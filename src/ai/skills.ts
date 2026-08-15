import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "ai";
import { z } from "zod";
import type { LearnedSkillStore } from "./skills/learnedStore.js";
import type { SkillRunContext } from "./skills/runContext.js";
import type { UserSkillStore } from "./skills/userStore.js";

export interface SkillArg {
  name: string;
  description: string;
  required: boolean;
}

export interface Skill {
  name: string;
  description: string;
  args: SkillArg[];
  content: string;
}

const skillsMap = new Map<string, Skill>();

// Exported (additive) so validateUserSkill.ts's parseUserSkillMarkdown can
// reuse the exact same `--- ... ---` frontmatter shape for user-uploaded
// .md skills instead of re-implementing a second parser that could drift
// from this one.
export interface Frontmatter {
  name?: string;
  description?: string;
  args: SkillArg[];
  body: string;
}

export function parseFrontmatter(raw: string): Frontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { args: [], body: raw };

  const lines = match[1].split("\n");
  let name: string | undefined;
  let description: string | undefined;
  const args: SkillArg[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("name:")) {
      name = line.slice(5).trim();
    } else if (line.startsWith("description:")) {
      description = line.slice(12).trim();
    } else if (line.startsWith("args:")) {
      // Parse YAML array items that follow
      i++;
      while (i < lines.length && lines[i].startsWith("  ")) {
        if (lines[i].trim().startsWith("- name:")) {
          const argName = lines[i].trim().slice(7).trim();
          let argDesc = "";
          let argRequired = false;
          // Read indented properties of this array item
          i++;
          while (i < lines.length && lines[i].startsWith("    ") && !lines[i].trim().startsWith("- ")) {
            const trimmed = lines[i].trim();
            if (trimmed.startsWith("description:")) {
              argDesc = trimmed.slice(12).trim();
            } else if (trimmed.startsWith("required:")) {
              argRequired = trimmed.slice(9).trim() === "true";
            }
            i++;
          }
          args.push({ name: argName, description: argDesc, required: argRequired });
          continue;
        }
        i++;
      }
      continue;
    }
    i++;
  }

  return { name, description, args, body: match[2] };
}

const ASK_INSTRUCTION_REPLACEMENT = "ask the user";

function processContent(content: string): string {
  return content.replace(/\{\{ask_instruction\}\}/g, ASK_INSTRUCTION_REPLACEMENT);
}

export async function loadSkills(): Promise<void> {
  // Resolve skills relative to this module: src/ai/../skills when running via
  // tsx, dist/ai/../skills when running the compiled build (the build script
  // copies src/skills → dist/skills so dist deploys are self-contained).
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  const dir = join(thisDir, "../skills");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    console.warn("[skills] No skills directory found at", dir);
    return;
  }

  const mdFiles = files.filter((f) => f.endsWith(".md"));
  await Promise.all(
    mdFiles.map(async (file) => {
      const raw = await readFile(join(dir, file), "utf-8");
      const fm = parseFrontmatter(raw);
      const name = fm.name ?? file.replace(/\.md$/, "");
      const skill: Skill = {
        name,
        description: fm.description ?? "",
        args: fm.args,
        content: processContent(fm.body),
      };
      skillsMap.set(name, skill);
    }),
  );

  console.log(`[skills] Loaded ${skillsMap.size} skills: ${[...skillsMap.keys()].join(", ")}`);
}

let loadOnce: Promise<void> | null = null;

// Loads skills unless they're already in memory, at most once per process.
//
// `loadSkills()` used to be called only from src/index.ts, i.e. only when the
// HTTP server boots. Any OTHER entry point into the agent — the showcase
// runner — then ran with an empty skills map, and failed silently in three
// places at once: a `/skill` slash command resolved to nothing (so its
// instructions were never injected), `load_skill` could not resolve a name,
// and `buildSystemPrompt` advertised an empty skill catalog. The agent still
// answered, just without any of its craft instructions — which is far worse
// than an error, because the output looks plausible.
//
// So the guarantee lives in prepareChatTurn (the shared turn builder) rather
// than in each entry point's boot sequence: anything that assembles a turn
// gets the skills, and there is nothing left to forget.
export function ensureSkillsLoaded(): Promise<void> {
  if (skillsMap.size > 0) return Promise.resolve();
  loadOnce ??= loadSkills();
  return loadOnce;
}

export function getSkill(name: string): Skill | undefined {
  return skillsMap.get(name);
}

export function getAllSkills(): Skill[] {
  return [...skillsMap.values()];
}

