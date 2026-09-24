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
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import {
  chatMocks,
  mockModel,
  resetChatMocks,
  textStreamChunks,
  userMessage,
} from "./chatMocks.js";
import { chatTurn, startApp, type RunningApp } from "./chatHarness.js";
import { fakeUserSkillStore, userSkill } from "./userSkillFakes.js";

// See the hoisting contract at the top of test/chatMocks.ts.
vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

const USER_ID = "11111111-1111-4111-8111-111111111111";

// The same in-memory store double test/user-skills-chat-turn.test.ts uses
// (test/userSkillFakes.ts) — what differs here is only the path it travels:
// buildApp() -> chatRoutes -> prepareChatTurn instead of a direct call.
const baseSkill = userSkill({ userId: USER_ID, body: "USER SKILL BODY FROM REAL HTTP REQUEST" });

let server: RunningApp;
let store: ReturnType<typeof fakeUserSkillStore>;

beforeAll(async () => {
  await loadSkills();
});

beforeEach(() => {
  resetChatMocks();
});

afterAll(async () => {
  await server?.close();
});

describe("POST /api/chat — user skill store wiring (real HTTP path)", () => {
  it("injects a user skill's body for /my-skill when sent through the real buildApp()/chatRoutes wiring", async () => {
    store = fakeUserSkillStore([baseSkill]);
    // buildApp() is the actual production entry point (app.ts), not
    // prepareChatTurn called directly — this is what catches a dropped
    // argument between buildApp -> chatRoutes -> prepareChatTurn that a
    // prepareChatTurn-only unit test structurally cannot see.
    server = await startApp(makeConfig(), {
      userSkillStore: store,
      memoryStore: null,
      learnedSkillStore: null,
      auditDb: null,
    });

    const model = mockModel(textStreamChunks("done"));
    chatMocks.model = model;

    const { res } = await chatTurn(server.url, {
      messages: [userMessage("/my-skill do the thing")],
      userId: USER_ID,
    });
    expect(res.status).toBe(200);

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
