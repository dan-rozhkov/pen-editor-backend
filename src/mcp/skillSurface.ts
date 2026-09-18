// Honesty layer between the curated skill catalog (src/ai/skills.ts,
// src/skills/*.md) and the MCP tool surface (src/mcp/server.ts).
//
// The curated catalog is authored for the full chat agent, which has every
// penTools schema (mostly client-executed in the browser) plus mode/policy
// routing (resolveTaskPolicy, src/ai/taskPolicy.ts). An MCP client only gets
// BRIDGED_TOOL_NAMES + STATIC_TOOL_NAMES + SKILL_TOOL_NAMES — a narrow slice.
// list_skills/load_skill must not pretend the rest of the catalog works
// unchanged on that slice: a skill whose instructions call a tool that isn't
// on the MCP surface (e.g. publish_to_showcase, create_plugin, ask_user)
// dead-ends the calling agent, and prototype/slides dead-end *worse* because
// their instructions assume mode/policy routing that simply doesn't exist
// off the chat route.
//
// This module never removes anything from the catalog — it only computes an
// honest label for each entry so list_skills/load_skill can say so instead of
// silently handing out instructions that can't be followed to the end.

import type { Skill } from "../ai/skills.js";
import { penTools } from "../ai/tools.js";
import { BRIDGED_TOOL_NAMES, SKILL_TOOL_NAMES, STATIC_TOOL_NAMES } from "./toolNames.js";

// Tool names referenced by curated skill markdown but declared nowhere in
// this repo's own schemas — never a penTools entry, never SKILL_TOOL_NAMES.
// Without these, ALL_KNOWN_TOOL_NAMES below can only ever detect a skill
// calling a *known* tool that's missing from the MCP surface; a skill built
// entirely on tools this repo never declares (research.md, which calls only
// Mobbin MCP tools) would score zero mentions and getUnavailableToolsForSkill
// would silently return [] — exactly the dead-end this module exists to
// prevent, and the worst case: research mode silently runs with NO reference
// tools at all off the chat route (see POLICY_DEPENDENT_SKILL_NAMES below)
// with load_skill("research") never having said a word about it.
//
// Kept as an explicit, sourced list rather than inferring "any snake_case
// identifier not on our surface" from prose — that would also catch a design
// skill's incidental mentions of CSS/token identifiers (`font_size`,
// `border_radius`, ...) that just happen to share tool-name shape, and turn
// every one of them into a false "unavailable tool" claim. An explicit list
// only grows when a skill actually needs a new external name recognized;
// each entry below is one this repo can point to:
//   - search_screens/search_flows/search_sections — the entire Mobbin MCP
//     tool surface (src/ai/mcp.ts), exactly as src/skills/research.md spells
//     them. Unlike Refero, Mobbin's tools have no server-side name prefix,
//     so there is no second "wire name" spelling to also list here.
//   - web_search/fetch_url — the built-in internet tools src/ai/system-
//     prompt.ts documents as "if available"; never configured for this MCP
//     server (which has no web-search wiring at all), so always unavailable
//     here regardless of chat-route configuration.
const EXTERNAL_SKILL_TOOL_NAMES: readonly string[] = [
  "search_screens",
  "search_flows",
  "search_sections",
  "web_search",
  "fetch_url",
];

// Every tool name a skill's instructions could plausibly reference: the full
// penTools schema set (client- and server-executed alike — a skill doesn't
// know or care which side executes a tool), the two skill-catalog tools (a
// skill can tell an agent to `load_skill` another skill, as prototype.md
// does for "research"), and the external tools above that this repo never
// declares a schema for at all.
const ALL_KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(penTools),
  ...SKILL_TOOL_NAMES,
  ...EXTERNAL_SKILL_TOOL_NAMES,
]);

// What's actually callable through this MCP server.
const MCP_SURFACE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...BRIDGED_TOOL_NAMES,
  ...STATIC_TOOL_NAMES,
  ...SKILL_TOOL_NAMES,
]);

// Tool names are exclusively snake_case, multi-segment identifiers
// (get_editor_state, batch_design, publish_to_showcase, ...) — no real
// English word collides with that shape, so matching on it directly (rather
// than a curated word list) is safe from false positives. We accept two
// spellings actually used in the skill markdown:
//   - backtick-quoted, prose style: `publish_to_showcase`
//   - call style, in fenced code or inline: publish_to_showcase( ... )
const BACKTICK_TOKEN_RE = /`([a-z][a-z0-9_]*)`/g;
const CALL_STYLE_TOKEN_RE = /\b([a-z][a-z0-9_]*)\(/g;

/**
 * Tool names from `candidates` that appear to be referenced in `text`,
 * via backtick-quoting or call syntax. Exported standalone (rather than only
 * as part of getUnavailableToolsForSkill) so the detector itself is unit
 * testable against known-tricky prose without needing a full Skill object.
 */
export function detectReferencedToolNames(
  text: string,
  candidates: ReadonlySet<string> = ALL_KNOWN_TOOL_NAMES,
): string[] {
  const found = new Set<string>();

  for (const re of [BACKTICK_TOKEN_RE, CALL_STYLE_TOKEN_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text))) {
      const name = match[1];
      if (candidates.has(name)) found.add(name);
    }
  }

  return [...found].sort();
}

