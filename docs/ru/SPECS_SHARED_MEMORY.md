# SPECS_SHARED_MEMORY.md

<!-- source-sha256: b406d17fee31158894f84d6fd380b468fc48b1780baf798f33885d831a7de967 -->

Английский источник: [Source of truth](../SPECS_SHARED_MEMORY.md). Изменения спецификации обновляют оба языка в одной задаче.


Версия документа: 1.0 · 2026-10-15. Базовый код: commit `e3bb6b4`.

**Работающее приложение использует ABI v2 и Control Protocol v2 (TASK-085):
state ring v2, pilot mailbox, SPSC-очереди (TASK-013), `init-v2` и обработчик
команд. ABI v1 остаётся реализованным и протестированным в
`packages/protocol`, но приложение его больше не использует; его удаление
требует зафиксированного решения.** TASK-008/009 реализуют
layout и транспорт v2; TASK-010 — команды.
Не добавлять EKF/EW в зарезервированные слова v1 без смены версии.
Идентификаторы задач определены в [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md).

## 1. Общие соглашения

* SI; world NED (North, East, Down), body FRD (Forward, Right, Down).
* Quaternion `(w,x,y,z)` — активный поворот FRD → NED; единичная норма.
* `accelerationNed` — кинематическое ускорение `dv/dt`, включая gravity.
  Ideal accelerometer specific force: `f_body = R(q)^T (a_ned - g_ned)`.
* На целевых Apple Silicon/x86-64 — little-endian, IEEE754. Float payload
  пакуется через **локальный** DataView, а shared words передаются Atomics.
* Main создаёт память один раз; structured clone SAB **без transfer list**.
  Нужны secure context, COOP `same-origin`, COEP `require-corp`,
  `crossOriginIsolated=true`. У внешних ресурсов нужны CORS/CORP.
* Single writer на каждую область. Не читать shared Float64Array напрямую.
  Ни Main, ни worker не используют бесконечный spin или ожидание другого.
* Render ring — bounded история для интерполяции, не AAR и не sensor queue.

## 2. ABI v1 (унаследованный регрессионный контракт)

Источник: `packages/protocol/src/index.ts`, `ABI_VERSION=1`, `MAGIC=0x4d534954`.
`64 + 256*128 + 64 = 32 896 bytes`.

| Область | Absolute Byte Offset | Bytes | Writer |
| --- | ---: | ---: | --- |
| Header | 0 | 64 | Main init, далее Worker counters |
| State ring | 64 | 32 768 | Worker |
| Pilot mailbox | 32 832 | 64 | Main |

### Header v1 (absolute offsets)

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | magic | magic |
| 4 | u32 | version | abi_version = 1 |
| 8 | u32 | slots | capacity = 256 |
| 12 | u32 | int32 words | state_words = 32 |
| 16 | u32 | publications | published |
| 20 | u32 | events | overruns |
| 24 | u32 | wall intervals | dropped_steps |
| 28..63 | u32[9] | — | reserved_zero |

### State v1 (offset от начала slot)

Для слота `i`: `absolute = 64 + i*128 + offset`, `0<=i<256`.

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | steps | tick (tick_id v1) |
| 8 | f64 | s | sim_time |
| 16 / 24 / 32 | f64 × 3 | m | north / east / down |
| 40 / 44 / 48 / 52 | f32 × 4 | unit quaternion | qw / qx / qy / qz |
| 56 / 60 / 64 | f32 × 3 | m/s | vn / ve / vd |
| 68 / 72 / 76 | f32 × 3 | m/s² | an / ae / ad |
| 80 / 84 / 88 | f32 × 3 | rad/s | p / q / r |
| 92 | f32 | [0,1] | demo_spool |
| 96 | f32 | V | demo_battery_voltage |
| 100 | u32 | bitmask | flags: bit0 OnGround, bit1 InputFailsafe |
| 104 | f64 | ms since time origin epoch | scheduled_wall_time_ms |
| 112..127 | u32[4] | — | reserved_zero; **нет EKF/EW** |

### Pilot mailbox v1 (offset от 32 832)

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | — | reserved_zero |
| 8 | f64 | wall ms | sampled_wall_time_ms |
| 16 / 20 / 24 | f32 × 3 | [-1,1] | roll / pitch / yaw |
| 28 | f32 | [0,1] | throttle |
| 32 | u32 | bitmask | bit0 Connected, bit1 Armed |
| 36..63 | u32[7] | — | reserved_zero |

