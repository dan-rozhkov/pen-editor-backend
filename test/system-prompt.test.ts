import { describe, it, expect } from "vitest";
import { AGENT_MODES, buildSystemPrompt } from "../src/ai/system-prompt.js";

describe("AGENT_MODES", () => {
  it("remains exported for legacy request-body validation", () => {
    expect(AGENT_MODES).toEqual(["edits", "prototype", "research"]);
  });
});

describe("buildSystemPrompt", () => {
  it("always returns the core prompt (no mode branching)", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("expert design agent for the Pencil editor");
    // Mode-specific prompt blocks no longer live in the system prompt.
    expect(prompt).not.toContain("## Agent Mode: prototype");
    expect(prompt).not.toContain("You are in PROTOTYPE mode");
  });

  it("carries the edits-flow rules that used to live in EDITS_MODE_PROMPT", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("get_variables");
    // Default behaviour still forbids inserting embeds unless a skill directs it.
    expect(prompt.toLowerCase()).toContain("embed");
  });

  it("renders a skill catalog when skills are provided", () => {
    const prompt = buildSystemPrompt([
      { name: "prototype", description: "Build a mockup." },
      { name: "polish", description: "Final visual pass." },
    ]);
    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("load_skill");
    expect(prompt).toContain("prototype");
    expect(prompt).toContain("Build a mockup.");
    expect(prompt).toContain("polish");
  });

  it("includes the prototype routing rule", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('type: "embed"');
    expect(prompt.toLowerCase()).toContain("create");
  });

  it("renders a strong create-new routing gate ahead of the mandatory flow", () => {
    // Regression: weaker models (glm/deepseek) skipped `load_skill(prototype)`
    // on create-new requests and fell into the native-node "Mandatory flow"
    // because the routing rule was softer than that flow. The catalog must now
    // gate the mandatory flow on the skill-routing decision and explicitly cover
    // the empty-canvas case.
    const prompt = buildSystemPrompt([
      { name: "prototype", description: "Build a mockup." },
    ]);
    // The routing decision is framed as the FIRST action, before other tools.
    expect(prompt).toContain("FIRST DECISION");
    // Empty canvas is called out as a reason to load — not to skip.
    expect(prompt.toLowerCase()).toContain("even when the canvas is empty");
    // The mandatory flow is explicitly scoped to editing existing nodes and
    // defers to skill routing.
    expect(prompt).toContain("Mandatory flow (for editing existing native nodes)");
  });

  it("routes presentation/slide-deck create requests to the slides skill", () => {
    const prompt = buildSystemPrompt([
      { name: "prototype", description: "Build a mockup." },
      { name: "slides", description: "Build a presentation deck." },
    ]);
    expect(prompt).toContain("`slides` skill");
    expect(prompt.toLowerCase()).toContain("slide deck");
  });

  it("includes fit-to-canvas guidance for embed htmlContent authoring", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("overflow: hidden");
    expect(prompt).toContain("box-sizing: border-box");
  });

  it("omits the catalog section when no skills are provided", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("Available Skills");
  });

  it("marks learned skills in the catalog and leaves curated ones unmarked", () => {
    const prompt = buildSystemPrompt([
      { name: "prototype", description: "Build a clickable prototype" },
      { name: "reading-canvas-state", description: "Read the canvas before editing", learned: true },
    ]);
    expect(prompt).toContain("- `prototype` — Build a clickable prototype");
    expect(prompt).toContain(
      "- `reading-canvas-state` — Read the canvas before editing (learned)",
    );
  });

  it("explains what (learned) means when at least one learned skill is present", () => {
    const prompt = buildSystemPrompt([
      { name: "reading-canvas-state", description: "Read the canvas first", learned: true },
    ]);
    expect(prompt).toContain("(learned)");
    expect(prompt).toContain("you wrote yourself");
  });

  it("omits the (learned) legend when every skill is curated", () => {
    const prompt = buildSystemPrompt([
      { name: "prototype", description: "Build a clickable prototype" },
    ]);
    expect(prompt).not.toContain("(learned)");
  });

  it("is byte-identical with SELF_SKILLS_ENABLED off / an empty learned catalog — this prompt sits at the front of the provider's cached prefix, so a curated-only catalog must render EXACTLY as it did before Phase 2", () => {
    const before = buildSystemPrompt([
      { name: "prototype", description: "Build a mockup." },
      { name: "polish", description: "Final visual pass." },
    ]);
    // Same skills, but each explicitly carries `learned: false` — the shape
    // a caller gets when it always sets the field rather than omitting it.
    const after = buildSystemPrompt([
      { name: "prototype", description: "Build a mockup.", learned: false },
      { name: "polish", description: "Final visual pass.", learned: false },
    ]);
    expect(after).toBe(before);
  });

  it("renders a stable, data-free canvas-context pointer when the turn delivers one — never the canvas data itself", () => {
    // Regression: the canvas context used to be rendered directly into
    // `system` (`## Current Canvas Context\n\n${canvasContext}`), which broke
    // prompt caching because canvasContext changes on every request. The
    // actual data now travels as a trailing message in modelMessages (see
    // chatTurn.ts); `system` may only ever carry a constant pointer to it.
    const prompt = buildSystemPrompt([], { canvasContextDelivered: true });
    expect(prompt).toContain("## Current Canvas Context");
    expect(prompt).toContain("<canvas_context>");
    expect(prompt).toContain("not here");
  });

  it("omits the canvas-context pointer entirely when no context is delivered this turn", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("## Current Canvas Context");
  });

  it("never varies with per-request canvas data — the pointer block is byte-identical regardless of what canvasContext string existed", () => {
    const a = buildSystemPrompt([], { canvasContextDelivered: true });
    const b = buildSystemPrompt([], { canvasContextDelivered: true });
    expect(a).toBe(b);
  });
});

describe("editing an existing embed", () => {
  it("routes partial screen edits to edit_embed_html, not batch_design", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("edit_embed_html");
    expect(prompt).toContain("read_embed_html");
    expect(prompt).toContain("Editing an existing embed");
  });
});

describe("tool failure honesty", () => {
  it("tells the agent never to report success over a failed tool call", () => {
    // Regression: the agent described a vector logo as created despite a
    // tool error, and only backed down when the user pushed back.
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("A tool result carrying an error means the work did NOT happen");
    expect(prompt.toLowerCase()).toContain("never describe it to the user as done");
  });
});

describe("embed fit-to-canvas: no inner scrolling", () => {
  it("bans overflow scrolling on inner containers, not just the root", () => {
    // Regression: the agent kept fixing scrollbar/offset bugs with
    // `overflow: hidden` on the root while leaving `overflow-y: auto` on an
    // inner `.content` container, which still rendered a scrollbar and a
    // right-side offset.
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("no inner container may scroll either");
    expect(prompt).toContain("overflow-y: auto");
  });
});
