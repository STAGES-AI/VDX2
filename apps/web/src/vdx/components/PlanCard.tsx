import type { Plan } from "../types";

interface PlanCardProps {
  plan: Plan;
  /** Set while the director job is paused at the plan-approval gate. */
  awaitingApproval?: boolean;
  onApprove?: () => void;
}

/** Chat card for a plan_ready event: title, logline, beats, shots-on-demand. */
export function PlanCard({ plan, awaitingApproval, onApprove }: PlanCardProps) {
  return (
    <div className="vdx-panel p-3 text-sm">
      {awaitingApproval ? (
        <div className="mb-2 flex items-center gap-2 rounded-[8px] bg-[#241b0f] px-2.5 py-1.5">
          <span className="size-2 shrink-0 rounded-full bg-[#c9892f]" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-[#c9892f]">
            Awaiting approval
          </span>
          <button type="button" className="vdx-pill shrink-0 !bg-[#c9892f] px-2.5 py-1 text-xs" onClick={onApprove}>
            Approve &amp; generate
          </button>
        </div>
      ) : null}
      <div className="font-heading text-sm font-semibold uppercase tracking-wide">{plan.title}</div>
      <p className="mt-1 text-muted-foreground">{plan.logline}</p>

      <div className="mt-3 space-y-2">
        {plan.beats.map((beat, i) => {
          const shots = plan.shots.filter((s) => s.beatId === beat.id);
          return (
            <div key={beat.id} className="rounded-[8px] bg-[var(--bm-well)] p-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">
                  {i + 1}. {beat.name}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {beat.durationSec.toFixed(1)}s
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{beat.description}</p>
              {shots.map((shot) => (
                <details key={shot.id} className="mt-1.5 group">
                  <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
                    <span className="font-mono font-medium text-foreground/80">{shot.id}</span>
                    {" · "}
                    {shot.durationSec.toFixed(1)}s · {shot.camera}
                  </summary>
                  <div className="mt-1 space-y-1 pl-2.5 text-xs shadow-[-2px_0_0_rgba(216,76,76,0.35)]">
                    <p>{shot.visualPrompt}</p>
                    {shot.voiceover ? (
                      <p className="text-muted-foreground">VO: “{shot.voiceover}”</p>
                    ) : null}
                    {shot.textOverlay ? (
                      <p className="text-muted-foreground">Text: {shot.textOverlay}</p>
                    ) : null}
                  </div>
                </details>
              ))}
            </div>
          );
        })}
      </div>

      <div className="vdx-divider-t mt-3 pt-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/70">Voice</span> {plan.voice}
        {" · "}
        <span className="font-medium text-foreground/70">Music</span> {plan.musicPrompt}
      </div>
    </div>
  );
}
