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

  return manifest;
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
