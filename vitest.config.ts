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
        "src/**/*.d.ts",
      ],
      // Non-regression gate: floors sit ~1-2pp below current measured coverage
      // so `npm run test:coverage` fails if coverage drops, without flaking on
      // minor v8 measurement variance. Ratchet these UP as coverage grows;
      // never lower them to make a red build pass.
      thresholds: {
        statements: 82,
        branches: 78,
        functions: 80,
        lines: 83,
      },
    },
  },
});
