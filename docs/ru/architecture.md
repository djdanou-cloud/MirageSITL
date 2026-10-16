# Архитектура MirageSITL

<!-- source-sha256: 3aa05932236cd916f69698a589ca6eac0f0c4e08c7373001a42cf9e706d1f5d8 -->

Английский источник: [Source of truth](../architecture.md). Изменения спецификации обновляют оба языка в одной задаче.


Подробные зависимости и порядок исполнения определяет
[PROJECT_ROADMAP.md](PROJECT_ROADMAP.md). Capability milestones в конце
этого руководства не заменяют подробное расписание Phase 0–6.

## Этап 01: реализованные границы

Рабочий вертикальный срез: React 19 / R3F / WebGL, модульный Web Worker,
постоянный `dt = 1/400 s`, атомарный SAB transport, Gamepad, калибровка,
демонстрационная модель мультикоптера, визуализация и диагностика.
JSBSim/BET, ArduPilot, EW и аппаратный HITL ещё не реализованы.
Демонстрационная аэродинамика не валидирована для обучения пилотов.

400–1200 Гц и 60–120 FPS — целевые бюджеты. Фиксированный шаг не означает
гарантированное исполнение каждые 2,5 мс: таймеры, GC, ОС и фоновые вкладки
не дают hard real-time. Производительность на M4 / RTX 4050 пока не измерена.

## Директории

```text
apps/web/
  src/App.tsx                 # HUD, controls, calibration
  src/capabilities.ts         # API checks and implemented mode eligibility
  src/runtime.ts              # Gamepad/rAF, lifecycle, SAB reads
  src/FlightScene.tsx         # Position/SLERP in R3F useFrame
  src/coordinates.ts          # NED to Three.js
  src/physics.worker.ts       # Physics owner and fixed-step scheduler
  vite.config.ts              # COOP/COEP for dev and preview
packages/
  protocol/src/index.ts       # ABI v1, types, SAB readers/writers
  physics/src/index.ts        # Demo dynamics and bounded scheduler
  physics/src/model-manifest.ts # Verified configuration registry
  physics/src/model.schema.json # Strict serialized model schema
  test-support/src/           # Fixture verification and seeded streams
  input/src/index.ts          # Gamepad and channel calibration
docs/
  PROJECT_ROADMAP.md          # English task source
  SPECS_SHARED_MEMORY.md      # Implemented v1 and target v2
  SPECS_SIMULATION_ENGINES.md # Target physics and EW contracts
  architecture.md
  shared-memory.md
  ru/                        # Russian documentation mirrors
tests/
  *.test.ts                  # ABI, physics, scheduler, input
  browser/simulation.spec.ts # Real Worker/SAB, UI, mock USB
```

Следующие компоненты добавляются поэтапно; сейчас этих директорий нет:

| Директория | Назначение |
| --- | --- |
| `apps/bridge` | localhost WS ↔ ArduPilot JSON/UDP и MAVLink |
| `packages/wasm-jsbsim` | pinned JSBSim/Emscripten, C ABI |
| `packages/wasm-bet` | роторы/рамы, native reference + WASM |
| `packages/sensors` | IMU/GNSS/magnetometer, шум, bias, timestamps |
| `packages/autopilot` | direct/external SITL/WASM SITL/HITL adapters |
| `packages/ew` | сценарные искажения наблюдений, hazard volumes |
| `packages/terrain` | streaming render LOD, отдельный collision LOD |
| `packages/aar` | recorder/replay, входы/актуаторы/truth/EKF |
| `services/tiles-worker` | Cloudflare proxy, квоты, разрешённый cache |
| `native` | исходники/toolchain pins и эталонные тесты WASM |

## Потоки и ответственность

