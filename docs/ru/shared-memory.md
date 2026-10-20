# SharedArrayBuffer ABI v1

<!-- source-sha256: 264bae56abaa261ed218a8a2b4f60851bb3c7e88f8bcfb1a9682661e2bdc215d -->

Английский источник: [Source of truth](../shared-memory.md). Изменения спецификации обновляют оба языка в одной задаче.


Этот документ — отдельная сводка унаследованного **ABI v1**, который сохраняется в `packages/protocol/src/index.ts` для регрессионных тестов и дублируется разделом 2 в [SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md). Работающее приложение использует **ABI v2** и Control Protocol v2 (TASK-085), заданные в [SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md).

Типизированный источник: [`packages/protocol/src/index.ts`](../../packages/protocol/src/index.ts).
Main создаёт SAB и передаёт в Worker через structured clone **без transfer
list**. Нужны secure context, COOP/COEP и `crossOriginIsolated=true`.
Проверяются byteLength/magic/version/размеры. В ABI нет ссылок JS/WASM.

## Layout

Индексы ниже — слова по 4 bytes. Размер:
`64 + 256 × 128 + 64 = 32 896 bytes`. Float payload пакуется через локальный
scratch DataView little-endian на целевых платформах; shared-память читается
и пишется **только Atomics над Int32Array**, включая оба слова float64.

| Область | Byte offset | Bytes | Writer |
| --- | ---: | ---: | --- |
| Header | 0 | 64 | Main init; Worker counters |
| State ring [256] | 64 | 32 768 | Worker |
| Control mailbox | 32 832 | 64 | Main |

### Header

| Word | Тип | Значение |
| --- | --- | --- |
| 0 | u32 | magic `0x4d534954` |
| 1 / 2 / 3 | u32 | version=1 / capacity=256 / stateWords=32 |
| 4 | u32 | Published, число кадров; 0=пусто |
| 5 | u32 | Overruns, события превышения catch-up budget |
| 6 | u32 | DroppedSteps, отброшенные wall-clock интервалы |
| 7–15 | reserved | нули |

Reset обнуляет tick/simTime/диагностику, но не Published. ABI v1 требует
перезапуска сессии до wrap 32-bit Published/tick (~124 суток при 400 Гц).

### State slot — 128 bytes

| Word | Тип | Поле |
| --- | --- | --- |
| 0 | i32 | seqlock: нечётный=запись, чётный=завершено |
| 1 | u32 | tick, интеграции после reset |
| 2–3 | f64 | simTime, s |
| 4–5 / 6–7 / 8–9 | 3×f64 | north/east/down, m |
| 10–13 | 4×f32 | quaternion w,x,y,z, FRD -> NED |
| 14–16 | 3×f32 | vn/ve/vd, m/s |
| 17–19 | 3×f32 | an/ae/ad, m/s², инерциальное ускорение NED включая gravity |
| 20–22 | 3×f32 | p/q/r body angular rates, rad/s |
| 23 | f32 | spool [0,1], demo collective response |
| 24 | f32 | batteryVoltage, V, demo estimate |
| 25 | u32 | bit0 OnGround, bit1 InputFailsafe (включает disarmed) |
| 26–27 | f64 | wallTimeMs, timeOrigin + scheduled deadline |
| 28–31 | reserved | нули |

### Control mailbox — 64 bytes

| Word | Тип | Поле |
| --- | --- | --- |
| 0 | i32 | seqlock |
| 1 | reserved | ноль |
| 2–3 | f64 | wallTimeMs, фактическое время опроса Main |
| 4 / 5 / 6 | 3×f32 | roll/pitch/yaw [-1,1] |
| 7 | f32 | throttle [0,1] |
| 8 | u32 | bit0 Connected, bit1 Armed |
| 9–15 | reserved | нули |

Последнее значение побеждает; нет очереди устаревших стиков. Worker
повторно проверяет finite/range, flags и возраст [0,250] мс. При contention
сохраняет последний целый input, который естественно устаревает.

## Публикация

Один writer на область: Worker не пишет controls, Main не пишет state.
State writer выбирает `slot=Published%256`, ставит нечётный seq, пишет
payload атомарными store, ставит чётный seq, затем увеличивает Published.
Reader проверяет чётный seq, копирует слова атомарными load в собственный
scratch и снова проверяет seq/Published. Только при успехе декодирует
scratch в output. Неудачное чтение не мутирует output. Максимум 3 попытки,
затем предыдущий кадр; writer никогда не ждёт renderer.

`latest(out,age)` допускает историю до 255 кадров. Два вызова не являются
одной транзакцией: renderer проверяет соседство tick, иначе показывает
последний кадр. Прямой конкурентный доступ к shared Float64Array запрещён:
одного seqlock недостаточно против разорванных float64. Все слова payload
атомарны; ABA после полного wrap не поддерживается длительностью сессии.

## Lifecycle

```ts
type MainToPhysics =
  | { type: 'init'; version: 1; buffer: SharedArrayBuffer }
  | { type: 'start' | 'pause' | 'reset' | 'dispose'; requestId: number };
type PhysicsToMain =
  | { type: 'ready'; version: 1; hz: 400 }
  | { type: 'ack'; command: 'start' | 'pause' | 'reset' | 'dispose'; requestId: number }
  | { type: 'error'; message: string };
```

Init публикует начальное состояние и ready, оставляет Worker paused.
Start идемпотентен, не сбрасывает модель. Pause останавливает шаги.
Reset также останавливает цикл и обнуляет модель/диагностику. Dispose
возвращает ACK и закрывает Worker. RequestId связывает ACK с командой UI.
Ошибки останавливают цикл. При unmount Main вправе terminate сразу.

Это доверенный внутрипроцессный API, не сетевой протокол авторизации.
TypeScript не заменяет runtime validation будущих WS/MAVLink сообщений.
Изменение порядка/единиц/полей требует нового ABI_VERSION; несовпадение
блокирует запуск, не преобразуется молча.
