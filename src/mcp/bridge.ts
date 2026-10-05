import { randomUUID } from "node:crypto";

// Minimal shape the bridge needs from a WebSocket-like connection. The real
// backend passes @fastify/websocket's underlying `ws` socket (structurally
// compatible: readyState, send, and an EventEmitter-style `on`); tests
// substitute a plain fake object with the same three members.
export interface EditorSocket {
  readyState: number;
  send(data: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  /** Optional: only needed to evict a tab whose auth session ended. */
  close?(code?: number, reason?: string): void;
}

/** WebSocket close code (4xxx = application-defined) for an ended auth session. */
export const SESSION_ENDED_CLOSE_CODE = 4401;

/**
 * What ties a cookie-authenticated tab to the auth session it upgraded with.
 * `isValid` is the single re-validation hook (a real DB lookup, never the
 * cookie cache — see src/mcp/routes.ts); tests inject their own.
 */
export interface SessionCredential {
  expiresAt: number;
  isValid(): Promise<boolean>;
}

const OPEN = 1; // ws.WebSocket.OPEN
const CALL_TIMEOUT_MS = 30_000;

// Two-phase delivery for tabs that sent `hello` with "ack": the tool_call goes
// out with `ack: true`, the tab replies `ack` WITHOUT executing, and only then
// does the bridge send `go`. No ack within this window means the tab is stalled
// or gone: the call is withdrawn from it (`cancel`) and re-routed, so exactly
// one tab is ever told to execute. Injectable for tests.
export const ACK_TIMEOUT_MS = 5_000;
let ackTimeoutMs = ACK_TIMEOUT_MS;
export function setAckTimeoutForTests(ms: number): void {
  ackTimeoutMs = ms;
}

// One logical callTool(): spans every attempt (re-route) and owns the single
// overall deadline.
interface Call {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  // Pre-go: bounds acks and re-routes. Restarted at `go` as the tab's
  // execution budget.
  timer: ReturnType<typeof setTimeout>;
  tool: string;
  settled: boolean;
  current: { session: Session; id: string } | null;
}

interface PendingCall {
  call: Call;
  /** False until the tab confirmed receipt; only matters for ack tabs. */
  acked: boolean;
  ackTimer?: ReturnType<typeof setTimeout>;
}

// Who owns a session / a call. A user id (cookie-authenticated tab, or the
// owner of a `/mcp` credential) or null (the legacy static-token surface).
// Calls only ever reach sessions with the SAME owner — see pickSession.
export type BridgeOwner = string | null;

interface Session {
  socket: EditorSocket;
  ownerUserId: BridgeOwner;
  lastActiveAt: number;
  credential: SessionCredential | null;
  pending: Map<string, PendingCall>;
  /** True once the tab said `hello` with the "ack" capability. */
  supportsAck: boolean;
  /** Missed an ack: not routed to until it sends any message again. */
  suspect: boolean;
}

interface WireMessage {
  id?: string;
  type: string;
  capabilities?: unknown;
  result?: string;
  error?: string;
}

const sessions = new Map<EditorSocket, Session>();

export const NO_SESSION_MESSAGE =
  "No Pen Editor tab is connected. Open the editor in a browser with MCP enabled (VITE_MCP_WS_TOKEN set).";

export function noUserSessionMessage(appOrigin: string): string {
  return `No Sideform editor is open for your account. Open ${appOrigin}/app while signed in, then retry.`;
}

function parseMessage(data: unknown): WireMessage | null {
  const text =
    typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : null;
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof (parsed as WireMessage).type === "string") {
      return parsed as WireMessage;
    }
    return null;
  } catch {
    return null;
  }
}

function settle(call: Call, outcome: { result: string } | { error: Error }): void {
  if (call.settled) return;
  call.settled = true;
  clearTimeout(call.timer);
  call.current = null;
  if ("error" in outcome) call.reject(outcome.error);
  else call.resolve(outcome.result);
}

function rejectAllPending(session: Session, error: Error): void {
  for (const pending of session.pending.values()) {
    clearTimeout(pending.ackTimer);
    settle(pending.call, { error });
  }
  session.pending.clear();
}

function sendQuietly(session: Session, message: object): void {
  try {
    session.socket.send(JSON.stringify(message));
  } catch {
    // Socket closing: the close handler settles whatever is pending.
  }
}

