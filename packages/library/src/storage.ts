/**
 * Content-addressed blob store: `<rootDir>/library/<sha256>.<ext>`.
 *
 * Identical bytes always land on the same path, so re-uploads are free and
 * `assets.sha256 UNIQUE` (schema.ts) can dedupe rows against it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface StoredBlob {
  sha256: string;
  storagePath: string;
  sizeBytes: number;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Directory blobs live in (created lazily by storeBlob). */
export function blobDir(rootDir: string): string {
  return join(rootDir, "library");
}

/**
 * Write bytes to the content-addressed store (no-op when the blob already
 * exists) and return its identity.
 */
export function storeBlob(rootDir: string, bytes: Uint8Array, ext: string): StoredBlob {
  const dir = blobDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const sha256 = sha256Hex(bytes);
  const storagePath = join(dir, ext ? `${sha256}.${ext}` : sha256);
  if (!existsSync(storagePath)) writeFileSync(storagePath, bytes);
  return { sha256, storagePath, sizeBytes: bytes.byteLength };
}
