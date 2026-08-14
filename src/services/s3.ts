import {
  S3Client,
  PutObjectCommand,
  type ObjectCannedACL,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import { extensionForMime } from "./imageTypes.js";

export function createS3Client(config: Config): S3Client | null {
  if (
    !config.S3_ENDPOINT ||
    !config.S3_BUCKET ||
    !config.S3_ACCESS_KEY_ID ||
    !config.S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }

  return new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

// Where an object with a given key is publicly readable. Everything that
// builds or matches a stored URL goes through here rather than concatenating
// endpoint + bucket itself, so a provider that serves reads off a different
// host than it accepts writes on (R2) needs no second opinion anywhere.
// Returns null when S3 isn't configured at all.
export function resolveS3PublicBase(config: Config): string | null {
  // Endpoint+bucket are required even when an explicit public base overrides
  // the URL shape: a public base alone describes where reads would land while
  // nothing can write there, and it would still arm /api/image-proxy's
  // allowlist. Staging the new base ahead of the credential cutover must stay
  // a clean 503, not a live allowlist entry pointing at an empty host.
  if (!config.S3_ENDPOINT || !config.S3_BUCKET) return null;
  if (config.S3_PUBLIC_BASE_URL) {
    return config.S3_PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  return `${config.S3_ENDPOINT.replace(/\/$/, "")}/${config.S3_BUCKET}`;
}

// The canned ACL to send, or undefined to omit the header entirely (R2).
// The env var is a free string, so an unknown value reaches the SDK as-is and
// fails loudly at the provider rather than being silently dropped here.
export function resolveS3Acl(config: Config): ObjectCannedACL | undefined {
  return config.S3_OBJECT_ACL
    ? (config.S3_OBJECT_ACL as ObjectCannedACL)
    : undefined;
}

/**
 * Everything needed to write an object and say where it can then be read.
 *
 * An object rather than positional arguments on purpose: `publicBase` and
 * `bucket` are both strings and, on a provider like R2, hold unrelated values
 * ("https://pub-x.r2.dev" vs "pen-editor"). Passed positionally, swapping them
 * type-checks cleanly and silently PUTs into a bucket named after a URL while
 * handing back a link built from the bucket name.
 */
export interface S3Target {
  client: S3Client;
  /** Where reads land — deliberately not the SDK endpoint, see resolveS3PublicBase. */
  publicBase: string;
  bucket: string;
  /**
   * Required, deliberately without a default: `resolveS3Acl` returns undefined
   * to mean "send no ACL header at all" (R2), and a default value would quietly
   * turn that back into public-read at every call site.
   */
  acl: ObjectCannedACL | undefined;
}

/** Builds the target from config; null when S3 isn't configured. */
export function resolveS3Target(config: Config): S3Target | null {
  const client = createS3Client(config);
  const publicBase = resolveS3PublicBase(config);
  if (!client || !publicBase || !config.S3_BUCKET) return null;
  return {
    client,
    publicBase,
    bucket: config.S3_BUCKET,
    acl: resolveS3Acl(config),
  };
}

// General-purpose PUT to a publicly readable bucket key, returning the public
// URL. The single place that actually talks to S3 — uploadImage (below) and the
// showcase run (src/showcase/run.ts) both delegate here instead of each
// building their own PutObjectCommand.
export async function uploadObject(
  { client, publicBase, bucket, acl }: S3Target,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(acl ? { ACL: acl } : {}),
      // No key this function is ever called with today gets reused for
      // different content: showcase derivative WebPs are content-hashed
      // (publish.ts, reencode.ts, rescreenshot.ts), rescreenshot's repair
      // objects get a fresh randomUUID-based key every run, showcase HTML
      // keys are written once per screen and never revisited (rescreenshot
      // re-renders the image only, not the HTML), and pen-editor's own
      // uploadImage keys off randomUUID too. That is what makes a
      // year-long immutable cache safe. If a future caller ever adds a path
      // that reuses a key on purpose (e.g. overwriting HTML in place), this
      // header will make browsers/CDNs keep serving the old bytes for a
      // year — don't add one without reconsidering `immutable` for that key
      // space. See the showcase image-delivery spec for the reasoning.
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  return `${publicBase}/${key}`;
}

export async function uploadImage(
  target: S3Target,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const ext = extensionForMime(mimeType);
  const key = `pen-editor/${randomUUID()}${ext}`;
  return uploadObject(target, key, buffer, mimeType);
}
