# CLAUDE.md — MirageSITL agent instructions

English is the repository source of truth. [Russian mirror](docs/ru/CLAUDE.md).
Read this file **before every iteration**, then the approved product scope in
[PROJECT_SCOPE.md](PROJECT_SCOPE.md), the [Phase 1 plan](docs/PHASE1_PLAN.md),
the selected TASK in
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
assume Codex/Cursor automatically read CLAUDE.md. TASK-084 added AGENTS.md and
`.cursor/rules/project.mdc` as thin pointers to this file rather than duplicate
policy copies; if a client loads neither pointer, open this file explicitly.

## 2. Current baseline (`7ad1f51`, Phase 1 planning, 2026-10-28)

### Scope and platform

PROJECT_SCOPE.md (approved by the stakeholder on 2026-10-28) is the source of
truth for product scope when older roadmap entries, the version 2 proposals or
implementation notes disagree. Phase 1 targets macOS on Apple Silicon with
Chrome, native ArduPilot SITL as an external local process, and multirotors up
to eight arms with two motors each (16 motors). The Phase 1 plan registers
TASK-127–TASK-192 and decisions D-01–D-12, and each open roadmap task carries
a Phase 1 disposition. Windows and WSL tooling and evidence below are
historical: they are preserved, they get no Phase 1 work, and they are not
Phase 1 acceptance evidence. Approval of the scope is not evidence of
implementation.

### What exists now

* **Core runtime and ABI:** The web application runs binary ABI v2 (TASK-085) with
  epoch-aware rendering, 400/800/1200 Hz clocks, SPSC transport, Control Protocol v2,
  and the simplified demo flight backend. ABI v1 remains a regression API in
  `packages/protocol`. On Windows Node, the `bench-physics` realtime run executed
  516.7 Hz (target 800) and 519.6 Hz (target 1200) with drops: ~16 ms timer
  wakeups × 8-step catch-up cap (`DEFAULT_MAX_CATCH_UP = 8`). Compute is ~1 µs/step;
  the browser Worker 800 Hz regression passed. Never relax the catch-up cap or
  rate-drop thresholds to hide drops.
* **Rust BET, propulsion, rigid-body, atmosphere, and sensors:** The `native/` Rust
  1.97.0 workspace (`mirage-bet`) provides scalar/SIMD128 WASM builds, checked C ABI
  arenas, polar lookup, a TypeScript atmosphere (standard ISA troposphere, or
  the ISA above the origin's temperature and pressure, which `airAtOrigin`
  derives from a sea-level pressure, a temperature offset and the elevation)
  and seeded synthetic AR(1) gusts (TASK-032; not Dryden, no shear), which
  `weather.set` drives in BET flight sessions (TASK-093), native rotor
  reference kernels with test-only WASM exports
  (TASK-020–TASK-023), motor/battery/arbitrary-frame wrench/RK4 rigid-body WASM
  adapters, and ideal/noisy IMU/baro/mag/GNSS sensors (TASK-024–TASK-028, TASK-034,
  TASK-035). TASK-033 adds the production bound-rotor ABI, NeuralFoil confidence-aware
  polar binding, free-shaft/inflow midpoint coupling and configurable
  `BetFlightDynamics` injection into `PhysicsSessionV2`. Scalar/SIMD, independent
  loads, 4800 Hz convergence, million-step allocation and browser SAB execution
  are checked separately. The legacy unbound ABI retains
  `AERODYNAMICS_UNAVAILABLE`; the application still defaults to demo dynamics.
