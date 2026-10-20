# HANDOVER.md — Agent Handover (`TASK-074`)

English source of truth. [Russian mirror](docs/ru/HANDOVER.md).

Date: 2026-10-20 · Previous baseline: `d4dda82` (`origin/main`) · Active task: `TASK-074 — Pilot HUD and freshness` (`DONE`).

Read [CLAUDE.md](CLAUDE.md) first, then the `TASK-074` section in [docs/PROJECT_ROADMAP.md](docs/PROJECT_ROADMAP.md).

---

## 1. Current State & What Was Completed

1. **Documentation cleanup (`d56c890`, pushed to `origin/main`):**
   - Consolidated all 18 bilingual documentation pairs, removed the 6 superseded `2026-10-17` snapshot files, and documented the root cause of the `516.7 Hz` / `519.6 Hz` Windows Node `bench-physics` realtime step rate (`~16 ms` Windows timer quantum $\times$ `DEFAULT_MAX_CATCH_UP = 8`).
2. **`TASK-074` marked `IN_PROGRESS` in [docs/PROJECT_ROADMAP.md](docs/PROJECT_ROADMAP.md) and [docs/ru/PROJECT_ROADMAP.md](docs/ru/PROJECT_ROADMAP.md):**
   - Added `apps/web/src/SerialConnect.tsx`, `HANDOVER.md`, `docs/ru/HANDOVER.md`, and `docs/documentation-index.json` to `Touched Files`.
3. **Implemented & unit-tested `applyAutopilotTelemetry` in [apps/web/src/hud/telemetry.ts](apps/web/src/hud/telemetry.ts) and [tests/hud.test.ts](tests/hud.test.ts):**
   - `applyAutopilotTelemetry(state: FlightStateV2, status: EkfStatus | null, lastKnownMode?: number): void` maps an identity-bound `EkfMonitor` snapshot onto `FlightStateV2` in place:
     - Demo truth (`status === null` or no observed frame on matching `state.epoch`) clears `VehicleFlagV2.AutopilotStatusValid`, `ekfFlags`, `autopilotHealth`, `autopilotStatusAgeMs`, and sets `autopilotMode = UNKNOWN_U32`.
     - When an autopilot frame has been observed on the current epoch, sets `VehicleFlagV2.AutopilotStatusValid`, populates `AutopilotHealthV2` (`HeartbeatFresh | EkfReportFresh | LinkHealthy`), preserves `lastKnownMode` when `status.mode === null` (stale heartbeat), and gates `state.ekfFlags = status.innovationHealthy ? status.flags : 0` so failed innovation ratios ($\ge 1.0$) or `EKF_UNINITIALIZED` (`1024`) never display `"EKF flags valid"` (`ekfFlags === 31`) in `PilotHud`.
   - Verified with `npx --no-install vitest run tests/hud.test.ts` (`3 passed`).
4. **Live Hardware Probe on Connected Flight Controller (`COM21`):**
   - Connected device: `ArduPilot (COM21)`, `USB\VID_1209&PID_5741\2D002C000C51333332393236` (ArduPilot `4.6.3` `3fc7011a`, `systemId = 1`, `componentId = 1`, disarmed on USB power without battery or indoor GPS).
   - **Key finding:** Passively, `SERIAL0` only emits `HEARTBEAT` (`id = 0`, `custom_mode = 0`) at 1 Hz and does **not** emit `EKF_STATUS_REPORT` (`id = 193`) unless polled via read-only `MAV_CMD_REQUEST_MESSAGE (512)` for message ID `193`.
   - Sending the 41-byte MAVLink2 `COMMAND_LONG (76)` packet for `MAV_CMD_REQUEST_MESSAGE (512, param1 = 193)` causes `COM21` to immediately return `EKF_STATUS_REPORT (193)` with raw flags `167` (`1 | 2 | 4 | 32 | 128`), which `EkfMonitor` maps to `EkfFlagV2` `23` (`AttitudeValid | HorizontalVelocityValid | VerticalVelocityValid | AbsoluteVerticalPositionValid`, missing `AbsoluteHorizontalPositionValid = 8` indoors) and `innovationHealthy: true`.
   - A 3.5 s timed capture (`169` ingested `HEARTBEAT` + `EKF_STATUS_REPORT` frames) is saved locally at `test-results/hardware/serial-com21-ardupilot-ekf.json`.

