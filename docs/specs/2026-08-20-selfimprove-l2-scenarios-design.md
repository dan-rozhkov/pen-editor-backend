# L2 Scenario: слой повторяемости для петли самообучения

**Дата:** 2026-08-20
**Статус:** design
**Затрагивает:** `pen-editor-backend` (`src/analysis/*`, `src/ai/selfimprove/*`, `src/tracing/traceStore.ts`, миграции)
**Продолжает:** `docs/superpowers/plans/2026-08-11-selfimprove-phase1-memory.md`, `…-phase2-skills.md`, `…-phase3-curator.md`

## Проблема

У нас два независимых конвейера, которые смотрят на одни и те же сессии и не
разговаривают друг с другом.

**Онлайн-петля** (`src/ai/selfimprove/review.ts`, `maybeRunReview`) видит ровно
**одну** сессию — `modelMessages` текущего HTTP-запроса плюс `assistantText`.
Запускается по счётчикам: `MEMORY_REVIEW_INTERVAL = 4` пользовательских хода,
`SKILL_REVIEW_INTERVAL = 15` шагов с тул-коллами
(`src/config.ts:13,23`). Дальше модель должна сама решить, есть ли здесь
что-то, достойное записи в `agent_memory` / `agent_skills`.

**Офлайн-конвейер Clio** (`src/analysis/run.ts`) видит **много** сессий:
`raw_traces` → `assembleSession` → `summarizeWithPiiGuard` → эмбеддинги →
`clusterSummaries` → `extractInsights` → markdown-репорт → задачи в Linear.
Его выход адресован человеку. Агенту в контекст не попадает ничего.

Отсюда главный дефект петли: **решение «это устойчивый паттерн или разовая
случайность» принимается по одному разговору.** Промпт ревью (справедливо)
требует сохранять только устойчивое — и модель (справедливо) почти всегда
отказывается. Аудит это подтверждает: за всё время жизни петли в
`agent_selfimprove_audit` осело около четырёх записей, остальные прогоны —
`nothing-saved`.

В терминах пирамиды памяти у нас есть:

| Слой | Что есть сегодня |
|---|---|
| L0 Conversation | `raw_traces` (TTL 14 дней) |
| L1 Atom | `session_insights` — corrections / errors / memory_requests / agent_claims |
| L2 Scenario | **отсутствует** |
| L3 Persona | `agent_memory` (`memory` + `user`), `agent_skills` |

L3 пишется напрямую из L0 одного разговора, минуя агрегацию. Ровно тот
сигнал, который делает запись оправданной — «это повторилось у этого
пользователя в третий раз» — сейчас не вычисляется нигде.

> Замечание про повод. Разбор `TencentDB-Agent-Memory` показал ровно эту
> дырку: их выигрыш даёт не хранилище и не векторный recall, а промежуточный
> слой Scenario между сырыми трейсами и персоной. Интегрировать их сервисы мы
> не будем (несовместимо с `prepareChatTurn`, prompt-кэшем и
> vision-preprocessing), а недостающий слой строим у себя на том, что уже
> лежит в Postgres.

## Решение

Ввести таблицу `agent_scenarios` — материализованный слой L2 — и два её
потребителя:

1. **Триггер и доказательство для ревью.** Сценарий, подтверждённый ≥ 3
   сессиями, делает ревью `due` (третий источник due-ности наряду с двумя
   счётчиками) и **передаётся в ревью текстом** как готовое свидетельство:
   «вот что повторилось N раз, вот сессии». Модель больше не угадывает
   устойчивость по одному разговору.
2. **Drill-down в обе стороны.** У сценария есть ссылки вниз (`session_ids` →
   `session_insights` → `raw_traces`) и вверх (`distilled_into` → имя скилла
   или запись памяти). Любую автономную запись агента можно проследить до
   доказательств, и наоборот.

Наполняется сценарий **офлайн**, тем же прогоном `src/analysis/run.ts`,
который уже строит саммари и инсайты. В горячем пути `/api/chat` не
появляется ни одного нового LLM-вызова.

```text
raw_traces ──► session_summaries ──► session_insights ──► agent_scenarios ──► review ──► agent_memory
   L0               (L1 сессии)            L1 атомы              L2            (петля)     agent_skills (L3)
    ▲                                          ▲                  │                              │
    └──────────────── session_ids ─────────────┴──────────────────┘        distilled_into ───────┘
```

## Развилка №1: сценарии персональные или глобальные

Факт, определяющий всё остальное: **`raw_traces` не хранит `user_id`** —
только `session_id` (`src/analysis/migrations/001_init.sql:3`), хотя
`userId` в чат-роуте есть и валидируется (`src/routes/chat.ts:205`). При
этом `agent_memory` персональна, а `agent_skills` — глобальна
(`011_agent_skills.sql`).

