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
        // hand-authored-run entrypoints: env + Postgres + S3 + Chromium
        // wiring only. Their pure seams (parseManifest/resolveScreens in
        // src/showcase/ingest.ts, publishScreens in src/showcase/publish.ts)
        // are unit-tested with injected deps.
        "src/showcase/ingestRun.ts",
        "src/showcase/imageRun.ts",
        "src/showcase/themeRun.ts",
        // the wiring those entrypoints share: reads env, connects, exits the
        // process on missing config — nothing to assert that the scripts
        // themselves don't already cover.
        "src/showcase/context.ts",
        // the script-guard tail every showcase CLI shares — it only decides
        // whether process.argv says "run me", which no unit test can observe
        // without becoming a test of the runner itself.
        "src/showcase/cli.ts",
        // rescreenshot entrypoint: same shape again. The loop it drives
        // (rescreenshotScreens, in src/showcase/rescreenshot.ts) is unit-tested
        // with injected deps and stays measured.
        "src/showcase/rescreenshotRun.ts",
        // reencode entrypoint: same shape again. The loop it drives
        // (reencodeScreens, in src/showcase/reencode.ts) is unit-tested with
        // injected deps and stays measured.
        "src/showcase/reencodeRun.ts",
        // pin entrypoint: same shape again. The loop it drives
        // (resolvePinAction/runPinAction, in src/showcase/pin.ts) is
        // unit-tested with an injected fake store and stays measured.
        "src/showcase/pinRun.ts",
        // replace-html and delete entrypoints: same shape again — flags in,
        // context out, one call into the tested module. Their logic
        // (replaceScreenHtml; resolveDeleteAction/runDeleteAction in
        // src/showcase/delete.ts) is unit-tested with an injected fake store
        // and stays measured. replaceHtmlRun.ts was missed when it landed,
        // which is what pushed function coverage under the 89% floor on main.
        "src/showcase/replaceHtmlRun.ts",
        "src/showcase/deleteRun.ts",
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
