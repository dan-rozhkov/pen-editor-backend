// Single source of truth for supported upload image types: magic-byte
// detection and file extensions. SVG is intentionally not supported: SVG
// files can contain scripts and the bucket serves uploads publicly, which
// would enable stored XSS.

interface ImageTypeSpec {
  mime: string;
  ext: string;
  matches: (buffer: Buffer) => boolean;
}

const IMAGE_TYPES: ImageTypeSpec[] = [
  {
    mime: "image/png",
    ext: ".png",
    matches: (b) =>
      b.length >= 4 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47,
  },
  {
    mime: "image/jpeg",
    ext: ".jpg",
    matches: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/gif",
    ext: ".gif",
    matches: (b) =>
      b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("latin1", 0, 6)),
  },
  {
    mime: "image/webp",
    ext: ".webp",
    matches: (b) =>
      b.length >= 12 &&
      b.toString("latin1", 0, 4) === "RIFF" &&
      b.toString("latin1", 8, 12) === "WEBP",
  },
];

export const SUPPORTED_IMAGE_TYPES_LABEL = IMAGE_TYPES.map((t) =>
  t.mime.slice("image/".length),
).join(", ");

// Determine the real image type from file content. The client-declared MIME
// type (multipart header or data URI) is not trusted.
export function sniffImageType(buffer: Buffer): string | null {
  return IMAGE_TYPES.find((t) => t.matches(buffer))?.mime ?? null;
}

export function extensionForMime(mimeType: string): string {
  return IMAGE_TYPES.find((t) => t.mime === mimeType)?.ext ?? ".bin";
}
