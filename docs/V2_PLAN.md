# MirageSITL version 2: engineering feedback plan

[Russian mirror](ru/V2_PLAN.md)

Status: proposal, 2026-10-20. Nothing in this document is implemented yet. It
turns two engineers' comments (19.10.2026) into a plan for version 2. Items
reuse existing MirageSITL components where possible and name the decisions
that still need an owner. [Section 7](#7-work-carried-over-from-the-existing-roadmap-and-documentation)
adds the open work already recorded elsewhere in the repository.

## 1. Who this is for

The readers know the current ArduPilot workflow: Mission Planner, its
DataFlash Log Viewer (graphs of `.bin` logs) and the parameter list. This plan
keeps that vocabulary. A short glossary is in [section 8](#8-glossary).

MirageSITL today already provides:

* a browser flight simulator with a 400/800/1200 Hz physics loop;
* an ArduPilot software-in-the-loop (SITL) connection through ArduPilot's JSON
  physics interface (TASK-041);
* MAVLink telemetry parsing (TASK-037);
* a flight recorder with replay and export (TASK-076/077/081);
* reference rotor models (blade element theory, inflow, coaxial interaction:
  TASK-020–024), checked against UIUC propeller wind-tunnel data (TASK-033).

It does **not** yet read DataFlash `.bin` logs, and its physics backend is
still the demo model.

## 2. Requests, as received

| ID | Source | Request |
| --- | --- | --- |
| R1 | Engineer 1 | Add a log viewer to the SITL, with two-log comparison and a log finder. |
| R2 | Engineer 1 | Show graphs on screen live, during flights. |
| R3 | Engineer 1 | Rethink and simplify how log parameters are grouped; add presets. |
| R4 | Engineer 1 | More colors, line styles and line widths for graphs. |
| R5 | Engineer 1 | Plot one or more ArduPilot *parameters* (not logged values), so that, for example, a PID change made in flight is visible on the graph. |
| R6 | Engineer 1 | Add the same features to DrorPlanner. |
| R7 | Engineer 2 | Show parameters with enough precision: values such as 0.00017 (typical D and FF gains) currently show as 0.00. |
| R8 | Engineer 2 | Model each rotor's thrust versus power, torque, tilting moments about two axes, RPM and motor heating. Bench data at known pressure and temperature can be rescaled to other conditions. |
| R9 | Engineer 2 | In flight the rotor sees oblique airflow; its properties depend strongly on airflow speed and angle. Include prop wash when air comes from below (fast descent, hard braking). Provide data for all airflow speeds and angles. |
| R10 | Engineer 2 | Rotors interact through their near-field flows; account for that. |
| R11 | Engineer 2 | Full aerodynamics is too expensive per time step: compute it in an external aerodynamic simulator and feed SITL with tables. Find out how SITL models this by default. |
| R12 | Engineer 2 | Ground effect is lower priority, but worth checking given recent poor precision landings of a lightly loaded drone. |
| R13 | Engineer 2 | Ignore the drone flying into its own earlier wake: flight-mode transitions are slow enough to treat each state as steady. |
| R14 | Engineer 2 | Until aerodynamic tables exist, provide a stand-in model, or at least understand SITL's default. |

Overall goal (Engineer 2): define the drone, compute its properties in an
aerodynamic simulator, then run SITL with that data to tune control and
trajectories.

## 3. Workstream A: log viewer (R1–R7)

### A1. Read ArduPilot DataFlash logs (prerequisite)

MirageSITL's recorder stores its own records; it cannot open `.bin` logs from
the flight controller or from SITL.

* Add a DataFlash parser that reads the self-describing `FMT` records and then
  every message type. This includes `PARM` (`TimeUS, Name, Value, Default`),
  `MSG`, `MODE`, `ATT`, `RATE`, `PIDR/PIDP/PIDY`, `RCOU`, `BAT` and `ESC`.
* Parse in a Worker, never on the page's main thread, and stream large logs
  in chunks.
* Validate every record and its length; a damaged log shows the damaged range
  instead of failing silently.
* Acceptance: field values and times agree with pymavlink's `mavlogdump` on
  the same files.

### A2. Live graphs during flight (R2)

* Plot telemetry while flying, in SITL (from MAVLink and the simulator's own
  state) and with a real vehicle (MAVLink only).
* Use the same plot component as the log viewer, so a preset built for
  analysis works live.
* Fixed-size buffers with a selectable window (for example 30 s, 2 min,
  10 min). Plotting must never slow the physics loop; it runs on the UI side
  at screen rate.

### A3. Two-log comparison (R1)

* Open two logs side by side or overlaid on one time axis.
* Align them by a chosen event (arming, takeoff, a mode change, a `MSG` text)
  or by a manual offset slider, and show the offset used.
* Show the parameter differences between the two logs (from their `PARM`
  records) next to the graphs; this is often the reason for comparing.

### A4. Log finder (R1)

Index a folder of logs once, then search by:

* date and duration;
* vehicle/firmware;
* flight modes used;
* `MSG` text (errors, failsafes, EKF messages);
* parameter value (for example "all flights with ATC_RAT_RLL_D > 0.0003").

### A5. Parameter grouping and presets (R3)

* Group fields by subsystem, following ArduPilot's own prefixes:
  * attitude rate loops: `ATC_RAT_*` with `PIDR/PIDP/PIDY`;
  * position control: `PSC_*`;
  * motors: `MOT_*` with `RCOU`/`ESC`;
  * EKF: `EK3_*` with `XKF*`;
  * battery: `BATT_*` with `BAT`;
  * vibration: `VIBE`.
* Ship presets for common tasks:
  * roll/pitch/yaw rate tuning (target versus actual rate, P/I/D terms,
    motor outputs);
  * altitude hold;
  * position hold;
  * vibration;
  * power and battery sag;
  * EKF health.
* Users can save their own presets. A preset is a small JSON file that can be
  shared, so the team uses the same views.

### A6. Graph styling (R4)

* A larger color palette that stays readable in light and dark themes.
* Line styles (solid, dashed, dotted), widths and markers.
* Per-preset style memory, and a legend that shows units.

### A7. Parameters on the graph (R5)

A parameter changed from the ground station during a flight is written to the
log as a timestamped `PARM` record (verified in the pinned ArduPilot source:
`GCS_Param.cpp` calls `Write_Parameter` on `PARAM_SET`).

* Draw a chosen parameter as a step line on its own axis, or as vertical
  markers labelled `ATC_RAT_RLL_D 0.00015 → 0.00020`.
* Draw it on the same time axis as the rate errors it affects.
* During a live flight, take the same changes from MAVLink `PARAM_VALUE`
  messages.
* To verify: changes made by Lua scripts or by other means may not produce
  `PARM` records. The viewer should say "no recorded changes" rather than
  imply a constant value.

### A8. Number display (R7)

* Never round parameters to a fixed two decimals. Show at least three
  significant figures, switching to scientific notation for very small or
  large values. For example `0.000170` or `1.70e-4`, never `0.00`.
* Show the exact stored value on hover, and copy it exactly.
* Apply the same rule to the parameter table, graph axes and tooltips.

### A9. DrorPlanner (R6)

* Build the viewer as a self-contained package with a documented interface:
  log in, plots and presets out.
* Decision needed: DrorPlanner's technology stack decides whether it embeds
  the package directly, hosts it as a web view, or reuses only the preset and
  formatting rules.

## 4. Workstream B: rotor aerodynamics in SITL (R8–R14)

### B0. How ArduPilot SITL models a multicopter today (R11, R14)

Read from the pinned ArduPilot source (`libraries/SITL/SIM_Motor.cpp`,
`SIM_Frame.cpp`, commit `8ab6afde`):

* **Thrust per motor.** The PWM output becomes a 0–1 command between
  `MOT_SPIN_MIN` and `MOT_SPIN_MAX`, shaped by `MOT_THST_EXPO`, and scaled by
  battery voltage. Thrust is a momentum-disk formula,
  T = ½ ρ A (v_out² − v_in²). The outflow speed is calibrated so the
  configured hover throttle holds the configured mass at the reference
  altitude. v_in is the airflow into the rotor along its axis, clipped at
  zero.
* **Yaw torque.** A fixed fraction of thrust times the frame size, not a
  measured torque curve.
* **Airflow effects.** An isotropic "momentum drag" proportional to the
  rotor's air velocity and √(ρ · disk area · thrust). The source itself calls
  the axial part "a hack" and leaves a TODO to replace the model with DC
  motor, momentum disk and blade element theory.
* **Body drag.** One drag area, derived from a single reference flight (a
  reference speed at a reference tilt angle).
* **Not modelled:** thrust and torque versus airflow angle (in-plane H-force,
  rotor tilting moments); air arriving from below (prop wash, vortex ring
  state; incoming flow is clipped at zero); rotor-to-rotor interaction; ground
  effect; motor heating.
* **RPM** is reported only for vibration simulation.
* **Configuration** comes from a frame JSON file and `SIM_FRM_*` parameters:
  mass, size, hover throttle, expo, PWM range, voltage, disk area, drag
  references and inertia.

So the default SITL cannot represent most of R8–R10. That is expected: it
targets controller testing, not airframe aerodynamics.

### B1. Architecture: keep tables outside ArduPilot (R11)

ArduPilot's built-in model has no input for performance tables. ArduPilot does
support an external physics model through its JSON interface:

* the simulator receives motor PWM;
* it returns vehicle state, IMU and position.

MirageSITL already implements that interface (TASK-041). Version 2 should
compute rotor forces in MirageSITL from tables and leave ArduPilot unmodified.
Then the same firmware build runs in SITL, in the browser and on the vehicle.

### B2. Stand-in until aerodynamic tables exist (R14)

Two steps, both usable immediately:

1. **Calibrated default model (days).** Fit ArduPilot's own frame parameters
   from data the team already has:
   * mass, inertia and frame size from the vehicle;
   * `MOT_THST_EXPO`, `MOT_SPIN_*` and hover throttle from logs;
   * the drag reference from a steady-speed flight log.

   Run ArduPilot's stock multicopter model with that JSON frame file. It is
   honest about what it lacks (B0), and gives controller work a baseline at
   once.
2. **MirageSITL rotor model from bench data (weeks).** Drive the existing
   rotor models from bench measurements (B3) through the JSON interface.
   Static thrust, torque and power come from the measured curves, and the
   airflow effects come from the existing inflow model (TASK-021). This
   replaces the "hack" in B0 with the team's measured data.

Both stand-ins must be labelled as such in the simulator and in exported
results.

### B3. Bench data import (R8)

* Define a CSV schema for bench runs, one row per steady point:
  * commanded throttle or PWM, voltage, current, electrical power;
  * RPM, thrust, torque;
  * motor temperature, optional;
  * air pressure and temperature;
  * prop and motor identifiers.
* Convert to coefficients so data from one day applies to another: CT and CP
  versus RPM, with air density from pressure and temperature (Engineer 2's
  point about rescaling). Motor efficiency comes from electrical versus shaft
  power.
* The import checks units, flags inconsistent rows (for example efficiency
  above 1), and records the file hash and conditions.
* This is the same kind of data the UIUC comparison (TASK-033) already
  handles, so the converters and checks can be shared.

### B4. Rotor tables from the external aerodynamic simulator (R9, R11)

A versioned table format, produced offline by the team's aerodynamic
simulator (blade element momentum, vortex or CFD), read by MirageSITL at
start-up:

* **Inputs (axes):**
  * airflow speed at the rotor;
  * airflow angle relative to the rotor disk, from 0° (edgewise) through 90°
    (axial climb) to −90° (descending into its own wake);
  * RPM, or advance ratio and tip Mach number.
* **Outputs per rotor:**
  * thrust;
  * in-plane force (H-force);
  * shaft torque;
  * rolling and pitching moments about the hub;
  * shaft power.

  All are in SI units in a stated hub frame.
* **Metadata:**
  * propeller geometry;
  * reference air density and how to rescale;
  * the solver and its version;
  * the valid envelope;
  * a content hash.
* **In flight:** MirageSITL interpolates (multilinear) between table points
  at every physics step without allocating memory, rescales to the current
  air density, and marks any point outside the table's envelope in telemetry.
* **Acceptance before trusting a table:**
  * at zero airflow it must reproduce the bench data (B3) within a tolerance
    declared before the comparison;
  * at forward speeds it must agree with any available flight-log segments.

### B5. Prop wash and descent through own wake (R9)

* The tables in B4 must include negative axial airflow (descent and braking).
* Vortex ring state and windmilling are regimes where simple momentum theory
  fails. The external solver's data are used as-is, and the region is flagged
  in telemetry so pilots and engineers see when the vehicle is in it.
* The existing inflow model already marks descent as unvalidated
  (TASK-021). That flag carries over.

### B6. Rotor-to-rotor interaction (R10)

* Per rotor pair, table multipliers or induced-velocity offsets versus airflow
  speed and angle, from the external simulator.
* Start with the configurations that matter most: front rotors washing into
  rear rotors in forward flight, and coaxial pairs. The existing coaxial wake
  model (TASK-024) is the starting point.

### B7. Steady-state assumption (R13)

Adopted as a design rule: rotor forces depend only on the current airflow,
RPM and geometry, not on the vehicle's earlier wake. A short inflow lag
(TASK-021) remains available, so throttle steps do not produce
non-physical instant thrust changes. Aggressive manoeuvres that re-enter their
own wake are out of scope for version 2.

### B8. Ground effect (R12)

Lower priority, but cheap to try:

* Add an optional thrust increase near the ground as a function of height over
  rotor radius, using a standard published model.
* Keep it off by default.
* Validate it against the precision-landing logs that showed the problem: the
  log viewer (A3) can compare a simulated landing with the real one.

### B9. Motor heating and RPM (R8, lower priority)

* RPM follows directly from the table model and the motor model (TASK-025).
* Motor temperature needs bench temperature data. A simple thermal model can
  come later; it is not needed for control tuning.

## 5. Workstream C: one vehicle definition file

Engineer 2's end-to-end goal needs one place to describe the drone. Proposal:
a versioned vehicle file listing:

* mass, centre of gravity and inertia;
* motor and rotor positions, tilt and spin direction;
* for each rotor: the bench data set (B3), the aerodynamic table (B4) and the
  interaction tables (B6);
* battery model.

The same file feeds the default-model fit (B2 step 1), the MirageSITL rotor
model (B2 step 2) and the documentation of each test.

## 6. Proposed order and decisions

| Phase | Content | Depends on | Size |
| --- | --- | --- | --- |
| 1 | A1 DataFlash parser; A8 number display; B0 written up for the team (this document); B2 step 1 calibrated default model | – | small |
| 2 | Log viewer core: A5 groups and presets, A6 styling, A7 parameter overlays, A3 comparison | A1 | medium |
| 3 | B3 bench import; B2 step 2 rotor model from bench data through the JSON interface | B3 data from the team | medium |
| 4 | A2 live graphs; A4 log finder | A1, A5 | medium |
| 5 | B4 table format and interpolation; B5 prop wash flags; B6 interaction | tables from the external simulator | large |
| 6 | B8 ground effect experiment; B9 heating; A9 DrorPlanner integration | B4, decision on DrorPlanner | medium |

Decisions needed:

1. Which external aerodynamic simulator, and who runs it.
   * This fixes the table producer for B4.
2. Table axes and resolution: which airflow speeds, angles and RPMs.
   * Ask the aerodynamics owner, using the flight envelope the team actually
     flies.
3. DrorPlanner's technology stack, for A9.
4. Tolerances for accepting bench and table models, agreed before comparing.
5. Where shared presets and vehicle files live (repository, shared drive).

These items are proposals. When one is approved, it becomes a numbered task
in the [project roadmap](PROJECT_ROADMAP.md) with its own acceptance criteria.

## 7. Work carried over from the existing roadmap and documentation

These items were already recorded in the [project roadmap](PROJECT_ROADMAP.md)
and other documents (review of 2026-10-20). They keep their existing TASK IDs.
"Blocked on" names the outside input each one waits for.

### 7.1 Unfinished roadmap tasks

| TASK | Title | Status | What remains |
| --- | --- | --- | --- |
| 033 | Model validation gate | BLOCKED_EXTERNAL | Propeller fidelity still fails at its fixed tolerances. Still needed: a measured or viscous-solver SDA1075 polar, a decision on BET tip loss and swirl, the archive storage decision, airframe data and the production BET binding. |
| 046 | ArduPilot browser HAL | TODO | Connect clock, storage, sensor and actuator endpoints to the WASM firmware with a lockstep clock and no deadlock on pause or exit. |
| 047 | WASM/native SITL parity | DONE | Native and browser arm/takeoff/land and GCS-failsafe match. Position RMSE 0.019/0.049 m and attitude RMSE 0.058/0.097°. The demo backend stays selected. |
| 051 | ArduPilot drone firmware | DEFERRED | Version 2 proposal. Produce ArduPilot 4.6.3+ firmware with Hybrid SITL and Simulation-on-Hardware, flash it to the drone, and test it there. Not a version 1 gate. PX4 is out of scope. |
| 073 | GPU acceptance harness | BLOCKED_EXTERNAL | Blocked on full-feature production traces (terrain, FPV and thermal together), VRAM accounting and an M4 device. |
| 074 | Pilot HUD and freshness | DONE | Serial `EkfMonitor` overlay on the Pilot HUD. Browser READY flight admission remains TASK-046/047. |
| 075 | Instructor console | DONE | Fault commands apply through the session EW registry. Weather and model commands stay rejected on the demo. |
| 078 | AAR response charts | DONE | Full-rate producer recording of each physics tick. Sensor and actuator payloads are stored only when that tick owns the frame. |
| 079 | Lessons and scenario runner | DONE | Scenario faults bind to the live epoch and count as applied only after the Worker ACK. Weather events stay rejected on the demo. |
| 080 | Accessibility and permissions UX | BLOCKED_EXTERNAL | Live-autopilot prerequisites, a screen-reader session and hardware permission/disconnect checks. |
| 082 | System acceptance matrix | BLOCKED_EXTERNAL | Real G0–G4 evidence for each mode. |
| 083 | Release provenance and runbook | BLOCKED_EXTERNAL | Clean-machine install, toolchain and license review, and review of raw evidence. |

### 7.2 Autopilot, SITL and HITL integration

* **Browser autopilot.** Wire the browser flight session to the autopilot and
  admit browser READY. Today SITL flight and EKF readiness (TASK-042/043/059)
  are native-only. TASK-074 displays serial EKF health on the Pilot HUD and
  does not admit that READY state.
* **Composed EW in the browser.** EW and startup EW admission are not yet
  applied in the live application.
* **ArduPilot WASM artifact distribution.** Blocked on a GPL review decision.
  Two related decisions are still open:
  * whether to move the Emscripten pin (4.0.15) to upstream CI's version;
  * measuring browser memory under load.
* **TASK-059 follow-ups:**
  * separate observation injection;
  * recording unhealthy EKF responses;
  * a per-rotor thrust-loss input for the synthetic quad.
* **Motor faults.** Full BET and mixer wiring, with compensation flight tests.
* **ArduPilot firmware for the drone (TASK-051, version 2).** This is a proposed
  upgrade, not a version 1 gate. Hybrid SITL and Simulation-on-Hardware must
  produce an ArduPilot 4.6.3 or newer firmware image that can be loaded onto
  the drone and tested on the drone. Hybrid SITL means the flight code uses
  ArduPilot's JSON physics backend (`AP_SIM_JSON_ENABLED`, UDP 9002).
  Simulation-on-Hardware means the same flight code is built with
  `env SIM_ENABLED 1` so the autopilot runs the simulation on the board.
  PX4 is out of scope. Props stay off until a written test procedure says
  otherwise. The existing no-drone virtual JSON lockstep
  (`scripts/run-virtual-hitl.mjs`) is only a prototype of the physics link. It
  does not produce the drone firmware and does not finish this upgrade.
  Version 1 system acceptance (TASK-082) does not wait for this firmware.
* **Bridge beyond loopback.** HTTPS/WSS and Private Network Access for remote
  use.
* **Newer firmware.** Must explicitly extend the pinned MAVLink subset.

### 7.3 Flight physics backend

* **Production BET binding.** The rotor kernels exist but the production step
  still reports "aerodynamics unavailable". This is the prerequisite for
  workstream B (section 4). Adapters are also still needed for:
  * the coaxial wake;
  * battery power feedback to the actuators;
  * reverse rotation and an RPM governor.
* **JSBSim session wiring.** Demo selection, weather, model switching and
  flight-session wiring; runtime model switching in the app.
  * Blocked on redistribution review of the aircraft model data.
* **Weather.** Not yet connected to the demo or JSBSim.
* **Landing gear.** Wheel spin, braking slip, anti-skid, steering and
  aircraft calibration. Measured NASA gear fidelity stays deferred by the
  owner's decision; its failing comparison is preserved.
* **Terrain contact (TASK-065).**
  * Wiring into the physics session.
  * Live tile decoding and terrain admission (blocked on licensed height data).
  * Contact-patch curvature.
* **Absolute MSL height.** Blocked on an authoritative EGM96/EGM2008 geoid grid.

### 7.4 Measured-data validation

* **Propeller fidelity:**
  * a measured (or viscous-solver) polar;
  * a declared tip-loss/inflow model;
  * explaining the DA4022 multi-blade errors;
  * low-Reynolds coverage.
* **Provenance rules.** Future polar data must keep raw solver, digitized,
  surrogate and extrapolated values apart, with Reynolds-envelope flags. Each
  measured dataset needs a reviewed units/envelope/provenance adapter.
* **Airframe fidelity.** Blocked on measured airframe data.
* **JSBSim propeller tables (TASK-086):**
  * a flight model must supply the rotating inertia (`<ixx>`);
  * Vol 4 true versus nominal diameters;
  * RPM dynamics and engine coupling;
  * Reynolds dependence across RPM.

  The tables are intended for future fixed-wing models.
* **Further uses of the UIUC data:**
  * measured load-torque curves for the shaft and ESC references;
  * replacing the arbitrary demo rotor geometry with a measured propeller.

  Each needs its own task and tolerance.
* **Autorotation.** Numerical tests do not establish validated autorotation.

### 7.5 Rendering, terrain and thermal

* **Live Google 3D Tiles.** Blocked on a deployed proxy, provider credentials
  and deployment approval.
* **Persistent caching.** Blocked on explicit permission and reviewed dataset
  rights.
* **WebGPU:**
  * real-GPU residency and frame-time measurement on target devices;
  * the WebGPU fisheye and analog-video variants;
  * a decision on which features the WebGPU profile supports.
* **Wide lenses.** Lenses above 80° need a cubemap source.
* **WorldCover land cover:**
  * application wiring;
  * a runtime manifest loaded from local files;
  * an OSM road/building overlay (blocked on a licensed extract);
  * publisher checksum verification.

  Regions outside Israel need deliberate acquisition.
* **Thermal:**
  * a production thermal scene and a WebGPU thermal renderer;
  * measured instrument and material validation, including CADEX parity
    (blocked on calibrated instrument data).

### 7.6 UI, recording and scenarios

* **Recording.** Full-rate synchronized recording of flight-controller sensor
  and actuator streams, with producer fan-out; a production resimulator.
* **Demo commands.** Weather and model commands stay rejected on the demo.
  Fault commands apply through the session EW registry (TASK-075).
* **Scenarios.** Scenario epoch/acknowledgement orchestration, and real model
  and firmware identities in the lessons in place of placeholders.

### 7.7 Performance, release and evidence

* **Delivered physics rate.** On Windows Node (`test-results/laptop/physics-*-idle.json`),
  the `bench-physics` realtime run executed 516.7 Hz (target 800, 1,426 drops)
  and 519.6 Hz (target 1200, 3,415 drops): ~16 ms timer wakeups × 8-step
  catch-up cap (`DEFAULT_MAX_CATCH_UP = 8`). Compute is ~1 us/step; the browser
  Worker 800 Hz regression passed its 720–880 Hz range. Next steps: profile
  timer wakeups separately from compute and design a supported scheduling
  improvement without relaxing the catch-up cap or thresholds.
* **Frame cadence.** On the RTX 4050 laptop (`test-results/laptop/`), visible
  60 Hz 1080p DPR1 demo captures measured p99 19.910 ms (WebGL2, 600 s) and
  19.645 ms (WebGPU, 120 s), and 144 Hz panel captures measured p99 19.565 ms
  (fixed 1080p) and 19.005 ms (`--native-viewport` 1536x826 DPR 1.25), missing
  the user-accepted 60 FPS p99 of 17.665 ms and the 8.33 ms (120 FPS) limit.
  The M4 WebGL2 production capture measured median 16.680 ms and p99 17.665 ms
  at a user-accepted 59.88 Hz refresh. Its scene did not fill the 2560×1440
  display; the MacBook Air native panel is 2560×1664. A 10-minute RTX 4050
  full-feature run and a presentation that covers the physical display remain open.
* **Evidence and reports.** Refresh the stale evidence manifest entries
  (`test-results/laptop/evidence-manifest.json`) and missing diagnostic
  reports, and reconcile the model-report (`test-results/validation/model-report.json`)
  and system-validator schemas. Production hosting must set COOP/COEP; verify
  hosted CI on current commits.
* **Release scope (decision).** Wait for all modes, or ship a narrower release
  backed by evidence.

### 7.8 Data licensing decisions

* UIUC propeller database: commit, redistribute or ask UIUC for terms. This
  also covers the derived JSBSim tables.
* JSBSim aircraft XML (c172x) redistribution.
* ArduPilot GPL distribution (7.2), Google tile caching (7.5) and the geoid
  grid license (7.3).
* Copyrighted textbooks and the PROPID sources stay local and are not
  distributed.

## 8. Glossary

| Term here | Mission Planner / ArduPilot equivalent |
| --- | --- |
| DataFlash log | the `.bin` file downloaded from the flight controller or produced by SITL |
| Parameter | an entry in Mission Planner's Full Parameter List (for example `ATC_RAT_RLL_D`) |
| `PARM` record | the log entry ArduPilot writes when a parameter is set from the ground station |
| JSON physics interface | `--model JSON` in ArduPilot SITL: an external program computes the physics |
| Frame JSON / `SIM_FRM_*` | ArduPilot SITL's built-in multicopter description |
| Airflow speed/angle | free-stream velocity and its angle to the rotor disk |
| H-force | the rotor's in-plane force in edgewise flow |
| Prop wash / vortex ring state | a rotor descending into its own downwash, with unsteady, reduced thrust |
| Ground effect | extra thrust near the ground, as the downwash is blocked |
