import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { createS3Client, uploadImage } from "../services/s3.js";

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

function parseDataUri(dataUri: string): { mimeType: string; buffer: Buffer } {
  const match = dataUri.match(/^data:(image\/[^;]+);base64,(.+)$/s);
  if (!match) {
    throw Object.assign(new Error("Invalid data URI format"), {
      statusCode: 400,
    });
  }
  const mimeType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  return { mimeType, buffer };
}

export async function uploadRoutes(app: FastifyInstance, config: Config) {
  const s3Client = createS3Client(config);

  app.post("/api/upload-image", async (request, reply) => {
    if (!s3Client || !config.S3_BUCKET || !config.S3_ENDPOINT) {
      return reply
        .status(503)
        .send({ error: "S3 storage is not configured" });
    }

    let buffer: Buffer;
    let mimeType: string;

    const contentType = request.headers["content-type"] ?? "";

    if (contentType.includes("multipart/form-data")) {
      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: "No file uploaded" });
      }
      mimeType = file.mimetype;
      buffer = await file.toBuffer();
    } else {
      const body = request.body as { image?: string } | null;
      if (!body?.image) {
        return reply.status(400).send({ error: "Missing 'image' field" });
      }
      ({ mimeType, buffer } = parseDataUri(body.image));
    }

    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return reply
        .status(400)
        .send({ error: `Unsupported image type: ${mimeType}` });
    }

    if (buffer.length > MAX_SIZE) {
      return reply
        .status(400)
        .send({ error: `Image too large: ${buffer.length} bytes (max ${MAX_SIZE})` });
    }

    const url = await uploadImage(
      s3Client,
      config.S3_BUCKET,
      config.S3_ENDPOINT,
      buffer,
      mimeType,
    );

    return reply.send({ url });
  });
}
