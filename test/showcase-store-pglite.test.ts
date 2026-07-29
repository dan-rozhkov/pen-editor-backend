// `showcase-store.test.ts` runs every `listApps` scenario against `fakePool`
// — a hand-written JS interpreter of the store's own SQL. That's fast and
// gives real ordering/pagination behavior to assert on, but it can only ever
// be as strict as the person who wrote the interpreter: it cannot catch a
// query that is syntactically valid but semantically illegal, which is
// exactly the shape of the `run_id` ambiguity bug this file exists to pin
// (see `docs/superpowers/specs/2026-07-29-showcase-filters-and-likes-design.md`,
// item 1). This suite runs the *real* `listApps` SQL against PGlite — an
// embedded, real Postgres query planner/executor — through the same
// `createShowcaseStore` the app uses, so a regression here means the real
// query is broken, not just this file's model of it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createShowcaseStore, type ShowcaseStore } from "../src/showcase/store.js";
import { makeConfig } from "./helpers.js";
import {
  createPgliteShowcaseHarness,
  type PgliteShowcaseHarness,
} from "./pgliteShowcaseHelpers.js";

interface AppFixture {
  runId: string;
  theme: string;
  likes: number;
  // Day offset from a fixed epoch — turned into a real, distinct
  // `created_at` via a raw UPDATE after insert, since `insertScreen` always
  // writes `now()` and every row in a tight test loop would otherwise land
  // in the same (or a colliding) millisecond.
  day: number;
}

// Five `fitness` apps, two `cooking` apps. Likes deliberately collide twice
// (r2/r4 both at 5, r5/c2 both at 0 — the "group of zeros" item 3 asks for)
// so every ordering also exercises the tie-break, not just the primary key.
const FIXTURE: AppFixture[] = [
  { runId: "00000000-0000-0000-0000-000000000001", theme: "fitness", likes: 1, day: 0 },
  { runId: "00000000-0000-0000-0000-000000000002", theme: "fitness", likes: 5, day: 1 },
  { runId: "00000000-0000-0000-0000-000000000003", theme: "fitness", likes: 3, day: 2 },
  { runId: "00000000-0000-0000-0000-000000000004", theme: "fitness", likes: 5, day: 3 },
  { runId: "00000000-0000-0000-0000-000000000005", theme: "fitness", likes: 0, day: 4 },
  { runId: "00000000-0000-0000-0000-000000000006", theme: "cooking", likes: 10, day: 5 },
  { runId: "00000000-0000-0000-0000-000000000007", theme: "cooking", likes: 0, day: 6 },
];

const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
function createdAtOf(day: number): string {
  return new Date(EPOCH + day * 86_400_000).toISOString();
}

// Mirrors the two ORDER BYs `listApps` actually issues (see store.ts) —
// row-wise ties broken by `run_id DESC`, which for these fixed, same-length,
// lowercase-hex uuids sorts identically to plain string comparison.
function latestOrder(apps: AppFixture[]): AppFixture[] {
  return [...apps].sort((a, b) => b.day - a.day || (a.runId < b.runId ? 1 : -1));
}
function popularOrder(apps: AppFixture[]): AppFixture[] {
  return [...apps].sort(
    (a, b) => b.likes - a.likes || b.day - a.day || (a.runId < b.runId ? 1 : -1),
  );
}

async function seedFixture(store: ShowcaseStore, harness: PgliteShowcaseHarness): Promise<void> {
  for (const app of FIXTURE) {
    await store.insertScreen({
      id: randomUUID(),
      runId: app.runId,
      theme: app.theme,
      title: `${app.theme} screen`,
      prompt: "a screen",
      model: "test-model",
      imageUrl: `https://cdn.test/${app.runId}.png`,
      htmlUrl: `https://cdn.test/${app.runId}.html`,
      width: 390,
      height: 844,
    });
    await harness.db.query("UPDATE showcase_screens SET created_at = $1 WHERE run_id = $2", [
      createdAtOf(app.day),
      app.runId,
    ]);
    if (app.likes > 0) {
      await store.likeApp(app.runId, app.likes);
    }
  }
}