`sim_time=tick/400`. Input age считается по фактическому wall clock,
не по presentation deadline. Допускается возраст 0..250 мс; NaN, disconnected
и disarmed дают нулевой target thrust с сохранением spool decay.
Reset не сбрасывает `published`. Сессию завершить **до wrap u32 published**:
примерно 124 суток при 400 Гц. V1 не имеет session epoch/flight modes.

Реализованный postMessage protocol:

```ts
export type MainToPhysicsV1 =
  | { type: 'init'; version: 1; buffer: SharedArrayBuffer }
  | { type: 'start' | 'pause' | 'reset' | 'dispose'; requestId: number };
export type PhysicsToMainV1 =
  | { type: 'ready'; version: 1; hz: 400 }
  | { type: 'ack'; command: 'start' | 'pause' | 'reset' | 'dispose'; requestId: number }
  | { type: 'error'; message: string };
```

## 3. ABI v2

State stride = **192 bytes**, capacity = **256**. Main SAB:
`64 + 256*192 + 64 = 49 280 bytes`. Другой layout не распознаётся как v2.
При несовпадении version/size/magic/stride/capacity запуск отклоняется.
Никакой автоматической интерпретации v1 как v2.

| Область | Absolute Byte Offset | Bytes | Writer |
| --- | ---: | ---: | --- |
| Header | 0 | 64 | Main init, Worker diagnostics |
| State ring | 64 | 49 152 | Physics Worker |
| Pilot mailbox | 49 216 | 64 | Main |

### Header v2

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | magic | magic = 0x4d534954 |
| 4 | u32 | version | abi_version = 2 |
| 8 | u32 | bytes | header_bytes = 64 |
| 12 | u32 | bytes | state_stride = 192 |
| 16 | u32 | slots | capacity = 256 |
| 20 | u32 | publications | published (Worker) |
| 24 | u32 | events | overruns (Worker) |
| 28 | u32 | wall intervals | dropped_steps (Worker) |
| 32 | u32 | Hz | physics_hz = 400, 800 или 1200 |
| 36 | u32 | epoch | session_epoch (Worker; initial 1) |
| 40 | u32 | steps | max_catch_up = 8 |
| 44 | u32 | bitmask | runtime_flags: bit0 Ready, bit1 Running, bit2 Fault |
| 48 | u32 | bytes | pilot_offset = 49 216 |
| 52 | u32 | bytes | pilot_bytes = 64 |
| 56..63 | u32[2] | — | reserved_zero |

Инициализация header выполняется до подключения readers. Hz меняется только
на paused/disarmed сессии, с новым epoch/reset. Диагностические counters
могут читаться независимо; header не является транзакционным snapshot.
Для согласованного epoch нужен epoch внутри прочитанного state.

### State v2 (offset от `64 + slot*192`)

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | publications | sample_id, равен published после этой записи |
| 8 | u64 (lo32,hi32) | steps | tick_id, интеграции внутри epoch |
| 16 | f64 | s | sim_time = tick_id / physics_hz |
| 24 / 32 / 40 | f64 × 3 | m NED | north / east / down |
| 48 / 52 / 56 / 60 | f32 × 4 | unit quaternion | qw / qx / qy / qz |
| 64 / 68 / 72 | f32 × 3 | m/s NED | vn / ve / vd |
| 76 / 80 / 84 | f32 × 3 | m/s² NED | an / ae / ad |
| 88 / 92 / 96 | f32 × 3 | rad/s FRD | p / q / r |
| 100 / 104 / 108 | f32 × 3 | m/s² FRD | ideal_specific_force_x/y/z |
| 112 | f32 | m/s | true_airspeed |
| 116 | f32 | V | battery_voltage |
| 120 | f32 | A | battery_current |
| 124 | f32 | Pa | ambient_pressure |
| 128 | f64 | wall ms | scheduled_wall_time_ms |
| 136 | f32 | m | ground_clearance |
| 140 | f32 | rev/min | reference_rotor_rpm; UI, не массив всех роторов |
| 144 | u32 | bitmask | vehicle_flags |
| 148 | u32 | bitmask | ekf_flags, нормализованные flags проекта |
| 152 | u32 | bitmask | ew_flags |
| 156 | u32 | bitmask | sensor_valid_mask |
| 160 | u32 | epoch | session_epoch |
| 164 | u32 | registry key | model_id |
| 168 | u32 | ArduPilot custom_mode | autopilot_mode; 0xffffffff = unknown |
| 172 | u32 | bitmask | autopilot_health |
| 176 | u64 (lo32,hi32) | steps | last_actuator_tick, meaningful при валидном actuator |
| 184 | f32 | wall ms HITL / sim ms SITL | autopilot_status_age_ms |
| 188 | u32 | — | reserved_zero |

