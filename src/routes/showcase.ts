import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseEnvList, type Config } from "../config.js";
import { createShowcaseStore, type ShowcaseStore, type ShowcaseScreenSource } from "../showcase/store.js";
// platform.js, not screenshot.js: the latter imports `playwright`, a
// devDependency that a production install never has.
import { showcaseViewport } from "../showcase/platform.js";
import { resolveS3PublicBase } from "../services/s3.js";

// Same pattern as `src/showcase/run.ts`/`reencodeRun.ts`: a single stuck S3
// object must not hang this request (or a whole `Promise.all`) forever.
const FETCH_TIMEOUT_MS = 10_000;
// A generous cap on one screen's HTML — these are single self-contained
// embed pages the agent authored, not arbitrary uploads, but the cap exists
// so a corrupted or maliciously huge object can't blow up this process's
// memory or bandwidth just because its `runId` is otherwise valid.
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// This route always fetches at most 5 screens (a run publishes at most 5),
// so this is a safety ceiling more than a real throttle — it keeps a future
// change to that 5-screen assumption from firing an unbounded number of
// concurrent S3 fetches from one request.
const HTML_FETCH_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

/**
 * The CSS-pixel box a screen's HTML was laid out in, derived from the stored
 * image dimensions.
 *
 * `showcase_screens.width/height` describe the **2x WebP** actually stored at
 * `image_url` (see `ShowcaseDerivativesUpdate` in showcase/store.ts), not the
 * document's own CSS size: a mobile screen is 780px wide there, and its height
 * is the full-page height, which exceeds the 844px viewport whenever the
 * content scrolls. Handing those numbers to the editor made "Open in Editor"
 * lay every screen out at 780 CSS px — a mobile design rendered at roughly
 * tablet width, hitting different media queries and coming out visibly
 * out of proportion.
 *
 * So: pin the width to the platform's authoring viewport and scale the height
 * by the same factor, which keeps a taller-than-viewport screen fully visible
 * instead of cropping it to 844px.
 */
function designSize(screen: ShowcaseScreenSource): { width: number; height: number } {
  const viewport = showcaseViewport(screen.platform);
  if (!Number.isFinite(screen.width) || screen.width <= 0) return viewport;
  const scale = viewport.width / screen.width;
  const height =
    Number.isFinite(screen.height) && screen.height > 0
      ? Math.round(screen.height * scale)
      : viewport.height;
  return { width: viewport.width, height };
}

// `limit` counts apps (gallery cards), not screens — an app publishes at most
// 5 screens, so 24 apps is ~120 screens, in the same ballpark as the old
// 50-screen ceiling.
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(24).default(12),
  cursor: z.string().optional(),
  sort: z.enum(["popular", "latest"]).default("popular"),
  category: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  // Defaults to "mobile" for backward compatibility — every client built
  // before desktop generation existed still gets exactly the feed it always
  // has.
  platform: z.enum(["mobile", "desktop"]).default("mobile"),
});

const categoriesQuerySchema = z.object({
  platform: z.enum(["mobile", "desktop"]).default("mobile"),
});

const modelsQuerySchema = z.object({
  platform: z.enum(["mobile", "desktop"]).default("mobile"),
});

const likeParamsSchema = z.object({
  runId: z.string().uuid(),
});

const appHtmlParamsSchema = z.object({
  runId: z.string().uuid(),
});

const imageProxyQuerySchema = z.object({
  url: z.string().url().max(4096),
});

// Timeweb has served the same public buckets from both hostnames over the
// lifetime of the showcase, and published HTML contains both spellings. Every
// prefix gets its twin — including migrated-away ones, which is the only case
// left once the configured base is another provider's entirely: an operator
// listing just the `.com` spelling in S3_LEGACY_PUBLIC_BASE_URLS would
// otherwise 403 every `.cloud`-spelled image in the back catalogue.
function withTimewebAlias(prefix: URL): URL[] {
  const aliasHost =
    prefix.hostname === "s3.timeweb.cloud"
      ? "s3.timeweb.com"
      : prefix.hostname === "s3.timeweb.com"
        ? "s3.timeweb.cloud"
        : null;
  if (!aliasHost) return [prefix];
  const alias = new URL(prefix.href);
  alias.hostname = aliasHost;
  return [prefix, alias];
}

