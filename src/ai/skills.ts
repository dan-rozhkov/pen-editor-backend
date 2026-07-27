import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tool } from "ai";
import { z } from "zod";

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

interface Frontmatter {
  name?: string;
  description?: string;
  args: SkillArg[];
  body: string;
}

function parseFrontmatter(raw: string): Frontmatter {
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

export function getSkillTools(): Record<string, unknown> {
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
      if (!skill) {
        const available = getAllSkills()
          .map((s) => s.name)
          .join(", ");
        return {
          error: `Unknown skill "${name}". Available skills: ${available}`,
        };
      }
      return { name: skill.name, instructions: skill.content };
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
