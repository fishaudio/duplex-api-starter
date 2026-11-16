/**
 * Fish Audio Realtime WebSocket Protocol Client (Binary MessagePack framing).
 *
 * Core protocol invariants enforced here:
 *  1. Send `session.start` immediately as the first frame (within 5s, or 1s when busy).
 *  2. Gate the 20 ms real-time audio clock on `session.started`; retain at most 1s of early audio.
 *  3. Stream 20 ms `pcm_s16le` caller chunks continuously—including silence (`0x00`)—so the
 *     session clock never stalls or hits `4408 idle_timeout`.
 *  4. Attach `"for": eager_id | turn_id` ONLY on the first `reply.text` frame of each `reply_id`.
 */

import WebSocket from "ws";
import { decode, encode } from "@msgpack/msgpack";

export const CLOSE_CODE_MEANINGS: Record<number, string> = {
  1000: "normal_closure",
  1002: "protocol_error",
  1009: "message_too_large (>128 KB)",
  1012: "server_restarting",
  4400: "invalid_message_or_session_start",
  4408: "idle_timeout",
  4409: "client_not_reading",
  4413: "session_limit",
  4429: "server_busy",
  4500: "internal_or_asr_degraded",
};

export interface RealtimeConnectOptions {
  url: string;
  authHeader?: string;
  sampleRate: number;
  referenceId?: string;
  ownSpeech?: "natural" | "quiet";
  noiseCancel?: boolean;
  backchannel?: boolean;
  interim?: boolean;
  playbackDelayMs?: number;
}

export class FishRealtimeClient {
  public sessionId = "";
  public outputSampleRate: number;
  public paused = false;
  public txFrames = 0;
  public rxFrames = 0;

  private readonly opts: RealtimeConnectOptions;
  private readonly onEvent: (channel: string, payload: Record<string, unknown>) => void | Promise<void>;
  private readonly onAgentAudio: (pcmS16le: Buffer) => void | Promise<void>;

  private ws: WebSocket | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private micQueue: Buffer = Buffer.alloc(0);
  private started = false;
  private seenReplyIds = new Set<string>();

  constructor(
    opts: RealtimeConnectOptions,
    onEvent: (channel: string, payload: Record<string, unknown>) => void | Promise<void>,
    onAgentAudio: (pcmS16le: Buffer) => void | Promise<void>,
  ) {
    this.opts = opts;
    this.outputSampleRate = opts.sampleRate;
    this.onEvent = onEvent;
    this.onAgentAudio = onAgentAudio;
  }

  public get isLive(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.started;
  }

  public buildSessionStart(): Record<string, unknown> {
    const frame: Record<string, unknown> = {
      type: "session.start",
      audio: {
        encoding: "pcm_s16le",
        sample_rate: Math.trunc(this.opts.sampleRate),
        noise_cancel: this.opts.noiseCancel ?? true,
      },
      own_speech: this.opts.ownSpeech ?? "quiet",
      playback: { delay_ms: Math.trunc(this.opts.playbackDelayMs ?? 260) },
      session_ending: true,
    };

    if (!this.opts.url.includes("/speak")) {
      frame.turns = {
        eager: true, // Always enable eager turns to eliminate turn-taking latency
        backchannel: this.opts.backchannel ?? true,
        interim: this.opts.interim ?? true,
      };
    }

    const refId = (this.opts.referenceId ?? "").trim();
    if (refId) {
      frame.voice = { reference_id: refId };
    }
    return frame;
  }

