import type { EvalSuite, EvalTask } from "./types.js";

const SLIDES = { width: 1024, height: 768 };

// Brief that pins every question the prototype/slides skills ask in their
// ask_user step ("Skip this only if the user's message already pins down every
// one of these"): audience, platform, visitor mode, tone, scope, reuse.
const PINNED_PROTOTYPE_BRIEF =
  "Mobile app for freelance illustrators to track invoices. Audience: solo freelancers, ages 25-40. " +
  "Platform: iPhone, 390x844. Visitor mode: signed-in returning user, light mode. Tone: calm, precise, " +
  "slightly playful. Scope: exactly one screen, the invoice list home screen. Reuse: nothing exists yet, " +
  "start from scratch with no existing design system or components. Write all copy in English. " +
  "Do not ask me anything, everything is decided.";

const PINNED_SLIDES_BRIEF =
  "Slide deck for a seed-round pitch of a carbon-accounting startup called Ledgerleaf. Audience: " +
  "seed investors. Format: 4:3 slides for a live presentation. Tone: confident, data-first, no hype. " +
  "Scope: exactly 5 slides: problem, solution, market, traction, ask. Reuse: nothing exists yet, " +
  "start from scratch with no template. Write all copy in English. Do not ask me anything, everything is decided.";

export const EVAL_TASKS: EvalTask[] = [
  {
    id: "reg-routing-prototype",
    suite: "regression",
    mode: "default",
    prompt: "create a new mobile onboarding screen for a meditation app",
    graders: [
      { type: "skill-loaded-first", skill: "prototype" },
      { type: "embeds-present", min: 1 },
      { type: "embed-only" },
    ],
    source: "Incident: prototype routing fix (0.17.2) - a plain chat turn must load the prototype skill before drawing. Skill: FIRST DECISION gate.",
  },
  {
    id: "reg-quotes",
    suite: "regression",
    mode: "prototype",
    prompt:
      "mobile app, a reviews screen for a bookshop. The copy is full of quotes: Russian «Лучшая книга года» and " +
      "\"Не оторваться\", English reviews like \"It's the kind of book you can't put down\" and 'A reader's dream', " +
      "with apostrophes in names (O'Brien, D'Angelo). One screen. Decide everything yourself.",
    graders: [{ type: "html-complete" }, { type: "embeds-present", min: 1 }],
    source: "Incident: batch_design unescaped-quote truncation - blank white screens (htmlContent cut at the first inner quote).",
  },
  {
    id: "reg-image-urls",
    suite: "regression",
    mode: "prototype",
    prompt:
      "mobile app for a travel agency, 3 image-heavy screens: destination feed, destination detail with a photo " +
      "gallery, and a saved trips list with thumbnails. Use real photography everywhere. Decide everything yourself.",
    graders: [{ type: "image-urls-issued" }, { type: "image-budget" }],
    source: "Incident: showcase mistyped image URLs - the model mistyped a generated-image URL, S3 answered 403 (object absent).",
  },
  {
    id: "reg-mobile-box",
    suite: "regression",
    mode: "prototype",
    prompt: "mobile app for a bike-sharing service, a 3-screen flow: map, ride in progress, ride summary. Decide everything yourself.",
    graders: [{ type: "box-size", platform: "mobile" }, { type: "embed-only" }, { type: "embeds-present", min: 3 }],
    source: "Skill prototype.md mobile device preset (390x844) and the FIR-45 embed-only guard.",
  },
  {
    id: "reg-slides-structure",
    suite: "regression",
    mode: "slides",
    prompt: "a 5-slide deck: quarterly product review for a note-taking app. Decide everything yourself.",
    graders: [
      { type: "box-size", ...SLIDES },
      { type: "filmstrip" },
      { type: "embeds-present", min: 5 },
    ],
    source: "Skill slides.md rules 2 and 3: 1024x768 slides in one horizontal filmstrip row.",
  },
  {
    id: "neg-ask-pinned-prototype",
    suite: "regression",
    mode: "prototype",
    prompt: PINNED_PROTOTYPE_BRIEF,
    graders: [{ type: "not-asked" }, { type: "embeds-present", min: 1 }],
    source: 'Skill prototype.md ask_user step: "Skip this only if the user\'s message already pins down every one of these".',
  },
  {
    id: "pos-ask-vague-prototype",
    suite: "regression",
    mode: "prototype",
    prompt: "make a screen for a coffee shop app",
    graders: [{ type: "asked-first" }],
    source: "Skill prototype.md ask_user step: a vague brief must be asked about before building.",
  },
  {
    id: "neg-ask-pinned-slides",
    suite: "regression",
    mode: "slides",
    prompt: PINNED_SLIDES_BRIEF,
    graders: [{ type: "not-asked" }, { type: "embeds-present", min: 5 }],
    source: 'Skill slides.md ask_user step: "Skip this only if the user\'s message already pins down every one of these".',
  },
  {
    id: "pos-ask-vague-slides",
    suite: "regression",
    mode: "slides",
    prompt: "make a presentation about our company",
    graders: [{ type: "asked-first" }],
    source: "Skill slides.md ask_user step: a vague brief must be asked about before building.",
  },
  {
    id: "cap-taste-mobile",
    suite: "capability",
    mode: "prototype",
    prompt: "mobile app for a neighbourhood tool-lending library, a 3-screen flow: browse tools, tool detail, borrow confirmation. Decide everything yourself.",
    graders: [{ type: "embeds-present", min: 3 }, { type: "taste-clean" }],
    source: "Probes P-009, P-011, P-012 (taste probes): AI-slop patterns from frontend-design.md.",
  },
  {
    id: "cap-taste-slides",
    suite: "capability",
    mode: "slides",
    prompt: "a 5-slide deck: annual report of a community-run public library. Decide everything yourself.",
    graders: [{ type: "embeds-present", min: 5 }, { type: "taste-clean" }],
    source: "Probes P-009, P-011, P-012 (taste probes) applied to slides.",
  },
  {
    id: "cap-research-grounded",
    suite: "capability",
    mode: "research",
    prompt: "/research find onboarding references for a fintech app",
    graders: [{ type: "grounded-refs" }],
    source: "Research mode contract: every cited reference URL must come from a tool result, not from memory.",
  },
];

export function selectTasks(suite: EvalSuite | "all", taskId?: string): EvalTask[] {
  const bySuite = EVAL_TASKS.filter((t) => suite === "all" || t.suite === suite);
  return taskId ? EVAL_TASKS.filter((t) => t.id === taskId) : bySuite;
}
