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

/**
 * Full class strings so Tailwind's scanner picks them up. Black Mamba only
 * defines 5 chromatic hues (docs/black-mamba-workspace-design.md §3: the
 * accent red plus 4 agent-role colors) — the 5 most distinct entity types
 * get one hue each; the rest stay neutral rather than inventing hues the
 * design key doesn't have. No borders — "no strokes/borders anywhere",
 * depth via fill only for a chip this small.
 */
export const ENTITY_BADGE: Record<EntityType, string> = {
  character: "bg-[#c084fc]/15 text-[#c084fc]", // violet — Designer
  location: "bg-[#6e8be8]/15 text-[#6e8be8]", // blue — Researcher
  scene: "bg-[#5bbf97]/15 text-[#5bbf97]", // green — Reviewer
  style: "bg-[#c9892f]/15 text-[#c9892f]", // amber — Builder
  brief: "bg-[#d84c4c]/15 text-[#d84c4c]", // red — accent
  prop: "bg-[#151418] text-[#b6b5bb]",
  voice: "bg-[#151418] text-[#b6b5bb]",
  other: "bg-[#151418] text-[#7c7a82]",
};

export function EntityBadge({ type }: { type: EntityType }) {
  const cls = ENTITY_BADGE[type] ?? ENTITY_BADGE.other;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${cls}`}
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
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${cls}`}>
      {type} · {name}
      {created ? <span className="opacity-70">(new)</span> : null}
    </span>
  );
}
