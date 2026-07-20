import { describe, expect, it, vi } from "vitest";
import {
  removeBase64Fields,
  sanitizeMcpToolResult,
  wrapReferoTools,
} from "../src/ai/mcp.js";

type ToolExecute = (input: unknown, options: unknown) => Promise<unknown>;

describe("removeBase64Fields", () => {
  it("drops a top-level base64 key while keeping siblings", () => {
    expect(removeBase64Fields({ url: "x", base64: "SECRET" })).toEqual({ url: "x" });
  });

  it("drops base64 nested in objects and arrays", () => {
    const input = {
      screens: [
        { id: 1, image: { url: "a", base64: "AAA" } },
        { id: 2, image: { url: "b", base64: "BBB" } },
      ],
    };
    expect(removeBase64Fields(input)).toEqual({
      screens: [
        { id: 1, image: { url: "a" } },
        { id: 2, image: { url: "b" } },
      ],
    });
  });

  it("passes primitives through unchanged", () => {
    expect(removeBase64Fields("hello")).toBe("hello");
    expect(removeBase64Fields(42)).toBe(42);
    expect(removeBase64Fields(null)).toBeNull();
    expect(removeBase64Fields(undefined)).toBeUndefined();
  });

  it("does not mutate the input object", () => {
    const input = { keep: 1, base64: "X", nested: { base64: "Y", ok: 2 } };
    const result = removeBase64Fields(input);
    expect(input.base64).toBe("X");
    expect(input.nested.base64).toBe("Y");
    expect(result).not.toBe(input);
  });
});

describe("sanitizeMcpToolResult", () => {
  it("returns non-object values unchanged", () => {
    expect(sanitizeMcpToolResult("text")).toBe("text");
    expect(sanitizeMcpToolResult(null)).toBeNull();
    expect(sanitizeMcpToolResult(7)).toBe(7);
  });

  it("strips base64 at the top level", () => {
    expect(sanitizeMcpToolResult({ base64: "AAA", meta: { ok: 1 } })).toEqual({
      meta: { ok: 1 },
    });
  });

  it("strips base64 embedded in JSON-encoded text content parts", () => {
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({ url: "https://x", base64: "HUGEPAYLOAD" }),
        },
      ],
    };
    const out = sanitizeMcpToolResult(result) as { content: { text: string }[] };
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed).toEqual({ url: "https://x" });
    expect(out.content[0].text).not.toContain("HUGEPAYLOAD");
  });

  it("leaves non-JSON text parts untouched", () => {
    const result = { content: [{ type: "text", text: "just a sentence" }] };
    const out = sanitizeMcpToolResult(result) as { content: { text: string }[] };
    expect(out.content[0].text).toBe("just a sentence");
  });

  it("ignores content parts that are not objects or lack string text", () => {
    const result = {
      content: ["raw-string", { type: "image", data: 1 }, null],
    };
    const out = sanitizeMcpToolResult(result) as { content: unknown[] };
    expect(out.content).toEqual(["raw-string", { type: "image", data: 1 }, null]);
  });

  it("returns the base64-stripped object when content is not an array", () => {
    expect(sanitizeMcpToolResult({ content: "nope", base64: "AAA" })).toEqual({
      content: "nope",
    });
  });
});

