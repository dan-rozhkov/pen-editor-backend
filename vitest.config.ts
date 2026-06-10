import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Network calls to providers are forbidden in tests; everything is mocked.
    testTimeout: 15_000,
  },
});
