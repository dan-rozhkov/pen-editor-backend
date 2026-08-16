import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import sharp from "sharp";
import type { Config } from "../config.js";
import type { ShowcaseStore } from "../showcase/store.js";
import { publishScreens, type PublishDeps } from "../showcase/publish.js";
import { MAX_SHOWCASE_SCREENS } from "../showcase/runner.js";
import { showcaseViewport, type ShowcasePlatform } from "../showcase/platform.js";
import { resolveS3Target, uploadObject, type S3Target } from "../services/s3.js";
import { sniffImageType } from "../services/imageTypes.js";
import { isPlausibleUserId } from "../lib/userId.js";
import type { AnalyticsClient } from "../analytics/posthog.js";

// POST /api/showcase/publish — the third caller of `publishScreens` (after
// `showcase:generate` and `showcase:ingest`), and the only one reachable over
// HTTP from the design agent's own tool set (`publish_to_showcase` in
// src/ai/tools.ts, client-executed on the frontend).
//
// Not authenticated, and the required `userId` below does not change that —
// it is a speed bump, not a security boundary (same framing as
// `isPlausibleUserId` and `chatBodySchema.userId` in src/routes/chat.ts):
// it stops a trivially-shaped direct `curl` from writing to the public
// homepage, nothing more. This is still the only internet-reachable write
// path onto the public homepage (every other writer into `showcase_screens`
// — `showcase:generate`, `showcase:ingest`, `showcase:pin`, `showcase:delete`
// — is an operator-run CLI with no HTTP surface). There is no unpublish
// route; cleanup after a bad publish is an operator running
// `npm run showcase:delete` by hand, using the `runId` this route returns.
//
// There is no headless browser in this path, by design: `src/showcase/
// screenshot.ts` imports `playwright`, a devDependency a production install
// never has, and this route must never import it either, directly or
// transitively. That's fine here because the screens already exist as pixels
// on the client's own canvas — the frontend rasterizes each screen itself
// with the editor's own export path (`renderNodeToCanvas`, Pixi extract +
// embed compositing, at 2x scale) and POSTs HTML + PNG. This route's job is
// to validate what the client sent, then hand it to the exact same
// `publishScreens` core the other two entrypoints use: `PublishDeps.
// screenshot(html, platform)` is injected, and the implementation below just
// returns the client-supplied PNG for whichever screen `publishScreens`'s own
// loop is currently on. `publishScreens` awaits `screenshot()` once per
// screen, strictly sequentially, in `input.screens` order — so an
// incrementing index closure over `decodedScreens` is enough to stay
// obviously correct without threading an id through. Every other step
// (normalize, WebP derivatives, LQIP, S3 keys, the DB row, the cover pin) is
// therefore byte-for-byte what `showcase:generate`/`showcase:ingest` produce.
//
// Honest caveat: `publishScreens` normalizes and stores
// `normalizeShowcaseHtml(html)`, but the client rasterized the *un-normalized*
// HTML straight off the canvas — so for a screen with unstyled form controls,
// the stored HTML's UA-reset layer (see normalizeHtml.ts) can differ very
// slightly from the pixels actually published. This is the same gap
// `showcase:ingest`'s hand-authored screens have always had; it isn't new
// here, just worth naming.

// Five 2x PNGs base64'd comfortably exceed the app-wide 10 MB bodyLimit
// (src/app.ts's Fastify instance) — this route needs its own, larger one.
const PUBLISH_BODY_LIMIT = 24 * 1024 * 1024;

// How long a publish may hold the busy flag before it's treated as
// abandoned rather than in-progress. `createS3Client` (src/services/s3.ts)
// sets no `requestTimeout`/`connectionTimeout`, so a hung PUT would
// otherwise hold `busy = true` forever — every subsequent publish 409s
// until the process is restarted. 5 minutes is generous for five sequential
// screenshot-sized S3 PUTs + a Postgres insert each, while still self-healing
// well inside an operator's patience.
export const PUBLISH_STALE_MS = 5 * 60 * 1000;

// One screen's HTML — these are single self-contained embed pages the agent
// authored on the canvas, not arbitrary uploads, but the cap still exists so
// a runaway/duplicated document can't blow up memory or the S3/Postgres
// writes that follow.
const MAX_SCREEN_HTML_BYTES = 500_000;
const MAX_TOTAL_HTML_BYTES = 2_000_000;
// Decoded (post-base64) PNG bytes, not the base64 string length.
const MAX_SCREEN_IMAGE_BYTES = 4_000_000;
const MAX_TOTAL_IMAGE_BYTES = 16_000_000;

