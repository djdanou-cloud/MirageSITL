# CLAUDE.md — MirageSITL agent instructions

<!-- source-sha256: 0d1122e52687ca2b4a2ba392f0d687e4cadcf8eb56b07e087ad93b5f352e5d77 -->

Английский источник: [Source of truth](../../CLAUDE.md). Изменения спецификации обновляют оба языка в одной задаче.


Это русское зеркало. Источник правил — [корневой английский CLAUDE.md](../../CLAUDE.md).

## 0. Обязательный язык репозитория и синхронизация

Весь исходный код, типы TypeScript, имена переменных/функций, комментарии,
сообщения UI/логов/ошибок, тесты, пояснения в fixtures, коммиты, заголовки и
описания PR, первичная документация **обязаны быть на английском языке**.
Математические символы, единицы, непрозрачные внешние идентификаторы и
фактический пользовательский ввод не считаются переводимым текстом.
Статический русский текст в runtime запрещён.

Русская проза находится только в `docs/ru/`. Все системные спецификации,
roadmap, архитектурные руководства, README и эти инструкции имеют русские
зеркала. Английские источники находятся в корне или `docs/`; зеркала
сохраняют имя файла внутри `docs/ru/`. Не заводить второй русский источник
в корне или другой части `docs/`.

Протокол синхронизации документации:

1. Сначала изменить английский источник и найти пару в
   `docs/documentation-index.json`. Новое руководство/spec требует новой пары.
2. В той же задаче/изменении обновить **полное** русское зеркало: интерфейсы,
   формулы, таблицы байтов, TASK IDs/dependencies, DoD, команды и статус
   реализации. Краткое резюме не заменяет перевод.
3. Fenced code/JSON/shell listings и display equations должны быть идентичны
   в обеих версиях. Комментарии кода в русском зеркале остаются английскими.
   Проза и пояснения таблиц переводятся без изменения технических значений.
4. Ссылки относительны фактическому каталогу. README соответствует
   `docs/ru/README.md`, корневой CLAUDE — `docs/ru/CLAUDE.md`, английский
   `docs/<FILE>.md` — `docs/ru/<FILE>.md`.
5. Проверить смысловое соответствие и только затем обновить `source-sha256`
   зеркала SHA-256 полного английского файла. Нельзя просто менять hash,
   чтобы скрыть провал проверки: он обнаруживает устаревание, не качество перевода.
6. Запустить `npm run check:docs`, записать синхронизацию в evidence задачи.
   Задача, изменяющая архитектуру/spec, не DONE при отсутствующем/устаревшем
   зеркале. Последующие изменения снова обновляют оба языка.

Перед **каждой итерацией** прочитать этот файл, выбранный TASK в
[PROJECT_ROADMAP.md](PROJECT_ROADMAP.md), затронутый contract в
[SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md) и/или
[SPECS_SIMULATION_ENGINES.md](SPECS_SIMULATION_ENGINES.md), затем текущий код.
Пользовательские инструкции и ограничения среды имеют приоритет.

Claude Code использует этот корневой файл по своему механизму загрузки.
Codex/Cursor не следует считать автоматически читающими CLAUDE.md.
TASK-084 добавил AGENTS.md и `.cursor/rules/project.mdc` как тонкие указатели
на этот файл, не дублирующие правила; если клиент не загружает ни один из
указателей, агент обязан открыть этот файл явно.

## 1. Реальный baseline и границы

На `e3bb6b4`: npm workspaces; `apps/web`; `packages/protocol`, `physics`,
`input`; SAB **v1**, 400 Гц fixed integration dt, demo dynamics, Gamepad,
React 19/R3F/WebGL. 13 unit и 4 browser tests были проверены при реализации.
Не считать этот исторический результат проверкой новых изменений.

Rust workspace, JSBSim/BET, v2, MAVLink, ArduPilot, HITL, EW, terrain,
thermal и AAR пока отсутствуют. Не писать «cargo check passed», «EKF ready»
или «1200 Гц поддерживается», пока соответствующий модуль не реализован
и проверка не выполнена. Целевой v2 не является описанием текущего v1.

Работать в существующем checkout (`/workspace/MirageSITL` в cloud).
Облачная задача уже изолирована; дополнительный worktree создавать только
по явному запросу пользователя. Сначала `git status --short`, сохранить
чужие изменения. Не делать reset/clean, не перезаписывать user files.
Коммит/push/deploy выполнять только в явно разрешённом пользователем scope;
новая задача не означает автоматическую публикацию результата.

