# Руководство локальной проверки и выпуска

## Настройка географических данных

Текущее покрытие классификации поверхности ESA WorldCover 2021 v200 ограничено
исключительно Израилем. В [руководстве WorldCover и ручной загрузки регионов](worldcover-data.md)
описаны публичный глобальный источник S3, требования AWS CLI, команды
PowerShell/zsh и проверки перед расширением поддерживаемого покрытия.

## Локальные проверки
<!-- source-sha256: 72fc122fb2454a9a0acbe15e91558240007bc97284f0484e86b3696851fe81c4 -->

Использовать существующий изолированный checkout, сохраняя локальные изменения. Node закреплён .nvmrc; Rust 1.97.0 и wasm32-unknown-unknown — native/rust-toolchain.toml. Зависимости ставить через npm ci. В облаке активировать CARGO_HOME=/workspace/.cache/mirage-cargo, RUSTUP_HOME=/workspace/.cache/mirage-rustup и добавить CARGO_HOME/bin в начало PATH; не переопределять HOME. Запустить lint, typecheck, check:docs, CI=true npm test, npm run build и locked native tests. Запустить npm run dev; проверить HTTP, COOP same-origin, COEP require-corp и настоящий Worker READY. Начать с нулевого газа, армировать, летать, приостановить и сбросить. Браузерные тесты используют системный Chromium только при наличии. Установка/запуск на чистой восстановленной машине для сертификации выпуска ещё не выполнялись.

Все новые команды свидетельств локальные. Без трассы они пишут BLOCKED_EXTERNAL и возвращают 2; некорректные данные дают 1. Они не развёртывают, не создают теги и не выполняют push. Изучать причины отчёта и сохранять исходные захваты с точными хешами байтов. Трассы ограничены 32 MiB. Анализаторы CLI записывают sourceRevision и validatorSha256; сохранять inputSha256 и совпадающую идентичность кода/отчёта. После изменений соответствующего кода/настроек повторять проверку.

```bash
node scripts/run-sitl.mjs
node scripts/probe-ardupilot-wasm.mjs
node scripts/bench-hitl.mjs --input /path/to/hitl-trace.json --sha256 <SHA256>
node scripts/report-ekf.mjs --input /path/to/ew-trace.json --sha256 <SHA256>
node scripts/bench-render.mjs --input /path/to/gpu-trace.json --sha256 <SHA256>
node scripts/validate-release.mjs --input /path/to/system-evidence.json --sha256 <SHA256>
node scripts/release-manifest.mjs --input /path/to/release-input.json --sha256 <SHA256>
node scripts/bench-terrain-scenarios.mjs 400
```

SITL требует MIRAGE_SITL_SOURCE на закреплённом чистом коммите, MIRAGE_SITL_BINARY с MIRAGE_SITL_BINARY_SHA256 и MIRAGE_SITL_DRIVER с MIRAGE_SITL_DRIVER_SHA256. Секреты не нужны. Node-драйвер (`scripts/sitl/driver.mjs`) получает --binary и --parameters, владеет жизненным циклом прошивки/моста и выдаёт только JSON-трассу после очистки. Он запускает JSON-backend, управляет RC/командами и пишет исходную диагностику автопилота; он отделён от демо. Проверки ELF/исходников отклоняют отсутствующие/поддельные входы; хеши устанавливают заявленную идентичность, но не воспроизводимость локального бинарника. Отдельно сохранять логи сборки/инструментария. Родитель создаёт закрытый рабочий каталог, ограничивает stdout/stderr 16 MiB, задаёт 120 с и при отказе завершает свою POSIX-группу процессов. Для потомков Windows нужен проверенный драйвер/job-object; глобальные команды kill запрещены. Общие кеши исходников/сборки при очистке не удалять.

Вход выпуска содержит schemaVersion=1, artifacts [{path,sha256,license}], systemReportPath и systemReportSha256. Инвентарь ограничен 4096 файлами, 64 MiB/файл и 512 MiB суммарно из apps/web/dist, packages/wasm-bet/dist или test-results/validation. Выход за пути, symlink-побег, повторы, отсутствие лицензий и несовпадения хешей отклоняются. Вывод фиксирует фактические размеры/хеши, ревизию/dirty, npm lock, хеш реестра данных и версию Node. Полная проверка лицензий зависимостей, реальных версий компиляторов и чистой машины/исходных G0–G4-свидетельств остаётся обязательной: создание инвентаря намеренно сохраняет BLOCKED_EXTERNAL даже при предоставленной зелёной сводке. Публикацию оно не разрешает.