```mermaid
flowchart LR
  HID[EdgeTX / OpenTX USB] --> GP[Main: Gamepad + calibration]
  GP --> CMD[SAB control mailbox]
  CMD --> W[Physics Worker: fixed step]
  W --> RING[SAB state ring]
  RING --> R[Main: R3F interpolation + HUD]
  W -. future .-> S[Ideal sensors -> noise -> EW]
  S -.-> AP[Autopilot adapter]
  AP -. actuators .-> W
  AP -.-> WS[Local WS bridge -> SITL]
  AP -.-> SERIAL[Web Serial -> HITL]
  AP -.-> WASM[ArduPilot WASM]
```

Worker владеет truth, часами симуляции и интегратором. Main владеет DOM,
WebGL, Gamepad и разрешениями. Физика не читает scene graph и не ждёт
рендер. React получает сводку каждые ~150 мс; R3F читает два последних
состояния: SLERP для quaternion, linear interpolation для координат.
При несовпадении соседних tick после конкурентной публикации/reset
показывается последнее целое состояние.

High-rate данные идут через SAB; `postMessage` — только init/lifecycle/error.
Расширения потребуют отдельных типизированных sensor/actuator buffers.
Hot path физики повторно использует вход, состояние и scratch; явных
аллокаций на шаге нет. Worker имеет отдельную JS-кучу, но абсолютной
изоляции от GC/ОС обещать нельзя. WASM memory выделяется заранее;
`memory.grow`, загрузка terrain, сеть и декодирование исключаются из шага.

## Часы, перегрузка и безопасность ввода

`FixedStepClock` следит за дедлайнами `performance.now()`. Интегратор всегда
получает один и тот же dt. До 8 шагов за callback, затем yield event loop
для lifecycle-команд. Вложенные `setTimeout` могут ограничиваться браузером
примерно 4 мс; один callback тогда выполняет несколько физических шагов.

Если бюджет catch-up исчерпан, целые wall-clock интервалы отбрасываются,
растут `DroppedSteps/Overruns`. Время симуляции увеличивается только на
рассчитанные шаги. Большой переменный dt не подставляется. Pause/resume
переустанавливают дедлайны; reset останавливает цикл и сбрасывает модель.
Скрытие вкладки снимает arm и ставит полёт на паузу. Worker самостоятельно
отвергает input старше 250 мс, нечисловые, disconnected/disarmed команды.
Целевая тяга становится нулевой, ротор продолжает затухать по spool lag.

Для SITL нужен другой режим clock: lockstep sensor/actuator frames с
симуляционными timestamp. Для HITL часы реальные; при перегрузке сессия
останавливается/помечается недостоверной, ускорять её нельзя.

Gamepad API доступен в Window, не в обычном Worker. Опрос в rAF имеет
ненулевую задержку USB/HID/browser/display. Измерять p50/p95/p99 input age
и end-to-end latency; «нулевой input lag» недостижим. Default осей
`roll=0,pitch=1,yaw=3,throttle=2` — начальное предположение, а не стандарт
EdgeTX. UI задаёт индексы/endpoints/центр/инверсию; deadzone 3,5% для
центрированных осей. Калибровка действует только в текущем сеансе.
Переключение источника/устройства/калибровки снимает arm. При отключении
пульта другой пульт автоматически не выбирается. Arm требует газ <=5%.

## Координаты и физические backend

SI, правая NED: North/East/Down. Body FRD: Forward/Right/Down.
Quaternion `(w,x,y,z)` преобразует FRD -> NED; body rates p/q/r — рад/с,
положительный знак по правилу правой руки. Three.js:
`(x,y,z)=(east,-down,-north)` — поворот без отражения. WGS84/ECEF и
origin shifts добавляются отдельно: float64 геодезия, локальные GPU float32.

Demo — rate-controlled toy quad: коллективная тяга, first-order spool lag,
quaternion, gravity и линейное сопротивление. Semi-implicit Euler для
перемещения, `down<=0` — простое ограничение плоской земли. Напряжение
индикативно зависит от газа, а не от батарейной электрохимии. Нет
индивидуальных моторов, контактов шасси, rotor BET или авторотации.

