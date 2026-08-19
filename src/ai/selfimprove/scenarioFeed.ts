import type { TraceQueryable } from "../../tracing/traceStore.js";

/** Attribution of a save is per RUN, not per scenario (the review has no way
 * to say which one it acted on — see the spec's attribution table). Offering
 * at most two is what keeps that attribution honest. */
export const MAX_SCENARIOS_PER_REVIEW = 2;

/** The anti-loop invariant lives in exactly one place: a scenario is offered
 * at most this many times before nextScenarioState retires it as 'rejected'.
 * fetchDueScenarios ALSO filters on this (offer_count < MAX_OFFERS) — not
 * just on state — because settleScenarios (the thing that actually flips the
 * row to 'rejected') only runs on the success path of maybeRunReview. A
 * timed-out or throwing review run (the exact case markScenariosOffered
 * exists to cover — see its call site's comment) never reaches settle, so a
 * provider that reliably hangs on a given prompt would otherwise leave the
 * row 'offered' forever: offer_count climbing 1, 2, 3, ... while the row
 * stays due on every single completed turn, re-running the full background
 * generateText call each time. The WHERE-clause cap makes the row stop
 * being due the moment it's been offered MAX_OFFERS times, independent of
 * whether anything ever settled it. */
const MAX_OFFERS = 2;

/** Minimum gap between two scenario-carrying reviews for the SAME user.
 * offer_count alone does not bound FREQUENCY, only total count: with N
 * scenarios queued and MAX_SCENARIOS_PER_REVIEW = 2, turn 1 offers the first
 * two (offer_count -> 1, still due), turn 2 offers the same two again
 * (offer_count -> 2, now retired), turn 3 offers the next two, and so on —
 * every one of N/2 consecutive completed turns runs a full background
 * generateText (up to DEFAULT_REVIEW_TIMEOUT_MS = 90s) purely because a
 * backlog existed, independent of MEMORY_REVIEW_INTERVAL /
 * SKILL_REVIEW_INTERVAL, which exist precisely to prevent that shape of
 * cost. `offered_at` already exists on every row (stamped by
 * markScenariosOffered) and needs no migration to double as the cooldown
 * clock: fetchDueScenarios refuses to surface ANYTHING for a user who was
 * offered a scenario more recently than this, regardless of which row it
 * was. One hour is long enough to not fight a normal multi-session-per-day
 * cadence while still cutting an N-turn backlog down to roughly one review
 * per hour. */
export const SCENARIO_OFFER_COOLDOWN_MS = 60 * 60 * 1000;

export interface DueScenario {
  id: number;
  kind: string;
  title: string;
  recipe: string;
  confirmations: number;
  offerCount: number;
}

/** Scenarios this user should be shown in a background review: THEIR OWN
 * rows only (`scope = 'user'`, i.e. `user_id = $1` — a global row's
 * `user_id` is NULL, so filtering on it excludes global rows without an
 * explicit `scope` check). Ordered by confirmations so the best-evidenced
 * pattern wins the two slots, and gated on a per-user cooldown so a queued
 * backlog can't fire a review on every consecutive turn (see
 * SCENARIO_OFFER_COOLDOWN_MS above).
 *
 * The global pool (rows mined from unattributed sessions, `scope = 'global'`)
 * keeps accumulating exactly as before — it is still visible in the
 * analysis report and via direct SQL — it is just never fed into a review's
 * prompt. Reason: renderScenarioBlock inserts a row's title/recipe verbatim
 * into a specific user's review message, and if that review then writes
 * something, the write lands in THAT user's agent_memory. scrubPii strips
 * identifiers out of the mined text, but it cannot strip an INSTRUCTION — a
 * global row is, by definition, evidence with no confirmed single owner, so
 * there is no user it is safe to hand it to as if it were their own history.
 * (This also retires the previous "global rows retire per-row, not
 * per-user" limitation: since global rows are never fetched here anymore,
 * markScenariosOffered/settleScenarios below never run against one from this
 * code path, so the multi-user offer-count concern they used to carry does
 * not apply.) */