const screenSchema = z.object({
  name: z.string().min(1).max(120),
  htmlContent: z.string().min(1),
  // A `data:image/png;base64,...` data URL, or bare base64 — either is
  // accepted; decodeImage below strips the data-URL prefix when present.
  image: z.string().min(1),
  width: z.number(),
  height: z.number(),
});

const publishBodySchema = z.object({
  theme: z.string().min(1).max(120),
  prompt: z.string().min(1).max(2000).optional(),
  model: z.string().min(1).max(120).optional(),
  platform: z.enum(["mobile", "desktop"]).optional(),
  coverIndex: z.number().int().positive().optional(),
  screens: z.array(screenSchema).min(1).max(MAX_SHOWCASE_SCREENS),
  // Same anonymous client id `/api/chat`'s `chatBodySchema.userId` carries
  // (`pen-editor/src/lib/userId.ts`, min/max mirrored from there), but
  // **required** here rather than optional. Bounded to 1..64 chars as the
  // same coarse sanity/DoS guard chat.ts uses; the actual shape check
  // (`isPlausibleUserId`) happens below, after parsing, so it can produce
  // its own clear 400 rather than a generic Zod issue.
  userId: z.string().min(1).max(64),
});

// Strict base64 charset + padding check. `Buffer.from(str, "base64")` never
// throws on invalid input — it silently drops any character outside the
// base64 alphabet instead — so without this, a corrupted payload either
// slips through as a truncated (and therefore wrong-size or non-PNG) image,
// producing a misleading "not a PNG" error, or slips past the magic-byte
// sniff and blows up later inside `buildDerivatives` as an opaque 502
// instead of an honest 400 here.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidBase64(raw: string): boolean {
  return raw.length > 0 && raw.length % 4 === 0 && BASE64_RE.test(raw);
}

function decodeImage(image: string): Buffer {
  const match = image.match(/^data:image\/[^;]+;base64,(.+)$/s);
  const raw = match ? match[1] : image;
  if (!isValidBase64(raw)) {
    throw new Error("image is not valid base64");
  }
  return Buffer.from(raw, "base64");
}

export interface ShowcasePublishDeps {
  /** Defaults to the real S3 upload (resolveS3Target + uploadObject); injected in tests. */
  upload?: (key: string, body: Buffer, contentType: string) => Promise<string>;
}

