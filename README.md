# MirageSITL

Первый этап веб-симулятора БПЛА: React 19 / Three.js, изолированный физический
Worker с фиксированным шагом 400 Гц, SharedArrayBuffer и USB Gamepad.

Реализованы 3D-сцена, запуск/пауза/сброс, коллективный газ, калибровка USB-осей,
arm при нулевом газе, failsafe ввода и диагностика пропущенного времени.

JSBSim/BET WASM, ArduPilot SITL/HITL, EW, terrain/FPV/thermal и AAR — следующие
этапы. Текущая модель упрощена и не валидирована для подготовки пилотов.

## Запуск

Node.js **22.12+** или **24 LTS**, npm 10+, современный Chrome/Edge на macOS/Windows.

```bash
cd /workspace/MirageSITL  # либо каталог вашего клона
npm ci
npm run dev
```

Локальный Vite-сервер использует порт 5173. Для SharedArrayBuffer нужны
secure context (HTTPS или localhost), COOP и COEP. Удалённый HTTP по IP не
подходит. Vite выставляет заголовки dev/preview; production-сервер должен
также возвращать:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Демо: **Запустить → Включить двигатели → поднять газ выше 50%**.
Пауза отключает двигатели; перед повторным arm верните газ к нулю. Сброс
останавливает симуляцию. Скрытие вкладки ставит полёт на паузу.

USB: включите joystick mode в EdgeTX/OpenTX, выберите USB-ввод и сдвиньте
стик для обнаружения браузером. Выберите устройство, проверьте индексы и
направления осей при выключенных двигателях. Default 0/1/3/2 не универсален;
таблица калибровки меняет ось, min, центр, max и инверсию. Калибровка действует
до перезагрузки. При отсутствии пульта доступен демо-ввод. Команды реальному
полётному контроллеру этот прототип не отправляет.

## Проверки

```bash
npm test
npm run build
npx playwright install chromium  # один раз, если браузера ещё нет
npm run test:browser
```

В облаке с системным Chromium:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

Если домашний npm cache недоступен, добавьте к npm ci аргумент
`--cache /workspace/.cache/mirage-npm`.
Production smoke: после сборки `npm run preview -w @mirage/web`; проверить
cross-origin isolation, ready, движение после arm и остановку на pause.

400 Гц — фиксированный интеграционный шаг, а не hard real-time гарантия
браузера. Catch-up ограничен 8 шагами, потери времени видны в UI. 60–120 FPS
и бюджеты на M4/RTX 4050 требуют отдельных измерений на целевых устройствах.
Облачный headless smoke не подтверждает эти показатели.

## Архитектура

* [Компоненты, границы интеграций и этапы](docs/architecture.md)
* [Бинарный ABI общей памяти и сообщения Main ↔ Worker](docs/shared-memory.md)

Используйте текущий checkout: облачная задача изолирована, дополнительный
Git worktree для запуска не нужен.
