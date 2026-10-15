# PROJECT_ROADMAP.md

Version 1.0 · 2026-10-15 · baseline `e3bb6b4`. English is the source of truth.
[Russian mirror](ru/PROJECT_ROADMAP.md).

Future modules are not claimed as implemented. The current baseline is a demo
React/Worker/SAB v1/Gamepad application with 400 Hz integration dt, 13 unit
tests, and four browser tests. Historical DONE entries refer to that validation,
not to unimplemented extensions.

Contracts: [Shared Memory](SPECS_SHARED_MEMORY.md),
[Simulation Engines](SPECS_SIMULATION_ENGINES.md), and [Agent workflow](../CLAUDE.md).
V1 source describes current behavior; v2 documentation defines the migration
target. Document generation itself does not implement runtime changes.

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
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. Clean npm ci preserved the lockfile SHA-256; build exit 0; 25 unit and 4 browser tests passed, with no skips/failures.


### TASK-002 — Type and lint gates

- **Status:** DONE — implemented and locally verified.
- **Title & Description:** Add dedicated typecheck/lint commands and eliminate explicit or implicitly unsafe any, including the browser dynamic import.
- **Dependencies:** TASK-001.
- **Touched Files:** `package.json`, `package-lock.json`, `eslint.config.mjs`, `tsconfig.json`, `tests/browser/simulation.spec.ts`, `tests/tooling.test.ts`, `tests/fixtures/tooling/unsafe-types.txt`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** unknown with runtime narrowing; strict/noUncheckedIndexedAccess; typed module imports.
- **DoD & Acceptance Criteria:** npm run lint and npm run typecheck execute successfully; negative fixtures with explicit any and unsafe assignment fail; do not weaken strict settings to accommodate existing code.
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. ESLint 10/typescript-eslint typed rules pass without suppression; npm run lint and npm run typecheck exit 0. tests/tooling.test.ts: 3 PASS; negative any/unsafe fixtures and TS2322 verified. Full suite: 25 unit and 4 browser PASS.


### TASK-003 — Automated CI

- **Status:** BLOCKED_EXTERNAL — implementation complete; hosted-run verification unavailable.
- **Title & Description:** Run pull-request checks without hardware or paid APIs.
- **Dependencies:** TASK-002.
- **Touched Files:** `.github/workflows/ci.yml`, `playwright.config.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package.json`, `package-lock.json`, `vitest.config.ts`, `.gitignore`, `tests/ci.test.ts`.
- **Interfaces / Contracts:** Node 24, frozen npm lock; separate unit/browser/build jobs.
- **DoD & Acceptance Criteria:** CI runs nonzero test counts and retains results/failure traces; no-tests and failed jobs fail the pipeline; synthetic checks require no secrets.
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. Three independent CI jobs implemented; tests/ci.test.ts: 3 PASS, including both runners rejecting zero tests. Local CI commands pass: 25 unit, 4 browser, production build. Reports: test-results/unit/junit.xml and test-results/browser/junit.xml, no skips/failures; build.log and apps/web/dist generated. Hosted Actions API read blocked by proxy CONNECT 403; inspect the first hosted run after push. No credentials or hardware required for synthetic jobs.


### TASK-004 — Golden fixtures and seed registry

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Define shared reference manifests with provenance and a deterministic PRNG.
- **Dependencies:** TASK-002.
- **Touched Files:** `packages/test-support/package.json`, `packages/test-support/src/fixtures.ts`, `packages/test-support/src/prng.ts`, `tests/fixtures.test.ts`, `tests/fixtures/registry.json`, `package-lock.json`, `tests/fixtures/ballistic.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** FixtureManifest {id, sourceSha256, units, validityEnvelope, tolerance}; PRNG algorithm/version.
- **DoD & Acceptance Criteria:** A known seed produces a frozen sequence; stream IDs are independent; invalid units/hashes fail validation; synthetic fixtures are never labeled experimental measurements.
- **Evidence:** Owner Codex; baseline c26df78; 2026-10-15. tests/fixtures.test.ts: 4 PASS. Seed 123 / stream 7 matches the frozen mulberry32-mix32-v1 vector; separate states/reset/zero seed and float bounds verified. Both raw-byte fixture hashes, unit/envelope/tolerance rejection, and provenance discrimination pass. Fixtures remain explicitly synthetic.

### TASK-005 — Runtime capability gate

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Detect SAB/WebGL2/WebGPU/Gamepad/Serial and expose eligible modes without false READY states.
- **Dependencies:** TASK-001, TASK-002.
- **Touched Files:** `apps/web/src/capabilities.ts`, `apps/web/src/App.tsx`, `tests/capabilities.test.ts`, `tests/browser/capabilities.spec.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** CapabilityReport; mode eligibility.
- **DoD & Acceptance Criteria:** Mocking each missing API produces an explicit disabled state; missing isolation blocks the Worker; WebGPU failure retains WebGL2 fallback.
- **Evidence:** Owner Codex; baseline c26df78; 2026-10-15. tests/capabilities.test.ts: 7 PASS; tests/browser/capabilities.spec.ts: 7 PASS on system Chromium 154. Missing secure context/isolation/SAB/Worker/WebGL2 blocks Start; missing Gamepad disables USB. Rejected/absent/timed-out GPU probes preserve WebGL2. API presence never enables future HITL/WebGPU modes.

### TASK-006 — Model manifest schema

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Validate model/frame/units/hash and configuration version before loading.
- **Dependencies:** TASK-004.
- **Touched Files:** `packages/physics/src/model-manifest.ts`, `packages/physics/src/model.schema.json`, `tests/model-manifest.test.ts`, `tests/fixtures/models/demo-quad.json`, `packages/physics/package.json`, `package-lock.json`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** ModelDescriptor, RotorGeometry, session modelId-to-SHA registry; SPD inertia.
- **DoD & Acceptance Criteria:** Positive/negative fixtures cover NaN, nonpositive mass, non-SPD inertia, duplicate motor IDs, rotorCount>32, and invalid quaternions; verify the hash before swapping.
- **Evidence:** Owner Codex; baseline c26df78; 2026-10-15. tests/model-manifest.test.ts: 4 PASS. Schema/frame/units/count/NaN, symmetric positive-definite inertia, unique IDs/channels, quaternion and element validation exercised. Raw SHA-256 precedes registry admission; failed hash/schema/collision preserves the existing model. Byte mutation during hashing cannot alter the verified snapshot. Runtime switching remains TASK-010.

### TASK-084 — Agent rule discovery

- **Status:** DONE — Claude; baseline 1064a57; 2026-10-15.
- **Title & Description:** Add thin entry points directing Codex/Cursor to the authoritative CLAUDE.md.
- **Dependencies:** TASK-001.
- **Touched Files:** `AGENTS.md`, `.cursor/rules/project.mdc`, `tests/agent-config.test.ts`, `docs/ru/AGENTS.md`, `docs/documentation-index.json`, `tests/documentation-policy.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** CLAUDE.md is the authoritative workflow; wrappers link to it rather than copying rules.
- **DoD & Acceptance Criteria:** A check resolves root CLAUDE.md from both entry points; the Cursor rule sets alwaysApply=true; do not claim automatic discovery by an unknown client.
- **Evidence:** Owner Claude; baseline 1064a57; 2026-10-15. AGENTS.md (registered EN/RU pair, because check:docs requires every Markdown file to be paired) and .cursor/rules/project.mdc link to root CLAUDE.md without copying its policy headings; the Cursor front matter sets alwaysApply: true. tests/agent-config.test.ts: 3 PASS (both links resolve to root CLAUDE.md, no duplicated policy headings, no claim that a named client loads a file automatically). tests/documentation-policy.test.ts now derives the expected pair/task counts from the registry and roadmap instead of hard-coding them. CLAUDE.md agent-discovery paragraph and all touched mirrors synchronized; npm run check:docs exit 0.

## Phase 1: Shared Memory & Worker

### TASK-007 — Retain the ABI v1 baseline

- **Status:** DONE — Codex; baseline c26df78; 2026-10-15.
- **Title & Description:** Preserve current reader/writer and lifecycle regressions as the migration baseline.
- **Dependencies:** TASK-001.
- **Touched Files:** `packages/protocol/src/index.ts`, `tests/protocol.test.ts`, `tests/protocol-golden.test.ts`, `tests/fixtures/abi/v1-layout.json`, `tests/fixtures/registry.json`, `tests/browser/simulation.spec.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** V1: 32896 bytes, 128-byte states, 400 Hz.
- **DoD & Acceptance Criteria:** DONE baseline e3bb6b4: four existing protocol tests cover size/version, float64 roundtrip, ring overwrite, busy frames, and controls; the browser verifies lifecycle.
- **Evidence:** Owner Codex; baseline c26df78; 2026-10-15. tests/protocol.test.ts: 4 PASS, including pinned 32896-byte size, header/mailbox offsets, and an independently packed 128-byte state golden. All four existing simulation browser tests pass, including real Worker fixed dt, stale input, lifecycle ACKs, USB failsafe, and mobile layout. V1 unchanged; no v2 runtime introduced. Full verification: frozen npm ci, npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 40 PASS; CI=true CHROMIUM_PATH=/usr/bin/chromium npm run test:browser: 11 PASS; no failures/skips. JUnit: test-results/unit/junit.xml and test-results/browser/junit.xml. Node 24.19.0, Chromium 154.0.8037.57, Debian cloud/software rendering. English/Russian README, architecture and roadmap synchronized. No target-GPU/hardware performance claim. Golden layout follow-up: owner Claude; baseline f13213b; 2026-10-15. tests/protocol-golden.test.ts: 4 PASS. The registered synthetic fixture abi-v1-layout (tests/fixtures/abi/v1-layout.json, SHA-256 00a2e97d75521263f4348199c5e0086dd720949cffc92185cdaf97fbd1fd8be0, tolerance 0) is cross-checked field by field against the Header/State/Pilot mailbox v1 tables in SPECS_SHARED_MEMORY.md and compared with all 32896 bytes written by StateWriter and ControlWriter without the v1 readers. Mutation checks: a symmetric mailbox roll/pitch swap passed every pre-existing test and failed only this test; a symmetric state spool/voltage swap and a specification row swap also failed. npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 44 PASS; CI=true npm run test:browser: 11 PASS with Playwright Chromium build 1194. Node 22.22.0 (container; .nvmrc requests 24). Pre-existing: tests/tooling.test.ts typed ESLint case takes 4.3-4.6 s against the 5 s default timeout and timed out once in five full runs, with or without this change.

