import { describe, expect, it, vi } from "vitest";
import { runTasteCheck } from "../src/ai/tasteCheck.js";
import { makeConfig } from "./helpers.js";
import { runGrader, trialPassed, levenshtein, type GraderContext } from "../src/evals/graders.js";
import type { GraderSpec, Outcome, OutcomeEmbed, ToolCallRecord } from "../src/evals/types.js";

vi.mock("../src/ai/tasteCheck.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/tasteCheck.js")>();
  return {
    ...actual,
    runTasteCheck: vi.fn(async (_client: unknown, _config: unknown, input: { screens: Array<{ id: string; name?: string }> }) => ({
      outcome: "checked",
      screens: input.screens.map((s) => ({ id: s.id, name: s.name, findings: [] })),
      feedback: null,
    })),
  };
});

const HTML = "<html><body><p>x</p></body></html>";
const embed = (over: Partial<OutcomeEmbed> = {}): OutcomeEmbed => ({
  name: "A",
  width: 390,
  height: 844,
  x: 0,
  y: 0,
  htmlContent: HTML,
  ...over,
});
const call = (name: string, args: unknown = {}, result = ""): ToolCallRecord => ({ index: 0, name, args, result });

function ctx(over: {
  outcome?: Partial<Outcome>;
  calls?: ToolCallRecord[];
  finalText?: string;
  hadMcpTools?: boolean;
}): GraderContext {
  const toolCalls = (over.calls ?? []).map((c, index) => ({ ...c, index }));
  return {
    task: { id: "t", suite: "regression", mode: "prototype", prompt: "p", graders: [], source: "s" },
    outcome: { embeds: [], issuedImageUrls: [], batchOperations: [], generatedImageCalls: 0, ...over.outcome },
    transcript: { toolCalls, finalText: over.finalText ?? "", steps: 1, finishReason: "stop" },
    hadMcpTools: over.hadMcpTools ?? true,
    systemOne: null,
    config: makeConfig(),
  };
}

const ins = (type: string, extra = "") => `a=I(document, {type: "${type}", name: "A"${extra}})`;

// spec, passing context, failing context
const cases: Array<[string, GraderSpec, GraderContext, GraderContext]> = [
  [
    "embeds-present",
    { type: "embeds-present", min: 2 },
    ctx({ outcome: { embeds: [embed(), embed()] } }),
    ctx({ outcome: { embeds: [embed()] } }),
  ],
  [
    "embed-only",
    { type: "embed-only" },
    ctx({ outcome: { batchOperations: [ins("embed", ', htmlContent: "<p>x</p>"')] } }),
    ctx({ outcome: { batchOperations: [ins("frame")] } }),
  ],
  [
    "box-size",
    { type: "box-size", platform: "mobile" },
    ctx({ outcome: { embeds: [embed()] } }),
    ctx({ outcome: { embeds: [embed({ width: 400 })] } }),
  ],
  [
    "filmstrip",
    { type: "filmstrip" },
    ctx({ outcome: { embeds: [embed({ x: 0 }), embed({ x: 1120 })] } }),
    ctx({ outcome: { embeds: [embed({ x: 0 }), embed({ x: 0 })] } }),
  ],
  [
    "html-complete",
    { type: "html-complete" },
    ctx({ outcome: { embeds: [embed()], batchOperations: [ins("embed", ', htmlContent: "<p>x</p>"')] } }),
    ctx({ outcome: { embeds: [embed()], batchOperations: [ins("embed")] } }),
  ],
  [
    "image-urls-issued",
    { type: "image-urls-issued" },
    ctx({
      outcome: {
        embeds: [embed({ htmlContent: '<img src="https://cdn.example/a/1.png"><img src="https://picsum.photos/1">' })],
        issuedImageUrls: ["https://cdn.example/a/1.png"],
      },
    }),
    ctx({
      outcome: {
        embeds: [embed({ htmlContent: '<img src="https://cdn.example/a/1.pnq">' })],
        issuedImageUrls: ["https://cdn.example/a/1.png"],
      },
    }),
  ],
  [
    "image-budget",
    { type: "image-budget" },
    ctx({ outcome: { generatedImageCalls: 8 } }),
    ctx({ outcome: { generatedImageCalls: 9 } }),
  ],
  [
    "asked-first",
    { type: "asked-first" },
    ctx({ calls: [call("ask_user"), call("batch_design")] }),
    ctx({ calls: [call("batch_design"), call("ask_user")] }),
  ],
  [
    "not-asked",
    { type: "not-asked" },
    ctx({ calls: [call("batch_design")] }),
    ctx({ calls: [call("ask_user")] }),
  ],
  [
    "skill-loaded-first",
    { type: "skill-loaded-first", skill: "prototype" },
    ctx({ calls: [call("load_skill", { name: "prototype" }), call("batch_design")] }),
    ctx({ calls: [call("batch_design"), call("load_skill", { name: "prototype" })] }),
  ],
  [
    "grounded-refs",
    { type: "grounded-refs" },
    ctx({ calls: [call("search_screens", {}, "see https://m.example/s/1")], finalText: "Ref: https://m.example/s/1." }),
    ctx({ calls: [call("search_screens", {}, "see https://m.example/s/1")], finalText: "Ref: https://made.up/x" }),
  ],
];

