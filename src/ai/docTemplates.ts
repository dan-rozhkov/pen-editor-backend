import { DOC_ONLY_SKILL_NAMES, ensureSkillsLoaded, getSkill, type Skill } from "./skills.js";

export interface DocTemplate {
  /** `<skill>` or `<skill>-<kind>`. */
  id: string;
  skill: string;
  kind?: string;
  /** H1 text of the template, without the leading `# `. */
  title: string;
  /** Short human label, for example "Usability test plan". */
  label: string;
  /** One-line description (the skill description's first sentence). */
  description: string;
  /** Template body without the H1 line and the blank line after it. */
  markdown: string;
}

/** Kinds per skill. A skill with no entry has one template without a kind. */
const KINDS: Record<string, { kind?: string; label: string }[]> = {
  "usability-test": [
    { kind: "plan", label: "Usability test plan" },
    { kind: "report", label: "Usability test report" },
  ],
};

/** "bug-report" -> "Bug report". */
function labelFor(skill: string): string {
  const words = skill.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The doc-only skills carry the document templates, so the list follows DOC_ONLY_SKILL_NAMES. */
function templateSkills(): { skill: string; kinds: { kind?: string; label: string }[] }[] {
  return [...DOC_ONLY_SKILL_NAMES].map((skill) => ({
    skill,
    kinds: KINDS[skill] ?? [{ label: labelFor(skill) }],
  }));
}

function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  return m ? m[1] : flat;
}

/**
 * Extracts the ````markdown block that directly follows the heading
 * `## Template` (kind undefined) or `## Template: <kind>`.
 */
export function extractTemplateBlock(content: string, kind?: string): string | undefined {
  const heading = kind === undefined ? "## Template" : `## Template: ${kind}`;
  const lines = content.split("\n");
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at === -1) return undefined;
  let i = at + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  const open = /^(`{4,})markdown\s*$/.exec(lines[i] ?? "");
  if (!open) return undefined;
  const fence = open[1];
  const body: string[] = [];
  for (i += 1; i < lines.length; i++) {
    if (lines[i].trim() === fence) return body.join("\n");
    body.push(lines[i]);
  }
  return undefined;
}

/** Splits `# Title` off the template body. */
export function splitTitle(block: string): { title: string; markdown: string } | undefined {
  const lines = block.split("\n");
  const m = /^#\s+(.+?)\s*$/.exec(lines[0] ?? "");
  if (!m) return undefined;
  let rest = 1;
  while (rest < lines.length && lines[rest].trim() === "") rest++;
  return { title: m[1], markdown: lines.slice(rest).join("\n").replace(/\s+$/, "") + "\n" };
}

export function buildDocTemplates(getSkillByName: (name: string) => Skill | undefined): DocTemplate[] {
  const out: DocTemplate[] = [];
  for (const { skill, kinds } of templateSkills()) {
    const s = getSkillByName(skill);
    if (!s) continue;
    for (const { kind, label } of kinds) {
      const block = extractTemplateBlock(s.content, kind);
      const parts = block === undefined ? undefined : splitTitle(block);
      if (!parts) continue;
      out.push({
        id: kind === undefined ? skill : `${skill}-${kind}`,
        skill,
        ...(kind === undefined ? {} : { kind }),
        title: parts.title,
        label,
        description: firstSentence(s.description),
        markdown: parts.markdown,
      });
    }
  }
  return out;
}

let cache: DocTemplate[] | undefined;

/** Builds the list once, after the skills are loaded, and caches it. */
export async function getDocTemplates(): Promise<DocTemplate[]> {
  if (cache) return cache;
  await ensureSkillsLoaded();
  const built = buildDocTemplates(getSkill);
  if (built.length > 0) cache = built;
  return built;
}

export function resetDocTemplatesCacheForTests(): void {
  cache = undefined;
}
