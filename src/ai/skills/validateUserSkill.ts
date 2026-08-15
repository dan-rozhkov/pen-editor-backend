// Pure validation for user-authored skills. No DB, no config, no I/O — same
// contract as validate.ts (learned skills): each function returns null on
// success or an error string on failure. Unlike validate.ts these errors are
// USER-facing (surfaced by a route, not fed back to the model), but the
// "say what to do next" bar is the same.
import { parseFrontmatter } from "../skills.js";
import { checkNameCollision } from "./validate.js";

export const USER_SKILL_NAME_RE = /^[a-z][a-z0-9-]{1,48}$/;
export const MAX_DESCRIPTION_CHARS = 200;
export const MIN_BODY_CHARS = 1;
export const MAX_BODY_CHARS = 24_000;
export const MAX_SKILLS_PER_USER = 50;

export function validateUserSkillName(name: string): string | null {
  if (!name) {
    return "name is required.";
  }
  if (!USER_SKILL_NAME_RE.test(name)) {
    return `Skill name "${name}" must be lowercase letters, digits and hyphens, starting with a letter, 2-49 characters long.`;
  }
  return null;
}

export function validateUserSkillDescription(description: string): string | null {
  // description defaults to '' at the row level (DDL: NOT NULL DEFAULT ''),
  // so — unlike a learned skill's description — an empty one is allowed
  // here; only "too long" or "not a single line" is a real error.
  const trimmed = description.trim();
  if (trimmed.length > MAX_DESCRIPTION_CHARS) {
    return `description must be ${MAX_DESCRIPTION_CHARS} characters or fewer (got ${trimmed.length}).`;
  }
  if (/\r|\n/.test(trimmed)) {
    return "description must be a single line.";
  }
  return null;
}

export function validateUserSkillBody(body: string): string | null {
  if (!body || body.length < MIN_BODY_CHARS) {
    return "body is required: the skill's instructions in markdown.";
  }
  if (body.length > MAX_BODY_CHARS) {
    return `body must be ${MAX_BODY_CHARS} characters or fewer (got ${body.length}).`;
  }
  return null;
}

// Reuses learned skills' curated/penTools collision rule verbatim — a user
// skill may not shadow a curated one any more than a learned one may (the
// error message even points at the same git-owned path), and neither may
// shadow a tool name. What checkNameCollision does NOT check — a name
// already taken by this SAME user's OTHER user_skills row — is a 409 the
// store's unique constraint (UserSkillExistsError) reports instead; that's
// a per-user existence question this pure validator has no store access to
// answer.
export function checkUserSkillNameCollision(
  name: string,
  known: { curatedNames: string[]; toolNames: string[] },
): string | null {
  return checkNameCollision(name, known);
}

export function checkUserSkillCap(currentCount: number): string | null {
  if (currentCount >= MAX_SKILLS_PER_USER) {
    return `You already have ${MAX_SKILLS_PER_USER} skills, the maximum per user. Delete one before creating another.`;
  }
  return null;
}

export interface ParsedUserSkillMarkdown {
  name?: string;
  description?: string;
  body: string;
}

// Fills name/description from `--- ... ---` frontmatter when an uploaded
// .md has it (same shape src/skills/*.md curated files use — reusing
// parseFrontmatter from skills.ts keeps the two in lockstep rather than
// risking a second, slightly different parser). When frontmatter is absent
// entirely, the raw text IS the body and name/description fall through to
// whatever the caller supplied (e.g. a form field) — parseUserSkillMarkdown
// itself never rejects a missing name/description; that 400 is the route's
// job once it has both this parse result AND the caller-supplied fallbacks
// to check together.
export function parseUserSkillMarkdown(raw: string): ParsedUserSkillMarkdown {
  const fm = parseFrontmatter(raw);
  return { name: fm.name, description: fm.description, body: fm.body.trim() };
}
