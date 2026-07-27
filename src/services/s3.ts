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
