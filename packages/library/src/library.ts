/**
 * Library engine — implements the frozen contract in types.ts over
 * bun:sqlite (db.ts) + a content-addressed blob store (storage.ts).
 *
 * Ingest pipeline: classify → dedupe by sha256 → store blob → probe media →
 * extract document text → FTS index → librarian organize → canvas placement.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import {
  mapAsset,
  mapCanvasItem,
  mapDocument,
  mapEntity,
  mapTake,
  openDb,
  type AssetRow,
  type CanvasItemRow,
  type DocumentRow,
  type EntityRow,
  type TakeRow,
} from "./db";
import { classify } from "./classify";
import { extractText } from "./extract";
import { organize, type LibrarianClient, type LibrarianOps } from "./librarian";
import { probeAsset } from "./probe";
import { sha256Hex, storeBlob } from "./storage";
import type {
  AssetKind,
  AssetRecord,
  CanvasItem,
  CreateLibraryOptions,
  DocumentRecord,
  EntityRecord,
  EntityType,
  EntityWithAssets,
  IngestInput,
  IngestOptions,
  IngestResult,
  Library,
  ProjectContext,
  SearchHit,
  TakeRecord,
} from "./types";

const BRIEF_TEXT_CAP = 8_000;
const DOCUMENT_EXCERPT_CAP = 500;

// Canvas auto-layout grid (5 columns).
const GRID = { originX: 40, originY: 40, stepX: 240, stepY: 200, columns: 5 };
const CANVAS_SIZE: Record<"asset" | "entity", { w: number; h: number }> = {
  asset: { w: 220, h: 170 },
  entity: { w: 240, h: 120 },
};

export interface LibraryEngineOptions extends CreateLibraryOptions {
  /** Env for gating the librarian's Claude path; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injected librarian client (tests) — takes precedence over env gating. */
  librarianClient?: LibrarianClient;
}

export function createLibrary(opts: LibraryEngineOptions = {}): Library {
  return new LibraryEngine(opts);
}

class LibraryEngine implements Library {
  readonly rootDir: string;
  private db: Database;
  private env: Record<string, string | undefined>;
  private librarianClient?: LibrarianClient;

  constructor(opts: LibraryEngineOptions) {
    this.rootDir = resolve(opts.rootDir ?? join(process.cwd(), ".vdx"));
    this.db = openDb(this.rootDir);
    this.env = opts.env ?? process.env;
    this.librarianClient = opts.librarianClient;
  }

  close(): void {
    this.db.close();
  }

  // -- ingest ---------------------------------------------------------------

  async ingest(input: IngestInput, opts: IngestOptions = {}): Promise<IngestResult> {
    const bytes: Uint8Array =
      typeof input.data === "string" ? new Uint8Array(readFileSync(input.data)) : input.data;
    const classification = classify(input.originalName, bytes);
    const sha256 = sha256Hex(bytes);

    // Dedupe: same bytes → same asset row; just (re-)link to the project.
    const existing = this.assetBySha(sha256);
    if (existing) {
      if (opts.projectId) {
        this.attachToProject(existing.id, opts.projectId, opts.purpose, opts.label);
      }
      return { asset: existing, document: this.getDocument(existing.id), duplicate: true };
    }

    const stored = storeBlob(this.rootDir, bytes, classification.ext);
    const id = randomUUID();
    const now = new Date().toISOString();
    const source: AssetRecord["source"] = opts.purpose === "generated" ? "generated" : "upload";
    this.db
      .query(
        `INSERT INTO assets (id, sha256, kind, mime, ext, original_name, size_bytes, storage_path, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(
        id,
        sha256,
        classification.kind,
        classification.mime,
        classification.ext,
        input.originalName,
        stored.sizeBytes,
        stored.storagePath,
        source,
        now,
      );

    // Media metadata (best-effort).
    const probe = await probeAsset(stored.storagePath, classification.kind);
    if (probe.width !== undefined || probe.height !== undefined || probe.durationSec !== undefined) {
      this.db
        .query(`UPDATE assets SET width = ?1, height = ?2, duration_sec = ?3 WHERE id = ?4`)
        .run(probe.width ?? null, probe.height ?? null, probe.durationSec ?? null, id);
    }

    // Document text extraction + FTS.
    let document: DocumentRecord | undefined;
    if (classification.kind === "document") {
      const extracted = await extractText(stored.storagePath, classification.ext);
      this.db
        .query(
          `INSERT INTO documents (asset_id, text_content, extraction_method, word_count)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .run(id, extracted.textContent, extracted.extractionMethod, extracted.wordCount);
      document = {
        assetId: id,
        textContent: extracted.textContent,
        extractionMethod: extracted.extractionMethod,
        wordCount: extracted.wordCount,
      };
      this.ftsUpsert("asset", id, extracted.textContent);
    }

    if (opts.projectId) {
      this.attachToProject(id, opts.projectId, opts.purpose, opts.label);
    }

    const asset = this.requireAsset(id);

    // Librarian organization (default on for uploads, off for generated).
    let organization: IngestResult["organization"];
    const shouldOrganize = opts.organize ?? opts.purpose !== "generated";
    if (shouldOrganize) {
      organization = await organize(this.librarianOps(), asset, document, {
        projectId: opts.projectId,
        client: this.librarianClient,
        env: this.env,
      });
    }

    // Canvas placement: the asset plus any entities the librarian touched.
    if (opts.projectId) {
      this.autoPlaceOnCanvas(opts.projectId, "asset", id);
      for (const linked of organization?.linkedEntities ?? []) {
        this.autoPlaceOnCanvas(opts.projectId, "entity", linked.entityId);
      }
    }

    return { asset, document, organization, duplicate: false };
  }