function editorImagePrefixes(config: Config): URL[] {
  const base = resolveS3PublicBase(config);
  if (!base) return [];
  try {
    const prefixes = withTimewebAlias(new URL(`${base}/pen-editor/`));
    // Bases we migrated away from. Their objects stay readable (and their
    // URLs stay embedded in already-published HTML) long after we stop
    // uploading there — see S3_LEGACY_PUBLIC_BASE_URLS. A malformed entry is
    // skipped rather than taking the whole allowlist down with it.
    for (const legacy of parseEnvList(config.S3_LEGACY_PUBLIC_BASE_URLS)) {
      try {
        prefixes.push(
          ...withTimewebAlias(new URL(`${legacy.replace(/\/$/, "")}/pen-editor/`)),
        );
      } catch {
        console.warn(`[showcase] ignoring malformed legacy S3 base: ${legacy}`);
      }
    }
    return prefixes;
  } catch {
    return [];
  }
}

function isEditorImageUrl(url: URL, prefix: URL): boolean {
  return (
    url.origin === prefix.origin &&
    url.username === "" &&
    url.password === "" &&
    url.pathname.startsWith(prefix.pathname)
  );
}

// The 1..25 bound exists solely so a single request can't post `count: 1e9`
// — it is not a rate limit (there's no dedup, claps are meant to be
// repeatable).
const likeBodySchema = z.object({
  count: z.coerce.number().int().min(1).max(25),
});

