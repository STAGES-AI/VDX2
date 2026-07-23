/**
 * Settings modal — Anthropic/fal.ai/ElevenLabs keys plus the Planner and
 * Editor Chat model/effort pickers. Mounted only while open (see routes/index.tsx),
 * so "fetch on mount" == "fetch on open". Save only PUTs fields the user
 * actually touched (see buildSettingsPatch in ../lib) — key inputs never show
 * the real secret, only a masked preview as placeholder text.
 */

import { useEffect, useRef, useState } from "react";
import { EFFORT_OPTIONS, MODEL_OPTIONS, buildSettingsPatch } from "../lib";
import type { ModelEffort, SettingsResponse, UpdateSettingsRequest } from "../types";

interface SettingsPanelProps {
  onClose: () => void;
  settings: SettingsResponse | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  onLoad: () => void;
  onSave: (patch: UpdateSettingsRequest) => Promise<boolean>;
}

interface KeyFieldState {
  value: string;
  cleared: boolean;
}

const EMPTY_KEY: KeyFieldState = { value: "", cleared: false };

interface SelectFields {
  plannerModel: string;
  plannerEffort: ModelEffort;
  editorModel: string;
  editorEffort: ModelEffort;
}

const DEFAULT_SELECTS: SelectFields = {
  plannerModel: MODEL_OPTIONS[0]!.value,
  plannerEffort: "medium",
  editorModel: MODEL_OPTIONS[0]!.value,
  editorEffort: "medium",
};

function StatusChip({ live }: { live: boolean }) {
  return (
    <span className={`vdx-chip ${live ? "!bg-[#5bbf97]/15 !text-[#5bbf97]" : ""}`}>
      {live ? "live" : "mock"}
    </span>
  );
}

