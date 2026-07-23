/**
 * VDX timeline data model — the agent-facing contract.
 *
 * Structure follows OpenCut classic (`apps/web/src/timeline/types.ts` at
 * b3d35fbc^): a project holds scenes; a scene holds SceneTracks with one
 * privileged `main` video track, `overlay` tracks above it, and `audio`
 * tracks below. Elements are a discriminated union on `type`, all times in
 * MediaTime ticks.
 *
 * Agent-native additions over classic: per-element `provenance` (prompt,
 * model, seed, entity refs, cost, parent take), `userModified` (the
 * never-clobber-user-state flag), and project-level `mediaAssets`.
 */

import type { FrameRate, MediaTime } from "./time";

// ---------------------------------------------------------------------------
// Media assets
// ---------------------------------------------------------------------------

export type MediaType = "video" | "image" | "audio";

export interface Provenance {
  kind: "generated" | "uploaded" | "mock";
  prompt?: string;
  model?: string;
  seed?: number;
  /** Entity bank ids this generation was conditioned on. */
  entityIds?: string[];
  /** Take lineage: the asset this one is an alternative/refinement of. */
  parentAssetId?: string;
  costUsd?: number;
  generatedAt?: string; // ISO 8601
}

export interface MediaAsset {
  id: string;
  type: MediaType;
  name: string;
  /** Absolute path or URL to the media file. */
  src: string;
  duration?: MediaTime;
  width?: number;
  height?: number;
  fps?: number;
  provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

export interface Transform {
  /** Pixel offset from canvas center. */
  x: number;
  y: number;
  scale: number;
  rotation: number; // degrees
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0 };

interface BaseElement {
  id: string;
  name: string;
  /** Timeline placement. */
  startTime: MediaTime;
  /** Visible duration on the timeline (post-trim). */
  duration: MediaTime;
  /** Trim from the head of the source. */
  trimStart: MediaTime;
  /** Trim from the tail of the source. */
  trimEnd: MediaTime;
  /** Full duration of the underlying source, when known. */
  sourceDuration?: MediaTime;
  /** True once a human has hand-edited this element. Agents must diff-and-ask
   *  before mutating anything with this flag set. */
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
  /** Playback rate; 1 = realtime. */
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
  /** Simple fade handles, in ticks. */
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

export type CreateElement =
  | Omit<VideoElement, "id">
  | Omit<ImageElement, "id">
  | Omit<AudioElement, "id">
  | Omit<TextElement, "id">;

// ---------------------------------------------------------------------------
// Tracks & scenes
// ---------------------------------------------------------------------------

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
  /** Overlay tracks render above main, listed top-first. */
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

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

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

export interface ElementRef {
  trackId: string;
  elementId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function elementEnd(el: TimelineElement): MediaTime {
  return el.startTime + el.duration;
}

export function canElementGoOnTrack(elementType: ElementType, track: TimelineTrack): boolean {
  switch (track.type) {
    case "video":
      return elementType === "video" || elementType === "image";
    case "text":
      return elementType === "text";
    case "audio":
      return elementType === "audio";
  }
}

/** Duration of a scene = latest element end across all tracks. */
export function sceneDuration(scene: TScene): MediaTime {
  let end = 0;
  const tracks: TimelineTrack[] = [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio];
  for (const track of tracks) {
    for (const el of track.elements) end = Math.max(end, elementEnd(el));
  }
  return end;
}

export function projectDuration(project: TProject): MediaTime {
  return project.scenes.reduce((sum, s) => sum + sceneDuration(s), 0);
}

export function findTrack(tracks: SceneTracks, trackId: string): TimelineTrack | undefined {
  if (tracks.main.id === trackId) return tracks.main;
  return (
    tracks.overlay.find((t) => t.id === trackId) ?? tracks.audio.find((t) => t.id === trackId)
  );
}

export function findElement(
  tracks: SceneTracks,
  ref: ElementRef,
): { track: TimelineTrack; element: TimelineElement; index: number } | undefined {
  const track = findTrack(tracks, ref.trackId);
  if (!track) return undefined;
  const index = track.elements.findIndex((e) => e.id === ref.elementId);
  if (index < 0) return undefined;
  return { track, element: track.elements[index] as TimelineElement, index };
}