export async function showcaseRoutes(
  app: FastifyInstance,
  config: Config,
  storeOverride?: ShowcaseStore | null,
): Promise<ShowcaseStore | null> {
  const store =
    storeOverride !== undefined ? storeOverride : createShowcaseStore(config);

  // Config-derived and therefore fixed for the process: computing it per
  // request would also re-log the malformed-entry warning on every proxied
  // image, which a single gallery page load fans out into dozens of lines.
  const imageProxyPrefixes = editorImagePrefixes(config);

  // Pixi uploads image pixels to WebGL, which requires a CORS-readable
  // response. Our public S3 objects are intentionally simple public files and
  // currently omit Access-Control-Allow-Origin, even though a plain <img> can
  // display them. Proxy only the immutable `pen-editor/` prefix of the
  // configured (or migrated-away) bucket — never an arbitrary caller-provided
  // host — so converted showcase photos remain renderable without creating an
  // SSRF endpoint.
  app.get("/api/image-proxy", async (request, reply) => {
    const prefixes = imageProxyPrefixes;
    if (prefixes.length === 0) {
      return reply.status(503).send({ error: "S3 storage is not configured" });
    }

    const parsed = imageProxyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid image URL" });
    }

    const imageUrl = new URL(parsed.data.url);
    if (!prefixes.some((prefix) => isEditorImageUrl(imageUrl, prefix))) {
      return reply.status(403).send({ error: "Image URL is not allowed" });
    }

    let response: Response;
    try {
      response = await fetch(imageUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      request.log.warn(
        { err: error, imageUrl: imageUrl.href },
        "image proxy fetch failed",
      );
      return reply.status(502).send({ error: "Failed to fetch image" });
    }
    if (!response.ok) {
      return reply.status(502).send({ error: "Failed to fetch image" });
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim();
    if (!contentType?.toLowerCase().startsWith("image/")) {
      return reply.status(415).send({ error: "Upstream resource is not an image" });
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
      return reply.status(413).send({ error: "Image is too large" });
    }

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return reply.status(413).send({ error: "Image is too large" });
    }

    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.type(contentType).send(Buffer.from(bytes));
  });

  app.get("/api/showcase", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Showcase storage is not configured" });
    }

    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query parameters" });
    }

    const { limit, cursor, sort, category, model, platform } = parsed.data;
    const { apps, nextCursor } = await store.listApps({
      limit,
      cursor,
      sort,
      category,
      model,
      platform,
    });

    // Explicit field lists, not the store rows: `prompt` (the full generation
    // prompt) and `pinned` stay server-side. Pin state needs no exposure —
    // the cover being first in `screens` is the whole contract.
    return reply.send({
      apps: apps.map((app) => ({
        runId: app.runId,
        theme: app.theme,
        model: app.model,
        platform: app.platform,
        createdAt: app.createdAt,
        likes: app.likes,
        screens: app.screens.map((screen) => ({
          id: screen.id,
          title: screen.title,
          imageUrl: screen.imageUrl,
          imageUrl1x: screen.imageUrl1x,
          lqip: screen.lqip,
          htmlUrl: screen.htmlUrl,
          width: screen.width,
          height: screen.height,
          createdAt: screen.createdAt,
        })),
      })),
      nextCursor,
    });
  });

  app.get("/api/showcase/categories", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Showcase storage is not configured" });
    }

    const parsed = categoriesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query parameters" });
    }

    const categories = await store.listCategories(parsed.data.platform);
    return reply.send({ categories });
  });

  app.get("/api/showcase/models", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Showcase storage is not configured" });
    }

    const parsed = modelsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid query parameters" });
    }

    const models = await store.listModels(parsed.data.platform);
    return reply.send({ models });
  });

  // The showcase's "Open in Editor" handoff (pen-editor's
  // ShowcaseAppCarousel → showcaseScreenHandoff.ts) needs the *actual HTML*
  // of every screen of an app, not just its `htmlUrl` — and a plain browser
  // `fetch(htmlUrl)` fails: the S3 bucket serving those objects returns no
  // `Access-Control-Allow-Origin` header (verified against the live bucket
  // 2026-07-29), so the CORS check rejects it before the frontend ever sees
  // a body. This route does that fetch server-side (no CORS involved
  // between two backends) and returns the HTML inline, scoped to one
  // app's *published* screens by `runId` — never an arbitrary caller-given
  // URL, so this isn't an open fetch-proxy/SSRF surface.
  app.get("/api/showcase/:runId/html", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Showcase storage is not configured" });
    }

    const params = appHtmlParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid runId" });
    }

    const screens = await store.getAppScreens(params.data.runId);
    if (screens.length === 0) {
      return reply.status(404).send({ error: "App not found" });
    }

    // One bad object must not sink the whole app: fetch every screen, log
    // and drop the ones that fail (timeout, non-2xx, or oversized), and only
    // 502 when NOT ONE screen came back — a run that has at least one good
    // screen still opens in the editor with the rest missing rather than
    // failing outright.
    const fetched = await mapWithConcurrency(
      screens,
      HTML_FETCH_CONCURRENCY,
      async (screen: ShowcaseScreenSource) => {
        try {
          let res: Response;
          try {
            res = await fetch(screen.htmlUrl, {
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
          } catch (err) {
            if (err instanceof Error && err.name === "TimeoutError") {
              throw new Error(
                `GET ${screen.htmlUrl} timed out after ${FETCH_TIMEOUT_MS}ms`,
                { cause: err },
              );
            }
            throw err;
          }
          if (!res.ok) {
            throw new Error(`GET ${screen.htmlUrl} -> ${res.status}`);
          }
          const contentLength = res.headers?.get?.("content-length");
          if (contentLength && Number(contentLength) > MAX_HTML_BYTES) {
            throw new Error(
              `GET ${screen.htmlUrl} exceeded ${MAX_HTML_BYTES} bytes (content-length: ${contentLength})`,
            );
          }
          const htmlContent = await res.text();
          if (Buffer.byteLength(htmlContent, "utf8") > MAX_HTML_BYTES) {
            throw new Error(
              `GET ${screen.htmlUrl} exceeded ${MAX_HTML_BYTES} bytes`,
            );
          }
          return {
            id: screen.id,
            title: screen.title,
            ...designSize(screen),
            htmlContent,
          };
        } catch (err) {
          request.log.error(
            { err, runId: params.data.runId, screenId: screen.id, htmlUrl: screen.htmlUrl },
            "showcase: failed to fetch a screen's HTML",
          );
          return null;
        }
      },
    );

    const withHtml = fetched.filter(
      (screen): screen is NonNullable<(typeof fetched)[number]> => screen !== null,
    );
    if (withHtml.length === 0) {
      return reply
        .status(502)
        .send({ error: "Failed to fetch any screen's HTML" });
    }

    // These objects are served `immutable` for a year in S3 (services/s3.ts)
    // and a `runId`'s screen set doesn't change once published, so this
    // aggregate response is safe to cache the same way.
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send({ screens: withHtml });
  });

  app.post("/api/showcase/:runId/like", async (request, reply) => {
    if (!store) {
      return reply
        .status(503)
        .send({ error: "Showcase storage is not configured" });
    }

    const params = likeParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "Invalid runId" });
    }
    const body = likeBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid request body" });
    }

    const likes = await store.likeApp(params.data.runId, body.data.count);
    if (likes === null) {
      return reply.status(404).send({ error: "App not found" });
    }
    return reply.send({ likes });
  });

  return store;
}
