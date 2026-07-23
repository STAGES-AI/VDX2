/**
 * Entity bank — JSON-file-backed store of typed, evolvable entities
 * (characters/locations/props/styles) with lineage via `baseEntityId`
 * (CoTriSyGen-style). Synchronous load/save keeps the bank trivially
 * consistent for the single-process agent runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Entity, EntityBank } from "./types";

function loadEntities(file: string): Entity[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (raw.trim() === "") return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Entity bank file ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `Fix or delete the file and retry.`,
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(`Entity bank file ${file} must contain a JSON array of entities.`);
  }
  return data as Entity[];
}

export function createEntityBank(filePath = ".vdx/entities.json"): EntityBank {
  const file = path.resolve(filePath);
  const entities: Entity[] = loadEntities(file);

  function save(): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(entities, null, 2)}\n`);
  }

  function find(id: string): Entity | undefined {
    return entities.find((e) => e.id === id);
  }

  return {
    list(): Entity[] {
      return [...entities];
    },

    get(id: string): Entity | undefined {
      return find(id);
    },

    upsert(input): Entity {
      const existing = find(input.id);
      const entity: Entity = {
        ...input,
        referenceImages: [...input.referenceImages],
        // Updates never clobber the original creation time (lineage stays honest).
        createdAt: existing?.createdAt ?? input.createdAt ?? new Date().toISOString(),
      };
      if (existing) {
        entities[entities.indexOf(existing)] = entity;
      } else {
        entities.push(entity);
      }
      save();
      return entity;
    },

    addReferenceImage(id: string, imagePath: string): void {
      const entity = find(id);
      if (!entity) {
        throw new Error(
          `Entity not found: ${id} — upsert it before adding reference images (bank: ${file})`,
        );
      }
      if (!entity.referenceImages.includes(imagePath)) {
        entity.referenceImages.push(imagePath);
        save();
      }
    },
  };
}
