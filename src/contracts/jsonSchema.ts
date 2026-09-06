import { z } from 'zod';

/**
 * ONE SCHEMA, TWO CONSUMERS.
 *
 * A headless `claude -p --json-schema` session enforces its structured output
 * against a JSON Schema, while this codebase validates the same bytes with a
 * zod schema and infers its types from it. Writing both by hand is the
 * one-concept-two-definitions drift the root contract forbids, and it is
 * exactly what the out-of-product supervisor scripts did: a JSON constant and
 * a hand-written validator that had to be kept in step by reading.
 *
 * So the JSON Schema is DERIVED from the zod schema, here, for the subset of
 * zod this repository's structured-output contracts use: strict objects,
 * strings with length bounds, enums, arrays, optionals, and a refinement
 * wrapper (whose predicate has no JSON Schema form and is validated by zod on
 * the way back in). Anything else THROWS at module load, so a contract that
 * reaches for a node this function cannot express fails the test suite
 * rather than shipping a schema the model was never held to.
 *
 * Deliberately not `zod-to-json-schema`: it is a transitive dependency here,
 * not a declared one, and its output covers far more of zod than a prompt
 * contract should ever use. A converter that refuses is the guard.
 */
export type JsonSchema = Record<string, unknown>;

export function jsonSchemaFromZod(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const object = schema as z.AnyZodObject;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(object.shape as Record<string, z.ZodTypeAny>)) {
        const childDef = child._def as { typeName: z.ZodFirstPartyTypeKind };
        if (childDef.typeName === z.ZodFirstPartyTypeKind.ZodOptional) {
          properties[key] = jsonSchemaFromZod((child as z.ZodOptional<z.ZodTypeAny>).unwrap());
        } else {
          properties[key] = jsonSchemaFromZod(child);
          required.push(key);
        }
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length > 0) out['required'] = required;
      if (object._def.unknownKeys === 'strict') out['additionalProperties'] = false;
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodString: {
      const out: JsonSchema = { type: 'string' };
      for (const check of (schema as z.ZodString)._def.checks) {
        if (check.kind === 'min') out['minLength'] = check.value;
        else if (check.kind === 'max') out['maxLength'] = check.value;
        else throw new Error(`jsonSchemaFromZod: unsupported string check "${check.kind}"`);
      }
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const out: JsonSchema = { type: 'number' };
      for (const check of (schema as z.ZodNumber)._def.checks) {
        if (check.kind === 'int') out['type'] = 'integer';
        else if (check.kind === 'min') out['minimum'] = check.value;
        else if (check.kind === 'max') out['maximum'] = check.value;
        else throw new Error(`jsonSchemaFromZod: unsupported number check "${check.kind}"`);
      }
      return out;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options] };
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { enum: [(schema as z.ZodLiteral<unknown>).value] };
    case z.ZodFirstPartyTypeKind.ZodArray:
      return { type: 'array', items: jsonSchemaFromZod((schema as z.ZodArray<z.ZodTypeAny>).element) };
    case z.ZodFirstPartyTypeKind.ZodEffects:
      // A refinement has no JSON Schema form; the wrapped shape is what the
      // model is held to, and zod enforces the predicate on the way back.
      return jsonSchemaFromZod((schema as z.ZodEffects<z.ZodTypeAny>).innerType());
    case z.ZodFirstPartyTypeKind.ZodOptional:
      throw new Error('jsonSchemaFromZod: optional is only supported as an object property');
    default:
      throw new Error(`jsonSchemaFromZod: unsupported zod node "${def.typeName}"`);
  }
}
