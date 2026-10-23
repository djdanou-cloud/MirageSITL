# MirageSITL

A browser-based UAV simulation and pilot-training project, starting with an
isolated fixed-step physics loop and a usable flight laboratory.

English is the repository source of truth. [Russian mirror](docs/ru/README.md).
Source code, UI, comments, tests, logs, commits, and primary documentation use
English. System documentation is maintained in both languages in the same change.

## Current implementation

Milestone 01 provides React 19, React Three Fiber/Three.js, Vite, Tailwind CSS,
and Lucide UI; a dedicated module Worker; fixed 400 Hz integration; atomic
SharedArrayBuffer transport; USB Gamepad input; axis calibration; and a simplified
quadrotor demonstration. The interface includes a 3D view, telemetry, collective
throttle, arm/disarm, pause/reset, input failsafe, and scheduler drop counters.

The running application uses binary ABI **v2** (TASK-085): session epochs, EKF/EW
status fields, sensor/actuator queues, and Control Protocol v2. The demo physics
publication leaves EKF/EW unset. TASK-074 overlays identity-bound serial
`EkfMonitor` diagnostics on the Pilot HUD only; that overlay does not admit a
browser autopilot flight backend (TASK-047). Instructor
fault commands apply through the session EW registry (TASK-075).
ABI v1 remains in `packages/protocol` with its tests as a regression API.

The Phase 0 foundation adds deterministic seeded streams, SHA-256-verified
synthetic fixture manifests, and strict model/frame/inertia/rotor validation.
Models are admitted to an immutable session registry; runtime model switching
remains a separate integration step. See the [architecture guide](docs/architecture.md)
for the serialized contracts.

Startup checks secure context, isolation, SharedArrayBuffer, Worker, and WebGL2.
Missing requirements disable Start with an explanation; missing Gamepad disables
USB input. Failed WebGPU probing preserves WebGL2. Serial API availability is
reported separately. Drone firmware for Hybrid SITL and Simulation-on-Hardware is a version 2 proposal (TASK-051), not a current session mode. WebGPU rendering is not yet
enabled in the active flight session.

## Quickstart

TASK-042 provides a native Linux/WSL ArduCopter integration driver
(`scripts/sitl/driver.mjs` and a pymavlink 2.4.50 sidecar): pinned native
firmware flies a synthetic quad X through our Rust rigid-body WASM and the
JSON/MAVLink interfaces, with scored flight and original telemetry audited by
`scripts/check-sitl-capture.mjs`. This offline harness does not change the
browser demo or establish measured aircraft fidelity. See the
[SITL procedure](docs/operations/runbook.md).

Use Node.js **22.13+** or **24 LTS** (`.nvmrc` selects 24), npm 10+, and a
current Chrome/Edge browser on macOS/Windows. Future Web Serial HITL targets
Chromium. Cloud tasks use the existing isolated checkout; do not create another
Git worktree unless explicitly requested.

```bash
cd /workspace/MirageSITL
npm ci
npm run dev
```

For a local clone, replace the working directory with its actual path.
The development server uses port 5173. SharedArrayBuffer requires a secure
context: HTTPS or localhost. Remote HTTP by IP does not qualify. Vite dev and
preview set these headers; production hosting must set them independently:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If the cloud home cache is unwritable, add
`--cache /workspace/.cache/mirage-npm` to `npm ci`.

### Flying the demo

Select **Start → Arm motors → raise Demo throttle above 50%**. Spool response
is intentionally delayed. Pause disarms; return throttle to zero before
rearming. Reset stops and returns the model to the ground. Hiding the tab pauses
the session.

For EdgeTX/OpenTX, select USB joystick mode on the transmitter, choose the
USB input tab, and move a stick so the browser can detect it. Select the device
and verify channel directions while disarmed. Initial axis mapping 0/1/3/2
is not universal. The calibration table sets axis, minimum, center, maximum,
and inversion. Calibration lasts until page reload. Demo input works without
hardware. This milestone sends no commands to a real flight controller.

## Architecture summary

```text
Main Thread: Gamepad/calibration -> SAB pilot mailbox
Physics Worker: fixed-step demo -> SAB state ring
Main Thread: coherent snapshots -> interpolation -> R3F/HUD
```

