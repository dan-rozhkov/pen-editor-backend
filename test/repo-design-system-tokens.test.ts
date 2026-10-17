import { describe, expect, it } from "vitest";
import {
  extractCssCustomPropertyTokens,
  extractRawCssCustomProperties,
  extractTailwindConfigTokens,
  resolveTailwindTokenReferences,
} from "../src/services/repoDesignSystem.js";

describe("extractTailwindConfigTokens", () => {
  it("extracts flat leaf values from theme.extend", () => {
    const config = `
      module.exports = {
        theme: {
          extend: {
            colors: {
              brand: "#3b82f6",
              muted: "#6b7280",
            },
            borderRadius: {
              lg: "0.5rem",
              full: "9999px",
            },
          },
        },
      };
    `;
    const tokens = extractTailwindConfigTokens(config);
    expect(tokens.colors).toEqual({ brand: "#3b82f6", muted: "#6b7280" });
    expect(tokens.borderRadius).toEqual({ lg: "0.5rem", full: "9999px" });
  });

  it("flattens a nested color group into dotted keys", () => {
    const config = `
      export default {
        theme: {
          extend: {
            colors: {
              brand: {
                500: "#3b82f6",
                600: "#2563eb",
              },
            },
          },
        },
      };
    `;
    const tokens = extractTailwindConfigTokens(config);
    expect(tokens.colors).toEqual({
      "brand.500": "#3b82f6",
      "brand.600": "#2563eb",
    });
  });

  it("merges top-level theme values with theme.extend values", () => {
    const config = `
      module.exports = {
        theme: {
          fontFamily: {
            sans: "Inter, sans-serif",
          },
          extend: {
            fontFamily: {
              mono: "JetBrains Mono, monospace",
            },
          },
        },
      };
    `;
    const tokens = extractTailwindConfigTokens(config);
    expect(tokens.fontFamily).toEqual({
      sans: "Inter, sans-serif",
      mono: "JetBrains Mono, monospace",
    });
  });

  it("skips unresolvable values (function calls, template interpolation) without throwing", () => {
    const config = `
      module.exports = {
        theme: {
          extend: {
            colors: {
              brand: "#3b82f6",
              computed: withOpacity("--brand"),
              templated: \`rgb(\${vars.brand})\`,
            },
          },
        },
      };
    `;
    expect(() => extractTailwindConfigTokens(config)).not.toThrow();
    const tokens = extractTailwindConfigTokens(config);
    expect(tokens.colors).toEqual({ brand: "#3b82f6" });
  });

  it("returns empty tokens when there is no theme block", () => {
    const tokens = extractTailwindConfigTokens("module.exports = { plugins: [] };");
    expect(tokens.colors).toEqual({});
    expect(tokens.spacing).toEqual({});
  });

  it("ignores comments around theme values", () => {
    const config = `
      module.exports = {
        theme: {
          extend: {
            // brand palette
            colors: {
              brand: "#3b82f6", /* primary */
            },
          },
        },
      };
    `;
    const tokens = extractTailwindConfigTokens(config);
    expect(tokens.colors).toEqual({ brand: "#3b82f6" });
  });
});

