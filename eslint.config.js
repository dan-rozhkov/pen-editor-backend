import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  // .stryker-tmp holds a full sandboxed copy of the repo (its own
  // package.json/tsconfig.json) while `npm run test:mutation` is running —
  // without this, typescript-eslint's project auto-detection finds two
  // candidate tsconfig roots and every file fails to parse.
  globalIgnores(["dist", "coverage", ".stryker-tmp"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
  // Guards against silently-inert or flaky-by-construction tests: a
  // conditional inside a test hides an assertion from ever running under
  // some branches, and .skip/.only rot or mask the suite. Scoped to test/**
  // only — nothing in src/ imports vitest globals.
  {
    files: ["test/**/*.ts"],
    plugins: { vitest },
    rules: {
      "vitest/no-conditional-tests": "error",
      "vitest/no-conditional-in-test": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/no-focused-tests": "error",
    },
  },
]);
