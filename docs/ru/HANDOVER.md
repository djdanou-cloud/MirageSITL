# HANDOVER.md — Передача работы агенту (`TASK-074`)

<!-- source-sha256: f9b47498cdc04355e42e7e6c5bb68368b7cb20d7fcb14b0903a0f51761bf86eb -->

Английский источник: [Source of truth](../../HANDOVER.md).

Дата: 2026-10-20 · Предыдущий baseline: `d4dda82` (`origin/main`) · Активная задача: `TASK-074 — Pilot HUD and freshness` (`DONE`).

Сначала прочитайте [CLAUDE.md](CLAUDE.md), затем раздел `TASK-074` в [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md).

---

## 1. Текущее состояние и что уже выполнено

1. **Очистка документации (`d56c890`, отправлено в `origin/main`):**
   - Консолидированы все 18 двуязычных пар документации, удалены 6 устаревших файлов снимков от `2026-10-17` и задокументирована первопричина частоты `516.7 Hz` / `519.6 Hz` в realtime-прогоне `bench-physics` на Windows Node (квант таймера Windows `~16 ms` $\times$ `DEFAULT_MAX_CATCH_UP = 8`).
2. **`TASK-074` переведена в статус `IN_PROGRESS` в [PROJECT_ROADMAP.md](../PROJECT_ROADMAP.md) и [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md):**
   - В `Touched Files` добавлены `apps/web/src/SerialConnect.tsx`, `HANDOVER.md`, `docs/ru/HANDOVER.md` и `docs/documentation-index.json`.
3. **Реализована и покрыта юнит-тестами функция `applyAutopilotTelemetry` в [apps/web/src/hud/telemetry.ts](../../apps/web/src/hud/telemetry.ts) и [tests/hud.test.ts](../../tests/hud.test.ts):**
   - `applyAutopilotTelemetry(state: FlightStateV2, status: EkfStatus | null, lastKnownMode?: number): void` накладывает привязанный к идентификатору снимок `EkfMonitor` на `FlightStateV2` на месте:
     - Истина demo (`status === null` или отсутствие принятого кадра на совпадающей эпохе `state.epoch`) сбрасывает `VehicleFlagV2.AutopilotStatusValid`, `ekfFlags`, `autopilotHealth`, `autopilotStatusAgeMs` и устанавливает `autopilotMode = UNKNOWN_U32`.
     - Когда на текущей эпохе принят кадр автопилота, функция выставляет `VehicleFlagV2.AutopilotStatusValid`, заполняет `AutopilotHealthV2` (`HeartbeatFresh | EkfReportFresh | LinkHealthy`), сохраняет `lastKnownMode` при `status.mode === null` (устаревший heartbeat) и ограничивает `state.ekfFlags = status.innovationHealthy ? status.flags : 0`, чтобы проваленные отношения инноваций ($\ge 1.0$) или `EKF_UNINITIALIZED` (`1024`) никогда не отображали `"EKF flags valid"` (`ekfFlags === 31`) в `PilotHud`.
   - Проверено командой `npx --no-install vitest run tests/hud.test.ts` (`3 passed`).
4. **Живой аппаратный опрос подключённого полётного контроллера (`COM21`):**
   - Подключённое устройство: `ArduPilot (COM21)`, `USB\VID_1209&PID_5741\2D002C000C51333332393236` (ArduPilot `4.6.3` `3fc7011a`, `systemId = 1`, `componentId = 1`, разоружён на питании от USB без батареи и без GPS в помещении).
   - **Ключевой вывод:** В пассивном режиме `SERIAL0` выдаёт только `HEARTBEAT` (`id = 0`, `custom_mode = 0`) с частотой 1 Гц и **не** отправляет `EKF_STATUS_REPORT` (`id = 193`), пока его не запросят через read-only команду `MAV_CMD_REQUEST_MESSAGE (512)` для сообщения с ID `193`.
   - Отправка 41-байтного пакета MAVLink2 `COMMAND_LONG (76)` для `MAV_CMD_REQUEST_MESSAGE (512, param1 = 193)` заставляет `COM21` немедленно вернуть `EKF_STATUS_REPORT (193)` с сырыми флагами `167` (`1 | 2 | 4 | 32 | 128`), которые `EkfMonitor` отображает в `EkfFlagV2` `23` (`AttitudeValid | HorizontalVelocityValid | VerticalVelocityValid | AbsoluteVerticalPositionValid`, без `AbsoluteHorizontalPositionValid = 8` в помещении) и `innovationHealthy: true`.
   - Захват длительностью 3.5 с (`169` принятых кадров `HEARTBEAT` + `EKF_STATUS_REPORT`) сохранён локально в `test-results/hardware/serial-com21-ardupilot-ekf.json`.

