/**
 * Offline test doubles shared by the agent suites: a Gateway that writes tiny
 * stub files (no network, no ffmpeg) and an in-memory Library that records
 * every call. Only TYPES come from @vdx/library — the real implementation
 * lands in parallel and must never be imported here.
 */

import * as path from "node:path";
import type { Gateway, GenerationRequest, GenerationResult } from "@vdx/gateway";
import type {
  AssetKind,
  AssetRecord,
  CanvasItem,
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
} from "@vdx/library";

/** Overshoot per video clip, exercising the trim-to-shot-duration path. */
export const CLIP_OVERSHOOT_SEC = 0.25;

export class FakeGateway implements Gateway {
  private counter = 0;
  readonly requests: GenerationRequest[] = [];

  constructor(private readonly dir: string) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(request);
    const ext = request.kind === "image" ? "png" : request.kind === "video" ? "mp4" : "wav";
    const filePath = path.join(this.dir, `${request.kind}-${++this.counter}.${ext}`);
    await Bun.write(filePath, `stub ${request.kind} media`);

    let durationSec: number | undefined;
    if (request.kind === "video") durationSec = request.durationSec + CLIP_OVERSHOOT_SEC;
    else if (request.kind === "music") durationSec = request.durationSec;
    else if (request.kind === "speech") {
      durationSec = request.text.trim().split(/\s+/).length / 2.5;
    }

    return {
      path: filePath,
      durationSec,
      width: "width" in request ? request.width : undefined,
      height: "height" in request ? request.height : undefined,
      model: `mock/fake-${request.kind}`,
      costUsd: 0,
      cached: false,
    };
  }

  totalCostUsd(): number {
    return 0;
  }

  isLive(): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------

interface FakeEntity extends EntityRecord {
  referenceAssetIds: string[];
  voiceAssetIds: string[];
  documentAssetIds: string[];
}