* **Rapier contact and terrain collision coupling (TASK-029, TASK-065):** The direct
  `f64` Rapier C ABI (`node scripts/build-contact.mjs`, cold-initialized in
  `GroundContact` with its bytes and manifest) passes native/WASM G1, synthetic
  compliance/contact checks, and browser Worker execution.
  `node scripts/check-contact-binding.mjs` records same-source parity and 9,000,000
  native steps; unit tests count 9,000,000 WASM steps. Published collision chunks
  drive Rapier ground contact via contact ABI v2 (TASK-065), supplying each wheel
  and the airframe with the underlying terrain triangle plane every tick and pausing
  stepping when ground is missing. Profile flight sessions stand on the decision
  D-07 supports of TASK-095, and their standard hull (a body cylinder and arm
  capsules, not measured) and propeller discs report every ground contact
  through contact ABI v3 (manifest derivation 5). TASK-149 is DONE: a hull or
  propeller strike that meets decision F-09 pauses the physics session on its
  tick, and the autopilot with it in lockstep; the Run tab lists it and may
  continue the run, labelled as not validated for a damaged aircraft.
  TASK-156 is DONE: a run pauses through one path (the user, a hidden tab,
  an accident, later missing terrain), the physics and ArduPilot's simulated
  time stand still together in JSON lockstep, and Resume continues both.
  TASK-160 is DONE: the Parameters tab reads the running SITL's complete
  list through the TASK-159 service and writes before and during flight and
  while paused; a value that needs a restart is never called applied. Every
  change is the run's `parameter-log` record, and `parameter-set` records are
  saved, compared and sent back (two new project record kinds).
  TASK-161 is DONE: the Parameters tab exports ArduPilot parameter files
  (NAME,VALUE at full float32 precision with a context header) of the running
  SITL, an experiment record or a parameter set, all or changed or chosen, and
  the aircraft profile as a separate project archive; native ArduCopter loads
  an exported file back to the same values (`scripts/check-param-file-sitl.mjs`).
  TASK-165 is DONE: the Experiments tab repeats an experiment or runs a
  variant of it in the Run tab, as a new record (experiment payload schema 4,
  schema 7 since TASK-148)
  whose lineage names the parent and the changed inputs; differences are shown,
  never judged (user decision of 2026-11-03), and an exported experiment lists
  what its archive cannot hold.
  TASK-174 is DONE: the Run tab flies a run by hand with the calibrated USB
  controller (RC override at 25 Hz), and losing the controller pauses the run
  (user decision of 2026-11-03), detected in Main or, for a stalled page, by a
  watchdog in the physics Worker; a replugged controller never takes over.
  TASK-175 is DONE: a Run-tab run is real time, capped or as fast as
  possible, takes the same steps at any pace, and shows its measured speed; a
  real-time run is called real time only at A-05's 0.99 average, judged from
  the autopilot's first heartbeat, and every dropped interval is listed.
  TASK-163 is DONE: the Logging tab plans what a Run-tab run records, with
  size estimates and storage warnings, and every run records with recorder v2
  into its experiment's record (experiment payload schema 3).
  TASK-195 is DONE: no run starts from a profile whose propellers overlap each
  other, reach the body or the ground, and the Aircraft tab proposes the fix
  (longer arms or a larger clearance) and saves it only on confirmation.
  TASK-196 is DONE: profile schema 7 describes the body, the arm thickness and
  up to seven body parts such as a camera pod, which the Aircraft tab edits and
  both 3D views draw; they replace the standard hull in the manifest, the
  clearance check and the accident report, which names a struck part as the body.
  TASK-194 is DONE on the user's approval of 2026-11-07, outside the Phase 1
  acceptance: profile schema 8 adds a landing gear (legs, skids or wheels) that
  the Aircraft tab describes, each value with its source or assumed by the
  standard rule and named so, flown in place of the D-07 supports and drawn in
  both 3D views; a body alone stays schema 7.
  TASK-116 is IN_PROGRESS: five barometer effects stream into ArduPilot's
  SIM_BAROn_GLITCH, its ground-effect compensation was exercised in native SITL,
  and real forum logs (`data/flight-logs/inventory.json`, kept outside the
  repository, `node scripts/check-baro-dips.mjs --dir DIRECTORY`, GNSS or rangefinder
  height) reproduced three of eight held-out landing dips: a dip fitted on one
  flight does not carry to the same aircraft's other flights, and the task stays
  open by the stakeholder's decision of 2026-11-07. TASK-145 is
  DONE: T-Motor's datasheet, on a laboratory supply, is fitted and bound in the
  Components tab (laboratory sets bind whatever the battery, 2026-11-07), and since 2026-11-08 its
  static solve takes the flight's own rotor binding (`flightRotorDefinition`; calibration record
  schema 2, schema 1 fits refused on binding). TASK-117 is BLOCKED_EXTERNAL on logged open-sky
  error statistics only (its urban comparison on smartLoc is shown): GNSS geometry of a four-system sky (the GPS almanac with IGS
  broadcast Galileo, GLONASS and BeiDou records), atmosphere, terrain, code noise,
  multipath and a placed jammer stream into SIM_GPS1_* at the receiver's own rate and
  lag, flown on native ArduCopter. TASK-105 is DONE (2026-11-09): the ESC shaper and the
  motor's heat fly on the ESC drive with G1 passing, HAL mailbox v2 motor speeds
  drive the browser firmware's notch, and ESC desynchronization is the TASK-166
  effect `esc.desync`, every value of it an engineering choice; the notch's
  attenuation of a vibration belongs to the deferred TASK-114. TASK-104 was DONE
  (2026-11-09, approved that day) and is reopened on 2026-11-10 to finish it: a pack whose battery card names an open-circuit
  curve flies the second-order Thevenin pack (shared bus records v2), and ArduCopter's
  sag-compensated low-battery warning behaves as declared on it; its comparison with
  the stakeholder's logged discharges is shown for the stakeholder to judge (SA-01).
  Terrain planes in sessions and live terrain admission remain open.
* **JSBSim WASM, contact backend, and UIUC propellers (TASK-030, TASK-031, TASK-086):**
  `node scripts/build-jsbsim.mjs` requires verified `JSBSIM_SOURCE_DIR` and
  `MIRAGE_EMSDK_DIR` checkouts with Emscripten 4.0.15 (aircraft XML remains local
  test input, excluded from artifacts); `node scripts/check-jsbsim-artifact.mjs`
  verifies WASM Worker smoke at 400/800/1200 Hz.
  `node scripts/build-jsbsim.mjs --contact` builds the instrumented JSBSim contact
  artifact with native WASM exceptions (the legacy JS-exception artifact remains
  separate and fails JS GC admission). `node scripts/check-jsbsim-backend.mjs --native`
  captures GNU native references (supporting WSL on Windows via
  `MIRAGE_JSBSIM_NATIVE_CMAKE`);
  `node --experimental-transform-types scripts/check-jsbsim-backend.mjs` verifies
  WASM trajectory parity and allocator behavior; `node scripts/bench-jsbsim.mjs`
  measures the real JS adapter separately. `node scripts/check-jsbsim-propellers.mjs`
  verifies UIUC propeller `<table name="C_T">` and `<table name="C_P">` loading in
  JSBSim v1.2.3 (18/18 cases, TASK-086). Read the engine spec's additive
  contact/initial-state ABI before coupling: built-in active gear and external
  contact cannot both supply a reaction in one tick.
* **Native upstream allocator diagnostics and patches:** `node scripts/check-jsbsim-native.mjs`
  checks native trim/frames and 1,000,000 steps in 250 bounded windows (exits 2 on
  a failed allocator gate). `node scripts/check-contact-native.mjs` uses the pinned
  Rapier checkout from `native/rapier/source.lock.json` and builds outside the
  repository. `node scripts/bench-contact.mjs` exercises repeated contact and must
  retain GC observation. Opt-in `--patched` native Rapier/JSBSim runs pass
  million-step allocator probes with zero calls/bytes and matching trajectory
  checksums while unpatched upstream builds still allocate;
  `node scripts/check-engine-patch-parity.mjs` checks report/source/patch identities
  before comparison. Never mark an engine high-rate certified from boundary tests
  or steady memory size alone.
* **Native ArduCopter SITL, EKF warmup, and EW captures (TASK-042, TASK-043, TASK-059):**
  `node scripts/run-sitl.mjs` runs the bounded owned-process harness with
  `scripts/sitl/driver.mjs` and a pymavlink 2.4.50 sidecar on Linux/WSL against
  pinned native ArduCopter and our Rust rigid-body WASM using an explicitly
  synthetic quad X model. `node scripts/check-sitl-capture.mjs --input CAPTURE_DIRECTORY`
  validates full-rate physics, original telemetry, source identities, and trace v2.
  `LiveEkfWarmup` (TASK-043) composes with the native driver using acknowledged JSON
  lockstep IMU samples and CRC-checked MAVLink EKF/heartbeat/GNSS diagnostics,
  revoking READY/EW admission when sensors or diagnostics go stale; replay with
  `node scripts/check-ekf-warmup.mjs` after the raw MAVLink audit
  (`scripts/sitl/check-raw.py`). TASK-059 native EW experiments run six-case
  acquisition, raw-wire/physics audits (`scripts/sitl/audit-ew.mjs` with
  `scripts/sitl/check-ew.py`), one-time calibration (`node scripts/freeze-ew.mjs`),
  and validation against fixed firmware-specific limits; `node scripts/run-ew-sitl.mjs`
  runs the calibration and validation passes.
  TASK-042/043/059 reports become historical snapshots when their input sources
  change; keep regression reports separately. Follow the [runbook](docs/operations/runbook.md)
  for Linux environment and owned-process scope. **Do not enable browser autopilot
  READY from offline native integrations.**
