# AGENTS.md — Guide for AI Coding Agents

This repository is the **100% Full-Stack TypeScript Fish Audio Realtime Voice Agent Starter**. When a developer asks you (Claude Code, Cursor, Codex, Antigravity, etc.) to run or customize this project for their business scenario, follow the architecture and protocol invariants below.

## Repository Map

- `config.example.toml` — Copy to `config.toml` (`cp config.example.toml config.toml`) to configure the Realtime WebSocket endpoint, auth (`bearer` or `basic`), and Vertex AI credentials.
- `src/shared/types.ts` — Shared TypeScript interfaces used across both Node server and React client (`npm run typecheck` validates both simultaneously).
- `src/server/fishRealtime.ts` — **Protocol Layer (DO NOT break invariants)**: Binary MessagePack WebSocket client (`@msgpack/msgpack` + `ws`) with a 20 ms real-time caller audio clock.
- `src/server/ambience.ts` — **Backend Ambience & Speech Ducker**: Decodes `assets/drive_thru.mp3` via WebAssembly (`mpg123-decoder`), loops seamlessly, and mixes into outbound `pcm_s16le` with `-10 dB` sidechain ducking when the agent speaks.
- `src/server/brain.ts` — **Eager-First LLM & Tool Orchestrator**: Connects Vertex AI Gemini (`@google/genai`, `priority` vs `normal` tiers) to Fish Realtime turns (`turn.eager`, `turn.resumed`, `turn.committed`, `reply.done`).
- `src/server/prompts.ts` — **Spoken Prompt Rules**: Dynamically formats the spoken system prompt using `session.started.text_rules`.
- `src/server/driveThru.ts` — **Domain Scenario & Tools (Swap this first!)**: Menu catalog, order POS state, and Gemini `FunctionDeclaration` schemas.
- `src/server/index.ts` — **HTTP + WebSocket Bridge**: Serves `/api/meta`, `/api/gemini-ping`, and `/ws`.
- `src/client/` — **React 19 + TypeScript Frontend**: Device selectors, missing-`config.toml` setup modal, POS order screen, and real-time Event Inspector.

## Critical Fish Audio Realtime Protocol Invariants

1. **Always Enable Eager Turns (`turns.eager: true`)**: Committed-only turn taking adds hundreds of milliseconds of dead air. Always start speculative LLM streaming on `turn.eager` with `"for": eager_id` (first `reply.text` frame only).
2. **Gate Mutating Tools Until `turn.committed`**: Read-only tools (`lookup_menu`, `get_order`) may run during `turn.eager`, while write tools (`add_item`, `update_item`, `remove_item`, `confirm_order`) must await `commitGate` until `turn.committed` arrives with `approved_eager_id == eager_id`. Cancel cleanly on `turn.resumed`.
3. **Immediate `session.start`**: Send `session.start` once as the first binary MessagePack frame within 5 s of connecting (within **1 s** when server capacity is full).
4. **Caller Audio Is the Session Clock**: After `session.started`, send `{"type": "audio", "data": Uint8Array}` every 20–100 ms continuously in real time—**including silence (`0x00`)**.
5. **Reconcile History with `reply.done.heard_text`**: Store `heard_text` (never unplayed text) in conversation history when interrupted.
6. **Zero-Dead-Air Tool Calls (`say` + `flush: true`)**: Flush a short spoken phrase (`flush: true, last: false`) before executing tools, then stream Hop 2 on the **same `reply_id`** ending with `last: true`.
7. **Gemini 3 Function-Calling Rules**: Use `ThinkingLevel.LOW` and preserve raw `Part[]` objects in `Content` history so `thoughtSignature` is retained across tool hops.
