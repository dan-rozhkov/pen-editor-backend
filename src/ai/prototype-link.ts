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
}
export interface PrototypeScreenInput {
  id: string;
  name: string;
  candidates: PrototypeCandidate[];
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
                `    - ${c.protoId}: <${c.tag}> "${c.text}"${c.ariaLabel ? ` [aria: ${c.ariaLabel}]` : ""}${c.href ? ` (href=${c.href})` : ""}`,
            )
            .join("\n")
        : "    (no clickable elements)";
      return `- screen "${s.name}" (id: ${s.id}):\n${cands}`;
    })
    .join("\n");
  return [
    "You are wiring a clickable prototype from a set of app screens.",
    "Each screen has clickable elements (buttons/links/cards) identified by protoId.",
    "For each element that logically navigates somewhere, decide which screen it should open.",
    "Only link to screens in the provided set. Use the element label AND the screen names to reason",
    "(e.g. a 'Sign in' button on a Login screen → the Dashboard/Home screen; 'Pricing' → the Pricing screen).",
    "Do NOT invent screens. Skip elements that are not navigational (e.g. 'Delete', form toggles).",
    "",
    "Screens:",
    lines,
  ].join("\n");
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
  // and never link a screen to itself.
  const links = object.links.filter(
    (l) =>
      ids.has(l.screenId) &&
      ids.has(l.targetScreenId) &&
      l.screenId !== l.targetScreenId &&
      candByScreen.get(l.screenId)?.has(l.protoId),
  );
  return { links };
}
