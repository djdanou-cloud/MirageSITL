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
status fields, sensor/actuator queues, and Control Protocol v2. EKF/EW values stay
unset until an autopilot and EW engine exist. ABI v1 remains in `packages/protocol`
with its tests but is no longer used by the application.

JSBSim/BET WASM, ArduPilot SITL/HITL, EW, photorealistic terrain, FPV/thermal
effects, and AAR are planned. The current aerodynamics are simplified and
have not been validated for pilot training.

The Phase 0 foundation adds deterministic seeded streams, SHA-256-verified
synthetic fixture manifests, and strict model/frame/inertia/rotor validation.
Models are admitted to an immutable session registry; runtime model switching
remains a later task. See the architecture guide for the serialized contracts.

Startup checks secure context, isolation, SharedArrayBuffer, Worker, and WebGL2.
Missing requirements disable Start with an explanation; missing Gamepad disables
USB input. Failed WebGPU probing preserves WebGL2. Serial API availability is
reported separately: HITL and WebGPU rendering are not implemented.

## Quickstart

TASK-042 now also has a separate native Linux/WSL ArduCopter integration driver:
real firmware flies a synthetic quad through our Rust rigid-body WASM and the
JSON/MAVLink interfaces. Its scored flight and original telemetry are audited
separately. This does not change the browser demo or resolve measured aircraft
fidelity. See the [SITL procedure](docs/operations/runbook.md).

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
ticks while paused. Dedicated lint/typecheck commands are available. Rust 1.97.0 and the wasm32 target are required for the WASM tests;
see CLAUDE.md for toolchain commands. GitHub Actions runs independent unit, browser, and build jobs
on pull requests and pushes to main. Unit JUnit reports, browser JUnit/HTML
reports and failure traces, and build logs/artifacts are uploaded even after
failure. The automated tooling checks include unsafe-type fixtures and
nonzero exit status when either runner discovers no tests.

400 Hz is a fixed **integration timestep**, not a browser hard real-time
guarantee. Catch-up is bounded to eight steps and dropped wall intervals are
visible in the UI. Target 60–120 FPS and 400–1200 Hz require production
measurements on Apple Silicon M4 and RTX 4050. Cloud headless smoke cannot
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
in the same task and run `npm run check:docs`. See CLAUDE.md for the complete
workflow, zero-allocation rules, deterministic math requirements, and evidence
needed to mark a task DONE.


Independent motor, battery, arbitrary-frame wrench and rigid-body RK4 references
are available in `native/bet`, with a real WASM body adapter and ideal/noisy
sensor package. The demo Worker still uses its existing demo dynamics; the full
BET backend is not wired. Rapier sphere/plane contacts run as an experiment
(allocation gate blocked). JSBSim has pinned build/bridge sources and a verified
native smoke. The 2026-10-18 Windows retry also builds the actual pinned WASM
artifact and passes Chromium Worker smoke at 400/800/1200 Hz; native/WASM
trajectory parity remains open. Aircraft XML is excluded from the artifact. The model
validation CLI reports numerical results separately and exits 2 until physical
reference data and integration gates are satisfied. See
[implementation contracts](docs/SPECS_SIMULATION_ENGINES.md).


Latest retry: opt-in `--patched` native Rapier/JSBSim runs now pass million-step
allocator probes with zero calls/bytes and matching original trajectory checksums.
The original builds still allocate. `node scripts/check-engine-patch-parity.mjs`
checks report/source/patch identities before comparison. Patches preserve storage
rather than changing physics. See the native allocation patch section in the
engine specification for exact scope, commands and limitations. These native
results do not certify the production Rapier JS/WASM binding, a JSBSim WASM build,
contact coupling or physical fidelity. The later 2026-10-18 local WASM build and
Worker smoke resolve the local SDK/artifact blocker; measured-data, trajectory
parity and production allocation gates remain open.

