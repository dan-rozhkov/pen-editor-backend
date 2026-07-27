// Curated pool of mobile-app domains the showcase generator picks from. Kept
// broad (consumer + prosumer + niche) so a long run doesn't feel repetitive.
export const SHOWCASE_THEMES: string[] = [
  "фитнес-трекер",
  "мобильный банк",
  "приложение для рецептов",
  "каршеринг",
  "медитация и сон",
  "учёт домашних растений",
  "билеты в кино",
  "трекер привычек",
  "доставка еды",
  "планировщик путешествий",
  "приложение для чтения книг",
  "трекер расходов",
  "прогноз погоды",
  "заметки и списки дел",
  "приложение для изучения языков",
  "музыкальный плеер",
  "трекер сна",
  "маркетплейс подержанных вещей",
  "приложение для йоги",
  "трекер воды",
  "бронирование столиков в ресторанах",
  "приложение для велопрогулок",
  "трекер настроения",
  "заказ такси",
  "приложение для ухода за питомцами",
  "трекер медикаментов",
  "приложение для каршеринга самокатов",
  "планировщик свадеб",
  "трекер сериалов и фильмов",
];

// Picks a random theme from `themes`, avoiding anything in `recent` when
// possible. If every theme is "recent" (small pool, long history), the
// exclusion is dropped rather than throwing or looping forever — otherwise a
// run with a short theme list would eventually have nothing left to pick.
export function pickTheme(
  themes: string[],
  recent: string[],
  random: () => number,
): string {
  if (themes.length === 0) {
    throw new Error("pickTheme: themes list must not be empty");
  }

  const recentSet = new Set(recent);
  const candidates = themes.filter((t) => !recentSet.has(t));
  const pool = candidates.length > 0 ? candidates : themes;

  const index = Math.floor(random() * pool.length);
  // Guard against a random() implementation returning exactly 1.
  return pool[Math.min(index, pool.length - 1)];
}
