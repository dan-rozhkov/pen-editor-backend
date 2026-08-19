import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";
import { scrubPii } from "./pii.js";

export type ScenarioKind = "correction" | "error" | "preference" | "workflow";

/** One L1 fact, tagged with the session it came from — the unit of grouping.
 * Sessions are the unit of CONFIRMATION (see confirmationsOf), atoms are the
 * unit of evidence; conflating them is how one angry conversation would fake
 * a "recurring" pattern. */
export interface ScenarioAtom {
  sessionId: string;
  kind: ScenarioKind;
  text: string;
}

export interface InsightRowForScenarios {
  session_id: string;
  user_id: string | null;
  errors: Array<{ tool?: string; error?: string; recovered?: boolean }>;
  corrections: Array<{ what_agent_did?: string; what_user_wanted?: string; agent_complied?: boolean }>;
  memory_requests: Array<{ quote?: string; honored?: boolean }>;
}

export interface ScenarioBucket {
  scope: "user" | "global";
  userId: string | null;
  atoms: ScenarioAtom[];
  /** Atoms dropped by the MAX_ATOMS_PER_BUCKET cap (the LEAST recent ones —
   * see run.ts's ORDER BY). 0 when the bucket fit under the cap. Callers
   * must log this, not swallow it — see MAX_ATOMS_PER_BUCKET's comment. */
  truncatedAtoms: number;
}

/** A bucket below this cannot show repetition, so it is not worth an LLM call. */
export const MIN_BUCKET_ATOMS = 2;

/** Hard cap on atoms fed to a single extraction prompt. Without a
 * --window-days bound the global bucket accumulates the platform's ENTIRE
 * history every run, and once the prompt outgrows the model's context
 * `generateObject` throws — which run.ts's per-bucket try/catch swallows, so
 * an over-cap bucket would otherwise silently stop being mined FOREVER.
 * Keeps the freshest atoms (relies on run.ts ordering rows by recency) and
 * the caller must log how much it trimmed (bucket.truncatedAtoms). */
export const MAX_ATOMS_PER_BUCKET = 300;

/** Cosine DISTANCE (1 - similarity) under which two titles are the same
 * scenario. Tuned conservatively: a false merge silently inflates
 * confirmations, which is the one number the whole trigger rests on. */
export const SCENARIO_DEDUP_MAX_DISTANCE = 0.15;

// Exported so the "undefined" guard is directly unit-testable: a record
// missing its required fields is not evidence, and interpolating it
// unconditionally used to produce atoms like `tool undefined: undefined`
// that the trailing empty-string filter below never caught.
export function atomsOf(row: InsightRowForScenarios): ScenarioAtom[] {
  const atoms: ScenarioAtom[] = [];
  for (const e of row.errors ?? []) {
    if (e.recovered) continue; // a recovered error taught the agent nothing new
    if (!e.tool || !e.error) continue; // partial record: nothing to act on
    atoms.push({ sessionId: row.session_id, kind: "error", text: `tool ${e.tool}: ${e.error}` });
  }
  for (const c of row.corrections ?? []) {
    if (!c.what_agent_did || !c.what_user_wanted) continue; // partial record
    atoms.push({
      sessionId: row.session_id,
      kind: "correction",
      text: `agent did: ${c.what_agent_did} / user wanted: ${c.what_user_wanted}`,
    });
  }
  for (const m of row.memory_requests ?? []) {
    atoms.push({ sessionId: row.session_id, kind: "preference", text: m.quote ?? "" });
  }
  return atoms.filter((a) => a.text.trim().length > 0);
}

function capAtoms(atoms: ScenarioAtom[]): { atoms: ScenarioAtom[]; truncated: number } {
  if (atoms.length <= MAX_ATOMS_PER_BUCKET) return { atoms, truncated: 0 };
  return {
    atoms: atoms.slice(0, MAX_ATOMS_PER_BUCKET),
    truncated: atoms.length - MAX_ATOMS_PER_BUCKET,
  };
}

/** Groups atoms per user, with every unattributed session rolled into one
 * global bucket. Buckets that cannot possibly show repetition are dropped
 * before any LLM call: fewer than MIN_BUCKET_ATOMS atoms, or every atom from
 * the same single session.
 *
 * The global bucket is pushed FIRST. run.ts caps how many buckets one run
 * mines (MAX_SCENARIO_BUCKETS_PER_RUN); with global pushed last it was
 * guaranteed to starve on any deployment with more than that many users,
 * since there is no rotation across runs — "last" meant "never". Per-user
 * buckets are still in Map insertion order (rows' arrival order), which is
 * NOT priority-ranked; see run.ts's comment on the known limitation. */
export function bucketAtoms(rows: InsightRowForScenarios[]): ScenarioBucket[] {
  const byUser = new Map<string, ScenarioAtom[]>();
  const global: ScenarioAtom[] = [];
  for (const row of rows) {
    const atoms = atomsOf(row);
    if (atoms.length === 0) continue;
    if (row.user_id) {
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), ...atoms]);
    } else {
      global.push(...atoms);
    }
  }
  const viable = (atoms: ScenarioAtom[]): boolean =>
    atoms.length >= MIN_BUCKET_ATOMS && new Set(atoms.map((a) => a.sessionId)).size >= 2;

  const buckets: ScenarioBucket[] = [];
  if (viable(global)) {
    const { atoms, truncated } = capAtoms(global);
    buckets.push({ scope: "global", userId: null, atoms, truncatedAtoms: truncated });
  }
  for (const [userId, atoms] of byUser) {
    if (viable(atoms)) {
      const { atoms: capped, truncated } = capAtoms(atoms);
      buckets.push({ scope: "user", userId, atoms: capped, truncatedAtoms: truncated });
    }
  }
  return buckets;
}

