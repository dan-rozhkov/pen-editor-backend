import type { Config } from "../config.js";

// Small GitHub REST client used by src/services/repoDesignSystem.ts to read
// a real product's codebase (structure + a handful of key files) so the
// design agent can reproduce it as plain HTML/CSS. No SDK dependency —
// global fetch is enough for the handful of endpoints we need.

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;

export interface RepoRef {
  owner: string;
  name: string;
  // Branch, tag or commit sha. Set only when unambiguous: either given
  // explicitly, or parsed from a `.../tree/<ref>` URL with nothing after it.
  // Undefined = caller should resolve the repo's default branch
  // (getRepoMeta), UNLESS refCandidates is present (see below).
  ref?: string;
  // Present when a `.../tree/<x>/<y>/...` URL was given and the boundary
  // between the ref and a subpath cannot be determined syntactically — a
  // branch name may itself contain "/" (e.g. "feature/my-branch"), so
  // "tree/feature/my-branch/src/app" is genuinely ambiguous between a ref
  // "feature" with subpath "my-branch/src/app" and a ref "feature/my-branch"
  // with subpath "src/app". Ordered shortest-prefix-first; a caller resolves
  // the real ref by trying each candidate against the API (see
  // resolveRepoTree below), capped at a few attempts.
  refCandidates?: string[];
  // Sub-path carried by a `.../tree/<ref>/<subpath>` URL. Informational only
  // (a naive guess when refCandidates is present) — the tree/file APIs below
  // always operate repo-wide; callers that care about a subPath filter the
  // results themselves.
  subPath?: string;
}

export class GithubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubNotFoundError";
  }
}

export class GithubRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubRateLimitError";
  }
}

export class GithubUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubUpstreamError";
  }
}

// Thrown by parseRepoRef for a genuinely malformed reference (bad shape, bad
// host, "..") — as opposed to the error classes above, which describe a
// GitHub API outcome. Kept distinct so route error-mapping can tell "the
// caller gave us garbage" (400) apart from "something unexpected blew up
// while we were building a brief" (500) — see mapGithubError in
// src/routes/repo.ts.
export class RepoRefValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoRefValidationError";
  }
}

// A repo name segment: letters, digits, `.`, `-`, `_`. Owners follow the
// same rules GitHub enforces for usernames/orgs closely enough for this
// tolerant a check. Deliberately does NOT accept "." or ".." even though the
// character class matches them — see isDotSegment below.
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/**
 * Parses a repo reference given by a user into { owner, name, ref?, subPath? }.
 * Accepts:
 *   - "owner/name"
 *   - "https://github.com/owner/name" (with or without a trailing ".git" / "/")
 *   - ".../tree/<ref>"
 *   - ".../tree/<ref>/<subpath>"
 * Throws a RepoRefValidationError for anything else.
 */
export function parseRepoRef(input: string): RepoRef {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new RepoRefValidationError("Repository reference is empty.");
  }

  let rest: string;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new RepoRefValidationError(`"${input}" is not a valid URL.`);
    }
    if (!/(^|\.)github\.com$/i.test(url.hostname)) {
      throw new RepoRefValidationError(
        `Only github.com repositories are supported, got host "${url.hostname}".`,
      );
    }
    rest = url.pathname;
  } else if (/^github\.com\//i.test(trimmed)) {
    rest = trimmed.slice(trimmed.indexOf("/"));
  } else {
    rest = trimmed;
  }

  const segments = rest.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) {
    throw new RepoRefValidationError(
      `Could not parse a repository from "${input}". Expected "owner/name" or a github.com URL.`,
    );
  }

  const [owner, rawName, maybeTree, maybeRef, ...subPathSegments] = segments;
  const name = rawName.replace(/\.git$/i, "");

  if (
    !SEGMENT_RE.test(owner) ||
    !SEGMENT_RE.test(name) ||
    isDotSegment(owner) ||
    isDotSegment(name)
  ) {
    throw new RepoRefValidationError(`Could not parse a repository from "${input}".`);
  }

  let ref: string | undefined;
  let refCandidates: string[] | undefined;
  let subPath: string | undefined;
  if (maybeTree === "tree") {
    if (!maybeRef) {
      throw new RepoRefValidationError(
        `Missing ref after "/tree/" in "${input}" — expected ".../tree/<ref>".`,
      );
    }
    if (subPathSegments.length === 0) {
      // Unambiguous: nothing follows the single segment, so it must be the
      // whole ref.
      ref = maybeRef;
    } else {
      // Ambiguous: the ref may itself contain "/" (a branch like
      // "feature/my-branch"). Offer progressively longer prefixes,
      // shortest first, capped at 3 attempts, for a caller to resolve
      // against the real API (resolveRepoTree).
      const remaining = [maybeRef, ...subPathSegments];
      refCandidates = [];
      for (let i = 1; i <= Math.min(3, remaining.length); i++) {
        refCandidates.push(remaining.slice(0, i).join("/"));
      }
      subPath = subPathSegments.join("/");
    }
  }

  return { owner, name, ref, refCandidates, subPath };
}

