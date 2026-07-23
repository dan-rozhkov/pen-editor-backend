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
}

const OPEN = 1; // ws.WebSocket.OPEN
const CALL_TIMEOUT_MS = 30_000;

interface PendingCall {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  socket: EditorSocket;
  lastActiveAt: number;
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
export function registerSession(socket: EditorSocket): void {
  const session: Session = { socket, lastActiveAt: Date.now(), pending: new Map() };
  sessions.set(socket, session);

  socket.on("message", (data) => {
    session.lastActiveAt = Date.now();
    const message = parseMessage(data);
    if (!message || message.type === "activity") return;

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

function pickSession(): Session | null {
  let best: Session | null = null;
  for (const session of sessions.values()) {
    if (session.socket.readyState !== OPEN) continue;
    if (!best || session.lastActiveAt > best.lastActiveAt) best = session;
  }
  return best;
}

// Routes a tool call to the most-recently-active connected editor tab and
// waits for its reply (30s timeout). Rejects immediately if no tab is
// connected, and rejects any in-flight call the instant its socket closes.
export function callTool(tool: string, args: Record<string, unknown>): Promise<string> {
  const session = pickSession();
  if (!session) {
    return Promise.reject(new Error(NO_SESSION_MESSAGE));
  }

  const id = randomUUID();
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`Editor did not respond to "${tool}" within ${CALL_TIMEOUT_MS}ms.`));
    }, CALL_TIMEOUT_MS);

    session.pending.set(id, { resolve, reject, timer });
    session.socket.send(JSON.stringify({ id, type: "tool_call", tool, args }));
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
