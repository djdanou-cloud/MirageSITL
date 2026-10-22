# PROJECT_ROADMAP.md

Продолжение TASK-033 от 2026-10-20: DATA_GENERATION_DONE; исполнитель Codex; база aab5e47. Оператор выбрал NACA6409 и NeuralFoil для нового набора аэродинамических данных. Отдельная воспроизводимая суррогатная поляра сохраняет достоверность и происхождение; измеренные сравнения SDA1075 сохраняются без подмены профиля. Область: `scripts/generate-neuralfoil-polar.py`, `scripts/neuralfoil-requirements.txt`, `tests/test_neuralfoil_polar.py`, `tests/fixtures/polars/naca6409-neuralfoil.json`, `tests/fixtures/registry.json`, дорожная карта, спецификация движков и их русские зеркала. Критерии отказа: нечисловые коэффициенты, отрицательное сопротивление, некорректная достоверность, изменение геометрии/зависимостей или несовпадение воспроизведения. Для новой модели данные SDA1075 больше не требуются; измеренная точность и производственная привязка BET остаются отдельными задачами.

Доказательства NACA6409: Python 3.12, NeuralFoil 0.3.3, AeroSandbox 4.2.10, NumPy 2.5.4; закреплены все 22 пакета окружения. Созданы 1210 точек: углы -30..30 градусов с шагом 0.5, десять Re от 1000 до 1000000, только несжимаемое течение. Достоверность >=0.9 имеют 601 узел; остальные 609 сохраняются, поиск учитывает минимум участвующих узлов. SHA-256 фикстуры d6d9793ea030c6b957fa9018ed5c3307891665829773574b2bacb26f1909c9a1. Генератор `--check`: код 0; семь тестов Python проходят (независимая геометрия NACA, прямые вызовы NeuralFoil, интерполяция, границы, достоверность и синтетическое происхождение в реестре). TypeScript, ESLint и сборка Vite: код 0; сохраняется предупреждение о размере пакета. Четыре файла Vitest выполняют 21 тест: 20 проходят, существующий тест NASA не запускает псевдоним python3 Windows; эквивалентный `python -I tests/fixtures/contact/generate_nasa_drop.py --check` проходит. Проверка хешей фикстур отдельно проходит. Первый запуск Vitest столкнулся с запретом переименования временных файлов песочницы; использование `.cache/tmp` в рабочем каталоге позволяет выполнить тесты. Проверка документации проходит (21 двуязычная пара, 86 задач, шесть раскладок); git diff --check проходит. Производственный движок, измеренная точность и READY автопилота не заявляются.


<!-- source-sha256: 50483e774ed9cfeb66e786b36182284b787475fbd8bce23de1ab4772aa63ddb7 -->

Английский источник: [Source of truth](../PROJECT_ROADMAP.md). Изменения спецификации обновляют оба языка в одной задаче.

Версия 1.1 · 2026-10-20 · baseline `aab5e47`. Будущие модули не объявляются реализованными. Активное браузерное приложение работает на ABI v2 (`49280` байт, шаг состояния `192` байта) с частотами `400/800/1200` Гц, очередями датчиков/актуаторов SPSC, рендерингом с учётом эпох, прореженными потоками Pilot HUD / Instructor / AAR и демонстрационным бэкендом динамики (`540` юнит-тестов в `97` файлах, браузерные наборы Chromium и `62` нативных теста Rust). Независимые нативные/WASM ядра роторов, прямой `f64` контакт шасси Rapier (`TASK-029`) и сопряжение чанков коллизий (`TASK-065`), закреплённый JSBSim v1.2.3 WASM/контакт (`TASK-030`/`031`/`086`), нативный полёт ArduCopter SITL в Linux/WSL, `LiveEkfWarmup` и регрессии отказов РЭБ (`TASK-042`/`043`/`059`), а также запуск Worker/EEPROM для ArduCopter WASM (`TASK-045`) проверены в соответствующих стендах. Производственная привязка поляр C ABI BET и конфигурируемые сессии теперь проверены TASK-033. TASK-046 проверяет браузерную границу времени/датчиков/PWM HAL и завершение принадлежащих сессии Worker. Браузерный `READY` автопилота, измеренная достоверность моделей (отдельно от синтетической базы TASK-033), Simulation-on-Hardware и виртуальный Hybrid SITL для ArduPilot (`TASK-051`), 10-минутное профилирование целевых GPU (`TASK-073`), полночастотная запись и итоговая проверка доступности (`TASK-078`/`080`; TASK-074, TASK-075 и TASK-079 выполнены) и итоговая приёмка релиза (`TASK-082`/`083`) остаются открытыми.

Контракты: [Shared Memory](SPECS_SHARED_MEMORY.md),
[Simulation Engines](SPECS_SIMULATION_ENGINES.md), [V2 Architecture & Verification Plan](V2_PLAN.md) и [Agent workflow](CLAUDE.md).
Само по себе обновление документации не вносит изменений в код времени выполнения.

## Как исполнять backlog

Одна TASK = один проверяемый capability increment, обычно один PR. Сначала
все Dependencies должны быть DONE с evidence. ID стабильны и не задают
порядок исполнения: например, атмосфера TASK-032 нужна раньше TASK-020.
Если задача требует research/data/hardware, сначала реализовать независимые
fixtures/инструменты; отсутствие внешнего входа пометить BLOCKED_EXTERNAL.
Не заменять физические/аппаратные критерии synthetic smoke-тестом.

Статусы: TODO → IN_PROGRESS → DONE; альтернативы BLOCKED_EXTERNAL,
BLOCKED_DECISION, FAILED_VALIDATION. Вести статус и evidence под задачей,
сохраняя ID. Tests не реализованного модуля не запускались; имена ниже —
целевые файлы, не заявление об их существовании. Touched Files содержит
точные пути; при необходимости другого файла обновить запись до изменения.

Для IN_PROGRESS записать owner, baseline SHA, выбранный contract, failing
test command; для DONE — commands, exit codes, executed test counts,
artifact/report paths, реальные device/firmware/data versions и остаточные
ограничения. Не удалять обязательные цели из scope ради зелёного отчёта.

## Общая Definition of Done

Каждый локальный DoD включает G0; G1 для hot-path задач, G2 для native/codec,
G3 для performance задач, G4 для hardware/provider интеграций.

* **G0 — correctness:** focused unit/integration tests реально выполнены;
  typecheck/lint/build (после TASK-002), регрессии затронутых контрактов;
  нет отключённых assertions, passWithNoTests или автоматического обновления
  goldens. Для docs-only достаточно проверок структуры/ссылок/листингов.
  Запустить `npm run check:docs`; изменения архитектуры/spec обновляют
  английский источник и зеркало `docs/ru/` в одной задаче. Source hash
  зеркала обновляется только после проверки перевода.
* **G1 — hot path:** после init/warmup 0 явных JS/WASM allocations и 0 bytes
  allocator growth на 1e6 steps; фиксированные capacities, no memory.grow,
  no fetch/await/JSON/React/console внутри step. Timer callbacks и browser GC
  измеряются отдельно: нельзя обещать абсолютную GC isolation.
* **G2 — numeric/protocol:** golden source/hash/units и заранее заданные
  tolerances; scalar обязательный, SIMD fallback и parity; external payload
  из unknown проходит bounds/schema/CRC. Не переносить ложную точность
  синтетической модели в статус experimental validation.
* **G3 — performance:** видимая вкладка, production, 1920×1080, DPR=1,
  заданный quality profile, M4 и RTX 4050 6GB, browser/OS/power mode записаны;
  60 s warmup + 10 min замер. 2026-10-21 пользователь принял для 60 FPS
  медиану 16.680 мс, p99 17.665 мс и панель 59.88 Гц. Профиль 120 FPS по-прежнему
  требует p99<=8.33 ms на панели, которая может его показать. Не требовать 120 FPS от software-headless browser.
  Compute-only physics p99<=50% dt: 1.25/0.625/0.4167 ms при 400/800/1200 Hz;
  отдельно executed Hz within ±1% на 10-s windows и wakeup lateness.
  Required real-time acceptance: zero dropped steps в контрольном прогоне.
  Браузер не гарантирует hard real-time: при провале gate фиксировать
  ограничение/блокер, а не увеличивать dt или скрывать drop.
* **G4 — external evidence:** реальные FC/provider/datasets проверены отдельно
  от mocks. Нет платы/ключа/лицензии/данных → BLOCKED_EXTERNAL с точным шагом
  разблокировки, без credentials в chat/files. HITL и WASM gates нельзя
  объявить выполненными потому, что внешний SITL работает.

Terrain budget baseline: <=2 GiB estimated GPU resident + <=512 MiB decoded
CPU cache; фактическую доступность GPU memory считать ограниченной и
подтверждать профилем. BET WASM arena baseline <=64 MiB. При превышении
менять quality/config в заданном envelope и повторять соответствующий gate,
не снижать критерий без записанного product decision.

## Спринты и phase gates

Спринт — ordered batch из 2–4 независимых/последовательных задач, а не
обещание календарного срока. Новый sprint не требует повторного согласования
очевидных implementation choices. Phases последовательны по основному
контуру; capability probes и внешние данные можно готовить заранее.
Минимальный существующий UI сохраняется до Phase 6.

| Phase | Sprint batches | Exit |
| --- | --- | --- |
| 0 Skeleton | S00a: 001,002,084; S00b: 003,004,005,006 | Воспроизводимый workspace, гейты lint/CI/config |
| 1 Shared Memory & Worker | S01a: 007,008,009; S01b: 010,011,012; S01c: 013,014,015,085 | ABI v2, часы, транспорт, профилирование |
| 2 Aerodynamics & WASM | S02a: 016,017,018; S02b: 019,032,020; S02c: 021,022,023; S02d: 024,025,026; S02e: 027,028,029; S02f: 030,031,033 | Бэкенды BET/JSBSim с заявленной областью применимости |
| 3 ArduPilot & Radio Link | S03a: 034,035,036,037; S03b: 038,039,040,041; S03c: 042,043; S03d: 044,045,046,047; S03e: 048,049,050,051 | Свидетельства SITL/WASM/HITL по режимам |
| 4 EW & Sensor Faults | S04a: 052,053,054; S04b: 055,056,057; S04c: 058,059 | Детерминированные отказы и закреплённые сценарии EKF |
| 5 Environment & Shaders | S05a: 060,061,062; S05b: 063,064,065; S05c: 066,067,068; S05d: 069,070,071,072; S05e: 073 | Лицензированный рельеф, профили рендера, гейты целевых GPU |
| 6 UI & Telemetry | S06a: 074,075; S06b: 076,077,078; S06c: 079,080,081; S06d: 082,083 | Тренировки/AAR и матрица релиза с доказательствами |

WASM ArduPilot feasibility и HITL compatibility — обязательные отдельные
gates. Если они заблокированы, продолжить независимые задачи, но не
объявлять полную Phase 3/проект DONE. Google persistent caching не считается
разрешённым требованием: TASK-060 фиксирует licensing decision; TASK-064
работает с разрешённым dataset, например собственными tiles. Исходная цель
10–15 km остаётся параметром регионального cache, не оправданием копирования
Google content без прав.

## Phase 0: Skeleton

### TASK-001 — Зафиксировать работающий skeleton

- **Status:** DONE — повторно проверено относительно baseline c8814c6.
- **Title & Description:** Сохранить существующий React/Vite workspace и воспроизводимый demo flight.
- **Dependencies:** нет.
- **Touched Files:** `package.json`, `package-lock.json`, `apps/web/vite.config.ts`, `README.md`.
- **Interfaces / Contracts:** React 19, Vite, npm workspaces; COOP/COEP.
- **DoD & Acceptance Criteria:** DONE baseline e3bb6b4: npm ci, npm run build, 13 unit и 4 browser tests ранее пройдены; чистая установка не меняет lockfile.
- **Evidence:** Владелец Codex; baseline c8814c6; 2026-10-15. Чистый `npm ci` сохранил SHA-256 lockfile; `npm run build` exit 0; 25 unit и 4 browser tests прошли без пропусков и ошибок.

### TASK-002 — Типизация и lint gate

- **Status:** DONE — реализовано и локально проверено.
- **Title & Description:** Добавить отдельные команды typecheck/lint и исключить explicit/implicit unsafe any, включая browser dynamic import.
- **Dependencies:** TASK-001.
- **Touched Files:** `package.json`, `package-lock.json`, `eslint.config.mjs`, `tsconfig.json`, `tests/browser/simulation.spec.ts`, `tests/tooling.test.ts`, `tests/fixtures/tooling/unsafe-types.txt`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** unknown + runtime narrowing; strict/noUncheckedIndexedAccess; typed module imports.
- **DoD & Acceptance Criteria:** npm run lint и npm run typecheck выполняются; negative lint fixture с explicit any и unsafe assignment отклоняется; не ослаблять strict ради existing кода.
- **Evidence:** Владелец Codex; baseline c8814c6; 2026-10-15. Типизированные правила ESLint 10 / `typescript-eslint` проходят без inline-подавлений; `npm run lint` и `npm run typecheck` exit 0. `tests/tooling.test.ts`: 3 PASS (проверены отрицательные фикстуры `any`/unsafe и `TS2322`).

### TASK-003 — Автоматический CI

- **Status:** DONE — реализация завершена; запуски на хостинге проверены 2026-10-16.
- **Title & Description:** Запускать проверки на pull request без зависимости от аппаратуры или платных API.
- **Dependencies:** TASK-002.
- **Touched Files:** `.github/workflows/ci.yml`, `playwright.config.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package.json`, `package-lock.json`, `vitest.config.ts`, `.gitignore`, `tests/ci.test.ts`.
- **Interfaces / Contracts:** Node 24, frozen npm lock; отдельно unit/browser/build jobs.
- **DoD & Acceptance Criteria:** CI запускает ненулевое число тестов, сохраняет результаты/trace при ошибке; no-tests и failed job дают failure; секреты не нужны для synthetic lane.
- **Evidence:** Владелец Codex/Claude; проверено 2026-10-16. Три независимых задания CI (`unit`, `browser`, `build`) в `.github/workflows/ci.yml` и `.github/workflows/native.yml` реализованы; `tests/ci.test.ts`: 4 PASS (оба раннера отклоняют запуски с нулём тестов и проверяют закреплённые версии тулчейна). Хостинговый запуск GitHub Actions `38935251383` (PR `#2`, head `e28eb7c`) прошёл все три задания (артефакт `test-results/unit/junit.xml` `12060104387`, браузерный отчёт `12060348065`, production-сборка); запуск `native.yml` `38935251375` также прошёл.

### TASK-004 — Golden fixtures и seed registry

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Создать общий формат эталонов с provenance и детерминированным PRNG.
- **Dependencies:** TASK-002.
- **Touched Files:** `packages/test-support/package.json`, `packages/test-support/src/fixtures.ts`, `packages/test-support/src/prng.ts`, `tests/fixtures.test.ts`, `tests/fixtures/registry.json`, `package-lock.json`, `tests/fixtures/ballistic.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** FixtureManifest {id, sourceSha256, units, validityEnvelope, tolerance}; PRNG algorithm/version.
- **DoD & Acceptance Criteria:** Известный seed даёт frozen sequence; разные stream IDs независимы; неверные units/hash отклоняются; ни один synthetic fixture не помечен experimental measurement.
- **Evidence:** Владелец Codex; baseline c26df78; 2026-10-15. `tests/fixtures.test.ts`: 4 PASS. Seed `123` / stream `7` совпадает с закреплённым вектором `mulberry32-mix32-v1`; проверены раздельные состояния потоков, сброс, нулевой seed, границы float, побайтовая проверка SHA-256, отклонение неверных единиц/диапазонов/допусков и различение синтетического происхождения.

### TASK-005 — Runtime capability gate

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Определять SAB/WebGL2/WebGPU/Gamepad/Serial и выдавать доступные режимы без ложного READY.
- **Dependencies:** TASK-001, TASK-002.
- **Touched Files:** `apps/web/src/capabilities.ts`, `apps/web/src/App.tsx`, `tests/capabilities.test.ts`, `tests/browser/capabilities.spec.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** CapabilityReport; mode eligibility.
- **DoD & Acceptance Criteria:** Mock каждого отсутствующего API даёт понятный disabled state; отсутствие isolation блокирует worker; WebGPU failure сохраняет WebGL2 fallback.
- **Evidence:** Владелец Codex; baseline c26df78; 2026-10-15. `tests/capabilities.test.ts`: 7 PASS; `tests/browser/capabilities.spec.ts`: 7 PASS в Chromium. Отсутствие secure context, cross-origin isolation, `SharedArrayBuffer`, `Worker` или WebGL2 блокирует Start; отсутствие Gamepad отключает USB; отклонённые/отсутствующие/превысившие тайм-аут пробы WebGPU сохраняют откат на WebGL2 без включения непроверенных режимов.

### TASK-006 — Model manifest schema

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Валидировать модели/рама/единицы/hash и версию конфигурации до загрузки.
- **Dependencies:** TASK-004.
- **Touched Files:** `packages/physics/src/model-manifest.ts`, `packages/physics/src/model.schema.json`, `tests/model-manifest.test.ts`, `tests/fixtures/models/demo-quad.json`, `packages/physics/package.json`, `package-lock.json`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** ModelDescriptor, RotorGeometry, registry modelId→SHA; SPD inertia.
- **DoD & Acceptance Criteria:** Positive/negative fixtures: NaN, масса<=0, не-SPD inertia, duplicate motor IDs, rotorCount>32 и invalid quaternion отвергаются; hash проверяется до swap.
- **Evidence:** Владелец Codex; baseline c26df78; 2026-10-15. `tests/model-manifest.test.ts`: 4 PASS. Проверены схема/система координат/единицы/количество/NaN, симметричный положительно определённый тензор инерции, уникальность ID/каналов моторов, норма кватерниона и побайтовая проверка SHA-256 перед допуском в реестр; сбой хеша/схемы/коллизии сохраняет прежнюю модель.

### TASK-084 — Обнаружение правил агентами

- **Status:** DONE — Claude; baseline 1064a57; 2026-10-15.
- **Title & Description:** Добавить тонкие entry points, которые направляют Codex/Cursor к единому CLAUDE.md.
- **Dependencies:** TASK-001.
- **Touched Files:** `AGENTS.md`, `.cursor/rules/project.mdc`, `tests/agent-config.test.ts`, `docs/ru/AGENTS.md`, `docs/documentation-index.json`, `tests/documentation-policy.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** CLAUDE.md — единый источник workflow; wrapper содержит ссылку, не копию правил.
- **DoD & Acceptance Criteria:** Проверка читает оба entry point и разрешает root CLAUDE.md; Cursor rule alwaysApply=true; тест не утверждает автоматическое чтение файла любым неизвестным клиентом.
- **Evidence:** Владелец Claude; baseline 1064a57; 2026-10-15. `AGENTS.md` (в паре с `docs/ru/AGENTS.md`) и `.cursor/rules/project.mdc` (`alwaysApply: true`) указывают на корневой `CLAUDE.md` без дублирования разделов правил. `tests/agent-config.test.ts`: 3 PASS; `tests/documentation-policy.test.ts`: 6 PASS.

## Phase 1: Shared Memory & Worker

### TASK-007 — Закрепить ABI v1 baseline

- **Status:** DONE — Codex/Claude; baseline f13213b; 2026-10-15.
- **Title & Description:** Сохранить существующие reader/writer и lifecycle regression как исходную точку миграции.
- **Dependencies:** TASK-001.
- **Touched Files:** `packages/protocol/src/index.ts`, `tests/protocol.test.ts`, `tests/protocol-golden.test.ts`, `tests/fixtures/abi/v1-layout.json`, `tests/fixtures/registry.json`, `tests/browser/simulation.spec.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** v1: 32896 bytes, 128-byte states, 400 Hz.
- **DoD & Acceptance Criteria:** DONE baseline e3bb6b4: существующие 4 protocol tests проверяют size/version, float64 roundtrip, ring overwrite, busy frame и controls; lifecycle проверен браузером.
- **Evidence:** Владелец Codex/Claude; 2026-10-15. `tests/protocol.test.ts` (4 PASS) и `tests/protocol-golden.test.ts` (4 PASS) проверяют раскладку v1 на 32896 байт и эталон состояния на 128 байт против `tests/fixtures/abi/v1-layout.json` (SHA-256 `00a2e97d75521263f4348199c5e0086dd720949cffc92185cdaf97fbd1fd8be0`, допуск 0) и таблиц v1 в [SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md). Reader/writer v1 сохраняются как регрессионный API, тогда как приложение работает на ABI v2 (`TASK-085`).

### TASK-008 — Константы и layout ABI v2

- **Status:** DONE — Claude; baseline 695023c; 2026-10-15.
- **Title & Description:** Ввести v2 отдельно от v1 и golden двоичный fixture.
- **Dependencies:** TASK-006, TASK-007.
- **Touched Files:** `packages/protocol/src/layout-v2.ts`, `packages/protocol/src/state-v2.ts`, `tests/layout-v2.test.ts`, `tests/fixtures/protocol/state-v2.hex`, `packages/protocol/src/pilot-v2.ts`, `packages/protocol/src/index.ts`, `tsconfig.json`, `tests/support/spec-layout.ts`, `tests/support/golden-v2.ts`, `tests/protocol-golden.test.ts`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY §3; 49280 bytes; state stride 192, TickId lo/hi.
- **DoD & Acceptance Criteria:** Все поля покрыты offset/size/alignment tests; golden побайтово совпадает; v1 не проходит v2 validation; reserved words нули.
- **Evidence:** Владелец Claude; baseline 695023c; 2026-10-15. `tests/layout-v2.test.ts`: 13 PASS. Зарегистрированная фикстура `abi-v2-golden` (`tests/fixtures/protocol/state-v2.hex`, допуск 0) совпадает с Header v2, State v2 (шаг 192 байта, 256 слотов) и Pilot mailbox v2 на всех 49280 байтах с естественным выравниванием, `negotiateAbiVersion`, переносом/границей 53-битного тика и отклонением буферов v1.

### TASK-009 — Атомарные v2 reader/writer

- **Status:** DONE — Claude; baseline 0cc6d4c; 2026-10-15.
- **Title & Description:** Реализовать bounded seqlock, публикацию sample_id и epoch-safe render history.
- **Dependencies:** TASK-008.
- **Touched Files:** `packages/protocol/src/atomic-v2.ts`, `packages/protocol/src/index.ts`, `tests/atomic-v2.test.ts`, `tests/browser/atomic-v2.spec.ts`, `tests/support/atomic-v2-stress.ts`, `tests/support/atomic-v2-stress.node-worker.ts`, `tests/support/atomic-v2-stress.browser-worker.ts`, `tests/tooling.test.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** StateWriterV2/StateReaderV2; single writer; max 3 read attempts.
- **DoD & Acceptance Criteria:** 1e6 concurrent publications без torn fields; interrupted writer возвращает miss без изменения output; counters/epochs/reset проверены; v1 tests сохранены до явного удаления compatibility.
- **Evidence:** Владелец Claude; baseline 0cc6d4c; 2026-10-15. `tests/atomic-v2.test.ts` (9 PASS) и `tests/browser/atomic-v2.spec.ts` (1 PASS) проверяют публикацию seqlock, валидацию `sample_id`, возврат miss при прерванной записи без изменения выхода, защиту `latestPair` при смене эпохи/модели/пропуске тиков и переносе 32-битного тика, а также 1e6 конкурентных публикаций в Node `worker_threads` (272 286 чтений, 0 разорванных) и Chromium Worker (611 561 чтение, 0 разорванных).

### TASK-010 — Control Protocol v2

- **Status:** DONE — Claude; baseline 3b1711b; 2026-10-15.
- **Title & Description:** Валидировать lifecycle, weather, model и fault commands и детерминированные ACK.
- **Dependencies:** TASK-008, TASK-009.
- **Touched Files:** `packages/protocol/src/control-v2.ts`, `packages/protocol/src/control-v2.schema.json`, `tests/control-v2.test.ts`, `packages/protocol/src/index.ts`, `package.json`, `package-lock.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY §6; unknown→ControlCommandV2; queued/applied/reject.
- **DoD & Acceptance Criteria:** Каждая ветвь имеет positive/negative fixture; stale epoch, duplicate ID, past tick и очередь 128+1 отклоняются; failed model swap сохраняет прежнюю paused модель.
- **Evidence:** Владелец Claude; baseline 3b1711b; 2026-10-15. `tests/control-v2.test.ts`: 74 PASS. Покрывает 60 положительных и отрицательных фикстур валидации (валидатор TypeScript + строгая схема Ajv 8.18.0), ACK жизненного цикла, `STALE_EPOCH`, идемпотентность дубликатов ID и вытеснение high-water после 128 ID, отклонение прошедшего тика и горизонта 10 с, очередь `128+1` с `OVERLOAD`, а также неудачную (`ASSET_MISSING`, сохранение прежней модели/эпохи, пауза) и успешную смену модели.

