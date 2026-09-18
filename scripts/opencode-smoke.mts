// Живой смоук OpenCode BYOK. Запуск:
//   OPENCODE_SMOKE_KEY=<ключ> npx tsx --env-file=.env scripts/opencode-smoke.mts
//
// Бьёт в НАСТОЯЩИЙ собранный сервер (buildApp) и в настоящий провайдер —
// смысл смоука в том, чтобы поймать то, что зелёные тесты не ловят.
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createOpenCodeModel } from "../src/ai/opencode.js";
import { streamText } from "ai";

const KEY = process.env.OPENCODE_SMOKE_KEY;
if (!KEY) throw new Error("нет OPENCODE_SMOKE_KEY");

const say = (s: string) => console.log(s);
const ok = (b: boolean) => (b ? "ДА" : "НЕТ");

const config = loadConfig(process.env);
const app = await buildApp(config);
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

// ── 1. Проверка ключа по обеим базам ───────────────────────────────────────
say("\n=== 1. Проверка ключа ===");
for (const provider of ["opencode-go", "opencode"] as const) {
  const r = await fetch(`${base}/api/opencode/validate`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-OpenCode-Key": KEY },
    body: JSON.stringify({ provider }),
  });
  const j = (await r.json()) as { ok: boolean; reason?: string; models?: string[] };
  say(`${provider.padEnd(12)} → ok=${ok(j.ok)}${j.reason ? ` (${j.reason})` : ""} моделей: ${j.models?.length ?? 0}`);
}

// ── 2. Настоящий ход через провайдер: отвечает ли, и приходит ли usage ──────
say("\n=== 2. Ход через провайдер (usage) ===");
for (const modelId of ["deepseek-v4.1-flash", "glm-5.3-flash"]) {
  try {
    const model = createOpenCodeModel({
      provider: "opencode-go",
      modelId,
      apiKey: KEY,
      sessionId: `smoke-${Date.now()}`,
    });
    const res = streamText({ model, prompt: "Reply with exactly: PONG" });
    let text = "";
    for await (const d of res.textStream) text += d;
    const usage = await res.usage;
    say(
      `${modelId.padEnd(22)} → ответ=${JSON.stringify(text.trim().slice(0, 40))} ` +
        `вход=${usage.inputTokens ?? 0} выход=${usage.outputTokens ?? 0} ` +
        `usage_живой=${ok(Boolean(usage.inputTokens))}`,
    );
  } catch (e) {
    say(`${modelId.padEnd(22)} → УПАЛ: ${(e as Error).message.slice(0, 160)}`);
  }
}

// ── 3. Принимает ли эндпоинт картинку (решает supportsVision) ──────────────
say("\n=== 3. Картинка в сообщении ===");
// 1x1 красный PNG
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
for (const modelId of ["deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash"]) {
  try {
    const model = createOpenCodeModel({
      provider: "opencode-go",
      modelId,
      apiKey: KEY,
      sessionId: `smoke-img-${Date.now()}`,
    });
    const res = streamText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this image? One word." },
            { type: "image", image: `data:image/png;base64,${PNG}` },
          ],
        },
      ],
    });
    let text = "";
    for await (const d of res.textStream) text += d;
    say(`${modelId.padEnd(30)} → ${JSON.stringify(text.trim().slice(0, 60))}`);
  } catch (e) {
    say(`${modelId.padEnd(30)} → ОТКАЗ: ${(e as Error).message.slice(0, 160)}`);
  }
}

// ── 4. Настоящий ход агента через /api/chat, до вызова тула ────────────────
say("\n=== 4. /api/chat, дизайн-агент ===");
const chatRes = await fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json", "X-OpenCode-Key": KEY },
  body: JSON.stringify({
    id: `smoke-chat-${Date.now()}`,
    model: "opencode-go/deepseek-v4.1-flash",
    messages: [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "/prototype a tiny mobile login screen, one screen only" }],
      },
    ],
    canvasContext: { roots: [], selection: [], variables: [] },
  }),
});
say(`HTTP ${chatRes.status}`);
const toolNames = new Set<string>();
let chars = 0;
let errorLine = "";
if (chatRes.body) {
  const reader = chatRes.body.getReader();
  const dec = new TextDecoder();
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    chars += chunk.length;
    for (const m of chunk.matchAll(/"toolName":"([^"]+)"/g)) toolNames.add(m[1]);
    if (chunk.includes('"type":"error"') && !errorLine) errorLine = chunk.slice(0, 300);
    if (toolNames.size > 0 && chars > 2000) break;
  }
  await reader.cancel().catch(() => {});
}
say(`получено байт потока: ${chars}`);
say(`вызванные тулы: ${[...toolNames].join(", ") || "(ни одного)"}`);
if (errorLine) say(`ОШИБКА В ПОТОКЕ: ${errorLine}`);

// ── Итог ───────────────────────────────────────────────────────────────────
say("\n=== ИТОГ ===");
say(`ход агента дошёл до вызова тула: ${ok(toolNames.size > 0)}`);
await app.close();
process.exit(0);
