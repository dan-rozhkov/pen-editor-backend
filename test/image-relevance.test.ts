import { beforeAll, describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { makeConfig } from "./helpers.js";
import { envSchema } from "../src/config.js";
import {
  freezeElidedSlots,
  resolveImageRescues,
  resetImageRelevanceCacheForTests,
  MAX_NEW_VERDICTS_PER_TURN,
} from "../src/ai/imageRelevance.js";
import {
  applyImageBudget,
  MAX_RESCUED_IMAGES,
  planImageElision,
  MAX_LIVE_TOOL_RESULT_IMAGES,
  TOOL_RESULT_ELISION_STEP,
} from "../src/ai/image-budget.js";
import type { SystemOneAnswer, SystemOneClient } from "../src/services/systemone.js";
import { loadSkills } from "../src/ai/skills.js";

// Phase 2: relevance instead of recency, on Jev. See
// docs/specs/2026-09-21-jev-image-relevance-design.md. Two layers of tests
// here:
//   1. resolveImageRescues (src/ai/imageRelevance.ts) in isolation, against
//      a fake SystemOneClient — no network, mirrors test/skill-routing.test.ts.
//   2. prepareChatTurn (src/ai/chatTurn.ts) end to end, mirroring the "image
//      budget" describe block in test/chat-turn.test.ts, to prove the three
//      IMAGE_RELEVANCE_MODE values are actually wired the way the spec
//      requires — off is byte-identical, shadow calls but never acts,
//      enforce acts.

// ── Fixtures ────────────────────────────────────────────────────────────

function userTextMessage(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] } as ModelMessage;
}

function toolCallMessage(id: string, toolName: string, args: unknown): ModelMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName, input: args }],
  } as ModelMessage;
}

function screenshotResultMessage(id: string, tag: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: id,
        toolName: "get_screenshot",
        output: {
          type: "content",
          value: [{ type: "image-data", data: tag, mediaType: "image/png" }],
        },
      },
    ],
  } as ModelMessage;
}

/** N screenshot tool-call/tool-result pairs after one user message — enough
 * structure for planImageElision AND for imageRelevance.ts's own toolName/
 * args correlation (which needs the matching assistant tool-call part). */
function buildHistory(n: number, userText = "check the header"): ModelMessage[] {
  const messages: ModelMessage[] = [userTextMessage(userText)];
  for (let i = 0; i < n; i++) {
    messages.push(toolCallMessage(`call-${i}`, "get_screenshot", { nodeId: `node-${i}` }));
    messages.push(screenshotResultMessage(`call-${i}`, `SCREEN${i}`));
  }
  return messages;
}

