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
        "boolean_operation",
        "find_empty_space_on_canvas",
        "generate_frame_image",
        "generate_image",
        "get_editor_state",
        "get_guidelines",
        "get_style_guide",
        "get_style_guide_tags",
        "get_variables",
        "get_text_styles",
        "set_text_styles",
        "apply_text_style",
        "get_styles",
        "set_styles",
        "apply_fill_style",
        "apply_effect_style",
        "rename_layers",
        "replace_all_matching_properties",
        "search_all_unique_properties",
        "set_export_settings",
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
      "get_text_styles",
      "set_text_styles",
      "apply_text_style",
      "get_styles",
      "set_styles",
      "apply_fill_style",
      "apply_effect_style",
      "replace_all_matching_properties",
      "snapshot_layout",
      "find_empty_space_on_canvas",
      "search_all_unique_properties",
      "rename_layers",
      "generate_image",
      "generate_frame_image",
      "boolean_operation",
      "set_export_settings",
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

  it("ignores wrapper/fence noise when counting operations", () => {
    const body = Array.from({ length: 25 }, (_, i) => `D("node${i}")`);
    const wrapped = ["<operations>", ...body, "</operations>"].join("\n");
    expect(schema.safeParse({ operations: wrapped }).success).toBe(true);
    const fenced = ["```pen", ...body, "```"].join("\n");
    expect(schema.safeParse({ operations: fenced }).success).toBe(true);
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

  it("accepts connector and ref types", () => {
    expect(
      schema.safeParse({ patterns: [{ type: "connector" }, { type: "ref" }] })
        .success,
    ).toBe(true);
  });

  it("rejects node types that do not exist on the frontend", () => {
    for (const stale of ["note", "icon_font", "connection", "image"]) {
      expect(
        schema.safeParse({ patterns: [{ type: stale }] }).success,
        stale,
      ).toBe(false);
    }
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

describe("set_export_settings schema", () => {
  const schema = schemaOf("set_export_settings");

  it("accepts nodeIds + format with all optional fields", () => {
    const result = schema.safeParse({
      nodeIds: ["node1", "node2"],
      format: "png",
      scale: 2,
      suffix: "@2x",
      quality: 0.9,
      mode: "add",
    });
    expect(result.success).toBe(true);
  });

  it("accepts just nodeIds + format (scale/suffix/quality/mode optional)", () => {
    expect(
      schema.safeParse({ nodeIds: ["node1"], format: "svg" }).success,
    ).toBe(true);
  });

  it("requires nodeIds and a valid format", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ nodeIds: [] , format: "png" }).success).toBe(false);
    expect(schema.safeParse({ nodeIds: ["n1"] }).success).toBe(false);
    expect(
      schema.safeParse({ nodeIds: ["n1"], format: "bmp" }).success,
    ).toBe(false);
  });

  it("rejects out-of-range quality and unknown mode", () => {
    expect(
      schema.safeParse({ nodeIds: ["n1"], format: "jpg", quality: 1.5 })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ nodeIds: ["n1"], format: "jpg", mode: "merge" })
        .success,
    ).toBe(false);
  });
});

describe("rename_layers schema", () => {
  const schema = schemaOf("rename_layers");

  it("accepts a valid renames array", () => {
    const result = schema.safeParse({
      renames: [
        { id: "frame1", name: "Login screen" },
        { id: "text1", name: "Title heading" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty renames array", () => {
    expect(schema.safeParse({ renames: [] }).success).toBe(false);
  });

  it("rejects blank names", () => {
    expect(
      schema.safeParse({ renames: [{ id: "frame1", name: "" }] }).success,
    ).toBe(false);
  });

  it("requires the renames field with id and name", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ renames: [{ id: "frame1" }] }).success).toBe(false);
    expect(schema.safeParse({ renames: [{ name: "X" }] }).success).toBe(false);
  });
});

describe("get_editor_state schema", () => {
  const schema = schemaOf("get_editor_state");

  it("requires the include_schema boolean", () => {
    expect(schema.safeParse({ include_schema: true }).success).toBe(true);
    expect(schema.safeParse({ include_schema: false }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ include_schema: "yes" }).success).toBe(false);
  });
});

describe("snapshot_layout schema", () => {
  const schema = schemaOf("snapshot_layout");

  it("accepts an empty object (all fields optional)", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("accepts a full valid query", () => {
    expect(
      schema.safeParse({ parentId: "root1", maxDepth: 3, problemsOnly: true })
        .success,
    ).toBe(true);
  });

  it("rejects wrongly typed fields", () => {
    expect(schema.safeParse({ maxDepth: "deep" }).success).toBe(false);
    expect(schema.safeParse({ problemsOnly: "yes" }).success).toBe(false);
    expect(schema.safeParse({ parentId: 1 }).success).toBe(false);
  });
});

describe("get_variables schema", () => {
  const schema = schemaOf("get_variables");

  it("accepts an empty object", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({});
  });
});

describe("get_text_styles schema", () => {
  const schema = schemaOf("get_text_styles");

  it("accepts an empty object", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({});
  });
});

