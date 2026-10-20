# PROJECT_ROADMAP.md

Version 1.1 · 2026-10-20 · baseline `aab5e47`. English is the source of truth.
[Russian mirror](ru/PROJECT_ROADMAP.md).

Future modules are not claimed as implemented. The active browser application runs on ABI v2 (`49280` bytes, `192`-byte state stride) with `400/800/1200` Hz clocks, SPSC sensor/actuator queues, epoch-aware rendering, decimated Pilot HUD / Instructor / AAR flows, and the demo dynamics backend (`540` unit tests across `97` files, Chromium browser suites, and `62` native Rust tests). Independent native/WASM rotor kernels, direct `f64` Rapier landing-gear contact (`TASK-029`) and collision-chunk coupling (`TASK-065`), pinned JSBSim v1.2.3 WASM/contact (`TASK-030`/`031`/`086`), native Linux/WSL ArduCopter SITL flight, `LiveEkfWarmup`, and EW fault regressions (`TASK-042`/`043`/`059`), and ArduCopter WASM Worker/EEPROM boot (`TASK-045`) are verified in their respective harnesses. Production BET C ABI polar binding and configurable session injection are now verified by TASK-033. Browser autopilot `READY`, ArduPilot browser flight HAL/parity (`TASK-046`/`047`), measured model fidelity (separate from the TASK-033 synthetic baseline), physical HITL (`TASK-051`), target GPU 10-minute profiling (`TASK-073`), instructor/scenario UI wiring (`TASK-075`/`078`/`079`/`080`; TASK-074 HUD freshness is done), and release sign-off (`TASK-082`/`083`) remain open.

Contracts: [Shared Memory](SPECS_SHARED_MEMORY.md),
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
  Use 60 s warmup and 10 min measurement. The 60 FPS profile requires p99
  frame<=16.67 ms; 120 FPS requires p99<=8.33 ms. Software-headless rendering
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

- **Status:** DONE — Codex; baseline 324d15e; 2026-10-19. Native LiveEkfWarmup admission, acknowledged JSON lockstep IMU timing, CRC-checked MAVLink EKF/GNSS diagnostics, and observed GNSS-age revocation/recovery pass live ArduCopter capture replay. Browser READY and physical HITL remain separate.
- **Title & Description:** Warm up for 30 simulated seconds and admit READY from actual EKF diagnostics.
- **Dependencies:** TASK-035, TASK-039, TASK-042.
- **Touched Files:** `packages/autopilot/src/warmup.ts`, `packages/autopilot/src/ekf-status.ts`, `packages/autopilot/package.json`, `packages/mavlink/src/codec.ts`, `tests/warmup.test.ts`, `tests/integration/ekf-ready.test.ts`, `tests/fixtures/mavlink/ekf-golden.json`, `tests/fixtures/mavlink/generate-ekf.py`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Normalized ekf_flags; source freshness; fast-forward only for SITL.
- **DoD & Acceptance Criteria:** Sensor timestamps agree; failed innovations never become READY just because a timer elapsed; measure acceleration factor; reject HITL fast-forward; disable startup EW until ready.
- **Evidence:** Owner Codex; baseline 324d15e; 2026-10-19. `packages/autopilot/src/warmup.ts`, `ekf-status.ts`, and `live-warmup.ts` (`json-lockstep` acknowledged IMU sample clock + CRC-checked `EKF_STATUS_REPORT`, `GPS_RAW_INT`, `HIGHRES_IMU`, `HEARTBEAT`; `0.01` s IMU and `0.3` s GNSS freshness bounds). In the pinned ArduCopter run (`test-results/validation/task-043-warmup.json`, `test-results/validation/task-043-flight.json`), `READY` first occurs at `41.27625` simulated seconds / `20.733261598` wall seconds (`1.990822804x` acceleration); all 8,413 readiness observations and 31,953 wire frames match raw MAVLink replay (`scripts/check-ekf-warmup.mjs`), including two observed GNSS-age excursions (`>0.3` s) that revoke and recover `READY`/EW admission, plus 7 synthetic rejection probes (`tests/warmup.test.ts`, `tests/integration/ekf-ready.test.ts`, `test-results/validation/task-043-unit.xml`, `test-results/validation/task-043-completion.json`). Browser UI autopilot `READY` and physical HITL remain separate.

### TASK-044 — ArduPilot WASM feasibility gate

