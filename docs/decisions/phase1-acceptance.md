# Phase 1 acceptance parameters

English source. [Russian mirror](../ru/phase1-acceptance.md).

TASK-132 (S13, S19). This record holds the stakeholder's decisions on the
values that Phase 1 acceptance is measured against. PROJECT_SCOPE.md leaves
each of them open: hardware performance targets are explicit decisions, and
no universal FPS, Hz or accuracy is asserted. An agent never invents a value.
Until the stakeholder chooses one, its status is BLOCKED_DECISION.

The acceptance matrix is
[docs/validation/phase1-matrix.json](../validation/phase1-matrix.json).
Decision D-08 in the [Phase 1 plan](../PHASE1_PLAN.md) refers to items A-01
to A-08, A-11 and A-12; D-05 includes A-09.

## Decisions

| ID | Item | Value | Status | Owner | Decision date | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| A-01 | Apple Silicon reference machines (model, chip, memory, display) | The stakeholder's 15-inch Apple M5 MacBook Air with 32 GB of memory is the only acceptance machine; its display mode is recorded with each run. The Apple M4 MacBook Air used for TASK-073 (Mac16,12, 8-core GPU, 16 GB) receives an estimate only, never a verdict | Decided | Stakeholder | 2026-10-28 | TASK-158, TASK-188, TASK-189, TASK-191 |
| A-02 | Supported macOS versions | The stable macOS release current on 2026-10-28 and every later release; each run records the exact version | Decided | Stakeholder | 2026-10-28 | TASK-127, TASK-152, TASK-190 |
| A-03 | Supported Chrome versions | Minimum: the stable Chrome version current on 2026-10-28. Every later stable release is supported, and the current stable version is the default. Each run records the exact version | Decided | Stakeholder | 2026-10-28 | TASK-152, TASK-188, TASK-190 |
| A-04 | Physics rate for each matrix configuration | 400 Hz for every configuration; 800 and 1200 Hz stay selectable options. Amended 2026-11-03: runs with ArduPilot SITL use 800 Hz, the lowest of these rates at which stock ArduCopter arms; runs without ArduPilot keep 400 Hz | Decided | Stakeholder | 2026-10-28, amended 2026-11-03 | TASK-153, TASK-158, TASK-175, TASK-189 |
| A-05 | Real-time criteria: required ratio of simulated to wall time, allowed dropped intervals, and how the actual rate is reported | A real-time run averages at least 0.99 of simulated time per wall-clock second; every dropped interval is reported, never hidden. Automated lockstep runs may run slower than real time, and their actual ratio is reported | Decided | Stakeholder | 2026-10-28 | TASK-175, TASK-189, TASK-191 |
| A-06 | Rendering criteria for the Phase 1 scene: frame-time limits, canvas and display | 60 frames per second on the M5's built-in display with the Chrome window filling the screen: median frame time at most 16.680 ms and p99 at most 17.665 ms, the 60 FPS limits accepted on 2026-10-23. On macOS, which has no displayed-frame timing source, the frame clock's p99 is reported, not judged: a run passes with the median at most 16.680 ms and no frame interval above 25 ms (amended 2026-11-01) | Decided | Stakeholder | 2026-10-28, amended 2026-11-01 | TASK-185, TASK-191 |
| A-07 | Workload of the 16-motor one-hour run: signals, rates, flight task and effects | A repeated flight circuit for one continuous simulated hour, with wind and repeatable gusts on, recording every available signal at the default rate (A-09) | Decided | Stakeholder | 2026-10-28 | TASK-189 |
| A-08 | Storage budget for recordings | At most 2 GB per simulated hour; the UI warns when free disk space falls below 10 GB | Decided | Stakeholder | 2026-10-28 | TASK-163, TASK-189 |
| A-09 | Default common logging frequency | 50 Hz | Decided | Stakeholder | 2026-10-28 | TASK-162, TASK-163 |
| A-10 | Which paired or coaxial configuration the matrix uses (arm count and motor pairing) | X8: four arms with two coaxial motors each (8 motors). Other configurations, such as eight arms with 16 motors, are tested separately on request | Decided | Stakeholder | 2026-10-28 | TASK-138, TASK-188 |
| A-11 | TASK-073 is not a Phase 1 gate; its evidence is preserved | Decided | Confirmed by the stakeholder | Stakeholder | 2026-10-28 | TASK-191 |
| A-12 | Application memory budget | The whole application (browser tabs, Workers and the local services it starts, including ArduPilot SITL) stays below 8 GB of memory on the reference machine | Decided | Stakeholder | 2026-10-28 | TASK-144, TASK-162, TASK-189, TASK-191 |
| A-13 | Hover steadiness in the nominal flight acceptance | In each 10 s hold of TASK-158's still-air flight, the standard deviation of the roll, pitch and yaw rates in ArduPilot's own log is at most 1 °/s on each axis; flights in wind or gusts are not judged by it. All five configurations fly stock settings: the quad's 40 Hz `INS_GYRO_FILTER`, which it flew with from 2026-11-04, was dropped by the stakeholder on 2026-11-07 | Decided | Stakeholder | 2026-11-04 | TASK-158 |

