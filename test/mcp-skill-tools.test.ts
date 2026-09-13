import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../src/mcp/server.js";
import {
  detectReferencedToolNames,
  getUnavailableToolsForSkill,
  POLICY_DEPENDENT_SKILL_NAMES,
} from "../src/mcp/skillSurface.js";

// Exercises list_skills/load_skill through the actual registered MCP tool
// handlers (not just the underlying src/ai/skills.ts functions, which
// test/skills.test.ts already covers) — this is what verifies the MCP-level
// wrapping (ensureSkillsLoaded() call, JSON shape, isError on an unknown
// name) actually works end to end.
//
// The SDK doesn't expose a public "invoke this registered tool" API, so this
// reaches into the same internal map test/mcp-tools-contract.test.ts uses
// and calls the registered handler directly — mirroring how the SDK's own
// CallToolRequestSchema handler invokes it (see executeToolHandler in
// @modelcontextprotocol/sdk/dist/esm/server/mcp.js).
interface RegisteredTool {
  handler: (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
}

function getRegisteredTool(server: ReturnType<typeof buildMcpServer>, name: string): RegisteredTool {
  const internal = server as unknown as { _registeredTools: Record<string, RegisteredTool> };
  const tool = internal._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} was not registered`);
  return tool;
}

interface CatalogEntry {
  name: string;
  description: string;
  unavailableTools?: string[];
  policyDependent?: true;
}

async function listSkills(server: ReturnType<typeof buildMcpServer>) {
  const tool = getRegisteredTool(server, "list_skills");
  const result = await tool.handler({}, {});
  const parsed = JSON.parse(result.content[0]?.text as string) as { notice: string; skills: CatalogEntry[] };
  return { result, ...parsed };
}

describe("MCP skill tools", () => {
  it("list_skills returns a non-empty curated catalog alongside a surface notice", async () => {
    const server = buildMcpServer();
    const { result, notice, skills } = await listSkills(server);
    expect(result.isError).toBeFalsy();
    expect(typeof notice).toBe("string");
    expect(notice.length).toBeGreaterThan(0);
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
      if (skill.unavailableTools !== undefined) {
        expect(Array.isArray(skill.unavailableTools)).toBe(true);
        expect(skill.unavailableTools.length).toBeGreaterThan(0);
      }
    }
  });

  it("list_skills flags a skill whose instructions call tools missing from the MCP surface", async () => {
    const server = buildMcpServer();
    const { skills } = await listSkills(server);
    // publish-showcase.md instructs the agent to call publish_to_showcase,
    // which is not part of BRIDGED_TOOL_NAMES/STATIC_TOOL_NAMES.
    const entry = skills.find((s) => s.name === "publish-showcase");
    expect(entry).toBeTruthy();
    expect(entry?.unavailableTools).toContain("publish_to_showcase");
  });

  it("list_skills omits unavailableTools for a skill fully usable on this surface", async () => {
    const server = buildMcpServer();
    const { skills } = await listSkills(server);
    // polish.md is a design-craft skill that never names a specific tool call
    // outside the MCP surface (and isn't prototype/slides) — should be clean.
    const entry = skills.find((s) => s.name === "polish");
    expect(entry).toBeTruthy();
    expect(entry?.unavailableTools).toBeUndefined();
  });

  it("list_skills no longer flags rename-layers now that rename_layers is bridged over MCP", async () => {
    const server = buildMcpServer();
    const { skills } = await listSkills(server);
    const entry = skills.find((s) => s.name === "rename-layers");
    expect(entry).toBeTruthy();
    expect(entry?.unavailableTools).toBeUndefined();
  });

  // Defect 1 regression: research.md calls only tools outside penTools
  // (Refero's search_screens/search_flows/get_screen/get_flow/
  // get_design_guidance) — before EXTERNAL_SKILL_TOOL_NAMES existed, the
  // detector's candidate set was penTools keys + SKILL_TOOL_NAMES only, so
  // none of those mentions could ever be found and this entry silently came
  // back with no unavailableTools at all.
  it("list_skills flags research's Refero-only tool calls as unavailable", async () => {
    const server = buildMcpServer();
    const { skills } = await listSkills(server);
    const entry = skills.find((s) => s.name === "research");
    expect(entry).toBeTruthy();
    expect(entry?.unavailableTools).toEqual(
      expect.arrayContaining(["search_screens", "search_flows", "get_screen", "get_flow", "get_design_guidance"]),
    );
  });

  // Defect 4 regression: prototype/slides/research assume a whole gated
  // subsystem (resolveTaskPolicy routing, or research mode's 503-without-MCP
  // gate) that load_skill warns about even when tool-mention detection finds
  // nothing — before this field existed, the catalog entry itself gave no
  // sign of that, so a caller that only reads list_skills (never loads every
  // skill) had no way to see it.
  it("list_skills marks prototype/slides/research as policyDependent", async () => {
    const server = buildMcpServer();
    const { skills } = await listSkills(server);
    for (const name of POLICY_DEPENDENT_SKILL_NAMES) {
      const entry = skills.find((s) => s.name === name);
      expect(entry, name).toBeTruthy();
      expect(entry?.policyDependent, name).toBe(true);
    }
    const clean = skills.find((s) => s.name === "polish");
    expect(clean?.policyDependent).toBeUndefined();
  });

  it("load_skill returns full instructions for a known curated skill", async () => {
    const server = buildMcpServer();
    const { skills } = await listSkills(server);
    expect(skills.length).toBeGreaterThan(0);
    const [{ name }] = skills;

    const loadTool = getRegisteredTool(server, "load_skill");
    const result = await loadTool.handler({ name }, {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBeTruthy();
  });

  it("load_skill prepends a warning when the skill references unavailable tools", async () => {
    const server = buildMcpServer();
    const loadTool = getRegisteredTool(server, "load_skill");
    const result = await loadTool.handler({ name: "publish-showcase" }, {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text as string;
    expect(text).toContain("NOTE:");
    expect(text).toContain("publish_to_showcase");
  });

  it("load_skill warns about resolveTaskPolicy for prototype/slides even without an unavailable-tool mention", async () => {
    const server = buildMcpServer();
    const loadTool = getRegisteredTool(server, "load_skill");
    for (const name of ["prototype", "slides"]) {
      const result = await loadTool.handler({ name }, {});
      expect(result.isError, name).toBeFalsy();
      expect(result.content[0]?.text, name).toContain("resolveTaskPolicy");
    }
  });

  // research's policy-dependent warning names a different mechanism (the
  // chat route's research-mode 503 gate, not resolveTaskPolicy) — asserted
  // separately rather than folded into the loop above so the test can't pass
  // by accident if the two messages were ever conflated into one generic,
  // partly-inaccurate sentence.
  it("load_skill warns about the research-mode 503 gate for research, distinct from resolveTaskPolicy", async () => {
    const server = buildMcpServer();
    const loadTool = getRegisteredTool(server, "load_skill");
    const result = await loadTool.handler({ name: "research" }, {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text as string;
    expect(text).toContain("NOTE:");
    expect(text).toContain("503");
    expect(text).not.toContain("resolveTaskPolicy");
  });

  it("POLICY_DEPENDENT_SKILL_NAMES includes research alongside prototype/slides", () => {
    expect([...POLICY_DEPENDENT_SKILL_NAMES].sort()).toEqual(["prototype", "research", "slides"]);
  });

  it("load_skill does not prepend any warning for a clean skill", async () => {
    const server = buildMcpServer();
    const loadTool = getRegisteredTool(server, "load_skill");
    const result = await loadTool.handler({ name: "polish" }, {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).not.toContain("NOTE:");
  });

  it("load_skill reports an error listing available names for an unknown skill", async () => {
    const server = buildMcpServer();
    const tool = getRegisteredTool(server, "load_skill");
    const result = await tool.handler({ name: "definitely-not-a-real-skill" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown skill");
    expect(result.content[0]?.text).toContain("Available skills:");
  });
});

describe("detectReferencedToolNames", () => {
  const candidates = new Set(["batch_design", "publish_to_showcase", "get_editor_state"]);

  it("matches a backtick-quoted tool name", () => {
    expect(detectReferencedToolNames("Call `batch_design` first.", candidates)).toEqual(["batch_design"]);
  });

  it("matches a call-style mention", () => {
    expect(detectReferencedToolNames("publish_to_showcase({ screens })", candidates)).toEqual([
      "publish_to_showcase",
    ]);
  });

  it("does not false-positive on ordinary English prose", () => {
    const prose =
      "Design a batch of screens, get the editor state first, and publish your work to the showcase " +
      "once everything looks right. Call get_editor_state, then design, then publish.";
    expect(detectReferencedToolNames(prose, candidates)).toEqual([]);
  });

  it("does not match a candidate name that only appears as a substring of another word", () => {
    // "get_editor_state" must not match inside "widget_editor_stateful" or similar
    const text = "`widget_editor_stateful_thing` is unrelated.";
    expect(detectReferencedToolNames(text, candidates)).toEqual([]);
  });

  it("dedupes repeated mentions", () => {
    const text = "`batch_design` ... later, batch_design( again )";
    expect(detectReferencedToolNames(text, candidates)).toEqual(["batch_design"]);
  });
});

describe("getUnavailableToolsForSkill", () => {
  it("returns tool names referenced in the skill body that are outside the MCP surface", () => {
    const skill = { content: "First call `get_editor_state`, then `publish_to_showcase`." };
    expect(getUnavailableToolsForSkill(skill)).toEqual(["publish_to_showcase"]);
  });

  it("returns an empty list when every referenced tool is on the MCP surface", () => {
    const skill = { content: "Use `get_editor_state` and `batch_get`." };
    expect(getUnavailableToolsForSkill(skill)).toEqual([]);
  });

  // Defect 1: the candidate set used to be penTools keys + SKILL_TOOL_NAMES
  // only, so a skill referencing exclusively external (Refero/web) tool
  // names scored zero unavailable tools — indistinguishable from a skill
  // that never mentioned any tool at all. This is research.md's actual shape
  // (see research.md's Tool Selection table and Search Strategy section).
  it("flags Refero tool names research.md actually uses, even though none is a penTools key", () => {
    const skill = {
      content:
        "Start with `get_design_guidance`. Use `search_screens` for a standalone screen, or " +
        "`search_flows` and then `get_flow` for a whole journey. Deep-dive with `get_screen` on " +
        "the best 3-4 results.",
    };
    expect(getUnavailableToolsForSkill(skill)).toEqual(
      ["get_design_guidance", "get_flow", "get_screen", "search_flows", "search_screens"].sort(),
    );
  });

  it("flags web_search/fetch_url when a skill mentions them", () => {
    const skill = { content: "Use `web_search` to find references, then `fetch_url` to read one." };
    expect(getUnavailableToolsForSkill(skill)).toEqual(["fetch_url", "web_search"]);
  });

  // The other direction of the same defect: widening the candidate set must
  // not turn ordinary design vocabulary that merely looks tool-shaped
  // (snake_case, sometimes multi-segment) into false "unavailable tool"
  // claims. These are real strings that appear in curated skill markdown
  // today (see the `font_size`/`border_radius`/`opacity` backtick mentions
  // across src/skills/*.md) — none of them is in EXTERNAL_SKILL_TOOL_NAMES,
  // so none should ever be flagged.
  it("does not flag ordinary CSS/property identifiers that merely look tool-shaped", () => {
    const skill = {
      content:
        "Keep `font_size` and `border_radius` consistent with the design system. Adjust `opacity` " +
        "and `line_height` for legibility. Never call border_radius( ) or font_size( ) directly — " +
        "these are CSS properties, not tools.",
    };
    expect(getUnavailableToolsForSkill(skill)).toEqual([]);
  });
});
