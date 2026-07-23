/**
 * ProjectStore — executes commands against a TProject with full undo/redo.
 *
 * Undo strategy follows OpenCut classic's command pattern: snapshot the
 * affected state before mutating (classic snapshotted SceneTracks per
 * command; we snapshot the whole project — cheap at this scale, provably
 * correct). Every apply() pushes an undo entry; agent and human edits share
 * one stack, which is the trust mechanism from the blueprint (§7).
 */

import { randomUUID } from "node:crypto";
import type { Command, CommandName } from "./commands";
import { commandSchemas, parseCommand } from "./commands";
import type {
  AudioTrack,
  CreateElement,
  ElementRef,
  MediaAsset,
  OverlayTrack,
  SceneTracks,
  TimelineElement,
  TimelineTrack,
  TProject,
  TScene,
  VideoTrack,
} from "./types";
import { canElementGoOnTrack, elementEnd, findElement, findTrack } from "./types";

export interface ApplyResult {
  /** Ids created by the command (elementId, sceneId, trackId, assetId...). */
  created?: Record<string, string>;
  /** Human-readable summary for chat narration and logs. */
  summary: string;
}

export interface HistoryEntry {
  command: Command;
  summary: string;
  snapshot: TProject;
  appliedAt: string;
}

export type StoreListener = (event: {
  command: Command;
  result: ApplyResult;
  project: TProject;
}) => void;

const PROJECT_SCHEMA_VERSION = 1;

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function now(): string {
  return new Date().toISOString();
}

function newVideoTrack(name: string): VideoTrack {
  return { id: randomUUID(), type: "video", name, elements: [], muted: false, hidden: false };
}

function newAudioTrack(name: string): AudioTrack {
  return { id: randomUUID(), type: "audio", name, elements: [], muted: false };
}

function newScene(name: string, isMain: boolean): TScene {
  return {
    id: randomUUID(),
    name,
    isMain,
    tracks: { overlay: [], main: newVideoTrack("Main"), audio: [newAudioTrack("Audio 1")] },
    createdAt: now(),
    updatedAt: now(),
  };
}

function overlaps(a: { startTime: number; duration: number }, b: { startTime: number; duration: number }): boolean {
  return a.startTime < b.startTime + b.duration && b.startTime < a.startTime + a.duration;
}

function trackHasRoom(track: TimelineTrack, el: { startTime: number; duration: number }, ignoreId?: string): boolean {
  return !track.elements.some((e) => e.id !== ignoreId && overlaps(e, el));
}

export function createEmptyProject(params: {
  name: string;
  fps: { numerator: number; denominator: number };
  width: number;
  height: number;
  backgroundColor: string;
}): TProject {
  const scene = newScene("Scene 1", true);
  return {
    metadata: { id: randomUUID(), name: params.name, createdAt: now(), updatedAt: now() },
    settings: {
      fps: params.fps,
      canvasSize: { width: params.width, height: params.height },
      background: { type: "color", color: params.backgroundColor },
    },
    scenes: [scene],
    currentSceneId: scene.id,
    mediaAssets: [],
    version: PROJECT_SCHEMA_VERSION,
  };
}

export class ProjectStore {
  private project: TProject;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<StoreListener>();

  constructor(project: TProject) {
    this.project = project;
  }

  static create(params?: Partial<Parameters<typeof createEmptyProject>[0]>): ProjectStore {
    return new ProjectStore(
      createEmptyProject({
        name: params?.name ?? "Untitled",
        fps: params?.fps ?? { numerator: 30, denominator: 1 },
        width: params?.width ?? 1920,
        height: params?.height ?? 1080,
        backgroundColor: params?.backgroundColor ?? "#000000",
      }),
    );
  }

