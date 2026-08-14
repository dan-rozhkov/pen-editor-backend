import { describe, expect, it } from "vitest";
import { parseScreenshotDataUrl } from "../src/ai/screenshotOutput.js";
import { penTools } from "../src/ai/tools.js";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("parseScreenshotDataUrl", () => {
  it("reads the handler's JSON string", () => {
    expect(parseScreenshotDataUrl(JSON.stringify({ imageData: DATA_URL }))).toEqual({
      base64: "iVBORw0KGgo=",
      mediaType: "image/png",
      dataUrl: DATA_URL,
    });
  });

  it("reads an already-parsed object and a bare data URL", () => {
    expect(parseScreenshotDataUrl({ imageData: DATA_URL })?.dataUrl).toBe(DATA_URL);
    expect(parseScreenshotDataUrl(DATA_URL)?.dataUrl).toBe(DATA_URL);
  });

  it("returns null for an error result or anything without an image", () => {
    expect(parseScreenshotDataUrl(JSON.stringify({ error: "Node not found." }))).toBeNull();
    expect(parseScreenshotDataUrl("just text")).toBeNull();
    expect(parseScreenshotDataUrl(undefined)).toBeNull();
  });
});

describe("get_screenshot toModelOutput", () => {
  const toModelOutput = (
    penTools.get_screenshot as unknown as {
      toModelOutput: (opts: { output: unknown }) => unknown;
    }
  ).toModelOutput;

  it("promotes the payload to a real image part instead of base64 text", () => {
    // The whole point: a vision-capable model must receive the picture, not a
    // few hundred KB of base64 it cannot read and pays for on every step.
    expect(toModelOutput({ output: JSON.stringify({ imageData: DATA_URL }) })).toEqual({
      type: "content",
      value: [{ type: "image-data", data: "iVBORw0KGgo=", mediaType: "image/png" }],
    });
  });

  it("passes an error result through as text", () => {
    const output = JSON.stringify({ error: "Node not found." });
    expect(toModelOutput({ output })).toEqual({ type: "text", value: output });
  });
});