### TASK-008 — ABI v2 constants and layout

- **Status:** DONE — Claude; baseline 695023c; 2026-10-15.
- **Title & Description:** Introduce v2 independently of v1 and create a golden binary fixture.
- **Dependencies:** TASK-006, TASK-007.
- **Touched Files:** `packages/protocol/src/layout-v2.ts`, `packages/protocol/src/state-v2.ts`, `tests/layout-v2.test.ts`, `tests/fixtures/protocol/state-v2.hex`, `packages/protocol/src/pilot-v2.ts`, `packages/protocol/src/index.ts`, `tsconfig.json`, `tests/support/spec-layout.ts`, `tests/support/golden-v2.ts`, `tests/protocol-golden.test.ts`, `tests/fixtures/registry.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY section 3; 49280 bytes; 192-byte state stride; TickId lo/hi.
- **DoD & Acceptance Criteria:** Offset/size/alignment tests cover every field; bytes match the golden fixture; v2 validation rejects v1; reserved words are zero.
- **Evidence:** Owner Claude; baseline 695023c; 2026-10-15. tests/layout-v2.test.ts: 11 PASS. Registered synthetic fixture abi-v2-golden (tests/fixtures/protocol/state-v2.hex, packed with Python struct from the section 3 tables independently of the TypeScript encoder, tolerance 0) matches the Header v2, State v2, and Pilot mailbox v2 tables field by field with full byte coverage; StateOffsetV2, PilotOffsetV2, and HeaderV2 cover every field; natural alignment holds in all 256 slots; StateCodecV2/PilotCodecV2 pack the golden values to the golden bytes and decode them back; createSharedMemoryV2 writes the golden header with zero ring and mailbox; validation rejects v1 buffers and 13 malformed header words; negotiateAbiVersion returns 1/2 and rejects a v1-sized buffer claiming version 2; tick carry, comparison, and 2^53 bounds; writer-side value contracts. Mutation checks: a symmetric battery voltage/current offset swap and a specification type change each fail. Extras beyond the listed files: pilot-v2.ts (the v2 mailbox is part of the same layout), index.ts re-exports, and tsconfig allowImportingTsExtensions (protocol modules use .ts imports so Node workers can load them for TASK-009). The shared specification parser now also backs the v1 golden test. npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 58 PASS. Node 22.22.0. The runtime still uses v1; English/Russian specification, README, architecture, and roadmap synchronized.

### TASK-009 — Atomic v2 readers and writers

- **Status:** DONE — Claude; baseline 0cc6d4c; 2026-10-15.
- **Title & Description:** Implement bounded seqlock, sample_id publication, and epoch-safe render history.
- **Dependencies:** TASK-008.
- **Touched Files:** `packages/protocol/src/atomic-v2.ts`, `packages/protocol/src/index.ts`, `tests/atomic-v2.test.ts`, `tests/browser/atomic-v2.spec.ts`, `tests/support/atomic-v2-stress.ts`, `tests/support/atomic-v2-stress.node-worker.ts`, `tests/support/atomic-v2-stress.browser-worker.ts`, `tests/tooling.test.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** StateWriterV2/StateReaderV2; single writer; at most three read attempts.
- **DoD & Acceptance Criteria:** 1e6 concurrent publications produce no torn fields; an interrupted writer yields miss without mutating output; test counters/epochs/reset; retain v1 tests until compatibility removal is explicit.
- **Evidence:** Owner Claude; baseline 0cc6d4c; 2026-10-15. tests/atomic-v2.test.ts: 9 PASS: golden state published as seqlock 2 plus golden bytes with sample_id=published; contract-violating states rejected without touching shared memory; ring wrap and age reads; a frame interrupted mid-write and a sample_id/head mismatch both miss without mutating output; counters, runtime flags, epoch, and rate; latestPair never pairs across epoch, model, or tick gaps but pairs across the 32-bit tick carry; pilot mailbox round trip and busy miss; v1 buffers refused. Concurrency: 1e6 publications from a Node worker_threads writer with a reader alternating newest and oldest (being-overwritten) slots: 272286 successful reads, 0 torn, 0 NaN, 0 regressions; tests/browser/atomic-v2.spec.ts in a Chromium module Worker: 611561 reads, 0 torn. Mutation checks: removing the seqlock re-check produced torn frames (3647 in the browser) and failed both stress tests; removing the sample_id check failed the deterministic head-mismatch test. tests/tooling.test.ts: the typed-lint case now has an explicit 30 s timeout because the stress test pushed it past the 5 s default (5.1-6.1 s measured). npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 67 PASS three consecutive runs; CI=true npm run test:browser: 12 PASS (Playwright Chromium build 1194). Node 22.22.0. apps/web/src/runtime.ts and physics.worker.ts are not migrated: WorkerInitV2 needs the TASK-013 sensor/actuator buffers, so the migration moved to new TASK-085 instead of a scaffold. v1 tests retained.

### TASK-010 — Control Protocol v2

- **Status:** DONE — Claude; baseline 3b1711b; 2026-10-15.
- **Title & Description:** Validate lifecycle, weather, model, and fault commands with deterministic acknowledgements.
- **Dependencies:** TASK-008, TASK-009.
- **Touched Files:** `packages/protocol/src/control-v2.ts`, `packages/protocol/src/control-v2.schema.json`, `tests/control-v2.test.ts`, `packages/protocol/src/index.ts`, `package.json`, `package-lock.json`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY section 6; unknown to ControlCommandV2; queued/applied/reject.
- **DoD & Acceptance Criteria:** Every branch has positive/negative fixtures; stale epoch, duplicate IDs, past ticks, and queue 128+1 are handled as specified; a failed model swap retains the previous paused model.
- **Evidence:** Owner Claude; baseline 3b1711b; 2026-10-15. tests/control-v2.test.ts: 72 PASS. 60 validation fixtures cover every command and effect branch (positive and negative: shape, additional/missing properties, NaN/Infinity/undefined, non-integers, enums, patterns, u32 bounds, every numeric envelope, drift norm, 16 KiB limit); the JSON Schema (Ajv 8.18.0, Ajv2020 strict) agrees with the TypeScript validator on all 55 JSON-representable cases except the documented drift-norm rule; the specification's JSON example is accepted. Processor: lifecycle ACKs and paused+disarmed rules, STALE_EPOCH, exact-duplicate replay without reapplication across an epoch change, different-payload reuse, high-water eviction after 128 IDs, malformed commands consuming no ID, past-tick and 10 s horizon rejection, application before the tick in receipt order with queued then applied ACKs, queue 128+1 OVERLOAD keeping older commands, cancellation on reset/dispose, failed model swap (ASSET_MISSING, previous model and epoch retained, paused) versus successful swap (new epoch), and no commit after dispose. Mutation checks: removing the queue limit, applying one tick late, and committing on a failed load each fail. Ajv is a dev dependency only (tests); frozen npm ci reproduces the lockfile. npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 139 PASS. Node 22.22.0. apps/web/src/physics.worker.ts is not wired (TASK-085). Late/out-of-order ACK handling on Main belongs with TASK-085; allocation measurement of beforeTick belongs to TASK-014.

### TASK-011 — 400/800/1200 Hz clocks

