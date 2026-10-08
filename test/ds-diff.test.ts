// Golden fixtures (test/fixtures/ds-diff) are mirrored in pen-editor
// (src/lib/designSystem/__tests__/fixtures); both repos' diffs must agree.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkRemovalPolicy,
  composeMigrations,
  deriveMigrations,
  diffSnapshots,
  type Migration,
} from "../src/ds/diff.js";
import { validateSnapshot, type Snapshot } from "../src/ds/snapshotSchema.js";
import { assert } from "./helpers.js";

const DIR = new URL("./fixtures/ds-diff/", import.meta.url);

interface PairFixture {
  description: string;
  before: Snapshot;
  after: Snapshot;
  expect: {
    requiredBump: string;
    removed: string[];
    addedKeys: string[];
    violations: Array<{ code: string; entity: string }>;
    migrations: Migration[];
  };
}

interface ChainFixture {
  description: string;
  chain: Snapshot[];
  expect: {
    steps: Array<{ requiredBump: string; violations: Array<{ code: string; entity: string }>; migrations: Migration[] }>;
    composedMigrations: Migration[];
  };
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
const load = <T>(file: string) => JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as T;
const pairs = files.filter((f) => !f.startsWith("chain-")).map((f) => [f, load<PairFixture>(f)] as const);
const chains = files.filter((f) => f.startsWith("chain-")).map((f) => [f, load<ChainFixture>(f)] as const);

function validated(raw: Snapshot): Snapshot {
  const result = validateSnapshot(raw);
  expect(result.ok).toBe(true);
  assert(result.ok);
  return result.snapshot;
}

const slim = (v: Array<{ code: string; entity: string }>) => v.map(({ code, entity }) => ({ code, entity }));

describe("ds diff golden fixtures", () => {
  it("covers every row of the bump table", () => {
    expect(pairs.map(([f]) => f.replace(/\.json$/, ""))).toEqual(
      expect.arrayContaining([
        "major-remove-variable-replaced", "major-remove-collection", "major-remove-mode", "major-type-change",
        "major-component-remove-axis", "major-component-remove-axis-value", "major-component-remove-slot",
        "major-remove-component-replaced",
        "minor-add-variable", "minor-add-collection", "minor-add-mode", "minor-add-component",
        "minor-add-axis-value", "minor-add-slot", "minor-deprecate-variable", "minor-deprecate-component",
        "patch-value-literal", "patch-alias-retarget", "patch-component-html", "patch-docs-description",
        "patch-undeprecate", "patch-ordering", "none-identical",
      ]),
    );
  });

  it.each(pairs)("%s", (_file, fixture) => {
    const before = validated(fixture.before);
    const after = validated(fixture.after);
    const diff = diffSnapshots(before, after);
    const violations = checkRemovalPolicy(before, after);
    expect(diff.requiredBump).toBe(fixture.expect.requiredBump);
    expect(diff.removed).toEqual(fixture.expect.removed);
    expect(diff.added).toEqual(fixture.expect.addedKeys);
    expect(slim(violations)).toEqual(fixture.expect.violations);
    expect(violations.length === 0 ? deriveMigrations(before, after) : []).toEqual(fixture.expect.migrations);
  });

  it.each(chains)("%s", (_file, fixture) => {
    const snapshots = fixture.chain.map(validated);
    const steps = snapshots.slice(1).map((next, i) => {
      const prev = snapshots[i];
      return {
        requiredBump: diffSnapshots(prev, next).requiredBump,
        violations: slim(checkRemovalPolicy(prev, next)),
        migrations: deriveMigrations(prev, next),
      };
    });
    expect(steps).toEqual(fixture.expect.steps);
    expect(composeMigrations(steps.map((s) => s.migrations))).toEqual(fixture.expect.composedMigrations);
  });
});

describe("composeMigrations", () => {
  it("terminates on a cycle (an id that comes back) and drops self-rebinds", () => {
    const ab: Migration = { op: "rebindToken", from: "a", to: "b", cssFrom: "--a", cssTo: "--b" };
    const ba: Migration = { op: "rebindToken", from: "b", to: "a", cssFrom: "--b", cssTo: "--a" };
    expect(composeMigrations([[ab], [ba]])).toEqual([ba]);
  });

  it("chains component remaps and turns a remap to a removed component into a removal", () => {
    expect(
      composeMigrations([
        [{ op: "remapComponent", from: "x", to: "y" }],
        [{ op: "remapComponent", from: "y", to: "z" }],
        [{ op: "removeComponent", key: "z" }],
      ]),
    ).toEqual([
      { op: "removeComponent", key: "x" },
      { op: "removeComponent", key: "y" },
      { op: "removeComponent", key: "z" },
    ]);
  });

  it("keeps one dropMode per mode", () => {
    const drop: Migration = { op: "dropMode", collection: "c", mode: "m" };
    expect(composeMigrations([[drop], [drop]])).toEqual([drop]);
  });
});

describe("diffSnapshots on a first publish", () => {
  it("reports initial", () => {
    const { after } = pairs[0][1];
    expect(diffSnapshots(null, validated(after)).requiredBump).toBe("initial");
  });
});