// Registers a newly-connected editor tab. Wires message/close handlers that
// resolve/reject in-flight callTool() promises and track activity for
// most-recently-active routing.
export function registerSession(
  socket: EditorSocket,
  ownerUserId: BridgeOwner = null,
  credential: SessionCredential | null = null,
): void {
  const session: Session = { socket, ownerUserId, lastActiveAt: Date.now(), credential, pending: new Map(),
    supportsAck: false,
    suspect: false,
  };
  sessions.set(socket, session);

  socket.on("message", (data) => {
    session.lastActiveAt = Date.now();
    session.suspect = false; // any sign of life clears a missed ack
    const message = parseMessage(data);
    // "activity" / "focus" only refresh lastActiveAt (above); no reply.
    if (!message || message.type === "activity" || message.type === "focus") return;
    if (message.type === "hello") {
      if (Array.isArray(message.capabilities) && message.capabilities.includes("ack")) {
        session.supportsAck = true;
      }
      return;
    }

    const id = message.id;
    if (!id) return;
    const pending = session.pending.get(id);
    if (message.type === "ack") {
      if (pending && !pending.acked) {
        pending.acked = true;
        clearTimeout(pending.ackTimer);
        pending.ackTimer = undefined;
        sendQuietly(session, { id, type: "go" });
        // The executing tab gets the full budget, whatever acks cost.
        clearTimeout(pending.call.timer);
        pending.call.timer = setTimeout(() => expire(pending.call), CALL_TIMEOUT_MS);
      } else if (!pending) {
        // Late ack for a call withdrawn from this tab: it must never execute.
        sendQuietly(session, { id, type: "cancel" });
      }
      return;
    }
    if (!pending) return;

    session.pending.delete(id);
    clearTimeout(pending.ackTimer);
    if (message.type === "tool_result") {
      settle(pending.call, { result: message.result ?? "" });
    } else if (message.type === "tool_error") {
      settle(pending.call, { error: new Error(message.error ?? "Tool call failed") });
    } else {
      settle(pending.call, { error: new Error(`Unexpected reply type: ${message.type}`) });
    }
  });

  socket.on("close", () => {
    rejectAllPending(session, new Error("Editor tab disconnected mid-call."));
    sessions.delete(socket);
  });
}

// Test/production seam for teardown paths that don't go through the
// socket's own "close" event (e.g. explicit server shutdown).
export function unregisterSession(socket: EditorSocket): void {
  const session = sessions.get(socket);
  if (!session) return;
  rejectAllPending(session, new Error("Editor tab disconnected mid-call."));
  sessions.delete(socket);
}

function evict(session: Session): void {
  rejectAllPending(session, new Error("Editor tab disconnected: its sign-in session ended."));
  sessions.delete(session.socket);
  try {
    session.socket.close?.(SESSION_ENDED_CLOSE_CODE, "session ended");
  } catch {
    // Already closing: the registry entry is gone either way.
  }
}

// THE re-validation point for cookie-authenticated tabs: a tab must not
// outlive the auth session it upgraded with. Expired or no-longer-found
// sessions are closed and dropped. A lookup that THROWS keeps the tab (a
// transient DB error must not log everyone out); the next check retries.
async function revalidate(session: Session): Promise<void> {
  const { credential } = session;
  if (!credential || !sessions.has(session.socket)) return;
  let valid = Date.now() < credential.expiresAt;
  if (valid) {
    try {
      valid = await credential.isValid();
    } catch {
      return;
    }
  }
  if (!valid && sessions.get(session.socket) === session) evict(session);
}

export function revalidateSession(socket: EditorSocket): Promise<void> {
  const session = sessions.get(socket);
  return session ? revalidate(session) : Promise.resolve();
}

function revalidateOwner(owner: string): Promise<unknown> {
  return Promise.all([...sessions.values()].filter((s) => s.ownerUserId === owner).map(revalidate));
}

function hasCredentialedSession(owner: string): boolean {
  for (const session of sessions.values()) if (session.ownerUserId === owner && session.credential) return true;
  return false;
}

// THE isolation point: the only code that chooses a session for a call, and
// it never looks at a session whose owner differs from the caller's.
function pickSession(owner: BridgeOwner, except?: Session): Session | null {
  let best: Session | null = null;
  for (const session of sessions.values()) {
    if (session.ownerUserId !== owner) continue;
    if (session.socket.readyState !== OPEN) continue;
    if (session.suspect || session === except) continue;
    if (!best || session.lastActiveAt > best.lastActiveAt) best = session;
  }
  return best;
}

