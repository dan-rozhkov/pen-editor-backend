// Who may do what to a design-system library. Pure: no SQL, no request. The
// role of a principal on one library comes from the store (a personal
// library: its owner; an organization library: the `member` row), the kind of
// principal narrows it further.
export type DsRole = "owner" | "editor" | "viewer";
export type DsAction = "read" | "comment" | "write" | "publish" | "approve" | "admin";
export type PrincipalKind = "user" | "agent" | "api_key";

/** The authenticated caller of /api/ds. */
export interface Principal {
  /** The account the caller acts for. */
  userId: string;
  kind: PrincipalKind;
  /** OAuth client id (kind `agent`). */
  clientId?: string;
  /** API key id (kind `api_key`). */
  keyId?: string;
  scopes: string[];
}

// Mirrors ORG_ROLES in src/auth/organization.ts (test/ds-access.test.ts pins
// that the two agree).
export const ROLE_ACTIONS: Record<DsRole, readonly DsAction[]> = {
  owner: ["read", "comment", "write", "publish", "approve", "admin"],
  editor: ["read", "comment", "write", "publish", "approve"],
  viewer: ["read", "comment"],
};

// What a kind of principal may ever do, whatever its role. An agent (OAuth
// token) reads and comments; it never writes, publishes or approves. An API
// key has no per-library permission yet, so it is read-only too (CI
// publishing arrives with key permissions in 8.6).
const KIND_ACTIONS: Record<PrincipalKind, readonly DsAction[]> = {
  user: ["read", "comment", "write", "publish", "approve", "admin"],
  agent: ["read", "comment"],
  api_key: ["read", "comment"],
};

export type Decision = { ok: true } | { ok: false; code: "forbidden" | "agent_cannot_approve" };

export function decide(principal: Pick<Principal, "kind">, role: DsRole, action: DsAction): Decision {
  if (!KIND_ACTIONS[principal.kind].includes(action)) {
    // A machine never ships or signs off a change. Not role-dependent.
    const gated = principal.kind === "agent" && (action === "approve" || action === "publish");
    return { ok: false, code: gated ? "agent_cannot_approve" : "forbidden" };
  }
  return ROLE_ACTIONS[role].includes(action) ? { ok: true } : { ok: false, code: "forbidden" };
}

export function can(principal: Pick<Principal, "kind">, role: DsRole, action: DsAction): boolean {
  return decide(principal, role, action).ok;
}

export function isDsRole(value: unknown): value is DsRole {
  return value === "owner" || value === "editor" || value === "viewer";
}
