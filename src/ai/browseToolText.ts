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

/** Profile facts of an app run. Shared by `openApp` and the browse_agent `app` field. */
/** Last two sentences of the profile facts, shared by the plain and the native text. */
const APP_PROFILE_TAIL =
  "The launch result has `profile: \"user\"` when it uses the user's profile. Do not tell the user which profile is in use unless the result says it.";

const APP_PROFILE_FACTS =
  "If the app is already open, the user is asked to restart it. Then the run uses the user's own profile with their logins and data. Otherwise the app starts with a new profile that has no logins. " + APP_PROFILE_TAIL;

/** Do not guess where a local app lives. */
const APP_NO_GUESS = "Do not guess the address of a local app or dev server. Do not try ports. Ask the user for the .app path or the URL.";

const WINDOW_RULE_PLAIN = "use the window of the app, not an `about:blank` or `data:` window";
const WINDOW_RULE_NATIVE = "use the window of the app. In an Electron app that Sideform launched, do not use an `about:blank` or `data:` window";

/** Behavior rules for the main agent in an app run (browse_open `app`). */
const appRulesOpen = (windowRule: string) =>
  `Before you test, check that the window title or page text names the app the user asked for. If it names another product, stop and tell the user. If a read is empty or fails, do not say the app has no data. Call \`browse_tabs\` with \`action: "list"\` and ${windowRule}. If you cannot confirm the right window, tell the user that you could not read the screen. If the user says what they see on the screen, do not contradict it. Find the cause of the difference. Do not state how profiles, sessions or data storage work unless a tool result says it. Mark a guess as a guess. Do not reload the app, quit it, or ask the user to quit it unless the user agrees first.`;
const APP_RULES_OPEN = appRulesOpen(WINDOW_RULE_PLAIN);

/** Same rules for browse_agent: the subagent holds the browser tools. */
const appRulesAgent = (windowRule: string) =>
  `Before you test, tell the subagent to check that the window title or page text names the app the user asked for. If the report names another product, stop and tell the user. If the report says the screen is empty or unread, do not say the app has no data. Tell the user that you could not read the screen, or run again and tell the subagent to list the windows and ${windowRule}. If the user says what they see on the screen, do not contradict it. Find the cause of the difference. Do not state how profiles, sessions or data storage work unless a tool result says it. Mark a guess as a guess. Do not tell the subagent to reload or quit the app, and do not ask the user to quit it, unless the user agrees first.`;
const APP_RULES_AGENT = appRulesAgent(WINDOW_RULE_PLAIN);

/**
 * Slots for the desktop-app variant of browse_open. Used only when the client
 * advertises `browseApps` AND the browser is the desktop one.
 */
export const PEN_EDITOR_BROWSE_APP_SLOTS: BrowseDescriptionSlots = {
  ...PEN_EDITOR_BROWSE_SLOTS,
  appLaunch: true,
  openApp: `Desktop apps: to start an Electron desktop app, pass \`app\` instead of \`url\`. \`app\` is the path of a macOS .app of an Electron app, for example /Applications/Orca.app. Pass \`url\` or \`app\`, not both. ${APP_NO_GUESS} The user must confirm the launch. ${APP_PROFILE_FACTS} Each window of the app is a tab. Until the run ends, you cannot open URLs or new tabs. You cannot see native menus or file dialogs. ${APP_RULES_OPEN}`,
};

/** Text of the `app` field of browse_agent (same facts as `openApp`). */
export const PEN_EDITOR_BROWSE_AGENT_APP_FIELD = `Optional. The path of a macOS .app of an Electron desktop app, for example /Applications/Orca.app. The browser starts this app instead of opening a URL, and the subagent works inside it. Do not use it together with \`url\`, \`setup\`, \`resume\` or \`capture\`. ${APP_NO_GUESS} Run one app run at a time: do not call browse_agent with \`app\` in parallel. The user must confirm the launch. ${APP_PROFILE_FACTS} Each window of the app is a tab. Until the run ends, the subagent cannot open URLs or new tabs and cannot see native menus or file dialogs.`;

/** Behavior rules for browse_agent with `app` (appended to the head by tools.ts). */
export const PEN_EDITOR_BROWSE_AGENT_APP_RULES = APP_RULES_AGENT;

// ── Native macOS apps (client capability `browseNativeApps`) ──────────────
// Used only with the desktop browser, `browseApps` and `browseNativeApps` all
// on. Plain strings, no runtime input: the bytes are the same for every
// request with the same flags, so prompt caching is not disturbed.

