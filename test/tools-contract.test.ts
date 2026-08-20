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
        "draw_vector",
        "boolean_operation",
        "find_empty_space_on_canvas",
        "generate_frame_image",
        "generate_image",
        "remove_background",
        "vectorize_image",
        "get_editor_state",
        "get_screenshot",
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
        "read_comments",
        "reply_comment",
        "resolve_comment",
        "leave_comment",
        "rename_layers",
        "read_embed_html",
        "edit_embed_html",
        "replace_all_matching_properties",
        "search_all_unique_properties",
        "set_export_settings",
        "export_layers_svg",
        "set_variables",
        "snapshot_layout",
        "create_plugin",
        "update_plugin",
        "list_plugins",
        "ask_user",
        "analyze_image",
        "publish_to_showcase",
        "update_tasks",
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
      "draw_vector",
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
      "read_embed_html",
      "edit_embed_html",
      "generate_image",
      "generate_frame_image",
      "remove_background",
      "vectorize_image",
      "boolean_operation",
      "set_export_settings",
      "export_layers_svg",
      "read_comments",
      "reply_comment",
      "resolve_comment",
      "leave_comment",
      "create_plugin",
      "update_plugin",
      "list_plugins",
      "ask_user",
      "get_screenshot",
      "publish_to_showcase",
      "update_tasks",
    ] as const) {
      expect(hasExecute(name), `${name} must be client-executed`).toBe(false);
    }

    // Static/read-only tools executed on the backend:
    for (const name of [
      "get_guidelines",
      "get_style_guide",
      "get_style_guide_tags",
      "analyze_image",
    ] as const) {
      expect(hasExecute(name), `${name} must execute on the backend`).toBe(true);
    }
  });
});

describe("draw_vector schema", () => {
  const schema = schemaOf("draw_vector");

  it("accepts a bounded progressive vector script", () => {
    expect(schema.safeParse({
      name: "Leaf",
      commands: [
        "M(120, 80)",
        "L(180, 60)",
        "L(160, 160)",
        "CLOSE()",
        'FILL("#65A765")',
        "END()",
      ].join("\n"),
    }).success).toBe(true);
  });

  it.each([
    { name: "", commands: "M(0,0)\nL(1,1)\nEND()" },
    { name: "Vector", commands: "" },
    { name: "Vector", commands: "x".repeat(32_769) },
  ])("rejects invalid bounds: %j", (input) => {
    expect(schema.safeParse(input).success).toBe(false);
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

  it("accepts more than 25 operations — the backend no longer truncates; the frontend truncates and reports back", () => {
    const ops = Array.from({ length: 26 }, (_, i) => `D("node${i}")`).join("\n");
    const result = schema.safeParse({ operations: ops });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.operations).toBe(ops);
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

describe("export_layers_svg schema", () => {
  const schema = schemaOf("export_layers_svg");

  it("accepts nodeIds", () => {
    expect(schema.safeParse({ nodeIds: ["n1", "n2"] }).success).toBe(true);
  });

  it("accepts an empty object (defaults to selection)", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({});
  });

  it("accepts an explicit empty nodeIds array (means \"export nothing\", not \"use selection\" — see frontend handler)", () => {
    const result = schema.safeParse({ nodeIds: [] });
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ nodeIds: [] });
  });

  it("rejects a non-array nodeIds", () => {
    expect(schema.safeParse({ nodeIds: "n1" }).success).toBe(false);
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

describe("read_comments schema", () => {
  const schema = schemaOf("read_comments");

  it("accepts an empty object (all fields optional)", () => {
    expect(schema.safeParse({}).success).toBe(true);
  });

  it("accepts includeResolved", () => {
    expect(schema.safeParse({ includeResolved: true }).success).toBe(true);
  });

  it("accepts threadId", () => {
    expect(schema.safeParse({ threadId: "t1" }).success).toBe(true);
  });

  it("rejects wrongly typed fields", () => {
    expect(schema.safeParse({ includeResolved: "yes" }).success).toBe(false);
    expect(schema.safeParse({ threadId: 1 }).success).toBe(false);
  });
});

describe("reply_comment schema", () => {
  const schema = schemaOf("reply_comment");

  it("accepts threadId and text", () => {
    expect(
      schema.safeParse({ threadId: "t1", text: "Fixed it." }).success,
    ).toBe(true);
  });

  it("requires threadId and text", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ threadId: "t1" }).success).toBe(false);
    expect(schema.safeParse({ text: "Fixed it." }).success).toBe(false);
  });

  it("rejects empty text", () => {
    expect(schema.safeParse({ threadId: "t1", text: "" }).success).toBe(false);
  });
});

describe("resolve_comment schema", () => {
  const schema = schemaOf("resolve_comment");

  it("accepts threadId", () => {
    expect(schema.safeParse({ threadId: "t1" }).success).toBe(true);
  });

  it("requires threadId", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ threadId: 1 }).success).toBe(false);
  });
});

