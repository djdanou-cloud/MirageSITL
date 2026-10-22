# Local validation and release runbook

## Geographic data setup

Current ESA WorldCover 2021 v200 terrain classification coverage is restricted
exclusively to Israel. Follow [WorldCover coverage and manual region downloads](worldcover-data.md)
for the public global S3 source, AWS CLI prerequisites, PowerShell/zsh commands
and the validation steps required before expanding supported coverage.

## Local checks

Use the existing isolated checkout; preserve local changes. Node is pinned by .nvmrc; Rust 1.97.0 and wasm32-unknown-unknown by native/rust-toolchain.toml. Install npm dependencies with npm ci. In the cloud activate CARGO_HOME=/workspace/.cache/mirage-cargo, RUSTUP_HOME=/workspace/.cache/mirage-rustup and prepend CARGO_HOME/bin to PATH; do not repurpose HOME. Run lint, typecheck, check:docs, CI=true npm test, npm run build and locked native tests. Start npm run dev; verify HTTP, COOP same-origin, COEP require-corp and the actual Worker READY state. Start at zero throttle, arm, fly, pause and reset. Browser tests use system Chromium only when available. A clean restored-machine installation/startup has not yet been executed for release certification.

All new evidence commands are local. With no trace they write BLOCKED_EXTERNAL and exit 2; invalid evidence exits 1. They never deploy, tag or push. Inspect report reasons and preserve original captures plus exact byte hashes. Trace files are bounded to 32 MiB. CLI analyzers stamp sourceRevision and validatorSha256; retain inputSha256 and use matching code/report identities. Re-run evidence after relevant code/config changes.

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

SITL requires MIRAGE_SITL_SOURCE at the pinned clean commit, MIRAGE_SITL_BINARY with MIRAGE_SITL_BINARY_SHA256, and MIRAGE_SITL_DRIVER with MIRAGE_SITL_DRIVER_SHA256. No secrets are required. The Node driver (`scripts/sitl/driver.mjs`) receives --binary and --parameters, owns firmware/bridge lifecycle and outputs only a JSON trace after cleanup. It runs the JSON backend, drives RC/commands and records original autopilot diagnostics; it is separate from the demo. Native ELF and source checks reject absent/fake inputs; hashes establish declared identity but not reproducibility of a locally built binary. Retain build logs/toolchain evidence separately. The parent creates a private working directory, bounds stdout/stderr to 16 MiB, enforces 120 s and terminates its owned POSIX process group on failure. Windows descendant containment still requires a verified driver/job-object implementation; do not use global kill commands. Never delete shared source/build caches during cleanup.

A release input contains schemaVersion=1, artifacts [{path,sha256,license}], systemReportPath and systemReportSha256. Inventory is limited to 4096 files, 64 MiB/file and 512 MiB total from apps/web/dist, packages/wasm-bet/dist or test-results/validation. Traversal, symlink escape, duplicates, absent licenses and mismatched hashes are rejected. The output records actual file sizes/hashes, source revision/dirty state, npm lock hash, dataset registry hash and Node version. Complete dependency-license review, actual compiler versions and clean-machine/raw G0–G4 evidence are still prerequisites: inventory generation deliberately remains BLOCKED_EXTERNAL even for a supplied green summary. It cannot authorize publication.

For rollback restore an explicitly selected known release in a separate deployment workflow; never reset or clean the working checkout. Stop only processes/groups owned by the current run, close Serial through its UI, and terminate the Workers created by that session. Keep diagnostic captures when a gate fails. No deployment credentials, automatic rollback or target-hardware acceptance are assumed.

Accessibility checklist: keyboard Tab reaches the skip link and core actions; Enter operates the focused action; visible focus persists; typing in text/select controls suppresses instructor shortcuts; 390px layout has no horizontal overflow; denied Serial permission produces one announcement and focus returns without repeated prompts; importing AAR keeps the live flight. Automated axe and browser checks cover these software paths. A physical transmitter/FC, assistive-screen-reader session and live autopilot UI remain separate unrun checks.

