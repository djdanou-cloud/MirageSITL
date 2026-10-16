# PROJECT_ROADMAP.md

<!-- source-sha256: 9995bfc3007d3415f729a8eb71e72f905ab913be2f851af6f15e97772b44c18e -->

Английский источник: [Source of truth](../PROJECT_ROADMAP.md). Изменения спецификации обновляют оба языка в одной задаче.


Версия 1.0 · 2026-10-15 · baseline `e3bb6b4`. Документация не объявляет будущие
модули реализованными. Сейчас есть demo React/Worker/SAB v1/Gamepad, 400 Гц
integration dt и 13 unit + 4 browser tests. Исторические DONE ниже ссылаются
на эту проверку, а не на несуществующие расширения.

Контракты: [Shared Memory](SPECS_SHARED_MEMORY.md),
[Simulation Engines](SPECS_SIMULATION_ENGINES.md), [Agent workflow](CLAUDE.md).
При расхождении v1 source — истина о текущем коде, v2 spec — цель миграции.
Другие runtime изменения не входят в текущую документационную задачу.

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
  60 s warmup + 10 min замер. 60 FPS profile p99 frame<=16.67 ms; 120 FPS
  profile p99<=8.33 ms. Не требовать 120 FPS от software-headless browser.
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
| 0 Skeleton | S00a: 001,002,084; S00b: 003,004,005,006 | reproducible workspace, lint/CI/config gates |
| 1 Shared Memory & Worker | S01a: 007,008,009; S01b: 010,011,012; S01c: 013,014,015,085 | ABI v2, clocks, transport and profiling |
| 2 Aerodynamics & WASM | S02a: 016,017,018; S02b: 019,032,020; S02c: 021,022,023; S02d: 024,025,026; S02e: 027,028,029; S02f: 030,031,033 | BET/JSBSim backend and declared validity |
| 3 ArduPilot & Radio Link | S03a: 034,035,036,037; S03b: 038,039,040,041; S03c: 042,043; S03d: 044,045,046,047; S03e: 048,049,050,051 | per-mode SITL/WASM/HITL evidence |
| 4 EW & Sensor Faults | S04a: 052,053,054; S04b: 055,056,057; S04c: 058,059 | deterministic sensor faults + pinned EKF scenarios |
| 5 Environment & Shaders | S05a: 060,061,062; S05b: 063,064,065; S05c: 066,067,068; S05d: 069,070,071,072; S05e: 073 | licensed terrain, render profiles, target GPU gates |
| 6 UI & Telemetry | S06a: 074,075; S06b: 076,077,078; S06c: 079,080,081; S06d: 082,083 | training/AAR and evidence-backed release matrix |

WASM ArduPilot feasibility и HITL compatibility — обязательные отдельные
gates. Если они заблокированы, продолжить независимые задачи, но не
объявлять полную Phase 3/проект DONE. Google persistent caching не считается
разрешённым требованием: TASK-060 фиксирует licensing decision; TASK-064
работает с разрешённым dataset, например собственными tiles. Исходная цель
10–15 km остаётся параметром регионального cache, не оправданием копирования
Google content без прав.


## Локальная проверка пакета: TASK-025–031 и TASK-033–035

2026-10-16; ответственный Codex; база 8f7dc19 с сохранённой локальной TASK-024.
Шесть задач DONE (025–028, 034–035); 029 — BLOCKED_DECISION, 030/031/033 —
BLOCKED_EXTERNAL. Проходящие юнит-тесты проверяют сохранение запрета этих допусков.
Итоговые локальные коды нулевые для frozen npm ci, lint, typecheck, check:docs,
build, 230 юнит-тестов (35 файлов), 17 браузерных тестов Chromium, 45 нативных
тестов, cargo check native/wasm32 и release-пробы аллокатора на миллион шагов.
JUnit: test-results/unit/junit.xml и test-results/browser/junit.xml; ошибок,
провалов и пропусков нет. Production-сборка сохраняет прежнее предупреждение о
крупном chunk. SHA-256 lockfile f2199316bc61fd3cdc3cf1017e5884942aa51443ca6d126820e48925db1495d7.

Node 24.19.0, Rust 1.97.0, Chromium 154.0.8037.57, Debian x86_64/software GPU;
CARGO_HOME=/workspace/.cache/mirage-cargo, RUSTUP_HOME=/workspace/.cache/mirage-rustup,
Cargo bin активирован в PATH. Производительность M4/RTX и hosted Actions не заявлены.
Отчёты аллокаций ideal/all/body имеют ноль GC и добавочных B/step; положительный
контроль обнаруживает аллокации. Контактная проба использует тот же закреплённый
провайдер 0.21.0, что и адаптер, исключая постороннюю транзитивную версию.
Модельный отчёт: 12 численных случаев PASS, максимальная ошибка позиции
1.624e-10 м, ориентации 0 рад; общий/fidelity BLOCKED и CLI-код 2. Хеш эталона
9f89eab73cd16e7f7296744b40a9389d5bff17f04f947f3473f0067b96bce142.
Повторная нативная сборка/smoke JSBSim возвращают 0; проверка предпосылок WASM
возвращает 2 из-за отсутствия закреплённого SDK. EN/RU-текст, уравнения, пути и
хеши синхронизированы и проверены. Изменения локальные; commit/push не выполнялись.

## Phase 0: Skeleton

### TASK-001 — Зафиксировать работающий skeleton

- **Status:** DONE — revalidated against baseline c8814c6.
- **Title & Description:** Сохранить существующий React/Vite workspace и воспроизводимый demo flight.
- **Dependencies:** нет.
- **Touched Files:** `package.json`, `package-lock.json`, `apps/web/vite.config.ts`, `README.md`.
- **Interfaces / Contracts:** React 19, Vite, npm workspaces; COOP/COEP.
- **DoD & Acceptance Criteria:** DONE baseline e3bb6b4: npm ci, npm run build, 13 unit и 4 browser tests ранее пройдены; чистая установка не меняет lockfile.
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. Чистый npm ci сохранил SHA-256 lockfile; build exit 0; 25 unit и 4 browser tests прошли без skips/failures.


### TASK-002 — Типизация и lint gate

- **Status:** DONE — implemented and locally verified.
- **Title & Description:** Добавить отдельные команды typecheck/lint и исключить explicit/implicit unsafe any, включая browser dynamic import.
- **Dependencies:** TASK-001.
- **Touched Files:** `package.json`, `package-lock.json`, `eslint.config.mjs`, `tsconfig.json`, `tests/browser/simulation.spec.ts`, `tests/tooling.test.ts`, `tests/fixtures/tooling/unsafe-types.txt`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** unknown + runtime narrowing; strict/noUncheckedIndexedAccess; typed module imports.
- **DoD & Acceptance Criteria:** npm run lint и npm run typecheck выполняются; negative lint fixture с explicit any и unsafe assignment отклоняется; не ослаблять strict ради existing кода.
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. ESLint 10/typescript-eslint typed rules проходят без подавлений; npm run lint и npm run typecheck: exit 0. tests/tooling.test.ts: 3 PASS, проверены отрицательные any/unsafe fixtures и TS2322. Полный suite: 25 unit и 4 browser PASS.


### TASK-003 — Автоматический CI

