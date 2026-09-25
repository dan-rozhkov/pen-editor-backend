import { describe, expect, it, vi } from "vitest";
import { makeConfig } from "./helpers.js";

// See test/structuredModelFakes.ts's HOISTING CONTRACT comment.
vi.mock("../src/ai/provider.js", async (importOriginal) =>
  (await import("./structuredModelFakes.js")).mockProviderModule(await importOriginal()),
);

import { createModel, mockJsonModelOnce } from "./structuredModelFakes.js";
import { choice, fakeClient } from "./browseFakes.js";
import type { SystemOneAnswer, SystemOneEvaluateParams, SystemOneQuestion } from "../src/services/systemone.js";
import type { BrowseStepElement, BrowseStepInput } from "../src/ai/browseStep.js";

const { decideBrowseStepUltrafast, buildUltrafastQuestions, withRememberedSelections } = await import("../src/ai/browseStepUltrafast.js");

const config = makeConfig({ TYPESAFE_API_KEY: "key" });

const FORM: BrowseStepElement[] = [
  { index: 0, tag: "input", label: "First name", ops: ["TYPE_TEXT"], value: "Anna" },
  { index: 1, tag: "input", label: "Last name", ops: ["TYPE_TEXT"], value: "" },
  { index: 2, tag: "input", label: "Email", ops: ["TYPE_TEXT"], hasValue: true },
  { index: 3, tag: "select", label: "Country", ops: ["SELECT"], options: ["Select…", "France", "Germany"], value: "France" },
  { index: 4, tag: "input", label: "I accept the terms", ops: ["CLICK"], checked: false },
  { index: 5, tag: "button", label: "Create account", ops: ["CLICK"] },
];

function input(overrides: Partial<BrowseStepInput> = {}): BrowseStepInput {
  return {
    goal: "Register as Anna Petrova from Germany and accept the terms",
    url: "https://example.com/register",
    title: "Register",
    elements: FORM,
    history: [],
    pageText: "Create your account",
    ...overrides,
  };
}

type Captured = SystemOneEvaluateParams<Record<string, SystemOneQuestion>>;

async function decide(answers: Record<string, SystemOneAnswer>, overrides: Partial<BrowseStepInput> = {}) {
  let captured: Captured | undefined;
  const result = await decideBrowseStepUltrafast(
    fakeClient(answers, { capture: (p) => (captured = p) }),
    config,
    input(overrides),
  );
  return { result, captured: captured! };
}

/** One-shot text-helper response; returns the prompt it was sent. */
function mockFieldText(text: string | null): () => string {
  return mockJsonModelOnce({ text }).seenPrompt;
}

describe("buildUltrafastQuestions", () => {
  const built = buildUltrafastQuestions("the goal", FORM, { y: 0, height: 900, atBottom: true });

  it("puts the goal and the next-step rules into every question's instructions", () => {
    for (const q of Object.values(built.questions)) {
      expect(q.instructions).toMatchObject({ goal: "the goal" });
      expect(JSON.stringify(q.instructions)).toContain("Do not repeat satisfied steps");
    }
    expect(JSON.stringify(built.questions.type_text_target.instructions)).toContain(
      "Do not choose a field that already contains the requested value",
    );
  });

  it("offers DONE/BLOCKED as operations and drops scrolls the page can't make", () => {
    expect(built.operations).toEqual(expect.arrayContaining(["CLICK", "TYPE_TEXT", "SELECT", "WAIT", "DONE", "BLOCKED"]));
    expect(built.operations).not.toContain("SCROLL_UP");
    expect(built.operations).not.toContain("SCROLL_DOWN");
  });

  it("repeats each field's current state in its target criterion", () => {
    const typeTargets = built.questions.type_text_target.type === "choice" ? built.questions.type_text_target.criteria : {};
    expect(typeTargets["0"]).toMatchObject({ element: "[0] First name", current_value: "Anna" });
    expect(typeTargets["1"]).toMatchObject({ current_value: "" });
    expect(typeTargets["2"]).toMatchObject({ current_value: "(filled; value hidden)" });
    const clickTargets = built.questions.click_target.type === "choice" ? built.questions.click_target.criteria : {};
    expect(clickTargets["4"]).toMatchObject({ checked: false });
  });

  it("makes every unselected, non-empty <select> option its own target", () => {
    const selectTargets = built.questions.select_target.type === "choice" ? built.questions.select_target.criteria : {};
    expect(Object.keys(selectTargets)).toEqual(["3:1", "3:3"]);
    expect(selectTargets["3:3"]).toMatchObject({ element: "[3] Country → Germany", current_value: "France" });
  });
});

