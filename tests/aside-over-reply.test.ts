import type { Content } from "@google/genai";
import { describe, expect, it } from "vitest";
import { GeminiVoiceBrain } from "../src/server/brain.ts";
import { DriveThruOrderState } from "../src/server/driveThru.ts";
import type { FishRealtimeClient } from "../src/server/fishRealtime.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; !check(); waited += 10) {
    if (waited >= ms) throw new Error("condition not met in time");
    await wait(10);
  }
}

/** A brain whose Gemini answers each request with the next of `answers` ("" = no words at all). */
function harness(answers: string[]) {
  const frames: Array<{ replyId: string; text: string; forId?: string; flush?: boolean; last?: boolean }> = [];
  const cancelledIds: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const requests: Content[][] = [];
  const rt = {
    isLive: true,
    replyText(replyId: string, text: string, opts?: { forId?: string; flush?: boolean; last?: boolean }) {
      frames.push({ replyId, text, ...opts });
    },
    replyCancel(replyId: string) {
      cancelledIds.push(replyId);
    },
  } as unknown as FishRealtimeClient;
  const brain = new GeminiVoiceBrain({
    credentialsPath: "",
    orderState: new DriveThruOrderState(),
    onEvent: (_channel, payload) => {
      events.push(payload);
    },
  });
  const ai = {
    models: {
      async generateContentStream(req: { contents: Content[] }) {
        requests.push(structuredClone(req.contents));
        const text = answers.shift() ?? "";
        return (async function* () {
          if (text) yield { candidates: [{ content: { role: "model", parts: [{ text }] } }] };
        })();
      },
    },
  };
  (brain as unknown as { buildClient: () => unknown }).buildClient = () => ({ ai, projectId: "test" });
  const send = (event: Record<string, unknown>) => brain.handleRealtimeEvent(event, rt);
  return { brain, frames, cancelledIds, events, requests, send };
}

const userSaid = (text: string): Content => ({ role: "user", parts: [{ text }] });
const agentSaid = (text: string): Content => ({ role: "model", parts: [{ text }] });

describe("asides said over a reply", () => {
  it("holds the words until the reply ends, then passes them to Gemini as the guest's words", async () => {
    const h = harness(["Sure, one Cookie Sundae."]);
    await h.send({ type: "session.started", session_id: "s", text_rules: {} });
    await h.send({ type: "reply.started", reply_id: "r-welcome", at_ms: 400 });
    await h.send({ type: "turn.interim", turn_id: "t1", text: "Can I also" });
    await h.send({ type: "turn.committed", turn_id: "t1", text: "Can I also get a cookie sundae?", kind: "aside" });

    // The reply goes on: nothing is cancelled and Gemini is not asked while it is being said.
    await wait(300);
    expect(h.cancelledIds).toEqual([]);
    expect(h.requests).toHaveLength(0);
    expect(h.events.some((e) => e.type === "llm.aside_held")).toBe(true);

    const welcome = "Welcome! What can I get started for you today?";
    await h.send({ type: "reply.done", reply_id: "r-welcome", status: "completed", heard_text: welcome, unheard_text: "" });
    await until(() => h.frames.some((f) => f.last && f.replyId !== "r-welcome"));

    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].slice(-2)).toEqual([agentSaid(welcome), userSaid("Can I also get a cookie sundae?")]);
    const answer = h.frames.filter((f) => f.replyId !== "r-welcome");
    expect(answer.map((f) => f.text).join("")).toBe("Sure, one Cookie Sundae.");
    expect(answer.every((f) => f.forId === undefined)).toBe(true);
    h.brain.resetCall();
  });

  it("starts no reply when Gemini answers the held words with nothing", async () => {
    const h = harness([""]);
    await h.send({ type: "session.started", session_id: "s", text_rules: {} });
    await h.send({ type: "turn.committed", turn_id: "t1", text: "Hey, pass me my wallet.", kind: "aside" });
    await h.send({ type: "reply.started", reply_id: "r-welcome", at_ms: 400 });
    await h.send({ type: "reply.done", reply_id: "r-welcome", status: "completed", heard_text: "Welcome!", unheard_text: "" });

    await until(() => h.events.some((e) => e.type === "llm.no_reply"));
    expect(h.requests[0].at(-1)).toEqual(userSaid("Hey, pass me my wallet."));
    expect(h.frames.map((f) => f.replyId)).toEqual(["r-welcome"]);
    h.brain.resetCall();
  });

  it("gives the held words to a caller turn committed meanwhile; an aside over no reply stays a note", async () => {
    const h = harness(["Got it, a large Cola."]);

    // No reply in flight: today's behaviour, a note in the history and no request of its own.
    await h.send({ type: "turn.committed", turn_id: "t1", text: "Grab the napkins.", kind: "aside" });
    await wait(300);
    expect(h.requests).toHaveLength(0);

    // Said over a reply that the caller then stops by talking: their turn takes the held words.
    await h.send({ type: "reply.started", reply_id: "r-total", at_ms: 9000 });
    await h.send({ type: "turn.committed", turn_id: "t2", text: "No pickles on that.", kind: "aside" });
    await h.send({ type: "reply.interrupted", reply_id: "r-total", by: "caller", heard_text: "Your total is", final: false });
    await h.send({
      type: "reply.done",
      reply_id: "r-total",
      status: "interrupted",
      by: "caller",
      heard_text: "Your total is",
      unheard_text: "$12.50.",
    });
    await wait(300);
    expect(h.requests).toHaveLength(0);

    await h.send({ type: "turn.committed", turn_id: "t3", text: "And a large cola.", kind: "turn" });
    await until(() => h.requests.length === 1);
    const contents = h.requests[0];
    expect(contents).toContainEqual(userSaid("[Guest spoke to passenger: Grab the napkins.]"));
    expect(contents.slice(-2)).toEqual([userSaid("No pickles on that."), userSaid("And a large cola.")]);
    await wait(300);
    expect(h.requests).toHaveLength(1);
    h.brain.resetCall();
  });
});
