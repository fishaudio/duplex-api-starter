# AGENTS.md — Guide for AI Coding Agents

This repository is the official **Fish Audio Realtime Voice Agent Starter**. When a developer asks you (Claude Code, Cursor, Codex, Antigravity, etc.) to run or customize this project for their business scenario, follow the architecture and protocol invariants below.

## Repository Map

- `backend/fish_realtime.py` — **Protocol Layer (DO NOT break invariants)**: Binary MessagePack WebSocket client for `wss://api.fish.audio/v1/realtime/converse`.
- `backend/ambience.py` — **Backend Ambience & Ducker**: Loops a background audio bed (`backend/assets/drive_thru.mp3`) into the outbound `pcm_s16le` stream with `-10 dB` sidechain ducking whenever the agent speaks.
- `backend/brain.py` — **LLM & Tool Orchestrator**: Connects Vertex AI Gemini (`priority` vs `normal` PayGo tiers) to Fish Realtime turns (`turn.eager`, `turn.resumed`, `turn.committed`, `reply.done`).
- `backend/prompts.py` — **Spoken Prompt Rules**: Dynamically formats the system prompt using `session.started.text_rules`.
- `backend/drive_thru.py` — **Domain Scenario & Tools (Swap this first!)**: Menu catalog, order state, and Gemini `FunctionDeclaration` schemas.
- `backend/app.py` — **HTTP + WebSocket Bridge**: Keeps `FISH_API_KEY` and cloud credentials strictly server-side; streams binary 20 ms `pcm_s16le` audio and JSON inspector events to the browser.
- `web/` — **React 19 + TypeScript + Vite Frontend**: Audio device selectors, WebAudio `AudioWorklet` capture & 240 ms jitter buffer (`web/public/audio-worklets.js`), POS board, and real-time event inspector.

## Critical Fish Audio Realtime Protocol Invariants

1. **Immediate `session.start`**: Send `session.start` once as the very first binary MessagePack frame within 5 s of connecting (within **1 s** when server capacity is full, or socket closes with `4408`).
2. **Caller Audio Is the Session Clock**: After `session.started`, send `{"type": "audio", "data": <bytes>}` every 20–100 ms continuously in real time—**including silence (`0x00`)**. Stopping audio for >30 s closes the call (`4408`) unless `listen.pause` is active (300 s).
3. **Binary MessagePack Only**: Pack every frame with `msgpack.packb(payload, use_bin_type=True)`. Never base64-encode `audio.data`.
4. **`for` Only on First Reply Frame**: When answering a `turn_id` or speculative `eager_id`, include `"for": id` **only** on the first `reply.text` frame of a new `reply_id`.
5. **Reconcile History with `reply.done.heard_text`**: When a caller barges in, only `heard_text` was spoken aloud. Store `heard_text` (never the full unplayed LLM draft) in conversation history.
6. **Zero-Dead-Air Tool Calls (`say` + `flush=True`)**: Before running a slow tool or database lookup, emit a short spoken phrase with `flush=True, last=False`, execute the tool, and stream the post-tool answer on the **same `reply_id`** ending with `last=True`.
7. **Gemini 3 Function-Calling Rules**: Keep `thinking_level="LOW"` (avoids `MALFORMED_FUNCTION_CALL` under `MINIMAL`) and preserve raw `candidate.content.parts` in history so `thought_signature` is retained across tool hops.

## How to Customize for a New Use Case

1. Replace `backend/drive_thru.py` with the user's tools and state (e.g., appointment booking, customer support CRM, restaurant reservations). Keep the optional `say` parameter on each tool schema so zero-dead-air filler speech keeps working automatically.
2. Update the persona instructions in `backend/prompts.py` while keeping the `text_rules` spoken formatting constraints intact.
3. Optionally swap `backend/assets/drive_thru.mp3` with another mono/stereo ambience loop (office room tone, call center, or disable ambience via `ambience_enabled=False`).
4. Update the left-hand card view in `web/src/App.tsx` to display your domain state.
