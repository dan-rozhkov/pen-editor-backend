import { describe, expect, it } from "vitest";
import {
  sniffImageType,
  extensionForMime,
  SUPPORTED_IMAGE_TYPES_LABEL,
} from "../src/services/imageTypes.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87 = Buffer.from("GIF87a-rest", "latin1");
const GIF89 = Buffer.from("GIF89a-rest", "latin1");
// "RIFF" + 4-byte size + "WEBP"
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "latin1"),
]);

describe("sniffImageType", () => {
  it("detects PNG by magic bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
  });

  it("detects JPEG by magic bytes", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
  });

  it("detects both GIF signatures", () => {
    expect(sniffImageType(GIF87)).toBe("image/gif");
    expect(sniffImageType(GIF89)).toBe("image/gif");
  });

  it("detects WEBP via RIFF/WEBP container markers", () => {
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("returns null for non-image data", () => {
    expect(sniffImageType(Buffer.from("hello world", "utf8"))).toBeNull();
  });

  it("rejects SVG (XSS vector — intentionally unsupported)", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
    expect(sniffImageType(svg)).toBeNull();
  });

  it("returns null for buffers too short to match a signature", () => {
    expect(sniffImageType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });

  it("does not match a RIFF container that is not WEBP", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("WAVE", "latin1"),
    ]);
    expect(sniffImageType(wav)).toBeNull();
  });
});

describe("extensionForMime", () => {
  it("maps supported mime types to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
  });

  it("falls back to .bin for unknown mime types", () => {
    expect(extensionForMime("image/svg+xml")).toBe(".bin");
    expect(extensionForMime("application/pdf")).toBe(".bin");
  });
});

describe("SUPPORTED_IMAGE_TYPES_LABEL", () => {
  it("lists the supported types without the image/ prefix", () => {
    expect(SUPPORTED_IMAGE_TYPES_LABEL).toBe("png, jpeg, gif, webp");
  });
});