```text
apps/web/             React UI, R3F view, Worker, runtime coordination
packages/protocol/    ABI v1/v2 and atomic readers/writers
packages/physics/     Demo dynamics and bounded scheduler
packages/input/       Gamepad adapter and calibration
packages/test-support/ Fixture integrity/provenance and deterministic PRNG
tests/                Unit and real-browser functional checks
docs/                 English specifications, roadmap, architecture
docs/ru/              Russian mirrors of system documentation
```

Physics owns truth and simulation time. Main owns browser UI/input/rendering.
High-rate data uses SAB; lifecycle/error messages use postMessage. The render
ring is short-lived interpolation history, not an AAR archive. Future physics
backends and autopilot adapters are defined in the specifications rather than
represented by nonfunctional services.

## Verification

```bash
npm run check:docs
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Install Playwright Chromium once only if needed. A prepared cloud machine can
use its system browser instead:

```bash
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

Unit checks cover ABI, scheduler, demo dynamics, coordinates, and calibration.
Browser checks exercise an actual Worker/SAB, takeoff, pause/reset, simulated
USB connection/disconnection, and mobile layout. USB tests use a mock and do
not validate a physical transmitter or Pixhawk.

After building, `npm run preview -w @mirage/web` serves the production bundle
on port 4173. Verify isolation, Worker READY, motion after arming, and stable
ticks while paused. Dedicated lint/typecheck commands are available. Rust 1.97.0
and the wasm32 target are required for the WASM tests; see [CLAUDE.md](CLAUDE.md)
for toolchain commands. GitHub Actions runs independent unit, browser, and build
jobs on pull requests and pushes to main. Unit JUnit reports, browser JUnit/HTML
reports and failure traces, and build logs/artifacts are uploaded even after
failure. The automated tooling checks include unsafe-type fixtures and
nonzero exit status when either runner discovers no tests.

400 Hz is a fixed **integration timestep**, not a browser hard real-time
guarantee. Catch-up is bounded to eight steps (`DEFAULT_MAX_CATCH_UP = 8`) and
dropped wall intervals are visible in the UI. On Windows Node, the
`bench-physics` realtime run executed 516.7 Hz (target 800) and 519.6 Hz
(target 1200) with drops: ~16 ms timer wakeups × 8-step catch-up cap. Compute is
~1 µs/step; the browser Worker 800 Hz regression passed. Catch-up caps and
drop thresholds must not be relaxed to hide drops. Target 60–120 FPS and
400–1200 Hz require production measurements (TASK-073). Since 2026-10-23 the
gate is a 1920×1080 canvas at 1x on the least performant tested integrated GPU,
on WebGL2 and WebGPU, at the accepted median 16.680 ms and p99 17.665 ms; every
other machine, screen and GPU is rated out of 100 in
[DEVICE_RATINGS.md](docs/DEVICE_RATINGS.md). Cloud headless smoke cannot
establish those budgets.

## System documentation

| English source | Russian mirror |
| --- | --- |
| [README](README.md) | [README](docs/ru/README.md) |
| [Project roadmap](docs/PROJECT_ROADMAP.md) | [Project roadmap](docs/ru/PROJECT_ROADMAP.md) |
| [Shared-memory specification](docs/SPECS_SHARED_MEMORY.md) | [Shared-memory specification](docs/ru/SPECS_SHARED_MEMORY.md) |
| [Simulation-engine specification](docs/SPECS_SIMULATION_ENGINES.md) | [Simulation-engine specification](docs/ru/SPECS_SIMULATION_ENGINES.md) |
| [Architecture](docs/architecture.md) | [Architecture](docs/ru/architecture.md) |
| [Implemented ABI v1 guide](docs/shared-memory.md) | [Implemented ABI v1 guide](docs/ru/shared-memory.md) |
| [Agent instructions](CLAUDE.md) | [Agent instructions](docs/ru/CLAUDE.md) |

When changing an English specification or guide, update its Russian mirror
in the same task and run `npm run check:docs`. See [CLAUDE.md](CLAUDE.md) for
the complete workflow, zero-allocation rules, deterministic math requirements,
and evidence needed to mark a task DONE.

