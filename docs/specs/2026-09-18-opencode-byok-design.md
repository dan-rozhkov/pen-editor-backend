# OpenCode Zen/Go как провайдер чат-агента, с ключом пользователя

Дата: 2026-09-18.

## Задача

Дать возможность гонять дизайн-агента через подписку OpenCode — **Go**
($10/мес, база `https://opencode.ai/zen/go/v1`) и **Zen** (pay-as-you-go,
база `https://opencode.ai/zen/v1`). Ключ **не хранится на сервере**: каждый
пользователь вводит свой в браузере и платит за себя.

Девять из десяти моделей текущего списка (`DEFAULT_MODELS`) есть на Go,
включая дефолтный `deepseek-v4.1-flash`, — то есть речь не о новых
возможностях, а о смене кошелька и маршрута.

## Что в OpenCode устроено не так, как у OpenRouter

Проверено по докам `opencode.ai/docs/go/` (2026-09-18), не по памяти:

1. **Три несовместимых эндпоинта.** `/responses` (`@ai-sdk/openai`),
   `/chat/completions` (`@ai-sdk/openai-compatible`), `/messages`
   (`@ai-sdk/anthropic`) — привязка жёсткая, у каждой модели своя. Одним
   клиентом список не покрыть.
2. **Требования к клиенту.** Go просит собственный `User-Agent` (не
   generic-имя SDK) и стабильный `x-opencode-session` на разговор — на нём
   строится роутинг и prompt-кэш на их стороне.
3. **Go «designed for OpenCode and other coding agents»**, трафик мониторится
   на злоупотребления. Формально дизайн-агент — не coding agent; по форме
   запросов (длинные тул-петли, большой кэшируемый префикс) близок. Риск
   принят осознанно.

## Объём

**Включено:** только семейство `/chat/completions` — одна новая зависимость
(`@ai-sdk/openai-compatible`), покрывает `deepseek-v4.1-flash`,
`deepseek-v4-flash-vision-exp`, `glm-5.3-flash`, `glm-5.3`, `glm-5.2` (а
также kimi/mimo/longcat/hy, если позже захочется расширить таблицу).

**Не включено:** `/responses` и `/messages` семейства; `ANALYSIS_MODEL`,
`VISION_MODEL`, `STRUCTURED_MODEL`, генерация картинок и витрина — остаются
на OpenRouter. У `openai-compatible` нет structured outputs; это ловушка №3
из откаченной двухпровайдерности (см. `deepseek-direct-provider-shipped`), и
наступать на неё второй раз незачем. `OPENROUTER_API_KEY` остаётся
обязательным.

**Zen** подключается как маршрут (вторая база + префикс `opencode/`), но
записей Zen в `DEFAULT_MODELS` на старте нет: у большинства его моделей
эндпоинт `/responses` или `/messages`. Конкретные `/chat/completions`-id
для Zen заполняются из живого `GET https://opencode.ai/zen/v1/models` на
этапе реализации. Ключ из консоли Zen один на оба маршрута — это
подтверждает живой смоук; если окажется, что нет, добавится второе поле в
диалоге ввода.

**Серверного `OPENCODE_API_KEY` не существует.** Ни фолбэка для чата, ни
ключа для CLI: иначе любой гость витрины молча выжигал бы чужой месячный
лимит.

## Идентификатор модели: префикс через слэш

`opencode-go/glm-5.3-flash`, `opencode/<id>` — ровно так их именует конфиг
самого OpenCode.

Причина не косметическая. Id обязан пройти круг: `GET /api/models` → пик
юзера в композере → тело `/api/chat` → `createModel`, и осесть в
`raw_traces.model`. Сегодняшний `bareModelId` срезает префикс — с двоеточной
формой (`opencode-go:glm-5.3-flash`) провайдер терялся бы на обратном пути и
запрос молча уехал бы в OpenRouter с несуществующим именем модели.

Поэтому:

- `parseModelRef` распознаёт **слэш**-префиксы `opencode-go/` и `opencode/`
  (плюс легаси-двоеточие `openrouter:`, как сейчас);
- `bareModelId` срезает **только** двоеточие `openrouter:` — слэш-форма
  уезжает наружу целиком и возвращается целой;
