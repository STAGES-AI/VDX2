/**
 * MockProvider — generates REAL media files with ffmpeg (and macOS `say` for
 * speech) so the renderer always has genuine inputs, even with no API keys.
 * Output is deterministic per request: colors/hues derive from the prompt
 * hash and filenames derive from the content hash.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { probeMedia, run, runFfmpeg } from "./ffmpeg";
import { contentHash, sha256Hex } from "./hash";
import type {
  GenerationRequest,
  GenerationResult,
  ImageRequest,
  MusicRequest,
  Provider,
  ProviderContext,
  SpeechRequest,
  VideoRequest,
} from "./types";

const MOCK_FONT_CANDIDATES = [
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
];

function fontFile(): string | undefined {
  return MOCK_FONT_CANDIDATES.find((f) => existsSync(f));
}

/**
 * Escape ffmpeg drawtext special characters (: % ' \ ,) after stripping
 * characters that are meaningful at the filtergraph level ([ ] ; =) and
 * newlines — those have no safe single-level escape.
 */
export function drawtextEscape(text: string): string {
  return text
    .replace(/[\r\n[\];=]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,");
}

/** Short label drawn onto mock media so shots are visually identifiable. */
function promptLabel(prompt: string): string {
  const excerpt = prompt.trim().slice(0, 40) || "mock";
  return drawtextEscape(excerpt);
}

/** Deterministic hue (0-359) from the prompt, for tinting mock media. */
export function promptHue(prompt: string): number {
  return Number.parseInt(sha256Hex(prompt).slice(0, 8), 16) % 360;
}

/** Deterministic solid color for the prompt as 0xRRGGBB (ffmpeg syntax). */
export function promptColor(prompt: string): string {
  const [r, g, b] = hslToRgb(promptHue(prompt), 0.6, 0.42);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `0x${hex(r)}${hex(g)}${hex(b)}`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h / 60) % 6;
  const rgb: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [r, g, b] = rgb[sector];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function drawtextFilter(label: string, fontsizeExpr: string): string {
  const font = fontFile();
  const parts = [
    `text=${label}`,
    "fontcolor=white",
    `fontsize=${fontsizeExpr}`,
    "x=(w-text_w)/2",
    "y=(h-text_h)/2",
    "box=1",
    "boxcolor=black@0.35",
    "boxborderw=8",
  ];
  if (font) parts.push(`fontfile=${font}`);
  return `drawtext=${parts.join(":")}`;
}

export class MockProvider implements Provider {
  readonly name = "mock";

  supports(_request: GenerationRequest): boolean {
    return true;
  }

  async generate(request: GenerationRequest, ctx: ProviderContext): Promise<GenerationResult> {
    mkdirSync(ctx.mediaDir, { recursive: true });
    const model = `mock/${request.kind}`;
    const key = contentHash(model, request).slice(0, 16);
    switch (request.kind) {
      case "image":
        return this.generateImage(request, ctx, model, key);
      case "video":
        return this.generateVideo(request, ctx, model, key);
      case "speech":
        return this.generateSpeech(request, ctx, model, key);
      case "music":
        return this.generateMusic(request, ctx, model, key);
    }
  }

  private async generateImage(
    request: ImageRequest,
    ctx: ProviderContext,
    model: string,
    key: string,
  ): Promise<GenerationResult> {
    const outPath = join(ctx.mediaDir, `mock-image-${key}.png`);
    const source = `color=c=${promptColor(request.prompt)}:s=${request.width}x${request.height}`;
    const label = drawtextFilter(promptLabel(request.prompt), "h/12");
    ctx.log(`mock image ${request.width}x${request.height} → ${outPath}`);
    try {
      await runFfmpeg(["-f", "lavfi", "-i", source, "-frames:v", "1", "-vf", label, outPath]);
    } catch {
      // drawtext can fail when no usable font is found — plain color card still works.
      await runFfmpeg(["-f", "lavfi", "-i", source, "-frames:v", "1", outPath]);
    }
    return {
      path: outPath,
      width: request.width,
      height: request.height,
      model,
      costUsd: 0,
      cached: false,
      seed: request.seed,
    };
  }

  private async generateVideo(
    request: VideoRequest,
    ctx: ProviderContext,
    model: string,
    key: string,
  ): Promise<GenerationResult> {
    const outPath = join(ctx.mediaDir, `mock-video-${key}.mp4`);
    const d = request.durationSec;
    const source = `testsrc2=size=${request.width}x${request.height}:rate=30:duration=${d}`;
    const tint = `hue=h=${promptHue(request.prompt)}:s=1.2`;
    const label = drawtextFilter(promptLabel(request.prompt), "h/14");
    ctx.log(`mock video ${request.width}x${request.height} ${d}s audio=${request.wantAudio} → ${outPath}`);

    const build = (withText: boolean): string[] => {
      const args = ["-f", "lavfi", "-i", source];
      if (request.wantAudio) {
        args.push("-f", "lavfi", "-i", `sine=frequency=294:sample_rate=44100:duration=${d}`);
      }
      const vf = withText ? `${tint},${label},format=yuv420p` : `${tint},format=yuv420p`;
      args.push("-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-movflags", "+faststart");
      if (request.wantAudio) {
        args.push("-af", "volume=0.08", "-c:a", "aac", "-shortest");
      } else {
        args.push("-an");
      }
      args.push(outPath);
      return args;
    };

    try {
      await runFfmpeg(build(true));
    } catch {
      await runFfmpeg(build(false));
    }
    const probe = await probeMedia(outPath);
    return {
      path: outPath,
      durationSec: probe.durationSec ?? d,
      width: request.width,
      height: request.height,
      model,
      costUsd: 0,
      cached: false,
      seed: request.seed,
    };
  }

  private async generateSpeech(
    request: SpeechRequest,
    ctx: ProviderContext,
    model: string,
    key: string,
  ): Promise<GenerationResult> {
    const outPath = join(ctx.mediaDir, `mock-speech-${key}.m4a`);
    const aiffPath = join(ctx.mediaDir, `mock-speech-${key}.aiff`);
    const spoke = await this.trySay(request.text, aiffPath, ctx);
    if (spoke) {
      await runFfmpeg(["-i", aiffPath, "-c:a", "aac", outPath]);
      rmSync(aiffPath, { force: true });
    } else {
      // Beep pattern with spoken cadence, sized to ~word count (~160 wpm).
      const words = request.text.trim().split(/\s+/).filter(Boolean).length || 1;
      const d = Math.max(1, words * 0.38);
      ctx.log(`mock speech fallback beep pattern (${words} words, ~${d.toFixed(1)}s) → ${outPath}`);
      await runFfmpeg([
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=320:sample_rate=22050:duration=${d.toFixed(2)}`,
        "-af",
        "tremolo=f=4.5:d=0.9,volume=0.4",
        "-c:a",
        "aac",
        outPath,
      ]);
    }
    const probe = await probeMedia(outPath);
    return {
      path: outPath,
      durationSec: probe.durationSec,
      model,
      costUsd: 0,
      cached: false,
    };
  }

  /** Try macOS `say` (text via stdin, so arbitrary text is safe). */
  private async trySay(text: string, aiffPath: string, ctx: ProviderContext): Promise<boolean> {
    const attempts = [
      ["say", "-o", aiffPath, "--data-format=LEF32@22050"],
      ["say", "-o", aiffPath],
    ];
    for (const cmd of attempts) {
      try {
        const result = await run(cmd, { stdin: text });
        if (result.code === 0 && existsSync(aiffPath)) {
          ctx.log(`mock speech via 'say' → ${aiffPath}`);
          return true;
        }
      } catch {
        // 'say' missing entirely (non-macOS) — fall through to beep pattern.
      }
    }
    return false;
  }

  private async generateMusic(
    request: MusicRequest,
    ctx: ProviderContext,
    model: string,
    key: string,
  ): Promise<GenerationResult> {
    const outPath = join(ctx.mediaDir, `mock-music-${key}.m4a`);
    const d = request.durationSec;
    // A minor-ish chord (A3, C4, E4) + pink noise bed, lowpassed and faded.
    const fadeOutStart = Math.max(0, d - 0.6);
    const filter =
      `[0:a][1:a][2:a][3:a]amix=inputs=4:normalize=0,lowpass=f=1000,` +
      `afade=t=in:st=0:d=0.5,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=0.6,volume=0.5[a]`;
    ctx.log(`mock music ${d}s → ${outPath}`);
    await runFfmpeg([
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=220:sample_rate=44100:duration=${d}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=261.63:sample_rate=44100:duration=${d}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=329.63:sample_rate=44100:duration=${d}`,
      "-f",
      "lavfi",
      "-i",
      `anoisesrc=colour=pink:amplitude=0.04:sample_rate=44100:duration=${d}`,
      "-filter_complex",
      filter,
      "-map",
      "[a]",
      "-c:a",
      "aac",
      outPath,
    ]);
    const probe = await probeMedia(outPath);
    return {
      path: outPath,
      durationSec: probe.durationSec ?? d,
      model,
      costUsd: 0,
      cached: false,
    };
  }
}
