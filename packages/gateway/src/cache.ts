/**
 * Content-addressed generation cache (default .vdx/cache).
 *
 * Layout: <key>.<ext> is the media file, <key>.json is the metadata — the
 * GenerationResult minus the `cached` flag, with `path` pointing at the
 * cached media file. The cache copy is canonical: the gateway returns the
 * cached path on both the first (store) and subsequent (lookup) calls, so
 * identical requests always yield the identical path.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { GenerationResult } from "./types";

type CacheMetadata = Omit<GenerationResult, "cached">;

export class GenerationCache {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  private metadataPath(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  /** Returns the cached result (cached: true, costUsd: 0) or undefined. */
  lookup(key: string): GenerationResult | undefined {
    const metaPath = this.metadataPath(key);
    if (!existsSync(metaPath)) return undefined;
    let metadata: CacheMetadata;
    try {
      metadata = JSON.parse(readFileSync(metaPath, "utf8")) as CacheMetadata;
    } catch (err) {
      throw new Error(`Corrupt cache metadata at ${metaPath}: ${err instanceof Error ? err.message : err}`);
    }
    // A cache entry is only valid while its media file still exists.
    if (!metadata.path || !existsSync(metadata.path)) return undefined;
    return { ...metadata, costUsd: 0, cached: true };
  }

  /**
   * Copy the produced media into the cache under <key>.<ext>, write the
   * metadata sidecar, and return the result rebased onto the cache path.
   */
  store(key: string, result: GenerationResult): GenerationResult {
    const ext = extname(result.path);
    if (!ext) throw new Error(`Cannot cache media without a file extension: ${result.path}`);
    if (!existsSync(result.path)) {
      throw new Error(`Cannot cache missing media file: ${result.path}`);
    }
    const cachedMediaPath = join(this.dir, `${key}${ext}`);
    copyFileSync(result.path, cachedMediaPath);
    const metadata: CacheMetadata = { ...stripCached(result), path: cachedMediaPath };
    writeFileSync(this.metadataPath(key), JSON.stringify(metadata, null, 2));
    return { ...metadata, cached: false };
  }
}

function stripCached(result: GenerationResult): CacheMetadata {
  const { cached: _cached, ...rest } = result;
  return rest;
}
