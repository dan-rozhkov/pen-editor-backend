// Server-side product analytics (PostHog), additive to and distinct from
// src/analysis/ (LLM-driven content analysis of raw_traces/session_insights
// — a different, unrelated system that lives one directory over under a
// deliberately similar name). This module only ever emits coarse product
// events: enums, ids, counts, durations, model names, coarse error
// categories — NEVER prompt text, message content, document content, user
// emails, or raw error messages. See CLAUDE.md's "Analytics" section.
import { PostHog } from "posthog-node";

export interface AnalyticsEvent {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}

export interface AnalyticsClient {
  capture(event: AnalyticsEvent): void;
  shutdown(): Promise<void>;
}

// A client that does nothing: no posthog-node instance, no network calls.
// This is the default whenever POSTHOG_API_KEY is unset — dev, tests, and
// CI all get this by default, which is what keeps every capture() call safe
// to sprinkle into request paths without gating each call site on config.
const noopClient: AnalyticsClient = {
  capture() {},
  async shutdown() {},
};

// Minimal shape this module actually calls on a posthog-node `PostHog`
// instance — narrowed so `wrapPostHogClient` (below) can be exercised in
// tests against a stub that misbehaves, without constructing a real
// `PostHog` (which needs a live key / network).
export interface PostHogLike {
  capture(props: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

// Wraps a raw posthog-node-shaped client with the defensive behavior every
// call site here relies on: capture() must never throw into a request path,
// and shutdown() must never hang or reject the onClose chain. Extracted from
// createAnalyticsClient so both invariants are unit-testable against a
// client that actually throws/rejects — the real `PostHog` class doesn't
// misbehave on demand without a live key.
export function wrapPostHogClient(client: PostHogLike): AnalyticsClient {
  return {
    capture(event) {
      // Fire-and-forget, and must never throw into a request path — a
      // PostHog outage or a bad property value must not break chat/showcase/
      // image-gen. posthog-node's capture() is synchronous (queues
      // in-memory), but wrap it anyway since it's the one call site this
      // client makes from arbitrary request code.
      try {
        client.capture({
          distinctId: event.distinctId,
          event: event.event,
          properties: event.properties,
        });
      } catch (err) {
        console.error("[analytics] capture failed:", err);
      }
    },
    async shutdown() {
      // Awaited from buildApp's onClose hook so buffered events flush
      // before the process exits, mirroring traceStore/memoryStore's own
      // close() contract. Bounded and wrapped in try/catch, mirroring
      // capture()'s own defensiveness: posthog-node's shutdown() defaults to
      // a 30s internal race and rethrows non-fetch errors, and Fastify runs
      // onClose hooks LIFO — an unbounded/rejecting shutdown here would
      // delay every store's own close() registered earlier (risking a
      // SIGKILL on Render's ~30s grace period) or abort the remaining close
      // hooks outright.
      try {
        await client.shutdown(2_000);
      } catch (err) {
        console.error("[analytics] shutdown failed:", err);
      }
    },
  };
}

export function createAnalyticsClient(opts: {
  apiKey?: string;
  host?: string;
}): AnalyticsClient {
  if (!opts.apiKey) {
    return noopClient;
  }

  const client = new PostHog(opts.apiKey, {
    host: opts.host,
    // A server process handles many requests; batch instead of flushing on
    // every capture() so we don't pay a network round-trip per event, while
    // still bounding how long an event can sit unsent before a crash could
    // lose it.
    flushAt: 20,
    flushInterval: 10_000,
  });

  return wrapPostHogClient(client);
}