  // -- assets ---------------------------------------------------------------

  getAsset(id: string): AssetRecord | undefined {
    const row = this.db.query(`SELECT * FROM assets WHERE id = ?1`).get(id) as AssetRow | null;
    return row ? mapAsset(row) : undefined;
  }

  getDocument(assetId: string): DocumentRecord | undefined {
    const row = this.db.query(`SELECT * FROM documents WHERE asset_id = ?1`).get(assetId) as DocumentRow | null;
    return row ? mapDocument(row) : undefined;
  }

  listAssets(filter?: { projectId?: string; kind?: AssetKind }): AssetRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    let sql = `SELECT a.* FROM assets a`;
    if (filter?.projectId) {
      sql += ` JOIN project_assets pa ON pa.asset_id = a.id`;
      where.push(`pa.project_id = ?${params.length + 1}`);
      params.push(filter.projectId);
    }
    if (filter?.kind) {
      where.push(`a.kind = ?${params.length + 1}`);
      params.push(filter.kind);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY a.created_at, a.id`;
    return (this.db.query(sql).all(...params) as AssetRow[]).map(mapAsset);
  }

  attachToProject(
    assetId: string,
    projectId: string,
    purpose?: "brief" | "reference" | "generated",
    label?: string,
  ): void {
    const existing = this.db
      .query(`SELECT purpose FROM project_assets WHERE project_id = ?1 AND asset_id = ?2`)
      .get(projectId, assetId) as { purpose: string } | null;
    if (existing) {
      // Re-attach: only explicitly-passed fields win (a duplicate upload must
      // not clobber an earlier 'brief' purpose with the default).
      if (purpose) {
        this.db
          .query(`UPDATE project_assets SET purpose = ?1 WHERE project_id = ?2 AND asset_id = ?3`)
          .run(purpose, projectId, assetId);
      }
      if (label !== undefined) {
        this.db
          .query(`UPDATE project_assets SET label = ?1 WHERE project_id = ?2 AND asset_id = ?3`)
          .run(label, projectId, assetId);
      }
      return;
    }
    this.db
      .query(
        `INSERT INTO project_assets (project_id, asset_id, purpose, label, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .run(projectId, assetId, purpose ?? "reference", label ?? null, new Date().toISOString());
  }

  // -- entities -------------------------------------------------------------

  createEntity(entity: {
    type: EntityType;
    name: string;
    description?: string;
    projectId?: string;
    baseEntityId?: string;
  }): EntityRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO entities (id, project_id, type, name, description, base_entity_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
      )
      .run(id, entity.projectId ?? null, entity.type, entity.name, entity.description ?? "", entity.baseEntityId ?? null, now);
    const record = this.requireEntity(id);
    this.ftsUpsert("entity", id, `${record.name}\n${record.description}`);
    return record;
  }

