import * as z from "zod/v4";

interface StandardIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
}

interface McpSchema<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: T; readonly output: T };
    readonly validate: (
      value: unknown,
    ) => { readonly value: T } | { readonly issues: readonly StandardIssue[] };
    readonly jsonSchema: {
      readonly input: () => Record<string, unknown>;
      readonly output: () => Record<string, unknown>;
    };
  };
}

/**
 * Preserve Zod's complete recursive JSON Schema on the MCP wire.
 *
 * Zod's current Standard Schema converter degrades recursive/refined
 * children to `{}` for input schemas. The MCP SDK uses that converter by
 * default, which made conditions and JSON values opaque in tools/list even
 * though runtime validation remained strict. This adapter advertises the full
 * schema produced by z.toJSONSchema while continuing to validate with the same
 * owning Zod schema.
 */
export function asMcpSchema<T>(schema: z.ZodType<T>): McpSchema<T> {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  return {
    "~standard": {
      version: 1,
      vendor: "decision-table",
      validate(value: unknown) {
        const parsed = schema.safeParse(value);
        if (parsed.success) return { value: parsed.data };
        return {
          issues: parsed.error.issues.map((issue) => ({
            message: issue.message,
            path: issue.path,
          })),
        };
      },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}
