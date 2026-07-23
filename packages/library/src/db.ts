/**
 * SQLite bootstrap + row mappers for the library engine.
 *
 * bun:sqlite is built into Bun — no native dependency. The database lives at
 * `<rootDir>/library.db` next to the content-addressed blob dir. Columns are
 * snake_case (see schema.ts); records are camelCase (see types.ts); the tiny
 * mappers below are the only place that translation happens.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DDL, SCHEMA_VERSION } from "./schema";
import type {
  AssetRecord,
  CanvasItem,
  DocumentRecord,
  EntityRecord,
  TakeRecord,
} from "./types";

/** Open (creating if needed) the library database under rootDir. */
export function openDb(rootDir: string): Database {
  mkdirSync(rootDir, { recursive: true });
  const db = new Database(join(rootDir, "library.db"), { create: true });
  db.exec(DDL);
  db.query(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
  return db;
}

// ---------------------------------------------------------------------------
// Row shapes (exactly what SELECT * returns) + mappers to contract records.
// ---------------------------------------------------------------------------

export interface AssetRow {
  id: string;
  sha256: string;
  kind: string;
  mime: string;
  ext: string;
  original_name: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  storage_path: string;
  source: string;
  created_at: string;
}

export function mapAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    sha256: row.sha256,
    kind: row.kind as AssetRecord["kind"],
    mime: row.mime,
    ext: row.ext,
    originalName: row.original_name,
    sizeBytes: row.size_bytes,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    durationSec: row.duration_sec ?? undefined,
    storagePath: row.storage_path,
    source: row.source as AssetRecord["source"],
    createdAt: row.created_at,
  };
}

export interface DocumentRow {
  asset_id: string;
  text_content: string;
  extraction_method: string;
  word_count: number;
}

export function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    assetId: row.asset_id,
    textContent: row.text_content,
    extractionMethod: row.extraction_method as DocumentRecord["extractionMethod"],
    wordCount: row.word_count,
  };
}

export interface EntityRow {
  id: string;
  project_id: string | null;
  type: string;
  name: string;
  description: string;
  base_entity_id: string | null;
  created_at: string;
  updated_at: string;
}

export function mapEntity(row: EntityRow): EntityRecord {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    type: row.type as EntityRecord["type"],
    name: row.name,
    description: row.description,
    baseEntityId: row.base_entity_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CanvasItemRow {
  id: string;
  project_id: string;
  ref_type: string;
  ref_id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  z: number;
  meta: string;
  created_at: string;
}

export function mapCanvasItem(row: CanvasItemRow): CanvasItem {
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.meta) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt meta degrades to {} rather than breaking the canvas.
  }
  return {
    id: row.id,
    projectId: row.project_id,
    refType: row.ref_type as CanvasItem["refType"],
    refId: row.ref_id,
    x: row.x,
    y: row.y,
    w: row.w ?? undefined,
    h: row.h ?? undefined,
    z: row.z,
    meta,
    createdAt: row.created_at,
  };
}

export interface TakeRow {
  id: string;
  project_id: string;
  shot_id: string;
  asset_id: string;
  keyframe_asset_id: string | null;
  prompt: string;
  selected: number;
  created_at: string;
}

export function mapTake(row: TakeRow): TakeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    shotId: row.shot_id,
    assetId: row.asset_id,
    keyframeAssetId: row.keyframe_asset_id ?? undefined,
    prompt: row.prompt,
    selected: row.selected !== 0,
    createdAt: row.created_at,
  };
}