- **Status:** BLOCKED_EXTERNAL — implementation complete; hosted-run verification unavailable.
- **Title & Description:** Запускать проверки на pull request без зависимости от аппаратуры или платных API.
- **Dependencies:** TASK-002.
- **Touched Files:** `.github/workflows/ci.yml`, `playwright.config.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package.json`, `package-lock.json`, `vitest.config.ts`, `.gitignore`, `tests/ci.test.ts`.
- **Interfaces / Contracts:** Node 24, frozen npm lock; отдельно unit/browser/build jobs.
- **DoD & Acceptance Criteria:** CI запускает ненулевое число тестов, сохраняет результаты/trace при ошибке; no-tests и failed job дают failure; секреты не нужны для synthetic lane.
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. Созданы три независимых CI jobs; tests/ci.test.ts: 3 PASS, оба runner отклоняют zero-test runs. Локальные CI команды прошли: 25 unit, 4 browser, production build. Reports: test-results/unit/junit.xml и test-results/browser/junit.xml без skips/failures; build.log и apps/web/dist созданы. GitHub Actions API недоступен: proxy CONNECT 403; после push проверить первый hosted run. Synthetic jobs не требуют credentials или аппаратуры. Проверка hosted CI (Claude, 2026-10-15): GitHub Actions теперь создаёт запуски, но каждая job завершается ошибкой без выполнения. Запуски 38804503643 (c26df78, push), 38806524546 (f13213b, push) и 38808881935 (1064a57, pull request djdanou-cloud/MirageSITL#1): все три job (unit, build, browser) завершились с failure через 2-3 s после старта, без шагов и без доступного лога (HTTP 404). Такая картина означает, что hosted runners не запускались (например, блокировка Actions из-за оплаты/лимита расходов или отключённые Actions), а не ошибку workflow или тестов. Разблокировка: владелец репозитория проверяет оплату аккаунта GitHub и настройки Actions репозитория, затем перезапускает workflow; изменения кода не требуются.


### TASK-004 — Golden fixtures и seed registry

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Создать общий формат эталонов с provenance и детерминированным PRNG.
- **Dependencies:** TASK-002.
- **Touched Files:** `packages/test-support/package.json`, `packages/test-support/src/fixtures.ts`, `packages/test-support/src/prng.ts`, `tests/fixtures.test.ts`, `tests/fixtures/registry.json`, `package-lock.json`, `tests/fixtures/ballistic.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** FixtureManifest {id, sourceSha256, units, validityEnvelope, tolerance}; PRNG algorithm/version.
- **DoD & Acceptance Criteria:** Известный seed даёт frozen sequence; разные stream IDs независимы; неверные units/hash отклоняются; ни один synthetic fixture не помечен experimental measurement.
- **Evidence:** Владелец Codex; baseline c26df78; 2026-10-15. tests/fixtures.test.ts: 4 PASS. Seed 123 / stream 7 совпадает с закреплённым вектором mulberry32-mix32-v1; проверены раздельные состояния/reset/нулевой seed и границы float. Проверены оба hash точных байтов, отклонение неверных units/envelope/tolerance и различение provenance. Fixtures явно синтетические.

### TASK-005 — Runtime capability gate

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Определять SAB/WebGL2/WebGPU/Gamepad/Serial и выдавать доступные режимы без ложного READY.
- **Dependencies:** TASK-001, TASK-002.
- **Touched Files:** `apps/web/src/capabilities.ts`, `apps/web/src/App.tsx`, `tests/capabilities.test.ts`, `tests/browser/capabilities.spec.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** CapabilityReport; mode eligibility.
- **DoD & Acceptance Criteria:** Mock каждого отсутствующего API даёт понятный disabled state; отсутствие isolation блокирует worker; WebGPU failure сохраняет WebGL2 fallback.
- **Evidence:** Владелец Codex; baseline c26df78; 2026-10-15. tests/capabilities.test.ts: 7 PASS; tests/browser/capabilities.spec.ts: 7 PASS на системном Chromium 154. Без secure context/isolation/SAB/Worker/WebGL2 Start отключён; без Gamepad отключён USB. Rejected/absent/timed-out GPU probes сохраняют WebGL2. Наличие API не включает будущие HITL/WebGPU modes.

### TASK-006 — Model manifest schema

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Валидировать модели/рама/единицы/hash и версию конфигурации до загрузки.
- **Dependencies:** TASK-004.
- **Touched Files:** `packages/physics/src/model-manifest.ts`, `packages/physics/src/model.schema.json`, `tests/model-manifest.test.ts`, `tests/fixtures/models/demo-quad.json`, `packages/physics/package.json`, `package-lock.json`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** ModelDescriptor, RotorGeometry, registry modelId→SHA; SPD inertia.
- **DoD & Acceptance Criteria:** Positive/negative fixtures: NaN, масса<=0, не-SPD inertia, duplicate motor IDs, rotorCount>32 и invalid quaternion отвергаются; hash проверяется до swap.
- **Evidence:** Владелец Codex; baseline c26df78; 2026-10-15. tests/model-manifest.test.ts: 4 PASS. Проверены schema/frame/units/count/NaN, симметричная положительно определённая inertia, уникальность IDs/channels, quaternion и элементы. Raw SHA-256 проверяется до допуска в реестр; ошибки hash/schema/collision сохраняют существующую модель. Изменение bytes во время hashing не меняет проверенный снимок. Переключение runtime остаётся TASK-010.

### TASK-084 — Обнаружение правил агентами

- **Status:** DONE — Claude; baseline 1064a57; 2026-10-15.
- **Title & Description:** Добавить тонкие entry points, которые направляют Codex/Cursor к единому CLAUDE.md.
- **Dependencies:** TASK-001.
- **Touched Files:** `AGENTS.md`, `.cursor/rules/project.mdc`, `tests/agent-config.test.ts`, `docs/ru/AGENTS.md`, `docs/documentation-index.json`, `tests/documentation-policy.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** CLAUDE.md — единый источник workflow; wrapper содержит ссылку, не копию правил.
- **DoD & Acceptance Criteria:** Проверка читает оба entry point и разрешает root CLAUDE.md; Cursor rule alwaysApply=true; тест не утверждает автоматическое чтение файла любым неизвестным клиентом.
- **Evidence:** Владелец Claude; baseline 1064a57; 2026-10-15. AGENTS.md (зарегистрированная пара EN/RU, поскольку check:docs требует пары для каждого Markdown-файла) и .cursor/rules/project.mdc ссылаются на корневой CLAUDE.md, не копируя его разделы правил; front matter Cursor задаёт alwaysApply: true. tests/agent-config.test.ts: 3 PASS (обе ссылки разрешаются в корневой CLAUDE.md, нет дублированных заголовков правил, нет утверждения, что названный клиент загружает файл автоматически). tests/documentation-policy.test.ts теперь вычисляет ожидаемое число пар и задач из реестра и roadmap вместо жёстко заданных чисел. Абзац CLAUDE.md об обнаружении правил и все затронутые зеркала синхронизированы; npm run check:docs exit 0.

## Phase 1: Shared Memory & Worker

### TASK-007 — Закрепить ABI v1 baseline

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Сохранить существующие reader/writer и lifecycle regression как исходную точку миграции.
- **Dependencies:** TASK-001.
- **Touched Files:** `packages/protocol/src/index.ts`, `tests/protocol.test.ts`, `tests/protocol-golden.test.ts`, `tests/fixtures/abi/v1-layout.json`, `tests/fixtures/registry.json`, `tests/browser/simulation.spec.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** v1: 32896 bytes, 128-byte states, 400 Hz.
- **DoD & Acceptance Criteria:** DONE baseline e3bb6b4: существующие 4 protocol tests проверяют size/version, float64 roundtrip, ring overwrite, busy frame и controls; lifecycle проверен браузером.
- **Evidence:** Владелец Codex; baseline c26df78; 2026-10-15. tests/protocol.test.ts: 4 PASS, включая закреплённый размер 32896 байт, смещения header/mailbox и независимо упакованный golden состояния 128 байт. Все четыре прежних simulation browser tests пройдены: настоящий Worker fixed dt, устаревший ввод, lifecycle ACKs, USB failsafe и mobile layout. V1 сохранён; runtime v2 не добавлен. Полная проверка: frozen npm ci, npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 40 PASS; CI=true CHROMIUM_PATH=/usr/bin/chromium npm run test:browser: 11 PASS; без failures/skips. JUnit: test-results/unit/junit.xml и test-results/browser/junit.xml. Node 24.19.0, Chromium 154.0.8037.57, Debian cloud/software rendering. README, architecture и roadmap синхронизированы EN/RU. Производительность целевых GPU/оборудования не заявляется. Дополнение golden layout: владелец Claude; baseline f13213b; 2026-10-15. tests/protocol-golden.test.ts: 4 PASS. Зарегистрированный синтетический fixture abi-v1-layout (tests/fixtures/abi/v1-layout.json, SHA-256 00a2e97d75521263f4348199c5e0086dd720949cffc92185cdaf97fbd1fd8be0, tolerance 0) поле за полем сверяется с таблицами Header/State/Pilot mailbox v1 в SPECS_SHARED_MEMORY.md и сравнивается со всеми 32896 байтами, записанными StateWriter и ControlWriter, без использования readers v1. Мутационные проверки: симметричная перестановка roll/pitch в mailbox прошла все прежние тесты и провалила только этот тест; симметричная перестановка spool/voltage в state и перестановка строки спецификации также провалились. npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 44 PASS; CI=true npm run test:browser: 11 PASS с Playwright Chromium build 1194. Node 22.22.0 (контейнер; .nvmrc требует 24). Существовавшая ранее проблема: typed ESLint случай в tests/tooling.test.ts занимает 4.3-4.6 s при timeout 5 s по умолчанию и один раз превысил его в пяти полных прогонах, независимо от этого изменения.

### TASK-008 — Константы и layout ABI v2

- **Status:** DONE — Claude; baseline 695023c; 2026-10-15.
- **Title & Description:** Ввести v2 отдельно от v1 и golden двоичный fixture.
- **Dependencies:** TASK-006, TASK-007.
- **Touched Files:** `packages/protocol/src/layout-v2.ts`, `packages/protocol/src/state-v2.ts`, `tests/layout-v2.test.ts`, `tests/fixtures/protocol/state-v2.hex`, `packages/protocol/src/pilot-v2.ts`, `packages/protocol/src/index.ts`, `tsconfig.json`, `tests/support/spec-layout.ts`, `tests/support/golden-v2.ts`, `tests/protocol-golden.test.ts`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY §3; 49280 bytes; state stride 192, TickId lo/hi.
- **DoD & Acceptance Criteria:** Все поля покрыты offset/size/alignment tests; golden побайтово совпадает; v1 не проходит v2 validation; reserved words нули.
- **Evidence:** Владелец Claude; baseline 695023c; 2026-10-15. tests/layout-v2.test.ts: 11 PASS. Зарегистрированный синтетический fixture abi-v2-golden (tests/fixtures/protocol/state-v2.hex, упакован Python struct по таблицам раздела 3 независимо от TypeScript encoder, tolerance 0) поле за полем совпадает с таблицами Header v2, State v2 и Pilot mailbox v2 при полном покрытии байтов; StateOffsetV2, PilotOffsetV2 и HeaderV2 покрывают все поля; естественное выравнивание соблюдается во всех 256 слотах; StateCodecV2/PilotCodecV2 упаковывают golden значения в golden байты и декодируют их обратно; createSharedMemoryV2 записывает golden header при нулевых ring и mailbox; проверка отклоняет буферы v1 и 13 искажённых слов header; negotiateAbiVersion возвращает 1/2 и отклоняет буфер размера v1 с версией 2; перенос tick, сравнение и граница 2^53; контракты значений на стороне writer. Мутационные проверки: симметричная перестановка смещений напряжения/тока батареи и изменение типа в спецификации проваливают тесты. Сверх перечисленных файлов: pilot-v2.ts (mailbox v2 входит в тот же layout), реэкспорт в index.ts и tsconfig allowImportingTsExtensions (модули protocol используют импорты .ts, чтобы Node workers загружали их для TASK-009). Общий парсер спецификации теперь используется и в golden-тесте v1. npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 58 PASS. Node 22.22.0. Runtime по-прежнему использует v1; спецификация, README, architecture и roadmap синхронизированы EN/RU.

### TASK-009 — Атомарные v2 reader/writer

- **Status:** DONE — Claude; baseline 0cc6d4c; 2026-10-15.
- **Title & Description:** Реализовать bounded seqlock, публикацию sample_id и epoch-safe render history.
- **Dependencies:** TASK-008.
- **Touched Files:** `packages/protocol/src/atomic-v2.ts`, `packages/protocol/src/index.ts`, `tests/atomic-v2.test.ts`, `tests/browser/atomic-v2.spec.ts`, `tests/support/atomic-v2-stress.ts`, `tests/support/atomic-v2-stress.node-worker.ts`, `tests/support/atomic-v2-stress.browser-worker.ts`, `tests/tooling.test.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** StateWriterV2/StateReaderV2; single writer; max 3 read attempts.
- **DoD & Acceptance Criteria:** 1e6 concurrent publications без torn fields; interrupted writer возвращает miss без изменения output; counters/epochs/reset проверены; v1 tests сохранены до явного удаления compatibility.
- **Evidence:** Владелец Claude; baseline 0cc6d4c; 2026-10-15. tests/atomic-v2.test.ts: 9 PASS: golden state публикуется как seqlock 2 плюс golden bytes с sample_id=published; состояния, нарушающие контракт, отклоняются без изменения общей памяти; переход ring и чтение по age; кадр, прерванный посреди записи, и несовпадение sample_id/head дают miss без изменения выхода; счётчики, runtime flags, epoch и частота; latestPair не связывает кадры через смену epoch, модели или пропуск tick, но связывает через перенос 32-битного tick; pilot mailbox round trip и miss при занятом mailbox; буферы v1 отклоняются. Конкурентность: 1e6 публикаций из writer в Node worker_threads при reader, чередующем новейший и старейший (перезаписываемый) слоты: 272286 успешных чтений, 0 разорванных, 0 NaN, 0 регрессий; tests/browser/atomic-v2.spec.ts в module Worker Chromium: 611561 чтение, 0 разорванных. Мутационные проверки: удаление повторной проверки seqlock дало разорванные кадры (3647 в браузере) и провалило оба стресс-теста; удаление проверки sample_id провалило детерминированный тест несовпадения head. tests/tooling.test.ts: случай typed lint получил явный timeout 30 s, поскольку стресс-тест вывел его за 5 s по умолчанию (измерено 5.1-6.1 s). npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 67 PASS в трёх подряд прогонах; CI=true npm run test:browser: 12 PASS (Playwright Chromium build 1194). Node 22.22.0. apps/web/src/runtime.ts и physics.worker.ts не переведены: WorkerInitV2 требует sensor/actuator buffers из TASK-013, поэтому миграция вынесена в новую TASK-085 вместо заглушки. Тесты v1 сохранены.

### TASK-010 — Control Protocol v2

- **Status:** DONE — Claude; baseline 3b1711b; 2026-10-15.
- **Title & Description:** Валидировать lifecycle, weather, model и fault commands и детерминированные ACK.
- **Dependencies:** TASK-008, TASK-009.
- **Touched Files:** `packages/protocol/src/control-v2.ts`, `packages/protocol/src/control-v2.schema.json`, `tests/control-v2.test.ts`, `packages/protocol/src/index.ts`, `package.json`, `package-lock.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY §6; unknown→ControlCommandV2; queued/applied/reject.
- **DoD & Acceptance Criteria:** Каждая ветвь имеет positive/negative fixture; stale epoch, duplicate ID, past tick и очередь 128+1 отклоняются; failed model swap сохраняет прежнюю paused модель.
- **Evidence:** Владелец Claude; baseline 3b1711b; 2026-10-15. tests/control-v2.test.ts: 72 PASS. 60 fixture проверки покрывают каждую ветвь команд и эффектов (положительные и отрицательные: форма, лишние/отсутствующие свойства, NaN/Infinity/undefined, нецелые числа, enums, patterns, границы u32, каждый числовой диапазон, норма дрейфа, лимит 16 KiB); JSON Schema (Ajv 8.18.0, Ajv2020 strict) совпадает с валидатором TypeScript во всех 55 случаях, представимых в JSON, кроме задокументированного правила нормы дрейфа; JSON-пример из спецификации принимается. Обработчик: ACK lifecycle-команд и правила paused+disarmed, STALE_EPOCH, повтор точного дубликата без повторного применения после смены epoch, повторное использование ID с другим payload, вытеснение high-water после 128 ID, некорректные команды не расходуют ID, отклонение прошедшего tick и горизонта 10 s, применение перед tick в порядке получения с ACK queued, затем applied, очередь 128+1 с OVERLOAD при сохранении старых команд, отмена при reset/dispose, неудачная смена модели (ASSET_MISSING, прежние модель и epoch сохранены, пауза) против успешной (новая epoch), отсутствие commit после dispose. Мутационные проверки: удаление лимита очереди, применение на tick позже и commit при неудачной загрузке проваливают тесты. Ajv — только dev-зависимость (тесты); frozen npm ci воспроизводит lockfile. npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 139 PASS. Node 22.22.0. apps/web/src/physics.worker.ts не подключён (TASK-085). Обработка поздних/неупорядоченных ACK на Main относится к TASK-085; измерение аллокаций beforeTick — к TASK-014.

### TASK-011 — Частоты 400/800/1200

- **Status:** DONE — Claude; baseline 1e96582; 2026-10-16.
- **Title & Description:** Параметризовать scheduler и dt с рациональными sensor timestamps.
- **Dependencies:** TASK-010.
- **Touched Files:** `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `tests/clock.test.ts`, `tests/browser/simulation.spec.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** PhysicsHz; TickId; simTime=tick/hz, fixed dt.
- **DoD & Acceptance Criteria:** Fake clock за 10 s даёт 4000/8000/12000 шагов; нет accumulated dt drift; pause/resume не создаёт backlog; 1200 Hz time_usec имеет интервалы 833/834 μs.
- **Evidence:** Владелец Claude; baseline 1e96582; 2026-10-16. tests/clock.test.ts: 12 PASS. Пробуждения с seeded-дрожанием (0.05-1.5 ms) дают ровно 4000/8000/12000 шагов за 10 s без потерь, а следующий срок ровно 10 s + 1/hz; ограниченный catch-up учитывает 1192 отброшенных шага при 1200 Гц; возобновление после паузы 4 s без backlog; интервалы time_usec при 1200 Гц ровно {833, 834} мкс с суммой 1e6; точность через перенос 32-битного tick и NaN за пределом 2^53 мкс; расписания IMU 200/400 Гц и GNSS 5/10 Гц синхронизированы на каждой частоте; DemoDynamics сходится при уменьшении dt. Мутация: накопление округлённой длины шага вместо целочисленных сроков проваливает тест дрейфа на 1200 Гц. Browser-проверка fixed dt теперь использует определение спецификации sim_time = tick/hz. physics.worker.ts не изменён: Worker v1 сохраняет 400 Гц через FixedStepClock до TASK-085. npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 151 PASS; simulation browser spec 4 PASS. Node 22.22.0.

### TASK-012 — Clock modes и перегрузка

- **Status:** DONE — Claude; baseline be502a4; 2026-10-16.
- **Title & Description:** Разделить interactive drop, SITL lockstep wait и HITL fault policy.
- **Dependencies:** TASK-011.
- **Touched Files:** `packages/physics/src/clock-policy.ts`, `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `tests/clock-policy.test.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** interactive / sitl-lockstep / hitl-realtime; maxCatchUp=8.
- **DoD & Acceptance Criteria:** При 1 s stall interactive считает drop, SITL не пропускает sim tick, HITL помечает session invalid; pause/dispose обслуживаются даже при отсутствующем actuator.
- **Evidence:** Владелец Claude; baseline be502a4; 2026-10-16. tests/clock-policy.test.ts: 5 PASS. Остановка Worker на 1 s при 400 Гц учитывает 392 interactive-потери при непрерывных ticks; остановка autopilot на 1 s в sitl-lockstep задерживает, но сохраняет каждый tick (непрерывно, без потерь), а заблокированный Worker догоняет по 8 ticks за pump без отбрасывания; hitl-realtime допускает ограничение таймера 4 ms при 1200 Гц, но остановка на 1 s устанавливает hitl-overrun, после чего ничего не выполняется, и сбрасывается только resetEpoch; без кадров актуаторов 100000 lockstep-вызовов pump возвращаются сразу (одна проверка gate, без шага); каждый режим выполняет не более maxCatchUp=8 ticks за pump. Мутации: удаление fault HITL и wall-темп для SITL проваливают тесты. physics.worker.ts подключается в TASK-085. npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 156 PASS. Node 22.22.0.

### TASK-013 — Sensor/actuator SPSC

- **Status:** DONE — Claude; baseline aef7af6; 2026-10-16.
- **Title & Description:** Создать раздельные bounded queues со строгим владением и backpressure.
- **Dependencies:** TASK-008, TASK-009, TASK-012.
- **Touched Files:** `packages/protocol/src/spsc-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/spsc-v2.test.ts`, `tests/browser/spsc-v2.spec.ts`, `packages/protocol/src/index.ts`, `tests/support/spsc-stress.ts`, `tests/support/spsc-stress.node-worker.ts`, `tests/support/spsc-stress.browser-worker.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY §5; capacity=1024, stride=128.
- **DoD & Acceptance Criteria:** Full/empty/wrap и reset tested; unread slot никогда не затирается; 1e6 frames сохраняют порядок; overflow SITL/HITL обрабатывается policy, не silent drop.
- **Evidence:** Владелец Claude; baseline aef7af6; 2026-10-16. tests/spsc-v2.test.ts: 9 PASS: смещения/типы слота разобраны из таблицы раздела 5, смещения/magic header — из его текста; проверка размера/вида/ABI/reserved; pop из пустой очереди; 1024 push, затем дважды would-block при full_events=2 и все непрочитанные кадры целы и по порядку; переполнение HITL фиксирует faulted (даже после освобождения места) до resetSpscQueue, который очищает счётчики и продвигает epoch; порядок через переход счётчика uint32; codecs кадров по смещениям спецификации с round trip и отклонением 13 нарушений контракта датчиков и 5 — актуаторов. Конкурентность: 1e6 кадров от producer в Node worker_threads с повтором по политике SITL: получено 1000000, 0 вне порядка, 0 повреждённых, 0 недопустимых, full_events равны повторам would-block; tests/browser/spsc-v2.spec.ts в module Worker Chromium: получено 1000000, 0 вне порядка/повреждённых/недопустимых. Мутации: отключение проверки заполнения проваливает три теста; освобождение слота до копирования проваливает стресс-тест на реальных потоках. npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 165 PASS. Node 22.22.0. В приложении пока не подключены producer и consumer (TASK-085 создаёт буферы; I/O workers появляются с TASK-034+).

### TASK-014 — Измеритель hot path

- **Status:** DONE — Claude; baseline 920bd23; 2026-10-16.
- **Title & Description:** Добавить allocation/step/deadline профилирование с машинным отчётом.
- **Dependencies:** TASK-009, TASK-011, TASK-013.
- **Touched Files:** `packages/physics/src/step-metrics.ts`, `scripts/bench-physics.mjs`, `tests/step-metrics.test.ts`, `docs/benchmarks/schema.json`, `packages/physics/src/index.ts`, `packages/physics/src/clock.ts`, `packages/physics/src/clock-policy.ts`, `packages/physics/src/demo-dynamics.ts`, `packages/physics/src/session-v2.ts`, `packages/protocol/src/state-v2.ts`, `packages/protocol/src/pilot-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/layout-v2.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** G1/G3; отдельно compute duration, wakeup lateness и executed Hz.
- **DoD & Acceptance Criteria:** После warmup 1e6 шагов: explicit JS/WASM allocations=0, arena size постоянен; baseline report содержит p50/p95/p99/max и environment; profiler overhead измерен отдельно.
- **Evidence:** Владелец Claude; baseline 920bd23; 2026-10-16. node scripts/bench-physics.mjs (Node 22.22.0, V8 12.4, --expose-gc --max-semi-space-size=64) на реальном шаге PhysicsSessionV2 при 400 Гц: zeroAllocation=true в 8 из 8 последовательных прогонов, верхняя граница на шаг 0.00000 B по окнам без GC из 1e6 и 2e6 шагов, 0 событий GC, аллоцирующий контроль обнаружен в каждом прогоне; compute p50 около 1.0 мкс, p99 около 1.9 мкс (накладные расходы таймера около 0.1 мкс/шаг сообщаются отдельно); прогон в реальном времени в Node около 400 Гц выполнено, задержка пробуждения p99 около 0.6 мс. До исправления тот же инструмент нашёл 93 события GC на 1e6 шагов: вариадический Math.hypot (124 GC на 1e6 вызовов отдельно) и упаковку double в невстраиваемых вызовах (sampling heap profiler V8 с учётом собранных объектов обнаружил один HeapNumber 16 байт на шаг в isValidFlightStateV2), из-за чего результаты между процессами были бимодальными. Исправления: время передаётся через числовые поля, целочисленные задержки пробуждения, встроенные сравнения в валидаторах (тесты точной эквивалентности для границы f32 и проверки uint32). Мутация: один небольшой объект на tick меняет вердикт (22 GC). tests/step-metrics.test.ts: 3 PASS (квантили/overflow/max гистограммы, раздельные метрики, прогон bench на 1e6 шагов, проверенный по docs/benchmarks/schema.json с zeroAllocation=true); tests/layout-v2.test.ts +2. В JS нет arena (постоянство WASM arena относится к TASK-017/018). npm run lint, npm run typecheck, npm run check:docs exit 0. Утверждений о времени в browser Worker или на целевом оборудовании нет. Доработка после hosted CI (Node 24.22.0): граница по целому окну показала 0.014-0.022 B/шаг при 0 GC, так как Node 24 добавляет фиксированные ~34-44 KB на измеряемое окно независимо от N (одинаковые байты при 1e6/2e6 и 4e6/8e6 шагах), поэтому вердикт теперь использует приращение между окнами N и 2N; Node 24 — 4/4 прогона 0.00000-0.00354 B/шаг, Node 22 — 2/2 прогона 0.00006 B/шаг, порог не изменён (0.01); мутация с одним небольшим объектом на 800 шагов даёт 0.040-0.047 B/шаг при 0 GC и проваливает вердикт. Второй hosted-прогон всё ещё падал: на runner с 2 CPU установка заданий TurboFan из фоновых потоков выделяет 0-120 KB на окно в моменты, зависящие от нагрузки (воспроизведено локально через taskset -c 0,1 с параллельными тестами: 1/6, затем 3/6 ложных провалов). Теперь bench запускает V8 с --single-threaded и берёт минимум по 3 повторам без GC для каждого размера окна: 6/6 нагруженных прогонов Node 24 дают 0.00000 B/шаг при фиксированных затратах, равных накладным расходам пробы 3000 B, Node 22 — 0.00000; мутация с одним объектом на 800 шагов даёт ровно 0.04000 B/шаг (32 B / 800) и проваливается.

### TASK-015 — Интерполяция и смена epoch

- **Status:** DONE — Claude; baseline db50e9a; 2026-10-16.
- **Title & Description:** Поддержать плавный renderer без интерполяции через reset/model swap.
- **Dependencies:** TASK-009, TASK-011.
- **Touched Files:** `apps/web/src/FlightScene.tsx`, `apps/web/src/coordinates.ts`, `packages/protocol/src/interpolation.ts`, `tests/interpolation.test.ts`, `packages/protocol/src/index.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Adjacent tick + same epoch/model, shortest-path quaternion SLERP.
- **DoD & Acceptance Criteria:** q и -q не дают полный оборот; NED basis tests проходят; reset/teleport разрывает history; renderer не ждёт writer и не изменяет truth.
- **Evidence:** Владелец Claude; baseline db50e9a; 2026-10-16. tests/interpolation.test.ts: 6 PASS относительно независимого оракула ось-угол: линейная позиция и ориентация по большой окружности при t=0/0.25/0.5/0.75 с точностью 1e-12 рад; q против -q не даёт вращения, а малое вращение с инвертированным знаком интерполируется на малый угол; нет интерполяции для истории 'latest'/'none' и при телепортации более 100 м за tick; входные данные не изменяются, ориентации float32 перенормируются, вырожденный кватернион рисуется как единичный; доля вычисляется по запланированному wall-времени и частоте, ограничена [0,1] и равна 1 при паузе или недопустимых данных; отображение позиции NED-to-render. Существующий тест базиса NED проходит. Мутации: удаление инверсии кратчайшего пути и игнорирование состояния истории проваливают тесты. FlightScene использует модуль (RefObject заменяет устаревший MutableRefObject). npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 189 PASS; CI=true npm run test:browser: 15 PASS. Node 22.22.0. Рендеринг здесь только на программном GPU; утверждений о частоте кадров нет.

### TASK-085 — Перевод Worker и Main на ABI v2

- **Status:** DONE — Claude; baseline bad3099; 2026-10-16.
- **Title & Description:** Перевести работающее приложение с ABI v1 и postMessage-протокола v1 на state ring v2, pilot mailbox, WorkerInitV2 и Control Protocol v2. Выделено из TASK-009/010, поскольку WorkerInitV2 требует sensor/actuator buffers из TASK-013.
- **Dependencies:** TASK-009, TASK-010, TASK-013.
- **Touched Files:** `apps/web/src/runtime.ts`, `apps/web/src/physics.worker.ts`, `apps/web/src/App.tsx`, `tests/browser/simulation.spec.ts`, `tests/browser/runtime-v2.spec.ts`, `apps/web/src/FlightScene.tsx`, `packages/physics/src/session-v2.ts`, `packages/physics/src/demo-dynamics.ts`, `packages/physics/src/index.ts`, `packages/protocol/src/control-v2.ts`, `packages/input/src/index.ts`, `tests/session-v2.test.ts`, `tests/control-v2.test.ts`, `tests/input.test.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** WorkerInitV2; StateWriterV2/StateReaderV2; PilotWriterV2/PilotReaderV2; ControlProcessorV2; SPECS_SHARED_MEMORY sections 3–6.
- **DoD & Acceptance Criteria:** Browser tests жизненного цикла, устаревшего ввода, USB failsafe и fixed dt проходят на v2; устаревший epoch или изменённый device_generation снимает arm; рендер никогда не интерполирует через смену epoch; совместимость с v1 удаляется только по зафиксированному решению.
- **Evidence:** Владелец Claude; baseline bad3099; 2026-10-16. Приложение работает на ABI v2: Main отправляет init-v2 с SAB состояния v2 и обеими SPSC-очередями; Worker — тонкий адаптер вокруг PhysicsSessionV2. tests/session-v2.test.ts: 10 PASS (ready-v2, шаги tick/hz, удержание при паузе, удельная сила в покое [0,0,-9.80665], давление ISA, demo отклоняет weather/fault с BAD_STATE и model.load с ASSET_MISSING, arm только при газе <=5%, изменение device_generation снимает arm и блокирует повторный arm до отзыва, устаревшая epoch и ввод старше 300 ms снимают arm, epochs reset/configure разрывают историю, шаги на 1200 Гц, sitl-lockstep отзывчиво ждёт и шагает по кадрам актуаторов для каждого tick с ActuatorValid, превышение сроков hitl-realtime устанавливает флаг Fault в header до reset, dispose). Мутации: игнорирование device_generation, arm при любом газе и игнорирование epoch проваливают тесты. tests/control-v2.test.ts: +2 (unsupportedReason, проверки parseWorkerEventV2/isWorkerInitV2); tests/input.test.ts: +1 (другой передатчик на повторно использованном index начинает новое поколение). DemoDynamics теперь сообщает кинематическое ускорение при контакте с землёй. Browser: все 4 simulation specs проходят на v2 (тест протокола Worker переведён на init-v2/команды с arm при 0% газа), все 7 capability specs проходят, tests/browser/runtime-v2.spec.ts: 2 PASS (устаревшая epoch и смена устройства снимают arm в реальном Worker, 800 Гц выполняются с точностью 10% за 2 s, reset разрывает историю latestPair; заменённый передатчик на index с arm снимает arm в UI). npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 178 PASS; CI=true npm run test:browser: 15 PASS (Playwright Chromium build 1194). Node 22.22.0. Код и тесты ABI v1 сохранены; приложение их больше не использует.

## Phase 2: Aerodynamics & WASM

### TASK-016 — Native Rust workspace

- **Status:** DONE — Claude; baseline 4187246; 2026-10-16 (hosted native.yml run blocked like TASK-003).
- **Title & Description:** Поднять pinned scalar BET crate и native tests.
- **Dependencies:** TASK-003, TASK-004.
- **Touched Files:** `native/Cargo.toml`, `native/Cargo.lock`, `native/rust-toolchain.toml`, `native/bet/Cargo.toml`, `native/bet/src/lib.rs`, `.github/workflows/native.yml`, `native/bet/tests/bootstrap.rs`, `tests/browser/native-bootstrap.spec.ts`, `.github/workflows/ci.yml`, `tests/ci.test.ts`, `.gitignore`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** wasm32-unknown-unknown; repr(C) boundary; scalar default.
- **DoD & Acceptance Criteria:** cargo check/test --locked проходят; target/toolchain pinned; воспроизводимый empty kernel artifact проверен на Chromium; production математика ещё не заявляется.
- **Evidence:** Владелец Claude; baseline 4187246; 2026-10-16. Toolchain rustc/cargo 1.97.0 (закреплён в native/rust-toolchain.toml вместе с wasm32-unknown-unknown, профиль minimal; rustup установил закреплённый toolchain при первом использовании). Внутри native/: cargo check --workspace --locked exit 0; cargo test --workspace --locked: 6 PASS (нулевой/NaN/подпороговый поток даёт нулевую силу; модуль = q c dr sqrt(CL^2+CD^2) с точностью 1e-14; подъёмная сила перпендикулярна потоку и радиальному направлению, сопротивление параллельно и диссипативно; зеркальное вращение меняет знак подъёмной силы и сохраняет сопротивление; линейность по хорде и ширине; exports равны kernel); cargo check -p mirage-bet --target wasm32-unknown-unknown --locked exit 0. Сборка no_std невозможна, поскольку в stable 1.97 нет f64::sqrt в core, а core::arch::wasm32::f64_sqrt нестабилен (wasm_numeric_instr); вместо этого сборка wasm32 использует ловушечный глобальный аллокатор. Release-артефакт: 376 байт, ноль imports, exports memory/bet_abi_version/bet_bootstrap_element_force. tests/browser/native-bootstrap.spec.ts: 1 PASS (две чистые сборки дают одинаковый SHA-256; Chromium инстанцирует модуль; четыре случая совпадают с независимым вычислением на JS с точностью 1e-12). tests/ci.test.ts +1 (один пин toolchain в rust-toolchain.toml, ci.yml, native.yml; native.yml выполняет check/test/wasm/reproducibility в native/). Kernel — bootstrap reference, а не проверенная аэродинамика. Выполнение native.yml на hosted runner не подтверждено (блокер TASK-003).

### TASK-017 — Сборка и загрузка WASM

- **Status:** DONE — Claude; baseline e152ee3; 2026-10-16 (hosted run blocked like TASK-003).
- **Title & Description:** Создать wrapper с hash/ABI проверкой и scalar/SIMD artifact selection.
- **Dependencies:** TASK-005, TASK-016.
- **Touched Files:** `packages/wasm-bet/package.json`, `packages/wasm-bet/src/loader.ts`, `scripts/build-wasm.mjs`, `tests/wasm-loader.test.ts`, `tests/browser/wasm-loader.spec.ts`, `package-lock.json`, `.github/workflows/ci.yml`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** bet_abi_version; artifact manifest, SIMD feature detection.
- **DoD & Acceptance Criteria:** Corrupt hash/ABI блокируют arm; fallback scalar при unsupported SIMD; instantiate выполняется вне step; memory заранее зарезервирована <=64 MiB для BET baseline.
- **Evidence:** Владелец Claude; baseline e152ee3; 2026-10-16. node scripts/build-wasm.mjs (rustc 1.97.0) exit 0: артефакты scalar и simd128 (-C target-feature=+simd128) по 376 B; сейчас они побайтно одинаковы (SHA-256 c2927877ec3e...), так как в bootstrap kernel компилятору нечего векторизовать, поэтому путь SIMD проверяется, но ускорения пока не даёт. tests/wasm-loader.test.ts (Node 22.22.0): 5 PASS (hash/размеры manifest равны node:crypto по файлам на диске; SIMD выбирается при обнаружении, scalar fallback — при отказе/исключении детекции или отсутствии SIMD-артефакта в manifest; оба варианта дают независимо вычисленную силу элемента с точностью 1e-12; 64 MiB резервируются при загрузке, последующий рост сообщает memoryStable(); резервирование сверх бюджета отклоняется; повреждённый hash, усечённый размер, несовпадение ABI manifest, чужой модуль без exports и ошибка fetch возвращают ok=false; отклонено 15 некорректных manifest). Мутации (отключена проверка hash; удалено резервирование памяти) роняют по 1 тесту. tests/browser/wasm-loader.spec.ts: 1 PASS в Chromium (crossOriginIsolated, SIMD128 обнаружен, simd128 загружен с резервом 64 MiB, принудительный scalar fallback, обе силы совпадают, повреждённые байты отклонены). Unit job в ci.yml теперь устанавливает закреплённый toolchain. Выполнение на hosted runner не подтверждено (блокер TASK-003). Инстанцирование асинхронно при инициализации; step, из которого его можно было бы вызвать, ещё нет (TASK-018).

### TASK-018 — C ABI и arena binding

- **Status:** DONE — Claude; baseline a3e7141; 2026-10-16 (hosted run blocked like TASK-003).
- **Title & Description:** Определить checked input/config/output records без object marshaling на шаге.
- **Dependencies:** TASK-006, TASK-017.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/include/bet.h`, `packages/wasm-bet/src/arena.ts`, `tests/wasm-abi.test.ts`, `native/bet/src/lib.rs`, `native/bet/build.rs`, `native/bet/tests/abi.rs`, `packages/wasm-bet/src/loader.ts`, `packages/wasm-bet/package.json`, `tests/fixtures/wasm-abi/generate.py`, `tests/fixtures/wasm-abi/bet-abi-v1.json`, `tests/fixtures/registry.json`, `tests/browser/native-bootstrap.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES §4, rotor output stride=128.
- **DoD & Acceptance Criteria:** Rust size/offset tests совпадают с TS golden; invalid pointer/count/size отклоняется; 1e6 step calls не вызывают allocator/grow; out перезаписывается in-place.
- **Evidence:** Владелец Claude; baseline a3e7141; 2026-10-16. Источник layout — native/bet/include/bet.h (71 defines); golden records — tests/fixtures/wasm-abi/bet-abi-v1.json (config 4384 B, input 256 B, два ротора), упакованы независимо через Python struct скриптом generate.py и зарегистрированы в tests/fixtures/registry.json. Внутри native/ (rustc 1.97.0): cargo test --workspace --locked: abi 7 PASS (каждый define из bet.h равен константе Rust; golden config декодируется и задаёт размер arena; 25 некорректных config и недостаточная arena отклоняются без живой arena; 1e6 шагов возвращают AERODYNAMICS_UNAVAILABLE и перезаписывают тот же буфер на месте; 12 некорректных входов, неверный dt и короткий выход отклоняются без записи выхода; освобождённые/повреждённые handles отклоняются; проверки диапазона/выравнивания/перекрытия регионов) + bootstrap 6 PASS; cargo check wasm32 exit 0. tests/wasm-abi.test.ts (Node 22.22.0, реальный артефакт wasm32): 7 PASS (BET_ABI равен bet.h; encodeBetConfig и записанный вход равны golden bytes; регионы выше __heap_base, выровнены на 64 байта, не перекрываются, внутри резерва 64 MiB; 1e6 вызовов stepInto с 0 событий GC в измеряемом окне, sentinel перезаписывается на каждом шаге, memoryStable; нулевые/ниже heap base/невыровненные/вне диапазона/перекрывающиеся указатели, плохие handles, неверный dt и освобождённые handles отклоняются через реальные exports; некорректные config отклоняются до arm; рост памяти приводит к отказу шага с MEMORY_GROWN). Проверка GC нашла и потребовала исправить упаковку одного HeapNumber на каждую нецелую компоненту вектора (fallback `?? NaN` при чтении Float64Array). Мутации (возврат этого fallback; Rust не перезаписывает flags ротора 0) роняют по 1 тесту. Ловушечный аллокатор wasm32 превращает любую аллокацию в trap, поэтому отсутствие аллокаций в wasm следует из завершения 1e6 шагов. Аэродинамики пока нет: step сообщает о недоступности до TASK-020. Выполнение на hosted runner не подтверждено (блокер TASK-003).

### TASK-019 — Polar lookup

- **Status:** DONE — Claude; baseline ddb263d; 2026-10-16 (hosted run blocked like TASK-003).
- **Title & Description:** Реализовать проверяемую интерполяцию CL/CD по alpha/logRe/Mach.
- **Dependencies:** TASK-004, TASK-018.
- **Touched Files:** `native/bet/src/polar.rs`, `tests/fixtures/polars/synthetic.json`, `native/bet/tests/polar.rs`, `native/bet/src/lib.rs`, `tests/fixtures/polars/generate.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** PolarTable; flattened (Mach,Re,alpha), validity flags.
- **DoD & Acceptance Criteria:** Узлы/межузлия/reverse flow/границы проверены аналитически; negative CD/NaN отвергнуты; outside range даёт clamp+flag, не скрытую экстраполяцию.
- **Evidence:** Владелец Claude; baseline ddb263d; 2026-10-16. Оракул — tests/fixtures/polars/synthetic.json (зарегистрирован; 9 узлов alpha на [-pi, pi] со срывом и обратным обтеканием, подобным плоской пластине, 3 Re, 3 Mach, 81 значение, 13 запросов), сгенерирован generate.py из замкнутых формул, кусочно-линейных по alpha и линейных по ln Re и Mach, поэтому трилинейный lookup точен; допуск 1e-12 absolute задан в fixture до реализации. Внутри native/ (rustc 1.97.0): cargo test --workspace --locked: polar 5 PASS (13 аналитических запросов, включая узлы, внутренности ячеек, обратное обтекание, alpha = +-pi и clamp по Re/Mach/alpha с точными ожиданиями флагов; все 81 узел воспроизводятся; интерполяция по ln Re и оси из одного узла; clamp равен граничному значению и выставляет флаг, не-finite запросы дают NaN и флаг; отрицательный CD, NaN/inf коэффициенты, повторяющиеся/неупорядоченные/NaN оси, Re <= 0, Mach < 0 и неверные размеры отклоняются) + abi 7 + bootstrap 6 PASS; cargo check wasm32 exit 0. Мутации (линейная интерполяция по Re вместо ln Re; потерян флаг clamp; принят отрицательный CD) роняют 2, 3 и 1 тест. Lookup ещё не подключён к шагу ротора (TASK-020), а таблица синтетическая, не измеренный профиль.

### TASK-020 — Blade element quadrature

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Интегрировать силы/моменты элементов с заданными Ω и inflow.
- **Dependencies:** TASK-019, TASK-032.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/blade.rs`, `native/bet/src/quadrature.rs`, `native/bet/tests/blade.rs`, `native/bet/src/lib.rs`, `tests/fixtures/rotors/blade.json`, `tests/fixtures/registry.json`, `native/bet/tests/allocation.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** RotorGeometry/RotorStepInput; equations §3.
- **DoD & Acceptance Criteria:** Zero-flow, mirror spin, drag dissipation и independent wrench fixtures; quadrature weights не умножают силу на число samples; refinement 16→32→64 converges с fixture tolerance.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. cargo test --test blade --locked: 5 PASS. Независимые annulus force/torque, radial refinement 16/32/64, нормированное azimuth averaging, spin mirroring, нулевой поток, drag power, alpha из pitch/flow, body-rate flow, отклонение неверных geometry/input и polar flags. tests/fixtures/rotors/blade.json зарегистрирован по SHA-256 как synthetic; fine relative tolerance 1e-4. tests/rotor-kernels.test.ts: 3 PASS, scalar/SIMD tails 1/3/5/63, независимые дискретные суммы с допуском 1e-9 N/Nm. Production ABI остаётся unavailable до versioned polar/config binding.

### TASK-021 — Dynamic inflow

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Добавить bounded axial induced-flow state и validity envelope.
- **Dependencies:** TASK-020.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/inflow.rs`, `native/bet/tests/inflow.rs`, `tests/fixtures/rotors/axial-inflow.json`, `tests/fixtures/registry.json`, `native/bet/src/lib.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** signed induced velocity; max 4 solver iterations/step.
- **DoD & Acceptance Criteria:** Hover momentum residual<=1% fixture thrust; transient convergence checked; VRS/out-of-envelope отмечен, не выдан за валидированный режим; finite на zero RPM/flow.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. cargo test --test inflow --locked: 2 PASS. Знаковый hover/climb momentum residual <=1%, точная релаксация на 400/800/1200 Гц, обратная тяга, нулевая нагрузка и явная валидность descent/VRS/transverse. Синтетический axial-inflow.json зарегистрирован по SHA-256. Closed-form target не использует итерации (в пределах бюджета четыре); это не валидированная модель inflow авторотации/VRS. Scalar/SIMD transient совпадает с аналитическим target в пределах 1e-9 м/с.

### TASK-022 — Free shaft / авторотация

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Интегрировать обороты из аэромомента, torque и потерь без RPM governor.
- **Dependencies:** TASK-021.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/shaft.rs`, `native/bet/tests/autorotation.rs`, `tests/fixtures/rotors/free-shaft.json`, `tests/fixtures/registry.json`, `native/bet/src/lib.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** J*dΩ/dt=tau_motor+s*Qair-tau_loss; RotorState.
- **DoD & Acceptance Criteria:** Без потока/мотора энергия убывает; при допустимом набегающем потоке free rotor набирает/теряет RPM по torque; steady residual<0.01 Nm; нет принудительного заданного RPM.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. cargo test --test autorotation --locked: 2 PASS. Пассивный спад энергии и точный предел zero damping; blade torque разгоняет/тормозит свободный вал в синтетическом восходящем потоке при обоих spin, достигает residual <0.01 Nm, сходится на 400/800/1200 Гц и замедляется после снятия потока. free-shaft.json зарегистрирован по SHA-256. Предписанных RPM/governor нет; попытка реверса явно ограничена. Scalar/SIMD passive speed совпадает в пределах 1e-9 рад/с. Экспериментальная валидация автожира не заявляется.

### TASK-023 — Flapping и gyro momentum

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Добавить coning/first-harmonic flap и полную передачу dH/dt.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/flapping.rs`, `native/bet/src/momentum.rs`, `native/bet/tests/flapping.rs`, `native/bet/src/lib.rs`, `tests/fixtures/rotors/flapping.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** RotorState flap states; Mhub=Mair-dH/dt; documented hinge parameters.
- **DoD & Acceptance Criteria:** Zero asymmetry case, sign/axis tests, angular momentum balance и timestep convergence; equations/source/validity сохранены; mesh tilt не используется вместо dynamics.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. cargo test --test flapping --locked: 3 PASS. Документированы zero-offset hinge Galerkin equations и modal inertia normalization; проверены oscillator refinement, collective symmetry, зеркальные rotating-hinge signs, границы валидности, spin/cone/cyclic momentum и inertial transport balance. Синтетический flapping.json зарегистрирован по SHA-256; scalar/SIMD oscillator tolerance 1e-8 rad. Native allocation test: ноль вызовов и выделенных байт на 1e6 совместных kernel steps, allocating positive control обнаружен; debug/release пройдены. WASM trapping allocator: миллион шагов dynamics со стабильной памятью. Ограничения flat-disk load coupling и small-angle reduced inertia явно сохранены. Общие gates завершены с exit 0: frozen npm ci (SHA-256 lockfile 89f81050ae94d179d043929086ba7ec00328644e5ac4d46b26013ee1422cb084 не изменён); npm run lint/typecheck/check:docs/build; CI=true npm test (209 PASS); CI=true CHROMIUM_PATH=/usr/bin/chromium npm run test:browser (17 PASS); cargo check --manifest-path native/Cargo.toml --workspace --locked; cargo check --manifest-path native/Cargo.toml -p mirage-bet --target wasm32-unknown-unknown --locked; cargo test --manifest-path native/Cargo.toml --workspace --locked (31 PASS). Итоговые отчёты без failures/skips: test-results/unit/junit.xml, test-results/browser/junit.xml. Rust 1.97.0 (2d8144b78), Node 24.19.0, Chromium 154.0.8037.57, Debian x86_64/software GPU; CARGO_HOME=/workspace/.cache/mirage-cargo, RUSTUP_HOME=/workspace/.cache/mirage-rustup, Cargo bin в PATH. EN/RU spec/architecture/roadmap/README/CLAUDE синхронизированы. Целевое оборудование и hosted Actions не проверены.

### TASK-024 — Соосное взаимодействие

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Ввести отдельный wake coupling для пары rotor disks.
- **Dependencies:** TASK-021, TASK-023.
- **Touched Files:** `native/bet/src/coaxial.rs`, `native/bet/tests/coaxial.rs`, `tests/fixtures/rotors/coaxial.json`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `native/bet/tests/allocation.rs`, `tests/rotor-kernels.test.ts`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** WakePair {upperId,lowerId,separationM,overlap}; energy/source provenance.
- **DoD & Acceptance Criteria:** Отключённый coupling даёт independent rotors; большие separation стремятся к нему; momentum/energy ledger checked; без измеренных данных модель явно experimental.
- **Evidence:** Владелец Codex; baseline 8f7dc19; 2026-10-16. cargo test --manifest-path native/Cargo.toml --test coaxial --locked: 4 PASS (независимый flux oracle, точный independent receiver wrench при disabled/zero-overlap, активная связь, far-field wrench в пределах 1e-6 N/Nm, масштабирование overlap, scaled momentum/energy budgets, отклонение неверных geometry/regimes). Эталон coaxial-analytic-v1 SHA-256 a7d0032c6c019afaa8b84f16692e2b1a9d07e180bedae28ba2bc6bd25bad5ebb; единицы SI; absolute fixture tolerance 1e-9. Native allocator counter включает 1e6 wake evaluations: ноль вызовов/байт, positive allocating control обнаружен. tests/rotor-kernels.test.ts: 4 PASS, включая scalar/SIMD wake oracle/budgets и 1e6 varying-thrust steps с trapping allocator и стабильной памятью; disabled/zero-flow output — канонический +0. Общая проверка exit 0: npm run lint, npm run typecheck, npm run check:docs, npm run build; CI=true npm test (210 PASS), CI=true CHROMIUM_PATH=/usr/bin/chromium npm run test:browser (17 PASS); cargo check --manifest-path native/Cargo.toml --workspace --locked, cargo check --manifest-path native/Cargo.toml -p mirage-bet --target wasm32-unknown-unknown --locked, cargo test --manifest-path native/Cargo.toml --workspace --locked (35 PASS); focused coaxial/allocation повторно после исправления signed zero (5 PASS). Итоговые JUnit: test-results/unit/junit.xml, test-results/browser/junit.xml, без failures/errors/skips. Rust 1.97.0, Node 24.19.0, Chromium 154.0.8037.57, Debian x86_64/software GPU. Cargo environment: CARGO_HOME=/workspace/.cache/mirage-cargo, RUSTUP_HOME=/workspace/.cache/mirage-rustup, Cargo bin в PATH. EN/RU specification, architecture и roadmap синхронизированы. Только experimental ideal-hover/mixing reference; измеренная калибровка, production C ABI/backend wiring и производительность целевого оборудования не заявляются.

### TASK-025 — ESC и spool model

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Преобразовывать duty в torque/RPM transient выбранной моделью привода.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/src/motor.rs`, `native/bet/tests/motor.rs`, `packages/physics/src/motor-config.ts`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/motor-config.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Torque-model или first-order governor; current/back-EMF limits.
- **DoD & Acceptance Criteria:** Step duty имеет заданный lag/current saturation; zero voltage не создаёт энергии; power-cut сохраняет spin decay; два spool ODE одновременно запрещены.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. Проходят 2 нативных теста мотора, проверка строгой схемы и аналитический паритет scalar/SIMD. Проверены точная задержка duty, насыщение тока, баланс мощности шины/вала/потерь и отключение без сброса скорости. Нативный счётчик включает мотор на 1e6 шагов: ноль вызовов/байт. Полная привязка роторов/backend остаётся отдельной работой.

### TASK-026 — Battery sag

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Рассчитывать SOC, bus voltage и доступную мощность для набора моторов.
- **Dependencies:** TASK-025.
- **Touched Files:** `native/bet/src/battery.rs`, `native/bet/tests/battery.rs`, `tests/fixtures/power/battery.json`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** V=Voc-I*R, SOC, power-limited flags.
- **DoD & Acceptance Criteria:** Analytic resistive cases, R→0, depleted SOC и недостижимый P не дают NaN; энергия/знаки тока согласованы; нагрузка всех motors учтена один раз.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. Проходят 2 нативных теста батареи и scalar/SIMD-эталон квадратного корня. Проверены общий учёт нагрузок, R=0/1e-20, ограничения заряда/тока/мощности, разряд, отклонение нечисел и баланс мощности при фиксированном SOC. power/battery.json — независимый хешированный синтетический эталон, не измерения батареи. Нативная проба миллиона шагов проходит.

### TASK-027 — Произвольная рама и wrench

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Суммировать thrust vectors, torque arms и transmitted rotor moments.
- **Dependencies:** TASK-006, TASK-023, TASK-025, TASK-026.
- **Touched Files:** `native/bet/src/frame.rs`, `packages/physics/src/frame.ts`, `native/bet/tests/frame.rs`, `tests/fixtures/models/tilted-octo.json`, `native/bet/src/lib.rs`, `native/bet/src/math.rs`, `tests/frame.test.ts`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** F=sum R*F; M=sum(r×R*F+R*Mhub); stable motor IDs.
- **DoD & Acceptance Criteria:** Quad/hexa/tilted octo fixtures, symmetry/yaw cancellation и handedness; tilted axes создают lateral force; запрещён double-count motor reaction.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. Проходят 2 нативных и 2 TypeScript-теста рамы и scalar/SIMD-эталон наклонённой силы. Симметричные quad/hexa/octo компенсируют плечевые/yaw-моменты; зарегистрированный tilted-octo даёт 4*sqrt(2) N по body X и Z от восьми единичных сил втулок. Проверены стабильные ID, правая система и отсутствие повторной реакции. Нативная проба миллиона шагов проходит.

### TASK-028 — Rigid-body integrator

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Интегрировать BET wrench с mass/inertia, quaternion и NED gravity.
- **Dependencies:** TASK-027.
- **Touched Files:** `native/bet/src/rigid_body.rs`, `packages/wasm-bet/src/backend.ts`, `native/bet/tests/rigid_body.rs`, `native/bet/src/lib.rs`, `native/bet/src/body_abi.rs`, `native/bet/tests/body_abi.rs`, `tests/rigid-body.test.ts`, `packages/wasm-bet/package.json`, `tests/fixtures/abi/body-v1.json`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `tests/browser/native-bootstrap.spec.ts`, `scripts/bench-sensors.mjs`.
- **Interfaces / Contracts:** DynamicsBackend, TruthOutput, один owner integration.
- **DoD & Acceptance Criteria:** Ballistic/torque-free/constant torque cases; quaternion norm error<1e-10 native; finite trajectory; 400/800/1200 convergence against offline 4800 Hz reference.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. Проходят 3 нативных теста тела и тест отклонения/раскладки body ABI: аналитическая баллистика и постоянный момент главной оси, ошибка нормы кватерниона ниже 1e-10, сходимость torque-free 400/800/1200 к 4800 Гц. Независимый body ABI v1 256/128 байт, отдельное владение памятью и тесты настоящего scalar/SIMD-адаптера. Нативный счётчик миллиона шагов проходит; WASM-ловушки аллокаций и стабильность памяти проверяются отдельно. Полный полётный BET backend не заявлен. Дополнительный G1: bench-sensors.mjs body выполняет настоящий scalar WASM-адаптер тела и сенсорный конвейер в шести прогретых окнах N=1e6/2e6: ноль GC/добавочных B/step, положительный контроль обнаружен; юнит-тесты выполняют 1e6 шагов на каждом scalar/SIMD-артефакте с ловушкой аллокаций и стабильной памятью.

### TASK-029 — Контакт шасси

- **Status:** BLOCKED_DECISION — Codex; нативный патч проходит, production-привязка не сертифицирована.
- **Title & Description:** Подключить один выбранный contact solver и согласовать impulses.
- **Dependencies:** TASK-028.
- **Touched Files:** `packages/physics/src/contact-backend.ts`, `packages/physics/src/ground-contact.ts`, `tests/contact.test.ts`, `tests/fixtures/contact/drop.json`, `package-lock.json`, `packages/physics/package.json`, `tests/contact-allocation.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `packages/physics/src/contact-engine.ts`, `scripts/bench-contact.mjs`, `native/rapier/allocation_probe.rs`, `native/rapier/source.lock.json`, `native/rapier/Cargo.lock`, `scripts/check-contact-native.mjs`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `native/rapier/patches/reuse-step-buffers.patch`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`.
- **Interfaces / Contracts:** ContactImpulse {pointBody,impulseNed,dt}; Rapier или Jolt, выбор зафиксирован ADR.
- **DoD & Acceptance Criteria:** Drop/roll/friction/no-penetration fixtures; restitution не добавляет энергии сверх заданного; rigid body не интегрируется вторым solver одновременно; alloc budget G1.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. Проходят тесты настоящего Rapier 0.21.0: падение сферы на плоскость, трение качения, непроникновение и восстановление. Владелец интегрирования и диагностика импульса реализованы. Проверка identity getter доказывает новые объекты: highRateCertified=false; G1 FAIL запрещает production-допуск. ADR в docs/architecture.md фиксирует необходимость привязки без аллокаций или другого решателя. Общий контакт шасси ещё не реализован.

- **Retry Evidence:** Повтор: getter с готовыми объектами и постоянные raw-векторы силы/момента/гравитации заменили создание обёрток на шаге; проверены raw pipeline с фиксированной топологией и идемпотентный dispose. Прогретая JS-проба по-прежнему провалена: 143/142/71 событий GC на окно 1e6 шагов (код 1). Нативный Rapier f64 0.36.0 без profiler, коммит b716d375efc0201003f0cd9ef7168eee0b62c177: 1,688,500 вызовов / 77,328,000 байт на 1e6 шагов (код 2). Отчёты test-results/bench/contact.json и contact-native.json. Нативный f64 не сертифицирует поставляемый f32 WASM. G1 провален, высокочастотного допуска нет.

- **Patch Retry Evidence (2026-10-16):** Явный патч повторного использования: одинаковые прогоны бодрствующей сферы/полупространства дают 2,002,500 вызовов / 96,320,000 байт у оригинала и ноль у патча за 1e6 шагов; сумма траектории 317ba7c959cd2b59 совпадает. Отчёт test-results/bench/contact-native-patched.json, код 0. Прежние числа относятся к конечному параллелепипеду со сном. Поставляемая JS-привязка всё ещё проваливает G1; общее шасси не завершено.

### TASK-030 — Pinned JSBSim WASM artifact

- **Status:** BLOCKED_EXTERNAL — Codex; retry verified on 2026-10-16.
- **Title & Description:** Собрать JSBSim через Emscripten с reproducible source/toolchain manifest.
- **Dependencies:** TASK-003, TASK-004, TASK-006.
- **Touched Files:** `native/jsbsim/CMakeLists.txt`, `native/jsbsim/source.lock.json`, `native/jsbsim/toolchain.lock.json`, `scripts/build-jsbsim.mjs`, `packages/wasm-jsbsim/package.json`, `tests/jsbsim-artifact.test.ts`, `native/jsbsim/bridge.cpp`, `native/jsbsim/property-map.json`, `package-lock.json`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `scripts/check-jsbsim-native.mjs`, `native/jsbsim/native_checks.cpp`, `native/jsbsim/patches/reuse-history-and-property-paths.patch`.
- **Interfaces / Contracts:** WASM C ABI version/hash и лицензии JSBSim/model data.
- **DoD & Acceptance Criteria:** Build из pinned SHA, проверенные checksums; native reference и WASM одного source; unit conversions не патчат сторонний код; artifact smoke в worker.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. Закреплены JSBSim v1.2.3 570e8115a102df8f877b11e0e59b964ea483e3c0 и emsdk 4.0.15 389a68bc35dcff7ebae4614e1615099dafda00d1; проверки исходников/лицензии/SDK-манифеста проходят. Нативный C++ bridge собирается GNU 14.2/CMake 3.31.6 и выдаёт 22 конечных SI-значения через 1 с. Установка Emscripten отклонена storage.googleapis.com proxy CONNECT 403; артефакта WASM и Worker smoke нет. Домен сети и повторяемая настройка сохранены в неприменённом черновике среды для проверки/сохранения/публикации. Hosted TASK-003 и приёмка лицензии данных модели не проверены.

- **Retry Evidence:** Повтор: python3 emsdk.py install 4.0.15 снова отклонён при загрузке node-v22.16.0-linux-x64.tar.xz с storage.googleapis.com: proxy tunnel CONNECT 403, код 1. Сетевой черновик не применён к этой среде. Добавлены нативная проверочная цель и флаги перехвата исключений холодного пути; сборка Emscripten и Worker smoke не выполнены. Повторяемая диагностика старта сохранена в черновике среды; сохранение не означает публикацию.

- **Patch Retry Evidence (2026-10-16):** Сборочный скрипт поддерживает проверяемый явный патч аллокаций и сохраняет его SHA-256 в манифесте артефактов. Checkout исходников чист. Нативный результат не устраняет HTTP 403 SDK и не заменяет настоящий WASM/Worker smoke.

### TASK-031 — JSBSim DynamicsBackend

- **Status:** BLOCKED_EXTERNAL — Codex; retry verified on 2026-10-16.
- **Title & Description:** Адаптировать JSBSim state, actuator и contact exchange.
- **Dependencies:** TASK-018, TASK-029, TASK-030, TASK-032.
- **Touched Files:** `native/jsbsim/bridge.cpp`, `packages/wasm-jsbsim/src/backend.ts`, `tests/jsbsim-backend.test.ts`, `tests/fixtures/airframes/jsbsim-trim.json`, `native/jsbsim/property-map.json`, `packages/wasm-jsbsim/package.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `native/jsbsim/native_checks.cpp`, `scripts/check-jsbsim-native.mjs`, `tests/jsbsim-native.test.ts`, `native/jsbsim/patches/reuse-history-and-property-paths.patch`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`.
- **Interfaces / Contracts:** DynamicsBackend; ft/slugs↔SI; FRD/NED, JSBSim integration ownership.
- **DoD & Acceptance Criteria:** Trim/step-control native vs WASM fixtures в manifest tolerance; stationary specific force/signs верны; согласованный contact impulse; 0 alloc/grow на шаге.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. C ABI/карта свойств и TypeScript-адаптер без создания выходов реализуют точное преобразование футов в метры, фиксированные ECEF/NED, wxyz и разделение координатного ускорения/удельной силы. JSBSim — единственный владелец интегрирования. Нативный smoke тех же исходников проходит; реальный WASM trim/control-паритет, лицензия данных, контактные импульсы и критерий аллокаций не пройдены. airframes/jsbsim-trim.json явно фиксирует блокировку и не является вымышленным trim-эталоном.

- **Retry Evidence:** Повтор: устранён ABA устаревших handles через поколения, пересечение кадров отклоняется до шага, усилены проверки heap/allocator views, добавлены необязательные холодные jsb_trim/trimInto. Настоящая полная нативная балансировка, неверные/устаревшие кадры, норма кватерниона и производные SI/осей проходят. Нативный аллокатор: 250 окон по 4000 измеряемых шагов после 400 прогрева, 21,142,500 вызовов / 1,454,820,000 байт, код 2. Отчёт test-results/validation/jsbsim-native.json содержит хеши исходников/модели/bridge/checker. G1 провален независимо от SDK; паритет native/WASM и контактный обмен открыты.

- **Patch Retry Evidence (2026-10-16):** Явный патч JSBSim повторно использует историю deque, обход атмосферных свойств и списки подачи топлива. Настоящая нативная балансировка и SI/оси проходят; 1e6 измеренных шагов дают ноль вызовов/байт против 21,142,500 вызовов / 1,454,820,000 байт оригинала. Сумма траектории 164fd3c0bf6d8a39 совпадает. Отчёт test-results/validation/jsbsim-native-patched.json, код 0. Другие модели, паритет WASM и контактное сопряжение не сертифицированы.

### TASK-032 — Атмосфера и ветер

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Реализовать единый atmospheric state и детерминированный gust input.
- **Dependencies:** TASK-004, TASK-006, TASK-010.
- **Touched Files:** `CLAUDE.md`, `docs/ru/CLAUDE.md`, `README.md`, `docs/ru/README.md`, `packages/physics/src/atmosphere.ts`, `packages/physics/src/wind.ts`, `tests/atmosphere.test.ts`, `packages/physics/package.json`, `package-lock.json`, `scripts/bench-wind.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Temperature/pressure→density/viscosity/speed of sound; seeded gust bandwidth.
- **DoD & Acceptance Criteria:** ISA reference points, calm/gust/reset/replay fixtures; единицы согласованы JSBSim/BET; fixed seed не зависит от render FPS; near-zero density отклонена schema.
- **Evidence:** Владелец Codex; baseline 9ce0da1; 2026-10-16. tests/atmosphere.test.ts: 4 PASS (ISA sea level/11 km, строгая state schema, calm/reset/независимый от render replay, стационарные variance/pole на 2e6 samples). node scripts/bench-wind.mjs: exit 0, seed 123, 400 Hz; шесть warmed окон N=1e6/2e6 без GC; incremental allocation estimate 0.000128 B/step с фиксированным probe overhead; allocating control обнаружил 31 GC events. Отчёт: test-results/bench/wind.json. Общие SI helpers экспортированы; runtime weather binding и измеренная turbulence не заявляются.

### TASK-033 — Model validation gate

- **Status:** BLOCKED_EXTERNAL — Codex; retry verified on 2026-10-16.
- **Title & Description:** Выполнить общий numerical/reference gate и сформировать отчёт достоверности моделей.
- **Dependencies:** TASK-014, TASK-024, TASK-028, TASK-029, TASK-031.
- **Touched Files:** `scripts/validate-models.mjs`, `tests/model-validation.test.ts`, `docs/validation/model-report.schema.json`, `tests/fixtures/validation/reference-manifest.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`.
- **Interfaces / Contracts:** ValidityEnvelope; numerical parity отдельно от experimental validity.
- **DoD & Acceptance Criteria:** Smooth 10 s cases: <=0.1 m/0.5° against 4800 Hz; scalar/SIMD force/moment tolerance §4; provenance каждого эталона; отсутствие экспериментальных данных даёт BLOCKED_EXTERNAL для fidelity, не fake PASS.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. Исполняемый отчёт собирает настоящие scalar/SIMD-артефакты и проходит 12 численных случаев (два сценария по 10 с, 400/800/1200 против 4800 Гц) с допуском 0.1 м/0.5 градуса; аналитическая баллистика проходит. Проверка схемы/кода выхода подтверждает numerical PASS, fidelity BLOCKED, общий BLOCKED и код 2. Отчёт test-results/validation/model-report.json содержит SHA-256 эталона/артефактов. Нет измерений борта/ротора, полной BET-привязки, контакта G1 и WASM-паритета JSBSim; fidelity нельзя отмечать DONE.

- **Retry Evidence:** Повтор: schema v2 сохраняет контактную/нативную JSBSim-диагностику с проверкой хешей, выявляет устаревшие отчёты, отклоняет пустые/переставленные частоты, неверные/повторяющиеся случаи и неподдерживаемые измерения до сборки. Настоящие 12 численных случаев проходят; оба диагностических допуска failed, общий/fidelity BLOCKED, код 2. Измерения борта/ротора не предоставлены, полной привязки BET нет. Итоговые коды 0: lint/typecheck/build/check:docs, 235 юнит-тестов (36 файлов), 17 браузерных тестов; актуальные JUnit без провалов/ошибок/пропусков. Провалы аллокаторов и SDK — отдельные непрошедшие критерии, не успешная интеграция. EN/RU синхронизированы; commit/push не выполнялись.

- **Final Patch Verification (2026-10-16):** Итог повтора патчей: lint/typecheck/build/check:docs — код 0; проходят 236 юнит-тестов в 37 файлах и 17 браузерных тестов Chromium. Актуальные JUnit: test-results/unit/junit.xml и test-results/browser/junit.xml, ноль провалов/ошибок/пропусков. Первый браузерный запуск не активировал Rust и не выдержал 800 Гц под параллельной нагрузкой; исправленный отдельный запуск проходит без изменения порогов. Нативные патчи и CLI engine-patch-parity — код 0; оригинальные нативные пробы — код 2; JS GC — код 1; CLI model-validation — код 2 с 12 численными PASS и заблокированной fidelity. Checkout исходников чист, хеш lockfile неизменен. Двуязычные хеши проверены. Черновик инструкций старта среды сохранён и требует проверки/сохранения/публикации в настройках; доступ SDK им не применён. Commit/push не выполнялись.

## Phase 3: ArduPilot & Radio Link

- **Patch Retry Evidence (2026-10-16):** Добавлена проверка паритета оригинал/патч с SHA-256 исходников/патча/отчёта, суммами всех шагов и тестами отклонения. Оба нативных патча проходят; исходные JS/нативные критерии провалены. Отчёт модели v2 разделяет результаты и всё ещё возвращает 2 при заблокированной fidelity. Отсутствие измерений, полной привязки BET и интеграции WASM/контакта явно сохранено.

### TASK-034 — Ideal sensors

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Преобразовать truth в IMU/mag/baro/airspeed без noise и EW.
- **Dependencies:** TASK-013, TASK-028, TASK-032.
- **Touched Files:** `packages/sensors/package.json`, `packages/sensors/src/ideal.ts`, `tests/ideal-sensors.test.ts`, `package-lock.json`, `tests/fixtures/sensors/ideal.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** GpsSample/ImuSample; acceleration vs specific force; gauss/Pa internal units.
- **DoD & Acceptance Criteria:** Stationary/free-fall/rotated-body fixtures; gyro и mag body frames; pressure signs verified; outputs in-place, G1.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. 2 теста идеальных сенсоров проверяют неподвижную/свободнопадающую/перевёрнутую удельную силу, поворот gauss, знак ISA Pa/Down и динамическое давление; существующий codec принимает записи. bench-sensors.mjs ideal охватывает все четыре реализованных вида сенсоров: шесть окон N=1e6/2e6, ноль GC и ноль добавочных B/step после 4e6 прогрева; положительный контроль обнаружен. Выходы/scratch переиспользуются. GNSS ожидает TASK-036; подключение к автопилоту/Worker не заявлено.

### TASK-035 — Частоты/шум/bias сенсоров

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Добавить rational sampling, bounded latency и seeded noise streams.
- **Dependencies:** TASK-004, TASK-011, TASK-034.
- **Touched Files:** `packages/sensors/src/scheduler.ts`, `packages/sensors/src/noise.ts`, `packages/sensors/src/latency.ts`, `tests/sensor-scheduler.test.ts`, `tests/sensor-noise.test.ts`, `scripts/bench-sensors.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** IMU 200/400, GPS 5/10 Hz; PSD/bandwidth; sensor frame time.
- **DoD & Acceptance Criteria:** За 60 sim s точные counts всех частот на 400/800/1200; seed repeatable; noise statistics в заданном confidence interval; latency queue bounded и monotonic.

- **Evidence:** Ответственный Codex; база 8f7dc19; 2026-10-16. Проходят 2 теста расписания/задержки и 2 шума. Точное число выборок за 60 с при 400/800/1200 для 5/10/200/400 Гц; ограниченная монотонная FIFO, переполнение/reset; независимые детерминированные потоки/reset; дисперсия и лаг Gaussian на 1e6 отсчётов. bench-sensors.mjs all: четыре миллиона тиков прогрева с переполнением времени, шесть окон N=1e6/2e6, ноль GC/добавочных B/step, положительный контроль 31 GC, ноль потерь. Массивы sampleInto избегают упаковки числовых результатов. RMS, полюс, блуждание смещения и двусторонняя PSD описаны; Node не доказывает время браузера/целевого оборудования.

### TASK-036 — WGS84 и MSL

- **Status:** DONE — Claude; baseline 346866c; 2026-10-16 (проверка абсолютной точности MSL — BLOCKED_EXTERNAL до установки авторитетной сетки геоида).
- **Title & Description:** Добавить origin/ECEF/NED/geoid преобразования с float64.
- **Dependencies:** TASK-004, TASK-006.
- **Touched Files:** `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `tests/geodesy.test.ts`, `tests/fixtures/geodesy/wgs84.json`, `tests/fixtures/geodesy/generate.py`, `tests/fixtures/registry.json`, `packages/sensors/package.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** WGS84 h vs MSL H; authoritative geoid dataset/hash/licence.
- **DoD & Acceptance Criteria:** Roundtrip<=1 mm для локальных synthetic cases; antimeridian/poles и 15 km offsets; нет cos(lat) singularity; dataset absent явно blocks absolute MSL accuracy gate.
- **Evidence:** Владелец Claude; baseline 346866c; 2026-10-16. Оракул — tests/fixtures/geodesy/wgs84.json (зарегистрирован), сгенерирован generate.py: замкнутая прямая формула WGS84 и обратное преобразование методом неподвижной точки на Python, независимо от обратного метода Bowring в TypeScript; 8 опорных точек (экватор, оба полюса, антимеридиан, Эверест 8848.86 м, Мёртвое море -430 м, высота 15 км, 89.9999 град) и 7 случаев касательной системы (смещения 15 км через оба полюса, через антимеридиан на восток и запад, смешанное 15 км, 15 км вниз, 10 км вверх). Node 24.22.0: tests/geodesy.test.ts 8 PASS (ECEF оракула с точностью 1e-6 м, обратные преобразования в пределах 1 мм; касательные случаи в пределах 1 мм с долготой в [-pi, pi) и обратным преобразованием в пределах 1 мм; сетки 13x13x4 смещений до 15 км в шести началах, включая оба полюса и долготу +-pi, худшая ошибка обратного преобразования меньше 1 мм; ортонормированные оси NED и подъём по нормали меняет только высоту; точная замена +pi на -pi в антиподе; синтетический геоид: билинейная интерполяция/замыкание/ограничение, обратимость H = h - N, проверка AVAILABLE только с происхождением и совпадающим hash, NO_GEOID — BLOCKED_EXTERNAL; некорректные сетки отклоняются) + проверка реестра fixtures.test.ts. Мутации (без уточнения Bowring, перевёрнутая ось east, без замыкания долготы) роняют 4, 1 и 1 тест. Остаток: авторитетная сетка геоида (источник EGM96/EGM2008, лицензия и SHA-256) не установлена, поэтому проверка абсолютной точности MSL — BLOCKED_EXTERNAL; локальные преобразования завершены.

### TASK-037 — MAVLink2 codec

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Зафиксировать dialect/generator и реализовать binary parser/encoder.
- **Dependencies:** TASK-003, TASK-004, TASK-013.
- **Touched Files:** `packages/mavlink/package.json`, `packages/mavlink/dialect.lock.json`, `packages/mavlink/src/codec.ts`, `packages/mavlink/src/sensor-mapping.ts`, `tests/mavlink.test.ts`, `tests/fixtures/mavlink/golden.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `packages/mavlink/src/messages.ts`, `packages/mavlink/src/samples.ts`, `scripts/generate-mavlink-fixtures.py`, `tests/fixtures/registry.json`, `package-lock.json`, `scripts/bench-links-ew.mjs`, `tests/sensor-samples.ts`, `tests/links-ew-allocation.test.ts`, `packages/mavlink/NOTICE`.
- **Interfaces / Contracts:** HIL_GPS/HIL_SENSOR/HIL_ACTUATOR_CONTROLS/RC_CHANNELS_OVERRIDE; §6 engines spec.
- **DoD & Acceptance Criteria:** Official-generated golden frames совпадают по CRC_EXTRA/packing; arbitrary chunks/truncation/bad CRC/seq tested; DOP×100, gauss/hPa/LSB и uint64 tests; no unsafe any.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Кадры официального pymavlink 2.4.50 из закреплённого common XML совпадают побайтно: CRC_EXTRA, порядок, u64, extensions и усечение нулей. Проходят пять тестов codec/mapping: произвольные chunks, отказ CRC/signing, переполнение sequence и восстановление после ошибки потребителя. Все четыре типа и готовые буферы проходят G1 400/800/1200 Гц. Сохранены хеши диалекта/генератора/лицензии и синтетический реестр; signing и другие ID не поддерживаются.

### TASK-038 — RC и flight mode mapping

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Расширить USB input режимами и правильно формировать RC override.
- **Dependencies:** TASK-010, TASK-037.
- **Touched Files:** `packages/input/src/mode-channel.ts`, `packages/input/src/calibration-store.ts`, `packages/mavlink/src/rc-override.ts`, `apps/web/src/App.tsx`, `tests/rc-override.test.ts`, `tests/browser/radio.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/runtime.ts`, `packages/input/package.json`, `packages/input/src/index.ts`, `tests/fixtures/registry.json`, `apps/web/package.json`, `package-lock.json`, `scripts/bench-links-ew.mjs`, `tests/links-ew-allocation.test.ts`, `docs/hardware/radio-checklist.md`, `docs/ru/radio-checklist.md`, `docs/documentation-index.json`.
- **Interfaces / Contracts:** Pilot mailbox v2; RC profile endpoints/deadzone/mode slots; channels 1..8 vs 9..18 sentinel semantics.
- **DoD & Acceptance Criteria:** Calibration сохраняется с schema/version; invalid axes/pad unplug/reconnect снимают arm; zero throttle gate; PWM endpoints и release/ignore по группам проверены; real USB имеет отдельный hardware checklist.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Проходят четыре RC/profile теста и браузерный радио-тест; регрессии ввода/армирования/отключения зелёные. Версионированная калибровка сохраняет основные и редактируемую независимую ось режима; неверная/совпадающая ось обнуляет ввод, изменения снимают армирование, reload восстанавливает настройки. PilotRcMapper проверяет PWM и release/ignore групп каналов; mailbox v2 передаёт слоты без выдуманных режимов. Физический USB checklist docs/hardware/radio-checklist.md и docs/ru/radio-checklist.md имеет NOT_RUN.

### TASK-039 — Autopilot state machine

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Определить один активный autopilot backend и lifecycle/link policies.
- **Dependencies:** TASK-010, TASK-012, TASK-013, TASK-037.
- **Touched Files:** `packages/autopilot/package.json`, `packages/autopilot/src/adapter.ts`, `packages/autopilot/src/state-machine.ts`, `tests/autopilot-state.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `package-lock.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** disconnected→initializing→warming→ready→running→fault; actuators/health.
- **DoD & Acceptance Criteria:** Illegal transitions rejected; одновременно SITL и HITL невозможны; stale actuator/disarm/link loss не держит последнюю тягу бесконечно; no fake EKF READY.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Два теста проверяют взаимоисключение backend, запрещённые переходы, epoch/будущие/повторные controls, потерю здоровья, disarm, устаревание и обратные часы. READY требует здоровья от адаптера; одного времени недостаточно. Тайм-аут 100 мс. Методы с typed-array часами проходят три частоты G1. Реализован допуск; настоящая прошивка/декодер здоровья и живой UI-автопилот не заявлены.

### TASK-040 — Локальный WS bridge

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Создать loopback transport с session/origin проверками и bounded framing.
- **Dependencies:** TASK-003, TASK-037, TASK-039.
- **Touched Files:** `apps/bridge/package.json`, `apps/bridge/src/server.ts`, `apps/bridge/src/session.ts`, `apps/bridge/src/framing.ts`, `tests/bridge.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `package-lock.json`, `scripts/bench-links-ew.mjs`.
- **Interfaces / Contracts:** WS localhost:9002; binary frames version/length/epoch; UDP channels отдельно.
- **DoD & Acceptance Criteria:** Unauthorized Origin/session и oversized/flood frames rejected; binds loopback по умолчанию; split/coalesced frames/backpressure/reconnect tested; production WSS/PNA compatibility documented.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Три теста проходят с настоящими WS/UDP roundtrip, фрагментами/объединением доставки, отказом token/origin/session, epoch, sequence wrap, лимитами flood/размера, reconnect и инъекцией backpressure. CLI проверен на 127.0.0.1:9002; остановлен только свой процесс. Один клиент, payload 4096 байт, 4096 сообщений/с, очереди по умолчанию 65536 байт, простой 5 с. Описаны binary v1, направления, токен и WSS/PNA; JSON lockstep ArduPilot остаётся TASK-041.

### TASK-041 — ArduPilot JSON physics backend

- **Status:** DONE — Claude; baseline 6401104; 2026-10-16 (протокол проверен по закреплённому upstream; запуск живого SITL — TASK-042).
- **Title & Description:** Связать sensor truth и servo outputs в external SITL lockstep.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-040.
- **Touched Files:** `apps/bridge/src/ardupilot-json.ts`, `packages/autopilot/src/external-sitl.ts`, `tests/ardupilot-json.test.ts`, `tests/fixtures/sitl/json-protocol.json`, `apps/bridge/src/server.ts`, `apps/bridge/package.json`, `packages/autopilot/package.json`, `package-lock.json`, `tests/fixtures/sitl/generate.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Pinned ArduPilot JSON protocol, frame counters/time domain; MAVLink не подменяет physics JSON.
- **DoD & Acceptance Criteria:** UDP packet schema/endianness/servo map verified against pinned upstream; lost/duplicate/out-of-order frames без double-step; next tick ждёт корректный actuator, pause остаётся responsive.
- **Evidence:** Владелец Claude; baseline 6401104; 2026-10-16. Закреплён upstream: ArduPilot 8ab6afde107a91df1b5f60ade8f333cb8a61b190, SIM_JSON.h sha256 ba8f86c7..., SIM_JSON.cpp 9d611508..., examples/JSON/readme.md cfc34793... (полные hash в tests/fixtures/sitl/json-protocol.json; generate.py загружает файлы и проверяет в исходниках значения magic, порт 9002 и правило шага timestamp 0.1 с). Node 24.22.0: tests/ardupilot-json.test.ts 10 PASS (эталонные 16/32-канальные пакеты из Python struct декодируются, три некорректных пакета отклоняются без изменения выхода; ответ побайтно равен строке Python '%.9f'; перенос на TypeScript закреплённых parse_sensors/parse_array читает каждое поле, пример из upstream readme разбирается и проходит проверку; продемонстрирована опасность порядка ключей: velocity_wind перед velocity или отсутствие velocity заставляет upstream читать ветер как скорость, что валидатор моста отклоняет вместе с 7 другими некорректными строками; lockstep: step/duplicate с идентичной повторной отправкой/gap/stale/restart/invalid; 20000 кадров с seed, 5% потерь, 10% дубликатов и перестановками окна дают ровно один tick на каждый принятый новый кадр; отображение PWM с явными MOT_PWM_MIN/MAX и подсчётом ограничений; timestamp должен расти меньше чем на 0.1 с; SteppingPolicy sitl-lockstep возвращает waiting без блокировки; реальный loopback UDP + WebSocket мост пересылает корректный servo-пакет, отбрасывает некорректный, отвечает на полученный порт источника SITL и закрывает сессию при некорректной строке состояния) + регрессия bridge.test.ts 3 PASS. Мутации (дубликат снова выполняет шаг, потерян знак минус, мост принимает любую датаграмму) роняют 2, 1 и 2 теста. Проверка CLI: MIRAGE_ARDUPILOT_JSON_PORT=9002 запускает мост. Остаток: бинарник ArduPilot SITL не запускается; проверка на живом процессе относится к закреплённой обвязке TASK-042.

### TASK-042 — External SITL integration harness

- **Status:** TODO.
- **Title & Description:** Запускать pinned ArduPilot и проверять замкнутый полёт без облачных API.
- **Dependencies:** TASK-031, TASK-037, TASK-038, TASK-039, TASK-041.
- **Touched Files:** `scripts/run-sitl.mjs`, `scripts/sitl.lock.json`, `tests/integration/external-sitl.test.ts`, `tests/fixtures/sitl/parameters.parm`.
- **Interfaces / Contracts:** Process lifecycle, RC+sensor+actuator loop, telemetry recording.
- **DoD & Acceptance Criteria:** arm/takeoff/hold/land scenario реально выполнен с ненулевым числом frames; tests fail при fake/missing binary или bridge; cleanup только своих процессов; mode/altitude thresholds frozen fixture.

### TASK-043 — EKF warmup и health

- **Status:** TODO.
- **Title & Description:** Прогревать 30 sim s и допускать READY по реальной диагностике EKF.
- **Dependencies:** TASK-035, TASK-039, TASK-042.
- **Touched Files:** `packages/autopilot/src/warmup.ts`, `packages/autopilot/src/ekf-status.ts`, `tests/warmup.test.ts`, `tests/integration/ekf-ready.test.ts`.
- **Interfaces / Contracts:** Normalized ekf_flags; source freshness; SITL fast-forward only.
- **DoD & Acceptance Criteria:** Согласованные sensor timestamps; failed innovations не дают READY после таймера; acceleration factor измерен; HITL отвергает fast-forward; no startup EW до ready.

### TASK-044 — ArduPilot WASM feasibility gate

- **Status:** TODO.
- **Title & Description:** Проверить HAL/scheduler/storage/network/license и сохранить конкретное решение с прототипом.
- **Dependencies:** TASK-016, TASK-039, TASK-042.
- **Touched Files:** `docs/decisions/ardupilot-wasm.md`, `native/ardupilot/source.lock.json`, `native/ardupilot/feasibility.md`, `tests/ardupilot-wasm-capability.test.ts`.
- **Interfaces / Contracts:** Required browser HAL capabilities; supported firmware targets.
- **DoD & Acceptance Criteria:** Каждая capability имеет запускаемый probe/observed blocker; решение feasible/blocked с доказательствами; blocked оставляет 045..047 открытыми, не считается реализацией WASM режима.

### TASK-045 — ArduPilot WASM build

- **Status:** TODO.
- **Title & Description:** Собрать выбранный firmware с pinned toolchain и hash manifests.
- **Dependencies:** TASK-044.
- **Touched Files:** `native/ardupilot/CMakeLists.txt`, `native/ardupilot/toolchain.lock.json`, `scripts/build-ardupilot-wasm.mjs`, `packages/autopilot/src/wasm-loader.ts`, `tests/ardupilot-wasm-build.test.ts`.
- **Interfaces / Contracts:** Artifact ABI/license/firmware manifest.
- **DoD & Acceptance Criteria:** Reproducible artifact загружается в Worker; symbols и memory limits проверены; dependency blocker из 044 должен быть устранён, fake empty module запрещён.

### TASK-046 — Browser HAL для ArduPilot

- **Status:** TODO.
- **Title & Description:** Подключить clock/storage/sensor/actuator endpoints к WASM firmware.
- **Dependencies:** TASK-013, TASK-035, TASK-045.
- **Touched Files:** `native/ardupilot/hal/browser_hal.cpp`, `packages/autopilot/src/wasm-sitl.ts`, `tests/wasm-hal.test.ts`.
- **Interfaces / Contracts:** Sim clock lockstep, virtual storage, preallocated mailbox; отдельный AP worker если HAL требует.
- **DoD & Acceptance Criteria:** Native HAL probes и wasm probes одинаковы; no sockets/file API assumptions; sensor timing/actuator count validated; вкладка pause/terminate не deadlock.

### TASK-047 — WASM/native SITL parity

- **Status:** TODO.
- **Title & Description:** Сравнить одинаковый сценарий на двух backends и включить WASM mode только после gate.
- **Dependencies:** TASK-042, TASK-043, TASK-046.
- **Touched Files:** `tests/integration/wasm-sitl.test.ts`, `scripts/compare-autopilot.mjs`, `docs/validation/autopilot-parity.schema.json`.
- **Interfaces / Contracts:** Identical seed/parameters/airframe; mode/EKF/trajectory tolerances.
- **DoD & Acceptance Criteria:** arm/takeoff/land + failsafe на обоих; thresholds заданы до запуска (position RMSE<=0.5 m, attitude RMSE<=2° за reference 30 s); несовпадение диагностируется, не обновляется golden автоматически.

### TASK-048 — Web Serial transport

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Открывать порт только по gesture и обрабатывать stream/reconnect безопасно.
- **Dependencies:** TASK-005, TASK-037, TASK-039.
- **Touched Files:** `packages/autopilot/src/serial-transport.ts`, `apps/web/src/SerialConnect.tsx`, `tests/serial-transport.test.ts`, `tests/browser/serial-permission.spec.ts`, `packages/autopilot/src/serial-io.worker.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/App.tsx`, `apps/web/package.json`, `package-lock.json`.
- **Interfaces / Contracts:** ReadableStream chunks→MAVLink parser; permission/user gesture, port lifecycle.
- **DoD & Acceptance Criteria:** Mock chunk/error/disconnect/cancel cases; повторное открытие не дублирует reader; unsupported браузер disabled; mock не считается реальным HITL.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Четыре Serial stream теста проверяют владение, chunks, close во время open, permission/read/cancel ошибки, ограниченные записи и явный reopen. Три теста Chromium проверяют отсутствие автоматического запроса, отказ/нет API и разбор фрагментов отдельным I/O Worker с чистым disconnect. Один chunk с ACK, предел 4096 байт, тайм-аут 500 мс; UI обновляется через 150 мс. Аппаратный HITL остаётся недоступным/непроверенным.

### TASK-049 — HIL sensor/actuator streaming

- **Status:** DONE — Claude; baseline b28c8c2; 2026-10-16 (потоковая передача проверена на поддельных часах; физическое оборудование — TASK-050/051).
- **Title & Description:** Выдавать HIL_SENSOR/HIL_GPS и принимать HIL_ACTUATOR_CONTROLS по реальным часам.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-037, TASK-048.
- **Touched Files:** `packages/autopilot/src/hitl.ts`, `packages/autopilot/src/hil-clock.ts`, `tests/hil-stream.test.ts`, `packages/autopilot/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** IMU 200/400, GNSS 5/10 Hz; actuator mapping/signing/time.
- **DoD & Acceptance Criteria:** За 60 s fake real clock верные counts/bytes/timestamps; dropout и queue overflow дают fault; fields_updated отражает реальные обновления; serial budget вычислен как baud/10 с запасом >=30%.
- **Evidence:** Владелец Claude; baseline b28c8c2; 2026-10-16. Node 24.22.0: tests/hil-stream.test.ts 17 PASS. Двенадцать прогонов по 60 с на поддельных часах реального времени (SteppingPolicy hitl-realtime с вызовом каждые 1 мс) покрывают физику 400/800/1200 Гц x IMU 200/400 Гц x GNSS 5/10 Гц с mag 100 Гц и baro 50 Гц: число tick 60*physicsHz, кадры HIL_SENSOR 60*imuHz и HIL_GPS 60*gnssHz декодируются MavParser без ошибок CRC/неподдерживаемых сообщений, метки времени ровно k*1e6/rate микросекунд, считанные байты равны выданным, fields_updated содержит accel/gyro в каждом кадре и mag/baro строго по своим расписаниям. Бюджет канала: 400*77+10*51 = 31310 B/s, 460800 бод принимается (67.9%), 115200 и 230400 отклоняются для 400 Гц; переполнение очереди фиксируется и сбрасывается reset; некорректные наблюдения не выдаются; приём актуаторов принимает строго более новые кадры в допустимом диапазоне (включая u64-время через 2^32), отклоняет повтор/более старые/вне диапазона без изменения выхода, а пропадание фиксируется через 100 мс. Мутации (mag в каждом кадре, без требования запаса, без проверки переполнения) роняют 12, 1 и 1 тест. Остаток: физический полётный контроллер и последовательное оборудование не задействованы (TASK-050/051).

### TASK-050 — HITL firmware capability gate

- **Status:** DONE — Claude; baseline 0006e07; 2026-10-16 (проверка реализована; доступность HITL — BLOCKED_EXTERNAL: нет проверенного профиля платы).
- **Title & Description:** Проверять build flags/плату/сообщения до объявления режима работоспособным.
- **Dependencies:** TASK-039, TASK-049.
- **Touched Files:** `packages/autopilot/src/hitl-capabilities.ts`, `docs/hardware/hitl-matrix.md`, `tests/hitl-capabilities.test.ts`, `docs/ru/hitl-matrix.md`, `docs/documentation-index.json`, `packages/autopilot/src/state-machine.ts`, `packages/autopilot/package.json`, `tests/autopilot-state.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Board+firmware SHA+HIL mode+MAVLink support matrix.
- **DoD & Acceptance Criteria:** Unsupported HIL_SENSOR/ACTUATOR path не даёт READY; записан проверенный поддерживаемый профиль или точный BLOCKED_EXTERNAL; наличие SITL не доказательство HITL.
- **Evidence:** Владелец Claude; baseline 0006e07; 2026-10-16. Исходники проверены на закреплённых коммитах: ArduPilot 8ab6afde... (GCS_Common.cpp sha256 345233ce..., обработчики MAVLink ArduCopter/ArduPlane, GCS.h, AP_InertialSensor.cpp: нет обработки HIL_SENSOR/HIL_GPS/HIL_ACTUATOR_CONTROLS; GPS через GPS_INPUT) и PX4 4d7e4de7... (mavlink_receiver.cpp sha256 2e22f0d3...: HIL_SENSOR только при включённом режиме HIL, HIL_GPS в режиме HIL или с use_hil_gps; HIL_ACTUATOR_CONTROLS.hpp sha256 1ac5017c...: поток). Node 24.22.0: tests/hitl-capabilities.test.ts 6 PASS (без профиля/наблюдения — BLOCKED_EXTERNAL с точными требованиями независимо от доступности SITL; ArduPilot — UNSUPPORTED с тремя причинами даже при проверенном профиле и живых данных; восемь случаев PX4, в каждом из которых недостаёт одного доказательства, дают BLOCKED_EXTERNAL с соответствующим требованием; полные доказательства дают замороженный выданный READY; AutopilotSession отклоняет hitl без вердикта, с вердиктом BLOCKED и с поддельным литералом READY и принимает выданный READY; разбор профиля отклоняет 7 некорректных входов; документ матрицы содержит записанные коммиты и hash) + tests/autopilot-state.test.ts обновлён под более строгий контракт connect (2 PASS). Мутации (флаг HIL не требуется, READY не регистрируется, сессия принимает любой вердикт) роняют 1, 2 и 1 тест. Новая двуязычная пара docs/hardware/hitl-matrix.md + docs/ru/hitl-matrix.md зарегистрирована; check:docs — 11 пар. Остаток: сама доступность HITL — BLOCKED_EXTERNAL, пока профиль платы не проверен на оборудовании (TASK-051).

### TASK-051 — Реальный HITL acceptance

- **Status:** TODO.
- **Title & Description:** Запустить аппаратный стенд и сохранить измеряемый отчёт транспорт/loop integrity.
- **Dependencies:** TASK-043, TASK-049, TASK-050.
- **Touched Files:** `scripts/bench-hitl.mjs`, `docs/hardware/hitl-test-procedure.md`, `docs/validation/hitl-report.schema.json`, `tests/hitl-report.test.ts`.
- **Interfaces / Contracts:** Board/firmware identity, timestamp jitter, sustained throughput, fail-safe.
- **DoD & Acceptance Criteria:** 60 s sensor stream + actuator response; p99 sample scheduling lateness<=5 ms at 200 Hz или <=2.5 ms at 400 Hz; no overflow/unaccounted loss; unplug disables actuators; без платы статус BLOCKED_EXTERNAL.

## Phase 4: EW & Sensor Faults

### TASK-052 — Hazard volumes

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Вычислять bounded exposure для sphere/cone и их комбинаций.
- **Dependencies:** TASK-010, TASK-032.
- **Touched Files:** `packages/ew/package.json`, `packages/ew/src/volumes.ts`, `tests/ew-volumes.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `package-lock.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES §5; r_min, power-relative, angular taper.
- **DoD & Acceptance Criteria:** Center/boundary/cone axis и sum order tests; exposure finite при r=0; outside volume=0; counts/capacity<=64, no per-step allocation.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Два численных теста проверяют обратный квадрат, конечный центр, границы радиуса/конуса, ось/taper, порядок ID, отказ duplicate/capacity и неизменность typed-array входов. Соблюдаются <=64 объёма и насыщение 1e12; severityFromNedInto проходит три G1 частоты. Это безразмерная учебная severity, не измеренный RF-бюджет.

### TASK-053 — GNSS jamming

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Реализовать receiver-training severity→satellites/DOP/fix с hysteresis.
- **Dependencies:** TASK-035, TASK-052.
- **Touched Files:** `packages/ew/src/gnss-jamming.ts`, `tests/gnss-jamming.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `packages/mavlink/src/samples.ts`, `scripts/bench-links-ew.mjs`, `tests/sensor-samples.ts`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** GpsSample; q filtered; Njam 0..3, DOPjam 50..99.
- **DoD & Acceptance Criteria:** q=0 сохраняет baseline, strong jam fix=0; restore thresholds корректны; no NaN/sentinel overflow; IMU/truth не изменяются.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Три теста проверяют аналитический экспоненциальный фильтр, zero/reset identity, сильный no-fix, гистерезис 0.8/0.6, восстановление по известным спутникам и сохранение неизвестного/худшего baseline. GPS-источник не меняется; IMU/барометр/truth не являются входами. advanceInto/distortInto проходят три частоты G1. Потеря пакетов, физический приёмник и ответ режима ArduPilot не заявлены.

### TASK-054 — Position-step spoofing

- **Status:** DONE — Claude; baseline 91579b7; 2026-10-16.
- **Title & Description:** Добавить атомарное смещение GPS в заданный tick.
- **Dependencies:** TASK-010, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/position-step.ts`, `tests/position-step.test.ts`, `packages/ew/package.json`, `packages/sensors/src/geodesy.ts`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** offsetNedM; source immutable; WGS84→wire after distortion.
- **DoD & Acceptance Criteria:** Position прыгает ровно на offset в пределах geodesy tolerance, baseline velocity остаётся; zero/disable/reset cases; altitude down sign и antimeridian tested.
- **Evidence:** Владелец Claude; baseline 91579b7; 2026-10-16. Оракул: разность искажённой и исходной точки, выраженная в касательной системе исходной точки (проверенной по независимой Python-фикстуре WGS84 в TASK-036), должна равняться заданному смещению с точностью 1 мм. Node 24.22.0: tests/position-step.test.ts 5 PASS (до запланированного tick изменений нет, в нём — атомарный шаг по трём осям с сохранением скорости/времени/DOP/fix/курса; +10 м Down понижает MSL на 10 м; смещение 9998 м выполняется с точностью 1 мм, смещение 10000.03 м отклоняется; 3 км на восток через антимеридиан приводят долготу в [-pi, pi); 1.5 км на север через полюс; нулевое смещение — точное тождество, disable/reset восстанавливают базу, источник не изменяется, некорректные источники и расписания отклоняются; MSL переводится через синтетическую сетку геоида, поэтому чистый шаг Down меняет H ровно на -D). LocalTangentFrame получил setOrigin без аллокаций; geodesy.test.ts 8 PASS без изменений. Мутация (ундуляция геоида не учитывается на входе) роняет 1 тест.

### TASK-055 — Когерентный drift

- **Status:** DONE — Claude; baseline 263ce7a; 2026-10-16.
- **Title & Description:** Интегрировать bias position/velocity на physics clock с speed cap и recovery.
- **Dependencies:** TASK-011, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/velocity-drift.ts`, `tests/velocity-drift.test.ts`, `packages/ew/package.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** b/v/a equations §5; hold-offset vs step-to-truth.
- **DoD & Acceptance Criteria:** Constant acceleration analytic fixtures; piecewise speed cap согласован с position; разные GPS/render rates дают одинаковые states; не обещается обход EKF gate.
- **Evidence:** Владелец Claude; baseline 263ce7a; 2026-10-16. Оракул: замкнутые формулы кинематики, независимые от шага. Node 24.22.0: tests/velocity-drift.test.ts 12 PASS (b = a t^2/2 и v = a t за 30 с при 400/800/1200 Гц с точностью 1e-8 м и 1e-10 м/с; ограничение скорости при |a| = 0.3 и пределе 2 м/с с t_c = 6.667 с внутри шага при любой частоте совпадает с 0.5|a|t_c^2 + cap (t - t_c) с точностью 1e-8 м и |v| = cap с точностью 1e-12; приращения b на шаге лежат между v_start dt и v_end dt при переходе через предел; hold-offset переходит в удержание с тормозным путём v^2/(2 decel) и затем точно удерживает смещение; step-to-truth обнуляет состояние и учитывает разрыв; выборка GPS 10 Гц против 5 Гц плюс три чтения рендера на шаг дают побитово одинаковое состояние; искажённая скорость (1, 1, 0) даёт курс pi/4, а дрейф смещает точку на восток; курс неизвестен ниже 0.05 м/с; некорректные пресеты/dt отклоняются; дрейф удерживается на границе 10 км). Мутации (обрезка скорости после неразделённого шага, мгновенная остановка при восстановлении) роняют 4 и 1 тест. Никаких утверждений о реакции шлюзов EKF не делается.

### TASK-056 — Magnetic anomaly

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Искажать mag vector в правильном sensor/body frame.
- **Dependencies:** TASK-034, TASK-052.
- **Touched Files:** `packages/ew/src/magnetic.ts`, `tests/magnetic-anomaly.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** Rz*Ry*Rx + biasBodyGauss; truth quaternion unchanged.
- **DoD & Acceptance Criteria:** Zero anomaly identity; 90° synthetic rotations сохраняют norm; bias unit tests; stationary truth/gyro не изменены; source/target alias запрещён.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Магнитный тест проверяет identity, синтетические повороты body на 90 градусов/норму, gauss bias, неизменность источника и отказ пересечения views. Rz*Ry*Rx вычисляется до шага; проходят три частоты G1. Truth/gyro не принимаются на вход; toilet-bowling/ответ EKF не гарантирован.

### TASK-057 — Motor faults

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Инъецировать отказ по стабильному motor ID без изменения GPS truth path.
- **Dependencies:** TASK-010, TASK-025, TASK-027.
- **Touched Files:** `packages/physics/src/motor-fault.ts`, `tests/motor-fault.test.ts`, `native/bet/tests/motor_failure.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `packages/physics/package.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** power-cut vs synthetic instant-thrust-loss; remainingThrustFraction.
- **DoD & Acceptance Criteria:** Power-cut сохраняет passive drag/spool; instant fault обнуляет выбранную силу в текущем tick и помечает synthetic validity; остальные motors не меняются; torque arm verified.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Два TypeScript теста проверяют стабильные ID, выборочное изменение привода/силы, пассивный wrench, переменный момент в массивах, reset и бит 5 ModelOutsideValidity. Нативный motor_failure проверяет ненулевой спад оборотов без привода и плечевой момент выбранного ротора. Три частоты G1 проходят. Power-cut и синтетический instant-thrust-loss различны; полётная проверка компенсации полного BET/микшера не заявлена.

### TASK-058 — EW pipeline composition

- **Status:** DONE — Claude; baseline c57bc60; 2026-10-16.
- **Title & Description:** Объединить sensor effects, registry и deterministic command application.
- **Dependencies:** TASK-053, TASK-054, TASK-055, TASK-056, TASK-057.
- **Touched Files:** `packages/ew/src/engine.ts`, `packages/sensors/src/pipeline.ts`, `tests/ew-pipeline.test.ts`, `packages/ew/src/gnss-jamming.ts`, `packages/ew/src/magnetic.ts`, `packages/ew/src/position-step.ts`, `packages/ew/src/velocity-drift.ts`, `packages/ew/package.json`, `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `packages/sensors/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** EwEngine, GpsSample/ImuSample, ew_flags и effect precedence.
- **DoD & Acceptance Criteria:** Порядок: baseline→step/drift→jamming→quantization, mag отдельно; multiple faults/reset consistent; source truth bit-identical; identical seed/event log produces identical packets.
- **Evidence:** Владелец Claude; baseline c57bc60; 2026-10-16. Node 24.22.0: tests/ew-pipeline.test.ts 6 PASS (шаг 300/-200/5 м плюс 10 с дрейфа равен одному применению WGS84 суммарного смещения, добавлена скорость дрейфа, затем подавление даёт fix 0, 1 спутник, HDOP 99, а полезная нагрузка HIL_GPS равна SensorMapping искажённого отсчёта; отказы GNSS не меняют магнитометр, а аномалия с рысканием 90 град отображает (x, y) в (-y, x) плюс смещение, не затрагивая accel/gyro/baro и GPS; замена в реестре, отключение невладельцем, motor-loss передаётся в MotorFaults (момент 2 -> 0.5 и обратно), ёмкость 16 слотов с registry-full, reset очищает флаги/моторы и записывает seed, motor-loss без MotorFaults отклоняется; массив истинного состояния, контекст и базовые отсчёты побитово неизменны после 2000 шагов; одинаковые seed и журнал команд через ControlProcessorV2 дают одинаковые байты HIL_GPS и флаги за 4000 tick; окна по 1e6 шагов со всеми пятью эффектами, IMU 200 Гц и GNSS 10 Гц через конвейер: хотя бы одно из максимум трёх окон после прогрева должно пройти без GC, чего не может выполнить аллокация на каждом шаге (16 МБ на окно); отдельные прогоны дают 0 GC в первом окне, а один случайный GC появился однажды под параллельной нагрузкой полного набора) + 32 регрессионных PASS в наборах геодезии, шага, дрейфа, подавления, магнитной аномалии и аллокаций links-ew. Проверка GC сначала провалилась (5 GC на 1e6 шагов); пошаговый зонд нашёл причину в упаковке float-аргументов невстраиваемых вызовов (integrate/speed дрейфа, вызовы касательной системы и геоида, аргументы dt), исправлено вариантами через typed arrays/поля; после этого все этапы дают 0. Мутации (отключение невладельцем снимает эффект, магнитная аномалия применяется к акселерометру, один объект на шаг: 14/13/13 GC в трёх окнах) роняют 1, 2 и 1 тест.

### TASK-059 — EKF scenario regressions

- **Status:** TODO.
- **Title & Description:** Измерять реакцию ArduPilot на все классы EW/отказов без hardcoded обещания режима.
- **Dependencies:** TASK-042, TASK-043, TASK-058.
- **Touched Files:** `tests/integration/ew-sitl.test.ts`, `tests/fixtures/scenarios/ew-matrix.json`, `scripts/report-ekf.mjs`.
- **Interfaces / Contracts:** Innovation/status/mode/trajectory AAR trace; pinned EKF parameters.
- **DoD & Acceptance Criteria:** No-fault control scenario и каждый fault реально запущены; trace показывает изменённые observations и ответ EKF; acceptance envelope зафиксирован для версии; неизвестная реакция — investigation, не silent PASS.

## Phase 5: Environment & Shaders

### TASK-060 — Provider/license policy

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Разделить Google live tiles и собственные cacheable datasets до реализации cache.
- **Dependencies:** TASK-003, TASK-005.
- **Touched Files:** `packages/terrain/package.json`, `packages/terrain/src/provider-policy.ts`, `docs/decisions/terrain-licensing.md`, `tests/terrain-policy.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/ru/terrain-licensing.md`, `docs/documentation-index.json`, `package-lock.json`.
- **Interfaces / Contracts:** ProviderPolicy {attribution, allowedCache, ttl, offline, datasetLicense}.
- **DoD & Acceptance Criteria:** Google persistent R2/prefetch запрещены по default; разрешение требует evidence; unknown policy fail-closed; fixtures независимы от API key; факт оплаты API не считается offline licence.

- **Execution scope:** Цель: реализовать контракт с независимыми численными/протокольными тестами или проверками жизненного цикла. Критерий провала: ошибка контракта, аллокаций, происхождения или жизненного цикла. Внешняя приёмка оборудования/провайдера проверяется отдельно.

- **Evidence (2026-10-16):** Тест политики отклоняет неизвестных поставщиков и постоянный кеш/prefetch/offline Google, требует атрибуцию/лицензию и хеш проверенного разрешения для кеширования лицензированных данных, проверяет неизменяемую политику. Google TTL 0 не даёт приложению права хранения. Зарегистрировано решение terrain-licensing EN/RU; API-ключ, живой запрос, кеш и развёртывание не нужны.

### TASK-061 — Tiles streaming adapter

- **Status:** DONE — Claude; baseline 89b46f1; 2026-10-16 (локальный fixture проверен; живые тайлы Google — BLOCKED_EXTERNAL до TASK-063 и учётных данных).
- **Title & Description:** Подключить один выбранный 3D Tiles loader к R3F с local licensed fixture.
- **Dependencies:** TASK-015, TASK-036, TASK-060.
- **Touched Files:** `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `apps/web/src/FlightScene.tsx`, `tests/tiles-provider.test.ts`, `tests/browser/terrain.spec.ts`, `packages/terrain/package.json`, `apps/web/src/App.tsx`, `apps/web/src/terrain-config.ts`, `apps/web/src/style.css`, `apps/web/package.json`, `package-lock.json`, `tests/support/terrain-harness.ts`, `tests/fixtures/tiles/generate.py`, `tests/fixtures/tiles/tileset.json`, `tests/fixtures/tiles/tile.glb`, `tests/fixtures/registry.json`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** 3D Tiles transforms, ECEF/local origin, attribution, abort/dispose.
- **DoD & Acceptance Criteria:** Fixture tileset загружается/позиционируется; cancelled request освобождает ресурсы; CORS/COEP errors видны; Google integration при missing key — BLOCKED_EXTERNAL, local tests продолжаются.
- **Evidence:** Владелец Claude; baseline 89b46f1; 2026-10-16. Загрузчик 3d-tiles-renderer 0.5.3 (Apache-2.0, опубликован 2026-09-18) закреплён в packages/terrain; lockfile добавляет только его и вспомогательные pbf/pmtiles/vector-tile. Fixture: собственный tileset 3D Tiles 1.1 под CC0 (tests/fixtures/tiles/generate.py: сетка 200 м с маркером 20 м, корневое преобразование ENU-to-ECEF в 47.3769N 8.5417E 400 м), оба файла зарегистрированы. Node 24.22.0: tests/tiles-provider.test.ts 7 PASS (живой Google без прокси — BLOCKED_EXTERNAL, локальный лицензированный — READY; неверная политика/URL блокируются; размещение переводит базис ENU, записанный Python, в рендер (100,0,0)/(0,20,0)/(0,0,-100) с точностью 1e-6 м; dispose прерывает выполняющиеся запросы без записи ошибок и отклоняет последующие; собственный сигнал загрузчика передаётся; TypeError классифицируется как cors-or-network, 404 — как http, с режимом CORS и без учётных данных; заголовок GLB и происхождение CC0; конфигурация приложения по умолчанию выключена, разбирает локальный tileset и блокирует четыре некорректных набора настроек). Chromium: tests/browser/terrain.spec.ts 2 PASS (реальный загрузчик загружает fixture: габариты (-100,0,-100)..(100,20,100) и северо-восточный угол в рендере (100,0,-100) с точностью 1 см, геометрия загружена в GPU, каждая геометрия/материал освобождены, после dispose 0 запросов и 0 моделей, атрибуция сохранена; недоступный cross-origin tileset сообщается как cors-or-network). Мутации (перевёрнута строка north, dispose пропускает загрузчик, TypeError не классифицируется) роняют unit- и/или браузерные тесты. Сборка: существовавшее предупреждение о размере chunk не изменилось по сути (главный chunk origin/main 1100.55 kB, теперь 1103.36 kB); загрузчик — отдельный chunk 114 kB по требованию, порог не повышался. Остаток: живые Google 3D Tiles — BLOCKED_EXTERNAL (прокси TASK-063 и учётные данные поставщика).

### TASK-062 — LOD и GPU budget

- **Status:** DONE — Claude; baseline ea69c6a; 2026-10-16 (синтетические бюджеты проверены; объём на реальном GPU и время кадра на целевом устройстве открыты).
- **Title & Description:** Ограничить сетевой/декодирующий/GPU terrain workload.
- **Dependencies:** TASK-061.
- **Touched Files:** `packages/terrain/src/lod-budget.ts`, `packages/terrain/src/resource-cache.ts`, `tests/terrain-budget.test.ts`, `packages/terrain/src/tiles-scene.ts`, `packages/terrain/package.json`, `tests/support/terrain-harness.ts`, `tests/browser/terrain.spec.ts`.
- **Interfaces / Contracts:** Bounded request queue, CPU/GPU byte accounting, SSE limits.
- **DoD & Acceptance Criteria:** Synthetic flythrough не превышает 2 GiB terrain GPU estimate и 512 MiB decoded CPU cache; eviction вызывает dispose; idle queue не растёт; quality degrade deterministic.
- **Evidence:** Исполнитель Claude; база ea69c6a; 2026-10-16. Node 24.22.0: tests/terrain-budget.test.ts 12 PASS. Модульные случаи: оценки байтов; значения LodBudget по умолчанию (2 GiB / 512 MiB), неверные параметры, огрубление при превышении любого бюджета, насыщение на 256 px, прогнозирующее восстановление после 30 спокойных кадров (кадр с превышением или выше прогноза сбрасывает серию); порядок RequestQueue по приоритету/возрасту, дубликаты, предел активных, отбрасывание/вытеснение; LRU-вытеснение кэша, отказ при жёстком пределе с освобождением и спросом за кадр. Пролёт с seed (mulberry32, seed 0x5eed и 7; 400 кадров по 30 м/кадр, затем 200 кадров зависания; радиус обзора 2 км; тайлы 12..36 MiB, самый детальный уровень ~30 GiB): максимум GPU <= 2 GiB и CPU <= 512 MiB в каждом кадре при наличии отказов, вытеснений и огрубления; каждый созданный ресурс освобождён ровно один раз; очередь <= 256; очередь и активные загрузки опустошаются за 60 кадров зависания и остаются пустыми при постоянных объёме и цели; одинаковые трассы для одного seed и разные для другого. Убитые мутации: нет жёсткого предела, нет освобождения при удалении, вытеснение видимых тайлов, непрогнозирующее восстановление, серия не сбрасывается при превышении, спрос не сбрасывается, обратный порядок при равенстве (незащищённый цикл добавления зависает и убит по таймауту). TilesScene ограничивает LRU загрузчика min(бюджетов) и управляет errorTarget; tests/browser/terrain.spec.ts (Chromium) проверяет предел 512 MiB, ненулевую оценку кэша и SSE 16 для фикстуры. Гейты: см. коммит. Объём на реальном GPU и время кадра на целевом устройстве остаются открытыми (программный GPU в облаке).

### TASK-063 — Cloudflare tiles proxy

- **Status:** DONE — Claude; база e9ad0f3; 2026-10-16 (локальные тесты Worker; развёртывание и живые учётные данные поставщика требуют отдельного разрешения).
- **Title & Description:** Создать authenticated proxy с quota, attribution/CORS и разрешёнными TTL.
- **Dependencies:** TASK-060, TASK-061.
- **Touched Files:** `services/tiles-worker/package.json`, `services/tiles-worker/wrangler.jsonc`, `services/tiles-worker/src/index.ts`, `services/tiles-worker/src/policy.ts`, `tests/tiles-proxy.test.ts`, `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `tsconfig.json`.
- **Interfaces / Contracts:** ProviderPolicy, opaque upstream key binding, origin/session checks.
- **DoD & Acceptance Criteria:** Local Worker tests: key не попадает клиенту/logs; bad origin/session и quota rejected; provider cache restrictions соблюдены; external deployment требует отдельного разрешения, не входит в local test success.
- **Evidence:** Исполнитель Claude; база e9ad0f3; 2026-10-16. Node 24.22.0: tests/tiles-proxy.test.ts 10 PASS с поддельным поставщиком и поддельным хранилищем Durable Object (без живых запросов к поставщику и без развёртывания). Случаи: конфигурация отказывает по умолчанию (нет ключа, короткий ключ подписи, пустые/не HTTPS/с путём origin, неверный JSON, постоянная политика Google, лицензированная политика, границы TTL) и отвечает 503 без запросов к поставщику; отсутствующий/чужой Origin — 403, preflight — 204 с заголовком сеанса; отсутствующий, подделанный, искажённый, чужого origin, истёкший сеанс и сеанс с чужим ключом — 401 до любого запроса к поставщику; пересылка добавляет ключ только к запросу поставщику, сохраняет только параметр Google session, удаляет set-cookie, задаёт CORS/CORP, Cache-Control no-store (TTL 0) и атрибуцию; HEAD без тела; чужие пути, обход каталогов, двойные слеши, клиентские ключи, лишние или повторные параметры и методы кроме GET отклоняются; ответ 403 поставщика с ключом в теле даёт общий 503, тело JSON с ключом блокируется ответом 502, исключение поставщика даёт 502; квоты запросов на сеанс и выдачи сеансов на IP возвращают 429 и сбрасываются после окна; проверка requestTilesSession на клиенте и заголовок сеанса TileFetchTracker от начала до конца. После всех тестов ни одно тело/заголовок ответа и ни одно событие журнала не содержит ключ (наблюдалось >20 каждого). Убитые мутации: пересылка произвольных параметров, отключённая проверка утечки ключа, привязка к origin, срок действия, квота со сдвигом на единицу, пересылка ошибок поставщика, отключённая проверка origin, отсутствующий ключ у поставщика, сброс окна квоты, политика кэша по TTL. wrangler.jsonc привязывает секреты только по имени; развёртывание, живой ключ и проверка человека в стиле Turnstile остаются внешними.

### TASK-064 — R2 для разрешённых datasets

- **Status:** DONE — Claude; база f35efe6; 2026-10-16 (тесты на эмуляторе; привязка R2 и постоянное кэширование требуют явного разрешения).
- **Title & Description:** Реализовать bounded 10–15 km regional cache только для разрешённого контента.
- **Dependencies:** TASK-062, TASK-063.
- **Touched Files:** `services/tiles-worker/src/r2-cache.ts`, `packages/terrain/src/region-manifest.ts`, `tests/r2-cache.test.ts`, `tests/support/memory-r2.ts`, `packages/terrain/package.json`.
- **Interfaces / Contracts:** Dataset hash/license, cache key/version/TTL, region manifest; deny Google unless explicit lawful policy.
- **DoD & Acceptance Criteria:** Local R2 emulator hit/miss/expiry/evict tests; bytes/quota cap; geographic radius filter 10/15 km; cacheable=false никогда не пишет R2; отсутствие прав/данных явно блокирует этот provider.
- **Evidence:** Исполнитель Claude; база f35efe6; 2026-10-16. Node 24.22.0: tests/r2-cache.test.ts 8 PASS с tests/support/memory-r2.ts (эмулятор подмножества привязки R2 в памяти с постраничным перечислением; не Miniflare). Случаи: структура манифеста, границы радиуса 10/15 км, повторяющиеся пути и обход каталогов, хеш/размер тайла, неизвестные поля и проверка политики; несовпадение хеша набора отклоняется; решения (Google BLOCKED даже с подтверждением, без подтверждения BLOCKED, пустой хеш или индекс BLOCKED, cacheable=false / только память / TTL 0 NO_CACHE); расстояние WGS84 (0.1° широты на 47.4° = 11.09..11.14 км); промах -> запись -> попадание без обращения к источнику, истечение после TTL удаляет объект и загружает заново, формат ключа и метаданные; ограничение 3000 байт соблюдается вытеснением самого старого и заменой существующего ключа; нет записей вне 10 км (запись в пределах 15 км), для тайлов вне индекса, при несовпадении хеша (не отдаётся) или при cacheable=false (0 записей при повторных чтениях); заблокированные манифесты не загружают и не записывают; версии кэша изолированы. Убитые мутации: проверка радиуса, истечение, удаление истёкшего, ограничение байтов, проверка хеша, защита записи NO_CACHE, правило Google, флаг cacheable, граница радиуса, постраничное перечисление, версионированный префикс, пустой индекс. Бакет R2 не привязан; постоянное кэширование требует явного разрешения, а набор данных с проверенными правами ещё не зарегистрирован.

### TASK-065 — Collision terrain LOD

- **Status:** TODO.
- **Title & Description:** Готовить collision mesh отдельно от визуального streaming и менять chunks на границе tick.
- **Dependencies:** TASK-029, TASK-061, TASK-062.
- **Touched Files:** `packages/terrain/src/collision-builder.worker.ts`, `packages/terrain/src/collision-chunks.ts`, `tests/terrain-collision.test.ts`.
- **Interfaces / Contracts:** Immutable versioned collision chunks, local origin, readiness around vehicle.
- **DoD & Acceptance Criteria:** Visual eviction не убирает активную землю под шасси; seam/drop tests; incomplete terrain останавливает/ограничивает полёт явно; heavy decode не запускается в physics worker.

### TASK-066 — WebGPU renderer capability

- **Status:** DONE — Claude; база 60ba4cf; 2026-10-16 (путь WebGL2, откаты и жизненный цикл проверены; рендеринг WebGPU здесь пропущен с причиной: нет работающего адаптера, поэтому путь WebGPU ждёт запуска в браузере с GPU).
- **Title & Description:** Добавить renderer adapter с WebGL2 fallback и resource lifecycle.
- **Dependencies:** TASK-005, TASK-061.
- **Touched Files:** `apps/web/src/render/renderer.ts`, `apps/web/src/render/webgpu.ts`, `tests/browser/render-backends.spec.ts`, `apps/web/src/FlightScene.tsx`, `tests/support/render-harness.ts`.
- **Interfaces / Contracts:** Same scene/material capabilities; browser selects Metal/DX backend.
- **DoD & Acceptance Criteria:** Available GPU modes запускаются, unsupported mode skipped с причиной, не выдаётся за pass; shader capability failures fallback; no leaked resources after renderer switch.
- **Evidence:** Исполнитель Claude; база 60ba4cf; 2026-10-16. Chromium (Playwright 1.56.1, SwiftShader; флаги спецификации добавляют --enable-unsafe-webgpu --use-webgpu-adapter=swiftshader): tests/browser/render-backends.spec.ts — 5 пройдено, 1 пропущен. WebGL2 рисует освещённый текстурированный куб (центральный пиксель не цвета фона), info.memory падает до 0 геометрий/текстур после освобождения 1 геометрии/материала/текстуры, контекст потерян после dispose; сломанный ShaderMaterial обнаруживается по журналу шейдера и заменяется пурпурным резервным материалом, который рисуется; запрошенный бэкенд WebGPU откатывается на WebGL2 с точной причиной; переключение рендереров освобождает каждый перед следующим; приложение учитывает ?renderer=webgl2|webgpu и показывает бэкенд и причину отката на холсте. ПРОПУЩЕН с причиной: "WebGPU unavailable: WebGPU adapter "google swiftshader" is not functional: device lost: A valid external Instance reference no longer exists." (программный адаптер теряет устройство при первом выводе на холст). Путь рендеринга WebGPU, его область валидации и откат по внедрённой пробе при доступном адаптере остаются непроверенными, пока спецификацию не запустит браузер с работающим адаптером WebGPU. Убитые мутации: игнорирование ошибки шейдера, неосвобождённые текстуры, непотерянный контекст, атрибут бэкенда из запроса вместо результата.

### TASK-067 — FPV camera/fisheye

- **Status:** DONE — Claude; база 778ee75; 2026-10-16 (WebGL2 проверен; fisheye для WebGPU не реализован: проход — ShaderMaterial WebGL).
- **Title & Description:** Отделить FPV pose/projection и lens distortion от внешней камеры.
- **Dependencies:** TASK-015, TASK-066.
- **Touched Files:** `packages/cameras/package.json`, `packages/cameras/src/fpv-camera.ts`, `packages/cameras/src/shaders/fisheye.glsl`, `tests/fisheye.test.ts`, `tests/browser/fpv.spec.ts`, `packages/cameras/src/fisheye.ts`, `packages/cameras/src/fisheye-material.ts`, `tests/support/fpv-harness.ts`, `package-lock.json`.
- **Interfaces / Contracts:** CameraConfig {fov, mount FRD, distortion}; immutable truth.
- **DoD & Acceptance Criteria:** Zero distortion identity; optical-center/radial mapping fixtures; positive/negative edge coordinates finite; analytic projection и viewport resize tested; no truth mutation.
- **Evidence:** Исполнитель Claude; база 778ee75; 2026-10-16. Node 24.22.0: tests/fisheye.test.ts 11 PASS: модель none — точная тождественность с камерой-источником, выведенной из выходной; эквидистантная k=0 при 120° отображает 30° в u=0.75, а по вертикали — с учётом соотношения сторон пикселей (замкнутая форма); при k=0 и k=(0.08,-0.015,0.002,-0.0003) каждый луч (theta 0.5..60°, шесть азимутов) обращается в UV источника там, куда его проецирует PerspectiveCamera three.js с выведенными FOV/соотношением, с точностью 1e-9; смещение главной точки (20,-10) px помещает туда оптическую ось с радиальной симметрией; изменение размера сохраняет горизонтальное поле зрения; выходы конечны на сетке 121x121, включая 10% за краями, при полном покрытии кадра; немонотонные объективы, 170° и неверные размеры отклоняются. FpvCamera: оси вперёд на север/восток, проекция точки в 10 м впереди в центр, наклон вверх 30°, повёрнутое смещение крепления, вектор вправо при крене +90°, эквивалентность q/-q, замороженная поза не меняется, неверный кватернион игнорируется, изменение размера. Chromium WebGL2 (SwiftShader): tests/browser/fpv.spec.ts 3 PASS, fisheye.glsl против зеркала на CPU на 96x72 через текстуру, кодирующую координаты: 0 из 6912 пикселей не совпали в каждом случае (худшая ошибка 0, 1 и 1 тексель; объявленный допуск 1 тексель не более чем на 1% пикселей, 0 для тождественности). Убитые мутации: знак наклона, неповёрнутое смещение, порядок композиции крепления, защита от неверного кватерниона, число шагов Ньютона, ось главной точки, соотношение сторон пикселя, предел 80°, коэффициент производной; шейдер: один шаг Ньютона, переставленные оси фокуса источника, масштабированный радиус.

### TASK-068 — Analog noise/jelly

- **Status:** DONE — Claude; база 7478d6f; 2026-10-16 (WebGL2 проверен; допуски зависят от бэкенда; вариант для WebGPU не реализован).
- **Title & Description:** Добавить seeded video interference, scanline и rolling-shutter deformation.
- **Dependencies:** TASK-067.
- **Touched Files:** `packages/cameras/src/analog.ts`, `packages/cameras/src/shaders/analog.glsl`, `tests/analog-noise.test.ts`, `tests/browser/analog.spec.ts`, `packages/cameras/src/analog-material.ts`, `packages/cameras/package.json`, `tests/support/analog-harness.ts`.
- **Interfaces / Contracts:** VideoNoiseConfig, throttle-decimated uniform; independent visual RNG.
- **DoD & Acceptance Criteria:** Same seed/time => same frame; amplitude связан с газом только render-path; no CPU pixel loops/frame allocations; golden images tolerances pinned by backend, not cross-GPU pixel equality.
- **Evidence:** Исполнитель Claude; база 7478d6f; 2026-10-16. Node 24.22.0: tests/analog-noise.test.ts 7 PASS: lowbias32 совпадает с независимой реализацией на Python на 5 векторах; seed кадра = hash(seed ^ hash(k)) с эталонными значениями из Python, не зависит от газа, 10000 различных seed кадров; циклы рендеринга 60 Hz и 144 Hz дают одинаковые uniform-переменные по видеокадрам (300 кадров); газ выбирается один раз за видеокадр и отображается в шум/«желе»/частоту вибрации, NaN -> 0, с ограничением; замороженный вход не меняется, и ни один метод не принимает состояние физики; неверные конфигурации отклоняются; 1e6 вызовов updateFrom с одним окном без GC из трёх. Chromium WebGL2 (SwiftShader): tests/browser/analog.spec.ts 5 PASS: при выключенных эффектах источник воспроизводится точно; одинаковые seed и видеокадр дают побайтно одинаковые кадры от разных рендереров, следующий видеокадр или другой seed отличаются; стандартное отклонение шума 2.9 / 17.7 уровня в пределах 20% при газе 0 / 1; вертикальная линия остаётся прямой без вибрации и изгибается на >= 6 px (<= 5 px от центра) на полном газе; строки развёртки не меняют изображение при одной строке на ряд пикселей и дают средние по рядам 73.3 / 118.7 при 24 строках с периодом четыре ряда. Убитые мутации: нет прореживания по кадрам, seed по числу кадров, газ без ограничения, «желе» без зависимости от газа, неинициализированное поле ScalarUniform (тест GC), шум пикселей без зависимости от кадра, без времени экспозиции строки, уменьшенный вдвое шум. Допуски относятся только к этому бэкенду.

### TASK-069 — WorldCover/OSM material map

- **Status:** DONE — Claude; база e67236d; 2026-10-16 (синтетический геопривязанный растр; проверка на реальном тайле требует локально размещённых лицензированных данных и декодирования GeoTIFF).
- **Title & Description:** Загружать лицензированные land classes и map features с provenance.
- **Dependencies:** TASK-036, TASK-060, TASK-061.
- **Touched Files:** `packages/thermal/package.json`, `packages/thermal/src/material-map.ts`, `packages/thermal/src/data-manifest.ts`, `tests/material-map.test.ts`, `tests/fixtures/thermal/material-classes.json`, `tests/fixtures/registry.json`, `package-lock.json`.
- **Interfaces / Contracts:** 10 m raster labels, road/roof overlays; attribution/hash/coordinate system.
- **DoD & Acceptance Criteria:** Known coordinates map correctly; missing data fallback labelled synthetic; raster class не трактуется как temperature; licenses/attribution сохранены без массовой неразрешённой выгрузки.
- **Evidence:** Исполнитель Claude; база e67236d; 2026-10-16. Node 24.22.0: tests/material-map.test.ts 9 PASS. Фикстура легенды tests/fixtures/thermal/material-classes.json (зарегистрирована) покрывает все 11 кодов WorldCover v200; поле temperatureK или emissivity отклоняется. Манифест: правила лицензии/атрибуции поставщиков, обязательный SHA-256 для реальных поставщиков, пометка синтетических данных, система координат, границы и повторяющиеся идентификаторы проверяются; имена тайлов N45E006/S03W060/N00E000/S03W003/N48E009; план 15 км вокруг Цюриха требует 1 тайл, пересечение 48N/9E — 4, план 10x10° отклоняется. Карта на синтетическом растре 12x12 на реальной сетке 1/12000°: все 143 центра пикселей и точки северо-западных углов/краёв дают ожидаемый код; отсутствие данных и точки вне слоёв дают synthetic-ground с synthetic=true; синтетические слои остаются синтетическими; здания поверх дорог поверх поверхности, roof:material=metal -> roof-metal, дорога residential на 2.9 м — асфальт, на 3.2 м — нет, footway игнорируется; образцы не содержат тепловых полей; незарегистрированные слои/слои неверного поставщика, несовпадение границ и неизвестные коды отклоняются; исходный код пакета не содержит сетевого кода. Убитые мутации: округлённый ряд пикселя, игнорирование отсутствия данных, удвоенная ширина дороги, пропуск зданий, потеря флага synthetic, проверка лицензии, ограничение массового плана, усечение имени тайла, учёт атрибуции. Осталось: реальные тайлы WorldCover и выгрузки OSM не загружаются и не коммитятся; декодирование GeoTIFF/OSM и проверка на реальных координатах требуют локально размещённых лицензированных данных.

### TASK-070 — Surface thermal state

- **Status:** TODO.
- **Title & Description:** Интегрировать температуру по solar/material/weather, отдельно от shader.
- **Dependencies:** TASK-032, TASK-069.
- **Touched Files:** `packages/thermal/src/heat-balance.ts`, `packages/thermal/src/solar.ts`, `tests/thermal-energy.test.ts`.
- **Interfaces / Contracts:** C*dT/dt=absorbedSolar-convection-radiation-conduction; emissivity/inertia.
- **DoD & Acceptance Criteria:** Night equilibrium, sunrise/shadow и unit energy balance fixtures; timestep convergence; AO влияет только на заданный radiative model, не заменяет heat solver; параметры инструментально не валидированы без данных.

### TASK-071 — Thermal renderer

- **Status:** TODO.
- **Title & Description:** Преобразовать thermal state в radiance/palette с atmosphere attenuation.
- **Dependencies:** TASK-066, TASK-070.
- **Touched Files:** `packages/thermal/src/thermal-camera.ts`, `packages/thermal/src/shaders/thermal.glsl`, `tests/thermal-camera.test.ts`, `tests/browser/thermal.spec.ts`.
- **Interfaces / Contracts:** InstrumentProfile {resolution, spectralResponse, noise, calibrationSource}; training profile отдельно от CADEX measurements.
- **DoD & Acceptance Criteria:** Blackbody monotonicity, emissivity/reflection и distance attenuation fixtures; cold/hot palette endpoints; no claims of CADEX parity без profile data; native sensor resolution configurable.

### TASK-072 — Shutter/NUC и thermal HUD

- **Status:** TODO.
- **Title & Description:** Добавить deterministic calibration cycle и bounded display interruption.
- **Dependencies:** TASK-071.
- **Touched Files:** `packages/thermal/src/nuc.ts`, `packages/thermal/src/thermal-status.ts`, `tests/thermal-nuc.test.ts`.
- **Interfaces / Contracts:** Shutter states idle/closed/calibrating/open; sensor frame time.
- **DoD & Acceptance Criteria:** Зафиксированная длительность/частота; NUC reset убирает заданный bias; no timestamp rewind; shutter не ставит физику на паузу и не меняет AAR truth.

### TASK-073 — GPU acceptance harness

- **Status:** TODO.
- **Title & Description:** Снять production profiles на M4/RTX 4050 с FPV/thermal/terrain.
- **Dependencies:** TASK-014, TASK-062, TASK-065, TASK-066, TASK-068, TASK-072.
- **Touched Files:** `scripts/bench-render.mjs`, `docs/benchmarks/render-matrix.json`, `docs/validation/gpu-report.schema.json`, `tests/gpu-report.test.ts`.
- **Interfaces / Contracts:** G3 device/browser/resolution/quality/VRAM evidence.
- **DoD & Acceptance Criteria:** По 10 min после 60 s warmup: 60 FPS profile p99<=16.67 ms и 120 FPS profile p99<=8.33 ms; terrain budget соблюдён; headless software GPU не подтверждает hardware gate; missing devices BLOCKED_EXTERNAL.

## Phase 6: UI & Telemetry

### TASK-074 — Pilot HUD и telemetry freshness

- **Status:** TODO.
- **Title & Description:** Показывать attitude/speed/altitude/mode/EKF с источником и возрастом.
- **Dependencies:** TASK-015, TASK-039, TASK-043.
- **Touched Files:** `apps/web/src/hud/PilotHud.tsx`, `apps/web/src/hud/attitude.ts`, `apps/web/src/hud/telemetry.ts`, `tests/hud.test.ts`, `tests/browser/hud.spec.ts`.
- **Interfaces / Contracts:** FlightStateV2, normalized ekf_flags, unknown/stale visual state.
- **DoD & Acceptance Criteria:** NED horizon signs verified; fake valid EKF из demo невозможен; stale AP status подписан; UI updates decimated, не React setState на 1200 Hz.

### TASK-075 — Instructor console/hotkeys

- **Status:** TODO.
- **Title & Description:** Инъецировать weather/fault/model commands с явным pending/applied state.
- **Dependencies:** TASK-010, TASK-038, TASK-058, TASK-074.
- **Touched Files:** `apps/web/src/instructor/Console.tsx`, `apps/web/src/instructor/hotkeys.ts`, `tests/instructor.test.ts`, `tests/browser/instructor.spec.ts`.
- **Interfaces / Contracts:** ControlCommandV2 request/ACK/epoch; scenario fault registry.
- **DoD & Acceptance Criteria:** Hotkeys не срабатывают при вводе в input; cancel/reset/stale epoch и rejection видны; кнопка не показывает applied до ACK; все fault IDs доступны без смены исходников.

### TASK-076 — AAR recorder

- **Status:** TODO.
- **Title & Description:** Записывать input/actuator/truth/sensor/events в отдельный bounded recorder.
- **Dependencies:** TASK-004, TASK-013, TASK-058.
- **Touched Files:** `packages/aar/package.json`, `packages/aar/src/format.ts`, `packages/aar/src/recorder.worker.ts`, `packages/aar/src/storage.ts`, `tests/aar-recorder.test.ts`.
- **Interfaces / Contracts:** AAR version/model hashes/seed/epoch/time domains; IndexedDB chunks/checksum.
- **DoD & Acceptance Criteria:** 30 min configured ring имеет фиксированный byte cap; slow storage/backpressure/loss explicitly counted; zero allocation в physics handoff; запись не использует 256-slot render ring как архив.

### TASK-077 — Replay и timeline

- **Status:** TODO.
- **Title & Description:** Воспроизводить recorded snapshots отдельно от deterministic resimulation.
- **Dependencies:** TASK-015, TASK-076.
- **Touched Files:** `packages/aar/src/replay.ts`, `packages/aar/src/resimulation.ts`, `tests/aar-replay.test.ts`.
- **Interfaces / Contracts:** ReplayMode snapshots/resimulate; seek boundaries, config provenance.
- **DoD & Acceptance Criteria:** Seek/reset/epoch discontinuity корректны; unknown format/hash mismatch rejected; state replay identical records; resim mismatch даёт отчёт, не auto-rewrite recording.

### TASK-078 — AAR response charts

- **Status:** TODO.
- **Title & Description:** Сопоставлять stick input, actuator и физический отклик по одному времени.
- **Dependencies:** TASK-074, TASK-077.
- **Touched Files:** `apps/web/src/aar/Review.tsx`, `apps/web/src/aar/series.ts`, `tests/aar-series.test.ts`, `tests/browser/aar.spec.ts`.
- **Interfaces / Contracts:** Bounded decimated time series; units/timebase, known recording gaps.
- **DoD & Acceptance Criteria:** Known step-response fixture показывает правильный lag; gaps не интерполируются как реальные данные; 30 min log отображается с <=10000 points/series и bounded memory.

### TASK-079 — Lessons/scenario runner

- **Status:** TODO.
- **Title & Description:** Описать сценарии тренировки декларативно и воспроизводимо.
- **Dependencies:** TASK-043, TASK-059, TASK-075, TASK-077.
- **Touched Files:** `packages/scenarios/package.json`, `packages/scenarios/src/schema.ts`, `packages/scenarios/src/runner.ts`, `tests/scenario-runner.test.ts`, `tests/fixtures/scenarios/pilot-basics.json`.
- **Interfaces / Contracts:** Lesson goals/seed/model/firmware/events/rubric/version; no physics code in UI.
- **DoD & Acceptance Criteria:** Malformed/unsupported scenario rejected; same config emits same tick events; outcomes оцениваются по trace/thresholds, не таймеру; paused clock не начисляет sim-time penalty.

### TASK-080 — Доступность и permissions UX

- **Status:** TODO.
- **Title & Description:** Обеспечить keyboard/focus/resize и понятные browser permission failures.
- **Dependencies:** TASK-005, TASK-048, TASK-075, TASK-078.
- **Touched Files:** `apps/web/src/ui/StatusMessage.tsx`, `apps/web/src/style.css`, `tests/browser/accessibility.spec.ts`.
- **Interfaces / Contracts:** Keyboard mapping vs instructor shortcuts, aria states, permission status.
- **DoD & Acceptance Criteria:** Keyboard-only основные действия доступны; focus restore после dialogs; 390px без overflow; permission denied не зацикливает запросы; automated accessibility scan plus manual checklist.

### TASK-081 — Экспорт сессий

- **Status:** TODO.
- **Title & Description:** Экспортировать/импортировать AAR с manifest и без секретов.
- **Dependencies:** TASK-076, TASK-077.
- **Touched Files:** `packages/aar/src/archive.ts`, `apps/web/src/aar/Export.tsx`, `tests/aar-archive.test.ts`.
- **Interfaces / Contracts:** Versioned archive, size/checksum limits; redact keys/serial identifiers as configured.
- **DoD & Acceptance Criteria:** Export→import roundtrip; zip bomb/oversized/invalid hash rejected до allocation; API keys/tokens отсутствуют в archive; пользователь видит размер/типы данных.

### TASK-082 — Сквозной acceptance matrix

- **Status:** TODO.
- **Title & Description:** Запустить поддерживаемые режимы со всеми UI/physics/telemetry gates.
- **Dependencies:** TASK-033, TASK-042, TASK-043, TASK-047, TASK-051, TASK-059, TASK-073, TASK-074, TASK-075, TASK-078, TASK-079, TASK-080, TASK-081.
- **Touched Files:** `tests/integration/system-acceptance.test.ts`, `docs/validation/system-matrix.json`, `scripts/validate-release.mjs`.
- **Interfaces / Contracts:** G0..G4; device/mode/model/firmware/provider coverage.
- **DoD & Acceptance Criteria:** По каждому требованию PASS/FAIL/BLOCKED/NOT_RUN с evidence; 60/120 FPS и 400/800/1200 Hz не выводятся из unit tests; WASM/HITL/Google omissions явно block соответствующий mode.

### TASK-083 — Release provenance и runbook

- **Status:** TODO.
- **Title & Description:** Сформировать проверяемый release bundle и инструкции запуска/восстановления.
- **Dependencies:** TASK-003, TASK-082.
- **Touched Files:** `docs/operations/runbook.md`, `docs/operations/release-manifest.schema.json`, `scripts/release-manifest.mjs`, `tests/release-manifest.test.ts`.
- **Interfaces / Contracts:** Source/artifact/dataset/toolchain hashes, licences, supported capability matrix.
- **DoD & Acceptance Criteria:** Clean-machine build/install/start проверены; rollback и process cleanup описаны; отчёт содержит реальные blocked gates; никаких deploy/push автоматически без разрешённого scope.


## Проверенный пакет транспорта и отказов (2026-10-16)

Ответственный Codex; база dfbf402. TASK-037/038/039/040/048/052/053/056/057/060
имеют DONE в своей программной/модульной области. Прежние TASK-029/030/031/033
остаются открыты. Физическая аппаратура/FC, измеренные модели, целевые GPU,
живые Google tiles и полный полёт SITL/HITL этим пакетом не сертифицированы.

Код 0: frozen npm ci, lint, typecheck, build, check:docs; 266 юнит-тестов
в 48 файлах, 21 браузерный тест Chromium, 46 нативных Rust-тестов и старт CLI
моста. Актуальные test-results/unit/junit.xml и test-results/browser/junit.xml
не содержат провалов/ошибок/пропусков. Браузер проверяет настоящие Worker/SAB/
MAVLink I/O Worker с моками Gamepad/Serial. Rust — 1.97.0. Production build
сохраняет прежнее предупреждение chunk >500 kB.

G1 node scripts/bench-links-ew.mjs all 400 / 800 / 1200 проходит на каждой частоте:
4e6 прогрева, шесть окон N=1e6/2e6, ноль GC и добавочных B/step; выделяющие
контроли обнаружены. SHA-256 текущих исходников/скрипта совпадает с тремя
отчётами test-results/bench/links-ew-all-<Hz>.json. Граф чередует четыре wire-типа
MAVLink, декодирует actuators, преобразует RC, пересекает переполнение слова
времени, меняет воздействие РЭБ и момент мотора. Аллокации I/O и real-time
бюджеты браузера/аппаратуры проверяются отдельно. Node 24.19.0, Chromium
154.0.8037.57, Debian x86_64/software GPU. SHA-256 lockfile
c391c7bc92bece5b5a23aea3733e58ed9edcd8e0bce873a54f6bddc8f42e7a5b.

MAVLink source 2e2b6af99084e4fde9bb304c84bb9253a1a98b6f, pymavlink 2.4.50;
официальные кадры/пороги не регенерировались из вывода симулятора. Синхронизированы
десять полных пар EN/RU; новые руководства физического радио и политики рельефа
имеют зеркала. Инструкции старта среды сохранены как черновик для проверки/
сохранения/публикации в настройках; это не применило сетевое исключение SDK
и не сертифицировало новую задачу.
