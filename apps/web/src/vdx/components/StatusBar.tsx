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
    <div className="vdx-divider-y flex h-7 shrink-0 items-center gap-2 bg-[var(--bm-well)] px-3 font-mono text-[11px]">
      {jobStatus ? (
        <>
          <span className="relative flex size-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#6e8be8] opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-[#6e8be8]" />
          </span>
          <span className="truncate text-foreground/80" title={jobStatus}>
            {jobStatus}
          </span>
        </>
      ) : project ? (
        <>
          <span className="size-2 shrink-0 rounded-full bg-[#5bbf97]" />
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
          className="vdx-chip ml-auto min-w-0 max-w-[45%] shrink-0 truncate !bg-[#5bbf97]/12 !text-[#5bbf97]"
          title={doneSummary}
        >
          {doneSummary}
        </span>
      ) : null}
    </div>
  );
}
