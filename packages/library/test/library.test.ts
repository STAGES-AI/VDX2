import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLibrarianPrompt,
  createLibrary,
  extractDocxViaUnzip,
  extractText,
  parseLibrarianResponse,
  stripDocxXml,
  suggestFromFilename,
  suggestFromMarkdown,
  type LibrarianClient,
  type LibrarianPrompt,
  type Library,
} from "../src";

// 1x1 red PNG — a real, probe-able image.
const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const roots: string[] = [];
const libraries: Library[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "vdx-library-"));
  roots.push(dir);
  return dir;
}

/** Fresh library on a tmp rootDir; env: {} forces the offline heuristic. */
function makeLibrary(extra?: { librarianClient?: LibrarianClient }): Library {
  const library = createLibrary({ rootDir: tmpRoot(), env: {}, ...extra });
  libraries.push(library);
  return library;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

afterAll(() => {
  for (const library of libraries) library.close();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("ingest: markdown brief", () => {
  test("brief filename -> purpose brief, brief entity, FTS, full text in context", async () => {
    const library = makeLibrary();
    const text =
      "Neon Dreams is a moody synthwave chase through a rain-soaked city at night. " +
      "A courier races the sunrise to deliver one last package.";
    const result = await library.ingest(
      { data: bytes(text), originalName: "brief.md" },
      { projectId: "proj-1" },
    );

    expect(result.duplicate).toBe(false);
    expect(result.asset.kind).toBe("document");
    expect(result.asset.mime).toBe("text/markdown");
    expect(result.document?.extractionMethod).toBe("plain");
    expect(result.document?.wordCount).toBeGreaterThan(10);

    const briefEntity = result.organization?.linkedEntities.find((e) => e.type === "brief");
    expect(briefEntity).toBeDefined();
    expect(briefEntity?.created).toBe(true);

    // FTS finds the document text.
    const hits = library.search("synthwave");
    expect(hits.some((h) => h.refType === "asset" && h.refId === result.asset.id)).toBe(true);
    expect(hits[0]!.snippet).toContain("[synthwave]");

    // Context carries the full brief text (purpose='brief').
    const context = library.getProjectContext("proj-1");
    expect(context.briefs).toHaveLength(1);
    expect(context.briefs[0]!.name).toBe("brief.md");
    expect(context.briefs[0]!.text).toBe(text);
    expect(context.documents).toHaveLength(0);
  });
});

describe("ingest: reference image", () => {
  test("character_mara.png -> character entity linked + canvas items", async () => {
    const library = makeLibrary();
    const result = await library.ingest(
      { data: TINY_PNG, originalName: "character_mara.png" },
      { projectId: "proj-2" },
    );

    expect(result.duplicate).toBe(false);
    expect(result.asset.kind).toBe("image");
    if (Bun.which("ffprobe")) {
      expect(result.asset.width).toBe(1);
      expect(result.asset.height).toBe(1);
    }

    const linked = result.organization?.linkedEntities ?? [];
    expect(linked).toHaveLength(1);
    expect(linked[0]!.type).toBe("character");
    expect(linked[0]!.name).toBe("Mara");
    expect(linked[0]!.created).toBe(true);

    const mara = library.getEntity(linked[0]!.entityId);
    expect(mara?.referenceImagePaths).toEqual([result.asset.storagePath]);

    // Entity name is FTS-indexed.
    const hits = library.search("mara");
    expect(hits.some((h) => h.refType === "entity" && h.refId === linked[0]!.entityId)).toBe(true);

    // Canvas: asset at grid slot 0, entity at slot 1.
    const items = library.listCanvasItems("proj-2");
    const assetItem = items.find((i) => i.refType === "asset" && i.refId === result.asset.id);
    const entityItem = items.find((i) => i.refType === "entity" && i.refId === linked[0]!.entityId);
    expect(assetItem).toMatchObject({ x: 40, y: 40, w: 220, h: 170 });
    expect(entityItem).toMatchObject({ x: 280, y: 40, w: 240, h: 120 });
  });

  test("duplicate upload dedupes: same asset id, no second canvas item", async () => {
    const library = makeLibrary();
    const first = await library.ingest(
      { data: TINY_PNG, originalName: "character_mara.png" },
      { projectId: "proj-3" },
    );
    const canvasBefore = library.listCanvasItems("proj-3").length;

    const second = await library.ingest(
      { data: TINY_PNG, originalName: "character_mara_copy.png" },
      { projectId: "proj-3" },
    );
    expect(second.duplicate).toBe(true);
    expect(second.asset.id).toBe(first.asset.id);
    expect(library.listAssets({ kind: "image" })).toHaveLength(1);
    expect(library.listCanvasItems("proj-3")).toHaveLength(canvasBefore);
  });
});

describe("ingest: markdown entity headings", () => {
  test("Character:/— headings create entities with section descriptions", async () => {
    const library = makeLibrary();
    // Existing Mara (empty description) should be reused, not duplicated.
    const image = await library.ingest(
      { data: TINY_PNG, originalName: "character_mara.png" },
      { projectId: "proj-4" },
    );
    const maraId = image.organization!.linkedEntities[0]!.entityId;

    const md = [
      "# World notes",
      "",
      "## Character: Mara",
      "A rogue courier in a chrome jacket.",
      "",
      "## Neon Alley — location",
      "A rain-slick alley lit by pink signage.",
    ].join("\n");
    const result = await library.ingest(
      { data: bytes(md), originalName: "world_notes.md" },
      { projectId: "proj-4" },
    );

    const linked = result.organization?.linkedEntities ?? [];
    const mara = linked.find((e) => e.name === "Mara");
    const alley = linked.find((e) => e.name === "Neon Alley");
    expect(mara).toMatchObject({ entityId: maraId, type: "character", created: false });
    expect(alley).toMatchObject({ type: "location", created: true });

    // Reused Mara picked up the section text as description.
    expect(library.getEntity(maraId)?.description).toContain("chrome jacket");
    expect(library.getEntity(alley!.entityId)?.description).toContain("pink signage");
    // Document linked to both entities with role 'document'.
    expect(library.getEntity(maraId)?.documentAssetIds).toContain(result.asset.id);
  });

  test("suggestion helpers: filenames and heading forms", () => {
    expect(suggestFromFilename("style_neon_palette.png", "image")).toMatchObject({
      type: "style",
      name: "Neon",
    });
    expect(suggestFromFilename("voice_mara.wav", "audio")).toMatchObject({ type: "voice", name: "Mara" });
    // 'voice' keyword is audio-only; as an image it is just a name token.
    expect(suggestFromFilename("voice_mara.png", "image")).toBeUndefined();
    expect(suggestFromFilename("holiday_photo.png", "image")).toBeUndefined();
    expect(suggestFromFilename("treatment.md", "document")).toMatchObject({ type: "brief", name: "Treatment" });

    const suggestions = suggestFromMarkdown("## STYLE: Vaporwave\nPink and teal.\n## Docks — Location\nFog.");
    expect(suggestions).toEqual([
      { type: "style", name: "Vaporwave", description: "Pink and teal." },
      { type: "location", name: "Docks", description: "Fog." },
    ]);
  });
});

describe("extraction: docx", () => {
  const zipAvailable = Bun.which("zip") !== null;

  function makeMinimalDocx(): string {
    const dir = tmpRoot();
    mkdirSync(join(dir, "word"), { recursive: true });
    writeFileSync(
      join(dir, "word", "document.xml"),
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:body><w:p><w:r><w:t>Hello from docx</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Second paragraph &amp; more</w:t></w:r></w:p></w:body></w:document>`,
    );
    const zip = Bun.spawnSync({ cmd: ["zip", "-q", "test.docx", "word/document.xml"], cwd: dir });
    expect(zip.exitCode).toBe(0);
    return join(dir, "test.docx");
  }

  test("stripDocxXml flattens paragraphs and decodes entities", () => {
    const xml = `<w:body><w:p><w:r><w:t>Alpha &amp; beta</w:t></w:r></w:p><w:p><w:r><w:t>Gamma</w:t></w:r></w:p></w:body>`;
    expect(stripDocxXml(xml)).toBe("Alpha & beta\nGamma");
  });

  test.skipIf(!zipAvailable)("unzip-xml path extracts word/document.xml", async () => {
    const docx = makeMinimalDocx();
    const text = await extractDocxViaUnzip(docx);
    expect(text).toContain("Hello from docx");
    expect(text).toContain("Second paragraph & more");
  });

  test.skipIf(!zipAvailable)("extractText dispatch + ingest store the docx text", async () => {
    const docx = makeMinimalDocx();
    const extracted = await extractText(docx, "docx");
    expect(["textutil", "unzip-xml"]).toContain(extracted.extractionMethod);
    expect(extracted.textContent).toContain("Hello from docx");
    expect(extracted.wordCount).toBeGreaterThan(3);

    const library = makeLibrary();
    const result = await library.ingest({ data: docx, originalName: "meeting_notes.docx" }, {});
    expect(result.asset.kind).toBe("document");
    expect(result.document?.textContent).toContain("Hello from docx");
  });
});

describe("search", () => {
  test("finds brief words and survives FTS syntax in queries", async () => {
    const library = makeLibrary();
    const result = await library.ingest(
      { data: bytes("The lighthouse keeper waits for the storm to pass."), originalName: "brief.md" },
      { projectId: "proj-5" },
    );
    expect(library.search("lighthouse")[0]!.refId).toBe(result.asset.id);
    expect(library.search("lighthouse storm").length).toBeGreaterThan(0);
    // Operators/quotes must not blow up MATCH.
    expect(library.search(`"lighthouse AND (storm`)).toBeArray();
    expect(library.search("   ")).toEqual([]);
    expect(library.search("zzz-no-such-token")).toEqual([]);
  });
});

describe("canvas", () => {
  test("upsert / move / remove", () => {
    const library = makeLibrary();
    const created = library.upsertCanvasItem({
      projectId: "proj-6",
      refType: "note",
      refId: "note-1",
      x: 10,
      y: 20,
      z: 1,
      meta: { text: "hello", color: "#ff0" },
    });
    expect(created.id).toBeString();
    expect(created.meta).toEqual({ text: "hello", color: "#ff0" });

    // Upserting the same (project, refType, refId) updates in place.
    const updated = library.upsertCanvasItem({
      projectId: "proj-6",
      refType: "note",
      refId: "note-1",
      x: 99,
      y: 20,
      z: 2,
      meta: { text: "hello again" },
    });
    expect(updated.id).toBe(created.id);
    expect(updated.x).toBe(99);
    expect(library.listCanvasItems("proj-6")).toHaveLength(1);

    const moved = library.moveCanvasItem(created.id, { x: 300, y: 400, w: 111 });
    expect(moved).toMatchObject({ x: 300, y: 400, w: 111, z: 2 });

    library.removeCanvasItem(created.id);
    expect(library.listCanvasItems("proj-6")).toHaveLength(0);
  });
});

describe("takes", () => {
  test("add / list / select (selection is exclusive per shot)", async () => {
    const library = makeLibrary();
    const clipA = await library.ingest(
      { data: bytes("clip A"), originalName: "clip_a.txt" },
      { projectId: "proj-7", purpose: "generated" },
    );
    const clipB = await library.ingest(
      { data: bytes("clip B"), originalName: "clip_b.txt" },
      { projectId: "proj-7", purpose: "generated" },
    );

    const take1 = library.addTake({
      projectId: "proj-7",
      shotId: "shot-1",
      assetId: clipA.asset.id,
      prompt: "wide shot",
      selected: true,
    });
    const take2 = library.addTake({
      projectId: "proj-7",
      shotId: "shot-1",
      assetId: clipB.asset.id,
      prompt: "close up",
      selected: true,
    });
    const other = library.addTake({
      projectId: "proj-7",
      shotId: "shot-2",
      assetId: clipA.asset.id,
      prompt: "other shot",
      selected: true,
    });

    // Adding take2 as selected cleared take1.
    let takes = library.listTakes("proj-7", "shot-1");
    expect(takes).toHaveLength(2);
    expect(takes.find((t) => t.id === take1.id)?.selected).toBe(false);
    expect(takes.find((t) => t.id === take2.id)?.selected).toBe(true);

    // Re-selecting take1 flips exclusively within the shot.
    const selected = library.selectTake(take1.id);
    expect(selected.selected).toBe(true);
    takes = library.listTakes("proj-7", "shot-1");
    expect(takes.find((t) => t.id === take2.id)?.selected).toBe(false);
    // Other shot untouched.
    expect(library.listTakes("proj-7", "shot-2").find((t) => t.id === other.id)?.selected).toBe(true);
    expect(library.listTakes("proj-7")).toHaveLength(3);
  });
});

describe("getProjectContext", () => {
  test("briefs, documents, entities, uploadedMedia shape", async () => {
    const library = makeLibrary();
    const projectId = "proj-8";
    await library.ingest({ data: bytes("A short film about tides."), originalName: "brief.md" }, { projectId });
    const doc = await library.ingest(
      { data: bytes("Research notes about the moon and tides. ".repeat(30)), originalName: "research.txt" },
      { projectId },
    );
    const image = await library.ingest({ data: TINY_PNG, originalName: "character_mara.png" }, { projectId });
    // Generated media must not appear in uploadedMedia.
    const generatedPng = new Uint8Array([...TINY_PNG, 0x00]);
    await library.ingest({ data: generatedPng, originalName: "take_0.png" }, { projectId, purpose: "generated" });

    const context = library.getProjectContext(projectId);
    expect(context.briefs).toHaveLength(1);
    expect(context.briefs[0]!.text).toContain("tides");

    expect(context.documents).toHaveLength(1);
    expect(context.documents[0]!.assetId).toBe(doc.asset.id);
    expect(context.documents[0]!.excerpt.length).toBeLessThanOrEqual(500);
    expect(context.documents[0]!.wordCount).toBeGreaterThan(0);

    const mara = context.entities.find((e) => e.name === "Mara");
    expect(mara?.referenceImagePaths).toEqual([image.asset.storagePath]);
    expect(context.entities.some((e) => e.type === "brief")).toBe(true);

    expect(context.uploadedMedia).toHaveLength(1);
    expect(context.uploadedMedia[0]).toMatchObject({
      assetId: image.asset.id,
      kind: "image",
      name: "character_mara.png",
      path: image.asset.storagePath,
    });
  });
});

describe("librarian claude path (injected client, no network)", () => {
  test("prompt shaping: document excerpt and image block", () => {
    const docPrompt = buildLibrarianPrompt(
      {
        id: "a1",
        sha256: "x",
        kind: "document",
        mime: "text/markdown",
        ext: "md",
        originalName: "brief.md",
        sizeBytes: 42,
        storagePath: "/tmp/x.md",
        source: "upload",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      { assetId: "a1", textContent: "A story about tides.", extractionMethod: "plain", wordCount: 4 },
    );
    expect(docPrompt.system).toContain('{"entities":');
    expect(docPrompt.content[0]).toMatchObject({ type: "text" });
    expect((docPrompt.content[0] as { text: string }).text).toContain("brief.md");
    expect((docPrompt.content[1] as { text: string }).text).toContain("A story about tides.");

    const imagePrompt = buildLibrarianPrompt(
      {
        id: "a2",
        sha256: "y",
        kind: "image",
        mime: "image/png",
        ext: "png",
        originalName: "mara.png",
        sizeBytes: TINY_PNG.byteLength,
        storagePath: "/tmp/mara.png",
        source: "upload",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      undefined,
      TINY_PNG,
    );
    const imageBlock = imagePrompt.content.find((b) => b.type === "image");
    expect(imageBlock).toMatchObject({ source: { type: "base64", media_type: "image/png" } });
    expect((imageBlock as { source: { data: string } }).source.data).toBe(Buffer.from(TINY_PNG).toString("base64"));
  });

  test("parseLibrarianResponse: strict JSON, fenced JSON, invalid shapes", () => {
    expect(parseLibrarianResponse('{"entities":[{"type":"character","name":"Zed","description":"Pilot."}]}')).toEqual([
      { type: "character", name: "Zed", description: "Pilot." },
    ]);
    expect(parseLibrarianResponse('```json\n{"entities":[]}\n```')).toEqual([]);
    expect(() => parseLibrarianResponse('{"entities":[{"type":"alien","name":"Zed"}]}')).toThrow();
    expect(() => parseLibrarianResponse("not json")).toThrow();
    expect(() => parseLibrarianResponse('{"items":[]}')).toThrow();
  });

  test("injected client drives organization; failures fall back to heuristic", async () => {
    const prompts: LibrarianPrompt[] = [];
    const fake: LibrarianClient = {
      complete: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({
          entities: [{ type: "character", name: "Zed", description: "A weary cargo pilot." }],
        });
      },
    };
    const library = makeLibrary({ librarianClient: fake });
    const result = await library.ingest(
      { data: bytes("Zed flies the last freighter."), originalName: "story.txt" },
      { projectId: "proj-9" },
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.content.some((b) => b.type === "text" && b.text.includes("story.txt"))).toBe(true);
    expect(result.organization?.linkedEntities).toMatchObject([{ name: "Zed", type: "character", created: true }]);
    expect(library.getEntity(result.organization!.linkedEntities[0]!.entityId)?.description).toBe(
      "A weary cargo pilot.",
    );

    const failing: LibrarianClient = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    const fallbackLibrary = makeLibrary({ librarianClient: failing });
    const fallback = await fallbackLibrary.ingest(
      { data: TINY_PNG, originalName: "character_mara.png" },
      { projectId: "proj-10" },
    );
    expect(fallback.organization?.linkedEntities).toMatchObject([{ name: "Mara", type: "character" }]);
  });
});
