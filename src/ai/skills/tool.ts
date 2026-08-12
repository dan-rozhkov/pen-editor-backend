// Turn-time, backend-executed tools for the agent's own skill library.
// `skill_view` (Task 6) is read-only and exists mainly for the background
// review run — a normal design turn reads a skill via `load_skill`, which
// already satisfies skill_manage's read-before-write guard. `skill_manage`
// (Task 7) is the only write path for `agent_skills`: create / patch /
// delete, each behind the curated-skill guard, the read-before-write guard,
// and the pure validators from validate.ts. Both are injected the same way
// `load_skill` is (getSkillTools()), so they are NOT `penTools` and never
// touch the cross-repo tool contract.
import { tool } from "ai";
import { z } from "zod";
import type { TraceQueryable } from "../../tracing/traceStore.js";
import { insertAuditRow, type AuditEntry, type AuditOrigin } from "../memory/store.js";
import { penTools } from "../tools.js";
import { getAllSkills, getSkill } from "../skills.js";
import { invalidateLearnedCatalog, type LearnedSkillStore } from "./learnedStore.js";
import type { SkillRunContext } from "./runContext.js";
import {
  applyPatch,
  checkNameCollision,
  validateBody,
  validateDescription,
  validateSkillName,
} from "./validate.js";

export interface SelfSkillToolDeps {
  store: LearnedSkillStore;
  runContext: SkillRunContext;
  db: TraceQueryable;
  userId: string;
  origin: AuditOrigin;
  /** skill_view exists for the background review run; a normal design turn
   *  reads skills through load_skill, which already satisfies the guard. */
  includeView: boolean;
}

interface ManageArgs {
  action: "create" | "patch" | "delete";
  name: string;
  description?: string;
  body?: string;
  old_string?: string;
  new_string?: string;
  absorbed_into?: string;
}

