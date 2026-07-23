/**
 * CanvasBoard — infinite pan/zoom board over the project's canvas items.
 *
 * World model: screen = world * scale + offset (see lib.ts canvas math).
 * Pan by dragging empty space or plain wheel; zoom with ctrl/cmd+wheel or
 * pinch (0.25–2.5x, toward the cursor). Items live in world coordinates on a
 * single transformed div (translate+scale, will-change) so panning/zooming
 * never re-lays-out the cards. Dragging a card is optimistic; the PATCH lands
 * on drop and the override reverts if it fails. Double-click empty space
 * opens an inline note input. An SVG layer under the cards draws the
 * shot-chain (plan order) between shot cards.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CANVAS_ITEM_SIZE,
  clamp,
  panBy,
  resolveMediaUrl,
  screenToWorld,
  shotChainSegments,
  zoomAt,
} from "../lib";
import type { CanvasView, ShotItemLike } from "../lib";
import type {
  CanvasAssetPayload,
  CanvasEntityPayload,
  CanvasItemView,
  CanvasNotePayload,
  CanvasShotPayload,
} from "../types";
import { EntityBadge, KindIcon } from "./badges";

interface CanvasBoardProps {
  items: CanvasItemView[];
  /** Plan shot ids in order — drives the shot-chain connection lines. */
  shotOrder: string[];
  hasProject: boolean;
  onMove: (itemId: string, pos: { x: number; y: number }) => Promise<void>;
  onCreateNote: (text: string, x: number, y: number) => Promise<void>;
  onSelectShot: (shotId: string) => void;
}

