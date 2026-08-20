import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadSkills } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

// Regression coverage for the prompt-cache fix: canvasContext used to be
// rendered directly into `system` (`## Current Canvas Context\n\n${data}`).
// Since the frontend rebuilds canvasContext on every request — including
// every auto-continuation of a tool-call loop — that made the cached prefix
// (system + prior history) change on request #1 of every conversation, so
// nothing ever cached. The fix moves the actual data to a trailing message
// in modelMessages and leaves only a constant pointer in `system`.
describe("prepareChatTurn — canvas context delivery", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("never puts canvas context data into the system prompt", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const config = makeConfig();

    const turn = await prepareChatTurn({
      config,
      messages: [userMessage("hi")],
      canvasContext: JSON.stringify({ roots: ["node-abc-123"], selectedIds: ["node-abc-123"] }),
    });

    expect(turn.system).not.toContain("node-abc-123");
    // The pointer heading survives (skills reference "Canvas Context").
    expect(turn.system).toContain("## Current Canvas Context");
  });

  it("appends canvas context as the last modelMessages entry, wrapped so it isn't mistaken for the user", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const config = makeConfig();
    const ctx = JSON.stringify({ roots: ["node-xyz-789"] });

    const turn = await prepareChatTurn({
      config,
      messages: [userMessage("make the header bigger")],
      canvasContext: ctx,
    });

    const last = turn.modelMessages[turn.modelMessages.length - 1];
    expect(last.role).toBe("user");
    const lastJson = JSON.stringify(last);
    expect(lastJson).toContain("<canvas_context>");
    expect(lastJson).toContain("node-xyz-789");
    expect(lastJson).toContain("Automatic message from the Pencil editor");
  });

  it("KEY: two turns with identical messages but different canvasContext produce the same systemPromptHash", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const config = makeConfig();

    const turnA = await prepareChatTurn({
      config,
      messages: [userMessage("edit the button")],
      canvasContext: JSON.stringify({ selectedIds: ["a"], roots: ["r1"] }),
    });
    const turnB = await prepareChatTurn({
      config,
      messages: [userMessage("edit the button")],
      canvasContext: JSON.stringify({ selectedIds: ["b", "c"], roots: ["r1", "r2"], theme: "dark" }),
    });

    expect(turnA.systemPromptHash).toBe(turnB.systemPromptHash);
    expect(turnA.system).toBe(turnB.system);
  });

  it("adds nothing and renders no pointer when canvasContext is absent (headless callers stay byte-identical)", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const config = makeConfig();

    const turn = await prepareChatTurn({
      config,
      messages: [userMessage("hi")],
    });

    expect(turn.system).not.toContain("## Current Canvas Context");
    const last = turn.modelMessages[turn.modelMessages.length - 1];
    expect(JSON.stringify(last)).not.toContain("<canvas_context>");
  });
});
