import { describe, expect, it } from "vitest";
import { triageSession, TRIAGE_MAX_CHARS } from "../src/analysis/triage.js";
import { isEmptyInsights } from "../src/analysis/run.js";
import type { SessionInsights } from "../src/analysis/insights.js";
import type {
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneNoulAnswer,
  SystemOneQuestion,
} from "../src/services/systemone.js";

// Hand-written fake client — no network, no global fetch stub — mirroring the
// SystemOneClient interface directly.
function fakeClient(
  scores: Record<string, number>,
  opts: { model?: string; capture?: (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) => void } = {},
): SystemOneClient {
  return {
    async evaluate(params) {
      opts.capture?.(params);
      const answers: Record<string, SystemOneNoulAnswer> = {};
      for (const key of Object.keys(params.questions)) {
        answers[key] = { type: "noul", noul: scores[key] ?? 0 };
      }
      return {
        model: opts.model ?? "jev-latest",
        answers: answers as never,
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

describe("triageSession", () => {
  it("skips when all four scores are below the threshold", async () => {
    const client = fakeClient({
      errors: 0.01,
      corrections: 0.02,
      memory_requests: 0.0,
      agent_claims: 0.05,
    });
    const verdict = await triageSession(client, "session text", 0.15);
    expect(verdict.decision).toBe("skip");
    expect(verdict.reason).toBe("scored");
    expect(verdict.model).toBe("jev-latest");
  });

  it("extracts when exactly one score is at or above the threshold (boundary)", async () => {
    // A value exactly EQUAL to the threshold must NOT skip.
    const client = fakeClient({
      errors: 0.01,
      corrections: 0.15,
      memory_requests: 0.0,
      agent_claims: 0.0,
    });
    const verdict = await triageSession(client, "session text", 0.15);
    expect(verdict.decision).toBe("extract");
    expect(verdict.max).toBeCloseTo(0.15);
  });

  it("fails open to extract when an answer has an unexpected (non-noul) type", async () => {
    // The client's response schema accepts choice/score answers for any
    // question id, so a vendor change or mis-keyed answer could return one
    // of those for what should be a noul question. That must never silently
    // score 0 (which would bias toward "skip") — it must fail open instead.
    const client: SystemOneClient = {
      async evaluate(params) {
        const answers: Record<string, unknown> = {};
        for (const key of Object.keys(params.questions)) {
          answers[key] =
            key === "corrections"
              ? { type: "choice", choice: "yes", probabilities: { yes: 1 }, confidence: 1 }
              : { type: "noul", noul: 0 };
        }
        return {
          model: "jev-latest",
          answers: answers as never,
          usage: { input_tokens: 10, output_tokens: 1 },
        };
      },
    };
    const verdict = await triageSession(client, "session text", 0.15);
    expect(verdict.decision).toBe("extract");
    expect(verdict.reason).toBe("error");
  });

  it("fails open to extract when the client throws", async () => {
    const client = throwingClient(new Error("rate limited"));
    const verdict = await triageSession(client, "session text", 0.15);
    expect(verdict.decision).toBe("extract");
    expect(verdict.reason).toBe("error");
    expect(verdict.model).toBeNull();
  });

  it("sends PII-scrubbed state to the client", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = fakeClient(
      { errors: 0, corrections: 0, memory_requests: 0, agent_claims: 0 },
      { capture: (params) => { captured = params; } },
    );
    const raw = "Contact me at jane.doe@example.com or +1 415 555 0132 about this.";
    await triageSession(client, raw, 0.15);
    const state = String(captured?.state);
    expect(state).not.toContain("jane.doe@example.com");
    expect(state).not.toContain("415 555 0132");
  });

  it("sends all four question ids in a single evaluate() call", async () => {
    let calls = 0;
    let questionIds: string[] = [];
    const client = fakeClient(
      { errors: 0, corrections: 0, memory_requests: 0, agent_claims: 0 },
      {
        capture: (params) => {
          calls += 1;
          questionIds = Object.keys(params.questions);
        },
      },
    );
    await triageSession(client, "session text", 0.15);
    expect(calls).toBe(1);
    expect(questionIds.sort()).toEqual(
      ["agent_claims", "corrections", "errors", "memory_requests"].sort(),
    );
  });

  it("exports a max-chars constant smaller than the full transcript budget", () => {
    expect(TRIAGE_MAX_CHARS).toBeLessThan(200_000);
    expect(TRIAGE_MAX_CHARS).toBeGreaterThan(0);
  });
});

describe("isEmptyInsights", () => {
  const empty: SessionInsights = {
    errors: [],
    corrections: [],
    memory_requests: [],
    agent_claims: [],
  };

  it("is true when all four arrays are empty", () => {
    expect(isEmptyInsights(empty)).toBe(true);
  });

  it("is false when any array has an entry", () => {
    expect(
      isEmptyInsights({
        ...empty,
        corrections: [
          {
            what_agent_did: "a",
            what_user_wanted: "b",
            user_quote: "no",
            agent_complied: false,
          },
        ],
      }),
    ).toBe(false);
  });
});
