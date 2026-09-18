import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";
import { loadSkills, getSkill } from "../src/ai/skills.js";
import { resetSkillRouteCacheForTests } from "../src/ai/skillRouting.js";
import type { SystemOneChoiceAnswer, SystemOneClient, SystemOneEvaluateParams, SystemOneQuestion } from "../src/services/systemone.js";
import type { UserSkill, UserSkillStore } from "../src/ai/skills/userStore.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

function fakeClient(
  answer: SystemOneChoiceAnswer,
  opts: { calls?: { count: number } } = {},
): SystemOneClient {
  return {
    async evaluate(_params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) {
      if (opts.calls) opts.calls.count += 1;
      return {
        model: "jev-latest",
        answers: { skill: answer } as never,
        usage: { input_tokens: 10, output_tokens: 1 },
      };
    },
  };
}

const confidentPrototypePick: SystemOneChoiceAnswer = {
  type: "choice",
  choice: "prototype",
  probabilities: { prototype: 0.95, none: 0.05 },
  confidence: 0.95,
};

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
    const client = fakeClient(confidentPrototypePick, { calls });

    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/prototype a login screen")],
      systemOneClient: client,
    });

    expect(calls.count).toBe(0);
  });

  it("shadow mode does not inject the synthetic lookup_skill pair", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const client = fakeClient(confidentPrototypePick);

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
    const client = fakeClient(confidentPrototypePick);

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
    const client = fakeClient(confidentPrototypePick, { calls });

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
    const client = fakeClient(confidentPrototypePick);

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
    const client = fakeClient(confidentPrototypePick, { calls });
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
    const client: SystemOneClient = {
      async evaluate(params) {
        captured = params;
        return {
          model: "jev-latest",
          answers: { skill: confidentPrototypePick } as never,
          usage: { input_tokens: 10, output_tokens: 1 },
        };
      },
    };

    await prepareChatTurn({
      config: makeConfig({ SKILL_ROUTING_MODE: "enforce" }),
      messages: [userMessage("/Users/me/shot.png make this a clickable prototype")],
      systemOneClient: client,
    });

    // The slash-shaped token itself must not leak into what Jev sees.
    expect(String(captured?.state)).not.toContain("/Users/me/shot.png");
    expect(String(captured?.state)).toContain("make this a clickable prototype");
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
    const client = fakeClient(confidentPrototypePick);

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
    const client = fakeClient(confidentPrototypePick, { calls });
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

    const autoClient = fakeClient(confidentPrototypePick);
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
});
