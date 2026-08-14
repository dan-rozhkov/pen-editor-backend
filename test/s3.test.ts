import { describe, expect, it, vi } from "vitest";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  createS3Client,
  resolveS3Acl,
  resolveS3PublicBase,
  resolveS3Target,
  uploadImage,
  type S3Target,
} from "../src/services/s3.js";
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

describe("resolveS3PublicBase", () => {
  it("defaults to endpoint + bucket for path-style providers", () => {
    expect(resolveS3PublicBase(makeConfig(FULL_S3))).toBe(
      "https://s3.example.test/my-bucket",
    );
  });

  it("prefers an explicit public base and drops its trailing slash", () => {
    // R2: writes go to the account's S3 endpoint, reads to an r2.dev domain
    // that has no bucket segment in the path at all.
    const base = resolveS3PublicBase(
      makeConfig({
        ...FULL_S3,
        S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
        S3_PUBLIC_BASE_URL: "https://pub-abc.r2.dev/",
      }),
    );
    expect(base).toBe("https://pub-abc.r2.dev");
  });

  it("returns null when S3 is unconfigured", () => {
    expect(resolveS3PublicBase(makeConfig())).toBeNull();
  });
});

describe("resolveS3Acl", () => {
  it("defaults to public-read and omits the header when blanked", () => {
    expect(resolveS3Acl(makeConfig(FULL_S3))).toBe("public-read");
    expect(resolveS3Acl(makeConfig({ ...FULL_S3, S3_OBJECT_ACL: "" }))).toBeUndefined();
  });
});

describe("resolveS3Target", () => {
  it("carries the public base, bucket and ACL together", () => {
    expect(resolveS3Target(makeConfig(FULL_S3))).toMatchObject({
      publicBase: "https://s3.example.test/my-bucket",
      bucket: "my-bucket",
      acl: "public-read",
    });
  });

  it("is null when S3 is unconfigured", () => {
    expect(resolveS3Target(makeConfig())).toBeNull();
  });
});

describe("uploadImage", () => {
  function fakeClient() {
    return { send: vi.fn().mockResolvedValue({}) } as unknown as S3Client;
  }

  function target(over: Partial<S3Target> = {}): S3Target {
    return {
      client: fakeClient(),
      publicBase: "https://s3.example.test/my-bucket",
      bucket: "my-bucket",
      acl: "public-read",
      ...over,
    };
  }

  it("omits the ACL header entirely when none is configured (R2)", async () => {
    const r2 = target({
      publicBase: "https://pub-abc.r2.dev",
      bucket: "pen-editor",
      acl: undefined,
    });
    const url = await uploadImage(r2, Buffer.from([1]), "image/png");

    expect(url).toMatch(/^https:\/\/pub-abc\.r2\.dev\/pen-editor\/[0-9a-f-]{36}\.png$/);
    const command = (r2.client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(command.input).toMatchObject({ Bucket: "pen-editor" });
    expect("ACL" in command.input).toBe(false);
  });

  it("uploads with a content-keyed object and returns the public URL", async () => {
    const t = target();
    const client = t.client;
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const url = await uploadImage(t, buffer, "image/png");

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
    const url = await uploadImage(target(), Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg");
    expect(url.endsWith(".jpg")).toBe(true);
  });

  it("generates a unique key per upload", async () => {
    const t = target();
    const url1 = await uploadImage(t, Buffer.from([1]), "image/png");
    const url2 = await uploadImage(t, Buffer.from([1]), "image/png");
    expect(url1).not.toBe(url2);
  });
});
