# Fish Audio Realtime Voice Agent Starter (Full-Stack TypeScript)

A clean, zero-native-dependency **Full-Stack TypeScript (Node.js + React 19 + Vite)** reference application demonstrating how to build a full-duplex, interruptible voice agent with **Fish Audio Realtime (`/v1/realtime/converse`)**, **speculative eager turns**, **tool calling**, and **backend ambience mixing**.

Out of the box, it runs an interactive **McDonald's Drive-Thru** scenario where callers order aloud over realistic kitchen & speaker-post ambience while watching every protocol frame, Gemini hop, and tool call stream live.

---

## Quickstart (1 Toolchain, 2 Commands)

### Prerequisites

- **Node.js 20+** and `npm`
- Fish Audio Realtime credentials (`Bearer` API key or preview `Basic` credentials)
- A Google Cloud Vertex AI Service Account JSON file

### 1. Configure `config.toml`

```bash
cp config.example.toml config.toml
```

Edit `config.toml` to configure your endpoint, authentication (`bearer` or `basic`), and Vertex AI credentials path. *(If any required field is missing, the web UI automatically opens a setup guide modal with a one-click **Re-check `config.toml`** button.)*

### 2. Install & start

```bash
npm install
npm run dev
```

Open **http://localhost:5173** (or run `npm run build && npm start` for single-port production mode on **http://localhost:8080**).

---

## Key Best Practices Demonstrated

| Best Practice | File | Why It Matters |
| --- | --- | --- |
| **Eager-First Turn Taking + Write-Tool Commit Gate** | `src/server/brain.ts` | Starts LLM streaming on `turn.eager` (`for=eager_id`) so Fish pre-synthesizes speech with ~0 ms onset wait; parks mutating tools at `commitGate` until `turn.committed` approves `eager_id` so discarded pauses never create phantom orders. |
| **Binary MessagePack + 20 ms Audio Clock** | `src/server/fishRealtime.ts` | Immediate `session.start`, `session.started` gating, and a 20 ms `pcm_s16le` pump that pads silence so calls never drift or hit `4408 idle_timeout`. Supports both `Bearer` and `Basic` auth. |
| **Zero-Dead-Air Tool Speech (`say` + `flush`)** | `src/server/brain.ts` + `src/server/driveThru.ts` | Flushes a short spoken filler (`"Got it, adding that now."`, `flush: true`) before running tools, then streams Hop 2 on the same `reply_id`. |
| **Backend Ambience + Speech Ducker** | `src/server/ambience.ts` | Pure-WASM MP3 decode (`mpg123-decoder`) + seamless 72 s drive-thru loop mixed on the **backend** into outbound PCM with `-10 dB` sidechain ducking when the agent speaks. |
| **Barge-In `heard_text` Alignment** | `src/server/brain.ts` + `public/audio-worklets.js` | Fades browser speaker playback over 80 ms on `reply.interrupted` and records **only** `reply.done.heard_text` into LLM history. |
| **Vertex AI Gemini Priority Tier** | `src/server/brain.ts` | Switches live between `priority` (`ON_DEMAND_PRIORITY` via `X-Vertex-AI-LLM-Shared-Request-Type: priority`) and `normal` (`ON_DEMAND`), using `ThinkingLevel.LOW` and preserving `thoughtSignature`. |

---

## Project Structure

```text
realtime-agent-starter/
├── AGENTS.md                   # Guide & protocol invariants for AI coding agents (Claude/Cursor/Codex)
├── config.example.toml         # Endpoint, Bearer/Basic auth, and Vertex AI config template
├── package.json                # Single unified TypeScript toolchain
├── public/
│   └── audio-worklets.js       # 20 ms PCM capture + 240 ms jitter buffer + 80 ms barge-in fade
├── assets/
│   ├── drive_thru.mp3          # CC0 1.0 kitchen + drive-thru lane ambience loop
│   └── SOURCES.md              # CC0 1.0 attributions
└── src/
    ├── shared/
    │   └── types.ts            # End-to-end types shared between Node server & React UI
    ├── server/
    │   ├── index.ts            # HTTP (/api/meta, /api/gemini-ping) + Browser /ws bridge
    │   ├── config.ts           # Hot-reloading config.toml loader & completeness validator
    │   ├── fishRealtime.ts     # Fish Realtime MessagePack client + 20 ms silence clock
    │   ├── ambience.ts         # Backend WASM MP3 ambience mixer + -10 dB speech ducker
    │   ├── brain.ts            # Eager-first Gemini orchestrator + commit-gated tools
    │   ├── prompts.ts          # Dynamic spoken prompt builder from session.started.text_rules
    │   └── driveThru.ts        # McDonald's menu, POS state, & 7 tool schemas (swap for your business!)
    └── client/
        ├── App.tsx             # POS board, config.toml modal, controls, and live Event Inspector
        ├── useAudioRig.ts      # Mic/speaker device enumeration & WebAudio duplex hook
        └── styles.css          # UI styling
```