- **Status:** TODO.
- **Title & Description:** Parameterize scheduler/dt and rational sensor timestamps.
- **Dependencies:** TASK-010.
- **Touched Files:** `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `apps/web/src/physics.worker.ts`, `tests/clock.test.ts`.
- **Interfaces / Contracts:** PhysicsHz; TickId; simTime=tick/hz; fixed dt.
- **DoD & Acceptance Criteria:** A fake clock produces 4000/8000/12000 steps in 10 s without accumulated dt drift; pause/resume creates no backlog; 1200 Hz time_usec intervals are 833/834 microseconds.

### TASK-012 — Clock modes and overload

- **Status:** TODO.
- **Title & Description:** Separate interactive time dropping, SITL lockstep waiting, and HITL fault policies.
- **Dependencies:** TASK-011.
- **Touched Files:** `packages/physics/src/clock-policy.ts`, `apps/web/src/physics.worker.ts`, `tests/clock-policy.test.ts`.
- **Interfaces / Contracts:** interactive / sitl-lockstep / hitl-realtime; maxCatchUp=8.
- **DoD & Acceptance Criteria:** A 1 s stall counts interactive drops, preserves every SITL simulation tick, and invalidates HITL; pause/dispose remain responsive when actuators are absent.

### TASK-013 — Sensor/actuator SPSC queues

- **Status:** TODO.
- **Title & Description:** Implement separate bounded queues with strict ownership and backpressure.
- **Dependencies:** TASK-008, TASK-009, TASK-012.
- **Touched Files:** `packages/protocol/src/spsc-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/spsc-v2.test.ts`, `tests/browser/spsc-v2.spec.ts`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY section 5; capacity=1024, stride=128.
- **DoD & Acceptance Criteria:** Test full/empty/wrap/reset; never overwrite unread slots; 1e6 frames retain order; SITL/HITL policies handle overflow without silent drops.

### TASK-014 — Hot-path instrumentation

- **Status:** TODO.
- **Title & Description:** Measure allocation counts, step duration, and deadline lateness in a machine-readable report.
- **Dependencies:** TASK-009, TASK-011, TASK-013.
- **Touched Files:** `packages/physics/src/step-metrics.ts`, `scripts/bench-physics.mjs`, `tests/step-metrics.test.ts`, `docs/benchmarks/schema.json`.
- **Interfaces / Contracts:** G1/G3; compute duration, wakeup lateness, and executed Hz are separate metrics.
- **DoD & Acceptance Criteria:** After warmup, 1e6 steps have zero explicit JS/WASM allocations and constant arena size; baseline report records p50/p95/p99/max and environment; measure profiler overhead separately.

### TASK-015 — Interpolation and epoch changes

- **Status:** TODO.
- **Title & Description:** Render smoothly without interpolating across reset or model replacement.
- **Dependencies:** TASK-009, TASK-011.
- **Touched Files:** `apps/web/src/FlightScene.tsx`, `apps/web/src/coordinates.ts`, `packages/protocol/src/interpolation.ts`, `tests/interpolation.test.ts`.
- **Interfaces / Contracts:** Adjacent ticks in the same epoch/model; shortest-path quaternion SLERP.
- **DoD & Acceptance Criteria:** q and -q do not cause a full rotation; NED basis tests pass; reset/teleport breaks history; rendering never waits for the writer or mutates truth.

### TASK-085 — Migrate Worker and Main to ABI v2

- **Status:** TODO.
- **Title & Description:** Switch the running application from ABI v1 and the v1 postMessage protocol to the v2 state ring, pilot mailbox, WorkerInitV2, and Control Protocol v2. Split out of TASK-009/010 because WorkerInitV2 requires the TASK-013 sensor/actuator buffers.
- **Dependencies:** TASK-009, TASK-010, TASK-013.
- **Touched Files:** `apps/web/src/runtime.ts`, `apps/web/src/physics.worker.ts`, `apps/web/src/App.tsx`, `tests/browser/simulation.spec.ts`, `tests/browser/runtime-v2.spec.ts`.
- **Interfaces / Contracts:** WorkerInitV2; StateWriterV2/StateReaderV2; PilotWriterV2/PilotReaderV2; ControlProcessorV2; SPECS_SHARED_MEMORY sections 3–6.
- **DoD & Acceptance Criteria:** Lifecycle, stale-input, USB-failsafe, and fixed-dt browser tests pass on v2; a stale epoch or changed device_generation disarms; rendering never interpolates across epochs; v1 compatibility is removed only by a recorded decision.

## Phase 2: Aerodynamics & WASM

### TASK-016 — Native Rust workspace

- **Status:** TODO.
- **Title & Description:** Create a pinned scalar BET crate and native tests.
- **Dependencies:** TASK-003, TASK-004.
- **Touched Files:** `native/Cargo.toml`, `native/Cargo.lock`, `native/rust-toolchain.toml`, `native/bet/Cargo.toml`, `native/bet/src/lib.rs`, `.github/workflows/native.yml`.
- **Interfaces / Contracts:** wasm32-unknown-unknown; repr(C) boundary; scalar by default.
- **DoD & Acceptance Criteria:** cargo check/test --locked pass; pin toolchain/target; verify a reproducible bootstrap kernel artifact in Chromium without claiming production aerodynamics.

### TASK-017 — WASM build and loading

- **Status:** TODO.
- **Title & Description:** Implement hash/ABI validation and scalar/SIMD artifact selection.
- **Dependencies:** TASK-005, TASK-016.
- **Touched Files:** `packages/wasm-bet/package.json`, `packages/wasm-bet/src/loader.ts`, `scripts/build-wasm.mjs`, `tests/wasm-loader.test.ts`, `tests/browser/wasm-loader.spec.ts`.
- **Interfaces / Contracts:** bet_abi_version; artifact manifest; SIMD feature detection.
- **DoD & Acceptance Criteria:** Corrupt hashes/ABI block arming; unsupported SIMD uses scalar fallback; instantiate outside step; reserve the BET baseline memory budget of <=64 MiB before running.

### TASK-018 — C ABI and arena binding

- **Status:** TODO.
- **Title & Description:** Define checked input/config/output records without per-step object marshaling.
- **Dependencies:** TASK-006, TASK-017.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/include/bet.h`, `packages/wasm-bet/src/arena.ts`, `tests/wasm-abi.test.ts`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES section 4; rotor output stride=128.
- **DoD & Acceptance Criteria:** Rust size/offset tests match TS golden records; reject invalid pointers/counts/sizes; 1e6 step calls perform no allocation/growth and overwrite output in place.

### TASK-019 — Polar lookup

- **Status:** TODO.
- **Title & Description:** Interpolate CL/CD over alpha/logRe/Mach with validated bounds.
- **Dependencies:** TASK-004, TASK-018.
- **Touched Files:** `native/bet/src/polar.rs`, `tests/fixtures/polars/synthetic.json`, `native/bet/tests/polar.rs`.
- **Interfaces / Contracts:** PolarTable; flattened (Mach,Re,alpha); validity flags.
- **DoD & Acceptance Criteria:** Analytic tests cover nodes/interpolation/reverse flow/bounds; reject negative CD/NaN; out-of-range inputs clamp and flag instead of silently extrapolating.

### TASK-020 — Blade element quadrature

- **Status:** TODO.
- **Title & Description:** Integrate element forces/moments for prescribed omega and inflow.
- **Dependencies:** TASK-019, TASK-032.
- **Touched Files:** `native/bet/src/blade.rs`, `native/bet/src/quadrature.rs`, `native/bet/tests/blade.rs`.
- **Interfaces / Contracts:** RotorGeometry/RotorStepInput; equations in section 3.
- **DoD & Acceptance Criteria:** Test zero flow, mirrored spin, drag dissipation, and independent wrench fixtures; sample count does not multiply total force; 16/32/64 refinement converges within fixture tolerance.

### TASK-021 — Dynamic inflow

- **Status:** TODO.
- **Title & Description:** Add bounded axial induced-flow state and its validity envelope.
- **Dependencies:** TASK-020.
- **Touched Files:** `native/bet/src/inflow.rs`, `native/bet/tests/inflow.rs`, `tests/fixtures/rotors/axial-inflow.json`.
- **Interfaces / Contracts:** Signed induced velocity; at most four solver iterations per step.
- **DoD & Acceptance Criteria:** Hover momentum residual is <=1% of fixture thrust; test transient convergence; mark VRS/out-of-envelope cases unvalidated; zero RPM/flow remains finite.

### TASK-022 — Free shaft and autorotation

- **Status:** TODO.
- **Title & Description:** Integrate RPM from aerodynamic torque, drive torque, and losses without an RPM governor.
- **Dependencies:** TASK-021.
- **Touched Files:** `native/bet/src/shaft.rs`, `native/bet/tests/autorotation.rs`, `tests/fixtures/rotors/free-shaft.json`.
- **Interfaces / Contracts:** J*dOmega/dt=tau_motor+s*Qair-tau_loss; RotorState.
- **DoD & Acceptance Criteria:** Without flow/drive, energy decreases; permitted airflow drives acceleration/deceleration through torque; steady residual<0.01 Nm; no artificial prescribed RPM.

