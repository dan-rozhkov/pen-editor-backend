import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DOC_ONLY_SKILL_NAMES, loadSkills, getSkill } from "../src/ai/skills.js";
import { createModel } from "../src/ai/provider.js";
import { AGENT_BROWSER_GUIDANCE, AGENT_BROWSER_QA_GUIDANCE, AGENT_BROWSER_QA_ISOLATED_GUIDANCE, BROWSE_AGENT_LOGIN_PROMPT, BROWSE_AGENT_PROMPT, browseAgentPrompt, MANUAL_BROWSER_GUIDANCE } from "../src/ai/system-prompt.js";
import { asSchema } from "ai";
import { browseAgentToolWithApp, browseOpenToolApp, browseOpenToolAppNative, penTools } from "../src/ai/tools.js";
import {
  PEN_EDITOR_BROWSE_AGENT_APP_FIELD,
  PEN_EDITOR_BROWSE_AGENT_APP_RULES,
  PEN_EDITOR_BROWSE_APP_SLOTS,
} from "../src/ai/browseToolText.js";
import flagOffGolden from "./fixtures/browse-app-flag-off.golden.json" with { type: "json" };
import { makeConfig } from "./helpers.js";

vi.mock("../src/ai/mcp.js", () => ({
  getMCPTools: vi.fn(async () => ({})),
  closeAllMCPClients: vi.fn(async () => {}),
  attachMobbinRelease: vi.fn(),
  releaseMCPTools: vi.fn(),
}));

