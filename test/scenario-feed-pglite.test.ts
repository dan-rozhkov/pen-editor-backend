// Runs the feed's SQL against a real Postgres engine (PGlite), not a JS
// fake: `ANY($1::bigint[])`, the CASE-guarded jsonb write, and the
// user_id/cooldown filtering are exactly the class of thing a hand-rolled
// interpreter would get subtly wrong while real Postgres enforces
// correctly. Reuses the generic harness from test/pgliteShowcaseHelpers.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import {
  fetchDueScenarios,
  markScenariosOffered,
  settleScenarios,
  MAX_SCENARIOS_PER_REVIEW,
} from "../src/ai/selfimprove/scenarioFeed.js";

let harness: PgliteHarness;

beforeAll(async () => {
  harness = await createPgliteHarness(["agent_scenarios"]);
});
afterEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness.close();
});

interface SeedScenario {
  scope: "user" | "global";
  userId?: string | null;
  kind?: string;
  title?: string;
  recipe?: string;
  confirmations?: number;
  sessionIds?: string[];
  state?: string;
  offerCount?: number;
}

async function seed(row: SeedScenario): Promise<number> {
  const { rows } = await harness.db.query(
    `INSERT INTO agent_scenarios
       (scope, user_id, kind, title, recipe, confirmations, session_ids, state, offer_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      row.scope,
      row.userId ?? (row.scope === "user" ? "u1" : null),
      row.kind ?? "correction",
      row.title ?? "starts with questions",
      row.recipe ?? "show a draft first",
      row.confirmations ?? 1,
      row.sessionIds ?? ["s1"],
      row.state ?? "open",
      row.offerCount ?? 0,
    ],
  );
  return Number((rows[0] as { id: number | string }).id);
}

async function stateOf(id: number): Promise<{ state: string; offer_count: number; offered_at: unknown; distilled_into: unknown }> {
  const { rows } = await harness.db.query(
    "SELECT state, offer_count, offered_at, distilled_into FROM agent_scenarios WHERE id = $1",
    [id],
  );
  return rows[0] as { state: string; offer_count: number; offered_at: unknown; distilled_into: unknown };
}

// Backdates a row's offered_at directly with SQL — the cheapest way to place
// it outside the cooldown window without waiting a real hour or reaching
// into fetchDueScenarios' internals.
async function backdateOfferedAt(id: number, msAgo: number): Promise<void> {
  await harness.db.query(
    `UPDATE agent_scenarios SET offered_at = now() - ($2::text || ' milliseconds')::interval WHERE id = $1`,
    [id, String(msAgo)],
  );
}

describe("fetchDueScenarios", () => {
  it("returns only the user's own rows: excludes global rows, other users, below-threshold rows, and terminal states", async () => {
    const mine = await seed({ scope: "user", userId: "u1", confirmations: 3 });
    await seed({ scope: "global", confirmations: 9 }); // global — excluded, see fetchDueScenarios' doc comment
    await seed({ scope: "user", userId: "u2", confirmations: 9 }); // someone else's — excluded
    await seed({ scope: "user", userId: "u1", confirmations: 1 }); // below threshold — excluded
    await seed({ scope: "user", userId: "u1", confirmations: 9, state: "distilled" }); // terminal — excluded
    await seed({ scope: "user", userId: "u1", confirmations: 9, state: "rejected" }); // terminal — excluded

    const due = await fetchDueScenarios(harness.db, "u1", 2);
    expect(due.map((d) => d.id)).toEqual([mine]);
  });

  it("orders by confirmations DESC and caps at MAX_SCENARIOS_PER_REVIEW", async () => {
    await seed({ scope: "user", userId: "u1", confirmations: 2, title: "low" });
    await seed({ scope: "user", userId: "u1", confirmations: 8, title: "high" });
    await seed({ scope: "user", userId: "u1", confirmations: 5, title: "mid" });

    const due = await fetchDueScenarios(harness.db, "u1", 1);
    expect(due).toHaveLength(MAX_SCENARIOS_PER_REVIEW);
    expect(due.map((d) => d.title)).toEqual(["high", "mid"]);
  });

  it("includes 'offered' rows, not just 'open'", async () => {
    const id = await seed({ scope: "user", userId: "u1", confirmations: 4, state: "offered", offerCount: 1 });
    const due = await fetchDueScenarios(harness.db, "u1", 1);
    expect(due.map((d) => d.id)).toContain(id);
    expect(due.find((d) => d.id === id)?.offerCount).toBe(1);
  });

  // Defect: settleScenarios (the thing that flips a row to 'rejected' after
  // its second silent offer) only ever runs on maybeRunReview's SUCCESS
  // path. A row left 'offered' by a timed-out/throwing run (the exact case
  // markScenariosOffered exists to cover — see its call site) never reaches
  // settle, so without a WHERE-clause cap of its own, fetchDueScenarios would
  // keep surfacing an 'offered' row with offer_count climbing 1, 2, 3, ...
  // forever — offered on every single completed turn.
  it("excludes an 'offered' row once it has already been offered the maximum number of times", async () => {
    const id = await seed({ scope: "user", userId: "u1", confirmations: 4, state: "offered", offerCount: 2 });
    const due = await fetchDueScenarios(harness.db, "u1", 1);
    expect(due.map((d) => d.id)).not.toContain(id);
  });

  // Defect 2: a backlog of due scenarios must not fire a full background
  // review on every single consecutive completed turn — offer_count alone
  // only bounds the TOTAL number of offers a row gets, not how close
  // together they can land. The cooldown is keyed on offered_at, which
  // already exists on every row, so no migration is needed.
  describe("cooldown", () => {
    it("returns nothing for a user who was offered a scenario within the cooldown window, regardless of which row", async () => {
      const justOffered = await seed({ scope: "user", userId: "u1", confirmations: 5, title: "already offered" });
      await seed({ scope: "user", userId: "u1", confirmations: 5, title: "a different row entirely" });
      await markScenariosOffered(harness.db, [justOffered]);

      // Same review-worthy user, same call shape as production — a second
      // consecutive completed turn asking "what's due" immediately after an
      // offer must come back empty, not just for the row that was offered,
      // but for the user's whole due set.
      const due = await fetchDueScenarios(harness.db, "u1", 1);
      expect(due).toEqual([]);
    });

    it("returns the due set again once the last offer falls outside the cooldown window", async () => {
      const id = await seed({ scope: "user", userId: "u1", confirmations: 5 });
      await markScenariosOffered(harness.db, [id]);
      await backdateOfferedAt(id, 2 * 60 * 60 * 1000); // 2 hours ago — outside the 1h default cooldown

      const due = await fetchDueScenarios(harness.db, "u1", 1);
      expect(due.map((d) => d.id)).toContain(id);
    });

    it("does not block a different user's due set", async () => {
      const mine = await seed({ scope: "user", userId: "u2", confirmations: 5 });
      const otherUsersRow = await seed({ scope: "user", userId: "u1", confirmations: 5 });
      await markScenariosOffered(harness.db, [otherUsersRow]);

      const due = await fetchDueScenarios(harness.db, "u2", 1);
      expect(due.map((d) => d.id)).toEqual([mine]);
    });
  });
});

describe("markScenariosOffered", () => {
  it("increments offer_count, flips state to 'offered' and stamps offered_at", async () => {
    const id = await seed({ scope: "user", userId: "u1", confirmations: 4, state: "open", offerCount: 0 });
    await markScenariosOffered(harness.db, [id]);
    const row = await stateOf(id);
    expect(row.state).toBe("offered");
    expect(row.offer_count).toBe(1);
    expect(row.offered_at).not.toBeNull();
  });

  it("is a no-op for an empty id list", async () => {
    // Must not throw on `ANY($1::bigint[])` with an empty array binding.
    await expect(markScenariosOffered(harness.db, [])).resolves.toBeUndefined();
  });
});

describe("settleScenarios", () => {
  it("sets 'distilled' and records distilled_into (via + the write tools that fired) when the review wrote something", async () => {
    const id = await seed({ scope: "user", userId: "u1", confirmations: 4, state: "open", offerCount: 0 });
    await markScenariosOffered(harness.db, [id]);
    await settleScenarios(
      harness.db,
      [{ id, kind: "correction", title: "t", recipe: "r", confirmations: 4, offerCount: 0 }],
      true,
      ["memory"],
    );
    const row = await stateOf(id);
    expect(row.state).toBe("distilled");
    expect(row.distilled_into).toMatchObject({ via: "background_review", tools: ["memory"] });
  });

  it("defaults distilled_into.tools to an empty array when no write tool names are passed", async () => {
    const id = await seed({ scope: "user", userId: "u1", confirmations: 4, state: "open", offerCount: 0 });
    await markScenariosOffered(harness.db, [id]);
    await settleScenarios(
      harness.db,
      [{ id, kind: "correction", title: "t", recipe: "r", confirmations: 4, offerCount: 0 }],
      true,
    );
    const row = await stateOf(id);
    expect(row.distilled_into).toMatchObject({ via: "background_review", tools: [] });
  });

  it("keeps a first silent offer alive as 'offered' (markScenariosOffered already set it, settleScenarios is a no-op)", async () => {
    const id = await seed({ scope: "user", userId: "u1", confirmations: 4, state: "open", offerCount: 0 });
    await markScenariosOffered(harness.db, [id]);
    await settleScenarios(harness.db, [{ id, kind: "correction", title: "t", recipe: "r", confirmations: 4, offerCount: 0 }], false);
    const row = await stateOf(id);
    expect(row.state).toBe("offered");
    expect(row.offer_count).toBe(1);
  });

  it("rejects for good on the second silent offer — the anti-loop invariant", async () => {
    const id = await seed({ scope: "user", userId: "u1", confirmations: 4, state: "open", offerCount: 0 });

    // First offer cycle: the row is read (offerCount still pre-increment),
    // THEN marked offered, mirroring maybeRunReview's real call order —
    // settleScenarios must see the pre-increment count to add "the offer
    // that just happened" itself. cooldownMs=0 throughout: this test is
    // about the state machine, not the cooldown (covered separately above),
    // and back-to-back markScenariosOffered calls for the same user would
    // otherwise trip the default cooldown on the second fetchDueScenarios.
    let due = await fetchDueScenarios(harness.db, "u1", 1, MAX_SCENARIOS_PER_REVIEW, 0);
    let row = due.find((d) => d.id === id)!;
    expect(row.offerCount).toBe(0);
    await markScenariosOffered(harness.db, [id]);
    await settleScenarios(harness.db, [row], false);
    expect((await stateOf(id)).state).toBe("offered");

    // Second offer cycle: proposed again, review writes nothing again.
    due = await fetchDueScenarios(harness.db, "u1", 1, MAX_SCENARIOS_PER_REVIEW, 0);
    row = due.find((d) => d.id === id)!;
    expect(row.offerCount).toBe(1);
    await markScenariosOffered(harness.db, [id]);
    await settleScenarios(harness.db, [row], false);
    const finalRow = await stateOf(id);
    expect(finalRow.state).toBe("rejected");

    // A rejected scenario must never be offered a third time.
    const dueAfter = await fetchDueScenarios(harness.db, "u1", 1, MAX_SCENARIOS_PER_REVIEW, 0);
    expect(dueAfter.map((d) => d.id)).not.toContain(id);
  });
});
