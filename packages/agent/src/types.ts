/**
 * Agent runtime contract — pinned so the server can bind to it while the
 * implementation lands. Implementations MUST keep these shapes.
 */

import type { Gateway } from "@vdx/gateway";
import type { Library, ProjectContext } from "@vdx/library";
import type { ProjectStore } from "@vdx/timeline";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Plan artifacts (brief → treatment → beats → shots), user-reviewable.
// ---------------------------------------------------------------------------

export const zBeat = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  durationSec: z.number().positive(),
});

export const zShot = z.object({
  id: z.string(),
  beatId: z.string(),
  durationSec: z.number().positive(),
  /** Fully self-contained visual prompt (statelessness rule: describe the
   *  scene as if the model has no context of any other shot). */
  visualPrompt: z.string(),
  /** One camera move max (restraint rule); "static" allowed. */
  camera: z.string(),
  /** Voiceover line spoken over this shot, if any. */
  voiceover: z.string().optional(),
  /** On-screen text overlay, if any. */
  textOverlay: z.string().optional(),
  /** Entity ids this shot depends on (characters/locations/styles). */
  entityIds: z.array(z.string()).default([]),
});

export const zPlan = z.object({
  title: z.string(),
  logline: z.string(),
  styleBible: z.string().describe("Global look/style tokens repeated into every shot prompt"),
  beats: z.array(zBeat).min(1),
  shots: z.array(zShot).min(1),
  musicPrompt: z.string(),
  voice: z.string().default("narrator"),
});

export type Beat = z.infer<typeof zBeat>;
export type Shot = z.infer<typeof zShot>;
export type Plan = z.infer<typeof zPlan>;

// ---------------------------------------------------------------------------
// Entity bank (CoTriSyGen-style: typed, evolvable, with lineage)
// ---------------------------------------------------------------------------

export interface Entity {
  id: string;
  type: "character" | "location" | "prop" | "style";
  name: string;
  description: string;
  referenceImages: string[];
  baseEntityId?: string;
  createdAt: string;
}

export interface EntityBank {
  list(): Entity[];
  get(id: string): Entity | undefined;
  upsert(entity: Omit<Entity, "createdAt"> & { createdAt?: string }): Entity;
  addReferenceImage(id: string, path: string): void;
}

// ---------------------------------------------------------------------------
// Director run
// ---------------------------------------------------------------------------

export interface Planner {
  readonly mode: "claude" | "mock";
  plan(brief: string, opts: { targetDurationSec: number; context?: ProjectContext }): Promise<Plan>;
}

/** Reasoning effort for a Claude call — settings-configurable, per-caller. */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type DirectorEvent =
  | { stage: "planning"; message: string }
  | { stage: "plan_ready"; plan: Plan }
  | { stage: "awaiting_approval"; message: string }
  | { stage: "keyframe"; shotId: string; message: string }
  | { stage: "clip"; shotId: string; message: string }
  | { stage: "audio"; message: string }
  | { stage: "assemble"; message: string }
  | { stage: "retake"; shotId: string; message: string }
  | { stage: "done"; message: string }
  | { stage: "error"; message: string };

export interface DirectorRunOptions {
  brief: string;
  targetDurationSec?: number; // default 20
  store: ProjectStore;
  gateway: Gateway;
  planner?: Planner;
  bank?: EntityBank;
  /** Uploaded briefs/docs/entities/media grounding the plan (from @vdx/library). */
  context?: ProjectContext;
  /** Library for registering generated assets + takes + canvas items.
   *  Optional: when absent, the director skips library bookkeeping. */
  library?: Library;
  /** Project id used for library bookkeeping (file id, not metadata.id). */
  libraryProjectId?: string;
  /** Review gate: when provided, the director emits awaiting_approval after
   *  plan_ready and blocks until this resolves (approve) or rejects (abort). */
  waitForApproval?: (plan: Plan) => Promise<void>;
  onEvent?: (event: DirectorEvent) => void;
}

export interface DirectorOutcome {
  plan: Plan;
  /** Chat-facing summary: shots produced, cost, duration. */
  summary: string;
  costUsd: number;
}

export interface RetakeOptions {
  store: ProjectStore;
  gateway: Gateway;
  plan: Plan;
  shotId: string;
  /** Optional user instruction folded into the shot's visual prompt. */
  promptTweak?: string;
  library?: Library;
  libraryProjectId?: string;
  bank?: EntityBank;
  onEvent?: (event: DirectorEvent) => void;
}

export interface RetakeOutcome {
  takeId?: string;
  assetPath: string;
  summary: string;
  costUsd: number;
}