### TASK-011 — Частоты 400/800/1200

- **Status:** DONE — Claude; baseline 1e96582; 2026-10-16.
- **Title & Description:** Параметризовать scheduler и dt с рациональными sensor timestamps.
- **Dependencies:** TASK-010.
- **Touched Files:** `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `tests/clock.test.ts`, `tests/browser/simulation.spec.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** PhysicsHz; TickId; simTime=tick/hz, fixed dt.
- **DoD & Acceptance Criteria:** Fake clock за 10 s даёт 4000/8000/12000 шагов; нет accumulated dt drift; pause/resume не создаёт backlog; 1200 Hz time_usec имеет интервалы 833/834 μs.
- **Evidence:** Владелец Claude; baseline 1e96582; 2026-10-16. `tests/clock.test.ts`: 12 PASS. Пробуждения с дрожанием дают ровно 4000/8000/12000 шагов за 10 с без дрейфа; ограниченный catch-up считает отброшенные шаги; pause/resume не создаёт backlog; интервалы `time_usec` при 1200 Гц равны `{833, 834}` мкс с суммой `1e6` через перенос 32-битного тика; расписания IMU 200/400 Гц и GNSS 5/10 Гц синхронизированы по фазе.

### TASK-012 — Clock modes и перегрузка

- **Status:** DONE — Claude; baseline be502a4; 2026-10-16.
- **Title & Description:** Разделить interactive drop, SITL lockstep wait и HITL fault policy.
- **Dependencies:** TASK-011.
- **Touched Files:** `packages/physics/src/clock-policy.ts`, `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `tests/clock-policy.test.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** interactive / sitl-lockstep / hitl-realtime; maxCatchUp=8.
- **DoD & Acceptance Criteria:** При 1 s stall interactive считает drop, SITL не пропускает sim tick, HITL помечает session invalid; pause/dispose обслуживаются даже при отсутствующем actuator.
- **Evidence:** Владелец Claude; baseline be502a4; 2026-10-16. `tests/clock-policy.test.ts`: 5 PASS. Задержка 1 с при 400 Гц считает 392 потери в режиме `interactive` с непрерывными тиками, сохраняет каждый тик в `sitl-lockstep` (догоняя не более `maxCatchUp = 8` тиков за вызов pump без блокировки при отсутствии актуаторов) и фиксирует `hitl-overrun` в `hitl-realtime` до `resetEpoch`.

### TASK-013 — Sensor/actuator SPSC

- **Status:** DONE — Claude; baseline aef7af6; 2026-10-16.
- **Title & Description:** Создать раздельные bounded queues со строгим владением и backpressure.
- **Dependencies:** TASK-008, TASK-009, TASK-012.
- **Touched Files:** `packages/protocol/src/spsc-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/spsc-v2.test.ts`, `tests/browser/spsc-v2.spec.ts`, `packages/protocol/src/index.ts`, `tests/support/spsc-stress.ts`, `tests/support/spsc-stress.node-worker.ts`, `tests/support/spsc-stress.browser-worker.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY §5; capacity=1024, stride=128.
- **DoD & Acceptance Criteria:** Full/empty/wrap и reset tested; unread slot никогда не затирается; 1e6 frames сохраняют порядок; overflow SITL/HITL обрабатывается policy, не silent drop.
- **Evidence:** Владелец Claude; baseline aef7af6; 2026-10-16. `tests/spsc-v2.test.ts` (9 PASS) и `tests/browser/spsc-v2.spec.ts` (1 PASS) проверяют раскладку слотов и заголовка раздела 5, full/empty/wrap/reset, фиксацию переполнения HITL до `resetSpscQueue`, кодеки кадров датчиков/актуаторов и 1e6 конкурентных кадров в Node `worker_threads` и Chromium Worker с 0 кадров вне порядка, повреждённых или недопустимых.

### TASK-014 — Измеритель hot path

- **Status:** DONE — Claude; baseline 920bd23; 2026-10-16.
- **Title & Description:** Добавить allocation/step/deadline профилирование с машинным отчётом.
- **Dependencies:** TASK-009, TASK-011, TASK-013.
- **Touched Files:** `packages/physics/src/step-metrics.ts`, `scripts/bench-physics.mjs`, `tests/step-metrics.test.ts`, `docs/benchmarks/schema.json`, `packages/physics/src/index.ts`, `packages/physics/src/clock.ts`, `packages/physics/src/clock-policy.ts`, `packages/physics/src/demo-dynamics.ts`, `packages/physics/src/session-v2.ts`, `packages/protocol/src/state-v2.ts`, `packages/protocol/src/pilot-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/layout-v2.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** G1/G3; отдельно compute duration, wakeup lateness и executed Hz.
- **DoD & Acceptance Criteria:** После warmup 1e6 шагов: explicit JS/WASM allocations=0, arena size постоянен; baseline report содержит p50/p95/p99/max и environment; profiler overhead измерен отдельно.
- **Evidence:** Владелец Claude; baseline 920bd23; 2026-10-16. `node scripts/bench-physics.mjs` (`--expose-gc --max-semi-space-size=64 --single-threaded`, отчёт `test-results/bench/physics.json`, схема `docs/benchmarks/schema.json`) и `tests/step-metrics.test.ts` (3 PASS) подтверждают `zeroAllocation = true` (`0.00000` Б/шаг по окнам `1e6`/`2e6`, 0 событий GC, выделяющий положительный контроль обнаружен; вычисление шага p50 `~1.0` мкс, p99 `~1.1–1.9` мкс). На Windows Node (`test-results/laptop/bench-physics-400.json`, `bench-physics-800.json`, `bench-physics-1200.json`) прогон `bench-physics` в реальном времени выполнил 400.5 Гц (цель 400, 0 потерь), 516.7 Гц (цель 800, 1 426 потерь) и 519.6 Гц (цель 1200, 3 415 потерь) с потерями: пробуждения таймера ~16 мс × лимит догоняющих шагов 8. Вычисление занимает ~1 мкс/шаг; регрессия браузерного Worker на 800 Гц пройдена.

### TASK-015 — Интерполяция и смена epoch

- **Status:** DONE — Claude; baseline db50e9a; 2026-10-16.
- **Title & Description:** Поддержать плавный renderer без интерполяции через reset/model swap.
- **Dependencies:** TASK-009, TASK-011.
- **Touched Files:** `apps/web/src/FlightScene.tsx`, `apps/web/src/coordinates.ts`, `packages/protocol/src/interpolation.ts`, `tests/interpolation.test.ts`, `packages/protocol/src/index.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Adjacent tick + same epoch/model, shortest-path quaternion SLERP.
- **DoD & Acceptance Criteria:** q и -q не дают полный оборот; NED basis tests проходят; reset/teleport разрывает history; renderer не ждёт writer и не изменяет truth.
- **Evidence:** Владелец Claude; baseline db50e9a; 2026-10-16. `tests/interpolation.test.ts` (6 PASS) проверяет линейную интерполяцию положения и ориентацию SLERP по кратчайшему пути с точностью `1e-12` рад относительно оракула ось-угол, эквивалентность `q`/`-q`, разрыв истории при `latest`/`none` или телепортации >100 м, а также отображение координат NED в рендер в `FlightScene.tsx`.

### TASK-085 — Перевод Worker и Main на ABI v2

- **Status:** DONE — Claude; baseline bad3099; 2026-10-16.
- **Title & Description:** Перевести работающее приложение с ABI v1 и postMessage-протокола v1 на state ring v2, pilot mailbox, WorkerInitV2 и Control Protocol v2. Выделено из TASK-009/010, поскольку WorkerInitV2 требует sensor/actuator buffers из TASK-013.
- **Dependencies:** TASK-009, TASK-010, TASK-013.
- **Touched Files:** `apps/web/src/runtime.ts`, `apps/web/src/physics.worker.ts`, `apps/web/src/App.tsx`, `tests/browser/simulation.spec.ts`, `tests/browser/runtime-v2.spec.ts`, `apps/web/src/FlightScene.tsx`, `packages/physics/src/session-v2.ts`, `packages/physics/src/demo-dynamics.ts`, `packages/physics/src/index.ts`, `packages/protocol/src/control-v2.ts`, `packages/input/src/index.ts`, `tests/session-v2.test.ts`, `tests/control-v2.test.ts`, `tests/input.test.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** WorkerInitV2; StateWriterV2/StateReaderV2; PilotWriterV2/PilotReaderV2; ControlProcessorV2; SPECS_SHARED_MEMORY sections 3–6.
- **DoD & Acceptance Criteria:** Browser tests жизненного цикла, устаревшего ввода, USB failsafe и fixed dt проходят на v2; устаревший epoch или изменённый device_generation снимает arm; рендер никогда не интерполирует через смену epoch; совместимость с v1 удаляется только по зафиксированному решению.
- **Evidence:** Владелец Claude; baseline bad3099; 2026-10-16. `tests/session-v2.test.ts` (11 PASS), `tests/browser/simulation.spec.ts` (4 PASS) и `tests/browser/runtime-v2.spec.ts` (2 PASS) проверяют подключение `init-v2` состояния и очередей SPSC, взведение только при газе `<=5%`, снятие вооружения при смене `device_generation` и устаревшей эпохе, выполнение браузерного Worker на 800 Гц в пределах 10% (`720–880` Гц) и безопасную к смене эпох историю интерполяции.

## Phase 2: Aerodynamics & WASM

### TASK-016 — Native Rust workspace

- **Status:** DONE — Claude; baseline 4187246; 2026-10-16.
- **Title & Description:** Поднять pinned scalar BET crate и native tests.
- **Dependencies:** TASK-003, TASK-004.
- **Touched Files:** `native/Cargo.toml`, `native/Cargo.lock`, `native/rust-toolchain.toml`, `native/bet/Cargo.toml`, `native/bet/src/lib.rs`, `.github/workflows/native.yml`, `native/bet/tests/bootstrap.rs`, `tests/browser/native-bootstrap.spec.ts`, `.github/workflows/ci.yml`, `tests/ci.test.ts`, `.gitignore`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** wasm32-unknown-unknown; repr(C) boundary; scalar default.
- **DoD & Acceptance Criteria:** cargo check/test --locked проходят; target/toolchain pinned; воспроизводимый empty kernel artifact проверен на Chromium; production математика ещё не заявляется.
- **Evidence:** Владелец Claude; baseline 4187246; 2026-10-16. Закреплён Rust `1.97.0` (`native/rust-toolchain.toml`, `wasm32-unknown-unknown` с ловушечным глобальным аллокатором и нулём импортов). `cargo test --manifest-path native/Cargo.toml --workspace --locked` (`bootstrap.rs`: 6 PASS) и `tests/browser/native-bootstrap.spec.ts` (1 PASS в Chromium) проверяют воспроизводимые по SHA-256 сборки и совпадение силы элемента с точностью `1e-12`. Хостинговый `.github/workflows/native.yml` прошёл в запуске `38935251375`.

### TASK-017 — Сборка и загрузка WASM

- **Status:** DONE — Claude; baseline e152ee3; 2026-10-16.
- **Title & Description:** Создать wrapper с hash/ABI проверкой и scalar/SIMD artifact selection.
- **Dependencies:** TASK-005, TASK-016.
- **Touched Files:** `packages/wasm-bet/package.json`, `packages/wasm-bet/src/loader.ts`, `scripts/build-wasm.mjs`, `tests/wasm-loader.test.ts`, `tests/browser/wasm-loader.spec.ts`, `package-lock.json`, `.github/workflows/ci.yml`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** bet_abi_version; artifact manifest, SIMD feature detection.
- **DoD & Acceptance Criteria:** Corrupt hash/ABI блокируют arm; fallback scalar при unsupported SIMD; instantiate выполняется вне step; memory заранее зарезервирована <=64 MiB для BET baseline.
- **Evidence:** Владелец Claude; baseline e152ee3; 2026-10-16. `node scripts/build-wasm.mjs` собирает артефакты `scalar` и `simd128` с `manifest.json`; `tests/wasm-loader.test.ts` (5 PASS) и `tests/browser/wasm-loader.spec.ts` (1 PASS в Chromium) проверяют контроль SHA-256/размера/ABI, детекцию SIMD128 с откатом на scalar и резервирование 64 МиБ памяти с `memoryStable()`.

### TASK-018 — C ABI и arena binding

- **Status:** DONE — Claude; baseline a3e7141; 2026-10-16.
- **Title & Description:** Определить checked input/config/output records без object marshaling на шаге.
- **Dependencies:** TASK-006, TASK-017.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/include/bet.h`, `packages/wasm-bet/src/arena.ts`, `tests/wasm-abi.test.ts`, `native/bet/src/lib.rs`, `native/bet/build.rs`, `native/bet/tests/abi.rs`, `packages/wasm-bet/src/loader.ts`, `packages/wasm-bet/package.json`, `tests/fixtures/wasm-abi/generate.py`, `tests/fixtures/wasm-abi/bet-abi-v1.json`, `tests/fixtures/registry.json`, `tests/browser/native-bootstrap.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES §4, rotor output stride=128.
- **DoD & Acceptance Criteria:** Rust size/offset tests совпадают с TS golden; invalid pointer/count/size отклоняется; 1e6 step calls не вызывают allocator/grow; out перезаписывается in-place.
- **Evidence:** Владелец Claude; baseline a3e7141; 2026-10-16. `native/bet/tests/abi.rs` (7 PASS) и `tests/wasm-abi.test.ts` (7 PASS) проверяют `native/bet/include/bet.h` и эталон `tests/fixtures/wasm-abi/bet-abi-v1.json` (конфигурация 4384 Б, вход 256 Б, шаг выхода ротора 128 Б), отклонение неверных указателей/выравнивания/перекрытий и 1e6 вызовов `stepInto` с 0 событий GC, 0 аллокаций WASM и `memoryStable()`. Рабочий шаг арены `bet_step` по-прежнему возвращает `AERODYNAMICS_UNAVAILABLE` до подключения версионированной привязки поляр и конфигурации.

### TASK-019 — Polar lookup

- **Status:** DONE — Claude; baseline ddb263d; 2026-10-16.
- **Title & Description:** Реализовать проверяемую интерполяцию CL/CD по alpha/logRe/Mach.
- **Dependencies:** TASK-004, TASK-018.
- **Touched Files:** `native/bet/src/polar.rs`, `tests/fixtures/polars/synthetic.json`, `native/bet/tests/polar.rs`, `native/bet/src/lib.rs`, `tests/fixtures/polars/generate.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** PolarTable; flattened (Mach,Re,alpha), validity flags.
- **DoD & Acceptance Criteria:** Узлы/межузлия/reverse flow/границы проверены аналитически; negative CD/NaN отвергнуты; outside range даёт clamp+flag, не скрытую экстраполяцию.
- **Evidence:** Владелец Claude; baseline ddb263d; 2026-10-16. `native/bet/tests/polar.rs` (5 PASS) проверяет трилинейную интерполяцию по `(Mach, ln Re, alpha)` с точностью `1e-12` против `tests/fixtures/polars/synthetic.json` (81 узел, 13 запросов), обратное обтекание и ограничение на границах с флагами применимости, а также отклонение отрицательного `CD` / нечисловых значений / некорректных осей. Фикстура синтетическая и не является измеренной полярой профиля.

### TASK-020 — Blade element quadrature

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Интегрировать силы/моменты элементов с заданными Ω и inflow.
- **Dependencies:** TASK-019, TASK-032.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/blade.rs`, `native/bet/src/quadrature.rs`, `native/bet/tests/blade.rs`, `native/bet/src/lib.rs`, `tests/fixtures/rotors/blade.json`, `tests/fixtures/registry.json`, `native/bet/tests/allocation.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** RotorGeometry/RotorStepInput; equations §3.
- **DoD & Acceptance Criteria:** Zero-flow, mirror spin, drag dissipation и independent wrench fixtures; quadrature weights не умножают силу на число samples; refinement 16→32→64 converges с fixture tolerance.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. `cargo test --test blade --locked` (5 PASS) и `tests/rotor-kernels.test.ts` (хвосты scalar/SIMD `1/3/5/63` с точностью `1e-9` Н/Н·м) проверяют силу/момент кольца, радиальное сгущение 16/32/64, нормированное усреднение по азимуту, зеркальное вращение, нулевой поток и диссипацию сопротивления против `tests/fixtures/rotors/blade.json` (относительный допуск `1e-4`). Привязка поляр к рабочему C ABI остаётся открытой.

### TASK-021 — Dynamic inflow

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Добавить bounded axial induced-flow state и validity envelope.
- **Dependencies:** TASK-020.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/inflow.rs`, `native/bet/tests/inflow.rs`, `tests/fixtures/rotors/axial-inflow.json`, `tests/fixtures/registry.json`, `native/bet/src/lib.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** signed induced velocity; max 4 solver iterations/step.
- **DoD & Acceptance Criteria:** Hover momentum residual<=1% fixture thrust; transient convergence checked; VRS/out-of-envelope отмечен, не выдан за валидированный режим; finite на zero RPM/flow.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. `cargo test --test inflow --locked` (2 PASS) и проверки scalar/SIMD WASM (`<=1e-9` м/с) подтверждают знаковую невязку импульса висения/набора `<=1%`, релаксацию на 400/800/1200 Гц, нулевую нагрузку и явные флаги применимости снижения/VRS/поперечного обтекания против `tests/fixtures/rotors/axial-inflow.json`. Не является валидированной моделью индуктивного потока VRS/авторотации.

### TASK-022 — Free shaft / авторотация

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Интегрировать обороты из аэромомента, torque и потерь без RPM governor.
- **Dependencies:** TASK-021.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/shaft.rs`, `native/bet/tests/autorotation.rs`, `tests/fixtures/rotors/free-shaft.json`, `tests/fixtures/registry.json`, `native/bet/src/lib.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** J*dΩ/dt=tau_motor+s*Qair-tau_loss; RotorState.
- **DoD & Acceptance Criteria:** Без потока/мотора энергия убывает; при допустимом набегающем потоке free rotor набирает/теряет RPM по torque; steady residual<0.01 Nm; нет принудительного заданного RPM.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. `cargo test --test autorotation --locked` (2 PASS) и проверки scalar/SIMD WASM (`<=1e-9` рад/с) подтверждают пассивное затухание энергии, ускорение/замедление свободного вала потоком при обоих направлениях вращения, стационарную невязку `<0.01` Н·м и сходимость на 400/800/1200 Гц против `tests/fixtures/rotors/free-shaft.json`. Экспериментальная валидация автожира не заявляется.

### TASK-023 — Flapping и gyro momentum

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Добавить coning/first-harmonic flap и полную передачу dH/dt.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/flapping.rs`, `native/bet/src/momentum.rs`, `native/bet/tests/flapping.rs`, `native/bet/src/lib.rs`, `tests/fixtures/rotors/flapping.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** RotorState flap states; Mhub=Mair-dH/dt; documented hinge parameters.
- **DoD & Acceptance Criteria:** Zero asymmetry case, sign/axis tests, angular momentum balance и timestep convergence; equations/source/validity сохранены; mesh tilt не используется вместо dynamics.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. `cargo test --test flapping --locked` (3 PASS) и `native/bet/tests/allocation.rs` проверяют уравнения Галёркина для шарнира без разноса, симметрию общего шага, зеркальные знаки вращения, баланс момента импульса `Mhub = Mair - dH/dt` против `tests/fixtures/rotors/flapping.json` (допуск scalar/SIMD `1e-8` рад) и 0 аллокаций за 1e6 совместных шагов ядер native/WASM. Связь нагрузки плоского диска и малоугловая приведённая инерция остаются явными ограничениями.

### TASK-024 — Соосное взаимодействие

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Ввести отдельный wake coupling для пары rotor disks.
- **Dependencies:** TASK-021, TASK-023.
- **Touched Files:** `native/bet/src/coaxial.rs`, `native/bet/tests/coaxial.rs`, `tests/fixtures/rotors/coaxial.json`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `native/bet/tests/allocation.rs`, `tests/rotor-kernels.test.ts`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** WakePair {upperId,lowerId,separationM,overlap}; energy/source provenance.
- **DoD & Acceptance Criteria:** Отключённый coupling даёт independent rotors; большие separation стремятся к нему; momentum/energy ledger checked; без измеренных данных модель явно experimental.
- **Evidence:** Владелец Codex; baseline 8f7dc19; 2026-10-16. `cargo test --manifest-path native/Cargo.toml --test coaxial --locked` (4 PASS) и `tests/rotor-kernels.test.ts` (4 PASS) проверяют независимость при отключении/нулевом перекрытии, сходимость в дальней зоне в пределах `1e-6` Н/Н·м, масштабирование перекрытия, балансы импульса/энергии против `tests/fixtures/rotors/coaxial.json` (допуск `1e-9`) и 1e6 шагов с 0 аллокаций. Экспериментальный эталон идеального висения/смешения; измеренный набор данных соосного винта и привязка к рабочему C ABI отсутствуют.

### TASK-025 — ESC и spool model

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Преобразовывать duty в torque/RPM transient выбранной моделью привода.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/src/motor.rs`, `native/bet/tests/motor.rs`, `packages/physics/src/motor-config.ts`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/motor-config.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Torque-model или first-order governor; current/back-EMF limits.
- **DoD & Acceptance Criteria:** Step duty имеет заданный lag/current saturation; zero voltage не создаёт энергии; power-cut сохраняет spin decay; два spool ODE одновременно запрещены.
- **Evidence:** Владелец Codex; baseline 8f7dc19; 2026-10-16. `native/bet/tests/motor.rs` (2 PASS), `tests/motor-config.test.ts` и тесты паритета scalar/SIMD WASM проверяют инерционность заполнения ШИМ, насыщение тока обмотки, баланс мощности шины/механики/потерь в меди, отключение питания без обнуления скорости вала и 0 аллокаций за 1e6 шагов.

