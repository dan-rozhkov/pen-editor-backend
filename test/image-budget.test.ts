import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

vi.mock("../src/services/vision.js", () => ({
  // applyImageBudget itself reads NOTHING from this module — its replacement
  // text is a constant, deliberately not derived from the description cache
  // (see the module's own "WHY ONLY TOOL-RESULT IMAGES" comment). The mock
  // exists only because collectImageSlots, reused from vision-messages.ts,
  // can hash a slot's image through visionCacheKey. peekCachedDescriptionByKey
  // is stubbed as a throwing spy so a future change that starts consulting
  // the cache fails loudly here instead of silently reintroducing the
  // mutable-state dependency review rejected.
  peekCachedDescriptionByKey: vi.fn(() => {
    throw new Error("applyImageBudget must not read the description cache");
  }),
  visionCacheKey: (image: string) => `key:${image}`,
}));

import {
  applyImageBudget,
  planImageElision,
  MAX_LIVE_TOOL_RESULT_IMAGES,
  TOOL_RESULT_ELISION_STEP,
} from "../src/ai/image-budget.js";

// One user message carrying a single distinct image (so slots are trivially
// addressable by their position in the returned array).
function userImageMessage(tag: string): ModelMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: `look at ${tag}` },
      { type: "image", image: `https://example.com/${tag}.png`, mediaType: "image/png" },
    ],
  } as ModelMessage;
}

// One tool message carrying a single get_screenshot result, structured the
// way toModelOutput promotes it (a real image-data content part) — same
// shape vision-messages.test.ts uses for the equivalent fixture.
function screenshotMessage(tag: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call-${tag}`,
        toolName: "get_screenshot",
        output: {
          type: "content",
          value: [{ type: "image-data", data: tag, mediaType: "image/png" }],
        },
      },
    ],
  } as ModelMessage;
}

function history(userTags: string[], screenshotTags: string[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // Interleave so ordering within each kind, not overall message order, is
  // what determines each budget's cutoff.
  const max = Math.max(userTags.length, screenshotTags.length);
  for (let i = 0; i < max; i++) {
    if (userTags[i]) messages.push(userImageMessage(userTags[i]));
    if (screenshotTags[i]) messages.push(screenshotMessage(screenshotTags[i]));
  }
  return messages;
}

function tagsOf(userN: number, prefix = "u"): string[] {
  return Array.from({ length: userN }, (_, i) => `${prefix}${i}`);
}

// Whether the Nth (0-based, chronological) user-image slot in the RESULT is
// still a live image part (as opposed to collapsed to text).
function isUserSlotLive(result: ModelMessage[], tag: string): boolean {
  const json = JSON.stringify(result);
  return json.includes(`https://example.com/${tag}.png`);
}

function isScreenshotSlotLive(result: ModelMessage[], tag: string): boolean {
  const json = JSON.stringify(result);
  return json.includes(`"data":"${tag}"`);
}

