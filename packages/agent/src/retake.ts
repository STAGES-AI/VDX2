/**
 * Retake — regenerate a single shot and swap it into the timeline.
 *
 * Rebuilds the shot's visual prompt (style bible + visualPrompt + optional
 * user tweak), runs the same image-first keyframe→clip pipeline as the
 * director at draft tier, registers the result as a selected take in the
 * library when one is attached, and swaps the shot's main-track element to
 * the new clip via the shared swapShotClip primitive. A user-locked element
 * (userModified) refuses the swap; the outcome summary says so instead of
 * throwing, and the generated take remains available for manual selection.
 */

import * as path from "node:path";
import { probeMedia } from "@vdx/gateway";
import type { Provenance } from "@vdx/timeline";
import { swapShotClip } from "./apply-take";
import type { DirectorEvent, RetakeOptions, RetakeOutcome } from "./types";

export async function retakeShot(options: RetakeOptions): Promise<RetakeOutcome> {
  const { store, gateway, plan, shotId, promptTweak, library, libraryProjectId, bank, onEvent } =
    options;
  const emit = (event: DirectorEvent) => onEvent?.(event);

  const shot = plan.shots.find((s) => s.id === shotId);
  if (!shot) {
    throw new Error(`Shot not found in plan: ${shotId} (shots: ${plan.shots.map((s) => s.id).join(", ")})`);
  }

  // Rebuild the prompt: style bible always present, user tweak appended.
  const base = shot.visualPrompt.includes(plan.styleBible)
    ? shot.visualPrompt
    : `${shot.visualPrompt} ${plan.styleBible}`;
  const prompt = promptTweak ? `${base} ${promptTweak}` : base;
  const referenceImages = shot.entityIds.flatMap((id) => bank?.get(id)?.referenceImages ?? []);
  const { width, height } = store.getProject().settings.canvasSize;

  emit({
    stage: "retake",
    shotId,
    message: `Retaking ${shotId}${promptTweak ? ` — "${promptTweak}"` : ""}`,
  });

  emit({ stage: "keyframe", shotId, message: `Generating keyframe for ${shotId}` });
  const keyframe = await gateway.generate({
    kind: "image",
    prompt,
    width,
    height,
    tier: "draft",
    ...(referenceImages.length > 0 ? { referenceImages } : {}),
  });

  emit({ stage: "clip", shotId, message: `Generating ${shot.durationSec}s clip for ${shotId}` });
  const clip = await gateway.generate({
    kind: "video",
    prompt,
    durationSec: shot.durationSec,
    width,
    height,
    keyframeImage: keyframe.path,
    wantAudio: false,
    tier: "draft",
    ...(referenceImages.length > 0 ? { referenceImages } : {}),
  });

  // Providers usually report duration; probe as a fallback, then trust the plan.
  let durationSec = clip.durationSec;
  if (durationSec === undefined) {
    try {
      durationSec = (await probeMedia(clip.path)).durationSec;
    } catch {
      // Unprobeable media (or no ffprobe): fall through to the planned length.
    }
  }
  durationSec ??= shot.durationSec;

  // Library bookkeeping (never fatal): new keyframe + clip assets, selected take.
  let takeId: string | undefined;
  let libraryAssetId: string | undefined;
  let libraryNote = "";
  if (library && libraryProjectId) {
    try {
      const keyframeIngest = await library.ingest(
        { data: keyframe.path, originalName: path.basename(keyframe.path) },
        { projectId: libraryProjectId, purpose: "generated", organize: false },
      );
      const clipIngest = await library.ingest(
        { data: clip.path, originalName: path.basename(clip.path) },
        { projectId: libraryProjectId, purpose: "generated", organize: false },
      );
      const take = library.addTake({
        projectId: libraryProjectId,
        shotId,
        assetId: clipIngest.asset.id,
        keyframeAssetId: keyframeIngest.asset.id,
        prompt,
        selected: true,
      });
      takeId = take.id;
      libraryAssetId = clipIngest.asset.id;
    } catch (err) {
      libraryNote = ` Library bookkeeping failed: ${err instanceof Error ? err.message : String(err)}.`;
    }
  }

  const provenance: Provenance = {
    kind: gateway.isLive() ? "generated" : "mock",
    prompt,
    model: clip.model,
    costUsd: clip.costUsd,
    ...(clip.seed !== undefined ? { seed: clip.seed } : {}),
    ...(shot.entityIds.length > 0 ? { entityIds: shot.entityIds } : {}),
    generatedAt: new Date().toISOString(),
  };

  const swap = swapShotClip({
    store,
    shotId,
    assetSrc: clip.path,
    ...(libraryAssetId !== undefined ? { assetId: libraryAssetId } : {}),
    durationSec,
    assetName: `${shotId} retake`,
    provenance,
  });

  const costUsd = keyframe.costUsd + clip.costUsd;
  const summary = swap.swapped
    ? `Retook ${shotId}: generated a new ${durationSec.toFixed(1)}s clip and swapped it in.` +
      `${libraryNote} Cost $${costUsd.toFixed(2)}.`
    : `${swap.summary}${libraryNote}`;
  emit({ stage: "retake", shotId, message: summary });

  return { ...(takeId !== undefined ? { takeId } : {}), assetPath: clip.path, summary, costUsd };
}
