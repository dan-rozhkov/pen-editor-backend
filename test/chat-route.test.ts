import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills, getSkill } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";
import { DEFAULT_MODELS } from "../src/config.js";

// ---------------------------------------------------------------------------
// Mocks: the provider returns a MockLanguageModelV3 (ai/test) and MCP tools
// are controlled per test — no network calls and no real API keys.
// ---------------------------------------------------------------------------

const holders = vi.hoisted(() => ({
  model: undefined as unknown,
  mcpTools: {} as Record<string, unknown>,
}));

vi.mock("../src/ai/provider.js", async (importOriginal) => {
  // Only createModel is faked — bareModelId (and anything else the module
  // exports) must stay the REAL implementation, since src/ai/chatTurn.ts
  // calls bareModelId on every prepareChatTurn() run.
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return { ...actual, createModel: vi.fn(() => holders.model) };
});

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => holders.mcpTools),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
    },
  ];
}

function toolCallStreamChunks(
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: "call-1",
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: USAGE,
    },
  ];
}

function mockModel(chunks: LanguageModelV3StreamPart[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, chunkDelayInMs: null }),
    }),
  });
}

interface RunningServer {
  app: FastifyInstance;
  url: string;
}

async function startServer(
  config = makeConfig(),
): Promise<RunningServer> {
  const app = await buildApp(config, { logger: false });
  // The chat route hijacks the reply and writes to reply.raw, which
  // app.inject() does not stream reliably — use a real listener + fetch.
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

function userMessage(text: string): Record<string, unknown> {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

async function postChat(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let server: RunningServer;

beforeAll(async () => {
  await loadSkills();
  server = await startServer();
});

afterAll(async () => {
  await server.app.close();
});

beforeEach(() => {
  holders.model = mockModel(textStreamChunks("ok"));
  holders.mcpTools = {};
});

describe("POST /api/chat — streaming happy paths", () => {
  it("streams a model tool-call (batch_design) to the client without executing it on the server", async () => {
    const operations = 'card=I(document, {type: "frame", name: "Card"})';
    holders.model = mockModel(
      toolCallStreamChunks("batch_design", { operations }),
    );

    const res = await postChat(server.url, {
      messages: [userMessage("create a card")],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    // The tool call reaches the client through the UI message stream…
    expect(body).toContain('"toolName":"batch_design"');
    expect(body).toContain("tool-input-available");
    expect(body).toContain("card=I(document,");
    // …but the tool is NOT executed on the backend: no output appears.
    expect(body).not.toContain("tool-output-available");
    expect(body).toContain("[DONE]");
  });

  it("preserves progressive draw_vector input deltas without executing the tool", async () => {
    holders.model = mockModel([
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-vector", toolName: "draw_vector" },
      {
        type: "tool-input-delta",
        id: "call-vector",
        delta: '{"name":"Leaf","commands":"M(10,10)\\n',
      },
      {
        type: "tool-input-delta",
        id: "call-vector",
        delta: 'L(20,20)\\nEND()"}',
      },
      { type: "tool-input-end", id: "call-vector" },
      {
        type: "tool-call",
        toolCallId: "call-vector",
        toolName: "draw_vector",
        input: '{"name":"Leaf","commands":"M(10,10)\\nL(20,20)\\nEND()"}',
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: USAGE,
      },
    ]);

    const res = await postChat(server.url, {
      messages: [userMessage("draw a leaf")],
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    const start = body.indexOf('"type":"tool-input-start"');
    const firstDelta = body.indexOf('"type":"tool-input-delta"');
    const available = body.indexOf('"type":"tool-input-available"');
    expect(start).toBeGreaterThan(-1);
    expect(firstDelta).toBeGreaterThan(start);
    expect(available).toBeGreaterThan(firstDelta);
    expect(body).not.toContain('"type":"tool-output-available"');
  });

  it("streams the model text response to the client", async () => {
    holders.model = mockModel(textStreamChunks("Hello from the design agent"));

    const res = await postChat(server.url, {
      messages: [userMessage("hi")],
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain("Hello from the design agent");
    expect(body).toContain("[DONE]");
  });

  it("passes canvasContext as a trailing message, not into the system prompt (prompt-cache fix)", async () => {
    const model = mockModel(textStreamChunks("ok"));
    holders.model = model;

    await (
      await postChat(server.url, {
        messages: [userMessage("hi")],
        canvasContext: "CANVAS-CTX-MARKER",
      })
    ).text();

    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = model.doStreamCalls[0].prompt as Array<{ role: string; content: unknown }>;
    const promptJson = JSON.stringify(prompt);
    // The marker made it into the request somewhere...
    expect(promptJson).toContain("CANVAS-CTX-MARKER");
    // ...but NOT inside the system message — only a constant pointer lives
    // there, so the cached prefix never varies with canvas state.
    const system = prompt.find((m) => m.role === "system");
    expect(JSON.stringify(system)).not.toContain("CANVAS-CTX-MARKER");
    expect(JSON.stringify(system)).toContain("## Current Canvas Context");
    // ...the marker instead lives in the LAST message, wrapped so the model
    // doesn't mistake it for the human's own words.
    const last = prompt[prompt.length - 1];
    expect(last.role).toBe("user");
    expect(JSON.stringify(last)).toContain("<canvas_context>");
    expect(JSON.stringify(last)).toContain("CANVAS-CTX-MARKER");
  });
});

describe("POST /api/chat — validation errors", () => {
  it("returns 400 for empty messages", async () => {
    const res = await postChat(server.url, { messages: [] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid request body");
  });

  it("returns 400 for an invalid body", async () => {
    const res = await postChat(server.url, { nonsense: true });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid request body");
  });

  // The composer's picker: an id GET /api/models offers must actually reach
  // the provider as this turn's model, flagged as the chat agent so it keeps
  // CHAT_REASONING_EFFORT rather than a helper role's "minimal".
  it("runs a picked model from the allowed list", async () => {
    const { createModel } = await import("../src/ai/provider.js");
    vi.mocked(createModel).mockClear();
    const picked = DEFAULT_MODELS[1].id;

    const res = await postChat(server.url, {
      messages: [userMessage("hi")],
      model: picked,
    });
    expect(res.status).toBe(200);
    await res.text();

    // `sessionId` is always the (generated, when absent from the request)
    // traceSessionId now — see test/chat-route-opencode.test.ts for the
    // OpenCode-specific assertions on that field and on opencodeApiKey.
    // toMatchObject (not toEqual) here on purpose: this test only cares that
    // the picked model and chatAgent flag reached createModel unchanged.
    expect(vi.mocked(createModel).mock.calls[0]?.[0]).toBeDefined();
    expect(vi.mocked(createModel).mock.calls[0]?.[1]).toBe(picked);
    expect(vi.mocked(createModel).mock.calls[0]?.[2]).toMatchObject({
      chatAgent: true,
    });
  });

  // A client cached before a list change still posts its old stored
  // selection. An unknown id must fall back to CHAT_MODEL, not 400 — a
  // rejection here would break every turn such a client makes until it
  // reloads.
  it("ignores an unknown model id instead of rejecting it", async () => {
    const { createModel } = await import("../src/ai/provider.js");
    vi.mocked(createModel).mockClear();

    const res = await postChat(server.url, {
      messages: [userMessage("hi")],
      model: "evil/not-allowed-model",
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(vi.mocked(createModel).mock.calls[0]?.[1]).toBeUndefined();
  });

  it("returns 400 when a single message contains more than 4 file/image parts", async () => {
    const imagePart = {
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,iVBORw0KGgo=",
    };
    const res = await postChat(server.url, {
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [
            { type: "text", text: "look at these" },
            ...Array.from({ length: 5 }, () => ({ ...imagePart })),
          ],
        },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Too many images in a single message");
    expect(body.error).toContain("maximum is 4");
  });

  it("allows exactly 4 image parts in one message", async () => {
    const imagePart = {
      type: "file",
      mediaType: "image/png",
      url: "data:image/png;base64,iVBORw0KGgo=",
    };
    const res = await postChat(server.url, {
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [
            { type: "text", text: "ok" },
            ...Array.from({ length: 4 }, () => ({ ...imagePart })),
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("POST /api/chat — universal toolset", () => {
  it("no longer 503s without MCP when a legacy research mode is requested", async () => {
    holders.mcpTools = {};
    holders.model = mockModel(textStreamChunks("done"));
    const res = await postChat(server.url, {
      messages: [userMessage("research pricing pages")],
      agentMode: "research", // legacy field — ignored now
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  it("exposes the load_skill tool and the skill catalog to the model", async () => {
    holders.mcpTools = {};
    const model = mockModel(textStreamChunks("done"));
    holders.model = model;
    const res = await postChat(server.url, {
      messages: [userMessage("make me a dashboard")],
    });
    expect(res.status).toBe(200);
    await res.text();

    const call = model.doStreamCalls[0];
    // The catalog is injected into the system prompt.
    const systemText = JSON.stringify(call.prompt).includes("Available Skills");
    expect(systemText).toBe(true);
    // load_skill is registered in the toolset.
    const toolNames = (call.tools ?? []).map(
      (t: { name?: string }) => t.name,
    );
    expect(toolNames).toContain("load_skill");
  });
});

describe("POST /api/chat — skill command injection", () => {
  it("injects a synthetic lookup_skill tool call and strips the command from the user text", async () => {
    const model = mockModel(textStreamChunks("done"));
    holders.model = model;

    const skill = getSkill("polish");
    expect(skill).toBeDefined();

    const res = await postChat(server.url, {
      messages: [userMessage("/polish make the header shine")],
    });
    expect(res.status).toBe(200);
    await res.text();

    expect(model.doStreamCalls).toHaveLength(1);
    const prompt = model.doStreamCalls[0].prompt;
    const promptJson = JSON.stringify(prompt);

    // The synthetic tool call + result pair carries the skill instructions.
    expect(promptJson).toContain("lookup_skill");
    expect(promptJson).toContain("Follow these instructions for the current task");
    // A distinctive snippet of the polish skill body made it into the prompt.
    expect(promptJson).toContain("final pass");

    // The slash command is stripped from the user message.
    const userMessages = (prompt as Array<{ role: string; content: unknown }>).filter(
      (m) => m.role === "user",
    );
    const lastUser = userMessages[userMessages.length - 1];
    const lastUserJson = JSON.stringify(lastUser);
    expect(lastUserJson).toContain("make the header shine");
    expect(lastUserJson).not.toContain("/polish");

    // The synthetic pair is injected BEFORE the last user message.
    const lastUserIndex = (prompt as Array<{ role: string }>).findLastIndex(
      (m) => m.role === "user",
    );
    const skillCallIndex = (prompt as Array<unknown>).findIndex((m) =>
      JSON.stringify(m).includes("lookup_skill"),
    );
    expect(skillCallIndex).toBeGreaterThan(-1);
    expect(skillCallIndex).toBeLessThan(lastUserIndex);
  });

  it("injects the plugin skill instructions for a /plugin command", async () => {
    const model = mockModel(textStreamChunks("done"));
    holders.model = model;

    const skill = getSkill("plugin");
    expect(skill).toBeDefined();

    const res = await postChat(server.url, {
      messages: [userMessage("/plugin make a tool that renames my selection")],
    });
    expect(res.status).toBe(200);
    await res.text();

    const promptJson = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(promptJson).toContain("lookup_skill");
    // A distinctive snippet of the plugin skill body made it into the prompt.
    expect(promptJson).toContain("pen.tools.run");

    const userMessages = (
      model.doStreamCalls[0].prompt as Array<{ role: string; content: unknown }>
    ).filter((m) => m.role === "user");
    const lastUserJson = JSON.stringify(userMessages[userMessages.length - 1]);
    expect(lastUserJson).toContain("make a tool that renames my selection");
    expect(lastUserJson).not.toContain("/plugin");
  });

  it("passes unknown slash commands through as plain text", async () => {
    const model = mockModel(textStreamChunks("ok"));
    holders.model = model;

    const res = await postChat(server.url, {
      messages: [userMessage("/no-such-skill help me")],
    });
    expect(res.status).toBe(200);
    await res.text();

    const promptJson = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(promptJson).not.toContain("lookup_skill");
    expect(promptJson).toContain("/no-such-skill help me");
  });
});

describe("POST /api/chat — CORS on the hijacked streaming reply", () => {
  let corsServer: RunningServer;

  beforeAll(async () => {
    corsServer = await startServer(
      makeConfig({
        CORS_ALLOWED_ORIGINS: "https://app.example.com, https://other.example.com",
      }),
    );
  });

  afterAll(async () => {
    await corsServer.app.close();
  });

  it("reflects an allowlisted origin on the streaming response", async () => {
    const res = await postChat(
      corsServer.url,
      { messages: [userMessage("hi")] },
      { Origin: "https://app.example.com" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("vary")).toContain("Origin");
    await res.text();
  });

  it("does not reflect an origin outside the allowlist", async () => {
    const res = await postChat(
      corsServer.url,
      { messages: [userMessage("hi")] },
      { Origin: "https://evil.example.com" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    await res.text();
  });

  it("reflects any origin when the allowlist is empty (dev mode)", async () => {
    const res = await postChat(
      server.url,
      { messages: [userMessage("hi")] },
      { Origin: "http://localhost:5173" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    await res.text();
  });
});

describe("GET /api/skills", () => {
  it("lists loaded skills with name and description", async () => {
    const res = await fetch(`${server.url}/api/skills`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skills: Array<{ name: string; description: string }>;
    };
    expect(body.skills.length).toBeGreaterThan(0);
    const polish = body.skills.find((s) => s.name === "polish");
    expect(polish).toBeDefined();
    expect(polish!.description).toMatch(/quality pass/i);
  });
});
