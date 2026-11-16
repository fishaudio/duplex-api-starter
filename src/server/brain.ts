/**
 * Vertex AI Gemini Brain Orchestrator (Eager-First + Commit-Gated Tools + Priority Tier).
 *
 * Production best practices demonstrated here:
 *  1. Eager-first execution (`turn.eager` -> `for=eager_id`): begins LLM streaming immediately
 *     during caller pause so Fish synthesizes & buffers speech ahead of `turn.committed`.
 *  2. Write-tool commit gate: read-only tools (`lookup_menu`, `get_order`) run immediately during
 *     `turn.eager`, while mutating tools (`add_item`, `update_item`, `remove_item`, `confirm_order`)
 *     park at `commitGate` until `turn.committed` approves `eager_id`—eliminating phantom POS items!
 *  3. Zero-dead-air tool speech (`say` + `flush: true`): flushes a short spoken phrase before tool
 *     execution and continues Hop 2 on the SAME `reply_id`.
 *  4. Barge-in alignment & false-barge recovery:
 *     - Appends ONLY `reply.done.heard_text` into conversation history.
 *     - `turn.committed (kind: "aside")` never cancels an already-committed active reply.
 *     - If caller barge-in / echo interrupts a reply and then resolves as `turn.dropped`
 *       (`echo`, `filler`, `nonuser`, `no_commit`) or `aside`, automatically resumes the unspoken tail.
 *  5. Vertex AI Priority PayGo: sets `X-Vertex-AI-LLM-Shared-Request-Type: priority`, uses fast
 *     thinking budget/level, and preserves raw `Part[]` (`thoughtSignature`) across tool hops.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { GoogleGenAI, ThinkingLevel, type Content, type Part } from "@google/genai";
import type { GeminiModelOption, GeminiPingResult, OrderSnapshot, TextRules } from "../shared/types.ts";
import { DriveThruOrderState, getGeminiTools, READ_ONLY_TOOLS } from "./driveThru.ts";
import type { FishRealtimeClient } from "./fishRealtime.ts";
import { buildDriveThruPrompt } from "./prompts.ts";

export const GEMINI_MODELS: GeminiModelOption[] = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Recommended)" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite" },
];

function getThinkingConfig(model: string): { thinkingBudget?: number; thinkingLevel?: ThinkingLevel } {
  // gemini-3.8 / 3.5 Flash achieve ~1.5-1.7s TTFT with thinkingBudget=64 while keeping clean tool calls
  if (model.startsWith("gemini-3.8") || model.startsWith("gemini-3.5")) {
    return { thinkingBudget: 64 };
  }
  return { thinkingLevel: ThinkingLevel.LOW };
}

function joinSpokenChunks(head: string, tail: string): string {
  const a = head.trimEnd();
  const b = tail.trimStart();
  if (!a) return tail.trim();
  if (!b) return head.trim();
  if (/^\s/.test(tail) || /\s$/.test(head) || /^[,.;:!?']/.test(b)) {
    return `${a}${tail.startsWith(" ") || /^[,.;:!?']/.test(b) ? "" : " "}${b}`.trim();
  }
  return `${a} ${b}`.trim();
}

class AsyncGate {
  private opened = false;
  private resolvers: Array<() => void> = [];

  public get isOpen(): boolean {
    return this.opened;
  }

  public open(): void {
    this.opened = true;
    for (const r of this.resolvers.splice(0)) r();
  }

  public wait(): Promise<void> {
    if (this.opened) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolvers.push(resolve);
    });
  }
}

interface InFlightRun {
  replyId: string;
  turnId: string;
  eagerId: string | null;
  cancelled: boolean;
  wireStopped: boolean;
  firstSent: boolean;
  unsentTail: string;
  commitGate: AsyncGate;
  stagedHistory: Content[];
}

interface RecoverableCut {
  text: string;
  createdAt: number;
  sourceRun: InFlightRun | null;
  hangupReason?: string;
}

export interface BrainOptions {
  credentialsPath: string;
  location?: string;
  model?: string;
  tier?: "priority" | "normal";
  orderState: DriveThruOrderState;
  onEvent?: (channel: string, payload: Record<string, unknown>) => void | Promise<void>;
  onOrderUpdate?: (snapshot: OrderSnapshot) => void | Promise<void>;
  onHangupRequested?: (reason: string) => void | Promise<void>;
}

export class GeminiVoiceBrain {
  public credentialsPath: string;
  public location: string;
  public model: string;
  public tier: "priority" | "normal";
  public readonly orderState: DriveThruOrderState;

  private textRules: TextRules = {};
  private history: Content[] = [];
  private active: InFlightRun | null = null;
  private replyCounter = 0;
  private pendingHangup: { replyId: string; reason: string } | null = null;
  private recoverableCut: RecoverableCut | null = null;
  private partialRetriedReplies = new Set<string>();

  private readonly onEvent?: (channel: string, payload: Record<string, unknown>) => void | Promise<void>;
  private readonly onOrderUpdate?: (snapshot: OrderSnapshot) => void | Promise<void>;
  private readonly onHangupRequested?: (reason: string) => void | Promise<void>;

  constructor(opts: BrainOptions) {
    this.credentialsPath = opts.credentialsPath;
    this.location = opts.location ?? "global";
    this.model = opts.model ?? "gemini-3.8-flash";
    this.tier = opts.tier ?? "priority";
    this.orderState = opts.orderState;
    this.onEvent = opts.onEvent;
    this.onOrderUpdate = opts.onOrderUpdate;
    this.onHangupRequested = opts.onHangupRequested;
  }

  private buildClient(): { ai: GoogleGenAI; projectId: string } {
    if (!this.credentialsPath || !fs.existsSync(this.credentialsPath)) {
      throw new Error(`Vertex credentials file not found: '${this.credentialsPath}'. Update config.toml.`);
    }
    const sa = JSON.parse(fs.readFileSync(this.credentialsPath, "utf8")) as { project_id: string };
    const headers: Record<string, string> = {};
    if (this.tier === "priority") {
      headers["X-Vertex-AI-LLM-Request-Type"] = "shared";
      headers["X-Vertex-AI-LLM-Shared-Request-Type"] = "priority";
    }

    const ai = new GoogleGenAI({
      vertexai: true,
      project: sa.project_id,
      location: this.location,
      googleAuthOptions: { keyFilename: this.credentialsPath },
      httpOptions: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
    return { ai, projectId: sa.project_id };
  }

  private async emit(channel: string, payload: Record<string, unknown>): Promise<void> {
    if (this.onEvent) await this.onEvent(channel, payload);
  }

  private nextReplyId(prefix = "r"): string {
    this.replyCounter += 1;
    return `${prefix}-${this.replyCounter}-${crypto.randomBytes(2).toString("hex")}`;
  }

  public resetCall(): void {
    this.history = [];
    this.textRules = {};
    this.pendingHangup = null;
    this.recoverableCut = null;
    this.partialRetriedReplies.clear();
    if (this.active) {
      this.active.cancelled = true;
      this.active.commitGate.open();
      this.active = null;
    }
    this.replyCounter = 0;
  }

  public async pingModel(): Promise<GeminiPingResult> {
    const { ai, projectId } = this.buildClient();
    const t0 = performance.now();
    let ttftMs: number | null = null;
    let trafficType = "UNKNOWN";
    const textChunks: string[] = [];

    const stream = await ai.models.generateContentStream({
      model: this.model,
      contents: "Greet a guest pulling up to the McDonald's drive-thru speaker in one short sentence.",
      config: {
        systemInstruction: buildDriveThruPrompt(this.textRules, this.orderState.daypart),
        temperature: 0.4,
        maxOutputTokens: 512,
        thinkingConfig: getThinkingConfig(this.model),
      },
    });

    for await (const chunk of stream) {
      if (chunk.usageMetadata?.trafficType) {
        trafficType = String(chunk.usageMetadata.trafficType);
      }
      if (chunk.text) {
        if (ttftMs === null) ttftMs = performance.now() - t0;
        textChunks.push(chunk.text);
      }
    }

    const totalMs = performance.now() - t0;
    return {
      ok: true,
      project_id: projectId,
      model: this.model,
      tier: this.tier,
      traffic_type: trafficType,
      ttft_ms: Math.round((ttftMs ?? totalMs) * 10) / 10,
      total_ms: Math.round(totalMs * 10) / 10,
      sample_reply: textChunks.join("").trim(),
    };
  }

  public async handleRealtimeEvent(event: Record<string, unknown>, rt: FishRealtimeClient): Promise<void> {
    const etype = String(event.type ?? "");

    if (etype === "session.started") {
      this.textRules = (event.text_rules ?? {}) as TextRules;
      rt.replyText("r-welcome", "Welcome to McDonald's! What can I get started for you today?", {
        last: true,
      });
      return;
    }

    if (etype === "reply.interrupted") {
      const replyId = String(event.reply_id ?? "");
      if (this.active && this.active.replyId === replyId) {
        // Stop transmitting on this dead reply_id, while keeping LLM stream alive in case
        // the interruption turns out to be echo/noise (`turn.dropped`)
        this.active.wireStopped = true;
      }
      return;
    }

    if (etype === "turn.eager") {
      const eagerId = String(event.eager_id ?? "");
      const turnId = String(event.turn_id ?? "");
      const text = String(event.text ?? "").trim();
      if (!text || !eagerId) return;

      this.cancelActive(rt, Boolean(this.active && !this.active.wireStopped));
      this.launchReply(rt, { callerText: text, turnId, eagerId });
      return;
    }

    if (etype === "turn.resumed") {
      const eagerId = String(event.eager_id ?? "");
      if (this.active && this.active.eagerId === eagerId) {
        await this.emit("LLM->", {
          type: "llm.eager_cancelled",
          eager_id: eagerId,
          reply_id: this.active.replyId,
        });
        this.cancelActive(rt, !this.active.wireStopped);
      }
      return;
    }

    if (etype === "turn.committed") {
      const turnId = String(event.turn_id ?? "");
      const text = String(event.text ?? "").trim();
      const kind = String(event.kind ?? "turn");
      const approvedEager = event.approved_eager_id ? String(event.approved_eager_id) : null;
      if (!text) return;

      if (kind === "aside") {
        // Spec: an `aside` stops nothing itself—never cancel an already-committed reply!
        if (this.active && !this.active.commitGate.isOpen) {
          this.cancelActive(rt, !this.active.wireStopped);
        }
        this.history.push({ role: "user", parts: [{ text: `[Guest spoke to passenger: ${text}]` }] });
        if (
          (!this.active || this.active.wireStopped) &&
          this.recoverableCut &&
          Date.now() - this.recoverableCut.createdAt < 6000 &&
          rt.isLive
        ) {
          await this.resendRecoverableCut(rt, "aside");
        }
        return;
      }

      // Real caller turn -> discard any pending cut-recovery from the prior turn
      this.recoverableCut = null;
      this.history.push({ role: "user", parts: [{ text }] });

      if (approvedEager && this.active && this.active.eagerId === approvedEager && !this.active.cancelled) {
        if (this.active.stagedHistory.length > 0) {
          this.history.push(...this.active.stagedHistory);
          this.active.stagedHistory = [];
        }
        this.active.commitGate.open();
        await this.emit("LLM->", {
          type: "llm.eager_approved",
          approved_eager_id: approvedEager,
          reply_id: this.active.replyId,
          lead_ms: event.lead_ms ?? null,
        });
        return;
      }

      this.cancelActive(rt, Boolean(this.active && !this.active.wireStopped));
      this.launchReply(rt, { callerText: null, turnId, eagerId: null });
      return;
    }

    if (etype === "reply.done") {
      const replyId = String(event.reply_id ?? "");
      const heard = String(event.heard_text ?? "").trim();
      const unheard = String(event.unheard_text ?? "").trim();
      const status = String(event.status ?? "");
      const by = event.by ? String(event.by) : "";

      if (heard) {
        this.history.push({ role: "model", parts: [{ text: heard }] });
      }
      if (unheard && (status === "interrupted" || status === "partial")) {
        this.history.push({
          role: "user",
          parts: [{ text: `[Speaker note: guest interrupted before hearing: ${unheard}]` }],
        });
      }

      const matchingRun = this.active && this.active.replyId === replyId ? this.active : null;
      let extraTail = "";
      if (matchingRun) {
        matchingRun.wireStopped = true;
        extraTail = matchingRun.unsentTail;
      }

      const hangupForThisReply =
        this.pendingHangup && this.pendingHangup.replyId === replyId ? this.pendingHangup : null;
      if (hangupForThisReply) {
        this.pendingHangup = null;
      }

      const remainder = joinSpokenChunks(unheard, extraTail);

      if (
        status === "partial" &&
        remainder &&
        rt.isLive &&
        !this.partialRetriedReplies.has(replyId)
      ) {
        const retryId = this.nextReplyId("r-cont");
        this.partialRetriedReplies.add(retryId);
        if (hangupForThisReply) {
          this.pendingHangup = { replyId: retryId, reason: hangupForThisReply.reason };
        }
        rt.replyText(retryId, remainder, { last: true });
        await this.emit("LLM->", {
          type: "llm.resumed_after_partial",
          reply_id: retryId,
          reason: String(event.reason ?? "partial"),
          text: remainder,
        });
        return;
      }

      if (status === "interrupted" && by === "caller" && (remainder || matchingRun)) {
        this.recoverableCut = {
          text: remainder,
          createdAt: Date.now(),
          sourceRun: matchingRun,
          hangupReason: hangupForThisReply?.reason,
        };
        return;
      }

      if (hangupForThisReply && status !== "interrupted") {
        setTimeout(() => {
          if (rt.isLive && this.onHangupRequested) {
            void this.onHangupRequested(hangupForThisReply.reason);
          }
        }, 500);
      }
      return;
    }

    if (etype === "turn.dropped") {
      const reason = String(event.reason ?? "dropped");
      if (
        this.recoverableCut &&
        Date.now() - this.recoverableCut.createdAt < 6000 &&
        rt.isLive
      ) {
        if (this.active && !this.active.commitGate.isOpen) {
          // Drop any unapproved speculative run sparked by the false-barge sound
          this.cancelActive(rt, !this.active.wireStopped);
        }
        await this.resendRecoverableCut(rt, reason);
      }
    }
  }

  private async resendRecoverableCut(rt: FishRealtimeClient, reason: string): Promise<void> {
    const cut = this.recoverableCut;
    this.recoverableCut = null;
    if (!cut || !rt.isLive) return;

    const newReplyId = this.nextReplyId("r-resume");

    // Case 1: The LLM stream for that reply is STILL generating tokens -> seamlessly redirect it!
    if (cut.sourceRun && this.active === cut.sourceRun && !cut.sourceRun.cancelled) {
      const oldId = cut.sourceRun.replyId;
      cut.sourceRun.replyId = newReplyId;
      cut.sourceRun.wireStopped = false;
      cut.sourceRun.unsentTail = "";
      cut.sourceRun.firstSent = true;
      cut.sourceRun.commitGate.open();

      if (cut.hangupReason) {
        this.pendingHangup = { replyId: newReplyId, reason: cut.hangupReason };
      } else if (this.pendingHangup && this.pendingHangup.replyId === oldId) {
        this.pendingHangup.replyId = newReplyId;
      }

      if (cut.text) {
        rt.replyText(newReplyId, `${cut.text} `, { last: false });
      } else {
        cut.sourceRun.firstSent = false;
      }

      await this.emit("LLM->", {
        type: "llm.resumed_after_false_barge",
        reply_id: newReplyId,
        reason,
        text: cut.text,
        streaming_continued: true,
      });
      return;
    }

    // Case 2: The LLM stream already finished -> replay the complete unspoken remainder at once
    if (!cut.text) return;
    if (cut.hangupReason) {
      this.pendingHangup = { replyId: newReplyId, reason: cut.hangupReason };
    }
    rt.replyText(newReplyId, cut.text, { last: true });
    await this.emit("LLM->", {
      type: "llm.resumed_after_false_barge",
      reply_id: newReplyId,
      reason,
      text: cut.text,
      streaming_continued: false,
    });
  }

  private cancelActive(rt: FishRealtimeClient, sendCancel: boolean): void {
    const cur = this.active;
    if (!cur) return;
    cur.cancelled = true;
    cur.commitGate.open();
    if (this.recoverableCut?.sourceRun === cur) {
      this.recoverableCut.sourceRun = null;
    }
    if (sendCancel && rt.isLive) {
      rt.replyCancel(cur.replyId);
    }
    this.active = null;
  }

  private launchReply(
    rt: FishRealtimeClient,
    params: { callerText: string | null; turnId: string; eagerId: string | null },
  ): void {
    const replyId = this.nextReplyId("r");
    const gate = new AsyncGate();
    if (!params.eagerId) gate.open();

    const run: InFlightRun = {
      replyId,
      turnId: params.turnId,
      eagerId: params.eagerId,
      cancelled: false,
      wireStopped: false,
      firstSent: false,
      unsentTail: "",
      commitGate: gate,
      stagedHistory: [],
    };
    this.active = run;

    const workingContents: Content[] = [...this.history];
    if (params.callerText !== null) {
      workingContents.push({ role: "user", parts: [{ text: params.callerText }] });
    }

    void this.executeHops(rt, run, workingContents);
  }

  private async executeHops(
    rt: FishRealtimeClient,
    run: InFlightRun,
    workingContents: Content[],
  ): Promise<void> {
    let spokenAny = false;

    const sendSpeech = (text: string, opts?: { flush?: boolean; last?: boolean }) => {
      if (run.cancelled || !rt.isLive) return;
      if (run.wireStopped) {
        if (text) {
          run.unsentTail += text;
          if (this.recoverableCut?.sourceRun === run) {
            this.recoverableCut.text = joinSpokenChunks(this.recoverableCut.text, text);
          }
        }
        return;
      }
      if (text) spokenAny = true;

      // Only pass `for: eager_id` while speculative; once committed, omit `for` so Fish says it immediately
      const effectiveForId =
        !run.firstSent && !run.commitGate.isOpen ? (run.eagerId ?? undefined) : undefined;

      rt.replyText(run.replyId, text, {
        forId: effectiveForId,
        flush: opts?.flush,
        last: opts?.last,
      });
      run.firstSent = true;
    };

    try {
      const { ai } = this.buildClient();

      for (let hop = 1; hop <= 3; hop++) {
        if (run.cancelled || !rt.isLive) return;

        const t0 = performance.now();
        let ttftMs: number | null = null;
        let trafficType = "UNKNOWN";
        const modelParts: Part[] = [];
        const functionCallParts: Part[] = [];
        const hopText: string[] = [];

        await this.emit("LLM->", {
          type: "llm.request",
          reply_id: run.replyId,
          hop,
          model: this.model,
          tier: this.tier,
          mode: run.eagerId ? "eager" : "committed",
          for: run.eagerId ?? (run.turnId || null),
        });

        const stream = await ai.models.generateContentStream({
          model: this.model,
          contents: workingContents,
          config: {
            systemInstruction: buildDriveThruPrompt(this.textRules, this.orderState.daypart),
            tools: [getGeminiTools()],
            temperature: 0.4,
            maxOutputTokens: 700,
            thinkingConfig: getThinkingConfig(this.model),
          },
        });

        for await (const chunk of stream) {
          if (run.cancelled || !rt.isLive) return;
          if (chunk.usageMetadata?.trafficType) {
            trafficType = String(chunk.usageMetadata.trafficType);
          }
          const parts = chunk.candidates?.[0]?.content?.parts;
          if (!parts) continue;

          for (const part of parts) {
            // Preserve raw Part objects intact (retains Gemini 3 `thoughtSignature`)
            modelParts.push(part);
            if (part.thought) continue;
            if (part.functionCall) {
              functionCallParts.push(part);
            } else if (part.text) {
              if (ttftMs === null) {
                ttftMs = performance.now() - t0;
                await this.emit("LLM->", {
                  type: "llm.first_token",
                  reply_id: run.replyId,
                  hop,
                  ttft_ms: Math.round(ttftMs * 10) / 10,
                  preview: part.text.slice(0, 60),
                });
              }
              hopText.push(part.text);
              sendSpeech(part.text, { last: false });
            }
          }
        }

        const totalMs = performance.now() - t0;
        await this.emit("LLM->", {
          type: "llm.hop_done",
          reply_id: run.replyId,
          hop,
          traffic_type: trafficType,
          ttft_ms: Math.round((ttftMs ?? totalMs) * 10) / 10,
          total_ms: Math.round(totalMs * 10) / 10,
          tool_calls: functionCallParts.map((p) => p.functionCall?.name).filter(Boolean),
          text: hopText.join("").trim(),
        });

        if (functionCallParts.length === 0) {
          sendSpeech("", { last: true });
          return;
        }

        const modelContent: Content = { role: "model", parts: modelParts };
        workingContents.push(modelContent);
        if (run.commitGate.isOpen) {
          this.history.push(modelContent);
        } else {
          run.stagedHistory.push(modelContent);
        }

        const responseParts: Part[] = [];
        for (const fcPart of functionCallParts) {
          const fc = fcPart.functionCall!;
          const toolName = fc.name ?? "unknown";
          const rawArgs = { ...(fc.args ?? {}) } as Record<string, unknown>;
          let sayLine = String(rawArgs.say ?? "").trim();
          delete rawArgs.say;

          // Flush immediate filler speech while the tool runs (held safely by Fish during eager!)
          if (sayLine && !spokenAny && !run.cancelled) {
            if (!sayLine.endsWith(" ")) sayLine += " ";
            sendSpeech(sayLine, { flush: true, last: false });
          }

          // Write tools MUST wait until `turn.committed` approves `eager_id`
          if (!READ_ONLY_TOOLS.has(toolName) && !run.commitGate.isOpen) {
            await this.emit("TOOL->", {
              type: "tool.awaiting_commit",
              reply_id: run.replyId,
              eager_id: run.eagerId,
              tool: toolName,
            });
            await run.commitGate.wait();
            if (run.cancelled || !rt.isLive) return;
          }

          const tTool = performance.now();
          const result = this.orderState.executeTool(toolName, rawArgs);
          const toolMs = Math.round((performance.now() - tTool) * 100) / 100;

          if (toolName === "end_call" && result.ok) {
            this.pendingHangup = {
              replyId: run.replyId,
              reason: String(rawArgs.reason ?? "completed"),
            };
          }

          await this.emit("TOOL->", {
            type: "tool.executed",
            reply_id: run.replyId,
            tool: toolName,
            args: rawArgs,
            say: sayLine.trim() || null,
            latency_ms: toolMs,
            ok: Boolean(result.ok ?? true),
          });
          if (this.onOrderUpdate) {
            await this.onOrderUpdate(this.orderState.snapshot());
          }

          responseParts.push({
            functionResponse: { name: toolName, response: result },
          });
        }

        const toolRespContent: Content = { role: "user", parts: responseParts };
        workingContents.push(toolRespContent);
        if (run.commitGate.isOpen) {
          this.history.push(toolRespContent);
        } else {
          run.stagedHistory.push(toolRespContent);
        }
      }

      sendSpeech("", { last: true });
    } catch (err) {
      if (!run.cancelled) {
        await this.emit("LLM->", {
          type: "llm.error",
          reply_id: run.replyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (this.recoverableCut?.sourceRun === run) {
        this.recoverableCut.sourceRun = null;
      }
      if (this.active === run) {
        this.active = null;
      }
    }
  }
}
