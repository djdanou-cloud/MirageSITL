# Tactical Icons, Avionics Audio & Contextual Info Bubbles (`InfoTip`) — Implementation Plan

English is the repository source of truth. [Russian mirror](docs/ru/ui_implementation_plan.md).

This plan integrates three cohesive layers into `@mirage/web`:
1. **Beginner-Friendly Contextual Info Bubbles (`InfoTip`)** near every major feature, flight instrument, and engineering setting.
2. **Tactical / Military GCS Icons** (`lucide-react` + custom 1px HUD/NATO inline SVGs).
3. **Zero-Asset Procedural Avionics Audio** (`Web Audio API` synthesizer with topbar Mute/Unmute control).

---

## 1. Guardrails & Test Compatibility (Critical Constraints)

MirageSITL enforces strict automated checks in `tests/browser/` (`app-shell.spec.ts`, `accessibility.spec.ts`, `simulation.spec.ts`, `aircraft-editor.spec.ts`, `card-editor.spec.ts`, `sensors-tab.spec.ts`). To guarantee **zero test regressions**:
- **Preserve Exact Accessible Names (`exact: true`):** Many tests query controls via `getByRole("button", { name: "...", exact: true })`, `getByRole("tab", { name, exact: true })`, and `getByLabel("...", { exact: true })`.
  - All decorative icons inside buttons/tabs/headings MUST have `aria-hidden="true"` and contain no text nodes.
  - **`InfoTip` triggers MUST NEVER be nested inside `<label>` or `<button>` elements.** Instead, place `<InfoTip>` alongside headings, legend rows, or inside a flex wrapper *next to* the `<label>` so the input's accessible label remains 100% unchanged.
