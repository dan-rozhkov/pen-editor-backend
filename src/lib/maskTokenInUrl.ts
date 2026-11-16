// The MCP WS upgrade (GET /api/mcp/ws?token=...) carries the auth token in
// the query string. Fastify's default request logging (pino) logs req.url
// verbatim, which would put the secret in plaintext logs. This serializer
// masks any `*token=...` query param on the logged url — not just an exact
// lowercase `token=`: other routes carry differently-named secrets in their
// query string too (e.g. an editToken), and a narrower match would leave
// those in the clear. Matches case-insensitively and requires the param
// name to be preceded by `?`/`&` so it only fires inside the query string,
// never inside an unrelated path segment or value.
export function maskTokenInUrl(url: string): string {
  return url.replace(/([?&][A-Za-z0-9_]*(?:token|ticket)=)[^&]+/gi, "$1[redacted]");
}