Будущий `DynamicsBackend`:
`reset(config)`, `step(dt, actuatorFrame, atmosphere, contactInput)`,
`readTruth(preallocatedOutput)`. Автопилот возвращает актуаторы;
только физика превращает их в силы/моменты.

* **JSBSim:** его собственные уравнения движения; единицы ft/slugs и
  conventions конвертируются явно на границе C ABI.
* **BET:** относительная скорость элемента, alpha, lift/drag по полярным
  таблицам Re/Mach, интеграция сил/момента. Для авторотации нужны баланс
  аэромомента, инерция, маховые движения и induced flow, а не заданные RPM.
* **Произвольная рама:** `F=ΣR_i F_i`,
  `M=Σ(r_i×R_i F_i + R_i M_i)` в body frame. ESC, напряжение,
  rotor inertia и взаимодействие соосных дисков — отдельные состояния.
* **Rapier/Jolt:** один владелец интегрирования rigid body. BET может
  отдавать силы solver; с JSBSim нужен согласованный обмен контактными
  импульсами. Два независимых интегратора одного тела недопустимы.

## ArduPilot: границы интеграций

Режимы взаимоисключающие; состояния:
`disconnected -> initializing -> warming -> ready -> running -> fault`.

1. **Внешний SITL — первый целевой backend.** Dev bridge
   `ws://localhost:9002`; для HTTPS проверить mixed-content/Private Network
   Access и при необходимости доверенный локальный WSS. Bind loopback,
   проверка Origin/сессии, ограничения размера/частоты. JSON/UDP physics
   backend передаёт truth/sensors lockstep; MAVLink — RC, команды и
   диагностику. Одного `RC_CHANNELS_OVERRIDE` для внешней физики мало.
2. **WASM ArduPilot — feasibility-задача.** HAL, scheduler, storage,
   sockets, лицензии, clock и parity с native SITL. Компиляция в WASM
   сама по себе не доказывает работоспособность порта.
3. **HITL.** Chromium на macOS/Windows, secure context и пользовательский
   gesture для Web Serial `requestPort()`. Safari/Firefox не целевые
   HITL-браузеры. MAVLink2 parser: CRC/dialect/seq/sysid/compid и signing,
   если требуется. `HIL_SENSOR` 200–400 Гц, `HIL_GPS` 5–10 Гц,
   `HIL_ACTUATOR_CONTROLS` с корректными timestamp. Сначала проверить
   поддержку этих сообщений/HIL режима в конкретной ArduPilot build/плате:
   наличие SITL не доказывает поддержку аппаратного HIL.

Serial budget: при 8N1 полезный предел `baud/10` bytes/s, включая framing
и весь трафик. 115200 может не хватить; нужен измеренный запас и baud,
поддерживаемый FC. Выбор порта не равен проверке замкнутого контура.

Прогрев 30 секунд — simulation time в SITL lockstep, без EW, с согласованными
IMU/GNSS/mag. Готовность по EKF health/status/innovations, не по одному
таймеру. В HITL fast-forward неприменим, EKF FC живёт в реальном времени.
Ни warmup, ни MAVLink пока не реализованы.

## EW, terrain, камеры и AAR — следующие этапы

Truth не изменяется: `truth -> ideal sensor -> noise/bias -> EW -> adapter`.
Сенсоры имеют свои частоты, задержки, оси, единицы и seeded RNG. Ускорение
в текущем ABI инерциальное, включая gravity: для HIL accelerometer specific
force требуется отдельно вычесть g и преобразовать в body frame.

Hazard volumes ограничивают `1/r²` через конечный `r_min` и saturation;
конус учитывает направление/aperture. Нужна receiver model: мощность не
равна числу спутников. GNSS loss/spoofing воздействует только на наблюдения;
coherent drift интегрирует согласованные position/velocity, не телепортирует
truth. Mag errors применяются в sensor frame; motor fault — к конкретному
актуатору до суммирования сил. Реакция EKF/flight mode зависит от версии,
параметров и других сенсоров: нельзя обещать обход gate или заданный
failsafe без сценарного регрессионного теста.