describe("showcase store against a real Postgres engine (PGlite)", () => {
  let harness: PgliteShowcaseHarness;
  let store: ShowcaseStore;

  beforeAll(async () => {
    harness = await createPgliteShowcaseHarness();
    store = createShowcaseStore(makeConfig({ TRACE_DATABASE_URL: "postgres://x" }), harness.db)!;
  }, 30_000);

  afterEach(async () => {
    await harness.reset();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe("listApps: sort x category x cursor", () => {
    const combos: Array<{
      sort: "popular" | "latest";
      category?: string;
      useCursor: boolean;
    }> = [];
    for (const sort of ["popular", "latest"] as const) {
      for (const category of [undefined, "fitness"]) {
        for (const useCursor of [false, true]) {
          combos.push({ sort, category, useCursor });
        }
      }
    }
    expect(combos).toHaveLength(8);

    it.each(combos)(
      "sort=$sort category=$category cursor=$useCursor returns the right apps in the right order",
      async ({ sort, category, useCursor }) => {
        await seedFixture(store, harness);
        const matching = category ? FIXTURE.filter((a) => a.theme === category) : FIXTURE;
        const expected = (sort === "latest" ? latestOrder : popularOrder)(matching).map(
          (a) => a.runId,
        );

        if (!useCursor) {
          // limit past the end of the matching set so `nextCursor` is
          // unambiguously null rather than "maybe more, maybe not".
          const { apps, nextCursor } = await store.listApps({
            limit: expected.length + 1,
            sort,
            category,
          });
          expect(apps.map((a) => a.runId)).toEqual(expected);
          expect(nextCursor).toBeNull();
          return;
        }

        // Page through 2 apps at a time and confirm the concatenation is an
        // exact, non-duplicated prefix of the expected order — this is the
        // combination the code review flagged as untested (category *and*
        // cursor together), and the one that exercises the `AND theme = $n`
        // clause sitting in the same subquery as the cursor's `HAVING`.
        const page1 = await store.listApps({ limit: 2, sort, category });
        expect(page1.apps.map((a) => a.runId)).toEqual(expected.slice(0, 2));

        if (expected.length <= 2) {
          expect(page1.nextCursor).toBeNull();
          return;
        }
        expect(page1.nextCursor).not.toBeNull();

        const page2 = await store.listApps({
          limit: 2,
          sort,
          category,
          cursor: page1.nextCursor!,
        });
        expect(page2.apps.map((a) => a.runId)).toEqual(expected.slice(2, 4));
      },
    );
  });

  it("walks the full popular-sorted feed in pages of 2 with no dupes or drops, across a tie and a zero group", async () => {
    await seedFixture(store, harness);
    const expected = popularOrder(FIXTURE).map((a) => a.runId);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const { apps, nextCursor } = await store.listApps({ limit: 2, sort: "popular", cursor });
      seen.push(...apps.map((a) => a.runId));
      if (!nextCursor) break;
      cursor = nextCursor;
    }

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  it("recentRunHtmlUrls collapses each run to one screen, freshest run first", async () => {
    // Real engine, not fakePool: `DISTINCT ON` requires its expression to lead
    // the ORDER BY, so the recency ordering has to sit in an outer query. A
    // hand-written SQL interpreter would happily accept the illegal version.
    await seedFixture(store, harness);
    // A real run publishes up to 5 screens; the fixture gives each run one, so
    // add a second to the newest run to prove the collapse actually happens.
    const newestRun = latestOrder(FIXTURE)[0];
    const extraId = randomUUID();
    await store.insertScreen({
      id: extraId,
      runId: newestRun.runId,
      theme: newestRun.theme,
      title: "second screen",
      prompt: "a screen",
      model: "test-model",
      imageUrl: `https://cdn.test/${extraId}.png`,
      htmlUrl: `https://cdn.test/${extraId}.html`,
      width: 390,
      height: 844,
    });

    const urls = await store.recentRunHtmlUrls(3);
    const newest = latestOrder(FIXTURE).slice(0, 3);
    expect(urls).toHaveLength(3);
    // The extra screen is the freshest row in the gallery, so its run leads —
    // represented once, by that newest screen.
    expect(urls[0]).toBe(`https://cdn.test/${extraId}.html`);
    expect(urls.slice(1)).toEqual(newest.slice(1).map((a) => `https://cdn.test/${a.runId}.html`));
  });

  it("listCategories reports every theme with at least one published app, ordered by app count", async () => {
    await seedFixture(store, harness);
    const categories = await store.listCategories();
    expect(categories).toEqual([
      { theme: "fitness", apps: 5 },
      { theme: "cooking", apps: 2 },
    ]);
  });

  describe("likeApp", () => {
    it("upserts on first like and increments on repeat likes", async () => {
      await seedFixture(store, harness);
      const runId = FIXTURE[0].runId; // seeded with likes: 1
      const afterFirst = await store.likeApp(runId, 4);
      expect(afterFirst).toBe(5); // 1 (seed) + 4
      const afterSecond = await store.likeApp(runId, 10);
      expect(afterSecond).toBe(15);
    });

    it("returns null for a run with no published screens", async () => {
      await seedFixture(store, harness);
      const result = await store.likeApp(randomUUID(), 1);
      expect(result).toBeNull();
    });
  });

  describe("platform filtering", () => {
    it("reads pre-migration rows with no explicit platform back as mobile", async () => {
      // Simulates a row inserted before migration 008 added the column —
      // relies on the column's own DB DEFAULT 'mobile' rather than on
      // insertScreen passing a value, which is exactly the scenario the
      // migration exists to make safe.
      const runId = randomUUID();
      const id = randomUUID();
      await harness.db.query(
        `INSERT INTO showcase_screens
           (id, run_id, theme, title, prompt, model, image_url, html_url, width, height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          runId,
          "legacy theme",
          "Legacy screen",
          "a screen",
          "test-model",
          "https://cdn.test/legacy.png",
          "https://cdn.test/legacy.html",
          390,
          844,
        ],
      );

      const { apps } = await store.listApps({ limit: 20, platform: "mobile" });
      const app = apps.find((a) => a.runId === runId);
      expect(app?.platform).toBe("mobile");
    });

    it("never mixes mobile and desktop apps in the same page, and paginates a filtered feed correctly", async () => {
      const mobileRuns = FIXTURE.map((f) => f.runId);
      const desktopRuns = Array.from({ length: 4 }, () => randomUUID());

      for (let i = 0; i < desktopRuns.length; i++) {
        const id = randomUUID();
        await store.insertScreen({
          id,
          runId: desktopRuns[i],
          theme: "analytics dashboard",
          title: "Desktop screen",
          prompt: "a screen",
          model: "test-model",
          imageUrl: `https://cdn.test/${desktopRuns[i]}.png`,
          htmlUrl: `https://cdn.test/${desktopRuns[i]}.html`,
          width: 1440,
          height: 1024,
          platform: "desktop",
        });
        // Distinct, increasing created_at so ordering (and pagination) is
        // deterministic, same trick `seedFixture` uses for the mobile fixture.
        await harness.db.query("UPDATE showcase_screens SET created_at = $1 WHERE id = $2", [
          createdAtOf(100 + i),
          id,
        ]);
      }
      await seedFixture(store, harness);

      // Every mobile app must be invisible to a desktop-filtered page, and
      // vice versa.
      const mobilePage = await store.listApps({
        limit: 20,
        sort: "latest",
        platform: "mobile",
      });
      expect(mobilePage.apps.map((a) => a.runId).sort()).toEqual([...mobileRuns].sort());
      expect(mobilePage.apps.every((a) => a.platform === "mobile")).toBe(true);

      const desktopPage = await store.listApps({
        limit: 20,
        sort: "latest",
        platform: "desktop",
      });
      expect(desktopPage.apps.map((a) => a.runId).sort()).toEqual([...desktopRuns].sort());
      expect(desktopPage.apps.every((a) => a.platform === "desktop")).toBe(true);

      // Second page of a filtered, cursor-paginated feed — the exact shape
      // the repo has previously shipped broken (an ambiguous run_id after a
      // JOIN, or a page boundary splitting an app), now exercised with the
      // platform filter active.
      const expectedDesktopOrder = [...desktopRuns].sort(
        (a, b) => desktopRuns.indexOf(b) - desktopRuns.indexOf(a),
      );
      const page1 = await store.listApps({ limit: 2, sort: "latest", platform: "desktop" });
      expect(page1.apps.map((a) => a.runId)).toEqual(expectedDesktopOrder.slice(0, 2));
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await store.listApps({
        limit: 2,
        sort: "latest",
        platform: "desktop",
        cursor: page1.nextCursor!,
      });
      expect(page2.apps.map((a) => a.runId)).toEqual(expectedDesktopOrder.slice(2, 4));
      // Never a mobile app leaking into a desktop-filtered second page.
      expect(page2.apps.every((a) => a.platform === "desktop")).toBe(true);
    });
  });
});
