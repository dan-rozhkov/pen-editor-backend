import { describe, expect, it, vi } from "vitest";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client, uploadImage } from "../src/services/s3.js";
import { makeConfig } from "./helpers.js";

const FULL_S3 = {
  S3_ENDPOINT: "https://s3.example.test",
  S3_BUCKET: "my-bucket",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
  S3_REGION: "ru-1",
};

describe("createS3Client", () => {
  it("returns a client when all required S3 settings are present", () => {
    const client = createS3Client(makeConfig(FULL_S3));
    expect(client).toBeInstanceOf(S3Client);
  });

  it("returns null when any required S3 setting is missing", () => {
    expect(createS3Client(makeConfig())).toBeNull();
    expect(createS3Client(makeConfig({ ...FULL_S3, S3_ENDPOINT: undefined }))).toBeNull();
    expect(createS3Client(makeConfig({ ...FULL_S3, S3_BUCKET: undefined }))).toBeNull();
    expect(createS3Client(makeConfig({ ...FULL_S3, S3_ACCESS_KEY_ID: undefined }))).toBeNull();
    expect(
      createS3Client(makeConfig({ ...FULL_S3, S3_SECRET_ACCESS_KEY: undefined })),
    ).toBeNull();
  });
});

describe("uploadImage", () => {
  function fakeClient() {
    return { send: vi.fn().mockResolvedValue({}) } as unknown as S3Client;
  }

  it("uploads with a content-keyed object and returns the public URL", async () => {
    const client = fakeClient();
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const url = await uploadImage(
      client,
      "my-bucket",
      "https://s3.example.test",
      buffer,
      "image/png",
    );

    expect(url).toMatch(
      /^https:\/\/s3\.example\.test\/my-bucket\/pen-editor\/[0-9a-f-]{36}\.png$/,
    );

    expect(client.send).toHaveBeenCalledTimes(1);
    const command = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: "my-bucket",
      Body: buffer,
      ContentType: "image/png",
      ACL: "public-read",
      CacheControl: "public, max-age=31536000, immutable",
    });
    // key embedded in the URL must equal the uploaded key
    expect(`https://s3.example.test/my-bucket/${command.input.Key}`).toBe(url);
  });

  it("derives the extension from the mime type", async () => {
    const client = fakeClient();
    const url = await uploadImage(
      client,
      "b",
      "https://e.test",
      Buffer.from([0xff, 0xd8, 0xff]),
      "image/jpeg",
    );
    expect(url.endsWith(".jpg")).toBe(true);
  });

  it("generates a unique key per upload", async () => {
    const client = fakeClient();
    const url1 = await uploadImage(client, "b", "https://e.test", Buffer.from([1]), "image/png");
    const url2 = await uploadImage(client, "b", "https://e.test", Buffer.from([1]), "image/png");
    expect(url1).not.toBe(url2);
  });
});
