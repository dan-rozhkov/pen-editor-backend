import { beforeEach, describe, expect, it } from "vitest";
import {
  routeSkill,
  resetSkillRouteCacheForTests,
  SKILL_ROUTING_TIMEOUT_MS,
} from "../src/ai/skillRouting.js";
import type {
  SystemOneAnswer,
  SystemOneClient,
  SystemOneEvaluateParams,
  SystemOneQuestion,
} from "../src/services/systemone.js";

// Two-pass routing (ported from TypeSafe's skill-suggestion cookbook): pass
// 1 asks a Choice over every candidate plus three "does this turn need a
// skill at all?" Nouls (keyed "gate::<name>" in the request); pass 2 asks a
// Choice over the shortlist plus one "does THIS skill fit?" Noul per
// candidate (keyed "fits::<name>"). These builders read the actual
// `params.questions` sent by the code under test so tests don't have to
// duplicate the exact gate-question key spelling by hand.
function pass1Response(opts: {
  winner: string;
  probabilities: Record<string, number>;
  confidence: number;
  /** Raw (pre-orientation) noul overrides, keyed by the gate name WITHOUT
   * the "gate::" prefix. Anything not given defaults to a value that clears
   * SKILL_ROUTING_GATE_THRESHOLD's default (0.3) comfortably. */
  gate?: Partial<Record<"documented_workflow" | "substantial_new_work" | "direct_edit_suffices", number>>;
}) {
  return (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) => {
    const answers: Record<string, SystemOneAnswer> = {
      which: {
        type: "choice",
        choice: opts.winner,
        probabilities: opts.probabilities,
        confidence: opts.confidence,
      },
    };
    for (const key of Object.keys(params.questions)) {
      if (!key.startsWith("gate::")) continue;
      const name = key.slice("gate::".length) as keyof NonNullable<typeof opts.gate>;
      const fallback = name === "direct_edit_suffices" ? 0.1 : 0.9;
      answers[key] = { type: "noul", noul: opts.gate?.[name] ?? fallback };
    }
    return {
      model: "jev-latest",
      answers,
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  };
}

function gatedPass1Response(opts: { probabilities: Record<string, number> }) {
  // All three gate nouls oriented AWAY from needing a skill: the two
  // "needs a skill" nouls low, and the inverted "a direct edit suffices"
  // noul high (so 1 - 0.9 = 0.1 once oriented) — mean well under 0.30.
  return pass1Response({
    winner: Object.keys(opts.probabilities)[0],
    probabilities: opts.probabilities,
    confidence: 0.9,
    gate: { documented_workflow: 0.05, substantial_new_work: 0.05, direct_edit_suffices: 0.9 },
  });
}

function pass2Response(opts: {
  winner: string;
  confidence: number;
  fits: Record<string, number>;
  /** Peak-probability distribution for the winning Choice answer — the
   * value the winner gate actually reads (see peakProbability in
   * skillRouting.ts). Defaults to `{ [winner]: confidence }` so tests that
   * don't care about peak/confidence diverging keep behaving exactly as
   * before that gate moved off the vendor `confidence` field. */
  probabilities?: Record<string, number>;
}) {
  return (_params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) => {
    const answers: Record<string, SystemOneAnswer> = {
      which: {
        type: "choice",
        choice: opts.winner,
        probabilities: opts.probabilities ?? { [opts.winner]: opts.confidence },
        confidence: opts.confidence,
      },
    };
    for (const [name, noul] of Object.entries(opts.fits)) {
      answers[`fits::${name}`] = { type: "noul", noul };
    }
    return {
      model: "jev-latest",
      answers,
      usage: { input_tokens: 60, output_tokens: 6 },
    };
  };
}

type Stage = (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>) => {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

function stagedClient(
  stages: Stage[],
  opts: { capture?: (params: SystemOneEvaluateParams<Record<string, SystemOneQuestion>>, callIndex: number) => void } = {},
): SystemOneClient {
  let call = 0;
  return {
    async evaluate(params) {
      const index = call;
      call += 1;
      opts.capture?.(params, index);
      const stage = stages[Math.min(index, stages.length - 1)];
      return stage(params) as never;
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

function candidate(name: string, description: string, content = `Instructions for ${name}.`) {
  return { name, description, content };
}

const candidates = [
  candidate("prototype", "Design a clickable prototype."),
  candidate("slides", "Build a slide deck."),
  candidate("critique", "Run a structured design critique."),
  candidate("polish", "Polish visual details of an existing screen."),
];

const baseOpts = { candidates, threshold: 0.7, overallBudgetMs: 5_000 };

describe("routeSkill", () => {
  // routeSkill memoizes per (text, context, candidates, thresholds) so a
  // tool-loop continuation does not re-pay for Jev; that cache is
  // module-level, so each test must start from empty or it answers with a
  // neighbour's fake.
  beforeEach(() => resetSkillRouteCacheForTests());

  it("returns the pass-2 winner when the gate clears and a candidate fits confidently", async () => {
    const client = stagedClient([
      pass1Response({
        winner: "prototype",
        probabilities: { prototype: 0.6, slides: 0.25, critique: 0.1, polish: 0.05 },
        confidence: 0.6,
      }),
      pass2Response({
        winner: "prototype",
        confidence: 0.9,
        fits: { prototype: 0.85, slides: 0.2, critique: 0.05 },
      }),
    ]);

    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "design a clickable login screen prototype",
    });

    expect(verdict.skill).toBe("prototype");
    expect(verdict.reason).toBe("picked");
    expect(verdict.confidence).toBe(0.9);
    expect(verdict.model).toBe("jev-latest");
    expect(verdict.fits).toEqual({ prototype: 0.85, slides: 0.2, critique: 0.05 });
    expect(verdict.gate).toBeGreaterThanOrEqual(0.3);
    expect(verdict.pass1Winner).toBeUndefined();
  });

  describe("the gate", () => {
    it("short-circuits before pass 2 when the mean of the three gate nouls is below the threshold", async () => {
      let pass2Called = false;
      const client = stagedClient([
        gatedPass1Response({ probabilities: { prototype: 0.4, slides: 0.3, critique: 0.2, polish: 0.1 } }),
        (params) => {
          pass2Called = true;
          return pass2Response({ winner: "prototype", confidence: 0.9, fits: { prototype: 0.9 } })(params);
        },
      ]);

      const verdict = await routeSkill(client, {
        ...baseOpts,
        messageText: "make the header a little bigger",
      });

      expect(verdict.skill).toBeNull();
      expect(verdict.reason).toBe("gated");
      expect(verdict.gate).toBeLessThan(0.3);
      expect(pass2Called).toBe(false);
      expect(verdict.fits).toBeUndefined();
    });

    it("reports the three oriented gate values, with the inverted question flipped", async () => {
      const client = stagedClient([
        pass1Response({
          winner: "prototype",
          probabilities: { prototype: 0.9, slides: 0.1 },
          confidence: 0.9,
          gate: { documented_workflow: 0.8, substantial_new_work: 0.8, direct_edit_suffices: 0.2 },
        }),
        pass2Response({ winner: "prototype", confidence: 0.9, fits: { prototype: 0.9, slides: 0.1 } }),
      ]);

      const verdict = await routeSkill(client, {
        ...baseOpts,
        candidates: [candidate("prototype", "Design a clickable prototype."), candidate("slides", "Build a deck.")],
        messageText: "design a clickable login screen prototype",
      });

      // direct_edit_suffices came back 0.2 raw but must be reported oriented
      // (1 - 0.2 = 0.8) since a high value there means "does NOT need a
      // skill" — the opposite orientation of the other two.
      expect(verdict.gateValues?.direct_edit_suffices).toBeCloseTo(0.8);
      expect(verdict.gateValues?.documented_workflow).toBeCloseTo(0.8);
      expect(verdict.gate).toBeCloseTo((0.8 + 0.8 + 0.8) / 3);
    });
  });

  // Finding #1: the gate must read the WINNER's own fit, not the shortlist's
  // best fit — those can diverge when pass 2's Choice winner isn't the
  // candidate with the highest per-candidate Noul.
  it("gates on the pass-2 WINNER's own fit, not the shortlist's best fit, and injects nothing when the winner's own fit is low", async () => {
    const client = stagedClient([
      pass1Response({
        winner: "design-critique",
        probabilities: { "design-critique": 0.5, prototype: 0.3, slides: 0.2 },
        confidence: 0.5,
      }),
      pass2Response({
        winner: "design-critique",
        confidence: 0.9,
        // The Choice still picked design-critique, but ITS OWN fit noul is
        // low — prototype's noul is high only because it's a plausible
        // runner-up, not because it won the choice.
        fits: { "design-critique": 0.05, prototype: 0.92, slides: 0.1 },
      }),
    ]);

    const verdict = await routeSkill(client, {
      ...baseOpts,
      candidates: [
        candidate("design-critique", "Run a structured design critique."),
        candidate("prototype", "Design a clickable prototype."),
        candidate("slides", "Build a slide deck."),
      ],
      messageText: "build a clickable prototype of the onboarding flow",
    });

    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("no-fit");
    expect(verdict.winnerFit).toBe(0.05);
  });

  it("reports winnerFit and picks the skill when the WINNER's own fit clears the threshold", async () => {
    const client = stagedClient([
      pass1Response({
        winner: "prototype",
        probabilities: { prototype: 0.6, slides: 0.25, critique: 0.1, polish: 0.05 },
        confidence: 0.6,
      }),
      pass2Response({
        winner: "prototype",
        confidence: 0.9,
        fits: { prototype: 0.85, slides: 0.2, critique: 0.05 },
      }),
    ]);

    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "design a clickable login screen prototype",
    });

    expect(verdict.skill).toBe("prototype");
    expect(verdict.winnerFit).toBe(0.85);
  });

  it("drops the whole shortlist with reason no-fit when the best fits noul is below the threshold", async () => {
    const client = stagedClient([
      pass1Response({
        winner: "prototype",
        probabilities: { prototype: 0.5, slides: 0.3, critique: 0.15, polish: 0.05 },
        confidence: 0.5,
      }),
      pass2Response({
        winner: "prototype",
        confidence: 0.8,
        fits: { prototype: 0.2, slides: 0.1, critique: 0.05 },
      }),
    ]);

    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "post this to Mastodon",
    });

    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("no-fit");
    expect(verdict.fits).toEqual({ prototype: 0.2, slides: 0.1, critique: 0.05 });
  });

  it("drops the pass-2 winner with reason low-confidence when its Choice confidence misses the threshold", async () => {
    const client = stagedClient([
      pass1Response({
        winner: "prototype",
        probabilities: { prototype: 0.5, slides: 0.3, critique: 0.15, polish: 0.05 },
        confidence: 0.5,
      }),
      pass2Response({
        winner: "prototype",
        confidence: 0.5,
        fits: { prototype: 0.6, slides: 0.4, critique: 0.1 },
      }),
    ]);

    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "something ambiguous about a screen",
    });

    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("low-confidence");
    expect(verdict.confidence).toBe(0.5);
  });

  // Round-3 review finding: `confidence` is a deterministic function of the
  // peak AND the option count, so a fixed `threshold` demands a much higher
  // peak over pass 2's small 3-4-candidate shortlist than it would over pass
  // 1's full catalog. The winner gate must read peak probability instead —
  // these two tests exercise both directions of that divergence.
  describe("the winner gate reads PEAK PROBABILITY, not the vendor confidence field", () => {
    it("rejects a winner whose peak is below threshold even though its vendor confidence clears it", async () => {
      const client = stagedClient([
        pass1Response({
          winner: "prototype",
          probabilities: { prototype: 0.5, slides: 0.3, critique: 0.15, polish: 0.05 },
          confidence: 0.5,
        }),
        pass2Response({
          winner: "prototype",
          // Vendor confidence clears baseOpts.threshold (0.7)...
          confidence: 0.75,
          // ...but the winner's own peak probability does not.
          probabilities: { prototype: 0.65, slides: 0.35 },
          fits: { prototype: 0.9, slides: 0.1, critique: 0.1 },
        }),
      ]);

      const verdict = await routeSkill(client, {
        ...baseOpts,
        messageText: "design a clickable login screen prototype",
      });

      expect(verdict.skill).toBeNull();
      expect(verdict.reason).toBe("low-confidence");
      expect(verdict.confidence).toBe(0.75);
      expect(verdict.peak).toBe(0.65);
    });

    it("accepts a winner whose peak clears threshold even though its vendor confidence would not", async () => {
      const client = stagedClient([
        pass1Response({
          winner: "prototype",
          probabilities: { prototype: 0.5, slides: 0.3, critique: 0.15, polish: 0.05 },
          confidence: 0.5,
        }),
        pass2Response({
          winner: "prototype",
          // Vendor confidence misses baseOpts.threshold (0.7)...
          confidence: 0.68,
          // ...but the winner's own peak probability clears it.
          probabilities: { prototype: 0.75, slides: 0.25 },
          fits: { prototype: 0.9, slides: 0.1, critique: 0.1 },
        }),
      ]);

      const verdict = await routeSkill(client, {
        ...baseOpts,
        messageText: "design a clickable login screen prototype",
      });

      expect(verdict.skill).toBe("prototype");
      expect(verdict.reason).toBe("picked");
      expect(verdict.confidence).toBe(0.68);
      expect(verdict.peak).toBe(0.75);
    });

    it("fails open (reason budget) when pass 2's choice answer has an empty probabilities map", async () => {
      const client = stagedClient([
        pass1Response({
          winner: "prototype",
          probabilities: { prototype: 0.9, slides: 0.05, critique: 0.03, polish: 0.02 },
          confidence: 0.9,
        }),
        (params) => {
          const answers: Record<string, SystemOneAnswer> = {
            which: { type: "choice", choice: "prototype", probabilities: {}, confidence: 0.9 },
          };
          for (const key of Object.keys(params.questions)) {
            if (key.startsWith("fits::")) answers[key] = { type: "noul", noul: 0.9 };
          }
          return { model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 1 } };
        },
      ]);

      const verdict = await routeSkill(client, {
        ...baseOpts,
        messageText: "design a clickable login screen prototype",
      });

      expect(verdict.skill).toBeNull();
      expect(verdict.reason).toBe("budget");
      expect(verdict.pass1Winner).toBe("prototype");
    });
  });

  it("carries only the top 3 candidates by probability into the shortlist pass", async () => {
    let pass2Candidates: string[] = [];
    const client = stagedClient([
      pass1Response({
        winner: "polish",
        probabilities: { prototype: 0.1, slides: 0.05, critique: 0.35, polish: 0.5 },
        confidence: 0.5,
      }),
      pass2Response({ winner: "polish", confidence: 0.9, fits: { polish: 0.9, critique: 0.5, prototype: 0.1 } }),
    ], {
      capture: (params, index) => {
        if (index !== 1) return;
        const which = params.questions.which as { criteria: Record<string, unknown> };
        pass2Candidates = Object.keys(which.criteria);
      },
    });

    await routeSkill(client, { ...baseOpts, messageText: "clean up the spacing on this screen" });

    expect(pass2Candidates.sort()).toEqual(["critique", "polish", "prototype"].sort());
    expect(pass2Candidates).not.toContain("slides"); // lowest of the four, dropped
  });

  // Finding #4: `choice` and `probabilities` are separate response fields —
  // nothing enforces that `which.choice` is the argmax of `probabilities`.
  // Without unioning pass1.winner into the shortlist, a winner whose OWN
  // probability entry ranked outside the top 3 would be dropped before pass
  // 2 ever runs a fits check on it.
  it("unions pass 1's own choice winner into the shortlist even when its probability ranks outside the top 3", async () => {
    let pass2Candidates: string[] = [];
    const client = stagedClient(
      [
        pass1Response({
          // "critique" is the Choice's own pick, but its probability entry
          // (0.05) ranks LAST of the four — outside SHORTLIST_SIZE's top 3
          // by probability alone.
          winner: "critique",
          probabilities: { prototype: 0.4, slides: 0.3, polish: 0.25, critique: 0.05 },
          confidence: 0.6,
        }),
        // fits must cover every candidate in the shortlist, which now
        // includes "polish" (top-3 by probability) alongside the unioned-in
        // winner "critique" — four entries, not three.
        pass2Response({
          winner: "critique",
          confidence: 0.9,
          fits: { critique: 0.9, prototype: 0.1, slides: 0.1, polish: 0.05 },
        }),
      ],
      {
        capture: (params, index) => {
          if (index !== 1) return;
          const which = params.questions.which as { criteria: Record<string, unknown> };
          pass2Candidates = Object.keys(which.criteria);
        },
      },
    );

    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "run a structured design critique on this screen",
    });

    expect(pass2Candidates).toContain("critique");
    // The winner resolves normally once pass 2 gets to weigh in on it.
    expect(verdict.skill).toBe("critique");
    expect(verdict.reason).toBe("picked");
  });

  // Finding #3: an empty/missing `probabilities` map on an otherwise
  // well-formed pass-1 choice answer is a vendor glitch (the same class
  // browseStep.ts's hasProbabilities guards against), not a confident "no
  // ranking" — must fail open with reason "error", uncached, rather than
  // flowing into an empty shortlist.
  it("fails open with reason error, uncached, when pass 1's choice answer has an empty probabilities map", async () => {
    let calls = 0;
    const client: SystemOneClient = {
      async evaluate(params) {
        calls += 1;
        const answers: Record<string, SystemOneAnswer> = {
          which: { type: "choice", choice: "prototype", probabilities: {}, confidence: 0.9 },
        };
        for (const key of Object.keys(params.questions)) {
          if (key.startsWith("gate::")) answers[key] = { type: "noul", noul: 0.9 };
        }
        return { model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 1 } };
      },
    };
    const opts = { ...baseOpts, messageText: "design a login screen prototype" };

    const first = await routeSkill(client, opts);
    expect(first.skill).toBeNull();
    expect(first.reason).toBe("error");

    // Uncached: a second call re-tries pass 1 rather than replaying the
    // same degraded verdict.
    const second = await routeSkill(client, opts);
    expect(second.reason).toBe("error");
    expect(calls).toBe(2);
  });

  // Finding #5: skills.ts's parser already strips frontmatter before
  // `content` ever reaches this module — a second, regex-based strip here
  // (since removed) could misfire on a body that legitimately opens with a
  // `---` thematic-break divider followed by another `---`, silently eating
  // real content instead of leaving it for pass 2's excerpt.
  it("does not re-strip a skill body that legitimately opens with two '---' lines (already frontmatter-free)", async () => {
    let pass2Criteria: Record<string, unknown> = {};
    const dividerBody = "---\nABOVE-THE-FOLD-MARKER\n---\nMore instructions below the divider.";
    const client = stagedClient(
      [
        pass1Response({
          winner: "prototype",
          probabilities: { prototype: 0.6, slides: 0.4 },
          confidence: 0.6,
        }),
        pass2Response({ winner: "prototype", confidence: 0.9, fits: { prototype: 0.9, slides: 0.1 } }),
      ],
      {
        capture: (params, index) => {
          if (index !== 1) return;
          pass2Criteria = (params.questions.which as { criteria: Record<string, unknown> }).criteria;
        },
      },
    );

    await routeSkill(client, {
      ...baseOpts,
      candidates: [
        candidate("prototype", "Design a clickable prototype.", dividerBody),
        candidate("slides", "Build a slide deck."),
      ],
      messageText: "design a clickable login screen prototype",
    });

    // If a second strip fired on the divider, this marker (which sits
    // between the two leading "---" lines) would have been discarded.
    expect(String(pass2Criteria.prototype)).toContain("ABOVE-THE-FOLD-MARKER");
  });

  // Findings #1/#2: a pass-1-only fallback (pass 2 never produced a
  // considered fit check) must NEVER inject — `skill` is always null and the
  // reason is the dedicated "budget" code, with pass 1's own winner and
  // confidence reported in DEDICATED fields for shadow-mode measurement
  // rather than reused as `skill`/`confidence`.
  describe("pass-2-failure fallback (reason: budget) never injects", () => {
    it("resolves to reason budget with skill null when pass 2 fails after pass 1 succeeded, reporting pass 1's winner separately", async () => {
      const client = stagedClient([
        pass1Response({
          winner: "prototype",
          probabilities: { prototype: 0.9, slides: 0.05, critique: 0.03, polish: 0.02 },
          confidence: 0.9,
        }),
        () => {
          throw new Error("simulated pass-2 timeout / budget exhausted");
        },
      ]);

      const verdict = await routeSkill(client, {
        ...baseOpts,
        messageText: "design a clickable login screen prototype",
      });

      expect(verdict.skill).toBeNull();
      expect(verdict.reason).toBe("budget");
      expect(verdict.pass1Winner).toBe("prototype");
      expect(verdict.pass1Confidence).toBe(0.9);
      expect(verdict.confidence).toBeUndefined();
      expect(verdict.fits).toBeUndefined();
    });

    it("still resolves to reason budget (not low-confidence) when pass 2 fails and pass 1's own winner wasn't confident either", async () => {
      const client = stagedClient([
        pass1Response({
          winner: "prototype",
          probabilities: { prototype: 0.4, slides: 0.3, critique: 0.2, polish: 0.1 },
          confidence: 0.4,
        }),
        () => {
          throw new Error("simulated pass-2 failure");
        },
      ]);

      const verdict = await routeSkill(client, {
        ...baseOpts,
        messageText: "something ambiguous",
      });

      expect(verdict.skill).toBeNull();
      expect(verdict.reason).toBe("budget");
      expect(verdict.pass1Winner).toBe("prototype");
      expect(verdict.pass1Confidence).toBe(0.4);
    });

    it("actually times out pass 2 against a real per-call deadline and still resolves to reason budget without injecting", async () => {
      const client: SystemOneClient = {
        async evaluate(params) {
          if ("gate::documented_workflow" in params.questions) {
            return pass1Response({
              winner: "prototype",
              probabilities: { prototype: 0.9, slides: 0.1 },
              confidence: 0.9,
            })(params) as never;
          }
          // Never resolves on its own — only params.signal can end this.
          await new Promise<void>((resolve, reject) => {
            params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          throw new Error("unreachable");
        },
      };

      const verdict = await routeSkill(client, {
        ...baseOpts,
        candidates: [candidate("prototype", "Design a clickable prototype."), candidate("slides", "Build a deck.")],
        overallBudgetMs: SKILL_ROUTING_TIMEOUT_MS + 200,
        messageText: "design a clickable login screen prototype",
      });

      expect(verdict.skill).toBeNull();
      expect(verdict.reason).toBe("budget");
      expect(verdict.pass1Winner).toBe("prototype");
    }, 10_000);

    // Finding #2: cached, but under a SHORT TTL — every step of one
    // tool-loop turn re-runs routeSkill on byte-identical input and must
    // agree on the same non-pick, so unlike a plain "error" verdict this one
    // IS pinned (just not for the full 10-minute TTL).
    it("caches the budget verdict so a repeat call with an identical key spares the vendor a second pass-1 call too", async () => {
      let pass1Calls = 0;
      const client: SystemOneClient = {
        async evaluate(params) {
          if ("gate::documented_workflow" in params.questions) {
            pass1Calls += 1;
            return pass1Response({
              winner: "prototype",
              probabilities: { prototype: 0.9, slides: 0.05, critique: 0.03, polish: 0.02 },
              confidence: 0.9,
            })(params) as never;
          }
          throw new Error("pass 2 always fails");
        },
      };
      const opts = { ...baseOpts, messageText: "design a clickable login screen prototype" };

      const first = await routeSkill(client, opts);
      const second = await routeSkill(client, opts);

      expect(first.reason).toBe("budget");
      expect(second).toEqual(first);
      expect(pass1Calls).toBe(1);
    });
  });

  it("fails open with reason error when pass 1 itself throws", async () => {
    const client = throwingClient(new Error("rate limited"));
    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "design a login screen prototype",
    });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("error");
    expect(verdict.model).toBeNull();
  });

  it("fails open when pass 1's 'which' answer is a non-choice type", async () => {
    const client = stagedClient([
      () => ({
        model: "jev-latest",
        answers: { which: { type: "noul", noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    ]);
    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "design a login screen prototype",
    });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("error");
  });

  // Finding #8: a Choice winner outside the candidates it was actually
  // asked about is vendor drift, not a real pick — must fail open, never
  // resolve to "picked".
  it("fails open with reason error when pass 1's winner isn't one of the offered candidates", async () => {
    const client = stagedClient([
      pass1Response({
        winner: "not-a-real-skill",
        probabilities: { "not-a-real-skill": 0.9, prototype: 0.1 },
        confidence: 0.9,
      }),
    ]);
    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "design a login screen prototype",
    });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("error");
  });

  it("resolves to reason budget, never an injected verdict, when pass 2's winner isn't in the shortlist", async () => {
    const client = stagedClient([
      pass1Response({
        winner: "prototype",
        probabilities: { prototype: 0.9, slides: 0.05, critique: 0.03, polish: 0.02 },
        confidence: 0.9,
      }),
      pass2Response({
        winner: "not-a-real-skill",
        confidence: 0.9,
        fits: { prototype: 0.9, slides: 0.1, critique: 0.05 },
      }),
    ]);
    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "design a clickable login screen prototype",
    });
    // Pass 2's own throw is caught by routeSkill's pass-2 failure handling,
    // same as any other pass-2 error — resolves to "budget" (pass 1's own
    // validated winner reported for measurement) rather than injecting the
    // bogus name.
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("budget");
    expect(verdict.pass1Winner).toBe("prototype");
  });

  it("fails open when a pass-1 gate answer comes back the wrong type", async () => {
    const client = stagedClient([
      (params) => {
        const answers: Record<string, SystemOneAnswer> = {
          which: { type: "choice", choice: "prototype", probabilities: { prototype: 0.9, slides: 0.1 }, confidence: 0.9 },
        };
        // Wrong type for every gate question — should fail open, not throw
        // an uncaught TypeError from reading `.noul` off a choice answer.
        for (const key of Object.keys(params.questions)) {
          if (key.startsWith("gate::")) {
            answers[key] = { type: "choice", choice: "yes", probabilities: { yes: 1 }, confidence: 1 };
          }
        }
        return { model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 1 } };
      },
    ]);
    const verdict = await routeSkill(client, {
      ...baseOpts,
      messageText: "design a login screen prototype",
    });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("error");
  });

  it("truncates the routed text before it reaches the vendor", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = stagedClient(
      [gatedPass1Response({ probabilities: { prototype: 0.5, slides: 0.5 } })],
      { capture: (params) => { captured = params; } },
    );
    const longText = "a".repeat(5_000);

    await routeSkill(client, { ...baseOpts, messageText: longText });

    // scrubPii runs AFTER truncation and only ever shrinks or preserves
    // length (it redacts matches in place) — so a bound is the right
    // assertion here, not an exact length that would depend on scrubbing.
    const sentLength = String((captured?.state as { request: string }).request).length;
    expect(sentLength).toBeGreaterThan(0);
    expect(sentLength).toBeLessThanOrEqual(2_000);
  });

  it("sends recent_context alongside request in the state", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = stagedClient(
      [gatedPass1Response({ probabilities: { prototype: 0.5, slides: 0.5 } })],
      { capture: (params) => { captured = params; } },
    );

    await routeSkill(client, {
      ...baseOpts,
      messageText: "make it bigger",
      recentContext: "user: design a login screen\nassistant: done",
    });

    const state = captured?.state as { request: string; recent_context: string };
    expect(state.recent_context).toContain("design a login screen");
  });

  // Finding #3: truncation must keep the TAIL of recentContext (the message
  // closest to the current turn), not the head — the head is what
  // buildRecentContext's own ordering (oldest→newest) puts furthest away
  // from "now," and is the least useful part to keep when something has to
  // be cut.
  it("keeps the TAIL of an over-long recentContext, not the head", async () => {
    let captured: SystemOneEvaluateParams<Record<string, SystemOneQuestion>> | undefined;
    const client = stagedClient(
      [gatedPass1Response({ probabilities: { prototype: 0.5, slides: 0.5 } })],
      { capture: (params) => { captured = params; } },
    );
    const oldest = "user: this is the OLDEST message, far from the current turn. ".repeat(10);
    const nearest = "assistant: now do the same for THE_LOGIN_SCREEN as the one before.";
    const longContext = `${oldest}\n${nearest}`;

    await routeSkill(client, {
      ...baseOpts,
      messageText: "now do the same for the login screen",
      recentContext: longContext,
    });

    const state = captured?.state as { recent_context: string };
    expect(state.recent_context).toContain("THE_LOGIN_SCREEN");
  });

  it("misses the cache when only the TAIL of recentContext changes (cache key truncates the same way)", async () => {
    let calls = 0;
    const client = stagedClient(
      [gatedPass1Response({ probabilities: { prototype: 0.9, slides: 0.1 } })],
      { capture: () => { calls += 1; } },
    );
    const filler = "x".repeat(1_500);

    await routeSkill(client, { ...baseOpts, messageText: "make the header bigger", recentContext: `${filler}AAA` });
    await routeSkill(client, { ...baseOpts, messageText: "make the header bigger", recentContext: `${filler}BBB` });

    expect(calls).toBe(2);
  });

  describe("verdict cache", () => {
    it("spares the vendor on a repeat call with an identical key", async () => {
      let calls = 0;
      const client = stagedClient(
        [gatedPass1Response({ probabilities: { prototype: 0.9, slides: 0.1 } })],
        { capture: () => { calls += 1; } },
      );
      const opts = { ...baseOpts, messageText: "make the header a little bigger" };

      const first = await routeSkill(client, opts);
      const second = await routeSkill(client, opts);

      expect(calls).toBe(1);
      expect(second).toEqual(first);
    });

    it("misses the cache when a threshold changes", async () => {
      let calls = 0;
      const client = stagedClient(
        [gatedPass1Response({ probabilities: { prototype: 0.9, slides: 0.1 } })],
        { capture: () => { calls += 1; } },
      );

      await routeSkill(client, { ...baseOpts, messageText: "make the header bigger" });
      await routeSkill(client, { ...baseOpts, messageText: "make the header bigger", gateThreshold: 0.5 });

      expect(calls).toBe(2);
    });

    it("misses the cache when recentContext changes", async () => {
      let calls = 0;
      const client = stagedClient(
        [gatedPass1Response({ probabilities: { prototype: 0.9, slides: 0.1 } })],
        { capture: () => { calls += 1; } },
      );

      await routeSkill(client, { ...baseOpts, messageText: "make the header bigger", recentContext: "a" });
      await routeSkill(client, { ...baseOpts, messageText: "make the header bigger", recentContext: "b" });

      expect(calls).toBe(2);
    });

    it("does not cache an error verdict, so a client that recovers on the next call is used", async () => {
      let attempt = 0;
      const client: SystemOneClient = {
        async evaluate(params) {
          attempt += 1;
          if (attempt === 1) throw new Error("rate limited");
          return gatedPass1Response({ probabilities: { prototype: 0.9, slides: 0.1 } })(params) as never;
        },
      };
      const opts = { ...baseOpts, messageText: "make the header bigger" };

      const first = await routeSkill(client, opts);
      expect(first.reason).toBe("error");

      const second = await routeSkill(client, opts);
      expect(second.reason).toBe("gated");
      expect(attempt).toBe(2);
    });

    // Finding #2 (revised): a "budget" verdict caused by a pass-2
    // failure/timeout IS now cached — just at a SHORT TTL (see
    // ROUTE_CACHE_SHORT_TTL_MS's comment in skillRouting.ts), not the full
    // 10-minute one "error" and every other verdict get skipped for
    // entirely. This is what keeps every STEP of the same tool-loop turn
    // (prepareChatTurn re-runs routing once per step, on byte-identical
    // input) agreeing on the same non-pick, while a transient blip still
    // can't suppress routing on a later, unrelated turn for the full TTL.
    it("caches a budget verdict caused by a pass-2 failure at the SHORT TTL — a repeat call does not re-try pass 2", async () => {
      // Distinguishes pass 1 (has the "gate::" questions) from pass 2 (does
      // not) by shape rather than by call order, since — unlike the other
      // tests in this file — this one deliberately calls routeSkill TWICE
      // and needs pass 1 to keep succeeding on both, in case the cache
      // doesn't hold (which would fail the assertion below anyway).
      let pass1Calls = 0;
      let pass2Calls = 0;
      const client: SystemOneClient = {
        async evaluate(params) {
          if ("gate::documented_workflow" in params.questions) {
            pass1Calls += 1;
            return pass1Response({
              winner: "prototype",
              probabilities: { prototype: 0.9, slides: 0.05, critique: 0.03, polish: 0.02 },
              confidence: 0.9,
            })(params) as never;
          }
          pass2Calls += 1;
          throw new Error("pass 2 down");
        },
      };
      const opts = { ...baseOpts, messageText: "design a clickable login screen prototype" };

      const first = await routeSkill(client, opts);
      const second = await routeSkill(client, opts);

      expect(first.reason).toBe("budget");
      expect(first.skill).toBeNull();
      expect(first.pass1Winner).toBe("prototype");
      expect(second).toEqual(first);
      // Served from cache: neither pass ran a second time.
      expect(pass1Calls).toBe(1);
      expect(pass2Calls).toBe(1);
    });
  });

  // Round-3 review finding: `perCallSignal()` used to hardcode
  // SKILL_ROUTING_TIMEOUT_MS (1.5s) as the per-call cap regardless of mode,
  // so a caller passing a laxer `overallBudgetMs` (shadow mode) still got
  // every individual call clipped to 1.5s — the laxer overall number could
  // never bind. `perCallTimeoutMs` lets a caller raise the per-call cap
  // independently of the default.
  describe("perCallTimeoutMs overrides the default per-call cap", () => {
    it("lets a single call run past SKILL_ROUTING_TIMEOUT_MS when a larger perCallTimeoutMs is given", async () => {
      let sawAbortBeforeResolving = false;
      const client: SystemOneClient = {
        async evaluate(params) {
          await new Promise<void>((resolve) => setTimeout(resolve, SKILL_ROUTING_TIMEOUT_MS + 500));
          if (params.signal?.aborted) sawAbortBeforeResolving = true;
          return pass1Response({
            winner: "prototype",
            probabilities: { prototype: 0.9, slides: 0.1 },
            confidence: 0.9,
          })(params) as never;
        },
      };

      const verdict = await routeSkill(client, {
        ...baseOpts,
        candidates: [candidate("prototype", "Design a clickable prototype."), candidate("slides", "Build a deck.")],
        overallBudgetMs: SKILL_ROUTING_TIMEOUT_MS + 5_000,
        perCallTimeoutMs: SKILL_ROUTING_TIMEOUT_MS + 5_000,
        messageText: "design a clickable login screen prototype",
      });

      expect(sawAbortBeforeResolving).toBe(false);
      expect(verdict.reason).not.toBe("error");
    }, 10_000);

    it("still aborts a call once the SHARED overall deadline elapses, even with a large perCallTimeoutMs", async () => {
      const client: SystemOneClient = {
        async evaluate(params) {
          await new Promise<void>((_resolve, reject) => {
            params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
          throw new Error("unreachable");
        },
      };

      const verdict = await routeSkill(client, {
        ...baseOpts,
        overallBudgetMs: 300,
        perCallTimeoutMs: 60_000,
        messageText: "design a clickable login screen prototype",
      });

      expect(verdict.skill).toBeNull();
      expect(verdict.reason).toBe("error");
    }, 10_000);
  });

  // Round-3 review finding: cacheKey used to serialize a 700-char excerpt of
  // EVERY candidate's `content` on every call. catalogFingerprint replaces
  // that with a cheap count+length digest — these tests check it still does
  // its job (hit when the catalog is unchanged, miss when it changes) rather
  // than merely being cheaper.
  describe("cacheKey uses a cheap catalog fingerprint, not full candidate bodies", () => {
    it("still hits the cache across two calls with the identical candidate catalog", async () => {
      let calls = 0;
      const client = stagedClient(
        [gatedPass1Response({ probabilities: { prototype: 0.9, slides: 0.1 } })],
        { capture: () => { calls += 1; } },
      );
      const opts = { ...baseOpts, messageText: "make the header a little bigger" };

      await routeSkill(client, opts);
      await routeSkill(client, opts);

      expect(calls).toBe(1);
    });

    it("misses the cache when a candidate's content changes length, even with the same name/description", async () => {
      let calls = 0;
      const client = stagedClient(
        [gatedPass1Response({ probabilities: { prototype: 0.9, slides: 0.1 } })],
        { capture: () => { calls += 1; } },
      );

      await routeSkill(client, {
        ...baseOpts,
        candidates: [candidate("prototype", "Design a clickable prototype.", "short body")],
        messageText: "make the header a little bigger",
      });
      await routeSkill(client, {
        ...baseOpts,
        candidates: [candidate("prototype", "Design a clickable prototype.", "a much longer body than before")],
        messageText: "make the header a little bigger",
      });

      expect(calls).toBe(2);
    });
  });

  it("returns unavailable without calling the client when there are no candidates", async () => {
    let called = false;
    const client: SystemOneClient = {
      async evaluate() {
        called = true;
        throw new Error("should not be called");
      },
    };
    const verdict = await routeSkill(client, { ...baseOpts, candidates: [], messageText: "anything" });
    expect(verdict.skill).toBeNull();
    expect(verdict.reason).toBe("unavailable");
    expect(called).toBe(false);
  });
});