  getProject(): TProject {
    return this.project;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get history(): ReadonlyArray<Pick<HistoryEntry, "command" | "summary" | "appliedAt">> {
    return this.undoStack.map(({ command, summary, appliedAt }) => ({ command, summary, appliedAt }));
  }

  undo(): string | undefined {
    const entry = this.undoStack.pop();
    if (!entry) return undefined;
    this.redoStack.push({ ...entry, snapshot: deepClone(this.project) });
    this.project = entry.snapshot;
    return entry.summary;
  }

  redo(): string | undefined {
    const entry = this.redoStack.pop();
    if (!entry) return undefined;
    this.undoStack.push({ ...entry, snapshot: deepClone(this.project) });
    this.project = entry.snapshot;
    return entry.summary;
  }

  /** Validate + execute a raw {type, params} command. */
  dispatch(input: unknown): ApplyResult {
    return this.apply(parseCommand(input));
  }

  apply(command: Command): ApplyResult {
    const schema = commandSchemas[command.type];
    const params = schema.parse(command.params) as never;
    const snapshot = deepClone(this.project);

    let result: ApplyResult;
    try {
      result = this.execute(command.type, params);
    } catch (err) {
      // Execution may have partially mutated state — roll back.
      this.project = snapshot;
      throw err;
    }

    this.project.metadata.updatedAt = now();
    this.undoStack.push({ command, summary: result.summary, snapshot, appliedAt: now() });
    this.redoStack = [];
    for (const listener of this.listeners) {
      listener({ command, result, project: this.project });
    }
    return result;
  }

  /** Apply a batch atomically: any failure rolls back the whole batch. */
  applyBatch(commands: Command[]): ApplyResult[] {
    const snapshot = deepClone(this.project);
    const undoDepth = this.undoStack.length;
    try {
      return commands.map((c) => this.apply(c));
    } catch (err) {
      this.project = snapshot;
      this.undoStack.length = undoDepth;
      throw err;
    }
  }

  // -------------------------------------------------------------------------

  private execute(type: CommandName, params: any): ApplyResult {
    switch (type) {
      case "create_project": {
        this.project = createEmptyProject({
          name: params.name,
          fps: params.fps,
          width: params.width,
          height: params.height,
          backgroundColor: params.backgroundColor,
        });
        return {
          created: { projectId: this.project.metadata.id, sceneId: this.project.currentSceneId },
          summary: `Created project "${params.name}" (${params.width}x${params.height})`,
        };
      }

      case "update_project_settings": {
        const s = this.project.settings;
        if (params.fps) s.fps = params.fps;
        if (params.width) s.canvasSize.width = params.width;
        if (params.height) s.canvasSize.height = params.height;
        if (params.backgroundColor) s.background = { type: "color", color: params.backgroundColor };
        if (params.name) this.project.metadata.name = params.name;
        return { summary: "Updated project settings" };
      }

      case "create_scene": {
        const scene = newScene(params.name, params.isMain);
        this.project.scenes.push(scene);
        return { created: { sceneId: scene.id }, summary: `Created scene "${params.name}"` };
      }

      case "rename_scene": {
        const scene = this.requireScene(params.sceneId);
        scene.name = params.name;
        return { summary: `Renamed scene to "${params.name}"` };
      }

      case "delete_scene": {
        if (this.project.scenes.length <= 1) throw new Error("Cannot delete the last scene");
        const index = this.project.scenes.findIndex((s) => s.id === params.sceneId);
        if (index < 0) throw new Error(`Scene not found: ${params.sceneId}`);
        const [removed] = this.project.scenes.splice(index, 1);
        if (this.project.currentSceneId === params.sceneId) {
          this.project.currentSceneId = this.project.scenes[0].id;
        }
        return { summary: `Deleted scene "${removed.name}"` };
      }

      case "add_track": {
        const scene = this.requireScene(params.sceneId);
        if (params.kind === "audio") {
          if (params.trackType !== "audio") throw new Error("audio tracks must have trackType audio");
          const track = newAudioTrack(params.name ?? `Audio ${scene.tracks.audio.length + 1}`);
          insertAt(scene.tracks.audio, track, params.index);
          return { created: { trackId: track.id }, summary: `Added audio track "${track.name}"` };
        }
        if (params.trackType === "audio") throw new Error("overlay tracks cannot be audio");
        const track: OverlayTrack =
          params.trackType === "video"
            ? newVideoTrack(params.name ?? `Overlay ${scene.tracks.overlay.length + 1}`)
            : {
                id: randomUUID(),
                type: "text",
                name: params.name ?? `Text ${scene.tracks.overlay.length + 1}`,
                elements: [],
                hidden: false,
              };
        insertAt(scene.tracks.overlay, track, params.index);
        return { created: { trackId: track.id }, summary: `Added ${params.trackType} track "${track.name}"` };
      }

      case "remove_track": {
        const scene = this.requireScene(params.sceneId);
        if (scene.tracks.main.id === params.trackId) throw new Error("Cannot remove the main track");
        const fromOverlay = scene.tracks.overlay.findIndex((t) => t.id === params.trackId);
        if (fromOverlay >= 0) {
          const [t] = scene.tracks.overlay.splice(fromOverlay, 1);
          return { summary: `Removed track "${t.name}"` };
        }
        const fromAudio = scene.tracks.audio.findIndex((t) => t.id === params.trackId);
        if (fromAudio >= 0) {
          const [t] = scene.tracks.audio.splice(fromAudio, 1);
          return { summary: `Removed track "${t.name}"` };
        }
        throw new Error(`Track not found: ${params.trackId}`);
      }

      case "set_track_muted": {
        const scene = this.requireScene(params.sceneId);
        const track = findTrack(scene.tracks, params.trackId);
        if (!track) throw new Error(`Track not found: ${params.trackId}`);
        if (track.type === "text") throw new Error("Text tracks have no audio");
        track.muted = params.muted;
        return { summary: `${params.muted ? "Muted" : "Unmuted"} "${track.name}"` };
      }

      case "set_track_hidden": {
        const scene = this.requireScene(params.sceneId);
        const track = findTrack(scene.tracks, params.trackId);
        if (!track) throw new Error(`Track not found: ${params.trackId}`);
        if (track.type === "audio") throw new Error("Audio tracks cannot be hidden");
        track.hidden = params.hidden;
        return { summary: `${params.hidden ? "Hid" : "Showed"} "${track.name}"` };
      }

      case "insert_element": {
        const scene = this.requireScene(params.sceneId);
        const create = params.element as CreateElement;
        this.validateMediaRef(create);
        const element = { ...create, id: randomUUID() } as TimelineElement;
        const trackId = this.placeElement(scene, element, params.placement);
        scene.updatedAt = now();
        return {
          created: { elementId: element.id, trackId },
          summary: `Inserted ${element.type} "${element.name}" on track ${trackId}`,
        };
      }

      case "update_element": {
        const scene = this.requireScene(params.sceneId);
        const found = findElement(scene.tracks, params.ref as ElementRef);
        if (!found) throw new Error(`Element not found: ${params.ref.elementId}`);
        if (found.element.userModified && !params.byUser) {
          throw new Error(
            `Element "${found.element.name}" was hand-edited by the user (userModified). ` +
              `Agent edits must be proposed for approval instead of applied directly.`,
          );
        }
        const patch = { ...params.patch };
        delete patch.id;
        delete patch.type;
        Object.assign(found.element, patch);
        if (params.byUser) found.element.userModified = true;
        // Timing changes must not create overlaps.
        if ("startTime" in patch || "duration" in patch) {
          if (!trackHasRoom(found.track, found.element, found.element.id)) {
            throw new Error("Update would overlap another element on the track");
          }
        }
        scene.updatedAt = now();
        return { summary: `Updated ${found.element.type} "${found.element.name}"` };
      }

      case "move_elements": {
        const scene = this.requireScene(params.sceneId);
        for (const move of params.moves) {
          const found = findElement(scene.tracks, move.ref);
          if (!found) throw new Error(`Element not found: ${move.ref.elementId}`);
          const target = move.toTrackId ? findTrack(scene.tracks, move.toTrackId) : found.track;
          if (!target) throw new Error(`Track not found: ${move.toTrackId}`);
          if (!canElementGoOnTrack(found.element.type, target)) {
            throw new Error(`${found.element.type} elements cannot go on ${target.type} tracks`);
          }
          const moved = { ...found.element, startTime: move.startTime };
          if (!trackHasRoom(target, moved, found.element.id)) {
            throw new Error(`Move would overlap on track "${target.name}"`);
          }
          found.track.elements.splice(found.index, 1);
          (target.elements as TimelineElement[]).push(moved as never);
          target.elements.sort((a, b) => a.startTime - b.startTime);
        }
        scene.updatedAt = now();
        return { summary: `Moved ${params.moves.length} element(s)` };
      }

      case "split_element": {
        const scene = this.requireScene(params.sceneId);
        const found = findElement(scene.tracks, params.ref);
        if (!found) throw new Error(`Element not found: ${params.ref.elementId}`);
        const el = found.element;
        const at = params.atTime;
        if (at <= el.startTime || at >= elementEnd(el)) {
          throw new Error("Split point must fall strictly inside the element");
        }
        const offset = at - el.startTime;
        const left = { ...el, duration: offset, trimEnd: el.trimEnd + (el.duration - offset) };
        const right = {
          ...deepClone(el),
          id: randomUUID(),
          startTime: at,
          duration: el.duration - offset,
          trimStart: el.trimStart + offset,
          name: `${el.name} (2)`,
        };
        found.track.elements.splice(found.index, 1, left as never, right as never);
        scene.updatedAt = now();
        return {
          created: { rightElementId: right.id },
          summary: `Split "${el.name}" at ${at} ticks`,
        };
      }

      case "delete_elements": {
        const scene = this.requireScene(params.sceneId);
        let count = 0;
        for (const ref of params.refs) {
          const found = findElement(scene.tracks, ref);
          if (!found) throw new Error(`Element not found: ${ref.elementId}`);
          found.track.elements.splice(found.index, 1);
          count++;
        }
        scene.updatedAt = now();
        return { summary: `Deleted ${count} element(s)` };
      }

      case "retime_element": {
        const scene = this.requireScene(params.sceneId);
        const found = findElement(scene.tracks, params.ref);
        if (!found) throw new Error(`Element not found: ${params.ref.elementId}`);
        const el = found.element;
        if (el.type !== "video" && el.type !== "audio") {
          throw new Error("Only video/audio elements can be retimed");
        }
        const prevRate = (el as { rate?: number }).rate ?? 1;
        const newDuration = Math.round((el.duration * prevRate) / params.rate);
        const retimed = { ...el, rate: params.rate, duration: newDuration };
        if (!trackHasRoom(found.track, retimed, el.id)) {
          throw new Error("Retime would overlap another element");
        }
        Object.assign(el, retimed);
        scene.updatedAt = now();
        return { summary: `Retimed "${el.name}" to ${params.rate}x` };
      }

      case "add_media_asset": {
        const asset: MediaAsset = { ...params.asset, id: params.asset.id ?? randomUUID() };
        if (this.project.mediaAssets.some((a) => a.id === asset.id)) {
          throw new Error(`Asset id already exists: ${asset.id}`);
        }
        this.project.mediaAssets.push(asset);
        return { created: { assetId: asset.id }, summary: `Added ${asset.type} asset "${asset.name}"` };
      }

      case "remove_media_asset": {
        const index = this.project.mediaAssets.findIndex((a) => a.id === params.assetId);
        if (index < 0) throw new Error(`Asset not found: ${params.assetId}`);
        const referenced = this.project.scenes.some((scene) =>
          [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio].some((t) =>
            t.elements.some((e) => "mediaId" in e && (e as { mediaId?: string }).mediaId === params.assetId),
          ),
        );
        if (referenced) throw new Error("Asset is referenced by timeline elements");
        const [removed] = this.project.mediaAssets.splice(index, 1);
        return { summary: `Removed asset "${removed.name}"` };
      }
    }
  }

  // -------------------------------------------------------------------------

  private requireScene(sceneId: string): TScene {
    const scene = this.project.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new Error(`Scene not found: ${sceneId}`);
    return scene;
  }

  private validateMediaRef(create: CreateElement): void {
    if ("mediaId" in create) {
      const asset = this.project.mediaAssets.find((a) => a.id === create.mediaId);
      if (!asset) throw new Error(`Unknown mediaId: ${create.mediaId}`);
      const want = create.type === "image" ? "image" : create.type;
      if (asset.type !== want) {
        throw new Error(`Asset "${asset.name}" is ${asset.type}, element wants ${want}`);
      }
    }
  }

  private placeElement(
    scene: TScene,
    element: TimelineElement,
    placement: { mode: "explicit"; trackId: string } | { mode: "auto"; trackKind?: "main" | "overlay" | "audio" },
  ): string {
    if (placement.mode === "explicit") {
      const track = findTrack(scene.tracks, placement.trackId);
      if (!track) throw new Error(`Track not found: ${placement.trackId}`);
      if (!canElementGoOnTrack(element.type, track)) {
        throw new Error(`${element.type} elements cannot go on ${track.type} tracks`);
      }
      if (!trackHasRoom(track, element)) {
        throw new Error(`Overlap on track "${track.name}" at ${element.startTime}`);
      }
      (track.elements as TimelineElement[]).push(element as never);
      track.elements.sort((a, b) => a.startTime - b.startTime);
      return track.id;
    }

    // Auto placement.
    const candidates: TimelineTrack[] = [];
    if (element.type === "audio") {
      candidates.push(...scene.tracks.audio);
    } else if (element.type === "text") {
      candidates.push(...scene.tracks.overlay.filter((t) => t.type === "text"));
    } else if (placement.trackKind === "overlay") {
      candidates.push(...scene.tracks.overlay.filter((t) => t.type === "video"));
    } else {
      candidates.push(scene.tracks.main, ...scene.tracks.overlay.filter((t) => t.type === "video"));
    }

    for (const track of candidates) {
      if (trackHasRoom(track, element)) {
        (track.elements as TimelineElement[]).push(element as never);
        track.elements.sort((a, b) => a.startTime - b.startTime);
        return track.id;
      }
    }

    // No room anywhere compatible — create a track.
    const created = this.execute("add_track", {
      sceneId: scene.id,
      kind: element.type === "audio" ? "audio" : "overlay",
      trackType: element.type === "text" ? "text" : element.type === "audio" ? "audio" : "video",
    });
    const trackId = created.created!.trackId;
    const track = findTrack(scene.tracks, trackId)!;
    (track.elements as TimelineElement[]).push(element as never);
    return trackId;
  }

  // -- serialization --------------------------------------------------------

  serialize(): string {
    return JSON.stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, project: this.project }, null, 2);
  }

  static deserialize(json: string): ProjectStore {
    const data = JSON.parse(json) as { schemaVersion: number; project: TProject };
    if (data.schemaVersion !== PROJECT_SCHEMA_VERSION) {
      throw new Error(`Unsupported project schema version: ${data.schemaVersion}`);
    }
    return new ProjectStore(data.project);
  }
}

function insertAt<T>(arr: T[], item: T, index?: number): void {
  if (index === undefined || index >= arr.length) arr.push(item);
  else arr.splice(Math.max(0, index), 0, item);
}
