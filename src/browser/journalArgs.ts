// Argument parsing shared by the cloud session registry (which must validate before
// any controller exists) and toCommandRunner (which adapts HTTP args to the controller).
export const MAX_TOKEN_LENGTH = 512;
export const MAX_JOURNAL_ORIGINS = 20;
export const MAX_ORIGIN_LENGTH = 512;

/** An optional token argument (package semantics: undefined means "the default one"). */
export function tokenArg(args: unknown): { token: string | undefined } | { error: string } {
  const token = (args as { token?: unknown } | undefined)?.token;
  if (token !== undefined && (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH)) {
    return { error: `token must be a string of at most ${MAX_TOKEN_LENGTH} characters` };
  }
  return { token };
}

/** A token the HTTP caller must send (checkpoint stop/capture have no legacy callers). */
export function requiredTokenArg(args: unknown): { token: string } | { error: string } {
  const t = tokenArg(args);
  if ("error" in t) return t;
  if (t.token === undefined || t.token === "") return { error: "token is required" };
  return { token: t.token };
}

function isHttpOrigin(o: string): boolean {
  try {
    const u = new URL(o);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === o;
  } catch {
    return false;
  }
}

/** `origins` for startJournal: omitted, or an array (possibly empty) of http(s) origins. */
export function originsArg(args: unknown): { origins: string[] | undefined } | { error: string } {
  const origins = (args as { origins?: unknown } | undefined)?.origins;
  if (origins === undefined) return { origins: undefined };
  if (
    !Array.isArray(origins) ||
    origins.length > MAX_JOURNAL_ORIGINS ||
    origins.some((o) => typeof o !== "string" || o.length > MAX_ORIGIN_LENGTH)
  ) {
    return { error: `origins must be an array of at most ${MAX_JOURNAL_ORIGINS} strings of at most ${MAX_ORIGIN_LENGTH} characters` };
  }
  if (!(origins as string[]).every(isHttpOrigin)) {
    return { error: "each origin must be an http(s) origin such as https://example.com (scheme and host only, no path)" };
  }
  return { origins: origins as string[] };
}
