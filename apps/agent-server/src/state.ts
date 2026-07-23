/**
 * ProjectsManager — owns the on-disk .vdx/ state directory and the live
 * ProjectStore instances.
 *
 * Layout under the root (default <cwd>/.vdx):
 *   projects/<id>.json   serialized ProjectStore (schemaVersion + project)
 *   plans/<id>.json      the Plan artifact from the director run
 *   media/               provider-produced media (gateway mediaDir)
 *   cache/               content-addressed generation cache (gateway cacheDir)
 *   renders/             finished MP4s + index.json (projectId → render list)
 *   tmp/                 renderer intermediates
 *
 * The manager's file id — NOT project.metadata.id — is the canonical project
 * id in every API. The director's `create_project` command replaces the whole
 * TProject (fresh metadata.id) when it names the project after the plan, so
 * the file id is the only identity that survives a director run.
 *
 * Stores are cached in memory per id so undo/redo history survives across
 * HTTP requests within one server process, and every store mutation
 * autosaves via ProjectStore.subscribe. undo/redo do not fire store
 * listeners — callers must save() after those.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Plan } from "@vdx/agent";
import { zPlan } from "@vdx/agent";
import { ProjectStore } from "@vdx/timeline";

export interface ProjectListItem {
  id: string;
  name: string;
  updatedAt: string;
}

export interface RenderInfo {
  /** Host-relative URL the server serves the MP4 under (/media/renders/...). */
  url: string;
  createdAt: string;
}

interface RenderEntry {
  file: string;
  createdAt: string;
}

type RendersIndex = Record<string, RenderEntry[]>;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class ProjectsManager {
  readonly root: string;
  readonly projectsDir: string;
  readonly plansDir: string;
  readonly mediaDir: string;
  readonly cacheDir: string;
  readonly rendersDir: string;
  readonly tmpDir: string;

  private readonly stores = new Map<string, ProjectStore>();

  constructor(root: string = join(process.cwd(), ".vdx")) {
    this.root = resolve(root);
    this.projectsDir = join(this.root, "projects");
    this.plansDir = join(this.root, "plans");
    this.mediaDir = join(this.root, "media");
    this.cacheDir = join(this.root, "cache");
    this.rendersDir = join(this.root, "renders");
    this.tmpDir = join(this.root, "tmp");
    for (const dir of [
      this.projectsDir,
      this.plansDir,
      this.mediaDir,
      this.cacheDir,
      this.rendersDir,
      this.tmpDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // -- projects -------------------------------------------------------------

  /** Create a fresh project (default name keeps the store director-pristine). */
  create(opts: { name?: string } = {}): { id: string; store: ProjectStore } {
    const store = ProjectStore.create(opts.name !== undefined ? { name: opts.name } : {});
    const id = randomUUID();
    this.attach(id, store);
    this.save(id, store);
    return { id, store };
  }

  has(id: string): boolean {
    return this.stores.has(id) || existsSync(this.projectPath(id));
  }

  /** Hydrate (or return the cached) ProjectStore for a project id. */
  get(id: string): ProjectStore {
    this.validateId(id);
    const cached = this.stores.get(id);
    if (cached) return cached;

    const path = this.projectPath(id);
    if (!existsSync(path)) {
      throw new Error(`Project not found: ${id} (no file at ${path})`);
    }
    let store: ProjectStore;
    try {
      store = ProjectStore.deserialize(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(
        `Project file ${path} failed to load: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.attach(id, store);
    return store;
  }

  /** Persist the store to projects/<id>.json. */
  save(id: string, store: ProjectStore): void {
    this.validateId(id);
    writeFileSync(this.projectPath(id), store.serialize());
  }

  /** All projects on disk (id = file name), newest first. */
  list(): ProjectListItem[] {
    const items: ProjectListItem[] = [];
    for (const file of readdirSync(this.projectsDir)) {
      if (!file.endsWith(".json")) continue;
      const id = basename(file, ".json");
      try {
        const data = JSON.parse(readFileSync(join(this.projectsDir, file), "utf8")) as {
          project?: { metadata?: { name?: string; updatedAt?: string } };
        };
        items.push({
          id,
          name: data.project?.metadata?.name ?? id,
          updatedAt: data.project?.metadata?.updatedAt ?? "",
        });
      } catch {
        // Unreadable file: list it by id so the problem is visible, not hidden.
        items.push({ id, name: `${id} (unreadable)`, updatedAt: "" });
      }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // -- plans ----------------------------------------------------------------

  savePlan(id: string, plan: Plan): void {
    this.validateId(id);
    writeFileSync(join(this.plansDir, `${id}.json`), `${JSON.stringify(plan, null, 2)}\n`);
  }

  getPlan(id: string): Plan | undefined {
    this.validateId(id);
    const path = join(this.plansDir, `${id}.json`);
    if (!existsSync(path)) return undefined;
    try {
      return zPlan.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (err) {
      throw new Error(
        `Plan file ${path} is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -- renders --------------------------------------------------------------

  /** Record a finished render (file name inside renders/) for a project. */
  addRender(id: string, file: string): RenderInfo {
    this.validateId(id);
    const index = this.readRendersIndex();
    const entry: RenderEntry = { file, createdAt: new Date().toISOString() };
    (index[id] ??= []).push(entry);
    writeFileSync(this.rendersIndexPath(), `${JSON.stringify(index, null, 2)}\n`);
    return { url: `/media/renders/${file}`, createdAt: entry.createdAt };
  }

  listRenders(id: string): RenderInfo[] {
    this.validateId(id);
    const entries = this.readRendersIndex()[id] ?? [];
    return entries
      .filter((entry) => existsSync(join(this.rendersDir, entry.file)))
      .map((entry) => ({ url: `/media/renders/${entry.file}`, createdAt: entry.createdAt }));
  }

  // -------------------------------------------------------------------------

  private attach(id: string, store: ProjectStore): void {
    // Autosave after every applied command; undo/redo need an explicit save().
    store.subscribe(() => this.save(id, store));
    this.stores.set(id, store);
  }

  private projectPath(id: string): string {
    return join(this.projectsDir, `${id}.json`);
  }

  private rendersIndexPath(): string {
    return join(this.rendersDir, "index.json");
  }

  private readRendersIndex(): RendersIndex {
    const path = this.rendersIndexPath();
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as RendersIndex;
    } catch (err) {
      throw new Error(
        `Renders index ${path} is corrupt: ${err instanceof Error ? err.message : String(err)}. ` +
          `Fix or delete the file and retry.`,
      );
    }
  }

  private validateId(id: string): void {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`Invalid project id: ${JSON.stringify(id)} (expected [A-Za-z0-9_-]+)`);
    }
  }
}