// Pass-through spy: the browse-subagent tests assert what prepareChatTurn
// hands to createModel; every other test gets the real implementation.
vi.mock("../src/ai/provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/provider.js")>();
  return { ...actual, createModel: vi.fn(actual.createModel) };
});

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
// in MockLanguageModelV4 for streaming).

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

  // Finding #8 (2026-09 review): generate_vector has two independent gates —
  // the embed-only structural gate (like draw_vector/vectorize_image) and
  // the QUIVER_API_KEY key gate (like FAL_KEY on remove_background/
  // vectorize_image) — and neither had a test. Without these, a refactor
  // could silently advertise generate_vector on a deployment whose
  // POST /api/vector/generate answers 503, a guaranteed-failing step for the
  // model with a green suite.
  describe("generate_vector gates", () => {
    it("is absent without QUIVER_API_KEY, even on the native task policy", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ QUIVER_API_KEY: undefined }),
        messages: [userMessage("make the header bigger")],
      });

      expect(turn.taskPolicy).toBe("native");
      expect(turn.tools.generate_vector).toBeUndefined();
    });

    it("is present on the native task policy when QUIVER_API_KEY is configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const { penTools } = await import("../src/ai/tools.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ QUIVER_API_KEY: "qv-test" }),
        messages: [userMessage("make the header bigger")],
      });

      expect(turn.taskPolicy).toBe("native");
      expect(turn.tools.generate_vector).toBe(penTools.generate_vector);
    });

    it("is absent on a /prototype turn (embed-only gate) even with QUIVER_API_KEY configured", async () => {
      // Isolates the embed-only structural gate from the QUIVER_API_KEY gate
      // — generate_vector places real scene nodes (paths/groups) exactly
      // like draw_vector/vectorize_image, so it's gated out of embed-only
      // mode regardless of whether the key gate would otherwise pass it.
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ QUIVER_API_KEY: "qv-test" }),
        messages: [userMessage("/prototype a login screen")],
      });

      expect(turn.taskPolicy).toBe("prototype");
      expect(turn.tools.generate_vector).toBeUndefined();
    });

    it("is absent on a /slides turn (embed-only gate) even with QUIVER_API_KEY configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ QUIVER_API_KEY: "qv-test" }),
        messages: [userMessage("/slides a quarterly review")],
      });

      expect(turn.taskPolicy).toBe("slides");
      expect(turn.tools.generate_vector).toBeUndefined();
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
    it("is present for the verified opencode-go deepseek-v4.1-flash without VISION_MODEL (images re-expanded natively)", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ VISION_MODEL: "" }),
        messages: [userMessage("make the header bigger")],
        modelOverride: "opencode-go/deepseek-v4.1-flash",
        opencodeApiKey: "sk-test-key",
      });

      expect(turn.tools.get_screenshot).toBeDefined();
    });

    it("is absent for an unverified opencode-go model without VISION_MODEL", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const turn = await prepareChatTurn({
        config: makeConfig({ VISION_MODEL: "" }),
        messages: [userMessage("make the header bigger")],
        modelOverride: "opencode-go/deepseek-v4-flash-vision-exp",
        opencodeApiKey: "sk-test-key",
      });

      expect(turn.tools.get_screenshot).toBeUndefined();
    });

    it("is absent for a vision-capable OpenCode Zen model when no VISION_MODEL is configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({ VISION_MODEL: "" });
      const messages = [userMessage("make the header bigger")];

      const turn = await prepareChatTurn({
        config,
        messages,
        modelOverride: "opencode/deepseek-v4-flash-vision-exp",
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

  describe("open_canvas_tab gate", () => {
    it.each([
      ["no clientCapabilities", undefined, false],
      ["canvasTabs false", { canvasTabs: false }, false],
      ["canvasTabs absent", { desktopBrowser: true }, false],
      ["canvasTabs true", { canvasTabs: true }, true],
    ])("%s", async (_label, caps, expected) => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const turn = await prepareChatTurn({
        config: makeConfig(),
        messages: [userMessage("open a new canvas")],
        clientCapabilities: caps,
      });
      expect(turn.tools.open_canvas_tab !== undefined).toBe(expected);
    });
  });

  describe("doc_* gate", () => {
    const names = ["doc_list", "doc_create", "doc_read", "doc_edit", "doc_open", "doc_insert_image"];
    it.each([
      ["no clientCapabilities", undefined, false],
      ["docTabs false", { docTabs: false }, false],
      ["docTabs absent", { canvasTabs: true }, false],
      ["docTabs true", { docTabs: true }, true],
    ])("%s", async (_label, caps, expected) => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const turn = await prepareChatTurn({
        config: makeConfig(),
        messages: [userMessage("write a spec")],
        clientCapabilities: caps,
      });
      for (const n of names) expect(turn.tools[n] !== undefined).toBe(expected);
    });
  });

  describe("workflow_* gate", () => {
    const names = ["workflow_list", "workflow_create", "workflow_read", "workflow_edit", "workflow_open"];
    it.each([
      ["no clientCapabilities", undefined, false],
      ["workflowTabs false", { workflowTabs: false }, false],
      ["workflowTabs absent", { docTabs: true }, false],
      ["workflowTabs true", { workflowTabs: true }, true],
    ])("%s", async (_label, caps, expected) => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const turn = await prepareChatTurn({
        config: makeConfig(),
        messages: [userMessage("make a checklist")],
        clientCapabilities: caps,
      });
      for (const n of names) expect(turn.tools[n] !== undefined).toBe(expected);
    });
  });

  describe("trace_* gate", () => {
    const names = ["trace_list", "trace_open", "trace_read", "trace_frame"];
    it.each([
      ["no clientCapabilities", undefined, false],
      ["traceTabs false", { traceTabs: false }, false],
      ["traceTabs absent", { docTabs: true }, false],
      ["traceTabs true", { traceTabs: true }, true],
    ])("%s", async (_label, caps, expected) => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const turn = await prepareChatTurn({
        config: makeConfig(),
        messages: [userMessage("what happened in this run")],
        clientCapabilities: caps,
      });
      for (const n of names) expect(turn.tools[n] !== undefined).toBe(expected);
    });
  });

  describe("browse_* gate", () => {
    // browse_open/browse_act/browse_find_images/browse_read only execute
    // inside the Electron shell's built-in browser bridge — a browser-hosted
    // session has no such bridge, so they must be absent unless the request
    // says clientCapabilities.desktopBrowser is true.
    it("is absent when clientCapabilities is not passed", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const { penTools } = await import("../src/ai/tools.js");

      expect(penTools.browse_open).toBeDefined();
      expect(penTools.browse_snapshot).toBeDefined();
      expect(penTools.browse_screenshot).toBeDefined();
      expect(penTools.browse_act).toBeDefined();
      expect(penTools.browse_tabs).toBeDefined();
      expect(penTools.browse_find_images).toBeDefined();
      expect(penTools.browse_read).toBeDefined();

      const messages = [userMessage("find some reference images")];
      const turn = await prepareChatTurn({ config: makeConfig(), messages });

      expect(turn.tools.browse_open).toBeUndefined();
      expect(turn.tools.browse_snapshot).toBeUndefined();
      expect(turn.tools.browse_screenshot).toBeUndefined();
      expect(turn.tools.browse_act).toBeUndefined();
      expect(turn.tools.browse_tabs).toBeUndefined();
      expect(turn.tools.browse_find_images).toBeUndefined();
      expect(turn.tools.browse_read).toBeUndefined();
    });

    it("is absent when desktopBrowser is explicitly false", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const messages = [userMessage("find some reference images")];
      const turn = await prepareChatTurn({
        config: makeConfig(),
        messages,
        clientCapabilities: { desktopBrowser: false },
      });

      expect(turn.tools.browse_open).toBeUndefined();
      expect(turn.tools.browse_snapshot).toBeUndefined();
      expect(turn.tools.browse_screenshot).toBeUndefined();
      expect(turn.tools.browse_act).toBeUndefined();
      expect(turn.tools.browse_tabs).toBeUndefined();
      expect(turn.tools.browse_find_images).toBeUndefined();
      expect(turn.tools.browse_read).toBeUndefined();
    });

    it.each([
      ["browser:'desktop'", { browser: "desktop" as const }, undefined, true],
      ["browser:'cloud' with STEEL_API_KEY", { browser: "cloud" as const }, "steel-key", true],
      ["browser:'cloud' without STEEL_API_KEY", { browser: "cloud" as const }, undefined, false],
      ["legacy desktopBrowser:true (no browser)", { desktopBrowser: true }, undefined, true],
      ["browser:'cloud' overrides legacy desktopBrowser:true without a key", { browser: "cloud" as const, desktopBrowser: true }, undefined, false],
    ])("browse_open gate: %s", async (_label, caps, steelKey, expected) => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const turn = await prepareChatTurn({
        config: makeConfig({ STEEL_API_KEY: steelKey }),
        messages: [userMessage("find some reference images")],
        clientCapabilities: caps,
        modelOverride: "google/gemini-2.5-flash",
      });
      expect(turn.tools.browse_open !== undefined).toBe(expected);
      expect(turn.tools.browse_act !== undefined).toBe(expected);
    });

    it("is present when desktopBrowser is true", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const messages = [userMessage("find some reference images")];
      const turn = await prepareChatTurn({
        config: makeConfig(),
        messages,
        clientCapabilities: { desktopBrowser: true },
        modelOverride: "google/gemini-2.5-flash",
      });

      expect(turn.tools.browse_open).toBeDefined();
      expect(turn.tools.browse_snapshot).toBeDefined();
      // browse_screenshot additionally needs the vision gate — satisfied
      // here via a vision-capable modelOverride, see the dedicated
      // describe block below for the vision-gate-specific cases.
      expect(turn.tools.browse_screenshot).toBeDefined();
      expect(turn.tools.browse_act).toBeDefined();
      expect(turn.tools.browse_tabs).toBeDefined();
      expect(turn.tools.browse_find_images).toBeDefined();
      expect(turn.tools.browse_read).toBeDefined();
    });
  });

  describe("browse_screenshot vision gate", () => {
    // browse_screenshot joins get_screenshot's own vision gate (both are in
    // SCREENSHOT_TOOL_NAMES) ON TOP OF the desktopBrowser structural gate
    // above — either gate deleting it is sufficient.
    it("is absent with desktopBrowser true but no vision path and no VISION_MODEL", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({
        VISION_MODEL: "",
        CHAT_MODEL: "vendor/text-only-model",
        CHAT_MODEL_SUPPORTS_VISION: false,
      });
      const messages = [userMessage("check the page")];

      const turn = await prepareChatTurn({
        config,
        messages,
        clientCapabilities: { desktopBrowser: true },
      });

      expect(turn.tools.browse_screenshot).toBeUndefined();
      // Its siblings are unaffected by the vision gate.
      expect(turn.tools.browse_open).toBeDefined();
    });

    it("is present with desktopBrowser true and a VISION_MODEL configured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({
        VISION_MODEL: "google/gemini-2.5-flash",
        CHAT_MODEL: "vendor/text-only-model",
        CHAT_MODEL_SUPPORTS_VISION: false,
      });
      const messages = [userMessage("check the page")];

      const turn = await prepareChatTurn({
        config,
        messages,
        clientCapabilities: { desktopBrowser: true },
      });

      expect(turn.tools.browse_screenshot).toBeDefined();
    });

    it("is present with desktopBrowser true and a vision-capable model, even with vision unconfigured", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({ VISION_MODEL: "" });
      const messages = [userMessage("check the page")];

      const turn = await prepareChatTurn({
        config,
        messages,
        clientCapabilities: { desktopBrowser: true },
        modelOverride: "google/gemini-2.5-flash",
      });

      expect(turn.tools.browse_screenshot).toBeDefined();
    });
  });

  describe("browse_task key gate", () => {
    // browse_task, unlike its browse_open/browse_act/browse_find_images
    // siblings, drives POST /api/browse/step (Jev) from the frontend's own
    // loop — that route 503s outright without TYPESAFE_API_KEY. Gate it
    // the same way remove_background/vectorize_image are gated on FAL_KEY,
    // so the tool is never advertised only to fail every call.
    it("is absent when TYPESAFE_API_KEY is unset, even with desktopBrowser", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const { penTools } = await import("../src/ai/tools.js");

      expect(penTools.browse_task).toBeDefined();

      const messages = [userMessage("log in and get to the pricing page")];
      const turn = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: undefined }),
        messages,
        clientCapabilities: { desktopBrowser: true },
      });

      expect(turn.tools.browse_task).toBeUndefined();
      // Its siblings are unaffected by the key gate.
      expect(turn.tools.browse_open).toBeDefined();
    });

    it("is present when both desktopBrowser and TYPESAFE_API_KEY are set", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const messages = [userMessage("log in and get to the pricing page")];
      const turn = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: "key", BROWSE_MODE: "task" }),
        messages,
        clientCapabilities: { desktopBrowser: true },
      });

      expect(turn.tools.browse_task).toBeDefined();
    });

    it("renders the browse_task-first rule into system only when browse_task is offered", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const messages = [userMessage("open skroutz.gr and build a cart")];
      const on = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: "key", BROWSE_MODE: "task" }),
        messages,
        clientCapabilities: { desktopBrowser: true },
      });
      expect(on.tools.browse_task).toBeDefined();
      expect(on.system).toContain("## Browser tasks");
      expect(on.system).toContain("starts with `browse_task`");

      const noKey = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: undefined, BROWSE_MODE: "task" }),
        messages,
        clientCapabilities: { desktopBrowser: true },
      });
      expect(noKey.tools.browse_task).toBeUndefined();
      expect(noKey.system).not.toContain("starts with `browse_task`");
      expect(noKey.system).toContain("Drive the built-in browser yourself");

      const noBrowser = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: "key", BROWSE_MODE: "task" }),
        messages,
      });
      expect(noBrowser.system).not.toContain("## Browser tasks");

      // Constant across requests (prompt caching).
      const again = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: "key", BROWSE_MODE: "task" }),
        messages: [userMessage("something else entirely")],
        clientCapabilities: { desktopBrowser: true },
      });
      expect(again.systemPromptHash).toBe(on.systemPromptHash);
    });

    it("is absent without desktopBrowser even when TYPESAFE_API_KEY is set", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const messages = [userMessage("log in and get to the pricing page")];
      const turn = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: "key", BROWSE_MODE: "task" }),
        messages,
      });

      expect(turn.tools.browse_task).toBeUndefined();
    });
  });

  describe("BROWSE_MODE manual (default)", () => {
    it("offers no browse_task, renders the manual rule, even with the TypeSafe key", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const { MANUAL_BROWSER_GUIDANCE, BROWSER_TASKS_GUIDANCE } = await import("../src/ai/system-prompt.js");
      const messages = [userMessage("open skroutz.gr and build a cart")];
      const turn = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: "key" }),
        messages,
        clientCapabilities: { desktopBrowser: true },
      });
      expect(turn.tools.browse_task).toBeUndefined();
      expect(turn.tools.browse_open).toBeDefined();
      expect(turn.tools.browse_snapshot).toBeDefined();
      expect(turn.tools.browse_act).toBeDefined();
      expect(turn.system).toContain("## Browser tasks");
      expect(turn.system).toContain(MANUAL_BROWSER_GUIDANCE);
      expect(turn.system).not.toContain(BROWSER_TASKS_GUIDANCE);
    });

    it("task mode without the TypeSafe key falls back to the manual rule", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const { MANUAL_BROWSER_GUIDANCE } = await import("../src/ai/system-prompt.js");
      const turn = await prepareChatTurn({
        config: makeConfig({ TYPESAFE_API_KEY: undefined, BROWSE_MODE: "task" }),
        messages: [userMessage("open skroutz.gr")],
        clientCapabilities: { desktopBrowser: true },
      });
      expect(turn.tools.browse_task).toBeUndefined();
      expect(turn.system).toContain(MANUAL_BROWSER_GUIDANCE);
    });

    it("no browser renders neither rule", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      for (const mode of ["manual", "task"] as const) {
        const turn = await prepareChatTurn({
          config: makeConfig({ TYPESAFE_API_KEY: "key", BROWSE_MODE: mode }),
          messages: [userMessage("hello")],
        });
        expect(turn.system).not.toContain("## Browser tasks");
      }
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

    // Regression test for the bug fixed 2026-09-23: convertToModelMessages
    // (chatTurn.ts) is called without `{ tools }`, so toModelOutput never ran
    // and this whole screenshot promotion used to be dead code in
    // production — vision-messages.test.ts/image-budget.test.ts's coverage
    // of the "content" shape only ever exercised a shape hand-built in the
    // test, never one that came out of the real conversion. These two tests
    // go through the REAL prepareChatTurn (real convertToModelMessages, the
    // new promoteScreenshotToolOutputs pass, and real applyVisionPreprocessing)
    // end to end, so they would have failed before the fix.
    it("promotes the get_screenshot text output to a real image file part, not base64 inside a JSON string", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const config = makeConfig(); // shipped default: vision-capable, native tool-result images

      const turn = await prepareChatTurn({ config, messages: screenshotHistory() });

      const toolMessage = turn.modelMessages.find(
        (m) => m.role === "tool",
      ) as unknown as {
        content: Array<{ output: { type: string; value: unknown } }>;
      };
      const output = toolMessage.content[0].output;
      expect(output.type).toBe("content");
      const parts = output.value as Array<{ type: string; data?: unknown }>;
      expect(parts).toEqual([
        { type: "file", mediaType: "image/png", data: { type: "data", data: "iVBORw0KGgoAAAANSUhEUg" } },
      ]);
      // The bug's failure mode: the base64 sitting inside a plain text/JSON
      // output instead of a real image file part. Assert the negative too.
      expect(
        toolMessage.content.some(
          (c) => c.output.type === "text" || c.output.type === "json",
        ),
      ).toBe(false);
    });
  });

  describe("browse_screenshot vision preprocessing", () => {
    const DATA_URL = "data:image/jpeg;base64,QUJDRUxFTUVOVFM";

    function browseScreenshotHistory(): Record<string, unknown>[] {
      return [
        userMessage("check the signup page"),
        {
          id: "b1",
          role: "assistant",
          parts: [
            {
              type: "tool-browse_screenshot",
              toolCallId: "call-b1",
              state: "output-available",
              input: { annotate: true },
              output: JSON.stringify({
                imageData: DATA_URL,
                url: "https://example.com/signup",
                title: "Sign up",
                width: 390,
                height: 844,
                snapshotId: "snap-42",
                elements: [{ index: 0, tag: "button", label: "Continue", ops: ["click"] }],
              }),
            },
          ],
        },
      ];
    }

    it("carries a real image file part on the native vision path, not a base64 JSON string", async () => {
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
      const config = makeConfig(); // shipped default: vision-capable, native tool-result images

      const turn = await prepareChatTurn({ config, messages: browseScreenshotHistory() });

      const toolMessage = turn.modelMessages.find(
        (m) => m.role === "tool",
      ) as unknown as {
        content: Array<{ output: { type: string; value: unknown } }>;
      };
      const output = toolMessage.content[0].output;
      expect(output.type).toBe("content");
      const parts = output.value as Array<{
        type: string;
        text?: string;
        data?: unknown;
        mediaType?: string;
      }>;
      const imagePart = parts.find((p) => p.type === "file");
      expect(imagePart).toEqual({
        type: "file",
        mediaType: "image/jpeg",
        data: { type: "data", data: "QUJDRUxFTUVOVFM" },
      });
      // The url/title/snapshotId/elements table survives as a sibling text
      // part rather than being flattened into (or dropped from) the image.
      const textPart = parts.find((p) => p.type === "text");
      const parsed = JSON.parse(textPart!.text!) as Record<string, unknown>;
      expect(parsed.snapshotId).toBe("snap-42");
      expect(parsed.elements).toEqual([{ index: 0, tag: "button", label: "Continue", ops: ["click"] }]);
      expect(parsed.imageData).toBeUndefined();
    });

    it("describes the image for a vision-less model while keeping the element table intact", async () => {
      const { describeImage } = await import("../src/services/vision.js");
      vi.mocked(describeImage).mockResolvedValue({
        ok: true,
        text: "A signup form with a Continue button.",
      });
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const config = makeConfig({
        CHAT_MODEL: "vendor/text-only-model",
        CHAT_MODEL_SUPPORTS_VISION: false,
      });
      const turn = await prepareChatTurn({ config, messages: browseScreenshotHistory() });

      const bodyText = JSON.stringify(turn.modelMessages);
      // The raw base64 must never reach the model.
      expect(bodyText).not.toContain("QUJDRUxFTUVOVFM");
      // The description replaces only the image...
      expect(bodyText).toContain("A signup form with a Continue button.");
      // ...while the structured element table (this is the whole point of
      // browse_screenshot's richer shape over get_screenshot's) survives.
      expect(bodyText).toContain("snap-42");
      expect(bodyText).toContain("Continue");
    });
  });

  // Confirms applyImageBudget (src/ai/image-budget.ts) is actually wired
  // into prepareChatTurn, not just unit-tested in isolation: a long history
  // of screenshots must arrive at streamText already trimmed, since nothing
  // else caps this for a vision-capable model on the shipped default
  // (applyVisionPreprocessing itself returns such a history untouched).
  describe("image budget", () => {
    function screenshotHistory(count: number): Record<string, unknown>[] {
      const messages: Record<string, unknown>[] = [userMessage("look at these screens")];
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
              // Distinct payload per screenshot so each is individually
              // greppable in the final request body.
              output: JSON.stringify({
                imageData: `data:image/png;base64,SCREEN${i}AAAA`,
              }),
            },
          ],
        });
      }
      return messages;
    }

    it("trims a long screenshot history before it reaches modelMessages, even for a vision-capable model", async () => {
      const { MAX_LIVE_TOOL_RESULT_IMAGES, TOOL_RESULT_ELISION_STEP } = await import(
        "../src/ai/image-budget.js"
      );
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const total = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP + 4;
      const config = makeConfig(); // shipped default: vision-capable, native tool-result images
      const turn = await prepareChatTurn({ config, messages: screenshotHistory(total) });

      const bodyText = JSON.stringify(turn.modelMessages);
      const liveCount = Array.from({ length: total }, (_, i) => i).filter((i) =>
        bodyText.includes(`SCREEN${i}AAAA`),
      ).length;

      expect(liveCount).toBeLessThan(total);
      expect(liveCount).toBeLessThanOrEqual(
        MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP - 1,
      );
      // The oldest screenshot must be the one that got elided, not some
      // arbitrary/most-recent one.
      expect(bodyText).not.toContain("SCREEN0AAAA");
    });

    it("does not run the budget when the model can't see, since vision preprocessing already converts every image", async () => {
      // On a vision-less model applyVisionPreprocessing replaces each image
      // with a cached, byte-stable description, so there is no base64 left
      // for a budget to save. Running the budget in front of it would swap a
      // real description for a constant placeholder — and would do it by
      // rewriting the OLDEST tool message, invalidating the provider's whole
      // cached prefix for no gain. So the budget must stay out of that path.
      const { MAX_LIVE_TOOL_RESULT_IMAGES, TOOL_RESULT_ELISION_STEP } = await import(
        "../src/ai/image-budget.js"
      );
      const { prepareChatTurn } = await import("../src/ai/chatTurn.js");

      const total = MAX_LIVE_TOOL_RESULT_IMAGES + TOOL_RESULT_ELISION_STEP + 4;
      const config = makeConfig({
        CHAT_MODEL_SUPPORTS_VISION: false,
        VISION_MODEL: "",
      });
      const turn = await prepareChatTurn({ config, messages: screenshotHistory(total) });

      const bodyText = JSON.stringify(turn.modelMessages);
      // The budget's own placeholder wording must be absent — whatever
      // vision preprocessing did to these slots, the budget didn't do it.
      expect(bodyText).not.toContain("aged out of the live-image window");
    });
  });
});

