import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// pen-editor's src/lib/__tests__/modelContract.test.ts imports THIS repo's
// src/config.ts directly out of the sibling checkout, to pin its
// FALLBACK_MODEL against our DEFAULT_MODELS. That only works while config.ts
// stays resolvable from a checkout that installs none of our dependencies —
// so config.ts must not (even transitively) pull in the provider SDKs.
//
// This guard exists because the backend's own CI structurally cannot catch
// the regression: `ai`, `@ai-sdk/deepseek` and `@openrouter/ai-sdk-provider`
// are installed here, so importing them from config.ts is green locally and
// red only in the other repository. It has already happened once, when
// bareModelId lived in src/ai/provider.ts.
const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), "utf8");

const importSources = (source: string): string[] =>
  [...source.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

describe("config.ts import weight", () => {
  it("does not import the provider module or any SDK", () => {
    const sources = importSources(read("config.ts"));
    expect(sources).not.toContain("./ai/provider.js");
    for (const source of sources) {
      expect(source.startsWith("@ai-sdk/"), `config.ts imports ${source}`).toBe(false);
      expect(source.startsWith("@openrouter/"), `config.ts imports ${source}`).toBe(false);
      expect(source === "ai", `config.ts imports ${source}`).toBe(false);
    }
  });

  it("keeps src/ai/modelRef.ts free of runtime imports", () => {
    // A type-only import would be erased at runtime, but any plain import
    // here re-opens the same hole, so the rule is simply: no imports.
    expect(importSources(read("ai/modelRef.ts"))).toEqual([]);
  });
});
