/**
 * Director — brief → plan → generated media → assembled timeline.
 *
 * Image-first pipeline per shot: keyframe image, then a video clip
 * conditioned on that keyframe. Clips land back-to-back on the main track;
 * voiceover and a ducked music bed go on audio tracks; title cards go on a
 * text overlay track. Every mutation goes through store.dispatch so the whole
 * run is undoable command-by-command.
 */

import * as path from "node:path";
import type { Gateway, GenerationResult } from "@vdx/gateway";
import type { Library } from "@vdx/library";
import type { MediaTime, ProjectStore, Provenance, TScene } from "@vdx/timeline";
import { mt } from "@vdx/timeline";
import { createPlanner } from "./claude-planner";
import type { DirectorEvent, DirectorOutcome, DirectorRunOptions, Plan, Shot } from "./types";

const CANVAS = { width: 1920, height: 1080 } as const;
const MUSIC_VOLUME = 0.25; // ducked under voiceover
const MUSIC_FADE_SEC = 0.5;
const TITLE_FONT_SIZE = 96;

// Shot cards on the library canvas: one row under the asset/entity cards.
const SHOT_CANVAS_Y = 480;
const SHOT_CANVAS_X0 = 40;
const SHOT_CANVAS_SPACING = 260;

interface GeneratedShot {
  shot: Shot;
  keyframe: GenerationResult;
  clip: GenerationResult;
}

interface PlacedShot {
  shot: Shot;
  startTicks: MediaTime;
  durationTicks: MediaTime;
}

function currentScene(store: ProjectStore): TScene {
  const project = store.getProject();
  const scene = project.scenes.find((s) => s.id === project.currentSceneId);
  if (!scene) throw new Error(`Current scene not found: ${project.currentSceneId}`);
  return scene;
}

/** A store fresh from ProjectStore.create(): default name, nothing placed. */
function isPristine(store: ProjectStore): boolean {
  const project = store.getProject();
  if (project.metadata.name !== "Untitled") return false;
  if (project.mediaAssets.length > 0) return false;
  return project.scenes.every((scene) =>
    [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio].every(
      (track) => track.elements.length === 0,
    ),
  );
}

