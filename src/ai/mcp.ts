import { createMCPClient } from "@ai-sdk/mcp";
import type { Config } from "../config.js";

type StringKeys<T> = {
  [K in keyof T]: T[K] extends string | undefined ? K : never;
}[keyof T] &
  string;

interface MCPServerEntry {
  name: string;
  url: string;
  apiKeyEnvField: StringKeys<Config>;
}

const MCP_SERVERS: MCPServerEntry[] = [
  {
    name: "refero",
    url: "https://api.refero.design/mcp/",
    apiKeyEnvField: "REFERO_API_KEY",
  },
];

/** Hard deadline for connecting to an MCP server and listing its tools. A hung
 * upstream must not pin the shared in-flight cache entry forever — rejection
 * evicts it (see pending.catch below) so the next request retries. */
const MCP_CONNECT_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[mcp] ${label}: connect/tools timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

interface CachedEntry {
  client: MCPClient;
  tools: Record<string, unknown>;
}

const cache = new Map<string, Promise<CachedEntry>>();

export function removeBase64Fields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeBase64Fields);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input)) {
    if (key === "base64") continue;
    out[key] = removeBase64Fields(val);
  }
  return out;
}

export function sanitizeMcpToolResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const output = removeBase64Fields(result) as Record<string, unknown>;
  const content = output.content;
  if (!Array.isArray(content)) return output;

  output.content = content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const typed = part as Record<string, unknown>;
    const text = typed.text;
    if (typeof text !== "string") return part;
    try {
      const parsed = JSON.parse(text);
      const sanitized = removeBase64Fields(parsed);
      return { ...typed, text: JSON.stringify(sanitized) };
    } catch {
      return part;
    }
  });
  return output;
}

interface ReferoTool {
  description?: string;
  title?: string;
  inputSchema?: unknown;
  toModelOutput?: unknown;
  type?: unknown;
  _meta?: unknown;
  execute?: (input: unknown, options: unknown) => Promise<unknown>;
}

type ToolExecute = (input: unknown, options: unknown) => Promise<unknown>;

/** Wraps a single named Refero tool (no-op if absent or execute-less), optionally
 * rewriting its description and always rewriting its execute function. Keeps the
 * tool-map reference unchanged (`===`) when the named tool isn't present, so
 * composing several wraps over an unaffected map is still an identity op. */
function wrapReferoTool(
  tools: Record<string, unknown>,
  name: string,
  options: {
    describe?: (description: string | undefined) => string;
    transformExecute: (originalExecute: ToolExecute) => ToolExecute;
  },
): Record<string, unknown> {
  const tool = tools[name] as ReferoTool | undefined;
  if (!tool || typeof tool.execute !== "function") {
    return tools;
  }

  const originalExecute = tool.execute.bind(tool);
  return {
    ...tools,
    [name]: {
      ...tool,
      ...(options.describe ? { description: options.describe(tool.description) } : {}),
      execute: options.transformExecute(originalExecute),
    },
  };
}

const INVALID_STYLE_UUIDS_PATTERN = /invalid[-_ ]?style[-_ ]?uuids?/i;
const STYLE_UUID_DESCRIPTION_HINT =
  "Pass exactly one valid style UUID (from refero_search_styles results) per call; multiple UUIDs are rejected.";
const STYLE_UUID_ERROR_HINT =
  "Pass exactly one valid style UUID from refero_search_styles results per call.";

function withStyleUuidHint(text: string): string {
  return INVALID_STYLE_UUIDS_PATTERN.test(text) ? `${text} ${STYLE_UUID_ERROR_HINT}` : text;
}

/** Appends the deterministic retry hint to any text content part whose text
 * indicates invalid style UUIDs (case-insensitive, either spelling). Skips
 * enrichment entirely for results explicitly marked `isError: false` (a
 * benign success payload should never gain a retry hint, even if its text
 * happens to contain the phrase); Refero's exact error shape is otherwise
 * unverified, so `isError` being true or absent still allows matching.
 * Returns the input object unchanged (`===`) when nothing matches, avoiding
 * a needless clone of the already-sanitized payload. */
function enrichStyleUuidResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const output = result as Record<string, unknown>;
  if (output.isError === false) return result;

  const content = output.content;
  if (!Array.isArray(content)) return result;

  const hasMatch = content.some(
    (part) =>
      part &&
      typeof part === "object" &&
      typeof (part as Record<string, unknown>).text === "string" &&
      INVALID_STYLE_UUIDS_PATTERN.test((part as Record<string, unknown>).text as string),
  );
  if (!hasMatch) return result;

  return {
    ...output,
    content: content.map((part) => {
      if (!part || typeof part !== "object") return part;
      const typed = part as Record<string, unknown>;
      if (typeof typed.text !== "string") return part;
      return { ...typed, text: withStyleUuidHint(typed.text) };
    }),
  };
}

/** Same hint, applied when Refero signals the error by throwing instead of
 * returning an error result. */
function enrichStyleUuidThrownError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!INVALID_STYLE_UUIDS_PATTERN.test(message)) return err;

  const hinted = withStyleUuidHint(message);
  if (err instanceof Error) {
    const wrapped = new Error(hinted);
    wrapped.cause = err;
    return wrapped;
  }
  return new Error(hinted);
}

export function wrapReferoTools(tools: Record<string, unknown>): Record<string, unknown> {
  let result = wrapReferoTool(tools, "refero_get_screen", {
    // Force no binary payloads from Refero and sanitize any accidental base64 in result.
    transformExecute: (originalExecute) => async (input, options) => {
      const normalizedInput =
        input && typeof input === "object"
          ? { ...(input as Record<string, unknown>), image_size: "none" }
          : { image_size: "none" };
      const res = await originalExecute(normalizedInput, options);
      return sanitizeMcpToolResult(res);
    },
  });

  result = wrapReferoTool(result, "refero_get_style", {
    // Steer the model toward a single valid UUID up front, and give it a
    // deterministic hint to retry with if it still sends several/invalid ones.
    describe: (description) =>
      description ? `${description} ${STYLE_UUID_DESCRIPTION_HINT}` : STYLE_UUID_DESCRIPTION_HINT,
    transformExecute: (originalExecute) => async (input, options) => {
      try {
        const res = await originalExecute(input, options);
        return enrichStyleUuidResult(sanitizeMcpToolResult(res));
      } catch (err) {
        throw enrichStyleUuidThrownError(err);
      }
    },
  });

  return result;
}

function connectAndFetchTools(
  entry: MCPServerEntry,
  apiKey: string,
): Promise<CachedEntry> {
  const pending = withTimeout(
    (async () => {
      const client = await createMCPClient({
        transport: {
          type: "http",
          url: entry.url,
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      });
      const tools = await client.tools();
      const wrappedTools = entry.name === "refero" ? wrapReferoTools(tools) : tools;
      console.log(`[mcp] Connected to ${entry.name} at ${entry.url}`);
      return { client, tools: wrappedTools };
    })(),
    MCP_CONNECT_TIMEOUT_MS,
    entry.name,
  );

  pending.catch(() => {
    cache.delete(entry.name);
  });

  return pending;
}

export async function getMCPTools(
  config: Config,
): Promise<Record<string, unknown>> {
  const promises: Promise<CachedEntry>[] = [];
  for (const entry of MCP_SERVERS) {
    const apiKey = config[entry.apiKeyEnvField];
    if (!apiKey) continue;

    if (!cache.has(entry.name)) {
      cache.set(entry.name, connectAndFetchTools(entry, apiKey));
    }
    promises.push(cache.get(entry.name)!);
  }

  const results = await Promise.allSettled(promises);

  const merged: Record<string, unknown> = {};
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      Object.assign(merged, result.value.tools);
    } else {
      const name = MCP_SERVERS[index]?.name ?? "unknown";
      console.warn(`[mcp] Failed to fetch tools from ${name}:`, result.reason);
    }
  }
  return merged;
}

export async function closeAllMCPClients(): Promise<void> {
  const entries = [...cache.entries()];
  cache.clear();

  await Promise.allSettled(
    entries.map(async ([name, pending]) => {
      try {
        const { client } = await pending;
        await client.close();
        console.log(`[mcp] Closed client: ${name}`);
      } catch (err) {
        console.warn(`[mcp] Error closing client ${name}:`, err);
      }
    }),
  );
}