The first measured fixture, `tests/fixtures/contact/nasa-drop.json`, holds the
NASA TM X-3561 level-surface landing-gear drops
(https://ntrs.nasa.gov/citations/19780003109). It was generated from the
hashed Docling archive in `tests/fixtures/contact/nasa/` by
`tests/fixtures/contact/generate_nasa_drop.py` and converted to SI. Against
it, the Rapier sphere contact passes impulse, nonpenetration and energy
consistency. It fails the measured deceleration (-1.6 g) and stroke envelopes,
and that historical failure is preserved in
`test-results/validation/nasa-drop-legacy.json`. The user's 2026-10-18 NASA
deferral is explicit in reference manifest v2/report schema v5; contact fidelity
is blocked without an active measured comparison, not passed.


TASK-037/038/039/040/048/052/053/056/057/060 add a pinned MAVLink2 subset,
versioned radio calibration/mode mapping, autopilot lifecycle admission, an
origin/token-checked loopback WS/UDP bridge, gesture-driven Serial transport
with a separate I/O decoding Worker, isolated EW/motor-fault components and a
fail-closed terrain policy. The demo remains the active flight backend; no
SITL/HITL, complete EW composition or live terrain integration is enabled.

Run npm run start -w @mirage/bridge with MIRAGE_BRIDGE_TOKEN supplied locally
(64 hex characters); optional MIRAGE_BRIDGE_ORIGIN, MIRAGE_MAVLINK_PORT and
MIRAGE_PHYSICS_PORT configure origin/UDP endpoints. Never print tokens or add
them to URLs/repository files. This is loopback ws; HTTPS/WSS/PNA needs separate
integration. Use node scripts/bench-links-ew.mjs all 400 (also 800/1200) for
Node allocation evidence, not hardware timing acceptance. Scalar conveniences
may box floating-point values: high-rate composition uses typed-array inputs
and outputs documented in the engine specification.


## Local thermal, instructor and AAR increment

The demo includes a NED attitude HUD with explicit unknown/stale autopilot status, an ACK-driven instructor console, and a bounded session recorder. Use **Start recording**, fly the demo, then **Review recording** or **Export session**. **Import AAR** opens a validated snapshot timeline without replacing the active flight. Recording is decimated Main-thread truth/pilot sampling at nominal 10 Hz; FC sensor/actuator streams remain unavailable in demo. The 30 minute ring uses 9,216,000 record bytes, with separately counted losses and eviction. Archive size is limited to 32 MiB and arbitrary metadata/keys/serial identifiers are excluded.

Instructor shortcuts are P pause, R reset and F selected fault; typing focus suppresses shortcuts. Weather/fault/model requests show the actual demo backend rejection until a supporting production backend is wired. The thermal package supplies a synthetic surface-energy solver, WebGL2 LWIR material and deterministic offset calibration, tested independently from the active scene. It does not claim measured CADEX fidelity.

TASK-043 warmup modules require autopilot-sourced diagnostics; live ArduPilot flight/warmup and the dependent UI acceptance gates remain blocked on TASK-042. Node allocation evidence for the recording producer is generated by `node scripts/bench-aar.mjs 400` (repeat at 800/1200); it does not certify browser scheduling or hardware performance.

## Local acceptance tooling and training modules

The repository now includes collision-chunk construction/ownership, deterministic scenario scheduling/rubrics, and local SITL/HITL/EW/GPU/system/release evidence tools. These independent modules do not enable a validated production flight backend. Missing firmware drivers, FCs, target GPUs, frozen EW traces and clean-machine release evidence remain explicit blockers. TASK-044 records the observed native HAL requirements; TASK-045–047 remain open.

Keyboard users can skip to controls and receive visible focus and one permission-denial announcement. The browser suite includes an unsuppressed axe scan and 390px overflow/Serial-focus checks. Run the normal verification gates before trusting a change. New commands, external trace formats, process ownership and the accessibility checklist are documented in [the runbook](docs/operations/runbook.md). All new evidence CLIs without input exit 2 with a blocked report; no publication happens automatically.

TASK-029/031 now provide numerical contact and JSBSim backend/allocation evidence; those passes do not establish measured aircraft fidelity. TASK-033 preserves the failed historical NASA comparison under explicit user deferral and still reports failed UIUC propeller fidelity. Its source-backed annular BEM sensitivity diagnostic adds local momentum, losses and swirl without changing the fixed tolerances or production backend. See the engine specification and UIUC data guide for source roles, commands and remaining polar limitations.

TASK-043 now connects the existing EKF monitor and 30-second warmup gate
to the native SITL driver. Readiness uses actual diagnostics and acknowledged
sensor timestamps, measures simulation acceleration, and revokes EW admission
when freshness or health fails. This native gate does not enable browser READY
or apply EW effects. See the operational runbook for capture/replay commands.


TASK-059 native EW experiments use the pinned ArduCopter installation and synthetic quad. See the operational runbook for six-case acquisition, independent raw-wire/physics audits, one-time calibration and separate validation against fixed firmware-specific limits. These results do not enable browser autopilot READY or establish measured aircraft fidelity.


TASK-045 now has a local ArduPilot browser artifact diagnostic, real Worker/pthread boot and persistent EEPROM checks. The artifact stays external and is served only with an explicit loopback development setting; see the operational runbook. The active flight backend remains the demo while TASK-046/047 integrate and verify the WASM firmware.
