# MirageSITL — Approved Project Scope

Status: approved by the stakeholder on 2026-10-28.
Audit baseline: `5b4a2fc`. [Russian mirror](docs/ru/PROJECT_SCOPE.md).

The final approval explicitly removes Windows support. Phase 1 targets only
macOS on Apple Silicon with Chrome. Earlier Windows/WSL delivery, portability
and acceptance requirements from this discussion are superseded.

This document records the scope agreed through the audit and feature-by-feature
review. It is the source of truth for product scope when older roadmap, version
2 proposals or implementation notes disagree. Existing technical contracts still
apply unless an approved change explicitly replaces them. Approval of this
document is not evidence of implementation, physical fidelity or release readiness.
This session authorizes documentation only; it does not start development.

## 1. Approved Scope (Source of Truth)

### Goal and evidence boundary

Enable users to select motors and propellers and tune ArduPilot parameters for
different real multirotor aircraft, including before their first real flight.
Phase 1 covers quadcopters, hexacopters, octocopters and paired-motor arrangements
up to eight arms with two motors per arm: 16 motors. Other aircraft classes are
later work. A synthetic demo alone does not satisfy the product goal.

A real flight log is optional. Users can start from component specifications or
bench measurements. The UI must distinguish preliminary predictions, calculations
supported by measurements, and aircraft behavior checked against real flights.
None of these labels alone certifies exported settings for real flight.

The audit found a working browser demo, implemented physics/sensor/link libraries,
and historical separate native and browser ArduPilot flight evidence. The main
application still selects demo dynamics. Measured UIUC propeller comparisons
fail existing tolerances; the historical NASA landing-gear comparison failed and
was deferred. Native EW captures predate the latest EW fixes. These facts must
not be relabeled as current integrated acceptance. The audit's focused run passed
64 tests in 12 files; it was not a full browser, hardware or flight acceptance run.
See the [roadmap](docs/PROJECT_ROADMAP.md),
[model report](test-results/validation/model-report.json) and
[earlier version 2 proposals](docs/V2_PLAN.md) for background, not extra authorization.

Each S-ID below identifies an approved requirement group, not a completed task.
Acceptance Criteria describe observable outcomes for future development.

### S01 — Platform, language and local operation

**Acceptance Criteria**

- The complete supported workflow runs on macOS on Apple Silicon in Chrome.
  Exact supported macOS/Chrome versions and reference machines remain to be selected.
- ArduPilot runs as an external local SITL process; the browser provides the UI,
  visualization and simulation integration. Native macOS launch must be investigated;
  a VM/container fallback is not silently substituted without stakeholder agreement.
- The UI is English. User-defined names support Russian and English text.
- Initial installation may download dependencies. After installation, simulation,
  tuning, local component/aircraft libraries, recording and log analysis work offline
  without an account or mandatory cloud service.
- Offline terrain is limited to existing local data; the synthetic pad works
  without map services. External map services may require connectivity.

### S02 — Start, stop, manual connection and synchronized pause

**Acceptance Criteria**

- First-run UI checks prerequisites and explains missing installation/configuration.
  A local launcher is part of the solution; a normal web page is not assumed to
  have permission to start arbitrary programs.
- The user selects an aircraft profile and compatible ArduPilot version, starts
  an experiment, and sees connection, parameter-loading and autopilot readiness.
- Stop terminates only processes owned by that experiment. Manual connection to
  an already running compatible SITL is supported; disconnect does not terminate it.
- Failures expose a useful reason, diagnostic log and restart path.
- Pause freezes physics and ArduPilot simulation time together, retaining position,
  velocity, aircraft state and scenario progress. It must not itself cause sensor
  or link-loss failsafes. Resume continues from the retained state.
- Charts/logs remain viewable on pause. ArduPilot parameter changes are allowed
  where supported; restart/disarm requirements remain visible. Changes to aircraft
  geometry, motors, propellers or other model characteristics require a new run.
