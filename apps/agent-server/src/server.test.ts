/**
 * HTTP contract tests against the Elysia app via app.handle (no port bound).
 * The full director+render pipeline is exercised by demo.ts; these cover the
 * request/response contract and the guardrails, plus the library-backed
 * endpoints (uploads, draft/gate flows, canvas, takes, retakes) — director
 * runs use the mock gateway, so they generate real media quickly offline.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TProject } from "@vdx/timeline";
import type { AppContext } from "./index";
import { createApp } from "./index";

let root: string;
let ctx: AppContext;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vdx-server-"));
  ctx = createApp({ root });
});

afterEach(() => {
  ctx.services.close();
  rmSync(root, { recursive: true, force: true });
});

const url = (path: string) => `http://localhost/${path.replace(/^\//, "")}`;

function post(path: string, body?: unknown): Request {
  return new Request(url(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function patch(path: string, body: unknown): Request {
  return new Request(url(path), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 120_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Wait until a job settles; fails the test when the job errored. */
async function waitForJob(jobId: string, label: string): Promise<void> {
  const job = ctx.jobs.get(jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  await waitFor(() => job.settled, `${label} (job ${jobId})`);
  const error = job.events.find((e) => e.stage === "error");
  if (error) throw new Error(`${label} failed: ${error.message}`);
}

const BRIEF_MD = [
  "# NEON RAIN treatment",
  "",
  "A courier races a storm through the neon district.",
  "",
  "The city blurs; the package glows.",
  "",
  "## Character: Kade",
  "A weathered courier in a reflective jacket.",
  "",
  "## Style: Neon Noir",
  "rain-soaked neon noir, cyan and magenta highlights",
  "",
].join("\n");

interface UploadResultItem {
  assetId: string;
  kind: string;
  name: string;
  url: string;
  sizeBytes: number;
  duplicate: boolean;
  organization: {
    summary: string;
    linkedEntities: Array<{ entityId: string; name: string; type: string; created: boolean }>;
  } | null;
}

async function uploadBrief(projectId: string): Promise<UploadResultItem> {
  const form = new FormData();
  form.append(
    "files",
    new File([BRIEF_MD], "brief_neon_rain.md", { type: "text/markdown" }),
    "brief_neon_rain.md",
  );
  form.append("projectId", projectId);
  form.append("purpose", "brief");
  const res = await ctx.app.handle(new Request(url("/api/uploads"), { method: "POST", body: form }));
  const body = await json<{ results: UploadResultItem[] }>(res);
  expect(body.results).toHaveLength(1);
  return body.results[0];
}

function mainElements(project: TProject) {
  const scene = project.scenes.find((s) => s.id === project.currentSceneId)!;
  return scene.tracks.main.elements;
}

test("GET / health", async () => {
  const res = await ctx.app.handle(new Request(url("/")));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { ok: boolean; service: string };
  expect(json.ok).toBe(true);
  expect(json.service).toBe("vdx-agent-server");
});

test("GET /api/projects starts empty and reflects created projects", async () => {
  const empty = (await (await ctx.app.handle(new Request(url("/api/projects")))).json()) as {
    projects: unknown[];
  };
  expect(empty.projects).toEqual([]);

  const { id } = ctx.manager.create();
  const listed = (await (await ctx.app.handle(new Request(url("/api/projects")))).json()) as {
    projects: Array<{ id: string }>;
  };
  expect(listed.projects.map((p) => p.id)).toContain(id);
});

test("GET /api/projects/:id returns project + empty plan/renders", async () => {
  const { id } = ctx.manager.create();
  const res = await ctx.app.handle(new Request(url(`/api/projects/${id}`)));
  expect(res.status).toBe(200);
  const json = (await res.json()) as {
    project: { metadata: { name: string } };
    plan?: unknown;
    renders: unknown[];
  };
  expect(json.project.metadata.name).toBe("Untitled");
  expect(json.plan ?? null).toBeNull();
  expect(json.renders).toEqual([]);
});

test("GET /api/projects/:id → 404 for unknown ids", async () => {
  const res = await ctx.app.handle(new Request(url("/api/projects/does-not-exist")));
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("does-not-exist");
});

test("POST /api/projects without a brief → 400", async () => {
  const res = await ctx.app.handle(post("/api/projects", {}));
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Invalid body");
});

test("undo/redo round-trip over HTTP shares one store", async () => {
  const { id, store } = ctx.manager.create();
  store.dispatch({ type: "update_project_settings", params: { name: "Edited" } });

  const undo = (await (await ctx.app.handle(post(`/api/projects/${id}/undo`))).json()) as {
    summary: string;
  };
  expect(undo.summary).toContain("settings");
  expect(store.getProject().metadata.name).toBe("Untitled");

  const redo = (await (await ctx.app.handle(post(`/api/projects/${id}/redo`))).json()) as {
    summary: string;
  };
  expect(redo.summary).toContain("settings");
  expect(store.getProject().metadata.name).toBe("Edited");

  const noop = (await (await ctx.app.handle(post(`/api/projects/${id}/redo`))).json()) as {
    summary: string;
  };
  expect(noop.summary).toBe("nothing to redo");
});

test("POST /api/projects/:id/edit applies the offline instruction set", async () => {
  const { id } = ctx.manager.create();
  const res = await ctx.app.handle(post(`/api/projects/${id}/edit`, { instruction: "undo" }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { reply: string; applied: string[] };
  expect(json.reply).toContain("Nothing to undo");
  expect(json.applied).toEqual([]);
});

test("SSE stream replays a settled job and closes", async () => {
  const job = ctx.jobs.createJob();
  job.emit({ stage: "planning", message: "hello" });
  job.emit({ stage: "done", message: "all done" });
  job.done();

  const res = await ctx.app.handle(new Request(url(`/api/jobs/${job.id}/stream`)));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const body = await res.text(); // resolves because the stream closes on settle
  const frames = body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice("data: ".length)) as { stage: string });
  expect(frames.map((f) => f.stage)).toEqual(["planning", "done"]);
});

test("SSE stream → 404 for unknown jobs", async () => {
  const res = await ctx.app.handle(new Request(url("/api/jobs/nope/stream")));
  expect(res.status).toBe(404);
});

test("/media/* serves files from .vdx with content types", async () => {
  await Bun.write(join(root, "renders", "clip.mp4"), "fake-mp4-bytes");
  const res = await ctx.app.handle(new Request(url("/media/renders/clip.mp4")));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("video/mp4");
  expect(await res.text()).toBe("fake-mp4-bytes");
});

test("/media/* refuses path traversal out of .vdx", async () => {
  const res = await ctx.app.handle(new Request(url("/media/..%2F..%2Fetc%2Fpasswd")));
  expect([400, 403, 404]).toContain(res.status);
  if (res.status !== 404) {
    expect(await res.text()).not.toContain("root:");
  }
});

test("/media/* → 404 for missing files", async () => {
  const res = await ctx.app.handle(new Request(url("/media/renders/ghost.mp4")));
  expect(res.status).toBe(404);
});

test("POST /api/projects/:id/render → 404 for unknown project", async () => {
  const res = await ctx.app.handle(post("/api/projects/ghost/render", { draft: true }));
  expect(res.status).toBe(404);
});

// -- uploads -----------------------------------------------------------------

test("POST /api/uploads ingests multipart files with organization + /media urls", async () => {
  const draft = await json<{ projectId: string }>(await ctx.app.handle(post("/api/projects/draft", {})));

  const item = await uploadBrief(draft.projectId);
  expect(item.kind).toBe("document");
  expect(item.name).toBe("brief_neon_rain.md");
  expect(item.sizeBytes).toBeGreaterThan(0);
  expect(item.duplicate).toBe(false);
  expect(item.url).toStartWith("/media/library/");
  expect(item.organization).not.toBeNull();
  const linked = item.organization!.linkedEntities;
  expect(linked.some((e) => e.name === "Kade" && e.type === "character")).toBe(true);
  expect(linked.some((e) => e.name === "Neon Noir" && e.type === "style")).toBe(true);

  // Asset row exists in the shared library and the url is actually served.
  expect(ctx.services.library.getAsset(item.assetId)?.originalName).toBe("brief_neon_rain.md");
  const served = await ctx.app.handle(new Request(url(item.url)));
  expect(served.status).toBe(200);
  expect(await served.text()).toBe(BRIEF_MD);

  // Re-uploading the same bytes dedupes.
  const again = await uploadBrief(draft.projectId);
  expect(again.assetId).toBe(item.assetId);
  expect(again.duplicate).toBe(true);

  // GET library reflects the asset (purpose brief) + entities with urls.
  const library = await json<{
    assets: Array<{ assetId: string; purpose: string; url: string }>;
    entities: Array<{ name: string; type: string; referenceImageUrls: string[] }>;
  }>(await ctx.app.handle(new Request(url(`/api/projects/${draft.projectId}/library`))));
  const briefAsset = library.assets.find((a) => a.assetId === item.assetId);
  expect(briefAsset?.purpose).toBe("brief");
  expect(library.entities.some((e) => e.name === "Kade" && e.type === "character")).toBe(true);
});

test("POST /api/uploads without files → 400", async () => {
  const form = new FormData();
  form.append("projectId", "whatever");
  const res = await ctx.app.handle(new Request(url("/api/uploads"), { method: "POST", body: form }));
  expect(res.status).toBe(400);
});

// -- draft + grounded director run -------------------------------------------

test(
  "draft project is reused by POST /api/projects and uploads ground the plan",
  async () => {
    const draft = await json<{ projectId: string }>(
      await ctx.app.handle(post("/api/projects/draft", {})),
    );
    const upload = await uploadBrief(draft.projectId);
    const kadeId = upload.organization!.linkedEntities.find((e) => e.name === "Kade")!.entityId;

    const created = await json<{ projectId: string; jobId: string }>(
      await ctx.app.handle(
        post("/api/projects", { brief: "neon rain chase", targetDurationSec: 8, projectId: draft.projectId }),
      ),
    );
    expect(created.projectId).toBe(draft.projectId);
    await waitForJob(created.jobId, "grounded director run");

    // Plan grounded in the uploaded brief: title from its first line, every
    // shot cast with the Kade entity (mock planner cycles context cast).
    const plan = ctx.manager.getPlan(created.projectId)!;
    expect(plan.title).toBe("NEON RAIN treatment");
    expect(plan.shots.length).toBeGreaterThan(0);
    for (const shot of plan.shots) {
      expect(shot.entityIds).toContain(kadeId);
      expect(shot.visualPrompt).toContain("Kade");
    }

    // One selected take per shot, served from the library blob store.
    const takes = await json<{
      takes: Array<{ shotId: string; url: string; selected: boolean }>;
    }>(await ctx.app.handle(new Request(url(`/api/projects/${created.projectId}/takes`))));
    expect(takes.takes).toHaveLength(plan.shots.length);
    for (const shot of plan.shots) {
      const take = takes.takes.find((t) => t.shotId === shot.id);
      expect(take?.selected).toBe(true);
      expect(take?.url).toStartWith("/media/library/");
    }

    // Canvas now shows the upload, entities, and one card per shot with media.
    const canvas = await json<{
      items: Array<{ refType: string; refId: string; payload: Record<string, unknown> }>;
    }>(await ctx.app.handle(new Request(url(`/api/projects/${created.projectId}/canvas`))));
    expect(canvas.items.some((i) => i.refType === "asset" && i.refId === upload.assetId)).toBe(true);
    expect(canvas.items.some((i) => i.refType === "entity" && i.refId === kadeId)).toBe(true);
    const shotCards = canvas.items.filter((i) => i.refType === "shot");
    expect(shotCards).toHaveLength(plan.shots.length);
    for (const card of shotCards) {
      expect(String(card.payload.clipUrl)).toStartWith("/media/library/");
      expect(String(card.payload.keyframeUrl)).toStartWith("/media/library/");
    }
  },
  240_000,
);

// -- approval gate ------------------------------------------------------------

test(
  "gated run pauses at awaiting_approval until POST /api/jobs/:id/approve",
  async () => {
    const created = await json<{ projectId: string; jobId: string }>(
      await ctx.app.handle(
        post("/api/projects", { brief: "a quiet mountain lake", targetDurationSec: 8, gate: true }),
      ),
    );
    const job = ctx.jobs.get(created.jobId)!;

    await waitFor(
      () => job.events.some((e) => e.stage === "awaiting_approval"),
      "awaiting_approval event",
    );
    expect(job.settled).toBe(false);
    // The plan is already persisted while the gate holds.
    expect(ctx.manager.getPlan(created.projectId)).toBeDefined();
    // And no generation has started yet.
    expect(job.events.some((e) => e.stage === "keyframe")).toBe(false);

    const approved = await json<{ ok: boolean }>(
      await ctx.app.handle(post(`/api/jobs/${created.jobId}/approve`)),
    );
    expect(approved.ok).toBe(true);
    await waitForJob(created.jobId, "gated director run");
    expect(job.events.some((e) => e.stage === "done")).toBe(true);
    expect(mainElements(ctx.manager.get(created.projectId).getProject()).length).toBeGreaterThan(0);
  },
  240_000,
);

test("POST /api/jobs/:id/approve → 404 for unknown jobs", async () => {
  const res = await ctx.app.handle(post("/api/jobs/nope/approve"));
  expect(res.status).toBe(404);
});

// -- canvas -------------------------------------------------------------------

test("canvas GET/PATCH/notes round-trip", async () => {
  const draft = await json<{ projectId: string }>(await ctx.app.handle(post("/api/projects/draft", {})));
  const upload = await uploadBrief(draft.projectId);

  // Add a note.
  const note = await json<{ item: { id: string; refType: string; payload: { text: string } } }>(
    await ctx.app.handle(
      post(`/api/projects/${draft.projectId}/canvas/notes`, { text: "tighter pacing", x: 500, y: 300 }),
    ),
  );
  expect(note.item.refType).toBe("note");
  expect(note.item.payload.text).toBe("tighter pacing");

  // Move it.
  const moved = await json<{ item: { x: number; y: number; z: number } }>(
    await ctx.app.handle(
      patch(`/api/projects/${draft.projectId}/canvas/${note.item.id}`, { x: 111, y: 222, z: 3 }),
    ),
  );
  expect(moved.item.x).toBe(111);
  expect(moved.item.y).toBe(222);
  expect(moved.item.z).toBe(3);

  // GET reflects the upload's asset card + the moved note with payloads.
  const canvas = await json<{
    items: Array<{ id: string; refType: string; refId: string; x: number; y: number; payload: Record<string, unknown> }>;
  }>(await ctx.app.handle(new Request(url(`/api/projects/${draft.projectId}/canvas`))));
  const assetCard = canvas.items.find((i) => i.refType === "asset" && i.refId === upload.assetId);
  expect(assetCard).toBeDefined();
  expect(String(assetCard!.payload.url)).toBe(upload.url);
  const noteCard = canvas.items.find((i) => i.id === note.item.id);
  expect(noteCard?.x).toBe(111);
  expect(noteCard?.y).toBe(222);

  // Unknown item → 404.
  const missing = await ctx.app.handle(
    patch(`/api/projects/${draft.projectId}/canvas/ghost`, { x: 1, y: 2 }),
  );
  expect(missing.status).toBe(404);
});

// -- takes + retake -----------------------------------------------------------

test(
  "retake creates a second take and select swaps the element's mediaId",
  async () => {
    const created = await json<{ projectId: string; jobId: string }>(
      await ctx.app.handle(post("/api/projects", { brief: "city of glass at night", targetDurationSec: 8 })),
    );
    await waitForJob(created.jobId, "director run");
    const projectId = created.projectId;

    const firstTakes = ctx.services.library.listTakes(projectId, "shot-2");
    expect(firstTakes).toHaveLength(1);
    const take1 = firstTakes[0];
    expect(take1.selected).toBe(true);

    // Retake shot-2 with a tweak.
    const retake = await json<{ jobId: string }>(
      await ctx.app.handle(
        post(`/api/projects/${projectId}/shots/shot-2/retake`, { promptTweak: "closer framing" }),
      ),
    );
    await waitForJob(retake.jobId, "retake");
    const retakeJob = ctx.jobs.get(retake.jobId)!;
    expect(retakeJob.events.some((e) => e.stage === "retake")).toBe(true);

    const afterRetake = ctx.services.library.listTakes(projectId, "shot-2");
    expect(afterRetake).toHaveLength(2);
    const take2 = afterRetake.find((t) => t.id !== take1.id)!;
    expect(take2.selected).toBe(true);
    expect(take2.prompt).toContain("closer framing");
    expect(afterRetake.find((t) => t.id === take1.id)!.selected).toBe(false);

    // The timeline element now plays the retake's clip (bin id == library id).
    const element = () =>
      mainElements(ctx.manager.get(projectId).getProject()).find((el) => el.name === "shot-2")!;
    expect((element() as { mediaId: string }).mediaId).toBe(take2.assetId);

    // The HTTP takes view agrees.
    const takesView = await json<{ takes: Array<{ id: string; shotId: string; selected: boolean }> }>(
      await ctx.app.handle(new Request(url(`/api/projects/${projectId}/takes`))),
    );
    expect(takesView.takes.filter((t) => t.shotId === "shot-2")).toHaveLength(2);
    expect(takesView.takes.find((t) => t.id === take2.id)?.selected).toBe(true);

    // Select take 1 back: element mediaId flips, selection persists, disk saved.
    const selected = await json<{ summary: string }>(
      await ctx.app.handle(post(`/api/projects/${projectId}/takes/${take1.id}/select`)),
    );
    expect(selected.summary).toContain("shot-2");
    expect((element() as { mediaId: string }).mediaId).toBe(take1.assetId);
    expect(ctx.services.library.listTakes(projectId, "shot-2").find((t) => t.id === take1.id)!.selected).toBe(true);

    const onDisk = JSON.parse(
      readFileSync(join(root, "projects", `${projectId}.json`), "utf8"),
    ) as { project: TProject };
    const diskElement = mainElements(onDisk.project).find((el) => el.name === "shot-2")!;
    expect((diskElement as { mediaId: string }).mediaId).toBe(take1.assetId);

    // Retake of an unknown shot → 404 (plan exists but shot doesn't).
    const badShot = await ctx.app.handle(post(`/api/projects/${projectId}/shots/shot-99/retake`, {}));
    expect(badShot.status).toBe(404);
  },
  240_000,
);

test("retake without a plan → 409", async () => {
  const draft = await json<{ projectId: string }>(await ctx.app.handle(post("/api/projects/draft", {})));
  const res = await ctx.app.handle(post(`/api/projects/${draft.projectId}/shots/shot-1/retake`, {}));
  expect(res.status).toBe(409);
});

test("POST /api/projects with unknown projectId → 404", async () => {
  const res = await ctx.app.handle(post("/api/projects", { brief: "x", projectId: "ghost" }));
  expect(res.status).toBe(404);
});

// -- settings -----------------------------------------------------------------

function put(path: string, body: unknown): Request {
  return new Request(url(path), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("GET /api/settings starts at defaults with no keys set", async () => {
  const settings = await json<{
    anthropicKeySet: boolean;
    falKeySet: boolean;
    elevenLabsKeySet: boolean;
    plannerModel: string;
    plannerEffort: string;
    editorModel: string;
    editorEffort: string;
  }>(await ctx.app.handle(new Request(url("/api/settings"))));
  expect(settings.anthropicKeySet).toBe(false);
  expect(settings.falKeySet).toBe(false);
  expect(settings.elevenLabsKeySet).toBe(false);
  expect(settings.plannerModel).toBeTruthy();
  expect(settings.editorEffort).toBeTruthy();
});

test("PUT then GET /api/settings round-trips with masked previews, never the raw key", async () => {
  const RAW_KEY = "sk-ant-supersecretvalue1234";
  const putRes = await json<{ anthropicKeySet: boolean; anthropicKeyPreview: string | null }>(
    await ctx.app.handle(
      put("/api/settings", { anthropicApiKey: RAW_KEY, plannerModel: "test-model", plannerEffort: "low" }),
    ),
  );
  expect(putRes.anthropicKeySet).toBe(true);
  expect(putRes.anthropicKeyPreview).not.toBe(RAW_KEY);
  expect(putRes.anthropicKeyPreview).not.toContain("supersecretvalue");

  const getRes = await json<{
    anthropicKeySet: boolean;
    anthropicKeyPreview: string | null;
    plannerModel: string;
    plannerEffort: string;
  }>(await ctx.app.handle(new Request(url("/api/settings"))));
  expect(getRes.anthropicKeySet).toBe(true);
  expect(getRes.anthropicKeyPreview).toBe(putRes.anthropicKeyPreview);
  expect(getRes.anthropicKeyPreview).not.toContain("supersecretvalue");
  expect(getRes.plannerModel).toBe("test-model");
  expect(getRes.plannerEffort).toBe("low");
});

test("PUT /api/settings with an empty string clears a previously-set key", async () => {
  await ctx.app.handle(put("/api/settings", { falApiKey: "fal-key-1234567890" }));
  const cleared = await json<{ falKeySet: boolean; falKeyPreview: string | null }>(
    await ctx.app.handle(put("/api/settings", { falApiKey: "" })),
  );
  expect(cleared.falKeySet).toBe(false);
  expect(cleared.falKeyPreview).toBeNull();
});

test("PUT /api/settings rejects an invalid effort value", async () => {
  const res = await ctx.app.handle(put("/api/settings", { plannerEffort: "extreme" }));
  expect(res.status).toBe(400);
});

// -- project rename/duplicate/delete -------------------------------------------

test("PATCH /api/projects/:id renames a project", async () => {
  const draft = await json<{ projectId: string }>(await ctx.app.handle(post("/api/projects/draft", {})));
  const renamed = await json<{ summary: string }>(
    await ctx.app.handle(patch(`/api/projects/${draft.projectId}`, { name: "Renamed Draft" })),
  );
  expect(renamed.summary).toContain("Renamed Draft");

  const got = await json<{ project: { metadata: { name: string } } }>(
    await ctx.app.handle(new Request(url(`/api/projects/${draft.projectId}`))),
  );
  expect(got.project.metadata.name).toBe("Renamed Draft");
});

test("PATCH /api/projects/:id → 404 for unknown project", async () => {
  const res = await ctx.app.handle(patch("/api/projects/ghost", { name: "x" }));
  expect(res.status).toBe(404);
});

test("PATCH /api/projects/:id → 400 for an empty name", async () => {
  const draft = await json<{ projectId: string }>(await ctx.app.handle(post("/api/projects/draft", {})));
  const res = await ctx.app.handle(patch(`/api/projects/${draft.projectId}`, { name: "" }));
  expect(res.status).toBe(400);
});

test("POST /api/projects/:id/duplicate clones a project under a fresh id", async () => {
  const draft = await json<{ projectId: string }>(await ctx.app.handle(post("/api/projects/draft", {})));
  await ctx.app.handle(patch(`/api/projects/${draft.projectId}`, { name: "Source" }));

  const dup = await json<{ projectId: string }>(
    await ctx.app.handle(post(`/api/projects/${draft.projectId}/duplicate`)),
  );
  expect(dup.projectId).not.toBe(draft.projectId);

  const got = await json<{ project: { metadata: { name: string } } }>(
    await ctx.app.handle(new Request(url(`/api/projects/${dup.projectId}`))),
  );
  expect(got.project.metadata.name).toBe("Source (copy)");
});

test("POST /api/projects/:id/duplicate → 404 for unknown project", async () => {
  const res = await ctx.app.handle(post("/api/projects/ghost/duplicate"));
  expect(res.status).toBe(404);
});

test("DELETE /api/projects/:id removes the project and detaches library rows", async () => {
  const draft = await json<{ projectId: string }>(await ctx.app.handle(post("/api/projects/draft", {})));
  const upload = await uploadBrief(draft.projectId);
  expect(ctx.services.assetPurposes(draft.projectId).size).toBeGreaterThan(0);

  const del = await json<{ ok: boolean }>(
    await ctx.app.handle(new Request(url(`/api/projects/${draft.projectId}`), { method: "DELETE" })),
  );
  expect(del.ok).toBe(true);

  const missing = await ctx.app.handle(new Request(url(`/api/projects/${draft.projectId}`)));
  expect(missing.status).toBe(404);
  expect(ctx.manager.list().map((p) => p.id)).not.toContain(draft.projectId);
  expect(ctx.services.assetPurposes(draft.projectId).size).toBe(0);
  // The uploaded asset itself is untouched by detaching the project.
  expect(ctx.services.library.getAsset(upload.assetId)).toBeDefined();
});

test("DELETE /api/projects/:id → 404 for unknown project", async () => {
  const res = await ctx.app.handle(new Request(url("/api/projects/ghost"), { method: "DELETE" }));
  expect(res.status).toBe(404);
});
