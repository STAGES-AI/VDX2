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
