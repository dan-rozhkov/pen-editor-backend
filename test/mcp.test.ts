import { describe, expect, it, vi } from "vitest";
import {
  removeBase64Fields,
  sanitizeMcpToolResult,
  wrapReferoTools,
} from "../src/ai/mcp.js";

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
});
