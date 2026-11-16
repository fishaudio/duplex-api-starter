"""Vertex AI Gemini Brain Orchestrator for Fish Audio Realtime.

Production best practices demonstrated here (distilled from `live3-agent/thinker/`):
  1. Vertex AI Priority PayGo (`tier="priority"`): sends headers
     `X-Vertex-AI-LLM-Request-Type: shared` + `X-Vertex-AI-LLM-Shared-Request-Type: priority`
     on the `global` endpoint, and exposes `usage_metadata.traffic_type` (`ON_DEMAND_PRIORITY`).
  2. Thinking configuration (`thinking_level="LOW"`): keeps first-token latency ~500-700 ms while
     avoiding `MALFORMED_FUNCTION_CALL` errors on multi-item Drive-Thru tool invocations, and
     retains Gemini 3 `thought_signature` parts intact across multi-hop function calls.
  3. Zero-dead-air tool calls (`say` + `flush=True`): speaks a short acknowledgement immediately
     while executing local/remote tools, then streams the post-tool answer on the SAME `reply_id`.
  4. Speculative Eager Turns (`turn.eager` -> `for=eager_id`): pre-generates & pre-synthesizes
     speech before turn endpointing completes; cancels cleanly on `turn.resumed`.
  5. Barge-in alignment: writes ONLY `reply.done.heard_text` into conversation history so the LLM
     never assumes the caller heard words cut off by interruption.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
import json
from pathlib import Path
import time
from typing import Any
import uuid
import warnings

warnings.filterwarnings("ignore", category=SyntaxWarning, module="google.genai")

from google import genai
from google.genai import types
from google.oauth2 import service_account

from .drive_thru import DriveThruOrderState, get_gemini_tools
from .fish_realtime import FishRealtimeClient
from .prompts import build_drive_thru_prompt

GEMINI_MODELS: list[dict[str, str]] = [
    {"id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash-Lite (Fastest)"},
    {"id": "gemini-3.5-flash", "label": "Gemini 3.5 Flash"},
    {"id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash"},
    {"id": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash-Lite"},
    {"id": "gemini-3-flash-preview", "label": "Gemini 3 Flash Preview"},
    {"id": "gemini-3.1-pro-preview", "label": "Gemini 3.1 Pro Preview"},
]


READ_ONLY_TOOLS = frozenset({"lookup_menu", "get_order"})


@dataclass
class InFlightReply:
    reply_id: str
    turn_id: str
    eager_id: str | None
    caller_text: str = ""
    task: asyncio.Task[None] | None = None
    cancelled: bool = False
    committed_event: asyncio.Event = field(default_factory=asyncio.Event)
    staged_tool_history: list[types.Content] = field(default_factory=list)


@dataclass
class GeminiVoiceBrain:
    credentials_path: str
    location: str = "global"
    model: str = "gemini-3.5-flash-lite"
    tier: str = "priority"  # "priority" or "normal"
    order_state: DriveThruOrderState = field(default_factory=DriveThruOrderState)
    on_event: Callable[[str, dict[str, Any]], Awaitable[None]] | None = None
    on_order_update: Callable[[dict[str, Any]], Awaitable[None]] | None = None

    text_rules: dict[str, Any] = field(default_factory=dict)
    history: list[types.Content] = field(default_factory=list)
    _active: InFlightReply | None = None
    _seq_reply: int = 0

    def _build_client(self) -> tuple[genai.Client, str]:
        path = Path(self.credentials_path).expanduser()
        if not path.exists():
            raise FileNotFoundError(
                f"Vertex credentials JSON not found at {path}. Set VERTEX_CREDENTIALS_PATH in .env."
            )
        with path.open() as f:
            project_id = json.load(f)["project_id"]

        creds = service_account.Credentials.from_service_account_file(
            str(path),
            scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )
        headers: dict[str, str] = {}
        if self.tier == "priority":
            headers["X-Vertex-AI-LLM-Request-Type"] = "shared"
            headers["X-Vertex-AI-LLM-Shared-Request-Type"] = "priority"

        client = genai.Client(
            vertexai=True,
            project=project_id,
            location=self.location,
            credentials=creds,
            http_options=types.HttpOptions(headers=headers) if headers else None,
        )
        return client, project_id

    async def _emit(self, channel: str, payload: dict[str, Any]) -> None:
        if self.on_event is not None:
            await self.on_event(channel, payload)

    def reset_call(self) -> None:
        self.history.clear()
        self.text_rules = {}
        self._active = None
        self._seq_reply = 0

    async def ping_model(self) -> dict[str, Any]:
        """Standalone check verifying Gemini latency and ON_DEMAND_PRIORITY vs ON_DEMAND tier."""
        client, project_id = self._build_client()
        t0 = time.perf_counter()
        ttft_ms: float | None = None
        chunks: list[str] = []
        traffic_type = "UNKNOWN"

        cfg = types.GenerateContentConfig(
            system_instruction=build_drive_thru_prompt(self.text_rules, self.order_state.daypart),
            temperature=0.4,
            max_output_tokens=512,
            thinking_config=types.ThinkingConfig(thinking_level="LOW"),
        )
        stream = await client.aio.models.generate_content_stream(
            model=self.model,
            contents="Greet a guest pulling up to the McDonald's drive-thru speaker in one short sentence.",
            config=cfg,
        )
        async for chunk in stream:
            if chunk.usage_metadata and getattr(chunk.usage_metadata, "traffic_type", None):
                traffic_type = str(chunk.usage_metadata.traffic_type).replace("TrafficType.", "")
            if chunk.text:
                if ttft_ms is None:
                    ttft_ms = (time.perf_counter() - t0) * 1000.0
                chunks.append(chunk.text)

        total_ms = (time.perf_counter() - t0) * 1000.0
        return {
            "project_id": project_id,
            "model": self.model,
            "tier": self.tier,
            "traffic_type": traffic_type,
            "ttft_ms": round(ttft_ms or total_ms, 1),
            "total_ms": round(total_ms, 1),
            "sample_reply": "".join(chunks).strip(),
        }

    async def handle_realtime_event(self, event: dict[str, Any], rt: FishRealtimeClient) -> None:
        etype = event.get("type")

        if etype == "session.started":
            self.text_rules = dict(event.get("text_rules") or {})
            # Send a welcoming drive-thru greeting as soon as the speaker post connects
            greeting = "Welcome to McDonald's! What can I get started for you today?"
            await rt.reply_text("r-welcome", greeting, last=True)
            return

        if etype == "turn.eager":
            eager_id = str(event.get("eager_id", ""))
            turn_id = str(event.get("turn_id", ""))
            text = str(event.get("text", "")).strip()
            if not text or not eager_id:
                return
            # Cancel any previous speculative reply before starting the new eager pre-run
            await self._cancel_active(rt, send_cancel=True)
            await self._launch_reply(rt, caller_text=text, turn_id=turn_id, eager_id=eager_id)

        elif etype == "turn.resumed":
            eager_id = str(event.get("eager_id", ""))
            if self._active and self._active.eager_id == eager_id:
                await self._emit(
                    "LLM->",
                    {"type": "llm.eager_cancelled", "eager_id": eager_id, "reply_id": self._active.reply_id},
                )
                await self._cancel_active(rt, send_cancel=True)

        elif etype == "turn.committed":
            turn_id = str(event.get("turn_id", ""))
            text = str(event.get("text", "")).strip()
            kind = str(event.get("kind", "turn"))
            approved_eager = event.get("approved_eager_id")
            if not text:
                return

            if kind == "aside":
                await self._cancel_active(rt, send_cancel=True)
                self.history.append(
                    types.Content(
                        role="user",
                        parts=[types.Part.from_text(text=f"[Guest spoke to passenger: {text}]")],
                    )
                )
                return

            self.history.append(types.Content(role="user", parts=[types.Part.from_text(text=text)]))

            if (
                approved_eager
                and self._active is not None
                and self._active.eager_id == approved_eager
                and not self._active.cancelled
            ):
                # Promote staged read-only tool turns & release any parked write tools immediately
                if self._active.staged_tool_history:
                    self.history.extend(self._active.staged_tool_history)
                    self._active.staged_tool_history.clear()
                self._active.committed_event.set()
                await self._emit(
                    "LLM->",
                    {
                        "type": "llm.eager_approved",
                        "approved_eager_id": approved_eager,
                        "reply_id": self._active.reply_id,
                        "lead_ms": event.get("lead_ms"),
                    },
                )
                return

            await self._cancel_active(rt, send_cancel=True)
            await self._launch_reply(rt, caller_text=None, turn_id=turn_id, eager_id=None)

        elif etype == "reply.done":
            heard = str(event.get("heard_text", "")).strip()
            unheard = str(event.get("unheard_text", "")).strip()
            status = str(event.get("status", ""))
            if heard:
                self.history.append(types.Content(role="model", parts=[types.Part.from_text(text=heard)]))
            if unheard and status in ("interrupted", "partial"):
                self.history.append(
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(
                                text=f"[Speaker note: guest interrupted before hearing: {unheard}]"
                            )
                        ],
                    )
                )

    async def _cancel_active(self, rt: FishRealtimeClient, send_cancel: bool) -> None:
        cur = self._active
        if cur is None:
            return
        cur.cancelled = True
        if cur.task and not cur.task.done():
            cur.task.cancel()
            try:
                await cur.task
            except asyncio.CancelledError:
                pass
        if send_cancel and rt.is_live:
            await rt.reply_cancel(cur.reply_id)
        self._active = None

    async def _launch_reply(
        self,
        rt: FishRealtimeClient,
        *,
        caller_text: str | None,
        turn_id: str,
        eager_id: str | None,
    ) -> None:
        self._seq_reply += 1
        reply_id = f"r-{self._seq_reply}-{uuid.uuid4().hex[:5]}"
        inflight = InFlightReply(
            reply_id=reply_id,
            turn_id=turn_id,
            eager_id=eager_id,
            caller_text=caller_text or "",
        )
        if eager_id is None:
            inflight.committed_event.set()
        self._active = inflight

        working_contents = list(self.history)
        if caller_text is not None:
            working_contents.append(
                types.Content(role="user", parts=[types.Part.from_text(text=caller_text)])
            )
        for_target = eager_id if eager_id else (turn_id or None)

        async def _run_hops() -> None:
            first_frame_sent = False
            spoken_any = False

            async def _send_speech(chunk_text: str, *, flush: bool = False, last: bool = False) -> None:
                nonlocal first_frame_sent, spoken_any
                if chunk_text:
                    spoken_any = True
                await rt.reply_text(
                    reply_id,
                    chunk_text,
                    for_id=for_target if not first_frame_sent else None,
                    flush=flush,
                    last=last,
                )
                first_frame_sent = True

            try:
                client, _ = self._build_client()
                cfg = types.GenerateContentConfig(
                    system_instruction=build_drive_thru_prompt(self.text_rules, self.order_state.daypart),
                    tools=[get_gemini_tools()],
                    temperature=0.4,
                    # Extra headroom because maxOutputTokens counts LOW thinking tokens too
                    max_output_tokens=700,
                    thinking_config=types.ThinkingConfig(thinking_level="LOW"),
                )

                # Up to 3 tool-call hops within the same voice reply
                for hop in range(1, 4):
                    if inflight.cancelled or not rt.is_live:
                        return

                    t0 = time.perf_counter()
                    ttft_ms: float | None = None
                    traffic_type = "UNKNOWN"
                    model_parts: list[types.Part] = []
                    function_calls: list[types.Part] = []
                    hop_text: list[str] = []

                    await self._emit(
                        "LLM->",
                        {
                            "type": "llm.request",
                            "reply_id": reply_id,
                            "hop": hop,
                            "model": self.model,
                            "tier": self.tier,
                            "mode": "eager" if eager_id else "committed",
                            "for": for_target,
                        },
                    )

                    stream = await client.aio.models.generate_content_stream(
                        model=self.model,
                        contents=working_contents,
                        config=cfg,
                    )
                    async for chunk in stream:
                        if inflight.cancelled or not rt.is_live:
                            return
                        if chunk.usage_metadata and getattr(chunk.usage_metadata, "traffic_type", None):
                            traffic_type = str(chunk.usage_metadata.traffic_type).replace("TrafficType.", "")

                        if not chunk.candidates:
                            continue
                        cand_content = chunk.candidates[0].content
                        if not cand_content or not cand_content.parts:
                            continue

                        for part in cand_content.parts:
                            # Keep raw parts intact to preserve Gemini 3 thought_signature
                            model_parts.append(part)
                            if getattr(part, "thought", False):
                                continue
                            if part.function_call is not None:
                                function_calls.append(part)
                            elif part.text:
                                if ttft_ms is None:
                                    ttft_ms = (time.perf_counter() - t0) * 1000.0
                                    await self._emit(
                                        "LLM->",
                                        {
                                            "type": "llm.first_token",
                                            "reply_id": reply_id,
                                            "hop": hop,
                                            "ttft_ms": round(ttft_ms, 1),
                                            "preview": part.text[:60],
                                        },
                                    )
                                hop_text.append(part.text)
                                await _send_speech(part.text, last=False)

                    total_ms = (time.perf_counter() - t0) * 1000.0
                    await self._emit(
                        "LLM->",
                        {
                            "type": "llm.hop_done",
                            "reply_id": reply_id,
                            "hop": hop,
                            "traffic_type": traffic_type,
                            "ttft_ms": round(ttft_ms or total_ms, 1),
                            "total_ms": round(total_ms, 1),
                            "tool_calls": [p.function_call.name for p in function_calls if p.function_call],
                            "text": "".join(hop_text).strip(),
                        },
                    )

                    if not function_calls:
                        # Final spoken hop complete -> close reply stream with last=True
                        await _send_speech("", last=True)
                        return

                    # Append model turn (preserving thought_signature on function_call parts!)
                    model_turn = types.Content(role="model", parts=model_parts)
                    working_contents.append(model_turn)
                    if inflight.committed_event.is_set():
                        self.history.append(model_turn)
                    else:
                        inflight.staged_tool_history.append(model_turn)

                    response_parts: list[types.Part] = []
                    for fc_part in function_calls:
                        fc = fc_part.function_call
                        assert fc is not None
                        raw_args = dict(fc.args or {})
                        say_line = str(raw_args.pop("say", "") or "").strip()

                        # Zero-dead-air best practice: flush `say` before running the tool
                        # (Safe during eager too: Fish holds `for=eager_id` speech until commit!)
                        if say_line and not spoken_any and not inflight.cancelled:
                            if not say_line.endswith(" "):
                                say_line += " "
                            await _send_speech(say_line, flush=True, last=False)

                        # CRITICAL EAGER INVARIANT: mutating tools must wait until turn.committed approves!
                        if fc.name not in READ_ONLY_TOOLS and not inflight.committed_event.is_set():
                            await self._emit(
                                "TOOL->",
                                {
                                    "type": "tool.awaiting_commit",
                                    "reply_id": reply_id,
                                    "eager_id": eager_id,
                                    "tool": fc.name,
                                },
                            )
                            await inflight.committed_event.wait()
                            if inflight.cancelled or not rt.is_live:
                                return

                        t_tool = time.perf_counter()
                        result = self.order_state.execute_tool(fc.name, raw_args)
                        tool_ms = round((time.perf_counter() - t_tool) * 1000.0, 2)

                        await self._emit(
                            "TOOL->",
                            {
                                "type": "tool.executed",
                                "reply_id": reply_id,
                                "tool": fc.name,
                                "args": raw_args,
                                "say": say_line.strip() or None,
                                "latency_ms": tool_ms,
                                "ok": result.get("ok", True),
                            },
                        )
                        if self.on_order_update is not None:
                            await self.on_order_update(self.order_state.snapshot())

                        response_parts.append(
                            types.Part.from_function_response(name=fc.name, response=result)
                        )

                    tool_resp_content = types.Content(role="user", parts=response_parts)
                    working_contents.append(tool_resp_content)
                    if inflight.committed_event.is_set():
                        self.history.append(tool_resp_content)
                    else:
                        inflight.staged_tool_history.append(tool_resp_content)

                # Safety close if max hops reached
                await _send_speech("", last=True)

            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._emit(
                    "LLM->",
                    {"type": "llm.error", "reply_id": reply_id, "error": f"{type(exc).__name__}: {exc}"},
                )

        inflight.task = asyncio.create_task(_run_hops())
