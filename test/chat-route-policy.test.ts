import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { buildApp } from "../src/app.js";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";

// Integration coverage for the FIR-45 structural backstop: when the message
// history shows the prototype/slides skill was loaded, batch_design is
// swapped for the embed-only variant, so a model-emitted native-node create
// op is rejected at the tool-input-validation layer (surfaced to the client
// as a tool-output-error carrying the embed-only guidance message). A
// control case confirms the same op still passes under the default (native)
// policy.

const holders = vi.hoisted(() => ({
  model: undefined as unknown,
  mcpTools: {} as Record<string, unknown>,
}));

vi.mock("../src/ai/provider.js", () => ({
  createModel: vi.fn(() => holders.model),
}));

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => holders.mcpTools),
  closeAllMCPClients: vi.fn(async () => {}),
}));

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

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

async function startServer(): Promise<RunningServer> {
  const app = await buildApp(makeConfig(), { logger: false });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url };
}

function userMessage(text: string): Record<string, unknown> {
  return { id: "m1", role: "user", parts: [{ type: "text", text }] };
}

// A prior turn's history entry recording a completed `load_skill` call —
// the same dynamic-tool UI part shape the client persists/replays.
function loadSkillHistoryEntry(name: "prototype" | "slides"): Record<string, unknown> {
  return {
    id: "a1",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolCallId: `call-load-skill-${name}`,
        toolName: "load_skill",
        state: "output-available",
        input: { name },
        output: { name, instructions: "..." },
      },
    ],
  };
}

async function postChat(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let server: RunningServer;

beforeAll(async () => {
  await loadSkills();
  server = await startServer();
});

afterAll(async () => {
  await server.app.close();
});

beforeEach(() => {
  holders.mcpTools = {};
});

describe("POST /api/chat — prototype/slides embed-only batch_design guard", () => {
  it("rejects a native frame create op when history loaded the prototype skill", async () => {
    const operations = 'x=I(document, {type: "frame"})';
    holders.model = mockModel(toolCallStreamChunks("batch_design", { operations }));

    const res = await postChat(server.url, {
      messages: [
        userMessage("build me a login screen"),
        loadSkillHistoryEntry("prototype"),
        userMessage("now insert it"),
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("tool-output-error");
    expect(body).toContain("embed-only");
    expect(body).toContain("may not create a native");
    expect(body).toContain("frame");
  });

  it("rejects a native frame create op when history loaded the slides skill", async () => {
    const operations = 'x=I(document, {type: "frame"})';
    holders.model = mockModel(toolCallStreamChunks("batch_design", { operations }));

    const res = await postChat(server.url, {
      messages: [
        userMessage("build me a 3-slide deck"),
        loadSkillHistoryEntry("slides"),
        userMessage("now insert slide 1"),
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("tool-output-error");
    expect(body).toContain("embed-only");
  });

  it("still allows a top-level embed create op under prototype policy", async () => {
    const operations = 'embed=I(document, {type: "embed", name: "Screen"})';
    holders.model = mockModel(toolCallStreamChunks("batch_design", { operations }));

    const res = await postChat(server.url, {
      messages: [
        userMessage("build me a login screen"),
        loadSkillHistoryEntry("prototype"),
        userMessage("now insert it"),
      ],
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("tool-output-error");
    expect(body).toContain("tool-input-available");
  });

  it("control: the same native frame op passes under the default (native) policy", async () => {
    const operations = 'x=I(document, {type: "frame"})';
    holders.model = mockModel(toolCallStreamChunks("batch_design", { operations }));

    const res = await postChat(server.url, {
      messages: [userMessage("edit the selected frame")],
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("tool-output-error");
    expect(body).toContain("tool-input-available");
  });
});