- Pause/resume events are recorded; wall time spent paused does not extend simulated
  flight duration. Manual-connection pause is enabled only for compatible clock control.
- External SITL clock/pause feasibility is an early verification requirement, not
  an already demonstrated capability or permission to patch ArduPilot.

### S03 — Aircraft editor and motor mapping

**Acceptance Criteria**

- Through the UI, users change arm count, lengths and placement; motor positions,
  thrust axes, rotation directions, and one or two motors on an arm. Paired rotor
  placement and separation are editable. Support extends to eight arms and 16 motors;
  it is not limited to three fixed quad/hexa/octo templates.
- Users enter mass, center of gravity, moments of inertia, payload characteristics,
  propulsion, battery and sensor configuration without editing code.
- Every motor can be assigned to an ArduPilot output. The 3D scheme shows its
  identity, placement, spin direction and thrust axis. A virtual one-motor-at-a-time
  check is available before flight.
- The application checks frame/output compatibility and explains required thrust
  allocation configuration or unsupported combinations. Stock ArduPilot capabilities
  are the starting point. Eight arms with two motors each remains mandatory even
  if a firmware limitation is discovered: surface the blocker for a decision.
- The complete drone model can be saved locally, reopened, copied and reused.

### S04 — Component library and two calculation input modes

**Acceptance Criteria**

- The UI explicitly offers **Preliminary calculation** and **Calculation from
  measurements**. Neither mode requires editing files or code outside the UI.
- Preliminary mode accepts motor, ESC and battery specifications and propeller
  geometry/characteristics. Assumptions and missing information are visible.
- Measured mode additionally accepts manual entry and file upload of bench data:
  RPM, thrust, torque, voltage/current and measurement conditions, as available.
  Missing quantities and limits of use are shown rather than invented.
- Local reusable cards store motors, propellers, ESCs and batteries with versions,
  sources, measurements and applicability limits; cards can be imported/exported.
- Measurements of a motor + propeller + ESC + power-supply combination remain
  attached to that combination. They are not silently generalized to another one.
- Static single-rotor measurements do not automatically validate forward flight,
  descent or a coaxial pair. Selecting measured mode does not certify a whole aircraft.
- Edits create a new version without changing the inputs of previous experiments.

### S05 — Flight aerodynamics

**Acceptance Criteria**

- Physics accounts for propeller thrust and torque changing with incoming airflow,
  including hover, forward motion and descent; interaction within coaxial pairs;
  body aerodynamic drag; rotor ground effect; and adverse vertical-descent regimes.
- Two coaxial motors are not modeled merely as twice one isolated motor's thrust.
- Each effect declares its model, required inputs and validity limits. Unsupported
  conditions or extrapolation are visible; implemented effects are not called
  measured-accurate without evidence.
- Geometry and component changes affect the physical model, not only its rendering.

### S06 — Battery and propulsion limits

**Acceptance Criteria**

- UI configuration includes battery capacity, cell count, initial charge and internal
  resistance. Simulation includes load-dependent voltage sag and charge consumption.
- Motor/ESC current, power and RPM limits use available component characteristics.
- Voltage, current, power, remaining charge and limit exceedances are visible in
  the UI and logs. Warnings about rating exceedance are distinguished from physical
  power limiting actually represented by the equipment model.
- Detailed heating, cooling and aging are excluded. Ambient temperature still
  participates in atmospheric calculations; no detailed thermal fidelity is implied.

### S07 — Weather and geographic conditions

**Acceptance Criteria**

- UI settings include steady wind speed/direction, gust strength/duration/direction,
  turbulence, temperature and atmospheric pressure.
- Weather can change during flight manually or by a saved scenario. Changes are
  logged; gust/turbulence realizations can be repeated for controlled comparisons.
- Users choose location on an available map or enter coordinates; terrain elevation
  above sea level, surface slope/contact, geographic gravity and magnetic field are
  accounted for within declared model limits.
- Atmospheric pressure is consistent with altitude and can be overridden by a
  measured value. The effective conditions used by the calculation are visible.
