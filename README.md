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

The current binary ABI is **v1**. Specifications define a separate **target v2**
with EKF/EW status, session epochs, and sensor/actuator queues. The v2 layout, codecs,
atomic transport, and Control Protocol v2 processor exist (TASK-008/009/010), but the
running application still uses v1 until TASK-085.

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
packages/protocol/    ABI v1 and atomic readers/writers
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
ticks while paused. Dedicated lint/typecheck commands are available. Rust/Cargo tooling remains
a future task. GitHub Actions runs independent unit, browser, and build jobs
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