export interface SkillToolsOptions {
  /** When wired, load_skill also resolves agent-authored skills from Postgres. */
  learnedStore?: LearnedSkillStore | null;
  /** When wired, a successful load counts as "read" for skill_manage's guard. */
  runContext?: SkillRunContext;
  /** When wired, load_skill also resolves THIS user's own custom skills —
   * enabled ones only (a disabled skill is the user's way of hiding it
   * without deleting it, so it must not be reachable by name either).
   * Resolution order is curated -> user -> learned: a user skill can never
   * shadow a curated one (the name validator already refuses that collision
   * at create time), but it DOES shadow a learned skill of the same name. */
  userSkills?: { store: UserSkillStore; userId: string } | null;
}

export function getSkillTools(
  options: SkillToolsOptions = {},
): Record<string, unknown> {
  const { learnedStore, runContext, userSkills } = options;

  const load_skill = tool({
    description:
      "Load a skill's full instructions by name. Call this when the user's task matches a skill listed in the 'Available Skills' catalog in your system prompt. Returns the skill's instructions to follow for the current turn.",
    inputSchema: z.object({
      name: z
        .string()
        .describe("The exact skill name from the Available Skills catalog."),
    }),
    execute: async ({ name }: { name: string }) => {
      const skill = getSkill(name);
      if (skill) {
        runContext?.markRead(name);
        return { name: skill.name, instructions: skill.content };
      }

      if (userSkills) {
        // Checked before learnedStore: user wins over learned on a name tie
        // (curated already won above, unconditionally). Disabled rows are
        // deliberately excluded here too, not just from the catalog — an
        // enabled-only get would be simplest, but the store's `get` returns
        // regardless of `enabled` so this checks explicitly.
        const userSkill = await userSkills.store
          .get(userSkills.userId, name)
          .catch(() => null);
        if (userSkill && userSkill.enabled) {
          // Best-effort: a failed counter bump must not fail the load.
          await userSkills.store.bumpUse(userSkills.userId, name).catch(() => undefined);
          // Deliberately NOT runContext?.markRead(name) here. The run
          // context exists for skill_manage's read-before-write guard on
          // the agent's OWN learned-skill library (agent_skills) — a user
          // skill is a different document under the same shared name. User
          // skill names are validated only against curated skills/penTools
          // (checkUserSkillNameCollision), never against agent_skills, so a
          // user skill CAN shadow a learned one at this name (see the
          // resolution-order comment on SkillToolsOptions above — user wins
          // the tie here). If this load marked the name read, a later
          // skill_manage `delete` on the LEARNED skill of the same name
          // would pass the read-before-write guard using a read whose body
          // the agent never actually saw (delete only needs read +
          // absorbed_into, no body comparison) — unlocking a write to a
          // library entry this call never touched.
          return { name: userSkill.name, instructions: userSkill.body, custom: true };
        }
      }

      if (learnedStore) {
        // Curated first, always: a learned skill can never shadow a git-owned
        // one, and the name validator already refuses that collision anyway.
        const learned = await learnedStore.get(name).catch(() => null);
        // `stale` is deliberately resolvable here, not just `active` — that
        // is what makes the curator's stale period (src/ai/selfimprove/
        // curate.ts) a real grace window: bumpUse revives a stale row back
        // to `active` as part of the same write, so being loaded IS the way
        // a skill proves it's still wanted. `archived` stays excluded; there
        // is no load-time unarchive path (see reviveArchived in
        // learnedStore.ts for the one place archival is reversible).
        if (learned && (learned.state === "active" || learned.state === "stale")) {
          // Best-effort: a failed counter bump must not fail the load.
          await learnedStore.bumpUse(name).catch(() => undefined);
          runContext?.markRead(name);
          return { name: learned.name, instructions: learned.body, learned: true };
        }
      }

      const curatedNames = getAllSkills().map((s) => s.name);
      const userNames = userSkills
        ? (await userSkills.store.listEnabled(userSkills.userId).catch(() => [])).map(
            (s) => s.name,
          )
        : [];
      const learnedNames = learnedStore
        ? (await learnedStore.listActive().catch(() => [])).map((s) => s.name)
        : [];
      const available = [...curatedNames, ...userNames, ...learnedNames].join(", ");
      return {
        error: `Unknown skill "${name}". Available skills: ${available}`,
      };
    },
  });
  return { load_skill };
}

export function detectSkillCommand(
  text: string,
): { skillName: string; userText: string } | null {
  const match = text.match(/^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/);
  if (!match) return null;
  return { skillName: match[1], userText: match[2].trim() };
}