- **Status:** DONE — Codex; baseline c3a4735; 2026-10-17. Independent feasibility gate completed; local WSL/Emscripten build and browser Worker/EEPROM boot were subsequently verified in TASK-045, while GPL redistribution (BLOCKED_DECISION) and MirageSITL flight HAL/parity (TASK-046/047) remain open.
- **Title & Description:** Probe HAL/scheduler/storage/network/licensing and record a concrete feasibility decision.
- **Dependencies:** TASK-016, TASK-039, TASK-042.
- **Touched Files:** `docs/decisions/ardupilot-wasm.md`, `native/ardupilot/source.lock.json`, `native/ardupilot/feasibility.md`, `tests/ardupilot-wasm-capability.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `docs/ru/ardupilot-wasm.md`, `docs/ru/feasibility.md`, `scripts/probe-ardupilot-wasm.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Required browser HAL capabilities; supported firmware targets.
- **DoD & Acceptance Criteria:** Each capability has a runnable probe or observed blocker; record evidence for feasible/blocked; blocked leaves TASK-045..047 open and does not count as a working WASM mode.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `scripts/probe-ardupilot-wasm.mjs`, `tests/ardupilot-wasm-capability.test.ts` (3 PASS), `native/ardupilot/source.lock.json`, `native/ardupilot/feasibility.md`, and [ardupilot-wasm.md](decisions/ardupilot-wasm.md) audit the pinned ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` HAL/scheduler/storage/network/GPL requirements. `TASK-045` subsequently resolved the local Emscripten 4.0.15 build, Worker/pthread boot, and IndexedDB EEPROM storage; `TASK-046`/`047` and GPLv3 redistribution review remain open.

### TASK-045 — ArduPilot WASM build

- **Status:** DONE — Codex; baseline af984ed; 2026-10-19. Local pinned build, real browser Worker/pthread admission, and persistent EEPROM acceptance verified. Artifact redistribution retains BLOCKED_DECISION (GPL review); MirageSITL flight HAL and parity remain TASK-046/047.
- **Title & Description:** Build selected firmware with pinned tools and artifact hashes.
- **Dependencies:** TASK-044.
- **Touched Files:** `native/ardupilot/CMakeLists.txt`, `native/ardupilot/toolchain.lock.json`, `scripts/build-ardupilot-wasm.mjs`, `packages/autopilot/src/wasm-loader.ts`, `tests/ardupilot-wasm-build.test.ts`, `scripts/probe-ardupilot-wasm.mjs`, `tests/ardupilot-wasm-capability.test.ts`, `docs/decisions/ardupilot-wasm.md`, `docs/ru/ardupilot-wasm.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `scripts/smoke-ardupilot-wasm.mjs`, `packages/autopilot/package.json`, `native/ardupilot/wasm-artifact.manifest.json`, `packages/autopilot/src/wasm-storage.ts`, `packages/autopilot/src/wasm-browser.ts`, `apps/web/src/ardupilot.worker.ts`, `apps/web/src/diagnostics/ardupilot-check.ts`, `apps/web/ardupilot-check.html`, `apps/web/vite.config.ts`, `tests/ardupilot-wasm-storage.test.ts`, `tests/browser/ardupilot-wasm.spec.ts`, `packages/mavlink/src/codec.ts`, `tests/fixtures/mavlink/wasm-parameters.json`, `tests/fixtures/mavlink/generate-wasm-parameters.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `README.md`, `docs/ru/README.md`, `scripts/check-ardupilot-browser.py`, `native/ardupilot/feasibility.md`, `docs/ru/feasibility.md`.
- **Interfaces / Contracts:** Artifact ABI/license/firmware manifest.
- **DoD & Acceptance Criteria:** A reproducible artifact loads in Worker with checked exports/memory limits; resolve TASK-044 blockers first; an empty replacement module is forbidden.
- **Evidence:** Owner Claude/Codex; baseline af984ed; 2026-10-19. Pinned ArduPilot `8ab6afde107a91df1b5f60ade8f333cb8a61b190` (`waf configure --board wasm && waf copter` in WSL with Emscripten 4.0.15 `389a68bc35dcff7ebae4614e1615099dafda00d1`) reproducibly builds `arducopter.wasm` (`3,730,330` B, SHA-256 `556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38`) and `arducopter.js` (`258,215` B, SHA-256 `b158a7b8e9b400c770e2b4fc87c66fc2aaf68bc583c7d71f3a56786d3bcb4212`), recorded in `native/ardupilot/wasm-artifact.manifest.json`. `scripts/smoke-ardupilot-wasm.mjs` boots the artifact in Node; Chromium 155.0.8059.84 (`tests/browser/ardupilot-wasm.spec.ts`: 8 PASS) boots the admitted firmware in 1 host Worker + 4 pthreads (`16` MiB initial shared memory, `2` GiB cap), persists `WP_SPD` (`10` to `8.125` m/s) across graceful and abrupt Worker restarts in 16 KiB IndexedDB EEPROM images audited by `scripts/check-ardupilot-browser.py`, and verifies clean Worker teardown (`test-results/validation/task-045-completion.json`, `test-results/validation/task-045-wire-audit.json`, `test-results/validation/task-045-browser.xml`, `test-results/validation/task-045-unit.xml`). Artifacts remain outside the repository pending GPLv3 distribution review (`BLOCKED_DECISION`); active app backend remains demo pending `TASK-046`/`047`.

### TASK-046 — ArduPilot browser HAL

- **Status:** IN_PROGRESS; Codex; baseline d4dda82; 2026-10-20. Goal: real ArduCopter sensor/actuator/clock coupling at 800 Hz initially, configurable 400/800/1200 Hz. Failure: accepted invalid versions/counts/time, time advancing without host input, native/WASM sensor disagreement, lost outputs, pause/stop deadlock, hot allocations or fabricated READY.
- **Title & Description:** Connect clock/storage/sensor/actuator endpoints to WASM firmware.
- **Dependencies:** TASK-013, TASK-035, TASK-045.
- **Touched Files:** `native/ardupilot/hal/browser_hal.cpp`, `packages/autopilot/src/wasm-sitl.ts`, `tests/wasm-hal.test.ts`.
- **Interfaces / Contracts:** Simulation lockstep clock; virtual storage; preallocated mailboxes; separate AP Worker if required by HAL.
- **DoD & Acceptance Criteria:** Native/WASM HAL probes agree; no assumed native sockets/files; validate sensor timing/actuator counts; tab pause and termination do not deadlock.

- **Implementation scope:** Versioned fixed-size HAL mailbox/native probe (`native/ardupilot/hal/browser_hal.h`, `browser_hal.cpp`, `probe.cpp`); pinned integration patch and local build/check tools (`native/ardupilot/hal/sitl-state.patch`, `scripts/build-ardupilot-hal.mjs`, `scripts/check-ardupilot-hal.mjs`); host adapter (`packages/autopilot/src/wasm-sitl.ts`), cold binding callback in `wasm-browser.ts`, package export, native/TS/browser tests (`tests/wasm-hal.test.ts`, `tests/browser/wasm-hal.spec.ts` and test Worker), engine specification/architecture/baseline instructions and Russian mirrors. Isolated source/build; preserve TASK-045 bytes and TASK-074 work. Separate HAL artifact identities; no firmware redistribution or TASK-047 parity claim. Existing ABI-v2 queues retain their byte layout and single-writer ownership.

### TASK-047 — WASM/native SITL parity

- **Status:** TODO.
- **Title & Description:** Compare identical scenarios and enable WASM mode only after passing parity.
- **Dependencies:** TASK-042, TASK-043, TASK-046.
- **Touched Files:** `tests/integration/wasm-sitl.test.ts`, `scripts/compare-autopilot.mjs`, `docs/validation/autopilot-parity.schema.json`.
- **Interfaces / Contracts:** Identical seeds/parameters/airframe; mode/EKF/trajectory tolerances.
- **DoD & Acceptance Criteria:** Both run arm/takeoff/land and failsafe; define thresholds first: position RMSE<=0.5 m and attitude RMSE<=2 degrees over the 30 s reference; diagnose divergence rather than automatically rewriting goldens.

### TASK-048 — Web Serial transport

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Open ports only through a user gesture and handle stream/reconnect lifecycle.
- **Dependencies:** TASK-005, TASK-037, TASK-039.
- **Touched Files:** `packages/autopilot/src/serial-transport.ts`, `apps/web/src/SerialConnect.tsx`, `tests/serial-transport.test.ts`, `tests/browser/serial-permission.spec.ts`, `packages/autopilot/src/serial-io.worker.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/App.tsx`, `apps/web/package.json`, `package-lock.json`.
- **Interfaces / Contracts:** ReadableStream chunks to MAVLink parser; permission/user gesture; port ownership.
- **DoD & Acceptance Criteria:** Mock chunk/error/disconnect/cancel cases; reopening never duplicates a reader; unsupported browsers disable the mode; mocks are not physical HITL evidence.
- **Evidence:** Owner Codex; baseline dfbf402; 2026-10-16. `tests/serial-transport.test.ts` (4 PASS) and `tests/browser/serial-permission.spec.ts` (3 PASS in Chromium) verify gesture-only port requests, single-reader ownership, 4096-byte bounded chunks with 500 ms decoder timeout in the dedicated Serial I/O Worker, and clean disconnect/reopen. Passive MAVLink2 reception from a physical Matek H743-WING over `COM7` is recorded in `test-results/hardware/serial-com7-matek.json`; closed-loop hardware HITL remains `TASK-051`.

### TASK-049 — HIL sensor/actuator streaming

- **Status:** DONE — Claude; baseline b28c8c2; 2026-10-16 (fake-clock streaming verified; physical hardware is TASK-051).
- **Title & Description:** Send HIL_SENSOR/HIL_GPS and receive HIL_ACTUATOR_CONTROLS on real-time clocks.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-037, TASK-048.
- **Touched Files:** `packages/autopilot/src/hitl.ts`, `packages/autopilot/src/hil-clock.ts`, `tests/hil-stream.test.ts`, `packages/autopilot/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** IMU 200/400 Hz; GNSS 5/10 Hz; actuator mapping/signing/time.
- **DoD & Acceptance Criteria:** A 60 s fake real-time clock gives exact counts/bytes/timestamps; dropout/queue overflow fault; fields_updated matches observations; baud/10 serial budget retains at least 30% headroom.
- **Evidence:** Owner Claude; baseline b28c8c2; 2026-10-16. `tests/hil-stream.test.ts` (17 PASS) verifies twelve 60 s `hitl-realtime` schedules across `400/800/1200` Hz physics x `200/400` Hz IMU x `5/10` Hz GNSS (`100` Hz mag, `50` Hz baro), exact `fields_updated` bitmasks, `460800` baud headroom (`67.9%` at `31,310` B/s; `115200`/`230400` rejected), queue overflow latching, and 100 ms actuator dropout fault. Physical flight controller verification remains `TASK-051`.

