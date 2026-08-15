// Regression coverage for the wiring bug found in code review: buildApp()
// constructed a userSkillStore but never passed it into chatRoutes, and
// chatRoutes never passed it into prepareChatTurn — so `(custom)` catalog
// entries, `/my-skill` slash resolution, and load_skill's user branch never
// fired for a REAL request, even though every unit test for prepareChatTurn
// itself (test/user-skills-chat-turn.test.ts) passed, since those call
// prepareChatTurn directly and can't see a wiring gap between buildApp and
// it. This file goes through the real HTTP path — buildApp() + listen +
// fetch — the same shape as test/chat-route.test.ts, with an injected
// in-memory UserSkillStore via BuildAppOptions (the same test seam
// memoryStore/learnedSkillStore already use).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import type { UserSkill, UserSkillStore } from "../src/ai/skills/userStore.js";

vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

const holders = vi.hoisted(() => ({ model: undefined as unknown }));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textStreamChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
  ];
}

function mockModel(chunks: LanguageModelV3StreamPart[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, chunkDelayInMs: null }),
    }),
  });
}

const USER_ID = "11111111-1111-4111-8111-111111111111";

const baseSkill: UserSkill = {
  userId: USER_ID,
  name: "my-skill",
  description: "does a custom thing",
  body: "USER SKILL BODY FROM REAL HTTP REQUEST",
  enabled: true,
  source: "manual",
  useCount: 0,
  lastUsedAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

// Minimal in-memory UserSkillStore double — same shape as the one in
// test/user-skills-chat-turn.test.ts, kept local rather than shared so this
// file exercises the HTTP path with zero dependency on that file's fixtures.
function fakeUserSkillStore(initial: UserSkill[]): UserSkillStore & { skills: UserSkill[] } {
  const skills = initial.map((s) => ({ ...s }));
  return {
    skills,
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
      const created: UserSkill = {
        ...baseSkill,
        ...input,
        enabled: true,
        useCount: 0,
        lastUsedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      skills.push(created);
      return created;
    },
    async update(userId, name, patch) {
      const found = skills.find((s) => s.userId === userId && s.name === name);
      if (!found) return null;
      if (patch.newName !== undefined) found.name = patch.newName;
      if (patch.description !== undefined) found.description = patch.description;
      if (patch.body !== undefined) found.body = patch.body;
      if (patch.enabled !== undefined) found.enabled = patch.enabled;
      found.updatedAt = new Date();
      return found;
    },
    async remove(userId, name) {
      const idx = skills.findIndex((s) => s.userId === userId && s.name === name);
      if (idx === -1) return false;
      skills.splice(idx, 1);
      return true;
    },
    async bumpUse(userId, name) {
      const found = skills.find((s) => s.userId === userId && s.name === name);
      if (found) {
        found.useCount += 1;
        found.lastUsedAt = new Date();
      }
    },
    async count(userId) {
      return skills.filter((s) => s.userId === userId).length;
    },
    async close() {},
  };
}

function userMessage(text: string): Record<string, unknown> {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

interface RunningServer {
  app: FastifyInstance;
  url: string;
}

let server: RunningServer;
let store: ReturnType<typeof fakeUserSkillStore>;

beforeAll(async () => {
  await loadSkills();
});

beforeEach(() => {
  holders.model = mockModel(textStreamChunks("ok"));
});

afterAll(async () => {
  await server?.app.close();
});

describe("POST /api/chat — user skill store wiring (real HTTP path)", () => {
  it("injects a user skill's body for /my-skill when sent through the real buildApp()/chatRoutes wiring", async () => {
    store = fakeUserSkillStore([baseSkill]);
    // buildApp() is the actual production entry point (app.ts), not
    // prepareChatTurn called directly — this is what catches a dropped
    // argument between buildApp -> chatRoutes -> prepareChatTurn that a
    // prepareChatTurn-only unit test structurally cannot see.
    const app = await buildApp(makeConfig(), {
      logger: false,
      userSkillStore: store,
      memoryStore: null,
      learnedSkillStore: null,
      auditDb: null,
    });
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    server = { app, url };

    const model = mockModel(textStreamChunks("done"));
    holders.model = model;

    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [userMessage("/my-skill do the thing")],
        userId: USER_ID,
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(model.doStreamCalls).toHaveLength(1);
    const promptJson = JSON.stringify(model.doStreamCalls[0].prompt);

    // The synthetic lookup_skill tool-call/result pair carries the user
    // skill's body — proof the store reached prepareChatTurn through the
    // real HTTP route, not just through a direct prepareChatTurn() call.
    expect(promptJson).toContain("lookup_skill");
    expect(promptJson).toContain("USER SKILL BODY FROM REAL HTTP REQUEST");

    // The slash command is stripped from the visible user text, same as a
    // curated skill.
    expect(promptJson).toContain("do the thing");
    expect(promptJson).not.toContain("/my-skill do the thing");

    // bumpUse actually landed — another signal the real store instance was
    // used, not a fresh/unwired one.
    expect(store.skills[0].useCount).toBe(1);
  });
});
