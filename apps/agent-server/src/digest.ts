/**
 * Read-only views of a project: a compact JSON digest for the MCP
 * `get_project` tool and printable outline/timeline lines for the demo CLI.
 * Pure functions over TProject/Plan — no I/O.
 */

import type { Plan } from "@vdx/agent";
import type { TimelineTrack, TProject } from "@vdx/timeline";
import { mt, projectDuration, sceneDuration } from "@vdx/timeline";

const sec = (ticks: number): number => Math.round(mt.toSeconds(ticks) * 1000) / 1000;

/** Compact JSON digest: ids everywhere, times in seconds. */
export function projectDigest(project: TProject): unknown {
  const digestTrack = (track: TimelineTrack, kind: "main" | "overlay" | "audio") => ({
    trackId: track.id,
    kind,
    type: track.type,
    name: track.name,
    elements: track.elements.map((el) => ({
      elementId: el.id,
      type: el.type,
      name: el.name,
      startSec: sec(el.startTime),
      durationSec: sec(el.duration),
      ...("mediaId" in el ? { mediaId: el.mediaId } : {}),
      ...("content" in el ? { content: el.content } : {}),
      ...("volume" in el ? { volume: el.volume } : {}),
      ...("rate" in el && el.rate !== undefined ? { rate: el.rate } : {}),
      ...(el.userModified ? { userModified: true } : {}),
    })),
  });

  return {
    name: project.metadata.name,
    canvas: project.settings.canvasSize,
    durationSec: sec(projectDuration(project)),
    currentSceneId: project.currentSceneId,
    scenes: project.scenes.map((scene) => ({
      sceneId: scene.id,
      name: scene.name,
      durationSec: sec(sceneDuration(scene)),
      tracks: [
        ...scene.tracks.overlay.map((t) => digestTrack(t, "overlay")),
        digestTrack(scene.tracks.main, "main"),
        ...scene.tracks.audio.map((t) => digestTrack(t, "audio")),
      ],
    })),
    mediaAssets: project.mediaAssets.map((asset) => ({
      assetId: asset.id,
      type: asset.type,
      name: asset.name,
      src: asset.src,
      ...(asset.duration !== undefined ? { durationSec: sec(asset.duration) } : {}),
    })),
  };
}

/** Plan outline for terminal output. */
export function planOutlineLines(plan: Plan): string[] {
  const lines: string[] = [];
  const total = plan.shots.reduce((sum, s) => sum + s.durationSec, 0);
  lines.push(`${plan.title} — ${plan.logline}`);
  lines.push(`Style: ${plan.styleBible}`);
  lines.push(`Music: ${plan.musicPrompt}`);
  for (const beat of plan.beats) {
    lines.push(`Beat ${beat.name} (${beat.durationSec.toFixed(1)}s): ${beat.description}`);
    for (const shot of plan.shots.filter((s) => s.beatId === beat.id)) {
      const extras = [
        `camera: ${shot.camera}`,
        ...(shot.voiceover ? [`vo: "${shot.voiceover}"`] : []),
        ...(shot.textOverlay ? [`title: "${shot.textOverlay}"`] : []),
      ].join(", ");
      lines.push(`  ${shot.id} (${shot.durationSec.toFixed(2)}s) — ${extras}`);
    }
  }
  lines.push(`Planned total: ${total.toFixed(2)}s over ${plan.shots.length} shots`);
  return lines;
}

/** Per-track timeline summary: every element with [in – out] times. */
export function timelineSummaryLines(project: TProject): string[] {
  const lines: string[] = [];
  const pushTrack = (track: TimelineTrack, label: string) => {
    lines.push(`${label} "${track.name}" (${track.type}, ${track.elements.length} element(s))`);
    for (const el of track.elements) {
      lines.push(
        `  [${mt.format(el.startTime)} – ${mt.format(el.startTime + el.duration)}] ` +
          `${el.type} "${el.name}"`,
      );
    }
  };
  for (const scene of project.scenes) {
    lines.push(`Scene "${scene.name}" (${mt.toSeconds(sceneDuration(scene)).toFixed(2)}s)`);
    for (const track of scene.tracks.overlay) pushTrack(track, "  overlay");
    pushTrack(scene.tracks.main, "  MAIN");
    for (const track of scene.tracks.audio) pushTrack(track, "  audio");
  }
  lines.push(`Project duration: ${mt.toSeconds(projectDuration(project)).toFixed(2)}s`);
  return lines;
}
