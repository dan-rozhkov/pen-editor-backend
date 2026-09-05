import type { Config } from "../config.js";
import {
  createRepoAccessCache,
  getFile,
  getRepoMeta,
  getRepoTree,
  resolveRepoTree,
  type RepoRef,
  type RepoTree,
  type RepoTreeEntry,
} from "./github.js";

// Builds a "design brief" from a real GitHub repository: framework/styling/
// component-library detection, design tokens (Tailwind config and/or CSS
// custom properties), and a component inventory — everything the design
// agent needs to reproduce the product's UI as plain HTML/CSS inside an
// embed (there is no React/Vue/etc. runtime available on canvas). See
// src/skills/design-from-repo.md for how the agent is expected to use this.

export type TokenCategory =
  | "colors"
  | "fontFamily"
  | "spacing"
  | "borderRadius"
  | "boxShadow";

export interface DesignTokens {
  source: string[];
  colors: Record<string, string>;
  fontFamily: Record<string, string>;
  spacing: Record<string, string>;
  borderRadius: Record<string, string>;
  boxShadow: Record<string, string>;
  // Escalation notes produced while resolving values — e.g. an unresolved
  // var(--x) reference that had to be kept raw. Never silently dropped:
  // buildDesignBrief folds these into the brief's top-level `notes`.
  notes: string[];
}

export interface ComponentInventoryEntry {
  name: string;
  path: string;
}

export interface DesignBrief {
  repo: {
    owner: string;
    name: string;
    ref: string;
    htmlUrl: string;
  };
  framework: string[];
  styling: string[];
  componentLibraries: string[];
  tokens: DesignTokens;
  components: ComponentInventoryEntry[];
  keyFiles: string[];
  notes: string[];
}

const MAX_COMPONENTS = 200;

function emptyTokens(): DesignTokens {
  return {
    source: [],
    colors: {},
    fontFamily: {},
    spacing: {},
    borderRadius: {},
    boxShadow: {},
    notes: [],
  };
}

const TOKEN_CATEGORIES = [
  "colors",
  "fontFamily",
  "spacing",
  "borderRadius",
  "boxShadow",
] as const;

// ---------------------------------------------------------------------------
// Tolerant scanning helpers (quote/brace aware, but no real JS/CSS parser)
// ---------------------------------------------------------------------------

// Returns the index of the `}` matching the `{` at openIdx, respecting
// string literals so a brace inside a string never throws off the count.
// Returns -1 if unbalanced.
function findMatchingBrace(text: string, openIdx: number): number {
  return findMatchingBracket(text, openIdx, "{", "}");
}

// Quote-aware bracket matcher shared by the object-literal ({) and array ([)
// scans.
function findMatchingBracket(
  text: string,
  openIdx: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

type CommentKind = "line" | "block" | null;

// Shared quote-aware comment scanner: walks `text` once, copying everything
// outside of a string literal and outside whatever `isCommentStart` flags,
// skipping line comments ("line") to the next newline and block comments
// ("block") to their closing `*/`. `quoteChars` lists which characters open
// a string literal for this language (JS also allows a template literal
// backtick; CSS does not).
function stripComments(
  text: string,
  quoteChars: string,
  isCommentStart: (ch: string, next: string | undefined) => CommentKind,
): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (quoteChars.includes(ch)) {
      quote = ch;
      out += ch;
      continue;
    }
    const kind = isCommentStart(ch, next);
    if (kind === "line") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (kind === "block") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip trailing '/'
      continue;
    }
    out += ch;
  }
  return out;
}

// Strips // line comments and /* */ block comments, respecting strings.
function stripJsComments(text: string): string {
  return stripComments(text, `"'\``, (ch, next) => {
    if (ch === "/" && next === "/") return "line";
    if (ch === "/" && next === "*") return "block";
    return null;
  });
}

// Splits `text` on top-level occurrences of `separator` (a single char),
// ignoring separators inside strings, (), [] or {}.
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\") {
        current += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if ("{[(".includes(ch)) depth++;
    if ("}])".includes(ch)) depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

