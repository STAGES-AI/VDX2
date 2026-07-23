/**
 * Headless renderer contract. Renders a TProject to an MP4 (or a single
 * frame PNG for VLM critics) using ffmpeg. The renderer resolves element
 * `mediaId`s through the project's mediaAssets (local `src` paths).
 */

import type { MediaTime, TProject } from "@vdx/timeline";

export interface RenderOptions {
  outPath: string;
  /** Draft renders at reduced resolution/bitrate for speed. */
  draft?: boolean;
  /** Render a single scene; whole project (scenes concatenated) otherwise. */
  sceneId?: string;
  onProgress?: (message: string) => void;
}

export interface RenderResult {
  outPath: string;
  durationSec: number;
  elapsedMs: number;
}

export interface FrameOptions {
  outPath: string;
  /** Project-level time (across concatenated scenes). */
  at: MediaTime;
}

export interface Renderer {
  renderProject(project: TProject, options: RenderOptions): Promise<RenderResult>;
  renderFrame(project: TProject, options: FrameOptions): Promise<string>;
}
