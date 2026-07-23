/**
 * Context/library integration — fully offline: FakeGateway writes stub files,
 * FakeLibrary records every call, MockPlanner grounds plans in a
 * ProjectContext. Covers the approval gate, entity-conditioned generation,
 * take/canvas bookkeeping, retakes, take re-application, and the
 * library-backed entity bank adapter.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageRequest, VideoRequest } from "@vdx/gateway";
import type { EntityWithAssets, ProjectContext } from "@vdx/library";
import { mt, ProjectStore } from "@vdx/timeline";
import type { VideoElement } from "@vdx/timeline";
import {
  applyTake,
  createLibraryBank,
  MockPlanner,
  retakeShot,
  runDirector,
  zPlan,
  type DirectorEvent,
  type DirectorOutcome,
  type Plan,
} from "../src/index";
import { CLIP_OVERSHOOT_SEC, FakeGateway, FakeLibrary } from "./fakes";

// The whole suite must run offline: never let a real key reach the agents.
delete process.env.ANTHROPIC_API_KEY;

const VDX_DIR = path.resolve(import.meta.dir, "../../../.vdx");
fs.mkdirSync(VDX_DIR, { recursive: true });
const workDir = fs.mkdtempSync(path.join(VDX_DIR, "agent-lib-test-"));

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

const PROJECT_ID = "proj-1";

const BRIEF_LINES = [
  "# Neon Harbor",
  "A smuggler's last run through a glowing port city.",
  "Open on Mara alone at the dock, rain coming down.",
  "The chase tightens through the market stalls.",
  "She lets the cargo go and sails out clean.",
];

function makeEntity(partial: Partial<EntityWithAssets> & Pick<EntityWithAssets, "id" | "type" | "name">): EntityWithAssets {
  const now = new Date().toISOString();
  return {
    description: "",
    referenceImagePaths: [],
    voicePaths: [],
    documentAssetIds: [],
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

function makeContext(): ProjectContext {
  return {
    briefs: [{ name: "brief.md", text: BRIEF_LINES.join("\n") }],
    documents: [],
    entities: [
      makeEntity({
        id: "ent-mara",
        type: "character",
        name: "Mara",
        description: "A weathered smuggler in an oilskin coat",
        referenceImagePaths: ["/refs/mara.png"],
      }),
      makeEntity({
        id: "ent-harbor",
        type: "location",
        name: "Neon Harbor",
        description: "A rain-slick port city stacked with neon signs",
        referenceImagePaths: ["/refs/harbor.png"],
      }),
      makeEntity({
        id: "ent-style",
        type: "style",
        name: "Noir Neon",
        description: "rain-slick noir, neon reflections, anamorphic flares",
      }),
    ],
    uploadedMedia: [],
  };
}

const CAST_IDS = ["ent-mara", "ent-harbor"];
const CAST_NAMES = ["Mara", "Neon Harbor"];

function mainElements(store: ProjectStore): VideoElement[] {
  const project = store.getProject();
  const scene = project.scenes.find((s) => s.id === project.currentSceneId)!;
  return scene.tracks.main.elements as VideoElement[];
}

// ---------------------------------------------------------------------------
// MockPlanner grounded in a ProjectContext
// ---------------------------------------------------------------------------

describe("MockPlanner with context", () => {
  const planner = new MockPlanner();
  const brief = "A moody chase through the docks";
  const context = makeContext();

  test("derives title/logline/beats from the brief and stays zPlan-valid", async () => {
    const plan = await planner.plan(brief, { targetDurationSec: 20, context });
    expect(() => zPlan.parse(plan)).not.toThrow();

    expect(plan.title).toBe("Neon Harbor"); // heading stripped
    expect(plan.logline).toBe(BRIEF_LINES[1]);
    expect(plan.beats.map((b) => b.description)).toEqual(BRIEF_LINES.slice(2, 5));
  });

  test("uses entity names as shot subjects and carries their ids", async () => {
    const plan = await planner.plan(brief, { targetDurationSec: 20, context });
    for (const shot of plan.shots) {
      expect(CAST_NAMES.some((name) => shot.visualPrompt.includes(name))).toBe(true);
      expect(shot.entityIds.length).toBe(1);
      expect(CAST_IDS).toContain(shot.entityIds[0]);
      // Statelessness: the (extended) style bible still rides every prompt.
      expect(shot.visualPrompt).toContain(plan.styleBible);
    }
    // Both cast members appear across the plan.
    const used = new Set(plan.shots.flatMap((s) => s.entityIds));
    expect([...used].sort()).toEqual([...CAST_IDS].sort());
  });

  test("style entity descriptions extend the style bible", async () => {
    const plan = await planner.plan(brief, { targetDurationSec: 20, context });
    expect(plan.styleBible).toContain("rain-slick noir, neon reflections, anamorphic flares");
    expect(plan.styleBible).toContain("cinematic 35mm film look");
  });

  test("is deterministic with context", async () => {
    const a = await planner.plan(brief, { targetDurationSec: 20, context });
    const b = await planner.plan(brief, { targetDurationSec: 20, context });
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Director: approval gate, context-driven references, library bookkeeping,
// then retakes and take re-application against the same run.
// ---------------------------------------------------------------------------

describe("runDirector with context + library", () => {
  const store = ProjectStore.create();
  const gateway = new FakeGateway(workDir);
  const library = new FakeLibrary(workDir);
  const context = makeContext();
  const events: DirectorEvent[] = [];
  let approvedPlan: Plan | undefined;
  let outcome: DirectorOutcome;

  beforeAll(async () => {
    outcome = await runDirector({
      brief: "A neon chase through the harbor",
      targetDurationSec: 20,
      store,
      gateway,
      context,
      library,
      libraryProjectId: PROJECT_ID,
      waitForApproval: async (plan) => {
        approvedPlan = plan;
      },
      onEvent: (event) => events.push(event),
    });
  });

  test("gate: awaiting_approval sits between plan_ready and generation", () => {
    const stages = events.map((e) => e.stage);
    const planReadyAt = stages.indexOf("plan_ready");
    const awaitingAt = stages.indexOf("awaiting_approval");
    const firstKeyframeAt = stages.indexOf("keyframe");
    expect(planReadyAt).toBeGreaterThanOrEqual(0);
    expect(awaitingAt).toBeGreaterThan(planReadyAt);
    expect(firstKeyframeAt).toBeGreaterThan(awaitingAt);
    expect(approvedPlan).toBe(outcome.plan);
    expect(stages).not.toContain("error");
  });

  test("context entities condition generation via referenceImagePaths", () => {
    const images = gateway.requests.filter((r): r is ImageRequest => r.kind === "image");
    expect(images.length).toBe(outcome.plan.shots.length);
    for (let i = 0; i < images.length; i++) {
      const expected = context.entities.find((e) => e.id === outcome.plan.shots[i].entityIds[0])!;
      expect(images[i].referenceImages).toEqual(expected.referenceImagePaths);
    }
    // The clip inherits the same conditioning.
    const videos = gateway.requests.filter((r): r is VideoRequest => r.kind === "video");
    expect(videos[0].referenceImages).toEqual(images[0].referenceImages);
  });

  test("registers keyframe + clip per shot as generated, unorganized assets", () => {
    expect(library.ingestCalls.length).toBe(outcome.plan.shots.length * 2);
    for (const call of library.ingestCalls) {
      expect(call.opts).toEqual({ projectId: PROJECT_ID, purpose: "generated", organize: false });
    }
  });

  test("adds one selected take per shot with keyframe lineage and prompt", () => {
    expect(library.takes.length).toBe(outcome.plan.shots.length);
    for (const shot of outcome.plan.shots) {
      const takes = library.listTakes(PROJECT_ID, shot.id);
      expect(takes.length).toBe(1);
      const take = takes[0];
      expect(take.selected).toBe(true);
      expect(take.prompt).toContain(outcome.plan.styleBible);
      expect(library.getAsset(take.assetId)!.kind).toBe("video");
      expect(library.getAsset(take.keyframeAssetId!)!.kind).toBe("image");
    }
  });

  test("upserts a row of shot canvas cards at y=480, x=40+260*i", () => {
    const cards = library.listCanvasItems(PROJECT_ID).filter((c) => c.refType === "shot");
    expect(cards.length).toBe(outcome.plan.shots.length);
    for (let i = 0; i < outcome.plan.shots.length; i++) {
      const shot = outcome.plan.shots[i];
      const card = cards.find((c) => c.refId === shot.id)!;
      expect(card.x).toBe(40 + 260 * i);
      expect(card.y).toBe(480);
      expect(card.meta).toEqual({ shotId: shot.id });
    }
  });

  // -- retake ---------------------------------------------------------------

  test("retakeShot swaps the right element's mediaId and adds a selected take", async () => {
    const target = outcome.plan.shots[1];
    const before = mainElements(store).find((el) => el.name === target.id)!;
    const beforeMediaId = before.mediaId;
    const slotTicks = before.duration;
    const retakeEvents: DirectorEvent[] = [];

    const result = await retakeShot({
      store,
      gateway,
      plan: outcome.plan,
      shotId: target.id,
      promptTweak: "harder rain, closer framing",
      library,
      libraryProjectId: PROJECT_ID,
      onEvent: (event) => retakeEvents.push(event),
    });

    // Same element, new clip; the slot length is preserved and the overshoot trimmed.
    const after = mainElements(store).find((el) => el.name === target.id)!;
    expect(after.id).toBe(before.id);
    expect(after.mediaId).not.toBe(beforeMediaId);
    expect(after.duration).toBe(slotTicks);
    expect(after.trimStart).toBe(0);
    expect(after.sourceDuration).toBe(mt.fromSeconds(target.durationSec + CLIP_OVERSHOOT_SEC));
    expect(after.trimEnd).toBe(after.sourceDuration! - slotTicks);

    // Untouched neighbors keep their clips.
    const neighbor = mainElements(store).find((el) => el.name === outcome.plan.shots[0].id)!;
    expect(neighbor.mediaId).not.toBe(after.mediaId);

    // The bin asset points at the generated clip, under the library asset id.
    const binAsset = store.getProject().mediaAssets.find((a) => a.id === after.mediaId)!;
    expect(binAsset.src).toBe(result.assetPath);

    // Prompt rebuilt: style bible + tweak, draft tier.
    const lastVideo = gateway.requests.filter((r): r is VideoRequest => r.kind === "video").at(-1)!;
    expect(lastVideo.prompt).toContain(outcome.plan.styleBible);
    expect(lastVideo.prompt).toContain("harder rain, closer framing");
    expect(lastVideo.tier).toBe("draft");
    expect(lastVideo.keyframeImage).toBeDefined();

    // New take selected, the director's original take deselected.
    const takes = library.listTakes(PROJECT_ID, target.id);
    expect(takes.length).toBe(2);
    const selected = takes.filter((t) => t.selected);
    expect(selected.length).toBe(1);
    expect(result.takeId).toBeDefined();
    expect(selected[0].id).toBe(result.takeId!);
    expect(selected[0].assetId).toBe(after.mediaId);
    expect(selected[0].prompt).toContain("harder rain, closer framing");

    expect(retakeEvents.map((e) => e.stage)).toContain("retake");
    expect(result.costUsd).toBe(0);
    expect(result.summary).toContain(target.id);
  });

  test("applyTake swaps back to an older take without duplicating bin assets", () => {
    const target = outcome.plan.shots[1];
    const originalTake = library.listTakes(PROJECT_ID, target.id)[0]; // the director's take
    const originalAsset = library.getAsset(originalTake.assetId)!;

    const result = applyTake({
      store,
      shotId: target.id,
      assetId: originalTake.assetId,
      assetSrc: originalAsset.storagePath,
      durationSec: target.durationSec + CLIP_OVERSHOOT_SEC,
    });
    expect(result.swapped).toBe(true);
    expect(result.userLocked).toBe(false);

    const element = mainElements(store).find((el) => el.name === target.id)!;
    const binAsset = store.getProject().mediaAssets.find((a) => a.id === element.mediaId)!;
    expect(binAsset.src).toBe(originalAsset.storagePath);
    expect(element.duration).toBe(mt.fromSeconds(target.durationSec));

    // The original clip was already in the bin — reused, not re-added.
    const withSrc = store.getProject().mediaAssets.filter((a) => a.src === originalAsset.storagePath);
    expect(withSrc.length).toBe(1);
  });

  test("retakeShot leaves user-locked elements alone and says so", async () => {
    const target = outcome.plan.shots[2];
    const project = store.getProject();
    const scene = project.scenes.find((s) => s.id === project.currentSceneId)!;
    const element = mainElements(store).find((el) => el.name === target.id)!;
    store.dispatch({
      type: "update_element",
      params: {
        sceneId: scene.id,
        ref: { trackId: scene.tracks.main.id, elementId: element.id },
        patch: {},
        byUser: true,
      },
    });
    const beforeMediaId = element.mediaId;

    const result = await retakeShot({
      store,
      gateway,
      plan: outcome.plan,
      shotId: target.id,
      library,
      libraryProjectId: PROJECT_ID,
    });

    expect(result.summary).toContain("user-locked");
    const after = mainElements(store).find((el) => el.name === target.id)!;
    expect(after.mediaId).toBe(beforeMediaId);
    // The take is still registered for manual selection later.
    expect(library.listTakes(PROJECT_ID, target.id).length).toBe(2);
    expect(result.takeId).toBeDefined();
  });

  test("retakeShot throws on unknown shot ids", async () => {
    await expect(
      retakeShot({ store, gateway, plan: outcome.plan, shotId: "shot-nope" }),
    ).rejects.toThrow(/Shot not found in plan: shot-nope/);
  });
});

describe("runDirector gate rejection and library resilience", () => {
  test("a rejecting gate aborts with an error event before any generation", async () => {
    const store = ProjectStore.create();
    const gateway = new FakeGateway(workDir);
    const events: DirectorEvent[] = [];

    await expect(
      runDirector({
        brief: "a doomed plan",
        targetDurationSec: 20,
        store,
        gateway,
        waitForApproval: async () => {
          throw new Error("plan rejected by reviewer");
        },
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow("plan rejected by reviewer");

    const stages = events.map((e) => e.stage);
    expect(stages).toContain("awaiting_approval");
    expect(stages).toContain("error");
    expect(stages).not.toContain("keyframe");
    expect(gateway.requests.length).toBe(0);
  });

  test("library failures never fail the run", async () => {
    class ExplodingLibrary extends FakeLibrary {
      override async ingest(): Promise<never> {
        throw new Error("disk full");
      }
    }
    const store = ProjectStore.create();
    const gateway = new FakeGateway(workDir);
    const library = new ExplodingLibrary(workDir);
    const events: DirectorEvent[] = [];

    const outcome = await runDirector({
      brief: "a resilient run",
      targetDurationSec: 20,
      store,
      gateway,
      library,
      libraryProjectId: PROJECT_ID,
      onEvent: (event) => events.push(event),
    });

    const warning = events.find(
      (e) => e.stage === "assemble" && e.message.includes("Library bookkeeping failed"),
    );
    expect(warning).toBeDefined();
    expect(warning!.stage === "assemble" && warning!.message).toContain("disk full");
    expect(events.map((e) => e.stage)).toContain("done");
    expect(mainElements(store).length).toBe(outcome.plan.shots.length);
    expect(library.takes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Library-backed entity bank adapter
// ---------------------------------------------------------------------------

describe("createLibraryBank", () => {
  const library = new FakeLibrary(workDir);
  const bank = createLibraryBank(library, "proj-bank");

  test("upsert creates, then updates by id and converges by type+name", () => {
    const created = bank.upsert({
      id: "hero",
      type: "character",
      name: "Tiny Robot",
      description: "A palm-sized gardening robot.",
      referenceImages: [],
    });
    // The library owns ids: the bank-chosen id is replaced by the library's.
    expect(created.id).not.toBe("hero");
    expect(created.type).toBe("character");
    expect(bank.get(created.id)!.name).toBe("Tiny Robot");

    const updatedById = bank.upsert({
      id: created.id,
      type: "character",
      name: "Tiny Robot v2",
      description: "Now with a watering-can arm.",
      referenceImages: [],
    });
    expect(updatedById.id).toBe(created.id);
    expect(updatedById.description).toBe("Now with a watering-can arm.");

    const updatedByName = bank.upsert({
      id: "some-unknown-id",
      type: "character",
      name: "Tiny Robot v2",
      description: "Same robot, offered under a new id.",
      referenceImages: [],
    });
    expect(updatedByName.id).toBe(created.id);
    expect(bank.list().length).toBe(1);
  });

  test("addReferenceImage ingests as a reference and links it (await flush)", async () => {
    const hero = bank.list()[0];
    bank.addReferenceImage(hero.id, "/refs/robot-front.png");
    await bank.flush();

    expect(bank.get(hero.id)!.referenceImages).toEqual(["/refs/robot-front.png"]);
    const call = library.ingestCalls.at(-1)!;
    expect(call.input.originalName).toBe("robot-front.png");
    expect(call.opts).toEqual({ projectId: "proj-bank", purpose: "reference", organize: false });
    const link = library.links.at(-1)!;
    expect(link.entityId).toBe(hero.id);
    expect(link.role).toBe("reference");
  });

  test("non-bank entity types stay invisible to the bank", () => {
    library.createEntity({ type: "brief", name: "The Brief", projectId: "proj-bank" });
    expect(bank.list().length).toBe(1);
    expect(bank.list()[0].name).toBe("Tiny Robot v2");
  });
});
