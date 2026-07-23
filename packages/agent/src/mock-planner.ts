/**
 * MockPlanner — a deterministic Plan from the brief, no network. Encodes the
 * same craft rules the Claude planner is prompted with: three-beat narrative
 * (hook / development / payoff), 4-6 shots of 3-6s sized to the target
 * duration, fully self-contained visual prompts (statelessness rule) that
 * repeat the style bible, at most one camera move per shot (restraint rule),
 * one voiceover line per beat on the beat's first shot, and a title card on
 * the final shot.
 *
 * When a ProjectContext is provided, the plan is grounded in it: shot
 * subjects cycle through character/location entity names (and carry their
 * entity ids), style entity descriptions extend the style bible, and the
 * first brief's opening lines drive title/logline/beat descriptions — still
 * fully deterministic.
 */

import type { ProjectContext } from "@vdx/library";
import type { Beat, Plan, Planner, Shot } from "./types";
import { zPlan } from "./types";

const STOPWORDS = new Set([
  "a", "an", "the", "of", "for", "and", "or", "to", "in", "on", "with", "about",
  "is", "are", "was", "were", "be", "that", "this", "these", "those", "it", "its",
  "as", "at", "by", "from", "into", "over", "under", "up", "down", "out", "our",
  "your", "my", "their", "some", "any", "very", "really", "please", "make",
  "makes", "making", "create", "video", "clip", "short", "second", "seconds",
]);

const MOOD_WORDS = [
  "calm", "epic", "upbeat", "dark", "dreamy", "energetic", "melancholy",
  "hopeful", "tense", "warm", "playful", "serene", "moody", "triumphant",
  "cozy", "mysterious", "nostalgic",
];

/** One camera move max per shot; cycled deterministically. */
const CAMERA_MOVES = [
  "slow push-in",
  "static",
  "gentle pan left",
  "slow pull-back",
  "gentle pan right",
  "static",
];

const SETTINGS = [
  "centered in a wide open landscape at golden hour",
  "in a quiet interior lit by a single tall window",
  "against a clean neutral studio backdrop",
  "surrounded by soft drifting mist at dawn",
  "on an empty street at dusk under warm lamplight",
  "beside still water reflecting a pale sky",
];

const LIGHTING = [
  "soft golden-hour light",
  "cool diffused daylight",
  "warm tungsten glow",
  "pale overcast light",
  "low-key dramatic side light",
  "gentle backlight with light haze",
];

