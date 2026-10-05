import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerSession,
  unregisterSession,
  callTool,
  sessionCount,
  resetBridgeForTests,
  NO_SESSION_MESSAGE,
  SESSION_ENDED_CLOSE_CODE,
  revalidateSession,
  setAckTimeoutForTests,
  ACK_TIMEOUT_MS,
  type EditorSocket,
  type SessionCredential,
} from "../src/mcp/bridge.js";

class FakeSocket implements EditorSocket {
  readyState = 1; // OPEN
  sent: string[] = [];
  closedWith: [number | undefined, string | undefined] | null = null;
  private messageListeners: Array<(data: unknown) => void> = [];
  private closeListeners: Array<() => void> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  on(event: "message" | "close", listener: (data?: unknown) => void): void {
    if (event === "message") this.messageListeners.push(listener as (data: unknown) => void);
    else this.closeListeners.push(listener as () => void);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = [code, reason];
    this.emitClose();
  }

  emitMessage(data: unknown): void {
    for (const l of this.messageListeners) l(data);
  }

  emitClose(): void {
    this.readyState = 3; // CLOSED
    for (const l of this.closeListeners) l();
  }

  terminated = false;
  terminate(): void {
    this.terminated = true;
    this.emitClose();
  }

  hello(): this {
    this.emitMessage(JSON.stringify({ type: "hello", capabilities: ["ack"] }));
    return this;
  }

  ack(id: string): void {
    this.emitMessage(JSON.stringify({ id, type: "ack" }));
  }

  /** Frames the bridge sent, parsed. */
  frames(): Array<{ id: string; type: string; ack?: boolean }> {
    return this.sent.map((f) => JSON.parse(f));
  }

  ofType(type: string): string[] {
    return this.frames().filter((f) => f.type === type).map((f) => f.id);
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
    await expect(callTool(null, "get_editor_state", {})).rejects.toThrow(NO_SESSION_MESSAGE);
  });

  it("routes a call to the only session and resolves on tool_result", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool(null, "get_editor_state", { include_schema: false });
    const call = socket.lastCall();
    expect(call.tool).toBe("get_editor_state");
    expect(call.args).toEqual({ include_schema: false });

    socket.emitMessage(JSON.stringify({ id: call.id, type: "tool_result", result: "{}" }));

    await expect(promise).resolves.toBe("{}");
  });

  it("rejects on tool_error", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool(null, "batch_design", { operations: 'D("x")' });
    const call = socket.lastCall();
    socket.emitMessage(JSON.stringify({ id: call.id, type: "tool_error", error: "node not found" }));

    await expect(promise).rejects.toThrow("node not found");
  });

  it("rejects (not hangs) on a reply with matching id but unrecognized type", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool(null, "get_editor_state", {});
    const call = socket.lastCall();
    socket.emitMessage(JSON.stringify({ id: call.id, type: "unknown_type" }));

    await expect(promise).rejects.toThrow("Unexpected reply type: unknown_type");
  });

  it("ignores activity pings and stray messages without a matching id", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool(null, "get_editor_state", {});
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

    void callTool(null, "get_editor_state", {});
    expect(older.sent).toHaveLength(1);
    expect(newer.sent).toHaveLength(0);
  });

  it("rejects a pending call immediately when the socket closes mid-call", async () => {
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool(null, "get_editor_state", {});
    socket.emitClose();

    await expect(promise).rejects.toThrow("disconnected mid-call");
  });

  it("times out after 30s with no reply", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    registerSession(socket);

    const promise = callTool(null, "get_editor_state", {});
    vi.advanceTimersByTime(30_000);

    await expect(promise).rejects.toThrow("did not respond");
  });

  it("unregisterSession rejects pending calls and drops the session", async () => {
    const socket = new FakeSocket();
    registerSession(socket);
    const promise = callTool(null, "get_editor_state", {});
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

    await expect(callTool(null, "get_editor_state", {})).rejects.toThrow("socket is closing");

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

    void callTool(null, "get_editor_state", {});
    expect(open.sent).toHaveLength(1);
  });
});

describe("mcp bridge owner isolation", () => {
  const tab = (owner: string | null) => {
    const socket = new FakeSocket();
    registerSession(socket, owner);
    return socket;
  };

  it("never routes a user's call to another owner's session", async () => {
    const b = tab("user-b");
    await expect(callTool("user-a", "get_editor_state", {}, "https://app.example")).rejects.toThrow(
      "No Sideform editor is open for your account. Open https://app.example/app while signed in, then retry.",
    );
    expect(b.sent).toHaveLength(0);
  });

  it("serves legacy (null-owner) sessions only to legacy calls, and users only their own", async () => {
    const legacy = tab(null);
    const user = tab("user-a");
    void callTool("user-a", "get_editor_state", {});
    expect(user.sent).toHaveLength(1);
    expect(legacy.sent).toHaveLength(0);
    void callTool(null, "get_editor_state", {});
    expect(legacy.sent).toHaveLength(1);
    expect(user.sent).toHaveLength(1);
    // A user with no tab does not fall back to the legacy session.
    await expect(callTool("user-z", "get_editor_state", {})).rejects.toThrow("No Sideform editor is open");
  });

  it("picks the owner's most recently active session, and focus counts as activity", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = tab("user-a");
    vi.setSystemTime(2_000);
    const second = tab("user-a");
    void callTool("user-a", "get_editor_state", {});
    expect(second.sent).toHaveLength(1);

    vi.setSystemTime(3_000);
    first.emitMessage(JSON.stringify({ type: "focus" }));
    void callTool("user-a", "get_editor_state", {});
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
    expect(first.sent.every((line) => JSON.parse(line).type === "tool_call")).toBe(true);
  });
});

