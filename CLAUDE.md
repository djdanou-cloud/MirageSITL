# CLAUDE.md — MirageSITL agent instructions

English is the repository source of truth. [Russian mirror](docs/ru/CLAUDE.md).
Read this file **before every iteration**, then the selected TASK in
[PROJECT_ROADMAP.md](docs/PROJECT_ROADMAP.md), the affected contract in
[SPECS_SHARED_MEMORY.md](docs/SPECS_SHARED_MEMORY.md) and/or
[SPECS_SIMULATION_ENGINES.md](docs/SPECS_SIMULATION_ENGINES.md), and current code.
User instructions and execution-environment restrictions take precedence.

TASK-042 continuation on 2026-10-19 supplies `scripts/sitl/driver.mjs` and a
pymavlink 2.4.50 sidecar. The full harness runs on Linux/WSL with pinned native
ArduCopter and existing Rust rigid-body WASM using an explicitly synthetic
quad X model. `scripts/check-sitl-capture.mjs --input CAPTURE_DIRECTORY` checks
full-rate physics, original telemetry, source identities and trace v2. This
supersedes historical claims below that no local driver/native flight exists.
It does not validate measured aerodynamics, production browser sessions, HITL
or arbitrary terrain. Do not enable browser autopilot READY from this offline
integration. Follow the runbook's Linux environment and owned-process scope.

TASK-029 completion on 2026-10-18 supersedes the historical contact allocation
blockers below: the verified direct f64 Rapier C ABI passes native/WASM G1,
synthetic compliance/contact checks and browser Worker execution. Build it with
`node scripts/build-contact.mjs`; cold-initialize `GroundContact` with its bytes
and manifest. `node scripts/check-contact-binding.mjs` records same-source parity
and nine million native steps; unit tests separately count nine million WASM
steps. NASA measured fidelity was explicitly deferred by the user; preserve its
archived failing legacy comparison. This does not certify aircraft calibration,
arbitrary terrain, target-device timing or a complete JSBSim/BET flight backend.

TASK-031 continuation uses `node scripts/build-jsbsim.mjs --contact` for the
instrumented JSBSim contact artifact with native WASM exceptions. The ordinary
legacy JS-exception artifact remains separate and fails JS GC admission.
`node scripts/check-jsbsim-backend.mjs --native` captures GNU native references;
`node --experimental-transform-types scripts/check-jsbsim-backend.mjs` checks
actual WASM parity/allocator behavior; `node scripts/bench-jsbsim.mjs` measures
the real JS adapter separately. The native runner supports WSL on Windows with
MIRAGE_JSBSIM_NATIVE_CMAKE selecting its Linux CMake executable. Read the engine
spec's additive contact/initial-state ABI before coupling. Built-in active gear
and external contact cannot both supply a reaction in one tick. Demo selection,
full weather/model/flight-session wiring, aircraft redistribution and measured
calibration remain separate; native/WASM parity does not enable autopilot READY.

## 1. Mandatory repository language

All source code, TypeScript types, identifiers, inline comments, log/error/UI
messages, tests, fixtures containing explanatory text, commit messages, PR titles/
descriptions, and primary documentation **MUST be in English**. Mathematical
symbols, unit notation, opaque external identifiers, and actual user input are
not prose translations. Do not introduce static Russian text into runtime code.

Russian prose belongs only in `docs/ru/`. All system specifications, roadmaps,
architecture guides, README, and these agent instructions have Russian mirrors.
English source locations are repository root or `docs/`; all mirrored files
preserve their basenames under `docs/ru/`. Never maintain a second Russian
specification in root or elsewhere under `docs/`.

### Documentation synchronization protocol

1. Change the English source first. Read its registered pair in
   `docs/documentation-index.json`. A new guide/spec requires a new mirror pair.
2. In the **same task/change**, update the complete Russian mirror, including
   affected interfaces, equations, byte tables, TASK IDs/dependencies, DoD,
   commands, and implementation status. Do not replace the mirror with a summary.
