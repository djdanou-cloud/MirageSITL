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


## Local batch verification: TASK-025–031 and TASK-033–035

2026-10-16; owner Codex; baseline 8f7dc19 plus preserved local TASK-024.
Six tasks are DONE (025–028, 034–035); 029 is BLOCKED_DECISION and 030/031/033
are BLOCKED_EXTERNAL. Passing unit tests assert those blocked gates remain closed.
Final local exits are zero for frozen npm ci, lint, typecheck, check:docs, build,
230 unit tests (35 files), 17 Chromium browser tests, 45 native tests, native and
wasm32 cargo check, and the release million-step allocator test. Unit/browser
JUnit reports: test-results/unit/junit.xml and test-results/browser/junit.xml;
zero failures/errors/skips. The production build retains its existing large-chunk
warning. Lockfile SHA-256 f2199316bc61fd3cdc3cf1017e5884942aa51443ca6d126820e48925db1495d7.

Node 24.19.0, Rust 1.97.0, Chromium 154.0.8037.57, Debian x86_64/software GPU;
CARGO_HOME=/workspace/.cache/mirage-cargo, RUSTUP_HOME=/workspace/.cache/mirage-rustup
and Cargo bin activated on PATH. No M4/RTX performance or hosted Actions claim.
Sensor ideal/all/body allocation reports show zero GC and zero incremental B/step;
positive controls detected allocations. The contact allocation test resolves the
same pinned 0.21.0 provider as the adapter, avoiding an unrelated transitive version.
Model report: 12 numerical cases PASS, max position error 1.624e-10 m,
max attitude error 0 rad; overall/fidelity BLOCKED and CLI exit 2. Reference hash
9f89eab73cd16e7f7296744b40a9389d5bff17f04f947f3473f0067b96bce142.
Native JSBSim bridge rebuild/smoke exits 0; WASM build prerequisite guard exits 2
because the pinned SDK is unavailable. EN/RU prose, equations, paths and hashes
were synchronized and checked. Changes remain local; no commit or push performed.

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