Flags v2:

| Поле | Биты |
| --- | --- |
| vehicle_flags | 0 GroundContact; 1 InputFailsafe; 2 Armed; 3 ActuatorValid; 4 AutopilotStatusValid; 5 ModelOutsideValidity; 6 Paused |
| ekf_flags | 0 AttitudeValid; 1 HorizontalVelocityValid; 2 VerticalVelocityValid; 3 AbsoluteHorizontalPositionValid; 4 AbsoluteVerticalPositionValid |
| ew_flags | 0 GnssJamming; 1 PositionStep; 2 VelocityDrift; 3 MagneticAnomaly; 4 MotorFault |
| sensor_valid_mask | 0 IMU; 1 GNSS; 2 Magnetometer; 3 Barometer; 4 Airspeed; 5 Terrain |
| autopilot_health | 0 HeartbeatFresh; 1 EkfReportFresh; 2 LinkHealthy; 3 CapabilityVerified |

EKF flags не выводятся из truth и не притворяются ответом FC. Источник —
реальная диагностика autopilot, с mapping для pinned dialect/firmware.
`AutopilotStatusValid=0` означает unknown, даже если ekf_flags=0.
`model_id` локален registry сессии; полные model hash/version хранятся в AAR.
NaN в truth запрещён; невалидное измерение маркируется mask и не подаётся
как валидный sensor sample. Остальные биты и reserved слова равны нулю.

### Pilot mailbox v2 (offset от 49 216)

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | sequence | seqlock |
| 4 | u32 | epoch | expected_session_epoch |
| 8 | f64 | wall ms | sampled_wall_time_ms |
| 16 / 20 / 24 | f32 × 3 | [-1,1] | roll / pitch / yaw |
| 28 | f32 | [0,1] | throttle |
| 32 | u32 | bitmask | bit0 Connected, bit1 Armed |
| 36 | u32 | index | calibrated_mode_slot [0,5], 0xffffffff=unavailable |
| 40 | u32 | custom_mode | requested_mode, 0xffffffff=no request |
| 44 | u32 | generation | device_generation, increment при смене устройства |
| 48 | u32 | publications | input_sample_id |
| 52..63 | u32[3] | — | reserved_zero |

Старый epoch, stale input, неfinite значение, неизвестные flags или
смена device_generation снимают arm. Новая сессия всегда disarmed;
переармирование явное, при газе <=5%. Mode slot не является PWM или
ArduPilot mode number: mapping задаётся профилем FC.

### Представление времени без BigInt-аллокаций в hot path

```ts
export interface TickId { lo: number; hi: number }
export type PhysicsHz = 400 | 800 | 1200;
export type Vec3 = readonly [number, number, number];
export interface FlightStateV2 {
  sampleId: number; tickId: TickId; epoch: number; simTimeS: number;
  northM: number; eastM: number; downM: number;
  qw: number; qx: number; qy: number; qz: number;
  vnMps: number; veMps: number; vdMps: number;
  anMps2: number; aeMps2: number; adMps2: number;
  pRadS: number; qRadS: number; rRadS: number;
  specificForceXBodyMps2: number; specificForceYBodyMps2: number; specificForceZBodyMps2: number;
  trueAirspeedMps: number; batteryVoltage: number; batteryCurrentA: number;
  ambientPressurePa: number; scheduledWallTimeMs: number;
  groundClearanceM: number; referenceRotorRpm: number;
  vehicleFlags: number; ekfFlags: number; ewFlags: number;
  sensorValidMask: number; modelId: number; autopilotMode: number;
  autopilotHealth: number; lastActuatorTick: TickId; autopilotStatusAgeMs: number;
}
export function incrementTickInPlace(t: TickId): void {
  t.lo = (t.lo + 1) >>> 0;
  if (t.lo === 0) t.hi = (t.hi + 1) >>> 0;
}
```