3. Keep fenced code/JSON/shell listings and displayed equations identical in
   both versions. Code comments inside the Russian mirror remain English.
   Translate prose and table explanations while preserving technical values.
4. Use links relative to each document's actual directory. README maps to
   `docs/ru/README.md`; root CLAUDE maps to `docs/ru/CLAUDE.md`; English
   `docs/<FILE>.md` maps to `docs/ru/<FILE>.md`.
5. Review semantic parity, then update the mirror's `source-sha256` metadata
   to the SHA-256 of the complete English file. Never refresh this hash merely
   to silence a failing check. A hash detects staleness, not translation quality.
6. Run `npm run check:docs`. Record bilingual synchronization in task evidence.
   No architecture/spec task is DONE with a missing/stale mirror. If the
   English contract changes in a later task, update both languages again.

Claude Code loads this root file through its own discovery mechanism. Do not
assume Codex/Cursor automatically read CLAUDE.md. TASK-084 added AGENTS.md and
`.cursor/rules/project.mdc` as thin pointers to this file rather than duplicate
policy copies; if a client loads neither pointer, open this file explicitly.

## 2. Actual baseline and scope

The pulled baseline `9ce0da1` runs ABI v2 with epoch-aware rendering,
400/800/1200 Hz clocks, SPSC transport, and the demo backend. V1 remains a
regression API. The Rust 1.97.0 workspace, scalar/SIMD WASM builds, checked
C ABI arenas, and polar lookup exist. TASK-032 and TASK-020–023 add atmosphere,
seeded wind, and native rotor reference kernels with test-only WASM exports.

Production BET arena stepping still reports AERODYNAMICS_UNAVAILABLE: polar
binding and a complete backend are not wired. Independent native JSBSim,
MAVLink2, local transport and EW/fault references now exist. Production JSBSim,
ArduPilot SITL/HITL, composed EW, live terrain, thermal and AAR integrations remain
open. Numerical tests do not
establish validated autorotation or target-device performance. Historical
results do not verify new changes; run the selected gates again.

Use the existing checkout (`/workspace/MirageSITL` in cloud). Cloud tasks are
already isolated; create another worktree only on explicit user request.
Start with `git status --short`, preserving other people's changes. Never
reset/clean or overwrite user files. Commit/push/deploy only within explicitly
authorized scope; a new task does not automatically authorize publication.

## 3. Commands available now versus planned

Run from repository root with Node 24 LTS (`.nvmrc`) and the npm lockfile:

```bash
npm ci
npm run dev
npm run build
npm test
npm run check:docs
npm run lint
npm run typecheck
npx --no-install vitest run tests/protocol.test.ts
npx --no-install tsc --noEmit
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
node scripts/bench-physics.mjs
node scripts/bench-wind.mjs
node scripts/bench-sensors.mjs all
node scripts/bench-sensors.mjs body
node scripts/validate-models.mjs
node scripts/build-jsbsim.mjs
node scripts/check-jsbsim-native.mjs
node scripts/bench-contact.mjs
node scripts/check-contact-native.mjs
cargo check --manifest-path native/Cargo.toml --workspace --locked
cargo test --manifest-path native/Cargo.toml --workspace --locked
cargo check --manifest-path native/Cargo.toml -p mirage-bet --target wasm32-unknown-unknown --locked
```

TASK-002 is implemented: `npm run lint` applies typed rules to TypeScript and
recommended JavaScript rules to tooling; `npm run typecheck` runs strict tsc.
TASK-003 adds independent GitHub Actions unit/browser/build jobs on pull
requests and pushes to main. Unit JUnit results, browser JUnit/HTML/traces,
and build output/logs are retained even after failure. Hosted execution must
be checked separately from successful local jobs.

`npm run build` already runs `tsc --noEmit` and Vite build. `npm test` means
`vitest run`; select focused tests by an existing exact path. Omit CHROMIUM_PATH
when using Playwright's browser. If needed, install it separately with
`npx playwright install chromium`. When the cloud home cache is unwritable,
use `npm ci --cache /workspace/.cache/mirage-npm --no-audit --no-fund`.
Do not change HOME or disable TLS/signature/checksum verification.