describe("set_text_styles schema", () => {
  const schema = schemaOf("set_text_styles");

  it("accepts an array of style definitions", () => {
    expect(
      schema.safeParse({
        textStyles: [{ name: "Heading/L", fontFamily: "Inter", fontSize: 32 }],
      }).success,
    ).toBe(true);
  });

  it("accepts an object keyed by style name, with an optional replace flag", () => {
    expect(
      schema.safeParse({
        textStyles: { "Heading/L": { fontSize: 32 } },
        replace: true,
      }).success,
    ).toBe(true);
  });

  it("requires textStyles and rejects a non-boolean replace", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ textStyles: [], replace: "yes" }).success,
    ).toBe(false);
  });
});

describe("apply_text_style schema", () => {
  const schema = schemaOf("apply_text_style");

  it("accepts nodeIds and a textStyleId", () => {
    expect(
      schema.safeParse({ nodeIds: ["text1", "text2"], textStyleId: "style1" })
        .success,
    ).toBe(true);
  });

  it("rejects an empty nodeIds array or a missing textStyleId", () => {
    expect(
      schema.safeParse({ nodeIds: [], textStyleId: "style1" }).success,
    ).toBe(false);
    expect(schema.safeParse({ nodeIds: ["text1"] }).success).toBe(false);
  });
});

describe("find_empty_space_on_canvas schema", () => {
  const schema = schemaOf("find_empty_space_on_canvas");

  it("accepts a full valid query with and without nodeId", () => {
    expect(
      schema.safeParse({
        direction: "right",
        width: 200,
        height: 100,
        padding: 16,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        direction: "bottom",
        width: 200,
        height: 100,
        padding: 16,
        nodeId: "abc",
      }).success,
    ).toBe(true);
  });

  it("requires direction, width, height and padding", () => {
    expect(schema.safeParse({ width: 1, height: 1, padding: 1 }).success).toBe(false);
    expect(
      schema.safeParse({ direction: "top", height: 1, padding: 1 }).success,
    ).toBe(false);
  });

  it("rejects an invalid direction and non-number dimensions", () => {
    expect(
      schema.safeParse({ direction: "up", width: 1, height: 1, padding: 1 })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        direction: "top",
        width: "wide",
        height: 1,
        padding: 1,
      }).success,
    ).toBe(false);
  });
});

describe("search_all_unique_properties schema", () => {
  const schema = schemaOf("search_all_unique_properties");

  it("accepts valid parents and property enums", () => {
    expect(
      schema.safeParse({
        parents: ["rootId"],
        properties: ["fillColor", "fontSize", "cornerRadius"],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown property names", () => {
    expect(
      schema.safeParse({ parents: ["rootId"], properties: ["opacity"] })
        .success,
    ).toBe(false);
  });

  it("requires both parents and properties as arrays", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ parents: ["rootId"] }).success).toBe(false);
    expect(
      schema.safeParse({ parents: "rootId", properties: ["fillColor"] })
        .success,
    ).toBe(false);
  });
});

describe("get_guidelines schema + execute", () => {
  const schema = schemaOf("get_guidelines");

  it("accepts known topics and rejects unknown/missing ones", () => {
    expect(schema.safeParse({ topic: "design-system" }).success).toBe(true);
    expect(schema.safeParse({ topic: "tailwind" }).success).toBe(true);
    expect(schema.safeParse({ topic: "made-up" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("execute returns the guideline text for a topic", async () => {
    const execute = (penTools.get_guidelines as {
      execute: (args: { topic: string }) => Promise<unknown>;
    }).execute;
    const result = (await execute({ topic: "design-system" })) as {
      topic: string;
      guidelines: string;
    };
    expect(result.topic).toBe("design-system");
    expect(result.guidelines).toContain("Auto-Layout");
  });
});

describe("get_style_guide_tags schema + execute", () => {
  const schema = schemaOf("get_style_guide_tags");

  it("accepts an empty object", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("execute returns the tag categories", async () => {
    const execute = (penTools.get_style_guide_tags as {
      execute: () => Promise<unknown>;
    }).execute;
    const result = (await execute()) as {
      tags: Record<string, string[]>;
    };
    expect(Object.keys(result.tags).sort()).toEqual([
      "color",
      "industry",
      "layout",
      "platform",
      "style",
    ]);
    expect(result.tags.style).toContain("minimal");
  });
});

describe("get_style_guide schema + execute", () => {
  const schema = schemaOf("get_style_guide");

  it("accepts tags, name, or an empty object", () => {
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ tags: ["minimal", "dark"] }).success).toBe(true);
    expect(schema.safeParse({ name: "Acme" }).success).toBe(true);
  });

  it("rejects wrongly typed fields", () => {
    expect(schema.safeParse({ tags: "minimal" }).success).toBe(false);
    expect(schema.safeParse({ name: 42 }).success).toBe(false);
  });

  it("execute echoes name/tags and returns a full style guide", async () => {
    const execute = (penTools.get_style_guide as {
      execute: (args: { tags?: string[]; name?: string }) => Promise<unknown>;
    }).execute;

    const named = (await execute({ name: "Acme" })) as {
      name: string;
      basedOn: string[];
      typography: unknown;
      colors: unknown;
    };
    expect(named.name).toBe("Acme");
    expect(named.basedOn).toEqual([]);
    expect(named.typography).toBeDefined();
    expect(named.colors).toBeDefined();

    const tagged = (await execute({ tags: ["minimal", "dark"] })) as {
      name: string;
      basedOn: string[];
    };
    expect(tagged.name).toBe("Generated Style Guide");
    expect(tagged.basedOn).toEqual(["minimal", "dark"]);
  });
});