---

## 2. Примечания по окружению (хост Windows 11)

- **Worktree и основной checkout:**
  - Этот коммит находится в ветке `analyze_repo_next_task` в worktree `C:\Users\djdan\.gemini\antigravity\worktrees\MirageSITL\analyze_repo_next_task`.
  - Основной checkout расположен в `C:\Users\djdan\OneDrive\Desktop\MirageSITL`.
- **Путь к бинарному файлу Node 24 на этой машине:**
  - Запись `C:\Users\djdan\AppData\Local\node` в пользовательском `PATH` виртуализирована внутри MSIX-пакета Claude:
    `C:\Users\djdan\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\node`
  - Добавляйте её в начало `$env:Path` в PowerShell, если `node` не находится:

```powershell
$env:Path = "C:\Users\djdan\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\node;$env:USERPROFILE\.cargo\bin;$env:Path"
```

---

## 3. Выполненные шаги реализации `TASK-074`

Эти шаги реализованы в основном checkout. Подключение Serial по-прежнему не допускает браузерный READY или HITL. Публикация Worker физики оставляет поля автопилота неизвестными.

### Шаг 1 — Подключить `EkfMonitor` в `SimulationRuntime` ([apps/web/src/runtime.ts](../../apps/web/src/runtime.ts))
- Импортировать `EkfMonitor` из `@mirage/autopilot/ekf-status`, `type MavFrame` из `@mirage/mavlink/codec` и `applyAutopilotTelemetry` из `./hud/telemetry`.
- Хранить предварительно выделенный рабочий буфер `MavFrame` (`payload = new Uint8Array(255)`, `view = new DataView(payload.buffer)`), `private ekfMonitor = new EkfMonitor(1, 1, 1, 1000)`, `private lastAutopilotMode = UNKNOWN_U32` и `private autopilotActive = false`.
- При смене `this.epoch` (или при вызове `clearAutopilotStatus()` при отключении последовательного порта) сбрасывать `this.ekfMonitor = new EkfMonitor(1, 1, this.epoch, 1000)`, `this.lastAutopilotMode = UNKNOWN_U32`, `this.autopilotActive = false` и вызывать `applyAutopilotTelemetry(this.current, null)`.
- Добавить метод `ingestSerialFrame(data: unknown, receivedMs = wallNow()): boolean`:
  - Проверять, что `data` является объектом с `type === "serial.frame"`, целочисленными `id`, `systemId`, `componentId`, `sequence` и `payload instanceof Uint8Array` (`payload.byteLength <= 255`).
  - Проверять `this.ekfMonitor.epoch === this.current.epoch` (пересоздавать `EkfMonitor`, если эпоха продвинулась).
  - Копировать `payload` в рабочий `MavFrame` и вызывать `this.ekfMonitor.ingest(this.ekfFrame, receivedMs)`.
  - Если кадр принят: выставлять `this.autopilotActive = true`, обновлять `this.lastAutopilotMode` при `status.mode !== null` и вызывать `this.syncAutopilotTelemetry(receivedMs)`.
- Добавить метод `private syncAutopilotTelemetry(nowMs = wallNow()): void`:
  - Вызывать `applyAutopilotTelemetry(this.current, this.autopilotActive ? this.ekfMonitor.snapshot(nowMs) : null, this.lastAutopilotMode)`.
- В `frame = (now: number) =>` вызывать `this.syncAutopilotTelemetry(wallNow())` сразу после `this.reader.latestPair(this.current, this.previous)` (даже если `read === "none"` на паузе), чтобы `this.current` всегда отражал актуальную свежесть/устаревание автопилота на прореженной частоте `this.report(...)` раз в 150 мс.

### Шаг 2 — Пересылать `serial.frame` и опрашивать read-only `EKF_STATUS_REPORT` в [apps/web/src/SerialConnect.tsx](../../apps/web/src/SerialConnect.tsx)
- Принимать необязательные свойства `{ onFrame?: (frame: unknown) => void; onDisconnect?: () => void }`.
- Определить read-only 41-байтный запрос MAVLink2 `COMMAND_LONG (76)` для `MAV_CMD_REQUEST_MESSAGE (512, param1 = 193)` (`EKF_STATUS_REPORT`):