export async function fetchDueScenarios(
  db: TraceQueryable,
  userId: string,
  threshold: number,
  limit: number = MAX_SCENARIOS_PER_REVIEW,
  cooldownMs: number = SCENARIO_OFFER_COOLDOWN_MS,
): Promise<DueScenario[]> {
  // Single round-trip: the NOT EXISTS subquery checks whether THIS user was
  // offered anything (any of their own rows, regardless of which one) more
  // recently than the cooldown window, and the outer query only runs the
  // real selection when that comes back empty. Computed here (not with a
  // `now() - interval` literal in SQL) so the cutoff is one JS Date, easy to
  // control from a test by writing a past `offered_at` instead of needing a
  // tiny cooldown constant.
  const cooldownCutoff = new Date(Date.now() - cooldownMs);
  const result = (await db.query(
    `SELECT s.id, s.kind, s.title, s.recipe, s.confirmations, s.offer_count
       FROM agent_scenarios s
      WHERE s.state IN ('open','offered')
        AND s.confirmations >= $2
        AND s.offer_count < $4
        AND s.user_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM agent_scenarios cooldown
           WHERE cooldown.user_id = $1
             AND cooldown.offered_at IS NOT NULL
             AND cooldown.offered_at > $5::timestamptz
        )
      ORDER BY s.confirmations DESC, s.id
      LIMIT $3`,
    [userId, threshold, limit, MAX_OFFERS, cooldownCutoff.toISOString()],
  )) as { rows: Array<Record<string, unknown>> };
  return result.rows.map((r) => ({
    id: Number(r.id),
    kind: String(r.kind),
    title: String(r.title),
    recipe: String(r.recipe),
    confirmations: Number(r.confirmations),
    offerCount: Number(r.offer_count),
  }));
}

/** Evidence, not instruction: the block states what recurred and how often,
 * and leaves the save/decline decision to the review prompt that precedes
 * it. Goes into the review's USER message — never the system prompt, which
 * is reused verbatim to keep the provider prefix cache warm.
 *
 * Deliberately does NOT say "your past sessions": even though fetchDueScenarios
 * now only ever returns this user's own rows (see its doc comment on why
 * scope='global' evidence is excluded), "past sessions" without a possessive
 * still reads naturally and costs nothing to keep — no reason to reintroduce
 * a possessive that would need to be walked back again if the source set
 * ever changes. */
export function renderScenarioBlock(rows: DueScenario[]): string {
  if (rows.length === 0) return "";
  const items = rows.map(
    (r) => `[S-${r.id} · ${r.kind} · seen in ${r.confirmations} separate sessions]\n${r.title}\n→ ${r.recipe}`,
  );
  return [
    "Recurring patterns mined from past sessions (evidence, not guesses — each was observed in several separate sessions):",
    ...items,
  ].join("\n\n");
}

/** The state machine's only decision point, kept pure so the anti-loop
 * invariant is testable without a database: a scenario is offered at most
 * twice, and a second silent offer retires it for good. `offerCount` is the
 * value AFTER markScenariosOffered incremented it. */
export function nextScenarioState(
  offerCount: number,
  wrote: boolean,
): "distilled" | "offered" | "rejected" {
  if (wrote) return "distilled";
  return offerCount >= MAX_OFFERS ? "rejected" : "offered";
}

// Mutates the row by id, not a per-user offer record — fine now that
// fetchDueScenarios only ever returns `scope = 'user'` rows (one owner per
// row by construction), so "the row's offer state" and "this user's offer
// state" are the same thing. Would need a join table keyed on
// (scenario_id, user_id) if global rows were ever fed back into this path.
export async function markScenariosOffered(db: TraceQueryable, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE agent_scenarios
        SET state = 'offered', offer_count = offer_count + 1, offered_at = now()
      WHERE id = ANY($1::bigint[])`,
    [ids],
  );
}

// Same per-row addressing as markScenariosOffered — fine for the same
// reason: only `scope = 'user'` rows ever reach this function now, and each
// belongs to exactly one user.
//
// `writeToolNames` is the caller's `calledTools` filtered down to the ones
// that actually write (REVIEW_WRITE_TOOLS in review.ts), e.g. ["memory"] or
// ["skill_manage"]. It only matters when `wrote` is true — a decline never
// touches `distilled_into`. Before this, `distilled_into` recorded the fixed
// literal `{"via":"background_review"}` on every distill, which said WHO
// distilled the scenario (the background review, as opposed to a foreground
// turn) but nothing about WHAT it turned into — so the spec's promised
// drill-down from a scenario to the memory entry or skill it became had no
// data to walk. The run already knows which write tool(s) fired (it has to,
// to compute `wrote` itself), so this just carries that same information one
// call further instead of collapsing it into a constant.
export async function settleScenarios(
  db: TraceQueryable,
  rows: DueScenario[],
  wrote: boolean,
  writeToolNames: string[] = [],
): Promise<void> {
  const distilledInto = JSON.stringify({ via: "background_review", tools: writeToolNames });
  for (const row of rows) {
    // offerCount here is pre-increment (the row was read before the offer),
    // so add the offer that just happened.
    const state = nextScenarioState(row.offerCount + 1, wrote);
    if (state === "offered") continue; // already set by markScenariosOffered
    await db.query(
      `UPDATE agent_scenarios
          SET state = $2,
              distilled_into = CASE WHEN $2 = 'distilled' THEN $3::jsonb ELSE distilled_into END
        WHERE id = $1`,
      [row.id, state, distilledInto],
    );
  }
}