### TASK-050 — HITL firmware capability gate

- **Status:** DONE — Claude; baseline 0006e07; 2026-10-16 (gate implemented; HITL availability BLOCKED_EXTERNAL: no verified board profile).
- **Title & Description:** Verify board/build flags/message support before declaring HITL available.
- **Dependencies:** TASK-039, TASK-049.
- **Touched Files:** `packages/autopilot/src/hitl-capabilities.ts`, `docs/hardware/hitl-matrix.md`, `tests/hitl-capabilities.test.ts`, `docs/ru/hitl-matrix.md`, `docs/documentation-index.json`, `packages/autopilot/src/state-machine.ts`, `packages/autopilot/package.json`, `tests/autopilot-state.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Board/firmware SHA/HIL mode/MAVLink capability matrix.
- **DoD & Acceptance Criteria:** Unsupported HIL sensor/actuator paths cannot become READY; record a verified profile or exact BLOCKED_EXTERNAL requirement; SITL availability does not prove HITL support.
- **Evidence:** Owner Claude; baseline 0006e07; 2026-10-16. `tests/hitl-capabilities.test.ts` (6 PASS) and [hitl-matrix.md](hardware/hitl-matrix.md) verify source-audited capability rules: pinned ArduPilot `8ab6afde...` lacks `HIL_SENSOR`/`HIL_ACTUATOR_CONTROLS` handlers (`UNSUPPORTED`), and PX4 `4d7e4de7...` requires a hardware-verified board profile (`BLOCKED_EXTERNAL`, `TASK-051`). A local Matek H743-WING running `ArduCopter V4.5.7 (c1269922)` on `COM7` (`test-results/hardware/serial-com7-matek.json`) was also probed and confirmed passive telemetry only.

### TASK-051 — Physical HITL acceptance

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Bench trace analyzer/procedure/schema implemented; physical HIL-capable FC profile, live 60 s closed-loop exchange, and unplug capture remain absent.
- **Title & Description:** Run a hardware bench and record transport/closed-loop integrity evidence.
- **Dependencies:** TASK-043, TASK-049, TASK-050.
- **Touched Files:** `scripts/bench-hitl.mjs`, `docs/hardware/hitl-test-procedure.md`, `docs/validation/hitl-report.schema.json`, `tests/hitl-report.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `docs/ru/hitl-test-procedure.md`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Board/firmware identity; timestamp jitter; sustained throughput; failsafe.
- **DoD & Acceptance Criteria:** Run 60 s sensor/actuator exchange; p99 sample scheduling lateness<=5 ms at 200 Hz or <=2.5 ms at 400 Hz; no overflow/unaccounted loss; unplug disables actuators; absent hardware is BLOCKED_EXTERNAL.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `scripts/bench-hitl.mjs`, `docs/validation/hitl-report.schema.json`, [hitl-test-procedure.md](hardware/hitl-test-procedure.md), and `tests/hitl-report.test.ts` verify report schema, jitter/loss thresholds, and `BLOCKED_EXTERNAL` exit 2 when no capture is supplied. Passive `COM7` telemetry from a Matek H743-WING (`ArduCopter V4.5.7`, battery disconnected, GPS absent) is archived in `test-results/hardware/serial-com7-matek.json`, but no HIL-capable board/firmware profile or 60 s bidirectional bench capture exists.

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