- двоеточная форма `opencode-go:` / `opencode:` валится на старте **громко**
  (как сейчас валится `deepseek:`), а не трактуется как bare-OpenRouter-id.

Инвариант «наружу едет то, что вернётся обратно» при этом усиливается:
раньше «голый id» и «id для провайдера» совпадали, теперь для opencode это
разные строки. `parseModelRef(...).modelId` — то, что уходит на провод
провайдеру; `bareModelId(...)` — то, что видит клиент и БД.

## Поток ключа

```
браузер (localStorage)
  └─ заголовок X-OpenCode-Key ─→ POST /api/chat
                                   └─ createModel(...{opencodeApiKey})
                                        └─ Authorization: Bearer ─→ opencode.ai
```

- **Заголовок, а не тело.** Тело `/api/chat` уходит в `raw_traces` в
  Postgres — ключ в нём осел бы навсегда.
- **Нигде не сохраняется:** ни в `raw_traces`, ни в логах Fastify, ни в
  свойствах событий PostHog. На это есть отдельный тест.
- **Уходит только на `opencode.ai`.** Базовые URL захардкожены; клиент не
  может указать хост.
- **`X-OpenCode-Key` добавляется в `allowedHeaders`** в
  `src/plugins/cors.ts`. Это явный allowlist — без правки каждый браузерный
  запрос умрёт на preflight, ещё до хендлера.
- Заголовок шлётся **только когда выбранная модель — opencode**; на
  OpenRouter-ходах ключ не покидает браузер.

### Слом действующего правила роута

Сейчас незнакомый `model` роут **игнорирует** и крутит дефолт. Для opencode
без ключа это неприемлемо — юзер выбрал бы Go и незаметно потратил наш
OpenRouter. Новое правило: модель с провайдером `opencode*` **без**
заголовка → **400**, `error_kind: "opencode_key_required"`. Незнакомый id
по-прежнему молча уезжает на дефолт: это протухший список у клиента, а не
ошибка пользователя.

## Изменения по файлам

### pen-editor-backend

- **`src/ai/modelRef.ts`** (остаётся import-free — его грузит фронтовый
  контракт-тест): union → `openrouter | opencode | opencode-go`; слэш-
  префиксы; `bareModelId` срезает только двоеточие;
  `providerHandlesToolResultImages` → **false** для opencode. Это не
  костыль, а вторая ось, под которую `applyVisionPreprocessing` уже написан:
  результат `get_screenshot` уедет текстовым описанием от `VISION_MODEL`.
  Перед мёржем — проверка по `node_modules/@ai-sdk/openai-compatible/dist`,
  чтением исходника, а не доков.
- **`src/ai/opencode.ts`** (новый): две базы; таблица «модель → эндпоинт»
  только с `/chat/completions`-семейством; `createOpenAICompatible` с
  `Authorization`, `User-Agent: pen-editor-design-agent/<ver>` и
  `x-opencode-session`. Модель вне таблицы — громкая ошибка, а не POST в
  неверный эндпоинт (он вернёт мусор или 404 без внятного текста).
- **`src/ai/provider.ts`**: `createModel` ветвится по провайдеру. Опции
  растут на `sessionId` и `opencodeApiKey`. `CHAT_REASONING_EFFORT` шлётся
  **только** в OpenRouter — `{reasoning:{effort}}` это его форма; гейт
  покрытия reasoning в тестах сужается до openrouter-id.
- **`src/ai/chatTurn.ts`**: прокидывает `sessionId` и `opencodeApiKey` в
  `createModel`.
- **`src/routes/chat.ts`**: читает заголовок; 400 при opencode-модели без
  ключа; передаёт `traceSessionId` (уже стабилен на разговор) как
  `x-opencode-session`. Без id заголовок не опускаем, а генерируем — Go
  строит на нём кэш.
- **`src/config.ts`**: opencode-записи в `DEFAULT_MODELS` с новым полем
  `requiresUserKey: true`; `CHAT_MODEL` с opencode-провайдером отвергается
  на старте (серверного ключа нет — такой дефолт не сработал бы ни для
  кого).