### TASK-023 — Flapping and gyroscopic momentum

- **Status:** TODO.
- **Title & Description:** Implement coning/first-harmonic flapping and complete dH/dt transmission.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/src/flapping.rs`, `native/bet/src/momentum.rs`, `native/bet/tests/flapping.rs`.
- **Interfaces / Contracts:** RotorState flap states; Mhub=Mair-dH/dt; documented hinge parameters.
- **DoD & Acceptance Criteria:** Test symmetry, sign/axes, angular momentum balance, and timestep convergence; retain equation sources/validity; mesh tilt never substitutes for dynamics.

### TASK-024 — Coaxial interaction

- **Status:** TODO.
- **Title & Description:** Introduce explicit wake coupling for a pair of rotor disks.
- **Dependencies:** TASK-021, TASK-023.
- **Touched Files:** `native/bet/src/coaxial.rs`, `native/bet/tests/coaxial.rs`, `tests/fixtures/rotors/coaxial.json`.
- **Interfaces / Contracts:** WakePair {upperId,lowerId,separationM,overlap}; energy/source provenance.
- **DoD & Acceptance Criteria:** Disabled coupling matches independent rotors; large separation approaches independence; check momentum/energy accounting; without measurements label the model experimental.

### TASK-025 — ESC and spool model

- **Status:** TODO.
- **Title & Description:** Convert duty into drive torque/RPM transients using the selected motor model.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/src/motor.rs`, `native/bet/tests/motor.rs`, `packages/physics/src/motor-config.ts`.
- **Interfaces / Contracts:** Torque model or first-order governor; current/back-EMF limits.
- **DoD & Acceptance Criteria:** Duty steps follow configured lag/current saturation; zero voltage creates no energy; power cuts preserve spin decay; never integrate two spool ODEs simultaneously.

### TASK-026 — Battery sag

- **Status:** TODO.
- **Title & Description:** Calculate SOC, bus voltage, and available power across all motors.
- **Dependencies:** TASK-025.
- **Touched Files:** `native/bet/src/battery.rs`, `native/bet/tests/battery.rs`, `tests/fixtures/power/battery.json`.
- **Interfaces / Contracts:** V=Voc-I*R; SOC; power-limited flags.
- **DoD & Acceptance Criteria:** Analytic resistance, R approaching zero, depleted SOC, and infeasible power cases remain finite; energy/current signs agree; count every motor load exactly once.

### TASK-027 — Arbitrary frame wrench

- **Status:** TODO.
- **Title & Description:** Aggregate thrust vectors, moment arms, and transmitted rotor moments.
- **Dependencies:** TASK-006, TASK-023, TASK-025, TASK-026.
- **Touched Files:** `native/bet/src/frame.rs`, `packages/physics/src/frame.ts`, `native/bet/tests/frame.rs`, `tests/fixtures/models/tilted-octo.json`.
- **Interfaces / Contracts:** F=sum R*F; M=sum(r cross R*F+R*Mhub); stable motor IDs.
- **DoD & Acceptance Criteria:** Quad/hexa/tilted-octo fixtures verify symmetry, yaw cancellation, and handedness; tilted axes generate lateral force; motor reaction is never counted twice.

### TASK-028 — Rigid-body integrator

- **Status:** TODO.
- **Title & Description:** Integrate BET wrench using mass/inertia, quaternion, and NED gravity.
- **Dependencies:** TASK-027.
- **Touched Files:** `native/bet/src/rigid_body.rs`, `packages/wasm-bet/src/backend.ts`, `native/bet/tests/rigid_body.rs`.
- **Interfaces / Contracts:** DynamicsBackend, TruthOutput; one integration owner.
- **DoD & Acceptance Criteria:** Test ballistic/torque-free/constant-torque cases; native quaternion norm error<1e-10; trajectories remain finite; check 400/800/1200 convergence against offline 4800 Hz.

### TASK-029 — Landing-gear contact

- **Status:** TODO.
- **Title & Description:** Integrate one chosen contact solver and synchronize impulses.
- **Dependencies:** TASK-028.
- **Touched Files:** `packages/physics/src/contact-backend.ts`, `packages/physics/src/ground-contact.ts`, `tests/contact.test.ts`, `tests/fixtures/contact/drop.json`.
- **Interfaces / Contracts:** ContactImpulse {pointBody,impulseNed,dt}; choose Rapier or Jolt in an ADR.
- **DoD & Acceptance Criteria:** Drop/rolling/friction/nonpenetration fixtures pass; restitution adds no excess energy; a second solver never reintegrates the same body; meet G1 allocation budget.

### TASK-030 — Pinned JSBSim WASM artifact

- **Status:** TODO.
- **Title & Description:** Build JSBSim with reproducible source/toolchain manifests through Emscripten.
- **Dependencies:** TASK-003, TASK-004, TASK-006.
- **Touched Files:** `native/jsbsim/CMakeLists.txt`, `native/jsbsim/source.lock.json`, `native/jsbsim/toolchain.lock.json`, `scripts/build-jsbsim.mjs`, `packages/wasm-jsbsim/package.json`, `tests/jsbsim-artifact.test.ts`.
- **Interfaces / Contracts:** WASM C ABI version/hash; JSBSim and model-data licenses.
- **DoD & Acceptance Criteria:** Build pinned source with verified checksums; native/WASM references share source; unit conversion does not patch upstream physics; Worker artifact smoke passes.

### TASK-031 — JSBSim DynamicsBackend

- **Status:** TODO.
- **Title & Description:** Adapt JSBSim state, actuators, and contact exchange.
- **Dependencies:** TASK-018, TASK-029, TASK-030, TASK-032.
- **Touched Files:** `native/jsbsim/bridge.cpp`, `packages/wasm-jsbsim/src/backend.ts`, `tests/jsbsim-backend.test.ts`, `tests/fixtures/airframes/jsbsim-trim.json`, `native/jsbsim/property-map.json`.
- **Interfaces / Contracts:** DynamicsBackend; ft/slugs to SI; FRD/NED; JSBSim owns integration.
- **DoD & Acceptance Criteria:** Native/WASM trim and step-control fixtures meet manifest tolerances; stationary specific force/signs are correct; couple contact impulses consistently; no per-step allocation/growth.

### TASK-032 — Atmosphere and wind

- **Status:** TODO.
- **Title & Description:** Implement shared atmospheric state and deterministic gust input.
- **Dependencies:** TASK-004, TASK-006, TASK-010.
- **Touched Files:** `packages/physics/src/atmosphere.ts`, `packages/physics/src/wind.ts`, `tests/atmosphere.test.ts`.
- **Interfaces / Contracts:** Temperature/pressure to density/viscosity/speed of sound; seeded gust bandwidth.
- **DoD & Acceptance Criteria:** ISA references and calm/gust/reset/replay fixtures pass; JSBSim/BET share units; fixed seed is independent of render FPS; reject invalid near-zero density through schema validation.

### TASK-033 — Model validation gate

- **Status:** TODO.
- **Title & Description:** Run numerical/reference validation and report model fidelity separately.
- **Dependencies:** TASK-014, TASK-024, TASK-028, TASK-029, TASK-031.
- **Touched Files:** `scripts/validate-models.mjs`, `tests/model-validation.test.ts`, `docs/validation/model-report.schema.json`, `tests/fixtures/validation/reference-manifest.json`.
- **Interfaces / Contracts:** ValidityEnvelope; numerical parity is separate from experimental validity.
- **DoD & Acceptance Criteria:** Smooth 10 s cases stay within 0.1 m/0.5 degrees of 4800 Hz references; meet scalar/SIMD force/moment tolerances in section 4; retain reference provenance; missing measurements block fidelity rather than producing a synthetic PASS.

## Phase 3: ArduPilot & Radio Link

### TASK-034 — Ideal sensors

- **Status:** TODO.
- **Title & Description:** Convert truth into IMU/magnetometer/barometer/airspeed observations without noise or EW.
- **Dependencies:** TASK-013, TASK-028, TASK-032.
- **Touched Files:** `packages/sensors/package.json`, `packages/sensors/src/ideal.ts`, `tests/ideal-sensors.test.ts`.
- **Interfaces / Contracts:** GpsSample/ImuSample; acceleration versus specific force; gauss/Pa internal units.
- **DoD & Acceptance Criteria:** Stationary/free-fall/rotated-body fixtures pass; gyro/mag use body axes; verify pressure signs; write outputs in place and meet G1.

### TASK-035 — Sensor rates, noise, and bias