Объекты/arrays этого DTO создаются при init, затем мутируются. В JSON u64
передаётся как `{lo,hi}`, оба uint32. В SAB lo по меньшему адресу.
`simTimeS` вычисляется из tick, не накапливается сложением. Поддерживаемый
предел tick — `<2^53` для точного Number-представления. MAVLink microseconds
вычисляются как `floor(tick*1_000_000/hz)` целочисленно/с remainder:
на 1200 Гц интервалы 833/834 мкс, а не постоянные 833 с накоплением ошибки.
Published по-прежнему u32: новая SAB-сессия до wrap (~41 суток при 1200 Гц).

## 4. Синхронизация: bounded seqlock + overwrite ring

Это single-writer nonblocking transport; формальный wait-free progress
reader не гарантируется при остановке writer на нечётном seq. Reader
возвращает miss за bounded время, writer не ждёт reader. Для ring queue
с обязательной доставкой используются другие правила из следующего раздела.

Ниже готовые алгоритмы для уже выделенных views/scratch. `publishedWord=5`
для v2. Все функции исполняются на владельце области, не параллельно
двумя writers. Scratch не разделяется между потоками.

```ts
export function publishAtomicFrame(
  shared: Int32Array, scratch: Int32Array, baseWord: number, words: number,
): void {
  const seq = Atomics.load(shared, baseWord);
  Atomics.store(shared, baseWord, (seq + 1) | 0); // odd
  for (let i = 1; i < words; i++) {
    Atomics.store(shared, baseWord + i, scratch[i]!);
  }
  Atomics.store(shared, baseWord, (seq + 2) | 0); // even; payload committed
}
export function tryReadAtomicFrame(
  shared: Int32Array, scratch: Int32Array, baseWord: number, words: number,
): boolean {
  const before = Atomics.load(shared, baseWord);
  if (before & 1) return false;
  for (let i = 1; i < words; i++) {
    scratch[i] = Atomics.load(shared, baseWord + i);
  }
  return before === Atomics.load(shared, baseWord);
}
```

Writer state: `count=published>>>0`, `slot=count%capacity`,
`scratch[1]=(count+1)>>>0`, publish frame, затем atomic store published=count+1.
Reader: count>age, slot=(count-1-age)%capacity, read seq/payload/seq в scratch,
проверить head==count и sample_id==count-age; лишь затем decode в output.
До 3 попыток; при miss output не меняется. Нельзя decode до проверки seq.
Для v1 sample_id проверки нет. Запись двух halfwords u64 по отдельности
без seqlock запрещена. Endianness проверяется при init.

Ring history lifetime: 640/320/213,33 мс при 400/800/1200 Гц. Interpolation
только между adjacent ticks одного epoch/model. При reset/смене модели
очистить render history. Полная публикация seq/head обязательна даже при
нулевом числе подключённых render consumers.

## 5. Sensor и actuator SPSC queues

Выделяются **отдельные SAB** для каждого направления, не в state ring.
Physics Worker пишет sensors, I/O Worker читает sensors и пишет actuators;
Physics читает actuators. Main не является вторым consumer этих очередей.
Для AAR producer делает fan-out в отдельную recording queue. Web Serial
requestPort остаётся по Main gesture; I/O использует Worker API/transferable
streams там, где это поддержано браузером. Нельзя привязывать 400 Гц HIL
отправку к Main rAF; fallback требует отдельного измеренного jitter gate.
Один producer и один consumer, capacity=1024, stride=128, размер каждой
`64+1024*128=131136 bytes`. Magic: `0x4d534e53` sensors,
`0x4d414354` actuators; version=2. C ABI payload transport не равен wire
MAVLink: codec выполняет scale/packing/checksum отдельно.

Queue header offsets: 0 magic u32; 4 version u32; 8 stride u32=128;
12 capacity u32=1024; 16 write_counter u32 (producer); 20 read_counter u32
(consumer); 24 full_events u32 (producer); 28 epoch u32 (reset paused);
32..63 reserved_zero. После остановки обоих endpoints reset очищает очередь.