interface DragState {
  itemId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

const CARD_BASE =
  "absolute select-none rounded-lg border bg-card text-card-foreground shadow-md transition-shadow hover:shadow-lg";

function itemSize(item: CanvasItemView): { w: number; h: number } {
  const fallback = CANVAS_ITEM_SIZE[item.refType];
  return { w: item.w ?? fallback.w, h: item.h ?? fallback.h };
}

function CardBody({ item, onSelectShot }: { item: CanvasItemView; onSelectShot: (shotId: string) => void }) {
  switch (item.refType) {
    case "asset": {
      const p = item.payload as CanvasAssetPayload;
      return (
        <div className="flex h-full flex-col overflow-hidden">
          {p.kind === "image" ? (
            <img
              src={resolveMediaUrl(p.url)}
              alt={p.name}
              draggable={false}
              className="min-h-0 w-full flex-1 rounded-t-[inherit] object-cover"
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <KindIcon kind={p.kind} className="size-7 fill-current opacity-70" />
            </div>
          )}
          <div className="flex items-center gap-1 border-t border-border/60 px-1.5 py-1">
            <KindIcon kind={p.kind} className="size-3 shrink-0 fill-current text-muted-foreground" />
            <span className="truncate text-[10px]" title={p.name}>
              {p.name}
            </span>
          </div>
        </div>
      );
    }
    case "entity": {
      const p = item.payload as CanvasEntityPayload;
      return (
        <div className="flex h-full flex-col gap-1.5 overflow-hidden p-2">
          <div className="flex items-center gap-1.5">
            <EntityBadge type={p.type} />
            <span className="truncate text-xs font-medium" title={p.name}>
              {p.name}
            </span>
          </div>
          {p.referenceImageUrls.length > 0 ? (
            <div className="flex min-h-0 flex-1 gap-1">
              {p.referenceImageUrls.slice(0, 3).map((url) => (
                <img
                  key={url}
                  src={resolveMediaUrl(url)}
                  alt=""
                  draggable={false}
                  className="min-w-0 flex-1 rounded object-cover"
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[10px] text-muted-foreground">
              no references yet
            </div>
          )}
        </div>
      );
    }
    case "shot": {
      const p = item.payload as CanvasShotPayload;
      return (
        <button
          type="button"
          className="flex h-full w-full cursor-pointer flex-col overflow-hidden text-left"
          title={`Open ${p.label} in the storyboard`}
          onClick={() => onSelectShot(p.shotId)}
        >
          {p.keyframeUrl ? (
            <img
              src={resolveMediaUrl(p.keyframeUrl)}
              alt={p.label}
              draggable={false}
              className="min-h-0 w-full flex-1 rounded-t-[inherit] object-cover"
            />
          ) : (
            <div className="flex min-h-0 w-full flex-1 items-center justify-center text-muted-foreground">
              <svg viewBox="0 0 24 24" className="size-7 fill-current opacity-50" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          )}
          {/* keyframe → clip lineage inside the card */}
          <div className="flex w-full items-center gap-1 border-t border-border/60 px-1.5 py-1">
            <span className="truncate text-[10px] font-medium" title={p.label}>
              {p.label}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1 text-[9px] text-muted-foreground">
              <span className={p.keyframeUrl ? "text-teal-300" : "opacity-40"}>key</span>
              <svg viewBox="0 0 12 12" className="size-2.5 fill-none stroke-current opacity-50" aria-hidden>
                <path strokeWidth="1.5" strokeLinecap="round" d="M2 6h7M7 3.5 9.5 6 7 8.5" />
              </svg>
              <span
                className={
                  p.clipUrl
                    ? "rounded-sm bg-indigo-500/25 px-1 text-indigo-300"
                    : "px-1 opacity-40"
                }
              >
                clip
              </span>
            </span>
          </div>
        </button>
      );
    }
    case "note": {
      const p = item.payload as CanvasNotePayload;
      return (
        <div className="h-full overflow-hidden p-2">
          <p className="whitespace-pre-wrap text-[11px] leading-snug text-amber-100/90">{p.text}</p>
        </div>
      );
    }
  }
}

function cardChrome(item: CanvasItemView): string {
  switch (item.refType) {
    case "entity":
      return "border-violet-400/60 ring-1 ring-violet-400/20";
    case "shot":
      return "border-border";
    case "note":
      return "border-amber-500/40 bg-amber-500/10 shadow-amber-950/30";
    default:
      return "border-border";
  }
}

export function CanvasBoard(props: CanvasBoardProps) {
  const { items, shotOrder, hasProject, onMove, onCreateNote, onSelectShot } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<CanvasView>({ offsetX: 60, offsetY: 40, scale: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

  /** Optimistic positions while dragging / until a refetch confirms them. */
  const [overrides, setOverrides] = useState<Record<string, { x: number; y: number }>>({});
  const dragRef = useRef<DragState | null>(null);
  const panRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);

  const [noteDraft, setNoteDraft] = useState<{ x: number; y: number; text: string } | null>(null);
  const noteDraftRef = useRef<{ x: number; y: number; text: string } | null>(null);
  noteDraftRef.current = noteDraft;

  const positioned = useMemo(
    () =>
      items.map((item) => {
        const o = overrides[item.id];
        return o ? { ...item, x: o.x, y: o.y } : item;
      }),
    [items, overrides],
  );

  const segments = useMemo(() => {
    const shotItems: ShotItemLike[] = positioned
      .filter((item) => item.refType === "shot")
      .map((item) => ({
        id: item.id,
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
        shotId: (item.payload as CanvasShotPayload).shotId,
      }));
    return shotChainSegments(shotItems, shotOrder);
  }, [positioned, shotOrder]);

  // Non-passive wheel handler so ctrl+wheel doesn't zoom the whole page.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.008);
        setView((v) => zoomAt(v, sx, sy, factor));
      } else {
        setView((v) => panBy(v, -e.deltaX, -e.deltaY));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // --- background pan ------------------------------------------------------

  const onBackgroundPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    panRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onBackgroundPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    const dx = e.clientX - pan.lastX;
    const dy = e.clientY - pan.lastY;
    pan.lastX = e.clientX;
    pan.lastY = e.clientY;
    setView((v) => panBy(v, dx, dy));
  }, []);

  const onBackgroundPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId === e.pointerId) panRef.current = null;
  }, []);