* **ArduPilot WASM build and Worker boot (TASK-044, TASK-045):** TASK-044 recorded
  native HAL feasibility requirements. TASK-045 provides the local Emscripten
  pthreads ArduCopter build/check (`node scripts/build-ardupilot-wasm.mjs`), real
  browser Worker/pthread boot, and IndexedDB `/ardupilot/eeprom.bin` persistence.
  GPLv3 firmware redistribution remains `BLOCKED_DECISION`; the artifact stays
  external and is served only via explicit loopback development settings. The active
  browser flight backend remains the demo pending application session/release
  admission. TASK-047 verifies local native/browser arm/takeoff/land and GCS
  failsafe parity, with independent raw-wire auditing and configuration-bound
  SHA-256 report admission in `AutopilotSession`. TASK-046 implements
  the checked sensor/PWM mailbox, host-owned 400/800/1200 Hz clock and configurable
  BET coupling, with separate native/kernel allocation and real-firmware browser
  checks (`scripts/build-ardupilot-hal.mjs`, `scripts/check-ardupilot-hal.mjs`,
  `tests/browser/wasm-hal.spec.ts`). Whole-firmware allocator admission and READY
  do not follow from the HAL boundary.
* **Links, bridge, Web Serial, EW, thermal, instructor UI, AAR, terrain, and scenarios:**
  TASK-037–TASK-040, TASK-048, TASK-052, TASK-053, TASK-056, TASK-057, and TASK-060
  provide the pinned MAVLink2 subset, versioned radio calibration/mode mapping,
  `EkfMonitor`/`EkfWarmup`, origin/token-checked loopback WS/UDP bridge,
  gesture-driven Web Serial transport with a separate I/O decoding Worker, isolated
  EW/motor-fault models, and fail-closed terrain policy. Run
  `npm run start -w @mirage/bridge` with `MIRAGE_BRIDGE_TOKEN` supplied locally
  (64 hex characters); optional `MIRAGE_BRIDGE_ORIGIN`, `MIRAGE_MAVLINK_PORT`, and
  `MIRAGE_PHYSICS_PORT` configure origin/UDP endpoints. **Never print bridge tokens
  or add them to URLs/repository files.** Loopback `ws` only; HTTPS/WSS/PNA require
  separate integration. Scalar convenience methods may box floats; high-rate
  composition uses typed-array `stepInto` inputs/outputs. The thermal package
  provides a synthetic surface-energy solver, LWIR WebGL2 material, and offset-only
  NUC (no measured CADEX claim). The demo UI has a source/freshness-aware attitude
  HUD, real Worker command ledger (unsupported demo weather/fault/model commands are
  intentionally rejected and must remain visibly rejected until their backend
  exists), keyboard/axe accessibility (TASK-079), and a Main-decimated 10 Hz AAR
  recorder/review/archive flow with a separate recorder Worker, SAB, and bounded
  IndexedDB chunks (not full-rate sensor/actuator recording or complete
  resimulation). High-rate terrain calls use `sampleInto`/`readyFrom`; building,
  staging, JSON/provenance checks, and outcome analysis are cold, stage/publish
  memory is byte-capped, and missing ground never becomes ready. Scenario polling
  returns indices; the integration owner must bind epochs and verify ACKs.
* **Benchmark and acceptance CLIs:** Use `node scripts/bench-links-ew.mjs all 400`,
  `node scripts/bench-aar.mjs 400`, and `node scripts/bench-terrain-scenarios.mjs 400`
  (also `800` and `1200`) for warmed Node allocation evidence (`bench-sensors.mjs all`
  requires Node 24 and warms 4,000,000 ticks). Independent CLI analyzers use
  `--input PATH --sha256 HEX` on bounded real captures: missing input exits 2
  (`BLOCKED_EXTERNAL`), invalid evidence or failed limits exits 1, and
  system/release tooling (`scripts/check-system-readiness.mjs`,
  `scripts/check-release-gates.mjs`) preserves `FAIL` separately from missing
  evidence. Reports never automatically enable a runtime mode.

### What remains open