- **Status:** TODO.
- **Title & Description:** Add rational sampling, bounded latency, and seeded noise streams.
- **Dependencies:** TASK-004, TASK-011, TASK-034.
- **Touched Files:** `packages/sensors/src/scheduler.ts`, `packages/sensors/src/noise.ts`, `packages/sensors/src/latency.ts`, `tests/sensor-scheduler.test.ts`, `tests/sensor-noise.test.ts`.
- **Interfaces / Contracts:** IMU 200/400 Hz; GPS 5/10 Hz; PSD/bandwidth; sample time.
- **DoD & Acceptance Criteria:** Exact sample counts over 60 simulated seconds at 400/800/1200; repeatable seeds; statistics within declared confidence intervals; bounded monotonic latency queues.

### TASK-036 — WGS84 and MSL

- **Status:** TODO.
- **Title & Description:** Implement float64 origin/ECEF/NED/geoid conversion.
- **Dependencies:** TASK-004, TASK-006.
- **Touched Files:** `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `tests/geodesy.test.ts`, `tests/fixtures/geodesy/wgs84.json`.
- **Interfaces / Contracts:** WGS84 ellipsoidal h versus MSL H; authoritative geoid data/hash/license.
- **DoD & Acceptance Criteria:** Local synthetic roundtrips<=1 mm; test poles/antimeridian/15 km offsets without cos(latitude) singularities; absent geoid data explicitly blocks the absolute MSL accuracy gate.

### TASK-037 — MAVLink2 codec

- **Status:** TODO.
- **Title & Description:** Pin the dialect/generator and implement streaming binary parsing/encoding.
- **Dependencies:** TASK-003, TASK-004, TASK-013.
- **Touched Files:** `packages/mavlink/package.json`, `packages/mavlink/dialect.lock.json`, `packages/mavlink/src/codec.ts`, `packages/mavlink/src/sensor-mapping.ts`, `tests/mavlink.test.ts`, `tests/fixtures/mavlink/golden.json`.
- **Interfaces / Contracts:** HIL_GPS/HIL_SENSOR/HIL_ACTUATOR_CONTROLS/RC_CHANNELS_OVERRIDE; engine specification section 6.
- **DoD & Acceptance Criteria:** Match official-generated frames including CRC_EXTRA/packing; test arbitrary chunks/truncation/bad CRC/sequence; cover DOP times 100, gauss/hPa/LSB/u64; no unsafe any.

### TASK-038 — RC and flight-mode mapping

- **Status:** TODO.
- **Title & Description:** Extend USB calibration with modes and correctly encode RC override.
- **Dependencies:** TASK-010, TASK-037.
- **Touched Files:** `packages/input/src/mode-channel.ts`, `packages/input/src/calibration-store.ts`, `packages/mavlink/src/rc-override.ts`, `apps/web/src/App.tsx`, `tests/rc-override.test.ts`, `tests/browser/radio.spec.ts`.
- **Interfaces / Contracts:** Pilot mailbox v2; RC endpoints/deadzone/mode slots; channel-group sentinel semantics.
- **DoD & Acceptance Criteria:** Persist schema-versioned calibration; bad axes/unplug/reconnect disarm; enforce zero-throttle arming; test PWM endpoints and group-specific release/ignore; retain a separate physical USB checklist.

### TASK-039 — Autopilot state machine

- **Status:** TODO.
- **Title & Description:** Define mutually exclusive autopilot backends and lifecycle/link policies.
- **Dependencies:** TASK-010, TASK-012, TASK-013, TASK-037.
- **Touched Files:** `packages/autopilot/package.json`, `packages/autopilot/src/adapter.ts`, `packages/autopilot/src/state-machine.ts`, `tests/autopilot-state.test.ts`.
- **Interfaces / Contracts:** disconnected to initializing to warming to ready to running to fault; actuators/health.
- **DoD & Acceptance Criteria:** Reject illegal transitions and concurrent SITL/HITL; stale actuators/disarm/link loss cannot hold thrust indefinitely; never fabricate EKF READY.

### TASK-040 — Local WebSocket bridge

- **Status:** TODO.
- **Title & Description:** Implement loopback transport with origin/session checks and bounded framing.
- **Dependencies:** TASK-003, TASK-037, TASK-039.
- **Touched Files:** `apps/bridge/package.json`, `apps/bridge/src/server.ts`, `apps/bridge/src/session.ts`, `apps/bridge/src/framing.ts`, `tests/bridge.test.ts`.
- **Interfaces / Contracts:** WS localhost:9002; version/length/epoch binary frames; separate UDP channels.
- **DoD & Acceptance Criteria:** Reject unauthorized origins/sessions and oversized/flooded frames; bind loopback by default; test split/coalesced frames/backpressure/reconnect; document WSS/PNA compatibility.

### TASK-041 — ArduPilot JSON physics backend

- **Status:** TODO.
- **Title & Description:** Connect truth/sensors and servo outputs in external SITL lockstep.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-040.
- **Touched Files:** `apps/bridge/src/ardupilot-json.ts`, `packages/autopilot/src/external-sitl.ts`, `tests/ardupilot-json.test.ts`, `tests/fixtures/sitl/json-protocol.json`.
- **Interfaces / Contracts:** Pinned ArduPilot JSON protocol; frame counters/time domain; MAVLink does not replace physics JSON.
- **DoD & Acceptance Criteria:** Verify UDP schema/endianness/servo mapping against pinned upstream; lost/duplicate/out-of-order packets never double-step; wait for valid actuator before next tick while pause stays responsive.

### TASK-042 — External SITL integration harness

- **Status:** TODO.
- **Title & Description:** Run pinned ArduPilot and verify closed-loop flight without cloud APIs.
- **Dependencies:** TASK-031, TASK-037, TASK-038, TASK-039, TASK-041.
- **Touched Files:** `scripts/run-sitl.mjs`, `scripts/sitl.lock.json`, `tests/integration/external-sitl.test.ts`, `tests/fixtures/sitl/parameters.parm`.
- **Interfaces / Contracts:** Process lifecycle; RC/sensor/actuator loop; telemetry recording.
- **DoD & Acceptance Criteria:** Actually execute arm/takeoff/hold/land with nonzero frames; missing/fake binaries or bridge fail tests; clean up only owned processes; freeze mode/altitude thresholds in fixtures.

### TASK-043 — EKF warmup and health

- **Status:** TODO.
- **Title & Description:** Warm up for 30 simulated seconds and admit READY from actual EKF diagnostics.
- **Dependencies:** TASK-035, TASK-039, TASK-042.
- **Touched Files:** `packages/autopilot/src/warmup.ts`, `packages/autopilot/src/ekf-status.ts`, `tests/warmup.test.ts`, `tests/integration/ekf-ready.test.ts`.
- **Interfaces / Contracts:** Normalized ekf_flags; source freshness; fast-forward only for SITL.
- **DoD & Acceptance Criteria:** Sensor timestamps agree; failed innovations never become READY just because a timer elapsed; measure acceleration factor; reject HITL fast-forward; disable startup EW until ready.

### TASK-044 — ArduPilot WASM feasibility gate

- **Status:** TODO.
- **Title & Description:** Probe HAL/scheduler/storage/network/licensing and record a concrete feasibility decision.
- **Dependencies:** TASK-016, TASK-039, TASK-042.
- **Touched Files:** `docs/decisions/ardupilot-wasm.md`, `native/ardupilot/source.lock.json`, `native/ardupilot/feasibility.md`, `tests/ardupilot-wasm-capability.test.ts`.
- **Interfaces / Contracts:** Required browser HAL capabilities; supported firmware targets.
- **DoD & Acceptance Criteria:** Each capability has a runnable probe or observed blocker; record evidence for feasible/blocked; blocked leaves TASK-045..047 open and does not count as a working WASM mode.

### TASK-045 — ArduPilot WASM build

- **Status:** TODO.
- **Title & Description:** Build selected firmware with pinned tools and artifact hashes.
- **Dependencies:** TASK-044.
- **Touched Files:** `native/ardupilot/CMakeLists.txt`, `native/ardupilot/toolchain.lock.json`, `scripts/build-ardupilot-wasm.mjs`, `packages/autopilot/src/wasm-loader.ts`, `tests/ardupilot-wasm-build.test.ts`.
- **Interfaces / Contracts:** Artifact ABI/license/firmware manifest.
- **DoD & Acceptance Criteria:** A reproducible artifact loads in Worker with checked exports/memory limits; resolve TASK-044 blockers first; an empty replacement module is forbidden.

### TASK-046 — ArduPilot browser HAL

- **Status:** TODO.
- **Title & Description:** Connect clock/storage/sensor/actuator endpoints to WASM firmware.
- **Dependencies:** TASK-013, TASK-035, TASK-045.
- **Touched Files:** `native/ardupilot/hal/browser_hal.cpp`, `packages/autopilot/src/wasm-sitl.ts`, `tests/wasm-hal.test.ts`.
- **Interfaces / Contracts:** Simulation lockstep clock; virtual storage; preallocated mailboxes; separate AP Worker if required by HAL.
- **DoD & Acceptance Criteria:** Native/WASM HAL probes agree; no assumed native sockets/files; validate sensor timing/actuator counts; tab pause and termination do not deadlock.

### TASK-047 — WASM/native SITL parity

- **Status:** TODO.
- **Title & Description:** Compare identical scenarios and enable WASM mode only after passing parity.
- **Dependencies:** TASK-042, TASK-043, TASK-046.
- **Touched Files:** `tests/integration/wasm-sitl.test.ts`, `scripts/compare-autopilot.mjs`, `docs/validation/autopilot-parity.schema.json`.
- **Interfaces / Contracts:** Identical seeds/parameters/airframe; mode/EKF/trajectory tolerances.
- **DoD & Acceptance Criteria:** Both run arm/takeoff/land and failsafe; define thresholds first: position RMSE<=0.5 m and attitude RMSE<=2 degrees over the 30 s reference; diagnose divergence rather than automatically rewriting goldens.

### TASK-048 — Web Serial transport

- **Status:** TODO.
- **Title & Description:** Open ports only through a user gesture and handle stream/reconnect lifecycle.
- **Dependencies:** TASK-005, TASK-037, TASK-039.
- **Touched Files:** `packages/autopilot/src/serial-transport.ts`, `apps/web/src/SerialConnect.tsx`, `tests/serial-transport.test.ts`, `tests/browser/serial-permission.spec.ts`, `packages/autopilot/src/serial-io.worker.ts`.
- **Interfaces / Contracts:** ReadableStream chunks to MAVLink parser; permission/user gesture; port ownership.
- **DoD & Acceptance Criteria:** Mock chunk/error/disconnect/cancel cases; reopening never duplicates a reader; unsupported browsers disable the mode; mocks are not physical HITL evidence.

### TASK-049 — HIL sensor/actuator streaming

- **Status:** TODO.
- **Title & Description:** Send HIL_SENSOR/HIL_GPS and receive HIL_ACTUATOR_CONTROLS on real-time clocks.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-037, TASK-048.
- **Touched Files:** `packages/autopilot/src/hitl.ts`, `packages/autopilot/src/hil-clock.ts`, `tests/hil-stream.test.ts`.
- **Interfaces / Contracts:** IMU 200/400 Hz; GNSS 5/10 Hz; actuator mapping/signing/time.
- **DoD & Acceptance Criteria:** A 60 s fake real-time clock gives exact counts/bytes/timestamps; dropout/queue overflow fault; fields_updated matches observations; baud/10 serial budget retains at least 30% headroom.

### TASK-050 — HITL firmware capability gate

- **Status:** TODO.
- **Title & Description:** Verify board/build flags/message support before declaring HITL available.
- **Dependencies:** TASK-039, TASK-049.
- **Touched Files:** `packages/autopilot/src/hitl-capabilities.ts`, `docs/hardware/hitl-matrix.md`, `tests/hitl-capabilities.test.ts`.
- **Interfaces / Contracts:** Board/firmware SHA/HIL mode/MAVLink capability matrix.
- **DoD & Acceptance Criteria:** Unsupported HIL sensor/actuator paths cannot become READY; record a verified profile or exact BLOCKED_EXTERNAL requirement; SITL availability does not prove HITL support.

### TASK-051 — Physical HITL acceptance

- **Status:** TODO.
- **Title & Description:** Run a hardware bench and record transport/closed-loop integrity evidence.
- **Dependencies:** TASK-043, TASK-049, TASK-050.
- **Touched Files:** `scripts/bench-hitl.mjs`, `docs/hardware/hitl-test-procedure.md`, `docs/validation/hitl-report.schema.json`, `tests/hitl-report.test.ts`.
- **Interfaces / Contracts:** Board/firmware identity; timestamp jitter; sustained throughput; failsafe.
- **DoD & Acceptance Criteria:** Run 60 s sensor/actuator exchange; p99 sample scheduling lateness<=5 ms at 200 Hz or <=2.5 ms at 400 Hz; no overflow/unaccounted loss; unplug disables actuators; absent hardware is BLOCKED_EXTERNAL.

## Phase 4: EW & Sensor Faults

### TASK-052 — Hazard volumes

- **Status:** TODO.
- **Title & Description:** Compute bounded exposure for spheres, cones, and combinations.
- **Dependencies:** TASK-010, TASK-032.
- **Touched Files:** `packages/ew/package.json`, `packages/ew/src/volumes.ts`, `tests/ew-volumes.test.ts`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES section 5; r_min, relative power, angular taper.
- **DoD & Acceptance Criteria:** Test center/boundaries/cone axis/summation order; r=0 remains finite; outside exposure is zero; capacity<=64 and no per-step allocation.

### TASK-053 — GNSS jamming

- **Status:** TODO.
- **Title & Description:** Implement training severity-to-satellite/DOP/fix behavior with hysteresis.
- **Dependencies:** TASK-035, TASK-052.
- **Touched Files:** `packages/ew/src/gnss-jamming.ts`, `tests/gnss-jamming.test.ts`.
- **Interfaces / Contracts:** GpsSample; filtered q; Njam 0..3 and DOPjam 50..99.
- **DoD & Acceptance Criteria:** q=0 preserves the baseline; strong jamming removes fix; recovery thresholds are correct; no NaN/sentinel overflow; IMU/truth stay unchanged.

### TASK-054 — Position-step spoofing

- **Status:** TODO.
- **Title & Description:** Apply GPS displacement atomically at a specified tick.
- **Dependencies:** TASK-010, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/position-step.ts`, `tests/position-step.test.ts`.
- **Interfaces / Contracts:** offsetNedM; immutable source; WGS84 conversion before wire encoding.
- **DoD & Acceptance Criteria:** Position changes by the offset within geodesy tolerance; preserve baseline velocity; test zero/disable/reset, altitude Down sign, and antimeridian behavior.

