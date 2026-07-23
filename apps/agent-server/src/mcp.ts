/**
 * vdx-editor — MCP stdio server exposing the timeline command catalog as
 * tools (one tool per command, schema shared with the store's zod validation:
 * one schema, three bindings), plus project lifecycle tools:
 *
 *   list_projects              projects on disk
 *   get_project                compact digest (ids + times in seconds)
 *   create_project_from_brief  full director run (mock-fast without API keys)
 *   render_project             render the project to an MP4 under renders/
 *
 * and library tools over the SAME shared Library instance the HTTP server
 * uses (services.ts):
 *
 *   upload_asset               ingest a local file (classify/extract/organize)
 *   search_library             FTS over document text + entity names
 *   list_entities              entities (global + per-project)
 *   create_entity              typed entity (character/location/style/...)
 *   link_asset_to_entity       attach a reference/voice/document asset
 *   list_takes                 take stacks per shot
 *   select_take                swap a take into the timeline + mark selected
 *   retake_shot                regenerate one shot synchronously
 *   canvas_add_note            drop a note card on the project canvas
 *
 * Every command tool loads the project through ProjectsManager, dispatches
 * through the ProjectStore (validated + undoable), saves, and returns the
 * command's human-readable summary.
 *
 * stdout is the protocol channel — all logging goes to stderr.
 */

import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { applyTake, createLibraryBank, retakeShot, runDirector } from "@vdx/agent";
import { commandCatalog } from "@vdx/timeline";
import { projectDigest } from "./digest";
import type { Services } from "./services";
import { createServices } from "./services";

const zProjectId = z
  .string()
  .describe("Project id (from list_projects or create_project_from_brief)");

const ENTITY_TYPES = [
  "character",
  "location",
  "scene",
  "style",
  "prop",
  "voice",
  "brief",
  "other",
] as const;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

interface ToolConfig {
  description: string;
  inputSchema?: Record<string, z.ZodTypeAny>;
}

/**
 * The SDK's registerTool generics blow TS's instantiation depth on
 * dynamically-built shapes; this wrapper keeps the runtime behavior (zod
 * validation from the shape) with an explicit, shallow signature.
 */
type RegisterTool = <A>(
  name: string,
  config: ToolConfig,
  cb: (args: A) => Promise<ToolResult> | ToolResult,
) => void;

function text(message: string): ToolResult {
  return { content: [{ type: "text", text: message }] };
}

function errorResult(err: unknown): ToolResult {
  return { ...text(`Error: ${err instanceof Error ? err.message : String(err)}`), isError: true };
}

