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
