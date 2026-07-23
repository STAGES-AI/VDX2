import { describe, expect, test } from "bun:test";
import { mt, ProjectStore, TICKS_PER_SECOND } from "../src";

function storeWithClip() {
  const store = ProjectStore.create({ name: "Test" });
  const project = store.getProject();
  const sceneId = project.currentSceneId;
  store.apply({
    type: "add_media_asset",
    params: {
      asset: {
        id: "clip1",
        type: "video",
        name: "Clip 1",
        src: "/tmp/clip1.mp4",
        duration: mt.fromSeconds(10),
        provenance: { kind: "mock" },
      },
    },
  });
  const result = store.apply({
    type: "insert_element",
    params: {
      sceneId,
      element: {
        type: "video",
        name: "Clip 1",
        mediaId: "clip1",
        startTime: 0,
        duration: mt.fromSeconds(5),
        trimStart: 0,
        trimEnd: mt.fromSeconds(5),
        sourceDuration: mt.fromSeconds(10),
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        opacity: 1,
        volume: 1,
      },
      placement: { mode: "auto" },
    },
  });
  return { store, sceneId, elementId: result.created!.elementId, trackId: result.created!.trackId };
}

describe("MediaTime", () => {
  test("second/tick round trip", () => {
    expect(mt.fromSeconds(1)).toBe(TICKS_PER_SECOND);
    expect(mt.toSeconds(mt.fromSeconds(3.5))).toBeCloseTo(3.5);
  });

  test("frame math is exact for common rates", () => {
    expect(mt.ticksPerFrame({ numerator: 30, denominator: 1 })).toBe(4000);
    expect(mt.ticksPerFrame({ numerator: 24, denominator: 1 })).toBe(5000);
    expect(mt.ticksPerFrame({ numerator: 24000, denominator: 1001 })).toBe(5005);
  });
});

describe("ProjectStore", () => {
  test("insert places element on main track", () => {
    const { store, trackId } = storeWithClip();
    const scene = store.getProject().scenes[0];
    expect(scene.tracks.main.id).toBe(trackId);
    expect(scene.tracks.main.elements).toHaveLength(1);
  });

  test("insert rejects unknown media", () => {
    const store = ProjectStore.create();
    const sceneId = store.getProject().currentSceneId;
    expect(() =>
      store.apply({
        type: "insert_element",
        params: {
          sceneId,
          element: {
            type: "video",
            name: "Ghost",
            mediaId: "nope",
            startTime: 0,
            duration: 1000,
            trimStart: 0,
            trimEnd: 0,
            transform: { x: 0, y: 0, scale: 1, rotation: 0 },
            opacity: 1,
            volume: 1,
          },
          placement: { mode: "auto" },
        },
      }),
    ).toThrow(/Unknown mediaId/);
  });

  test("auto placement avoids overlap by creating a track", () => {
    const { store, sceneId } = storeWithClip();
    store.apply({
      type: "insert_element",
      params: {
        sceneId,
        element: {
          type: "video",
          name: "Clip 2",
          mediaId: "clip1",
          startTime: mt.fromSeconds(2), // overlaps element on main
          duration: mt.fromSeconds(3),
          trimStart: 0,
          trimEnd: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          opacity: 1,
          volume: 1,
        },
        placement: { mode: "auto" },
      },
    });
    const scene = store.getProject().scenes[0];
    expect(scene.tracks.overlay).toHaveLength(1);
    expect(scene.tracks.overlay[0].elements).toHaveLength(1);
  });

  test("split produces two elements with correct trims", () => {
    const { store, sceneId, trackId, elementId } = storeWithClip();
    store.apply({
      type: "split_element",
      params: { sceneId, ref: { trackId, elementId }, atTime: mt.fromSeconds(2) },
    });
    const main = store.getProject().scenes[0].tracks.main;
    expect(main.elements).toHaveLength(2);
    const [left, right] = main.elements;
    expect(left.duration).toBe(mt.fromSeconds(2));
    expect(right.startTime).toBe(mt.fromSeconds(2));
    expect(right.duration).toBe(mt.fromSeconds(3));
    expect(right.trimStart).toBe(mt.fromSeconds(2));
  });

  test("undo/redo restores state", () => {
    const { store, sceneId, trackId, elementId } = storeWithClip();
    store.apply({
      type: "split_element",
      params: { sceneId, ref: { trackId, elementId }, atTime: mt.fromSeconds(2) },
    });
    expect(store.getProject().scenes[0].tracks.main.elements).toHaveLength(2);
    store.undo();
    expect(store.getProject().scenes[0].tracks.main.elements).toHaveLength(1);
    store.redo();
    expect(store.getProject().scenes[0].tracks.main.elements).toHaveLength(2);
  });

  test("userModified guard blocks agent edits and allows byUser", () => {
    const { store, sceneId, trackId, elementId } = storeWithClip();
    store.apply({
      type: "update_element",
      params: { sceneId, ref: { trackId, elementId }, patch: { opacity: 0.5 }, byUser: true },
    });
    expect(() =>
      store.apply({
        type: "update_element",
        params: { sceneId, ref: { trackId, elementId }, patch: { opacity: 0.1 }, byUser: false },
      }),
    ).toThrow(/userModified/);
    store.apply({
      type: "update_element",
      params: { sceneId, ref: { trackId, elementId }, patch: { opacity: 0.9 }, byUser: true },
    });
  });

  test("move rejects overlaps", () => {
    const { store, sceneId, trackId, elementId } = storeWithClip();
    const second = store.apply({
      type: "insert_element",
      params: {
        sceneId,
        element: {
          type: "video",
          name: "Clip 2",
          mediaId: "clip1",
          startTime: mt.fromSeconds(6),
          duration: mt.fromSeconds(2),
          trimStart: 0,
          trimEnd: 0,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          opacity: 1,
          volume: 1,
        },
        placement: { mode: "explicit", trackId },
      },
    });
    expect(() =>
      store.apply({
        type: "move_elements",
        params: {
          sceneId,
          moves: [
            { ref: { trackId, elementId: second.created!.elementId }, startTime: mt.fromSeconds(1) },
          ],
        },
      }),
    ).toThrow(/overlap/i);
  });

  test("batch rolls back atomically", () => {
    const { store, sceneId, trackId, elementId } = storeWithClip();
    expect(() =>
      store.applyBatch([
        {
          type: "update_element",
          params: { sceneId, ref: { trackId, elementId }, patch: { opacity: 0.4 }, byUser: false },
        },
        { type: "delete_elements", params: { sceneId, refs: [{ trackId, elementId: "missing" }] } },
      ]),
    ).toThrow();
    const el = store.getProject().scenes[0].tracks.main.elements[0];
    expect(el.opacity).toBe(1); // first command rolled back too
    expect(store.undoDepth).toBe(2); // asset + insert only
  });

  test("serialization round trip", () => {
    const { store } = storeWithClip();
    const json = store.serialize();
    const restored = ProjectStore.deserialize(json);
    expect(restored.getProject().scenes[0].tracks.main.elements).toHaveLength(1);
    expect(restored.getProject().mediaAssets).toHaveLength(1);
  });

  test("retime adjusts duration", () => {
    const { store, sceneId, trackId, elementId } = storeWithClip();
    store.apply({
      type: "retime_element",
      params: { sceneId, ref: { trackId, elementId }, rate: 2 },
    });
    const el = store.getProject().scenes[0].tracks.main.elements[0];
    expect(el.duration).toBe(mt.fromSeconds(2.5));
  });
});