- **Status:** DONE — Codex; baseline 0a31f44; 2026-10-19. Six real native calibration flights and six independent validation flights pass frozen firmware/parameter/model/source-specific limits. Raw RX/TX, actual EKF/mode responses, and PWM/Rust-WASM physics replay verified. Scope is the synthetic native quad; browser, physical HITL, and measured aircraft fidelity remain separate.
- **Title & Description:** Measure ArduPilot responses to EW/mechanical faults without promising a hard-coded mode.
- **Dependencies:** TASK-042, TASK-043, TASK-058.
- **Touched Files:** `tests/integration/ew-sitl.test.ts`, `tests/fixtures/scenarios/ew-matrix.json`, `scripts/report-ekf.mjs`, `scripts/run-ew-sitl.mjs`, `scripts/freeze-ew.mjs`, `scripts/sitl/audit-ew.mjs`, `scripts/sitl/ew-observations.ts`, `scripts/sitl/check-ew.py`, `scripts/sitl/driver.mjs`, `scripts/sitl/telemetry.py`, `scripts/sitl/quad.mjs`, `tests/sitl-ew.test.ts`, `docs/operations/runbook.md`, `docs/ru/runbook.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Innovation/status/mode/trajectory AAR trace; pinned EKF parameters.
- **DoD & Acceptance Criteria:** Run a no-fault control and every fault; traces show changed observations and actual EKF responses; freeze version-specific envelopes; unexplained responses require investigation rather than silent PASS.
- **Evidence:** Owner Codex; baseline 0a31f44; 2026-10-19. `test-results/validation/task-059-native.json` PASS across 6 calibration and 6 validation flights (710,636 replayed physics frames, 20,612 response rows) against frozen `tests/fixtures/scenarios/ew-matrix.json` (SHA-256 `c8bd27d9be4e22a5b10279cc925589e7299edeadb667cd478638d0f533494b3a`): jamming and drift trigger `Guided -> Land`, position step triggers GPS-glitch flags, magnetic bias raises compass innovations/selection activity, and single-rotor thrust loss causes tumble/contact within 3 s, while the no-fault control completes healthy hold and landing (`test-results/validation/task-059-flight-regression.json`, `test-results/validation/task-059-tests.json`). Six rejection probes (`tests/sitl-ew.test.ts`, `tests/integration/ew-sitl.test.ts`) pass.

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
- **Title & Description:** Build an authenticated proxy with quotas, attribution/CORS, and permitted TTLs.
- **Dependencies:** TASK-060, TASK-061.
- **Touched Files:** `services/tiles-worker/package.json`, `services/tiles-worker/wrangler.jsonc`, `services/tiles-worker/src/index.ts`, `services/tiles-worker/src/policy.ts`, `tests/tiles-proxy.test.ts`, `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `tsconfig.json`.
- **Interfaces / Contracts:** ProviderPolicy; opaque upstream secret binding; origin/session verification.
- **DoD & Acceptance Criteria:** Local Worker tests verify no key reaches clients/logs, invalid origin/session/quota rejection, and provider restrictions; deployment needs separate authorization and is not implied by local success.
- **Evidence:** Owner Claude; baseline e9ad0f3; 2026-10-16. `tests/tiles-proxy.test.ts` (10 PASS) verifies fail-closed configuration, Origin/HMAC-session validation, upstream API key injection and error-body key redaction, `Cache-Control: no-store` (`TTL 0`), and per-session/per-IP quotas. External Cloudflare deployment and live Google credentials remain separate.

### TASK-064 — R2 for permitted datasets