### TASK-026 — Battery sag

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Рассчитывать SOC, bus voltage и доступную мощность для набора моторов.
- **Dependencies:** TASK-025.
- **Touched Files:** `native/bet/src/battery.rs`, `native/bet/tests/battery.rs`, `tests/fixtures/power/battery.json`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** V=Voc-I*R, SOC, power-limited flags.
- **DoD & Acceptance Criteria:** Analytic resistive cases, R→0, depleted SOC и недостижимый P не дают NaN; энергия/знаки тока согласованы; нагрузка всех motors учтена один раз.
- **Evidence:** Владелец Codex; baseline 8f7dc19; 2026-10-16. `native/bet/tests/battery.rs` (2 PASS) и проверки квадратичного корня scalar/SIMD против синтетической фикстуры `tests/fixtures/power/battery.json` подтверждают общий учёт нагрузки, пределы `R = 0`/`1e-20`, ограничение тока/мощности, полный разряд и 0 аллокаций за 1e6 шагов.

### TASK-027 — Произвольная рама и wrench

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Суммировать thrust vectors, torque arms и transmitted rotor moments.
- **Dependencies:** TASK-006, TASK-023, TASK-025, TASK-026.
- **Touched Files:** `native/bet/src/frame.rs`, `packages/physics/src/frame.ts`, `native/bet/tests/frame.rs`, `tests/fixtures/models/tilted-octo.json`, `native/bet/src/lib.rs`, `native/bet/src/math.rs`, `tests/frame.test.ts`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** F=sum R*F; M=sum(r×R*F+R*Mhub); stable motor IDs.
- **DoD & Acceptance Criteria:** Quad/hexa/tilted octo fixtures, symmetry/yaw cancellation и handedness; tilted axes создают lateral force; запрещён double-count motor reaction.
- **Evidence:** Владелец Codex; baseline 8f7dc19; 2026-10-16. `native/bet/tests/frame.rs` (2 PASS), `tests/frame.test.ts` (2 PASS) и проверки scalar/SIMD против `tests/fixtures/models/tilted-octo.json` подтверждают взаимную компенсацию моментов симметричных quad/hexa/octo, боковую силу `4*sqrt(2)` Н при наклоне осей, правые преобразования координат без двойного учёта реакции и 0 аллокаций за 1e6 шагов.

### TASK-028 — Rigid-body integrator

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Интегрировать BET wrench с mass/inertia, quaternion и NED gravity.
- **Dependencies:** TASK-027.
- **Touched Files:** `native/bet/src/rigid_body.rs`, `packages/wasm-bet/src/backend.ts`, `native/bet/tests/rigid_body.rs`, `native/bet/src/lib.rs`, `native/bet/src/body_abi.rs`, `native/bet/tests/body_abi.rs`, `tests/rigid-body.test.ts`, `packages/wasm-bet/package.json`, `tests/fixtures/abi/body-v1.json`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `tests/browser/native-bootstrap.spec.ts`, `scripts/bench-sensors.mjs`.
- **Interfaces / Contracts:** DynamicsBackend, TruthOutput, один owner integration.
- **DoD & Acceptance Criteria:** Ballistic/torque-free/constant torque cases; quaternion norm error<1e-10 native; finite trajectory; 400/800/1200 convergence against offline 4800 Hz reference.
- **Evidence:** Владелец Codex; baseline 8f7dc19; 2026-10-16. `native/bet/tests/rigid_body.rs` (3 PASS), `native/bet/tests/body_abi.rs` (1 PASS) и `tests/rigid-body.test.ts` проверяют аналитические решения баллистики и постоянного момента, ошибку нормы кватерниона `<1e-10`, сходимость свободного вращения 400/800/1200 Гц к эталону 4800 Гц и body ABI v1 256/128 байт (`tests/fixtures/abi/body-v1.json`). `node scripts/bench-sensors.mjs body` (`test-results/bench/sensors-body.json`) проходит шесть окон `1e6`/`2e6` с 0 GC и 0 аллокаций WASM.

### TASK-029 — Контакт шасси

- **Status:** DONE — Codex; baseline 316152d; 2026-10-18. Прямой f64 C ABI Rapier, настраиваемая податливая топология колесо/стойка/шина/упор, единственный владелец интегрирования и гейты аллокаций G1 в native/WASM/браузерном Worker проверены. Измеренная достоверность сброса NASA явно отложена пользователем; архивное непрошедшее сравнение с жёсткой сферой сохранено.
- **Title & Description:** Подключить один выбранный contact solver и согласовать impulses.
- **Dependencies:** TASK-028.
- **Touched Files:** `packages/physics/src/contact-backend.ts`, `packages/physics/src/ground-contact.ts`, `tests/contact.test.ts`, `tests/fixtures/contact/drop.json`, `package-lock.json`, `packages/physics/package.json`, `tests/contact-allocation.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `packages/physics/src/contact-engine.ts`, `scripts/bench-contact.mjs`, `native/rapier/allocation_probe.rs`, `native/rapier/source.lock.json`, `native/rapier/Cargo.lock`, `scripts/check-contact-native.mjs`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `native/rapier/patches/reuse-step-buffers.patch`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`, `tests/fixtures/contact/nasa-drop.json`, `tests/fixtures/contact/generate_nasa_drop.py`, `tests/fixtures/contact/nasa/nasa-tm-x-3561.md`, `tests/fixtures/contact/nasa/nasa-tp-2353.md`, `tests/fixtures/contact/nasa/naca-report-1248.md`, `.gitattributes`, `packages/physics/src/nasa-drop.ts`, `packages/test-support/src/fixtures.ts`, `tests/fixtures.test.ts`, `scripts/check-docs.mjs`, `README.md`, `docs/ru/README.md`.
- **Interfaces / Contracts:** ContactImpulse {pointBody,impulseNed,dt}; Rapier или Jolt, выбор зафиксирован ADR.
- **DoD & Acceptance Criteria:** Drop/roll/friction/no-penetration fixtures; restitution не добавляет энергии сверх заданного; rigid body не интегрируется вторым solver одновременно; alloc budget G1.
- **Evidence:** Владелец Codex; baseline 316152d; 2026-10-18. Прямой `f64` C ABI Rapier 0.36.0 (`native/contact/`, сборка через `node scripts/build-contact.mjs` с патчем повторного использования буферов `native/rapier/patches/reuse-step-buffers.patch`) и податливые ядра линейной/газо-дроссельной стойки, нелинейной шины, упоров хода и обода (`native/bet/src/landing_gear.rs`, `tests/landing-gear.test.ts`, `tests/contact-binding.test.ts`). `node scripts/check-contact-binding.mjs` (`test-results/validation/task-029-binding.json`) проходит 9 000 000 нативных шагов, а `tests/contact-allocation.test.ts` — 9 000 000 шагов WASM на 400/800/1200 Гц с 0/3/8 колёсами при 0 вызовов/байт аллокатора и точном совпадении позиции (максимальная разница ориентации `2.98e-8` рад). `node scripts/bench-contact.mjs` (`test-results/bench/contact.json`) проходит три окна по 1e6 шагов с 0 GC и `<0.004` Б/шаг; `tests/browser/contact.spec.ts` проходит 1e6 шагов в Chromium Worker. Итоговые отчёты: `test-results/validation/task-029-completion.json`, `test-results/validation/task-029-compliance.json`, `test-results/bench/contact-native-patched.json`. Архивные фикстуры NASA TM X-3561 / TP-2353 / NACA 1248 (`tests/fixtures/contact/nasa-drop.json`, `test-results/validation/nasa-drop-legacy.json`) сохранены вместе с непрошедшим сравнением жёсткой сферы согласно решению пользователя об отсрочке. Не сертифицирует калибровку самолёта, раскрутку колёс/антиюз/руление, тайминги целевых устройств и полное подключение к полётной сессии BET/JSBSim.

### TASK-030 — Pinned JSBSim WASM artifact

- **Status:** DONE — Codex; baseline 18317f8; 2026-10-18. Закреплённый локальный WASM-артефакт, проверка воспроизводимости и smoke-тест в реальном браузерном Worker пройдены.
- **Title & Description:** Собрать JSBSim через Emscripten с reproducible source/toolchain manifest.
- **Dependencies:** TASK-003, TASK-004, TASK-006.
- **Touched Files:** `native/jsbsim/CMakeLists.txt`, `native/jsbsim/source.lock.json`, `native/jsbsim/toolchain.lock.json`, `scripts/build-jsbsim.mjs`, `packages/wasm-jsbsim/package.json`, `tests/jsbsim-artifact.test.ts`, `native/jsbsim/bridge.cpp`, `native/jsbsim/property-map.json`, `package-lock.json`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `scripts/check-jsbsim-native.mjs`, `native/jsbsim/native_checks.cpp`, `native/jsbsim/patches/reuse-history-and-property-paths.patch`.
- **Interfaces / Contracts:** WASM C ABI version/hash и лицензии JSBSim/model data.
- **DoD & Acceptance Criteria:** Build из pinned SHA, проверенные checksums; native reference и WASM одного source; unit conversions не патчат сторонний код; artifact smoke в worker.
- **Evidence:** Владелец Codex; baseline 18317f8; 2026-10-18. Закреплены JSBSim v1.2.3 (`570e8115a102df8f877b11e0e59b964ea483e3c0`) и Emscripten 4.0.15 (`389a68bc35dcff7ebae4614e1615099dafda00d1`) с `SOURCE_DATE_EPOCH=1749297861`. `node scripts/build-jsbsim.mjs` создаёт побайтово идентичные сборки в независимых каталогах; `node scripts/check-jsbsim-artifact.mjs` (`test-results/validation/jsbsim-artifact.json`) проходит smoke-тест в Chromium Worker на 400/800/1200 Гц (22 конечных выхода СИ, ошибка времени/нормы кватерниона `<=1e-10`, стабильная память 64 МиБ); `tests/jsbsim-artifact.test.ts` проходит. XML моделей самолётов остаются локальным тестовым входом, исключённым из упакованных артефактов до проверки лицензии распространения.

### TASK-031 — JSBSim DynamicsBackend

- **Status:** DONE — Codex; baseline 2ede92f; 2026-10-18. Паритет балансировки, управления и контакта с одним владельцем в native/WASM, проверки стационарной удельной силы и гейты аллокаций C++/WASM/JS пройдены для локального эталона c172x. XML модели не включён в пакет; измеренная калибровка и полная готовность полётной сессии остаются отдельными.
- **Title & Description:** Адаптировать JSBSim state, actuator и contact exchange.
- **Dependencies:** TASK-018, TASK-029, TASK-030, TASK-032.
- **Touched Files:** `native/jsbsim/bridge.cpp`, `packages/wasm-jsbsim/src/backend.ts`, `tests/jsbsim-backend.test.ts`, `tests/fixtures/airframes/jsbsim-trim.json`, `native/jsbsim/property-map.json`, `packages/wasm-jsbsim/package.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `native/jsbsim/native_checks.cpp`, `scripts/check-jsbsim-native.mjs`, `tests/jsbsim-native.test.ts`, `native/jsbsim/patches/reuse-history-and-property-paths.patch`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`.
- **Interfaces / Contracts:** DynamicsBackend; ft/slugs↔SI; FRD/NED, JSBSim integration ownership.
- **DoD & Acceptance Criteria:** Trim/step-control native vs WASM fixtures в manifest tolerance; stationary specific force/signs верны; согласованный contact impulse; 0 alloc/grow на шаге.
- **Evidence:** Владелец Codex; baseline 2ede92f; 2026-10-18. Добавочный контактный ABI v1 (`node scripts/build-jsbsim.mjs --contact`, нативные исключения WASM, патчи `native/jsbsim/patches/reuse-history-and-property-paths.patch` и `contact-impulse.patch`; JS 83 070 Б, WASM 1 696 214 Б). `node scripts/check-jsbsim-backend.mjs --native` (`test-results/validation/task-031-native.json`) и `node --experimental-transform-types scripts/check-jsbsim-backend.mjs` (`test-results/validation/task-031-backend.json`) проходят 9 случаев балансировки/управления/контакта и 3 стационарных случая на 12 000 000 горячих шагах при 400/800/1200 Гц с 0 аллокаций C++/WASM, точным совпадением позиции за 10 с, максимальной разницей ориентации `2.98e-8` рад, разницей скорости `<7e-14` м/с, ошибкой импульса `<9e-11` Н·с и направленной вверх стационарной удельной силой `~9.78` м/с². `node scripts/bench-jsbsim.mjs` (`test-results/bench/jsbsim-400.json`; отказ устаревшей сборки с JS-исключениями сохранён в `test-results/bench/jsbsim-400-legacy-exceptions.json`) проходит три окна по 1e6 шагов с 0 GC и `<0.004` Б/шаг. Сводка: `test-results/validation/task-031-completion.json`. Распространение XML моделей, измеренная достоверность самолёта, подключение к полётной сессии и `READY` автопилота остаются отдельными.

### TASK-032 — Атмосфера и ветер

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Реализовать единый atmospheric state и детерминированный gust input.
- **Dependencies:** TASK-004, TASK-006, TASK-010.
- **Touched Files:** `CLAUDE.md`, `docs/ru/CLAUDE.md`, `README.md`, `docs/ru/README.md`, `packages/physics/src/atmosphere.ts`, `packages/physics/src/wind.ts`, `tests/atmosphere.test.ts`, `packages/physics/package.json`, `package-lock.json`, `scripts/bench-wind.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Temperature/pressure→density/viscosity/speed of sound; seeded gust bandwidth.
- **DoD & Acceptance Criteria:** ISA reference points, calm/gust/reset/replay fixtures; единицы согласованы JSBSim/BET; fixed seed не зависит от render FPS; near-zero density отклонена schema.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. `tests/atmosphere.test.ts`: 4 PASS (ISA на уровне моря и 11 км, строгая схема состояния, штиль/сброс/независимое от FPS воспроизведение, стационарная дисперсия/полюс на 2e6 отсчётах). `node scripts/bench-wind.mjs` (`test-results/bench/wind.json`): код 0, seed 123, 400 Гц, шесть прогретых окон `1e6`/`2e6` с 0 GC и приращением `0.000128` Б/шаг.

### TASK-033 — Model validation gate

- **Доказательства завершения (2026-10-20):** DONE для выбранной оператором программной базы конфигурируемой синтетической геометрии/NeuralFoil; исполнитель Codex; база d56c890. Более ранние записи продолжения ниже сохраняются как история; это завершение заменяет их утверждения об отсутствующей привязке. Три геометрии роторов/два профиля NeuralFoil проходят 72 независимых численных случая равномерного/кольцевого потока; 61 сохраняет флаги фильтрации. Производственный bound ABI и конфигурируемый backend роторов/корпуса проходят 18 сравнений по десять секунд scalar/SIMD на 400/800/1200 Гц против 4800 Гц (4/6/8 роторов); максимальная ошибка позиции 0.003529693668440359 м, ориентации 0 рад, ниже неизменных пределов 0.1 м / 0.5 градуса. `node scripts/check-bet-runtime.mjs`: код 0. `node scripts/check-bet-runtime.mjs --allocation`: код 0; счётчик native-bound цикла на 1,000,000 шагов показывает ноль вызовов/байтов и обнаруживает положительный контроль; scalar/SIMD-проверки активного ротора NeuralFoil и проверка неподвижного корпуса с четырьмя роторами при нулевой гравитации выполняют по 1,000,000 шагов с нулём GC, стабильной памятью WASM и 0.003104–0.003248 добавочного Б/шаг; аллоцирующий контроль обнаруживается. Отчёты: `test-results/validation/bet-runtime.json`, `test-results/validation/bet-runtime-allocation.json` (все исходники native-крейта, входы runtime, тест и хеши пакетов/артефактов).
- **Проверка:** Windows 11 x64, Node 24.19.0, закреплённый rustc 1.97.0, Python 3.12 и Chromium 141.0.7390.37 (Playwright revision 1194). `cargo test --workspace --locked` в `native/`: 66 PASS. `node node_modules/vitest/vitest.mjs run`: 550 PASS / 99 файлов, один прежний пропуск необязательного артефакта ArduCopter; loopback/junction-тестам нужен запуск вне ограниченной песочницы. Полная регрессия предшествует окончательным экспортам пакетов/нормализации LF; заключительные целевые проверки охватывают экспорты, отчёт и контракты байтов/документации. Девятнадцать тестов Python и точное воспроизведение обоих наборов NeuralFoil проходят. Шесть Chromium-проверок (выбранный BET SAB Worker, production-bootstrap и четыре прежних сценария симуляции), строгий TypeScript, ESLint, производственная сборка Vite и двуязычная документация проходят. Сборка сохраняет прежнее предупреждение о размере bundle. Точные JUnit-данные: `test-results/validation/task-033-unit.xml`, `test-results/validation/task-033-focused.xml`, `test-results/validation/task-033-final.xml`, `test-results/browser/junit.xml`.
- **Граница приёмки:** Схема model-report v8 отделяет численный/runtime PASS от неподтверждённой измерениями точности синтетики. `node scripts/validate-models.mjs` намеренно возвращает код 2: историческая точность UIUC не проходит, измеренная точность NASA остаётся deferred/blocked. Допуски и проваленные измерения не переименовываются. Публичные API доступны через фабрику динамики сессии; Worker приложения по умолчанию использует DemoDynamics. Реализация ограничена жёсткими роторами без махового движения в свободном полёте, явными входами момента/микшера/атмосферы и сохраняемыми флагами достоверности/применимости. Измеренная сертификация планера, сопряжение батареи/контакта, реальное время на целевом устройстве и READY браузерного автопилота вне выбранной области завершения и остаются недопущенными.


- **Область завершения runtime (2026-10-20):** DONE; исполнитель Codex; база d56c890 и сохранённая локальная работа. Завершить производственную версионированную привязку поляр/роторов и конфигурируемый BET в полётной сессии с выбранной оператором синтетической геометрией/NeuralFoil. Дополнительные файлы: `native/bet/src/bound.rs`, `native/bet/src/polar.rs`, `native/bet/src/lib.rs`, `native/bet/include/bet_bound.h`, `native/bet/tests/bound.rs`, `native/bet/tests/polar.rs`, `native/bet/tests/allocation.rs`, `packages/wasm-bet/src/rotor.ts`, `packages/physics/src/bet-dynamics.ts`, `packages/physics/src/session-v2.ts`, `tests/bet-runtime.test.ts`, `tests/browser/bet-runtime.spec.ts`, `tests/browser/bet-worker.ts`, `tests/browser/native-bootstrap.spec.ts`, `scripts/check-bet-runtime.mjs`, существующие валидатор/отчёт/схема, архитектура/спецификация/базовые инструкции агента и русские зеркала. Прежний ABI роторов v1 сохраняет отказы. Новый дополнительный bound ABI v1 использует проверенную неизменную конфигурацию и состояние вызывающей стороны; проверяет указатели/перекрытия/версии/dt/стабильность памяти, не делает частичных записей при ошибках, передаёт флаги низкой достоверности/выхода за поляру/применимости потока. Шаг сопрягает ядра вала/потока и передачу углового момента; роторы явно жёсткие, без махового движения. G1 требует ноль вызовов/байтов аллокатора и отсутствие роста WASM на миллионе шагов; G2 — независимые нагрузки, scalar/SIMD и сходимость 400/800/1200 к 4800 Гц. ID модели и число роторов поступают от выбранного backend; demo по умолчанию совместим. Измеренная точность отделена от завершения синтетической программной валидации. READY браузерного автопилота не включается.
- **Поддержка runtime-тестов:** `tests/bet-runtime-fixture.ts` задаёт многократно используемые синтетические модели для Node/браузера/runtime; `native/bet/tests/support/bound_fixture.rs` строит байтовую фикстуру для native-проверок корректности/аллокаций. Это явные тестовые данные, не калиброванные значения реального аппарата.
- **Поддержка регрессий:** `tests/layout-v2.test.ts` и `tests/protocol-golden.test.ts` теперь ссылаются на текущие заголовки спецификации после обновления базы; значения ABI и проверки не меняются.
- **Публичный API и воспроизводимость:** Манифесты пакетов экспортируют `@mirage/physics/bet-dynamics` и `@mirage/wasm-bet/rotor`; runtime-тесты используют эти экспорты. Идентичность доказательств runtime охватывает все исходники native-крейта, аллокационный тест/фикстуру и манифесты пакетов. Тесты model-report допускают явный blocked для отсутствующих доказательств в свежей копии, требуя обе диагностики pass перед runtime PASS. Текст исходников использует байты LF согласно контракту репозитория для межплатформенной стабильности хешей.


Конфигурируемое продолжение (2026-10-20): DONE (приращение синтетических конфигураций); исполнитель Codex; база d56c890 и существующая локальная работа. Оператор разрешил синтетическую геометрию и множество конфигураций вместо одного калиброванного ротора. Генерация NeuralFoil обобщена на четырёхзначные NACA, проверка BET — на версионированные синтетические определения с независимым выбором поляры, числа лопастей, радиуса/корня, распределений хорды/крутки, квадратуры и рабочих точек. Дополнительная область: `scripts/check-rotor-bet.py` (прежний CLI сохранён как обёртка), `tests/fixtures/rotors/synthetic-bet-suite.json`, `tests/fixtures/polars/naca0012-neuralfoil.json`, генератор/реестр/тесты, отчёт/схема модели (v7), архитектура/спецификация/дорожная карта и русские зеркала. Прежние допуски и проверки достоверности/применимости каждой конфигурации сохранены. Синтетической геометрии достаточно для реализации и численной проверки; измеренная точность — отдельная категория доказательств, не предварительное условие этого продолжения.

Доказательства конфигураций: три независимых синтетических ротора и два профиля NeuralFoil выполняют 72 численных случая, все PASS. Максимальная ошибка независимых CT/CP: 4.996003610813204e-16; максимальная кольцевая невязка: 9.587418512725526e-11. Фильтрация неизменна: базовый 0/24, суженный трёхлопастной 2/24, симметричный четырёхлопастной 9/24 без флагов (всего 11 без флагов, 61 с флагами). Генераторы NACA6409 и NACA0012 воспроизводятся побайтно. SHA-256 фикстуры NACA0012: b65b811583008327d517505e2995ed2bd1ee9fa66cad207288bf0a436a01dab1. Отчёты: `test-results/validation/rotor-bet.json` (схема v2), model-report v7. Проходят 19 тестов Python, 15 целевых Vitest плюс проверка хешей зарегистрированных фикстур, TypeScript, ESLint и производственная сборка; сохраняются предупреждения bundle/linker/hardlink. Проверяются масштабирование радиуса (сила R^4, мощность R^5 при постоянных RPM, коэффициентах и геометрически масштабированном состоянии), влияние числа лопастей, сужение/крутка, идентичность профиля, симметричный профиль и отклонение некорректных входов. Синтетический набор — база разработки; измерения конкретного ротора не нужны для продолжения реализации. Измеренная точность, проваленные исторические проверки UIUC и производственная интеграция сессии BET учитываются отдельно.

Продолжение BET NACA6409: DONE (только численная интеграция); исполнитель Codex; база d56c890 и сохранённый локальный набор NACA6409. Проверенная по хешу таблица NeuralFoil подана существующим native-решателям равномерного/кольцевого BET с явно синтетическим ротором. Независимый Python-эталон сил/импульса, консервативная проверка достоверности конечных сечений и раздел суррогата схемы v6 добавлены в отчёт. Дополнительная область: `scripts/check-naca6409-bet.py`, `tests/test_naca6409_bet.py`, `scripts/validate-models.mjs`, `tests/model-validation.test.ts`, `docs/validation/model-report.schema.json`, `docs/architecture.md` и русское зеркало. Заранее объявленные допуски коэффициентов: 1e-9 абсолютный и 1e-8 относительный; невязка импульса <=1e-9 масштаба силы; достоверность >=0.9; явное несжимаемое приближение ограничено Mach<=0.3 без создания данных сжимаемости. Ошибка коэффициентов/эталона, некорректный native-вывод, несходимость, устаревшие входы, потеря флагов или выдача суррогата за измерения означают отказ. Производственная привязка ABI остаётся отдельным приращением.

Доказательства BET NACA6409 (2026-10-20): Windows 11; Python 3.12; rustc 1.97.0. Выполнены 24 случая (12 равномерных, 12 кольцевых). Максимальная ошибка независимых CT/CP равна 1.1102230246251565e-16; максимальная относительная кольцевая невязка 9.455382564231208e-11. Численные проверки PASS; 23 случая имеют ячейки низкой достоверности, шесть — native-флаги поляры/границы Mach; ни один не проходит все фильтры. Эти пересекающиеся количества не превращаются в измеренный PASS. Отчёт: `test-results/validation/naca6409-bet.json`; схема model-report v6 отделяет численный PASS от неподтверждённой точности суррогата и сохраняет провал UIUC (CLI: код 2). Проходят 12 тестов Python, 15 целевых Vitest (включая отклонение v5, обязательные данные суррогата и запрет его переименования в измеренный допуск), 62 native-теста, точное воспроизведение генератора, TypeScript, ESLint и производственная сборка; сохраняются предупреждения bundle/linker/hardlink. Спецификации, архитектура и дорожная карта EN/RU синхронизированы; идентичность исходников/исполняемого файла/поляры в отчётах. Браузерный/runtime ABI не изменён; измеренный допуск и READY не заявлены. TASK-033 в целом остаётся BLOCKED_EXTERNAL.

- **Status:** DONE — Codex; база d56c890; 2026-10-20. Конфигурируемая синтетическая геометрия/NeuralFoil: реализация и программная валидация завершены. Измеренная точность отдельно failed/blocked; режимы обучения и автопилота не допускаются.
- **Title & Description:** Выполнить общий numerical/reference gate и сформировать отчёт достоверности моделей.
- **Dependencies:** TASK-014, TASK-024, TASK-028, TASK-029, TASK-031.
- **Touched Files:** `scripts/validate-models.mjs`, `tests/model-validation.test.ts`, `docs/validation/model-report.schema.json`, `tests/fixtures/validation/reference-manifest.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`, `packages/physics/src/nasa-drop.ts`, `packages/physics/src/ground-contact.ts`, `tests/fixtures/contact/nasa-drop.json`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `native/bet/src/propeller.rs`, `native/bet/src/lib.rs`, `native/bet/tests/propeller.rs`, `tests/documentation-policy.test.ts`, `native/bet/examples/propeller_points.rs`, `packages/physics/src/uiuc-propeller.ts`, `tests/uiuc-propeller.test.ts`, `tests/fixtures.test.ts`, `tests/fixtures/rotors/uiuc-propellers.json`, `tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py`, `tests/fixtures/rotors/uiuc/sda1075.dat`, `data/uiuc-propdb/inventory.json`, `docs/operations/uiuc-propdb-data.md`, `docs/ru/uiuc-propdb-data.md`, `docs/documentation-index.json`, `test-results/validation/model-report.json`, `tests/fixtures/polars/generate_sda1075_xfoil.py`, `tests/fixtures/polars/sda1075-xfoil.json`.
- **Interfaces / Contracts:** ValidityEnvelope; numerical parity отдельно от experimental validity.
- **DoD & Acceptance Criteria:** Smooth 10 s cases: <=0.1 m/0.5° against 4800 Hz; scalar/SIMD force/moment tolerance §4; provenance каждого эталона; отсутствие экспериментальных данных даёт BLOCKED_EXTERNAL для fidelity, не fake PASS.
- **Evidence:** Владелец Codex/Claude; проверено 2026-10-18. `node scripts/validate-models.mjs` завершается с кодом 2 и записывает отчёт схемы v5 `test-results/validation/model-report.json`: 12 численных случаев (400/800/1200 Гц против 4800 Гц) PASS в пределах `0.1` м / `0.5` град (максимальная ошибка позиции `1.624e-10` м); диагностика контакта G1 `TASK-029` и бэкенда/G1 JSBSim `TASK-031` PASS; архивное сравнение сброса NASA TM X-3561 (`tests/fixtures/contact/nasa-drop.json`, `test-results/validation/nasa-drop-legacy.json`) записано как `blocked` (отложено решением пользователя, непрошедшее сравнение замедления/хода жёсткой сферы сохранено); сравнения с базой пропеллеров UIUC DA4002/DA4022 (`data/uiuc-propdb/inventory.json`, [руководство по данным UIUC](uiuc-propdb-data.md), `tests/fixtures/rotors/uiuc-propellers.json`, `tests/fixtures/polars/sda1075-xfoil.json`, `test-results/validation/propeller-points.json`, `test-results/validation/propeller-bem.json`, `test-results/validation/propeller-source-review.json`, `test-results/validation/task-033-continuation.json`, `test-results/validation/task-033-handoff-review.json`) сообщают `failed` относительно фиксированных допусков CT/CP (`0/534` тонкий профиль, `26/165` MIT XFOIL 6.99 с равномерным потоком и `48/193` кольцевой BEM с концевыми/корневыми потерями и закруткой при 690 точках вне поляры и 75 вне применимости импульсной теории). Остающиеся внешние блокеры: измеренные поляры SDA1075 при малых Re, измеренные наборы данных полного планера/ротора, решение о лицензии архива UIUC и рабочая привязка C ABI BET.

### TASK-086 — Таблицы пропеллеров JSBSim из данных UIUC

- **Status:** DONE — Claude; baseline 324d15e; 2026-10-18. Таблицы сгенерированы и проверены; нативная загрузка и проверка тяги в закреплённом JSBSim v1.2.3 проходят (18/18 точек).
- **Title & Description:** Сгенерировать определения пропеллеров фиксированного шага JSBSim (C_THRUST/C_POWER в зависимости от J) из проверенной по хешу базы данных пропеллеров UIUC для будущих моделей самолётов.
- **Dependencies:** TASK-030, TASK-033.
- **Touched Files:** `data/jsbsim/generate_uiuc_propellers.py`, `data/jsbsim/engine/uiuc_apce_10x5.xml`, `data/jsbsim/engine/uiuc_apce_10x7.xml`, `data/jsbsim/engine/uiuc_apce_11x7.xml`, `data/jsbsim/engine/uiuc_apce_12x6.xml`, `data/jsbsim/engine/uiuc_apce_14x10.xml`, `data/jsbsim/engine/uiuc_da4002_9x6p75.xml`, `data/jsbsim/engine/uiuc-propellers.manifest.json`, `tests/jsbsim-propellers.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/operations/uiuc-propdb-data.md`, `docs/ru/uiuc-propdb-data.md`, `native/jsbsim/propeller_probe.cpp`, `native/jsbsim/propeller/CMakeLists.txt`, `scripts/check-jsbsim-propellers.mjs`, `CLAUDE.md`, `docs/ru/CLAUDE.md`.
- **Interfaces / Contracts:** XML пропеллера JSBSim, `<table name="C_THRUST|C_POWER" type="internal">` в зависимости от J = V/(nD), в том же соглашении коэффициентов, что и UIUC; манифест `uiuc-propellers.manifest.json` с SHA-256 и источниками каждого файла.
- **DoD & Acceptance Criteria:** Строки копируются точно как напечатаны по объявленному правилу выбора RPM; побайтный `--check`; каждый источник прослеживается до инвентаря; загрузка в нативный JSBSim v1.2.3 и проверка статической тяги и тяги при поступательном движении против измеренного CT в пределах 1%.
- **Evidence:** Владелец Claude; baseline 324d15e; 2026-10-18. `data/jsbsim/generate_uiuc_propellers.py --check` проверяет шесть XML-определений фиксированного шага (APC Thin Electric `10x5`, `10x7`, `11x7`, `12x6`, `14x10` и `DA4002 9x6.75`) и `data/jsbsim/engine/uiuc-propellers.manifest.json`. `JSBSIM_SOURCE_DIR=<checkout> node scripts/check-jsbsim-propellers.mjs` (`test-results/validation/jsbsim-propellers.json`) загружает все шесть файлов через `FGFDMExec::LoadModel` в закреплённом JSBSim v1.2.3 (`570e8115a102df8f877b11e0e59b964ea483e3c0`) и проходит 18/18 статических, средних и интерполированных точек тяги/мощности с относительной точностью `4.1e-16` от измеренных CT/CP (допуск 1%). `tests/jsbsim-propellers.test.ts`: 4 PASS. Ограничения вне DoD: полётные модели должны задавать момент инерции `<ixx>`, проверка лицензии распространения UIUC распространяется на производные таблицы, а истинные диаметры тома 4 относительно номинальных остаются непроверенными.

## Phase 3: ArduPilot & Radio Link

### TASK-034 — Ideal sensors

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Преобразовать truth в IMU/mag/baro/airspeed без noise и EW.
- **Dependencies:** TASK-013, TASK-028, TASK-032.
- **Touched Files:** `packages/sensors/package.json`, `packages/sensors/src/ideal.ts`, `tests/ideal-sensors.test.ts`, `package-lock.json`, `tests/fixtures/sensors/ideal.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** GpsSample/ImuSample; acceleration vs specific force; gauss/Pa internal units.
- **DoD & Acceptance Criteria:** Stationary/free-fall/rotated-body fixtures; gyro и mag body frames; pressure signs verified; outputs in-place, G1.
- **Evidence:** Владелец Codex; baseline 8f7dc19; 2026-10-16. `tests/ideal-sensors.test.ts` (2 PASS против `tests/fixtures/sensors/ideal.json`) проверяет удельную силу в покое/свободном падении/перевёрнутом положении, магнитный вектор в гауссах при повороте корпуса, знак давления ISA Па/Down и скоростной напор. `node scripts/bench-sensors.mjs ideal` (`test-results/bench/sensors-ideal.json`) проходит шесть окон `1e6`/`2e6` с 0 GC и 0 добавочных Б/шаг.