WebGL2 — стартовый renderer; WebGPU — отдельный backend с capability
detection и visual parity tests. Metal/DX12 выбирает браузер. Ограничить
DPR, текстуры, tile LOD: RTX 4050 имеет 6 GB с запасом под browser/framebuffer,
M4 использует общую RAM. Terrain decoder не должен занимать Physics Worker.

Google Photorealistic Tiles требует billing/key/attribution и соблюдения
условий Map Tiles API. **Постоянное копирование Google tiles в R2 и
предзагрузка радиуса 10–15 км не принимаются как разрешённый default.**
Сначала проверить лицензию/правила caching; cache только в разрешённых
пределах или использовать собственные/лицензированные offline tiles.
Cloudflare proxy скрывает ключ, ограничивает origin/session/quota и
следует разрешённым TTL. COEP требует CORS/CORP для внешних tiles/WASM.

Analog FPV — postprocessing, отделённый от truth. WorldCover/OSM дают
классы поверхностей, не температуру: thermal требует emissivity, погоду,
solar heating, inertia, attenuation и calibration data. AO не вычисляет
тепло. Начать с контролируемых synthetic материалов и GPU budget.

State ring — лишь ~0,64 с для рендера, не AAR. AAR — отдельный bounded
recorder Worker/IndexedDB: input/actuator/truth/sensors/EKF + seed/config/
version/events. Потери логируются. Replay состояния отличается от
повторного расчёта; native/WASM сравниваются с численными допусками.

## Поэтапная приёмка

| Этап | Результат | Проверка |
| --- | --- | --- |
| 01 — сейчас | Worker/SAB/Gamepad/demo | unit tests + настоящий браузерный Worker, полёт/pause/reset, USB mock |
| 02 | WASM physics abstraction + sensors | силы/моменты, specific force, contacts/energy, convergence 400/800/1200 Гц |
| 03 | внешний SITL lockstep | arm/takeoff/land, EKF readiness, RC, разрывы связи, pinned ArduPilot |
| 04 | BET/рамы/авторотация | thrust curves, torque balance, energy, spool/battery, экспериментальные эталоны |
| 05 | EW + AAR | seeded replay, truth/sensors separation, EKF response и mode changes |
| 06 | HITL | реальная плата/firmware, sustained serial throughput, jitter/loss/failsafe |
| 07 | terrain/FPV/thermal/WebGPU | лицензии/attribution, VRAM/LOD, целевые M4/4050 |
| Feasibility | ArduPilot WASM | parity с внешним SITL до объявления поддерживаемым |

Замеры в production на M4 и RTX 4050, видимая вкладка, после warmup:
frame time p50/p95/p99, worker step/deadline lateness, выполненные steps/s,
dropped wall time, input age, sensor jitter, GPU memory и end-to-end latency.
120 FPS — 8,33 мс/frame, 60 FPS — 16,67 мс; 1200 Гц — 0,833 мс/step
с запасом. Облачный headless smoke не подтверждает эти бюджеты.

## Контракты Phase 0: fixtures, возможности браузера и модели

