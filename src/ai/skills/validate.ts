// Pure validation for self-authored skills. No DB, no config, no I/O: every
// rule the spec locks is checkable from strings alone, and keeping them here
// means the tool layer (Task 7's skill_manage) is only wiring. Each function
// returns null on success or a MODEL-FACING error string on failure — the
// tool returns these verbatim to the LLM, so they must say what to do next,
// not just what went wrong.

export const SKILL_NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const MAX_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 60;
export const MAX_BODY_LINES = 200;

export function validateSkillName(name: string): string | null {
  // Length check first: a name that's merely too long still needs a length-shaped
  // error rather than being lumped in with the regex's generic kebab-case message.
  if (!name || name.length > MAX_NAME_CHARS) {
    return `Skill name must be 1-64 characters (got ${name?.length ?? 0}).`;
  }
  if (!SKILL_NAME_RE.test(name)) {
    return `Skill name "${name}" must be kebab-case: lowercase letters and digits separated by single hyphens, starting with a letter (e.g. "reading-canvas-state").`;
  }
  return null;
}

export function validateDescription(description: string): string | null {
  if (!description || !description.trim()) {
    return "description is required: one line saying when this skill applies.";
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return `description must be ${MAX_DESCRIPTION_CHARS} characters or fewer (got ${description.length}). It is a catalog line, not the skill.`;
  }
  return null;
}

export function validateBody(body: string): string | null {
  if (!body || !body.trim()) {
    return "body is required: the skill's instructions in markdown, without frontmatter.";
  }
  const lines = body.split("\n").length;
  if (lines > MAX_BODY_LINES) {
    return `body must be ${MAX_BODY_LINES} lines or fewer (got ${lines}). Keep the skill class-level: cut the session narrative, keep the procedure.`;
  }
  return null;
}

export function checkNameCollision(
  name: string,
  known: { curatedNames: string[]; toolNames: string[] },
): string | null {
  if (known.curatedNames.includes(name)) {
    return `"${name}" is a curated skill. Curated skills are git-owned files (src/skills/${name}.md) and are read-only to this tool — they can only be changed by a human in git. Pick a different name, or put the lesson in a learned skill of your own.`;
  }
  if (known.toolNames.includes(name)) {
    return `"${name}" is the name of a tool you can call. A skill may not shadow a tool name — pick a different name.`;
  }
  return null;
}

// Exact-substring patch, deliberately the same contract as a code editor's
// str_replace: the old text must occur EXACTLY once. Zero matches means the
// model is patching a body it did not actually read; several matches mean the
// edit is ambiguous and could land in the wrong section.
export function applyPatch(
  body: string,
  oldString: string,
  newString: string,
): { body: string } | { error: string } {
  if (oldString === "") {
    return { error: "old_string must not be empty. Copy the exact text to replace out of the skill body." };
  }
  const first = body.indexOf(oldString);
  if (first === -1) {
    return {
      error:
        "old_string was not found in the skill body. View the skill again with skill_view and copy the exact text, including whitespace.",
    };
  }
  // Scan from first + 1, not first + oldString.length: a second occurrence
  // can OVERLAP the first (e.g. body "aaa", oldString "aa" — the second "aa"
  // starts at index 1, inside the first match) and starting the scan past
  // the whole first match would walk right over it, letting an ambiguous
  // patch through as if old_string were unique. "occurs exactly once"
  // has to mean every possible start position, overlapping or not.
  const second = body.indexOf(oldString, first + 1);
  if (second !== -1) {
    return {
      error:
        "old_string occurs more than once in the skill body. Include more surrounding lines so the match is unique.",
    };
  }
  return { body: body.slice(0, first) + newString + body.slice(first + oldString.length) };
}
