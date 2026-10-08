// Snapshot v1: the wire shape of one published library version. Spec:
// pen-editor/docs/superpowers/specs/2026-10-08-ds-library-snapshot-v1.md.
// zod strips unknown keys, so what is stored (and hashed) is exactly this
// shape; integrity (ids, aliases, cycles, replacements) is checked on top.
import { z } from "zod";

export const SUPPORTED_SCHEMA_VERSION = 1;
export const THEME_COLLECTION_ID = "theme";
export const COMPONENT_KEY_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const MAX_README_BYTES = 20 * 1024;

const shortText = z.string().max(2000);
const id = z.string().min(1).max(128);

const deprecationSchema = z.object({
  since: z.string().max(32).optional(),
  replacedBy: id.optional(),
  note: shortText.optional(),
});

const modeValueSchema = z.union([z.string().max(2000), z.object({ alias: id })]);

const collectionSchema = z.object({
  id,
  name: z.string().min(1).max(200),
  modes: z.array(z.object({ id, name: z.string().min(1).max(200) })).min(1).max(50),
  defaultModeId: id,
});

const variableSchema = z.object({
  id,
  name: z.string().min(1).max(200),
  type: z.enum(["color", "number", "string"]),
  collectionId: id,
  valuesByMode: z.record(z.string(), modeValueSchema),
  description: shortText.optional(),
  scopes: z.array(z.string().max(40)).max(40).optional(),
  deprecated: deprecationSchema.optional(),
});

const componentSchema = z.object({
  key: z.string(),
  html: z.string().max(1_000_000),
  rev: z.string().max(128),
  meta: z.object({
    name: z.string().min(1).max(200),
    description: shortText.optional(),
    variants: z.record(z.string().max(80), z.array(z.string().max(80)).max(100)).optional(),
    status: z.enum(["draft", "stable", "deprecated"]).optional(),
    deprecated: deprecationSchema.optional(),
  }),
});

export const snapshotSchema = z.object({
  schemaVersion: z.number().int().min(1),
  collections: z.array(collectionSchema).max(200),
  variables: z.array(variableSchema).max(20_000),
  components: z.array(componentSchema).max(2_000),
  docs: z.object({ readme: z.string() }).optional(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type SnapshotVariable = Snapshot["variables"][number];
export type SnapshotCollection = Snapshot["collections"][number];
export type SnapshotComponent = Snapshot["components"][number];

export interface SnapshotIssue {
  path: string;
  message: string;
}

export type SnapshotValidation =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; code: "invalid_snapshot" | "unsupported_schema"; message: string; issues: SnapshotIssue[] };

const NUL = "\\u0000";

function fail(issues: SnapshotIssue[]): SnapshotValidation {
  return { ok: false, code: "invalid_snapshot", message: "The snapshot is not valid.", issues };
}

export function validateSnapshot(raw: unknown): SnapshotValidation {
  // Check the version before the full shape so a newer client gets the
  // actionable error rather than a pile of unknown-field complaints.
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version === "number" && version > SUPPORTED_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "unsupported_schema",
      message: `Snapshot schemaVersion ${version} is newer than this server supports (${SUPPORTED_SCHEMA_VERSION}).`,
      issues: [],
    };
  }
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const snapshot = parsed.data;
  if (snapshot.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    return fail([{ path: "schemaVersion", message: `schemaVersion must be ${SUPPORTED_SCHEMA_VERSION}` }]);
  }
  // jsonb refuses the NUL escape, which a text value can legitimately carry.
  if (JSON.stringify(snapshot).includes(NUL)) {
    return fail([{ path: "", message: "Strings may not contain U+0000." }]);
  }
  const issues = checkIntegrity(snapshot);
  return issues.length > 0 ? fail(issues.slice(0, 20)) : { ok: true, snapshot };
}

