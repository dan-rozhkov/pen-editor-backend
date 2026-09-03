import { normalizeShowcaseHtml } from "./normalizeHtml.js";
import {
  DEAD_SPACE_LIMIT_CSS_PX,
  DEVICE_SCALE_FACTOR,
  measureBottomDeadSpace,
} from "./previewDiagnostics.js";
import { showcaseViewport, type ShowcasePlatform } from "./platform.js";
import type { ScreenshotResult } from "./screenshot.js";

// The render-and-judge pass shared by `showcase:preview` (hand-authored files)
// and `showcase:generate --dry-run` (a real generation, unpublished).
//
// It lives apart from both entrypoints so the two cannot drift: a preview that
// normalizes differently from the pipeline, or judges against a different box,
// fails in exactly the way a preview exists to catch. Dependencies are
// injected rather than imported, so this module can be unit-tested without
// the Chromium that CI does not install — the type-only import of
// `ScreenshotResult` is erased at compile time and keeps `playwright` out of
// this module's graph.

export interface ScreenSource {
  /** Used in logs and the contact sheet; the PNG path is given separately. */
  label: string;
  html: string;
  pngPath: string;
}

export interface ScreenReport {
  label: string;
  pngPath: string;
  width: number;
  height: number;
  /** Defects worth a human's attention; empty means the screen passed. */
  notes: string[];
}

export interface RenderDeps {
  screenshot(html: string, platform: ShowcasePlatform): Promise<ScreenshotResult>;
  writeFile(path: string, data: Buffer): Promise<void>;
}

export async function renderAndDiagnose(
  deps: RenderDeps,
  sources: ScreenSource[],
  platform: ShowcasePlatform,
): Promise<ScreenReport[]> {
  const viewport = showcaseViewport(platform);
  const expected = {
    width: viewport.width * DEVICE_SCALE_FACTOR,
    height: viewport.height * DEVICE_SCALE_FACTOR,
  };

  const reports: ScreenReport[] = [];
  // Sequential on purpose: one page at a time is what the browser session
  // promises, and the log reads in screen order.
  for (const source of sources) {
    const html = normalizeShowcaseHtml(source.html);
    const { buffer, width, height, clipped } = await deps.screenshot(html, platform);
    await deps.writeFile(source.pngPath, buffer);

    const notes: string[] = [];
    if (width !== expected.width || height !== expected.height) {
      notes.push(`wrong size — expected ${expected.width}x${expected.height}, content overflows`);
    }
    if (clipped.length > 0) notes.push(`sliced by the bottom edge: ${clipped.join(", ")}`);

    const dead = await measureBottomDeadSpace(buffer);
    if (dead.blank) {
      notes.push("blank mount — nothing rendered, the asset wait probably timed out");
    } else if (dead.cssPx > DEAD_SPACE_LIMIT_CSS_PX) {
      notes.push(`${dead.cssPx}px of dead space at the bottom`);
    }

    reports.push({ label: source.label, pngPath: source.pngPath, width, height, notes });
  }
  return reports;
}

/** The lines an entrypoint prints for one screen. */
export function describeReport(report: ScreenReport): string[] {
  const suffix = report.notes.length === 0 ? "  ok" : "";
  return [
    `${report.pngPath} — ${report.width}x${report.height}${suffix}`,
    ...report.notes.map((note) => `  ! ${note}`),
  ];
}

/** `01-home-feed` — a sortable, filesystem-safe stem for a generated screen.
 * Screen names arrive from the model and may be non-latin or punctuated; the
 * number carries the ordering, so a name that slugifies to nothing is fine. */
export function screenFileStem(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${String(index + 1).padStart(2, "0")}-${slug || "screen"}`;
}

/** True if `entries` (filenames from a directory listing) contains a screen
 * this pass would have written — `.html` or `.png`. Callers refuse to write
 * into a directory where this is true rather than clearing it first: a
 * `--dry-run=<dir>` run into a directory that already holds screens from an
 * earlier run would judge those stale files as its own, silently, because
 * the contact sheet is built only from the current run's reports while the
 * by-eye step opens every PNG on disk. Deleting someone's files is the worse
 * failure, so the fix is to refuse, not to clean up first. */
export function containsScreenOutput(entries: string[]): boolean {
  return entries.some((entry) => entry.endsWith(".html") || entry.endsWith(".png"));
}