const BROWSE_TOOLS = [
  "browse_open",
  "browse_snapshot",
  "browse_screenshot",
  "browse_act",
  "browse_tabs",
  "browse_find_images",
  "browse_read",
];
const DESKTOP = { desktopBrowser: true };
const GO_MODEL = "opencode-go/deepseek-v4.1-flash";

async function prepare(overrides: Record<string, unknown>) {
  const { prepareChatTurn } = await import("../src/ai/chatTurn.js");
  return prepareChatTurn({
    config: makeConfig(),
    messages: [userMessage("find the price of X")],
    ...overrides,
  });
}

describe("browse subagent", () => {
  beforeAll(async () => {
    await loadSkills();
  });
  beforeEach(() => {
    vi.mocked(createModel).mockClear();
  });

  describe("BROWSE_MODE=agent main turn", () => {
    it("keeps only browse_agent among browser tools and renders the agent guidance", async () => {
      const turn = await prepare({ config: makeConfig({ BROWSE_MODE: "agent" }), clientCapabilities: DESKTOP });
      expect(Object.keys(turn.tools).filter((name) => name.startsWith("browse_"))).toEqual(["browse_agent"]);
      expect(turn.system).toContain(AGENT_BROWSER_GUIDANCE);
      expect(turn.system).not.toContain(MANUAL_BROWSER_GUIDANCE);
    });

    it("offers nothing browser-related without a browser", async () => {
      const turn = await prepare({ config: makeConfig({ BROWSE_MODE: "agent" }) });
      expect(Object.keys(turn.tools).filter((name) => name.startsWith("browse_"))).toEqual([]);
      expect(turn.system).not.toContain("## Browser tasks");
    });
  });

  it("browse_capture follows the browser gate in manual mode and is absent in agent mode", async () => {
    const manual = await prepare({ config: makeConfig({ BROWSE_MODE: "manual" }), clientCapabilities: DESKTOP });
    expect(manual.tools.browse_capture).toBeDefined();
    const noBrowser = await prepare({ config: makeConfig({ BROWSE_MODE: "manual" }) });
    expect(noBrowser.tools.browse_capture).toBeUndefined();
    const agent = await prepare({ config: makeConfig({ BROWSE_MODE: "agent" }), clientCapabilities: DESKTOP, browseCapture: true });
    expect(agent.tools.browse_capture).toBeUndefined();
  });

  it.each(["manual", "task", "agent"] as const)("BROWSE_MODE=%s main turn never offers browse_fill_login", async (mode) => {
    const turn = await prepare({
      config: makeConfig({ BROWSE_MODE: mode, TYPESAFE_API_KEY: "key" }),
      clientCapabilities: DESKTOP,
      browseLogin: true,
    });
    expect(turn.tools.browse_fill_login).toBeUndefined();
  });

  it.each(["manual", "task"] as const)("BROWSE_MODE=%s never offers browse_agent", async (mode) => {
    const turn = await prepare({
      config: makeConfig({ BROWSE_MODE: mode, TYPESAFE_API_KEY: "key" }),
      clientCapabilities: DESKTOP,
    });
    expect(turn.tools.browse_agent).toBeUndefined();
    expect(turn.tools.browse_open).toBeDefined();
  });

  describe("agentMode browse", () => {
    it("carries exactly the seven browse tools, the dedicated prompt and no canvas context", async () => {
      const turn = await prepare({
        config: makeConfig({ BROWSE_MODE: "agent" }),
        agentMode: "browse",
        canvasContext: "SECRET-CANVAS",
        clientCapabilities: DESKTOP,
      });
      expect(Object.keys(turn.tools).sort()).toEqual([...BROWSE_TOOLS].sort());
      expect(turn.system).toBe(BROWSE_AGENT_PROMPT);
      expect(BROWSE_AGENT_PROMPT).not.toContain("confirm in chat");
      expect(BROWSE_AGENT_PROMPT).toContain("already confirmed that exact step");
      expect(AGENT_BROWSER_GUIDANCE).toContain("confirmed that exact step");
      expect(JSON.stringify(turn.modelMessages)).not.toContain("canvas_context");
      expect(JSON.stringify(turn.modelMessages)).not.toContain("SECRET-CANVAS");
    });

    it("adds browse_capture only when browseCapture is true", async () => {
      const base = { config: makeConfig({ BROWSE_MODE: "agent" }), agentMode: "browse", clientCapabilities: DESKTOP };
      const without = await prepare(base);
      expect(without.tools.browse_capture).toBeUndefined();
      const falsy = await prepare({ ...base, browseCapture: false });
      expect(falsy.tools.browse_capture).toBeUndefined();
      const withCapture = await prepare({ ...base, browseCapture: true });
      expect(withCapture.tools.browse_capture).toBeDefined();
      expect(Object.keys(withCapture.tools).sort()).toEqual([...BROWSE_TOOLS, "browse_capture"].sort());
    });

    it("adds browse_fill_login and its prompt only when browseLogin is true", async () => {
      const base = { config: makeConfig({ BROWSE_MODE: "agent" }), agentMode: "browse", clientCapabilities: DESKTOP };
      const without = await prepare(base);
      expect(without.tools.browse_fill_login).toBeUndefined();
      expect(without.system).toBe(BROWSE_AGENT_PROMPT);
      const falsy = await prepare({ ...base, browseLogin: false });
      expect(falsy.tools.browse_fill_login).toBeUndefined();
      expect(falsy.system).toBe(BROWSE_AGENT_PROMPT);
      const withLogin = await prepare({ ...base, browseLogin: true });
      expect(withLogin.tools.browse_fill_login).toBeDefined();
      expect(withLogin.system).toBe(BROWSE_AGENT_LOGIN_PROMPT);
      expect(BROWSE_AGENT_LOGIN_PROMPT).toContain("browse_fill_login");
      expect(BROWSE_AGENT_PROMPT).not.toContain("browse_fill_login");
      expect(Object.keys(withLogin.tools).sort()).toEqual([...BROWSE_TOOLS, "browse_fill_login"].sort());
    });

    it("never adds browse_fill_login without a browser", async () => {
      const turn = await prepare({ agentMode: "browse", browseLogin: true });
      expect(turn.tools.browse_fill_login).toBeUndefined();
    });

    it("ignores browseLogin when the client is not the desktop browser", async () => {
      const turn = await prepare({
        config: makeConfig({ BROWSE_MODE: "agent" }),
        agentMode: "browse",
        browseLogin: true,
        clientCapabilities: { browser: "cloud" },
      });
      expect(turn.tools.browse_fill_login).toBeUndefined();
      expect(turn.system).toBe(BROWSE_AGENT_PROMPT);
    });

    it("adds qa_verdict and the QA prompt only when browseQa is true", async () => {
      const base = { config: makeConfig({ BROWSE_MODE: "agent" }), agentMode: "browse", clientCapabilities: DESKTOP };
      const without = await prepare(base);
      expect(without.tools.qa_verdict).toBeUndefined();
      expect(without.system).toBe(BROWSE_AGENT_PROMPT);
      const falsy = await prepare({ ...base, browseQa: false });
      expect(falsy.tools.qa_verdict).toBeUndefined();
      const qa = await prepare({ ...base, browseQa: true });
      expect(qa.tools.qa_verdict).toBeDefined();
      expect((qa.tools.qa_verdict as { execute?: unknown }).execute).toBeUndefined();
      // qa_assert only with the browseAssert capability.
      expect(qa.tools.qa_assert).toBeUndefined();
      const qaAssert = await prepare({ ...base, browseQa: true, clientCapabilities: { ...DESKTOP, browseAssert: true } });
      expect(qaAssert.tools.qa_assert).toBeDefined();
      expect((qaAssert.tools.qa_assert as { execute?: unknown }).execute).toBeUndefined();
      const assertWithoutQa = await prepare({ ...base, clientCapabilities: { ...DESKTOP, browseAssert: true } });
      expect(assertWithoutQa.tools.qa_assert).toBeUndefined();
      expect(without.tools.qa_assert).toBeUndefined();
      expect(falsy.tools.qa_assert).toBeUndefined();
      expect(qa.system).toBe(browseAgentPrompt({ qa: true }));
      expect(browseAgentPrompt({ qa: true })).toContain("qa_verdict");
      expect(browseAgentPrompt({ qa: true })).toContain("QA engineer");
      expect(BROWSE_AGENT_PROMPT).not.toContain("qa_verdict");
      expect(qa.system).toContain("call `qa_verdict` exactly once");
      expect(qa.system).not.toContain("Before an irreversible step (purchase, booking, payment, sending, submitting a form with personal data, deleting), stop. Do not do the step.");
      expect(BROWSE_AGENT_PROMPT).toContain("Before an irreversible step (purchase, booking, payment, sending, submitting a form with personal data, deleting), stop. Do not do the step.");
      expect(browseAgentPrompt({ qa: true })).toBe(browseAgentPrompt({ qa: true }));
      expect(browseAgentPrompt()).toBe(BROWSE_AGENT_PROMPT);
      expect(Object.keys(qa.tools).sort()).toEqual([...BROWSE_TOOLS, "qa_verdict"].sort());
      expect(Object.keys(qaAssert.tools).sort()).toEqual([...BROWSE_TOOLS, "qa_verdict", "qa_assert"].sort());
      const qaLogin = await prepare({ ...base, browseQa: true, browseLogin: true });
      expect(qaLogin.system).toBe(browseAgentPrompt({ qa: true, login: true }));
      expect(browseAgentPrompt({ qa: true, login: true })).toContain("browse_fill_login");
      expect(Object.keys(qaLogin.tools).sort()).toEqual([...BROWSE_TOOLS, "browse_fill_login", "qa_verdict"].sort());
    });

    it("offers `checks` in browse_agent only with browseQa + browseAssert", async () => {
      const cfg = makeConfig({ BROWSE_MODE: "agent" });
      const props = async (caps: Record<string, unknown>) => {
        const turn = await prepare({ config: cfg, clientCapabilities: { ...DESKTOP, ...caps } });
        const tool = turn.tools.browse_agent as { description: string; inputSchema: unknown };
        const json = (asSchema(tool.inputSchema as Parameters<typeof asSchema>[0]).jsonSchema as { properties: Record<string, unknown> }).properties;
        return { keys: Object.keys(json), description: tool.description };
      };
      for (const caps of [{}, { browseAssert: true }]) {
        const r = await props(caps);
        expect(r.keys).not.toContain("checks");
        expect(r.description).not.toContain("qa_assert");
      }
      for (const caps of [{ browseQa: true }, { browseQa: true, browseIsolation: true }]) {
        const r = await props(caps);
        expect(r.keys).toContain("qa");
        expect(r.keys).not.toContain("checks");
        expect(r.description).not.toContain("checks");
      }
      for (const caps of [{ browseQa: true, browseAssert: true }, { browseQa: true, browseIsolation: true, browseAssert: true }]) {
        const r = await props(caps);
        expect(r.keys).toContain("checks");
        expect(r.description).toContain("qa_assert");
      }
    });

    it("browseQa without a browser gives the normal prompt and no tool", async () => {
      const turn = await prepare({ config: makeConfig({ BROWSE_MODE: "agent" }), agentMode: "browse", browseQa: true });
      expect(turn.tools.qa_verdict).toBeUndefined();
      expect(turn.system).toBe(BROWSE_AGENT_PROMPT);
    });

    it("lists the bug-hunt skill only when browse_agent with qa is offered", async () => {
      const cfg = makeConfig({ BROWSE_MODE: "agent" });
      const withQa = await prepare({ config: cfg, clientCapabilities: { ...DESKTOP, browseQa: true } });
      const withoutQa = await prepare({ config: cfg, clientCapabilities: DESKTOP });
      const noBrowser = await prepare({ config: cfg });
      expect(withQa.system).toContain("bug-hunt");
      expect(withoutQa.system).not.toContain("bug-hunt");
      expect(noBrowser.system).not.toContain("bug-hunt");
    });

    it("lists the document template skills only to a client with docTabs", async () => {
      const withDocs = await prepare({ clientCapabilities: { docTabs: true } });
      const withoutDocs = await prepare({});
      const catalog = (system: string) => system.slice(system.indexOf("## Available Skills")).split("\n").filter((l) => l.startsWith("- `"));
      for (const name of DOC_ONLY_SKILL_NAMES) {
        expect(catalog(withDocs.system).some((l) => l.startsWith(`- \`${name}\``))).toBe(true);
        expect(catalog(withoutDocs.system).some((l) => l.startsWith(`- \`${name}\``))).toBe(false);
      }
    });

    it("shows the qa flag of browse_agent and the QA bullet only to a client with the browseQa capability", async () => {
      const cfg = makeConfig({ BROWSE_MODE: "agent" });
      const old = await prepare({ config: cfg, clientCapabilities: DESKTOP });
      const modern = await prepare({ config: cfg, clientCapabilities: { ...DESKTOP, browseQa: true } });
      const schemaKeys = (t: { tools: Record<string, unknown> }) => {
        const s = (t.tools.browse_agent as { inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } } }).inputSchema;
        return s.safeParse({ goal: "g", qa: true }).data ?? {};
      };
      expect(schemaKeys(old)).not.toHaveProperty("qa");
      expect(schemaKeys(modern)).toHaveProperty("qa", true);
      expect((old.tools.browse_agent as { description: string }).description).not.toContain("qa: true");
      expect((modern.tools.browse_agent as { description: string }).description).toContain("qa: true");
      expect(old.system).not.toContain("`qa` param");
      expect(modern.system).toContain("`qa` param");
      expect(AGENT_BROWSER_GUIDANCE).not.toContain("qa: true");
    });

    describe("browseApps capability (desktop apps)", () => {
      const cfgAgent = makeConfig({ BROWSE_MODE: "agent" });
      const json = (t: unknown) => asSchema((t as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema).jsonSchema;
      const keys = (t: unknown) => Object.keys((json(t) as { properties: Record<string, unknown> }).properties);
      const parses = (t: unknown, v: unknown) =>
        (t as { inputSchema: { safeParse: (x: unknown) => { success: boolean } } }).inputSchema.safeParse(v).success;
      const desc = (t: unknown) => (t as { description: string }).description;

      it("manual mode: the browse_open app variant needs the capability AND the desktop browser", async () => {
        const off = await prepare({ clientCapabilities: DESKTOP });
        expect(keys(off.tools.browse_open)).toEqual(["url"]);
        expect(desc(off.tools.browse_open)).not.toContain("/Applications/Orca.app");
        const on = await prepare({ clientCapabilities: { ...DESKTOP, browseApps: true } });
        expect(keys(on.tools.browse_open)).toEqual(["url", "app"]);
        expect(parses(on.tools.browse_open, { app: "/Applications/Orca.app" })).toBe(true);
        expect(parses(on.tools.browse_open, { url: "https://a.com" })).toBe(true);
        expect(parses(on.tools.browse_open, {})).toBe(false);
        expect(parses(on.tools.browse_open, { url: "https://a.com", app: "/Applications/Orca.app" })).toBe(false);
        expect(desc(on.tools.browse_open)).toContain("The user must confirm the launch.");
        const cloud = await prepare({ clientCapabilities: { browser: "cloud", browseApps: true } });
        expect(cloud.tools.browse_open).toBeUndefined();
        const cloudKey = await prepare({
          config: makeConfig({ STEEL_API_KEY: "k" }),
          clientCapabilities: { browser: "cloud", browseApps: true },
        });
        expect(keys(cloudKey.tools.browse_open)).toEqual(["url"]);
        expect(desc(cloudKey.tools.browse_open)).toBe(desc(off.tools.browse_open));
      });

      it("subagent turn gets the same browse_open variant", async () => {
        const base = { config: cfgAgent, agentMode: "browse" };
        const off = await prepare({ ...base, clientCapabilities: DESKTOP });
        const on = await prepare({ ...base, clientCapabilities: { ...DESKTOP, browseApps: true } });
        expect(keys(off.tools.browse_open)).toEqual(["url"]);
        expect(keys(on.tools.browse_open)).toEqual(["url", "app"]);
      });

      it("browse_agent gets `app` only with the capability on a desktop client", async () => {
        const off = await prepare({ config: cfgAgent, clientCapabilities: { ...DESKTOP, browseQa: true } });
        expect(keys(off.tools.browse_agent)).not.toContain("app");
        expect(desc(off.tools.browse_agent)).not.toContain("macOS .app");
        for (const caps of [{}, { browseQa: true }, { browseQa: true, browseIsolation: true, browseAssert: true }]) {
          const on = await prepare({ config: cfgAgent, clientCapabilities: { ...DESKTOP, ...caps, browseApps: true } });
          expect(keys(on.tools.browse_agent)).toContain("app");
          expect(parses(on.tools.browse_agent, { goal: "g", app: "/Applications/Orca.app" })).toBe(true);
          expect(parses(on.tools.browse_agent, { goal: "g", app: "/Applications/Orca.app", url: "https://a.com" })).toBe(false);
          expect(parses(on.tools.browse_agent, { goal: "g", app: "/Applications/Orca.app", resume: "x" })).toBe(false);
          expect(parses(on.tools.browse_agent, { goal: "g", app: "/Applications/Orca.app", capture: true })).toBe(false);
          expect(parses(on.tools.browse_agent, { goal: "g", url: "https://a.com", app: "" })).toBe(true);
          expect(parses(on.tools.browse_agent, { goal: "g", app: "/Applications/Orca.app", url: "" })).toBe(true);
          expect(parses(on.tools.browse_agent, { goal: "g", app: "/Applications/Orca.app", url: null, setup: null, resume: "  " })).toBe(true);
          expect(parses(on.tools.browse_agent, { goal: "g", app: "/Applications/Orca.app", url: "https://a.com" })).toBe(false);
          expect(desc(on.tools.browse_agent)).toContain("not call browse_agent with `app` in parallel");
          expect(desc(on.tools.browse_agent)).toContain("macOS .app");
        }
        const cloud = await prepare({
          config: makeConfig({ BROWSE_MODE: "agent", STEEL_API_KEY: "k" }),
          clientCapabilities: { browser: "cloud", browseApps: true },
        });
        expect(keys(cloud.tools.browse_agent)).not.toContain("app");
      });
    });

    describe("browseNativeApps capability (native macOS apps)", () => {
      const cfgAgent = makeConfig({ BROWSE_MODE: "agent" });
      const desc = (t: unknown) => (t as { description: string }).description;
      const NATIVE_MARK = "accessibility tree";
      const NATIVE_PHRASES = [
        "as shown in the Dock or in its window title",
        "\"Qure Dev\"",
        "controlled without a restart",
        "any macOS app",
        "window screenshots",
        "The user confirms each attach in a dialog.",
        "accessibility role",
        "`browse_tabs` lists the windows",
        "Back, forward, reload, upload and viewport do not work there.",
        "`browse_find_images` and `browse_capture` are not available there.",
        "QA checks work only in part there: a `text` check, and an `element` or `value` check with an `index` from `browse_snapshot`.",
        "permission error",
        "Do not retry.",
        "bring the app to the front and move the pointer",
        "An Electron app that is not running starts with a new profile",
        "You cannot see native menus or file dialogs.",
        "the user must confirm the launch",
        "is not an Electron app cannot be started",
      ];

      it("manual mode: native text needs desktop AND browseApps AND browseNativeApps", async () => {
        const plain = await prepare({ clientCapabilities: { ...DESKTOP, browseApps: true } });
        expect(desc(plain.tools.browse_open)).not.toContain(NATIVE_MARK);
        const on = await prepare({ clientCapabilities: { ...DESKTOP, browseApps: true, browseNativeApps: true } });
        for (const p of NATIVE_PHRASES) expect(desc(on.tools.browse_open)).toContain(p);
        expect(desc(on.tools.browse_open)).toContain("In an Electron app that Sideform launched, do not use an `about:blank` or `data:` window");
        expect(desc(on.tools.browse_open)).not.toContain("the user is asked to restart it");
        // Ignored without browseApps.
        const noApps = await prepare({ clientCapabilities: { ...DESKTOP, browseNativeApps: true } });
        const off = await prepare({ clientCapabilities: DESKTOP });
        expect(desc(noApps.tools.browse_open)).toBe(desc(off.tools.browse_open));
        // Ignored on the cloud browser.
        const cloud = await prepare({
          config: makeConfig({ STEEL_API_KEY: "k" }),
          clientCapabilities: { browser: "cloud", browseApps: true, browseNativeApps: true },
        });
        expect(desc(cloud.tools.browse_open)).toBe(desc(off.tools.browse_open));
        // No flag: byte-identical to the plain app variant.
        const explicitOff = await prepare({ clientCapabilities: { ...DESKTOP, browseApps: true, browseNativeApps: false } });
        expect(desc(explicitOff.tools.browse_open)).toBe(desc(plain.tools.browse_open));
      });

      it("flag-off app texts, descriptions and schemas are byte-identical to the pre-native output", async () => {
        const g = flagOffGolden;
        expect(PEN_EDITOR_BROWSE_APP_SLOTS.openApp).toBe(g.texts.openApp);
        expect(PEN_EDITOR_BROWSE_AGENT_APP_FIELD).toBe(g.texts.field);
        expect(PEN_EDITOR_BROWSE_AGENT_APP_RULES).toBe(g.texts.rules);
        const json = (t: unknown) => JSON.stringify(asSchema((t as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema).jsonSchema);
        const keys = [[false, false, false], [true, false, false], [true, true, false], [true, true, true], [true, false, true]] as const;
        for (const [qa, isolated, assert] of keys) {
          const t = browseAgentToolWithApp({ qa, isolated, assert });
          const want = g.tools[`${qa}${isolated}${assert}` as keyof typeof g.tools] as { d: string; s: string };
          expect(desc(t)).toBe(want.d);
          expect(json(t)).toBe(want.s);
        }
        expect(desc(browseOpenToolApp)).toBe(g.tools.open.d);
        expect(json(browseOpenToolApp)).toBe(g.tools.open.s);
      });

      it("browseApps-only and cloud+browseNativeApps send the same browse_agent bytes as flag-off", async () => {
        const base = { config: cfgAgent };
        const bytes = (t: { tools: Record<string, unknown> }) => {
          const a = t.tools.browse_agent as { inputSchema: Parameters<typeof asSchema>[0] };
          return JSON.stringify([desc(a), asSchema(a.inputSchema).jsonSchema]);
        };
        const appsOnly = await prepare({ ...base, clientCapabilities: { ...DESKTOP, browseApps: true } });
        const appsExplicitOff = await prepare({ ...base, clientCapabilities: { ...DESKTOP, browseApps: true, browseNativeApps: false } });
        expect(bytes(appsOnly)).toBe(bytes(appsExplicitOff));
        const plain = await prepare({ ...base, clientCapabilities: DESKTOP });
        const cloudOn = await prepare({
          config: makeConfig({ BROWSE_MODE: "agent", STEEL_API_KEY: "k" }),
          clientCapabilities: { browser: "cloud", browseApps: true, browseNativeApps: true },
        });
        const cloudOff = await prepare({
          config: makeConfig({ BROWSE_MODE: "agent", STEEL_API_KEY: "k" }),
          clientCapabilities: { browser: "cloud", browseApps: true },
        });
        expect(bytes(cloudOn)).toBe(bytes(cloudOff));
        expect(bytes(plain)).not.toBe(bytes(appsOnly));
      });

      it("native browse_open schema describes `app` as a name or a path", () => {
        const schema = asSchema(browseOpenToolAppNative.inputSchema).jsonSchema as {
          properties: Record<string, { description?: string }>;
        };
        expect(schema.properties.app.description).toContain("Dock");
        expect(schema.properties.app.description).not.toContain("Electron");
        const plain = asSchema(browseOpenToolApp.inputSchema).jsonSchema as { properties: Record<string, { description?: string }> };
        expect(plain.properties.app.description).toContain("Electron");
      });

      it("subagent turn gets the native browse_open text", async () => {
        const on = await prepare({
          config: cfgAgent,
          agentMode: "browse",
          clientCapabilities: { ...DESKTOP, browseApps: true, browseNativeApps: true },
        });
        for (const p of NATIVE_PHRASES) expect(desc(on.tools.browse_open)).toContain(p);
      });

      describe("browse_act coordinates (x, y, button, clicks)", () => {
        const COORD = ["x", "y", "button", "clicks"];
        const actSchema = (t: { tools: Record<string, unknown> }) =>
          asSchema((t.tools.browse_act as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema).jsonSchema as {
            properties: Record<string, unknown>;
          };
        const actBytes = (t: { tools: Record<string, unknown> }) => JSON.stringify([desc(t.tools.browse_act), actSchema(t)]);
        const defaultAct = JSON.stringify([desc(penTools.browse_act), asSchema(penTools.browse_act.inputSchema).jsonSchema]);

        it("subagent turn with browseNativeApps has the coordinate fields", async () => {
          const on = await prepare({
            config: cfgAgent,
            agentMode: "browse",
            clientCapabilities: { ...DESKTOP, browseApps: true, browseNativeApps: true },
          });
          const props = Object.keys(actSchema(on).properties);
          for (const k of COORD) expect(props).toContain(k);
          expect(desc(on.tools.browse_act)).toContain("`x` and `y`");
        });

        it("manual main turn with browseNativeApps has the coordinate fields", async () => {
          const on = await prepare({ clientCapabilities: { ...DESKTOP, browseApps: true, browseNativeApps: true } });
          const props = Object.keys(actSchema(on).properties);
          for (const k of COORD) expect(props).toContain(k);
        });

        it("without browseNativeApps browse_act equals the default", async () => {
          const cases = [
            { clientCapabilities: DESKTOP },
            { clientCapabilities: { ...DESKTOP, browseApps: true } },
            { clientCapabilities: { ...DESKTOP, browseApps: true, browseNativeApps: false } },
            { clientCapabilities: { ...DESKTOP, browseNativeApps: true } },
            { config: makeConfig({ STEEL_API_KEY: "k" }), clientCapabilities: { browser: "cloud" as const, browseApps: true, browseNativeApps: true } },
          ];
          for (const c of cases) {
            const t = await prepare(c);
            for (const k of COORD) expect(Object.keys(actSchema(t).properties)).not.toContain(k);
            expect(actBytes(t)).toBe(defaultAct);
          }
          const sub = await prepare({ config: cfgAgent, agentMode: "browse", clientCapabilities: { ...DESKTOP, browseApps: true } });
          expect(actBytes(sub)).toBe(defaultAct);
        });
      });

      it("browse_agent: native `app` field and guidance, gated, deterministic", async () => {
        const base = { config: cfgAgent };
        const plain = await prepare({ ...base, clientCapabilities: { ...DESKTOP, browseApps: true } });
        expect(desc(plain.tools.browse_agent)).not.toContain(NATIVE_MARK);
        const caps = { ...DESKTOP, browseApps: true, browseNativeApps: true };
        const on = await prepare({ ...base, clientCapabilities: caps });
        const on2 = await prepare({ ...base, clientCapabilities: caps });
        expect(desc(on.tools.browse_agent)).toBe(desc(on2.tools.browse_agent));
        expect(desc(on.tools.browse_agent)).toContain("the name of the app as shown in the Dock or in its window title");
        const schema = asSchema((on.tools.browse_agent as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema).jsonSchema as {
          properties: Record<string, { description?: string }>;
        };
        for (const p of NATIVE_PHRASES) expect(schema.properties.app.description).toContain(p);
        for (const withQa of [{}, { browseQa: true, browseIsolation: true, browseAssert: true }]) {
          const t = await prepare({ ...base, clientCapabilities: { ...caps, ...withQa } });
          expect(desc(t.tools.browse_agent)).toContain("Dock");
        }
        const noApps = await prepare({ ...base, clientCapabilities: { ...DESKTOP, browseNativeApps: true } });
        const off = await prepare({ ...base, clientCapabilities: DESKTOP });
        expect(desc(noApps.tools.browse_agent)).toBe(desc(off.tools.browse_agent));
        const cloud = await prepare({
          config: makeConfig({ BROWSE_MODE: "agent", STEEL_API_KEY: "k" }),
          clientCapabilities: { browser: "cloud", browseApps: true, browseNativeApps: true },
        });
        expect(desc(cloud.tools.browse_agent)).not.toContain(NATIVE_MARK);
      });
    });

    it("shows the parallel/isolated sentence only with browseQa + browseIsolation", async () => {
      const cfg = makeConfig({ BROWSE_MODE: "agent" });
      const desc = (t: { tools: Record<string, unknown> }) => (t.tools.browse_agent as { description: string }).description;
      // zod 3: the refined schema is a ZodEffects wrapping the ZodObject.
      const qaFieldDesc = (t: { tools: Record<string, unknown> }) => {
        const schema = (t.tools.browse_agent as { inputSchema: Record<string, any> }).inputSchema; // eslint-disable-line @typescript-eslint/no-explicit-any
        let inner = schema;
        while (inner && !inner.shape && inner._def?.schema) inner = inner._def.schema;
        const shape = inner?.shape;
        return (shape?.qa?.description as string | undefined) ?? "";
      };
      const noQa = await prepare({ config: cfg, clientCapabilities: { ...DESKTOP, browseIsolation: true } });
      const qaOnly = await prepare({ config: cfg, clientCapabilities: { ...DESKTOP, browseQa: true } });
      const both = await prepare({ config: cfg, clientCapabilities: { ...DESKTOP, browseQa: true, browseIsolation: true } });
      const marker = "isolated browser";
      // 1. no browseQa: no QA text, isolation alone changes nothing.
      expect(noQa.system).not.toContain("`qa` param");
      expect(noQa.system).not.toContain(marker);
      expect(desc(noQa)).not.toContain("qa: true");
      // 2. browseQa only: previous QA text, no parallel sentence.
      expect(qaOnly.system).toContain("`qa` param");
      expect(qaOnly.system).not.toContain(marker);
      expect(qaOnly.system).not.toContain("SAME step");
      // 3. both: QA text plus the parallel/isolated sentence, in guidance and in the qa field.
      expect(both.system).toContain("`qa` param");
      expect(both.system).toContain("SAME step");
      expect(both.system).toContain(marker);
      // Cache stability: the two prompts differ ONLY in the browser guidance block.
      const strip = (sys: string, g: string) => sys.replace(`\n## Browser tasks\n\n${g}`, "");
      expect(strip(both.system, AGENT_BROWSER_QA_ISOLATED_GUIDANCE)).toBe(strip(qaOnly.system, AGENT_BROWSER_QA_GUIDANCE));
      expect(both.system).not.toBe(qaOnly.system);
      // Cloud browser is never isolated, even if the client claims it.
      const cloud = await prepare({
        config: makeConfig({ BROWSE_MODE: "agent", STEEL_API_KEY: "k" }),
        clientCapabilities: { browser: "cloud", browseQa: true, browseIsolation: true },
      });
      expect(cloud.system).toContain("`qa` param");
      expect(cloud.system).not.toContain("SAME step");
      expect(qaFieldDesc(noQa)).toBe("");
      expect(qaFieldDesc(qaOnly)).toContain("call browse_agent several times.");
      expect(qaFieldDesc(qaOnly)).not.toContain("SAME step");
      expect(qaFieldDesc(both)).toContain("SAME step");
      expect(qaFieldDesc(both)).toContain(marker);
      expect(qaOnly.tools.browse_agent).not.toBe(both.tools.browse_agent);
    });

    it("never offers qa_verdict outside a browse subagent turn", async () => {
      const cfg = makeConfig({ BROWSE_MODE: "agent" });
      for (const agentMode of ["edits", "prototype", "research"]) {
        const turn = await prepare({ config: cfg, agentMode, browseQa: true, clientCapabilities: DESKTOP });
        expect(turn.tools.qa_verdict, agentMode).toBeUndefined();
        expect(turn.tools.qa_assert, agentMode).toBeUndefined();
      }
      const main = await prepare({ config: cfg, clientCapabilities: DESKTOP, browseQa: true });
      expect(main.tools.qa_verdict).toBeUndefined();
      expect(main.tools.qa_assert).toBeUndefined();
      expect(main.tools.browse_agent).toBeDefined();
      const noBrowser = await prepare({ agentMode: "browse", browseQa: true });
      expect(noBrowser.tools.qa_verdict).toBeUndefined();
      expect(noBrowser.tools.qa_assert).toBeUndefined();
    });

    it("never adds browse_capture without a browser", async () => {
      const turn = await prepare({ agentMode: "browse", browseCapture: true });
      expect(turn.tools.browse_capture).toBeUndefined();
    });

    it("does not run slash-command skill detection", async () => {
      const turn = await prepare({
        agentMode: "browse",
        messages: [userMessage("/prototype a login screen")],
        clientCapabilities: DESKTOP,
      });
      expect(turn.slashSkillName).toBeUndefined();
      expect(turn.taskPolicy).toBe("native");
      expect(turn.tools.batch_design).toBeUndefined();
    });

    it("has no tools without a browser", async () => {
      const turn = await prepare({ agentMode: "browse" });
      expect(Object.keys(turn.tools)).toEqual([]);
    });

    it("runs on BROWSE_AGENT_MODEL, not the user's chat model, with reasoning off", async () => {
      const turn = await prepare({
        agentMode: "browse",
        modelOverride: "anthropic/claude-haiku-5.5",
        clientCapabilities: DESKTOP,
      });
      expect(turn.selectedModelId).toBe("deepseek/deepseek-v4.1-flash");
      expect(createModel).toHaveBeenCalledWith(
        expect.anything(),
        "deepseek/deepseek-v4.1-flash",
        expect.objectContaining({ reasoningEffort: "none" }),
      );
    });

    it("ignores the OpenCode Go model even with the user's key", async () => {
      const turn = await prepare({
        agentMode: "browse",
        modelOverride: GO_MODEL,
        opencodeApiKey: "user-key",
        clientCapabilities: DESKTOP,
      });
      expect(turn.selectedModelId).toBe("deepseek/deepseek-v4.1-flash");
      expect(createModel).toHaveBeenCalledWith(
        expect.anything(),
        "deepseek/deepseek-v4.1-flash",
        expect.objectContaining({ reasoningEffort: "none" }),
      );
    });

    it("leaves the main model alone for every other agentMode", async () => {
      const edits = await prepare({ agentMode: "edits", modelOverride: "anthropic/claude-haiku-5.5" });
      expect(edits.selectedModelId).toBe("anthropic/claude-haiku-5.5");
      expect(edits.system).not.toBe(BROWSE_AGENT_PROMPT);
    });
  });
});

describe("browse step watchdog seam", () => {
  it("wraps the nested browse model and not the main chat model", async () => {
    const { hasStepWatchdog } = await import("../src/ai/stepWatchdog.js");
    const browse = await prepare({
      config: makeConfig({ BROWSE_MODE: "agent" }),
      agentMode: "browse",
      clientCapabilities: DESKTOP,
    });
    expect(hasStepWatchdog(browse.model)).toBe(true);
    const main = await prepare({ config: makeConfig({ BROWSE_MODE: "agent" }) });
    expect(hasStepWatchdog(main.model)).toBe(false);
    const off = await prepare({
      config: makeConfig({ BROWSE_MODE: "agent", BROWSE_STEP_FIRST_CHUNK_MS: 0, BROWSE_STEP_IDLE_MS: 0 }),
      agentMode: "browse",
      clientCapabilities: DESKTOP,
    });
    expect(hasStepWatchdog(off.model)).toBe(false);
  });
});
