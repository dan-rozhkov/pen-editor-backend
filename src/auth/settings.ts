import type { Config } from "../config.js";

// One place that turns the optional account env vars into concrete values, so
// the auth instance, the well-known routes and /api/auth-config can never
// disagree about what the public origins are.
export interface AuthSettings {
  /** Public backend origin, no trailing slash. OAuth issuer base. */
  baseUrl: string;
  /** Frontend origin, no trailing slash. */
  appOrigin: string;
  /** Canonical protected-resource URL of the remote MCP endpoint. */
  mcpResource: string;
  google: boolean;
  emailEnabled: boolean;
}

const stripSlash = (url: string): string => url.replace(/\/+$/, "");

export function resolveAuthSettings(config: Config): AuthSettings {
  const baseUrl = stripSlash(config.BETTER_AUTH_URL ?? `http://localhost:${config.PORT}`);
  return {
    baseUrl,
    // Vite's default dev port: the localhost fallback keeps `npm run dev` +
    // `npm run dev` in the frontend working without any account env vars.
    appOrigin: stripSlash(config.APP_ORIGIN ?? "http://localhost:5173"),
    mcpResource: config.MCP_RESOURCE_URL ?? `${baseUrl}/mcp`,
    google: Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
    emailEnabled: Boolean(config.RESEND_API_KEY && config.EMAIL_FROM),
  };
}
