import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { loadSkills, getSkill } from "../src/ai/skills.js";
import { resetSkillRouteCacheForTests } from "../src/ai/skillRouting.js";
import type {
  SystemOneAnswer,
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneQuestion,
} from "../src/services/systemone.js";
import type { UserSkill, UserSkillStore } from "../src/ai/skills/userStore.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

// getSkill's real behavior is used everywhere EXCEPT the one test below that
// simulates a catalog/lookup-store mismatch (a name routeSkill legitimately
// picked no longer resolving). That test flips this flag for its duration
// only — every other test gets the real, unmodified getSkill.
const getSkillForcedMiss = vi.hoisted(() => ({ enabled: false }));
vi.mock("../src/ai/skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/skills.js")>();
  return {
    ...actual,
    getSkill: (...args: Parameters<typeof actual.getSkill>) =>
      getSkillForcedMiss.enabled ? undefined : actual.getSkill(...args),
  };
});

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

// A fake SystemOneClient that plays BOTH of routeSkill's two passes,
// distinguishing them by the question keys it was asked ("gate::..." only
// appears in pass 1, "fits::..." only in pass 2) — real candidate names
// come from the actually-loaded skill catalog on disk, so this deliberately
// doesn't hardcode them.
function makeStagedJevClient(opts: {
  pass1Winner?: string;
  pass1Probabilities?: Record<string, number>;
  pass1Confidence?: number;
  gate?: Partial<Record<"documented_workflow" | "substantial_new_work" | "direct_edit_suffices", number>>;
  pass2Winner?: string;
  pass2Confidence?: number;
  /** Peak-probability distribution for pass 2's winning Choice answer — the
   * value the winner gate actually reads (round-3 review: the gate moved
   * off the vendor `confidence` field to this). Defaults to
   * `{ [winner]: confidence }` so existing callers that don't care about
   * peak/confidence diverging keep the same effective gate value as before. */
  pass2Probabilities?: Record<string, number>;
  fits?: Record<string, number>;
  defaultFits?: number;
  calls?: { count: number };
  capture?: (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>, pass: 1 | 2) => void;
} = {}): SystemOneClient {
  const gate = { documented_workflow: 0.9, substantial_new_work: 0.9, direct_edit_suffices: 0.1, ...opts.gate };
  return {
    async evaluate(params) {
      if (opts.calls) opts.calls.count += 1;
      const isPass1 = Object.keys(params.questions).some((k) => k.startsWith("gate::"));
      const answers: Record<string, SystemOneAnswer> = {};
      if (isPass1) {
        opts.capture?.(params, 1);
        answers.which = {
          type: "choice",
          choice: opts.pass1Winner ?? "prototype",
          probabilities: opts.pass1Probabilities ?? { prototype: 0.95, slides: 0.05 },
          confidence: opts.pass1Confidence ?? 0.95,
        };
        for (const key of Object.keys(params.questions)) {
          if (!key.startsWith("gate::")) continue;
          const name = key.slice("gate::".length) as keyof typeof gate;
          answers[key] = { type: "noul", noul: gate[name] ?? 0.9 };
        }
      } else {
        opts.capture?.(params, 2);
        const pass2Winner = opts.pass2Winner ?? opts.pass1Winner ?? "prototype";
        const pass2Confidence = opts.pass2Confidence ?? 0.95;
        answers.which = {
          type: "choice",
          choice: pass2Winner,
          probabilities: opts.pass2Probabilities ?? { [pass2Winner]: pass2Confidence },
          confidence: pass2Confidence,
        };
        for (const key of Object.keys(params.questions)) {
          if (!key.startsWith("fits::")) continue;
          const name = key.slice("fits::".length);
          answers[key] = { type: "noul", noul: opts.fits?.[name] ?? opts.defaultFits ?? 0.9 };
        }
      }
      return {
        model: "jev-latest",
        answers,
        usage: { input_tokens: 10, output_tokens: 1 },
      } as never;
    },
  };
}

// The tail of a tool-loop continuation request: the browser resent the full
// history after running a client-executed tool, so the LAST message is an
// assistant tool-call/result, not the user message. See lastUserIndex's
// comment in chatTurn.ts.
function assistantToolResultMessage(): Record<string, unknown> {
  return {
    id: "a-mid",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: "call-mid-1",
        toolName: "get_editor_state",
        state: "output-available",
        input: {},
        output: "{}",
      },
    ],
  };
}

