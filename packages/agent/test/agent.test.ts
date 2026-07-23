/**
 * Agent runtime tests — fully offline: a fake Gateway writes tiny stub files
 * (no network, no ffmpeg), MockPlanner plans deterministically, and the
 * editor agent runs its mock path.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { mt, ProjectStore } from "@vdx/timeline";
import type { AudioElement, TScene, VideoElement } from "@vdx/timeline";
import {
  applyEditInstruction,
  createEntityBank,
  MockPlanner,
  runDirector,
  zPlan,
  type DirectorEvent,
  type DirectorOutcome,
} from "../src/index";
import { FakeGateway } from "./fakes";

// The whole suite must run offline: never let a real key reach the agents.
delete process.env.ANTHROPIC_API_KEY;

const VDX_DIR = path.resolve(import.meta.dir, "../../../.vdx");
fs.mkdirSync(VDX_DIR, { recursive: true });
const workDir = fs.mkdtempSync(path.join(VDX_DIR, "agent-test-"));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function currentScene(store: ProjectStore): TScene {
  const project = store.getProject();
  return project.scenes.find((s) => s.id === project.currentSceneId)!;
}

// ---------------------------------------------------------------------------
// MockPlanner
// ---------------------------------------------------------------------------

describe("MockPlanner", () => {
  const planner = new MockPlanner();
  const brief = "A dreamy short film about a lighthouse keeper and the sea";

  test("produces a valid Plan with real narrative structure", async () => {
    const plan = await planner.plan(brief, { targetDurationSec: 20 });
    expect(() => zPlan.parse(plan)).not.toThrow();

    expect(plan.beats.length).toBe(3);
    expect(plan.beats.map((b) => b.name)).toEqual(["Hook", "Development", "Payoff"]);

    expect(plan.shots.length).toBeGreaterThanOrEqual(4);
    expect(plan.shots.length).toBeLessThanOrEqual(6);
    for (const shot of plan.shots) {
      expect(shot.durationSec).toBeGreaterThanOrEqual(3);
      expect(shot.durationSec).toBeLessThanOrEqual(6);
      // Statelessness + style bible: every prompt is self-contained.
      expect(shot.visualPrompt).toContain(plan.styleBible);
      expect(shot.camera.length).toBeGreaterThan(0);
    }

    // Voiceover per beat, on the beat's first shot; title card on the last.
    expect(plan.shots[0].voiceover).toBeDefined();
    expect(plan.shots[plan.shots.length - 1].textOverlay).toBe(plan.title);
    const voicedBeats = new Set(plan.shots.filter((s) => s.voiceover).map((s) => s.beatId));
    expect(voicedBeats.size).toBe(3);

    // Mood words from the brief feed the music prompt.
    expect(plan.musicPrompt).toContain("dreamy");
  });

  test("shot durations sum to ~target and beats mirror their shots", async () => {
    for (const target of [15, 20, 30]) {
      const plan = await planner.plan(brief, { targetDurationSec: target });
      const shotSum = plan.shots.reduce((sum, s) => sum + s.durationSec, 0);
      expect(Math.abs(shotSum - target)).toBeLessThanOrEqual(target * 0.1);
      const beatSum = plan.beats.reduce((sum, b) => sum + b.durationSec, 0);
      expect(beatSum).toBeCloseTo(shotSum, 6);
    }
  });

  test("is deterministic", async () => {
    const a = await planner.plan(brief, { targetDurationSec: 20 });
    const b = await planner.plan(brief, { targetDurationSec: 20 });
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Director + editor agent over a fake gateway
// ---------------------------------------------------------------------------

describe("runDirector + editor agent (mock)", () => {
  const store = ProjectStore.create();
  const gateway = new FakeGateway(workDir);
  const events: DirectorEvent[] = [];
  let outcome: DirectorOutcome;

  beforeAll(async () => {
    outcome = await runDirector({
      brief: "An upbeat short about a tiny robot learning to garden",
      targetDurationSec: 20,
      store,
      gateway,
      onEvent: (event) => events.push(event),
    });
  });

  test("creates the project from the plan and emits lifecycle events", () => {
    expect(store.getProject().metadata.name).toBe(outcome.plan.title);
    const stages = events.map((e) => e.stage);
    const expectedStages: DirectorEvent["stage"][] = [
      "planning", "plan_ready", "keyframe", "clip", "audio", "assemble", "done",
    ];
    for (const stage of expectedStages) {
      expect(stages).toContain(stage);
    }
    expect(stages).not.toContain("error");
  });

  test("places shots back-to-back on the main track with correct trims", () => {
    const scene = currentScene(store);
    const main = scene.tracks.main.elements as VideoElement[];
    expect(main.length).toBe(outcome.plan.shots.length);

    let cursor = 0;
    for (let i = 0; i < main.length; i++) {
      const el = main[i];
      const shot = outcome.plan.shots[i];
      expect(el.type).toBe("video");
      expect(el.startTime).toBe(cursor); // no gaps, no overlaps
      expect(el.duration).toBe(mt.fromSeconds(shot.durationSec)); // capped at shot length
      expect(el.trimStart).toBe(0);
      expect(el.trimEnd).toBe(el.sourceDuration! - el.duration); // clip came back long
      expect(el.trimEnd).toBeGreaterThan(0);
      cursor += el.duration;
    }
  });

  test("adds voiceover per voiced shot and one ducked music bed", () => {
    const scene = currentScene(store);
    const audio = scene.tracks.audio.flatMap((t) => t.elements) as AudioElement[];
    const voCount = outcome.plan.shots.filter((s) => s.voiceover).length;
    expect(voCount).toBe(3); // one per beat
    expect(audio.length).toBe(voCount + 1);

    const music = audio.find((el) => el.name === "Music")!;
    expect(music).toBeDefined();
    expect(music.startTime).toBe(0);
    expect(music.volume).toBe(0.25);
    expect(music.fadeIn).toBe(mt.fromSeconds(0.5));
    expect(music.fadeOut).toBe(mt.fromSeconds(0.5));

    // Each VO starts exactly at its shot's start.
    const mainStarts = (scene.tracks.main.elements as VideoElement[]).map((el) => el.startTime);
    for (const vo of audio.filter((el) => el.name.startsWith("VO "))) {
      expect(mainStarts).toContain(vo.startTime);
    }
  });

  test("adds the title card as a centered text overlay during the last shot", () => {
    const scene = currentScene(store);
    const textEls = scene.tracks.overlay.flatMap((t) => (t.type === "text" ? t.elements : []));
    expect(textEls.length).toBe(1);
    const title = textEls[0];
    expect(title.content).toBe(outcome.plan.title);
    expect(title.fontSize).toBe(96);
    expect(title.color).toBe("#FFFFFF");
    expect(title.textAlign).toBe("center");

    const lastShot = (currentScene(store).tracks.main.elements as VideoElement[]).at(-1)!;
    expect(title.startTime).toBe(lastShot.startTime);
    expect(title.duration).toBe(lastShot.duration);
  });

  test("summary mentions shot count and cost is the gateway's total", () => {
    expect(outcome.summary).toContain(`${outcome.plan.shots.length} shots`);
    expect(outcome.summary).toContain("mock");
    expect(outcome.costUsd).toBe(0);
  });

  test("registers media assets with mock provenance", () => {
    const assets = store.getProject().mediaAssets;
    // one clip per shot + one speech per voiced shot + one music bed
    expect(assets.length).toBe(outcome.plan.shots.length + 3 + 1);
    for (const asset of assets) {
      expect(asset.provenance.kind).toBe("mock");
      expect(fs.existsSync(asset.src)).toBe(true);
    }
  });

  test("editor mock: 'mute music' zeroes the music volume", async () => {
    const result = await applyEditInstruction(store, "please mute the music");
    expect(result.applied.length).toBe(1);
    const scene = currentScene(store);
    const music = scene.tracks.audio
      .flatMap((t) => t.elements)
      .find((el) => el.name === "Music")!;
    expect(music.volume).toBe(0);
  });

  test("editor mock: 'undo' pops the last command", async () => {
    const depthBefore = store.undoDepth;
    const result = await applyEditInstruction(store, "undo");
    expect(result.applied.length).toBe(1);
    expect(store.undoDepth).toBe(depthBefore - 1);
    // The mute was undone — music volume is back to 0.25.
    const music = currentScene(store)
      .tracks.audio.flatMap((t) => t.elements)
      .find((el) => el.name === "Music")!;
    expect(music.volume).toBe(0.25);
  });

  test("editor mock: 'tighten' retimes the last main video 1.25x", async () => {
    const scene = currentScene(store);
    const before = (scene.tracks.main.elements as VideoElement[]).at(-1)!;
    const durationBefore = before.duration; // dispatch mutates the element in place
    const result = await applyEditInstruction(store, "make the ending a bit faster");
    expect(result.applied.length).toBe(1);
    const after = (currentScene(store).tracks.main.elements as VideoElement[]).find(
      (el) => el.id === before.id,
    )!;
    expect(after.rate).toBe(1.25);
    expect(after.duration).toBe(Math.round(durationBefore / 1.25));
  });

  test("editor mock: free-form instructions explain the missing key", async () => {
    const result = await applyEditInstruction(store, "add a vignette and color-grade shot 2");
    expect(result.applied.length).toBe(0);
    expect(result.reply).toContain("ANTHROPIC_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// Entity bank
// ---------------------------------------------------------------------------

describe("createEntityBank", () => {
  const bankPath = path.join(workDir, "entities.json");

  test("upsert persists, preserves createdAt, and tracks lineage", () => {
    const bank = createEntityBank(bankPath);
    const created = bank.upsert({
      id: "hero",
      type: "character",
      name: "Tiny Robot",
      description: "A palm-sized gardening robot with a chipped green shell.",
      referenceImages: [],
    });
    expect(created.createdAt).toBeTruthy();

    const updated = bank.upsert({
      id: "hero",
      type: "character",
      name: "Tiny Robot v2",
      description: "Now with a watering-can arm.",
      referenceImages: [],
      baseEntityId: "hero",
    });
    expect(updated.createdAt).toBe(created.createdAt); // preserved on update
    expect(updated.baseEntityId).toBe("hero");
    expect(bank.list().length).toBe(1);

    bank.addReferenceImage("hero", "/media/hero-front.png");
    bank.addReferenceImage("hero", "/media/hero-front.png"); // dedup
    expect(bank.get("hero")!.referenceImages).toEqual(["/media/hero-front.png"]);

    // A fresh instance reloads the same state from disk.
    const reloaded = createEntityBank(bankPath);
    expect(reloaded.get("hero")!.name).toBe("Tiny Robot v2");
    expect(reloaded.get("hero")!.createdAt).toBe(created.createdAt);
    expect(reloaded.get("hero")!.referenceImages).toEqual(["/media/hero-front.png"]);
  });

  test("addReferenceImage on a missing entity fails helpfully", () => {
    const bank = createEntityBank(bankPath);
    expect(() => bank.addReferenceImage("nobody", "/x.png")).toThrow(/Entity not found: nobody/);
  });
});