| Вариант | Плюсы | Минусы | Вердикт |
|---|---|---|---|
| **A.** Сценарии только глобальные | Ноль изменений в трейсинге; работает сегодня | Кормит только `agent_skills`; персональная память — половина ценности петли — не улучшается вообще | отклонён |
| **B.** Добавить `user_id` в `raw_traces` и `session_summaries`, сценарии со `scope in ('user','global')` | Кормит оба хранилища; глобальные сценарии остаются доступны для сессий без `userId` | Миграция + прокидывание поля; персональный след в трейсах | **выбран** |
| C. Отдельный конвейер L2 поверх `agent_selfimprove_audit` | Уже персонален | В аудите нет содержимого разговора — только факт записи. Строить сценарии не из чего | отклонён |

По B: `userId` — анонимный id из `localStorage pen.userId`, не e-mail и не
логин; новых персональных данных не появляется, добавляется только связка
«эти сессии — одного и того же анонимного клиента». Ограничители уже стоят:
`TRACE_RAW_TTL_DAYS = 14` режет L0, `scrubPii`/`scrubInsights` — L1.
Колонка nullable: сессии без валидного `userId` дают `scope = 'global'`.

## Развилка №2: чем считать повторяемость

| Вариант | Вердикт |
|---|---|
| Детерминированный ключ (tool + категория ошибки) | Ловит только `errors`; correction «ты опять начал с вопросов вместо черновика» не сводится к ключу — отклонён |
| Ещё один LLM-каскад со своими саммари | Дублирует `summarize.ts`/`cluster.ts`, второй источник дрейфа — отклонён |
| **Один `generateObject`-проход по атомам L1 + дедуп по эмбеддингу заголовка** | **выбран** |

Группируем **не сессии, а атомы**: элементы `corrections`, `errors`,
`memory_requests` из `session_insights` за окно (по умолчанию 30 дней), с
их `session_id`. Одна сессия может дать два сценария, и наоборот — поэтому
`clusterSummaries` (он группирует сессии целиком) переиспользовать нельзя,
но форма прохода копируется с него один в один: `generateObject`, zod-схема,
системный промпт с правилом «actionable, а не тематический».

Дедуп с уже существующими строками — по эмбеддингу `title` из уже
подключённого `createEmbedder` (`src/analysis/embeddings.ts`, 768 измерений).
Вектор хранится **как `jsonb`-массив чисел, а не как `vector(768)`**: PGlite,
на котором гоняются SQL-тесты, не умеет `CREATE EXTENSION vector` (поэтому
`test/pgliteShowcaseHelpers.ts` пропускает `001`/`002`), строк здесь десятки, а
косинус в JS — чистая функция, которую можно проверить юнит-тестом. Косинусное
расстояние < 0.15 к существующей строке того же `scope`/`user_id` → это тот же
сценарий: `confirmations += число новых
сессий`, `session_ids` объединяются, `last_seen_at = now()`. Иначе — insert.

**Инвариант:** `confirmations` считает **различные `session_id`**, а не
атомы. Три жалобы в одной сессии — это одно подтверждение, иначе один
раздражённый разговор мгновенно даст «устойчивый паттерн».

## Контракт: таблица

`src/analysis/migrations/014_agent_scenarios.sql`

```sql
CREATE TABLE IF NOT EXISTS agent_scenarios (
  id             BIGSERIAL PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('user','global')),
  user_id        TEXT,                       -- NOT NULL ровно когда scope='user'
  kind           TEXT NOT NULL CHECK (kind IN ('correction','error','preference','workflow')),
  title          TEXT NOT NULL,              -- одна строка: что повторяется
  recipe         TEXT NOT NULL,              -- 2-4 строки: что делать иначе
  confirmations  INTEGER NOT NULL DEFAULT 1, -- число РАЗЛИЧНЫХ сессий
  session_ids    TEXT[] NOT NULL,
  embedding      JSONB,                      -- number[]; НЕ pgvector, см. ниже
  state          TEXT NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','offered','distilled','rejected')),
  offer_count    INTEGER NOT NULL DEFAULT 0,
  distilled_into JSONB,                      -- {kind:'skill',name} | {kind:'memory',target}
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  offered_at     TIMESTAMPTZ,
  CONSTRAINT agent_scenarios_user_scope
    CHECK ((scope = 'user') = (user_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS agent_scenarios_due_idx
  ON agent_scenarios (scope, user_id, state, confirmations DESC);
```

`src/analysis/migrations/013_trace_user_id.sql` добавляет
`raw_traces.user_id TEXT` и `session_summaries.user_id TEXT` (обе nullable,
существующие строки остаются `NULL` и попадают в `scope='global'`).

### Машина состояний

```text
open ──(предложен ревью)──► offered ──(ревью что-то записал)──► distilled
                               │
                               └──(два предложения подряд без записи)──► rejected
```

**Инвариант против зацикливания:** `offered` без результата не возвращается в
`open` бесконечно. `offer_count` растёт на каждое предложение; на втором
безрезультатном — `rejected`, и сценарий больше никогда не предлагается.
Без этого каждое ревью до конца времён получало бы один и тот же
проигнорированный сценарий.

**Порог due:** `confirmations >= SCENARIO_CONFIRM_THRESHOLD` (config,
дефолт 3) и `state = 'open'`.

## Контракт: как сценарий попадает в ревью

