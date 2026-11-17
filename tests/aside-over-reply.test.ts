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

/** A tool call Gemini makes instead of answering with words. */
type ToolCall = { call: string; args: Record<string, unknown> };

/**
 * A brain whose Gemini answers each request with the next of `answers` ("" = no words at all), each
 * `delayMs` after it was asked.
 */
function harness(answers: Array<string | ToolCall>, delayMs = 0) {
  const frames: Array<{ replyId: string; text: string; forId?: string; flush?: boolean; last?: boolean }> = [];
  const cancelledIds: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const requests: Content[][] = [];
  const hangups: string[] = [];
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
    onHangupRequested: (reason) => {
      hangups.push(reason);
    },
  });
  const ai = {
    models: {
      async generateContentStream(req: { contents: Content[] }) {
        requests.push(structuredClone(req.contents));
        const answer = answers.shift() ?? "";
        return (async function* () {
          if (delayMs > 0) await wait(delayMs);
          if (typeof answer !== "string") {
            const part = { functionCall: { name: answer.call, args: answer.args } };
            yield { candidates: [{ content: { role: "model", parts: [part] } }] };
          } else if (answer) {
            yield { candidates: [{ content: { role: "model", parts: [{ text: answer }] } }] };
          }
        })();
      },
    },
  };
  (brain as unknown as { buildClient: () => unknown }).buildClient = () => ({ ai, projectId: "test" });
  const send = (event: Record<string, unknown>) => brain.handleRealtimeEvent(event, rt);
  return { brain, frames, cancelledIds, events, requests, hangups, send };
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