Producer считает unsigned `(write-read)>>>0`. Если =capacity, не перезаписывает
непрочитанное: `would-block` для SITL; fault/invalid session для HITL.
Иначе записывает payload в свободный slot и atomic store write+1.
Consumer после atomic load write копирует весь slot в локальный scratch,
затем atomic store read+1. Producer не переиспользует slot до этого store.
Все shared слова payload также через Atomics. Consumer не декодирует wire
или вызывает callbacks до освобождения copied slot. Counters используют
модульную арифметику; capacity<2^31. Poll bounded per pump.

| Slot Offset | Type | Units | Поле обоих направлений |
| ---: | --- | --- | --- |
| 0 | u32 | enum | kind: sensor 1=IMU,2=GNSS,3=MAG,4=BARO,5=AIRSPEED; actuator 1=frame |
| 4 | u32 | epoch | epoch |
| 8 | u64 | steps | tick_id |
| 16 | u64 | us | sample_time_us / actuator_time_us |
| 24 | u32 | bitmask | validity_flags / actuator_flags (bit0 Armed) |
| 28 | u32 | count | sensor value_count / actuator_count<=16 |
| 32..95 | f32[16] | kind-dependent | values / normalized_actuators |
| 96..119 | f64[3] | GNSS: deg,deg,m MSL | geo_lat_lon_alt; для остальных zero |
| 120 | u32 | index | source_id / motor_map_id |
| 124 | u32 | — | reserved_zero |

Sensor values: IMU count=6: specific force FRD m/s²[0..2], gyro FRD rad/s[3..5];
GNSS count=8: vN/vE/vD m/s, HDOP, VDOP, fix_type, satellites, course rad
(course unavailable отражается flags); MAG count=3: FRD gauss;
BARO count=3: pressure Pa, pressure_alt m, temperature K;
AIRSPEED count=1: differential pressure Pa. Count проверяется по kind;
integer sensor quantities представлены f32 только при exact integer values.
Sensor validity_flags: bit0 PayloadValid, 1 PositionFixValid, 2 CourseValid,
3 TimestampValid, 4 EncodingClipped, 5 SourceStale, 6 HdopValid, 7 VdopValid,
8 VelocityValid, 9 SatellitesValid. Неприменимые биты нули. GNSS без fix
может иметь PayloadValid=1 и PositionFixValid=0: он всё равно передаёт
диагностический no-fix frame. Неизвестный DOP хранится finite placeholder=0
при снятом valid bit, wire encoder выдаёт 65535. VelocityValid=0 даёт
vel=65535, vn/ve/vd=0 и fix_type=0 при MAVLink encoding.
Actuator values [-1,1], интерпретация thrust/surface через motor_map profile;
motor duty после mapping [0,1], не заменять все каналы одной формулой.

## 6. Worker Control Protocol v2

Низкочастотные JSON-команды валидируются из `unknown` в
`packages/protocol/src/control-v2.ts`. Не посылать их на каждом physics tick.
Init остаётся structured clone, содержащим SAB: он **не JSON**.
Wire external WS/MAVLink имеет собственные schemas/authentication.

```ts
export type EwEffect =
  | { kind: 'gnss-jamming'; severity: number }
  | { kind: 'position-step'; offsetNedM: Vec3 }
  | { kind: 'velocity-drift'; accelerationNedMps2: Vec3; maxSpeedMps: number }
  | { kind: 'magnetic'; rotationRad: Vec3; biasBodyGauss: Vec3 }
  | { kind: 'motor-loss'; motorIndex: number; mode: 'power-cut' | 'instant-thrust-loss'; remainingThrustFraction: number };
export interface EnvelopeV2 {
  protocolVersion: 2; requestId: number; expectedEpoch: number;
}
export type ScheduledCommandV2 = EnvelopeV2 & { atTick: TickId } & (
  | { type: 'weather.set'; windNedMps: Vec3; temperatureK: number;
      pressurePa: number; turbulenceRmsMps: number; seed: number }
  | { type: 'fault.set'; faultId: string; enabled: boolean; effect: EwEffect;
      recovery: 'hold-offset' | 'step-to-truth' }
);
export type LifecycleCommandV2 = EnvelopeV2 & (
  | { type: 'sim.start' | 'sim.pause' | 'worker.dispose' }
  | { type: 'sim.reset'; seed: number }
  | { type: 'sim.configure'; hz: PhysicsHz; clockMode: 'interactive' | 'sitl-lockstep' | 'hitl-realtime' }
  | { type: 'model.load'; modelId: number; manifestSha256: string }
);
export type ControlCommandV2 = ScheduledCommandV2 | LifecycleCommandV2;
export interface WorkerInitV2 {
  type: 'init-v2'; protocolVersion: 2; stateBuffer: SharedArrayBuffer;
  sensorBuffer: SharedArrayBuffer; actuatorBuffer: SharedArrayBuffer;
}
export type CommandResultV2 =
  | { type: 'ready-v2'; protocolVersion: 2; abiVersion: 2; epoch: number; hz: PhysicsHz }
  | { type: 'ack-v2'; requestId: number; status: 'queued' | 'applied';
      epoch: number; appliedTick: TickId }
  | { type: 'reject-v2'; requestId: number; code: 'SCHEMA' | 'STALE_EPOCH' |
      'BAD_STATE' | 'OUT_OF_RANGE' | 'ASSET_MISSING' | 'OVERLOAD'; message: string };
```