TASK-004–006 добавляют границы проверки конфигурации; новый физический backend
не вводится. TASK-007 сохраняет работающий ABI v1. Тесты v1 фиксируют 32896 байт,
заголовок 64 байта, 256 состояний по 128 байт и pilot mailbox со смещения 32832.
`tests/protocol-golden.test.ts` добавляет независимый oracle: зарегистрированный
и составленный вручную fixture `tests/fixtures/abi/v1-layout.json` должен
поле за полем совпадать с таблицами байтов v1 для header, state и pilot mailbox
в SPECS_SHARED_MEMORY.md, а каждый байт буфера 32896 байт, записанный
StateWriter и ControlWriter (header, два слота ring, нетронутые слоты,
reserved words и mailbox), должен совпадать с образом, упакованным локальным
DataView. Readers v1 не используются, поэтому симметричная ошибка смещений
encoder/decoder не может пройти проверку. TASK-008 добавляет в packages/protocol
константы layout v2, codecs state и pilot, инициализацию header, проверку и
согласование v1/v2. Они сверяются с `tests/fixtures/protocol/state-v2.hex` —
golden records, упакованными Python struct по таблицам спецификации независимо
от TypeScript encoder. TASK-009 добавляет ограниченный seqlock-транспорт
раздела 4: StateWriterV2/StateReaderV2 с проверками sample_id и head и не
более чем тремя попытками чтения, PilotWriterV2/PilotReaderV2, диагностику
header и безопасную по epoch историю рендера (latestPair никогда не связывает
кадры через смену epoch, модели или пропуск tick). Стресс-тест на реальных
потоках публикует 1e6 кадров в Node worker_threads и в browser module Worker,
пока reader проверяет каждое поле; удаление повторной проверки seqlock
приводит к обнаружению разорванных кадров. TASK-010 добавляет Control
Protocol v2: `parseControlCommandV2` проверяет недоверенные команды и
возвращает нормализованные копии, `control-v2.schema.json` — эквивалентный
контракт JSON Schema 2020-12 (тест эквивалентности на Ajv покрывает более 50
случаев), а `ControlProcessorV2` реализует дедупликацию, epochs, расписание
из 128 команд, применяемых перед интегрированием каждого tick, правила
состояний жизненного цикла и атомарную смену модели через интерфейс
`ControlTargetV2` с заранее выделенным outbox. Работающее приложение остаётся
на v1 до TASK-085.

### Проверенные манифесты fixtures и детерминированные потоки

`packages/test-support` экспортирует `./fixtures` и `./prng`. Реестр
`tests/fixtures/registry.json` задаёт пути относительно `tests/fixtures/`.
Все три эталонных payload явно синтетические: аналитические NED ballistic samples
при постоянной гравитации, конфигурация демонстрационного квадрокоптера и
составленная вручную раскладка байтов ABI v1.
Они служат воспроизводимыми программными эталонами, а не экспериментальным
подтверждением аэродинамики.

`verifyFixture(metadata, bytes)` делает снимки обоих входов до ожидания SHA-256,
проверяет строгие метаданные formatVersion 1, сравнивает 64-символьный lowercase
hash с точными байтами payload и возвращает глубоко замороженный манифест.
Изменение пробелов требует нового hash. Размер payload ограничен 16 MiB.
Каждая величина имеет разрешённую единицу и соответствующие конечные замкнутые
границы; абсолютный и относительный допуски конечны и неотрицательны. Словарь
единиц: `1`, `s`, `us`, `m`, `m/s`, `m/s^2`, `rad`, `rad/s`, `N`, `N*m`,
`kg`, `kg*m^2`, `Pa`, `K`, `V`, `A`, `rev/min`, `gauss`.

Provenance — строгий discriminated union. Синтетическим данным нужен derivation;
измеренным — datasetId, license, разбираемый acquiredAt и HTTPS reference.
Замена synthetic на measured с сохранением derivation отклоняется.
Метаданные не доказывают факт измерения: перед использованием для physics gate
нужно проверить внешний источник. Digest подтверждает целостность относительно
доверенной записи реестра, но не подлинность произвольного переданного hash.