function checkIntegrity(s: Snapshot): SnapshotIssue[] {
  const issues: SnapshotIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (s.docs && Buffer.byteLength(s.docs.readme, "utf8") > MAX_README_BYTES) {
    add("docs.readme", "readme is larger than 20 KB");
  }

  const collections = new Map<string, SnapshotCollection>();
  s.collections.forEach((c, i) => {
    if (collections.has(c.id)) add(`collections.${i}.id`, `duplicate collection id "${c.id}"`);
    collections.set(c.id, c);
    const modeIds = new Set<string>();
    for (const m of c.modes) {
      if (modeIds.has(m.id)) add(`collections.${i}.modes`, `duplicate mode id "${m.id}"`);
      modeIds.add(m.id);
    }
    if (!modeIds.has(c.defaultModeId)) add(`collections.${i}.defaultModeId`, "defaultModeId is not one of the modes");
    if (c.id === THEME_COLLECTION_ID) {
      const ids = [...modeIds].sort().join(",");
      if (c.modes.length !== 2 || ids !== "dark,light") {
        add(`collections.${i}.modes`, 'the "theme" collection must have exactly the modes "light" and "dark"');
      }
    }
  });

  const variables = new Map<string, SnapshotVariable>();
  s.variables.forEach((v, i) => {
    if (variables.has(v.id)) add(`variables.${i}.id`, `duplicate variable id "${v.id}"`);
    variables.set(v.id, v);
  });

  s.variables.forEach((v, i) => {
    const collection = collections.get(v.collectionId);
    if (!collection) {
      add(`variables.${i}.collectionId`, `unknown collection "${v.collectionId}"`);
      return;
    }
    const modeIds = new Set(collection.modes.map((m) => m.id));
    for (const [modeId, value] of Object.entries(v.valuesByMode)) {
      if (!modeIds.has(modeId)) add(`variables.${i}.valuesByMode`, `unknown mode "${modeId}"`);
      if (typeof value !== "string") {
        const target = variables.get(value.alias);
        if (!target) add(`variables.${i}.valuesByMode.${modeId}`, `alias target "${value.alias}" does not exist`);
        else if (target.type !== v.type) {
          add(`variables.${i}.valuesByMode.${modeId}`, `alias target "${value.alias}" has type ${target.type}, expected ${v.type}`);
        }
      }
    }
    const replacedBy = v.deprecated?.replacedBy;
    if (replacedBy !== undefined) {
      if (replacedBy === v.id) add(`variables.${i}.deprecated.replacedBy`, "a variable cannot replace itself");
      else if (!variables.has(replacedBy)) add(`variables.${i}.deprecated.replacedBy`, `replacement "${replacedBy}" does not exist`);
    }
  });
  findAliasCycle(s.variables, add);

  const keys = new Set<string>();
  s.components.forEach((c, i) => {
    if (!COMPONENT_KEY_RE.test(c.key) || c.key === "slot") {
      add(`components.${i}.key`, `invalid component key "${c.key}"`);
    }
    if (keys.has(c.key)) add(`components.${i}.key`, `duplicate component key "${c.key}"`);
    keys.add(c.key);
  });
  s.components.forEach((c, i) => {
    const replacedBy = c.meta.deprecated?.replacedBy;
    if (replacedBy === undefined) return;
    if (replacedBy === c.key) add(`components.${i}.meta.deprecated.replacedBy`, "a component cannot replace itself");
    else if (!keys.has(replacedBy)) add(`components.${i}.meta.deprecated.replacedBy`, `replacement "${replacedBy}" does not exist`);
  });
  return issues;
}

function findAliasCycle(variables: SnapshotVariable[], add: (path: string, message: string) => void): void {
  const edges = new Map<string, string[]>();
  for (const v of variables) {
    edges.set(
      v.id,
      Object.values(v.valuesByMode).flatMap((value) => (typeof value === "string" ? [] : [value.alias])),
    );
  }
  const state = new Map<string, 1 | 2>(); // 1 = on the stack, 2 = done
  const visit = (start: string): string | null => {
    const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    state.set(start, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const out = edges.get(top.node) ?? [];
      if (top.next >= out.length) {
        state.set(top.node, 2);
        stack.pop();
        continue;
      }
      const to = out[top.next++];
      if (!edges.has(to)) continue;
      const seen = state.get(to);
      if (seen === 1) return to;
      if (seen === undefined) {
        state.set(to, 1);
        stack.push({ node: to, next: 0 });
      }
    }
    return null;
  };
  for (const v of variables) {
    if (state.has(v.id)) continue;
    const hit = visit(v.id);
    if (hit) {
      add("variables", `alias cycle through "${hit}"`);
      return;
    }
  }
}
