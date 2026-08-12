import { describe, expect, it } from "vitest";
import {
  ARCHIVE_AFTER_DAYS,
  STALE_AFTER_DAYS,
  classifySkills,
  curateSkills,
  daysUnused,
  formatCurateReport,
  parseCurateFlags,
  type AgentSkillRow,
  type CuratorClient,
  type CurateResult,
} from "../src/ai/selfimprove/curate.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const DAY_MS = 86_400_000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}

function row(overrides: Partial<AgentSkillRow> & { name: string }): AgentSkillRow {
  return {
    state: "active",
    use_count: 0,
    last_used_at: null,
    created_at: daysAgo(200),
    ...overrides,
  };
}

describe("daysUnused", () => {
  it("counts from last_used_at when the skill has been used", () => {
    expect(daysUnused(row({ name: "a", last_used_at: daysAgo(12) }), NOW)).toBe(12);
  });

  it("falls back to created_at when the skill was never used", () => {
    expect(
      daysUnused(row({ name: "a", last_used_at: null, created_at: daysAgo(7) }), NOW),
    ).toBe(7);
  });
});

describe("classifySkills", () => {
  it("leaves a fresh, never-used skill alone", () => {
    const rows = [row({ name: "fresh", created_at: daysAgo(3) })];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("leaves an old skill alone while it is still being used", () => {
    const rows = [
      row({ name: "in-use", created_at: daysAgo(200), last_used_at: daysAgo(5) }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  // Boundary table around the 30-day stale threshold: 29 (no), 30 (yes,
  // exact boundary), 31 (yes).
  it.each([
    [29, false],
    [30, true],
    [31, true],
  ])("active, unused for %i days -> stale = %s", (days, shouldStale) => {
    const rows = [
      row({ name: "s", created_at: daysAgo(days + 50), last_used_at: daysAgo(days) }),
    ];
    expect(classifySkills(rows, NOW).length).toBe(shouldStale ? 1 : 0);
    if (shouldStale) {
      expect(classifySkills(rows, NOW)[0]).toMatchObject({ from: "active", to: "stale" });
    }
  });

  it("stales an active skill unused for 30+ days", () => {
    const rows = [
      row({ name: "rusty", created_at: daysAgo(80), last_used_at: daysAgo(31), use_count: 4 }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "rusty", from: "active", to: "stale", daysUnused: 31, useCount: 4 },
    ]);
  });

  it("stales an active never-used skill once it is 30+ days old", () => {
    const rows = [row({ name: "stillborn", created_at: daysAgo(31), last_used_at: null })];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "stillborn", from: "active", to: "stale", daysUnused: 31, useCount: 0 },
    ]);
  });

  it("does not stale a never-used skill created fewer than 30 days ago, even if idle >= 30", () => {
    // idle == age here since last_used_at is null — the created_at guard is
    // what stops a fresh (but somehow idle-looking) row from staling early.
    const rows = [row({ name: "too-young", created_at: daysAgo(29), last_used_at: null })];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("does not stale a skill unused for fewer than 30 days", () => {
    const rows = [row({ name: "recent", created_at: daysAgo(90), last_used_at: daysAgo(29) })];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("takes only one step per run — a 200-day-idle active skill goes to stale, not archived", () => {
    const rows = [row({ name: "ancient", created_at: daysAgo(400), last_used_at: daysAgo(200) })];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "ancient", from: "active", to: "stale", daysUnused: 200, useCount: 0 },
    ]);
  });

  // Boundary table around the 90-day archive threshold: 89 (no), 90 (yes,
  // exact boundary), 91 (yes).
  it.each([
    [89, false],
    [90, true],
    [91, true],
  ])("stale, unused for %i days total -> archived = %s", (days, shouldArchive) => {
    const rows = [
      row({
        name: "s",
        state: "stale",
        created_at: daysAgo(days + 100),
        last_used_at: daysAgo(days),
      }),
    ];
    expect(classifySkills(rows, NOW).length).toBe(shouldArchive ? 1 : 0);
    if (shouldArchive) {
      expect(classifySkills(rows, NOW)[0]).toMatchObject({ from: "stale", to: "archived" });
    }
  });

  it("archives a stale skill unused for 90+ days", () => {
    const rows = [
      row({ name: "dead", state: "stale", created_at: daysAgo(400), last_used_at: daysAgo(91) }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "dead", from: "stale", to: "archived", daysUnused: 91, useCount: 0 },
    ]);
  });

  it("archives a stale never-used skill 90+ days after creation", () => {
    const rows = [
      row({ name: "never", state: "stale", created_at: daysAgo(120), last_used_at: null }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([
      { name: "never", from: "stale", to: "archived", daysUnused: 120, useCount: 0 },
    ]);
  });

  it("keeps a stale skill stale below the 90-day mark", () => {
    const rows = [
      row({ name: "resting", state: "stale", created_at: daysAgo(200), last_used_at: daysAgo(45) }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("ignores use_count entirely — popularity does not stop the clock", () => {
    const rows = [
      row({
        name: "once-loved",
        state: "stale",
        use_count: 500,
        created_at: daysAgo(400),
        last_used_at: daysAgo(120),
      }),
    ];
    expect(classifySkills(rows, NOW).map((t) => t.to)).toEqual(["archived"]);
  });

  it("never transitions an already archived skill", () => {
    const rows = [
      row({ name: "gone", state: "archived", created_at: daysAgo(900), last_used_at: daysAgo(800) }),
    ];
    expect(classifySkills(rows, NOW)).toEqual([]);
  });

  it("classifies a mixed table in input order", () => {
    const rows = [
      row({ name: "fresh", created_at: daysAgo(2) }),
      row({ name: "rusty", created_at: daysAgo(80), last_used_at: daysAgo(45) }),
      row({ name: "dead", state: "stale", created_at: daysAgo(400), last_used_at: daysAgo(100) }),
    ];
    expect(classifySkills(rows, NOW).map((t) => [t.name, t.to])).toEqual([
      ["rusty", "stale"],
      ["dead", "archived"],
    ]);
  });

  it("pins the thresholds the spec locks", () => {
    expect(STALE_AFTER_DAYS).toBe(30);
    expect(ARCHIVE_AFTER_DAYS).toBe(90);
  });
});

function result(overrides: Partial<CurateResult> = {}): CurateResult {
  return { scanned: 0, applied: false, transitions: [], ...overrides };
}

describe("formatCurateReport", () => {
  it("says 0 transitions explicitly when nothing qualifies", () => {
    const text = formatCurateReport(result({ scanned: 12 }));
    expect(text).toContain("scanned 12");
    expect(text).toContain("0 transitions");
    expect(text).not.toContain("→");
  });

  it("names the dry run and how to make it write", () => {
    const text = formatCurateReport(result({ scanned: 3 }));
    expect(text).toContain("dry run");
    expect(text).toContain("--apply");
  });

  it("does not claim to be a dry run when applied", () => {
    const text = formatCurateReport(result({ scanned: 3, applied: true }));
    expect(text).not.toContain("dry run");
  });

  it("prints one line per skill with the transition and the idle days", () => {
    const text = formatCurateReport(
      result({
        scanned: 4,
        applied: true,
        transitions: [
          { name: "rusty", from: "active", to: "stale", daysUnused: 31, useCount: 4 },
          { name: "dead", from: "stale", to: "archived", daysUnused: 120, useCount: 0 },
        ],
      }),
    );
    const lines = text.split("\n");
    expect(lines.some((l) => l.includes("rusty") && l.includes("active → stale") && l.includes("31d"))).toBe(true);
    expect(lines.some((l) => l.includes("dead") && l.includes("stale → archived") && l.includes("120d"))).toBe(true);
  });

  it("totals the transitions by target state", () => {
    const text = formatCurateReport(
      result({
        scanned: 9,
        applied: true,
        transitions: [
          { name: "a", from: "active", to: "stale", daysUnused: 40, useCount: 1 },
          { name: "b", from: "active", to: "stale", daysUnused: 50, useCount: 2 },
          { name: "c", from: "stale", to: "archived", daysUnused: 95, useCount: 0 },
        ],
      }),
    );
    expect(text).toContain("3 transitions");
    expect(text).toContain("2 → stale");
    expect(text).toContain("1 → archived");
  });
});

describe("curateSkills wiring (fake CuratorClient — no real DB)", () => {
  function rawRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      name: "rusty",
      state: "active",
      use_count: 0,
      last_used_at: daysAgo(45).toISOString(),
      created_at: daysAgo(200).toISOString(),
      ...overrides,
    };
  }

  // Finding 4: a dry run must be safe to point at production — it should
  // never take a `FOR UPDATE` lock (which lives until COMMIT/ROLLBACK) or
  // even open a transaction, since it was always going to write nothing.
  it("never opens a transaction or takes row locks without --apply", async () => {
    const calls: string[] = [];
    const client: CuratorClient = {
      query: async (sql) => {
        calls.push(sql);
        return { rows: [rawRow()] };
      },
    };

    const result = await curateSkills(client, { apply: false, now: NOW });

    expect(result.transitions).toEqual([{ name: "rusty", from: "active", to: "stale", daysUnused: 45, useCount: 0 }]);
    expect(calls.some((sql) => sql.includes("BEGIN"))).toBe(false);
    expect(calls.some((sql) => sql.includes("FOR UPDATE"))).toBe(false);
    expect(calls.some((sql) => sql.includes("COMMIT"))).toBe(false);
  });

  // Finding 5: `ROLLBACK` itself failing (typically because the connection
  // is already dead — the usual reason the transaction failed in the first
  // place) must not replace the real error with the rollback's error.
  it("propagates the original failure even when the rollback itself also fails", async () => {
    const client: CuratorClient = {
      query: async (sql) => {
        if (sql.startsWith("BEGIN")) return { rows: [] };
        if (sql.includes("SELECT * FROM agent_skills")) return { rows: [rawRow()] };
        if (sql.includes("INSERT INTO agent_selfimprove_audit")) {
          throw new Error("original failure: audit insert boom");
        }
        if (sql.startsWith("ROLLBACK")) {
          throw new Error("rollback also failed: connection is dead");
        }
        return { rows: [] };
      },
    };

    await expect(curateSkills(client, { apply: true, now: NOW })).rejects.toThrow(
      "original failure: audit insert boom",
    );
  });
});

describe("parseCurateFlags", () => {
  it("defaults to a dry run with no flags at all", () => {
    expect(parseCurateFlags([])).toEqual({ apply: false });
  });

  it("mutates only when --apply is given", () => {
    expect(parseCurateFlags(["--apply"])).toEqual({ apply: true });
  });

  it("accepts --dry-run as an explicit spelling of the default", () => {
    expect(parseCurateFlags(["--dry-run"])).toEqual({ apply: false });
  });

  it("rejects --apply together with --dry-run", () => {
    expect(() => parseCurateFlags(["--apply", "--dry-run"])).toThrow(
      /mutually exclusive/,
    );
  });

  it("rejects unknown arguments instead of silently ignoring them", () => {
    expect(() => parseCurateFlags(["--aply"])).toThrow(/unknown argument/);
    expect(() => parseCurateFlags(["--limit=5"])).toThrow(/unknown argument/);
  });
});