## Physics, contact, and JSBSim modules

Independent motor, battery, arbitrary-frame wrench, and rigid-body RK4
references are available in `native/bet`, with a real WASM body adapter,
ISA/wind atmosphere (TASK-032), and ideal/noisy sensor suite (TASK-020–TASK-028,
TASK-034, TASK-035). TASK-033 adds a configurable NeuralFoil BET backend and
production polar/rotor binding, selectable through the PhysicsSessionV2 dynamics
factory and verified in a browser SAB Worker. The application Worker still
selects its existing demo dynamics by default.

The direct `f64` Rapier contact C ABI (`node scripts/build-contact.mjs`,
`node scripts/check-contact-binding.mjs`) passes native/WASM G1 zero-allocation
gates, synthetic compliance/contact checks, and browser Worker execution
(TASK-029). Published collision chunks drive Rapier ground contact through
contact ABI v2 (TASK-065): every tick, each wheel and the airframe receive the
plane of the terrain triangle beneath them, and missing ground pauses stepping
(flight-session wiring and live terrain admission remain open).

JSBSim has a verified Emscripten 4.0.15 WASM build (`node scripts/build-jsbsim.mjs`,
Worker smoke via `node scripts/check-jsbsim-artifact.mjs` at 400/800/1200 Hz,
TASK-030), an instrumented native-WASM-exception contact backend
(`node scripts/build-jsbsim.mjs --contact`, native/WASM parity and allocator
checks via `node scripts/check-jsbsim-backend.mjs --native`,
`node --experimental-transform-types scripts/check-jsbsim-backend.mjs`, and
`node scripts/bench-jsbsim.mjs`, TASK-031), and verified UIUC `<table name="C_T">` /
`<table name="C_P">` propeller loading in JSBSim v1.2.3
(`node scripts/check-jsbsim-propellers.mjs`, 18/18 cases, TASK-086). Aircraft
XML remains excluded from build artifacts. Opt-in `--patched` native
Rapier/JSBSim probes pass million-step zero-allocation checks with matching
trajectory checksums (`node scripts/check-engine-patch-parity.mjs`), while
unpatched upstream builds still allocate. See
[implementation contracts](docs/SPECS_SIMULATION_ENGINES.md).

