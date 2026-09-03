// Machine-checkable "AI tell" triggers for a rendered showcase screen — the
// same signals a human art director learns to spot on sight (unfilled
// lorem-ipsum copy, a re-drawn iOS status bar, a metric repeated at the same
// round number three times) but cheap enough to run on every screen in every
// generation, ported from OJO's audit triggers referenced in prototype.md.
//
// Operates on the screen's raw HTML string — a single self-contained document
// with inline CSS, Phosphor icons as `<i class="ph ph-...">`. Findings are
// short, human-readable notes, deduped and in a fixed order so a report is
// stable across runs of the same screen.

/** Strip HTML comments — prototype.md mandates a direction-contract comment
 * at the top of every screen, which may legitimately contain words like
 * "never lorem" or "not John Doe" while explaining what NOT to do. Copy
 * checks must never fire on that comment. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

/** Strip `<style>`/`<script>` blocks, then all remaining tags, to approximate
 * the text a person actually sees — copy checks must never fire on CSS
 * selectors or inline JS that happen to contain a matched word. */
function visibleText(html: string): string {
  return stripComments(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text nodes as rendered — same stripping as `visibleText` but split on tag
 * boundaries and kept as separate trimmed strings, so a check can ask "is
 * this ONE node exactly X" without being fooled by neighbouring text. */
function textNodes(html: string): string[] {
  return stripComments(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .split(/<[^>]+>/)
    .map((chunk) => chunk.replace(/&nbsp;/gi, " ").trim())
    .filter(Boolean);
}

// OJO rule: a text node that is literally a UI-kit slot name, never edited.
// Deliberately narrow — plenty of real screens legitimately use a single
// word like "Card" (a wallet tab) or "Title"/"Description" (a form field
// label), so only the words that are unambiguous slot placeholders on their
// own are flagged as single-word nodes. Two-word template phrases (the
// UI-kit's literal placeholder copy, e.g. "Card title") are flagged as exact
// phrases instead, since neither word alone is suspicious.
const SINGLE_WORD_LABELS = ["Placeholder", "Heading", "Subtitle"];

const TWO_WORD_LABELS = [
  "card title",
  "section heading",
  "description here",
  "description goes here",
  "button label",
  "image placeholder",
  "item name",
  "user name",
];

const CTA_WORDS = ["Submit", "OK", "Continue", "Learn More", "Get Started"];

const RELATIVE_TIME_RE =
  // OJO rule: unfilled relative timestamps ("2 hours ago", "Just now") are a
  // stock-copy tell when the same one repeats — a real feed rarely has three
  // identical ages.
  /\b(\d+\s*(?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\s+ago|\d+\s*[hmdw]\s+ago|just now|yesterday)\b/gi;

const METRIC_TOKEN_RE =
  // OJO rule: round-number money placeholders ("$1,234", "$100.00") repeated
  // verbatim are the giveaway a real dataset would not produce. Money only,
  // and only ROUND money: a tip calculator legitimately shows "20%" in three
  // places and a split bill repeats one diner's "$22.67" share per line, so
  // percentages and organic cents are not evidence of anything (measured on
  // a real run: all three findings were of that kind).
  /\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.00)?(?![\d.])/g;

// OJO rule: emoji in UI copy instead of an icon font reads as unpolished.
// `\p{Extended_Pictographic}` alone is too broad — it also matches ©, ®, ™,
// ↗, ▶, ♥ and other ordinary typographic/symbol characters that show up in
// legitimate copy (copyright notices, trend arrows). Narrow to characters
// that actually render as emoji: `\p{Emoji_Presentation}` (the codepoints
// whose default presentation IS emoji), plus an Extended_Pictographic
// character explicitly forced into emoji presentation with U+FE0F (VS16).
// No `g` flag — this is only ever used with `.test()`/`RegExp.exec` via a
// fresh call per screen, and a module-level `g` regex's `.lastIndex` would
// otherwise leak across calls (screen 2's emoji missed after screen 1's).
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;

/** Findings on the visible-text layer: lorem, personas, placeholder
 * companies, fake emails, literal label words, repeated timestamps/metrics,
 * repeated generic CTAs, emoji. */
function auditCopy(html: string): string[] {
  const notes: string[] = [];
  const text = visibleText(html);
  const nodes = textNodes(html);

  // OJO rule: unfilled lorem-ipsum copy.
  if (/lorem/i.test(text)) notes.push("lorem ipsum placeholder copy");

  // OJO rule: generic stand-in personas instead of a plausible name.
  const personaRe =
    /\b(john\s+doe|jane\s+doe|john\s+smith|jane\s+smith|user\s+[12]|@username)\b/i;
  if (personaRe.test(text)) notes.push("generic persona name (e.g. John Doe, @username)");

  // OJO rule: placeholder company names instead of a plausible brand.
  const companyRe =
    /\b(acme|globex|initech|hooli|pied\s+piper|examplecorp|techcorp)\b/i;
  if (companyRe.test(text)) notes.push("placeholder company name (e.g. Acme, Globex)");

  // OJO rule: obviously-fake email domains.
  const emailRe = /\b[\w.+-]+@(?:[\w-]+\.)*example\.[\w.]+|@(?:email|test)\.com\b/i;
  if (emailRe.test(text)) notes.push("placeholder email address (example.com / @test.com)");

  // OJO rule: a text node that is literally a UI-kit slot name, never edited.
  const singleWordLabelSet = new Set(SINGLE_WORD_LABELS.map((w) => w.toLowerCase()));
  const twoWordLabelSet = new Set(TWO_WORD_LABELS);
  if (
    nodes.some(
      (n) => singleWordLabelSet.has(n.toLowerCase()) || twoWordLabelSet.has(n.toLowerCase()),
    )
  ) {
    notes.push(
      "literal placeholder label left in copy (e.g. \"Placeholder\", \"Card title\")",
    );
  }

  // OJO rule: the same relative timestamp repeated 3+ times across the screen.
  const timeCounts = new Map<string, number>();
  for (const match of text.matchAll(RELATIVE_TIME_RE)) {
    const key = match[0].toLowerCase().replace(/\s+/g, " ");
    timeCounts.set(key, (timeCounts.get(key) ?? 0) + 1);
  }
  const repeatedTime = [...timeCounts.entries()].find(([, count]) => count >= 3);
  if (repeatedTime) {
    notes.push(`the timestamp "${repeatedTime[0]}" repeats ${repeatedTime[1]} times`);
  }

  // OJO rule: the same round money amount repeated 3+ times.
  const metricCounts = new Map<string, number>();
  for (const match of text.matchAll(METRIC_TOKEN_RE)) {
    const key = match[0].replace(/\s+/g, "");
    metricCounts.set(key, (metricCounts.get(key) ?? 0) + 1);
  }
  const repeatedMetric = [...metricCounts.entries()].find(([, count]) => count >= 3);
  if (repeatedMetric) {
    notes.push(`the metric "${repeatedMetric[0]}" repeats ${repeatedMetric[1]} times`);
  }

  // OJO rule: a generic CTA label reused across more than one button/link.
  const ctaTagRe = /<(button|a)\b[^>]*>([\s\S]*?)<\/\1>|<[^>]+class="[^"]*(?:btn|button|cta)[^"]*"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/gi;
  const ctaCounts = new Map<string, number>();
  for (const match of html.matchAll(ctaTagRe)) {
    const inner = visibleText(match[2] ?? match[3] ?? "").toLowerCase();
    for (const word of CTA_WORDS) {
      if (inner === word.toLowerCase()) {
        ctaCounts.set(word, (ctaCounts.get(word) ?? 0) + 1);
      }
    }
  }
  for (const [word, count] of ctaCounts) {
    if (count > 1) notes.push(`generic CTA "${word}" used ${count} times`);
  }

  // OJO rule: emoji standing in for an icon in UI copy.
  if (EMOJI_RE.test(text)) notes.push("emoji used in UI copy instead of an icon");

  return notes;
}

/** Findings on the raw HTML/CSS layer: re-drawn device chrome that duplicates
 * what the real device already provides (status bar, home indicator, bezel). */
function auditChrome(html: string): string[] {
  const notes: string[] = [];
  const text = visibleText(html);

  // A "lead region" of the raw HTML string — status bars sit at the top of
  // a screen, so icon-cluster checks below are scoped to it (or to a short
  // window right after a matched token) instead of the whole document, to
  // avoid pairing a top-of-screen token with an unrelated icon far below
  // (e.g. a Settings screen's own Wi-Fi/Battery rows).
  const leadRegionEnd = Math.ceil(html.length * 0.15);
  const leadRegionHtml = html.slice(0, leadRegionEnd);
  const hasLeadStatusIcon = /ph-(?:battery|cell-signal|wifi)\w*/i.test(leadRegionHtml);

  // OJO rule: a hardcoded clock time near the top of the screen, alongside a
  // battery/signal/wifi glyph, is a hand-drawn status bar the real device
  // chrome already renders. The icon must be in the same lead region as the
  // clock text, or within 300 raw-HTML characters after it — otherwise an
  // unrelated status icon anywhere in a long screen would pair with any
  // clock-shaped token near the top (e.g. "Next class 9:30").
  const leadText = text.slice(0, Math.ceil(text.length * 0.15));
  const clockMatch = /\b(?:9:41|09:41|\d{1,2}:\d{2})\b/.exec(leadText);
  if (clockMatch) {
    const clockHtmlIndex = html.indexOf(clockMatch[0]);
    const nearIconWindow =
      clockHtmlIndex >= 0
        ? html.slice(clockHtmlIndex, clockHtmlIndex + 300)
        : "";
    if (hasLeadStatusIcon || /ph-(?:battery|cell-signal|wifi)\w*/i.test(nearIconWindow)) {
      notes.push("fake status bar (clock + signal/battery glyphs drawn into the screen)");
    }
  }

  // OJO rule: wifi and battery icon classes both present, close together, in
  // the top of the document, is itself a status-bar cluster even without a
  // matched clock token. Both proximity (within 300 raw-HTML characters of
  // each other) and lead-region placement are required — a Settings screen
  // that legitimately lists Wi-Fi and Battery rows further down the page
  // must not be flagged.
  const wifiMatch = /ph-wifi\b/i.exec(leadRegionHtml);
  const batteryMatch = /ph-battery\w*/i.exec(leadRegionHtml);
  if (
    wifiMatch &&
    batteryMatch &&
    Math.abs(wifiMatch.index - batteryMatch.index) <= 300
  ) {
    notes.push("fake status bar (wifi + battery cluster)");
  }

  // OJO rule: a pill-shaped bar sized like the iOS home indicator
  // (roughly 100-160px wide, <=6px tall, fully rounded) drawn into the page.
  // Deliberately conservative: also requires the SAME style/rule block to
  // set `position: absolute|fixed` and a `bottom:` offset of 24px or less —
  // without that, an ordinary fully-rounded progress-bar track in the same
  // size range (e.g. a 140x4 pill) would otherwise be indistinguishable
  // from a home indicator drawn as a bottom-pinned overlay.
  const styleBlocks = [...html.matchAll(/style="([^"]*)"/gi)].map((m) => m[1]);
  const cssRuleBlocks = [...html.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  const homeIndicatorRe =
    /(?=[\s\S]*(?:border-radius\s*:\s*(?:9{3,}px|50%))|[\s\S]*border-radius\s*:\s*[1-9]\d{3,}px)(?=[\s\S]*height\s*:\s*(?:[0-6](?:\.\d+)?)px)(?=[\s\S]*width\s*:\s*(?:1[0-5]\d|160)px)(?=[\s\S]*position\s*:\s*(?:absolute|fixed))[\s\S]*bottom\s*:\s*(?:[0-9]|1\d|2[0-4])(?:\.\d+)?px/i;
  if ([...styleBlocks, ...cssRuleBlocks].some((block) => homeIndicatorRe.test(block))) {
    notes.push("fake home indicator drawn as a pill bar");
  }

  // OJO rule: a top-level wrapper styled as the phone's own bezel (rounded
  // corners at device size) rather than trusting the real device frame.
  const bezelRe =
    /(?=[\s\S]*border-radius\s*:\s*(?:[3-9]\d|\d{3,})px)(?=[\s\S]*width\s*:\s*390px)[\s\S]*height\s*:\s*844px/i;
  if ([...styleBlocks, ...cssRuleBlocks].some((block) => bezelRe.test(block))) {
    notes.push("phone bezel drawn around the screen");
  }

  return notes;
}

/**
 * Scan a screen's HTML for machine-checkable "AI tell" defects: unfilled
 * placeholder copy and hand-drawn device chrome that duplicates what the
 * real device already renders. Returns one short note per distinct finding,
 * deduped, in a fixed order. Empty means clean.
 */
export function auditScreenHtml(html: string): string[] {
  const notes = [...auditCopy(html), ...auditChrome(html)];
  return [...new Set(notes)];
}
