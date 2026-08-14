import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { resolveS3Target, uploadImage } from "../services/s3.js";
import {
  sniffImageType,
  SUPPORTED_IMAGE_TYPES_LABEL,
} from "../services/imageTypes.js";

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB

function parseDataUri(dataUri: string): Buffer {
  const match = dataUri.match(/^data:image\/[^;]+;base64,(.+)$/s);
  if (!match) {
    throw Object.assign(new Error("Invalid data URI format"), {
      statusCode: 400,
    });
  }
  return Buffer.from(match[1], "base64");
}

export async function uploadRoutes(app: FastifyInstance, config: Config) {
  // One guard for the whole route: the target is null under exactly the
  // conditions that used to be checked field by field here.
  const s3Target = resolveS3Target(config);

  app.post("/api/upload-image", async (request, reply) => {
    if (!s3Target) {
      return reply
        .status(503)
        .send({ error: "S3 storage is not configured" });
    }

    let buffer: Buffer;

    const contentType = request.headers["content-type"] ?? "";

    if (contentType.includes("multipart/form-data")) {
      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: "No file uploaded" });
      }
      buffer = await file.toBuffer();
    } else {
      const body = request.body as { image?: string } | null;
      if (!body?.image) {
        return reply.status(400).send({ error: "Missing 'image' field" });
      }
      buffer = parseDataUri(body.image);
    }

    const mimeType = sniffImageType(buffer);
    if (!mimeType) {
      return reply.status(400).send({
        error: `Uploaded data is not a supported image (supported: ${SUPPORTED_IMAGE_TYPES_LABEL})`,
      });
    }

    if (buffer.length > MAX_SIZE) {
      return reply
        .status(400)
        .send({ error: `Image too large: ${buffer.length} bytes (max ${MAX_SIZE})` });
    }

    const url = await uploadImage(s3Target, buffer, mimeType);

    return reply.send({ url });
  });
}
