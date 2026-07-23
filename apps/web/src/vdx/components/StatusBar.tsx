import type { TProject } from "../types";

interface StatusBarProps {
  jobStatus: string | null;
  project: TProject | null;
  durationSec: number;
  /** Last director `done` summary (shots/cost/duration) — sticks around. */
  doneSummary: string | null;
}

/** Thin bar between preview and timeline: live job progress, else project info. */
export function StatusBar({ jobStatus, project, durationSec, doneSummary }: StatusBarProps) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-y border-border bg-muted/60 px-3 text-xs">
      {jobStatus ? (
        <>
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-indigo-500" />
          </span>
          <span className="truncate text-foreground/80" title={jobStatus}>
            {jobStatus}
          </span>
        </>
      ) : project ? (
        <>
          <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
          <span className="truncate text-muted-foreground">
            {project.metadata.name} · {durationSec.toFixed(1)}s · {project.scenes.length}{" "}
            {project.scenes.length === 1 ? "scene" : "scenes"} · {project.mediaAssets.length} assets
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">Idle — no project</span>
      )}
      {doneSummary ? (
        <span
          className="ml-auto min-w-0 max-w-[45%] shrink-0 truncate rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-px text-[10px] text-emerald-300"
          title={doneSummary}
        >
          {doneSummary}
        </span>
      ) : null}
    </div>
  );
}