Для отката восстанавливать явно выбранный известный выпуск отдельным процессом развёртывания; не делать reset/clean рабочего checkout. Останавливать только процессы/группы текущего запуска, закрывать Serial через интерфейс и завершать Worker этой сессии. При провале сохранять диагностику. Ключи развёртывания, автоматический откат и аппаратная приёмка не предполагаются.

Чеклист доступности: Tab достигает skip-link и основных действий; Enter активирует фокус; фокус видим; ввод в текстовые/select-контролы подавляет инструкторские горячие клавиши; при 390px нет горизонтального переполнения; отказ Serial объявляется один раз, фокус возвращается без повторных запросов; импорт AAR сохраняет живой полёт. Автоматические axe/браузерные проверки покрывают эти программные пути. Физические передатчик/FC, сеанс экранного диктора и живой интерфейс автопилота остаются отдельными незапущенными проверками.

## Нативный полёт SITL (TASK-042)

Запускать весь harness на Linux или внутри WSL Ubuntu. Нужны Node 24,
виртуальная среда с pymavlink 2.4.50, чистые исходники на коммите из
`scripts/sitl.lock.json`, их нативный ArduCopter ELF и scalar WASM тела из
`node scripts/build-wasm.mjs`. Существующие исходники/сборки допустимы после
проверки идентичности; сохранять логи сборки/версии компилятора. Для этой
интеграции синтетического аппарата не нужны физический FC, внешний полётный
лог, облачные credentials или измеренная поляра. `scripts/sitl/driver.mjs` —
эталонный замкнутый драйвер; он отделён от демо.

Задать пути ниже в Linux shell. Это локальные пути, а не секреты. Каталог
захвата должен быть новым. Параметры сохраняют ARMING_CHECK=1 и включённый
EKF3. Не отключать проверки и не менять закреплённые допуски полёта.

```bash
export MIRAGE_SITL_SOURCE=/path/to/pinned/ardupilot
export MIRAGE_SITL_BINARY=/path/to/native/arducopter
export MIRAGE_SITL_PYTHON=/path/to/venv/bin/python
export MIRAGE_SITL_DRIVER="$PWD/scripts/sitl/driver.mjs"
export MIRAGE_SITL_BINARY_SHA256=$(sha256sum "$MIRAGE_SITL_BINARY" | cut -d ' ' -f 1)
export MIRAGE_SITL_DRIVER_SHA256=$(sha256sum "$MIRAGE_SITL_DRIVER" | cut -d ' ' -f 1)
export MIRAGE_SITL_CAPTURE_DIR="$PWD/.cache/task-042/capture-new"
node scripts/run-sitl.mjs
"$MIRAGE_SITL_PYTHON" scripts/sitl/check-raw.py --input "$MIRAGE_SITL_CAPTURE_DIR"
node scripts/check-sitl-capture.mjs --input "$MIRAGE_SITL_CAPTURE_DIR"
```

`run-sitl` запускает firmware/драйвер и возвращает 0 только после полного
полёта; без prerequisites возвращает 2. `check-sitl-capture` независимо
проверяет сохранённую v2-трассу по полночастотной физике и исходной
декодированной телеметрии, неизменные хеши исходников, счётчики кадров,
частоты/PWM и пишет `test-results/validation/task-042-flight.json`.
Сначала `check-raw.py` независимо декодирует и проверяет CRC сырого MAVLink,
требуя совпадения каждого сохранённого наблюдения с упорядоченным префиксом
потока. Firmware при аудите повторно не запускается. Сохранять сырой MAVLink, физику,
декодированную телеметрию и DataFlash в захвате, их хеши и неудачные попытки.
Полночастотные логи остаются локальными входами cache, а не распространяемой
firmware/исходниками. Оцениваемая трасса 100 Hz сохраняет исходные номера
кадров 800 Hz с шагом восемь. Нативный PASS не включает браузерный READY,
измеренную достоверность аппарата, записанный Simulation-on-Hardware или рабочий контакт рельефа.

## Проверка ноутбука Windows

