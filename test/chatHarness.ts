// HTTP mechanics for `/api/chat` integration tests: start the real app,
// post a turn, read the SSE body. Assertions stay in the test bodies — this
// file only hides plumbing.
//
// Pair it with chatMocks.ts (the provider/MCP mocks). This module imports
// src/app.js, so it must NOT be imported from inside a vi.mock factory —
// that is what chatMocks.ts is for.
//
// Why listen + fetch and not app.inject(): the chat route calls
// reply.hijack() and pipes to reply.raw, which inject() does not stream.
import type { FastifyInstance } from "fastify";
import { vi } from "vitest";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { Config } from "../src/config.js";
import type { RawTraceRow, TraceStore } from "../src/tracing/traceStore.js";
import type { AnalyticsClient, AnalyticsEvent } from "../src/analytics/posthog.js";
import { makeConfig } from "./helpers.js";

export interface RunningApp {
  app: FastifyInstance;
  url: string;
  close: () => Promise<void>;
}

export async function startApp(
  config: Config = makeConfig(),
  options: Omit<BuildAppOptions, "logger"> = {},
): Promise<RunningApp> {
  const app = await buildApp(config, { logger: false, ...options });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, url, close: () => app.close() };
}

export function postChat(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Posts a turn and drains the SSE body — draining is what lets the route's
// onFinish (trace write, analytics) fire.
export async function chatTurn(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ res: Response; body: string }> {
  const res = await postChat(url, body, headers);
  return { res, body: await res.text() };
}

export type SseChunk = { type?: string } & Record<string, unknown>;

// Parses the UI message stream's `data: {...}` lines; `[DONE]` is dropped.
export function parseSse(body: string): SseChunk[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data) as SseChunk);
}

export function sseChunksOfType(body: string, type: string): SseChunk[] {
  return parseSse(body).filter((chunk) => chunk.type === type);
}

// Tool calls the model handed to the client (fully-parsed inputs).
export function toolCalls(body: string): Array<{ toolName: string; input: unknown }> {
  return sseChunksOfType(body, "tool-input-available").map((c) => ({
    toolName: c.toolName as string,
    input: c.input,
  }));
}

// ---------------------------------------------------------------------------
// In-memory recorders for the buildApp() test seams.
// ---------------------------------------------------------------------------

export function recordingTraceStore(): TraceStore & { rows: RawTraceRow[] } {
  const rows: RawTraceRow[] = [];
  return {
    rows,
    writeRawTrace: async (row) => {
      rows.push(row);
    },
    close: async () => {},
  };
}

export function recordingAnalyticsClient(): AnalyticsClient & { events: AnalyticsEvent[] } {
  const events: AnalyticsEvent[] = [];
  return {
    events,
    capture(event) {
      events.push(event);
    },
    async shutdown() {},
  };
}

// Waits until the recorder has captured an event with this name (the route
// captures after the stream finishes, asynchronously) and returns it.
export function waitForEvent(
  analytics: { events: AnalyticsEvent[] },
  name: string,
): Promise<AnalyticsEvent> {
  return vi.waitFor(() => {
    const event = analytics.events.find((e) => e.event === name);
    if (!event) throw new Error(`no ${name} event captured yet`);
    return event;
  });
}
