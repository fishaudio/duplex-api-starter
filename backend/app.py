"""HTTP & WebSocket Server Bridging React Web Client <-> Fish Realtime <-> Vertex Gemini."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web
from dotenv import load_dotenv

from .ambience import AmbienceMixer
from .brain import GEMINI_MODELS, GeminiVoiceBrain
from .drive_thru import MENU_CATALOG, DriveThruOrderState
from .fish_realtime import BUILTIN_VOICES, FishRealtimeClient, RealtimeSessionConfig

ROOT_DIR = Path(__file__).resolve().parent.parent
WEB_DIST_DIR = ROOT_DIR / "web" / "dist"
load_dotenv(ROOT_DIR / ".env")


def _default_credentials_path() -> str:
    return (
        os.environ.get("VERTEX_CREDENTIALS_PATH")
        or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        or ""
    )


async def handle_meta(_request: web.Request) -> web.Response:
    cred_path = _default_credentials_path()
    return web.json_response(
        {
            "voices": BUILTIN_VOICES,
            "models": GEMINI_MODELS,
            "menu": MENU_CATALOG,
            "default_realtime_url": os.environ.get(
                "FISH_REALTIME_URL", "wss://api.fish.audio/v1/realtime/converse"
            ),
            "has_fish_api_key": bool(os.environ.get("FISH_API_KEY", "").strip()),
            "has_vertex_credentials": bool(cred_path and Path(cred_path).expanduser().exists()),
        }
    )


async def handle_gemini_ping(request: web.Request) -> web.Response:
    body = await request.json()
    model = str(body.get("model") or GEMINI_MODELS[0]["id"])
    tier = str(body.get("tier") or "priority")
    brain = GeminiVoiceBrain(
        credentials_path=_default_credentials_path(),
        location=os.environ.get("VERTEX_LOCATION", "global"),
        model=model,
        tier=tier,
    )
    try:
        res = await brain.ping_model()
        return web.json_response({"ok": True, **res})
    except Exception as exc:
        return web.json_response({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=400)


async def handle_browser_ws(request: web.Request) -> web.WebSocketResponse:
    """Per-tab WebSocket: binary frames = 20ms pcm_s16le audio; text frames = JSON events/commands."""
    browser_ws = web.WebSocketResponse(max_msg_size=262_144)
    await browser_ws.prepare(request)

    order_state = DriveThruOrderState(daypart="regular")
    ambience = AmbienceMixer(sample_rate=24000, enabled=True, level_db=0.0)
    rt_client: FishRealtimeClient | None = None
    rt_task: asyncio.Task[None] | None = None
    show_raw_audio = False

    async def send_json(msg: dict[str, Any]) -> None:
        if not browser_ws.closed:
            await browser_ws.send_str(json.dumps(msg, ensure_ascii=False))

    async def on_event(channel: str, payload: dict[str, Any]) -> None:
        nonlocal show_raw_audio
        if channel in ("C->audio", "S->audio") and not show_raw_audio:
            return
        clean_payload = {
            k: (f"<{len(v)}B>" if isinstance(v, (bytes, bytearray)) else v)
            for k, v in payload.items()
        }
        await send_json({"kind": "event", "channel": channel, "payload": clean_payload})

        if channel == "S->":
            if payload.get("type") == "session.started" and rt_client is not None:
                ambience.set_sample_rate(rt_client.output_sample_rate)
                await send_json(
                    {
                        "kind": "session_ready",
                        "session_id": rt_client.session_id,
                        "output_sample_rate": rt_client.output_sample_rate,
                    }
                )
            if rt_client is not None:
                await brain.handle_realtime_event(payload, rt_client)

    async def on_order_update(snapshot: dict[str, Any]) -> None:
        await send_json({"kind": "order", "order": snapshot})

    brain = GeminiVoiceBrain(
        credentials_path=_default_credentials_path(),
        location=os.environ.get("VERTEX_LOCATION", "global"),
        order_state=order_state,
        on_event=on_event,
        on_order_update=on_order_update,
    )

    async def on_agent_audio(agent_pcm: bytes) -> None:
        if browser_ws.closed:
            return
        # Backend mixes continuous McDonald's drive-thru bed + automatic speech ducking
        mixed_pcm = ambience.mix_pcm_s16le(agent_pcm)
        await browser_ws.send_bytes(mixed_pcm)

    async def stop_active_call() -> None:
        nonlocal rt_client, rt_task
        if rt_client is not None:
            await rt_client.close()
        if rt_task is not None:
            try:
                await asyncio.wait_for(rt_task, timeout=2.0)
            except Exception:
                rt_task.cancel()
        rt_client = None
        rt_task = None
        await send_json({"kind": "call_state", "live": False})

    # Send initial POS order state on connect
    await on_order_update(order_state.snapshot())

    try:
        async for msg in browser_ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                if rt_client is not None:
                    rt_client.feed_caller_pcm(msg.data)
            elif msg.type == aiohttp.WSMsgType.TEXT:
                cmd = json.loads(msg.data)
                ctype = cmd.get("type")

                if ctype == "call.start":
                    await stop_active_call()
                    brain.reset_call()
                    brain.model = str(cmd.get("gemini_model") or GEMINI_MODELS[0]["id"])
                    brain.tier = str(cmd.get("gemini_tier") or "priority")
                    order_state.daypart = str(cmd.get("daypart") or order_state.daypart)

                    sample_rate = int(cmd.get("sample_rate") or 24000)
                    ambience.set_sample_rate(sample_rate)
                    ambience.enabled = bool(cmd.get("ambience_enabled", True))
                    ambience.level_db = float(cmd.get("ambience_db", 0.0))
                    show_raw_audio = bool(cmd.get("raw_audio", False))

                    api_key = str(cmd.get("fish_api_key") or "").strip() or os.environ.get("FISH_API_KEY", "").strip()
                    ws_url = str(cmd.get("fish_url") or "").strip() or os.environ.get(
                        "FISH_REALTIME_URL", "wss://api.fish.audio/v1/realtime/converse"
                    )

                    cfg = RealtimeSessionConfig(
                        url=ws_url,
                        api_key=api_key,
                        sample_rate=sample_rate,
                        voice=str(cmd.get("voice") or "Clara"),
                        noise_cancel=bool(cmd.get("noise_cancel", True)),
                        eager=bool(cmd.get("eager", True)),
                        backchannel=bool(cmd.get("backchannel", True)),
                        interim=bool(cmd.get("interim", True)),
                    )
                    rt_client = FishRealtimeClient(
                        config=cfg,
                        on_event=on_event,
                        on_agent_audio=on_agent_audio,
                    )
                    await send_json({"kind": "call_state", "live": True})

                    async def _runner(client: FishRealtimeClient) -> None:
                        try:
                            await client.run()
                        finally:
                            if not browser_ws.closed:
                                await send_json({"kind": "call_state", "live": False})

                    rt_task = asyncio.create_task(_runner(rt_client))

                elif ctype == "call.stop":
                    await stop_active_call()

                elif ctype == "config.live":
                    if "ambience_enabled" in cmd:
                        ambience.enabled = bool(cmd["ambience_enabled"])
                    if "ambience_db" in cmd:
                        ambience.level_db = float(cmd["ambience_db"])
                    if "gemini_model" in cmd:
                        brain.model = str(cmd["gemini_model"])
                    if "gemini_tier" in cmd:
                        brain.tier = str(cmd["gemini_tier"])
                    if "raw_audio" in cmd:
                        show_raw_audio = bool(cmd["raw_audio"])

                elif ctype == "listen.pause" and rt_client is not None:
                    await rt_client.set_paused(bool(cmd.get("paused", True)))

                elif ctype == "order.daypart":
                    order_state.daypart = str(cmd.get("daypart", "regular"))
                    await on_order_update(order_state.snapshot())

                elif ctype == "order.reset":
                    order_state.reset()
                    await on_order_update(order_state.snapshot())
    finally:
        await stop_active_call()

    return browser_ws


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/api/meta", handle_meta)
    app.router.add_post("/api/gemini-ping", handle_gemini_ping)
    app.router.add_get("/ws", handle_browser_ws)

    if WEB_DIST_DIR.exists():
        async def _index(_req: web.Request) -> web.FileResponse:
            return web.FileResponse(WEB_DIST_DIR / "index.html")

        app.router.add_get("/", _index)
        app.router.add_static("/", WEB_DIST_DIR, show_index=False)

    return app


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    print(f"Fish Audio Realtime Starter Backend listening on http://localhost:{port}")
    web.run_app(create_app(), host="127.0.0.1", port=port, print=None)


if __name__ == "__main__":
    main()