export function getSelfSkillTools(
  deps: SelfSkillToolDeps,
): Record<string, unknown> {
  const { store, runContext, db, userId, origin } = deps;

  const skill_view = tool({
    description:
      "Read a skill in full — its description and body — without loading it as instructions for the current turn. Use this before patching or deleting a skill: you may only edit a skill you have actually read in this run. Curated skills can be viewed but never edited.",
    inputSchema: z.object({
      name: z.string().describe("Exact skill name, curated or learned."),
    }),
    execute: async ({ name }: { name: string }) => {
      const curated = getSkill(name);
      if (curated) {
        runContext.markRead(name);
        return {
          name: curated.name,
          description: curated.description,
          body: curated.content,
          learned: false,
          editable: false,
        };
      }

      const learned = await store.get(name).catch(() => null);
      if (learned) {
        await store.bumpView(name).catch(() => undefined);
        runContext.markRead(name);
        return {
          name: learned.name,
          description: learned.description,
          body: learned.body,
          learned: true,
          // skill_manage's provenance guard only ever patches/deletes rows
          // with created_by === 'agent' (a human-seeded or hand-edited row
          // is immune, see the guard's own comment) — this field must agree
          // with that so the model doesn't attempt a write skill_manage will
          // just reject.
          editable: learned.createdBy === "agent",
          state: learned.state,
          useCount: learned.useCount,
        };
      }

      const available = [
        ...getAllSkills().map((s) => s.name),
        ...(await store.listActive().catch(() => [])).map((s) => s.name),
      ].join(", ");
      return { error: `Unknown skill "${name}". Skills that exist: ${available}` };
    },
  });

  // Audit is observability, not the write itself: an audit failure must
  // never turn a landed skill change into a reported error, or the model
  // retries a write that already succeeded (see "failure isolation" tests).
  const audit = async (action: string, payload: Record<string, unknown>) => {
    const entry: AuditEntry = { userId, origin, subsystem: "skill", action, payload };
    try {
      await insertAuditRow(db, entry);
    } catch (err) {
      console.error("[selfskills] audit write failed:", (err as Error).message);
    }
  };

  // Turns a thrown store error into a MODEL-FACING string instead of letting
  // it propagate out of `execute` — a temporary Postgres blip (or a
  // saturated pool, see the connectionTimeoutMillis fix on auditDb.ts)
  // otherwise surfaces to the user as a hard tool error mid design-turn,
  // which load_skill/skill_view already avoid (both catch their own store
  // calls) but skill_manage previously did not.
  function storeErrorMessage(err: unknown, doingWhat: string): string {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[selfskills] ${doingWhat} failed:`, message);
    // replaceBody's own thrown Error ("... no longer exists — deleted
    // concurrently") is already a clear, actionable, model-facing
    // explanation (see its doc comment in learnedStore.ts) — surface it
    // verbatim instead of masking it behind a generic wrapper. Anything
    // else (connection refused, a raw Postgres error string, ...) becomes a
    // generic transient-error message so an internal error never reaches
    // the model dressed up as guidance about what to do next.
    if (message.includes("no longer exists")) return message;
    return `A database error occurred while ${doingWhat}. This is likely transient — try again, or move on and mention it if it keeps happening.`;
  }

  const curatedGuard = (name: string): string | null =>
    getSkill(name)
      ? `"${name}" is a curated skill. Curated skills are git-owned files (src/skills/${name}.md) and are read-only to this tool — a human edits them in git. If the lesson belongs somewhere, put it in a learned skill.`
      : null;

  const readGuard = (name: string): string | null =>
    runContext.hasRead(name)
      ? null
      : `You have not read "${name}" in this run. Call skill_view with name "${name}" first, then patch or delete it — editing a skill you have not actually read overwrites work you cannot see.`;

  const skill_manage = tool({
    description:
      "Create, patch or delete a skill you wrote yourself. Prefer patching an existing skill over creating a new one; skills should be class-level (a kind of task), never a record of one session. Curated skills cannot be changed here. You must skill_view (or load_skill) a skill in this run before patching or deleting it.",
    inputSchema: z.object({
      action: z
        .enum(["create", "patch", "delete"])
        .describe("create a new skill, patch an existing one, or delete one."),
      name: z.string().describe('Skill name, kebab-case (e.g. "reading-canvas-state").'),
      description: z
        .string()
        .optional()
        .describe("create only. One catalog line, 60 characters or fewer."),
      body: z
        .string()
        .optional()
        .describe("create only. Markdown instructions, 200 lines or fewer, no frontmatter."),
      old_string: z
        .string()
        .optional()
        .describe("patch only. Exact text to replace; must occur exactly once in the body."),
      new_string: z.string().optional().describe("patch only. Replacement text."),
      absorbed_into: z
        .string()
        .optional()
        .describe(
          "delete only, required. Name of the skill that now covers this one, or an empty string when you are simply pruning it.",
        ),
    }),
    execute: async (args: ManageArgs) => {
      const { action, name } = args;

      if (action === "create") {
        const nameError = validateSkillName(name);
        if (nameError) return { error: nameError };

        const collision = checkNameCollision(name, {
          curatedNames: getAllSkills().map((s) => s.name),
          toolNames: Object.keys(penTools),
        });
        if (collision) return { error: collision };

        const description = args.description ?? "";
        const descriptionError = validateDescription(description);
        if (descriptionError) return { error: descriptionError };

        const body = args.body ?? "";
        const bodyError = validateBody(body);
        if (bodyError) return { error: bodyError };

        let existing;
        try {
          existing = await store.get(name);
        } catch (err) {
          return { error: storeErrorMessage(err, `checking whether "${name}" already exists`) };
        }
        if (existing) {
          // `name` is a primary key and an archived row is never deleted
          // (src/ai/selfimprove/curate.ts), so a plain `create` on an
          // archived name would otherwise dead-end forever: the pre-check
          // below says "use patch", but `patch` only ever rewrites `body`
          // (replaceBody) and can't touch `state` — the skill would stay
          // invisible to both the catalog and load_skill no matter how many
          // times it's "successfully" patched. Reviving is the fix, not a
          // better error message: overwrite the archived row's content and
          // bring it back to `active`, same as a fresh create would have
          // produced, but at the name that was already claimed. Restricted
          // to rows created_by === 'agent' for the same reason patch/delete
          // are (see the provenance guard below in this file) — this tool
          // never overwrites a human-seeded row, archived or not.
          if (existing.state === "archived" && existing.createdBy === "agent" && store.reviveArchived) {
            let revived: boolean;
            try {
              revived = await store.reviveArchived(name, { description, body });
            } catch (err) {
              return { error: storeErrorMessage(err, `reviving archived skill "${name}"`) };
            }
            if (revived) {
              invalidateLearnedCatalog();
              await audit("revive", { name, description, bodyLines: body.split("\n").length });
              return {
                ok: true,
                message: `Revived archived skill "${name}" with new content. It will appear in your skills catalog marked (learned) on the next turn.`,
              };
            }
            // Raced: the row moved again (e.g. concurrently un-archived,
            // patched, or deleted) between the `get` above and this write —
            // fall through to the generic already-exists error below rather
            // than claiming a revival that didn't happen.
          }
          return {
            error:
              existing.state === "archived" && existing.createdBy !== "agent"
                ? `A learned skill named "${name}" already exists but is archived and not owned by the agent (created_by = "${existing.createdBy}"). It cannot be revived here — pick a different name.`
                : `A learned skill named "${name}" already exists. Use action "patch" to change it — do not replace a skill wholesale.`,
          };
        }

        try {
          await store.create({ name, description, body });
        } catch (err) {
          // No ON CONFLICT in LearnedSkillStore.create (deliberate — see its
          // own comment): a unique_violation here (Postgres error code
          // 23505) means the pre-check above raced with another writer that
          // won. Report it with the same "already exists, use patch"
          // guidance the pre-check gives, not a raw constraint-violation
          // string the model can't act on.
          if ((err as { code?: string }).code === "23505") {
            return {
              error: `A learned skill named "${name}" already exists (created concurrently by another writer). Use action "patch" to change it instead.`,
            };
          }
          return { error: storeErrorMessage(err, `creating "${name}"`) };
        }
        invalidateLearnedCatalog();
        await audit("create", { name, description, bodyLines: body.split("\n").length });
        return {
          ok: true,
          message: `Created skill "${name}". It will appear in your skills catalog marked (learned) on the next turn.`,
        };
      }

      let existing;
      try {
        existing = await store.get(name);
      } catch (err) {
        return { error: storeErrorMessage(err, `looking up "${name}"`) };
      }

      if (!existing) {
        // No learned row at this name: any write here genuinely targets a
        // curated FILE (if one exists) rather than a stale DB row, so the
        // guard belongs here unconditionally. Contrast with the patch
        // branch below, which re-checks this only for a row that DOES
        // exist and happens to share a name with a curated file added
        // later — see that branch's comment.
        const curatedError = curatedGuard(name);
        if (curatedError) return { error: curatedError };

        let available: string;
        try {
          available = (await store.listActive()).map((s) => s.name).join(", ");
        } catch (err) {
          console.error("[selfskills] listActive failed while building an error message:", (err as Error).message);
          available = "(unable to list learned skills — database error)";
        }
        return {
          error: `No learned skill named "${name}". Learned skills: ${available || "(none yet)"}.`,
        };
      }

      // Provenance guard: the autonomous review run only ever wrote rows
      // with created_by = 'agent' (LearnedSkillStore.create hardcodes it),
      // so a row with any other value did not come from this loop — it was
      // seeded or hand-authored by a human directly in Postgres. The spec's
      // "the autonomous reviewer edits only created_by = 'agent' skills" is
      // enforced here rather than trusted to callers, so it holds for every
      // origin (foreground, background_review, curator) that reaches this
      // tool, not just the review run.
      if (existing.createdBy !== "agent") {
        return {
          error: `"${name}" was not created by the agent (created_by = "${existing.createdBy}"). This tool only patches or deletes skills it authored itself.`,
        };
      }

      const readError = readGuard(name);
      if (readError) return { error: readError };

      if (action === "patch") {
        // A learned row exists at this name. If a curated file has SINCE
        // claimed the same name (checkNameCollision only guards create
        // time, so this can happen), patching the row writes content
        // nobody will ever read again — load_skill and the prompt catalog
        // both resolve a name collision to the curated file (see
        // chatTurn.ts's dedup), never the shadowed learned row. Block it
        // the same way a fresh create under that name would be blocked.
        // DELETE below is deliberately exempt from this same check: it
        // only removes a Postgres row, never touches the git-owned
        // curated file, and removing dead weight is exactly the cleanup
        // this collision calls for.
        const curatedError = curatedGuard(name);
        if (curatedError) return { error: curatedError };

        if (args.old_string === undefined || args.new_string === undefined) {
          return { error: "patch requires both old_string and new_string." };
        }
        const patched = applyPatch(existing.body, args.old_string, args.new_string);
        if ("error" in patched) return { error: patched.error };

        const bodyError = validateBody(patched.body);
        if (bodyError) return { error: bodyError };

        try {
          await store.replaceBody(name, patched.body);
        } catch (err) {
          return { error: storeErrorMessage(err, `patching "${name}"`) };
        }
        invalidateLearnedCatalog();
        await audit("patch", {
          name,
          oldString: args.old_string,
          newString: args.new_string,
          bodyLines: patched.body.split("\n").length,
        });
        return { ok: true, message: `Patched skill "${name}".` };
      }

      // action === "delete" — no curatedGuard call here; see the patch
      // branch's comment for why delete is exempt from it.
      const absorbedInto = args.absorbed_into;
      if (absorbedInto === undefined) {
        return {
          error:
            'delete requires absorbed_into: the name of the skill that now covers this one, or an empty string ("") if you are simply pruning it. Deleting knowledge without saying where it went is how a library loses things silently.',
        };
      }
      if (absorbedInto !== "") {
        let target: unknown = getSkill(absorbedInto);
        if (!target) {
          try {
            target = await store.get(absorbedInto);
          } catch (err) {
            return {
              error: storeErrorMessage(err, `looking up absorbed_into target "${absorbedInto}"`),
            };
          }
        }
        if (!target) {
          return {
            error: `absorbed_into names "${absorbedInto}", which is not an existing skill. Name the skill that actually covers this material, or pass "" to prune.`,
          };
        }
      }

      let removed: boolean;
      try {
        removed = await store.remove(name);
      } catch (err) {
        return { error: storeErrorMessage(err, `deleting "${name}"`) };
      }
      if (!removed) {
        // Mirrors replaceBody's own "no longer exists" guard (see
        // learnedStore.ts): between the `existing` lookup above and this
        // DELETE, the row was removed by another writer (a concurrent
        // foreground call, another background review run). Report it
        // rather than claiming success for a delete that did nothing.
        return {
          error: `Could not delete "${name}": it no longer exists — it may have already been deleted by a concurrent call.`,
        };
      }
      invalidateLearnedCatalog();
      await audit("delete", { name, absorbedInto });
      return {
        ok: true,
        message: absorbedInto
          ? `Deleted skill "${name}" (absorbed into "${absorbedInto}").`
          : `Deleted skill "${name}" (pruned).`,
      };
    },
  });

  const tools: Record<string, unknown> = { skill_manage };
  if (deps.includeView) tools.skill_view = skill_view;
  return tools;
}
