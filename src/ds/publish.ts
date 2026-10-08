// The rules of a publish, as pure functions over a locked PublishContext:
// the store owns the transaction, this module owns every decision in it.
// Order of work (inside the row lock): idempotency replay, archived, base
// version, snapshot validity, diff, bump, removal policy, version limit.
import { canonicalJson, sha256Hex } from "./canonical.js";
import {
  bumpSatisfies,
  checkRemovalPolicy,
  deriveMigrations,
  diffSnapshots,
  type Migration,
  type RequiredBump,
  type SnapshotDiff,
  type Violation,
} from "./diff.js";
import {
  MAX_VERSIONS_PER_LIBRARY,
  type PublishContext,
  type PublishDecision,
  type PublishRejection,
} from "./dsStore.js";
import { nextVersions, type Bump } from "./semver.js";
import { validateSnapshot, type Snapshot, type SnapshotValidation } from "./snapshotSchema.js";

/**
 * A snapshot validated and serialized exactly once, before any lock is taken:
 * the canonical JSON is what the size check measures, the hash covers, and the
 * INSERT stores. `json` and `hash` are empty when the snapshot is invalid.
 */
export interface PreparedSnapshot {
  validation: SnapshotValidation;
  json: string;
  hash: string;
}

export function prepareSnapshot(raw: unknown): PreparedSnapshot {
  const validation = validateSnapshot(raw);
  if (!validation.ok) return { validation, json: "", hash: "" };
  const json = canonicalJson(validation.snapshot);
  return { validation, json, hash: sha256Hex(json) };
}

export interface PublishInput {
  baseVersion: string | null;
  bump: Bump;
  snapshot: PreparedSnapshot;
  changelog: unknown;
  notes: string;
  idempotencyKey: string;
  requestHash: string;
}

const reject = (status: number, code: string, message: string, details?: Record<string, unknown>): PublishRejection => ({
  kind: "reject",
  status,
  code,
  message,
  ...(details ? { details } : {}),
});

/** Checks shared by preview and publish: base version, then snapshot validity. */
export function checkBaseAndSnapshot(
  ctx: Pick<PublishContext, "latest">,
  baseVersion: string | null,
  validation: SnapshotValidation,
): PublishRejection | { snapshot: Snapshot } {
  const latestVersion = ctx.latest?.version ?? null;
  if (baseVersion !== latestVersion) {
    return reject(409, "stale_base", "The library has a newer version than the one this change was based on.", { latestVersion });
  }
  if (!validation.ok) {
    return reject(422, validation.code, validation.message, { issues: validation.issues });
  }
  return { snapshot: validation.snapshot };
}

export interface Analysis {
  diff: SnapshotDiff;
  violations: Violation[];
  migrations: Migration[];
  requiredBump: RequiredBump;
  nextVersions: Record<Bump, string>;
}

export function analyze(latest: Snapshot | null, next: Snapshot, latestVersion: string | null): Analysis {
  const diff = diffSnapshots(latest, next);
  const violations = checkRemovalPolicy(latest, next);
  return {
    diff,
    violations,
    migrations: violations.length === 0 ? deriveMigrations(latest, next) : [],
    requiredBump: diff.requiredBump,
    nextVersions: nextVersions(latestVersion),
  };
}

export function violationRejection(violations: Violation[]): PublishRejection {
  const first = violations.find((v) => v.code === "removal_not_deprecated") ?? violations[0];
  return reject(422, first.code, first.message, {
    entities: violations.filter((v) => v.code === first.code).map((v) => v.entity),
    violations,
  });
}

export function decidePublish(input: PublishInput): (ctx: PublishContext) => PublishDecision {
  return (ctx) => {
    if (ctx.replay) {
      if (ctx.replay.requestHash !== input.requestHash) {
        return reject(422, "idempotency_key_reuse", "This Idempotency-Key was already used with a different request.");
      }
      const { version, bump, publishedAt, publishedBy, snapshotHash } = ctx.replay;
      return { kind: "replay", result: { version, bump, publishedAt, publishedBy, snapshotHash } };
    }
    if (ctx.library.archivedAt) return reject(409, "archived", "This library is archived and cannot be published to.");
    const checked = checkBaseAndSnapshot(ctx, input.baseVersion, input.snapshot.validation);
    if ("kind" in checked) return checked;

    const analysis = analyze(ctx.latest?.snapshot ?? null, checked.snapshot, ctx.latest?.version ?? null);
    const first = ctx.latest === null;
    if (analysis.requiredBump === "none") return reject(422, "no_changes", "The snapshot is identical to the latest version.");
    if (!first && !bumpSatisfies(input.bump, analysis.requiredBump)) {
      return reject(422, "bump_too_low", `This change needs at least a ${analysis.requiredBump} bump.`, { required: analysis.requiredBump });
    }
    if (analysis.violations.length > 0) return violationRejection(analysis.violations);
    if (ctx.versionCount >= MAX_VERSIONS_PER_LIBRARY) {
      return reject(422, "version_limit", `A library can hold at most ${MAX_VERSIONS_PER_LIBRARY} versions.`);
    }

    return {
      kind: "insert",
      version: {
        version: first ? "1.0.0" : analysis.nextVersions[input.bump],
        bump: first ? "initial" : input.bump,
        baseVersion: input.baseVersion,
        snapshotJson: input.snapshot.json,
        snapshotHash: input.snapshot.hash,
        changelog: input.changelog,
        summary: analysis.diff.summary,
        migrations: analysis.migrations,
        notes: input.notes,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      },
    };
  };
}
