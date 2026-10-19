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

SITL requires MIRAGE_SITL_SOURCE at the pinned clean commit, MIRAGE_SITL_BINARY with MIRAGE_SITL_BINARY_SHA256, and an operator-owned MIRAGE_SITL_DRIVER with MIRAGE_SITL_DRIVER_SHA256. No secrets are required. The Node driver receives --binary and --parameters, owns firmware/bridge lifecycle and outputs only a JSON trace after cleanup. It must actually run the JSON backend, drive RC/commands and record original autopilot diagnostics; the demo does not supply this missing production driver. Native ELF and source checks reject absent/fake inputs; hashes establish declared identity but not reproducibility of a locally built binary. Retain build logs/toolchain evidence separately. The parent creates a private working directory, bounds stdout/stderr to 16 MiB, enforces 120 s and terminates its owned POSIX process group on failure. Windows descendant containment still requires a verified driver/job-object implementation; do not use global kill commands. Never delete shared source/build caches during cleanup.

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
this synthetic-aircraft integration. The supplied reference driver replaces
the historical missing-driver prerequisite above; it is separate from the demo.

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
READY, measured-aircraft fidelity, physical HITL or production terrain contact.

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
do not widen limits to obtain continuous READY. A physical HITL run is not
performed by the synthetic HITL clock probe. TASK-042 historical reports live
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
