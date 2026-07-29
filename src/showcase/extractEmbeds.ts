import JSON5 from "json5";
import {
  splitBatchDesignStatements,
  isCreateOp,
  nodeTypeOfCreateOp,
  CREATE_OP_RE,
  findFirstTopLevelBrace,
  findMatchingBrace,
} from "../ai/tools.js";

// ── Locating a top-level string field's raw (still-quoted) value ──────────
//
// Historically this matched a top-level `name`/`htmlContent` key with a
// single anchored regex requiring every internal delimiter to be
// backslash-escaped (mirroring TOP_LEVEL_TYPE_KEY_RE in tools.ts). That
// regex is correct when the model escapes internal quotes, but the model
// routinely emits HTML attribute values in the SAME quote style as the
// surrounding string without escaping them
// (`htmlContent: "<div class="wrap">...`). Since the regex's value group
// only spans to the FIRST unescaped delimiter, it silently truncated
// `htmlContent` at that point — no error, just a cut-off HTML string shipped
// to S3 and rendered as a blank screen.
//
// The fix below no longer assumes the first unescaped delimiter is the
// closing one. It finds where the key's value starts, then considers every
// unescaped occurrence of the delimiter after that point a CANDIDATE closing
// quote, and picks the rightmost candidate whose remainder — the rest of the
// object's interior — parses as zero-or-more well-formed top-level
// `, key: value` fields (see isValidFieldTail). A correctly-escaped value has
// exactly one such candidate (the model's own escaping already hid the
// internal ones), so existing well-formed input is unaffected; an
// unescaped-attribute value has several, and this recovers the true end
// instead of stopping at the first one.
function isEscapedAt(text: string, pos: number): boolean {
  let backslashes = 0;
  let i = pos - 1;
  while (i >= 0 && text[i] === "\\") {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1;
}

// True iff `tail` — the text immediately after a CANDIDATE closing
// delimiter, up to the end of the enclosing object's interior — is itself a
// well-formed sequence of zero or more top-level `, key: value` fields. Used
// to tell the true end of a string value apart from a stray unescaped
// delimiter inside it: only the true end leaves a tail that looks like the
// rest of a props object (nothing, or more fields); anything else leaves a
// tail starting mid-attribute (e.g. `wrap"><p>hi</p>...`), which this rejects.
function isValidFieldTail(tail: string): boolean {
  let i = 0;
  const n = tail.length;
  const skipWs = () => {
    while (i < n && /\s/.test(tail[i])) i++;
  };

  for (;;) {
    skipWs();
    if (i >= n) return true;
    if (tail[i] !== ",") return false;
    i++;
    skipWs();

    const keyMatch = /^(?:"[A-Za-z_$][\w$]*"|'[A-Za-z_$][\w$]*'|[A-Za-z_$][\w$]*)/.exec(
      tail.slice(i),
    );
    if (!keyMatch) return false;
    i += keyMatch[0].length;
    skipWs();
    if (tail[i] !== ":") return false;
    i++;
    skipWs();

    const valueStart = i;
    let depth = 0;
    let inStr: '"' | "'" | null = null;
    let escaped = false;
    while (i < n) {
      const ch = tail[i];
      if (escaped) {
        escaped = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        i++;
        continue;
      }
      if (inStr) {
        if (ch === inStr) inStr = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        i++;
        continue;
      }
      if (ch === "{" || ch === "[" || ch === "(") {
        depth++;
        i++;
        continue;
      }
      if (ch === "}" || ch === "]" || ch === ")") {
        if (depth === 0) return false;
        depth--;
        i++;
        continue;
      }
      if (ch === "," && depth === 0) break;
      i++;
    }
    if (depth !== 0 || inStr || escaped) return false;
    if (i === valueStart) return false; // empty value between `:` and `,`/end
  }
}

// Finds the index (within `interior`) of the TRUE closing delimiter for a
// string value that opened at `interior[valueStart - 1]`. Scans candidates —
// every unescaped occurrence of `delimiter` from `valueStart` onward — from
// FIRST to last, returning the earliest one whose remainder satisfies
// isValidFieldTail. Returns -1 if no candidate qualifies (the value never
// closes at all, e.g. a hard cutoff mid-script).
//
// Earliest-valid, not latest-valid: a candidate mid-attribute (e.g. right
// after the opening `"` of `class="wrap"`) leaves a tail that starts
// mid-markup (`wrap">...`) and fails isValidFieldTail outright, so it's
// never chosen. But when the field BEFORE htmlContent is itself a quoted
// string with no delimiter inside (e.g. `name: "Dashboard"`), its own true
// closing quote is the earliest candidate, and the remainder — the rest of
// the object, including the whole htmlContent field — legitimately parses as
// "more top-level fields" (isValidFieldTail's own value-scanner tracks
// quote-pairing the same way, so a well-formed nested string value validates
// even though it itself contains unescaped quotes). Scanning latest-first
// would instead walk past that correct answer to whatever the LAST
// delimiter in the whole remaining interior happens to be — which, if a
// field further down also ends in a quote, trivially "validates" against an
// empty tail and silently swallows every field in between.
function findClosingDelimiterIndex(
  interior: string,
  valueStart: number,
  delimiter: '"' | "'",
): number {
  for (let i = valueStart; i < interior.length; i++) {
    if (interior[i] === delimiter && !isEscapedAt(interior, i)) {
      if (isValidFieldTail(interior.slice(i + 1))) {
        return i;
      }
    }
  }
  return -1;
}

// Finds a top-level `key`'s quoted value within an object's interior (the
// text strictly between its `{`/`}`) and returns the RAW value, still
// including its surrounding quotes (e.g. `"<div>...</div>"`). Anchored to
// "start of interior or right after a comma" so a `key` occurring inside an
// already-consumed value's own text isn't mistaken for a top-level field.
function findRawFieldValue(interior: string, key: string): string | undefined {
  const keyRe = new RegExp(
    `(?:^|,)\\s*(?:"${key}"|'${key}'|${key})\\s*:\\s*(["'])`,
  );
  const match = keyRe.exec(interior);
  if (!match) return undefined;

  const delimiter = match[1] as '"' | "'";
  const valueStart = match.index + match[0].length; // just past the opening quote
  const closingIndex = findClosingDelimiterIndex(interior, valueStart, delimiter);
  if (closingIndex === -1) {
    console.warn(
      `[extractEmbeds] findRawFieldValue: no closing ${delimiter} found for "${key}"; skipping field`,
    );
    return undefined;
  }

  return interior.slice(valueStart - 1, closingIndex + 1);
}

// Decodes a quoted string literal (still including its surrounding quotes)
// into its runtime string value.
//
// This delegates to JSON5.parse rather than hand-rolling the escape table,
// deliberately mirroring the frontend's own DSL parser
// (pen-editor/src/lib/tools/batchDesign/parser.ts, classifyToken), which
// also feeds a quoted token straight to `JSON5.parse`. JSON5 accepts both
// double- and single-quoted strings (unlike JSON.parse) and implements the
// full JS escape table (\n, \t, \r, \b, \f, \v, \0, \xXX, \uXXXX, line
// continuations, and passthrough of unknown escapes), so backend and
// frontend interpret the exact same escape semantics by construction — no
// separate implementation to drift out of sync.
//
// A prior version of this function did `slice(1, -1).replace(/\\(.)/g,
// "$1")`, which collapsed every `\X` to `X`. That's correct for `\"`, `\'`,
// `\\`, but wrong for everything else: `\n` became a literal "n", `–`
// became the literal text "u2013", etc. Since the LLM's HTML routinely
// contains `\n`/`\t`/unicode escapes, this silently corrupted every
// showcase screen's HTML before it was uploaded to S3 and shown publicly.
//
// Parsing can still fail on a value JSON5 doesn't accept. Rather than
// throwing and losing the whole batch, or silently dropping the field, this
// logs a warning and returns undefined so the caller treats it the same as a
// missing field.
// JSON5 rejects an unescaped literal newline inside a string literal, but the
// model routinely writes multi-line HTML that way — and a rejected value means
// the whole screen is dropped, which is worse than any corruption. The
// frontend executor hits the identical problem and solves it the same way
// (`escapeRawNewlinesInStrings` in pen-editor/src/lib/tools/batchDesign/
// parser.ts): convert raw newlines *inside* the literal to `\n`/`\r` escapes
// before parsing. Backslash state is tracked so an already-escaped quote does
// not end the string early.
//
// This also escapes any UNESCAPED internal occurrence of the value's own
// delimiter (other than the opening/closing quote itself) before parsing.
// findRawFieldValue/findClosingDelimiterIndex already locate the true end of
// the value even when the model left internal quotes unescaped, but JSON5
// itself would still choke on (or silently mis-parse) those internal quotes
// unless they're escaped first — same backslash bookkeeping as the newline
// handling above, extended to a second character class instead of adding a
// second tracker.
function escapeRawNewlinesInString(rawValue: string): string {
  const delimiter = rawValue[0];
  const lastIndex = rawValue.length - 1;
  let result = "";
  let escaped = false;

  for (let i = 0; i < rawValue.length; i++) {
    const ch = rawValue[i];
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escaped = true;
      continue;
    }
    if (ch === delimiter && i !== 0 && i !== lastIndex) {
      // An unescaped internal delimiter — the model forgot to escape an
      // HTML attribute quote written in the same quote style. Escape it now
      // so JSON5 treats it as content instead of (wrongly) ending the string
      // early; the true end was already located by the caller.
      result += "\\" + ch;
      continue;
    }
    if (ch === "\n") {
      result += "\\n";
      continue;
    }
    if (ch === "\r") {
      result += "\\r";
      continue;
    }
    result += ch;
  }

  // Defensive: a value that never opened with a quote isn't ours to rewrite.
  return delimiter === '"' || delimiter === "'" ? result : rawValue;
}

