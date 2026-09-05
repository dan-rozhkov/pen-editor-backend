import { describe, expect, it } from "vitest";
import { buildComponentInventory, detectFramework } from "../src/services/repoDesignSystem.js";
import type { RepoTreeEntry } from "../src/services/github.js";

function blob(path: string): RepoTreeEntry {
  return { path, type: "blob" };
}

describe("buildComponentInventory", () => {
  // shadcn-ui/ui is the most obvious target this feature has, and it keeps
  // every component in apps/v4/components — a root-anchored pattern returned
  // an inventory of zero for it against the real repo.
  it("finds components one workspace deep in a monorepo", () => {
    const paths = buildComponentInventory([
      blob("apps/v4/components/ui/button.tsx"),
      blob("apps/web/src/components/Nav.tsx"),
      blob("packages/ui/src/components/Card.tsx"),
      blob("libs/shared/components/Badge.tsx"),
      blob("examples/demo/app/components/Hero.tsx"),
      // Two workspaces deep is not a convention — stay out of vendored trees.
      blob("apps/web/vendor/pkg/components/Nope.tsx"),
      blob("node_modules/thing/components/Nope.tsx"),
    ]).map((e) => e.path);

    expect(paths).toContain("apps/v4/components/ui/button.tsx");
    expect(paths).toContain("apps/web/src/components/Nav.tsx");
    expect(paths).toContain("packages/ui/src/components/Card.tsx");
    expect(paths).toContain("libs/shared/components/Badge.tsx");
    expect(paths).toContain("examples/demo/app/components/Hero.tsx");
    expect(paths).not.toContain("apps/web/vendor/pkg/components/Nope.tsx");
    expect(paths).not.toContain("node_modules/thing/components/Nope.tsx");
  });

  // A workspace-nested components/ui is still the design-system primitive set.
  it("still sorts components/ui primitives first inside a workspace", () => {
    const paths = buildComponentInventory([
      blob("apps/v4/components/analytics.tsx"),
      blob("apps/v4/components/ui/button.tsx"),
    ]).map((e) => e.path);
    expect(paths[0]).toBe("apps/v4/components/ui/button.tsx");
  });

  it("finds components under conventional directories", () => {
    const entries = buildComponentInventory([
      blob("src/components/Button.tsx"),
      blob("components/Card.jsx"),
      blob("app/components/Header.tsx"),
      blob("src/ui/Modal.tsx"),
      blob("packages/design/src/components/Avatar.tsx"),
      blob("README.md"),
      blob("src/lib/utils.ts"),
    ]);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(
      [
        "src/components/Button.tsx",
        "components/Card.jsx",
        "app/components/Header.tsx",
        "src/ui/Modal.tsx",
        "packages/design/src/components/Avatar.tsx",
      ].sort(),
    );
  });

  it("orders components/ui primitives before everything else", () => {
    const entries = buildComponentInventory([
      blob("src/components/Dashboard.tsx"),
      blob("components/ui/button.tsx"),
      blob("components/ui/card.tsx"),
      blob("src/components/Sidebar.tsx"),
    ]);
    expect(entries.map((e) => e.path)).toEqual([
      "components/ui/button.tsx",
      "components/ui/card.tsx",
      "src/components/Dashboard.tsx",
      "src/components/Sidebar.tsx",
    ]);
  });

  it("excludes test and story files", () => {
    const entries = buildComponentInventory([
      blob("src/components/Button.tsx"),
      blob("src/components/Button.test.tsx"),
      blob("src/components/Button.spec.tsx"),
      blob("src/components/Button.stories.tsx"),
      blob("src/components/__tests__/Button.tsx"),
      blob("src/components/stories/Button.tsx"),
    ]);
    expect(entries.map((e) => e.path)).toEqual(["src/components/Button.tsx"]);
  });

  it("ignores non-component file types and non-blob entries", () => {
    const entries = buildComponentInventory([
      blob("src/components/Button.tsx"),
      blob("src/components/styles.css"),
      { path: "src/components", type: "tree" },
    ]);
    expect(entries.map((e) => e.path)).toEqual(["src/components/Button.tsx"]);
  });

  it("caps the inventory at 200 entries", () => {
    const many = Array.from({ length: 250 }, (_, i) => blob(`src/components/Comp${i}.tsx`));
    const entries = buildComponentInventory(many);
    expect(entries).toHaveLength(200);
  });

  it("derives a PascalCase name from the file basename", () => {
    const entries = buildComponentInventory([blob("src/components/user-card.tsx")]);
    expect(entries[0]).toEqual({
      name: "UserCard",
      path: "src/components/user-card.tsx",
    });
  });

  // Regression: `exports` used to be fabricated as [toPascalCase(basename)]
  // without reading the file — components/ui/button/index.tsx would have
  // claimed `exports: ["Index"]`, which is never true. The field is gone;
  // pin that no entry carries it.
  it("never fabricates an exports field", () => {
    const entries = buildComponentInventory([blob("components/ui/button/index.tsx")]);
    expect(entries[0]).not.toHaveProperty("exports");
    expect(Object.keys(entries[0]).sort()).toEqual(["name", "path"]);
  });
});

describe("detectFramework", () => {
  // Regression: any Vite/CRA React SPA using react-router (the standard
  // router for a plain React app, not Remix-specific) used to be reported
  // as framework: ["remix"], which also suppressed the "react" entry.
  it("does not treat react-router as a Remix signal", () => {
    const deps = new Set(["react", "react-dom", "react-router", "react-router-dom"]);
    const found = detectFramework(deps);
    expect(found).toContain("react");
    expect(found).not.toContain("remix");
  });

  it("still detects Remix from its own package", () => {
    const deps = new Set(["react", "@remix-run/react", "@remix-run/node"]);
    const found = detectFramework(deps);
    expect(found).toContain("remix");
    expect(found).not.toContain("react");
  });
});
