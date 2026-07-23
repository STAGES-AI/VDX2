/**
 * ElevenLabsProvider — speech synthesis via the ElevenLabs REST API.
 * POST https://api.elevenlabs.io/v1/text-to-speech/<voiceId> with xi-api-key,
 * saves the returned mp3. Requires ELEVENLABS_API_KEY; keyless environments
 * route speech to the MockProvider instead.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { probeMedia } from "./ffmpeg";
import { contentHash } from "./hash";
import type { GenerationRequest, GenerationResult, Provider, ProviderContext, SpeechRequest } from "./types";

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/** Default narrator voice ("Rachel", ElevenLabs premade). */
export const ELEVENLABS_NARRATOR_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** Logical voice name → ElevenLabs voice id. Unknown names pass through raw. */
export const ELEVENLABS_VOICE_MAP: Record<string, string> = {
  narrator: ELEVENLABS_NARRATOR_VOICE_ID,
};

export const ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";

/** ~$0.10 per 1k characters. */
export const ELEVENLABS_COST_PER_1K_CHARS_USD = 0.1;

export function elevenLabsVoiceId(voice: string): string {
  return ELEVENLABS_VOICE_MAP[voice] ?? voice;
}

export function estimateElevenLabsCostUsd(text: string): number {
  return (text.length / 1000) * ELEVENLABS_COST_PER_1K_CHARS_USD;
}

export interface ShapedElevenLabsRequest {
  url: string;
  body: Record<string, unknown>;
  estimatedCostUsd: number;
  voiceId: string;
}

/** Pure request shaping — unit-testable without network. */
export function buildElevenLabsRequest(request: SpeechRequest): ShapedElevenLabsRequest {
  const voiceId = elevenLabsVoiceId(request.voice);
  return {
    url: `${ELEVENLABS_BASE_URL}/${voiceId}`,
    body: { text: request.text, model_id: ELEVENLABS_MODEL_ID },
    estimatedCostUsd: estimateElevenLabsCostUsd(request.text),
    voiceId,
  };
}

export interface ElevenLabsProviderOptions {
  apiKey?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export class ElevenLabsProvider implements Provider {
  readonly name = "elevenlabs";
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ElevenLabsProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ElevenLabsProvider requires an API key: set ELEVENLABS_API_KEY in the environment " +
          "(or pass { apiKey }). Without it the gateway uses the mock provider.",
      );
    }
    this.apiKey = apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  supports(request: GenerationRequest): boolean {
    return request.kind === "speech";
  }

  async generate(request: GenerationRequest, ctx: ProviderContext): Promise<GenerationResult> {
    if (request.kind !== "speech") {
      throw new Error(`ElevenLabsProvider does not support kind "${request.kind}" (speech only)`);
    }
    mkdirSync(ctx.mediaDir, { recursive: true });
    const shaped = buildElevenLabsRequest(request);
    const model = `elevenlabs/${shaped.voiceId}`;
    ctx.log(`elevenlabs tts voice=${shaped.voiceId} chars=${request.text.length}`);

    const response = await this.fetchFn(shaped.url, {
      method: "POST",
      headers: { "xi-api-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(shaped.body),
    });
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 300);
      } catch {
        detail = "<unreadable body>";
      }
      throw new Error(`elevenlabs POST ${shaped.url} failed: ${response.status} ${detail}`);
    }

    const outPath = join(ctx.mediaDir, `elevenlabs-${contentHash(model, request).slice(0, 16)}.mp3`);
    writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));

    let durationSec: number | undefined;
    try {
      durationSec = (await probeMedia(outPath)).durationSec;
    } catch {
      // Leave duration unknown when ffprobe cannot parse the file.
    }

    return {
      path: outPath,
      durationSec,
      model,
      costUsd: shaped.estimatedCostUsd,
      cached: false,
    };
  }
}