* **Phase 1 program (TASK-127–TASK-192, [PHASE1_PLAN.md](docs/PHASE1_PLAN.md)):**
  TASK-131 (offline and terrain inventory, `node scripts/check-offline.mjs`) and
  TASK-135 (the physics-review branch landed) are DONE, and so is TASK-132: the
  stakeholder decided every acceptance value
  ([phase1-acceptance.md](docs/decisions/phase1-acceptance.md)). TASK-133 is DONE
  too ([phase1-fidelity.md](docs/decisions/phase1-fidelity.md)): by scope
  amendment SA-01, MirageSITL sets no fidelity limits and gives no fidelity
  pass or fail; the user judges the comparisons. TASK-130 is DONE: the pinned
  UAVLogViewer builds and opens a current ArduCopter log offline
  ([uavlogviewer.md](docs/decisions/uavlogviewer.md),
  `node scripts/check-uavlogviewer.mjs`). TASK-136 is DONE: `packages/project`
  keeps projects, component cards, aircraft profiles and experiments in
  IndexedDB as immutable versions addressed by SHA-256, with project archives
  (`.mirageproj`). TASK-137 is DONE: the application opens in an English shell
  with a project context and the twelve Phase 1 tabs, its navigation survives
  a reload in the store's local settings, and the former demo page is the Run
  tab's explicitly synthetic backend. TASK-138 is DONE: `packages/aircraft`
  validates aircraft profile schema 1 (one to eight arms, up to 16 motors with
  coaxial pairs, mass properties, payload, outputs and card references) and
  derives its rotor layout and a vehicle manifest v2 whose bytes Node and
  Chromium reproduce identically. TASK-139 is DONE: component cards for
  motors, propellers, ESCs and batteries name the source of every value, move
  between projects in a card exchange file (`.miragecards`), and give a BET
  propeller geometry with its assumptions and validity flags listed. TASK-140
  is DONE: the Components tab keeps bench measurements bound to one exact
  motor, propeller, ESC and power-supply combination (bench CSV v2), and each
  profile version is a preliminary calculation or a calculation from
  measurements, with the TASK-133 labels per motor. TASK-141 is DONE: the
  Aircraft tab builds all five S19 configurations without files, and its 3D
  scheme draws each rotor where the derived manifest puts it. TASK-192 is
  DONE: the Components tab creates, edits and copies cards of all four types
  without files, each value known with its source or stored as not known, and
  every save is a new card version. TASK-143 is DONE: the Sensors tab stores
  sensor configuration schema 1 in profile schema 3, shows every field's owner
  on the external-SITL path, and offers cited per-sensor presets (SA-02).
  TASK-147 is DONE: ownership mapping 2 and matrix schema 3 apply the
  configuration on native ArduPilot SITL, with generated `SIM_*` parameters
  read back before arming and MirageSITL's IMU and battery errors on the JSON
  state line (`MIRAGE_SITL_SENSORS`, `node scripts/run-sitl-sensors.mjs`,
  `node scripts/check-sitl-sensors.mjs`); the magnetometer's position and
  orientation stay locked on `native-json`. TASK-144 is DONE: a profile version
  and its component cards build `BetFlightDynamics` with up to 16 rotors on the
  TASK-092 drive (`resolveComponents` lists every assumed value and blocks
  flight on missing ones, profile schema 4 picks each propeller's polar from the
  runtime catalog, `buildProfileDynamics` and `profileModelPort` load it through
  `model.load`, and the physics Worker accepts the BET module and manifests by
  hash); all five S19 configurations hold a trimmed hover, and in Node on the
  M5 the 16-rotor step has a p99 of 0.19 ms, inside the period at 400, 800 and
  1200 Hz (`node scripts/bench-profile-dynamics.mjs`). TASK-150 is DONE: the MAVLink
  codec reads a message table that pymavlink 2.4.50 generates from the pinned
  `ardupilotmega.xml` and its includes, and supports 40 messages (TASK-155 added
  AUTOPILOT_VERSION and TASK-173 SET_ATTITUDE_TARGET), adding the
  parameter, command, status, telemetry, mission and position-target messages
  of Phase 1, with a cold `packInto` builder, field readers and preallocated
  decoders for the high-rate telemetry subset, all byte- and value-exact
  against pymavlink goldens. TASK-178 is DONE: `packages/dataflash` reads
  DataFlash logs, in a Worker if needed, with the field values and times of
  pymavlink's `mavlogdump`, reports damaged byte ranges, and writes MirageSITL
  truth, motor, event and parameter-change records under `MS` names that
  pymavlink reads back unchanged. TASK-179 is DONE: `scripts/build-uavlogviewer.mjs`
  builds the pinned UAVLogViewer with patches 0000–0004
  (`third_party/uavlogviewer/patches/`) reproducibly into the launcher home, the
  installer runs it, Vite serves it at `/uavlogviewer/`, and the Analysis tab opens
  DataFlash logs in it offline through an origin-checked message interface, in Chrome
  on the M5. TASK-180 is DONE: a stored experiment opens there with ArduPilot's own log
  or a log written from its recording, its context beside the viewer and its requested,
  confirmed and rejected parameter changes on the plot, and a log from elsewhere marks
  what it does not hold Unknown. TASK-181 is DONE: two flights, or two intervals of one, are
  compared in the viewer, dashed on one value axis, overlaid or side by side, with aligned starts
  and a manual shift, and a saved comparison keeps its alignment. TASK-182 is DONE: **Create experiment from log**
  reports field by field what a log and an interval give, with each source message, what
  is missing and what the run will not take, and the run it plans starts on the ground
  at the log's home with its settings on an aircraft the user chooses, which is not a
  replay. TASK-183 is DONE: that run takes changed parameters and computes its own path, and it
  compares with the original flight by metrics and in the viewer. TASK-146 is DONE: with the TASK-092 drive,
  `BetFlightDynamics` checks every step against card ratings and the model's
  clamps, keeps a rating `warning` apart from a modeled `limited` clamp,
  publishes per-motor and battery values in the separate power telemetry v1
  channel and shows them in the Run tab's power panel; the AAR v1 record has
  no room for them, so TASK-162 stores them. TASK-094 is DONE for Phase 1: the
  body step v2 takes a CG offset (the moment moves to the CG) and reports the
  angular acceleration and the reference point, and contact configuration
  version 2 gives Rapier the full inertia tensor. TASK-095 is DONE:
  contact sessions run without Rapier's CCD, so they travel kilometres
  without an allocation, the gear's strut and tire loads step implicitly (drop
  peaks no longer depend on the step rate), the wheels have static, Coulomb
  and brush-tire friction (contact configuration version 3), and
  `BetFlightConfiguration.contact` makes `GroundContact` the flight model's
  body integrator in place of the attitude-resetting synthetic pad; native
  ArduCopter takes off and lands on the D-07 supports in the harness and the
  Run tab. Terrain planes in sessions remain for TASK-187, and browser-hosted
  ArduCopter is not a Phase 1 flight mode. TASK-158 is DONE, which completes
  milestone M3: `node scripts/phase1/nominal-flight.mjs` takes each of the five
  S19 configurations through the UI alone in Google Chrome with native
  ArduCopter, from typed component cards to a stopped run, and writes the
  verdicts of its profile-creation, output-mapping, start, flight-task and
  pause-resume workflows into `docs/validation/phase1-matrix.json`, each citing
  its evidence report in `test-results/validation/phase1-nominal/`. Decision
  A-04 is amended: runs with ArduPilot SITL use 800 Hz. Decision A-13 requires
  a steady hover (body rates within 1 °/s, standard deviation, in the flight's
  own log), so the quad flies that acceptance with a 40 Hz gyro filter, set in
  the Parameters tab; at stock settings it oscillates at 10 Hz. TASK-172 is DONE:
  the Flight tasks tab defines takeoff, hover, landing, straight, climb,
  descent, acceleration, braking, turn and route tasks as versioned project
  items (`packages/scenarios/src/flight-tasks.ts`), and the Run tab flies a
  stored one with native ArduCopter through guided targets and uploaded
  missions, requested next to actual and both recorded, the definition in
  experiment payload schema 5. Ground values apply at the first physics step;
  by the user's decision of 2026-11-04 an airborne start is a lead-in that
  ArduPilot flies, and the task's clock starts on arrival. Every guided target
  is one ArduPilot can follow without correcting: position, velocity and
  acceleration on a path smoothed within the limits it reports (WP_ACC_Z,
  PSC_D_JERK, PSC_NE_JERK, ATC_ACC_Y_MAX), so what is requested is what can be
  flown. A run the launcher starts gets COMPASS_DEC at boot from its home, or
  EKF3 learns a false gyro error and the true heading creeps about 2° from the
  one commanded. TASK-173 is DONE: tuning maneuvers are flight tasks of eight
  more types (`packages/scenarios/src/maneuvers.ts`), steps and doublets in roll,
  pitch, heading and altitude, whose changes are sharp on purpose. The
  Experiments tab charts requested against actual from the stored recording, with
  delay, rise time, overshoot, settling and end error of each change, shown and
  not judged. Roll and pitch can end a few tenths of a degree off the request
  because EKF3 lags ArduPilot's simulated gyro drift (SIM_DRIFT_SPEED). TASK-177 is
  DONE: the Experiments tab compares two flown experiments (`packages/analysis`),
  listing the inputs held equal and flagging one that differs, accounting for the
  components' own mass, and showing thrust margin, RPM, current, power, energy, a
  duration estimate with its scenario and reserve, position and maneuver response and
  recorded limit exceedances, shown and not judged. `thrustCapacity` solves the thrust at
  full command. TASK-197 is DONE: the flight step solves the battery bus and the motors
  together (`native/bet/src/bus_solve.rs`), so the voltage no longer flips every tick at high
  demand, a pack at its limit holds the motors back, and a flight at full command settles on
  the thrust `thrustCapacity` gives. TASK-176 is DONE:
  the Experiments tab runs a batch of parameter sets the user supplies
  (`packages/project/src/batch.ts`), one scenario from the Run tab once per set with every
  other input identical. A failed run is recorded and never retried, and the next set
  still runs. Nothing searches for values or ranks the sets. TASK-148 is DONE: WGS84
  normal gravity (`gravity.ts`), the WMM2025 main field (`geomagnetic.ts`) and
  the hashed EGM96 grid (`data/geoid/`, which opens the TASK-036 MSL gate) pass
  their reference data; `effectiveConditions` combines them for a location,
  flight sessions take the location's gravity and origin air, the Weather and
  location tab keeps one location per project and shows its conditions, the
  Run tab starts ArduPilot at it (`--home`, barometer parameters, COMPASS_DEC,
  `environment.set` to the physics Worker), and experiment payload schema 7
  records the location with its conditions. TASK-142 is DONE:
  the Aircraft tab maps each motor to an output and generates the frame
  parameters from the TASK-128 catalog (the S19 octa-x fixture spins the
  mirror of stock OCTA X, so it uses the scripting matrix). TASK-151 (the
  local launcher, `apps/launcher`) and TASK-152 (`scripts/install-macos.mjs`
  and the Project tab's first-run check) are DONE: both pass with the network
  switched off. TASK-153 is DONE: the Run tab's ArduPilot SITL backend
  flies an aircraft profile with native ArduCopter through the launcher, the
  physics Worker stepping PhysicsSessionV2 on SITL's frames (`SitlJsonLink`),
  READY from LiveEkfWarmup and revoked when diagnostics go stale, with G1 for
  the lockstep step. TASK-154 is DONE: the Run tab's run states (`SessionController`),
  the immutable experiment record (`@mirage/aircraft/experiment`), parameter
  read-back and the four DoD faults pass against the installed ArduCopter.
  TASK-155 is DONE:
  the Run tab's Connect attaches to an ArduCopter SITL the user started (the
  launcher owns only the connection, `POST /v1/connections`), refuses it with
  every reason unless it runs JSON physics, is disarmed, reports a verified
  commit, already holds the profile's parameters (nothing is written to it)
  and starts at the session's home, records it as experiment schema 2, and
  leaves it running across connect and disconnect cycles. All three pass in
  Google Chrome 156 on the M5. TASK-185 is DONE: the Run tab's SITL
  backend draws the chosen profile's aircraft in 3D (the Aircraft tab's own
  rotor parts, blades turning with each motor's speed) at the session's pose,
  with external and onboard views, a two-minute trajectory and flight and
  per-motor panels; it holds 60 FPS on the M5 with no late frame, and A-06
  now judges macOS by the median and no interval above 25 ms (stakeholder,
  2026-11-01). TASK-157 is DONE: before flight the Run tab's motor check has
  ArduPilot spin each motor alone and compares its frame (test order, output,
  spin) with the rotor the physics turned; all five S19 configurations pass
  against native ArduCopter, and a swapped mapping or a reversed spin is
  caught on exactly that motor. TASK-159 is DONE: `ParameterService`
  (`@mirage/autopilot/param-service`) downloads ArduPilot's complete parameter
  list, classifies every write by read-back (`confirmed`, `refused`,
  `timeout`, `stale`) and shows exact float32 values, with metadata generated
  offline from the pinned source (`data/ardupilot/param-metadata.json`,
  `scripts/generate-param-metadata.mjs`); `node scripts/check-param-sitl.mjs`
  passes against native ArduCopter. TASK-164 is DONE: the launcher refuses
  `LOG_*` parameters the firmware's metadata or SITL cannot honour, and
  attaches each run's DataFlash files to the experiment (`dataflash.json`:
  size, SHA-256, complete/truncated/damaged/empty/missing, firmware from VER,
  logging read back from PARM).
  TASK-162 is DONE: recorder v2
  (`packages/aar`) records a run signal by signal at effective rates
  min(requested, source) from a 30-signal catalog, through a zero-allocation
  producer in the physics Worker (`recording-v2.arm`), into checksummed
  format v2 chunks in the persistent IndexedDB database `mirage-recordings`,
  without the 32 MiB cap; records reopen after a restart, a cut-off one as
  interrupted. The Logging tab and the Run tab's wiring are TASK-163/165.
  Decisions D-04
  and D-06 to D-12 are decided. TASK-127 and TASK-128 are DONE: stock
  ArduCopter builds and flies natively on Apple Silicon
  ([macos-sitl.md](docs/decisions/macos-sitl.md)), and its stock frames and
  scripting matrix drive all five S19 configurations, 16 motors included
  ([ardupilot-frames.md](docs/decisions/ardupilot-frames.md)). The stakeholder
  decided D-01 on 2026-11-06: stable ArduCopter V4.7.2, commit `fb77356` (TASK-198), and
  D-02 the same day: the native build on the user's Mac. The browser WASM firmware
  keeps its own lock at `8ab6afd`. TASK-129 records D-03: JSON lockstep without `no_lockstep` owns
  simulated time, a 60 s pause does not induce a failsafe, parameter access
  waits until resume, and acceleration is host-limited
  ([sitl-clock.md](docs/decisions/sitl-clock.md)). TASK-136 defined the project archive of D-05, TASK-139 its
  component-card format and TASK-140 its measured-data format. TASK-073,
  TASK-080, TASK-082 and TASK-083 below are not Phase 1 gates; see their Phase 1
  dispositions in the roadmap. On 2026-11-06 the matrix stands at 51 PASS on evidence from a
  clean installation of the final code (`node scripts/phase1/acceptance.mjs`), Phase 1 not yet
  accepted: TASK-187 feeds per-tick terrain planes to the contact and records `truth.contact`
  and `events.contact`; TASK-189 flew the 16-motor hour (`node scripts/phase1/endurance.mjs`,
  2.87 times real time with the Mac in use for its last part, 249 MB, 3.30 GB);
  `node scripts/phase1/global-workflows.mjs` runs the global workflows with the network blocked
  per process under `sandbox-exec`, no system setting changed; `node scripts/release-manifest.mjs
  --delivery` writes the delivery manifest; TASK-186 is DONE on a real FABDEM build
  (`scripts/geodata/setup-macos.sh`); the installer now builds the physics modules, which a
  clean machine lacked. Repeated flights found a contact fault the first 51 PASS missed: a list
  of the engine's bounding-volume tree grew inside a step, about 5 flights in 36, and the engine
  patches now size those lists from the tree (TASK-095). TASK-190 is DONE, and TASK-191 waits on the stakeholder's judgement of TASK-101's coaxial comparison (TASK-099 and TASK-100 are DONE, the stakeholder judging their comparisons on 2026-11-08);
  TASK-145 and TASK-184 are DONE on T-Motor's datasheet and a forum flight log (2026-11-07). A-06 passes: three more runs on V4.7.2 after five on `8ab6afd`, and one
  failing run with a 50.01 ms interval of unproven cause. TASK-098's inflow ended the quad's
  stock-settings oscillation, so A-13's 40 Hz filter is the stakeholder's to keep or drop. TASK-090's
  `scripts/fidelity-capture.mjs` writes a capture from two logs; TASK-108 and TASK-115
  are DEFERRED with their Phase 1 parts done. The bridge's message limit follows the
  run's rate and speed-up (TASK-175): a flat 4096 per second closed any run above 5.1
  times real time at 800 Hz, hidden while Low Power Mode held this Mac at 4.7.
