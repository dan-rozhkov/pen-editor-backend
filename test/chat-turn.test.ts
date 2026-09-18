import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadSkills, getSkill } from "../src/ai/skills.js";
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
}));

// Mocked so describeImage() never makes a live network call to VISION_MODEL
// — used directly by the "get_screenshot vision preprocessing" describe
// block below, and indirectly by the pre-existing analyze_image gate tests
// (analyze_image's execute() calls describeImage() too). Default resolved
// value keeps those pre-existing tests passing without caring about vision
// content; the get_screenshot describe block overrides it per-test.
vi.mock("../src/services/vision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/vision.js")>();
  return {
    ...actual,
    describeImage: vi.fn().mockResolvedValue({ ok: true, text: "stub description" }),
  };
});

// prepareChatTurn calls createModel(config, modelOverride), which needs a
// real OpenRouter provider construction only — createModel itself doesn't
// make network calls, it just builds a LanguageModel descriptor, so no mock
// is required here (unlike test/chat-route.test.ts, which mocks it to swap
// in MockLanguageModelV3 for streaming).

function userMessage(text: string) {
  return { role: "user", parts: [{ type: "text", text }] };
}

describe("prepareChatTurn", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("routes a /prototype slash command to a non-native task policy with the embed-only batch_design variant", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const skill = getSkill("prototype");
    expect(skill).toBeDefined();

    const config = makeConfig();
    const messages = [userMessage("/prototype a login screen")];

    const turn = await prepareChatTurn({ config, messages });

    expect(turn.taskPolicy).toBe("prototype");
    expect(turn.slashSkillName).toBe("prototype");
    expect(turn.tools.batch_design).toBeDefined();

    // The embed-only variant is a distinct tool instance from the default
    // penTools.batch_design (schema swapped in resolveTaskPolicy branch).
    const { penTools } = await import("../src/ai/tools.js");
    expect(turn.tools.batch_design).not.toBe(penTools.batch_design);
    expect(turn.tools.draw_vector).toBeUndefined();
    // Same embed-only reasoning as draw_vector: vectorize_image's default
    // mode: "layers" places native vector paths, which this mode has no
    // scene graph for. remove_background is asymmetric — see the dedicated
    // "remove_background / vectorize_image gates" describe block below.
    expect(turn.tools.vectorize_image).toBeUndefined();
  });

  it("does not expose draw_vector to /slides turns", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

    const config = makeConfig();
    const messages = [userMessage("/slides a quarterly review")];

    const turn = await prepareChatTurn({ config, messages });

    expect(turn.taskPolicy).toBe("slides");
    expect(turn.tools.draw_vector).toBeUndefined();
    expect(turn.tools.vectorize_image).toBeUndefined();
  });

  // Regression: prepareChatTurn used to assume some *other* code had already
  // called loadSkills() — true for the HTTP server (src/index.ts does it at
  // boot), false for the showcase runner, which is a separate process. There,
  // every skill lookup resolved to nothing and the turn was assembled with no
  // skill instructions, no skill catalog in the system prompt, and a
  // load_skill tool that could not resolve a name. Nothing threw; the agent
  // just silently lost its craft rules. The tests above miss this because
  // their beforeAll preloads the skills — so this one deliberately does not.
  it("injects skill instructions even when nothing preloaded the skills", async () => {
    vi.resetModules();
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

    const config = makeConfig();
    const messages = [userMessage("/prototype a login screen")];

    const turn = await prepareChatTurn({ config, messages });

    const injected = JSON.stringify(turn.modelMessages);
    expect(injected).toContain("Agent Mode: prototype");
    // The catalog of available skills is built from the same map.
    expect(turn.system).toContain("prototype");
    expect(turn.tools.load_skill).toBeDefined();
  });

  it("resolves a plain message to the native task policy with a non-empty system prompt", async () => {
    const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
    const { penTools } = await import("../src/ai/tools.js");

    const config = makeConfig();
    const messages = [userMessage("make the header bigger")];

    const turn = await prepareChatTurn({ config, messages });

    expect(turn.taskPolicy).toBe("native");
    expect(turn.slashSkillName).toBeUndefined();
    expect(turn.system.length).toBeGreaterThan(0);
    expect(turn.tools.batch_design).toBe(penTools.batch_design);
    expect(turn.tools.draw_vector).toBe(penTools.draw_vector);
  });

  describe("remove_background / vectorize_image gates", () => {
    it("are absent without FAL_KEY, even on the native task policy", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ FAL_KEY: undefined }),
        messages: [userMessage("make the header bigger")],
      });

      expect(turn.taskPolicy).toBe("native");
      expect(turn.tools.remove_background).toBeUndefined();
      expect(turn.tools.vectorize_image).toBeUndefined();
    });

    it("are present on the native task policy when FAL_KEY is configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ FAL_KEY: "test-fal-key" }),
        messages: [userMessage("make the header bigger")],
      });

      expect(turn.taskPolicy).toBe("native");
      expect(turn.tools.remove_background).toBeDefined();
      expect(turn.tools.vectorize_image).toBeDefined();
    });

    it("the embed-only gate is ASYMMETRIC on a /prototype turn: vectorize_image is gone, remove_background stays — isolated from the FAL_KEY gate by configuring FAL_KEY", async () => {
      // The gate exists to stop NATIVE SCENE NODES from appearing in
      // embed-only mode. vectorize_image's default mode: "layers" does
      // exactly that (like draw_vector), so it's gated out. remove_background
      // in its image_url form never touches the scene graph — URL in, URL
      // out, meant to land in an embed's <img src> — which is exactly the
      // real imagery prototype/slides screens want, so it stays available.
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ FAL_KEY: "test-fal-key" }),
        messages: [userMessage("/prototype a login screen")],
      });

      expect(turn.taskPolicy).toBe("prototype");
      expect(turn.tools.vectorize_image).toBeUndefined();
      expect(turn.tools.remove_background).toBeDefined();
    });

    it("the same asymmetry holds on a /slides turn", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ FAL_KEY: "test-fal-key" }),
        messages: [userMessage("/slides a quarterly review")],
      });

      expect(turn.taskPolicy).toBe("slides");
      expect(turn.tools.vectorize_image).toBeUndefined();
      expect(turn.tools.remove_background).toBeDefined();
    });
  });

  describe("get_screenshot gate", () => {
    // The shipped model reads images natively, so the vision-less cases below
    // use the other supported shape: an operator-pointed text-only model
    // declared with CHAT_MODEL_SUPPORTS_VISION=false.
    it("is absent when the model is vision-less and no VISION_MODEL is configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({
        VISION_MODEL: "",
        CHAT_MODEL: "vendor/text-only-model",
        CHAT_MODEL_SUPPORTS_VISION: false,
      });
      const messages = [userMessage("make the header bigger")];

      const turn = await prepareChatTurn({ config, messages });

      expect(turn.tools.get_screenshot).toBeUndefined();
    });

    it("is present when a VISION_MODEL is configured, even for a vision-less main model", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({
        VISION_MODEL: "google/gemini-2.5-flash",
        CHAT_MODEL: "vendor/text-only-model",
        CHAT_MODEL_SUPPORTS_VISION: false,
      });
      const messages = [userMessage("make the header bigger")];

      const turn = await prepareChatTurn({ config, messages });

      expect(turn.tools.get_screenshot).toBeDefined();
    });

    it("is present when the main model is vision-capable, even with vision unconfigured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({ VISION_MODEL: "" });
      const messages = [userMessage("make the header bigger")];

      const turn = await prepareChatTurn({
        config,
        messages,
        modelOverride: "google/gemini-2.5-flash",
      });

      expect(turn.tools.get_screenshot).toBeDefined();
    });

    // Regression: the gate used to be single-axis ("does the model see, OR
    // is VISION_MODEL configured") and ignored providerHandlesToolResultImages
    // entirely. opencode-go/deepseek-v4-flash-vision-exp is vision-capable
    // (no DEFAULT_MODELS entry, so modelSupportsVision assumes true) but its
    // provider ("opencode-go") routes through @ai-sdk/openai-compatible,
    // which cannot carry a tool-result image natively — so with no
    // VISION_MODEL configured, every get_screenshot call would resolve to
    // the literal "Vision is not configured on this server" placeholder
    // (src/services/vision.ts), a phantom tool exactly like the vision-less
    // case above. The old single-axis check kept the tool in this case
    // because it only asked "does the model see" — this pins the fix.
    it("is absent for a vision-capable OpenCode model when no VISION_MODEL is configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({ VISION_MODEL: "" });
      const messages = [userMessage("make the header bigger")];

      const turn = await prepareChatTurn({
        config,
        messages,
        modelOverride: "opencode-go/deepseek-v4-flash-vision-exp",
        opencodeApiKey: "sk-test-key",
      });

      expect(turn.tools.get_screenshot).toBeUndefined();
    });

    it("is present for the same vision-capable OpenCode model once VISION_MODEL is configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({ VISION_MODEL: "google/gemini-2.5-flash" });
      const messages = [userMessage("make the header bigger")];

      const turn = await prepareChatTurn({
        config,
        messages,
        modelOverride: "opencode-go/deepseek-v4-flash-vision-exp",
        opencodeApiKey: "sk-test-key",
      });

      expect(turn.tools.get_screenshot).toBeDefined();
    });
  });

  describe("attach_local_repo gate", () => {
    // attach_local_repo is client-executed and declared in penTools solely
    // to satisfy pen-editor's cross-repo tool-name contract — the design
    // agent runs in a browser with no filesystem, so it must never actually
    // be offered a normal chat turn's tools. Only a local agent driving the
    // editor tab over WebMCP calls it directly.
    it("is never offered in a normal turn's tool set", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const { penTools } = await import("../src/ai/tools.js");

      expect(penTools.attach_local_repo).toBeDefined();

      const messages = [userMessage("build a design from this repo")];
      const turn = await prepareChatTurn({ config: makeConfig(), messages });

      expect(turn.tools.attach_local_repo).toBeUndefined();
    });
  });

  describe("analyze_image gate", () => {
    it("is absent with no VISION_MODEL — it would have nothing to call", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ VISION_MODEL: "" }),
        messages: [userMessage("look at this reference")],
      });

      expect(turn.tools.analyze_image).toBeUndefined();
    });

    it("is present, and carries this request's config, when vision is configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ VISION_MODEL: "google/gemini-2.5-flash" }),
        messages: [userMessage("look at this reference")],
      });

      expect(turn.tools.analyze_image).toBeDefined();
      // A config-less static entry would answer with the wiring-bug message
      // instead of actually calling the vision service.
      const result = await (
        turn.tools.analyze_image as {
          execute: (args: { imageUrl: string }) => Promise<string>;
        }
      ).execute({ imageUrl: "https://example.com/a.png" });
      expect(result).not.toContain("was not given a server config");
    });
  });

  // The invariant src/ai/vision-messages.ts exists to hold, end to end
  // through prepareChatTurn: a get_screenshot result's image must reach the
  // model in a shape the model can actually use — a real image part when it
  // can see, a text description when it cannot — and NEVER as a base64 blob
  // sitting in tool-message text. The latter is not hypothetical: it is what
  // @ai-sdk/deepseek did to every screenshot while that provider was wired
  // up, with no error anywhere.
  describe("get_screenshot vision preprocessing", () => {
    const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg";

    function screenshotHistory(): Record<string, unknown>[] {
      return [
        userMessage("check the header"),
        {
          id: "a1",
          role: "assistant",
          parts: [
            {
              type: "tool-get_screenshot",
              toolCallId: "call-1",
              state: "output-available",
              input: { nodeId: "header-1" },
              output: JSON.stringify({ imageData: DATA_URL }),
            },
          ],
        },
      ];
    }

    it("leaves the screenshot native at the shipped default, which reads images", async () => {
      const { describeImage } = await import("../src/services/vision.js");
      // Other tests in this file share the module-level mock.
      vi.mocked(describeImage).mockClear();
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      // makeConfig() with NO CHAT_MODEL override — the real shipped default.
      const config = makeConfig();
      const turn = await prepareChatTurn({ config, messages: screenshotHistory() });

      const bodyText = JSON.stringify(turn.modelMessages);
      // Present as image data the provider will map to a real image part,
      // not converted and not described.
      expect(bodyText).toContain("iVBORw0KGgoAAAANSUhEUg");
      expect(describeImage).not.toHaveBeenCalled();
    });

    it("describes the screenshot instead when the chat model cannot read images", async () => {
      const { describeImage } = await import("../src/services/vision.js");
      vi.mocked(describeImage).mockResolvedValue({
        ok: true,
        text: "A header with a logo and three nav links.",
      });
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({
        CHAT_MODEL: "vendor/text-only-model",
        CHAT_MODEL_SUPPORTS_VISION: false,
      });
      const turn = await prepareChatTurn({ config, messages: screenshotHistory() });

      const bodyText = JSON.stringify(turn.modelMessages);
      // The base64 payload must not appear anywhere in the request body, in
      // any shape (raw text, JSON-stringified content part).
      expect(bodyText).not.toContain("iVBORw0KGgoAAAANSUhEUg");
      expect(bodyText).toContain("A header with a logo and three nav links.");
    });
  });
});