export async function showcasePublishRoutes(
  app: FastifyInstance,
  config: Config,
  store: ShowcaseStore | null,
  deps: ShowcasePublishDeps = {},
  // Null by default so every existing caller (tests, ad hoc scripts) is
  // unaffected — same undefined/null-elsewhere contract chat.ts's
  // `analytics` param follows.
  analytics: AnalyticsClient | null = null,
): Promise<void> {
  // Hoisted to registration time, not created per request: `createS3Client`
  // does `new S3Client({...})` unconditionally and it is never destroyed, so
  // resolving it inside the handler would leak one client (its own
  // credential provider + HTTP agent) on every single request, including
  // ones that immediately 400 or are rejected by auth — matches
  // src/routes/upload.ts and src/routes/showcase.ts, which both resolve
  // their S3 target once at registration too.
  const s3Target: S3Target | null = resolveS3Target(config);

  // Serializes publishes across concurrent requests. A publish fans out into
  // several sequential S3 PUTs and a Postgres insert per screen; letting a
  // second request run the same pipeline concurrently buys nothing (there is
  // one agent driving one canvas per session) and only risks unbounded
  // fan-out. A 409 gives the agent an actionable answer — retry shortly —
  // instead of leaving it to wait indefinitely on a request that was queued
  // behind another. Always cleared in `finally` so a thrown error never wedges
  // the route open forever; `busySince` backstops a HANG too (see
  // PUBLISH_STALE_MS) — `finally` only ever runs once the request actually
  // settles, one way or another, so it does nothing for a request that never
  // resolves at all (`createS3Client` sets no request/connection timeout).
  //
  // What this does NOT do, by design: it does not serialize publishes across
  // replicas (Render can scale this service out to more than one instance,
  // each with its own `busy`/`busySince` in memory), and two simultaneous
  // *legitimate* callers on the same instance get a 409 rather than a queued
  // turn. Both are accepted trade-offs for a route with roughly one caller
  // per editing session, not a design that guarantees single-flight.
  let busy = false;
  let busySince: number | null = null;

  app.post(
    "/api/showcase/publish",
    {
      bodyLimit: PUBLISH_BODY_LIMIT,
      config: {
        // Unauthenticated (userId is only shape-checked, see the route's own
        // "not a security boundary" comment above) and the one internet-
        // reachable write path onto the public homepage — each call triggers
        // real S3 PUTs plus a Postgres insert per screen. 10/min/IP is
        // generous for one live editing session publishing a batch of
        // screens, while bounding an automated loop of publishes.
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply
          .status(503)
          .send({ error: "Showcase storage is not configured" });
      }
      if (!s3Target) {
        return reply.status(503).send({ error: "S3 storage is not configured" });
      }

      const parsed = publishBodySchema.safeParse(request.body);
      if (!parsed.success) {
        // A concise `path: message` list — the caller needs to know which
        // field is wrong, not the full Zod schema shape `.format()` dumps.
        const issues = parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        );
        return reply.status(400).send({
          error: "Invalid request body",
          issues,
        });
      }
      const body = parsed.data;

      // Deliberately stricter than chat.ts: there, a shape-invalid userId is
      // treated as ABSENT and the turn just degrades to memory-free — chat
      // still works either way. Here the id is the *only* gate between a
      // stray `curl` and a write to the public homepage, so silently
      // downgrading to "no id" would defeat the point of requiring one at
      // all. Fail loudly instead.
      if (!isPlausibleUserId(body.userId)) {
        return reply.status(400).send({
          error: "userId is not a plausible client id (expected a UUID-shaped string)",
        });
      }

      if (body.coverIndex !== undefined && body.coverIndex > body.screens.length) {
        return reply.status(400).send({
          error: `coverIndex ${body.coverIndex} is out of range for ${body.screens.length} screen(s)`,
        });
      }

      if (busy) {
        const staleForMs = busySince === null ? 0 : Date.now() - busySince;
        if (staleForMs <= PUBLISH_STALE_MS) {
          return reply
            .status(409)
            .send({ error: "A showcase publish is already in progress — wait and retry" });
        }
        // The previous publish has been "in progress" longer than any real
        // publish takes — almost certainly a hung S3 PUT that will never
        // reach `finally`. Reclaim the flag instead of 409ing forever.
        app.log.warn(
          `showcase publish: reclaiming a busy flag stuck for ${staleForMs}ms (> ${PUBLISH_STALE_MS}ms) — treating the previous publish as abandoned`,
        );
      }
      busy = true;
      busySince = Date.now();

      try {
        const platform: ShowcasePlatform = body.platform ?? "mobile";
        const viewport = showcaseViewport(platform);
        const expectedWidth = viewport.width * 2;
        const expectedHeight = viewport.height * 2;

        // Validate every screen (type, CSS size, decoded pixel size, and the
        // running byte totals) before touching S3 or Postgres — so a bad
        // screen 3 of 5 never causes so much as one S3 PUT. That guarantee
        // stops here, at the end of this loop: `publishScreens` below is NOT
        // atomic. It uploads and inserts one screen at a time, so a screen
        // that passes every check above and still fails inside
        // `publishScreens` (a dropped S3 connection, a Postgres constraint,
        // …) leaves every earlier screen in this call already published and
        // already rendering as a truncated gallery card. The 502 response
        // carries `runId` and `publishedCount` for exactly that cleanup —
        // see the catch block below.
        const decodedScreens: Array<{ buffer: Buffer; width: number; height: number }> = [];
        let totalHtmlBytes = 0;
        let totalImageBytes = 0;

        for (let i = 0; i < body.screens.length; i++) {
          const screen = body.screens[i];
          const label = `screen ${i + 1} ("${screen.name}")`;

          const htmlBytes = Buffer.byteLength(screen.htmlContent, "utf8");
          if (htmlBytes > MAX_SCREEN_HTML_BYTES) {
            return reply.status(400).send({
              error: `${label}: HTML is ${htmlBytes} bytes, over the ${MAX_SCREEN_HTML_BYTES}-byte limit`,
            });
          }
          totalHtmlBytes += htmlBytes;
          if (totalHtmlBytes > MAX_TOTAL_HTML_BYTES) {
            return reply.status(400).send({
              error: `Total HTML size exceeds the ${MAX_TOTAL_HTML_BYTES}-byte limit (through ${label})`,
            });
          }

          if (
            Math.abs(screen.width - viewport.width) > 1 ||
            Math.abs(screen.height - viewport.height) > 1
          ) {
            return reply.status(400).send({
              error: `${label}: CSS size ${screen.width}x${screen.height} does not match the ${platform} viewport ${viewport.width}x${viewport.height}`,
            });
          }

          let buffer: Buffer;
          try {
            buffer = decodeImage(screen.image);
          } catch (error) {
            const reason = error instanceof Error ? error.message : "image is not valid base64";
            return reply.status(400).send({ error: `${label}: ${reason}` });
          }
          if (buffer.length === 0) {
            return reply.status(400).send({ error: `${label}: image is empty` });
          }
          if (buffer.length > MAX_SCREEN_IMAGE_BYTES) {
            return reply.status(400).send({
              error: `${label}: image is ${buffer.length} bytes, over the ${MAX_SCREEN_IMAGE_BYTES}-byte limit`,
            });
          }
          totalImageBytes += buffer.length;
          if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
            return reply.status(400).send({
              error: `Total image size exceeds the ${MAX_TOTAL_IMAGE_BYTES}-byte limit (through ${label})`,
            });
          }

          // Sniff the real type rather than trusting the client — same
          // helper src/routes/upload.ts uses. Only PNG is accepted here:
          // publishScreens/buildDerivatives assumes a PNG source.
          const mime = sniffImageType(buffer);
          if (mime !== "image/png") {
            return reply.status(400).send({
              error: `${label}: image is not a PNG (detected: ${mime ?? "unknown"})`,
            });
          }

          let metadata: { width?: number; height?: number };
          try {
            metadata = await sharp(buffer).metadata();
          } catch {
            return reply.status(400).send({ error: `${label}: PNG could not be decoded` });
          }
          const width = metadata.width;
          const height = metadata.height;
          if (
            !width ||
            !height ||
            Math.abs(width - expectedWidth) > 2 ||
            Math.abs(height - expectedHeight) > 2
          ) {
            return reply.status(400).send({
              error: `${label}: image is ${width ?? "?"}x${height ?? "?"}px, expected ~${expectedWidth}x${expectedHeight}px (2x the ${platform} viewport)`,
            });
          }

          decodedScreens.push({ buffer, width, height });
        }

        const upload =
          deps.upload ??
          ((key: string, buf: Buffer, contentType: string) =>
            uploadObject(s3Target, key, buf, contentType));

        // Walks decodedScreens in lockstep with publishScreens's own
        // sequential for-loop — see the file header comment for why this is
        // safe.
        let nextIndex = 0;
        const publishDeps: PublishDeps = {
          screenshot: async () => {
            const screen = decodedScreens[nextIndex];
            if (!screen) {
              // Unreachable while publishScreens calls this exactly once per
              // input screen; throwing beats returning undefined, which would
              // surface much later as an unreadable sharp/S3 error.
              throw new Error(
                `showcase publish: no decoded screen at index ${nextIndex}`,
              );
            }
            nextIndex += 1;
            return screen;
          },
          uploadWebp: (key, buf) => upload(key, buf, "image/webp"),
          uploadHtml: (key, buf) => upload(key, buf, "text/html; charset=utf-8"),
          insertScreen: (row) => store.insertScreen(row),
          newId: randomUUID,
          log: (message) => app.log.info(message),
          pinScreen: (id) => store.pinScreen(id),
        };

        const runId = randomUUID();
        let published;
        try {
          published = await publishScreens(publishDeps, {
            runId,
            theme: body.theme,
            prompt: body.prompt ?? body.theme,
            // Recording the author in `model` (per this repo's convention
            // for hand-authored/non-LLM runs) keeps these distinguishable in
            // `showcase_screens` from OpenRouter-generated runs.
            model: body.model ?? "pen-editor (editor handoff)",
            screens: body.screens.map((s) => ({
              name: s.name,
              htmlContent: s.htmlContent,
            })),
            coverIndex: body.coverIndex,
            platform,
          });
        } catch (error) {
          // `publishedCount` is a lower bound derived from the injected
          // `screenshot` callback's own progress, not a value publishScreens
          // returns (it only returns on full success): `nextIndex` counts
          // how many screens have had `screenshot()` invoked, and since each
          // loop iteration in publishScreens completes fully (upload +
          // insert + optional pin) before the next one calls `screenshot()`
          // again, every screen before the one currently in flight is
          // guaranteed already published. `nextIndex - 1` is that count.
          const publishedCount = Math.max(0, nextIndex - 1);
          // The raw error can be a pg constraint name or an S3
          // endpoint/bucket string — never echo it to the caller. Log the
          // real cause server-side, keyed by runId, and hand the caller only
          // what it needs to act: the runId to clean up with
          // `npm run showcase:delete --app <runId>`.
          app.log.error(
            { err: error, runId, publishedCount },
            "showcase publish: publishScreens failed partway through",
          );
          return reply.status(502).send({
            error: "Failed to publish screens to the showcase",
            runId,
            publishedCount,
          });
        }

        analytics?.capture({
          event: "showcase_published",
          distinctId: body.userId,
          properties: { screen_count: published.length, platform },
        });

        return reply.status(200).send({ runId, platform, screens: published });
      } finally {
        busy = false;
        busySince = null;
      }
    },
  );
}
