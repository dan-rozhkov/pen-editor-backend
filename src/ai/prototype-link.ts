import { generateObject } from "ai";
import { z } from "zod";
import type { Config } from "../config.js";
import { createModel } from "./provider.js";

export interface PrototypeCandidate {
  protoId: string;
  tag: string;
  text: string;
  ariaLabel?: string;
  href?: string;
  /** The element's `class` attribute — an intent signal when text is thin
   * (icon-only buttons) or generic (`plant-card` → a plant detail screen). */
  classHint?: string;
}
export interface PrototypeScreenInput {
  id: string;
  name: string;
  candidates: PrototypeCandidate[];
  content?: string;
}
export interface PrototypeLink {
  screenId: string;
  protoId: string;
  targetScreenId: string;
}

export const prototypeLinkResultSchema = z.object({
  links: z.array(
    z.object({
      screenId: z.string(),
      protoId: z.string(),
      targetScreenId: z.string(),
    }),
  ),
});

function buildPrompt(screens: PrototypeScreenInput[]): string {
  const lines = screens
    .map((s) => {
      const cands = s.candidates.length
        ? s.candidates
            .map(
              (c) =>
                `    - ${c.protoId}: <${c.tag}${c.classHint ? `.${c.classHint.split(" ").join(".")}` : ""}> "${c.text}"${c.ariaLabel ? ` [aria: ${c.ariaLabel}]` : ""}${c.href ? ` (href=${c.href})` : ""}`,
            )
            .join("\n")
        : "    (no clickable elements)";
      const content = s.content
        ? `    Content excerpt: "${s.content}"\n`
        : "";
      return `- screen "${s.name}" (id: ${s.id}):\n${content}    Clickable elements:\n${cands}`;
    })
    .join("\n");
  return [
    "You are wiring a clickable prototype from a set of app screens.",
    "This is a clickable prototype: for EVERY clickable element that plausibly navigates to another screen, pick the target screen.",
    "Prefer linking over leaving unlinked when a reasonable destination exists — under-linking makes the prototype feel broken.",
    "Use the screen id EXACTLY as given below (the id is a short slug like 'dashboard', not the screen name).",
    "Each element is shown as `<tag.class...>` — the class names (e.g. `plant-card`, `tab`, `back`, `list-item`) are a strong hint about what the element is, even when its text is empty (icon-only controls).",
    "Use the element label, its classes, the content excerpt, AND the screen names to reason about intent, for example:",
    "  - a 'Pricing' link/button anywhere → the pricing screen.",
    "  - a primary 'Sign in' / 'Log in' / 'Get started' / 'Continue' CTA on an auth or landing screen → the main app/dashboard screen.",
    "  - an item card/row/tile (a `card`/`item`/`tile` element whose text names a specific thing, e.g. a 'Monstera' plant card) → that thing's detail screen (e.g. a 'Plant Detail - Monstera' screen).",
    "  - a bottom-nav / tab-bar entry (`tab`, `nav-item`) whose label matches a section → that section's screen.",
    "  - a `back` control or 'Back' / 'Cancel' → the previous/parent screen the user came from.",
    "Only skip elements that are truly non-navigational (form toggles/checkboxes, 'Delete', theme switch, and similar in-place controls).",
    "Do NOT invent screens — every targetScreenId must be one of the ids listed below.",
    "",
    "Screens:",
    lines,
  ].join("\n");
}

/**
 * Resolve a model-returned targetScreenId against the known screen id set.
 * Models sometimes echo the screen's display name instead of its id, or get
 * the id's case wrong — salvage those instead of silently dropping the link.
 */
function resolveTargetScreenId(
  raw: string,
  screens: PrototypeScreenInput[],
  ids: Set<string>,
): string | undefined {
  if (ids.has(raw)) return raw;
  const lower = raw.toLowerCase();
  const byId = screens.find((s) => s.id.toLowerCase() === lower);
  if (byId) return byId.id;
  const byName = screens.find((s) => s.name.toLowerCase() === lower);
  if (byName) return byName.id;
  return undefined;
}

export async function generatePrototypeLinks(
  screens: PrototypeScreenInput[],
  config: Config,
): Promise<{ links: PrototypeLink[] }> {
  const ids = new Set(screens.map((s) => s.id));
  const candByScreen = new Map(
    screens.map((s) => [s.id, new Set(s.candidates.map((c) => c.protoId))]),
  );

  const { object } = await generateObject({
    model: createModel(config),
    schema: prototypeLinkResultSchema,
    prompt: buildPrompt(screens),
  });

  // Defensive filter: keep only links referencing known screens + real candidates,
  // resolving a mistyped/name-echoed targetScreenId where possible, and never
  // link a screen to itself.
  const links: PrototypeLink[] = [];
  for (const l of object.links) {
    if (!ids.has(l.screenId)) continue;
    if (!candByScreen.get(l.screenId)?.has(l.protoId)) continue;
    const targetScreenId = resolveTargetScreenId(l.targetScreenId, screens, ids);
    if (!targetScreenId) continue;
    if (targetScreenId === l.screenId) continue;
    links.push({ ...l, targetScreenId });
  }
  return { links };
}
