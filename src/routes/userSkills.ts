// Figma-style "your own skills" CRUD + upload + AI-assisted draft generation,
// scoped by the same anonymous, shape-checked `userId` as /api/memory/activity
// — never authenticated, same trust model as agent_memory. This route owns
// no store lifecycle (app.ts's onClose hook already closes the shared
// UserSkillStore); it only turns HTTP requests into store calls.
import type { FastifyInstance } from "fastify";
import { generateObject } from "ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { createModel } from "../ai/provider.js";
import { ensureSkillsLoaded, getAllSkills } from "../ai/skills.js";
import { penTools } from "../ai/tools.js";
import { isPlausibleUserId } from "../lib/userId.js";
import {
  UserSkillExistsError,
  type UserSkill,
  type UserSkillStore,
} from "../ai/skills/userStore.js";
import { invalidateUserSkillCatalog } from "../ai/skills/userSkillCatalog.js";
import {
  checkUserSkillCap,
  checkUserSkillNameCollision,
  parseUserSkillMarkdown,
  validateUserSkillBody,
  validateUserSkillDescription,
  validateUserSkillName,
} from "../ai/skills/validateUserSkill.js";

// Same 1..64 bound as chat.ts's userId field, but — like GET /api/memory/activity,
// not chat.ts — a shape-invalid value here is a hard 400, not silently downgraded
// to "no user": this route reads and writes a per-user skill library, so a
// colliding low-entropy id (e.g. two callers both sending "test") is exactly
// the leak isPlausibleUserId exists to reject outright.
const userIdSchema = z.string().min(1).max(64).refine(isPlausibleUserId);

const listQuerySchema = z.object({ userId: userIdSchema });

const nameParamSchema = z.object({ name: z.string().min(1).max(100) });

// `name`/`description` are optional here: an uploaded raw .md's frontmatter
// (parseUserSkillMarkdown) can supply either, and the two are merged before
// validateUserSkillName/Description ever run. `body` is always required —
// for a plain create it's the markdown instructions; for an upload it's the
// whole .md file (frontmatter included) and parseUserSkillMarkdown splits it.
// The upper bound here is a coarse DoS guard only; the precise, user-facing
// 24000-char rule lives in validateUserSkillBody so its error message names
// the exact limit.
const createBodySchema = z.object({
  userId: userIdSchema,
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  body: z.string().min(1).max(100_000),
  source: z.enum(["manual", "upload", "generated"]).optional(),
});

const patchBodySchema = z.object({
  userId: userIdSchema,
  newName: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  body: z.string().min(1).max(100_000).optional(),
  enabled: z.boolean().optional(),
});

const deleteQuerySchema = z.object({ userId: userIdSchema });

// Cap enforced directly in the schema (not just validateUserSkillBody-style,
// since there is no equivalent business-rule function for prompts) — the
// spec's "cap prompt at 2000 chars" is a hard 400, not a truncation.
const generateBodySchema = z.object({
  userId: userIdSchema,
  prompt: z.string().min(1).max(2000),
});

const generateResultSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
});

interface PublicUserSkill {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  source: UserSkill["source"];
  useCount: number;
  updatedAt: Date;
}

function toPublic(skill: UserSkill): PublicUserSkill {
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    enabled: skill.enabled,
    source: skill.source,
    useCount: skill.useCount,
    updatedAt: skill.updatedAt,
  };
}

// The same curated-skill/penTools collision set skill_manage's checkNameCollision
// already enforces for learned skills — a user skill may not shadow either any
// more than a learned one may (see validateUserSkill.ts's checkUserSkillNameCollision
// doc). Recomputed per-call rather than cached: getAllSkills()/penTools are both
// cheap, in-memory, and this is nowhere near a hot path.
//
// Must await ensureSkillsLoaded() first: unlike /api/chat, this route is not
// guaranteed to run after a chat turn has ever populated the in-memory skills
// map (loadSkills is otherwise only triggered by prepareChatTurn). A process
// that receives a create/patch before its first chat turn would otherwise see
// ZERO curated names here and let a user skill claim a name — e.g.
// "prototype" — that a curated skill already owns, permanently unreachable
// once curated skills load later, since curated always wins the tie (see the
// long comment on ensureSkillsLoaded in ai/skills.ts).
async function knownNames(): Promise<{ curatedNames: string[]; toolNames: string[] }> {
  await ensureSkillsLoaded();
  return {
    curatedNames: getAllSkills().map((s) => s.name),
    toolNames: Object.keys(penTools),
  };
}

