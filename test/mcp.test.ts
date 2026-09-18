import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_INLINE_BINARY_CHARS,
  MAX_TOTAL_BINARY_CHARS_PER_RESULT,
  removeBase64Fields,
  sanitizeAllToolResults,
  sanitizeMcpToolResult,
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
    expect(sanitizeMcpToolResult("text", true)).toBe("text");
    expect(sanitizeMcpToolResult(null, true)).toBeNull();
    expect(sanitizeMcpToolResult(7, true)).toBe(7);
  });

  it("strips base64 at the top level", () => {
    expect(sanitizeMcpToolResult({ base64: "AAA", meta: { ok: 1 } }, true)).toEqual({
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
    const out = sanitizeMcpToolResult(result, true) as { content: { text: string }[] };
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed).toEqual({ url: "https://x" });
    expect(out.content[0].text).not.toContain("HUGEPAYLOAD");
  });

  it("leaves non-JSON text parts untouched", () => {
    const result = { content: [{ type: "text", text: "just a sentence" }] };
    const out = sanitizeMcpToolResult(result, true) as { content: { text: string }[] };
    expect(out.content[0].text).toBe("just a sentence");
  });

  it("ignores content parts that are not objects or lack string text", () => {
    const result = {
      content: ["raw-string", { type: "image", data: 1 }, null],
    };
    const out = sanitizeMcpToolResult(result, true) as { content: unknown[] };
    expect(out.content).toEqual(["raw-string", { type: "image", data: 1 }, null]);
  });

  it("returns the base64-stripped object when content is not an array", () => {
    expect(sanitizeMcpToolResult({ content: "nope", base64: "AAA" }, true)).toEqual({
      content: "nope",
    });
  });

  it("leaves a SMALL image content part untouched — under MAX_INLINE_BINARY_CHARS reaches a vision-capable model natively", () => {
    // Mobbin's own previews are deliberately low-resolution and meant to be
    // read by the model — this must pass through byte-for-byte so the
    // shipped OpenRouter provider (native on both axes) sees it directly.
    const smallPayload = "A".repeat(2000); // well under MAX_INLINE_BINARY_CHARS
    const result = {
      content: [{ type: "image", data: smallPayload, mimeType: "image/jpeg" }],
    };
    expect(sanitizeMcpToolResult(result, true)).toEqual(result);
  });

  it("replaces an OVERSIZED MCP image content part with a text description, dropping the base64 payload", () => {
    // {type:"image", data, mimeType} is the standard MCP image content
    // part, and the field is "data" — not "base64" — so removeBase64Fields
    // alone never catches it.
    const bigPayload = "A".repeat(MAX_INLINE_BINARY_CHARS + 1);
    const result = {
      content: [{ type: "image", data: bigPayload, mimeType: "image/jpeg" }],
    };
    const out = sanitizeMcpToolResult(result, true) as {
      content: { type: string; text?: string; data?: unknown }[];
    };
    const part = out.content[0];
    expect(part.type).toBe("text");
    expect(part.data).toBeUndefined();
    expect(part.text).not.toContain(bigPayload);
    expect(part.text).toContain("image/jpeg");
    // Points the model at the real way to inspect an image, instead of a
    // dead end — but only when vision (analyze_image) is actually available.
    expect(part.text).toContain("analyze_image");
    expect(JSON.stringify(out)).not.toContain(bigPayload);
  });

  it("does not mention analyze_image for a dropped image when vision is not configured", () => {
    // chatTurn.ts deletes analyze_image from the tool set whenever
    // isVisionConfigured(config) is false — naming it here would point the
    // model at a tool that isn't in this turn's tool set.
    const bigPayload = "A".repeat(MAX_INLINE_BINARY_CHARS + 1);
    const result = {
      content: [{ type: "image", data: bigPayload, mimeType: "image/jpeg" }],
    };
    const out = sanitizeMcpToolResult(result, false) as { content: { text?: string }[] };
    expect(out.content[0].text).not.toContain("analyze_image");
    expect(out.content[0].text).toContain("image/jpeg");
  });

  it("replaces the OVERSIZED {type:'file', data, mimeType} image content variant too", () => {
    const bigPayload = "B".repeat(MAX_INLINE_BINARY_CHARS + 1);
    const result = {
      content: [{ type: "file", data: bigPayload, mimeType: "image/png" }],
    };
    const out = sanitizeMcpToolResult(result, true) as {
      content: { type: string; text?: string }[];
    };
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toContain("image/png");
    expect(JSON.stringify(out)).not.toContain(bigPayload);
  });

  it("leaves a small non-image 'file' content part (e.g. a small PDF) untouched", () => {
    const result = {
      content: [{ type: "file", data: "not-really-checked", mimeType: "application/pdf" }],
    };
    expect(sanitizeMcpToolResult(result, true)).toEqual(result);
  });

  it("replaces an OVERSIZED non-image 'file' content part (e.g. a large PDF) too — the floor applies regardless of mimeType", () => {
    const bigPdf = "P".repeat(MAX_INLINE_BINARY_CHARS + 1);
    const result = {
      content: [{ type: "file", data: bigPdf, mimeType: "application/pdf" }],
    };
    const out = sanitizeMcpToolResult(result, true) as { content: { type: string; text?: string }[] };
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toContain("application/pdf");
    // Non-image drop: no analyze_image pointer, that tool only inspects images.
    expect(out.content[0].text).not.toContain("analyze_image");
    expect(JSON.stringify(out)).not.toContain(bigPdf);
  });

  it("replaces an oversized {type:'audio', data} content part", () => {
    const bigAudio = "S".repeat(MAX_INLINE_BINARY_CHARS + 1);
    const result = {
      content: [{ type: "audio", data: bigAudio, mimeType: "audio/wav" }],
    };
    const out = sanitizeMcpToolResult(result, true) as { content: { type: string; text?: string }[] };
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toContain("audio/wav");
    expect(JSON.stringify(out)).not.toContain(bigAudio);
  });

  it("replaces an oversized MCP embedded resource ({type:'resource', resource:{blob, mimeType}})", () => {
    const bigBlob = "R".repeat(MAX_INLINE_BINARY_CHARS + 1);
    const result = {
      content: [
        { type: "resource", resource: { blob: bigBlob, mimeType: "image/png", uri: "x" } },
      ],
    };
    const out = sanitizeMcpToolResult(result, true) as { content: { type: string; text?: string }[] };
    expect(out.content[0].type).toBe("text");
    expect(out.content[0].text).toContain("image/png");
    expect(JSON.stringify(out)).not.toContain(bigBlob);
  });

  it("leaves a small MCP embedded resource untouched", () => {
    const result = {
      content: [{ type: "resource", resource: { blob: "AAA", mimeType: "image/png" } }],
    };
    expect(sanitizeMcpToolResult(result, true)).toEqual(result);
  });

  // Finding 1: the per-part ceiling (MAX_INLINE_BINARY_CHARS) alone lets a
  // search result with many previews, each individually under that
  // ceiling, sum to far more than any single-part check catches. This is
  // the exact scenario the review called out: "one preview at 250k and
  // seven at 150k" — reproduced here directly (the aggregate budget is what
  // must catch the seven 150k parts; a 250k single part would already be
  // caught by the per-part ceiling alone, which is covered by the existing
  // oversized-part tests above).
  describe("aggregate binary budget across one result's parts", () => {
    it("passes through several small previews whose SUM stays under the aggregate budget", () => {
      // 3 parts x 50,000 chars = 150,000 chars total, under both the
      // per-part ceiling (200,000) and the aggregate budget (300,000).
      const part = (n: number) => ({
        type: "image",
        data: "A".repeat(50_000),
        mimeType: "image/jpeg",
        id: n,
      });
      const result = { content: [part(1), part(2), part(3)] };
      const out = sanitizeMcpToolResult(result, true) as {
        content: { type: string; id: number }[];
      };
      expect(out.content.every((p) => p.type === "image")).toBe(true);
      expect(out.content.map((p) => p.id)).toEqual([1, 2, 3]);
    });

    it("drops every part past the point the running total crosses the aggregate budget, keeping earlier ones intact", () => {
      // 8 parts x 150,000 chars = 1,200,000 chars — each individually well
      // under the 200,000-char per-part ceiling, but the sum is 4x the
      // 300,000-char aggregate budget. This is the reviewer's "8 results,
      // each with its own inline preview" scenario for search_screens/
      // search_sections (MOBBIN_LIMIT_CAPS = 8).
      const partSize = 150_000;
      const parts = Array.from({ length: 8 }, (_, i) => ({
        type: "image",
        data: "A".repeat(partSize),
        mimeType: "image/jpeg",
        id: i,
      }));
      const result = { content: parts };
      const out = sanitizeMcpToolResult(result, true) as {
        content: { type: string; text?: string; id?: number }[];
      };

      // First two (300,000 chars) fit exactly at the budget; the third
      // would push the running total to 450,000 and is dropped, along
      // with every part after it.
      expect(out.content[0].type).toBe("image");
      expect(out.content[0].id).toBe(0);
      expect(out.content[1].type).toBe("image");
      expect(out.content[1].id).toBe(1);
      for (let i = 2; i < 8; i++) {
        expect(out.content[i].type).toBe("text");
        expect(out.content[i].text).toContain("aggregate budget");
      }

      // The whole point: this tool result no longer carries anywhere near
      // 1.2M base64 chars once sanitized.
      const serialized = JSON.stringify(out);
      expect(serialized.length).toBeLessThan(MAX_TOTAL_BINARY_CHARS_PER_RESULT + partSize * 2);
    });

    it("an individually-oversized part is dropped by the per-part check and never counts toward the aggregate running total", () => {
      // A single part over MAX_INLINE_BINARY_CHARS is caught by the
      // per-part ceiling first (existing behavior) — it must not also
      // consume aggregate budget on the way out, since nothing of it
      // survives either way. Two more small parts after it should still
      // pass through untouched.
      const oversizedPart = {
        type: "image",
        data: "B".repeat(MAX_INLINE_BINARY_CHARS + 1),
        mimeType: "image/jpeg",
      };
      const smallPart = (id: number) => ({
        type: "image",
        data: "A".repeat(50_000),
        mimeType: "image/jpeg",
        id,
      });
      const result = { content: [oversizedPart, smallPart(1), smallPart(2)] };
      const out = sanitizeMcpToolResult(result, true) as {
        content: { type: string; id?: number }[];
      };
      expect(out.content[0].type).toBe("text"); // per-part drop
      expect(out.content[1].type).toBe("image");
      expect(out.content[1].id).toBe(1);
      expect(out.content[2].type).toBe("image");
      expect(out.content[2].id).toBe(2);
    });

    it("caps the aggregate cost of a realistic 8-item search_screens-shaped result end to end via sanitizeAllToolResults", async () => {
      const partSize = 150_000;
      const original = vi.fn(async () => ({
        content: Array.from({ length: 8 }, () => ({
          type: "image",
          data: "A".repeat(partSize),
          mimeType: "image/jpeg",
        })),
      }));
      const tools = { search_screens: { execute: original } };
      const wrapped = sanitizeAllToolResults(tools, true);
      const exec = (
        wrapped.search_screens as { execute: (i: unknown, o: unknown) => Promise<unknown> }
      ).execute;
      const result = (await exec({}, {})) as { content: { type: string }[] };

      const imageParts = result.content.filter((p) => p.type === "image");
      const textParts = result.content.filter((p) => p.type === "text");
      expect(imageParts.length).toBeLessThan(8);
      expect(textParts.length).toBeGreaterThan(0);
      // Never even close to the un-budgeted ~1.2M chars this result would
      // have cost before the aggregate budget existed.
      expect(JSON.stringify(result).length).toBeLessThan(partSize * 3);
    });
  });
});

describe("sanitizeAllToolResults", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sanitizes the result of an arbitrary MCP tool (e.g. search_screens)", async () => {
    const bigPayload = "C".repeat(MAX_INLINE_BINARY_CHARS + 1);
    const original = vi.fn(async () => ({
      content: [{ type: "image", data: bigPayload, mimeType: "image/jpeg" }],
    }));
    const tools = { search_screens: { execute: original } };

    const wrapped = sanitizeAllToolResults(tools, true);
    const exec = (wrapped.search_screens as { execute: (i: unknown, o: unknown) => Promise<unknown> })
      .execute;
    const result = (await exec({}, {})) as { content: { type: string; text?: string }[] };

    expect(original).toHaveBeenCalledWith({}, {});
    expect(result.content[0].type).toBe("text");
    expect(JSON.stringify(result)).not.toContain(bigPayload);
  });

  it("leaves a tool with no execute function unchanged, by reference", () => {
    const tools = { static_tool: { description: "no execute here" } };
    const wrapped = sanitizeAllToolResults(tools, true);
    expect(wrapped.static_tool).toBe(tools.static_tool);
  });
});
