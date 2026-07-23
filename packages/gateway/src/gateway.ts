/**
 * createGateway — routes generation requests to providers, wraps the
 * content-addressed cache, and accumulates session spend.
 *
 * Routing (per request kind + available env keys):
 *   speech       → ElevenLabs when ELEVENLABS_API_KEY is set, else mock
 *   image/video  → fal.ai when FAL_KEY is set, else mock
 *   music        → mock always (no music API wired yet)
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { GenerationCache } from "./cache";
import { ElevenLabsProvider, elevenLabsVoiceId } from "./elevenlabs";
import { FalProvider, falModelFor } from "./fal";
import { contentHash } from "./hash";
import { MockProvider } from "./mock";
import type { Gateway, GenerationRequest, GenerationResult, Provider, ProviderContext } from "./types";

export { probeMedia } from "./ffmpeg";
export type { MediaProbe } from "./ffmpeg";

export interface GatewayOptions {
  /** Where providers write produced media. Default: <cwd>/.vdx/media */
  mediaDir?: string;
  /** Content-addressed cache location. Default: <cwd>/.vdx/cache */
  cacheDir?: string;
  log?: (message: string) => void;
  /** Injectable for tests; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export function createGateway(opts: GatewayOptions = {}): Gateway {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const mediaDir = resolve(opts.mediaDir ?? join(process.cwd(), ".vdx", "media"));
  const cacheDir = resolve(opts.cacheDir ?? join(process.cwd(), ".vdx", "cache"));
  mkdirSync(mediaDir, { recursive: true });
  const cache = new GenerationCache(cacheDir);

  const falKey = env.FAL_KEY;
  const elevenKey = env.ELEVENLABS_API_KEY;
  const mock = new MockProvider();
  const fal = falKey ? new FalProvider({ apiKey: falKey }) : undefined;
  const eleven = elevenKey ? new ElevenLabsProvider({ apiKey: elevenKey }) : undefined;

  function route(request: GenerationRequest): { provider: Provider; model: string } {
    switch (request.kind) {
      case "image":
      case "video":
        return fal
          ? { provider: fal, model: falModelFor(request) }
          : { provider: mock, model: `mock/${request.kind}` };
      case "speech":
        return eleven
          ? { provider: eleven, model: `elevenlabs/${elevenLabsVoiceId(request.voice)}` }
          : { provider: mock, model: "mock/speech" };
      case "music":
        // No music API wired yet — mock always, even when live keys exist.
        return { provider: mock, model: "mock/music" };
    }
  }

  let totalCostUsd = 0;
  const ctx: ProviderContext = { mediaDir, log };

  return {
    async generate(request: GenerationRequest): Promise<GenerationResult> {
      const { provider, model } = route(request);
      const key = contentHash(model, request);

      const hit = cache.lookup(key);
      if (hit) {
        log(`cache hit ${request.kind} ${key.slice(0, 12)} → ${hit.path}`);
        return hit;
      }

      log(`generate ${request.kind} via ${provider.name} (${model})`);
      const result = await provider.generate(request, ctx);
      totalCostUsd += result.costUsd;
      return cache.store(key, result);
    },

    totalCostUsd(): number {
      return totalCostUsd;
    },

    isLive(): boolean {
      return Boolean(falKey || elevenKey);
    },
  };
}
