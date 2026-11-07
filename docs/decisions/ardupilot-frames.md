# ArduPilot frame and output feasibility (TASK-128)

English source. [Russian mirror](../ru/ardupilot-frames.md).

Status: DONE, 2026-10-29. The stakeholder decided D-01 on 2026-11-06: stable
**ArduCopter V4.7.2**, commit `fb773567896014da007bca58358704d4a0d8516f` (section "The move to V4.7.2" at the end).
Up to that section this record is the original evidence on the then pinned
**ArduCopter V4.8.0-dev**, commit
`8ab6afde107a91df1b5f60ade8f333cb8a61b190`. It changed no firmware pin or native source. This record checks stock frames and the stock Lua motor-matrix
interface; it does not approve a new release/default firmware version.

## Source-derived catalog

`tests/fixtures/sitl/frames.json` records the pinned source hashes, version,
conditional capacities, motor-function enums, five layouts and Python-packed
16/32-channel servo oracles. Generate only this catalog from the clean source:

```bash
.cache/task-127/venv/bin/python tests/fixtures/sitl/generate.py --frames-only --source .cache/task-127/ardupilot --check
```

Without `--check` the command writes the frame catalog. This separate mode does
not regenerate `json-protocol.json` or the TASK-089 sensor/error catalog.
The source X tables give motor azimuth, yaw factor and test order. The normalized
roll/pitch factors follow the source's 0.5 maximum scaling. Position is body FRD,
with an explicitly synthetic 0.2 m arm radius; paired heights are ±0.03 m.
Those lengths and inertias are harness inputs, not measured upstream geometry.
The paired-16 layout is a declared eight-arm, two-motor-per-arm configuration,
initialized through stock `MotorsMatrix:add_motor_raw` and `MotorsMatrix:init(16)`.
Its Lua file is copied into the capture and its ready message is retained as
original MAVLink. No `SIM_Multicopter`, `SIM_Plane` or firmware patch is used.

| Frame ID | Class/type | Motors | JSON channels | Test sequence → motor IDs |
| --- | --- | --- | --- | --- |
| quad-x | 1/1 | 4 | 16 | 1, 4, 2, 3 |
| hexa-x | 2/1 | 6 | 16 | 5, 1, 4, 6, 2, 3 |
| octo-x | 3/1 | 8 | 16 | 1, 3, 8, 4, 2, 6, 7, 5 |
| x8 | 4/1 | 8 | 16 | 1, 6, 4, 7, 3, 8, 2, 5 |
| paired-16 | 15/1 + stock Lua | 16 | 32 | 1 through 16 |

Motor IDs and test sequence are different concepts. The selected probe maps
motor N to output N explicitly. Motor functions are 33–40 for motors 1–8,
82–85 for 9–12 and 160–179 for 13–32. A uniform `32 + motor` rule is wrong
above motor 8. Outputs not used by a motor are explicitly disabled.
The SITL source's 4096 KiB program-size setting enables scripting and 32 servo
slots; motors have a 32-slot bound with scripting, versus 12 without it.
`SERVO_32_ENABLE=0/1` selects 40/72-byte JSON packets (16/32 channels); using
32 wire slots does not increase the Phase 1 maximum of 16 physics motors.

The pinned firmware renamed `ARMING_CHECK` to `ARMING_SKIPCHK`. Frame profiles
explicitly set and read back **`ARMING_SKIPCHK=0`**, meaning no checks skipped,
with EKF3 enabled. The first probe refused to proceed when the legacy name
could not be read back; the capture is retained. Checks are not disabled.

## Native probe and capture contract

`scripts/run-sitl-frames.mjs FRAME_ID motor-test|flight NEW_CAPTURE_DIRECTORY`
uses the same owned process-group launcher and checked native executable as
TASK-127. It supplies private working directories and loopback ports. Every
case records source, binary, scalar WASM and model hashes, the host, parameter
requests/read-backs, original incoming/outgoing MAVLink and original servo bytes.
The driver refuses unknown frames, non-stock IMU ownership, EW, a reused capture
directory, unexpected packet width/rate, gaps, failed read-back or absent Lua
initialization. The limits are 120 s wall time, 96,000 physics steps and 64 MiB
per audit input file. The legacy four-motor trace v2 remains a separate contract.

The new `run.json` is identified by `schemaVersion=1`, `task=TASK-128`,
`frameId` and `phase`. `servo.raw` concatenates full fixed-width original
packets; `physics.ndjson` has one time/frame/position/velocity/WXYZ-quaternion
record per packet. Flight samples retain the original frame IDs at stride 8.
`frame.parm`, optional `frame.lua`, `telemetry.ndjson`, `mavlink.raw`, `tx.raw`,
`firmware.log` and owned DataFlash logs remain with the capture.

