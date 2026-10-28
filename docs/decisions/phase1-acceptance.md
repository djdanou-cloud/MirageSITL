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
to A-08 and A-11; D-05 includes A-09.

## Decisions

| ID | Item | Value | Status | Owner | Decision date | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| A-01 | Apple Silicon reference machines (model, chip, memory, display) | The stakeholder's Apple M5 MacBook Air is the only acceptance machine; its memory and display are recorded with each run. The Apple M4 MacBook Air used for TASK-073 (Mac16,12, 8-core GPU, 16 GB) receives an estimate only, never a verdict | Decided | Stakeholder | 2026-10-28 | TASK-158, TASK-188, TASK-189, TASK-191 |
| A-02 | Supported macOS versions | Not chosen | BLOCKED_DECISION | Stakeholder | — | TASK-127, TASK-152, TASK-190 |
| A-03 | Supported Chrome versions | The latest stable Chrome; each run records its exact version | Decided | Stakeholder | 2026-10-28 | TASK-152, TASK-188, TASK-190 |
| A-04 | Physics rate for each matrix configuration | Not chosen | BLOCKED_DECISION | Stakeholder | — | TASK-153, TASK-175, TASK-189 |
| A-05 | Real-time criteria: required ratio of simulated to wall time, allowed dropped intervals, and how the actual rate is reported | Not chosen | BLOCKED_DECISION | Stakeholder | — | TASK-175, TASK-189, TASK-191 |
| A-06 | Rendering criteria for the Phase 1 scene: frame-time limits, canvas and display | Not chosen | BLOCKED_DECISION | Stakeholder | — | TASK-185, TASK-191 |
| A-07 | Workload of the 16-motor one-hour run: signals, rates, flight task and effects | Not chosen | BLOCKED_DECISION | Stakeholder | — | TASK-189 |
| A-08 | Storage budget for recordings | Not chosen | BLOCKED_DECISION | Stakeholder | — | TASK-163, TASK-189 |
| A-09 | Default common logging frequency | Not chosen | BLOCKED_DECISION | Stakeholder | — | TASK-162, TASK-163 |
| A-10 | Which paired or coaxial configuration the matrix uses (arm count and motor pairing) | Not chosen | BLOCKED_DECISION | Stakeholder | — | TASK-138, TASK-188 |
| A-11 | TASK-073 is not a Phase 1 gate; its evidence is preserved | Decided | Recorded | Stakeholder (PROJECT_SCOPE.md) | 2026-10-28 | TASK-191 |

## Context for the open items

These observations come from existing evidence. They are not proposed values,
and none of them is Phase 1 acceptance evidence.

* **A-01 to A-03:** TASK-073 measured an Apple M4 MacBook Air (Mac16,12,
  8-core GPU, 16 GB) on macOS 27.0.1 with Chrome 155.0.8059.85, and a 14-inch
  Apple M5 MacBook; see [DEVICE_RATINGS.md](../DEVICE_RATINGS.md). Those runs
  rendered the G3 scene, not a Phase 1 session.
* **A-04:** The browser clock supports 400, 800 and 1200 Hz (ABI v2). S13 does
  not authorize raising the physics rate to offer 2 kHz recording.
* **A-05:** The only real-time measurement is `node scripts/bench-physics.mjs`
  on Windows Node: 516.7 Hz executed for an 800 Hz target, limited by about
  16 ms timer wakeups and the 8-step catch-up cap. It is neither macOS nor
  browser evidence, and the catch-up cap and drop thresholds are never relaxed
  to hide drops.
* **A-06:** The TASK-073 limits (median 16.680 ms, p99 17.665 ms at 1920 x
  1080 and 1x) were decided on 2026-10-23 for the G3 scene with terrain,
  buildings, thermal and FPV on the least performant integrated GPU. Whether
  the Phase 1 scene reuses them is part of this decision.
* **A-07 and A-08:** S13 requires the UI to estimate MB per simulated hour
  and to show actual growth. An example such as 2 MB per hour is not a
  guaranteed size.
* **A-09:** S13 leaves the default numeric frequency undecided. Rates such as
  10 Hz must be selectable where sources support them, and 2 kHz only for
  sources that produce at least that many samples.
* **A-10:** S19 requires "a paired/coaxial configuration" alongside the
  eight-arm, 16-motor maximum.

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
| `configurations` | Quad, hexa and octo with one motor per arm; a paired or coaxial configuration (A-10); eight arms with two motors each (16 motors) |
| `workflows` | Each workflow's criterion, the configurations it applies to (`each-configuration`, a list, or `global`) and the tasks that deliver it |
| `cells[].verdict` | PASS, FAIL, BLOCKED_EXTERNAL, BLOCKED_DECISION or NOT_RUN |
| `cells[].evidence` | `null`, or the evidence path and its SHA-256 |
| `cells[].blockedBy` | The decisions a BLOCKED_DECISION cell waits on |

The matrix has 51 cells: 9 workflows for each of the 5 configurations, the
one-hour run for the 16-motor configuration, and 5 global workflows. On
2026-10-28, 41 cells are NOT_RUN because no evidence exists, and 10 are
BLOCKED_DECISION: the 9 cells of the paired or coaxial configuration (A-10),
and the one-hour run (A-01 to A-05, A-07 and A-08). TASK-188 aggregates
evidence into the matrix; missing evidence stays NOT_RUN, and failures are
preserved.

## Recording a decision

When the stakeholder decides an item, record the value, owner and date in the
table above in both languages, then update the dependent tasks. A value
recorded without a stakeholder decision date is invalid.
