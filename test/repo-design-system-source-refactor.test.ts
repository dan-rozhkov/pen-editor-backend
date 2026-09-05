import { describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import type { RepoMeta, RepoTree } from "../src/services/github.js";

// Regression test for the buildDesignBrief -> buildDesignBriefFromSource
// refactor (pen-editor-backend/CLAUDE.md's split-execution architecture
// aside — this one is purely "did extracting the core change GitHub
// behavior"). getRepoMeta/getRepoTree/getFile are mocked exactly like
// test/repo-route.test.ts's fixtures so this pins the SAME brief shape that
// existed before the refactor, plus the new `source` field.

const FIXTURE_META: RepoMeta = {
  defaultBranch: "main",
  htmlUrl: "https://github.com/acme/webapp",
};

const FIXTURE_TREE: RepoTree = {
  truncated: false,
  entries: [
    { path: "package.json", type: "blob" },
    { path: "tailwind.config.ts", type: "blob" },
    { path: "app/globals.css", type: "blob" },
    { path: "src/components/ui/button.tsx", type: "blob" },
    { path: "src/components/Header.tsx", type: "blob" },
  ],
};

const FIXTURE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    dependencies: { react: "^18.0.0", next: "^14.0.0", tailwindcss: "^3.4.0" },
  }),
  "tailwind.config.ts": `
    export default {
      theme: {
        extend: {
          colors: { brand: "#3b82f6" },
        },
      },
    };
  `,
  "app/globals.css": `
    :root {
      --background: #ffffff;
    }
  `,
};

const getRepoMetaMock = vi.fn(async () => FIXTURE_META);
const getRepoTreeMock = vi.fn(async () => FIXTURE_TREE);
const getFileMock = vi.fn(async (_owner: string, _name: string, _ref: string, path: string) => {
  return FIXTURE_FILES[path] ?? null;
});

vi.mock("../src/services/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/github.js")>();
  return {
    ...actual,
    getRepoMeta: (...args: unknown[]) => getRepoMetaMock(...(args as [string, string])),
    getRepoTree: (...args: unknown[]) => getRepoTreeMock(...(args as [])),
    getFile: (...args: unknown[]) => getFileMock(...(args as [string, string, string, string])),
  };
});

describe("buildDesignBrief (post-refactor wrapper over buildDesignBriefFromSource)", () => {
  it("still produces the same brief shape as before the source-agnostic refactor, now with source: \"github\"", async () => {
    const { buildDesignBrief } = await import("../src/services/repoDesignSystem.js");
    const config = makeConfig();

    const brief = await buildDesignBrief({ owner: "acme", name: "webapp" }, config);

    expect(brief.source).toBe("github");
    expect(brief.repo).toEqual({
      owner: "acme",
      name: "webapp",
      ref: "main",
      htmlUrl: FIXTURE_META.htmlUrl,
    });
    expect(brief.framework).toContain("next");
    expect(brief.styling).toContain("tailwindcss");
    expect(brief.tokens.colors).toMatchObject({ brand: "#3b82f6", background: "#ffffff" });
    expect(brief.components.map((c) => c.path)).toContain("src/components/ui/button.tsx");
    expect(brief.keyFiles).toEqual(
      expect.arrayContaining(["package.json", "app/globals.css", "tailwind.config.ts"]),
    );
    expect(brief.notes).not.toContain(
      "No design tokens found (no Tailwind config theme/extend block and no :root/@theme CSS custom properties) — ask the user for exact values rather than guessing.",
    );
  });

  it("surfaces the GitHub-specific truncated-tree note through initialNotes, unchanged", async () => {
    getRepoTreeMock.mockImplementationOnce(async () => ({ ...FIXTURE_TREE, truncated: true }));
    const { buildDesignBrief } = await import("../src/services/repoDesignSystem.js");
    const config = makeConfig();

    const brief = await buildDesignBrief({ owner: "acme", name: "webapp" }, config);

    expect(brief.notes).toContain(
      "GitHub truncated the file tree for this repo (it is very large) — some files or components may be missing from this brief.",
    );
  });

  // buildDesignBriefFromSource is shared between the GitHub path (getFile
  // returns null for a 404 or a non-file, e.g. a submodule/symlink) and the
  // local-attachment path (a file simply wasn't pushed). The "not provided"
  // wording only made sense for the local case, where the caller withheld
  // it — on GitHub it reads as blaming the caller for something GitHub
  // itself returned null for. Pin the transport-neutral wording here so a
  // regression toward the caller-blaming phrasing is caught on the GitHub
  // side too, not just in repo-brief-local-route.test.ts.
  it("uses transport-neutral wording ('could not be read') for a GitHub file getFile returned null for", async () => {
    getFileMock.mockImplementationOnce(async () => null); // package.json
    const { buildDesignBrief } = await import("../src/services/repoDesignSystem.js");
    const config = makeConfig();

    const brief = await buildDesignBrief({ owner: "acme", name: "webapp" }, config);

    expect(brief.notes.some((n) => n.includes("package.json") && n.includes("could not be read"))).toBe(
      true,
    );
    expect(brief.notes.some((n) => n.includes("not provided"))).toBe(false);
  });
});