- Existing available map/elevation data and the synthetic pad define geographic
  coverage in Phase 1 (S17); complete coverage of Israel is not required.
- Wind flowing around mountains/buildings is excluded from Phase 1.

### S08 — Dedicated Sensors tab

**Acceptance Criteria**

- A separate **Sensors** tab offers **Ideal sensors** and **With specified errors**.
- Supported sensors are IMU (gyro/accelerometer), GNSS, barometer, magnetometer and
  battery voltage/current measurement.
- IMU settings include sampling rate, noise, bias, latency, placement and orientation;
  GNSS settings include update rate, position/velocity accuracy and latency;
  barometer settings include noise, bias and latency; magnetometer settings include
  noise, bias, placement and orientation; battery sensing has measurement errors.
- Settings are retained in the aircraft profile and experiment record. Each error
  has a defined owner so MirageSITL and ArduPilot do not accidentally apply it twice.

### S09 — Dedicated Faults and interference tab, including EKF drift

**Acceptance Criteria**

- The separate tab configures individual motor failure/reduced power, GNSS loss
  or degradation, GNSS position steps/gradual drift, magnetic interference,
  missing/frozen sensor readings, and loss of pilot control or ground-station link.
- Effects can be applied manually or scheduled with onset, duration and recovery;
  events and actual application outcomes are recorded.
- Motor faults change physical actuation. Sensor interference changes observations,
  not the independent true aircraft state.
- **EKF drift** is an input-error scenario with direction, growth rate, duration and
  gradual/abrupt removal configured through the UI. It does not overwrite ArduPilot's
  internal EKF estimate or force a predetermined trajectory.
- Charts compare true trajectory/velocity with the EKF estimate and show their errors.
  ArduPilot may drift, reject measurements or enter failsafe; no particular response
  is promised before observing it.

### S10 — Flight tasks, initial conditions and execution speed

**Acceptance Criteria**

- Users can fly manually with a controller or run repeatable takeoff, hover, landing,
  straight flight, climb, descent, acceleration, braking and turning tasks.
- Route points, altitudes and speeds are entered through the UI. Tuning maneuvers
  command changes in roll, pitch, heading and altitude and display requested versus
  actual response. ArduPilot receives commands; physics calculates the resulting motion.
- Initial position, attitude, speed and battery charge are configurable; mass and
  payload belong to the aircraft profile.
- Real-time and accelerated runs use the same physics. Acceleration is limited by
  the host and must not be achieved by simplifying the model or skipping steps.
- Actual simulation speed and overload are visible. A run that falls behind is not
  represented as real-time. No fixed acceleration factor has been approved.

### S11 — ArduPilot parameter tuning and export at any stage

**Acceptance Criteria**

- The UI reads actual connected-SITL parameters and allows edits before/during flight
  and, where supported, on pause. Requests, refusals and confirmed read-back values
  are distinguished. Disarm/restart requirements remain visible.
- Each change records parameter name, old/new values, time and outcome. Confirmation
  of storage is not mislabeled as immediate behavioral application when restart is needed.
- Users save/compare parameter sets and send previous values back. Historical values
  and their relationship to experiments are retained.
- At any stage, users can export an ArduPilot-compatible parameter file containing
  all available configurable parameters, changes relative to a selected baseline,
  or selected parameters/groups, for manual loading by the user.
- Before export, users see the contents and value source: saved profile, experiment
  or actual SITL read-back. Pending/unconfirmed requests are not exported as confirmed
  live values. Aircraft/firmware/experiment context accompanies the export.
- Simulator-only geometry/weather settings are saved separately from ArduPilot
  parameter files. Direct writing to a real controller is excluded.

### S12 — Comparison and user-defined parameter batches

**Acceptance Criteria**

- Users copy an aircraft profile, change motors/propellers or other settings and
  compare experiments. Comparisons support both different conditions for one aircraft
  and equal conditions for different configurations.
