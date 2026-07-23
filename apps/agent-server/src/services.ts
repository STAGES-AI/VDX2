/**
 * Shared runtime services — ONE ProjectsManager, JobRegistry, Gateway,
 * Renderer, and Library instance, reused by the HTTP app (index.ts) and the
 * MCP server (mcp.ts) so both faces see the same state.
 *
 * The library lives under the same .vdx root the manager owns (db at
 * .vdx/library.db, blobs at .vdx/library/), which puts every storagePath
 * inside the root the existing /media/* static route serves:
 * url = '/media/' + relative(root, storagePath).
 */

import { relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import type { Gateway } from "@vdx/gateway";
import { createGateway } from "@vdx/gateway";
import type { Library } from "@vdx/library";
import { createLibrary, openDb } from "@vdx/library";
import type { Renderer } from "@vdx/render";
import { createRenderer } from "@vdx/render";
import { JobRegistry } from "./jobs";
import { ProjectsManager } from "./state";

export interface CreateServicesOptions {
  /** State root (default <cwd>/.vdx). */
  root?: string;
  /** Log sink — HTTP logs to stdout; MCP must pass a stderr logger. */
  log?: (message: string) => void;
}

export interface Services {
  manager: ProjectsManager;
  jobs: JobRegistry;
  gateway: Gateway;
  renderer: Renderer;
  library: Library;
  /** '/media/...' URL for an absolute file path under the .vdx root. */
  mediaUrl(absolutePath: string): string;
  /** project_assets purpose per asset id for one project. */
  assetPurposes(projectId: string): Map<string, string>;
  /** Close persistent handles (library db); tests call this per app. */
  close(): void;
}

export function createServices(options: CreateServicesOptions = {}): Services {
  const log = options.log ?? ((message: string) => console.log(message));
  const manager = new ProjectsManager(options.root);
  const jobs = new JobRegistry();
  const gateway = createGateway({
    mediaDir: manager.mediaDir,
    cacheDir: manager.cacheDir,
    log: (message) => log(`[gateway] ${message}`),
  });
  const renderer = createRenderer({ tmpDir: manager.tmpDir });
  const library = createLibrary({ rootDir: manager.root });
  // Companion read connection for the one lookup the Library contract does
  // not expose (per-project asset purposes). The db is WAL — a second
  // same-process reader always sees the engine's committed writes.
  const db: Database = openDb(manager.root);

  return {
    manager,
    jobs,
    gateway,
    renderer,
    library,

    mediaUrl(absolutePath: string): string {
      return `/media/${relative(manager.root, absolutePath).split(sep).join("/")}`;
    },

    assetPurposes(projectId: string): Map<string, string> {
      const rows = db
        .query(`SELECT asset_id, purpose FROM project_assets WHERE project_id = ?1`)
        .all(projectId) as Array<{ asset_id: string; purpose: string }>;
      return new Map(rows.map((row) => [row.asset_id, row.purpose]));
    },

    close(): void {
      db.close();
      library.close();
    },
  };
}