## Context for the decisions

These observations come from existing evidence. They are not proposed values,
and none of them is Phase 1 acceptance evidence.

* **A-01 to A-03:** TASK-073 measured an Apple M4 MacBook Air (Mac16,12,
  8-core GPU, 16 GB) on macOS 27.0.1 with Chrome 155.0.8059.85, and the
  stakeholder's 15-inch Apple M5 MacBook Air; see [DEVICE_RATINGS.md](../DEVICE_RATINGS.md). Those runs
  rendered the G3 scene, not a Phase 1 session.
* **A-04:** The browser clock supports 400, 800 and 1200 Hz (ABI v2). S13 does
  not authorize raising the physics rate to offer 2 kHz recording.
  Amendment of 2026-11-03 (stakeholder, TASK-158): in a run with ArduPilot
  SITL the physics produces the autopilot's IMU samples, one per step in JSON
  lockstep, and stock ArduCopter refuses to arm while a gyro's rate is below
  1.8 times its 400 Hz main loop
  (`AP_InertialSensor::pre_arm_check_gyro_backend_rate_hz` at commit
  8ab6afd, and in the same words at V4.7.2). At 400 Hz it reports "PreArm: Gyro 0 rate 400Hz < loop rate*1.8
  720Hz", which TASK-153 found on 2026-10-31, after this decision. The
  alternatives were halving the autopilot's loop rate (`SCHED_LOOP_RATE` 200),
  which departs from the default of real flight controllers, and leaving the
  flight cells of the matrix blocked. The stakeholder chose 800 Hz, the rate
  of every SITL flight since TASK-153.
* **A-05:** The only real-time measurement is `node scripts/bench-physics.mjs`
  on Windows Node: 516.7 Hz executed for an 800 Hz target, limited by about
  16 ms timer wakeups and the 8-step catch-up cap. It is neither macOS nor
  browser evidence, and the catch-up cap and drop thresholds are never relaxed
  to hide drops.
* **A-06:** The TASK-073 limits (median 16.680 ms, p99 17.665 ms at 1920 x
  1080 and 1x) were decided on 2026-10-23 for the G3 scene with terrain,
  buildings, thermal and FPV on the least performant integrated GPU. Whether
  the Phase 1 scene reuses them is part of this decision.
  Amendment of 2026-11-01 (stakeholder): Chrome's frame clock on the M5 moves
  about 1 ms around each refresh, so its p99 read 17.670 ms with no late
  frame, both on 2026-10-22 (TASK-073, fixture scene) and on 2026-11-01
  (TASK-185 flight view: 3,601 and 1,801 intervals, maximum 17.680 ms). macOS
  has no displayed-frame timing source (TASK-073, user decision of
  2026-10-22), so on macOS the p99 is reported and the run passes when the
  median is at most 16.680 ms and no interval exceeds 25 ms, 1.5 refresh
  intervals at 60 Hz, so that no frame was skipped. Windows keeps the median
  and p99 limits.
* **A-07 and A-08:** S13 requires the UI to estimate MB per simulated hour
  and to show actual growth. An example such as 2 MB per hour is not a
  guaranteed size.
* **A-09:** S13 leaves the default numeric frequency undecided. Rates such as
  10 Hz must be selectable where sources support them, and 2 kHz only for
  sources that produce at least that many samples.
* **A-10:** S19 requires "a paired/coaxial configuration" alongside the
  eight-arm, 16-motor maximum.