// prototype/slides don't just call tools missing from the MCP surface — the
// chat route's resolveTaskPolicy (src/ai/taskPolicy.ts) swaps in an
// embed-only batch_design variant and drives mode routing whenever one of
// them is loaded. None of that exists on the MCP path: there is no chat
// route, no mode, no policy swap. Kept as its own explicit, commented list
// (rather than inferring it from tool mentions) because this gap isn't about
// a missing tool at all — it's a missing subsystem.
//
// "research" belongs here too, for a related but distinct reason: /api/chat's
// `agentMode` field (AGENT_MODES in src/ai/system-prompt.ts) is recorded into
// traces/analytics only — there is no gate on the chat route that 503s, or
// otherwise rejects, a request with no Mobbin MCP connection. Research mode
// simply runs with whatever tools getMCPTools resolves for that request:
// the full Mobbin toolset when the browser supplied a valid X-Mobbin-Token
// (per-user OAuth, unlike the old Refero setup's shared server key), or NO
// reference tools at all when it didn't — silently, not as an error. That's
// a second, independent gap from the tool-name detection above
// (EXTERNAL_SKILL_TOOL_NAMES already flags every Mobbin tool research.md
// mentions as unavailable on its own): even a caller who somehow tolerated
// every missing Mobbin tool would still be relying on a mode whose entire
// reference-tool surface is opportunistic, not guaranteed, on this MCP path
// (which has no equivalent of the browser's X-Mobbin-Token header at all).
// getSkillSurfaceWarning below renders a research-specific sentence for this
// (distinct from prototype/slides' resolveTaskPolicy sentence) so the
// warning names the actual mechanism instead of a generic "policy routing"
// that wouldn't be true of research.
export const POLICY_DEPENDENT_SKILL_NAMES: ReadonlySet<string> = new Set([
  "prototype",
  "slides",
  "research",
]);

/** Tool names `skill`'s instructions reference that aren't on the MCP surface. */
export function getUnavailableToolsForSkill(skill: Pick<Skill, "content">): string[] {
  return detectReferencedToolNames(skill.content, ALL_KNOWN_TOOL_NAMES).filter(
    (name) => !MCP_SURFACE_TOOL_NAMES.has(name),
  );
}

const SURFACE_NOTICE =
  "This MCP server exposes a narrower tool surface than the built-in chat agent " +
  "(see list_skills/load_skill results for what a given skill needs). A skill that " +
  "references an unavailable tool cannot be completed end to end here — skip the " +
  "steps that need it and tell the user what was skipped.";

/** The general disclaimer list_skills should surface once, alongside the catalog. */
export function getSkillSurfaceNotice(): string {
  return SURFACE_NOTICE;
}

/**
 * Warning text to prepend to a skill's instructions when loaded via
 * load_skill, or undefined if the skill is fully usable on this surface.
 */
export function getSkillSurfaceWarning(skill: Pick<Skill, "name" | "content">): string | undefined {
  const unavailableTools = getUnavailableToolsForSkill(skill);
  const policyDependent = POLICY_DEPENDENT_SKILL_NAMES.has(skill.name);

  if (unavailableTools.length === 0 && !policyDependent) return undefined;

  const lines = [
    `NOTE: this MCP server's tool surface is narrower than the built-in chat agent's.`,
  ];
  if (unavailableTools.length > 0) {
    lines.push(
      `The following tools this skill's instructions call are NOT available here: ${unavailableTools.join(", ")}. ` +
        `Skip any step that needs one of them and tell the user it was skipped instead of guessing at a substitute.`,
    );
  }
  if (policyDependent) {
    lines.push(
      skill.name === "research"
        ? `This skill also assumes the chat route's research mode, whose Mobbin reference tools only exist there ` +
            `when the browser supplies a per-user X-Mobbin-Token (see src/routes/mobbinAuth.ts) — there is no ` +
            `equivalent credential on this MCP path, so research runs with NO reference tools here, silently, ` +
            `on top of whichever Mobbin tools above are unavailable. Treat this whole skill as unsupported unless ` +
            `Mobbin tools are genuinely reachable through this session.`
        : `This skill also assumes the chat route's mode/policy routing (resolveTaskPolicy, embed-only ` +
            `batch_design) which does not exist on this MCP path — treat any instruction that depends on it as inapplicable.`,
    );
  }
  return lines.join("\n");
}