describe("held asides around a stopped reply, an eager and a hangup", () => {
  it("waits for the reply.done of a reply a caller sound stopped, even when the sound is dropped first", async () => {
    const h = harness(["Sure, a cola too."]);
    await h.send({ type: "session.started", session_id: "s", text_rules: {} });
    await h.send({ type: "reply.started", reply_id: "r-welcome", at_ms: 400 });
    await h.send({ type: "turn.committed", turn_id: "t1", text: "Can I get a cola too?", kind: "aside" });
    await h.send({ type: "reply.interrupted", reply_id: "r-welcome", by: "caller", heard_text: "Welcome!", final: false });
    await h.send({ type: "turn.dropped", turn_id: "t2", reason: "echo" });

    // What the guest heard of the welcome is not known yet: Gemini is not asked.
    await wait(400);
    expect(h.requests).toHaveLength(0);

    await h.send({
      type: "reply.done",
      reply_id: "r-welcome",
      status: "interrupted",
      by: "caller",
      heard_text: "Welcome!",
      unheard_text: "What can I get started for you today?",
    });
    await until(() => h.requests.length === 1);
    expect(h.requests[0].slice(-3)).toEqual([
      agentSaid("Welcome!"),
      userSaid("[Speaker note: guest interrupted before hearing: What can I get started for you today?]"),
      userSaid("Can I get a cola too?"),
    ]);
    h.brain.resetCall();
  });

  it("puts held words before the words of an eager, and its approved turn keeps them; a wordless aside is a note", async () => {
    const h = harness(["One large cola, coming up."], 200);
    await h.send({ type: "session.started", session_id: "s", text_rules: {} });
    await h.send({ type: "reply.started", reply_id: "r-welcome", at_ms: 400 });
    await h.send({ type: "turn.committed", turn_id: "t0", text: "...", kind: "aside" });
    await h.send({ type: "turn.committed", turn_id: "t1", text: "Is the cola diet?", kind: "aside" });
    expect(h.events.filter((e) => e.type === "llm.aside_held").map((e) => e.text)).toEqual(["Is the cola diet?"]);

    await h.send({ type: "turn.eager", turn_id: "t2", eager_id: "e1", text: "A large cola please." });
    await until(() => h.requests.length === 1);
    expect(h.requests[0].slice(-2)).toEqual([userSaid("Is the cola diet?"), userSaid("A large cola please.")]);

    await h.send({ type: "turn.committed", turn_id: "t2", text: "A large cola please.", kind: "turn", approved_eager_id: "e1" });
    await until(() => h.frames.some((f) => f.last && f.replyId !== "r-welcome"));
    expect(h.events.some((e) => e.type === "llm.eager_approved")).toBe(true);
    const history = (h.brain as unknown as { history: Content[] }).history;
    expect(history).toContainEqual(userSaid("[Guest spoke to passenger: ...]"));
    expect(history.slice(-2)).toEqual([userSaid("Is the cola diet?"), userSaid("A large cola please.")]);

    await h.send({ type: "reply.done", reply_id: "r-welcome", status: "replaced", by: "replaced", heard_text: "Welcome!", unheard_text: "" });
    await wait(300);
    expect(h.requests).toHaveLength(1);
    h.brain.resetCall();
  });

  it("hangs up after an end_call that says no words, once no reply is being said", async () => {
    const h = harness([{ call: "end_call", args: { reason: "guest_goodbye" } }, ""]);
    await h.send({ type: "session.started", session_id: "s", text_rules: {} });
    await h.send({ type: "reply.started", reply_id: "r-welcome", at_ms: 400 });
    // The guest's goodbye commits while the welcome is still being said: the hangup waits for it.
    await h.send({ type: "turn.committed", turn_id: "t1", text: "Bye!", kind: "turn" });
    await until(() => h.events.some((e) => e.type === "llm.no_reply"));
    await wait(700);
    expect(h.hangups).toEqual([]);
    expect(h.frames.map((f) => f.replyId)).toEqual(["r-welcome"]);

    await h.send({ type: "reply.done", reply_id: "r-welcome", status: "completed", heard_text: "Welcome!", unheard_text: "" });
    await until(() => h.hangups.length === 1);
    expect(h.hangups).toEqual(["guest_goodbye"]);
    h.brain.resetCall();

    // Nothing being said: the call closes ~500 ms after the empty answer.
    const g = harness([{ call: "end_call", args: { reason: "guest_goodbye" } }, ""]);
    await g.send({ type: "turn.committed", turn_id: "t1", text: "Bye!", kind: "turn" });
    await until(() => g.hangups.length === 1, 1500);
    expect(g.hangups).toEqual(["guest_goodbye"]);
    expect(g.frames).toEqual([]);
    g.brain.resetCall();
  });

  it("does not answer words held over the farewell: the call ends and they stay in the history", async () => {
    const farewell = "Thank you, bye-bye!";
    const h = harness([{ call: "end_call", args: { reason: "order_confirmed", say: farewell } }, ""]);
    await h.send({ type: "turn.committed", turn_id: "t1", text: "That's all, thanks.", kind: "turn" });
    await until(() => h.frames.some((f) => f.last));
    const replyId = h.frames[0].replyId;
    await h.send({ type: "reply.started", reply_id: replyId, at_ms: 9000 });
    await h.send({ type: "turn.committed", turn_id: "t2", text: "Did they put the napkins in?", kind: "aside" });
    await h.send({ type: "reply.done", reply_id: replyId, status: "completed", heard_text: farewell, unheard_text: "" });

    await until(() => h.hangups.length === 1);
    expect(h.hangups).toEqual(["order_confirmed"]);
    expect(h.requests).toHaveLength(2);
    expect(h.events.some((e) => e.type === "llm.aside_unanswered")).toBe(true);
    h.brain.resetCall();
  });
});

