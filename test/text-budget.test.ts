import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { loadSkills } from "../src/ai/skills.js";
import {
  KEEP_RECENT_TOOL_RESULTS,
  MASKED_HEAD_CHARS,
  MASK_MIN_CHARS,
  TEXT_BUDGET_STEP,
  applyTextBudget,
  planTextBudget,
  textBudgetPlaceholder,
} from "../src/ai/text-budget.js";
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

const BIG = MASK_MIN_CHARS + 500;
const OPTS = { startTokens: 0 };

type Output = { type: string; value: unknown };

function result(id: string, toolName: string, output: Output): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName, output }],
  } as ModelMessage;
}

function textOut(chars: number): Output {
  return { type: "text", value: "x".repeat(chars) };
}

/** n chronological browse_snapshot results, each BIG chars. */
function snapshots(n: number, toolName = "browse_snapshot"): ModelMessage[] {
  return Array.from({ length: n }, (_, i) => result(`c${i}`, toolName, textOut(BIG)));
}

function outputsOf(messages: ModelMessage[]): unknown[] {
  return messages.flatMap((m) =>
    (m.content as Array<{ output?: unknown }>).map((p) => p.output),
  );
}

function maskedIndexes(messages: ModelMessage[]): number[] {
  return outputsOf(messages)
    .map((o, i) => (JSON.stringify(o).includes("[Earlier ") ? i : -1))
    .filter((i) => i >= 0);
}

describe("text-budget", () => {
  it("masks nothing below the start threshold", () => {
    const messages = snapshots(20);
    const out = applyTextBudget(messages, { startTokens: 1_000_000 });
    expect(out.messages).toBe(messages);
    expect(out.report.elidedParts).toBe(0);
  });

  it.each([5, 9, 10, 14, 23])("with %i results only the first floor((N-5)/5)*5 are eligible", (n) => {
    const expected = Math.floor(Math.max(0, n - KEEP_RECENT_TOOL_RESULTS) / TEXT_BUDGET_STEP) * TEXT_BUDGET_STEP;
    const out = applyTextBudget(snapshots(n), OPTS);
    expect(maskedIndexes(out.messages)).toEqual(Array.from({ length: expected }, (_, i) => i));
    expect(out.report.elidedParts).toBe(expected);
  });

  it("masks only browse_act, browse_snapshot and browse_open", () => {
    const names = ["browse_act", "browse_snapshot", "browse_open", "browse_read", "fetch_url", "web_search", "lookup_skill", "browse_screenshot"];
    // Each tool twice, so the first copy is not the newest of its tool.
    const messages = [
      ...[...names, ...names].map((n, i) => result(`a${i}`, n, textOut(BIG))),
      ...snapshots(10, "other_tool"),
    ];
    expect(maskedIndexes(applyTextBudget(messages, OPTS).messages)).toEqual([0, 1, 2]);
  });

  it("keeps the newest result of each masked tool even past the cutoff", () => {
    const messages = [
      result("old", "browse_snapshot", textOut(BIG)),
      result("act", "browse_act", textOut(BIG)),
      result("last", "browse_snapshot", textOut(BIG)),
      ...snapshots(12, "other_tool"),
    ];
    // cutoff = 10 covers all three browse results; only the older snapshot goes.
    expect(maskedIndexes(applyTextBudget(messages, OPTS).messages)).toEqual([0]);
  });

  it("never masks a content output that carries an image", () => {
    const withImage = (id: string) =>
      result(id, "browse_snapshot", {
        type: "content",
        value: [{ type: "text", text: "t".repeat(BIG) }, { type: "image-data", data: "d", mediaType: "image/png" }],
      });
    const messages = [withImage("i1"), withImage("i2"), ...snapshots(10, "other_tool")];
    expect(applyTextBudget(messages, OPTS).report.elidedParts).toBe(0);
  });

  it("never masks results at or under MASK_MIN_CHARS", () => {
    const messages = [result("s", "browse_act", textOut(MASK_MIN_CHARS)), ...snapshots(10, "other_tool")];
    expect(applyTextBudget(messages, OPTS).report.elidedParts).toBe(0);
  });

  it("never masks error outputs", () => {
    const messages = [
      result("e1", "browse_act", { type: "error-text", value: "e".repeat(BIG) }),
      result("e2", "browse_act", { type: "error-json", value: { m: "e".repeat(BIG) } }),
      ...snapshots(10, "other_tool"),
    ];
    expect(applyTextBudget(messages, OPTS).report.elidedParts).toBe(0);
  });

  it("masks json outputs by serialized length and leaves content outputs' images out of the size", () => {
    const messages = [
      result("j", "browse_open", { type: "json", value: { page: "p".repeat(BIG) } }),
      result("j2", "browse_open", textOut(10)),
      result("c", "browse_snapshot", {
        type: "content",
        value: [{ type: "image-data", data: "d".repeat(BIG * 10), mediaType: "image/png" }, { type: "text", text: "short" }],
      }),
      ...snapshots(8, "other_tool"),
    ];
    const out = applyTextBudget(messages, OPTS);
    expect(maskedIndexes(out.messages)).toEqual([0]);
    expect(out.report.totalChars).toBe(JSON.stringify({ page: "p".repeat(BIG) }).length + 10 + "short".length + 8 * BIG);
  });

  it("placeholder keeps the head of the original result", () => {
    const original = `{"url":"https://shop.test/cart","changed":true}${"y".repeat(BIG)}`;
    const messages = [
      result("p", "browse_act", { type: "text", value: original }),
      result("p2", "browse_act", textOut(10)),
      ...snapshots(10),
    ];
    const value = (outputsOf(applyTextBudget(messages, OPTS).messages)[0] as { value: string }).value;
    expect(value).toContain(`Start of the result: ${original.slice(0, MASKED_HEAD_CHARS)}]`);
    expect(value.length).toBeLessThan(MASKED_HEAD_CHARS + 400);
  });

  it("placeholder is byte-identical for the same tool and output", () => {
    const a = applyTextBudget(snapshots(10), OPTS).messages;
    const b = applyTextBudget([...snapshots(10), ...snapshots(3, "other_tool")], OPTS).messages;
    expect(outputsOf(a)[0]).toEqual({ type: "text", value: textBudgetPlaceholder("browse_snapshot", "x".repeat(BIG)) });
    expect(outputsOf(a)[0]).toEqual(outputsOf(b)[0]);
  });

  it("is monotone: a masked part stays masked and the output moves only at step boundaries", () => {
    const base = snapshots(13);
    const grown = [...base, result("c13", "browse_snapshot", textOut(BIG))];
    const before = applyTextBudget(base, OPTS).messages;
    const after = applyTextBudget(grown, OPTS).messages;
    expect(after.slice(0, 13)).toEqual(before);
    const crossing = applyTextBudget([...grown, result("c14", "browse_act", textOut(BIG))], OPTS).messages;
    expect(maskedIndexes(crossing).length).toBe(10);
    expect(maskedIndexes(crossing).slice(0, maskedIndexes(before).length)).toEqual(maskedIndexes(before));
  });

  it("does not mutate its input", () => {
    const messages = snapshots(12);
    const snapshot = JSON.stringify(messages);
    const out = applyTextBudget(messages, OPTS);
    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(out.messages).not.toBe(messages);
    expect(out.messages[11]).toBe(messages[11]);
  });

  it("reports consistent counts in plan and apply", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "u".repeat(400) },
      ...snapshots(12),
    ];
    const plan = planTextBudget(messages, OPTS);
    expect(plan).toEqual(applyTextBudget(messages, OPTS).report);
    expect(plan).toEqual({
      estimatedTokens: Math.ceil((400 + 12 * BIG) / 4),
      toolResults: 12,
      elidedParts: 5,
      elidedChars: 5 * BIG,
      totalChars: 400 + 12 * BIG,
    });
  });
});