  updateEntity(id: string, patch: { name?: string; description?: string }): EntityRecord {
    const existing = this.requireEntity(id);
    const name = patch.name ?? existing.name;
    const description = patch.description ?? existing.description;
    this.db
      .query(`UPDATE entities SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4`)
      .run(name, description, new Date().toISOString(), id);
    const record = this.requireEntity(id);
    this.ftsUpsert("entity", id, `${record.name}\n${record.description}`);
    return record;
  }

  linkAssetToEntity(entityId: string, assetId: string, role: "reference" | "voice" | "document" = "reference"): void {
    this.db
      .query(
        `INSERT OR IGNORE INTO entity_assets (entity_id, asset_id, role, added_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .run(entityId, assetId, role, new Date().toISOString());
  }

  listEntities(projectId?: string): EntityWithAssets[] {
    const rows = (
      projectId
        ? this.db
            .query(`SELECT * FROM entities WHERE project_id = ?1 OR project_id IS NULL ORDER BY created_at, id`)
            .all(projectId)
        : this.db.query(`SELECT * FROM entities ORDER BY created_at, id`).all()
    ) as EntityRow[];
    return rows.map((row) => this.withAssets(mapEntity(row)));
  }

  getEntity(id: string): EntityWithAssets | undefined {
    const row = this.db.query(`SELECT * FROM entities WHERE id = ?1`).get(id) as EntityRow | null;
    return row ? this.withAssets(mapEntity(row)) : undefined;
  }

  // -- search + context -----------------------------------------------------

  search(query: string, limit = 20): SearchHit[] {
    // FTS5 MATCH has its own operator syntax; quoting every token keeps user
    // input from ever being parsed as operators (and escapes inner quotes).
    const tokens = query.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
    let rows: Array<{ ref_type: string; ref_id: string; snippet: string; rank: number }>;
    try {
      rows = this.db
        .query(
          `SELECT ref_type, ref_id, snippet(library_fts, 0, '[', ']', '…', 12) AS snippet, rank
           FROM library_fts WHERE library_fts MATCH ?1 ORDER BY rank LIMIT ?2`,
        )
        .all(match, limit) as never;
    } catch {
      return [];
    }
    return rows.map((r) => ({
      refType: r.ref_type as SearchHit["refType"],
      refId: r.ref_id,
      snippet: r.snippet,
      rank: r.rank,
    }));
  }

  getProjectContext(projectId: string): ProjectContext {
    const docRows = this.db
      .query(
        `SELECT a.id AS asset_id, a.original_name, pa.purpose, d.text_content, d.word_count
         FROM project_assets pa
         JOIN assets a ON a.id = pa.asset_id
         JOIN documents d ON d.asset_id = a.id
         WHERE pa.project_id = ?1
         ORDER BY pa.added_at, a.id`,
      )
      .all(projectId) as Array<{
      asset_id: string;
      original_name: string;
      purpose: string;
      text_content: string;
      word_count: number;
    }>;

    const briefs = docRows
      .filter((r) => r.purpose === "brief")
      .map((r) => ({ name: r.original_name, text: r.text_content.slice(0, BRIEF_TEXT_CAP) }));
    const documents = docRows
      .filter((r) => r.purpose !== "brief")
      .map((r) => ({
        name: r.original_name,
        excerpt: r.text_content.slice(0, DOCUMENT_EXCERPT_CAP),
        wordCount: r.word_count,
        assetId: r.asset_id,
      }));

    const uploadedMedia = (
      this.db
        .query(
          `SELECT a.* FROM project_assets pa
           JOIN assets a ON a.id = pa.asset_id
           WHERE pa.project_id = ?1 AND a.source = 'upload' AND a.kind IN ('image','video','audio')
           ORDER BY pa.added_at, a.id`,
        )
        .all(projectId) as AssetRow[]
    ).map((row) => ({
      assetId: row.id,
      kind: row.kind as AssetKind,
      name: row.original_name,
      path: row.storage_path,
    }));

    return { briefs, documents, entities: this.listEntities(projectId), uploadedMedia };
  }

  // -- canvas ---------------------------------------------------------------

  listCanvasItems(projectId: string): CanvasItem[] {
    const rows = this.db
      .query(`SELECT * FROM canvas_items WHERE project_id = ?1 ORDER BY z, created_at, id`)
      .all(projectId) as CanvasItemRow[];
    return rows.map(mapCanvasItem);
  }

  upsertCanvasItem(item: Omit<CanvasItem, "id" | "createdAt"> & { id?: string }): CanvasItem {
    // Match by id when given, else by the (project, refType, refId) unique key
    // — either way an existing row is updated, never duplicated.
    let existing = item.id
      ? (this.db.query(`SELECT * FROM canvas_items WHERE id = ?1`).get(item.id) as CanvasItemRow | null)
      : null;
    existing ??= this.db
      .query(`SELECT * FROM canvas_items WHERE project_id = ?1 AND ref_type = ?2 AND ref_id = ?3`)
      .get(item.projectId, item.refType, item.refId) as CanvasItemRow | null;
    const meta = JSON.stringify(item.meta ?? {});
    if (existing) {
      this.db
        .query(
          `UPDATE canvas_items SET project_id = ?1, ref_type = ?2, ref_id = ?3,
             x = ?4, y = ?5, w = ?6, h = ?7, z = ?8, meta = ?9 WHERE id = ?10`,
        )
        .run(item.projectId, item.refType, item.refId, item.x, item.y, item.w ?? null, item.h ?? null, item.z, meta, existing.id);
      return this.requireCanvasItem(existing.id);
    }
    const id = item.id ?? randomUUID();
    this.db
      .query(
        `INSERT INTO canvas_items (id, project_id, ref_type, ref_id, x, y, w, h, z, meta, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .run(id, item.projectId, item.refType, item.refId, item.x, item.y, item.w ?? null, item.h ?? null, item.z, meta, new Date().toISOString());
    return this.requireCanvasItem(id);
  }

  moveCanvasItem(id: string, pos: { x: number; y: number; w?: number; h?: number; z?: number }): CanvasItem {
    const existing = this.requireCanvasItem(id);
    this.db
      .query(`UPDATE canvas_items SET x = ?1, y = ?2, w = ?3, h = ?4, z = ?5 WHERE id = ?6`)
      .run(pos.x, pos.y, pos.w ?? existing.w ?? null, pos.h ?? existing.h ?? null, pos.z ?? existing.z, id);
    return this.requireCanvasItem(id);
  }

  removeCanvasItem(id: string): void {
    this.db.query(`DELETE FROM canvas_items WHERE id = ?1`).run(id);
  }

  // -- takes ----------------------------------------------------------------

  addTake(take: Omit<TakeRecord, "id" | "createdAt" | "selected"> & { selected?: boolean }): TakeRecord {
    const id = randomUUID();
    const selected = take.selected ?? false;
    if (selected) {
      this.db
        .query(`UPDATE takes SET selected = 0 WHERE project_id = ?1 AND shot_id = ?2`)
        .run(take.projectId, take.shotId);
    }
    this.db
      .query(
        `INSERT INTO takes (id, project_id, shot_id, asset_id, keyframe_asset_id, prompt, selected, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        id,
        take.projectId,
        take.shotId,
        take.assetId,
        take.keyframeAssetId ?? null,
        take.prompt,
        selected ? 1 : 0,
        new Date().toISOString(),
      );
    return this.requireTake(id);
  }

  listTakes(projectId: string, shotId?: string): TakeRecord[] {
    const rows = (
      shotId
        ? this.db
            .query(`SELECT * FROM takes WHERE project_id = ?1 AND shot_id = ?2 ORDER BY created_at, id`)
            .all(projectId, shotId)
        : this.db.query(`SELECT * FROM takes WHERE project_id = ?1 ORDER BY created_at, id`).all(projectId)
    ) as TakeRow[];
    return rows.map(mapTake);
  }

  selectTake(takeId: string): TakeRecord {
    const take = this.requireTake(takeId);
    this.db
      .query(`UPDATE takes SET selected = 0 WHERE project_id = ?1 AND shot_id = ?2`)
      .run(take.projectId, take.shotId);
    this.db.query(`UPDATE takes SET selected = 1 WHERE id = ?1`).run(takeId);
    return this.requireTake(takeId);
  }

  // -- internals ------------------------------------------------------------

  private assetBySha(sha256: string): AssetRecord | undefined {
    const row = this.db.query(`SELECT * FROM assets WHERE sha256 = ?1`).get(sha256) as AssetRow | null;
    return row ? mapAsset(row) : undefined;
  }

  private requireAsset(id: string): AssetRecord {
    const asset = this.getAsset(id);
    if (!asset) throw new Error(`Asset not found: ${id}`);
    return asset;
  }

  private requireEntity(id: string): EntityRecord {
    const row = this.db.query(`SELECT * FROM entities WHERE id = ?1`).get(id) as EntityRow | null;
    if (!row) throw new Error(`Entity not found: ${id}`);
    return mapEntity(row);
  }

  private requireCanvasItem(id: string): CanvasItem {
    const row = this.db.query(`SELECT * FROM canvas_items WHERE id = ?1`).get(id) as CanvasItemRow | null;
    if (!row) throw new Error(`Canvas item not found: ${id}`);
    return mapCanvasItem(row);
  }

  private requireTake(id: string): TakeRecord {
    const row = this.db.query(`SELECT * FROM takes WHERE id = ?1`).get(id) as TakeRow | null;
    if (!row) throw new Error(`Take not found: ${id}`);
    return mapTake(row);
  }

  private withAssets(entity: EntityRecord): EntityWithAssets {
    const rows = this.db
      .query(
        `SELECT ea.role, a.id AS asset_id, a.storage_path
         FROM entity_assets ea JOIN assets a ON a.id = ea.asset_id
         WHERE ea.entity_id = ?1 ORDER BY ea.added_at, a.id`,
      )
      .all(entity.id) as Array<{ role: string; asset_id: string; storage_path: string }>;
    return {
      ...entity,
      referenceImagePaths: rows.filter((r) => r.role === "reference").map((r) => r.storage_path),
      voicePaths: rows.filter((r) => r.role === "voice").map((r) => r.storage_path),
      documentAssetIds: rows.filter((r) => r.role === "document").map((r) => r.asset_id),
    };
  }

  /** Replace the FTS row(s) for a ref; empty content just clears them. */
  private ftsUpsert(refType: "asset" | "entity", refId: string, content: string): void {
    this.db.query(`DELETE FROM library_fts WHERE ref_type = ?1 AND ref_id = ?2`).run(refType, refId);
    if (content.trim().length > 0) {
      this.db
        .query(`INSERT INTO library_fts (content, ref_type, ref_id) VALUES (?1, ?2, ?3)`)
        .run(content, refType, refId);
    }
  }

  /** Grid auto-position; no-op when the ref already sits on this canvas. */
  private autoPlaceOnCanvas(projectId: string, refType: "asset" | "entity", refId: string): void {
    const existing = this.db
      .query(`SELECT id FROM canvas_items WHERE project_id = ?1 AND ref_type = ?2 AND ref_id = ?3`)
      .get(projectId, refType, refId);
    if (existing) return;
    const { n } = this.db
      .query(`SELECT COUNT(*) AS n FROM canvas_items WHERE project_id = ?1`)
      .get(projectId) as { n: number };
    const size = CANVAS_SIZE[refType];
    this.upsertCanvasItem({
      projectId,
      refType,
      refId,
      x: GRID.originX + GRID.stepX * (n % GRID.columns),
      y: GRID.originY + GRID.stepY * Math.floor(n / GRID.columns),
      w: size.w,
      h: size.h,
      z: 0,
      meta: {},
    });
  }

  private librarianOps(): LibrarianOps {
    return {
      findEntity: (name, type, projectId) => {
        if (projectId) {
          const row = this.db
            .query(
              `SELECT * FROM entities WHERE project_id = ?1 AND type = ?2 AND name = ?3 COLLATE NOCASE
               ORDER BY created_at LIMIT 1`,
            )
            .get(projectId, type, name) as EntityRow | null;
          if (row) return mapEntity(row);
        }
        const row = this.db
          .query(
            `SELECT * FROM entities WHERE project_id IS NULL AND type = ?1 AND name = ?2 COLLATE NOCASE
             ORDER BY created_at LIMIT 1`,
          )
          .get(type, name) as EntityRow | null;
        return row ? mapEntity(row) : undefined;
      },
      createEntity: (entity) => this.createEntity(entity),
      updateEntityDescription: (id, description) => {
        this.updateEntity(id, { description });
      },
      linkAssetToEntity: (entityId, assetId, role) => this.linkAssetToEntity(entityId, assetId, role),
      markProjectAssetPurpose: (projectId, assetId, purpose) =>
        this.attachToProject(assetId, projectId, purpose),
    };
  }
}
