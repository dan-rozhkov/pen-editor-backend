import { vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Defense-in-depth so no test run can ever touch a developer's real
// ~/.pen-editor/mcp.json, even if a future test forgets to opt out of
// publishing (see BuildAppOptions.publishHandshake in src/app.ts, which is
// the primary layer: publishing defaults to false and only src/index.ts
// opts in). This mocks node:os's homedir() the same way
// test/mcp-auto-token.test.ts already does locally, applied globally so
// every test file gets it "for free" — src/mcp/autoToken.ts is the only
// module in this codebase that calls homedir().
//
// Deliberately node:os's `homedir()`, not process.env.HOME: some
// dependencies (Playwright's browser cache path, in particular —
// test/showcase-screenshot.test.ts) resolve their own real home directory
// via process.env.HOME directly, outside vitest's module graph, and
// redirecting that env var broke Chromium discovery there. vi.mock only
// intercepts modules resolved through vitest's own transform, so it leaves
// those untouched.
//
// Tests that need a *fresh, isolated* home per test case
// (test/mcp-auto-token.test.ts) still declare their own vi.mock("node:os", ...)
// locally, which takes precedence over this one for that file; this is a
// backstop underneath that, not a replacement for it.
const fallbackTestHome = mkdtempSync(join(tmpdir(), "pen-editor-test-home-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => fallbackTestHome };
});