const extractionSchema = z.object({
  scenarios: z.array(
    z.object({
      kind: z.enum(["correction", "error", "preference", "workflow"]),
      title: z.string().describe("One line: what recurs. No quotes, no names."),
      recipe: z.string().describe("2-4 lines: what the agent should do instead."),
      session_ids: z.array(z.string()).describe("Ids of the sessions this was observed in"),
    }),
  ),
});

export interface ExtractedScenario {
  kind: ScenarioKind;
  title: string;
  recipe: string;
  session_ids: string[];
}

const EXTRACTION_SYSTEM = `You read facts extracted from past sessions of an AI design agent and name the patterns that RECUR across DIFFERENT sessions.

Rules:
- Only report a pattern observed in at least two different session ids. One session is an anecdote, not a scenario.
- Prefer patterns that are ACTIONABLE for the agent itself (a habit to change, a step to always take) over topical groupings.
- 'title' is one line, no verbatim user quotes, no personal data.
- 'recipe' says what to do differently, in the imperative, 2-4 lines.
- 'session_ids' must be ids present in the input. Never invent one.
- Return an empty array rather than inventing a weak pattern.`;

/** One LLM pass per bucket. Anything the model invents (a session id not in
 * the input) is dropped here rather than trusted — the id set is the sole
 * evidence link back to L0/L1, so a hallucinated one would produce a
 * scenario nobody can drill down into. Free text is PII-scrubbed on the way
 * out, same rule the clustering pass follows. */
export async function extractScenarios(
  model: LanguageModel,
  atoms: ScenarioAtom[],
): Promise<ExtractedScenario[]> {
  const known = new Set(atoms.map((a) => a.sessionId));
  const prompt = atoms.map((a) => `[${a.sessionId}] (${a.kind}) ${a.text}`).join("\n");
  const { object } = await generateObject({
    model,
    schema: extractionSchema,
    system: EXTRACTION_SYSTEM,
    prompt,
  });
  return object.scenarios
    .map((s) => ({
      kind: s.kind as ScenarioKind,
      title: scrubPii(s.title),
      recipe: scrubPii(s.recipe),
      session_ids: [...new Set(s.session_ids.filter((id) => known.has(id)))],
    }))
    .filter((s) => s.session_ids.length >= 2 && s.title.trim() && s.recipe.trim());
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Mirrors agent_scenarios.state (014_agent_scenarios.sql). 'distilled' and
 * 'rejected' are terminal: the loop already made its call on that pattern. */
export type ScenarioState = "open" | "offered" | "distilled" | "rejected";

export interface ExistingScenario {
  id: number;
  title: string;
  embedding: number[] | null;
  session_ids: string[];
  state: ScenarioState;
}

/** trim + lowercase + collapse internal whitespace, so "  Wants   updates"
 * and "wants updates" count as the same scenario when there is no embedding
 * to compare by. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The nearest existing row (ANY state — callers decide what a terminal-state
 * match means, see upsertScenario). An exact normalized-title match is
 * checked FIRST and wins outright, regardless of whether either side has an
 * embedding; only when no title matches does this fall back to embedding
 * cosine distance.
 *
 * Title-first matters even when both sides HAVE an embedding: an embedding
 * model swap between runs (or a truncated/corrupt stored vector) can leave
 * two rows with an identical normalized title but a cosine distance above
 * the threshold. Checking the cheap, exact signal before the approximate one
 * means that case still merges instead of silently inserting a duplicate.
 *
 * The fallback also matters on its own: without EMBEDDINGS_API_KEY (or after
 * a failed embed call) `embedding` is always null, so a rule that required
 * an embedding on both sides would mean NOTHING ever deduped and
 * agent_scenarios grew unbounded every run. A missing vector is unknown
 * *similarity*, not unknown *identity* — an exact title match is still a
 * real duplicate. */
export function findDuplicate(
  candidateTitle: string,
  embedding: number[] | null,
  existing: ExistingScenario[],
  maxDistance: number = SCENARIO_DEDUP_MAX_DISTANCE,
): ExistingScenario | null {
  const normalizedCandidate = normalizeTitle(candidateTitle);
  const titleMatch = existing.find((row) => normalizeTitle(row.title) === normalizedCandidate);
  if (titleMatch) return titleMatch;

  if (!embedding) return null;
  let best: ExistingScenario | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const row of existing) {
    if (!row.embedding) continue;
    const distance = 1 - cosine(embedding, row.embedding);
    if (distance <= maxDistance && distance < bestDistance) {
      bestDistance = distance;
      best = row;
    }
  }
  return best;
}

export function mergeSessionIds(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

/** Confirmations are DISTINCT SESSIONS, never atoms — the invariant the
 * whole due-threshold rests on. */
export function confirmationsOf(sessionIds: string[]): number {
  return new Set(sessionIds).size;
}
