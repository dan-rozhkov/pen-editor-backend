# Зрение агента через auxiliary vision-модель

Дата: 2026-08-14. Прообраз: `NousResearch/hermes-agent` (`auxiliary.vision`).

## Проблема

Дефолтная модель (`OPENROUTER_MODEL=deepseek/deepseek-v4-pro`) не умеет vision.
Сегодня это лечится вычёркиванием: фронт молча выбрасывает приложенные
пользователем картинки (`stripImageParts`), а `get_screenshot` вообще
закомментирован в `penTools` — агент не может ни посмотреть на референс, ни
проверить, что нарисовал.

## Как это решено в Hermes

Отдельная **auxiliary vision-модель**: картинка уходит вторым, независимым
completion-вызовом в зрячую модель, а её текстовое описание вставляется в
контекст основной (слепой) модели. Существенные детали их реализации:

- конфиг-блок `auxiliary.vision` (provider/model/base_url/api_key/timeout);
- решение «нативно или текстом» принимается по **статическим метаданным**
  модели (`decide_image_input_mode`), а не рантайм-пробой;
- описание возвращается **как обычный tool-result / текстовая часть**, не
  правкой system-prompt;
- **кэш по картинке**, нормализация (SVG/BMP→PNG, ресайз под лимит), щедрый
  таймаут;
- два промпта: общий «опиши всё» и «опиши всё, затем ответь на вопрос».

