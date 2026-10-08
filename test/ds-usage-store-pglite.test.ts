// ds_usage SQL (migration 021) against PGlite: idempotent upsert, prev_metrics
// rotation, validation against the pinned snapshot, no free text stored,
// 90-day pruning, deletion rights and the summary math.
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "../src/ds/access.js";
import { createDsStore, type DsStore, type NewVersion } from "../src/ds/dsStore.js";
import type { Snapshot } from "../src/ds/snapshotSchema.js";
import { USAGE_PRUNE_BATCH, usageMetricsSchema, type UsageMetrics } from "../src/ds/usage.js";
import { assert } from "./helpers.js";
import { createPgliteAuthPool } from "./pgliteAuthPool.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";

const user = (userId: string): Principal => ({ userId, kind: "user", scopes: [] });
const BASE = (JSON.parse(readFileSync(new URL("./fixtures/ds-diff/none-identical.json", import.meta.url), "utf8")) as { before: Snapshot }).before;
const doc = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function metrics(over: Partial<UsageMetrics> = {}): UsageMetrics {
  return {
    schemaVersion: 1,
    nodes: 100,
    tokens: { bindable: 10, bound: 8, boundToLibrary: 6, literal: 2, use: { var_brand: 4 } },
    components: { instances: 4, detached: 1, use: { button: 3 }, detachedByKey: { button: 1 } },
    lint: { "hardcoded-value": 2 },
    ...over,
  };
}