describe("extractCssCustomPropertyTokens", () => {
  it("extracts :root custom properties, defaulting unprefixed names to colors", () => {
    const css = `
      :root {
        --background: #ffffff;
        --primary: #111827;
        --radius: 0.5rem;
      }
    `;
    const tokens = extractCssCustomPropertyTokens(css);
    expect(tokens.colors).toEqual({ background: "#ffffff", primary: "#111827" });
    expect(tokens.borderRadius).toEqual({ radius: "0.5rem" });
  });

  it("extracts a Tailwind v4 @theme block, categorizing by namespaced prefix", () => {
    const css = `
      @theme {
        --color-brand-500: #3b82f6;
        --font-sans: Inter, sans-serif;
        --spacing-4: 1rem;
        --radius-lg: 0.75rem;
        --shadow-md: 0 4px 6px rgba(0,0,0,0.1);
      }
    `;
    const tokens = extractCssCustomPropertyTokens(css);
    expect(tokens.colors).toEqual({ "brand.500": "#3b82f6" });
    expect(tokens.fontFamily).toEqual({ sans: "Inter, sans-serif" });
    expect(tokens.spacing).toEqual({ 4: "1rem" });
    expect(tokens.borderRadius).toEqual({ lg: "0.75rem" });
    expect(tokens.boxShadow).toEqual({ md: "0 4px 6px rgba(0,0,0,0.1)" });
  });

  it("merges :root and @theme blocks from the same stylesheet", () => {
    const css = `
      :root {
        --background: #ffffff;
      }
      @theme {
        --color-brand-500: #3b82f6;
      }
    `;
    const tokens = extractCssCustomPropertyTokens(css);
    expect(tokens.colors).toEqual({ background: "#ffffff", "brand.500": "#3b82f6" });
  });

  // Tailwind's fontFamily is array-shaped by convention, and a real config
  // mixes literals with spreads of the framework defaults
  // (shadcn-ui/taxonomy: `sans: ["var(--font-sans)", ...fontFamily.sans]`).
  // Dropping the whole entry left a brief with no font stack at all.
  it("joins array values and drops the elements it cannot resolve", () => {
    const source = `module.exports = { theme: { extend: {
      fontFamily: {
        sans: ["var(--font-sans)", ...fontFamily.sans],
        heading: ["Satoshi", "sans-serif"],
      },
      boxShadow: { card: ["0 1px 2px rgba(0,0,0,.06)", "0 8px 24px rgba(0,0,0,.08)"] },
    } } }`;
    const tokens = extractTailwindConfigTokens(source);
    expect(tokens.fontFamily).toEqual({
      sans: "var(--font-sans)",
      heading: "Satoshi, sans-serif",
    });
    expect(tokens.boxShadow.card).toBe(
      "0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.08)"
    );
  });

  it("skips an array with no resolvable element rather than inventing one", () => {
    const source = `module.exports = { theme: { fontFamily: { sans: [...fontFamily.sans] } } }`;
    expect(extractTailwindConfigTokens(source).fontFamily).toEqual({});
  });

  it("returns empty tokens for CSS with no :root or @theme block", () => {
    const tokens = extractCssCustomPropertyTokens(".button { color: red; }");
    expect(tokens.colors).toEqual({});
  });

  // Regression: the terminator regex required a trailing ";", so the LAST
  // declaration of every block (no trailing semicolon before "}") was
  // silently dropped.
  it("does not drop the last declaration when it has no trailing semicolon", () => {
    const tokens = extractCssCustomPropertyTokens(":root { --a: red; --b: #fff }");
    expect(tokens.colors).toEqual({ a: "red", b: "#fff" });
  });

  it("does not drop a single declaration with no trailing semicolon at all", () => {
    const tokens = extractCssCustomPropertyTokens(":root { --only: #123456 }");
    expect(tokens.colors).toEqual({ only: "#123456" });
  });

  // Regression: a commented-out ":root {" made extractCssBlocksBySelector
  // latch onto the comment's own brace, swallowing the real block that
  // followed and reporting zero tokens found.
  it("ignores a commented-out :root block and still finds the real one", () => {
    const tokens = extractCssCustomPropertyTokens("/* :root { */ :root { --a: red; }");
    expect(tokens.colors).toEqual({ a: "red" });
  });

  it("does not treat // inside a url() as a comment starter", () => {
    // CSS has no line comments — stripCssComments must not borrow
    // stripJsComments' "//" handling, or a url("http://...") value gets
    // truncated.
    const tokens = extractCssCustomPropertyTokens(
      ':root { --bg-image: url("http://example.com/a.png"); --a: red; }',
    );
    expect(tokens.colors.a).toBe("red");
    expect(tokens.colors["bg.image"]).toContain("http://example.com/a.png");
  });

  // Regression: --font-size-lg used to land in fontFamily because the
  // "font-" prefix matched before any size-specific check.
  it("buckets --font-size-* under spacing, not fontFamily", () => {
    const tokens = extractCssCustomPropertyTokens(":root { --font-size-lg: 1.125rem; }");
    expect(tokens.fontFamily).toEqual({});
    expect(tokens.spacing).toEqual({ lg: "1.125rem" });
  });

  it("still buckets a real font stack under fontFamily", () => {
    const tokens = extractCssCustomPropertyTokens(':root { --font-sans: Inter, sans-serif; }');
    expect(tokens.fontFamily).toEqual({ sans: "Inter, sans-serif" });
  });

  // The shadcn/ui shape: --background: 0 0% 100% is a bare HSL channel
  // triplet, not a usable CSS color, until it's wrapped in hsl(...).
  it("wraps a bare HSL channel triplet into a real hsl() color", () => {
    const tokens = extractCssCustomPropertyTokens(":root { --background: 0 0% 100%; }");
    expect(tokens.colors.background).toBe("hsl(0 0% 100%)");
  });

  it("wraps a bare RGB channel triplet into a real rgb() color", () => {
    const tokens = extractCssCustomPropertyTokens(":root { --border: 228 228 231; }");
    expect(tokens.colors.border).toBe("rgb(228 228 231)");
  });

  it("does not double-wrap a value that is already a color function", () => {
    const tokens = extractCssCustomPropertyTokens(":root { --primary: hsl(217 91% 60%); }");
    expect(tokens.colors.primary).toBe("hsl(217 91% 60%)");
  });

  it("leaves a hex color untouched", () => {
    const tokens = extractCssCustomPropertyTokens(":root { --primary: #3b82f6; }");
    expect(tokens.colors.primary).toBe("#3b82f6");
  });

  // Resolving var() references within the same stylesheet: a common shadcn
  // shape splits a raw triplet from the property that references it.
  it("resolves an intra-file var() reference and wraps the resolved triplet", () => {
    const css = ":root { --primary-raw: 217 91% 60%; --primary: var(--primary-raw); }";
    const tokens = extractCssCustomPropertyTokens(css);
    expect(tokens.colors.primary).toBe("hsl(217 91% 60%)");
  });

  it("resolves hsl(var(--x)) by substituting only the inner reference", () => {
    const css = ":root { --primary-raw: 217 91% 60%; --primary: hsl(var(--primary-raw)); }";
    const tokens = extractCssCustomPropertyTokens(css);
    expect(tokens.colors.primary).toBe("hsl(217 91% 60%)");
  });

  it("uses a var() fallback when the referenced property is missing", () => {
    const css = ":root { --primary: var(--missing, 217 91% 60%); }";
    const tokens = extractCssCustomPropertyTokens(css);
    expect(tokens.colors.primary).toBe("hsl(217 91% 60%)");
  });

  // Regression: an unresolvable var() reference used to be silently kept as
  // opaque, unusable CSS with no signal that anything was wrong.
  it("keeps an unresolved var() reference raw and reports it in notes", () => {
    const css = ":root { --primary: var(--missing-token); }";
    const tokens = extractCssCustomPropertyTokens(css);
    expect(tokens.colors.primary).toBe("var(--missing-token)");
    expect(tokens.notes.some((n) => n.includes("--missing-token"))).toBe(true);
  });
});

