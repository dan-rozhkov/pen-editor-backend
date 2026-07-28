import { readFile } from "node:fs/promises";
import { readFlag } from "./cliFlags.js";
import { replaceScreenHtml } from "./replaceHtml.js";
import { openShowcaseContext } from "./context.js";
import { runAsScript } from "./cli.js";

// CLI entrypoint for `npm run showcase:replace-html -- --screen <id> --file
// fixed.html`. Same split as the other showcase scripts: this half only reads
// argv/env and wires Postgres and S3, so it is excluded from coverage while
// replaceHtml.ts stays measured.
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const id = readFlag(argv, "screen");
  const file = readFlag(argv, "file");

  if (!id || !file) {
    console.error(
      "[replace-html] usage: npm run showcase:replace-html -- --screen <screen-id> --file <path.html>",
    );
    process.exit(1);
  }

  const html = await readFile(file, "utf8");
  const ctx = await openShowcaseContext("replace-html");
  try {
    const result = await replaceScreenHtml(
      {
        store: ctx.store,
        uploadHtml: (key, body) => ctx.upload(key, body, "text/html; charset=utf-8"),
        log: (message) => console.log(message),
      },
      { id, html },
    );
    console.log(`[replace-html] was: ${result.previousHtmlUrl}`);
    console.log(
      `[replace-html] now re-render it: npm run showcase:rescreenshot -- --app ${result.id} --force`,
    );
  } finally {
    await ctx.close();
  }
}

runAsScript(import.meta.url, "replace-html", main);