describe("wrapReferoTools", () => {
  it("returns the tool map unchanged when refero_get_screen is absent", () => {
    const tools = { some_tool: { execute: vi.fn() } };
    expect(wrapReferoTools(tools)).toBe(tools);
  });

  it("returns the tool map unchanged when execute is not a function", () => {
    const tools = { refero_get_screen: { description: "d" } };
    expect(wrapReferoTools(tools)).toBe(tools);
  });

  it("forces image_size:none, sanitizes the result, and preserves other tools", async () => {
    const original = vi.fn(async () => ({
      base64: "TOP",
      content: [
        { type: "text", text: JSON.stringify({ url: "u", base64: "INNER" }) },
      ],
    }));
    const otherTool = { execute: vi.fn() };
    const tools = {
      refero_get_screen: { description: "screens", execute: original },
      other_tool: otherTool,
    };

    const wrapped = wrapReferoTools(tools);
    const exec = (wrapped.refero_get_screen as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }).execute;

    const result = (await exec({ query: "hero" }, { signal: 1 })) as {
      base64?: string;
      content: { text: string }[];
    };

    // input augmented with image_size: "none", existing fields kept
    expect(original).toHaveBeenCalledWith(
      { query: "hero", image_size: "none" },
      { signal: 1 },
    );
    // result sanitized
    expect(result.base64).toBeUndefined();
    expect(result.content[0].text).not.toContain("INNER");
    // unrelated tools left intact
    expect(wrapped.other_tool).toBe(otherTool);
  });

  it("defaults to image_size:none when input is not an object", async () => {
    const original = vi.fn(async () => ({ ok: true }));
    const wrapped = wrapReferoTools({
      refero_get_screen: { execute: original },
    });
    const exec = (wrapped.refero_get_screen as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }).execute;

    await exec(undefined, {});
    expect(original).toHaveBeenCalledWith({ image_size: "none" }, {});
  });

  it("leaves the tool map unchanged (by reference) when neither refero tool is present", () => {
    const tools = { other_tool: { execute: vi.fn() } };
    expect(wrapReferoTools(tools)).toBe(tools);
  });

  it("leaves refero_get_screen's wrapping unaffected when refero_get_style is absent", async () => {
    const original = vi.fn(async () => ({ ok: true }));
    const tools = { refero_get_screen: { description: "d", execute: original } };
    const wrapped = wrapReferoTools(tools);
    expect(wrapped.refero_get_style).toBeUndefined();
    const exec = (wrapped.refero_get_screen as { execute: ToolExecute }).execute;
    await exec({}, {});
    expect(original).toHaveBeenCalledWith({ image_size: "none" }, {});
  });

  it("appends the one-UUID sentence to refero_get_style's description and sanitizes results", async () => {
    const original = vi.fn(async () => ({
      base64: "TOP",
      content: [{ type: "text", text: JSON.stringify({ ok: true, base64: "INNER" }) }],
    }));
    const tools = {
      refero_get_style: { description: "Fetch a style.", execute: original },
    };

    const wrapped = wrapReferoTools(tools);
    const tool = wrapped.refero_get_style as {
      description: string;
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };

    expect(tool.description).toBe(
      "Fetch a style. Pass exactly one valid style UUID (from refero_search_styles results) per call; multiple UUIDs are rejected.",
    );

    const result = (await tool.execute({ style_uuid: "abc" }, {})) as {
      base64?: string;
      content: { text: string }[];
    };
    expect(original).toHaveBeenCalledWith({ style_uuid: "abc" }, {});
    expect(result.base64).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true });
  });

  it("uses a bare description when refero_get_style has none", () => {
    const wrapped = wrapReferoTools({
      refero_get_style: { execute: vi.fn() },
    });
    const tool = wrapped.refero_get_style as { description: string };
    expect(tool.description).toBe(
      "Pass exactly one valid style UUID (from refero_search_styles results) per call; multiple UUIDs are rejected.",
    );
  });

  it.each([
    ["INVALID_STYLE_UUIDS", "invalid_style_uuids"],
    ["invalid style uuids (mixed case)", "Invalid Style UUIDs"],
    ["hyphenated", "invalid-style-uuid"],
    ["camelCase singular, no separator", "InvalidStyleUuid"],
  ])(
    "appends the retry hint when the result content indicates %s",
    async (_label, errorText) => {
      const original = vi.fn(async () => ({
        content: [{ type: "text", text: `Error: ${errorText}` }],
      }));
      const wrapped = wrapReferoTools({ refero_get_style: { execute: original } });
      const tool = wrapped.refero_get_style as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      };

      const result = (await tool.execute({}, {})) as { content: { text: string }[] };
      expect(result.content[0].text).toBe(
        `Error: ${errorText} Pass exactly one valid style UUID from refero_search_styles results per call.`,
      );
    },
  );

  it("does not append the retry hint to a benign isError:false result even if the text mentions invalid style uuids", async () => {
    const original = vi.fn(async () => ({
      isError: false,
      content: [{ type: "text", text: "Docs: avoid invalid style uuids by using search first." }],
    }));
    const wrapped = wrapReferoTools({ refero_get_style: { execute: original } });
    const tool = wrapped.refero_get_style as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };

    const result = (await tool.execute({}, {})) as { content: { text: string }[] };
    expect(result.content[0].text).toBe(
      "Docs: avoid invalid style uuids by using search first.",
    );
  });

  it("leaves the result untouched when no content part matches the invalid-uuid hint", async () => {
    const original = vi.fn(async () => ({
      content: [{ type: "text", text: "all good, nothing to see here" }],
    }));
    const wrapped = wrapReferoTools({ refero_get_style: { execute: original } });
    const tool = wrapped.refero_get_style as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };

    const result = (await tool.execute({}, {})) as { content: { text: string }[] };
    expect(result.content[0].text).toBe("all good, nothing to see here");
  });

  it("appends the retry hint when execute throws an invalid-style-uuids error", async () => {
    const original = vi.fn(async () => {
      throw new Error("Request failed: invalid_style_uuids");
    });
    const wrapped = wrapReferoTools({ refero_get_style: { execute: original } });
    const tool = wrapped.refero_get_style as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };

    await expect(tool.execute({}, {})).rejects.toThrow(
      "Request failed: invalid_style_uuids Pass exactly one valid style UUID from refero_search_styles results per call.",
    );
  });

  it("leaves unrelated errors and results untouched", async () => {
    const original = vi.fn(async () => {
      throw new Error("network timeout");
    });
    const wrapped = wrapReferoTools({ refero_get_style: { execute: original } });
    const tool = wrapped.refero_get_style as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    };

    await expect(tool.execute({}, {})).rejects.toThrow("network timeout");
  });

  it("wraps both refero_get_screen and refero_get_style without affecting each other", async () => {
    const screenOriginal = vi.fn(async () => ({ ok: "screen" }));
    const styleOriginal = vi.fn(async () => ({ ok: "style" }));
    const tools = {
      refero_get_screen: { description: "screens", execute: screenOriginal },
      refero_get_style: { description: "styles", execute: styleOriginal },
    };

    const wrapped = wrapReferoTools(tools);
    const screenExec = (wrapped.refero_get_screen as { execute: ToolExecute }).execute;
    const styleExec = (wrapped.refero_get_style as { execute: ToolExecute }).execute;

    await screenExec({}, {});
    expect(screenOriginal).toHaveBeenCalledWith({ image_size: "none" }, {});

    await styleExec({ style_uuid: "abc" }, {});
    expect(styleOriginal).toHaveBeenCalledWith({ style_uuid: "abc" }, {});
  });
});