describe("extractRawCssCustomProperties", () => {
  it("returns raw, unwrapped values keyed by bare property name", () => {
    const css = ":root { --background: 0 0% 100%; --radius: 0.5rem; }";
    expect(extractRawCssCustomProperties(css)).toEqual({
      background: "0 0% 100%",
      radius: "0.5rem",
    });
  });
});

describe("resolveTailwindTokenReferences", () => {
  // The shadcn/ui shape this whole fix targets: a Tailwind config that
  // never has real color values, only var() indirections into the repo's
  // global stylesheet.
  it("resolves a Tailwind color that references a CSS custom property", () => {
    const tailwindTokens = extractTailwindConfigTokens(
      `module.exports = { theme: { extend: { colors: { primary: "hsl(var(--primary))" } } } }`,
    );
    const rawCssVars = extractRawCssCustomProperties(":root { --primary: 217 91% 60%; }");
    const { tokens, notes } = resolveTailwindTokenReferences(tailwindTokens, rawCssVars);
    expect(tokens.colors.primary).toBe("hsl(217 91% 60%)");
    expect(notes).toEqual([]);
  });

  it("reports an unresolved cross-file reference in notes instead of guessing", () => {
    const tailwindTokens = extractTailwindConfigTokens(
      `module.exports = { theme: { extend: { colors: { primary: "hsl(var(--primary))" } } } }`,
    );
    const { tokens, notes } = resolveTailwindTokenReferences(tailwindTokens, {});
    expect(tokens.colors.primary).toBe("hsl(var(--primary))");
    expect(notes.some((n) => n.includes("--primary"))).toBe(true);
  });
});
