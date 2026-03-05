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

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

interface CachedEntry {
  client: MCPClient;
  tools: Record<string, unknown>;
}

const cache = new Map<string, Promise<CachedEntry>>();

function removeBase64Fields(value: unknown): unknown {
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

function sanitizeMcpToolResult(result: unknown): unknown {
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

function wrapReferoTools(tools: Record<string, unknown>): Record<string, unknown> {
  const tool = tools.refero_get_screen as {
    description?: string;
    title?: string;
    inputSchema?: unknown;
    toModelOutput?: unknown;
    type?: unknown;
    _meta?: unknown;
    execute?: (input: unknown, options: unknown) => Promise<unknown>;
  } | undefined;

  if (!tool || typeof tool.execute !== "function") {
    return tools;
  }

  const originalExecute = tool.execute.bind(tool);
  const wrapped = {
    ...tool,
    // Force no binary payloads from Refero and sanitize any accidental base64 in result.
    execute: async (input: unknown, options: unknown) => {
      const normalizedInput =
        input && typeof input === "object"
          ? { ...(input as Record<string, unknown>), image_size: "none" }
          : { image_size: "none" };
      const result = await originalExecute(normalizedInput, options);
      return sanitizeMcpToolResult(result);
    },
  };

  return {
    ...tools,
    refero_get_screen: wrapped,
  };
}

function connectAndFetchTools(
  entry: MCPServerEntry,
  apiKey: string,
): Promise<CachedEntry> {
  const pending = (async () => {
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
  })();

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
