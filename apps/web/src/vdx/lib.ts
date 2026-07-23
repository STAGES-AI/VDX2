/**
 * Pure helpers for the VDX UI: tick math, media URL resolution, and the
 * timeline row layout. No DOM, no fetch — everything here is unit-testable.
 */

import type {
  ElementType,
  MediaTime,
  TProject,
  TScene,
  TimelineElement,
  TimelineTrack,
} from "./types";

export const TICKS_PER_SECOND = 120_000;

/** Agent server base URL (CORS-enabled). */
export const API_BASE = "http://localhost:8790";

export function ticksToSeconds(t: MediaTime): number {
  return t / TICKS_PER_SECOND;
}

/** "M:SS.d" — compact clock for tooltips and the ruler (e.g. "0:04.5"). */
export function fmtClock(seconds: number): string {
  const sign = seconds < 0 ? "-" : "";
  const abs = Math.abs(seconds);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${sign}${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/**
 * The server hands out render/media urls either absolute
 * ("http://localhost:8790/media/x.mp4") or host-relative ("/media/x.mp4").
 * Normalize both to absolute against the agent server.
 */
export function resolveMediaUrl(url: string, base: string = API_BASE): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${base}${url}`;
  return `${base}/${url}`;
}

/** Accept attribute for the upload picker / drop targets. */
export const UPLOAD_ACCEPT = "image/*,video/*,audio/*,.md,.txt,.pdf,.docx,.rtf";

/** "532 B", "1.2 KB", "48.9 MB" — compact human file size. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Canvas view math — screen px = world * scale + offset
// ---------------------------------------------------------------------------

export interface CanvasView {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export const CANVAS_MIN_SCALE = 0.25;
export const CANVAS_MAX_SCALE = 2.5;

/** Default card footprint per canvas refType (world units == css px at 1x). */
export const CANVAS_ITEM_SIZE: Record<"asset" | "entity" | "shot" | "note", { w: number; h: number }> = {
  asset: { w: 160, h: 120 },
  entity: { w: 190, h: 130 },
  shot: { w: 210, h: 160 },
  note: { w: 170, h: 110 },
};

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function screenToWorld(view: CanvasView, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - view.offsetX) / view.scale, y: (sy - view.offsetY) / view.scale };
}

export function worldToScreen(view: CanvasView, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * view.scale + view.offsetX, y: wy * view.scale + view.offsetY };
}

export function panBy(view: CanvasView, dx: number, dy: number): CanvasView {
  return { ...view, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}

/**
 * Zoom by `factor` keeping the world point under screen (sx, sy) fixed.
 * Scale is clamped to [CANVAS_MIN_SCALE, CANVAS_MAX_SCALE]; a clamped-out
 * zoom returns the view unchanged.
 */
export function zoomAt(view: CanvasView, sx: number, sy: number, factor: number): CanvasView {
  const scale = clamp(view.scale * factor, CANVAS_MIN_SCALE, CANVAS_MAX_SCALE);
  if (scale === view.scale) return view;
  const { x: wx, y: wy } = screenToWorld(view, sx, sy);
  return { scale, offsetX: sx - wx * scale, offsetY: sy - wy * scale };
}

// ---------------------------------------------------------------------------
// Takes — grouping and selection
// ---------------------------------------------------------------------------

export interface TakeLike {
  id: string;
  shotId: string;
  selected: boolean;
  createdAt: string;
}

/** Group takes by shotId; each group sorted oldest → newest (take #1 first). */
export function groupTakesByShot<T extends TakeLike>(takes: T[]): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const take of takes) (groups[take.shotId] ??= []).push(take);
  for (const shotId of Object.keys(groups)) {
    groups[shotId]!.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
  return groups;
}

/** The selected take of a group, else the newest, else null. */
export function pickSelectedTake<T extends TakeLike>(takes: T[]): T | null {
  if (takes.length === 0) return null;
  const selected = takes.find((t) => t.selected);
  if (selected) return selected;
  return [...takes].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  )[0]!;
}

// ---------------------------------------------------------------------------
// Canvas shot chain — connect shot cards in plan order
// ---------------------------------------------------------------------------

export interface ShotItemLike {
  id: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  shotId: string;
}

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function itemCenter(item: ShotItemLike): { x: number; y: number } {
  const w = item.w ?? CANVAS_ITEM_SIZE.shot.w;
  const h = item.h ?? CANVAS_ITEM_SIZE.shot.h;
  return { x: item.x + w / 2, y: item.y + h / 2 };
}

/**
 * Line segments joining each shot card to the next, ordered by `shotOrder`
 * (the plan's shot id sequence). Shots missing a card are skipped; when no
 * order is supplied, cards fall back to natural shotId ordering.
 */
export function shotChainSegments(items: ShotItemLike[], shotOrder: string[]): Segment[] {
  const byShot = new Map(items.map((item) => [item.shotId, item] as const));
  const ordered =
    shotOrder.length > 0
      ? shotOrder.flatMap((shotId) => {
          const item = byShot.get(shotId);
          return item ? [item] : [];
        })
      : [...items].sort((a, b) => a.shotId.localeCompare(b.shotId, undefined, { numeric: true }));

  const segments: Segment[] = [];
  for (let i = 0; i + 1 < ordered.length; i++) {
    const from = itemCenter(ordered[i]!);
    const to = itemCenter(ordered[i + 1]!);
    segments.push({ x1: from.x, y1: from.y, x2: to.x, y2: to.y });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Durations (mirrors packages/timeline helpers; ticks in, ticks out)
// ---------------------------------------------------------------------------

function elementEnd(el: TimelineElement): MediaTime {
  return el.startTime + el.duration;
}

export function sceneDurationTicks(scene: TScene): MediaTime {
  let end = 0;
  const tracks: TimelineTrack[] = [
    scene.tracks.main,
    ...scene.tracks.overlay,
    ...scene.tracks.audio,
  ];
  for (const track of tracks) {
    for (const el of track.elements) end = Math.max(end, elementEnd(el as TimelineElement));
  }
  return end;
}

export function projectDurationTicks(project: TProject): MediaTime {
  return project.scenes.reduce((sum, s) => sum + sceneDurationTicks(s), 0);
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

const RULER_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** Pick a tick step (seconds) that yields at most ~12 labels. */
export function rulerStep(durationSec: number): number {
  for (const step of RULER_STEPS) {
    if (durationSec / step <= 12) return step;
  }
  return RULER_STEPS[RULER_STEPS.length - 1]!;
}

/** Mark positions in seconds: 0, step, 2*step, ... <= durationSec. */
export function rulerMarks(durationSec: number): number[] {
  if (durationSec <= 0) return [0];
  const step = rulerStep(durationSec);
  const marks: number[] = [];
  for (let s = 0; s <= durationSec + 1e-9; s += step) marks.push(Number(s.toFixed(3)));
  return marks;
}

// ---------------------------------------------------------------------------
// Timeline layout — project → read-only rows of positioned blocks
// ---------------------------------------------------------------------------

export type RowKind = "overlay" | "main" | "audio";

export interface LaidOutElement {
  id: string;
  name: string;
  type: ElementType;
  startSec: number;
  endSec: number;
  /** Percent offsets against the full project duration. */
  leftPct: number;
  widthPct: number;
}

export interface TimelineRow {
  key: string;
  label: string;
  kind: RowKind;
  elements: LaidOutElement[];
}

export interface TimelineLayout {
  rows: TimelineRow[];
  durationSec: number;
}

/**
 * Full class strings so Tailwind's scanner picks them up. Exact Black Mamba
 * hues (docs/black-mamba-workspace-design.md §3 agent-role colors) — no
 * borders, per the design key's "no strokes anywhere" rule.
 */
export const ELEMENT_COLORS: Record<ElementType, string> = {
  video: "bg-[#6e8be8]/85 text-white",
  image: "bg-[#5bbf97]/85 text-[#0a1410]",
  text: "bg-[#c9892f]/85 text-[#1a1305]",
  audio: "bg-[#c084fc]/85 text-[#1a0f22]",
};

/**
 * Flatten a project into ruler-aligned rows. Scenes play back to back, so
 * each scene's elements are offset by the total duration of the scenes
 * before it. One row per track: overlay rows first (top-first), then MAIN,
 * then audio rows. When a project has several scenes the scene name is
 * prefixed onto the track label.
 */
export function buildTimelineRows(project: TProject): TimelineLayout {
  const totalTicks = projectDurationTicks(project);
  const durationSec = ticksToSeconds(totalTicks);
  // Guard the divisor so an empty project still renders empty rows.
  const divisor = Math.max(totalTicks, 1);
  const multiScene = project.scenes.length > 1;

  const rows: TimelineRow[] = [];
  let offsetTicks = 0;

  for (const scene of project.scenes) {
    const prefix = multiScene ? `${scene.name} · ` : "";

    const pushRow = (track: TimelineTrack, kind: RowKind, label: string) => {
      const elements = (track.elements as TimelineElement[]).map((el) => {
        const start = offsetTicks + el.startTime;
        return {
          id: el.id,
          name: el.name,
          type: el.type,
          startSec: ticksToSeconds(start),
          endSec: ticksToSeconds(start + el.duration),
          leftPct: (start / divisor) * 100,
          widthPct: (el.duration / divisor) * 100,
        } satisfies LaidOutElement;
      });
      rows.push({ key: `${scene.id}:${track.id}`, label, kind, elements });
    };

    for (const track of scene.tracks.overlay) pushRow(track, "overlay", `${prefix}${track.name}`);
    pushRow(scene.tracks.main, "main", `${prefix}MAIN`);
    for (const track of scene.tracks.audio) pushRow(track, "audio", `${prefix}${track.name}`);

    offsetTicks += sceneDurationTicks(scene);
  }

  return { rows, durationSec };
}
