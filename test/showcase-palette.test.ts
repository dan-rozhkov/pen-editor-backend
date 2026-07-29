import { describe, expect, it, vi } from "vitest";
import {
  extractAccentHex,
  hueFamily,
  recentAccentFamilies,
} from "../src/showcase/palette.js";

// The gallery's palette rotation reads the accent back out of already-published
// HTML rather than storing it at publish time, so these tests use the real
// shapes the agent emits: a `:root` custom-property block plus hex literals
// scattered through the stylesheet.
function screenHtml(vars: Record<string, string>, repeats = 1): string {
  const decls = Object.entries(vars)
    .map(([k, v]) => `--${k}:${v}`)
    .join(";");
  const body = Object.values(vars)
    .map((v) => `.x{color:${v}}`)
    .join("")
    .repeat(repeats);
  return `<html><head><style>:root{${decls}}${body}</style></head><body></body></html>`;
}

describe("hueFamily", () => {
  it("names the warm band the skill's Calibration axis covers", () => {
    // The accents from the runs that triggered this work: terracotta, rust,
    // amber. All three must land in ONE family, otherwise "avoid what the last
    // runs used" lets the next run walk two degrees over and repeat the look.
    expect(hueFamily("#c4704c")).toBe("terracotta/amber");
    expect(hueFamily("#c97d60")).toBe("terracotta/amber");
    expect(hueFamily("#d4944e")).toBe("terracotta/amber");
    expect(hueFamily("#d4a853")).toBe("terracotta/amber");
  });

  it("names the other hue families", () => {
    expect(hueFamily("#e11d48")).toBe("red/crimson");
    expect(hueFamily("#c7f64b")).toBe("lime/yellow");
    expect(hueFamily("#10b981")).toBe("green/emerald");
    expect(hueFamily("#0d9488")).toBe("teal/cyan");
    expect(hueFamily("#3b82f6")).toBe("blue");
    expect(hueFamily("#8b5cf6")).toBe("violet/purple");
    expect(hueFamily("#ec4899")).toBe("pink/magenta");
  });

  it("returns null for neutrals — a gray is not an accent", () => {
    expect(hueFamily("#18181b")).toBeNull();
    expect(hueFamily("#ffffff")).toBeNull();
    expect(hueFamily("#faf9f6")).toBeNull();
  });
});

describe("extractAccentHex", () => {
  it("picks the most-used saturated color, ignoring neutrals", () => {
    const html = screenHtml({
      bg: "#0d0a08",
      surface: "#1a1410",
      text: "#f2ece4",
      accent: "#d4944e",
    });
    expect(extractAccentHex(html)).toBe("#d4944e");
  });

  it("prefers frequency among saturated colors", () => {
    // A design with one dominant accent plus an incidental danger red: the
    // rotation must learn the dominant one.
    const html =
      screenHtml({ accent: "#10b981" }, 3) + screenHtml({ danger: "#dc2626" }, 1);
    expect(extractAccentHex(html)).toBe("#10b981");
  });

  it("expands 3-digit hex", () => {
    expect(extractAccentHex("<style>.a{color:#f80}</style>")).toBe("#ff8800");
  });

  it("returns null when nothing saturated is present", () => {
    expect(extractAccentHex(screenHtml({ bg: "#ffffff", text: "#18181b" }))).toBeNull();
  });
});

describe("recentAccentFamilies", () => {
  it("maps recent screens to distinct families, freshest first", async () => {
    const fetchHtml = vi.fn(async (url: string) =>
      ({
        "a.html": screenHtml({ accent: "#d4944e" }),
        "b.html": screenHtml({ accent: "#10b981" }),
        "c.html": screenHtml({ accent: "#c4704c" }), // same family as a.html
      })[url] ?? "",
    );
    await expect(
      recentAccentFamilies(["a.html", "b.html", "c.html"], fetchHtml),
    ).resolves.toEqual(["terracotta/amber", "green/emerald"]);
  });

  it("skips screens that fail to fetch or have no accent", async () => {
    const fetchHtml = vi.fn(async (url: string) => {
      if (url === "gone.html") throw new Error("404");
      if (url === "gray.html") return screenHtml({ bg: "#ffffff" });
      return screenHtml({ accent: "#3b82f6" });
    });
    await expect(
      recentAccentFamilies(["gone.html", "gray.html", "ok.html"], fetchHtml),
    ).resolves.toEqual(["blue"]);
  });

  it("never rejects — palette rotation is an optimization, not a gate", async () => {
    const fetchHtml = vi.fn(async () => {
      throw new Error("S3 down");
    });
    await expect(recentAccentFamilies(["a.html"], fetchHtml)).resolves.toEqual([]);
  });
});
