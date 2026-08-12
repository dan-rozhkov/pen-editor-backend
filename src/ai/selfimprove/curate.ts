import { z } from "zod";

// Deterministic skills curator (phase 3 of the self-improvement loop). No LLM
// is involved anywhere in this module by design — the spec's non-goals name
// LLM-driven consolidation as the upstream project's worst incident source.
//
// Ageing rule, from the spec's locked Curator section:
//   active, unused >= 30 days (and created >= 30 days ago) -> stale
//   stale,  unused >= 90 days total                        -> archived
// and archived rows are never deleted, only dropped from the catalog (see
// src/ai/skills/learnedStore.ts's listActive, which already excludes
// anything not 'active' — phase 3 doesn't have to touch it). 'stale' rows are
// dropped from the catalog too, but — unlike 'archived' — stay resolvable
// through load_skill: a successful load revives a stale row back to 'active'
// (learnedStore.bumpUse), which is what makes the 30-day stale period an
// actual grace window instead of a name for "already doomed." See the
// bottom of classifySkills' doc comment for why that matters here too.

export const SKILL_STATES = ["active", "stale", "archived"] as const;
export type SkillState = (typeof SKILL_STATES)[number];

export const STALE_AFTER_DAYS = 30;
export const ARCHIVE_AFTER_DAYS = 90;

/** `agent_selfimprove_audit.user_id` is NOT NULL, but learned skills are
 * global (spec: "not per-user"), so a curator run belongs to no user. This
 * sentinel is not a client-generated uuid and cannot collide with one. */
export const CURATOR_AUDIT_USER_ID = "system";

const DAY_MS = 86_400_000;

/** The columns classification needs. Unknown keys are stripped, so the same
 * schema parses rows read with `SELECT *` (which is what the audit snapshot
 * stores) without the extra columns tripping validation. */
export const agentSkillRowSchema = z.object({
  name: z.string(),
  state: z.enum(SKILL_STATES),
  use_count: z.coerce.number().int(),
  last_used_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
});

export type AgentSkillRow = z.infer<typeof agentSkillRowSchema>;

export interface CurateTransition {
  name: string;
  from: SkillState;
  to: SkillState;
  daysUnused: number;
  useCount: number;
}

/** Whole days since the skill was last useful: its `last_used_at`, or its
 * `created_at` when it was never used at all. */
export function daysUnused(row: AgentSkillRow, now: Date): number {
  const since = (row.last_used_at ?? row.created_at).getTime();
  return Math.floor((now.getTime() - since) / DAY_MS);
}

/** Classifies a snapshot of rows read BEFORE any write. One transition per
 * row per run — an `active` skill idle for 200 days becomes `stale` here and
 * `archived` only on a later run, which is what makes every report line
 * exactly one state change. That gap between runs is real grace, not just a
 * label: `load_skill` still resolves a `stale` row (see learnedStore.ts) and
 * revives it to `active` on a successful load, so the only way an
 * erroneously-staled skill avoids archival is to actually be used again
 * before the next run — there is no separate "undo" path, being loaded IS
 * the undo. `use_count`/`view_count` never affect classification itself:
 * recency alone decides whether a skill is dead weight. */
export function classifySkills(rows: AgentSkillRow[], now: Date): CurateTransition[] {
  const transitions: CurateTransition[] = [];

  for (const row of rows) {
    const idle = daysUnused(row, now);

    if (row.state === "active") {
      // A skill created yesterday and never used has idle === its own age —
      // the `created_at` age check is what keeps it out of the sweep instead
      // of being born stale. Age and idle coincide exactly when
      // last_used_at is null, so re-deriving age separately isn't needed.
      const ageDays = Math.floor((now.getTime() - row.created_at.getTime()) / DAY_MS);
      if (idle >= STALE_AFTER_DAYS && ageDays >= STALE_AFTER_DAYS) {
        transitions.push({
          name: row.name,
          from: "active",
          to: "stale",
          daysUnused: idle,
          useCount: row.use_count,
        });
      }
      continue;
    }

    if (row.state === "stale" && idle >= ARCHIVE_AFTER_DAYS) {
      transitions.push({
        name: row.name,
        from: "stale",
        to: "archived",
        daysUnused: idle,
        useCount: row.use_count,
      });
    }

    // 'archived' rows never transition further — there is no unarchive path
    // in this phase (spec: Deferred).
  }

  return transitions;
}

