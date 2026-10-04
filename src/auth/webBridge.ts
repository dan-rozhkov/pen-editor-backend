import type { FastifyReply, FastifyRequest } from "fastify";

// Fastify <-> Web Request/Response conversion for handlers that speak the Web
// API (Better Auth's `handler`, the plugin's metadata responders).

export function toWebHeaders(raw: FastifyRequest["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

// Better Auth's rate limiter reads the client IP from x-forwarded-for. Never
// pass the client's own header through: overwrite it with Fastify's
// request.ip, which app.ts's `trustProxy` resolves (the peer must be a
// private/loopback proxy hop, as on Render, for XFF to count at all).
function trustedHeaders(request: FastifyRequest): Headers {
  const headers = toWebHeaders(request.headers);
  headers.set("x-forwarded-for", request.ip);
  return headers;
}

export function toWebRequest(request: FastifyRequest): Request {
  const url = new URL(request.url, `${request.protocol}://${request.host}`);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = request.body;
  return new Request(url, {
    method: request.method,
    headers: trustedHeaders(request),
    // The catch-all registers a raw (Buffer) content-type parser, so the body
    // reaches Better Auth byte-for-byte; anything else would be re-serialized.
    body: hasBody && Buffer.isBuffer(body) && body.length > 0 ? new Uint8Array(body) : undefined,
  });
}

export async function sendWebResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.status(response.status);
  for (const [name, value] of response.headers) {
    // Set-Cookie is the one header that cannot be comma-joined; it is
    // forwarded below from getSetCookie() as separate values.
    if (name.toLowerCase() !== "set-cookie") reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
  return reply.send(response.body ? Buffer.from(await response.arrayBuffer()) : null);
}
