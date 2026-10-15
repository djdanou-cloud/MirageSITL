# MirageSITL

<!-- source-sha256: dd586057f1203ce04f11077aea74e91817025bdc8eb570af00c5a3dc2470d756 -->

Английский источник: [Source of truth](../../README.md). Изменения спецификации обновляют оба языка в одной задаче.


Браузерный проект симуляции БПЛА и подготовки пилотов, начинающийся с
изолированного физического цикла и работающей полётной лаборатории.

Английский язык — источник истины репозитория. Код, UI, комментарии,
тесты, логи, коммиты и первичная документация — на английском. Системная
документация поддерживается на двух языках в одном изменении.

## Текущая реализация

Milestone 01 включает React 19, React Three Fiber/Three.js, Vite, Tailwind CSS
и Lucide UI; отдельный модульный Worker; фиксированное интегрирование 400 Гц;
атомарный SharedArrayBuffer transport; USB Gamepad и калибровку осей;
упрощённую демонстрационную модель квадрокоптера. В интерфейсе есть 3D-сцена,
телеметрия, коллективный газ, arm/disarm, pause/reset, failsafe ввода и
счётчики пропущенных временных интервалов.

Текущий бинарный ABI — **v1**. Спецификации отдельно задают **целевой v2**:
EKF/EW status, epochs сессий и sensor/actuator queues. Константы layout и codecs v2
существуют (TASK-008), но работающее приложение по-прежнему использует v1.

JSBSim/BET WASM, ArduPilot SITL/HITL, РЭБ, фотореалистичный terrain,
FPV/thermal и AAR запланированы. Текущая аэродинамика упрощена и не
валидирована для подготовки пилотов.

Основа Phase 0 добавляет детерминированные seeded streams, проверяемые по SHA-256
манифесты синтетических fixtures и строгую проверку моделей/frame/inertia/rotors.
Модели допускаются в неизменяемый реестр сессии; переключение модели runtime
остаётся будущей задачей. Контракты сериализации описаны в руководстве архитектуры.

При запуске проверяются secure context, isolation, SharedArrayBuffer, Worker и
WebGL2. Без обязательных возможностей Start отключён с объяснением; без Gamepad
отключён USB. Ошибка WebGPU probe сохраняет WebGL2. Доступность Serial API
показывается отдельно: HITL и WebGPU rendering ещё не реализованы.

## Быстрый запуск

Node.js **22.13+** или **24 LTS** (`.nvmrc` выбирает 24), npm 10+ и современный
Chrome/Edge на macOS/Windows. Будущий HITL Web Serial нацелен на Chromium.
Облачная задача использует текущий изолированный checkout; новый Git worktree
создаётся только по явному запросу.

```bash
cd /workspace/MirageSITL
npm ci
npm run dev
```

Для локального клона укажите фактический каталог. Dev-сервер использует
порт 5173. Для SharedArrayBuffer нужен secure context: HTTPS или localhost.
Удалённый HTTP по IP не подходит. Vite dev/preview выставляют заголовки;
production hosting настраивает их отдельно:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Если cloud home cache недоступен для записи, добавьте
`--cache /workspace/.cache/mirage-npm` к `npm ci`.

### Демонстрационный полёт

Выберите **Start → Arm motors → поднимите Demo throttle выше 50%**.
Spool response намеренно имеет задержку. Pause отключает двигатели;
верните газ к нулю перед повторным arm. Reset останавливает модель и
возвращает её на землю. Скрытие вкладки ставит сеанс на паузу.

В EdgeTX/OpenTX выберите USB joystick mode, вкладку USB и сдвиньте стик
для обнаружения браузером. Выберите устройство и проверьте направления
при выключенных двигателях. Начальный mapping 0/1/3/2 не универсален.
Таблица задаёт ось, min, center, max и inversion. Калибровка действует до
перезагрузки страницы. Demo работает без аппаратуры. Этот этап не
отправляет команд реальному полётному контроллеру.

## Краткая архитектура

```text
Main Thread: Gamepad/calibration -> SAB pilot mailbox
Physics Worker: fixed-step demo -> SAB state ring
Main Thread: coherent snapshots -> interpolation -> R3F/HUD
```

```text
apps/web/             React UI, R3F view, Worker, runtime coordination
packages/protocol/    ABI v1 and atomic readers/writers
packages/physics/     Demo dynamics and bounded scheduler
packages/input/       Gamepad adapter and calibration
packages/test-support/ Fixture integrity/provenance and deterministic PRNG
tests/                Unit and real-browser functional checks
docs/                 English specifications, roadmap, architecture
docs/ru/              Russian mirrors of system documentation
```

Physics владеет truth и временем симуляции. Main — UI/вводом/рендером.
High-rate данные передаются через SAB, lifecycle/errors — postMessage.
Render ring хранит короткую историю интерполяции, а не AAR archive.
Будущие backends/adapters описаны в спецификациях, а не представлены
пустыми неработающими сервисами.

## Проверка

```bash
npm run check:docs
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Playwright Chromium устанавливается один раз, только если отсутствует.
Подготовленная cloud-среда может использовать системный браузер:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

Unit tests проверяют ABI, scheduler, demo dynamics, координаты и калибровку.
Browser tests используют настоящий Worker/SAB, взлёт, pause/reset,
имитацию подключения/отключения USB и mobile layout. Mock USB не
валидирует реальный пульт или Pixhawk.

После сборки `npm run preview -w @mirage/web` запускает production bundle
на порту 4173. Проверьте isolation, Worker READY, движение после arm и
неизменные ticks при pause. Отдельные lint/typecheck команды доступны; Rust/Cargo пока остаётся будущей
задачей. GitHub Actions запускает независимые unit/browser/build jobs для PR
и push в main. JUnit unit, JUnit/HTML и failure traces браузера, build logs
и artifacts сохраняются даже после ошибок. Автоматические tooling checks
проверяют unsafe-type fixtures и ненулевой exit status обоих runners при
отсутствии найденных тестов.

400 Гц — фиксированный **интеграционный шаг**, не hard real-time гарантия
браузера. Catch-up ограничен 8 шагами, потери wall time видны в UI.
Целевые 60–120 FPS и 400–1200 Гц требуют production-измерений на Apple
Silicon M4 и RTX 4050; cloud headless smoke их не подтверждает.

## Системная документация

| Английский источник | Русское зеркало |
| --- | --- |
| [README](../../README.md) | [README](README.md) |
| [Roadmap](../PROJECT_ROADMAP.md) | [Roadmap](PROJECT_ROADMAP.md) |
| [Shared memory](../SPECS_SHARED_MEMORY.md) | [Shared memory](SPECS_SHARED_MEMORY.md) |
| [Simulation engines](../SPECS_SIMULATION_ENGINES.md) | [Simulation engines](SPECS_SIMULATION_ENGINES.md) |
| [Архитектура](../architecture.md) | [Архитектура](architecture.md) |
| [Реализованный ABI v1](../shared-memory.md) | [Реализованный ABI v1](shared-memory.md) |
| [Правила агента](../../CLAUDE.md) | [Правила агента](CLAUDE.md) |

Изменяя английскую спецификацию/guide, обновляйте русское зеркало в той
же задаче и запускайте `npm run check:docs`. Полный workflow, правила
zero-allocation/deterministic math и evidence для DONE заданы в CLAUDE.md.
