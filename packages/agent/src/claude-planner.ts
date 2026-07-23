/**
 * ClaudePlanner — brief → Plan via the Anthropic API with structured output.
 *
 * Primary path: `client.messages.parse` with
 * `output_config: { format: zodOutputFormat(zPlan) }` (SDK helpers/zod).
 * The installed SDK may predate those helpers, so we feature-detect at
 * runtime and fall back to a forced tool call whose input_schema is zPlan —
 * either way the result is validated with `zPlan.parse` before returning.
 *
 * Only constructed when ANTHROPIC_API_KEY is set (see createPlanner);
 * everything else in the repo runs against MockPlanner.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ProjectContext } from "@vdx/library";
import { zodToJsonSchema } from "./json-schema";
import { MockPlanner } from "./mock-planner";
import type { Plan, Planner } from "./types";
import { zPlan } from "./types";

const PLANNER_MODEL = "claude-opus-4-8";

/** Researched craft rules for one-shot AI video generation, verbatim-ish. */
const SYSTEM_PROMPT = `You are a film director planning a short AI-generated video from a brief.

Craft rules — follow ALL of them:
- STATELESSNESS: Each shot's visualPrompt must fully describe subject, setting, lighting, and style as if the video model has no context of any other shot. Never write "the same room" or "she continues" — restate everything, every shot.
- STYLE BIBLE: Define styleBible as a short list of global look tokens (film stock, palette, light quality, lens character) and repeat those tokens verbatim in every shot's visualPrompt.
- RESTRAINT: One camera move max per shot ("static" is allowed and often best). Subtle motion only, never stacked moves (no "pan while zooming"), dead-simple staging: one subject, one action per shot.
- BEAT DISCIPLINE: Exactly three beats — hook, development, payoff. The hook lands in the FIRST shot, development escalates, the payoff resolves at the end. Shot lengths 3-6 seconds each; shot durations must sum to approximately the target duration.
- VOICEOVER: Write voiceover to be read aloud within its shot's durationSec at ~2.5 words per second (a 4s shot fits ~10 words). One voiceover line per beat, placed on that beat's first shot.
- TITLE CARD: Put a short textOverlay title card on the final shot.
- MUSIC: musicPrompt describes a single instrumental bed matching the brief's mood — genre, tempo, instrumentation, explicitly no vocals.`;

/**
 * Uploaded briefs/docs/entities rendered into the system prompt so the plan
 * treats them as canon: briefs in full, document excerpts, and the entity
 * roster with ids the model must echo back in shot.entityIds.
 */
function renderContext(context: ProjectContext): string {
  const sections: string[] = [
    "PROJECT CONTEXT — everything below is canon. Honor these names, descriptions, and facts exactly; never contradict or rename them.",
  ];
  if (context.briefs.length > 0) {
    sections.push(
      "BRIEFS (full text):\n" +
        context.briefs.map((b) => `--- ${b.name} ---\n${b.text}`).join("\n\n"),
    );
  }
  if (context.documents.length > 0) {
    sections.push(
      "DOCUMENT EXCERPTS:\n" +
        context.documents
          .map((d) => `- ${d.name} (${d.wordCount} words): ${d.excerpt}`)
          .join("\n"),
    );
  }
  if (context.entities.length > 0) {
    sections.push(
      "ENTITY ROSTER:\n" +
        context.entities
          .map((e) => `- [${e.type}] id=${e.id} "${e.name}": ${e.description}`)
          .join("\n") +
        "\nWhen a shot features an entity, reference the entity by NAME in that shot's " +
        "visualPrompt (statelessness rule still applies: restate its description) and set " +
        "the shot's entityIds to the matching ids from this roster.",
    );
  }
  return sections.join("\n\n");
}

type ZodOutputFormat = (schema: unknown) => unknown;

async function loadZodOutputFormat(): Promise<ZodOutputFormat | undefined> {
  try {
    // Variable specifier: resolved at runtime only, so older SDKs without the
    // helpers/zod subpath don't break module load.
    const specifier = "@anthropic-ai/sdk/helpers/zod";
    const mod = (await import(specifier)) as { zodOutputFormat?: ZodOutputFormat };
    return typeof mod.zodOutputFormat === "function" ? mod.zodOutputFormat : undefined;
  } catch {
    return undefined;
  }
}

export class ClaudePlanner implements Planner {
  readonly mode = "claude" as const;
  private readonly model: string;

  constructor(model: string = PLANNER_MODEL) {
    this.model = model;
  }

  async plan(
    brief: string,
    opts: { targetDurationSec: number; context?: ProjectContext },
  ): Promise<Plan> {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ClaudePlanner requires ANTHROPIC_API_KEY — use createPlanner() to fall back to MockPlanner");
    }
    const client = new Anthropic();
    const system = opts.context
      ? `${SYSTEM_PROMPT}\n\n${renderContext(opts.context)}`
      : SYSTEM_PROMPT;
    const userMessage =
      `Brief: ${brief}\n\n` +
      `Target duration: ${opts.targetDurationSec} seconds. Plan the video now.`;

    const zodOutputFormat = await loadZodOutputFormat();
    const messages = client.messages as unknown as Record<string, unknown>;

    if (zodOutputFormat && typeof messages.parse === "function") {
      // Structured output via messages.parse + zodOutputFormat(zPlan).
      const response = (await (messages.parse as (params: unknown) => Promise<unknown>)({
        model: this.model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system,
        messages: [{ role: "user", content: userMessage }],
        output_config: { format: zodOutputFormat(zPlan) },
      })) as { parsed_output?: unknown; stop_reason?: string };
      if (!response.parsed_output) {
        throw new Error(
          `Claude returned no parsed plan (stop_reason: ${response.stop_reason ?? "unknown"})`,
        );
      }
      return zPlan.parse(response.parsed_output);
    }

    // Fallback for SDKs without messages.parse: force a single tool call whose
    // input_schema is zPlan, then validate the tool input ourselves.
    // (Forced tool_choice is incompatible with thinking, so none is set here.)
    const response = (await (client.messages.create as (params: unknown) => Promise<unknown>)({
      model: this.model,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: userMessage }],
      tools: [
        {
          name: "emit_plan",
          description: "Emit the finished video plan.",
          input_schema: zodToJsonSchema(zPlan),
        },
      ],
      tool_choice: { type: "tool", name: "emit_plan" },
    })) as { content: Array<{ type: string; input?: unknown }>; stop_reason?: string };

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse) {
      throw new Error(`Claude did not emit a plan (stop_reason: ${response.stop_reason ?? "unknown"})`);
    }
    return zPlan.parse(toolUse.input);
  }
}

/** ClaudePlanner when ANTHROPIC_API_KEY is set, MockPlanner otherwise. */
export function createPlanner(): Planner {
  return process.env.ANTHROPIC_API_KEY ? new ClaudePlanner() : new MockPlanner();
}
