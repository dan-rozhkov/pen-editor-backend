import JSON5 from "json5";
import {
  splitBatchDesignStatements,
  isCreateOp,
  nodeTypeOfCreateOp,
  CREATE_OP_RE,
  findFirstTopLevelBrace,
  findMatchingBrace,
  splitTopLevelByComma,
} from "../ai/tools.js";

// Matches a top-level `name`/`htmlContent` key inside a create op's props
// object, capturing the (still-quoted) string value. Mirrors the `type` key
// matcher in tools.ts (TOP_LEVEL_TYPE_KEY_RE) — same shape, different key.
function topLevelKeyRe(key: string): RegExp {
  return new RegExp(
    `^\\s*(?:"${key}"|'${key}'|${key})\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`,
  );
}

const NAME_KEY_RE = topLevelKeyRe("name");
const HTML_CONTENT_KEY_RE = topLevelKeyRe("htmlContent");

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
function escapeRawNewlinesInString(rawValue: string): string {
  const delimiter = rawValue[0];
  let result = "";
  let escaped = false;

  for (const ch of rawValue) {
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
  let name: string | undefined;
  let htmlContent: string | undefined;
  for (const chunk of splitTopLevelByComma(interior)) {
    const nameMatch = chunk.match(NAME_KEY_RE);
    if (nameMatch) name = unquote(nameMatch[1]);
    const htmlMatch = chunk.match(HTML_CONTENT_KEY_RE);
    if (htmlMatch) htmlContent = unquote(htmlMatch[1]);
  }
  return { name, htmlContent };
}

// Extracts every `type: "embed"` screen (I()/R() create ops) from a
// batch_design `operations` script, in document order. Statements that
// aren't a node-creating I()/R() op, or that create a non-embed node, are
// skipped. A create op with no `htmlContent` is skipped too — there is
// nothing to render. Reuses the same statement splitter / brace / comma
// scanners tools.ts uses for the embed-only guard, so this can't drift from
// how the frontend/backend interpret the same script.
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
