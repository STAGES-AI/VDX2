/**
 * Local mirrors of the frozen VDX contracts.
 *
 * apps/web does not declare @vdx/timeline or @vdx/agent as dependencies, so
 * the shapes the UI consumes over HTTP are duplicated here as types only.
 * Keep in sync with:
 *   packages/timeline/src/types.ts (TProject and friends)
 *   packages/agent/src/types.ts    (Plan/Beat/Shot, DirectorEvent)
 */

// ---------------------------------------------------------------------------
// Timeline (packages/timeline/src/types.ts)
// ---------------------------------------------------------------------------

/** Integer ticks; 120_000 ticks per second. */
export type MediaTime = number;

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export type MediaType = "video" | "image" | "audio";

export interface Provenance {
  kind: "generated" | "uploaded" | "mock";
  prompt?: string;
  model?: string;
  seed?: number;
  entityIds?: string[];
  parentAssetId?: string;
  costUsd?: number;
  generatedAt?: string;
}

export interface MediaAsset {
  id: string;
  type: MediaType;
  name: string;
  src: string;
  duration?: MediaTime;
  width?: number;
  height?: number;
  fps?: number;
  provenance: Provenance;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

interface BaseElement {
  id: string;
  name: string;
  startTime: MediaTime;
  duration: MediaTime;
  trimStart: MediaTime;
  trimEnd: MediaTime;
  sourceDuration?: MediaTime;
  userModified?: boolean;
  provenance?: Provenance;
}

export interface VideoElement extends BaseElement {
  type: "video";
  mediaId: string;
  transform: Transform;
  opacity: number;
  volume: number;
  muted?: boolean;
  rate?: number;
}

export interface ImageElement extends BaseElement {
  type: "image";
  mediaId: string;
  transform: Transform;
  opacity: number;
}

export interface AudioElement extends BaseElement {
  type: "audio";
  mediaId: string;
  volume: number;
  muted?: boolean;
  fadeIn?: MediaTime;
  fadeOut?: MediaTime;
}

export interface TextElement extends BaseElement {
  type: "text";
  content: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  backgroundColor?: string;
  textAlign: "left" | "center" | "right";
  transform: Transform;
  opacity: number;
}

export type TimelineElement = VideoElement | ImageElement | AudioElement | TextElement;
export type ElementType = TimelineElement["type"];

export interface VideoTrack {
  id: string;
  type: "video";
  name: string;
  elements: (VideoElement | ImageElement)[];
  muted: boolean;
  hidden: boolean;
}

export interface TextTrack {
  id: string;
  type: "text";
  name: string;
  elements: TextElement[];
  hidden: boolean;
}

export interface AudioTrack {
  id: string;
  type: "audio";
  name: string;
  elements: AudioElement[];
  muted: boolean;
}

export type OverlayTrack = VideoTrack | TextTrack;
export type TimelineTrack = VideoTrack | TextTrack | AudioTrack;

export interface SceneTracks {
  overlay: OverlayTrack[];
  main: VideoTrack;
  audio: AudioTrack[];
}

export interface TScene {
  id: string;
  name: string;
  isMain: boolean;
  tracks: SceneTracks;
  createdAt: string;
  updatedAt: string;
}

export type TBackground = { type: "color"; color: string };

export interface TProjectSettings {
  fps: FrameRate;
  canvasSize: { width: number; height: number };
  background: TBackground;
}

export interface TProjectMetadata {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface TProject {
  metadata: TProjectMetadata;
  settings: TProjectSettings;
  scenes: TScene[];
  currentSceneId: string;
  mediaAssets: MediaAsset[];
  version: number;
}

// ---------------------------------------------------------------------------
// Plan (packages/agent/src/types.ts)
// ---------------------------------------------------------------------------

export interface Beat {
  id: string;
  name: string;
  description: string;
  durationSec: number;
}

export interface Shot {
  id: string;
  beatId: string;
  durationSec: number;
  visualPrompt: string;
  camera: string;
  voiceover?: string;
  textOverlay?: string;
  entityIds: string[];
}

export interface Plan {
  title: string;
  logline: string;
  styleBible: string;
  beats: Beat[];
  shots: Shot[];
  musicPrompt: string;
  voice: string;
}

// ---------------------------------------------------------------------------
// Server events (DirectorEvent over SSE, plus render_done on render jobs)
// ---------------------------------------------------------------------------

export type JobEvent =
  | { stage: "planning"; message: string }
  | { stage: "plan_ready"; plan: Plan; message?: string }
  | { stage: "awaiting_approval"; message: string }
  | { stage: "keyframe"; shotId: string; message: string }
  | { stage: "clip"; shotId: string; message: string }
  | { stage: "audio"; message: string }
  | { stage: "assemble"; message: string }
  | { stage: "retake"; shotId: string; message: string }
  | { stage: "render_done"; url: string; message?: string }
  | { stage: "done"; message: string }
  | { stage: "error"; message: string };

// ---------------------------------------------------------------------------
// Library mirrors (packages/library/src/types.ts — HTTP-facing subset)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HTTP API response shapes (agent server at localhost:8790)
// ---------------------------------------------------------------------------

export interface CreateProjectResponse {
  projectId: string;
  jobId: string;
}

/** POST /api/projects request body. */
export interface CreateProjectRequest {
  brief: string;
  targetDurationSec?: number;
  /** Reuse an existing (draft) project instead of creating a new one. */
  projectId?: string;
  /** Pause after plan_ready with awaiting_approval until the job is approved. */
  gate?: boolean;
}

// --- uploads ---------------------------------------------------------------

export interface UploadOrganization {
  summary: string;
  linkedEntities: { entityId: string; name: string; type: EntityType; created: boolean }[];
}

export interface UploadResultItem {
  assetId: string;
  kind: AssetKind;
  name: string;
  url: string;
  sizeBytes: number;
  duplicate: boolean;
  organization: UploadOrganization | null;
}

export interface UploadResponse {
  results: UploadResultItem[];
}

// --- library ---------------------------------------------------------------

export interface LibraryAsset {
  assetId: string;
  kind: AssetKind;
  name: string;
  url: string;
  sizeBytes: number;
  purpose: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export interface LibraryEntity {
  id: string;
  type: EntityType;
  name: string;
  description: string;
  referenceImageUrls: string[];
  voiceUrls: string[];
}

export interface LibraryResponse {
  assets: LibraryAsset[];
  entities: LibraryEntity[];
}

// --- canvas ----------------------------------------------------------------

export type CanvasRefType = "asset" | "entity" | "shot" | "note";

export interface CanvasAssetPayload {
  name: string;
  kind: AssetKind;
  url: string;
}

export interface CanvasEntityPayload {
  name: string;
  type: EntityType;
  referenceImageUrls: string[];
}

export interface CanvasShotPayload {
  shotId: string;
  label: string;
  keyframeUrl?: string;
  clipUrl?: string;
}

export interface CanvasNotePayload {
  text: string;
}

export type CanvasPayload =
  | CanvasAssetPayload
  | CanvasEntityPayload
  | CanvasShotPayload
  | CanvasNotePayload;

export interface CanvasItemView {
  id: string;
  refType: CanvasRefType;
  refId: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  z: number;
  meta: Record<string, unknown>;
  payload: CanvasPayload;
}

export interface CanvasResponse {
  items: CanvasItemView[];
}

// --- takes -----------------------------------------------------------------

export interface TakeInfo {
  id: string;
  shotId: string;
  url: string;
  keyframeUrl?: string;
  prompt: string;
  selected: boolean;
  createdAt: string;
}

export interface TakesResponse {
  takes: TakeInfo[];
}

export interface ProjectListItem {
  id: string;
  name: string;
  updatedAt: string;
}

export interface RenderInfo {
  url: string;
  createdAt: string;
}

export interface ProjectResponse {
  project: TProject;
  plan?: Plan;
  renders: RenderInfo[];
}

export interface EditResponse {
  reply: string;
  applied: string[];
}

// --- settings ----------------------------------------------------------------

export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** GET /api/settings response. */
export interface SettingsResponse {
  anthropicKeySet: boolean;
  anthropicKeyPreview: string | null;
  falKeySet: boolean;
  falKeyPreview: string | null;
  elevenLabsKeySet: boolean;
  elevenLabsKeyPreview: string | null;
  plannerModel: string;
  plannerEffort: ModelEffort;
  editorModel: string;
  editorEffort: ModelEffort;
}

/**
 * PUT /api/settings request body. All fields optional; an omitted field is
 * left unchanged server-side, an empty string clears that API key.
 */
export interface UpdateSettingsRequest {
  anthropicApiKey?: string;
  falApiKey?: string;
  elevenLabsApiKey?: string;
  plannerModel?: string;
  plannerEffort?: ModelEffort;
  editorModel?: string;
  editorEffort?: ModelEffort;
}

// ---------------------------------------------------------------------------
// Chat model (UI-local)
// ---------------------------------------------------------------------------

export type ChatMessage =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "status"; stage: JobEvent["stage"] | "info"; text: string }
  | { id: string; kind: "plan"; plan: Plan }
  | { id: string; kind: "reply"; text: string; applied: string[] }
  | { id: string; kind: "upload"; item: UploadResultItem }
  | { id: string; kind: "error"; text: string };

/** Omit distributed over a union (plain Omit collapses unions). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A chat message before an id is assigned. */
export type ChatMessageInput = DistributiveOmit<ChatMessage, "id">;
