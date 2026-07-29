// A published screen is rendered as a bare document — Chromium for the
// screenshot, an <iframe> for the gallery lightbox — with nothing between it
// and the user-agent stylesheet. So every form control the design did not
// explicitly style shows up wearing Chromium's own clothes: a `<button>` comes
// out with `border: 2px outset`, `font-family: Arial` and a grey ButtonFace,
// inside a screen set in its own font. That is exactly how a recipe app's sage
// CTA shipped to the gallery with a bevelled system border and an Arial label
// (screen 260e0d07, "5 · On the table").
//
// The repair is a normalization pass, not a redesign: neutralize the UA
// defaults that leak, and nothing else. The mechanism is a CASCADE LAYER —
// unlayered author declarations beat layered ones no matter their specificity
// or order, so this block can only ever fill in where the design said nothing.
// A design that sets its own button border keeps it; a design that says
// nothing gets a flat control instead of a system widget.
//
// Deliberately NOT reset: `padding` and `text-align` on buttons (designs
// routinely lean on the UA's centering), and `appearance` on checkbox / radio /
// range / color / file inputs (those ARE the native widget — blanking them
// leaves an invisible control).
const RESET_MARKER = "data-showcase-ua-reset";

const RESET_STYLE = `<style ${RESET_MARKER}>
@layer showcase-ua-reset {
  button, input, select, textarea {
    font: inherit;
    letter-spacing: inherit;
    color: inherit;
    background: none;
    border: 0;
    border-radius: 0;
  }
  button, textarea,
  input:not([type]), input[type="text"], input[type="search"], input[type="email"],
  input[type="password"], input[type="number"], input[type="tel"], input[type="url"],
  input[type="date"], input[type="time"], input[type="datetime-local"],
  input[type="month"], input[type="week"],
  input[type="submit"], input[type="button"], input[type="reset"] {
    -webkit-appearance: none;
    appearance: none;
  }
  button { cursor: pointer; }
  textarea { resize: none; }
}
</style>`;

/** True when `html` already carries the reset — the pass is idempotent, and
 * both `publish.ts` and `rescreenshot.ts` may see the same document. */
export function hasShowcaseUaReset(html: string): boolean {
  return html.includes(RESET_MARKER);
}

/**
 * Injects the UA-neutralizing stylesheet into one screen's HTML. Returns the
 * input unchanged when it is already there.
 *
 * Placement is `<head>` when the document has one, otherwise the top of the
 * fragment — the cascade does not care (a layered rule loses to every
 * unlayered one wherever it sits), so this only chases readability and the
 * one case that DOES matter: landing inside the document rather than before
 * `<!doctype>`.
 */
export function normalizeShowcaseHtml(html: string): string {
  if (hasShowcaseUaReset(html)) return html;

  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + "\n" + RESET_STYLE + html.slice(at);
  }

  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + "\n" + RESET_STYLE + html.slice(at);
  }

  return RESET_STYLE + "\n" + html;
}
