import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { containsNul } from "../src/ds/nul.js";
import { nextVersions, parseVersion } from "../src/ds/semver.js";
import { validateSnapshot, type Snapshot } from "../src/ds/snapshotSchema.js";

const BASE = (
  JSON.parse(readFileSync(new URL("./fixtures/ds-diff/none-identical.json", import.meta.url), "utf8")) as { before: Snapshot }
).before;

function mutated(change: (s: Snapshot) => void): Snapshot {
  const copy = JSON.parse(JSON.stringify(BASE)) as Snapshot;
  change(copy);
  return copy;
}

describe("validateSnapshot", () => {
  it("accepts the base fixture and strips unknown keys", () => {
    const result = validateSnapshot({ ...BASE, extra: 1, variables: BASE.variables.map((v) => ({ ...v, value: "#fff" })) });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("extra");
    expect(JSON.stringify(result)).not.toContain('"value"');
  });

  it.each([
    ["a duplicate variable id", (s: Snapshot) => s.variables.push({ ...s.variables[0] })],
    ["a duplicate component key", (s: Snapshot) => s.components.push({ ...s.components[0] })],
    ["an unknown collection", (s: Snapshot) => void (s.variables[0].collectionId = "nope")],
    ["a value for an unknown mode", (s: Snapshot) => void (s.variables[0].valuesByMode.sepia = "#fff")],
    ["an alias of another type", (s: Snapshot) => void (s.variables[0].valuesByMode.light = { alias: "var_space" })],
    ["an alias cycle", (s: Snapshot) => {
      s.variables[0].valuesByMode.light = { alias: "var_accent" };
    }],
    ["a missing default mode", (s: Snapshot) => void (s.collections[1].defaultModeId = "nope")],
    ["a theme collection with a third mode", (s: Snapshot) => s.collections[0].modes.push({ id: "sepia", name: "Sepia" })],
    ["a replacement that does not exist", (s: Snapshot) => void (s.variables[0].deprecated = { replacedBy: "var_none" })],
    ["a component replacing itself", (s: Snapshot) => void (s.components[0].meta.deprecated = { replacedBy: "button" })],
    ["the reserved component key", (s: Snapshot) => void (s.components[0].key = "slot")],
    ["an invalid component key", (s: Snapshot) => void (s.components[0].key = "Bad Key")],
    ["a readme over 20 KB", (s: Snapshot) => void (s.docs = { readme: "x".repeat(20 * 1024 + 1) })],
    ["a NUL character", (s: Snapshot) => void (s.variables[0].name = "a\u0000b")],
  ])("rejects %s", (_name, change) => {
    const result = validateSnapshot(mutated(change));
    expect(result).toMatchObject({ ok: false, code: "invalid_snapshot" });
  });

  it("accepts the literal text backslash-u0000 (it is not a NUL character)", () => {
    const literal = mutated((s) => void (s.variables[0].name = "a\\u0000b"));
    expect(validateSnapshot(literal).ok).toBe(true);
  });

  it("answers unsupported_schema for a newer version before looking at the rest", () => {
    expect(validateSnapshot({ schemaVersion: 2, whatever: true })).toMatchObject({ ok: false, code: "unsupported_schema" });
  });

  it.each([null, "x", [], { schemaVersion: 1 }])("rejects %j", (raw) => {
    expect(validateSnapshot(raw)).toMatchObject({ ok: false, code: "invalid_snapshot" });
  });
});

describe("semver", () => {
  it("parses strictly and computes the next versions", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(["01.0.0", "1.0", "1.0.0-rc1", "v1.0.0", ""].map(parseVersion)).toEqual([null, null, null, null, null]);
    expect(nextVersions("1.4.2")).toEqual({ major: "2.0.0", minor: "1.5.0", patch: "1.4.3" });
    expect(nextVersions(null)).toEqual({ major: "1.0.0", minor: "1.0.0", patch: "1.0.0" });
  });
});

describe("containsNul", () => {
  it("finds a real U+0000 in values, keys and nested containers, and ignores the escape text", () => {
    expect(containsNul("a\u0000b")).toBe(true);
    expect(containsNul({ a: [{ b: "x\u0000" }] })).toBe(true);
    expect(containsNul({ "k\u0000": 1 })).toBe(true);
    expect(containsNul("a\\u0000b")).toBe(false);
    expect(containsNul({ a: [1, null, true, "plain"] })).toBe(false);
    expect(containsNul(undefined)).toBe(false);
  });
});