describe("a hangup the guest talks past", () => {
  const goodbyeWithNoWords = (): Array<string | ToolCall> => [{ call: "end_call", args: { reason: "guest_goodbye" } }, ""];

  /** The guest's goodbye commits while the welcome is said; Gemini ends the call with no words. */
  async function goodbyeOverWelcome(h: ReturnType<typeof harness>): Promise<void> {
    await h.send({ type: "session.started", session_id: "s", text_rules: {} });
    await h.send({ type: "reply.started", reply_id: "r-welcome", at_ms: 400 });
    await h.send({ type: "turn.committed", turn_id: "t1", text: "Bye!", kind: "turn" });
    await until(() => h.events.some((e) => e.type === "llm.no_reply"));
  }

  const welcomeReplaced = { type: "reply.done", reply_id: "r-welcome", status: "replaced", by: "replaced", heard_text: "Welcome!", unheard_text: "" };

  it("drops the hangup waiting on the welcome when the guest's next turn is answered over it", async () => {
    const answer = "Sure, a large cola first.";
    const h = harness([...goodbyeWithNoWords(), answer]);
    await goodbyeOverWelcome(h);

    // The guest keeps talking: the answer to their new turn replaces the welcome and is not cut.
    await h.send({ type: "turn.committed", turn_id: "t2", text: "Wait, a large cola first.", kind: "turn" });
    await until(() => h.frames.some((f) => f.last && f.replyId !== "r-welcome"));
    const answerId = h.frames.at(-1)!.replyId;
    await h.send(welcomeReplaced);
    await h.send({ type: "reply.started", reply_id: answerId, at_ms: 3000 });
    await wait(700);
    expect(h.hangups).toEqual([]);
    expect(h.events.some((e) => e.type === "llm.hangup_dropped")).toBe(true);

    await h.send({ type: "reply.done", reply_id: answerId, status: "completed", heard_text: answer, unheard_text: "" });
    await wait(700);
    expect(h.hangups).toEqual([]);
    h.brain.resetCall();
  });

  it("drops it too when the welcome ends while the answer to the guest's next turn is still being written", async () => {
    const h = harness([...goodbyeWithNoWords(), "Sure, a large cola first."], 300);
    await goodbyeOverWelcome(h);

    await h.send({ type: "turn.committed", turn_id: "t2", text: "Wait, a large cola first.", kind: "turn" });
    await h.send({ type: "reply.done", reply_id: "r-welcome", status: "completed", heard_text: "Welcome!", unheard_text: "" });
    await until(() => h.frames.some((f) => f.last && f.replyId !== "r-welcome"));
    await wait(700);
    expect(h.hangups).toEqual([]);
    h.brain.resetCall();
  });

  it("takes a replaced reply for no farewell, even when its receipt comes before the turn commits", async () => {
    const h = harness([...goodbyeWithNoWords(), "Sure, a large cola first."]);
    await goodbyeOverWelcome(h);

    await h.send({ type: "turn.eager", turn_id: "t2", eager_id: "e2", text: "Wait, a large cola first." });
    await until(() => h.frames.some((f) => f.last && f.replyId !== "r-welcome"));
    await h.send(welcomeReplaced);
    await h.send({ type: "turn.committed", turn_id: "t2", text: "Wait, a large cola first.", kind: "turn", approved_eager_id: "e2" });
    await wait(700);
    expect(h.hangups).toEqual([]);
    h.brain.resetCall();
  });

  it("closes the call once when the guest says goodbye again as it closes", async () => {
    const farewell = "Thank you, bye-bye!";
    const h = harness([{ call: "end_call", args: { reason: "order_confirmed", say: farewell } }, "", ...goodbyeWithNoWords()]);
    await h.send({ type: "turn.committed", turn_id: "t1", text: "That's all, thanks.", kind: "turn" });
    await until(() => h.frames.some((f) => f.last));
    const replyId = h.frames[0].replyId;
    await h.send({ type: "reply.started", reply_id: replyId, at_ms: 9000 });
    await h.send({ type: "reply.done", reply_id: replyId, status: "completed", heard_text: farewell, unheard_text: "" });

    // The guest's own goodbye commits while the line closes: Gemini ends the call again, with no words.
    await h.send({ type: "turn.committed", turn_id: "t2", text: "Bye!", kind: "turn" });
    await until(() => h.events.some((e) => e.type === "llm.no_reply"));
    await wait(700);
    expect(h.hangups).toEqual(["order_confirmed"]);
    h.brain.resetCall();
  });
});
