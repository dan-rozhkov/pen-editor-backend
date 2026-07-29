import { randomUUID, createHash } from "node:crypto";
import type { ShowcaseScreenDraft } from "./runner.js";
import type { ShowcaseContext } from "./context.js";
import { buildDerivatives } from "./derivatives.js";
import { normalizeShowcaseHtml } from "./normalizeHtml.js";
import { DEFAULT_SHOWCASE_PLATFORM, type ShowcasePlatform } from "./platform.js";

// The half of a showcase run that does not care where the screens came from:
// screenshot each one, upload the WebP derivatives and the source HTML,
// insert a row. `run.ts` feeds it the output of an autonomous LLM turn;
// `ingestRun.ts` feeds it screens authored by hand. Keeping one implementation
// is what stops the two paths from drifting into differently-shaped rows in
// the same table.

export interface PublishDeps {
  // `platform` picks the render viewport (`showcaseViewport`/
  // `SHOWCASE_VIEWPORTS`) — always the whole run's platform (see
  // `PublishInput.platform`), since one run targets exactly one device
  // class.
  screenshot(
    html: string,
    platform: ShowcasePlatform,
  ): Promise<{ buffer: Buffer; width: number; height: number }>;
  uploadWebp(key: string, body: Buffer): Promise<string>;
  uploadHtml(key: string, body: Buffer): Promise<string>;
  insertScreen(row: {
    id: string;
    runId: string;
    theme: string;
    title: string;
    prompt: string;
    model: string;
    imageUrl: string;
    imageUrl1x?: string;
    lqip?: string;
    htmlUrl: string;
    width: number;
    height: number;
    platform: ShowcasePlatform;
  }): Promise<void>;
  newId(): string;
  log(message: string): void;
  pinScreen(id: string): Promise<boolean>;
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
    uploadWebp: (key, body) => ctx.upload(key, body, "image/webp"),
    uploadHtml: (key, body) => ctx.upload(key, body, "text/html; charset=utf-8"),
    insertScreen: (row) => ctx.store.insertScreen(row),
    newId: randomUUID,
    log: (message) => console.log(message),
    pinScreen: (id) => ctx.store.pinScreen(id),
  };
}

export interface PublishInput {
  runId: string;
  theme: string;
  prompt: string;
  model: string;
  screens: ShowcaseScreenDraft[];
  // 1-based index into `screens` — the cover picked in the manifest or via
  // `--cover=<n>`. Pinned right after that screen's row is inserted so a run
  // that fails partway through never leaves a stale id to look up later.
  coverIndex?: number;
  // Defaults to "mobile" — every run targets exactly one device class, and
  // callers that predate desktop generation don't need to know this field
  // exists.
  platform?: ShowcasePlatform;
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
  const platform = input.platform ?? DEFAULT_SHOWCASE_PLATFORM;

  for (let i = 0; i < input.screens.length; i++) {
    const screen = input.screens[i];
    const index = i + 1;

    // Normalize ONCE, then screenshot and store the same string: the gallery
    // lightbox iframes the stored HTML, so a screen whose image was repaired
    // but whose HTML was not would come apart the moment a visitor opened it.
    const htmlContent = normalizeShowcaseHtml(screen.htmlContent);

    const { buffer } = await deps.screenshot(htmlContent, platform);
    const derivatives = await buildDerivatives(buffer);

    // Content hash of the 2x body, shared by both variants so one screen has
    // one hash and both objects are immutable — see the image-delivery spec.
    const sha8 = createHash("sha256")
      .update(derivatives.webp2x.body)
      .digest("hex")
      .slice(0, 8);

    const imageUrl = await deps.uploadWebp(
      `showcase/${input.runId}/${index}-${sha8}.webp`,
      derivatives.webp2x.body,
    );
    const imageUrl1x = await deps.uploadWebp(
      `showcase/${input.runId}/${index}-${sha8}@1x.webp`,
      derivatives.webp1x.body,
    );
    const htmlUrl = await deps.uploadHtml(
      `showcase/${input.runId}/${index}.html`,
      Buffer.from(htmlContent, "utf8"),
    );

    const title = screen.name || `${input.theme} — экран ${index}`;
    const id = deps.newId();

    await deps.insertScreen({
      id,
      runId: input.runId,
      theme: input.theme,
      title,
      prompt: input.prompt,
      model: input.model,
      imageUrl,
      imageUrl1x,
      lqip: derivatives.lqip,
      htmlUrl,
      platform,
      // The dimensions of the object actually stored at `imageUrl`, i.e.
      // `derivatives.webp2x`'s own dimensions — not `screenshot()`'s raw
      // `width`/`height` (buildDerivatives never resizes the 2x variant, only
      // re-encodes the format, so today these are numerically identical; but
      // reading them off the WebP itself is what makes that true by
      // construction rather than by coincidence, and matches
      // rescreenshot.ts/reencode.ts, which have no raw screenshot dimension
      // to fall back on). The frontend's srcset `w` descriptors are built
      // straight from these columns, so they must describe the served bytes.
      width: derivatives.webp2x.width,
      height: derivatives.webp2x.height,
    });

    published.push({ title, imageUrl });
    deps.log(`[showcase] saved screen ${index}/${input.screens.length}: ${title}`);

    if (input.coverIndex === index) {
      await deps.pinScreen(id);
      deps.log(`[showcase] pinned as cover: ${title}`);
    }
  }

  return published;
}
