import { randomUUID } from "node:crypto";
import type { ShowcaseScreenDraft } from "./runner.js";
import type { ShowcaseContext } from "./context.js";

// The half of a showcase run that does not care where the screens came from:
// screenshot each one, upload the PNG and the source HTML, insert a row.
// `run.ts` feeds it the output of an autonomous LLM turn; `ingestRun.ts` feeds
// it screens authored by hand. Keeping one implementation is what stops the
// two paths from drifting into differently-shaped rows in the same table.

export interface PublishDeps {
  screenshot(html: string): Promise<{ buffer: Buffer; width: number; height: number }>;
  uploadPng(key: string, body: Buffer): Promise<string>;
  uploadHtml(key: string, body: Buffer): Promise<string>;
  insertScreen(row: {
    id: string;
    runId: string;
    theme: string;
    title: string;
    prompt: string;
    model: string;
    imageUrl: string;
    htmlUrl: string;
    width: number;
    height: number;
  }): Promise<void>;
  newId(): string;
  log(message: string): void;
}

/** The live wiring of PublishDeps used by both CLI entrypoints — Postgres and
 * S3 from the shared context, Chromium from the caller's browser session. Kept
 * here so `showcase:generate` and `showcase:ingest` cannot drift into
 * different S3 content types or id sources. */
export function publishDepsFrom(
  ctx: ShowcaseContext,
  screenshot: PublishDeps["screenshot"],
): PublishDeps {
  return {
    screenshot,
    uploadPng: (key, body) => ctx.upload(key, body, "image/png"),
    uploadHtml: (key, body) => ctx.upload(key, body, "text/html; charset=utf-8"),
    insertScreen: (row) => ctx.store.insertScreen(row),
    newId: randomUUID,
    log: (message) => console.log(message),
  };
}

export interface PublishInput {
  runId: string;
  theme: string;
  prompt: string;
  model: string;
  screens: ShowcaseScreenDraft[];
}

export interface PublishedScreen {
  title: string;
  imageUrl: string;
}

export async function publishScreens(
  deps: PublishDeps,
  input: PublishInput,
): Promise<PublishedScreen[]> {
  const published: PublishedScreen[] = [];

  for (let i = 0; i < input.screens.length; i++) {
    const screen = input.screens[i];
    const index = i + 1;

    const { buffer, width, height } = await deps.screenshot(screen.htmlContent);

    const imageUrl = await deps.uploadPng(
      `showcase/${input.runId}/${index}.png`,
      buffer,
    );
    const htmlUrl = await deps.uploadHtml(
      `showcase/${input.runId}/${index}.html`,
      Buffer.from(screen.htmlContent, "utf8"),
    );

    const title = screen.name || `${input.theme} — экран ${index}`;

    await deps.insertScreen({
      id: deps.newId(),
      runId: input.runId,
      theme: input.theme,
      title,
      prompt: input.prompt,
      model: input.model,
      imageUrl,
      htmlUrl,
      width,
      height,
    });

    published.push({ title, imageUrl });
    deps.log(`[showcase] saved screen ${index}/${input.screens.length}: ${title}`);
  }

  return published;
}
