import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { describeImage } from "../services/vision.js";
import { parseScreenshotDataUrl } from "./screenshotOutput.js";

const MAX_BATCH_DESIGN_OPERATIONS = 25;

// Mirrors splitOperationLines in the frontend parser
// (pen-editor/src/lib/tools/batchDesign/parser.ts): a newline ends a statement
// only at top level — outside strings and unbalanced (), {}, [] — so a
// multi-line value (e.g. htmlContent) still counts as one operation. Wrapper/fence
// noise lines (stray <operations>/<batch_design> tags or ``` code fences a model
// sometimes emits around the script) are stripped at the edges and skipped in the
// interior, matching isWrapperNoiseLine/stripWrapperNoiseLines in the frontend
// parser, so a near-limit wrapped batch isn't over-counted and wrongly rejected here.

// A line is pure wrapper/fence noise (a stray tag or Markdown code fence a model
// sometimes emits around the script). Mirrors isWrapperNoiseLine in the frontend
// parser (pen-editor/src/lib/tools/batchDesign/parser.ts). Matches only when the
// ENTIRE trimmed line is noise — never a substring inside a real operation.
function isWrapperNoiseLine(raw: string): boolean {
  if (/^(`{3,}|~{3,})[\w-]*$/.test(raw)) return true;
  if (/^<\/?\s*(operations|batch_design)\s*\/?>$/i.test(raw)) return true;
  return false;
}

// Blank out contiguous wrapper/fence noise at the top and bottom edges of the
// input before counting, so a wrapped script isn't over-counted. Mirrors
// stripWrapperNoiseLines in the frontend parser. Edge-only so a lone `<script>`
// or ``` line inside a string value (e.g. htmlContent) is never touched.
function stripWrapperNoiseLines(input: string): string {
  const lines = input.split("\n");
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && isWrapperNoiseLine(lines[start].trim())) {
    lines[start] = "";
    start++;
  }
  while (end >= start && isWrapperNoiseLine(lines[end].trim())) {
    lines[end] = "";
    end--;
  }
  return lines.join("\n");
}

// Tracks backslash-escapes and string-literal state while scanning character
// by character. consume(ch) returns true when the char belongs to an escape
// sequence or string literal and the caller should skip structural handling.
function createQuoteScanner() {
  let escaped = false;
  let stringDelimiter: '"' | "'" | "`" | null = null;
  return {
    consume(ch: string): boolean {
      if (escaped) {
        escaped = false;
        return true;
      }
      if (ch === "\\") {
        escaped = true;
        return true;
      }
      if (stringDelimiter) {
        if (ch === stringDelimiter) stringDelimiter = null;
        return true;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        stringDelimiter = ch;
        return true;
      }
      return false;
    },
    get inString(): boolean {
      return escaped || stringDelimiter !== null;
    },
  };
}

// Tracks (), {}, [] nesting depth for chars the quote scanner did not consume;
// atTopLevel is true when all three depths are balanced.
function createDepthTracker() {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  return {
    track(ch: string): void {
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      else if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth--;
    },
    get atTopLevel(): boolean {
      return parenDepth === 0 && braceDepth === 0 && bracketDepth === 0;
    },
  };
}

// Splits a batch_design `operations` script into its individual top-level
// statements (a newline ends a statement only at top level — outside strings
// and unbalanced (), {}, [] — so a multi-line value still counts as one
// statement), skipping blank/comment/wrapper-noise lines. Exported so the
// embed-only node-type guard (below) can walk the real statements without
// duplicating the scanner. There is no operation-count check anymore — a
// batch over the cap is truncated at execution time on the frontend, not
// rejected here.
export function splitBatchDesignStatements(operations: string): string[] {
  operations = stripWrapperNoiseLines(operations);
  const statements: string[] = [];
  let current = "";
  const depth = createDepthTracker();
  const scanner = createQuoteScanner();

  const pushStatement = (text: string) => {
    const trimmed = text.trim();
    if (
      trimmed &&
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("#") &&
      !isWrapperNoiseLine(trimmed)
    ) {
      statements.push(trimmed);
    }
  };

  for (const ch of operations) {
    current += ch;

    if (scanner.consume(ch)) continue;

    depth.track(ch);

    if (ch === "\n" && depth.atTopLevel) {
      pushStatement(current);
      current = "";
    }
  }

  pushStatement(current);
  return statements;
}

// ── Embed-only guard (prototype/slides task policy) ────────────────────────
//
// In prototype/slides task policy the agent must build screens as a single
// `embed` node with HTML inside, never native frame/rect/text/etc nodes.
// Prompting alone drifts, so this is a structural backstop: given one
// statement from splitBatchDesignStatements, find the top-level node type an
// I()/R() operation would create. Same-turn limitation: this only sees
// operations inside ONE batch_design call — a model that creates a native
// node from a *different* tool call (there isn't one) or re-declares intent
// across calls isn't caught here; each batch_design call is validated
// independently.

// Scans `text` from `fromIndex` (already inside an operator's open paren, so
// parenDepth starts at 1) for the first unquoted top-level `{` — the start of
// the operation's props object. Returns -1 if the call closes without one.
export function findFirstTopLevelBrace(text: string, fromIndex: number): number {
  let parenDepth = 1;
  const scanner = createQuoteScanner();

  for (let i = fromIndex; i < text.length; i++) {
    const ch = text[i];
    if (scanner.consume(ch)) continue;
    if (ch === "(") {
      parenDepth++;
      continue;
    }
    if (ch === ")") {
      parenDepth--;
      if (parenDepth <= 0) return -1;
      continue;
    }
    if (ch === "{") return i;
  }
  return -1;
}

// Returns the index of the `}` matching the `{` at `openIndex`, scanning with
// the same string/escape/paren/brace/bracket awareness as the statement
// splitter above.
export function findMatchingBrace(text: string, openIndex: number): number {
  // Only brace balance matters for finding the matching `}` — unbalanced
  // (), [] inside the object (e.g. a function-call-shaped value) still nest
  // inside braces, so tracking brace depth alone is sufficient once strings
  // are excluded.
  let braceDepth = 0;
  const scanner = createQuoteScanner();

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (scanner.consume(ch)) continue;
    if (ch === "{") braceDepth++;
    else if (ch === "}") {
      braceDepth--;
      if (braceDepth === 0) return i;
    }
  }
  return -1;
}

// Splits `text` on top-level commas only — not commas nested inside a deeper
// {}, [], () or string — so e.g. `type: "embed", fills: [{type: "solid"}]`
// splits into two chunks (`type: "embed"` and `fills: [...]`), never
// exposing the nested `type` inside the fills array as a top-level chunk.
export function splitTopLevelByComma(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const depth = createDepthTracker();
  const scanner = createQuoteScanner();

  for (const ch of text) {
    if (!scanner.inString && ch === "," && depth.atTopLevel) {
      chunks.push(current);
      current = "";
      continue;
    }
    current += ch;

    if (scanner.consume(ch)) continue;

    depth.track(ch);
  }
  chunks.push(current);
  return chunks;
}

const TOP_LEVEL_TYPE_KEY_RE =
  /^\s*(?:"type"|'type'|type)\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/;

// Shared by isCreateOp and nodeTypeOfCreateOp so the two can't drift: matches
// an optional `binding=` prefix followed by the `I`/`R` operator and its
// opening paren — the only operators that create a node.
export const CREATE_OP_RE = /^(?:[A-Za-z_$][\w$]*\s*=\s*)?(I|R)\s*\(/;

// True iff `statement` is a node-creating `I(...)`/`R(...)` operation (with
// or without a `binding=` prefix). C/U/D/M/G/snapshot/etc are all false —
// this only tells you whether the statement CREATES a node, not what type;
// see nodeTypeOfCreateOp for the (possibly absent) explicit type.
export function isCreateOp(statement: string): boolean {
  return CREATE_OP_RE.test(statement.trim());
}

// Given a single batch_design statement (as produced by
// splitBatchDesignStatements), returns the top-level node `type` an
// `I(...)`/`R(...)` create operation would produce, or null if the statement
// isn't a node-creating I/R call (C/U/D/M/G/snapshot/etc), or has no
// top-level `type` key. A `type` nested inside a paint/fill/effect object
// (e.g. `fills: [{type: "solid", ...}]`) is deliberately NOT matched — only
// the props object's OWN top-level `type` key counts. Note: a create op with
// NO explicit type key returns null here — callers that need the EFFECTIVE
// type (e.g. the embed-only guard, where the frontend executor defaults a
// missing type to a native "frame") must apply that default themselves via
// isCreateOp + `?? "frame"`; this function's contract is "the type as
// literally written", not "the type that would end up on canvas".
export function nodeTypeOfCreateOp(statement: string): string | null {
  const trimmed = statement.trim();
  const opMatch = trimmed.match(CREATE_OP_RE);
  if (!opMatch) return null;

  const objStart = findFirstTopLevelBrace(trimmed, opMatch[0].length);
  if (objStart === -1) return null;

  const objEnd = findMatchingBrace(trimmed, objStart);
  if (objEnd === -1) return null;

  const interior = trimmed.slice(objStart + 1, objEnd);
  for (const chunk of splitTopLevelByComma(interior)) {
    const match = chunk.match(TOP_LEVEL_TYPE_KEY_RE);
    if (match) {
      return match[1].slice(1, -1).replace(/\\(.)/g, "$1");
    }
  }
  return null;
}

// Factory so a per-request variant (prototype/slides task policy) can add the
// embed-only guard on top of the same validation the default tool uses,
// without duplicating the alias/empty checks.
export const batchDesignInputShape = {
  operations: z.string().optional(),
  // Compatibility aliases for models that occasionally emit wrong key names.
  design: z.string().optional(),
  script: z.string().optional(),
  batch: z.string().optional(),
};

export function makeBatchDesignInputSchema(opts?: { embedOnly?: boolean }) {
  const embedOnly = opts?.embedOnly ?? false;

  return z
    .object(batchDesignInputShape)
    .transform((input, ctx) => {
      const operations = input.operations ?? input.design ?? input.script ?? input.batch;

      if (!operations || !operations.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Required string field "operations" is missing or empty.',
          path: ["operations"],
        });
        return z.NEVER;
      }

      // Structural backstop for prototype/slides task policy: the agent must
      // build every screen as a single embed with HTML inside, never native
      // frame/rect/text/etc nodes. Same-turn limitation: only statements
      // inside THIS batch_design call are checked.
      if (embedOnly) {
        const statements = splitBatchDesignStatements(operations);
        for (const statement of statements) {
          if (!isCreateOp(statement)) continue; // U/D/G/C/M — never creates a node
          // A create op with no explicit `type` key isn't "no type" on
          // canvas — the frontend executor defaults a missing type to a
          // native frame (nodeMapper.ts: `mapNodeType(data.type ?? "frame")`).
          // So a type-less insert must be treated as creating a frame here too.
          const effectiveType = nodeTypeOfCreateOp(statement) ?? "frame";
          if (effectiveType !== "embed") {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message:
                `Prototype/slides flow is embed-only: batch_design may not create a native "${effectiveType}" node. ` +
                `Every screen must be a single top-level embed — I(document, {type: "embed", name: "...", htmlContent: "..."}). ` +
                `Do not create frame/rect/text/etc. nodes; put all visual structure inside the embed's HTML. ` +
                `If the user said "separate frames", make each screen its OWN embed, not a native frame.`,
              path: ["operations"],
            });
            return z.NEVER;
          }
        }
      }

      return { operations };
    });
}

