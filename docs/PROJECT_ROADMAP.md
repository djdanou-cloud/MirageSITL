# PROJECT_ROADMAP.md

Version 1.3 · 2026-10-28 · baseline `4593971` for the status summary below. English is the source of truth.
[Russian mirror](ru/PROJECT_ROADMAP.md).

Future modules are not claimed as implemented. The active browser application runs on ABI v2 (`49280` bytes, `192`-byte state stride) with `400/800/1200` Hz clocks, SPSC sensor/actuator queues, epoch-aware rendering, decimated Pilot HUD / Instructor / AAR flows, and the demo dynamics backend (`540` unit tests across `97` files, Chromium browser suites, and `62` native Rust tests). Independent native/WASM rotor kernels, direct `f64` Rapier landing-gear contact (`TASK-029`) and collision-chunk coupling (`TASK-065`), pinned JSBSim v1.2.3 WASM/contact (`TASK-030`/`031`/`086`), native Linux/WSL ArduCopter SITL flight, `LiveEkfWarmup`, and EW fault regressions (`TASK-042`/`043`/`059`), and ArduCopter WASM Worker/EEPROM boot (`TASK-045`) are verified in their respective harnesses. Production BET C ABI polar binding and configurable session injection are now verified by TASK-033. TASK-046 verifies the browser HAL clock/sensor/PWM boundary and owned-Worker teardown. Browser autopilot `READY`, measured model fidelity (separate from the TASK-033 synthetic baseline), ArduPilot Simulation-on-Hardware and virtual Hybrid SITL (`TASK-051`), target GPU 10-minute profiling (`TASK-073`), full-rate recording and accessibility sign-off (`TASK-078`/`080`; TASK-074, TASK-075, and TASK-079 are done), and release sign-off (`TASK-082`/`083`) remain open. The physics fidelity program (Phases 7–13, TASK-087–TASK-123) is registered; TASK-087–TASK-090 are in progress and the rest is not implemented. Version 1.3 registers the product Phase 1 program (TASK-127–TASK-191) from the approved [PROJECT_SCOPE.md](../PROJECT_SCOPE.md) of 2026-10-28, which governs product scope; [PHASE1_PLAN.md](PHASE1_PLAN.md) maps it to the existing work. Registration implements nothing.

Contracts: [Approved scope](../PROJECT_SCOPE.md), [Phase 1 plan](PHASE1_PLAN.md), [Shared Memory](SPECS_SHARED_MEMORY.md),
[Simulation Engines](SPECS_SIMULATION_ENGINES.md), [V2 Architecture & Verification Plan](V2_PLAN.md), and [Agent workflow](../CLAUDE.md).
Document generation itself does not implement runtime changes.

## Executing the backlog

One TASK is one independently verifiable capability increment, normally one PR.
Every dependency must be DONE with evidence first. IDs are stable identifiers,
not execution order: for example TASK-032 atmosphere precedes TASK-020.
For research/data/hardware work, complete independent fixtures/tooling first;
missing external input becomes BLOCKED_EXTERNAL. Synthetic smoke cannot replace
physical-model or hardware acceptance.

Statuses: TODO -> IN_PROGRESS -> DONE, with BLOCKED_EXTERNAL,
BLOCKED_DECISION, and FAILED_VALIDATION alternatives. Record status/evidence
under each task and preserve its ID. Test paths below are planned deliverables,
not claims that the files exist. Touched Files are exact paths; update the
task before editing an additional file.

IN_PROGRESS records owner, baseline SHA, selected contract, and failing test
command. DONE records commands, exit codes, executed test counts, artifact/report
paths, actual device/firmware/data versions, and remaining limitations.
Never remove required goals merely to make the report green.

## Common Definition of Done

Every local DoD includes G0. Apply G1 to hot paths, G2 to numerical/native/codec
work, G3 to performance work, and G4 to external hardware/provider integration.

* **G0 — correctness:** actually run focused unit/integration tests,
  typecheck/lint/build after TASK-002, and affected contract regressions.
  No disabled assertions, passWithNoTests, or automatic golden replacement.
  Documentation-only work checks structure/links/layout/listings instead of
  unrelated application suites. Run `npm run check:docs`; architecture/spec
  changes update the English source and matching `docs/ru/` mirror in the
  same change. Update the Russian source hash only after reviewing translation.
* **G1 — hot path:** after initialization/warmup, zero explicit JS/WASM
  allocations and zero allocator growth bytes over 1e6 steps; fixed capacities;
  no memory.grow/fetch/await/JSON/React/console inside step. Measure timer
  callbacks and browser GC separately; absolute GC isolation is not promised.
* **G2 — numerical/protocol:** record golden source/hash/units and tolerances
  before implementation. Scalar execution is mandatory, with SIMD fallback/
  parity. External values pass unknown/schema/bounds/CRC validation. Numerical
  precision in a synthetic model does not establish experimental validity.
* **G3 — performance:** visible tab, production build, 1920x1080, DPR=1,
  specified quality profile, M4 and RTX 4050 6GB; record browser/OS/power mode.
  Use 60 s warmup and 10 min measurement. On 2026-10-21 the user accepted a
  60 FPS median of 16.680 ms, a p99 of 17.665 ms, and a 59.88 Hz panel. The
  120 FPS profile still requires p99<=8.33 ms on a panel that can present it.
  Software-headless rendering
  does not establish target-device performance. Compute-only physics p99
  must be <=50% dt: 1.25/0.625/0.4167 ms at 400/800/1200 Hz. Separately report
  executed Hz within +/-1% over 10-s windows and wakeup lateness. Real-time
  acceptance requires zero dropped steps in the control run. Browsers provide
  no hard real-time guarantee: record a failed gate as a limitation/blocker,
  never increase dt or hide drops.
* **G4 — external evidence:** verify real FC/provider/datasets separately from
  mocks. Missing hardware/key/license/data means BLOCKED_EXTERNAL with the exact
  unblocking operation; never put credentials in chat/files. Working external
  SITL does not satisfy the HITL or ArduPilot WASM gates.

Terrain baseline budgets are <=2 GiB estimated resident GPU memory and <=512 MiB
decoded CPU cache; treat GPU memory as constrained and verify the profile.
BET WASM baseline arena is <=64 MiB. If budgets fail, change quality/configuration
within the declared envelope and rerun the gate. Changing thresholds requires a
recorded product decision.

## Sprints and phase gates

A sprint is an ordered batch of two to four tasks, not a calendar-duration
promise. Routine implementation choices need no repeated approval. Main phases
are sequential; capability probes and external-data preparation may start early.
Retain the minimal existing UI until Phase 6.

| Phase | Sprint batches | Exit |
| --- | --- | --- |
| 0 Skeleton | S00a: 001,002,084; S00b: 003,004,005,006 | Reproducible workspace, lint/CI/config gates |
| 1 Shared Memory & Worker | S01a: 007,008,009; S01b: 010,011,012; S01c: 013,014,015,085 | ABI v2, clocks, transport, profiling |
| 2 Aerodynamics & WASM | S02a: 016,017,018; S02b: 019,032,020; S02c: 021,022,023; S02d: 024,025,026; S02e: 027,028,029; S02f: 030,031,033 | BET/JSBSim backends with declared validity |
| 3 ArduPilot & Radio Link | S03a: 034,035,036,037; S03b: 038,039,040,041; S03c: 042,043; S03d: 044,045,046,047; S03e: 048,049,050,051 | Per-mode SITL/WASM/HITL evidence |
| 4 EW & Sensor Faults | S04a: 052,053,054; S04b: 055,056,057; S04c: 058,059 | Deterministic faults and pinned EKF scenarios |
| 5 Environment & Shaders | S05a: 060,061,062; S05b: 063,064,065; S05c: 066,067,068; S05d: 069,070,071,072; S05e: 073 | Licensed terrain, render profiles, target-GPU gates |
| 6 UI & Telemetry | S06a: 074,075; S06b: 076,077,078; S06c: 079,080,081; S06d: 082,083 | Training/AAR and evidence-backed release matrix |
| 7 Physics Fidelity Foundations | S07a: 087,088; S07b: 089,090; S07c: 091 | Manifest v2 and interface v2 frozen with fixtures, sensor-error ownership decided, a measured capture scored, BET compute within G3 |
| 8 Core Flight Dynamics | S08a: 092,093; S08b: 094,095; S08c: 096 | ArduCopter in both paths with a physical throttle curve, battery sag, wind, drag and compliant landing |
| 9 Advanced Rotor Aerodynamics | S09a: 097,098; S09b: 099,100; S09c: 101,102; S09d: 103 | UIUC rerun meets its declared target; ground-effect and descent behaviors compared with data |
| 10 Propulsion & Environment | S10a: 104,105; S10b: 106,107; S10c: 108 | Battery, motor-thermal, turbulence and Earth-field references met |
| 11 Airframe & Vehicle Classes | S11a: 109,110; S11b: 111,112; S11c: 113 | ArduPlane and QuadPlane missions with transitions in both paths |
| 12 Sensor Physics | S12a: 115,114; S12b: 116,117; S12c: 118 | Vibration, barometer and GNSS statistics match logged data |
| 13 Structures & Extreme Environment | S13a: 119,120; S13b: 121,122; S13c: 123 | Flexible-structure, mass-change and hazard-flow behaviors compared with data |
| P1.1 Feasibility & Decisions | P1.1a: 127,128,129; P1.1b: 130,131; P1.1c: 132,133 | macOS SITL, the 16-motor path, clock and pause, the log viewer, offline and terrain inventory, and acceptance and fidelity decisions recorded with evidence or exact blockers |
| P1.2 Scope Mapping | P1.2a: 134,135 | Documentation reconciled with the scope; the TASK-087–TASK-090 increments landed on main |
| P1.3 Data Foundation & Editors | P1.3a: 136,137; P1.3b: 138,139,140; P1.3c: 141,142,143 | Versioned projects, profiles up to 16 motors, component cards, calculation modes, output mapping and Sensors settings through the UI |
| P1.4 Approved Physical Models | P1.4a: 144,145; P1.4b: 146,147; P1.4c: 148,149 (with 087–101 and 106) | Profile-driven dynamics with propulsion, battery, aerodynamics, sensors, environment and basic contact within declared limits |
| P1.5 Integrated External SITL | P1.5a: 150,151,152; P1.5b: 153,154; P1.5c: 155,156,157; P1.5d: 158 | Nominal flight of every S19 configuration through the UI on macOS |
| P1.6 Recording & Parameters | P1.6a: 159,160,161; P1.6b: 162,163; P1.6c: 164,165 | Parameter read-back and export and full-run recording with provenance |
| P1.7 Tasks, Weather, Faults & Batches | P1.7a: 166,167; P1.7b: 168,169,170; P1.7c: 171,172,173; P1.7d: 174,175; P1.7e: 176,177 | Repeatable tasks, weather and fault schedules, EKF drift, run speed, batches and comparisons |
| P1.8 Log Analysis | P1.8a: 178,179; P1.8b: 180,181 | UAVLogViewer integrated with DataFlash and experiment logs and comparisons |
| P1.9 Experiments From Logs | P1.9a: 182,183,184 | Log-based experiments, re-simulation and fidelity evidence per profile version |
| P1.10 Visualization & Terrain | P1.10a: 185,186,187 | Geometry-driven views, terrain sources and contact on real terrain |
| P1.11 Acceptance & Delivery | P1.11a: 188,189; P1.11b: 190,191 | S19 executed on macOS with PASS, FAIL, BLOCKED and NOT_RUN recorded |

Rows P1.1–P1.11 are the product Phase 1 stages of [PROJECT_SCOPE.md](../PROJECT_SCOPE.md) section 3, detailed in [PHASE1_PLAN.md](PHASE1_PLAN.md); batch labels such as P1.1a are unrelated to the scope's requirement IDs S01–S19. Where the engineering phases above conflict with the approved scope, the scope governs product inclusion, and TASK-134 records each task's disposition.

ArduPilot WASM feasibility and HITL compatibility are mandatory separate gates.
If blocked, continue independent tasks without declaring all of Phase 3 or the
project DONE. Persistent Google caching is not assumed permitted: TASK-060 records
the licensing decision. TASK-064 caches an authorized dataset, such as owned
tiles. The 10–15 km goal remains a region-cache parameter, not permission to
copy Google content without rights.

## Phase 0: Skeleton

### TASK-001 — Preserve the working skeleton

- **Status:** DONE — revalidated against baseline c8814c6.
- **Title & Description:** Retain the existing React/Vite workspace and reproducible demo flight.
- **Dependencies:** none.
- **Touched Files:** `package.json`, `package-lock.json`, `apps/web/vite.config.ts`, `README.md`.
- **Interfaces / Contracts:** React 19, Vite, npm workspaces; COOP/COEP.
- **DoD & Acceptance Criteria:** DONE baseline e3bb6b4: npm ci, npm run build, 13 unit and 4 browser tests previously passed; clean installation leaves the lockfile unchanged.
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. Clean `npm ci` preserved the lockfile SHA-256; `npm run build` exit 0; 25 unit and 4 browser tests passed with 0 skips/failures.

### TASK-002 — Type and lint gates

- **Status:** DONE — implemented and locally verified.
- **Title & Description:** Add dedicated typecheck/lint commands and eliminate explicit or implicitly unsafe any, including the browser dynamic import.
- **Dependencies:** TASK-001.
- **Touched Files:** `package.json`, `package-lock.json`, `eslint.config.mjs`, `tsconfig.json`, `tests/browser/simulation.spec.ts`, `tests/tooling.test.ts`, `tests/fixtures/tooling/unsafe-types.txt`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** unknown with runtime narrowing; strict/noUncheckedIndexedAccess; typed module imports.
- **DoD & Acceptance Criteria:** npm run lint and npm run typecheck execute successfully; negative fixtures with explicit any and unsafe assignment fail; do not weaken strict settings to accommodate existing code.
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. ESLint 10 / `typescript-eslint` typed rules pass without inline suppression; `npm run lint` and `npm run typecheck` exit 0. `tests/tooling.test.ts`: 3 PASS (negative `any`/unsafe fixtures and `TS2322` verified).

### TASK-003 — Automated CI

- **Status:** DONE — implementation complete; hosted runs verified on 2026-10-16.
- **Title & Description:** Run pull-request checks without hardware or paid APIs.
- **Dependencies:** TASK-002.
- **Touched Files:** `.github/workflows/ci.yml`, `playwright.config.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package.json`, `package-lock.json`, `vitest.config.ts`, `.gitignore`, `tests/ci.test.ts`.
- **Interfaces / Contracts:** Node 24, frozen npm lock; separate unit/browser/build jobs.
- **DoD & Acceptance Criteria:** CI runs nonzero test counts and retains results/failure traces; no-tests and failed jobs fail the pipeline; synthetic checks require no secrets.
- **Evidence:** Owner Codex/Claude; verified 2026-10-16. Three independent CI jobs (`unit`, `browser`, `build`) in `.github/workflows/ci.yml` and `.github/workflows/native.yml` implemented; `tests/ci.test.ts`: 4 PASS (both runners reject zero-test invocations and verify toolchain pins). Hosted GitHub Actions run `38935251383` (PR `#2`, head `e28eb7c`) passed all three jobs (`test-results/unit/junit.xml` artifact `12060104387`, browser report artifact `12060348065`, production build); `native.yml` run `38935251375` also passed.

### TASK-004 — Golden fixtures and seed registry

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Define shared reference manifests with provenance and a deterministic PRNG.
- **Dependencies:** TASK-002.
- **Touched Files:** `packages/test-support/package.json`, `packages/test-support/src/fixtures.ts`, `packages/test-support/src/prng.ts`, `tests/fixtures.test.ts`, `tests/fixtures/registry.json`, `package-lock.json`, `tests/fixtures/ballistic.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** FixtureManifest {id, sourceSha256, units, validityEnvelope, tolerance}; PRNG algorithm/version.
- **DoD & Acceptance Criteria:** A known seed produces a frozen sequence; stream IDs are independent; invalid units/hashes fail validation; synthetic fixtures are never labeled experimental measurements.
- **Evidence:** Owner Codex; baseline c26df78; 2026-10-15. `tests/fixtures.test.ts`: 4 PASS. Seed `123` / stream `7` matches the frozen `mulberry32-mix32-v1` vector; separate stream states, reset, zero seed, float bounds, raw-byte SHA-256 verification, unit/envelope/tolerance rejection, and synthetic provenance discrimination verified.

### TASK-005 — Runtime capability gate

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Detect SAB/WebGL2/WebGPU/Gamepad/Serial and expose eligible modes without false READY states.
- **Dependencies:** TASK-001, TASK-002.
- **Touched Files:** `apps/web/src/capabilities.ts`, `apps/web/src/App.tsx`, `tests/capabilities.test.ts`, `tests/browser/capabilities.spec.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** CapabilityReport; mode eligibility.
- **DoD & Acceptance Criteria:** Mocking each missing API produces an explicit disabled state; missing isolation blocks the Worker; WebGPU failure retains WebGL2 fallback.
- **Evidence:** Owner Codex; baseline c26df78; 2026-10-15. `tests/capabilities.test.ts`: 7 PASS; `tests/browser/capabilities.spec.ts`: 7 PASS in Chromium. Missing secure context, cross-origin isolation, `SharedArrayBuffer`, `Worker`, or WebGL2 blocks Start; missing Gamepad disables USB; rejected/absent/timed-out WebGPU probes preserve WebGL2 fallback without enabling unverified modes.

### TASK-006 — Model manifest schema

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Validate model/frame/units/hash and configuration version before loading.
- **Dependencies:** TASK-004.
- **Touched Files:** `packages/physics/src/model-manifest.ts`, `packages/physics/src/model.schema.json`, `tests/model-manifest.test.ts`, `tests/fixtures/models/demo-quad.json`, `packages/physics/package.json`, `package-lock.json`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** ModelDescriptor, RotorGeometry, session modelId-to-SHA registry; SPD inertia.
- **DoD & Acceptance Criteria:** Positive/negative fixtures cover NaN, nonpositive mass, non-SPD inertia, duplicate motor IDs, rotorCount>32, and invalid quaternions; verify the hash before swapping.
- **Evidence:** Owner Codex; baseline c26df78; 2026-10-15. `tests/model-manifest.test.ts`: 4 PASS. Schema/frame/units/count/NaN, symmetric positive-definite inertia, unique motor IDs/channels, quaternion norm, and raw-byte SHA-256 verification before registry admission pass; failed hash/schema/collision preserves the existing model.

### TASK-084 — Agent rule discovery

- **Status:** DONE — Claude; baseline 1064a57; 2026-10-15.
- **Title & Description:** Add thin entry points directing Codex/Cursor to the authoritative CLAUDE.md.
- **Dependencies:** TASK-001.
- **Touched Files:** `AGENTS.md`, `.cursor/rules/project.mdc`, `tests/agent-config.test.ts`, `docs/ru/AGENTS.md`, `docs/documentation-index.json`, `tests/documentation-policy.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** CLAUDE.md is the authoritative workflow; wrappers link to it rather than copying rules.
- **DoD & Acceptance Criteria:** A check resolves root CLAUDE.md from both entry points; the Cursor rule sets alwaysApply=true; do not claim automatic discovery by an unknown client.
- **Evidence:** Owner Claude; baseline 1064a57; 2026-10-15. `AGENTS.md` (paired with `docs/ru/AGENTS.md`) and `.cursor/rules/project.mdc` (`alwaysApply: true`) point to root `CLAUDE.md` without duplicating policy sections. `tests/agent-config.test.ts`: 3 PASS; `tests/documentation-policy.test.ts`: 6 PASS.

## Phase 1: Shared Memory & Worker

### TASK-007 — Retain the ABI v1 baseline

- **Status:** DONE — Codex/Claude; baseline f13213b; 2026-10-15.
- **Title & Description:** Preserve current reader/writer and lifecycle regressions as the migration baseline.
- **Dependencies:** TASK-001.
- **Touched Files:** `packages/protocol/src/index.ts`, `tests/protocol.test.ts`, `tests/protocol-golden.test.ts`, `tests/fixtures/abi/v1-layout.json`, `tests/fixtures/registry.json`, `tests/browser/simulation.spec.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** V1: 32896 bytes, 128-byte states, 400 Hz.
- **DoD & Acceptance Criteria:** DONE baseline e3bb6b4: four existing protocol tests cover size/version, float64 roundtrip, ring overwrite, busy frames, and controls; the browser verifies lifecycle.
- **Evidence:** Owner Codex/Claude; 2026-10-15. `tests/protocol.test.ts` (4 PASS) and `tests/protocol-golden.test.ts` (4 PASS) verify the 32896-byte v1 layout and 128-byte state golden against `tests/fixtures/abi/v1-layout.json` (SHA-256 `00a2e97d75521263f4348199c5e0086dd720949cffc92185cdaf97fbd1fd8be0`, tolerance 0) and the v1 tables in [SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md). V1 readers and writers remain as a regression API while the application runs ABI v2 (`TASK-085`).

### TASK-008 — ABI v2 constants and layout

- **Status:** DONE — Claude; baseline 695023c; 2026-10-15.
- **Title & Description:** Introduce v2 independently of v1 and create a golden binary fixture.
- **Dependencies:** TASK-006, TASK-007.
- **Touched Files:** `packages/protocol/src/layout-v2.ts`, `packages/protocol/src/state-v2.ts`, `tests/layout-v2.test.ts`, `tests/fixtures/protocol/state-v2.hex`, `packages/protocol/src/pilot-v2.ts`, `packages/protocol/src/index.ts`, `tsconfig.json`, `tests/support/spec-layout.ts`, `tests/support/golden-v2.ts`, `tests/protocol-golden.test.ts`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY section 3; 49280 bytes; 192-byte state stride; TickId lo/hi.
- **DoD & Acceptance Criteria:** Offset/size/alignment tests cover every field; bytes match the golden fixture; v2 validation rejects v1; reserved words are zero.
- **Evidence:** Owner Claude; baseline 695023c; 2026-10-15. `tests/layout-v2.test.ts`: 13 PASS. Registered fixture `abi-v2-golden` (`tests/fixtures/protocol/state-v2.hex`, tolerance 0) matches Header v2, State v2 (192-byte stride, 256 slots), and Pilot mailbox v2 across all 49280 bytes with natural alignment, `negotiateAbiVersion`, 53-bit tick carry/bounds, and v1 buffer rejection.

### TASK-009 — Atomic v2 readers and writers

- **Status:** DONE — Claude; baseline 0cc6d4c; 2026-10-15.
- **Title & Description:** Implement bounded seqlock, sample_id publication, and epoch-safe render history.
- **Dependencies:** TASK-008.
- **Touched Files:** `packages/protocol/src/atomic-v2.ts`, `packages/protocol/src/index.ts`, `tests/atomic-v2.test.ts`, `tests/browser/atomic-v2.spec.ts`, `tests/support/atomic-v2-stress.ts`, `tests/support/atomic-v2-stress.node-worker.ts`, `tests/support/atomic-v2-stress.browser-worker.ts`, `tests/tooling.test.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** StateWriterV2/StateReaderV2; single writer; at most three read attempts.
- **DoD & Acceptance Criteria:** 1e6 concurrent publications produce no torn fields; an interrupted writer yields miss without mutating output; test counters/epochs/reset; retain v1 tests until compatibility removal is explicit.
- **Evidence:** Owner Claude; baseline 0cc6d4c; 2026-10-15. `tests/atomic-v2.test.ts` (9 PASS) and `tests/browser/atomic-v2.spec.ts` (1 PASS) verify seqlock publication, `sample_id` validation, interrupted-write miss without output mutation, `latestPair` epoch/model/tick-gap guards across 32-bit tick carry, and 1e6 concurrent publications in Node `worker_threads` (272,286 reads, 0 torn) and Chromium Worker (611,561 reads, 0 torn).

### TASK-010 — Control Protocol v2

- **Status:** DONE — Claude; baseline 3b1711b; 2026-10-15.
- **Title & Description:** Validate lifecycle, weather, model, and fault commands with deterministic acknowledgements.
- **Dependencies:** TASK-008, TASK-009.
- **Touched Files:** `packages/protocol/src/control-v2.ts`, `packages/protocol/src/control-v2.schema.json`, `tests/control-v2.test.ts`, `packages/protocol/src/index.ts`, `package.json`, `package-lock.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY section 6; unknown to ControlCommandV2; queued/applied/reject.
- **DoD & Acceptance Criteria:** Every branch has positive/negative fixtures; stale epoch, duplicate IDs, past ticks, and queue 128+1 are handled as specified; a failed model swap retains the previous paused model.
- **Evidence:** Owner Claude; baseline 3b1711b; 2026-10-15. `tests/control-v2.test.ts`: 74 PASS. Covers 60 positive/negative validation fixtures (TypeScript validator + Ajv 8.18.0 strict schema), lifecycle ACKs, `STALE_EPOCH`, duplicate ID idempotency and high-water eviction after 128 IDs, past-tick and 10 s horizon rejection, queue `128+1` `OVERLOAD`, and failed (`ASSET_MISSING`, previous model/epoch retained, paused) versus successful model swaps.

### TASK-011 — 400/800/1200 Hz clocks

- **Status:** DONE — Claude; baseline 1e96582; 2026-10-16.
- **Title & Description:** Parameterize scheduler/dt and rational sensor timestamps.
- **Dependencies:** TASK-010.
- **Touched Files:** `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `tests/clock.test.ts`, `tests/browser/simulation.spec.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** PhysicsHz; TickId; simTime=tick/hz; fixed dt.
- **DoD & Acceptance Criteria:** A fake clock produces 4000/8000/12000 steps in 10 s without accumulated dt drift; pause/resume creates no backlog; 1200 Hz time_usec intervals are 833/834 microseconds.
- **Evidence:** Owner Claude; baseline 1e96582; 2026-10-16. `tests/clock.test.ts`: 12 PASS. Jittered wakeups produce exact 4000/8000/12000 steps in 10 s with zero drift; bounded catch-up counts dropped steps; pause/resume creates no backlog; 1200 Hz `time_usec` intervals are `{833, 834}` us summing to `1e6` across 32-bit tick carry; 200/400 Hz IMU and 5/10 Hz GNSS schedules stay phase-locked.

### TASK-012 — Clock modes and overload

- **Status:** DONE — Claude; baseline be502a4; 2026-10-16.
- **Title & Description:** Separate interactive time dropping, SITL lockstep waiting, and HITL fault policies.
- **Dependencies:** TASK-011.
- **Touched Files:** `packages/physics/src/clock-policy.ts`, `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `tests/clock-policy.test.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** interactive / sitl-lockstep / hitl-realtime; maxCatchUp=8.
- **DoD & Acceptance Criteria:** A 1 s stall counts interactive drops, preserves every SITL simulation tick, and invalidates HITL; pause/dispose remain responsive when actuators are absent.
- **Evidence:** Owner Claude; baseline be502a4; 2026-10-16. `tests/clock-policy.test.ts`: 5 PASS. A 1 s stall at 400 Hz counts 392 `interactive` drops with contiguous ticks, preserves every tick in `sitl-lockstep` (catching up at most `maxCatchUp = 8` ticks per pump without blocking when actuators are absent), and latches `hitl-overrun` in `hitl-realtime` until `resetEpoch`.

### TASK-013 — Sensor/actuator SPSC queues

- **Status:** DONE — Claude; baseline aef7af6; 2026-10-16.
- **Title & Description:** Implement separate bounded queues with strict ownership and backpressure.
- **Dependencies:** TASK-008, TASK-009, TASK-012.
- **Touched Files:** `packages/protocol/src/spsc-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/spsc-v2.test.ts`, `tests/browser/spsc-v2.spec.ts`, `packages/protocol/src/index.ts`, `tests/support/spsc-stress.ts`, `tests/support/spsc-stress.node-worker.ts`, `tests/support/spsc-stress.browser-worker.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY section 5; capacity=1024, stride=128.
- **DoD & Acceptance Criteria:** Test full/empty/wrap/reset; never overwrite unread slots; 1e6 frames retain order; SITL/HITL policies handle overflow without silent drops.
- **Evidence:** Owner Claude; baseline aef7af6; 2026-10-16. `tests/spsc-v2.test.ts` (9 PASS) and `tests/browser/spsc-v2.spec.ts` (1 PASS) verify section 5 slot/header layouts, full/empty/wrap/reset, HITL overflow latching until `resetSpscQueue`, sensor/actuator frame codecs, and 1e6 concurrent frames in Node `worker_threads` and Chromium Worker with 0 out-of-order, corrupt, or invalid frames.

### TASK-014 — Hot-path instrumentation

- **Status:** DONE — Claude; baseline 920bd23; 2026-10-16.
- **Title & Description:** Measure allocation counts, step duration, and deadline lateness in a machine-readable report.
- **Dependencies:** TASK-009, TASK-011, TASK-013.
- **Touched Files:** `packages/physics/src/step-metrics.ts`, `scripts/bench-physics.mjs`, `tests/step-metrics.test.ts`, `docs/benchmarks/schema.json`, `packages/physics/src/index.ts`, `packages/physics/src/clock.ts`, `packages/physics/src/clock-policy.ts`, `packages/physics/src/demo-dynamics.ts`, `packages/physics/src/session-v2.ts`, `packages/protocol/src/state-v2.ts`, `packages/protocol/src/pilot-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/layout-v2.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** G1/G3; compute duration, wakeup lateness, and executed Hz are separate metrics.
- **DoD & Acceptance Criteria:** After warmup, 1e6 steps have zero explicit JS/WASM allocations and constant arena size; baseline report records p50/p95/p99/max and environment; measure profiler overhead separately.
- **Evidence:** Owner Claude; baseline 920bd23; 2026-10-16. `node scripts/bench-physics.mjs` (`--expose-gc --max-semi-space-size=64 --single-threaded`, report `test-results/bench/physics.json`, schema `docs/benchmarks/schema.json`) and `tests/step-metrics.test.ts` (3 PASS) verify `zeroAllocation = true` (`0.00000` B/step incremental across `1e6`/`2e6` windows, 0 GC events, positive allocating control detected; compute p50 `~1.0` us, p99 `~1.1–1.9` us). On Windows Node (`test-results/laptop/bench-physics-400.json`, `bench-physics-800.json`, `bench-physics-1200.json`), the `bench-physics` realtime run executed 400.5 Hz (target 400, 0 drops), 516.7 Hz (target 800, 1,426 drops), and 519.6 Hz (target 1200, 3,415 drops) with drops: ~16 ms timer wakeups x 8-step catch-up cap. Compute is ~1 us/step; the browser Worker 800 Hz regression passed.

### TASK-015 — Interpolation and epoch changes

- **Status:** DONE — Claude; baseline db50e9a; 2026-10-16.
- **Title & Description:** Render smoothly without interpolating across reset or model replacement.
- **Dependencies:** TASK-009, TASK-011.
- **Touched Files:** `apps/web/src/FlightScene.tsx`, `apps/web/src/coordinates.ts`, `packages/protocol/src/interpolation.ts`, `tests/interpolation.test.ts`, `packages/protocol/src/index.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Adjacent ticks in the same epoch/model; shortest-path quaternion SLERP.
- **DoD & Acceptance Criteria:** q and -q do not cause a full rotation; NED basis tests pass; reset/teleport breaks history; rendering never waits for the writer or mutates truth.
- **Evidence:** Owner Claude; baseline db50e9a; 2026-10-16. `tests/interpolation.test.ts` (6 PASS) verifies linear position and shortest-path SLERP attitude within `1e-12` rad against an axis-angle oracle, `q`/`-q` equivalence, history breaks on `latest`/`none` or >100 m teleport, and NED-to-render mapping in `FlightScene.tsx`.

### TASK-085 — Migrate Worker and Main to ABI v2

- **Status:** DONE — Claude; baseline bad3099; 2026-10-16.
- **Title & Description:** Switch the running application from ABI v1 and the v1 postMessage protocol to the v2 state ring, pilot mailbox, WorkerInitV2, and Control Protocol v2. Split out of TASK-009/010 because WorkerInitV2 requires the TASK-013 sensor/actuator buffers.
- **Dependencies:** TASK-009, TASK-010, TASK-013.
- **Touched Files:** `apps/web/src/runtime.ts`, `apps/web/src/physics.worker.ts`, `apps/web/src/App.tsx`, `tests/browser/simulation.spec.ts`, `tests/browser/runtime-v2.spec.ts`, `apps/web/src/FlightScene.tsx`, `packages/physics/src/session-v2.ts`, `packages/physics/src/demo-dynamics.ts`, `packages/physics/src/index.ts`, `packages/protocol/src/control-v2.ts`, `packages/input/src/index.ts`, `tests/session-v2.test.ts`, `tests/control-v2.test.ts`, `tests/input.test.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** WorkerInitV2; StateWriterV2/StateReaderV2; PilotWriterV2/PilotReaderV2; ControlProcessorV2; SPECS_SHARED_MEMORY sections 3–6.
- **DoD & Acceptance Criteria:** Lifecycle, stale-input, USB-failsafe, and fixed-dt browser tests pass on v2; a stale epoch or changed device_generation disarms; rendering never interpolates across epochs; v1 compatibility is removed only by a recorded decision.
- **Evidence:** Owner Claude; baseline bad3099; 2026-10-16. `tests/session-v2.test.ts` (11 PASS), `tests/browser/simulation.spec.ts` (4 PASS), and `tests/browser/runtime-v2.spec.ts` (2 PASS) verify `init-v2` state/SPSC wiring, `<=5%` throttle arming, `device_generation` and stale-epoch disarm, 800 Hz browser Worker execution within 10% (`720–880` Hz), and epoch-safe interpolation history.

## Phase 2: Aerodynamics & WASM

### TASK-016 — Native Rust workspace

- **Status:** DONE — Claude; baseline 4187246; 2026-10-16.
- **Title & Description:** Create a pinned scalar BET crate and native tests.
- **Dependencies:** TASK-003, TASK-004.
- **Touched Files:** `native/Cargo.toml`, `native/Cargo.lock`, `native/rust-toolchain.toml`, `native/bet/Cargo.toml`, `native/bet/src/lib.rs`, `.github/workflows/native.yml`, `native/bet/tests/bootstrap.rs`, `tests/browser/native-bootstrap.spec.ts`, `.github/workflows/ci.yml`, `tests/ci.test.ts`, `.gitignore`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** wasm32-unknown-unknown; repr(C) boundary; scalar by default.
- **DoD & Acceptance Criteria:** cargo check/test --locked pass; pin toolchain/target; verify a reproducible bootstrap kernel artifact in Chromium without claiming production aerodynamics.
- **Evidence:** Owner Claude; baseline 4187246; 2026-10-16. Pinned Rust `1.97.0` (`native/rust-toolchain.toml`, `wasm32-unknown-unknown` with trapping global allocator and zero imports). `cargo test --manifest-path native/Cargo.toml --workspace --locked` (`bootstrap.rs`: 6 PASS) and `tests/browser/native-bootstrap.spec.ts` (1 PASS in Chromium) verify reproducible SHA-256 builds and element-force parity within `1e-12`. Hosted `.github/workflows/native.yml` passed in run `38935251375`.

### TASK-017 — WASM build and loading

- **Status:** DONE — Claude; baseline e152ee3; 2026-10-16.
- **Title & Description:** Implement hash/ABI validation and scalar/SIMD artifact selection.
- **Dependencies:** TASK-005, TASK-016.
- **Touched Files:** `packages/wasm-bet/package.json`, `packages/wasm-bet/src/loader.ts`, `scripts/build-wasm.mjs`, `tests/wasm-loader.test.ts`, `tests/browser/wasm-loader.spec.ts`, `package-lock.json`, `.github/workflows/ci.yml`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** bet_abi_version; artifact manifest; SIMD feature detection.
- **DoD & Acceptance Criteria:** Corrupt hashes/ABI block arming; unsupported SIMD uses scalar fallback; instantiate outside step; reserve the BET baseline memory budget of <=64 MiB before running.
- **Evidence:** Owner Claude; baseline e152ee3; 2026-10-16. `node scripts/build-wasm.mjs` builds `scalar` and `simd128` artifacts with `manifest.json`; `tests/wasm-loader.test.ts` (5 PASS) and `tests/browser/wasm-loader.spec.ts` (1 PASS in Chromium) verify SHA-256/size/ABI checks, SIMD128 detection with scalar fallback, and 64 MiB memory reservation with `memoryStable()`.

### TASK-018 — C ABI and arena binding

- **Status:** DONE — Claude; baseline a3e7141; 2026-10-16.
- **Title & Description:** Define checked input/config/output records without per-step object marshaling.
- **Dependencies:** TASK-006, TASK-017.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/include/bet.h`, `packages/wasm-bet/src/arena.ts`, `tests/wasm-abi.test.ts`, `native/bet/src/lib.rs`, `native/bet/build.rs`, `native/bet/tests/abi.rs`, `packages/wasm-bet/src/loader.ts`, `packages/wasm-bet/package.json`, `tests/fixtures/wasm-abi/generate.py`, `tests/fixtures/wasm-abi/bet-abi-v1.json`, `tests/fixtures/registry.json`, `tests/browser/native-bootstrap.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES section 4; rotor output stride=128.
- **DoD & Acceptance Criteria:** Rust size/offset tests match TS golden records; reject invalid pointers/counts/sizes; 1e6 step calls perform no allocation/growth and overwrite output in place.
- **Evidence:** Owner Claude; baseline a3e7141; 2026-10-16. `native/bet/tests/abi.rs` (7 PASS) and `tests/wasm-abi.test.ts` (7 PASS) verify `native/bet/include/bet.h` and golden `tests/fixtures/wasm-abi/bet-abi-v1.json` (config 4384 B, input 256 B, rotor output stride 128 B), pointer/alignment/overlap rejection, and 1e6 `stepInto` calls with 0 GC events, 0 WASM allocations, and `memoryStable()`. Production `bet_step` arena stepping still reports `AERODYNAMICS_UNAVAILABLE` until a versioned polar/config binding is wired.

### TASK-019 — Polar lookup

- **Status:** DONE — Claude; baseline ddb263d; 2026-10-16.
- **Title & Description:** Interpolate CL/CD over alpha/logRe/Mach with validated bounds.
- **Dependencies:** TASK-004, TASK-018.
- **Touched Files:** `native/bet/src/polar.rs`, `tests/fixtures/polars/synthetic.json`, `native/bet/tests/polar.rs`, `native/bet/src/lib.rs`, `tests/fixtures/polars/generate.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** PolarTable; flattened (Mach,Re,alpha); validity flags.
- **DoD & Acceptance Criteria:** Analytic tests cover nodes/interpolation/reverse flow/bounds; reject negative CD/NaN; out-of-range inputs clamp and flag instead of silently extrapolating.
- **Evidence:** Owner Claude; baseline ddb263d; 2026-10-16. `native/bet/tests/polar.rs` (5 PASS) verifies trilinear `(Mach, ln Re, alpha)` interpolation within `1e-12` against `tests/fixtures/polars/synthetic.json` (81 nodes, 13 queries), reverse-flow and boundary clamping with validity flags, and negative `CD` / non-finite / malformed axis rejection. The fixture is synthetic, not a measured airfoil polar.

### TASK-020 — Blade element quadrature

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Integrate element forces/moments for prescribed omega and inflow.
- **Dependencies:** TASK-019, TASK-032.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/blade.rs`, `native/bet/src/quadrature.rs`, `native/bet/tests/blade.rs`, `native/bet/src/lib.rs`, `tests/fixtures/rotors/blade.json`, `tests/fixtures/registry.json`, `native/bet/tests/allocation.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** RotorGeometry/RotorStepInput; equations in section 3.
- **DoD & Acceptance Criteria:** Test zero flow, mirrored spin, drag dissipation, and independent wrench fixtures; sample count does not multiply total force; 16/32/64 refinement converges within fixture tolerance.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. `cargo test --test blade --locked` (5 PASS) and `tests/rotor-kernels.test.ts` (scalar/SIMD tails `1/3/5/63` within `1e-9` N/Nm) verify annulus force/torque, 16/32/64 radial refinement, normalized azimuth averaging, spin mirroring, zero flow, and drag dissipation against `tests/fixtures/rotors/blade.json` (relative tolerance `1e-4`). Production C ABI polar binding remains open.

### TASK-021 — Dynamic inflow

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Add bounded axial induced-flow state and its validity envelope.
- **Dependencies:** TASK-020.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/inflow.rs`, `native/bet/tests/inflow.rs`, `tests/fixtures/rotors/axial-inflow.json`, `tests/fixtures/registry.json`, `native/bet/src/lib.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Signed induced velocity; at most four solver iterations per step.
- **DoD & Acceptance Criteria:** Hover momentum residual is <=1% of fixture thrust; test transient convergence; mark VRS/out-of-envelope cases unvalidated; zero RPM/flow remains finite.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. `cargo test --test inflow --locked` (2 PASS) and scalar/SIMD WASM checks (`<=1e-9` m/s) verify signed hover/climb momentum residual `<=1%`, relaxation at 400/800/1200 Hz, zero loading, and explicit descent/VRS/transverse validity flags against `tests/fixtures/rotors/axial-inflow.json`. Not a validated VRS/autorotation inflow model.

### TASK-022 — Free shaft and autorotation

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Integrate RPM from aerodynamic torque, drive torque, and losses without an RPM governor.
- **Dependencies:** TASK-021.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/shaft.rs`, `native/bet/tests/autorotation.rs`, `tests/fixtures/rotors/free-shaft.json`, `tests/fixtures/registry.json`, `native/bet/src/lib.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** J*dOmega/dt=tau_motor+s*Qair-tau_loss; RotorState.
- **DoD & Acceptance Criteria:** Without flow/drive, energy decreases; permitted airflow drives acceleration/deceleration through torque; steady residual<0.01 Nm; no artificial prescribed RPM.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. `cargo test --test autorotation --locked` (2 PASS) and scalar/SIMD WASM checks (`<=1e-9` rad/s) verify passive energy decay, airflow-driven free-shaft acceleration/deceleration for both spins, steady residual `<0.01` Nm, and 400/800/1200 Hz convergence against `tests/fixtures/rotors/free-shaft.json`. No experimental autogyro validation claimed.

### TASK-023 — Flapping and gyroscopic momentum

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Implement coning/first-harmonic flapping and complete dH/dt transmission.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/flapping.rs`, `native/bet/src/momentum.rs`, `native/bet/tests/flapping.rs`, `native/bet/src/lib.rs`, `tests/fixtures/rotors/flapping.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** RotorState flap states; Mhub=Mair-dH/dt; documented hinge parameters.
- **DoD & Acceptance Criteria:** Test symmetry, sign/axes, angular momentum balance, and timestep convergence; retain equation sources/validity; mesh tilt never substitutes for dynamics.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. `cargo test --test flapping --locked` (3 PASS) and `native/bet/tests/allocation.rs` verify zero-offset hinge Galerkin equations, collective symmetry, mirrored spin signs, `Mhub = Mair - dH/dt` momentum balance against `tests/fixtures/rotors/flapping.json` (scalar/SIMD tolerance `1e-8` rad), and 0 allocations over 1e6 combined native/WASM kernel steps. Flat-disk load coupling and small-angle reduced inertia remain explicit limitations.

### TASK-024 — Coaxial interaction

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Introduce explicit wake coupling for a pair of rotor disks.
- **Dependencies:** TASK-021, TASK-023.
- **Touched Files:** `native/bet/src/coaxial.rs`, `native/bet/tests/coaxial.rs`, `tests/fixtures/rotors/coaxial.json`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `native/bet/tests/allocation.rs`, `tests/rotor-kernels.test.ts`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** WakePair {upperId,lowerId,separationM,overlap}; energy/source provenance.
- **DoD & Acceptance Criteria:** Disabled coupling matches independent rotors; large separation approaches independence; check momentum/energy accounting; without measurements label the model experimental.
- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. `cargo test --manifest-path native/Cargo.toml --test coaxial --locked` (4 PASS) and `tests/rotor-kernels.test.ts` (4 PASS) verify disabled/zero-overlap independence, far-field convergence within `1e-6` N/Nm, overlap scaling, momentum/energy budgets against `tests/fixtures/rotors/coaxial.json` (tolerance `1e-9`), and 1e6 steps with 0 allocations. Experimental ideal-hover/mixing reference only; no measured coaxial dataset or production C ABI binding.

### TASK-025 — ESC and spool model

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Convert duty into drive torque/RPM transients using the selected motor model.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/src/motor.rs`, `native/bet/tests/motor.rs`, `packages/physics/src/motor-config.ts`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/motor-config.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Torque model or first-order governor; current/back-EMF limits.
- **DoD & Acceptance Criteria:** Duty steps follow configured lag/current saturation; zero voltage creates no energy; power cuts preserve spin decay; never integrate two spool ODEs simultaneously.
- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. `native/bet/tests/motor.rs` (2 PASS), `tests/motor-config.test.ts`, and scalar/SIMD WASM parity tests verify duty lag, winding-current saturation, bus/mechanical/copper power balance, power cut without resetting shaft speed, and 0 allocations over 1e6 steps.

### TASK-026 — Battery sag

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Calculate SOC, bus voltage, and available power across all motors.
- **Dependencies:** TASK-025.
- **Touched Files:** `native/bet/src/battery.rs`, `native/bet/tests/battery.rs`, `tests/fixtures/power/battery.json`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** V=Voc-I*R; SOC; power-limited flags.
- **DoD & Acceptance Criteria:** Analytic resistance, R approaching zero, depleted SOC, and infeasible power cases remain finite; energy/current signs agree; count every motor load exactly once.
- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. `native/bet/tests/battery.rs` (2 PASS) and scalar/SIMD quadratic-root oracle checks against synthetic `tests/fixtures/power/battery.json` verify shared load accounting, `R = 0`/`1e-20` limits, current/power saturation, depletion, and 0 allocations over 1e6 steps.

### TASK-027 — Arbitrary frame wrench

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Aggregate thrust vectors, moment arms, and transmitted rotor moments.
- **Dependencies:** TASK-006, TASK-023, TASK-025, TASK-026.
- **Touched Files:** `native/bet/src/frame.rs`, `packages/physics/src/frame.ts`, `native/bet/tests/frame.rs`, `tests/fixtures/models/tilted-octo.json`, `native/bet/src/lib.rs`, `native/bet/src/math.rs`, `tests/frame.test.ts`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** F=sum R*F; M=sum(r cross R*F+R*Mhub); stable motor IDs.
- **DoD & Acceptance Criteria:** Quad/hexa/tilted-octo fixtures verify symmetry, yaw cancellation, and handedness; tilted axes generate lateral force; motor reaction is never counted twice.
- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. `native/bet/tests/frame.rs` (2 PASS), `tests/frame.test.ts` (2 PASS), and scalar/SIMD checks against `tests/fixtures/models/tilted-octo.json` verify symmetric quad/hexa/octo moment cancellation, `4*sqrt(2)` N tilted lateral force, right-handed transforms without duplicate reaction, and 0 allocations over 1e6 steps.

### TASK-028 — Rigid-body integrator

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Integrate BET wrench using mass/inertia, quaternion, and NED gravity.
- **Dependencies:** TASK-027.
- **Touched Files:** `native/bet/src/rigid_body.rs`, `packages/wasm-bet/src/backend.ts`, `native/bet/tests/rigid_body.rs`, `native/bet/src/lib.rs`, `native/bet/src/body_abi.rs`, `native/bet/tests/body_abi.rs`, `tests/rigid-body.test.ts`, `packages/wasm-bet/package.json`, `tests/fixtures/abi/body-v1.json`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `tests/browser/native-bootstrap.spec.ts`, `scripts/bench-sensors.mjs`.
- **Interfaces / Contracts:** DynamicsBackend, TruthOutput; one integration owner.
- **DoD & Acceptance Criteria:** Test ballistic/torque-free/constant-torque cases; native quaternion norm error<1e-10; trajectories remain finite; check 400/800/1200 convergence against offline 4800 Hz.
- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. `native/bet/tests/rigid_body.rs` (3 PASS), `native/bet/tests/body_abi.rs` (1 PASS), and `tests/rigid-body.test.ts` verify ballistic and constant-torque analytic solutions, quaternion norm error `<1e-10`, torque-free 400/800/1200 Hz convergence to 4800 Hz, and 256/128-byte body ABI v1 (`tests/fixtures/abi/body-v1.json`). `node scripts/bench-sensors.mjs body` (`test-results/bench/sensors-body.json`) passes six `1e6`/`2e6` windows with 0 GC and 0 WASM allocations.

### TASK-029 — Landing-gear contact

- **Status:** DONE — Codex; baseline 316152d; 2026-10-18. Direct f64 Rapier C ABI, configurable compliant wheel/strut/tire/stop topology, single integration owner, and native/WASM/browser Worker G1 allocation gates verified. NASA measured drop fidelity was explicitly deferred by the user; the archived failing rigid-sphere comparison is preserved.
- **Title & Description:** Integrate one chosen contact solver and synchronize impulses.
- **Dependencies:** TASK-028.
- **Touched Files:** `packages/physics/src/contact-backend.ts`, `packages/physics/src/ground-contact.ts`, `tests/contact.test.ts`, `tests/fixtures/contact/drop.json`, `package-lock.json`, `packages/physics/package.json`, `tests/contact-allocation.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `packages/physics/src/contact-engine.ts`, `scripts/bench-contact.mjs`, `native/rapier/allocation_probe.rs`, `native/rapier/source.lock.json`, `native/rapier/Cargo.lock`, `scripts/check-contact-native.mjs`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `native/rapier/patches/reuse-step-buffers.patch`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`, `tests/fixtures/contact/nasa-drop.json`, `tests/fixtures/contact/generate_nasa_drop.py`, `tests/fixtures/contact/nasa/nasa-tm-x-3561.md`, `tests/fixtures/contact/nasa/nasa-tp-2353.md`, `tests/fixtures/contact/nasa/naca-report-1248.md`, `.gitattributes`, `packages/physics/src/nasa-drop.ts`, `packages/test-support/src/fixtures.ts`, `tests/fixtures.test.ts`, `scripts/check-docs.mjs`, `README.md`, `docs/ru/README.md`.
- **Interfaces / Contracts:** ContactImpulse {pointBody,impulseNed,dt}; choose Rapier or Jolt in an ADR.
- **DoD & Acceptance Criteria:** Drop/rolling/friction/nonpenetration fixtures pass; restitution adds no excess energy; a second solver never reintegrates the same body; meet G1 allocation budget.
- **Evidence:** Owner Codex; baseline 316152d; 2026-10-18. Direct `f64` Rapier 0.36.0 C ABI (`native/contact/`, built via `node scripts/build-contact.mjs` with storage-reuse patch `native/rapier/patches/reuse-step-buffers.patch`) and compliant linear/gas-orifice strut, nonlinear tire, travel-stop, and rim kernels (`native/bet/src/landing_gear.rs`, `tests/landing-gear.test.ts`, `tests/contact-binding.test.ts`). `node scripts/check-contact-binding.mjs` (`test-results/validation/task-029-binding.json`) passes 9,000,000 native steps and `tests/contact-allocation.test.ts` passes 9,000,000 WASM steps across 400/800/1200 Hz and 0/3/8 wheels with 0 allocator calls/bytes and exact position parity (max attitude diff `2.98e-8` rad). `node scripts/bench-contact.mjs` (`test-results/bench/contact.json`) passes three 1e6-step windows with 0 GC and `<0.004` B/step; `tests/browser/contact.spec.ts` passes 1e6 steps in a Chromium Worker. Summary reports: `test-results/validation/task-029-completion.json`, `test-results/validation/task-029-compliance.json`, `test-results/bench/contact-native-patched.json`. Archived NASA TM X-3561 / TP-2353 / NACA 1248 fixtures (`tests/fixtures/contact/nasa-drop.json`, `test-results/validation/nasa-drop-legacy.json`) remain preserved with their failing rigid-sphere comparison per user deferral. Does not certify aircraft calibration, wheel-spin/anti-skid/steering, target-device timing, or full BET/JSBSim session wiring.

### TASK-030 — Pinned JSBSim WASM artifact

- **Status:** DONE — Codex; baseline 18317f8; 2026-10-18. Pinned local WASM artifact, reproducibility comparison, and real browser Worker smoke pass.
- **Title & Description:** Build JSBSim with reproducible source/toolchain manifests through Emscripten.
- **Dependencies:** TASK-003, TASK-004, TASK-006.
- **Touched Files:** `native/jsbsim/CMakeLists.txt`, `native/jsbsim/source.lock.json`, `native/jsbsim/toolchain.lock.json`, `scripts/build-jsbsim.mjs`, `packages/wasm-jsbsim/package.json`, `tests/jsbsim-artifact.test.ts`, `native/jsbsim/bridge.cpp`, `native/jsbsim/property-map.json`, `package-lock.json`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `scripts/check-jsbsim-native.mjs`, `native/jsbsim/native_checks.cpp`, `native/jsbsim/patches/reuse-history-and-property-paths.patch`.
- **Interfaces / Contracts:** WASM C ABI version/hash; JSBSim and model-data licenses.
- **DoD & Acceptance Criteria:** Build pinned source with verified checksums; native/WASM references share source; unit conversion does not patch upstream physics; Worker artifact smoke passes.
- **Evidence:** Owner Codex; baseline 18317f8; 2026-10-18. Pinned JSBSim v1.2.3 (`570e8115a102df8f877b11e0e59b964ea483e3c0`) and Emscripten 4.0.15 (`389a68bc35dcff7ebae4614e1615099dafda00d1`) with `SOURCE_DATE_EPOCH=1749297861`. `node scripts/build-jsbsim.mjs` produces byte-identical builds across independent directories; `node scripts/check-jsbsim-artifact.mjs` (`test-results/validation/jsbsim-artifact.json`) passes Chromium Worker smoke at 400/800/1200 Hz (22 finite SI outputs, time/quaternion norm error `<=1e-10`, stable 64 MiB memory); `tests/jsbsim-artifact.test.ts` passes. Aircraft XML remains local test input excluded from packaged artifacts pending redistribution review.

### TASK-031 — JSBSim DynamicsBackend

- **Status:** DONE — Codex; baseline 2ede92f; 2026-10-18. Native/WASM trim, control, and single-owner contact parity, stationary specific-force checks, and measured C++/WASM/JS allocation gates pass for the local c172x reference. Model XML remains unbundled; measured calibration and full flight-session readiness are separate.
- **Title & Description:** Adapt JSBSim state, actuators, and contact exchange.
- **Dependencies:** TASK-018, TASK-029, TASK-030, TASK-032.
- **Touched Files:** `native/jsbsim/bridge.cpp`, `packages/wasm-jsbsim/src/backend.ts`, `tests/jsbsim-backend.test.ts`, `tests/fixtures/airframes/jsbsim-trim.json`, `native/jsbsim/property-map.json`, `packages/wasm-jsbsim/package.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `native/jsbsim/native_checks.cpp`, `scripts/check-jsbsim-native.mjs`, `tests/jsbsim-native.test.ts`, `native/jsbsim/patches/reuse-history-and-property-paths.patch`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`.
- **Interfaces / Contracts:** DynamicsBackend; ft/slugs to SI; FRD/NED; JSBSim owns integration.
- **DoD & Acceptance Criteria:** Native/WASM trim and step-control fixtures meet manifest tolerances; stationary specific force/signs are correct; couple contact impulses consistently; no per-step allocation/growth.
- **Evidence:** Owner Codex; baseline 2ede92f; 2026-10-18. Additive contact ABI v1 (`node scripts/build-jsbsim.mjs --contact`, native WASM exceptions, `native/jsbsim/patches/reuse-history-and-property-paths.patch` and `contact-impulse.patch`;JSBSim 83,070 B, WASM 1,696,214 B). `node scripts/check-jsbsim-backend.mjs --native` (`test-results/validation/task-031-native.json`) and `node --experimental-transform-types scripts/check-jsbsim-backend.mjs` (`test-results/validation/task-031-backend.json`) pass 9 trim/control/contact and 3 stationary cases across 12,000,000 hot steps at 400/800/1200 Hz with 0 C++/WASM allocations, exact 10 s position parity, max attitude diff `2.98e-8` rad, velocity diff `<7e-14` m/s, momentum error `<9e-11` N·s, and upward stationary specific force `~9.78` m/s². `node scripts/bench-jsbsim.mjs` (`test-results/bench/jsbsim-400.json`; legacy JS-exception failure preserved in `test-results/bench/jsbsim-400-legacy-exceptions.json`) passes three 1e6-step windows with 0 GC and `<0.004` B/step. Summary: `test-results/validation/task-031-completion.json`. Model XML redistribution, measured aircraft fidelity, flight-session wiring, and autopilot READY remain separate.

### TASK-032 — Atmosphere and wind

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Implement shared atmospheric state and deterministic gust input.
- **Dependencies:** TASK-004, TASK-006, TASK-010.
- **Touched Files:** `CLAUDE.md`, `docs/ru/CLAUDE.md`, `README.md`, `docs/ru/README.md`, `packages/physics/src/atmosphere.ts`, `packages/physics/src/wind.ts`, `tests/atmosphere.test.ts`, `packages/physics/package.json`, `package-lock.json`, `scripts/bench-wind.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Temperature/pressure to density/viscosity/speed of sound; seeded gust bandwidth.
- **DoD & Acceptance Criteria:** ISA references and calm/gust/reset/replay fixtures pass; JSBSim/BET share units; fixed seed is independent of render FPS; reject invalid near-zero density through schema validation.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. `tests/atmosphere.test.ts`: 4 PASS (ISA sea level and 11 km, strict state schema, calm/reset/render-independent replay, stationary variance/pole over 2e6 samples). `node scripts/bench-wind.mjs` (`test-results/bench/wind.json`): exit 0, seed 123, 400 Hz, six warmed `1e6`/`2e6` windows with 0 GC and `0.000128` B/step incremental estimate.

### TASK-033 — Model validation gate

- **Completion evidence (2026-10-20):** DONE for the user's configurable synthetic-geometry/NeuralFoil software baseline; owner Codex; baseline d56c890. Earlier dated continuation entries below are retained history; this completion supersedes their missing-binding claims. Three rotor geometries/two NeuralFoil profiles pass 72 independent uniform/annular numerical cases; 61 retain screening flags. The production bound ABI and configurable rotor/body backend pass 18 ten-second scalar/SIMD convergence comparisons at 400/800/1200 Hz against 4800 Hz (4/6/8 rotors); maximum position error 0.003529693668440359 m, attitude error 0 rad, below the unchanged 0.1 m / 0.5 degree limits. `node scripts/check-bet-runtime.mjs` exits 0. `node scripts/check-bet-runtime.mjs --allocation` exits 0: counted native bound loop 1,000,000 steps, zero calls/bytes with detected positive control; scalar and SIMD active NeuralFoil rotor probes and the stationary zero-gravity four-rotor body probe each execute 1,000,000 steps with zero GC, stable WASM memory and 0.003104–0.003248 incremental B/step; allocating positive control is detected. Reports: `test-results/validation/bet-runtime.json`, `test-results/validation/bet-runtime-allocation.json` (all native crate sources, runtime inputs, probe and package/artifact hashes).
- **Verification:** Windows 11 x64, Node 24.19.0, pinned rustc 1.97.0, Python 3.12 and Chromium 141.0.7390.37 (Playwright revision 1194). `cargo test --workspace --locked` in `native/`: 66 PASS. `node node_modules/vitest/vitest.mjs run`: 550 PASS / 99 files, one pre-existing optional ArduCopter artifact skip; loopback/junction tests require execution outside the restricted sandbox. Full regression precedes final package-export/LF normalization; final focused checks cover exports, report and byte-layout/document contracts. Nineteen Python tests and byte reproduction of both NeuralFoil datasets pass. Six Chromium checks (BET selected SAB Worker, production bootstrap and four existing simulation flows), strict TypeScript, ESLint, Vite production build and bilingual documentation checks pass. Build retains the existing large-bundle warning. Exact JUnit evidence: `test-results/validation/task-033-unit.xml`, `test-results/validation/task-033-focused.xml`, `test-results/validation/task-033-final.xml`, `test-results/browser/junit.xml`.
- **Acceptance boundary:** Model-report schema v8 records numerical/runtime PASS separately from unvalidated synthetic fidelity. `node scripts/validate-models.mjs` intentionally exits 2 because historical UIUC fidelity fails and NASA measured fidelity remains deferred/blocked. No thresholds or failed historical measurements are relabeled. The public APIs are usable through the session dynamics factory; the application Worker defaults to DemoDynamics. Rigid nonflapping free-flight rotors, explicit torque/mixer/atmosphere inputs and retained confidence/validity flags define this implementation. Measured airframe certification, battery/contact coupling, target-device realtime and browser autopilot READY are outside the selected completion scope and remain unadmitted.


- **Runtime completion scope (2026-10-20):** DONE; owner Codex; baseline d56c890 plus preserved local work. Complete a production-built, versioned polar/rotor binding and configurable BET flight-session injection using the user's synthetic geometry/NeuralFoil baseline. Additional files: `native/bet/src/bound.rs`, `native/bet/src/polar.rs`, `native/bet/src/lib.rs`, `native/bet/include/bet_bound.h`, `native/bet/tests/bound.rs`, `native/bet/tests/polar.rs`, `native/bet/tests/allocation.rs`, `packages/wasm-bet/src/rotor.ts`, `packages/physics/src/bet-dynamics.ts`, `packages/physics/src/session-v2.ts`, `tests/bet-runtime.test.ts`, `tests/browser/bet-runtime.spec.ts`, `tests/browser/bet-worker.ts`, `tests/browser/native-bootstrap.spec.ts`, `scripts/check-bet-runtime.mjs`, plus the existing validator/report/schema, architecture/specification/agent-baseline docs and Russian mirrors. Preserve legacy rotor ABI v1 rejection behavior. New bound ABI v1 is additive, has caller-owned immutable validated configuration and state, checks pointers/overlaps/versions/dt/memory stability, returns no partial writes on errors, and carries low-confidence/outside-polar/inflow validity flags. Fixed-step rotor evaluation composes existing shaft/inflow kernels and transmitted angular momentum; rigid nonflapping rotors are explicit. G1 requires zero allocator calls/bytes and no WASM growth over one million steps; G2 requires independent load and scalar/SIMD parity plus 400/800/1200-to-4800 reference convergence. Flight-session model IDs and rotor counts must come from the selected backend; demo defaults remain compatible. Measured-fidelity reports remain distinct from completion of the synthetic validation capability. Do not enable browser autopilot READY.
- **Runtime test support:** `tests/bet-runtime-fixture.ts` supplies reusable synthetic model configurations for Node/browser/runtime checks; `native/bet/tests/support/bound_fixture.rs` supplies byte-fixture construction shared by native correctness/allocation tests. These are explicit test data, not calibrated vehicle defaults.
- **Regression support:** `tests/layout-v2.test.ts` and `tests/protocol-golden.test.ts` now reference the current specification headings after the baseline pull; no ABI values or assertions change.
- **Public API and reproducibility:** Export `@mirage/physics/bet-dynamics` and `@mirage/wasm-bet/rotor` in the package manifests; runtime tests consume those exports. Runtime acceptance identities cover all native crate sources, allocator probe/fixture and package manifests. Model-report tests accept explicitly blocked runtime proof on a fresh checkout, and require both diagnostics to pass before runtime PASS. Source text follows repository LF bytes for cross-platform hash stability.

- **Configuration-driven continuation (2026-10-20):** DONE (synthetic configuration increment); owner Codex; baseline d56c890 plus existing local work. User authorizes synthetic rotor geometry and multiple configurations rather than one calibrated rotor. Generalize offline NeuralFoil generation to NACA four-digit profiles and BET validation to versioned synthetic rotor configurations with independent polar selection, blade count, radius/root, spanwise chord/twist, quadrature and operating points. Additional scope: `scripts/check-rotor-bet.py` (retain old CLI wrapper), `tests/fixtures/rotors/synthetic-bet-suite.json`, `tests/fixtures/polars/naca0012-neuralfoil.json`, the generator/registry/tests, model reporter/schema (v7), architecture/specification/roadmap and Russian mirrors. Preserve existing tolerances and per-configuration confidence/validity screening; test scale laws, blade-count response, independent airfoil selection and invalid inputs. Synthetic geometry is sufficient for implementation and numerical validation; measured fidelity remains a separate evidence category, not a prerequisite for this continuation.
- **Configuration evidence:** Three independent synthetic rotor definitions and two NeuralFoil airfoils execute 72 numerical cases, all PASS. Maximum uniform CT/CP oracle error: 4.996003610813204e-16; maximum annular residual: 9.587418512725526e-11. Screening is unchanged: baseline 0/24, tapered three-blade 2/24, symmetric four-blade 9/24 clear flags (11 clear, 61 flagged overall). Both NACA6409 and NACA0012 generators reproduce byte-for-byte. NACA0012 fixture SHA-256: b65b811583008327d517505e2995ed2bd1ee9fa66cad207288bf0a436a01dab1. Reports: `test-results/validation/rotor-bet.json` (schema v2) and model-report schema v7. Nineteen Python tests, 15 focused Vitest tests plus registered-fixture hash verification, TypeScript, ESLint and production build pass; bundle/linker/hardlink warnings remain. Tests cover radius scaling (force R^4, power R^5 at fixed RPM with geometrically scaled state and constant coefficients), blade-count response, spanwise taper/twist, profile identity, symmetric-airfoil behavior and invalid-input rejection. The synthetic suite is the development baseline; no target-rotor measurements are needed to continue implementation. Measured fidelity, failed historical UIUC gates and production BET session integration remain separately reported.

- **NACA6409 BET continuation:** DONE (numerical integration increment only); owner Codex; baseline d56c890 plus preserved local NACA6409 dataset. Feed the hash-verified NeuralFoil table into the existing native uniform/annular BET runners using an explicitly synthetic NACA6409 rotor. Add an independent Python uniform-inflow force/momentum oracle, conservative final-section confidence screening and a schema-v6 surrogate section in the model report. Additional scope: `scripts/check-naca6409-bet.py`, `tests/test_naca6409_bet.py`, `scripts/validate-models.mjs`, `tests/model-validation.test.ts`, `docs/validation/model-report.schema.json`, `docs/architecture.md` and its Russian mirror. Predeclared coefficient oracle tolerances: absolute 1e-9, relative 1e-8; momentum residual <=1e-9 relative force scale; confidence >=0.9; an incompressible approximation is explicitly limited to Mach<=0.3 without inventing compressibility data. Failure criterion: coefficient/oracle mismatch, malformed native output, nonconvergence, stale inputs, lost validity flags, or treating surrogate results as measured fidelity. Production ABI binding remains a separate capability increment.
- **NACA6409 BET evidence (2026-10-20):** Windows 11; Python 3.12; rustc 1.97.0. The new native pipeline executes 24 cases (12 uniform and 12 annular). Maximum independent uniform CT/CP error is 1.1102230246251565e-16; maximum annular relative residual is 9.455382564231208e-11. Numerical checks PASS; 23 cases have low-confidence cells, six have native polar/Mach-limit flags, and none clear all screening flags. These overlap counts never become measured PASS. Report: `test-results/validation/naca6409-bet.json`; model-report schema v6 records numerical PASS separately from unvalidated surrogate fidelity and retains failed UIUC fidelity (CLI exit 2). Verification: 12 Python tests, 15 focused Vitest tests (including v5 rejection, required surrogate evidence and rejection of surrogate fidelity relabeling), 62 native tests, generator byte reproduction, TypeScript, ESLint and production build all pass; existing bundle/linker/hardlink warnings remain. English/Russian specifications, architecture and roadmap are synchronized; source/executable/polar identities are in the reports. No browser/runtime ABI changes, measured acceptance or autopilot READY admission. TASK-033 remains BLOCKED_EXTERNAL overall.

- **NACA6409 continuation (2026-10-20):** DATA_GENERATION_DONE; owner Codex; baseline aab5e47. The operator selects NACA6409 and NeuralFoil for the new airfoil dataset. Generate a separate reproducible surrogate polar, including confidence and provenance; preserve the measured SDA1075 comparisons without substituting a different section. Scope: `scripts/generate-neuralfoil-polar.py`, `scripts/neuralfoil-requirements.txt`, `tests/test_neuralfoil_polar.py`, `tests/fixtures/polars/naca6409-neuralfoil.json`, `tests/fixtures/registry.json`, this roadmap, the engine specification and their Russian mirrors. Failure criterion: nonfinite coefficients, negative drag, invalid confidence, changed geometry/dependencies, or reproduction mismatch. This selection removes the need for SDA1075 data for the new model; it does not establish measured fidelity or implement production BET binding.
- **NACA6409 evidence:** Python 3.12, NeuralFoil 0.3.3, AeroSandbox 4.2.10, NumPy 2.5.4; all 22 environment distributions pinned. Generated 1210 points: alpha -30..30 degrees / 0.5 degree, ten Re nodes 1000..1000000, incompressible only. 601 nodes have confidence >=0.9; the remaining 609 are retained and screened by minimum contributing-corner confidence. Fixture SHA-256 d6d9793ea030c6b957fa9018ed5c3307891665829773574b2bacb26f1909c9a1. Generator `--check` exit 0; seven Python tests pass (independent NACA geometry, direct NeuralFoil samples, interpolation, bounds, confidence and registered synthetic provenance). TypeScript, ESLint and Vite build exit 0; existing bundle warning remains. Four Vitest files execute 21 tests: 20 pass, one existing NASA regeneration case cannot launch the Windows python3 alias; equivalent `python -I tests/fixtures/contact/generate_nasa_drop.py --check` passes. Fixture hash verification separately passes. Initial Vitest execution hit sandbox temporary-file rename errors; using workspace `.cache/tmp` permits execution. Documentation check passes (21 bilingual pairs, 86 tasks, six layouts); git diff --check passes. No production backend, measured acceptance or autopilot READY is claimed.


- **Status:** DONE — Codex; baseline d56c890; 2026-10-20. Configurable synthetic-geometry/NeuralFoil implementation and software validation complete. Measured fidelity remains independently failed/blocked and cannot admit training or autopilot modes.
- **Phase 1 disposition:** Reused (S05). The failed UIUC and deferred NASA comparisons keep their verdicts.
- **Title & Description:** Run numerical/reference validation and report model fidelity separately.
- **Dependencies:** TASK-014, TASK-024, TASK-028, TASK-029, TASK-031.
- **Touched Files:** `scripts/validate-models.mjs`, `tests/model-validation.test.ts`, `docs/validation/model-report.schema.json`, `tests/fixtures/validation/reference-manifest.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`, `packages/physics/src/nasa-drop.ts`, `packages/physics/src/ground-contact.ts`, `tests/fixtures/contact/nasa-drop.json`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `native/bet/src/propeller.rs`, `native/bet/src/lib.rs`, `native/bet/tests/propeller.rs`, `tests/documentation-policy.test.ts`, `native/bet/examples/propeller_points.rs`, `packages/physics/src/uiuc-propeller.ts`, `tests/uiuc-propeller.test.ts`, `tests/fixtures.test.ts`, `tests/fixtures/rotors/uiuc-propellers.json`, `tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py`, `tests/fixtures/rotors/uiuc/sda1075.dat`, `data/uiuc-propdb/inventory.json`, `docs/operations/uiuc-propdb-data.md`, `docs/ru/uiuc-propdb-data.md`, `docs/documentation-index.json`, `test-results/validation/model-report.json`, `tests/fixtures/polars/generate_sda1075_xfoil.py`, `tests/fixtures/polars/sda1075-xfoil.json`.
- **Interfaces / Contracts:** ValidityEnvelope; numerical parity is separate from experimental validity.
- **DoD & Acceptance Criteria:** Smooth 10 s cases stay within 0.1 m/0.5 degrees of 4800 Hz references; meet scalar/SIMD force/moment tolerances in section 4; retain reference provenance; missing measurements block fidelity rather than producing a synthetic PASS.
- **Evidence:** Owner Codex/Claude; verified 2026-10-18. `node scripts/validate-models.mjs` exits 2 and writes schema v5 `test-results/validation/model-report.json`: 12 numerical cases (400/800/1200 Hz vs 4800 Hz) PASS within `0.1` m / `0.5` deg (max position error `1.624e-10` m); TASK-029 contact G1 and TASK-031 JSBSim backend/G1 diagnostics PASS; archived NASA TM X-3561 drop comparison (`tests/fixtures/contact/nasa-drop.json`, `test-results/validation/nasa-drop-legacy.json`) is recorded as `blocked` (deferred by user decision, failing rigid-sphere deceleration/stroke comparison preserved); UIUC Propeller Database DA4002/DA4022 comparisons (`data/uiuc-propdb/inventory.json`, [UIUC data guide](operations/uiuc-propdb-data.md), `tests/fixtures/rotors/uiuc-propellers.json`, `tests/fixtures/polars/sda1075-xfoil.json`, `test-results/validation/propeller-points.json`, `test-results/validation/propeller-bem.json`, `test-results/validation/propeller-source-review.json`, `test-results/validation/task-033-continuation.json`, `test-results/validation/task-033-handoff-review.json`) report `failed` against fixed CT/CP tolerances (`0/534` thin-airfoil, `26/165` MIT XFOIL 6.99 uniform-inflow, and `48/193` annular tip/hub/swirl BEM with 690 points outside polar and 75 outside momentum validity). Remaining external blockers: measured low-Re SDA1075 polars, measured full-airframe/rotor datasets, UIUC archive license decision, and production BET C ABI binding.

### TASK-086 — UIUC-derived JSBSim propeller tables

- **Status:** DONE — Claude; baseline 324d15e; 2026-10-18. Tables generated and verified; native load and thrust check in pinned JSBSim v1.2.3 pass (18/18 points).
- **Title & Description:** Generate JSBSim fixed-pitch propeller definitions (C_THRUST/C_POWER versus J) from the hash-verified UIUC Propeller Database for future fixed-wing models.
- **Dependencies:** TASK-030, TASK-033.
- **Touched Files:** `data/jsbsim/generate_uiuc_propellers.py`, `data/jsbsim/engine/uiuc_apce_10x5.xml`, `data/jsbsim/engine/uiuc_apce_10x7.xml`, `data/jsbsim/engine/uiuc_apce_11x7.xml`, `data/jsbsim/engine/uiuc_apce_12x6.xml`, `data/jsbsim/engine/uiuc_apce_14x10.xml`, `data/jsbsim/engine/uiuc_da4002_9x6p75.xml`, `data/jsbsim/engine/uiuc-propellers.manifest.json`, `tests/jsbsim-propellers.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/operations/uiuc-propdb-data.md`, `docs/ru/uiuc-propdb-data.md`, `native/jsbsim/propeller_probe.cpp`, `native/jsbsim/propeller/CMakeLists.txt`, `scripts/check-jsbsim-propellers.mjs`, `CLAUDE.md`, `docs/ru/CLAUDE.md`.
- **Interfaces / Contracts:** JSBSim propeller XML, `<table name="C_THRUST|C_POWER" type="internal">` versus J = V/(nD), with the same coefficient convention as UIUC; manifest `uiuc-propellers.manifest.json` with per-file SHA-256 and sources.
- **DoD & Acceptance Criteria:** Rows copied exactly as printed by a declared RPM-selection rule; byte-for-byte `--check`; every source traced to the inventory; native JSBSim v1.2.3 load plus a static and advancing thrust check against the measured CT within 1%.
- **Evidence:** Owner Claude; baseline 324d15e; 2026-10-18. `data/jsbsim/generate_uiuc_propellers.py --check` verifies the six fixed-pitch XML definitions (APC Thin Electric `10x5`, `10x7`, `11x7`, `12x6`, `14x10`, and `DA4002 9x6.75`) and `data/jsbsim/engine/uiuc-propellers.manifest.json`. `JSBSIM_SOURCE_DIR=<checkout> node scripts/check-jsbsim-propellers.mjs` (`test-results/validation/jsbsim-propellers.json`) loads all six files through `FGFDMExec::LoadModel` in pinned JSBSim v1.2.3 (`570e8115a102df8f877b11e0e59b964ea483e3c0`) and passes 18/18 static, mid-curve, and interpolated thrust/power points within `4.1e-16` relative of measured CT/CP (tolerance 1%). `tests/jsbsim-propellers.test.ts`: 4 PASS. Remaining limitations outside DoD: flight models must supply `<ixx>` rotational inertia, UIUC redistribution license review applies to derived tables, and Vol 4 true versus nominal diameters remain unverified.

## Phase 3: ArduPilot & Radio Link

### TASK-034 — Ideal sensors

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Convert truth into IMU/magnetometer/barometer/airspeed observations without noise or EW.
- **Dependencies:** TASK-013, TASK-028, TASK-032.
- **Touched Files:** `packages/sensors/package.json`, `packages/sensors/src/ideal.ts`, `tests/ideal-sensors.test.ts`, `package-lock.json`, `tests/fixtures/sensors/ideal.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** GpsSample/ImuSample; acceleration versus specific force; gauss/Pa internal units.
- **DoD & Acceptance Criteria:** Stationary/free-fall/rotated-body fixtures pass; gyro/mag use body axes; verify pressure signs; write outputs in place and meet G1.
- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. `tests/ideal-sensors.test.ts` (2 PASS against `tests/fixtures/sensors/ideal.json`) verifies stationary/free-fall/inverted specific force, rotated body magnetic gauss, ISA Pa/Down sign, and dynamic pressure. `node scripts/bench-sensors.mjs ideal` (`test-results/bench/sensors-ideal.json`) passes six `1e6`/`2e6` windows with 0 GC and 0 incremental B/step.

### TASK-035 — Sensor rates, noise, and bias

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Add rational sampling, bounded latency, and seeded noise streams.
- **Dependencies:** TASK-004, TASK-011, TASK-034.
- **Touched Files:** `packages/sensors/src/scheduler.ts`, `packages/sensors/src/noise.ts`, `packages/sensors/src/latency.ts`, `tests/sensor-scheduler.test.ts`, `tests/sensor-noise.test.ts`, `scripts/bench-sensors.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** IMU 200/400 Hz; GPS 5/10 Hz; PSD/bandwidth; sample time.
- **DoD & Acceptance Criteria:** Exact sample counts over 60 simulated seconds at 400/800/1200; repeatable seeds; statistics within declared confidence intervals; bounded monotonic latency queues.
- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. `tests/sensor-scheduler.test.ts` (2 PASS) and `tests/sensor-noise.test.ts` (2 PASS) verify exact 60 s sample counts at 400/800/1200 Hz for 5/10/200/400 Hz sensors, bounded monotonic latency FIFO, and 1e6-sample Gaussian variance/bias walk. `node scripts/bench-sensors.mjs all` (`test-results/bench/sensors-all.json`) passes six `1e6`/`2e6` windows after 4e6 warmup ticks with 0 GC and 0 incremental B/step.

### TASK-036 — WGS84 and MSL

- **Status:** DONE — Claude; baseline 346866c; 2026-10-16 (absolute MSL accuracy gate BLOCKED_EXTERNAL until an authoritative geoid grid is installed).
- **Phase 1 disposition:** Reused (S07). The absolute MSL gate opens only with the TASK-148 geoid grid.
- **Title & Description:** Implement float64 origin/ECEF/NED/geoid conversion.
- **Dependencies:** TASK-004, TASK-006.
- **Touched Files:** `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `tests/geodesy.test.ts`, `tests/fixtures/geodesy/wgs84.json`, `tests/fixtures/geodesy/generate.py`, `tests/fixtures/registry.json`, `packages/sensors/package.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** WGS84 ellipsoidal h versus MSL H; authoritative geoid data/hash/license.
- **DoD & Acceptance Criteria:** Local synthetic roundtrips<=1 mm; test poles/antimeridian/15 km offsets without cos(latitude) singularities; absent geoid data explicitly blocks the absolute MSL accuracy gate.
- **Evidence:** Owner Claude; baseline 346866c; 2026-10-16. `tests/geodesy.test.ts` (8 PASS against `tests/fixtures/geodesy/wgs84.json`) verifies forward/Bowring-inverse WGS84 and tangent-frame roundtrips within `1` mm across both poles, the antimeridian, and 15 km offsets, plus synthetic geoid `H = h - N` interpolation. Remaining limitation: no authoritative geoid grid (EGM96/EGM2008 source, license, SHA-256) is installed, so absolute MSL accuracy remains `BLOCKED_EXTERNAL`.

### TASK-037 — MAVLink2 codec

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Pin the dialect/generator and implement streaming binary parsing/encoding.
- **Dependencies:** TASK-003, TASK-004, TASK-013.
- **Touched Files:** `packages/mavlink/package.json`, `packages/mavlink/dialect.lock.json`, `packages/mavlink/src/codec.ts`, `packages/mavlink/src/sensor-mapping.ts`, `tests/mavlink.test.ts`, `tests/fixtures/mavlink/golden.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `packages/mavlink/src/messages.ts`, `packages/mavlink/src/samples.ts`, `scripts/generate-mavlink-fixtures.py`, `tests/fixtures/registry.json`, `package-lock.json`, `scripts/bench-links-ew.mjs`, `tests/sensor-samples.ts`, `tests/links-ew-allocation.test.ts`, `packages/mavlink/NOTICE`.
- **Interfaces / Contracts:** HIL_GPS/HIL_SENSOR/HIL_ACTUATOR_CONTROLS/RC_CHANNELS_OVERRIDE; engine specification section 6.
- **DoD & Acceptance Criteria:** Match official-generated frames including CRC_EXTRA/packing; test arbitrary chunks/truncation/bad CRC/sequence; cover DOP times 100, gauss/hPa/LSB/u64; no unsafe any.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/mavlink.test.ts` (5 PASS) verifies byte-for-byte parity with official `pymavlink` 2.4.50 frames (`tests/fixtures/mavlink/golden.json`, `packages/mavlink/dialect.lock.json`), arbitrary chunk framing, CRC/signing rejection, and sequence wrap. `node scripts/bench-links-ew.mjs all 400|800|1200` (`test-results/bench/links-ew-all-400.json`..`1200.json`) passes with 0 GC. Signed MAVLink and unlisted message IDs remain unsupported.

### TASK-038 — RC and flight-mode mapping

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Extend USB calibration with modes and correctly encode RC override.
- **Dependencies:** TASK-010, TASK-037.
- **Touched Files:** `packages/input/src/mode-channel.ts`, `packages/input/src/calibration-store.ts`, `packages/mavlink/src/rc-override.ts`, `apps/web/src/App.tsx`, `tests/rc-override.test.ts`, `tests/browser/radio.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/runtime.ts`, `packages/input/package.json`, `packages/input/src/index.ts`, `tests/fixtures/registry.json`, `apps/web/package.json`, `package-lock.json`, `scripts/bench-links-ew.mjs`, `tests/links-ew-allocation.test.ts`, `docs/hardware/radio-checklist.md`, `docs/ru/radio-checklist.md`, `docs/documentation-index.json`.
- **Interfaces / Contracts:** Pilot mailbox v2; RC endpoints/deadzone/mode slots; channel-group sentinel semantics.
- **DoD & Acceptance Criteria:** Persist schema-versioned calibration; bad axes/unplug/reconnect disarm; enforce zero-throttle arming; test PWM endpoints and group-specific release/ignore; retain a separate physical USB checklist.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/rc-override.test.ts` (4 PASS) and `tests/browser/radio.spec.ts` (1 PASS) verify versioned calibration persistence, independent mode-channel mapping, disarm on calibration change/unplug, and `PilotRcMapper` PWM endpoints and channel-group release/ignore sentinels (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC). Physical USB transmitter verification in [radio-checklist.md](hardware/radio-checklist.md) remains `NOT_RUN`.

### TASK-039 — Autopilot state machine

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Define mutually exclusive autopilot backends and lifecycle/link policies.
- **Dependencies:** TASK-010, TASK-012, TASK-013, TASK-037.
- **Touched Files:** `packages/autopilot/package.json`, `packages/autopilot/src/adapter.ts`, `packages/autopilot/src/state-machine.ts`, `tests/autopilot-state.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `package-lock.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** disconnected to initializing to warming to ready to running to fault; actuators/health.
- **DoD & Acceptance Criteria:** Reject illegal transitions and concurrent SITL/HITL; stale actuators/disarm/link loss cannot hold thrust indefinitely; never fabricate EKF READY.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/autopilot-state.test.ts` (2 PASS) and G1 probes (`test-results/bench/links-ew-all-400.json`..`1200.json`) verify mutually exclusive backend admission, illegal transition rejection, 100 ms actuator timeout/staleness disarm, and adapter-sourced health requirements before `READY`.

### TASK-040 — Local WebSocket bridge

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Implement loopback transport with origin/session checks and bounded framing.
- **Dependencies:** TASK-003, TASK-037, TASK-039.
- **Touched Files:** `apps/bridge/package.json`, `apps/bridge/src/server.ts`, `apps/bridge/src/session.ts`, `apps/bridge/src/framing.ts`, `tests/bridge.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `package-lock.json`, `scripts/bench-links-ew.mjs`.
- **Interfaces / Contracts:** WS localhost:9002; version/length/epoch binary frames; separate UDP channels.
- **DoD & Acceptance Criteria:** Reject unauthorized origins/sessions and oversized/flooded frames; bind loopback by default; test split/coalesced frames/backpressure/reconnect; document WSS/PNA compatibility.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/bridge.test.ts` (3 PASS) verifies loopback `127.0.0.1:9002` WS/UDP roundtrips, split/coalesced binary v1 framing, token/origin/session rejection, 4096-byte / 4096 msg/s / 64 KiB queue bounds, backpressure, and reconnect. Production HTTPS/WSS/PNA hosting requires separate integration.

### TASK-041 — ArduPilot JSON physics backend

- **Status:** DONE — Claude; baseline 6401104; 2026-10-16.
- **Title & Description:** Connect truth/sensors and servo outputs in external SITL lockstep.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-040.
- **Touched Files:** `apps/bridge/src/ardupilot-json.ts`, `packages/autopilot/src/external-sitl.ts`, `tests/ardupilot-json.test.ts`, `tests/fixtures/sitl/json-protocol.json`, `apps/bridge/src/server.ts`, `apps/bridge/package.json`, `packages/autopilot/package.json`, `package-lock.json`, `tests/fixtures/sitl/generate.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Pinned ArduPilot JSON protocol; frame counters/time domain; MAVLink does not replace physics JSON.
- **DoD & Acceptance Criteria:** Verify UDP schema/endianness/servo mapping against pinned upstream; lost/duplicate/out-of-order packets never double-step; wait for valid actuator before next tick while pause stays responsive.
- **Evidence:** Owner Claude; baseline 6401104; 2026-10-16. `tests/ardupilot-json.test.ts` (10 PASS against `tests/fixtures/sitl/json-protocol.json` from pinned ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` `SIM_JSON.h`/`SIM_JSON.cpp`) verifies 16/32-channel servo decoding, byte-exact `%.9f` sensor replies, key-order validation (`velocity` before `velocity_wind`), 20,000-frame loss/duplicate/reorder lockstep stepping without double-stepping, and loopback UDP/WebSocket bridge forwarding.

### TASK-042 — External SITL integration harness

- **Status:** DONE — Codex; baseline 324d15e; 2026-10-19. Pinned native ArduCopter completes closed-loop arm/takeoff/hold/land through the Rust WASM rigid-body backend and synthetic quad X reference; original MAVLink/physics captures pass independent replay and CRC audits.
- **Title & Description:** Run pinned ArduPilot and verify closed-loop flight without cloud APIs.
- **Dependencies:** TASK-031, TASK-037, TASK-038, TASK-039, TASK-041.
- **Touched Files:** `scripts/run-sitl.mjs`, `scripts/sitl.lock.json`, `tests/integration/external-sitl.test.ts`, `tests/fixtures/sitl/parameters.parm`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`.
- **Interfaces / Contracts:** Process lifecycle; RC/sensor/actuator loop; telemetry recording.
- **DoD & Acceptance Criteria:** Actually execute arm/takeoff/hold/land with nonzero frames; missing/fake binaries or bridge fail tests; clean up only owned processes; freeze mode/altitude thresholds in fixtures.
- **Evidence:** Owner Codex; baseline 324d15e; 2026-10-19. Pinned native ArduCopter (`8ab6afde107a91df1b5f60ade8f333cb8a61b190`, ELF SHA-256 `fa37bf619bce116d410931f1b7d24ea72ed444ba529379df0db9738742ecb186`) driven by `scripts/sitl/driver.mjs` and `pymavlink` 2.4.50 sidecar at 800 Hz (`trace v2`, stride 8). Final flight (`test-results/validation/task-042-flight.json`): 67,257 physics frames, 4,161 scored samples, 84.07125 simulated seconds in 43.075 wall seconds, 0 gaps/duplicates/restarts, 10.20 s hold at `9.7914–9.9966` m truth / `9.755–9.989` m autopilot altitude, and disarmed ground landing; all 2,113 telemetry observations match CRC-checked MAVLink bytes (`scripts/check-sitl-capture.mjs`). Process ownership, fake-ELF rejection, and capture mutation suites (`tests/integration/external-sitl.test.ts`, `tests/sitl-quad.test.ts`, `tests/sitl-flight-trace.test.ts`) pass (`test-results/validation/task-042-unit.xml`, `test-results/validation/task-042-rejections.json`, `test-results/validation/task-042-completion.json`). Does not validate measured aircraft aerodynamics (`TASK-033`) or enable browser autopilot `READY`.

### TASK-043 — EKF warmup and health

- **Status:** DONE — Codex; baseline 324d15e; 2026-10-19. Native LiveEkfWarmup admission, acknowledged JSON lockstep IMU timing, CRC-checked MAVLink EKF/GNSS diagnostics, and observed GNSS-age revocation/recovery pass live ArduCopter capture replay. Browser READY and recorded Simulation-on-Hardware remain separate.
- **Title & Description:** Warm up for 30 simulated seconds and admit READY from actual EKF diagnostics.
- **Dependencies:** TASK-035, TASK-039, TASK-042.
- **Touched Files:** `packages/autopilot/src/warmup.ts`, `packages/autopilot/src/ekf-status.ts`, `packages/autopilot/package.json`, `packages/mavlink/src/codec.ts`, `tests/warmup.test.ts`, `tests/integration/ekf-ready.test.ts`, `tests/fixtures/mavlink/ekf-golden.json`, `tests/fixtures/mavlink/generate-ekf.py`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Normalized ekf_flags; source freshness; fast-forward only for SITL.
- **DoD & Acceptance Criteria:** Sensor timestamps agree; failed innovations never become READY just because a timer elapsed; measure acceleration factor; reject HITL fast-forward; disable startup EW until ready.
- **Evidence:** Owner Codex; baseline 324d15e; 2026-10-19. `packages/autopilot/src/warmup.ts`, `ekf-status.ts`, and `live-warmup.ts` (`json-lockstep` acknowledged IMU sample clock + CRC-checked `EKF_STATUS_REPORT`, `GPS_RAW_INT`, `HIGHRES_IMU`, `HEARTBEAT`; `0.01` s IMU and `0.3` s GNSS freshness bounds). In the pinned ArduCopter run (`test-results/validation/task-043-warmup.json`, `test-results/validation/task-043-flight.json`), `READY` first occurs at `41.27625` simulated seconds / `20.733261598` wall seconds (`1.990822804x` acceleration); all 8,413 readiness observations and 31,953 wire frames match raw MAVLink replay (`scripts/check-ekf-warmup.mjs`), including two observed GNSS-age excursions (`>0.3` s) that revoke and recover `READY`/EW admission, plus 7 synthetic rejection probes (`tests/warmup.test.ts`, `tests/integration/ekf-ready.test.ts`, `test-results/validation/task-043-unit.xml`, `test-results/validation/task-043-completion.json`). Browser UI autopilot `READY` and recorded Simulation-on-Hardware remain separate.

### TASK-044 — ArduPilot WASM feasibility gate

- **Status:** DONE — Codex; baseline c3a4735; 2026-10-17. Independent feasibility gate completed; local WSL/Emscripten build and browser Worker/EEPROM boot were subsequently verified in TASK-045, while GPL redistribution (BLOCKED_DECISION) remains open; MirageSITL flight parity passed in TASK-047 without selecting the application backend; TASK-046 now verifies the browser HAL.
- **Phase 1 disposition:** Preserved: browser-hosted ArduPilot is not a Phase 1 flight mode and is not expanded (scope section 2).
- **Title & Description:** Probe HAL/scheduler/storage/network/licensing and record a concrete feasibility decision.
- **Dependencies:** TASK-016, TASK-039, TASK-042.
- **Touched Files:** `docs/decisions/ardupilot-wasm.md`, `native/ardupilot/source.lock.json`, `native/ardupilot/feasibility.md`, `tests/ardupilot-wasm-capability.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `docs/ru/ardupilot-wasm.md`, `docs/ru/feasibility.md`, `scripts/probe-ardupilot-wasm.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Required browser HAL capabilities; supported firmware targets.
- **DoD & Acceptance Criteria:** Each capability has a runnable probe or observed blocker; record evidence for feasible/blocked; blocked leaves TASK-045..047 open and does not count as a working WASM mode.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `scripts/probe-ardupilot-wasm.mjs`, `tests/ardupilot-wasm-capability.test.ts` (3 PASS), `native/ardupilot/source.lock.json`, `native/ardupilot/feasibility.md`, and [ardupilot-wasm.md](decisions/ardupilot-wasm.md) audit the pinned ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` HAL/scheduler/storage/network/GPL requirements. `TASK-045` subsequently resolved the local Emscripten 4.0.15 build, Worker/pthread boot, and IndexedDB EEPROM storage; `TASK-046` subsequently verifies the browser HAL; `TASK-047` parity passed without selecting the application backend, and GPLv3 redistribution review remains open.

### TASK-045 — ArduPilot WASM build

- **Status:** DONE — Codex; baseline af984ed; 2026-10-19. Local pinned build, real browser Worker/pthread admission, and persistent EEPROM acceptance verified. Artifact redistribution retains BLOCKED_DECISION (GPL review); MirageSITL flight parity passed in TASK-047 without selecting the application backend; the HAL is verified by TASK-046.
- **Phase 1 disposition:** Preserved: browser-hosted ArduPilot is not a Phase 1 flight mode and is not expanded (scope section 2).
- **Title & Description:** Build selected firmware with pinned tools and artifact hashes.
- **Dependencies:** TASK-044.
- **Touched Files:** `native/ardupilot/CMakeLists.txt`, `native/ardupilot/toolchain.lock.json`, `scripts/build-ardupilot-wasm.mjs`, `packages/autopilot/src/wasm-loader.ts`, `tests/ardupilot-wasm-build.test.ts`, `scripts/probe-ardupilot-wasm.mjs`, `tests/ardupilot-wasm-capability.test.ts`, `docs/decisions/ardupilot-wasm.md`, `docs/ru/ardupilot-wasm.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `scripts/smoke-ardupilot-wasm.mjs`, `packages/autopilot/package.json`, `native/ardupilot/wasm-artifact.manifest.json`, `packages/autopilot/src/wasm-storage.ts`, `packages/autopilot/src/wasm-browser.ts`, `apps/web/src/ardupilot.worker.ts`, `apps/web/src/diagnostics/ardupilot-check.ts`, `apps/web/ardupilot-check.html`, `apps/web/vite.config.ts`, `tests/ardupilot-wasm-storage.test.ts`, `tests/browser/ardupilot-wasm.spec.ts`, `packages/mavlink/src/codec.ts`, `tests/fixtures/mavlink/wasm-parameters.json`, `tests/fixtures/mavlink/generate-wasm-parameters.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `README.md`, `docs/ru/README.md`, `scripts/check-ardupilot-browser.py`, `native/ardupilot/feasibility.md`, `docs/ru/feasibility.md`.
- **Interfaces / Contracts:** Artifact ABI/license/firmware manifest.
- **DoD & Acceptance Criteria:** A reproducible artifact loads in Worker with checked exports/memory limits; resolve TASK-044 blockers first; an empty replacement module is forbidden.
- **Evidence:** Owner Claude/Codex; baseline af984ed; 2026-10-19. Pinned ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` (`waf configure --board wasm && waf copter` in WSL with Emscripten 4.0.15 `389a68bc35dcff7ebae4614e1615099dafda00d1`) reproducibly builds `arducopter.wasm` (`3,730,330` B, SHA-256 `556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38`) and `arducopter.js` (`258,215` B, SHA-256 `b158a7b8e9b400c770e2b4fc87c66fc2aaf68bc583c7d71f3a56786d3bcb4212`), recorded in `native/ardupilot/wasm-artifact.manifest.json`. `scripts/smoke-ardupilot-wasm.mjs` boots the artifact in Node; Chromium 155.0.8059.84 (`tests/browser/ardupilot-wasm.spec.ts`: 8 PASS) boots the admitted firmware in 1 host Worker + 4 pthreads (`16` MiB initial shared memory, `2` GiB cap), persists `WP_SPD` (`10` to `8.125` m/s) across graceful and abrupt Worker restarts in 16 KiB IndexedDB EEPROM images audited by `scripts/check-ardupilot-browser.py`, and verifies clean Worker teardown (`test-results/validation/task-045-completion.json`, `test-results/validation/task-045-wire-audit.json`, `test-results/validation/task-045-browser.xml`, `test-results/validation/task-045-unit.xml`). Artifacts remain outside the repository pending GPLv3 distribution review (`BLOCKED_DECISION`); active app backend remains demo pending `TASK-047`.

### TASK-046 — ArduPilot browser HAL

- **Status:** DONE — Codex; completion baseline 55a7c01; 2026-10-20. Real HAL clock/sensor/PWM coupling, storage and deterministic owned-Worker teardown verified at 400/800/1200 Hz. Browser flight parity passed in TASK-047 without selecting the application backend. READY remains separate.
- **Phase 1 disposition:** Preserved: browser-hosted ArduPilot is not a Phase 1 flight mode and is not expanded (scope section 2).
- **Title & Description:** Connect clock/storage/sensor/actuator endpoints to WASM firmware.
- **Dependencies:** TASK-013, TASK-035, TASK-045.
- **Touched Files:** `native/ardupilot/hal/browser_hal.cpp`, `packages/autopilot/src/wasm-sitl.ts`, `tests/wasm-hal.test.ts`.
- **Interfaces / Contracts:** Simulation lockstep clock; virtual storage; preallocated mailboxes; separate AP Worker if required by HAL.
- **DoD & Acceptance Criteria:** Native/WASM HAL probes agree; no assumed native sockets/files; validate sensor timing/actuator counts; tab pause and termination do not deadlock.

- **Implementation scope:** Versioned fixed-size HAL mailbox/native probe (`native/ardupilot/hal/browser_hal.h`, `browser_hal.cpp`, `probe.cpp`); pinned integration patch and local build/check tools (`native/ardupilot/hal/sitl-state.patch`, `scripts/build-ardupilot-hal.mjs`, `scripts/check-ardupilot-hal.mjs`); host adapter (`packages/autopilot/src/wasm-sitl.ts`), cold binding callback in `wasm-browser.ts`, package export, native/TS/browser tests (`tests/wasm-hal.test.ts`, `tests/browser/wasm-hal.spec.ts` and test Worker), engine specification/architecture/baseline instructions and Russian mirrors. Isolated source/build; preserve TASK-045 bytes and TASK-074 work. Separate HAL artifact identities; no firmware redistribution or TASK-047 parity claim. Existing ABI-v2 queues retain their byte layout and single-writer ownership.

- **Additional probe scope:** `native/ardupilot/hal/wasm_probe.cpp` exercises the actual HAL kernel in pthread WASM with allocator instrumentation; `fault_probe.cpp` independently rejects malformed native frames. Update `scripts/probe-ardupilot-wasm.mjs` and feasibility/decision guides (with Russian mirrors) to distinguish implemented HAL evidence from still-unadmitted production flight.

- **Lifecycle regression:** Finish checkpoint/store/profile cleanup before terminating any pthread. Detach callbacks, terminate all peers and acknowledge/close the owner without another asynchronous turn. Reject late pthread construction. The delayed-release fixture checks this ordering against four real pthreads; the original zero-Worker deadline remains unchanged.

- **Legacy regression diagnostics:** `tests/browser/ardupilot-wasm.spec.ts` reports remaining Worker URLs on cleanup failures; the zero-owned-Worker assertion remains unchanged.

- **Initial HAL evidence (2026-10-20):** `node scripts/build-ardupilot-hal.mjs --resume` exits 0 with local WASM SHA-256 `765e082bcc6d1c89124379645d64aa7c82784430032204a130f73b323818be51` (3,733,494 bytes), pinned ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190`, Emscripten 4.0.15. `node scripts/check-ardupilot-hal.mjs` passes three native million-step runs at 400/800/1200 Hz; `--reuse-native` refreshes JS/WASM evidence only after exact native source hash checks. Kernel WASM SHA-256 `15c0415a100ff4da328c17186a1a5be95e60771fa94c4eb7dd544a1dfa66a476`: one million steps, 0 malloc calls/bytes, 0 measured JS GC events, 0.002976 incremental JS bytes/step, stable memory, detected allocating controls. Report: `test-results/validation/task-046-allocation.json`, with its hash-bound native reference. Nine independent native malformed-frame cases reject before modifying output. Focused unit run: 23 PASS, 1 optional original-artifact test skipped. `tests/browser/wasm-hal.spec.ts`: 4 PASS on Chromium 141.0.7390.37 / Windows, using the final artifact; 8 simulated seconds at each rate plus 800 BET steps with synthetic NACA6409/NeuralFoil geometry, pause/frozen clock, resume and zero remaining Workers. Reports: `test-results/validation/task-046-browser-{400,800,1200}.json` and `task-046-browser-800-bet.json`, including admitted manifests. The bounded 4 ms test-Worker pump batches exchanges; no real-time rate or full-firmware allocator claim follows. Typecheck, scoped/full lint and production web build pass (existing chunk-size warning).

- **Historical failure evidence (resolved):** At 55a7c01, a four-case restart/profile run passed 3 and failed 1 with an unresponsive owner Worker. Speculative self-close changes were removed. Callback detachment alone did not fix the await after peer termination. Completion now removes that asynchronous gap; two negative-control runs against 55a7c01 fail the independent release/termination ordering oracle, while repeated and full final acceptance pass. Prior failures remain historical evidence rather than being relabelled successful.

- **Historical common regression record:** The bounded full unit run (`vitest run --maxWorkers=2`) finished with 556 PASS, 4 FAIL, 1 skipped: three documentation-policy failures captured an intermediate stale roadmap mirror, and one legacy `wasm-abi` GC assertion observed a collection. After synchronization, an isolated unchanged-threshold rerun of documentation policy, WASM ABI and HAL tests passed 19/19. The full run is retained as failed; this focused rerun is not represented as a green full suite.

- **Completion scope (baseline 55a7c01):** `tests/browser/firmware-lifecycle-worker.ts` and an added real-firmware case in `tests/browser/ardupilot-wasm.spec.ts` delay the actual Web Lock release Promise to expose teardown interleavings. `wasm-browser.ts` must finish asynchronous profile/storage cleanup before terminating pthreads, prohibit late thread creation, and retain exclusive resource ownership. No deadline or zero-Worker assertion is relaxed.

- **Completion acceptance:** Frozen baseline `6052519` plus the three hash-bound TASK-046 source/test files; `test-results/validation/task-046-completion.json` records identities and exact scope. `node node_modules/playwright/cli.js test tests/browser/ardupilot-wasm.spec.ts tests/browser/wasm-hal.spec.ts`: 13 PASS, 0 skipped; the restart/profile/delayed-release subset with `--repeat-each 3`: 9 PASS and 21 real firmware boots. `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --reporter=default --reporter=junit --outputFile.junit=test-results/task-046-unit.xml`: 561 PASS and 1 contact allocator timeout across 100 files, 0 skipped, including the optional real ArduCopter artifact smoke through `MIRAGE_ARDUPILOT_WASM_DIR`. The identical contact test then passes alone with `--maxWorkers=1`, its original 300000 ms guard, and AboveNormal priority only for its owned processes. Thus all 562 unit cases have passing coverage on identical frozen source bytes; the full-run timeout is retained, not rewritten as a green single run. Reports: `test-results/validation/task-046-browser-final.xml`, `task-046-unit-full.xml`, `task-046-unit-contact.xml`. Lint, strict typecheck, production web build (unchanged chunk warning), bilingual documentation and staged whitespace checks pass. Acceptance uses a frozen source fixture with the same pinned root/nested dependencies and its recorded Git HEAD to avoid unrelated concurrent edits. Its initial metadata-only CLI failure was corrected and both focused and full runs were repeated. The earlier concurrent browser page-setup timeout was rerun in isolation with the original deadline; no firmware or cleanup assertion was relaxed. Refreshed HAL G1 passes one million WASM/JS steps (0 calls/bytes, 0 GC events, stable memory, positive controls) with hash-identical native million-step evidence at all three rates; all 9 native malformed-frame cases reject unchanged output.

- **Remaining for TASK-046:** None. Native/WASM flight parity, production autopilot READY and whole-firmware allocator qualification remain separate; GPL distribution remains BLOCKED_DECISION. The active application retains its separately admitted backend.

### TASK-047 — WASM/native SITL parity

- **Status:** DONE — Cursor; baseline bfc2cb6; 2026-10-20. Native and browser arm/takeoff/land and GCS-failsafe flights match inside the fixed 30 s limits. The demo application backend stays selected.
- **Phase 1 disposition:** Preserved: browser-hosted ArduPilot is not a Phase 1 flight mode and is not expanded (scope section 2). Its parity report `test-results/validation/autopilot-parity.json` is ignored by Git and is not in the repository; the values recorded below are the evidence, and `node scripts/compare-autopilot.mjs` regenerates the report from local captures (see the runbook).
- **Title & Description:** Compare identical scenarios and enable WASM mode only after passing parity.
- **Dependencies:** TASK-042, TASK-043, TASK-046.
- **Touched Files:** `tests/integration/wasm-sitl.test.ts`, `scripts/compare-autopilot.mjs`, `docs/validation/autopilot-parity.schema.json`.
- **Interfaces / Contracts:** Identical seeds/parameters/airframe; mode/EKF/trajectory tolerances.
- **DoD & Acceptance Criteria:** Both run arm/takeoff/land and failsafe; define thresholds first: position RMSE<=0.5 m and attitude RMSE<=2 degrees over the 30 s reference; diagnose divergence rather than automatically rewriting goldens.
- **Execution scope:** Add a fail-closed capture comparator/schema and independent numerical/admission tests first; then capture the same configurable synthetic NACA6409/NeuralFoil BET aircraft, origin, sensor seed, parameters and tick-scheduled commands through native JSON SITL and the real browser HAL. Supporting capture drivers/Workers, explicit synthetic ground support in BET, and browser boot defaults may be added where required, with focused regressions and synchronized engine/architecture documentation. Preserve unrelated reports and local firmware. Failure criteria include incomplete flight/failsafe, stale or unhealthy telemetry, unequal input identities/ticks, missing provenance, or either fixed RMSE limit exceeded. An analyzer test or matching disarmed traces cannot admit browser READY; retain the demo backend until real flight and existing runtime gates pass.
- **Discovered dependency repair:** The independent wire audit exposed delayed EKF decoding when `MavParser` scanned an unsupported frame's payload for another start byte. Extend scope to `packages/mavlink/src/codec.ts` and its framing regression: consume the bounded, structurally valid unsupported envelope as a whole; never admit its payload, and preserve resynchronization for corrupt known frames. Repeat captures after the fix; do not relabel the earlier freshness failure as passing evidence.
- **Mode admission scope:** Add a cold, SHA-256-verified parity capability bound to the active firmware/airframe/parameter/sensor/command identities and rate; gate `AutopilotSession.connect('wasm-sitl', ...)` on that issued capability (`packages/autopilot/src/wasm-parity.ts`, state machine, package export and focused tests). A serialized/forged verdict or historical report for other inputs cannot enable this backend. This gate does not select the application backend or replace live warmup, allocator, distribution or release admission.
- **Checkpoint (local commit requested):** Real native/browser nominal and GCS-loss captures pass all four independent pymavlink audits and the fixed 30 s comparison: position RMSE 0.018855/0.048724 m, attitude RMSE 0.057905/0.096648 degrees, maximum mode/arming mismatch 0.03/0.18 s (`test-results/validation/autopilot-parity.json`). Actual-report capability admission passes. Focused framing/codec/warmup/HAL/storage/parity checks: 51 PASS; lifecycle/admission/parity checks: 32 PASS. Broad unit run: 587 PASS, 5 environment failures (loopback/symlink/Python alias), 1 optional firmware skip; environment rerun: 23 PASS across four files, including real firmware smoke, bridge, fixture and manifest checks. **Evidence:** Owner Cursor; baseline bfc2cb6; 2026-10-20. Repeated native WSL and Chromium 141 HAL captures after the allocation fix. `node scripts/compare-autopilot.mjs` exits 0 with `test-results/validation/autopilot-parity.json` PASS: takeoff-land position RMSE 0.018855 m, attitude RMSE 0.057905 degrees, mode mismatch 0.02 s; GCS-failsafe position RMSE 0.048724 m, attitude RMSE 0.096648 degrees, mode mismatch 0.19 s. Four pymavlink 2.4.50 wire audits passed. Browser captures: `tests/browser/autopilot-parity.spec.ts` 2 PASS. HAL module SHA-256 `765e082bcc6d1c89124379645d64aa7c82784430032204a130f73b323818be51`. Synthetic-pad allocation: 1,000,000 steps, 0 GC events, 0.003248 bytes/step. This report does not select the application backend.

### TASK-048 — Web Serial transport

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Phase 1 disposition:** Preserved: the Web Serial and HIL code stays; HITL, Simulation-on-Hardware and writes to a real controller are outside Phase 1 (scope section 2).
- **Title & Description:** Open ports only through a user gesture and handle stream/reconnect lifecycle.
- **Dependencies:** TASK-005, TASK-037, TASK-039.
- **Touched Files:** `packages/autopilot/src/serial-transport.ts`, `apps/web/src/SerialConnect.tsx`, `tests/serial-transport.test.ts`, `tests/browser/serial-permission.spec.ts`, `packages/autopilot/src/serial-io.worker.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/App.tsx`, `apps/web/package.json`, `package-lock.json`.
- **Interfaces / Contracts:** ReadableStream chunks to MAVLink parser; permission/user gesture; port ownership.
- **DoD & Acceptance Criteria:** Mock chunk/error/disconnect/cancel cases; reopening never duplicates a reader; unsupported browsers disable the mode; mocks are not Simulation-on-Hardware evidence.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/serial-transport.test.ts` (4 PASS) and `tests/browser/serial-permission.spec.ts` (3 PASS in Chromium) verify gesture-only port requests, single-reader ownership, 4096-byte bounded chunks with 500 ms decoder timeout in the dedicated Serial I/O Worker, and clean disconnect/reopen. Passive MAVLink2 reception from a physical Matek H743-WING over `COM7` is recorded in `test-results/hardware/serial-com7-matek.json`. Drone firmware for Hybrid SITL and Simulation-on-Hardware is the version 2 proposal `TASK-051`, not this transport task.

### TASK-049 — HIL sensor/actuator streaming

- **Status:** DONE — Claude; baseline b28c8c2; 2026-10-16 (fake-clock streaming verified; drone firmware for Simulation-on-Hardware is the version 2 proposal TASK-051).
- **Phase 1 disposition:** Preserved: the Web Serial and HIL code stays; HITL, Simulation-on-Hardware and writes to a real controller are outside Phase 1 (scope section 2).
- **Title & Description:** Send HIL_SENSOR/HIL_GPS and receive HIL_ACTUATOR_CONTROLS on real-time clocks.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-037, TASK-048.
- **Touched Files:** `packages/autopilot/src/hitl.ts`, `packages/autopilot/src/hil-clock.ts`, `tests/hil-stream.test.ts`, `packages/autopilot/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** IMU 200/400 Hz; GNSS 5/10 Hz; actuator mapping/signing/time.
- **DoD & Acceptance Criteria:** A 60 s fake real-time clock gives exact counts/bytes/timestamps; dropout/queue overflow fault; fields_updated matches observations; baud/10 serial budget retains at least 30% headroom.
- **Evidence:** Owner Claude; baseline b28c8c2; 2026-10-16. `tests/hil-stream.test.ts` (17 PASS) verifies twelve 60 s `hitl-realtime` schedules across `400/800/1200` Hz physics x `200/400` Hz IMU x `5/10` Hz GNSS (`100` Hz mag, `50` Hz baro), exact `fields_updated` bitmasks, `460800` baud headroom (`67.9%` at `31,310` B/s; `115200`/`230400` rejected), queue overflow latching, and 100 ms actuator dropout fault. Recorded Simulation-on-Hardware is not part of this software streamer. Drone firmware for that path is the version 2 proposal `TASK-051`.

### TASK-050 — HITL firmware capability gate

- **Status:** DONE — Claude; baseline 0006e07; 2026-10-16 (gate implemented; HITL availability BLOCKED_EXTERNAL: no verified board profile).
- **Phase 1 disposition:** Preserved: the Web Serial and HIL code stays; HITL, Simulation-on-Hardware and writes to a real controller are outside Phase 1 (scope section 2).
- **Title & Description:** Verify board/build flags/message support before declaring HITL available.
- **Dependencies:** TASK-039, TASK-049.
- **Touched Files:** `packages/autopilot/src/hitl-capabilities.ts`, `docs/hardware/hitl-matrix.md`, `tests/hitl-capabilities.test.ts`, `docs/ru/hitl-matrix.md`, `docs/documentation-index.json`, `packages/autopilot/src/state-machine.ts`, `packages/autopilot/package.json`, `tests/autopilot-state.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Board/firmware SHA/HIL mode/MAVLink capability matrix.
- **DoD & Acceptance Criteria:** Unsupported HIL sensor/actuator paths cannot become READY; record a verified profile or exact BLOCKED_EXTERNAL requirement; SITL availability does not prove HITL support.
- **Evidence:** Owner Claude; baseline 0006e07; 2026-10-16. `tests/hitl-capabilities.test.ts` (6 PASS) and [hitl-matrix.md](hardware/hitl-matrix.md) verify source-audited capability rules: pinned ArduPilot `8ab6afde...` lacks `HIL_SENSOR`/`HIL_ACTUATOR_CONTROLS` handlers (`UNSUPPORTED`), PX4 `4d7e4de7...` is outside the version 2 ArduPilot proposal `TASK-051`. `TASK-051` is deferred and is not a version 1 gate. A local Matek H743-WING running `ArduCopter V4.5.7 (c1269922)` on `COM7` (`test-results/hardware/serial-com7-matek.json`) was also probed and confirmed passive telemetry only.

### TASK-051 — ArduPilot drone firmware for Hybrid SITL and Simulation-on-Hardware

- **Status:** DEFERRED — Cursor; baseline 843994e; 2026-10-20. Moved out of version 1 into the version 2 proposal in [V2_PLAN.md](V2_PLAN.md). Version 1 acceptance does not wait on this task.
- **Phase 1 disposition:** Deferred: HITL, Simulation-on-Hardware and writes to a real controller are outside Phase 1 (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Later, produce an ArduPilot 4.6.3 or newer firmware image that can be loaded on the drone and tested there, using Hybrid SITL and Simulation-on-Hardware. PX4 is out of scope.
- **Dependencies:** TASK-041, TASK-043, TASK-049, TASK-050.
- **Touched Files:** `docs/V2_PLAN.md`, `docs/ru/V2_PLAN.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/hardware/hitl-test-procedure.md`, `docs/ru/hitl-test-procedure.md`.
- **Interfaces / Contracts:** Version 2 firmware build. Hybrid SITL uses the JSON physics backend. Simulation-on-Hardware uses `env SIM_ENABLED 1`. The image is flashed to the drone for the on-vehicle test.
- **DoD & Acceptance Criteria:** Version 1 has no pass condition for this task. Version 2 is done only when that firmware image exists, loads on the drone, and the on-vehicle Hybrid SITL and Simulation-on-Hardware checks in the version 2 plan pass. The existing virtual JSON run does not satisfy the version 2 check.
- **Evidence:** Owner Cursor; baseline 843994e; 2026-10-20. The virtual no-drone JSON lockstep remains a prototype only (`node --experimental-strip-types scripts/run-virtual-hitl.mjs`, 24000 frames, p99 0.0118 ms). No drone firmware image was produced.

## Phase 4: EW & Sensor Faults

### TASK-052 — Hazard volumes

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Compute bounded exposure for spheres, cones, and combinations.
- **Dependencies:** TASK-010, TASK-032.
- **Touched Files:** `packages/ew/package.json`, `packages/ew/src/volumes.ts`, `tests/ew-volumes.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `package-lock.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES section 5; r_min, relative power, angular taper.
- **DoD & Acceptance Criteria:** Test center/boundaries/cone axis/summation order; r=0 remains finite; outside exposure is zero; capacity<=64 and no per-step allocation.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/ew-volumes.test.ts` (2 PASS) and G1 probes (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC) verify inverse-square exposure, `r = 0` clamping, sphere/cone boundaries, canonical ID summation order, and `<=64` volume capacity.

### TASK-053 — GNSS jamming

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Implement training severity-to-satellite/DOP/fix behavior with hysteresis.
- **Dependencies:** TASK-035, TASK-052.
- **Touched Files:** `packages/ew/src/gnss-jamming.ts`, `tests/gnss-jamming.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `packages/mavlink/src/samples.ts`, `scripts/bench-links-ew.mjs`, `tests/sensor-samples.ts`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** GpsSample; filtered q; Njam 0..3 and DOPjam 50..99.
- **DoD & Acceptance Criteria:** q=0 preserves the baseline; strong jamming removes fix; recovery thresholds are correct; no NaN/sentinel overflow; IMU/truth stay unchanged.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/gnss-jamming.test.ts` (3 PASS) and G1 probes (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC) verify exponential severity filtering, `q = 0` identity, `0.8`/`0.6` fix-loss/recovery hysteresis, satellite/DOP clamping, and immutable source GPS/truth.

### TASK-054 — Position-step spoofing

- **Status:** DONE — Claude; baseline 91579b7; 2026-10-16.
- **Title & Description:** Apply GPS displacement atomically at a specified tick.
- **Dependencies:** TASK-010, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/position-step.ts`, `tests/position-step.test.ts`, `packages/ew/package.json`, `packages/sensors/src/geodesy.ts`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** offsetNedM; immutable source; WGS84 conversion before wire encoding.
- **DoD & Acceptance Criteria:** Position changes by the offset within geodesy tolerance; preserve baseline velocity; test zero/disable/reset, altitude Down sign, and antimeridian behavior.
- **Evidence:** Owner Claude; baseline 91579b7; 2026-10-16. `tests/position-step.test.ts` (5 PASS) verifies atomic 3-axis NED offset application at the scheduled tick within `1` mm across the antimeridian and poles, `+Down` lowering MSL via geoid conversion, velocity/DOP/fix preservation, and `10 km` envelope bounds without mutating source samples.

### TASK-055 — Coherent drift

- **Status:** DONE — Claude; baseline 263ce7a; 2026-10-16.
- **Title & Description:** Integrate position/velocity bias on the physics clock with a speed cap and recovery policy.
- **Dependencies:** TASK-011, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/velocity-drift.ts`, `tests/velocity-drift.test.ts`, `packages/ew/package.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** b/v/a equations in section 5; hold-offset versus step-to-truth.
- **DoD & Acceptance Criteria:** Constant-acceleration analytic fixtures pass; piecewise speed limiting preserves position/velocity consistency; GPS/render rates do not change state; no promise of bypassing EKF gates.
- **Evidence:** Owner Claude; baseline 263ce7a; 2026-10-16. `tests/velocity-drift.test.ts` (12 PASS) verifies closed-form constant-acceleration kinematics and intra-step speed-cap clamping at 400/800/1200 Hz within `1e-8` m and `1e-10` m/s, `hold-offset` deceleration stopping distance vs `step-to-truth` reset, and bit-identical state across 5/10 Hz GPS and render reads.

### TASK-056 — Magnetic anomalies

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Distort magnetic vectors in the correct sensor/body frame.
- **Dependencies:** TASK-034, TASK-052.
- **Touched Files:** `packages/ew/src/magnetic.ts`, `tests/magnetic-anomaly.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** Rz*Ry*Rx plus biasBodyGauss; truth quaternion is unchanged.
- **DoD & Acceptance Criteria:** Zero anomaly is identity; synthetic 90-degree rotations preserve norm; test bias units; truth/gyro stay unchanged; reject source/target aliasing.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/magnetic-anomaly.test.ts` (1 PASS) and G1 probes (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC) verify zero-anomaly identity, 90-degree `Rz*Ry*Rx` norm preservation, body-frame gauss bias, aliasing rejection, and untouched truth/gyro.

### TASK-057 — Motor faults

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Inject failures by stable motor ID without modifying the GPS truth path.
- **Dependencies:** TASK-010, TASK-025, TASK-027.
- **Touched Files:** `packages/physics/src/motor-fault.ts`, `tests/motor-fault.test.ts`, `native/bet/tests/motor_failure.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `packages/physics/package.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** power-cut versus synthetic instant-thrust-loss; remainingThrustFraction.
- **DoD & Acceptance Criteria:** Power-cut preserves passive drag/spool decay; instant fault removes the selected force in that tick and sets synthetic validity; leave other motors unchanged; verify moment arms.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/motor-fault.test.ts` (2 PASS), `native/bet/tests/motor_failure.rs` (1 PASS), and G1 probes (`test-results/bench/links-ew-all-400.json`..`1200.json`: 0 GC) verify stable motor ID selection, passive spool decay under `power-cut`, immediate force scaling and `ModelOutsideValidity` bit 5 under `instant-thrust-loss`, and lever-arm moments.

### TASK-058 — EW pipeline composition

- **Status:** DONE — Claude; baseline c57bc60; 2026-10-16.
- **Title & Description:** Compose effects, fault registry, and deterministic command application.
- **Dependencies:** TASK-053, TASK-054, TASK-055, TASK-056, TASK-057.
- **Touched Files:** `packages/ew/src/engine.ts`, `packages/sensors/src/pipeline.ts`, `tests/ew-pipeline.test.ts`, `packages/ew/src/gnss-jamming.ts`, `packages/ew/src/magnetic.ts`, `packages/ew/src/position-step.ts`, `packages/ew/src/velocity-drift.ts`, `packages/ew/package.json`, `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `packages/sensors/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** EwEngine; GpsSample/ImuSample; ew_flags; effect precedence.
- **DoD & Acceptance Criteria:** Order is baseline to step/drift to jamming to quantization; magnetometer is independent; faults/reset compose consistently; truth stays bit-identical; identical seed/event log yields identical packets.
- **Evidence:** Owner Claude; baseline c57bc60; 2026-10-16. `tests/ew-pipeline.test.ts` (6 PASS) verifies `baseline -> step/drift -> jamming -> quantization` GPS precedence, independent magnetometer distortion, 16-slot fault registry and `MotorFaults` forwarding, bit-identical truth arrays, deterministic `HIL_GPS` bytes for identical seed/command logs, and 1e6-step zero-GC execution with all five effects active.

### TASK-059 — EKF scenario regressions

- **Status:** DONE — Codex; baseline 0a31f44; 2026-10-19. Six real native calibration flights and six independent validation flights pass frozen firmware/parameter/model/source-specific limits. Raw RX/TX, actual EKF/mode responses, and PWM/Rust-WASM physics replay verified. Scope is the synthetic native quad; browser, recorded Simulation-on-Hardware, and measured aircraft fidelity remain separate. Since TASK-125 and TASK-126 (2026-10-27) changed `packages/ew/src/engine.ts`, `magnetic.ts`, `position-step.ts` and `velocity-drift.ts`, these reports are a historical snapshot of the previous source closure: a new native EW capture fails the frozen source-closure check until the matrix is recalibrated and revalidated on Linux/WSL native SITL.
- **Phase 1 disposition:** Its DONE evidence is a historical snapshot of the previous EW sources; TASK-171 refreshes it on macOS (S09).
- **Title & Description:** Measure ArduPilot responses to EW/mechanical faults without promising a hard-coded mode.
- **Dependencies:** TASK-042, TASK-043, TASK-058.
- **Touched Files:** `tests/integration/ew-sitl.test.ts`, `tests/fixtures/scenarios/ew-matrix.json`, `scripts/report-ekf.mjs`, `scripts/run-ew-sitl.mjs`, `scripts/freeze-ew.mjs`, `scripts/sitl/audit-ew.mjs`, `scripts/sitl/ew-observations.ts`, `scripts/sitl/check-ew.py`, `scripts/sitl/driver.mjs`, `scripts/sitl/telemetry.py`, `scripts/sitl/quad.mjs`, `tests/sitl-ew.test.ts`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Innovation/status/mode/trajectory AAR trace; pinned EKF parameters.
- **DoD & Acceptance Criteria:** Run a no-fault control and every fault; traces show changed observations and actual EKF responses; freeze version-specific envelopes; unexplained responses require investigation rather than silent PASS.
- **Evidence:** Owner Codex; baseline 0a31f44; 2026-10-19. `test-results/validation/task-059-native.json` PASS across 6 calibration and 6 validation flights (710,636 replayed physics frames, 20,612 response rows) against frozen `tests/fixtures/scenarios/ew-matrix.json` (SHA-256 `c8bd27d9be4e22a5b10279cc925589e7299edeadb667cd478638d0f533494b3a`): jamming and drift trigger `Guided -> Land`, position step triggers GPS-glitch flags, magnetic bias raises compass innovations/selection activity, and single-rotor thrust loss causes tumble/contact within 3 s, while the no-fault control completes healthy hold and landing (`test-results/validation/task-059-flight-regression.json`, `test-results/validation/task-059-tests.json`). Six rejection probes (`tests/sitl-ew.test.ts`, `tests/integration/ew-sitl.test.ts`) pass.

### TASK-125 — EW fault ID re-targeting releases the previous effect

- **Status:** DONE — Claude; baseline 001f06f; 2026-10-27. Found while verifying TASK-124: enabling a faultId that already owned another effect kind, or moving a motor-loss faultId to another motor, returned `applied` but left the previous effect active with no registry owner, so no disable could end it before `sim.reset` (for example `EwFlagV2.GnssJamming` stayed set after jamming, then magnetic, then disabling both). A refused re-target also freed the faultId before the kernel refused the new effect, orphaning the old one. The instructor console keeps one fault ID while its effect select changes, so its default flow hit this. Per the user's decisions the faultId moves and its previous effect is released with the new command's `recovery`, and `packages/ew/src/engine.ts` changes although TASK-059 hashes it.
- **Title & Description:** Release the effect a faultId owned when an enable command moves it to another effect or motor, and keep a refused re-target from changing the registry.
- **Dependencies:** TASK-058, TASK-124.
- **Touched Files:** `packages/ew/src/engine.ts`, `tests/ew-pipeline.test.ts`, `tests/session-v2.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** `EwEngine.apply(command, tick): ApplyResult` keeps its signature and results. A faultId owns at most one effect (its kind, plus the motor for motor-loss). Enabling a faultId that owns another effect engages the new effect first, then releases the old one with the new command's `recovery` (only velocity-drift distinguishes `hold-offset` from `step-to-truth`) and reuses or frees its slot; a newer faultId still replaces the owner of the target effect, and re-enabling the same effect still updates its parameters in place. A command whose effect cannot engage returns `rejected` with the registry and every effect unchanged. Control Protocol v2, `SessionFaultPort`, wire messages and ABI v2 are unchanged. `engine.ts` is in the TASK-059 frozen source closure, so the TASK-059 native reports become a historical snapshot.
- **DoD & Acceptance Criteria:** After a faultId moves between effects or motors, disabling its current effect leaves none of its earlier effects active; moving a motor-loss faultId restores the previous motor at once; a faultId moving onto an effect another faultId owns replaces that owner and frees its own old slot; a re-targeted drift ends with the new command's recovery, not the recovery it was enabled with; a refused re-target leaves the faultId's effect and the target effect's owner untouched; the session takes the instructor console's one-fault-ID flow to no active fault with every command applied; the new tests fail before the fix and pass after it; `apply` gains no allocation; English and Russian contracts change together.
- **Evidence:** Owner Claude; baseline 001f06f (TASK-124); 2026-10-27; Node 24.22.1 on macOS 26.6 arm64. Repro probes before the fix (`node --experimental-transform-types`, fresh `EwEngine`): jamming, then magnetic, then disabling `x` as both returned `applied` four times while `EwFlagV2.GnssJamming` stayed set after 4000 steps; a motor-loss faultId moved from motor 0 to motor 1 and disabled as both left motor 0 cut and `MotorFault` set; a re-target to a 20 km position step, refused by `PositionStep.schedule`, returned `rejected` but orphaned the magnetic anomaly its faultId owned. With the tests added and the engine unchanged, `npx --no-install vitest run tests/ew-pipeline.test.ts tests/session-v2.test.ts` exited 1 with 3 failed / 25 passed: both new `tests/ew-pipeline.test.ts` cases and the new session case, whose `ewFlags` read 10 (PositionStep plus MagneticAnomaly) instead of 8. After the fix the same command passes 28/28; together with `tests/control-v2.test.ts`, `tests/ew-volumes.test.ts`, `tests/gnss-jamming.test.ts`, `tests/magnetic-anomaly.test.ts`, `tests/position-step.test.ts`, `tests/scenario-runner.test.ts`, `tests/velocity-drift.test.ts` and `tests/integration/ew-sitl.test.ts`, 138/138 pass in 10 files. `npm run typecheck` exits 0; ESLint (`--max-warnings=0 --no-inline-config`) on the three touched code and test files exits 0; `npm run check:docs` exits 0 (20 pairs, 125 tasks); `git diff --check` is clean. G1 (scratch probe, not committed): in 1e6-call windows, one faultId re-targeted through jamming, magnetic, motor 0, motor 1 and a position step with integer-valued parameters ran with 0 GC in 5 of 6 windows (one burst of 2–3 GC, always in the second window, with and without `--single-threaded`); the same effects enabled and disabled under separate faultIds ran with 0 GC in all 6; an allocating control triggered 17 GC. English and Russian `SPECS_SIMULATION_ENGINES.md` and this roadmap changed together. Remaining: TASK-059 must be recalibrated and revalidated on Linux/WSL native SITL before a new native EW capture can pass the frozen source-closure check (BLOCKED_EXTERNAL here: the native SITL harness requires Linux/WSL, and this host is macOS). Pre-existing and outside this change: enabling a magnetic anomaly with a non-integer rotation triggers 3–4 GC per 1e6-call window even without re-targeting (float arguments on the way to `MagneticAnomaly.configure`); TASK-126 removes it.

### TASK-126 — Allocation-free EW fault application

- **Status:** DONE — Claude; baseline 5c23e91; 2026-10-27. A G1 probe made during TASK-125 found that `EwEngine.apply`, which runs at the tick boundary and must not allocate, boxed doubles on several paths: a magnetic enable passed six floats, destructured from the command, to `MagneticAnomaly.configure`; a position step passed its offset and the tick to `schedule`/`advanceTick`; drift destructured a non-integer acceleration; motor-loss passed its remaining thrust fraction to `MotorFaults.set`; and every enable passed the tick to `engage`, which V8 keeps as a small integer only below 2^30 under pointer compression (2^31 without). The drift preset object literal and its max-speed field did not allocate. The user asked for the magnetic path and a check of the drift preset; the same probe found the other paths, so all of them are fixed before TASK-059 is recalibrated, which TASK-125 already requires.
- **Title & Description:** Pass fault-command floats to the EW kernels through arrays, so applying any admitted `fault.set` allocates nothing.
- **Dependencies:** TASK-054, TASK-055, TASK-056, TASK-057, TASK-058, TASK-125.
- **Touched Files:** `packages/ew/src/engine.ts`, `packages/ew/src/magnetic.ts`, `packages/ew/src/position-step.ts`, `packages/ew/src/velocity-drift.ts`, `packages/physics/src/motor-fault.ts`, `tests/ew-pipeline.test.ts`, `tests/magnetic-anomaly.test.ts`, `tests/position-step.test.ts`, `tests/motor-fault.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** New allocation-free kernel inputs: `MagneticAnomaly.configureFrom(rotationRad, biasBodyGauss)`, `PositionStep.scheduleFrom(offsetNedM, atTick: Float64Array)` and `advanceTickFrom(tick: Float64Array)`, and `MotorFaults.setFromArray(id, mode, remainingSource: Float64Array)`. `configure`, `schedule`, `advanceTick` and `set` keep their signatures and results and delegate to them. An empty tick or fraction array is rejected, and `advanceTickFrom` with an empty array changes nothing. `EwEngine.apply` keeps its signature and results and reuses one engine-owned drift preset; `VelocityDrift.enable` reads acceleration elements by index. Control Protocol v2, `SessionFaultPort` and ABI v2 are unchanged. `engine.ts`, `magnetic.ts`, `position-step.ts` and `velocity-drift.ts` are in the TASK-059 frozen source closure; `motor-fault.ts` is not.
- **DoD & Acceptance Criteria:** Applying 1e6 fault commands that cover every effect with non-integer parameters, re-targeting and ticks past 2^32 gives a GC-free window, while an allocating control in the same test triggers GC; that test fails before the fix; each array-input method matches an independently constructed kernel or its scalar form and rejects a missing input; existing EW, session and motor-fault tests pass unchanged; English and Russian contracts change together.
- **Evidence:** Owner Claude; baseline 5c23e91; 2026-10-27; Node 24.22.1 on macOS 26.6 arm64. Scratch probe before the fix (not committed; 1e6 `apply` calls per window, alternating enable and disable under one faultId; GC per window): magnetic with non-integer rotation and bias 22–23; drift with acceleration [0.1, 0.2, 0] 7–8, while integer acceleration with max speed 3.5 gave 0; position step [30.5, -12.25, 1.5] 5–6; motor-loss with remaining fraction 0.25 1–2; enables at tick 2^32 + i: position step 22, jamming 1–2; integer-valued parameters and jamming severity 0.4 gave 0. A separate probe showed that storing large or non-integer doubles into existing object fields does not allocate. With the test added and the code unchanged, `npx --no-install vitest run tests/ew-pipeline.test.ts -t "every effect without triggering GC"` exited 1 with [5, 5, 5] GC per window. After the fix all twelve probe variants ran at 0 GC in every window, and the G1 test passed five consecutive runs. `tests/control-v2.test.ts`, `tests/ew-pipeline.test.ts`, `tests/ew-volumes.test.ts`, `tests/gnss-jamming.test.ts`, `tests/magnetic-anomaly.test.ts`, `tests/position-step.test.ts`, `tests/scenario-runner.test.ts`, `tests/session-v2.test.ts`, `tests/velocity-drift.test.ts`, `tests/motor-fault.test.ts` and `tests/integration/ew-sitl.test.ts` pass 144/144 in 11 files, including three direct tests of the array-input methods, written with the fix because the methods are new. `npm run typecheck` exits 0; ESLint (`--max-warnings=0 --no-inline-config`) on every touched code and test file exits 0; `npm run check:docs` exits 0 (20 pairs, 126 tasks); `git diff --check` is clean. English and Russian `SPECS_SIMULATION_ENGINES.md` and this roadmap changed together. Remaining: the TASK-059 recalibration and revalidation on Linux/WSL native SITL that TASK-125 left open now also covers `magnetic.ts`, `position-step.ts` and `velocity-drift.ts` (BLOCKED_EXTERNAL here: the native SITL harness requires Linux/WSL, and this host is macOS).

## Phase 5: Environment & Shaders

### TASK-060 — Provider and license policy

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Separate Google live tiles from cacheable owned/licensed datasets before implementing caches.
- **Dependencies:** TASK-003, TASK-005.
- **Touched Files:** `packages/terrain/package.json`, `packages/terrain/src/provider-policy.ts`, `docs/decisions/terrain-licensing.md`, `tests/terrain-policy.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/ru/terrain-licensing.md`, `docs/documentation-index.json`, `package-lock.json`.
- **Interfaces / Contracts:** ProviderPolicy {attribution, allowedCache, ttl, offline, datasetLicense}.
- **DoD & Acceptance Criteria:** Google persistent R2/prefetch is denied by default; authorization requires evidence; unknown policy fails closed; fixtures need no API key; paid API access does not establish an offline license.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/terrain-policy.test.ts` and [terrain-licensing.md](decisions/terrain-licensing.md) verify fail-closed provider validation, default denial of Google persistent caching/prefetch/offline storage (`ttl = 0`), and required attribution/license/permission-hash checks for cacheable licensed datasets.

### TASK-061 — Tiles streaming adapter

- **Status:** DONE — Claude; baseline 89b46f1; 2026-10-16 (local fixture verified; live Google tiles BLOCKED_EXTERNAL on deployed proxy and credentials).
- **Title & Description:** Connect one chosen 3D Tiles loader to R3F using a local licensed fixture.
- **Dependencies:** TASK-015, TASK-036, TASK-060.
- **Touched Files:** `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `apps/web/src/FlightScene.tsx`, `tests/tiles-provider.test.ts`, `tests/browser/terrain.spec.ts`, `packages/terrain/package.json`, `apps/web/src/App.tsx`, `apps/web/src/terrain-config.ts`, `apps/web/src/style.css`, `apps/web/package.json`, `package-lock.json`, `tests/support/terrain-harness.ts`, `tests/fixtures/tiles/generate.py`, `tests/fixtures/tiles/tileset.json`, `tests/fixtures/tiles/tile.glb`, `tests/fixtures/registry.json`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** 3D Tiles transforms; ECEF/local origin; attribution; abort/dispose.
- **DoD & Acceptance Criteria:** Load/place the fixture; canceled requests release resources; show CORS/COEP failures; missing Google credentials block live integration while local checks continue.
- **Evidence:** Owner Claude; baseline 89b46f1; 2026-10-16. `tests/tiles-provider.test.ts` (7 PASS) and `tests/browser/terrain.spec.ts` (2 PASS in Chromium) verify `3d-tiles-renderer` 0.5.3 loading of the CC0 3D Tiles 1.1 fixture (`tests/fixtures/tiles/tileset.json`, `tile.glb`), ENU-to-ECEF placement within `1` cm, request abort and geometry/material disposal, and CORS/network error classification. Live Google 3D Tiles remain `BLOCKED_EXTERNAL` without a deployed proxy and API key.

### TASK-062 — LOD and GPU budgets

- **Status:** DONE — Claude; baseline ea69c6a; 2026-10-16 (synthetic budgets verified; real-GPU residency and target-device frame time remain TASK-073).
- **Title & Description:** Bound terrain network, decoding, and GPU workloads.
- **Dependencies:** TASK-061.
- **Touched Files:** `packages/terrain/src/lod-budget.ts`, `packages/terrain/src/resource-cache.ts`, `tests/terrain-budget.test.ts`, `packages/terrain/src/tiles-scene.ts`, `packages/terrain/package.json`, `tests/support/terrain-harness.ts`, `tests/browser/terrain.spec.ts`.
- **Interfaces / Contracts:** Bounded request queue; CPU/GPU byte accounting; SSE limits.
- **DoD & Acceptance Criteria:** Synthetic flythrough respects <=2 GiB estimated terrain GPU residency and <=512 MiB decoded CPU cache; eviction disposes resources; idle queues do not grow; degradation is deterministic.
- **Evidence:** Owner Claude; baseline ea69c6a; 2026-10-16. `tests/terrain-budget.test.ts` (12 PASS) and `tests/browser/terrain.spec.ts` verify `<=2` GiB GPU and `<=512` MiB CPU cache caps across a 600-frame seeded flythrough, deterministic SSE coarsening/recovery, LRU eviction with single `dispose()`, and `<=256` request queue bounds. Target-GPU residency and 10-minute frame-time profiling remain `TASK-073`.

### TASK-063 — Cloudflare tiles proxy

- **Status:** DONE — Claude; baseline e9ad0f3; 2026-10-16 (local Worker tests; deployment and live provider credentials need separate authorization).
- **Phase 1 disposition:** Frozen: the Google tiles proxy and the R2 cache need keys, a deployment and new-provider approval (S17, scope section 2).
- **Title & Description:** Build an authenticated proxy with quotas, attribution/CORS, and permitted TTLs.
- **Dependencies:** TASK-060, TASK-061.
- **Touched Files:** `services/tiles-worker/package.json`, `services/tiles-worker/wrangler.jsonc`, `services/tiles-worker/src/index.ts`, `services/tiles-worker/src/policy.ts`, `tests/tiles-proxy.test.ts`, `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `tsconfig.json`.
- **Interfaces / Contracts:** ProviderPolicy; opaque upstream secret binding; origin/session verification.
- **DoD & Acceptance Criteria:** Local Worker tests verify no key reaches clients/logs, invalid origin/session/quota rejection, and provider restrictions; deployment needs separate authorization and is not implied by local success.
- **Evidence:** Owner Claude; baseline e9ad0f3; 2026-10-16. `tests/tiles-proxy.test.ts` (10 PASS) verifies fail-closed configuration, Origin/HMAC-session validation, upstream API key injection and error-body key redaction, `Cache-Control: no-store` (`TTL 0`), and per-session/per-IP quotas. External Cloudflare deployment and live Google credentials remain separate.

### TASK-064 — R2 for permitted datasets

- **Status:** DONE — Claude; baseline f35efe6; 2026-10-16 (emulator tests; R2 binding and persistent caching need explicit permission).
- **Phase 1 disposition:** Frozen: the Google tiles proxy and the R2 cache need keys, a deployment and new-provider approval (S17, scope section 2).
- **Title & Description:** Cache 10–15 km regions only for content whose license permits it.
- **Dependencies:** TASK-062, TASK-063.
- **Touched Files:** `services/tiles-worker/src/r2-cache.ts`, `packages/terrain/src/region-manifest.ts`, `tests/r2-cache.test.ts`, `tests/support/memory-r2.ts`, `packages/terrain/package.json`.
- **Interfaces / Contracts:** Dataset hash/license; cache key/version/TTL; region manifest; deny Google unless explicitly authorized by a lawful policy.
- **DoD & Acceptance Criteria:** Local R2 emulator tests hit/miss/expiry/eviction; enforce byte/quota caps and 10/15 km radius; cacheable=false never writes; missing rights/data explicitly block the provider.
- **Evidence:** Owner Claude; baseline f35efe6; 2026-10-16. `tests/r2-cache.test.ts` (8 PASS on `tests/support/memory-r2.ts`) verifies `10–15` km WGS84 radius filtering, dataset SHA-256 and license validation, unconditional Google persistent cache denial, TTL expiry, and oldest-first byte-cap eviction. Live R2 bucket binding and licensed dataset registration remain external.

### TASK-065 — Collision terrain LOD

- **Status:** DONE — Claude; baseline 6f0b249; 2026-10-18. Collision chunks drive the TASK-029 Rapier contact through contact ABI v2 per-tick planes; missing ground pauses stepping. Flight-session wiring and live terrain admission remain separate.
- **Title & Description:** Build collision chunks independently of visuals and swap them at tick boundaries.
- **Dependencies:** TASK-029, TASK-061, TASK-062.
- **Touched Files:** `packages/terrain/src/collision-builder.worker.ts`, `packages/terrain/src/collision-chunks.ts`, `tests/terrain-collision.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `packages/terrain/package.json`, `packages/terrain/src/collision-build.ts`, `scripts/bench-terrain-scenarios.mjs`, `tests/browser/terrain-collision.spec.ts`, `native/contact/src/contact.rs`, `native/contact/src/lib.rs`, `native/contact/tests/contact.rs`, `packages/physics/src/ground-contact.ts`, `packages/physics/src/terrain-contact.ts`, `scripts/build-contact.mjs`, `tests/terrain-contact.test.ts`, `tests/contact-support.ts`, `tests/contact-binding.test.ts`, `scripts/bench-terrain-scenarios.mjs`.
- **Interfaces / Contracts:** Immutable versioned collision chunks; local origin; readiness around the vehicle.
- **DoD & Acceptance Criteria:** Visual eviction retains active ground; seam/drop tests pass; incomplete ground explicitly limits/pauses flight; heavy decoding never runs in the physics Worker.
- **Evidence:** Owner Codex/Claude; baseline 6f0b249; 2026-10-18. `node scripts/build-contact.mjs --native --test-native` (4 PASS), `tests/terrain-collision.test.ts` (5 PASS), `tests/terrain-contact.test.ts` (4 PASS), and `tests/browser/terrain-collision.spec.ts` verify off-thread chunk construction, 64 MiB active+pending byte cap, tick-boundary swapping, contact ABI v2 per-tick ground planes across chunk seams within `1e-6` with 0 WASM allocations, and stepping pause when ground is missing. `node scripts/bench-terrain-scenarios.mjs 400|800|1200` (`test-results/bench/terrain-scenarios-400.json`..`1200.json`) passes 6 measured windows at each rate with 0 GC. Flight-session wiring, live tile decoding, and contact-patch curvature remain open.

### TASK-066 — WebGPU renderer capability

- **Status:** DONE — Claude/Codex; baseline 60ba4cf; verified 2026-10-17. WebGL2/WebGPU renderer adapter, shader/device fallbacks, and resource disposal verified in software Chromium (5 PASS, 1 WebGPU skip) and on native RTX 4050 GPU (6/6 PASS, 0 skips).
- **Title & Description:** Add a renderer adapter with WebGL2 fallback and resource lifecycle.
- **Dependencies:** TASK-005, TASK-061.
- **Touched Files:** `apps/web/src/render/renderer.ts`, `apps/web/src/render/webgpu.ts`, `tests/browser/render-backends.spec.ts`, `apps/web/src/FlightScene.tsx`, `tests/support/render-harness.ts`.
- **Interfaces / Contracts:** Common scene/material capabilities; browser chooses Metal/DX backend.
- **DoD & Acceptance Criteria:** Available modes run; unsupported modes are skipped with a reason, not passed; shader failures fall back; switching releases all resources.
- **Evidence:** Owner Claude/Codex; verified 2026-10-17. `tests/browser/render-backends.spec.ts` verifies WebGL2 and WebGPU rendering, broken-shader magenta fallback, WebGPU-to-WebGL2 fallback with exact diagnostic reason, and complete geometry/material/texture/context disposal on renderer switch (`test-results/laptop/browser-render-gpu.xml`: 6/6 PASS with 0 skips on Windows 11 RTX 4050 Laptop GPU; headless SwiftShader runs 5 PASS and explicitly skips native WebGPU presentation when its software device is lost).

### TASK-067 — FPV camera and fisheye

- **Status:** DONE — Claude; baseline 778ee75; 2026-10-16 (WebGL2 verified; WebGPU fisheye not implemented: the pass is a WebGL ShaderMaterial).
- **Title & Description:** Separate mounted FPV pose/projection and lens distortion from the external camera.
- **Dependencies:** TASK-015, TASK-066.
- **Touched Files:** `packages/cameras/package.json`, `packages/cameras/src/fpv-camera.ts`, `packages/cameras/src/shaders/fisheye.glsl`, `tests/fisheye.test.ts`, `tests/browser/fpv.spec.ts`, `packages/cameras/src/fisheye.ts`, `packages/cameras/src/fisheye-material.ts`, `tests/support/fpv-harness.ts`, `package-lock.json`.
- **Interfaces / Contracts:** CameraConfig {fov, mount FRD, distortion}; immutable truth.
- **DoD & Acceptance Criteria:** Zero distortion is identity; optical-center/radial fixtures and analytic projection/resize tests pass; edge coordinates stay finite; no truth mutation.
- **Evidence:** Owner Claude; baseline 778ee75; 2026-10-16. `tests/fisheye.test.ts` (11 PASS) and `tests/browser/fpv.spec.ts` (3 PASS in Chromium WebGL2) verify FRD mount pose composition, equidistant/polynomial distortion ray inversion within `1e-9`, principal-point offset, viewport resize, immutable truth, and pixel-by-pixel agreement between `fisheye.glsl` and the CPU oracle (`0/6912` mismatched pixels).

### TASK-068 — Analog interference and jelly

- **Status:** DONE — Claude; baseline 7478d6f; 2026-10-16 (WebGL2 verified; tolerances backend-specific; WebGPU variant not implemented).
- **Phase 1 disposition:** Frozen: analog video effects and the thermal camera are backlog (scope section 2). TASK-185 reuses the TASK-067 camera pose without effects.
- **Title & Description:** Add seeded video noise, scanlines, and rolling-shutter deformation.
- **Dependencies:** TASK-067.
- **Touched Files:** `packages/cameras/src/analog.ts`, `packages/cameras/src/shaders/analog.glsl`, `tests/analog-noise.test.ts`, `tests/browser/analog.spec.ts`, `packages/cameras/src/analog-material.ts`, `packages/cameras/package.json`, `tests/support/analog-harness.ts`.
- **Interfaces / Contracts:** VideoNoiseConfig; throttle-decimated uniforms; independent visual RNG.
- **DoD & Acceptance Criteria:** Equal seed/time gives the same frame; throttle affects rendering only; no CPU pixel loops/per-frame allocation; image tolerances are backend-specific, not cross-GPU pixel equality.
- **Evidence:** Owner Claude; baseline 7478d6f; 2026-10-16. `tests/analog-noise.test.ts` (7 PASS) and `tests/browser/analog.spec.ts` (5 PASS in Chromium WebGL2) verify render-rate-independent per-video-frame seeds (`lowbias32`), throttle-coupled noise/jelly/scanlines without physics state access, 1e6 zero-GC `updateFrom` calls, and byte-identical WebGL2 frames for equal seed and video frame.

### TASK-069 — WorldCover/OSM material map

- **Status:** DONE — Claude; baseline b774986; 2026-10-17. WorldCover v200 / OSM material map and Israel GeoTIFF window decoder verified; uncovered coordinates are explicitly labeled synthetic.
- **Title & Description:** Load licensed land classes and map features with provenance.
- **Dependencies:** TASK-036, TASK-060, TASK-061.
- **Touched Files:** `packages/thermal/package.json`, `packages/thermal/src/material-map.ts`, `packages/thermal/src/data-manifest.ts`, `tests/material-map.test.ts`, `tests/fixtures/thermal/material-classes.json`, `tests/fixtures/registry.json`, `package-lock.json`, `packages/thermal/src/geotiff.ts`, `tests/worldcover-geotiff.test.ts`, `data/worldcover/2021-v200/israel/inventory.json`, `docs/operations/worldcover-data.md`, `docs/ru/worldcover-data.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** 10 m raster labels; road/roof overlays; attribution/hash/coordinate system.
- **DoD & Acceptance Criteria:** Known coordinates map correctly; missing data is labeled synthetic; land classes are not temperatures; preserve attribution/licenses without unauthorized bulk downloads.
- **Evidence:** Owner Claude; baseline b774986; 2026-10-17. `tests/material-map.test.ts` (9 PASS on `tests/fixtures/thermal/material-classes.json`) and `tests/worldcover-geotiff.test.ts` (17 PASS on the three committed ESA WorldCover 2021 v200 Israel GeoTIFFs `N27E033`, `N30E033`, `N33E033` in `data/worldcover/2021-v200/israel/inventory.json`, `90,313,215` B; see [worldcover-data.md](operations/worldcover-data.md)) verify license/attribution/SHA-256 checks, building/road/land precedence, 8 known Israel locations, the 30°N tile seam, and `synthetic = true` fallback outside coverage. Application scene wiring and an OSM extract remain open.

### TASK-070 — Surface thermal state

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Synthetic lumped surface model; measured validation remains separate.
- **Phase 1 disposition:** Frozen: analog video effects and the thermal camera are backlog (scope section 2). TASK-185 reuses the TASK-067 camera pose without effects.
- **Title & Description:** Integrate material temperatures from solar forcing/weather outside the shader.
- **Dependencies:** TASK-032, TASK-069.
- **Touched Files:** `packages/thermal/src/heat-balance.ts`, `packages/thermal/src/solar.ts`, `packages/thermal/package.json`, `tests/thermal-energy.test.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** C*dT/dt=absorbedSolar-convection-radiation-conduction; emissivity/inertia.
- **DoD & Acceptance Criteria:** Test night equilibrium/sunrise/shadows/energy units and timestep convergence; AO affects only an explicit radiative model, not a substitute heat solver; measured validation remains pending without data.
- **Evidence:** Owner Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-energy.test.ts` (15 PASS) verifies `HeatSurface` trapezoidal and `ThermalField` batched allocation-free Heun slab solvers (`<=0.02` K agreement over 6 h), NOAA solar ephemeris vs NREL SPA (`1e-9` direction match), 3600 s night equilibrium, shadows/sky-view radiative coupling, and 600 s timestep convergence (`<0.002` K). Synthetic model; no measured material calibration claimed. Extended 2026-10-22 (owner Claude, TASK-073 P5): big-leaf Penman-Monteith latent flux for surfaces with a surface resistance and the FAO-56 log-profile aerodynamic resistance for canopies; `tests/thermal-energy.test.ts` (19 PASS) adds FAO-56 table oracles (e_s 2.338 and 4.243 kPa at 20 and 30 C, gamma 0.067 kPa/K, grass r_a within 3% of 208/u), an independently written balance with LE, canopy within 4 K of air at midday, 600 s versus 1 s steps within 0.01 K, and the unchanged zero-GC stepping check.

### TASK-071 — Thermal renderer

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Independent synthetic LWIR WebGL2 pipeline; production scene and measured instrument remain open.
- **Phase 1 disposition:** Frozen: analog video effects and the thermal camera are backlog (scope section 2). TASK-185 reuses the TASK-067 camera pose without effects.
- **Title & Description:** Map thermal states to radiance/palettes with atmospheric attenuation.
- **Dependencies:** TASK-066, TASK-070.
- **Touched Files:** `packages/thermal/src/thermal-camera.ts`, `packages/thermal/src/shaders/thermal.glsl`, `tests/thermal-camera.test.ts`, `tests/browser/thermal.spec.ts`, `tests/support/thermal-harness.ts`, `packages/thermal/package.json`, `tests/material-map.test.ts`, `apps/web/src/render/webgpu.ts`, `tests/browser/render-backends.spec.ts`, `tests/support/render-harness.html`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `packages/thermal/src/thermal-material.ts`.
- **Interfaces / Contracts:** InstrumentProfile {resolution, spectralResponse, noise, calibrationSource}; synthetic training profiles are separate from CADEX measurements.
- **DoD & Acceptance Criteria:** Test blackbody monotonicity, emissivity/reflection/distance attenuation, and cold/hot palette endpoints; configurable native resolution; do not claim CADEX parity without profile data.
- **Evidence:** Owner Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-camera.test.ts` (8 PASS) and `tests/browser/thermal.spec.ts` (1 PASS in Chromium WebGL2) verify Simpson band Planck radiance integration (`54–56` W/(m²·sr) at 300 K), emissivity/reflection/Beer-Lambert attenuation, `white-hot`/`black-hot`/`ironbow` palettes, configurable native resolution, and pixel-by-pixel GLSL vs CPU agreement within 1 8-bit level. No CADEX measured profile or production scene wiring claimed.

### TASK-072 — Thermal shutter and NUC

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Deterministic synthetic offset-only shutter calibration.
- **Phase 1 disposition:** Frozen: analog video effects and the thermal camera are backlog (scope section 2). TASK-185 reuses the TASK-067 camera pose without effects.
- **Title & Description:** Implement deterministic calibration cycles and bounded display interruption.
- **Dependencies:** TASK-071.
- **Touched Files:** `packages/thermal/src/nuc.ts`, `packages/thermal/src/thermal-status.ts`, `packages/thermal/package.json`, `tests/thermal-nuc.test.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Shutter states idle/closed/calibrating/open; sensor frame time.
- **DoD & Acceptance Criteria:** Fix cycle duration/rate; NUC removes configured bias without timestamp reversal; shutter never pauses physics or mutates AAR truth.
- **Evidence:** Owner Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-nuc.test.ts` (4 PASS) verifies `idle -> closed -> calibrating -> open` shutter cadence, 17-frame display freeze on a 120 s grid, fixed-pattern offset removal (`0.71 ± 30%` counts residual on 4096 noisy pixels), monotone timestamps, and bit-identical `ThermalField`/physics state across shutter cycles.

### TASK-073 — GPU acceptance harness

- **Status:** BLOCKED_EXTERNAL — Claude; branch `task-073-g3`; 2026-10-24. By user decision of 2026-10-23 the gate is a 1920 x 1080 canvas at 1x on the least performant tested integrated GPU, on both WebGL2 and WebGPU; every other machine, screen and GPU is measured and rated in [DEVICE_RATINGS.md](DEVICE_RATINGS.md) without deciding. Three integrated GPUs have been tested (Apple M4, Intel Graphics in the RTX 4050 laptop, Apple M5). The Intel iGPU's latest gate-eligible captures (2026-10-24, its own 1920 x 1080 panel as the only and therefore primary display) PASS on both WebGL2 and WebGPU (p99 17.310 ms each, rating 100); its earlier captures, all with an external monitor on the NVIDIA GPU as the primary display, FAIL (p99 19.960-42.430 ms), because Chrome on Windows takes its frame clock from the primary display. The M4 and M5 have no gate-eligible run yet, so the gate device is unknown. Earlier status (2026-10-23): BLOCKED_EXTERNAL; the Intel iGPU's gate-eligible WebGL2 and WebGPU captures of 2026-10-23 both FAIL (p99 27.685 / 24.040 ms), as do the same captures on its own 1920 x 1080 panel (p99 42.430 / 41.965 ms). Previous status: FAIL — Claude; branch `task-073-g3`; 2026-10-22. The G3 scene (real terrain, buildings, material drape, Boson 640 thermal, FPV, scripted flight) runs on WebGL2 and WebGPU; 10-minute captures on this laptop meet the 60 FPS median but fail the p99 limit on the RTX 4050 (27.085 ms on both backends) and on the Intel iGPU; with `--disable-direct-composition` the frame-clock p99 passes (16.675/16.685 ms) but the PresentMon displayed-frame gate fails (p99 33.4 ms); the M4 full-display captures remain to be repeated. Earlier status (Cursor; baseline 5be98c4; 2026-10-21): The user accepted the M4 60 FPS timing (median 16.680 ms, p99 17.665 ms) and the 59.88 Hz panel. The operator screenshot shows the scene did not fill the 2560×1440 display. The native panel is 2560×1664 and was not the presented surface. RTX 4050 full-feature 60 FPS captures FAIL the accepted limits (balanced power p99 23.880 ms; maximum-performance power median 16.685 ms and p99 34.260 ms), and WebGPU fisheye/thermal passes remain open; open items are listed in [needed_for_task073.md](needed_for_task073.md).
- **Phase 1 disposition:** Not a Phase 1 gate (item A-11 in [docs/decisions/phase1-acceptance.md](decisions/phase1-acceptance.md)): its gate depends on Windows-measured integrated GPUs and on thermal and FPV views that Phase 1 excludes. Its evidence and harness are preserved; TASK-132 sets the Phase 1 rendering criteria (A-06).
- **Title & Description:** Profile production rendering with terrain/FPV/thermal; the least performant tested integrated GPU at 1920 x 1080 and 1x decides, and every tested machine, screen and GPU is rated.
- **Dependencies:** TASK-014, TASK-062, TASK-065, TASK-066, TASK-068, TASK-072.
- **Touched Files:** `scripts/bench-render.mjs`, `scripts/check-gpu-perf.mjs`, `scripts/gpu-trace.mjs`, `apps/web/src/render/g3-mode.ts`, `apps/web/src/render/g3-passes.ts`, `apps/web/src/FlightScene.tsx`, `apps/web/src/style.css`, `apps/web/vite.config.ts`, `apps/web/package.json`, `docs/benchmarks/render-matrix.json`, `docs/validation/gpu-report.schema.json`, `tests/gpu-report.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `package-lock.json`, `docs/needed_for_task073.md`, `docs/ru/needed_for_task073.md`, `scripts/gpu-ratings.mjs`, `docs/benchmarks/device-results.json`, `docs/DEVICE_RATINGS.md`, `docs/ru/DEVICE_RATINGS.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/capture-samplers.mjs`, `tests/capture-samplers.test.ts`, `scripts/diagnose-pacing.mjs`, `scripts/analyze-pacing.mjs`, `apps/web/src/render/gpu-pass-timer.ts`, `apps/web/src/render/g3-passes-webgpu.ts`, `apps/web/src/render/gpu-pass-timer-webgpu.ts`, `tests/gpu-pass-timer-webgpu.test.ts`, `tests/g3-mode.test.ts`, `scripts/vblank-probe.ps1`, `scripts/analyze-vblank.mjs`.
- **Interfaces / Contracts:** G3 trace schema 2 (`scripts/bench-render.mjs`, including PresentMon `displayedMs` and the measured browser's `chromeArgs`), per-run `gpu-run` verdict (PASS/FAIL for gate-eligible runs, INFO for rated runs, BLOCKED_EXTERNAL) with the 0-100 rating, run records in `docs/benchmarks/device-results.json`, and the G3 `gpu-report` from `node scripts/gpu-ratings.mjs decide`.
- **DoD & Acceptance Criteria:** Gate (user decision of 2026-10-23): on the least performant tested integrated GPU (Apple Silicon, Intel integrated graphics, AMD Radeon Graphics; the lowest mean rating over its gate-eligible runs, ties to the worse p99), a 1920 x 1080 canvas at 1x scale (DPR 1) in the 60 FPS profile on a display above 58 Hz, measured for 10 min after 60 s warmup, passes on both WebGL2 and WebGPU: median <=16.680 ms and p99 <=17.665 ms (rounded to 0.001 ms), terrain residency within 2 GiB GPU and 512 MiB CPU, terrain, FPV and thermal held and the scripted flight airborne for the whole window. Every tested integrated GPU needs gate-eligible runs on both backends before the least performant one is known; until then the verdict is BLOCKED_EXTERNAL. All other machines, screens, GPUs, canvases and the 120 FPS profile (whose p99 <=8.33 ms limit is kept for reference) are measured, rated out of 100 and listed in [DEVICE_RATINGS.md](DEVICE_RATINGS.md), and never decide. Software-headless GPUs, hidden tabs, windows the machine slept through and canvases that change size produce no evidence. By user decision of 2026-10-22 the displayed-frame times measured by PresentMon (how long each frame stayed on screen, within the measurement window) must meet the same limits as the requestAnimationFrame intervals; on Windows a gate-eligible run without PresentMon data is BLOCKED_EXTERNAL, and where no display-timing source exists (macOS) the run records `displaySource: unavailable` and gates on the frame clock only.
- **Evidence:** Owner Cursor; baseline 5be98c4; 2026-10-21. The user declared the measured M4 median of 16.680 ms and p99 of 17.665 ms acceptable, and declared the 59.88 Hz panel refresh acceptable for the 60 FPS profile. `assessGpu` now rounds frame times to 0.001 ms and applies those 60 FPS limits. The 120 FPS p99 limit remains 8.33 ms. `npx --no-install vitest run tests/gpu-report.test.ts tests/evidence-tools.test.ts` and `npx --no-install tsc --noEmit` cover the accepted boundary and the rejection of p99 17.666 ms. The 10-minute WebGL2 capture (`test-results/m4`, Chrome 155.0.8059.85, macOS 27.0.1, AC power, Node 26.8.2, Apple M4 MacBook Air Mac16,12, 8 GPU cores, 16 GB) recorded 35974 frames at 1920×1080 DPR 1 after 60 s warmup, with terrain, FPV, and thermal held and 10092 bytes of tile residency. Its saved analyzer file still says FAIL because it was scored before this decision; under the declared limits those two numbers pass. The operator screenshot in `task_073_results/` (1932×1217 PNG taken 2026-10-20 23:56) shows why the presentation does not pass. Chrome is a floating window on the desktop, the toolbar and `127.0.0.1:5175/?renderer=webgl2&g3=1` are visible, and the macOS wallpaper remains visible around the window. The flight image does not cover the screen. The Mac display mode used for the run is 2560×1440. The MacBook Air panel's native resolution is 2560×1664. The harness had forced an emulated 1920×1080 viewport, which matches neither display. Further testing: repeat the capture with the scene filling the 2560×1440 mode and, separately, the native 2560×1664 panel, and keep a full-display screenshot beside the drawing-buffer size. Run 120 FPS only on a panel at or above 120 Hz, including a 10-minute RTX 4050 capture with terrain, FPV, and thermal. WebGPU stays blocked until fisheye and thermal passes exist. Historical RTX 4050 demo captures remain above both the accepted 17.665 ms p99 and the 8.33 ms 120 FPS limit. RTX 4050 (owner Claude; 2026-10-21): two 10-minute full-feature WebGL2 captures from branch `task-073-render-profile` (`bf53d57`: `?profile=full`, `scripts/capture-render.mjs`, deterministic synthetic CC0 stress tileset of 341 tiles, content SHA-256 `a771cacd838c6603fa63ea3bbd9985d0ad00fed6b84ba0a968210424dfce5940`) with Chrome 155.0.8059.85, NVIDIA GeForce RTX 4050 Laptop GPU (driver 32.0.15.6100), Windows 11 10.0.26200, AC power and an external 1920×1080 60 Hz display, fullscreen 1920×1080 DPR 1 with terrain, FPV and thermal held for the whole window; the flight canvas was 1316×640 inside the application layout, so the full-display rule is also not met. Both traces were scored by this commit line's `scripts/bench-render.mjs` (validator SHA-256 `801a8e97132d788b2678269e81994a9cc4c40fb5ac7f284b77db6f73206fe28b`) under the accepted limits. (1) Balanced power (scheme `381b4222-f694-41f0-9685-ff5bb260df2e`): 35,754 frames, median 16.670 ms, p99 23.880 ms, 349 missed refreshes of 36,000 (0.97%), GPU in P8 at 210–360 MHz, trace SHA-256 `b69f0651c47b73d6a274c765b4ca727efef6e0d4693ea51bfa60d32f86ca17b3`: `FAIL` (p99). (2) Operator-set maximum performance (NVIDIA per-program Prefer maximum performance for `chrome.exe`, Windows Best performance overlay `ded574b5-45a0-4f42-8737-46345c09c238`, vendor Performance profile): 35,151 frames, median 16.685 ms, p99 34.260 ms, maximum 96.5 ms, 947 missed refreshes (2.63%), GPU alternating P5/P8 299 times at 420–450 MHz with NVIDIA clock reason `GPU idle` at 54–64 °C, trace SHA-256 `b90ee6801356df85c9b0790398721d2c900ab51a7c951325eeb94c90e6995061`: `FAIL` (median and p99). GPU-process dedicated memory peaked at 147 MiB and 140 MiB (Windows counters) and the terrain cache at 12.5 MiB, within the 2 GiB / 512 MiB budgets. Diagnosis (local `scripts/diagnose-render.mjs`: WebGL2 `EXT_disjoint_timer_query_webgl2` per requestAnimationFrame callback, 120 s per profile after 20 s warmup): balanced demo/terrain/full p99 21.4/22.2/23.6 ms with 31/30/52 intervals over 25 ms; maximum performance 41.1/40.6/34.8 ms with 131/135/138; main-thread callback p99 at most 5.3 ms and no long tasks in any run; timer-query GPU times follow the clock state rather than the scene. In the balanced trace 63% of intervals over 18.5 ms are timestamp jitter paired with a short interval summing to two refreshes. Conclusion: the misses are dominated by GPU power-state behaviour under Windows hybrid graphics, not by scene cost; the RTX 4050 60 FPS profile stays `FAIL` and no limit was changed. Traces, sidecars, reports and `nvidia-smi` samples are in the ignored `test-results/render/` and `test-results/render/maxperf/` directories and are not committed. P3 (owner Claude; 2026-10-22, branch `task-073-g3`): `scripts/geodata/` builds FABDEM quantized-mesh terrain with a verified EGM2008-to-WGS84 conversion (19.395 m applied against 19.396 m at the area) and 2,871,993 Overture buildings as 3D Tiles 1.1 via PostGIS and `pg2b3dm`; the app loads both through `TilesScene` (`QuantizedMeshPlugin`, `ImplicitTilingPlugin`), and `scripts/check-gpu-perf.mjs --geodata` captures over them. New browser tests place a synthetic quantized-mesh fixture within 0.5 m of its ellipsoidal height and load an implicit-tiling fixture like its explicit twin. Only about 1.3% of buildings carry a height or floor count; the rest use 6 m. P4 (owner Claude; 2026-10-22, branch `task-073-g3`): `scripts/geodata/extract_osm.py` and `build_material_map.py` build a 1 m, 2000 x 2000 material-class raster for the area from the Geofabrik extract (SHA-256 `59ac7350c78fc90d77f65fdc670c1d3248c8b218d9f8bbb4cee4c6ef9b22a2a5`) and ESA WorldCover v200 with the `MaterialMap` legend and precedence; `check_material_map.mjs` agreed with the TypeScript `MaterialMap` at 99.98% of 5,000 seeded samples (criterion at least 97%, one mismatch at a class edge): `PASS`. The app drapes the raster on the terrain (`apps/web/src/render/material-drape.ts`) and shows the WorldCover and OSM attributions; `tests/material-drape.test.ts` covers raster validation, the palette and loading. The colours are for display only; P5 maps classes to emissivities. P5 (owner Claude; 2026-10-22, branch `task-073-g3`): the G3 thermal camera is the approximated `BOSON_640_50DEG` profile (public data sheet values, 8.7 mm 50 degree lens, 60 Hz, no parity claim); `AreaThermal` couples the TASK-070 heat balance to every raster class in five orientations with the section 9.1 emissivities, the G-buffer reads class and face orientation per fragment, and `ThermalSensorChain` drives the TASK-072 shutter/NUC over a generated fixed pattern whose residual the shader adds (equal to the NUC output within 1e-5 K in `tests/thermal-sensor.test.ts`). New tests: `tests/thermal-sensor.test.ts`, `tests/area-thermal.test.ts`, the Boson profile in `tests/thermal-camera.test.ts`, view and time parsing in `tests/g3-mode.test.ts`, and a browser oracle for the fixed pattern and open sky in `tests/browser/thermal.spec.ts` (55 browser tests passed, 16 skipped). Smoke over the Israel area (`--view thermal`, 10 s) rendered the thermal view with one NUC cycle; the tree canopy first reached about 60 C at 10:00 local because the TASK-070 model had no evapotranspiration; after the TASK-070 latent-flux extension (assumed 60% humidity) it stays within about 3 K of air temperature and reads darker than pavement. Visual reference: `scripts/geodata/fetch_flir_sample.py` range-read test video `vbrSzr4vFTm5QwuGH` (208 frames as 14-bit LZW TIFF and 8-bit AGC JPEG, 78 MB, every member CRC-checked) from the Teledyne FLIR ADAS v2 archive (11,865,443,849 bytes, published MD5 `3150533d3a712c598aa110d5513a1671`) into `~/mirage-geodata/flir-adas-v2/` outside the repository; `flir-sample-manifest.json` (SHA-256 `d4b429c720e06fc6e4bab7154f7cd14b6a2b4b471ebbc158b4e72b71f57a1e3f`) lists each file's SHA-256 and the README hash (`662bd3e48d4fe6fb1d55a4bbf83450993cafe3377c9c5f980b64bc58c46e9c28`). It was recorded by a Tau 2 (13 mm, 45 degree HFOV, T-linear) on a car with no time, place or weather in its records, so it supports qualitative comparison only; its frames show tree canopy cooler than sunlit pavement, which the evapotranspiration extension now reproduces. P6 (owner Claude; 2026-10-22, branch `task-073-g3`): the fisheye, analog, thermal G-buffer and thermal camera passes run on WebGPU as TSL node materials (`g3-passes-webgpu.ts`); `tests/browser/webgpu-passes.spec.ts` passes on the RTX 4050 with `MIRAGE_BROWSER_GPU=hardware` (34 rendering tests across the WebGPU, thermal, FPV, analog and backend specs). `check-gpu-perf.mjs` and the analyzer now accept `--backend webgpu`; a 10 s WebGPU smoke over the Israel area held terrain, FPV and thermal at 1920 x 1080 (PresentMon displayed median 16.66 ms, p99 27.9 ms; GPU busy median 6.8 ms; GPU-process memory peak 623 MiB) and is `BLOCKED_EXTERNAL` only for its length. Anti-aliasing after operator review: thermal 3 x 3 detector-area supersampling, mipmapped material colours and a 4x multisampled FPV source (parked frames have no dithering or grain: temporal change 0.00 and 0.19 grey levels); the analog FPV noise default was halved at the operator's request (parked FPV temporal noise 7.07 -> 3.53 grey levels). P7 (owner Claude; 2026-10-22, branch `task-073-g3`, commit `78eccf4`): 10-minute G3 captures after 60 s warmup over the Israel area (FABDEM terrain, Overture buildings, material drape, Boson 640 thermal with 3 x 3 supersampling, scripted circuit, chase view), Chrome with the RTX 4050 on the external 1920 x 1080 60 Hz display (DISPLAY5), Windows Balanced power scheme (`381b4222-f694-41f0-9685-ff5bb260df2e`), terrain, FPV and thermal held throughout, no page errors. WebGL2: 35,656 frames, median 16.670 ms, p99 27.085 ms, 1,579 intervals over 18.5 ms (4.43%), PresentMon displayed p99 26.88 ms, GPU busy median 6.80 ms / p99 7.98 ms, GPU mostly in P4 (633 of 641 samples), GPU-process memory peak 443 MiB, frames SHA-256 `22bfde1f74f87349d70a48f8b4b9240f4518c1dcc542f2deb17755da69dfc8d4`: `FAIL` (p99). WebGPU: 35,893 frames, median 16.665 ms, p99 27.085 ms, 1,477 intervals over 18.5 ms (4.12%), PresentMon displayed p99 27.08 ms, GPU busy median 6.86 ms / p99 8.13 ms, P4 in 629 of 640 samples, memory peak 626 MiB, frames SHA-256 `008d177ecbe4a672a10c60c9b8c5cf57a1813639dd7189426638fd3d85d8963e`: `FAIL` (p99). Both medians are within the accepted 16.680 ms; the p99 misses occur with the GPU busy for less than half of a refresh, consistent with the earlier power-state diagnosis. The informational 120 FPS runs on the internal 144 Hz panel (DISPLAY1, Intel iGPU, 125% scaling) are `BLOCKED_EXTERNAL`: a Chrome window placed on that panel still paces requestAnimationFrame at 59.88 Hz while the 60 Hz external display is primary, so the panel can only be measured as the primary or only display. Reports and traces are in the ignored `test-results/p7/`. No limit was changed; G3 acceptance remains `FAIL` on this machine. Panel runs (2026-10-22, operator disconnected the external display and set the internal panel to 1920 x 1200 at 144 Hz, 100% scaling, Windows power mode Best performance `ded574b5-45a0-4f42-8737-46345c09c238`, AC): all four 10-minute captures rendered on the Intel iGPU that drives the panel (`ANGLE (Intel, Intel(R) Graphics (0x0000A7AB) Direct3D11)`), with the RTX 4050 idle in P8, so the analyzer reports `BLOCKED_EXTERNAL` ("GPU is not Apple M4 or RTX 4050"; the resolution is also not 1920 x 1080). Informational iGPU figures, features held, no errors: WebGL2 120 profile 58.7 FPS mean, median 14.08 ms, p99 22.32 ms, GPU busy median 16.9 ms; WebGPU 120 profile 83.7 FPS, 13.77 / 21.04 ms, GPU busy 11.4 ms; WebGL2 60 profile 58.2 FPS, 14.28 / 21.92 ms; WebGPU 60 profile 98.4 FPS (rendering is not capped at the profile rate), 7.04 / 20.93 ms. Measuring the RTX 4050 on the panel needs Chrome assigned to the high-performance GPU in Windows graphics settings. After the user's device decision (Windows integrated GPUs accepted, GPU recorded in every verdict), the six P7 captures were re-scored with the same inputs (`gpu-report-rescored.json` beside each report): the two external-display runs are `RTX4050`, `FAIL` (p99); the four panel runs are `WindowsIGPU`, `FAIL` because the surface is 1920 x 1200, not the 1920 x 1080 DPR 1 profile (their p99 of 20.9-22.3 ms also exceeds 17.665 ms, and the 120 FPS profile reached 58.7 and 83.7 FPS on average). Frame-pacing diagnosis (2026-10-22, RTX 4050, external 60 Hz display primary, Chrome assigned to the NVIDIA GPU, Best performance): `scripts/diagnose-pacing.mjs` records a Chrome trace, PresentMon and 10 Hz `nvidia-smi` over a 45 s window and `scripts/analyze-pacing.mjs` attributes every missed refresh. Missed and on-time frames do the same work (page BeginMainFrame 3.7 vs 3.9 ms, rAF callbacks 3.5 vs 3.4 ms, Chrome executing the WebGL commands 0.85 vs 0.90 ms, no page GC, GPU busy 6.9 vs 6.9 ms); the late frames are presented on time but displayed for two refreshes, while Chrome's GPU thread blocks in `DXGISwapChainImageBacking::Present` for 29 instead of 16 ms. Setting the internal panel from 144 to 60 Hz did not change the rate (9.66% vs 9.79%), so a refresh-rate beat is ruled out. The cause is Chrome's direct-composition presentation of the fullscreen canvas (PresentMon: Hardware Composed: Independent Flip, sync interval 0, about 66 ms display latency): with `--disable-direct-composition` (Composed: Copy with GPU GDI, sync interval 1) the same 45 s window gives WebGL2 rAF median 16.665 ms, p99 16.675 ms, 0.82% late displays (default: p99 34.73 ms, 9.66%) and WebGPU median 16.665 ms, p99 16.675 ms, 0.48% (default: p99 35.38 ms, 9.60%), with all features active. These are diagnostic windows, not 10-minute acceptance captures. 10-minute captures with the switch (`check-gpu-perf.mjs --chrome-args "--disable-direct-composition"`, recorded as `chromeArgs` in the trace and report metrics and in the browser identity; RTX 4050, external 1920 x 1080 60 Hz display, Best performance, all features held, no errors): WebGL2 35,982 frames, median 16.665 ms, p99 16.675 ms, 22 intervals over 18.5 ms (0.06%), GPU busy median 4.74 ms, memory peak 441 MiB, frames SHA-256 `de7ae7d42deac75bc093268515b2e70edb2a8d0629d5dad2afb7c159185d81e8`: `PASS`; WebGPU 35,993 frames, median 16.665 ms, p99 16.685 ms, 20 intervals over 18.5 ms (0.06%), GPU busy median 5.09 ms, memory peak 626 MiB, frames SHA-256 `528b6642ff4c4cc2df095fb822525da7ffaf2dbbc8b0ac0dc26de528db27441f`: `PASS`. Caveat: the gate scores the page's requestAnimationFrame intervals; PresentMon, which records what reached the display, shows 2.56% (WebGL2) and 2.06% (WebGPU) of frames shown for two refreshes with the switch (Composed: Copy with GPU GDI; for WebGL2 34,971 of 35,982 rendered frames were displayed), against 1.33% and 1.43% in the default Balanced baselines. The switch makes Chrome's frame clock regular but does not remove on-screen judder; the PASS applies to the defined requestAnimationFrame gate with this Chrome configuration only. Displayed-frame gate (user decision 2026-10-22; `bench-render.mjs` field `displayedMs`, filled by `check-gpu-perf.mjs` from the PresentMon CSV): re-scoring all eight P7 captures with the recorded data (`gpu-report-rescored.json`) gives `FAIL` for every run. Stock Chrome on the RTX 4050: frame clock p99 27.085 ms and displayed p99 26.88 ms (WebGL2) / 27.08 ms (WebGPU). `--disable-direct-composition`: frame clock p99 16.675 / 16.685 ms but displayed p99 33.40 / 33.37 ms, so the earlier `PASS` becomes `FAIL`. Intel iGPU panel runs: `FAIL` on the 1920 x 1080 DPR 1 surface rule. No limit was changed. WebGL2 iGPU optimisation (2026-10-22; `?g3profile=1` per-pass GPU timer queries; Chrome `--force_low_power_gpu` to render on the Intel iGPU, 1920 x 1080): the FPV source render cost 8.57 ms because its 4x multisampled target also resolved depth and stencil, which ANGLE/D3D11 does with a shader; resolving colour only (the only attachment read) gives 3.41 ms with the same 4x anti-aliasing, and rendering the shadow map once per frame instead of on each of the three scene renders saves another 0.6 ms; GPU time per frame 15.5 -> 9.3 ms (WebGPU on the same iGPU: about 9.6 ms), image unchanged in chase and FPV screenshots. Lost flights: 5 of the 9 P7 captures lost the scripted flight (the first at 40 s in the RTX 4050 WebGL2 baseline; the 10-minute iGPU capture after the optimisation at 92 s), so their frame times do not measure the flight scene; the Worker's `pilot.rejected` diagnostic (recorded as `pilotRejection` in each flight-log sample) shows the cause: a fresh pilot sample with age -0.000244 ms (one double-precision step at the epoch-millisecond magnitude) failed the `age >= 0` freshness check, the armed latch blocked permanently and the demo dynamics dropped the drone onto its flat ground, which lies inside the real terrain. Fix: pilot freshness now accepts samples stamped up to `INPUT_CLOCK_TOLERANCE_MS` = 1 ms in the future (Main and the Worker each compute `performance.timeOrigin + performance.now()` from their own coarsened time origin); samples further in the future and older than 250 ms still disarm and block the latch, and `tests/session-v2.test.ts` replays the captured -0.000244 ms age. Check after the fix (2026-10-23; Chrome 155 with `--force_low_power_gpu`, ANGLE Intel(R) Graphics (0x0000A7AB) Direct3D11, WebGL2, real terrain, chase view, fullscreen 1920 x 1080): the scripted circuit flew 661 s with HUD altitude 30.0 m in all 66 samples at 10 s intervals, no input failsafe and no `pilot.rejected` notice (before the fix the same setup lost the flight after 48 s and 92 s). This is a flight check, not a G3 frame-time capture. Intel iGPU gate captures (2026-10-23; `check-gpu-perf.mjs --chrome-args "--force_low_power_gpu"`, Chrome 155, Balanced power, external 1920 x 1080 59.88 Hz monitor at 1x, real terrain, chase view, 60 s warmup + 600 s; output `test-results/p7/igpu-gate-{webgl2,webgpu}-60-external`): both gate-eligible and both `FAIL` with terrain, FPV and thermal held and the scripted flight airborne throughout. WebGL2: 35,658 frames, median 16.655 ms, p99 27.685 ms, 447 missed refreshes, PresentMon displayed median 17.052 ms and p99 57.041 ms (10,191 of 35,660 presented frames never displayed), rating 63. WebGPU: 35,712 frames, median 16.670 ms, p99 24.040 ms, 378 missed, displayed median 16.677 ms and p99 50.008 ms (3,929 of 35,713 never displayed), rating 75. Both rendered on the Intel GPU (GPU process: shared memory only, GPU busy median 11.4 / 11.2 ms); the monitor is driven by the NVIDIA GPU, so frames cross adapters and are composed by DWM (`Composed: Flip`). Both runs are in `docs/benchmarks/device-results.json`; the historical records of this laptop now carry the full renderer strings their captures recorded, so the Intel runs group as one GPU. `node scripts/gpu-ratings.mjs decide`: `BLOCKED_EXTERNAL` until the M4 and M5 have gate-eligible runs; if the Intel iGPU is the least performant, TASK-073 fails. Intel iGPU on its own panel (2026-10-23; the same command with `--position 1920,0` on the internal panel set to 1920 x 1080 60 Hz at 100% scaling, so the Intel GPU drives the display and the NVIDIA GPU idled in P8; output `test-results/p7/igpu-panel1080-{webgl2,webgpu}-60`): both gate-eligible and `FAIL`, rating 38 each. WebGL2: 35,101 frames, median 16.670 ms, p99 42.430 ms, 1,061 missed refreshes, all frames displayed, displayed p99 33.395 ms. WebGPU: 35,108 frames, median 16.665 ms, p99 41.965 ms, 1,035 missed, displayed p99 33.375 ms. Present mode `Hardware Composed: Independent Flip`; GPU busy median 11.4 / 11.9 ms, p99 15.2 / 18.5 ms. Pacing is worse than through the NVIDIA-driven monitor, so the cross-adapter copy is not the cause of the failure. All four Intel runs are in the registry (ratings 38-75). Pacing diagnosis on the iGPU panel (2026-10-23; `diagnose-pacing.mjs --backend webgl2 --position 1920,0 --chrome-args "--force_low_power_gpu"`, 45 s after 30 s warmup; not acceptance evidence): 282 of 2,277 presents came more than 1.5 refreshes after the previous one (12.4%; tracing adds load). The late frames are frames Chrome never started, not slow frames: Chrome's compositor recorded 273 `STATE_DROPPED/BACKFILL` frames and skipped one or two BeginFrames 191 and 76 times; renderer main-thread and rAF work (about 7-8 ms), GPU-process work and Present (0.13 ms, not blocked) match on-time frames; Intel GPU time per frame is 13.7 ms either way, and the GPU sat idle a median 28.5 ms before each late frame (2.5 ms before on-time frames), so it was waiting for Chrome rather than backed up. 281 of the 282 late presents coincide with a `GpuVSyncThread` wait that lasted two or three refreshes (90 and 184 of 2,277 waits, with no work inside): the vertical-blank signal Chrome's GPU process waits on arrived for only about 85% of the panel's refreshes, and without a BeginFrame no frame is produced. The cause of the lost vertical-blank signals on this Intel-driven panel (driver, panel power management such as Panel Self Refresh, or Chrome's Windows VSync provider) has not been isolated. Idle control (2026-10-23; the same panel, Chrome and switch, a black fullscreen page changing one 8 x 8 px square per frame, no WebGL scene, 60 s with a light trace): 3,598 rAF frames, p99 20.2 ms, 4 intervals over 1.5 refreshes (0.1%); 3,599 `GpuVSyncThread` waits for about 3,593 refreshes, of which 3 lasted two refreshes and 1 three. The vertical-blank signals are lost only under the scene's load, not by the panel or driver at rest. Split-load controls (2026-10-23; same panel, Chrome and switch, 60 s each with a light trace): a full-screen WebGL2 shader calibrated with timer queries to 13.0 ms of Intel GPU time per frame (p95 13.6 ms) gave 3,591 `GpuVSyncThread` waits for about 3,593 refreshes, 13 waits of two or three refreshes and 13 late rAF intervals (0.36%); 15 ms of busy main-thread work per frame without WebGL gave 3,600 waits, 8 of two refreshes and 8 late intervals (0.2%). Neither GPU load nor main-thread CPU load alone reproduces the scene's loss of about 15% of the signals; the trigger is another part of the scene's load (for example the combination, the physics Worker, memory traffic or the scene's GPU passes) and has not been isolated. Scene and tool bisection (2026-10-23; same panel, Chrome and switch; each case flies the circuit 30 s, then 45 s of rAF intervals and a light `toplevel` trace; `?g3skip=fpv|thermal` skips those WebGL2 passes for diagnostics and marks the probe feature off): without capture tools the full scene lost only 10 vertical-blank signals (0.37% late rAF intervals, p99 20.7 ms), and skipping thermal (0.30%), skipping FPV (0.37%), pausing the physics Worker (0.19%) or a synthetic 13 ms GPU + 8 ms CPU load (0.22%) changed nothing. Adding the capture tools one at a time to the full scene: PresentMon 0.41%, `typeperf` GPU-memory counters 0.19%, `nvidia-smi` polled at 1 Hz as in `check-gpu-perf.mjs` 1.99% (52 long waits, rAF p99 46.7 ms), `nvidia-smi` at 10 Hz as in `diagnose-pacing.mjs` 12.55% (285 long waits, p99 55.6 ms), all three capture tools 1.63%. The lost signals are caused by the harness's own `nvidia-smi` sampler: each query of the idle RTX 4050 delays the Intel panel's vertical-blank signal by two or three refreshes. The Intel iGPU gate captures above ran with that sampler at 1 Hz, so their frame-time failures are at least partly an artefact of the measurement; they stay recorded as measured, and no limit or verdict was changed. Re-capture without `nvidia-smi` (2026-10-24; `check-gpu-perf.mjs` and `diagnose-pacing.mjs` now query `nvidia-smi` only when the measured WebGL renderer is NVIDIA and otherwise record the clocks as unavailable with the reason, `clockSamplerFor` in `scripts/capture-samplers.mjs`, tested in `tests/capture-samplers.test.ts`; Intel iGPU on its own 1920 x 1080 60 Hz panel at 1x, otherwise as above; output `test-results/p7/igpu-panel1080-nosmi-{webgl2,webgpu}-60`): both gate-eligible and still `FAIL` on the p99 limit only. WebGL2: 35,937 frames, median 16.665 ms, p99 19.960 ms, 88 missed refreshes, all frames displayed, displayed median 16.667 ms and p99 19.297 ms, rating 92. WebGPU: 35,951 frames, median 16.665 ms, p99 20.140 ms, 81 missed, displayed p99 19.926 ms, rating 91. GPU busy median 12.3 / 12.1 ms, p99 15.2 / 18.3 ms. Without the sampler the frame-clock p99 fell from 42.4 to 20.0 ms; the remaining 2.3-2.5 ms over the limit is not attributed yet. Harness rewrite (owner Claude; 2026-10-23, branch `task-073-g3`): `scripts/gpu-trace.mjs` classifies GPUs as integrated, discrete, software or unknown, rates every valid run out of 100 (pacing 50, sustain 20, median 10, features 10, memory 10) and gates only integrated 1920 x 1080 1x 60 FPS runs; `scripts/check-gpu-perf.mjs` no longer rejects other GPUs or canvases, records the display refresh, canvas, scripted-flight state and the wall-to-monotonic skew (a window the machine slept through is BLOCKED_EXTERNAL: on 2026-10-22 an Apple M5 capture with the lid closed showed 199-310 ms stalls about every 46 s, one of which aged a pilot sample to 256.9 ms, tripped the 250 ms input timeout and grounded the scripted flight), and writes a schema-2 trace and `run-record.json`; `scripts/gpu-ratings.mjs` keeps the registry, rates each machine + screen + GPU combination, picks the least performant integrated GPU and produces the G3 `gpu-report`. The registry is seeded with the historical M4, RTX 4050, Intel iGPU and M5 runs (provisional ratings where inputs are missing). `npx --no-install vitest run tests/gpu-report.test.ts tests/evidence-tools.test.ts`: 4 passed; `npm run lint` and `npm run typecheck`: pass; `npm test` on the Apple M5: 626 passed, 1 skipped, 1 failed (`tests/contact-allocation.test.ts` timed out at 300 s in the parallel suite and passed alone in 294.8 s; an earlier full run reported 5 failures in 2 files whose names were not captured); `npm run check:docs`: pass. A 25 s smoke capture on the M5 wrote a schema-2 trace and run record and was correctly BLOCKED_EXTERNAL for its length; the scripted flight held 30 m at 10 m/s; the CDP fullscreen request left the macOS window at a 1200 x 1029 viewport, which is still open. `node scripts/gpu-ratings.mjs decide`: BLOCKED_EXTERNAL (no gate-eligible run on any of the three tested integrated GPUs). Primary display and vertical-blank delivery (owner Claude; 2026-10-24, branch `task-073-g3`): the remaining p99 gap of the Intel iGPU panel runs came from the display arrangement, not from the scene. Chrome on Windows waits for the vertical blank of the primary monitor (`ui/gl/vsync_thread_win_dxgi.cc`: `MonitorFromWindow(nullptr, MONITOR_DEFAULTTOPRIMARY)`, then `IDXGIOutput::WaitForVBlank`) and stamps each frame with the time its vsync thread woke (`ui/gl/vsync_thread_win.cc`: `base::TimeTicks::Now()`); those stamps are the `requestAnimationFrame` timestamps the gate scores. In the 2026-10-23 and 2026-10-24 panel runs the primary monitor was the external display driven by the NVIDIA GPU at (0,0) and the measured window was on the Intel panel at (1920,0), so the frame clock came from another display. Panel settings (CSOT MNG007QX2-2): its EDID declares 1920 x 1200 with a 60 Hz base timing and range limits of 48-144 Hz with continuous frequency (variable-refresh capable); the Intel driver has Adaptive Sync, PSR2 (with DRRS) and DPST on; Windows has no per-user variable-refresh or windowed-game settings. Variable refresh was not engaged: PresentMon screen times of the 2026-10-24 captures lie on a fixed 16.6668 ms grid (60.000 Hz). New diagnostics: `scripts/vblank-probe.ps1` waits on `D3DKMTWaitForVerticalBlankEvent`, the kernel wait behind `WaitForVBlank`, and reads the scan line on waking; `scripts/analyze-vblank.mjs` reconstructs each vertical blank on a fitted refresh grid and aligns page rAF timestamps with it; `scripts/diagnose-pacing.mjs` gained `--no-trace`, `--vblank LINES` and `--query`; `check-gpu-perf.mjs` records whether the captured display was the primary one. With the panel as the only display, the vertical-blank event reached a waiting thread 0.21 ms (p50) and 6.8 ms (p99) after the blank on an idle desktop (`test-results/pacing/vblank-desktop-idle.json`; consistent with panel self refresh or display power states, not isolated, and not on the measured path because the G3 scene redraws the whole screen every frame) and 0.83 ms (p99) during the full WebGPU scene; raising the waiting thread's priority (normal, above normal, highest in a high-priority process) did not shorten the tail. In a 150 s WebGPU scene window (`diagnose-pacing.mjs --backend webgpu --no-trace --vblank 1200 --query "&g3profile=1" --chrome-args "--force_low_power_gpu --enable-webgpu-developer-features"`, output `test-results/pacing/panelonly-profile`) Chrome's rAF timestamps arrived 0.10 ms (p50) and 0.77 ms (p99) after the blank, and 38 of the 40 that were more than 1 ms late fell on refreshes where the probe was also late: the frame-clock jitter is the kernel's delivery of the vertical-blank event, which no page can change. Gate captures with the external display disconnected (`check-gpu-perf.mjs --position 0,0 --chrome-args "--force_low_power_gpu"`, Chrome 155, Balanced power, internal panel 1920 x 1080 60 Hz at 100% scaling as the only display, Israel area, chase view, 60 s warmup + 600 s; output `test-results/p7/igpu-panelonly-{webgl2,webgpu}-60`, recorded in `docs/benchmarks/device-results.json`): WebGL2 `PASS`, rating 100: 36,004 frames, median 16.665 ms, p99 17.310 ms, maximum 23.430 ms, 0 missed refreshes, every frame displayed (`Hardware Composed: Independent Flip`), displayed median 16.666 ms and p99 17.279 ms, GPU busy median 13.6 ms and p99 15.1 ms, GPU-process shared memory peak 497 MiB. WebGPU `PASS`, rating 100: 36,002 frames, median 16.665 ms, p99 17.310 ms, maximum 40.465 ms, 2 missed refreshes, every frame displayed, displayed median 16.666 ms and p99 17.281 ms, GPU busy median 13.7 ms and p99 15.0 ms (48 of 41,399 presents above 16.67 ms, against 633 of 41,340 with the external display, whose bursts in the first two laps no longer appear), shared memory peak 648 MiB. Terrain, FPV and thermal were held and the flight stayed airborne in both. The WebGL2 capture's build predates this change; the WebGPU capture's build already contained the new per-pass timer, inactive without `?g3profile=1`. WebGPU per-pass GPU time (new `apps/web/src/render/gpu-pass-timer-webgpu.ts` behind `?g3profile=1`: it labels three's per-pass timestamp queries with the G3 pass that issued them; 10,018 frames of the 150 s window above): FPV scene 1.43 ms, fisheye 1.62 ms, analog 0.73 ms, chase scene 2.48 ms, thermal G-buffer 1.13 ms, thermal camera 0.95 ms (medians); sum of passes median 8.43 ms, p99 9.30 ms, maximum 11.52 ms; no frame above 16.67 ms. `?g3skip` now applies to both backends. `npx --no-install vitest run tests/gpu-pass-timer-webgpu.test.ts tests/g3-mode.test.ts tests/capture-samplers.test.ts tests/gpu-report.test.ts tests/evidence-tools.test.ts`: 14 passed; `npm run typecheck` and `npm run lint`: pass. `node scripts/gpu-ratings.mjs decide`: `BLOCKED_EXTERNAL` (the M4 and M5 still have no gate-eligible run). No limit was changed.

## Phase 6: UI & Telemetry

### TASK-074 — Pilot HUD and freshness

- **Status:** DONE — Cursor; baseline d4dda82; 2026-10-20. Identity-bound `EkfMonitor` diagnostics from decoded USB `serial.frame` messages drive `PilotHud` source, `custom_mode`, degraded/valid EKF flags, and 1000 ms staleness. Disconnect clears the overlay back to demo truth. The physics Worker still publishes unknown autopilot fields. A serial grant does not admit browser READY or HITL.
- **Title & Description:** Display attitude/speed/altitude/mode/EKF with source and age.
- **Dependencies:** TASK-015, TASK-039, TASK-043.
- **Touched Files:** `apps/web/src/hud/PilotHud.tsx`, `apps/web/src/hud/attitude.ts`, `apps/web/src/hud/telemetry.ts`, `apps/web/src/SerialConnect.tsx`, `apps/web/src/App.tsx`, `apps/web/src/runtime.ts`, `apps/web/src/style.css`, `packages/physics/src/session-v2.ts`, `tests/session-v2.test.ts`, `tests/hud.test.ts`, `tests/browser/hud.spec.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `HANDOVER.md`, `docs/ru/HANDOVER.md`, `docs/documentation-index.json`.
- **Interfaces / Contracts:** FlightStateV2; normalized ekf_flags; unknown/stale visual states.
- **DoD & Acceptance Criteria:** Verify NED horizon signs; demo cannot fabricate valid EKF; stale AP status is marked; decimate React updates instead of setState at 1200 Hz.
- **Evidence:** Owner Cursor; baseline d4dda82; 2026-10-20. `npx --no-install vitest run tests/hud.test.ts tests/session-v2.test.ts` (15 PASS: `tests/hud.test.ts` 3, `tests/session-v2.test.ts` 12) verifies NED horizon signs, `q`/`-q` equivalence, demo rejection of fabricated EKF flags, failed-innovation gating, and age staleness. `npx --no-install playwright test tests/browser/hud.spec.ts tests/browser/serial-permission.spec.ts tests/browser/instructor.spec.ts` (8 PASS in Chromium 141 headless shell) verifies demo unknown status, CRC-valid golden HEARTBEAT/EKF frames through `serial-io.worker.ts`, `EKF DEGRADED` for raw flags 167, `EKF flags valid` for raw flags 55, STALE after more than 1000 ms of silence, at most 12 HUD DOM mutations in 1000 ms, disconnect returning to demo truth, and the existing serial-permission and instructor regressions. `npm run typecheck`, `npm run lint`, and `npm run build` exit 0.

### TASK-075 — Instructor console and hotkeys

- **Status:** DONE — Cursor; baseline ba4e37c; 2026-10-20. Editable fault IDs are admitted by the live session EW registry and become applied only after the Worker tick ACK. Weather and model commands stay rejected. The demo spool is not a per-rotor model, so a motor-loss flag could not change its single thrust; TASK-124 now rejects motor-loss at admission instead.
- **Title & Description:** Send weather/fault/model commands with explicit pending/applied status.
- **Dependencies:** TASK-010, TASK-038, TASK-058, TASK-074.
- **Touched Files:** `apps/web/src/instructor/Console.tsx`, `apps/web/src/instructor/hotkeys.ts`, `apps/web/src/instructor/commands.ts`, `apps/web/src/App.tsx`, `apps/web/src/runtime.ts`, `apps/web/src/style.css`, `tests/instructor.test.ts`, `tests/browser/instructor.spec.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** ControlCommandV2 request/ACK/epoch; scenario fault registry.
- **DoD & Acceptance Criteria:** Hotkeys ignore text-input focus; cancellation/reset/stale epoch/rejection are visible; show applied only after ACK; all fault IDs are usable without source changes.
- **Evidence:** Owner Cursor; baseline ba4e37c; 2026-10-20. `tests/instructor.test.ts` (1 PASS) and `tests/session-v2.test.ts` (12 PASS) verify the ACK ledger and that an arbitrary `fault.set` id is queued, then applied, and publishes `EwFlagV2.GnssJamming`, while `weather.set`, `model.load`, and a session without the EW port stay rejected. `tests/browser/instructor.spec.ts` verifies the same weather rejection, fault applied ACK, and text-input hotkey suppression in Chromium. A reset clears the EW flags.

### TASK-124 — Fault and EW contract alignment

- **Status:** DONE — Claude; baseline 27e2a6a; 2026-10-27. A settings audit found four mismatches between fault admission, EW execution and the application: an 11.3 km position step (each component inside ±10 km) was admitted, acknowledged `applied`, and then halted the session until a page reload; motor-loss was acknowledged with no physical effect on the demo quad; the Worker's motor table was fixed to motors 0–3; and `sim.configure` kept active faults while `sim.reset` cleared them. Per the user's decisions, unmodeled motor-loss is rejected at admission and `sim.configure` clears faults.
- **Title & Description:** Make fault admission match the EW kernels, report failed applies as rejects, derive motor tables from the active dynamics, and keep faulted sessions recoverable without a reload.
- **Dependencies:** TASK-010, TASK-057, TASK-058, TASK-075, TASK-085.
- **Touched Files:** `packages/protocol/src/control-v2.ts`, `packages/protocol/src/control-v2.schema.json`, `packages/physics/src/session-v2.ts`, `packages/ew/src/session-port.ts`, `packages/ew/package.json`, `apps/web/src/physics.worker.ts`, `apps/web/src/runtime.ts`, `apps/web/src/App.tsx`, `tests/control-v2.test.ts`, `tests/session-v2.test.ts`, `tests/ew-pipeline.test.ts`, `tests/scenario-runner.test.ts`, `tests/browser/instructor.spec.ts`, `tests/browser/runtime-v2.spec.ts`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `scripts/check-gpu-perf.mjs`, `tests/browser/simulation.spec.ts`, `tests/contact-allocation.test.ts`.
- **Interfaces / Contracts:** Control Protocol v2 admits `position-step` only with `|offsetNedM|<=10000` m (the expression of `PositionStep.schedule`); `ScheduledRejectV2` and `ControlTargetV2.applyScheduled(...): ScheduledRejectV2 | null`; `ControlProcessorV2.halt(reason)`; `SessionDynamics.useMotorFaults`; `SessionFaultPort.bindMotors` (replaces `validityFlags`); `createSessionFaultPort` (`@mirage/ew/session-port`); `ViewStats.faulted`. Wire messages, reject codes, Control Protocol v2 and ABI v2 are unchanged, so no version bump is needed; `packages/ew/src/engine.ts` is unchanged, which keeps the TASK-059 frozen source identities valid.
- **DoD & Acceptance Criteria:** Admission and the PositionStep kernel agree for every tested offset on and around the 10 km sphere; a due command that cannot take effect gets a final reject (OVERLOAD or OUT_OF_RANGE), never `applied`; every session fault halts the processor, so `sim.start` is refused and `sim.reset` recovers without a pause or a page reload; motor-loss is rejected with BAD_STATE while the active dynamics reads no motor-fault table; motor IDs are `0..rotorCount-1` of the active dynamics and are rebuilt by `sim.configure`; `sim.configure` clears every fault and keeps the last reset's seed; English and Russian contracts change together.
- **Discovered dependency repair:** CI on this branch, like `main` at `4593971` and `ebea731`, intermittently failed `tests/browser/simulation.spec.ts` "isolates shared memory, renders, takes off and pauses/resets" with the altitude stuck at 0. One Main-thread frame longer than the 250 ms pilot-input timeout (a slow software-rendered CI frame) makes the session disarm on stale input and block rearming until the request is withdrawn, as specified, but Main kept requesting arm and kept showing "Disarm motors". A 400 ms injected stall reproduced it locally; a 200 ms stall did not. Main now follows the session's arm latch (`SimulationRuntime.followSessionArming`): it withdraws a request the session dropped, or can no longer grant because the throttle rose above 5% first, and shows why. The takeoff test now climbs like an operator, rearming explicitly at 0% throttle after a logged failsafe, and a new browser test injects the stall. The new test failed before the fix and passes after it; the helper passed 5/5 under random 300–500 ms stalls; the 9 UI browser specs pass 29/29; lint and typecheck exit 0. With lint fixed, the CI unit job reached `npm test` for the first time since `4dcae07`; its only failure was `tests/contact-allocation.test.ts` exceeding its single 300 s budget (343 s on CI; 212–278 s in the last passing `main` runs). The nine configurations now run as separate tests with a 180 s budget each, keeping the same 9,000,000 WASM steps and assertions (locally 4 s, 13–17 s and 32 s for 0, 3 and 8 wheels).
- **Evidence:** Owner Claude; baseline 27e2a6a; 2026-10-27. Before the fix, with only the behavior-preserving move of the Worker port into `createSessionFaultPort`, `npx --no-install vitest run tests/control-v2.test.ts tests/session-v2.test.ts tests/ew-pipeline.test.ts` exited 1 with 12 failed / 94 passed: the 11 new tests kept here (11.3 km step admitted; failed apply acknowledged `applied`; motor 5 hitting the fixed 0–3 table and faulting the session; faults kept by `sim.configure`; a HITL fault not resettable without a pause) and one `EwEngine.bindMotorFaults` test, dropped when `engine.ts` was left byte-identical. After the fix that set plus `tests/scenario-runner.test.ts`, `tests/motor-fault.test.ts`, `tests/position-step.test.ts` and `tests/instructor.test.ts` passes 118/118 in 7 files. `npm test` exits 0: 613 passed, 1 skipped in 104 files (before the contact-allocation budget repair above, its only failure was that test's 300 s timeout). `npm run typecheck` exits 0. `npm run lint` exits 0 after a behavior-neutral fix of the two errors in `scripts/check-gpu-perf.mjs` that had failed the `main` CI lint step since `4dcae07` (`cause` on the rethrown error, `globalThis.HTMLButtonElement` in the page callback). `npm run check:docs` exits 0 (20 pairs, 124 tasks). Playwright 1.56.1 with Chromium 141.0.7390.37 headless on macOS 26.6 arm64, served on Vite port 5183 because port 5173 was held by another worktree's server: 28/28 pass in the `instructor`, `runtime-v2`, `simulation`, `accessibility`, `hud`, `aar`, `capabilities`, `radio` and `serial-permission` specs, including the visible motor-loss rejection and Reset recovery from a staged session fault. G1 on Node 24.22.1: `node scripts/bench-physics.mjs` reports zero allocation (0 GC, 0 B/step, allocating control detected), and a session probe with `createSessionFaultPort`, all five effects active and a bound six-motor table measured 0 GC and 0 B/step over 1e6/2e6-step windows at 400 and 1200 Hz (allocating control: 68 GC). English and Russian `SPECS_SHARED_MEMORY.md`, `SPECS_SIMULATION_ENGINES.md`, `architecture.md`, `README.md` and this roadmap changed together. Remaining: no session dynamics reads motor faults yet (wiring BetFlightDynamics is open), and `npm test` rewrites tracked reports under `test-results/` (restored to HEAD here).

### TASK-076 — AAR recorder

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Bounded recorder/producer library and decimated demo flow; full-rate production fanout is not wired.
- **Title & Description:** Record input/actuator/truth/sensor/events in a separate bounded recorder.
- **Dependencies:** TASK-004, TASK-013, TASK-058.
- **Touched Files:** `packages/aar/package.json`, `packages/aar/src/format.ts`, `packages/aar/src/record.ts`, `packages/aar/src/handoff.ts`, `packages/aar/src/recorder.ts`, `packages/aar/src/recorder.worker.ts`, `packages/aar/src/recorder-host.ts`, `packages/aar/src/storage.ts`, `tests/aar-recorder.test.ts`, `tests/browser/aar.spec.ts`, `tests/support/aar-harness.ts`, `scripts/bench-aar.mjs`, `apps/web/src/runtime.ts`, `apps/web/package.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `tests/aar-storage.test.ts`.
- **Interfaces / Contracts:** AAR version/model hashes/seed/epoch/time domains; IndexedDB chunks/checksums.
- **DoD & Acceptance Criteria:** A configured 30 min ring has a fixed byte cap; explicitly count storage backpressure/loss; physics handoff meets zero-allocation; the 256-slot render ring is never an archive.
- **Evidence:** Owner Codex/Claude; baseline 660d86e; 2026-10-16. `tests/aar-recorder.test.ts` (5 PASS), `tests/aar-storage.test.ts` (2 PASS), and `tests/browser/aar.spec.ts` (1 PASS) verify ISO-HDLC CRC (`cbf43926`), fixed `9,216,000`-byte 30 min / 10 Hz ring capacity, dedicated 256-slot handoff SAB, and `ChunkStorage` `maxPending = 8` IndexedDB burst queueing with counted overflow drops. `node scripts/bench-aar.mjs 400|800|1200` (`test-results/bench/aar-400.json`..`1200.json`) passes six `1e6`/`2e6` windows with 0 GC. Active demo recording is Main-decimated with explicit gaps; full-rate physics/autopilot fanout is not wired.

### TASK-077 — Replay and timeline

- **Status:** DONE — Codex; baseline 660d86e; 2026-10-16. Snapshot replay and provenance-gated resimulation comparison interface.
- **Title & Description:** Separate recorded snapshot replay from deterministic resimulation.
- **Dependencies:** TASK-015, TASK-076.
- **Touched Files:** `packages/aar/src/replay.ts`, `packages/aar/src/resimulation.ts`, `tests/aar-replay.test.ts`, `packages/aar/package.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** ReplayMode snapshots/resimulate; seek boundaries; configuration provenance.
- **DoD & Acceptance Criteria:** Correct seeking/reset/epoch discontinuity; reject unknown format/hash mismatch; replay preserves records; resimulation mismatch generates a report instead of rewriting recordings.
- **Evidence:** Owner Codex; baseline 660d86e; 2026-10-16. `tests/aar-replay.test.ts` (3 PASS) verifies epoch-scoped seek, immutable snapshot copies, corrupted/version/hash rejection, co-timed multi-sensor tick advancement, and mismatch reporting without rewriting recorded archives.

### TASK-078 — AAR response charts

- **Status:** DONE — Cursor; baseline 55a7c01; 2026-10-20. The physics worker is the only recording producer. Each tick stores truth and the pilot input used for that tick. A sensor or actuator payload is stored only when that tick already owns the frame. The 32 MiB archive caps the full-rate window below 30 minutes. Charts still decimate to at most 10000 points.
- **Title & Description:** Align pilot input, actuator commands, and model responses on one time axis.
- **Dependencies:** TASK-074, TASK-077.
- **Touched Files:** `apps/web/src/aar/Review.tsx`, `apps/web/src/aar/series.ts`, `tests/aar-series.test.ts`, `tests/browser/aar.spec.ts`, `apps/web/src/style.css`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Bounded decimated time series; units/timebase; explicit recording gaps.
- **DoD & Acceptance Criteria:** A known step-response fixture shows correct lag; do not interpolate gaps as real data; display 30 min with <=10000 points per series and bounded memory.
- **Evidence:** Owner Codex; baseline 660d86e; 2026-10-16. `tests/aar-series.test.ts` (2 PASS) and `tests/browser/aar.spec.ts` verify `0.2`/`0.3`/`0.4` s pilot/actuator/response step alignment, uninterpolated gap segments, and 30 min (`18,000`-sample) peak-preserving decimation to `<=10,000` points. `tests/session-v2.test.ts` records more than 8 full-rate ticks with the decimated flag clear and one consumed barometer frame. The physics session is the only sensor-queue consumer while recording.

### TASK-079 — Lessons and scenario runner

- **Status:** DONE — Cursor; baseline 6fa74a6; 2026-10-20. A scenario event is submitted on its simulation tick with the live epoch and a fresh request id. The binder claims applied only after the applied ACK. A queued ACK, a weather rejection, and a missed tick do not count as applied. Placeholder lesson hashes are not a certified aircraft lesson.
- **Title & Description:** Define reproducible training scenarios declaratively.
- **Dependencies:** TASK-043, TASK-059, TASK-075, TASK-077.
- **Touched Files:** `packages/scenarios/package.json`, `packages/scenarios/src/schema.ts`, `packages/scenarios/src/runner.ts`, `tests/scenario-runner.test.ts`, `tests/fixtures/scenarios/pilot-basics.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `packages/scenarios/src/evaluate.ts`, `package-lock.json`, `scripts/bench-terrain-scenarios.mjs`.
- **Interfaces / Contracts:** Goals/seed/model/firmware/events/rubric/version; no physics in UI.
- **DoD & Acceptance Criteria:** Reject malformed/unsupported scenarios; identical configuration emits identical tick events; evaluate outcomes from traces/thresholds, not just timers; paused clocks incur no simulation-time penalty.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `tests/scenario-runner.test.ts` and `node scripts/bench-terrain-scenarios.mjs 400|800|1200` (`test-results/bench/terrain-scenarios-400.json`..`1200.json`: 0 GC) verify `packages/scenarios/` schema admission, deterministic tick event polling, pause handling without sim-time penalty, and trace-based rubric evaluation against `tests/fixtures/scenarios/pilot-basics.json`. `tests/scenario-runner.test.ts` (5 PASS) verifies identical tick indices, pause handling, rubric evaluation, epoch binding, applied-only claims, a live fault ACK with `EwFlagV2.GnssJamming`, and a weather command recorded as rejected. Placeholder lesson hashes remain uncertified.

### TASK-080 — Accessibility and permissions UX

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Demo keyboard/focus/narrow-layout/permission UX and unsuppressed axe scan verified; TASK-075 and TASK-078 are done. Manual screen-reader/hardware checks remain open.
- **Phase 1 disposition:** The automated keyboard and axe checks remain regressions for new UI (S19). The manual screen-reader sign-off is not an S19 item unless decision D-12 adds it.
- **Title & Description:** Support keyboard/focus/resize and clear browser-permission failures.
- **Dependencies:** TASK-005, TASK-048, TASK-075, TASK-078.
- **Touched Files:** `apps/web/src/ui/StatusMessage.tsx`, `apps/web/src/style.css`, `tests/browser/accessibility.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `apps/web/src/App.tsx`, `apps/web/src/SerialConnect.tsx`, `apps/web/src/aar/Review.tsx`, `apps/web/src/ui/focus.ts`, `tests/focus.test.ts`, `package.json`, `package-lock.json`.
- **Interfaces / Contracts:** Keyboard controls versus instructor shortcuts; aria states; permission status.
- **DoD & Acceptance Criteria:** Core actions are keyboard accessible; restore focus after dialogs; no 390px overflow; permission denial never loops prompts; run an automated accessibility scan and a manual checklist.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `tests/focus.test.ts` and `tests/browser/accessibility.spec.ts` (2 PASS in Chromium) verify keyboard control navigation, dialog focus restoration, 390 px narrow-viewport layout without horizontal overflow, non-looping Web Serial permission denial, and zero unsuppressed axe violations. Remaining blockers: manual assistive screen-reader / physical hardware verification.

### TASK-081 — Session export

- **Status:** DONE — Codex; baseline 660d86e; 2026-10-16. Bounded checksummed archives, metadata redaction, and browser import/export.
- **Title & Description:** Export/import AAR with manifests and no secrets.
- **Dependencies:** TASK-076, TASK-077.
- **Touched Files:** `packages/aar/src/archive.ts`, `apps/web/src/aar/Export.tsx`, `apps/web/src/App.tsx`, `tests/aar-archive.test.ts`, `tests/browser/aar.spec.ts`, `packages/aar/package.json`, `apps/web/package.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Versioned archive; size/checksum limits; configurable key/serial-identifier redaction.
- **DoD & Acceptance Criteria:** Roundtrip export/import; reject archive bombs/oversized payloads/invalid hashes before allocation; no API keys/tokens in archives; show size and data categories.
- **Evidence:** Owner Codex; baseline 660d86e; 2026-10-16. `tests/aar-archive.test.ts` (2 PASS) and `tests/browser/aar.spec.ts` verify SHA-256 header+manifest+payload and per-record CRC validation, pre-allocation rejection of payloads exceeding `32` MiB or `4096`-byte metadata, API-key/serial-identifier redaction, and browser export/import roundtrip without replacing active flight state.

### TASK-082 — System acceptance matrix

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Hash-bound per-mode system matrix implemented; open dependencies (TASK-033, 073, 080) and unrun hardware/mode gates keep system acceptance blocked. TASK-051 is a version 2 proposal and is not a dependency. TASK-074, TASK-075, TASK-078, and TASK-079 are done and do not close this gate.
- **Phase 1 disposition:** Its tooling is reused; Phase 1 acceptance is TASK-188, TASK-189 and TASK-191 (S19). Its WASM, HITL and Windows rows are not Phase 1 gates.
- **Title & Description:** Exercise supported modes against all UI/physics/telemetry gates.
- **Dependencies:** TASK-033, TASK-042, TASK-043, TASK-047, TASK-059, TASK-073, TASK-074, TASK-075, TASK-078, TASK-079, TASK-080, TASK-081.
- **Touched Files:** `tests/integration/system-acceptance.test.ts`, `docs/validation/system-matrix.json`, `scripts/validate-release.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** G0..G4; device/mode/model/firmware/provider coverage.
- **DoD & Acceptance Criteria:** Every requirement has PASS/FAIL/BLOCKED/NOT_RUN evidence; unit tests do not establish 60/120 FPS or real 400/800/1200 Hz; missing WASM/HITL/Google coverage explicitly blocks the affected mode.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `scripts/validate-release.mjs`, `docs/validation/system-matrix.json`, and `tests/integration/system-acceptance.test.ts` verify per-mode `G0`–`G4` status aggregation (`test-results/laptop/system-report.json` exits 1, preserving observed `G2` model-validation `FAIL` and `G3` GPU frame-time `FAIL` separately from `NOT_RUN` hardware/mode gates). Dependencies `TASK-042`, `TASK-043`, `TASK-047`, `TASK-059`, `TASK-074`, `TASK-075`, and `TASK-081` are `DONE`; `TASK-033`, `TASK-073`, and `TASK-080` remain open. `TASK-051` is deferred to version 2 and is not a version 1 gate.

### TASK-083 — Release provenance and runbook

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Bounded artifact/license/hash inventory and recovery runbook implemented; blocked on TASK-082, dataset/artifact license review, and clean-machine verification.
- **Phase 1 disposition:** Its tooling is reused; Phase 1 delivery is TASK-190 (S01, S19). Its Windows and WASM release rows are not Phase 1 gates.
- **Title & Description:** Produce a verifiable release bundle and operational recovery instructions.
- **Dependencies:** TASK-003, TASK-082.
- **Touched Files:** `docs/operations/runbook.md`, `docs/operations/release-manifest.schema.json`, `scripts/release-manifest.mjs`, `tests/release-manifest.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `docs/ru/runbook.md`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Source/artifact/dataset/toolchain hashes; licenses; supported capability matrix.
- **DoD & Acceptance Criteria:** Verify clean-machine installation/build/startup; document rollback and owned-process cleanup; report actual blocked gates; never deploy/push automatically outside authorized scope.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `scripts/release-manifest.mjs`, `docs/operations/release-manifest.schema.json`, [runbook.md](operations/runbook.md), and `tests/release-manifest.test.ts` verify artifact/source/toolchain SHA-256 inventory and explicit `UNREVIEWED` license gating (`test-results/laptop/release-manifest.json` inventories 11 build files / `1,855,274` B and exits 1 while `TASK-082` and license/clean-machine reviews remain open).

## Physics fidelity program (Phases 7–13)

Registered on 2026-10-26 from the physics fidelity review of baseline `4593971`. Registration implements nothing. MirageSITL remains an external flight-dynamics model for ArduPilot: native runs use the JSON backend (TASK-041) and the browser build uses the HAL mailbox (TASK-046). ArduPilot's internal `SIM_Multicopter` and `SIM_Plane` models are not modified. The native firmware stays unmodified ([V2_PLAN.md](V2_PLAN.md), section 4, B1) except for the opt-in TASK-089 `imu-noise-floor` patch, recorded by the user's decision of 2026-10-26. New vehicle parameters belong in the vehicle manifest (TASK-087), not in new ArduPilot `SIM_*` parameters; that patch's two noise-floor parameters are the only exception. TASK-166 defines the on/off and intensity controls that every environment, sensor-error, EW and fault effect of the program must expose; it carries the effect-control request of 2026-10-27, which this branch first registered under the number TASK-124 that main already used. Streams may run in parallel where dependencies allow. Version 1 release gates (TASK-082, TASK-083) do not wait on these phases.

Measured starting point (review measurement, not a gate: 4-core Xeon 2.1 GHz, Rust 1.97.0 release, Node 22, scratch harnesses outside the repository; TASK-091 replaces it with a repository benchmark). One BET element costs about 110 ns natively. The production quad tick (28 strips × 8 azimuth samples × 2 evaluations per rotor) costs about 0.21 ms natively and 0.35 ms through the browser WASM adapters. An octocopter tick costs about 0.70 ms, above the G3 compute limit of 0.4167 ms at 1200 Hz. The RK4 body step costs 175 ns natively and 614 ns in WASM. Steady hover thrust from the production torque-source ESC fits `T/Tmax = (1−a)·d + a·d²` with `a ≈ 0.20`, against `a ≈ 0.87` for the unwired back-EMF `motor.rs` kernel and ArduPilot's default `MOT_THST_EXPO` of 0.65.

Acceptance tolerances are recorded in each task's contract before its comparison ([V2_PLAN.md](V2_PLAN.md), section 6, decision 4). Fields of a versioned interface that belong to a later task are fail-closed until that task lands: a neutral value is required, anything else is rejected.

## Phase 7: Physics Fidelity Foundations

Contracts, evidence and compute headroom that every later fidelity task builds on.

### TASK-087 — Vehicle model manifest v2

- **Status:** IN_PROGRESS — 2026-10-26; owner Claude; baseline `27e2a6a`; contract: [SPECS_SIMULATION_ENGINES.md](SPECS_SIMULATION_ENGINES.md), section "Vehicle manifest v2 and ArduPilot profile (TASK-087)". Failure criterion: a manifest that the validator admits but the v1 runtime or the profile silently reinterprets. Increment 1 is implemented: the strict v2 schema and validator (inertia realizability, cross-references, provenance, a quad X geometry check against the TASK-047 parity aircraft), lossless v1 migration, a fail-closed v1 projection, derived principal axes, `k_t` and CG-relative positions, ArduPilot profile v1 with evidenced names only, a hash-verified v1/v2 `VehicleRegistry` and an optional `SessionModelPort` for `model.load`. Evidence on Node 24.22.1: `npx --no-install vitest run tests/vehicle-manifest.test.ts` exit 0 with 21 tests; the oracles are two analytic eigenvalue references at 1e-12 relative, a hand-derived golden profile and exact round trips of `demo-quad.json`, `tilted-octo.json` and the parity base quad. With `tests/model-manifest.test.ts`, `fixtures.test.ts`, `session-v2.test.ts`, `control-v2.test.ts`, `bet-runtime.test.ts` and `documentation-policy.test.ts`: 7 files, 130 tests, exit 0. `npm run typecheck` exit 0; `npm run check:docs` exit 0. The changed files lint clean. `npm run lint` exits 1 only on two pre-existing errors in the untouched `scripts/check-gpu-perf.mjs`. Fixture `models/synthetic-quad-v2.json` (SHA-256 `9b9f6d07…c1498f`) is synthetic. Remaining: generate the native SITL `quad.parm` from a manifest, which changes the driver source identity and needs fresh TASK-042/043/059 captures; register models from an application path. Self-review fix: a `model.load` interrupted by `worker.dispose` built dynamics that nobody disposed; a disposed session now builds nothing and the load ends with `BAD_STATE`. After the fix, `tests/vehicle-manifest.test.ts` passes 22 tests, and `control-v2`, `session-v2`, `scenario-runner` and `ew-pipeline` pass 98 tests in 4 files; `npm run typecheck` exit 0.
- **Phase 1 disposition:** Required (S03, S04, S08, S15). TASK-135 landed increment 1 of each; the remaining increments continue here.
- **Title & Description:** Define one validated, versioned vehicle description ([V2_PLAN.md](V2_PLAN.md) workstream C): mass properties, rotors, motors and ESCs, battery, airframe drag, control surfaces, landing gear, sensor mounts and rotor wake pairs, with provenance per dataset, a v1 migration, derived values and an ArduPilot parameter profile.
- **Dependencies:** TASK-006, TASK-033.
- **Touched Files:** `packages/physics/src/vehicle.schema.json`, `packages/physics/src/vehicle-manifest.ts`, `packages/physics/src/ardupilot-profile.ts`, `packages/physics/package.json`, `packages/physics/src/session-v2.ts`, `scripts/sitl/driver.mjs`, `tests/vehicle-manifest.test.ts`, `tests/fixtures/models/synthetic-quad-v2.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `schemaVersion: 2` vehicle manifest validated from `unknown` by a strict JSON Schema plus physical checks; SI units, FRD/NED, wxyz quaternions; mass, CG offset from the body reference point and inertia about the CG; derived principal axes and motor `k_t = 60/(2π·KV)`; per-dataset provenance (`measured` or `synthetic`, SHA-256); `migrateModelManifestV1`; deterministic ArduPilot `.parm` profile; the session model registry admits v1 and v2 manifests for `model.load`.
- **DoD & Acceptance Criteria:** v1 fixtures migrate losslessly (mass, inertia and rotors identical); rejection fixtures cover unknown keys, units, non-SPD inertia, duplicate IDs and channels, unnormalized quaternions and out-of-envelope values; derived principal moments match an analytic reference within 1e-12 relative; the parameter profile is byte-identical to a golden output and uses only parameter names with repository evidence; `model.load` admits a hashed v2 model; the default demo backend is unchanged.

### TASK-088 — Rotor and body interface v2

- **Status:** IN_PROGRESS — 2026-10-26; owner Claude; baseline `27e2a6a`; contract: [SPECS_SIMULATION_ENGINES.md](SPECS_SIMULATION_ENGINES.md), section "Step interfaces v2 (TASK-088)". Failure criterion: a neutral v2 record whose physics differs from v1, or a later-task field that is silently ignored. Increment 1 is implemented: 256-byte bound-rotor input and output records on v1 arenas, and a 448-byte body input with a 256-byte output. They carry version words, reserved-zero words and validity bits, and later-task fields are fail-closed with status −8: ESC duty and bus voltage (TASK-092), external wake (TASK-101), ground plane (TASK-100), gravity model (TASK-108), CG offset (TASK-094) and mass-property rates (TASK-119). The body specific force F/m is valid now. Exports and C declarations are added, plus TS adapters, Python-packed golden records and a native reference example. `native/bet/examples/interface_v2_reference.rs` and `tests/fixtures/wasm-abi/generate.py` joined Touched Files for the native-versus-WASM reference and the independent fixture generator. Evidence: `cargo test --manifest-path native/Cargo.toml --workspace --locked` exit 0, 23 suites and 72 tests. That includes `bound_v2` and `body_abi_v2`: bitwise v1 equality over 2000 steps, 16 rotor and 19 body rejection records that leave state and output unchanged, and zero allocator calls and bytes over 10^6 steps. The wasm32 check exits 0. `npx --no-install vitest run tests/wasm-abi-v2.test.ts` exit 0 with 11 tests on scalar and SIMD128 WASM: spec layouts equal the golden layouts with full byte coverage; neutral v2 equals v1 bitwise; native versus WASM within 1e-12 (largest 8.5e-14 for the rotor, with force and moment components relative to their vector norm, and 8.4e-16 for the body); adapters write the golden records; the fixture statuses hold; and 10^6 steps run without allocation traps or memory growth. `npm run typecheck` and `npm run check:docs` exit 0; the changed files lint clean. `bet-abi-v1.json` regenerates byte-identically. Remaining: JS-side GC probes for the v2 adapters in `scripts/check-bet-runtime.mjs --allocation`, and moving `BetFlightDynamics` onto v2 when a later task needs a new field.
- **Phase 1 disposition:** Required (S03, S04, S08, S15). TASK-135 landed increment 1 of each; the remaining increments continue here.
- **Title & Description:** Extend the bound-rotor and rigid-body byte interfaces once for the Phase 8–10 inputs and outputs (ESC duty, bus voltage, ground plane, external wake velocity, inflow states, electrical outputs, CG offset, mass-property rates, gravity model), keeping v1 as a regression API.
- **Dependencies:** TASK-018, TASK-028, TASK-033, TASK-087.
- **Touched Files:** `native/bet/src/bound_v2.rs`, `native/bet/src/body_abi_v2.rs`, `native/bet/src/lib.rs`, `native/bet/include/bet_bound.h`, `native/bet/tests/bound_v2.rs`, `native/bet/tests/body_abi_v2.rs`, `native/bet/examples/interface_v2_reference.rs`, `packages/wasm-bet/src/rotor-v2.ts`, `packages/wasm-bet/src/body-v2.ts`, `packages/wasm-bet/package.json`, `tests/wasm-abi-v2.test.ts`, `tests/fixtures/wasm-abi/interface-v2.json`, `tests/fixtures/wasm-abi/generate.py`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Little-endian fixed records with explicit offsets and reserved-zero words; version words checked; fields owned by later tasks are fail-closed (neutral value required, otherwise an unsupported status) until their owning task lands; outputs carry validity bits for unavailable quantities; no `memory.grow` after arming; native, scalar WASM and SIMD128 WASM agree.
- **DoD & Acceptance Criteria:** Byte-offset tables in the engine spec match golden byte fixtures; v1 and v2 produce identical physics for neutral v2 inputs (bitwise on scalar WASM, ≤1e-12 relative native versus WASM); rejection tests cover version, length, reserved bytes, non-finite, out-of-range and unsupported fields; G1 allocation probes stay at zero calls and bytes over 1e6 steps.

### TASK-089 — Autopilot boundary v2 and sensor-error ownership

- **Status:** IN_PROGRESS — 2026-10-26; owner Claude; baseline `27e2a6a`; contract: [SPECS_SIMULATION_ENGINES.md](SPECS_SIMULATION_ENGINES.md), section "Sensor-error ownership (TASK-089)". Failure criterion: an error applied twice, or by nobody without a declaration, or ownership that rests on an unverified parameter, key or delivery path. Increment 1 is implemented: the pinned-source catalog, generated by `tests/fixtures/sitl/generate.py` from 13 files at `8ab6afde…` (323 SIM parameters, 36 JSON keys, 30 asserted source facts; `json-protocol.json` regenerates byte-identically); the 25-source ownership taxonomy with neutral values; matrix validation; and the neutralizing parameter profile. `tests/fixtures/sitl/ardupilot-catalog.json` joined Touched Files because the catalog is its own generated artifact. Findings from the pinned source: the IMU backend's accelerometer (0.01 m/s²) and gyro (radians(0.04)) noise floors are unconditional, so changing their owner needs a native firmware patch (BLOCKED_DECISION until the 2026-10-26 decision below); the browser HAL bypasses the aircraft model's magnetic anomaly and motor terms. Evidence on Node 24.22.1: `npx --no-install vitest run tests/error-ownership.test.ts` exit 0 with 11 tests. The TASK-059 profile holds exactly the native driver's experiment parameters, and the parity profiles are empty. With `tests/fixtures.test.ts` and `tests/ardupilot-json.test.ts`: 27 tests, exit 0. `npm run typecheck` and `npm run check:docs` exit 0; the changed files lint clean. Remaining: HAL payload v2 with byte fixtures and the TASK-046 browser check; oracle tests for optional JSON keys; airspeed and rangefinder sources; profile wiring in `external-sitl.ts`, `wasm-sitl.ts` and the native driver; and a TASK-047 parity rerun after any delivery change. Increment 2 follows the user's decision of 2026-10-26: ArduPilot defaults stay the default, and a setting switches off ArduPilot's fixed IMU noise floors. Increment 2 contents:
- **Phase 1 disposition:** Required (S03, S04, S08, S15). TASK-135 landed increment 1 of each; the remaining increments continue here.
  - `native/ardupilot/patches/imu-noise-floor.patch` (`7a43d2ed…`) adds `SIM_ACC_FLOOR` (0.01 m/s/s) and `SIM_GYR_FLOOR` (0.04 deg/s), whose defaults are the upstream constants.
  - Catalog schema 2 records the patch applied strictly to the pinned sources, plus 31 facts.
  - Ownership matrix schema 2 declares `firmwarePatches`, admitted on `native-json` only.
  - New code: `imuNoiseFloorMatrix`, `scripts/ownership-profile.mjs --imu-noise-floor ardupilot|off`, `scripts/build-ardupilot-sitl.mjs` and `scripts/check-imu-noise-floor.mjs`.

  These files, `native/ardupilot/patches/`, `tests/imu-noise-floor.test.ts` and the `test-results/validation/task-089-imu-floor-*.json` reports joined Touched Files to build, select and verify the patch. `CLAUDE.md` and `docs/ru/CLAUDE.md` also joined, because they record the decision, as did `docs/operations/runbook.md` and `docs/ru/runbook.md` for the operator procedure.

  Evidence: the pinned ArduCopter SITL was built here (upstream ELF `b54bef09…`; patched ELF `06846b05…` built by the script with GCC 13.3.0) and flown with the unchanged driver on Node 24.22.1 and pymavlink 2.4.50.
  - With default parameters, the patched firmware matched upstream bit for bit over all 27,362 `HIGHRES_IMU` samples in that pair.
  - With the floors off, the disarmed residual standard deviation falls from 6.05e-4 m/s² and 4.78e-5 rad/s to at most 1.2e-6 m/s² and 8.1e-8 rad/s. The limits were set before measurement.
  - Upstream firmware given the `off` lines keeps its floors, because it skips unknown defaults silently. This negative control fails as it should.
  - Both patched flights pass the TASK-042 raw and flight audits.
  - `npx --no-install vitest run tests/error-ownership.test.ts tests/imu-noise-floor.test.ts tests/fixtures.test.ts tests/ardupilot-json.test.ts` exits 0 with 37 tests in 4 files, and the regenerated fixtures match their registered hashes.

  Increment 3 follows the user's decision of 2026-10-27: the native harness reads the setting, and the user accepts the resulting TASK-059 re-freeze.
  - `scripts/run-sitl.mjs` accepts `MIRAGE_SITL_IMU_NOISE_FLOOR` unset (`ardupilot`) or `off` and records it in its report.
  - With `off`, `scripts/sitl/driver.mjs` appends the validated profile to `quad.parm` and reads both parameters back through `scripts/sitl/telemetry.py`. It holds arming until PARAM_VALUE reports 0 for both and otherwise fails 20 s into the simulation. Default runs send nothing new.
  - `scripts/sitl/check-raw.py` includes the read-back PARAM_VALUE frames that `run.json` declares. The analyzer's `--reference` compares samples until the first driver command.

  These four scripts joined Touched Files to apply and audit the setting.

  Evidence (2026-10-27, `node scripts/run-sitl.mjs`):
  - Upstream with the default setting and patched with `off` both PASS.
  - The `off` flight reports `SIM_ACC_FLOOR 0` and `SIM_GYR_FLOOR 0`, arms at 42.25 s, and passes the floor analysis and the TASK-042 raw and flight audits.
  - Upstream with `off` fails closed at 20 s without arming.
  - Patched with defaults matches upstream on all 13,082 samples before the first command. MAVLink command timing differs by up to 52 ms between runs, so the earlier whole-flight identity is not guaranteed.
  - `npx --no-install vitest run tests/imu-noise-floor.test.ts tests/error-ownership.test.ts tests/vehicle-manifest.test.ts tests/evidence-tools.test.ts tests/sitl-flight-trace.test.ts tests/integration/ew-sitl.test.ts tests/sitl-ew.test.ts` exits 0 with 52 tests in 7 files.

  Remaining for the switch:
  - Apply the patch in the browser HAL build, with the TASK-046 checks.
  - Re-freeze TASK-059 with the current driver on the operator's machine; until then `report-ekf.mjs` rejects new EW validation captures.
  - Re-run `check-raw.py` on earlier TASK-042/043 captures to refresh their audits.
- **Title & Description:** Decide, per sensor and error source, whether MirageSITL or ArduPilot's SITL sensor backends add each error, and deliver the required fields through the JSON line, the browser HAL mailbox and MAVLink injection ([V2_PLAN.md](V2_PLAN.md) B1). Upstream firmware is the default. The one recorded firmware patch (decision 2026-10-26) only switches off ArduPilot's fixed IMU noise floors on request.
- **Dependencies:** TASK-041, TASK-046, TASK-047, TASK-059, TASK-087.
- **Touched Files:** `packages/autopilot/src/error-ownership.ts`, `packages/autopilot/package.json`, `tests/error-ownership.test.ts`, `tests/fixtures/sitl/error-ownership.json`, `tests/fixtures/sitl/ardupilot-catalog.json`, `tests/fixtures/registry.json`, `packages/autopilot/src/external-sitl.ts`, `packages/autopilot/src/wasm-sitl.ts`, `native/ardupilot/hal/browser_hal.h`, `native/ardupilot/hal/browser_hal.cpp`, `native/ardupilot/hal/sitl-state.patch`, `tests/fixtures/sitl/generate.py`, `tests/ardupilot-json.test.ts`, `native/ardupilot/patches/imu-noise-floor.patch`, `scripts/build-ardupilot-sitl.mjs`, `scripts/ownership-profile.mjs`, `scripts/check-imu-noise-floor.mjs`, `scripts/run-sitl.mjs`, `scripts/sitl/driver.mjs`, `scripts/sitl/telemetry.py`, `scripts/sitl/check-raw.py`, `tests/imu-noise-floor.test.ts`, `test-results/validation/task-089-imu-floor-*.json`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Versioned ownership matrix (error source → owner, delivery path, ArduPilot parameters to neutralize, and from schema 2 the firmware patches of the target build). Only delivery paths with repository evidence are admissible: JSON keys covered by the TASK-041 oracle, HAL payload fields in `browser_hal.h`, and `GPS1_TYPE 14` MAVLink injection from TASK-059. Optional upstream JSON keys and `SIM_*` parameter names need a catalog generated from the hash-pinned ArduPilot source. A native firmware patch needs a recorded decision; the 2026-10-26 decision admits only `imu-noise-floor`, whose defaults reproduce upstream and which is admitted only on paths whose builds apply it.
- **DoD & Acceptance Criteria:**
  - Matrix validation rejects double ownership, missing delivery paths and unverified parameter names.
  - The generated parameter profile neutralizes exactly the ArduPilot error sources MirageSITL owns.
  - The IMU noise-floor setting defaults to ArduPilot behaviour, and its `off` value removes both floors in a real capture on every path it is admitted for.
  - Patched firmware on defaults stays bit-identical to upstream.
  - Any runner that applies `off` confirms the values by read-back.
  - Any HAL payload v2 has byte fixtures and passes the TASK-046 browser check.
  - TASK-047 native/browser parity passes again after the change.

### TASK-090 — Fidelity evidence pipeline

- **Status:** IN_PROGRESS — 2026-10-26; owner Claude; baseline `27e2a6a`; contract: [SPECS_SIMULATION_ENGINES.md](SPECS_SIMULATION_ENGINES.md), section "Fidelity evidence pipeline (TASK-090)". Failure criterion: any path that turns synthetic or unhashed data into PASS, or a metric that disagrees with its analytic oracle. Increment 1 is implemented: RMS, bias and Theil metrics; a radix-2 FFT and Welch H1 response with coherence; the CIFER-style cost with W_γ = [1.58(1 − e^(−γ²))]², W_p = 0.01745 and the J ≤ 100 guideline as a ceiling; bench CSV v1 import to CT, CQ, CP and FM with ISA density correction and consistency flags; capture schema v1; and `scripts/check-fidelity.mjs` on the shared evidence helper. Evidence on Node 24.22.1: `npx --no-install vitest run tests/fidelity-metrics.test.ts tests/bench-import.test.ts` exit 0 with 20 tests. The oracles are a direct DFT (1e-12), a time-domain IIR filter against its analytic response (1e-12 relative), a pure delay (1e-9°), the coherence of a known signal-to-noise ratio (0.5 ± 0.03, a 5σ bound), analytic J for gain, phase and coherence-weighted mismatches (1e-9) and an analytic Theil coefficient. `node scripts/check-fidelity.mjs` exit 2 (BLOCKED_EXTERNAL). The analytic capture `validation/fidelity-synthetic-capture.json` (SHA-256 `74e2c16d…91b2a7`, with `validation/bench-synthetic.csv`, `191082c4…dbfbb0`) exits 2 with J = 19.950 = 20·W_γ(1). Malformed, unhashed or over-permissive variants exit 1. `tests/fixtures.test.ts`, `npm run typecheck` and `npm run check:docs` exit 0; the changed files lint clean. Remaining, and required for DONE (G4): one real ArduCopter SYSTEMID flight capture and one real thrust-stand file. Also remaining: DataFlash conversion to capture v1 and the simulation replay that produces the simulated series.
- **Phase 1 disposition:** Required (S03, S04, S08, S15). TASK-135 landed increment 1 of each; the remaining increments continue here.
- **Title & Description:** Score model changes against measured data: time-domain log-replay metrics, frequency-response identification from ArduCopter SYSTEMID chirps, and component bench data import ([V2_PLAN.md](V2_PLAN.md) B3), using the repository's evidence and exit-code conventions.
- **Dependencies:** TASK-033, TASK-087.
- **Touched Files:** `packages/physics/src/fidelity-metrics.ts`, `packages/physics/src/bench-import.ts`, `packages/physics/package.json`, `scripts/check-fidelity.mjs`, `tests/fidelity-metrics.test.ts`, `tests/bench-import.test.ts`, `tests/fixtures/validation/fidelity-synthetic-capture.json`, `tests/fixtures/validation/bench-synthetic.csv`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/V2_PLAN.md`, `docs/ru/V2_PLAN.md`.
- **Interfaces / Contracts:** `scripts/check-fidelity.mjs --input PATH --sha256 HEX` (exit 0 PASS, 1 FAIL or invalid evidence, 2 BLOCKED_EXTERNAL); capture schema v1 with provenance; metrics: RMS, bias, Theil inequality coefficient, Welch H1 frequency response with coherence, cost `J = (20/n)·Σ W_γ·[(Δ|H|_dB)² + 0.01745·(Δ∠H_deg)²]` against a declared limit (guideline 100); bench CSV v1 to CT/CP versus RPM with density correction and consistency flags.
- **DoD & Acceptance Criteria:** Synthetic oracles recover known transfer functions within declared tolerances and known mismatches give the analytic J; malformed or unhashed input fails; missing measured data reports BLOCKED_EXTERNAL, never PASS; at least one real flight capture and one real bench file are scored before the task is DONE (G4).

### TASK-091 — BET kernel performance headroom

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required for real-time 16-motor runs (S10, S19): the review measured an octocopter tick at about 0.70 ms against the 0.4167 ms G3 compute limit at 1200 Hz.
- **Title & Description:** Cut the production rotor tick cost at least 5× with results unchanged within a pre-declared tolerance, so later fidelity fits the G3 budget.
- **Dependencies:** TASK-014, TASK-033.
- **Touched Files:** `native/bet/src/blade.rs`, `native/bet/src/polar.rs`, `native/bet/src/bound.rs`, `native/bet/src/lib.rs`, `native/bet/tests/blade.rs`, `native/bet/tests/polar.rs`, `native/bet/tests/bound.rs`, `scripts/check-bet-runtime.mjs`, `docs/benchmarks/schema.json`, `test-results/bench/bet.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** O(1) polar indexing on uniform and logarithmic axes with interleaved coefficient cells and a precomputed confidence bitmask; precomputed element constants; duplicate square root and `rem_euclid` removed; optional single-evaluation predictor; regime-dependent azimuth sampling with hysteresis and a validity flag; SIMD128 across strips; the current kernel kept as the scalar reference.
- **DoD & Acceptance Criteria:** Tolerance declared before implementation and met on all TASK-033 suites; SIMD tails 1/3/5/63 and the scalar fallback pass; a repository benchmark reports p50/p99 per tick at 400/800/1200 Hz and shows at least 5× lower cost than the recorded baseline; octocopter compute p99 ≤ 0.4167 ms at 1200 Hz (G3); G1 allocation gates unchanged.

## Phase 8: Core Flight Dynamics

Wire the kernels that already exist into the flight path and make the body, contact and wind consistent.

### TASK-092 — Electromechanical drive in the production step

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S06): the production motor, ESC and battery bus.
- **Title & Description:** Replace the ideal torque-source ESC in `BetFlightDynamics` with the voltage-driven motor, ESC and shared battery bus from `motor.rs` and `battery.rs`, including signed braking torque, so throttle-to-thrust curves and battery sag become physical.
- **Dependencies:** TASK-025, TASK-026, TASK-087, TASK-088, TASK-089.
- **Touched Files:** `native/bet/src/motor.rs`, `native/bet/src/battery.rs`, `native/bet/src/shaft.rs`, `native/bet/src/bound_v2.rs`, `native/bet/tests/motor.rs`, `native/bet/tests/battery.rs`, `native/bet/tests/drive.rs`, `packages/physics/src/bet-dynamics.ts`, `packages/physics/src/ardupilot-profile.ts`, `packages/autopilot/src/wasm-sitl.ts`, `packages/autopilot/src/external-sitl.ts`, `tests/drive-chain.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** ESC duty with a first-order lag and update-rate hold; `i = (d·V_bus − k_e·Ω)/R` clamped to `[−I_brake, I_max]`; `τ = k_t·i − τ₀`; shared bus solved per tick with a documented iteration or one-tick lag; the shaft accepts signed motor torque; battery voltage and current published in `FlightState` and delivered through the HAL and TASK-089 paths; the profile sets `BATT_*`, `MOT_BAT_VOLT_*` and a fitted `MOT_THST_EXPO`.
- **DoD & Acceptance Criteria:** Steady thrust-versus-duty curvature matches thrust-stand data within the declared tolerance (the review probe gives `a ≈ 0.87` for a synthetic 600 KV case versus 0.20 today); energy balance closes within 1e-9 relative; power-cut faults follow the physical path; ArduCopter hovers in both paths with nonzero battery current; G1 gates pass.

### TASK-093 — Weather and atmosphere plumbing

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S07): weather and atmosphere in sessions.
- **Title & Description:** Make wind and atmospheric state real inputs of every flight path: implement `weather.set`, recompute ISA with temperature offset and QNH every tick, and evaluate wind at the CG and each rotor hub.
- **Dependencies:** TASK-010, TASK-032, TASK-087.
- **Touched Files:** `packages/physics/src/session-v2.ts`, `packages/physics/src/bet-dynamics.ts`, `packages/physics/src/atmosphere.ts`, `packages/protocol/src/control-v2.ts`, `packages/autopilot/src/external-sitl.ts`, `tests/session-v2.test.ts`, `tests/atmosphere.test.ts`, `tests/weather-plumbing.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `weather.set` applied at tick boundaries with acknowledgements instead of `unsupportedReason`; `T = T₀ + ΔT − L·h`, `p = p₀·(1 − L·h/T₀′)^(g/(R·L))`, `ρ = p/(R·T)`; `BetFlightDynamics` reads density, viscosity and speed of sound per tick; true airspeed relative to the air; `velocity_wind` in the JSON line. At the pinned commit `SIM_JSON` derives airspeed from ground velocity unless the JSON line carries `airspeed`, and applies `velocity_wind` only after that, so the native path also sends `airspeed` once the TASK-089 oracle covers that key.
- **DoD & Acceptance Criteria:** Scheduled weather changes apply on the exact tick in every epoch; ISA references within 1e-9 relative; constant-wind flight shows the expected ground-speed offset and airspeed; replay is seed- and FPS-independent; no allocation in the tick.

### TASK-094 — Rigid-body core v2

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S03, S18): CG offsets and the full inertia tensor, and the base of TASK-095.
- **Title & Description:** Generalize the 6-DOF core for CG offsets, time-varying mass properties and optional Earth-rotation terms, and make Rapier-owned sessions keep the full inertia tensor.
- **Dependencies:** TASK-028, TASK-029, TASK-088.
- **Touched Files:** `native/bet/src/rigid_body.rs`, `native/bet/src/body_abi_v2.rs`, `native/bet/tests/rigid_body.rs`, `packages/wasm-bet/src/body-v2.ts`, `native/contact/src/contact.rs`, `native/contact/tests/contact.rs`, `packages/physics/src/ground-contact.ts`, `tests/rigid-body-v2.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Equations of motion about a body reference point with CG offset: `m·(a_O + ω̇×r_c + ω×(ω×r_c)) = F` and `I_O·ω̇ + İ_O·ω + ω×(I_O·ω) + m·r_c×a_O = M_O`; optional `v̇ = R·f + g(φ,h) − (2·ω_ie + ω_en)×v`; documented rotor-coupling error budget against the 4800 Hz reference with an optional two-evaluation variant; Rapier mass properties in a principal-axis frame.
- **DoD & Acceptance Criteria:** Analytic CG-offset, torque-free precession and inertia-coupling fixtures pass within declared tolerances; zero-offset v2 matches v1 bitwise; Rapier sessions with products of inertia match RK4 within the declared budget; G1 gates pass.

### TASK-095 — Compliant ground contact in flight sessions

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S18): compliant contact in flight sessions. The NASA comparison stays deferred.
- **Title & Description:** Replace the attitude-resetting synthetic pad and the inelastic floor with compliant Rapier contact on published terrain for takeoff, landing and ground handling.
- **Dependencies:** TASK-029, TASK-065, TASK-087, TASK-094.
- **Touched Files:** `native/contact/src/contact.rs`, `native/contact/src/lib.rs`, `native/contact/tests/contact.rs`, `packages/physics/src/ground-contact.ts`, `packages/physics/src/terrain-contact.ts`, `packages/physics/src/bet-dynamics.ts`, `scripts/build-contact.mjs`, `scripts/sitl/quad.mjs`, `tests/flight-contact.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Compound airframe hull (capsules, boxes, skids); implicit spring-dampers with effective stiffness `k + c/dt`; static friction below breakaway and Coulomb friction above; brush-model tire side force `F_y = C_α·tan α` capped at `μ·N`; propeller-strike events; the contact backend owns integration; missing ground still pauses stepping.
- **DoD & Acceptance Criteria:** Drop, slope-hold and sideslip fixtures pass declared tolerances at 400/800/1200 Hz without rate-dependent peak acceleration; ArduCopter takes off and lands in both paths without an attitude reset; the deferred NASA drop comparison is rerun only after an explicit user decision; G1 gates pass.

### TASK-096 — Multirotor airframe aerodynamics

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S05): body drag. Its measured-data comparisons follow decision D-11.
- **Title & Description:** Add body and arm drag, lift and moments so forward speed, lean angle, wind estimation and EKF3 drag-based dead reckoning behave realistically.
- **Dependencies:** TASK-087, TASK-093.
- **Touched Files:** `native/bet/src/airframe.rs`, `native/bet/src/lib.rs`, `native/bet/tests/airframe.rs`, `packages/physics/src/bet-dynamics.ts`, `packages/physics/src/vehicle.schema.json`, `tests/airframe-drag.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `F = −½·ρ·|v_a|·(C_D·A)_b·v_a` with a fitted drag-area tensor or a direction-dependent table; body lift and side force; moments from the center-of-pressure offset; manifest `airframe.drag` block with provenance; rotor momentum drag from BET checked, not duplicated.
- **DoD & Acceptance Criteria:** Analytic drag fixtures pass; trimmed forward-flight lean angles match a reference within the declared tolerance; EKF3 drag fusion (`EK3_DRAG_BCOEF_X/Y`, `EK3_DRAG_MCOEF`) converges in SITL with calibration-consistent values; no allocation in the tick.

## Phase 9: Advanced Rotor Aerodynamics

Rotor fidelity in hover, edgewise flight, descent and near the ground.

### TASK-097 — Full-range airfoil polars

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S05): full-range polars. Its measured-data comparisons follow decision D-11.
- **Title & Description:** Provide physically plausible section coefficients at any angle of attack, Reynolds number and Mach number instead of clamping beyond the ±30° NeuralFoil range.
- **Dependencies:** TASK-019, TASK-033, TASK-091.
- **Touched Files:** `tests/fixtures/polars/generate_extended.py`, `tests/fixtures/polars/naca6409-extended.json`, `packages/wasm-bet/src/rotor.ts`, `native/bet/src/polar.rs`, `native/bet/tests/polar.rs`, `tests/polar-extension.test.ts`, `tests/fixtures/registry.json`, `scripts/validate-models.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Viterna–Corrigan extension to ±180° (`C_D = C_Dmax·sin²α + B₂·cos α`, `C_L = ½·C_Dmax·sin 2α + A₂·cos²α/sin α`); reverse-flow mapping; Prandtl–Glauert or Kármán–Tsien compressibility to about M 0.7 with drag rise; low-Re coverage to 1e4; Snel rotational augmentation `ΔC_L = 3·(c/r)²·(C_L,inv − C_L)`; C¹ blending; a real Mach axis in `parseNeuralFoilPolar`; hashed provenance per table.
- **DoD & Acceptance Criteria:** Continuity and limit fixtures pass (flat-plate behavior near 90°, no force jumps); the UIUC comparison is rerun and its result recorded against the declared target; the `polar.rs` API is unchanged and allocation-free.

### TASK-098 — Inflow v2: annular, tip loss, edgewise and dynamic inflow

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S05): inflow v2. Its measured-data comparisons follow decision D-11.
- **Title & Description:** Replace uniform axial inflow with a fixed 0.1 s lag by an inflow model that is valid in edgewise flight, includes tip and hub losses, and has the physical millisecond time scale.
- **Dependencies:** TASK-021, TASK-088, TASK-091, TASK-097.
- **Touched Files:** `native/bet/src/inflow.rs`, `native/bet/src/blade.rs`, `native/bet/src/bound_v2.rs`, `native/bet/tests/inflow.rs`, `native/bet/tests/dynamic_inflow.rs`, `packages/wasm-bet/src/rotor-v2.ts`, `tests/fixtures/rotors/dynamic-inflow.json`, `tests/fixtures/registry.json`, `scripts/validate-models.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Annular momentum with the Prandtl factor F (at most four warm-started Newton iterations); Glauert `λ = μ·tan α_d + C_T/(2·√(μ² + λ²))`; Pitt–Peters three-state dynamic inflow `[M]·λ̇ + [L(χ)]⁻¹·λ = [C_T, C_L, C_M]ᵀ` with `M = diag(128/75π, 16/45π, 16/45π)` and `λ(r,ψ) = λ₀ + (r/R)·(λs·sinψ + λc·cosψ)`; derived time scale `τ ≈ M·R/(4·v_i)`; manual `inflowTauS` overrides flagged synthetic.
- **DoD & Acceptance Criteria:** Hover momentum residual ≤1%; edgewise and climb fixtures match annular BEM references within declared tolerances; the inflow step-response time constant is within 10% of the analytic value; the UIUC rerun is recorded; iteration-cap failures are flagged, never silent; G1 gates pass.

### TASK-099 — Vortex ring state, windmill brake and descent inflow

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S05): descent regimes. Its measured-data comparisons follow decision D-11.
- **Title & Description:** Model induced velocity and thrust in descent, where the current momentum root is invalid and only flagged ([V2_PLAN.md](V2_PLAN.md) B5).
- **Dependencies:** TASK-098.
- **Touched Files:** `native/bet/src/inflow.rs`, `native/bet/tests/descent_inflow.rs`, `tests/fixtures/rotors/descent-inflow.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Empirical induced-velocity curve over `−2 ≤ V_c/v_h ≤ 0`; windmill-brake branch `v_i = −V_c/2 − √((V_c/2)² − v_h²)`; VRS boundary in `(V_x/v_h, V_c/v_h)`; seeded band-limited thrust fluctuation and roll-damping loss inside it; branch selection with hysteresis; regions without data keep `ModelOutsideValidity`.
- **DoD & Acceptance Criteria:** Induced velocity is continuous across branches; the curve reproduces its source data within the declared tolerance; fluctuations replay identically for one seed; descent flight data are compared before DONE.

### TASK-100 — Rotor ground effect

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S05): ground effect. Its measured-data comparisons follow decision D-11.
- **Title & Description:** Reproduce the near-ground thrust gain and power drop that drive takeoff, landing and the land detector, off by default ([V2_PLAN.md](V2_PLAN.md) B8).
- **Dependencies:** TASK-065, TASK-088, TASK-095, TASK-098.
- **Touched Files:** `native/bet/src/ground_effect.rs`, `native/bet/src/inflow.rs`, `native/bet/src/lib.rs`, `native/bet/tests/ground_effect.rs`, `packages/physics/src/terrain-contact.ts`, `packages/physics/src/bet-dynamics.ts`, `tests/rotor-ground-effect.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Per-rotor height along the hub axis to the local terrain plane; induced-velocity factor `κ = 1 − (R/4z)²/(1 + (V_t/v_i)²)`, valid for `z/R ≳ 0.5` and flagged below; multirotor neighbor terms (Sanchez-Cuevas et al., 2017); image method for tilted disks; the terrain coupler samples one plane per hub.
- **DoD & Acceptance Criteria:** Thrust-ratio fixtures match the closed form within 1e-9; hover-height sweep data or precision-landing logs are compared within the declared tolerance; the disabled mode is bitwise identical to TASK-098.

### TASK-101 — Rotor–rotor and rotor–airframe interference

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S05) for coaxial pairs; the task also covers rear-rotor and airframe interference. Its measured-data comparisons follow decision D-11.
- **Title & Description:** Account for wakes that reach other rotors (coaxial stacks, rear rotors in forward flight) and the airframe (download), generalizing the coaxial reference ([V2_PLAN.md](V2_PLAN.md) B6).
- **Dependencies:** TASK-024, TASK-088, TASK-096, TASK-098.
- **Touched Files:** `native/bet/src/wake.rs`, `native/bet/src/coaxial.rs`, `native/bet/src/lib.rs`, `native/bet/tests/wake.rs`, `packages/physics/src/bet-dynamics.ts`, `packages/physics/src/vehicle.schema.json`, `tests/rotor-interference.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Per-rotor slipstream with contraction `R_w = R·√((V + v_i)/(V + 2·v_i))`, far-wake speed about `V + 2·v_i`, wake-angle skew and spreading; the receiver adds the area-averaged wake velocity exactly once; download `F = ½·ρ·u_w²·C_D·A_washed`; overlapping pairs precomputed at configuration; manifest wake-pair declarations.
- **DoD & Acceptance Criteria:** Momentum and energy budgets close; disabled coupling is bitwise identical; coaxial and forward-flight fixtures match declared references; pair ordering is deterministic; G1 gates pass.

### TASK-102 — Blade-by-blade rotor mode

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: not required by S01–S19 (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Track individual blades in time so once-per-revolution and blade-passing loads, rotor imbalance and two-blade gyroscopic anisotropy exist as the source for vibration synthesis.
- **Dependencies:** TASK-023, TASK-088, TASK-091, TASK-098.
- **Touched Files:** `native/bet/src/blade.rs`, `native/bet/src/bound_v2.rs`, `native/bet/src/momentum.rs`, `native/bet/tests/azimuth_resolved.rs`, `packages/wasm-bet/src/rotor-v2.ts`, `tests/azimuth-resolved.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Azimuth state `ψ̇ = s·Ω`; blades evaluated at `ψ_b = ψ + 2πb/B`; static imbalance `F = m_u·r_u·Ω²` rotating with the blades plus a couple; two-blade transverse inertia in the hub angular momentum; harmonic outputs (amplitude and phase of the once-per-revolution, blade-passing and electrical orders) in a preallocated buffer; manifest imbalance, blade inertia and motor pole pairs.
- **DoD & Acceptance Criteria:** Averaged loads equal the azimuth-averaged mode within the declared tolerance; imbalance force and the two-per-revolution gyroscopic moment match analytic fixtures; accelerometer spectra are compared with measured data before DONE; compute cost is recorded against the G3 budget.

### TASK-103 — Rotor lookup-table mode

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Optional (S04): TASK-145 may use the table mode for measured combinations.
- **Title & Description:** Provide a validated fast rotor model from tables for faster-than-real-time regression and for measured or external-solver data ([V2_PLAN.md](V2_PLAN.md) B4).
- **Dependencies:** TASK-090, TASK-097, TASK-098.
- **Touched Files:** `native/bet/src/rotor_map.rs`, `native/bet/src/lib.rs`, `native/bet/tests/rotor_map.rs`, `scripts/generate-rotor-map.mjs`, `packages/wasm-bet/src/rotor-v2.ts`, `tests/rotor-map.test.ts`, `tests/fixtures/rotors/rotor-map-synthetic.json`, `tests/fixtures/registry.json`, `docs/V2_PLAN.md`, `docs/ru/V2_PLAN.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** The B4 table format (axes: airflow speed, airflow angle from edgewise through axial climb to descent, RPM or advance ratio and tip Mach; outputs: thrust, H-force, torque, rolling and pitching moments, shaft power; metadata: geometry, reference density, solver, envelope, hash); 4–5-D multilinear interpolation with exact `ρ·Ω²` scaling and edge flags; selectable per rotor (`rotorModel: "bet" | "map"`).
- **DoD & Acceptance Criteria:** Tables generated from the full BET reproduce it within the declared error budget; at zero airflow tables reproduce bench data within the declared tolerance; per-tick cost meets the Tier A target; out-of-envelope queries are flagged.

## Phase 10: Propulsion & Environment

Dynamic battery and motor models, standard turbulence, wind shear and Earth fields.

### TASK-104 — Battery v2: dynamic, thermal and aging

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: heating, cooling and aging are excluded (scope section 2); load-dependent sag and electrical limits come from TASK-092 and TASK-146. It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Model realistic voltage sag, recovery and temperature behavior so ArduPilot battery failsafes and sag compensation behave as in the field.
- **Dependencies:** TASK-026, TASK-092, TASK-093.
- **Touched Files:** `native/bet/src/battery.rs`, `native/bet/tests/battery.rs`, `tests/fixtures/power/battery-2rc.json`, `tests/fixtures/registry.json`, `tests/battery-dynamics.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Thevenin 2-RC model `V = OCV(SOC,T) − I·R₀(T,SOC) − V₁ − V₂` with `V̇_k = −V_k/(R_k·C_k) + I/C_k` discretized exactly; tabulated LiPo open-circuit voltage; Arrhenius `R₀(T)`; pack heat balance `m·c_p·Ṫ = I²·R₀ + Σ V_k²/R_k + I·T·∂U/∂T − h(V_air)·A·(T − T_amb)`; capacity fade and resistance growth; parameters fitted from pulse tests.
- **DoD & Acceptance Criteria:** Pulse-response fixtures match analytic RC solutions; a measured pulse or flight discharge is reproduced within the declared voltage RMS tolerance; the `BATT_FS_VOLTSRC 1` sag-compensated failsafe behaves as expected in SITL.

### TASK-105 — Motor and ESC v2: electrical, thermal, protocols and telemetry

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: not required by S01–S19 (scope section 2); electrical limits come from TASK-092 and TASK-146, and heating is excluded. It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Capture RPM-dependent torque limits, thermal degradation and ESC behavior (quantization, latency, ramp limits, braking, telemetry) that set actuator bandwidth and saturation ([V2_PLAN.md](V2_PLAN.md) B9).
- **Dependencies:** TASK-025, TASK-089, TASK-092.
- **Touched Files:** `native/bet/src/motor.rs`, `native/bet/src/esc.rs`, `native/bet/src/lib.rs`, `native/bet/tests/motor.rs`, `native/bet/tests/esc.rs`, `packages/autopilot/src/wasm-sitl.ts`, `native/ardupilot/hal/browser_hal.h`, `tests/esc-telemetry.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `L·di/dt = d·V_bus − R(T_w)·i − k_e(T_m)·Ω` integrated exactly; no-load and iron losses; `R(T) = R₂₀·(1 + 0.00393·ΔT)` and a magnet-temperature torque constant; two-node thermal network with airflow cooling; PWM and DShot quantization, frame latency, update rate, ramp limits, desync and startup, current limit, derating; eRPM telemetry delivered for `INS_HNTCH_MODE 3`.
- **DoD & Acceptance Criteria:** Electrical step and thermal fixtures match analytic solutions; thrust-stand temperature runs are reproduced within declared tolerances; harmonic-notch tracking is verified with simulated telemetry; G1 gates pass.

### TASK-106 — Turbulence v2: Dryden, von Kármán and Kaimal

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Required (S07) for turbulence; Dryden spectra are the minimum Phase 1 increment.
- **Title & Description:** Replace the uncorrelated per-axis AR(1) gust with standard turbulence spectra scaled by altitude, airspeed and condition, including rotational gusts and spatial coherence.
- **Dependencies:** TASK-032, TASK-093, TASK-166.
- **Touched Files:** `packages/physics/src/wind.ts`, `packages/physics/src/turbulence.ts`, `tests/turbulence.test.ts`, `scripts/bench-wind.mjs`, `tests/fixtures/environment/dryden-psd.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** MIL-F-8785C Dryden shaping filters `H_u = σ_u·√(2·L_u/(π·V))/(1 + (L_u/V)·s)` and `H_v,w = σ·√(L/(π·V))·(1 + √3·(L/V)·s)/(1 + (L/V)·s)²` with low-altitude scale lengths and intensities; rotational gusts; von Kármán rational fits; Kaimal spectra advected by the mean wind for hover; inter-hub coherence; exact discretization with tick-indexed coefficient refresh; fixed RNG stream IDs.
- **DoD & Acceptance Criteria:** Estimated PSDs match the specification spectra within declared tolerances over 1e7 samples; variance and scale lengths match; replay is seed-deterministic and FPS-independent; G1 gates pass. The effect exposes its on/off and intensity controls under the TASK-166 contract, and off is bitwise identical to the effect being absent.

### TASK-107 — Wind profile, shear and terrain-induced flow

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: terrain-induced flow is excluded (scope section 2), and wind profiles and shear are not among the S07 weather settings. It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Model mean wind versus height and terrain: logarithmic shear with land-cover roughness and precomputed terrain speed-up fields.
- **Dependencies:** TASK-069, TASK-093, TASK-095, TASK-106, TASK-166.
- **Touched Files:** `packages/physics/src/wind-profile.ts`, `packages/terrain/src/roughness.ts`, `tests/wind-profile.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `U(z) = (u*/κ)·ln((z − d)/z₀)` with an optional Monin–Obukhov correction; roughness length and displacement height from WorldCover classes; MIL-F-8785C shear for comparison; gridded terrain-flow fields loaded before arming.
- **DoD & Acceptance Criteria:** Profile fixtures match analytic values; the roughness mapping is versioned with provenance; grids respect the memory budget and never grow memory after arming. The effect exposes its on/off and intensity controls under the TASK-166 contract, and off is bitwise identical to the effect being absent.

### TASK-108 — Earth gravity and magnetic fields

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Partly required (S07): normal gravity, the WMM main field and a hashed geoid grid, delivered by TASK-148. Anomaly fields and vehicle interference are deferred.
- **Title & Description:** Use WGS84 normal gravity, Earth rotation and a geomagnetic model with anomalies and vehicle interference instead of constant gravity and a constant magnetic vector.
- **Dependencies:** TASK-036, TASK-089, TASK-092, TASK-094.
- **Touched Files:** `packages/sensors/src/gravity.ts`, `packages/sensors/src/geomagnetic.ts`, `packages/sensors/src/ideal.ts`, `native/bet/src/rigid_body.rs`, `tests/gravity.test.ts`, `tests/geomagnetic.test.ts`, `tests/fixtures/geodesy/wmm2025-reference.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Somigliana `γ(φ) = γ_e·(1 + k·sin²φ)/√(1 − e²·sin²φ)` with height correction; gravity along the ellipsoid normal; Earth rate `7.292115e-5 rad/s` in gyro truth; WMM2025 main field; EMAG2v3 anomalies; dipole sources; current-driven interference `B_int = Σ K_i·I_i` with soft and hard iron; an EGM2008 geoid grid with provenance.
- **DoD & Acceptance Criteria:** Gravity matches NIMA TR8350.2 reference values within 1e-9 relative; field values match WMM2025 test values within published tolerances; anomalies are defined relative to the ArduPilot declination baseline; the MSL gate becomes AVAILABLE only with a hashed geoid grid.

## Phase 11: Airframe & Vehicle Classes

Fixed-wing, QuadPlane, tilt-rotor and tailsitter vehicles.

### TASK-109 — Fixed-wing aerodynamics and control-surface actuators

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: fixed-wing, VTOL and other aircraft classes are later stages (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Add native fixed-wing UAV aerodynamics from cruise through stall, spin and post-stall, driven by ArduPlane servo outputs.
- **Dependencies:** TASK-087, TASK-094, TASK-097, TASK-106.
- **Touched Files:** `native/bet/src/wing.rs`, `native/bet/src/servo.rs`, `native/bet/src/lib.rs`, `native/bet/tests/wing.rs`, `native/bet/tests/servo.rs`, `packages/physics/src/vehicle.schema.json`, `packages/physics/src/fixed-wing-dynamics.ts`, `tests/fixed-wing-dynamics.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Strip or lifting-line surfaces with local velocity `v_cg + ω×r + wind` and 360° polars; lagged tail downwash `ε(t) = ε₀ + (dε/dα)·α(t − l_t/V)`; sidewash, fuselage and fin; flap-effectiveness control surfaces with hinge moments; Goman–Khrabrov stall hysteresis; deep-stall trim from `C_m(α)`; servo bandwidth, rate limit, deadband and backlash; manifest `surfaces[]`.
- **DoD & Acceptance Criteria:** Analytic lift-curve, trim and roll-damping fixtures pass; a reference aircraft trims and responds within declared tolerances of wind-tunnel or flight data; stall and spin entry are compared with data before DONE; G1 gates pass.

### TASK-110 — ArduPlane and QuadPlane coupling with an interim UAV reference

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: fixed-wing, VTOL and other aircraft classes are later stages (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Fly ArduPlane and QuadPlane against MirageSITL physics in the native and browser paths, with a UAV-class JSBSim model as a cross-check.
- **Dependencies:** TASK-031, TASK-089, TASK-109.
- **Touched Files:** `scripts/sitl/driver.mjs`, `packages/autopilot/src/external-sitl.ts`, `native/ardupilot/hal/sitl-state.patch`, `native/jsbsim/bridge.cpp`, `native/jsbsim/property-map.json`, `packages/wasm-jsbsim/src/backend.ts`, `tests/plane-sitl.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Plane parameter profiles and servo mapping; full body-axis air velocity with true angle of attack and sideslip; airspeed delivery through a verified JSON key or a TASK-089 field; an extended JSBSim property map beyond four inputs.
- **DoD & Acceptance Criteria:** ArduPlane completes a pinned auto mission in both paths; native and browser parity within declared limits; the JSBSim cross-check is recorded; no native firmware modification.

### TASK-111 — Wing ground effect and slipstream on lifting surfaces

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: fixed-wing, VTOL and other aircraft classes are later stages (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Model flare and float near the ground and propeller-blown wings and tails.
- **Dependencies:** TASK-100, TASK-101, TASK-109.
- **Touched Files:** `native/bet/src/wing.rs`, `native/bet/src/wake.rs`, `native/bet/tests/wing_ground_effect.rs`, `tests/wing-slipstream.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Induced-drag factor `φ = (16·h/b)²/(1 + (16·h/b)²)`; reduced tail downwash near the ground; slipstream speed-up and swirl `Δα = atan(v_t/(V + v_a))` applied to washed strips; manifest rotor-to-surface wash map.
- **DoD & Acceptance Criteria:** Closed-form fixtures pass; flare behavior is compared with landing data; disabled terms are bitwise identical to TASK-109.

### TASK-112 — QuadPlane dynamics

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: fixed-wing, VTOL and other aircraft classes are later stages (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Realistic QuadPlane hover, transition and back-transition, including lift rotors in edgewise flow and rotor–wing interference.
- **Dependencies:** TASK-098, TASK-101, TASK-109, TASK-110.
- **Touched Files:** `packages/physics/src/quadplane-dynamics.ts`, `packages/physics/src/vehicle.schema.json`, `tests/quadplane-dynamics.test.ts`, `tests/fixtures/models/synthetic-quadplane-v2.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Composition of inflow-v2 lift rotors, a forward thrust rotor and the wing model with download and upwash coupling; high-α wing during back-transition; stopped-propeller drag and windmilling through the free shaft; `Q_ENABLE` and `Q_FRAME_*` mapping.
- **DoD & Acceptance Criteria:** QHOVER, QLOITER and transitions complete in both paths; `Q_ASSIST_SPEED` behavior is exercised; transition data are compared before DONE.

### TASK-113 — Tilt-rotor and tailsitter support

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: fixed-wing, VTOL and other aircraft classes are later stages (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Support vehicles whose thrust axes move or whose wings fly at ±90° angle of attack in hover.
- **Dependencies:** TASK-094, TASK-109, TASK-112.
- **Touched Files:** `packages/physics/src/tilt-kinematics.ts`, `packages/physics/src/quadplane-dynamics.ts`, `packages/physics/src/vehicle.schema.json`, `tests/tilt-kinematics.test.ts`, `tests/tailsitter-dynamics.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Per-tick hub orientation from tilt servos; tilt rate added to the hub angular velocity (`ω_tilt × H` and reaction torques); CG and inertia shift with tilt; ±180° angle-of-attack and sideslip aerodynamics on all surfaces; blown elevons; tail-sitting ground contact; manifest `tilt` blocks.
- **DoD & Acceptance Criteria:** Gyroscopic and reaction-torque fixtures pass; tilt-rotor and tailsitter transitions complete in SITL; behavior is compared with data before DONE.

## Phase 12: Sensor Physics

Vibration and IMU, barometer, GNSS, magnetometer, airspeed and rangefinder error physics.

### TASK-114 — Vibration synthesis and IMU sampling chain

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: not required by S01–S19 (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Generate realistic accelerometer and gyro vibration and sample it like real IMUs, so aliasing, clipping and harmonic-notch behavior are reproducible.
- **Dependencies:** TASK-089, TASK-102, TASK-115.
- **Touched Files:** `packages/sensors/src/vibration.ts`, `packages/sensors/src/imu-chain.ts`, `tests/vibration.test.ts`, `tests/imu-chain.test.ts`, `packages/autopilot/src/wasm-sitl.ts`, `native/ardupilot/hal/browser_hal.h`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Excitation from blade-by-blade harmonics; frame transfer and isolator filters; synthesis at the sensor internal rate with recursive oscillators; sensor low-pass and anti-alias filtering, output-rate decimation and range clipping; IMU batch delivery decided under TASK-089; ArduPilot vibration noise neutralized when MirageSITL owns it.
- **DoD & Acceptance Criteria:** Aliasing, clipping and decimation fixtures match analytic expectations; simulated accelerometer spectra match measured logs within declared tolerances; the harmonic notch locks onto simulated RPM; per-tick cost stays within the Tier B budget.

### TASK-115 — IMU error model v2

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Partly required (S08): placement (lever arm) and orientation, delivered by TASK-147. Temperature, Allan-variance and vibration-rectification terms are deferred.
- **Title & Description:** Replace the single AR(1) plus bias walk with Allan-variance-calibrated, temperature-dependent IMU errors.
- **Dependencies:** TASK-035, TASK-087, TASK-089, TASK-166.
- **Touched Files:** `packages/sensors/src/noise.ts`, `packages/sensors/src/imu-errors.ts`, `tests/imu-errors.test.ts`, `tests/fixtures/sensors/imu-allan.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `ω_m = (I + S + M)·ω + b(T) + G_g·a + n`; angle random walk, bias instability as summed Gauss–Markov processes, rate random walk; temperature polynomial and warm-up; scale-factor nonlinearity, misalignment, g-sensitivity, vibration rectification, LSB quantization and a seeded turn-on bias; lever arm `a_IMU = a + ω̇×r + ω×(ω×r)`; manifest `sensors.imu[]`.
- **DoD & Acceptance Criteria:** The Allan deviation of simulated output matches the configured curve within declared tolerances over 1e7 samples; lever-arm and misalignment fixtures pass; seeded replay is deterministic; G1 gates pass. The effect exposes its on/off and intensity controls under the TASK-166 contract, and off is bitwise identical to the effect being absent.

### TASK-116 — Barometer v2

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: not required by S01–S19 (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Model the pressure errors that dominate barometric altitude near the ground and in fast flight.
- **Dependencies:** TASK-089, TASK-096, TASK-100, TASK-166.
- **Touched Files:** `packages/sensors/src/barometer.ts`, `tests/barometer.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `p = p_static + ΔC_p(α,β)·q∞ + Δp_GE + Δp_wash + drift(T,t) + noise`; ground cushion `Δp_GE ≈ k·½·ρ·v_i²·g(z/R)`; sensor lag and conversion time; weather pressure trend; delivery through TASK-089 with ArduPilot `SIM_BARO_*` errors neutralized.
- **DoD & Acceptance Criteria:** Fixtures match closed forms; logged takeoff and landing baro dips are reproduced within declared tolerances; ArduPilot ground-effect handling (`GND_EFFECT_COMP`, `EK3_GND_EFF_DZ`) is exercised. The effect exposes its on/off and intensity controls under the TASK-166 contract, and off is bitwise identical to the effect being absent.

### TASK-117 — GNSS v2

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: not required by S01–S19 (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Tie GNSS position and velocity errors and outages to satellite geometry, terrain and buildings, the atmosphere and the RF environment.
- **Dependencies:** TASK-036, TASK-053, TASK-058, TASK-089, TASK-108, TASK-166.
- **Touched Files:** `packages/sensors/src/gnss.ts`, `packages/sensors/src/gnss-visibility.worker.ts`, `packages/ew/src/engine.ts`, `tests/gnss-errors.test.ts`, `tests/fixtures/sensors/gnss-ephemeris.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Ephemeris-based azimuth and elevation; line-of-sight and NLOS by ray casting on the terrain lattice; Klobuchar ionosphere, Saastamoinen troposphere, multipath error envelope, NLOS bias and C/N0-dependent noise; receiver solution latency and rate; jamming `(C/N0)_eff⁻¹ = (C/N0)⁻¹ + (J/S)/(Q·R_c)` from EW zones; MAVLink `GPS1_TYPE 14` delivery.
- **DoD & Acceptance Criteria:** Geometry and DOP fixtures match references; open-sky and urban error statistics match logged data within declared tolerances; jamming thresholds follow the link budget; visibility runs off the physics Worker. The effect exposes its on/off and intensity controls under the TASK-166 contract, and off is bitwise identical to the effect being absent.

### TASK-118 — Magnetometer, airspeed and rangefinder v2

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: not required by S01–S19 (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Model the dominant remaining sensor errors: motor-current magnetic interference, pitot geometry and slipstream, and rangefinder beam and surface effects.
- **Dependencies:** TASK-056, TASK-089, TASK-092, TASK-101, TASK-108.
- **Touched Files:** `packages/sensors/src/magnetometer.ts`, `packages/sensors/src/airspeed.ts`, `packages/sensors/src/rangefinder.ts`, `tests/magnetometer.test.ts`, `tests/airspeed-sensor.test.ts`, `tests/rangefinder.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `B_m = S·(B_earth + B_anom) + b_hard + Σ K_i·I_i` with temperature drift; `q_m = q∞·cosⁿθ + C_p,pos·q` with tubing lag and slipstream contamination; nearest return in the beam cone, reflectivity per land-cover class, range noise and dropouts.
- **DoD & Acceptance Criteria:** Fixtures match closed forms; `COMPASS_MOT*` compensation tests behave as on hardware; rangefinder delivery is verified per transport.

## Phase 13: Structures & Extreme Environment

Flexible structure, mass changes, convective and hazardous flows, and unsteady aerodynamics.

### TASK-119 — Variable mass, payload release, slung loads and slosh

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: not required by S01–S19 (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Model in-flight CG and inertia changes (payload drops, fuel burn, spraying) and suspended or liquid payloads.
- **Dependencies:** TASK-094, TASK-095.
- **Touched Files:** `native/bet/src/rigid_body.rs`, `packages/physics/src/mass-events.ts`, `packages/protocol/src/control-v2.ts`, `packages/protocol/src/control-v2.schema.json`, `tests/mass-events.test.ts`, `tests/slosh.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Parallel-axis updates at mass events; momentum-conserving release; `İ·ω` for continuous mass flow; a released payload becomes a separate Rapier body; tension-only cable spring-damper; equivalent-pendulum slosh per tank (Abramson, NASA SP-106); a new acknowledged Control Protocol command with a version bump and fixtures.
- **DoD & Acceptance Criteria:** Conservation fixtures pass; payload-release transients and slosh are compared with flight data before DONE; protocol fixtures and rejection tests pass.

### TASK-120 — Flexible structure (aeroelasticity)

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: flexible structures are excluded (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Model wing bending and torsion, boom twist and arm and frame modes that change handling, control effectiveness and vibration.
- **Dependencies:** TASK-094, TASK-102, TASK-109, TASK-114.
- **Touched Files:** `native/bet/src/modal.rs`, `native/bet/src/lib.rs`, `native/bet/tests/modal.rs`, `packages/physics/src/vehicle.schema.json`, `tests/flexible-body.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Truncated modal equations `q̈ + 2·ζ·ω·q̇ + ω²·q = Q/M` with exact per-mode stepping and quasi-static condensation above a quarter of the physics rate; strip angle of attack with elastic twist and plunge; the Jones approximation of the Wagner function; mean-axes coupling; boom twist rotating hub axes; modal acceleration at the IMU.
- **DoD & Acceptance Criteria:** Modal frequency and damping fixtures pass; static aeroelastic twist matches analytic beams; frequencies are compared with ground-vibration tests before DONE; G1 gates pass.

### TASK-121 — Thermals and the convective boundary layer

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: thermals are not among the S07 weather settings. It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Provide realistic convective updrafts and sink for ArduPlane `SOAR` testing and altitude-hold disturbances.
- **Dependencies:** TASK-070, TASK-106, TASK-107, TASK-166.
- **Touched Files:** `packages/physics/src/thermals.ts`, `tests/thermals.test.ts`, `packages/protocol/src/control-v2.ts`, `packages/protocol/src/control-v2.schema.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** `w* = (g·z_i·H/(ρ·c_p·T))^(1/3)` with surface heat flux from the thermal surface-energy solver; Allen (2006) updraft profile with environmental sink; seeded thermal life cycle and drift with the wind; a `weather.set` extension with a protocol version bump.
- **DoD & Acceptance Criteria:** Mass-conservation and profile fixtures pass; seeded replay is deterministic; ArduPlane `SOAR` engages in SITL. The effect exposes its on/off and intensity controls under the TASK-166 contract, and off is bitwise identical to the effect being absent.

### TASK-122 — Microbursts, gust fronts, wake vortices and other-vehicle downwash

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: multi-aircraft wakes are excluded (scope section 2), and microbursts and gust fronts are not among the S07 weather settings. It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Model hazardous localized flows for landing safety and swarm or formation flight.
- **Dependencies:** TASK-079, TASK-101, TASK-106, TASK-166.
- **Touched Files:** `packages/physics/src/hazard-flows.ts`, `packages/scenarios/src/schema.ts`, `tests/hazard-flows.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Oseguera–Bowles downburst (mass-conserving analytic field); moving shear-line gust fronts; Burnham–Hallock vortices `V_θ = (Γ/2π)·r/(r² + r_c²)` with `Γ₀ = W/(ρ·V·b₀)` and `b₀ = π·b/4`, descent and decay; rotor wakes as aging segments; scenario-driven activation; bounded shared wake buffers between vehicle Workers.
- **DoD & Acceptance Criteria:** Divergence-free and analytic-field fixtures pass; scenario timing binds to ticks with acknowledgements; multi-vehicle wake exchange is lockstep-deterministic. The effect exposes its on/off and intensity controls under the TASK-166 contract, and off is bitwise identical to the effect being absent.

### TASK-123 — Dynamic stall and unsteady airfoil aerodynamics

- **Status:** TODO — registered 2026-10-26 from the physics fidelity review; baseline 4593971.
- **Phase 1 disposition:** Deferred: not required by S01–S19 (scope section 2). It keeps its ID, contract and evidence; work on it needs separate stakeholder approval.
- **Title & Description:** Capture lift overshoot, hysteresis and delayed stall under fast-changing angle of attack on rotors and wings.
- **Dependencies:** TASK-097, TASK-102, TASK-109.
- **Touched Files:** `native/bet/src/dynamic_stall.rs`, `native/bet/src/blade.rs`, `native/bet/src/wing.rs`, `native/bet/src/lib.rs`, `native/bet/tests/dynamic_stall.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Øye separation lag `ḟ = (f_st − f)/τ_f` with `C_L = f·C_L,inv + (1 − f)·C_L,fs`; Leishman–Beddoes for higher fidelity; one state per strip per blade in preallocated arrays; flags outside the calibrated reduced-frequency range.
- **DoD & Acceptance Criteria:** Oscillating-airfoil fixtures match published hysteresis loops within declared tolerances; the static limit equals the 360° polar; G1 gates pass.

## Product Phase 1 program (PROJECT_SCOPE.md)

Registered on 2026-10-28 from the approved [PROJECT_SCOPE.md](../PROJECT_SCOPE.md) (audit baseline `5b4a2fc`) and an inventory of baseline `384e974` and the unmerged branches. [PHASE1_PLAN.md](PHASE1_PLAN.md) maps every requirement group to existing and new work and gives the disposition of earlier open tasks, the stage order, the decisions and the risks. Registration implements nothing and authorizes no development: each task starts only under an explicit development instruction and stays within that instruction's scope.

Phase 1 targets macOS on Apple Silicon in Chrome. ArduPilot runs as an external local SITL process, and the browser provides the UI, visualization and simulation integration. Each task names the scope requirement groups it serves (S01–S19); these IDs are unrelated to the sprint-batch labels in the table above. Historical Windows and WSL evidence is preserved but is not Phase 1 acceptance. Deferred tasks keep their IDs and contracts. The stages below follow the scope's execution plan; no dates or effort estimates are given.

## Stage P1.1: Feasibility and Decisions

Scope step 1. Each task produces evidence on the target platform or an exact BLOCKED status; decisions record their owner and date.

### TASK-127 — Native ArduPilot SITL on macOS Apple Silicon

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S01, S02) Build the pinned ArduCopter SITL natively on an Apple Silicon Mac and fly it in a closed loop against MirageSITL physics through the JSON backend. The owned-process harness refuses non-Linux hosts and checks for ELF binaries today. Extend it to accept a macOS host and Mach-O binaries, keep its Linux path, and add no Windows work. Record the toolchain and every blocker. A virtual machine or container is not substituted without a recorded stakeholder decision.
- **Dependencies:** TASK-041, TASK-042.
- **Touched Files:** `scripts/run-sitl.mjs`, `scripts/sitl/driver.mjs`, `scripts/sitl/telemetry.py`, `tests/support/parity-native.ts`, `tests/integration/external-sitl.test.ts`, `docs/decisions/macos-sitl.md`, `docs/ru/macos-sitl.md`, `docs/documentation-index.json`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Host record: macOS version, chip, Xcode command-line tools, Python and pymavlink 2.4.50, ArduPilot commit and binary SHA-256. The harness accepts ELF on Linux and Mach-O on macOS, keeps process-group ownership and cleanup, and still refuses Windows. Missing prerequisites exit 2 (BLOCKED_EXTERNAL).
- **DoD & Acceptance Criteria:** On an Apple Silicon Mac the pinned ArduCopter builds from a clean pinned checkout, or the exact failure is recorded. The TASK-042 arm, takeoff, hold and land scenario passes `scripts/check-sitl-capture.mjs` on that Mac. Cleanup terminates only owned processes. Fake and non-executable binaries are still rejected. Cloud Linux runs and historical WSL captures do not count (G4).

### TASK-128 — ArduPilot version and the 16-motor output path

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S03, S19) Select the compatible ArduCopter version or versions for Phase 1. Verify, in the hash-pinned source and in native SITL on macOS, that quad, hexa and octo frames, one coaxial-pair frame and the eight-arm, two-motor (16-motor) configuration can be expressed with stock frame classes or the stock scripting-matrix frame. Check the motor limit, the output count and the JSON servo packet. A firmware limitation is escalated as BLOCKED_DECISION with options; the 16-motor requirement is never reduced.
- **Dependencies:** TASK-041, TASK-127.
- **Touched Files:** `tests/fixtures/sitl/frames.json`, `tests/fixtures/sitl/generate.py`, `scripts/sitl/multirotor.mjs`, `scripts/sitl/driver.mjs`, `tests/sitl-frames.test.ts`, `docs/decisions/ardupilot-frames.md`, `docs/ru/ardupilot-frames.md`, `docs/documentation-index.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Frame catalog generated from the pinned source: frame class and type to motor count, motor numbering, position and yaw factors and spin; motor output-function values; maximum motor and output counts; 16- and 32-channel JSON servo packets. A synthetic N-rotor reference model in the harness replaces the quad-only reference for these checks.
- **DoD & Acceptance Criteria:** For each of the five configurations native SITL arms, a one-motor-at-a-time test moves exactly the expected output in the physics packet, and the aircraft hovers. Otherwise the exact limitation and its options (for example the stock scripting-matrix frame, a build option, or a firmware patch that needs approval) are recorded as BLOCKED_DECISION. The selected versions are recorded with commit and binary hash.

### TASK-129 — External SITL clock ownership, synchronized pause and acceleration

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S02, S10) Demonstrate on macOS, with native ArduCopter in JSON lockstep, that MirageSITL physics owns simulated time. Withholding physics replies freezes ArduPilot time, resume continues from the retained state, and accelerated runs are limited only by the host. Characterize MAVLink parameter access and RC and ground-station traffic while paused. Characterize the bridge's 5 s idle disconnect, which would drop a paused session. Classify which manual-connection configurations are clock-compatible.
- **Dependencies:** TASK-041, TASK-043, TASK-127.
- **Touched Files:** `scripts/sitl/driver.mjs`, `scripts/sitl/pause-probe.mjs`, `scripts/sitl/telemetry.py`, `apps/bridge/src/server.ts`, `tests/integration/sitl-pause.test.ts`, `docs/decisions/sitl-clock.md`, `docs/ru/sitl-clock.md`, `docs/documentation-index.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Pause is a tick-boundary hold of the next JSON reply. Simulated time advances only on executed steps, and paused wall time is excluded from simulated duration. The bridge distinguishes a paused session from an idle one. The acceleration setting (`--speedup` or its successor) and the measured simulated/wall ratio are recorded.
- **DoD & Acceptance Criteria:** On macOS, pauses of at least 60 s wall time on the ground and in hover resume without failsafe, EKF reset or a state discontinuity beyond a tolerance declared before the test. Whether parameter reads and writes work while paused is recorded with evidence. The achieved acceleration is measured. ArduPilot is not modified.

### TASK-130 — UAVLogViewer identity, license and offline-integration feasibility

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S14) Identify the upstream UAVLogViewer, pin a commit, and record its license and its compatibility with local bundling. Build it offline, with no tokens or online imagery required after installation, and open a real ArduPilot DataFlash log in Chrome on macOS. Choose how side-by-side and overlay comparisons, time alignment, parameter markers and MirageSITL experiment logs will be added: a patch series on a pinned fork, upstream extension points, or embedding with a message interface. No replacement viewer is started.
- **Dependencies:** TASK-081.
- **Touched Files:** `third_party/uavlogviewer/source.lock.json`, `scripts/check-uavlogviewer.mjs`, `docs/decisions/uavlogviewer.md`, `docs/ru/uavlogviewer.md`, `docs/documentation-index.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Source lock: repository, commit, license, build inputs and output hashes. The decision record names the extension approach, the upstream modules it changes and the adapter route for MirageSITL experiments.
- **DoD & Acceptance Criteria:** A pinned offline build opens one real DataFlash log with the network disabled. The license question is resolved or escalated as BLOCKED_DECISION. The extension plan names the upstream code it changes. Any blocker is BLOCKED_EXTERNAL or BLOCKED_DECISION with the exact missing input.

### TASK-131 — Offline dependency and existing-terrain inventory

- **Status:** DONE — Claude; baseline f34b09a; 2026-10-28. `config/offline-inventory.json` holds 20 dependency rows and 27 listed network origins; `data/terrain/inventory.json` holds 9 terrain sources and 5 coverage gaps; [docs/operations/offline-inventory.md](operations/offline-inventory.md) explains them. Evidence: `node scripts/check-offline.mjs` exit 0 (289 files scanned, 23 origins named, 38 runtime npm packages with reviewed licenses, 3 WorldCover files verified by bytes and SHA-256). After `npm run build`, `node scripts/check-offline.mjs --dist apps/web/dist` exit 0 (14 bundle files; all 27 origins named, none unused). `npx --no-install vitest run tests/offline-inventory.test.ts`: 11 tests pass, including failures on an unlisted origin in source and in a bundle. The documentation pair is registered and `npm run check:docs` passes. Open licenses point to D-01, D-02, D-04, D-06, D-08, D-09, TASK-045, TASK-148 and TASK-159; D-09 awaits the stakeholder's decision.
- **Title & Description:** (S01, S17) Inventory every dependency the Phase 1 workflow needs after installation: application bundles and WASM artifacts, ArduPilot sources and toolchain, the Python environment, parameter metadata, UAVLogViewer assets and terrain data. Classify the available imagery and elevation data, with Israel as the focus: the synthetic pad, the WorldCover land-cover tiles (TASK-069), the test fixtures, and the FABDEM tooling whose output is not in the repository. New providers and automatic region downloads are out of scope. `config/offline-inventory.json` was added to Touched Files during the task: the dependency rows and the network-origin list need a machine-readable file that the check reads, and the terrain file holds terrain sources only.
- **Dependencies:** TASK-060, TASK-069.
- **Touched Files:** `docs/operations/offline-inventory.md`, `docs/ru/offline-inventory.md`, `docs/documentation-index.json`, `config/offline-inventory.json`, `data/terrain/inventory.json`, `scripts/check-offline.mjs`, `tests/offline-inventory.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Inventory rows: item, version, source, license, SHA-256, bytes, the workflow that needs it, and whether installation downloads it. Terrain rows distinguish imagery, elevation and land cover, and record coverage, resolution and readiness (ready, needs data, or needs keys or deployment). Rows record SHA-256 and bytes for files kept in the repository; built artifacts record theirs in their build manifests, and sources are pinned by commit. Readiness also distinguishes ready-not-wired (validated local data not connected to the runtime) and test-only.
- **DoD & Acceptance Criteria:** Every runtime dependency of the planned workflow has a row, and the check fails on an unlisted network origin. Every dataset has a license status, and unresolved licenses become decisions. Coverage gaps are listed, not filled with new providers. Nothing is downloaded automatically.

### TASK-132 — Phase 1 acceptance parameters: reference hardware, performance and recording

- **Status:** DONE — Claude; 2026-10-28. Every item A-01 to A-12 now carries the stakeholder's decision of 2026-10-28; the matrix uses X8 as its paired configuration, and all 51 cells are NOT_RUN until evidence exists. A-11 follows from the approved scope and was explained to the stakeholder. Earlier status: BLOCKED_DECISION — Claude; baseline 8e928fc; 2026-10-28. The decision record [docs/decisions/phase1-acceptance.md](decisions/phase1-acceptance.md) lists items A-01 to A-11, and the matrix [docs/validation/phase1-matrix.json](validation/phase1-matrix.json) lists 5 configurations, 15 workflows and 51 cells: 41 NOT_RUN and 10 BLOCKED_DECISION. A-01 to A-10 awaited the stakeholder's values; no value was invented. On 2026-10-28 the stakeholder decided A-01 to A-05 and added A-12 (memory below 8 GB); A-06 to A-10 stay open, and the one-hour cell now waits on A-07 and A-08 only. A-11 records that TASK-073 is not a Phase 1 gate, as the approved scope of 2026-10-28 states; TASK-073's status and evidence are unchanged. Evidence: a structural check of the matrix (each workflow covers each of its configurations exactly once; every verdict is from the list; every BLOCKED_DECISION cell names its decisions; no cell has evidence) reports 0 problems; `npm run check:docs` passes with the new pair. The paired or coaxial configuration (A-10) was added as a decision item because S19 names no specific arrangement.
- **Title & Description:** (S13, S19) Record the stakeholder's decisions on the agreed Apple Silicon reference machines, macOS and Chrome versions, the physics rate for each configuration, real-time criteria, rendering criteria for the Phase 1 scene, the 16-motor one-hour recording workload, the storage budget, and the default common logging frequency. Reconcile TASK-073: its gate was measured with Windows-hosted integrated GPUs and a thermal and FPV scene that Phase 1 excludes, so it does not block Phase 1, and its evidence is preserved.
- **Dependencies:** TASK-014.
- **Touched Files:** `docs/decisions/phase1-acceptance.md`, `docs/ru/phase1-acceptance.md`, `docs/documentation-index.json`, `docs/validation/phase1-matrix.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Decision record with a value, owner and date for every item. Acceptance-matrix schema: configuration × workflow × verdict (PASS, FAIL, BLOCKED_EXTERNAL, BLOCKED_DECISION, NOT_RUN) with evidence path and hash.
- **DoD & Acceptance Criteria:** Every value carries a stakeholder decision date. A value that has not been chosen stays BLOCKED_DECISION and is never invented by an agent. The matrix lists all S19 configurations and workflows. TASK-073's historical results are neither relabeled nor deleted.

### TASK-133 — Model envelopes, fidelity criteria and the basic contact approximation

- **Status:** DONE — Claude; 2026-10-28. The stakeholder decided the remaining items on 2026-10-28: MirageSITL sets no validation limits and issues no fidelity verdicts (F-02, F-05; recorded as a scope amendment to S15), F-04 lists the quantities MirageSITL computes and shows, and F-03 keeps engineering envelope bounds only for the out-of-range warning that S05 requires. TASK-145, TASK-184 and TASK-191 were updated to match. Earlier status: BLOCKED_DECISION — Claude; 2026-10-28. On 2026-10-28 the stakeholder approved F-01, F-06 and F-07, chose the F-08 contact defaults, and asked Claude to set the F-09 thresholds; the validation limits and envelope bounds F-02 to F-05 stay open. Earlier status: BLOCKED_DECISION — Claude; baseline d4a8b54; 2026-10-28. [docs/decisions/phase1-fidelity.md](decisions/phase1-fidelity.md) proposes the per-effect table for 13 effect rows (model, inputs, envelope, verification tolerance, validation tolerance, out-of-envelope behavior and tasks), the five S15 comparisons with their metrics and data, the three confidence labels with a combination rule, geometry-derived support points, contact defaults derived from a static deflection, damping ratio and friction coefficients, and accident criteria. Models, inputs and verification tolerances repeat existing contracts; every validation limit, the open envelope bounds and the contact defaults stay BLOCKED_DECISION (items F-01 to F-09), and none was invented. The UIUC FAIL and the deferred NASA FAIL keep their verdicts. [SPECS_SIMULATION_ENGINES.md](SPECS_SIMULATION_ENGINES.md) section 7 points to the record. Evidence: `npm run check:docs` passes with the new pair, including the identical displayed equation in both languages.
- **Title & Description:** (S05, S06, S15, S18) For each approved physical effect, specify the model, required inputs, validity envelope, numerical tolerance and extrapolation behavior. The effects are propulsion, battery, inflow in hover, forward flight and descent, coaxial pairs, body drag, ground effect, adverse descent, contact, sensors and environment. For each S15 comparison (attitude and rate response, overshoot and oscillation, altitude, climb and descent, trajectory, propulsion and energy), specify the metric, the data it needs and its limit. Define the confidence labels and the basic support and contact approximation, without gear editing.
- **Dependencies:** TASK-033.
- **Touched Files:** `docs/decisions/phase1-fidelity.md`, `docs/ru/phase1-fidelity.md`, `docs/documentation-index.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Per-effect table: model, inputs, envelope, tolerance and flag. Per-comparison table: metric, data, limit and owner. Confidence labels: preliminary, measured-input, flight-checked; none certifies settings for real flight. Contact: support points derived from geometry, default stiffness, damping and friction, and accident criteria.
- **DoD & Acceptance Criteria:** The tables are approved before any Phase 1 model task claims acceptance. The failed UIUC and deferred NASA comparisons keep their verdicts. Every limit has an owner and a date. No effect is called measured-accurate without evidence.

## Stage P1.2: Scope Mapping

Scope step 2. Align the documentation with the approved scope and bring unmerged work onto main before building on it.

### TASK-134 — Reconcile the roadmap, specifications and agent instructions with PROJECT_SCOPE.md

- **Status:** DONE — Claude; baseline 7ad1f51; 2026-10-28. A **Phase 1 disposition** line now sits on all 42 open tasks before TASK-127 and on the 16 DONE tasks that the plan's section 4 names, in both languages; no Status line or DONE evidence was changed. CLAUDE.md, the README, the architecture overview and AGENTS.md direct agents to PROJECT_SCOPE.md and the Phase 1 plan first; CLAUDE.md has a current baseline section; and the README, CLAUDE.md and the architecture overview mark the Windows and WSL material as historical. The two missing-script references in CLAUDE.md and the README, and one that TASK-131 had introduced in `config/offline-inventory.json`, now name the real audit commands (`scripts/sitl/check-raw.py`, `scripts/sitl/audit-ew.mjs` with `scripts/sitl/check-ew.py`, `node scripts/freeze-ew.mjs`, `node scripts/run-ew-sitl.mjs`). TASK-047's disposition notes that its parity report is not tracked. HANDOVER.md is retired to a pointer that keeps its one current finding. V2_PLAN.md is marked as background. Decisions D-11 and D-12 are registered in the plan and referenced from TASK-096–TASK-101 and TASK-080; they await the stakeholder. Evidence: a script check finds a disposition on every open task before TASK-127 in both languages (58 lines each); a search finds no remaining instruction to run either missing script; `node scripts/check-offline.mjs` exit 0; `npm run check:docs` passes.
- **Title & Description:** (S01–S19) Apply the disposition table in [PHASE1_PLAN.md](PHASE1_PLAN.md) section 4. Record each open roadmap task's Phase 1 disposition without rewriting completed evidence. Update the CLAUDE.md baseline, the README and the architecture overview so agents read PROJECT_SCOPE.md and the plan first. Mark Windows and WSL as historical, with no Phase 1 work. Record decisions D-11 and D-12. Correct the references to files that are not in the repository (`scripts/check-mavlink-capture.mjs`, `scripts/check-ew-capture.mjs`), and retire the stale TASK-074 handover. During the task, `config/offline-inventory.json` was added to Touched Files to correct a missing-script reference that TASK-131 introduced, and `docs/decisions/phase1-acceptance.md` with its mirror to record the outcome for the `analyze_repo_next_task` branch, which the plan assigned to TASK-132.
- **Dependencies:** TASK-084.
- **Touched Files:** `CLAUDE.md`, `docs/ru/CLAUDE.md`, `README.md`, `docs/ru/README.md`, `AGENTS.md`, `docs/ru/AGENTS.md`, `HANDOVER.md`, `docs/ru/HANDOVER.md`, `docs/documentation-index.json`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/V2_PLAN.md`, `docs/ru/V2_PLAN.md`, `docs/PHASE1_PLAN.md`, `docs/ru/PHASE1_PLAN.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `config/offline-inventory.json`, `docs/decisions/phase1-acceptance.md`, `docs/ru/phase1-acceptance.md`.
- **Interfaces / Contracts:** Documentation only; no runtime contract changes. Dispositions use the existing status vocabulary, and a deferred task keeps its ID and contract. The scope and its mirror change only through a recorded scope amendment.
- **DoD & Acceptance Criteria:** Every open task has a disposition consistent with the scope. No DONE evidence is rewritten. No reference to a missing file remains in the reconciled documents. `npm run check:docs` passes, and the English sources and Russian mirrors change together.

### TASK-135 — Land the physics-review branch increments of TASK-087–TASK-090

- **Status:** DONE — Claude; baseline 7f5b2a1, merging branch tip 94c4881; 2026-10-28. The merge resolves the conflicts with TASK-124–TASK-126 and retires the branch's effect-control TASK-124 into TASK-166. It closes one integration gap that neither side covered: `model.load` did not rebuild the TASK-124 motor-fault table, so a loaded model kept the previous model's motor count and faults. `commitModel` now rebinds the table and starts the new epoch fault-free, as `sim.configure` does; the new test in `tests/session-v2.test.ts` fails without the fix. The existing TASK-124–TASK-126 tests are unchanged and pass. Evidence: typecheck, lint and build exit 0; `npm run check:docs` exit 0 (23 pairs, 191 tasks); `cargo test --workspace --locked` 23 suites, 72 tests pass. Full `npm test`: 119 files, 718 tests passed, 15 skipped, and 5 files failed on the cold environment only. Three contact suites timed out while the first Rapier clone and build held the build lock; documentation-policy ran before the mirror hashes were refreshed; and the WorldCover hash test exceeded its 5 s default under parallel load. A rerun of those 5 files passed (37 tests). TASK-087–TASK-090 evidence rerun: 13 test files, 121 tests pass; `node scripts/check-fidelity.mjs` exit 2 (synthetic capture, J = 19.950, never a pass); `node scripts/ownership-profile.mjs --imu-noise-floor off` and `--imu-noise-floor ardupilot` exit 0; `node scripts/run-sitl.mjs` exit 2, BLOCKED_EXTERNAL without native SITL in this environment. TASK-087–TASK-090 stay IN_PROGRESS.
- **Title & Description:** (S03, S04, S08, S15) Merge the unmerged branch `claude/ardupilot-sitl-physics-review-ggf1tb` (9 commits on `27e2a6a`, 65 files) into main. It holds increment 1 of the vehicle manifest v2, the interfaces v2, the error-ownership catalog, and the fidelity metrics with bench import. Resolve conflicts with TASK-124–TASK-126. The branch registers "TASK-124 — Effect controls", which collides with main's TASK-124; TASK-166 supersedes it, so it is not merged under that ID. The branch's opt-in `imu-noise-floor` ArduPilot patch stays unused by Phase 1 runs until decision D-10. Touched Files lists the principal files; the rest of that branch's diff comes unchanged. The README, architecture, runbook and Phase 1 plan files (both languages) were added to Touched Files during the merge because both sides changed them, and `tests/session-v2.test.ts` was added for the model.load integration fix.
- **Dependencies:** TASK-124, TASK-125, TASK-126.
- **Touched Files:** `packages/physics/src/vehicle-manifest.ts`, `packages/physics/src/vehicle.schema.json`, `packages/physics/src/ardupilot-profile.ts`, `packages/physics/src/bench-import.ts`, `packages/physics/src/fidelity-metrics.ts`, `packages/physics/src/session-v2.ts`, `packages/autopilot/src/error-ownership.ts`, `packages/wasm-bet/src/rotor-v2.ts`, `packages/wasm-bet/src/body-v2.ts`, `native/bet/src/bound_v2.rs`, `native/bet/src/body_abi_v2.rs`, `scripts/build-ardupilot-sitl.mjs`, `scripts/check-fidelity.mjs`, `tests/vehicle-manifest.test.ts`, `tests/wasm-abi-v2.test.ts`, `tests/error-ownership.test.ts`, `tests/fidelity-metrics.test.ts`, `tests/bench-import.test.ts`, `tests/session-v2.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PHASE1_PLAN.md`, `docs/ru/PHASE1_PLAN.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The contracts specified on the branch for TASK-087–TASK-090, with no new behavior. Stock, unpatched SITL stays the default build. Task IDs stay unique.
- **DoD & Acceptance Criteria:** On the merged head, `npm test`, typecheck, lint, `npm run check:docs` and `cargo test --workspace --locked` pass. The TASK-087–TASK-090 evidence commands are rerun and recorded; the tasks remain IN_PROGRESS until their own DoD is met. No duplicate task ID exists. TASK-124–TASK-126 behavior and tests are unchanged.

## Stage P1.3: Data Foundation and Editors

Scope step 3. Versioned local data and the editors that create it (S03, S04, S08, S16).

### TASK-136 — Local project store with immutable versions

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S16, S01) Persist projects, aircraft profile versions, component cards and experiments locally, with no account or cloud service. Editing creates a new version and never changes the inputs of earlier experiments. Export and import report missing dependencies. User-defined names accept Russian and English text. The task chooses the storage backend (Origin Private File System or IndexedDB) and justifies the choice; files managed by the launcher remain a documented alternative.
- **Dependencies:** TASK-076, TASK-081.
- **Touched Files:** `packages/project/package.json`, `packages/project/src/schema.ts`, `packages/project/src/project.schema.json`, `packages/project/src/store.ts`, `packages/project/src/versions.ts`, `packages/project/src/archive.ts`, `tests/project-store.test.ts`, `tests/browser/project-store.spec.ts`, `package-lock.json`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Project schema v1 validated from `unknown`; records addressed by the SHA-256 of canonical JSON; Unicode NFC names with length limits; quota reporting; archives with a manifest, per-file hashes and size limits checked before allocation, as in TASK-081.
- **DoD & Acceptance Criteria:** Save, reopen, copy, export and import round-trip across a browser restart with the network disabled. Tampered and oversized archives are rejected. An edit leaves earlier experiment inputs byte-identical. Cyrillic and Latin names round-trip. An import reports each missing dependency.

### TASK-137 — Phase 1 application shell and navigation

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S01) Replace the single demo page with an English application shell that has a project context and these tabs: Project, Aircraft, Components, Sensors, Faults and interference, Weather and location, Flight tasks, Parameters, Logging, Run, Experiments and Analysis. The existing demo flight stays reachable and labeled synthetic. Keyboard operation and the automated accessibility scan stay green.
- **Dependencies:** TASK-005, TASK-085, TASK-136.
- **Touched Files:** `apps/web/src/App.tsx`, `apps/web/src/shell/AppShell.tsx`, `apps/web/src/shell/navigation.ts`, `apps/web/src/shell/ProjectBar.tsx`, `apps/web/src/style.css`, `apps/web/package.json`, `tests/app-shell.test.ts`, `tests/browser/app-shell.spec.ts`, `tests/browser/accessibility.spec.ts`, `package-lock.json`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Navigation state is restored from the project store. Physics stays out of React, and high-rate data reaches the UI only in decimated form. The demo is a selectable, explicitly synthetic mode.
- **DoD & Acceptance Criteria:** Navigation and project context survive a reload. Every tab is reachable by keyboard. The axe scan reports zero violations. A 390 px layout has no horizontal overflow. The existing demo browser tests still pass.

### TASK-138 — Aircraft profile v1 for multirotors up to eight arms and 16 motors

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S03) Define the product-level aircraft profile on top of the vehicle manifest v2 (TASK-087). It covers one to eight arms with length, azimuth, height and tilt; one or two motors per arm with pair separation; and per-motor position, thrust axis and spin. It also holds mass, CG, inertia and payload, the battery, per-motor propulsion component references, a sensor-configuration reference and the motor-to-output mapping. Derive the manifest that physics consumes. Any change to geometry or components is a new version and needs a new run.
- **Dependencies:** TASK-087, TASK-136.
- **Touched Files:** `packages/aircraft/package.json`, `packages/aircraft/src/profile.schema.json`, `packages/aircraft/src/profile.ts`, `packages/aircraft/src/layout.ts`, `packages/aircraft/src/derive-manifest.ts`, `tests/aircraft-profile.test.ts`, `tests/fixtures/aircraft/quad-x.json`, `tests/fixtures/aircraft/hexa-x.json`, `tests/fixtures/aircraft/octa-x.json`, `tests/fixtures/aircraft/coaxial-x8.json`, `tests/fixtures/aircraft/octa-coaxial-16.json`, `tests/fixtures/registry.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Profile `schemaVersion: 1` validated from `unknown`; at most 8 arms and 16 motors (the ABI v2 actuator limit `MAX_ACTUATORS = 16`); unique motor IDs and outputs; SI units and FRD body axes; positive-definite inertia; deterministic derivation to manifest v2 with provenance.
- **DoD & Acceptance Criteria:** Fixtures for the five S19 configurations validate, and their derived rotor positions, axes and spins match an independent oracle. Rejection fixtures cover 17 motors, 9 arms, duplicate outputs, a pair with inconsistent geometry and non-physical inertia. Derivation is byte-reproducible.

### TASK-139 — Component cards for motors, propellers, ESCs and batteries

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S04) Provide reusable local cards with versions, sources, attached measurements and applicability limits, with import and export. Motor: KV, winding resistance, no-load current, current and power limits, mass. Propeller: diameter, pitch, blade count, mass, and optional chord, twist and airfoil. ESC: current limit and update rate. Battery: cells, capacity, internal resistance, limits and mass. Derive BET propeller geometry from a card and list every assumption the derivation makes.
- **Dependencies:** TASK-090, TASK-136.
- **Touched Files:** `packages/aircraft/src/components.schema.json`, `packages/aircraft/src/components.ts`, `packages/aircraft/src/propeller-geometry.ts`, `tests/component-cards.test.ts`, `tests/fixtures/components/motor-example.json`, `tests/fixtures/components/propeller-example.json`, `tests/fixtures/components/esc-example.json`, `tests/fixtures/components/battery-example.json`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Card schemas with units and ranges; provenance `specification`, `measured` or `synthetic` with SHA-256; immutable card versions; geometry derivation with listed assumptions and validity flags.
- **DoD & Acceptance Criteria:** Schema fixtures cover units, ranges and missing fields. Derived geometry for an example propeller matches a hand-computed oracle. Import and export round-trip. Example cards are labeled examples and never measured data.

### TASK-140 — Calculation modes and measured component combinations

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S04, S15) Offer **Preliminary calculation** and **Calculation from measurements** in the UI. Measured mode adds manual entry and file upload of bench data (RPM, thrust, torque, voltage, current and conditions), reusing the TASK-090 bench import. Measurements bind to the exact motor, propeller, ESC and power-supply combination by card versions and are never generalized to another combination. Missing quantities and limits of use are shown. Static single-rotor data does not validate forward flight, descent or coaxial pairs. Apply the TASK-133 confidence labels.
- **Dependencies:** TASK-133, TASK-137, TASK-138, TASK-139.
- **Touched Files:** `packages/aircraft/src/calculation-mode.ts`, `packages/aircraft/src/measurements.ts`, `packages/physics/src/bench-import.ts`, `apps/web/src/library/MeasurementsEditor.tsx`, `tests/calculation-mode.test.ts`, `tests/fixtures/components/bench-combination.csv`, `tests/browser/measurements.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The mode is a property of a profile version. A measurement set records its conditions (air density or temperature and pressure, supply voltage) and a combination key built from the card versions. The labels follow TASK-133.
- **DoD & Acceptance Criteria:** Binding tests show that another combination never inherits data. Missing quantities appear as missing and are never invented. CSV files with bad units or out-of-range values are rejected. A browser test enters and uploads data, and the label changes from preliminary to measured-input only for the bound combination.

### TASK-141 — Aircraft editor with a geometry-driven 3D scheme

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S03) Edit arms (count, length, placement), one or two motors per arm and their separation, motor positions, thrust axes and spin directions; mass, CG, inertia and payload; and the battery, propulsion and sensor selections, without editing files. A 3D scheme shows each motor's identity, placement, spin direction and thrust axis. Profiles are saved, reopened and copied through the project store, and invalid edits are explained.
- **Dependencies:** TASK-015, TASK-137, TASK-138, TASK-139.
- **Touched Files:** `apps/web/src/aircraft/AircraftEditor.tsx`, `apps/web/src/aircraft/ArmTable.tsx`, `apps/web/src/aircraft/MassProperties.tsx`, `apps/web/src/aircraft/AircraftScheme3D.tsx`, `apps/web/src/style.css`, `tests/aircraft-editor.test.ts`, `tests/browser/aircraft-editor.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The editor writes only through the profile API (TASK-138). The scheme renders from the derived manifest, not from separate UI state.
- **DoD & Acceptance Criteria:** Browser tests build all five S19 configurations through the UI alone. The rendered motor positions, spins and axes equal the derived manifest. Invalid edits are blocked with a reason. Copy creates a new profile and leaves the original unchanged.

### TASK-142 — Motor-to-output mapping and frame compatibility check

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S03) Assign every motor to an ArduPilot output. Generate the frame and allocation parameters from the TASK-128 catalog, using a stock frame or the stock scripting-matrix frame. Explain any required configuration or unsupported combination. Surface a 16-motor blocker found by TASK-128 for a decision instead of hiding it.
- **Dependencies:** TASK-128, TASK-138, TASK-141.
- **Touched Files:** `packages/aircraft/src/output-mapping.ts`, `packages/aircraft/src/frame-parameters.ts`, `apps/web/src/aircraft/OutputMapping.tsx`, `tests/output-mapping.test.ts`, `tests/browser/output-mapping.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Mapping record: motor ID to output number. Generated parameters use only names present in the pinned catalog and are attached to the profile version. Unsupported combinations return a structured reason.
- **DoD & Acceptance Criteria:** Mappings round-trip. The generated parameters for the five configurations match the catalog oracle. Unsupported combinations are refused with a reason. A browser test maps a 16-motor profile, or shows the recorded blocker.

### TASK-143 — Sensors tab: ideal sensors or specified errors

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S08) Add a separate Sensors tab with **Ideal sensors** and **With specified errors**. IMU: sampling rate, noise, bias, latency, placement and orientation. GNSS: update rate, position and velocity accuracy, and latency. Barometer: noise, bias and latency. Magnetometer: noise, bias, placement and orientation. Battery voltage and current measurement: measurement errors. Settings are stored in the profile and the experiment record, and each field shows its owner, MirageSITL or ArduPilot, from the TASK-089 matrix.
- **Dependencies:** TASK-089, TASK-137, TASK-138.
- **Touched Files:** `packages/aircraft/src/sensor-config.ts`, `packages/aircraft/src/sensor-config.schema.json`, `apps/web/src/sensors/SensorsTab.tsx`, `tests/sensor-config.test.ts`, `tests/browser/sensors-tab.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Sensor configuration schema v1 with units, ranges and an owner for each error source. Ideal mode sets every MirageSITL-owned error to its neutral value. Fields that their owner cannot apply are disabled with a reason.
- **DoD & Acceptance Criteria:** Schema fixtures cover units and ranges. Ideal mode equals neutral values. Every field displays its owner. Values persist per profile version and are copied into experiments.

## Stage P1.4: Approved Physical Models

Scope step 4. Profile-driven physics with declared limits (S05–S08, S18). The existing tasks TASK-087–TASK-101 and TASK-106 deliver the core models ([PHASE1_PLAN.md](PHASE1_PLAN.md) section 4); TASK-144–TASK-149 connect them to profiles, limits, sensors, environment and accidents.

### TASK-144 — Profile-driven multirotor dynamics with up to 16 rotors

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S03, S05) Build the flight session's dynamics from an aircraft profile version instead of synthetic fixtures: up to 16 rotors with per-rotor geometry, the TASK-092 motor, ESC and battery drive from the component cards, and coaxial pairs declared for the TASK-101 coupling. Register the model with the session (`model.load`) and keep the demo as an explicit option. Geometry and component changes must change forces, not only rendering.
- **Dependencies:** TASK-088, TASK-092, TASK-138.
- **Touched Files:** `packages/physics/src/profile-dynamics.ts`, `packages/physics/src/bet-dynamics.ts`, `packages/physics/src/session-v2.ts`, `apps/web/src/physics.worker.ts`, `tests/profile-dynamics.test.ts`, `tests/browser/profile-dynamics.spec.ts`, `scripts/bench-physics.mjs`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** `SessionDynamics` built from manifest v2 through the session model registry; a rotor count of 16 or fewer, with outputs mapped through the 16-slot actuator frame; validity flags propagated to the session; no allocation in the step.
- **DoD & Acceptance Criteria:** The five S19 configurations load, and each trims to hover in a physics-only check. Changing a propeller card changes hover RPM and power in the direction an independent oracle predicts. The 16-rotor compute p50 and p99 at 400, 800 and 1200 Hz are reported against the TASK-132 budget. G1 shows zero allocation over 1e6 steps.

### TASK-145 — Measured-mode propulsion calibration

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S04, S05) In measured mode, fit the rotor and motor model to the bound combination's static thrust, torque and power versus RPM, and to its electrical data when present. Record and show the fit residuals; MirageSITL sets no fit tolerance (scope amendment of 2026-10-28). Flag operation outside the measured envelope and in non-static regimes as extrapolation. Never transfer a calibration to another combination. The task chooses between scaling the BET model and the TASK-103 table mode, with a justification.
- **Dependencies:** TASK-140, TASK-144.
- **Touched Files:** `packages/physics/src/propulsion-calibration.ts`, `tests/propulsion-calibration.test.ts`, `tests/fixtures/components/bench-combination.csv`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The calibration record holds the combination key, data hash, fitted coefficients, residuals and envelope, and is attached to the profile version. Queries outside the envelope set a validity flag.
- **DoD & Acceptance Criteria:** A synthetic oracle recovers known coefficients. A real bench file is fitted and its residuals are shown before measured mode is called working (G4). Envelope exits are flagged in the session and the recording.

### TASK-146 — Battery and propulsion limits: warnings versus modeled limiting

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S06) Battery capacity, cell count, initial charge and internal resistance drive load-dependent voltage sag and charge consumption on the TASK-092 bus. Motor and ESC current, power and RPM limits come from the cards. The UI and the logs show voltage, current, power, remaining charge and limit exceedances, and keep a rating warning distinct from limiting that the model actually applies. Heating, cooling and aging are excluded.
- **Dependencies:** TASK-092, TASK-139, TASK-144.
- **Touched Files:** `packages/physics/src/limit-monitor.ts`, `packages/physics/src/session-v2.ts`, `apps/web/src/run/PowerPanel.tsx`, `tests/limit-monitor.test.ts`, `tests/browser/power-panel.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Per-motor and battery telemetry is published through a versioned channel alongside the ABI v2 state, which does not change without a version bump. Each exceedance event is either `warning` (a rating is exceeded and physics is unchanged) or `limited` (the model clamped).
- **DoD & Acceptance Criteria:** Analytic sag and state-of-charge fixtures pass. A run that exceeds a rating shows a warning while physics continues. A run that reaches a modeled clamp shows `limited`. Per-motor values reach the recording. G1 passes.

### TASK-147 — Sensor error configuration in the external-SITL path

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S08) Apply the Sensors tab configuration in the external-SITL session according to the TASK-089 ownership matrix. MirageSITL applies the errors it owns to the observations it delivers (the JSON state line and the GNSS injection path). ArduPilot-owned errors are set through generated, catalog-verified `SIM_*` parameters. Implement IMU and magnetometer placement (lever arm) and orientation, and battery voltage and current measurement errors on a verified delivery path. Ideal mode neutralizes both sides where possible and records what cannot be neutralized. This is the Phase 1 subset of TASK-115.
- **Dependencies:** TASK-035, TASK-089, TASK-143.
- **Touched Files:** `packages/sensors/src/configured.ts`, `packages/sensors/src/lever-arm.ts`, `packages/autopilot/src/external-sitl.ts`, `packages/autopilot/src/error-ownership.ts`, `tests/sensor-configured.test.ts`, `tests/lever-arm.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** `a_IMU = a + ω̇×r + ω×(ω×r)` and the sensor-to-body rotation, as in the TASK-115 contract. Ownership validation runs before arming. Seeded noise uses fixed stream IDs.
- **DoD & Acceptance Criteria:** Matrix validation and a runtime test show that no error is applied twice. Lever-arm and misalignment fixtures match analytic values. Seeded runs are reproducible. The experiment record lists the ArduPilot-side terms that Ideal mode cannot neutralize, for example the unconditional IMU noise floors without decision D-10.

### TASK-148 — Location and geographic environment

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S07) Choose the location on an available map or by coordinates. Use terrain elevation above sea level from available data with an authoritative, hashed geoid grid, or use the synthetic pad. Compute WGS84 normal gravity by latitude and height and the WMM main magnetic field. Keep pressure consistent with altitude, with a measured QNH override from TASK-093. Set the ArduPilot home position consistently with MirageSITL, and show and record the effective conditions the calculation uses. This is the Phase 1 subset of TASK-108; anomaly fields and vehicle magnetic interference stay deferred.
- **Dependencies:** TASK-036, TASK-093, TASK-131.
- **Touched Files:** `packages/sensors/src/gravity.ts`, `packages/sensors/src/geomagnetic.ts`, `packages/sensors/src/geoid.ts`, `data/geoid/inventory.json`, `apps/web/src/weather/LocationPicker.tsx`, `packages/physics/src/session-v2.ts`, `tests/gravity.test.ts`, `tests/geomagnetic.test.ts`, `tests/browser/location.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Somigliana normal gravity with height correction and the WMM2025 main field, as in the TASK-108 contract. A geoid grid with source, license and SHA-256. An effective-conditions record holding location, elevation, gravity, magnetic field, temperature, pressure and density.
- **DoD & Acceptance Criteria:** Gravity matches the NIMA TR8350.2 reference values within 1e-9 relative. Field values match the WMM2025 test values within published tolerances. Home and origin consistency between MirageSITL and ArduPilot is checked at start. The TASK-036 MSL gate becomes available only with a hashed geoid grid. A browser test picks a location and shows the effective conditions.

### TASK-149 — Accident detection and automatic pause

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S18) Record contact of the body or a propeller as an accident: TASK-095 propeller-strike events, or body contact outside the support points. The accident pauses the run, preserving state and logs, and contact loads and events are recorded. A run may continue after an accident, but the continuation is labeled as not validated for a physically damaged aircraft. User-commanded motor failures remain independent.
- **Dependencies:** TASK-095, TASK-144.
- **Touched Files:** `packages/physics/src/accident.ts`, `packages/physics/src/session-v2.ts`, `tests/accident.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Accident event: tick, contact location, body or propeller, impulse and contact load. The session pauses on that tick through the same path as a user pause, which TASK-156 connects to ArduPilot. A post-accident flag is set on the experiment.
- **DoD & Acceptance Criteria:** A hard landing on the support points raises no accident. An arm or propeller strike raises an accident on the correct tick. The run pauses on that tick. The event and the contact loads appear in the recording. Continuation is visibly labeled.

## Stage P1.5: Integrated External-SITL Session

Scope step 5. Launch, connect, fly and pause native ArduPilot on macOS through the application (S01–S03). Sequential batches wait until TASK-158 passes.

### TASK-150 — MAVLink message set for Phase 1 ground-station functions

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S02, S09, S10, S11) Extend the MAVLink2 codec, with golden pymavlink 2.4.50 fixtures, to the messages Phase 1 needs: the parameter list request and parameter payload builders; COMMAND_LONG, COMMAND_INT and COMMAND_ACK; STATUSTEXT and SYS_STATUS; ATTITUDE, LOCAL_POSITION_NED, GLOBAL_POSITION_INT and VFR_HUD; SERVO_OUTPUT_RAW and BATTERY_STATUS; the mission protocol; and the position-target messages. Update `dialect.lock.json`, which lists only 4 of the 12 message IDs the codec supports today.
- **Dependencies:** TASK-037.
- **Touched Files:** `packages/mavlink/src/codec.ts`, `packages/mavlink/src/messages.ts`, `packages/mavlink/dialect.lock.json`, `scripts/generate-mavlink-fixtures.py`, `tests/fixtures/mavlink/golden.json`, `tests/mavlink.test.ts`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Unsigned MAVLink2 only, as today; byte-exact packing with CRC_EXTRA; preallocated decode targets for the high-rate telemetry subset; unsupported frames consumed whole, preserving the TASK-047 repair.
- **DoD & Acceptance Criteria:** Every added message matches pymavlink bytes. Chunking, truncation and bad-CRC tests pass. G1 holds for the high-rate subset. The dialect lock matches the codec.

### TASK-151 — Local launcher service for macOS

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S01, S02) Provide a local loopback service that the user starts. It checks prerequisites and keeps a catalog of the installed compatible ArduPilot versions. It starts and stops owned SITL processes with per-experiment working directories and parameter files, collects diagnostics and DataFlash logs, and hosts the WebSocket bridge. A normal web page cannot start programs; the launcher is the only component that does.
- **Dependencies:** TASK-040, TASK-127.
- **Touched Files:** `apps/launcher/package.json`, `apps/launcher/src/server.ts`, `apps/launcher/src/processes.ts`, `apps/launcher/src/prerequisites.ts`, `apps/launcher/src/catalog.ts`, `apps/launcher/src/logs.ts`, `tests/launcher.test.ts`, `package-lock.json`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** A versioned loopback API (status, prerequisites, start, stop, logs, catalog) authenticated with a locally generated token and an exact Origin match; it binds to loopback only and records process ownership. Tokens are never printed or put in URLs.
- **DoD & Acceptance Criteria:** Start, stop, crash and restart cases pass with fake and real binaries. Processes the launcher does not own are never touched. Unauthorized origins and tokens are rejected. The service works offline on a reference Mac (G4).

### TASK-152 — macOS installation and first-run prerequisite check

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S01, S02) Provide an installation path that downloads or builds the pinned dependencies with hash verification: ArduPilot sources at the selected commits, the Python environment with pymavlink, and the application and UAVLogViewer assets. Add a first-run screen that checks the launcher connection and each prerequisite, and explains what is missing and how to fix it. After installation the workflows run offline.
- **Dependencies:** TASK-131, TASK-151.
- **Touched Files:** `scripts/install-macos.mjs`, `apps/launcher/src/prerequisites.ts`, `apps/web/src/shell/FirstRun.tsx`, `tests/install-macos.test.ts`, `tests/browser/first-run.spec.ts`, `docs/operations/install-macos.md`, `docs/ru/install-macos.md`, `docs/documentation-index.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** An install manifest built from the TASK-131 inventory records the hash, size and license of every item. Each prerequisite check returns a structured missing or ok result with a fix instruction. No secrets are stored.
- **DoD & Acceptance Criteria:** A clean installation on a reference Mac is recorded. Each missing prerequisite produces its specific message. Restart and offline launch succeed with the network disabled.

### TASK-153 — Browser physics as the JSON lockstep backend for native ArduPilot

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S01, S02, S03) Run the profile dynamics in the physics Worker in SITL lockstep with native ArduPilot over the launcher's bridge: servo packets come in for up to 16 outputs and JSON state lines go out. MAVLink travels over the same bridge to the application's ground-station functions. READY is admitted only from this session's live EKF diagnostics (LiveEkfWarmup), never from offline captures. Overload and dropped steps are visible.
- **Dependencies:** TASK-043, TASK-129, TASK-144, TASK-150, TASK-151.
- **Touched Files:** `apps/web/src/physics.worker.ts`, `apps/web/src/runtime.ts`, `apps/web/src/sitl/bridge-client.ts`, `packages/autopilot/src/external-sitl.ts`, `packages/autopilot/src/live-warmup.ts`, `packages/physics/src/session-v2.ts`, `packages/physics/src/clock-policy.ts`, `apps/bridge/src/server.ts`, `apps/bridge/src/session.ts`, `tests/external-sitl-session.test.ts`, `tests/browser/external-sitl.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The `sitl-lockstep` clock policy; servo-to-rotor mapping from the profile; the existing bridge framing, epochs and limits; the autopilot state-machine lifecycle `disconnected → initializing → warming → ready → running → fault`; zero allocation in the lockstep step.
- **DoD & Acceptance Criteria:** On macOS, a profile-defined quad arms, takes off, holds and lands through the browser application. Lost, duplicated and reordered packets never double-step. Stale diagnostics revoke READY. G1 holds for the step. No offline report admits READY.

### TASK-154 — Experiment start, stop, readiness and failure handling

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S02) The user selects a profile version and a compatible ArduPilot version and starts an experiment. The launcher spawns SITL with the generated frame, output, sensor and initial parameters, and the UI shows connection, parameter loading and EKF readiness. Stop terminates only the experiment's own processes. Every failure shows its reason, a diagnostic log and a restart path. Changing model characteristics requires a new run.
- **Dependencies:** TASK-136, TASK-142, TASK-153.
- **Touched Files:** `apps/web/src/run/RunPanel.tsx`, `apps/web/src/run/session-controller.ts`, `apps/launcher/src/processes.ts`, `tests/run-controller.test.ts`, `tests/browser/run-panel.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Run states: idle, starting, loading parameters, warming, ready, running, paused, stopping, and failed with a reason. The experiment record stores the profile version, the ArduPilot version and binary hash, and the initial parameters.
- **DoD & Acceptance Criteria:** Fault-injection tests (missing binary, busy port, crash during warmup, bridge loss) show the reason and a working restart. Stop leaves no owned process behind. The experiment record contains every version and parameter used.

### TASK-155 — Manual connection to a running compatible SITL

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S02) Connect to an ArduPilot SITL that the user started; disconnecting never terminates it. Check compatibility: version, frame, and JSON lockstep with MirageSITL physics. Enable pause only for configurations that TASK-129 classified as clock-compatible.
- **Dependencies:** TASK-129, TASK-153.
- **Touched Files:** `apps/web/src/run/ManualConnect.tsx`, `apps/web/src/run/session-controller.ts`, `apps/launcher/src/server.ts`, `tests/browser/manual-connect.spec.ts`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Connection descriptor: JSON physics and MAVLink endpoints, plus a compatibility verdict with its reasons. Ownership is `external`, so stop and disconnect only release the connection.
- **DoD & Acceptance Criteria:** Connect and disconnect cycles leave the external process running. Incompatible configurations are refused with reasons. Pause is disabled, with an explanation, where the clock is not compatible.

### TASK-156 — Synchronized pause and resume in integrated sessions

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S02) Pause freezes physics and ArduPilot simulated time together (per TASK-129), retaining position, velocity, aircraft state and scenario progress, and must not itself cause sensor or link-loss failsafes. The bridge keeps paused sessions alive, and charts and logs stay viewable. Parameter changes are allowed where TASK-129 showed support, with restart and disarm requirements visible. Pause and resume events are recorded, and paused wall time does not extend the simulated duration. Accident pauses (TASK-149) and missing-terrain pauses use the same path. Define a tab-visibility policy that never silently continues on stale manual input.
- **Dependencies:** TASK-129, TASK-149, TASK-153.
- **Touched Files:** `packages/physics/src/session-v2.ts`, `packages/physics/src/clock-policy.ts`, `packages/scenarios/src/runner.ts`, `apps/web/src/runtime.ts`, `apps/web/src/run/RunPanel.tsx`, `apps/bridge/src/server.ts`, `apps/bridge/src/session.ts`, `tests/session-pause.test.ts`, `tests/browser/sitl-pause.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** One pause path with a reason (`user`, `accident`, `terrain`, `visibility`); a keep-alive for paused bridge sessions; pause and resume events with tick and wall time.
- **DoD & Acceptance Criteria:** A pause of at least 10 min in hover resumes within the TASK-129 continuity tolerance with no failsafe. Events appear in the record. Simulated duration excludes paused wall time. Browser tests cover a user pause, an accident pause and a hidden-tab pause.

### TASK-157 — Virtual one-motor-at-a-time check

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S03) Before flight, spin each motor individually through ArduPilot's motor-test command in SITL. The 3D scheme highlights the motor that physics actually drives, with its spin direction. A mismatch between the expected and the observed output or spin is reported.
- **Dependencies:** TASK-141, TASK-142, TASK-154.
- **Touched Files:** `apps/web/src/aircraft/MotorTest.tsx`, `apps/web/src/run/session-controller.ts`, `tests/browser/motor-test.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** A motor-test sequence per output, disarmed and on the ground only. The result per motor is the expected output, the observed output, the observed spin, and pass or fail.
- **DoD & Acceptance Criteria:** All five configurations pass. A deliberately swapped mapping and a reversed spin are detected. The test refuses to run while armed or airborne.

### TASK-158 — Nominal flight acceptance on macOS

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S01–S03) Through the UI on a reference Mac: create the profile, map outputs, run the motor test, start, arm, take off, hover, land, pause and resume, and stop. Do this first for a quad with one motor per arm, then for the remaining S19 configurations, including the 16-motor one. Sequential batches (TASK-176) wait for this task.
- **Dependencies:** TASK-095, TASK-146, TASK-147, TASK-152, TASK-155, TASK-156, TASK-157.
- **Touched Files:** `scripts/phase1/nominal-flight.mjs`, `tests/integration/phase1-nominal.test.ts`, `docs/validation/phase1-matrix.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Evidence per configuration: capture hashes, versions, device, browser and OS, with verdicts written to the TASK-132 matrix.
- **DoD & Acceptance Criteria:** Each of the five configurations has a current PASS capture or an exact blocker in the matrix. Historical WSL captures are not reused.

## Stage P1.6: Recording and Parameter Provenance

Scope step 6. Parameter read, write, read-back and export, and full-run recording with provenance, before comparative runs rely on them (S11, S13, S16).

### TASK-159 — ArduPilot parameter service with read-back and metadata

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S11) Download the full parameter list with index and count tracking and retries. Write with PARAM_SET and confirm by read-back, distinguishing requested, refused, confirmed and timed-out values. Generate parameter metadata (units, ranges, groups, reboot-required) offline from the pinned ArduPilot source of each supported version. Show values at full precision, for example `0.00017`, never `0.00`.
- **Dependencies:** TASK-150, TASK-153.
- **Touched Files:** `packages/autopilot/src/param-service.ts`, `packages/autopilot/src/param-metadata.ts`, `scripts/generate-param-metadata.mjs`, `data/ardupilot/param-metadata.json`, `tests/param-service.test.ts`, `tests/integration/param-sitl.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Parameter states `requested`, `refused`, `confirmed`, `timeout` and `stale`; float32 wire values stored exactly; metadata keyed by ArduPilot commit; the reboot-required flag taken from metadata.
- **DoD & Acceptance Criteria:** The full list downloads from native SITL. Every write's outcome is confirmed by read-back or classified. Reboot-required parameters are flagged. Value formatting round-trips the exact float32.

### TASK-160 — Parameters tab: editing, history and parameter sets

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S11) Read the actual SITL parameters and edit them before and during flight, and on pause where supported. Show requested, refused and confirmed values and the disarm or restart each change needs. Record every change with its name, old and new value, time, outcome and experiment. Save and compare parameter sets and send earlier values back. Storage confirmation is never presented as applied behavior when a restart is needed.
- **Dependencies:** TASK-137, TASK-156, TASK-159.
- **Touched Files:** `apps/web/src/params/ParametersTab.tsx`, `apps/web/src/params/ParameterHistory.tsx`, `apps/web/src/params/parameter-sets.ts`, `packages/project/src/schema.ts`, `tests/parameter-sets.test.ts`, `tests/browser/parameters-tab.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Parameter-change event: name, old value, new value, request time, outcome, simulated tick and experiment ID. A parameter set is a versioned record with its source.
- **DoD & Acceptance Criteria:** A browser test against SITL covers every state, including a write while paused or its documented refusal. Restart-required changes are never labeled applied. History persists with the experiment.

### TASK-161 — ArduPilot parameter file export

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S11) At any stage, export an ArduPilot-compatible parameter file for the user to load manually. It contains all available parameters, the changes relative to a selected baseline, or selected parameters and groups. Before export, preview the contents and each value's source: saved profile, experiment, or actual SITL read-back. Pending and unconfirmed requests are not exported as confirmed live values. The aircraft, firmware and experiment context accompanies the file. Simulator-only geometry and weather settings are saved separately. Nothing is written to a real controller.
- **Dependencies:** TASK-159, TASK-160.
- **Touched Files:** `packages/autopilot/src/param-file.ts`, `apps/web/src/params/ParameterExport.tsx`, `tests/param-file.test.ts`, `tests/browser/parameter-export.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** A parameter file with a comment header for context, `NAME,VALUE` lines at full float32 precision and a deterministic order. A separate simulator-settings file uses the project archive format.
- **DoD & Acceptance Criteria:** An exported file loaded back into SITL reproduces identical values. Pending values are excluded. Baseline-difference and group selections match oracles. The context header is present.

### TASK-162 — Experiment recorder v2 with full-run streaming and per-signal rates

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S13) Build a signal catalog with each source's native rate: truth, per-motor RPM, current and power, battery, sensor observations, actuator outputs, autopilot telemetry including the EKF estimate, and events. Recording uses a common rate with per-signal and per-group overrides. The effective rate is the lower of the requested and source rates, without duplicated samples, and 2 kHz is offered only for sources that produce it. Record the parameter snapshot and change events, and weather, fault, pause and accident events. Stream to local storage without the 32 MiB cap of TASK-076, with explicit gaps. Store channel, rate and availability metadata so that omitted data is never read as zero.
- **Dependencies:** TASK-076, TASK-136, TASK-153.
- **Touched Files:** `packages/aar/src/format-v2.ts`, `packages/aar/src/signal-catalog.ts`, `packages/aar/src/stream-storage.ts`, `packages/aar/src/recorder-v2.ts`, `apps/web/src/physics.worker.ts`, `tests/recorder-v2.test.ts`, `tests/browser/recorder-v2.spec.ts`, `scripts/bench-aar.mjs`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Format v2 with a versioned header, signal table and chunk checksums. Fan-out happens at the producer boundary with one consumer per queue. Physics never waits on storage.
- **DoD & Acceptance Criteria:** A one-hour simulated run, accelerated in the test, records continuously within the storage budget. Sample counts prove the effective rates. A 2 kHz request on a 1200 Hz source is capped and the cap is shown. G1 holds at the producer. The record reopens after a restart.

### TASK-163 — Logging tab with size estimates and storage monitoring

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S13) Add a separate Logging tab. All available signals are enabled by default, with the common default frequency from TASK-132 and per-signal or per-group overrides. Show requested and effective rates and each source's limit. Estimate MB per simulated hour and the total for a selected duration, then show actual growth, including growth per real second in accelerated runs. Warn before storage runs out and show recording gaps.
- **Dependencies:** TASK-132, TASK-137, TASK-162.
- **Touched Files:** `apps/web/src/logging/LoggingTab.tsx`, `apps/web/src/logging/size-estimate.ts`, `tests/size-estimate.test.ts`, `tests/browser/logging-tab.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The estimate is computed from the signal catalog and the format overhead. The storage quota is read from the browser storage API. Warning thresholds are recorded in the experiment.
- **DoD & Acceptance Criteria:** Estimates fall within a tolerance, declared before the test, of the actual sizes. A low-quota test warns before exhaustion. Unsupported rates are refused with an explanation. Gaps are visible.

### TASK-164 — ArduPilot DataFlash capture per experiment

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S13, S14) Configure and verify SITL DataFlash logging: the `LOG_*` parameters are checked against metadata and capabilities, not assumed arbitrary. Collect each run's `.BIN` files from the launcher's working directory into the experiment with hashes, kept separate from the MirageSITL recorder.
- **Dependencies:** TASK-151, TASK-154, TASK-159.
- **Touched Files:** `apps/launcher/src/logs.ts`, `packages/project/src/schema.ts`, `tests/dataflash-capture.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Experiment attachment: file name, size, SHA-256, ArduPilot version and logging parameters. Missing and partial logs are reported, never synthesized.
- **DoD & Acceptance Criteria:** Every run's `.BIN` is attached and hashed. The configured logging is confirmed from the log contents. A missing or truncated log is reported.

### TASK-165 — Experiment lifecycle: Repeat, Create variant, export and import

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S16) An experiment fixes the aircraft version, the ArduPilot version and initial parameters, weather and location, the task, the fault schedule and the recording setup. It retains results and in-flight parameter, environment and fault events. **Repeat** reuses the same inputs; **Create variant** preserves the original while allowing changes. Reproducibility means preserved inputs and declared tolerances, not bit-identical outputs on every machine. Export and import report missing external dependencies.
- **Dependencies:** TASK-136, TASK-154, TASK-160, TASK-162.
- **Touched Files:** `packages/project/src/experiment.ts`, `apps/web/src/experiments/ExperimentsTab.tsx`, `tests/experiment-lifecycle.test.ts`, `tests/browser/experiments-tab.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Experiment record v1 references hashed inputs. A variant keeps a link to its parent. The reproducibility tolerance is stored with the experiment.
- **DoD & Acceptance Criteria:** Repeating a seeded run on the same machine matches within the declared tolerance. A variant leaves the original unchanged. An import into another store lists the missing dependencies.

## Stage P1.7: Flight Tasks, Weather, Faults and Batches

Scope step 7. Reproducible tasks, manual and scheduled effects, EKF-drift observations, run speed and user-defined batches (S07, S09, S10, S12).

### TASK-166 — Effect control contract for weather, sensor errors and faults

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S07, S08, S09) Give every environment, sensor-error, EW and fault effect a user-facing control: an on/off switch and an intensity setting, carried by a versioned control record with an identifier, an enabled flag, a dimensionless intensity, and physical parameters with units. Controls are set through the control protocol and the instructor console, apply at tick boundaries with acknowledgements, and can be scheduled with onset, duration and recovery. Every injected effect is off by default, and an effect that is off or at zero intensity is bitwise identical to an absent one. ArduPilot-side SITL errors keep the TASK-089 ownership setting, whose default is ArduPilot's own behavior. This task carries the user's request of 2026-10-27, first registered on the physics-review branch as an effect-control task numbered TASK-124; TASK-135 retired that number because main already uses it.
- **Dependencies:** TASK-010, TASK-075, TASK-079, TASK-089, TASK-093, TASK-156.
- **Touched Files:** `packages/protocol/src/control-v3.ts`, `packages/protocol/src/control-v3.schema.json`, `packages/protocol/src/control-v2.ts`, `packages/physics/src/session-v2.ts`, `packages/scenarios/src/schema.ts`, `apps/web/src/instructor/Console.tsx`, `apps/web/src/instructor/commands.ts`, `tests/control-v3.test.ts`, `tests/session-v2.test.ts`, `tests/browser/instructor.spec.ts`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** A Control Protocol version bump with migration of v2 `weather.set` and `fault.set`, and rejection fixtures. `intensity` ≥ 0, where 1 is the configured nominal magnitude. Queued, applied and rejected acknowledgements. Every range equals the owning model's validity envelope, which resolves today's mismatches: turbulence RMS is 0–30 m/s in the protocol but 0–50 m/s in the gust model; temperature is 200–340 K against 180–330 K; wind is ±100 m/s against ±200 m/s per axis; and the protocol has no gust-bandwidth field. Covered effects: mean wind, gusts and turbulence (TASK-032, TASK-106); shear and terrain flow (TASK-107); thermals and hazard flows (TASK-121, TASK-122); atmosphere offsets (TASK-093); MirageSITL sensor errors (TASK-115–TASK-117, TASK-147); EW effects (TASK-053–TASK-056, composed by TASK-058); and motor faults (TASK-057). ArduPilot SITL errors are covered through the TASK-089 ownership setting. Effect tasks registered later declare their control under this contract, and a backend that cannot apply an effect keeps rejecting its control visibly.
- **DoD & Acceptance Criteria:** Every covered effect has a control record whose ranges equal its model envelope, and the existing `weather.set` and `fault.set` fields map onto these records. Migration and rejection tests and JSON fixtures pass. For every effect, disabled and zero intensity are bitwise identical to absent over a seeded run. Intensity scaling matches each model's definition against an independent oracle; for example, gust RMS scales linearly. The instructor console exposes every control with pending, applied and rejected status from the TASK-075 ledger, replacing today's hard-coded presets (north wind only, fixed EW magnitudes). Scenario files schedule controls with tick-bound acknowledgements (TASK-079), and scheduled effects apply on their exact ticks.

### TASK-167 — Weather tab with scheduled changes and repeatable gusts

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S07) Provide settings for steady wind speed and direction; discrete gusts with strength, duration and direction; turbulence intensity (TASK-106); temperature; and pressure consistent with altitude, with a measured override. Weather can change during flight, manually or from a saved schedule, and the changes are logged. Seeded gust and turbulence realizations repeat for controlled comparisons, and the effective conditions are visible.
- **Dependencies:** TASK-106, TASK-137, TASK-148, TASK-166.
- **Touched Files:** `apps/web/src/weather/WeatherTab.tsx`, `packages/physics/src/discrete-gust.ts`, `tests/discrete-gust.test.ts`, `tests/browser/weather-tab.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The discrete-gust shape and its parameters are declared in the engine specification before implementation. Schedules use the TASK-166 records. Seed and stream IDs are stored with the experiment.
- **DoD & Acceptance Criteria:** The gust shape matches its analytic definition. The same seed reproduces the same realization. Scheduled changes apply on their tick. A browser test sets wind on a running SITL session, observes the effect and removes it.

### TASK-168 — Sensor dropout, frozen readings and link-loss effects

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S09) Add missing and frozen IMU, GNSS, barometer and magnetometer readings, delivered on each sensor's ownership path; for ArduPilot-owned sensors this uses catalog-verified fault parameters. Add loss of pilot control and loss of the ground-station link at the bridge. Wire reduced motor power and motor failure (TASK-057) into the profile dynamics. Observations and links change; truth does not.
- **Dependencies:** TASK-057, TASK-147, TASK-153, TASK-166.
- **Touched Files:** `packages/ew/src/sensor-dropout.ts`, `apps/bridge/src/link-faults.ts`, `packages/physics/src/profile-dynamics.ts`, `packages/autopilot/src/error-ownership.ts`, `tests/sensor-dropout.test.ts`, `tests/link-faults.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Effects are expressed as TASK-166 records. Link loss acts on the bridge's MAVLink channels without touching JSON physics. Motor faults act on physical actuation only.
- **DoD & Acceptance Criteria:** Each effect changes only its observation, link or actuator. Truth arrays stay bitwise identical for sensor and link effects. ArduPilot's response is recorded, not predicted. G1 holds for tick application.

### TASK-169 — Faults and interference tab with schedules and outcomes

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S09) Add a separate tab that configures motor failure and reduced power, GNSS loss or degradation, GNSS position steps and gradual drift, magnetic interference, missing or frozen readings, and loss of pilot control or the ground-station link. Effects apply manually or on a schedule with onset, duration and recovery. Events and actual outcomes (pending, applied, rejected) are recorded.
- **Dependencies:** TASK-137, TASK-166, TASK-168.
- **Touched Files:** `apps/web/src/faults/FaultsTab.tsx`, `apps/web/src/faults/schedule.ts`, `apps/web/src/instructor/Console.tsx`, `tests/fault-schedule.test.ts`, `tests/browser/faults-tab.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Schedules are stored with the experiment. The outcome ledger extends the TASK-075 acknowledgement ledger.
- **DoD & Acceptance Criteria:** A browser test schedules and applies each effect class against SITL. Outcomes are visible and recorded. Unsupported effects are visibly rejected.

### TASK-170 — EKF drift scenario with truth-versus-estimate charts

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S09) Build the **EKF drift** input-error scenario on the TASK-055 coherent drift, delivered on the GNSS path. The UI configures direction, growth rate, duration, and gradual or abrupt removal. The scenario never overwrites ArduPilot's EKF or forces a trajectory. Charts compare the true trajectory and velocity with the EKF estimate from autopilot telemetry and show their errors. ArduPilot may drift, reject measurements or enter failsafe; its actual reaction is recorded.
- **Dependencies:** TASK-055, TASK-150, TASK-162, TASK-169.
- **Touched Files:** `packages/scenarios/src/ekf-drift.ts`, `apps/web/src/analysis/TruthVsEstimate.tsx`, `tests/ekf-drift.test.ts`, `tests/browser/ekf-drift.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Drift-profile parameters with units; estimate and truth aligned on simulated time; error series computed from the recording.
- **DoD & Acceptance Criteria:** The drift profile matches its analytic form. Chart errors match an independent computation from the recorded truth and estimate. No response is promised or hard-coded.

### TASK-171 — Refresh EW and fault regression evidence on macOS native SITL

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S09) Recalibrate and revalidate the TASK-059 matrix on native SITL on macOS against the current EW sources, which TASK-125, TASK-126 and the Phase 1 effects changed. The historical Linux and WSL reports stay unchanged as history.
- **Dependencies:** TASK-059, TASK-127, TASK-168.
- **Touched Files:** `tests/fixtures/scenarios/ew-matrix.json`, `scripts/run-ew-sitl.mjs`, `scripts/freeze-ew.mjs`, `scripts/sitl/audit-ew.mjs`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The frozen source closure, firmware hash and parameters work as in TASK-059. The new matrix records the macOS host.
- **DoD & Acceptance Criteria:** New calibration and validation flights pass the frozen limits with the current source closure. The earlier reports are untouched.

### TASK-172 — Flight task library with routes and initial conditions

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S10) Provide repeatable takeoff, hover, landing, straight flight, climb, descent, acceleration, braking and turning tasks. Route points, altitudes and speeds are entered through the UI. ArduPilot receives the commands (mission upload or guided commands), and physics calculates the resulting motion. Initial position, attitude, speed and battery charge are configurable; mass and payload stay in the aircraft profile. Requested and actual values are shown side by side.
- **Dependencies:** TASK-150, TASK-153, TASK-165.
- **Touched Files:** `packages/scenarios/src/flight-tasks.ts`, `packages/autopilot/src/mission.ts`, `packages/autopilot/src/guided.ts`, `apps/web/src/tasks/FlightTasksTab.tsx`, `apps/web/src/tasks/RouteEditor.tsx`, `tests/flight-tasks.test.ts`, `tests/integration/flight-tasks-sitl.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Task definition v1 (type, parameters, route, initial conditions) stored with the experiment. Missions use the MAVLink mission protocol with acknowledgements. Initial conditions are applied at the start tick before arming.
- **DoD & Acceptance Criteria:** Each task type completes in SITL with recorded requested and actual traces. The route editor round-trips. Initial conditions are verified in the truth state at the start tick.

### TASK-173 — Tuning maneuvers with requested-versus-actual response

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S10) Command changes in roll, pitch, heading and altitude (steps and doublets with configurable amplitude and duration), and display requested versus actual response with rise-time, overshoot and settling metrics.
- **Dependencies:** TASK-162, TASK-172.
- **Touched Files:** `packages/scenarios/src/maneuvers.ts`, `apps/web/src/tasks/ManeuverPanel.tsx`, `apps/web/src/analysis/ResponsePlot.tsx`, `tests/maneuvers.test.ts`, `tests/browser/maneuvers.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Maneuver definitions are stored with the experiment. Metrics are computed from the recorded series on one time base.
- **DoD & Acceptance Criteria:** Metrics match an analytic second-order fixture. The maneuvers execute in SITL. The plots are time-aligned.

### TASK-174 — Manual flight with a controller in integrated sessions

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S10) Fly ArduPilot with the calibrated USB controller through RC override over the bridge. Stale input, unplugging and reconnection follow the existing input-safety rules, and the pilot-link-loss effect (TASK-168) acts on this path.
- **Dependencies:** TASK-038, TASK-153.
- **Touched Files:** `apps/web/src/runtime.ts`, `apps/web/src/sitl/bridge-client.ts`, `packages/mavlink/src/rc-override.ts`, `tests/browser/manual-flight.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** RC override at a declared rate, with the channel-group sentinels of TASK-038. Disconnecting never silently selects another transmitter.
- **DoD & Acceptance Criteria:** A browser test with a mocked gamepad arms and flies SITL. Unplugging triggers the defined policy. Thrust is never held on stale input.

### TASK-175 — Real-time and accelerated runs with visible actual speed

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S10) Run the same physics with the same step sequence in real-time and accelerated modes. Acceleration is limited only by the host and is never achieved by simplifying the model or skipping steps. Actual simulation speed and overload are visible, and a run that falls behind is never presented as real-time. No fixed acceleration factor is promised.
- **Dependencies:** TASK-132, TASK-153, TASK-156.
- **Touched Files:** `packages/physics/src/clock-policy.ts`, `apps/web/src/physics.worker.ts`, `apps/web/src/run/SpeedIndicator.tsx`, `tests/run-speed.test.ts`, `tests/browser/run-speed.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Run-speed modes `real-time` and `as-fast-as-possible`. The displayed speed is the measured simulated/wall ratio over a window. Dropped intervals are counted and shown.
- **DoD & Acceptance Criteria:** Seeded trajectories in both modes agree within a tolerance declared before the test. The displayed speed equals the measured ratio. A real-time run with drops is labeled as such.

### TASK-176 — Sequential user-defined parameter batches

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S12) The user supplies several parameter sets. The same scenario runs automatically and sequentially for each set with all other inputs identical, and the collected results can be inspected. The system does not search for new values or declare a set fit for real flight.
- **Dependencies:** TASK-158, TASK-161, TASK-165, TASK-172.
- **Touched Files:** `apps/web/src/experiments/BatchRunner.tsx`, `packages/project/src/batch.ts`, `tests/batch.test.ts`, `tests/browser/batch.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Batch record: scenario, parameter sets and the resulting experiment IDs. Failed runs are recorded and never retried silently.
- **DoD & Acceptance Criteria:** N sets produce N experiments with identical non-parameter inputs. One failed run does not corrupt the others. There is no automatic optimization path.

### TASK-177 — Experiment comparison and result metrics

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S12) Copy a profile, change motors, propellers or other settings, and compare experiments: different conditions for one aircraft, or equal conditions for different configurations. Controlled comparisons preserve payload, battery, weather and task as selected, and account explicitly for changes in the components' own mass. Results include takeoff capability and thrust margin; RPM, current, power and energy; estimated flight duration for a stated scenario; position and maneuver response; and component limit exceedances. The calculation mode and input confidence stay visible.
- **Dependencies:** TASK-140, TASK-146, TASK-165, TASK-173.
- **Touched Files:** `packages/analysis/package.json`, `packages/analysis/src/metrics.ts`, `packages/analysis/src/compare.ts`, `apps/web/src/compare/CompareTab.tsx`, `tests/experiment-metrics.test.ts`, `tests/browser/compare-tab.spec.ts`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Metric definitions, with units and formulas, are declared in the engine specification. Each comparison lists the inputs held equal and the ones that differ. Flight-duration estimates name their scenario and reserve assumptions.
- **DoD & Acceptance Criteria:** Metrics match hand-computed fixtures. A comparison whose controls differ unexpectedly is flagged. Confidence labels are shown.

## Stage P1.8: Log Analysis with UAVLogViewer

Scope step 8. Integrate the existing UAVLogViewer for DataFlash and experiment logs (S14), building on TASK-130.

### TASK-178 — DataFlash reader and writer

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S14, S15) Parse self-describing DataFlash logs (FMT records first) in a Worker: chunked and validated, with damaged ranges reported. Write MirageSITL experiment records (truth, motor telemetry, events, and parameter changes with requested, confirmed and rejected status) as DataFlash files that the viewer can open.
- **Dependencies:** TASK-004.
- **Touched Files:** `packages/dataflash/package.json`, `packages/dataflash/src/reader.ts`, `packages/dataflash/src/writer.ts`, `packages/dataflash/src/dataflash.worker.ts`, `scripts/generate-dataflash-fixtures.py`, `tests/dataflash.test.ts`, `tests/fixtures/dataflash/reference.json`, `tests/fixtures/registry.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The reader outputs typed columns per message type, with units from FMTU where present. The writer uses distinct message names for MirageSITL data so that it is never confused with data the autopilot logged.
- **DoD & Acceptance Criteria:** Field values and times match pymavlink's `mavlogdump` on reference logs. Writer output re-parses identically. Damaged-file fixtures report their ranges.

### TASK-179 — Bundle the pinned UAVLogViewer for offline use

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S14) Build the pinned viewer from source with recorded hashes and license notices, serve it locally inside the Analysis tab under the application's isolation headers, and open real DataFlash logs offline.
- **Dependencies:** TASK-130, TASK-137, TASK-152.
- **Touched Files:** `third_party/uavlogviewer/source.lock.json`, `scripts/build-uavlogviewer.mjs`, `apps/web/src/analysis/LogViewerHost.tsx`, `apps/web/vite.config.ts`, `tests/browser/log-viewer.spec.ts`, `docs/operations/offline-inventory.md`, `docs/ru/offline-inventory.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The host and the viewer communicate only through the interface chosen in TASK-130. The viewer's network access is limited to local assets.
- **DoD & Acceptance Criteria:** An offline browser test opens a reference `.bin`. License notices ship with the build. Build hashes are recorded and reproducible.

### TASK-180 — Open MirageSITL experiments in the viewer with context

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S14) Open MirageSITL experiment results, with their attached ArduPilot `.BIN` files, in the integrated analysis workflow. Parameter-change events appear on the flight timeline next to response plots, with requested, confirmed and rejected changes distinguishable. Show aircraft and component versions, environmental conditions and parameter differences. Context missing from external logs is marked unknown, and parameter history absent from a source is never fabricated.
- **Dependencies:** TASK-160, TASK-164, TASK-165, TASK-178, TASK-179.
- **Touched Files:** `apps/web/src/analysis/experiment-adapter.ts`, `apps/web/src/analysis/ContextPanel.tsx`, `third_party/uavlogviewer/patches/experiment-context.patch`, `tests/experiment-adapter.test.ts`, `tests/browser/log-viewer-experiments.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The adapter converts an experiment into a DataFlash file (TASK-178) plus a context document. External logs get context fields marked `unknown`.
- **DoD & Acceptance Criteria:** A browser test opens an experiment and shows its events and context. An external log shows its unknowns. No parameter history is invented.

### TASK-181 — Two-flight and two-interval comparison in the viewer

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S14) Compare two flights, or two selected intervals of one flight, side by side or overlaid, with distinct curves and common scales for matching quantities. Align interval starts and shift time manually to match maneuvers. Parameter-change markers stay on each flight's timeline.
- **Dependencies:** TASK-180.
- **Touched Files:** `third_party/uavlogviewer/patches/compare.patch`, `apps/web/src/analysis/CompareLogs.tsx`, `tests/log-alignment.test.ts`, `tests/browser/log-compare.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Alignment state: the offset of each source and the selected intervals, saved with the comparison.
- **DoD & Acceptance Criteria:** The alignment arithmetic matches a fixture. A browser test overlays two logs with shared scales and a manual shift.

## Stage P1.9: Experiments from Logs and Fidelity

Scope step 9. Real logs are optional; when present they seed experiments and fidelity evidence (S15).

### TASK-182 — Create an experiment from a real log

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S15) **Create experiment from log** accepts a log and an interval and extracts the available initial conditions, parameters, and task and control information. It asks the user to supply missing inputs through the UI and discloses missing commands, weather or aircraft information. Exact replay of an arbitrary log is not promised, and the lack of a log never disables simulation.
- **Dependencies:** TASK-165, TASK-172, TASK-178.
- **Touched Files:** `packages/analysis/src/log-to-experiment.ts`, `apps/web/src/experiments/FromLogWizard.tsx`, `tests/log-to-experiment.test.ts`, `tests/browser/from-log.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Extraction report: each field is `extracted`, `user-supplied` or `missing`, with its source message.
- **DoD & Acceptance Criteria:** Extraction matches the reference log's fields. Missing items are listed. The created experiment runs.

### TASK-183 — Re-simulation with changed parameters and comparison with the original flight

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S15) Run the created experiment with the original or changed ArduPilot parameters. The trajectory is recalculated, not forced to follow the recorded path. Compare the result with the original log in the viewer and with metrics.
- **Dependencies:** TASK-177, TASK-181, TASK-182.
- **Touched Files:** `packages/analysis/src/resimulate.ts`, `apps/web/src/experiments/FromLogCompare.tsx`, `tests/resimulate.test.ts`, `tests/browser/from-log-compare.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Re-simulation never feeds recorded positions back into physics. The comparison uses the TASK-181 alignment.
- **DoD & Acceptance Criteria:** A test shows that the re-simulated path can diverge from the recording. The comparison opens with aligned timelines and metrics.

### TASK-184 — Fidelity assessment per profile version and regime

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S15) Where matching data exists, compare attitude and rate response, overshoot and oscillation, altitude, climb and descent, trajectory, and measured propulsion and energy quantities, using the TASK-090 metrics, and show them with charts. MirageSITL sets no fidelity limits and issues no fidelity pass or fail: the user judges how far to trust the results (scope amendment of 2026-10-28). A comparison belongs to one profile version and its tested regimes; geometry, mass, motor or propeller changes require a new comparison. Missing data is shown as missing. Operational acceptance and fidelity are reported separately.
- **Dependencies:** TASK-090, TASK-133, TASK-183.
- **Touched Files:** `packages/analysis/src/fidelity.ts`, `apps/web/src/experiments/FidelityReport.tsx`, `scripts/check-fidelity.mjs`, `tests/fidelity-assessment.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Comparison record: profile version hash, regimes, compared quantities and metrics, with no limits and no verdicts. Invalid or unhashed input is rejected.
- **DoD & Acceptance Criteria:** Synthetic oracles recover known metrics. At least one real flight log is compared before DONE (G4). A profile change marks earlier comparisons as belonging to the previous version and resets the `flight-checked` label.

## Stage P1.10: Visualization and Existing Terrain

Scope step 10. Geometry-derived views and the existing terrain, without new providers or deferred effects (S17, S18).

### TASK-185 — Geometry-driven aircraft model, views and telemetry panels

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S17) Build the 3D aircraft from the profile: arms, motors, spin indicators and thrust axes. Provide external and onboard views; the onboard view reuses the TASK-067 camera pose without artistic or analog effects. Show the trajectory, the route and its points, and the flight and per-motor telemetry panels.
- **Dependencies:** TASK-067, TASK-141, TASK-153.
- **Touched Files:** `apps/web/src/FlightScene.tsx`, `apps/web/src/scene/AircraftModel.tsx`, `apps/web/src/scene/Trajectory.tsx`, `apps/web/src/scene/RouteOverlay.tsx`, `apps/web/src/run/TelemetryPanels.tsx`, `tests/browser/flight-views.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** The scene reads interpolated state only. Panels update at a decimated rate and never on each physics step.
- **DoD & Acceptance Criteria:** The rendered aircraft matches the profile in tests. Views switch without leaks. Panels show per-motor values from the session. Frame times meet the TASK-132 rendering criteria.

### TASK-186 — Terrain source selection, coverage and missing-terrain pause

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S17) Select at run time, not at build time, between the explicitly labeled synthetic level pad and the available real terrain. Imagery and elevation are distinguished, and coverage, source and detail are shown. An adapter that needs deployment, keys or data is shown as not ready. Missing terrain during a real-terrain run pauses it through the synchronized pause instead of substituting a plane. Automatic region downloads are excluded.
- **Dependencies:** TASK-065, TASK-131, TASK-148, TASK-156.
- **Touched Files:** `apps/web/src/terrain-config.ts`, `apps/web/src/weather/TerrainSource.tsx`, `packages/terrain/src/coverage.ts`, `tests/terrain-coverage.test.ts`, `tests/browser/terrain-source.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Terrain source record: kind, coverage, resolution, license and readiness from the TASK-131 inventory. A missing collision chunk pauses with reason `terrain`.
- **DoD & Acceptance Criteria:** The pad works offline. Real terrain loads from inventoried local data. A missing chunk causes a synchronized pause with a message. Unready adapters (Google tiles, R2) are marked not ready.

### TASK-187 — Contact on sloped real terrain in integrated sessions

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S18) Provide basic contact with the synthetic pad and the available real terrain, including surface slope, in flight sessions, using the TASK-133 approximation and no gear editor. Contact loads and events can be inspected in recordings.
- **Dependencies:** TASK-095, TASK-149, TASK-186.
- **Touched Files:** `packages/physics/src/terrain-contact.ts`, `packages/physics/src/profile-dynamics.ts`, `packages/terrain/src/collision-chunks.ts`, `tests/terrain-slope-contact.test.ts`, `tests/browser/terrain-contact-session.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Per-tick terrain planes come from collision chunks (TASK-065), with the contact backend as the single integration owner (TASK-095).
- **DoD & Acceptance Criteria:** Slope-hold and slide fixtures pass within the TASK-133 tolerance. SITL lands on sloped terrain. Contact events are recorded. No specific landing-gear fidelity is claimed.

## Stage P1.11: Integrated Acceptance and Local Delivery

Scope step 11. Execute S19 on macOS and prepare local delivery, recording PASS, FAIL, BLOCKED and NOT_RUN separately.

### TASK-188 — Phase 1 acceptance matrix harness

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S19) Build a hash-bound runner and aggregator over the configurations (quad, hexa and octo with one motor per arm; a paired or coaxial configuration; eight arms with two motors each) and the workflows: profile creation through the UI, output mapping, start, flight task, pause and resume, parameter changes, recording, reopening results, and explicit refusal of unsupported operations. Reuse the TASK-082 evidence conventions.
- **Dependencies:** TASK-132, TASK-134, TASK-158.
- **Touched Files:** `scripts/phase1/acceptance.mjs`, `scripts/validate-release.mjs`, `docs/validation/phase1-matrix.json`, `tests/phase1-acceptance.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Verdicts PASS, FAIL, BLOCKED_EXTERNAL, BLOCKED_DECISION and NOT_RUN, each with an evidence path and SHA-256. Missing evidence is NOT_RUN. Reports never enable a runtime mode.
- **DoD & Acceptance Criteria:** The matrix aggregates evidence with hashes. Missing evidence shows as NOT_RUN. Failures are preserved. A forged or stale report is rejected.

### TASK-189 — Sixteen-motor one-hour simulated-time run with recording

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S19) On the agreed Apple Silicon reference hardware in Chrome, the 16-motor configuration completes at least one continuous hour of simulated time with recording. This is not necessarily one hour of wall time, and the actual rate is still reported: executed Hz, drops and the simulated/wall ratio.
- **Dependencies:** TASK-091, TASK-162, TASK-175, TASK-188.
- **Touched Files:** `scripts/phase1/endurance.mjs`, `tests/integration/phase1-endurance.test.ts`, `docs/validation/phase1-matrix.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Evidence: device, chip, memory, macOS, Chrome, power mode, physics rate, workload and recording size, with hashes.
- **DoD & Acceptance Criteria:** A current capture shows one continuous simulated hour with a complete recording and no undeclared gap. A failure against the TASK-132 criteria is recorded as FAIL, never hidden.

### TASK-190 — macOS delivery: installation, restart, offline operation and recovery

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S01, S19) Demonstrate the clean-machine installation on a reference Mac, restart, and the offline workflows with the network disabled: simulation, tuning, local libraries, recording and log analysis. Demonstrate export and import, and verify the installation and recovery guidance. Produce a release manifest of sources, artifacts, datasets and licenses, reusing the TASK-083 tooling.
- **Dependencies:** TASK-152, TASK-179, TASK-188.
- **Touched Files:** `scripts/install-macos.mjs`, `scripts/release-manifest.mjs`, `tests/release-manifest.test.ts`, `docs/operations/install-macos.md`, `docs/ru/install-macos.md`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** A release manifest with hashes and license status per item. An unreviewed license blocks delivery as BLOCKED_DECISION.
- **DoD & Acceptance Criteria:** A recorded clean installation and an offline run with the network blocked both pass. The recovery steps are verified. Nothing is deployed or published automatically.

### TASK-191 — Phase 1 acceptance report

- **Status:** TODO — registered 2026-10-28 from PROJECT_SCOPE.md; baseline 384e974.
- **Title & Description:** (S19) Execute every S19 criterion: the full matrix, comparisons, parameter export, offline operation and the 16-motor hour. Report hardware performance against the TASK-132 decisions, keeping PASS, FAIL, BLOCKED and NOT_RUN separate; fidelity comparisons are reported as data without verdicts (TASK-133). Historical results are never reused as current acceptance.
- **Dependencies:** TASK-096, TASK-098, TASK-099, TASK-100, TASK-101, TASK-106, TASK-145, TASK-163, TASK-167, TASK-170, TASK-171, TASK-174, TASK-176, TASK-177, TASK-181, TASK-184, TASK-185, TASK-187, TASK-189, TASK-190.
- **Touched Files:** `test-results/validation/phase1-acceptance.json`, `docs/validation/phase1-matrix.json`, `docs/PHASE1_PLAN.md`, `docs/ru/PHASE1_PLAN.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Report schema: S-ID, criterion, verdict, evidence path and hash, device, and source identities.
- **DoD & Acceptance Criteria:** Every S19 criterion has current evidence or an explicit status. The report is hash-bound. Phase 1 is declared accepted only when every mandatory criterion is PASS, or when the stakeholder records an explicit decision for an item.

## Current Verification & Hardware Summary

* **Software and native test suites (2026-10-19):** `npm run lint`, `npm run typecheck`, `npm run check:docs`, and `npm run build` exit 0. Unit suite: `540` PASS across `97` files (`test-results/validation/task-045-unit.xml`, `test-results/validation/task-059-tests.json`). Native Rust workspace (`cargo test --manifest-path native/Cargo.toml --workspace --locked`, Rust `1.97.0`): `62` PASS plus native contact ABI (`native/contact`: `4` PASS). Browser Playwright suite: `50` PASS in software Chromium (1 WebGPU skip on SwiftShader), `6/6` PASS on native RTX 4050 WebGPU (`test-results/laptop/browser-render-gpu.xml`), and `8/8` PASS on ArduCopter WASM Worker/EEPROM (`test-results/validation/task-045-browser.xml`).
* **Hot-path G1 allocation reports:** Zero observed GC events and zero incremental B/step across warmed `1e6`/`2e6`-step windows in `test-results/bench/physics.json`, `test-results/bench/wind.json`, `test-results/bench/sensors-ideal.json`, `test-results/bench/sensors-all.json`, `test-results/bench/sensors-body.json`, `test-results/bench/contact.json`, `test-results/bench/jsbsim-400.json`, `test-results/bench/links-ew-all-400.json`..`1200.json`, `test-results/bench/aar-400.json`..`1200.json`, and `test-results/bench/terrain-scenarios-400.json`..`1200.json`. On Windows Node (`test-results/laptop/bench-physics-400.json`, `bench-physics-800.json`, `bench-physics-1200.json`), the `bench-physics` realtime run executed 516.7 Hz (target 800) and 519.6 Hz (target 1200) with drops: ~16 ms timer wakeups x 8-step catch-up cap. Compute is ~1 us/step; the browser Worker 800 Hz regression passed.
* **Engine, SITL, and hardware captures:**
  * Contact & terrain coupling (`TASK-029`, `TASK-065`): `test-results/validation/task-029-completion.json`, `test-results/validation/task-029-binding.json`, `test-results/bench/contact-native-patched.json`.
  * JSBSim v1.2.3 WASM, contact & UIUC propellers (`TASK-030`, `TASK-031`, `TASK-086`): `test-results/validation/jsbsim-artifact.json`, `test-results/validation/task-031-native.json`, `test-results/validation/task-031-backend.json`, `test-results/validation/task-031-completion.json`, `test-results/validation/jsbsim-propellers.json`.
  * Model validation (`TASK-033`): `test-results/validation/model-report.json`, `test-results/validation/nasa-drop-legacy.json`, `test-results/validation/propeller-points.json`, `test-results/validation/propeller-bem.json`, `test-results/validation/task-033-continuation.json` (12/12 numerical PASS; NASA drop deferred/failing archive preserved; UIUC propeller fixed-tolerance fidelity FAIL, exit 2).
  * Native ArduCopter SITL, `LiveEkfWarmup`, and EW fault regressions (`TASK-042`, `TASK-043`, `TASK-059`): `test-results/validation/task-042-flight.json`, `test-results/validation/task-042-completion.json`, `test-results/validation/task-043-warmup.json`, `test-results/validation/task-043-completion.json`, `test-results/validation/task-059-native.json`, `test-results/validation/task-059-flight-regression.json`.
  * ArduCopter WASM build & Worker/EEPROM boot (`TASK-045`): `test-results/validation/task-045-completion.json`, `test-results/validation/task-045-wire-audit.json`.
  * Local hardware & laptop probes (`TASK-048`, `TASK-050`, `TASK-073`, `TASK-082`, `TASK-083`): passive USB MAVLink2 capture from a Matek H743-WING (`ArduCopter V4.5.7`) on `COM7` in `test-results/hardware/serial-com7-matek.json`; Windows 11 / RTX 4050 Laptop GPU probes in `test-results/laptop/summary.json`, `test-results/laptop/gpu-rtx4050-60.json`, `test-results/laptop/gpu-rtx4050-120.json`, `test-results/laptop/gpu-rtx4050-native144.json`, `test-results/laptop/system-report.json`, and `test-results/laptop/release-manifest.json`. The Apple M4 timing decision and the 2560×1440 presentation gap are recorded under TASK-073; the operator screenshot is in `task_073_results/`. See [runbook.md](operations/runbook.md) and [V2_PLAN.md](V2_PLAN.md) for operational commands and environment setup.
