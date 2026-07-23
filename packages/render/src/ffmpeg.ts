/**
 * Thin ffmpeg/ffprobe process wrappers. Every renderer invocation funnels
 * through here so failures always carry the exact command line and a stderr
 * tail — the fastest way to debug a bad filtergraph.
 *
 * Binaries resolve from PATH; override with FFMPEG_PATH / FFPROBE_PATH.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface ProbeResult {
  durationSec: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "ffprobe";

const STDERR_TAIL_CHARS = 4000;

function tail(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= STDERR_TAIL_CHARS ? trimmed : `…${trimmed.slice(-STDERR_TAIL_CHARS)}`;
}

async function exec(bin: string, args: string[]): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    throw new Error(`Failed to start ${bin} — is it installed and on PATH? (${String(err)})`);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${bin} exited with code ${exitCode}\n` +
        `command: ${bin} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}\n` +
        `stderr tail:\n${tail(stderr)}`,
    );
  }
  return { stdout, stderr };
}

/** Run ffmpeg with the given args; throws with a stderr tail on failure. */
export function run(args: string[]): Promise<RunResult> {
  return exec(FFMPEG, args);
}

/** ffprobe a media file for the metadata the renderer cares about. */
export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await exec(FFPROBE, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  let parsed: {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe returned unparseable JSON for ${path}:\n${tail(stdout)}`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  let durationSec = Number(parsed.format?.duration);
  if (!Number.isFinite(durationSec)) {
    const streamDurations = streams.map((s) => Number(s.duration)).filter((d) => Number.isFinite(d));
    durationSec = streamDurations.length ? Math.max(...streamDurations) : 0;
  }

  return {
    durationSec,
    width: video?.width,
    height: video?.height,
    hasAudio: audio !== undefined,
    hasVideo: video !== undefined,
  };
}

// -- filter capability detection --------------------------------------------

const filterCache = new Map<string, Promise<boolean>>();

/**
 * Whether the local ffmpeg build ships a filter (e.g. `drawtext` requires
 * libfreetype and is missing from lean builds). Result is cached per process.
 */
export function ffmpegHasFilter(name: string): Promise<boolean> {
  let cached = filterCache.get(name);
  if (!cached) {
    const pattern = new RegExp(`\\s${name}\\s`);
    cached = exec(FFMPEG, ["-hide_banner", "-filters"]).then(({ stdout }) =>
      stdout.split("\n").some((line) => pattern.test(line)),
    );
    filterCache.set(name, cached);
  }
  return cached;
}
