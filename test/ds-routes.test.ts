// /api/ds over real HTTP: the real Better Auth + the real ds SQL on PGlite.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createDsStore, encodeCursor, type DsStore } from "../src/ds/dsStore.js";
import type { Snapshot } from "../src/ds/snapshotSchema.js";
import { APP_ORIGIN, useAuthApp } from "./authHarness.js";
import { recordingAnalyticsClient, startApp } from "./chatHarness.js";
import { assert, makeConfig } from "./helpers.js";
import { createPgliteAuthPool } from "./pgliteAuthPool.js";
import { createPgliteHarness } from "./pgliteShowcaseHelpers.js";

const analytics = recordingAnalyticsClient();
// Lets a test break the store's snapshot reads without touching its other methods.
const fault = { getVersion: false };
const wrapDsStore = (store: DsStore): DsStore => ({
  ...store,
  getVersion: (...args: Parameters<DsStore["getVersion"]>) => {
    if (fault.getVersion) throw new Error("injected getVersion failure");
    return store.getVersion(...args);
  },
});
const app = useAuthApp({}, { withDsStore: true, analytics, wrapDsStore });

const BASE = (
  JSON.parse(readFileSync(new URL("./fixtures/ds-diff/none-identical.json", import.meta.url), "utf8")) as { before: Snapshot }
).before;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const withVar = (s: Snapshot, extra: Snapshot["variables"][number]): Snapshot => ({ ...clone(s), variables: [...clone(s).variables, extra] });
const OLD: Snapshot["variables"][number] = {
  id: "var_old",
  name: "Old Brand",
  type: "color",
  collectionId: "theme",
  valuesByMode: { light: "#0050ff", dark: "#4080ff" },
};
const V1 = withVar(BASE, OLD);
const V2 = withVar(BASE, { ...OLD, deprecated: { since: "1.1.0", replacedBy: "var_brand" } });
const V3 = BASE;

let cookieA = "";
let cookieB = "";
let hop = 0;

