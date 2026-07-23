/**
 * FalProvider — image + video generation via the fal.ai queue REST API,
 * plain fetch (no SDK): POST https://queue.fal.run/<modelId>, poll the
 * returned status_url until COMPLETED, then download the result file(s).
 *
 * Requires FAL_KEY. In keyless environments the gateway routes to the
 * MockProvider instead; unit tests inject a fake fetch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { probeMedia } from "./ffmpeg";
import { contentHash } from "./hash";
import type {
  GenerationRequest,
  GenerationResult,
  ImageRequest,
  Provider,
  ProviderContext,
  QualityTier,
  VideoRequest,
} from "./types";

/**
 * Model routing table (verified July 2026). Kept in one place so model bumps
 * are a one-line edit. Video models split by conditioning: imageToVideo when
 * the request carries a keyframeImage, textToVideo otherwise.
 */
export const FAL_MODEL_TABLE = {
  image: {
    draft: "fal-ai/flux/schnell",
    standard: "fal-ai/flux/dev",
    hero: "fal-ai/flux/dev",
  },
  video: {
    draft: {
      textToVideo: "fal-ai/minimax/hailuo-02/standard/text-to-video",
      imageToVideo: "fal-ai/minimax/hailuo-02/standard/image-to-video",
    },
    standard: {
      // Audio is always off at this tier (kling charges 2x for audio).
      textToVideo: "fal-ai/kling-video/v2.6/pro/text-to-video",
      imageToVideo: "fal-ai/kling-video/v2.6/pro/image-to-video",
    },
    hero: {
      textToVideo: "fal-ai/veo3.1",
      imageToVideo: "fal-ai/veo3.1",
    },
  },
} as const;

/** Per-second video rates (USD) by model family; audio variants where priced. */
export const FAL_VIDEO_RATE_PER_SEC = {
  hailuo: 0.045,
  kling26: 0.07,
  kling26Audio: 0.14,
  veo31: 0.2,
  veo31Audio: 0.4,
} as const;

/** Flat per-image estimates (USD) by tier. */
export const FAL_IMAGE_COST_USD: Record<QualityTier, number> = {
  draft: 0.003,
  standard: 0.025,
  hero: 0.05,
};

export const FAL_QUEUE_BASE_URL = "https://queue.fal.run";

export function falModelFor(request: ImageRequest | VideoRequest): string {
  if (request.kind === "image") return FAL_MODEL_TABLE.image[request.tier];
  const variants = FAL_MODEL_TABLE.video[request.tier];
  return request.keyframeImage ? variants.imageToVideo : variants.textToVideo;
}

export function estimateFalCostUsd(request: ImageRequest | VideoRequest): number {
  if (request.kind === "image") return FAL_IMAGE_COST_USD[request.tier];
  switch (request.tier) {
    case "draft":
      return FAL_VIDEO_RATE_PER_SEC.hailuo * request.durationSec;
    case "standard":
      // Audio is forced off for kling, so the audio rate never applies.
      return FAL_VIDEO_RATE_PER_SEC.kling26 * request.durationSec;
    case "hero":
      return (
        (request.wantAudio ? FAL_VIDEO_RATE_PER_SEC.veo31Audio : FAL_VIDEO_RATE_PER_SEC.veo31) *
        request.durationSec
      );
  }
}

function nearestAspectRatio(width: number, height: number): string {
  const ratio = width / height;
  const candidates: Array<[string, number]> = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
  ];
  candidates.sort((a, b) => Math.abs(a[1] - ratio) - Math.abs(b[1] - ratio));
  return candidates[0][0];
}

