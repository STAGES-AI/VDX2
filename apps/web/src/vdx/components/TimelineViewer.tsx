import { useMemo } from "react";
import { ELEMENT_COLORS, buildTimelineRows, fmtClock, rulerMarks } from "../lib";
import type { RowKind } from "../lib";
import type { TProject } from "../types";

const LABEL_COL = "w-32 shrink-0 border-r border-border px-2";

const ROW_TINT: Record<RowKind, string> = {
  overlay: "bg-background",
  main: "bg-muted/40",
  audio: "bg-background",
};

/** Read-only timeline: seconds ruler on top, one row per track below. */
export function TimelineViewer({ project }: { project: TProject | null }) {
  const layout = useMemo(() => (project ? buildTimelineRows(project) : null), [project]);

  if (!project || !layout) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Timeline appears once a project exists
      </div>
    );
  }

  const { rows, durationSec } = layout;
  const marks = rulerMarks(durationSec);
  const safeDuration = Math.max(durationSec, 0.001);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Ruler */}
      <div className="flex h-6 shrink-0 border-b border-border text-[10px] text-muted-foreground">
        <div className={`${LABEL_COL} flex items-center font-medium uppercase tracking-wide`}>
          {fmtClock(durationSec)} total
        </div>
        <div className="relative flex-1">
          {marks.map((sec) => (
            <div
              key={sec}
              className="absolute top-0 h-full border-l border-border/70 pl-1 leading-6"
              style={{ left: `${(sec / safeDuration) * 100}%` }}
            >
              {fmtClock(sec)}
            </div>
          ))}
        </div>
      </div>

      {/* Track rows */}
      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground">No tracks yet</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.key}
              className={`flex h-9 border-b border-border/60 ${ROW_TINT[row.kind]}`}
            >
              <div
                className={`${LABEL_COL} flex items-center truncate text-[10px] font-medium uppercase tracking-wide ${
                  row.kind === "main" ? "text-foreground/80" : "text-muted-foreground"
                }`}
                title={row.label}
              >
                {row.label}
              </div>
              <div className="relative flex-1">
                {row.elements.map((el) => (
                  <div
                    key={el.id}
                    className={`absolute inset-y-1 min-w-0.5 overflow-hidden rounded-sm border px-1 text-[10px] leading-6 ${ELEMENT_COLORS[el.type]}`}
                    style={{ left: `${el.leftPct}%`, width: `${el.widthPct}%` }}
                    title={`${el.name}\n${fmtClock(el.startSec)} → ${fmtClock(el.endSec)} (${(
                      el.endSec - el.startSec
                    ).toFixed(2)}s)`}
                  >
                    <span className="block truncate">{el.name}</span>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
