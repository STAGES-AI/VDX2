/**
 * The Renderer implementation: renders scenes with ./scene and stitches them
 * into a project MP4, or extracts a single frame for VLM critics.
 *
 * Concatenation strategy: every scene is encoded with identical settings, so
 * the concat demuxer with stream copy (`-f concat -c copy`) is the default —
 * no generation loss, near-instant. If copy fails for any reason we fall back
 * to a filter-level concat with a re-encode.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { mt, projectDuration, sceneDuration } from "@vdx/timeline";
import type { TProject, TScene } from "@vdx/timeline";
import { probe, run } from "./ffmpeg";
import { renderScene } from "./scene";
import type { FrameOptions, RenderOptions, RenderResult, Renderer } from "./types";

export interface RendererConfig {
  /** Root for intermediate files. Default: <cwd>/.vdx/tmp */
  tmpDir?: string;
  /** Keep per-job intermediates around for debugging. */
  keepIntermediates?: boolean;
}

function pickScenes(project: TProject, sceneId?: string): TScene[] {
  if (sceneId === undefined) return project.scenes;
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) {
    throw new Error(
      `Scene not found: ${sceneId}. Known scenes: ${project.scenes.map((s) => s.id).join(", ")}`,
    );
  }
  return [scene];
}

export function createRenderer(config: RendererConfig = {}): Renderer {
  const tmpRoot = resolve(config.tmpDir ?? join(process.cwd(), ".vdx", "tmp"));

  function newJobDir(): string {
    const dir = join(tmpRoot, `job-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function cleanup(dir: string): void {
    if (!config.keepIntermediates) rmSync(dir, { recursive: true, force: true });
  }

  async function concatScenes(
    parts: string[],
    outPath: string,
    jobDir: string,
    draft: boolean,
    progress: (message: string) => void,
  ): Promise<void> {
    const listPath = join(jobDir, "concat.txt");
    writeFileSync(
      listPath,
      parts.map((p) => `file '${p.replace(/'/g, `'\\''`)}'`).join("\n") + "\n",
    );
    try {
      await run(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outPath]);
    } catch (err) {
      // Should not happen (identical encode settings), but stay correct.
      progress(`Stream-copy concat failed, re-encoding: ${String(err).split("\n")[0]}`);
      const inputs = parts.flatMap((p) => ["-i", p]);
      const graph =
        parts.map((_, i) => `[${i}:v][${i}:a]`).join("") +
        `concat=n=${parts.length}:v=1:a=1[v][a]`;
      await run([
        "-y",
        ...inputs,
        "-filter_complex", graph,
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264",
        "-preset", draft ? "ultrafast" : "veryfast",
        "-crf", draft ? "30" : "23",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "48000",
        outPath,
      ]);
    }
  }

  async function renderProject(project: TProject, options: RenderOptions): Promise<RenderResult> {
    const started = Date.now();
    const progress = options.onProgress ?? (() => {});
    const scenes = pickScenes(project, options.sceneId);
    const renderable = scenes.filter((s) => sceneDuration(s) > 0);
    if (renderable.length === 0) {
      throw new Error(
        options.sceneId
          ? `Scene ${options.sceneId} has no elements — nothing to render`
          : `Project "${project.metadata.name}" has no scene with elements — nothing to render`,
      );
    }
    const skipped = scenes.length - renderable.length;
    if (skipped > 0) progress(`Skipping ${skipped} empty scene(s)`);

    mkdirSync(dirname(resolve(options.outPath)), { recursive: true });
    const jobDir = newJobDir();
    try {
      if (renderable.length === 1) {
        progress(`Rendering scene "${renderable[0].name}"`);
        await renderScene(project, renderable[0], options.outPath, {
          draft: options.draft,
          workDir: jobDir,
          onProgress: progress,
        });
      } else {
        const parts: string[] = [];
        for (let i = 0; i < renderable.length; i++) {
          progress(`Rendering scene ${i + 1}/${renderable.length} ("${renderable[i].name}")`);
          const part = join(jobDir, `scene-${i}.mp4`);
          await renderScene(project, renderable[i], part, {
            draft: options.draft,
            workDir: jobDir,
            onProgress: progress,
          });
          parts.push(part);
        }
        progress(`Concatenating ${parts.length} scenes`);
        await concatScenes(parts, options.outPath, jobDir, options.draft ?? false, progress);
      }
      const probed = await probe(options.outPath);
      return {
        outPath: options.outPath,
        durationSec: probed.durationSec,
        elapsedMs: Date.now() - started,
      };
    } finally {
      cleanup(jobDir);
    }
  }

  /**
   * Extract one frame at a project-level time.
   *
   * Cost note: this renders the containing scene's composite (up to the
   * requested time, full quality) and then seeks into it — O(time-into-scene)
   * per call, not O(1). Provably matches renderProject output; if frame
   * critique becomes hot, cache the per-scene renders keyed by scene content.
   */
  async function renderFrame(project: TProject, options: FrameOptions): Promise<string> {
    const totalTicks = projectDuration(project);
    if (totalTicks <= 0) {
      throw new Error(`Project "${project.metadata.name}" has no content to render a frame from`);
    }
    const ticksPerFrame = mt.ticksPerFrame(project.settings.fps);
    // Clamp inside [0, duration - one frame] so a frame always exists.
    const at = Math.min(Math.max(options.at, 0), Math.max(0, totalTicks - ticksPerFrame));

    // Locate the containing scene (project time = scenes back to back).
    let local = at;
    let target: TScene | undefined;
    for (const scene of project.scenes) {
      const d = sceneDuration(scene);
      if (d <= 0) continue;
      if (local < d) {
        target = scene;
        break;
      }
      local -= d;
    }
    if (!target) {
      // Only reachable through tick rounding at the very end; use the last frame.
      target = [...project.scenes].reverse().find((s) => sceneDuration(s) > 0)!;
      local = Math.max(0, sceneDuration(target) - ticksPerFrame);
    }

    const localSec = mt.toSeconds(local);
    mkdirSync(dirname(resolve(options.outPath)), { recursive: true });
    const jobDir = newJobDir();
    try {
      const sceneFile = join(jobDir, "frame-scene.mp4");
      await renderScene(project, target, sceneFile, {
        draft: false,
        workDir: jobDir,
        limitSec: localSec + 1,
      });
      await run([
        "-y",
        "-ss", localSec.toFixed(6),
        "-i", sceneFile,
        "-frames:v", "1",
        "-update", "1",
        options.outPath,
      ]);
      if (!existsSync(options.outPath)) {
        throw new Error(
          `Frame extraction produced no output at ${options.outPath} (t=${localSec.toFixed(3)}s in scene "${target.name}")`,
        );
      }
      return options.outPath;
    } finally {
      cleanup(jobDir);
    }
  }

  return { renderProject, renderFrame };
}
