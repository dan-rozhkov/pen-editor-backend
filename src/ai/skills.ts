import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  // Always read from src/skills regardless of whether we run via tsx or compiled dist/
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  const projectRoot = join(thisDir, "../..");
  const dir = join(projectRoot, "src/skills");
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

export function getSkill(name: string): Skill | undefined {
  return skillsMap.get(name);
}

export function getAllSkills(): Skill[] {
  return [...skillsMap.values()];
}

export function detectSkillCommand(
  text: string,
): { skillName: string; userText: string } | null {
  const match = text.match(/^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/);
  if (!match) return null;
  return { skillName: match[1], userText: match[2].trim() };
}
