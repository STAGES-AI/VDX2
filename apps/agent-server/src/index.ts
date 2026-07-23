/**
 * The VDX agent server — HTTP + SSE binding of the director/editor runtime.
 *
 * Elysia app on :8790 (CORS open) implementing the contract the web UI is
 * coded against (apps/web/src/vdx/api.ts):
 *
 *   POST /api/uploads                     multipart {files, projectId?, purpose?} → {results}
 *   POST /api/projects/draft              {name?} → {projectId} (empty project, no director)
 *   POST /api/projects                    {brief, targetDurationSec?, projectId?, gate?} → {projectId, jobId}
 *   POST /api/jobs/:jobId/approve         → {ok: true} (resolves a gated run)
 *   GET  /api/jobs/:jobId/stream          SSE of job events (replay + live)
 *   GET  /api/projects                    → {projects}
 *   GET  /api/projects/:id                → {project, plan, renders}
 *   GET  /api/projects/:id/library        → {assets, entities}
 *   GET  /api/projects/:id/canvas         → {items} (payload-enriched canvas views)
 *   PATCH /api/projects/:id/canvas/:itemId  {x?,y?,w?,h?,z?} → {item}
 *   POST /api/projects/:id/canvas/notes   {text, x, y} → {item}
 *   GET  /api/projects/:id/takes          → {takes}
 *   POST /api/projects/:id/takes/:takeId/select → {summary}
 *   POST /api/projects/:id/shots/:shotId/retake {promptTweak?} → {jobId}
 *   POST /api/projects/:id/edit|undo|redo|render  (unchanged)
 *   PATCH /api/projects/:id                 {name} → {summary} (rename)
 *   POST /api/projects/:id/duplicate        → {projectId} (deep-cloned copy)
 *   DELETE /api/projects/:id                → {ok: true}
 *   GET  /api/settings                      → SettingsView (masked keys)
 *   PUT  /api/settings                      partial RuntimeConfig patch → SettingsView
 *   GET  /media/*                         static files from the .vdx state dir
 *
 * All asset urls are '/media/...' paths: '/media/' + relative(root, storagePath).
 *
 * Settings (API keys + planner/editor model+effort) are hot: PUT /api/settings
 * rebuilds the Gateway and swaps the RuntimeConfig services.ts holds, with no
 * server restart. See services.ts's module docs for why every consumer of
 * the Gateway must call services.getGateway() fresh rather than caching it.
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import { z } from "zod";
import {
  applyEditInstruction,
  applyTake,
  createLibraryBank,
  createPlanner,
  retakeShot,
  runDirector,
} from "@vdx/agent";
import type { Plan } from "@vdx/agent";
import type { CanvasItem } from "@vdx/library";
import { effectiveEnv } from "./config";
import type { Job } from "./jobs";
import type { Services } from "./services";
import { createServices } from "./services";

export const PORT = 8790;

const zCreateBody = z.object({
  brief: z.string().min(1, "brief must be a non-empty string"),
  targetDurationSec: z.number().positive().optional(),
  projectId: z.string().min(1).optional(),
  gate: z.boolean().optional(),
});

const zDraftBody = z
  .object({ name: z.string().min(1).optional() })
  .optional()
  .nullable();

const zUploadFields = z.object({
  projectId: z.string().min(1).optional(),
  purpose: z.enum(["brief", "reference"]).optional(),
});

const zEditBody = z.object({
  instruction: z.string().min(1, "instruction must be a non-empty string"),
});

const zRenderBody = z
  .object({ draft: z.boolean().optional() })
  .optional()
  .nullable();

const zCanvasPatchBody = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  z: z.number().optional(),
});

const zNoteBody = z.object({
  text: z.string().min(1, "text must be a non-empty string"),
  x: z.number(),
  y: z.number(),
});

const zRetakeBody = z
  .object({ promptTweak: z.string().min(1).optional() })
  .optional()
  .nullable();

const zRenameBody = z.object({
  name: z.string().min(1, "name must be a non-empty string"),
});

const zEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);

const zSettingsBody = z.object({
  anthropicApiKey: z.string().optional(),
  falApiKey: z.string().optional(),
  elevenLabsApiKey: z.string().optional(),
  plannerModel: z.string().min(1).optional(),
  plannerEffort: zEffort.optional(),
  editorModel: z.string().min(1).optional(),
  editorEffort: zEffort.optional(),
});

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aiff": "audio/aiff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Canvas item enriched with the payload the web UI renders from. */
interface CanvasItemView {
  id: string;
  refType: CanvasItem["refType"];
  refId: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  z: number;
  meta: Record<string, unknown>;
  payload: Record<string, unknown>;
}