## Native SITL flight (TASK-042)

Run the whole harness on Linux or inside WSL Ubuntu. Use Node 24, a virtual
environment with pymavlink 2.4.50, the clean source at the commit in
`scripts/sitl.lock.json`, its native ArduCopter ELF, and the scalar body WASM
from `node scripts/build-wasm.mjs`. Existing source/builds may be reused after
checking their identities; preserve build logs/compiler versions. No physical
FC, external flight log, cloud credentials or measured polar is required for
this synthetic-aircraft integration. `scripts/sitl/driver.mjs` is the reference
closed-loop driver; it is separate from the demo.

Set the paths below in the Linux shell. Values are local paths, not secrets.
The capture directory must be new. The firmware parameters keep ARMING_CHECK=1
and EKF3 enabled. Do not disable checks or alter the frozen flight tolerances.

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

`run-sitl` executes firmware/driver and returns 0 only for a completed flight;
without prerequisites it returns 2. `check-sitl-capture` independently checks
the saved v2 trace against full-rate physics and original decoded telemetry,
verifies unchanged source hashes, frame/cadence/PWM counters and writes
`test-results/validation/task-042-flight.json`. `check-raw.py` first independently
decodes and CRC-checks raw MAVLink, requiring every recorded observation to
match its ordered stream prefix. The audit does not rerun firmware.
Keep raw MAVLink, physics, decoded telemetry and DataFlash logs in the capture;
retain their hashes and failed trials. Full-rate logs remain local cache inputs,
not redistributed firmware/source. The 100 Hz scored trace preserves original
800 Hz frame numbers at stride eight. Native PASS does not enable browser
READY, measured-aircraft fidelity, recorded Simulation-on-Hardware or production terrain contact.

## Windows laptop verification

The repository attributes preserve LF source/fixture bytes on Windows and keep
the hashed NASA archives byte-exact. Do not regenerate fixture or mirror hashes
to compensate for checkout conversion. Playwright launches Vite with its own
Node executable; npm need not be on PATH after locked dependencies are installed.
Browser fixture imports use portable, escaped Vite filesystem URLs.

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

Set CHROMIUM_PATH to an actual installed Chrome/Chromium/Edge executable or omit
it to use Playwright's separately installed browser. The default functional
profile uses software rendering. MIRAGE_BROWSER_GPU=hardware removes software
GPU launch overrides; it does not guarantee that the discrete GPU was selected.
Inspect the recorded adapter and driver. Keep the visible probe window in front,
and run timing probes without competing test/build workloads. Record power mode,
resolution, DPR, temperatures, visibility changes and any unrelated load.

The laptop probe owns a loopback production-preview server and a separate browser
profile; it closes only those resources. It never connects to Serial. Its raw
frame intervals, GPU diagnostics, heap snapshots and screenshot describe the
current demo. Browser heap is not GPU residency or terrain CPU cache. A completed
demo probe does not satisfy TASK-073's full production terrain/FPV/thermal matrix,
its memory limits or the separate M4 requirement. A visible 10-minute demo run
remains useful stability evidence even when production acceptance is blocked.

The production capture is separate:

```bash
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 60
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 120
```

It serves the local CC0 tiles fixture and measures the mounted FPV, fisheye,
analog, and synthetic LWIR scene at 1920×1080 DPR 1 after 60 s warmup and 600 s
of visible frames. WebGPU exits `BLOCKED_EXTERNAL` because fisheye and thermal
passes are not implemented. A panel whose refresh cannot present the requested
profile, and a browser whose layout size, screen size, or device pixel ratio is
zero, also exit `BLOCKED_EXTERNAL`. Those results are not frame-time failures.
On 2026-10-21 the user accepted a 60 FPS median of 16.680 ms, a p99 of 17.665 ms,
and a 59.88 Hz panel. The 120 FPS p99 limit remains 8.33 ms. The M4 capture was
scored in an emulated 1920×1080 window. The active Mac display mode is
2560×1440 and the MacBook Air native panel is 2560×1664. The operator
screenshot in `task_073_results/` shows Chrome floating on the desktop, so the
next capture must fill the physical display. Run the command in a graphical
session that can show the window; keep that window in front.

