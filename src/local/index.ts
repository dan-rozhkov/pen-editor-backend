// Entry of the local backend (`npm run build:local` → dist-local/server.mjs,
// `npm run dev:local`): Sideform Light's bundled server. Contract:
// sideform-light/CONTRACT.md "Backend" and docs/specs/2026-11-16-sideform-light-local-mode.md.
//
// Env: SIDEFORM_LOCAL_TOKEN (shared secret; required unless
// SIDEFORM_LOCAL_INSECURE_DEV=1), SIDEFORM_LOCAL_DATA_DIR (a writable dir for
// anything that needs files), PORT (0), SIDEFORM_LOCAL_EXIT_WITH_PARENT=1 (exit
// when the parent process is gone; implied under Electron's parentPort).
// Always binds 127.0.0.1.
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { installAbortRejectionGuard } from "../abortRejectionGuard.js";
import { closeAllMCPClients } from "../ai/mcp.js";
import { getAllSkills, loadSkills, setSkillsDir } from "../ai/skills.js";
import { buildLocalApp } from "./app.js";
import { loadLocalConfig } from "./config.js";
import { watchParent } from "./parentWatch.js";

// Replaced by scripts/build-local.mjs (esbuild define) with `true`; undeclared under tsx.
declare const __SIDEFORM_LOCAL_BUNDLE__: boolean | undefined;

installAbortRejectionGuard();

// Electron's utilityProcess exposes parentPort; plain node does not.
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "close", listener: () => void): unknown;
}
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

const token = process.env.SIDEFORM_LOCAL_TOKEN || undefined;
const insecureDev = process.env.SIDEFORM_LOCAL_INSECURE_DEV === "1";
if (!token && !insecureDev) {
  console.error("[local] SIDEFORM_LOCAL_TOKEN is not set. Refusing to start without it (dev only: SIDEFORM_LOCAL_INSECURE_DEV=1).");
  process.exit(1);
}

const config = loadLocalConfig();

const dataDir = process.env.SIDEFORM_LOCAL_DATA_DIR;
if (dataDir) {
  await mkdir(dataDir, { recursive: true });
  // Anything cwd-relative (e.g. .logs) lands in the app's data dir, not wherever the shell started us.
  process.chdir(dataDir);
}

// Skills ship next to the bundle (dist-local/skills); under tsx the default
// (src/skills) applies. The browser / browse turns use fixed prompts and tool
// lists (no skill catalog, no load_skill), so missing skills only disable
// /slash skill commands: warn, do not exit.
if (typeof __SIDEFORM_LOCAL_BUNDLE__ !== "undefined" && __SIDEFORM_LOCAL_BUNDLE__) {
  setSkillsDir(join(fileURLToPath(new URL(".", import.meta.url)), "skills"));
}
await loadSkills();
if (getAllSkills().length === 0) {
  console.warn("[skills] No skills loaded (skills dir missing). Continuing: browser and browse turns do not use them.");
}

const app = await buildLocalApp(config, { token, insecureDev });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await closeAllMCPClients();
    await app.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
parentPort?.on("close", shutdown);
// parentPort does not emit "close" in Electron's utilityProcess: poll the parent pid too.
if (parentPort || process.env.SIDEFORM_LOCAL_EXIT_WITH_PARENT === "1") {
  watchParent({ ppid: process.ppid, onGone: () => void shutdown() });
}

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
const { port } = app.server.address() as AddressInfo;
parentPort?.postMessage({ type: "ready", port });
console.log(`SIDEFORM_LOCAL_READY port=${port}`);
