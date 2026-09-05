import { describe, expect, it, beforeAll } from "vitest";
import {
  detectSkillCommand,
  getAllSkills,
  getSkill,
  getSkillTools,
  loadSkills,
} from "../src/ai/skills.js";
import { SHOWCASE_VIEWPORTS } from "../src/showcase/platform.js";

describe("detectSkillCommand", () => {
  it("detects a valid skill command and extracts the user text", () => {
    const result = detectSkillCommand("/polish make the header tighter");
    expect(result).toEqual({
      skillName: "polish",
      userText: "make the header tighter",
    });
  });

  it("detects a command with no trailing text (empty userText)", () => {
    const result = detectSkillCommand("/audit");
    expect(result).toEqual({ skillName: "audit", userText: "" });
  });

  it("supports dashes and digits in skill names", () => {
    const result = detectSkillCommand("/teach-impeccable do it");
    expect(result).toEqual({
      skillName: "teach-impeccable",
      userText: "do it",
    });
  });

  it("still matches unknown command names (resolution happens later via getSkill)", () => {
    const result = detectSkillCommand("/no-such-skill hello");
    expect(result).toEqual({ skillName: "no-such-skill", userText: "hello" });
    expect(getSkill("no-such-skill")).toBeUndefined();
  });

  it("returns null for plain text without a slash", () => {
    expect(detectSkillCommand("make it pop")).toBeNull();
  });

  it("returns null for a slash followed by non-latin text (e.g. '/привет')", () => {
    expect(detectSkillCommand("/привет")).toBeNull();
  });

  it("returns null for a slash in the middle of the text", () => {
    expect(detectSkillCommand("see src/skills for details")).toBeNull();
  });

  it("returns null for a bare slash or a path-like string", () => {
    expect(detectSkillCommand("/")).toBeNull();
    expect(detectSkillCommand("/123abc")).toBeNull();
  });

  it("preserves multi-line user text after the command", () => {
    const result = detectSkillCommand("/polish line one\nline two");
    expect(result?.skillName).toBe("polish");
    expect(result?.userText).toBe("line one\nline two");
  });
});