- Controlled comparisons preserve payload, battery, weather and task as selected;
  changes in the components' own mass are accounted for explicitly.
- Results include takeoff capability/thrust margin, RPM/current/power/energy use,
  estimated flight duration for a stated scenario, position/maneuver response, and
  component limit exceedances. Calculation mode and input confidence remain visible.
- Users can supply several parameter sets for sequential automatic runs of the same
  scenario, then inspect collected results. The system does not independently search
  for new parameter values or declare a set fit for real flight.

### S13 — Dedicated Logging tab and full-experiment recording

**Acceptance Criteria**

- A separate **Logging** tab selects recorded signals; all available signals are
  enabled by default. A common recording frequency is the default control, with
  per-signal/group overrides. The default numeric frequency remains undecided.
- Requested and effective frequencies are shown. Rates such as 10 Hz are selectable
  where supported; 2 kHz is available only for sources actually producing at least
  that many samples. The UI exposes source limits and caps/rejects unsupported rates
  explicitly. Duplicated samples are not presented as additional measurements.
- A global rate respects each source's limit. This requirement does not authorize
  raising the physics rate merely to offer 2 kHz recording.
- ArduPilot settings are recorded as an initial snapshot plus change events; sampled
  telemetry and sensor signals use frequencies. DataFlash recording capabilities are
  separate from the MirageSITL recorder and must be checked, not assumed arbitrary.
- The UI estimates MB per simulated hour and total size for a selected duration,
  then shows actual growth. Accelerated runs also show growth per real second.
  An example such as 2 MB/hour is not a guaranteed size.
- Recording covers the full experiment rather than the old short archive window.
  Available storage limits duration; warn before exhaustion and expose recording gaps.
- Selected channels, effective rates, source availability and events remain associated
  with the saved experiment so omitted data is not mistaken for zero-valued data.

### S14 — Integrate UAVLogViewer and compare logs

**Acceptance Criteria**

- Integrate the existing UAVLogViewer, rather than silently replacing it with a new
  lookalike. Verify its version, license, integration and extension feasibility first.
- Users open real ArduPilot DataFlash logs and MirageSITL experiment results through
  the integrated analysis workflow; required adapters/formats must be established.
- Compare two flights or two selected intervals of one flight, with charts side by
  side or overlaid, distinct curves and common scales for matching quantities.
- Users align interval starts and manually shift time to match maneuvers.
- Parameter-change events appear on the corresponding flight timeline next to
  response plots. Requested, confirmed and rejected changes remain distinguishable.
- MirageSITL comparisons show aircraft/component versions, environmental conditions
  and parameter differences. Missing context in external logs is marked unknown;
  parameter history not present in the source is not fabricated.

### S15 — Create an experiment from a real log and assess fidelity

**Acceptance Criteria**

- Real flight logs are optional for initial tuning and for running preliminary or
  measured-input models. Lack of a log does not disable simulation.
- **Create experiment from log** accepts a log/interval, extracts available initial
  conditions, parameters and task/control information, and asks the user to supply
  missing inputs through the UI.
- A new simulation can use changed ArduPilot parameters and be compared with the
  original. Its trajectory is recalculated, not forced to follow the recorded path.
- Missing commands, weather or aircraft information are disclosed. Exact replay of
  an arbitrary log is not promised.
- Where matching data exists, compare attitude/rate response, overshoot/oscillations,
  altitude/climb/descent, trajectory and measured propulsion/energy quantities.
  Numerical fidelity limits must be agreed for the relevant model and operating range.
- Fidelity evidence belongs to a specific profile version and tested regimes.
  Geometry, mass, motor or propeller changes require a new assessment; missing data
  remains unverified rather than passed. Operational acceptance and fidelity are separate.

### S16 — Local projects, versions and reproducibility

**Acceptance Criteria**

- A project holds versioned aircraft geometry, components, characteristics and sensors.
  An experiment fixes the aircraft version, ArduPilot version/initial parameters,
  weather/location, task, fault schedule and recording setup.
