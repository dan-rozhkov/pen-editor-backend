-- WebP derivatives for the showcase feed: a half-width @1x variant for
-- srcset, and a tiny blurred placeholder shipped inline in the feed JSON.
-- Both nullable so a partial backfill (npm run showcase:reencode) is safe at
-- every point — a row without them just renders as it does today.
ALTER TABLE showcase_screens
  ADD COLUMN IF NOT EXISTS image_url_1x TEXT,
  ADD COLUMN IF NOT EXISTS lqip TEXT;