Контракт runtime validation (нормативный, TASK-010 реализует JSON Schema
2020-12 + валидатор и equivalence tests с этими TS types):

* Все objects `additionalProperties:false`, все поля выбранной ветви required.
  Discriminator `type`, вложенный `effect.kind`; запрещены NaN/Infinity,
  undefined и нецелые значения для integer fields. Payload <=16 KiB.
* protocolVersion const=2; requestId/expectedEpoch/tick halves/modelId/seed
  integer [0,4294967295]. Request IDs строго возрастают за жизнь Worker,
  включая смены epoch; до wrap нужен новый Worker. Cache последних 128 IDs
  хранит исходный payload и последний результат. Точный повтор возвращает
  cached ACK/reject без применения; тот же ID с другим payload отвергается.
  Для ID<=high-water mark, уже вытесненного из cache, вернуть BAD_STATE.
  Dedup проверяется до expectedEpoch, чтобы повтор reset получил прежний
  результат. Это позволяет bounded cache без бесконечного множества IDs.
* Vec3 — array ровно из 3 finite numbers. Wind components [-100,100] m/s;
  temperature [200,340] K, pressure [30000,110000] Pa;
  turbulenceRms [0,30] m/s. Density выводится из атмосферы, не задаётся вторым
  противоречивым полем. Эти пределы — envelope модели, не климата Земли.
* faultId `[A-Za-z0-9_-]{1,64}`; manifestSha256 ровно 64 hex chars.
  severity/remainingThrustFraction [0,1], motor mode из указанного enum,
  motorIndex integer [0,31] и <rotorCount;
  offset components [-10000,10000] m, drift acceleration components [-0.3,0.3]
  m/s² и norm<=0.3; maxSpeed (0,20] m/s; magnetic rotation components [-pi,pi],
  bias components [-2,2] gauss. Новые диапазоны требуют изменения spec/tests.
* Scheduled command atTick >= next unintegrated tick, horizon <=10 s.
  Применять **перед** интеграцией указанного tick; одинаковый tick — порядок
  приёма, записанный в AAR. Past tick не переписывает историю.
  Приём/валидация создают command record вне hot path; применение копирует
  scalar state из preallocated slots. ACK/events идут в bounded outbox и
  отправляются postMessage после compute batch, без аллокаций внутри step.
* `queued` — принято, но не применено; appliedTick в queued — плановый tick,
  в applied — фактический. Нужен финальный applied/reject для каждого queued.
  Очередь максимум 128 команд, overflow отклоняется без потери старых.
* Pause/dispose обслуживаются вне fixed-step и без ожидания actuator.
  Reset/configure/model.load допустимы paused+disarmed. Они отменяют queued
  команды с reject BAD_STATE, сбрасывают clocks/history/queues и увеличивают
  epoch. ACK содержит новый epoch; команды со старым expectedEpoch отвергаются.
* Model manifest заранее загружен/проверен по hash вне hot path. Подготовка
  backend выполняется paused; swap только после успешной проверки/инициализации.
  Ошибка сохраняет предыдущую модель в paused состоянии, без partial swap.