* **motor-test:** a stationary, explicitly constrained synthetic bench, not a
  flight. Native `MAV_CMD_DO_MOTOR_TEST` commands request one 1200 µs motor for
  0.3 s. Every command needs a real accepted ACK and at least eight matching
  servo frames. No other motor may rise above idle; unused outputs must stay
  at their original baseline. The stock common transition from 0 to 1000 µs
  is idle, not a second motor spinning. Tests wait for return to idle before
  the next command. Stock motor-test temporary failsafe handling ends with
  `motor_test_stop`; the flight is a separate fresh process.
* **flight:** a free six-DOF Rust-body simulation driven by the native outputs.
  The synthetic thrust curve, motor lag, mass/inertia and point forces are
  declared in `referenceConfiguration`. An inelastic pad prevents penetration
  and never supplies flight control or resets attitude. The gate requires
  native healthy arming, takeoff ≥3 m, hover at 10 m ±1 m for ≥10 s (truth and
  autopilot), then landing ≤0.5 m and disarm, with fresh heartbeat/EKF/altitude
  and no frame gap. Neither ideal coaxial loads nor successful hover establish
  measured aerodynamic or wake fidelity; TASK-101/144 remain separate.

`check-raw.py` uses pymavlink 2.4.50 to check CRC and exact observation prefixes,
parameter read-backs and the original outbound motor commands, including their
float32 duration. `check-sitl-frames.mjs` checks those audit hashes, derives
expected parameters from the catalog, verifies every raw servo packet and
replays the physics through real scalar WASM. Position/velocity/quaternion
replay tolerance is 1e-10 (m, m/s, dimensionless), with q and −q equivalent.
Flight modes, health, freshness, altitude and stages are joined to original
telemetry. A motor bench cannot satisfy flight acceptance. Reports never enable
browser READY or certify real-time timing.

## Commands

The native source, binary and Python are the checked TASK-127 artifacts. Initial
build/dependency setup is in [macos-sitl.md](macos-sitl.md).

```bash
export MIRAGE_SITL_SOURCE="$PWD/.cache/task-127/ardupilot"
export MIRAGE_SITL_BINARY="$PWD/.cache/task-127/build-stock/sitl/bin/arducopter"
export MIRAGE_SITL_PYTHON="$PWD/.cache/task-127/venv/bin/python"
node scripts/run-sitl-frames.mjs paired-16 motor-test .cache/task-128/example-motor-new
"$MIRAGE_SITL_PYTHON" scripts/sitl/check-raw.py --input .cache/task-128/example-motor-new
node scripts/check-sitl-frames.mjs --input .cache/task-128/example-motor-new --output .cache/task-128/example-motor-audit.json
node scripts/run-sitl-frames.mjs paired-16 flight .cache/task-128/example-flight-new
"$MIRAGE_SITL_PYTHON" scripts/sitl/check-raw.py --input .cache/task-128/example-flight-new
node scripts/check-sitl-frames.mjs --input .cache/task-128/example-flight-new --output .cache/task-128/example-flight-audit.json
```

## Numerical and allocation checks

Independent test literals and Python source extraction check all 42 motor
azimuths, signs, test orders and output functions. Analytic cross products,
collective hover balance, freefall and pad specific force check the real WASM
reference. Motor evidence tests reject wrong/simultaneous/missing output and
movement of unused outputs. Tests build their own scalar/SIMD artifacts in
a temporary directory and leave tracked reports unchanged.

The G1 probe runs the 16-rotor reference and real Rust WASM body. After 10,000
representative valid reset poses and four million warmup steps, it measures
three pairs of one/two million steps, observes GC and stable WASM memory,
and requires zero GC events and an N/2N allocation slope below 0.01 byte/step,
with an allocating positive control. Setup, observers and I/O are excluded.
The initial identity/exact-unit-norm-only warmup exposed a V8 deoptimization
in the existing body reset validator when later roundoff made the norm residual
nonzero. Non-identity poses alone did not resolve it; exercising a valid
near-unit pose within the existing 1e-6 reset envelope did. No runtime validator,
physics threshold, GC assertion or benchmark acceptance limit was weakened.
The failed probes and deoptimization traces remain in `.cache/task-128/`.

```bash
node --expose-gc --single-threaded --max-semi-space-size=64 tests/support/frames-allocation.mjs --wasm packages/wasm-bet/dist/mirage_bet.scalar.wasm --out .cache/task-128/allocation-final.json
npx --no-install vitest run tests/sitl-frames.test.ts tests/sitl-quad.test.ts tests/fixtures.test.ts
```

