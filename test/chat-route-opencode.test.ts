import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { chatMocks, mockModel, resetChatMocks, textStreamChunks, userMessage } from "./chatMocks.js";
import {
  postChat,
  recordingAnalyticsClient,
  startApp,
  waitForEvent,
  type RunningApp,
} from "./chatHarness.js";

// Same mocking shape as test/chat-route.test.ts — createModel is faked so no
// real provider call is ever made, but the REAL parseModelRef/isOpenCodeProvider
// (re-exported by src/ai/provider.js) keep running, since the chat route's
// opencode-key-required check depends on them. See test/chatMocks.ts.
vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

let server: RunningApp;

beforeAll(async () => {
  await loadSkills();
  server = await startApp();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  resetChatMocks();
});

describe("POST /api/chat — OpenCode BYOK model selection", () => {
  it("400s an allowlisted opencode model with no X-OpenCode-Key header", async () => {
    const analytics = recordingAnalyticsClient();
    const { url, close } = await startApp(makeConfig(), { analytics });

    const res = await postChat(url, {
      messages: [userMessage("hi")],
      model: "opencode-go/glm-5.3-flash",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("opencode_key_required");
    expect(body.error).toBeTruthy();

    const failed = await waitForEvent(analytics, "agent_turn_failed");
    expect(failed.properties?.error_kind).toBe("opencode_key_required");

    await close();
  });

  it("runs the turn when an opencode model is picked WITH the header, and forwards the key + sessionId to createModel", async () => {
    const { createModel } = await import("../src/ai/provider.js");
    vi.mocked(createModel).mockClear();

    const res = await postChat(
      server.url,
      {
        id: "tab-opencode-1",
        messages: [userMessage("hi")],
        model: "opencode-go/glm-5.3-flash",
      },
      { "X-OpenCode-Key": "sk-test-abc123" },
    );

    expect(res.status).toBe(200);
    await res.text();

    const call = vi.mocked(createModel).mock.calls[0];
    expect(call?.[1]).toBe("opencode-go/glm-5.3-flash");
    expect(call?.[2]).toMatchObject({
      chatAgent: true,
      sessionId: "tab-opencode-1",
      opencodeApiKey: "sk-test-abc123",
    });
  });

  it("still ignores an UNKNOWN model id and runs the default (no 400, no key required)", async () => {
    const { createModel } = await import("../src/ai/provider.js");
    vi.mocked(createModel).mockClear();

    const res = await postChat(server.url, {
      messages: [userMessage("hi")],
      model: "opencode-go/totally-unknown-model",
    });

    expect(res.status).toBe(200);
    await res.text();
    expect(vi.mocked(createModel).mock.calls[0]?.[1]).toBeUndefined();
  });

  it("still runs a normal OpenRouter model with no header", async () => {
    const res = await postChat(server.url, {
      messages: [userMessage("hi")],
      model: "z-ai/glm-5.3-flash",
    });
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("POST /api/chat — agentMode browse gate", () => {
  it("400s browse_agent_disabled when BROWSE_MODE is not agent", async () => {
    const { url, close } = await startApp(makeConfig({ BROWSE_MODE: "manual" }));
    try {
      const res = await postChat(url, {
        messages: [userMessage("open a page")],
        agentMode: "browse",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("browse_agent_disabled");
    } finally {
      await close();
    }
  });

  it("passes browseCapture from the body to the subagent's tool set", async () => {
    const { url, close } = await startApp(makeConfig({ BROWSE_MODE: "agent" }));
    const toolsSent = async (extra: Record<string, unknown>) => {
      const model = mockModel(textStreamChunks("ok"));
      chatMocks.model = model;
      const res = await postChat(url, {
        messages: [userMessage("copy the page")],
        agentMode: "browse",
        clientCapabilities: { desktopBrowser: true },
        ...extra,
      });
      expect(res.status).toBe(200);
      await res.text();
      return (model.doStreamCalls[0].tools ?? []).map((t: { name?: string }) => t.name);
    };
    try {
      expect(await toolsSent({ browseCapture: true })).toContain("browse_capture");
      expect(await toolsSent({})).not.toContain("browse_capture");
      expect(await toolsSent({ browseCapture: false })).not.toContain("browse_capture");
      const bad = await postChat(url, {
        messages: [userMessage("copy the page")],
        agentMode: "browse",
        browseCapture: "yes",
      });
      expect(bad.status).toBe(400);
      await bad.text();
    } finally {
      await close();
    }
  });

  it("passes browseLogin from the body to the subagent's tool set", async () => {
    const { url, close } = await startApp(makeConfig({ BROWSE_MODE: "agent" }));
    const toolsSent = async (extra: Record<string, unknown>) => {
      const model = mockModel(textStreamChunks("ok"));
      chatMocks.model = model;
      const res = await postChat(url, {
        messages: [userMessage("sign in")],
        agentMode: "browse",
        clientCapabilities: { desktopBrowser: true },
        ...extra,
      });
      expect(res.status).toBe(200);
      await res.text();
      return (model.doStreamCalls[0].tools ?? []).map((t: { name?: string }) => t.name);
    };
    try {
      expect(await toolsSent({ browseLogin: true })).toContain("browse_fill_login");
      expect(await toolsSent({})).not.toContain("browse_fill_login");
      expect(await toolsSent({ browseLogin: false })).not.toContain("browse_fill_login");
    } finally {
      await close();
    }
  });

  it("does not 400 browse_agent_disabled when BROWSE_MODE is agent", async () => {
    const { url, close } = await startApp(makeConfig({ BROWSE_MODE: "agent" }));
    try {
      const res = await postChat(url, {
        messages: [userMessage("open a page")],
        agentMode: "browse",
      });
      if (res.status === 400) {
        expect(((await res.json()) as { code?: string }).code).not.toBe("browse_agent_disabled");
      }
      await res.text();
    } finally {
      await close();
    }
  });
});