### TASK-035 — Частоты/шум/bias сенсоров

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Добавить rational sampling, bounded latency и seeded noise streams.
- **Dependencies:** TASK-004, TASK-011, TASK-034.
- **Touched Files:** `packages/sensors/src/scheduler.ts`, `packages/sensors/src/noise.ts`, `packages/sensors/src/latency.ts`, `tests/sensor-scheduler.test.ts`, `tests/sensor-noise.test.ts`, `scripts/bench-sensors.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** IMU 200/400, GPS 5/10 Hz; PSD/bandwidth; sensor frame time.
- **DoD & Acceptance Criteria:** За 60 sim s точные counts всех частот на 400/800/1200; seed repeatable; noise statistics в заданном confidence interval; latency queue bounded и monotonic.
- **Evidence:** Владелец Codex; baseline 8f7dc19; 2026-10-16. `tests/sensor-scheduler.test.ts` (2 PASS) и `tests/sensor-noise.test.ts` (2 PASS) проверяют точное число отсчётов за 60 с при 400/800/1200 Гц для датчиков 5/10/200/400 Гц, ограниченную монотонную очередь задержки FIFO и гауссовскую дисперсию/блуждание смещения на 1e6 отсчётах. `node scripts/bench-sensors.mjs all` (`test-results/bench/sensors-all.json`) проходит шесть окон `1e6`/`2e6` после 4e6 тиков прогрева с 0 GC и 0 добавочных Б/шаг.

### TASK-036 — WGS84 и MSL

- **Status:** DONE — Claude; baseline 346866c; 2026-10-16 (гейт абсолютной точности MSL — BLOCKED_EXTERNAL до установки авторитетной сетки геоида).
- **Title & Description:** Добавить origin/ECEF/NED/geoid преобразования с float64.
- **Dependencies:** TASK-004, TASK-006.
- **Touched Files:** `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `tests/geodesy.test.ts`, `tests/fixtures/geodesy/wgs84.json`, `tests/fixtures/geodesy/generate.py`, `tests/fixtures/registry.json`, `packages/sensors/package.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** WGS84 h vs MSL H; authoritative geoid dataset/hash/licence.
- **DoD & Acceptance Criteria:** Roundtrip<=1 mm для локальных synthetic cases; antimeridian/poles и 15 km offsets; нет cos(lat) singularity; dataset absent явно blocks absolute MSL accuracy gate.
- **Evidence:** Владелец Claude; baseline 346866c; 2026-10-16. `tests/geodesy.test.ts` (8 PASS против `tests/fixtures/geodesy/wgs84.json`) проверяет прямое и обратное (по Боурингу) преобразования WGS84 и касательной системы координат с точностью `1` мм через оба полюса, антимеридиан и смещения 15 км, а также билинейную интерполяцию синтетического геоида `H = h - N`. Остающееся ограничение: авторитетная сетка геоида (источник EGM96/EGM2008, лицензия, SHA-256) не установлена, поэтому абсолютная точность MSL остаётся `BLOCKED_EXTERNAL`.

### TASK-037 — MAVLink2 codec

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Зафиксировать dialect/generator и реализовать binary parser/encoder.
- **Dependencies:** TASK-003, TASK-004, TASK-013.
- **Touched Files:** `packages/mavlink/package.json`, `packages/mavlink/dialect.lock.json`, `packages/mavlink/src/codec.ts`, `packages/mavlink/src/sensor-mapping.ts`, `tests/mavlink.test.ts`, `tests/fixtures/mavlink/golden.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `packages/mavlink/src/messages.ts`, `packages/mavlink/src/samples.ts`, `scripts/generate-mavlink-fixtures.py`, `tests/fixtures/registry.json`, `package-lock.json`, `scripts/bench-links-ew.mjs`, `tests/sensor-samples.ts`, `tests/links-ew-allocation.test.ts`, `packages/mavlink/NOTICE`.
- **Interfaces / Contracts:** HIL_GPS/HIL_SENSOR/HIL_ACTUATOR_CONTROLS/RC_CHANNELS_OVERRIDE; §6 engines spec.
- **DoD & Acceptance Criteria:** Official-generated golden frames совпадают по CRC_EXTRA/packing; arbitrary chunks/truncation/bad CRC/seq tested; DOP×100, gauss/hPa/LSB и uint64 tests; no unsafe any.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/mavlink.test.ts` (5 PASS) проверяет побайтовое совпадение с кадрами официального `pymavlink` 2.4.50 (`tests/fixtures/mavlink/golden.json`, `packages/mavlink/dialect.lock.json`), разбор произвольных фрагментов, отклонение неверного CRC/подписи и переполнение sequence. `node scripts/bench-links-ew.mjs all 400|800|1200` (`test-results/bench/links-ew-all-400.json`..`1200.json`) проходит с 0 GC. Подписанный MAVLink и неперечисленные ID сообщений не поддерживаются.

### TASK-038 — RC и flight mode mapping

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Расширить USB input режимами и правильно формировать RC override.
- **Dependencies:** TASK-010, TASK-037.
- **Touched Files:** `packages/input/src/mode-channel.ts`, `packages/input/src/calibration-store.ts`, `packages/mavlink/src/rc-override.ts`, `apps/web/src/App.tsx`, `tests/rc-override.test.ts`, `tests/browser/radio.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/runtime.ts`, `packages/input/package.json`, `packages/input/src/index.ts`, `tests/fixtures/registry.json`, `apps/web/package.json`, `package-lock.json`, `scripts/bench-links-ew.mjs`, `tests/links-ew-allocation.test.ts`, `docs/hardware/radio-checklist.md`, `docs/ru/radio-checklist.md`, `docs/documentation-index.json`.
- **Interfaces / Contracts:** Pilot mailbox v2; RC profile endpoints/deadzone/mode slots; channels 1..8 vs 9..18 sentinel semantics.
- **DoD & Acceptance Criteria:** Calibration сохраняется с schema/version; invalid axes/pad unplug/reconnect снимают arm; zero throttle gate; PWM endpoints и release/ignore по группам проверены; real USB имеет отдельный hardware checklist.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/rc-override.test.ts` (4 PASS) и `tests/browser/radio.spec.ts` (1 PASS) проверяют сохранение версионированной калибровки, независимое отображение канала режима, снятие вооружения при изменении калибровки/отключении и граничные значения PWM и специальных кодов release/ignore по группам каналов в `PilotRcMapper` (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC). Проверка физического USB-передатчика в [radio-checklist.md](radio-checklist.md) остаётся `NOT_RUN`.

