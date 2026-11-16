import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AmbienceMixer, preloadAmbienceAsset } from "../src/server/ambience.ts";
import { GeminiVoiceBrain } from "../src/server/brain.ts";
import { loadAndValidateConfig } from "../src/server/config.ts";
import { DriveThruOrderState } from "../src/server/driveThru.ts";
import type { FishRealtimeClient } from "../src/server/fishRealtime.ts";
import { createStarterServer } from "../src/server/index.ts";

describe("Full-Stack TypeScript Realtime Agent Starter", () => {
  it("flags missing fields cleanly when config.toml is absent or incomplete", () => {
    const missingPath = path.join(os.tmpdir(), `nonexistent-${Date.now()}.toml`);
    const { validation } = loadAndValidateConfig(missingPath);
    expect(validation.ready).toBe(false);
    expect(validation.configFileExists).toBe(false);
    expect(validation.missingFields[0]).toContain("config.toml file not found");
  });

  it("decodes drive_thru.mp3 via WASM and mixes ducked ambience into pcm_s16le", async () => {
    await preloadAmbienceAsset();
    const mixer = new AmbienceMixer({ sampleRate: 24000, enabled: true, levelDb: 0 });
    const silentFrame = Buffer.alloc(480 * 2, 0); // 20 ms @ 24 kHz
    const mixed = mixer.mixPcmS16le(silentFrame);
    expect(mixed.byteLength).toBe(silentFrame.byteLength);

    let peak = 0;
    for (let i = 0; i < 480; i++) {
      peak = Math.max(peak, Math.abs(mixed.readInt16LE(i * 2)));
    }
    expect(peak).toBeGreaterThan(0);
  });

  it(
    "gates mutating Drive-Thru tools on turn.eager until turn.committed approves",
    async () => {
      const { config, validation } = loadAndValidateConfig();
      if (!validation.ready) return;

      const sentFrames: Array<Record<string, unknown>> = [];
      const cancelledIds: string[] = [];
      const fakeRt = {
        isLive: true,
        replyText(replyId: string, text: string, opts?: { forId?: string; flush?: boolean; last?: boolean }) {
          sentFrames.push({ replyId, text, ...opts });
        },
        replyCancel(replyId: string) {
          cancelledIds.push(replyId);
        },
      } as unknown as FishRealtimeClient;

      let parkedResolve: (() => void) | null = null;
      const events: Array<Record<string, unknown>> = [];
      const orderState = new DriveThruOrderState();

      const brain = new GeminiVoiceBrain({
        credentialsPath: config.vertex_ai.credentials_path,
        model: "gemini-3.5-flash-lite",
        tier: "priority",
        orderState,
        onEvent: (_ch, payload) => {
          events.push(payload);
          if (payload.type === "tool.awaiting_commit" && parkedResolve) {
            parkedResolve();
          }
        },
      });

      // 1. Eager pause followed by `turn.resumed` -> MUST NOT add Oreo McFlurry!
      const parked1 = new Promise<void>((r) => {
        parkedResolve = r;
      });
      await brain.handleRealtimeEvent(
        { type: "turn.eager", eager_id: "e_drop", turn_id: "t1", text: "One Oreo McFlurry please" },
        fakeRt,
      );
      await parked1;
      expect(orderState.lines).toHaveLength(0);

      await brain.handleRealtimeEvent({ type: "turn.resumed", eager_id: "e_drop" }, fakeRt);
      expect(cancelledIds).toHaveLength(1);
      expect(orderState.lines).toHaveLength(0);

      // 2. Eager pause followed by `turn.committed(approved_eager_id)` -> instant tool execution!
      const parked2 = new Promise<void>((r) => {
        parkedResolve = r;
      });
      await brain.handleRealtimeEvent(
        { type: "turn.eager", eager_id: "e_ok", turn_id: "t2", text: "One Big Mac please" },
        fakeRt,
      );
      await parked2;
      expect(orderState.lines).toHaveLength(0);

      await brain.handleRealtimeEvent(
        {
          type: "turn.committed",
          turn_id: "t2",
          text: "One Big Mac please",
          kind: "turn",
          approved_eager_id: "e_ok",
          lead_ms: 240,
        },
        fakeRt,
      );

      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (orderState.lines.length > 0 && sentFrames.some((f) => f.last === true && !cancelledIds.includes(String(f.replyId)))) {
          break;
        }
      }
      expect(orderState.lines).toHaveLength(1);
      expect(orderState.lines[0].name).toContain("Big Mac");
      expect(events.some((e) => e.type === "llm.eager_approved")).toBe(true);
    },
    30_000,
  );

  it(
    "connects end-to-end to the configured Fish Realtime server and receives synthesized voice + ambience",
    async () => {
      const { validation } = loadAndValidateConfig();
      if (!validation.ready) return;

      const srv = await createStarterServer();
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const port = (srv.address() as AddressInfo).port;

      try {
        // Verify /api/gemini-ping Priority tier
        const pingResp = await fetch(`http://127.0.0.1:${port}/api/gemini-ping`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gemini-3.5-flash-lite", tier: "priority" }),
        });
        const pingJson = (await pingResp.json()) as Record<string, unknown>;
        expect(pingJson.ok).toBe(true);
        expect(pingJson.traffic_type).toBe("ON_DEMAND_PRIORITY");

        // Open browser /ws -> start real call -> verify session.started + welcome reply.started + mixed audio!
        const bws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const seenEvents: string[] = [];
        let audioBytesReceived = 0;

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timed out; seen=${seenEvents.join(",")}`)), 20_000);

          bws.on("open", () => {
            bws.send(JSON.stringify({ type: "call.start", sample_rate: 24000 }));
          });

          bws.on("message", (data, isBinary) => {
            if (isBinary) {
              const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
              audioBytesReceived += buf.byteLength;
              return;
            }
            const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
            if (msg.kind === "event") {
              const payload = msg.payload as Record<string, unknown>;
              const etype = String(payload.type);
              seenEvents.push(etype);
              if (etype === "reply.started" && audioBytesReceived > 0) {
                clearTimeout(timer);
                bws.send(JSON.stringify({ type: "call.stop" }));
                bws.close();
                resolve();
              }
            } else if (msg.kind === "call_error") {
              clearTimeout(timer);
              reject(new Error(String(msg.error)));
            }
          });
          bws.on("error", reject);
        });

        expect(seenEvents).toContain("session.start");
        expect(seenEvents).toContain("session.started");
        expect(seenEvents).toContain("reply.started");
        expect(audioBytesReceived).toBeGreaterThan(2000);
      } finally {
        srv.close();
      }
    },
    30_000,
  );
});
