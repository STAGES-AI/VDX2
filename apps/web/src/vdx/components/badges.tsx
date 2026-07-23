/** Shared presentational atoms: asset-kind glyphs and entity type badges. */

import type { AssetKind, EntityType } from "../types";

const KIND_PATHS: Record<AssetKind, string> = {
  // simple 24x24 glyphs (filled) — image / video / audio / document
  image:
    "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 2v8.6l3.6-3.6 3 3L15 11.6l4 4V7H5Zm3.5 1a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z",
  video: "M4 5h11a1 1 0 0 1 1 1v3.2l4.4-2.6a.6.6 0 0 1 .9.5v9.8a.6.6 0 0 1-.9.5L16 14.8V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  audio:
    "M13 4.1v12.2a3.4 3.4 0 1 1-2-3.1V6.6L19 5v8.9a3.4 3.4 0 1 1-2-3.1V3l-4 1.1Z",
  document:
    "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm6 2v4h4l-4-4ZM9 12h6v1.5H9V12Zm0 3.5h6V17H9v-1.5Z",
};

export function KindIcon({ kind, className }: { kind: AssetKind; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? "size-4 fill-current"} aria-hidden>
      <path d={KIND_PATHS[kind]} />
    </svg>
  );
}

/** Full class strings so Tailwind's scanner picks them up. */
export const ENTITY_BADGE: Record<EntityType, string> = {
  character: "bg-violet-500/15 text-violet-300 border-violet-400/30",
  location: "bg-sky-500/15 text-sky-300 border-sky-400/30",
  scene: "bg-cyan-500/15 text-cyan-300 border-cyan-400/30",
  style: "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-400/30",
  prop: "bg-orange-500/15 text-orange-300 border-orange-400/30",
  voice: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  brief: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  other: "bg-zinc-500/15 text-zinc-300 border-zinc-400/30",
};

export function EntityBadge({ type }: { type: EntityType }) {
  const cls = ENTITY_BADGE[type] ?? ENTITY_BADGE.other;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {type}
    </span>
  );
}

/** 'character · Mara' chip used on upload cards. */
export function EntityChip({
  type,
  name,
  created,
}: {
  type: EntityType;
  name: string;
  created?: boolean;
}) {
  const cls = ENTITY_BADGE[type] ?? ENTITY_BADGE.other;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${cls}`}
    >
      {type} · {name}
      {created ? <span className="opacity-70">(new)</span> : null}
    </span>
  );
}