Since 2026-10-22 the capture uses no viewport emulation. `--position X,Y`
(default `0,0`) names the top-left corner of the display that shows it; the
browser window goes fullscreen there with an English UI (no translate prompt)
and the `?g3=1` page hides scrolling, so the measured canvas is what the
physical display presents. The accepted 60 FPS profile runs on any display
above 58 Hz (user decision 2026-10-22); other profiles still need
`refresh + 1 >= fps`. Beside the analyzer report the capture writes the raw
frame intervals (`gpu-<backend>-<fps>.frames.json`, hashed in the side record),
an OS screenshot of the whole display (`display-<backend>-<fps>.png`), and
supplementary samples that never feed the gate: Windows `GPU Process Memory`
peaks for the browser GPU process, `nvidia-smi` power states and clocks
(`clocks-<backend>-<fps>.json`), and PresentMon display-change timing. PresentMon
v2.6.0 is expected at `.cache/tools/presentmon-2.6.0/PresentMon-2.6.0-x64.exe`
(or `MIRAGE_PRESENTMON`) and needs an elevated shell or an account in the
Windows "Performance Log Users" group; otherwise the side record states that it
did not run. `node scripts/diagnose-render.mjs` compares the demo, terrain and
`?g3=1` scenes with WebGL2 GPU timer queries; it is diagnostic only. Both tools
open `?g3=1&flight=circuit`: a scripted pilot (`packages/input/src/scripted-flight.ts`)
moves only the sticks, arms at zero throttle, climbs to 30 m and circles the
origin at 10 m/s on a circuit of at most 300 m radius kept inside 60% of the
build-time area radius `VITE_MIRAGE_AREA_RADIUS_M` (default 1000 m), so
terrain streaming and level-of-detail changes happen during the measurement.
The capture writes the flight once per second (`flight-<backend>-<fps>.json`:
HUD altitude and position, simulation time, physics rate, input failsafe, arm
state and the longest frame gap). It presses Start only after the feature wait
and its separate WebGL identity probe: a main-thread stall above the 250 ms
pilot input timeout blocks the worker's arming latch until the arm request is
withdrawn, so a stall in flight makes the drone fall, by design. The FPV camera
sits on the nose of the drawn body (`apps/web/src/vehicle-geometry.ts`), not
inside it. `MIRAGE_SCREENSHOTS=1` keeps a Playwright screenshot of every browser
test (default: failures only) for operator review.

`?g3=1` presents the external chase view with the whole drone by default; the
FPV, analog and thermal passes still render every frame to their own targets.
`?view=fpv` presents the FPV image instead. Captures and tests open
`view=chase`. PresentMon starts before the flight and records the whole run,
because opening its ETW session stalled the browser for about 300 ms in a test
run (long enough to trip the input timeout). It writes `CPUStartQPCTime`
(`--qpc_time_ms`), which shares the QueryPerformanceCounter time base with
Node's `process.hrtime` on Windows, so the side record keeps only the frames
inside the measurement window and reports `DisplayedTime` (on-screen time per
frame), `GPUBusy` and the present mode.

The generated terrain and buildings (see `docs/architecture.md`) are built in
WSL and never committed:

```bash
bash scripts/geodata/setup-wsl.sh
python3 -I scripts/geodata/fetch_fabdem.py --config config/geodata.json --out ~/mirage-geodata/fabdem
python -I scripts/geodata/build_terrain.py --config config/geodata.json --fabdem ~/mirage-geodata/fabdem --out ~/mirage-geodata/israel/terrain
python -I scripts/geodata/build_buildings.py --config config/geodata.json --terrain-work ~/mirage-geodata/israel/terrain/_work --work ~/mirage-geodata/buildings-work --out ~/mirage-geodata/israel/buildings
python -I scripts/geodata/extract_osm.py --config config/geodata.json --pbf israel-and-palestine-261020.osm.pbf --out ~/mirage-geodata/israel/osm
python -I scripts/geodata/build_material_map.py --config config/geodata.json --classes config/material-classes.json --worldcover data/worldcover/2021-v200/israel --osm ~/mirage-geodata/israel/osm --out ~/mirage-geodata/israel/materials
node --experimental-transform-types scripts/geodata/check_material_map.mjs --materials '\\wsl.localhost\Ubuntu\home\<user>\mirage-geodata\israel\materials' --osm '\\wsl.localhost\Ubuntu\home\<user>\mirage-geodata\israel\osm'
node scripts/check-gpu-perf.mjs --backend webgl2 --fps 60 --geodata '\\wsl.localhost\Ubuntu\home\<user>\mirage-geodata\israel'
```

`--view thermal` (or `fpv`) presents that image instead of the chase view for
inspection runs; acceptance captures keep the default `chase`. The thermal scene
instant defaults to 2026-07-15 07:00 UTC; open the page with
`?thermalUtc=2026-07-15T12:00:00Z` (a zoned ISO time) to inspect another hour.

The Python scripts run inside the `mirage-geo` environment
(`micromamba run -n mirage-geo ...`). The OSM extract (`*.osm.pbf`) is an
operator-supplied Geofabrik file kept in the repository root and ignored by
Git; `check_material_map.mjs` exits 0 on PASS and 1 on FAIL. Keep the data out of the repository
folder (it is synchronised by OneDrive here). Run the capture from PowerShell:
Git Bash rewrites the `\\wsl.localhost` path.

The Serial controller waits at most 5 seconds for decoder readiness before
opening the selected device. The existing 500 ms per-chunk backpressure deadline
is unchanged. A permission grant or this startup handshake cannot enable HITL.

For operator-assisted placement on a particular display, pass `--ready-file`
with a fresh path inside the output directory. The probe opens the page but
waits before warmup and acquisition. Create that file only after the operator
confirms the window is on the intended display. An existing readiness file is
rejected; a 15-minute timeout stops the probe rather than starting it without
confirmation. The selected display's refresh rate must support the requested
visible FPS profile; retain lower-refresh captures as separate evidence.

Use `--native-viewport` for visual layout checks: the window starts maximized
without forced viewport or DPR emulation. `--position X,Y` chooses its initial
desktop location; use coordinates from the actual monitor arrangement. Record
the resulting viewport and DPR instead of labeling this as the fixed 1080p
profile. On a scaled laptop display, an emulated 1920 CSS-pixel viewport can
clip inside a smaller native browser client area. A native-size confirmation
and the recorded horizontal layout bounds distinguish test-window sizing from
an application overflow defect. Never count a clipped capture as a visual pass.

Recorded Windows 11 laptop baseline (`test-results/laptop/`, Intel Core 7 240H,
RTX 4050 Laptop GPU, driver 561.00, Chrome 155.0.8059.84, Node 24.19.0, Rust
1.97.0): on the 1920x1080 60 Hz output, visible DPR1 demo captures after 60 s
warmup measured 35,995 frames over 600.0052 s (59.9911 FPS, p50/p95/p99
16.670/17.640/19.910 ms, max 34.365 ms) on WebGL2 and 7,193 frames over
120.002465 s (59.9404 FPS, p50/p95/p99 16.665/17.635/19.645 ms, max 34.270 ms)
on native WebGPU; on the 1920x1200 144 Hz panel, a fixed 1920x1080 capture gave
59.9911 FPS (p99 19.565 ms, clipped) and a `--native-viewport` 1536x826 DPR 1.25
capture gave 59.99994 FPS (p99 19.005 ms, unclipped). All miss the accepted 60 FPS p99 of 17.665 ms
and the 120 FPS limit of 8.33 ms. Separately, 5 s `node scripts/bench-physics.mjs` realtime
captures on Windows Node (`test-results/laptop/physics-*-idle.json`) executed
400.532 Hz (0 dropped, compute p99 1.2 us, wakeup lateness p99 15.76 ms) at
target 400 Hz, 516.710 Hz (1,426 dropped, compute p99 1.1 us, lateness p99
16.06 ms) at target 800 Hz, and 519.573 Hz (3,415 dropped, compute p99 1.3 us,
lateness p99 15.99 ms) at target 1200 Hz (~16 ms timer wakeups x 8-step
catch-up cap); the browser Worker 800 Hz regression passed its 720–880 Hz range.