`SeededRandom(seed, streamId)` принимает uint32, включая ноль. Версия —
`mulberry32-mix32-v1`; reset воспроизводит последовательность. Начальное состояние:
`mix32(seed ^ mix32(streamId ^ 0x9e3779b9))`, арифметика uint32. mix32 применяет
xor shifts 16/15/15 и умножения на 0x21f0aaad и 0x735a2d97.
Mulberry32 увеличивает состояние на 0x6d2b79f5. `nextUint32()` выдаёт [0, 2^32−1];
`nextFloat()` делит на 2^32, получая [0,1). Для seed 123 / stream 7 закреплён ряд
uint32: 1915834569, 2163859737, 2018986825, 2541224312, 3937151044.
Раздельные экземпляры имеют независимое изменяемое состояние; это не
криптографический генератор и не доказательство статистической независимости
или непересечения потоков. Конструктор/reset проверяют параметры вне step;
получение чисел не создаёт объектов. Назначение потоков датчикам относится
к будущему контракту sensors/EW.

### Допуск браузера перед запуском Worker

`apps/web/src/capabilities.ts` предоставляет `CapabilityReport` и внедряемый
`inspectCapabilities(environment?, timeoutMs?)`. Для текущего графического demo
нужны secure context, cross-origin isolation, SharedArrayBuffer, Worker и
успешное создание WebGL2 context. При отсутствии обязательных возможностей
Start отключён, Worker/сцена не создаются, показано объяснение. READY по-прежнему
требует подтверждения инициализации от настоящего Worker.
Для USB дополнительно нужен Gamepad API. Наличие пульта, калибровка каналов и
статус подключения остаются отдельными проверками ввода.

WebGPU adapter probe обрабатывает rejection, null и таймаут одну секунду,
сохраняя WebGL2. Временный WebGL2 probe освобождает context. Serial проверяется
без запроса разрешения. Наличие API отличается от допуска режима:
`hitlEligible` и `webgpuEligible` остаются false, поскольку интеграции ещё нет.
Chromium tests подменяют доступность API и проверяют настоящий поддерживаемый
Worker/renderer; оборудование ими не валидируется.

### Допуск модели и неизменяемые ID сессии

`@mirage/physics/model-manifest` — отдельный package export. Его схема AJV 8.20.0
и асинхронный загрузчик не входят в граф импортов текущего demo Worker.
Сериализованные `ModelDescriptor`/`RotorGeometry` используют readonly JSON arrays;
это конфигурационное представление целевой геометрии, а не будущий typed-array
WASM ABI из SPECS_SIMULATION_ENGINES. `VerifiedModel` хранит `{sha256, manifest}`
раздельно, поэтому манифест не хеширует сам себя.

`model.schema.json` использует JSON Schema draft-07, запрещает неизвестные поля
и требует schemaVersion 1, units SI, world NED, body FRD, quaternion order wxyz,
положительную конечную массу, row-major inertia из девяти значений,
modelId в [1,2^32−1], kind demo/bet/jsbsim, rotorCapacity 32 и совпадающие
rotorCount/rotors в [0,32]. Inertia должна быть точно симметричной и положительно
определённой по Cholesky; проверка не исправляет тензор. Rotor IDs и motor
channels — уникальные целые [0,31]. Число лопастей [1,16], azimuth samples
[1,64], polar IDs — uint32.

Для ротора нужны положительные radius/chords/shaft inertia/quadrature widths,
неотрицательные cutout и bearing friction, spin sign ±1, конечная геометрия и
единичный hub-to-body wxyz quaternion с допуском нормы 1e-6. Массивы radial station,
chord, twist и width имеют одинаковую длину [1,64]. Stations строго возрастают
внутри (cutout,radius); сумма widths равна radius−cutout с допуском 1e-9 м.
Это проверка структурной допустимости, а не доступности polar или точности
аэродинамики.

`ModelRegistry.register(bytes, expectedSha256)` копирует не более 1 MiB,
проверяет точные байты по доверенному SHA-256, декодирует строгий UTF-8 JSON,
валидирует и замораживает снимок, затем допускает его в реестр сессии.
Одинаковые ID/hash возвращают ту же запись; иной hash для существующего ID —
коллизия. Ошибки hash/schema/physics не меняют реестр, в том числе когда вызывающий
код изменяет исходные bytes во время hashing. `get(modelId)` возвращает
проверенную неизменяемую запись. Переключение модели runtime появится в
TASK-010; текущий demo этим реестром не переключается. Проверка конфигурации
может выделять память; она не должна выполняться внутри physics step.