TASK-014 adds `node scripts/bench-physics.mjs` (re-executes itself with
`--expose-gc --max-semi-space-size=64 --single-threaded`). It writes
`test-results/bench/physics.json` (schema `docs/benchmarks/schema.json`):
a zero-allocation verdict for the real PhysicsSessionV2 step after reaching
steady state, compute p50/p95/p99/max, timer overhead, and real-time wakeup
lateness/executed Hz. It runs in Node; it is not browser or target-hardware
evidence.

TASK-016 adds the `native/` Rust workspace (crate `mirage-bet`). The toolchain
is pinned in `native/rust-toolchain.toml` (1.97.0 + wasm32-unknown-unknown);
rustup reads it from the current directory, so run cargo inside `native/`
(or install the same toolchain) for pinned results. The wasm32 build has a
trapping global allocator and no imports.

TASK-017 adds `node scripts/build-wasm.mjs [--out dir]`: it builds the
`scalar` and `simd128` artifacts into `packages/wasm-bet/dist/` (ignored)
with `manifest.json` (SHA-256, bytes, ABI read from the module, toolchain).
`@mirage/wasm-bet/loader` validates the manifest, selects SIMD only after
feature detection, verifies size/hash/ABI/exports, and reserves the memory
budget before arming. `tests/wasm-loader.test.ts` runs the script, so unit
tests need the pinned Rust toolchain.

`node scripts/run-sitl.mjs` now exists as a bounded owned-process harness and
flight-trace validator. It requires pinned source, a native ELF+SHA-256 and a
trusted local closed-loop driver+SHA-256; the production driver is not supplied.
Missing prerequisites produce BLOCKED_EXTERNAL (exit 2). A passing child-process
or structural trace test is not proof that ArduPilot flew. See the operational
runbook for environment variable names, trace schema and ownership limitations.

Cargo check does not validate physics or browser execution: run native tests,
WASM smoke, and reference parity too. Install missing targets through the
supported toolchain, never report an unrun/skipped check as passed. Future
test/DoD commands are requirements, not completed execution records.

Dev/preview must send COOP `same-origin` and COEP `require-corp`. External
WASM/tiles/textures must satisfy CORS/CORP. Do not disable isolation to load
an asset. Production hosting must configure these headers separately.

## 4. Executing one TASK-XXX

1. Read Dependencies, Touched Files, Interfaces, and DoD completely. Verify
   dependency evidence against code/tests, not just a DONE label. Do not build
   downstream functionality on a missing contract.
2. Record IN_PROGRESS with owner, baseline SHA, goal, and failure criterion.
   Before changing an additional file/interface, update the task/contract and
   explain why. Do not silently expand scope.
3. Find existing runners, fixtures, and patterns. Add a focused failing test
   for the required behavior/bug. A missing-import error alone is not a physics
   test: once the module exists, assertions must check an independent oracle.
4. Implement the smallest complete capability increment. Avoid scaffolds that
   return success without doing work. Contract changes require byte fixtures,
   a version bump, and migration/rejection tests.
5. Run the focused test, typecheck/lint, affected regressions, then required
   build/browser/native/integration checks. Documentation-only work checks
   structure/task references/DAG/links/layout/listings rather than adding
   meaningless runtime tests.
6. Meet G1 for hot paths, G2 for numerical/codec work, G3 for performance, and
   G4 for hardware/provider integration. Mocks cannot satisfy real-device or
   credential-dependent gates.
7. Update the English architecture/spec/roadmap and the matching Russian
   mirror in the same change. Preserve full technical depth and update source
   hash metadata only after review. Run `npm run check:docs`.
8. Save exact commands, exit codes, counts, report paths, seed, units, toolchain,
   model/firmware/source hashes, and hardware/browser details. Do not put secrets
   or huge external datasets into fixtures.
9. Mark DONE only after local and common DoD. Use BLOCKED_EXTERNAL or
   BLOCKED_DECISION for precise missing inputs and record independent results.
   Never lower thresholds, disable assertions, or regenerate goldens from the
   implementation output merely to pass.
