import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startKeepalive, KEEPALIVE_INTERVAL_MS } from "../src/mcp/routes.js";

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
