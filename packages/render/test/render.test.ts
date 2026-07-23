import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStore, mt } from "@vdx/timeline";
import type { TextElement } from "@vdx/timeline";
import {
  atempoChain,
  buildDrawtextFilter,
  createRenderer,
  encodePng,
  escapeFilterValue,
  ffColor,
  probe,
  renderTextImage,
  run,
} from "../src";

const RENDER_TIMEOUT = 120_000;

// Real media synthesized by ffmpeg into the project state dir (gitignored).
const testRoot = join(import.meta.dir, "..", "..", "..", ".vdx", "test", `render-${process.pid}`);
const mediaDir = join(testRoot, "media");
const outDir = join(testRoot, "out");
const tmpDir = join(testRoot, "tmp");
const clipPath = join(mediaDir, "clip.mp4");
const tonePath = join(mediaDir, "tone.m4a");

beforeAll(async () => {
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  // 3s 320x240 test pattern with a 440Hz tone track.
  await run([
    "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k",
    "-shortest",
    clipPath,
  ]);
  // 2s 660Hz tone as m4a.
  await run([
    "-y",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:duration=2",
    "-c:a", "aac", "-b:a", "96k",
    tonePath,
  ]);
}, RENDER_TIMEOUT);

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

/**
 * 640x360 project, one scene:
 *  - video: clip trimmed from t=0.5, 2.5s on the main track
 *  - text: "HELLO" overlay from 1s to 2s
 *  - audio: 2s tone starting at 0.5s with 0.25s fades
 * Scene duration = 2.5s.
 */
function buildProject(): ProjectStore {
  const store = ProjectStore.create({
    name: "Render test",
    width: 640,
    height: 360,
    backgroundColor: "#101020",
  });
  const sceneId = store.getProject().currentSceneId;
  store.apply({
    type: "add_media_asset",
    params: {
      asset: {
        id: "clip",
        type: "video",
        name: "Test clip",
        src: clipPath,
        duration: mt.fromSeconds(3),
        width: 320,
        height: 240,
        provenance: { kind: "mock" },
      },
    },
  });
  store.apply({
    type: "add_media_asset",
    params: {
      asset: {
        id: "tone",
        type: "audio",
        name: "Tone",
        src: tonePath,
        duration: mt.fromSeconds(2),
        provenance: { kind: "mock" },
      },
    },
  });
  store.apply({
    type: "insert_element",
    params: {
      sceneId,
      element: {
        type: "video",
        name: "Main clip",
        mediaId: "clip",
        startTime: 0,
        duration: mt.fromSeconds(2.5),
        trimStart: mt.fromSeconds(0.5),
        trimEnd: 0,
        sourceDuration: mt.fromSeconds(3),
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        opacity: 1,
        volume: 1,
      },
      placement: { mode: "auto" },
    },
  });
  store.apply({
    type: "insert_element",
    params: {
      sceneId,
      element: {
        type: "text",
        name: "Title",
        content: "HELLO",
        startTime: mt.fromSeconds(1),
        duration: mt.fromSeconds(1),
        trimStart: 0,
        trimEnd: 0,
        fontSize: 48,
        fontFamily: "Helvetica",
        color: "#FFFFFF",
        backgroundColor: "#000000CC",
        textAlign: "center",
        transform: { x: 0, y: -80, scale: 1, rotation: 0 },
        opacity: 1,
      },
      placement: { mode: "auto" },
    },
  });
  store.apply({
    type: "insert_element",
    params: {
      sceneId,
      element: {
        type: "audio",
        name: "Tone bed",
        mediaId: "tone",
        startTime: mt.fromSeconds(0.5),
        duration: mt.fromSeconds(2),
        trimStart: 0,
        trimEnd: 0,
        volume: 0.8,
        fadeIn: mt.fromSeconds(0.25),
        fadeOut: mt.fromSeconds(0.25),
      },
      placement: { mode: "auto" },
    },
  });
  return store;
}

describe("helpers", () => {
  test("ffColor converts hex forms and passes names through", () => {
    expect(ffColor("#000000")).toBe("0x000000");
    expect(ffColor("#FFF")).toBe("0xFFFFFF");
    expect(ffColor("#12345678")).toBe("0x12345678");
    expect(ffColor("white")).toBe("white");
  });

  test("escapeFilterValue neutralizes filtergraph metacharacters", () => {
    expect(escapeFilterValue("plain")).toBe("'plain'");
    expect(escapeFilterValue("a:b,c")).toBe("'a:b,c'");
    expect(escapeFilterValue("it's")).toBe(`'it'\\''s'`);
    expect(escapeFilterValue("back\\slash")).toBe("'back\\\\slash'");
  });

  test("buildDrawtextFilter escapes text and windows the enable expression", () => {
    const el: TextElement = {
      id: "t1",
      type: "text",
      name: "Title",
      content: "it's 50%: go, [now]",
      startTime: mt.fromSeconds(1),
      duration: mt.fromSeconds(1),
      trimStart: 0,
      trimEnd: 0,
      fontSize: 48,
      fontFamily: "Helvetica",
      color: "#FFFFFF",
      backgroundColor: "#000000CC",
      textAlign: "center",
      transform: { x: 10, y: -20, scale: 1, rotation: 0 },
      opacity: 0.9,
    };
    const filter = buildDrawtextFilter(el, { startSec: 1, endSec: 2 });
    expect(filter).toStartWith("drawtext=text='it'\\''s 50%: go, [now]'");
    expect(filter).toContain("expansion=none");
    expect(filter).toContain("fontsize=48");
    expect(filter).toContain("fontcolor=0xFFFFFF@0.9");
    expect(filter).toContain("box=1:boxcolor=0x000000CC");
    expect(filter).toContain("x=(w-text_w)/2+(10):y=(h-text_h)/2+(-20)");
    expect(filter).toContain("enable='between(t,1.000000,2.000000)'");
  });

  test("atempoChain decomposes rates into the 0.5–2 range", () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(1.5)).toEqual(["atempo=1.5"]);
    expect(atempoChain(0.25)).toEqual(["atempo=0.5", "atempo=0.5"]);
    expect(atempoChain(8)).toEqual(["atempo=2", "atempo=2", "atempo=2"]);
    for (const f of atempoChain(0.3)) {
      const v = Number(f.split("=")[1]);
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThanOrEqual(2);
    }
  });
});