- Records retain results and in-flight parameter/environment/fault events.
- **Repeat** reuses the same inputs; **Create variant** preserves the original while
  allowing changes. Reproducibility means preserved inputs and declared tolerances,
  not a promise of bit-identical outputs on every machine.
- Projects, complete drone models, components and experiments can be saved/reopened
  locally and exported/imported. Missing external dependencies are reported.
- Local operation needs neither account nor cloud synchronization. Windows transfer
  or execution is no longer a Phase 1 acceptance requirement.

### S17 — Existing terrain and focused visualization

**Acceptance Criteria**

- Use only the existing mapping components and currently available datasets, with
  Israel as the initial geographic focus. GovMap, additional providers and universal
  user map import are deferred. Full national coverage is not promised.
- Imagery and elevation are distinguished. The UI shows available coverage, source
  and terrain detail; an adapter needing deployment/keys/data is not a ready source.
- The synthetic level pad remains explicitly selectable without real data. Missing
  terrain during a real-terrain run pauses it rather than silently substituting a plane.
- The 3D aircraft reflects configured geometry/motor placement. External and onboard
  views, trajectory, route/points, flight and motor telemetry are available.
- Real terrain and the synthetic pad are clearly distinguished. Existing local data
  supports offline use where permitted; automatic region downloads are excluded.

### S18 — Basic contact and accident handling

**Acceptance Criteria**

- Basic contact works with the synthetic pad and available real terrain, including
  surface slope. Contact loads and events can be inspected in recordings.
- Body/propeller contact is recorded as an accident and automatically pauses the run,
  preserving state and logs. Continuing after it is not presented as a validated
  simulation of a physically damaged aircraft.
- A basic contact model is required, but UI editing of support/gear positions,
  stiffness, damping and friction is deferred. Specific landing-gear load fidelity
  is not claimed. User-commanded motor failures remain available independently.

### S19 — Phase 1 operational acceptance

**Acceptance Criteria**

- The acceptance matrix includes quad-, hexa- and octocopters with one motor per arm,
  a paired/coaxial configuration, and the maximum eight-arm/two-motor configuration.
- For each, demonstrate profile creation through the UI, correct ArduPilot output
  mapping, start, flight task, pause/resume, parameter changes, recording and reopening
  results. Unsupported operations must be explicitly refused.
- On agreed Apple Silicon reference hardware in Chrome, the 16-motor configuration
  completes at least one continuous hour of simulated time with recording. This is
  not necessarily one hour of wall time and does not waive actual-rate reporting.
- Demonstrate the supported macOS installation/restart and local/offline workflows,
  export/import, comparisons and parameter export. Windows is not part of acceptance.
- Hardware performance targets and numerical fidelity thresholds remain explicit
  decisions; neither historical Windows results nor cloud runs substitute for macOS
  product acceptance. No universal FPS/Hz or measured-aircraft accuracy is asserted here.

## 2. Out of Scope / Rejected (Do Not Touch)

These are exclusions or deferred work, not instructions to delete existing code.
Do not develop, enable or expand them without separate stakeholder approval.
Existing modules may be preserved and used only where needed for approved scope;
their presence or an older TODO/DONE label does not authorize the excluded feature.