* **Measured model fidelity (separate from the TASK-033 synthetic baseline):** `node scripts/validate-models.mjs`
  reports numerical/runtime PASS, contact deferred/blocked, propeller FAIL,
  and exits 2. Synthetic geometry and NeuralFoil complete the software validation
  baseline selected by the user; they do not establish measured fidelity. The NASA
  TM X-3561 landing-gear drop comparison (`tests/fixtures/contact/nasa-drop.json`,
  archived in `test-results/validation/nasa-drop-legacy.json`) fails its measured
  deceleration (`-1.6 g`) and stroke envelopes and was explicitly deferred by the
  user; UIUC propeller BEM comparisons also fail measured fidelity tolerances.
  **Never describe the failing NASA/UIUC comparisons as merely missing data or
  relax thresholds to hide them.**
* **Browser WASM SITL, UX chain, GPU timing, and release gates:**
  Browser application session/READY integration, TASK-073 (G3 frame-time gate via `scripts/check-gpu-perf.mjs` and
  `scripts/gpu-ratings.mjs`: by user decision of 2026-10-23 the least performant tested integrated GPU must pass a 1920×1080 canvas at 1x on WebGL2 and WebGPU at median 16.680 ms and p99 17.665 ms; every other machine, screen and GPU is rated out of 100 in `docs/DEVICE_RATINGS.md` without deciding; the Intel iGPU passed on 2026-10-24, the M5's first gate-eligible pair, on an external 1920 x 1080 screen on 2026-11-08, FAILS with p99 18.620/18.635 ms and no missed refresh (cause not established), and the M4 still needs gate-eligible runs; on Windows capture on the primary display, because Chrome takes its frame clock from the primary display's vertical blank), TASK-080
  (accessibility sign-off; TASK-074 HUD freshness, TASK-075 fault ACKs, TASK-078 full-rate recording, and TASK-079 scenario ACK binding are done and do not admit browser READY), TASK-082 (multi-hour integrated soak), and TASK-083 (clean-machine
  release and assistive screen-reader sign-off) remain open.
