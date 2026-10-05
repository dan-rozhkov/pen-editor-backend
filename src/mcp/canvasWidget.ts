import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { parseEnvList, type Config } from "../config.js";
import type { SessionCredential } from "./bridge.js";
import { mintBridgeTicket } from "./bridgeTickets.js";

// The Sideform canvas as an MCP Apps widget (SEP-1865): `open_canvas` makes the
// host render this `ui://` resource, whose iframe loads the editor in embed
// mode and joins the bridge with a ticket. Registered only on the remote
// `/mcp` server, where the caller (and so the ticket owner) is known.
export const CANVAS_RESOURCE_URI = "ui://sideform/canvas-v1.html";
export const BRIDGE_META_KEY = "sideform/bridge";
export const BRIDGE_TICKET_TOOL = "sideform_bridge_ticket";

export interface CanvasWidgetSettings {
  appOrigin: string;
  /** Public API origin (BETTER_AUTH_URL), no trailing slash. */
  apiOrigin: string;
  /** Origins of the S3 public bases (screens/uploads served as <img>). */
  storageOrigins: string[];
  /** Extra origins (MCP_APP_RESOURCE_DOMAINS) for images and the like. */
  extraDomains: string[];
}

const toOrigin = (url: string): string | null => (URL.canParse(url) ? new URL(url).origin : null);

// Every origin is normalized through URL so a hostile or sloppy env value (a
// path, quotes, a trailing slash) can never reach the HTML or the CSP verbatim.
export function resolveCanvasWidgetSettings(config: Config, appOrigin: string, apiOrigin: string): CanvasWidgetSettings {
  const origins = (urls: string[]) => urls.map(toOrigin).filter((o): o is string => o !== null);
  return {
    appOrigin: toOrigin(appOrigin) ?? "",
    apiOrigin: toOrigin(apiOrigin) ?? "",
    storageOrigins: origins([
      ...(config.S3_PUBLIC_BASE_URL ? [config.S3_PUBLIC_BASE_URL] : []),
      ...parseEnvList(config.S3_LEGACY_PUBLIC_BASE_URLS),
    ]),
    extraDomains: origins(parseEnvList(config.MCP_APP_RESOURCE_DOMAINS)),
  };
}

const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const STATIC_RESOURCE_HOSTS = [
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://unpkg.com",
  "https://picsum.photos",
  "https://fastly.picsum.photos",
];

export function canvasWidgetHtml(appOrigin: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Sideform canvas</title>` +
    `<style>html,body,#root{height:100%;margin:0}</style></head>` +
    `<body><div id="root"></div>` +
    `<script type="module" src="${escapeAttr(`${appOrigin}/embed/loader.js`)}"></script></body></html>`
  );
}

const wsOrigin = (apiOrigin: string): string => apiOrigin.replace(/^http/, "ws");

export function canvasWidgetCsp(settings: CanvasWidgetSettings) {
  const unique = (items: string[]) => [...new Set(items)];
  return {
    // The API origin is also a resource host: the image proxy is loaded via <img>.
    resourceDomains: unique([
      settings.appOrigin,
      settings.apiOrigin,
      ...STATIC_RESOURCE_HOSTS,
      ...settings.storageOrigins,
      ...settings.extraDomains,
    ]),
    connectDomains: unique([settings.apiOrigin, wsOrigin(settings.apiOrigin), ...settings.extraDomains]),
  };
}

function ticketPayload(owner: string, credential: SessionCredential, settings: CanvasWidgetSettings) {
  return { ticket: mintBridgeTicket(owner, credential), wsUrl: `${wsOrigin(settings.apiOrigin)}/api/mcp/ws` };
}

export function registerCanvasWidget(
  server: McpServer,
  owner: string,
  credential: SessionCredential,
  settings: CanvasWidgetSettings,
): void {
  const uiMeta = { ui: { csp: canvasWidgetCsp(settings), prefersBorder: false } };

  registerAppResource(
    server,
    "Sideform canvas",
    CANVAS_RESOURCE_URI,
    { description: "The live Sideform design canvas.", _meta: uiMeta },
    async () => ({
      contents: [
        {
          uri: CANVAS_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: canvasWidgetHtml(settings.appOrigin),
          _meta: uiMeta,
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "open_canvas",
    {
      title: "Open Sideform canvas",
      description:
        "Open the live Sideform canvas in this conversation. Call it once before the design tools when the client can display apps; afterwards the design tools edit this canvas.",
      inputSchema: {},
      _meta: { ui: { resourceUri: CANVAS_RESOURCE_URI }, "openai/outputTemplate": CANVAS_RESOURCE_URI },
    },
    async () => ({
      content: [{ type: "text" as const, text: `If your client displays apps, the Sideform canvas is now shown in the conversation and design tools edit it. Otherwise open ${settings.appOrigin}/app in a browser while signed in.` }],
      _meta: { [BRIDGE_META_KEY]: ticketPayload(owner, credential, settings) },
    }),
  );

  registerAppTool(
    server,
    BRIDGE_TICKET_TOOL,
    {
      description: "Mint a fresh bridge ticket so the canvas widget can reconnect. Called by the widget, not the model.",
      inputSchema: {},
      _meta: { ui: { resourceUri: CANVAS_RESOURCE_URI, visibility: ["app"] } },
    },
    async () => ({
      content: [{ type: "text" as const, text: "Bridge ticket issued." }],
      _meta: { [BRIDGE_META_KEY]: ticketPayload(owner, credential, settings) },
    }),
  );
}
