import type { Config } from "../src/config.js";

// Fake S3 target for route tests that `vi.mock("../src/services/s3.js")`. The
// target is faked (its real form would construct an SDK client) but still
// derived from the config it is handed, so a route's 503 guard is driven by
// configuration rather than by a hardcoded stub answer. Must never import
// `src/` values: it runs inside a vi.mock factory.
export function fakeS3Target(config: Config) {
  return config.S3_BUCKET && config.S3_ENDPOINT
    ? {
        client: { sentinel: true },
        publicBase: `${config.S3_ENDPOINT}/${config.S3_BUCKET}`,
        bucket: config.S3_BUCKET,
        acl: "public-read",
      }
    : null;
}