describe("decideBrowseStepUltrafast", () => {
  it("sends page text, element state and recent actions, scrubbing PII", async () => {
    const { captured } = await decide(
      { operation: choice("WAIT", 0.9) },
      {
        pageText: "Signed in as anna@example.com",
        history: [{ operation: "TYPE_TEXT", label: 'TYPE_TEXT "Anna" into "First name"', ok: true, index: 0 }],
      },
    );
    const state = captured.state as {
      page: { text: string };
      elements: Array<Record<string, unknown>>;
      recent_actions: Array<Record<string, unknown>>;
    };
    expect(state.page.text).not.toContain("anna@example.com");
    expect(state.elements[0]).toMatchObject({ label: "First name", value: "Anna" });
    expect(state.elements[3]).toMatchObject({ value: "France" });
    expect(state.elements[4]).toMatchObject({ checked: false });
    expect(state.recent_actions[0]).toMatchObject({ action: 'TYPE_TEXT "Anna" into "First name"', ok: true });
  });

  it.each([
    ["DONE", "done"],
    ["BLOCKED", "blocked"],
    ["WAIT", "act"],
  ])("maps operation %s to outcome %s", async (op, outcome) => {
    const { result } = await decide({ operation: choice(op, 0.9) });
    expect(result.outcome).toBe(outcome);
  });

  it.each([
    ["DONE", "CLICK"],
    ["BLOCKED", "CLICK"],
  ])("demotes an unconfident %s to the runner-up operation", async (terminal) => {
    const { result } = await decide({
      operation: choice(terminal, 0.3, { probabilities: { [terminal]: 0.3, CLICK: 0.25, WAIT: 0.2 } }),
      click_target: choice("5", 0.9),
    });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 5 });
  });

  it("reports a <select> an older desktop build left unreported as unknown, not filled", () => {
    const legacySelect: BrowseStepElement = {
      index: 7,
      tag: "select",
      label: "Country",
      ops: ["SELECT"],
      options: ["Select a country", "Germany"],
      hasValue: true,
    };
    const { questions } = buildUltrafastQuestions("goal", [legacySelect], undefined);
    const criteria = questions.select_target.type === "choice" ? questions.select_target.criteria : {};
    expect(criteria["7:2"]).toMatchObject({ current_value: "(unknown)" });
  });

  it("remembers a <select> choice from history when the snapshot doesn't report it", () => {
    const legacySelect: BrowseStepElement = { index: 7, tag: "select", label: "Country", ops: ["SELECT"], options: ["Germany"], hasValue: true };
    const history = [
      { operation: "SELECT", label: 'SELECT "France" in "Country"', ok: true, index: 7 },
      { operation: "SELECT", label: 'SELECT "Germany" in "Country"', ok: true, index: 7 },
      { operation: "SELECT", label: 'SELECT "Spain" in "Country" (no effect)', ok: false, index: 7 },
    ];
    expect(withRememberedSelections([legacySelect], history)[0].value).toBe("Germany");
    expect(withRememberedSelections([{ ...legacySelect, value: "Italy" }], history)[0].value).toBe("Italy");
  });

  it("acts on the argmax target however low its peak (no gates)", async () => {
    const { result } = await decide({ operation: choice("CLICK", 0.4), click_target: choice("4", 0.3) });
    expect(result).toMatchObject({ outcome: "act", operation: "CLICK", index: 4 });
  });

  it("returns a SELECT with the chosen option's text and no text-model call", async () => {
    createModel.mockClear();
    const { result } = await decide({ operation: choice("SELECT", 0.9), select_target: choice("3:3", 0.9) });
    expect(result).toMatchObject({ outcome: "act", operation: "SELECT", index: 3, text: "Germany" });
    expect(createModel).not.toHaveBeenCalled();
  });

  it("asks the text model for the value of the CHOSEN field", async () => {
    const prompt = mockFieldText("Petrova");
    const { result } = await decide({ operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("1", 0.9) });
    expect(result).toMatchObject({ outcome: "act", operation: "TYPE_TEXT", index: 1, text: "Petrova", textSource: "llm" });
    expect(prompt()).toContain("Last name");
    expect(prompt()).toContain("Create your account");
  });

  it("blocks when the goal holds no value for the chosen field", async () => {
    mockFieldText(null);
    const { result } = await decide({ operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("1", 0.9) });
    expect(result.outcome).toBe("blocked");
  });

  it.each([
    ["typing into a password field", { operation: choice("TYPE_TEXT", 0.9), type_text_target: choice("9", 0.9) }],
    ["pressing Enter with a password field on the page", { operation: choice("PRESS_ENTER", 0.9) }],
  ])("refuses %s", async (_name, answers) => {
    const { result } = await decide(answers, {
      elements: [...FORM, { index: 9, tag: "input", label: "Password", ops: ["TYPE_TEXT"], isPassword: true }],
    });
    expect(result.outcome).toBe("blocked");
  });

  it.each([
    ["an operation that was not offered", { operation: choice("SCROLL_UP", 0.9) }],
    ["a target that was not offered", { operation: choice("CLICK", 0.9), click_target: choice("0", 0.9) }],
    ["a missing target answer", { operation: choice("CLICK", 0.9) }],
  ])("retries on %s", async (_name, answers) => {
    const { result } = await decide(answers, { scroll: { y: 0, height: 900 } });
    expect(result.outcome).toBe("retry");
  });

  it("retries when Jev itself fails", async () => {
    const result = await decideBrowseStepUltrafast(fakeClient({}, { throwError: new Error("boom") }), config, input());
    expect(result).toMatchObject({ outcome: "retry" });
    expect(result.reason).toContain("boom");
  });
});