describe("ds_usage store against PGlite", () => {
  let harness: PgliteHarness;
  let store: DsStore;
  let lib = "";

  const version = (v: string, snapshot: Snapshot): NewVersion => ({
    version: v,
    bump: "minor",
    baseVersion: null,
    snapshotJson: JSON.stringify(snapshot),
    snapshotHash: `hash-${v}`,
    changelog: {},
    summary: { added: 0, changed: 0, deprecated: 0, removed: 0 },
    migrations: [],
    notes: "",
    idempotencyKey: `key-${v}-00000`,
    requestHash: `req-${v}`,
  });
  const publish = (v: string) =>
    store.publish({ libraryId: lib, principal: user("owner"), idempotencyKey: `key-${v}-00000` }, () => ({ kind: "insert", version: version(v, BASE) }));
  const report = (documentKey: string, m: UsageMetrics, who = "owner", v = "1.0.0") =>
    store.reportUsage({ libraryId: lib, principal: user(who), documentKey, version: v, metrics: m });
  const row = async (documentKey: string) =>
    (await harness.pglite.query<{ reporter_id: string; metrics: UsageMetrics; prev_metrics: UsageMetrics | null }>(
      "SELECT reporter_id, metrics, prev_metrics FROM ds_usage WHERE document_key = $1",
      [documentKey],
    )).rows[0];

  beforeAll(async () => {
    harness = await createPgliteHarness(["ds_libraries"]);
    store = createDsStore("postgres://x", { ...createPgliteAuthPool(harness.pglite), end: async () => {} })!;
  }, 30_000);
  afterEach(async () => {
    await harness.reset();
  });
  afterAll(async () => {
    await harness.close();
  });

  async function seed() {
    const created = await store.createLibrary({ id: "lib_u", principal: user("owner"), name: "Kit", description: "" });
    assert(created.kind === "created");
    lib = created.library.id;
    await publish("1.0.0");
  }

  it("upserts per (library, document): one row, replaced flag, prev_metrics rotates only on change", async () => {
    await seed();
    expect(await report(doc(1), metrics())).toEqual({ kind: "ok", replaced: false });
    expect((await row(doc(1))).prev_metrics).toBeNull();
    // An identical retry changes nothing: the real "before" is not erased.
    expect(await report(doc(1), metrics())).toEqual({ kind: "ok", replaced: true });
    expect((await row(doc(1))).prev_metrics).toBeNull();
    const next = metrics({ lint: { "hardcoded-value": 5 } });
    await report(doc(1), next);
    const r = await row(doc(1));
    expect(r.metrics).toEqual(next);
    expect(r.prev_metrics).toEqual(metrics());
    expect((await harness.pglite.query("SELECT 1 FROM ds_usage")).rows).toHaveLength(1);
  });

  it("rejects an unknown version and ids outside the pinned snapshot, without echoing them", async () => {
    await seed();
    expect(await report(doc(1), metrics(), "owner", "9.9.9")).toEqual({ kind: "unknown_version" });
    const bad = metrics({
      tokens: { bindable: 1, bound: 1, boundToLibrary: 1, literal: 0, use: { var_brand: 1, "secret-id": 2 } },
      components: { instances: 1, detached: 1, use: { nope: 1 }, detachedByKey: { nope: 1 } },
    });
    expect(await report(doc(1), bad)).toEqual({ kind: "unknown_ids", count: 3 });
    expect((await harness.pglite.query("SELECT 1 FROM ds_usage")).rows).toHaveLength(0);
  });

  it("stores no free text: the schema is strict, so a marker string in any field is refused", () => {
    const MARKER = "MARKER-secret-title";
    for (const poisoned of [
      { ...metrics(), title: MARKER },
      { ...metrics(), tokens: { ...metrics().tokens, name: MARKER } },
      { ...metrics(), lint: { [MARKER]: 1 } },
      { ...metrics(), nodes: MARKER },
      { ...metrics(), nodes: -1 },
      { ...metrics(), nodes: 1.5 },
      { ...metrics(), nodes: 10_000_001 },
    ]) {
      expect(usageMetricsSchema.safeParse(poisoned).success).toBe(false);
    }
    expect(usageMetricsSchema.safeParse(metrics()).success).toBe(true);
  });

  it("needs a role: a stranger gets not_found, an agent may report (read), nobody else's library", async () => {
    await seed();
    expect(await report(doc(1), metrics(), "stranger")).toEqual({ kind: "not_found" });
    expect(await store.getUsageSummary(lib, user("stranger"))).toBeNull();
    const agent: Principal = { userId: "owner", kind: "agent", scopes: [] };
    expect((await store.reportUsage({ libraryId: lib, principal: agent, documentKey: doc(2), version: "1.0.0", metrics: metrics() })).kind).toBe("ok");
  });

  it("prunes at most 50 reports older than 90 days per write and the summary ignores them", async () => {
    await seed();
    for (let i = 0; i < USAGE_PRUNE_BATCH + 5; i++) await report(doc(i + 1), metrics());
    await harness.pglite.query(`UPDATE ds_usage SET reported_at = now() - interval '91 days'`);
    expect((await store.getUsageSummary(lib, user("owner")) as { documents: { total: number } }).documents.total).toBe(0);
    await report(doc(900), metrics());
    expect(Number((await harness.pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM ds_usage")).rows[0].n)).toBe(55 + 1 - USAGE_PRUNE_BATCH);
    await report(doc(901), metrics());
    expect(Number((await harness.pglite.query<{ n: number }>("SELECT count(*)::int AS n FROM ds_usage")).rows[0].n)).toBe(2);
  });

  it("lets the reporter or an admin delete a report; another reader may not; absent is idempotent", async () => {
    await seed();
    await report(doc(1), metrics());
    const input = (who: string) => ({ libraryId: lib, principal: user(who), documentKey: doc(1) });
    expect(await store.deleteUsage(input("stranger"))).toBe("not_found");
    expect(await store.deleteUsage(input("owner"))).toBe("deleted");
    expect(await row(doc(1))).toBeUndefined();
    expect(await store.deleteUsage(input("owner"))).toBe("deleted");
  });

  it("summarizes: documents, behind, coverage, top detached, unused tokens, lint and regressions", async () => {
    await seed();
    await publish("1.1.0");
    await report(doc(1), metrics(), "owner", "1.1.0");
    await report(doc(2), metrics({ tokens: { bindable: 10, bound: 2, boundToLibrary: 1, literal: 8, use: { var_bg: 1 } }, lint: { "hardcoded-value": 1, contrast: 1 } }), "owner", "1.0.0");
    // doc 2 reports again with more hardcoded values: a regression.
    await report(doc(2), metrics({ tokens: { bindable: 10, bound: 2, boundToLibrary: 1, literal: 8, use: { var_bg: 1 } }, lint: { "hardcoded-value": 4, contrast: 1 } }), "owner", "1.0.0");
    const s = (await store.getUsageSummary(lib, user("owner"))) as Exclude<Awaited<ReturnType<DsStore["getUsageSummary"]>>, null | { kind: string }>;
    expect(s.documents).toEqual({ total: 2, byVersion: { "1.1.0": 1, "1.0.0": 1 }, behind: 1 });
    expect(s.coverage.token).toEqual({ avg: 0.5, p50: 0.5 });
    expect(s.coverage.component).toEqual({ avg: 0.75, p50: 0.75 });
    expect(s.topDetached).toEqual([{ key: "button", count: 2 }]);
    expect(s.unusedTokens.map((t) => t.id).sort()).toEqual(["var_accent", "var_space"]);
    expect(s.lint).toMatchObject({ "hardcoded-value": 6, contrast: 1, "off-scale-value": 0, "component-drift": 0 });
    expect(s.regressions).toEqual([{ documentKey: doc(2).slice(0, 8), rule: "hardcoded-value", delta: 3 }]);
    expect(s.lastReportedAt).toBeInstanceOf(Date);
  });

  it("an empty library summarizes to zeros", async () => {
    await seed();
    const s = (await store.getUsageSummary(lib, user("owner"))) as { documents: { total: number }; coverage: { token: unknown }; lastReportedAt: unknown };
    expect(s.documents.total).toBe(0);
    expect(s.coverage.token).toBeNull();
    expect(s.lastReportedAt).toBeNull();
  });
});
