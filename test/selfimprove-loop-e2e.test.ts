// End-to-end coverage for the self-improvement loop (memory phase 1 + skills
// phase 2 + the deterministic curator, phase 3), shipped in v0.38.0.
//
// Every piece already has its own unit/integration test (memory-*.test.ts,
// selfskills-*.test.ts, selfimprove-curate-pglite.test.ts, ...), but nothing
// drives the pieces TOGETHER, across several consecutive real HTTP turns
// against a real Postgres engine (PGlite) — which is exactly what would
// expose a stitching bug the per-piece tests can't see (e.g. a store built
// for one subsystem accidentally never wired to the route, or a catalog
// cache not invalidated across the boundary between two subsystems). This
// file is that missing wiring test.
//
// Style/infra borrowed from:
//   - test/memory-chat-route.test.ts   (buildApp + listen + fetch, capturing
//     the exact prompt the mocked provider received)
//   - test/chat-route.test.ts          (scripted MockLanguageModelV3, SSE
//     body assertions)
//   - test/selfskills-review.test.ts   (background review shape)
//   - test/selfimprove-curate-pglite.test.ts (createPgliteHarness, injecting
//     a PGlite pool into the real store factories)
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { createPgliteHarness, type PgliteHarness } from "./pgliteShowcaseHelpers.js";
import { createMemoryStore, type MemoryStore } from "../src/ai/memory/store.js";
import {
  createLearnedSkillStore,
  invalidateLearnedCatalog,
  type LearnedSkillStore,
} from "../src/ai/skills/learnedStore.js";
import { curateSkills, type CuratorClient } from "../src/ai/selfimprove/curate.js";
import type { TraceQueryable } from "../src/tracing/traceStore.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

// createModel always returns whatever the current test has stashed here —
// same "holders" indirection as memory-chat-route.test.ts / chat-route.test.ts,
// required because vi.mock factories are hoisted above normal declarations.
const holders = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

let toolCallSeq = 0;
function toolChunks(toolName: string, input: Record<string, unknown>): LanguageModelV3StreamPart[] {
  toolCallSeq += 1;
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: `call-${toolCallSeq}`,
      toolName,
      input: JSON.stringify(input),
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: USAGE },
  ];
}

type ScriptStep =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: string; input: Record<string, unknown> };

function text(text: string): ScriptStep {
  return { kind: "text", text };
}
function toolCall(toolName: string, input: Record<string, unknown>): ScriptStep {
  return { kind: "tool", toolName, input };
}

function chunksForStep(step: ScriptStep): LanguageModelV3StreamPart[] {
  return step.kind === "text" ? textChunks(step.text) : toolChunks(step.toolName, step.input);
}

// Non-streaming counterpart of chunksForStep: the background review
// (maybeRunReview, src/ai/selfimprove/review.ts) drives the model with
// `generateText`, which calls `doGenerate`, NOT `doStream` — the primary
// chat route uses `streamText`/`doStream`. Both draw from the SAME queue
// below so a single, ordered script can describe a flow that crosses both.
function resultForStep(step: ScriptStep): {
  content: Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; input?: string }>;
  finishReason: { unified: string; raw: string };
  usage: typeof USAGE;
  warnings: never[];
} {
  return {
    content:
      step.kind === "text"
        ? [{ type: "text", text: step.text }]
        : [
            {
              type: "tool-call",
              toolCallId: `call-${(toolCallSeq += 1)}`,
              toolName: step.toolName,
              input: JSON.stringify(step.input),
            },
          ],
    finishReason:
      step.kind === "text"
        ? { unified: "stop", raw: "stop" }
        : { unified: "tool-calls", raw: "tool_calls" },
    usage: USAGE,
    warnings: [],
  };
}

