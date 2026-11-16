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

  it("executes all 8 Drive-Thru POS tools accurately (lookup, add, update, remove, get, confirm, cancel, end_call)", () => {
    const pos = new DriveThruOrderState();

    const menu = pos.executeTool("lookup_menu", { query: "Burger" });
    expect(menu.ok).toBe(true);
    expect((menu.items as Array<{ name: string }>).some((i) => i.name === "Burger")).toBe(true);

    const added = pos.executeTool("add_item", {
      item: "Burger",
      qty: 1,
      size: "large",
      meal: true,
      drink: "Lemon-Lime Soda",
      modifiers: ["no pickles"],
    });
    expect(added.ok).toBe(true);
    expect(pos.lines).toHaveLength(1);
    expect(pos.lines[0].meal).toBe(true);
    expect(pos.lines[0].modifiers).toEqual(["no pickles"]);

    const added2 = pos.executeTool("add_item", { item: "French Fries", size: "small" });
    expect(added2.ok).toBe(true);
    expect(pos.lines).toHaveLength(2);

    const updated = pos.executeTool("update_item", { line: 1, qty: 2, drink: "Cola" });
    expect(updated.ok).toBe(true);
    expect(pos.lines[0].qty).toBe(2);
    expect(pos.lines[0].drink).toBe("Cola");

    const removed = pos.executeTool("remove_item", { line: 2 });
    expect(removed.ok).toBe(true);
    expect(pos.lines).toHaveLength(1);

    const got = pos.executeTool("get_order", {});
    expect(got.ok).toBe(true);
    expect((got.order as { total: number }).total).toBeGreaterThan(0);

    const confirmed = pos.executeTool("confirm_order", {});
    expect(confirmed.ok).toBe(true);
    expect(pos.status).toBe("confirmed");

    const hangup = pos.executeTool("end_call", { reason: "order_confirmed" });
    expect(hangup.ok).toBe(true);
    expect(hangup.ending_call).toBe(true);

    const cancelled = pos.executeTool("cancel_order", {});
    expect(cancelled.ok).toBe(true);
    expect(pos.lines).toHaveLength(0);
    expect(pos.status).toBe("cancelled");
  });

  it("never cancels a committed reply on kind='aside' and recovers unspoken remainder on turn.dropped / partial", async () => {
    const sentFrames: Array<Record<string, unknown>> = [];
    const cancelledIds: string[] = [];
    const hangups: string[] = [];
    const fakeRt = {
      isLive: true,
      replyText(replyId: string, text: string, opts?: { forId?: string; flush?: boolean; last?: boolean }) {
        sentFrames.push({ replyId, text, ...opts });
      },
      replyCancel(replyId: string) {
        cancelledIds.push(replyId);
      },
    } as unknown as FishRealtimeClient;

    const brain = new GeminiVoiceBrain({
      credentialsPath: "",
      orderState: new DriveThruOrderState(),
      onHangupRequested: (reason) => {
        hangups.push(reason);
      },
    });

    // 1. Committed reply interrupted by echo (`by: "caller"`), then `kind: "aside"` arrives:
    //    aside must NOT cancel anything, and must trigger cut recovery for the interrupted reply!
    await brain.handleRealtimeEvent(
      {
        type: "reply.done",
        reply_id: "r-echo-1",
        status: "interrupted",
        by: "caller",
        heard_text: "I do,",
        unheard_text: "but I am here to help with your order.",
      },
      fakeRt,
    );
    await brain.handleRealtimeEvent(
      { type: "turn.committed", turn_id: "t_aside", text: "Hey pass me my wallet", kind: "aside" },
      fakeRt,
    );
    expect(cancelledIds).toHaveLength(0);
    expect(sentFrames.some((f) => String(f.text).includes("but I am here to help with your order."))).toBe(true);

    // 2. Caller barge-in followed by `turn.dropped` (reason="echo") -> automatically resumes remainder!
    sentFrames.length = 0;
    await brain.handleRealtimeEvent(
      {
        type: "reply.done",
        reply_id: "r-echo-2",
        status: "interrupted",
        by: "caller",
        heard_text: "Sure,",
        unheard_text: "what can I get started for you today?",
      },
      fakeRt,
    );
    await brain.handleRealtimeEvent({ type: "turn.dropped", reason: "echo" }, fakeRt);
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].text).toBe("what can I get started for you today?");
    expect(sentFrames[0].last).toBe(true);
    expect(sentFrames[0].forId).toBeUndefined();

    // 3. `partial` reply receipt immediately re-sends unheard remainder once
    sentFrames.length = 0;
    await brain.handleRealtimeEvent(
      {
        type: "reply.done",
        reply_id: "r-part-1",
        status: "partial",
        reason: "stopped_early",
        heard_text: "Your total is",
        unheard_text: "$12.50.",
      },
      fakeRt,
    );
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].text).toBe("$12.50.");
    expect(sentFrames[0].last).toBe(true);

    // 4. `end_call` waits for `reply.done` (status="completed") + ~500ms playout before hanging up,
    //    and does NOT hang up if interrupted.
    (brain as unknown as { pendingHangup: { replyId: string; reason: string } | null }).pendingHangup = {
      replyId: "r-bye-1",
      reason: "order_confirmed",
    };
    await brain.handleRealtimeEvent(
      {
        type: "reply.done",
        reply_id: "r-bye-1",
        status: "completed",
        heard_text: "Please pull forward, bye-bye!",
        unheard_text: "",
      },
      fakeRt,
    );
    expect(hangups).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 600));
    expect(hangups).toEqual(["order_confirmed"]);
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
        model: "gemini-3.8-flash",
        tier: "priority",
        orderState,
        onEvent: (_ch, payload) => {
          events.push(payload);
          if (payload.type === "tool.awaiting_commit" && parkedResolve) {
            parkedResolve();
          }
        },
      });

      // 1. Eager pause followed by `turn.resumed` -> MUST NOT add Cookie Sundae!
      const parked1 = new Promise<void>((r) => {
        parkedResolve = r;
      });
      await brain.handleRealtimeEvent(
        { type: "turn.eager", eager_id: "e_drop", turn_id: "t1", text: "One Cookie Sundae please" },
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
        { type: "turn.eager", eager_id: "e_ok", turn_id: "t2", text: "One Burger please" },
        fakeRt,
      );
      await parked2;
      expect(orderState.lines).toHaveLength(0);

      await brain.handleRealtimeEvent(
        {
          type: "turn.committed",
          turn_id: "t2",
          text: "One Burger please",
          kind: "turn",
          approved_eager_id: "e_ok",
          lead_ms: 240,
        },
        fakeRt,
      );

      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (
          orderState.lines.length > 0 &&
          sentFrames.some((f) => f.last === true && !cancelledIds.includes(String(f.replyId)))
        ) {
          break;
        }
      }
      expect(orderState.lines).toHaveLength(1);
      expect(orderState.lines[0].name).toContain("Burger");
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
        // Verify /api/gemini-ping Priority tier with default gemini-3.8-flash
        const pingResp = await fetch(`http://127.0.0.1:${port}/api/gemini-ping`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gemini-3.8-flash", tier: "priority" }),
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
