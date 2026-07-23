/**
 * Project switcher — replaces the header's bare <select>. A well-styled
 * trigger opens a popover with "+ New Project" plus the project list, each
 * row exposing rename/duplicate/delete on hover. Rename edits inline (no
 * window.prompt); delete needs a second click on "Delete?" within the same
 * row (no window.confirm). Closes on outside click and Escape.
 */

import { useEffect, useRef, useState } from "react";
import type { ProjectListItem } from "../types";

interface ProjectMenuProps {
  projects: ProjectListItem[];
  projectId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onNewProject: () => void;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 fill-none stroke-current stroke-2" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.6]" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 20h4L18.5 9.5a2.121 2.121 0 1 0-3-3L5 17v3Z" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.6]" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path strokeLinecap="round" d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-[1.6]" aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M6 7h12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"
      />
    </svg>
  );
}

const ROW_ACTION_BTN = "vdx-pill-ghost flex size-6 shrink-0 items-center justify-center";

function ProjectRow({
  project,
  active,
  busy,
  onSelect,
  onRename,
  onDuplicate,
  onDelete,
}: {
  project: ProjectListItem;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onRename: (name: string) => Promise<boolean>;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [committing, setCommitting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  // Synchronous re-entrancy guard for commitRename — the `committing` state
  // update that disables the input can itself trigger a blur (and thus a
  // second commitRename via onBlur) before React has re-rendered with the
  // new state, so the guard can't rely on state timing.
  const committingRef = useRef(false);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  // Any click outside the "Delete?" button itself cancels the confirm state
  // (including clicks elsewhere in the same row) — mousedown fires before the
  // button's own click, so a click ON the button still lands normally.
  useEffect(() => {
    if (!confirmingDelete) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (confirmBtnRef.current?.contains(e.target as Node)) return;
      setConfirmingDelete(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [confirmingDelete]);

  const commitRename = async () => {
    if (committingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === project.name) {
      setName(project.name);
      setRenaming(false);
      return;
    }
    committingRef.current = true;
    setCommitting(true);
    const ok = await onRename(trimmed);
    committingRef.current = false;
    setCommitting(false);
    setRenaming(false);
    if (!ok) setName(project.name);
  };

  if (renaming) {
    return (
      <div className="px-1.5 py-1">
        <input
          ref={inputRef}
          className="vdx-well h-7 w-full border-0 px-2.5 text-xs text-foreground outline-none"
          style={{ borderRadius: 14 }}
          value={name}
          disabled={committing}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commitRename();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setName(project.name);
              setRenaming(false);
            }
          }}
          onBlur={() => {
            if (!committingRef.current) void commitRename();
          }}
        />
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-1 rounded-[7px] px-1.5 py-1.5 hover:bg-[var(--bm-hover)]">
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-xs text-foreground/85"
        style={active ? { color: "var(--bm-c1)", fontWeight: 600 } : undefined}
        disabled={busy}
        onClick={onSelect}
      >
        {project.name}
      </button>
      <span
        className={`flex shrink-0 items-center gap-0.5 ${
          confirmingDelete ? "" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        {confirmingDelete ? (
          <button
            ref={confirmBtnRef}
            type="button"
            className="whitespace-nowrap px-1.5 text-[10px] font-semibold text-[#d84c4c]"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(false);
              onDelete();
            }}
          >
            Delete?
          </button>
        ) : (
          <>
            <button
              type="button"
              title="Rename"
              aria-label="Rename project"
              className={ROW_ACTION_BTN}
              onClick={(e) => {
                e.stopPropagation();
                setName(project.name);
                setRenaming(true);
              }}
            >
              <PencilIcon />
            </button>
            <button
              type="button"
              title="Duplicate"
              aria-label="Duplicate project"
              className={ROW_ACTION_BTN}
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate();
              }}
            >
              <CopyIcon />
            </button>
            <button
              type="button"
              title="Delete"
              aria-label="Delete project"
              className={`${ROW_ACTION_BTN} hover:!text-[#d84c4c]`}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmingDelete(true);
              }}
            >
              <TrashIcon />
            </button>
          </>
        )}
      </span>
    </div>
  );
}

export function ProjectMenu(props: ProjectMenuProps) {
  const { projects, projectId, busy, onSelect, onRefresh, onNewProject, onRename, onDuplicate, onDelete } =
    props;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = projects.find((p) => p.id === projectId) ?? null;

  useEffect(() => {
    if (!open) return;
    onRefresh();
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="vdx-well flex h-8 max-w-56 items-center gap-1.5 border-0 px-3 text-xs text-foreground outline-none"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {active ? active.name : projects.length > 0 ? "Open a project…" : "No projects yet"}
        </span>
        <ChevronIcon />
      </button>

      {open ? (
        <div className="vdx-panel absolute right-0 top-[calc(100%+6px)] z-40 w-64 overflow-hidden p-1.5">
          <button
            type="button"
            className="w-full rounded-[7px] px-2 py-1.5 text-left text-xs font-medium text-foreground/90 hover:bg-[var(--bm-hover)]"
            onClick={() => {
              onNewProject();
              setOpen(false);
            }}
          >
            + New Project
          </button>
          {projects.length > 0 ? (
            <div className="vdx-divider-t mt-1 max-h-64 space-y-0.5 overflow-y-auto pt-1">
              {projects.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  active={p.id === projectId}
                  busy={busy}
                  onSelect={() => {
                    onSelect(p.id);
                    setOpen(false);
                  }}
                  onRename={(name) => onRename(p.id, name)}
                  onDuplicate={() => {
                    onDuplicate(p.id);
                    setOpen(false);
                  }}
                  onDelete={() => onDelete(p.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
