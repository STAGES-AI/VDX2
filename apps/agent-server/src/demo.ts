/**
 * End-to-end demo CLI:
 *
 *   bun run apps/agent-server/src/demo.ts "<brief>" [targetDurationSec] [--with-refs]
 *
 * Creates a project, runs the director (console progress), renders a draft
 * MP4, then prints the plan outline, the per-track timeline summary, total
 * cost, and the artifact paths. Exits non-zero on any failure.
 *
 * With --with-refs, a sample treatment .md and a mock-generated character
 * portrait are ingested into the library first, and the director runs with
 * the resulting ProjectContext — proving uploads ground the plan (entity
 * names in shot prompts, entityIds on shots, takes recorded per shot).
 */

import { join } from "node:path";
import type { DirectorEvent, EntityBank } from "@vdx/agent";
import { createEntityBank, createLibraryBank, runDirector } from "@vdx/agent";
import { createGateway } from "@vdx/gateway";
import type { Library, ProjectContext } from "@vdx/library";
import { createLibrary } from "@vdx/library";
import { createRenderer } from "@vdx/render";
import { planOutlineLines, timelineSummaryLines } from "./digest";
import { ProjectsManager } from "./state";

const SAMPLE_BRIEF_MD = [
  "# NEON RAIN treatment",
  "",
  "A courier races a storm through the neon district to deliver a glowing package.",
  "",
  "Open on rain hammering an empty intersection, sodium lights flickering.",
  "",
  "## Character: Kade",
  "A weathered courier in a reflective jacket, rain beading on the visor of a scuffed helmet.",
  "",
  "## Style: Neon Noir",
  "rain-soaked neon noir, cyan and magenta highlights, wet asphalt reflections, deep shadows",
  "",
].join("\n");

function printEvent(event: DirectorEvent): void {
  switch (event.stage) {
    case "plan_ready":
      console.log(`[plan_ready] "${event.plan.title}" — ${event.plan.shots.length} shots`);
      break;
    case "keyframe":
    case "clip":
      console.log(`[${event.stage}] ${event.shotId}: ${event.message}`);
      break;
    default:
      console.log(`[${event.stage}] ${event.message}`);
  }
}

function heading(title: string): void {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(0, 60 - title.length))}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const withRefs = args.includes("--with-refs");
  const positional = args.filter((arg) => arg !== "--with-refs");
  const brief = positional[0];
  if (!brief || brief.trim() === "") {
    console.error(
      'Usage: bun run apps/agent-server/src/demo.ts "<brief>" [targetDurationSec] [--with-refs]',
    );
    process.exit(2);
  }
  const targetArg = positional[1];
  const targetDurationSec = targetArg !== undefined ? Number(targetArg) : undefined;
  if (targetDurationSec !== undefined && !(targetDurationSec > 0)) {
    console.error(`targetDurationSec must be a positive number, got: ${targetArg}`);
    process.exit(2);
  }

  const manager = new ProjectsManager();
  const gateway = createGateway({
    mediaDir: manager.mediaDir,
    cacheDir: manager.cacheDir,
    log: (message) => console.log(`  [gateway] ${message}`),
  });

  const { id, store } = manager.create();

  // --with-refs: ingest a sample brief + a generated character portrait so the
  // planner runs grounded in real library context.
  let library: Library | undefined;
  let context: ProjectContext | undefined;
  let bank: EntityBank;
  if (withRefs) {
    heading("Library (refs)");
    library = createLibrary({ rootDir: manager.root });
    const briefIngest = await library.ingest(
      { data: new TextEncoder().encode(SAMPLE_BRIEF_MD), originalName: "brief_neon_rain.md" },
      { projectId: id, purpose: "brief" },
    );
    console.log(`brief: ${briefIngest.organization?.summary ?? "stored"}`);

    const portrait = await gateway.generate({
      kind: "image",
      prompt: "Portrait of Kade, weathered courier in a reflective jacket, neon noir",
      width: 768,
      height: 768,
      tier: "draft",
    });
    const portraitIngest = await library.ingest(
      { data: portrait.path, originalName: "character_kade.png" },
      { projectId: id, purpose: "reference" },
    );
    console.log(`portrait: ${portraitIngest.organization?.summary ?? "stored"}`);

    context = library.getProjectContext(id);
    console.log(
      `Context: ${context.briefs.length} brief(s), ${context.entities.length} entit(y/ies): ` +
        context.entities.map((e) => `${e.type} "${e.name}"`).join(", "),
    );
    bank = createLibraryBank(library, id);
  } else {
    bank = createEntityBank(join(manager.root, "entities.json"));
  }

  heading("Director");
  console.log(`Brief: ${brief}`);
  console.log(`Project: ${id} (providers ${gateway.isLive() ? "LIVE" : "mock"})`);

  const outcome = await runDirector({
    brief,
    ...(targetDurationSec !== undefined ? { targetDurationSec } : {}),
    store,
    gateway,
    bank,
    ...(withRefs && library !== undefined && context !== undefined
      ? { context, library, libraryProjectId: id }
      : {}),
    onEvent: printEvent,
  });
  manager.save(id, store);
  manager.savePlan(id, outcome.plan);

  heading("Plan outline");
  for (const line of planOutlineLines(outcome.plan)) console.log(line);

  if (withRefs && library !== undefined) {
    heading("Grounding");
    for (const shot of outcome.plan.shots) {
      console.log(`${shot.id}: entityIds [${shot.entityIds.join(", ")}]`);
    }
    const takes = library.listTakes(id);
    console.log(`Takes recorded: ${takes.length} (selected: ${takes.filter((t) => t.selected).length})`);
    const shotCards = library.listCanvasItems(id).filter((item) => item.refType === "shot");
    console.log(`Canvas shot cards: ${shotCards.length}`);
  }

  heading("Timeline");
  for (const line of timelineSummaryLines(store.getProject())) console.log(line);

  heading("Render (draft)");
  const renderer = createRenderer({ tmpDir: manager.tmpDir });
  const fileName = `${id}-${Date.now()}.mp4`;
  const outPath = join(manager.rendersDir, fileName);
  const result = await renderer.renderProject(store.getProject(), {
    outPath,
    draft: true,
    onProgress: (message) => console.log(`  [render] ${message}`),
  });
  manager.addRender(id, fileName);

  heading("Result");
  const plannedSec = outcome.plan.shots.reduce((sum, s) => sum + s.durationSec, 0);
  console.log(`Plan total:      ${plannedSec.toFixed(2)}s`);
  console.log(`MP4 duration:    ${result.durationSec.toFixed(2)}s (${(result.elapsedMs / 1000).toFixed(1)}s render)`);
  console.log(`Total cost:      $${gateway.totalCostUsd().toFixed(2)}`);
  console.log(`Project JSON:    ${join(manager.projectsDir, `${id}.json`)}`);
  console.log(`Plan JSON:       ${join(manager.plansDir, `${id}.json`)}`);
  console.log(`MP4:             ${result.outPath}`);
  console.log(`\n${outcome.summary}`);

  library?.close();
}

main().catch((err: unknown) => {
  console.error(`\nDemo failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
