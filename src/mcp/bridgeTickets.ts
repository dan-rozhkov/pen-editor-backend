import { randomBytes } from "node:crypto";
import type { SessionCredential } from "./bridge.js";

// One-time credentials that let a sandboxed MCP App widget join the editor
// bridge as the `/mcp` caller's account. The widget iframe has a host-specific
// origin and no cookies, so it cannot use the cookie path; the ticket, minted
// over the authenticated `/mcp` channel, is its credential for ONE upgrade.
// In-memory and single-instance, like the bridge itself.
export const BRIDGE_TICKET_TTL_MS = 120_000;
// A ticket session never outlives this, so the widget has to re-ticket (and so
// re-prove its minting credential) at least this often.
export const TICKET_SESSION_MAX_MS = 12 * 60 * 60 * 1000;

interface TicketEntry {
  owner: string;
  expiresAt: number;
  credential: SessionCredential;
}
const tickets = new Map<string, TicketEntry>();

function sweep(now: number): void {
  for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
}

// `credential` is the /mcp credential that minted the ticket (API key or OAuth
// token): the resulting WS session is re-validated against it, so revoking the
// key or the agent's consent also evicts the widget.
export function mintBridgeTicket(owner: string, credential: SessionCredential, now = Date.now()): string {
  sweep(now);
  const ticket = randomBytes(32).toString("base64url");
  const expiresAt = Math.min(credential.expiresAt, now + TICKET_SESSION_MAX_MS);
  tickets.set(ticket, {
    owner,
    expiresAt: now + BRIDGE_TICKET_TTL_MS,
    credential: { expiresAt, isValid: () => credential.isValid() },
  });
  return ticket;
}

// Returns the owner and credential and invalidates the ticket, or null when it
// is unknown, expired or already used.
export function consumeBridgeTicket(
  ticket: string,
  now = Date.now(),
): { owner: string; credential: SessionCredential } | null {
  sweep(now);
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  return { owner: entry.owner, credential: entry.credential };
}

export function resetBridgeTicketsForTests(): void {
  tickets.clear();
}
