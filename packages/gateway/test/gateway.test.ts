import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildElevenLabsRequest,
  buildFalRequest,
  canonicalJson,
  contentHash,
  createGateway,
  ELEVENLABS_NARRATOR_VOICE_ID,
  ElevenLabsProvider,
  estimateFalCostUsd,
  FAL_MODEL_TABLE,
  FalProvider,
  probeMedia,
  type GenerationRequest,
  type ImageRequest,
  type SpeechRequest,
  type VideoRequest,
} from "../src";

const TEST_ROOT = join(import.meta.dir, "..", "..", "..", ".vdx", "test", `gateway-${randomUUID().slice(0, 8)}`);
const mediaDir = join(TEST_ROOT, "media");
const cacheDir = join(TEST_ROOT, "cache");
mkdirSync(mediaDir, { recursive: true });

// env: {} forces mock routing even if the machine has real keys.
const gateway = createGateway({ mediaDir, cacheDir, env: {} });

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("hash", () => {
  test("canonical JSON sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [1, 2] } })).toBe('{"a":{"c":[1,2],"d":2},"b":1}');
  });

  test("content hash is stable across key order and ignores tier", () => {
    const a: ImageRequest = { kind: "image", prompt: "sunset", width: 320, height: 180, tier: "draft" };
    const b = { tier: "draft", height: 180, width: 320, prompt: "sunset", kind: "image" } as ImageRequest;
    expect(contentHash("mock/image", a)).toBe(contentHash("mock/image", b));
    // tier is captured by the model id, not the request payload.
    expect(contentHash("mock/image", { ...a, tier: "hero" })).toBe(contentHash("mock/image", a));
    expect(contentHash("mock/image", { ...a, prompt: "sunrise" })).not.toBe(contentHash("mock/image", a));
    expect(contentHash("other/model", a)).not.toBe(contentHash("mock/image", a));
  });
});

describe("mock generation via gateway", () => {
  test("gateway is not live without keys", () => {
    expect(gateway.isLive()).toBe(false);
  });

  test(
    "image: produces a real nonzero PNG",
    async () => {
      const request: ImageRequest = {
        kind: "image",
        prompt: "A neon city skyline at dusk, 50% chance of rain: 'moody'",
        width: 320,
        height: 180,
        tier: "draft",
      };
      const result = await gateway.generate(request);
      expect(existsSync(result.path)).toBe(true);
      expect(statSync(result.path).size).toBeGreaterThan(0);
      expect(result.model).toBe("mock/image");
      expect(result.costUsd).toBe(0);
      expect(result.cached).toBe(false);
      const probe = await probeMedia(result.path);
      expect(probe.width).toBe(320);
      expect(probe.height).toBe(180);
    },
    30000,
  );

  test(
    "video: 2s duration within 0.2s, audio stream when requested",
    async () => {
      const request: VideoRequest = {
        kind: "video",
        prompt: "drone shot over ocean",
        durationSec: 2,
        width: 320,
        height: 180,
        wantAudio: true,
        tier: "draft",
      };
      const result = await gateway.generate(request);
      expect(existsSync(result.path)).toBe(true);
      const probe = await probeMedia(result.path);
      expect(Math.abs((probe.durationSec ?? 0) - 2)).toBeLessThanOrEqual(0.2);
      expect(probe.hasAudio).toBe(true);
      expect(result.durationSec).toBeGreaterThan(0);
    },
    30000,
  );

  test(
    "video: no audio stream when wantAudio is false",
    async () => {
      const request: VideoRequest = {
        kind: "video",
        prompt: "slow pan across desert",
        durationSec: 2,
        width: 320,
        height: 180,
        wantAudio: false,
        tier: "draft",
      };
      const result = await gateway.generate(request);
      const probe = await probeMedia(result.path);
      expect(probe.hasAudio).toBe(false);
    },
    30000,
  );

  test(
    "speech: produces a file with duration > 0",
    async () => {
      const request: SpeechRequest = {
        kind: "speech",
        text: "Welcome to the show. Tonight we explore the deep sea.",
        voice: "narrator",
        tier: "draft",
      };
      const result = await gateway.generate(request);
      expect(existsSync(result.path)).toBe(true);
      expect(result.durationSec ?? 0).toBeGreaterThan(0);
      expect(result.model).toBe("mock/speech");
    },
    30000,
  );

  test(
    "music: requested duration, faded",
    async () => {
      const request: GenerationRequest = { kind: "music", prompt: "calm ambient pads", durationSec: 2, tier: "draft" };
      const result = await gateway.generate(request);
      expect(existsSync(result.path)).toBe(true);
      expect(Math.abs((result.durationSec ?? 0) - 2)).toBeLessThanOrEqual(0.3);
    },
    30000,
  );

  test(
    "cache: identical request returns cached: true with the identical path",
    async () => {
      const request: ImageRequest = {
        kind: "image",
        prompt: "cache me if you can",
        width: 320,
        height: 180,
        tier: "draft",
      };
      const first = await gateway.generate(request);
      expect(first.cached).toBe(false);
      const second = await gateway.generate({ ...request });
      expect(second.cached).toBe(true);
      expect(second.path).toBe(first.path);
      expect(second.costUsd).toBe(0);
      expect(existsSync(second.path)).toBe(true);
    },
    30000,
  );

  test("mock generation accrues no cost", () => {
    expect(gateway.totalCostUsd()).toBe(0);
  });
});