- **`src/routes/models.ts`**: отдаёт `requiresUserKey` в каждой записи.
- **`src/routes/opencode.ts`** (новый): `POST /api/opencode/validate` —
  читает тот же заголовок, дёргает `GET <base>/models` апстрима, отвечает
  `{ok, plan, models}` либо `{ok:false, reason}`. Нужен потому, что браузер
  не может постучаться в `opencode.ai` напрямую (CORS), а проверять
  вставленный ключ надо. Под общий rate-limit.
- **`src/plugins/cors.ts`**: `X-OpenCode-Key` в `allowedHeaders`.

### pen-editor

- **`src/lib/opencodeKey.ts`** (новый): единственная точка чтения/записи/
  очистки; `localStorage["pen.opencode.key.v1"]`, всё в try/catch (приватный
  режим бросает). Урок `shareCanvas`: учётные данные чистятся через **одну**
  точку, иначе однажды забудешь ветку.
- **`src/hooks/useDesignChat.ts`**: в `prepareSendMessagesRequest`
  возвращать `headers` с ключом, когда модель тела — opencode. Эта функция
  вычисляется на каждую отправку, включая автопродолжения тул-петли, — то
  есть ключ не «запекается» в транспорт при монтировании и подхватывается
  сразу после ввода.
- **`src/lib/chatModels.ts`**: `requiresUserKey` в `ChatModelOption` и в
  `FALLBACK_MODELS`; новые записи зеркалят бэкенд.
- **`src/hooks/useModelOptions.ts`** + пикер: запись с `requiresUserKey` и
  без сохранённого ключа рисуется с замком, неактивна и ведёт к вводу.
- **`src/components/chat/OpenCodeKeyDialog.tsx`** (новый): ввод, «Проверить»
  (через `/api/opencode/validate`), «Удалить ключ». Плюс команда в палитре.

### Метаданные моделей

Пять записей, метка «· Go». `supportsVision` = **false** всем, кроме
`deepseek-v4-flash-vision-exp` (в доках Go прямо описан приём картинок с
тарификацией по размеру). Твины на OpenRouter зрячие, но зрячесть здесь —
свойство эндпоинта, а не модели; непроверенный `true` означает, что
картинка уходит в пустоту и модель уверенно фантазирует. Флаги поднимаем
после живого смоука, не раньше. Пользователь при этом всё равно может
приложить картинку: `visionFallback` опишет её текстом.

## Безопасность

- **Плагины ключ не достанут**: `sandbox="allow-scripts"` без
  `allow-same-origin` (`src/lib/plugins/pluginHost.ts:89`) — opaque origin,
  своё хранилище.
- **Embed-HTML — тот же origin.** `innerHTML` не исполняет `<script>`, но
  `<img onerror>` исполняет, а содержимое embed'ов пишет LLM или приносит
  вставка из Figma. Отдельного барьера от same-origin у нас нет: ключ
  защищён ровно настолько, насколько мы доверяем содержимому холста. Это
  принято сознательно; «Удалить ключ» — единственная имеющаяся страховка.
- `sessionStorage` тут ничего не меняет (тот же origin), поэтому выбран
  `localStorage` — переживает перезагрузку, вводится один раз.

## Проверка

Юнит (бэкенд): парсинг слэш-формы; круг id без потери префикса; громкое
падение на двоеточной форме; заголовки (`Authorization`, `User-Agent`,
`x-opencode-session`) долетают до fetch; reasoning **не** уходит в opencode;
opencode-модель без заголовка → 400; ключ отсутствует в строке `raw_traces`
и в свойствах PostHog; `requiresUserKey` в `/api/models`; validate ok/invalid.

Юнит (фронт): хранилище (включая бросающий `localStorage`); заголовок
уходит только для opencode-модели; замок в пикере; обновлённый
`modelContract.test.ts`.

**Живой смоук — обязателен, с настоящим ключом.** Один ход `/api/chat` до
вызова `batch_design` плюс попытка с приложенной картинкой. Ровно так прямой
DeepSeek прошёл всё CI и не ответил в проде ни разу
(`deepseek-flash-direct-never-responds`): второй провайдер зелёный в тестах
ничего не доказывает.

## Порядок мёржа

Бэкенд на `main` первым, фронт следом — `modelContract.test.ts` читает
соседний чекаут, и обратный порядок красит собственный пуш
(`tool-contract-merge-order`).
