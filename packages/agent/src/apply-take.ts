/**
 * Take application — swap which clip a shot's main-track element plays.
 *
 * The director names every main-track element after its shot id, so a shot's
 * element is located by name and re-pointed at a different media asset. The
 * same swap primitive backs both retakes (new generation) and take selection
 * from the library (an older take). The element's slot on the timeline never
 * moves: duration stays the shot slot length, capped only when the new clip
 * is shorter than the slot.
 */

import type { ProjectStore, Provenance, TScene } from "@vdx/timeline";
import { mt } from "@vdx/timeline";

export interface SwapShotClipOptions {
  store: ProjectStore;
  /** Shot id == main-track element name (director invariant). */
  shotId: string;
  /** Absolute path of the replacement clip file. */
  assetSrc: string;
  /** Stable project-bin id for the clip (e.g. the library asset id). Reused
   *  when already registered, so re-applying a take is idempotent. */
  assetId?: string;
  /** Clip duration in seconds when known; falls back to the registered asset
   *  duration, then to the element's current slot length. */
  durationSec?: number;
  assetName?: string;
  provenance?: Provenance;
}

export interface SwapShotClipResult {
  swapped: boolean;
  /** True when the element is user-locked (userModified) and was left alone. */
  userLocked: boolean;
  /** Project media asset id the element now (or would) point at. */
  mediaId: string;
  elementId: string;
  summary: string;
}

function currentScene(store: ProjectStore): TScene {
  const project = store.getProject();
  const scene = project.scenes.find((s) => s.id === project.currentSceneId);
  if (!scene) throw new Error(`Current scene not found: ${project.currentSceneId}`);
  return scene;
}

/**
 * Point the main-track element named `shotId` at a (possibly new) clip asset.
 * Registers the asset in the project bin when it isn't there yet, then
 * patches mediaId/sourceDuration/trims via update_element with byUser false —
 * so a user-locked element refuses the swap, reported via `userLocked`
 * instead of throwing.
 */
export function swapShotClip(options: SwapShotClipOptions): SwapShotClipResult {
  const { store, shotId, assetSrc } = options;
  const project = store.getProject();
  const scene = currentScene(store);
  const main = scene.tracks.main;
  const element = main.elements.find((el) => el.name === shotId);
  if (!element) {
    throw new Error(
      `No main-track element named "${shotId}" — the director names shot elements after shot ids`,
    );
  }

  // Reuse an existing bin asset (by stable id or by source path) so swapping
  // back and forth between takes never duplicates assets.
  const existing = project.mediaAssets.find(
    (a) => (options.assetId !== undefined && a.id === options.assetId) || a.src === assetSrc,
  );

  const slotTicks = element.duration;
  const sourceTicks =
    options.durationSec !== undefined
      ? mt.fromSeconds(options.durationSec)
      : (existing?.duration ?? slotTicks);
  const durationTicks = Math.min(slotTicks, sourceTicks);

  let mediaId: string;
  if (existing) {
    mediaId = existing.id;
  } else {
    const added = store.dispatch({
      type: "add_media_asset",
      params: {
        asset: {
          ...(options.assetId !== undefined ? { id: options.assetId } : {}),
          type: "video",
          name: options.assetName ?? `${shotId} take`,
          src: assetSrc,
          duration: sourceTicks,
          provenance:
            options.provenance ?? { kind: "generated", generatedAt: new Date().toISOString() },
        },
      },
    });
    mediaId = added.created!.assetId;
  }

  try {
    store.dispatch({
      type: "update_element",
      params: {
        sceneId: scene.id,
        ref: { trackId: main.id, elementId: element.id },
        patch: {
          mediaId,
          duration: durationTicks,
          trimStart: 0,
          trimEnd: Math.max(0, sourceTicks - durationTicks),
          sourceDuration: sourceTicks,
        },
        byUser: false,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("userModified")) {
      return {
        swapped: false,
        userLocked: true,
        mediaId,
        elementId: element.id,
        summary:
          `Shot ${shotId} is user-locked (hand-edited), so its element was left untouched. ` +
          `The clip is registered in the bin — apply it from the UI or ask the user to approve the swap.`,
      };
    }
    throw err;
  }

  return {
    swapped: true,
    userLocked: false,
    mediaId,
    elementId: element.id,
    summary:
      `Swapped ${shotId} to a ${mt.toSeconds(durationTicks).toFixed(1)}s clip ` +
      `(asset ${mediaId}).`,
  };
}

export interface ApplyTakeOptions {
  store: ProjectStore;
  shotId: string;
  /** Library asset id of the take's clip (becomes the project-bin asset id). */
  assetId: string;
  /** Absolute path of the take's clip file. */
  assetSrc: string;
  /** Clip duration in seconds when known. */
  durationSec?: number;
}

/** Select a take: swap the shot's element to the take's clip asset. */
export function applyTake(options: ApplyTakeOptions): SwapShotClipResult {
  return swapShotClip({
    store: options.store,
    shotId: options.shotId,
    assetId: options.assetId,
    assetSrc: options.assetSrc,
    ...(options.durationSec !== undefined ? { durationSec: options.durationSec } : {}),
    assetName: `${options.shotId} take`,
  });
}
