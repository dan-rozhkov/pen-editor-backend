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
