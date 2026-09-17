import { beforeEach, describe, expect, it } from "vitest";
import { routeSkill, resetSkillRouteCacheForTests } from "../src/ai/skillRouting.js";
import type {
  SystemOneAnswer,
  SystemOneChoiceAnswer,
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneQuestion,
} from "../src/services/systemone.js";

// Hand-written fake client — no network, no global fetch stub — mirroring
// the SystemOneClient interface directly — no network, no HTTP stubbing.
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
  // routeSkill memoizes per (text, candidates, threshold) so a tool-loop
  // continuation does not re-pay for Jev; that cache is module-level, so
  // each test must start from empty or it answers with a neighbour's fake.
  beforeEach(() => resetSkillRouteCacheForTests());

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

  it("truncates the routed text before it reaches the vendor", async () => {
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
    const longText = "a".repeat(5_000);

    await routeSkill(client, { messageText: longText, candidates, threshold: 0.7 });

    // scrubPii runs AFTER truncation and only ever shrinks or preserves
    // length (it redacts matches in place) — so a bound is the right
    // assertion here, not an exact length that would depend on scrubbing.
    const sentLength = String(captured?.state).length;
    expect(sentLength).toBeGreaterThan(0);
    expect(sentLength).toBeLessThanOrEqual(2_000);
  });

  it("excludes a candidate literally named \"none\" instead of clobbering the no-match sentinel", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const collidingCandidates = [
      ...candidates,
      { name: "none", description: "a real skill someone named 'none'" },
    ];
    const client = fakeClient(
      {
        type: "choice",
        choice: "none",
        probabilities: { prototype: 0.1, slides: 0.1, none: 0.8 },
        confidence: 0.8,
      },
      { capture: (params) => { captured = params; } },
    );

    const verdict = await routeSkill(client, {
      messageText: "hello",
      candidates: collidingCandidates,
      threshold: 0.7,
    });

    const question = captured?.questions.skill;
    const criteria = (question as { criteria: Record<string, string | null> }).criteria;
    // Still exactly three options — the colliding candidate was dropped,
    // not merged under the sentinel's key.
    expect(Object.keys(criteria).sort()).toEqual(["none", "prototype", "slides"].sort());
    // The sentinel's own description must survive untouched, proving the
    // candidate never got to overwrite criteria.none.
    expect(criteria.none).not.toBe("a real skill someone named 'none'");

    // And the sentinel still means what it always meant: a vendor answer of
    // choice:"none" is "no match", not "the user asked for the none skill".
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("none");
  });

  describe("verdict cache", () => {
    it("spares the vendor on a repeat call with an identical (text, candidates, threshold) key", async () => {
      const calls = { count: 0 };
      const client = fakeClient(
        {
          type: "choice",
          choice: "prototype",
          probabilities: { prototype: 0.9, slides: 0.05, none: 0.05 },
          confidence: 0.9,
        },
        { capture: () => { calls.count += 1; } },
      );
      const opts = { messageText: "design a login screen prototype", candidates, threshold: 0.7 };

      const first = await routeSkill(client, opts);
      const second = await routeSkill(client, opts);

      expect(calls.count).toBe(1);
      expect(second).toEqual(first);
    });

    it("misses the cache when the threshold changes", async () => {
      const calls = { count: 0 };
      const client = fakeClient(
        {
          type: "choice",
          choice: "prototype",
          probabilities: { prototype: 0.9, slides: 0.05, none: 0.05 },
          confidence: 0.9,
        },
        { capture: () => { calls.count += 1; } },
      );

      await routeSkill(client, { messageText: "design a login screen prototype", candidates, threshold: 0.7 });
      await routeSkill(client, { messageText: "design a login screen prototype", candidates, threshold: 0.8 });

      expect(calls.count).toBe(2);
    });

    it("misses the cache when the candidate list changes", async () => {
      const calls = { count: 0 };
      const client = fakeClient(
        {
          type: "choice",
          choice: "prototype",
          probabilities: { prototype: 0.9, slides: 0.05, none: 0.05 },
          confidence: 0.9,
        },
        { capture: () => { calls.count += 1; } },
      );

      await routeSkill(client, { messageText: "design a login screen prototype", candidates, threshold: 0.7 });
      await routeSkill(client, {
        messageText: "design a login screen prototype",
        candidates: [...candidates, { name: "onboarding", description: "Build an onboarding flow." }],
        threshold: 0.7,
      });

      expect(calls.count).toBe(2);
    });

    it("does not cache an error verdict, so a client that recovers on the next call is used", async () => {
      let attempt = 0;
      const client: SystemOneClient = {
        async evaluate() {
          attempt += 1;
          if (attempt === 1) throw new Error("rate limited");
          return {
            model: "jev-latest",
            answers: {
              skill: {
                type: "choice",
                choice: "prototype",
                probabilities: { prototype: 0.9, slides: 0.05, none: 0.05 },
                confidence: 0.9,
              },
            } as never,
            usage: { input_tokens: 10, output_tokens: 1 },
          };
        },
      };
      const opts = { messageText: "design a login screen prototype", candidates, threshold: 0.7 };

      const first = await routeSkill(client, opts);
      expect(first.reason).toBe("error");

      const second = await routeSkill(client, opts);
      expect(second.reason).toBe("picked");
      expect(attempt).toBe(2);
    });
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
