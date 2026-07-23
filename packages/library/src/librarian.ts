/**
 * The librarian — turns raw uploads into organized, linked entities.
 *
 * Two paths:
 *  - Heuristic (always available, offline): filename keywords + markdown
 *    heading scan drive entity creation/linking.
 *  - Claude (env-gated on ANTHROPIC_API_KEY, or an injected client): a
 *    compact classify+describe prompt returning strict JSON. Any failure
 *    falls back to the heuristic, so organization never blocks an ingest.
 */

import { readFileSync } from "node:fs";
import type {
  AssetRecord,
  DocumentRecord,
  EntityRecord,
  EntityType,
  OrganizationResult,
} from "./types";

/** Narrow db surface the librarian needs; implemented by library.ts. */
export interface LibrarianOps {
  /** Same name+type lookup, project scope first, then global. */
  findEntity(name: string, type: EntityType, projectId?: string): EntityRecord | undefined;
  createEntity(entity: {
    type: EntityType;
    name: string;
    description?: string;
    projectId?: string;
  }): EntityRecord;
  /** Fill in a description on an existing entity (used when reusing). */
  updateEntityDescription(id: string, description: string): void;
  linkAssetToEntity(entityId: string, assetId: string, role: "reference" | "voice" | "document"): void;
  markProjectAssetPurpose(projectId: string, assetId: string, purpose: "brief" | "reference" | "generated"): void;
}

export interface OrganizeOptions {
  projectId?: string;
  /** Injected Claude client (tests) — takes precedence over env gating. */
  client?: LibrarianClient;
  /** Env used for gating the Claude path; defaults to process.env. */
  env?: Record<string, string | undefined>;
}

const ENTITY_TYPES: EntityType[] = [
  "character",
  "location",
  "scene",
  "style",
  "prop",
  "voice",
  "brief",
  "other",
];

/** Filename keyword -> entity type. voice/brief-group are kind-gated below. */
const FILENAME_KEYWORDS: Record<string, EntityType> = {
  char: "character",
  character: "character",
  cast: "character",
  style: "style",
  look: "style",
  palette: "style",
  location: "location",
  set: "location",
  scene: "location",
  env: "location",
  prop: "prop",
  voice: "voice",
  brief: "brief",
  treatment: "brief",
  script: "brief",
  pitch: "brief",
};

const DESCRIPTION_CAP = 800;

function titleCase(words: string[]): string {
  return words
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function stem(originalName: string): string {
  const base = originalName.split("/").pop() ?? originalName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function linkRole(kind: AssetRecord["kind"]): "reference" | "voice" | "document" {
  if (kind === "audio") return "voice";
  if (kind === "document") return "document";
  return "reference";
}

interface EntitySuggestion {
  type: EntityType;
  name: string;
  description: string;
}

/** Filename heuristic: keyword tokens pick the type, the rest becomes the name. */
export function suggestFromFilename(
  originalName: string,
  kind: AssetRecord["kind"],
): EntitySuggestion | undefined {
  const tokens = stem(originalName)
    .split(/[\s_\-.]+/)
    .filter(Boolean);
  let type: EntityType | undefined;
  const nameTokens: string[] = [];
  for (const token of tokens) {
    const keyword = FILENAME_KEYWORDS[token.toLowerCase()];
    const applies =
      keyword !== undefined &&
      (keyword === "voice" ? kind === "audio" : keyword === "brief" ? kind === "document" : true);
    if (applies && type === undefined) {
      type = keyword;
    } else if (applies && type === keyword) {
      // Repeated keyword token — still stripped from the name.
    } else {
      nameTokens.push(token.toLowerCase());
    }
  }
  if (type === undefined) return undefined;
  const name = nameTokens.length > 0 ? titleCase(nameTokens) : titleCase(tokens.map((t) => t.toLowerCase()));
  return { type, name, description: "" };
}

/**
 * Markdown heading scan: "Character: X" / "Location: X" / "Style: X"
 * (case-insensitive) and the "## X — character" variant. The section body
 * (until the next heading) becomes the entity description.
 */
export function suggestFromMarkdown(text: string): EntitySuggestion[] {
  const lines = text.split(/\r?\n/);
  const suggestions: EntitySuggestion[] = [];
  const headingTypes = "character|location|style";

  for (let i = 0; i < lines.length; i++) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i]!);
    if (!heading) continue;
    const title = heading[1]!;

    let type: EntityType | undefined;
    let name: string | undefined;
    const prefixed = new RegExp(`^(${headingTypes})\\s*:\\s*(.+)$`, "i").exec(title);
    const suffixed = new RegExp(`^(.+?)\\s*(?:—|–|--|-)\\s*(${headingTypes})\\s*$`, "i").exec(title);
    if (prefixed) {
      type = prefixed[1]!.toLowerCase() as EntityType;
      name = prefixed[2]!.trim();
    } else if (suffixed) {
      type = suffixed[2]!.toLowerCase() as EntityType;
      name = suffixed[1]!.trim();
    }
    if (!type || !name) continue;

    const body: string[] = [];
    for (let j = i + 1; j < lines.length && !/^#{1,6}\s+/.test(lines[j]!); j++) {
      body.push(lines[j]!);
    }
    suggestions.push({
      type,
      name,
      description: body.join("\n").trim().slice(0, DESCRIPTION_CAP),
    });
  }
  return suggestions;
}

