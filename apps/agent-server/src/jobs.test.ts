import { expect, test } from "bun:test";
import type { JobEvent } from "./jobs";
import { JobRegistry } from "./jobs";

function collector() {
  const events: JobEvent[] = [];
  let ended = 0;
  return {
    events,
    endedCount: () => ended,
    subscriber: {
      onEvent: (event: JobEvent) => events.push(event),
      onEnd: () => {
        ended += 1;
      },
    },
  };
}

test("registry hands out retrievable jobs with unique ids", () => {
  const registry = new JobRegistry();
  const a = registry.createJob();
  const b = registry.createJob();
  expect(a.id).not.toBe(b.id);
  expect(registry.get(a.id)).toBe(a);
  expect(registry.get("missing")).toBeUndefined();
});

test("subscribers get replay of past events, then live ones", () => {
  const job = new JobRegistry().createJob();
  job.emit({ stage: "planning", message: "one" });
  job.emit({ stage: "assemble", message: "two" });

  const c = collector();
  job.subscribe(c.subscriber);
  expect(c.events.map((e) => e.message)).toEqual(["one", "two"]);

  job.emit({ stage: "done", message: "three" });
  expect(c.events.map((e) => e.message)).toEqual(["one", "two", "three"]);
});

test("done settles subscribers exactly once and stores the result", () => {
  const job = new JobRegistry().createJob();
  const c = collector();
  job.subscribe(c.subscriber);
  job.done({ ok: true });
  job.done({ ok: false }); // ignored
  expect(job.settled).toBe(true);
  expect(job.result).toEqual({ ok: true });
  expect(c.endedCount()).toBe(1);
});

test("emit after settle is ignored", () => {
  const job = new JobRegistry().createJob();
  job.done();
  job.emit({ stage: "late", message: "nope" });
  expect(job.events.length).toBe(0);
});

test("subscribing to a settled job replays then ends immediately", () => {
  const job = new JobRegistry().createJob();
  job.emit({ stage: "planning", message: "hi" });
  job.done();
  const c = collector();
  job.subscribe(c.subscriber);
  expect(c.events.length).toBe(1);
  expect(c.endedCount()).toBe(1);
});

test("fail emits a terminal error event and settles", () => {
  const job = new JobRegistry().createJob();
  const c = collector();
  job.subscribe(c.subscriber);
  job.fail(new Error("kaboom"));
  expect(job.settled).toBe(true);
  expect(c.events[c.events.length - 1]).toEqual({ stage: "error", message: "kaboom" });
  expect(c.endedCount()).toBe(1);
});

test("fail after an already-emitted error event does not duplicate it", () => {
  const job = new JobRegistry().createJob();
  job.emit({ stage: "error", message: "director said so" });
  job.fail(new Error("director said so"));
  expect(job.events.filter((e) => e.stage === "error").length).toBe(1);
});

test("unsubscribe stops live delivery", () => {
  const job = new JobRegistry().createJob();
  const c = collector();
  const unsubscribe = job.subscribe(c.subscriber);
  job.emit({ stage: "planning", message: "one" });
  unsubscribe();
  job.emit({ stage: "planning", message: "two" });
  job.done();
  expect(c.events.map((e) => e.message)).toEqual(["one"]);
  expect(c.endedCount()).toBe(0);
});
