import { describe, expect, it, vi } from "vitest";
import {
  MAX_INLINE_BINARY_CHARS,
  removeBase64Fields,
  sanitizeAllToolResults,
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
    // Finding 2/4: the sanitizer used to drop EVERY image regardless of
    // size. A thumbnail well under the inline threshold must now pass
    // through byte-for-byte so a vision-capable model on the shipped config
    // (OpenRouter, native on both axes) can see it directly.
    const smallPayload = "A".repeat(2000); // well under MAX_INLINE_BINARY_CHARS
    const result = {
      content: [{ type: "image", data: smallPayload, mimeType: "image/jpeg" }],
    };
    expect(sanitizeMcpToolResult(result, true)).toEqual(result);
  });

  it("replaces an OVERSIZED MCP image content part with a text description, dropping the base64 payload", () => {
    // This is the real shape a production session leaked: {type:"image",
    // data, mimeType} is the standard MCP image content part, and the field
    // is "data" — not "base64" — so removeBase64Fields alone never caught it.
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
    // Finding 2b: chatTurn.ts deletes analyze_image from the tool set
    // whenever isVisionConfigured(config) is false — naming it here would
    // point the model at a tool that isn't in this turn's tool set.
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

  it("leaves a SMALL non-image 'file' content part (e.g. a small PDF) untouched", () => {
    const result = {
      content: [{ type: "file", data: "not-really-checked", mimeType: "application/pdf" }],
    };
    expect(sanitizeMcpToolResult(result, true)).toEqual(result);
  });

  it("replaces an OVERSIZED non-image 'file' content part (e.g. a large PDF) too — the floor applies regardless of mimeType", () => {
    // Finding 4: the size floor must apply to ANY oversized binary, not just
    // images — an earlier version of this suite asserted a multi-MB PDF's
    // `data` survived untouched, which was the exact gap this closes.
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
    // Finding 4: this shape carries its payload under resource.blob, not
    // `data` or `base64` — isImageContentPart never looked at it and
    // removeBase64Fields doesn't either (the key is "blob", not "base64"),
    // so it used to pass through whole regardless of size.
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
});

describe("sanitizeAllToolResults", () => {
  it("sanitizes the result of a tool that is NOT one of the two hand-wrapped Refero tools", async () => {
    // Before this fix, only refero_get_screen and refero_get_style ever had
    // their execute() output sanitized (via wrapReferoTool inside
    // wrapReferoTools) — every other MCP tool, refero_get_screen_image
    // included, reached the model with raw image bytes intact.
    const bigPayload = "C".repeat(MAX_INLINE_BINARY_CHARS + 1);
    const original = vi.fn(async () => ({
      content: [{ type: "image", data: bigPayload, mimeType: "image/jpeg" }],
    }));
    const tools = { some_other_mcp_tool: { execute: original } };

    const wrapped = sanitizeAllToolResults(tools, true);
    const exec = (wrapped.some_other_mcp_tool as { execute: (i: unknown, o: unknown) => Promise<unknown> })
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

describe("wrapReferoTools", () => {
  it("returns the tool map unchanged when refero_get_screen is absent", () => {
    const tools = { some_tool: { execute: vi.fn() } };
    expect(wrapReferoTools(tools, true)).toBe(tools);
  });

  it("returns the tool map unchanged when execute is not a function", () => {
    const tools = { refero_get_screen: { description: "d" } };
    expect(wrapReferoTools(tools, true)).toBe(tools);
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

    const wrapped = wrapReferoTools(tools, true);
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
    const wrapped = wrapReferoTools(
      { refero_get_screen: { execute: original } },
      true,
    );
    const exec = (wrapped.refero_get_screen as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }).execute;

    await exec(undefined, {});
    expect(original).toHaveBeenCalledWith({ image_size: "none" }, {});
  });

  it("leaves the tool map unchanged (by reference) when neither refero tool is present", () => {
    const tools = { other_tool: { execute: vi.fn() } };
    expect(wrapReferoTools(tools, true)).toBe(tools);
  });

  it("leaves refero_get_screen's wrapping unaffected when refero_get_style is absent", async () => {
    const original = vi.fn(async () => ({ ok: true }));
    const tools = { refero_get_screen: { description: "d", execute: original } };
    const wrapped = wrapReferoTools(tools, true);
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

    const wrapped = wrapReferoTools(tools, true);
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
    const wrapped = wrapReferoTools(
      { refero_get_style: { execute: vi.fn() } },
      true,
    );
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
      const wrapped = wrapReferoTools({ refero_get_style: { execute: original } }, true);
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
    const wrapped = wrapReferoTools({ refero_get_style: { execute: original } }, true);
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
    const wrapped = wrapReferoTools({ refero_get_style: { execute: original } }, true);
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
    const wrapped = wrapReferoTools({ refero_get_style: { execute: original } }, true);
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
    const wrapped = wrapReferoTools({ refero_get_style: { execute: original } }, true);
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

    const wrapped = wrapReferoTools(tools, true);
    const screenExec = (wrapped.refero_get_screen as { execute: ToolExecute }).execute;
    const styleExec = (wrapped.refero_get_style as { execute: ToolExecute }).execute;

    await screenExec({}, {});
    expect(screenOriginal).toHaveBeenCalledWith({ image_size: "none" }, {});

    await styleExec({ style_uuid: "abc" }, {});
    expect(styleOriginal).toHaveBeenCalledWith({ style_uuid: "abc" }, {});
  });

  describe("refero_get_screen_image", () => {
    // A small, already-sanitized-looking result — what the tool's execute
    // returns when the real image comes back under MAX_INLINE_BINARY_CHARS.
    // In production this is what sanitizeAllToolResults (applied to every
    // tool BEFORE wrapReferoTools ever sees it, see connectAndFetchTools)
    // would already have produced; these unit tests craft it directly since
    // they exercise wrapReferoTools in isolation from that earlier stage.
    function smallImageResult() {
      return { content: [{ type: "image", data: "AAAA", mimeType: "image/jpeg" }] };
    }

    // What sanitizeAllToolResults would have already turned an OVERSIZED raw
    // image into — built via the real sanitizer so this fixture can't drift
    // from describeDroppedBinaryPart's actual wording.
    function droppedImageResult(visionConfigured: boolean) {
      return sanitizeMcpToolResult(
        {
          content: [
            { type: "image", data: "X".repeat(MAX_INLINE_BINARY_CHARS + 1), mimeType: "image/jpeg" },
          ],
        },
        visionConfigured,
      );
    }

    function makeTools(overrides: {
      getScreen: ToolExecute;
      getScreenImage?: ToolExecute;
    }) {
      return {
        refero_get_screen: { description: "screens", execute: overrides.getScreen },
        refero_get_screen_image: {
          description: "raw image",
          execute: overrides.getScreenImage ?? vi.fn(async () => ({ content: [] })),
        },
      };
    }

    it("lets a SMALL real image through untouched, without ever calling refero_get_screen for a URL", async () => {
      // Finding 2a: the wrap used to unconditionally redirect to a text
      // pointer regardless of size — a vision-capable model could never see
      // this tool's image natively. Now a small (under-threshold) result
      // passes straight through.
      const getScreen = vi.fn();
      const getScreenImage = vi.fn(async () => smallImageResult());
      const wrapped = wrapReferoTools(makeTools({ getScreen, getScreenImage }), true);
      const tool = wrapped.refero_get_screen_image as { execute: ToolExecute };

      const result = (await tool.execute({ screen_id: "abc" }, {})) as {
        content: { type: string; data?: string }[];
      };

      expect(getScreenImage).toHaveBeenCalledOnce();
      expect(getScreen).not.toHaveBeenCalled();
      expect(result).toEqual(smallImageResult());
    });

    it("resolves a URL via refero_get_screen when the real call's image was dropped as oversized", async () => {
      const getScreen = vi.fn(async () => ({
        preview_url: "https://images.refero.design/x_preview.jpg",
        uuid: "abc",
      }));
      const getScreenImage = vi.fn(async () => droppedImageResult(true));
      const wrapped = wrapReferoTools(makeTools({ getScreen, getScreenImage }), true);
      const tool = wrapped.refero_get_screen_image as { execute: ToolExecute };

      const result = (await tool.execute({ screen_id: "abc" }, {})) as {
        content: { type: string; text: string }[];
      };

      // Exactly ONE real image-fetch call — the URL lookup is enrichment
      // AFTER that call comes back dropped, never a second image call.
      expect(getScreenImage).toHaveBeenCalledOnce();
      expect(getScreenImage).toHaveBeenCalledWith({ screen_id: "abc" }, {});
      // Goes through the ALREADY-WRAPPED refero_get_screen, which itself
      // forces image_size:"none" onto every call (see the wrap above).
      expect(getScreen).toHaveBeenCalledWith(
        { screen_id: "abc", response_format: "json", image_size: "none" },
        {},
      );
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain(
        "https://images.refero.design/x_preview.jpg",
      );
      expect(result.content[0].text).toContain("analyze_image");
    });

    it("returns the dropped placeholder as-is (no URL lookup) when there is no screen_id", async () => {
      const getScreen = vi.fn();
      const getScreenImage = vi.fn(async () => droppedImageResult(true));
      const wrapped = wrapReferoTools(makeTools({ getScreen, getScreenImage }), true);
      const tool = wrapped.refero_get_screen_image as { execute: ToolExecute };

      const result = await tool.execute({}, {});

      expect(getScreen).not.toHaveBeenCalled();
      expect(result).toEqual(droppedImageResult(true));
    });

    it("returns the dropped placeholder as-is when refero_get_screen throws", async () => {
      const getScreen = vi.fn(async () => {
        throw new Error("not found");
      });
      const getScreenImage = vi.fn(async () => droppedImageResult(true));
      const wrapped = wrapReferoTools(makeTools({ getScreen, getScreenImage }), true);
      const tool = wrapped.refero_get_screen_image as { execute: ToolExecute };

      const result = await tool.execute({ screen_id: "abc" }, {});

      // Only the one (already-spent) image call — no second real call is
      // made just because the URL lookup failed (finding 5).
      expect(getScreenImage).toHaveBeenCalledOnce();
      expect(result).toEqual(droppedImageResult(true));
    });

    it("returns the dropped placeholder as-is when refero_get_screen has no preview/thumbnail URL", async () => {
      const getScreen = vi.fn(async () => ({ uuid: "abc" })); // no preview_url/thumbnail_url
      const getScreenImage = vi.fn(async () => droppedImageResult(true));
      const wrapped = wrapReferoTools(makeTools({ getScreen, getScreenImage }), true);
      const tool = wrapped.refero_get_screen_image as { execute: ToolExecute };

      const result = await tool.execute({ screen_id: "abc" }, {});

      expect(result).toEqual(droppedImageResult(true));
    });

    it("forces image_size:thumbnail and never looks up a URL when vision is not configured", async () => {
      // Finding 2b: chatTurn.ts deletes analyze_image whenever
      // isVisionConfigured(config) is false, so a URL pointer naming it (or
      // even attempting the lookup) would be worse than useless. Instead the
      // real call is forced to the smallest size and its (still
      // threshold-sanitized) result is returned as-is either way.
      const getScreen = vi.fn();
      const getScreenImage = vi.fn(async () => droppedImageResult(false));
      const wrapped = wrapReferoTools(makeTools({ getScreen, getScreenImage }), false);
      const tool = wrapped.refero_get_screen_image as { execute: ToolExecute };

      const result = await tool.execute({ screen_id: "abc" }, {});

      expect(getScreenImage).toHaveBeenCalledWith({ screen_id: "abc", image_size: "thumbnail" }, {});
      expect(getScreen).not.toHaveBeenCalled();
      expect(result).toEqual(droppedImageResult(false));
      expect((result as { content: { text?: string }[] }).content[0].text).not.toContain(
        "analyze_image",
      );
    });

    it("forces image_size:thumbnail even when input is not an object, vision not configured", async () => {
      const getScreenImage = vi.fn(async () => ({ content: [] }));
      const wrapped = wrapReferoTools(
        makeTools({ getScreen: vi.fn(), getScreenImage }),
        false,
      );
      const tool = wrapped.refero_get_screen_image as { execute: ToolExecute };

      await tool.execute(undefined, {});

      expect(getScreenImage).toHaveBeenCalledWith({ image_size: "thumbnail" }, {});
    });

    it("leaves the tool map unchanged when refero_get_screen is absent", () => {
      const tools = { refero_get_screen_image: { execute: vi.fn() } };
      const wrapped = wrapReferoTools(tools, true);
      expect(wrapped.refero_get_screen_image).toBe(tools.refero_get_screen_image);
    });
  });
});
