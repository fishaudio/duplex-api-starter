# Fish Audio Duplex API Starter

> **Preview — invitation only.** Access to the Fish Audio Duplex API is currently limited to selected customers. A public repository does not grant service access.

A browser demo for an interruptible voice agent. Speak to a fictional diner order taker, ask about the menu, change an order, and see the resulting actions on screen.

The application uses **TypeScript**, with a **React** browser interface and a **Node.js** server. Fish Audio Duplex API handles the live voice connection; **Gemini on Vertex AI** generates replies and selects tools.

## Run locally

You need:

- Node.js 20 or later and npm.
- An invitation to the Fish Audio Duplex API preview and service credentials.
- A Google Cloud project with Vertex AI access and a service account JSON file.
- A browser with microphone access.

Copy the configuration template:

```bash
cp config.example.toml config.toml
```

Edit `config.toml` with your Realtime endpoint and credentials, then set the path to your Vertex AI service account file. The template explains the settings. Keep both credential files on your server; `config.toml` is ignored by Git.

Install dependencies and start development mode:

```bash
npm install
npm run dev
```

Open [localhost:5173](http://localhost:5173), select your microphone and speaker, and start a call. If configuration is missing, the setup dialog lists the fields to complete.

To serve the built application on one port:

```bash
npm run build
npm start
```

Then open [localhost:8080](http://localhost:8080).

## Voice selection

The demo defaults to **Clara**. Use the **Voice** dropdown for a preset, or choose **Custom…** to enter a Fish Voice Library reference ID. An empty custom ID uses the service default. Voice selection applies to the next call.

The presets use Voice Library counterparts of the Live 3 voices. The Duplex handshake sends `voice.reference_id` with the ID below, not the voice name. Set `fish_realtime.reference_id` in `config.toml` to change the startup selection; an omitted setting uses Clara, while an explicit empty string uses the service default.

| Voice | Reference ID |
| --- | --- |
| Clara | `1c8ce946e6c847e6a3b32a88cce2a1e4` |
| Nora | `ea43bb2019214265a675f69fe4bcc14e` |
| Owen | `a47bfeff3bc1493cb92a04c8fe4eb762` |
| Marco | `b905eff67d954eb7bbe0754e6e62b3ea` |
| Milo | `f022291776c7474eb71403c454142ba6` |
| Jonah | `c2bc3b0c9c7943f3a49e5b7cdb730792` |
| Harper | `95df3b76803249da8b36795a55e9a535` |
| Patricia | `c4e84d4cd97b4153bcd78560460f1c61` |
| Maddie | `90f9c20fa030430c85ddf3b6608ed1ad` |
| Ethan | `283c705d24334216964ff9ec67c6b987` |
| Tyler | `6b352181d9064977b3ec46de5cf01b39` |
| Brianna | `d50f7dccfb994c238f639be665dc325b` |

## What the demo includes

- A menu and live order screen with quantities, modifiers, and totals.
- Tools to look up menu items and add, change, remove, or confirm an order.
- Interruptible speech and an event inspector for turns, replies, and tool calls.
- Microphone and speaker selection, browser echo cancellation, and a playback buffer.
- Optional kitchen ambience, mixed on the server and lowered while the agent speaks.
- Gemini model and Vertex AI traffic-tier selection.

The menu and prices are sample data. Order confirmation updates demo state; it does not submit a real order or take payment. Echo cancellation and response latency depend on the browser, devices, network, and selected model.

## How the conversation works

1. The browser sends microphone audio to the Node.js server.
2. The server maintains a Realtime WebSocket connection to Fish Audio.
3. When a caller pauses, Gemini can start preparing a response before the turn is final. This is called an **eager turn**.
4. Menu and order lookups can run immediately. Tools that change an order wait until Fish commits the caller's turn, so an abandoned pause cannot create an order.
5. Gemini's text is streamed to Fish for speech, and tool results update the order screen.

The server keeps the caller's audio clock running even during silence. After an interruption, conversation history uses the words the caller actually heard. The call closes after the farewell finishes playing.

## Customize the example

Start with these files:

| File | Purpose |
| --- | --- |
| `config.example.toml` | Connection, authentication, model, and ambience settings. |
| `src/server/driveThru.ts` | Sample menu, order state, and business tools. Replace this for another workflow. |
| `src/server/prompts.ts` | The agent's role, ordering instructions, and spoken-text rules. |
| `src/client/App.tsx` | Browser controls, order display, and event inspector. |
| `src/server/brain.ts` | Gemini requests, tool execution, and conversation history. |
| `src/server/fishRealtime.ts` | Fish Realtime protocol and continuous audio delivery. |
| `src/client/useAudioRig.ts` and `public/audio-worklets.js` | Browser capture, playback, and audio routing. |
| `src/server/ambience.ts` | Background sound mixing. Attribution is in [assets/SOURCES.md](assets/SOURCES.md). |

Read [AGENTS.md](AGENTS.md) before changing the protocol or turn-handling code. A production integration also needs application authentication, real business systems, monitoring, and testing for its workflow.

## Check changes

```bash
npm run typecheck
npm test
npm run build
```
