import { describe, expect, it } from "vitest";
import { canvasWidgetCsp, canvasWidgetHtml, resolveCanvasWidgetSettings } from "../src/mcp/canvasWidget.js";
import { maskTokenInUrl } from "../src/app.js";
import { makeConfig } from "./helpers.js";

describe("canvas widget CSP and HTML", () => {
  it("derives hosts from the config, API origin in both lists", () => {
    const settings = resolveCanvasWidgetSettings(
      makeConfig({
        S3_PUBLIC_BASE_URL: "https://cdn.example.com/bucket",
        S3_LEGACY_PUBLIC_BASE_URLS: "https://old.example.com/x, https://older.example.com",
        MCP_APP_RESOURCE_DOMAINS: "https://img.example.net",
      }),
      "https://app.example.com/",
      "https://api.example.com/",
    );
    const csp = canvasWidgetCsp(settings);
    expect(csp.resourceDomains).toEqual([
      "https://app.example.com",
      "https://api.example.com",
      "https://fonts.googleapis.com",
      "https://fonts.gstatic.com",
      "https://unpkg.com",
      "https://picsum.photos",
      "https://fastly.picsum.photos",
      "https://cdn.example.com",
      "https://old.example.com",
      "https://older.example.com",
      "https://img.example.net",
    ]);
    expect(csp.connectDomains).toEqual(["https://api.example.com", "wss://api.example.com", "https://img.example.net"]);
  });

  it("normalizes origins and escapes the loader URL", () => {
    const settings = resolveCanvasWidgetSettings(makeConfig(), 'https://app.example.com/"><script>x</script>', "https://api.example.com/path");
    expect(settings.appOrigin).toBe("https://app.example.com");
    expect(settings.apiOrigin).toBe("https://api.example.com");
    const html = canvasWidgetHtml('https://a.test"><script>alert(1)</script>');
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("maskTokenInUrl", () => {
  it("redacts ticket= like token=", () => {
    expect(maskTokenInUrl("/api/mcp/ws?ticket=abc123&x=1")).toBe("/api/mcp/ws?ticket=[redacted]&x=1");
    expect(maskTokenInUrl("/api/mcp/ws?token=abc")).toBe("/api/mcp/ws?token=[redacted]");
  });
});
