import { z } from "zod";
import { MAX_SHOWCASE_SCREENS, type ShowcaseScreenDraft } from "./runner.js";

// `npm run showcase:ingest` publishes screens that were authored by hand (or by
// an agent outside this process — e.g. Claude Code following src/skills/
// prototype.md itself) instead of by an autonomous OpenRouter turn. Everything
// downstream — screenshot, S3, Postgres — is the same code path as
// `showcase:generate`; only the source of the HTML differs.
//
// Screens may carry their HTML inline (`htmlContent`) or point at a sibling
// file (`file`). The file form exists because a screen is several hundred lines
// of HTML: embedding that in a JSON string means escaping every quote and
// newline, which is exactly the kind of transcription error that produced
// broken showcase screens before.

const screenSchema = z
  .object({
    name: z.string().min(1),
    htmlContent: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    // Marks the screen that should be pinned first in the showcase feed.
    // `--cover=<n>` (see cliFlags.ts) overrides this at publish time; the
    // manifest field exists so a hand-authored run.json is self-describing
    // without needing a CLI flag alongside it.
    cover: z.boolean().optional(),
  })
  .refine((s) => Boolean(s.htmlContent) !== Boolean(s.file), {
    message: "each screen needs exactly one of `htmlContent` or `file`",
  });

export const manifestSchema = z.object({
  theme: z.string().min(1),
  // What this run is "about" — stored per screen and shown nowhere yet, but it
  // is the only record of intent once the HTML is on S3. Defaults to the theme.
  prompt: z.string().min(1).optional(),
  // Recorded verbatim in showcase_screens.model so hand-run screens can be told
  // apart from `showcase:generate` output later.
  model: z.string().min(1).optional(),
  screens: z.array(screenSchema).min(1),
});

export type ShowcaseManifest = z.infer<typeof manifestSchema>;

export function parseManifest(raw: string): ShowcaseManifest {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${(err as Error).message}`, { cause: err });
  }

  const manifest = manifestSchema.parse(json);

  // The cap is a product decision (a short flow, not a whole app), so it holds
  // for hand-authored runs too. The autonomous runner silently drops extras
  // because a model overshooting is expected; a hand-written manifest listing
  // seven screens is a mistake worth reporting.
  if (manifest.screens.length > MAX_SHOWCASE_SCREENS) {
    throw new Error(
      `manifest lists ${manifest.screens.length} screens; the showcase keeps at most ${MAX_SHOWCASE_SCREENS}`,
    );
  }

  const coverCount = manifest.screens.filter((s) => s.cover).length;
  if (coverCount > 1) {
    throw new Error(
      `manifest marks ${coverCount} screens as \`cover: true\`; at most one screen can be the pinned cover`,
    );
  }

  return manifest;
}

/** 1-based index of the manifest's `cover: true` screen, if any — the shape
 * `PublishInput.coverIndex` expects. `parseManifest` already guarantees at
 * most one match. */
export function coverIndexFrom(manifest: ShowcaseManifest): number | undefined {
  const index = manifest.screens.findIndex((s) => s.cover);
  return index === -1 ? undefined : index + 1;
}

export interface CoverIndexInput {
  /** `readFlag(argv, "cover")` — undefined both when the flag is absent and
   * when it was given without a value; `flagPresent` disambiguates. */
  raw: string | undefined;
  /** `hasFlag(argv, "cover")` — whether `--cover` appeared in argv at all. */
  flagPresent: boolean;
  /** Manifest's own `cover: true` screen (already 1-based via
   * `coverIndexFrom`), used as the fallback when `--cover` is absent.
   * `run.ts` has no manifest, so it never passes this. */
  manifestDefault?: number;
  /** Number of screens actually available. `ingestRun.ts` knows this
   * upfront (the manifest is already resolved); `run.ts` only learns it
   * after the agent runs, so it validates format pre-run by omitting this
   * and re-validates the bound post-run by passing it. */
  screenCount?: number;
}

/** Resolves `--cover` against a manifest default and (once known) the actual
 * screen count, or throws an Error with a message ready to hand to
 * `console.error`. `--cover` given without a value is a mistake worth
 * failing loudly on — silently falling back to the manifest default (or to
 * "no cover") would mean an operator's explicit override is dropped without
 * a trace. */
export function resolveCoverIndex(input: CoverIndexInput): number | undefined {
  if (!input.flagPresent) return input.manifestDefault;

  if (input.raw === undefined) {
    throw new Error("--cover requires a value (an integer screen index)");
  }

  const coverIndex = Number(input.raw);
  if (!Number.isInteger(coverIndex) || coverIndex < 1) {
    throw new Error("--cover must be a positive integer screen index");
  }

  if (input.screenCount !== undefined && coverIndex > input.screenCount) {
    throw new Error(
      `--cover must be an integer between 1 and ${input.screenCount} (the number of screens)`,
    );
  }

  return coverIndex;
}

export interface ResolveDeps {
  /** Reads a screen's HTML file, resolved relative to the manifest. */
  readFile(relativePath: string): Promise<string>;
}

export async function resolveScreens(
  deps: ResolveDeps,
  manifest: ShowcaseManifest,
): Promise<ShowcaseScreenDraft[]> {
  const screens: ShowcaseScreenDraft[] = [];

  for (const screen of manifest.screens) {
    const htmlContent = screen.htmlContent ?? (await deps.readFile(screen.file!));
    if (!htmlContent.trim()) {
      throw new Error(`screen "${screen.name}" resolved to empty HTML`);
    }
    screens.push({ name: screen.name, htmlContent });
  }

  return screens;
}
