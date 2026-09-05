---
name: design-from-repo
description: Build a design concept from a real product's GitHub repository — read its design tokens and component sources with read_design_repo/read_repo_files, then reproduce them faithfully as plain HTML/CSS embeds (no framework, no Tailwind runtime).
args:
  - name: repo
    description: The repo the user gave — "owner/name", a github.com URL, or a URL with /tree/<ref>
    required: false
---

## Agent Mode: design-from-repo

The user wants a design built from a **real codebase**, not invented from scratch — they gave you a
GitHub repo (or one is already visible in the conversation). Your job is to extract that repo's actual
design truth — its tokens and its component structure — and reproduce it faithfully on canvas.

**This is prototype/embed work.** Everything you build still lives inside `embed` nodes, exactly as the
`prototype` skill describes — load it now if you have not already, its device presets, taste rules, and
`batch_design` mechanics all still apply on top of everything below.

### The one constraint that matters most

**The canvas has no React/Vue/Svelte/etc. runtime, and embeds run no JavaScript at all.** Whatever
framework the repo uses, the output is always plain, static HTML + inline/`<style>` CSS. Concretely:

- Copying JSX/template markup verbatim does not work — convert it to plain HTML tags.
- Copying `className="px-4 py-2 bg-blue-500 rounded-lg"` does not work — Tailwind's CDN/runtime script
  is unavailable in an embed, so utility classes are inert. Convert every utility class into real CSS
  properties (`padding: 1rem 1.5rem; background: #3b82f6; border-radius: 0.5rem;`), using the **actual
  token values** from the brief below, not a guess at what a class name usually means.
- Copying `styled-components`/CSS-in-JS as-is does not work either — flatten it into a `<style>` block.
- Interactive behavior (state, hooks, event handlers) has no equivalent — represent it visually (e.g. an
  open dropdown, a filled form state) as a separate screen/embed rather than trying to make it "work".

**Never invent a token value that is not in the brief.** If a color/spacing/radius/font you need is not
in `tokens`, say so explicitly and either ask the user for it or pick the closest documented value and
label it as an approximation — do not silently make one up and present it as exact.

### Flow

1. **Parse the repo reference** the user gave. Accepted shapes: `owner/name`, a full
   `https://github.com/owner/name` URL, or a URL with `/tree/<ref>` (optionally followed by a subpath).
   If nothing looks like a repo reference in the conversation, ask for one rather than guessing.

2. **Call `read_design_repo`** with that reference first, always before reading any file. Only public
   repositories are readable — a private repo (or one that doesn't exist) comes back as the same
   not-found error either way. It returns:
   - `framework` / `styling` / `componentLibraries` — what the repo is actually built with.
   - `tokens` — colors, fontFamily, spacing, borderRadius, boxShadow, each as `{ dottedKey: value }`,
     plus `tokens.source` naming where they came from (a Tailwind config, `:root`/`@theme` CSS, or both).
     Treat this as the ONLY source of real values — see the constraint above. A `var(--x)` /
     `hsl(var(--x))` / `rgb(var(--x))` reference is already resolved against the repo's own custom
     properties where possible, and a bare HSL/RGB channel triplet (shadcn/ui's
     `--background: 0 0% 100%`) is already wrapped into a real `hsl(...)`/`rgb(...)` color — you can use
     these values directly in CSS. When a reference could NOT be resolved, the raw value is kept as-is
     and `notes` names exactly which reference is unresolved — treat that as a hard stop for that value:
     ask the user rather than guessing what it should render as.
   - `components` — up to 200 `{ name, path }` entries, design-system primitives (`components/ui`-style
     directories) sorted first. `name` is a label derived from the filename (PascalCased), not something
     read out of the file — don't treat it as a claim about what the component actually exports; read the
     file (step 4) if that matters.
   - `keyFiles` — paths worth reading next (package.json, the Tailwind config, the global stylesheet).
   - `notes` — caveats (truncated tree, monorepo, no tokens found, an unresolved token reference, etc.) —
     read these, they tell you where the brief is incomplete rather than silently guessing on your behalf.

3. **Pick the components that actually matter** for what the user asked to build — do not read all 200.
   Prefer entries from `components/ui` (primitives: buttons, inputs, cards) plus the 2-5 higher-level
   components that compose the screen(s) in question.

4. **Call `read_repo_files`** with those paths (max 20 per call) to get their real source. Read the
   actual JSX/template structure — element nesting, conditional/variant branches, prop-driven states —
   and the actual styling (Tailwind classes, CSS module, styled-components) attached to each part.

5. **Restate the token set you're about to use** briefly before building (a short list of the colors,
   font stack, radii, and spacing you'll apply) — this is your own checkpoint against inventing values,
   not a required user-facing form.

6. **Build the concept as embeds**, following the `prototype` skill's mandatory flow (ask_user for scope
   if not already clear, device sizing, component-reuse-on-canvas rules, HTML safety) with one addition:
   the HTML structure inside each embed should mirror the real component's structure (the same
   meaningful wrapper/child relationships, the same variant states if relevant) rather than a generic
   reinterpretation — that fidelity to the source is the entire point of this skill. Style it with plain
   CSS built from the token values pulled in step 2/4, never with the repo's own utility class names.

### Common mistakes to avoid

- Calling `read_repo_files` before `read_design_repo` — you won't know which paths are worth reading.
- Leaving Tailwind/utility class names in the embed's `class` attributes "for reference" — they do
  nothing on canvas and just add dead weight; convert them to CSS every time.
- Treating `tokens` as a suggestion and eyeballing colors from a screenshot instead — when the brief has
  the exact hex/value, use it exactly.
- Reading every file in `components` — stay scoped to what the current request needs.
