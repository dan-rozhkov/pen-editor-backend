// Shared TraceQueryable pool for skill_manage/skill_view's own writes to
// agent_selfimprove_audit (src/ai/skills/tool.ts). Memory's audit writes go
// through MemoryStore.writeAudit/insertAuditRow on the memory pool; skills
// have no equivalent higher-level store method for a table keyed by
// (user_id, target) — agent_skills is keyed by `name` alone — so
// getSelfSkillTools takes a plain TraceQueryable directly instead. This is
// that queryable: one pool per process, not per request, same
// singleton-by-URL pattern as getSharedLearnedSkillStore
// (src/ai/skills/learnedStore.ts) and the memory pool in
// src/ai/memory/store.ts.
import type { Config } from "../../config.js";
import { createPgPool, type TraceQueryable } from "../../tracing/traceStore.js";

// This pool sits in the hot path of every skill_manage write:
// getSelfSkillTools' `audit()` helper calls insertAuditRow on it from
// directly inside a turn's `execute` (see tool.ts) — same shape as
// MEMORY_POOL_CONNECTION_TIMEOUT_MS / SKILLS_POOL_CONNECTION_TIMEOUT_MS on
// the neighboring pools. pg's own default (no timeout — wait forever) would
// let a saturated Postgres hang the user's turn on a write whose result the
// model doesn't even wait on for the main response, just for the audit row.
const AUDIT_POOL_CONNECTION_TIMEOUT_MS = 5_000;

let shared: { url: string; db: TraceQueryable } | null = null;

export function getSharedAuditDb(config: Config): TraceQueryable | null {
  const url = config.TRACE_DATABASE_URL;
  if (!url) return null;
  if (shared?.url === url) return shared.db;
  if (shared) {
    // A URL change only happens in tests that rebuild Config per case (see
    // learnedStore.ts's getSharedLearnedSkillStore, which has the identical
    // trap) — but without this, the stale pool from the PREVIOUS URL is
    // simply dropped on the floor: nothing ever calls .end() on it, so
    // repeated buildApp() calls in one process (e.g. a test file with many
    // `it`s) leak one pg.Pool per case.
    shared.db.end().catch((err) => {
      console.error("[selfimprove] failed to close previous audit pool:", err);
    });
  }
  const db = createPgPool(url, {
    connectionTimeoutMillis: AUDIT_POOL_CONNECTION_TIMEOUT_MS,
  }) as unknown as TraceQueryable;
  shared = { url, db };
  return db;
}

/** Test-only: drops the module-level singleton pool. */
export function __resetSharedAuditDb(): void {
  shared = null;
}
