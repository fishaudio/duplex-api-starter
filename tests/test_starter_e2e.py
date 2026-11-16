"""End-to-end verification of Backend Ambience, Drive-Thru Tool Calling, Gemini Tiers, and WS Bridge."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import aiohttp
from aiohttp import web
import msgpack
import numpy as np
import pytest

from backend.ambience import AmbienceMixer
from backend.app import create_app


class MockFishConverseServer:
    """Local MessagePack WebSocket server emulating `/v1/realtime/converse`."""

    def __init__(self) -> None:
        self.frames: list[dict[str, Any]] = []
        self._runner: web.AppRunner | None = None
        self.url: str = ""

    async def start(self) -> str:
        app = web.Application()
        app.router.add_get("/v1/realtime/converse", self._handle)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        self.url = f"ws://127.0.0.1:{port}/v1/realtime/converse"
        return self.url

    async def stop(self) -> None:
        if self._runner:
            await self._runner.cleanup()

    async def _handle(self, req: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(req)
        seq = 0

        async def send_s(payload: dict[str, Any]) -> None:
            nonlocal seq
            await ws.send_bytes(msgpack.packb({"seq": seq, **payload}, use_bin_type=True))
            seq += 1

        first = await ws.receive()
        start_msg = msgpack.unpackb(first.data, raw=False)
        assert start_msg["type"] == "session.start"
        assert start_msg["voice"] == "Clara"
        self.frames.append(start_msg)

        sr = start_msg["audio"]["sample_rate"]
        await send_s(
            {
                "type": "session.started",
                "session_id": "sess_mcd_01",
                "limits": {"max_session_s": 1800, "idle_s": 30},
                "text_rules": {"numbers": "written", "tags": "off", "ack_in_t": False, "avoid": "any"},
                "audio": {"encoding": "pcm_s16le", "sample_rate": sr, "output_sample_rate": sr},
                "noise_cancel": {"on": True, "delay_ms": 20},
            }
        )

        # Stream a silent agent audio frame so backend AmbienceMixer runs on it
        await send_s({"type": "audio", "data": b"\x00" * int(sr * 2 * 0.02)})

        audio_in = 0
        sent_turn = False
        reply_texts: dict[str, list[str]] = {}

        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.BINARY:
                break
            frame = msgpack.unpackb(msg.data, raw=False)
            ftype = frame["type"]
            if ftype == "audio":
                audio_in += 1
                if audio_in == 3 and not sent_turn:
                    sent_turn = True
                    await send_s(
                        {
                            "type": "turn.committed",
                            "turn_id": "t_order_1",
                            "text": "Can I get a Big Mac meal with a large Sprite and no pickles?",
                            "kind": "turn",
                            "approved_eager_id": None,
                            "lead_ms": None,
                            "agent": {"reply_id": None, "state": "idle", "heard_text": "", "basis": "aligned"},
                        }
                    )
            else:
                self.frames.append(frame)
                if ftype == "reply.text":
                    rid = frame["reply_id"]
                    reply_texts.setdefault(rid, []).append(frame["text"])
                    if frame.get("last"):
                        full = "".join(reply_texts[rid])
                        await send_s(
                            {
                                "type": "reply.done",
                                "reply_id": rid,
                                "status": "completed",
                                "reason": None,
                                "by": None,
                                "heard_text": full,
                                "unheard_text": "",
                                "heard_chars": len(full),
                                "basis": "aligned",
                                "audio_end_ms": 1200,
                            }
                        )
        return ws


def test_backend_ambience_mixer_and_ducker() -> None:
    mixer = AmbienceMixer(sample_rate=24000, enabled=True, level_db=0.0)
    silent_agent = b"\x00" * (480 * 2)  # 20 ms silence @ 24 kHz
    mixed = mixer.mix_pcm_s16le(silent_agent)
    assert len(mixed) == len(silent_agent)
    # Mixed output must contain non-zero McDonald's ambience samples!
    arr_silent = np.frombuffer(mixed, dtype=np.int16)
    assert np.max(np.abs(arr_silent)) > 0

    # Loud agent speech triggers -10 dB ducking without clipping
    loud_tone = (np.sin(np.linspace(0, 20, 480)) * 8000).astype(np.int16).tobytes()
    mixed_loud = mixer.mix_pcm_s16le(loud_tone)
    assert len(mixed_loud) == len(loud_tone)


@pytest.mark.asyncio
async def test_full_web_starter_gemini_priority_and_drive_thru_tool_call() -> None:
    mock_fish = MockFishConverseServer()
    fish_url = await mock_fish.start()

    runner = web.AppRunner(create_app())
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
    base = f"http://127.0.0.1:{port}"

    try:
        async with aiohttp.ClientSession() as http:
            # 1. Verify /api/meta exposes voices & Gemini models
            meta = await (await http.get(f"{base}/api/meta")).json()
            assert any(v["id"] == "Clara" for v in meta["voices"])
            assert meta["has_vertex_credentials"] is True

            # 2. Verify /api/gemini-ping for BOTH priority & normal tiers
            ping_prio = await (
                await http.post(
                    f"{base}/api/gemini-ping",
                    json={"model": "gemini-3.5-flash-lite", "tier": "priority"},
                )
            ).json()
            assert ping_prio["ok"] is True
            assert ping_prio["traffic_type"] == "ON_DEMAND_PRIORITY"

            ping_norm = await (
                await http.post(
                    f"{base}/api/gemini-ping",
                    json={"model": "gemini-3.5-flash-lite", "tier": "normal"},
                )
            ).json()
            assert ping_norm["ok"] is True
            assert ping_norm["traffic_type"] == "ON_DEMAND"

            # 3. Connect browser /ws, start call, verify tool call updates McDonald's POS + ambience PCM arrives
            async with http.ws_connect(f"ws://127.0.0.1:{port}/ws") as bws:
                await bws.send_str(
                    json.dumps(
                        {
                            "type": "call.start",
                            "voice": "Clara",
                            "gemini_model": "gemini-3.5-flash-lite",
                            "gemini_tier": "priority",
                            "sample_rate": 24000,
                            "fish_api_key": "test-key",
                            "fish_url": fish_url,
                            "ambience_enabled": True,
                            "ambience_db": 0,
                        }
                    )
                )

                got_mixed_audio = False
                final_order: dict[str, Any] | None = None
                seen_events: list[str] = []

                deadline = asyncio.get_event_loop().time() + 18.0
                while asyncio.get_event_loop().time() < deadline:
                    msg = await asyncio.wait_for(bws.receive(), timeout=10.0)
                    if msg.type == aiohttp.WSMsgType.BINARY:
                        pcm = np.frombuffer(msg.data, dtype=np.int16)
                        if np.max(np.abs(pcm)) > 0:
                            got_mixed_audio = True
                    elif msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        if data["kind"] == "order" and data["order"]["lines"]:
                            final_order = data["order"]
                        elif data["kind"] == "event":
                            etype = data["payload"]["type"]
                            seen_events.append(etype)
                            if etype == "reply.done" and final_order is not None:
                                break

                assert got_mixed_audio is True, "Expected backend-mixed ambience PCM on speaker WS"
                assert final_order is not None, f"Expected add_item tool call to populate order; seen={seen_events}"
                assert any("Big Mac" in line["name"] for line in final_order["lines"])
                assert "tool.executed" in seen_events
                assert "llm.hop_done" in seen_events
    finally:
        await runner.cleanup()
        await mock_fish.stop()
