/**
 * Shared runtime services — ONE ProjectsManager, JobRegistry, Gateway,
 * Renderer, and Library instance, reused by the HTTP app (index.ts) and the
 * MCP server (mcp.ts) so both faces see the same state.
 *
 * The library lives under the same .vdx root the manager owns (db at
 * .vdx/library.db, blobs at .vdx/library/), which puts every storagePath
 * inside the root the existing /media/* static route serves:
 * url = '/media/' + relative(root, storagePath).
 *
 * Gateway is hot-swappable: the API keys that drive it can change at
 * runtime via updateSettings() (backing PUT /api/settings), so gateway is
 * NOT a field callers can capture into a closure at boot — it is exposed
 * only through getGateway(), which callers MUST invoke fresh at the point
 * of use. Capturing the return value of getGateway() into a variable that
 * outlives a single request/job-start defeats the whole point: settings
 * changes would silently stop taking effect until a restart.
 */

import { relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import type { Gateway } from "@vdx/gateway";
import { createGateway } from "@vdx/gateway";
import type { Library } from "@vdx/library";
import { createLibrary, openDb } from "@vdx/library";
import type { Renderer } from "@vdx/render";
import { createRenderer } from "@vdx/render";
import type { RuntimeConfig, SettingsView } from "./config";
import { effectiveEnv, loadConfig, saveConfig, toSettingsView } from "./config";
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
  renderer: Renderer;
  library: Library;
  /** The live Gateway. Call fresh at each point of use — see module docs. */
  getGateway(): Gateway;
  /** Raw runtime config (unmasked) — for reading model/effort at job start. */
  getConfig(): RuntimeConfig;
  /** Masked config for the Settings UI (GET /api/settings). */
  getSettingsView(): SettingsView;
  /** Persist a settings patch, rebuild the gateway, return the masked view. */
  updateSettings(patch: Partial<RuntimeConfig>): SettingsView;
  /** '/media/...' URL for an absolute file path under the .vdx root. */
  mediaUrl(absolutePath: string): string;
  /** project_assets purpose per asset id for one project. */
  assetPurposes(projectId: string): Map<string, string>;
  /**
   * Detach a project from the library: drop its project_assets/canvas_items/
   * takes rows. Does NOT delete the underlying assets — they may be shared
   * or reused outside this project.
   */
  detachProject(projectId: string): void;
  /** Close persistent handles (library db); tests call this per app. */
  close(): void;
}

export function createServices(options: CreateServicesOptions = {}): Services {
  const log = options.log ?? ((message: string) => console.log(message));
  const manager = new ProjectsManager(options.root);
  const jobs = new JobRegistry();

  let config: RuntimeConfig = loadConfig(manager.root);

  function buildGateway(cfg: RuntimeConfig): Gateway {
    return createGateway({
      mediaDir: manager.mediaDir,
      cacheDir: manager.cacheDir,
      log: (message) => log(`[gateway] ${message}`),
      // createGateway's `env` option REPLACES process.env wholesale when
      // provided (it does not overlay it) — so build the merged object
      // ourselves: config values win, everything else still falls through.
      env: { ...process.env, ...effectiveEnv(cfg) },
    });
  }

  let gatewayInstance: Gateway = buildGateway(config);
  const renderer = createRenderer({ tmpDir: manager.tmpDir });
  const library = createLibrary({ rootDir: manager.root });
  // Companion read connection for the one lookup the Library contract does
  // not expose (per-project asset purposes) and for detachProject's cleanup.
  // The db is WAL — a second same-process reader/writer always sees the
  // engine's committed writes.
  const db: Database = openDb(manager.root);

  return {
    manager,
    jobs,
    renderer,
    library,

    getGateway(): Gateway {
      return gatewayInstance;
    },

    getConfig(): RuntimeConfig {
      return config;
    },

    getSettingsView(): SettingsView {
      return toSettingsView(config);
    },

    updateSettings(patch: Partial<RuntimeConfig>): SettingsView {
      config = saveConfig(manager.root, patch);
      gatewayInstance = buildGateway(config);
      return toSettingsView(config);
    },

    mediaUrl(absolutePath: string): string {
      return `/media/${relative(manager.root, absolutePath).split(sep).join("/")}`;
    },

    assetPurposes(projectId: string): Map<string, string> {
      const rows = db
        .query(`SELECT asset_id, purpose FROM project_assets WHERE project_id = ?1`)
        .all(projectId) as Array<{ asset_id: string; purpose: string }>;
      return new Map(rows.map((row) => [row.asset_id, row.purpose]));
    },

    detachProject(projectId: string): void {
      db.query(`DELETE FROM project_assets WHERE project_id = ?1`).run(projectId);
      db.query(`DELETE FROM canvas_items WHERE project_id = ?1`).run(projectId);
      db.query(`DELETE FROM takes WHERE project_id = ?1`).run(projectId);
    },

    close(): void {
      db.close();
      library.close();
    },
  };
}