| Item | Disposition |
| --- | --- |
| Windows/WSL product support, packaging and acceptance | Removed by the final approval. Preserve existing tools/evidence; do not add Windows delivery work. |
| Intel Macs, other browsers and additional operating systems | Not required in Phase 1. |
| Browser-hosted ArduPilot as a user flight mode | Not the selected Phase 1 backend. Preserve existing WASM work; no expansion or deletion authorized. |
| Fixed-wing, VTOL and other aircraft classes | Later stages; their detailed scope is not approved. |
| Support/landing-gear editor: positions, stiffness, damping, friction | Backlog, explicitly reconfirmed at the end of review. |
| Structural destruction, body deformation and flight with a physically damaged propeller | Backlog, explicitly reconfirmed at the end of review. |
| Detailed motor/ESC/battery heating, cooling and aging | Backlog. Electrical limits and atmospheric temperature remain approved. |
| Full airflow simulation, flexible blades/structures, wakes of multiple aircraft | Backlog. Approved coaxial interaction and descent effects remain required. |
| Terrain/building-induced airflow | Backlog. |
| Autonomous parameter optimization/search | Backlog. User-specified sequential batches remain approved. |
| GovMap, new map providers, universal user map/elevation import, automatic offline region downloads | Backlog. Current available data and the synthetic pad define Phase 1. |
| Thermal camera, analog video interference and artistic camera effects | Backlog; preserve existing code without expanding the feature. |
| Cloud synchronization/collaboration, mandatory accounts | Outside Phase 1. |
| Direct parameter writes to a real controller; new HITL/Simulation-on-Hardware product modes | Outside Phase 1. Manual parameter-file export remains approved. |
| Russian UI localization | Backlog. Russian user-defined names and documentation remain allowed. |
| Public online component catalog and automatic manufacturer-data collection | Outside Phase 1. |
| DrorPlanner integration and other unselected items in earlier proposals | Not approved by this scope. |

ArduPilot source/firmware modifications, a macOS VM/container substitution, and
replacement of UAVLogViewer with a different viewer require a separate recorded
decision if needed. None is implicitly authorized by a technical blocker.

## 3. Execution Plan

This is the ordered plan for a later authorized development session, not permission
to implement during the audit/documentation session. Reuse existing capabilities
only after checking their actual integration and evidence. S-IDs do not renumber
existing roadmap tasks.

### Prioritized work

1. **Resolve feasibility and acceptance decisions early.** Verify external ArduPilot
   on Apple Silicon, 16-motor allocation/output transport, synchronized clock/pause,
   offline dependencies, and UAVLogViewer license/extension/log compatibility.
   Inventory available terrain. Record exact versions and remaining blockers.
2. **Map approved requirements to existing work.** Reconcile older roadmap/spec
   conflicts with this scope in a separately authorized implementation change.
   Keep deferred modules frozen; establish numerical and performance acceptance
   before using those limits to declare success.
3. **Create the versioned aircraft/component data foundation and editors.** Implement
   local save/reopen/import/export, input modes, measured combinations, Sensors
   settings and motor mapping, including 16-motor configurations (S03, S04, S08, S16).
4. **Complete approved physical models.** Couple propulsion, battery, rotor/body
   aerodynamics, sensor models, geographic environment and basic ground contact.
   Verify independent model behavior and validity limits (S05-S08, S18).
5. **Deliver the integrated external-SITL session.** Local prerequisite/launch flow,
   actual readiness, motor checks, manual connection, stop/restart and synchronized
   pause on macOS (S01-S03). Establish a complete nominal flight before adding batches.
6. **Establish recording and parameter provenance.** Implement channel/rate controls,
   storage estimates and full-run recording alongside parameter read/write/read-back,
   event history and exports. Do this before relying on comparative runs (S11, S13, S16).
7. **Add flight scenarios, weather changes and faults.** Reproducible tasks, manual
   and scheduled effects, EKF-drift observations, real-time/accelerated modes and
   sequential user-defined parameter batches (S07, S09, S10, S12). Refresh EW evidence
   against the actual changed sources, not historical capture verdicts.
8. **Integrate UAVLogViewer and comparison.** DataFlash and experiment access,
   side-by-side/overlay plots, time alignment, parameter-event markers and experiment
   context (S14), building on early feasibility findings.
9. **Add experiment creation from logs and fidelity comparisons.** Extract only
   available inputs, allow manual completion, run changed parameters and compare
   model response with real evidence without blocking pre-flight tuning (S15).
10. **Complete visualization and existing-terrain integration.** Geometry-derived
    views, route/telemetry, available terrain coverage and missing-data handling,
    without adding new providers or deferred effects (S17, S18).
