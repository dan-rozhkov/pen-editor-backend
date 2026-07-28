import { readFlag } from "./cliFlags.js";
import { openShowcaseContext } from "./context.js";
import { resolvePinAction, runPinAction } from "./pin.js";
import { runAsScript } from "./cli.js";

// CLI entrypoint for `npm run showcase:pin`. Same wiring-only shape as the
// other showcase entrypoints: env + Postgres via openShowcaseContext, no
// browser or S3 work needed since pinning only touches showcase_screens.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const screen = readFlag(argv, "screen");
  const limitFlag = readFlag(argv, "limit");
  const run = readFlag(argv, "run");

  const action = resolvePinAction({
    screen,
    clear: argv.includes("--clear"),
    list: argv.includes("--list"),
    limit: limitFlag ? Number(limitFlag) : undefined,
    run,
  });

  const ctx = await openShowcaseContext("pin", { requireS3: false });
  try {
    await runPinAction({ store: ctx.store, log: (message) => console.log(message) }, action);
  } finally {
    await ctx.close();
  }
}

runAsScript(import.meta.url, "pin", main);