---

## 2. Environment Notes (Windows 11 Host)

- **Worktree vs Main Checkout:**
  - This commit is on branch `analyze_repo_next_task` in worktree `C:\Users\djdan\.gemini\antigravity\worktrees\MirageSITL\analyze_repo_next_task`.
  - The main checkout is at `C:\Users\djdan\OneDrive\Desktop\MirageSITL`.
- **Node 24 Binary Path on This Machine:**
  - The User `PATH` entry `C:\Users\djdan\AppData\Local\node` is virtualized inside the MSIX Claude package:
    `C:\Users\djdan\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\node`
  - Prepend it in PowerShell if `node` is not found:

```powershell
$env:Path = "C:\Users\djdan\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\node;$env:USERPROFILE\.cargo\bin;$env:Path"
```

---

## 3. Completed implementation steps for `TASK-074`

These steps are implemented in the main checkout. A serial connection still does not admit browser READY or HITL. The physics Worker publication keeps autopilot fields unknown.

### Step 1 — Wire `EkfMonitor` into `SimulationRuntime` ([apps/web/src/runtime.ts](apps/web/src/runtime.ts))
- Import `EkfMonitor` from `@mirage/autopilot/ekf-status`, ` type MavFrame` from `@mirage/mavlink/codec`, and `applyAutopilotTelemetry` from `./hud/telemetry`.
- Hold a preallocated scratch `MavFrame` (`payload = new Uint8Array(255)`, `view = new DataView(payload.buffer)`), `private ekfMonitor = new EkfMonitor(1, 1, 1, 1000)`, `private lastAutopilotMode = UNKNOWN_U32`, and `private autopilotActive = false`.
- When `this.epoch` changes (or when `clearAutopilotStatus()` is called on serial disconnect), reset `this.ekfMonitor = new EkfMonitor(1, 1, this.epoch, 1000)`, `this.lastAutopilotMode = UNKNOWN_U32`, `this.autopilotActive = false`, and call `applyAutopilotTelemetry(this.current, null)`.
- Add `ingestSerialFrame(data: unknown, receivedMs = wallNow()): boolean`:
  - Validate that `data` is an object with `type === "serial.frame"`, integer `id`, `systemId`, `componentId`, `sequence`, and `payload instanceof Uint8Array` (`payload.byteLength <= 255`).
  - Ensure `this.ekfMonitor.epoch === this.current.epoch` (re-create `EkfMonitor` if epoch advanced).
  - Copy `payload` into the scratch `MavFrame` and call `this.ekfMonitor.ingest(this.ekfFrame, receivedMs)`.
  - If accepted: set `this.autopilotActive = true`, update `this.lastAutopilotMode` when `status.mode !== null`, and call `this.syncAutopilotTelemetry(receivedMs)`.
- Add `private syncAutopilotTelemetry(nowMs = wallNow()): void`:
  - Call `applyAutopilotTelemetry(this.current, this.autopilotActive ? this.ekfMonitor.snapshot(nowMs) : null, this.lastAutopilotMode)`.
- In `frame = (now: number) =>`, call `this.syncAutopilotTelemetry(wallNow())` right after `this.reader.latestPair(this.current, this.previous)` (even if `read === "none"` while paused) so `this.current` always has up-to-date autopilot freshness/staleness on the decimated 150 ms `this.report(...)` cadence.

### Step 2 — Forward `serial.frame` and Poll Read-Only `EKF_STATUS_REPORT` in [apps/web/src/SerialConnect.tsx](apps/web/src/SerialConnect.tsx)
- Accept optional props `{ onFrame?: (frame: unknown) => void; onDisconnect?: () => void }`.
- Define the read-only 41-byte MAVLink2 `COMMAND_LONG (76)` request for `MAV_CMD_REQUEST_MESSAGE (512, param1 = 193)` (`EKF_STATUS_REPORT`):

