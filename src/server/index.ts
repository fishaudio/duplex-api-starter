import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { AuthScheme, MetaResponse } from "../shared/types.ts";
import { AmbienceMixer, preloadAmbienceAsset } from "./ambience.ts";
import { GEMINI_MODELS, GeminiVoiceBrain } from "./brain.ts";
import { buildAuthHeader, loadAndValidateConfig } from "./config.ts";
import { DriveThruOrderState, MENU_CATALOG } from "./driveThru.ts";
import { FishRealtimeClient } from "./fishRealtime.ts";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        const str = Buffer.concat(chunks).toString("utf8");
        resolve(str ? (JSON.parse(str) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export async function createStarterServer(configOverridePath?: string): Promise<http.Server> {
  await preloadAmbienceAsset();

  const distDir = path.resolve(process.cwd(), "dist");
  const publicDir = path.resolve(process.cwd(), "public");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/meta") {
      const { validation } = loadAndValidateConfig(configOverridePath);
      const body: MetaResponse = {
        models: GEMINI_MODELS,
        menu: MENU_CATALOG,
        configStatus: validation,
      };
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/gemini-ping") {
      try {
        const payload = await readJsonBody(req);
        const { config, validation } = loadAndValidateConfig(configOverridePath);
        if (!config.vertex_ai.credentials_path) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: `Missing vertex_ai.credentials_path in ${validation.configPath}`,
            }),
          );
          return;
        }
        const brain = new GeminiVoiceBrain({
          credentialsPath: config.vertex_ai.credentials_path,
          location: config.vertex_ai.location,
          model: String(payload.model ?? config.vertex_ai.default_model),
          tier: payload.tier === "normal" ? "normal" : "priority",
          orderState: new DriveThruOrderState(),
        });
        const ping = await brain.pingModel();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(ping));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // Static serving for production single-port mode (`npm run build && npm start`)
    for (const root of [distDir, publicDir]) {
      if (!fs.existsSync(root)) continue;
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const candidate = path.resolve(root, rel);
      if (candidate.startsWith(root) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const ext = path.extname(candidate);
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
        fs.createReadStream(candidate).pipe(res);
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 262_144 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (browserWs: WebSocket) => {
    const { config: initialCfg } = loadAndValidateConfig(configOverridePath);
    const orderState = new DriveThruOrderState();
    const ambience = new AmbienceMixer({
      sampleRate: 24000,
      enabled: initialCfg.ambience.enabled,
      levelDb: initialCfg.ambience.level_db,
    });

    let rtClient: FishRealtimeClient | null = null;
    let showRawAudio = false;

    const sendJson = (msg: Record<string, unknown>) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify(msg));
      }
    };

    const brain = new GeminiVoiceBrain({
      credentialsPath: initialCfg.vertex_ai.credentials_path,
      location: initialCfg.vertex_ai.location,
      model: initialCfg.vertex_ai.default_model,
      tier: initialCfg.vertex_ai.default_tier,
      orderState,
      onEvent: async (channel, payload) => {
        sendJson({ kind: "event", channel, payload });
      },
      onOrderUpdate: async (snapshot) => {
        sendJson({ kind: "order", order: snapshot });
      },
    });

    const handleRealtimeEvent = async (channel: string, payload: Record<string, unknown>) => {
      if ((channel === "C->audio" || channel === "S->audio") && !showRawAudio) {
        return;
      }
      const sanitized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) {
        sanitized[k] = v instanceof Uint8Array ? `<${v.byteLength}B>` : v;
      }
      sendJson({ kind: "event", channel, payload: sanitized });

      if (channel === "WS" && payload.type === "ws.upgrade_refused") {
        sendJson({
          kind: "call_error",
          error: `Fish Realtime refused WebSocket upgrade (HTTP ${payload.status}): ${payload.detail ?? ""}`,
        });
      }

      if (channel === "S->" && rtClient) {
        if (payload.type === "session.started") {
          ambience.setSampleRate(rtClient.outputSampleRate);
          sendJson({
            kind: "session_ready",
            session_id: rtClient.sessionId,
            output_sample_rate: rtClient.outputSampleRate,
          });
        }
        await brain.handleRealtimeEvent(payload, rtClient);
      }
    };

    const stopActiveCall = (notifyClient = true) => {
      if (rtClient) {
        rtClient.close();
        rtClient = null;
      }
      if (notifyClient) {
        sendJson({ kind: "call_state", live: false });
      }
    };

    // Initial order snapshot
    sendJson({ kind: "order", order: orderState.snapshot() });

    browserWs.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        if (rtClient) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          rtClient.feedCallerPcm(buf);
        }
        return;
      }

      const cmd = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      const ctype = String(cmd.type ?? "");

      if (ctype === "call.start") {
        // Close any previous upstream socket silently without telling browser `live: false`
        // (telling browser `live: false` here would tear down the AudioContext it just opened!)
        stopActiveCall(false);
        const { config, validation } = loadAndValidateConfig(configOverridePath);

        // Allow optional runtime endpoint/auth overrides from UI; fall back to config.toml
        const endpoint = String(cmd.endpoint ?? "").trim() || config.fish_realtime.endpoint;
        const authScheme: AuthScheme =
          cmd.auth_scheme === "basic" || cmd.auth_scheme === "bearer"
            ? cmd.auth_scheme
            : config.fish_realtime.auth_scheme;
        const authHeader = buildAuthHeader({
          authScheme,
          token: String(cmd.token ?? "").trim() || config.fish_realtime.token,
          username: String(cmd.username ?? "").trim() || config.fish_realtime.username,
          password: String(cmd.password ?? "").trim() || config.fish_realtime.password,
        });

        if (!authHeader || !config.vertex_ai.credentials_path || !fs.existsSync(config.vertex_ai.credentials_path)) {
          sendJson({
            kind: "config_required",
            configStatus: validation,
          });
          return;
        }

        brain.resetCall();
        brain.credentialsPath = config.vertex_ai.credentials_path;
        brain.location = config.vertex_ai.location;
        brain.model = String(cmd.gemini_model ?? config.vertex_ai.default_model);
        brain.tier = cmd.gemini_tier === "normal" ? "normal" : "priority";

        const sampleRate = Number(cmd.sample_rate ?? 24000);
        ambience.setSampleRate(sampleRate);
        ambience.enabled = cmd.ambience_enabled !== undefined ? Boolean(cmd.ambience_enabled) : config.ambience.enabled;
        ambience.levelDb = cmd.ambience_db !== undefined ? Number(cmd.ambience_db) : config.ambience.level_db;
        showRawAudio = Boolean(cmd.raw_audio);

        const client = new FishRealtimeClient(
          {
            url: endpoint,
            authHeader,
            sampleRate,
            referenceId:
              cmd.reference_id !== undefined
                ? String(cmd.reference_id).trim()
                : config.fish_realtime.reference_id,
          },
          handleRealtimeEvent,
          (agentPcm) => {
            if (browserWs.readyState !== WebSocket.OPEN) return;
            const mixed = ambience.mixPcmS16le(agentPcm);
            browserWs.send(mixed);
          },
        );
        rtClient = client;
        sendJson({ kind: "call_state", live: true });

        void client.connectAndRun().finally(() => {
          if (rtClient === client) {
            rtClient = null;
            sendJson({ kind: "call_state", live: false });
          }
        });
      } else if (ctype === "call.stop") {
        stopActiveCall();
      } else if (ctype === "config.live") {
        if (cmd.ambience_enabled !== undefined) ambience.enabled = Boolean(cmd.ambience_enabled);
        if (cmd.ambience_db !== undefined) ambience.levelDb = Number(cmd.ambience_db);
        if (cmd.gemini_model !== undefined) brain.model = String(cmd.gemini_model);
        if (cmd.gemini_tier !== undefined) brain.tier = cmd.gemini_tier === "normal" ? "normal" : "priority";
        if (cmd.raw_audio !== undefined) showRawAudio = Boolean(cmd.raw_audio);
      } else if (ctype === "listen.pause" && rtClient) {
        rtClient.setPaused(Boolean(cmd.paused));
      } else if (ctype === "order.daypart") {
        orderState.daypart = cmd.daypart === "breakfast" ? "breakfast" : "regular";
        sendJson({ kind: "order", order: orderState.snapshot() });
      } else if (ctype === "order.reset") {
        orderState.reset();
        sendJson({ kind: "order", order: orderState.snapshot() });
      }
    });

    browserWs.on("close", () => {
      stopActiveCall();
    });
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config } = loadAndValidateConfig();
  const srv = await createStarterServer();
  srv.listen(config.server.port, "127.0.0.1", () => {
    console.log(`Fish Realtime Starter (TypeScript) listening on http://localhost:${config.server.port}`);
  });
}
