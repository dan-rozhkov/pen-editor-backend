import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import {
  chatMocks,
  mockModel,
  resetChatMocks,
  toolCallStreamChunks,
  userMessage,
} from "./chatMocks.js";
import { chatTurn, startApp, type RunningApp } from "./chatHarness.js";

// Integration coverage for the FIR-45 structural backstop: when the message
// history shows the prototype/slides skill was loaded, batch_design is
// swapped for the embed-only variant, so a model-emitted native-node create
// op is rejected at the tool-input-validation layer (surfaced to the client
// as a tool-output-error carrying the embed-only guidance message). A
// control case confirms the same op still passes under the default (native)
// policy.

vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./chatMocks.js")).mockProviderModule(await importOriginal()),
);
vi.mock("../src/ai/mcp.js", async () => (await import("./chatMocks.js")).mockMcpModule());

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

// The model answers with one batch_design call carrying these operations.
function turnWithBatchDesign(operations: string, messages: Record<string, unknown>[]) {
  chatMocks.model = mockModel(toolCallStreamChunks("batch_design", { operations }));
  return chatTurn(server.url, { messages });
}

// History where an earlier turn loaded `skill`.
function afterLoading(skill: "prototype" | "slides", ask: string, followUp: string) {
  return [userMessage(ask), loadSkillHistoryEntry(skill), userMessage(followUp)];
}

const NATIVE_FRAME_OP = 'x=I(document, {type: "frame"})';

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

describe("POST /api/chat — prototype/slides embed-only batch_design guard", () => {
  it("rejects a native frame create op when history loaded the prototype skill", async () => {
    const { res, body } = await turnWithBatchDesign(
      NATIVE_FRAME_OP,
      afterLoading("prototype", "build me a login screen", "now insert it"),
    );

    expect(res.status).toBe(200);
    expect(body).toContain("tool-output-error");
    expect(body).toContain("embed-only");
    expect(body).toContain("may not create a native");
    expect(body).toContain("frame");
  });

  it("rejects a native frame create op when history loaded the slides skill", async () => {
    const { res, body } = await turnWithBatchDesign(
      NATIVE_FRAME_OP,
      afterLoading("slides", "build me a 3-slide deck", "now insert slide 1"),
    );

    expect(res.status).toBe(200);
    expect(body).toContain("tool-output-error");
    expect(body).toContain("embed-only");
  });

  it("still allows a top-level embed create op under prototype policy", async () => {
    const { res, body } = await turnWithBatchDesign(
      'embed=I(document, {type: "embed", name: "Screen"})',
      afterLoading("prototype", "build me a login screen", "now insert it"),
    );

    expect(res.status).toBe(200);
    expect(body).not.toContain("tool-output-error");
    expect(body).toContain("tool-input-available");
  });

  it("control: the same native frame op passes under the default (native) policy", async () => {
    const { res, body } = await turnWithBatchDesign(NATIVE_FRAME_OP, [
      userMessage("edit the selected frame"),
    ]);

    expect(res.status).toBe(200);
    expect(body).not.toContain("tool-output-error");
    expect(body).toContain("tool-input-available");
  });
});
