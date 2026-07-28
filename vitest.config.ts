import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Network calls to providers are forbidden in tests; everything is mocked.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts", // entrypoint: reads env and listens
        // analyze worker entrypoint: reads env, connects to Postgres, runs the
        // script. Its pure seams (parseWindowDays, tally, tallyInsights,
        // insightInsertValues, buildInsightsForSession) are unit-tested in
        // test/analysis-run.test.ts; main()'s orchestration is verified by the
        // build and the live `npm run analyze`, per the repo convention that
        // integration loops are not unit-tested.
        "src/analysis/run.ts",
        // showcase generator entrypoint: same shape as analysis/run.ts — reads
        // env, connects to Postgres and S3, drives the run. Its pure seam
        // (readFlag) lives in src/showcase/cliFlags.ts and is unit-tested.
        "src/showcase/run.ts",
        // rescreenshot entrypoint: same shape again. The loop it drives
        // (rescreenshotScreens, in src/showcase/rescreenshot.ts) is unit-tested
        // with injected deps and stays measured.
        "src/showcase/rescreenshotRun.ts",
        // Playwright driver. It IS tested — test/showcase-screenshot.test.ts
        // asserts the real layout geometry — but only against a real Chromium,
        // which CI does not install (`npx playwright install chromium` is a
        // documented local step), so those tests skip there. Counting it would
        // measure whether CI has browser binaries, not whether the code is
        // tested.
        "src/showcase/screenshot.ts",
        "src/**/*.d.ts",
      ],
      // Non-regression gate: floors sit ~1-2pp below current measured coverage
      // so `npm run test:coverage` fails if coverage drops, without flaking on
      // minor v8 measurement variance. Ratchet these UP as coverage grows;
      // never lower them to make a red build pass.
      thresholds: {
        statements: 89,
        branches: 80,
        functions: 89,
        lines: 90,
      },
    },
  },
});