// Routes a tool call to the owner's most-recently-active connected editor tab
// and waits for its reply (30s timeout). Rejects immediately if that owner has
// no tab connected, and rejects any in-flight call the instant its socket
// closes. `appOrigin` only feeds the no-session message for a user owner.
export function callTool(
  owner: BridgeOwner,
  tool: string,
  args: Record<string, unknown>,
  appOrigin = "",
): Promise<string> {
  // Tabs of a user owner re-check their auth session first; the legacy
  // (owner null) path and credential-less tabs stay synchronous.
  if (owner !== null && hasCredentialedSession(owner)) {
    return revalidateOwner(owner).then(() => dispatchCall(owner, tool, args, appOrigin));
  }
  return dispatchCall(owner, tool, args, appOrigin);
}

function expire(call: Call): void {
  const { current } = call;
  let neverAcked = false;
  if (current) {
    const pending = current.session.pending.get(current.id);
    neverAcked = !!pending && !pending.acked;
    clearTimeout(pending?.ackTimer);
    current.session.pending.delete(current.id);
    // Do not leave the tab holding a call nobody waits for.
    if (neverAcked) sendQuietly(current.session, { id: current.id, type: "cancel" });
  }
  settle(call, {
    error: new Error(
      neverAcked
        ? `Editor tab is not responding to "${call.tool}" (no acknowledgement within ${CALL_TIMEOUT_MS}ms).`
        : `Editor did not respond to "${call.tool}" within ${CALL_TIMEOUT_MS}ms.`,
    ),
  });
}

function dispatchCall(
  owner: BridgeOwner,
  tool: string,
  args: Record<string, unknown>,
  appOrigin: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const call: Call = {
      resolve,
      reject,
      settled: false,
      current: null,
      tool,
      // ONE pre-go bound across every tab the call visits (see `go` above).
      timer: setTimeout(() => expire(call), CALL_TIMEOUT_MS),
    };
    attempt(call, owner, tool, args, appOrigin);
  });
}

function attempt(
  call: Call,
  owner: BridgeOwner,
  tool: string,
  args: Record<string, unknown>,
  appOrigin: string,
): void {
  if (call.settled) return;
  // Suspect sessions are skipped, so re-running pickSession after a missed
  // ack naturally moves on (and still only ever looks at this owner).
  const session = pickSession(owner);
  if (!session) {
    settle(call, {
      error: new Error(owner === null ? NO_SESSION_MESSAGE : noUserSessionMessage(appOrigin)),
    });
    return;
  }

  const id = randomUUID();
  const pending: PendingCall = { call, acked: !session.supportsAck };
  const wantsAck = session.supportsAck;
  if (wantsAck) {
    pending.ackTimer = setTimeout(() => {
      // Nobody else to try: keep waiting on this (possibly just slow) tab and
      // let the overall deadline decide, as before acks existed.
      if (!pickSession(owner, session)) return;
      // Withdraw the call from this tab but keep the tab: it may only be slow,
      // and its already-acked calls keep running. `cancel` makes sure it
      // never executes this one even if the frame is still queued.
      session.pending.delete(id);
      session.suspect = true;
      sendQuietly(session, { id, type: "cancel" });
      call.current = null;
      attempt(call, owner, tool, args, appOrigin);
    }, ackTimeoutMs);
  }
  call.current = { session, id };
  session.pending.set(id, pending);
  try {
    session.socket.send(JSON.stringify({ id, type: "tool_call", tool, args, ...(wantsAck && { ack: true }) }));
  } catch (err) {
    // A synchronous throw from send() (e.g. socket already closing) means
    // the call never went out.
    clearTimeout(pending.ackTimer);
    session.pending.delete(id);
    settle(call, { error: err instanceof Error ? err : new Error(String(err)) });
  }
}

export function sessionCount(): number {
  return sessions.size;
}

// Test-only: clears all registered sessions and pending calls so tests
// don't leak state into each other via the module-level registry.
export function resetBridgeForTests(): void {
  for (const session of sessions.values()) {
    for (const pending of session.pending.values()) {
      clearTimeout(pending.ackTimer);
      clearTimeout(pending.call.timer);
    }
  }
  sessions.clear();
  ackTimeoutMs = ACK_TIMEOUT_MS;
}