function kindFor(originalName: string): AssetKind {
  const ext = path.extname(originalName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if ([".wav", ".mp3", ".m4a", ".aac", ".flac"].includes(ext)) return "audio";
  return "document";
}

/** In-memory Library double: records ingests/takes/canvas ops for assertions. */
export class FakeLibrary implements Library {
  readonly rootDir: string;
  readonly assets: AssetRecord[] = [];
  readonly canvasItems: CanvasItem[] = [];
  readonly takes: TakeRecord[] = [];
  readonly ingestCalls: { input: IngestInput; opts?: IngestOptions }[] = [];
  readonly links: { entityId: string; assetId: string; role?: string }[] = [];
  private readonly entities: FakeEntity[] = [];
  private counter = 0;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.counter}`;
  }

  async ingest(input: IngestInput, opts?: IngestOptions): Promise<IngestResult> {
    this.ingestCalls.push({ input, ...(opts ? { opts } : {}) });
    const kind = kindFor(input.originalName);
    const asset: AssetRecord = {
      id: this.nextId("lib-asset"),
      sha256: this.nextId("sha"),
      kind,
      mime: `${kind}/*`,
      ext: path.extname(input.originalName).slice(1),
      originalName: input.originalName,
      sizeBytes: 16,
      storagePath:
        typeof input.data === "string" ? input.data : path.join(this.rootDir, input.originalName),
      source: opts?.purpose === "generated" ? "generated" : "upload",
      createdAt: new Date().toISOString(),
    };
    this.assets.push(asset);
    return { asset, duplicate: false };
  }

  getAsset(id: string): AssetRecord | undefined {
    return this.assets.find((a) => a.id === id);
  }

  getDocument(_assetId: string): DocumentRecord | undefined {
    return undefined;
  }

  listAssets(filter?: { projectId?: string; kind?: AssetKind }): AssetRecord[] {
    return this.assets.filter((a) => !filter?.kind || a.kind === filter.kind);
  }

  attachToProject(): void {}

  createEntity(entity: {
    type: EntityType;
    name: string;
    description?: string;
    projectId?: string;
    baseEntityId?: string;
  }): EntityRecord {
    const now = new Date().toISOString();
    const record: FakeEntity = {
      id: this.nextId("lib-ent"),
      type: entity.type,
      name: entity.name,
      description: entity.description ?? "",
      ...(entity.projectId !== undefined ? { projectId: entity.projectId } : {}),
      ...(entity.baseEntityId !== undefined ? { baseEntityId: entity.baseEntityId } : {}),
      createdAt: now,
      updatedAt: now,
      referenceAssetIds: [],
      voiceAssetIds: [],
      documentAssetIds: [],
    };
    this.entities.push(record);
    return { ...record };
  }

  updateEntity(id: string, patch: { name?: string; description?: string }): EntityRecord {
    const record = this.entities.find((e) => e.id === id);
    if (!record) throw new Error(`Entity not found: ${id}`);
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.description !== undefined) record.description = patch.description;
    record.updatedAt = new Date().toISOString();
    return { ...record };
  }

  linkAssetToEntity(entityId: string, assetId: string, role?: "reference" | "voice" | "document"): void {
    const record = this.entities.find((e) => e.id === entityId);
    if (!record) throw new Error(`Entity not found: ${entityId}`);
    this.links.push({ entityId, assetId, ...(role !== undefined ? { role } : {}) });
    const bucket =
      role === "voice"
        ? record.voiceAssetIds
        : role === "document"
          ? record.documentAssetIds
          : record.referenceAssetIds;
    if (!bucket.includes(assetId)) bucket.push(assetId);
  }

  private withAssets(record: FakeEntity): EntityWithAssets {
    const paths = (ids: string[]) =>
      ids.map((id) => this.getAsset(id)?.storagePath).filter((p): p is string => p !== undefined);
    const { referenceAssetIds, voiceAssetIds, documentAssetIds, ...base } = record;
    return {
      ...base,
      referenceImagePaths: paths(referenceAssetIds),
      voicePaths: paths(voiceAssetIds),
      documentAssetIds: [...documentAssetIds],
    };
  }

  listEntities(projectId?: string): EntityWithAssets[] {
    return this.entities
      .filter((e) => projectId === undefined || e.projectId === projectId)
      .map((e) => this.withAssets(e));
  }

  getEntity(id: string): EntityWithAssets | undefined {
    const record = this.entities.find((e) => e.id === id);
    return record ? this.withAssets(record) : undefined;
  }

  search(_query: string, _limit?: number): SearchHit[] {
    return [];
  }

  getProjectContext(projectId: string): ProjectContext {
    return { briefs: [], documents: [], entities: this.listEntities(projectId), uploadedMedia: [] };
  }

  listCanvasItems(projectId: string): CanvasItem[] {
    return this.canvasItems.filter((c) => c.projectId === projectId);
  }

  upsertCanvasItem(item: Omit<CanvasItem, "id" | "createdAt"> & { id?: string }): CanvasItem {
    const existing = item.id ? this.canvasItems.find((c) => c.id === item.id) : undefined;
    if (existing) {
      const updated: CanvasItem = { ...existing, ...item, id: existing.id, createdAt: existing.createdAt };
      this.canvasItems[this.canvasItems.indexOf(existing)] = updated;
      return updated;
    }
    const created: CanvasItem = {
      ...item,
      id: item.id ?? this.nextId("canvas"),
      createdAt: new Date().toISOString(),
    };
    this.canvasItems.push(created);
    return created;
  }

  moveCanvasItem(id: string, pos: { x: number; y: number; w?: number; h?: number; z?: number }): CanvasItem {
    const item = this.canvasItems.find((c) => c.id === id);
    if (!item) throw new Error(`Canvas item not found: ${id}`);
    Object.assign(item, pos);
    return item;
  }

  removeCanvasItem(id: string): void {
    const index = this.canvasItems.findIndex((c) => c.id === id);
    if (index >= 0) this.canvasItems.splice(index, 1);
  }

  addTake(take: Omit<TakeRecord, "id" | "createdAt" | "selected"> & { selected?: boolean }): TakeRecord {
    const selected = take.selected ?? false;
    if (selected) {
      for (const t of this.takes) {
        if (t.projectId === take.projectId && t.shotId === take.shotId) t.selected = false;
      }
    }
    const record: TakeRecord = {
      ...take,
      id: this.nextId("take"),
      selected,
      createdAt: new Date().toISOString(),
    };
    this.takes.push(record);
    return record;
  }

  listTakes(projectId: string, shotId?: string): TakeRecord[] {
    return this.takes.filter(
      (t) => t.projectId === projectId && (shotId === undefined || t.shotId === shotId),
    );
  }

  selectTake(takeId: string): TakeRecord {
    const take = this.takes.find((t) => t.id === takeId);
    if (!take) throw new Error(`Take not found: ${takeId}`);
    for (const t of this.takes) {
      if (t.projectId === take.projectId && t.shotId === take.shotId) t.selected = false;
    }
    take.selected = true;
    return take;
  }

  close(): void {}
}
