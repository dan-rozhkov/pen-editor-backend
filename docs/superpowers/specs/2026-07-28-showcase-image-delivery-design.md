# Showcase image delivery — WebP derivatives, immutable cache, lazy carousel

Date: 2026-07-28
Repos: `pen-editor-backend` (publish pipeline, storage, API), `pen-editor` (gallery)

## Problem

Measured on production (`https://pen-editor-backend.onrender.com/api/showcase?limit=24`,
objects on `https://s3.timeweb.com/<bucket>/showcase/...`):

| | measured |
|---|---|
| Format / size | PNG 750×1624, 100 KB – 855 KB, ~450 KB average |
| First feed page | 24 screens ⇒ **~10 MB** of images |
| Timeweb S3 delivery | TTFB 0.6–4.4 s, full transfer 4–18 s per image |
| Response headers | no `Cache-Control` at all, no CDN in front of the bucket |
| Markup | `ShowcaseCard` renders one fixed-width `<img>`, no `srcset`; the carousel keeps *every* slide of an app mounted and the slides overlap inside the viewport, so `loading="lazy"` never defers them |

Two independent causes: oversized bytes (PNG for photographic content at 2× the
displayed size) and a slow, uncached origin.

Re-encoding one real screen: **855 KB PNG → 81 KB WebP q80 @2x → 32 KB @1x** (~10×).

## Non-goals

- No CDN / image proxy in front of Timeweb. Considered and deliberately deferred:
  it fixes TTFB but needs a domain and new infrastructure. Revisit only if TTFB
  still hurts after this work.
- No change to the screenshot rendering itself (`clearBottomBarOverlap`, font/image
  readiness waits stay exactly as they are).
- No change to the lightbox: it renders the live HTML in an iframe, not the PNG.

## Design

### 1. Derivatives at publish time (backend)

New dependency: `sharp`.

New module `src/showcase/derivatives.ts`, one exported function:

```ts
export interface ScreenDerivatives {
  webp2x: { body: Buffer; width: number; height: number };
  webp1x: { body: Buffer; width: number; height: number };
  lqip: string; // data:image/webp;base64,… ~400 bytes
}
export function buildDerivatives(png: Buffer): Promise<ScreenDerivatives>;
```

- `webp2x` — native screenshot width (750px), quality 80.
- `webp1x` — half width (375px), quality 80.
- `lqip` — 16px-wide blurred WebP as a data URI, budget < 1 KB.

`publish.ts` uploads the two WebP objects and **stops uploading the PNG**. The PNG
was only ever used as `image_url`; the source of truth for re-rendering is the
stored HTML, which is unchanged.

Object keys carry a short content hash:

```
showcase/<runId>/<n>-<sha8>.webp      # 2x, image_url
showcase/<runId>/<n>-<sha8>@1x.webp   # 1x, image_url_1x
showcase/<runId>/<n>.html             # unchanged
```

The hash is the first 8 hex chars of the SHA-256 of the 2x WebP body, used for
*both* variants so one screen has one hash. This makes every object immutable:
`showcase:rescreenshot` now writes a new URL instead of overwriting a key that a
year-long cache still points at.

`uploadObject` (`src/services/s3.ts`) gains
`CacheControl: "public, max-age=31536000, immutable"` for every object it writes.
HTML keys are not content-hashed and are overwritten by `rescreenshot`; that is
acceptable because the lightbox iframe is opened on demand and a stale HTML there
is cosmetic. (If it becomes a problem, hash the HTML key the same way — out of
scope here.)

### 2. Database and API contract

Migration `src/analysis/migrations/005_showcase_derivatives.sql`:

```sql
ALTER TABLE showcase_screens
  ADD COLUMN IF NOT EXISTS image_url_1x TEXT,
  ADD COLUMN IF NOT EXISTS lqip TEXT;
```

Both nullable. A row without them renders exactly as today, so a partial backfill
is safe at every point.

- `ShowcaseScreenRow` / `insertScreen` gain `imageUrl1x?: string` and `lqip?: string`.
- `listScreens` selects and maps both; `GET /api/showcase` returns `imageUrl1x` and
  `lqip` alongside `imageUrl`.
- Sort keys are untouched, so the keyset cursor is unchanged
  (`docs/.../showcase-pinned-screen`: any new sort key must enter the cursor — none
  is added here).