* Runtime command не меняет terrain licensing, секреты или домены сети.
* Детали реализации (TASK-010, `ControlProcessorV2`): команда, отклонённая
  при проверке (SCHEMA или OUT_OF_RANGE, найденный при проверке полей), не
  расходует свой requestId и не попадает в кэш; её reject сообщает полученный
  requestId, если это uint32, иначе -1. ACK lifecycle-команды сообщает
  последний проинтегрированный tick той epoch, в которой она применена (0
  после reset/configure/смены модели). `model.load` сначала возвращает
  `queued`, затем итоговый `applied` (новая epoch), `ASSET_MISSING` или
  `BAD_STATE`; пока загрузка не завершена, все прочие команды, кроме
  `worker.dispose`, отклоняются с BAD_STATE. Отменённые команды отклоняются
  в порядке их срока. JSON Schema не может выразить лимит 16 KiB и ограничение
  нормы дрейфа; оба проверяет валидатор TypeScript.
* Backend, который не может моделировать запланированную команду, отклоняет её
  при приёме с BAD_STATE и причиной (`ControlTargetV2.unsupportedReason`);
  demo backend не имеет модели атмосферы или EW, поэтому отклоняет каждую
  команду `weather.set` и `fault.set`. Вне потока команд/результатов Worker
  сообщает о fault сессии (например, неудачном `init-v2` или превышении сроков
  HITL) как `{ type: 'fault-v2', protocolVersion: 2, message }`. Main проверяет
  каждое сообщение Worker (`parseWorkerEventV2`) и игнорирует неизвестные;
  Worker проверяет `init-v2` по форме и по layout каждого буфера.

Пример валидного JSON (время 1 секунда при 400 Гц):

```json
{
  "protocolVersion": 2,
  "requestId": 17,
  "expectedEpoch": 1,
  "atTick": { "lo": 400, "hi": 0 },
  "type": "fault.set",
  "faultId": "training-drift",
  "enabled": true,
  "effect": { "kind": "velocity-drift", "accelerationNedMps2": [0.1, 0, 0], "maxSpeedMps": 2 },
  "recovery": "hold-offset"
}
```

## 7. Приёмка протокола

TASK-008/009: exhaustive offset/size/alignment tests; golden byte vectors;
v1 rejection/v2 negotiation; tick carry; epoch/reset/interpolation;
worker concurrency stress 1e6 publications без torn/NaN frames; interrupted
writer возвращает miss, output неизменен; full/empty queues и counter wrap.
TASK-010: positive/negative fixture для каждой ветви, late/duplicate/out-of-order
ACK, очередь 128+1, stale epoch, atomic model swap failure. TASK-014:
pack/read step без JS/WASM allocations после init, измерение отдельно от
timer callback allocations браузера. Все новые contract tests автоматические;
показать статус «не запущено», если модуль/оборудование ещё отсутствуют.


## Отдельный транспорт AAR (TASK-076)

Транспорт записи — отдельный SAB 131,136 байт: заголовок 64 байта и 256 слотов по 512 байт. Magic/версия/счётчики записи/чтения/потерь занимают байты 0/4/8/12/16; остальные слова заголовка нулевые. Все общие слова — атомарные int32; float-данные кодируются в локальной памяти. Счётчик записи публикуется после копирования записи, счётчик чтения освобождается после копирования наружу. Модульные счётчики различают полную/пустую очередь; переполнение отбрасывает новый отсчёт и увеличивает потери без блокировки физики. Второго потребителя полётных очередей датчиков/актуаторов нет. Полётные буферы ABI-v2 и их владение не меняются. Полная раскладка записи/архива AAR, provenance, CRC/SHA-256, ёмкость и ограничения воспроизведения описаны в [Simulation Engines](SPECS_SIMULATION_ENGINES.md). Текущий производитель demo использует прореживание Main; полное подключение рабочего производителя высокой частоты остаётся отдельной интеграцией.

## Граница нативного допуска TASK-043

Нативный LiveEkfWarmup получает настоящую диагностику firmware и явное
происхождение часов сенсоров без добавления SAB-полей или изменения
смещений/флагов ABI v2. Нормализованные биты EKF сохраняют прежний смысл.
Нативное решение READY/РЭБ ограничено сессией/эпохой external-SITL; оно не
публикуется автоматически в demo Worker. Браузерный AutopilotStatusValid
остаётся сброшенным в этой публикации. Копия HUD на Main может установить его
по привязанному к идентификатору снимку EkfMonitor, эпоха которого совпадает
с отображаемым состоянием полёта. Подключение Serial не публикует этот флаг
в SAB и не допускает браузерный READY. Тайминги/отзыв описаны в спецификации двигателя;
записанный Simulation-on-Hardware версии 2 не допускает fast-forward.
