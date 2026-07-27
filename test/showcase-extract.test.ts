import { describe, expect, it } from "vitest";
import { extractEmbedScreens } from "../src/showcase/extractEmbeds.js";

describe("extractEmbedScreens", () => {
  it("extracts a single embed screen's name and htmlContent", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Home", htmlContent: "<!doctype html><html><body>Hi</body></html>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toEqual([
      { name: "Home", htmlContent: "<!doctype html><html><body>Hi</body></html>" },
    ]);
  });

  it("handles escaped double quotes inside the HTML", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Quotes", htmlContent: "<div class=\\"card\\">Hi</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].htmlContent).toBe('<div class="card">Hi</div>');
  });

  it("handles literal braces inside an inline <style> block", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Styled", htmlContent: "<style>.foo{color:red;padding:4px}</style><div class=\\"foo\\">Hi</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].htmlContent).toBe(
      '<style>.foo{color:red;padding:4px}</style><div class="foo">Hi</div>',
    );
  });

  it("extracts multiple screens from one operations script", () => {
    const operations = [
      's1=I(document, {type: "embed", name: "Home", htmlContent: "<div>Home</div>"})',
      's2=I(document, {type: "embed", name: "Profile", htmlContent: "<div>Profile</div>"})',
    ].join("\n");
    const screens = extractEmbedScreens(operations);
    expect(screens).toEqual([
      { name: "Home", htmlContent: "<div>Home</div>" },
      { name: "Profile", htmlContent: "<div>Profile</div>" },
    ]);
  });

  it("ignores non-I/non-embed operations", () => {
    const operations = [
      'U("abc", {content: "Hello"})',
      'D("xyz")',
      's1=I(document, {type: "frame", name: "Native"})',
      's2=I(document, {type: "embed", name: "Only Screen", htmlContent: "<div>Only</div>"})',
    ].join("\n");
    const screens = extractEmbedScreens(operations);
    expect(screens).toEqual([{ name: "Only Screen", htmlContent: "<div>Only</div>" }]);
  });

  it("supports single-quoted string values", () => {
    const operations =
      "s1=I(document, {type: 'embed', name: 'Single', htmlContent: '<div>Single</div>'})";
    const screens = extractEmbedScreens(operations);
    expect(screens).toEqual([{ name: "Single", htmlContent: "<div>Single</div>" }]);
  });

  it("skips an embed create op with no htmlContent", () => {
    const operations = 's1=I(document, {type: "embed", name: "Empty"})';
    expect(extractEmbedScreens(operations)).toEqual([]);
  });

  it("falls back to 'Untitled' when name is missing", () => {
    const operations = 's1=I(document, {type: "embed", htmlContent: "<div>Hi</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toEqual([{ name: "Untitled", htmlContent: "<div>Hi</div>" }]);
  });

  it("returns an empty array for a script with no embed screens", () => {
    const operations = 'D("abc")\nU("xyz", {fill: "#000"})';
    expect(extractEmbedScreens(operations)).toEqual([]);
  });

  it("decodes \\n as a real newline, not the letter n", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Newline", htmlContent: "<div>Line1\\nLine2</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].htmlContent).toBe("<div>Line1\nLine2</div>");
  });

  // The model routinely writes multi-line HTML with real line breaks rather
  // than "\n" escapes. JSON5 rejects those outright, so without the
  // raw-newline pre-escape the whole screen would be dropped — losing a
  // screen entirely, not merely mangling it.
  it("keeps a screen whose HTML contains literal, unescaped newlines", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Multiline", htmlContent: "<div>\n  <p>Hi</p>\n</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].htmlContent).toBe("<div>\n  <p>Hi</p>\n</div>");
  });

  it("decodes \\t and \\r", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Whitespace", htmlContent: "<div>A\\tB\\rC</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].htmlContent).toBe("<div>A\tB\rC</div>");
  });

  it("decodes a \\uXXXX unicode escape", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Unicode", htmlContent: "<div>en\\u2013dash</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].htmlContent).toBe("<div>en\u2013dash</div>");
  });

  it("decodes \\\\ as a single backslash", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Backslash", htmlContent: "<div>C:\\\\\\\\path</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].htmlContent).toBe("<div>C:\\\\path</div>");
  });

  it("decodes an escaped single quote inside a single-quoted value", () => {
    const operations =
      "s1=I(document, {type: 'embed', name: 'Apostrophe', htmlContent: '<div>It\\'s here</div>'})";
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].htmlContent).toBe("<div>It's here</div>");
  });

  it("decodes escapes in the name field too", () => {
    const operations =
      's1=I(document, {type: "embed", name: "Line1\\nLine2", htmlContent: "<div>Hi</div>"})';
    const screens = extractEmbedScreens(operations);
    expect(screens).toHaveLength(1);
    expect(screens[0].name).toBe("Line1\nLine2");
  });
});
