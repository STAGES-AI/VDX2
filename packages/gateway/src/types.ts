/**
 * Generation gateway contract — the seam between the agent runtime and
 * generation providers (fal.ai, ElevenLabs, mock). Implementations MUST NOT
 * change these shapes; the agent and server bind to them.
 *
 * All results are files on local disk (downloaded when remote) so the
 * renderer and timeline always work from local paths.
 */

export type QualityTier = "draft" | "standard" | "hero";

export interface ImageRequest {
  kind: "image";
  prompt: string;
  width: number;
  height: number;
  /** Local paths or URLs of reference images (entity conditioning). */
  referenceImages?: string[];
  seed?: number;
  tier: QualityTier;
}

export interface VideoRequest {
  kind: "video";
  prompt: string;
  durationSec: number;
  width: number;
  height: number;
  /** First-frame conditioning (image-first pipeline): local path or URL. */
  keyframeImage?: string;
  referenceImages?: string[];
  /** Ask the model for native audio when supported; silent otherwise. */
  wantAudio: boolean;
  seed?: number;
  tier: QualityTier;
}

export interface SpeechRequest {
  kind: "speech";
  text: string;
  /** Provider-specific voice id; "narrator" default. */
  voice: string;
  tier: QualityTier;
}

export interface MusicRequest {
  kind: "music";
  prompt: string;
  durationSec: number;
  tier: QualityTier;
}

export type GenerationRequest = ImageRequest | VideoRequest | SpeechRequest | MusicRequest;

export interface GenerationResult {
  /** Absolute local path of the produced media file. */
  path: string;
  /** Media metadata when known. */
  durationSec?: number;
  width?: number;
  height?: number;
  /** Model actually used (mock models are prefixed "mock/"). */
  model: string;
  /** Estimated cost in USD (0 for mock/cache hits). */
  costUsd: number;
  /** True when served from the content-addressed cache. */
  cached: boolean;
  seed?: number;
}

export interface Provider {
  readonly name: string;
  supports(request: GenerationRequest): boolean;
  generate(request: GenerationRequest, ctx: ProviderContext): Promise<GenerationResult>;
}

export interface ProviderContext {
  /** Directory to write produced media into. */
  mediaDir: string;
  log: (message: string) => void;
}

export interface Gateway {
  /**
   * Route, cache, and execute a generation request.
   * Deterministic cache key = hash(model + normalized request).
   */
  generate(request: GenerationRequest): Promise<GenerationResult>;
  /** Total estimated spend this session, USD. */
  totalCostUsd(): number;
  /** True when running against real providers (keys present). */
  isLive(): boolean;
}
