/**
 * Thin ffmpeg/ffprobe process helpers shared by providers and the gateway.
 * Everything is spawned argv-style (no shell), so paths and filter strings
 * never need shell quoting — only ffmpeg's own filtergraph escaping.
 */

import { existsSync } from "node:fs";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a command (no shell). Returns exit code + captured output. */
export async function run(cmd: string[], opts?: { stdin?: string }): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd,
    stdin: opts?.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Run ffmpeg with -y and quiet logging; throws with stderr tail on failure. */
export async function runFfmpeg(args: string[]): Promise<void> {
  const cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", ...args];
  const result = await run(cmd);
  if (result.code !== 0) {
    const tail = result.stderr.trim().split("\n").slice(-6).join("\n");
    throw new Error(`ffmpeg failed (exit ${result.code}): ${tail}\n  command: ${cmd.join(" ")}`);
  }
}

export interface MediaProbe {
  durationSec?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
}

/**
 * Probe a local media file with ffprobe. Returns duration (seconds) and,
 * for visual media, width/height. Throws if the file is missing or ffprobe
 * cannot parse it — callers that tolerate unknown metadata should catch.
 */
export async function probeMedia(path: string): Promise<MediaProbe> {
  if (!existsSync(path)) throw new Error(`probeMedia: file does not exist: ${path}`);
  const result = await run([
    "ffprobe",
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,width,height",
    "-of",
    "json",
    path,
  ]);
  if (result.code !== 0) {
    throw new Error(`ffprobe failed for ${path}: ${result.stderr.trim().split("\n").slice(-3).join("\n")}`);
  }
  const parsed = JSON.parse(result.stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  const probe: MediaProbe = {};
  const duration = Number.parseFloat(parsed.format?.duration ?? "");
  if (Number.isFinite(duration)) probe.durationSec = duration;
  const video = parsed.streams?.find((s) => s.codec_type === "video" && s.width && s.height);
  if (video) {
    probe.width = video.width;
    probe.height = video.height;
  }
  probe.hasAudio = parsed.streams?.some((s) => s.codec_type === "audio") ?? false;
  return probe;
}
