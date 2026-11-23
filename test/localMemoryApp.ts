import type { FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalApp } from "../src/local/app.js";
import { loadLocalConfig } from "../src/local/config.js";
import { createFileMemoryStore } from "../src/ai/memory/fileStore.js";

/** A listening local app with a real file memory store in a temp dir (memory route tests). */
export async function startLocalMemoryApp(token: string, dirPrefix: string): Promise<{ app: FastifyInstance; url: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), dirPrefix));
  const store = createFileMemoryStore(join(dir, "agent-memory.json"));
  const app = await buildLocalApp(loadLocalConfig({}), { logger: false, token, memoryStore: store });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    app,
    url,
    close: async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