Жёсткое ограничение проекта: `input.system` в `maybeRunReview`
переиспользуется **верватим**, чтобы не сбить префиксный кэш провайдера.
Значит сценарии **нельзя** класть в системный промпт.

Кладём их в *пользовательское* сообщение ревью — ровно тем маршрутом,
которым туда уже кладётся свежий снапшот памяти
(`review.ts`: `reviewPrompt = ${reviewPromptBase}\n\nCurrent memory contents…`).
Маршрут уже проверен в бою, новых рисков для кэша нет.

```text
<reviewPromptBase>

Recurring patterns observed across this user's past sessions (evidence, not
guesses — each was seen in N separate sessions):

[S-124 · correction · seen in 4 sessions]
Пользователь просит сразу черновик, а агент начинает с уточняющих вопросов.
→ …recipe…

Current memory contents (do not add anything already listed here …)
```

**Максимум два сценария за прогон.** Это не про токены, а про атрибуцию: см.
ниже.

### Атрибуция результата

Ревью не сообщает, какой именно сценарий он дистиллировал. Варианты:

| Вариант | Вердикт |
|---|---|
| Добавить `scenario_id` в аргументы `memory` / `skill_manage` | Меняет контракт инструментов, продублированный в промптах и тестах обеих фаз — отклонён |
| **Считать по факту записи в прогоне** (`REVIEW_WRITE_TOOLS` уже детектится в `review.ts`) | **выбран** |

Если прогон, которому были предложены сценарии, завершился `saved` — все
предложенные (максимум два) помечаются `distilled`, а их id пишутся в
`payload.scenario_ids` строки аудита. Атрибуция грубая, и лимит в два
сценария — это и есть цена, которой мы делаем её приемлемо точной.

## Наблюдаемость: как поймём, что стало лучше

Прошлый раз петля почти не срабатывала, и мы узнали об этом случайно.
Поэтому метрика фиксируется здесь, а не «потом»:

По `agent_selfimprove_audit` (origin `background_review`) сравниваем долю
`action='saved'` среди прогонов **со сценариями** (`payload.scenario_ids`
непусто) и **без**. Обе цифры лежат в одной таблице, считаются одним
запросом, попадают в отчёт `src/analysis/report.ts` отдельной строкой.

Целевой критерий приёмки: на прогонах со сценариями доля `saved` заметно
выше, чем на счётчиковых. Если она такая же низкая — виноват промпт ревью, а
не отсутствие агрегации, и это ровно то, что мы хотели узнать.

## Не-цели

- **Никакого векторного recall в горячем пути.** Сценарии читаются только
  фоновым ревью, не при сборке хода.
- **Никакой LLM-консолидации памяти.** Phase 3 отказалась от неё осознанно
  (`src/ai/selfimprove/curate.ts`), решение в силе: курирование остаётся
  детерминированным.
- **Никакой символической краткосрочной памяти** (Mermaid-канвас, офлоад
  tool-логов). Наши ходы короткие; выгружать нечего.
- **Никакого UI.** Инспекция — SQL и отчёт анализа.
- **Сценарии не пишут в память сами.** Единственный, кто пишет в
  `agent_memory`/`agent_skills`, — ревью через существующие инструменты.

## Затрагиваемые файлы

| Файл | Что делает |
|---|---|
| `migrations/013_trace_user_id.sql` | `user_id` в `raw_traces`, `session_summaries` |
| `migrations/014_agent_scenarios.sql` | таблица L2 |
| `src/tracing/traceStore.ts`, `src/routes/chat.ts` | прокинуть `userId` в трейс |
| `src/analysis/assemble.ts`, `run.ts` | донести `user_id` до саммари; шаг построения сценариев |
| `src/analysis/scenarios.ts` (новый) | извлечение (LLM-проход), дедуп по эмбеддингу, чистые функции состояния |
| `src/analysis/report.ts` | строка метрики saved-rate |
| `src/ai/selfimprove/scenarioFeed.ts` (новый) | чтение due-сценариев, рендер блока, пометка исхода |
| `src/ai/selfimprove/review.ts` | третий источник due + блок в user-сообщении + `scenario_ids` в аудите |
| `src/config.ts` | `SCENARIO_CONFIRM_THRESHOLD`, `SCENARIOS_ENABLED` |

## Тесты

- **Чистые функции без БД** (по образцу `curate.ts`/`classifySkills`): дедуп
  по расстоянию, подсчёт `confirmations` по различным сессиям, машина
  состояний `open→offered→distilled|rejected`, инвариант `offer_count`.
- **Проверка due**: сценарий ниже порога не делает ревью due; сценарий выше —
  делает даже при нулевых счётчиках; `rejected` не предлагается никогда.
- **Ревью с моком** (`MockLanguageModelV3`, как в существующих тестах фазы 1–2):
  блок сценариев попадает в user-сообщение и **не** попадает в `system`;
  прогон без записи на втором предложении помечает `rejected`.
- **Извлечение**: LLM замокан, проверяется маппинг атомов → строк и
  `scope`-разделение при `user_id IS NULL`.