export const BATCH_DESIGN_DESCRIPTION = `Execute batch operations on the .pen node tree. Accepts a mini-script string with operations:

**Operations:**
- \`binding=I(parent, nodeData)\` — Insert new node. Works both for a freshly-created parent binding AND for adding a child to an already-existing node: pass the existing node's id/path as \`parent\` (e.g. \`I("existingFrameId", {...})\` or \`I(card+"/body", {...})\`). This is the ONLY way to add children to an existing node — \`U()\` cannot add, remove, or reorder children.
- \`binding=C(sourceId, parent, overrides)\` — Copy node (\`positionDirection\`/\`positionPadding\` for placement)
- \`U(path, updateData)\` — Update properties (cannot change id, type, or children)
- \`binding=R(path, newNodeData)\` — Replace node entirely
- \`M(nodeId, parent?, index?)\` — Move node
- \`D(nodeId)\` — Delete node
- \`G(nodeId, "ai"|"stock", prompt)\` — Generate/find image and apply as fill to frame/rectangle

**Rules:**
- At most ${MAX_BATCH_DESIGN_OPERATIONS} operations are executed per call — prefer keeping each call within that limit
- If you send more than ${MAX_BATCH_DESIGN_OPERATIONS} operations, the call does NOT fail: only the first ${MAX_BATCH_DESIGN_OPERATIONS} are executed and the rest are skipped. The result reports \`truncated: true\` plus counts and the list of skipped operations
- On \`truncated: true\`, your next \`batch_design\` call must contain ONLY the skipped operations — never repeat operations that already executed, or you'll create duplicate nodes
- Bindings (e.g. \`card=I(...)\`) do not survive across calls — in the follow-up call, replace any binding references from the truncated call with the real node ids returned in the result's \`bindings\` field
- Bindings (e.g. \`card=I(...)\`) only live within one call — assigned ONLY via the \`binding=I(...)\`/\`binding=R(...)\` prefix, never via an \`id\` field inside nodeData (any \`id\`/\`name\` you put in nodeData is cosmetic and is ignored for referencing — it is NOT usable as a binding)
- Use \`+\` to build paths: \`U(card+"/title", {content: "Hello"})\`
- If using existing node IDs from previous tool results, pass them as strings (e.g. \`U("abc123", {...})\`)
- The "document" binding is predefined and references the document root
- Insert/Copy/Replace MUST have a binding name
- No "image" node type — use G() on frame/rectangle to apply image fills
- \`placeholder: true\` marks frames being actively designed
- Text has no color by default — set \`fill\` property
- **Text links (hyperlinks):** write a text node's \`content\` (or \`text\`) as a markdown link \`[label](https://...)\` — optionally \`[label](https://... "title")\` — to turn the WHOLE node into a hyperlink (Figma's Link attribute; there's no per-character sub-string link, only a whole text node). Renders with an underline and a default link-blue color, unless the node also has its own \`fill\`/\`fills\`, which takes precedence. In exported HTML it becomes a real \`<a href target="_blank" rel="noopener">\`. Example: \`I(parent, {type: "text", name: "CTA", content: "[Sign up now](https://example.com/signup)"})\`. Remove a link by re-setting \`content\`/\`text\` to plain (non-markdown) text, or clear it directly with \`U("abc", {link: null})\`.
- **Fills (single vs stack):** A single \`fill: "#hex"\` or \`fill: "$--var"\` still works for one solid/variable color. For Figma-style multiple/layered fills, pass a \`fills\` array (bottom-to-top — last entry renders on top) of paint objects:
  - Solid: \`{type: "solid", color: "#hex" | "$--var", opacity?: 0-1, visible?: bool, blendMode?: string}\`
  - Gradient: \`{type: "gradient", gradient: {type: "linear"|"radial", stops: [{color, position}], startX, startY, endX, endY}}\`
  - Image: \`{type: "image", url: "https://...", mode: "fill"|"fit"|"stretch"}\`
  - Pattern (repeating image tile, for textures/grids/decorative backgrounds; rectangle/frame/ellipse only): \`{type: "pattern", url: "https://...", scale?: number (tile scale factor, default 1), spacingX?: px, spacingY?: px (gaps between tiles), offsetX?: px, offsetY?: px (whole-pattern shift), rowOffset?: 0-1 (fraction of a cell each row shifts horizontally — 0.5 gives a brick stagger)}\`
  - Video (a playing .mp4/.webm video as the fill; rectangle/frame/ellipse only): \`{type: "video", src: "https://... or data:video/... — a YouTube URL (youtube.com/watch?v=, youtu.be/, youtube.com/shorts/) also works", mode: "fill"|"fit"|"stretch", autoplay?: bool (default true), loop?: bool (default true), muted?: bool (default true), crop?: {x, y, width, height} (0-1 normalized)}\`. Same fit/crop model as an image fill. NOTE: browsers block unmuted autoplay, so an autoplaying video is effectively muted unless the user unmutes it — keep \`muted: true\` (the default) when \`autoplay\` is on. A YouTube \`src\` renders as its static thumbnail on the canvas (YouTube can't be played inside the editor) but exports/previews as a real playing embedded player.
  Do NOT pass an \`id\` on paints — ids are generated automatically. When you set \`fills\`, it is the single source of truth and any single \`fill\` on that node is ignored. \`$--var\` references inside a solid paint's \`color\` resolve and bind exactly like a single \`fill\`. Example: \`U("abc", {fills: [{type: "solid", color: "$--background"}, {type: "image", url: "https://...", mode: "fill"}]})\`
- **Strokes (single vs stack):** a single \`stroke: "#hex" | "$--var"\` still works for one solid/variable stroke color (paired with \`strokeThickness\`/\`strokeWidth\`). For Figma-style multiple/layered strokes — most commonly a gradient border — pass a \`strokes\` array (bottom-to-top, same paint shapes as \`fills\`, but ONLY \`solid\` and \`gradient\` are supported on a stroke — no image/pattern/video): \`{type: "solid", color: "#hex" | "$--var", opacity?: 0-1, visible?: bool, blendMode?: string}\` or \`{type: "gradient", gradient: {type: "linear"|"radial", stops: [{color, position}], startX, startY, endX, endY}}\`. Stroke GEOMETRY (\`strokeThickness\`/\`strokeWidth\`, \`strokeAlign\`, per-side weights) is a single property of the node, not of each paint — Figma's model has one shared weight/align for all stroke paints, which composite in the same geometry (later paints drawn over earlier ones). Do NOT pass a per-side stroke together with a gradient paint — that combination is unsupported (undefined behavior). Do NOT pass an \`id\` on paints. When you set \`strokes\`, it is the single source of truth and any single \`stroke\` on that node is ignored. Example — a gradient border: \`U("abc", {strokes: [{type: "gradient", gradient: {type: "linear", stops: [{color: "#7c3aed", position: 0}, {color: "#06b6d4", position: 1}], startX: 0, startY: 0, endX: 1, endY: 0}}], strokeThickness: 2, strokeAlign: "inside"})\`
- **Effects (shadow/blur stack):** pass an \`effects\` array (bottom-to-top, like \`fills\`) on any node (rectangle/frame/ellipse/text) to add shadows and blur:
  - Drop shadow (cast outward, behind the node): \`{type: "shadow", shadowType: "outer", color: "#hex", offset: {x, y}, blur, spread}\`
  - Inner shadow (cast inward from the edges, e.g. for pressed/inset states): \`{type: "shadow", shadowType: "inner", color: "#hex", offset: {x, y}, blur, spread}\` — renders as CSS \`box-shadow: inset ...\` on export
  - Layer blur (blurs the node itself): \`{type: "blur", radius}\`
  - Background blur (a.k.a. backdrop blur — blurs whatever is rendered BEHIND the node instead of the node itself; combine with a semi-transparent fill for a glassmorphism/iOS "frosted glass" card): \`{type: "background-blur", radius}\`
  - Noise (film grain, Figma-style): \`{type: "noise", noiseType: "mono"|"duo"|"multi", color: "#rrggbbaa" (noise pixel color+opacity; mono/duo), secondaryColor?: "#rrggbbaa" (duo), opacity?: 0-1 (multi only), noiseSize: px (cell size, >=1), noiseSizeY?: px (non-uniform vertical size), density: 0-1, blendMode?: string}\`. Max 2 noise effects per node. Renders in the editor and raster exports; dropped in HTML export.
  Multiple shadows (of either kind) and multiple blurs (layer and/or background) can coexist in the same stack; each entry accepts an optional \`visible: bool\` (defaults true). Setting \`effects\` replaces the whole stack. Example: \`U("abc", {effects: [{type: "shadow", shadowType: "outer", color: "#00000040", offset: {x: 0, y: 4}, blur: 8, spread: 0}, {type: "shadow", shadowType: "inner", color: "#00000080", offset: {x: 0, y: 2}, blur: 4, spread: 0}]})\`. Glassmorphism card example: \`U("abc", {fills: [{type: "solid", color: "#ffffff", opacity: 0.4}], effects: [{type: "background-blur", radius: 16}]})\`. Noise example: \`U("abc", {effects: [{type: "noise", noiseType: "mono", color: "#00000040", noiseSize: 1, density: 0.5}]})\`
- **Corner radius (frame/rectangle):** \`cornerRadius\` accepts either a single number for a uniform radius (\`U("abc", {cornerRadius: 12})\`) OR an array of per-corner radii in \`[topLeft, topRight, bottomRight, bottomLeft]\` order for independent corners (\`U("abc", {cornerRadius: [12, 12, 0, 0]})\`). CSS-style shorthand lengths (1, 2, or 3 values) are also accepted. Setting one form clears the other.
- **Corner smoothing / squircle (frame/rectangle):** \`cornerSmoothing\` is a single number, 0-1 (a fraction, NOT 0-100), applied uniformly to every rounded corner of the shape — it works alongside independent per-corner radii. \`0\` (or unset) is a plain circular-arc corner (default look). Higher values morph the corner into a continuous "squircle" curve; \`~0.6\` approximates the iOS app-icon look. Has no visible effect where \`cornerRadius\`/\`cornerRadiusPerCorner\` is 0. Example: \`U("abc", {cornerRadius: 24, cornerSmoothing: 0.6})\`.
- **Star (polygon node):** a \`type: "polygon"\` node with \`innerRadiusRatio\` set (0-1, exclusive of 1) renders as a star instead of a regular polygon — \`sides\` becomes the number of rays. Only \`sides\`/\`innerRadiusRatio\` need to be given; \`points\` is auto-generated (regenerated on update too, as long as \`points\` itself isn't also passed). \`innerRadiusRatio\` close to 0 gives long thin spikes; close to 1 gives a barely-notched polygon; \`0.5\` is a typical 5-point star look. Example: \`I("abc", {type: "polygon", name: "Rating Star", width: 24, height: 24, sides: 5, innerRadiusRatio: 0.5, fill: "#f5b700"})\`. A plain regular polygon (hexagon, etc.) just omits \`innerRadiusRatio\`, same as before.
- **Ellipse arc / donut (pie charts, progress rings):** an ellipse accepts \`startAngle\` (degrees, 0 = rightmost point, clockwise, default 0), \`sweepAngle\` (degrees, clamped to [-360, 360], default 360 = full ellipse), and \`innerRadiusRatio\` (0-1, donut hole radius as a ratio of the outer radius, default 0 = solid pie/full ellipse). A 90° pie wedge: \`{startAngle: 0, sweepAngle: 90}\`. A full donut ring: \`{innerRadiusRatio: 0.6}\` (sweepAngle stays 360). A partial "thick arc" (donut + partial sweep): combine both. Example: \`I("abc", {type: "ellipse", name: "Progress Ring", width: 100, height: 100, startAngle: -90, sweepAngle: 240, innerRadiusRatio: 0.7, fill: "#3366ff"})\`.
- **Line arrowheads:** a line accepts \`startCap\`/\`endCap\`, each one of \`"none"\` (default), \`"arrow"\` (open chevron), \`"triangle"\` (filled arrowhead), \`"circle"\`, or \`"bar"\` (perpendicular stop, like a dimension line), sized relative to \`strokeWidth\`. \`startCap\` is at \`(points[0], points[1])\`, \`endCap\` at \`(points[2], points[3])\`. Example, a one-way arrow: \`U("abc", {endCap: "triangle"})\`; a dimension line: \`U("abc", {startCap: "bar", endCap: "bar"})\`.
- \`fill_container\` only valid when parent has flexbox layout
- **Wrap (card grids / tag lists):** set \`wrap: true\` on a frame with layout to let children flow onto new lines once the main axis runs out of space. Use \`rowGap\`/\`columnGap\` for independent spacing on each axis (row-gap = space between wrapped lines, column-gap = space between items in a row) — either falls back to \`gap\` when unset, so \`gap\` alone still applies to both axes. A wrapped frame typically has a fixed/fill \`width\` and \`height: "fit_content"\` so it hugs the total height of all wrapped rows. Example: \`U("cardGrid", {wrap: true, columnGap: 16, rowGap: 24})\`
- **Min/max sizing (any child in an auto-layout frame):** \`minWidth\`/\`maxWidth\`/\`minHeight\`/\`maxHeight\` (numbers, in px) clamp a child's resolved size regardless of its sizing mode (fixed/fill_container/fit_content) — e.g. a \`width: "fill_container"\` card that shouldn't grow past 320px: \`U("card", {maxWidth: 320})\`
- Variable references must use exact names from \`get_variables\` (including leading \`--\` and dashes), e.g. \`"$--ck-blue-500"\`
- **Constraints (resize behavior, Figma-style):** \`constraints: {horizontal, vertical}\` on a child controls how it repositions/resizes when its parent frame is resized. Each axis is one of \`"min"\` (pinned to left/top, fixed size — the default when unset), \`"max"\` (pinned to right/bottom, fixed size), \`"center"\` (keeps its offset from the parent's center), \`"stretch"\` (left & right / top & bottom both pinned — size grows/shrinks with the parent), or \`"scale"\` (position and size both scale with the parent). Only meaningful for a direct child of a frame WITHOUT auto-layout — auto-layout frames size children via flex rules and ignore constraints. Example: \`U("abc", {constraints: {horizontal: "stretch", vertical: "min"}})\`
- **Layer masks (Figma-style):** set \`isMask: true\` on a node inside a frame/group to turn it into a mask that clips its siblings rendered ABOVE it (later in that same parent's children — the mask must be created/moved BEFORE the content it should clip so it ends up lower in z-order) up to the next masking sibling or the end of the group. The masker itself is not drawn — only its shape clips. Works for vector shapes (rectangle/ellipse/path/polygon — clips to their outline) as well as text/image-filled nodes (clips to that node's own rendered bounds/shape; soft per-pixel transparency is not yet respected, so prefer a vector shape when you need a precise cutout). Unset with \`isMask: false\` (or omit) to restore normal rendering. Example — a photo cropped to a circle: \`g=I("abc", {type: "frame", name: "Avatar", width: 80, height: 80, children: [{type: "ellipse", name: "Mask", width: 80, height: 80, isMask: true}, {type: "rectangle", name: "Photo", width: 80, height: 80}]})\` then \`G(photoId, "stock", "portrait photo")\`.
- **Lists (bullet/numbered) on a text node:** a text node's \`text\` is \`\\n\`-joined paragraphs; give it a parallel \`paragraphs\` array (same length as the number of \`\\n\`-separated lines — pad plain paragraphs with \`{}\`) where each entry is \`{listType?: "bullet"|"number"|"none", indentLevel?: number}\`. \`indentLevel\` (0 = top level) nests the item and restarts numbered counters per nested level (a bullet/plain paragraph at the same or shallower level resets a deeper numbered run; returning to a shallower level resumes its own counter). Omit \`paragraphs\`, or use \`{}\`/\`{listType: "none"}\`, for plain (non-list) paragraphs. Example — a heading, a 3-item bullet list, another heading, then a numbered list with one nested sub-step: \`I("doc", {type: "text", name: "Notes", text: "Groceries\\nMilk\\nEggs\\nBread\\nSteps\\nMix\\nDetails\\nBake", paragraphs: [{}, {listType:"bullet"}, {listType:"bullet"}, {listType:"bullet"}, {}, {listType:"number"}, {listType:"number", indentLevel:1}, {listType:"number"}]})\` (paragraphs one-to-one with the 8 \`\\n\`-separated lines). \`U("abc", {paragraphs: [...]})\` re-tags an existing text node's paragraphs the same way (array length should match the node's current line count).
- **Paragraph spacing (text node):** \`paragraphSpacing\` (number, px, default 0) adds extra vertical gap after every \`\\n\`-separated paragraph but the last (a 3-paragraph node gets 2 gaps). Included in auto-size/hug height measurement, so a text node with \`textWidthMode: "auto"\` or \`"fixed"\` (auto-height) grows to fit it automatically. Example: \`U("abc", {paragraphSpacing: 16})\`.
- **Variable font axes (text node):** for a variable font (e.g. \`"Inter"\`, \`"Roboto Flex"\`, \`"Recursive"\`, \`"Fraunces"\`, \`"Source Sans 3"\`, \`"Source Serif 4"\`, \`"Newsreader"\`), \`fontVariations\` is an object of OpenType axis tag → numeric value, e.g. \`{wght: 530}\` for a fine-grained weight between the standard 100-900 steps, or \`{wght: 700, wdth: 87, opsz: 24}\` to combine weight/width/optical-size on a font that exposes those axes. Values are clamped by the browser to each axis's registered min/max. When \`wght\` is set it takes precedence over the static \`fontWeight\` field. Example: \`U("abc", {fontVariations: {wght: 450}})\`.

**Example:**
\`\`\`
card=I("parentId", {type: "frame", name: "Account Card", layout: "vertical", padding: 16, gap: 12, width: 300, height: "fit_content"})
U(card+"/title", {content: "Account Details"})
\`\`\``;