Атрибуты репозитория сохраняют LF исходников и фикстур в Windows, а хешированные
архивы NASA сохраняются побайтно. Не пересоздавать хеши фикстур или зеркал из-за
преобразования checkout. Playwright запускает Vite собственным Node; после
установки закреплённых зависимостей npm в PATH не требуется. Браузерные фикстуры
используют переносимые экранированные URL файловой системы Vite.

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js . --max-warnings=0 --no-inline-config
node scripts/check-docs.mjs
node node_modules/vitest/vitest.mjs run --maxWorkers=2
$env:CHROMIUM_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
node node_modules/@playwright/test/cli.js test
$env:MIRAGE_BROWSER_GPU = 'hardware'
$env:MIRAGE_BROWSER_HEADED = '1'
node node_modules/@playwright/test/cli.js test tests/browser/render-backends.spec.ts
node scripts/probe-laptop.mjs --backend webgl2 --warmup 60 --seconds 600
node scripts/probe-laptop.mjs --backend webgpu --warmup 60 --seconds 120
```

Указать в CHROMIUM_PATH установленный Chrome/Chromium/Edge или не задавать
переменную для отдельно установленного браузера Playwright. Функциональный
профиль по умолчанию использует программный рендеринг. MIRAGE_BROWSER_GPU=hardware
убирает принудительные программные настройки GPU, но не гарантирует выбор
дискретной карты. Проверять записанные адаптер и драйвер. Видимое окно пробы
держать впереди, а временные пробы запускать без конкурирующих тестов и сборок.
Записывать режим питания, разрешение, DPR, температуры, изменения видимости
и постороннюю нагрузку.

Проба ноутбука владеет loopback-сервером production-preview и отдельным профилем
браузера; закрывает только собственные ресурсы. Она не подключается к Serial.
Сырые интервалы кадров, диагностика GPU, снимки объёма кучи и изображение относятся
к текущему демо. Куча браузера не равна резидентности GPU или CPU-кешу ландшафта.
Завершённая демопроба не удовлетворяет полной production-матрице
terrain/FPV/thermal TASK-073, её ограничениям памяти или отдельному требованию M4.
Видимый десятиминутный запуск демо остаётся полезным свидетельством стабильности,
даже когда production-приёмка заблокирована.

Отдельный production-захват:

```bash
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 60
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 120
```

Он раздаёт локальную фикстуру тайлов CC0 и измеряет сцену с установленной FPV,
fisheye, аналоговым видео и синтетическим LWIR на 1920×1080 при DPR 1 после
прогрева 60 с и 600 с видимых кадров. WebGPU завершается с `BLOCKED_EXTERNAL`,
потому что проходы fisheye и thermal не реализованы. Панель, чья частота
обновления не может показать запрошенный профиль, и браузер с нулевым размером
вёрстки, экрана или device pixel ratio тоже завершаются с `BLOCKED_EXTERNAL`.
2026-10-21 пользователь принял для 60 FPS медиану 16.680 мс, p99 17.665 мс и
панель 59.88 Гц. Предел p99 для 120 FPS остаётся 8.33 мс. Захват M4 оценивался
в эмулированном окне 1920×1080. Активный режим дисплея Mac — 2560×1440, штатная
матрица MacBook Air — 2560×1664. Снимок оператора в `task_073_results/`
показывает Chrome плавающим на рабочем столе, поэтому следующий захват должен
заполнить физический дисплей. Запускать команду в графической сессии, которая
может показать окно, и держать это окно впереди.

С 2026-10-22 захват не использует эмуляцию viewport. `--position X,Y`
(по умолчанию `0,0`) задаёт левый верхний угол дисплея, на котором он
показывается; окно браузера переходит там в полноэкранный режим с английским
интерфейсом (без предложения перевода), а страница `?g3=1` скрывает прокрутку,
поэтому измеряемый canvas совпадает с тем, что показывает физический дисплей.
Принятый профиль 60 FPS запускается на любом дисплее выше 58 Гц (решение
пользователя 2026-10-22); другие профили по-прежнему требуют
`refresh + 1 >= fps`. Рядом с отчётом анализатора захват записывает сырые
интервалы кадров (`gpu-<backend>-<fps>.frames.json`, хеш в сопроводительной
записи), снимок всего дисплея средствами ОС (`display-<backend>-<fps>.png`) и
дополнительные отсчёты, которые никогда не влияют на шлюз: пики Windows
`GPU Process Memory` для GPU-процесса браузера, состояния питания и частоты
`nvidia-smi` (`clocks-<backend>-<fps>.json`) и время смены изображения
PresentMon. PresentMon v2.6.0 ожидается в
`.cache/tools/presentmon-2.6.0/PresentMon-2.6.0-x64.exe` (или `MIRAGE_PRESENTMON`)
и требует повышенных прав или учётной записи в группе Windows
«Performance Log Users»; иначе сопроводительная запись сообщает, что он не
запускался. `node scripts/diagnose-render.mjs` сравнивает сцены demo, terrain и
`?g3=1` с помощью таймерных запросов GPU WebGL2; это только диагностика. Оба
инструмента открывают `?g3=1&flight=circuit`: сценарный пилот
(`packages/input/src/scripted-flight.ts`) только двигает стики, ставит на охрану
при нулевом газе, набирает 30 м и облетает начало координат со скоростью 10 м/с
по кругу радиусом не более 300 м, оставаясь внутри 60% радиуса района из
конфигурации сборки `VITE_MIRAGE_AREA_RADIUS_M` (по умолчанию 1000 м), поэтому во
время измерения происходят подгрузка ландшафта и смена уровней детализации.
Захват раз в секунду записывает полёт (`flight-<backend>-<fps>.json`: высота и
позиция с HUD, время симуляции, частота физики, отказ по входу, состояние охраны
и самый длинный разрыв кадров). Кнопку Start он нажимает только после ожидания
функций и отдельной WebGL-пробы идентичности: остановка главного потока дольше
тайм-аута входа пилота 250 мс блокирует защёлку охраны в Worker до снятия запроса
охраны, поэтому остановка в полёте приводит к падению дрона — так задумано.
FPV-камера находится на носу отрисованного корпуса
(`apps/web/src/vehicle-geometry.ts`), а не внутри него. `MIRAGE_SCREENSHOTS=1`
сохраняет снимок Playwright для каждого браузерного теста (по умолчанию — только
для упавших) для просмотра оператором.

`?g3=1` по умолчанию показывает внешний вид с камеры сопровождения, где виден
весь дрон; проходы FPV, аналогового видео и тепловизора по-прежнему рендерятся
каждый кадр в собственные цели. `?view=fpv` показывает вместо этого изображение
FPV. Захваты и тесты открывают `view=chase`. PresentMon запускается до полёта и
записывает весь прогон, потому что открытие его ETW-сессии в тестовом прогоне
остановило браузер примерно на 300 мс (достаточно, чтобы сработал тайм-аут
входа). Он записывает `CPUStartQPCTime` (`--qpc_time_ms`), который в Windows
использует ту же шкалу QueryPerformanceCounter, что и `process.hrtime` в Node,
поэтому сопроводительная запись оставляет только кадры внутри окна измерения и
сообщает `DisplayedTime` (время показа каждого кадра на экране), `GPUBusy` и
режим вывода.

Контроллер Serial ожидает готовность декодера до 5 секунд перед открытием
выбранного устройства. Существующий тайм-аут обратного давления 500 мс для
каждого chunk не меняется. Разрешение доступа и подтверждение запуска не включают HITL.

Для размещения окна оператором на определённом дисплее передать `--ready-file`
с новым путём внутри каталога результатов. Проба откроет страницу, но будет ждать
до прогрева и сбора данных. Создавать этот файл только после подтверждения
оператором нужного дисплея. Существующий файл отвергается; тайм-аут 15 минут
останавливает пробу вместо запуска без подтверждения. Частота выбранного дисплея
должна поддерживать запрошенный профиль видимого FPS; захваты на меньшей частоте
сохраняются как отдельные свидетельства.

Для визуальной проверки раскладки использовать `--native-viewport`: окно
запускается развёрнутым без принудительного viewport или эмуляции DPR.
`--position X,Y` задаёт начальное положение на рабочем столе; координаты брать
из фактического расположения мониторов. Записывать полученные viewport и DPR,
не называя такой запуск фиксированным профилем 1080p. На масштабированном дисплее
ноутбука эмуляция viewport 1920 CSS-пикселей может обрезаться внутри меньшей
нативной клиентской области браузера. Подтверждение нативного размера и запись
горизонтальных границ раскладки позволяют отличить размер тестового окна от
переполнения приложения. Обрезанный захват не считается визуальным PASS.

Записанная базовая проверка ноутбука Windows 11 (`test-results/laptop/`, Intel
Core 7 240H, RTX 4050 Laptop GPU, драйвер 561.00, Chrome 155.0.8059.84, Node
24.19.0, Rust 1.97.0): на выходе 1920x1080 60 Hz видимые захваты демо с DPR1
после 60 с прогрева дали 35 995 кадров за 600.0052 с (59.9911 FPS, p50/p95/p99
16.670/17.640/19.910 мс, макс. 34.365 мс) в WebGL2 и 7 193 кадра за 120.002465 с
(59.9404 FPS, p50/p95/p99 16.665/17.635/19.645 мс, макс. 34.270 мс) в нативном
WebGPU; на панели 1920x1200 144 Hz фиксированный захват 1920x1080 дал 59.9911
FPS (p99 19.565 мс, обрезан), а захват `--native-viewport` 1536x826 DPR 1.25 дал
59.99994 FPS (p99 19.005 мс, без обрезки). Все они не укладываются в принятый p99 60 FPS 17.665 мс
и предел 120 FPS 8.33 мс. Отдельно пятисекундные прогоны реального времени
`node scripts/bench-physics.mjs` в Windows Node (`test-results/laptop/physics-*-idle.json`)
выполнили 400.532 Hz (0 пропусков, вычисление p99 1.2 us, опоздание пробуждения
p99 15.76 мс) при цели 400 Hz, 516.710 Hz (1 426 пропусков, вычисление p99
1.1 us, опоздание p99 16.06 мс) при цели 800 Hz и 519.573 Hz (3 415 пропусков,
вычисление p99 1.3 us, опоздание p99 15.99 мс) при цели 1200 Hz (пробуждения
таймера ~16 мс x предел наверстывания 8 шагов); браузерная регрессия Worker на
800 Hz прошла свой диапазон 720–880 Hz.

Локальная USB-диагностика (`test-results/hardware/`, COM20 на 115200 8N1,
DTR/RTS отключены, батарея отсоединена) подтвердила устройство ArduPilot (VID
`1209`, PID `5741`, сообщаемая прошивка 4.6.3 stable `3fc7011a`, sysid/compid
1/1) на 67 пассивных кадрах (`5e996d6bb607ac9af9754676e6ffcc37509d700ec02041c477c8f403bb914638`)
и 252 кадрах опроса (`b026643bd47943e57a276896db85d608d852ec266f6592547fd82ece20d48329`)
без ошибок CRC или пропусков последовательности, со здоровыми выборками
IMU/барометра, disarmed heartbeat и выключенным HIL, тогда как компас, GPS,
батарея, RC (`PreArm: RC not found`) и допуск EKF по времени остались
заблокированы. Сырые захваты содержат идентификаторы устройства и не должны
переиспользоваться как общие фикстуры.

При диагностике движков и моделей проверять поля JSON-отчётов, а не только коды
выхода: `node scripts/validate-models.mjs` (`test-results/validation/model-report.json`)
возвращает 2, когда численные проверки проходят (`numericalStatus: "pass"`), а
сравнения с измерениями пропеллеров/контакта не проходят (`propellerFidelityStatus: "fail"`,
`contactFidelityStatus: "fail"`). Для артефактов JSBSim и контакта запускать
`node scripts/build-contact.mjs`, `node scripts/check-contact-binding.mjs`,
`node scripts/build-jsbsim.mjs --contact`,
`node scripts/check-jsbsim-backend.mjs --native`,
`node --experimental-transform-types scripts/check-jsbsim-backend.mjs` и
`node scripts/bench-jsbsim.mjs`.

## Захват нативной готовности EKF (TASK-043)

Нативный драйвер теперь использует LiveEkfWarmup для допуска arming и пишет
warmup.ndjson. Сохранять настроенные хеши исходников/ELF/драйвера, выбирать
новый каталог захвата, как выше. Запустить прежний нативный harness, затем
аудит сырого MAVLink перед следующими командами:

```bash
node scripts/check-sitl-capture.mjs --input "$MIRAGE_SITL_CAPTURE_DIR" --output test-results/validation/task-043-flight.json
node scripts/check-ekf-warmup.mjs --input "$MIRAGE_SITL_CAPTURE_DIR"
```

Второй отчёт отделяет наблюдавшиеся READY/отзывы и ускорение от синтетических
проверок отклонения. Требуются настоящий подтверждённый JSON IMU-отсчёт,
CRC-проверенные GPS fix/здоровье, неизменные исходники и совпадающий replay
решений. Краткие провалы свежести GNSS должны быть видны; не расширять допуски
ради непрерывного READY. Синтетическая проверка часов HITL не выполняет записанный Simulation-on-Hardware и виртуальный Hybrid SITL. Исторические отчёты TASK-042 лежат в
test-results/validation/task-042-snapshot-2026-10-19; новые аудиты используют
необязательный путь --output, сохраняя их. Нативный допуск не включает
браузерный READY и не применяет эффекты РЭБ.


## Нативный сбор отклика РЭБ (TASK-059)

Использовать те же закреплённые Linux/WSL ELF, исходники, WASM, Node и окружение MIRAGE_SITL_PYTHON, что в TASK-042. Драйвер владеет каждой парой прошивка/sidecar и ограничивает время; случаи выполняются последовательно. Существующий здоровый нативный полёт остаётся отдельной регрессией. Не использовать непустой каталог записи повторно.

```bash
export NODE_OPTIONS=--experimental-transform-types
node scripts/run-ew-sitl.mjs --output .cache/task-059/calibration --case all
node scripts/freeze-ew.mjs --calibration .cache/task-059/calibration
node scripts/run-ew-sitl.mjs --output .cache/task-059/validation --case all
node scripts/report-ekf.mjs --input test-results/validation/task-059-input.json --sha256 INPUT_SHA256
```

Команда freeze предназначена для однократной калибровки и отклоняет существующие диапазоны. Затем проверять новые записи по включённой матрице; не повторять калибровку ради исправления FAIL. Входной JSON содержит schemaVersion 2 и caseDirectories в порядке control, jamming, position-step, velocity-drift, magnetic, motor-loss. Использовать относительные пути репозитория для переносимого манифеста и SHA-256 точных байтов. Каждый случай сохраняет response-audit.json, исходные RX/TX, оригинальную декодированную телеметрию, наблюдения, физику полной частоты, решения допуска, настоящие ответы параметров и собственные логи прошивки. report-ekf повторно проверяет исходные байты и физику, отклоняет повторное использование калибровки/дрейф исходников и пишет ekf-report.json. Архивировать собственные симуляционные записи без бинарников прошивки и сторонних исходников. Нативные отчёты не включают браузерный READY и не сертифицируют физический самолёт.


## Локальный браузерный допуск прошивки (TASK-045)

Использовать точную внешнюю пару артефактов из native/ardupilot/wasm-artifact.manifest.json. Сборщик принимает только новые/пустые каталоги сборки и артефактов, сравнивает результат с этим манифестом, проверяет исходники/submodule/SDK/компилятор и сохраняет build.log. Сохранять предупреждения компилятора и pthread/memory-growth. Артефакт не копируется в production-приложение. Запустить локальный dev-сервер с явной настройкой и открыть /ardupilot-check.html для внутренней диагностики. Прошивка запускается только явным диагностическим/тестовым вызовом. Профиль связывает исходник/модуль; для экспериментов использовать отдельный профиль.

```bash
export MIRAGE_ARDUPILOT_WASM_DIR=/absolute/path/to/local/artifacts
node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1
```

```bash
CHROMIUM_PATH=/path/to/chrome node node_modules/@playwright/test/cli.js test tests/browser/ardupilot-wasm.spec.ts
python scripts/check-ardupilot-browser.py --input test-results/validation/task-045-browser-boot.json
```

Команде аудита нужен pymavlink 2.4.50 (подходит установленный WSL venv). Браузерные тесты используют только встроенный синтетический квадрокоптер и остаются disarmed. Проверяются настоящий ответ/сохранение/восстановление параметра, внезапное завершение, отсутствие оставшихся Worker, конфликты профиля, отмена транзакции, повреждение хранилища, изоляция, хеши, пределы размера и доступ к артефактам. JSON содержит исходные serial-байты и три EEPROM-образа по 16 КиБ; независимый аудитор пишет wire-audit JSON и serial/EEPROM .bin. Это собственные тестовые результаты. Прошивка/glue остаются внешними под local-only-pending-gpl-review. Повреждённые записи сохранять для диагностики; не стирать молча и не подменять defaults ради PASS. Контракт восстановления гарантирует только подтверждённые checkpoint. Живое время/физика симуляции, интеграция постоянного хранилища в полёте, пауза и паритет полёта относятся к TASK-046/047.

## TASK-047: локальное сравнение полёта native/browser

Используйте закреплённые чистые исходники/native ELF и HAL-артефакт TASK-042/046,
Node 24, существующую scalar-сборку BET WASM, изолированный Chromium и pymavlink
2.4.50. Для этого синтетического сравнения NACA6409/NeuralFoil не нужны
оборудование и измеренные данные ротора. Подготовка требует новой директории
и копирует upstream Copter defaults с явными параметрами синтетической модели;
проверки arming и EKF3 сохраняются. Native-драйвер запускается в Linux/WSL;
на Windows подготовьте bundle через Windows Node, передайте WSL-пути
собранному native-драйверу и используйте Windows Node для Playwright. Оба
бэкенда должны использовать один подготовленный файл defaults. При изменении
исходников сохраняйте захваты; пересоберите драйвер и повторите оба бэкенда,
не редактируя хеши.

```bash
node scripts/prepare-autopilot-parity.mjs --defaults /path/to/ardupilot/Tools/autotest/default_params/copter.parm --output .cache/task-047-run
node .cache/task-047-run/native-driver.mjs "$PWD" "$MIRAGE_SITL_BINARY" "$MIRAGE_SITL_SOURCE" "$PWD/.cache/task-047-run/defaults.parm" "$PWD/.cache/task-047-run/native-nominal.json"
MIRAGE_PARITY_FAILSAFE=1 node .cache/task-047-run/native-driver.mjs "$PWD" "$MIRAGE_SITL_BINARY" "$MIRAGE_SITL_SOURCE" "$PWD/.cache/task-047-run/defaults.parm" "$PWD/.cache/task-047-run/native-failsafe.json"
MIRAGE_PARITY_DEFAULTS="$PWD/.cache/task-047-run/defaults.parm" MIRAGE_HAL_ARTIFACT_DIR=/path/to/local/hal node node_modules/playwright/cli.js test tests/browser/autopilot-parity.spec.ts
for input in .cache/task-047-run/native-nominal.json .cache/task-047-run/native-failsafe.json test-results/validation/task-047-browser-takeoff-land.json test-results/validation/task-047-browser-gcs-failsafe.json; do
  python scripts/sitl/check-parity-wire.py --input "$input" --output "$input.audit.json"