Известные их грабли, которых мы избегаем by design: если aux-модель не
настроена, Hermes местами всё равно шлёт `image_url` в текстовую модель и
получает провайдерскую ошибку (#58581), а `provider: auto` умеет
разрезолвиться в «никуда» (#50426). У нас недоступность зрения — это всегда
текстовая заглушка, никогда не картинка в слепую модель.

## Решение

### 1. `src/services/vision.ts` — auxiliary vision-сервис

```ts
export function isVisionConfigured(config: Config): boolean;
export function describeImage(params: {
  image: string;            // http(s):// или data: URL
  question?: string;
  config: Config;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; text: string }>;
export function __resetVisionCache(): void;   // тест-хук
```

- модель: `createModel(config, config.VISION_MODEL)`, вызов `generateText`
  с user-сообщением из text-части и image-части;
- промпты (порт Hermes, заточенный под дизайн-агента):
  - без вопроса — «Describe everything visible in this image in thorough
    detail. Include any text, layout structure, colors, typography, spacing,
    imagery, UI controls and any other notable visual information.»
  - с вопросом — «Fully describe and explain everything about this image,
    then answer the following question:\n\n{question}»
- `maxOutputTokens: VISION_MAX_TOKENS`, таймаут `VISION_TIMEOUT_MS`;
- **кэш**: `Map` на 64 записи, ключ `sha256(image + "\0" + question)`,
  FIFO-вытеснение. Он не столько про деньги, сколько про корректность —
  описание одной и той же картинки обязано быть байт-идентичным между
  ходами, иначе на каждом ходу инвалидируется prompt-кэш провайдера;
- guard по размеру: `data:` больше 6 МБ не отправляется;
- **никогда не бросает наружу**: любая ошибка → `{ ok: false, text }` с
  человекочитаемой причиной.

### 2. `src/ai/vision-messages.ts` — единый проход по сообщениям

Наш аналог `decide_image_input_mode`. Вызывается в `prepareChatTurn` до
передачи сообщений в `streamText`.

```ts
export function modelSupportsVision(config: Config, modelId: string): boolean;
export function applyVisionPreprocessing(
  messages: ModelMessage[],
  opts: { config: Config; modelId: string },
): Promise<ModelMessage[]>;
```

- модель зрячая → сообщения возвращаются **без изменений** (нативный путь);
- модель слепая → каждая картинка заменяется текстом:
  - image-часть пользовательского сообщения → `[Image: visual description]\n<текст>`;
  - tool-result `get_screenshot` с `imageData` → текстовое описание снимка;
  - ошибка описания / зрение не настроено → `[Image attached but could not be
    analyzed: <причина>]`. Картинка в слепую модель не уходит ни при каких
    условиях.

Один проход покрывает оба источника картинок — и вложение пользователя, и
скриншот холста.

**Бюджет на ход.** Роут ограничивает картинки *на сообщение*
(`MAX_IMAGE_PARTS = 4`), но проход идёт по всей истории — без своего лимита
длинная переписка (или собранный руками запрос с такой историей) даёт по
vision-вызову на каждую когда-либо приложенную картинку, все разом. Поэтому
описываются только `MAX_DESCRIBED_IMAGES_PER_TURN = 8` самых свежих
картинок, остальные заменяются на явную заглушку «earlier image omitted», а
параллелизм ограничен 4 (у Hermes это `auxiliary.vision.max_concurrency`).
Инвариант «ни одной image-части слепой модели» держится и здесь: превышение
бюджета — тоже текст, а не оставленная картинка.

### 3. `analyze_image` — backend-executed тул

`analyze_image({ imageUrl, question? })` → текст описания. Даёт агенту
посмотреть на то, что он сам сгенерировал (`generate_image`), на
refero-скрин или на картинку из документа. Исполняется на бэкенде, так что
работает независимо от того, зрячая основная модель или нет. Без
`VISION_MODEL` тул из набора удаляется: звать ему нечего, а фантомный тул
сжигает шаг на «vision не настроен».

### 4. `get_screenshot` возвращается

`plans/002` (Branch B, «оставить выключенным») отменяется: причина запрета
была ровно в том, что модель не могла посмотреть на снимок.

- схема раскомментируется в `penTools`, тул остаётся client-executed;
- **`toModelOutput` обязателен.** Хэндлер возвращает
  `JSON.stringify({ imageData })`, и без промоушена это дошло бы до модели
  несколькими сотнями килобайт base64-*текста* — нечитаемого и дорогого,
  причём пересылаемого на каждом следующем шаге хода. Тул промотирует
  payload в настоящую image-часть (`type:"content"` + `image-data`), а
  `applyVisionPreprocessing` уже её меняет на описание, если модель слепая.
  Разбор payload'а живёт в `src/ai/screenshotOutput.ts` — один источник
  правды для обеих сторон;
- **структурный гейт**: схема попадает в per-request набор тулов, только
  если основная модель зрячая **или** настроен `VISION_MODEL` (прецедент —
  FIR-45 embed-only guard). Фантомного тула, который некому исполнить, не
  появляется;
- фронт-хэндлер даунскейлит снимок до 1400 px по большей стороне;
- в system-prompt две живые строки «ты не видишь холст» заменяются на
  описание визуальной верификации: когда снимать и что снимок стоит денег.

### 5. Фронтенд

- `stripImageParts` убирается: картинки всегда уходят на бэкенд, решение о
  нативном/текстовом пути принимает он;
- хэндлер `analyze_image` по образцу `get_guidelines` (backend-executed,
  фронтовый хэндлер существует ради контракта);
- списки в контракт-тестах обоих репо обновляются.

## Конфиг

| Переменная | Дефолт | Смысл |
|---|---|---|
| `VISION_MODEL` | `google/gemini-2.5-flash` | aux vision-модель; пусто ⇒ зрение выключено |
| `VISION_MAX_TOKENS` | `1200` | потолок описания |
| `VISION_TIMEOUT_MS` | `120000` | таймаут vision-вызова |

## Тесты

- `test/vision.test.ts` — промпты, кэш (второй вызов не ходит в модель),
  guard по размеру, ошибка → `ok:false`, выключённое зрение;
- `test/vision-messages.test.ts` — зрячая модель не трогается; слепая
  получает текст вместо картинки и вместо `get_screenshot`-снимка;
- контракт-тесты обоих репо + фронтовый тест даунскейла.

## Порядок мержа

Бэкенд (`analyze_image` + `get_screenshot` в `penTools`) — первым, фронт —
следом, по правилу «Tool-contract merge order» из корневого CLAUDE.md.