// Unauthenticated headers — no Authorization, even when a token is
// configured. Used for the public-repo visibility probe (see
// ensurePublicRepoAccess) so that check can never itself be answered using
// the token's elevated access.
const PUBLIC_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "User-Agent": "pen-editor-backend",
  "X-GitHub-Api-Version": "2022-11-28",
};

function authHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = { ...PUBLIC_HEADERS };
  if (config.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${config.GITHUB_TOKEN}`;
  }
  return headers;
}

async function rawGithubFetch(
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  try {
    return await fetch(`${GITHUB_API_BASE}${path}`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GithubUpstreamError(
      `Failed to reach GitHub: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function interpretGithubResponse(
  response: Response,
  path: string,
  config: Config,
): Promise<Response> {
  if (response.status === 404) {
    throw new GithubNotFoundError(`GitHub returned 404 for ${path}.`);
  }

  if (response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      throw new GithubRateLimitError(
        config.GITHUB_TOKEN
          ? "GitHub API rate limit exceeded for this token."
          : "GitHub API rate limited (unauthenticated requests are capped at ~60/hour) — set GITHUB_TOKEN to raise the limit.",
      );
    }
    const body = await response.text().catch(() => "");
    throw new GithubUpstreamError(
      `GitHub returned 403 for ${path}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GithubUpstreamError(
      `GitHub returned ${response.status} for ${path}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }

  return response;
}

async function githubFetch(path: string, config: Config): Promise<Response> {
  const response = await rawGithubFetch(path, authHeaders(config));
  return interpretGithubResponse(response, path, config);
}

// Per-request cache for the public-repo probe below. A fresh Map should be
// created once per incoming HTTP request (see routes/repo.ts) and threaded
// through every github.ts call for that request — sharing it is what turns
// "one probe per repo" into the actual behavior instead of "one probe per
// file".
export type RepoAccessCache = Map<string, Promise<void>>;

export function createRepoAccessCache(): RepoAccessCache {
  return new Map();
}

/**
 * SECURITY GATE: must run before any token-bearing request for a given
 * repo. `.env.example`/config.ts document GITHUB_TOKEN as giving access to
 * the token owner's private repos, but every route here is unauthenticated
 * — without this check, this feature would be an unauthenticated proxy onto
 * the token owner's private source for anyone on the internet.
 *
 * Proves the repo is publicly visible with an UNAUTHENTICATED request
 * (never the configured token) before letting the caller proceed to make
 * token-bearing requests against it. A 404 on the unauthenticated probe is
 * surfaced as the same GithubNotFoundError a real 404 would be — this never
 * falls through to an authenticated retry, which is exactly the shape a
 * private-repo leak would take.
 *
 * GITHUB_ALLOW_PRIVATE_REPOS is an explicit opt-out for a trusted,
 * single-operator deployment that wants the agent to read the token owner's
 * own private repos.
 */
export async function ensurePublicRepoAccess(
  owner: string,
  name: string,
  config: Config,
  cache: RepoAccessCache,
): Promise<void> {
  if (config.GITHUB_ALLOW_PRIVATE_REPOS) return;

  const key = `${owner}/${name}`;
  let probe = cache.get(key);
  if (!probe) {
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    probe = rawGithubFetch(path, PUBLIC_HEADERS).then(async (response) => {
      await interpretGithubResponse(response, path, config);
      // interpretGithubResponse throws on 404/403/other non-ok statuses; if
      // it resolves, the repo answered an unauthenticated request, i.e. it
      // is public.
    });
    cache.set(key, probe);
  }
  await probe;
}

export interface RepoMeta {
  defaultBranch: string;
  htmlUrl: string;
}

export async function getRepoMeta(
  owner: string,
  name: string,
  config: Config,
  cache: RepoAccessCache,
): Promise<RepoMeta> {
  await ensurePublicRepoAccess(owner, name, config, cache);
  const response = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    config,
  );
  const data = (await response.json()) as {
    default_branch?: string;
    html_url?: string;
  };
  return {
    defaultBranch: data.default_branch ?? "main",
    htmlUrl: data.html_url ?? `https://github.com/${owner}/${name}`,
  };
}

