/**
 * The command catalog — the frozen agent-facing contract.
 *
 * Every mutation of a project goes through one of these commands, whether it
 * originates from the human UI, the agent's MCP tools, or agent-generated
 * scripts. One schema, three bindings (per the VDX2 blueprint §2).
 *
 * Commands are validated with zod. `commandCatalog` exposes name +
 * description + schema so the MCP server and the Claude tool definitions are
 * generated from the same source of truth.
 */

import { z } from "zod";

// -- shared fragments -------------------------------------------------------

const zTicks = z.number().int().describe("Time in MediaTime ticks (120000 ticks = 1 second)");
const zTicksNonNeg = zTicks.refine((v) => v >= 0, "must be >= 0");

const zFrameRate = z.object({
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive(),
});

const zTransform = z.object({
  x: z.number(),
  y: z.number(),
  scale: z.number().positive(),
  rotation: z.number(),
});

const zProvenance = z.object({
  kind: z.enum(["generated", "uploaded", "mock"]),
  prompt: z.string().optional(),
  model: z.string().optional(),
  seed: z.number().optional(),
  entityIds: z.array(z.string()).optional(),
  parentAssetId: z.string().optional(),
  costUsd: z.number().optional(),
  generatedAt: z.string().optional(),
});

const zElementBase = {
  name: z.string(),
  startTime: zTicksNonNeg,
  duration: zTicks.refine((v) => v > 0, "duration must be > 0"),
  trimStart: zTicksNonNeg.default(0),
  trimEnd: zTicksNonNeg.default(0),
  sourceDuration: zTicksNonNeg.optional(),
  userModified: z.boolean().optional(),
  provenance: zProvenance.optional(),
};

const zCreateVideoElement = z.object({
  type: z.literal("video"),
  ...zElementBase,
  mediaId: z.string(),
  transform: zTransform.default({ x: 0, y: 0, scale: 1, rotation: 0 }),
  opacity: z.number().min(0).max(1).default(1),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().optional(),
  rate: z.number().positive().optional(),
});

const zCreateImageElement = z.object({
  type: z.literal("image"),
  ...zElementBase,
  mediaId: z.string(),
  transform: zTransform.default({ x: 0, y: 0, scale: 1, rotation: 0 }),
  opacity: z.number().min(0).max(1).default(1),
});

const zCreateAudioElement = z.object({
  type: z.literal("audio"),
  ...zElementBase,
  mediaId: z.string(),
  volume: z.number().min(0).max(2).default(1),
  muted: z.boolean().optional(),
  fadeIn: zTicksNonNeg.optional(),
  fadeOut: zTicksNonNeg.optional(),
});

const zCreateTextElement = z.object({
  type: z.literal("text"),
  ...zElementBase,
  content: z.string(),
  fontSize: z.number().positive().default(64),
  fontFamily: z.string().default("Helvetica"),
  color: z.string().default("#FFFFFF"),
  backgroundColor: z.string().optional(),
  textAlign: z.enum(["left", "center", "right"]).default("center"),
  transform: zTransform.default({ x: 0, y: 0, scale: 1, rotation: 0 }),
  opacity: z.number().min(0).max(1).default(1),
});

export const zCreateElement = z.discriminatedUnion("type", [
  zCreateVideoElement,
  zCreateImageElement,
  zCreateAudioElement,
  zCreateTextElement,
]);

const zElementRef = z.object({ trackId: z.string(), elementId: z.string() });

const zPlacement = z.union([
  z.object({ mode: z.literal("explicit"), trackId: z.string() }),
  z.object({
    mode: z.literal("auto"),
    trackKind: z.enum(["main", "overlay", "audio"]).optional(),
  }),
]);

// -- command params ---------------------------------------------------------

