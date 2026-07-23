/**
 * Library contract — storage-backed asset/reference system, separate from
 * STAGES. Implementations MUST keep these shapes; the agent runtime, server,
 * and web UI bind to them.
 */

export type AssetKind = "image" | "video" | "audio" | "document";
export type EntityType =
  | "character"
  | "location"
  | "scene"
  | "style"
  | "prop"
  | "voice"
  | "brief"
  | "other";

export interface AssetRecord {
  id: string;
  sha256: string;
  kind: AssetKind;
  mime: string;
  ext: string;
  originalName: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSec?: number;
  storagePath: string;
  source: "upload" | "generated";
  createdAt: string;
}

export interface DocumentRecord {
  assetId: string;
  textContent: string;
  extractionMethod: "plain" | "textutil" | "unzip-xml" | "pdftotext" | "none";
  wordCount: number;
}

export interface EntityRecord {
  id: string;
  projectId?: string;
  type: EntityType;
  name: string;
  description: string;
  baseEntityId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntityWithAssets extends EntityRecord {
  referenceImagePaths: string[];
  voicePaths: string[];
  documentAssetIds: string[];
}

export interface CanvasItem {
  id: string;
  projectId: string;
  refType: "asset" | "entity" | "shot" | "note";
  refId: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  z: number;
  /** JSON meta: notes carry {text, color}; shots carry {shotId}. */
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface TakeRecord {
  id: string;
  projectId: string;
  shotId: string;
  assetId: string;
  keyframeAssetId?: string;
  prompt: string;
  selected: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------

export interface IngestInput {
  /** Absolute path OR raw bytes. */
  data: string | Uint8Array;
  originalName: string;
}

export interface IngestOptions {
  projectId?: string;
  purpose?: "brief" | "reference" | "generated";
  label?: string;
  /** Run the librarian organization step (default true for uploads). */
  organize?: boolean;
}

export interface OrganizationResult {
  /** Chat-facing one-liner: what the librarian did with this file. */
  summary: string;
  linkedEntities: { entityId: string; name: string; type: EntityType; created: boolean }[];
}

export interface IngestResult {
  asset: AssetRecord;
  document?: DocumentRecord;
  organization?: OrganizationResult;
  /** True when sha256 matched an existing asset (deduped). */
  duplicate: boolean;
}

export interface SearchHit {
  refType: "asset" | "entity";
  refId: string;
  snippet: string;
  rank: number;
}

/** Structured bundle handed to the planner/director as grounding context. */
export interface ProjectContext {
  briefs: { name: string; text: string }[];
  documents: { name: string; excerpt: string; wordCount: number; assetId: string }[];
  entities: EntityWithAssets[];
  uploadedMedia: { assetId: string; kind: AssetKind; name: string; path: string }[];
}

// ---------------------------------------------------------------------------

export interface Library {
  ingest(input: IngestInput, opts?: IngestOptions): Promise<IngestResult>;

  getAsset(id: string): AssetRecord | undefined;
  getDocument(assetId: string): DocumentRecord | undefined;
  listAssets(filter?: { projectId?: string; kind?: AssetKind }): AssetRecord[];
  attachToProject(assetId: string, projectId: string, purpose?: "brief" | "reference" | "generated", label?: string): void;

  createEntity(entity: {
    type: EntityType;
    name: string;
    description?: string;
    projectId?: string;
    baseEntityId?: string;
  }): EntityRecord;
  updateEntity(id: string, patch: { name?: string; description?: string }): EntityRecord;
  linkAssetToEntity(entityId: string, assetId: string, role?: "reference" | "voice" | "document"): void;
  listEntities(projectId?: string): EntityWithAssets[];
  getEntity(id: string): EntityWithAssets | undefined;

  search(query: string, limit?: number): SearchHit[];
  getProjectContext(projectId: string): ProjectContext;

  // Canvas
  listCanvasItems(projectId: string): CanvasItem[];
  upsertCanvasItem(item: Omit<CanvasItem, "id" | "createdAt"> & { id?: string }): CanvasItem;
  moveCanvasItem(id: string, pos: { x: number; y: number; w?: number; h?: number; z?: number }): CanvasItem;
  removeCanvasItem(id: string): void;

  // Takes
  addTake(take: Omit<TakeRecord, "id" | "createdAt" | "selected"> & { selected?: boolean }): TakeRecord;
  listTakes(projectId: string, shotId?: string): TakeRecord[];
  selectTake(takeId: string): TakeRecord;

  /** Underlying root dir (for serving files: storagePath is inside it). */
  readonly rootDir: string;
  close(): void;
}

export interface CreateLibraryOptions {
  /** Defaults to <cwd>/.vdx — db at .vdx/library.db, blobs at .vdx/library/ */
  rootDir?: string;
}
