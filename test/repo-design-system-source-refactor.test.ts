import { describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { FIXTURE_META, FIXTURE_TREE, githubFixtureMocks } from "./githubRepoFixtures.js";

// Regression test for the buildDesignBrief -> buildDesignBriefFromSource
// refactor (pen-editor-backend/CLAUDE.md's split-execution architecture
// aside — this one is purely "did extracting the core change GitHub
// behavior"). getRepoMeta/getRepoTree/getFile serve the same acme/webapp
// fixtures test/repo-route.test.ts uses (test/githubRepoFixtures.ts), so this
// pins the SAME brief shape that existed before the refactor, plus the new
// `source` field.
const github = githubFixtureMocks();

vi.mock("../src/services/github.js", async (importOriginal) =>
  (await import("./githubRepoFixtures.js")).githubModuleWithMocks(await importOriginal(), () => github),
);

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
    github.getRepoTree.mockImplementationOnce(async () => ({ ...FIXTURE_TREE, truncated: true }));
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
    github.getFile.mockImplementationOnce(async () => null); // package.json
    const { buildDesignBrief } = await import("../src/services/repoDesignSystem.js");
    const config = makeConfig();

    const brief = await buildDesignBrief({ owner: "acme", name: "webapp" }, config);

    expect(brief.notes.some((n) => n.includes("package.json") && n.includes("could not be read"))).toBe(
      true,
    );
    expect(brief.notes.some((n) => n.includes("not provided"))).toBe(false);
  });
});