The model validation CLI (`node scripts/validate-models.mjs`) reports numerical
and runtime results separately and exits 2 while measured physical fidelity
remains open. The user-selected TASK-033 synthetic/NeuralFoil software baseline
is distinct from measured certification. The first measured contact fixture,
`tests/fixtures/contact/nasa-drop.json`, holds the NASA TM X-3561 level-surface
landing-gear drops (https://ntrs.nasa.gov/citations/19780003109), generated from
the hashed Docling archive in `tests/fixtures/contact/nasa/` by
`tests/fixtures/contact/generate_nasa_drop.py` and converted to SI. Against it,
the Rapier sphere contact passes impulse, nonpenetration, and energy consistency,
but fails the measured deceleration (`-1.6 g`) and stroke envelopes; that
historical failure is preserved in `test-results/validation/nasa-drop-legacy.json`.
The user's 2026-10-18 NASA deferral is explicit in reference manifest v2 and
report schema v5; contact and UIUC propeller BEM fidelity remain blocked on
measured validation, not passed.

## Autopilot, links, and EW modules

TASK-037/038/039/040/048/052/053/056/057/060 provide a pinned MAVLink2 subset,
versioned radio calibration/mode mapping, autopilot lifecycle admission, an
origin/token-checked loopback WS/UDP bridge, gesture-driven Web Serial transport
with a separate I/O decoding Worker, isolated EW/motor-fault components, and a
fail-closed terrain policy. Run `npm run start -w @mirage/bridge` with
`MIRAGE_BRIDGE_TOKEN` supplied locally (64 hex characters); optional
`MIRAGE_BRIDGE_ORIGIN`, `MIRAGE_MAVLINK_PORT`, and `MIRAGE_PHYSICS_PORT`
configure origin/UDP endpoints. Never print tokens or add them to URLs/repository
files. This is loopback `ws`; HTTPS/WSS/PNA require separate integration. Use
`node scripts/bench-links-ew.mjs all 400` (also `800`/`1200`) for Node
allocation evidence, not hardware timing acceptance. Scalar conveniences may box
floating-point values: high-rate composition uses typed-array inputs and outputs
documented in the engine specification.

TASK-043 connects `EkfMonitor` and the 30-second `LiveEkfWarmup` gate to the
native Linux/WSL SITL driver (TASK-042). Readiness uses actual autopilot
diagnostics and acknowledged sensor timestamps, measures simulation acceleration,
and revokes EW admission when freshness or health fails (`scripts/check-ekf-warmup.mjs`).
TASK-059 native EW experiments use the pinned ArduCopter installation and
synthetic quad for six-case acquisition, raw-wire/physics audits, one-time
calibration, and validation against fixed firmware-specific limits
(`scripts/check-ew-capture.mjs`). These offline native gates do not enable
browser autopilot READY or establish measured aircraft fidelity.

TASK-044 records native ArduPilot HAL requirements, and TASK-045 provides the
local ArduCopter WASM build/diagnostic (`node scripts/build-ardupilot-wasm.mjs`),
real browser Worker/pthread boot, and persistent IndexedDB EEPROM checks. The
firmware artifact stays external under `BLOCKED_DECISION` (GPLv3 redistribution)
and is served only with an explicit loopback development setting; see the
[operational runbook](docs/operations/runbook.md). The active browser flight
backend remains the demo pending application session/release admission. TASK-047
verifies local native/browser flight parity and gates WASM lifecycle connection
on a SHA-256-verified report bound to the active configuration. See the runbook
for the capture/audit/comparison procedure. TASK-046 supplies the
checked sensor/PWM mailbox and host-owned 400/800/1200 Hz clock, including local
real-firmware tests with configurable synthetic NACA6409/NeuralFoil BET physics.
Build with `node scripts/build-ardupilot-hal.mjs`; validate the kernel with
`node scripts/check-ardupilot-hal.mjs` and select local browser test artifacts
through `MIRAGE_HAL_ARTIFACT_DIR`. Full firmware allocation qualification and
autopilot READY are separate from this HAL boundary.

## Thermal, instructor, AAR, and acceptance tooling

The demo includes a NED attitude HUD with explicit unknown/stale autopilot
status, an ACK-driven instructor console, and a bounded session recorder. Use
**Start recording**, fly the demo, then **Review recording** or **Export session**.
**Import AAR** opens a validated snapshot timeline without replacing the active
flight. Recording is written by the physics worker at the physics rate. Truth
and the pilot input used for that tick are stored every tick. A sensor or
actuator frame is stored only when that tick already owns it. The 32 MiB archive
caps the full-rate window below 30 minutes. Charts still decimate to at most
10000 points. Arbitrary metadata, keys, and serial identifiers are
excluded. Measure producer allocations with `node scripts/bench-aar.mjs 400`
(repeat at `800`/`1200`).

Instructor shortcuts are P pause, R reset, and F selected fault; typing focus
suppresses shortcuts. Weather and model requests show the demo rejection.
Fault commands apply after the Worker ACK (TASK-075). Recording stores every
physics tick, with actuator or sensor bytes only when that tick owns the frame
(TASK-078). The
thermal package supplies a synthetic surface-energy solver, WebGL2 LWIR material,
and deterministic offset calibration, tested independently from the active scene;
it does not claim measured CADEX fidelity.

The repository also includes collision-chunk construction/ownership,
deterministic scenario scheduling/rubrics (`node scripts/bench-terrain-scenarios.mjs 400`,
`800`, `1200`), and local SITL/HITL/EW/GPU/system/release evidence CLIs.
Keyboard users can skip to controls and receive visible focus and one
permission-denial announcement; the browser suite includes an unsuppressed axe
scan and 390 px overflow/Serial-focus checks (TASK-079). Commands, external trace
formats, process ownership, and the accessibility checklist are documented in
[the runbook](docs/operations/runbook.md). All evidence CLIs without input exit 2
(`BLOCKED_EXTERNAL`) with a blocked report; target GPUs
(TASK-073), multi-hour soak (TASK-082), and clean-machine release sign-off
(TASK-083) remain open, and no publication happens automatically.
