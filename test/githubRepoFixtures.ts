// An in-memory "acme/webapp" GitHub repo (Next + Tailwind, a brand color and a
// :root token) for tests that mock src/services/github.js's IO functions.
//
// This module imports github.js for TYPES only, so it is safe to load from
// inside that module's own vi.mock factory. Each test file keeps its literal
// vi.mock path and delegates:
//
//   const github = githubFixtureMocks();
//   vi.mock("../src/services/github.js", async (importOriginal) =>
//     (await import("./githubRepoFixtures.js")).githubModuleWithMocks(
//       await importOriginal(), () => github));
import { vi } from "vitest";
import type * as GithubModule from "../src/services/github.js";
import type { RepoMeta, RepoTree } from "../src/services/github.js";

export const FIXTURE_META: RepoMeta = {
  defaultBranch: "main",
  htmlUrl: "https://github.com/acme/webapp",
};

export const FIXTURE_TREE: RepoTree = {
  truncated: false,
  entries: [
    { path: "package.json", type: "blob" },
    { path: "tailwind.config.ts", type: "blob" },
    { path: "app/globals.css", type: "blob" },
    { path: "src/components/ui/button.tsx", type: "blob" },
    { path: "src/components/Header.tsx", type: "blob" },
  ],
};

export const FIXTURE_FILES: Record<string, string> = {
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

// Spies serving the fixtures. `getRepoMeta` answers any repo with
// FIXTURE_META unless the caller supplies its own lookup.
export function githubFixtureMocks(
  getRepoMeta: (owner: string, name: string) => Promise<RepoMeta> = async () => FIXTURE_META,
) {
  return {
    getRepoMeta: vi.fn(getRepoMeta),
    getRepoTree: vi.fn(async (): Promise<RepoTree> => FIXTURE_TREE),
    getFile: vi.fn(
      async (_owner: string, _name: string, _ref: string, path: string): Promise<string | null> =>
        FIXTURE_FILES[path] ?? null,
    ),
  };
}

export type GithubFixtureMocks = ReturnType<typeof githubFixtureMocks>;

// The real module with its three IO functions routed to the mocks. `mocks` is
// read lazily, at call time: the hoisted vi.mock factory runs before the test
// file's own `const github = githubFixtureMocks()` line has executed.
export function githubModuleWithMocks(
  actual: typeof GithubModule,
  mocks: () => GithubFixtureMocks,
): typeof GithubModule {
  return {
    ...actual,
    getRepoMeta: ((...args: unknown[]) =>
      mocks().getRepoMeta(...(args as [string, string]))) as typeof actual.getRepoMeta,
    // Arguments are forwarded even though the fake ignores them, so a test can
    // assert on what the route asked for.
    getRepoTree: ((...args: unknown[]) =>
      mocks().getRepoTree(...(args as []))) as typeof actual.getRepoTree,
    getFile: ((...args: unknown[]) =>
      mocks().getFile(...(args as [string, string, string, string]))) as typeof actual.getFile,
  };
}
