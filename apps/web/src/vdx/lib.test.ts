import { describe, expect, test } from "bun:test";
import {
  CANVAS_ITEM_SIZE,
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  TICKS_PER_SECOND,
  buildSettingsPatch,
  buildTimelineRows,
  clamp,
  fmtBytes,
  fmtClock,
  groupTakesByShot,
  panBy,
  pickSelectedTake,
  projectDurationTicks,
  resolveMediaUrl,
  rulerMarks,
  rulerStep,
  screenToWorld,
  shotChainSegments,
  ticksToSeconds,
  worldToScreen,
  zoomAt,
} from "./lib";
import type { CanvasView, SettingsFormEdits, ShotItemLike, TakeLike } from "./lib";
import type {
  AudioTrack,
  SettingsResponse,
  TProject,
  TScene,
  TextElement,
  TextTrack,
  VideoElement,
  VideoTrack,
} from "./types";

// --- fixtures --------------------------------------------------------------

const sec = (s: number) => Math.round(s * TICKS_PER_SECOND);

function videoEl(id: string, startSec: number, durSec: number): VideoElement {
  return {
    id,
    type: "video",
    name: `clip ${id}`,
    mediaId: `media-${id}`,
    startTime: sec(startSec),
    duration: sec(durSec),
    trimStart: 0,
    trimEnd: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    opacity: 1,
    volume: 1,
  };
}

function textEl(id: string, startSec: number, durSec: number): TextElement {
  return {
    id,
    type: "text",
    name: `title ${id}`,
    content: "hello",
    fontSize: 48,
    fontFamily: "Inter",
    color: "#fff",
    textAlign: "center",
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    opacity: 1,
    startTime: sec(startSec),
    duration: sec(durSec),
    trimStart: 0,
    trimEnd: 0,
  };
}

