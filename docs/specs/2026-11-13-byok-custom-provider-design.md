# BYOK: свой OpenAI-совместимый провайдер для чат-агента

Дата: 2026-11-13. Продолжает `2026-09-18-opencode-byok-design.md`: тот же
поток ключа (браузер → заголовок → `createModel`), но провайдер и модель
задаёт пользователь, а не наш список.

## Что получает пользователь

Настройки → AI agent → группа **Custom provider**:

1. Пресет: OpenAI, OpenRouter, Groq, DeepSeek, Together, Mistral или «Custom».
   Пресет только заполняет Base URL.
2. Base URL (`https://…/v1`) и API key.
3. Кнопка **Load models**: бэкенд зовёт `GET <base>/models` с ключом
   пользователя и отдаёт список. Пользователь добавляет нужные модели.
4. Поле **Model ID** + Add: модель вручную, если у провайдера нет `/models`
   или нужной модели в нём нет.
5. Добавленные модели появляются в пикере чата и в «Default model» с
   подписью `· Own key`.

Один провайдер на браузер. Несколько провайдеров — не в этой задаче.

## Идентификатор модели

`byok/<modelId>` — слэш-префикс, как у `opencode-go/`. `parseModelRef`
отдаёт `{provider: "byok", modelId}`, `bareModelId` префикс не срезает: id
обязан вернуться с клиента целым.

`byok/` id **не** проходят через allowlist `DEFAULT_MODELS` — список моделей
у каждого пользователя свой.

## Поток ключа

```
браузер (localStorage pen.byok.v1: {baseUrl, apiKey, models[]})
  └─ X-BYOK-Base-URL + X-BYOK-Key ─→ POST /api/chat, POST /api/byok/models
                                       └─ createModel(...{byok}) ─→ <baseUrl>
```

- Заголовки, а не тело: тело `/api/chat` пишется в `raw_traces`.
- Заголовки уходят только на ходах с `byok/`-моделью.
- `byok/`-модель без любого из двух заголовков → 400 `byok_key_required`.
  Тихого отката на OpenRouter нет: это тратило бы наши деньги на чужой выбор.
- Ключ и base URL не пишутся в трейсы, логи и PostHog.

## SSRF

Base URL задаёт клиент, а запрос делает наш сервер. Защита в два слоя
(`src/ai/byokNetwork.ts`):

1. `parseByokBaseUrl` — синхронно: только `https:`, без `user:pass@`, без
   литерального приватного/loopback/link-local IP, без `localhost`,
   `*.local`, `*.internal`. Ошибка → 400 `byok_base_url_invalid`.
2. `byokFetch` — `fetch` из `undici` с `Agent`, у которого `connect.lookup`
   отбрасывает приватные адреса **после** DNS. Это закрывает DNS-rebinding:
   проверяется тот адрес, к которому реально идёт соединение.

`BYOK_ALLOW_PRIVATE_NETWORK=true` выключает оба слоя (локальный Ollama /
LM Studio при `npm run dev`). По умолчанию `false`.

## Модель

`createOpenAICompatible({name: "byok", baseURL, apiKey, fetch: byokFetch})`,
`/chat/completions`. Reasoning не шлём: форма у провайдеров разная.

- `providerHandlesToolResultImages` → `false` (openai-compatible
  stringify-ит картинку из tool-result).
- `modelSupportsVision` → `false` для `byok/`: мы не знаем модель. Картинки
  описывает `VISION_MODEL`, если он настроен.
- Вспомогательные роли (`VISION_MODEL`, `STRUCTURED_MODEL`, анализ, память)
  остаются на OpenRouter сервера.

## `POST /api/byok/models`

Заголовки как у чата. Ответ: `{ok: true, models: [{id, contextWindow?}]}`
или `{ok: false, reason}`, где `reason` ∈ `invalid_key` | `no_model_list` |
`upstream_error`. Невалидный base URL → 400 `byok_base_url_invalid`.
`contextWindow` берётся из `context_length` (форма OpenRouter), если есть.
Rate limit 10/мин/IP, как у `/api/opencode/validate`.