describe("leave_comment schema", () => {
  const schema = schemaOf("leave_comment");

  it("accepts a single comment anchored to a nodeId", () => {
    expect(
      schema.safeParse({ comments: [{ nodeId: "n1", text: "x" }] }).success,
    ).toBe(true);
  });

  it("accepts a single comment anchored to x/y", () => {
    expect(
      schema.safeParse({ comments: [{ x: 10, y: 20, text: "x" }] }).success,
    ).toBe(true);
  });

  it("accepts a multi-item batch", () => {
    const result = schema.safeParse({
      comments: [
        { nodeId: "n1", text: "Contrast too low here." },
        { x: 100, y: 200, text: "Spacing feels arbitrary." },
        { nodeId: "n3", text: "Inconsistent corner radius." },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an item with neither nodeId nor x/y", () => {
    expect(schema.safeParse({ comments: [{ text: "x" }] }).success).toBe(false);
  });

  it("rejects an item with empty text", () => {
    expect(
      schema.safeParse({ comments: [{ nodeId: "n1", text: "" }] }).success,
    ).toBe(false);
  });

  it("rejects an empty comments array", () => {
    expect(schema.safeParse({ comments: [] }).success).toBe(false);
  });

  it("rejects an item with only x and no y", () => {
    expect(
      schema.safeParse({ comments: [{ x: 10, text: "x" }] }).success,
    ).toBe(false);
  });

  it("rejects an item with only y and no x", () => {
    expect(
      schema.safeParse({ comments: [{ y: 10, text: "x" }] }).success,
    ).toBe(false);
  });

  it("rejects missing comments field and more than 50 items", () => {
    expect(schema.safeParse({}).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({
      nodeId: `n${i}`,
      text: "x",
    }));
    expect(schema.safeParse({ comments: many }).success).toBe(false);
  });
});

describe("update_tasks schema", () => {
  const schema = schemaOf("update_tasks");

  it("accepts a single task", () => {
    expect(
      schema.safeParse({ tasks: [{ title: "Экран «Цели»", status: "pending" }] })
        .success,
    ).toBe(true);
  });

  it("accepts a full plan with mixed statuses", () => {
    const result = schema.safeParse({
      tasks: [
        { title: "Собрать стайл-гайд", status: "completed" },
        { title: "Экран «Цели»", status: "in_progress" },
        { title: "Экран «Прогресс»", status: "pending" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing tasks field", () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("rejects an empty tasks array", () => {
    expect(schema.safeParse({ tasks: [] }).success).toBe(false);
  });

  it("rejects more than 20 tasks", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      title: `Task ${i}`,
      status: "pending" as const,
    }));
    expect(schema.safeParse({ tasks: many }).success).toBe(false);
  });

  it("accepts exactly 20 tasks", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      title: `Task ${i}`,
      status: "pending" as const,
    }));
    expect(schema.safeParse({ tasks: twenty }).success).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(
      schema.safeParse({ tasks: [{ title: "", status: "pending" }] }).success,
    ).toBe(false);
  });

  it("rejects a missing status", () => {
    expect(schema.safeParse({ tasks: [{ title: "x" }] }).success).toBe(false);
  });

  it("rejects an invalid status value", () => {
    expect(
      schema.safeParse({ tasks: [{ title: "x", status: "done" }] }).success,
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

describe("create_plugin schema", () => {
  const schema = schemaOf("create_plugin");

  it("accepts the minimal required fields (headless plugin)", () => {
    const result = schema.safeParse({
      name: "Renamer",
      description: "Renames the selection sequentially.",
      code: "pen.notify('hi')",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an explicit null ui (headless) and an object ui (panel size)", () => {
    expect(
      schema.safeParse({
        name: "Renamer",
        description: "d",
        code: "c",
        ui: null,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        name: "Renamer",
        description: "d",
        code: "c",
        icon: "✏️",
        ui: { width: 320, height: 240 },
      }).success,
    ).toBe(true);
  });

  it("requires non-empty name, description and code", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ name: "", description: "d", code: "c" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ name: "n", description: "", code: "c" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ name: "n", description: "d", code: "" }).success,
    ).toBe(false);
  });

  it("rejects a malformed ui", () => {
    expect(
      schema.safeParse({
        name: "n",
        description: "d",
        code: "c",
        ui: { width: 320 },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        name: "n",
        description: "d",
        code: "c",
        ui: { width: -1, height: 240 },
      }).success,
    ).toBe(false);
  });
});

describe("update_plugin schema", () => {
  const schema = schemaOf("update_plugin");

  it("accepts just an id (no-op patch shape-wise)", () => {
    expect(schema.safeParse({ id: "plugin-1" }).success).toBe(true);
  });

  it("accepts any subset of patch fields", () => {
    expect(
      schema.safeParse({ id: "plugin-1", name: "New name" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ id: "plugin-1", code: "pen.close()" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ id: "plugin-1", ui: null }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ id: "plugin-1", ui: { width: 100, height: 100 } })
        .success,
    ).toBe(true);
  });

  it("requires id", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ name: "New name" }).success).toBe(false);
  });

  it("rejects empty-string patch fields", () => {
    expect(schema.safeParse({ id: "plugin-1", name: "" }).success).toBe(false);
    expect(
      schema.safeParse({ id: "plugin-1", description: "" }).success,
    ).toBe(false);
    expect(schema.safeParse({ id: "plugin-1", code: "" }).success).toBe(false);
  });
});