- **Status:** DONE — Claude; baseline f35efe6; 2026-10-16 (emulator tests; R2 binding and persistent caching need explicit permission).
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
- **Title & Description:** Integrate material temperatures from solar forcing/weather outside the shader.
- **Dependencies:** TASK-032, TASK-069.
- **Touched Files:** `packages/thermal/src/heat-balance.ts`, `packages/thermal/src/solar.ts`, `packages/thermal/package.json`, `tests/thermal-energy.test.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** C*dT/dt=absorbedSolar-convection-radiation-conduction; emissivity/inertia.
- **DoD & Acceptance Criteria:** Test night equilibrium/sunrise/shadows/energy units and timestep convergence; AO affects only an explicit radiative model, not a substitute heat solver; measured validation remains pending without data.
- **Evidence:** Owner Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-energy.test.ts` (15 PASS) verifies `HeatSurface` trapezoidal and `ThermalField` batched allocation-free Heun slab solvers (`<=0.02` K agreement over 6 h), NOAA solar ephemeris vs NREL SPA (`1e-9` direction match), 3600 s night equilibrium, shadows/sky-view radiative coupling, and 600 s timestep convergence (`<0.002` K). Synthetic model; no measured material calibration claimed.

### TASK-071 — Thermal renderer

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Independent synthetic LWIR WebGL2 pipeline; production scene and measured instrument remain open.
- **Title & Description:** Map thermal states to radiance/palettes with atmospheric attenuation.
- **Dependencies:** TASK-066, TASK-070.
- **Touched Files:** `packages/thermal/src/thermal-camera.ts`, `packages/thermal/src/shaders/thermal.glsl`, `tests/thermal-camera.test.ts`, `tests/browser/thermal.spec.ts`, `tests/support/thermal-harness.ts`, `packages/thermal/package.json`, `tests/material-map.test.ts`, `apps/web/src/render/webgpu.ts`, `tests/browser/render-backends.spec.ts`, `tests/support/render-harness.html`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `packages/thermal/src/thermal-material.ts`.
- **Interfaces / Contracts:** InstrumentProfile {resolution, spectralResponse, noise, calibrationSource}; synthetic training profiles are separate from CADEX measurements.
- **DoD & Acceptance Criteria:** Test blackbody monotonicity, emissivity/reflection/distance attenuation, and cold/hot palette endpoints; configurable native resolution; do not claim CADEX parity without profile data.
- **Evidence:** Owner Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-camera.test.ts` (8 PASS) and `tests/browser/thermal.spec.ts` (1 PASS in Chromium WebGL2) verify Simpson band Planck radiance integration (`54–56` W/(m²·sr) at 300 K), emissivity/reflection/Beer-Lambert attenuation, `white-hot`/`black-hot`/`ironbow` palettes, configurable native resolution, and pixel-by-pixel GLSL vs CPU agreement within 1 8-bit level. No CADEX measured profile or production scene wiring claimed.

### TASK-072 — Thermal shutter and NUC

- **Status:** DONE — Codex/Claude; baseline 660d86e; 2026-10-16. Deterministic synthetic offset-only shutter calibration.
- **Title & Description:** Implement deterministic calibration cycles and bounded display interruption.
- **Dependencies:** TASK-071.
- **Touched Files:** `packages/thermal/src/nuc.ts`, `packages/thermal/src/thermal-status.ts`, `packages/thermal/package.json`, `tests/thermal-nuc.test.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Shutter states idle/closed/calibrating/open; sensor frame time.
- **DoD & Acceptance Criteria:** Fix cycle duration/rate; NUC removes configured bias without timestamp reversal; shutter never pauses physics or mutates AAR truth.
- **Evidence:** Owner Codex/Claude; baseline 660d86e; 2026-10-16. `tests/thermal-nuc.test.ts` (4 PASS) verifies `idle -> closed -> calibrating -> open` shutter cadence, 17-frame display freeze on a 120 s grid, fixed-pattern offset removal (`0.71 ± 30%` counts residual on 4096 noisy pixels), monotone timestamps, and bit-identical `ThermalField`/physics state across shutter cycles.

### TASK-073 — GPU acceptance harness