export interface CurateResult {
  /** How many `agent_skills` rows the run looked at. */
  scanned: number;
  /** True when the run was allowed to write (`--apply`). */
  applied: boolean;
  transitions: CurateTransition[];
}

/** The whole stdout report. A run that changes nothing prints an explicit
 * "0 transitions" line — a curator that succeeds silently is indistinguishable
 * from a curator that is broken. */
export function formatCurateReport(result: CurateResult): string {
  const lines: string[] = [];
  const mode = result.applied ? "applying" : "dry run — pass --apply to write";
  lines.push(`[curate] scanned ${result.scanned} learned skill(s) (${mode})`);

  if (result.transitions.length === 0) {
    lines.push("[curate] 0 transitions — no skill qualifies for stale or archived");
    return lines.join("\n");
  }

  const width = Math.max(...result.transitions.map((t) => t.name.length));
  for (const t of result.transitions) {
    lines.push(
      `[curate] ${t.name.padEnd(width)}  ${t.from} → ${t.to}  ${t.daysUnused}d unused, used ${t.useCount}x`,
    );
  }

  const toStale = result.transitions.filter((t) => t.to === "stale").length;
  const toArchived = result.transitions.filter((t) => t.to === "archived").length;
  lines.push(
    `[curate] ${result.transitions.length} transitions: ${toStale} → stale, ${toArchived} → archived`,
  );
  if (!result.applied) {
    lines.push("[curate] nothing was written");
  }
  return lines.join("\n");
}

export interface CurateFlags {
  apply: boolean;
}

const KNOWN_FLAGS = new Set(["--apply", "--dry-run"]);

/** `npm run skills:curate` is read-only unless `--apply` is passed. That is
 * inverted from the usual CLI default on purpose (the spec forbids
 * mutate-by-default), and `--dry-run` is accepted purely so spelling the
 * default out loud is not an error. Unknown arguments throw rather than being
 * ignored: a typo'd flag that silently does something else is exactly the
 * failure mode this CLI cannot afford. */
export function parseCurateFlags(argv: string[]): CurateFlags {
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  }
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply && dryRun) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  return { apply };
}

/** Just enough of `pg.PoolClient` / the PGlite test adapter to run the
 * curator. It must be a single *connection*, not a pool: the whole run is one
 * transaction, and a pool would scatter BEGIN/UPDATE/COMMIT across clients. */
export interface CuratorClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface CurateOptions {
  /** False (the default for the CLI) makes the whole run read-only. */
  apply: boolean;
  /** Injected clock; defaults to wall time. Tests pin it. */
  now?: Date;
}

/** One curation pass. In `apply` mode: reads the whole table under
 * `FOR UPDATE`, classifies it in memory, and writes the pre-mutation
 * snapshot followed by the state updates, all inside a single transaction.
 * In dry-run mode (the default): a plain, lock-free, transaction-less read —
 * see the dedicated comment below for why that split matters.
 *
 * The read is `SELECT *` and the snapshot stores those raw rows: a snapshot
 * that only kept the columns the classifier looks at would not be a snapshot.
 * Classification parses the same rows through a schema that strips the rest.
 *
 * Reading the whole table is deliberate. Learned skills are tens of rows, not
 * millions, and doing the ageing arithmetic in TS against an injected clock is
 * what makes the thresholds testable without freezing the database clock. */
