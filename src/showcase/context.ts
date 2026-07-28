import { loadConfig, type Config } from "../config.js";
import { createPgPool } from "../tracing/traceStore.js";
import { migrate } from "../analysis/migrate.js";
import { createShowcaseStore, type ShowcaseStore } from "./store.js";
import { createS3Client, uploadObject } from "../services/s3.js";
import type { S3Client } from "@aws-sdk/client-s3";

// Env validation + Postgres/S3 wiring shared by every showcase entrypoint.
// Extracted when `showcase:ingest` became the third script needing the exact
// same twenty lines (the jscpd gate is 0.1%, but the real reason is that the
// three copies had already started to disagree about which vars they check).
//
// Exits the process on missing configuration rather than throwing: these are
// all CLI entrypoints, and a stack trace is a worse answer than the line
// naming the variable you forgot.

export interface ShowcaseContext {
  config: Config;
  store: ShowcaseStore;
  s3Client: S3Client;
  bucket: string;
  endpoint: string;
  upload(key: string, body: Buffer, contentType: string): Promise<string>;
  close(): Promise<void>;
}

export async function openShowcaseContext(tag: string): Promise<ShowcaseContext> {
  const config = loadConfig();

  if (!config.TRACE_DATABASE_URL) {
    console.error(`[${tag}] TRACE_DATABASE_URL is required`);
    process.exit(1);
  }

  const s3Client = createS3Client(config);
  if (!s3Client || !config.S3_BUCKET || !config.S3_ENDPOINT) {
    console.error(
      `[${tag}] S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are all required`,
    );
    process.exit(1);
  }
  const bucket = config.S3_BUCKET;
  const endpoint = config.S3_ENDPOINT;

  const pool = createPgPool(config.TRACE_DATABASE_URL);
  const store = createShowcaseStore(config, pool);
  if (!store) {
    console.error(`[${tag}] failed to construct showcase store`);
    process.exit(1);
  }

  const migrationClient = await pool.connect();
  try {
    const applied = await migrate(migrationClient);
    if (applied.length) {
      console.log(`[${tag}] applied migrations: ${applied.join(", ")}`);
    }
  } finally {
    migrationClient.release();
  }

  return {
    config,
    store,
    s3Client,
    bucket,
    endpoint,
    upload: (key, body, contentType) =>
      uploadObject(s3Client, bucket, endpoint, key, body, contentType),
    close: () => store.close(),
  };
}
