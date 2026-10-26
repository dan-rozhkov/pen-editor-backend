import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  BROWSE_TRACE_ASSET_PATH,
  BROWSE_TRACE_ID,
  mapTraceFrames,
  parseBrowseTrace,
} from "@sideform/browser-agent/agent/session";
import type { Config } from "../config.js";
import { requireUserId } from "../auth/actor.js";
import { deleteObjects, getObjectText, resolveS3Target, uploadObject } from "../services/s3.js";
import { abortOnClientDisconnect } from "./clientDisconnect.js";
import { DASHED_UUID_RE } from "../lib/userId.js";
import { decodeImageDataUri, sniffImageType } from "../services/imageTypes.js";

// POST /api/browse/traces stores a finished cloud browse run (format and
// recorder: @sideform/browser-agent, spec docs/specs/2026-10-20-browse-run-trace-design.md)
// in the public bucket; GET /api/browse/traces/:id reads the manifest back for
// the /trace/:id viewer. The server makes the id: the UUID is the read
// capability, so it must not be guessable or chosen by the client.

const MAX_ASSETS = 160;
const MAX_ASSET_BYTES = 3 * 1024 * 1024;
// base64 is 4/3 of the bytes; reject before decoding so a huge string is never allocated.
const MAX_ASSET_DATA_URL_CHARS = Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 128;
// A DOM snapshot asset (dom/<n>.html | dom/<n>.txt): the package's default maxDomBytes.
const MAX_DOM_ASSET_BYTES = 2 * 1024 * 1024;
const MAX_DOM_DATA_URL_CHARS = Math.ceil((MAX_DOM_ASSET_BYTES * 4) / 3) + 128;
// Stored as text/plain for both extensions: the public bucket must never serve a
// DOM snapshot as HTML. The incoming data URL type is still checked per extension.
const DOM_STORED_MIME = "text/plain; charset=utf-8";
const DOM_FILE_RE = /^\d{1,4}\.(html|txt)$/;
const DOM_READ_TIMEOUT_MS = 15_000;
const DOM_DATA_URL_RE = /^data:(text\/html|text\/plain)(?:;charset=[A-Za-z0-9._-]+)?;base64,([A-Za-z0-9+/]*={0,2})$/i;
const UPLOAD_CONCURRENCY = 8;
// The stored manifest stays well under getObjectText's 8 MB read cap.
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_TRACES_PER_DAY = 200;
const MIME_FOR_EXT: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