function scene(id: string, opts: { main: VideoTrack; overlay?: TextTrack[]; audio?: AudioTrack[] }): TScene {
  return {
    id,
    name: `Scene ${id}`,
    isMain: true,
    tracks: { overlay: opts.overlay ?? [], main: opts.main, audio: opts.audio ?? [] },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function project(scenes: TScene[]): TProject {
  return {
    metadata: { id: "p1", name: "Test", createdAt: "", updatedAt: "" },
    settings: {
      fps: { numerator: 30, denominator: 1 },
      canvasSize: { width: 1920, height: 1080 },
      background: { type: "color", color: "#000" },
    },
    scenes,
    currentSceneId: scenes[0]?.id ?? "",
    mediaAssets: [],
    version: 1,
  };
}

const mainTrack = (id: string, els: VideoElement[]): VideoTrack => ({
  id,
  type: "video",
  name: "Main",
  elements: els,
  muted: false,
  hidden: false,
});

// --- tests -----------------------------------------------------------------

describe("time helpers", () => {
  test("ticksToSeconds", () => {
    expect(ticksToSeconds(TICKS_PER_SECOND)).toBe(1);
    expect(ticksToSeconds(sec(3.5))).toBeCloseTo(3.5);
  });

  test("fmtClock", () => {
    expect(fmtClock(0)).toBe("0:00.0");
    expect(fmtClock(4.5)).toBe("0:04.5");
    expect(fmtClock(72)).toBe("1:12.0");
  });
});

describe("resolveMediaUrl", () => {
  test("absolute urls pass through", () => {
    expect(resolveMediaUrl("http://localhost:8790/media/a.mp4")).toBe(
      "http://localhost:8790/media/a.mp4",
    );
    expect(resolveMediaUrl("https://cdn.example.com/x.mp4")).toBe("https://cdn.example.com/x.mp4");
  });

  test("host-relative /media paths get the server base", () => {
    expect(resolveMediaUrl("/media/renders/a.mp4")).toBe(
      "http://localhost:8790/media/renders/a.mp4",
    );
  });

  test("bare relative paths get base + slash", () => {
    expect(resolveMediaUrl("media/a.mp4")).toBe("http://localhost:8790/media/a.mp4");
  });
});

describe("ruler", () => {
  test("step scales with duration", () => {
    expect(rulerStep(5)).toBe(0.5);
    expect(rulerStep(12)).toBe(1);
    expect(rulerStep(20)).toBe(2);
    expect(rulerStep(60)).toBe(5);
    expect(rulerStep(600)).toBe(60);
  });

  test("marks cover 0..duration inclusive", () => {
    expect(rulerMarks(10)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rulerMarks(0)).toEqual([0]);
  });
});

describe("buildTimelineRows", () => {
  test("single scene: overlay, MAIN, audio order and pct layout", () => {
    const overlay: TextTrack = {
      id: "t-text",
      type: "text",
      name: "Titles",
      elements: [textEl("x", 1, 2)],
      hidden: false,
    };
    const audio: AudioTrack = {
      id: "t-audio",
      type: "audio",
      name: "Music",
      elements: [
        {
          id: "a1",
          type: "audio",
          name: "score",
          mediaId: "m-a1",
          startTime: 0,
          duration: sec(10),
          trimStart: 0,
          trimEnd: 0,
          volume: 1,
        },
      ],
      muted: false,
    };
    const p = project([
      scene("s1", {
        main: mainTrack("t-main", [videoEl("v1", 0, 5), videoEl("v2", 5, 5)]),
        overlay: [overlay],
        audio: [audio],
      }),
    ]);

    const { rows, durationSec } = buildTimelineRows(p);
    expect(durationSec).toBe(10);
    expect(rows.map((r) => r.kind)).toEqual(["overlay", "main", "audio"]);
    expect(rows.map((r) => r.label)).toEqual(["Titles", "MAIN", "Music"]);

    const mainRow = rows[1]!;
    expect(mainRow.elements).toHaveLength(2);
    expect(mainRow.elements[0]!.leftPct).toBeCloseTo(0);
    expect(mainRow.elements[0]!.widthPct).toBeCloseTo(50);
    expect(mainRow.elements[1]!.leftPct).toBeCloseTo(50);
    expect(mainRow.elements[1]!.endSec).toBeCloseTo(10);

    const titleBlock = rows[0]!.elements[0]!;
    expect(titleBlock.type).toBe("text");
    expect(titleBlock.leftPct).toBeCloseTo(10);
    expect(titleBlock.widthPct).toBeCloseTo(20);
  });

  test("scenes play back to back with offsets and prefixed labels", () => {
    const p = project([
      scene("s1", { main: mainTrack("m1", [videoEl("v1", 0, 4)]) }),
      scene("s2", { main: mainTrack("m2", [videoEl("v2", 0, 6)]) }),
    ]);
    const { rows, durationSec } = buildTimelineRows(p);
    expect(durationSec).toBe(10);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label).toBe("Scene s1 · MAIN");
    expect(rows[1]!.label).toBe("Scene s2 · MAIN");
    // second scene's clip starts at 4s = 40%
    expect(rows[1]!.elements[0]!.startSec).toBeCloseTo(4);
    expect(rows[1]!.elements[0]!.leftPct).toBeCloseTo(40);
    expect(rows[1]!.elements[0]!.widthPct).toBeCloseTo(60);
  });

  test("empty project renders without dividing by zero", () => {
    const p = project([scene("s1", { main: mainTrack("m1", []) })]);
    const { rows, durationSec } = buildTimelineRows(p);
    expect(durationSec).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.elements).toEqual([]);
  });

  test("projectDurationTicks sums scenes", () => {
    const p = project([
      scene("s1", { main: mainTrack("m1", [videoEl("v1", 0, 4)]) }),
      scene("s2", { main: mainTrack("m2", [videoEl("v2", 1, 2)]) }),
    ]);
    expect(projectDurationTicks(p)).toBe(sec(7));
  });
});