export interface RepoTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

export interface RepoTree {
  entries: RepoTreeEntry[];
  truncated: boolean;
}

// Percent-encodes a ref for use as a path segment, WITHOUT encoding the "/"
// separators a multi-segment branch name (e.g. "feature/my-branch")
// legitimately contains — encodeURIComponent(ref) would turn those into
// "%2F", which GitHub's tree API does not resolve back to a real ref.
function encodeRefPathSegment(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

export async function getRepoTree(
  owner: string,
  name: string,
  ref: string,
  config: Config,
  cache: RepoAccessCache,
): Promise<RepoTree> {
  await ensurePublicRepoAccess(owner, name, config, cache);
  const response = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeRefPathSegment(ref)}?recursive=1`,
    config,
  );
  const data = (await response.json()) as {
    tree?: Array<{ path?: string; type?: string; size?: number }>;
    truncated?: boolean;
  };
  const entries: RepoTreeEntry[] = (data.tree ?? [])
    .filter(
      (item): item is { path: string; type: string; size?: number } =>
        typeof item.path === "string" && typeof item.type === "string",
    )
    .map((item) => ({
      path: item.path,
      type: item.type as RepoTreeEntry["type"],
      size: item.size,
    }));
  return { entries, truncated: data.truncated === true };
}

/**
 * Resolves an ambiguous set of ref candidates (see RepoRef.refCandidates)
 * against the real API by trying the shortest candidate first and
 * progressively longer ones on a 404 — capped at refCandidates.length (the
 * caller already caps that list at 3). A non-404 error aborts immediately
 * rather than trying the next candidate, since it isn't evidence the ref was
 * wrong.
 */
export async function resolveRepoTree(
  owner: string,
  name: string,
  refCandidates: string[],
  config: Config,
  cache: RepoAccessCache,
): Promise<{ ref: string; tree: RepoTree }> {
  let lastNotFound: GithubNotFoundError | undefined;
  for (const candidate of refCandidates) {
    try {
      const tree = await getRepoTree(owner, name, candidate, config, cache);
      return { ref: candidate, tree };
    } catch (err) {
      if (err instanceof GithubNotFoundError) {
        lastNotFound = err;
        continue;
      }
      throw err;
    }
  }
  throw (
    lastNotFound ??
    new GithubNotFoundError(`Could not resolve a ref for ${owner}/${name}.`)
  );
}

export async function getFile(
  owner: string,
  name: string,
  ref: string,
  path: string,
  config: Config,
  cache: RepoAccessCache,
): Promise<string | null> {
  await ensurePublicRepoAccess(owner, name, config, cache);
  let response: Response;
  try {
    response = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=${encodeURIComponent(ref)}`,
      config,
    );
  } catch (err) {
    if (err instanceof GithubNotFoundError) return null;
    throw err;
  }

  const data = (await response.json()) as {
    content?: string;
    encoding?: string;
    type?: string;
  };

  if (data.type !== "file" || typeof data.content !== "string") {
    // Directory, submodule, or symlink — not a readable text file.
    return null;
  }

  const base64 = data.content.replace(/\n/g, "");
  return Buffer.from(base64, "base64").toString("utf-8");
}
