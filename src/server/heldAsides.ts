/**
 * Asides said over a reply, held until the reply ends.
 *
 * Fish commits words that were no turn at the agent as `turn.committed` with `kind: "aside"`, and an
 * aside stops nothing. One that comes while a reply of ours is being said (or still being written) can
 * be the caller talking over the agent without the recognizer taking it for a turn: most often a second
 * voice on a speakerphone, sometimes the caller adding something in passing. Its words go to Gemini as
 * the guest's words, after the reply: a request started now would not know how much of the reply the
 * guest heard, and its answer would replace the reply being said. The prompt lets Gemini answer with
 * nothing when the words were not meant for the agent. The Fish agent platform does the same.
 *
 * The words wait until no reply is in flight, the `reply.done` of a reply that was stopped has come,
 * and the caller has gone quiet with nothing of theirs left to commit. A caller turn committed
 * meanwhile takes them (`take`): they are answered with that turn, not on their own.
 */

/** How often the wait is checked. */
const POLL_MS = 100;
/**
 * How long after the caller was last heard (`turn.interim`, `turn.eager`, a reply they stopped) their
 * commit or drop is waited for. Fish commits about 1.1 s after the caller stops, the eager and the
 * last interim come earlier, and an eager can end with no turn event at all.
 */
const CALLER_COMMIT_WAIT_MS = 1500;

export interface HeldAsidesOptions {
  /**
   * A reply of ours is being said or written, or one was stopped and its `reply.done` (what the guest
   * heard of it) is still to come: the held words wait, so that they go after what was heard.
   */
  replyInFlight(): boolean;
  /** Nothing is in the way any more: the held words go to Gemini as one guest message. */
  release(text: string): void;
}

export class HeldAsides {
  private held: string[] = [];
  /** When the caller was last heard with no commit or drop since; undefined when nothing is to come. */
  private callerHeardAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: HeldAsidesOptions) {}

  public get pending(): boolean {
    return this.held.length > 0;
  }

  public hold(text: string): void {
    this.held.push(text);
    this.arm();
  }

  /** The held words, still held: an eager request puts them before the caller's new words. */
  public peek(): string | undefined {
    return this.held.length > 0 ? this.held.join(" ") : undefined;
  }

  /** The held words leave without a request of their own: a caller turn takes them. */
  public take(): string | undefined {
    const text = this.peek();
    this.clear();
    return text;
  }

  /** The caller is talking: what they say may become a turn that takes the held words. */
  public onCallerHeard(): void {
    this.callerHeardAt = Date.now();
  }

  /** The caller's words were committed or dropped: nothing of theirs is still to come. */
  public onCallerDone(): void {
    this.callerHeardAt = undefined;
  }

  /** A new call: nothing is held and nothing is waited for. */
  public clear(): void {
    this.held = [];
    this.callerHeardAt = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), POLL_MS);
    this.timer.unref?.();
  }

  private check(): void {
    this.timer = undefined;
    if (this.held.length === 0) return;
    const callerToCommit =
      this.callerHeardAt !== undefined && Date.now() - this.callerHeardAt < CALLER_COMMIT_WAIT_MS;
    if (callerToCommit || this.opts.replyInFlight()) {
      this.arm();
      return;
    }
    this.opts.release(this.take()!);
  }
}