- **Status:** BLOCKED_EXTERNAL — Codex; 2026-10-17. Benchmark analyzer/schema and short RTX 4050 demo captures exist; 10-minute full-feature (terrain/FPV/thermal) traces, GPU residency accounting, 60/120 FPS p99 compliance, and Apple M4 hardware remain absent.
- **Title & Description:** Profile production rendering on M4/RTX 4050 with terrain/FPV/thermal enabled.
- **Dependencies:** TASK-014, TASK-062, TASK-065, TASK-066, TASK-068, TASK-072.
- **Touched Files:** `scripts/bench-render.mjs`, `docs/benchmarks/render-matrix.json`, `docs/validation/gpu-report.schema.json`, `tests/gpu-report.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** G3 device/browser/resolution/quality/VRAM evidence.
- **DoD & Acceptance Criteria:** Measure each profile for 10 min after 60 s warmup; 60 FPS p99<=16.67 ms and 120 FPS p99<=8.33 ms; meet terrain budgets; software-headless GPU cannot satisfy hardware gates; missing devices are BLOCKED_EXTERNAL.
- **Evidence:** Owner Codex; 2026-10-17. `scripts/bench-render.mjs`, `docs/benchmarks/render-matrix.json`, `docs/validation/gpu-report.schema.json`, and `tests/gpu-report.test.ts` are implemented. Short 15 s visible Chromium captures on Windows 11 with an NVIDIA RTX 4050 Laptop GPU (`test-results/laptop/gpu-rtx4050-60.json`, `test-results/laptop/gpu-rtx4050-120.json`, `test-results/laptop/gpu-rtx4050-native144.json`) measured ~60 FPS cadence with p99 frame time `22.7–28.6` ms (failing `<=16.67` ms 60 FPS and `<=8.33` ms 120 FPS G3 thresholds) on the demo scene without terrain/FPV/thermal enabled or GPU residency telemetry. Full 10-minute RTX 4050 and Apple M4 runs remain `BLOCKED_EXTERNAL`.

## Phase 6: UI & Telemetry

### TASK-074 — Pilot HUD and freshness

- **Status:** DONE — Cursor; baseline d4dda82; 2026-10-20. Identity-bound `EkfMonitor` diagnostics from decoded USB `serial.frame` messages drive `PilotHud` source, `custom_mode`, degraded/valid EKF flags, and 1000 ms staleness. Disconnect clears the overlay back to demo truth. The physics Worker still publishes unknown autopilot fields. A serial grant does not admit browser READY or HITL.
- **Title & Description:** Display attitude/speed/altitude/mode/EKF with source and age.
- **Dependencies:** TASK-015, TASK-039, TASK-043.
- **Touched Files:** `apps/web/src/hud/PilotHud.tsx`, `apps/web/src/hud/attitude.ts`, `apps/web/src/hud/telemetry.ts`, `apps/web/src/SerialConnect.tsx`, `apps/web/src/App.tsx`, `apps/web/src/runtime.ts`, `apps/web/src/style.css`, `packages/physics/src/session-v2.ts`, `tests/session-v2.test.ts`, `tests/hud.test.ts`, `tests/browser/hud.spec.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `HANDOVER.md`, `docs/ru/HANDOVER.md`, `docs/documentation-index.json`.
- **Interfaces / Contracts:** FlightStateV2; normalized ekf_flags; unknown/stale visual states.
- **DoD & Acceptance Criteria:** Verify NED horizon signs; demo cannot fabricate valid EKF; stale AP status is marked; decimate React updates instead of setState at 1200 Hz.
- **Evidence:** Owner Cursor; baseline d4dda82; 2026-10-20. `npx --no-install vitest run tests/hud.test.ts tests/session-v2.test.ts` (14 PASS: `tests/hud.test.ts` 3, `tests/session-v2.test.ts` 11) verifies NED horizon signs, `q`/`-q` equivalence, demo rejection of fabricated EKF flags, failed-innovation gating, and age staleness. `npx --no-install playwright test tests/browser/hud.spec.ts tests/browser/serial-permission.spec.ts tests/browser/instructor.spec.ts` (8 PASS in Chromium 141 headless shell) verifies demo unknown status, CRC-valid golden HEARTBEAT/EKF frames through `serial-io.worker.ts`, `EKF DEGRADED` for raw flags 167, `EKF flags valid` for raw flags 55, STALE after more than 1000 ms of silence, at most 12 HUD DOM mutations in 1000 ms, disconnect returning to demo truth, and the existing serial-permission and instructor regressions. `npm run typecheck`, `npm run lint`, and `npm run build` exit 0.

### TASK-075 — Instructor console and hotkeys

- **Status:** TODO — Console/ACK/hotkey software verified; TASK-074 HUD freshness is done. Production session fault wiring remains open.
- **Title & Description:** Send weather/fault/model commands with explicit pending/applied status.
- **Dependencies:** TASK-010, TASK-038, TASK-058, TASK-074.
- **Touched Files:** `apps/web/src/instructor/Console.tsx`, `apps/web/src/instructor/hotkeys.ts`, `apps/web/src/instructor/commands.ts`, `apps/web/src/App.tsx`, `apps/web/src/runtime.ts`, `apps/web/src/style.css`, `tests/instructor.test.ts`, `tests/browser/instructor.spec.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** ControlCommandV2 request/ACK/epoch; scenario fault registry.
- **DoD & Acceptance Criteria:** Hotkeys ignore text-input focus; cancellation/reset/stale epoch/rejection are visible; show applied only after ACK; all fault IDs are usable without source changes.
- **Evidence:** Owner Codex; baseline 660d86e; 2026-10-16. `tests/instructor.test.ts` (1 PASS) and `tests/browser/instructor.spec.ts` (1 PASS) verify Worker command/ACK handling, editable fault IDs, motor/weather/model requests, bounded pending/queued/applied/rejected/cancelled ledger, epoch race handling, and text-input hotkey suppression. Demo rejections stay visible. TASK-074 HUD freshness is done; production session fault wiring remains open.

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

- **Status:** TODO — Response charts and demo review verified; TASK-074 HUD freshness is done. Full-rate actuator/sensor recording remains open.
- **Title & Description:** Align pilot input, actuator commands, and model responses on one time axis.
- **Dependencies:** TASK-074, TASK-077.
- **Touched Files:** `apps/web/src/aar/Review.tsx`, `apps/web/src/aar/series.ts`, `tests/aar-series.test.ts`, `tests/browser/aar.spec.ts`, `apps/web/src/style.css`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Bounded decimated time series; units/timebase; explicit recording gaps.
- **DoD & Acceptance Criteria:** A known step-response fixture shows correct lag; do not interpolate gaps as real data; display 30 min with <=10000 points per series and bounded memory.
- **Evidence:** Owner Codex; baseline 660d86e; 2026-10-16. `tests/aar-series.test.ts` (2 PASS) and `tests/browser/aar.spec.ts` verify `0.2`/`0.3`/`0.4` s pilot/actuator/response step alignment, uninterpolated gap segments, and 30 min (`18,000`-sample) peak-preserving decimation to `<=10,000` points. TASK-074 HUD freshness is done; full-rate actuator/sensor recording remains open.

### TASK-079 — Lessons and scenario runner

- **Status:** TODO — TASK-042/043/059 dependencies resolved 2026-10-19; scenario schema, deterministic tick runner, and rubric evaluator verified; awaits TASK-075 and live session ACK orchestration.
- **Title & Description:** Define reproducible training scenarios declaratively.
- **Dependencies:** TASK-043, TASK-059, TASK-075, TASK-077.
- **Touched Files:** `packages/scenarios/package.json`, `packages/scenarios/src/schema.ts`, `packages/scenarios/src/runner.ts`, `tests/scenario-runner.test.ts`, `tests/fixtures/scenarios/pilot-basics.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `packages/scenarios/src/evaluate.ts`, `package-lock.json`, `scripts/bench-terrain-scenarios.mjs`.
- **Interfaces / Contracts:** Goals/seed/model/firmware/events/rubric/version; no physics in UI.
- **DoD & Acceptance Criteria:** Reject malformed/unsupported scenarios; identical configuration emits identical tick events; evaluate outcomes from traces/thresholds, not just timers; paused clocks incur no simulation-time penalty.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `tests/scenario-runner.test.ts` and `node scripts/bench-terrain-scenarios.mjs 400|800|1200` (`test-results/bench/terrain-scenarios-400.json`..`1200.json`: 0 GC) verify `packages/scenarios/` schema admission, deterministic tick event polling, pause handling without sim-time penalty, and trace-based rubric evaluation against `tests/fixtures/scenarios/pilot-basics.json`. `TASK-042`, `TASK-043`, and `TASK-059` are now DONE; binding scenario commands/ACKs to a live autopilot session and completing `TASK-075` remain open.

