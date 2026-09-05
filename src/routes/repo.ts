import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  GithubNotFoundError,
  GithubRateLimitError,
  GithubUpstreamError,
  RepoRefValidationError,
  createRepoAccessCache,
  getFile,
  getRepoMeta,
  parseRepoRef,
  resolveRepoTree,
  type RepoAccessCache,
} from "../services/github.js";
import { buildDesignBrief } from "../services/repoDesignSystem.js";
import { fetchFilesWithBudget } from "../services/repoFiles.js";

// Backs the client-executed read_design_repo/read_repo_files chat tools
// (src/ai/tools.ts): the frontend proxies those tool calls to these routes.
// See CLAUDE.md's split-execution architecture — this is one of the rare
// pieces of "tool logic" that lives entirely on the backend because reading
// a GitHub repo needs no browser/scene-graph state at all.

const MAX_FILES_PER_REQUEST = 20;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const TRUNCATION_MARKER = "\n/* ... truncated ... */";
// Comfortably under the frontend tool-call timeout (25s) and typical hosting
// proxy timeouts — the files route used to fetch up to 20 paths strictly
// sequentially at up to 15s each (a ~5 minute worst case).
const FILES_REQUEST_DEADLINE_MS = 20_000;
const FILES_CONCURRENCY = 4;

const briefBodySchema = z.object({
  repo: z.string().min(1),
  ref: z.string().min(1).optional(),
});

// No leading "/", no ".." segment anywhere, no empty path.
const safeRelativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !/(^|\/)\.\.($|\/)/.test(p), {
    message: "path must be a relative path with no \"..\" segments",
  });

const filesBodySchema = z.object({
  repo: z.string().min(1),
  ref: z.string().min(1).optional(),
  paths: z.array(safeRelativePath).min(1).max(MAX_FILES_PER_REQUEST),
});

function mapGithubError(err: unknown): { status: number; message: string } {
  if (err instanceof GithubNotFoundError) {
    return { status: 404, message: err.message };
  }
  if (err instanceof RepoRefValidationError) {
    return { status: 400, message: err.message };
  }
  if (err instanceof GithubRateLimitError || err instanceof GithubUpstreamError) {
    return { status: 502, message: err.message };
  }
  // Anything else (a bug, a TypeError, an unexpected shape from GitHub) is
  // NOT the caller's fault — don't blame it on them with a 400, and don't
  // leak the raw error message either. Log it (the caller always checks
  // `status >= 500` before logging) and report a generic message.
  return { status: 500, message: "Internal error while reading the repository." };
}

// Resolves { owner, name, ref } for a request, given an optional explicit
// ref override from the request body. Shared by both routes so the
// "explicit ref wins; otherwise resolve an ambiguous /tree/<...> URL by
// trying its ref candidates" logic lives in exactly one place.
async function resolveOwnerNameRef(
  repoInput: string,
  explicitRef: string | undefined,
  config: Config,
  cache: RepoAccessCache,
): Promise<{ owner: string; name: string; ref: string }> {
  const parsedRepo = parseRepoRef(repoInput);
  const { owner, name } = parsedRepo;
  if (explicitRef) {
    return { owner, name, ref: explicitRef };
  }
  if (parsedRepo.ref) {
    return { owner, name, ref: parsedRepo.ref };
  }
  if (parsedRepo.refCandidates && parsedRepo.refCandidates.length > 0) {
    const resolved = await resolveRepoTree(owner, name, parsedRepo.refCandidates, config, cache);
    return { owner, name, ref: resolved.ref };
  }
  const meta = await getRepoMeta(owner, name, config, cache);
  return { owner, name, ref: meta.defaultBranch };
}

export async function repoRoutes(app: FastifyInstance, config: Config): Promise<void> {
  app.post(
    "/api/repo/brief",
    {
      config: {
        // Building a brief costs ~5 GitHub API calls; this bounds how often
        // a single client can burn through the (possibly unauthenticated,
        // ~60/hour) GitHub rate limit.
        rateLimit: { max: 20, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = briefBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }

      try {
        const parsedRepo = parseRepoRef(parsed.data.repo);
        const repoRef = parsed.data.ref
          ? { owner: parsedRepo.owner, name: parsedRepo.name, ref: parsed.data.ref }
          : parsedRepo;
        const brief = await buildDesignBrief(repoRef, config);
        return reply.send(brief);
      } catch (err) {
        const { status, message } = mapGithubError(err);
        if (status >= 500) app.log.error({ err }, "repo brief failed");
        return reply.status(status).send({ error: message });
      }
    },
  );

  app.post(
    "/api/repo/files",
    {
      config: {
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const parsed = filesBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? "invalid body" });
      }

      // One probe-cache and one resolved ref shared across every file in
      // this request — resolving ref/probing visibility once, not once per
      // path.
      const cache = createRepoAccessCache();
      let owner: string;
      let name: string;
      let ref: string;
      try {
        ({ owner, name, ref } = await resolveOwnerNameRef(parsed.data.repo, parsed.data.ref, config, cache));
      } catch (err) {
        const { status, message } = mapGithubError(err);
        if (status >= 500) app.log.error({ err }, "repo files: resolving repo failed");
        return reply.status(status).send({ error: message });
      }

      const outcome = await fetchFilesWithBudget(
        parsed.data.paths,
        (path) =>
          getFile(owner, name, ref, path, config, cache).then(
            (content) => (content === null ? { kind: "missing" as const } : { kind: "content" as const, content }),
            (err) => ({ kind: "error" as const, err }),
          ),
        {
          deadlineAt: Date.now() + FILES_REQUEST_DEADLINE_MS,
          concurrency: FILES_CONCURRENCY,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          maxFileBytes: MAX_FILE_BYTES,
          truncationMarker: TRUNCATION_MARKER,
        },
      );

      if (outcome.error) {
        const { status, message } = mapGithubError(outcome.error.err);
        if (status >= 500) {
          app.log.error({ err: outcome.error.err, path: outcome.error.path }, "repo files: fetch failed");
        }
        return reply.status(status).send({ error: message });
      }

      return reply.send({
        repo: { owner, name, ref },
        files: outcome.files,
        missing: outcome.missing,
        notRead: outcome.notRead,
      });
    },
  );
}
