// Golden fixtures (test/fixtures/ds-diff) are mirrored in pen-editor
// (src/lib/designSystem/__tests__/fixtures); both repos' diffs must agree.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cssNameOf,
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
        "patch-undeprecate", "patch-ordering", "none-identical", "major-rename-variable", "patch-rename-same-css",
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

  const rename = (id: string, cssFrom: string, cssTo: string): Migration => ({ op: "renameToken", id, cssFrom, cssTo });
  const rebind = (from: string, to: string, cssFrom: string, cssTo: string): Migration => ({ op: "rebindToken", from, to, cssFrom, cssTo });

  it("collapses a rename chain and drops a rename that comes back", () => {
    expect(composeMigrations([[rename("x", "--a", "--b")], [rename("x", "--b", "--c")]])).toEqual([rename("x", "--a", "--c")]);
    expect(composeMigrations([[rename("x", "--a", "--b")], [rename("x", "--b", "--a")]])).toEqual([]);
  });

  it("points an earlier rebind at the renamed target and keeps the rename", () => {
    expect(composeMigrations([[rebind("a", "b", "--a", "--b")], [rename("b", "--b", "--b2")]])).toEqual([
      rename("b", "--b", "--b2"),
      rebind("a", "b", "--a", "--b2"),
    ]);
  });

  it("turns a rename followed by a rebind of the same token into one rebind from the original CSS name", () => {
    expect(composeMigrations([[rename("b", "--b", "--b2")], [rebind("b", "c", "--b2", "--c")]])).toEqual([rebind("b", "c", "--b", "--c")]);
  });

  it("drops a rename of a token that is frozen later", () => {
    expect(composeMigrations([[rename("b", "--b", "--b2")], [{ op: "freezeToken", id: "b" }]])).toEqual([{ op: "freezeToken", id: "b" }]);
  });

  it("freezes a rebound source with the value of the token that was frozen", () => {
    expect(composeMigrations([[rebind("a", "b", "--a", "--b")], [{ op: "freezeToken", id: "b" }]])).toEqual([
      { op: "freezeToken", id: "a", valueFrom: "b" },
      { op: "freezeToken", id: "b" },
    ]);
    expect(
      composeMigrations([[rebind("a", "b", "--a", "--b")], [rebind("b", "c", "--b", "--c")], [{ op: "freezeToken", id: "c" }]]),
    ).toEqual([
      { op: "freezeToken", id: "a", valueFrom: "c" },
      { op: "freezeToken", id: "b", valueFrom: "c" },
      { op: "freezeToken", id: "c" },
    ]);
  });

  it("keeps one dropMode per mode", () => {
    const drop: Migration = { op: "dropMode", collection: "c", mode: "m" };
    expect(composeMigrations([[drop], [drop]])).toEqual([drop]);
  });
});

// A tiny document model: one usage per token of the first snapshot. Applying
// the per-step migrations one by one is the ground truth; the composed list
// must land every usage in the same place.
type Usage = { kind: "token"; id: string; css: string } | { kind: "literal"; value: string };

function applyMigrations(doc: Usage[], ops: Migration[], valueFrom: (id: string) => string): Usage[] {
  return doc.map((u) => {
    if (u.kind !== "token") return u;
    for (const op of ops) {
      if (op.op === "rebindToken" && u.id === op.from) return { kind: "token", id: op.to, css: op.cssTo };
      if (op.op === "renameToken" && u.id === op.id) return { ...u, css: op.cssTo };
      if (op.op === "freezeToken" && u.id === op.id) return { kind: "literal", value: valueFrom(op.valueFrom ?? op.id) };
    }
    return u;
  });
}

const valueIn = (snapshot: Snapshot, id: string) => JSON.stringify(snapshot.variables.find((v) => v.id === id)?.valuesByMode ?? null);

describe("composeMigrations equals step-by-step application", () => {
  it.each(chains)("%s", (_file, fixture) => {
    const snapshots = fixture.chain.map(validated);
    const start: Usage[] = snapshots[0].variables.map((v) => ({ kind: "token", id: v.id, css: cssNameOf(v) }));
    let sequential = start;
    const steps: Migration[][] = [];
    snapshots.slice(1).forEach((next, i) => {
      const ops = deriveMigrations(snapshots[i], next);
      steps.push(ops);
      sequential = applyMigrations(sequential, ops, (id) => valueIn(snapshots[i], id));
    });
    // A composed freeze reads the value from the last version that still has the token.
    const lastValue = (id: string) => valueIn(snapshots.findLast((s) => s.variables.some((v) => v.id === id)) as Snapshot, id);
    expect(applyMigrations(start, composeMigrations(steps), lastValue)).toEqual(sequential);
  });
});

describe("diffSnapshots on a first publish", () => {
  it("reports initial", () => {
    const { after } = pairs[0][1];
    expect(diffSnapshots(null, validated(after)).requiredBump).toBe("initial");
  });
});
