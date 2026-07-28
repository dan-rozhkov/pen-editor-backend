// Shared tail of every showcase CLI: run `main` only when this module *is* the
// script being executed (importing an entrypoint — as the tests do — must not
// connect to Postgres), and turn an unhandled rejection into a tagged line plus
// a non-zero exit instead of a raw stack trace.
export function runAsScript(
  moduleUrl: string,
  tag: string,
  main: () => Promise<void>,
): void {
  const invoked = process.argv[1];
  if (!invoked || !moduleUrl.endsWith(invoked.split("/").pop()!)) return;

  main().catch((err) => {
    console.error(`[${tag}] failed:`, err);
    process.exit(1);
  });
}