describe("probe", () => {
  test("reports duration, dimensions, and audio presence", async () => {
    const clip = await probe(clipPath);
    expect(clip.width).toBe(320);
    expect(clip.height).toBe(240);
    expect(clip.hasVideo).toBe(true);
    expect(clip.hasAudio).toBe(true);
    expect(Math.abs(clip.durationSec - 3)).toBeLessThanOrEqual(0.25);

    const tone = await probe(tonePath);
    expect(tone.hasVideo).toBe(false);
    expect(tone.hasAudio).toBe(true);
    expect(Math.abs(tone.durationSec - 2)).toBeLessThanOrEqual(0.25);
  }, RENDER_TIMEOUT);
});

describe("text image", () => {
  test("renders text to a PNG that ffprobe can decode", async () => {
    const image = renderTextImage({
      content: "HELLO",
      fontSize: 28,
      color: "#FFFFFF",
      backgroundColor: "#00000080",
      textAlign: "center",
    });
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
    const file = join(outDir, "hello.png");
    writeFileSync(file, encodePng(image.data, image.width, image.height));
    const p = await probe(file);
    expect(p.width).toBe(image.width);
    expect(p.height).toBe(image.height);
  }, RENDER_TIMEOUT);
});

describe("renderer", () => {
  test("renders a single-scene project in draft mode", async () => {
    const store = buildProject();
    const renderer = createRenderer({ tmpDir });
    const out = join(outDir, "draft.mp4");
    const messages: string[] = [];
    const result = await renderer.renderProject(store.getProject(), {
      outPath: out,
      draft: true,
      onProgress: (m) => messages.push(m),
    });

    expect(existsSync(out)).toBe(true);
    expect(result.outPath).toBe(out);
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(messages.length).toBeGreaterThan(0);

    const p = await probe(out);
    expect(Math.abs(p.durationSec - 2.5)).toBeLessThanOrEqual(0.25);
    expect(result.durationSec).toBeCloseTo(p.durationSec, 3);
    expect(p.hasAudio).toBe(true);
    expect(p.width).toBe(640);
    expect(p.height).toBe(360);
  }, RENDER_TIMEOUT);

  test("renderFrame extracts a PNG at 1s", async () => {
    const store = buildProject();
    const renderer = createRenderer({ tmpDir });
    const out = join(outDir, "frame.png");
    const path = await renderer.renderFrame(store.getProject(), {
      outPath: out,
      at: mt.fromSeconds(1),
    });
    expect(path).toBe(out);
    expect(existsSync(out)).toBe(true);
    const p = await probe(out);
    expect(p.width).toBe(640);
    expect(p.height).toBe(360);
  }, RENDER_TIMEOUT);

  test("two scenes concatenate to the summed duration", async () => {
    const store = buildProject();
    const created = store.apply({ type: "create_scene", params: { name: "Scene 2", isMain: false } });
    const scene2 = created.created!.sceneId;
    store.apply({
      type: "insert_element",
      params: {
        sceneId: scene2,
        element: {
          type: "video",
          name: "Clip again",
          mediaId: "clip",
          startTime: 0,
          duration: mt.fromSeconds(1),
          trimStart: 0,
          trimEnd: mt.fromSeconds(2),
          sourceDuration: mt.fromSeconds(3),
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          opacity: 1,
          volume: 1,
        },
        placement: { mode: "auto" },
      },
    });

    const renderer = createRenderer({ tmpDir });
    const out = join(outDir, "two-scenes.mp4");
    const result = await renderer.renderProject(store.getProject(), { outPath: out, draft: true });
    expect(existsSync(out)).toBe(true);
    const p = await probe(out);
    // 2.5s + 1s scenes.
    expect(Math.abs(p.durationSec - 3.5)).toBeLessThanOrEqual(0.3);
    expect(result.durationSec).toBeCloseTo(p.durationSec, 3);
  }, RENDER_TIMEOUT);

  test("renderProject with a sceneId renders just that scene", async () => {
    const store = buildProject();
    const renderer = createRenderer({ tmpDir });
    const out = join(outDir, "single-scene.mp4");
    const sceneId = store.getProject().currentSceneId;
    await renderer.renderProject(store.getProject(), { outPath: out, draft: true, sceneId });
    const p = await probe(out);
    expect(Math.abs(p.durationSec - 2.5)).toBeLessThanOrEqual(0.25);
  }, RENDER_TIMEOUT);

  test("empty project renders nothing and says so", async () => {
    const store = ProjectStore.create({ name: "Empty" });
    const renderer = createRenderer({ tmpDir });
    await expect(
      renderer.renderProject(store.getProject(), { outPath: join(outDir, "never.mp4") }),
    ).rejects.toThrow(/nothing to render/);
  });
});