### TASK-039 — Autopilot state machine

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Определить один активный autopilot backend и lifecycle/link policies.
- **Dependencies:** TASK-010, TASK-012, TASK-013, TASK-037.
- **Touched Files:** `packages/autopilot/package.json`, `packages/autopilot/src/adapter.ts`, `packages/autopilot/src/state-machine.ts`, `tests/autopilot-state.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `package-lock.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** disconnected→initializing→warming→ready→running→fault; actuators/health.
- **DoD & Acceptance Criteria:** Illegal transitions rejected; одновременно SITL и HITL невозможны; stale actuator/disarm/link loss не держит последнюю тягу бесконечно; no fake EKF READY.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/autopilot-state.test.ts` (2 PASS) и пробы G1 (`test-results/bench/links-ew-all-400.json`..`1200.json`) проверяют взаимоисключающий допуск бэкендов, отклонение недопустимых переходов, снятие вооружения при тайм-ауте/устаревании актуаторов за 100 мс и требование здоровья от адаптера перед переходом в `READY`.

### TASK-040 — Локальный WS bridge

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Создать loopback transport с session/origin проверками и bounded framing.
- **Dependencies:** TASK-003, TASK-037, TASK-039.
- **Touched Files:** `apps/bridge/package.json`, `apps/bridge/src/server.ts`, `apps/bridge/src/session.ts`, `apps/bridge/src/framing.ts`, `tests/bridge.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `package-lock.json`, `scripts/bench-links-ew.mjs`.
- **Interfaces / Contracts:** WS localhost:9002; binary frames version/length/epoch; UDP channels отдельно.
- **DoD & Acceptance Criteria:** Unauthorized Origin/session и oversized/flood frames rejected; binds loopback по умолчанию; split/coalesced frames/backpressure/reconnect tested; production WSS/PNA compatibility documented.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/bridge.test.ts` (3 PASS) проверяет обмен WS/UDP на loopback `127.0.0.1:9002`, разбор фрагментированных/склеенных бинарных кадров v1, отклонение неверных токенов/origin/сессий, ограничения 4096 байт / 4096 сообщений/с / очереди 64 КиБ, обратное давление и переподключение. Размещение в production с HTTPS/WSS/PNA требует отдельной интеграции.

### TASK-041 — ArduPilot JSON physics backend

- **Status:** DONE — Claude; baseline 6401104; 2026-10-16.
- **Title & Description:** Связать sensor truth и servo outputs в external SITL lockstep.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-040.
- **Touched Files:** `apps/bridge/src/ardupilot-json.ts`, `packages/autopilot/src/external-sitl.ts`, `tests/ardupilot-json.test.ts`, `tests/fixtures/sitl/json-protocol.json`, `apps/bridge/src/server.ts`, `apps/bridge/package.json`, `packages/autopilot/package.json`, `package-lock.json`, `tests/fixtures/sitl/generate.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Pinned ArduPilot JSON protocol, frame counters/time domain; MAVLink не подменяет physics JSON.
- **DoD & Acceptance Criteria:** UDP packet schema/endianness/servo map verified against pinned upstream; lost/duplicate/out-of-order frames без double-step; next tick ждёт корректный actuator, pause остаётся responsive.
- **Evidence:** Владелец Claude; baseline 6401104; 2026-10-16. `tests/ardupilot-json.test.ts` (10 PASS против `tests/fixtures/sitl/json-protocol.json` из закреплённого ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` `SIM_JSON.h`/`SIM_JSON.cpp`) проверяет декодирование 16/32-канальных сервопакетов, побайтово точные ответы датчиков `%.9f`, валидацию порядка ключей (`velocity` перед `velocity_wind`), пошаговый lockstep на 20 000 кадров с потерями/дубликатами/перестановками без двойного шага и пересылку через loopback-мост UDP/WebSocket.

### TASK-042 — External SITL integration harness

- **Status:** DONE — Codex; baseline 324d15e; 2026-10-19. Закреплённый нативный ArduCopter завершает замкнутый цикл arm/takeoff/hold/land через бэкенд твёрдого тела Rust WASM и синтетический эталон quad X; исходные захваты MAVLink/физики проходят независимое воспроизведение и аудит CRC.
- **Title & Description:** Запускать pinned ArduPilot и проверять замкнутый полёт без облачных API.
- **Dependencies:** TASK-031, TASK-037, TASK-038, TASK-039, TASK-041.
- **Touched Files:** `scripts/run-sitl.mjs`, `scripts/sitl.lock.json`, `tests/integration/external-sitl.test.ts`, `tests/fixtures/sitl/parameters.parm`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`.
- **Interfaces / Contracts:** Process lifecycle, RC+sensor+actuator loop, telemetry recording.
- **DoD & Acceptance Criteria:** arm/takeoff/hold/land scenario реально выполнен с ненулевым числом frames; tests fail при fake/missing binary или bridge; cleanup только своих процессов; mode/altitude thresholds frozen fixture.
- **Evidence:** Владелец Codex; baseline 324d15e; 2026-10-19. Закреплённый нативный ArduCopter (`8ab6afde107a91df1b5f60ade8f333cb8a61b190`, ELF SHA-256 `fa37bf619bce116d410931f1b7d24ea72ed444ba529379df0db9738742ecb186`) под управлением `scripts/sitl/driver.mjs` и sidecar `pymavlink` 2.4.50 на 800 Гц (`trace v2`, шаг 8). Итоговый полёт (`test-results/validation/task-042-flight.json`): 67 257 кадров физики, 4 161 оцениваемый отсчёт, 84.07125 модельных секунд за 43.075 реальных секунд, 0 пропусков/дубликатов/перезапусков, удержание 10.20 с на высоте `9.7914–9.9966` м по истине / `9.755–9.989` м по автопилоту и посадка на землю со снятием вооружения; все 2 113 наблюдений телеметрии совпадают с проверенными по CRC байтами MAVLink (`scripts/check-sitl-capture.mjs`). Наборы тестов владения процессами, отклонения фиктивного ELF и мутаций захвата (`tests/integration/external-sitl.test.ts`, `tests/sitl-quad.test.ts`, `tests/sitl-flight-trace.test.ts`) проходят (`test-results/validation/task-042-unit.xml`, `test-results/validation/task-042-rejections.json`, `test-results/validation/task-042-completion.json`). Не подтверждает измеренную аэродинамику аппарата (`TASK-033`) и не включает браузерный `READY` автопилота.

### TASK-043 — EKF warmup и health

- **Status:** DONE — Codex; baseline 324d15e; 2026-10-19. Нативный допуск LiveEkfWarmup, подтверждённое время IMU в JSON lockstep, проверенная по CRC диагностика MAVLink EKF/GNSS и наблюдавшиеся отзыв/восстановление по возрасту GNSS проходят воспроизведение живого захвата ArduCopter. Браузерный READY и записанный Simulation-on-Hardware остаются отдельными.
- **Title & Description:** Прогревать 30 sim s и допускать READY по реальной диагностике EKF.
- **Dependencies:** TASK-035, TASK-039, TASK-042.
- **Touched Files:** `packages/autopilot/src/warmup.ts`, `packages/autopilot/src/ekf-status.ts`, `packages/autopilot/package.json`, `packages/mavlink/src/codec.ts`, `tests/warmup.test.ts`, `tests/integration/ekf-ready.test.ts`, `tests/fixtures/mavlink/ekf-golden.json`, `tests/fixtures/mavlink/generate-ekf.py`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Normalized ekf_flags; source freshness; SITL fast-forward only.
- **DoD & Acceptance Criteria:** Согласованные sensor timestamps; failed innovations не дают READY после таймера; acceleration factor измерен; HITL отвергает fast-forward; no startup EW до ready.
- **Evidence:** Владелец Codex; baseline 324d15e; 2026-10-19. `packages/autopilot/src/warmup.ts`, `ekf-status.ts` и `live-warmup.ts` (подтверждённые часы отсчётов IMU `json-lockstep` + проверенные по CRC `EKF_STATUS_REPORT`, `GPS_RAW_INT`, `HIGHRES_IMU`, `HEARTBEAT`; пределы свежести `0.01` с для IMU и `0.3` с для GNSS). В прогоне закреплённого ArduCopter (`test-results/validation/task-043-warmup.json`, `test-results/validation/task-043-flight.json`) первый переход в `READY` происходит на `41.27625` модельной секунде / `20.733261598` реальной секунде (ускорение `1.990822804x`); все 8 413 наблюдений готовности и 31 953 проводных кадра совпадают с воспроизведением сырого MAVLink (`scripts/check-ekf-warmup.mjs`), включая два наблюдавшихся превышения возраста GNSS (`>0.3` с), которые отзывают и восстанавливают допуск `READY`/РЭБ, а также 7 синтетических проб отклонения (`tests/warmup.test.ts`, `tests/integration/ekf-ready.test.ts`, `test-results/validation/task-043-unit.xml`, `test-results/validation/task-043-completion.json`). Браузерный UI `READY` автопилота и записанный Simulation-on-Hardware остаются отдельными.

### TASK-044 — ArduPilot WASM feasibility gate

- **Status:** DONE — Codex; baseline c3a4735; 2026-10-17. Независимый гейт осуществимости завершён; локальная сборка в WSL/Emscripten и запуск браузерного Worker/EEPROM впоследствии проверены в TASK-045, тогда как распространение под GPL (BLOCKED_DECISION) остаётся открытым, а паритет полёта MirageSITL пройден в TASK-047 без выбора бэкенда приложения; TASK-046 теперь проверяет браузерный HAL.
- **Title & Description:** Проверить HAL/scheduler/storage/network/license и сохранить конкретное решение с прототипом.
- **Dependencies:** TASK-016, TASK-039, TASK-042.
- **Touched Files:** `docs/decisions/ardupilot-wasm.md`, `native/ardupilot/source.lock.json`, `native/ardupilot/feasibility.md`, `tests/ardupilot-wasm-capability.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `docs/ru/ardupilot-wasm.md`, `docs/ru/feasibility.md`, `scripts/probe-ardupilot-wasm.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Required browser HAL capabilities; supported firmware targets.
- **DoD & Acceptance Criteria:** Каждая capability имеет запускаемый probe/observed blocker; решение feasible/blocked с доказательствами; blocked оставляет 045..047 открытыми, не считается реализацией WASM режима.
- **Evidence:** Владелец Codex; baseline c3a4735; 2026-10-17. `scripts/probe-ardupilot-wasm.mjs`, `tests/ardupilot-wasm-capability.test.ts` (3 PASS), `native/ardupilot/source.lock.json`, `native/ardupilot/feasibility.md` и [ardupilot-wasm.md](ardupilot-wasm.md) проверяют требования HAL/планировщика/хранилища/сети/GPL закреплённого ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190`. Впоследствии `TASK-045` решила локальную сборку на Emscripten 4.0.15, запуск Worker/pthread и хранение EEPROM в IndexedDB; `TASK-046` впоследствии проверяет браузерный HAL; паритет `TASK-047` пройден без выбора бэкенда приложения, а проверка распространения GPLv3 остаётся открытой.

### TASK-045 — ArduPilot WASM build

- **Status:** DONE — Codex; baseline af984ed; 2026-10-19. Локальная закреплённая сборка, допуск реального браузерного Worker/pthread и сохранение EEPROM проверены. Распространение артефакта сохраняет BLOCKED_DECISION (проверка GPL); паритет полёта MirageSITL пройден в TASK-047 без выбора бэкенда приложения; HAL проверен в TASK-046.
- **Title & Description:** Собрать выбранный firmware с pinned toolchain и hash manifests.
- **Dependencies:** TASK-044.
- **Touched Files:** `native/ardupilot/CMakeLists.txt`, `native/ardupilot/toolchain.lock.json`, `scripts/build-ardupilot-wasm.mjs`, `packages/autopilot/src/wasm-loader.ts`, `tests/ardupilot-wasm-build.test.ts`, `scripts/probe-ardupilot-wasm.mjs`, `tests/ardupilot-wasm-capability.test.ts`, `docs/decisions/ardupilot-wasm.md`, `docs/ru/ardupilot-wasm.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `scripts/smoke-ardupilot-wasm.mjs`, `packages/autopilot/package.json`, `native/ardupilot/wasm-artifact.manifest.json`, `packages/autopilot/src/wasm-storage.ts`, `packages/autopilot/src/wasm-browser.ts`, `apps/web/src/ardupilot.worker.ts`, `apps/web/src/diagnostics/ardupilot-check.ts`, `apps/web/ardupilot-check.html`, `apps/web/vite.config.ts`, `tests/ardupilot-wasm-storage.test.ts`, `tests/browser/ardupilot-wasm.spec.ts`, `packages/mavlink/src/codec.ts`, `tests/fixtures/mavlink/wasm-parameters.json`, `tests/fixtures/mavlink/generate-wasm-parameters.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `README.md`, `docs/ru/README.md`, `scripts/check-ardupilot-browser.py`, `native/ardupilot/feasibility.md`, `docs/ru/feasibility.md`.
- **Interfaces / Contracts:** Artifact ABI/license/firmware manifest.
- **DoD & Acceptance Criteria:** Reproducible artifact загружается в Worker; symbols и memory limits проверены; dependency blocker из 044 должен быть устранён, fake empty module запрещён.
- **Evidence:** Владелец Claude/Codex; baseline af984ed; 2026-10-19. Закреплённый ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` (`waf configure --board wasm && waf copter` в WSL с Emscripten 4.0.15 `389a68bc35dcff7ebae4614e1615099dafda00d1`) воспроизводимо собирает `arducopter.wasm` (`3 730 330` Б, SHA-256 `556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38`) и `arducopter.js` (`258 215` Б, SHA-256 `b158a7b8e9b400c770e2b4fc87c66fc2aaf68bc583c7d71f3a56786d3bcb4212`), зафиксированные в `native/ardupilot/wasm-artifact.manifest.json`. `scripts/smoke-ardupilot-wasm.mjs` загружает артефакт в Node; Chromium 155.0.8059.84 (`tests/browser/ardupilot-wasm.spec.ts`: 8 PASS) запускает допущенную прошивку в 1 ведущем Worker + 4 pthread (`16` МиБ начальной общей памяти, предел `2` ГиБ), сохраняет `WP_SPD` (`10` -> `8.125` м/с) при штатном и принудительном перезапуске Worker в образах EEPROM по 16 КиБ в IndexedDB, проверяемых `scripts/check-ardupilot-browser.py`, и подтверждает чистое завершение Worker (`test-results/validation/task-045-completion.json`, `test-results/validation/task-045-wire-audit.json`, `test-results/validation/task-045-browser.xml`, `test-results/validation/task-045-unit.xml`). Артефакты остаются вне репозитория до проверки условий распространения GPLv3 (`BLOCKED_DECISION`); активным бэкендом приложения остаётся demo до выполнения `TASK-047`.

### TASK-046 — Browser HAL для ArduPilot

- **Status:** DONE — Codex; база завершения 55a7c01; 2026-10-20. Проверены реальные время/датчики/PWM HAL, хранилище и детерминированное завершение принадлежащих сессии Worker на 400/800/1200 Гц. Паритет браузерного полёта пройден в TASK-047 без выбора бэкенда приложения. READY остаётся отдельным.
- **Title & Description:** Подключить clock/storage/sensor/actuator endpoints к WASM firmware.
- **Dependencies:** TASK-013, TASK-035, TASK-045.
- **Touched Files:** `native/ardupilot/hal/browser_hal.cpp`, `packages/autopilot/src/wasm-sitl.ts`, `tests/wasm-hal.test.ts`.
- **Interfaces / Contracts:** Sim clock lockstep, virtual storage, preallocated mailbox; отдельный AP worker если HAL требует.
- **DoD & Acceptance Criteria:** Native HAL probes и wasm probes одинаковы; no sockets/file API assumptions; sensor timing/actuator count validated; вкладка pause/terminate не deadlock.

- **Область реализации:** Версионированный HAL-mailbox/native-проверка (`native/ardupilot/hal/browser_hal.h`, `browser_hal.cpp`, `probe.cpp`); патч закреплённого upstream и локальные сборка/проверка (`native/ardupilot/hal/sitl-state.patch`, `scripts/build-ardupilot-hal.mjs`, `scripts/check-ardupilot-hal.mjs`); адаптер (`packages/autopilot/src/wasm-sitl.ts`), холодный callback в `wasm-browser.ts`, экспорт пакета, native/TS/браузерные тесты (`tests/wasm-hal.test.ts`, `tests/browser/wasm-hal.spec.ts` и тестовый Worker), спецификация/архитектура/базовые инструкции и русские зеркала. Отдельные исходники/сборка сохраняют байты TASK-045 и работу TASK-074. Идентичность HAL-артефакта отдельная; распространение прошивки и паритет TASK-047 не заявляются. Очереди ABI-v2 сохраняют байты и единственного писателя.

- **Дополнительные проверки:** `native/ardupilot/hal/wasm_probe.cpp` исполняет реальное ядро HAL в pthread WASM со счётчиком аллокаций; `fault_probe.cpp` независимо отклоняет неверные native-кадры. Обновить `scripts/probe-ardupilot-wasm.mjs` и руководства feasibility/decision (с русскими зеркалами), отделяя реализованные доказательства HAL от недопущенного производственного полёта.

- **Регрессия жизненного цикла:** Завершить checkpoint/хранилище/профиль до остановки любого pthread. Снять callback, завершить все потоки и подтвердить остановку/закрыть владельца без нового асинхронного оборота. Запретить позднее создание pthread. Fixture задержанного освобождения проверяет порядок на четырёх реальных pthread; прежний таймаут отсутствия Worker не меняется.

- **Диагностика прежних регрессий:** `tests/browser/ardupilot-wasm.spec.ts` показывает URL оставшихся Worker при ошибке очистки; требование нулевого числа своих Worker не меняется.

- **Исходные свидетельства HAL (2026-10-20):** `node scripts/build-ardupilot-hal.mjs --resume` завершается с кодом 0; локальный WASM SHA-256 `765e082bcc6d1c89124379645d64aa7c82784430032204a130f73b323818be51` (3 733 494 байта), закреплённый ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190`, Emscripten 4.0.15. `node scripts/check-ardupilot-hal.mjs` проходит три нативных прогона по миллиону шагов на 400/800/1200 Гц; `--reuse-native` обновляет JS/WASM-свидетельства только после точной проверки хешей нативных исходников. WASM ядра SHA-256 `15c0415a100ff4da328c17186a1a5be95e60771fa94c4eb7dd544a1dfa66a476`: миллион шагов, 0 вызовов/байтов malloc, 0 измеренных событий GC JS, 0.002976 добавочных байта JS на шаг, стабильная память, контрольные аллокации обнаружены. Отчёт: `test-results/validation/task-046-allocation.json` со ссылкой на нативное свидетельство, привязанной к хешу. Девять независимых нативных случаев неверного кадра отклоняются до изменения выхода. Целевой unit-прогон: 23 PASS, 1 необязательный тест исходного артефакта пропущен. `tests/browser/wasm-hal.spec.ts`: 4 PASS на Chromium 141.0.7390.37 / Windows с окончательным артефактом; по 8 секунд симуляции на каждой частоте и 800 шагов BET с синтетической геометрией NACA6409/NeuralFoil, пауза/замороженное время, продолжение и отсутствие оставшихся Worker. Отчёты: `test-results/validation/task-046-browser-{400,800,1200}.json` и `task-046-browser-800-bet.json` с допущенными манифестами. Ограниченный 4 мс тестовый цикл Worker группирует обмены; частота реального времени и аллокации всей прошивки не сертифицируются. Typecheck, целевой/полный lint и production-сборка web проходят (прежнее предупреждение размера чанка).

- **Исторические свидетельства отказа (устранён):** На 55a7c01 прогон четырёх случаев перезапуска/профиля дал 3 PASS и 1 FAIL с Worker-владельцем без ответа. Предположительные изменения self-close удалены. Одно снятие callback не исправляло await после остановки потоков. Завершение устраняет этот асинхронный промежуток; два отрицательных контрольных прогона на 55a7c01 проваливают независимую проверку порядка освобождения/остановки, а повторная и полная окончательная приёмка проходят. Прежние отказы сохраняются историческими свидетельствами и не переименовываются в успех.

- **Исторические общие регрессии:** Полный unit-прогон с ограничением (`vitest run --maxWorkers=2`) завершился с 556 PASS, 4 FAIL, 1 пропуском: три отказа политики документации захватили промежуточное устаревшее зеркало дорожной карты, а прежняя проверка GC `wasm-abi` наблюдала сборку. После синхронизации изолированный повтор политики документации, WASM ABI и HAL с неизменными порогами прошёл 19/19. Полный прогон сохраняет статус отказа; целевой повтор не объявляется успешным полным набором.

- **Область завершения (база 55a7c01):** `tests/browser/firmware-lifecycle-worker.ts` и дополнительный случай реальной прошивки в `tests/browser/ardupilot-wasm.spec.ts` задерживают фактический Promise освобождения Web Lock, выявляя чередования при завершении. `wasm-browser.ts` должен завершать асинхронную очистку профиля/хранилища до остановки pthread, запрещать позднее создание потоков и сохранять исключительное владение ресурсами. Таймауты и требование нулевого числа Worker не ослабляются.

- **Окончательная приёмка:** Замороженная база `6052519` и три файла исходников/тестов TASK-046 с привязкой к хешам; `test-results/validation/task-046-completion.json` фиксирует идентичности и точную область. `node node_modules/playwright/cli.js test tests/browser/ardupilot-wasm.spec.ts tests/browser/wasm-hal.spec.ts`: 13 PASS, 0 пропусков; поднабор перезапуска/профиля/задержанного освобождения с `--repeat-each 3`: 9 PASS и 21 реальная загрузка прошивки. `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=default --reporter=junit --outputFile.junit=test-results/task-046-unit.xml`: 561 PASS и 1 таймаут проверки аллокатора контакта в 100 файлах, 0 пропусков, включая необязательную дымовую проверку реального ArduCopter через `MIRAGE_ARDUPILOT_WASM_DIR`. Затем тот же тест контакта проходит отдельно с `--maxWorkers=1`, прежним таймаутом 300000 мс и приоритетом AboveNormal только собственных процессов. Итого все 562 unit-случая имеют успешное покрытие на идентичных байтах замороженных исходников; таймаут полного прогона сохраняется, а не переименовывается в успешный единый прогон. Отчёты: `test-results/validation/task-046-browser-final.xml`, `task-046-unit-full.xml`, `task-046-unit-contact.xml`. Lint, строгий typecheck, production-сборка web (прежнее предупреждение размера чанка), двуязычная документация и проверка пробелов staged проходят. Приёмка использует замороженный fixture исходников с теми же закреплёнными корневыми/вложенными зависимостями и записанным Git HEAD, исключая посторонние одновременные изменения. Его первоначальная ошибка CLI только из-за метаданных исправлена, затем повторены целевые и полные прогоны. Прежний таймаут создания браузерной страницы при параллельной нагрузке перепроверен изолированно с исходным таймаутом; проверки прошивки и очистки не ослаблялись. Обновлённый G1 HAL проходит миллион шагов WASM/JS (0 вызовов/байтов, 0 событий GC, стабильная память, положительные контроли) с нативными свидетельствами миллиона шагов на всех трёх частотах при идентичных хешах; все 9 нативных случаев неверного кадра отклоняются без изменения выхода.

- **Остаток TASK-046:** Нет. Паритет полёта native/WASM, production READY автопилота и квалификация аллокаций всей прошивки остаются отдельными; распространение GPL остаётся BLOCKED_DECISION. Активное приложение сохраняет отдельно допущенный бэкенд.

### TASK-047 — WASM/native SITL parity

- **Status:** DONE — Cursor; база bfc2cb6; 2026-10-20. Нативные и браузерные полёты arm/взлёт/посадка и отказ GCS совпадают в фиксированных пределах 30 с. Демонстрационный бэкенд приложения остаётся выбранным.
- **Title & Description:** Сравнить одинаковый сценарий на двух backends и включить WASM mode только после gate.
- **Dependencies:** TASK-042, TASK-043, TASK-046.
- **Touched Files:** `tests/integration/wasm-sitl.test.ts`, `scripts/compare-autopilot.mjs`, `docs/validation/autopilot-parity.schema.json`.
- **Interfaces / Contracts:** Identical seed/parameters/airframe; mode/EKF/trajectory tolerances.
- **DoD & Acceptance Criteria:** arm/takeoff/land + failsafe на обоих; thresholds заданы до запуска (position RMSE<=0.5 m, attitude RMSE<=2° за reference 30 s); несовпадение диагностируется, не обновляется golden автоматически.
- **Область выполнения:** Сначала добавить анализатор захватов и схему с отказом при неполных данных, а также независимые численные тесты и проверки допуска; затем записать одинаковый настраиваемый синтетический аппарат BET NACA6409/NeuralFoil, начало координат, seed датчиков, параметры и команды по тикам через native JSON SITL и реальный браузерный HAL. При необходимости добавить драйверы/Workers захвата, явно синтетическую опору на землю в BET и начальные параметры браузера с целевыми регрессионными тестами и синхронным обновлением спецификации движков/архитектуры. Сохранить посторонние отчёты и локальную прошивку. Критерии отказа: неполный полёт/failsafe, устаревшая или нездоровая телеметрия, разные идентичности входов/тики, отсутствие происхождения или превышение любого фиксированного предела RMSE. Тест анализатора или совпадение разоружённых трасс не допускает браузерный READY; бэкенд demo сохраняется до прохождения реальных полётов и существующих runtime-gates.
- **Обнаруженное исправление зависимости:** Независимый аудит исходных байтов выявил задержку декодирования EKF: `MavParser` искал следующий стартовый байт внутри payload неподдерживаемого кадра. Область расширяется на `packages/mavlink/src/codec.ts` и регрессионную проверку фрейминга: полностью потреблять ограниченный структурно корректный неподдерживаемый конверт, не допускать его payload и сохранять ресинхронизацию повреждённых известных кадров. Повторить захваты после исправления; прежний отказ свежести не переименовывать в успешное свидетельство.
- **Область допуска режима:** Добавить холодную capability паритета с проверкой SHA-256, связанную с текущими идентичностями прошивки/аппарата/параметров/датчиков/команд и частотой; требовать выданную capability в `AutopilotSession.connect('wasm-sitl', ...)` (`packages/autopilot/src/wasm-parity.ts`, автомат состояний, экспорт пакета и целевые тесты). Сериализованный/поддельный результат или исторический отчёт для других входов не включает этот бэкенд. Gate не выбирает бэкенд приложения и не заменяет живой прогрев, квалификацию аллокатора, допуск распространения или релиза.
- **Контрольная точка (запрошен локальный коммит):** Реальные native/browser захваты штатного полёта и потери GCS проходят четыре независимых аудита pymavlink и фиксированное сравнение за 30 с: position RMSE 0.018855/0.048724 м, attitude RMSE 0.057905/0.096648 градуса, максимальное расхождение mode/arming 0.03/0.18 с (`test-results/validation/autopilot-parity.json`). Допуск capability по реальному отчёту проходит. Целевые проверки framing/codec/warmup/HAL/storage/паритета: 51 PASS; lifecycle/admission/паритет: 32 PASS. Общий unit-прогон: 587 PASS, 5 отказов окружения (loopback/symlink/псевдоним Python), 1 пропуск необязательной прошивки; повтор окружения: 23 PASS в четырёх файлах, включая реальную прошивку, bridge, fixture и manifest. **Доказательства:** Владелец Cursor; baseline bfc2cb6; 2026-10-20. Повторены захваты native в WSL и HAL в Chromium 141 после исправления аллокаций. `node scripts/compare-autopilot.mjs` завершается с кодом 0, `test-results/validation/autopilot-parity.json` имеет статус PASS: takeoff-land RMSE положения 0.018855 м, RMSE ориентации 0.057905 градуса, расхождение режима 0.02 с; GCS-failsafe RMSE положения 0.048724 м, RMSE ориентации 0.096648 градуса, расхождение режима 0.19 с. Четыре аудита pymavlink 2.4.50 прошли. Браузерные захваты: `tests/browser/autopilot-parity.spec.ts` 2 PASS. SHA-256 модуля HAL `765e082bcc6d1c89124379645d64aa7c82784430032204a130f73b323818be51`. Аллокация синтетической площадки: 1 000 000 шагов, 0 событий GC, 0.003248 байта/шаг. Этот отчёт не выбирает бэкенд приложения.

### TASK-048 — Web Serial transport

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Открывать порт только по gesture и обрабатывать stream/reconnect безопасно.
- **Dependencies:** TASK-005, TASK-037, TASK-039.
- **Touched Files:** `packages/autopilot/src/serial-transport.ts`, `apps/web/src/SerialConnect.tsx`, `tests/serial-transport.test.ts`, `tests/browser/serial-permission.spec.ts`, `packages/autopilot/src/serial-io.worker.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/App.tsx`, `apps/web/package.json`, `package-lock.json`.
- **Interfaces / Contracts:** ReadableStream chunks→MAVLink parser; permission/user gesture, port lifecycle.
- **DoD & Acceptance Criteria:** Mock chunk/error/disconnect/cancel cases; повторное открытие не дублирует reader; unsupported браузер disabled; mock не считается реальным HITL.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/serial-transport.test.ts` (4 PASS) и `tests/browser/serial-permission.spec.ts` (3 PASS в Chromium) проверяют запрос порта только по пользовательскому жесту, владение единственным reader, ограниченные чанки по 4096 байт с тайм-аутом декодера 500 мс в выделенном Serial I/O Worker и чистое отключение/повторное открытие. Пассивный приём MAVLink2 от физического контроллера Matek H743-WING через `COM7` записан в `test-results/hardware/serial-com7-matek.json`. Прошивка дрона для Hybrid SITL и Simulation-on-Hardware — это предложение версии 2 `TASK-051`, а не эта транспортная задача.

### TASK-049 — HIL sensor/actuator streaming

- **Status:** DONE — Claude; baseline b28c8c2; 2026-10-16 (потоковая передача проверена на поддельных часах; прошивка дрона для Simulation-on-Hardware — предложение версии 2 TASK-051).
- **Title & Description:** Выдавать HIL_SENSOR/HIL_GPS и принимать HIL_ACTUATOR_CONTROLS по реальным часам.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-037, TASK-048.
- **Touched Files:** `packages/autopilot/src/hitl.ts`, `packages/autopilot/src/hil-clock.ts`, `tests/hil-stream.test.ts`, `packages/autopilot/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** IMU 200/400, GNSS 5/10 Hz; actuator mapping/signing/time.
- **DoD & Acceptance Criteria:** За 60 s fake real clock верные counts/bytes/timestamps; dropout и queue overflow дают fault; fields_updated отражает реальные обновления; serial budget вычислен как baud/10 с запасом >=30%.
- **Evidence:** Владелец Claude; baseline b28c8c2; 2026-10-16. `tests/hil-stream.test.ts` (17 PASS) проверяет двенадцать 60-секундных расписаний `hitl-realtime` для комбинаций `400/800/1200` Гц физики × `200/400` Гц IMU × `5/10` Гц GNSS (`100` Гц магнитометр, `50` Гц барометр), точные битовые маски `fields_updated`, запас пропускной способности на `460800` бод (`67.9%` при `31 310` Б/с; `115200`/`230400` отклоняются), фиксацию переполнения очереди и отказ при пропадании актуаторов на 100 мс. Записанный Simulation-on-Hardware не входит в этот программный поток. Прошивка дрона для этого пути — предложение версии 2 `TASK-051`.

### TASK-050 — HITL firmware capability gate

- **Status:** DONE — Claude; baseline 0006e07; 2026-10-16 (гейт реализован; доступность HITL — BLOCKED_EXTERNAL: нет проверенного профиля платы).
- **Title & Description:** Проверять build flags/плату/сообщения до объявления режима работоспособным.
- **Dependencies:** TASK-039, TASK-049.
- **Touched Files:** `packages/autopilot/src/hitl-capabilities.ts`, `docs/hardware/hitl-matrix.md`, `tests/hitl-capabilities.test.ts`, `docs/ru/hitl-matrix.md`, `docs/documentation-index.json`, `packages/autopilot/src/state-machine.ts`, `packages/autopilot/package.json`, `tests/autopilot-state.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Board+firmware SHA+HIL mode+MAVLink support matrix.
- **DoD & Acceptance Criteria:** Unsupported HIL_SENSOR/ACTUATOR path не даёт READY; записан проверенный поддерживаемый профиль или точный BLOCKED_EXTERNAL; наличие SITL не доказательство HITL.
- **Evidence:** Владелец Claude; baseline 0006e07; 2026-10-16. `tests/hitl-capabilities.test.ts` (6 PASS) и [hitl-matrix.md](hitl-matrix.md) проверяют правила допуска по аудиту исходников: в закреплённом ArduPilot `8ab6afde...` отсутствуют обработчики `HIL_SENSOR`/`HIL_ACTUATOR_CONTROLS` (`UNSUPPORTED`), PX4 `4d7e4de7...` не входит в предложение версии 2 `TASK-051`. `TASK-051` отложена и не является гейтом версии 1. Также был опрошен локальный контроллер Matek H743-WING с `ArduCopter V4.5.7 (c1269922)` на `COM7` (`test-results/hardware/serial-com7-matek.json`), что подтвердило наличие только пассивной телеметрии.

### TASK-051 — Прошивка ArduPilot для дрона: Hybrid SITL и Simulation-on-Hardware

- **Status:** DEFERRED — Cursor; baseline 843994e; 2026-10-20. Вынесена из версии 1 в предложение версии 2 в [V2_PLAN.md](V2_PLAN.md). Приёмка версии 1 не ждёт эту задачу.
- **Title & Description:** Позже собрать образ прошивки ArduPilot 4.6.3 или новее, который можно загрузить на дрон и проверить там, используя Hybrid SITL и Simulation-on-Hardware. PX4 вне области.
- **Dependencies:** TASK-041, TASK-043, TASK-049, TASK-050.
- **Touched Files:** `docs/V2_PLAN.md`, `docs/ru/V2_PLAN.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/hardware/hitl-test-procedure.md`, `docs/ru/hitl-test-procedure.md`.
- **Interfaces / Contracts:** Сборка прошивки версии 2. Hybrid SITL использует JSON-бэкенд физики. Simulation-on-Hardware использует `env SIM_ENABLED 1`. Образ прошивается на дрон для проверки на аппарате.
- **DoD & Acceptance Criteria:** У версии 1 нет критерия прохождения этой задачи. Версия 2 завершена только когда этот образ прошивки существует, загружается на дрон и проверки Hybrid SITL и Simulation-on-Hardware на аппарате из плана версии 2 проходят. Существующий виртуальный прогон JSON этого не закрывает.
- **Evidence:** Владелец Cursor; baseline 843994e; 2026-10-20. Виртуальный JSON lockstep без дрона остаётся только прототипом (`node --experimental-strip-types scripts/run-virtual-hitl.mjs`, 24000 кадров, p99 0.0118 мс). Образ прошивки для дрона не создавался.

## Phase 4: EW & Sensor Faults

### TASK-052 — Hazard volumes

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Вычислять bounded exposure для sphere/cone и их комбинаций.
- **Dependencies:** TASK-010, TASK-032.
- **Touched Files:** `packages/ew/package.json`, `packages/ew/src/volumes.ts`, `tests/ew-volumes.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `package-lock.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES §5; r_min, power-relative, angular taper.
- **DoD & Acceptance Criteria:** Center/boundary/cone axis и sum order tests; exposure finite при r=0; outside volume=0; counts/capacity<=64, no per-step allocation.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/ew-volumes.test.ts` (2 PASS) и пробы G1 (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC) проверяют убывание по обратному квадрату расстояния, ограничение при `r = 0`, границы сферы и конуса, канонический порядок суммирования по ID и ёмкость `<=64` объёмов.

### TASK-053 — GNSS jamming

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Реализовать receiver-training severity→satellites/DOP/fix с hysteresis.
- **Dependencies:** TASK-035, TASK-052.
- **Touched Files:** `packages/ew/src/gnss-jamming.ts`, `tests/gnss-jamming.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `packages/mavlink/src/samples.ts`, `scripts/bench-links-ew.mjs`, `tests/sensor-samples.ts`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** GpsSample; q filtered; Njam 0..3, DOPjam 50..99.
- **DoD & Acceptance Criteria:** q=0 сохраняет baseline, strong jam fix=0; restore thresholds корректны; no NaN/sentinel overflow; IMU/truth не изменяются.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/gnss-jamming.test.ts` (3 PASS) и пробы G1 (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC) проверяют экспоненциальную фильтрацию интенсивности помехи, тождественность при `q = 0`, гистерезис потери/восстановления фиксации `0.8`/`0.6`, ограничение числа спутников и DOP, а также неизменность исходного GPS и истины.

### TASK-054 — Position-step spoofing

- **Status:** DONE — Claude; baseline 91579b7; 2026-10-16.
- **Title & Description:** Добавить атомарное смещение GPS в заданный tick.
- **Dependencies:** TASK-010, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/position-step.ts`, `tests/position-step.test.ts`, `packages/ew/package.json`, `packages/sensors/src/geodesy.ts`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** offsetNedM; source immutable; WGS84→wire after distortion.
- **DoD & Acceptance Criteria:** Position прыгает ровно на offset в пределах geodesy tolerance, baseline velocity остаётся; zero/disable/reset cases; altitude down sign и antimeridian tested.
- **Evidence:** Владелец Claude; baseline 91579b7; 2026-10-16. `tests/position-step.test.ts` (5 PASS) проверяет атомарное применение трёхосного смещения NED на запланированном тике с точностью `1` мм через антимеридиан и полюса, понижение MSL при `+Down` через геоид, сохранение скорости/DOP/fix и ограничение области `10 км` без изменения исходных отсчётов.

### TASK-055 — Когерентный drift

- **Status:** DONE — Claude; baseline 263ce7a; 2026-10-16.
- **Title & Description:** Интегрировать bias position/velocity на physics clock с speed cap и recovery.
- **Dependencies:** TASK-011, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/velocity-drift.ts`, `tests/velocity-drift.test.ts`, `packages/ew/package.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** b/v/a equations §5; hold-offset vs step-to-truth.
- **DoD & Acceptance Criteria:** Constant acceleration analytic fixtures; piecewise speed cap согласован с position; разные GPS/render rates дают одинаковые states; не обещается обход EKF gate.
- **Evidence:** Владелец Claude; baseline 263ce7a; 2026-10-16. `tests/velocity-drift.test.ts` (12 PASS) проверяет замкнутые формулы равноускоренной кинематики и ограничение скорости внутри шага на 400/800/1200 Гц с точностью `1e-8` м и `1e-10` м/с, тормозной путь `hold-offset` против сброса `step-to-truth` и побитовую идентичность состояния при чтениях GPS 5/10 Гц и рендера.

### TASK-056 — Magnetic anomaly

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Искажать mag vector в правильном sensor/body frame.
- **Dependencies:** TASK-034, TASK-052.
- **Touched Files:** `packages/ew/src/magnetic.ts`, `tests/magnetic-anomaly.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** Rz*Ry*Rx + biasBodyGauss; truth quaternion unchanged.
- **DoD & Acceptance Criteria:** Zero anomaly identity; 90° synthetic rotations сохраняют norm; bias unit tests; stationary truth/gyro не изменены; source/target alias запрещён.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/magnetic-anomaly.test.ts` (1 PASS) и пробы G1 (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC) проверяют тождественность при нулевой аномалии, сохранение нормы при поворотах `Rz*Ry*Rx` на 90 градусов, смещение в гауссах в связанной системе, отклонение совпадения входного и выходного буферов и неизменность истины и гироскопа.

### TASK-057 — Motor faults

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Инъецировать отказ по стабильному motor ID без изменения GPS truth path.
- **Dependencies:** TASK-010, TASK-025, TASK-027.
- **Touched Files:** `packages/physics/src/motor-fault.ts`, `tests/motor-fault.test.ts`, `native/bet/tests/motor_failure.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `packages/physics/package.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** power-cut vs synthetic instant-thrust-loss; remainingThrustFraction.
- **DoD & Acceptance Criteria:** Power-cut сохраняет passive drag/spool; instant fault обнуляет выбранную силу в текущем tick и помечает synthetic validity; остальные motors не меняются; torque arm verified.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/motor-fault.test.ts` (2 PASS), `native/bet/tests/motor_failure.rs` (1 PASS) и пробы G1 (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC) проверяют выбор мотора по стабильному ID, пассивное затухание оборотов при `power-cut`, мгновенное масштабирование силы с битом 5 `ModelOutsideValidity` при `instant-thrust-loss` и плечевые моменты.

### TASK-058 — EW pipeline composition

- **Status:** DONE — Claude; baseline c57bc60; 2026-10-16.
- **Title & Description:** Объединить sensor effects, registry и deterministic command application.
- **Dependencies:** TASK-053, TASK-054, TASK-055, TASK-056, TASK-057.
- **Touched Files:** `packages/ew/src/engine.ts`, `packages/sensors/src/pipeline.ts`, `tests/ew-pipeline.test.ts`, `packages/ew/src/gnss-jamming.ts`, `packages/ew/src/magnetic.ts`, `packages/ew/src/position-step.ts`, `packages/ew/src/velocity-drift.ts`, `packages/ew/package.json`, `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `packages/sensors/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** EwEngine, GpsSample/ImuSample, ew_flags и effect precedence.
- **DoD & Acceptance Criteria:** Порядок: baseline→step/drift→jamming→quantization, mag отдельно; multiple faults/reset consistent; source truth bit-identical; identical seed/event log produces identical packets.
- **Evidence:** Владелец Claude; baseline c57bc60; 2026-10-16. `tests/ew-pipeline.test.ts` (6 PASS) проверяет порядок применения GPS `baseline -> step/drift -> jamming -> quantization`, независимое искажение магнитометра, реестр на 16 слотов отказов и передачу в `MotorFaults`, побитовую неизменность массивов истины, детерминированные байты `HIL_GPS` при одинаковых seed и журнале команд, а также выполнение 1e6 шагов с 0 GC при всех пяти активных эффектах.

### TASK-059 — EKF scenario regressions

- **Status:** DONE — Codex; baseline 0a31f44; 2026-10-19. Шесть реальных нативных калибровочных полётов и шесть независимых валидационных полётов проходят закреплённые пределы для конкретных прошивки/параметров/модели/исходников. Проверены сырые RX/TX, реальные ответы EKF/режимов и воспроизведение физики PWM/Rust-WASM. Область — синтетический нативный квадрокоптер; браузер, записанный Simulation-on-Hardware и измеренная достоверность самолёта остаются отдельными.
- **Title & Description:** Измерять реакцию ArduPilot на все классы EW/отказов без hardcoded обещания режима.
- **Dependencies:** TASK-042, TASK-043, TASK-058.
- **Touched Files:** `tests/integration/ew-sitl.test.ts`, `tests/fixtures/scenarios/ew-matrix.json`, `scripts/report-ekf.mjs`, `scripts/run-ew-sitl.mjs`, `scripts/freeze-ew.mjs`, `scripts/sitl/audit-ew.mjs`, `scripts/sitl/ew-observations.ts`, `scripts/sitl/check-ew.py`, `scripts/sitl/driver.mjs`, `scripts/sitl/telemetry.py`, `scripts/sitl/quad.mjs`, `tests/sitl-ew.test.ts`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Innovation/status/mode/trajectory AAR trace; pinned EKF parameters.
- **DoD & Acceptance Criteria:** No-fault control scenario и каждый fault реально запущены; trace показывает изменённые observations и ответ EKF; acceptance envelope зафиксирован для версии; неизвестная реакция — investigation, не silent PASS.
- **Evidence:** Владелец Codex; baseline 0a31f44; 2026-10-19. `test-results/validation/task-059-native.json` PASS на 6 калибровочных и 6 валидационных полётах (710 636 воспроизведённых кадров физики, 20 612 строк ответа) против замороженной матрицы `tests/fixtures/scenarios/ew-matrix.json` (SHA-256 `c8bd27d9be4e22a5b10279cc925589e7299edeadb667cd478638d0f533494b3a`): подавление GNSS и когерентный дрейф вызывают переход `Guided -> Land`, скачок позиции вызывает флаги GPS-glitch, магнитное смещение повышает инновации/активность выбора компаса, а потеря тяги одного ротора приводит к кувырку/контакту с землёй в течение 3 с, тогда как контрольный полёт без отказов завершает здоровое висение и посадку (`test-results/validation/task-059-flight-regression.json`, `test-results/validation/task-059-tests.json`). Шесть проб отклонения (`tests/sitl-ew.test.ts`, `tests/integration/ew-sitl.test.ts`) проходят.

## Phase 5: Environment & Shaders

### TASK-060 — Provider/license policy

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Разделить Google live tiles и собственные cacheable datasets до реализации cache.
- **Dependencies:** TASK-003, TASK-005.
- **Touched Files:** `packages/terrain/package.json`, `packages/terrain/src/provider-policy.ts`, `docs/decisions/terrain-licensing.md`, `tests/terrain-policy.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/ru/terrain-licensing.md`, `docs/documentation-index.json`, `package-lock.json`.
- **Interfaces / Contracts:** ProviderPolicy {attribution, allowedCache, ttl, offline, datasetLicense}.
- **DoD & Acceptance Criteria:** Google persistent R2/prefetch запрещены по default; разрешение требует evidence; unknown policy fail-closed; fixtures независимы от API key; факт оплаты API не считается offline licence.
- **Evidence:** Владелец Codex; baseline dfbf402; 2026-10-16. `tests/terrain-policy.test.ts` и [terrain-licensing.md](terrain-licensing.md) проверяют fail-closed валидацию поставщиков, запрет по умолчанию постоянного кеширования/предзагрузки/офлайн-хранения Google (`ttl = 0`) и обязательную проверку атрибуции/лицензии/хеша разрешения для кешируемых лицензированных наборов данных.

### TASK-061 — Tiles streaming adapter

- **Status:** DONE — Claude; baseline 89b46f1; 2026-10-16 (локальный fixture проверен; живые тайлы Google — BLOCKED_EXTERNAL до развёртывания прокси и учётных данных).
- **Title & Description:** Подключить один выбранный 3D Tiles loader к R3F с local licensed fixture.
- **Dependencies:** TASK-015, TASK-036, TASK-060.
- **Touched Files:** `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `apps/web/src/FlightScene.tsx`, `tests/tiles-provider.test.ts`, `tests/browser/terrain.spec.ts`, `packages/terrain/package.json`, `apps/web/src/App.tsx`, `apps/web/src/terrain-config.ts`, `apps/web/src/style.css`, `apps/web/package.json`, `package-lock.json`, `tests/support/terrain-harness.ts`, `tests/fixtures/tiles/generate.py`, `tests/fixtures/tiles/tileset.json`, `tests/fixtures/tiles/tile.glb`, `tests/fixtures/registry.json`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** 3D Tiles transforms, ECEF/local origin, attribution, abort/dispose.
- **DoD & Acceptance Criteria:** Fixture tileset загружается/позиционируется; cancelled request освобождает ресурсы; CORS/COEP errors видны; Google integration при missing key — BLOCKED_EXTERNAL, local tests продолжаются.
- **Evidence:** Владелец Claude; baseline 89b46f1; 2026-10-16. `tests/tiles-provider.test.ts` (7 PASS) и `tests/browser/terrain.spec.ts` (2 PASS в Chromium) проверяют загрузку фикстуры CC0 3D Tiles 1.1 (`tests/fixtures/tiles/tileset.json`, `tile.glb`) через `3d-tiles-renderer` 0.5.3, размещение ENU-to-ECEF с точностью `1` см, отмену запросов с освобождением геометрии/материалов и классификацию ошибок CORS/сети. Живые Google 3D Tiles остаются `BLOCKED_EXTERNAL` без развёрнутого прокси и API-ключа.

### TASK-062 — LOD и GPU budget

- **Status:** DONE — Claude; baseline ea69c6a; 2026-10-16 (синтетические бюджеты проверены; резидентность на реальном GPU и время кадра на целевом устройстве остаются в TASK-073).
- **Title & Description:** Ограничить сетевой/декодирующий/GPU terrain workload.
- **Dependencies:** TASK-061.
- **Touched Files:** `packages/terrain/src/lod-budget.ts`, `packages/terrain/src/resource-cache.ts`, `tests/terrain-budget.test.ts`, `packages/terrain/src/tiles-scene.ts`, `packages/terrain/package.json`, `tests/support/terrain-harness.ts`, `tests/browser/terrain.spec.ts`.
- **Interfaces / Contracts:** Bounded request queue, CPU/GPU byte accounting, SSE limits.
- **DoD & Acceptance Criteria:** Synthetic flythrough не превышает 2 GiB terrain GPU estimate и 512 MiB decoded CPU cache; eviction вызывает dispose; idle queue не растёт; quality degrade deterministic.
- **Evidence:** Владелец Claude; baseline ea69c6a; 2026-10-16. `tests/terrain-budget.test.ts` (12 PASS) и `tests/browser/terrain.spec.ts` проверяют ограничения `<=2` ГиБ GPU и `<=512` МиБ кеша CPU на 600-кадровом пролёте с фиксированным seed, детерминированное огрубление/восстановление SSE, вытеснение LRU с однократным вызовом `dispose()` и предел очереди запросов `<=256`. Резидентность на целевом GPU и 10-минутное профилирование времени кадра остаются в `TASK-073`.

### TASK-063 — Cloudflare tiles proxy

- **Status:** DONE — Claude; baseline e9ad0f3; 2026-10-16 (локальные тесты Worker; развёртывание и живые учётные данные поставщика требуют отдельного разрешения).
- **Title & Description:** Создать authenticated proxy с quota, attribution/CORS и разрешёнными TTL.
- **Dependencies:** TASK-060, TASK-061.
- **Touched Files:** `services/tiles-worker/package.json`, `services/tiles-worker/wrangler.jsonc`, `services/tiles-worker/src/index.ts`, `services/tiles-worker/src/policy.ts`, `tests/tiles-proxy.test.ts`, `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `tsconfig.json`.
- **Interfaces / Contracts:** ProviderPolicy, opaque upstream key binding, origin/session checks.
- **DoD & Acceptance Criteria:** Local Worker tests: key не попадает клиенту/logs; bad origin/session и quota rejected; provider cache restrictions соблюдены; external deployment требует отдельного разрешения, не входит в local test success.
- **Evidence:** Владелец Claude; baseline e9ad0f3; 2026-10-16. `tests/tiles-proxy.test.ts` (10 PASS) проверяет fail-closed конфигурацию, валидацию Origin и HMAC-сессий, подстановку ключа поставщика и вырезание ключа из тел ошибок, `Cache-Control: no-store` (`TTL 0`) и квоты на сессию/IP. Внешнее развёртывание в Cloudflare и живые учётные данные Google остаются отдельными.

### TASK-064 — R2 для разрешённых datasets

- **Status:** DONE — Claude; baseline f35efe6; 2026-10-16 (тесты на эмуляторе; привязка R2 и постоянное кэширование требуют явного разрешения).
- **Title & Description:** Реализовать bounded 10–15 km regional cache только для разрешённого контента.
- **Dependencies:** TASK-062, TASK-063.
- **Touched Files:** `services/tiles-worker/src/r2-cache.ts`, `packages/terrain/src/region-manifest.ts`, `tests/r2-cache.test.ts`, `tests/support/memory-r2.ts`, `packages/terrain/package.json`.
- **Interfaces / Contracts:** Dataset hash/license, cache key/version/TTL, region manifest; deny Google unless explicit lawful policy.
- **DoD & Acceptance Criteria:** Local R2 emulator hit/miss/expiry/evict tests; bytes/quota cap; geographic radius filter 10/15 km; cacheable=false никогда не пишет R2; отсутствие прав/данных явно блокирует этот provider.
- **Evidence:** Владелец Claude; baseline f35efe6; 2026-10-16. `tests/r2-cache.test.ts` (8 PASS на `tests/support/memory-r2.ts`) проверяет фильтрацию по радиусу WGS84 `10–15` км, валидацию SHA-256 и лицензии набора данных, безусловный запрет постоянного кеширования Google, истечение TTL и вытеснение старейших записей по лимиту байт. Привязка живого бакета R2 и регистрация лицензированного набора данных остаются внешними.

### TASK-065 — Collision terrain LOD

- **Status:** DONE — Claude; baseline 6f0b249; 2026-10-18. Чанки коллизий управляют контактом Rapier из TASK-029 через плоскости на каждый тик контактного ABI v2; отсутствие земли приостанавливает шаги. Подключение к полётной сессии и живой допуск рельефа остаются отдельными.
- **Title & Description:** Готовить collision mesh отдельно от визуального streaming и менять chunks на границе tick.
- **Dependencies:** TASK-029, TASK-061, TASK-062.
- **Touched Files:** `packages/terrain/src/collision-builder.worker.ts`, `packages/terrain/src/collision-chunks.ts`, `tests/terrain-collision.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `packages/terrain/package.json`, `packages/terrain/src/collision-build.ts`, `scripts/bench-terrain-scenarios.mjs`, `tests/browser/terrain-collision.spec.ts`, `native/contact/src/contact.rs`, `native/contact/src/lib.rs`, `native/contact/tests/contact.rs`, `packages/physics/src/ground-contact.ts`, `packages/physics/src/terrain-contact.ts`, `scripts/build-contact.mjs`, `tests/terrain-contact.test.ts`, `tests/contact-support.ts`, `tests/contact-binding.test.ts`, `scripts/bench-terrain-scenarios.mjs`.
- **Interfaces / Contracts:** Immutable versioned collision chunks, local origin, readiness around vehicle.
- **DoD & Acceptance Criteria:** Visual eviction не убирает активную землю под шасси; seam/drop tests; incomplete terrain останавливает/ограничивает полёт явно; heavy decode не запускается в physics worker.
- **Evidence:** Владелец Codex/Claude; baseline 6f0b249; 2026-10-18. `node scripts/build-contact.mjs --native --test-native` (4 PASS), `tests/terrain-collision.test.ts` (5 PASS), `tests/terrain-contact.test.ts` (4 PASS) и `tests/browser/terrain-collision.spec.ts` проверяют построение чанков вне основного потока, лимит 64 МиБ для активных и ожидающих чанков, переключение на границах тиков, плоскости земли на каждый тик контактного ABI v2 через стыки чанков с точностью `1e-6` при 0 аллокаций WASM и приостановку шагов при отсутствии земли. `node scripts/bench-terrain-scenarios.mjs 400|800|1200` (`test-results/bench/terrain-scenarios-400.json`..`1200.json`) проходит 6 измеряемых окон на каждой частоте с 0 GC. Подключение к полётной сессии, декодирование живых тайлов и кривизна пятна контакта остаются открытыми.

### TASK-066 — WebGPU renderer capability

- **Status:** DONE — Claude/Codex; baseline 60ba4cf; проверено 2026-10-17. Адаптер рендерера WebGL2/WebGPU, откаты шейдеров/устройства и освобождение ресурсов проверены в программном Chromium (5 PASS, 1 пропуск WebGPU) и на аппаратном GPU RTX 4050 (6/6 PASS, 0 пропусков).
- **Title & Description:** Добавить renderer adapter с WebGL2 fallback и resource lifecycle.
- **Dependencies:** TASK-005, TASK-061.
- **Touched Files:** `apps/web/src/render/renderer.ts`, `apps/web/src/render/webgpu.ts`, `tests/browser/render-backends.spec.ts`, `apps/web/src/FlightScene.tsx`, `tests/support/render-harness.ts`.
- **Interfaces / Contracts:** Same scene/material capabilities; browser selects Metal/DX backend.
- **DoD & Acceptance Criteria:** Available GPU modes запускаются, unsupported mode skipped с причиной, не выдаётся за pass; shader capability failures fallback; no leaked resources after renderer switch.
- **Evidence:** Владелец Claude/Codex; проверено 2026-10-17. `tests/browser/render-backends.spec.ts` проверяет рендеринг WebGL2 и WebGPU, резервный пурпурный материал при ошибке шейдера, откат с WebGPU на WebGL2 с точной диагностической причиной и полное освобождение геометрии/материалов/текстур/контекста при переключении рендерера (`test-results/laptop/browser-render-gpu.xml`: 6/6 PASS без пропусков на Windows 11 с RTX 4050 Laptop GPU; headless SwiftShader проходит 5 PASS и явно пропускает вывод native WebGPU при потере программного устройства).

### TASK-067 — FPV camera/fisheye

- **Status:** DONE — Claude; baseline 778ee75; 2026-10-16 (WebGL2 проверен; fisheye для WebGPU не реализован: проход — ShaderMaterial WebGL).
- **Title & Description:** Отделить FPV pose/projection и lens distortion от внешней камеры.
- **Dependencies:** TASK-015, TASK-066.
- **Touched Files:** `packages/cameras/package.json`, `packages/cameras/src/fpv-camera.ts`, `packages/cameras/src/shaders/fisheye.glsl`, `tests/fisheye.test.ts`, `tests/browser/fpv.spec.ts`, `packages/cameras/src/fisheye.ts`, `packages/cameras/src/fisheye-material.ts`, `tests/support/fpv-harness.ts`, `package-lock.json`.
- **Interfaces / Contracts:** CameraConfig {fov, mount FRD, distortion}; immutable truth.
- **DoD & Acceptance Criteria:** Zero distortion identity; optical-center/radial mapping fixtures; positive/negative edge coordinates finite; analytic projection и viewport resize tested; no truth mutation.
- **Evidence:** Владелец Claude; baseline 778ee75; 2026-10-16. `tests/fisheye.test.ts` (11 PASS) и `tests/browser/fpv.spec.ts` (3 PASS в Chromium WebGL2) проверяют композицию позы крепления FRD, обращение лучей эквидистантной/полиномиальной дисторсии с точностью `1e-9`, смещение главной точки, изменение размера области вывода, неизменность истины и попиксельное совпадение `fisheye.glsl` с оракулом на CPU (`0/6912` несовпавших пикселей).

### TASK-068 — Analog noise/jelly

- **Status:** DONE — Claude; baseline 7478d6f; 2026-10-16 (WebGL2 проверен; допуски зависят от бэкенда; вариант для WebGPU не реализован).
- **Title & Description:** Добавить seeded video interference, scanline и rolling-shutter deformation.
- **Dependencies:** TASK-067.
- **Touched Files:** `packages/cameras/src/analog.ts`, `packages/cameras/src/shaders/analog.glsl`, `tests/analog-noise.test.ts`, `tests/browser/analog.spec.ts`, `packages/cameras/src/analog-material.ts`, `packages/cameras/package.json`, `tests/support/analog-harness.ts`.
- **Interfaces / Contracts:** VideoNoiseConfig, throttle-decimated uniform; independent visual RNG.
- **DoD & Acceptance Criteria:** Same seed/time => same frame; amplitude связан с газом только render-path; no CPU pixel loops/frame allocations; golden images tolerances pinned by backend, not cross-GPU pixel equality.
- **Evidence:** Владелец Claude; baseline 7478d6f; 2026-10-16. `tests/analog-noise.test.ts` (7 PASS) и `tests/browser/analog.spec.ts` (5 PASS в Chromium WebGL2) проверяют независимые от частоты рендера seed видеокадров (`lowbias32`), связанные с газом шум/«желе»/строки развёртки без доступа к состоянию физики, 1e6 вызовов `updateFrom` без GC и побайтово идентичные кадры WebGL2 при одинаковых seed и номере видеокадра.

### TASK-069 — WorldCover/OSM material map

- **Status:** DONE — Claude; baseline b774986; 2026-10-17. Карта материалов WorldCover v200 / OSM и декодер окон GeoTIFF Израиля проверены; непокрытые координаты явно помечаются как синтетические.
- **Title & Description:** Загружать лицензированные land classes и map features с provenance.
- **Dependencies:** TASK-036, TASK-060, TASK-061.
- **Touched Files:** `packages/thermal/package.json`, `packages/thermal/src/material-map.ts`, `packages/thermal/src/data-manifest.ts`, `tests/material-map.test.ts`, `tests/fixtures/thermal/material-classes.json`, `tests/fixtures/registry.json`, `package-lock.json`, `packages/thermal/src/geotiff.ts`, `tests/worldcover-geotiff.test.ts`, `data/worldcover/2021-v200/israel/inventory.json`, `docs/operations/worldcover-data.md`, `docs/ru/worldcover-data.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** 10 m raster labels, road/roof overlays; attribution/hash/coordinate system.
- **DoD & Acceptance Criteria:** Known coordinates map correctly; missing data fallback labelled synthetic; raster class не трактуется как temperature; licenses/attribution сохранены без массовой неразрешённой выгрузки.
- **Evidence:** Владелец Claude; baseline b774986; 2026-10-17. `tests/material-map.test.ts` (9 PASS на `tests/fixtures/thermal/material-classes.json`) и `tests/worldcover-geotiff.test.ts` (17 PASS на трёх закоммиченных GeoTIFF Израиля ESA WorldCover 2021 v200 `N27E033`, `N30E033`, `N33E033` в `data/worldcover/2021-v200/israel/inventory.json`, `90 313 215` Б; см. [worldcover-data.md](worldcover-data.md)) проверяют контроль лицензии/атрибуции/SHA-256, приоритет зданий/дорог/поверхности, 8 известных точек Израиля, стык тайлов на 30° с. ш. и откат `synthetic = true` вне зоны покрытия. Подключение к сцене приложения и выгрузка OSM остаются открытыми.

### TASK-070 — Surface thermal state

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Синтетическая сосредоточенная модель поверхности; измеренная валидация остаётся отдельной.
- **Title & Description:** Интегрировать температуру по solar/material/weather, отдельно от shader.
- **Dependencies:** TASK-032, TASK-069.
- **Touched Files:** `packages/thermal/src/heat-balance.ts`, `packages/thermal/src/solar.ts`, `packages/thermal/package.json`, `tests/thermal-energy.test.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** C*dT/dt=absorbedSolar-convection-radiation-conduction; emissivity/inertia.
- **DoD & Acceptance Criteria:** Night equilibrium, sunrise/shadow и unit energy balance fixtures; timestep convergence; AO влияет только на заданный radiative model, не заменяет heat solver; параметры инструментально не валидированы без данных.
- **Evidence:** Владелец Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-energy.test.ts` (15 PASS) проверяет трапецеидальный решатель `HeatSurface` и пакетный решатель слоёв Хойна без аллокаций `ThermalField` (согласие `<=0.02` К за 6 ч), солнечные эфемериды NOAA против NREL SPA (совпадение направления `1e-9`), ночное равновесие за 3600 с, радиационную связь теней/видимости неба и сходимость по шагу времени за 600 с (`<0.002` К). Синтетическая модель; измеренная калибровка материалов не заявляется. Расширено 2026-10-22 (владелец Claude, TASK-073 P5): скрытый поток Пенмана-Монтейта «большого листа» для поверхностей с поверхностным сопротивлением и аэродинамическое сопротивление по логарифмическому профилю FAO-56 для полога; `tests/thermal-energy.test.ts` (19 PASS) добавляет эталоны по таблицам FAO-56 (e_s 2.338 и 4.243 кПа при 20 и 30 C, gamma 0.067 кПа/К, r_a травы в пределах 3% от 208/u), независимо записанный баланс с LE, полог в пределах 4 K от воздуха в полдень, шаги 600 с против 1 с в пределах 0.01 K и неизменную проверку шага без сборок мусора.

### TASK-071 — Thermal renderer

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Независимый синтетический LWIR-конвейер WebGL2; рабочая сцена и измеренный прибор остаются открытыми.
- **Title & Description:** Преобразовать thermal state в radiance/palette с atmosphere attenuation.
- **Dependencies:** TASK-066, TASK-070.
- **Touched Files:** `packages/thermal/src/thermal-camera.ts`, `packages/thermal/src/shaders/thermal.glsl`, `tests/thermal-camera.test.ts`, `tests/browser/thermal.spec.ts`, `tests/support/thermal-harness.ts`, `packages/thermal/package.json`, `tests/material-map.test.ts`, `apps/web/src/render/webgpu.ts`, `tests/browser/render-backends.spec.ts`, `tests/support/render-harness.html`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `packages/thermal/src/thermal-material.ts`.
- **Interfaces / Contracts:** InstrumentProfile {resolution, spectralResponse, noise, calibrationSource}; training profile отдельно от CADEX measurements.
- **DoD & Acceptance Criteria:** Blackbody monotonicity, emissivity/reflection и distance attenuation fixtures; cold/hot palette endpoints; no claims of CADEX parity без profile data; native sensor resolution configurable.
- **Evidence:** Владелец Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-camera.test.ts` (8 PASS) и `tests/browser/thermal.spec.ts` (1 PASS в Chromium WebGL2) проверяют полосовое интегрирование радиации Планка методом Симпсона (`54–56` Вт/(м²·ср) при 300 К), излучательную способность/отражение/ослабление Бугера — Ламберта — Бера, палитры `white-hot`/`black-hot`/`ironbow`, настраиваемое собственное разрешение и попиксельное согласие GLSL и CPU в пределах одного 8-битного уровня. Измеренный профиль CADEX и подключение к рабочей сцене не заявляются.

### TASK-072 — Shutter/NUC и thermal HUD

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Детерминированная синтетическая калибровка смещения затвором.
- **Title & Description:** Добавить deterministic calibration cycle и bounded display interruption.
- **Dependencies:** TASK-071.
- **Touched Files:** `packages/thermal/src/nuc.ts`, `packages/thermal/src/thermal-status.ts`, `packages/thermal/package.json`, `tests/thermal-nuc.test.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Shutter states idle/closed/calibrating/open; sensor frame time.
- **DoD & Acceptance Criteria:** Зафиксированная длительность/частота; NUC reset убирает заданный bias; no timestamp rewind; shutter не ставит физику на паузу и не меняет AAR truth.
- **Evidence:** Владелец Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-nuc.test.ts` (4 PASS) проверяет цикл затвора `idle -> closed -> calibrating -> open`, удержание кадра на 17 отсчётов на сетке 120 с, удаление фиксированного геометрического смещения (остаток `0.71 ± 30%` отсчёта на 4096 зашумлённых пикселях), монотонность меток времени и побитовую неизменность `ThermalField`/состояния физики при срабатывании затвора.

### TASK-073 — GPU acceptance harness

- **Status:** BLOCKED_EXTERNAL — Cursor; baseline 5be98c4; 2026-10-21. Пользователь принял время кадра M4 для 60 FPS (медиана 16.680 мс, p99 17.665 мс) и панель 59.88 Гц. Снимок оператора показывает, что сцена не заполнила дисплей 2560×1440. Штатная матрица 2560×1664 не была поверхностью показа. Полнофункциональные захваты RTX 4050 при 60 FPS не проходят принятые пределы (сбалансированное питание: p99 23.880 мс; максимальная производительность: медиана 16.685 мс и p99 34.260 мс), а проходы fisheye/thermal для WebGPU остаются открытыми; открытые пункты перечислены в [needed_for_task073.md](needed_for_task073.md).
- **Title & Description:** Снять production profiles на M4/RTX 4050 с FPV/thermal/terrain.
- **Dependencies:** TASK-014, TASK-062, TASK-065, TASK-066, TASK-068, TASK-072.
- **Touched Files:** `scripts/bench-render.mjs`, `scripts/check-gpu-perf.mjs`, `scripts/gpu-trace.mjs`, `apps/web/src/render/g3-mode.ts`, `apps/web/src/render/g3-passes.ts`, `apps/web/src/FlightScene.tsx`, `apps/web/src/style.css`, `apps/web/vite.config.ts`, `apps/web/package.json`, `docs/benchmarks/render-matrix.json`, `docs/validation/gpu-report.schema.json`, `tests/gpu-report.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `package-lock.json`, `docs/needed_for_task073.md`, `docs/ru/needed_for_task073.md`.
- **Interfaces / Contracts:** G3 device/browser/resolution/quality/VRAM evidence.
- **DoD & Acceptance Criteria:** По 10 min после 60 s warmup. Принятые пользователем пределы 60 FPS: медиана <=16.680 ms и p99 <=17.665 ms; панель 59.88 Hz принята для этого профиля. 120 FPS по-прежнему требует p99<=8.33 ms на панели с частотой не ниже 120 Hz. Terrain budget соблюдён. Изображение полёта должно заполнять активный физический дисплей. Headless software GPU не подтверждает hardware gate. Missing devices BLOCKED_EXTERNAL.
- **Evidence:** Владелец Cursor; baseline 5be98c4; 2026-10-21. Пользователь объявил измеренные на M4 медиану 16.680 мс и p99 17.665 мс приемлемыми и объявил обновление панели 59.88 Гц приемлемым для профиля 60 FPS. `assessGpu` теперь округляет время кадра до 0.001 мс и применяет эти пределы 60 FPS. Предел p99 для 120 FPS остаётся 8.33 мс. `npx --no-install vitest run tests/gpu-report.test.ts tests/evidence-tools.test.ts` и `npx --no-install tsc --noEmit` проверяют принятую границу и отказ при p99 17.666 мс. Десятиминутный захват WebGL2 (`test-results/m4`, Chrome 155.0.8059.85, macOS 27.0.1, питание от сети, Node 26.8.2, Apple M4 MacBook Air Mac16,12, 8 ядер GPU, 16 ГБ) записал 35974 кадра 1920×1080 при DPR 1 после прогрева 60 с; terrain, FPV и thermal оставались активными, резидентность тайлов 10092 байт. Сохранённый файл анализатора всё ещё говорит FAIL, потому что он посчитан до этого решения; при объявленных пределах эти два числа проходят. Снимок оператора в `task_073_results/` (PNG 1932×1217 от 2026-10-20 23:56) показывает, почему показ не проходит. Chrome — плавающее окно на рабочем столе, видны панель инструментов и `127.0.0.1:5175/?renderer=webgl2&g3=1`, а обои macOS остаются вокруг окна. Изображение полёта не покрывает экран. Режим дисплея Mac в этом прогоне — 2560×1440. Штатное разрешение матрицы MacBook Air — 2560×1664. Стенд принудительно задал эмулированный viewport 1920×1080, который не совпадает ни с одним из этих дисплеев. Дальнейшие проверки: повторить захват, заполнив режим 2560×1440 и, отдельно, штатную матрицу 2560×1664, и сохранить снимок всего дисплея рядом с размером буфера рисования. Профиль 120 FPS запускать только на панели от 120 Гц, включая десятиминутный захват RTX 4050 с terrain, FPV и thermal. WebGPU остаётся заблокированным, пока нет проходов fisheye и thermal. Исторические демозахваты RTX 4050 по-прежнему выше и принятого p99 17.665 мс, и предела 8.33 мс для 120 FPS. RTX 4050 (владелец Claude; 2026-10-21): два 10-минутных полнофункциональных захвата WebGL2 из ветки `task-073-render-profile` (`bf53d57`: `?profile=full`, `scripts/capture-render.mjs`, детерминированный синтетический CC0-тайлсет нагрузки из 341 тайла, SHA-256 содержимого `a771cacd838c6603fa63ea3bbd9985d0ad00fed6b84ba0a968210424dfce5940`) с Chrome 155.0.8059.85, NVIDIA GeForce RTX 4050 Laptop GPU (драйвер 32.0.15.6100), Windows 11 10.0.26200, питанием от сети и внешним дисплеем 1920×1080 60 Гц, полноэкранно 1920×1080 при DPR 1, terrain, FPV и thermal активны всё окно измерения; canvas полёта занимал 1316×640 внутри разметки приложения, поэтому правило заполнения дисплея также не выполнено. Обе трассы оценены `scripts/bench-render.mjs` этой линии коммитов (SHA-256 валидатора `801a8e97132d788b2678269e81994a9cc4c40fb5ac7f284b77db6f73206fe28b`) по принятым пределам. (1) Сбалансированное питание (схема `381b4222-f694-41f0-9685-ff5bb260df2e`): 35 754 кадра, медиана 16.670 мс, p99 23.880 мс, 349 пропущенных обновлений из 36 000 (0.97%), GPU в P8 на 210–360 МГц, SHA-256 трассы `b69f0651c47b73d6a274c765b4ca727efef6e0d4693ea51bfa60d32f86ca17b3`: `FAIL` (p99). (2) Заданная оператором максимальная производительность (в NVIDIA для программы `chrome.exe` режим «Предпочтителен режим максимальной производительности», режим Windows «Максимальная производительность» `ded574b5-45a0-4f42-8737-46345c09c238`, профиль производителя Performance): 35 151 кадр, медиана 16.685 мс, p99 34.260 мс, максимум 96.5 мс, 947 пропущенных обновлений (2.63%), GPU 299 раз переключался между P5 и P8 на 420–450 МГц с причиной частоты NVIDIA `GPU idle` при 54–64 °C, SHA-256 трассы `b90ee6801356df85c9b0790398721d2c900ab51a7c951325eeb94c90e6995061`: `FAIL` (медиана и p99). Пик выделенной памяти GPU-процесса составил 147 МиБ и 140 МиБ (счётчики Windows), пик кеша ландшафта 12.5 МиБ — в пределах бюджетов 2 ГиБ / 512 МиБ. Диагностика (локальный `scripts/diagnose-render.mjs`: WebGL2 `EXT_disjoint_timer_query_webgl2` для каждого обратного вызова requestAnimationFrame, по 120 с на профиль после прогрева 20 с): при сбалансированном питании p99 demo/terrain/full 21.4/22.2/23.6 мс и 31/30/52 интервала длиннее 25 мс; при максимальной производительности 41.1/40.6/34.8 мс и 131/135/138; p99 обратного вызова главного потока не более 5.3 мс, длинных задач нет ни в одном прогоне; время GPU по таймерным запросам следует состоянию частоты, а не сцене. В сбалансированной трассе 63% интервалов длиннее 18.5 мс — дрожание меток времени в паре с коротким интервалом, в сумме два обновления экрана. Вывод: пропуски определяются поведением состояний питания GPU при гибридной графике Windows, а не стоимостью сцены; профиль RTX 4050 60 FPS остаётся `FAIL`, пределы не менялись. Трассы, сопроводительные файлы, отчёты и отсчёты `nvidia-smi` находятся в игнорируемых каталогах `test-results/render/` и `test-results/render/maxperf/` и не зафиксированы. P3 (владелец Claude; 2026-10-22, ветка `task-073-g3`): `scripts/geodata/` строит рельеф quantized-mesh из FABDEM с проверенным переводом EGM2008 в WGS84 (применено 19.395 м при 19.396 м в районе) и 2 871 993 здания Overture в 3D Tiles 1.1 через PostGIS и `pg2b3dm`; приложение загружает оба источника через `TilesScene` (`QuantizedMeshPlugin`, `ImplicitTilingPlugin`), а `scripts/check-gpu-perf.mjs --geodata` выполняет захват над ними. Новые браузерные тесты размещают синтетическую фикстуру quantized-mesh в пределах 0.5 м от её эллипсоидальной высоты и загружают фикстуру с неявным тайлингом так же, как её явный аналог. Высоту или этажность имеют лишь около 1.3% зданий; остальные используют 6 м. P4 (владелец Claude; 2026-10-22, ветка `task-073-g3`): `scripts/geodata/extract_osm.py` и `build_material_map.py` строят растр классов материалов 1 м, 2000 x 2000 для района из выгрузки Geofabrik (SHA-256 `59ac7350c78fc90d77f65fdc670c1d3248c8b218d9f8bbb4cee4c6ef9b22a2a5`) и ESA WorldCover v200 с легендой и приоритетом `MaterialMap`; `check_material_map.mjs` совпал с TypeScript-классом `MaterialMap` в 99.98% из 5 000 выборок с фиксированным зерном (критерий не менее 97%, одно расхождение на границе класса): `PASS`. Приложение накладывает растр на рельеф (`apps/web/src/render/material-drape.ts`) и показывает атрибуции WorldCover и OSM; `tests/material-drape.test.ts` проверяет валидацию растра, палитру и загрузку. Цвета служат только для показа; в P5 классы сопоставляются с излучательной способностью. P5 (владелец Claude; 2026-10-22, ветка `task-073-g3`): тепловизор G3 — приближённый профиль `BOSON_640_50DEG` (значения открытого технического описания, объектив 8.7 мм 50 градусов, 60 Гц, без заявления соответствия); `AreaThermal` связывает тепловой баланс TASK-070 с каждым классом растра в пяти ориентациях с излучательной способностью раздела 9.1, G-буфер читает класс и ориентацию грани для каждого фрагмента, а `ThermalSensorChain` управляет затвором/NUC TASK-072 над сгенерированным фиксированным шумом, остаток которого добавляет шейдер (совпадает с выходом NUC в пределах 1e-5 K в `tests/thermal-sensor.test.ts`). Новые тесты: `tests/thermal-sensor.test.ts`, `tests/area-thermal.test.ts`, профиль Boson в `tests/thermal-camera.test.ts`, разбор вида и времени в `tests/g3-mode.test.ts` и браузерный эталон для фиксированного шума и открытого неба в `tests/browser/thermal.spec.ts` (55 браузерных тестов пройдены, 16 пропущены). Пробный прогон над районом в Израиле (`--view thermal`, 10 с) показал тепловое изображение с одним циклом NUC; сначала крона деревьев нагревалась примерно до 60 C в 10:00 по местному времени, потому что в модели TASK-070 не было эвапотранспирации; после расширения TASK-070 скрытым потоком (принятая влажность 60%) она остаётся в пределах примерно 3 K от температуры воздуха и выглядит темнее покрытия. Визуальный эталон: `scripts/geodata/fetch_flir_sample.py` выборочно прочитал по диапазонам байт тестовое видео `vbrSzr4vFTm5QwuGH` (208 кадров в виде 14-битных TIFF со сжатием LZW и 8-битных JPEG с АРУ, 78 МБ, CRC каждого элемента проверен) из архива Teledyne FLIR ADAS v2 (11 865 443 849 байт, опубликованный MD5 `3150533d3a712c598aa110d5513a1671`) в `~/mirage-geodata/flir-adas-v2/` вне репозитория; `flir-sample-manifest.json` (SHA-256 `d4b429c720e06fc6e4bab7154f7cd14b6a2b4b471ebbc158b4e72b71f57a1e3f`) перечисляет SHA-256 каждого файла и хеш README (`662bd3e48d4fe6fb1d55a4bbf83450993cafe3377c9c5f980b64bc58c46e9c28`). Видео записано камерой Tau 2 (13 мм, 45 градусов по горизонтали, T-linear) на автомобиле, без времени, места и погоды в записях, поэтому годится только для качественного сравнения; на его кадрах кроны деревьев холоднее освещённого солнцем покрытия, что теперь воспроизводит расширение с эвапотранспирацией. Приёмка G3 не изменилась.

## Phase 6: UI & Telemetry

### TASK-074 — Pilot HUD и telemetry freshness

- **Status:** DONE — Cursor; baseline d4dda82; 2026-10-20. Привязанная к идентификатору диагностика `EkfMonitor` из декодированных USB-кадров `serial.frame` задаёт в `PilotHud` источник, `custom_mode`, деградированные/валидные флаги EKF и устаревание 1000 мс. Отключение очищает наложение и возвращает demo truth. Worker физики по-прежнему публикует неизвестные поля автопилота. Разрешение Serial не допускает браузерный READY или HITL.
- **Title & Description:** Показывать attitude/speed/altitude/mode/EKF с источником и возрастом.
- **Dependencies:** TASK-015, TASK-039, TASK-043.
- **Touched Files:** `apps/web/src/hud/PilotHud.tsx`, `apps/web/src/hud/attitude.ts`, `apps/web/src/hud/telemetry.ts`, `apps/web/src/SerialConnect.tsx`, `apps/web/src/App.tsx`, `apps/web/src/runtime.ts`, `apps/web/src/style.css`, `packages/physics/src/session-v2.ts`, `tests/session-v2.test.ts`, `tests/hud.test.ts`, `tests/browser/hud.spec.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `HANDOVER.md`, `docs/ru/HANDOVER.md`, `docs/documentation-index.json`.
- **Interfaces / Contracts:** FlightStateV2, normalized ekf_flags, unknown/stale visual state.
- **DoD & Acceptance Criteria:** NED horizon signs verified; fake valid EKF из demo невозможен; stale AP status подписан; UI updates decimated, не React setState на 1200 Hz.
- **Evidence:** Владелец Cursor; baseline d4dda82; 2026-10-20. `npx --no-install vitest run tests/hud.test.ts tests/session-v2.test.ts` (15 PASS: `tests/hud.test.ts` 3, `tests/session-v2.test.ts` 12) проверяет знаки горизонта NED, эквивалентность `q`/`-q`, отказ demo от подделанных флагов EKF, отсечку по инновациям и устаревание по возрасту. `npx --no-install playwright test tests/browser/hud.spec.ts tests/browser/serial-permission.spec.ts tests/browser/instructor.spec.ts` (8 PASS в headless Chromium 141) проверяет неизвестный статус demo, CRC-валидные эталонные кадры HEARTBEAT/EKF через `serial-io.worker.ts`, `EKF DEGRADED` для сырых флагов 167, `EKF flags valid` для сырых флагов 55, STALE после молчания дольше 1000 мс, не более 12 DOM-мутаций HUD за 1000 мс, возврат к demo truth после отключения, а также прежние регрессии serial-permission и instructor. `npm run typecheck`, `npm run lint` и `npm run build` завершаются с кодом 0.

### TASK-075 — Instructor console/hotkeys

- **Status:** DONE — Cursor; baseline ba4e37c; 2026-10-20. Редактируемые ID отказов принимает реестр РЭБ живой сессии, и статус applied появляется только после ACK тика Worker. Команды погоды и модели остаются отклонёнными. Катушка demo — не модель отдельных роторов, поэтому флаг motor-loss не меняет её единственную тягу.
- **Title & Description:** Инъецировать weather/fault/model commands с явным pending/applied state.
- **Dependencies:** TASK-010, TASK-038, TASK-058, TASK-074.
- **Touched Files:** `apps/web/src/instructor/Console.tsx`, `apps/web/src/instructor/hotkeys.ts`, `apps/web/src/instructor/commands.ts`, `apps/web/src/App.tsx`, `apps/web/src/runtime.ts`, `apps/web/src/style.css`, `tests/instructor.test.ts`, `tests/browser/instructor.spec.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** ControlCommandV2 request/ACK/epoch; scenario fault registry.
- **DoD & Acceptance Criteria:** Hotkeys не срабатывают при вводе в input; cancel/reset/stale epoch и rejection видны; кнопка не показывает applied до ACK; все fault IDs доступны без смены исходников.
- **Evidence:** Владелец Cursor; baseline ba4e37c; 2026-10-20. `tests/instructor.test.ts` (1 PASS) и `tests/session-v2.test.ts` (12 PASS) проверяют журнал ACK и то, что произвольный `fault.set` ставится в очередь, затем применяется и публикует `EwFlagV2.GnssJamming`, а `weather.set`, `model.load` и сессия без порта РЭБ остаются отклонёнными. `tests/browser/instructor.spec.ts` проверяет то же отклонение погоды, ACK применения отказа и подавление горячих клавиш при вводе в Chromium. Сброс очищает флаги РЭБ.

### TASK-076 — AAR recorder

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Ограниченная библиотека регистратора/производителя и прореженный поток demo; разветвление полной частоты в рабочем режиме не подключено.
- **Title & Description:** Записывать input/actuator/truth/sensor/events в отдельный bounded recorder.
- **Dependencies:** TASK-004, TASK-013, TASK-058.
- **Touched Files:** `packages/aar/package.json`, `packages/aar/src/format.ts`, `packages/aar/src/record.ts`, `packages/aar/src/handoff.ts`, `packages/aar/src/recorder.ts`, `packages/aar/src/recorder.worker.ts`, `packages/aar/src/recorder-host.ts`, `packages/aar/src/storage.ts`, `tests/aar-recorder.test.ts`, `tests/browser/aar.spec.ts`, `tests/support/aar-harness.ts`, `scripts/bench-aar.mjs`, `apps/web/src/runtime.ts`, `apps/web/package.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `tests/aar-storage.test.ts`.
- **Interfaces / Contracts:** AAR version/model hashes/seed/epoch/time domains; IndexedDB chunks/checksum.
- **DoD & Acceptance Criteria:** 30 min configured ring имеет фиксированный byte cap; slow storage/backpressure/loss explicitly counted; zero allocation в physics handoff; запись не использует 256-slot render ring как архив.
- **Evidence:** Владелец Codex/Claude; baseline 660d86e; 2026-10-16. `tests/aar-recorder.test.ts` (5 PASS), `tests/aar-storage.test.ts` (2 PASS) и `tests/browser/aar.spec.ts` (1 PASS) проверяют CRC ISO-HDLC (`cbf43926`), фиксированную ёмкость кольца `9 216 000` байт на 30 мин / 10 Гц, выделенный SAB передачи на 256 слотов и очередь всплесков IndexedDB `maxPending = 8` в `ChunkStorage` с подсчётом отброшенных при переполнении чанков. `node scripts/bench-aar.mjs 400|800|1200` (`test-results/bench/aar-400.json`..`1200.json`) проходит шесть окон `1e6`/`2e6` с 0 GC. Активная запись demo прореживается на Main с явными разрывами; разветвление полной частоты из физики/автопилота не подключено.

### TASK-077 — Replay и timeline

- **Status:** DONE — Codex; baseline 660d86e; 2026-10-16. Воспроизведение снимков и интерфейс сравнения ресимуляции с проверкой происхождения.
- **Title & Description:** Воспроизводить recorded snapshots отдельно от deterministic resimulation.
- **Dependencies:** TASK-015, TASK-076.
- **Touched Files:** `packages/aar/src/replay.ts`, `packages/aar/src/resimulation.ts`, `tests/aar-replay.test.ts`, `packages/aar/package.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** ReplayMode snapshots/resimulate; seek boundaries, config provenance.
- **DoD & Acceptance Criteria:** Seek/reset/epoch discontinuity корректны; unknown format/hash mismatch rejected; state replay identical records; resim mismatch даёт отчёт, не auto-rewrite recording.
- **Evidence:** Владелец Codex; baseline 660d86e; 2026-10-16. `tests/aar-replay.test.ts` (3 PASS) проверяет позиционирование в пределах эпохи, неизменяемые копии снимков, отклонение повреждённых данных/неверной версии/хеша, однократное продвижение тика при одновременных наблюдениях нескольких датчиков и формирование отчёта о расхождении без перезаписи архивов.

### TASK-078 — AAR response charts

- **Status:** DONE — Cursor; baseline 55a7c01; 2026-10-20. Единственный производитель записи — Worker физики. Каждый тик хранит истину и вход пилота, использованный на этом тике. Полезная нагрузка датчика или актуатора хранится только если тик уже владеет кадром. Архив 32 МиБ ограничивает окно полной частоты короче 30 минут. Графики по-прежнему прореживают ряд до 10000 точек.
- **Title & Description:** Сопоставлять stick input, actuator и физический отклик по одному времени.
- **Dependencies:** TASK-074, TASK-077.
- **Touched Files:** `apps/web/src/aar/Review.tsx`, `apps/web/src/aar/series.ts`, `tests/aar-series.test.ts`, `tests/browser/aar.spec.ts`, `apps/web/src/style.css`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Bounded decimated time series; units/timebase, known recording gaps.
- **DoD & Acceptance Criteria:** Known step-response fixture показывает правильный lag; gaps не интерполируются как реальные данные; 30 min log отображается с <=10000 points/series и bounded memory.
- **Evidence:** Владелец Codex; baseline 660d86e; 2026-10-16. `tests/aar-series.test.ts` (2 PASS) и `tests/browser/aar.spec.ts` проверяют совмещение ступеней ввода пилота/актуаторов/отклика на `0.2`/`0.3`/`0.4` с, неинтерполируемые сегменты разрывов и сохраняющее пики прореживание 30-минутной записи (`18 000` отсчётов) до `<=10 000` точек. `tests/session-v2.test.ts` записывает больше 8 тиков полной частоты без флага прореживания и один потреблённый кадр барометра. Пока идёт запись, сессия физики — единственный потребитель очереди датчиков.

### TASK-079 — Lessons/scenario runner

- **Status:** DONE — Cursor; baseline 6fa74a6; 2026-10-20. Событие сценария отправляется на своём тике симуляции с живой эпохой и новым request id. Binder считает отказ применённым только после ACK applied. Queued, отклонение погоды и пропущенный тик не считаются применением. Хеши-заглушки урока не сертифицируют борт.
- **Title & Description:** Описать сценарии тренировки декларативно и воспроизводимо.
- **Dependencies:** TASK-043, TASK-059, TASK-075, TASK-077.
- **Touched Files:** `packages/scenarios/package.json`, `packages/scenarios/src/schema.ts`, `packages/scenarios/src/runner.ts`, `tests/scenario-runner.test.ts`, `tests/fixtures/scenarios/pilot-basics.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `packages/scenarios/src/evaluate.ts`, `package-lock.json`, `scripts/bench-terrain-scenarios.mjs`.
- **Interfaces / Contracts:** Lesson goals/seed/model/firmware/events/rubric/version; no physics code in UI.
- **DoD & Acceptance Criteria:** Malformed/unsupported scenario rejected; same config emits same tick events; outcomes оцениваются по trace/thresholds, не таймеру; paused clock не начисляет sim-time penalty.
- **Evidence:** Владелец Codex; baseline c3a4735; 2026-10-17. `tests/scenario-runner.test.ts` и `node scripts/bench-terrain-scenarios.mjs 400|800|1200` (`test-results/bench/terrain-scenarios-400.json`..`1200.json`: 0 GC) проверяют допуск схемы `packages/scenarios/`, детерминированный опрос событий по тикам, обработку паузы без штрафа модельного времени и оценку рубрик по трассе на `tests/fixtures/scenarios/pilot-basics.json`. `tests/scenario-runner.test.ts` (5 PASS) проверяет одинаковые индексы тиков, паузу, рубрику, привязку эпохи, заявление applied только после ACK, живой ACK отказа с `EwFlagV2.GnssJamming` и запись отклонения погоды. Хеши-заглушки урока остаются несертифицированными.

### TASK-080 — Доступность и permissions UX

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Клавиатура, фокус, узкая раскладка, UX разрешений в demo и проверка axe без подавлений пройдены; TASK-075 выполнена. TASK-078 и ручные проверки экранного диктора/оборудования остаются открытыми.
- **Title & Description:** Обеспечить keyboard/focus/resize и понятные browser permission failures.
- **Dependencies:** TASK-005, TASK-048, TASK-075, TASK-078.
- **Touched Files:** `apps/web/src/ui/StatusMessage.tsx`, `apps/web/src/style.css`, `tests/browser/accessibility.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `apps/web/src/App.tsx`, `apps/web/src/SerialConnect.tsx`, `apps/web/src/aar/Review.tsx`, `apps/web/src/ui/focus.ts`, `tests/focus.test.ts`, `package.json`, `package-lock.json`.
- **Interfaces / Contracts:** Keyboard mapping vs instructor shortcuts, aria states, permission status.
- **DoD & Acceptance Criteria:** Keyboard-only основные действия доступны; focus restore после dialogs; 390px без overflow; permission denied не зацикливает запросы; automated accessibility scan plus manual checklist.
- **Evidence:** Владелец Codex; baseline c3a4735; 2026-10-17. `tests/focus.test.ts` и `tests/browser/accessibility.spec.ts` (2 PASS в Chromium) проверяют управление с клавиатуры, возврат фокуса после диалогов, раскладку узкого экрана 390 px без горизонтальной прокрутки, отсутствие зацикливания при отказе в разрешении Web Serial и ноль неподавленных нарушений axe. Остающиеся блокеры: завершение `TASK-078` и ручная проверка со вспомогательным экранным диктором и физическим оборудованием.

### TASK-081 — Экспорт сессий

- **Status:** DONE — Codex; baseline 660d86e; 2026-10-16. Ограниченные архивы с контрольными суммами, удалением чувствительных метаданных и импортом/экспортом в браузере.
- **Title & Description:** Экспортировать/импортировать AAR с manifest и без секретов.
- **Dependencies:** TASK-076, TASK-077.
- **Touched Files:** `packages/aar/src/archive.ts`, `apps/web/src/aar/Export.tsx`, `apps/web/src/App.tsx`, `tests/aar-archive.test.ts`, `tests/browser/aar.spec.ts`, `packages/aar/package.json`, `apps/web/package.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Versioned archive, size/checksum limits; redact keys/serial identifiers as configured.
- **DoD & Acceptance Criteria:** Export→import roundtrip; zip bomb/oversized/invalid hash rejected до allocation; API keys/tokens отсутствуют в archive; пользователь видит размер/типы данных.
- **Evidence:** Владелец Codex; baseline 660d86e; 2026-10-16. `tests/aar-archive.test.ts` (2 PASS) и `tests/browser/aar.spec.ts` проверяют валидацию SHA-256 заголовка+манифеста+полезной нагрузки и по-записного CRC, отклонение до выделения памяти архивов свыше `32` МиБ или метаданных свыше `4096` байт, вырезание API-ключей/серийных идентификаторов и цикл экспорта/импорта в браузере без замены активного состояния полёта.

### TASK-082 — Сквозной acceptance matrix

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Привязанная к хешам системная матрица по режимам реализована; открытые зависимости (TASK-033, 073, 080) и невыполненные аппаратные/режимные гейты удерживают системную приёмку заблокированной. TASK-051 — предложение версии 2 и не является зависимостью. TASK-074, TASK-075 и TASK-079 выполнены и не закрывают этот гейт.
- **Title & Description:** Запустить поддерживаемые режимы со всеми UI/physics/telemetry gates.
- **Dependencies:** TASK-033, TASK-042, TASK-043, TASK-047, TASK-059, TASK-073, TASK-074, TASK-075, TASK-078, TASK-079, TASK-080, TASK-081.
- **Touched Files:** `tests/integration/system-acceptance.test.ts`, `docs/validation/system-matrix.json`, `scripts/validate-release.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** G0..G4; device/mode/model/firmware/provider coverage.
- **DoD & Acceptance Criteria:** По каждому требованию PASS/FAIL/BLOCKED/NOT_RUN с evidence; 60/120 FPS и 400/800/1200 Hz не выводятся из unit tests; WASM/HITL/Google omissions явно block соответствующий mode.
- **Evidence:** Владелец Codex; baseline c3a4735; 2026-10-17. `scripts/validate-release.mjs`, `docs/validation/system-matrix.json` и `tests/integration/system-acceptance.test.ts` проверяют агрегацию статусов `G0`–`G4` по режимам (`test-results/laptop/system-report.json` завершается с кодом 1, сохраняя наблюдаемые `FAIL` валидации моделей `G2` и `FAIL` времени кадра GPU `G3` отдельно от невыполненных аппаратных/режимных гейтов `NOT_RUN`). Зависимости `TASK-042`, `TASK-043`, `TASK-059`, `TASK-074`, `TASK-075` и `TASK-081` имеют статус `DONE`; `TASK-033`, `TASK-073` и `TASK-078`/`080` остаются открытыми. `TASK-051` отложена в версию 2 и не является гейтом версии 1.

### TASK-083 — Release provenance и runbook

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Ограниченный инвентарь артефактов/лицензий/хешей и эксплуатационный runbook восстановления реализованы; заблокировано зависимостью TASK-082, проверкой лицензий наборов данных/артефактов и проверкой на чистой машине.
- **Title & Description:** Сформировать проверяемый release bundle и инструкции запуска/восстановления.
- **Dependencies:** TASK-003, TASK-082.
- **Touched Files:** `docs/operations/runbook.md`, `docs/operations/release-manifest.schema.json`, `scripts/release-manifest.mjs`, `tests/release-manifest.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `docs/ru/runbook.md`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Source/artifact/dataset/toolchain hashes, licences, supported capability matrix.
- **DoD & Acceptance Criteria:** Clean-machine build/install/start проверены; rollback и process cleanup описаны; отчёт содержит реальные blocked gates; никаких deploy/push автоматически без разрешённого scope.
- **Evidence:** Владелец Codex; baseline c3a4735; 2026-10-17. `scripts/release-manifest.mjs`, `docs/operations/release-manifest.schema.json`, [runbook.md](runbook.md) и `tests/release-manifest.test.ts` проверяют инвентаризацию SHA-256 артефактов/исходников/тулчейна и явную блокировку непроверенных лицензий `UNREVIEWED` (`test-results/laptop/release-manifest.json` инвентаризирует 11 файлов сборки / `1 855 274` Б и завершается с кодом 1, пока остаются открытыми `TASK-082` и проверки лицензий/чистой машины).

## Текущая сводка верификации и аппаратных проб

* **Программные и нативные тестовые наборы (2026-10-19):** `npm run lint`, `npm run typecheck`, `npm run check:docs` и `npm run build` завершаются с кодом 0. Набор юнит-тестов: `540` PASS в `97` файлах (`test-results/validation/task-045-unit.xml`, `test-results/validation/task-059-tests.json`). Нативный workspace Rust (`cargo test --manifest-path native/Cargo.toml --workspace --locked`, Rust `1.97.0`): `62` PASS плюс нативный контактный ABI (`native/contact`: `4` PASS). Браузерный набор Playwright: `50` PASS в программном Chromium (1 пропуск WebGPU на SwiftShader), `6/6` PASS на аппаратном WebGPU RTX 4050 (`test-results/laptop/browser-render-gpu.xml`) и `8/8` PASS для Worker/EEPROM ArduCopter WASM (`test-results/validation/task-045-browser.xml`).
* **Отчёты аллокаций горячего пути G1:** Ноль наблюдаемых событий GC и ноль добавочных Б/шаг на прогретых окнах `1e6`/`2e6` шагов в `test-results/bench/physics.json`, `test-results/bench/wind.json`, `test-results/bench/sensors-ideal.json`, `test-results/bench/sensors-all.json`, `test-results/bench/sensors-body.json`, `test-results/bench/contact.json`, `test-results/bench/jsbsim-400.json`, `test-results/bench/links-ew-all-400.json`..`1200.json`, `test-results/bench/aar-400.json`..`1200.json` и `test-results/bench/terrain-scenarios-400.json`..`1200.json`. На Windows Node (`test-results/laptop/bench-physics-400.json`, `bench-physics-800.json`, `bench-physics-1200.json`) прогон `bench-physics` в реальном времени выполнил 516.7 Гц (цель 800) и 519.6 Гц (цель 1200) с потерями: пробуждения таймера ~16 мс × лимит догоняющих шагов 8. Вычисление занимает ~1 мкс/шаг; регрессия браузерного Worker на 800 Гц пройдена.
* **Захваты движков, SITL и оборудования:**
  * Контакт и сопряжение с рельефом (`TASK-029`, `TASK-065`): `test-results/validation/task-029-completion.json`, `test-results/validation/task-029-binding.json`, `test-results/bench/contact-native-patched.json`.
  * JSBSim v1.2.3 WASM, контакт и пропеллеры UIUC (`TASK-030`, `TASK-031`, `TASK-086`): `test-results/validation/jsbsim-artifact.json`, `test-results/validation/task-031-native.json`, `test-results/validation/task-031-backend.json`, `test-results/validation/task-031-completion.json`, `test-results/validation/jsbsim-propellers.json`.
  * Валидация моделей (`TASK-033`): `test-results/validation/model-report.json`, `test-results/validation/nasa-drop-legacy.json`, `test-results/validation/propeller-points.json`, `test-results/validation/propeller-bem.json`, `test-results/validation/task-033-continuation.json` (12/12 численных PASS; сброс NASA отложен с сохранением непрошедшего архива; достоверность пропеллеров UIUC при фиксированных допусках FAIL, код 2).
  * Нативный ArduCopter SITL, `LiveEkfWarmup` и регрессии отказов РЭБ (`TASK-042`, `TASK-043`, `TASK-059`): `test-results/validation/task-042-flight.json`, `test-results/validation/task-042-completion.json`, `test-results/validation/task-043-warmup.json`, `test-results/validation/task-043-completion.json`, `test-results/validation/task-059-native.json`, `test-results/validation/task-059-flight-regression.json`.
  * Сборка ArduCopter WASM и запуск Worker/EEPROM (`TASK-045`): `test-results/validation/task-045-completion.json`, `test-results/validation/task-045-wire-audit.json`.
  * Локальные пробы оборудования и ноутбука (`TASK-048`, `TASK-050`, `TASK-073`, `TASK-082`, `TASK-083`): пассивный USB-захват MAVLink2 от Matek H743-WING (`ArduCopter V4.5.7`) на `COM7` в `test-results/hardware/serial-com7-matek.json`; пробы Windows 11 / RTX 4050 Laptop GPU в `test-results/laptop/summary.json`, `test-results/laptop/gpu-rtx4050-60.json`, `test-results/laptop/gpu-rtx4050-120.json`, `test-results/laptop/gpu-rtx4050-native144.json`, `test-results/laptop/system-report.json` и `test-results/laptop/release-manifest.json`. Решение по времени кадра Apple M4 и разрыв показа на 2560×1440 записаны в TASK-073; снимок оператора лежит в `task_073_results/`. Операционные команды и настройка окружения описаны в [runbook.md](runbook.md) и [V2_PLAN.md](V2_PLAN.md).