describe("prepareChatTurn — TEXT_BUDGET_MODE", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  const uiMessages = [
    { id: "u", role: "user", parts: [{ type: "text", text: "go" }] },
    ...Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      role: "assistant",
      parts: [
        {
          type: "tool-browse_snapshot",
          toolCallId: `call-${i}`,
          state: "output-available",
          input: {},
          output: `PAGE${i}${"x".repeat(BIG)}`,
        },
      ],
    })),
  ];

  async function historyFor(mode: "off" | "shadow" | "enforce") {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const turn = await prepareChatTurn({
      config: makeConfig({ TEXT_BUDGET_MODE: mode, TEXT_BUDGET_START_TOKENS: 0 }),
      messages: uiMessages,
    });
    return { json: JSON.stringify(turn.modelMessages), report: turn.textBudget };
  }

  it("shadow reports but sends the unchanged history; enforce sends the masked one; off reports nothing", async () => {
    const off = await historyFor("off");
    const shadow = await historyFor("shadow");
    const enforce = await historyFor("enforce");
    expect(off.report).toBeUndefined();
    expect(shadow.json).toBe(off.json);
    expect(shadow.report).toMatchObject({ mode: "shadow", elidedParts: 5 });
    expect(enforce.report).toMatchObject({ mode: "enforce", elidedParts: 5 });
    expect(enforce.json).not.toContain(`PAGE0${"x".repeat(MASKED_HEAD_CHARS)}`);
    expect(enforce.json).toContain(`PAGE11${"x".repeat(BIG)}`);
    expect(enforce.json).toContain("[Earlier browse_snapshot result shortened");
  });
});