function unquote(rawValue: string): string | undefined {
  try {
    const decoded: unknown = JSON5.parse(escapeRawNewlinesInString(rawValue));
    if (typeof decoded === "string") return decoded;
    console.warn(
      `[extractEmbeds] unquote: expected a string literal, got ${typeof decoded}: ${rawValue.slice(0, 80)}`,
    );
  } catch (err) {
    console.warn(
      `[extractEmbeds] unquote: failed to parse string literal, skipping field: ${rawValue.slice(0, 80)}`,
      err,
    );
  }
  return undefined;
}

// A crude but cheap smoke test for "this HTML was cut off mid-markup" — the
// last `<` in the string has no `>` after it, meaning an opening tag or
// attribute never closed. This is exactly the shape a truncated-at-a-quote
// bug produces (e.g. `...<div class=`), and is meant as loud diagnostics for
// that failure mode, not a general HTML validator: well-formed HTML that
// happens to end in plain text (no trailing tag at all) is unaffected, since
// the last `>` then still comes from an earlier, properly-closed tag.
function looksTruncated(html: string): boolean {
  const lastOpen = html.lastIndexOf("<");
  if (lastOpen === -1) return false;
  const lastClose = html.lastIndexOf(">");
  return lastClose < lastOpen;
}

// Given one batch_design statement (as produced by
// splitBatchDesignStatements), returns its top-level `name`/`htmlContent`
// string values, or undefined for either if not present/not parseable.
function readEmbedFields(
  statement: string,
): { name?: string; htmlContent?: string } {
  const trimmed = statement.trim();
  const opMatch = trimmed.match(CREATE_OP_RE);
  if (!opMatch) return {};

  const objStart = findFirstTopLevelBrace(trimmed, opMatch[0].length);
  if (objStart === -1) return {};
  const objEnd = findMatchingBrace(trimmed, objStart);
  if (objEnd === -1) return {};

  const interior = trimmed.slice(objStart + 1, objEnd);

  const rawName = findRawFieldValue(interior, "name");
  const name = rawName !== undefined ? unquote(rawName) : undefined;

  const rawHtmlContent = findRawFieldValue(interior, "htmlContent");
  const htmlContent =
    rawHtmlContent !== undefined ? unquote(rawHtmlContent) : undefined;

  if (htmlContent !== undefined && looksTruncated(htmlContent)) {
    console.warn(
      `[extractEmbeds] htmlContent for screen "${name ?? "Untitled"}" looks ` +
        `truncated mid-tag (ends with "${htmlContent.slice(-60)}") — this is ` +
        "the signature of an unescaped quote inside the model's HTML cutting " +
        "the value short. The screen will still be published; verify it " +
        "visually before trusting the gallery.",
    );
  }

  return { name, htmlContent };
}

// Extracts every `type: "embed"` screen (I()/R() create ops) from a
// batch_design `operations` script, in document order. Statements that
// aren't a node-creating I()/R() op, or that create a non-embed node, are
// skipped. A create op with no `htmlContent` is skipped too — there is
// nothing to render. Reuses the same statement splitter / brace scanners
// tools.ts uses for the embed-only guard, so this can't drift from how the
// frontend/backend interpret the same script.
export function extractEmbedScreens(
  operations: string,
): Array<{ name: string; htmlContent: string }> {
  const screens: Array<{ name: string; htmlContent: string }> = [];

  for (const statement of splitBatchDesignStatements(operations)) {
    if (!isCreateOp(statement)) continue;
    const effectiveType = nodeTypeOfCreateOp(statement) ?? "frame";
    if (effectiveType !== "embed") continue;

    const { name, htmlContent } = readEmbedFields(statement);
    if (!htmlContent) continue;

    screens.push({ name: name ?? "Untitled", htmlContent });
  }

  return screens;
}