// One model instance, shared for an entire app's lifetime, backed by a
// mutable queue: every AI-SDK "step" (a single doStream/doGenerate call — a
// request can contain several when a tool has a server-side `execute`, since
// the loop then continues in-process) pops the next scripted step. Steps for
// the PRIMARY turn and steps for a background review that turn triggers must
// be pushed onto the queue, in order, before the request that will
// (eventually, possibly asynchronously) consume them — the tests wait for an
// observable DB side effect of the review before issuing the next request,
// which is what keeps this ordering race-free (see the comment above
// `waitForCounters`'s call sites).
function makeScriptedModel(queue: ScriptStep[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => {
      const next = queue.shift();
      if (!next) {
        throw new Error(
          "[test] scripted model queue exhausted (doStream) — a request needed another step but the test didn't script one",
        );
      }
      return { stream: simulateReadableStream({ chunks: chunksForStep(next), chunkDelayInMs: null }) };
    },
    doGenerate: async () => {
      const next = queue.shift();
      if (!next) {
        throw new Error(
          "[test] scripted model queue exhausted (doGenerate) — the background review needed another step but the test didn't script one",
        );
      }
      return resultForStep(next);
    },
  });
}

function userMessage(text: string): Record<string, unknown> {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role: "user", parts: [{ type: "text", text }] };
}

// Represents the frontend's resend of a resolved CLIENT-executed tool call
// (get_editor_state has no `execute`, so the first request ends with a
// pending call and the browser has to run it and resend) — same
// `dynamic-tool` shape prepareChatTurn itself uses to inject a skill's
// instructions (see chatTurn.ts), which is what convertToModelMessages
// expects for "here is a tool result" in a UIMessage.
function resolvedClientToolMessage(toolName: string, output: string): Record<string, unknown> {
  return {
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName,
        toolCallId: `client-${toolName}`,
        state: "output-available",
        input: {},
        output,
      },
    ],
  };
}

async function postChat(url: string, body: unknown): Promise<string> {
  const res = await fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.text();
}