describe("deterministic eval graders", () => {
  it.each(cases)("%s passes on a good fixture", async (_n, spec, good) => {
    expect((await runGrader(spec, good)).status).toBe("pass");
  });

  it.each(cases)("%s fails on a bad fixture", async (_n, spec, _good, bad) => {
    const result = await runGrader(spec, bad);
    expect(result.status).toBe("fail");
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it("names the mistyped URL in the detail", async () => {
    const [, spec, , bad] = cases[5];
    expect((await runGrader(spec, bad)).detail).toContain("mistyped copy");
  });

  it("fails a typo of an issued picsum URL instead of letting the stock host pass it", async () => {
    const issued = "https://picsum.photos/seed/travel-feed/800/600";
    const typo = ctx({
      outcome: { embeds: [embed({ htmlContent: '<img src="https://picsum.photos/seed/travel-fead/800/600">' })], issuedImageUrls: [issued] },
    });
    const result = await runGrader({ type: "image-urls-issued" }, typo);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("mistyped copy");
    const exact = ctx({ outcome: { embeds: [embed({ htmlContent: `<img src="${issued}">` })], issuedImageUrls: [issued] } });
    expect((await runGrader({ type: "image-urls-issued" }, exact)).status).toBe("pass");
    const stock = ctx({ outcome: { embeds: [embed({ htmlContent: '<img src="https://picsum.photos/id/1/10/10">' })], issuedImageUrls: [issued] } });
    expect((await runGrader({ type: "image-urls-issued" }, stock)).status).toBe("pass");
  });

  it("html-complete tolerates a replaced screen (more embed ops than final embeds)", async () => {
    const op = ins("embed", ', htmlContent: "<p>x</p>"');
    const replaced = ctx({ outcome: { embeds: [embed()], batchOperations: [op, op] } });
    expect((await runGrader({ type: "html-complete" }, replaced)).status).toBe("pass");
  });

  it("skill-loaded-first passes when prepareChatTurn injected the skill, even before batch_design", async () => {
    const spec: GraderSpec = { type: "skill-loaded-first", skill: "prototype" };
    const injected = ctx({ calls: [call("batch_design")], outcome: { injectedSkill: "prototype", skillSource: "slash" } });
    expect((await runGrader(spec, injected)).status).toBe("pass");
    const other = ctx({ calls: [call("batch_design")], outcome: { injectedSkill: "slides", skillSource: "auto" } });
    expect((await runGrader(spec, other)).status).toBe("fail");
  });

  it("taste-clean passes the task prompt as brief and chunks screens at the request cap", async () => {
    const many = ctx({ outcome: { embeds: Array.from({ length: 10 }, (_, i) => embed({ name: `S${i}` })) } });
    const result = await runGrader({ type: "taste-clean" }, { ...many, systemOne: {} as GraderContext["systemOne"] });
    expect(result.status).toBe("pass");
    const calls = vi.mocked(runTasteCheck).mock.calls;
    expect(calls.map((c) => c[2].screens.length)).toEqual([8, 2]);
    expect(calls.map((c) => c[2].brief)).toEqual(["p", "p"]);
  });

  it("skips grounded-refs without MCP tools", async () => {
    const result = await runGrader({ type: "grounded-refs" }, ctx({ hadMcpTools: false }));
    expect(result).toMatchObject({ status: "skipped", detail: "no_mcp_tools" });
  });

  it("skips taste-clean without a SystemOne client", async () => {
    const result = await runGrader({ type: "taste-clean" }, ctx({ outcome: { embeds: [embed()] } }));
    expect(result.status).toBe("skipped");
  });

  it("trialPassed needs no fail and one non-skipped grader", () => {
    const r = (status: "pass" | "fail" | "skipped") => ({ id: "embed-only" as const, status, detail: "" });
    expect(trialPassed([r("pass"), r("skipped")])).toBe(true);
    expect(trialPassed([r("pass"), r("fail")])).toBe(false);
    expect(trialPassed([r("skipped")])).toBe(false);
  });

  it("measures edit distance", () => {
    expect(levenshtein("abc", "abd")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});