/** Which app text a client gets. */
export type BrowseAppText = false | "electron" | "native";

/** Electron facts for an app that is not running (the restart sentence does not apply). */
const APP_PROFILE_FACTS_NOT_RUNNING =
  "An Electron app that is not running starts with a new profile that has no logins. " + APP_PROFILE_TAIL;

/** Facts of a native-aware app run. Shared by `openApp` and the browse_agent `app` field. */
const APP_NATIVE_FACTS =
  "An app that is already running is controlled without a restart. This works for any macOS app. The run uses the accessibility tree and window screenshots of the app, in the user's own session. The user confirms each attach in a dialog. The `tag` of an element is its accessibility role. `browse_tabs` lists the windows of the app. Back, forward, reload, upload and viewport do not work there. `browse_find_images` and `browse_capture` are not available there. QA checks work only in part there: a `text` check, and an `element` or `value` check with an `index` from `browse_snapshot`. Checks with a CSS selector, `count` and `url` checks fail there. `no_console_errors` and `no_failed_requests` always pass there and prove nothing. An absent or hidden check means \"not visible in the window\": scroll first if the content can be out of view. If a tool returns a permission error, pass it to the user. Do not retry. Actions may bring the app to the front and move the pointer. Do not act faster than needed. You cannot see native menus or file dialogs. When `browse_screenshot` is in the tool set, it shows the window as an image. Use it when the snapshot is empty or does not show the content. When the snapshot does not have the control, `browse_act` `click` and `type` also accept `x` and `y` in pixels of the latest `browse_screenshot`. Prefer `index` when the element is in the snapshot. After a click at `x` and `y`, take a new `browse_screenshot` to check the result. An app that is not running and is not an Electron app cannot be started. Ask the user to open it. If the app is not running, the user must confirm the launch in a dialog. " +
  APP_PROFILE_FACTS_NOT_RUNNING;

const APP_RULES_OPEN_NATIVE = appRulesOpen(WINDOW_RULE_NATIVE);
const APP_RULES_AGENT_NATIVE = appRulesAgent(WINDOW_RULE_NATIVE);

const APP_NAME_FORM =
  "`app` is the name of the app as shown in the Dock or in its window title, for example \"Qure Dev\", or the path of a .app, for example /Applications/Orca.app.";

/** Description of the `app` property of browse_open, native-aware. */
export const PEN_EDITOR_BROWSE_OPEN_APP_FIELD_NATIVE =
  "The name of the app as shown in the Dock or in its window title, for example \"Qure Dev\", or the path of a .app, for example /Applications/Orca.app. Use instead of `url`.";

/** Slots for browse_open when the client also advertises `browseNativeApps`. */
export const PEN_EDITOR_BROWSE_APP_SLOTS_NATIVE: BrowseDescriptionSlots = {
  ...PEN_EDITOR_BROWSE_SLOTS,
  coordinateActions: true,
  appLaunch: true,
  openApp: `Desktop apps: to work in a desktop app, pass \`app\` instead of \`url\`. ${APP_NAME_FORM} Pass \`url\` or \`app\`, not both. ${APP_NO_GUESS} ${APP_NATIVE_FACTS} Each window of the app is a tab. Until the run ends, you cannot open URLs or new tabs. ${APP_RULES_OPEN_NATIVE}`,
};

/** Text of the `app` field of browse_agent, native-aware. */
export const PEN_EDITOR_BROWSE_AGENT_APP_FIELD_NATIVE = `Optional. ${APP_NAME_FORM} The browser works in this app instead of opening a URL, and the subagent works inside it. Do not use it together with \`url\`, \`setup\`, \`resume\` or \`capture\`. ${APP_NO_GUESS} Run one app run at a time: do not call browse_agent with \`app\` in parallel. ${APP_NATIVE_FACTS} Each window of the app is a tab. Until the run ends, the subagent cannot open URLs or new tabs. If the user asks to work from screenshots, say so in \`goal\`: the subagent uses browse_screenshot when it is available, and can click and type at a point of a screenshot. Do not refuse the request yourself.`;

/** Behavior rules for browse_agent with a native-aware `app`. */
export const PEN_EDITOR_BROWSE_AGENT_APP_RULES_NATIVE = APP_RULES_AGENT_NATIVE;