  const onBackgroundDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!hasProject) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const world = screenToWorld(viewRef.current, e.clientX - rect.left, e.clientY - rect.top);
      setNoteDraft({ x: world.x, y: world.y, text: "" });
    },
    [hasProject],
  );

  // --- item drag -----------------------------------------------------------

  const onItemPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, item: CanvasItemView) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      dragRef.current = {
        itemId: item.id,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        originX: item.x,
        originY: item.y,
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onItemPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const scale = viewRef.current.scale;
    const dx = (e.clientX - drag.startClientX) / scale;
    const dy = (e.clientY - drag.startClientY) / scale;
    if (!drag.moved && Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY) < 4) {
      return; // still a click
    }
    drag.moved = true;
    setOverrides((prev) => ({
      ...prev,
      [drag.itemId]: { x: drag.originX + dx, y: drag.originY + dy },
    }));
  }, []);

  const onItemPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      if (!drag.moved) return;
      // Suppress the click that follows a drag (so shot cards don't open).
      e.preventDefault();
      const scale = viewRef.current.scale;
      const x = drag.originX + (e.clientX - drag.startClientX) / scale;
      const y = drag.originY + (e.clientY - drag.startClientY) / scale;
      onMove(drag.itemId, { x, y }).catch(() => {
        // revert the optimistic move
        setOverrides((prev) => {
          const next = { ...prev };
          delete next[drag.itemId];
          return next;
        });
      });
    },
    [onMove],
  );

  const suppressClickRef = useRef(false);
  const onItemClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  // --- note draft ----------------------------------------------------------

  // Guarded via the ref so the unmount-time blur after Enter/Escape can't
  // commit a second time.
  const commitNote = useCallback(() => {
    const draft = noteDraftRef.current;
    if (!draft) return;
    noteDraftRef.current = null;
    setNoteDraft(null);
    const text = draft.text.trim();
    if (!text) return;
    void onCreateNote(text, draft.x, draft.y);
  }, [onCreateNote]);

  const cancelNote = useCallback(() => {
    noteDraftRef.current = null;
    setNoteDraft(null);
  }, []);

  const gridSize = 24 * view.scale;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full touch-none overflow-hidden bg-background"
      style={{
        backgroundImage: "radial-gradient(circle, oklch(1 0 0 / 8%) 1px, transparent 1px)",
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${view.offsetX}px ${view.offsetY}px`,
      }}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={onBackgroundPointerUp}
      onPointerCancel={onBackgroundPointerUp}
      onDoubleClick={onBackgroundDoubleClick}
    >
      {/* world layer */}
      <div
        className="absolute left-0 top-0"
        style={{
          transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})`,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        {/* shot-chain lines under the cards */}
        {segments.length > 0 ? (
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1">
            {segments.map((s, i) => (
              <line
                key={i}
                x1={s.x1}
                y1={s.y1}
                x2={s.x2}
                y2={s.y2}
                className="stroke-muted-foreground/25"
                strokeWidth={1.5}
                strokeDasharray="5 4"
              />
            ))}
          </svg>
        ) : null}

        {positioned.map((item) => {
          const { w, h } = itemSize(item);
          const dragged = dragRef.current?.itemId === item.id && dragRef.current.moved;
          return (
            <div
              key={item.id}
              className={`${CARD_BASE} ${cardChrome(item)} ${dragged ? "cursor-grabbing" : "cursor-grab"}`}
              style={{ left: item.x, top: item.y, width: w, height: h, zIndex: item.z }}
              onPointerDown={(e) => onItemPointerDown(e, item)}
              onPointerMove={onItemPointerMove}
              onPointerUp={(e) => {
                if (dragRef.current?.moved) suppressClickRef.current = true;
                onItemPointerUp(e);
              }}
              onPointerCancel={onItemPointerUp}
              onClickCapture={onItemClickCapture}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <CardBody item={item} onSelectShot={onSelectShot} />
            </div>
          );
        })}

        {noteDraft ? (
          <div
            className="absolute z-50 rounded-md border border-amber-500/60 bg-amber-500/15 p-1.5 shadow-lg"
            style={{ left: noteDraft.x, top: noteDraft.y, width: CANVAS_ITEM_SIZE.note.w }}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              className="w-full bg-transparent text-[11px] text-amber-100 outline-none placeholder:text-amber-200/40"
              placeholder="Note… (Enter to add)"
              value={noteDraft.text}
              onChange={(e) => setNoteDraft((d) => (d ? { ...d, text: e.target.value } : d))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitNote();
                else if (e.key === "Escape") cancelNote();
              }}
              onBlur={commitNote}
            />
          </div>
        ) : null}
      </div>

      {/* HUD */}
      <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-2 rounded-md border border-border bg-card/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
        <span className="tabular-nums">{Math.round(clamp(view.scale, 0.01, 99) * 100)}%</span>
        <span className="hidden sm:inline">drag: pan · ⌘/ctrl+scroll: zoom · double-click: note</span>
      </div>

      {items.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="max-w-64 text-center text-sm text-muted-foreground">
            {hasProject
              ? "The canvas fills up as uploads and shots land. Double-click to leave a note."
              : "Canvas appears once a project exists."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
