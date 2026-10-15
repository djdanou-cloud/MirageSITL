# CLAUDE.md — MirageSITL agent instructions

English is the repository source of truth. [Russian mirror](docs/ru/CLAUDE.md).
Read this file **before every iteration**, then the selected TASK in
[PROJECT_ROADMAP.md](docs/PROJECT_ROADMAP.md), the affected contract in
[SPECS_SHARED_MEMORY.md](docs/SPECS_SHARED_MEMORY.md) and/or
[SPECS_SIMULATION_ENGINES.md](docs/SPECS_SIMULATION_ENGINES.md), and current code.
User instructions and execution-environment restrictions take precedence.

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
assume Codex/Cursor automatically read CLAUDE.md: before TASK-084, open it
explicitly. TASK-084 adds AGENTS.md and `.cursor/rules/project.mdc` as thin
pointers rather than duplicate policy copies.

## 2. Actual baseline and scope

At `e3bb6b4`: npm workspaces; `apps/web`; `packages/protocol`, `physics`,
and `input`; SAB **v1**; 400 Hz fixed integration dt; demo dynamics; Gamepad;
React 19/R3F/WebGL. The implementation previously passed 13 unit and four
browser tests. Historical results do not verify new changes.

Rust, JSBSim/BET, v2, MAVLink, ArduPilot, HITL, EW, terrain, thermal, and AAR
are not implemented yet. Never report cargo checks, EKF readiness, or 1200 Hz
support before implementing the module and actually running the relevant check.
Target v2 documentation is not the current v1 implementation.

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
npx --no-install vitest run tests/protocol.test.ts
npx --no-install tsc --noEmit
CHROMIUM_PATH=/usr/bin/chromium npm run test:browser
```

`npm run build` already runs `tsc --noEmit` and Vite build. `npm test` means
`vitest run`; select focused tests by an existing exact path. Omit CHROMIUM_PATH
when using Playwright's browser. If needed, install it separately with
`npx playwright install chromium`. When the cloud home cache is unwritable,
use `npm ci --cache /workspace/.cache/mirage-npm --no-audit --no-fund`.
Do not change HOME or disable TLS/signature/checksum verification.

The following commands **do not exist yet**. The listed task introduces
them, after which dependent work must run them:

| Command | Introduced by | Purpose |
| --- | --- | --- |
| `npm run lint` | TASK-002 | Typed ESLint; no-explicit-any and no-unsafe-* |
| `npm run typecheck` | TASK-002 | Dedicated strict TypeScript gate |
| `cargo check --manifest-path native/Cargo.toml --workspace --locked` | TASK-016 | Native Rust compilation |
| `cargo test --manifest-path native/Cargo.toml --workspace --locked` | TASK-016 | Scalar reference tests |
| `cargo check --manifest-path native/Cargo.toml -p mirage-bet --target wasm32-unknown-unknown --locked` | TASK-016 | WASM target compilation; use crate name mirage-bet |
| `node scripts/build-wasm.mjs` | TASK-017 | Scalar/SIMD artifacts and manifests |
| `node scripts/bench-physics.mjs` | TASK-014 | Machine-readable step/allocation report |
| `node scripts/build-jsbsim.mjs` | TASK-030 | Pinned Emscripten build |
| `node scripts/run-sitl.mjs` | TASK-042 | Pinned native ArduPilot harness |

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
  type-guard validation. TASK-002 enforces repository-wide typed linting.
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
