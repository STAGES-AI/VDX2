/**
 * Best-effort media metadata via ffprobe. The library stays standalone — this
 * is a deliberately tiny process runner, not an import from @vdx/gateway.
 * Probing never fails an ingest: missing ffprobe or unparseable media just
 * yields an empty probe.
 */

import type { AssetKind } from "./types";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawn a command argv-style (no shell). */
export async function run(cmd: string[]): Promise<RunResult> {
  const proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export interface ProbeResult {
  width?: number;
  height?: number;
  durationSec?: number;
}

/**
 * Probe width/height (images, video) and duration (video, audio) with
 * ffprobe. Returns {} when ffprobe is unavailable or cannot parse the file.
 */
export async function probeAsset(path: string, kind: AssetKind): Promise<ProbeResult> {
  if (kind === "document") return {};
  if (!Bun.which("ffprobe")) return {};

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
  if (result.code !== 0) return {};

  let parsed: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
  };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {};
  }

  const probe: ProbeResult = {};
  if (kind !== "image") {
    const duration = Number.parseFloat(parsed.format?.duration ?? "");
    if (Number.isFinite(duration)) probe.durationSec = duration;
  }
  const video = parsed.streams?.find((s) => (s.codec_type === "video" && s.width && s.height));
  if (video) {
    probe.width = video.width;
    probe.height = video.height;
  }
  return probe;
}