/** The app plus its state/jobs handles (tests reach into these). */
export type AppContext = ReturnType<typeof createApp>;

export function createApp(options: { root?: string } = {}) {
  const services = createServices(options.root !== undefined ? { root: options.root } : {});
  // NOTE: `gateway` is intentionally NOT destructured here. Destructuring it
  // once at boot would capture a closure over the Gateway instance that
  // exists at that moment; updateSettings() (PUT /api/settings) rebuilds the
  // Gateway on every config change, so anything holding the old reference
  // would silently keep using stale API keys until a restart. Call
  // services.getGateway() fresh at the point of use instead — see
  // services.ts's module docs.
  const { manager, jobs, renderer, library } = services;

  function startDirectorJob(
    projectId: string,
    brief: string,
    opts: { targetDurationSec?: number; gate?: boolean } = {},
  ): Job {
    const store = manager.get(projectId);
    const job = jobs.createJob();
    const bank = createLibraryBank(library, projectId);
    void (async () => {
      try {
        const config = services.getConfig();
        const planner = createPlanner({
          model: config.plannerModel,
          effort: config.plannerEffort,
          apiKey: effectiveEnv(config).ANTHROPIC_API_KEY,
        });
        const outcome = await runDirector({
          brief,
          ...(opts.targetDurationSec !== undefined
            ? { targetDurationSec: opts.targetDurationSec }
            : {}),
          store,
          gateway: services.getGateway(),
          planner,
          bank,
          context: library.getProjectContext(projectId),
          library,
          libraryProjectId: projectId,
          ...(opts.gate ? { waitForApproval: () => job.waitForApproval() } : {}),
          onEvent: (event) => {
            // Persist the plan as soon as it exists so GET /projects/:id can
            // show it mid-run.
            if (event.stage === "plan_ready") manager.savePlan(projectId, event.plan);
            job.emit(event);
          },
        });
        await bank.flush();
        manager.save(projectId, store);
        manager.savePlan(projectId, outcome.plan);
        job.done(outcome);
      } catch (err) {
        manager.save(projectId, store); // keep whatever partial state exists
        job.fail(err);
      }
    })();
    return job;
  }

  function startRetakeJob(projectId: string, plan: Plan, shotId: string, promptTweak?: string): Job {
    const store = manager.get(projectId);
    const job = jobs.createJob();
    const bank = createLibraryBank(library, projectId);
    void (async () => {
      try {
        const outcome = await retakeShot({
          store,
          gateway: services.getGateway(),
          plan,
          shotId,
          ...(promptTweak !== undefined ? { promptTweak } : {}),
          library,
          libraryProjectId: projectId,
          bank,
          onEvent: (event) => job.emit(event),
        });
        manager.save(projectId, store);
        job.emit({ stage: "done", message: outcome.summary });
        job.done(outcome);
      } catch (err) {
        manager.save(projectId, store);
        job.fail(err);
      }
    })();
    return job;
  }

  function startRenderJob(projectId: string, draft: boolean): Job {
    const store = manager.get(projectId);
    const job = jobs.createJob();
    void (async () => {
      try {
        const fileName = `${projectId}-${Date.now()}.mp4`;
        const outPath = join(manager.rendersDir, fileName);
        job.emit({ stage: "assemble", message: `Rendering ${draft ? "draft" : "final"} MP4` });
        const result = await renderer.renderProject(store.getProject(), {
          outPath,
          draft,
          onProgress: (message) => job.emit({ stage: "assemble", message }),
        });
        const info = manager.addRender(projectId, fileName);
        job.emit({
          stage: "render_done",
          url: info.url,
          message: `Rendered ${result.durationSec.toFixed(2)}s in ${(result.elapsedMs / 1000).toFixed(1)}s`,
        });
        job.emit({ stage: "done", message: `Render complete: ${info.url}` });
        job.done(result);
      } catch (err) {
        job.fail(err);
      }
    })();
    return job;
  }

  /** Plan for a project, or undefined when absent/unreadable. */
  function planFor(projectId: string): Plan | undefined {
    try {
      return manager.getPlan(projectId);
    } catch {
      return undefined;
    }
  }

  /**
   * Enrich a stored canvas item with its render payload. Returns undefined
   * for dangling refs (deleted asset/entity) so the canvas never 500s.
   */
  function canvasItemView(
    projectId: string,
    item: CanvasItem,
    plan: Plan | undefined,
  ): CanvasItemView | undefined {
    let payload: Record<string, unknown>;
    switch (item.refType) {
      case "asset": {
        const asset = library.getAsset(item.refId);
        if (!asset) return undefined;
        payload = {
          name: asset.originalName,
          kind: asset.kind,
          url: services.mediaUrl(asset.storagePath),
        };
        break;
      }
      case "entity": {
        const entity = library.getEntity(item.refId);
        if (!entity) return undefined;
        payload = {
          name: entity.name,
          type: entity.type,
          referenceImageUrls: entity.referenceImagePaths.map((p) => services.mediaUrl(p)),
        };
        break;
      }
      case "shot": {
        const shotId = typeof item.meta.shotId === "string" ? item.meta.shotId : item.refId;
        const shot = plan?.shots.find((s) => s.id === shotId);
        const takes = library.listTakes(projectId, shotId);
        const selected = takes.find((t) => t.selected) ?? takes[takes.length - 1];
        const clip = selected ? library.getAsset(selected.assetId) : undefined;
        const keyframe = selected?.keyframeAssetId
          ? library.getAsset(selected.keyframeAssetId)
          : undefined;
        payload = {
          shotId,
          label: shot ? shot.visualPrompt.slice(0, 60) : shotId,
          ...(keyframe ? { keyframeUrl: services.mediaUrl(keyframe.storagePath) } : {}),
          ...(clip ? { clipUrl: services.mediaUrl(clip.storagePath) } : {}),
        };
        break;
      }
      case "note":
        payload = { text: typeof item.meta.text === "string" ? item.meta.text : "" };
        break;
    }
    return {
      id: item.id,
      refType: item.refType,
      refId: item.refId,
      x: item.x,
      y: item.y,
      ...(item.w !== undefined ? { w: item.w } : {}),
      ...(item.h !== undefined ? { h: item.h } : {}),
      z: item.z,
      meta: item.meta,
      payload,
    };
  }

  function takeView(take: {
    id: string;
    shotId: string;
    assetId: string;
    keyframeAssetId?: string;
    prompt: string;
    selected: boolean;
    createdAt: string;
  }) {
    const clip = library.getAsset(take.assetId);
    const keyframe = take.keyframeAssetId ? library.getAsset(take.keyframeAssetId) : undefined;
    return {
      id: take.id,
      shotId: take.shotId,
      url: clip ? services.mediaUrl(clip.storagePath) : "",
      ...(keyframe ? { keyframeUrl: services.mediaUrl(keyframe.storagePath) } : {}),
      prompt: take.prompt,
      selected: take.selected,
      createdAt: take.createdAt,
    };
  }

  const app = new Elysia()
    .use(cors({ origin: true }))
    .get("/", () => ({ ok: true, service: "vdx-agent-server", port: PORT }))

    .get("/api/settings", () => services.getSettingsView())

    .put("/api/settings", ({ body, set }) => {
      const parsed = zSettingsBody.safeParse(body ?? {});
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      return services.updateSettings(parsed.data);
    })

    .post("/api/uploads", async ({ body, set }) => {
      if (typeof body !== "object" || body === null) {
        set.status = 400;
        return "Expected multipart/form-data with a 'files' field";
      }
      const record = body as Record<string, unknown>;
      const rawFiles = record.files;
      const files = (Array.isArray(rawFiles) ? rawFiles : [rawFiles]).filter(
        (f): f is File => f instanceof File,
      );
      if (files.length === 0) {
        set.status = 400;
        return "No files in the 'files' field";
      }
      const fields = zUploadFields.safeParse({
        ...(typeof record.projectId === "string" ? { projectId: record.projectId } : {}),
        ...(typeof record.purpose === "string" ? { purpose: record.purpose } : {}),
      });
      if (!fields.success) {
        set.status = 400;
        return `Invalid fields: ${fields.error.issues.map((i) => i.message).join("; ")}`;
      }
      const { projectId, purpose } = fields.data;
      try {
        const results = [];
        for (const file of files) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await library.ingest(
            { data: bytes, originalName: file.name },
            {
              ...(projectId !== undefined ? { projectId } : {}),
              ...(purpose !== undefined ? { purpose } : {}),
            },
          );
          results.push({
            assetId: result.asset.id,
            kind: result.asset.kind,
            name: result.asset.originalName,
            url: services.mediaUrl(result.asset.storagePath),
            sizeBytes: result.asset.sizeBytes,
            duplicate: result.duplicate,
            organization: result.organization ?? null,
          });
        }
        return { results };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .post("/api/projects/draft", ({ body, set }) => {
      const parsed = zDraftBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      const name = parsed.data?.name;
      const { id } = manager.create(name !== undefined ? { name } : {});
      return { projectId: id };
    })

    .post("/api/projects", ({ body, set }) => {
      const parsed = zCreateBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      const { brief, targetDurationSec, projectId, gate } = parsed.data;
      let id: string;
      if (projectId !== undefined) {
        if (!manager.has(projectId)) {
          set.status = 404;
          return `Project not found: ${projectId}`;
        }
        id = projectId;
      } else {
        id = manager.create().id;
      }
      const job = startDirectorJob(id, brief, {
        ...(targetDurationSec !== undefined ? { targetDurationSec } : {}),
        ...(gate !== undefined ? { gate } : {}),
      });
      return { projectId: id, jobId: job.id };
    })

    .post("/api/jobs/:jobId/approve", ({ params, set }) => {
      const job = jobs.get(params.jobId);
      if (!job) {
        set.status = 404;
        return `Unknown job: ${params.jobId}`;
      }
      job.approve();
      return { ok: true };
    })

    .get("/api/jobs/:jobId/stream", ({ params, set }) => {
      const job = jobs.get(params.jobId);
      if (!job) {
        set.status = 404;
        return `Unknown job: ${params.jobId}`;
      }
      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const close = () => {
            try {
              controller.close();
            } catch {
              // already closed (client hung up first)
            }
          };
          unsubscribe = job.subscribe({
            onEvent: (event) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
              } catch {
                unsubscribe?.();
              }
            },
            onEnd: close,
          });
        },
        cancel() {
          unsubscribe?.();
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    })

    .get("/api/projects", () => ({ projects: manager.list() }))

    .get("/api/projects/:id", ({ params, set }) => {
      try {
        if (!manager.has(params.id)) {
          set.status = 404;
          return `Project not found: ${params.id}`;
        }
        const store = manager.get(params.id);
        return {
          project: store.getProject(),
          plan: manager.getPlan(params.id),
          renders: manager.listRenders(params.id),
        };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .patch("/api/projects/:id", ({ params, body, set }) => {
      const parsed = zRenameBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      try {
        manager.rename(params.id, parsed.data.name);
        return { summary: `Renamed to "${parsed.data.name}"` };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .post("/api/projects/:id/duplicate", ({ params, set }) => {
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      try {
        const { newId } = manager.duplicate(params.id);
        return { projectId: newId };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .delete("/api/projects/:id", ({ params, set }) => {
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      try {
        manager.delete(params.id);
        services.detachProject(params.id);
        return { ok: true };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .get("/api/projects/:id/library", ({ params, set }) => {
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      try {
        const purposes = services.assetPurposes(params.id);
        const assets = library.listAssets({ projectId: params.id }).map((asset) => ({
          assetId: asset.id,
          kind: asset.kind,
          name: asset.originalName,
          url: services.mediaUrl(asset.storagePath),
          sizeBytes: asset.sizeBytes,
          purpose: purposes.get(asset.id) ?? "reference",
          ...(asset.width !== undefined ? { width: asset.width } : {}),
          ...(asset.height !== undefined ? { height: asset.height } : {}),
          ...(asset.durationSec !== undefined ? { durationSec: asset.durationSec } : {}),
        }));
        const entities = library.listEntities(params.id).map((entity) => ({
          id: entity.id,
          type: entity.type,
          name: entity.name,
          description: entity.description,
          referenceImageUrls: entity.referenceImagePaths.map((p) => services.mediaUrl(p)),
          voiceUrls: entity.voicePaths.map((p) => services.mediaUrl(p)),
        }));
        return { assets, entities };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .get("/api/projects/:id/canvas", ({ params, set }) => {
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      try {
        const plan = planFor(params.id);
        const items = library
          .listCanvasItems(params.id)
          .map((item) => canvasItemView(params.id, item, plan))
          .filter((view): view is CanvasItemView => view !== undefined);
        return { items };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .patch("/api/projects/:id/canvas/:itemId", ({ params, body, set }) => {
      const parsed = zCanvasPatchBody.safeParse(body ?? {});
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      const existing = library.listCanvasItems(params.id).find((i) => i.id === params.itemId);
      if (!existing) {
        set.status = 404;
        return `Canvas item not found in project ${params.id}: ${params.itemId}`;
      }
      try {
        const patch = parsed.data;
        const moved = library.moveCanvasItem(params.itemId, {
          x: patch.x ?? existing.x,
          y: patch.y ?? existing.y,
          ...(patch.w !== undefined ? { w: patch.w } : {}),
          ...(patch.h !== undefined ? { h: patch.h } : {}),
          ...(patch.z !== undefined ? { z: patch.z } : {}),
        });
        const view = canvasItemView(params.id, moved, planFor(params.id));
        return { item: view };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .post("/api/projects/:id/canvas/notes", ({ params, body, set }) => {
      const parsed = zNoteBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      try {
        const { text, x, y } = parsed.data;
        const item = library.upsertCanvasItem({
          projectId: params.id,
          refType: "note",
          refId: randomUUID(),
          x,
          y,
          z: 0,
          meta: { text },
        });
        const view = canvasItemView(params.id, item, undefined);
        return { item: view };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .get("/api/projects/:id/takes", ({ params, set }) => {
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      try {
        return { takes: library.listTakes(params.id).map(takeView) };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .post("/api/projects/:id/takes/:takeId/select", ({ params, set }) => {
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      const take = library.listTakes(params.id).find((t) => t.id === params.takeId);
      if (!take) {
        set.status = 404;
        return `Take not found in project ${params.id}: ${params.takeId}`;
      }
      const asset = library.getAsset(take.assetId);
      if (!asset) {
        set.status = 500;
        return `Take ${take.id} points at a missing asset: ${take.assetId}`;
      }
      try {
        const store = manager.get(params.id);
        const result = applyTake({
          store,
          shotId: take.shotId,
          assetId: take.assetId,
          assetSrc: asset.storagePath,
          ...(asset.durationSec !== undefined ? { durationSec: asset.durationSec } : {}),
        });
        library.selectTake(take.id);
        manager.save(params.id, store);
        return { summary: result.summary };
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .post("/api/projects/:id/shots/:shotId/retake", ({ params, body, set }) => {
      const parsed = zRetakeBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      const plan = planFor(params.id);
      if (!plan) {
        set.status = 409;
        return `Project ${params.id} has no plan yet — run the director first`;
      }
      if (!plan.shots.some((s) => s.id === params.shotId)) {
        set.status = 404;
        return `Shot not found in plan: ${params.shotId} (shots: ${plan.shots.map((s) => s.id).join(", ")})`;
      }
      const job = startRetakeJob(params.id, plan, params.shotId, parsed.data?.promptTweak);
      return { jobId: job.id };
    })

    .post("/api/projects/:id/edit", async ({ params, body, set }) => {
      const parsed = zEditBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      try {
        const store = manager.get(params.id);
        const config = services.getConfig();
        const result = await applyEditInstruction(store, parsed.data.instruction, {
          model: config.editorModel,
          effort: config.editorEffort,
          apiKey: effectiveEnv(config).ANTHROPIC_API_KEY,
        });
        manager.save(params.id, store);
        return result;
      } catch (err) {
        set.status = 500;
        return errorMessage(err);
      }
    })

    .post("/api/projects/:id/undo", ({ params, set }) => {
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      const store = manager.get(params.id);
      const summary = store.undo();
      manager.save(params.id, store);
      return { summary: summary ?? "nothing to undo" };
    })

    .post("/api/projects/:id/redo", ({ params, set }) => {
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      const store = manager.get(params.id);
      const summary = store.redo();
      manager.save(params.id, store);
      return { summary: summary ?? "nothing to redo" };
    })

    .post("/api/projects/:id/render", ({ params, body, set }) => {
      const parsed = zRenderBody.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return `Invalid body: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
      }
      if (!manager.has(params.id)) {
        set.status = 404;
        return `Project not found: ${params.id}`;
      }
      const job = startRenderJob(params.id, parsed.data?.draft ?? false);
      return { jobId: job.id };
    })

    .get("/media/*", async ({ params, set }) => {
      let rel = params["*"];
      try {
        rel = decodeURIComponent(rel);
      } catch {
        set.status = 400;
        return `Bad path: ${rel}`;
      }
      const abs = resolve(manager.root, rel);
      if (abs !== manager.root && !abs.startsWith(manager.root + sep)) {
        set.status = 403;
        return "Path escapes the media root";
      }
      if (!existsSync(abs)) {
        set.status = 404;
        return `Not found: /media/${rel}`;
      }
      return new Response(Bun.file(abs), {
        headers: { "content-type": contentTypeFor(abs) },
      });
    });

  return { app, manager, jobs, services };
}

if (import.meta.main) {
  const { app, manager } = createApp();
  app.listen(PORT);
  console.log(`vdx-agent-server listening on http://localhost:${PORT} (state: ${manager.root})`);
}