function extractKeywords(brief: string): string[] {
  const words = brief.toLowerCase().match(/[a-z][a-z'-]+/g) ?? [];
  const out: string[] = [];
  for (const word of words) {
    if (!STOPWORDS.has(word) && !out.includes(word)) out.push(word);
  }
  return out.length > 0 ? out : ["light", "motion", "form"];
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Character/location entities become shot subjects, cycled deterministically. */
function contextCast(context?: ProjectContext): { id: string; name: string }[] {
  return (context?.entities ?? [])
    .filter((e) => e.type === "character" || e.type === "location")
    .map((e) => ({ id: e.id, name: e.name }));
}

/** Style entity descriptions extend the style bible. */
function contextStyleWords(context?: ProjectContext): string[] {
  return (context?.entities ?? [])
    .filter((e) => e.type === "style")
    .map((e) => e.description.trim())
    .filter((words) => words !== "");
}

/** Non-empty opening lines of the first brief, markdown headings stripped. */
function briefLines(context?: ProjectContext): string[] {
  const text = context?.briefs[0]?.text ?? "";
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line !== "");
}

export function buildMockPlan(
  brief: string,
  targetDurationSec: number,
  context?: ProjectContext,
): Plan {
  if (!Number.isFinite(targetDurationSec) || targetDurationSec <= 0) {
    throw new Error(`targetDurationSec must be a positive number, got ${targetDurationSec}`);
  }
  const keywords = extractKeywords(brief);
  const cast = contextCast(context);
  const subjectOf = (i: number) =>
    cast.length > 0 ? cast[i % cast.length].name : keywords[i % keywords.length];
  const entityIdsOf = (i: number) => (cast.length > 0 ? [cast[i % cast.length].id] : []);

  const lines = briefLines(context);
  const title = lines[0] ?? keywords.slice(0, 3).map(titleCase).join(" ");

  const styleWords = contextStyleWords(context);
  const styleBible = [
    "cinematic 35mm film look, soft natural light, muted earth tones, " +
      "shallow depth of field, fine film grain",
    ...styleWords,
  ].join(", ");

  // 4-6 shots of 3-6s each, sized to the target.
  const shotCount = Math.min(6, Math.max(4, Math.round(targetDurationSec / 4.5)));
  const perShotSec =
    Math.round(Math.min(6, Math.max(3, targetDurationSec / shotCount)) * 100) / 100;

  const moods = MOOD_WORDS.filter((m) => brief.toLowerCase().includes(m));
  const moodPhrase = moods.length > 0 ? moods.join(", ") : "warm, minimal";
  const musicPrompt =
    `${moodPhrase} instrumental bed, slow build, no vocals, ` +
    `subtle percussion, ~${Math.round(targetDurationSec)} seconds`;

  const voiceoverByBeat: Record<string, string> = {
    hook: `What if ${subjectOf(0)} could change everything?`,
    development: `Piece by piece, ${subjectOf(0)} takes shape.`,
    payoff: "And this is only the beginning.",
  };

  const beatOf = (i: number): "hook" | "development" | "payoff" =>
    i === 0 ? "hook" : i === shotCount - 1 ? "payoff" : "development";

  const shots: Shot[] = [];
  const seenBeats = new Set<string>();
  for (let i = 0; i < shotCount; i++) {
    const beatName = beatOf(i);
    const beatId = `beat-${beatName}`;
    const isFirstShotOfBeat = !seenBeats.has(beatId);
    seenBeats.add(beatId);

    // Statelessness rule: subject + setting + lighting + style, every shot.
    const visualPrompt =
      `A cinematic shot of ${subjectOf(i)} ${SETTINGS[i % SETTINGS.length]}, ` +
      `${LIGHTING[i % LIGHTING.length]}, one clear subject, simple staging. ` +
      styleBible;

    shots.push({
      id: `shot-${i + 1}`,
      beatId,
      durationSec: perShotSec,
      visualPrompt,
      camera: CAMERA_MOVES[i % CAMERA_MOVES.length],
      ...(isFirstShotOfBeat ? { voiceover: voiceoverByBeat[beatName] } : {}),
      ...(i === shotCount - 1 ? { textOverlay: title } : {}),
      entityIds: entityIdsOf(i),
    });
  }

  const beatDuration = (beatId: string) =>
    shots.filter((s) => s.beatId === beatId).reduce((sum, s) => sum + s.durationSec, 0);

  // Brief opening lines (after the title line) seed logline + beat arcs.
  const beats: Beat[] = [
    {
      id: "beat-hook",
      name: "Hook",
      description:
        lines[2] ?? `Open on ${subjectOf(0)} — a single arresting image that poses a question.`,
      durationSec: beatDuration("beat-hook"),
    },
    {
      id: "beat-development",
      name: "Development",
      description:
        lines[3] ??
        `Escalate: ${keywords.slice(0, 2).join(" and ")} evolve, each shot raising the stakes.`,
      durationSec: beatDuration("beat-development"),
    },
    {
      id: "beat-payoff",
      name: "Payoff",
      description:
        lines[4] ??
        `Land the payoff: the full picture of ${title} resolves, title card over the final shot.`,
      durationSec: beatDuration("beat-payoff"),
    },
  ];

  return zPlan.parse({
    title,
    logline: lines[1] ?? `A ${shotCount}-shot short about ${keywords.slice(0, 3).join(", ")}.`,
    styleBible,
    beats,
    shots,
    musicPrompt,
    voice: "narrator",
  });
}

export class MockPlanner implements Planner {
  readonly mode = "mock" as const;

  async plan(
    brief: string,
    opts: { targetDurationSec: number; context?: ProjectContext },
  ): Promise<Plan> {
    return buildMockPlan(brief, opts.targetDurationSec, opts.context);
  }
}
