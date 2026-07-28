import { randomUUID, createHash } from "node:crypto";
import type { ShowcaseStore } from "./store.js";

// Swaps the stored HTML of a single showcase screen — the escape hatch for
// fixing markup the design agent got wrong (a clipped SVG viewBox, a typo'd
// image URL) without re-running the agent and getting a different design.
//
// The HTML is the source of truth for the image: after this, a
// `showcase:rescreenshot --app <id> --force` re-renders the screen from the
// new markup. This module deliberately does not screenshot on its own — the
// two steps stay separable so a bad edit can be re-edited before anything the
// gallery serves changes.
//
// The new markup goes to a *fresh* content-hashed key, never over the old
// one: showcase objects are uploaded `immutable` with a one-year max-age
// (services/s3.ts), so overwriting in place would leave every cache — and
// `rescreenshot`'s own fetch — reading the broken bytes for a year.

export interface ReplaceHtmlDeps {
  store: Pick<ShowcaseStore, "getScreenSource" | "updateScreenHtmlUrl">;
  uploadHtml(key: string, body: Buffer): Promise<string>;
  log?(message: string): void;
}

export interface ReplaceHtmlResult {
  id: string;
  title: string;
  previousHtmlUrl: string;
  htmlUrl: string;
}

export async function replaceScreenHtml(
  deps: ReplaceHtmlDeps,
  input: { id: string; html: string },
): Promise<ReplaceHtmlResult> {
  const log = deps.log ?? (() => {});

  const screen = await deps.store.getScreenSource(input.id);
  if (!screen) throw new Error(`no showcase screen with id ${input.id}`);

  const body = Buffer.from(input.html, "utf8");
  const sha8 = createHash("sha256").update(body).digest("hex").slice(0, 8);
  const htmlUrl = await deps.uploadHtml(
    `showcase/revision/${randomUUID()}-${sha8}.html`,
    body,
  );
  await deps.store.updateScreenHtmlUrl(screen.id, htmlUrl);

  log(`[replace-html] ${screen.title} (${screen.id}) -> ${htmlUrl}`);

  return {
    id: screen.id,
    title: screen.title,
    previousHtmlUrl: screen.htmlUrl,
    htmlUrl,
  };
}
