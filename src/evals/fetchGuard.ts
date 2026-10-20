import { AsyncLocalStorage } from "node:async_hooks";

// The evals must never reach OpenRouter (docs/specs/2026-10-20-agent-evals-design.md).
// installFetchGuard wraps globalThis.fetch and rejects any request whose host
// ends in openrouter.ai. A trial runs inside runWithGuardScope so the blocked
// URL is attributed to that trial even with several trials in flight.

export class OpenRouterBlockedError extends Error {
  constructor(public readonly url: string) {
    super(`openrouter_blocked: ${url}`);
    this.name = "OpenRouterBlockedError";
  }
}

export interface GuardScope {
  blockedUrls: string[];
}

const scopeStore = new AsyncLocalStorage<GuardScope>();

export function runWithGuardScope<T>(fn: (scope: GuardScope) => Promise<T>): Promise<T> {
  const scope: GuardScope = { blockedUrls: [] };
  return scopeStore.run(scope, () => fn(scope));
}

export function isBlockedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Returns a function that restores the original fetch. */
export function installFetchGuard(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = urlOf(input);
    if (isBlockedHost(url)) {
      scopeStore.getStore()?.blockedUrls.push(url);
      return Promise.reject(new OpenRouterBlockedError(url));
    }
    return original(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}