function applySuggestions(
  ops: LibrarianOps,
  asset: AssetRecord,
  suggestions: EntitySuggestion[],
  opts: OrganizeOptions,
): OrganizationResult {
  const linked: OrganizationResult["linkedEntities"] = [];
  const role = linkRole(asset.kind);

  for (const suggestion of suggestions) {
    const existing = ops.findEntity(suggestion.name, suggestion.type, opts.projectId);
    let entity: EntityRecord;
    let created = false;
    if (existing) {
      entity = existing;
      if (suggestion.description && !existing.description) {
        ops.updateEntityDescription(existing.id, suggestion.description);
      }
    } else {
      entity = ops.createEntity({
        type: suggestion.type,
        name: suggestion.name,
        description: suggestion.description,
        projectId: opts.projectId,
      });
      created = true;
    }
    ops.linkAssetToEntity(entity.id, asset.id, role);
    linked.push({ entityId: entity.id, name: entity.name, type: suggestion.type, created });

    if (suggestion.type === "brief" && asset.kind === "document" && opts.projectId) {
      ops.markProjectAssetPurpose(opts.projectId, asset.id, "brief");
    }
  }

  const summary =
    linked.length === 0
      ? `Stored "${asset.originalName}" in the library.`
      : `Filed "${asset.originalName}" → ${linked
          .map((e) => `${e.type} "${e.name}"${e.created ? " (new)" : ""}`)
          .join(", ")}.`;
  return { summary, linkedEntities: linked };
}

/** Heuristic organization: filename keywords + markdown headings. */
export function organizeHeuristic(
  ops: LibrarianOps,
  asset: AssetRecord,
  document: DocumentRecord | undefined,
  opts: OrganizeOptions,
): OrganizationResult {
  const suggestions: EntitySuggestion[] = [];
  const fromName = suggestFromFilename(asset.originalName, asset.kind);
  if (fromName) suggestions.push(fromName);

  if (document && asset.ext === "md" && document.textContent) {
    for (const md of suggestFromMarkdown(document.textContent)) {
      const clash = suggestions.some(
        (s) => s.type === md.type && s.name.toLowerCase() === md.name.toLowerCase(),
      );
      if (!clash) suggestions.push(md);
    }
  }
  return applySuggestions(ops, asset, suggestions, opts);
}

// ---------------------------------------------------------------------------
// Claude path (env-gated). Prompt-shaping is pure so it unit-tests without a
// network; the live client is a thin fetch wrapper.
// ---------------------------------------------------------------------------

export const LIBRARIAN_MODEL = "claude-opus-4-8";
const DOCUMENT_EXCERPT_CHARS = 4_000;

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface LibrarianPrompt {
  system: string;
  content: ClaudeContentBlock[];
}

export interface LibrarianClient {
  /** Returns the model's raw text response for the given prompt. */
  complete(prompt: LibrarianPrompt): Promise<string>;
}

