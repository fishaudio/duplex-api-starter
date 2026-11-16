# Fish Audio Realtime Voice Agent Starter

A clean, production-oriented **TypeScript + React + Python** reference application demonstrating how to build a full-duplex, interruptible voice agent with **Fish Audio Realtime (`/v1/realtime/converse`)**, **tool calling**, **speculative eager turns**, and **backend ambience mixing**.

Out of the box, it runs an interactive **McDonald's Drive-Thru** scenario where callers order aloud over realistic kitchen & speaker-post ambience while watching every protocol frame, LLM hop, and tool call stream live.

---

## Key Best Practices Demonstrated

| Best Practice | Where to Read It | Why It Matters |
| --- | --- | --- |
| **Binary MessagePack + 20 ms Audio Clock** | `backend/fish_realtime.py` | Immediate `session.start`, `session.started` gating, and a monotonic 20 ms `pcm_s16le` pump that pads silence so calls never drift or hit `4408 idle_timeout`. |
| **Speculative Eager Turns (`turns.eager`)** | `backend/brain.py` | Starts LLM streaming on `turn.eager` (`for=eager_id`) so Fish pre-synthesizes audio before turn endpointing finishes; cancels cleanly on `turn.resumed`. |
| **Barge-In `heard_text` Alignment** | `backend/brain.py` + `web/public/audio-worklets.js` | Fades browser speaker playback over 80 ms on `reply.interrupted` and records **only** `reply.done.heard_text` into LLM history. |
| **Zero-Dead-Air Tool Calls (`say` + `flush`)** | `backend/brain.py` + `backend/drive_thru.py` | Flushes a short spoken filler (`"Got it, adding that now."`, `flush=True`) before executing tools, then continues the answer on the same `reply_id`. |
| **Backend Ambience + Speech Ducker** | `backend/ambience.py` | Mixes a seamless 72 s drive-thru bed on the **backend** into outbound PCM (works identically for WebRTC, WebSockets, and SIP/Twilio) with automatic `-10 dB` sidechain ducking when the agent speaks. |
| **Dynamic Spoken Prompt (`text_rules`)** | `backend/prompts.py` | Adapts LLM formatting rules (`ack_in_t`, `numbers`, `tags`, `avoid`) directly from `session.started.text_rules`. |
| **Vertex AI Gemini Priority Tier** | `backend/brain.py` | Supports switching between `priority` (`ON_DEMAND_PRIORITY` via `X-Vertex-AI-LLM-Shared-Request-Type: priority`) and `normal` (`ON_DEMAND`), with `thinking_level="LOW"` and preserved `thought_signature` on tool calls. |

---

## Quickstart (2 Minutes)

### Prerequisites

- **Python 3.12+** with [`uv`](https://docs.astral.sh/uv/)
- **Node.js 20+** with `npm`
- A **Fish Audio API Key** (`FISH_API_KEY`)
- A **Google Cloud Vertex AI Service Account JSON** with Vertex AI User role

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set:

```ini
FISH_API_KEY=your_fish_api_key
VERTEX_CREDENTIALS_PATH=/path/to/your-service-account.json
```

### 2. Install & build (or run in dev mode)

**Option A — Single-port server (build frontend once, serve from Python on `:8080`):**

```bash
cd web && npm install && npm run build && cd ..
uv sync
uv run python -m backend.app
```

Open **http://localhost:8080**.

**Option B — Hot-reload development (`:5173` frontend + `:8080` backend):**

```bash
# Terminal 1 — Python backend
uv sync
uv run python -m backend.app

# Terminal 2 — Vite React frontend
cd web && npm install && npm run dev
```

Open **http://localhost:5173**.

---

## Project Layout

```text
realtime-agent-starter/
├── AGENTS.md                  # Instructions & invariants for AI coding agents (Claude/Cursor/Codex)
├── README.md                  # Quickstart & architecture guide
├── .env.example               # Environment variable template
├── pyproject.toml             # Python dependencies
├── backend/
│   ├── app.py                 # HTTP + /ws server bridging browser <-> Fish Realtime <-> Gemini
│   ├── fish_realtime.py       # Fish Realtime binary MessagePack client + 20 ms clock pump
│   ├── ambience.py            # Backend looping ambience mixer + -10 dB speech sidechain ducker
│   ├── brain.py               # Gemini streaming + Priority PayGo + eager turns + tool hops
│   ├── prompts.py             # Spoken prompt builder conditioned on session.started.text_rules
│   ├── drive_thru.py          # McDonald's menu, POS state, and 7 tool definitions
│   └── assets/
│       ├── drive_thru.mp3     # CC0 1.0 kitchen + drive-thru lane ambience loop
│       └── SOURCES.md         # CC0 1.0 audio source attributions
└── web/
    ├── public/
    │   └── audio-worklets.js  # 20 ms PCM capture + 240 ms jitter buffer + 80 ms barge-in fade
    └── src/
        ├── App.tsx            # POS board, device/voice/model controls, and live Event Inspector
        ├── useAudioRig.ts     # Mic/speaker device enumeration & WebAudio duplex hook
        ├── types.ts           # Shared TypeScript interfaces
        └── styles.css         # UI styling
```

## Adapting With Your AI Coding Agent

Open this repository in **Claude Code**, **Cursor**, **Codex**, or **Antigravity**—it will read `AGENTS.md` automatically. Prompt:

> *"Replace the McDonald's drive-thru scenario in `backend/drive_thru.py` and `web/src/App.tsx` with a dental clinic receptionist that can check open slots, book appointments, and reschedule patients."*