describe("applyImageBudget", () => {
  it("returns messages untouched (same array reference behavior) when below both budgets", () => {
    const messages = history(tagsOf(3, "u"), tagsOf(2, "s"));
    const result = applyImageBudget(messages);
    expect(result).toEqual(messages);
    // Untouched messages are literally the same object — nothing was
    // reconstructed, matching applyVisionPreprocessing's own convention.
    result.forEach((message, i) => expect(message).toBe(messages[i]));
  });

  it("elides nothing at all when there are no images", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "hello" } as ModelMessage];
    expect(applyImageBudget(messages)).toBe(messages);
  });

  it("elides a browse_screenshot result the same as a get_screenshot one — the pass is tool-agnostic", () => {
    // extractToolResultImages' structured `content`-shaped path (the one
    // toModelOutput promotions produce) never checked toolName, so
    // browse_screenshot's toModelOutput output (also `{type:"content",
    // value:[...]}`, just with an extra text sibling part) should budget
    // identically to get_screenshot's image-only shape.
    const browseShot: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-browse",
          toolName: "browse_screenshot",
          output: {
            type: "content",
            value: [
              { type: "text", text: JSON.stringify({ url: "https://x", elements: [] }) },
              { type: "image-data", data: "b0", mediaType: "image/jpeg" },
            ],
          },
        },
      ],
    } as ModelMessage;

    const tags = tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP, "s");
    const messages = [...history([], tags), browseShot];
    const result = applyImageBudget(messages);

    // browse_screenshot's slot is the newest, so it must stay live even
    // though older get_screenshot slots get elided by the step-wise cutoff.
    const browseResult = result[result.length - 1] as {
      content: { output: { value: unknown[] } }[];
    };
    const value = browseResult.content[0].output.value as Array<{ type: string; data?: string }>;
    expect(value.some((part) => part.type === "image-data" && part.data === "b0")).toBe(true);
  });

  it("does not crash on a message with non-array content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "plain string content, no parts" } as ModelMessage,
      screenshotMessage("s0"),
    ];
    expect(() => applyImageBudget(messages)).not.toThrow();
  });

  describe("step-wise cutoff", () => {
    it("moves in steps of S, never decreases, and keeps live count within H..H+S-1", () => {
      const tags = tagsOf(24, "s");
      let previousCutoff = 0;
      for (let n = 0; n <= tags.length; n++) {
        const messages = history([], tags.slice(0, n));
        const result = applyImageBudget(messages);
        const liveCount = tags.slice(0, n).filter((tag) => isScreenshotSlotLive(result, tag)).length;
        const cutoff = n - liveCount;

        if (n > MAX_LIVE_TOOL_RESULT_IMAGES) {
          expect(liveCount).toBeGreaterThanOrEqual(MAX_LIVE_TOOL_RESULT_IMAGES);
          expect(liveCount).toBeLessThanOrEqual(
            MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP - 1,
          );
        } else {
          expect(liveCount).toBe(n); // below the floor, everything is live
        }

        // Monotonicity: the cutoff index never decreases as the history grows.
        expect(cutoff).toBeGreaterThanOrEqual(previousCutoff);
        previousCutoff = cutoff;
      }
    });

    it("only changes the cutoff once every S new images, not on every single one", () => {
      const tags = tagsOf(20, "s");
      const cutoffs: number[] = [];
      for (let n = 0; n <= tags.length; n++) {
        const messages = history([], tags.slice(0, n));
        const result = applyImageBudget(messages);
        const liveCount = tags.slice(0, n).filter((tag) => isScreenshotSlotLive(result, tag)).length;
        cutoffs.push(n - liveCount);
      }
      // Count how many times the cutoff actually changes between consecutive N.
      let changes = 0;
      for (let i = 1; i < cutoffs.length; i++) {
        if (cutoffs[i] !== cutoffs[i - 1]) changes++;
      }
      // A step of S over 20 images changes at most floor(20/S) + 1 times —
      // strictly fewer than 20 (one change per new image, the "keep last N"
      // behavior this design explicitly avoids).
      expect(changes).toBeLessThanOrEqual(Math.ceil(20 / TOOL_RESULT_ELISION_STEP) + 1);
      expect(changes).toBeLessThan(20);
    });
  });

  describe("byte-stability across turns (hysteresis)", () => {
    it("gives elided slots byte-identical text whether or not one more image has since arrived", () => {
      const tags = tagsOf(10, "s");
      const before = history([], tags);
      const after = history([], [...tags, "s10"]);

      const resultBefore = applyImageBudget(before);
      const resultAfter = applyImageBudget(after);

      const textOf = (result: ModelMessage[], index: number) => {
        const content = (result[index] as { content: { output: unknown }[] }).content;
        return JSON.stringify(content[0].output);
      };

      // Slots elided in BOTH runs (the early ones, well below either cutoff)
      // must render identical text — this is the whole point of the
      // step-wise cutoff instead of "keep last N".
      for (let i = 0; i < 5; i++) {
        expect(textOf(resultBefore, i)).toBe(textOf(resultAfter, i));
      }
    });
  });

  it("is idempotent: running it twice equals running it once", () => {
    const messages = history(tagsOf(12, "u"), tagsOf(12, "s"));
    const once = applyImageBudget(messages);
    const twice = applyImageBudget(once);
    expect(twice).toEqual(once);
  });

  it("never elides a user attachment, however many screenshots pile up", () => {
    // The asymmetry is the whole point: a screenshot is re-fetchable
    // (get_screenshot), a user's attachment is not, so this pass drops the
    // former and never the latter. Twenty screenshots is far past the
    // tool-result budget, yet the single attachment stays a live image part.
    const messages = history(["u0"], tagsOf(20, "s"));
    const result = applyImageBudget(messages);
    expect(isUserSlotLive(result, "u0")).toBe(true);

    // ...and user images never push a screenshot out either: they are not
    // counted by the only budget there is.
    const messages2 = history(tagsOf(20, "u"), ["s0"]);
    const result2 = applyImageBudget(messages2);
    expect(isScreenshotSlotLive(result2, "s0")).toBe(true);
    expect(result2).toBe(messages2); // nothing to elide at all
    for (const tag of tagsOf(20, "u")) {
      expect(isUserSlotLive(result2, tag)).toBe(true);
    }
  });

  it("tells the model to take a fresh screenshot without naming a tool that may be absent", () => {
    // chatTurn drops get_screenshot from the tool set when the model can't
    // see and no VISION_MODEL is set, and the model is picked per chat — so
    // naming the tool would, after a mid-chat switch to a text-only model,
    // instruct a call that cannot be made.
    const tags = tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP, "s");
    const result = applyImageBudget(history([], tags));

    const part = (result[0] as { content: { output: { value: { text: string }[] } }[] })
      .content[0];
    expect(part.output.value[0].text).toContain("screenshot");
    expect(part.output.value[0].text).not.toContain("get_screenshot");
  });

  describe("MCP results (the shape production actually produces)", () => {
    // convertToModelMessages is called WITHOUT `{ tools }`, so an MCP result
    // never gets toModelOutput's `content` promotion — it arrives as
    // `{type:"json", value:{content:[...]}}`. Verified against the real SDK;
    // before this shape was handled, MCP images were invisible to the budget
    // entirely: never counted, never elided, re-sent verbatim every turn.
    const mcpResult = (tag: string, imageCount: number): ModelMessage =>
      ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${tag}`,
            toolName: "mcp__mobbin__search_screens",
            output: {
              type: "json",
              value: {
                content: [
                  { type: "text", text: `caption for ${tag}` },
                  ...Array.from({ length: imageCount }, (_, i) => ({
                    type: "image",
                    data: `${tag}-${i}`,
                    mimeType: "image/png",
                  })),
                ],
              },
            },
          },
        ],
      }) as ModelMessage;

    const liveImages = (result: ModelMessage[]): number =>
      (JSON.stringify(result).match(/"type":"image"/g) ?? []).length;

    it("counts and elides images carried in a json-shaped MCP result", () => {
      const n = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP;
      const messages = Array.from({ length: n }, (_, i) => mcpResult(`m${i}`, 1));
      const result = applyImageBudget(messages);
      expect(liveImages(result)).toBeLessThan(n);
    });

    it("charges a multi-image result for every image it carries, not for one slot", () => {
      // Three results of four images each is twelve images — over the budget
      // — even though it is only three slots. A slot-based count would leave
      // all twelve live.
      const messages = Array.from({ length: 3 }, (_, i) => mcpResult(`m${i}`, 4));
      const result = applyImageBudget(messages);
      expect(liveImages(result)).toBeLessThan(12);
    });

    it("keeps the caption when it elides the images beside it", () => {
      const n = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP;
      const messages = Array.from({ length: n }, (_, i) => mcpResult(`m${i}`, 1));
      const result = applyImageBudget(messages);

      const value = (
        result[0] as { content: { output: { value: { content: { text: string }[] } } }[] }
      ).content[0].output.value.content;
      expect(value[0].text).toBe("caption for m0"); // prose survived verbatim
      expect(value[1].text).toContain("omitted"); // image part replaced
      expect(JSON.stringify(result)).not.toContain('"m0-0"'); // payload gone
    });
  });

  it("does not tell the model to screenshot the canvas when what aged out was some other tool's image", () => {
    // collectImageSlots widens the structured path to EVERY image-bearing
    // tool result, so an MCP reference screen lands in this budget too.
    // Advising get_screenshot there sends the agent to do unrelated work —
    // and adds another tool-result slot while doing it.
    const mcpMessage = (tag: string): ModelMessage =>
      ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${tag}`,
            toolName: "refero_get_screen_image",
            output: {
              type: "content",
              value: [{ type: "image-data", data: tag, mediaType: "image/png" }],
            },
          },
        ],
      }) as ModelMessage;

    const n = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP;
    const messages = Array.from({ length: n }, (_, i) => mcpMessage(`m${i}`));
    const result = applyImageBudget(messages);

    const part = (result[0] as { content: { output: { value: { text: string }[] } }[] })
      .content[0];
    expect(part.output.value[0].text).not.toContain("get_screenshot");
    expect(part.output.value[0].text).toContain("omitted");
  });

  it("keeps the sibling text of a multi-part tool result when eliding its image", () => {
    // An MCP result routinely carries prose next to its screenshots.
    // Collapsing the whole `output` to one placeholder would throw that prose
    // away along with the pixels.
    const mixed = (tag: string): ModelMessage =>
      ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${tag}`,
            toolName: "refero_get_screen_image",
            output: {
              type: "content",
              value: [
                { type: "text", text: `caption for ${tag}` },
                { type: "image-data", data: tag, mediaType: "image/png" },
              ],
            },
          },
        ],
      }) as ModelMessage;

    const n = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP;
    const messages = Array.from({ length: n }, (_, i) => mixed(`m${i}`));
    const result = applyImageBudget(messages);

    const value = (result[0] as { content: { output: { value: { text: string }[] } }[] })
      .content[0].output.value;
    expect(value[0].text).toBe("caption for m0"); // sibling survived verbatim
    expect(value[1].text).toContain("omitted"); // image part replaced
    expect(isScreenshotSlotLive(result, "m0")).toBe(false);
  });

  it("does not let a tool result without an image spend the budget", () => {
    // An error result (`{"error": ...}`) produces no slot at all, so it must
    // not advance the cutoff. Order matters for this to discriminate: the
    // error results come LAST, so a pass that counted them would elide the
    // real screenshots at the FRONT. With them first, a buggy pass would
    // elide the error results instead and the real ones would survive anyway
    // — the test would pass without testing anything.
    const errorResult = (tag: string): ModelMessage =>
      ({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: `call-${tag}`,
            toolName: "get_screenshot",
            output: { type: "text", value: JSON.stringify({ error: "Node not found" }) },
          },
        ],
      }) as ModelMessage;

    const realTags = tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES, "s");
    const messages = [
      ...realTags.map((t) => screenshotMessage(t)),
      ...Array.from({ length: TOOL_RESULT_ELISION_STEP }, (_, i) => errorResult(`x${i}`)),
    ];
    const result = applyImageBudget(messages);

    // Exactly MAX_LIVE_TOOL_RESULT_IMAGES real screenshots — at the budget,
    // not over it — so every one of them must still be live.
    expect(result).toBe(messages);
    for (const tag of realTags) {
      expect(isScreenshotSlotLive(result, tag)).toBe(true);
    }
  });

  it("does not touch messages that carry no image slot", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "just text" }] } as ModelMessage,
      ...history([], tagsOf(20, "s")),
    ];
    const result = applyImageBudget(messages);
    expect(result[0]).toBe(messages[0]);
  });

  // Phase 2 (docs/specs/2026-09-21-jev-image-relevance-design.md): a rescue
  // SHIFTS elision to the next slot in line, it never REDUCES how many
  // images get elided. src/ai/imageRelevance.ts decides WHICH toolCallIds
  // to spare; these tests only cover applyImageBudget's/planImageElision's
  // own half of the contract — that spending a rescue moves the cutoff
  // sideways, not down.
  describe("rescue (Jev phase 2 — planImageElision / opts.rescued)", () => {
    it("planImageElision reports exactly the slots pure recency would elide", () => {
      const tags = tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP, "s");
      const messages = history([], tags);
      const plan = planImageElision(messages);
      const planned = new Set(plan.map((slot) => slot.toolCallId));
      // Every planned slot must actually be elided by a plain (unrescued)
      // applyImageBudget call, and vice versa.
      const budgeted = applyImageBudget(messages);
      for (const tag of tags) {
        const elided = !isScreenshotSlotLive(budgeted, tag);
        expect(planned.has(`call-${tag}`)).toBe(elided);
      }
    });

    it("is empty when nothing is over budget", () => {
      const messages = history([], tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES, "s"));
      expect(planImageElision(messages)).toEqual([]);
    });

    it("THE key property: rescuing one candidate elides a different slot, not fewer slots", () => {
      const tags = tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP, "s");
      const messages = history([], tags);

      const plan = planImageElision(messages);
      expect(plan.length).toBeGreaterThan(0);
      const rescuedId = plan[0].toolCallId as string;

      const withoutRescue = applyImageBudget(messages);
      const withRescue = applyImageBudget(messages, { rescued: new Set([rescuedId]) });

      const liveCount = (result: typeof messages) =>
        tags.filter((tag) => isScreenshotSlotLive(result, tag)).length;

      // A REAL bug this test must catch: "rescue reduces elision" would grow
      // liveCount by one instead of leaving it unchanged.
      expect(liveCount(withRescue)).toBe(liveCount(withoutRescue));

      // The rescued slot is now live...
      const rescuedTag = tags.find((tag) => `call-${tag}` === rescuedId) as string;
      expect(isScreenshotSlotLive(withRescue, rescuedTag)).toBe(true);
      // ...and exactly one slot that used to be live is now elided instead
      // (the next-oldest one in line), keeping the total elided count fixed.
      const elidedByRescue = tags.filter(
        (tag) => isScreenshotSlotLive(withoutRescue, tag) && !isScreenshotSlotLive(withRescue, tag),
      );
      expect(elidedByRescue.length).toBe(1);
    });

    it("rescuing every candidate in the eviction zone still elides the same total count", () => {
      const tags = tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES + 2 * TOOL_RESULT_ELISION_STEP, "s");
      const messages = history([], tags);

      const plan = planImageElision(messages);
      const rescued = new Set(plan.map((s) => s.toolCallId as string));

      const withoutRescue = applyImageBudget(messages);
      const withRescue = applyImageBudget(messages, { rescued });

      const liveCount = (result: typeof messages) =>
        tags.filter((tag) => isScreenshotSlotLive(result, tag)).length;

      // Same total elided/live count regardless of how many were rescued —
      // the walk just keeps reaching further back for a slot to elide.
      expect(liveCount(withRescue)).toBe(liveCount(withoutRescue));
    });

    it("a rescued toolCallId outside the eviction zone (a live slot) has no effect", () => {
      const messages = history([], tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES, "s"));
      const result = applyImageBudget(messages, { rescued: new Set(["call-s0"]) });
      expect(result).toBe(messages); // nothing was ever going to be elided
    });

    it("with no opts, behaves byte-identically to phase 1 (opts is optional)", () => {
      const tags = tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP, "s");
      const messages = history([], tags);
      expect(applyImageBudget(messages)).toEqual(applyImageBudget(messages, {}));
    });
  });

  describe("integration with applyVisionPreprocessing", () => {
    it("leaves an elided slot as plain text, so vision preprocessing never tries to describe it again", async () => {
      vi.resetModules();
      vi.doMock("../src/services/vision.js", () => ({
        peekCachedDescriptionByKey: vi.fn().mockReturnValue(undefined),
        peekCachedFailureByKey: vi.fn().mockReturnValue(undefined),
        describeImage: vi.fn(async () => ({ ok: true, text: "should not be called for elided slots" })),
        visionCacheKey: (image: string) => `key:${image}`,
        isVisionConfigured: () => true,
      }));
      const { applyImageBudget: budget } = await import("../src/ai/image-budget.js");
      const { applyVisionPreprocessing } = await import("../src/ai/vision-messages.js");
      const { makeConfig } = await import("./helpers.js");
      const { describeImage } = await import("../src/services/vision.js");

      const tags = tagsOf(MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP + 2, "s");
      const messages = history([], tags);
      const budgeted = budget(messages);

      // Force the vision-less path so applyVisionPreprocessing has to look
      // at every remaining slot, including the ones NOT elided by the budget.
      const config = makeConfig({
        CHAT_MODEL: "vendor/text-only-model",
        CHAT_MODEL_SUPPORTS_VISION: false,
      });
      await applyVisionPreprocessing(budgeted, { config, modelId: "vendor/text-only-model" });

      // Only the LIVE slots (unaffected by the image budget) can still
      // reach describeImage() — elided slots are already plain text by the
      // time vision preprocessing runs, so they never compete for its
      // MAX_DESCRIBED_IMAGES_PER_TURN budget or trigger a network call.
      expect(vi.mocked(describeImage).mock.calls.length).toBeLessThanOrEqual(
        MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP - 1,
      );
      vi.doUnmock("../src/services/vision.js");
    });
  });
});
