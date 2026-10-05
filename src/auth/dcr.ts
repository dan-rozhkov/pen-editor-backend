// RFC 7591 defaults `application_type` to "web", and Better Auth's oauth
// provider then refuses http loopback redirect URIs for it. Real MCP clients
// (Claude Code, Cursor, the MCP SDK) register `http://localhost:<port>/callback`
// and usually omit `application_type`, so they could never connect. A client
// whose redirects are ALL http loopback is a native app by definition: say so
// when it did not say otherwise. Anything explicit or non-loopback is untouched.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isHttpLoopback(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/** Returns the registration body with `application_type: "native"` added when it applies, else the input object. */
export function defaultLoopbackClientToNative(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (record.application_type !== undefined) return body;
  const uris = record.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isHttpLoopback)) return body;
  return { ...record, application_type: "native" };
}

/** Raw-body form for the Fastify catch-all; returns the same buffer when nothing changes. */
export function patchRegistrationBody(raw: Buffer): Buffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return raw;
  }
  const patched = defaultLoopbackClientToNative(parsed);
  return patched === parsed ? raw : Buffer.from(JSON.stringify(patched));
}