10. Run `git diff --check`; review diff/untracked files and ensure outputs,
    node_modules, and secrets are not staged. Report changes, actual checks,
    and missing capabilities. Take the next task only within authorized scope;
    a request to edit documentation does not authorize the whole backlog.

Evidence template, **not a completed result**:

```text
TASK-020: IN_PROGRESS
Baseline: <sha>; Owner: <agent>
Contract: docs/SPECS_SIMULATION_ENGINES.md sections 2–3
Tests: cargo test ... --test blade; exit=<code>; executed=<N>
Oracle: <fixture id and source hash>; tolerance=<absolute/relative>
Artifacts: <report path>; hardware=<device or not required>
Documentation: <English path> + <Russian path>; check:docs=<result>
Remaining: <none or exact external blocker>
```

## 5. TypeScript, interfaces, and code style

* Use strict and noUncheckedIndexedAccess. **No any**: explicit assertions,
  unsafe inferred values from imports/JSON, or lint suppression to bypass this
  rule. External data starts as unknown and becomes a domain type after schema/
  type-guard validation. TASK-002 implements repository-wide typed linting with ESLint 10 and typescript-eslint; inline suppression is disabled by the lint command.
* `as unknown as T`, non-null assertions, and array-index assertions require
  a proven platform/bounds invariant, a test, and explanation. They cannot
  replace validation of external payloads. Trusted local module imports may
  retain their statically known namespace type.
* Use discriminated unions for lifecycle/faults and exhaustive switches with
  never. Reject unknown network/control messages. TS types do not validate bytes.
* Name units explicitly (M, Mps, RadS, Pa, Gauss, Us), require finite values,
  document frames, and use degrees only at wire/UI boundaries. Document
  quaternion order, normalize output, and treat q/-q as equivalent.
* Use readable named modules/functions, not minified source. Keep aerodynamics
  out of React. Numerical constants require provenance/validity envelopes;
  undocumented correction factors are forbidden.
* Use frozen installs. Dependency changes must be necessary for the task and
  include manifest/lock/reproducibility validation. Do not hide build warnings
  by raising thresholds without analyzing requirement impact.

## 6. Zero-allocation physics loop

The hot path includes integration, sensors, EW, actuator mapping, SAB packing,
and callbacks they invoke on each of 400–1200 steps/s. After initialize/reset:

* Never create objects, arrays, tuples, typed views, closures, strings, Error,
  Promise, BigInt values, iterators/generators, or temporary Three vectors.
  No spread/rest/map/filter/flatMap, JSON, console, fetch, postMessage, or React
  setState inside step.
* Allocate arenas/scratch/outputs/RNG states once. Use indexed numerical loops
  and `stepInto(input,out)` to mutate preallocated outputs. Bound rotor/element/
  volume/queued-command counts by contract.
* Validate/load configuration outside step. Apply scalars/IDs from preallocated
  slots at tick boundaries. Write ACK/events to a bounded outbox, creating and
  sending object messages after the compute batch rather than inside step.
* Rust step must not reallocate Vec, collect, Box, format, allocate, or panic
  during normal operation. Use checked bounds/error flags. C++ must not call
  new/malloc or grow strings. No memory.grow after arming.
* Measure allocator calls/bytes in native/WASM and instrument explicit JS
  allocations. Constant heap size alone does not prove zero allocations:
  allocation/free may leave size unchanged. Record warmup, profiler overhead,
  and excluded host/timer operations separately.
* A dedicated Worker reduces Main-GC coupling, but gives no hard real-time
  guarantee. Fixed dt never depends on render FPS. Apply the overload policy
  and expose dropped intervals. Main must never call Atomics.wait.

## 7. WASM, SIMD, and deterministic numerical routines

Require a scalar reference. Feature-detect SIMD128; baseline execution cannot
require SIMD. Do not enable relaxed-simd/fast-math by default. Make reduction
order and tail-lane behavior explicit. Limit unsafe to narrow, checked ABI/SIMD
sections with documented invariants/tests.