export function buildLibrarianPrompt(
  asset: AssetRecord,
  document?: DocumentRecord,
  imageBytes?: Uint8Array,
): LibrarianPrompt {
  const system =
    `You are a film-production librarian. Classify the uploaded file and extract the entities it ` +
    `describes or depicts. Respond with STRICT JSON only — no prose, no code fences — shaped as ` +
    `{"entities":[{"type":"...","name":"...","description":"..."}]}. ` +
    `Allowed types: ${ENTITY_TYPES.join(", ")}. Names are short proper nouns; descriptions are one ` +
    `or two sentences. Return {"entities":[]} when nothing identifiable is present.`;

  const content: ClaudeContentBlock[] = [
    {
      type: "text",
      text: `File: ${asset.originalName} (${asset.kind}, ${asset.mime}, ${asset.sizeBytes} bytes)`,
    },
  ];
  if (document?.textContent) {
    content.push({
      type: "text",
      text: `Document text (excerpt):\n${document.textContent.slice(0, DOCUMENT_EXCERPT_CHARS)}`,
    });
  }
  if (asset.kind === "image" && imageBytes) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: asset.mime, data: Buffer.from(imageBytes).toString("base64") },
    });
  }
  return { system, content };
}

/** Parse + validate the model's strict-JSON reply. Throws on any deviation. */
export function parseLibrarianResponse(raw: string): EntitySuggestion[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(trimmed) as { entities?: unknown };
  if (!parsed || !Array.isArray(parsed.entities)) {
    throw new Error("librarian: response missing entities array");
  }
  return parsed.entities.map((e) => {
    const entity = e as { type?: unknown; name?: unknown; description?: unknown };
    if (
      typeof entity.type !== "string" ||
      !ENTITY_TYPES.includes(entity.type as EntityType) ||
      typeof entity.name !== "string" ||
      entity.name.trim().length === 0
    ) {
      throw new Error(`librarian: invalid entity in response: ${JSON.stringify(e)}`);
    }
    return {
      type: entity.type as EntityType,
      name: entity.name.trim(),
      description: typeof entity.description === "string" ? entity.description.slice(0, DESCRIPTION_CAP) : "",
    };
  });
}

export async function organizeWithClaude(
  client: LibrarianClient,
  ops: LibrarianOps,
  asset: AssetRecord,
  document: DocumentRecord | undefined,
  opts: OrganizeOptions,
): Promise<OrganizationResult> {
  let imageBytes: Uint8Array | undefined;
  if (asset.kind === "image") {
    imageBytes = readFileSync(asset.storagePath);
  }
  const raw = await client.complete(buildLibrarianPrompt(asset, document, imageBytes));
  return applySuggestions(ops, asset, parseLibrarianResponse(raw), opts);
}

/** Live Anthropic client (fetch-based; no SDK dependency). */
export function createAnthropicLibrarianClient(apiKey: string): LibrarianClient {
  return {
    async complete(prompt) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: LIBRARIAN_MODEL,
          max_tokens: 1024,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.content }],
        }),
      });
      if (!response.ok) {
        throw new Error(`librarian: anthropic API error ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = body.content?.find((b) => b.type === "text")?.text;
      if (!text) throw new Error("librarian: anthropic response had no text block");
      return text;
    },
  };
}

/**
 * Organize an ingested asset. Uses Claude when a client is injected or
 * ANTHROPIC_API_KEY is set; falls back to the heuristic on any error.
 */
export async function organize(
  ops: LibrarianOps,
  asset: AssetRecord,
  document: DocumentRecord | undefined,
  opts: OrganizeOptions = {},
): Promise<OrganizationResult> {
  const env = opts.env ?? process.env;
  const client =
    opts.client ?? (env.ANTHROPIC_API_KEY ? createAnthropicLibrarianClient(env.ANTHROPIC_API_KEY) : undefined);
  if (client) {
    try {
      return await organizeWithClaude(client, ops, asset, document, opts);
    } catch {
      // Claude path is best-effort; the heuristic below always works.
    }
  }
  return organizeHeuristic(ops, asset, document, opts);
}