describe("loadSkills / getSkill", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("loads the real skills from src/skills", () => {
    const skills = getAllSkills();
    expect(skills.length).toBeGreaterThan(0);
    const names = skills.map((s) => s.name);
    expect(names).toContain("polish");
  });

  it("parses frontmatter name/description/args", () => {
    const polish = getSkill("polish");
    expect(polish).toBeDefined();
    expect(polish!.name).toBe("polish");
    expect(polish!.description).toMatch(/quality pass/i);
    expect(polish!.args).toEqual([
      {
        name: "target",
        description: "The feature or area to polish (optional)",
        required: false,
      },
    ]);
  });

  it("strips frontmatter from content and keeps the body", () => {
    const polish = getSkill("polish")!;
    expect(polish.content).not.toContain("user-invokable");
    expect(polish.content).not.toContain("description:");
    expect(polish.content).toContain("final pass");
  });

  it("replaces {{ask_instruction}} placeholders in content", () => {
    for (const skill of getAllSkills()) {
      expect(skill.content).not.toContain("{{ask_instruction}}");
    }
  });

  it("returns undefined for unknown skills", () => {
    expect(getSkill("definitely-not-a-skill")).toBeUndefined();
  });

  it("loads the prototype and research mode skills", async () => {
    await loadSkills();
    const proto = getSkill("prototype");
    expect(proto).toBeDefined();
    expect(proto!.description.length).toBeGreaterThan(0);
    // A distinctive snippet from the prototype mode content.
    expect(proto!.content).toContain("PROTOTYPE mode");

    const research = getSkill("research");
    expect(research).toBeDefined();
    expect(research!.content).toContain("design research agent");
  });

  it("loads the slides skill with its frontmatter", async () => {
    await loadSkills();
    const slides = getSkill("slides");
    expect(slides).toBeDefined();
    expect(slides!.name).toBe("slides");
    expect(slides!.description.length).toBeGreaterThan(0);
    expect(slides!.description.toLowerCase()).toContain("deck");
  });

  it("loads the plugin skill with its frontmatter and args", async () => {
    await loadSkills();
    const plugin = getSkill("plugin");
    expect(plugin).toBeDefined();
    expect(plugin!.name).toBe("plugin");
    expect(plugin!.description.length).toBeGreaterThan(0);
    expect(plugin!.description.toLowerCase()).toContain("plugin");
    expect(plugin!.args).toEqual([
      {
        name: "request",
        description:
          "What the plugin should do (optional — the user's message usually already says this)",
        required: false,
      },
    ]);
  });

  it("documents the pen.* API and rules in the plugin skill", () => {
    const plugin = getSkill("plugin")!;
    // The pen.* surface documented accurately from the real implementation.
    expect(plugin.content).toContain("pen.tools.run");
    expect(plugin.content).toContain("pen.scene.batch");
    expect(plugin.content).toContain("pen.scene.get");
    expect(plugin.content).toContain("pen.selection.get");
    expect(plugin.content).toContain("pen.selection.set");
    expect(plugin.content).toContain("pen.viewport.zoomTo");
    expect(plugin.content).toContain("pen.notify");
    expect(plugin.content).toContain("pen.storage.get");
    expect(plugin.content).toContain("pen.storage.set");
    expect(plugin.content).toContain('pen.on("selectionchange"');
    expect(plugin.content).toContain("pen.close()");
    // Allowlist and cap called out.
    expect(plugin.content).toContain("rename_layers");
    expect(plugin.content).toContain("25 operations");
    // Code-size limit.
    expect(plugin.content).toContain("100 KB");
    // Iteration convention.
    expect(plugin.content).toContain("list_plugins");
    expect(plugin.content).toContain("update_plugin");
    // At least one headless and one UI example.
    expect(plugin.content.toLowerCase()).toContain("headless");
    expect(plugin.content).toContain("ui: { width: 200, height: 120 }");
  });

  it("pins the deck-specific structural rules in the slides skill", () => {
    const slides = getSkill("slides")!;
    // One embed per slide, not one embed for the whole deck.
    expect(slides.content).toContain("One embed per slide");
    // Fixed 4:3 slide size.
    expect(slides.content).toContain("1024");
    expect(slides.content).toContain("768");
    // Horizontal filmstrip layout formula.
    expect(slides.content.toLowerCase()).toContain("filmstrip");
    // Shared theme/master enforced across slides.
    expect(slides.content).toContain(":root{}");
    // Deck photography is generated too, with picsum as the stated fallback.
    expect(slides.content).toContain("generate_image");
    expect(slides.content).toContain("picsum.photos");
  });

  it("pins the design-default prompt rules in the prototype skill", () => {
    const proto = getSkill("prototype")!;
    // Icons: Phosphor is the default icon system; emoji-as-icons banned.
    expect(proto.content).toContain("Phosphor");
    // Fonts/icons load via @import — <link> is stripped on the canvas.
    expect(proto.content).toContain("@import");
    expect(proto.content).not.toContain('rel="stylesheet"');
    // Typography: single-family default, no multi-family primary stacks table.
    expect(proto.content).toContain("ONE font family per design");
    expect(proto.content).not.toContain("Recommended font stacks");
    // Images: external-image stand-in fear addressed; gradient-as-photo banned.
    expect(proto.content).toContain("DO render inside embeds");
    // Meaningful photography is generated, not pulled from stock — with a
    // budget, a micro-imagery carve-out, and an explicit stock fallback for
    // the turns where generation isn't available.
    expect(proto.content).toContain("generate_image");
    expect(proto.content).toMatch(/stock is the fallback, not the default/i);
    expect(proto.content).toMatch(/Micro imagery stays on stock/i);
    expect(proto.content).toMatch(/\*\*Fallback, in this order:\*\*/);
    // Reference research must happen before generation so generated imagery
    // inherits a real visual direction instead of becoming an isolated first step.
    const referenceStep = proto.content.indexOf(
      "Search for visual references BEFORE generating anything",
    );
    const generationStep = proto.content.indexOf(
      "Generate the imagery AFTER reference research",
    );
    expect(referenceStep).toBeGreaterThan(-1);
    expect(generationStep).toBeGreaterThan(referenceStep);
    expect(proto.content).toContain("Load the `research` skill");
    // Device chrome: no unrequested status bar / device frame.
    expect(proto.content).toContain("NO device/OS chrome");
  });

  it("searches for slide references before generating deck imagery", () => {
    const slides = getSkill("slides")!;
    const referenceStep = slides.content.indexOf(
      "Search for visual references before generating images",
    );
    const imageRule = slides.content.indexOf(
      "After the reference-search step",
    );
    expect(referenceStep).toBeGreaterThan(-1);
    expect(imageRule).toBeGreaterThan(referenceStep);
  });

  it("searches real references before new-work can render a direction", () => {
    const newWork = getSkill("new-work")!;
    const referenceStep = newWork.content.indexOf(
      "Search real references before proposing or rendering a direction",
    );
    const visualizeStep = newWork.content.indexOf(
      "When image generation is available",
    );
    expect(referenceStep).toBeGreaterThan(-1);
    expect(visualizeStep).toBeGreaterThan(referenceStep);
    expect(newWork.content).toContain(
      "Do not call image generation — including `/visualize` — until this search is complete",
    );
  });

  it("keeps the prototype skill's mobile preset equal to the showcase viewport", () => {
    // These drifted once (skill 375x812 vs viewport 390x844) and the cost was
    // invisible: the agent authored screens in one box, Playwright shot them
    // in another, and publish_to_showcase — which demands the viewport size
    // exactly — rejected the result. Assert against SHOWCASE_VIEWPORTS rather
    // than a literal so the two can only be changed together.
    const proto = getSkill("prototype")!;
    const { width, height } = SHOWCASE_VIEWPORTS.mobile;
    expect(proto.content).toContain(`width: ${width}, height: ${height}`);
    expect(proto.content).not.toMatch(/width: 375, height: 812/);
  });

  it("pins the multi-screen and slides-handoff rules in the prototype skill", () => {
    const proto = getSkill("prototype")!;
    // Multi-screen requests get one embed per screen, not one merged embed.
    expect(proto.content).toContain("ONE embed per screen");
    // Presentation/deck requests are handed off to the slides skill.
    expect(proto.content).toContain("`slides` skill");
  });

  it("pins the fit-to-canvas rules in the prototype skill", () => {
    const proto = getSkill("prototype")!;
    expect(proto.content).toContain("Fit to canvas");
    expect(proto.content).toContain("overflow: hidden");
    expect(proto.content).toContain("box-sizing: border-box");
    // Checklist item to catch overflow before emitting HTML.
    expect(proto.content).toContain("FIT-TO-CANVAS CHECK");
  });

  it("pins the fit-to-canvas rules in the slides skill", () => {
    const slides = getSkill("slides")!;
    expect(slides.content).toContain("Fit to canvas");
    expect(slides.content).toContain("overflow: hidden");
    expect(slides.content).toContain("box-sizing: border-box");
    expect(slides.content).toContain("FIT-TO-CANVAS CHECK");
  });

  it("bans inner scrolling containers, not just the root, in the prototype skill", () => {
    // Regression: three consecutive corrections about the same defect — the
    // agent's fix each time was `overflow: hidden` on the root while an
    // inner `.content` container kept `overflow-y: auto`, which still
    // rendered a scrollbar and a right-side offset.
    const proto = getSkill("prototype")!;
    expect(proto.content).toContain("No element may scroll, not just the root");
    expect(proto.content).toContain("overflow-y: auto");
    expect(proto.content).toContain("overflow: scroll");
  });

  it("bans inner scrolling containers, not just the root, in the slides skill", () => {
    const slides = getSkill("slides")!;
    expect(slides.content).toContain("No element may scroll, not just the root");
    expect(slides.content).toContain("overflow-y: auto");
  });

  it("tells the agent to diagnose contrast before cycling icon names", () => {
    // Regression: ~10 turns spent cycling ph-* names (stopwatch -> pulse ->
    // sliders-horizontal -> sliders -> faders -> faders-horizontal -> funnel)
    // when the real defect was a CSS rule painting the icon near-invisible
    // against its own background.
    const proto = getSkill("prototype")!;
    expect(proto.content).toContain("Never cycle through icon names hoping one renders");
    expect(proto.content.toLowerCase()).toContain("issues");
    expect(proto.content).toContain("font-size");
  });

  it("names the un-imported-weight cause of a blank icon in the prototype skill", () => {
    // ph-fill/ph-bold/ph-duotone need their own stylesheet; with only the
    // regular @import they render as blank space with a perfectly valid name,
    // and the editor's unknown-name lint deliberately does not flag them —
    // so the skill has to carry this cause or the agent chases contrast forever.
    const proto = getSkill("prototype")!;
    expect(proto.content).toContain("A weight you never imported");
    expect(proto.content).toContain("ph-duotone");
  });
});