export async function curateSkills(
  client: CuratorClient,
  options: CurateOptions,
): Promise<CurateResult> {
  const now = options.now ?? new Date();

  if (!options.apply) {
    // A dry run must be safe to point at production on a whim. `SELECT ...
    // FOR UPDATE` — even one that never gets to an UPDATE — takes row locks
    // that live until COMMIT/ROLLBACK, which would stall every concurrent
    // `bumpUse`/`bumpView`/`replaceBody` against `agent_skills` for the
    // whole read, for a run that was going to write nothing anyway. Skipping
    // both the lock and the transaction entirely is what makes "dry run" an
    // honest description rather than "same blast radius, no output".
    const { rows } = await client.query(`SELECT * FROM agent_skills ORDER BY name`, []);
    const parsed = rows.map((row) => agentSkillRowSchema.parse(row));
    return { scanned: parsed.length, applied: false, transitions: classifySkills(parsed, now) };
  }

  await client.query("BEGIN");
  try {
    // `[]` (not omitted) matters for the PGlite test adapter: it dispatches
    // "run with the extended/prepared protocol" vs "run with the simple
    // protocol" on whether a params array was passed at all, and only the
    // former returns real row data (see test/pgliteShowcaseHelpers.ts).
    const { rows } = await client.query(
      `SELECT * FROM agent_skills ORDER BY name FOR UPDATE`,
      [],
    );
    // A failed read must abort the write — never rewrite from a view you did
    // not actually read (the spec's concurrency invariant). A parse error
    // throws here, before anything is written, and the catch below rolls back.
    const parsed = rows.map((row) => agentSkillRowSchema.parse(row));
    const transitions = classifySkills(parsed, now);
    // Snapshot value per name, captured from the very rows just classified —
    // this is the "as of the read" state the UPDATE guard below re-checks
    // against, not a value re-read later that could itself have moved.
    const lastUsedAtByName = new Map(parsed.map((row) => [row.name, row.last_used_at]));

    if (transitions.length > 0) {
      // Snapshot BEFORE any UPDATE, same transaction: this is the spec's
      // "snapshot before mutation" invariant, not just good practice — the
      // whole point is that the payload shows the world as it was before
      // this run touched it.
      await client.query(
        `INSERT INTO agent_selfimprove_audit (user_id, origin, subsystem, action, payload)
         VALUES ($1, 'curator', 'skill', 'snapshot', $2::jsonb)`,
        [CURATOR_AUDIT_USER_ID, JSON.stringify(rows)],
      );

      const appliedNames = new Set<string>();
      for (const [target, fromState] of [
        ["stale", "active"],
        ["archived", "stale"],
      ] as const) {
        const group = transitions.filter((t) => t.to === target);
        if (group.length === 0) continue;
        const names = group.map((t) => t.name);
        const lastUsedAts = group.map((t) => lastUsedAtByName.get(t.name) ?? null);
        // Never DELETE, never TRUNCATE — the curator's only write to
        // agent_skills is this state + updated_at UPDATE.
        //
        // Guarded by the row's state AND last_used_at as read in THIS run's
        // snapshot (not just its name): `SELECT ... FOR UPDATE` should make
        // this redundant under real Postgres (a concurrent writer blocks
        // until this transaction commits or rolls back), but the guard is
        // what turns "should be impossible" into "provably can't happen even
        // if a future change weakens the lock, or a test double doesn't
        // model it" — belt-and-suspenders on the same "never rewrite from a
        // view you didn't actually read" invariant the parse-then-throw
        // above already relies on. `IS NOT DISTINCT FROM` (not `=`) is
        // required because `last_used_at` is nullable and `NULL = NULL` is
        // NULL, not true, in SQL.
        const { rows: updated } = await client.query(
          `UPDATE agent_skills AS a
              SET state = $1, updated_at = now()
             FROM unnest($2::text[], $3::timestamptz[]) AS v(name, last_used_at)
            WHERE a.name = v.name
              AND a.state = $4
              AND a.last_used_at IS NOT DISTINCT FROM v.last_used_at
        RETURNING a.name`,
          [target, names, lastUsedAts, fromState],
        );
        for (const { name } of updated as { name: string }[]) {
          appliedNames.add(name);
        }
      }

      // A transition the guard skipped (the row moved between the snapshot
      // read and this run's own UPDATE) is reported as NOT applied — the
      // report must describe what actually landed in the table, not what
      // the snapshot alone would have implied.
      const applied = transitions.filter((t) => appliedNames.has(t.name));
      const skipped = transitions.length - applied.length;
      if (skipped > 0) {
        console.warn(
          `[curate] ${skipped} transition(s) skipped: the row changed after this run's snapshot`,
        );
      }

      await client.query("COMMIT");
      return { scanned: parsed.length, applied: options.apply, transitions: applied };
    }

    await client.query("COMMIT");
    return { scanned: parsed.length, applied: options.apply, transitions };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The connection may already be dead (the usual reason the try block
      // above threw in the first place) — a failed ROLLBACK on top of that
      // is not actionable, and letting it replace `err` below would report
      // "rollback failed" for what was actually a snapshot/UPDATE failure,
      // hiding the real cause. Mirrors LearnedSkillStore.replaceBody's own
      // rollback handling in learnedStore.ts.
      console.error("[curate] rollback failed:", (rollbackErr as Error).message);
    }
    throw err;
  }
}
