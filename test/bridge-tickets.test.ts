import { describe, expect, it } from "vitest";
import {
  BRIDGE_TICKET_TTL_MS,
  TICKET_SESSION_MAX_MS,
  consumeBridgeTicket,
  mintBridgeTicket,
} from "../src/mcp/bridgeTickets.js";

const credential = (expiresAt = Infinity) => ({ expiresAt, isValid: async () => true });

describe("bridge tickets", () => {
  it("binds the owner, is single use and unguessable", () => {
    const a = mintBridgeTicket("alice", credential());
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(mintBridgeTicket("alice", credential())).not.toBe(a);
    expect(consumeBridgeTicket(a)?.owner).toBe("alice");
    expect(consumeBridgeTicket(a)).toBeNull();
    expect(consumeBridgeTicket("unknown")).toBeNull();
  });

  it("expires after the TTL", () => {
    const t0 = 1_000_000;
    const live = mintBridgeTicket("bob", credential(), t0);
    expect(consumeBridgeTicket(live, t0 + BRIDGE_TICKET_TTL_MS - 1)).toMatchObject({ owner: "bob" });
    const dead = mintBridgeTicket("bob", credential(), t0);
    expect(consumeBridgeTicket(dead, t0 + BRIDGE_TICKET_TTL_MS)).toBeNull();
  });

  it("caps the session at 12 h and at the minting credential's own expiry", () => {
    const t0 = 5_000;
    expect(consumeBridgeTicket(mintBridgeTicket("a", credential(), t0), t0)?.credential.expiresAt).toBe(t0 + TICKET_SESSION_MAX_MS);
    expect(consumeBridgeTicket(mintBridgeTicket("a", credential(t0 + 1000), t0), t0)?.credential.expiresAt).toBe(t0 + 1000);
  });
});
