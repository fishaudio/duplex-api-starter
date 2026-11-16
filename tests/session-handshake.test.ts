import type { AddressInfo } from "node:net";
import { decode, encode } from "@msgpack/msgpack";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { FishRealtimeClient } from "../src/server/fishRealtime.ts";

it.each([
  { label: "enabled by default", noiseCancel: undefined, expected: true },
  { label: "explicitly disabled", noiseCancel: false, expected: false },
])("starts with noise cancellation $label and exchanges binary audio", async ({ noiseCancel, expected }) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const received: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  let outputBytes = 0;
  server.on("connection", (ws) => {
    ws.on("message", (data, binary) => {
      if (!binary) return ws.close(1002);
      const frame = decode(Buffer.from(data as Buffer)) as Record<string, unknown>;
      received.push(frame);
      if (received.length === 1) {
        const audio = frame.audio as Record<string, unknown>;
        // The deployed Duplex endpoint rejects unknown audio fields with 4400.
        const allowed = new Set(["encoding", "sample_rate", "output_sample_rate", "noise_cancellation"]);
        if (frame.type !== "session.start" || !audio || Object.keys(audio).some((key) => !allowed.has(key))) {
          ws.send(encode({ type: "error", code: "invalid_session_start" }));
          return ws.close(4400);
        }
        ws.send(encode({
          type: "session.started", session_id: "test", audio: { output_sample_rate: 24000 },
          noise_cancellation: { on: audio.noise_cancellation ?? false, delay_ms: 0 },
        }));
      } else if (frame.type === "audio") {
        ws.send(encode({ type: "audio", data: new Uint8Array(960) }));
        ws.close(1000);
      }
    });
  });
  const client = new FishRealtimeClient(
    { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/duplex/converse`, sampleRate: 24000, noiseCancel },
    (_channel, event) => { events.push(event); },
    (pcm) => { outputBytes += pcm.length; },
  );
  const timeout = setTimeout(() => client.close(), 2000);
  try {
    await client.connectAndRun();
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.some((event) => event.type === "session.started")).toBe(true);
    expect(received[0].audio).toMatchObject({ noise_cancellation: expected });
    expect(received[0].audio).not.toHaveProperty("noise_cancel");
    expect(events.find((event) => event.type === "session.started")?.noise_cancellation).toMatchObject({ on: expected });
    expect(received[0].turns).toMatchObject({ eager: true });
    expect(received[1].data).toBeInstanceOf(Uint8Array);
    expect(outputBytes).toBe(960);
  } finally {
    clearTimeout(timeout);
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