Local USB diagnostics (`test-results/hardware/`, COM20 at 115200 8N1, DTR/RTS
disabled, battery disconnected) verified an ArduPilot device (VID `1209`, PID
`5741`, reported firmware 4.6.3 stable `3fc7011a`, sysid/compid 1/1) across 67
passive frames (`5e996d6bb607ac9af9754676e6ffcc37509d700ec02041c477c8f403bb914638`)
and 252 query frames (`b026643bd47943e57a276896db85d608d852ec266f6592547fd82ece20d48329`)
with zero CRC errors or sequence gaps, healthy IMU/barometer samples, disarmed
heartbeats and HIL disabled, while compass, GPS, battery, RC (`PreArm: RC not
found`) and timed EKF admission remained blocked. Raw captures contain device
identifiers and must not be reused as generic fixtures.

When diagnosing engines or models, check JSON report fields rather than exit
codes alone: `node scripts/validate-models.mjs` (`test-results/validation/model-report.json`)
exits 2 when numerical checks pass (`numericalStatus: "pass"`) while measured
propeller/contact comparisons fail (`propellerFidelityStatus: "fail"`,
`contactFidelityStatus: "fail"`). For JSBSim and contact artifacts, run
`node scripts/build-contact.mjs`, `node scripts/check-contact-binding.mjs`,
`node scripts/build-jsbsim.mjs --contact`,
`node scripts/check-jsbsim-backend.mjs --native`,
`node --experimental-transform-types scripts/check-jsbsim-backend.mjs` and
`node scripts/bench-jsbsim.mjs`.

## Native EKF readiness capture (TASK-043)

The native driver now uses LiveEkfWarmup for arming admission and writes
warmup.ndjson. Preserve the configured source/ELF/driver hashes and choose a
new capture directory as above. Run the existing native harness, then the
raw MAVLink audit before these commands:

```bash
node scripts/check-sitl-capture.mjs --input "$MIRAGE_SITL_CAPTURE_DIR" --output test-results/validation/task-043-flight.json
node scripts/check-ekf-warmup.mjs --input "$MIRAGE_SITL_CAPTURE_DIR"
```

The second report distinguishes observed READY/revocations and acceleration
from synthetic rejection probes. It requires the actual acknowledged JSON IMU
sample clock, CRC-checked GPS fix/health reports, unchanged source files and
matching decision replay. Keep transient GNSS freshness failures visible;
do not widen limits to obtain continuous READY. The synthetic HITL clock probe does not run recorded Simulation-on-Hardware or virtual Hybrid SITL. TASK-042 historical reports live
in test-results/validation/task-042-snapshot-2026-10-19; new capture audits use
the optional --output path to preserve them. Native admission does not enable
browser READY or apply EW effects.


## Native EW response acquisition (TASK-059)

Use the same pinned Linux/WSL ELF, source, WASM, Node and MIRAGE_SITL_PYTHON environment as TASK-042. The driver owns each firmware/sidecar pair and enforces its deadline; cases are sequential. The existing native healthy flight remains a separate regression. Never reuse a nonempty capture directory.

```bash
export NODE_OPTIONS=--experimental-transform-types
node scripts/run-ew-sitl.mjs --output .cache/task-059/calibration --case all
node scripts/freeze-ew.mjs --calibration .cache/task-059/calibration
node scripts/run-ew-sitl.mjs --output .cache/task-059/validation --case all
node scripts/report-ekf.mjs --input test-results/validation/task-059-input.json --sha256 INPUT_SHA256
```