// The system message is always prompt[0] for this codebase's turns (see
// LanguageModelV3Message's `role: 'system'` variant) — plucking it out lets
// prefix comparisons ignore the ever-growing conversation history below it.
function systemOf(call: { prompt: unknown }): string {
  const msg = (call.prompt as Array<{ role: string; content: unknown }>).find(
    (m) => m.role === "system",
  );
  if (!msg || typeof msg.content !== "string") {
    throw new Error("[test] no system message found in captured prompt");
  }
  return msg.content;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

// buildApp's onClose hooks call store.close()/db.end() — harmless when each
// store owns its own pg.Pool, but here all three (memoryStore,
// learnedSkillStore, auditDb) are thin wrappers around the SAME PGlite
// instance via the harness's pool/db. Closing the underlying connection
// three times over would break the harness for the rest of the file (and for
// the curator calls run directly against harness.db after the app is
// otherwise done with it). The harness's own close() in afterAll is the one
// real teardown; app.close() only needs to release the HTTP listener here.
function withNoopClose<T extends { close(): Promise<void> }>(store: T): T {
  return { ...store, close: async () => {} };
}
function withNoopEnd(db: TraceQueryable): TraceQueryable {
  return { ...db, end: async () => {} };
}

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

describe("self-improvement loop — end to end", () => {
  describe("both subsystems enabled", () => {
    let harness: PgliteHarness;
    let memoryStore: MemoryStore;
    let learnedStore: LearnedSkillStore;
    let auditDb: TraceQueryable;
    let app: FastifyInstance;
    let url: string;
    let queue: ScriptStep[];
    let model: MockLanguageModelV3;

    beforeAll(async () => {
      await loadSkills();
      harness = await createPgliteHarness([
        "agent_memory",
        "agent_review_state",
        "agent_skills",
        "agent_selfimprove_audit",
      ]);

      const config = makeConfig({
        MEMORY_ENABLED: true,
        SELF_SKILLS_ENABLED: true,
        // Unused directly (the pool below is injected instead) but required:
        // createMemoryStore's own gate is "config has TRACE_DATABASE_URL",
        // independent of whether a pool was injected — see
        // test/memory-store-pglite.test.ts.
        TRACE_DATABASE_URL: "postgres://unused-pglite-is-injected",
      });

      memoryStore = createMemoryStore(config, harness.pool)!;
      learnedStore = createLearnedSkillStore(config, harness.pool)!;
      auditDb = harness.db;

      queue = [];
      model = makeScriptedModel(queue);
      holders.model = model;

      app = await buildApp(config, {
        logger: false,
        traceStore: null,
        showcaseStore: null,
        memoryStore: withNoopClose(memoryStore),
        learnedSkillStore: withNoopClose(learnedStore),
        auditDb: withNoopEnd(auditDb),
      });
      url = await app.listen({ port: 0, host: "127.0.0.1" });
    });

    afterAll(async () => {
      await app?.close();
      await harness?.close();
    });

    // Polls the real agent_review_state row rather than trusting request
    // timing: bumpCounters runs from the chat route's onFinish, which is not
    // awaited by the response — the HTTP round trip completing does not by
    // itself guarantee the counter write has landed yet.
    async function waitForCounters(userId: string, turns: number, steps: number): Promise<void> {
      await vi.waitFor(async () => {
        const { rows } = await harness.pool.query(
          "SELECT turns_since_memory, steps_since_skill FROM agent_review_state WHERE user_id = $1",
          [userId],
        );
        const row = rows[0] as { turns_since_memory: number; steps_since_skill: number } | undefined;
        expect(row).toBeDefined();
        expect(row!.turns_since_memory).toBe(turns);
        expect(row!.steps_since_skill).toBe(steps);
      });
    }

    async function auditRows(
      userId: string,
    ): Promise<Array<{ origin: string; subsystem: string; action: string }>> {
      const { rows } = await harness.pool.query(
        "SELECT origin, subsystem, action FROM agent_selfimprove_audit WHERE user_id = $1 ORDER BY id",
        [userId],
      );
      return rows as Array<{ origin: string; subsystem: string; action: string }>;
    }

    // ------------------------------------------------------------------
    // Scenario 1+2: memory survives a turn, as a stable prefix, and stays
    // isolated per user.
    // ------------------------------------------------------------------
    it("memory written in one turn is read back in the next, as a stable prefix, and never leaks to another user", async () => {
      const callsBeforeTurn1 = model.doStreamCalls.length;

      // Turn 1: the model saves a fact about the user via the `memory` tool
      // (target 'user'), then replies — a normal completed turn.
      queue.push(
        toolCall("memory", {
          target: "user",
          operations: [{ action: "add", content: "User's name is Zeynep" }],
        }),
        text("Got it, I'll remember your name."),
      );
      const turn1Body = await postChat(url, {
        messages: [userMessage("Please remember my name is Zeynep.")],
        userId: USER_A,
      });
      expect(turn1Body).toContain('"toolName":"memory"');
      expect(turn1Body).toContain("tool-output-available");
      await waitForCounters(USER_A, 1, 2);

      // The system prompt for turn 1's FIRST step was built before the tool
      // ran (the snapshot is read once at the top of prepareChatTurn) — it
      // must not contain "Zeynep" yet.
      const turn1System = systemOf(model.doStreamCalls[callsBeforeTurn1]);
      expect(turn1System).not.toContain("Zeynep");

      // A different user, interleaved between A's write and A's next turn,
      // must not see it either — real per-(user_id, target) rows in
      // Postgres, not a fake keyed loosely enough to leak.
      queue.push(text("Hi! How can I help?"));
      const callsBeforeB = model.doStreamCalls.length;
      await postChat(url, {
        messages: [userMessage("hi")],
        userId: USER_B,
      });
      const systemForB = systemOf(model.doStreamCalls[callsBeforeB]);
      expect(systemForB).not.toContain("Zeynep");

      // Turn 2 (User A, a fresh HTTP request): the snapshot is reloaded, so
      // this system prompt DOES contain "Zeynep".
      queue.push(text("You told me you prefer concise replies. Anything else?"));
      const callsBeforeTurn2 = model.doStreamCalls.length;
      await postChat(url, {
        messages: [userMessage("What do you remember about me?")],
        userId: USER_A,
      });
      await waitForCounters(USER_A, 2, 3);
      const turn2System = systemOf(model.doStreamCalls[callsBeforeTurn2]);
      expect(turn2System).toContain("Zeynep");
      expect(turn2System).toContain("USER PROFILE");

      // "Stable prefix, not a tail": the shared, cacheable part of the
      // system prompt (core instructions + memory guidance + skills
      // catalog — everything BEFORE the per-user snapshot block) must be
      // byte-identical between turn 1 (no memory yet) and turn 2 (memory
      // present) — the snapshot must be the ONLY difference, and it must
      // sit after that shared prefix, not be spliced into the middle of it
      // or duplicated at the very end past canvasContext.
      const shared = commonPrefixLength(turn1System, turn2System);
      expect(shared).toBeGreaterThan(2000); // CORE_PROMPT alone is this long
      expect(turn1System.slice(0, shared)).not.toContain("Zeynep");
      expect(turn2System.slice(0, shared)).not.toContain("Zeynep");
      expect(turn2System.indexOf("Zeynep")).toBeGreaterThanOrEqual(shared);
      // And the divergence starts exactly where the snapshot block begins,
      // not somewhere unrelated (e.g. a skills-catalog difference would be a
      // stitching bug, not a memory one).
      expect(turn2System.slice(shared)).toMatch(/^[\s\S]*USER PROFILE/);
    });

    // ------------------------------------------------------------------
    // Scenario 3: a learned skill survives a turn, appears in the next
    // turn's catalog marked (learned), is resolvable via load_skill, and is
    // visible to a DIFFERENT user (skills are global, not per-user).
    // ------------------------------------------------------------------
    it("a skill created via skill_manage is catalogued, loadable, and shared across users", async () => {
      const skillBody = "# Export Icons\n\nBatch-select every icon layer and export all as SVG in one pass.";

      // Turn 3: create the skill.
      queue.push(
        toolCall("skill_manage", {
          action: "create",
          name: "export-icons",
          description: "Export every icon layer as SVG in one batch",
          body: skillBody,
        }),
        text("Saved that as a skill for next time."),
      );
      const turn3Body = await postChat(url, {
        messages: [userMessage("Remember to batch-export icons as SVG next time.")],
        userId: USER_A,
      });
      expect(turn3Body).toContain('"toolName":"skill_manage"');
      await waitForCounters(USER_A, 3, 5);

      // Turn 4: a fresh turn's catalog includes it, marked (learned), and
      // load_skill actually resolves the body.
      queue.push(toolCall("load_skill", { name: "export-icons" }), text("Loaded it — here's the plan."));
      const callsBeforeTurn4 = model.doStreamCalls.length;
      const turn4Body = await postChat(url, {
        messages: [userMessage("Use that icon export approach.")],
        userId: USER_A,
      });
      await waitForCounters(USER_A, 4, 7);
      const turn4System = systemOf(model.doStreamCalls[callsBeforeTurn4]);
      expect(turn4System).toContain("- `export-icons` — Export every icon layer as SVG in one batch (learned)");
      expect(turn4Body).toContain('"toolName":"load_skill"');
      expect(turn4Body).toContain("tool-output-available");
      expect(turn4Body).toContain("Batch-select every icon layer");

      // Skills are global: a completely different user sees the exact same
      // catalog entry, with no skill_manage call of their own.
      queue.push(text("Sure, I can do that."));
      const callsBeforeB2 = model.doStreamCalls.length;
      await postChat(url, { messages: [userMessage("hi again")], userId: USER_B });
      const systemForB2 = systemOf(model.doStreamCalls[callsBeforeB2]);
      expect(systemForB2).toContain("- `export-icons` — Export every icon layer as SVG in one batch (learned)");
    });

    // ------------------------------------------------------------------
    // Scenario 4+5: the background review fires exactly at threshold (not
    // before), a mid-turn continuation accumulates steps but not turns, the
    // review's write lands in agent_selfimprove_audit with
    // origin='background_review', and GET /api/memory/activity surfaces it
    // (without payload).
    // ------------------------------------------------------------------
    it("the background review runs only once both counters are actually due, and the activity endpoint sees it", async () => {
      // Picks up counters left at (4, 7) by the previous `it` — turns 5-8 are
      // four more ordinary single-step completed turns.
      for (let i = 0; i < 4; i++) {
        queue.push(text(`ok ${i}`));
        // Deliberately sequential (not Promise.all): each turn's counters
        // must land before the next request is sent, since they share the
        // one mutable script queue above.
        await postChat(url, { messages: [userMessage(`message ${i}`)], userId: USER_A });
      }
      await waitForCounters(USER_A, 8, 11);

      // Turn 9 is a genuine mid-turn round trip: the model asks for a
      // CLIENT-executed tool (get_editor_state has no `execute`, so this
      // request ends with a pending call and no reply the user ever saw).
      queue.push(toolCall("get_editor_state", { include_schema: false }));
      await postChat(url, { messages: [userMessage("what's on the canvas?")], userId: USER_A });
      // Mid-turn: steps accumulate (11 -> 12) but turns_since_memory does NOT
      // move (stays 8) — this is the exact bug class turnComplete guards
      // against (see the doc comment on MaybeRunReviewInput in review.ts).
      await waitForCounters(USER_A, 8, 12);

      // The client resends with the resolved tool result — a fresh HTTP
      // request carrying the full history, same as the real frontend.
      queue.push(text("Nothing unusual on the canvas."));
      await postChat(url, {
        messages: [
          userMessage("what's on the canvas?"),
          resolvedClientToolMessage("get_editor_state", "{}"),
        ],
        userId: USER_A,
      });
      await waitForCounters(USER_A, 9, 13);

      // Turn 10 pushes turns_since_memory to 10 (memory due) AND, by making
      // the model call the memory tool twice before its final reply,
      // steps_since_skill to 16 (skill due too) — exercising the "both fired
      // in the same request" combined-review path deliberately, not by
      // accident.
      //
      // The review is fire-and-forget from onFinish and can start consuming
      // the queue before this function even gets to the line after
      // `postChat` below — so its steps MUST already be queued, in order,
      // right behind turn 10's own steps, not pushed afterward. `postChat`
      // resolving only means turn 10's OWN response finished streaming, not
      // that the review (which starts from that same onFinish) has run yet.
      queue.push(
        toolCall("memory", {
          target: "memory",
          operations: [{ action: "add", content: "Users often ask to batch icon exports" }],
        }),
        toolCall("memory", {
          target: "user",
          operations: [{ action: "add", content: "Zeynep asks to batch small repetitive tasks" }],
        }),
        text("Noted both of those."),
        // Review's own generateText call (one memory write, then a closing
        // reply) — queued now, consumed later once the review actually runs.
        toolCall("memory", {
          target: "memory",
          operations: [{ action: "add", content: "Icon-export requests recur — worth a dedicated skill." }],
        }),
        text("Nothing else to save."),
      );
      await postChat(url, { messages: [userMessage("also remember this")], userId: USER_A });
      await waitForCounters(USER_A, 0, 0); // both thresholds fire and reset in the same transaction

      // Wait for the ACTUAL audit row the review's tool call produced, not a
      // fixed delay — the review is still running fire-and-forget at this
      // point, and vi.waitFor is what makes the rest of the test wait for it
      // to actually finish (draining the two queue entries above) before
      // anything else touches the shared model queue.
      await vi.waitFor(async () => {
        const rows = await auditRows(USER_A);
        expect(rows.some((r) => r.origin === "background_review")).toBe(true);
      });

      const rows = await auditRows(USER_A);
      const reviewRows = rows.filter((r) => r.origin === "background_review");
      // Exactly the one write the scripted review model made — proves the
      // review actually ran with a real, working `memory` tool bound to
      // origin 'background_review', not just that SOME row appeared.
      expect(reviewRows).toEqual([{ origin: "background_review", subsystem: "memory", action: "add" }]);

      // GET /api/memory/activity surfaces exactly this event — a UI-facing
      // read of the same row, never the deleted/mutated content itself.
      const before = await fetch(`${url}/api/memory/activity?userId=${USER_A}&sinceId=0`);
      const beforeJson = (await before.json()) as { events: Array<Record<string, unknown>>; latestId: number };
      const reviewEvent = beforeJson.events.find(
        (e) => e.origin === "background_review" && e.subsystem === "memory",
      );
      expect(reviewEvent).toBeDefined();
      expect(reviewEvent).not.toHaveProperty("payload");
      expect(Object.keys(reviewEvent!).sort()).toEqual(["action", "created_at", "id", "origin", "subsystem"]);
    });

    // ------------------------------------------------------------------
    // Scenario 6: the curator ages the skill out of the catalog, but
    // load_skill still resolves it and revives it — closing the loop.
    // ------------------------------------------------------------------
    it("the curator stales an unused skill out of the catalog, and load_skill revives it", async () => {
      const NOW = new Date("2026-09-20T12:00:00.000Z");
      const oldEnough = new Date(NOW.getTime() - 40 * 86_400_000).toISOString();

      // Age the skill created in the earlier `it` directly in Postgres —
      // "50+ real turns to age a row" would be an absurd way to test a
      // deterministic, clock-injected curator; curate.ts is exactly what
      // selfimprove-curate-pglite.test.ts already unit-tests in isolation,
      // so here it's exercised as the CLI would run it, against the row the
      // HTTP turns above actually produced.
      await harness.pool.query(
        "UPDATE agent_skills SET last_used_at = $1, created_at = $1 WHERE name = $2",
        [oldEnough, "export-icons"],
      );

      const result = await curateSkills(harness.db as unknown as CuratorClient, {
        apply: true,
        now: NOW,
      });
      expect(result.transitions).toEqual([
        // useCount is 1, not 0: the earlier `it` already loaded this skill
        // once via load_skill, which bumps use_count on every successful
        // resolution (see learnedStore.ts's bumpUse).
        { name: "export-icons", from: "active", to: "stale", daysUnused: 40, useCount: 1 },
      ]);

      const auditSnapshot = await harness.pool.query(
        "SELECT origin, subsystem, action FROM agent_selfimprove_audit WHERE origin = 'curator'",
        [],
      );
      expect(auditSnapshot.rows).toEqual([{ origin: "curator", subsystem: "skill", action: "snapshot" }]);

      // The curator wrote straight to Postgres, bypassing the app's
      // learnedStore instance — its 30s in-process catalog cache would
      // otherwise still show the pre-curate (active) state on the very next
      // turn. Production hits the same gap between a `npm run skills:curate`
      // run and the next request; skill_manage/skill_view invalidate it on
      // every write they make, but the curator is a separate process in
      // reality and has no such call to make on this shared cache.
      invalidateLearnedCatalog();

      // Next turn: the catalog omits it (stale is excluded exactly like
      // archived — see learnedStore.listActive).
      queue.push(text("Sure."));
      const callsBeforeTurn = model.doStreamCalls.length;
      await postChat(url, { messages: [userMessage("anything new?")], userId: USER_A });
      const systemAfterStale = systemOf(model.doStreamCalls[callsBeforeTurn]);
      expect(systemAfterStale).not.toContain("export-icons");

      // But load_skill still resolves it (the whole point of `stale` being a
      // grace period, not archived-under-a-softer-name) — and doing so
      // revives it back to `active` as a side effect of the load.
      queue.push(toolCall("load_skill", { name: "export-icons" }), text("Using the icon export approach."));
      const revivalBody = await postChat(url, {
        messages: [userMessage("use the icon export approach again")],
        userId: USER_A,
      });
      expect(revivalBody).toContain("Batch-select every icon layer");

      const { rows } = await harness.pool.query(
        "SELECT state FROM agent_skills WHERE name = 'export-icons'",
        [],
      );
      expect((rows[0] as { state: string }).state).toBe("active");

      // And the catalog reflects the revival on the very next turn (the
      // load path's invalidateLearnedCatalog-equivalent is bumpUse, which
      // just writes the row — getLearnedCatalog's cache still needs a fresh
      // read; it was already invalidated above by the earlier call, and the
      // 30s TTL has not been touched since, so re-fetch it explicitly here
      // for the same reason production code has no way around it either:
      // this assertion is about the DB state, not the cache).
      invalidateLearnedCatalog();
      queue.push(text("Yep, still around."));
      const callsBeforeFinal = model.doStreamCalls.length;
      await postChat(url, { messages: [userMessage("is that skill still around?")], userId: USER_A });
      const systemAfterRevival = systemOf(model.doStreamCalls[callsBeforeFinal]);
      expect(systemAfterRevival).toContain("- `export-icons`");
      expect(systemAfterRevival).toContain("(learned)");
    });
  });

  // ------------------------------------------------------------------
  // Scenario 7: both flags off. Stores are wired all the way through (to
  // prove the ABSENCE of writes is because of the flags, not because there
  // was nowhere to write) but must never be touched, and chat must behave
  // exactly as it did before either subsystem existed.
  // ------------------------------------------------------------------
  describe("both flags disabled", () => {
    let harness: PgliteHarness;
    let app: FastifyInstance;
    let url: string;

    beforeAll(async () => {
      await loadSkills();
      harness = await createPgliteHarness([
        "agent_memory",
        "agent_review_state",
        "agent_skills",
        "agent_selfimprove_audit",
      ]);

      const config = makeConfig({
        MEMORY_ENABLED: false,
        SELF_SKILLS_ENABLED: false,
        TRACE_DATABASE_URL: "postgres://unused-pglite-is-injected",
      });
      // createMemoryStore/createLearnedSkillStore don't know about the
      // flags — only app.ts's own factory gate does (see
      // test/app-memory-gate.test.ts) — so wiring live, reachable stores
      // here and then proving they're never queried is a stronger claim
      // than just not passing any store at all.
      const memoryStore = createMemoryStore(config, harness.pool)!;
      const learnedStore = createLearnedSkillStore(config, harness.pool)!;

      holders.model = makeScriptedModel([text("Hello!"), text("Still working."), text("Yep.")]);

      app = await buildApp(config, {
        logger: false,
        traceStore: null,
        showcaseStore: null,
        memoryStore: withNoopClose(memoryStore),
        learnedSkillStore: withNoopClose(learnedStore),
        auditDb: withNoopEnd(harness.db),
      });
      url = await app.listen({ port: 0, host: "127.0.0.1" });
    });

    afterAll(async () => {
      await app?.close();
      await harness?.close();
    });

    it("behaves like a plain chat turn and never touches any of the three tables", async () => {
      for (let i = 0; i < 3; i++) {
        // Sequential by design (single shared model queue), same as above.
        const body = await postChat(url, {
          messages: [userMessage(`message ${i}`)],
          userId: USER_A,
        });
        expect(body).toContain("[DONE]");
      }

      // No fire-and-forget write is still in flight: give the event loop a
      // couple of ticks (no real timer — nothing here is scheduled on one)
      // before asserting the tables are empty.
      await vi.waitFor(() => Promise.resolve(), { timeout: 50 });

      const memory = await harness.pool.query("SELECT count(*)::int AS n FROM agent_memory", []);
      const state = await harness.pool.query("SELECT count(*)::int AS n FROM agent_review_state", []);
      const skills = await harness.pool.query("SELECT count(*)::int AS n FROM agent_skills", []);
      const audit = await harness.pool.query("SELECT count(*)::int AS n FROM agent_selfimprove_audit", []);
      expect((memory.rows[0] as { n: number }).n).toBe(0);
      expect((state.rows[0] as { n: number }).n).toBe(0);
      expect((skills.rows[0] as { n: number }).n).toBe(0);
      expect((audit.rows[0] as { n: number }).n).toBe(0);

      // And the system prompt never advertises either subsystem.
      const model = holders.model as MockLanguageModelV3;
      const system = systemOf(model.doStreamCalls[model.doStreamCalls.length - 1]);
      expect(system).not.toContain("Persistent Memory");
      expect(system).not.toContain("(learned)");
    });

    it("GET /api/memory/activity reports nothing rather than erroring", async () => {
      const res = await fetch(`${url}/api/memory/activity?userId=${USER_A}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ events: [], latestId: null });
    });
  });
});
