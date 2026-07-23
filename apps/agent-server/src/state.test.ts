import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMockPlan } from "@vdx/agent";
import { ProjectsManager } from "./state";

let root: string;
let manager: ProjectsManager;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vdx-state-"));
  manager = new ProjectsManager(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("create writes projects/<id>.json and returns a live store", () => {
  const { id, store } = manager.create();
  expect(existsSync(join(root, "projects", `${id}.json`))).toBe(true);
  expect(store.getProject().scenes.length).toBe(1);
});

test("layout directories exist after construction", () => {
  for (const dir of ["projects", "plans", "media", "cache", "renders", "tmp"]) {
    expect(existsSync(join(root, dir))).toBe(true);
  }
});

test("every dispatched command autosaves to disk", () => {
  const { id, store } = manager.create();
  store.dispatch({ type: "update_project_settings", params: { name: "Autosaved" } });
  const onDisk = JSON.parse(readFileSync(join(root, "projects", `${id}.json`), "utf8")) as {
    project: { metadata: { name: string } };
  };
  expect(onDisk.project.metadata.name).toBe("Autosaved");
});

test("get returns the same cached instance (undo history survives requests)", () => {
  const { id, store } = manager.create();
  store.dispatch({ type: "update_project_settings", params: { name: "Renamed" } });
  const again = manager.get(id);
  expect(again).toBe(store);
  expect(again.undoDepth).toBe(1);
  expect(again.undo()).toContain("settings");
});

test("get hydrates from disk in a fresh manager", () => {
  const { id, store } = manager.create();
  store.dispatch({ type: "update_project_settings", params: { name: "Persisted" } });
  const fresh = new ProjectsManager(root);
  expect(fresh.get(id).getProject().metadata.name).toBe("Persisted");
});

test("the file id stays canonical even when create_project replaces metadata.id", () => {
  const { id, store } = manager.create();
  const before = store.getProject().metadata.id;
  store.dispatch({
    type: "create_project",
    params: { name: "Replaced" },
  });
  expect(store.getProject().metadata.id).not.toBe(before);
  // Autosave still lands under the manager id, and list() reports it.
  expect(manager.list().map((p) => p.id)).toContain(id);
  expect(manager.get(id).getProject().metadata.name).toBe("Replaced");
});

test("get on an unknown id throws a helpful error", () => {
  expect(() => manager.get("nope")).toThrow(/Project not found: nope/);
});

test("get rejects path-traversal ids", () => {
  expect(() => manager.get("../evil")).toThrow(/Invalid project id/);
});

test("list returns id/name/updatedAt sorted newest first", async () => {
  const a = manager.create();
  a.store.dispatch({ type: "update_project_settings", params: { name: "Older" } });
  await Bun.sleep(5); // updatedAt has millisecond resolution
  const b = manager.create();
  b.store.dispatch({ type: "update_project_settings", params: { name: "Newer" } });
  const list = manager.list();
  expect(list.length).toBe(2);
  expect(list[0].id).toBe(b.id);
  expect(list[0].name).toBe("Newer");
  expect(list[1].name).toBe("Older");
});

test("plan round-trips through plans/<id>.json", () => {
  const { id } = manager.create();
  expect(manager.getPlan(id)).toBeUndefined();
  const plan = buildMockPlan("a neon city at night", 15);
  manager.savePlan(id, plan);
  const loaded = manager.getPlan(id);
  expect(loaded?.title).toBe(plan.title);
  expect(loaded?.shots.length).toBe(plan.shots.length);
});

test("renders index records urls and skips missing files", async () => {
  const { id } = manager.create();
  expect(manager.listRenders(id)).toEqual([]);
  await Bun.write(join(root, "renders", "real.mp4"), "x");
  const info = manager.addRender(id, "real.mp4");
  manager.addRender(id, "ghost.mp4"); // never written to disk
  expect(info.url).toBe("/media/renders/real.mp4");
  const listed = manager.listRenders(id);
  expect(listed.length).toBe(1);
  expect(listed[0].url).toBe("/media/renders/real.mp4");
  expect(listed[0].createdAt).toBeTruthy();
});

// -- rename -------------------------------------------------------------------

test("rename persists across a fresh manager (reload via get)", () => {
  const { id } = manager.create();
  manager.rename(id, "New Name");
  expect(manager.get(id).getProject().metadata.name).toBe("New Name");

  const fresh = new ProjectsManager(root);
  expect(fresh.get(id).getProject().metadata.name).toBe("New Name");
  expect(fresh.list().find((p) => p.id === id)?.name).toBe("New Name");
});

// -- duplicate ----------------------------------------------------------------

test("duplicate produces a new id, independent state, and a (copy) suffix", () => {
  const { id, store } = manager.create();
  store.dispatch({ type: "update_project_settings", params: { name: "Original" } });

  const { newId } = manager.duplicate(id);
  expect(newId).not.toBe(id);

  const copy = manager.get(newId);
  expect(copy.getProject().metadata.name).toBe("Original (copy)");
  expect(copy.getProject().metadata.id).not.toBe(store.getProject().metadata.id);

  // Mutate the copy — the original is untouched.
  copy.dispatch({ type: "update_project_settings", params: { name: "Mutated Copy" } });
  expect(manager.get(newId).getProject().metadata.name).toBe("Mutated Copy");
  expect(manager.get(id).getProject().metadata.name).toBe("Original");

  // Both persisted independently to disk.
  const fresh = new ProjectsManager(root);
  expect(fresh.get(id).getProject().metadata.name).toBe("Original");
  expect(fresh.get(newId).getProject().metadata.name).toBe("Mutated Copy");
});

test("duplicate carries the plan over under the new id when one exists", () => {
  const { id } = manager.create();
  const plan = buildMockPlan("a neon city at night", 15);
  manager.savePlan(id, plan);

  const { newId } = manager.duplicate(id);
  const copiedPlan = manager.getPlan(newId);
  expect(copiedPlan?.title).toBe(plan.title);
  expect(copiedPlan?.shots.length).toBe(plan.shots.length);
});

test("duplicate without a plan leaves the copy plan-less", () => {
  const { id } = manager.create();
  const { newId } = manager.duplicate(id);
  expect(manager.getPlan(newId)).toBeUndefined();
});

// -- delete ---------------------------------------------------------------------

test("delete removes the project files; get/list no longer show it", () => {
  const { id } = manager.create();
  const plan = buildMockPlan("a quiet mountain lake", 10);
  manager.savePlan(id, plan);
  expect(existsSync(join(root, "projects", `${id}.json`))).toBe(true);
  expect(existsSync(join(root, "plans", `${id}.json`))).toBe(true);

  manager.delete(id);

  expect(existsSync(join(root, "projects", `${id}.json`))).toBe(false);
  expect(existsSync(join(root, "plans", `${id}.json`))).toBe(false);
  expect(manager.has(id)).toBe(false);
  expect(manager.list().map((p) => p.id)).not.toContain(id);
  expect(() => manager.get(id)).toThrow(/Project not found/);
});

test("delete on a project with no plan file does not throw", () => {
  const { id } = manager.create();
  expect(() => manager.delete(id)).not.toThrow();
  expect(manager.has(id)).toBe(false);
});
