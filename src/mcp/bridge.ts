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

interface PendingCall {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
}

interface WireMessage {
  id?: string;
  type: string;
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

function rejectAllPending(session: Session, error: Error): void {
  for (const call of session.pending.values()) {
    clearTimeout(call.timer);
    call.reject(error);
  }
  session.pending.clear();
}

// Registers a newly-connected editor tab. Wires message/close handlers that
// resolve/reject in-flight callTool() promises and track activity for
// most-recently-active routing.
export function registerSession(
  socket: EditorSocket,
  ownerUserId: BridgeOwner = null,
  credential: SessionCredential | null = null,
): void {
  const session: Session = { socket, ownerUserId, lastActiveAt: Date.now(), credential, pending: new Map() };
  sessions.set(socket, session);

  socket.on("message", (data) => {
    session.lastActiveAt = Date.now();
    const message = parseMessage(data);
    // "activity" / "focus" only refresh lastActiveAt (above); no reply.
    if (!message || message.type === "activity" || message.type === "focus") return;

    const id = message.id;
    if (!id) return;
    const pendingCall = session.pending.get(id);
    if (!pendingCall) return;

    if (message.type === "tool_result") {
      session.pending.delete(id);
      clearTimeout(pendingCall.timer);
      pendingCall.resolve(message.result ?? "");
    } else if (message.type === "tool_error") {
      session.pending.delete(id);
      clearTimeout(pendingCall.timer);
      pendingCall.reject(new Error(message.error ?? "Tool call failed"));
    } else {
      session.pending.delete(id);
      clearTimeout(pendingCall.timer);
      pendingCall.reject(new Error(`Unexpected reply type: ${message.type}`));
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
function pickSession(owner: BridgeOwner): Session | null {
  let best: Session | null = null;
  for (const session of sessions.values()) {
    if (session.ownerUserId !== owner) continue;
    if (session.socket.readyState !== OPEN) continue;
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

function dispatchCall(
  owner: BridgeOwner,
  tool: string,
  args: Record<string, unknown>,
  appOrigin: string,
): Promise<string> {
  const session = pickSession(owner);
  if (!session) {
    return Promise.reject(
      new Error(owner === null ? NO_SESSION_MESSAGE : noUserSessionMessage(appOrigin)),
    );
  }

  const id = randomUUID();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Editor did not respond to "${tool}" within ${CALL_TIMEOUT_MS}ms.`));
    }, CALL_TIMEOUT_MS);

    session.pending.set(id, { resolve, reject, timer });
    try {
      session.socket.send(JSON.stringify({ id, type: "tool_call", tool, args }));
    } catch (err) {
      // A synchronous throw from send() (e.g. socket already closing) means
      // the call never went out — clear the timer and pending entry so
      // reject() below is the only settlement, instead of also firing the
      // 30s timeout later.
      clearTimeout(timer);
      session.pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export function sessionCount(): number {
  return sessions.size;
}

// Test-only: clears all registered sessions and pending calls so tests
// don't leak state into each other via the module-level registry.
export function resetBridgeForTests(): void {
  for (const session of sessions.values()) {
    for (const call of session.pending.values()) clearTimeout(call.timer);
  }
  sessions.clear();
}