11. **Run integrated acceptance and prepare local delivery.** Execute S19, including
    the 16-motor hour, clean macOS installation, offline operation, storage behavior,
    recording/viewer/export workflows and agreed target-machine performance. Record
    PASS, FAIL, BLOCKED and NOT_RUN separately; provide installation/recovery guidance.

### Decisions and evidence still required

These are open implementation/acceptance details within the approved scope, not
reasons to drop mandatory features or to claim that they already work.

| Decision / verification | Required resolution |
| --- | --- |
| ArduPilot version and 16 outputs | Pin a compatible version/frame allocation and verify the complete command path for all 16 motors. Escalate a limitation instead of reducing scope. |
| macOS launch method | Verify native Apple Silicon execution and local bridge/launcher installation. Obtain a separate decision for a VM/container fallback. |
| External pause/accelerated clock | Demonstrate clock ownership, pause without induced failsafe, and supported parameter access while paused. |
| UAVLogViewer | Confirm upstream identity/version/license, offline bundling, extension approach and adapters for both external and MirageSITL logs. |
| Data formats and defaults | Define UI import/export formats for measured data and models, validation rules and the common default logging frequency. Expose source-specific limits. |
| Physics and fidelity | Specify models, inputs, operating envelopes and numerical tolerances; agree measurable fidelity criteria for each relevant comparison. Do not turn failed NASA/UIUC evidence into PASS. |
| Basic contact | Specify the basic support/contact approximation while keeping gear editing and specific gear fidelity out of scope. |
| Hardware and performance | Agree Apple Silicon reference devices, macOS/Chrome versions, real-time budgets and recording workloads. Reconcile historical GPU gates explicitly; Windows gates cannot remain Phase 1 blockers. |
| Existing maps and dependencies | Inventory actually available imagery/elevation, coverage, licenses and offline assets. New provider onboarding is deferred. |

No delivery dates or effort estimates were approved. These must follow feasibility
checks and task decomposition, not be inferred from this scope.

## 4. Developer Guardrails

**Instruction for future Claude Code sessions and other development agents:**

> Develop strictly according to this document. Any deviation or unsolicited feature
> addition is prohibited without separate stakeholder approval.

1. Read this scope and the repository agent instructions before planning work. This
   approved scope controls product inclusion/exclusion; older plans do not override
   it. Keep existing technical safeguards unless explicitly revised through approval.
2. This approval concludes an audit and requirements session. Do not write or commit
   working code in this session. Begin implementation only under a subsequent explicit
   development instruction, and remain within that instruction's selected scope.
3. Map each development task to an S-ID and its Acceptance Criteria. Routine technical
   choices within approved behavior may be made normally; changing behavior, adding
   features, removing requirements or unfreezing backlog requires recorded agreement.
4. Report blockers and propose alternatives before substituting a different backend,
   platform, viewer or capability. Do not quietly omit 16-motor support, synchronized
   pause, offline use or another mandatory requirement.
5. Do not modify ArduPilot source or firmware without separate approval. Configuring
   supported stock frame/motor mappings is distinct from modifying firmware.
6. Preserve existing code and historical evidence. A deferred feature is not a
   deletion instruction. Do not implement the old physics program or version 2 plan
   wholesale merely because it is documented.
7. Distinguish implemented code, integrated behavior, observed test results and
   measured physical accuracy. Do not pass missing/unrun checks, weaken limits to
   hide failures, fabricate measurements, or reuse stale reports as current acceptance.
8. Preserve true state separately from sensor/EKF observations. Keep event timing,
   source versions, model versions and recording limitations visible in results.
9. Do not publish, deploy, commit, push, enable paid services or write to a real
   controller merely because the feature appears in this document; obtain the
   applicable action authorization. Manual export is not real-hardware control.
10. Record stakeholder-approved scope amendments in this document and its complete
    Russian mirror together. Keep the documentation index/hash current. Preserve
    requirement identities or explicitly document their replacement.