```ts
const REQUEST_EKF_STATUS_REPORT = new Uint8Array([
  253, 33, 0, 0, 1, 255, 190, 76, 0, 0,
  0, 64, 193, 67, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
  1, 1, 0, 152, 183,
]);
```

- В `worker.onmessage`, когда `data.type === "serial.frame"`:
  - Увеличивать `frames++` и вызывать `onFrame?.(data)`.
  - Если `"id" in data && data.id === 0` (`HEARTBEAT`), отмечать `seenHeartbeat = true`.
- В интервале `displayTimer` (150 мс, пока `transport.status === "open"` и `seenHeartbeat` истинно) отправлять `void transport.write(REQUEST_EKF_STATUS_REPORT).catch(() => undefined)` не чаще одного раза в 250 мс, чтобы физические USB-порты ArduPilot (`SERIAL0`) выдавали `EKF_STATUS_REPORT (193)` наряду с `HEARTBEAT (0)`.
- В `disconnect()` вызывать `onDisconnect?.()`, чтобы `SimulationRuntime.clearAutopilotStatus()` возвращал HUD в состояние `DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN`.

### Шаг 3 — Связать `<SerialConnect />` и нижнюю карточку HUD в [apps/web/src/App.tsx](../../apps/web/src/App.tsx)
- Импортировать `hudTelemetry` из `./hud/telemetry`.
- Вычислять `const hud = runtime.current ? hudTelemetry(runtime.current.current) : null;` при рендере.
- В блоке `.flight-mode` (около строки 335):
  - Отображать `hud?.source === "autopilot" ? hud.mode : "DIRECT RATE"` в `<strong>`.
  - Отображать `hud?.source === "autopilot" ? (hud.status === "fresh" ? "Autopilot telemetry live" : "Autopilot telemetry stale") : "ArduPilot disconnected"` в `<span>`.
- Передавать `onFrame={(frame) => runtime.current?.ingestSerialFrame(frame)}` и `onDisconnect={() => runtime.current?.clearAutopilotStatus()}` в `<SerialConnect />`.

### Шаг 4 — Расширить браузерный E2E-тест в [tests/browser/hud.spec.ts](../../tests/browser/hud.spec.ts)
- Сохранить существующий тест происхождения demo.
- Добавить второй тест, который устанавливает мок-порт `navigator.serial` перед `page.goto("/")` и подаёт реальные кадры MAVLink2 с валидной CRC — `HEARTBEAT` (`id = 0`, `mode = 5`) и `EKF_STATUS_REPORT` (`id = 193`, деградированный `flags = 167 -> 23` и валидный `flags = 55 -> 31`) из `tests/fixtures/mavlink/ekf-golden.json` — через реальный `serial-io.worker.ts`:
  - Проверить переход `hud-ap-status` из `DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN` $\rightarrow$ `AP MODE 5 · FRESH · <age> ms` с `EKF DEGRADED` (`flags = 23`), затем `EKF flags valid` (`flags = 31`).
  - Приостановить поток более чем на $1100\text{ ms}$ и проверить переход `hud-ap-status` в `STALE` и `EKF STALE`.
  - Проверить, что обновления React на `hud-ap-status` остаются прореженными ($\le 12$ мутаций DOM за окно 1000 мс, а не 400–1200 Гц).
  - Нажать `Disconnect serial` и проверить возврат `hud-ap-status` к `DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN`.

### Шаг 5 — Контрольные проверки и синхронизация документации
- Выполнить:

```powershell
npx --no-install vitest run tests/hud.test.ts tests/session-v2.test.ts
npm run typecheck
npm run lint
npm run build
npx --no-install playwright test tests/browser/hud.spec.ts tests/browser/serial-permission.spec.ts tests/browser/instructor.spec.ts
node scripts/check-docs.mjs
git diff --check
```

- Обновить статус `TASK-074` на `DONE` в [PROJECT_ROADMAP.md](../PROJECT_ROADMAP.md) и [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md), а также синхронизировать ссылки на статус в [README.md](../../README.md), [CLAUDE.md](../../CLAUDE.md), [SPECS_SIMULATION_ENGINES.md](../SPECS_SIMULATION_ENGINES.md), [architecture.md](../architecture.md), [V2_PLAN.md](../V2_PLAN.md) и их русских зеркалах в `docs/ru/`.