function call(cookie: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${app().url}${path}`, {
    method,
    headers: {
      Origin: APP_ORIGIN,
      // Rate limits key on the client IP; every call gets its own.
      "X-Forwarded-For": `203.0.113.${(++hop % 250) + 1}`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createLibrary(cookie: string, name = `Kit ${randomUUID().slice(0, 8)}`): Promise<string> {
  const res = await call(cookie, "POST", "/api/ds/libraries", { name });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

interface PublishBody {
  baseVersion: string | null;
  bump?: string;
  snapshot: unknown;
  notes?: string;
}
function publish(cookie: string, libraryId: string, body: PublishBody, key: string = randomUUID()) {
  return call(cookie, "POST", `/api/ds/libraries/${libraryId}/versions`, { bump: "minor", ...body }, { "Idempotency-Key": key });
}
const errorOf = async (res: Response) => (await res.json()) as { error: string; message: string; details?: Record<string, unknown> };

beforeAll(async () => {
  cookieA = await app().signUp("ds-a@example.test");
  cookieB = await app().signUp("ds-b@example.test");
});

describe("access", () => {
  it("answers 401 to a caller without a session, even with a plausible anonymous userId", async () => {
    const anon = await call("", "GET", "/api/ds/libraries");
    expect(anon.status).toBe(401);
    expect(await errorOf(anon)).toMatchObject({ error: "unauthorized" });
    const forged = await call("", "POST", "/api/ds/libraries", { name: "Forged", userId: randomUUID() });
    expect(forged.status).toBe(401);
  });

  it("hides another account's library behind 404 on every route", async () => {
    const id = await createLibrary(cookieA);
    const base = `/api/ds/libraries/${id}`;
    const attempts = await Promise.all([
      call(cookieB, "GET", base),
      call(cookieB, "PATCH", base, { name: "Mine now" }),
      call(cookieB, "DELETE", base),
      call(cookieB, "POST", `${base}/preview`, { baseVersion: null, snapshot: BASE }),
      publish(cookieB, id, { baseVersion: null, snapshot: BASE }),
      call(cookieB, "GET", `${base}/versions`),
      call(cookieB, "GET", `${base}/versions/latest`),
      call(cookieB, "GET", `${base}/updates?from=1.0.0`),
    ]);
    expect(attempts.map((r) => r.status)).toEqual(Array(8).fill(404));
    expect((await call(cookieB, "GET", "/api/ds/libraries").then((r) => r.json())) as { items: unknown[] }).toEqual({ items: [], nextCursor: null });
  });

  it("answers 503 when the store is off and when accounts are off", async () => {
    const off = await startApp(makeConfig(), { dsStore: null });
    const harness = await createPgliteHarness([]);
    const noAuth = await startApp(makeConfig(), { dsStore: createDsStore("postgres://x", { ...createPgliteAuthPool(harness.pglite), end: async () => {} }) });
    try {
      const storeOff = await fetch(`${off.url}/api/ds/libraries`);
      expect([storeOff.status, (await errorOf(storeOff)).error]).toEqual([503, "ds_unavailable"]);
      const authOff = await fetch(`${noAuth.url}/api/ds/libraries`);
      expect([authOff.status, (await errorOf(authOff)).error]).toEqual([503, "auth_disabled"]);
    } finally {
      await off.close();
      await noAuth.close();
      await harness.close();
    }
  });
});

describe("library CRUD", () => {
  it("creates, reads, renames, lists with a cursor and archives", async () => {
    const created = await call(cookieB, "POST", "/api/ds/libraries", { name: "  Core  ", description: "Tokens" });
    expect(created.status).toBe(201);
    const lib = (await created.json()) as { id: string; name: string; ownerId: string; latestVersion: null };
    expect(created.headers.get("location")).toBe(`/api/ds/libraries/${lib.id}`);
    expect(lib).toMatchObject({ name: "Core", latestVersion: null });
    expect(lib.id).toMatch(/^lib_[A-Za-z0-9_-]{12}$/);

    expect((await call(cookieB, "POST", "/api/ds/libraries", { name: "core" })).status).toBe(409);
    expect((await call(cookieB, "POST", "/api/ds/libraries", { name: "" })).status).toBe(400);
    expect(await errorOf(await call(cookieB, "POST", "/api/ds/libraries", { name: "a\u0000b" }))).toMatchObject({ error: "invalid_request" });

    const renamed = await call(cookieB, "PATCH", `/api/ds/libraries/${lib.id}`, { name: "Core v2" });
    expect(((await renamed.json()) as { name: string }).name).toBe("Core v2");
    expect((await call(cookieB, "PATCH", `/api/ds/libraries/${lib.id}`, {})).status).toBe(400);

    await createLibrary(cookieB, "Second");
    await createLibrary(cookieB, "Third");
    const first = (await (await call(cookieB, "GET", "/api/ds/libraries?limit=2")).json()) as { items: Array<{ id: string }>; nextCursor: string };
    const second = (await (await call(cookieB, "GET", `/api/ds/libraries?limit=2&cursor=${first.nextCursor}`)).json()) as { items: Array<{ id: string }>; nextCursor: null };
    expect([first.items.length, second.items.length, second.nextCursor]).toEqual([2, 1, null]);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(3);
    expect((await call(cookieB, "GET", "/api/ds/libraries?limit=0")).status).toBe(400);
    expect(await errorOf(await call(cookieB, "GET", "/api/ds/libraries?cursor=garbage"))).toMatchObject({ error: "invalid_cursor" });

    expect((await call(cookieB, "DELETE", `/api/ds/libraries/${lib.id}`)).status).toBe(204);
    expect((await call(cookieB, "DELETE", `/api/ds/libraries/${lib.id}`)).status).toBe(204);
    const archived = (await (await call(cookieB, "GET", `/api/ds/libraries/${lib.id}`)).json()) as { archivedAt: string };
    expect(archived.archivedAt).toBeTruthy();
    expect(await errorOf(await publish(cookieB, lib.id, { baseVersion: null, snapshot: BASE }))).toMatchObject({ error: "archived" });
    expect(await errorOf(await call(cookieB, "PATCH", `/api/ds/libraries/${lib.id}`, { name: "x" }))).toMatchObject({ error: "archived" });
    const names = (await (await call(cookieB, "GET", "/api/ds/libraries")).json()) as { items: Array<{ name: string }> };
    expect(names.items.map((i) => i.name)).not.toContain("Core v2");
  });
});

describe("the Phase 6 exit sequence", () => {
  it("publishes 1.0.0, deprecates (1.1.0), removes (2.0.0) and serves the migration", async () => {
    const id = await createLibrary(cookieA);

    const preview1 = await call(cookieA, "POST", `/api/ds/libraries/${id}/preview`, { baseVersion: null, snapshot: V1 });
    expect(await preview1.json()).toMatchObject({ latestVersion: null, requiredBump: "initial", nextVersions: { major: "1.0.0" } });
    expect(((await (await call(cookieA, "GET", `/api/ds/libraries/${id}`)).json()) as { latestVersion: null }).latestVersion).toBeNull();

    const first = await publish(cookieA, id, { baseVersion: null, bump: "major", snapshot: V1, notes: "First" });
    expect(first.status).toBe(201);
    expect(first.headers.get("location")).toBe(`/api/ds/libraries/${id}/versions/1.0.0`);
    expect(await first.json()).toMatchObject({ version: "1.0.0", bump: "initial" });

    const preview2 = (await (await call(cookieA, "POST", `/api/ds/libraries/${id}/preview`, { baseVersion: "1.0.0", snapshot: V2 })).json()) as Record<string, unknown>;
    expect(preview2).toMatchObject({ latestVersion: "1.0.0", requiredBump: "minor", summary: { deprecated: 1 }, violations: [], nextVersions: { minor: "1.1.0" } });

    const second = await publish(cookieA, id, { baseVersion: "1.0.0", bump: "minor", snapshot: V2 });
    expect(await second.json()).toMatchObject({ version: "1.1.0", bump: "minor" });

    const third = await publish(cookieA, id, { baseVersion: "1.1.0", bump: "major", snapshot: V3 });
    expect(third.status).toBe(201);
    expect(await third.json()).toMatchObject({ version: "2.0.0", bump: "major" });

    const updates = (await (await call(cookieA, "GET", `/api/ds/libraries/${id}/updates?from=1.0.0`)).json()) as {
      current: string; latest: string; hasMore: boolean; items: Array<{ version: string; migrations: unknown[] }>;
    };
    expect([updates.current, updates.latest, updates.hasMore]).toEqual(["1.0.0", "2.0.0", false]);
    expect(updates.items.map((i) => i.version)).toEqual(["1.1.0", "2.0.0"]);
    expect(updates.items[1].migrations).toEqual([
      { op: "rebindToken", from: "var_old", to: "var_brand", cssFrom: "--old-brand", cssTo: "--brand" },
    ]);
    expect((await call(cookieA, "GET", `/api/ds/libraries/${id}/updates?from=7.7.7`)).status).toBe(404);
    expect((await call(cookieA, "GET", `/api/ds/libraries/${id}/updates`)).status).toBe(400);

    const list = (await (await call(cookieA, "GET", `/api/ds/libraries/${id}/versions?limit=2`)).json()) as {
      items: Array<{ version: string; summary: { removed: number }; snapshot?: unknown }>; nextCursor: string;
    };
    expect(list.items.map((i) => i.version)).toEqual(["2.0.0", "1.1.0"]);
    expect(list.items[0].summary.removed).toBe(1);
    expect(list.items[0].snapshot).toBeUndefined();
    expect(list.nextCursor).toBeTruthy();

    const detail = (await (await call(cookieA, "GET", `/api/ds/libraries/${id}`)).json()) as { latestVersion: string; latest: { version: string } };
    expect([detail.latestVersion, detail.latest.version]).toEqual(["2.0.0", "2.0.0"]);
  });

  it("serves versions with an ETag, 304 and immutable caching", async () => {
    const id = await createLibrary(cookieA);
    await publish(cookieA, id, { baseVersion: null, snapshot: BASE });
    const res = await call(cookieA, "GET", `/api/ds/libraries/${id}/versions/1.0.0`);
    const etag = res.headers.get("etag");
    assert(etag);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await res.json()).toMatchObject({ version: "1.0.0", baseVersion: null, snapshot: { schemaVersion: 1 }, migrations: [] });

    const cached = await call(cookieA, "GET", `/api/ds/libraries/${id}/versions/1.0.0`, undefined, { "If-None-Match": etag });
    expect([cached.status, await cached.text()]).toEqual([304, ""]);

    expect(etag).toMatch(/^"1\.0\.0:[0-9a-f]{64}"$/);
    const latest = await call(cookieA, "GET", `/api/ds/libraries/${id}/versions/latest`);
    expect([latest.headers.get("etag"), latest.headers.get("cache-control")]).toEqual([etag, "private, no-cache"]);
    expect((await call(cookieA, "GET", `/api/ds/libraries/${id}/versions/9.9.9`)).status).toBe(404);
    expect((await call(cookieA, "GET", `/api/ds/libraries/${id}/versions/nope`)).status).toBe(404);
  });
});

describe("ETag across a revert", () => {
  it("does not 304 a stale body when a later version reverts to an earlier snapshot", async () => {
    const id = await createLibrary(cookieA);
    await publish(cookieA, id, { baseVersion: null, snapshot: BASE });
    const edited = clone(BASE);
    edited.variables[0].description = "temporary";
    await publish(cookieA, id, { baseVersion: "1.0.0", bump: "patch", snapshot: edited });
    expect((await publish(cookieA, id, { baseVersion: "1.0.1", bump: "patch", snapshot: BASE })).status).toBe(201);

    const first = await call(cookieA, "GET", `/api/ds/libraries/${id}/versions/1.0.0`);
    const revert = await call(cookieA, "GET", `/api/ds/libraries/${id}/versions/1.0.2`, undefined, { "If-None-Match": first.headers.get("etag") as string });
    expect(revert.status).toBe(200);
    expect(((await revert.json()) as { version: string }).version).toBe("1.0.2");
  });
});

describe("library limits and purge", () => {
  it("answers library_limit with the live and total counts", async () => {
    const cookie = await app().signUp("ds-cap@example.test");
    for (let i = 0; i < 20; i++) await createLibrary(cookie, `Cap ${i}`);
    const over = await call(cookie, "POST", "/api/ds/libraries", { name: "One too many" });
    expect([over.status, await errorOf(over)]).toMatchObject([422, { error: "library_limit", details: { live: 20, total: 20 } }]);
  });

  it("hard-deletes an archived library with ?purge=true, and only that", async () => {
    const id = await createLibrary(cookieA);
    await publish(cookieA, id, { baseVersion: null, snapshot: BASE });
    const early = await call(cookieA, "DELETE", `/api/ds/libraries/${id}?purge=true`);
    expect([early.status, (await errorOf(early)).error]).toEqual([409, "not_archived"]);
    expect((await call(cookieB, "DELETE", `/api/ds/libraries/${id}?purge=true`)).status).toBe(404);
    expect((await call(cookieA, "DELETE", `/api/ds/libraries/${id}`)).status).toBe(204);
    expect((await call(cookieB, "DELETE", `/api/ds/libraries/${id}?purge=true`)).status).toBe(404);
    expect((await call(cookieA, "DELETE", `/api/ds/libraries/${id}?purge=true`)).status).toBe(204);
    expect((await call(cookieA, "GET", `/api/ds/libraries/${id}`)).status).toBe(404);
    expect((await call(cookieA, "DELETE", `/api/ds/libraries/${id}?purge=true`)).status).toBe(404);
    expect((await call(cookieA, "DELETE", `/api/ds/libraries/${id}?purge=maybe`)).status).toBe(400);
  });
});

describe("text fields", () => {
  it("rejects a real NUL but accepts the literal text backslash-u0000", async () => {
    const literal = "back\\u0000slash";
    const lib = await call(cookieA, "POST", "/api/ds/libraries", { name: literal, description: literal });
    expect(lib.status).toBe(201);
    const id = ((await lib.json()) as { id: string }).id;
    const snapshot = clone(BASE);
    snapshot.variables[0].description = literal;
    expect((await publish(cookieA, id, { baseVersion: null, snapshot, notes: literal })).status).toBe(201);
    expect((await call(cookieA, "POST", "/api/ds/libraries", { name: "ok", description: "a\u0000b" })).status).toBe(400);
  });
});

describe("cursors", () => {
  it("answers 400 invalid_cursor for a decodable cursor with bad values", async () => {
    const id = await createLibrary(cookieA);
    const bad = [
      ["/api/ds/libraries", encodeCursor(["not-a-timestamp", "lib_x"])],
      ["/api/ds/libraries", encodeCursor(["2026-01-01T00:00:00.000001Z", "x'; --"])],
      [`/api/ds/libraries/${id}/versions`, encodeCursor(["x.y.z"])],
      [`/api/ds/libraries/${id}/versions`, encodeCursor(["99999999999.0.0"])],
    ] as const;
    for (const [path, cursor] of bad) {
      const res = await call(cookieA, "GET", `${path}?cursor=${cursor}`);
      expect([res.status, (await errorOf(res)).error]).toEqual([400, "invalid_cursor"]);
    }
    const ok = await call(cookieA, "GET", `/api/ds/libraries/${id}/versions?cursor=${encodeCursor(["1.0.0"])}`);
    expect(ok.status).toBe(200);
  });
});

describe("publish after commit", () => {
  it("stays 201 with a summary in analytics even when the store cannot read the version back", async () => {
    const id = await createLibrary(cookieA);
    const before = analytics.events.length;
    fault.getVersion = true;
    try {
      const res = await publish(cookieA, id, { baseVersion: null, snapshot: withVar(BASE, OLD) });
      expect(res.status).toBe(201);
    } finally {
      fault.getVersion = false;
    }
    const event = analytics.events.slice(before).find((e) => e.event === "ds_published");
    expect(event?.properties).toEqual({ bump: "initial", added: 0, changed: 0, deprecated: 0, removed: 0 });
  });
});

describe("publish rules", () => {
  it("refuses a removal in the same publish as the deprecation, and a removal never deprecated", async () => {
    const id = await createLibrary(cookieA);
    await publish(cookieA, id, { baseVersion: null, snapshot: V1 });
    const refused = await publish(cookieA, id, { baseVersion: "1.0.0", bump: "major", snapshot: V3 });
    expect(refused.status).toBe(422);
    expect(await errorOf(refused)).toMatchObject({ error: "removal_not_deprecated", details: { entities: ["variable:var_old"] } });
    const preview = (await (await call(cookieA, "POST", `/api/ds/libraries/${id}/preview`, { baseVersion: "1.0.0", snapshot: V3 })).json()) as { violations: Array<{ code: string }> };
    expect(preview.violations.map((v) => v.code)).toEqual(["removal_not_deprecated"]);
  });

  it("refuses a bump below what the change needs and accepts a higher one", async () => {
    const id = await createLibrary(cookieA);
    await publish(cookieA, id, { baseVersion: null, snapshot: BASE });
    const added = withVar(BASE, { ...OLD, id: "var_new" });
    const low = await publish(cookieA, id, { baseVersion: "1.0.0", bump: "patch", snapshot: added });
    expect([low.status, await errorOf(low)]).toMatchObject([422, { error: "bump_too_low", details: { required: "minor" } }]);
    const high = await publish(cookieA, id, { baseVersion: "1.0.0", bump: "major", snapshot: added });
    expect(await high.json()).toMatchObject({ version: "2.0.0", bump: "major" });
  });

  it("answers no_changes, stale_base and invalid bodies", async () => {
    const id = await createLibrary(cookieA);
    const stale = await publish(cookieA, id, { baseVersion: "1.0.0", snapshot: BASE });
    expect(await errorOf(stale)).toMatchObject({ error: "stale_base", details: { latestVersion: null } });
    await publish(cookieA, id, { baseVersion: null, snapshot: BASE });
    expect(await errorOf(await publish(cookieA, id, { baseVersion: "1.0.0", snapshot: BASE }))).toMatchObject({ error: "no_changes" });
    expect(await errorOf(await publish(cookieA, id, { baseVersion: null, snapshot: withVar(BASE, OLD) }))).toMatchObject({
      error: "stale_base",
      details: { latestVersion: "1.0.0" },
    });
    expect((await publish(cookieA, id, { baseVersion: "1.0.0", bump: "huge", snapshot: BASE })).status).toBe(400);
    expect((await call(cookieA, "POST", `/api/ds/libraries/${id}/versions`, { baseVersion: "1.0.0", bump: "patch", snapshot: BASE })).status).toBe(400);
  });

  it("rejects invalid and too-new snapshots with the field that is wrong", async () => {
    const id = await createLibrary(cookieA);
    const broken = withVar(BASE, { ...OLD, valuesByMode: { light: { alias: "var_missing" }, dark: "#000" } });
    const invalid = await publish(cookieA, id, { baseVersion: null, snapshot: broken });
    expect(invalid.status).toBe(422);
    const body = await errorOf(invalid);
    expect(body.error).toBe("invalid_snapshot");
    expect(JSON.stringify(body.details)).toContain("var_missing");
    expect(await errorOf(await publish(cookieA, id, { baseVersion: null, snapshot: { ...BASE, schemaVersion: 2 } }))).toMatchObject({ error: "unsupported_schema" });
    const nul = clone(BASE);
    nul.variables[0].description = "a\u0000b";
    expect(await errorOf(await publish(cookieA, id, { baseVersion: null, snapshot: nul }))).toMatchObject({ error: "invalid_snapshot" });
    const noTheme = clone(BASE);
    noTheme.collections[0].modes.pop();
    expect((await publish(cookieA, id, { baseVersion: null, snapshot: noTheme })).status).toBe(422);
  });

  it("enforces the size limits", async () => {
    const id = await createLibrary(cookieA);
    const big = await publish(cookieA, id, { baseVersion: null, snapshot: { pad: "x".repeat(4.3 * 1024 * 1024) } });
    expect([big.status, (await errorOf(big)).error]).toEqual([413, "snapshot_too_large"]);
  });
});

describe("idempotency and concurrency", () => {
  it("replays the stored result for the same key and body, and refuses a reused key", async () => {
    const id = await createLibrary(cookieA);
    const body = { baseVersion: null, snapshot: BASE, notes: "once" };
    const key = randomUUID();
    const first = await publish(cookieA, id, body, key);
    const replay = await publish(cookieA, id, body, key);
    expect([first.status, replay.status, replay.headers.get("idempotent-replayed")]).toEqual([201, 200, "true"]);
    expect(await replay.json()).toEqual(await first.json());
    expect(first.headers.get("idempotent-replayed")).toBeNull();

    const reused = await publish(cookieA, id, { ...body, notes: "different" }, key);
    expect([reused.status, (await errorOf(reused)).error]).toEqual([422, "idempotency_key_reuse"]);
    const versions = (await (await call(cookieA, "GET", `/api/ds/libraries/${id}/versions`)).json()) as { items: unknown[] };
    expect(versions.items).toHaveLength(1);
  });

  it("requires an Idempotency-Key", async () => {
    const id = await createLibrary(cookieA);
    const missing = await call(cookieA, "POST", `/api/ds/libraries/${id}/versions`, { baseVersion: null, bump: "minor", snapshot: BASE });
    expect((await errorOf(missing)).error).toBe("idempotency_key_required");
    const short = await publish(cookieA, id, { baseVersion: null, snapshot: BASE }, "short");
    expect(short.status).toBe(400);
  });

  it("lets exactly one of two concurrent publishes win", async () => {
    const id = await createLibrary(cookieA);
    await publish(cookieA, id, { baseVersion: null, snapshot: BASE });
    const a = clone(BASE);
    a.variables[0].description = "from tab A";
    const b = clone(BASE);
    b.variables[0].description = "from tab B";
    const results = await Promise.all([
      publish(cookieA, id, { baseVersion: "1.0.0", bump: "patch", snapshot: a }),
      publish(cookieA, id, { baseVersion: "1.0.0", bump: "patch", snapshot: b }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect((await errorOf(loser as Response)).error).toBe("stale_base");
    const versions = (await (await call(cookieA, "GET", `/api/ds/libraries/${id}/versions`)).json()) as { items: unknown[] };
    expect(versions.items).toHaveLength(2);
  });
});

describe("analytics", () => {
  it("captures ds_published with counts only, never names, notes or markup", async () => {
    const marker = "SECRET-MARKER-9f3a";
    const id = await createLibrary(cookieA, `Library ${marker}`);
    const snapshot = withVar(BASE, { ...OLD, name: `Token ${marker}` });
    snapshot.components[0].html = `<button data-c="button">${marker}</button>`;
    await publish(cookieA, id, { baseVersion: null, snapshot, notes: `Notes ${marker}` });
    const event = analytics.events.find((e) => e.event === "ds_published" && e.properties?.bump === "initial");
    expect(event?.properties).toEqual({ bump: "initial", added: 0, changed: 0, deprecated: 0, removed: 0 });
    expect(JSON.stringify(analytics.events)).not.toContain(marker);
  });
});