const baseUserSkill: UserSkill = {
  userId: "u1",
  name: "mysk",
  description: "a disabled custom skill",
  body: "DISABLED CUSTOM BODY",
  enabled: false,
  source: "manual",
  useCount: 0,
  lastUsedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// Minimal in-memory UserSkillStore double — only `get`/`bumpUse` are
// exercised by the slash-command path this test drives.
function fakeUserSkillStore(initial: UserSkill[]): UserSkillStore {
  const skills = initial.map((s) => ({ ...s }));
  return {
    async list(userId) {
      return skills.filter((s) => s.userId === userId);
    },
    async listEnabled(userId) {
      return skills.filter((s) => s.userId === userId && s.enabled);
    },
    async get(userId, name) {
      return skills.find((s) => s.userId === userId && s.name === name) ?? null;
    },
    async create(input) {
      const created: UserSkill = { ...baseUserSkill, ...input, enabled: true };
      skills.push(created);
      return created;
    },
    async update() {
      return null;
    },
    async remove() {
      return false;
    },
    async bumpUse(userId, name) {
      const found = skills.find((s) => s.userId === userId && s.name === name);
      if (found) found.useCount += 1;
    },
    async count(userId) {
      return skills.filter((s) => s.userId === userId).length;
    },
    async close() {},
  };
}

describe("prepareChatTurn — Jev skill routing", () => {
  // See the note in skill-routing.test.ts: routeSkill's memo is
  // module-level and would otherwise carry verdicts between tests.
  beforeEach(() => resetSkillRouteCacheForTests());

  beforeAll(async () => {
    await loadSkills();
    expect(getSkill("prototype")).toBeDefined();
  });

  it("does not call Jev when an explicit slash command already resolved a skill", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = makeStagedJevClient({ calls });

    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/prototype a login screen")],
      systemOneClient: client,
    });

    expect(calls.count).toBe(0);
  });

  it("shadow mode does not inject the synthetic lookup_skill pair", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const client = makeStagedJevClient();

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "shadow" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: client,
    });

    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
  });

  it("enforce mode injects the synthetic lookup_skill pair for a confident pick", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const client = makeStagedJevClient();

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: client,
    });

    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).toContain("lookup_skill");
    expect(injected).toContain("Agent Mode: prototype");
  });

  it("off mode never calls Jev", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = makeStagedJevClient({ calls });

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "off" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: client,
    });

    expect(calls.count).toBe(0);
    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
  });

  it("enforce-mode pick resolves the FIR-45 embed-only task policy, not just the injection", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const client = makeStagedJevClient();

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: client,
    });

    // The regression this guards: an enforce-mode pick used to set
    // skillContent (so the model sees "Agent Mode: prototype") without ever
    // setting slashSkillName, so resolveTaskPolicy stayed "native" and
    // batch_design was NOT swapped for the embed-only variant.
    expect(turn.taskPolicy).toBe("prototype");
  });

  it("does not auto-pick at all when the slash command names a real-but-disabled user skill", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = makeStagedJevClient({ calls });
    const store = fakeUserSkillStore([baseUserSkill]);

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/mysk please do the thing")],
      userId: "u1",
      userSkillStore: store,
      systemOneClient: client,
    });

    // Jev must never be consulted for this message — the disabled skill is
    // deliberately unresolvable, and auto-picking a DIFFERENT curated skill
    // here would be a back door around that.
    expect(calls.count).toBe(0);
    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
    expect(injected).not.toContain("DISABLED CUSTOM BODY");
  });

  it("routes Jev on the stripped text when the slash token doesn't resolve to any skill", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = makeStagedJevClient({
      capture: (params, pass) => {
        if (pass === 1) captured = params;
      },
    });

    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/Users/me/shot.png make this a clickable prototype")],
      systemOneClient: client,
    });

    // The slash-shaped token itself must not leak into what Jev sees.
    const request = (captured?.state as { request: string })?.request;
    expect(request).not.toContain("/Users/me/shot.png");
    expect(request).toContain("make this a clickable prototype");
  });

  // Finding #9: an AI SDK v6 assistant message can be split into SEVERAL
  // "text" parts around a tool call. extractMessageText used to read only
  // the FIRST one, so recent_context got only an opening fragment of a
  // reasoning-then-tool-call-then-more-reasoning assistant turn.
  it("joins ALL text parts of a message into recent_context, not just the first", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = makeStagedJevClient({
      capture: (params, pass) => {
        if (pass === 1) captured = params;
      },
    });

    const splitAssistantMessage = {
      role: "assistant",
      parts: [
        { type: "text", text: "FIRST-FRAGMENT-before-the-tool-call" },
        {
          type: "dynamic-tool",
          toolCallId: "call-1",
          toolName: "get_editor_state",
          state: "output-available",
          input: {},
          output: "{}",
        },
        { type: "text", text: "SECOND-FRAGMENT-after-the-tool-call" },
      ],
    };

    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [
        userMessage("design a login screen"),
        splitAssistantMessage,
        userMessage("now do the same for the signup screen"),
      ],
      systemOneClient: client,
    });

    const recentContext = (captured?.state as { recent_context: string })?.recent_context;
    expect(recentContext).toContain("FIRST-FRAGMENT-before-the-tool-call");
    expect(recentContext).toContain("SECOND-FRAGMENT-after-the-tool-call");
  });

  it("keeps a slash-command skill AND the FIR-45 task policy alive across a tool-loop continuation", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "off" }),
      messages: [userMessage("/prototype a login screen"), assistantToolResultMessage()],
    });

    // Regression: keying off messages[messages.length - 1] (the assistant
    // tail) instead of the last USER message meant the slash command was
    // never even looked at from step 2 of a tool loop onward — no
    // injection at all, and resolveTaskPolicy fell back to "native"
    // mid-prototype since nothing else in history satisfies it.
    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).toContain("lookup_skill");
    expect(turn.taskPolicy).toBe("prototype");

    // Spliced immediately before the user message, not appended behind the
    // assistant/tool step it is supposed to precede.
    const skillIdx = turn.modelMessages.findIndex((m) => JSON.stringify(m).includes("lookup_skill"));
    const userIdx = turn.modelMessages.findIndex((m) => JSON.stringify(m).includes("a login screen"));
    const midIdx = turn.modelMessages.findIndex((m) => JSON.stringify(m).includes("call-mid-1"));
    expect(skillIdx).toBeGreaterThanOrEqual(0);
    expect(skillIdx).toBeLessThan(userIdx);
    expect(midIdx).toBeGreaterThan(userIdx);
  });

  it("keeps an enforce-mode Jev auto-pick AND the task policy alive across a tool-loop continuation too", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const client = makeStagedJevClient();

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [
        userMessage("design me a clickable prototype for a login screen"),
        assistantToolResultMessage(),
      ],
      systemOneClient: client,
    });

    // Before the fix, lastUserText resolved from the assistant tail was
    // undefined, so the Jev auto-pick block was skipped entirely on step 2+
    // — no injection, taskPolicy stuck at "native".
    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).toContain("lookup_skill");
    expect(turn.taskPolicy).toBe("prototype");
    expect(turn.skillSource).toBe("auto");
  });

  it("bumps the user-skill usage counter once per user turn, not once per tool-loop step", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const store = fakeUserSkillStore([{ ...baseUserSkill, enabled: true }]);

    // Fresh turn: the user message IS the last message.
    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "off" }),
      messages: [userMessage("/mysk please do the thing")],
      userId: "u1",
      userSkillStore: store,
    });
    expect((await store.get("u1", "mysk"))?.useCount).toBe(1);

    // A later step of the SAME turn: an assistant/tool message follows the
    // re-sent user message. Without the isFreshUserTurn gate, re-resolving
    // the same slash command on every step bumped the counter again — an
    // N-step tool loop would count as N invocations of one skill use.
    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "off" }),
      messages: [userMessage("/mysk please do the thing"), assistantToolResultMessage()],
      userId: "u1",
      userSkillStore: store,
    });
    expect((await store.get("u1", "mysk"))?.useCount).toBe(1);
  });

  it("suppresses the Jev auto-pick when the named user skill's lookup fails, instead of treating it as \"no such skill\"", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = makeStagedJevClient({ calls });
    const failingStore: UserSkillStore = {
      async list() { return []; },
      async listEnabled() { return []; },
      async get() { throw new Error("db unreachable"); },
      async create(input) {
        return { ...baseUserSkill, ...input, enabled: true };
      },
      async update() { return null; },
      async remove() { return false; },
      async bumpUse() {},
      async count() { return 0; },
      async close() {},
    };

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/mysk please do the thing")],
      userId: "u1",
      userSkillStore: failingStore,
      systemOneClient: client,
    });

    // Before the fix, a rejected/timed-out lookup was indistinguishable
    // from "no user skill by that name", reopening the exact back door
    // skipAutoPick exists to close: Jev auto-picking a DIFFERENT curated
    // skill for a message that explicitly named one via slash.
    expect(calls.count).toBe(0);
    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
  });

  it("reports skillSource matching how the skill was resolved: slash, auto, or neither", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

    const slashTurn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "off" }),
      messages: [userMessage("/prototype a login screen")],
    });
    expect(slashTurn.skillSource).toBe("slash");

    const autoClient = makeStagedJevClient();
    const autoTurn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      systemOneClient: autoClient,
    });
    expect(autoTurn.skillSource).toBe("auto");

    const noneTurn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "off" }),
      messages: [userMessage("just make the header a bit bigger")],
    });
    expect(noneTurn.skillSource).toBeUndefined();
  });

  it("missing client (no key) never calls Jev and never injects", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

    const turn = await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce", TYPESAFE_API_KEY: undefined }),
      messages: [userMessage("design me a clickable prototype for a login screen")],
      // No systemOneClient passed — createSystemOne(config) must be used and
      // must return null since TYPESAFE_API_KEY is unset.
    });

    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).not.toContain("lookup_skill");
  });

  describe("logging every verdict (not just picks)", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });
    afterEach(() => {
      logSpy.mockRestore();
    });

    function skillRoutingLines(): unknown[] {
      return logSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.startsWith("[skillRouting] "))
        .map((line) => JSON.parse(line.slice("[skillRouting] ".length)));
    }

    it("logs a verdict in enforce mode even when the gate drops the turn (no pick)", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const client = makeStagedJevClient({
        gate: { documented_workflow: 0.05, substantial_new_work: 0.05, direct_edit_suffices: 0.95 },
      });

      const turn = await prepareChatTurn({
        config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
        messages: [userMessage("nudge this button two pixels to the right")],
        systemOneClient: client,
      });

      expect(JSON.stringify(turn.modelMessages)).not.toContain("lookup_skill");
      const entries = skillRoutingLines() as Array<{ reason: string; mode: string; skill: string | null }>;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ reason: "gated", mode: "enforce", skill: null });
    });

    it("logs a verdict in shadow mode even when nothing is picked (no-fit)", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const client = makeStagedJevClient({ defaultFits: 0.05 });

      await prepareChatTurn({
        config: makeConfig({ SKILL_ROUTING_MODE: "shadow" }),
        messages: [userMessage("design me a clickable prototype for a login screen")],
        systemOneClient: client,
      });

      // Shadow mode is fire-and-forget — the routeSkill promise settles
      // after prepareChatTurn already returned, so wait for the log line
      // rather than asserting immediately.
      await vi.waitFor(() => expect(skillRoutingLines().length).toBeGreaterThan(0));
      const entries = skillRoutingLines() as Array<{ reason: string; mode: string; skill: string | null }>;
      expect(entries[0]).toMatchObject({ reason: "no-fit", mode: "shadow", skill: null });
    });

    // "totally-fake-skill" used to stand in here for "a picked name that
    // doesn't resolve via getSkill" — but that name was never one of the
    // candidates actually offered to Jev (real, on-disk skills only), so
    // finding #8's membership check now correctly rejects it upstream, as
    // reason "error", before this log line is ever produced. The scenario
    // this test actually cares about — routeSkill legitimately picks a
    // REAL candidate whose entry has since gone missing from the resolving
    // store — is simulated instead by forcing getSkill() to miss for one
    // otherwise-valid winner ("prototype").
    it("logs resolves: false when a picked (real, offered) name doesn't resolve via getSkill", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const client = makeStagedJevClient({
        pass1Winner: "prototype",
        pass2Winner: "prototype",
        fits: { prototype: 0.9 },
      });

      getSkillForcedMiss.enabled = true;
      let turn: Awaited<ReturnType<typeof prepareChatTurn>>;
      try {
        turn = await prepareChatTurn({
          config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
          messages: [userMessage("design me a clickable prototype for a login screen")],
          systemOneClient: client,
        });
      } finally {
        getSkillForcedMiss.enabled = false;
      }

      expect(JSON.stringify(turn.modelMessages)).not.toContain("lookup_skill");
      const entries = skillRoutingLines() as Array<{ reason: string; skill: string | null; resolves?: boolean }>;
      expect(entries[0]).toMatchObject({ reason: "picked", skill: "prototype", resolves: false });
    });

    it("never logs the user's message text", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const client = makeStagedJevClient();

      await prepareChatTurn({
        config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
        messages: [userMessage("SUPER-SECRET-REQUEST-TEXT design me a clickable prototype for a login screen")],
        systemOneClient: client,
      });

      const raw = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
      expect(raw).not.toContain("SUPER-SECRET-REQUEST-TEXT");
    });
  });
});
