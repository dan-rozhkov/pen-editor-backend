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
        "src/**/*.d.ts",
      ],
    },
  },
});
