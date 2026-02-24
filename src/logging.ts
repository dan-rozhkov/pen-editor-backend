import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface LogStep {
  stepNumber: number;
  text: string;
  toolCalls: { toolName: string; args: Record<string, unknown> }[];
  toolResults: { toolName: string; result: unknown }[];
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface SessionLog {
  sessionId: string;
  timestamp: string;
  model: string;
  systemPrompt: string;
  messages: unknown[];
  steps: LogStep[];
  totalUsage: { inputTokens: number; outputTokens: number };
}

const LOGS_DIR = join(process.cwd(), ".logs");

export async function logSession(data: SessionLog): Promise<void> {
  await mkdir(LOGS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const random = randomBytes(4).toString("hex");
  const filename = `session-${timestamp}-${random}.json`;
  await writeFile(join(LOGS_DIR, filename), JSON.stringify(data, null, 2));
}