## Строительные блоки runtime (Phase 1–2)


### Многочастотные часы (TASK-011)

`packages/physics/src/clock.ts` предоставляет `MultiRateClock` для 400/800/1200 Гц.
Шаг интегрирования всегда ровно `1/hz`; сроки вычисляются как
`origin + n*1000/hz` по целым счётчикам шагов, поэтому дрожание пробуждений
никогда не накапливается в дрейф. За одно пробуждение выполняется не более
`maxCatchUp` (8) шагов; лишнее wall-время отбрасывается и учитывается, а
`reset(nowMs)` при возобновлении отбрасывает накопившийся backlog. Часы
владеют `TickId` текущей epoch (tick 1 — первое интегрирование).
`tickToMicros` точно вычисляет MAVLink `time_usec = floor(tick*1e6/hz)`
(интервалы 833/834 мкс при 1200 Гц), а `isSampleDue`/`sampleIndexAtTick`
рационально планируют выборки IMU/GNSS. `DemoDynamics(hz)` интегрирует с
`dt = 1/hz` и `sim_time = tick/hz`. Worker v1 по-прежнему работает на 400 Гц
через `FixedStepClock`, теперь являющийся `MultiRateClock` на 400 Гц.

### Режимы часов и перегрузка (TASK-012)

`SteppingPolicy` (`packages/physics/src/clock-policy.ts`) оборачивает один
`MultiRateClock` и применяет заданный режим при каждом неблокирующем вызове
`pump(nowMs, gate, step, report)`. **interactive** задаёт темп по wall-времени
и учитывает отброшенные интервалы. **sitl-lockstep** продвигается по времени
симуляции: tick выполняется только когда `StepGate` сообщает о готовности его
кадра актуаторов, ticks никогда не отбрасываются, за один pump выполняется не
более `maxCatchUp`, а при отсутствии кадра вызов сразу возвращается с
`waiting`, поэтому сообщения pause/dispose никогда не блокируются.
**hitl-realtime** задаёт темп по wall-времени относительно физического
полётного контроллера; догоняющие шаги в пределах `maxCatchUp` нормальны, но
любой отброшенный интервал устанавливает fault `hitl-overrun`, после чего ни
один tick не выполняется до `resetEpoch`. Заранее выделенный `PumpReport`
перезаписывается при каждом pump.

### SPSC-очереди датчиков и актуаторов (TASK-013)

`spsc-v2.ts` реализует очереди раздела 5: по одному SAB размером 131 136 байт
на направление, по одному `SpscProducer` и одному `SpscConsumer` на каждый.
Producer владеет write_counter/full_events, consumer — read_counter; счётчики
модульные uint32, и каждое общее слово использует Atomics. Полная очередь
никогда не перезаписывает непрочитанные кадры: `sitl-would-block` возвращает
`would-block`, чтобы lockstep ждал, а `hitl-fault` фиксирует fault сессии до
`resetSpscQueue`, который очищает счётчики и продвигает epoch очереди только
при остановленных обоих концах. Каждое условие заполнения увеличивает
full_events. Consumer копирует слот в scratch и освобождает его до
декодирования. `SensorFrameCodecV2` и `ActuatorFrameCodecV2` упаковывают общий
слот 128 байт и проверяют его по виду: число значений, диапазон f32, точные
целые значения fix/satellites GNSS, биты validity только для GNSS, нулевые
geo-поля вне GNSS и нормализованные актуаторы в [-1,1]. Стресс-тесты на
реальных потоках передают 1e6 кадров по порядку в Node worker_threads и в
browser Worker.