done
node scripts/assemble-autopilot-parity.mjs --native .cache/task-047-run/native-nominal.json .cache/task-047-run/native-failsafe.json --wasm test-results/validation/task-047-browser-takeoff-land.json test-results/validation/task-047-browser-gcs-failsafe.json --output .cache/task-047-run/comparison
node scripts/compare-autopilot.mjs --native .cache/task-047-run/comparison/native.json --wasm .cache/task-047-run/comparison/wasm.json --output test-results/validation/autopilot-parity.json
```

Каждый native-прогон владеет частной временной директорией прошивки и дочерним
процессом; браузерный fixture владеет Worker/pthread прошивки. Захваты записывают
120 с полёта при 800 Гц с отсчётами 100 Гц, исходными serial-байтами и командами.
Оцениваемый эталон за 30 с — 90..120 с, без выравнивания траекторий. Штатный
случай посылает LAND на 90 с; GCS-случай вместо этого обрывает heartbeat и
требует STATUSTEXT прошивки, подтверждающий failsafe до посадки/разоружения.
JSON аудита сохраняется рядом с каждым захватом. До численного сравнения
анализатор проверяет эти файлы и текущие идентичности исходников/артефактов.
Отчёт допускает лишь capability паритета соответствующего жизненного цикла;
он не выбирает бэкенд приложения, не подтверждает измеренную точность и не
закрывает гейты аллокаций, распространения и релиза. Перед admitWasmParity
сохраните SHA-256 отчёта в доверенной локальной конфигурации приёмки.
Отсутствие захватов даёт код 2, неуспешные/непроверенные данные — код 1;
не заменяйте проваленный захват синтетической трассой и не обновляйте golden
для сокрытия расхождения.