describe("mcp bridge auth-session binding", () => {
  const FAR = Date.now() + 3_600_000;
  const bound = (owner: string, credential: SessionCredential) => {
    const socket = new FakeSocket();
    registerSession(socket, owner, credential);
    return socket;
  };

  it("closes and drops a tab whose session is gone, then falls through to the valid tab", async () => {
    const stale = bound("user-a", { expiresAt: FAR, isValid: async () => false });
    const live = bound("user-a", { expiresAt: FAR, isValid: async () => true });
    void callTool("user-a", "get_editor_state", {});
    await vi.waitFor(() => expect(live.sent).toHaveLength(1));
    expect(stale.closedWith).toEqual([SESSION_ENDED_CLOSE_CODE, "session ended"]);
    expect(stale.sent).toHaveLength(0);
    expect(live.sent).toHaveLength(1);
    expect(sessionCount()).toBe(1);
  });

  it("answers the normal no-editor error once the only tab expired, without a lookup", async () => {
    const isValid = vi.fn(async () => true);
    const tab = bound("user-a", { expiresAt: Date.now() - 1, isValid });
    await expect(callTool("user-a", "get_editor_state", {}, "https://app.example")).rejects.toThrow(
      "No Sideform editor is open",
    );
    expect(isValid).not.toHaveBeenCalled();
    expect(tab.closedWith?.[0]).toBe(SESSION_ENDED_CLOSE_CODE);
  });

  it("keeps the tab when the lookup itself fails", async () => {
    const tab = bound("user-a", { expiresAt: FAR, isValid: async () => Promise.reject(new Error("db down")) });
    await revalidateSession(tab);
    expect(tab.closedWith).toBeNull();
    expect(sessionCount()).toBe(1);
  });
});

