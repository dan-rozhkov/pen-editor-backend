import { describe, expect, it } from "vitest";
import { routeSkill } from "../src/ai/skillRouting.js";
import type {
  SystemOneAnswer,
  SystemOneChoiceAnswer,
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneQuestion,
} from "../src/services/systemone.js";

// Hand-written fake client — no network, no global fetch stub — mirroring
// the SystemOneClient interface directly (same style as test/triage.test.ts).
function fakeClient(
  answer: SystemOneChoiceAnswer,
  opts: {
    model?: string;
    capture?: (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) => void;
  } = {},
): SystemOneClient {
  return {
    async evaluate(params) {
      opts.capture?.(params);
      return {
        model: opts.model ?? "jev-latest",
        answers: { skill: answer } as never,
        usage: { input_tokens: 100, output_tokens: 10 },
      };
    },
  };
}

function throwingClient(err: Error): SystemOneClient {
  return {
    async evaluate() {
      throw err;
    },
  };
}

const candidates = [
  { name: "prototype", description: "Design a clickable prototype." },
  { name: "slides", description: "Build a slide deck." },
];

describe("routeSkill", () => {
  it("returns the picked skill when confidence meets the threshold", async () => {
    const client = fakeClient({
      type: "choice",
      choice: "prototype",
      probabilities: { prototype: 0.9, slides: 0.05, none: 0.05 },
      confidence: 0.9,
    });
    const verdict = await routeSkill(client, {
      messageText: "design a login screen prototype",
      candidates,
      threshold: 0.7,
    });
    expect(verdict.skill).toBe("prototype");
    expect(verdict.reason).toBe("picked");
    expect(verdict.model).toBe("jev-latest");
  });

  it("returns skill: null when the model picks 'none'", async () => {
    const client = fakeClient({
      type: "choice",
      choice: "none",
      probabilities: { prototype: 0.1, slides: 0.1, none: 0.8 },
      confidence: 0.8,
    });
    const verdict = await routeSkill(client, {
      messageText: "make the header bigger",
      candidates,
      threshold: 0.7,
    });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("none");
  });

  it("returns skill: null with reason low-confidence when below the threshold", async () => {
    const client = fakeClient({
      type: "choice",
      choice: "prototype",
      probabilities: { prototype: 0.5, slides: 0.3, none: 0.2 },
      confidence: 0.69,
    });
    const verdict = await routeSkill(client, {
      messageText: "something ambiguous",
      candidates,
      threshold: 0.7,
    });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("low-confidence");
  });

  it("treats confidence exactly equal to the threshold as confident (boundary)", async () => {
    const client = fakeClient({
      type: "choice",
      choice: "prototype",
      probabilities: { prototype: 0.7, slides: 0.2, none: 0.1 },
      confidence: 0.7,
    });
    const verdict = await routeSkill(client, {
      messageText: "design a login screen prototype",
      candidates,
      threshold: 0.7,
    });
    expect(verdict.skill).toBe("prototype");
    expect(verdict.reason).toBe("picked");
  });

  it("fails open when the client throws", async () => {
    const client = throwingClient(new Error("rate limited"));
    const verdict = await routeSkill(client, {
      messageText: "design a login screen prototype",
      candidates,
      threshold: 0.7,
    });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("error");
    expect(verdict.model).toBeNull();
  });

  it("fails open when the answer is a non-choice type (noul/score) for the choice question", async () => {
    const wrongTypeAnswer: SystemOneAnswer = { type: "noul", noul: 0.9 };
    const client: SystemOneClient = {
      async evaluate() {
        return {
          model: "jev-latest",
          answers: { skill: wrongTypeAnswer } as never,
          usage: { input_tokens: 10, output_tokens: 1 },
        };
      },
    };
    const verdict = await routeSkill(client, {
      messageText: "design a login screen prototype",
      candidates,
      threshold: 0.7,
    });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("error");
    expect(() => verdict.confidence.toFixed(2)).not.toThrow();
  });

  it("sends every curated skill name AND the none option in criteria", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = fakeClient(
      {
        type: "choice",
        choice: "none",
        probabilities: { prototype: 0.1, slides: 0.1, none: 0.8 },
        confidence: 0.8,
      },
      { capture: (params) => { captured = params; } },
    );
    await routeSkill(client, {
      messageText: "hello",
      candidates,
      threshold: 0.7,
    });
    const question = captured?.questions.skill;
    expect(question?.type).toBe("choice");
    const criteria = (question as { criteria: Record<string, string | null> }).criteria;
    expect(Object.keys(criteria).sort()).toEqual(["none", "prototype", "slides"].sort());
  });
});