function KeyRow({
  label,
  keySet,
  preview,
  placeholder,
  field,
  onChange,
  onClear,
}: {
  label: string;
  keySet: boolean;
  preview: string | null;
  placeholder: string;
  field: KeyFieldState;
  onChange: (value: string) => void;
  onClear: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-foreground/80">{label}</span>
        <StatusChip live={keySet && !field.cleared} />
        {keySet && !field.cleared ? (
          <button
            type="button"
            className="ml-auto text-[11px] text-muted-foreground hover:text-[#d84c4c]"
            onClick={onClear}
          >
            Clear
          </button>
        ) : null}
      </div>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        className="vdx-well h-9 w-full border-0 px-3.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        style={{ borderRadius: 18 }}
        placeholder={field.cleared ? "will be cleared on save" : (preview ?? placeholder)}
        value={field.value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

const SELECT_CLASS = "vdx-well h-9 flex-1 border-0 px-3 text-xs text-foreground outline-none";

function ModelEffortSelects({
  model,
  effort,
  onModelChange,
  onEffortChange,
}: {
  model: string;
  effort: ModelEffort;
  onModelChange: (value: string) => void;
  onEffortChange: (value: ModelEffort) => void;
}) {
  return (
    <div className="flex gap-2">
      <select
        className={SELECT_CLASS}
        style={{ borderRadius: 999 }}
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
      >
        {MODEL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className={SELECT_CLASS}
        style={{ borderRadius: 999 }}
        value={effort}
        onChange={(e) => onEffortChange(e.target.value as ModelEffort)}
      >
        {EFFORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const { onClose, settings, loading, error, saving, onLoad, onSave } = props;

  const [anthropicKey, setAnthropicKey] = useState<KeyFieldState>(EMPTY_KEY);
  const [falKey, setFalKey] = useState<KeyFieldState>(EMPTY_KEY);
  const [elevenLabsKey, setElevenLabsKey] = useState<KeyFieldState>(EMPTY_KEY);
  const [selects, setSelects] = useState<SelectFields>(DEFAULT_SELECTS);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch once per mount — the panel is only mounted while open.
  useEffect(() => {
    onLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-sync local form state whenever fresh settings land (initial load, or
  // right after a successful save) — key inputs reset to empty on purpose,
  // selects pick up the server's current values.
  useEffect(() => {
    if (!settings) return;
    setSelects({
      plannerModel: settings.plannerModel,
      plannerEffort: settings.plannerEffort,
      editorModel: settings.editorModel,
      editorEffort: settings.editorEffort,
    });
    setAnthropicKey(EMPTY_KEY);
    setFalKey(EMPTY_KEY);
    setElevenLabsKey(EMPTY_KEY);
  }, [settings]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(
    () => () => {
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
    },
    [],
  );

  const handleSave = async () => {
    if (!settings) return;
    const patch = buildSettingsPatch(settings, {
      anthropicApiKey: anthropicKey.value,
      anthropicCleared: anthropicKey.cleared,
      falApiKey: falKey.value,
      falCleared: falKey.cleared,
      elevenLabsApiKey: elevenLabsKey.value,
      elevenLabsCleared: elevenLabsKey.cleared,
      plannerModel: selects.plannerModel,
      plannerEffort: selects.plannerEffort,
      editorModel: selects.editorModel,
      editorEffort: selects.editorEffort,
    });
    const ok = await onSave(patch);
    if (ok) {
      setJustSaved(true);
      if (savedTimeoutRef.current) clearTimeout(savedTimeoutRef.current);
      savedTimeoutRef.current = setTimeout(() => setJustSaved(false), 1500);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="vdx-panel flex max-h-[85vh] w-full max-w-[440px] flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="vdx-divider-b flex shrink-0 items-center gap-2 px-4 py-3">
          <h2 className="font-heading text-sm font-semibold uppercase tracking-wide">Settings</h2>
          <button
            type="button"
            title="Close"
            aria-label="Close settings"
            className="vdx-pill-ghost ml-auto flex size-7 shrink-0 items-center justify-center"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" className="size-3.5 fill-none stroke-current stroke-2" aria-hidden>
              <path strokeLinecap="round" d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-sm">
          {loading && !settings ? (
            <p className="text-xs text-muted-foreground">Loading settings…</p>
          ) : null}
          {error ? (
            <div className="rounded-[10px] bg-[#d84c4c]/12 px-3 py-2 text-xs text-[#ff8080] shadow-[inset_0_0_0_1px_rgba(216,76,76,0.18)]">
              {error}
            </div>
          ) : null}

          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Anthropic
            </h3>
            <KeyRow
              label="API key"
              keySet={settings?.anthropicKeySet ?? false}
              preview={settings?.anthropicKeyPreview ?? null}
              placeholder="sk-ant-..."
              field={anthropicKey}
              onChange={(value) => setAnthropicKey({ value, cleared: false })}
              onClear={() => setAnthropicKey({ value: "", cleared: true })}
            />
          </section>

          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Planner
            </h3>
            <ModelEffortSelects
              model={selects.plannerModel}
              effort={selects.plannerEffort}
              onModelChange={(v) => setSelects((s) => ({ ...s, plannerModel: v }))}
              onEffortChange={(v) => setSelects((s) => ({ ...s, plannerEffort: v }))}
            />
          </section>

          <section className="space-y-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Editor Chat
            </h3>
            <ModelEffortSelects
              model={selects.editorModel}
              effort={selects.editorEffort}
              onModelChange={(v) => setSelects((s) => ({ ...s, editorModel: v }))}
              onEffortChange={(v) => setSelects((s) => ({ ...s, editorEffort: v }))}
            />
            <p className="text-xs text-muted-foreground">
              Used for natural-language edits in chat — lower effort feels snappier.
            </p>
          </section>

          <section className="space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Generation
            </h3>
            <KeyRow
              label="fal.ai key"
              keySet={settings?.falKeySet ?? false}
              preview={settings?.falKeyPreview ?? null}
              placeholder="fal-..."
              field={falKey}
              onChange={(value) => setFalKey({ value, cleared: false })}
              onClear={() => setFalKey({ value: "", cleared: true })}
            />
            <KeyRow
              label="ElevenLabs key"
              keySet={settings?.elevenLabsKeySet ?? false}
              preview={settings?.elevenLabsKeyPreview ?? null}
              placeholder="xi-api-key-..."
              field={elevenLabsKey}
              onChange={(value) => setElevenLabsKey({ value, cleared: false })}
              onClear={() => setElevenLabsKey({ value: "", cleared: true })}
            />
          </section>
        </div>

        <div className="vdx-divider-t flex shrink-0 items-center justify-end gap-2 p-3">
          <button
            type="button"
            className="vdx-pill px-4 py-2 text-sm"
            disabled={saving || !settings}
            onClick={() => void handleSave()}
          >
            {justSaved ? "Saved" : saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