describe("mcp bridge two-phase ack", () => {
  const result = (id: string, r = "ok") => JSON.stringify({ id, type: "tool_result", result: r });

  function acking(owner: string | null): FakeSocket {
    const socket = new FakeSocket();
    registerSession(socket, owner);
    return socket.hello();
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("asks for an ack only from tabs that said hello, and never to others", () => {
    const old = new FakeSocket();
    registerSession(old, "user-a");
    void callTool("user-a", "get_editor_state", {}).catch(() => {});
    expect(old.frames()[0].ack).toBeUndefined();

    resetBridgeForTests();
    const fresh = acking("user-a");
    void callTool("user-a", "get_editor_state", {}).catch(() => {});
    expect(fresh.frames()[0].ack).toBe(true);
  });

  it("sends go on ack and then resolves from the result", async () => {
    const tab = acking("user-a");
    const promise = callTool("user-a", "get_editor_state", {});
    const { id } = tab.lastCall();
    expect(tab.ofType("go")).toEqual([]);
    tab.ack(id);
    expect(tab.ofType("go")).toEqual([id]);
    tab.emitMessage(result(id));
    await expect(promise).resolves.toBe("ok");
  });

  it("exactly once: a missed ack re-routes to B, and A's late ack gets cancel, never go", async () => {
    const a = acking("user-a");
    vi.advanceTimersByTime(1);
    const b = acking("user-a");
    vi.advanceTimersByTime(1);
    a.emitMessage(JSON.stringify({ type: "focus" })); // A is the most recent

    const promise = callTool("user-a", "get_editor_state", {});
    const idA = a.lastCall().id;
    expect(b.sent).toHaveLength(0);

    vi.advanceTimersByTime(ACK_TIMEOUT_MS);
    expect(a.terminated).toBe(false);
    expect(a.closedWith).toBeNull();
    expect(b.sent).toHaveLength(1);

    a.ack(idA); // late
    expect(a.ofType("go")).toEqual([]);
    expect(a.ofType("cancel")).toContain(idA);

    const idB = b.lastCall().id;
    b.ack(idB);
    expect(b.ofType("go")).toEqual([idB]);
    b.emitMessage(result(idB, "from-b"));
    await expect(promise).resolves.toBe("from-b");
  });

  it("does not reject A's already-acked slow call when A is marked suspect", async () => {
    const a = acking("user-a");
    vi.advanceTimersByTime(1);
    const b = acking("user-a");
    vi.advanceTimersByTime(1);
    a.emitMessage(JSON.stringify({ type: "focus" })); // A preferred
    const slow = callTool("user-a", "slow", {});
    const slowId = a.lastCall().id;
    a.ack(slowId);
    const second = callTool("user-a", "second", {});
    expect(a.ofType("tool_call")).toHaveLength(2);
    vi.advanceTimersByTime(ACK_TIMEOUT_MS); // second never acked by A: re-routed to B
    expect(b.ofType("tool_call")).toHaveLength(1);
    b.ack(b.lastCall().id);
    b.emitMessage(result(b.lastCall().id, "b"));
    await expect(second).resolves.toBe("b");
    a.emitMessage(result(slowId, "slow-done"));
    await expect(slow).resolves.toBe("slow-done");
  });

  it("keeps waiting on a single slow tab: no cancel, no suspect, success when it acks late", async () => {
    const a = acking("user-a");
    const promise = callTool("user-a", "x", {});
    const { id } = a.lastCall();
    vi.advanceTimersByTime(8_000); // past the ack timeout, still the only tab
    expect(a.ofType("cancel")).toEqual([]);
    a.ack(id);
    expect(a.ofType("go")).toEqual([id]);
    a.emitMessage(result(id, "late-but-ok"));
    await expect(promise).resolves.toBe("late-but-ok");
  });

  it("says the tab is not responding (not no-editor) when a never-acked sole tab hits the deadline", async () => {
    const a = acking("user-a");
    const settled = expect(callTool("user-a", "x", {}, "https://app.example")).rejects.toThrow(
      /Editor tab is not responding/,
    );
    vi.advanceTimersByTime(30_000);
    await settled;
    expect(a.ofType("go")).toEqual([]);
  });

  it("gives the executing tab a fresh 30s budget from go", async () => {
    const a = acking("user-a");
    const promise = callTool("user-a", "x", {});
    const { id } = a.lastCall();
    vi.advanceTimersByTime(20_000);
    a.ack(id); // go at t=20s
    vi.advanceTimersByTime(29_000); // t=49s: past the old 30s bound
    a.emitMessage(result(id, "in-budget"));
    await expect(promise).resolves.toBe("in-budget");
  });

  it("still times out 30s after go", async () => {
    const a = acking("user-a");
    const settled = expect(callTool("user-a", "x", {})).rejects.toThrow("within 30000ms");
    a.ack(a.lastCall().id);
    vi.advanceTimersByTime(30_000);
    await settled;
  });

  it("clears suspect on any later message from the tab", () => {
    const a = acking("user-a");
    const b = acking("user-a");
    void callTool("user-a", "x", {}).catch(() => {});
    vi.advanceTimersByTime(ACK_TIMEOUT_MS); // a suspect, call moved to b
    expect(b.ofType("tool_call")).toHaveLength(1);
    void callTool("user-a", "y", {}).catch(() => {});
    expect(a.ofType("tool_call")).toHaveLength(1); // suspect: not routed
    a.emitMessage(JSON.stringify({ type: "activity" }));
    void callTool("user-a", "z", {}).catch(() => {});
    expect(a.ofType("tool_call")).toHaveLength(2);
  });

  it("never fails over to another owner's session", async () => {
    const a = acking("user-a");
    const other = acking("user-b");
    const settled = expect(callTool("user-a", "x", {}, "https://app.example")).rejects.toThrow(/not responding/);
    vi.advanceTimersByTime(30_000);
    await settled;
    expect(a.ofType("cancel")).toHaveLength(1); // withdrawn only at the deadline
    expect(other.sent).toHaveLength(0);
  });

  it("applies one 30s deadline across re-routes", async () => {
    setAckTimeoutForTests(20_000);
    acking("user-a");
    acking("user-a");
    const settled = expect(callTool("user-a", "x", {})).rejects.toThrow(/not responding/);
    vi.advanceTimersByTime(20_000); // first tab missed; second attempt starts at 20s
    vi.advanceTimersByTime(10_000); // total 30s, NOT 50s
    await settled;
  });

  it("keeps today's behaviour for a session that never said hello", async () => {
    const legacy = new FakeSocket();
    registerSession(legacy, "user-a");
    const settled = expect(callTool("user-a", "x", {})).rejects.toThrow("within 30000ms");
    vi.advanceTimersByTime(ACK_TIMEOUT_MS * 3);
    expect(legacy.ofType("cancel")).toEqual([]);
    vi.advanceTimersByTime(30_000);
    await settled;
  });

  it("does not skip a healthy tab while a keepalive ping is in flight", () => {
    // The bridge no longer tracks pong state: a registered, open tab is routable.
    const tab = new FakeSocket();
    registerSession(tab, "user-a");
    vi.advanceTimersByTime(29_999);
    void callTool("user-a", "x", {}).catch(() => {});
    expect(tab.sent).toHaveLength(1);
  });
});