### TASK-055 — Coherent drift

- **Status:** TODO.
- **Title & Description:** Integrate position/velocity bias on the physics clock with a speed cap and recovery policy.
- **Dependencies:** TASK-011, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/velocity-drift.ts`, `tests/velocity-drift.test.ts`.
- **Interfaces / Contracts:** b/v/a equations in section 5; hold-offset versus step-to-truth.
- **DoD & Acceptance Criteria:** Constant-acceleration analytic fixtures pass; piecewise speed limiting preserves position/velocity consistency; GPS/render rates do not change state; no promise of bypassing EKF gates.

### TASK-056 — Magnetic anomalies

- **Status:** TODO.
- **Title & Description:** Distort magnetic vectors in the correct sensor/body frame.
- **Dependencies:** TASK-034, TASK-052.
- **Touched Files:** `packages/ew/src/magnetic.ts`, `tests/magnetic-anomaly.test.ts`.
- **Interfaces / Contracts:** Rz*Ry*Rx plus biasBodyGauss; truth quaternion is unchanged.
- **DoD & Acceptance Criteria:** Zero anomaly is identity; synthetic 90-degree rotations preserve norm; test bias units; truth/gyro stay unchanged; reject source/target aliasing.

### TASK-057 — Motor faults

- **Status:** TODO.
- **Title & Description:** Inject failures by stable motor ID without modifying the GPS truth path.
- **Dependencies:** TASK-010, TASK-025, TASK-027.
- **Touched Files:** `packages/physics/src/motor-fault.ts`, `tests/motor-fault.test.ts`, `native/bet/tests/motor_failure.rs`.
- **Interfaces / Contracts:** power-cut versus synthetic instant-thrust-loss; remainingThrustFraction.
- **DoD & Acceptance Criteria:** Power-cut preserves passive drag/spool decay; instant fault removes the selected force in that tick and sets synthetic validity; leave other motors unchanged; verify moment arms.

### TASK-058 — EW pipeline composition

- **Status:** TODO.
- **Title & Description:** Compose effects, fault registry, and deterministic command application.
- **Dependencies:** TASK-053, TASK-054, TASK-055, TASK-056, TASK-057.
- **Touched Files:** `packages/ew/src/engine.ts`, `packages/sensors/src/pipeline.ts`, `tests/ew-pipeline.test.ts`.
- **Interfaces / Contracts:** EwEngine; GpsSample/ImuSample; ew_flags; effect precedence.
- **DoD & Acceptance Criteria:** Order is baseline to step/drift to jamming to quantization; magnetometer is independent; faults/reset compose consistently; truth stays bit-identical; identical seed/event log yields identical packets.

### TASK-059 — EKF scenario regressions

- **Status:** TODO.
- **Title & Description:** Measure ArduPilot responses to EW/mechanical faults without promising a hard-coded mode.
- **Dependencies:** TASK-042, TASK-043, TASK-058.
- **Touched Files:** `tests/integration/ew-sitl.test.ts`, `tests/fixtures/scenarios/ew-matrix.json`, `scripts/report-ekf.mjs`.
- **Interfaces / Contracts:** Innovation/status/mode/trajectory AAR trace; pinned EKF parameters.
- **DoD & Acceptance Criteria:** Run a no-fault control and every fault; traces show changed observations and actual EKF responses; freeze version-specific envelopes; unexplained responses require investigation rather than silent PASS.

## Phase 5: Environment & Shaders

### TASK-060 — Provider and license policy

- **Status:** TODO.
- **Title & Description:** Separate Google live tiles from cacheable owned/licensed datasets before implementing caches.
- **Dependencies:** TASK-003, TASK-005.
- **Touched Files:** `packages/terrain/package.json`, `packages/terrain/src/provider-policy.ts`, `docs/decisions/terrain-licensing.md`, `tests/terrain-policy.test.ts`.
- **Interfaces / Contracts:** ProviderPolicy {attribution, allowedCache, ttl, offline, datasetLicense}.
- **DoD & Acceptance Criteria:** Google persistent R2/prefetch is denied by default; authorization requires evidence; unknown policy fails closed; fixtures need no API key; paid API access does not establish an offline license.

### TASK-061 — Tiles streaming adapter

- **Status:** TODO.
- **Title & Description:** Connect one chosen 3D Tiles loader to R3F using a local licensed fixture.
- **Dependencies:** TASK-015, TASK-036, TASK-060.
- **Touched Files:** `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `apps/web/src/FlightScene.tsx`, `tests/tiles-provider.test.ts`, `tests/browser/terrain.spec.ts`.
- **Interfaces / Contracts:** 3D Tiles transforms; ECEF/local origin; attribution; abort/dispose.
- **DoD & Acceptance Criteria:** Load/place the fixture; canceled requests release resources; show CORS/COEP failures; missing Google credentials block live integration while local checks continue.

