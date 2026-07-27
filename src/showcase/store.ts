import type { Config } from "../config.js";
import { createPgPool, type TraceQueryable } from "../tracing/traceStore.js";

export interface ShowcaseScreenRow {
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
}

export interface ShowcaseScreen extends ShowcaseScreenRow {
  createdAt: string;
}

export interface ShowcaseStore {
  insertScreen(row: ShowcaseScreenRow): Promise<void>;
  listScreens(opts: {
    limit: number;
    cursor?: string;
  }): Promise<{ screens: ShowcaseScreen[]; nextCursor: string | null }>;
  recentThemes(limit: number): Promise<string[]>;
  // For `npm run showcase:rescreenshot` — the stored HTML is the source of
  // truth, so every screen can be re-rendered after a screenshot bug fix.
  listScreenSources(): Promise<ShowcaseScreenSource[]>;
  updateScreenImage(update: ShowcaseImageUpdate): Promise<void>;
  close(): Promise<void>;
}

export interface ShowcaseScreenSource {
  id: string;
  title: string;
  htmlUrl: string;
  width: number;
  height: number;
}

export interface ShowcaseImageUpdate {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
}

interface DecodedCursor {
  createdAt: string;
  id: string;
}

function badCursor(): never {
  throw Object.assign(new Error("Invalid cursor"), { statusCode: 400 });
}

function decodeCursor(cursor: string): DecodedCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw badCursor();
  }
  const sepIndex = decoded.indexOf("|");
  if (sepIndex === -1) badCursor();
  const createdAt = decoded.slice(0, sepIndex);
  const id = decoded.slice(sepIndex + 1);
  if (!createdAt || !id) badCursor();
  if (Number.isNaN(Date.parse(createdAt))) badCursor();
  return { createdAt, id };
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

interface ShowcaseScreenDbRow {
  id: string;
  run_id: string;
  theme: string;
  title: string;
  prompt: string;
  model: string;
  image_url: string;
  html_url: string;
  width: number;
  height: number;
  created_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: ShowcaseScreenDbRow): ShowcaseScreen {
  return {
    id: row.id,
    runId: row.run_id,
    theme: row.theme,
    title: row.title,
    prompt: row.prompt,
    model: row.model,
    imageUrl: row.image_url,
    htmlUrl: row.html_url,
    width: row.width,
    height: row.height,
    createdAt: toIso(row.created_at),
  };
}

export function createShowcaseStore(
  config: Config,
  pool?: TraceQueryable,
): ShowcaseStore | null {
  if (!config.TRACE_DATABASE_URL) return null;
  const db: TraceQueryable = pool ?? createPgPool(config.TRACE_DATABASE_URL);

  return {
    async insertScreen(row) {
      await db.query(
        `INSERT INTO showcase_screens
           (id, run_id, theme, title, prompt, model, image_url, html_url, width, height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.id,
          row.runId,
          row.theme,
          row.title,
          row.prompt,
          row.model,
          row.imageUrl,
          row.htmlUrl,
          row.width,
          row.height,
        ],
      );
    },

    async listScreens({ limit, cursor }) {
      const conditions = ["published = true"];
      const params: unknown[] = [];
      if (cursor) {
        const { createdAt, id } = decodeCursor(cursor);
        params.push(createdAt, id);
        conditions.push(
          `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      params.push(limit);
      const sql = `SELECT id, run_id, theme, title, prompt, model, image_url, html_url, width, height, created_at
                   FROM showcase_screens
                   WHERE ${conditions.join(" AND ")}
                   ORDER BY created_at DESC, id DESC
                   LIMIT $${params.length}`;
      const result = (await db.query(sql, params)) as {
        rows: ShowcaseScreenDbRow[];
      };
      const screens = result.rows.map(mapRow);
      const nextCursor =
        screens.length === limit && screens.length > 0
          ? encodeCursor(
              screens[screens.length - 1].createdAt,
              screens[screens.length - 1].id,
            )
          : null;
      return { screens, nextCursor };
    },

    async recentThemes(limit) {
      const result = (await db.query(
        `SELECT theme, MAX(created_at) AS last_seen
           FROM showcase_screens
           GROUP BY theme
           ORDER BY last_seen DESC
           LIMIT $1`,
        [limit],
      )) as { rows: Array<{ theme: string }> };
      return result.rows.map((r) => r.theme);
    },

    async listScreenSources() {
      // Oldest first, and unpublished rows included: a re-render is a repair of
      // whatever is stored, not a feed the visitor sees.
      const result = (await db.query(
        `SELECT id, title, html_url, width, height
           FROM showcase_screens
           ORDER BY created_at ASC, id ASC`,
        [],
      )) as {
        rows: Array<{
          id: string;
          title: string;
          html_url: string;
          width: number;
          height: number;
        }>;
      };
      return result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        htmlUrl: row.html_url,
        width: row.width,
        height: row.height,
      }));
    },

    async updateScreenImage({ id, imageUrl, width, height }) {
      await db.query(
        `UPDATE showcase_screens SET image_url = $2, width = $3, height = $4 WHERE id = $1`,
        [id, imageUrl, width, height],
      );
    },

    close: () => db.end(),
  };
}
