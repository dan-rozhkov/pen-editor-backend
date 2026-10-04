import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startKeepalive, startSessionRevalidation, KEEPALIVE_INTERVAL_MS, SESSION_REVALIDATE_INTERVAL_MS } from "../src/mcp/routes.js";
import { registerSession, resetBridgeForTests, sessionCount } from "../src/mcp/bridge.js";

// Minimal fake of the ws.WebSocket surface startKeepalive touches:
// on("pong"|"close"), ping(), terminate().
class FakeSocket {
  pings = 0;
  terminated = false;
  private listeners: Record<string, Array<() => void>> = {};

  on(event: "pong" | "close", listener: () => void): void {
    (this.listeners[event] ??= []).push(listener);
  }

  ping(): void {
    this.pings += 1;
  }

  terminate(): void {
    this.terminated = true;
  }

  emitPong(): void {
    for (const l of this.listeners.pong ?? []) l();
  }

  emitClose(): void {
    for (const l of this.listeners.close ?? []) l();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mcp WS keepalive", () => {
  it("pings on the interval and keeps the connection alive when pong replies arrive", () => {
    const socket = new FakeSocket();
    startKeepalive(socket as never);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
    expect(socket.pings).toBe(1);
    expect(socket.terminated).toBe(false);

    socket.emitPong();
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS);
    expect(socket.pings).toBe(2);
    expect(socket.terminated).toBe(false);
  });

  it("terminates the connection if no pong arrives before the next interval", () => {
    const socket = new FakeSocket();
    startKeepalive(socket as never);

    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS); // ping #1, no pong reply
    expect(socket.pings).toBe(1);
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS); // still no pong -> terminate
    expect(socket.terminated).toBe(true);
    expect(socket.pings).toBe(1); // never pinged again after terminating
  });

  it("clears the interval on close so it doesn't leak timers", () => {
    const socket = new FakeSocket();
    startKeepalive(socket as never);

    socket.emitClose();
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 5);
    expect(socket.pings).toBe(0);
    expect(socket.terminated).toBe(false);
  });
});

describe("mcp WS session revalidation timer", () => {
  it("evicts a tab whose session ended on the interval and stops after close", async () => {
    resetBridgeForTests();
    let valid = true;
    const socket = new FakeSocket() as FakeSocket & { readyState: number; send(): void; close(): void };
    socket.readyState = 1;
    socket.close = () => socket.emitClose();
    registerSession(socket as never, "user-a", { expiresAt: Date.now() + 3_600_000, isValid: async () => valid });
    startSessionRevalidation(socket as never);

    await vi.advanceTimersByTimeAsync(SESSION_REVALIDATE_INTERVAL_MS);
    expect(sessionCount()).toBe(1);
    valid = false;
    await vi.advanceTimersByTimeAsync(SESSION_REVALIDATE_INTERVAL_MS);
    expect(sessionCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
