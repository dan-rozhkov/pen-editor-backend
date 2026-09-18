import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Finding 2 regression: deliberately does NOT mock releaseMCPTools or
// attachMobbinRelease (every existing chat-route test does, per the review
// note that a regression turning either hook into a no-op would stay
// green forever). Only the actual network boundary — @ai-sdk/mcp's
// createMCPClient — is faked, so this exercises the REAL refCount/lease
// wiring in src/ai/mcp.ts and the REAL try/catch added around it in
// src/ai/chatTurn.ts.
vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: vi.fn(),
}));

// Only getSkillTools is overridden (to throw, simulating any of
// getWebTools/getSkillTools/getMemoryTools/getSelfSkillTools/
// makeAnalyzeImageTool failing between getMCPTools resolving and
// prepareChatTurn's return) — everything else stays the real
// implementation, since prepareChatTurn depends on ensureSkillsLoaded/
// getAllSkills/getSkill/detectSkillCommand actually working.
const skillToolsThrows = vi.hoisted(() => ({ enabled: false }));
vi.mock("../src/ai/skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/skills.js")>();
  return {
    ...actual,
    getSkillTools: (...args: Parameters<typeof actual.getSkillTools>) => {
      if (skillToolsThrows.enabled) {
        throw new Error("simulated failure after getMCPTools resolved");
      }
      return actual.getSkillTools(...args);
    },
  };
});

import { createMCPClient } from "@ai-sdk/mcp";
import { closeAllMCPClients, getMCPTools } from "../src/ai/mcp.js";
import { prepareChatTurn } from "../src/ai/chatTurn.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";

function fakeClient(tools: Record<string, unknown> = { search_screens: { execute: vi.fn() } }) {
  return {
    tools: vi.fn(async () => tools),
    close: vi.fn(async () => {}),
  };
}

async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function userMessage(text: string): Record<string, unknown> {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

describe("Finding 2 — prepareChatTurn releases its Mobbin lease when a later step throws", () => {
  const config = makeConfig();

  beforeAll(async () => {
    await loadSkills();
  });

  afterEach(async () => {
    skillToolsThrows.enabled = false;
    await closeAllMCPClients();
    vi.mocked(createMCPClient).mockReset();
    vi.useRealTimers();
  });

  it("does NOT leak the lease when a step after getMCPTools throws — the client closes promptly on its next TTL sweep instead of only after the 10-minute force-close backstop", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(client as never);

    skillToolsThrows.enabled = true;
    await expect(
      prepareChatTurn({
        config,
        messages: [userMessage("hello")],
        mobbinAccessToken: "leak-token",
      }),
    ).rejects.toThrow("simulated failure after getMCPTools resolved");
    skillToolsThrows.enabled = false;

    // The failed turn's lease must already be released — advancing past
    // the TTL and reconnecting for the same token must close the OLD
    // client right away. Before the fix, the lease was never released
    // (refCount stuck at 1), so this same sequence would leave clientA
    // open until the 10-minute RETIRE_FORCE_CLOSE_MS backstop instead.
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    vi.mocked(createMCPClient).mockResolvedValueOnce(fakeClient() as never);
    await getMCPTools(config, { mobbinAccessToken: "leak-token" });
    await flushMicrotasks();

    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("(control) DOES leave the lease held when the turn succeeds normally, until the caller releases it — proves the assertion above is actually sensitive to the fix, not a tautology", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    vi.mocked(createMCPClient).mockResolvedValueOnce(client as never);

    skillToolsThrows.enabled = false;
    const prepared = await prepareChatTurn({
      config,
      messages: [userMessage("hello")],
      mobbinAccessToken: "leak-token-success",
    });
    expect(prepared.tools).toBeTruthy();
    // Deliberately never released — simulates routes/chat.ts's "close"
    // handler never having fired yet (request still in flight).

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
    vi.mocked(createMCPClient).mockResolvedValueOnce(fakeClient() as never);
    await getMCPTools(config, { mobbinAccessToken: "leak-token-success" });
    await flushMicrotasks();

    // A genuinely still-open lease must NOT be closed early — confirms the
    // previous test's prompt close is really detecting the release, not
    // some unconditional eviction behavior.
    expect(client.close).not.toHaveBeenCalled();
  });
});