export function buildMcpServer(services: Services): McpServer {
  const server = new McpServer({ name: "vdx-editor", version: "0.1.0" });
  const registerTool = server.registerTool.bind(server) as unknown as RegisterTool;
  const { manager, gateway, renderer, library } = services;

  // -- one tool per timeline command ---------------------------------------
  for (const command of commandCatalog) {
    const shape = (command.schema as z.ZodObject<z.ZodRawShape>).shape;
    registerTool(
      command.name,
      {
        description:
          `${command.description} All times are MediaTime ticks (120000 ticks = 1 second). ` +
          `Applies to the project identified by projectId.`,
        inputSchema: { projectId: zProjectId, ...shape },
      },
      async (args: { projectId: string } & Record<string, unknown>) => {
        try {
          const { projectId, ...params } = args;
          const store = manager.get(projectId);
          const result = store.dispatch({ type: command.name, params });
          manager.save(projectId, store);
          return text(result.summary);
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  // -- lifecycle tools ------------------------------------------------------

  registerTool(
    "list_projects",
    { description: "List all VDX projects on disk (id, name, last update)." },
    async () => {
      const projects = manager.list();
      if (projects.length === 0) {
        return text("No projects yet. Use create_project_from_brief to make one.");
      }
      return text(
        projects
          .map((p) => `${p.id} — "${p.name}" (updated ${p.updatedAt || "unknown"})`)
          .join("\n"),
      );
    },
  );

  registerTool(
    "get_project",
    {
      description:
        "Compact digest of a project: scenes, tracks, and elements with their ids and " +
        "times in seconds, plus the media asset bin.",
      inputSchema: { projectId: zProjectId },
    },
    async ({ projectId }: { projectId: string }) => {
      try {
        const store = manager.get(projectId);
        return text(JSON.stringify(projectDigest(store.getProject()), null, 2));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "create_project_from_brief",
    {
      description:
        "Create a project and run the full director pipeline on a brief (plan, generate " +
        "keyframes/clips/voiceover/music, assemble the timeline). Uploaded briefs/refs " +
        "already attached to the project ground the plan. Runs synchronously; fast in " +
        "mock mode (no API keys).",
      inputSchema: {
        brief: z.string().min(1).describe("What the video should be"),
        targetDurationSec: z.number().positive().optional().describe("Target length, default 20s"),
      },
    },
    async ({ brief, targetDurationSec }: { brief: string; targetDurationSec?: number }) => {
      try {
        const { id, store } = manager.create();
        const bank = createLibraryBank(library, id);
        const outcome = await runDirector({
          brief,
          ...(targetDurationSec !== undefined ? { targetDurationSec } : {}),
          store,
          gateway,
          bank,
          context: library.getProjectContext(id),
          library,
          libraryProjectId: id,
          onEvent: (event) => console.error(`[director] ${event.stage}`),
        });
        await bank.flush();
        manager.save(id, store);
        manager.savePlan(id, outcome.plan);
        return text(`projectId: ${id}\n${outcome.summary}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "render_project",
    {
      description: "Render a project to an MP4 under the .vdx/renders directory.",
      inputSchema: {
        projectId: zProjectId,
        draft: z.boolean().optional().describe("Draft = faster, lower resolution/bitrate"),
      },
    },
    async ({ projectId, draft }: { projectId: string; draft?: boolean }) => {
      try {
        const store = manager.get(projectId);
        const fileName = `${projectId}-${Date.now()}.mp4`;
        const outPath = join(manager.rendersDir, fileName);
        const result = await renderer.renderProject(store.getProject(), {
          outPath,
          draft: draft ?? false,
          onProgress: (message) => console.error(`[render] ${message}`),
        });
        manager.addRender(projectId, fileName);
        return text(
          `Rendered ${result.durationSec.toFixed(2)}s to ${result.outPath} ` +
            `in ${(result.elapsedMs / 1000).toFixed(1)}s`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // -- library tools --------------------------------------------------------

  registerTool(
    "upload_asset",
    {
      description:
        "Ingest a local file into the library: classify, dedupe, extract document text, " +
        "and organize into entities (characters/locations/styles/briefs). Optionally " +
        "attach to a project so it grounds the next director run.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path of the file to ingest"),
        projectId: zProjectId.optional(),
        purpose: z.enum(["brief", "reference"]).optional(),
      },
    },
    async ({
      path,
      projectId,
      purpose,
    }: {
      path: string;
      projectId?: string;
      purpose?: "brief" | "reference";
    }) => {
      try {
        const result = await library.ingest(
          { data: path, originalName: basename(path) },
          {
            ...(projectId !== undefined ? { projectId } : {}),
            ...(purpose !== undefined ? { purpose } : {}),
          },
        );
        const lines = [
          `assetId: ${result.asset.id} (${result.asset.kind}, ${result.asset.sizeBytes} bytes` +
            `${result.duplicate ? ", duplicate" : ""})`,
          `url: ${services.mediaUrl(result.asset.storagePath)}`,
          ...(result.organization ? [result.organization.summary] : []),
        ];
        return text(lines.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "search_library",
    {
      description:
        "Full-text search over the library (document text, entity names/descriptions). " +
        "Returns matching assets/entities with snippets.",
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }: { query: string }) => {
      try {
        const hits = library.search(query);
        if (hits.length === 0) return text(`No matches for "${query}".`);
        return text(
          hits.map((h) => `${h.refType} ${h.refId}: ${h.snippet}`).join("\n"),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "list_entities",
    {
      description:
        "List library entities (characters, locations, styles, ...). With projectId, " +
        "includes that project's entities plus global ones.",
      inputSchema: { projectId: zProjectId.optional() },
    },
    async ({ projectId }: { projectId?: string }) => {
      try {
        const entities = library.listEntities(projectId);
        if (entities.length === 0) return text("No entities yet.");
        return text(
          entities
            .map(
              (e) =>
                `${e.id} — ${e.type} "${e.name}"` +
                `${e.description ? `: ${e.description.slice(0, 120)}` : ""}` +
                ` (${e.referenceImagePaths.length} ref image(s), ${e.voicePaths.length} voice(s))`,
            )
            .join("\n"),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "create_entity",
    {
      description: "Create a library entity (character, location, style, prop, ...).",
      inputSchema: {
        type: z.enum(ENTITY_TYPES),
        name: z.string().min(1),
        description: z.string().optional(),
        projectId: zProjectId.optional(),
      },
    },
    async ({
      type,
      name,
      description,
      projectId,
    }: {
      type: (typeof ENTITY_TYPES)[number];
      name: string;
      description?: string;
      projectId?: string;
    }) => {
      try {
        const entity = library.createEntity({
          type,
          name,
          ...(description !== undefined ? { description } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
        });
        return text(`Created ${entity.type} "${entity.name}" (id ${entity.id}).`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "link_asset_to_entity",
    {
      description:
        "Link a library asset to an entity as a reference image, voice sample, or document.",
      inputSchema: {
        entityId: z.string().min(1),
        assetId: z.string().min(1),
        role: z.enum(["reference", "voice", "document"]).optional(),
      },
    },
    async ({
      entityId,
      assetId,
      role,
    }: {
      entityId: string;
      assetId: string;
      role?: "reference" | "voice" | "document";
    }) => {
      try {
        const entity = library.getEntity(entityId);
        if (!entity) return errorResult(new Error(`Entity not found: ${entityId}`));
        const asset = library.getAsset(assetId);
        if (!asset) return errorResult(new Error(`Asset not found: ${assetId}`));
        library.linkAssetToEntity(entityId, assetId, role);
        return text(
          `Linked "${asset.originalName}" to ${entity.type} "${entity.name}" as ${role ?? "reference"}.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "list_takes",
    {
      description: "List take stacks for a project (optionally one shot): id, shot, selection, prompt.",
      inputSchema: { projectId: zProjectId, shotId: z.string().optional() },
    },
    async ({ projectId, shotId }: { projectId: string; shotId?: string }) => {
      try {
        const takes = library.listTakes(projectId, shotId);
        if (takes.length === 0) {
          return text(`No takes${shotId ? ` for ${shotId}` : ""} in project ${projectId}.`);
        }
        return text(
          takes
            .map((t) => {
              const asset = library.getAsset(t.assetId);
              return (
                `${t.selected ? "* " : "  "}${t.id} — ${t.shotId}` +
                `${asset ? ` (${services.mediaUrl(asset.storagePath)})` : ""}` +
                `: ${t.prompt.slice(0, 80)}`
              );
            })
            .join("\n"),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "select_take",
    {
      description:
        "Select a take: mark it selected in the library and swap the shot's timeline " +
        "element to the take's clip.",
      inputSchema: { takeId: z.string().min(1) },
    },
    async ({ takeId }: { takeId: string }) => {
      try {
        const take = library.selectTake(takeId);
        const asset = library.getAsset(take.assetId);
        if (!asset) return errorResult(new Error(`Take ${takeId} points at a missing asset: ${take.assetId}`));
        const store = manager.get(take.projectId);
        const result = applyTake({
          store,
          shotId: take.shotId,
          assetId: take.assetId,
          assetSrc: asset.storagePath,
          ...(asset.durationSec !== undefined ? { durationSec: asset.durationSec } : {}),
        });
        manager.save(take.projectId, store);
        return text(result.summary);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "retake_shot",
    {
      description:
        "Regenerate one shot (keyframe + clip), record it as the selected take, and swap " +
        "it into the timeline. Runs synchronously; fast in mock mode.",
      inputSchema: {
        projectId: zProjectId,
        shotId: z.string().min(1),
        promptTweak: z.string().optional().describe("Extra instruction folded into the shot prompt"),
      },
    },
    async ({
      projectId,
      shotId,
      promptTweak,
    }: {
      projectId: string;
      shotId: string;
      promptTweak?: string;
    }) => {
      try {
        const store = manager.get(projectId);
        const plan = manager.getPlan(projectId);
        if (!plan) {
          return errorResult(
            new Error(`Project ${projectId} has no plan — run create_project_from_brief first`),
          );
        }
        const outcome = await retakeShot({
          store,
          gateway,
          plan,
          shotId,
          ...(promptTweak !== undefined ? { promptTweak } : {}),
          library,
          libraryProjectId: projectId,
          bank: createLibraryBank(library, projectId),
          onEvent: (event) => console.error(`[retake] ${event.stage}`),
        });
        manager.save(projectId, store);
        return text(outcome.summary);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerTool(
    "canvas_add_note",
    {
      description: "Add a sticky-note card to the project's library canvas.",
      inputSchema: {
        projectId: zProjectId,
        text: z.string().min(1),
        x: z.number().optional().describe("Canvas x (default 40)"),
        y: z.number().optional().describe("Canvas y (default 40)"),
      },
    },
    async ({
      projectId,
      text: noteText,
      x,
      y,
    }: {
      projectId: string;
      text: string;
      x?: number;
      y?: number;
    }) => {
      try {
        const item = library.upsertCanvasItem({
          projectId,
          refType: "note",
          refId: randomUUID(),
          x: x ?? 40,
          y: y ?? 40,
          z: 0,
          meta: { text: noteText },
        });
        return text(`Added note ${item.id} at (${item.x}, ${item.y}).`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

if (import.meta.main) {
  const services = createServices({ log: (message) => console.error(message) });
  const server = buildMcpServer(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`vdx-editor MCP server on stdio (state: ${services.manager.root})`);
}