describe("getSkillTools / load_skill", () => {
  it("returns the skill instructions for a known skill", async () => {
    await loadSkills();
    const tools = getSkillTools() as {
      load_skill: { execute: (a: { name: string }) => Promise<unknown> };
    };
    const out = (await tools.load_skill.execute({ name: "prototype" })) as {
      name: string;
      instructions: string;
    };
    expect(out.name).toBe("prototype");
    expect(out.instructions).toContain("PROTOTYPE mode");
  });

  it("returns an error listing available skills for an unknown name", async () => {
    await loadSkills();
    const tools = getSkillTools() as {
      load_skill: { execute: (a: { name: string }) => Promise<unknown> };
    };
    const out = (await tools.load_skill.execute({ name: "nope" })) as {
      error: string;
    };
    expect(out.error).toContain("nope");
    expect(out.error).toContain("prototype");
  });
});

// Regression coverage for the code-review findings on design-from-repo.md:
// (1) the skill used to claim a local brief is "already sitting in
// canvasContext" and told the agent to skip read_design_repo when one is
// attached — the only producer of a brief is read_design_repo itself, so
// following that instruction meant designing with zero real tokens/
// components. (2) it also told the agent to read `repo.source`, but the
// field is a top-level `source` on DesignBrief, a sibling of `repo`.
describe("design-from-repo skill content", () => {
  it("never tells the agent a local brief already sits in canvasContext, or to skip read_design_repo", async () => {
    await loadSkills();
    const skill = getSkill("design-from-repo")!;
    expect(skill).toBeDefined();
    expect(skill.content).not.toMatch(/already sitting in `?canvasContext`?/i);
    expect(skill.content).not.toMatch(/skip (straight to step 3|read_design_repo)/i);
  });

  it("always instructs calling read_design_repo first, even when a local repo is attached", async () => {
    await loadSkills();
    const skill = getSkill("design-from-repo")!;
    expect(skill.content).toMatch(/must always do this first/i);
  });

  it("references DesignBrief's real field name `source`, never the non-existent `repo.source`", async () => {
    await loadSkills();
    const skill = getSkill("design-from-repo")!;
    expect(skill.content).not.toContain("`repo.source`");
    expect(skill.content).not.toContain("repo.source");
  });

  it("mentions the localRepo canvasContext marker as a name/count only, not a brief", async () => {
    await loadSkills();
    const skill = getSkill("design-from-repo")!;
    expect(skill.content).toMatch(/localRepo/);
    expect(skill.content).toMatch(/no\s+brief is ever placed/i);
  });
});