### TASK-062 — LOD and GPU budgets

- **Status:** TODO.
- **Title & Description:** Bound terrain network, decoding, and GPU workloads.
- **Dependencies:** TASK-061.
- **Touched Files:** `packages/terrain/src/lod-budget.ts`, `packages/terrain/src/resource-cache.ts`, `tests/terrain-budget.test.ts`.
- **Interfaces / Contracts:** Bounded request queue; CPU/GPU byte accounting; SSE limits.
- **DoD & Acceptance Criteria:** Synthetic flythrough respects <=2 GiB estimated terrain GPU residency and <=512 MiB decoded CPU cache; eviction disposes resources; idle queues do not grow; degradation is deterministic.

### TASK-063 — Cloudflare tiles proxy

- **Status:** TODO.
- **Title & Description:** Build an authenticated proxy with quotas, attribution/CORS, and permitted TTLs.
- **Dependencies:** TASK-060, TASK-061.
- **Touched Files:** `services/tiles-worker/package.json`, `services/tiles-worker/wrangler.jsonc`, `services/tiles-worker/src/index.ts`, `services/tiles-worker/src/policy.ts`, `tests/tiles-proxy.test.ts`.
- **Interfaces / Contracts:** ProviderPolicy; opaque upstream secret binding; origin/session verification.
- **DoD & Acceptance Criteria:** Local Worker tests verify no key reaches clients/logs, invalid origin/session/quota rejection, and provider restrictions; deployment needs separate authorization and is not implied by local success.

### TASK-064 — R2 for permitted datasets

- **Status:** TODO.
- **Title & Description:** Cache 10–15 km regions only for content whose license permits it.
- **Dependencies:** TASK-062, TASK-063.
- **Touched Files:** `services/tiles-worker/src/r2-cache.ts`, `packages/terrain/src/region-manifest.ts`, `tests/r2-cache.test.ts`.
- **Interfaces / Contracts:** Dataset hash/license; cache key/version/TTL; region manifest; deny Google unless explicitly authorized by a lawful policy.
- **DoD & Acceptance Criteria:** Local R2 emulator tests hit/miss/expiry/eviction; enforce byte/quota caps and 10/15 km radius; cacheable=false never writes; missing rights/data explicitly block the provider.

### TASK-065 — Collision terrain LOD

- **Status:** TODO.
- **Title & Description:** Build collision chunks independently of visuals and swap them at tick boundaries.
- **Dependencies:** TASK-029, TASK-061, TASK-062.
- **Touched Files:** `packages/terrain/src/collision-builder.worker.ts`, `packages/terrain/src/collision-chunks.ts`, `tests/terrain-collision.test.ts`.
- **Interfaces / Contracts:** Immutable versioned collision chunks; local origin; readiness around the vehicle.
- **DoD & Acceptance Criteria:** Visual eviction retains active ground; seam/drop tests pass; incomplete ground explicitly limits/pauses flight; heavy decoding never runs in the physics Worker.

### TASK-066 — WebGPU renderer capability

- **Status:** TODO.
- **Title & Description:** Add a renderer adapter with WebGL2 fallback and resource lifecycle.
- **Dependencies:** TASK-005, TASK-061.
- **Touched Files:** `apps/web/src/render/renderer.ts`, `apps/web/src/render/webgpu.ts`, `tests/browser/render-backends.spec.ts`.
- **Interfaces / Contracts:** Common scene/material capabilities; browser chooses Metal/DX backend.
- **DoD & Acceptance Criteria:** Available modes run; unsupported modes are skipped with a reason, not passed; shader failures fall back; switching releases all resources.

### TASK-067 — FPV camera and fisheye

- **Status:** TODO.
- **Title & Description:** Separate mounted FPV pose/projection and lens distortion from the external camera.
- **Dependencies:** TASK-015, TASK-066.
- **Touched Files:** `packages/cameras/package.json`, `packages/cameras/src/fpv-camera.ts`, `packages/cameras/src/shaders/fisheye.glsl`, `tests/fisheye.test.ts`, `tests/browser/fpv.spec.ts`.
- **Interfaces / Contracts:** CameraConfig {fov, mount FRD, distortion}; immutable truth.
- **DoD & Acceptance Criteria:** Zero distortion is identity; optical-center/radial fixtures and analytic projection/resize tests pass; edge coordinates stay finite; no truth mutation.

### TASK-068 — Analog interference and jelly

- **Status:** TODO.
- **Title & Description:** Add seeded video noise, scanlines, and rolling-shutter deformation.
- **Dependencies:** TASK-067.
- **Touched Files:** `packages/cameras/src/analog.ts`, `packages/cameras/src/shaders/analog.glsl`, `tests/analog-noise.test.ts`, `tests/browser/analog.spec.ts`.
- **Interfaces / Contracts:** VideoNoiseConfig; throttle-decimated uniforms; independent visual RNG.
- **DoD & Acceptance Criteria:** Equal seed/time gives the same frame; throttle affects rendering only; no CPU pixel loops/per-frame allocation; image tolerances are backend-specific, not cross-GPU pixel equality.

### TASK-069 — WorldCover/OSM material map

- **Status:** TODO.
- **Title & Description:** Load licensed land classes and map features with provenance.
- **Dependencies:** TASK-036, TASK-060, TASK-061.
- **Touched Files:** `packages/thermal/package.json`, `packages/thermal/src/material-map.ts`, `packages/thermal/src/data-manifest.ts`, `tests/material-map.test.ts`, `tests/fixtures/thermal/material-classes.json`.
- **Interfaces / Contracts:** 10 m raster labels; road/roof overlays; attribution/hash/coordinate system.
- **DoD & Acceptance Criteria:** Known coordinates map correctly; missing data is labeled synthetic; land classes are not temperatures; preserve attribution/licenses without unauthorized bulk downloads.

### TASK-070 — Surface thermal state

- **Status:** TODO.
- **Title & Description:** Integrate material temperatures from solar forcing/weather outside the shader.
- **Dependencies:** TASK-032, TASK-069.
- **Touched Files:** `packages/thermal/src/heat-balance.ts`, `packages/thermal/src/solar.ts`, `tests/thermal-energy.test.ts`.
- **Interfaces / Contracts:** C*dT/dt=absorbedSolar-convection-radiation-conduction; emissivity/inertia.
- **DoD & Acceptance Criteria:** Test night equilibrium/sunrise/shadows/energy units and timestep convergence; AO affects only an explicit radiative model, not a substitute heat solver; measured validation remains pending without data.

### TASK-071 — Thermal renderer

- **Status:** TODO.
- **Title & Description:** Map thermal states to radiance/palettes with atmospheric attenuation.
- **Dependencies:** TASK-066, TASK-070.
- **Touched Files:** `packages/thermal/src/thermal-camera.ts`, `packages/thermal/src/shaders/thermal.glsl`, `tests/thermal-camera.test.ts`, `tests/browser/thermal.spec.ts`.
- **Interfaces / Contracts:** InstrumentProfile {resolution, spectralResponse, noise, calibrationSource}; synthetic training profiles are separate from CADEX measurements.
- **DoD & Acceptance Criteria:** Test blackbody monotonicity, emissivity/reflection/distance attenuation, and cold/hot palette endpoints; configurable native resolution; do not claim CADEX parity without profile data.