* **A-13:** TASK-158 found on 2026-11-03 that a height criterion cannot see an
  attitude oscillation. At stock settings the S19 quad X holds 5 m within 0.1 m
  while its roll rate swings ±85 °/s at 10 Hz, a standard deviation of 61 °/s;
  the other four configurations measure at most 0.22 °/s. The stakeholder chose
  to require a steady hover, with a limit about four times the steady aircraft's
  worst reading. For the quad, the stakeholder chose the 40 Hz gyro filter over
  rate gains at 0.8 of stock and over a redesign of the test quad. This is an
  operational criterion for that flight, not a comparison with a measured
  aircraft, so scope amendment SA-01 does not apply to it.
  `node scripts/phase1/nominal-flight.mjs --stock-settings` keeps the negative
  control: the quad at stock settings failed it until TASK-098 changed the rotor inflow.
  On 2026-11-06 (TASK-198) a bisection on `8ab6afd` read a roll of 59.39 °/s on the commit
  before TASK-098 and 0.08 °/s on it, and the control now reads 0.09 °/s on V4.7.2. So this
  flight no longer shows a failure, and `tests/integration/phase1-nominal.test.ts` holds the
  limit to hand-built readings. On 2026-11-07 the stakeholder dropped the filter. The quad then flew its acceptance at stock settings and held body-rate standard deviations of 0.10, 0.09 and 0.05 °/s (roll, pitch, yaw); the other four, flown again because the rules file changed, held at most 0.29 °/s, and the matrix holds 51 PASS.

## TASK-073 reconciliation (A-11)

TASK-073's gate was measured on Windows-hosted integrated GPUs with a scene
that includes the thermal camera and FPV effects. The approved scope of
2026-10-28 removes Windows support, places the thermal camera in the backlog,
and states that historical Windows results do not substitute for macOS
product acceptance. TASK-073 therefore does not gate Phase 1. Its status line,
captures, analyzer reports and device ratings stay as they are: they are
neither relabeled nor deleted. Phase 1 rendering is accepted against A-06 on
the A-01 machines.

The unmerged `analyze_repo_next_task` branch holds a Mac M4 test procedure and
a TASK-073 acceptance plan from 2026-10-20 (`docs/hardware/mac-m4-final-test.md`
on that branch). Phase 1 takes no acceptance criterion from it: the procedure
predates the approved scope, and its final stage gates on TASK-073. Its static,
native, unit and browser stages can seed the TASK-127 and TASK-152 checklists.
The branch stays unmerged (recorded by TASK-134 on 2026-10-28).

## Acceptance matrix

`docs/validation/phase1-matrix.json` lists the S19 configurations and
workflows with one verdict per cell:

| Field | Meaning |
| --- | --- |
| `configurations` | Quad, hexa and octo with one motor per arm; X8, four arms with two coaxial motors each (A-10); eight arms with two motors each (16 motors) |
| `workflows` | Each workflow's criterion, the configurations it applies to (`each-configuration`, a list, or `global`) and the tasks that deliver it |
| `cells[].verdict` | PASS, FAIL, BLOCKED_EXTERNAL, BLOCKED_DECISION or NOT_RUN |
| `cells[].evidence` | `null`, or the evidence path and its SHA-256 |
| `cells[].blockedBy` | The decisions a BLOCKED_DECISION cell waits on |

The matrix has 51 cells: 9 workflows for each of the 5 configurations, the
one-hour run for the 16-motor configuration, and 5 global workflows. On
2026-10-28 every value is decided and all 51 cells are NOT_RUN because no
evidence exists yet. TASK-188 aggregates
evidence into the matrix; missing evidence stays NOT_RUN, and failures are
preserved. TASK-158 writes the profile-creation, output-mapping, start,
flight-task and pause-resume cells of each configuration from
`node scripts/phase1/nominal-flight.mjs`, only on the A-01 machine. Each cell
cites its configuration's evidence report in
`test-results/validation/phase1-nominal/` with the report's SHA-256. TASK-188
adds the parameter-changes, recording, reopen-results and unsupported-refusal
cells to the same run, and `node scripts/phase1/acceptance.mjs` checks every cell
against its evidence: a forged, missing or invalid report is refused and fails
the matrix, a stale one leaves its cell to run, and a failure stays a failure
while its report stands.

## Recording a decision

When the stakeholder decides an item, record the value, owner and date in the
table above in both languages, then update the dependent tasks. A value
recorded without a stakeholder decision date is invalid.
