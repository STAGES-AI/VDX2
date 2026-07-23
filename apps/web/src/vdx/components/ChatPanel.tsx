import { useEffect, useRef, useState } from "react";
import { UPLOAD_ACCEPT, fmtBytes } from "../lib";
import type { ChatMessage, Plan, UploadResultItem } from "../types";
import { EntityChip, KindIcon } from "./badges";
import { PlanCard } from "./PlanCard";

interface ChatPanelProps {
  messages: ChatMessage[];
  /** Plan loaded with an existing project (shown when no plan card is in chat yet). */
  plan: Plan | null;
  busy: boolean;
  uploading: boolean;
  hasProject: boolean;
  /** True while the director job is paused at the plan-approval gate. */
  awaitingApproval: boolean;
  /** 'Use as brief' — uploads in this batch get purpose='brief'. */
  briefMode: boolean;
  onBriefModeChange: (value: boolean) => void;
  onSend: (text: string, gate: boolean) => void;
  onApprove: () => void;
  onUpload: (files: File[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  onRender: (draft: boolean) => void;
}

function UploadCard({ item }: { item: UploadResultItem }) {
  return (
    <div className="mr-8 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <KindIcon kind={item.kind} className="size-4 shrink-0 fill-current text-muted-foreground" />
        <span className="min-w-0 truncate font-medium" title={item.name}>
          {item.name}
        </span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
          {fmtBytes(item.sizeBytes)}
        </span>
        {item.duplicate ? (
          <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            duplicate
          </span>
        ) : null}
      </div>
      {item.organization ? (
        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          <p className="text-xs text-muted-foreground">{item.organization.summary}</p>
          {item.organization.linkedEntities.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {item.organization.linkedEntities.map((e) => (
                <EntityChip key={e.entityId} type={e.type} name={e.name} created={e.created} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Message({
  message,
  awaitingApproval,
  onApprove,
}: {
  message: ChatMessage;
  awaitingApproval: boolean;
  onApprove: () => void;
}) {
  switch (message.kind) {
    case "user":
      return (
        <div className="ml-8 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          {message.text}
        </div>
      );
    case "plan":
      return (
        <PlanCard plan={message.plan} awaitingApproval={awaitingApproval} onApprove={onApprove} />
      );
    case "upload":
      return <UploadCard item={message.item} />;
    case "reply":
      return (
        <div className="mr-8 rounded-lg border border-border bg-card px-3 py-2 text-sm">
          <p>{message.text}</p>
          {message.applied.length > 0 ? (
            <ul className="mt-1.5 space-y-0.5 border-t border-border/60 pt-1.5 text-xs text-muted-foreground">
              {message.applied.map((a, i) => (
                <li key={i}>✓ {a}</li>
              ))}
            </ul>
          ) : null}
        </div>
      );
    case "error":
      return (
        <div className="mr-8 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {message.text}
        </div>
      );
    case "status":
      return (
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span className="inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <span className="truncate" title={message.text}>
            {message.stage !== "info" ? (
              <span className="mr-1 font-medium uppercase tracking-wide text-foreground/60">
                {message.stage}
              </span>
            ) : null}
            {message.text}
          </span>
        </div>
      );
  }
}

const ACTION_BTN =
  "rounded-md border border-border bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";

const TOGGLE_LABEL =
  "flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground";

export function ChatPanel(props: ChatPanelProps) {
  const {
    messages,
    plan,
    busy,
    uploading,
    hasProject,
    awaitingApproval,
    briefMode,
    onBriefModeChange,
    onSend,
    onApprove,
    onUpload,
    onUndo,
    onRedo,
    onRender,
  } = props;
  const [draft, setDraft] = useState("");
  const [gate, setGate] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    onSend(text, gate);
  };

  const pickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onUpload(Array.from(list));
  };

  const showPinnedPlan = plan != null && !messages.some((m) => m.kind === "plan");
  const lastPlanId = [...messages].reverse().find((m) => m.kind === "plan")?.id ?? null;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 && !showPinnedPlan ? (
          <div className="mt-10 px-4 text-center text-sm text-muted-foreground">
            <p className="font-heading text-lg text-foreground/80">Direct a video</p>
            <p className="mt-2">
              Describe the video you want — the first message creates a project and the director
              gets to work. After that, chat to edit it. Drop files anywhere (or use the paperclip)
              to fill the library first.
            </p>
          </div>
        ) : null}
        {showPinnedPlan ? (
          <PlanCard plan={plan} awaitingApproval={awaitingApproval} onApprove={onApprove} />
        ) : null}
        {messages.map((m) => (
          <Message
            key={m.id}
            message={m}
            awaitingApproval={awaitingApproval && m.id === lastPlanId}
            onApprove={onApprove}
          />
        ))}
      </div>

      <div className="border-t border-border p-3">
        <div className="mb-2 flex flex-wrap gap-1.5">
          <button type="button" className={ACTION_BTN} disabled={!hasProject || busy} onClick={onUndo}>
            Undo
          </button>
          <button type="button" className={ACTION_BTN} disabled={!hasProject || busy} onClick={onRedo}>
            Redo
          </button>
          <button
            type="button"
            className={ACTION_BTN}
            disabled={!hasProject || busy}
            onClick={() => onRender(true)}
          >
            Render (draft)
          </button>
          <button
            type="button"
            className={ACTION_BTN}
            disabled={!hasProject || busy}
            onClick={() => onRender(false)}
          >
            Render (final)
          </button>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={(e) => {
              pickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            title="Attach files"
            aria-label="Attach files"
            className="flex size-9 shrink-0 items-center justify-center self-end rounded-md border border-border bg-secondary text-secondary-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-2" aria-hidden>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m16.5 6.75-6.9 6.9a1.9 1.9 0 1 0 2.7 2.7l6.9-6.9a3.8 3.8 0 0 0-5.4-5.4l-6.9 6.9a5.7 5.7 0 1 0 8.1 8.1l5.5-5.5"
                />
              </svg>
            )}
          </button>
          <textarea
            className="min-h-9 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            rows={2}
            placeholder={hasProject ? "Edit the video… (e.g. “make the title bigger”)" : "Describe the video to create…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="submit"
            className="self-end rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={busy || draft.trim().length === 0}
          >
            {busy ? "Working…" : "Send"}
          </button>
        </form>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <label className={TOGGLE_LABEL} title="Uploads in the next batch are ingested as the project brief">
            <input
              type="checkbox"
              className="size-3 accent-primary"
              checked={briefMode}
              onChange={(e) => onBriefModeChange(e.target.checked)}
            />
            Use as brief
          </label>
          <label className={TOGGLE_LABEL} title="Pause after planning until you approve the plan">
            <input
              type="checkbox"
              className="size-3 accent-primary"
              checked={gate}
              onChange={(e) => setGate(e.target.checked)}
            />
            Review plan before generating
          </label>
        </div>
      </div>
    </div>
  );
}
