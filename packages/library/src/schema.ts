/**
 * VDX Library database schema — SQLite (bun:sqlite), separate from STAGES.
 *
 * Design notes:
 * - Embedded SQLite is the right store for a local-first editor: ACID, zero
 *   ops, FTS5 full-text search built in. The DDL is written conservatively
 *   (TEXT ids, ISO dates, CHECK enums) so it ports 1:1 to Postgres when the
 *   product goes multi-user.
 * - Files are NOT stored as blobs. Storage is content-addressed on disk
 *   (`<libraryDir>/<sha256>.<ext>`); `assets.sha256` is UNIQUE so re-uploads
 *   dedupe to the same row.
 * - `library_fts` indexes extracted document text and entity name/description
 *   for agent recall ("use the neon alley from the March brief").
 */

export const SCHEMA_VERSION = 1;

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('image','video','audio','document')),
  mime          TEXT NOT NULL,
  ext           TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  duration_sec  REAL,
  storage_path  TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload','generated')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  asset_id          TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  text_content      TEXT NOT NULL,
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('plain','textutil','unzip-xml','pdftotext','none')),
  word_count        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  id             TEXT PRIMARY KEY,
  project_id     TEXT,
  type           TEXT NOT NULL CHECK (type IN ('character','location','scene','style','prop','voice','brief','other')),
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  base_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_project ON entities(project_id);

CREATE TABLE IF NOT EXISTS entity_assets (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  asset_id  TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'reference' CHECK (role IN ('reference','voice','document')),
  added_at  TEXT NOT NULL,
  PRIMARY KEY (entity_id, asset_id, role)
);

CREATE TABLE IF NOT EXISTS project_assets (
  project_id TEXT NOT NULL,
  asset_id   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  purpose    TEXT NOT NULL DEFAULT 'reference' CHECK (purpose IN ('brief','reference','generated')),
  label      TEXT,
  added_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_project_assets_project ON project_assets(project_id);

-- Infinite canvas: spatial layout of assets/entities/shots/notes per project.
CREATE TABLE IF NOT EXISTS canvas_items (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  ref_type   TEXT NOT NULL CHECK (ref_type IN ('asset','entity','shot','note')),
  ref_id     TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  w          REAL,
  h          REAL,
  z          INTEGER NOT NULL DEFAULT 0,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (project_id, ref_type, ref_id)
);
CREATE INDEX IF NOT EXISTS idx_canvas_project ON canvas_items(project_id);

-- Take stacks: alternative generations per shot slot.
CREATE TABLE IF NOT EXISTS takes (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  shot_id           TEXT NOT NULL,
  asset_id          TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  keyframe_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  prompt            TEXT NOT NULL DEFAULT '',
  selected          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_takes_shot ON takes(project_id, shot_id);

CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
  content,
  ref_type UNINDEXED,
  ref_id UNINDEXED
);
`;