/** Local image files become data URIs; http(s) URLs pass through. */
function toImageUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith("data:")) return pathOrUrl;
  if (!existsSync(pathOrUrl)) {
    throw new Error(`fal reference image not found on disk: ${pathOrUrl}`);
  }
  const ext = extname(pathOrUrl).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${readFileSync(pathOrUrl).toString("base64")}`;
}

export interface ShapedFalRequest {
  modelId: string;
  url: string;
  body: Record<string, unknown>;
  estimatedCostUsd: number;
}

/** Pure request shaping — unit-testable without network. */
export function buildFalRequest(request: ImageRequest | VideoRequest): ShapedFalRequest {
  const modelId = falModelFor(request);
  const body: Record<string, unknown> = { prompt: request.prompt };
  if (request.seed !== undefined) body.seed = request.seed;

  if (request.kind === "image") {
    body.image_size = { width: request.width, height: request.height };
    body.num_images = 1;
  } else {
    body.duration = request.durationSec;
    body.aspect_ratio = nearestAspectRatio(request.width, request.height);
    if (request.keyframeImage) body.image_url = toImageUrl(request.keyframeImage);
    if (request.tier === "standard") body.generate_audio = false;
    if (request.tier === "hero") body.generate_audio = request.wantAudio;
  }

  return {
    modelId,
    url: `${FAL_QUEUE_BASE_URL}/${modelId}`,
    body,
    estimatedCostUsd: estimateFalCostUsd(request),
  };
}

interface FalQueueSubmit {
  request_id?: string;
  status_url?: string;
  response_url?: string;
}

interface FalQueueStatus {
  status?: string;
  error?: unknown;
}

export interface FalProviderOptions {
  apiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  maxPollMs?: number;
}

export class FalProvider implements Provider {
  readonly name = "fal";
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;

  constructor(options: FalProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.FAL_KEY;
    if (!apiKey) {
      throw new Error(
        "FalProvider requires a fal.ai API key: set FAL_KEY in the environment " +
          "(or pass { apiKey }). Without it the gateway uses the mock provider.",
      );
    }
    this.apiKey = apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.maxPollMs = options.maxPollMs ?? 10 * 60 * 1000;
  }

  supports(request: GenerationRequest): boolean {
    return request.kind === "image" || request.kind === "video";
  }

  async generate(request: GenerationRequest, ctx: ProviderContext): Promise<GenerationResult> {
    if (request.kind !== "image" && request.kind !== "video") {
      throw new Error(`FalProvider does not support kind "${request.kind}" (image/video only)`);
    }
    mkdirSync(ctx.mediaDir, { recursive: true });
    const shaped = buildFalRequest(request);
    ctx.log(`fal submit ${shaped.modelId} (~$${shaped.estimatedCostUsd.toFixed(3)})`);

    const submit = await this.postJson<FalQueueSubmit>(shaped.url, shaped.body);
    if (!submit.status_url || !submit.response_url) {
      throw new Error(`fal queue submit for ${shaped.modelId} returned no status_url/response_url`);
    }

    await this.pollUntilComplete(submit.status_url, shaped.modelId, ctx);
    const payload = await this.getJson<Record<string, unknown>>(submit.response_url);
    const fileUrl = extractFileUrl(payload);
    if (!fileUrl) {
      throw new Error(
        `fal result for ${shaped.modelId} contained no downloadable file url ` +
          `(keys: ${Object.keys(payload).join(", ")})`,
      );
    }

    const ext = extname(new URL(fileUrl).pathname) || (request.kind === "image" ? ".png" : ".mp4");
    const outPath = join(ctx.mediaDir, `fal-${request.kind}-${contentHash(shaped.modelId, request).slice(0, 16)}${ext}`);
    await this.download(fileUrl, outPath);
    ctx.log(`fal downloaded ${fileUrl} → ${outPath}`);

    let durationSec = request.kind === "video" ? request.durationSec : undefined;
    let width = request.width;
    let height = request.height;
    try {
      const probe = await probeMedia(outPath);
      durationSec = probe.durationSec ?? durationSec;
      width = probe.width ?? width;
      height = probe.height ?? height;
    } catch {
      // Keep requested dimensions when the file cannot be probed.
    }

    return {
      path: outPath,
      durationSec,
      width,
      height,
      model: shaped.modelId,
      costUsd: shaped.estimatedCostUsd,
      cached: false,
      seed: request.seed,
    };
  }

  // -- queue plumbing --------------------------------------------------------

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Key ${this.apiKey}` };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  private async postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`fal POST ${url} failed: ${response.status} ${await safeText(response)}`);
    }
    return (await response.json()) as T;
  }

  private async getJson<T>(url: string): Promise<T> {
    const response = await this.fetchFn(url, { headers: this.headers(false) });
    if (!response.ok) {
      throw new Error(`fal GET ${url} failed: ${response.status} ${await safeText(response)}`);
    }
    return (await response.json()) as T;
  }

  private async pollUntilComplete(statusUrl: string, modelId: string, ctx: ProviderContext): Promise<void> {
    const deadline = Date.now() + this.maxPollMs;
    for (;;) {
      const status = await this.getJson<FalQueueStatus>(statusUrl);
      if (status.status === "COMPLETED") return;
      if (status.status === "FAILED" || status.status === "ERROR" || status.status === "CANCELLED") {
        throw new Error(`fal generation failed for ${modelId}: ${JSON.stringify(status.error ?? status)}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`fal generation timed out for ${modelId} after ${this.maxPollMs}ms (last: ${status.status})`);
      }
      ctx.log(`fal ${modelId}: ${status.status ?? "waiting"}...`);
      if (this.pollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }

  private async download(url: string, outPath: string): Promise<void> {
    const response = await this.fetchFn(url, { headers: this.headers(false) });
    if (!response.ok) {
      throw new Error(`fal download ${url} failed: ${response.status} ${await safeText(response)}`);
    }
    writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));
  }
}

/** Find the produced file url across fal's result shapes. */
function extractFileUrl(payload: Record<string, unknown>): string | undefined {
  const video = payload.video as { url?: string } | undefined;
  if (video?.url) return video.url;
  const images = payload.images as Array<{ url?: string }> | undefined;
  if (images?.[0]?.url) return images[0].url;
  const image = payload.image as { url?: string } | undefined;
  if (image?.url) return image.url;
  return undefined;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "<unreadable body>";
  }
}