function nounResponder(rescue: (key: string) => number): SystemOneClient {
  return {
    async evaluate(params) {
      const answers: Record<string, SystemOneAnswer> = {};
      for (const key of Object.keys(params.questions)) {
        answers[key] = { type: "noul", noul: rescue(key) };
      }
      return { model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

describe("ratchet across the recency shift", () => {
  // The hole this guards: a rescue SHIFTS elision onto the next slot in
  // line, and that victim was never a candidate, so nothing froze a verdict
  // for it. On the next turn the cutoff has moved and the victim IS a
  // candidate — a fresh one, with no cache entry — so Jev is free to rescue
  // it and bring an already-elided image back to life. That flips its text
  // from placeholder back to a real image part in the MIDDLE of the
  // history, which is exactly the prompt-cache break the whole ratchet
  // exists to prevent (and it silently re-adds the tokens too).
  it("never un-elides a slot that a previous turn's shift already elided", async () => {
    resetImageRelevanceCacheForTests();
    const sessionId = "sess-shift";
    const config = makeConfig();

    // Turn 1: 9 screenshots → cutoff 3 → recency would elide call-0..2.
    const turn1Messages = buildHistory(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP);
    const turn1Candidates = planImageElision(turn1Messages);
    const rescuedFirst = turn1Candidates[0].toolCallId as string;
    const shiftVictim = turn1Candidates[turn1Candidates.length - 1].toolCallId as string;

    const turn1Rescued = (await resolveImageRescues(
      nounResponder((key) => (key === rescuedFirst ? 0.99 : 0.0)),
      { config, sessionId, candidates: turn1Candidates, messages: turn1Messages },
    )).rescued;
    expect(turn1Rescued.has(rescuedFirst)).toBe(true);

    // The three steps chatTurn's enforce path runs, in the same order:
    // resolve rescues → freeze what will ACTUALLY be elided → apply. The
    // freeze is the whole point of this test; dropping it makes the final
    // assertion fail.
    freezeElidedSlots(
      sessionId,
      planImageElision(turn1Messages, turn1Rescued).map((slot) => slot.toolCallId),
    );
    const turn1Applied = applyImageBudget(turn1Messages, { rescued: turn1Rescued });
    const turn1Body = JSON.stringify(turn1Applied);
    // Rescuing call-0 pushed elision one slot further down the line, so the
    // slot right after the recency window is the one that actually died.
    const shiftedOnto = `SCREEN${Number(shiftVictim.replace("call-", "")) + 1}`;
    expect(turn1Body).not.toContain(`"${shiftedOnto}"`);

    // Turn 2: three more screenshots → cutoff 6 → the shift victim is now
    // inside the candidate window for the first time. Jev says "keep it".
    const turn2Messages = buildHistory(
      MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP * 2,
    );
    const turn2Candidates = planImageElision(turn2Messages);
    const turn2Rescued = (await resolveImageRescues(
      nounResponder((key) => (key === `call-${Number(shiftVictim.replace("call-", "")) + 1}` ? 0.99 : 0.0)),
      { config, sessionId, candidates: turn2Candidates, messages: turn2Messages },
    )).rescued;

    const turn2Body = JSON.stringify(applyImageBudget(turn2Messages, { rescued: turn2Rescued }));
    expect(turn2Body).not.toContain(`"${shiftedOnto}"`); // must STAY dead
  });
});

describe("resolveImageRescues", () => {
  it("returns empty and never calls Jev when sessionId is absent — no ratchet home", async () => {
    const messages = buildHistory(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP);
    const candidates = planImageElision(messages);
    expect(candidates.length).toBeGreaterThan(0);

    let calls = 0;
    const client = nounResponder(() => {
      calls++;
      return 0.9;
    });

    const result = (await resolveImageRescues(client, {
      config: makeConfig(),
      sessionId: undefined,
      candidates,
      messages,
    })).rescued;

    expect(result.size).toBe(0);
    expect(calls).toBe(0);
  });

  it("returns empty without throwing when there is no client", async () => {
    const messages = buildHistory(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP);
    const candidates = planImageElision(messages);
    const result = (await resolveImageRescues(null, {
      config: makeConfig(),
      sessionId: "sess-no-client",
      candidates,
      messages,
    })).rescued;
    expect(result.size).toBe(0);
  });

  describe("the ratchet", () => {
    it("keeps a rescue live on the next turn, and does not ask Jev about a decided candidate again", async () => {
      resetImageRelevanceCacheForTests();
      const n = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP;
      const messages = buildHistory(n);
      const candidates = planImageElision(messages);
      expect(candidates.length).toBeGreaterThan(0);
      const targetId = candidates[0].toolCallId as string;

      let callCount = 0;
      const client = nounResponder((key) => {
        // Only meaningful on the FIRST call — a second call would answer
        // the opposite for targetId, to prove it's the ratchet holding the
        // verdict, not the vendor re-confirming it.
        if (key === targetId) return callCount === 1 ? 0.9 : 0.1;
        return 0.1;
      });
      const countingClient: SystemOneClient = {
        async evaluate(params) {
          callCount++;
          return client.evaluate(params);
        },
      };

      const turn1 = (await resolveImageRescues(countingClient, {
        config: makeConfig(),
        sessionId: "sess-ratchet",
        candidates,
        messages,
      })).rescued;
      expect(turn1.has(targetId)).toBe(true);
      expect(callCount).toBe(1);

      const turn2 = (await resolveImageRescues(countingClient, {
        config: makeConfig(),
        sessionId: "sess-ratchet",
        candidates,
        messages,
      })).rescued;
      // Still rescued — the ratchet, not a re-ask, is what decided this.
      expect(turn2.has(targetId)).toBe(true);
      // And every OTHER candidate that was decided "no" on turn 1 must not
      // have resurrected either.
      for (const candidate of candidates.slice(1)) {
        expect(turn2.has(candidate.toolCallId as string)).toBe(false);
      }
      // No new evaluate() call at all — everything was already decided.
      expect(callCount).toBe(1);
    });

    it("a candidate decided 'not rescued' never comes back, even under a different sessionId's client behavior", async () => {
      resetImageRelevanceCacheForTests();
      const n = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP;
      const messages = buildHistory(n);
      const candidates = planImageElision(messages);
      const targetId = candidates[0].toolCallId as string;

      const neverRescue = nounResponder(() => 0.0);
      const turn1 = (await resolveImageRescues(neverRescue, {
        config: makeConfig(),
        sessionId: "sess-frozen",
        candidates,
        messages,
      })).rescued;
      expect(turn1.has(targetId)).toBe(false);

      const alwaysRescue = nounResponder(() => 0.99);
      const turn2 = (await resolveImageRescues(alwaysRescue, {
        config: makeConfig(),
        sessionId: "sess-frozen",
        candidates,
        messages,
      })).rescued;
      expect(turn2.has(targetId)).toBe(false);
    });
  });

  describe("budgets", () => {
    it("asks Jev about at most MAX_NEW_VERDICTS_PER_TURN brand-new candidates in one call", async () => {
      resetImageRelevanceCacheForTests();
      const n = MAX_LIVE_TOOL_RESULT_IMAGES + 3 * TOOL_RESULT_ELISION_STEP;
      const messages = buildHistory(n);
      const candidates = planImageElision(messages);
      expect(candidates.length).toBeGreaterThan(MAX_NEW_VERDICTS_PER_TURN);

      const askedKeysByCall: string[][] = [];
      const client: SystemOneClient = {
        async evaluate(params) {
          askedKeysByCall.push(Object.keys(params.questions));
          const answers: Record<string, SystemOneAnswer> = {};
          // Never rescue — isolates the per-turn NEW-verdict budget from
          // MAX_RESCUED_IMAGES, which is a separate cap.
          for (const key of Object.keys(params.questions)) answers[key] = { type: "noul", noul: 0 };
          return { model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      };

      await resolveImageRescues(client, {
        config: makeConfig(),
        sessionId: "sess-budget",
        candidates,
        messages,
      });

      expect(askedKeysByCall.length).toBe(1);
      expect(askedKeysByCall[0].length).toBe(MAX_NEW_VERDICTS_PER_TURN);

      // The overflow candidates (never asked) are frozen as "not rescued":
      // a second call, even with the full candidate set again, must not
      // trigger any new evaluate() call — everything is now decided.
      const result2 = (await resolveImageRescues(client, {
        config: makeConfig(),
        sessionId: "sess-budget",
        candidates,
        messages,
      })).rescued;
      expect(result2.size).toBe(0);
      expect(askedKeysByCall.length).toBe(1);
    });

    it("never grants more than MAX_RESCUED_IMAGES, even when Jev approves every candidate", async () => {
      resetImageRelevanceCacheForTests();
      // Keep the candidate count within MAX_NEW_VERDICTS_PER_TURN so the
      // verdict budget above doesn't also gate this test.
      const n = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP;
      const messages = buildHistory(n);
      const candidates = planImageElision(messages);
      expect(candidates.length).toBeLessThanOrEqual(MAX_NEW_VERDICTS_PER_TURN);
      expect(candidates.length).toBeGreaterThan(MAX_RESCUED_IMAGES);

      const alwaysRescue = nounResponder(() => 0.99);
      const result = (await resolveImageRescues(alwaysRescue, {
        config: makeConfig(),
        sessionId: "sess-concurrency",
        candidates,
        messages,
      })).rescued;

      expect(result.size).toBe(MAX_RESCUED_IMAGES);
    });

    it("counts already-cached rescues toward the cap and skips asking entirely once it's full", async () => {
      resetImageRelevanceCacheForTests();
      const n = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP;
      const messages = buildHistory(n);
      const candidates = planImageElision(messages);
      expect(candidates.length).toBeGreaterThan(MAX_RESCUED_IMAGES);

      const alwaysRescue = nounResponder(() => 0.99);
      const first = (await resolveImageRescues(alwaysRescue, {
        config: makeConfig(),
        sessionId: "sess-two-call",
        candidates: candidates.slice(0, MAX_RESCUED_IMAGES),
        messages,
      })).rescued;
      expect(first.size).toBe(MAX_RESCUED_IMAGES);

      let calls = 0;
      const countingClient: SystemOneClient = {
        async evaluate(params) {
          calls++;
          return alwaysRescue.evaluate(params);
        },
      };
      const second = (await resolveImageRescues(countingClient, {
        config: makeConfig(),
        sessionId: "sess-two-call",
        candidates, // full set, including the still-undecided ones
        messages,
      })).rescued;

      expect(second.size).toBe(MAX_RESCUED_IMAGES); // still capped
      expect(calls).toBe(0); // the cap was already full — never even asked
    });
  });

  describe("no pixels, ever", () => {
    it("never sends image payload bytes to Jev, in `state` or anywhere else in the request", async () => {
      resetImageRelevanceCacheForTests();
      const bigBase64 = "A".repeat(2000);
      const dataUrl = `data:image/png;base64,${bigBase64}`;
      const rawTag = "THE-ACTUAL-PIXEL-MARKER";

      const messages: ModelMessage[] = [
        userTextMessage("use the reference I attached"),
        // Pathological but real-shaped: a tool call whose OWN arguments
        // happen to carry a data URL (e.g. an image-reference argument).
        toolCallMessage("call-x", "get_screenshot", { nodeId: "n1", imageHint: dataUrl }),
        screenshotResultMessage("call-x", rawTag),
      ];

      const candidateSlot = planImageElision([...messages, ...buildHistory(
        MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP,
      ).slice(1)]).find((c) => c.toolCallId === "call-x");
      expect(candidateSlot).toBeDefined();

      let capturedState: unknown;
      const client: SystemOneClient = {
        async evaluate(params) {
          capturedState = params.state;
          const answers: Record<string, SystemOneAnswer> = {};
          for (const key of Object.keys(params.questions)) answers[key] = { type: "noul", noul: 0.9 };
          return { model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      };

      await resolveImageRescues(client, {
        config: makeConfig(),
        sessionId: "sess-pii",
        candidates: [candidateSlot!],
        messages,
      });

      const serialized = JSON.stringify(capturedState);
      expect(serialized).not.toContain(bigBase64);
      expect(serialized).not.toContain("data:image");
      expect(serialized).not.toContain(rawTag); // the tool-result's own image marker
    });
  });

  describe("fail-open", () => {
    it("falls back to nothing rescued when Jev throws", async () => {
      resetImageRelevanceCacheForTests();
      const messages = buildHistory(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP);
      const candidates = planImageElision(messages);
      const client: SystemOneClient = {
        async evaluate() {
          throw new Error("boom");
        },
      };
      const result = (await resolveImageRescues(client, {
        config: makeConfig(),
        sessionId: "sess-throw",
        candidates,
        messages,
      })).rescued;
      expect(result.size).toBe(0);
    });

    it("falls back to nothing rescued on a timeout", async () => {
      resetImageRelevanceCacheForTests();
      const messages = buildHistory(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP);
      const candidates = planImageElision(messages);
      const hangingClient: SystemOneClient = {
        evaluate(params) {
          return new Promise((_resolve, reject) => {
            params.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
      };
      const result = (await resolveImageRescues(hangingClient, {
        config: makeConfig({ IMAGE_RELEVANCE_TIMEOUT_MS: 20 }),
        sessionId: "sess-timeout",
        candidates,
        messages,
      })).rescued;
      expect(result.size).toBe(0);
    });

    it("skips (not throws on) an individual malformed answer", async () => {
      resetImageRelevanceCacheForTests();
      const messages = buildHistory(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP);
      const candidates = planImageElision(messages);
      const client: SystemOneClient = {
        async evaluate(params) {
          const answers: Record<string, SystemOneAnswer> = {};
          for (const key of Object.keys(params.questions)) {
            // Vendor drift: a "choice" answer where a "noul" was asked for.
            answers[key] = {
              type: "choice",
              choice: "x",
              probabilities: {},
              confidence: 0,
            } as unknown as SystemOneAnswer;
          }
          return { model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      };
      const result = (await resolveImageRescues(client, {
        config: makeConfig(),
        sessionId: "sess-garbage",
        candidates,
        messages,
      })).rescued;
      expect(result.size).toBe(0);
    });
  });
});

// ── config default ─────────────────────────────────────────────────────

describe("IMAGE_RELEVANCE_MODE config default", () => {
  it("defaults to off — a deployment that never set it must not silently call Jev", () => {
    expect(envSchema.shape.IMAGE_RELEVANCE_MODE.parse(undefined)).toBe("off");
  });
});

// ── prepareChatTurn wiring (src/ai/chatTurn.ts) ────────────────────────

function screenshotHistory(count: number): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [
    { role: "user", parts: [{ type: "text", text: "look at these screens" }] },
  ];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `a${i}`,
      role: "assistant",
      parts: [
        {
          type: "tool-get_screenshot",
          toolCallId: `call-${i}`,
          state: "output-available",
          input: { nodeId: `node-${i}` },
          output: JSON.stringify({ imageData: `data:image/png;base64,SCREEN${i}AAAA` }),
        },
      ],
    });
  }
  return messages;
}

function rescueClient(rescueIds: Set<string>, calls?: { count: number }): SystemOneClient {
  return {
    async evaluate(params) {
      if (calls) calls.count += 1;
      const answers: Record<string, SystemOneAnswer> = {};
      for (const key of Object.keys(params.questions)) {
        answers[key] = { type: "noul", noul: rescueIds.has(key) ? 0.9 : 0.1 };
      }
      return { model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
}

describe("prepareChatTurn — Jev image relevance", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  const total = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP + 4;

  function liveScreenshotCount(bodyText: string): number {
    return Array.from({ length: total }, (_, i) => i).filter((i) =>
      bodyText.includes(`SCREEN${i}AAAA`),
    ).length;
  }

  it("off (the default): never calls Jev, and renders byte-identical to before this feature existed", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = rescueClient(new Set(["call-0"]), calls);

    const withClient = await prepareChatTurn({
      config: makeConfig(), // IMAGE_RELEVANCE_MODE defaults to "off"
      messages: screenshotHistory(total),
      systemOneClient: client,
      sessionId: "sess-off",
      // The ratchet keys off chatSessionId — the REAL conversation id — not
      // sessionId, which src/routes/chat.ts backfills with a fresh
      // `anon-<uuid>` PER REQUEST. Passing only the latter is exactly the
      // "no ratchet home" case, and Jev is skipped entirely.
      chatSessionId: "sess-off",
    });
    expect(calls.count).toBe(0);

    const withoutClient = await prepareChatTurn({
      config: makeConfig(),
      messages: screenshotHistory(total),
    });

    // Byte-identical regardless of whether a Jev client happens to be wired
    // in — "off" must behave as if this feature doesn't exist at all.
    expect(JSON.stringify(withClient.modelMessages)).toBe(
      JSON.stringify(withoutClient.modelMessages),
    );
  });

  it("shadow: calls Jev but never changes which images stay live", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const calls = { count: 0 };
    const client = rescueClient(new Set(["call-0"]), calls);

    const shadowTurn = await prepareChatTurn({
      config: makeConfig({ IMAGE_RELEVANCE_MODE: "shadow" }),
      messages: screenshotHistory(total),
      systemOneClient: client,
      sessionId: "sess-shadow",
      // The ratchet keys off chatSessionId — the REAL conversation id — not
      // sessionId, which src/routes/chat.ts backfills with a fresh
      // `anon-<uuid>` PER REQUEST. Passing only the latter is exactly the
      // "no ratchet home" case, and Jev is skipped entirely.
      chatSessionId: "sess-shadow",
    });
    const recencyOnlyTurn = await prepareChatTurn({
      config: makeConfig(), // off
      messages: screenshotHistory(total),
    });

    // The RESULT must be byte-identical to pure recency — shadow mode never
    // acts on what Jev says.
    expect(JSON.stringify(shadowTurn.modelMessages)).toBe(
      JSON.stringify(recencyOnlyTurn.modelMessages),
    );

    // But Jev WAS actually consulted (fire-and-forget, so give its promise
    // a tick to settle before checking).
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.count).toBeGreaterThan(0);
  });

  it("enforce: rescues the approved candidate, shifting elision to the next slot rather than growing the live count", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    // call-5, not call-0: only the NEWEST MAX_NEW_VERDICTS_PER_TURN
    // candidates get a real verdict (see the slice-direction test below), and
    // with six candidates call-0 sits in the frozen overflow.
    const client = rescueClient(new Set(["call-5"]));

    const enforceTurn = await prepareChatTurn({
      config: makeConfig({ IMAGE_RELEVANCE_MODE: "enforce" }),
      messages: screenshotHistory(total),
      systemOneClient: client,
      sessionId: "sess-enforce",
      // The ratchet keys off chatSessionId — the REAL conversation id — not
      // sessionId, which src/routes/chat.ts backfills with a fresh
      // `anon-<uuid>` PER REQUEST. Passing only the latter is exactly the
      // "no ratchet home" case, and Jev is skipped entirely.
      chatSessionId: "sess-enforce",
    });
    const recencyOnlyTurn = await prepareChatTurn({
      config: makeConfig(),
      messages: screenshotHistory(total),
    });

    const enforceBody = JSON.stringify(enforceTurn.modelMessages);
    const recencyBody = JSON.stringify(recencyOnlyTurn.modelMessages);

    // The rescued screenshot is live under enforce even though pure
    // recency would have elided it.
    expect(recencyBody).not.toContain("SCREEN5AAAA");
    expect(enforceBody).toContain("SCREEN5AAAA");

    // Same total live count either way — a shift, not a grant.
    expect(liveScreenshotCount(enforceBody)).toBe(liveScreenshotCount(recencyBody));
  });

  it("spends the per-turn verdict budget on the NEWEST candidates, not the oldest", async () => {
    // Matters on the first turn the feature meets an existing conversation —
    // a process restart, a mode flip, a resumed chat — where every candidate
    // is new at once. Slicing from the front would burn the budget on the
    // oldest screenshots and permanently freeze the newest (the very ones a
    // rescue is for) as not-rescued, first-write-wins, for the process's life.
    resetImageRelevanceCacheForTests();
    const messages = buildHistory(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP * 3);
    const candidates = planImageElision(messages);
    // Guard the premise: more candidates than the per-turn budget, or the
    // slice direction could not matter and this test would prove nothing.
    expect(candidates.length).toBeGreaterThan(MAX_NEW_VERDICTS_PER_TURN);

    const asked: string[] = [];
    const recordingClient: SystemOneClient = {
      async evaluate(params) {
        asked.push(...Object.keys(params.questions));
        return { model: "jev", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    };
    await resolveImageRescues(recordingClient, {
      config: makeConfig(),
      sessionId: "sess-slice",
      candidates,
      messages,
    });

    const newest = candidates
      .slice(-MAX_NEW_VERDICTS_PER_TURN)
      .map((slot) => slot.toolCallId as string);
    expect([...asked].sort()).toEqual([...newest].sort());
  });

  it("freezes what it elided even when Jev failed, so a later verdict can't resurrect it", async () => {
    // The fail-open path caches no VERDICT, which is right — a timeout is a
    // transport fact, not a judgement. But the candidates still get elided
    // this turn by pure recency. Leave them unfrozen and they come back as
    // fresh candidates once the cutoff advances, a later working call says
    // "keep it", and an already-placeholdered image returns to life
    // mid-history: the prompt-cache break the ratchet exists to prevent.
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    resetImageRelevanceCacheForTests();

    const throwingClient: SystemOneClient = {
      async evaluate() {
        throw new Error("jev is down");
      },
    };
    const failedTurn = await prepareChatTurn({
      config: makeConfig({ IMAGE_RELEVANCE_MODE: "enforce" }),
      messages: screenshotHistory(total),
      systemOneClient: throwingClient,
      chatSessionId: "sess-fail-freeze",
    });
    const failedBody = JSON.stringify(failedTurn.modelMessages);
    // Pure recency still ran: the oldest screenshot is gone.
    expect(failedBody).not.toContain("SCREEN0AAAA");

    // The newest slot this failed turn elided — the one at real risk of
    // coming back, since the next turn's verdict budget will ask about it.
    const newestElidedOnTurn1 = `call-${MAX_LIVE_TOOL_RESULT_IMAGES - 1}`;
    expect(failedBody).not.toContain(`SCREEN${MAX_LIVE_TOOL_RESULT_IMAGES - 1}AAAA`);

    // Next turn: more screenshots, the cutoff has advanced, and Jev is
    // healthy and eager to rescue everything it is asked about.
    const laterTurn = await prepareChatTurn({
      config: makeConfig({ IMAGE_RELEVANCE_MODE: "enforce" }),
      messages: screenshotHistory(total + TOOL_RESULT_ELISION_STEP),
      // Target a slot that (a) turn 1 already elided and (b) turn 2 actually
      // ASKS about. The verdict budget takes the NEWEST candidates, so
      // approving call-0 would prove nothing — it sits in the frozen
      // overflow and is never put to Jev either way.
      systemOneClient: rescueClient(new Set([newestElidedOnTurn1])),
      chatSessionId: "sess-fail-freeze",
    });
    expect(JSON.stringify(laterTurn.modelMessages)).not.toContain(
      `SCREEN${MAX_LIVE_TOOL_RESULT_IMAGES - 1}AAAA`,
    );
  });

  it("reports WHY the rescue count is zero, so a failure can't read as a considered decline", async () => {
    // The live lesson: a TypeSafe account out of credits made every call 402,
    // and the summary printed `would rescue 0/6` four runs in a row — exactly
    // what a healthy, conservative model looks like. Shadow mode exists to be
    // measured, so a zero that cannot be read is a broken measurement. The two
    // zeros below must be distinguishable.
    resetImageRelevanceCacheForTests();
    const messages = buildHistory(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP);
    const candidates = planImageElision(messages);

    const declined = await resolveImageRescues(nounResponder(() => 0.0), {
      config: makeConfig(),
      sessionId: "sess-outcome-declined",
      candidates,
      messages,
    });
    expect(declined.rescued.size).toBe(0);
    expect(declined.outcome).toBe("asked");
    expect(declined.asked).toBeGreaterThan(0);

    const broken: SystemOneClient = {
      async evaluate() {
        throw new Error("402 no credits");
      },
    };
    const failed = await resolveImageRescues(broken, {
      config: makeConfig(),
      sessionId: "sess-outcome-failed",
      candidates,
      messages,
    });
    expect(failed.rescued.size).toBe(0); // same count...
    expect(failed.outcome).toBe("failed"); // ...different, readable reason
    expect(failed.asked).toBe(0);

    const noClient = await resolveImageRescues(null, {
      config: makeConfig(),
      sessionId: "sess-outcome-noclient",
      candidates,
      messages,
    });
    expect(noClient.outcome).toBe("no-client");

    const noSession = await resolveImageRescues(nounResponder(() => 0.9), {
      config: makeConfig(),
      sessionId: undefined,
      candidates,
      messages,
    });
    expect(noSession.outcome).toBe("no-session");
  });
});