  public async connectAndRun(): Promise<void> {
    const headers: Record<string, string> = {};
    if (this.opts.authHeader) {
      headers.Authorization = this.opts.authHeader;
    }

    await new Promise<void>((resolve) => {
      const ws = new WebSocket(this.opts.url, { headers, maxPayload: 262_144 });
      this.ws = ws;

      ws.on("open", () => {
        void this.onEvent("WS", { type: "ws.connected", url: this.opts.url });
        this.sendFrame(this.buildSessionStart());
      });

      ws.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          if (body.length < 400) body += chunk.toString("utf8");
        });
        res.on("end", () => {
          void this.onEvent("WS", {
            type: "ws.upgrade_refused",
            status: res.statusCode ?? 0,
            url: this.opts.url,
            fish_error_code: res.headers["x-fish-error-code"] ?? null,
            retry_after: res.headers["retry-after"] ?? null,
            detail: body.trim() || res.statusMessage || "WebSocket upgrade refused",
          });
          ws.close();
          resolve();
        });
      });

      ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
        if (!isBinary) return;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        const msg = decode(buf) as Record<string, unknown>;
        const etype = String(msg.type ?? "unknown");

        if (etype === "session.started") {
          this.started = true;
          this.sessionId = String(msg.session_id ?? "");
          const audioObj = (msg.audio ?? {}) as Record<string, unknown>;
          this.outputSampleRate = Number(audioObj.output_sample_rate ?? this.opts.sampleRate);
          void this.onEvent("S->", msg);
          this.start20msClockPump();
        } else if (etype === "audio") {
          const data = msg.data;
          if (data instanceof Uint8Array) {
            this.rxFrames += 1;
            const pcm = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
            void this.onAgentAudio(pcm);
            void this.onEvent("S->audio", {
              seq: msg.seq,
              type: "audio",
              bytes: pcm.byteLength,
              frame: this.rxFrames,
            });
          }
        } else {
          void this.onEvent("S->", msg);
        }
      });

      ws.on("close", (code: number) => {
        this.stopPump();
        void this.onEvent("WS", {
          type: "ws.closed",
          close_code: code,
          meaning: CLOSE_CODE_MEANINGS[code] ?? "closed",
        });
        resolve();
      });

      ws.on("error", (err: Error) => {
        void this.onEvent("WS", { type: "ws.error", error: err.message });
      });
    });
  }

  public feedCallerPcm(pcmS16le: Buffer): void {
    const capBytes = this.started ? this.opts.sampleRate : this.opts.sampleRate * 2;
    this.micQueue = Buffer.concat([this.micQueue, pcmS16le]);
    if (this.micQueue.byteLength > capBytes) {
      this.micQueue = this.micQueue.subarray(this.micQueue.byteLength - capBytes);
    }
  }

  private start20msClockPump(): void {
    this.stopPump();
    const chunkBytes = Math.trunc(this.opts.sampleRate * 2 * 0.02);
    const silence = Buffer.alloc(chunkBytes, 0);

    this.pumpTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.paused) return;

      let chunk: Buffer;
      if (this.micQueue.byteLength >= chunkBytes) {
        chunk = this.micQueue.subarray(0, chunkBytes);
        this.micQueue = this.micQueue.subarray(chunkBytes);
      } else {
        chunk = silence;
      }

      this.txFrames += 1;
      // Encode Uint8Array so @msgpack/msgpack writes raw MessagePack `bin`
      const packed = encode({
        type: "audio",
        data: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      });
      this.ws.send(packed);
      void this.onEvent("C->audio", {
        type: "audio",
        bytes: chunk.byteLength,
        frame: this.txFrames,
      });
    }, 20);
  }

  private stopPump(): void {
    if (this.pumpTimer) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }
  }

  private sendFrame(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encode(payload));
    void this.onEvent("C->", payload);
  }

  public replyText(
    replyId: string,
    text: string,
    opts?: { forId?: string; flush?: boolean; last?: boolean },
  ): void {
    const frame: Record<string, unknown> = {
      type: "reply.text",
      reply_id: replyId,
      text,
      flush: Boolean(opts?.flush),
      last: Boolean(opts?.last),
    };
    if (!this.seenReplyIds.has(replyId)) {
      this.seenReplyIds.add(replyId);
      if (opts?.forId) {
        frame.for = opts.forId;
      }
    }
    this.sendFrame(frame);
  }

  public replyCancel(replyId: string): void {
    this.sendFrame({ type: "reply.cancel", reply_id: replyId });
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
    this.sendFrame({ type: paused ? "listen.pause" : "listen.resume" });
  }

  public close(): void {
    this.stopPump();
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close(1000);
    }
    this.ws = null;
  }
}