// Factory so a per-request embed-only variant (prototype/slides task policy)
// can be built with the SAME description/behavior as the default tool, just
// swapping the input schema. No `execute` here either — batch_design stays
// client-executed regardless of variant.
export function makeBatchDesignTool(opts?: { embedOnly?: boolean }) {
  return tool({
    description: BATCH_DESIGN_DESCRIPTION,
    inputSchema: makeBatchDesignInputSchema(opts).describe(
      'Tool input object. Required canonical field: {"operations":"..."}; aliases design/script/batch are accepted for robustness.',
    ),
  });
}

export const drawVectorInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  commands: z.string().min(1).max(32_768),
});

const drawVectorTool = tool({
  description: `Draw one native vector shape progressively on the canvas. Use this instead of batch_design when the user requests a freeform native vector, icon/logo contour, or explicitly wants to watch the agent draw.
The browser previews each complete command line while this tool input streams, then commits one PathNode after validation. Small mistakes don't fail the call — they come back as "warnings" in the result instead.
Commands, one per line, recommended order geometry first then paint then END() last:
- M(x, y) starts a new subpath. Use it more than once in a call to draw multiple subpaths in one shape (e.g. an icon with a hole) — later subpaths cut/add per the evenodd fill rule.
- L(x, y) straight segment
- C(cp1x, cp1y, cp2x, cp2y, x, y) cubic segment
- CLOSE() (alias Z()) closes the current subpath; optional
- FILL(color) fills the shape; works even if a subpath isn't CLOSE()d (it closes implicitly, like SVG)
- STROKE(color, width) strokes the shape; width is clamped to (0, 100]
- END() once, last (optional — a missing END() doesn't fail the call)
Paint is optional: with no FILL and no STROKE, a default stroke is applied so the shape is still visible. Colors accept #RGB, #RRGGBB, #RRGGBBAA, rgb()/rgba(). Commands are case-insensitive, args may be space- or comma-separated, parentheses and color quotes are optional ('m 12 30' and 'fill #e0522a' work like 'M(12, 30)' and 'FILL("#e0522a")'), and stray blank lines/semicolons/markdown fences are ignored. One tool call draws one shape (possibly multi-subpath); call the tool again for another shape.`,
  inputSchema: drawVectorInputSchema,
});