- **390 px Mobile Viewport & Zero Overflow:** `accessibility.spec.ts` and `app-shell.spec.ts` assert `document.documentElement.scrollWidth <= innerWidth` at `390×844` across all 12 tabs.
  - Info bubbles will use viewport-safe positioning (`position: fixed` or CSS-clamped popover anchored to the trigger's bounding rect) so they never widen `documentElement.scrollWidth`.
- **Zero Axe Violations:** `InfoTip` will use a semantic `<button type="button" className="info-tip-trigger" aria-label="More information: ...">` with `aria-expanded` / `role="tooltip"` support, keyboard focus (`Focus` / `Hover` / `Click`), and `Escape` to dismiss.
- **Zero-Allocation Physics Isolation:** Audio synthesis and UI tooltips live strictly on the Main thread (`apps/web/src/ui/`). [`physics.worker.ts`](apps/web/src/physics.worker.ts) is untouched.

---

## 2. New Shared UI Modules (`apps/web/src/ui/`)

### A. Contextual Info Bubble Component: `apps/web/src/ui/InfoTip.tsx`
A compact, tactical `?` / `Info` badge (`14×14 px` `CircleHelp` / `Info` icon from `lucide-react`) that displays a dark MFD-styled explanation bubble on **mouse hover**, **keyboard focus**, or **tap/click** (for mobile/touch):
- **Visual Style:** Phosphor-cyan border (`#36574e`), deep slate surface (`#0c1821`), crisp monospace header + plain-English explanation (`11px`, max-width `260px`), optional **"Why it matters"** or **"Safe value / tip"** callout line.
- **Smart Viewport Clamping:** On hover/focus, measures `getBoundingClientRect()` and clamps `left`/`top` within `[8px, window.innerWidth - 268px]` so it never clips off-screen or causes horizontal scroll at `390px`.

### B. Procedural Avionics Synthesizer: `apps/web/src/ui/audio.ts`
A zero-dependency `TacticalAudio` Web Audio API controller:
- **Topbar Audio Toggle** in [`AppShell.tsx`](apps/web/src/shell/AppShell.tsx): `Volume2` / `VolumeX` icon button (`aria-label="Toggle tactical audio"`, `aria-pressed`), persisted in `localStorage` (`mirage.audio.enabled`).
- **Synthesized Sound Cues (MIT / 100% Free Code):**
  1. `click()`: `15 ms` high-passed mechanical toggle click (`1800 Hz → 400 Hz`) on tab switches, Start/Pause/Reset, and mode switches.
  2. `arm()` / `disarm()`: Rising two-tone lock chirp (`880 Hz → 1320 Hz`) when arming motors; falling safe chime (`960 Hz → 480 Hz`) when disarming.
  3. `faultAck()`: RWR-style double staccato pulse (`2 × 60 ms` at `1046 Hz`) when an Instructor EW/fault command is acknowledged.
  4. `caution()`: MIL-STD bi-tone caution (`800 Hz / 640 Hz`, `280 ms`) triggered once on state transition into `InputFailsafe`, `faulted`, or `EKF STALE` / `DEGRADED`.
  5. `reject()`: Low avionics invalid-entry buzz (`320 Hz + 340 Hz`, `150 ms`) when a command is rejected or validation fails.
  6. `recordPip()`: Clean telemetry marker tone (`1200 Hz`, `70 ms`) when starting/stopping AAR recording.

---

## 3. Where Info Bubbles (`InfoTip`) & Tactical Icons Will Be Integrated

### A. Shell Header & Navigation ([`AppShell.tsx`](apps/web/src/shell/AppShell.tsx), [`ProjectBar.tsx`](apps/web/src/shell/ProjectBar.tsx))
- **Tactical Icons:**
  - Subtle `13px` `aria-hidden="true"` icons inside each of the 12 navigation tabs (`FolderKanban` for Project, `Plane` for Aircraft, `Cpu` for Components, `Radar` for Sensors, `ZapOff` for Faults, `CloudWind` for Weather, `Route` for Flight tasks, `Sliders` for Parameters, `Database` for Logging, `Play` for Run, `FlaskConical` for Experiments, `LineChart` for Analysis).
  - Audio Mute/Unmute button (`Volume2` / `VolumeX`) in `.shell-header`.
- **Info Bubbles (`InfoTip`):**
  - **Project Bar:** Explains that projects are stored locally in your browser's IndexedDB (no cloud account needed) and can be exported as `.mirageproj` archives.

### B. `Run` Tab — Flight Viewport, HUD & Pilot Console ([`App.tsx`](apps/web/src/App.tsx), [`PilotHud.tsx`](apps/web/src/hud/PilotHud.tsx), [`SerialConnect.tsx`](apps/web/src/SerialConnect.tsx))
- **Tactical Icons & HUD Symbology:**
  - Upgrade [`PilotHud.tsx`](apps/web/src/hud/PilotHud.tsx) attitude window with an inline SVG **MIL-STD HUD pitch ladder & water-line boresight (`—v—`)** plus status icons (`Satellite`, `ShieldAlert`).
  - Add telemetry micro-icons in `.hud-bottom` (`ArrowUpFromLine` for AGL, `Gauge` for Speed, `BatteryCharging` for Power, `Compass` for Control Mode).
  - Add icons to `Arm motors` / `Disarm motors` (`Power` / `ShieldAlert`), `Demo input` / `USB / EdgeTX` (`Sliders` / `Gamepad2`), and `Connect serial` (`Plug` / `Unplug`).
- **Beginner Info Bubbles (`InfoTip`):**
  1. **Flight Backend (`Synthetic demo` vs `ArduPilot SITL`):** Explains what the built-in synthetic quadcopter does vs. full ArduPilot SITL firmware.
  2. **Coordinate Badge (`DEMO QUAD / NED`):** Explains **NED (North-East-Down)** aviation coordinates and **AGL (Above Ground Level)** altitude.
  3. **Pilot HUD (`EKF / Attitude`):** Explains the artificial horizon (roll/pitch) and what an **EKF (Extended Kalman Filter)** does in a drone autopilot.
  4. **Physics / Main Thread / Scheduler Metrics:**
     - *Physics Hz:* Why physics runs on a separate Worker thread at a fixed `400 Hz` (`2.5 ms` step) independent of screen frame rate.
     - *Main Thread FPS:* Browser 3D rendering frame rate.
     - *Scheduler Overruns / Dropped:* What happens when the OS pauses the browser timer (catch-up cap of 8 steps prevents "spiral of death").
  5. **Input Source (`Demo input` vs `USB / EdgeTX`):** How to fly with the on-screen collective throttle vs. plugging in an EdgeTX/OpenTX RC radio over USB joystick mode.
  6. **Arming Latch Rule (`Arm motors`):** Explains why real drones (and MirageSITL) require **0% throttle** before arming, and why tab-hiding or input timeouts trigger an automatic disarm failsafe.
  7. **USB Channels / Calibration & Mode Channel:** Explains Roll/Pitch/Yaw/Throttle axis mapping, deadzone (`3.5%`), inversion, and the 6-slot flight-mode switch channel.
  8. **System Status (`Worker / SAB`, `Serial API`, `Input protection`):**
     - *Worker / SAB:* What `SharedArrayBuffer` lock-free shared memory is.
     - *Serial API (HITL):* How Web Serial reads live MAVLink `HEARTBEAT` and `EKF_STATUS_REPORT` frames from a USB flight controller.
     - *Input Protection:* Explains the `250 ms` pilot heartbeat watchdog (`INPUT LIVE` vs `DISARMED / STALE`).

### C. Instructor Console & AAR Recorder ([`Console.tsx`](apps/web/src/instructor/Console.tsx), [`Export.tsx`](apps/web/src/aar/Export.tsx), [`Review.tsx`](apps/web/src/aar/Review.tsx))
- **Tactical Icons:**
  - `Radar`, `Zap`, `Wind`, `Box`, `Terminal` in [`Console.tsx`](apps/web/src/instructor/Console.tsx).
  - `CircleDot` (Record), `Square` (Stop), `Eye` (Review), `Download` (Export), `Upload` (Import) in [`Export.tsx`](apps/web/src/aar/Export.tsx).
- **Beginner Info Bubbles (`InfoTip`):**
  1. **Instructor Console & Hotkeys (`P`, `R`, `F`):** How instructor fault injection works via Worker ACK.
  2. **Fault Effect (`gnss-jamming`, `position-step`, `velocity-drift`, `magnetic`, `motor-loss`):** Plain-English breakdown of each Electronic Warfare (EW) / hardware failure mode (e.g., how GNSS jamming degrades satellite navigation vs. motor power-cut spool decay).
  3. **Weather & Model Load:** Why weather and custom model loading require the full aerodynamics backend and are visibly rejected on the simplified demo.
  4. **Session Recording & AAR (`.aar`):** How After-Action Review records every physics tick into a bounded `32 MiB` ring buffer and plots Pilot Input vs. Actuator vs. Roll Rate response.

### D. `Project`, `Aircraft`, `Components`, and `Sensors` Tabs
- **Tactical Icons:** Section header icons (`FolderPlus`, `Archive`, `HardDrive`, `Compass`, `Scale`, `Cpu`, `Wrench`, `Activity`).
- **Beginner Info Bubbles (`InfoTip`):**
  - **Aircraft Tab ([`AircraftEditor.tsx`](apps/web/src/aircraft/AircraftEditor.tsx), [`ArmTable.tsx`](apps/web/src/aircraft/ArmTable.tsx), [`MassProperties.tsx`](apps/web/src/aircraft/MassProperties.tsx)):**
    - *Arms & Coaxial Setup:* What arm azimuth angle, arm length, cant/tilt angle, and coaxial upper/lower motors mean.
    - *Mass & Inertia Tensor ($I_{xx}, I_{yy}, I_{zz}$):* Plain-English explanation of center of mass and moments of inertia (resistance to roll, pitch, and yaw angular acceleration).
  - **Components Tab ([`ComponentsPanel.tsx`](apps/web/src/library/ComponentsPanel.tsx), [`CalculationPanel.tsx`](apps/web/src/library/CalculationPanel.tsx)):**
    - *Component Cards:* What $K_v$ (RPM/V), internal resistance $R_m$, no-load current $I_0$, and battery C-rating / internal resistance mean.
    - *Calculation Mode (`Preliminary` vs `From measurements`):* Difference between datasheet-derived estimates and bench-thrust stand measurement binding.
  - **Sensors Tab ([`SensorsTab.tsx`](apps/web/src/sensors/SensorsTab.tsx)):**
    - *Sensor Error Modes (`Ideal` vs `With specified errors`):* How bias, white noise, random walk, and scale-factor errors affect IMU, GNSS, Barometer, and Magnetometer readings, and what "Owner (`MirageSITL` vs `ArduPilot SITL`)" means.

---

## 4. Verification Plan

1. **Unit & Type Checks:**
   - Add unit tests for `InfoTip` clamping/accessibility and `TacticalAudio` state transitions & mute persistence.
   - Run `npm run lint`, `npm run typecheck`, and `npm test`.
2. **Real Browser & Accessibility Verification:**
   - Run `npm run test:browser` (or focused Playwright specs: `accessibility.spec.ts`, `app-shell.spec.ts`, `simulation.spec.ts`, `aircraft-editor.spec.ts`, `card-editor.spec.ts`, `sensors-tab.spec.ts`) to verify:
     - Zero `axe-core` accessibility violations.
     - Zero horizontal overflow at `390×844` mobile resolution across all tabs.
     - All existing `getByRole` / `getByLabel` / `getByTestId` assertions pass unmodified.