## Completed native evidence

All ten final captures pass on Apple M5, macOS 26.6 / Darwin 25.6 arm64,
Node 24.22.1 and pymavlink 2.4.50. The stock arm64 Mach-O binary built with
Apple Clang 21 has SHA-256
`d47c1f64934f1911e4d6fb88da8aa18c21c9e438f3ae687b0e56eb13807e08e4`.
The frame catalog SHA-256 is
`e17967e0f5b12d43862f9ffb8ec2d945d362b4ef6a17ef200efdd8d3dde9b38e`;
scalar WASM is
`a8b73c42ea8e269f87d200813b83e1d544a9d086c9ed707288bb394b5bb5f344`.
D-01's frame/output compatibility requirement is satisfied by this pinned
version, including stock scripting for 16 motors. Firmware distribution and
application-session integration remain their separate tasks.

| Frame | Motor checks | Bench frames | Flight frames | Hold s | Truth hold range m |
| --- | --- | --- | --- | --- | --- |
| quad-x | 4/4 | 10881 | 67233 | 10.19 | 9.765494–9.990083 |
| hexa-x | 6/6 | 12322 | 67233 | 10.19 | 9.765099–9.990430 |
| octo-x | 8/8 | 13764 | 67393 | 10.19 | 9.773524–9.990159 |
| x8 | 8/8 | 13764 | 67393 | 10.19 | 9.773615–9.989921 |
| paired-16 | 16/16 | 19533 | 67257 | 10.19 | 9.785518–9.987085 |

The actual native command for every row used the environment above and
`node scripts/run-sitl-frames.mjs FRAME PHASE DIRECTORY`, with FRAME equal to
the table ID, PHASE `motor-test` or `flight`, and DIRECTORY
`.cache/task-128/final-FRAME-motor` or `.cache/task-128/final-FRAME-flight`.
Each invocation exited 0. Every motor had 240–242 original active servo frames;
all flights had 4,161 scored samples, fresh healthy EKF telemetry and zero
transport gaps/duplicates/drops. All 406,773 frames replay with zero position
and quaternion error. The aggregate with report hashes is
`.cache/task-128/completion.json`; captures and audits are local ignored
artifacts, not bundled firmware or checked-in flight data. To repeat the audits:

```bash
for frame in quad-x hexa-x octo-x x8 paired-16; do
  for phase in motor flight; do
    capture=".cache/task-128/final-${frame}-${phase}"
    .cache/task-127/venv/bin/python scripts/sitl/check-raw.py --input "$capture"
    node scripts/check-sitl-frames.mjs --input "$capture" --output "${capture}-audit.json"
  done
done
```

All 20 raw/physics audit invocations exit 0. `allocation-final.json` records
13,000,000 actual steps, six measurement windows with zero GC, zero N/2N
byte-per-step slope, stable WASM memory and 61 positive-control GC events.
The focused eight-file suite passes 27/27 tests; `npm run build` (including
strict typecheck) and checkout lint pass. Lint uses
`npm run lint -- --ignore-pattern '.claude/worktrees/**'` to exclude unrelated
nested worktrees. Vite retains its existing large-chunk warning.
The legacy quad regression `.cache/task-127/capture-003` and its raw/physics
audit `.cache/task-128/legacy-quad-regression.json` pass separately.
`npm run check:docs` checks 30 bilingual pairs, 192 tasks and six layouts;
semantic translation parity is reviewed, and `git diff --check` passes.
TASK-143 sensor files, the upstream source and tracked historical reports
remain unchanged. Earlier failed/prototype captures remain available and are
excluded from the final matrix.

## Re-verification — 2026-10-30

The uncommitted TASK-128 tree was run again on baseline `78b4ee0` on the same
Mac with the same binary, frame catalog and scalar WASM hashes, because the
earlier captures do not record the frame-driver source hash. The catalog check
`generate.py --frames-only --check` passes against the clean pinned source.
Captures are in `.cache/task-128/rerun-20261030/`, named `FRAME-motor` and
`FRAME-flight`, each with its audit report and command logs. All ten runs, all
ten `check-raw.py` audits and all ten `check-sitl-frames.mjs` audits exit 0:

