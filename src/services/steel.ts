// Thin fetch wrapper over the Steel REST API (https://api.steel.dev) — no SDK
// dependency. Spec: docs/specs/2026-09-29-cloud-browser-steel-design.md §3.3.
//
// liveViewUrl is Steel's `debugUrl`: per docs.steel.dev ("Embed Sessions →
// Live Sessions") it is THE URL meant for an <iframe>, and it is
// unauthenticated by design (no API key in it — anyone holding the URL can
// see the session, which is why it is only ever returned to the caller whose
// signed handle owns the session). `sessionViewerUrl` is the dashboard page
// instead. The API key itself never leaves the backend.

export interface SteelSession {
  id: string;
  liveViewUrl: string;
  websocketUrl: string;
  /** Steel's createdAt (ISO) + timeout (ms) from the create response, when reported. */
  createdAt?: string;
  timeoutMs?: number;
}

export interface SteelSessionStatus {
  id: string;
  status: "live" | "released" | "failed" | string;
  /** Steel's createdAt (ISO) + timeout (ms), when reported — lets a reconnect recover expiresAt. */
  createdAt?: string;
  timeoutMs?: number;
  liveViewUrl?: string;
}

export interface SteelClient {
  createSession(opts: { timeoutMs: number; dimensions: { width: number; height: number } }): Promise<SteelSession>;
  /** null when Steel no longer knows the session (404). */
  getSession(id: string): Promise<SteelSessionStatus | null>;
  releaseSession(id: string): Promise<void>;
  cdpUrl(id: string): string;
}

export class SteelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SteelError";
  }
}

export interface SteelClientOptions {
  apiKey: string;
  baseUrl?: string;
  connectUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createSteelClient(opts: SteelClientOptions): SteelClient {
  const base = (opts.baseUrl ?? "https://api.steel.dev").replace(/\/$/, "");
  const connect = opts.connectUrl ?? "wss://connect.steel.dev";
  const doFetch = opts.fetchImpl ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return doFetch(`${base}${path}`, {
      method,
      headers: { "steel-api-key": opts.apiKey, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  }

  return {
    async createSession({ timeoutMs, dimensions }) {
      const res = await call("POST", "/v1/sessions", {
        timeout: timeoutMs,
        dimensions,
        // The live view is a spectator window: the agent drives the page.
        debugConfig: { interactive: false },
      });
      if (!res.ok) throw new SteelError(`Steel createSession failed (HTTP ${res.status})`, res.status);
      const j = (await res.json()) as { id?: string; debugUrl?: string; websocketUrl?: string; createdAt?: string; timeout?: number };
      if (!j.id || !j.debugUrl) throw new SteelError("Steel createSession returned no id/debugUrl");
      return { id: j.id, liveViewUrl: j.debugUrl, websocketUrl: j.websocketUrl ?? "", createdAt: j.createdAt, timeoutMs: j.timeout };
    },
    async getSession(id) {
      const res = await call("GET", `/v1/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new SteelError(`Steel getSession failed (HTTP ${res.status})`, res.status);
      const j = (await res.json()) as { id?: string; status?: string; createdAt?: string; timeout?: number; debugUrl?: string };
      return { id: j.id ?? id, status: j.status ?? "unknown", createdAt: j.createdAt, timeoutMs: j.timeout, liveViewUrl: j.debugUrl };
    },
    async releaseSession(id) {
      const res = await call("POST", `/v1/sessions/${encodeURIComponent(id)}/release`, {});
      // 404 = already gone, which is the goal.
      if (!res.ok && res.status !== 404) throw new SteelError(`Steel releaseSession failed (HTTP ${res.status})`, res.status);
    },
    cdpUrl(id) {
      return `${connect}?apiKey=${encodeURIComponent(opts.apiKey)}&sessionId=${encodeURIComponent(id)}`;
    },
  };
}