- **Status:** DONE — implementation complete; hosted runs verified on 2026-10-16.
- **Title & Description:** Run pull-request checks without hardware or paid APIs.
- **Dependencies:** TASK-002.
- **Touched Files:** `.github/workflows/ci.yml`, `playwright.config.ts`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `package.json`, `package-lock.json`, `vitest.config.ts`, `.gitignore`, `tests/ci.test.ts`.
- **Interfaces / Contracts:** Node 24, frozen npm lock; separate unit/browser/build jobs.
- **DoD & Acceptance Criteria:** CI runs nonzero test counts and retains results/failure traces; no-tests and failed jobs fail the pipeline; synthetic checks require no secrets.
- **Evidence:** Owner Codex; baseline c8814c6; 2026-10-15. Three independent CI jobs implemented; tests/ci.test.ts: 3 PASS, including both runners rejecting zero tests. Local CI commands pass: 25 unit, 4 browser, production build. Reports: test-results/unit/junit.xml and test-results/browser/junit.xml, no skips/failures; build.log and apps/web/dist generated. Hosted Actions API read blocked by proxy CONNECT 403; inspect the first hosted run after push. No credentials or hardware required for synthetic jobs. Hosted follow-up (Claude, 2026-10-15): GitHub Actions now records runs, but every job fails without executing. Runs 38804503643 (c26df78, push), 38806524546 (f13213b, push), and 38808881935 (1064a57, pull request djdanou-cloud/MirageSITL#1): all three jobs (unit, build, browser) completed as failure 2-3 s after starting, with no steps and no downloadable log (HTTP 404). This pattern means the hosted runners were never started (for example an Actions billing/spending-limit lock or disabled Actions), not a workflow or test failure. Unblock: the repository owner checks GitHub account billing and the repository's Actions settings, then re-runs the workflow; no code change is needed. Hosted verification (Claude, 2026-10-16): GitHub Actions run 38935251383 (pull request djdanou-cloud/MirageSITL#2, head e28eb7c) executed all three jobs to success: unit 62 files / 394 tests passed with test-results/unit/junit.xml uploaded as artifact 12060104387; browser passed with its report uploaded as artifact 12060348065; build passed. Native checks run 38935251375 also passed. Earlier billing-lock failures no longer occur.


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

- **Status:** DONE — Claude; baseline 1e96582; 2026-10-16.
- **Title & Description:** Parameterize scheduler/dt and rational sensor timestamps.
- **Dependencies:** TASK-010.
- **Touched Files:** `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `tests/clock.test.ts`, `tests/browser/simulation.spec.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** PhysicsHz; TickId; simTime=tick/hz; fixed dt.
- **DoD & Acceptance Criteria:** A fake clock produces 4000/8000/12000 steps in 10 s without accumulated dt drift; pause/resume creates no backlog; 1200 Hz time_usec intervals are 833/834 microseconds.
- **Evidence:** Owner Claude; baseline 1e96582; 2026-10-16. tests/clock.test.ts: 12 PASS. Seeded jittered wakeups (0.05-1.5 ms) give exactly 4000/8000/12000 steps in 10 s with zero drops and the next deadline exactly 10 s + 1/hz; bounded catch-up counts 1192 dropped steps at 1200 Hz; resume after a 4 s pause has no backlog; time_usec intervals at 1200 Hz are exactly {833, 834} us summing to 1e6; exact across the 32-bit tick carry and NaN beyond 2^53 us; 200/400 Hz IMU and 5/10 Hz GNSS schedules are phase-locked at every rate; DemoDynamics converges as dt shrinks. Mutation: accumulating the rounded step length instead of integer deadlines fails the 1200 Hz drift test. The browser fixed-dt assertion now uses the specification's sim_time = tick/hz. physics.worker.ts unchanged: the v1 Worker keeps 400 Hz via FixedStepClock until TASK-085. npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 151 PASS; simulation browser spec 4 PASS. Node 22.22.0.

### TASK-012 — Clock modes and overload

- **Status:** DONE — Claude; baseline be502a4; 2026-10-16.
- **Title & Description:** Separate interactive time dropping, SITL lockstep waiting, and HITL fault policies.
- **Dependencies:** TASK-011.
- **Touched Files:** `packages/physics/src/clock-policy.ts`, `packages/physics/src/clock.ts`, `packages/physics/src/index.ts`, `tests/clock-policy.test.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** interactive / sitl-lockstep / hitl-realtime; maxCatchUp=8.
- **DoD & Acceptance Criteria:** A 1 s stall counts interactive drops, preserves every SITL simulation tick, and invalidates HITL; pause/dispose remain responsive when actuators are absent.
- **Evidence:** Owner Claude; baseline be502a4; 2026-10-16. tests/clock-policy.test.ts: 5 PASS. A 1 s Worker stall at 400 Hz counts 392 interactive drops with contiguous ticks; a 1 s autopilot stall in sitl-lockstep delays but preserves every tick (contiguous, zero drops) and a blocked Worker catches up 8 ticks per pump without dropping; hitl-realtime tolerates 4 ms timer clamping at 1200 Hz but a 1 s stall sets hitl-overrun, executes nothing afterwards, and clears only on resetEpoch; with no actuator frames 100000 lockstep pumps return immediately (one gate check each, no step); every mode runs at most maxCatchUp=8 ticks per pump. Mutations: removing the HITL fault and wall-pacing SITL each fail. physics.worker.ts is wired in TASK-085. npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 156 PASS. Node 22.22.0.

### TASK-013 — Sensor/actuator SPSC queues

- **Status:** DONE — Claude; baseline aef7af6; 2026-10-16.
- **Title & Description:** Implement separate bounded queues with strict ownership and backpressure.
- **Dependencies:** TASK-008, TASK-009, TASK-012.
- **Touched Files:** `packages/protocol/src/spsc-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/spsc-v2.test.ts`, `tests/browser/spsc-v2.spec.ts`, `packages/protocol/src/index.ts`, `tests/support/spsc-stress.ts`, `tests/support/spsc-stress.node-worker.ts`, `tests/support/spsc-stress.browser-worker.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SHARED_MEMORY section 5; capacity=1024, stride=128.
- **DoD & Acceptance Criteria:** Test full/empty/wrap/reset; never overwrite unread slots; 1e6 frames retain order; SITL/HITL policies handle overflow without silent drops.
- **Evidence:** Owner Claude; baseline aef7af6; 2026-10-16. tests/spsc-v2.test.ts: 9 PASS: slot offsets/types parsed from the section 5 table and header offsets/magics from its prose; size/kind/ABI/reserved validation; empty pop; 1024 pushes then would-block twice with full_events=2 and every unread frame intact in order; HITL overflow latches faulted (even after space frees) until resetSpscQueue clears counters and advances the epoch; order across the uint32 counter wrap; frame codecs at spec offsets with round trip and 13 sensor plus 5 actuator contract violations rejected. Concurrency: 1e6 frames from a Node worker_threads producer with SITL retry: 1000000 received, 0 out of order, 0 corrupt, 0 invalid, full_events equal to would-block retries; tests/browser/spsc-v2.spec.ts in a Chromium module Worker: 1000000 received, 0 out of order/corrupt/invalid. Mutations: disabling the full check fails three tests; releasing a slot before copying it fails the real-thread stress test. npm run lint, npm run typecheck, npm run check:docs exit 0; CI=true npm test: 165 PASS. Node 22.22.0. No producer or consumer is attached in the application yet (TASK-085 creates the buffers; I/O workers arrive with TASK-034+).

### TASK-014 — Hot-path instrumentation

- **Status:** DONE — Claude; baseline 920bd23; 2026-10-16.
- **Title & Description:** Measure allocation counts, step duration, and deadline lateness in a machine-readable report.
- **Dependencies:** TASK-009, TASK-011, TASK-013.
- **Touched Files:** `packages/physics/src/step-metrics.ts`, `scripts/bench-physics.mjs`, `tests/step-metrics.test.ts`, `docs/benchmarks/schema.json`, `packages/physics/src/index.ts`, `packages/physics/src/clock.ts`, `packages/physics/src/clock-policy.ts`, `packages/physics/src/demo-dynamics.ts`, `packages/physics/src/session-v2.ts`, `packages/protocol/src/state-v2.ts`, `packages/protocol/src/pilot-v2.ts`, `packages/protocol/src/sensor-frame.ts`, `packages/protocol/src/actuator-frame.ts`, `tests/layout-v2.test.ts`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** G1/G3; compute duration, wakeup lateness, and executed Hz are separate metrics.
- **DoD & Acceptance Criteria:** After warmup, 1e6 steps have zero explicit JS/WASM allocations and constant arena size; baseline report records p50/p95/p99/max and environment; measure profiler overhead separately.
- **Evidence:** Owner Claude; baseline 920bd23; 2026-10-16. node scripts/bench-physics.mjs (Node 22.22.0, V8 12.4, --expose-gc --max-semi-space-size=64) on the real PhysicsSessionV2 step at 400 Hz: zeroAllocation=true in 8 of 8 consecutive runs, per-step upper bound 0.00000 B over GC-free windows of 1e6 and 2e6 steps, 0 GC events, allocating control detected each run; compute p50 about 1.0 us, p99 about 1.9 us (timer overhead about 0.1 us/step reported separately); real-time Node run about 400 Hz executed, wakeup lateness p99 about 0.6 ms. Before the fix the same instrument found 93 GC events per 1e6 steps: variadic Math.hypot (124 GC per 1e6 calls in isolation) and doubles boxed across non-inlined calls (the V8 sampling heap profiler with collected objects located one 16-byte HeapNumber per step in isValidFlightStateV2), which made results bimodal across processes. Fixes: time passed through numeric fields, integer wakeup delays, inline validator comparisons (exact equivalence tests for the f32 bound and uint32 test). Mutation: one small object per tick flips the verdict (22 GC). tests/step-metrics.test.ts: 3 PASS (histogram quantiles/overflow/max, separate metrics, 1e6-step bench run validated against docs/benchmarks/schema.json with zeroAllocation=true); tests/layout-v2.test.ts +2. JS has no arena (WASM arena constancy belongs to TASK-017/018). npm run lint, npm run typecheck, npm run check:docs exit 0. No browser-Worker or target-hardware timing claim. Hosted CI follow-up (Node 24.22.0): the whole-window bound read 0.014-0.022 B/step with 0 GC because Node 24 adds a fixed ~34-44 KB per measured window independent of N (identical bytes at 1e6/2e6 and 4e6/8e6 steps), so the verdict now uses the incremental rate between the N and 2N windows; Node 24 4/4 runs 0.00000-0.00354 B/step and Node 22 2/2 runs 0.00006 B/step, threshold unchanged at 0.01; mutation of one small object per 800 steps reads 0.040-0.047 B/step with 0 GC and fails the verdict. Second hosted run still failed: on 2-CPU runners concurrent TurboFan job installation allocates 0-120 KB per window at contention-dependent times (reproduced locally with taskset -c 0,1 plus parallel tests: 1/6 then 3/6 false failures). The bench now runs V8 with --single-threaded and takes the minimum over 3 GC-free repeats per window size: 6/6 contended Node 24 runs read 0.00000 B/step with the fixed cost equal to the 3000 B probe overhead, Node 22 0.00000; the one-object-per-800-steps mutation reads exactly 0.04000 B/step (32 B / 800) and fails.

### TASK-015 — Interpolation and epoch changes

- **Status:** DONE — Claude; baseline db50e9a; 2026-10-16.
- **Title & Description:** Render smoothly without interpolating across reset or model replacement.
- **Dependencies:** TASK-009, TASK-011.
- **Touched Files:** `apps/web/src/FlightScene.tsx`, `apps/web/src/coordinates.ts`, `packages/protocol/src/interpolation.ts`, `tests/interpolation.test.ts`, `packages/protocol/src/index.ts`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Adjacent ticks in the same epoch/model; shortest-path quaternion SLERP.
- **DoD & Acceptance Criteria:** q and -q do not cause a full rotation; NED basis tests pass; reset/teleport breaks history; rendering never waits for the writer or mutates truth.
- **Evidence:** Owner Claude; baseline db50e9a; 2026-10-16. tests/interpolation.test.ts: 6 PASS against an independent axis-angle oracle: linear position and great-circle attitude at t=0/0.25/0.5/0.75 within 1e-12 rad; q versus -q gives no rotation and a sign-flipped small rotation interpolates by the small angle; no interpolation for 'latest'/'none' history or a teleport beyond 100 m per tick; inputs are not mutated, float32 attitudes are renormalized, a degenerate quaternion renders as identity; the fraction derives from scheduled wall time and rate, clamped to [0,1], 1 when paused or invalid; NED-to-render position mapping. The existing NED basis test still passes. Mutations: removing the shortest-path negation and ignoring the history state each fail. FlightScene uses the module (RefObject replaces the deprecated MutableRefObject). npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 189 PASS; CI=true npm run test:browser: 15 PASS. Node 22.22.0. Rendering is software-GPU only here; no frame-rate claim.

### TASK-085 — Migrate Worker and Main to ABI v2

- **Status:** DONE — Claude; baseline bad3099; 2026-10-16.
- **Title & Description:** Switch the running application from ABI v1 and the v1 postMessage protocol to the v2 state ring, pilot mailbox, WorkerInitV2, and Control Protocol v2. Split out of TASK-009/010 because WorkerInitV2 requires the TASK-013 sensor/actuator buffers.
- **Dependencies:** TASK-009, TASK-010, TASK-013.
- **Touched Files:** `apps/web/src/runtime.ts`, `apps/web/src/physics.worker.ts`, `apps/web/src/App.tsx`, `tests/browser/simulation.spec.ts`, `tests/browser/runtime-v2.spec.ts`, `apps/web/src/FlightScene.tsx`, `packages/physics/src/session-v2.ts`, `packages/physics/src/demo-dynamics.ts`, `packages/physics/src/index.ts`, `packages/protocol/src/control-v2.ts`, `packages/input/src/index.ts`, `tests/session-v2.test.ts`, `tests/control-v2.test.ts`, `tests/input.test.ts`, `README.md`, `docs/ru/README.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/SPECS_SHARED_MEMORY.md`, `docs/ru/SPECS_SHARED_MEMORY.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** WorkerInitV2; StateWriterV2/StateReaderV2; PilotWriterV2/PilotReaderV2; ControlProcessorV2; SPECS_SHARED_MEMORY sections 3–6.
- **DoD & Acceptance Criteria:** Lifecycle, stale-input, USB-failsafe, and fixed-dt browser tests pass on v2; a stale epoch or changed device_generation disarms; rendering never interpolates across epochs; v1 compatibility is removed only by a recorded decision.
- **Evidence:** Owner Claude; baseline bad3099; 2026-10-16. The app runs on ABI v2: Main sends init-v2 with the v2 state SAB and both SPSC queues; the Worker is a thin adapter around PhysicsSessionV2. tests/session-v2.test.ts: 10 PASS (ready-v2, tick/hz stepping, pause hold, resting specific force [0,0,-9.80665], ISA pressure, demo rejects weather/fault with BAD_STATE and model.load with ASSET_MISSING, arming only at <=5% throttle, device_generation change disarms and blocks rearm until withdrawn, stale epoch and 300 ms-old input disarm, reset/configure epochs break history, 1200 Hz stepping, sitl-lockstep waits responsively and steps on per-tick actuator frames with ActuatorValid, hitl-realtime overrun sets the header Fault flag until reset, dispose). Mutations: ignoring device_generation, arming at any throttle, and ignoring the epoch each fail. tests/control-v2.test.ts: +2 (unsupportedReason, parseWorkerEventV2/isWorkerInitV2 guards); tests/input.test.ts: +1 (a different transmitter at a reused index starts a new generation). DemoDynamics now reports kinematic acceleration on ground contact. Browser: all 4 simulation specs pass on v2 (the Worker protocol test converted to init-v2/commands with arming at 0% throttle), all 7 capability specs pass, and tests/browser/runtime-v2.spec.ts: 2 PASS (stale epoch and device change disarm in a real Worker, 800 Hz executed within 10% over 2 s, reset breaks latestPair history; a swapped transmitter at the armed index disarms the UI). npm run lint, npm run typecheck, npm run check:docs, npm run build exit 0; CI=true npm test: 178 PASS; CI=true npm run test:browser: 15 PASS (Playwright Chromium build 1194). Node 22.22.0. ABI v1 code and tests remain; the application no longer uses them.

## Phase 2: Aerodynamics & WASM

### TASK-016 — Native Rust workspace

- **Status:** DONE — Claude; baseline 4187246; 2026-10-16 (hosted native.yml run blocked like TASK-003).
- **Title & Description:** Create a pinned scalar BET crate and native tests.
- **Dependencies:** TASK-003, TASK-004.
- **Touched Files:** `native/Cargo.toml`, `native/Cargo.lock`, `native/rust-toolchain.toml`, `native/bet/Cargo.toml`, `native/bet/src/lib.rs`, `.github/workflows/native.yml`, `native/bet/tests/bootstrap.rs`, `tests/browser/native-bootstrap.spec.ts`, `.github/workflows/ci.yml`, `tests/ci.test.ts`, `.gitignore`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** wasm32-unknown-unknown; repr(C) boundary; scalar by default.
- **DoD & Acceptance Criteria:** cargo check/test --locked pass; pin toolchain/target; verify a reproducible bootstrap kernel artifact in Chromium without claiming production aerodynamics.
- **Evidence:** Owner Claude; baseline 4187246; 2026-10-16. Toolchain rustc/cargo 1.97.0 (pinned in native/rust-toolchain.toml with wasm32-unknown-unknown, minimal profile; rustup installed the pinned toolchain on first use). Inside native/: cargo check --workspace --locked exit 0; cargo test --workspace --locked: 6 PASS (zero/NaN/sub-threshold flow gives zero force; magnitude = q c dr sqrt(CL^2+CD^2) within 1e-14; lift perpendicular to flow and radial direction, drag parallel and dissipative; mirrored spin flips lift and keeps drag; linear in chord and width; exports equal the kernel); cargo check -p mirage-bet --target wasm32-unknown-unknown --locked exit 0. A no_std build was not possible because stable 1.97 has no f64::sqrt in core and core::arch::wasm32::f64_sqrt is unstable (wasm_numeric_instr); the wasm32 build instead uses a trapping global allocator. Release artifact: 376 bytes, zero imports, exports memory/bet_abi_version/bet_bootstrap_element_force. tests/browser/native-bootstrap.spec.ts: 1 PASS (two clean builds give identical SHA-256; Chromium instantiates it; four cases match an independent JS evaluation within 1e-12). tests/ci.test.ts +1 (one toolchain pin across rust-toolchain.toml, ci.yml, native.yml; native.yml runs check/test/wasm/reproducibility in native/). The kernel is a bootstrap reference, not validated aerodynamics. Hosted native.yml execution is unverified (TASK-003 blocker).

### TASK-017 — WASM build and loading

- **Status:** DONE — Claude; baseline e152ee3; 2026-10-16 (hosted run blocked like TASK-003).
- **Title & Description:** Implement hash/ABI validation and scalar/SIMD artifact selection.
- **Dependencies:** TASK-005, TASK-016.
- **Touched Files:** `packages/wasm-bet/package.json`, `packages/wasm-bet/src/loader.ts`, `scripts/build-wasm.mjs`, `tests/wasm-loader.test.ts`, `tests/browser/wasm-loader.spec.ts`, `package-lock.json`, `.github/workflows/ci.yml`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** bet_abi_version; artifact manifest; SIMD feature detection.
- **DoD & Acceptance Criteria:** Corrupt hashes/ABI block arming; unsupported SIMD uses scalar fallback; instantiate outside step; reserve the BET baseline memory budget of <=64 MiB before running.
- **Evidence:** Owner Claude; baseline e152ee3; 2026-10-16. node scripts/build-wasm.mjs (rustc 1.97.0) exit 0: scalar and simd128 (-C target-feature=+simd128) artifacts, 376 B each; they are currently byte-identical (SHA-256 c2927877ec3e...) because the bootstrap kernel has nothing the compiler vectorizes, so the SIMD path is exercised but brings no speedup yet. tests/wasm-loader.test.ts (Node 22.22.0): 5 PASS (manifest hashes/sizes equal node:crypto over the files on disk; SIMD selected when detected, scalar fallback when detection fails/throws or the manifest has no SIMD artifact; both variants give the independently computed element force within 1e-12; 64 MiB reserved at load, later growth reported by memoryStable(); out-of-budget reservations rejected; corrupt hash, truncated size, manifest ABI mismatch, foreign module without exports, and fetch failure all return ok=false; 15 malformed manifests rejected). Mutations (hash check disabled; memory reservation removed) each fail 1 test. tests/browser/wasm-loader.spec.ts: 1 PASS in Chromium (crossOriginIsolated, SIMD128 detected, simd128 loaded with 64 MiB reserved, forced scalar fallback, both forces match, corrupt bytes rejected). The ci.yml unit job now installs the pinned toolchain. Hosted execution is unverified (TASK-003 blocker). Instantiation is async at initialization; no step exists yet to call it from (TASK-018).

### TASK-018 — C ABI and arena binding

- **Status:** DONE — Claude; baseline a3e7141; 2026-10-16 (hosted run blocked like TASK-003).
- **Title & Description:** Define checked input/config/output records without per-step object marshaling.
- **Dependencies:** TASK-006, TASK-017.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/include/bet.h`, `packages/wasm-bet/src/arena.ts`, `tests/wasm-abi.test.ts`, `native/bet/src/lib.rs`, `native/bet/build.rs`, `native/bet/tests/abi.rs`, `packages/wasm-bet/src/loader.ts`, `packages/wasm-bet/package.json`, `tests/fixtures/wasm-abi/generate.py`, `tests/fixtures/wasm-abi/bet-abi-v1.json`, `tests/fixtures/registry.json`, `tests/browser/native-bootstrap.spec.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES section 4; rotor output stride=128.
- **DoD & Acceptance Criteria:** Rust size/offset tests match TS golden records; reject invalid pointers/counts/sizes; 1e6 step calls perform no allocation/growth and overwrite output in place.
- **Evidence:** Owner Claude; baseline a3e7141; 2026-10-16. Layout source native/bet/include/bet.h (71 defines); golden records tests/fixtures/wasm-abi/bet-abi-v1.json (config 4384 B, input 256 B, two rotors) packed independently with Python struct by generate.py and registered in tests/fixtures/registry.json. Inside native/ (rustc 1.97.0): cargo test --workspace --locked: abi 7 PASS (every bet.h define equals the Rust constant; golden config decodes and sizes the arena; 25 invalid configs and an undersized arena rejected with no live arena left; 1e6 steps return AERODYNAMICS_UNAVAILABLE and overwrite the same buffer in place; 12 invalid inputs, wrong dt, and a short output rejected without writing output; disposed/corrupt handles rejected; region range/alignment/overlap checks) + bootstrap 6 PASS; cargo check wasm32 exit 0. tests/wasm-abi.test.ts (Node 22.22.0, real wasm32 artifact): 7 PASS (BET_ABI equals bet.h; encodeBetConfig and the written input equal the golden bytes; regions above __heap_base, 64-byte aligned, disjoint, inside the 64 MiB reservation; 1e6 stepInto calls with 0 GC events in the measured window, sentinels overwritten each step, memoryStable; null/below-heap-base/misaligned/out-of-range/overlapping pointers, bad handles, wrong dt, and disposed handles rejected through the real exports; invalid configs rejected before arming; growth faults stepping with MEMORY_GROWN). The GC check found and drove a fix for one boxed HeapNumber per non-integer vector component (a `?? NaN` fallback on Float64Array reads). Mutations (that fallback restored; Rust not overwriting rotor 0 flags) each fail 1 test. The wasm32 trapping allocator makes any allocation a trap, so zero wasm allocations follow from the 1e6 steps completing. No aerodynamics yet: step reports unavailability until TASK-020. Hosted execution unverified (TASK-003 blocker).

### TASK-019 — Polar lookup

- **Status:** DONE — Claude; baseline ddb263d; 2026-10-16 (hosted run blocked like TASK-003).
- **Title & Description:** Interpolate CL/CD over alpha/logRe/Mach with validated bounds.
- **Dependencies:** TASK-004, TASK-018.
- **Touched Files:** `native/bet/src/polar.rs`, `tests/fixtures/polars/synthetic.json`, `native/bet/tests/polar.rs`, `native/bet/src/lib.rs`, `tests/fixtures/polars/generate.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** PolarTable; flattened (Mach,Re,alpha); validity flags.
- **DoD & Acceptance Criteria:** Analytic tests cover nodes/interpolation/reverse flow/bounds; reject negative CD/NaN; out-of-range inputs clamp and flag instead of silently extrapolating.
- **Evidence:** Owner Claude; baseline ddb263d; 2026-10-16. Oracle tests/fixtures/polars/synthetic.json (registered; 9 alpha nodes over [-pi, pi] with stall and flat-plate-like reverse flow, 3 Re, 3 Mach, 81 values, 13 queries) generated by generate.py from closed forms that are piecewise linear in alpha and linear in ln Re and Mach, so trilinear lookup is exact; tolerance 1e-12 absolute set in the fixture before implementation. Inside native/ (rustc 1.97.0): cargo test --workspace --locked: polar 5 PASS (13 analytic queries incl. nodes, cell interiors, reverse flow, alpha = +-pi, and clamped Re/Mach/alpha with exact flag expectations; all 81 nodes reproduced; ln-Re interpolation and single-node axes; clamp equals the boundary value and flags, non-finite queries give NaN plus flag; negative CD, NaN/inf coefficients, duplicate/unordered/NaN axes, Re <= 0, Mach < 0, and wrong shapes rejected) + abi 7 + bootstrap 6 PASS; cargo check wasm32 exit 0. Mutations (linear instead of ln Re; clamp flag dropped; negative CD accepted) fail 2, 3, and 1 tests. The lookup is not yet wired into a rotor step (TASK-020) and the table is synthetic, not a measured airfoil.

### TASK-020 — Blade element quadrature

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Integrate element forces/moments for prescribed omega and inflow.
- **Dependencies:** TASK-019, TASK-032.
- **Touched Files:** `native/bet/src/abi.rs`, `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/blade.rs`, `native/bet/src/quadrature.rs`, `native/bet/tests/blade.rs`, `native/bet/src/lib.rs`, `tests/fixtures/rotors/blade.json`, `tests/fixtures/registry.json`, `native/bet/tests/allocation.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** RotorGeometry/RotorStepInput; equations in section 3.
- **DoD & Acceptance Criteria:** Test zero flow, mirrored spin, drag dissipation, and independent wrench fixtures; sample count does not multiply total force; 16/32/64 refinement converges within fixture tolerance.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. cargo test --test blade --locked: 5 PASS. Independent annulus force/torque, 16/32/64 radial refinement, normalized azimuth averaging, spin mirroring, zero flow, drag power, pitch/flow-derived alpha, body-rate flow, geometry/input rejection and polar flags. tests/fixtures/rotors/blade.json is SHA-256 registered with synthetic provenance; fine relative tolerance 1e-4. tests/rotor-kernels.test.ts: 3 PASS, scalar/SIMD tails 1/3/5/63, independent discrete sums within 1e-9 N/Nm. Production ABI still reports unavailable pending a versioned polar/config binding.

### TASK-021 — Dynamic inflow

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Add bounded axial induced-flow state and its validity envelope.
- **Dependencies:** TASK-020.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/inflow.rs`, `native/bet/tests/inflow.rs`, `tests/fixtures/rotors/axial-inflow.json`, `tests/fixtures/registry.json`, `native/bet/src/lib.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Signed induced velocity; at most four solver iterations per step.
- **DoD & Acceptance Criteria:** Hover momentum residual is <=1% of fixture thrust; test transient convergence; mark VRS/out-of-envelope cases unvalidated; zero RPM/flow remains finite.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. cargo test --test inflow --locked: 2 PASS. Signed hover/climb momentum residual <=1%, exact relaxation at 400/800/1200 Hz, reverse thrust, zero loading and explicit descent/VRS/transverse validity. SHA-256 registered synthetic axial-inflow.json oracle. Closed-form target uses zero iterative solves (within four-iteration budget); not a validated autorotation/VRS inflow model. Scalar/SIMD transient matches analytic target within 1e-9 m/s.

### TASK-022 — Free shaft and autorotation

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Integrate RPM from aerodynamic torque, drive torque, and losses without an RPM governor.
- **Dependencies:** TASK-021.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/shaft.rs`, `native/bet/tests/autorotation.rs`, `tests/fixtures/rotors/free-shaft.json`, `tests/fixtures/registry.json`, `native/bet/src/lib.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** J*dOmega/dt=tau_motor+s*Qair-tau_loss; RotorState.
- **DoD & Acceptance Criteria:** Without flow/drive, energy decreases; permitted airflow drives acceleration/deceleration through torque; steady residual<0.01 Nm; no artificial prescribed RPM.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. cargo test --test autorotation --locked: 2 PASS. Passive energy decay and exact zero-damping limit; coupled blade torque drives/brakes the free shaft under synthetic upward flow for both spins, reaches residual <0.01 Nm, converges at 400/800/1200 Hz, and decelerates after airflow removal. SHA-256 registered free-shaft.json oracle. No prescribed RPM/governor; attempted reversal is explicitly limited. Scalar/SIMD passive speed agrees within 1e-9 rad/s. No experimental autogyro validation claimed.

### TASK-023 — Flapping and gyroscopic momentum

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Implement coning/first-harmonic flapping and complete dH/dt transmission.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/Cargo.toml`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/support/mod.rs`, `native/bet/src/flapping.rs`, `native/bet/src/momentum.rs`, `native/bet/tests/flapping.rs`, `native/bet/src/lib.rs`, `tests/fixtures/rotors/flapping.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** RotorState flap states; Mhub=Mair-dH/dt; documented hinge parameters.
- **DoD & Acceptance Criteria:** Test symmetry, sign/axes, angular momentum balance, and timestep convergence; retain equation sources/validity; mesh tilt never substitutes for dynamics.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. cargo test --test flapping --locked: 3 PASS. Zero-offset hinge Galerkin equations and modal inertia normalization documented; oscillator refinement, collective symmetry, mirrored rotating-hinge signs, bounded validity, spin/cone/cyclic momentum and inertial transport balance. Synthetic flapping.json registered by SHA-256; scalar/SIMD oscillator tolerance 1e-8 rad. Native allocation test: zero calls and zero allocated bytes over 1e6 combined kernel steps, allocating positive control detected; debug and release pass. WASM trapping allocator: million-step dynamics, stable memory. Flat-disk load coupling and small-angle reduced inertia remain explicit limitations. Full batch gates exit 0: frozen npm ci (lockfile SHA-256 89f81050ae94d179d043929086ba7ec00328644e5ac4d46b26013ee1422cb084 unchanged); npm run lint/typecheck/check:docs/build; CI=true npm test (209 PASS); CI=true CHROMIUM_PATH=/usr/bin/chromium npm run test:browser (17 PASS); cargo check --manifest-path native/Cargo.toml --workspace --locked; cargo check --manifest-path native/Cargo.toml -p mirage-bet --target wasm32-unknown-unknown --locked; cargo test --manifest-path native/Cargo.toml --workspace --locked (31 PASS). No failures/skips in final reports: test-results/unit/junit.xml, test-results/browser/junit.xml. Rust 1.97.0 (2d8144b78), Node 24.19.0, Chromium 154.0.8037.57, Debian x86_64/software GPU; CARGO_HOME=/workspace/.cache/mirage-cargo and RUSTUP_HOME=/workspace/.cache/mirage-rustup, Cargo bin on PATH. EN/RU spec/architecture/roadmap/README/CLAUDE synchronized. Target hardware and hosted Actions remain unverified.

### TASK-024 — Coaxial interaction

- **Status:** DONE — Codex; baseline 8f7dc19; 2026-10-16.
- **Title & Description:** Introduce explicit wake coupling for a pair of rotor disks.
- **Dependencies:** TASK-021, TASK-023.
- **Touched Files:** `native/bet/src/coaxial.rs`, `native/bet/tests/coaxial.rs`, `tests/fixtures/rotors/coaxial.json`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `native/bet/tests/allocation.rs`, `tests/rotor-kernels.test.ts`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** WakePair {upperId,lowerId,separationM,overlap}; energy/source provenance.
- **DoD & Acceptance Criteria:** Disabled coupling matches independent rotors; large separation approaches independence; check momentum/energy accounting; without measurements label the model experimental.
- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. cargo test --manifest-path native/Cargo.toml --test coaxial --locked: 4 PASS (independent flux oracle, exact disabled/zero-overlap receiver wrench, active coupling, far-field wrench within 1e-6 N/Nm, overlap scaling, scaled momentum/energy budgets, geometry/regime rejection). Oracle coaxial-analytic-v1 SHA-256 a7d0032c6c019afaa8b84f16692e2b1a9d07e180bedae28ba2bc6bd25bad5ebb; units SI; absolute fixture tolerance 1e-9. Native allocator counter includes 1e6 wake evaluations: zero calls/bytes, positive allocating control detected. tests/rotor-kernels.test.ts: 4 PASS, including scalar/SIMD wake oracle/budget checks and 1e6 varying-thrust steps with trapping allocator and stable memory; disabled/zero-flow output is canonical +0. Full verification exit 0: npm run lint, npm run typecheck, npm run check:docs, npm run build; CI=true npm test (210 PASS), CI=true CHROMIUM_PATH=/usr/bin/chromium npm run test:browser (17 PASS); cargo check --manifest-path native/Cargo.toml --workspace --locked, cargo check --manifest-path native/Cargo.toml -p mirage-bet --target wasm32-unknown-unknown --locked, cargo test --manifest-path native/Cargo.toml --workspace --locked (35 PASS); focused coaxial/allocation rerun after signed-zero correction (5 PASS). Final JUnit: test-results/unit/junit.xml, test-results/browser/junit.xml, no failures/errors/skips. Rust 1.97.0, Node 24.19.0, Chromium 154.0.8037.57, Debian x86_64/software GPU. Cargo environment uses CARGO_HOME=/workspace/.cache/mirage-cargo, RUSTUP_HOME=/workspace/.cache/mirage-rustup with Cargo bin on PATH. EN/RU specification, architecture and roadmap synchronized. Experimental ideal-hover/mixing reference only; no measured calibration, production C ABI/backend wiring or target-hardware performance claim.

### TASK-025 — ESC and spool model

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Convert duty into drive torque/RPM transients using the selected motor model.
- **Dependencies:** TASK-022.
- **Touched Files:** `native/bet/src/motor.rs`, `native/bet/tests/motor.rs`, `packages/physics/src/motor-config.ts`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/motor-config.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Torque model or first-order governor; current/back-EMF limits.
- **DoD & Acceptance Criteria:** Duty steps follow configured lag/current saturation; zero voltage creates no energy; power cuts preserve spin decay; never integrate two spool ODEs simultaneously.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. 2 native motor tests, strict motor schema test and scalar/SIMD analytic parity pass. Exact duty lag, winding-current saturation, bus/mechanical/copper power balance and power cut without resetting shaft speed. Native allocator probe includes motor over 1e6 steps with zero calls/bytes. Full rotor/backend wiring remains separate.

### TASK-026 — Battery sag

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Calculate SOC, bus voltage, and available power across all motors.
- **Dependencies:** TASK-025.
- **Touched Files:** `native/bet/src/battery.rs`, `native/bet/tests/battery.rs`, `tests/fixtures/power/battery.json`, `native/bet/src/lib.rs`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** V=Voc-I*R; SOC; power-limited flags.
- **DoD & Acceptance Criteria:** Analytic resistance, R approaching zero, depleted SOC, and infeasible power cases remain finite; energy/current signs agree; count every motor load exactly once.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. 2 native battery tests and scalar/SIMD quadratic-root oracle pass. Shared load accounting, R=0/1e-20, charge/current/power saturation, depletion, nonfinite rejection and held-SOC power balance covered. power/battery.json is an independent hashed synthetic oracle, not pack measurements. Native million-step allocation gate passes.

### TASK-027 — Arbitrary frame wrench

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Aggregate thrust vectors, moment arms, and transmitted rotor moments.
- **Dependencies:** TASK-006, TASK-023, TASK-025, TASK-026.
- **Touched Files:** `native/bet/src/frame.rs`, `packages/physics/src/frame.ts`, `native/bet/tests/frame.rs`, `tests/fixtures/models/tilted-octo.json`, `native/bet/src/lib.rs`, `native/bet/src/math.rs`, `tests/frame.test.ts`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** F=sum R*F; M=sum(r cross R*F+R*Mhub); stable motor IDs.
- **DoD & Acceptance Criteria:** Quad/hexa/tilted-octo fixtures verify symmetry, yaw cancellation, and handedness; tilted axes generate lateral force; motor reaction is never counted twice.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. 2 native and 2 TypeScript frame tests plus scalar/SIMD tilted-force oracle pass. Symmetric quad/hexa/octo cancel lever/yaw moments; registered tilted-octo fixture produces 4*sqrt(2) N on body X and Z from eight unit hub forces. Stable IDs, right-handed transforms and no duplicate transmitted reaction. Native million-step allocation gate passes.

### TASK-028 — Rigid-body integrator

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Integrate BET wrench using mass/inertia, quaternion, and NED gravity.
- **Dependencies:** TASK-027.
- **Touched Files:** `native/bet/src/rigid_body.rs`, `packages/wasm-bet/src/backend.ts`, `native/bet/tests/rigid_body.rs`, `native/bet/src/lib.rs`, `native/bet/src/body_abi.rs`, `native/bet/tests/body_abi.rs`, `tests/rigid-body.test.ts`, `packages/wasm-bet/package.json`, `tests/fixtures/abi/body-v1.json`, `native/bet/src/test_exports.rs`, `tests/rotor-kernels.test.ts`, `native/bet/tests/allocation.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `tests/browser/native-bootstrap.spec.ts`, `scripts/bench-sensors.mjs`.
- **Interfaces / Contracts:** DynamicsBackend, TruthOutput; one integration owner.
- **DoD & Acceptance Criteria:** Test ballistic/torque-free/constant-torque cases; native quaternion norm error<1e-10; trajectories remain finite; check 400/800/1200 convergence against offline 4800 Hz.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. 3 native rigid-body tests plus body ABI rejection/layout test pass: ballistic and constant principal torque analytic solutions, quaternion norm below 1e-10, torque-free 400/800/1200 convergence to 4800 Hz. Independent 256/128-byte body ABI v1, dedicated-memory ownership and actual scalar/SIMD adapter tests. Native million-step allocation counter passes; WASM allocation traps and memory stability are exercised separately. No full BET flight/backend claim. Additional G1 evidence: bench-sensors.mjs body runs the actual scalar WASM body adapter plus sensor pipeline over six warmed N=1e6/2e6 windows: zero GC, zero incremental B/step, positive allocating control detected; unit tests run 1e6 steps per scalar/SIMD artifact with trapping allocator and stable memory.

### TASK-029 — Landing-gear contact

- **Status:** BLOCKED_DECISION — Codex; native patch passes; production binding is uncertified.
- **Title & Description:** Integrate one chosen contact solver and synchronize impulses.
- **Dependencies:** TASK-028.
- **Touched Files:** `packages/physics/src/contact-backend.ts`, `packages/physics/src/ground-contact.ts`, `tests/contact.test.ts`, `tests/fixtures/contact/drop.json`, `package-lock.json`, `packages/physics/package.json`, `tests/contact-allocation.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `packages/physics/src/contact-engine.ts`, `scripts/bench-contact.mjs`, `native/rapier/allocation_probe.rs`, `native/rapier/source.lock.json`, `native/rapier/Cargo.lock`, `scripts/check-contact-native.mjs`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `native/rapier/patches/reuse-step-buffers.patch`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`.
- **Interfaces / Contracts:** ContactImpulse {pointBody,impulseNed,dt}; choose Rapier or Jolt in an ADR.
- **DoD & Acceptance Criteria:** Drop/rolling/friction/nonpenetration fixtures pass; restitution adds no excess energy; a second solver never reintegrates the same body; meet G1 allocation budget.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. Real Rapier 0.21.0 sphere/plane drop, rolling friction, nonpenetration and restitution tests pass. Integration ownership and impulse diagnostic are implemented. Provider getter identity test proves fresh wrappers: highRateCertified=false; G1 FAIL prevents production admission. ADR in docs/architecture.md records the decision and need for nonallocating binding or alternate solver. General landing-gear manifold remains open.

- **Retry Evidence:** Retry: reusable target getters and persistent raw force/torque/gravity vectors replace per-step wrapper construction; fixed-topology raw pipeline and idempotent disposal tested. Actual warmed JS probe still fails with 143/142/71 GC events per 1e6-step window (exit 1). Profiler-free native f64 Rapier 0.36.0, pinned source b716d375efc0201003f0cd9ef7168eee0b62c177: 1,688,500 allocator calls / 77,328,000 bytes over 1e6 steps (exit 2). Reports test-results/bench/contact.json and contact-native.json. Native f64 evidence does not certify packaged f32 WASM. G1 remains failed; no high-rate admission.

- **Patch Retry Evidence (2026-10-16):** Opt-in storage-reuse patch: matching awake sphere/halfspace runs now measure original 2,002,500 calls / 96,320,000 bytes versus patched zero calls/bytes over 1e6 steps; trajectory checksum 317ba7c959cd2b59 matches. Patched report test-results/bench/contact-native-patched.json, CLI exit 0. Earlier finite-box/sleep-enabled counts are historical. The shipped JS binding still fails G1; general landing gear remains open.

### TASK-030 — Pinned JSBSim WASM artifact

- **Status:** BLOCKED_EXTERNAL — Codex; retry verified on 2026-10-16.
- **Title & Description:** Build JSBSim with reproducible source/toolchain manifests through Emscripten.
- **Dependencies:** TASK-003, TASK-004, TASK-006.
- **Touched Files:** `native/jsbsim/CMakeLists.txt`, `native/jsbsim/source.lock.json`, `native/jsbsim/toolchain.lock.json`, `scripts/build-jsbsim.mjs`, `packages/wasm-jsbsim/package.json`, `tests/jsbsim-artifact.test.ts`, `native/jsbsim/bridge.cpp`, `native/jsbsim/property-map.json`, `package-lock.json`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `scripts/check-jsbsim-native.mjs`, `native/jsbsim/native_checks.cpp`, `native/jsbsim/patches/reuse-history-and-property-paths.patch`.
- **Interfaces / Contracts:** WASM C ABI version/hash; JSBSim and model-data licenses.
- **DoD & Acceptance Criteria:** Build pinned source with verified checksums; native/WASM references share source; unit conversion does not patch upstream physics; Worker artifact smoke passes.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. Pinned JSBSim v1.2.3 commit 570e8115a102df8f877b11e0e59b964ea483e3c0; pinned emsdk 4.0.15 commit 389a68bc35dcff7ebae4614e1615099dafda00d1; source/license/SDK-manifest guards pass. Native C++ bridge builds with GNU 14.2/CMake 3.31.6 and returns 22 finite SI outputs after 1 s. Emscripten install fails at storage.googleapis.com with proxy CONNECT 403; no WASM artifact or Worker smoke. Network domain and reusable setup saved as an unapplied environment draft requiring review/save/publication. Hosted TASK-003 execution and model-data licensing acceptance remain unverified.

- **Retry Evidence:** Retry: python3 emsdk.py install 4.0.15 still fails downloading node-v22.16.0-linux-x64.tar.xz from storage.googleapis.com: proxy tunnel CONNECT 403, exit 1. Saved network draft remains unapplied to this runtime. Added native check target and cold-path exception-catching build flags; actual Emscripten compilation/Worker artifact smoke remain unrun. Reusable startup diagnostics saved in the environment draft; persistence is not publication.

- **Patch Retry Evidence (2026-10-16):** Build runner now supports a verified opt-in allocation patch and records its SHA-256 in the artifact manifest. Source checkouts remain clean. Native patched evidence cannot clear the SDK HTTP 403 or substitute for actual WASM/Worker smoke.

### TASK-031 — JSBSim DynamicsBackend

- **Status:** BLOCKED_EXTERNAL — Codex; retry verified on 2026-10-16.
- **Title & Description:** Adapt JSBSim state, actuators, and contact exchange.
- **Dependencies:** TASK-018, TASK-029, TASK-030, TASK-032.
- **Touched Files:** `native/jsbsim/bridge.cpp`, `packages/wasm-jsbsim/src/backend.ts`, `tests/jsbsim-backend.test.ts`, `tests/fixtures/airframes/jsbsim-trim.json`, `native/jsbsim/property-map.json`, `packages/wasm-jsbsim/package.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `tests/fixtures/registry.json`, `native/jsbsim/native_checks.cpp`, `scripts/check-jsbsim-native.mjs`, `tests/jsbsim-native.test.ts`, `native/jsbsim/patches/reuse-history-and-property-paths.patch`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`.
- **Interfaces / Contracts:** DynamicsBackend; ft/slugs to SI; FRD/NED; JSBSim owns integration.
- **DoD & Acceptance Criteria:** Native/WASM trim and step-control fixtures meet manifest tolerances; stationary specific force/signs are correct; couple contact impulses consistently; no per-step allocation/growth.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. C ABI/property map and TypeScript in-place adapter implement exact ft-to-m conversion, fixed-origin ECEF/NED transport, wxyz and separate coordinate acceleration/specific force. JSBSim is the sole integration owner. Native same-source smoke passes; actual WASM trim/control parity, model redistribution review, contact impulse coupling and no-allocation gate do not. airframes/jsbsim-trim.json explicitly records blocked acceptance; it is not a fabricated trim golden.

- **Retry Evidence:** Retry: fixed stale-handle ABA using generations, rejected overlapping frames before advancing simulation, hardened heap/allocator view checks, and added optional cold jsb_trim/trimInto. Actual native full trim, invalid/stale frames, normalized quaternion and SI/frame derivative checks pass. Native allocator probe covers 250 windows of 4000 measured steps after 400 warmup each: 21,142,500 calls / 1,454,820,000 bytes, exit 2. Report test-results/validation/jsbsim-native.json includes source/model/bridge/checker hashes. G1 fails independently of the SDK block; native/WASM parity and contact coupling remain open.

- **Patch Retry Evidence (2026-10-16):** Opt-in JSBSim patch reuses deque history, atmosphere property traversal and fuel-feed storage. Actual native full trim and SI/frame checks pass; 1e6 measured steps now have zero calls/bytes versus original 21,142,500 calls / 1,454,820,000 bytes. Trajectory checksum 164fd3c0bf6d8a39 matches. Patched report test-results/validation/jsbsim-native-patched.json; CLI exit 0. Other models, WASM parity and contact coupling remain uncertified.

### TASK-032 — Atmosphere and wind

- **Status:** DONE — Codex; baseline 9ce0da1; 2026-10-16.
- **Title & Description:** Implement shared atmospheric state and deterministic gust input.
- **Dependencies:** TASK-004, TASK-006, TASK-010.
- **Touched Files:** `CLAUDE.md`, `docs/ru/CLAUDE.md`, `README.md`, `docs/ru/README.md`, `packages/physics/src/atmosphere.ts`, `packages/physics/src/wind.ts`, `tests/atmosphere.test.ts`, `packages/physics/package.json`, `package-lock.json`, `scripts/bench-wind.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** Temperature/pressure to density/viscosity/speed of sound; seeded gust bandwidth.
- **DoD & Acceptance Criteria:** ISA references and calm/gust/reset/replay fixtures pass; JSBSim/BET share units; fixed seed is independent of render FPS; reject invalid near-zero density through schema validation.
- **Evidence:** Owner Codex; baseline 9ce0da1; 2026-10-16. tests/atmosphere.test.ts: 4 PASS (ISA sea level/11 km, strict state schema, calm/reset/render-independent replay, stationary variance/pole over 2e6 samples). node scripts/bench-wind.mjs: exit 0, seed 123, 400 Hz; six warmed N=1e6/2e6 windows, no GC; incremental allocation estimate 0.000128 B/step with fixed probe overhead; allocating control detected 31 GC events. Report: test-results/bench/wind.json. Shared SI helpers exported; no runtime weather binding or measured turbulence claim.

### TASK-033 — Model validation gate

- **Status:** BLOCKED_EXTERNAL — Codex; retry verified on 2026-10-16.
- **Title & Description:** Run numerical/reference validation and report model fidelity separately.
- **Dependencies:** TASK-014, TASK-024, TASK-028, TASK-029, TASK-031.
- **Touched Files:** `scripts/validate-models.mjs`, `tests/model-validation.test.ts`, `docs/validation/model-report.schema.json`, `tests/fixtures/validation/reference-manifest.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `scripts/check-engine-patch-parity.mjs`, `tests/engine-patch-parity.test.ts`.
- **Interfaces / Contracts:** ValidityEnvelope; numerical parity is separate from experimental validity.
- **DoD & Acceptance Criteria:** Smooth 10 s cases stay within 0.1 m/0.5 degrees of 4800 Hz references; meet scalar/SIMD force/moment tolerances in section 4; retain reference provenance; missing measurements block fidelity rather than producing a synthetic PASS.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. Executable reporter builds real scalar/SIMD artifacts and passes 12 numerical cases (two 10 s scenarios, 400/800/1200 versus 4800 Hz) within 0.1 m/0.5 degrees; analytic ballistic check passes. Schema/exit-code test verifies numerical PASS, fidelity BLOCKED, overall BLOCKED, exit 2. Report: test-results/validation/model-report.json, with reference/artifact SHA-256. No measured airframe/rotor dataset, complete BET binding, contact G1 or JSBSim WASM parity; do not label the fidelity gate DONE.

- **Retry Evidence:** Retry: model report schema v2 records hash-checked contact/native-JSBSim diagnostics, detects stale evidence and rejects empty/misordered rates, malformed/duplicate cases and unsupported measured-data entries before build. Actual 12 numerical cases pass; both diagnostic gates report failed, overall/fidelity BLOCKED, exit 2. No measured airframe/rotor dataset was supplied; full BET binding remains absent. Final retry checks exit 0: lint/typecheck/build/check:docs, 235 unit tests (36 files), 17 browser tests; fresh JUnit has no failures/errors/skips. Allocation probes and SDK failures are separate unsuccessful acceptance gates, not counted as passing integration. EN/RU documents synchronized; no commit/push.

- **Final Patch Verification (2026-10-16):** Final patch retry: lint/typecheck/build/check:docs exit 0; 236 unit tests in 37 files and 17 Chromium browser tests pass. Fresh JUnit: test-results/unit/junit.xml and test-results/browser/junit.xml, zero failures/errors/skips. The first browser invocation lacked Rust activation and had an 800 Hz timing miss under concurrent load; the corrected isolated run passes unchanged thresholds. Patched native probes and engine-patch-parity CLI exit 0; original native probes exit 2; JS GC probe exit 1; model-validation CLI exit 2 with 12 numerical PASS and blocked fidelity. Source checkouts remain clean; lockfile hash unchanged. Bilingual source hashes checked. Environment startup draft saved, requires settings review/save/publication; it does not apply SDK access. No commit/push.

## Phase 3: ArduPilot & Radio Link

- **Patch Retry Evidence (2026-10-16):** Added original/patched native parity checker with source/patch/report SHA-256 and all-step trajectory checksums, plus rejection tests. Both patched native diagnostics pass; original JS/native gates remain failed. Model report v2 keeps those results separate and still exits 2 for blocked fidelity. Missing measured datasets, complete BET binding and WASM/contact integration remain explicit.

### TASK-034 — Ideal sensors

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Convert truth into IMU/magnetometer/barometer/airspeed observations without noise or EW.
- **Dependencies:** TASK-013, TASK-028, TASK-032.
- **Touched Files:** `packages/sensors/package.json`, `packages/sensors/src/ideal.ts`, `tests/ideal-sensors.test.ts`, `package-lock.json`, `tests/fixtures/sensors/ideal.json`, `tests/fixtures/registry.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** GpsSample/ImuSample; acceleration versus specific force; gauss/Pa internal units.
- **DoD & Acceptance Criteria:** Stationary/free-fall/rotated-body fixtures pass; gyro/mag use body axes; verify pressure signs; write outputs in place and meet G1.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. 2 ideal sensor tests cover stationary/free-fall/inverted specific force, rotated gauss, ISA Pa/down sign and dynamic pressure; existing sensor codec validates records. bench-sensors.mjs ideal exercises all four implemented sensor kinds: six N=1e6/2e6 windows, zero GC and zero incremental B/step after 4e6 warmup; allocating control detected. Existing output records/scratch are reused. GNSS awaits TASK-036; no autopilot/Worker wiring claim.

### TASK-035 — Sensor rates, noise, and bias

- **Status:** DONE — Codex; baseline 8f7dc19 plus local TASK-024; 2026-10-16.
- **Title & Description:** Add rational sampling, bounded latency, and seeded noise streams.
- **Dependencies:** TASK-004, TASK-011, TASK-034.
- **Touched Files:** `packages/sensors/src/scheduler.ts`, `packages/sensors/src/noise.ts`, `packages/sensors/src/latency.ts`, `tests/sensor-scheduler.test.ts`, `tests/sensor-noise.test.ts`, `scripts/bench-sensors.mjs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`.
- **Interfaces / Contracts:** IMU 200/400 Hz; GPS 5/10 Hz; PSD/bandwidth; sample time.
- **DoD & Acceptance Criteria:** Exact sample counts over 60 simulated seconds at 400/800/1200; repeatable seeds; statistics within declared confidence intervals; bounded monotonic latency queues.

- **Evidence:** Owner Codex; baseline 8f7dc19; 2026-10-16. 2 scheduler/latency and 2 noise tests pass. Exact 60 s counts at 400/800/1200 for 5/10/200/400 Hz; bounded monotonic FIFO overflow/reset; independent deterministic streams/reset; 1e6-sample Gaussian variance and lag. bench-sensors.mjs all: four million warmup ticks including timestamp rollover, six N=1e6/2e6 windows, zero GC/zero incremental B/step, allocating control 31 GC events, zero dropped samples. Numeric arrays in sampleInto avoid boxed returns. Noise RMS, pole, bias walk and two-sided PSD are documented; Node evidence is not browser/target-hardware timing.

### TASK-036 — WGS84 and MSL

- **Status:** DONE — Claude; baseline 346866c; 2026-10-16 (absolute MSL accuracy gate BLOCKED_EXTERNAL until an authoritative geoid grid is installed).
- **Title & Description:** Implement float64 origin/ECEF/NED/geoid conversion.
- **Dependencies:** TASK-004, TASK-006.
- **Touched Files:** `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `tests/geodesy.test.ts`, `tests/fixtures/geodesy/wgs84.json`, `tests/fixtures/geodesy/generate.py`, `tests/fixtures/registry.json`, `packages/sensors/package.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** WGS84 ellipsoidal h versus MSL H; authoritative geoid data/hash/license.
- **DoD & Acceptance Criteria:** Local synthetic roundtrips<=1 mm; test poles/antimeridian/15 km offsets without cos(latitude) singularities; absent geoid data explicitly blocks the absolute MSL accuracy gate.
- **Evidence:** Owner Claude; baseline 346866c; 2026-10-16. Oracle tests/fixtures/geodesy/wgs84.json (registered) generated by generate.py: closed-form WGS84 forward and a fixed-point inverse in Python, independent of the TypeScript Bowring inverse; 8 reference points (equator, both poles, antimeridian, Everest 8848.86 m, Dead Sea -430 m, 15 km altitude, 89.9999 deg) and 7 tangent cases (15 km offsets over both poles, across the antimeridian eastward and westward, mixed 15 km, 15 km down, 10 km up). Node 24.22.0: tests/geodesy.test.ts 8 PASS (oracle ECEF within 1e-6 m and inverses within 1 mm; tangent cases within 1 mm with longitude in [-pi, pi) and roundtrip within 1 mm; 13x13x4 grids of offsets up to 15 km at six origins including both poles and +-pi longitude roundtrip with worst error below 1 mm; orthonormal NED axes and pure-height climb along the normal; exact +pi to -pi wrap at the antipode; synthetic geoid bilinear/wrap/clamp, H = h - N roundtrip, gate AVAILABLE only with provenance and a matching hash, NO_GEOID BLOCKED_EXTERNAL; malformed grids rejected) + fixtures.test.ts registry verification. Mutations (no Bowring refinement, flipped east axis, no longitude wrap) fail 4, 1 and 1 tests. Remaining: no authoritative geoid grid (EGM96/EGM2008 source, license and SHA-256) is installed, so the absolute MSL accuracy gate is BLOCKED_EXTERNAL; local conversions are complete.

### TASK-037 — MAVLink2 codec

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Pin the dialect/generator and implement streaming binary parsing/encoding.
- **Dependencies:** TASK-003, TASK-004, TASK-013.
- **Touched Files:** `packages/mavlink/package.json`, `packages/mavlink/dialect.lock.json`, `packages/mavlink/src/codec.ts`, `packages/mavlink/src/sensor-mapping.ts`, `tests/mavlink.test.ts`, `tests/fixtures/mavlink/golden.json`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `packages/mavlink/src/messages.ts`, `packages/mavlink/src/samples.ts`, `scripts/generate-mavlink-fixtures.py`, `tests/fixtures/registry.json`, `package-lock.json`, `scripts/bench-links-ew.mjs`, `tests/sensor-samples.ts`, `tests/links-ew-allocation.test.ts`, `packages/mavlink/NOTICE`.
- **Interfaces / Contracts:** HIL_GPS/HIL_SENSOR/HIL_ACTUATOR_CONTROLS/RC_CHANNELS_OVERRIDE; engine specification section 6.
- **DoD & Acceptance Criteria:** Match official-generated frames including CRC_EXTRA/packing; test arbitrary chunks/truncation/bad CRC/sequence; cover DOP times 100, gauss/hPa/LSB/u64; no unsafe any.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Official pymavlink 2.4.50 frames from pinned common XML match byte-for-byte: CRC_EXTRA, field order, u64 words, extensions and trailing-zero truncation. Five codec/mapping tests pass, including arbitrary chunks, CRC/signing rejection, sequence wrap and consumer-error recovery. Reused buffers and all four wire types are exercised by the 400/800/1200 Hz G1 probe. Dialect/generator/license hashes and synthetic golden registry retained; signed MAVLink and additional message IDs remain unsupported.

### TASK-038 — RC and flight-mode mapping

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Extend USB calibration with modes and correctly encode RC override.
- **Dependencies:** TASK-010, TASK-037.
- **Touched Files:** `packages/input/src/mode-channel.ts`, `packages/input/src/calibration-store.ts`, `packages/mavlink/src/rc-override.ts`, `apps/web/src/App.tsx`, `tests/rc-override.test.ts`, `tests/browser/radio.spec.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/runtime.ts`, `packages/input/package.json`, `packages/input/src/index.ts`, `tests/fixtures/registry.json`, `apps/web/package.json`, `package-lock.json`, `scripts/bench-links-ew.mjs`, `tests/links-ew-allocation.test.ts`, `docs/hardware/radio-checklist.md`, `docs/ru/radio-checklist.md`, `docs/documentation-index.json`.
- **Interfaces / Contracts:** Pilot mailbox v2; RC endpoints/deadzone/mode slots; channel-group sentinel semantics.
- **DoD & Acceptance Criteria:** Persist schema-versioned calibration; bad axes/unplug/reconnect disarm; enforce zero-throttle arming; test PWM endpoints and group-specific release/ignore; retain a separate physical USB checklist.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Four RC/profile tests and the radio browser test pass; existing input/arming/disconnect regressions remain green. Versioned calibration persists raw axes and an editable independent mode axis; invalid/overlapping mode axes clear input, calibration changes disarm, and reload restores settings. PilotRcMapper checks PWM endpoints and channel-group release/ignore; v2 mailbox carries calibrated slots without inventing flight modes. Physical USB checklist docs/hardware/radio-checklist.md and docs/ru/radio-checklist.md is NOT_RUN.

### TASK-039 — Autopilot state machine

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Define mutually exclusive autopilot backends and lifecycle/link policies.
- **Dependencies:** TASK-010, TASK-012, TASK-013, TASK-037.
- **Touched Files:** `packages/autopilot/package.json`, `packages/autopilot/src/adapter.ts`, `packages/autopilot/src/state-machine.ts`, `tests/autopilot-state.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `package-lock.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** disconnected to initializing to warming to ready to running to fault; actuators/health.
- **DoD & Acceptance Criteria:** Reject illegal transitions and concurrent SITL/HITL; stale actuators/disarm/link loss cannot hold thrust indefinitely; never fabricate EKF READY.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Two lifecycle tests cover exclusive backends, illegal transitions, epoch/future/replayed controls, health loss, disarm, staleness and reversed clocks. READY needs actual adapter-sourced health; elapsed time alone cannot enable it. Default timeout 100 ms. Typed-array clock methods pass all three G1 frequencies. This task defines admission; no real firmware/health decoder or live UI autopilot is claimed.

### TASK-040 — Local WebSocket bridge

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Implement loopback transport with origin/session checks and bounded framing.
- **Dependencies:** TASK-003, TASK-037, TASK-039.
- **Touched Files:** `apps/bridge/package.json`, `apps/bridge/src/server.ts`, `apps/bridge/src/session.ts`, `apps/bridge/src/framing.ts`, `tests/bridge.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `package-lock.json`, `scripts/bench-links-ew.mjs`.
- **Interfaces / Contracts:** WS localhost:9002; version/length/epoch binary frames; separate UDP channels.
- **DoD & Acceptance Criteria:** Reject unauthorized origins/sessions and oversized/flooded frames; bind loopback by default; test split/coalesced frames/backpressure/reconnect; document WSS/PNA compatibility.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Three bridge tests pass with real loopback WS/UDP roundtrips, fragmented/coalesced delivery, token/origin/session rejection, epochs, sequence wrap, flood/size bounds, reconnect and injected backpressure. CLI startup verified on 127.0.0.1:9002; only the owned process stopped. One client, 4096-byte payload, 4096 messages/s, default 65536-byte queues and 5 s idle close. Exact binary v1 header, channel directions, token handling and WSS/PNA limits documented; ArduPilot JSON lockstep remains TASK-041.

### TASK-041 — ArduPilot JSON physics backend

- **Status:** DONE — Claude; baseline 6401104; 2026-10-16 (protocol verified against pinned upstream source; live SITL run is TASK-042).
- **Title & Description:** Connect truth/sensors and servo outputs in external SITL lockstep.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-040.
- **Touched Files:** `apps/bridge/src/ardupilot-json.ts`, `packages/autopilot/src/external-sitl.ts`, `tests/ardupilot-json.test.ts`, `tests/fixtures/sitl/json-protocol.json`, `apps/bridge/src/server.ts`, `apps/bridge/package.json`, `packages/autopilot/package.json`, `package-lock.json`, `tests/fixtures/sitl/generate.py`, `tests/fixtures/registry.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Pinned ArduPilot JSON protocol; frame counters/time domain; MAVLink does not replace physics JSON.
- **DoD & Acceptance Criteria:** Verify UDP schema/endianness/servo mapping against pinned upstream; lost/duplicate/out-of-order packets never double-step; wait for valid actuator before next tick while pause stays responsive.
- **Evidence:** Owner Claude; baseline 6401104; 2026-10-16. Upstream pinned: ArduPilot 8ab6afde107a91df1b5f60ade8f333cb8a61b190, SIM_JSON.h sha256 ba8f86c7..., SIM_JSON.cpp 9d611508..., examples/JSON/readme.md cfc34793... (full hashes in tests/fixtures/sitl/json-protocol.json; generate.py downloads them and asserts the magic values, port 9002 and the 0.1 s timestamp rule in the source). Node 24.22.0: tests/ardupilot-json.test.ts 10 PASS (16/32-channel golden packets from Python struct decode, three malformed packets rejected with output untouched; reply equals the Python '%.9f' line byte-for-byte; a TypeScript transcription of pinned parse_sensors/parse_array reads every field, the upstream readme example parses and validates; key-order hazard demonstrated: velocity_wind before velocity or a missing velocity makes upstream read wind as velocity, which the bridge validator refuses along with 7 other malformed lines; lockstep step/duplicate with identical resend/gap/stale/restart/invalid; 20000 seeded frames with 5% loss, 10% duplicates and window reversals give exactly one tick per accepted forward frame; PWM mapping with explicit MOT_PWM_MIN/MAX and clamp counting; timestamp must increase by less than 0.1 s; SteppingPolicy sitl-lockstep returns waiting without blocking; real loopback UDP + WebSocket bridge forwards a valid servo packet, drops a malformed one, replies to the learned SITL source port, and closes the session on an invalid state line) + bridge.test.ts regression 3 PASS. Mutations (duplicate steps again, minus sign lost, bridge accepts any datagram) fail 2, 1 and 2 tests. CLI smoke: MIRAGE_ARDUPILOT_JSON_PORT=9002 starts the bridge. Remaining: no ArduPilot SITL binary is run; verification against the live process belongs to the pinned harness TASK-042.

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

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Open ports only through a user gesture and handle stream/reconnect lifecycle.
- **Dependencies:** TASK-005, TASK-037, TASK-039.
- **Touched Files:** `packages/autopilot/src/serial-transport.ts`, `apps/web/src/SerialConnect.tsx`, `tests/serial-transport.test.ts`, `tests/browser/serial-permission.spec.ts`, `packages/autopilot/src/serial-io.worker.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `apps/web/src/App.tsx`, `apps/web/package.json`, `package-lock.json`.
- **Interfaces / Contracts:** ReadableStream chunks to MAVLink parser; permission/user gesture; port ownership.
- **DoD & Acceptance Criteria:** Mock chunk/error/disconnect/cancel cases; reopening never duplicates a reader; unsupported browsers disable the mode; mocks are not physical HITL evidence.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Four Serial stream tests cover ownership, arbitrary chunks, pending-open close, permission/read/cancel errors, bounded writes and explicit reopen. Three real Chromium tests verify no automatic request, denial/unsupported handling and fragmented bytes parsed by the separate I/O Worker before clean disconnect. One in-flight acknowledged chunk, 4096-byte bound, 500 ms decoder timeout; UI reports at 150 ms intervals. Hardware HITL remains unavailable and unverified.

### TASK-049 — HIL sensor/actuator streaming

- **Status:** DONE — Claude; baseline b28c8c2; 2026-10-16 (fake-clock streaming verified; physical hardware is TASK-050/051).
- **Title & Description:** Send HIL_SENSOR/HIL_GPS and receive HIL_ACTUATOR_CONTROLS on real-time clocks.
- **Dependencies:** TASK-012, TASK-035, TASK-036, TASK-037, TASK-048.
- **Touched Files:** `packages/autopilot/src/hitl.ts`, `packages/autopilot/src/hil-clock.ts`, `tests/hil-stream.test.ts`, `packages/autopilot/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** IMU 200/400 Hz; GNSS 5/10 Hz; actuator mapping/signing/time.
- **DoD & Acceptance Criteria:** A 60 s fake real-time clock gives exact counts/bytes/timestamps; dropout/queue overflow fault; fields_updated matches observations; baud/10 serial budget retains at least 30% headroom.
- **Evidence:** Owner Claude; baseline b28c8c2; 2026-10-16. Node 24.22.0: tests/hil-stream.test.ts 17 PASS. Twelve 60 s runs on a fake real-time clock (SteppingPolicy hitl-realtime pumped every 1 ms) cover physics 400/800/1200 Hz x IMU 200/400 Hz x GNSS 5/10 Hz with mag 100 Hz and baro 50 Hz: tick counts 60*physicsHz, HIL_SENSOR 60*imuHz and HIL_GPS 60*gnssHz frames decoded by MavParser with zero CRC/unsupported errors, timestamps exactly k*1e6/rate microseconds, drained bytes equal emitted bytes, fields_updated has accel/gyro on every frame and mag/baro exactly on their schedules. Link budget: 400*77+10*51 = 31310 B/s, 460800 baud accepted (67.9%), 115200 and 230400 rejected for 400 Hz; queue overflow latches and reset clears; invalid observations are not emitted; actuator admission accepts strictly newer in-range frames (including u64 time across 2^32), rejects replay/older/out-of-range frames without touching output, and dropout latches after 100 ms. Mutations (mag flagged on every frame, no headroom requirement, no overflow check) fail 12, 1 and 1 tests. Remaining: no physical flight controller or serial hardware is exercised (TASK-050/051).

### TASK-050 — HITL firmware capability gate

- **Status:** DONE — Claude; baseline 0006e07; 2026-10-16 (gate implemented; HITL availability BLOCKED_EXTERNAL: no verified board profile).
- **Title & Description:** Verify board/build flags/message support before declaring HITL available.
- **Dependencies:** TASK-039, TASK-049.
- **Touched Files:** `packages/autopilot/src/hitl-capabilities.ts`, `docs/hardware/hitl-matrix.md`, `tests/hitl-capabilities.test.ts`, `docs/ru/hitl-matrix.md`, `docs/documentation-index.json`, `packages/autopilot/src/state-machine.ts`, `packages/autopilot/package.json`, `tests/autopilot-state.test.ts`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** Board/firmware SHA/HIL mode/MAVLink capability matrix.
- **DoD & Acceptance Criteria:** Unsupported HIL sensor/actuator paths cannot become READY; record a verified profile or exact BLOCKED_EXTERNAL requirement; SITL availability does not prove HITL support.
- **Evidence:** Owner Claude; baseline 0006e07; 2026-10-16. Source evidence inspected at pinned commits: ArduPilot 8ab6afde... (GCS_Common.cpp sha256 345233ce..., ArduCopter/ArduPlane MAVLink handlers, GCS.h, AP_InertialSensor.cpp: no HIL_SENSOR/HIL_GPS/HIL_ACTUATOR_CONTROLS handling; GPS via GPS_INPUT) and PX4 4d7e4de7... (mavlink_receiver.cpp sha256 2e22f0d3...: HIL_SENSOR only when HIL mode is enabled, HIL_GPS in HIL mode or with use_hil_gps; HIL_ACTUATOR_CONTROLS.hpp sha256 1ac5017c...: stream). Node 24.22.0: tests/hitl-capabilities.test.ts 6 PASS (no profile/observation gives BLOCKED_EXTERNAL with exact requirements regardless of SITL availability; ArduPilot UNSUPPORTED with three reasons even when verified and live; eight PX4 cases missing one piece of evidence each are BLOCKED_EXTERNAL with the matching requirement; full evidence gives a frozen issued READY; AutopilotSession refuses hitl without a verdict, with a BLOCKED verdict and with a forged READY literal, accepts it with an issued READY; profile parsing rejects 7 malformed inputs; matrix document contains the recorded commits and hashes) + tests/autopilot-state.test.ts updated to the stricter connect contract (2 PASS). Mutations (HIL flag not required, READY not registered, session accepts any verdict) fail 1, 2 and 1 tests. New bilingual pair docs/hardware/hitl-matrix.md + docs/ru/hitl-matrix.md registered; check:docs 11 pairs. Remaining: HITL availability itself is BLOCKED_EXTERNAL until a board profile is verified on hardware (TASK-051).

### TASK-051 — Physical HITL acceptance

- **Status:** TODO.
- **Title & Description:** Run a hardware bench and record transport/closed-loop integrity evidence.
- **Dependencies:** TASK-043, TASK-049, TASK-050.
- **Touched Files:** `scripts/bench-hitl.mjs`, `docs/hardware/hitl-test-procedure.md`, `docs/validation/hitl-report.schema.json`, `tests/hitl-report.test.ts`.
- **Interfaces / Contracts:** Board/firmware identity; timestamp jitter; sustained throughput; failsafe.
- **DoD & Acceptance Criteria:** Run 60 s sensor/actuator exchange; p99 sample scheduling lateness<=5 ms at 200 Hz or <=2.5 ms at 400 Hz; no overflow/unaccounted loss; unplug disables actuators; absent hardware is BLOCKED_EXTERNAL.

## Phase 4: EW & Sensor Faults

### TASK-052 — Hazard volumes

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Compute bounded exposure for spheres, cones, and combinations.
- **Dependencies:** TASK-010, TASK-032.
- **Touched Files:** `packages/ew/package.json`, `packages/ew/src/volumes.ts`, `tests/ew-volumes.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `package-lock.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** SPECS_SIMULATION_ENGINES section 5; r_min, relative power, angular taper.
- **DoD & Acceptance Criteria:** Test center/boundaries/cone axis/summation order; r=0 remains finite; outside exposure is zero; capacity<=64 and no per-step allocation.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Two numerical tests cover inverse-square exposure, finite center, radius/cone boundaries, axis/taper, canonical ID order, duplicate/capacity rejection and immutable typed-array inputs. <=64 volumes and saturation 1e12 are enforced; severityFromNedInto passes all three G1 frequencies. Exposure is dimensionless synthetic training severity, not a measured RF link budget.

### TASK-053 — GNSS jamming

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Implement training severity-to-satellite/DOP/fix behavior with hysteresis.
- **Dependencies:** TASK-035, TASK-052.
- **Touched Files:** `packages/ew/src/gnss-jamming.ts`, `tests/gnss-jamming.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `packages/mavlink/src/samples.ts`, `scripts/bench-links-ew.mjs`, `tests/sensor-samples.ts`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** GpsSample; filtered q; Njam 0..3 and DOPjam 50..99.
- **DoD & Acceptance Criteria:** q=0 preserves the baseline; strong jamming removes fix; recovery thresholds are correct; no NaN/sentinel overflow; IMU/truth stay unchanged.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Three tests verify analytic exponential filtering, zero/reset identity, strong-jam no-fix, 0.8/0.6 hysteresis, known-satellite recovery and unknown/degraded baseline preservation. Source GPS is unchanged; IMU/barometer/truth are not inputs. advanceInto/distortInto pass all three G1 frequencies. No packet-loss, physical receiver or ArduPilot mode-response claim.

### TASK-054 — Position-step spoofing

- **Status:** DONE — Claude; baseline 91579b7; 2026-10-16.
- **Title & Description:** Apply GPS displacement atomically at a specified tick.
- **Dependencies:** TASK-010, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/position-step.ts`, `tests/position-step.test.ts`, `packages/ew/package.json`, `packages/sensors/src/geodesy.ts`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** offsetNedM; immutable source; WGS84 conversion before wire encoding.
- **DoD & Acceptance Criteria:** Position changes by the offset within geodesy tolerance; preserve baseline velocity; test zero/disable/reset, altitude Down sign, and antimeridian behavior.
- **Evidence:** Owner Claude; baseline 91579b7; 2026-10-16. Oracle: the corrupted fix minus the source fix, expressed in the source's tangent frame (validated against the independent Python WGS84 fixture in TASK-036), must equal the commanded offset within 1 mm. Node 24.22.0: tests/position-step.test.ts 5 PASS (no change before the scheduled tick and an atomic 3-axis step at it with velocity/time/DOP/fix/course preserved; +10 m Down lowers MSL by 10 m; a 9998 m offset within 1 mm and a 10000.03 m offset rejected; east 3 km across the antimeridian wraps longitude into [-pi, pi); 1.5 km north across the pole; zero offset is exact identity, disable/reset restore the baseline, the source is never mutated, invalid sources and schedules are rejected; MSL converts through a synthetic geoid grid so a pure Down step changes H by exactly -D). LocalTangentFrame gained an allocation-free setOrigin; geodesy.test.ts 8 PASS unchanged. Mutation (geoid undulation ignored on input) fails 1 test.

### TASK-055 — Coherent drift

- **Status:** DONE — Claude; baseline 263ce7a; 2026-10-16.
- **Title & Description:** Integrate position/velocity bias on the physics clock with a speed cap and recovery policy.
- **Dependencies:** TASK-011, TASK-036, TASK-052.
- **Touched Files:** `packages/ew/src/velocity-drift.ts`, `tests/velocity-drift.test.ts`, `packages/ew/package.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** b/v/a equations in section 5; hold-offset versus step-to-truth.
- **DoD & Acceptance Criteria:** Constant-acceleration analytic fixtures pass; piecewise speed limiting preserves position/velocity consistency; GPS/render rates do not change state; no promise of bypassing EKF gates.
- **Evidence:** Owner Claude; baseline 263ce7a; 2026-10-16. Oracle: closed-form kinematics, independent of step size. Node 24.22.0: tests/velocity-drift.test.ts 12 PASS (b = a t^2/2 and v = a t for 30 s at 400/800/1200 Hz within 1e-8 m and 1e-10 m/s; speed cap at |a| = 0.3, cap 2 m/s with t_c = 6.667 s inside a step at every rate matches 0.5|a|t_c^2 + cap (t - t_c) within 1e-8 m and |v| = cap within 1e-12; per-step b increments bracketed by v_start dt and v_end dt across the cap; hold-offset reaches holding with the stopping distance v^2/(2 decel) and then holds exactly; step-to-truth zeroes state and counts the discontinuity; GPS sampled at 10 Hz versus 5 Hz plus three render reads per step gives bit-identical state; corrupted velocity (1, 1, 0) gives course pi/4 and drift moves the fix east; course unknown below 0.05 m/s; invalid presets/dt rejected; drift holds at the 10 km envelope). Mutations (clip velocity after an unsplit step, stop instantly on recovery) fail 4 and 1 tests. No EKF-gate outcome is claimed.

### TASK-056 — Magnetic anomalies

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Distort magnetic vectors in the correct sensor/body frame.
- **Dependencies:** TASK-034, TASK-052.
- **Touched Files:** `packages/ew/src/magnetic.ts`, `tests/magnetic-anomaly.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** Rz*Ry*Rx plus biasBodyGauss; truth quaternion is unchanged.
- **DoD & Acceptance Criteria:** Zero anomaly is identity; synthetic 90-degree rotations preserve norm; test bias units; truth/gyro stay unchanged; reject source/target aliasing.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Magnetic test verifies identity, synthetic 90-degree body rotations/norm, gauss bias, unchanged source and overlapping-view rejection. Rz*Ry*Rx is precomputed outside stepping; all three G1 frequencies pass. Truth/gyro are not accepted inputs; no guaranteed toilet-bowling/EKF response.

### TASK-057 — Motor faults

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Inject failures by stable motor ID without modifying the GPS truth path.
- **Dependencies:** TASK-010, TASK-025, TASK-027.
- **Touched Files:** `packages/physics/src/motor-fault.ts`, `tests/motor-fault.test.ts`, `native/bet/tests/motor_failure.rs`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `scripts/bench-links-ew.mjs`, `packages/physics/package.json`, `tests/links-ew-allocation.test.ts`.
- **Interfaces / Contracts:** power-cut versus synthetic instant-thrust-loss; remainingThrustFraction.
- **DoD & Acceptance Criteria:** Power-cut preserves passive drag/spool decay; instant fault removes the selected force in that tick and sets synthetic validity; leave other motors unchanged; verify moment arms.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Two TypeScript tests verify stable IDs, selected-only power/force changes, preserved passive wrench, varying torque arrays, reset and ModelOutsideValidity bit 5. Native motor_failure test verifies nonzero passive spool decay after zero drive and the selected lever-arm moment. All three G1 frequencies pass. Power-cut and synthetic instant-thrust-loss remain distinct; full BET/mixer compensation flight testing is not claimed.

### TASK-058 — EW pipeline composition

- **Status:** DONE — Claude; baseline c57bc60; 2026-10-16.
- **Title & Description:** Compose effects, fault registry, and deterministic command application.
- **Dependencies:** TASK-053, TASK-054, TASK-055, TASK-056, TASK-057.
- **Touched Files:** `packages/ew/src/engine.ts`, `packages/sensors/src/pipeline.ts`, `tests/ew-pipeline.test.ts`, `packages/ew/src/gnss-jamming.ts`, `packages/ew/src/magnetic.ts`, `packages/ew/src/position-step.ts`, `packages/ew/src/velocity-drift.ts`, `packages/ew/package.json`, `packages/sensors/src/geodesy.ts`, `packages/sensors/src/geoid.ts`, `packages/sensors/package.json`, `package-lock.json`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** EwEngine; GpsSample/ImuSample; ew_flags; effect precedence.
- **DoD & Acceptance Criteria:** Order is baseline to step/drift to jamming to quantization; magnetometer is independent; faults/reset compose consistently; truth stays bit-identical; identical seed/event log yields identical packets.
- **Evidence:** Owner Claude; baseline c57bc60; 2026-10-16. Node 24.22.0: tests/ew-pipeline.test.ts 6 PASS (step 300/-200/5 m plus 10 s of drift equals one WGS84 application of the summed offset, drift velocity added, then jamming sets fix 0, 1 satellite, HDOP 99, and the HIL_GPS payload equals SensorMapping of the distorted sample; GNSS faults leave the magnetometer unchanged while a yaw-90 deg anomaly maps (x, y) to (-y, x) plus bias with accel/gyro/baro untouched and GPS unaffected; registry replacement, non-owner disable, motor-loss forwarded to MotorFaults (torque 2 to 0.5 and back), 16-slot capacity with registry-full, reset clears flags/motors and records the seed, motor-loss without MotorFaults rejected; truth array, context and baseline samples bit-identical after 2000 steps; identical seed and command log through ControlProcessorV2 give identical HIL_GPS payload bytes and flags over 4000 ticks; 1e6-step windows with all five effects active, IMU at 200 Hz and GNSS at 10 Hz through the pipeline: at least one of up to three windows must be GC-free after warm-up, which a per-step allocation cannot satisfy (16 MB per window); standalone runs read 0 GC in the first window, and one stray GC appeared once under full-suite parallel load) + 32 regression PASS across geodesy, step, drift, jamming, magnetic and links-ew allocation suites. The GC check initially failed (5 GCs per 1e6 steps); a per-stage probe traced it to float arguments boxed by non-inlined calls (drift integrate/speed, tangent-frame and geoid calls, dt arguments), fixed with typed-array/field-based variants; all stages then read 0. Mutations (non-owner disable releases the effect, magnetic anomaly applied to the accelerometer, one object allocated per step: 14/13/13 GCs in three windows) fail 1, 2 and 1 tests.

### TASK-059 — EKF scenario regressions

- **Status:** TODO.
- **Title & Description:** Measure ArduPilot responses to EW/mechanical faults without promising a hard-coded mode.
- **Dependencies:** TASK-042, TASK-043, TASK-058.
- **Touched Files:** `tests/integration/ew-sitl.test.ts`, `tests/fixtures/scenarios/ew-matrix.json`, `scripts/report-ekf.mjs`.
- **Interfaces / Contracts:** Innovation/status/mode/trajectory AAR trace; pinned EKF parameters.
- **DoD & Acceptance Criteria:** Run a no-fault control and every fault; traces show changed observations and actual EKF responses; freeze version-specific envelopes; unexplained responses require investigation rather than silent PASS.

## Phase 5: Environment & Shaders

### TASK-060 — Provider and license policy

- **Status:** DONE — Codex; baseline dfbf402; 2026-10-16.
- **Title & Description:** Separate Google live tiles from cacheable owned/licensed datasets before implementing caches.
- **Dependencies:** TASK-003, TASK-005.
- **Touched Files:** `packages/terrain/package.json`, `packages/terrain/src/provider-policy.ts`, `docs/decisions/terrain-licensing.md`, `tests/terrain-policy.test.ts`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`, `docs/SPECS_SIMULATION_ENGINES.md`, `docs/ru/SPECS_SIMULATION_ENGINES.md`, `docs/architecture.md`, `docs/ru/architecture.md`, `README.md`, `docs/ru/README.md`, `CLAUDE.md`, `docs/ru/CLAUDE.md`, `docs/ru/terrain-licensing.md`, `docs/documentation-index.json`, `package-lock.json`.
- **Interfaces / Contracts:** ProviderPolicy {attribution, allowedCache, ttl, offline, datasetLicense}.
- **DoD & Acceptance Criteria:** Google persistent R2/prefetch is denied by default; authorization requires evidence; unknown policy fails closed; fixtures need no API key; paid API access does not establish an offline license.

- **Execution scope:** Goal: implement the declared contract with independent numerical/protocol or lifecycle tests. Failure criterion: any contract, allocation, provenance or lifecycle check fails. External hardware/provider acceptance remains separate.

- **Evidence (2026-10-16):** Policy test rejects unknown providers and Google persistence/prefetch/offline, requires attribution/license and reviewed permission-evidence hashes for licensed dataset caching, and checks immutable validated policy. Google TTL 0 grants no application retention. English/Russian terrain-licensing decision registered; no API key, live request, cache implementation or deployment required.

### TASK-061 — Tiles streaming adapter

- **Status:** DONE — Claude; baseline 89b46f1; 2026-10-16 (local fixture verified; live Google tiles BLOCKED_EXTERNAL on TASK-063 and credentials).
- **Title & Description:** Connect one chosen 3D Tiles loader to R3F using a local licensed fixture.
- **Dependencies:** TASK-015, TASK-036, TASK-060.
- **Touched Files:** `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `apps/web/src/FlightScene.tsx`, `tests/tiles-provider.test.ts`, `tests/browser/terrain.spec.ts`, `packages/terrain/package.json`, `apps/web/src/App.tsx`, `apps/web/src/terrain-config.ts`, `apps/web/src/style.css`, `apps/web/package.json`, `package-lock.json`, `tests/support/terrain-harness.ts`, `tests/fixtures/tiles/generate.py`, `tests/fixtures/tiles/tileset.json`, `tests/fixtures/tiles/tile.glb`, `tests/fixtures/registry.json`, `docs/architecture.md`, `docs/ru/architecture.md`, `docs/PROJECT_ROADMAP.md`, `docs/ru/PROJECT_ROADMAP.md`.
- **Interfaces / Contracts:** 3D Tiles transforms; ECEF/local origin; attribution; abort/dispose.
- **DoD & Acceptance Criteria:** Load/place the fixture; canceled requests release resources; show CORS/COEP failures; missing Google credentials block live integration while local checks continue.
- **Evidence:** Owner Claude; baseline 89b46f1; 2026-10-16. Loader 3d-tiles-renderer 0.5.3 (Apache-2.0, published 2026-09-18) pinned in packages/terrain; lockfile adds only it and its pbf/pmtiles/vector-tile helpers. Fixture: own-work CC0 3D Tiles 1.1 tileset (tests/fixtures/tiles/generate.py: 200 m grid with a 20 m marker, ENU-to-ECEF root transform at 47.3769N 8.5417E 400 m), both files registered. Node 24.22.0: tests/tiles-provider.test.ts 7 PASS (Google live without the proxy BLOCKED_EXTERNAL and local licensed READY; wrong policy/URL blocked; placement maps the Python-written ENU basis to render (100,0,0)/(0,20,0)/(0,0,-100) within 1e-6 m; dispose aborts in-flight requests without recording failures and rejects later requests; the loader's own signal is relayed; TypeError classified cors-or-network and 404 http with CORS mode and omitted credentials; GLB header and CC0 provenance; app config off by default, parses a local tileset, blocks four malformed settings). Chromium: tests/browser/terrain.spec.ts 2 PASS (the real loader loads the fixture: bounding box (-100,0,-100)..(100,20,100) and north-east corner at render (100,0,-100) within 1 cm, geometry uploaded, every geometry/material disposed, 0 in flight and 0 models after dispose, attribution kept; an unreachable cross-origin tileset is reported as cors-or-network). Mutations (north row flipped, dispose skips the loader, TypeError not classified) fail the unit and/or browser tests. Build: the pre-existing chunk-size warning is unchanged in kind (origin/main main chunk 1100.55 kB, now 1103.36 kB); the loader is a separate on-demand 114 kB chunk and the threshold was not raised. Remaining: live Google 3D Tiles BLOCKED_EXTERNAL (TASK-063 proxy and provider credentials).

### TASK-062 — LOD and GPU budgets

- **Status:** DONE — Claude; baseline ea69c6a; 2026-10-16 (synthetic budgets verified; real-GPU residency and target-device frame time open).
- **Title & Description:** Bound terrain network, decoding, and GPU workloads.
- **Dependencies:** TASK-061.
- **Touched Files:** `packages/terrain/src/lod-budget.ts`, `packages/terrain/src/resource-cache.ts`, `tests/terrain-budget.test.ts`, `packages/terrain/src/tiles-scene.ts`, `packages/terrain/package.json`, `tests/support/terrain-harness.ts`, `tests/browser/terrain.spec.ts`.
- **Interfaces / Contracts:** Bounded request queue; CPU/GPU byte accounting; SSE limits.
- **DoD & Acceptance Criteria:** Synthetic flythrough respects <=2 GiB estimated terrain GPU residency and <=512 MiB decoded CPU cache; eviction disposes resources; idle queues do not grow; degradation is deterministic.
- **Evidence:** Owner Claude; baseline ea69c6a; 2026-10-16. Node 24.22.0: tests/terrain-budget.test.ts 12 PASS. Unit cases: estimators; LodBudget defaults (2 GiB / 512 MiB), invalid options, coarsening on either budget, saturation at 256 px, predictive recovery after 30 calm frames (an over-budget or above-prediction frame restarts the run); RequestQueue priority/age order, duplicates, active cap, drop/displace; cache LRU eviction, hard-cap refusal with dispose and per-frame demand. Seeded flythrough (mulberry32 seeds 0x5eed and 7; 400 frames at 30 m/frame then 200 hover frames; 2 km view radius; 12..36 MiB tiles, finest level ~30 GiB): max GPU <= 2 GiB and CPU <= 512 MiB on every frame while refusals, evictions and coarsening occur; every created resource disposed exactly once; queue <= 256; queue and active downloads drain within 60 hover frames and stay empty with constant residency and target; identical traces for the same seed, different for another. Mutations killed: no hard cap, no dispose on remove, eviction of visible tiles, non-predictive recovery, calm run not reset on over-budget frames, denied demand not reset, reversed tie order (an unguarded admission loop hangs and was killed by timeout). TilesScene caps the loader LRU at min(budgets) and drives errorTarget; tests/browser/terrain.spec.ts (Chromium) checks a 512 MiB cap, a non-zero cached estimate and SSE 16 for the fixture. Gates: see commit. Real-GPU residency and target-device frame-time evidence remain open (cloud software GPU).

### TASK-063 — Cloudflare tiles proxy

- **Status:** DONE — Claude; baseline e9ad0f3; 2026-10-16 (local Worker tests; deployment and live provider credentials need separate authorization).
- **Title & Description:** Build an authenticated proxy with quotas, attribution/CORS, and permitted TTLs.
- **Dependencies:** TASK-060, TASK-061.
- **Touched Files:** `services/tiles-worker/package.json`, `services/tiles-worker/wrangler.jsonc`, `services/tiles-worker/src/index.ts`, `services/tiles-worker/src/policy.ts`, `tests/tiles-proxy.test.ts`, `packages/terrain/src/tiles-provider.ts`, `packages/terrain/src/tiles-scene.ts`, `tsconfig.json`.
- **Interfaces / Contracts:** ProviderPolicy; opaque upstream secret binding; origin/session verification.
- **DoD & Acceptance Criteria:** Local Worker tests verify no key reaches clients/logs, invalid origin/session/quota rejection, and provider restrictions; deployment needs separate authorization and is not implied by local success.
- **Evidence:** Owner Claude; baseline e9ad0f3; 2026-10-16. Node 24.22.0: tests/tiles-proxy.test.ts 10 PASS with a fake upstream and fake Durable Object storage (no live provider request, no deployment). Cases: configuration fails closed (missing key, short signing key, empty/non-HTTPS/path origins, invalid JSON, persistent Google policy, licensed policy, TTL bounds) and answers 503 without upstream calls; missing/foreign Origin 403, preflight 204 with the session header; missing, tampered, malformed, cross-origin, expired and foreign-key sessions 401 before any upstream request; forwarding adds the key only upstream, keeps only Google's session parameter, strips set-cookie, sets CORS/CORP, Cache-Control no-store (TTL 0) and attribution; HEAD has no body; foreign paths, traversal, double slashes, client keys, extra or duplicate parameters and non-GET methods rejected; upstream 403 body containing the key returns a generic 503, a JSON body echoing the key is blocked with 502, and an upstream exception returns 502; per-session request and per-IP issuance quotas return 429 and reset after the window; client requestTilesSession validation and TileFetchTracker session header end-to-end. After all tests, no response body/header or log event contains the key (>20 of each observed). Mutations killed: forwarding arbitrary parameters, disabled key-leak check, origin binding, expiry, off-by-one quota, echoed upstream errors, disabled origin check, missing upstream key, quota window reset, TTL cache policy. wrangler.jsonc binds secrets by name only; deployment, a live key and Turnstile-style human verification remain external.

### TASK-064 — R2 for permitted datasets

- **Status:** DONE — Claude; baseline f35efe6; 2026-10-16 (emulator tests; R2 binding and persistent caching need explicit permission).
- **Title & Description:** Cache 10–15 km regions only for content whose license permits it.
- **Dependencies:** TASK-062, TASK-063.
- **Touched Files:** `services/tiles-worker/src/r2-cache.ts`, `packages/terrain/src/region-manifest.ts`, `tests/r2-cache.test.ts`, `tests/support/memory-r2.ts`, `packages/terrain/package.json`.
- **Interfaces / Contracts:** Dataset hash/license; cache key/version/TTL; region manifest; deny Google unless explicitly authorized by a lawful policy.
- **DoD & Acceptance Criteria:** Local R2 emulator tests hit/miss/expiry/eviction; enforce byte/quota caps and 10/15 km radius; cacheable=false never writes; missing rights/data explicitly block the provider.
- **Evidence:** Owner Claude; baseline f35efe6; 2026-10-16. Node 24.22.0: tests/r2-cache.test.ts 8 PASS against tests/support/memory-r2.ts (in-memory emulator of the R2 binding subset with paginated listing; not Miniflare). Cases: manifest structure, radius 10/15 km bounds, duplicate/traversal paths, tile hash/size, unknown fields and policy validation; dataset hash mismatch rejected; decisions (Google BLOCKED even with evidence, missing evidence BLOCKED, null hash or empty index BLOCKED, cacheable=false / memory-only / TTL 0 NO_CACHE); WGS84 distance (0.1 deg latitude at 47.4 deg = 11.09..11.14 km); miss -> store -> hit without an origin call, expiry after TTL deletes and refetches, key layout and metadata; 3000-byte cap holds with oldest eviction and replacement of an existing key; no writes outside 10 km (written within 15 km), for unlisted tiles, hash mismatches (not served) or cacheable=false (0 puts over repeated reads); blocked manifests neither fetch nor write; cache versions isolated. Mutations killed: radius check, expiry, expired delete, byte cap, hash check, NO_CACHE write guard, Google rule, cacheable flag, radius bound, pagination, versioned prefix, empty index. No R2 bucket is bound; persistent caching needs explicit permission, and no dataset with reviewed rights is registered yet.

### TASK-065 — Collision terrain LOD

- **Status:** TODO.
- **Title & Description:** Build collision chunks independently of visuals and swap them at tick boundaries.
- **Dependencies:** TASK-029, TASK-061, TASK-062.
- **Touched Files:** `packages/terrain/src/collision-builder.worker.ts`, `packages/terrain/src/collision-chunks.ts`, `tests/terrain-collision.test.ts`.
- **Interfaces / Contracts:** Immutable versioned collision chunks; local origin; readiness around the vehicle.
- **DoD & Acceptance Criteria:** Visual eviction retains active ground; seam/drop tests pass; incomplete ground explicitly limits/pauses flight; heavy decoding never runs in the physics Worker.

### TASK-066 — WebGPU renderer capability

- **Status:** DONE — Claude; baseline 60ba4cf; 2026-10-16 (WebGL2 path, fallbacks and lifecycle verified; WebGPU rendering skipped with reason here: no functional adapter, so the WebGPU path awaits a GPU browser run).
- **Title & Description:** Add a renderer adapter with WebGL2 fallback and resource lifecycle.
- **Dependencies:** TASK-005, TASK-061.
- **Touched Files:** `apps/web/src/render/renderer.ts`, `apps/web/src/render/webgpu.ts`, `tests/browser/render-backends.spec.ts`, `apps/web/src/FlightScene.tsx`, `tests/support/render-harness.ts`.
- **Interfaces / Contracts:** Common scene/material capabilities; browser chooses Metal/DX backend.
- **DoD & Acceptance Criteria:** Available modes run; unsupported modes are skipped with a reason, not passed; shader failures fall back; switching releases all resources.
- **Evidence:** Owner Claude; baseline 60ba4cf; 2026-10-16. Chromium (Playwright 1.56.1, SwiftShader; spec flags add --enable-unsafe-webgpu --use-webgpu-adapter=swiftshader): tests/browser/render-backends.spec.ts 5 passed, 1 skipped. WebGL2 renders a lit textured box (non-background centre pixel), info.memory drops to 0 geometries/textures after releasing 1 geometry/material/texture, context lost after dispose; a broken ShaderMaterial is detected from the shader log and replaced by the magenta fallback, which is drawn; a requested WebGPU backend falls back to WebGL2 with the exact reason; switching renderers releases each before the next; the app honours ?renderer=webgl2|webgpu and exposes backend and fallback reason on the canvas. SKIPPED with reason: "WebGPU unavailable: WebGPU adapter "google swiftshader" is not functional: device lost: A valid external Instance reference no longer exists." (the software adapter loses its device on first canvas presentation). The WebGPU render path, its validation scope, and the injected-probe fallback with an available adapter remain unverified until a browser with a functional WebGPU adapter runs this spec. Mutations killed: shader failure ignored, textures not disposed, context not lost, backend attribute from the request instead of the result.

### TASK-067 — FPV camera and fisheye

- **Status:** DONE — Claude; baseline 778ee75; 2026-10-16 (WebGL2 verified; WebGPU fisheye not implemented: the pass is a WebGL ShaderMaterial).
- **Title & Description:** Separate mounted FPV pose/projection and lens distortion from the external camera.
- **Dependencies:** TASK-015, TASK-066.
- **Touched Files:** `packages/cameras/package.json`, `packages/cameras/src/fpv-camera.ts`, `packages/cameras/src/shaders/fisheye.glsl`, `tests/fisheye.test.ts`, `tests/browser/fpv.spec.ts`, `packages/cameras/src/fisheye.ts`, `packages/cameras/src/fisheye-material.ts`, `tests/support/fpv-harness.ts`, `package-lock.json`.
- **Interfaces / Contracts:** CameraConfig {fov, mount FRD, distortion}; immutable truth.
- **DoD & Acceptance Criteria:** Zero distortion is identity; optical-center/radial fixtures and analytic projection/resize tests pass; edge coordinates stay finite; no truth mutation.
- **Evidence:** Owner Claude; baseline 778ee75; 2026-10-16. Node 24.22.0: tests/fisheye.test.ts 11 PASS: model none is the exact identity with the output-derived source camera; equidistant k=0 at 120 deg maps 30 deg to u=0.75 and vertical by the pixel aspect (closed form); for k=0 and k=(0.08,-0.015,0.002,-0.0003) every ray (theta 0.5..60 deg, six azimuths) inverts onto the source UV where a three.js PerspectiveCamera with the derived FOV/aspect projects it, within 1e-9; principal-point offset (20,-10) px puts the optical axis there with radial symmetry; resize keeps horizontal FOV; outputs finite on a 121x121 grid including 10% beyond the edges, with the whole frame covered; non-monotonic lenses, 170 deg and invalid sizes rejected. FpvCamera: north/east forward axes, centre projection of a point 10 m ahead, 30 deg uptilt, rotated mount offset, roll +90 deg right vector, q/-q equivalence, frozen pose unchanged, invalid quaternion ignored, resize. Chromium WebGL2 (SwiftShader): tests/browser/fpv.spec.ts 3 PASS, fisheye.glsl against the CPU mirror on 96x72 via a coordinate-encoding texture: 0 of 6912 pixels mismatched in each case (worst error 0, 1 and 1 texel; declared tolerance 1 texel on <= 1% of pixels, 0 for the identity). Mutations killed: uptilt sign, unrotated offset, mount composition order, invalid-quaternion guard, Newton steps, principal-point axis, pixel aspect, 80 deg limit, derivative coefficient; shader: one Newton step, swapped source focal axes, scaled radius.

### TASK-068 — Analog interference and jelly

- **Status:** DONE — Claude; baseline 7478d6f; 2026-10-16 (WebGL2 verified; tolerances backend-specific; WebGPU variant not implemented).
- **Title & Description:** Add seeded video noise, scanlines, and rolling-shutter deformation.
- **Dependencies:** TASK-067.
- **Touched Files:** `packages/cameras/src/analog.ts`, `packages/cameras/src/shaders/analog.glsl`, `tests/analog-noise.test.ts`, `tests/browser/analog.spec.ts`, `packages/cameras/src/analog-material.ts`, `packages/cameras/package.json`, `tests/support/analog-harness.ts`.
- **Interfaces / Contracts:** VideoNoiseConfig; throttle-decimated uniforms; independent visual RNG.
- **DoD & Acceptance Criteria:** Equal seed/time gives the same frame; throttle affects rendering only; no CPU pixel loops/per-frame allocation; image tolerances are backend-specific, not cross-GPU pixel equality.
- **Evidence:** Owner Claude; baseline 7478d6f; 2026-10-16. Node 24.22.0: tests/analog-noise.test.ts 7 PASS: lowbias32 matches an independent Python implementation on 5 vectors; frame seed = hash(seed ^ hash(k)) with Python reference values, unaffected by throttle, 10000 distinct frame seeds; 60 Hz and 144 Hz render loops produce identical per-video-frame uniforms (300 frames); throttle sampled once per video frame and mapped to noise/jelly/vibration frequency, NaN -> 0, clamped; frozen input unchanged and no method accepts physics state; invalid configs rejected; 1e6 updateFrom calls with one GC-free window of three. Chromium WebGL2 (SwiftShader): tests/browser/analog.spec.ts 5 PASS: all effects off reproduces the source exactly; equal seed and video frame give byte-identical frames from separate renderers, the next video frame or another seed differ; noise standard deviation 2.9 / 17.7 levels within 20% at throttle 0 / 1; a vertical line stays straight without vibration and bends by >= 6 px (<= 5 px from centre) at full throttle; scanlines leave one-line-per-row images unchanged and give 73.3 / 118.7 row means at 24 lines with a four-row period. Mutations killed: no frame decimation, frame-count seed, unclamped throttle, throttle-independent jelly, uninitialised ScalarUniform field (GC test), frame-independent pixel noise, no line exposure time, halved noise. Tolerances are for this backend only.

### TASK-069 — WorldCover/OSM material map

- **Status:** DONE — Claude; baseline e67236d; 2026-10-16 (synthetic georeferenced raster; real-tile check needs locally placed licensed data and GeoTIFF decoding).
- **Title & Description:** Load licensed land classes and map features with provenance.
- **Dependencies:** TASK-036, TASK-060, TASK-061.
- **Touched Files:** `packages/thermal/package.json`, `packages/thermal/src/material-map.ts`, `packages/thermal/src/data-manifest.ts`, `tests/material-map.test.ts`, `tests/fixtures/thermal/material-classes.json`, `tests/fixtures/registry.json`, `package-lock.json`.
- **Interfaces / Contracts:** 10 m raster labels; road/roof overlays; attribution/hash/coordinate system.
- **DoD & Acceptance Criteria:** Known coordinates map correctly; missing data is labeled synthetic; land classes are not temperatures; preserve attribution/licenses without unauthorized bulk downloads.
- **Evidence:** Owner Claude; baseline e67236d; 2026-10-16. Node 24.22.0: tests/material-map.test.ts 9 PASS. Legend fixture tests/fixtures/thermal/material-classes.json (registered) covers all 11 WorldCover v200 codes; a temperatureK or emissivity field is rejected. Manifest: provider license/attribution rules, required SHA-256 for real providers, synthetic labelling, CRS, bounds and duplicate ids enforced; tile names N45E006/S03W060/N00E000/S03W003/N48E009; a 15 km Zurich plan needs 1 tile, a 48N/9E straddle 4, a 10x10 deg plan is refused. Map on a synthetic 12x12 raster on the real 1/12000 deg grid: all 143 pixel centres and north-west corner/edge points map to the expected code; no-data and out-of-layer points return synthetic-ground with synthetic=true; synthetic layers stay synthetic; buildings over roads over land, roof:material=metal -> roof-metal, residential road at 2.9 m asphalt and 3.2 m not, footway ignored; samples carry no thermal field; unregistered/wrong-provider layers, bound mismatches and unknown codes rejected; package source contains no network code. Mutations killed: rounded pixel row, no-data ignored, double road width, buildings skipped, synthetic flag dropped, license check, bulk-plan limit, tile name truncation, attribution tracking. Remaining: no real WorldCover tile or OSM extract is committed or downloaded; GeoTIFF/OSM decoding and a real-coordinate check need locally placed licensed data.

### TASK-070 — Surface thermal state

- **Status:** DONE — Claude; baseline 9a67a2b; 2026-10-16 (numerical model verified; measured validation pending without data).
- **Title & Description:** Integrate material temperatures from solar forcing/weather outside the shader.
- **Dependencies:** TASK-032, TASK-069.
- **Touched Files:** `packages/thermal/src/heat-balance.ts`, `packages/thermal/src/solar.ts`, `tests/thermal-energy.test.ts`, `packages/thermal/package.json`, `package-lock.json`.
- **Interfaces / Contracts:** C*dT/dt=absorbedSolar-convection-radiation-conduction; emissivity/inertia.
- **DoD & Acceptance Criteria:** Test night equilibrium/sunrise/shadows/energy units and timestep convergence; AO affects only an explicit radiative model, not a substitute heat solver; measured validation remains pending without data.
- **Evidence:** Owner Claude; baseline 9a67a2b; 2026-10-16. Node 24.22.0: tests/thermal-energy.test.ts 10 PASS. Solar: NREL SPA reference (2003-10-17 19:30:30 UTC, 39.742476 N 105.1786 W) zenith and azimuth within 0.05 deg; solstice declinations +-23.44 deg; night irradiance 0; DNI monotonic in zenith, below 1.035 S0, AM60/AM1 ratio 0.8 per Meinel; full overcast keeps 25%; Swinbank 0.764 at 288.15 K. Heat balance against the equation written independently in the test: 48 h night run reaches the bisection equilibrium within 0.005 K and below air temperature, overcast > 1 K warmer; flux components in W/m^2 sum to the net; C dT equals accumulated energy in J/m^2; error vs a 1 s reference falls > 3x per halving of 600/300/150 s and stays < 0.01 K at 150 s; a stiff metal roof stays within 0.05 K at 600 s through automatic substeps; Zurich solstice: sunrise 03:xx UTC, minimum within 90 min after it, sunlit > half-shaded > shaded (> 5 K apart), south wall cooler than the roofless horizontal; occlusion changes nothing for radiatively inert surfaces and warms an occluded emitting surface; ISA-derived air temperature; 1000 elements x 1000 steps with one GC-free window. Mutations killed: equation of centre, equation of time, Meinel exponent, convection, Heun predictor, substepping, sky-view in longwave, shadow, energy accumulation. Remaining: properties are typical uncalibrated values; measured surface-temperature validation pending without data.

### TASK-071 — Thermal renderer

- **Status:** DONE — Claude; baseline 88b1382; 2026-10-16 (WebGL2 verified; synthetic profile only, no CADEX parity claimed).
- **Title & Description:** Map thermal states to radiance/palettes with atmospheric attenuation.
- **Dependencies:** TASK-066, TASK-070.
- **Touched Files:** `packages/thermal/src/thermal-camera.ts`, `packages/thermal/src/shaders/thermal.glsl`, `tests/thermal-camera.test.ts`, `tests/browser/thermal.spec.ts`, `packages/thermal/src/thermal-material.ts`, `packages/thermal/package.json`, `tests/support/thermal-harness.ts`, `package-lock.json`.
- **Interfaces / Contracts:** InstrumentProfile {resolution, spectralResponse, noise, calibrationSource}; synthetic training profiles are separate from CADEX measurements.
- **DoD & Acceptance Criteria:** Test blackbody monotonicity, emissivity/reflection/distance attenuation, and cold/hot palette endpoints; configurable native resolution; do not claim CADEX parity without profile data.
- **Evidence:** Owner Claude; baseline 88b1382; 2026-10-16. Node 24.22.0: tests/thermal-camera.test.ts 6 PASS: the band integral over 0.2-2000 um equals sigma T^4 / pi within 0.1% at 250/300/400 K; Wien peak; LWIR 8-14 um radiance strictly increasing over 150-405 K; table interpolation within 0.02% of the exact integral; emissivity 1/0/0.4 give emission, reflection and their mix; Beer-Lambert attenuation decreases monotonically towards the path radiance; span endpoints map to levels 0 and 1; white-hot/black-hot/ironbow endpoints and non-decreasing ironbow luminance; synthetic profile never claims CADEX parity, measured profiles need a calibration hash. Chromium WebGL2 (SwiftShader): tests/browser/thermal.spec.ts 4 PASS: thermal.glsl on a 64x48 float G-buffer (255-335 K, emissivity 0.5-1, 0-5 km) matches the CPU mirror with 0 pixels beyond 2/255 in all palettes, rendered at the profile's native 64x48 resolution; cold/hot palette endpoints exact. Mutations killed: Planck exponent, reflection term, second radiation constant, measured-profile validation; shader: no attenuation, no table interpolation, ironbow control point. Remaining: no measured instrument profile; CADEX parity not claimed; WebGPU variant not implemented.

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


## Verified transport and fault batch (2026-10-16)

Owner Codex; baseline dfbf402. TASK-037/038/039/040/048/052/053/056/057/060
are DONE within their software/module scope. The earlier blocked TASK-029/030/
031/033 remain open. No physical transmitter/FC, measured model, target GPU,
Google live tiles or complete SITL/HITL flight is certified by this batch.

Exit 0: frozen npm ci, lint, typecheck, build, check:docs; 266 unit tests in
48 files, 21 Chromium browser tests, 46 native Rust tests and bridge CLI startup.
Fresh reports test-results/unit/junit.xml and test-results/browser/junit.xml
have zero failures/errors/skips. Browser test uses real Worker/SAB/MAVLink I/O
Worker plus mocked Gamepad/Serial devices. Native test uses Rust 1.97.0.
The production build retains the existing >500 kB chunk warning.

G1 commands node scripts/bench-links-ew.mjs all 400 / 800 / 1200 each pass:
4e6 warmup, six N=1e6/2e6 windows, zero GC and zero incremental B/step;
allocating controls detected. Current source/script SHA-256 matches all three
reports test-results/bench/links-ew-all-<Hz>.json. Tested graph rotates all four
MAVLink wire types, decodes actuators, maps RC, crosses timestamp word rollover
and varies EW exposure and motor torque. I/O allocation and browser/hardware
real-time budgets are separate. Node 24.19.0, Chromium 154.0.8037.57,
Debian x86_64/software GPU. Lockfile SHA-256
c391c7bc92bece5b5a23aea3733e58ed9edcd8e0bce873a54f6bddc8f42e7a5b.

MAVLink source 2e2b6af99084e4fde9bb304c84bb9253a1a98b6f, pymavlink 2.4.50;
o official frame or acceptance threshold was regenerated from simulator output.
Ten complete EN/RU document pairs are synchronized; new physical-radio and
terrain-policy guides have mirrors. Environment startup instructions were saved
as a draft, requiring settings review/save/publication to reuse; saving did not
apply the prior SDK network exception or certify a fresh task.