| Frame | Motor checks | Bench frames | Flight frames | Hold s | Truth hold range m |
| --- | --- | --- | --- | --- | --- |
| quad-x | 4/4 | 10881 | 67257 | 10.20 | 9.763896–9.989826 |
| hexa-x | 6/6 | 12322 | 67257 | 10.19 | 9.785475–9.987057 |
| octo-x | 8/8 | 13764 | 67233 | 10.19 | 9.765425–9.989636 |
| x8 | 8/8 | 13764 | 67257 | 10.19 | 9.785621–9.986953 |
| paired-16 | 16/16 | 19533 | 67257 | 10.19 | 9.785518–9.987085 |

Each motor had 240–242 active servo frames, each flight 4,161 scored samples
with zero gaps, duplicates and drops, and all 406,525 frames replay with zero
position and quaternion error. Some flight frame counts differ slightly from
the 2026-10-29 matrix (quad-x 67,233 then 67,257); the cause was not
investigated, and every value is inside the unchanged limits. The repeated allocation
probe `rerun-20261030/allocation.json` records 13,000,000 steps, zero GC in
all six windows, a zero N/2N byte-per-step slope, stable WASM memory and 61
positive-control GC events.

## Copter-4.7.2 beside the pin — 2026-11-06

Evidence for D-01, requested by the stakeholder on 2026-11-06 ("Test Copter-4.7.2
first"). When it was written it selected nothing: the pin was still `8ab6afd`, and these runs
were made in a throwaway copy of the repository with its lock set to the stable release
**ArduCopter V4.7.2**, commit `fb773567896014da007bca58358704d4a0d8516f`, dated
2026-10-11, four days before the pinned development commit. No firmware patch was
applied. Same Mac, binary SHA-256
`09413f3c55f8073c06b22f8353ccff4c85db7223c844b66123702b3660797da5`. The captures
stay outside the repository.

**Installation and frames.** `node scripts/install-macos.mjs` installed it from
nothing into a new home, with `copter` built in 54.457 s. The frame catalog
generated from 4.7.2 holds the same 5 configurations and 42 motors, row for row;
only the source hashes and the version differ. The motor limit moved from
`AP_Motors_Class.h` to `AP_Motors_config.h` with the same values, and the 32 servo
slots, 32-channel JSON packets, `SERVO_32_ENABLE`, `MotorsMatrix:add_motor_raw` and
the motor functions are unchanged. `ARMING_SKIPCHK` already exists in 4.7. The
declination table is the same file, and the 40 MAVLink messages the dialect lock
lists have the same definitions.

**Frame probes.** All ten runs, ten `check-raw.py` audits and ten
`check-sitl-frames.mjs` audits exit 0, with zero gaps, duplicates and drops, and
all 406,085 frames replay with zero position and quaternion error:

| Frame | Motor checks | Bench frames | Flight frames | Hold s | Truth hold range m |
| --- | --- | --- | --- | --- | --- |
| quad-x | 4/4 | 10881 | 67129 | 10.20 | 9.767398–9.984110 |
| hexa-x | 6/6 | 12322 | 67145 | 10.20 | 9.753268–9.989921 |
| octo-x | 8/8 | 13764 | 67145 | 10.20 | 9.737805–9.985086 |
| x8 | 8/8 | 13764 | 67129 | 10.20 | 9.766275–9.984296 |
| paired-16 | 16/16 | 19533 | 67273 | 10.21 | 9.738670–9.984216 |

**Flights through the application.** `node scripts/phase1/nominal-flight.mjs`
passed 5 of 5 configurations and all nine workflows of each, in real time. The
reports name ArduCopter V4.7.2. The standard deviation of the body rates in each
10 s hold, roll/pitch/yaw in °/s, reads alike on both versions:

| Configuration | `8ab6afd` | V4.7.2 |
| --- | --- | --- |
| quad | 0.07/0.07/0.05 | 0.07/0.08/0.04 |
| hexa | 0.08/0.16/0.08 | 0.10/0.14/0.08 |
| octo | 0.12/0.05/0.02 | 0.12/0.07/0.02 |
| x8 | 0.07/0.10/0.01 | 0.05/0.07/0.01 |
| octo-paired-16 | 0.13/0.19/0.03 | 0.11/0.19/0.03 |

**Browser suite.** With its tests pointed at this build, 153 passed, 2 failed, 23
were skipped and 2 did not run, against 156 passed, 1 failed and 23 skipped on
`8ab6afd`, whose failure was a test's assumption that has since been fixed. The
first failure was `manual-connect.spec.ts`: the application correctly refused a
SITL from a commit it had not verified, because `verifiedCommits` in the copy
still read the pinned catalog, and the file's two later serial tests then did not
run. With that one value and the test's version text changed, the file passes 3 of
3. The second failure is a real difference, below.

**What 4.7.2 lacks.** Its parameter metadata lists 5,687 parameters against 5,799:
131 exist only at the pin and 19 only at 4.7.2. Of the 33 error sources, 3 name
parameters that 4.7.2 does not have: `imu.board-trim` (`SIM_BRD_TRIM`; 4.7.2 has
`SIM_ACC_TRIM`), `baro.ground-effect` (`SIM_BARO_GEFF_M`, `SIM_BAR2_GEFF_M`,
`SIM_BAR3_GEFF_M`) and `gnss.position-noise` (`SIM_GPS1_HNSE`, `SIM_GPS2_HNSE`). A
run that switches these errors off stops at its start with "ArduPilot did not
confirm the initial parameters: SIM_BAR2_GEFF_M does not exist in this ArduPilot
build", so `parameters-tab.spec.ts` fails there. At 4.7.2 `SIM_GPS1_NOISE` moves
altitude only, so the Sensors tab's GNSS horizontal position error has no
parameter to set. The sensor catalog does not regenerate as it is: 12 of the 53
source lines it cites read differently, 6 of them because the compass code left
`SIM_Compass.cpp`.

**What moving would take.** The lock, the generated catalogs and the parameter
metadata; the 3 error sources and the 12 cited lines; a decision on the GNSS
horizontal error; the commit named in 22 source files and 57 test files; and the
whole matrix again, whose evidence names `8ab6afd`.

**Not run on 4.7.2:** `npm test`, the one-hour flight and the five global workflows
of the acceptance matrix, and any real aircraft. The browser suite's 23 skipped
tests include the WASM firmware specs.

## The move to V4.7.2 — 2026-11-06 (decision D-01, TASK-198)

The stakeholder decided in the words "Move to 4.7.2". `scripts/sitl.lock.json` now pins
stock ArduCopter V4.7.2, with no firmware patch. The 16-motor path stays stock:
`FRAME_CLASS` 15 with the Lua scripting matrix. `node scripts/install-macos.mjs` installed
it into a new home, with `copter` built in 53.175 s. The arm64 Mach-O is 4,821,160 bytes,
SHA-256 `5ea7bdeabb8d6540784f444a2a722d78bd6b1e90b389352690fcac34bd8ab841`; the hash depends on the folder it is built in, so the throwaway copy
above has another. The frame catalog, the SITL source catalog, the JSON protocol fixture,
the parameter metadata (this commit alone) and the declination table are generated from it.

The ten probes repeated on the moved tree: all ten runs and twenty audits exit 0, with zero
gaps, duplicates and drops, and all 406,613 frames replay with zero position and quaternion
error.

| Frame | Motor checks | Bench frames | Flight frames | Hold s | Truth hold range m |
| --- | --- | --- | --- | --- | --- |
| quad-x | 4/4 | 10881 | 67273 | 10.21 | 9.765762–9.983820 |
| hexa-x | 6/6 | 12322 | 67273 | 10.20 | 9.765828–9.984049 |
| octo-x | 8/8 | 13764 | 67273 | 10.21 | 9.738442–9.985262 |
| x8 | 8/8 | 13764 | 67273 | 10.20 | 9.767991–9.983418 |
| paired-16 | 16/16 | 19533 | 67257 | 10.20 | 9.766755–9.983961 |

What moved with it, because V4.7.2 has no such parameters: `imu.board-trim` is now
`SIM_ACC_TRIM`, which turns the accelerometer only; `baro.ground-effect` has no owner, since
the firmware has no such error; `gnss.position-noise` is the vertical `SIM_GPSn_NOISE` alone.
So the Sensors tab's GNSS horizontal position error is disabled, with its reason, the NEO-M9N
preset reports that it applies nothing, and a value in an earlier profile version still reads
and is applied by nothing. Experiments recorded on `8ab6afd` carry sensor snapshot 2 and are
refused with a reason that names it. The opt-in `imu-noise-floor` patch is rebased onto V4.7.2
and stays unused under D-10.

What did not move: the browser WASM firmware, which is not a Phase 1 path, keeps
`native/ardupilot/source.lock.json` at `8ab6afd` with its patches, parity tests and evidence,
and moving it needs its own task; the DataFlash fixture stays the V4.8.0-dev log it is;
and `docs/hardware/ardupilot-sensors.md`, whose hash the sensor presets bind, keeps its
citations at `8ab6afde`. The user-setting names it lists all exist at V4.7.2 except `GNDEFF_ALT`
and `GNDEFF_TMO`, which are `GND_EFFECT_COMP` there.

The evidence on V4.7.2 is in TASK-198: the whole acceptance matrix, the five aircraft, the
16-motor hour, TASK-129's pauses, the parameter and sensor runs and the EW limits.
