/**
 * Minimal zod → JSON Schema converter for the shapes used in this repo
 * (commandCatalog schemas + zPlan): object / string / number / boolean /
 * literal / enum / array / union / discriminatedUnion / optional / nullable /
 * default / effects (refine) / record / unknown.
 *
 * Hand-rolled on purpose: the installed zod (v3 classic API) has no
 * `z.toJSONSchema`, and we cannot add a dependency. Dispatch is on
 * `_def.typeName` strings rather than `instanceof` so schemas built by a
 * different zod instance (e.g. @vdx/timeline's copy) convert fine.
 */

import type { z } from "zod";

export type JsonSchema = Record<string, unknown>;

interface ZodDefLike {
  typeName: string;
  description?: string;
  [key: string]: unknown;
}

function defOf(schema: z.ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  const describe = (out: JsonSchema): JsonSchema =>
    def.description ? { description: def.description, ...out } : out;

  switch (def.typeName) {
    case "ZodString":
      return describe({ type: "string" });

    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      const checks = (def.checks as Array<{ kind: string; value?: number; inclusive?: boolean }>) ?? [];
      for (const check of checks) {
        if (check.kind === "int") out.type = "integer";
        else if (check.kind === "min" && check.value !== undefined) {
          if (check.inclusive === false) out.exclusiveMinimum = check.value;
          else out.minimum = check.value;
        } else if (check.kind === "max" && check.value !== undefined) {
          if (check.inclusive === false) out.exclusiveMaximum = check.value;
          else out.maximum = check.value;
        }
      }
      return describe(out);
    }

    case "ZodBoolean":
      return describe({ type: "boolean" });

    case "ZodLiteral": {
      const value = def.value as string | number | boolean;
      return describe({ type: typeof value as string, const: value });
    }

    case "ZodEnum":
      return describe({ type: "string", enum: [...(def.values as string[])] });

    case "ZodArray": {
      const out: JsonSchema = {
        type: "array",
        items: zodToJsonSchema(def.type as z.ZodTypeAny),
      };
      const min = def.minLength as { value: number } | null | undefined;
      const max = def.maxLength as { value: number } | null | undefined;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      return describe(out);
    }

    case "ZodObject": {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties, additionalProperties: false };
      if (required.length > 0) out.required = required;
      return describe(out);
    }

    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return describe({
        anyOf: (def.options as z.ZodTypeAny[]).map((option) => zodToJsonSchema(option)),
      });

    case "ZodOptional":
    case "ZodNullable":
      return zodToJsonSchema(def.innerType as z.ZodTypeAny);

    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType as z.ZodTypeAny);
      return describe({ ...inner, default: (def.defaultValue as () => unknown)() });
    }

    case "ZodEffects": // refine/transform — convert the wrapped schema
      return zodToJsonSchema(def.schema as z.ZodTypeAny);

    case "ZodRecord":
      return describe({
        type: "object",
        additionalProperties: def.valueType ? zodToJsonSchema(def.valueType as z.ZodTypeAny) : true,
      });

    case "ZodUnknown":
    case "ZodAny":
      return describe({});

    default:
      throw new Error(
        `zodToJsonSchema: unsupported zod type "${def.typeName}" — extend packages/agent/src/json-schema.ts`,
      );
  }
}
