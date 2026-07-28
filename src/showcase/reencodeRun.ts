import { reencodeScreens } from "./reencode.js";
import { openShowcaseContext } from "./context.js";
import { runAsScript } from "./cli.js";
import { parseCommonRepairFlags } from "./cliFlags.js";

// A single stuck object on Timeweb must not hang a sequential run forever —
// same reasoning as rescreenshot's Chromium timeout, applied to the plain
// `fetch` here.
const FETCH_TIMEOUT_MS = 30_000;

// CLI entrypoint for `npm run showcase:reencode`. Kept apart from
// reencode.ts for the same reason rescreenshotRun.ts is kept apart from
// rescreenshot.ts: this half only reads env and wires Postgres and S3
// together (no Chromium here — the source is the already-stored PNG, not a
// re-render), so it is excluded from coverage while the loop it drives stays
// measured.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { force, dryRun, limit } = parseCommonRepairFlags(argv, "reencode");

  const ctx = await openShowcaseContext("reencode");
  try {
    const summary = await reencodeScreens(
      {
        store: ctx.store,
        async fetchPng(url) {
          let res: Response;
          try {
            res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          } catch (err) {
            if (err instanceof Error && err.name === "TimeoutError") {
              throw new Error(`GET ${url} timed out after ${FETCH_TIMEOUT_MS}ms`, {
                cause: err,
              });
            }
            throw err;
          }
          if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        },
        uploadWebp: (key, body) => ctx.upload(key, body, "image/webp"),
        log: (message) => console.log(message),
      },
      { force, dryRun, limit },
    );

    console.log(
      `[reencode] done${dryRun ? " (dry run)" : ""} — ${summary.updated} updated, ` +
        `${summary.skipped} skipped, ${summary.failed} failed of ${summary.total}`,
    );
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await ctx.close();
  }
}

runAsScript(import.meta.url, "reencode", main);