// Per-IP and per-userId daily counters, in memory (reset on restart).
export function createDailyCap(max = MAX_TRACES_PER_DAY, now: () => Date = () => new Date()) {
  const daily = new Map<string, number>();
  const dayKey = () => now().toISOString().slice(0, 10);
  return {
    over: (keys: string[]) => keys.some((k) => (daily.get(`${dayKey()}|${k}`) ?? 0) >= max),
    bump(keys: string[]) {
      const day = dayKey();
      for (const k of daily.keys()) if (!k.startsWith(day)) daily.delete(k);
      for (const k of keys) daily.set(`${day}|${k}`, (daily.get(`${day}|${k}`) ?? 0) + 1);
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

interface DecodedAsset {
  buffer: Buffer;
  mime: string;
  // Set for DOM assets: the public bucket would serve stored HTML inline if a
  // browser opened the object URL directly. The viewer fetches the text.
  disposition?: string;
}
type DecodedAssets = { ok: true; byPath: Map<string, DecodedAsset> } | { ok: false; error: string };

function decodeDomAsset(i: number, path: string, dataUrl: string): DecodedAsset | string {
  if (dataUrl.length > MAX_DOM_DATA_URL_CHARS) return `assets[${i}]: larger than ${MAX_DOM_ASSET_BYTES} bytes`;
  const match = DOM_DATA_URL_RE.exec(dataUrl);
  if (!match || match[2]!.length % 4 !== 0) return `assets[${i}]: invalid data URI`;
  const ext = path.slice(path.lastIndexOf(".") + 1);
  const wantType = ext === "html" ? "text/html" : "text/plain";
  if (match[1]!.toLowerCase() !== wantType) return `assets[${i}]: data type does not match the path`;
  const buffer = Buffer.from(match[2]!, "base64");
  if (buffer.length > MAX_DOM_ASSET_BYTES) return `assets[${i}]: larger than ${MAX_DOM_ASSET_BYTES} bytes`;
  return { buffer, mime: DOM_STORED_MIME, disposition: "attachment" };
}

function decodeAssets(raw: unknown, referenced: Set<string>): DecodedAssets {
  if (!Array.isArray(raw)) return { ok: false, error: "assets: expected an array" };
  if (raw.length > MAX_ASSETS) return { ok: false, error: `assets: at most ${MAX_ASSETS}` };
  const byPath = new Map<string, DecodedAsset>();
  for (const [i, entry] of raw.entries()) {
    if (!isObject(entry) || typeof entry.path !== "string" || typeof entry.dataUrl !== "string") {
      return { ok: false, error: `assets[${i}]: expected { path, dataUrl }` };
    }
    const { path, dataUrl } = entry;
    if (!BROWSE_TRACE_ASSET_PATH.test(path)) return { ok: false, error: `assets[${i}]: invalid path` };
    if (byPath.has(path)) return { ok: false, error: `assets[${i}]: duplicate path` };
    if (!referenced.has(path)) return { ok: false, error: `assets[${i}]: not referenced by the manifest` };
    if (path.startsWith("dom/")) {
      const dom = decodeDomAsset(i, path, dataUrl);
      if (typeof dom === "string") return { ok: false, error: dom };
      byPath.set(path, dom);
      continue;
    }
    if (dataUrl.length > MAX_ASSET_DATA_URL_CHARS) {
      return { ok: false, error: `assets[${i}]: larger than ${MAX_ASSET_BYTES} bytes` };
    }
    const buffer = decodeImageDataUri(dataUrl);
    if (!buffer) return { ok: false, error: `assets[${i}]: invalid data URI` };
    if (buffer.length > MAX_ASSET_BYTES) {
      return { ok: false, error: `assets[${i}]: larger than ${MAX_ASSET_BYTES} bytes` };
    }
    const mime = sniffImageType(buffer);
    if (!mime) return { ok: false, error: `assets[${i}]: not a supported image` };
    if (MIME_FOR_EXT[path.slice(path.lastIndexOf(".") + 1)] !== mime) {
      return { ok: false, error: `assets[${i}]: image type does not match the path` };
    }
    byPath.set(path, { buffer, mime });
  }
  return { ok: true, byPath };
}

export async function browseTraceRoutes(app: FastifyInstance, config: Config): Promise<void> {
  const s3Target = resolveS3Target(config);
  const dailyCap = createDailyCap();

  app.post(
    "/api/browse/traces",
    {
      bodyLimit: 24 * 1024 * 1024,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const userId = await requireUserId(request, reply);
      if (!userId) return reply;
      if (!s3Target) {
        return reply.status(503).send({ error: "S3 storage is not configured" });
      }
      const body = request.body;
      if (!isObject(body)) return reply.status(400).send({ error: "Invalid body" });

      const parsed = parseBrowseTrace(body.manifest);
      if ("error" in parsed) return reply.status(400).send({ error: parsed.error });
      const manifest = parsed.trace;

      // Every frame and DOM snapshot must point at an uploaded asset: a stored frame src is
      // rendered by the viewer, so a client-chosen URL must never get through.
      const referenced = new Set<string>();
      for (const frame of manifest.frames) {
        if (!BROWSE_TRACE_ASSET_PATH.test(frame.src) || !frame.src.startsWith("frames/")) {
          return reply.status(400).send({ error: `frames[${frame.id}]: src must be an asset path` });
        }
        referenced.add(frame.src);
      }
      for (const dom of manifest.doms ?? []) {
        if (!BROWSE_TRACE_ASSET_PATH.test(dom.src) || !dom.src.startsWith("dom/")) {
          return reply.status(400).send({ error: `doms[${dom.id}]: src must be an asset path` });
        }
        referenced.add(dom.src);
      }
      const decoded = decodeAssets(body.assets, referenced);
      if (!decoded.ok) return reply.status(400).send({ error: decoded.error });
      const missing = [...referenced].find((p) => !decoded.byPath.has(p));
      if (missing) return reply.status(400).send({ error: `asset ${missing} is missing` });

      const id = randomUUID();
      const prefix = `browse-traces/${id}`;
      const urlFor = (path: string) => `${s3Target.publicBase}/${prefix}/${path}`;
      // `owner` is never stored: this object is publicly readable and an anon
      // userId is a credential elsewhere. A hash still lets us group by owner.
      // parseBrowseTrace keeps unknown fields, so a client `owner` or
      // `ownerHash` is overwritten/removed here.
      const { owner: _o, ...rest } = manifest as unknown as Record<string, unknown>;
      const mapped = mapTraceFrames(manifest, urlFor);
      const stored = {
        ...rest,
        frames: mapped.frames,
        ...(mapped.doms ? { doms: mapped.doms } : {}),
        id,
        ownerHash: createHash("sha256").update(userId).digest("hex"),
      };
      const json = Buffer.from(JSON.stringify(stored));
      if (json.length > MAX_MANIFEST_BYTES) {
        return reply.status(413).send({ error: `manifest larger than ${MAX_MANIFEST_BYTES} bytes` });
      }
      const quotaKeys = [`u|${userId}`, `ip|${request.ip}`];
      if (dailyCap.over(quotaKeys)) {
        return reply.status(429).send({ error: "Daily trace limit reached — try again tomorrow." });
      }
      dailyCap.bump(quotaKeys);

      const gone = abortOnClientDisconnect(reply);
      const written: string[] = [];
      try {
        const queue = [...decoded.byPath.entries()];
        let failed = false;
        const worker = async () => {
          for (let next = queue.shift(); next && !failed && !gone.signal.aborted; next = queue.shift()) {
            const [path, { buffer, mime, disposition }] = next;
            const key = `${prefix}/${path}`;
            written.push(key);
            try {
              await uploadObject(s3Target, key, buffer, mime, {
                abortSignal: gone.signal,
                ...(disposition ? { contentDisposition: disposition } : {}),
              });
            } catch (err) {
              failed = true;
              throw err;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
        if (gone.signal.aborted) throw new Error("client disconnected");
        // Last: a reader that finds trace.json finds every frame it points at.
        const jsonKey = `${prefix}/trace.json`;
        written.push(jsonKey);
        await uploadObject(s3Target, jsonKey, json, "application/json", { abortSignal: gone.signal });
      } catch (err) {
        // Best effort: do not leave half a trace behind.
        await deleteObjects(s3Target, written).catch(() => undefined);
        if (gone.signal.aborted) return reply;
        request.log.error({ err }, "browse trace upload failed");
        return reply.status(502).send({ error: "Trace storage failed" });
      }
      return reply.send({ id });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/browse/traces/:id",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!DASHED_UUID_RE.test(request.params.id)) return reply.status(400).send({ error: "Invalid trace id" });
      // Keys come from randomUUID (lowercase).
      const id = request.params.id.toLowerCase();
      if (!s3Target) {
        return reply.status(503).send({ error: "S3 storage is not configured" });
      }
      let text: string | null;
      try {
        text = await getObjectText(s3Target, `browse-traces/${id}/trace.json`);
      } catch (err) {
        request.log.error({ err, traceId: id }, "browse trace read failed");
        return reply.status(502).send({ error: "Trace storage failed" });
      }
      if (text === null) return reply.status(404).send({ error: "Trace not found" });
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return reply.status(404).send({ error: "Trace not found" });
      }
      if (!isObject(json)) return reply.status(404).send({ error: "Trace not found" });
      const { owner: _owner, ownerHash: _hash, ...publicTrace } = json;
      return reply.send(publicTrace);
    },
  );

  // The public bucket sends no CORS headers, so the browser viewer reads DOM text
  // through this route. Same read right as the manifest GET: the trace id.
  app.get<{ Params: { id: string; file: string } }>(
    "/api/browse/traces/:id/dom/:file",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { file } = request.params;
      if (!BROWSE_TRACE_ID.test(request.params.id)) return reply.status(400).send({ error: "Invalid trace id" });
      if (!DOM_FILE_RE.test(file)) return reply.status(400).send({ error: "Invalid DOM file" });
      const id = request.params.id.toLowerCase();
      if (!s3Target) {
        return reply.status(503).send({ error: "S3 storage is not configured" });
      }
      // No manifest check: the POST above writes a dom/<n>.* object only after
      // decodeAssets confirmed the manifest references that path (`referenced`),
      // and :id / :file are regex-constrained, so the key cannot leave this trace.
      const assetPath = `dom/${file}`;
      let text: string | null;
      try {
        text = await getObjectText(s3Target, `browse-traces/${id}/${assetPath}`, {
          maxBytes: MAX_DOM_ASSET_BYTES,
          abortSignal: AbortSignal.timeout(DOM_READ_TIMEOUT_MS),
        });
      } catch (err) {
        request.log.error({ err, traceId: id, file }, "browse trace DOM read failed");
        return reply.status(502).send({ error: "Trace storage failed" });
      }
      if (text === null) return reply.status(404).send({ error: "DOM file not found" });
      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "private, max-age=3600")
        .header("X-Content-Type-Options", "nosniff")
        .send(text);
    },
  );
}
