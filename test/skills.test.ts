import { describe, expect, it, beforeAll } from "vitest";
import {
  detectSkillCommand,
  getAllSkills,
  getSkill,
  getSkillTools,
  loadSkills,
  DOC_ONLY_SKILL_NAMES,
} from "../src/ai/skills.js";
import { AGENT_BROWSER_QA_GUIDANCE } from "../src/ai/system-prompt.js";
import { SHOWCASE_VIEWPORTS } from "../src/showcase/platform.js";
import { penTools } from "../src/ai/tools.js";

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

  // The Calibration block is COPY-PASTED into three skills rather than
  // referenced from one — prototype inlines it so it stays self-sufficient
  // under one-skill injection, and new-work carries its own. Widening the axis
  // in one file and not the others is the failure mode this pins: a guardrail
  // that only two of three carriers enforce is a guardrail with a hole in it.
  const CALIBRATION_CARRIERS = ["prototype", "frontend-design", "new-work"] as const;

  it("carries the same anti-default Calibration axis in every skill that copies it", () => {
    for (const name of CALIBRATION_CARRIERS) {
      const skill = getSkill(name)!;
      expect(skill, `${name} skill missing`).toBeDefined();
      // The axis covers BOTH accent bands. Described as a conjunction of
      // traits ("cream AND serif AND terracotta") it missed every variation,
      // so it is an axis: a warm ground plus either naturals accent, serif or
      // not, light or dark.
      expect(skill.content, name).toMatch(/reassuring-naturals axis/i);
      expect(skill.content, name).toMatch(/terracotta/i);
      expect(skill.content, name).toMatch(/forest green/i);
      // The meta-trap: swapping one default for another is not a fix, so the
      // escape from the list is a stated reason and never a new palette.
      expect(skill.content, name).toContain(
        "A tell is an unspecified default, not a forbidden value.",
      );
    }
  });

  it("makes the naturals-cluster check numeric in the prototype pre-flight", () => {
    const proto = getSkill("prototype")!;
    // Checklists work on these models where prose floors do not, and "read the
    // hue off your own hex" is what stops the check being eyeballed away.
    expect(proto.content).toContain("NATURALS-CLUSTER CHECK");
    expect(proto.content).toContain("8–55°");
    expect(proto.content).toContain("75–160°");
  });

  it("forbids vague adjectives and reference-averaging in the prototype skill", () => {
    const proto = getSkill("prototype")!;
    // An unspecified brief returns the median of the training data, and
    // "modern / clean / premium / sleek" specify nothing.
    expect(proto.content).toContain("Vague adjectives are not a direction");
    // The old wording told the model to synthesize references into their
    // common threads — i.e. to compute the median of the median. It must not
    // come back.
    expect(proto.content).not.toContain("synthesize a cohesive style from their common threads");
    expect(proto.content).toContain("Never average them.");
  });

  it("gives the critique skill a numbered, checkable slop-tell scan", () => {
    const critique = getSkill("critique")!;
    const heading = "### The slop-tell scan (checkable)";
    expect(critique.content).toContain(heading);
    // Count the tells INSIDE the scan section only — the file carries other
    // numbered lists further down, so counting across the whole document
    // would still pass with half the tells deleted.
    const start = critique.content.indexOf(heading) + heading.length;
    const next = critique.content.indexOf("\n### ", start);
    const section = critique.content.slice(start, next === -1 ? undefined : next);
    const tells = section.match(/^\d{1,2}\. \*\*/gm) ?? [];
    expect(tells.length).toBe(12);
    // Each tell has to carry its own pass/fail test and say what to record —
    // that is the whole difference from the prose it replaces.
    expect(section.match(/Test:/g) ?? []).toHaveLength(12);
    expect(section.match(/Record:/g) ?? []).toHaveLength(12);
    // Both assessments must run it, and the verdict must name which fired.
    expect(critique.content).toContain("name which numbered tells fired");
    expect(critique.content).toContain(
      "A tell is an unspecified default, not a forbidden value.",
    );
  });

  it("gives bug-hunt a 12-family attack catalog and the QA rules", () => {
    const hunt = getSkill("bug-hunt")!;
    expect(hunt).toBeDefined();
    expect(hunt.args.map((a) => a.name)).toEqual(["target"]);
    const heading = "## Attack catalog";
    expect(hunt.content).toContain(heading);
    const start = hunt.content.indexOf(heading) + heading.length;
    const next = hunt.content.indexOf("\n## ", start);
    const section = hunt.content.slice(start, next === -1 ? undefined : next);
    expect(section.match(/^\d{1,2}\. \*\*/gm) ?? []).toHaveLength(12);
    expect(section.match(/Try:/g) ?? []).toHaveLength(12);
    expect(section.match(/Expect:/g) ?? []).toHaveLength(12);
    expect(hunt.content).toContain("qa: true");
    expect(hunt.content).toContain("setup.network");
    expect(hunt.content).toContain("setup.emulate");
    expect(hunt.content).toContain("Rerun every failed scenario once");
    // Live smoke 19.10: the agent never sent `checks` while the rule was
    // conditional, and never typed regex characters into a search field.
    expect(hunt.content).toContain("every attack run MUST pass `checks`");
    expect(hunt.content).toContain("In search and filter fields, also type regex and wildcard characters");
    expect(AGENT_BROWSER_QA_GUIDANCE).toContain("bug-hunt");
  });

  it("keeps the bug-hunt scenario example valid against the browse_agent schema", () => {
    // The example is what the model copies. A field name that the schema
    // rejects (it is strict) turns every copied call into a validation error.
    const hunt = getSkill("bug-hunt")!;
    const block = /```json\n([\s\S]*?)\n```/.exec(hunt.content);
    expect(block).not.toBeNull();
    const example: unknown = JSON.parse(block![1]);
    const schema = penTools.browse_agent.inputSchema as import("zod").ZodType;
    expect(schema.safeParse(example).success).toBe(true);
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

  it("pins the screen-by-screen reasoning rule in the prototype skill", () => {
    // Regression guard: models used to think through every screen's layout
    // in one long reasoning pass before the first batch_design call. The
    // skill must direct one screen of reasoning + one batch_design call at a
    // time, reusing the first screen's tokens/styles verbatim.
    const proto = getSkill("prototype")!;
    expect(proto.content).toContain("Work screen-by-screen, not all-at-once");
    expect(proto.content).toContain("one screen per `batch_design` call");
    expect(proto.content).toContain("byte-for-byte");
  });

  it("pins the fit-to-canvas rules in the prototype skill", () => {
    const proto = getSkill("prototype")!;
    expect(proto.content).toContain("Fit to canvas");
    expect(proto.content).toContain("overflow: hidden");
    expect(proto.content).toContain("box-sizing: border-box");
    // Checklist item to catch overflow before emitting HTML.
    expect(proto.content).toContain("FIT-TO-CANVAS CHECK");
  });

  it("pins the spacing pass in the prototype skill", () => {
    const proto = getSkill("prototype")!;
    expect(proto.content).toContain("### Spacing pass");
    // The ladder lives in :root, so every screen gets one without a tool call.
    for (const token of ["--space-inside", "--space-item", "--space-group", "--space-section", "--space-page"]) {
      expect(proto.content).toContain(token);
    }
    expect(proto.content).toContain("4/8/12/16/20/24/32/40/48/64");
    expect(proto.content).toContain("Container padding ≥ the gap between its items");
    // Checklist item to catch the 20/20/20 look before emitting HTML.
    expect(proto.content).toContain("SPACING-LADDER CHECK");
  });

  it("pins the spacing ladder in the slides skill", () => {
    const slides = getSkill("slides")!;
    expect(slides.content).toContain("Spacing ladder in the master `:root`");
    expect(slides.content).toContain("4/8/12/16/20/24/32/40/48/64");
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

// Document templates: each skill hands doc_create a skeleton. doc_create's
// description routes to these names, so a rename here must update it too.
const DOC_TEMPLATE_SKILLS = [...DOC_ONLY_SKILL_NAMES];

// GFM cells split on every unescaped pipe outside inline code.
const countCells = (row: string) =>
  row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").replace(/`[^`]*`/g, "x").split(/(?<!\\)\|/).length;

// Every table row of a skill, paired with its table's header row.
function tableRowsWithHeader(content: string): Array<{ header: string; row: string }> {
  const out: Array<{ header: string; row: string }> = [];
  let header: string | null = null;
  for (const line of content.split("\n")) {
    const isRow = line.trim().startsWith("|");
    header = isRow ? (header ?? line) : null;
    if (isRow && header !== line) out.push({ header, row: line });
  }
  return out;
}

describe("document template skills", () => {
  beforeAll(async () => {
    await loadSkills();
  });

  it("covers the six template types", () => {
    expect([...DOC_TEMPLATE_SKILLS].sort()).toEqual(
      ["bug-report", "design-brief", "design-spec", "test-plan", "test-report", "usability-test"],
    );
  });

  it.each(DOC_TEMPLATE_SKILLS)("%s loads with a template, writes through doc_create and cites sources", (name) => {
    const skill = getSkill(name)!;
    expect(skill).toBeDefined();
    expect(skill.description.length).toBeGreaterThan(0);
    expect(skill.content).toContain("doc_create");
    expect(skill.content).toMatch(/^## Template/m);
    expect(skill.content).toMatch(/^## Sources/m);
    expect(skill.content).toContain("```markdown");
    expect(skill.content).toContain("[TBD");
  });

  it.each(DOC_TEMPLATE_SKILLS)("%s uses only markup the document editor keeps", (name) => {
    const skill = getSkill(name)!;
    // Footnotes are dropped by the editor on the next user edit.
    expect(skill.content).not.toMatch(/\[\^[^\]]+\]/);
    // Only toggles and data-color/data-bg spans survive; any other tag is lost.
    const tags = skill.content.match(/<\/?[a-z][a-z0-9-]*\b[^>]*>/gi) ?? [];
    const allowed = /^(<\/?(details|summary)>|<span data-(color|bg)="[a-z]+">|<\/span>)$/;
    expect(tags.filter((t) => !allowed.test(t))).toEqual([]);
  });

  it.each(DOC_TEMPLATE_SKILLS)("%s tables have as many cells in each row as in the header", (name) => {
    const rows = tableRowsWithHeader(getSkill(name)!.content);
    const broken = rows.filter(({ header, row }) => countCells(row) !== countCells(header)).map((r) => r.row);
    expect(broken).toEqual([]);
  });

  it("gates every curated skill that writes with doc_create", () => {
    const writers = getAllSkills()
      .filter((s) => s.content.includes("Write the document with `doc_create`"))
      .map((s) => s.name)
      .sort();
    expect(writers).toEqual([...DOC_TEMPLATE_SKILLS].sort());
  });

  it("bug-report template writes its metadata as a property list", () => {
    expect(getSkill("bug-report")!.content).toContain("|  |  |\n| --- | --- |");
  });

  it("doc_create describes the empty-header property list", () => {
    const description = penTools.doc_create.description ?? "";
    expect(description).toContain("property list");
    expect(description).toContain("`|  |  |`");
    expect(penTools.doc_edit.description ?? "").toContain("property lists");
  });

  it("doc_create routes every template skill by name", () => {
    const description = penTools.doc_create.description ?? "";
    for (const name of DOC_TEMPLATE_SKILLS) expect(description).toContain(name);
  });
});

describe("QA retrospective skill rules", () => {
  it("keeps the QA retrospective rules in bug-hunt, bug-report and test-report", () => {
    const hunt = getSkill("bug-hunt")!.content;
    expect(hunt).toContain("Never guess an API URL");
    expect(hunt).toContain("`qa.unmatchedMocks`");
    expect(hunt).toContain("`visible: true`");
    expect(hunt).toContain("do not delete anything");
    expect(hunt).toContain("Judge:");
    expect(hunt).toContain("`placed`");
    expect(getSkill("bug-report")!.content).toContain("only if a rerun reproduced it");
    expect(getSkill("bug-report")!.content).toContain("only when it is in your tool list");
    expect(getSkill("test-report")!.content).toContain("`qa.unmatchedMocks`");
  });

  it("bug-report diagnoses, dedups by behaviour and names the suspect change", () => {
    const report = getSkill("bug-report")!.content;
    expect(report).toContain("## Diagnose before you report");
    expect(report).toContain("Write a report only for a product bug.");
    expect(report).toContain("treat it as one outage");
    expect(report).toContain("Never change the expected result to agree with the actual result.");
    expect(report).toContain("Compare the behaviour");
    expect(report).toContain("Set its status to Reopened with the red tag");
    expect(report).toContain("- Suspect change:");
    expect(report).toContain("Do not guess a commit.");
    expect(report).toContain("If the duplicate is Won't fix or Deferred, do not change its status.");
    expect(report).toContain("| Regression | [Yes: last good build X, first bad build Y / No / Unknown] (optional) |");
    expect(report).toContain('<span data-bg="red">Reopened</span>');
  });

  it("bug-report never claims a recheck that did not run, and keeps priority and language", () => {
    const report = getSkill("bug-report")!.content;
    expect(report).toContain("When the user asks again about a bug that you already reported");
    expect(report).toContain("if you did not call `browse_agent` in this turn");
    expect(report).toContain("Reading a saved trace with `trace_read` is not a new check.");
    expect(report).toContain("- Setting Priority yourself.");
    expect(report).toContain("Keep the Priority placeholder");
    expect(report).not.toContain("Severity and Priority are `[TBD: ...]` placeholders. Replace each one with the tag.");
    expect(report).not.toContain("`[TBD: set at triage]`");
    expect(report).toContain("When you edit an existing document, keep its language.");
    expect(report).toContain("are not a language signal");
    expect(report).toContain("Do this if the user names a newer build, or asks you to check the bug.");
    expect(report).toContain("If your rerun does not show the bug");
    expect(report).toContain("Write Priority as a tag only when the user gave it.");
  });
});
