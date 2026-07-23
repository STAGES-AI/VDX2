/**
 * Runtime-configurable settings — API keys and Claude model/effort — stored
 * as JSON next to the rest of the .vdx state (<root>/config.json) so changes
 * made through the Settings UI survive restarts AND, more importantly, take
 * effect immediately: services.ts holds this config in a mutable variable
 * and rebuilds the Gateway from it on every update (see updateSettings).
 *
 * process.env.* stays the fallback for every key/field so the server keeps
 * working exactly as before for anyone who never touches Settings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeConfig {
  anthropicApiKey: string | null;
  falApiKey: string | null;
  elevenLabsApiKey: string | null;
  plannerModel: string;
  plannerEffort: Effort;
  editorModel: string;
  editorEffort: Effort;
}

export const DEFAULT_CONFIG: RuntimeConfig = {
  anthropicApiKey: null,
  falApiKey: null,
  elevenLabsApiKey: null,
  plannerModel: "claude-opus-4-8",
  plannerEffort: "high",
  editorModel: "claude-opus-4-8",
  editorEffort: "medium",
};

/** The three key fields; an empty-string patch value means "clear". */
type KeyField = "anthropicApiKey" | "falApiKey" | "elevenLabsApiKey";

function configPath(root: string): string {
  return join(root, "config.json");
}

/** Read <root>/config.json, merged shallow over the defaults. Never throws. */
export function loadConfig(root: string): RuntimeConfig {
  const path = configPath(root);
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (err) {
    console.warn(
      `[config] ${path} is not valid JSON, falling back to defaults: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Load current config, apply a patch, persist, and return the new config.
 * undefined  → leave the field unchanged
 * ""         → clear the field (key fields only; stored as null)
 * non-empty  → set the field
 */
export function saveConfig(root: string, patch: Partial<RuntimeConfig>): RuntimeConfig {
  const current = loadConfig(root);
  const next: RuntimeConfig = { ...current };

  const applyKey = (field: KeyField, value: string | null | undefined) => {
    if (value === undefined) return;
    next[field] = value === "" ? null : value;
  };
  applyKey("anthropicApiKey", patch.anthropicApiKey);
  applyKey("falApiKey", patch.falApiKey);
  applyKey("elevenLabsApiKey", patch.elevenLabsApiKey);

  if (patch.plannerModel !== undefined) next.plannerModel = patch.plannerModel;
  if (patch.plannerEffort !== undefined) next.plannerEffort = patch.plannerEffort;
  if (patch.editorModel !== undefined) next.editorModel = patch.editorModel;
  if (patch.editorEffort !== undefined) next.editorEffort = patch.editorEffort;

  mkdirSync(root, { recursive: true });
  writeFileSync(configPath(root), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Provider env vars derived from config, falling back to process.env per
 * key. Only keys that end up non-empty are included, so spreading this over
 * (or under) process.env never clobbers an existing var with "".
 */
export function effectiveEnv(config: RuntimeConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const anthropic = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY;
  const fal = config.falApiKey ?? process.env.FAL_KEY;
  const eleven = config.elevenLabsApiKey ?? process.env.ELEVENLABS_API_KEY;
  if (anthropic) env.ANTHROPIC_API_KEY = anthropic;
  if (fal) env.FAL_KEY = fal;
  if (eleven) env.ELEVENLABS_API_KEY = eleven;
  return env;
}

/** null passthrough; short keys mask to a single ellipsis (no slicing). */
export function maskKey(key: string | null): string | null {
  if (key === null) return null;
  if (key.length < 10) return "…";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Masked/public shape of RuntimeConfig — safe to return over HTTP/MCP. */
export interface SettingsView {
  anthropicKeySet: boolean;
  anthropicKeyPreview: string | null;
  falKeySet: boolean;
  falKeyPreview: string | null;
  elevenLabsKeySet: boolean;
  elevenLabsKeyPreview: string | null;
  plannerModel: string;
  plannerEffort: Effort;
  editorModel: string;
  editorEffort: Effort;
}

export function toSettingsView(config: RuntimeConfig): SettingsView {
  return {
    anthropicKeySet: config.anthropicApiKey !== null,
    anthropicKeyPreview: maskKey(config.anthropicApiKey),
    falKeySet: config.falApiKey !== null,
    falKeyPreview: maskKey(config.falApiKey),
    elevenLabsKeySet: config.elevenLabsApiKey !== null,
    elevenLabsKeyPreview: maskKey(config.elevenLabsApiKey),
    plannerModel: config.plannerModel,
    plannerEffort: config.plannerEffort,
    editorModel: config.editorModel,
    editorEffort: config.editorEffort,
  };
}
