/**
 * Services tests focused on the two things the Settings feature depends on:
 *  - the Gateway is genuinely hot-swappable (proves the destructure bug
 *    described in services.ts's module docs is NOT present: a caller that
 *    calls getGateway() fresh always sees the current instance, and
 *    updateSettings() actually builds a new one rather than mutating in
 *    place or being ignored).
 *  - detachProject drops the library-side rows for a project without
 *    touching the underlying assets.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Services } from "./services";
import { createServices } from "./services";

let root: string;
let services: Services;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vdx-services-"));
  services = createServices({ root, log: () => {} });
});

afterEach(() => {
  services.close();
  rmSync(root, { recursive: true, force: true });
});

// -- gateway hot-reload (THE regression test for the critical bug) ----------

test("updateSettings swaps getGateway() to a NEW instance", () => {
  const before = services.getGateway();
  expect(before.isLive()).toBe(false); // no FAL/ElevenLabs key configured yet

  const view = services.updateSettings({ falApiKey: "test-fal-key-1234567890" });
  expect(view.falKeySet).toBe(true);

  const after = services.getGateway();
  expect(after).not.toBe(before); // identity check: a genuinely new instance
  expect(after.isLive()).toBe(true); // and it actually routes live now
});

test("a caller holding a getGateway() accessor (not a cached instance) always sees the latest gateway", () => {
  // This is the exact shape index.ts/mcp.ts must use: call services.getGateway()
  // fresh at the point of use rather than hoisting it to a closure variable.
  const liveGateway = () => services.getGateway();
  const first = liveGateway();
  services.updateSettings({ falApiKey: "another-test-key-1234567890" });
  const second = liveGateway();
  expect(second).not.toBe(first);
  expect(second.isLive()).toBe(true);
});

test("updateSettings with no relevant key change still returns a working gateway", () => {
  const before = services.getGateway();
  services.updateSettings({ plannerModel: "some-other-model" });
  const after = services.getGateway();
  // Every updateSettings call rebuilds the gateway (simple, always-correct
  // semantics) even when the patch didn't touch FAL/ElevenLabs keys.
  expect(after).not.toBe(before);
  expect(after.isLive()).toBe(false);
});

// -- settings view --------------------------------------------------------------

test("getSettingsView never exposes the raw key", () => {
  services.updateSettings({ anthropicApiKey: "sk-ant-realkeyvalue1234" });
  const view = services.getSettingsView();
  expect(view.anthropicKeySet).toBe(true);
  expect(view.anthropicKeyPreview).not.toBe("sk-ant-realkeyvalue1234");
  expect(view.anthropicKeyPreview).not.toContain("realkeyvalue");
});

test("getConfig returns the raw config (unmasked) for internal callers", () => {
  services.updateSettings({ plannerModel: "custom-planner", plannerEffort: "xhigh" });
  const config = services.getConfig();
  expect(config.plannerModel).toBe("custom-planner");
  expect(config.plannerEffort).toBe("xhigh");
});

// -- detachProject ----------------------------------------------------------

test("detachProject drops project_assets/canvas_items/takes but not the asset itself", async () => {
  const { id: projectId } = services.manager.create();
  const ingested = await services.library.ingest(
    { data: new TextEncoder().encode("hello world"), originalName: "note.txt" },
    { projectId, purpose: "reference" },
  );
  services.library.upsertCanvasItem({
    projectId,
    refType: "asset",
    refId: ingested.asset.id,
    x: 0,
    y: 0,
    z: 0,
    meta: {},
  });
  services.library.addTake({
    projectId,
    shotId: "shot-1",
    assetId: ingested.asset.id,
    prompt: "test take",
  });

  expect(services.assetPurposes(projectId).size).toBeGreaterThan(0);
  expect(services.library.listCanvasItems(projectId).length).toBeGreaterThan(0);
  expect(services.library.listTakes(projectId).length).toBeGreaterThan(0);

  services.detachProject(projectId);

  expect(services.assetPurposes(projectId).size).toBe(0);
  expect(services.library.listCanvasItems(projectId)).toEqual([]);
  expect(services.library.listTakes(projectId)).toEqual([]);
  // The asset survives — it may be shared/reused outside this project.
  expect(services.library.getAsset(ingested.asset.id)).toBeDefined();
});