const GENERATE_SYSTEM_PROMPT = `You write custom skills for an AI design agent, in the same style as Anthropic's Agent Skills: a short, procedural markdown document that tells the agent HOW to do a class of task, not a one-off narrative about a single session.

Given a short description of a workflow, produce:
- name: lowercase-kebab-case, 2-49 characters, starting with a letter (letters, digits, hyphens only) — a short slug for the skill.
- description: one line, under 200 characters, saying WHEN this skill applies (not what it does).
- body: markdown instructions for the agent, written as an imperative procedure — steps, conventions, gotchas to avoid. Keep it class-level: strip session-specific narrative (dates, one-off ids, "the user said X") and keep only what would help on any future task of this kind.`;

export async function userSkillRoutes(
  app: FastifyInstance,
  config: Config,
  store: UserSkillStore | null,
): Promise<void> {
  app.get("/api/user-skills", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid or missing userId" });
    }
    // No store configured (no TRACE_DATABASE_URL) is a real, supported
    // deployment shape — never a 5xx for a read; the client just sees an
    // empty, unavailable feature, same stance as GET /api/memory/activity.
    if (!store) {
      return reply.send({ skills: [], available: false });
    }
    try {
      const skills = await store.list(parsed.data.userId);
      return reply.send({ skills: skills.map(toPublic), available: true });
    } catch (err) {
      app.log.error({ err }, "[user-skills] list failed");
      return reply.status(500).send({ error: "Failed to load skills." });
    }
  });

  app.post("/api/user-skills", async (request, reply) => {
    const parsed = createBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? "Invalid request body",
      });
    }
    if (!store) {
      return reply.status(503).send({ error: "User skills are not available." });
    }

    const { userId, source = "manual" } = parsed.data;

    // Frontmatter (if present) fills in whatever the caller didn't supply
    // directly, and always supplies the actual body-after-frontmatter — a
    // plain (non-uploaded) create still round-trips fine here since
    // parseUserSkillMarkdown on a frontmatter-less string just returns the
    // whole text as `body`.
    const parsedMd = parseUserSkillMarkdown(parsed.data.body);
    const name = parsed.data.name ?? parsedMd.name;
    const description = parsed.data.description ?? parsedMd.description ?? "";
    const body = parsedMd.body;

    if (!name) {
      return reply.status(400).send({
        error: "name is required (supply it directly, or via '---\\nname: ...\\n---' frontmatter).",
      });
    }

    // Trim BEFORE validating and storing — not just before validating. The
    // description validator used to test description.trim() but the route
    // stored the untrimmed value, so e.g. "Applies to X\n" passed the
    // single-line check yet still broke renderSkillCatalog's
    // `- \`name\` — ${description}` list-item line in the cached system
    // prompt, and untrimmed whitespace could push the stored value past
    // MAX_DESCRIPTION_CHARS even though the trimmed form validated fine.
    // Same slip applies to `name`, which is user-suppliable directly (not
    // just via frontmatter) and only ever regex-checked, never trimmed.
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();

    const nameErr = validateUserSkillName(trimmedName);
    if (nameErr) return reply.status(400).send({ error: nameErr });
    const descriptionErr = validateUserSkillDescription(trimmedDescription);
    if (descriptionErr) return reply.status(400).send({ error: descriptionErr });
    const bodyErr = validateUserSkillBody(body);
    if (bodyErr) return reply.status(400).send({ error: bodyErr });
    const collision = checkUserSkillNameCollision(trimmedName, await knownNames());
    if (collision) return reply.status(400).send({ error: collision });

    try {
      // count()-then-create() is a benign TOCTOU race: two concurrent
      // creates for the same user can both read a count under the cap and
      // both insert, letting a user briefly exceed MAX_SKILLS_PER_USER by
      // one or two rows. Not worth a transaction/advisory lock for — the
      // blast radius is bounded by MAX_USER_SKILLS_IN_PROMPT (chatTurn.ts),
      // which truncates the catalog rendered into the system prompt
      // regardless of how many rows actually exist, so an over-cap user
      // just can't see/use the overflow, not a correctness or security bug.
      const count = await store.count(userId);
      const capErr = checkUserSkillCap(count);
      if (capErr) return reply.status(400).send({ error: capErr });
    } catch (err) {
      app.log.error({ err }, "[user-skills] count failed");
      return reply.status(500).send({ error: "Failed to create skill." });
    }

    try {
      const skill = await store.create({
        userId,
        name: trimmedName,
        description: trimmedDescription,
        body,
        source,
      });
      // Invalidate BEFORE responding: otherwise a client that immediately
      // starts a chat turn after a 201 could still read the stale (pre-write)
      // cached catalog for up to CATALOG_TTL_MS, showing the just-created
      // skill as absent from `(custom)` even though the API already
      // confirmed it exists.
      invalidateUserSkillCatalog(store, userId);
      return reply.status(201).send({ skill: toPublic(skill) });
    } catch (err) {
      if (err instanceof UserSkillExistsError) {
        return reply.status(409).send({ error: err.message });
      }
      app.log.error({ err }, "[user-skills] create failed");
      return reply.status(500).send({ error: "Failed to create skill." });
    }
  });

  app.patch("/api/user-skills/:name", async (request, reply) => {
    const params = nameParamSchema.safeParse(request.params);
    const parsed = patchBodySchema.safeParse(request.body);
    if (!params.success || !parsed.success) {
      return reply.status(400).send({
        error: parsed.success
          ? "Invalid request"
          : (parsed.error.issues[0]?.message ?? "Invalid request body"),
      });
    }
    if (!store) {
      return reply.status(503).send({ error: "User skills are not available." });
    }

    const { userId, newName: rawNewName, description: rawDescription, body, enabled } = parsed.data;
    // Same trim-before-validate-and-store rule as POST above: neither field
    // is trimmed by the schema, and validateUserSkillDescription only tested
    // the trimmed form while the untrimmed value used to reach the store.
    const newName = rawNewName !== undefined ? rawNewName.trim() : undefined;
    const description = rawDescription !== undefined ? rawDescription.trim() : undefined;

    if (newName !== undefined) {
      const nameErr = validateUserSkillName(newName);
      if (nameErr) return reply.status(400).send({ error: nameErr });
      const collision = checkUserSkillNameCollision(newName, await knownNames());
      if (collision) return reply.status(400).send({ error: collision });
    }
    if (description !== undefined) {
      const descriptionErr = validateUserSkillDescription(description);
      if (descriptionErr) return reply.status(400).send({ error: descriptionErr });
    }
    if (body !== undefined) {
      const bodyErr = validateUserSkillBody(body);
      if (bodyErr) return reply.status(400).send({ error: bodyErr });
    }

    try {
      const updated = await store.update(userId, params.data.name, {
        newName,
        description,
        body,
        enabled,
      });
      if (!updated) {
        return reply.status(404).send({ error: "Skill not found." });
      }
      // The catalog cache is keyed by userId, not by skill name (see
      // userSkillCatalog.ts), so one call clears this user's whole cached
      // list — covering a rename, a disable, a description/body edit, all
      // alike. Without it a disabled/renamed skill keeps being advertised
      // in the system prompt for up to CATALOG_TTL_MS even though
      // load_skill already answers "Unknown skill" for it.
      invalidateUserSkillCatalog(store, userId);
      return reply.send({ skill: toPublic(updated) });
    } catch (err) {
      if (err instanceof UserSkillExistsError) {
        return reply.status(409).send({ error: err.message });
      }
      app.log.error({ err }, "[user-skills] update failed");
      return reply.status(500).send({ error: "Failed to update skill." });
    }
  });

  app.delete("/api/user-skills/:name", async (request, reply) => {
    const params = nameParamSchema.safeParse(request.params);
    const query = deleteQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.status(400).send({ error: "Invalid or missing userId" });
    }
    if (!store) {
      return reply.status(503).send({ error: "User skills are not available." });
    }
    try {
      const deleted = await store.remove(query.data.userId, params.data.name);
      if (!deleted) {
        return reply.status(404).send({ error: "Skill not found." });
      }
      // Same reasoning as the POST/PATCH handlers above: without this a
      // deleted skill keeps appearing in the system prompt's catalog for up
      // to CATALOG_TTL_MS after the API already reports it gone.
      invalidateUserSkillCatalog(store, query.data.userId);
      return reply.send({ deleted: true });
    } catch (err) {
      app.log.error({ err }, "[user-skills] delete failed");
      return reply.status(500).send({ error: "Failed to delete skill." });
    }
  });

  app.post("/api/user-skills/generate", async (request, reply) => {
    const parsed = generateBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? "Invalid request body",
      });
    }
    // Draft generation never persists (the client reviews then POSTs
    // separately), so it needs no store at all — but userId is still
    // required and shape-checked, per this route family's blanket rule.
    try {
      const { object } = await generateObject({
        model: createModel(config),
        schema: generateResultSchema,
        system: GENERATE_SYSTEM_PROMPT,
        prompt: parsed.data.prompt,
      });
      return reply.send({ draft: object });
    } catch (err) {
      app.log.error({ err }, "[user-skills] generate failed");
      return reply.status(502).send({ error: "Failed to generate a skill draft." });
    }
  });
}
