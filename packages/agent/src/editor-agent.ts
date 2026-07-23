/**
 * Editor agent — free-form edit instructions applied to a live ProjectStore.
 *
 * With ANTHROPIC_API_KEY set: a Claude tool-use loop whose tools are
 * generated from the timeline commandCatalog (one schema, three bindings)
 * plus a read_project digest tool. Each timeline tool call is a
 * store.dispatch, so every agent edit shares the same undo stack as human
 * edits.
 *
 * Without a key: a small deterministic instruction set (undo / redo /
 * mute music / faster|tighten) so the demo works fully offline.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AudioTrack, ProjectStore, TimelineTrack, TScene, VideoElement } from "@vdx/timeline";
import { commandCatalog, mt } from "@vdx/timeline";
import { zodToJsonSchema } from "./json-schema";
import type { Effort } from "./types";

const EDITOR_MODEL = "claude-opus-4-8";
const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You are the Editor agent operating a real timeline for a video project.
- Mutate the project ONLY through the provided tools; each tool is a validated timeline command.
- All times are MediaTime ticks: multiply seconds by 120000 (e.g. 2.5s = 300000 ticks, 1 frame at 30fps = 4000 ticks).
- Call read_project first to learn scene ids, track ids, and element ids before editing.
- Prefer minimal, precise edits. When done, reply with a short summary of what you changed.`;

export interface EditResult {
  reply: string;
  applied: string[];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function currentScene(store: ProjectStore): TScene {
  const project = store.getProject();
  const scene = project.scenes.find((s) => s.id === project.currentSceneId);
  if (!scene) throw new Error(`Current scene not found: ${project.currentSceneId}`);
  return scene;
}

/** Compact JSON digest of the project — ids and times in seconds. */
function projectDigest(store: ProjectStore): unknown {
  const project = store.getProject();
  const sec = (ticks: number) => Math.round(mt.toSeconds(ticks) * 1000) / 1000;
  const digestTrack = (track: TimelineTrack, kind: string) => ({
    trackId: track.id,
    kind,
    type: track.type,
    name: track.name,
    elements: track.elements.map((el) => ({
      elementId: el.id,
      type: el.type,
      name: el.name,
      startSec: sec(el.startTime),
      durationSec: sec(el.duration),
      ...("mediaId" in el ? { mediaId: el.mediaId } : {}),
      ...("content" in el ? { content: el.content } : {}),
      ...("volume" in el ? { volume: el.volume } : {}),
      ...("rate" in el && el.rate !== undefined ? { rate: el.rate } : {}),
      ...(el.userModified ? { userModified: true } : {}),
    })),
  });
  return {
    name: project.metadata.name,
    currentSceneId: project.currentSceneId,
    scenes: project.scenes.map((scene) => ({
      sceneId: scene.id,
      name: scene.name,
      tracks: [
        digestTrack(scene.tracks.main, "main"),
        ...scene.tracks.overlay.map((t) => digestTrack(t, "overlay")),
        ...scene.tracks.audio.map((t) => digestTrack(t, "audio")),
      ],
    })),
    mediaAssets: project.mediaAssets.map((asset) => ({
      assetId: asset.id,
      type: asset.type,
      name: asset.name,
      ...(asset.duration !== undefined ? { durationSec: sec(asset.duration) } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Mock (offline) path — deterministic regex handling of common instructions
// ---------------------------------------------------------------------------

function findAudioElement(
  scene: TScene,
  match: RegExp,
): { track: AudioTrack; elementId: string } | undefined {
  for (const track of scene.tracks.audio) {
    for (const el of track.elements) {
      if (match.test(el.name)) return { track, elementId: el.id };
    }
  }
  return undefined;
}

function lastMainVideo(scene: TScene): VideoElement | undefined {
  const videos = scene.tracks.main.elements.filter((el) => el.type === "video");
  if (videos.length === 0) return undefined;
  return videos.reduce((a, b) => (b.startTime >= a.startTime ? b : a)) as VideoElement;
}

function applyMockInstruction(store: ProjectStore, instruction: string): EditResult {
  const lower = instruction.toLowerCase();

  if (/\bundo\b/.test(lower)) {
    const summary = store.undo();
    return summary
      ? { reply: `Undid: ${summary}`, applied: [`undo: ${summary}`] }
      : { reply: "Nothing to undo.", applied: [] };
  }

  if (/\bredo\b/.test(lower)) {
    const summary = store.redo();
    return summary
      ? { reply: `Redid: ${summary}`, applied: [`redo: ${summary}`] }
      : { reply: "Nothing to redo.", applied: [] };
  }

  if (/\bmute\b/.test(lower) && /\bmusic\b/.test(lower)) {
    const scene = currentScene(store);
    const found = findAudioElement(scene, /music/i);
    if (!found) return { reply: "No music element found to mute.", applied: [] };
    const result = store.dispatch({
      type: "update_element",
      params: {
        sceneId: scene.id,
        ref: { trackId: found.track.id, elementId: found.elementId },
        patch: { volume: 0 },
      },
    });
    return { reply: "Muted the music (volume 0).", applied: [result.summary] };
  }

  if (/\bfaster\b|\btighten\b/.test(lower)) {
    const scene = currentScene(store);
    const last = lastMainVideo(scene);
    if (!last) return { reply: "No video element on the main track to retime.", applied: [] };
    const result = store.dispatch({
      type: "retime_element",
      params: {
        sceneId: scene.id,
        ref: { trackId: scene.tracks.main.id, elementId: last.id },
        rate: 1.25,
      },
    });
    return { reply: `Sped up "${last.name}" to 1.25x.`, applied: [result.summary] };
  }

  return {
    reply:
      "Free-form edits need ANTHROPIC_API_KEY. Offline I understand: " +
      "'undo', 'redo', 'mute music', and 'faster'/'tighten'.",
    applied: [],
  };
}

// ---------------------------------------------------------------------------
// Claude tool-use path
// ---------------------------------------------------------------------------

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

function buildTools(): unknown[] {
  return [
    ...commandCatalog.map((command) => ({
      name: command.name,
      description: `${command.description} All times are MediaTime ticks (120000 ticks = 1 second).`,
      input_schema: zodToJsonSchema(command.schema),
    })),
    {
      name: "read_project",
      description:
        "Read a compact JSON digest of the current project: scenes, tracks, and elements " +
        "with their ids and times in seconds, plus the media asset bin.",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

async function applyWithClaude(
  store: ProjectStore,
  instruction: string,
  model: string,
  effort: Effort | undefined,
  apiKey: string | undefined,
): Promise<EditResult> {
  const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  const tools = buildTools();
  const applied: string[] = [];
  const messages: unknown[] = [{ role: "user", content: instruction }];
  let reply = "";

  // Same defensive gating as claude-planner.ts: the installed SDK does not
  // declare `effort` in its request types and there is no live key here to
  // confirm the API accepts it, so it is only sent when explicitly
  // configured away from the "high" default.
  const effortField = effort && effort !== "high" ? { output_config: { effort } } : {};

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = (await (client.messages.create as (params: unknown) => Promise<unknown>)({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages,
      tools,
      ...effortField,
    })) as { content: Array<Record<string, unknown>>; stop_reason?: string };

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("\n")
      .trim();
    if (text) reply = text;

    const toolUses = response.content.filter(
      (block): block is Record<string, unknown> & ToolUseBlock => block.type === "tool_use",
    );
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

    messages.push({ role: "assistant", content: response.content });
    const results = toolUses.map((block) => {
      try {
        if (block.name === "read_project") {
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(projectDigest(store)),
          };
        }
        const result = store.dispatch({ type: block.name, params: block.input });
        applied.push(result.summary);
        return { type: "tool_result", tool_use_id: block.id, content: result.summary };
      } catch (err) {
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
    });
    messages.push({ role: "user", content: results });
  }

  return {
    reply: reply || (applied.length > 0 ? `Applied ${applied.length} edit(s).` : "No changes made."),
    applied,
  };
}

// ---------------------------------------------------------------------------

export async function applyEditInstruction(
  store: ProjectStore,
  instruction: string,
  opts?: { model?: string; effort?: Effort; apiKey?: string },
): Promise<EditResult> {
  const apiKey = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return applyMockInstruction(store, instruction);
  }
  return applyWithClaude(store, instruction, opts?.model ?? EDITOR_MODEL, opts?.effort, apiKey);
}
