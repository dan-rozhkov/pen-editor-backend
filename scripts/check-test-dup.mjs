#!/usr/bin/env node
// Ratchet gate for duplication in tests. The prod gate (`check:dup`, 0.1%) is too strict
// for tests, where repeated arrange blocks are partly legitimate — so instead of a fixed
// threshold, duplicated lines may never grow past the committed baseline.
//
//   node scripts/check-test-dup.mjs            # fail if any suite grew
//   node scripts/check-test-dup.mjs --update   # lower the baseline after a cleanup
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG = "test-dup.config.json";
const BASELINE = "test-dup-baseline.json";
const update = process.argv.includes("--update");

const { suites, minTokens = 70 } = JSON.parse(readFileSync(CONFIG, "utf8"));
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};

function measure(suite) {
  const out = mkdtempSync(join(tmpdir(), "test-dup-"));
  // Own config on purpose: jscpd 5.x applies the repo's .jscpd.json `ignore` (which excludes
  // __tests__) even to explicit paths and then silently reports 0 files.
  const config = join(out, "jscpd.json");
  writeFileSync(config, JSON.stringify({ minTokens, ignore: suite.ignore ?? [], ...(suite.pattern && { pattern: suite.pattern }) }));
  const args = ["jscpd", suite.path, "-c", config, "--min-tokens", String(minTokens), "--reporters", "json", "--output", out, "--silent"];
  if (suite.pattern) args.push("--pattern", suite.pattern);
  if (suite.ignore) args.push("--ignore", suite.ignore.join(","));
  execFileSync("npx", args, { stdio: "ignore" });
  const report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
  if (report.statistics.total.sources === 0) throw new Error(`${suite.name}: jscpd scanned 0 files — check path/pattern/ignore`);
  return report;
}

function changedFiles() {
  try {
    const diff = execFileSync("git", ["diff", "--name-only", "origin/main"], { encoding: "utf8" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" });
    return new Set(`${diff}\n${untracked}`.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

const next = {};
let failed = false;
for (const suite of suites) {
  const report = measure(suite);
  const lines = report.statistics.total.duplicatedLines;
  const allowed = baseline[suite.name];
  // --update only ever lowers the baseline; raising it is a hand edit that shows up in review.
  next[suite.name] = allowed === undefined ? lines : Math.min(lines, allowed);
  if (allowed === undefined) {
    console.log(`${suite.name}: ${lines} duplicated lines (no baseline)`);
    continue;
  }
  if (lines > allowed) {
    failed = true;
    console.error(`${suite.name}: ${lines} duplicated lines > baseline ${allowed} (+${lines - allowed})`);
    const changed = changedFiles();
    const rel = (f) => (f.startsWith(suite.path) ? f : join(suite.path, f));
    for (const d of report.duplicates) {
      const a = d.firstFile, b = d.secondFile;
      if (changed.size && !changed.has(rel(a.name)) && !changed.has(rel(b.name))) continue;
      console.error(`  ${d.lines} lines  ${a.name}:${a.start}-${a.end}  <>  ${b.name}:${b.start}-${b.end}`);
    }
    console.error("  Extract the shared mechanics into a helper/fixture or an it.each table; see CLAUDE.md → Testing.");
  } else {
    console.log(`${suite.name}: ${lines} duplicated lines (baseline ${allowed})`);
    if (lines < allowed) console.log(`  ↓ ${allowed - lines} below baseline — run with --update to lock it in`);
  }
}

if (update || suites.some((s) => baseline[s.name] === undefined)) {
  writeFileSync(BASELINE, JSON.stringify(next, null, 2) + "\n");
  console.log(`wrote ${BASELINE}`);
}
process.exit(failed ? 1 : 0);
