import { afterEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { __resetSharedAuditDb, getSharedAuditDb } from "../src/ai/selfimprove/auditDb.js";
import * as traceStore from "../src/tracing/traceStore.js";

describe("getSharedAuditDb", () => {
  afterEach(() => {
    __resetSharedAuditDb();
    vi.restoreAllMocks();
  });

  it("returns null without TRACE_DATABASE_URL", () => {
    expect(getSharedAuditDb(makeConfig())).toBeNull();
  });

  it("returns the same instance on repeated calls for the same URL", () => {
    const config = makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/unused" });
    const first = getSharedAuditDb(config);
    const second = getSharedAuditDb(config);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("builds a fresh pool when the URL changes", () => {
    const first = getSharedAuditDb(
      makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/one" }),
    );
    const second = getSharedAuditDb(
      makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/two" }),
    );
    expect(second).not.toBe(first);
  });

  // Finding 3: pg's own default is to wait forever for a connection. This
  // pool sits in a hot path (skill_manage's audit write happens inside a
  // turn's `execute`), so an unreachable/saturated Postgres must fail fast
  // rather than hang the user's turn — same reasoning, and the same 5s
  // value, as the neighboring memory/learned-skill pools.
  it("passes a 5s connectionTimeoutMillis to the pool, matching the other hot-path pools", () => {
    const createPgPoolSpy = vi.spyOn(traceStore, "createPgPool");
    getSharedAuditDb(makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/unused" }));
    expect(createPgPoolSpy).toHaveBeenCalledWith(
      "postgres://localhost/unused",
      expect.objectContaining({ connectionTimeoutMillis: 5_000 }),
    );
  });

  // Finding 4: a URL change (only ever seen in tests / multi-config
  // processes) must close the pool it's replacing — otherwise it's simply
  // dropped, leaking a pg.Pool with no one left to close it.
  it("closes the previous pool's connection when the URL changes", () => {
    const first = getSharedAuditDb(
      makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/one" }),
    )!;
    const endSpy = vi.spyOn(first, "end");
    getSharedAuditDb(makeConfig({ TRACE_DATABASE_URL: "postgres://localhost/two" }));
    expect(endSpy).toHaveBeenCalledTimes(1);
  });
});
