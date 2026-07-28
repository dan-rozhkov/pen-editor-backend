import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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

// General-purpose PUT to a public-read bucket key, returning the public URL.
// The single place that actually talks to S3 — uploadImage (below) and the
// showcase run (src/showcase/run.ts) both delegate here instead of each
// building their own PutObjectCommand.
export async function uploadObject(
  client: S3Client,
  bucket: string,
  endpoint: string,
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
      ACL: "public-read",
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

  return `${endpoint}/${bucket}/${key}`;
}

export async function uploadImage(
  client: S3Client,
  bucket: string,
  endpoint: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const ext = extensionForMime(mimeType);
  const key = `pen-editor/${randomUUID()}${ext}`;
  return uploadObject(client, bucket, endpoint, key, buffer, mimeType);
}