* **Physics fidelity program (TASK-087–TASK-123, roadmap Phases 7–13):** registered
  2026-10-26 from the physics fidelity review. TASK-087, TASK-088, TASK-090 and the
  Phase 1 part of TASK-089 are DONE:
  * TASK-087: the strict vehicle manifest v2 (`vehicle-manifest.ts`), an ArduPilot
    profile limited to evidenced names, and an optional `SessionModelPort` for
    `model.load`; the default demo backend is unchanged. The physics Worker
    registers each profile's derived v2 manifest; the Linux driver's
    `quad.parm` gets no Phase 1 work.
  * TASK-088: bound-rotor and body step interfaces v2 with fail-closed later-task
    fields (status −8); neutral records run v1 bitwise. The JS GC probes of
    `check-bet-runtime.mjs --allocation` cover the v2 adapters.
  * TASK-089: a pinned-source SITL catalog and a 25-source error-ownership matrix. By
    the user's 2026-10-26 decision ArduPilot defaults stay the default, and the opt-in
    `imu-noise-floor` firmware patch (`scripts/build-ardupilot-sitl.mjs`) adds
    `SIM_ACC_FLOOR`/`SIM_GYR_FLOOR`, which switch off the fixed IMU noise floors
    (`scripts/ownership-profile.mjs --imu-noise-floor off`). Unpatched firmware skips
    them silently, so `run-sitl.mjs` with `MIRAGE_SITL_IMU_NOISE_FLOOR=off` holds arming
    until the firmware confirms both values. That driver change ended the TASK-059 matrix
    (accepted 2026-10-27), and TASK-171 is DONE: `tests/fixtures/scenarios/ew-matrix.json`
    is frozen again on macOS with the current driver, and six separate validation flights
    pass it (`docs/validation/ew-macos-report.json`). Under guardrail 5 of the
    approved PROJECT_SCOPE.md, decision D-10 of 2026-10-28 is: no patch for now,
    so Phase 1 runs use stock ArduPilot SITL and leave the patch unused. Every SIM_
    parameter of the catalog is declared, and a live write of a parameter of an error
    MirageSITL applies or this run switches off is refused with its reason. Its
    browser-path items stay with the preserved TASK-046 and TASK-047.
  * TASK-090: fidelity metrics and `scripts/check-fidelity.mjs`, which never passes
    synthetic data. DONE on 2026-11-08: the Pavo's four SystemId flights against
    SITL and the UIUC and T-Motor static-stand data (capture schema 3, source
    `bench-test`) are scored as REPORTED, with no verdict (SA-01).

  TASK-092 is DONE: `BetFlightDynamics` takes an optional production drive
  (voltage-driven motor, ESC hold and lag, shared battery bus over bound-rotor v2
  drive mode 1 and `bet_bus_step`), the torque drive stays bit for bit as before,
  the ArduPilot profile v2 sets `BATT_MONITOR`, `MOT_BAT_VOLT_*` and a fitted
  `MOT_THST_EXPO`, and native ArduCopter hovers on it with measured bus current
  (`MIRAGE_PARITY_DRIVE=esc`); the browser WASM hover is BLOCKED_EXTERNAL without
  an Emscripten toolchain and the TASK-045 artifact. TASK-091 (BET compute
  headroom) is DONE: the default rotor kernel, within the T1 tolerance of the
  reference, runs 5.3x faster than the recorded baseline in the SIMD128 build
  Chrome runs (3.6x in scalar), option 4 keeps the bit-identical exact kernel,
  the opt-in modes of bound configuration version 2 (off by default) reach
  12.5x, and an octocopter step at 1200 Hz has a p99 of 0.065 ms in a Chrome
  Worker on the M5 against the 0.4167 ms G3 limit (`node scripts/bench-bet.mjs`,
  `tests/browser/bet-compute.spec.ts`). TASK-097 is DONE: extended catalog polars
  cover every angle of attack and Mach numbers to 0.7 from the NeuralFoil tables
  (`tests/fixtures/polars/generate_extended.py`), flagged low confidence outside
  the source range, with rotational lift augmentation in bound configuration
  version 3; source tables keep their IDs and bytes. TASK-098 is DONE: profile
  flights use Pitt-Peters dynamic inflow with annular tip and hub losses and the
  derived millisecond time constant (bound configuration version 4), and a rotor
  that does not ask for it runs the old model bitwise. TASK-099 adds Johnson's
  descent and vortex ring model with a seeded thrust fluctuation (configuration
  version 5); its comparison with the stakeholder's Pavo descents ran on 2026-11-08
  and is not reproduced (the logs reach only the edge of the vortex ring region);
  the stakeholder judged it "Good for now" and the task is DONE. The Pavo model's faster hover
  traced to its assumed propeller chord; with the stakeholder's measured chord of 2026-11-09 (10 mm
  at the widest point) it hovers 10 to 12 % slower than the logs, thrust about a fifth high at about
  the measured power, and the descent and SystemId comparisons were run again
  (SPECS_SIMULATION_ENGINES "Why the model hovers faster"). TASK-100 adds the rotor ground effect,
  off unless effect `rotor.ground-effect` asks for it, with the closed-form thrust
  ratio at equal power, the multirotor's neighbours and, since 2026-11-08, the
  fountain's lift on the body (Sanchez-Cuevas, K_b 2); its comparison with the
  stakeholder's Bee35 hover log reproduces the lowest heights and misses 6 to 9
  radii; the stakeholder accepted it, and the task is DONE. TASK-101 adds the rotor
  wakes (`packages/physics/src/rotor-wake.ts`): a top-hat tube from every rotor to
  any other in reach, on by default, so a coaxial pair is not twice one rotor,
  and the airframe's download from the hull. Its forward-flight comparison with
  NASA's MTB2 tunnel data ran on 2026-11-08 (`tests/rotor-wake-mtb2.test.ts`,
  `MIRAGE_MTB2_DIR`), judged by the stakeholder as it stands: the level rear rotor's
  large loss at 40 ft/s is reproduced, a raised one's dependence on RPM and the
  level one's loss at 20 ft/s are not. Its coaxial comparison with NACA TN 2318
  (Harrington 1951, digitized into `tests/fixtures/rotors/harrington-coaxial.json`) ran
  on 2026-11-09 (`tests/rotor-wake-harrington.test.ts`, `MIRAGE_HARRINGTON=1`): a pair's
  extra torque over two lone rotors is reproduced on rotor 1 and not on rotor 2 (the
  model 0.06 to 0.08 high), and the model's torque is 21 to 32 % low everywhere from its
  section drag; the task stays BLOCKED_EXTERNAL until the stakeholder judges it. TASK-103 adds the rotor table mode
  (`packages/wasm-bet/src/rotor-map.ts`, configuration version 6): five axes with a
  Reynolds scale, selected per rotor in `BetFlightConfiguration.rotorMaps`, not yet in
  the profile. TASK-103 is DONE: 9 of 111 left-out stand points miss the declared
  3 %, by the data's own scatter, and the stakeholder accepted that on 2026-11-07.
  TASK-093 is DONE: `weather.set`
  applies on its tick to `BetFlightDynamics` (the demo still rejects it); every
  step the rotors read the ISA air at the CG's height above the origin's air
  and a uniform mean wind with a seeded TASK-032 gust, the published airspeed
  is relative to the air, the SITL JSON line carries `velocity_wind` (no
  `airspeed` until the TASK-089 oracle covers it), and a weather the model
  refuses faults the session. TASK-096 is DONE: `BetFlightDynamics`
  applies airframe drag from a manifest's drag-area tensor and center of
  pressure (`buildProfileDynamics` consumes the block), flagged beyond the
  data's airspeed range; profiles get a preliminary estimate from the
  standard hull (manifest derivation 6) unless they state drag areas with
  their source (profile schema 5, the Aircraft tab's Body drag section); in
  native SITL the quad holds station
  in wind with its lean shown against the body drag, and EKF3 drag fusion
  learns the wind. That test flies the quad with a 40 Hz gyro filter: at stock
  settings it holds altitude in a 10 Hz attitude oscillation (TASK-158), which
  pulls EKF3's cross-wind estimate and heading. TASK-096 first put that
  error down to EKF3's per-axis drag form; the comparison of 2026-11-04
  corrects it. The physics tasks TASK-097–TASK-123
  are not implemented. TASK-166 is DONE: Control Protocol v3
  (`packages/protocol/src/control-v3.ts`) gives every environment, EW, motor and
  sensor-error effect a record with an on/off switch and an intensity, each range
  equal to its model's envelope, and off or zero is bitwise identical to absent
  over a seeded run. `weather.set` and `fault.set` map onto those records and fly
  as they did, scenario schema 2 schedules them, and the instructor console has one
  form per effect. A running session rejects `sensor.*` controls visibly, and the
  console stays on the demo page until TASK-167 and TASK-169. TASK-106's Phase 1 part
  is DONE: MIL-F-8785C low-altitude Dryden turbulence (`packages/physics/src/turbulence.ts`,
  effect `wind.turbulence`), without rotational gusts or the other spectra. TASK-168 is DONE:
  ten sensor and link faults reach stock native ArduCopter on the path that owns each reading
  (the state line, ArduPilot's own fault parameters, the bridge), with truth bitwise untouched,
  and motor faults act on the profile dynamics; ArduPilot's response is recorded, not predicted,
  and TASK-169 gives them a tab. TASK-169 is DONE: the Faults and interference tab applies
  those effects by hand or on a schedule the run keeps in its experiment record, counted from the
  first armed report, and `effect-log` records each outcome; GNSS steps and drift reach ArduPilot on
  the state line, north and east, jamming and magnetometer bias through its own parameters, and a
  magnetometer rotation through the attitude on the line. TASK-170 is DONE: the tab's EKF drift
  scenario flies as an input error on that path, ArduPilot's estimate is never written, and the
  Experiments tab charts the truth against its estimate from the recording. TASK-188 is DONE: `node scripts/phase1/acceptance.mjs`
  checks every matrix cell against its evidence and refuses what is forged, missing or stale,
  and `node scripts/phase1/nominal-flight.mjs` gives nine workflows per configuration, so 45 of
  the 51 cells pass on the A-01 machine. ArduPilot's own SITL
  errors keep the TASK-089 setting, whose default is ArduPilot's behaviour. That request of 2026-10-27 was first
  registered as TASK-124 on the physics-review branch, a number main already used.
  MirageSITL stays an external
  flight-dynamics model: do not modify
  ArduPilot `SIM_Multicopter`/`SIM_Plane` or the native firmware for these tasks
  without a recorded decision.

### Workspace and git discipline

Use the existing checkout (`/workspace/MirageSITL` in cloud). Cloud tasks are
already isolated; create another worktree only on explicit user request.
Start with `git status --short`, preserving other people's changes. Never
reset/clean or overwrite user files. Commit/push/deploy only within explicitly
authorized scope; **do not push without explicit user instruction**, and a new
task does not automatically authorize publication. Historical results do not
verify new changes; run the selected gates again.

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
node scripts/check-offline.mjs
node scripts/build-jsbsim.mjs
node scripts/check-jsbsim-native.mjs
node scripts/check-jsbsim-propellers.mjs
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
`vitest run`; select focused tests by an existing exact path. It must leave
tracked `test-results/` evidence unchanged: tests write generated reports to
temporary or ignored directories, and `tests/support/tracked-results.ts` fails
the run if `git status --porcelain -- test-results/` changes.
`npm run test:browser` keeps the same guarantee: Playwright writes the JUnit
report, traces and TASK-045 firmware captures under `test-results/browser/`,
which holds no tracked files, and the HTML report to `playwright-report/`; the
last configured reporter, `tests/support/tracked-results-reporter.ts`, repeats
the check after the other reporters have written their files. Omit CHROMIUM_PATH
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

`node scripts/run-sitl.mjs` is the bounded owned-process harness and
flight-trace validator. TASK-042 supplies `scripts/sitl/driver.mjs` and the
pymavlink 2.4.50 sidecar for Linux/WSL runs with pinned native ArduCopter
(source + ELF SHA-256); `node scripts/check-sitl-capture.mjs --input CAPTURE_DIRECTORY`
audits captured runs. Missing host prerequisites produce `BLOCKED_EXTERNAL`
(exit 2). A passing child-process or structural trace test alone is not proof
that ArduPilot flew. See the operational [runbook](docs/operations/runbook.md)
for environment variable names, trace schema, and ownership limitations.

TASK-158 adds `node scripts/phase1/nominal-flight.mjs [--configuration ID]...
[--chrome PATH] [--stock-settings]`, the Phase 1 nominal flight acceptance on the
reference Mac: it runs the opt-in `tests/browser/phase1-nominal.spec.ts` in
Google Chrome on the Mac's GPU, about 15 minutes for the five configurations, and
rewrites the tracked reports in `test-results/validation/phase1-nominal/`, and
the matrix only on the A-01 machine. `--stock-settings` is the negative control
of decision A-13, which fails the quad and never writes the matrix. It exits 0
when every workflow passed, 1 when one failed or was not reached, and 2 for
`BLOCKED_EXTERNAL`. Run speed is reported, not judged.

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

MirageSITL is non-commercial (stakeholder decision D-09, 2026-10-28). Do not
ask the stakeholder licensing questions; record license facts in
`config/offline-inventory.json` and `data/terrain/inventory.json` instead.

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

## 11. Communicating with the stakeholder

By the stakeholder's instruction of 2026-11-07, everything an agent tells the
stakeholder follows one protocol: every question, every report of a finished
task or increment, every status update and every explanation of a result.
Write as for a junior developer with little prior experience:

* **Background first.** Say what the thing is, what it is for and why it
  matters now, before any detail, number or option.
* **All the information needed.** Give every fact the reader needs to follow
  or decide, without assuming they remember earlier messages, tasks or
  decision IDs; name what a TASK, decision or parameter is when you use it.
* **Plain language.** Define each technical term the first time, use an
  analogy where it helps, and say what each number means in practice (what a
  0.39 m error or a 1 °/s limit means for the aircraft).
* **Decisions.** For each question, list the options with what each means for
  the user and the project, its cost and risk, and a recommendation with the
  reason. Ask one decision at a time, in the question itself.
* **Reports.** Say what now works and why it matters, then the evidence, then
  what is not done or not verified, and why. Never report only test counts
  and commit hashes.

Keep the full technical detail in the specifications, the roadmap and the
code; messages explain it, they do not replace it.
