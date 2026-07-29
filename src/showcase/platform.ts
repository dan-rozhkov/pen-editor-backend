// The showcase generates for two device classes. Everything downstream keys
// off this one type — CLI flags, the theme pool, the screenshot viewport, the
// `platform` column on `showcase_screens`, and the `/api/showcase` filter —
// so a third platform (tablet, say) would only ever need to extend this file
// and `SHOWCASE_PLATFORMS`, never be re-spelled as a string literal elsewhere.
//
// "mobile" is the default everywhere (CLI flags, the DB column, the API query
// param) for backward compatibility: every row published before this type
// existed is a phone screen, and every existing caller that doesn't yet know
// about desktop should keep behaving exactly as it did.
export type ShowcasePlatform = "mobile" | "desktop";

export const SHOWCASE_PLATFORMS: readonly ShowcasePlatform[] = ["mobile", "desktop"];

export const DEFAULT_SHOWCASE_PLATFORM: ShowcasePlatform = "mobile";

export function isShowcasePlatform(value: string): value is ShowcasePlatform {
  return (SHOWCASE_PLATFORMS as readonly string[]).includes(value);
}

// The CSS viewport each platform's screens are authored and screenshotted in.
// `deviceScaleFactor: 2` means the stored PNG/WebP comes out at 2x these — so
// these, not the stored image dimensions, are the CSS box a screen's HTML
// belongs in. Desktop's 1440x1024 matches the prototype skill's own "Otherwise
// (default desktop)" device preset (src/skills/prototype.md), same as mobile's
// 390x844 is an iPhone-ish viewport around the skill's 375x812 mobile preset.
//
// They live here, not in screenshot.ts, because screenshot.ts imports
// `playwright` — a devDependency. The API routes need these numbers to hand
// screens to the editor, and importing them from screenshot.ts would drag
// playwright into the server's module graph and crash a production install
// that never installs dev dependencies.
export const SHOWCASE_VIEWPORTS: Record<ShowcasePlatform, { width: number; height: number }> = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 1024 },
};

export function showcaseViewport(
  platform: ShowcasePlatform = DEFAULT_SHOWCASE_PLATFORM,
): { width: number; height: number } {
  return SHOWCASE_VIEWPORTS[platform];
}
