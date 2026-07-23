/**
 * Library-backed EntityBank — adapts the @vdx/library entity store to the
 * agent's EntityBank interface so the director/retake pipeline can condition
 * generations on library entities without knowing about the library.
 *
 * Mapping: bank types character|location|prop|style pass through 1:1 (other
 * library entity types are invisible to the bank); upsert routes to
 * createEntity/updateEntity (the library owns ids — matching falls back to
 * type+name when the given id is unknown); addReferenceImage ingests the
 * image into the library and links it to the entity. The bank contract is
 * synchronous while library ingest is async, so addReferenceImage queues its
 * work — await flush() to observe it.
 */

import * as path from "node:path";
import type { EntityType, EntityWithAssets, Library } from "@vdx/library";
import type { Entity, EntityBank } from "./types";

const BANK_TYPES = ["character", "location", "prop", "style"] as const satisfies readonly Entity["type"][];

function isBankType(type: EntityType): type is Entity["type"] {
  return (BANK_TYPES as readonly string[]).includes(type);
}

function toEntity(record: EntityWithAssets): Entity | undefined {
  if (!isBankType(record.type)) return undefined;
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    description: record.description,
    referenceImages: [...record.referenceImagePaths],
    ...(record.baseEntityId !== undefined ? { baseEntityId: record.baseEntityId } : {}),
    createdAt: record.createdAt,
  };
}

export interface LibraryEntityBank extends EntityBank {
  /** Await the async work queued by addReferenceImage (ingest + link). */
  flush(): Promise<void>;
}

export function createLibraryBank(library: Library, projectId: string): LibraryEntityBank {
  let pending: Promise<void> = Promise.resolve();

  return {
    list(): Entity[] {
      return library
        .listEntities(projectId)
        .map(toEntity)
        .filter((e): e is Entity => e !== undefined);
    },

    get(id: string): Entity | undefined {
      const record = library.getEntity(id);
      return record ? toEntity(record) : undefined;
    },

    upsert(input): Entity {
      // The library owns entity ids: match by id first, then by type+name
      // (so bank-chosen ids like "hero" converge on one library entity).
      const existing =
        library.getEntity(input.id) ??
        library.listEntities(projectId).find((e) => e.type === input.type && e.name === input.name);
      const record = existing
        ? library.updateEntity(existing.id, { name: input.name, description: input.description })
        : library.createEntity({
            type: input.type,
            name: input.name,
            description: input.description,
            projectId,
            ...(input.baseEntityId !== undefined ? { baseEntityId: input.baseEntityId } : {}),
          });
      const withAssets = library.getEntity(record.id);
      const entity = withAssets ? toEntity(withAssets) : undefined;
      if (!entity) {
        throw new Error(`Library entity ${record.id} has non-bank type "${record.type}"`);
      }
      return entity;
    },

    addReferenceImage(id: string, imagePath: string): void {
      // EntityBank is sync but library.ingest is async: chain the work so
      // successive calls stay ordered, observable via flush().
      pending = pending.then(async () => {
        const result = await library.ingest(
          { data: imagePath, originalName: path.basename(imagePath) },
          { projectId, purpose: "reference", organize: false },
        );
        library.linkAssetToEntity(id, result.asset.id, "reference");
      });
    },

    flush(): Promise<void> {
      return pending;
    },
  };
}
