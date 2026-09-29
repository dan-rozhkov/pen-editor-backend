#!/usr/bin/env node
// Regenerates src/browser/vendor/* from ../pen-editor-desktop (spec:
// docs/specs/2026-09-29-cloud-browser-steel-design.md §3.1). The controller is
// NEVER forked: the only edits allowed are the mechanical rewrites below —
//   1. relative imports get a `.js` extension (NodeNext),
//   2. navigation.ts is reduced to decideBrowserNavigation (its `electron`
//      type import goes away with everything else that used it),
//   3. BrowserTabInfo (declared in desktop's tabManager.ts) is inlined as a type,
//   4. a header comment names the source commit.
// test/browserVendorSync.test.ts asserts the checked-in copies equal this
// script's output, so a committed desktop change fails there until `npm run browser:sync`.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HEADER_END = "// ---- end of vendor header ----";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DESKTOP = path.resolve(here, "../../pen-editor-desktop");
const OUT_DIR = path.resolve(here, "../src/browser/vendor");

// vendored file name -> source path under <desktop>/src/main
const SOURCES = {
  "controller.ts": "browser/controller.ts",
  "pageScripts.ts": "browser/pageScripts.ts",
  "keys.ts": "browser/keys.ts",
  "navigation.ts": "navigation.ts",
};

const TAB_INFO_TYPE = `interface BrowserTabInfo {
  tabId: number;
  url: string;
  title: string;
  current: boolean;
}`;

function replaceOnce(src, from, to, label) {
  if (!src.includes(from)) throw new Error(`sync-browser-vendor: expected ${label} not found — desktop source changed shape`);
  return src.replace(from, to);
}

function reduceNavigation(src) {
  const start = src.indexOf("/**\n * Pure policy for browser tabs");
  const fnStart = src.indexOf("export function decideBrowserNavigation");
  if (start < 0 || fnStart < 0) throw new Error("sync-browser-vendor: decideBrowserNavigation not found in navigation.ts");
  const end = src.indexOf("\n}\n", fnStart);
  if (end < 0) throw new Error("sync-browser-vendor: decideBrowserNavigation has no end");
  return src.slice(start, end + 3);
}

function rewrite(name, src) {
  switch (name) {
    case "navigation.ts":
      return reduceNavigation(src);
    case "controller.ts": {
      let out = src;
      out = replaceOnce(out, 'from "../navigation";', 'from "./navigation.js";', "navigation import");
      out = replaceOnce(out, 'from "./keys";', 'from "./keys.js";', "keys import");
      out = replaceOnce(out, 'from "./pageScripts";', 'from "./pageScripts.js";', "pageScripts import");
      out = replaceOnce(out, 'import type { BrowserTabInfo } from "../tabManager";', TAB_INFO_TYPE, "tabManager import");
      return out;
    }
    default:
      return src;
  }
}

function sourceCommit(desktopRoot) {
  try {
    const opts = { cwd: desktopRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], opts).trim();
  } catch {
    return "unknown";
  }
}

// Reads the COMMITTED file (git HEAD), never the working tree: uncommitted
// desktop edits (another session mid-change) must not leak into the backend.
// Falls back to the file on disk only when the checkout is not a git repo.
function readCommitted(desktopRoot, rel) {
  try {
    const opts = { cwd: desktopRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 };
    return execFileSync("git", ["show", `HEAD:${rel}`], opts);
  } catch {
    return readFileSync(path.join(desktopRoot, rel), "utf8");
  }
}

/** @returns {Record<string, string>} vendored file name -> full content (header included) */
export function buildVendorFiles(desktopRoot = DEFAULT_DESKTOP) {
  const commit = sourceCommit(desktopRoot);
  const files = {};
  for (const [name, rel] of Object.entries(SOURCES)) {
    const src = readCommitted(desktopRoot, `src/main/${rel}`);
    const header = [
      `// VENDORED from pen-editor-desktop/src/main/${rel} @ ${commit}.`,
      "// Do not edit: regenerate with `npm run browser:sync` (scripts/sync-browser-vendor.mjs).",
      HEADER_END,
      "",
    ].join("\n");
    files[name] = header + rewrite(name, src);
  }
  return files;
}

/** Content with the header (which names a commit and so drifts) removed. */
export function stripHeader(content) {
  const i = content.indexOf(HEADER_END);
  return i < 0 ? content : content.slice(i + HEADER_END.length + 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const desktop = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DESKTOP;
  const files = buildVendorFiles(desktop);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(OUT_DIR, name), content);
  console.log(`vendored ${Object.keys(files).join(", ")} from ${desktop}`);
}
