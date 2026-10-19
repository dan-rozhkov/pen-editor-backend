import type { BrowseDescriptionSlots } from "@sideform/browser-agent/agent";

// Pen Editor's host text for the browse tools and the browse subagent prompt.
// The generic parts live in `@sideform/browser-agent/agent`; the words that
// name a Pen Editor feature (browse_task, the canvas, Pinterest, web_search,
// placeOnCanvas) are passed in here. With these values the package builds the
// strings byte for byte as they were before the move
// (test/browse-agent-text.test.ts pins them).

const BROWSE_TASK_HINT =
  "If browse_task is in your tool set, start browser tasks with it and use this tool for finishing or follow-up; if it is not, drive the browser with this tool directly (see Browser tasks in the system prompt).";

// `elementTargeting`: Pen Editor resolves browse_act's natural-language `element`
// itself (the frontend handler), so its definitions keep that field and its text.
export const PEN_EDITOR_BROWSE_SLOTS: BrowseDescriptionSlots = {
  elementTargeting: true,
  taskHint: BROWSE_TASK_HINT,
  openIntro: `${BROWSE_TASK_HINT} Opening a page the user just wants to look at is fine.`,
  openLead:
    "Opens the built-in browser tab (a REAL browser tab — in the desktop app it runs on the user's OWN logged-in session, cookies and all; in the web app it is a fresh cloud browser with no logins) and navigate it to",
  openReach:
    'This is how you reach outside references the canvas can\'t otherwise see: a Pinterest search URL (e.g. "https://www.pinterest.com/search/pins/?q=minimal%20fintech%20app%20ui") is the worked example — search results load as an infinite-scroll image grid you then read with browse_find_images.',
  snapshotStaleCauses: "browse_snapshot, browse_screenshot with annotate, or browse_task again",
  screenshotVisionNote:
    "on a text-only model this costs a second vision-model call that returns a description rather than the image itself, same as get_screenshot",
  screenshotPlacement:
    "When the user asks to capture, save, or put a browser page on the canvas or as a reference, call this tool with `placeOnCanvas: true`. The result then adds `placedNodeId`, the id of the new canvas layer, and the image is also returned to you as usual.",
  scrollExample: " like Pinterest's",
  imagesUsage:
    "The returned URLs go straight onto the canvas: imageFill.url already accepts remote http(s) URLs (falling back to the image proxy when direct loading trips CORS), so no download step is needed.",
  imagesGridExample: " (Pinterest et al.)",
  readHow:
    "This is how you read a page you've already navigated to with browse_open/browse_task: once the browser is sitting on the page you need, call this INSTEAD OF falling back to web_search for the same information — web_search only re-finds pages you can already see, and cannot read this one's actual current content (a search result, a filtered listing, anything behind a click).",
};

export const PEN_EDITOR_BROWSE_PRINCIPAL = "a design assistant";

/** Guidance bullet that both the manual guidance and the subagent prompt carry. */
export const PEN_EDITOR_SCREENSHOT_BULLET =
  "- To put a screenshot of the browser page on the canvas, call `browse_screenshot` with `placeOnCanvas: true`.";

/** Guidance bullet only the manual guidance carries. */
export const PEN_EDITOR_CAPTURE_BULLET =
  "- To put an editable copy of the page on the canvas when the user asks for it, call `browse_capture`.";

/** Paragraph of the subagent prompt for the gated browse_capture tool. */
export const PEN_EDITOR_CAPTURE_SECTION =
  "If browse_capture is in your tools, the user asked for a copy of a page on the canvas: get to the right page (and element), call browse_capture once, and report its nodeId.";

/**
 * Slots for the desktop-app variant of browse_open. Used only when the client
 * advertises `browseApps` AND the browser is the desktop one.
 */
export const PEN_EDITOR_BROWSE_APP_SLOTS: BrowseDescriptionSlots = {
  ...PEN_EDITOR_BROWSE_SLOTS,
  appLaunch: true,
  openApp:
    "Desktop apps: to start an Electron desktop app, pass `app` instead of `url`. `app` is the path of a macOS .app of an Electron app, for example /Applications/Orca.app. Pass `url` or `app`, not both. The user must confirm the launch. The app starts with a new profile that has no logins. Each window of the app is a tab. Until the run ends, you cannot open URLs or new tabs. You cannot see native menus or file dialogs.",
};

/** Text of the `app` field of browse_agent (same facts as `openApp`). */
export const PEN_EDITOR_BROWSE_AGENT_APP_FIELD =
  "Optional. The path of a macOS .app of an Electron desktop app, for example /Applications/Orca.app. The browser starts this app instead of opening a URL, and the subagent works inside it. Do not use it together with `url`, `setup`, `resume` or `capture`. Run one app run at a time: do not call browse_agent with `app` in parallel. The user must confirm the launch. The app starts with a new profile that has no logins. Each window of the app is a tab. Until the run ends, the subagent cannot open URLs or new tabs and cannot see native menus or file dialogs.";
