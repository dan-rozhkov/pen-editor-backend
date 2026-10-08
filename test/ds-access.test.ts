import { describe, expect, it } from "vitest";
import { can, decide, ROLE_ACTIONS, type DsAction, type DsRole, type PrincipalKind } from "../src/ds/access.js";
import { ORG_ROLES, statements } from "../src/auth/organization.js";

const ACTIONS: DsAction[] = ["read", "comment", "write", "publish", "approve", "admin"];
const ROLES: DsRole[] = ["viewer", "editor", "owner"];

describe("library role matrix (user principal)", () => {
  const allowed: Record<DsRole, DsAction[]> = {
    viewer: ["read", "comment"],
    editor: ["read", "comment", "write", "publish", "approve"],
    owner: ACTIONS,
  };
  it.each(ROLES.flatMap((role) => ACTIONS.map((action) => [role, action] as const)))("%s x %s", (role, action) => {
    expect(can({ kind: "user" }, role, action)).toBe(allowed[role].includes(action));
  });

  it("agrees with the Better Auth organization roles", () => {
    for (const role of ROLES) {
      expect([...ROLE_ACTIONS[role]].sort(), role).toEqual([...(ORG_ROLES[role].statements.library ?? [])].sort());
    }
    expect([...statements.library].sort()).toEqual([...ACTIONS].sort());
  });
});

describe("kind of principal", () => {
  it("an agent reads and comments, and may never publish or approve, whatever its role", () => {
    for (const role of ROLES) {
      expect(can({ kind: "agent" }, role, "read")).toBe(true);
      expect(can({ kind: "agent" }, role, "comment")).toBe(true);
      expect(decide({ kind: "agent" }, role, "approve")).toEqual({ ok: false, code: "agent_cannot_approve" });
      expect(decide({ kind: "agent" }, role, "publish")).toEqual({ ok: false, code: "agent_cannot_approve" });
      expect(decide({ kind: "agent" }, role, "write")).toEqual({ ok: false, code: "forbidden" });
      expect(decide({ kind: "agent" }, role, "admin")).toEqual({ ok: false, code: "forbidden" });
    }
  });

  it.each<PrincipalKind>(["api_key"])("%s is read-only until keys carry permissions", (kind) => {
    for (const role of ROLES) {
      expect(ACTIONS.filter((a) => can({ kind }, role, a))).toEqual(["read", "comment"]);
    }
  });
});
