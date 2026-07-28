// Optional one-off overrides for `npm run showcase:generate`:
// `--theme="заказ такси"` pins the theme instead of picking a random unused
// one, `--model=moonshotai/kimi-k2.5` swaps the generation model. Both default
// to the automatic behaviour, so the unattended cron-style invocation is
// unchanged.
//
// Lives here rather than in run.ts because that module is a script — importing
// it to test the parser would run main().
export function readFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return undefined;
}

/** True if `--name` appears in argv at all, in either the inline (`--name=x`)
 * or separated (`--name x`) form, or with no value at all (`--name` as the
 * last token, or followed by another flag). `readFlag` collapses all of the
 * valueless cases to `undefined`, which is indistinguishable from the flag
 * being absent entirely — callers that need to tell "not given" apart from
 * "given but malformed" (to error instead of silently falling back to a
 * default) check this first. */
export function hasFlag(argv: string[], name: string): boolean {
  const prefix = `--${name}=`;
  return argv.some((a) => a === `--${name}` || a.startsWith(prefix));
}

export interface CommonRepairFlags {
  force: boolean;
  dryRun: boolean;
  limit: number | undefined;
}

/** `--force` / `--dry-run` / `--limit` parsing shared by the repair-style CLI
 * entrypoints (`showcase:rescreenshot`, `showcase:reencode`) — both loop over
 * every stored screen and want the same trial-run knobs. `tag` is the
 * `[prefix]` used in the error message when `--limit` isn't a positive
 * number; on that error this exits the process, same as `openShowcaseContext`
 * does for missing env — a CLI is better served by a one-line message naming
 * the bad flag than a stack trace. */
export function parseCommonRepairFlags(argv: string[], tag: string): CommonRepairFlags {
  const force = argv.includes("--force");
  const dryRun = argv.includes("--dry-run");
  const limitFlag = readFlag(argv, "limit");
  const limit = limitFlag ? Number(limitFlag) : undefined;

  if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
    console.error(`[${tag}] --limit must be a positive number`);
    process.exit(1);
  }

  return { force, dryRun, limit };
}