## 2. Команды: доступные сейчас и запланированные

Из корня репозитория, Node 24 LTS (`.nvmrc`), npm lock обязателен:

```bash
npm ci
npm run dev
npm run build
npm test
npm run check:docs
npm run lint
npm run typecheck
npx --no-install vitest run tests/protocol.test.ts
npx --no-install tsc --noEmit
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

TASK-002 реализован: `npm run lint` включает typed правила TypeScript и
recommended JavaScript rules для tooling; `npm run typecheck` запускает strict tsc.
TASK-003 добавляет независимые GitHub Actions unit/browser/build jobs для PR
и push в main. JUnit unit, JUnit/HTML/traces браузера и build output/logs
сохраняются после ошибок. Hosted execution проверяется отдельно от локальных jobs.

`npm run build` уже выполняет `tsc --noEmit` и Vite build. `npm test` =
`vitest run`; focused test выбирается существующим точным путём.
Для своего Playwright browser убрать CHROMIUM_PATH; установку Chromium
делать отдельно `npx playwright install chromium`, если требуется.
В cloud при недоступном домашнем cache:
`npm ci --cache /workspace/.cache/mirage-npm --no-audit --no-fund`.
Не менять HOME и не отключать TLS/signature/checksum verification.

Команды **ещё отсутствуют**; внедряются указанной задачей и только после
этого становятся обязательными для её зависимых задач:

| Команда | Появится | Назначение |
| --- | --- | --- |
| `cargo check --manifest-path native/Cargo.toml --workspace --locked` | TASK-016 | native Rust compile |
| `cargo test --manifest-path native/Cargo.toml --workspace --locked` | TASK-016 | scalar reference tests |
| `cargo check --manifest-path native/Cargo.toml -p mirage-bet --target wasm32-unknown-unknown --locked` | TASK-016 | WASM target compile; crate name закрепить как mirage-bet |
| `node scripts/build-wasm.mjs` | TASK-017 | scalar/SIMD artifacts + manifests |
| `node scripts/bench-physics.mjs` | TASK-014 | machine-readable step/allocation report |
| `node scripts/build-jsbsim.mjs` | TASK-030 | pinned Emscripten build |
| `node scripts/run-sitl.mjs` | TASK-042 | pinned native ArduPilot harness |

Cargo check не проверяет физику и не доказывает browser execution; нужны
native tests, WASM smoke и reference parity. Если Rust target отсутствует,
установить поддерживаемым toolchain способом, не объявлять тест skipped
как passed. Команды в Tests/DoD будущих задач — требования, а не отчёт.

Dev/preview обязаны возвращать COOP `same-origin` и COEP `require-corp`.
Внешние WASM/tiles/textures должны удовлетворять CORS/CORP. Не отключать
isolation ради загрузки ресурса. Production hosting задаёт headers отдельно.

## 3. Как брать TASK-XXX

1. Прочитать task целиком: Dependencies, Touched Files, Interfaces, DoD.
   Проверить evidence зависимостей по коду/тестам, а не только статус DONE.
   Не начинать downstream implementation поверх отсутствующего контракта.
2. Зафиксировать IN_PROGRESS: owner, baseline SHA, цель, критерий отказа.
   Если требуется дополнительный файл/изменение интерфейса — сначала
   обновить task/contract и описать причину; не расширять scope молча.
3. Найти существующие test runners, fixtures и patterns. Добавить focused
   failing test, который воспроизводит требуемое поведение/неисправность.
   Ошибка отсутствующего import не является достаточным тестом физики:
   после появления модуля assertion должен проверять независимый oracle.
4. Реализовать минимальный capability increment. Избегать scaffold, который
   выдаёт success без работы. Contract changes сопровождаются byte fixtures,
   version bump и migration/rejection tests.
5. Запустить focused test → typecheck/lint → затронутые regression tests →
   build/browser/native/integration по DoD. Для docs-only вместо app suites
   проверить task refs/DAG/links/layout/listings; не добавлять бессмысленные
   runtime tests только ради изменения документации.
6. Для hot path пройти G1, для numeric/codec G2, для performance G3, для
   hardware/provider G4 из roadmap. Настоящее оборудование/credentials
   нельзя заменять mocks и объявлять соответствующий gate завершённым.
7. Сохранить evidence: exact commands/exit codes/counts/report paths,
   seed/units/toolchain/model/firmware/source hashes, hardware/browser при
   измерениях. В tests не хранить секреты или огромные внешние datasets.
8. DONE только после всех локальных и общих критериев. При blocked gate
   записать BLOCKED_EXTERNAL/BLOCKED_DECISION с конкретным недостающим
   входом и результатами независимой работы. Не снижать threshold, не
   отключать assertion и не переписывать golden по своему output.
9. `git diff --check`, проверить diff/untracked files и отсутствие outputs/
   node_modules/keys в staging. В отчёте: что изменено, что реально
   проверено и какие возможности ещё отсутствуют. Следующий TASK брать
   только в пределах разрешённого объёма работ, не исполнять весь backlog
   автоматически по просьбе изменить один документ.

Пример evidence записи (шаблон, **не выполненный результат**):

```text
TASK-020: IN_PROGRESS
Baseline: <sha>; Owner: <agent>
Contract: docs/SPECS_SIMULATION_ENGINES.md sections 2–3
Tests: cargo test ... --test blade; exit=<code>; executed=<N>
Oracle: <fixture id and source hash>; tolerance=<absolute/relative>
Artifacts: <report path>; hardware=<device or not required>
Documentation: <English path> + <Russian path>; check:docs=<result>
Remaining: <none or exact external blocker>
```

## 4. TypeScript, API и кодстайл

* `strict`, `noUncheckedIndexedAccess`; **запрещён any**, включая type assertions,
  unsafe inferred any из dynamic imports/JSON и отключение lint для обхода.
  Внешнее значение — `unknown`; после schema/type guard становится domain
  type. TASK-002 включает typed linting на ESLint 10/typescript-eslint; команда lint отключает inline suppression.
* `as unknown as T`, non-null assertions и array index `!` допустимы только
  для доказанного инварианта платформы/buffer bounds с test и объяснением;
  не использовать как замену проверки внешнего payload.
* Discriminated unions для lifecycle/faults; exhaustive switch с `never`.
  Неизвестные network/control messages отклоняются. TypeScript types сами
  по себе не валидируют runtime bytes.
* Единицы в именах (`M`, `Mps`, `RadS`, `Pa`, `Gauss`, `Us`), finite values,
  documented coordinate frames. Degrees только на boundary wire/UI.
  Указывать scalar order quaternion; normalized output, q и -q эквивалентны.
* Ясные именованные функции/модули, без minification исходников. React
  компоненты не содержат аэродинамику. Numeric constants документированы
  source/envelope, magic correction factors без provenance запрещены.
* Frozen install/lockfile; dependency changes только по необходимости TASK,
  вместе с manifest/lock/reproducibility tests. Не заглушать build warnings
  поднятием threshold вместо анализа влияния на требование.

## 5. Zero-allocation physics loop

Hot path — интеграция, датчики, EW, actuator mapping, SAB packing и callbacks,
которые они вызывают на каждом из 400–1200 шагов/с. После initialize/reset:

* Не создавать object/array/tuple, typed views, closures, строки, Error,
  Promise, BigInt values, iterator/generator или временный Three Vector.
  Не использовать spread/rest, map/filter/flatMap, JSON, console, fetch,
  postMessage и React setState внутри step.
* Выделять arenas, scratch, outputs и RNG states один раз. Численные loops
  по индексам; методы `stepInto(input,out)` мутируют заранее выделенный out.
  Число роторов/элементов/volumes/queued commands ограничено контрактом.
* Изменения config валидировать/загружать вне step; применять scalars/IDs
  на границе tick из preallocated slots. ACK/events писать в bounded outbox;
  object messages создаются/отправляются после compute batch, не в step.
* В Rust не вызывать Vec push с realloc, collect, Box, format!, allocator
  или panic в обычном step. Bounds/error flags вместо traps. В C++ не
  вызывать new/malloc/string growth в шаге. No `memory.grow` после arm.
* Измерять allocator calls/bytes в native/WASM и явные аллокации JS с
  инструментированием. Постоянный heap size сам по себе не доказывает 0
  allocations (alloc/free может сохранять размер). Показать warmup,
  profiler overhead и исключённые host/timer операции отдельно.
* Отдельный worker уменьшает связь с Main GC, но не даёт hard real-time.
  Fixed dt не изменяется из-за render FPS. При overload следовать clock
  policy, показывать dropped intervals; Main никогда не делает Atomics.wait.

## 6. WASM/SIMD и численная дисциплина

Scalar reference обязателен. SIMD128 выбирается capability detection;
никакого требования SIMD для запуска baseline. Начать с обычного SIMD,
не relaxed-simd/fast-math; floating reduction order и tail lanes явные.
`unsafe` только в узком проверенном ABI/SIMD участке с invariants/tests.

Физика/геодезия по умолчанию float64; renderer получает локальные float32.
WASM ABI — fixed repr(C), explicit strides, checked pointers/counts/alignment,
никаких Rust references/Vec/enum ABI assumptions на JS boundary. Views не
могут переживать замену memory buffer; во время step buffer не меняется.

Numerical tolerances берутся из spec/fixture **до** реализации. Bit-identical
parity между CPU/GPU/native/WASM не обещается; одинаковый seed и runtime
должны воспроизводить sensor/EW сценарий. Для SIMD проверить tail counts
1/3/5/63 и scalar fallback. Если parity расходится, исправить вычисление/
определить допустимый numerical budget, не применять random epsilon.

## 7. Межпоточные и внешние контуры

* Один writer на SAB область; state/pilot — atomic int32 seqlock; sensors/
  actuators — SPSC с отдельными owners. Прямой shared Float64Array доступ
  запрещён; decode output только после успешной проверки seq/head.
* Epoch/model discontinuity разрывает interpolation/replay history. Нельзя
  добавлять новые поля в reserved v1 без миграции ABI. Проверять byte
  offsets и golden records, не только размер TS interface.
* ArduPilot JSON physics transport и MAVLink RC/telemetry — разные каналы.
  RC override sentinel semantics зависят от группы каналов. Serial/WS
  parser проверяет CRC/IDs/schema/bounds; потоковые chunks не равны frames.
* Web Serial permission запрашивать по gesture. Fast-forward EKF только
  SITL, не physical HITL. 30 s timer не доказывает EKF health. Статус EKF
  показывать только из autopilot с freshness, не выводить из truth.
* EW искажает observations, не truth. `motor-loss` отдельно воздействует
  на physics actuator path. Никаких заявлений об обходе EKF gates или
  гарантированном mode change без pinned integration scenario evidence.
* AAR использует отдельный recorder с gaps/provenance, не render ring.
  Несколько consumers не читают одну SPSC queue; fan-out копирует frames
  в отдельную bounded recording queue на producer/IO boundary.

## 8. Данные, renderer и измерения

Google live tiles — attribution/CORS/COEP/provider policy; постоянный R2
cache/prefetch без разрешения не включать. Собственные/лицензированные
datasets используют отдельный разрешённый cache policy. API keys и реальные
секреты не писать в client bundle, репозиторий, логи, fixtures или chat.

WorldCover/OSM классы не температура; AO не heat solver. Thermal profile
CADEX не объявлять достоверным без данных прибора. Все synthetic effects
помечать в model/instrument manifest. Shader pipeline не меняет truth.

FPS/Hz evidence должно включать device/browser/OS/quality/resolution,
warmup/duration, p50/p95/p99, compute duration отдельно от wall lateness,
executed step rate и drops. Ни unit test fake clock, ни software GPU
в cloud не подтверждают 120 FPS на M4/RTX. Если требуемая платформа
недоступна, сохранить functional results и оставить hardware gate открытым.

## 9. Документы как исполняемый контракт

Сохранять TASK IDs стабильными, dependency graph ацикличным, ссылки/пути
валидными. Новые задачи получают свободный ID, старые не перенумеровываются.
При изменении ABI/units/clock policy менять source/spec/fixtures вместе.
Не ставить DONE только за сгенерированный интерфейс или документ.

`npm run check:docs` проверяет зарегистрированные пары, разделение языков,
source hashes, одинаковые fenced contracts/equations, зависимости задач и
покрытие layout. Семантическое качество перевода агент проверяет отдельно.
В текущей миграции UI и тестовые selectors переведены на английский, добавлен
documentation check; будущие Rust/physics/autopilot модули не установлены.
Перед следующим кодовым TASK проверить package.json/HEAD; baseline обновлять
по фактической реализации, не по намерениям.