// Shared by create_plugin/update_plugin so the panel-size shape can't drift
// between the two tools.
const pluginUiSchema = z
  .object({
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .nullish();

export const getEditorStateInputShape = {
  include_schema: z
    .boolean()
    .describe(
      "Whether to include the .pen file schema in the response. Set true if you need to understand the node format.",
    ),
};

export const batchGetInputShape = {
  patterns: z
    .array(
      z.object({
        type: z
          .enum([
            "frame",
            "group",
            "rectangle",
            "ellipse",
            "line",
            "polygon",
            "path",
            "text",
            "embed",
            "ref",
            "connector",
          ])
          .optional()
          .describe("Only return nodes with this type"),
        name: z
          .string()
          .optional()
          .describe(
            "Only return nodes whose name matches this regex pattern",
          ),
      }),
    )
    .optional()
    .describe("Search patterns to match nodes"),
  nodeIds: z
    .array(z.string())
    .optional()
    .describe("Specific node IDs to read"),
  parentId: z
    .string()
    .optional()
    .describe("Parent node ID to limit search scope"),
  readDepth: z
    .number()
    .optional()
    .describe(
      "How deep to read children (default 1). Nodes beyond this depth show as '...'.",
    ),
  searchDepth: z
    .number()
    .optional()
    .describe("How deep to search in the node tree. Unlimited if omitted."),
  resolveVariables: z
    .boolean()
    .optional()
    .describe(
      "If true, variable references are resolved to their current values.",
    ),
  includePathGeometry: z
    .boolean()
    .optional()
    .describe("If true, include full SVG path geometry data."),
};

export const snapshotLayoutInputShape = {
  parentId: z
    .string()
    .optional()
    .describe(
      "Subtree root to inspect. Omit for the whole document.",
    ),
  maxDepth: z
    .number()
    .optional()
    .describe(
      "Depth limit for traversal. Default is direct children only. Be careful with large values.",
    ),
  problemsOnly: z
    .boolean()
    .optional()
    .describe(
      "If true, only return nodes with layout problems (clipping, overflow).",
    ),
};

export const getVariablesInputShape = {};

export const setVariablesInputShape = {
  variables: z
    .record(z.unknown())
    .describe(
      "Variable definitions, as an object keyed by variable name. Simplest form — a plain hex string per name: " +
        '`{"--brand-primary": "#3b82f6", "--brand-bg": "#ffffff"}`. ' +
        "Full form — an object per name with `type` (\"color\" | \"number\" | \"string\", default \"color\") and `value`: " +
        '`{"--radius-lg": {"type": "number", "value": "16"}}`. ' +
        "Per-theme values use `themeValues`: " +
        '`{"--brand-bg": {"type": "color", "value": "#ffffff", "themeValues": {"dark": "#0b0b0b"}}}`. ' +
        "Names may be given with or without a leading `--`/`$`. Nested token groups (e.g. `{colors: {primary: {$type, $value}}}`) are also accepted.",
    ),
  replace: z
    .boolean()
    .optional()
    .describe(
      "If true, replaces all existing variables. Default is merge.",
    ),
};

// The full instructional text for each topic — unchanged from the previous
// inline `guidelines` record, only hoisted so both the chat tool's execute
// and the MCP server's get_guidelines tool (src/mcp/server.ts) can call the
// same lookup without duplicating this content.
const GUIDELINES: Record<string, string> = {
  "design-system":
    "## Sizing & Auto-Layout Rules\n" +
    "CRITICAL: When creating frames with layout (vertical/horizontal), you MUST explicitly set width and height. " +
    "Never leave them as default — the default is a fixed pixel size which breaks auto-layout.\n" +
    "- Use `width: \"fill_container\"` for children that should stretch to parent width.\n" +
    "- Use `height: \"fill_container\"` for children that should stretch to parent height.\n" +
    "- Use `width: \"fit_content\"` or `height: \"fit_content\"` for content-sized elements.\n" +
    "- Use `height: \"fit_content(900)\"` for screens/sections that need a minimum height but grow with content.\n" +
    "- Only use fixed pixel values for elements with a known exact size (icons, avatars, fixed sidebars).\n" +
    "- Screen root frames: `width: 1440, height: \"fit_content(900)\"`.\n" +
    "- Content areas inside screens: `width: \"fill_container\", height: \"fit_content\"` or `height: \"fill_container\"`.\n" +
    "- Wrapper/container frames: ALWAYS set `height: \"fit_content\"` — they should grow with content.\n" +
    "- Card grids / tag lists: set `wrap: true` on the frame plus a fixed/fill `width` and `height: \"fit_content\"` so rows wrap and the frame hugs the total row height. Use `rowGap`/`columnGap` for independent row/column spacing (each falls back to `gap`).\n" +
    "- Use `minWidth`/`maxWidth`/`minHeight`/`maxHeight` on a child to clamp its resolved size (e.g. a `fill_container` card capped at `maxWidth: 320` so it doesn't stretch too wide in a wide row).\n\n" +
    "### Examples\n" +
    "WRONG: `I(screen, {type: \"frame\", layout: \"vertical\", gap: 16})` — no width/height, will use fixed defaults!\n" +
    "RIGHT: `I(screen, {type: \"frame\", layout: \"vertical\", gap: 16, width: \"fill_container\", height: \"fit_content\"})`\n\n" +
    "## Component Usage\n" +
    "- A reusable component is a native `frame` node with `reusable: true` — NOT an embed node. Use `get_editor_state`/`batch_get` to discover existing ones (search `type: \"frame\"`, check `reusable`).\n" +
    "- An instance is a `ref` node: `inst=I(parent, {type: \"ref\", componentId: \"<componentFrameId>\", width, height})`. Do NOT recreate a component's UI from scratch with frame/rect/text — insert a `ref` pointing at it instead.\n" +
    "- Per-instance customization goes through **overrides**, addressed by descendant path (a child's id, or `\"childId/grandchildId\"` for nested descendants): `U(inst+\"/label\", {text: \"Buy now\"})` sets a property on that instance only, leaving the component and other instances untouched.\n" +
    "- **Component properties (variants)**: a component can declare typed, named switches via `properties` on the component frame — `variant` (enum, e.g. state=default/hover/pressed), `boolean` (e.g. showIcon), or `text` (e.g. label). Each property is `{id, name, type, variantOptions?, defaultValue, bindingPath, bindingProp}`, where `bindingPath`/`bindingProp` name the descendant path and field the property controls (the same addressing as an override). `bindingProp` must be the node's INTERNAL field name, not an AI-input alias — use `\"text\"` for a text node's content (NOT `\"content\"`, which is only accepted by `U()`'s own alias mapping, not by `bindingProp`).\n" +
    "- **Important sequencing**: `componentId`, `bindingPath`, and any other id referenced *inside a nested `{...}`/`[...]` object* only resolve if written as a quoted string of a REAL, already-existing node id — same-call bindings (e.g. `comp=I(...)`) only substitute as bare top-level arguments (parent/sourceId/path), never inside nested JSON. So: create the component and its descendants in one `batch_design` call, read their real ids off the returned `createdNodes`, then in a follow-up call declare `properties` and/or create the `ref` instance using those ids as quoted strings.\n" +
    "  Call 1: `comp=I(document, {type: \"frame\", name: \"Button\", reusable: true, width: 120, height: 40})\\nlabel=I(comp, {type: \"text\", content: \"Click me\", width: 80, height: 20})` → returns e.g. `comp` id `\"n1\"`, `label` id `\"n2\"`.\n" +
    "  Call 2: `U(\"n1\", {properties: [{id: \"state\", name: \"State\", type: \"variant\", variantOptions: [\"default\",\"hover\"], defaultValue: \"default\", bindingPath: \"n2\", bindingProp: \"fill\"}]})\\ninst=I(document, {type: \"ref\", componentId: \"n1\", width: 120, height: 40})`.\n" +
    "- An instance selects a property's value via `propertyValues` (keyed by property id), NOT via `overrides`: `U(inst, {propertyValues: {state: \"hover\"}})` (`inst` here is a real id from a previous result, quoted, or a same-call top-level binding). `U()` merges `propertyValues` by key (setting one property never clobbers others already selected on the instance), and switching a property never touches the instance's `overrides` — both apply together, with an explicit override at the same path winning.\n" +
    "- When creating new designs, reuse existing components (and their declared variants) rather than building UI from scratch.\n\n" +
    "## Layout Patterns\n" +
    "- Sidebar + Content: sidebar with fixed width (240-280px), main with `width: \"fill_container\"`.\n" +
    "- Card grids: horizontal frame with `gap: 16-24`, cards with `width: \"fill_container\"`.\n" +
    "- Form fields: vertical frame with `gap: 16`, inputs with `width: \"fill_container\"`.\n\n" +
    "## Design Tokens\n" +
    "- Always use `$--variable` tokens for colors, never hardcode hex values.\n" +
    "- Colors: `$--background`, `$--foreground`, `$--muted-foreground`, `$--primary`, `$--border`, `$--card`.\n" +
    "- Typography: `$--font-primary` (headings), `$--font-secondary` (body).\n" +
    "- Border radius: `$--radius-none`, `$--radius-m`, `$--radius-pill`.\n\n" +
    "## Spacing Reference\n" +
    "- Screen sections gap: 24-32. Card grid gap: 16-24. Form fields gap: 16.\n" +
    "- Inside cards padding: 24. Page content padding: 32. Button padding: [10, 16].\n" +
    "- Maintain consistent spacing — pick from the established scale, don't use arbitrary values.",
  code:
    "When generating code from designs, use semantic HTML elements. " +
    "Map frame layouts to CSS flexbox. Map auto-layout direction to flex-direction. " +
    "Use CSS custom properties for theme variables. Export assets as needed.",
  table:
    "Build tables using nested frames with auto-layout. " +
    "Use a vertical frame for rows and horizontal frames for cells. " +
    "Keep header row as a separate component for reuse. " +
    "Apply consistent padding and borders across cells.",
  tailwind:
    "Map design tokens to Tailwind utility classes. " +
    "Use flex/grid for frame layouts. Apply gap-* for spacing. " +
    "Use p-* for padding, rounded-* for corner radius. " +
    "Map fill colors to bg-* and text colors to text-*.",
  "landing-page":
    "Structure landing pages with a hero section, features grid, testimonials, and CTA. " +
    "Use large typography for headings (48-72px). " +
    "Maintain visual hierarchy with consistent spacing (64-128px between sections). " +
    "Include responsive breakpoints for mobile and desktop.",
};

export async function getGuidelinesImpl(
  topic: string,
): Promise<{ topic: string; guidelines: string } | { error: string }> {
  if (!GUIDELINES[topic]) {
    return {
      error: `Invalid topic. Available topics: ${Object.keys(GUIDELINES).join(", ")}`,
    };
  }
  return { topic, guidelines: GUIDELINES[topic] };
}

export async function getStyleGuideTagsImpl(): Promise<{ tags: Record<string, string[]> }> {
  return {
    tags: {
      style: ["minimal", "bold", "elegant", "playful", "corporate", "modern", "retro", "brutalist"],
      color: ["monochrome", "vibrant", "pastel", "dark", "light", "warm", "cool", "earth-tones"],
      industry: ["saas", "ecommerce", "finance", "healthcare", "education", "creative", "technology"],
      platform: ["mobile", "website", "webapp", "dashboard"],
      layout: ["grid", "asymmetric", "centered", "full-width", "card-based", "sidebar"],
    },
  };
}

export async function getStyleGuideImpl(args: { tags?: string[]; name?: string }): Promise<{
  name: string;
  basedOn: string[];
  typography: unknown;
  colors: unknown;
  spacing: unknown;
  borderRadius: unknown;
}> {
  const { tags, name } = args;
  return {
    name: name ?? "Generated Style Guide",
    basedOn: tags ?? [],
    typography: {
      headingFont: "Inter",
      bodyFont: "Inter",
      sizes: { h1: 48, h2: 36, h3: 24, h4: 18, body: 16, small: 14, caption: 12 },
      weights: { heading: "700", body: "400", emphasis: "600" },
    },
    colors: {
      primary: "#3B82F6",
      secondary: "#8B5CF6",
      accent: "#F59E0B",
      background: "#FFFFFF",
      surface: "#F8FAFC",
      text: "#0F172A",
      textMuted: "#64748B",
      border: "#E2E8F0",
      success: "#22C55E",
      error: "#EF4444",
      warning: "#F59E0B",
    },
    spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32, xxl: 48, section: 64 },
    borderRadius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
  };
}

// Backend-executed, unlike every native design tool: it calls the auxiliary
// vision model directly (src/services/vision.ts) rather than dispatching to
// the browser, so it works regardless of whether the main model is
// vision-capable. `config` is threaded in exactly like batch_design's
// `embedOnly` override (see makeBatchDesignTool + prepareChatTurn): the
// static `penTools.analyze_image` entry below exists so the tool-name/schema
// contract test can see it without a Config, but prepareChatTurn always
// rebuilds it with the real per-request config before streamText runs.
export function makeAnalyzeImageTool(config?: Config) {
  return tool({
    description:
      "Look at an image by URL and get back a detailed text description — colors, layout, typography, text content, UI controls, imagery. Use this to inspect an image already in the design (a fill, an embed's <img>), a reference screenshot, or something you just made with generate_image/generate_frame_image. Works independently of which model is driving the conversation. Pass a specific question to have the description focus on it.",
    inputSchema: z.object({
      imageUrl: z
        .string()
        .describe("http(s):// or data: URL of the image to analyze."),
      question: z
        .string()
        .optional()
        .describe("Optional specific question to answer about the image, beyond a general description."),
    }),
    execute: async ({ imageUrl, question }) => {
      if (!config) {
        // Only reachable through the config-less static entry below, which
        // prepareChatTurn always replaces — so this is a wiring bug, not an
        // operator misconfiguration, and it must not read like one.
        return "Image analysis is unavailable in this context (the tool was not given a server config).";
      }
      const result = await describeImage({ image: imageUrl, question, config });
      return result.text;
    },
  });
}

export const penTools = {
  // ── Reading & Navigation ──────────────────────────────────────────

  get_editor_state: tool({
    description:
      "Get the current editor state including active .pen file, user selection, top-level nodes, and available components. Reusable components are native `frame` nodes with `reusable: true` — NOT embed nodes. They are returned under `reusableComponents` (id, name, a synced HTML snapshot for readability, syncState) and `documentComponents` (tag-based reuse). Never recreate a listed component with fresh frame/rect/text nodes — instead insert a `ref` node with `componentId` pointing at it. See `batch_design`'s Component Usage section for how to declare variant/boolean/text properties on a component and switch them on instances.",
    inputSchema: z.object(getEditorStateInputShape),
  }),

  batch_get: tool({
    description:
      "Retrieve nodes by searching for matching patterns or by reading specific node IDs. Supports flexible tree traversal with depth control. Use this to inspect node structure before modifying. Note: reusable components are native frame nodes — search with type: \"frame\" and check the `reusable` flag (and `properties`, if it declares variants) to find them; `type: \"ref\"` finds component instances.",
    inputSchema: z.object(batchGetInputShape),
  }),

  snapshot_layout: tool({
    description:
      "Get computed layout rectangles (positions and sizes after the layout engine runs). Use this to understand where elements actually appear on screen, check for overlapping/clipped elements, and find space for new content.",
    inputSchema: z.object(snapshotLayoutInputShape),
  }),

  // Client-executed (the browser renders and captures the node). Only
  // advertised for a turn when the main model is vision-capable or a
  // VISION_MODEL is configured to describe it instead — see the gate in
  // prepareChatTurn (src/ai/chatTurn.ts), which deletes this entry from the
  // per-request tool set otherwise so a phantom tool nobody could act on is
  // never offered.
  get_screenshot: tool({
    description:
      "Take a screenshot of a specific node for visual verification. Use this after finishing a screen or when a result looks suspicious — it costs a round trip (and, on a text-only model, a second vision-model call that returns a description rather than the image itself), so prefer snapshot_layout/batch_get for routine structural checks. Returns an image.",
    inputSchema: z.object({
      nodeId: z.string().describe("The ID of the node to screenshot."),
    }),
    // Without this the handler's `JSON.stringify({ imageData: "data:..." })`
    // would reach the model as a few hundred KB of base64 *text* — unreadable
    // and enormously expensive, and re-sent on every later step of the turn.
    // Promote it to a real image part instead; applyVisionPreprocessing
    // (src/ai/vision-messages.ts) then swaps that part for a text description
    // if the model turns out to be vision-less, so both paths work.
    toModelOutput: ({ output }) => {
      const image = parseScreenshotDataUrl(output);
      if (!image) {
        return { type: "text", value: typeof output === "string" ? output : JSON.stringify(output) };
      }
      return {
        type: "content",
        value: [{ type: "image-data", data: image.base64, mediaType: image.mediaType }],
      };
    },
  }),

  get_variables: tool({
    description:
      "Read all design variables (tokens) and themes defined in the .pen file. Variables can be colors, numbers, strings, or booleans, and may have different values per theme.",
    inputSchema: z.object(getVariablesInputShape),
  }),

  // ── Modification ──────────────────────────────────────────────────

  batch_design: makeBatchDesignTool(),

  draw_vector: drawVectorTool,

  rename_layers: tool({
    description:
      "Rename one or more layers (nodes) to logical, human-readable names in a single undoable step. Provide the node id and the new name for each layer. Read each layer's type, text content, and hierarchy first (via get_editor_state / batch_get) so the names reflect each layer's role (e.g. a text node reading \"Sign in\" → \"Sign in button\"; a frame of inputs → \"Login form\"). Leave already-meaningful names alone.",
    inputSchema: z.object({
      renames: z
        .array(
          z.object({
            id: z.string().describe("The node id to rename."),
            name: z
              .string()
              .min(1)
              .describe("The new layer name (non-empty)."),
          }),
        )
        .min(1)
        .describe("One {id, name} entry per layer to rename."),
    }),
  }),

  read_embed_html: tool({
    description:
      "Read part of an existing embed node's HTML without pulling the whole document into context. " +
      "`outline` (default) returns the tag structure with attributes intact and text/deep subtrees elided — " +
      "use it to see how a screen is built. `grep` returns the lines matching a literal substring with surrounding " +
      "context — use it to get byte-exact anchors for edit_embed_html. `full` returns the entire HTML; avoid it " +
      "unless you are genuinely rewriting the screen. Always read before editing: edit_embed_html matches the text you " +
      "give it, tolerating only whitespace differences.",
    inputSchema: z
      .object({
        nodeId: z.string().describe("Id of the embed node to read."),
        mode: z
          .enum(["outline", "grep", "full"])
          .default("outline")
          .describe("outline = elided structure, grep = matches for `pattern`, full = entire HTML."),
        pattern: z
          .string()
          .optional()
          .describe("Literal substring to search for (not a regex). Required when mode is 'grep'."),
        contextLines: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(2)
          .describe("Lines of context around each grep match."),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(12)
          .default(4)
          .describe("Nesting depth kept in outline mode; deeper subtrees are summarized."),
      })
      .refine((a) => a.mode !== "grep" || (a.pattern ?? "").length > 0, {
        message: "pattern is required when mode is 'grep'",
      }),
  }),

  edit_embed_html: tool({
    description:
      "Apply targeted text edits to an existing embed node's HTML instead of rewriting the whole screen. " +
      "Each edit replaces an exact substring (`oldString`) with `newString`; an empty `newString` deletes the match. " +
      "ALWAYS use this — never batch_design `U(id, {htmlContent: ...})` — when changing part of a screen that already " +
      "exists: rewriting a whole screen costs thousands of tokens and silently drifts parts you were not asked to touch. " +
      "Read the fragment with read_embed_html first; matching is exact, falling back to a whitespace-tolerant " +
      "match (indentation and line breaks) only when the exact one finds nothing and the tolerant one is unambiguous. " +
      "Each oldString must occur exactly once unless replaceAll is true. Edits apply in order and atomically — if any " +
      "edit fails to match, nothing is changed. The call is also refused when the edits would leave a previously " +
      "well-formed screen with an unclosed tag, so open and close a tag in the SAME call, never across two.",
    inputSchema: z.object({
      nodeId: z.string().describe("Id of the embed node to edit."),
      // Models sometimes emit `edits` as a JSON-encoded string instead of an array; the frontend
      // handler (editEmbedHtml.ts parseEdits) already tolerates that, so parse it here too rather
      // than rejecting the call before it reaches the browser. Non-JSON strings pass through
      // untouched so zod still reports a normal validation error.
      edits: z.preprocess(
        (val) => {
          if (typeof val !== "string") return val;
          try {
            return JSON.parse(val);
          } catch {
            return val;
          }
        },
        z
          .array(
            z.object({
              oldString: z
                .string()
                .min(1)
                .describe("Exact substring to find. Must occur exactly once unless replaceAll is true."),
              newString: z.string().describe("Replacement text. An empty string deletes the matched fragment."),
              replaceAll: z
                .boolean()
                .optional()
                .describe("Replace every occurrence instead of requiring a unique match."),
            }),
          )
          .min(1)
          .max(20)
          .describe("Edits applied in order, each against the result of the previous one."),
      ),
    }),
  }),

  boolean_operation: tool({
    description:
      "Combine 2+ selected shape nodes (rectangle/ellipse/polygon/path) into a single flattened path using a boolean operation, replacing the originals in one undoable step — useful for cutouts, icons, and complex silhouettes. `union` merges outlines, `subtract` cuts the upper shapes out of the bottom-most one, `intersect` keeps only the overlapping area, `exclude` keeps everything except the overlap (XOR), `flatten` merges outlines like union but is meant for normalizing a multi-shape selection into one editable path. Order matters for subtract/exclude — shapes are combined bottom-to-top by their current z-order (layer stacking), not by the order of nodeIds. All nodes must share the same parent.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(2)
        .describe("IDs of the shape nodes to combine (2 or more, same parent)."),
      operation: z
        .enum(["union", "subtract", "intersect", "exclude", "flatten"])
        .describe("Which boolean operation to apply."),
    }),
  }),

  set_variables: tool({
    description:
      "Add or update design variables and themes. Variables can reference theme axes for different values per theme. By default merges with existing variables (matched by id or name); set replace=true to overwrite all.",
    inputSchema: z.object(setVariablesInputShape),
  }),

  get_text_styles: tool({
    description:
      "Read all named, reusable text styles (Figma-style 'Text styles') defined in the .pen file: fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textTransform.",
    inputSchema: z.object({}),
  }),

  set_text_styles: tool({
    description:
      "Create or update named text styles. By default merges with existing styles by id/name (updating a style pushes the change to every text node bound to it, except locally-overridden properties); set replace=true to overwrite the whole set.",
    inputSchema: z.object({
      textStyles: z
        .union([
          z.array(z.record(z.unknown())),
          z.record(z.unknown()),
        ])
        .describe(
          "Text style definitions to add or merge. Either an array of {name, fontFamily, fontSize, fontWeight, lineHeight, letterSpacing, textTransform} objects, or an object keyed by style name.",
        ),
      replace: z
        .boolean()
        .optional()
        .describe(
          "If true, replaces all existing text styles. Default is merge.",
        ),
    }),
  }),

  apply_text_style: tool({
    description:
      "Bind one or more text nodes to a named text style (from get_text_styles / set_text_styles), copying the style's typography onto each node. Use instead of manually setting fontFamily/fontSize/etc. for design-system consistency.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe("IDs of the text nodes to bind to the style."),
      textStyleId: z.string().describe("The id of the text style to apply."),
    }),
  }),

  get_styles: tool({
    description:
      "Read all named, reusable fill (color/gradient/image/pattern paint) and effect (shadow/blur stack) styles defined in the .pen file (Figma-style 'Color styles' and 'Effect styles'). Unlike a plain variable, a style can hold a full gradient, image, or shadow/blur stack, and a fill style's solid color may itself reference a variable.",
    inputSchema: z.object({}),
  }),

  set_styles: tool({
    description: `Create or update named fill styles and/or effect styles. Editing an existing style (by id or name) live-updates every node currently applying it — no separate "propagate" step needed. By default merges with existing styles; set replace=true to overwrite the whole set (fillStyles and effectStyles are replaced independently — omit one to leave it untouched even with replace=true).

- Fill style paint: either a full paint object \`{type: "solid"|"gradient"|"image"|"pattern", ...}\` (same shapes as a \`fills\` entry in \`batch_design\`, including \`"$--var"\` variable references in a solid's \`color\`), the shorthand \`{color: "#hex" | "$--var"}\` for a solid color style, or a paint object carrying just a \`gradient\`/\`image\`/\`pattern\` sub-object (the type is inferred). An ambiguous paint (no color and no gradient/image/pattern) is reported as an error rather than silently stored.
- Effect style: \`{name, effects: [...]}\` — same shadow/layer-blur/background-blur/noise objects as a node's \`effects\` array in \`batch_design\`.

Returns the created/updated style ids and names (with a created|updated status) — pass those ids straight to \`apply_fill_style\`/\`apply_effect_style\` without a \`get_styles\` round-trip.`,
    inputSchema: z.object({
      fillStyles: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(
          "Fill style definitions to add or merge: [{id?, name, paint?: {...}, color?: '#hex'|'$--var'}].",
        ),
      effectStyles: z
        .array(z.record(z.unknown()))
        .optional()
        .describe(
          "Effect style definitions to add or merge: [{id?, name, effects: [...]}].",
        ),
      replace: z
        .boolean()
        .optional()
        .describe(
          "If true, replaces the existing set for each of fillStyles/effectStyles that was provided. Default is merge.",
        ),
    }),
  }),

  apply_fill_style: tool({
    description:
      "Bind one or more nodes' fill to a named fill style (from get_styles / set_styles) — sets the node's topmost paint layer (or adds one if it has none) to reference the style, so future edits to the style live-update the node. Use for design-system-consistent color/gradient/image fills instead of a raw fill value.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe("IDs of the nodes to bind to the fill style."),
      styleId: z.string().describe("The id of the fill style to apply."),
    }),
  }),

  apply_effect_style: tool({
    description:
      "Bind one or more nodes' whole shadow/blur stack to a named effect style (from get_styles / set_styles) — replaces the node's own effects with a live reference to the style. Use for design-system-consistent shadows instead of raw effects values.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe("IDs of the nodes to bind to the effect style."),
      styleId: z.string().describe("The id of the effect style to apply."),
    }),
  }),

  set_export_settings: tool({
    description:
      "Add (or replace) an export preset on one or more nodes — format, scale and an optional filename suffix (e.g. '@2x', '_dark'). This is how to configure or trigger an export with specific parameters: it writes to the node's `exportSettings` so the user's Export panel can run 'Export all' for those nodes. Does not itself produce a downloadable file.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .min(1)
        .describe("IDs of the nodes to configure export settings on."),
      format: z
        .enum(["svg", "png", "jpg", "webp", "pdf"])
        .describe("Export file format."),
      scale: z
        .number()
        .positive()
        .optional()
        .describe("Export scale multiplier (e.g. 0.5, 1, 2, 3). Defaults to 1."),
      suffix: z
        .string()
        .optional()
        .describe("Filename suffix appended before the extension, e.g. '@2x' or '_dark'."),
      quality: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Encoder quality 0-1, used for lossy raster formats (jpg/webp)."),
      mode: z
        .enum(["add", "replace"])
        .optional()
        .describe("'add' appends a new export setting (default); 'replace' replaces all existing settings on the node with this one."),
    }),
  }),

  export_layers_svg: tool({
    description:
      "Export one or more existing layers (e.g. a logo built from native `path`/`rect`/`group` nodes) to a single standalone SVG document, returned as a `data:image/svg+xml;base64,...` data URI. Use this instead of hand-reconstructing SVG path data or calling generate_image whenever the goal is an exact 1:1 copy of layers that already exist on the canvas — freehand SVG/path re-authoring reliably produces wrong proportions and garbled text/letterforms. Drop the returned `dataUri` straight into an embed's htmlContent as `<img src=\"...\" width=\"{width}\" height=\"{height}\">` (the tool also returns the SVG's intrinsic width/height for sizing — if the export contains a rotated node or a blur/drop-shadow, this canvas is padded beyond the layers' tight bounding box to avoid clipping, and a warning explains why). Omit nodeIds entirely to export the user's current canvas selection; pass an explicit array — including an empty `[]` — to export exactly those nodes and nothing else (an empty array is treated as \"export nothing\", not as a fallback to the current selection). Fails with a clear error if nothing is selected/found, or if the serialized SVG is too large — export fewer/simpler layers in that case.",
    inputSchema: z.object({
      nodeIds: z
        .array(z.string())
        .optional()
        .describe(
          "IDs of the layers to export. Omit entirely to export the current canvas selection. Pass an explicit array to export exactly those nodes; an empty array ([]) means \"export nothing\" and returns an error, it does NOT fall back to the current selection.",
        ),
    }),
  }),

  replace_all_matching_properties: tool({
    description:
      "Recursively find-and-replace property values across the node tree. Useful for bulk color/font/spacing changes (e.g. rebranding, theme adjustments).",
    inputSchema: z.object({
      parents: z
        .array(z.string())
        .describe("Node IDs to search within recursively."),
      properties: z
        .object({
          fillColor: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
          textColor: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
          strokeColor: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
          strokeThickness: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          cornerRadius: z
            .array(
              z.object({
                from: z.array(z.number()),
                to: z.array(z.number()),
              }),
            )
            .optional(),
          cornerSmoothing: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          padding: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          gap: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          fontSize: z
            .array(z.object({ from: z.number(), to: z.number() }))
            .optional(),
          fontFamily: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
          fontWeight: z
            .array(z.object({ from: z.string(), to: z.string() }))
            .optional(),
        })
        .describe(
          "Property replacements. Each key maps to an array of {from, to} pairs.",
        ),
    }),
  }),

  // ── Utility ───────────────────────────────────────────────────────

  find_empty_space_on_canvas: tool({
    description:
      "Find available empty space on the canvas in a given direction with the specified dimensions. Use before inserting new top-level frames to avoid overlapping.",
    inputSchema: z.object({
      direction: z
        .enum(["top", "right", "bottom", "left"])
        .describe("Direction to search for empty space."),
      width: z.number().describe("Required width of empty space."),
      height: z.number().describe("Required height of empty space."),
      padding: z
        .number()
        .describe("Minimum distance from other elements."),
      nodeId: z
        .string()
        .optional()
        .describe(
          "Reference node to search around. Omit to search around entire canvas content.",
        ),
    }),
  }),

  search_all_unique_properties: tool({
    description:
      "Search for all unique values of specified properties across the node tree. Useful for auditing design consistency (e.g. finding all colors or font sizes in use).",
    inputSchema: z.object({
      parents: z
        .array(z.string())
        .describe("Node IDs to search within recursively."),
      properties: z
        .array(
          z.enum([
            "fillColor",
            "textColor",
            "strokeColor",
            "strokeThickness",
            "cornerRadius",
            "cornerSmoothing",
            "padding",
            "gap",
            "fontSize",
            "fontFamily",
            "fontWeight",
          ]),
        )
        .describe("Property names to collect unique values for."),
    }),
  }),

  get_guidelines: tool({
    description:
      "Get design guidelines and rules for a specific topic. Returns static instructional content to help you follow best practices.",
    inputSchema: z.object({
      topic: z
        .enum(["code", "table", "tailwind", "landing-page", "design-system"])
        .describe("Topic to retrieve guidelines for."),
    }),
    execute: async ({ topic }) => getGuidelinesImpl(topic),
  }),

  get_style_guide_tags: tool({
    description:
      "Get all available style guide tags. Call this before get_style_guide to know which tags you can use for filtering.",
    inputSchema: z.object({}),
    execute: async () => getStyleGuideTagsImpl(),
  }),

  get_style_guide: tool({
    description:
      "Get a style guide for design inspiration. Either pass 5-10 tags to find a matching style, or pass a specific name to retrieve a known style guide.",
    inputSchema: z.object({
      tags: z
        .array(z.string())
        .optional()
        .describe("5-10 tags to search for a matching style guide."),
      name: z
        .string()
        .optional()
        .describe("Specific style guide name to retrieve."),
    }),
    execute: async ({ tags, name }) => getStyleGuideImpl({ tags, name }),
  }),

  // ── Comments ──────────────────────────────────────────────────────

  read_comments: tool({
    description:
      "Read canvas comment threads so you can act on them. Each thread carries a stable order number, its resolved state, and (when the thread is anchored to a node rather than a bare canvas point) the anchored nodeId and that node's name — a pin gives an exact node anchor that plain chat messages don't have, so use the nodeId to target your fix precisely. Returns each thread's messages (author 'me' or 'agent', plus text). Pass threadId to fetch a single thread, or omit it to list all threads.",
    inputSchema: z.object({
      includeResolved: z
        .boolean()
        .optional()
        .describe("Whether to include resolved threads. Default false (only unresolved threads are returned)."),
      threadId: z
        .string()
        .optional()
        .describe("If given, return only this thread instead of the full list."),
    }),
  }),

  reply_comment: tool({
    description:
      "Append a reply to an existing comment thread, authored by you (the agent). Use this to report back after acting on a comment, or to ask a clarifying question on the thread.",
    inputSchema: z.object({
      threadId: z.string().describe("The id of the thread to reply to."),
      text: z.string().min(1).describe("The reply message body (non-empty)."),
    }),
  }),

  resolve_comment: tool({
    description:
      "Mark a comment thread as resolved. Use after you've addressed what the thread asked for.",
    inputSchema: z.object({
      threadId: z.string().describe("The id of the thread to resolve."),
    }),
  }),

  leave_comment: tool({
    description:
      "Drop one or more comment pins authored by you (the agent), each starting a new thread. Pass every comment you want to leave as a single batch in one call — this is the intended way to do design-review-style feedback (5-15 findings in one turn) without spending a tool call per pin. For each item: give nodeId to anchor the pin precisely to that node (the pin defaults to the node's center) — prefer this whenever a comment is about a specific layer, since it's what lets a later fix (yours or the user's) find the exact element. If there's no single node to anchor to, give x/y instead as a world-space canvas point. Every item needs nodeId OR both x and y; an item with neither is rejected. Returns the created thread numbers so you can cite them precisely in your reply (e.g. \"left 4 notes: #7-#10\").",
    inputSchema: z.object({
      comments: z
        .array(
          z
            .object({
              nodeId: z
                .string()
                .optional()
                .describe(
                  "Id of the node to anchor this comment to (pin defaults to the node's center). Omit if using x/y instead.",
                ),
              x: z
                .number()
                .optional()
                .describe("World-space canvas x coordinate for the pin. Required together with y when nodeId is omitted."),
              y: z
                .number()
                .optional()
                .describe("World-space canvas y coordinate for the pin. Required together with x when nodeId is omitted."),
              text: z
                .string()
                .min(1)
                .describe("The comment body (non-empty). Be specific and actionable."),
            })
            .refine((item) => item.nodeId !== undefined || (item.x !== undefined && item.y !== undefined), {
              message: "Each comment needs either nodeId, or both x and y.",
            }),
        )
        .min(1)
        .max(50)
        .describe("Batch of comments to leave in this single call (1-50). Each item needs nodeId, or both x and y."),
    }),
  }),

  // ── Plugins ───────────────────────────────────────────────────────
  // Client-executed like every other tool above. Schemas are deliberately
  // minimal — the full pen.* API reference, rules and examples live in the
  // `plugin` skill (call load_skill with name "plugin"), not here, so the
  // system prompt stays small and prompt caching isn't disturbed.

  create_plugin: tool({
    description:
      "Install a new AI-authored plugin: sandboxed JavaScript that runs in the editor and can call editor tools through the pen.* API. Load the `plugin` skill FIRST for the full API reference, rules, and examples before writing `code`.",
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .describe("Short plugin name shown in the command palette and plugin manager."),
      description: z
        .string()
        .min(1)
        .describe("One-sentence description of what the plugin does."),
      icon: z
        .string()
        .optional()
        .describe("Optional single emoji shown next to the plugin name."),
      code: z
        .string()
        .min(1)
        .describe(
          "Plugin JavaScript source, run as an ES module inside a sandboxed iframe. See the `plugin` skill for the pen.* API before writing this.",
        ),
      ui: pluginUiSchema.describe(
        "Panel size for a UI plugin. Omit or pass null for a headless plugin with no visible panel.",
      ),
    }),
  }),

  update_plugin: tool({
    description:
      "Update an existing plugin's code or metadata — the way to iterate on a plugin after the user asks for a change or reports a bug. Pass only the fields you want to change. Call list_plugins first if you don't already have the plugin's id.",
    inputSchema: z.object({
      id: z
        .string()
        .min(1)
        .describe("Id of the plugin to update (from list_plugins or a prior create_plugin result)."),
      name: z.string().min(1).optional().describe("New plugin name."),
      description: z.string().min(1).optional().describe("New description."),
      icon: z.string().optional().describe("New icon (single emoji)."),
      code: z
        .string()
        .min(1)
        .optional()
        .describe("Replacement plugin source. See the `plugin` skill for the pen.* API."),
      ui: pluginUiSchema.describe("New panel size, or null to make the plugin headless."),
    }),
  }),

  list_plugins: tool({
    description:
      "List installed plugins (id, name, description). Call this before update_plugin if you don't already know the target plugin's id.",
    inputSchema: z.object({}),
  }),

  ask_user: tool({
    description:
      "Ask the user structured clarifying questions and get answers back as an interactive form in the chat, instead of guessing. " +
      "MANDATORY before you create anything new on the canvas (a new screen/page/mockup/deck/etc.): call ask_user FIRST — before get_editor_state/batch_design — to gather the brief (audience, platform/size, tone/style, scope, brand constraints such as whether to reuse existing variables/fonts). " +
      "You may also call it mid-task for a genuine fork in direction. Do NOT ask about things you can infer from the Canvas Context. Pack all questions into ONE call. " +
      "Each option-based question may offer a 'Decide for me' choice (the user delegates — its answer value is the string \"__auto__\", meaning YOU pick a sensible default) and an 'Other…' free-text field (returned in the answer's `note`). " +
      "Your turn PAUSES until the user submits; the answers come back as the tool result, then you continue.",
    inputSchema: z.object({
      title: z
        .string()
        .optional()
        .describe("Optional heading shown above the questions."),
      questions: z
        .array(
          z.object({
            id: z.string().min(1).describe("Stable machine id for this question; the answer is keyed by it."),
            label: z.string().min(1).describe("The question, shown in bold."),
            hint: z.string().optional().describe("Optional secondary line under the label."),
            type: z
              .enum(["single", "multi", "select", "text"])
              .describe("single = one chip; multi = checkboxes; select = dropdown; text = free input."),
            options: z
              .array(
                z.object({
                  value: z.string().min(1),
                  label: z.string().min(1),
                  description: z.string().optional(),
                }),
              )
              .optional()
              .describe("Choices for single/multi/select. Omit for text."),
            required: z.boolean().optional().describe("If true, the user must answer before submitting."),
            allowOther: z
              .boolean()
              .optional()
              .describe("Show an 'Other…' free-text field beside the options (default true for option questions)."),
            allowDecideForMe: z
              .boolean()
              .optional()
              .describe("Show a 'Decide for me' choice that delegates to you (default true for option questions)."),
            placeholder: z.string().optional().describe("Placeholder for text / Other input."),
          })
            .refine(
              (q) => q.type === "text" || (Array.isArray(q.options) && q.options.length > 0),
              { message: "single/multi/select questions require a non-empty options array" },
            ),
        )
        .min(1, "Provide at least one question")
        .max(8, "Too many questions — keep it focused")
        .refine(
          (qs) => new Set(qs.map((q) => q.id)).size === qs.length,
          { message: "question ids must be unique" },
        )
        .describe("The questions to ask, all shown in one form."),
    }),
  }),

  generate_image: tool({
    description:
      "Generate an image from a text prompt. Use when the user asks for an illustration, photo, texture, or background that is NOT being applied to a specific frame, and to author the photography inside a prototype/slide embed rather than falling back to stock placeholders. Returns a hosted image URL: it is rendered inline in the chat and can be used directly in an embed's HTML (`<img src>` / `background-image`). If the call errors, or comes back with a note (a placeholder, a spent budget, or an inline `data:` URL that must stay out of HTML), follow that note — use the URL it returned only where the note allows, otherwise a stock placeholder — and do not retry it.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed description of the image to generate"),
    }),
  }),
  generate_frame_image: tool({
    description:
      "Generate an image from a text prompt and set it as the image fill of a specific frame. Use for on-canvas requests that target a frame (e.g. 'make a background for this frame', 'fill this frame with a photo of X'). Pass the target frame's id from the editor state / current selection. The image also appears in the chat.",
    inputSchema: z.object({
      prompt: z.string().describe("Detailed description of the image to generate"),
      frame_id: z
        .string()
        .describe("ID of the frame whose fill should become the generated image"),
    }),
  }),

  remove_background: tool({
    description:
      "Remove the background from an image, returning a PNG with transparency. Pass node_id to replace the image fill of a node already on the canvas in place, or image_url to just get a cut-out back. Use it for product shots, logos, and subjects that need compositing onto another background — never on a background photo or a full-bleed scene that is supposed to stay whole.",
    inputSchema: z
      .object({
        node_id: z.string().optional().describe("Id of a canvas node whose image fill should be replaced in place."),
        image_url: z.string().url().optional().describe("Image URL to cut out when the source is not a node on the canvas."),
      })
      .refine((a) => Boolean(a.node_id || a.image_url), { message: "Provide node_id or image_url" }),
  }),

  vectorize_image: tool({
    description:
      "Convert a raster image to SVG and place it on the canvas as EDITABLE vector layers — real paths you can recolour and reshape — rather than a flat picture. Use it for logos, icons, and flat illustrations. Never use it on photographs: a traced photo becomes thousands of unusable paths. When the artwork already exists as canvas layers, use export_layers_svg instead — it is exact and free.",
    inputSchema: z
      .object({
        node_id: z.string().optional().describe("Id of a canvas node holding the image to vectorize. The node is replaced by the resulting vector layers."),
        image_url: z.string().url().optional().describe("Image URL to vectorize when the source is not a node on the canvas."),
        mode: z.enum(["layers", "image"]).default("layers").describe("\"layers\" places editable paths on the canvas; \"image\" just places the resulting SVG as a picture."),
      })
      .refine((a) => Boolean(a.node_id || a.image_url), { message: "Provide node_id or image_url" }),
  }),

  analyze_image: makeAnalyzeImageTool(),

  publish_to_showcase: tool({
    description:
      "Publish canvas screens the user made to the PUBLIC showcase gallery at `/` as one app (at most 5 screens). Client-executed: POSTs the named screens' HTML plus a rasterized PNG (the editor's own export path, 2x scale) to the backend, which normalizes/screenshots-in-place/uploads/stores them exactly like an autonomous showcase run. Each screen must be exactly the target platform's viewport size (mobile 390x844, desktop 1440x1024) or the call is rejected — resize or rebuild the screen first, this tool never resizes for you. Publishing is public and irreversible from here (there is no unpublish tool). Never call this unless the user explicitly asked to publish/showcase these screens — on a vague request, confirm which screens and under what app name first.",
    inputSchema: z.object({
      theme: z
        .string()
        .min(1)
        .describe('Short name of the app/flow as it appears in the gallery, e.g. "Habit tracker".'),
      prompt: z
        .string()
        .optional()
        .describe("One sentence on what this app is — recorded with the run."),
      platform: z
        .enum(["mobile", "desktop"])
        .optional()
        .describe(
          "Device class of the screens. Defaults to mobile (390x844); desktop is 1440x1024.",
        ),
      screens: z
        .array(
          z.object({
            nodeId: z.string().describe("Id of the frame or embed node holding one screen."),
            title: z.string().min(1).describe('Screen title shown in the gallery, e.g. "Onboarding".'),
            cover: z
              .boolean()
              .optional()
              .describe("Mark exactly one screen as the app's cover in the gallery."),
          }),
        )
        .min(1)
        .max(5),
    }),
  }),
};