### TASK-072 — Thermal shutter and NUC

- **Status:** TODO.
- **Title & Description:** Implement deterministic calibration cycles and bounded display interruption.
- **Dependencies:** TASK-071.
- **Touched Files:** `packages/thermal/src/nuc.ts`, `packages/thermal/src/thermal-status.ts`, `tests/thermal-nuc.test.ts`.
- **Interfaces / Contracts:** Shutter states idle/closed/calibrating/open; sensor frame time.
- **DoD & Acceptance Criteria:** Fix cycle duration/rate; NUC removes configured bias without timestamp reversal; shutter never pauses physics or mutates AAR truth.

### TASK-073 — GPU acceptance harness

- **Status:** TODO.
- **Title & Description:** Profile production rendering on M4/RTX 4050 with terrain/FPV/thermal enabled.
- **Dependencies:** TASK-014, TASK-062, TASK-065, TASK-066, TASK-068, TASK-072.
- **Touched Files:** `scripts/bench-render.mjs`, `docs/benchmarks/render-matrix.json`, `docs/validation/gpu-report.schema.json`, `tests/gpu-report.test.ts`.
- **Interfaces / Contracts:** G3 device/browser/resolution/quality/VRAM evidence.
- **DoD & Acceptance Criteria:** Measure each profile for 10 min after 60 s warmup; 60 FPS p99<=16.67 ms and 120 FPS p99<=8.33 ms; meet terrain budgets; software-headless GPU cannot satisfy hardware gates; missing devices are BLOCKED_EXTERNAL.

## Phase 6: UI & Telemetry

### TASK-074 — Pilot HUD and freshness

- **Status:** TODO.
- **Title & Description:** Display attitude/speed/altitude/mode/EKF with source and age.
- **Dependencies:** TASK-015, TASK-039, TASK-043.
- **Touched Files:** `apps/web/src/hud/PilotHud.tsx`, `apps/web/src/hud/attitude.ts`, `apps/web/src/hud/telemetry.ts`, `tests/hud.test.ts`, `tests/browser/hud.spec.ts`.
- **Interfaces / Contracts:** FlightStateV2; normalized ekf_flags; unknown/stale visual states.
- **DoD & Acceptance Criteria:** Verify NED horizon signs; demo cannot fabricate valid EKF; stale AP status is marked; decimate React updates instead of setState at 1200 Hz.

### TASK-075 — Instructor console and hotkeys

- **Status:** TODO.
- **Title & Description:** Send weather/fault/model commands with explicit pending/applied status.
- **Dependencies:** TASK-010, TASK-038, TASK-058, TASK-074.
- **Touched Files:** `apps/web/src/instructor/Console.tsx`, `apps/web/src/instructor/hotkeys.ts`, `tests/instructor.test.ts`, `tests/browser/instructor.spec.ts`.
- **Interfaces / Contracts:** ControlCommandV2 request/ACK/epoch; scenario fault registry.
- **DoD & Acceptance Criteria:** Hotkeys ignore text-input focus; cancellation/reset/stale epoch/rejection are visible; show applied only after ACK; all fault IDs are usable without source changes.

### TASK-076 — AAR recorder

- **Status:** TODO.
- **Title & Description:** Record input/actuator/truth/sensor/events in a separate bounded recorder.
- **Dependencies:** TASK-004, TASK-013, TASK-058.
- **Touched Files:** `packages/aar/package.json`, `packages/aar/src/format.ts`, `packages/aar/src/recorder.worker.ts`, `packages/aar/src/storage.ts`, `tests/aar-recorder.test.ts`.
- **Interfaces / Contracts:** AAR version/model hashes/seed/epoch/time domains; IndexedDB chunks/checksums.
- **DoD & Acceptance Criteria:** A configured 30 min ring has a fixed byte cap; explicitly count storage backpressure/loss; physics handoff meets zero-allocation; the 256-slot render ring is never an archive.

### TASK-077 — Replay and timeline

- **Status:** TODO.
- **Title & Description:** Separate recorded snapshot replay from deterministic resimulation.
- **Dependencies:** TASK-015, TASK-076.
- **Touched Files:** `packages/aar/src/replay.ts`, `packages/aar/src/resimulation.ts`, `tests/aar-replay.test.ts`.
- **Interfaces / Contracts:** ReplayMode snapshots/resimulate; seek boundaries; configuration provenance.
- **DoD & Acceptance Criteria:** Correct seeking/reset/epoch discontinuity; reject unknown format/hash mismatch; replay preserves records; resimulation mismatch generates a report instead of rewriting recordings.

### TASK-078 — AAR response charts

- **Status:** TODO.
- **Title & Description:** Align pilot input, actuator commands, and model responses on one time axis.
- **Dependencies:** TASK-074, TASK-077.
- **Touched Files:** `apps/web/src/aar/Review.tsx`, `apps/web/src/aar/series.ts`, `tests/aar-series.test.ts`, `tests/browser/aar.spec.ts`.
- **Interfaces / Contracts:** Bounded decimated time series; units/timebase; explicit recording gaps.
- **DoD & Acceptance Criteria:** A known step-response fixture shows correct lag; do not interpolate gaps as real data; display 30 min with <=10000 points per series and bounded memory.

### TASK-079 — Lessons and scenario runner

- **Status:** TODO.
- **Title & Description:** Define reproducible training scenarios declaratively.
- **Dependencies:** TASK-043, TASK-059, TASK-075, TASK-077.
- **Touched Files:** `packages/scenarios/package.json`, `packages/scenarios/src/schema.ts`, `packages/scenarios/src/runner.ts`, `tests/scenario-runner.test.ts`, `tests/fixtures/scenarios/pilot-basics.json`.
- **Interfaces / Contracts:** Goals/seed/model/firmware/events/rubric/version; no physics in UI.
- **DoD & Acceptance Criteria:** Reject malformed/unsupported scenarios; identical configuration emits identical tick events; evaluate outcomes from traces/thresholds, not just timers; paused clocks incur no simulation-time penalty.

### TASK-080 — Accessibility and permissions UX

- **Status:** TODO.
- **Title & Description:** Support keyboard/focus/resize and clear browser-permission failures.
- **Dependencies:** TASK-005, TASK-048, TASK-075, TASK-078.
- **Touched Files:** `apps/web/src/ui/StatusMessage.tsx`, `apps/web/src/style.css`, `tests/browser/accessibility.spec.ts`.
- **Interfaces / Contracts:** Keyboard controls versus instructor shortcuts; aria states; permission status.
- **DoD & Acceptance Criteria:** Core actions are keyboard accessible; restore focus after dialogs; no 390px overflow; permission denial never loops prompts; run an automated accessibility scan and a manual checklist.

### TASK-081 — Session export

- **Status:** TODO.
- **Title & Description:** Export/import AAR with manifests and no secrets.
- **Dependencies:** TASK-076, TASK-077.
- **Touched Files:** `packages/aar/src/archive.ts`, `apps/web/src/aar/Export.tsx`, `tests/aar-archive.test.ts`.
- **Interfaces / Contracts:** Versioned archive; size/checksum limits; configurable key/serial-identifier redaction.
- **DoD & Acceptance Criteria:** Roundtrip export/import; reject archive bombs/oversized payloads/invalid hashes before allocation; no API keys/tokens in archives; show size and data categories.

### TASK-082 — System acceptance matrix

- **Status:** TODO.
- **Title & Description:** Exercise supported modes against all UI/physics/telemetry gates.
- **Dependencies:** TASK-033, TASK-042, TASK-043, TASK-047, TASK-051, TASK-059, TASK-073, TASK-074, TASK-075, TASK-078, TASK-079, TASK-080, TASK-081.
- **Touched Files:** `tests/integration/system-acceptance.test.ts`, `docs/validation/system-matrix.json`, `scripts/validate-release.mjs`.
- **Interfaces / Contracts:** G0..G4; device/mode/model/firmware/provider coverage.
- **DoD & Acceptance Criteria:** Every requirement has PASS/FAIL/BLOCKED/NOT_RUN evidence; unit tests do not establish 60/120 FPS or real 400/800/1200 Hz; missing WASM/HITL/Google coverage explicitly blocks the affected mode.

### TASK-083 — Release provenance and runbook

- **Status:** TODO.
- **Title & Description:** Produce a verifiable release bundle and operational recovery instructions.
- **Dependencies:** TASK-003, TASK-082.
- **Touched Files:** `docs/operations/runbook.md`, `docs/operations/release-manifest.schema.json`, `scripts/release-manifest.mjs`, `tests/release-manifest.test.ts`.
- **Interfaces / Contracts:** Source/artifact/dataset/toolchain hashes; licenses; supported capability matrix.
- **DoD & Acceptance Criteria:** Verify clean-machine installation/build/startup; document rollback and owned-process cleanup; report actual blocked gates; never deploy/push automatically outside authorized scope.
