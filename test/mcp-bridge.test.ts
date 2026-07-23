import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSession,
  unregisterSession,
  callTool,
  sessionCount,
  resetBridgeForTests,
  NO_SESSION_MESSAGE,
  type EditorSocket,
} from "../src/mcp/bridge.js";

class FakeSocket implements EditorSocket {
  readyState = 1; // OPEN
  sent: string[] = [];
  private messageListeners: Array<(data: unknown) => void> = [];
  private closeListeners: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  on(event: "message" | "close", listener: (data?: unknown) => void): void {
    if (event === "message") this.messageListeners.push(listener as (data: unknown) => void);
    else this.closeListeners.push(listener as () => void);
  }

  emitMessage(data: unknown): void {
    for (const l of this.messageListeners) l(data);
  }

  emitClose(): void {
    this.readyState = 3; // CLOSED
    for (const l of this.closeListeners) l();
  }

  lastCall(): { id: string; tool: string; args: unknown } {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

beforeEach(() => {
  resetBridgeForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mcp bridge", () => {
  it("rejects immediately with no connected session", async () => {
    await expect(callTool("get_editor_state", {})).rejects.toThrow(NO_SESSION_MESSAGE);
  });

  it("routes a call to the only session and resolves on tool_result", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", { include_schema: false });
    const call = socket.lastCall();
    expect(call.tool).toBe("get_editor_state");
    expect(call.args).toEqual({ include_schema: false });

    socket.emitMessage(JSON.stringify({ id: call.id, type: "tool_result", result: "{}" }));

    await expect(promise).resolves.toBe("{}");
  });

  it("rejects on tool_error", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("batch_design", { operations: 'D("x")' });
    const call = socket.lastCall();
    socket.emitMessage(JSON.stringify({ id: call.id, type: "tool_error", error: "node not found" }));

    await expect(promise).rejects.toThrow("node not found");
  });

  it("rejects (not hangs) on a reply with matching id but unrecognized type", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", {});
    const call = socket.lastCall();
    socket.emitMessage(JSON.stringify({ id: call.id, type: "unknown_type" }));

    await expect(promise).rejects.toThrow("Unexpected reply type: unknown_type");
  });

  it("ignores activity pings and stray messages without a matching id", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", {});
    const call = socket.lastCall();
    socket.emitMessage(JSON.stringify({ type: "activity" }));
    socket.emitMessage(JSON.stringify({ id: "not-the-real-id", type: "tool_result", result: "wrong" }));
    socket.emitMessage(JSON.stringify({ id: call.id, type: "tool_result", result: "right" }));

    await expect(promise).resolves.toBe("right");
  });

  it("routes to the most-recently-active session", () => {
    vi.useFakeTimers();
    const older = new FakeSocket();
    const newer = new FakeSocket();

    vi.setSystemTime(1000);
    registerSession(older);
    vi.setSystemTime(2000);
    registerSession(newer);
    vi.setSystemTime(3000);
    older.emitMessage(JSON.stringify({ type: "activity" }));

    void callTool("get_editor_state", {});
    expect(older.sent).toHaveLength(1);
    expect(newer.sent).toHaveLength(0);
  });

  it("rejects a pending call immediately when the socket closes mid-call", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", {});
    socket.emitClose();

    await expect(promise).rejects.toThrow("disconnected mid-call");
  });

  it("times out after 30s with no reply", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool("get_editor_state", {});
    vi.advanceTimersByTime(30_000);

    await expect(promise).rejects.toThrow("did not respond");
  });

  it("unregisterSession rejects pending calls and drops the session", async () => {
    const socket = new FakeSocket();
    registerSession(socket);
    const promise = callTool("get_editor_state", {});
    unregisterSession(socket);

    await expect(promise).rejects.toThrow("disconnected mid-call");
    expect(sessionCount()).toBe(0);
  });

  it("rejects (and clears the pending entry/timer) when socket.send throws synchronously", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    registerSession(socket);
    socket.send = () => {
      throw new Error("socket is closing");
    };

    await expect(callTool("get_editor_state", {})).rejects.toThrow("socket is closing");

    // The 30s call-timeout timer must have been cleared on the synchronous
    // send() failure — a leaked timer would otherwise fire later (a no-op
    // since the promise already settled, but a real leak nonetheless).
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips a closed session when picking the most-recently-active one", () => {
    const closed = new FakeSocket();
    const open = new FakeSocket();
    registerSession(closed);
    registerSession(open);
    closed.emitClose(); // closed is now readyState 3, more recently "active" by wall clock but not OPEN

    void callTool("get_editor_state", {});
    expect(open.sent).toHaveLength(1);
  });
});