### TASK-080 — Accessibility and permissions UX

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Demo keyboard/focus/narrow-layout/permission UX and unsuppressed axe scan verified; live-autopilot prerequisites TASK-075/078 and manual screen-reader/hardware checks remain open.
- **Title & Description:** Support keyboard/focus/resize and clear browser-permission failures.
- **Dependencies:** TASK-005, TASK-048, TASK-075, TASK-078.
- **Touched Files:** `apps/web/src/ui/StatusMessage.tsx`, `apps/web/src/style.css`, `tests/browser/accessibility.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `apps/web/src/App.tsx`, `apps/web/src/SerialConnect.tsx`, `apps/web/src/aar/Review.tsx`, `apps/web/src/ui/focus.ts`, `tests/focus.test.ts`, `package.json`, `package-lock.json`.
- **Interfaces / Contracts:** Keyboard controls versus instructor shortcuts; aria states; permission status.
- **DoD & Acceptance Criteria:** Core actions are keyboard accessible; restore focus after dialogs; no 390px overflow; permission denial never loops prompts; run an automated accessibility scan and a manual checklist.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `tests/focus.test.ts` and `tests/browser/accessibility.spec.ts` (2 PASS in Chromium) verify keyboard control navigation, dialog focus restoration, 390 px narrow-viewport layout without horizontal overflow, non-looping Web Serial permission denial, and zero unsuppressed axe violations. Remaining blockers: `TASK-075`/`078` completion and manual assistive screen-reader / physical hardware verification.

### TASK-081 — Session export

- **Status:** DONE — Codex; baseline 660d86e; 2026-10-16. Bounded checksummed archives, metadata redaction, and browser import/export.
- **Title & Description:** Export/import AAR with manifests and no secrets.
- **Dependencies:** TASK-076, TASK-077.
- **Touched Files:** `packages/aar/src/archive.ts`, `apps/web/src/aar/Export.tsx`, `apps/web/src/App.tsx`, `tests/aar-archive.test.ts`, `tests/browser/aar.spec.ts`, `packages/aar/package.json`, `apps/web/package.json`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package-lock.json`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`.
- **Interfaces / Contracts:** Versioned archive; size/checksum limits; configurable key/serial-identifier redaction.
- **DoD & Acceptance Criteria:** Roundtrip export/import; reject archive bombs/oversized payloads/invalid hashes before allocation; no API keys/tokens in archives; show size and data categories.
- **Evidence:** Owner Codex; baseline 660d86e; 2026-10-16. `tests/aar-archive.test.ts` (2 PASS) and `tests/browser/aar.spec.ts` verify SHA-256 header+manifest+payload and per-record CRC validation, pre-allocation rejection of payloads exceeding `32` MiB or `4096`-byte metadata, API-key/serial-identifier redaction, and browser export/import roundtrip without replacing active flight state.

### TASK-082 — System acceptance matrix

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Hash-bound per-mode system matrix implemented; open dependencies (TASK-033, 047, 051, 073, 075–080) and unrun hardware/mode gates keep system acceptance blocked. TASK-074 HUD freshness is done and does not close this gate.
- **Title & Description:** Exercise supported modes against all UI/physics/telemetry gates.
- **Dependencies:** TASK-033, TASK-042, TASK-043, TASK-047, TASK-051, TASK-059, TASK-073, TASK-074, TASK-075, TASK-078, TASK-079, TASK-080, TASK-081.
- **Touched Files:** `tests/integration/system-acceptance.test.ts`, `docs/validation/system-matrix.json`, `scripts/validate-release.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** G0..G4; device/mode/model/firmware/provider coverage.
- **DoD & Acceptance Criteria:** Every requirement has PASS/FAIL/BLOCKED/NOT_RUN evidence; unit tests do not establish 60/120 FPS or real 400/800/1200 Hz; missing WASM/HITL/Google coverage explicitly blocks the affected mode.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `scripts/validate-release.mjs`, `docs/validation/system-matrix.json`, and `tests/integration/system-acceptance.test.ts` verify per-mode `G0`–`G4` status aggregation (`test-results/laptop/system-report.json` exits 1, preserving observed `G2` model-validation `FAIL` and `G3` GPU frame-time `FAIL` separately from `NOT_RUN` hardware/mode gates). Dependencies `TASK-042`, `TASK-043`, `TASK-059`, `TASK-074`, and `TASK-081` are `DONE`; `TASK-033`, `TASK-047`, `TASK-051`, `TASK-073`, and `TASK-075`/`078`/`079`/`080` remain open.

### TASK-083 — Release provenance and runbook