describe("fmtBytes", () => {
  test("bytes and units", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(532)).toBe("532 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(48.9 * 1024 * 1024)).toBe("48.9 MB");
    expect(fmtBytes(250 * 1024 * 1024)).toBe("250 MB");
    expect(fmtBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  test("garbage is safe", () => {
    expect(fmtBytes(-5)).toBe("0 B");
    expect(fmtBytes(Number.NaN)).toBe("0 B");
  });
});

describe("canvas view math", () => {
  const view: CanvasView = { offsetX: 40, offsetY: -20, scale: 2 };

  test("clamp", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  test("screenToWorld/worldToScreen round-trip", () => {
    const w = screenToWorld(view, 140, 80);
    expect(w).toEqual({ x: 50, y: 50 });
    const s = worldToScreen(view, w.x, w.y);
    expect(s).toEqual({ x: 140, y: 80 });
  });

  test("panBy shifts the offset only", () => {
    expect(panBy(view, 10, -5)).toEqual({ offsetX: 50, offsetY: -25, scale: 2 });
  });

  test("zoomAt keeps the cursor's world point fixed", () => {
    const zoomed = zoomAt(view, 140, 80, 1.25);
    expect(zoomed.scale).toBeCloseTo(2.5);
    const w = screenToWorld(zoomed, 140, 80);
    expect(w.x).toBeCloseTo(50);
    expect(w.y).toBeCloseTo(50);
  });

  test("zoomAt clamps to the scale range", () => {
    const maxed = zoomAt(view, 0, 0, 100);
    expect(maxed.scale).toBe(CANVAS_MAX_SCALE);
    const tiny = zoomAt({ offsetX: 0, offsetY: 0, scale: 0.3 }, 10, 10, 0.01);
    expect(tiny.scale).toBe(CANVAS_MIN_SCALE);
    // already at the max: no-op returns the same view
    const pinned = { offsetX: 1, offsetY: 2, scale: CANVAS_MAX_SCALE };
    expect(zoomAt(pinned, 5, 5, 2)).toBe(pinned);
  });
});

describe("takes", () => {
  const take = (id: string, shotId: string, createdAt: string, selected = false): TakeLike => ({
    id,
    shotId,
    selected,
    createdAt,
  });

  test("groupTakesByShot groups and sorts oldest-first", () => {
    const groups = groupTakesByShot([
      take("t3", "shot-2", "2026-01-03T00:00:00Z"),
      take("t1", "shot-1", "2026-01-01T00:00:00Z"),
      take("t2", "shot-1", "2026-01-02T00:00:00Z"),
    ]);
    expect(Object.keys(groups).sort()).toEqual(["shot-1", "shot-2"]);
    expect(groups["shot-1"]!.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(groups["shot-2"]!.map((t) => t.id)).toEqual(["t3"]);
  });

  test("pickSelectedTake prefers the selected flag", () => {
    const takes = [
      take("t1", "s", "2026-01-01T00:00:00Z", true),
      take("t2", "s", "2026-01-02T00:00:00Z"),
    ];
    expect(pickSelectedTake(takes)!.id).toBe("t1");
  });

  test("pickSelectedTake falls back to the newest", () => {
    const takes = [
      take("t1", "s", "2026-01-01T00:00:00Z"),
      take("t2", "s", "2026-01-02T00:00:00Z"),
    ];
    expect(pickSelectedTake(takes)!.id).toBe("t2");
    expect(pickSelectedTake([])).toBe(null);
  });
});

describe("shotChainSegments", () => {
  const item = (id: string, shotId: string, x: number, y: number, w?: number, h?: number): ShotItemLike =>
    ({ id, shotId, x, y, w, h });

  test("connects consecutive shots in plan order via centers", () => {
    const items = [
      item("c2", "shot-2", 100, 0, 100, 100),
      item("c1", "shot-1", 0, 0, 100, 100),
    ];
    const segments = shotChainSegments(items, ["shot-1", "shot-2"]);
    expect(segments).toEqual([{ x1: 50, y1: 50, x2: 150, y2: 50 }]);
  });

  test("skips shots without a card", () => {
    const items = [
      item("c1", "shot-1", 0, 0, 100, 100),
      item("c3", "shot-3", 200, 0, 100, 100),
    ];
    const segments = shotChainSegments(items, ["shot-1", "shot-2", "shot-3"]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ x1: 50, y1: 50, x2: 250, y2: 50 });
  });

  test("defaults card size when w/h missing", () => {
    const { w, h } = CANVAS_ITEM_SIZE.shot;
    const segments = shotChainSegments(
      [item("c1", "shot-1", 0, 0), item("c2", "shot-2", 400, 0)],
      ["shot-1", "shot-2"],
    );
    expect(segments[0]).toEqual({ x1: w / 2, y1: h / 2, x2: 400 + w / 2, y2: h / 2 });
  });

  test("falls back to natural shotId order without a plan", () => {
    const items = [
      item("c10", "shot-10", 900, 0, 10, 10),
      item("c2", "shot-2", 100, 0, 10, 10),
      item("c1", "shot-1", 0, 0, 10, 10),
    ];
    const segments = shotChainSegments(items, []);
    // numeric-aware: shot-1 → shot-2 → shot-10
    expect(segments.map((s) => s.x1)).toEqual([5, 105]);
    expect(segments.map((s) => s.x2)).toEqual([105, 905]);
  });

  test("fewer than two cards yields no segments", () => {
    expect(shotChainSegments([], ["shot-1"])).toEqual([]);
    expect(shotChainSegments([item("c1", "shot-1", 0, 0)], ["shot-1"])).toEqual([]);
  });
});

describe("buildSettingsPatch", () => {
  const loaded: SettingsResponse = {
    anthropicKeySet: true,
    anthropicKeyPreview: "sk-ant-...abcd",
    falKeySet: false,
    falKeyPreview: null,
    elevenLabsKeySet: true,
    elevenLabsKeyPreview: "el-...9f2a",
    plannerModel: "claude-sonnet-5",
    plannerEffort: "medium",
    editorModel: "claude-haiku-4-5",
    editorEffort: "low",
  };

  const noEdits: SettingsFormEdits = {
    anthropicApiKey: "",
    anthropicCleared: false,
    falApiKey: "",
    falCleared: false,
    elevenLabsApiKey: "",
    elevenLabsCleared: false,
    plannerModel: loaded.plannerModel,
    plannerEffort: loaded.plannerEffort,
    editorModel: loaded.editorModel,
    editorEffort: loaded.editorEffort,
  };

  test("no changes yields an empty patch", () => {
    expect(buildSettingsPatch(loaded, noEdits)).toEqual({});
  });

  test("typing a new key includes only that field, trimmed", () => {
    const patch = buildSettingsPatch(loaded, { ...noEdits, anthropicApiKey: "  sk-ant-new123  " });
    expect(patch).toEqual({ anthropicApiKey: "sk-ant-new123" });
  });

  test("an untouched-but-blank key field is omitted, not sent as an empty string", () => {
    const patch = buildSettingsPatch(loaded, noEdits);
    expect(patch.anthropicApiKey).toBeUndefined();
    expect(patch.falApiKey).toBeUndefined();
    expect(patch.elevenLabsApiKey).toBeUndefined();
  });

  test("an explicit clear sends an empty string even though the field is blank", () => {
    const patch = buildSettingsPatch(loaded, { ...noEdits, anthropicCleared: true });
    expect(patch).toEqual({ anthropicApiKey: "" });
  });

  test("typing after a clear wins over the clear flag", () => {
    const patch = buildSettingsPatch(loaded, {
      ...noEdits,
      anthropicApiKey: "sk-ant-fresh",
      anthropicCleared: true,
    });
    expect(patch).toEqual({ anthropicApiKey: "sk-ant-fresh" });
  });

  test("changed selects are included, unchanged ones are not", () => {
    const patch = buildSettingsPatch(loaded, {
      ...noEdits,
      plannerModel: "claude-opus-4-8",
      editorEffort: "xhigh",
    });
    expect(patch).toEqual({ plannerModel: "claude-opus-4-8", editorEffort: "xhigh" });
  });

  test("multiple key and select changes combine into one patch", () => {
    const patch = buildSettingsPatch(loaded, {
      ...noEdits,
      falApiKey: "fal-key-1",
      elevenLabsCleared: true,
      plannerEffort: "max",
    });
    expect(patch).toEqual({ falApiKey: "fal-key-1", elevenLabsApiKey: "", plannerEffort: "max" });
  });
});