The freeze command is one-time calibration and refuses existing envelopes. On later runs, evaluate new captures against the checked-in matrix; do not rerun calibration to repair a failure. The input JSON has schemaVersion 2 and caseDirectories ordered control, jamming, position-step, velocity-drift, magnetic, motor-loss. Use repository-relative directories for a portable manifest and SHA-256 of its exact bytes. Each case writes response-audit.json plus raw RX/TX bytes, original decoded telemetry, observations, full-rate physics, readiness decisions, actual parameter readbacks and owned firmware logs. report-ekf re-audits raw bytes and physics, rejects calibration reuse/source drift and writes ekf-report.json. Archive these owned simulation captures without firmware binaries or third-party source. Native reports do not enable browser READY or certify physical aircraft.


## Local browser firmware acceptance (TASK-045)

Use the exact external artifact pair matching native/ardupilot/wasm-artifact.manifest.json. The fresh builder accepts only new/empty build and artifact directories and compares output against that manifest; it checks source/submodule/SDK/compiler identities and retains build.log. Preserve compiler and pthread/memory-growth warnings. No artifact is copied into the production application. Start the local development server with the explicit setting, then open /ardupilot-check.html for the internal diagnostic. It starts firmware only on an explicit diagnostic/test call. Profiles bind source/module identities; use a distinct profile for experiments.

```bash
export MIRAGE_ARDUPILOT_WASM_DIR=/absolute/path/to/local/artifacts
node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1
```

```bash
CHROMIUM_PATH=/path/to/chrome node node_modules/@playwright/test/cli.js test tests/browser/ardupilot-wasm.spec.ts
python scripts/check-ardupilot-browser.py --input test-results/validation/task-045-browser-boot.json
```

The audit command requires pymavlink 2.4.50 (the installed WSL venv is suitable). Browser tests use only the built-in synthetic quad and remain disarmed. They check real parameter readback/save/restore, abrupt termination, zero surviving Workers, profile conflicts, transaction aborts, corrupt storage, isolation, hashes, size caps and artifact access checks. The JSON capture includes original serial bytes and three 16 KiB EEPROM images; the independent auditor writes wire-audit JSON and serial/EEPROM .bin files. These are owned test outputs. Firmware/glue remain external under local-only-pending-gpl-review. Keep corrupt records for diagnosis; never silently wipe or substitute defaults to obtain a pass. Only acknowledged checkpoints survive the recovery contract. Live simulation time/physics, persistent storage integration during flight, pause semantics and flight parity belong to TASK-046/047.

## TASK-047 local native/browser flight comparison

Use the pinned clean native source/ELF and HAL artifact from TASK-042/046,
Node 24, the existing scalar BET WASM build, isolated Chromium and pymavlink
2.4.50. No hardware or measured rotor data is required for this synthetic
NACA6409/NeuralFoil comparison. Preparation requires a new directory and
copies upstream Copter defaults with explicit synthetic-model overrides;
arming checks and EKF3 remain enabled. Run the native driver under Linux/WSL;
on Windows, prepare/bundle with Windows Node, then pass WSL paths to the
bundled native driver and use Windows Node for Playwright. Use the same
prepared defaults file for both backends. Preserve captures when sources
change; rebuild the driver and repeat both backends rather than editing hashes.

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

Each native run owns its private temporary firmware directory and child process;
the browser fixture owns its firmware Worker/pthreads. Captures record 120 s
of flight at 800 Hz, sampled at 100 Hz, with original serial and command bytes.
The scored 30 s reference is 90..120 s, not a trajectory-aligned window. The
nominal case commands LAND at 90 s; the GCS case cuts heartbeats instead and
requires firmware STATUSTEXT confirming failsafe before landing/disarm.
Audit JSON is written beside each capture. The comparator validates those
files and current source/artifact identities before numerical scoring.
A report enables only the matching lifecycle parity capability; it does not
select the application backend, admit measured fidelity or settle allocation,
distribution and release gates. Store its SHA-256 in trusted local acceptance
configuration before calling admitWasmParity. Missing captures exit 2 and
failed/unverified evidence exits 1; never replace a failed capture with a
synthetic trace or update goldens to hide a mismatch.
