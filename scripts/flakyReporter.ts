// Vitest reporter that records which tests only passed after a retry.
//
// The built-in `json` reporter does not expose retry information at all —
// verified empirically (2026-08-20): a test that fails once and then passes
// under `--retry` shows up in the json report as a plain `"status": "passed"`
// assertion result, with no field naming the retry. `TestCase.diagnostic()`
// (available to a custom reporter via `onTestCaseResult`) is the mechanism
// that actually carries it: `{ retryCount, flaky }`, where `flaky` is true
// exactly when a test needed more than one attempt to reach its final state.
//
// This reporter collects every flaky test case into a small JSON file that
// `scripts/flaky-summary.mjs` turns into a markdown table for
// `$GITHUB_STEP_SUMMARY`. It intentionally does nothing when nothing was
// flaky — an empty run should produce no artifact, not an empty one, so the
// summary step can distinguish "didn't run" from "ran clean". Because of
// that, a leftover file from a *previous* run on a reused workspace (a
// self-hosted runner, or a developer's own checkout) would otherwise survive
// a clean run and get misread as this run's result — onTestRunStart removes
// any stale file up front so a clean run really does leave none behind.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import type { Reporter, TestCase } from "vitest/node";

export interface FlakyTestRecord {
  name: string;
  file: string;
  retryCount: number;
  errorMessage: string | undefined;
}

const DEFAULT_OUTPUT_PATH = "flaky-tests.json";

export default class FlakyReporter implements Reporter {
  private readonly outputPath: string;
  private readonly flaky: FlakyTestRecord[] = [];

  constructor(options: { outputFile?: string } = {}) {
    this.outputPath = options.outputFile ?? DEFAULT_OUTPUT_PATH;
  }

  onTestRunStart(): void {
    if (existsSync(this.outputPath)) {
      rmSync(this.outputPath);
    }
  }

  onTestCaseResult(testCase: TestCase): void {
    const diagnostic = testCase.diagnostic();
    if (!diagnostic?.flaky) return;

    const result = testCase.result();
    const firstError = result.errors?.[0];
    this.flaky.push({
      name: testCase.fullName,
      file: testCase.module.relativeModuleId,
      retryCount: diagnostic.retryCount,
      errorMessage: firstError?.message,
    });
  }

  onTestRunEnd(): void {
    if (this.flaky.length === 0) return;
    writeFileSync(this.outputPath, JSON.stringify(this.flaky, null, 2));
  }
}