export const commandSchemas = {
  create_project: z.object({
    name: z.string(),
    fps: zFrameRate.default({ numerator: 30, denominator: 1 }),
    width: z.number().int().positive().default(1920),
    height: z.number().int().positive().default(1080),
    backgroundColor: z.string().default("#000000"),
  }),

  update_project_settings: z.object({
    fps: zFrameRate.optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    backgroundColor: z.string().optional(),
    name: z.string().optional(),
  }),

  create_scene: z.object({
    name: z.string(),
    isMain: z.boolean().default(false),
  }),

  rename_scene: z.object({ sceneId: z.string(), name: z.string() }),

  delete_scene: z.object({ sceneId: z.string() }),

  add_track: z.object({
    sceneId: z.string(),
    kind: z.enum(["overlay", "audio"]),
    trackType: z.enum(["video", "text", "audio"]),
    name: z.string().optional(),
    /** Index within the overlay/audio list; appended when omitted. */
    index: z.number().int().min(0).optional(),
  }),

  remove_track: z.object({ sceneId: z.string(), trackId: z.string() }),

  set_track_muted: z.object({ sceneId: z.string(), trackId: z.string(), muted: z.boolean() }),

  set_track_hidden: z.object({ sceneId: z.string(), trackId: z.string(), hidden: z.boolean() }),

  insert_element: z.object({
    sceneId: z.string(),
    element: zCreateElement,
    placement: zPlacement.default({ mode: "auto" }),
  }),

  update_element: z.object({
    sceneId: z.string(),
    ref: zElementRef,
    /** Partial patch of element fields; type/id cannot change. */
    patch: z.record(z.string(), z.unknown()),
    /** Set true when a human made this edit (marks userModified). */
    byUser: z.boolean().default(false),
  }),

  move_elements: z.object({
    sceneId: z.string(),
    moves: z.array(
      z.object({
        ref: zElementRef,
        startTime: zTicksNonNeg,
        /** Move to a different (compatible) track when provided. */
        toTrackId: z.string().optional(),
      }),
    ),
  }),

  split_element: z.object({
    sceneId: z.string(),
    ref: zElementRef,
    /** Timeline time at which to split; must fall inside the element. */
    atTime: zTicksNonNeg,
  }),

  delete_elements: z.object({
    sceneId: z.string(),
    refs: z.array(zElementRef).min(1),
  }),

  retime_element: z.object({
    sceneId: z.string(),
    ref: zElementRef,
    rate: z.number().positive().describe("Playback rate; 2 = twice as fast"),
  }),

  add_media_asset: z.object({
    asset: z.object({
      id: z.string().optional(),
      type: z.enum(["video", "image", "audio"]),
      name: z.string(),
      src: z.string(),
      duration: zTicksNonNeg.optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      fps: z.number().optional(),
      provenance: zProvenance,
    }),
  }),

  remove_media_asset: z.object({ assetId: z.string() }),
} as const;

export type CommandName = keyof typeof commandSchemas;

export type CommandParams<N extends CommandName> = z.infer<(typeof commandSchemas)[N]>;

export interface Command<N extends CommandName = CommandName> {
  type: N;
  params: CommandParams<N>;
}

export const commandDescriptions: Record<CommandName, string> = {
  create_project: "Create a new project with canvas settings and a main scene.",
  update_project_settings: "Update project fps, canvas size, background color, or name.",
  create_scene: "Add a scene to the project.",
  rename_scene: "Rename a scene.",
  delete_scene: "Delete a scene (the last remaining scene cannot be deleted).",
  add_track: "Add an overlay (video/text) or audio track to a scene.",
  remove_track: "Remove a track and all its elements (main track cannot be removed).",
  set_track_muted: "Mute or unmute a video/audio track.",
  set_track_hidden: "Hide or show an overlay/main track.",
  insert_element:
    "Insert a video/image/audio/text element onto a track. Auto placement finds or creates a compatible track without overlaps.",
  update_element:
    "Patch fields of an element (timing, transform, volume, text content, ...). Refuses to modify user-edited elements unless byUser is set.",
  move_elements: "Move one or more elements to new start times and optionally other tracks.",
  split_element: "Split an element at a timeline position into two elements.",
  delete_elements: "Delete elements from the timeline.",
  retime_element: "Change playback rate of a video/audio element (duration adjusts).",
  add_media_asset: "Register a media file (with provenance) in the project bin.",
  remove_media_asset: "Remove a media asset from the bin (fails if referenced by elements).",
};

/** name → {description, schema} for MCP tool + Claude tool generation. */
export const commandCatalog = (Object.keys(commandSchemas) as CommandName[]).map((name) => ({
  name,
  description: commandDescriptions[name],
  schema: commandSchemas[name],
}));

export function parseCommand(input: unknown): Command {
  const shape = z
    .object({ type: z.string(), params: z.unknown() })
    .parse(input);
  const name = shape.type as CommandName;
  const schema = commandSchemas[name];
  if (!schema) throw new Error(`Unknown command type: ${shape.type}`);
  return { type: name, params: schema.parse(shape.params ?? {}) } as Command;
}