function provenanceFor(
  gateway: Gateway,
  result: GenerationResult,
  prompt: string,
  entityIds: string[],
): Provenance {
  return {
    kind: gateway.isLive() ? "generated" : "mock",
    prompt,
    model: result.model,
    costUsd: result.costUsd,
    ...(result.seed !== undefined ? { seed: result.seed } : {}),
    ...(entityIds.length > 0 ? { entityIds } : {}),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Register a run's generated media with the library: ingest each keyframe and
 * clip (purpose "generated", no librarian pass), record one selected take per
 * shot, and upsert a row of shot cards on the project canvas. Asset/entity
 * canvas cards are the library's own job on ingest — only shot cards are ours.
 */
async function registerShotsInLibrary(
  library: Library,
  projectId: string,
  clips: GeneratedShot[],
  promptFor: (shot: Shot) => string,
): Promise<void> {
  const existingCards = library
    .listCanvasItems(projectId)
    .filter((item) => item.refType === "shot");
  for (let i = 0; i < clips.length; i++) {
    const { shot, keyframe, clip } = clips[i];
    const keyframeIngest = await library.ingest(
      { data: keyframe.path, originalName: path.basename(keyframe.path) },
      { projectId, purpose: "generated", organize: false },
    );
    const clipIngest = await library.ingest(
      { data: clip.path, originalName: path.basename(clip.path) },
      { projectId, purpose: "generated", organize: false },
    );
    library.addTake({
      projectId,
      shotId: shot.id,
      assetId: clipIngest.asset.id,
      keyframeAssetId: keyframeIngest.asset.id,
      prompt: promptFor(shot),
      selected: true,
    });
    const existing = existingCards.find((item) => item.refId === shot.id);
    library.upsertCanvasItem({
      ...(existing ? { id: existing.id } : {}),
      projectId,
      refType: "shot",
      refId: shot.id,
      x: SHOT_CANVAS_X0 + SHOT_CANVAS_SPACING * i,
      y: SHOT_CANVAS_Y,
      z: 0,
      meta: { shotId: shot.id },
    });
  }
}

export async function runDirector(options: DirectorRunOptions): Promise<DirectorOutcome> {
  const { store, gateway, bank, onEvent } = options;
  const targetDurationSec = options.targetDurationSec ?? 20;
  const planner = options.planner ?? createPlanner();
  const emit = (event: DirectorEvent) => onEvent?.(event);

  try {
    // a. Plan ------------------------------------------------------------
    emit({ stage: "planning", message: `Planning (${planner.mode}) for a ~${targetDurationSec}s video` });
    const plan: Plan = await planner.plan(options.brief, {
      targetDurationSec,
      ...(options.context ? { context: options.context } : {}),
    });
    emit({ stage: "plan_ready", plan });

    // a2. Review gate: block until the caller approves the plan; a rejection
    // aborts the run (the catch below emits the error event).
    if (options.waitForApproval) {
      emit({
        stage: "awaiting_approval",
        message: `Awaiting approval of plan "${plan.title}" (${plan.shots.length} shots)`,
      });
      await options.waitForApproval(plan);
    }

    // b. Ensure a project exists ----------------------------------------
    if (isPristine(store)) {
      store.dispatch({
        type: "create_project",
        params: {
          name: plan.title,
          fps: { numerator: 30, denominator: 1 },
          width: CANVAS.width,
          height: CANVAS.height,
          backgroundColor: "#000000",
        },
      });
    }
    const scene = currentScene(store);
    const sceneId = scene.id;
    const mainTrackId = scene.tracks.main.id;

    // c. Image-first generation per shot, sequentially. Mock providers are
    // fast; in live mode the keyframe→clip pairs are independent per shot and
    // could run under Promise.all with a concurrency cap.
    const contextEntities = new Map(
      (options.context?.entities ?? []).map((entity) => [entity.id, entity]),
    );
    const referencesFor = (shot: Shot): string[] => {
      const paths: string[] = [];
      for (const id of shot.entityIds) {
        const candidates = [
          ...(bank?.get(id)?.referenceImages ?? []),
          ...(contextEntities.get(id)?.referenceImagePaths ?? []),
        ];
        for (const p of candidates) if (!paths.includes(p)) paths.push(p);
      }
      return paths;
    };
    const promptFor = (shot: Shot): string =>
      shot.visualPrompt.includes(plan.styleBible)
        ? shot.visualPrompt
        : `${shot.visualPrompt} ${plan.styleBible}`;

    const clips: GeneratedShot[] = [];
    for (const shot of plan.shots) {
      const prompt = promptFor(shot);
      const referenceImages = referencesFor(shot);

      emit({ stage: "keyframe", shotId: shot.id, message: `Generating keyframe for ${shot.id}` });
      const keyframe = await gateway.generate({
        kind: "image",
        prompt,
        width: CANVAS.width,
        height: CANVAS.height,
        tier: "draft",
        ...(referenceImages.length > 0 ? { referenceImages } : {}),
      });

      emit({ stage: "clip", shotId: shot.id, message: `Generating ${shot.durationSec}s clip for ${shot.id}` });
      const clip = await gateway.generate({
        kind: "video",
        prompt,
        durationSec: shot.durationSec,
        width: CANVAS.width,
        height: CANVAS.height,
        keyframeImage: keyframe.path,
        wantAudio: false,
        tier: "draft",
        ...(referenceImages.length > 0 ? { referenceImages } : {}),
      });
      clips.push({ shot, keyframe, clip });
    }

    // c2. Library bookkeeping — keyframe/clip assets, one selected take per
    // shot, and a shot card row on the canvas. Never fatal: a broken library
    // must not lose an otherwise good run.
    if (options.library && options.libraryProjectId) {
      try {
        await registerShotsInLibrary(options.library, options.libraryProjectId, clips, promptFor);
      } catch (err) {
        emit({
          stage: "assemble",
          message: `Library bookkeeping failed (run continues): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // d. Place clips back-to-back on the main track ---------------------
    emit({ stage: "assemble", message: `Placing ${clips.length} clips on the main track` });
    const placed: PlacedShot[] = [];
    let cursor: MediaTime = 0;
    for (const { shot, clip } of clips) {
      const provenance = provenanceFor(gateway, clip, promptFor(shot), shot.entityIds);
      // Clips may come back slightly long/short of the requested duration:
      // place the probed duration but cap at the planned shot duration.
      const sourceTicks = mt.fromSeconds(clip.durationSec ?? shot.durationSec);
      const shotTicks = mt.fromSeconds(shot.durationSec);
      const durationTicks = Math.min(sourceTicks, shotTicks);

      const added = store.dispatch({
        type: "add_media_asset",
        params: {
          asset: {
            type: "video",
            name: `${shot.id} clip`,
            src: clip.path,
            duration: sourceTicks,
            width: clip.width ?? CANVAS.width,
            height: clip.height ?? CANVAS.height,
            provenance,
          },
        },
      });

      store.dispatch({
        type: "insert_element",
        params: {
          sceneId,
          element: {
            type: "video",
            // INVARIANT: main-track shot elements are named after their shot
            // id — retakeShot/applyTake locate elements by this name.
            name: shot.id,
            mediaId: added.created!.assetId,
            startTime: cursor,
            duration: durationTicks,
            trimStart: 0,
            trimEnd: Math.max(0, sourceTicks - durationTicks),
            sourceDuration: sourceTicks,
            provenance,
          },
          placement: { mode: "explicit", trackId: mainTrackId },
        },
      });

      placed.push({ shot, startTicks: cursor, durationTicks });
      cursor += durationTicks;
    }
    const totalTicks = cursor;

    // e. Voiceover per shot that has a line ------------------------------
    const voShots = placed.filter((p) => p.shot.voiceover);
    for (const { shot, startTicks } of voShots) {
      emit({ stage: "audio", message: `Generating voiceover for ${shot.id}` });
      const speech = await gateway.generate({
        kind: "speech",
        text: shot.voiceover!,
        voice: plan.voice,
        tier: "draft",
      });
      const provenance = provenanceFor(gateway, speech, shot.voiceover!, []);
      const speechTicks = mt.fromSeconds(speech.durationSec ?? shot.durationSec);

      const added = store.dispatch({
        type: "add_media_asset",
        params: {
          asset: {
            type: "audio",
            name: `${shot.id} voiceover`,
            src: speech.path,
            duration: speechTicks,
            provenance,
          },
        },
      });

      store.dispatch({
        type: "insert_element",
        params: {
          sceneId,
          element: {
            type: "audio",
            name: `VO ${shot.id}`,
            mediaId: added.created!.assetId,
            startTime: startTicks,
            duration: speechTicks,
            trimStart: 0,
            trimEnd: 0,
            sourceDuration: speechTicks,
            volume: 1.0,
            provenance,
          },
          placement: { mode: "auto" },
        },
      });
    }

    // f. One music bed, sized to the whole timeline, ducked under VO -----
    emit({ stage: "audio", message: "Generating music bed" });
    const totalSec = mt.toSeconds(totalTicks);
    const music = await gateway.generate({
      kind: "music",
      prompt: plan.musicPrompt,
      durationSec: totalSec,
      tier: "draft",
    });
    const musicProvenance = provenanceFor(gateway, music, plan.musicPrompt, []);
    const musicSourceTicks = mt.fromSeconds(music.durationSec ?? totalSec);
    const musicDurationTicks = Math.min(musicSourceTicks, totalTicks) || musicSourceTicks;

    const musicAsset = store.dispatch({
      type: "add_media_asset",
      params: {
        asset: {
          type: "audio",
          name: "Music bed",
          src: music.path,
          duration: musicSourceTicks,
          provenance: musicProvenance,
        },
      },
    });

    store.dispatch({
      type: "insert_element",
      params: {
        sceneId,
        element: {
          type: "audio",
          name: "Music",
          mediaId: musicAsset.created!.assetId,
          startTime: 0,
          duration: musicDurationTicks,
          trimStart: 0,
          trimEnd: Math.max(0, musicSourceTicks - musicDurationTicks),
          sourceDuration: musicSourceTicks,
          volume: MUSIC_VOLUME,
          fadeIn: mt.fromSeconds(MUSIC_FADE_SEC),
          fadeOut: mt.fromSeconds(MUSIC_FADE_SEC),
          provenance: musicProvenance,
        },
        placement: { mode: "auto" },
      },
    });

    // g. Text overlays (title cards), centered, during the shot window ---
    const overlayShots = placed.filter((p) => p.shot.textOverlay);
    for (const { shot, startTicks, durationTicks } of overlayShots) {
      emit({ stage: "assemble", message: `Adding title card for ${shot.id}` });
      store.dispatch({
        type: "insert_element",
        params: {
          sceneId,
          element: {
            type: "text",
            name: `Title ${shot.id}`,
            content: shot.textOverlay!,
            startTime: startTicks,
            duration: durationTicks,
            trimStart: 0,
            trimEnd: 0,
            fontSize: TITLE_FONT_SIZE,
            fontFamily: "Helvetica",
            color: "#FFFFFF",
            textAlign: "center",
            transform: { x: 0, y: 0, scale: 1, rotation: 0 },
            opacity: 1,
          },
          placement: { mode: "auto" },
        },
      });
    }

    // h. Outcome ---------------------------------------------------------
    const costUsd = gateway.totalCostUsd();
    const summary =
      `Directed "${plan.title}": ${plan.shots.length} shots over ${totalSec.toFixed(1)}s, ` +
      `${voShots.length} voiceover line(s), 1 music bed, ${overlayShots.length} title card(s). ` +
      `Providers: ${gateway.isLive() ? "live" : "mock"}. Estimated cost $${costUsd.toFixed(2)}.`;
    emit({ stage: "done", message: summary });

    return { plan, summary, costUsd };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ stage: "error", message });
    throw err;
  }
}
