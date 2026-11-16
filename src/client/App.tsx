import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthScheme,
  ConfigValidation,
  GeminiPingResult,
  InspectorEvent,
  MetaResponse,
  OrderSnapshot,
} from "../shared/types";
import { useAudioRig } from "./useAudioRig";
import { VoicePicker } from "./VoicePicker";
import { DEFAULT_VOICE_REFERENCE_ID } from "../shared/voices";

type FilterTab = "all" | "turns" | "replies" | "llm" | "tools" | "transcript";

function dbToPercent(db: number): number {
  return Math.max(0, Math.min(100, ((db + 65) / 65) * 100));
}

function classifyEventRow(type: string): string {
  if (type.includes("interrupted") || type.includes("error") || type.includes("refused")) {
    return "ev-row ev-interrupt";
  }
  if (type.startsWith("turn.")) return "ev-row ev-turn";
  if (type.startsWith("reply.") || type === "agent.speech") return "ev-row ev-reply";
  if (type.startsWith("llm.")) return "ev-row ev-llm";
  if (type.startsWith("tool.")) return "ev-row ev-tool";
  return "ev-row";
}

export function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [configStatus, setConfigStatus] = useState<ConfigValidation | null>(null);
  const [showConfigModal, setShowConfigModal] = useState<boolean>(false);
  const [showEndpointDrawer, setShowEndpointDrawer] = useState<boolean>(false);

  const [referenceId, setReferenceId] = useState<string>(DEFAULT_VOICE_REFERENCE_ID);
  const [geminiModel, setGeminiModel] = useState<string>("gemini-3.8-flash");
  const [geminiTier, setGeminiTier] = useState<"priority" | "normal">("priority");
  const [sampleRate, setSampleRate] = useState<number>(24000);

  // Optional runtime Endpoint & Auth override fields (defaulting from config.toml)
  const [endpointOverride, setEndpointOverride] = useState<string>("");
  const [authScheme, setAuthScheme] = useState<AuthScheme>("bearer");
  const [bearerToken, setBearerToken] = useState<string>("");
  const [basicUser, setBasicUser] = useState<string>("");
  const [basicPass, setBasicPass] = useState<string>("");

  const [ambienceEnabled, setAmbienceEnabled] = useState<boolean>(true);
  const [ambienceDb, setAmbienceDb] = useState<number>(0);
  const [rawAudio, setRawAudio] = useState<boolean>(false);

  const [callLive, setCallLive] = useState<boolean>(false);
  const [paused, setPaused] = useState<boolean>(false);
  const [sessionId, setSessionId] = useState<string>("");
  const [callError, setCallError] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderSnapshot | null>(null);
  const [events, setEvents] = useState<InspectorEvent[]>([]);
  const [filter, setFilter] = useState<FilterTab>("all");
  const [pingResult, setPingResult] = useState<GeminiPingResult | null>(null);
  const [pingLoading, setPingLoading] = useState<boolean>(false);

  const wsRef = useRef<WebSocket | null>(null);
  const nextEventId = useRef<number>(1);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const rig = useAudioRig();

  const fetchMeta = useCallback(async () => {
    const r = await fetch("/api/meta");
    const data = (await r.json()) as MetaResponse;
    setMeta(data);
    setConfigStatus(data.configStatus);
    setReferenceId(data.configStatus.defaultReferenceId || "");
    setGeminiModel(data.configStatus.defaultModel || "gemini-3.8-flash");
    setGeminiTier(data.configStatus.defaultTier || "priority");
    setAmbienceEnabled(data.configStatus.ambienceEnabled);
    setAmbienceLevelSafe(data.configStatus.ambienceLevelDb);
    setEndpointOverride(data.configStatus.endpoint);
    setAuthScheme(data.configStatus.authScheme);
    setShowConfigModal(!data.configStatus.ready);
  }, []);

  function setAmbienceLevelSafe(val: number) {
    if (!Number.isNaN(val)) setAmbienceDb(val);
  }

  useEffect(() => {
    void fetchMeta().catch(console.error);

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        rig.enqueueSpeakerPcm(ev.data);
        return;
      }
      const msg = JSON.parse(ev.data as string) as Record<string, unknown>;
      if (msg.kind === "order") {
        setOrder(msg.order as OrderSnapshot);
      } else if (msg.kind === "call_state") {
        const isLive = Boolean(msg.live);
        setCallLive(isLive);
        if (!isLive) {
          setPaused(false);
          void rig.stopRig();
        }
      } else if (msg.kind === "session_ready") {
        setSessionId(String(msg.session_id ?? ""));
        if (typeof msg.output_sample_rate === "number" && msg.output_sample_rate > 0) {
          rig.setServerOutputRate(msg.output_sample_rate);
        }
      } else if (msg.kind === "call_error") {
        setCallError(String(msg.error ?? "Call failed"));
      } else if (msg.kind === "config_required") {
        const status = msg.configStatus as ConfigValidation;
        setConfigStatus(status);
        setShowConfigModal(true);
        void rig.stopRig();
      } else if (msg.kind === "event") {
        const payload = msg.payload as Record<string, unknown>;
        const etype = String(payload.type ?? "unknown");
        if (etype === "reply.interrupted" && payload.final === false) {
          rig.flushSpeaker();
        }
        const now = new Date();
        const ts = `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, "0")}`;
        setEvents((prev) => [
          ...prev.slice(-1499),
          {
            id: nextEventId.current++,
            ts,
            channel: String(msg.channel),
            type: etype,
            seq: typeof payload.seq === "number" ? payload.seq : undefined,
            payload,
          },
        ]);
      }
    };

    return () => {
      ws.close();
      void rig.stopRig();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, filter]);

  const sendWsJson = (payload: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  };

  useEffect(() => {
    sendWsJson({
      type: "config.live",
      ambience_enabled: ambienceEnabled,
      ambience_db: ambienceDb,
      gemini_model: geminiModel,
      gemini_tier: geminiTier,
      raw_audio: rawAudio,
    });
  }, [ambienceEnabled, ambienceDb, geminiModel, geminiTier, rawAudio]);

  const handleToggleCall = async () => {
    if (callLive) {
      sendWsJson({ type: "call.stop" });
      await rig.stopRig();
      setCallLive(false);
      return;
    }

    setCallError(null);
    // Check config readiness unless user typed runtime credentials in drawer
    const hasRuntimeAuth =
      (authScheme === "bearer" && bearerToken.trim().length > 0) ||
      (authScheme === "basic" && basicUser.trim().length > 0 && basicPass.trim().length > 0);
    if (configStatus && !configStatus.ready && !hasRuntimeAuth) {
      setShowConfigModal(true);
      return;
    }

    try {
      await rig.startRig(sampleRate, (pcmBuf) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(pcmBuf);
        }
      });
    } catch (err) {
      setCallError(`Microphone permission / device error: ${String(err)}`);
      return;
    }

    sendWsJson({
      type: "call.start",
      reference_id: referenceId,
      gemini_model: geminiModel,
      gemini_tier: geminiTier,
      sample_rate: sampleRate,
      endpoint: endpointOverride,
      auth_scheme: authScheme,
      token: bearerToken,
      username: basicUser,
      password: basicPass,
      ambience_enabled: ambienceEnabled,
      ambience_db: ambienceDb,
      raw_audio: rawAudio,
    });
  };

  const handleTogglePause = () => {
    const next = !paused;
    setPaused(next);
    sendWsJson({ type: "listen.pause", paused: next });
  };

  const handleTestGemini = async () => {
    setPingLoading(true);
    try {
      const resp = await fetch("/api/gemini-ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: geminiModel, tier: geminiTier }),
      });
      const data = (await resp.json()) as GeminiPingResult;
      setPingResult(data);
    } catch (err) {
      setPingResult({ ok: false, error: String(err) });
    } finally {
      setPingLoading(false);
    }
  };

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (filter === "all") return true;
      if (filter === "turns") return e.type.startsWith("turn.");
      if (filter === "replies") return e.type.startsWith("reply.") || e.type === "agent.speech";
      if (filter === "llm") return e.type.startsWith("llm.");
      if (filter === "tools") return e.type.startsWith("tool.");
      if (filter === "transcript") {
        return (
          e.type === "turn.committed" ||
          e.type === "turn.eager" ||
          e.type === "reply.done" ||
          e.type === "reply.interrupted" ||
          e.type === "tool.executed"
        );
      }
      return true;
    });
  }, [events, filter]);

  const activeDaypart = order?.daypart ?? "regular";
  const visibleMenu = useMemo(() => {
    return (meta?.menu ?? []).filter((m) => m.daypart === "all" || m.daypart === activeDaypart);
  }, [meta, activeDaypart]);

  return (
    <div className="app-shell">
      {/* Automatic Modal when config.toml is missing or incomplete */}
      {showConfigModal && configStatus && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2>Update config.toml First</h2>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
              Required credentials or endpoint settings are missing in{" "}
              <code>{configStatus.configPath}</code>. Copy <code>config.example.toml</code> to{" "}
              <code>config.toml</code> and fill in the fields below:
            </div>

            {configStatus.missingFields.length > 0 && (
              <div className="modal-missing">
                <strong>Missing / Incomplete Fields:</strong>
                <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                  {configStatus.missingFields.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            )}

            <pre className="modal-code">{`# cp config.example.toml config.toml

[fish_realtime]
endpoint = "wss://api.fish.audio/v1/duplex/converse"
auth_scheme = "bearer"     # or "basic"
token = "your_fish_api_key"
# username = ""            # used when auth_scheme = "basic"
# password = ""

[vertex_ai]
credentials_path = "/path/to/vertex-service-account.json"
location = "global"
default_tier = "priority"`}</pre>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button className="btn" onClick={() => setShowConfigModal(false)}>
                Inspect UI Anyway
              </button>
              <button className="btn btn-gemini" onClick={() => void fetchMeta()}>
                Re-check config.toml
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="topbar">
        <div className="topbar-row">
          <div className="brand">
            <span>Drive-Thru Realtime Agent</span>
          </div>

          <div className="field">
            <label>Microphone</label>
            <select
              value={rig.inputDeviceId}
              onChange={(e) => rig.setInputDeviceId(e.target.value)}
            >
              <option value="default">System Default Mic</option>
              {rig.devices.inputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Speaker Output</label>
            <select
              value={rig.outputDeviceId}
              onChange={(e) => rig.setOutputDeviceId(e.target.value)}
            >
              <option value="default">System Default Speaker</option>
              {rig.devices.outputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Speaker ${i + 1}`}
                </option>
              ))}
            </select>
          </div>

          <VoicePicker value={referenceId} onChange={setReferenceId} disabled={callLive} />

          <div className="field">
            <label>Gemini Model</label>
            <select value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)}>
              {(meta?.models ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Vertex AI Tier</label>
            <select
              value={geminiTier}
              onChange={(e) => setGeminiTier(e.target.value as "priority" | "normal")}
            >
              <option value="priority">Priority (ON_DEMAND_PRIORITY)</option>
              <option value="normal">Normal (ON_DEMAND)</option>
            </select>
          </div>

          <div className="field">
            <label>Sample Rate</label>
            <select
              value={sampleRate}
              onChange={(e) => setSampleRate(Number(e.target.value))}
              disabled={callLive}
            >
              <option value={24000}>24,000 Hz</option>
              <option value={44100}>44,100 Hz</option>
              <option value={16000}>16,000 Hz</option>
              <option value={48000}>48,000 Hz</option>
            </select>
          </div>
        </div>

        <div className="topbar-row">
          <button
            className={`btn ${callLive ? "btn-call-stop" : "btn-call-start"}`}
            onClick={() => void handleToggleCall()}
          >
            {callLive ? "End Call" : "Start Drive-Thru Call"}
          </button>

          <button className="btn" onClick={handleTogglePause} disabled={!callLive}>
            {paused ? "Resume Listening" : "Pause Listening"}
          </button>

          <button
            className="btn"
            onClick={() =>
              void rig.testAudioHardware().catch((err) => setCallError(`Audio test failed: ${String(err)}`))
            }
          >
            Test Mic &amp; Spk
          </button>

          <button className="btn btn-gemini" onClick={() => void handleTestGemini()} disabled={pingLoading}>
            {pingLoading ? "Testing..." : "Test Gemini Tier"}
          </button>

          <button className="btn" onClick={() => setShowEndpointDrawer((v) => !v)} disabled={callLive}>
            Endpoint &amp; Auth ({authScheme})
          </button>

          <div className="pill-group">
            <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={ambienceEnabled}
                onChange={(e) => setAmbienceEnabled(e.target.checked)}
              />
              Backend Kitchen Ambience
            </label>
            <input
              type="range"
              min={-15}
              max={10}
              step={1}
              value={ambienceDb}
              onChange={(e) => setAmbienceDb(Number(e.target.value))}
              disabled={!ambienceEnabled}
              style={{ width: 75 }}
            />
            <span style={{ color: "var(--muted)", minWidth: 40 }}>
              {ambienceDb >= 0 ? `+${ambienceDb}` : ambienceDb} dB
            </span>
          </div>

          <div className="pill-group">
            <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={rig.echoCancel}
                onChange={(e) => rig.setEchoCancel(e.target.checked)}
                disabled={callLive}
              />
              Speaker AEC
            </label>
          </div>

          <div className="pill-group" style={{ marginLeft: "auto" }}>
            <span>Mic</span>
            <div className="meter-bar">
              <div className="meter-fill" style={{ width: `${dbToPercent(rig.micDb)}%` }} />
            </div>
            <span>Spk</span>
            <div className="meter-bar">
              <div className="meter-fill" style={{ width: `${dbToPercent(rig.spkDb)}%` }} />
            </div>
            <span style={{ color: "var(--muted)" }}>Buf {rig.bufferedMs}ms</span>
          </div>
        </div>

        {showEndpointDrawer && (
          <div className="topbar-row" style={{ paddingTop: 4, borderTop: "1px dashed var(--border)" }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Realtime WS Endpoint (defaults from config.toml)</label>
              <input
                type="text"
                value={endpointOverride}
                onChange={(e) => setEndpointOverride(e.target.value)}
                placeholder="wss://api.fish.audio/v1/duplex/converse"
              />
            </div>
            <div className="field">
              <label>Auth Scheme</label>
              <select value={authScheme} onChange={(e) => setAuthScheme(e.target.value as AuthScheme)}>
                <option value="bearer">Bearer Token</option>
                <option value="basic">Basic Auth</option>
              </select>
            </div>
            {authScheme === "bearer" ? (
              <div className="field">
                <label>Bearer Token Override</label>
                <input
                  type="password"
                  value={bearerToken}
                  onChange={(e) => setBearerToken(e.target.value)}
                  placeholder="Leave blank to use config.toml"
                />
              </div>
            ) : (
              <>
                <div className="field">
                  <label>Basic Username Override</label>
                  <input
                    type="text"
                    value={basicUser}
                    onChange={(e) => setBasicUser(e.target.value)}
                    placeholder="Leave blank for config.toml"
                  />
                </div>
                <div className="field">
                  <label>Basic Password Override</label>
                  <input
                    type="password"
                    value={basicPass}
                    onChange={(e) => setBasicPass(e.target.value)}
                    placeholder="Leave blank for config.toml"
                  />
                </div>
              </>
            )}
          </div>
        )}
      </header>

      {callError && (
        <div className="error-banner">
          <span>
            <strong>Connection Error:</strong> {callError}
          </span>
          <button className="tab-btn" onClick={() => setCallError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {pingResult && (
        <div className="ping-banner">
          {pingResult.ok ? (
            <span>
              <strong>Gemini Verified:</strong> {pingResult.model} | Tier Header:{" "}
              <code>{pingResult.tier}</code> → Response TrafficType:{" "}
              <strong style={{ color: "var(--gold)" }}>{pingResult.traffic_type}</strong> | TTFT:{" "}
              <strong>{pingResult.ttft_ms} ms</strong> | Sample: &ldquo;{pingResult.sample_reply}&rdquo;
            </span>
          ) : (
            <span style={{ color: "#fca5a5" }}>Gemini Error: {pingResult.error}</span>
          )}
          <button className="tab-btn" onClick={() => setPingResult(null)}>
            Dismiss
          </button>
        </div>
      )}

      <main className="workspace">
        <section className="pos-column">
          <div className="pos-screen">
            <div className="pos-header">
              <div>
                <div className="pos-title">ORDER #{order?.order_number ?? 142}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  {sessionId ? `Live Session: ${sessionId}` : "Ready at Speaker Post 1 (Eager Mode Active)"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className={`status-badge status-${order?.status ?? "open"}`}>
                  {order?.status ?? "open"}
                </span>
                <button className="tab-btn" onClick={() => sendWsJson({ type: "order.reset" })}>
                  Reset
                </button>
              </div>
            </div>

            <div className="order-lines">
              {!order || order.lines.length === 0 ? (
                <div className="empty-order">
                  Start the call and order aloud — e.g.{" "}
                  <em>&ldquo;Can I get a Burger meal with a large Lemon-Lime Soda, no pickles?&rdquo;</em>
                </div>
              ) : (
                order.lines.map((line) => (
                  <div key={line.line} className="order-item">
                    <div>
                      <div className="order-item-title">
                        {line.qty}x {line.name}
                        {line.meal && <span className="meal-tag">MEAL</span>}
                      </div>
                      <div className="order-item-sub">
                        Size: {line.size}
                        {line.meal && line.drink ? ` • Drink: ${line.drink}` : ""}
                        {line.modifiers.length > 0 ? ` • ${line.modifiers.join(", ")}` : ""}
                      </div>
                    </div>
                    <div style={{ fontWeight: 700 }}>${line.line_total.toFixed(2)}</div>
                  </div>
                ))
              )}
            </div>

            <div className="totals">
              <div className="totals-row">
                <span>Subtotal</span>
                <span>${(order?.subtotal ?? 0).toFixed(2)}</span>
              </div>
              <div className="totals-row">
                <span>Tax (8.25%)</span>
                <span>${(order?.tax ?? 0).toFixed(2)}</span>
              </div>
              <div className="totals-grand">
                <span>Order Total</span>
                <span>${(order?.total ?? 0).toFixed(2)}</span>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: 13 }}>
              Menu Board ({activeDaypart === "breakfast" ? "Breakfast" : "Lunch & Dinner"})
            </strong>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className={`tab-btn ${activeDaypart === "regular" ? "active" : ""}`}
                onClick={() => sendWsJson({ type: "order.daypart", daypart: "regular" })}
              >
                Lunch &amp; Dinner
              </button>
              <button
                className={`tab-btn ${activeDaypart === "breakfast" ? "active" : ""}`}
                onClick={() => sendWsJson({ type: "order.daypart", daypart: "breakfast" })}
              >
                Breakfast
              </button>
            </div>
          </div>

          <div className="menu-grid">
            {visibleMenu.map((item) => (
              <div key={item.id} className="menu-card">
                <div>
                  <div style={{ fontWeight: 600 }}>{item.name}</div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{item.category}</div>
                </div>
                <span className="menu-price">${item.price.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="inspector-column">
          <div className="inspector-bar">
            <div style={{ display: "flex", gap: 4 }}>
              {(["all", "transcript", "turns", "replies", "llm", "tools"] as FilterTab[]).map((t) => (
                <button
                  key={t}
                  className={`tab-btn ${filter === t ? "active" : ""}`}
                  onClick={() => setFilter(t)}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 11.5 }}>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  cursor: "pointer",
                  color: "var(--muted)",
                }}
              >
                <input
                  type="checkbox"
                  checked={rawAudio}
                  onChange={(e) => setRawAudio(e.target.checked)}
                />
                Raw Audio Frames
              </label>
              <button className="tab-btn" onClick={() => setEvents([])}>
                Clear ({events.length})
              </button>
            </div>
          </div>

          <div className="event-list">
            {filteredEvents.length === 0 ? (
              <div style={{ color: "var(--muted)", padding: 24, textAlign: "center" }}>
                All Fish Realtime frames (<code>session.*</code>, <code>turn.eager</code>,{" "}
                <code>turn.committed</code>, <code>reply.*</code>), Vertex AI Gemini hops (
                <code>ON_DEMAND_PRIORITY</code>), and Drive-Thru tool calls will stream here live.
              </div>
            ) : (
              filteredEvents.map((ev) => {
                const rest: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(ev.payload)) {
                  if (k !== "type" && k !== "seq") rest[k] = v;
                }
                return (
                  <div key={ev.id} className={classifyEventRow(ev.type)}>
                    <span className="ev-ts">{ev.ts}</span>
                    <span className="ev-ch">
                      {ev.channel}
                      {ev.seq !== undefined ? `#${ev.seq}` : ""}
                    </span>
                    <span className="ev-type">{ev.type}</span>
                    <span className="ev-body">{JSON.stringify(rest)}</span>
                  </div>
                );
              })
            )}
            <div ref={logEndRef} />
          </div>
        </section>
      </main>
    </div>
  );
}
