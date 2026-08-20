#!/usr/bin/env node
// Reads flaky-tests.json (written by scripts/flakyReporter.ts, one entry per
// test that only passed after a Vitest retry) and appends a markdown table
// to $GITHUB_STEP_SUMMARY. Quiet no-op when there is nothing flaky to report
// or the file was never written — this is meant to run with `if: always()`
// right after the test step, whether or not anything was flaky.
import { readFile, appendFile } from "node:fs/promises";

const INPUT_PATH = process.env.FLAKY_REPORT_PATH ?? "flaky-tests.json";

async function main() {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  let raw;
  try {
    raw = await readFile(INPUT_PATH, "utf8");
  } catch {
    // No file: nothing retried this run. Nothing to report.
    return;
  }

  let records;
  try {
    records = JSON.parse(raw);
  } catch {
    console.error(`flaky-summary: ${INPUT_PATH} was not valid JSON, skipping`);
    return;
  }

  if (!Array.isArray(records) || records.length === 0) return;

  const rows = records
    .map((r) => {
      const name = String(r.name ?? "unknown").replace(/\|/g, "\\|");
      const file = String(r.file ?? "unknown").replace(/\|/g, "\\|");
      const retryCount = String(r.retryCount ?? "?");
      const error = String(r.errorMessage ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      return `| ${file} | ${name} | ${retryCount} | ${error} |`;
    })
    .join("\n");

  const table = [
    "## Flaky tests",
    "",
    `${records.length} test(s) passed only after a retry this run:`,
    "",
    "| File | Test | Retries | First failure |",
    "| --- | --- | --- | --- |",
    rows,
    "",
  ].join("\n");

  if (!summaryPath) {
    // Not running in GitHub Actions (or the var isn't set) — print instead
    // of silently doing nothing, so a local `npm run flaky:summary` is
    // still useful.
    console.log(table);
    return;
  }

  await appendFile(summaryPath, `${table}\n`);
}

// The CI step runs this with `if: always()` specifically so a failed test
// step still gets a summary — a cosmetic script throwing here (a malformed
// entry, an appendFile failure, GITHUB_STEP_SUMMARY pointing somewhere
// unwritable) must never turn an otherwise-green run red, and must never
// mask a red run's real failure behind this step's own exit code instead.
// Report the error and exit 0 either way.
try {
  await main();
} catch (err) {
  console.error("flaky-summary: unexpected error, ignoring:", err);
}
