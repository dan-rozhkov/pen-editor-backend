import { hasFlag, readFlag } from "./cliFlags.js";
import { openShowcaseContext } from "./context.js";
import { resolveDeleteAction, runDeleteAction } from "./delete.js";
import { runAsScript } from "./cli.js";

// CLI entrypoint for `npm run showcase:delete`. Wiring only, like the other
// showcase entrypoints; no S3 client because deleting only touches
// showcase_screens rows (the objects are kept — see store.deleteScreens).
//
//   npm run showcase:delete -- --app <run-id|screen-id> [--dry-run]
//   npm run showcase:delete -- --screen <screen-id> [--dry-run]
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // `hasFlag` before `readFlag`: a valueless `--app` reads back as
  // `undefined`, indistinguishable from not passing it at all, and this is
  // the one command where "I meant to name a target and fat-fingered it" must
  // not fall through to a different code path. `?? ""` turns it into the
  // explicit "requires an id" error.
  const action = resolveDeleteAction({
    app: hasFlag(argv, "app") ? (readFlag(argv, "app") ?? "") : undefined,
    screen: hasFlag(argv, "screen") ? (readFlag(argv, "screen") ?? "") : undefined,
    dryRun: argv.includes("--dry-run"),
  });

  const ctx = await openShowcaseContext("delete", { requireS3: false });
  try {
    await runDeleteAction(
      { store: ctx.store, log: (message) => console.log(message) },
      action,
    );
  } finally {
    await ctx.close();
  }
}

runAsScript(import.meta.url, "delete", main);