// Splits a single "key: value" segment at its top-level `:`.
function splitKeyValue(part: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < part.length; i++) {
    const ch = part[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if ("{[(".includes(ch)) depth++;
    if ("}])".includes(ch)) depth--;
    if (ch === ":" && depth === 0) {
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
    }
  }
  return null;
}

function unquoteKey(key: string): string {
  const match = key.match(/^["'`](.*)["'`]$/s);
  return match ? match[1] : key;
}

// Resolves a single scalar leaf (a string literal or a bare number/length) to
// a plain string, or null when it cannot be resolved cheaply — a function
// call, a template literal with interpolation, a spread, or a reference to
// another variable. Skipped rather than guessed, per the "don't invent token
// values" rule downstream.
function resolveScalarValue(value: string): string | null {
  if (!value) return null;
  const stringMatch = value.match(/^(["'`])([\s\S]*)\1$/);
  if (stringMatch) {
    const inner = stringMatch[2];
    if (inner.includes("${")) return null; // unresolved template interpolation
    return inner;
  }
  if (/^-?\d+(\.\d+)?(px|rem|em|%)?$/.test(value)) return value;
  return null;
}

/**
 * Resolves a JS object-literal leaf value to a plain string.
 *
 * Arrays are joined with ", " rather than skipped, because Tailwind's two
 * most useful categories are array-shaped by convention: `fontFamily` is
 * always a stack (`sans: ["var(--font-sans)", ...fontFamily.sans]`) and
 * `boxShadow` is often a list of layers. Treating those as unresolvable lost
 * the whole font stack of a typical config — measured on shadcn-ui/taxonomy,
 * whose brief came back with zero fonts before this.
 *
 * Elements that don't resolve (the `...fontFamily.sans` spread above, which
 * would need the real Tailwind defaults to expand) are dropped, and an array
 * with nothing resolvable in it is null like any other unresolved value —
 * a partial stack is honest and directly usable as CSS, an invented one is
 * not.
 */
function resolveLeafValue(rawValue: string): string | null {
  const value = rawValue.trim().replace(/,\s*$/, "").trim();
  if (!value) return null;

  if (value.startsWith("[")) {
    const close = findMatchingBracket(value, 0, "[", "]");
    if (close === -1) return null;
    const parts = splitTopLevel(value.slice(1, close), ",")
      .map((element) => resolveScalarValue(element.trim()))
      .filter((element): element is string => element !== null);
    return parts.length > 0 ? parts.join(", ") : null;
  }

  return resolveScalarValue(value);
}

// Recursively flattens a JS object literal's *body* (without the outer
// braces) into dotted keys -> resolved leaf strings. Nested object values
// recurse (colors.brand.500); anything else unresolved is simply omitted.
function flattenObjectLiteral(
  body: string,
  prefix: string[],
  out: Record<string, string>,
): void {
  for (const part of splitTopLevel(body, ",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const kv = splitKeyValue(trimmed);
    if (!kv) continue;
    const [rawKey, rawValue] = kv;
    const key = unquoteKey(rawKey);
    if (!key) continue;
    const value = rawValue.trim();
    if (value.startsWith("{")) {
      const close = findMatchingBrace(value, 0);
      if (close === -1) continue;
      flattenObjectLiteral(value.slice(1, close), [...prefix, key], out);
      continue;
    }
    const leaf = resolveLeafValue(value);
    if (leaf === null) continue;
    out[[...prefix, key].join(".")] = leaf;
  }
}

// Finds every occurrence of `name: {` (as an object key, not just any
// substring) anywhere in `text` and returns each match's brace-matched body.
// Deliberately not anchored to "top level" — this is what lets a Tailwind
// config's `theme.extend.colors` be picked up by the same search as a
// top-level `theme.colors`.
function extractAllNamedBlocks(text: string, name: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`(?:^|[{,\\s])${name}\\s*:\\s*\\{`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const openIdx = match.index + match[0].lastIndexOf("{");
    const closeIdx = findMatchingBrace(text, openIdx);
    if (closeIdx === -1) break;
    blocks.push(text.slice(openIdx + 1, closeIdx));
    re.lastIndex = closeIdx + 1;
  }
  return blocks;
}

const TAILWIND_CATEGORY_KEYS: Record<TokenCategory, string> = {
  colors: "colors",
  fontFamily: "fontFamily",
  spacing: "spacing",
  borderRadius: "borderRadius",
  boxShadow: "boxShadow",
};

/**
 * Extracts theme tokens from a Tailwind config file's source text (v3-style
 * `module.exports = { theme: { extend: { colors: {...} } } }`, or the plain
 * `theme: {...}` shape). Never executes the file — a tolerant textual scan
 * over the `theme` block only. Values that can't be resolved (functions,
 * spreads, references) are silently skipped.
 */
export function extractTailwindConfigTokens(source: string): DesignTokens {
  const tokens = emptyTokens();
  const cleaned = stripJsComments(source);
  const themeBlocks = extractAllNamedBlocks(cleaned, "theme");
  if (themeBlocks.length === 0) return tokens;

  for (const category of Object.keys(TAILWIND_CATEGORY_KEYS) as TokenCategory[]) {
    const key = TAILWIND_CATEGORY_KEYS[category];
    for (const themeBlock of themeBlocks) {
      for (const categoryBlock of extractAllNamedBlocks(themeBlock, key)) {
        flattenObjectLiteral(categoryBlock, [], tokens[category]);
      }
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// CSS custom property extraction (:root {} and Tailwind v4's @theme {})
// ---------------------------------------------------------------------------

const CSS_CATEGORY_PREFIXES: Array<[string, TokenCategory]> = [
  ["color-", "colors"],
  ["colors-", "colors"],
  // Must be checked before the bare "font-" prefix below — otherwise a name
  // like "--font-size-lg" matches "font-" first and lands in fontFamily,
  // even though it is a length (closer to spacing) and not a font stack.
  ["font-size-", "spacing"],
  ["font-", "fontFamily"],
  ["spacing-", "spacing"],
  ["space-", "spacing"],
  ["radius-", "borderRadius"],
  ["shadow-", "boxShadow"],
];

function categorizeCssVar(name: string): { category: TokenCategory; key: string } {
  for (const [prefix, category] of CSS_CATEGORY_PREFIXES) {
    if (name.startsWith(prefix)) {
      const rest = name.slice(prefix.length);
      return { category, key: (rest || name).replace(/-/g, ".") };
    }
  }
  const lower = name.toLowerCase();
  const dotted = name.replace(/-/g, ".");
  if (lower.includes("radius")) return { category: "borderRadius", key: dotted };
  if (lower.includes("shadow")) return { category: "boxShadow", key: dotted };
  // Same font-size vs. font-family distinction as the prefix table above,
  // for an unprefixed name (e.g. "fontSize", "textFontSize").
  if (lower.includes("font") && lower.includes("size")) return { category: "spacing", key: dotted };
  if (lower.includes("font")) return { category: "fontFamily", key: dotted };
  if (lower.includes("spacing") || lower.includes("space")) {
    return { category: "spacing", key: dotted };
  }
  return { category: "colors", key: dotted };
}

// Extracts every top-level `<selector> { ... }` block whose selector matches
// `selectorRe` and returns each match's inner text (brace-matched, so a
// nested rule doesn't truncate it early).
function extractCssBlocksBySelector(css: string, selectorRe: RegExp): string[] {
  const blocks: string[] = [];
  const re = new RegExp(selectorRe.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    const openIdx = css.indexOf("{", match.index);
    if (openIdx === -1) continue;
    const closeIdx = findMatchingBrace(css, openIdx);
    if (closeIdx === -1) break;
    blocks.push(css.slice(openIdx + 1, closeIdx));
    re.lastIndex = closeIdx + 1;
  }
  return blocks;
}

// Strips /* */ CSS comments, respecting string literals — unlike
// stripJsComments, this does NOT treat "//" as a comment starter (CSS has no
// line comments, and a "//" inside e.g. a url("http://...") is real content
// that must survive).
function stripCssComments(text: string): string {
  return stripComments(text, `"'`, (ch, next) => (ch === "/" && next === "*" ? "block" : null));
}

// Matches a `--name: value` declaration ending at the next `;`, the block's
// own closing `}` (only possible if a nested rule sneaks a brace in), or the
// end of the text — NOT only at a trailing `;`. The property regex used to
// require a terminating `;`, which silently dropped the last declaration of
// every block missing one (`:root { --a: red; --b: #fff }`).
const CSS_CUSTOM_PROPERTY_RE = /--([a-zA-Z0-9-]+)\s*:\s*([^;}]+?)(?=[;}]|$)/g;

// Shared by extractRawCssCustomProperties and extractCssCustomPropertyTokens
// so both agree on exactly which declarations exist, comment-stripped and
// brace-matched, before either resolves or categorizes them.
function parseCssCustomProperties(css: string): Array<{ name: string; value: string }> {
  const cleaned = stripCssComments(css);
  const blocks = [
    ...extractCssBlocksBySelector(cleaned, /:root\s*/),
    ...extractCssBlocksBySelector(cleaned, /@theme(?:\s+inline)?\s*/),
  ];
  const out: Array<{ name: string; value: string }> = [];
  for (const block of blocks) {
    let match: RegExpExecArray | null;
    while ((match = CSS_CUSTOM_PROPERTY_RE.exec(block))) {
      const value = match[2].trim();
      if (!value) continue;
      out.push({ name: match[1], value });
    }
  }
  return out;
}

/**
 * Raw (pre-categorization, pre-resolution) `--name -> value` map of every
 * custom property declared in a `:root {}`/`@theme {}` block. Exposed so a
 * *different* file's values (e.g. a Tailwind config's
 * `primary: "hsl(var(--primary))"`) can be resolved against this file's
 * custom properties — see resolveTailwindTokenReferences below.
 */
export function extractRawCssCustomProperties(css: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { name, value } of parseCssCustomProperties(css)) {
    map[name] = value;
  }
  return map;
}

// Resolves `var(--x)` (optionally `var(--x, fallback)`) references inside
// `value` against `customProps` (a raw `--name -> value` map), substituting
// the real value where one is known. Handles the common nested shape
// `hsl(var(--primary))` for free: only the `var(...)` part is replaced, so
// the surrounding `hsl(...)`/`rgb(...)` wrapper the source already wrote is
// preserved verbatim. An unresolvable reference (no matching property, no
// fallback) is left as-is and reported in `notes` — the point of this
// feature is real values landing in the embed's CSS, so a silent guess here
// would be worse than escalating.
function resolveCssVarReferences(
  value: string,
  customProps: Record<string, string>,
  notes: string[],
  ownerLabel: string,
): string {
  let result = value;
  // Bounded, not recursive-forever: a custom property that references
  // another one at most a few levels deep is realistic; a cycle is not.
  for (let pass = 0; pass < 5 && /var\(\s*--/.test(result); pass++) {
    result = result.replace(
      /var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,\s*([^)]*))?\)/g,
      (whole: string, refName: string, fallback: string | undefined) => {
        const bareName = refName.slice(2);
        if (Object.prototype.hasOwnProperty.call(customProps, bareName)) {
          return customProps[bareName];
        }
        if (fallback && fallback.trim()) {
          notes.push(
            `${ownerLabel}: ${refName} has no matching custom property in this repo's extracted tokens — used its CSS fallback "${fallback.trim()}" instead. Verify this is correct before shipping it.`,
          );
          return fallback.trim();
        }
        notes.push(
          `${ownerLabel}: could not resolve ${refName} — no matching custom property was found among this repo's extracted tokens. Kept the raw reference "${whole}"; ask the user for the real value rather than guessing.`,
        );
        return whole;
      },
    );
  }
  return result;
}

// A bare HSL or RGB channel triplet — shadcn/ui's `--background: 0 0% 100%`
// shape — is not a usable CSS color on its own; wrap it into a real
// `hsl(...)`/`rgb(...)` function so it renders instead of resolving to
// nothing inside an embed (which has no `:root` to combine it with).
const HSL_TRIPLET_RE =
  /^-?[\d.]+(?:deg|rad|grad|turn)?\s+[\d.]+%\s+[\d.]+%(?:\s*\/\s*[\d.]+%?)?$/;
const RGB_TRIPLET_RE = /^\d{1,3}\s+\d{1,3}\s+\d{1,3}(?:\s*\/\s*[\d.]+%?)?$/;

function normalizeColorValue(value: string): string {
  const trimmed = value.trim();
  if (HSL_TRIPLET_RE.test(trimmed)) return `hsl(${trimmed})`;
  if (RGB_TRIPLET_RE.test(trimmed)) return `rgb(${trimmed})`;
  return trimmed;
}

/**
 * Extracts design tokens from CSS custom properties declared in a `:root {}`
 * block and/or a Tailwind v4 `@theme {}` block. Property names are
 * categorized by a namespaced prefix (`--color-*`, `--font-*`, `--spacing-*`
 * / `--space-*`, `--radius-*`, `--shadow-*`) when present, falling back to a
 * substring heuristic on the bare name, defaulting to `colors` (most
 * unprefixed :root custom properties in real codebases are colors, e.g.
 * shadcn/ui's `--background`/`--primary`).
 *
 * Values are resolved against each other within this same stylesheet
 * (`--primary: var(--primary-raw)`) and, for the `colors` category, a bare
 * HSL/RGB channel triplet is wrapped into a real CSS color function — see
 * resolveCssVarReferences/normalizeColorValue above for why.
 */
export function extractCssCustomPropertyTokens(css: string): DesignTokens {
  const tokens = emptyTokens();
  const parsed = parseCssCustomProperties(css);
  const rawByName = extractRawCssCustomProperties(css);
  for (const { name } of parsed) {
    const { category, key } = categorizeCssVar(name);
    const resolved = resolveCssVarReferences(rawByName[name], rawByName, tokens.notes, `--${name}`);
    tokens[category][key] = category === "colors" ? normalizeColorValue(resolved) : resolved;
  }
  return tokens;
}

/**
 * Resolves `var(--x)`/`hsl(var(--x))`/`rgb(var(--x))` references inside
 * already-extracted tokens (typically from a Tailwind config, e.g.
 * `primary: "hsl(var(--primary))"`) against a repo's raw CSS custom
 * properties (typically from its global stylesheet's `:root`/`@theme`
 * block) — the cross-file counterpart to extractCssCustomPropertyTokens'
 * own intra-file resolution. Also normalizes any resulting bare HSL/RGB
 * triplet in the `colors` category. Returns the resolved tokens plus any
 * escalation notes produced along the way (unresolved references) —
 * `tokens.notes` itself is left untouched so callers can merge deliberately.
 */
export function resolveTailwindTokenReferences(
  tokens: DesignTokens,
  rawCssVars: Record<string, string>,
): { tokens: DesignTokens; notes: string[] } {
  const notes: string[] = [];
  const resolved = emptyTokens();
  resolved.source = tokens.source;
  resolved.notes = tokens.notes;
  for (const category of TOKEN_CATEGORIES) {
    for (const [key, rawValue] of Object.entries(tokens[category])) {
      const value = resolveCssVarReferences(rawValue, rawCssVars, notes, `theme.${category}.${key}`);
      resolved[category][key] = category === "colors" ? normalizeColorValue(value) : value;
    }
  }
  return { tokens: resolved, notes };
}

function mergeTokens(base: DesignTokens, extra: DesignTokens): DesignTokens {
  const merged = emptyTokens();
  merged.source = [...base.source, ...extra.source];
  merged.notes = [...base.notes, ...extra.notes];
  for (const category of TOKEN_CATEGORIES) {
    merged[category] = { ...base[category], ...extra[category] };
  }
  return merged;
}

function tokensAreEmpty(tokens: DesignTokens): boolean {
  return (
    Object.keys(tokens.colors).length === 0 &&
    Object.keys(tokens.fontFamily).length === 0 &&
    Object.keys(tokens.spacing).length === 0 &&
    Object.keys(tokens.borderRadius).length === 0 &&
    Object.keys(tokens.boxShadow).length === 0
  );
}

// ---------------------------------------------------------------------------
// Framework / styling / component-library detection
// ---------------------------------------------------------------------------

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function allDeps(pkg: PackageJsonShape): Set<string> {
  return new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
}

function hasAny(deps: Set<string>, ...names: string[]): boolean {
  return names.some((n) => deps.has(n));
}

function hasPrefixed(deps: Set<string>, prefix: string): boolean {
  for (const dep of deps) {
    if (dep.startsWith(prefix)) return true;
  }
  return false;
}

export function detectFramework(deps: Set<string>): string[] {
  const found: string[] = [];
  if (hasAny(deps, "next")) found.push("next");
  // "react-router" alone is NOT a Remix signal — it's the standard router
  // for any React SPA (Vite/CRA included), only @remix-run/* actually
  // implies Remix. Treating it as a Remix marker used to also suppress the
  // "react" entry below for every such SPA.
  if (hasAny(deps, "@remix-run/react", "@remix-run/node")) {
    found.push("remix");
  }
  if (hasAny(deps, "nuxt", "nuxt3")) found.push("nuxt");
  else if (hasAny(deps, "vue")) found.push("vue");
  if (hasAny(deps, "svelte", "@sveltejs/kit")) found.push("svelte");
  if (hasAny(deps, "astro")) found.push("astro");
  if (hasAny(deps, "react") && !found.includes("next") && !found.includes("remix")) {
    found.push("react");
  }
  return found;
}

function detectStyling(deps: Set<string>, tree: RepoTreeEntry[]): string[] {
  const found: string[] = [];
  if (hasAny(deps, "tailwindcss")) found.push("tailwindcss");
  if (hasAny(deps, "styled-components")) found.push("styled-components");
  if (hasPrefixed(deps, "@emotion/")) found.push("emotion");
  if (hasPrefixed(deps, "@vanilla-extract/")) found.push("vanilla-extract");
  if (hasAny(deps, "sass", "node-sass")) found.push("sass");
  if (tree.some((e) => e.type === "blob" && /\.module\.(css|scss)$/i.test(e.path))) {
    found.push("css-modules");
  }
  return found;
}

function detectComponentLibraries(deps: Set<string>, tree: RepoTreeEntry[]): string[] {
  const found: string[] = [];
  if (hasPrefixed(deps, "@radix-ui/")) found.push("radix");
  if (hasAny(deps, "@mui/material")) found.push("mui");
  if (hasAny(deps, "@chakra-ui/react")) found.push("chakra");
  if (hasAny(deps, "@mantine/core")) found.push("mantine");
  if (hasAny(deps, "@headlessui/react", "@headlessui/vue")) found.push("headlessui");
  const hasComponentsUi = tree.some(
    (e) => e.type === "blob" && /(^|\/)components\/ui\//.test(e.path),
  );
  if (
    hasComponentsUi &&
    (hasAny(deps, "class-variance-authority", "tailwind-merge") || found.includes("radix"))
  ) {
    found.push("shadcn/ui");
  }
  return found;
}

// ---------------------------------------------------------------------------
// Component inventory
// ---------------------------------------------------------------------------

// The same conventional directories, optionally one workspace deep. A
// monorepo keeps them under `apps/<name>/` or `packages/<name>/`, and
// shadcn-ui/ui — the most obvious target this feature has — is exactly that
// shape: every component sits in `apps/v4/components/ui/`, so a root-anchored
// pattern returned an inventory of zero for it.
const WORKSPACE_PREFIX = "(?:(?:apps|packages|examples|libs)/[^/]+/)?";
const COMPONENT_DIR_SUFFIXES = [
  "src/components/",
  "components/",
  "app/components/",
  "src/ui/",
];
const COMPONENT_DIR_PATTERNS = COMPONENT_DIR_SUFFIXES.map(
  (suffix) => new RegExp(`^${WORKSPACE_PREFIX}${suffix.replace(/\//g, "\\/")}`),
);

const COMPONENT_FILE_RE = /\.(tsx|jsx|vue|svelte)$/i;
const EXCLUDE_RE = /(\.(test|spec|stories)\.[a-z]+$)|(^|\/)(__tests__|__mocks__|\.storybook|stories)\//i;

function toPascalCase(basename: string): string {
  return basename
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function buildComponentInventory(tree: RepoTreeEntry[]): ComponentInventoryEntry[] {
  const candidates = tree.filter(
    (entry) =>
      entry.type === "blob" &&
      COMPONENT_FILE_RE.test(entry.path) &&
      COMPONENT_DIR_PATTERNS.some((re) => re.test(entry.path)) &&
      !EXCLUDE_RE.test(entry.path),
  );

  const isPrimitive = (path: string) => /(^|\/)components\/ui\//.test(path);

  candidates.sort((a, b) => {
    const aPrimitive = isPrimitive(a.path) ? 0 : 1;
    const bPrimitive = isPrimitive(b.path) ? 0 : 1;
    if (aPrimitive !== bPrimitive) return aPrimitive - bPrimitive;
    return a.path.localeCompare(b.path);
  });

  return candidates.slice(0, MAX_COMPONENTS).map((entry) => {
    const basename = entry.path.split("/").pop() ?? entry.path;
    const withoutExt = basename.replace(COMPONENT_FILE_RE, "");
    const name = toPascalCase(withoutExt);
    return { name, path: entry.path };
  });
}

// ---------------------------------------------------------------------------
// Key files
// ---------------------------------------------------------------------------

const GLOBAL_CSS_CANDIDATES = [
  "app/globals.css",
  "src/app/globals.css",
  "src/index.css",
  "src/app.css",
  "styles/globals.css",
];

const TAILWIND_CONFIG_NAMES = [
  "tailwind.config.js",
  "tailwind.config.ts",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
];

function findTailwindConfigPath(tree: RepoTreeEntry[]): string | undefined {
  const paths = tree.filter((e) => e.type === "blob").map((e) => e.path);
  // Prefer a root-level config; fall back to the first match anywhere
  // (monorepos sometimes keep it under a single app package).
  const root = TAILWIND_CONFIG_NAMES.find((name) => paths.includes(name));
  if (root) return root;
  return paths.find((p) => TAILWIND_CONFIG_NAMES.some((name) => p.endsWith(`/${name}`)));
}

function findGlobalCssPath(tree: RepoTreeEntry[]): string | undefined {
  const paths = new Set(tree.filter((e) => e.type === "blob").map((e) => e.path));
  const known = GLOBAL_CSS_CANDIDATES.find((p) => paths.has(p));
  if (known) return known;
  return tree.find(
    (e) => e.type === "blob" && /\.css$/i.test(e.path) && !/node_modules\//.test(e.path),
  )?.path;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function buildDesignBrief(
  repo: RepoRef,
  config: Config,
): Promise<DesignBrief> {
  // One probe-cache per brief: getRepoMeta/getRepoTree/getFile below all
  // read the same repo, and the public-repo visibility probe
  // (ensurePublicRepoAccess in github.ts) must run once, not once per call.
  const cache = createRepoAccessCache();
  const meta = await getRepoMeta(repo.owner, repo.name, config, cache);

  // Resolve the final ref. An explicit ref always wins; otherwise, if the
  // repo reference came from an ambiguous `/tree/<x>/<y>/...` URL (a branch
  // name may itself contain "/"), try each candidate — shortest first —
  // against the real tree API rather than trusting the naive first segment.
  let ref: string;
  let tree: RepoTree;
  if (repo.ref) {
    ref = repo.ref;
    tree = await getRepoTree(repo.owner, repo.name, ref, config, cache);
  } else if (repo.refCandidates && repo.refCandidates.length > 0) {
    const resolved = await resolveRepoTree(repo.owner, repo.name, repo.refCandidates, config, cache);
    ref = resolved.ref;
    tree = resolved.tree;
  } else {
    ref = meta.defaultBranch;
    tree = await getRepoTree(repo.owner, repo.name, ref, config, cache);
  }

  const notes: string[] = [];
  if (tree.truncated) {
    notes.push(
      "GitHub truncated the file tree for this repo (it is very large) — some files or components may be missing from this brief.",
    );
  }

  const packageJsonPaths = tree.entries.filter(
    (e) => e.type === "blob" && /(^|\/)package\.json$/.test(e.path) && !e.path.includes("node_modules/"),
  );
  if (packageJsonPaths.length > 1) {
    notes.push(
      `This looks like a monorepo (${packageJsonPaths.length} package.json files found) — this brief was built from the root package.json only.`,
    );
  }

  const keyFiles: string[] = [];
  let deps = new Set<string>();
  if (packageJsonPaths.some((e) => e.path === "package.json")) {
    keyFiles.push("package.json");
    const raw = await getFile(repo.owner, repo.name, ref, "package.json", config, cache);
    if (raw) {
      try {
        deps = allDeps(JSON.parse(raw) as PackageJsonShape);
      } catch {
        notes.push("package.json could not be parsed as JSON.");
      }
    }
  } else {
    notes.push("No root package.json found.");
  }

  const framework = detectFramework(deps);
  const styling = detectStyling(deps, tree.entries);
  const componentLibraries = detectComponentLibraries(deps, tree.entries);

  let tokens = emptyTokens();

  // Read the global stylesheet FIRST (before the Tailwind config) so its raw
  // `--name -> value` map is available to resolve a Tailwind config value
  // like `primary: "hsl(var(--primary))"` against — the shadcn/ui shape.
  // Merge order into `tokens` is unaffected: Tailwind is still merged first,
  // CSS second, so CSS still wins a key collision exactly as before.
  const globalCssPath = findGlobalCssPath(tree.entries);
  let rawCssVars: Record<string, string> = {};
  let cssTokens: DesignTokens | null = null;
  if (globalCssPath) {
    keyFiles.push(globalCssPath);
    const raw = await getFile(repo.owner, repo.name, ref, globalCssPath, config, cache);
    if (raw) {
      rawCssVars = extractRawCssCustomProperties(raw);
      cssTokens = extractCssCustomPropertyTokens(raw);
    }
  }

  const tailwindConfigPath = findTailwindConfigPath(tree.entries);
  if (tailwindConfigPath) {
    keyFiles.push(tailwindConfigPath);
    const raw = await getFile(repo.owner, repo.name, ref, tailwindConfigPath, config, cache);
    if (raw) {
      const extracted = extractTailwindConfigTokens(raw);
      const { tokens: tailwindTokens, notes: refNotes } = resolveTailwindTokenReferences(extracted, rawCssVars);
      notes.push(...refNotes);
      if (!tokensAreEmpty(tailwindTokens)) {
        tailwindTokens.source = [tailwindConfigPath];
        tokens = mergeTokens(tokens, tailwindTokens);
      }
    }
  }

  if (cssTokens && !tokensAreEmpty(cssTokens)) {
    cssTokens.source = [globalCssPath as string];
    tokens = mergeTokens(tokens, cssTokens);
  }

  if (tokensAreEmpty(tokens)) {
    notes.push(
      "No design tokens found (no Tailwind config theme/extend block and no :root/@theme CSS custom properties) — ask the user for exact values rather than guessing.",
    );
  }
  // Surface any unresolved var()/hsl(var())/rgb(var()) reference at the
  // brief's top level too, not just inside tokens.notes — this is exactly
  // the kind of caveat the design-from-repo skill tells the agent to read
  // and escalate on rather than silently guess past.
  notes.push(...tokens.notes);

  const tsconfigPathsPath = tree.entries.find(
    (e) => e.type === "blob" && e.path === "tsconfig.json",
  )?.path;
  if (tsconfigPathsPath) keyFiles.push(tsconfigPathsPath);

  const components = buildComponentInventory(tree.entries);
  if (components.length === 0) {
    notes.push(
      "No components found under conventional directories (src/components, components, app/components, src/ui — each also searched one workspace deep, e.g. apps/<name>/components).",
    );
  } else if (components.length === MAX_COMPONENTS) {
    notes.push(`Component inventory capped at ${MAX_COMPONENTS} entries — there may be more.`);
  }

  return {
    repo: { owner: repo.owner, name: repo.name, ref, htmlUrl: meta.htmlUrl },
    framework,
    styling,
    componentLibraries,
    tokens,
    components,
    keyFiles,
    // One unresolved token reference is one fact, however many times it was
    // hit. A Tailwind config that uses `var(--font-sans)` across several
    // categories produced the identical sentence four times over, and a
    // repeated note reads to the model as repeated emphasis on the one thing
    // it cannot act on.
    notes: [...new Set(notes)],
  };
}