describe("fal request shaping (no network)", () => {
  test("constructor throws without a key", () => {
    const saved = process.env.FAL_KEY;
    delete process.env.FAL_KEY;
    try {
      expect(() => new FalProvider()).toThrow(/FAL_KEY/);
    } finally {
      if (saved !== undefined) process.env.FAL_KEY = saved;
    }
  });

  test("cost estimates follow the per-second rate map", () => {
    const base: VideoRequest = {
      kind: "video",
      prompt: "p",
      durationSec: 2,
      width: 1920,
      height: 1080,
      wantAudio: false,
      tier: "draft",
    };
    expect(estimateFalCostUsd(base)).toBeCloseTo(0.09); // hailuo 0.045/s
    expect(estimateFalCostUsd({ ...base, tier: "standard" })).toBeCloseTo(0.14); // kling26 0.07/s
    expect(estimateFalCostUsd({ ...base, tier: "hero" })).toBeCloseTo(0.4); // veo31 0.20/s
    expect(estimateFalCostUsd({ ...base, tier: "hero", wantAudio: true })).toBeCloseTo(0.8); // veo31 audio 0.40/s
    expect(
      estimateFalCostUsd({ kind: "image", prompt: "p", width: 1024, height: 1024, tier: "draft" }),
    ).toBeCloseTo(0.003);
  });

  test("draft text-to-video routes to hailuo; hero enables audio per wantAudio", () => {
    const draft = buildFalRequest({
      kind: "video",
      prompt: "p",
      durationSec: 6,
      width: 1920,
      height: 1080,
      wantAudio: false,
      tier: "draft",
    });
    expect(draft.modelId).toBe(FAL_MODEL_TABLE.video.draft.textToVideo);
    const hero = buildFalRequest({
      kind: "video",
      prompt: "p",
      durationSec: 4,
      width: 1080,
      height: 1920,
      wantAudio: true,
      tier: "hero",
    });
    expect(hero.modelId).toBe("fal-ai/veo3.1");
    expect(hero.body.generate_audio).toBe(true);
    expect(hero.body.aspect_ratio).toBe("9:16");
  });

  test(
    "generate: queue submit URL, auth header, kling audio off, cost math",
    async () => {
      const keyframePath = join(mediaDir, "keyframe.png");
      writeFileSync(keyframePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (calls.length === 1) {
          return Response.json({
            request_id: "req-1",
            status_url: "https://queue.fal.run/fal-ai/kling-video/requests/req-1/status",
            response_url: "https://queue.fal.run/fal-ai/kling-video/requests/req-1",
          });
        }
        if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
        if (url.endsWith("/req-1")) {
          return Response.json({ video: { url: "https://fal.media/files/out.mp4" } });
        }
        return new Response(Buffer.from("not-a-real-mp4"));
      }) as unknown as typeof fetch;

      const provider = new FalProvider({ apiKey: "test-key", fetchFn, pollIntervalMs: 0 });
      const request: VideoRequest = {
        kind: "video",
        prompt: "hero walks into frame",
        durationSec: 2,
        width: 1920,
        height: 1080,
        keyframeImage: keyframePath,
        wantAudio: true, // kling tier still forces audio off
        tier: "standard",
      };
      const result = await provider.generate(request, { mediaDir, log: () => {} });

      expect(calls[0].url).toBe("https://queue.fal.run/fal-ai/kling-video/v2.6/pro/image-to-video");
      expect(calls[0].init?.method).toBe("POST");
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Key test-key");
      const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
      expect(body.prompt).toBe("hero walks into frame");
      expect(body.generate_audio).toBe(false);
      expect(String(body.image_url)).toStartWith("data:image/png;base64,");

      expect(calls.map((c) => c.url)).toContain("https://fal.media/files/out.mp4");
      expect(result.costUsd).toBeCloseTo(0.14); // kling26: 0.07/s * 2s
      expect(result.model).toBe("fal-ai/kling-video/v2.6/pro/image-to-video");
      expect(existsSync(result.path)).toBe(true);
      expect(result.durationSec).toBe(2); // probe fails on fake bytes → requested duration
    },
    30000,
  );
});

describe("elevenlabs request shaping (no network)", () => {
  test("constructor throws without a key", () => {
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      expect(() => new ElevenLabsProvider()).toThrow(/ELEVENLABS_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
    }
  });

  test("narrator maps to the default voice id and cost is ~$0.10/1k chars", () => {
    const text = "a".repeat(500);
    const shaped = buildElevenLabsRequest({ kind: "speech", text, voice: "narrator", tier: "standard" });
    expect(shaped.url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_NARRATOR_VOICE_ID}`);
    expect(shaped.estimatedCostUsd).toBeCloseTo(0.05);
  });

  test(
    "generate: posts xi-api-key and saves the mp3 body",
    async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(Buffer.from("fake-mp3-bytes"));
      }) as unknown as typeof fetch;

      const provider = new ElevenLabsProvider({ apiKey: "el-test-key", fetchFn });
      const result = await provider.generate(
        { kind: "speech", text: "Hello there.", voice: "narrator", tier: "standard" },
        { mediaDir, log: () => {} },
      );

      expect(calls[0].url).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_NARRATOR_VOICE_ID}`);
      const headers = calls[0].init?.headers as Record<string, string>;
      expect(headers["xi-api-key"]).toBe("el-test-key");
      expect(existsSync(result.path)).toBe(true);
      expect(result.path).toEndWith(".mp3");
      expect(result.model).toBe(`elevenlabs/${ELEVENLABS_NARRATOR_VOICE_ID}`);
    },
    30000,
  );
});
