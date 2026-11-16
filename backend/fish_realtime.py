"""Fish Audio Realtime WebSocket Protocol Client (MessagePack binary framing).

Best practices demonstrated here:
  1. Send `session.start` as the very first frame immediately after WebSocket connect
     (within 5 s normally, or 1 s when server capacity is full).
  2. Wait for `session.started` before starting the real-time audio clock; keep at most
     the newest 1 s of pre-start audio so the call never starts late.
  3. Stream caller audio continuously in 20 ms chunks (`pcm_s16le` mono), padding with
     silence (`0x00`) whenever no mic packet is queued so the call clock never stalls.
  4. Attach `"for": eager_id | turn_id` ONLY on the first `reply.text` frame of each `reply_id`.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import time
from typing import Any

import aiohttp
import msgpack

# Built-in low-latency anthropomorphic voices (from live3-agent/voice_meta.json)
BUILTIN_VOICES: list[dict[str, str]] = [
    {"id": "Clara", "gender": "F", "label": "Clara (Female - Default)"},
    {"id": "Nora", "gender": "F", "label": "Nora (Female)"},
    {"id": "Owen", "gender": "M", "label": "Owen (Male)"},
    {"id": "Marco", "gender": "M", "label": "Marco (Male)"},
    {"id": "Maddie", "gender": "F", "label": "Maddie (Female)"},
    {"id": "Ethan", "gender": "M", "label": "Ethan (Male)"},
    {"id": "Tyler", "gender": "M", "label": "Tyler (Male)"},
    {"id": "Brianna", "gender": "F", "label": "Brianna (Female)"},
    {"id": "Milo", "gender": "M", "label": "Milo (Male)"},
    {"id": "Jonah", "gender": "M", "label": "Jonah (Male)"},
    {"id": "Harper", "gender": "F", "label": "Harper (Female)"},
    {"id": "Patricia", "gender": "F", "label": "Patricia (Female)"},
]

CLOSE_CODES: dict[int, str] = {
    1000: "normal_closure",
    1002: "protocol_error",
    1009: "message_too_large",
    1012: "server_restarting",
    4400: "invalid_message_or_session_start",
    4408: "idle_timeout",
    4409: "client_not_reading",
    4413: "session_limit",
    4429: "server_busy",
    4500: "internal_or_asr_degraded",
}


@dataclass
class RealtimeSessionConfig:
    url: str = "wss://api.fish.audio/v1/realtime/converse"
    api_key: str = ""
    sample_rate: int = 24000
    voice: str = "Clara"
    noise_cancel: bool = True
    eager: bool = True
    backchannel: bool = True
    interim: bool = True
    own_speech: str = "natural"
    playback_delay_ms: int = 260


class FishRealtimeClient:
    """Spec-compliant async client for `/v1/realtime/converse` and `/v1/realtime/speak`."""

    def __init__(
        self,
        config: RealtimeSessionConfig,
        on_event: Callable[[str, dict[str, Any]], Awaitable[None]],
        on_agent_audio: Callable[[bytes], Awaitable[None]],
    ) -> None:
        self.config = config
        self.on_event = on_event
        self.on_agent_audio = on_agent_audio

        self.session_id: str = ""
        self.output_sample_rate: int = config.sample_rate
        self.paused: bool = False
        self.tx_frames: int = 0
        self.rx_frames: int = 0

        self._http: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._pump_task: asyncio.Task[None] | None = None
        self._mic_buf = bytearray()
        self._started = asyncio.Event()
        self._seen_replies: set[str] = set()

    @property
    def is_live(self) -> bool:
        return self._ws is not None and not self._ws.closed and self._started.is_set()

    def build_session_start(self) -> dict[str, Any]:
        c = self.config
        frame: dict[str, Any] = {
            "type": "session.start",
            "audio": {
                "encoding": "pcm_s16le",
                "sample_rate": int(c.sample_rate),
                "noise_cancel": bool(c.noise_cancel),
            },
            "own_speech": c.own_speech,
            "playback": {"delay_ms": int(c.playback_delay_ms)},
            "session_ending": True,
        }
        if "/speak" not in c.url:
            frame["turns"] = {
                "eager": bool(c.eager),
                "backchannel": bool(c.backchannel),
                "interim": bool(c.interim),
            }
        v = c.voice.strip()
        if v:
            frame["voice"] = {"reference_id": v[4:].strip()} if v.startswith("ref:") else v
        return frame

    async def run(self) -> None:
        headers = {}
        if self.config.api_key.strip():
            headers["Authorization"] = f"Bearer {self.config.api_key.strip()}"

        self._http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10))
        try:
            try:
                self._ws = await self._http.ws_connect(
                    self.config.url,
                    headers=headers,
                    autoping=True,
                    max_msg_size=262_144,
                )
            except aiohttp.WSServerHandshakeError as exc:
                hdrs = dict(exc.headers) if exc.headers else {}
                await self.on_event(
                    "WS",
                    {
                        "type": "ws.upgrade_refused",
                        "status": exc.status,
                        "fish_error_code": hdrs.get("x-fish-error-code"),
                        "retry_after": hdrs.get("Retry-After") or hdrs.get("retry-after"),
                    },
                )
                return

            await self.on_event("WS", {"type": "ws.connected", "url": self.config.url})
            await self._send(self.build_session_start())

            async for msg in self._ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    data = msgpack.unpackb(msg.data, raw=False)
                    if not isinstance(data, dict):
                        continue
                    etype = data.get("type", "unknown")
                    if etype == "session.started":
                        self.session_id = str(data.get("session_id", ""))
                        self.output_sample_rate = int(
                            (data.get("audio") or {}).get("output_sample_rate", self.config.sample_rate)
                        )
                        self._started.set()
                        await self.on_event("S->", data)
                        self._start_20ms_pump()
                    elif etype == "audio":
                        pcm = data.get("data", b"")
                        if isinstance(pcm, (bytes, bytearray)):
                            self.rx_frames += 1
                            await self.on_agent_audio(bytes(pcm))
                            await self.on_event(
                                "S->audio",
                                {
                                    "seq": data.get("seq"),
                                    "type": "audio",
                                    "bytes": len(pcm),
                                    "frame": self.rx_frames,
                                },
                            )
                    else:
                        await self.on_event("S->", data)
                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED):
                    break
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    await self.on_event("WS", {"type": "ws.error", "error": str(self._ws.exception())})
                    break

            code = self._ws.close_code if self._ws else None
            await self.on_event(
                "WS",
                {"type": "ws.closed", "close_code": code, "reason": CLOSE_CODES.get(code or 0, "closed")},
            )
        finally:
            await self.close()

    async def _send(self, payload: dict[str, Any], emit: bool = True) -> None:
        if self._ws is None or self._ws.closed:
            return
        await self._ws.send_bytes(msgpack.packb(payload, use_bin_type=True))
        if emit:
            await self.on_event("C->", payload)

    def feed_caller_pcm(self, pcm_bytes: bytes) -> None:
        cap = self.config.sample_rate * 2 if not self._started.is_set() else self.config.sample_rate
        self._mic_buf.extend(pcm_bytes)
        if len(self._mic_buf) > cap:
            del self._mic_buf[:-cap]

    def _start_20ms_pump(self) -> None:
        chunk_bytes = int(self.config.sample_rate * 2 * 0.02)
        silence = b"\x00" * chunk_bytes

        async def _loop() -> None:
            next_tick = time.monotonic()
            while self._ws is not None and not self._ws.closed:
                next_tick += 0.02
                delay = next_tick - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                elif delay < -0.1:
                    next_tick = time.monotonic()

                if self.paused:
                    continue

                if len(self._mic_buf) >= chunk_bytes:
                    chunk = bytes(self._mic_buf[:chunk_bytes])
                    del self._mic_buf[:chunk_bytes]
                else:
                    chunk = silence

                self.tx_frames += 1
                await self._send({"type": "audio", "data": chunk}, emit=False)
                await self.on_event(
                    "C->audio",
                    {"type": "audio", "bytes": len(chunk), "frame": self.tx_frames},
                )

        self._pump_task = asyncio.create_task(_loop())

    async def reply_text(
        self,
        reply_id: str,
        text: str,
        *,
        for_id: str | None = None,
        flush: bool = False,
        last: bool = False,
    ) -> None:
        frame: dict[str, Any] = {
            "type": "reply.text",
            "reply_id": reply_id,
            "text": text,
            "flush": bool(flush),
            "last": bool(last),
        }
        if reply_id not in self._seen_replies:
            self._seen_replies.add(reply_id)
            if for_id:
                frame["for"] = for_id
        await self._send(frame)

    async def reply_cancel(self, reply_id: str) -> None:
        await self._send({"type": "reply.cancel", "reply_id": reply_id})

    async def set_paused(self, paused: bool) -> None:
        self.paused = paused
        await self._send({"type": "listen.pause" if paused else "listen.resume"})

    async def close(self) -> None:
        if self._pump_task is not None:
            self._pump_task.cancel()
            try:
                await self._pump_task
            except asyncio.CancelledError:
                pass
            self._pump_task = None
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        if self._http is not None and not self._http.closed:
            await self._http.close()