- `pen-editor/src/lib/showcase.ts` mirrors the two optional fields.

### 3. Frontend

`ShowcaseCard`:

- `srcset={"<1x> 375w, <2x> 750w"}` when `imageUrl1x` is present, plain `src` otherwise.
- `sizes="(min-width:1280px) 22vw, (min-width:1024px) 30vw, (min-width:640px) 45vw, 90vw"`
  — derived from the grid (`grid-cols-1 / sm:2 / lg:3 / xl:4`) plus the carousel's
  `px-12 sm:px-16` padding.
- `lqip` painted as a `background-image` on the wrapper, cleared on the image's
  `onLoad`. This is what actually covers Timeweb's 2 s TTFB: the placeholder ships
  inside the feed JSON and paints immediately.
- New prop `eager?: boolean` → `fetchpriority="high"` when set.

`ShowcaseAppCarousel`:

- Renders the `<img>` only for slides within ±1 of the selected index; farther
  slides render the same-sized box with just the LQIP. This is the actual fix for
  "all slides load at once" — overlapping slides defeat `loading="lazy"`.
- The first card of the first app in the grid gets `eager`; everything else keeps
  `loading="lazy"`.

### 4. Backfill

New CLI `npm run showcase:reencode` (`src/showcase/reencode.ts` + `reencodeRun.ts`,
shaped after `rescreenshot.ts` / `rescreenshotRun.ts`, sharing `ShowcaseContext`):

1. List rows (id, image_url, image_url_1x).
2. Skip rows that already have `image_url_1x` unless `--force`.
3. Download the existing PNG over HTTP, run `buildDerivatives`, upload both WebPs.
4. `updateScreenDerivatives({ id, imageUrl, imageUrl1x, lqip })`.

No Chromium involved — pixels are byte-identical to what is published today, and a
run takes seconds rather than minutes. Old PNG objects are left in the bucket
(harmless, and a cheap rollback).

`--dry-run` prints what would change. Failures on a single row are logged and the
run continues; the pass is idempotent, so a rerun picks up what failed.

### 5. Testing

Backend (Vitest):
- `derivatives.test.ts` — a real small PNG fixture in → WebP magic bytes (`RIFF`/`WEBP`),
  expected widths (750/375), LQIP is a `data:image/webp;base64,` URI under 1 KB.
- `publish.test.ts` — with mocked `PublishDeps`: two WebP keys per screen, both
  carrying the same hash, no `.png` upload, row carries `imageUrl1x` + `lqip`.
- store test — new columns are selected and mapped; a row with NULLs maps to
  `undefined` rather than `null`.
- `reencode.test.ts` — skips rows that already have derivatives, processes those
  that don't, `--force` reprocesses.

Frontend (Vitest + happy-dom):
- `ShowcaseCard` renders `srcset`/`sizes` when `imageUrl1x` is present and a bare
  `src` when it isn't; `fetchpriority` only with `eager`.
- `ShowcaseAppCarousel` mounts `<img>` only for the ±1 window; a 5-screen app shows
  at most 3 images initially.

Live verification (required before calling this done — the whole task is a
performance claim):
- `showcase:reencode --dry-run` against production, then a real run.
- Re-measure with the same curl loop used for the diagnosis: total image bytes of
  the first page, per-image TTFB and total time, presence of `Cache-Control` on a
  fresh object.
- Load `/` in a browser and confirm the LQIP → image transition and that a
  multi-screen app does not fetch every slide up front.

Target: ~10 MB → ~0.8–1 MB for the first page, with something visible immediately
instead of a 2–4 s blank.

## Risks

- **`sharp` on render.com** — a native binary; the backend image must build it.
  If the deploy breaks, the fallback with no new dependency is Playwright's
  `type: "jpeg", quality: 82` (~144 KB vs 855 KB — 6× instead of 10×, and no LQIP).
- **`immutable` on non-hashed keys** — only HTML is left unhashed; noted above.
- **Partial backfill** — safe by construction: nullable columns, feature-detected
  in the card.
- **Repo split** — no tool schemas change, so the `contract` CI job is unaffected
  and the two repos can merge in either order. The backend must ship first anyway
  so the frontend has fields to read; until then the frontend simply sees
  `undefined` and behaves as today.