Physics/geodesy use float64 by default; rendering receives local float32.
WASM ABI uses fixed repr(C), explicit strides, checked pointers/counts/alignment,
and no Rust references/Vec/enum layout assumptions. Views cannot survive a
replaced memory buffer; memory stays stable throughout step.

Set numerical tolerances from the spec/fixture **before** implementation.
Do not promise bit-identical CPU/GPU/native/WASM results. Equal seed/runtime
must reproduce sensor/EW scenarios. Test SIMD tails 1/3/5/63 and scalar
fallback. Diagnose parity differences and justify an error budget instead
of applying arbitrary epsilons. Keep RNG algorithms, stream IDs, and event
ordering fixed independently of render FPS.

## 8. Inter-thread and external control loops

* One writer per region. State/pilot use atomic int32 seqlocks; sensors/
  actuators use SPSC ownership. Never access shared Float64Array directly.
  Decode outputs only after successful seq/head validation.
* Epoch/model changes break interpolation/replay history. Reserved v1 fields
  cannot acquire new meanings without migration. Check actual byte offsets
  and golden records, not merely TS interface sizes.
* ArduPilot JSON physics and MAVLink RC/telemetry are separate channels.
  RC sentinel meanings depend on channel group. Serial/WS parsing validates
  CRC, IDs, schemas, and bounds; stream chunks are not messages.
* Request Web Serial permission through a gesture. EKF fast-forward is SITL
  only. A 30 s timer does not establish EKF health. Display autopilot-sourced
  EKF status with freshness rather than deriving it from truth.
* EW changes observations, not truth. Motor faults separately affect physics
  actuators. Do not claim EKF gate bypass or guaranteed mode changes without
  pinned integration evidence.
* AAR uses a separate recorder with explicit gaps/provenance. Never attach
  two consumers to one SPSC queue; fan out into a separate bounded recording
  queue at the producer/I/O boundary.

## 9. Data, rendering, and measurement

Google live tiles require attribution, CORS/COEP, and provider policy.
Do not enable persistent R2 caching/prefetch without permission. Owned/licensed
datasets have a separate authorized cache policy. API keys/secrets never belong
in client bundles, the repository, logs, fixtures, or chat.

WorldCover/OSM classes are not temperatures, and AO is not a heat solver.
Do not claim CADEX fidelity without instrument data. Mark synthetic effects
in manifests. Shader effects cannot mutate truth.

FPS/Hz evidence records device/browser/OS/quality/resolution, warmup/duration,
p50/p95/p99, compute duration separately from wall lateness, actual executed
step rate, and drops. Fake-clock unit tests and cloud software GPUs do not
establish M4/RTX 120 FPS. Save functional results while leaving unavailable
hardware gates open.

## 10. Documentation is an executable contract

Preserve TASK IDs, an acyclic dependency graph, and valid links/paths.
Assign unused IDs to new tasks without renumbering old ones. Contract changes
update source/spec/fixtures and both documentation languages together.
A generated interface or document alone is not a completed runtime capability.

`npm run check:docs` checks the registered pairs, English/Russian separation,
source hashes, identical fenced contracts/equations, task dependencies, and
layout coverage. It cannot judge the semantic quality of a translation;
agents must review that explicitly. Root and docs sources are English;
only `docs/ru/` contains Russian prose. Recheck package.json/HEAD before the
next code task and update this baseline only from observed implementation.


TASK-025–035 add independent propulsion/body/sensor references, a Rapier contact
experiment and pinned JSBSim build/adapter sources. They do not complete the
production BET backend. `bench-sensors.mjs all` requires Node 24 and warms four
million ticks before measuring; `validate-models.mjs` exits 2 when numerical
cases pass but fidelity is blocked. `build-jsbsim.mjs` requires verified
JSBSIM_SOURCE_DIR and MIRAGE_EMSDK_DIR checkouts plus an installed Emscripten 4.0.15.
The 2026-10-18 Windows retry verifies that SDK and passes actual WASM Worker
smoke via `node scripts/check-jsbsim-artifact.mjs` at 400/800/1200 Hz. Aircraft
XML remains local test input, excluded from artifacts. Native/WASM trajectory
parity remains open; never substitute smoke for parity. Rapier and JSBSim
adapters are not high-rate certified.

