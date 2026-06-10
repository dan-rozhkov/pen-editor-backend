import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { penTools } from "../src/ai/tools.js";

// Contract tests: pin down the argument shape the backend declares for the
// client-executed tools. The frontend handlers must agree with these schemas.

function schemaOf(toolName: keyof typeof penTools): z.ZodTypeAny {
  const tool = penTools[toolName] as { inputSchema?: unknown };
  expect(tool.inputSchema, `${String(toolName)} must declare inputSchema`).toBeDefined();
  return tool.inputSchema as z.ZodTypeAny;
}

describe("penTools registry", () => {
  it("declares the expected tool names", () => {
    expect(Object.keys(penTools).sort()).toEqual(
      [
        "batch_design",
        "batch_get",
        "find_empty_space_on_canvas",
        "get_editor_state",
        "get_guidelines",
        "get_style_guide",
        "get_style_guide_tags",
        "get_variables",
        "replace_all_matching_properties",
        "search_all_unique_properties",
        "set_variables",
        "snapshot_layout",
      ].sort(),
    );
  });

  it("client-executed tools have no execute function; static ones do", () => {
    const hasExecute = (name: keyof typeof penTools) =>
      typeof (penTools[name] as { execute?: unknown }).execute === "function";

    // Executed in the browser against the local scene graph:
    for (const name of [
      "batch_design",
      "batch_get",
      "get_editor_state",
      "get_variables",
      "set_variables",
      "replace_all_matching_properties",
      "snapshot_layout",
      "find_empty_space_on_canvas",
      "search_all_unique_properties",
    ] as const) {
      expect(hasExecute(name), `${name} must be client-executed`).toBe(false);
    }

    // Static/read-only tools executed on the backend:
    for (const name of [
      "get_guidelines",
      "get_style_guide",
      "get_style_guide_tags",
    ] as const) {
      expect(hasExecute(name), `${name} must execute on the backend`).toBe(true);
    }
  });
});

describe("batch_design schema", () => {
  const schema = schemaOf("batch_design");

  it("accepts the canonical {operations} payload", () => {
    const result = schema.safeParse({
      operations: 'card=I(document, {type: "frame", name: "Card"})',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      operations: 'card=I(document, {type: "frame", name: "Card"})',
    });
  });

  it.each(["design", "script", "batch"])(
    "normalizes the %s alias into operations",
    (alias) => {
      const result = schema.safeParse({ [alias]: "D(\"node1\")" });
      expect(result.success).toBe(true);
      expect(result.success && result.data).toEqual({
        operations: 'D("node1")',
      });
    },
  );

  it("rejects an empty payload", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty/whitespace operations", () => {
    expect(schema.safeParse({ operations: "" }).success).toBe(false);
    expect(schema.safeParse({ operations: "   \n " }).success).toBe(false);
  });

  it("rejects non-string operations", () => {
    expect(schema.safeParse({ operations: ["D(\"x\")"] }).success).toBe(false);
    expect(schema.safeParse({ operations: 42 }).success).toBe(false);
  });

  it("rejects more than 25 operations", () => {
    const ops = Array.from({ length: 26 }, (_, i) => `D("node${i}")`).join("\n");
    const result = schema.safeParse({ operations: ops });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain("Too many operations");
    }
  });

  it("accepts exactly 25 operations", () => {
    const ops = Array.from({ length: 25 }, (_, i) => `D("node${i}")`).join("\n");
    expect(schema.safeParse({ operations: ops }).success).toBe(true);
  });

  it("counts multi-line values as a single operation and ignores comments", () => {
    // One I() spanning multiple lines + comments must not trip the limit.
    const multiLine = [
      "// comment line",
      "# another comment",
      'a=I(document, {type: "embed", htmlContent: "<div>',
      "multi",
      "line",
      '</div>"})',
      ...Array.from({ length: 24 }, (_, i) => `D("n${i}")`),
    ].join("\n");
    expect(schema.safeParse({ operations: multiLine }).success).toBe(true);
  });
});

describe("batch_get schema", () => {
  const schema = schemaOf("batch_get");

  it("accepts a full valid query", () => {
    const result = schema.safeParse({
      patterns: [{ type: "embed", name: "Card.*" }, { type: "text" }],
      nodeIds: ["abc123"],
      parentId: "root1",
      readDepth: 2,
      searchDepth: 5,
      resolveVariables: true,
      includePathGeometry: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty object (all fields optional)", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("rejects unknown node types in patterns", () => {
    expect(
      schema.safeParse({ patterns: [{ type: "component" }] }).success,
    ).toBe(false);
  });

  it("rejects wrongly typed fields", () => {
    expect(schema.safeParse({ nodeIds: "abc123" }).success).toBe(false);
    expect(schema.safeParse({ readDepth: "deep" }).success).toBe(false);
  });
});

describe("set_variables schema", () => {
  const schema = schemaOf("set_variables");

  it("accepts variables with an optional replace flag", () => {
    expect(
      schema.safeParse({
        variables: { "--primary": "#3B82F6", "--gap": 16 },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        variables: { "--primary": "#3B82F6" },
        replace: true,
      }).success,
    ).toBe(true);
  });

  it("requires the variables record", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ replace: true }).success).toBe(false);
  });

  it("rejects non-record variables and non-boolean replace", () => {
    expect(schema.safeParse({ variables: "not-a-record" }).success).toBe(false);
    expect(
      schema.safeParse({ variables: {}, replace: "yes" }).success,
    ).toBe(false);
  });
});

describe("replace_all_matching_properties schema", () => {
  const schema = schemaOf("replace_all_matching_properties");

  it("accepts valid from/to replacement pairs", () => {
    const result = schema.safeParse({
      parents: ["rootId"],
      properties: {
        fillColor: [{ from: "#000000", to: "#18181b" }],
        fontSize: [{ from: 14, to: 16 }],
        cornerRadius: [{ from: [4, 4, 4, 4], to: [8, 8, 8, 8] }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty properties object", () => {
    expect(
      schema.safeParse({ parents: ["rootId"], properties: {} }).success,
    ).toBe(true);
  });

  it("requires parents and properties", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ parents: ["rootId"] }).success).toBe(false);
    expect(schema.safeParse({ properties: {} }).success).toBe(false);
  });

  it("rejects mismatched value types in pairs", () => {
    // fillColor expects string from/to
    expect(
      schema.safeParse({
        parents: ["rootId"],
        properties: { fillColor: [{ from: 0, to: 1 }] },
      }).success,
    ).toBe(false);
    // fontSize expects number from/to
    expect(
      schema.safeParse({
        parents: ["rootId"],
        properties: { fontSize: [{ from: "14", to: "16" }] },
      }).success,
    ).toBe(false);
  });
});