```ts
const REQUEST_EKF_STATUS_REPORT = new Uint8Array([
  253, 33, 0, 0, 1, 255, 190, 76, 0, 0,
  0, 64, 193, 67, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
  1, 1, 0, 152, 183,
]);
```

- In `worker.onmessage`, when `data.type === "serial.frame"`:
  - Increment `frames++` and call `onFrame?.(data)`.
  - If `"id" in data && data.id === 0` (`HEARTBEAT`), record `seenHeartbeat = true`.
- In the 150 ms `displayTimer` interval (while `transport.status === "open"` and `seenHeartbeat` is true), send `void transport.write(REQUEST_EKF_STATUS_REPORT).catch(() => undefined)` at most once every 250 ms so physical ArduPilot USB ports (`SERIAL0`) emit `EKF_STATUS_REPORT (193)` alongside `HEARTBEAT (0)`.
- In `disconnect()`, call `onDisconnect?.()` so `SimulationRuntime.clearAutopilotStatus()` returns the HUD to `DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN`.

### Step 3 — Connect `<SerialConnect />` and Bottom HUD Card in [apps/web/src/App.tsx](apps/web/src/App.tsx)
- Import `hudTelemetry` from `./hud/telemetry`.
- Compute `const hud = runtime.current ? hudTelemetry(runtime.current.current) : null;` during render.
- In `.flight-mode` (around line 335):
  - Display `hud?.source === "autopilot" ? hud.mode : "DIRECT RATE"` in `<strong>`.
  - Display `hud?.source === "autopilot" ? (hud.status === "fresh" ? "Autopilot telemetry live" : "Autopilot telemetry stale") : "ArduPilot disconnected"` in `<span>`.
- Pass `onFrame={(frame) => runtime.current?.ingestSerialFrame(frame)}` and `onDisconnect={() => runtime.current?.clearAutopilotStatus()}` to `<SerialConnect />`.

### Step 4 — Expand Browser E2E Test in [tests/browser/hud.spec.ts](tests/browser/hud.spec.ts)
- Keep the existing demo provenance test.
- Add a second test that installs a mock `navigator.serial` port before `page.goto("/")` and feeds real CRC-valid MAVLink2 `HEARTBEAT` (`id = 0`, `mode = 5`) and `EKF_STATUS_REPORT` (`id = 193`, degraded `flags = 167 -> 23` and valid `flags = 55 -> 31`) frames from `tests/fixtures/mavlink/ekf-golden.json` through the real `serial-io.worker.ts`:
  - Verify `hud-ap-status` transitions from `DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN` $\rightarrow$ `AP MODE 5 · FRESH · <age> ms` with `EKF DEGRADED` (`flags = 23`), then `EKF flags valid` (`flags = 31`).
  - Pause the stream for $>1100\text{ ms}$ and verify `hud-ap-status` transitions to `STALE` and `EKF STALE`.
  - Verify React updates on `hud-ap-status` remain decimated ($\le 12$ DOM mutations over a 1000 ms window, never 400–1200 Hz).
  - Click `Disconnect serial` and verify `hud-ap-status` returns to `DEMO TRUTH · ArduPilot disconnected · EKF UNKNOWN`.

### Step 5 — Verification Gates & Documentation Sync
- Run:

```powershell
npx --no-install vitest run tests/hud.test.ts tests/session-v2.test.ts
npm run typecheck
npm run lint
npm run build
npx --no-install playwright test tests/browser/hud.spec.ts tests/browser/serial-permission.spec.ts tests/browser/instructor.spec.ts
node scripts/check-docs.mjs
git diff --check
```

- Update `TASK-074` to `DONE` in [docs/PROJECT_ROADMAP.md](docs/PROJECT_ROADMAP.md) and [docs/ru/PROJECT_ROADMAP.md](docs/ru/PROJECT_ROADMAP.md), and synchronize status references in [README.md](README.md), [CLAUDE.md](CLAUDE.md), [docs/SPECS_SIMULATION_ENGINES.md](docs/SPECS_SIMULATION_ENGINES.md), [docs/architecture.md](docs/architecture.md), [docs/V2_PLAN.md](docs/V2_PLAN.md), and their `docs/ru/` mirrors.