- **Status:** BLOCKED_EXTERNAL — Codex; baseline c3a4735; 2026-10-17. Bounded artifact/license/hash inventory and recovery runbook implemented; blocked on TASK-082, dataset/artifact license review, and clean-machine verification.
- **Title & Description:** Produce a verifiable release bundle and operational recovery instructions.
- **Dependencies:** TASK-003, TASK-082.
- **Touched Files:** `docs/operations/runbook.md`, `docs/operations/release-manifest.schema.json`, `scripts/release-manifest.mjs`, `tests/release-manifest.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `docs/documentation-index.json`, `docs/ru/runbook.md`, `scripts/validation/evidence.mjs`, `tests/evidence-tools.test.ts`, `tests/support/node-evidence.ts`.
- **Interfaces / Contracts:** Source/artifact/dataset/toolchain hashes; licenses; supported capability matrix.
- **DoD & Acceptance Criteria:** Verify clean-machine installation/build/startup; document rollback and owned-process cleanup; report actual blocked gates; never deploy/push automatically outside authorized scope.
- **Evidence:** Owner Codex; baseline c3a4735; 2026-10-17. `scripts/release-manifest.mjs`, `docs/operations/release-manifest.schema.json`, [runbook.md](operations/runbook.md), and `tests/release-manifest.test.ts` verify artifact/source/toolchain SHA-256 inventory and explicit `UNREVIEWED` license gating (`test-results/laptop/release-manifest.json` inventories 11 build files / `1,855,274` B and exits 1 while `TASK-082` and license/clean-machine reviews remain open).

## Current Verification & Hardware Summary

* **Software and native test suites (2026-10-19):** `npm run lint`, `npm run typecheck`, `npm run check:docs`, and `npm run build` exit 0. Unit suite: `540` PASS across `97` files (`test-results/validation/task-045-unit.xml`, `test-results/validation/task-059-tests.json`). Native Rust workspace (`cargo test --manifest-path native/Cargo.toml --workspace --locked`, Rust `1.97.0`): `62` PASS plus native contact ABI (`native/contact`: `4` PASS). Browser Playwright suite: `50` PASS in software Chromium (1 WebGPU skip on SwiftShader), `6/6` PASS on native RTX 4050 WebGPU (`test-results/laptop/browser-render-gpu.xml`), and `8/8` PASS on ArduCopter WASM Worker/EEPROM (`test-results/validation/task-045-browser.xml`).
* **Hot-path G1 allocation reports:** Zero observed GC events and zero incremental B/step across warmed `1e6`/`2e6`-step windows in `test-results/bench/physics.json`, `test-results/bench/wind.json`, `test-results/bench/sensors-ideal.json`, `test-results/bench/sensors-all.json`, `test-results/bench/sensors-body.json`, `test-results/bench/contact.json`, `test-results/bench/jsbsim-400.json`, `test-results/bench/links-ew-all-400.json`..`1200.json`, `test-results/bench/aar-400.json`..`1200.json`, and `test-results/bench/terrain-scenarios-400.json`..`1200.json`. On Windows Node (`test-results/laptop/bench-physics-400.json`, `bench-physics-800.json`, `bench-physics-1200.json`), the `bench-physics` realtime run executed 516.7 Hz (target 800) and 519.6 Hz (target 1200) with drops: ~16 ms timer wakeups x 8-step catch-up cap. Compute is ~1 us/step; the browser Worker 800 Hz regression passed.
* **Engine, SITL, and hardware captures:**
  * Contact & terrain coupling (`TASK-029`, `TASK-065`): `test-results/validation/task-029-completion.json`, `test-results/validation/task-029-binding.json`, `test-results/bench/contact-native-patched.json`.
  * JSBSim v1.2.3 WASM, contact & UIUC propellers (`TASK-030`, `TASK-031`, `TASK-086`): `test-results/validation/jsbsim-artifact.json`, `test-results/validation/task-031-native.json`, `test-results/validation/task-031-backend.json`, `test-results/validation/task-031-completion.json`, `test-results/validation/jsbsim-propellers.json`.
  * Model validation (`TASK-033`): `test-results/validation/model-report.json`, `test-results/validation/nasa-drop-legacy.json`, `test-results/validation/propeller-points.json`, `test-results/validation/propeller-bem.json`, `test-results/validation/task-033-continuation.json` (12/12 numerical PASS; NASA drop deferred/failing archive preserved; UIUC propeller fixed-tolerance fidelity FAIL, exit 2).
  * Native ArduCopter SITL, `LiveEkfWarmup`, and EW fault regressions (`TASK-042`, `TASK-043`, `TASK-059`): `test-results/validation/task-042-flight.json`, `test-results/validation/task-042-completion.json`, `test-results/validation/task-043-warmup.json`, `test-results/validation/task-043-completion.json`, `test-results/validation/task-059-native.json`, `test-results/validation/task-059-flight-regression.json`.
  * ArduCopter WASM build & Worker/EEPROM boot (`TASK-045`): `test-results/validation/task-045-completion.json`, `test-results/validation/task-045-wire-audit.json`.
  * Local hardware & laptop probes (`TASK-048`, `TASK-050`, `TASK-051`, `TASK-073`, `TASK-082`, `TASK-083`): passive USB MAVLink2 capture from a Matek H743-WING (`ArduCopter V4.5.7`) on `COM7` in `test-results/hardware/serial-com7-matek.json`; Windows 11 / RTX 4050 Laptop GPU probes in `test-results/laptop/summary.json`, `test-results/laptop/gpu-rtx4050-60.json`, `test-results/laptop/gpu-rtx4050-120.json`, `test-results/laptop/gpu-rtx4050-native144.json`, `test-results/laptop/system-report.json`, and `test-results/laptop/release-manifest.json`. See [runbook.md](operations/runbook.md) and [V2_PLAN.md](V2_PLAN.md) for operational commands and environment setup.
