/**
 * Stable content hashing for cache keys and mock determinism.
 *
 * Key = sha256 hex of canonical JSON (recursively sorted keys, undefined
 * dropped) of { model, request }. The request is normalized by stripping
 * fields that do not affect the produced media once the model is fixed —
 * today that is `tier`, because the routed model id already encodes the
 * tier choice. Same request + same model ⇒ same key, regardless of object
 * key insertion order.
 */

import { createHash } from "node:crypto";
import type { GenerationRequest } from "./types";

/** Serialize a JSON-compatible value with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Strip fields that are irrelevant once the model id is fixed. */
export function normalizeRequest(request: GenerationRequest): Record<string, unknown> {
  const { tier: _tier, ...rest } = request;
  return rest;
}

/** Deterministic cache key for (model, request). */
export function contentHash(model: string, request: GenerationRequest): string {
  return sha256Hex(canonicalJson({ model, request: normalizeRequest(request) }));
}
