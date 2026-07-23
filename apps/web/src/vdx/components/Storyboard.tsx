/**
 * Storyboard — plan shots joined with their takes as a responsive card grid.
 * Each card: selected-take thumb, beat/duration/camera, expandable prompt,
 * voiceover, a retake button (with optional prompt tweak) and the take stack.
 */

import { useEffect, useRef, useState } from "react";
import { groupTakesByShot, pickSelectedTake, resolveMediaUrl } from "../lib";
import type { Beat, Plan, Shot, TakeInfo } from "../types";

interface StoryboardProps {
  plan: Plan | null;
  takes: TakeInfo[];
  busy: boolean;
  selectedShotId: string | null;
  onRetake: (shotId: string, promptTweak?: string) => void;
  onSelectTake: (takeId: string) => void;
}

function Thumb({ take, label }: { take: TakeInfo | null; label: string }) {
  if (take?.keyframeUrl) {
    return (
      <img
        src={resolveMediaUrl(take.keyframeUrl)}
        alt={label}
        loading="lazy"
        className="aspect-video w-full rounded-t-[inherit] object-cover"
      />
    );
  }
  if (take?.url) {
    return (
      <video
        src={resolveMediaUrl(take.url)}
        muted
        playsInline
        preload="metadata"
        className="aspect-video w-full rounded-t-[inherit] object-cover"
      />
    );
  }
  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-t-[inherit] bg-black/40 text-muted-foreground">
      <svg viewBox="0 0 24 24" className="size-8 fill-current opacity-40" aria-hidden>
        <path d="M8 5v14l11-7z" />
      </svg>
    </div>
  );
}

function ShotCard({
  shot,
  beat,
  takes,
  busy,
  selected,
  onRetake,
  onSelectTake,
}: {
  shot: Shot;
  beat: Beat | undefined;
  takes: TakeInfo[];
  busy: boolean;
  selected: boolean;
  onRetake: (shotId: string, promptTweak?: string) => void;
  onSelectTake: (takeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tweak, setTweak] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);

  const selectedTake = pickSelectedTake(takes);

  return (
    <div
      ref={ref}
      className="vdx-panel flex flex-col overflow-hidden text-sm"
      style={selected ? { boxShadow: "0 0 0 1px #d84c4c, 0 14px 34px -8px rgba(0,0,0,0.55)" } : undefined}
    >
      <div className="relative">
        <Thumb take={selectedTake} label={shot.id} />
        {selectedTake?.url ? (
          <span className="absolute bottom-1.5 right-1.5 rounded-full bg-[#6e8be8]/90 px-2 py-px font-mono text-[9px] font-medium uppercase tracking-wide text-white">
            clip
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-2.5">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-mono text-xs font-semibold">{shot.id}</span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {beat?.name ?? shot.beatId}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {shot.durationSec.toFixed(1)}s
          </span>
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{shot.camera}</div>

        <button
          type="button"
          className="text-left"
          title={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
        >
          <p className={`text-xs text-foreground/80 ${expanded ? "" : "line-clamp-3"}`}>
            {shot.visualPrompt}
          </p>
        </button>

        {shot.voiceover ? (
          <p className="text-[11px] italic text-muted-foreground">VO: “{shot.voiceover}”</p>
        ) : null}

        {/* take stack */}
        {takes.length > 0 ? (
          <div className="vdx-divider-t mt-auto flex flex-wrap items-center gap-1.5 pt-1.5">
            <span className="mr-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              takes
            </span>
            {takes.map((take, i) => (
              <button
                key={take.id}
                type="button"
                disabled={busy || take.selected}
                title={take.prompt}
                onClick={() => onSelectTake(take.id)}
                className="relative size-9 overflow-hidden rounded-[7px] font-mono text-[10px] opacity-80 transition-opacity hover:opacity-100 disabled:cursor-default disabled:opacity-100"
                style={take.selected ? { boxShadow: "0 0 0 1.5px #d84c4c" } : undefined}
              >
                {take.keyframeUrl ? (
                  <img
                    src={resolveMediaUrl(take.keyframeUrl)}
                    alt={`take ${i + 1}`}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-[var(--bm-raised)] text-muted-foreground">
                    {i + 1}
                  </span>
                )}
                <span className="absolute bottom-0 right-0 rounded-tl-[6px] bg-black/70 px-0.5 text-[8px] leading-3 text-white">
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {/* retake */}
        <form
          className="vdx-divider-t flex gap-1.5 pt-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            onRetake(shot.id, tweak.trim() || undefined);
            setTweak("");
          }}
        >
          <input
            className="vdx-well h-7 min-w-0 flex-1 border-0 px-3 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            placeholder="Optional tweak… (e.g. “wider shot”)"
            value={tweak}
            disabled={busy}
            onChange={(e) => setTweak(e.target.value)}
          />
          <button type="submit" disabled={busy} className="vdx-pill-ghost h-7 shrink-0 px-2.5 text-[11px] font-medium">
            Retake
          </button>
        </form>
      </div>
    </div>
  );
}

export function Storyboard(props: StoryboardProps) {
  const { plan, takes, busy, selectedShotId, onRetake, onSelectTake } = props;

  if (!plan) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        The storyboard appears once the director has a plan.
      </div>
    );
  }

  const beatById = new Map(plan.beats.map((b) => [b.id, b] as const));
  const takesByShot = groupTakesByShot(takes);

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
        {plan.shots.map((shot) => (
          <ShotCard
            key={shot.id}
            shot={shot}
            beat={beatById.get(shot.beatId)}
            takes={takesByShot[shot.id] ?? []}
            busy={busy}
            selected={selectedShotId === shot.id}
            onRetake={onRetake}
            onSelectTake={onSelectTake}
          />
        ))}
      </div>
    </div>
  );
}