Retry checks: check-jsbsim-native.mjs verifies native trim/frames and a million
steps in 250 bounded windows; it exits 2 on a failed allocator gate.
check-contact-native.mjs requires the pinned Rapier checkout from
native/rapier/source.lock.json and builds outside the repository.
bench-contact.mjs exercises repeated contact and must retain GC observation.
These diagnostic failures are real blockers; never mark an engine high-rate
certified from passing boundary tests or steady memory size.


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


## Local batch after baseline 660d86e

The thermal library now has a synthetic energy solver, LWIR WebGL2 material and offset-only NUC. The demo UI has a source/freshness-aware attitude HUD, real Worker command ledger and a Main-decimated AAR recorder/review/archive flow. The new recorder Worker owns a separate SAB and bounded IndexedDB chunks. Do not describe this as full-rate synchronized sensor/actuator recording, complete resimulation or measured thermal fidelity.

`EkfMonitor` parses the pinned ArduPilot diagnostic frames and `EkfWarmup` provides a 30 simulated second admission gate. Actual firmware execution/fast-forward integration remains blocked by TASK-042; TASK-043/074/075/078 must retain that gate. Do not enable autopilot READY merely because module/unit/browser tests pass. Unsupported demo weather/fault/model commands are intentionally rejected and must remain visibly rejected until their backend exists.

Use `node scripts/bench-aar.mjs 400`, also 800 and 1200, to measure the actual recording encode/SPSC producer graph with allocation controls. Recorder I/O, snapshot/archive copies, thermal integration and React/chart decimation are outside the high-frequency loop. Run all unit tests and browser tests with the repository-pinned Rust toolchain active because existing WASM tests invoke Cargo. User authorization for this batch is local commits only; do not push until explicitly instructed.


## Local continuation after c3a4735

TASK-042/044/051/059/065/073/079/080/082/083 add independent acceptance tooling,
collision lattice ownership/queries, scenario schema/tick polling/rubrics and
keyboard/permission accessibility. Read docs/operations/runbook.md and the latest
engine contract before using them. Hardware/live flight, browser firmware,
production terrain-contact coupling and scenario ACK orchestration remain open.
TASK-044 records a negative feasibility decision; TASK-045–047 remain open.

The new CLI analyzers use --input PATH --sha256 HEX and bounded real captures.
No input yields BLOCKED_EXTERNAL/2; invalid evidence or failed limits yields 1.
Reports do not enable a mode. System/release tooling preserves FAIL separately
from missing evidence. The pulled NASA contact comparison already fails its
measured deceleration/stroke envelopes: validate-models.mjs reports numerical
PASS, contact FAIL and overall failed (currently exit 2). Do not describe that
as a merely missing dataset or relax thresholds to hide it.

Use node scripts/bench-terrain-scenarios.mjs 400 (also 800/1200) for warmed Node
allocation evidence. High-rate terrain calls use sampleInto/readyFrom; building,
staging, JSON/provenance checks and outcome analysis are cold. Stage/publish
memory is byte-capped; missing ground never becomes ready. Scenario polling
returns indices; the integration owner must bind epochs and verify ACKs. Physical
FC, target GPU, clean-machine release and assistive-screen-reader checks remain
external. Keep this continuation local; do not push without user instruction.

TASK-043 native continuation (2026-10-19) composes LiveEkfWarmup with the
actual driver. Its explicit JSON lockstep IMU clock uses acknowledged encoded
samples; CRC-checked MAVLink supplies EKF/heartbeat/GNSS and a separate reported
IMU clock. Replay with scripts/check-ekf-warmup.mjs after the raw MAVLink audit.
READY/EW admission revokes on stale sensors or diagnostics; physical HITL and
browser READY remain separate. TASK-042 reports are historical snapshots when
their input sources change; keep the new native regression report separately.
