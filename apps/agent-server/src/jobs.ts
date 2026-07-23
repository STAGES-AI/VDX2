/**
 * In-memory job registry backing the SSE endpoints.
 *
 * A job is an append-only event log plus a settled flag. Subscribers get the
 * full past log replayed synchronously on attach, then live events; onEnd
 * fires exactly once per subscriber when the job settles (immediately when
 * subscribing to an already-settled job). Events are plain JSON objects with
 * a `stage` — DirectorEvents flow through unchanged, render jobs add
 * `render_done`.
 *
 * Jobs also carry an approval gate for gated director runs: the runner blocks
 * on waitForApproval() (the director emits its own awaiting_approval event
 * first) and POST /api/jobs/:id/approve resolves it via approve(). The gate
 * is idempotent and order-independent — approving before anyone waits lets
 * the wait resolve immediately.
 */

import { randomUUID } from "node:crypto";

export interface JobEvent {
  stage: string;
  message?: string;
  [key: string]: unknown;
}

export interface JobSubscriber {
  onEvent: (event: JobEvent) => void;
  onEnd: () => void;
}

export interface Job {
  readonly id: string;
  readonly settled: boolean;
  readonly events: readonly JobEvent[];
  readonly result: unknown;
  emit(event: JobEvent): void;
  /** Settle successfully; further emits are ignored. */
  done(result?: unknown): void;
  /** Emit a terminal error event (unless one just fired) and settle. */
  fail(err: unknown): void;
  /** Replay past events, then stream live ones. Returns an unsubscribe fn. */
  subscribe(subscriber: JobSubscriber): () => void;
  /** Open the approval gate (idempotent); resolves pending/future waits. */
  approve(): void;
  /** Resolves once approve() has been called (immediately when it already was). */
  waitForApproval(): Promise<void>;
}

class JobImpl implements Job {
  readonly id = randomUUID();
  settled = false;
  result: unknown = undefined;
  readonly events: JobEvent[] = [];
  private readonly subscribers = new Set<JobSubscriber>();
  private approved = false;
  private approvalWaiters: Array<() => void> = [];

  emit(event: JobEvent): void {
    if (this.settled) return;
    this.events.push(event);
    for (const subscriber of this.subscribers) subscriber.onEvent(event);
  }

  done(result?: unknown): void {
    if (this.settled) return;
    this.result = result;
    this.settle();
  }

  fail(err: unknown): void {
    if (this.settled) return;
    const message = err instanceof Error ? err.message : String(err);
    // runDirector emits its own terminal error event before throwing —
    // don't duplicate it on the stream.
    const last = this.events[this.events.length - 1];
    if (!(last && last.stage === "error")) {
      this.emit({ stage: "error", message });
    }
    this.settle();
  }

  subscribe(subscriber: JobSubscriber): () => void {
    for (const event of this.events) subscriber.onEvent(event);
    if (this.settled) {
      subscriber.onEnd();
      return () => {};
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  approve(): void {
    this.approved = true;
    const waiters = this.approvalWaiters;
    this.approvalWaiters = [];
    for (const resolve of waiters) resolve();
  }

  waitForApproval(): Promise<void> {
    if (this.approved) return Promise.resolve();
    return new Promise((resolve) => {
      this.approvalWaiters.push(resolve);
    });
  }

  private settle(): void {
    this.settled = true;
    for (const subscriber of this.subscribers) subscriber.onEnd();
    this.subscribers.clear();
  }
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  createJob(): Job {
    const job = new JobImpl();
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }
}