describe("list_plugins schema", () => {
  const schema = schemaOf("list_plugins");

  it("accepts an empty object", () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({});
  });
});

describe("ask_user schema", () => {
  const schema = schemaOf("ask_user");

  it("accepts a full multi-question payload", () => {
    const result = schema.safeParse({
      title: "A couple of questions",
      questions: [
        { id: "audience", label: "Who is the audience?", type: "single",
          options: [{ value: "devs", label: "Developers" }], required: true },
        { id: "focus", label: "What to emphasize?", hint: "Pick several",
          type: "multi", options: [{ value: "speed", label: "Speed" }] },
        { id: "name", label: "Project name?", type: "text", placeholder: "Acme" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a single question without a title", () => {
    expect(
      schema.safeParse({
        questions: [{ id: "q1", label: "Language?", type: "single",
          options: [{ value: "en", label: "English" }] }],
      }).success,
    ).toBe(true);
  });

  it("requires at least one question and rejects an empty array", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ questions: [] }).success).toBe(false);
  });

  it("rejects an unknown field type and a blank id/label", () => {
    expect(schema.safeParse({ questions: [{ id: "q", label: "L", type: "slider" }] }).success).toBe(false);
    expect(schema.safeParse({ questions: [{ id: "", label: "L", type: "text" }] }).success).toBe(false);
    expect(schema.safeParse({ questions: [{ id: "q", label: "", type: "text" }] }).success).toBe(false);
  });

  it("rejects single/multi/select questions without options", () => {
    for (const type of ["single", "multi", "select"] as const) {
      expect(
        schema.safeParse({ questions: [{ id: "q", label: "L", type }] }).success,
        `${type} without options`,
      ).toBe(false);
      expect(
        schema.safeParse({ questions: [{ id: "q", label: "L", type, options: [] }] }).success,
        `${type} with empty options`,
      ).toBe(false);
    }
  });

  it("allows a text question without options", () => {
    expect(
      schema.safeParse({ questions: [{ id: "q", label: "L", type: "text" }] }).success,
    ).toBe(true);
  });

  it("rejects duplicate question ids", () => {
    expect(
      schema.safeParse({
        questions: [
          { id: "dup", label: "A", type: "text" },
          { id: "dup", label: "B", type: "text" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("publish_to_showcase schema", () => {
  const schema = schemaOf("publish_to_showcase");

  it("accepts a valid multi-screen payload", () => {
    const result = schema.safeParse({
      theme: "Habit tracker",
      prompt: "A minimal daily habit tracker with streaks.",
      platform: "mobile",
      screens: [
        { nodeId: "n1", title: "Onboarding", cover: true },
        { nodeId: "n2", title: "Today" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts the minimal shape (theme + one screen, no optional fields)", () => {
    expect(
      schema.safeParse({
        theme: "Habit tracker",
        screens: [{ nodeId: "n1", title: "Onboarding" }],
      }).success,
    ).toBe(true);
  });

  it("rejects a screen without a title", () => {
    expect(
      schema.safeParse({
        theme: "Habit tracker",
        screens: [{ nodeId: "n1" }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        theme: "Habit tracker",
        screens: [{ nodeId: "n1", title: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects more than 5 screens", () => {
    const screens = Array.from({ length: 6 }, (_, i) => ({
      nodeId: `n${i}`,
      title: `Screen ${i}`,
    }));
    expect(schema.safeParse({ theme: "Habit tracker", screens }).success).toBe(false);
  });

  it("requires theme and a non-empty screens array", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ theme: "Habit tracker", screens: [] }).success).toBe(false);
    expect(
      schema.safeParse({ screens: [{ nodeId: "n1", title: "Onboarding" }] }).success,
    ).toBe(false);
  });

  it("rejects an invalid platform value", () => {
    expect(
      schema.safeParse({
        theme: "Habit tracker",
        platform: "tablet",
        screens: [{ nodeId: "n1", title: "Onboarding" }],
      }).success,
    ).toBe(false);
  });
});

describe("edit_embed_html schema", () => {
  const schema = (penTools.edit_embed_html as { inputSchema: z.ZodTypeAny }).inputSchema;

  it("accepts a minimal single edit", () => {
    const parsed = schema.parse({
      nodeId: "embed1",
      edits: [{ oldString: "#111", newString: "#222" }],
    });
    expect(parsed.edits[0].replaceAll).toBeUndefined();
  });

  it("rejects an empty edits array", () => {
    expect(() => schema.parse({ nodeId: "embed1", edits: [] })).toThrow();
  });

  it("rejects more than 20 edits", () => {
    const edits = Array.from({ length: 21 }, (_, i) => ({ oldString: `a${i}`, newString: "b" }));
    expect(() => schema.parse({ nodeId: "embed1", edits })).toThrow();
  });

  it("rejects an empty oldString but allows an empty newString (deletion)", () => {
    expect(() => schema.parse({ nodeId: "e", edits: [{ oldString: "", newString: "x" }] })).toThrow();
    expect(() => schema.parse({ nodeId: "e", edits: [{ oldString: "x", newString: "" }] })).not.toThrow();
  });
});

describe("read_embed_html schema", () => {
  const schema = (penTools.read_embed_html as { inputSchema: z.ZodTypeAny }).inputSchema;

  it("defaults to outline mode with sane context/depth", () => {
    const parsed = schema.parse({ nodeId: "embed1" });
    expect(parsed.mode).toBe("outline");
    expect(parsed.contextLines).toBe(2);
    expect(parsed.maxDepth).toBe(4);
  });

  it("requires a pattern in grep mode", () => {
    expect(() => schema.parse({ nodeId: "embed1", mode: "grep" })).toThrow();
    expect(() => schema.parse({ nodeId: "embed1", mode: "grep", pattern: "btn" })).not.toThrow();
  });
});
