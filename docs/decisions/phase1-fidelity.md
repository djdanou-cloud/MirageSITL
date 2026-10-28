# Phase 1 model envelopes, fidelity criteria and contact approximation

English source. [Russian mirror](../ru/phase1-fidelity.md).

TASK-133 (S05, S06, S15, S18) for decisions D-06 and D-07 in the
[Phase 1 plan](../PHASE1_PLAN.md). For each approved physical effect, this
record states the Phase 1 model, its inputs, its validity envelope, its
tolerances and what happens outside the envelope. It also defines the S15
comparisons, the confidence labels and the basic contact approximation.

The models, inputs and envelopes come from contracts that already exist in
[SPECS_SIMULATION_ENGINES.md](../SPECS_SIMULATION_ENGINES.md) and the
[roadmap](../PROJECT_ROADMAP.md). They are proposed here for approval. Two kinds
of tolerance are kept apart:

* **Verification** checks the code against a closed form, a convergence
  reference or a conservation law. Where a task contract already fixes one,
  this record repeats it.
* **Validation** compares the model with measured data. Every validation limit
  is the stakeholder's decision and stays BLOCKED_DECISION until it is approved
  with an owner and a date. An agent never invents one.

No Phase 1 model task claims acceptance before these tables are approved, and
no effect is called measured-accurate without evidence.

## Status of this record

| ID | Item | Status | Owner | Decision date |
| --- | --- | --- | --- | --- |
| F-01 | Per-effect models, inputs, envelopes and out-of-envelope behavior (table below) | Proposed; awaiting approval | Stakeholder | — |
| F-02 | Validation tolerance for each effect | BLOCKED_DECISION | Stakeholder | — |
| F-03 | Envelope bounds still open: forward-flight advance ratio, polar Reynolds-number range and bench-fit extrapolation margin | BLOCKED_DECISION | Stakeholder | — |
| F-04 | S15 comparison metrics and data (table below) | Proposed; awaiting approval | Stakeholder | — |
| F-05 | S15 comparison limits | BLOCKED_DECISION | Stakeholder | — |
| F-06 | Confidence labels and the rule for combining them | Proposed; awaiting approval | Stakeholder | — |
| F-07 | Support points derived from geometry | Proposed; awaiting approval (D-07) | Stakeholder | — |
| F-08 | Default static deflection, damping ratio and friction coefficients | BLOCKED_DECISION (D-07) | Stakeholder | — |
| F-09 | Accident criteria and the minimum contact that counts | Proposed rule; thresholds BLOCKED_DECISION | Stakeholder | — |

## Confidence labels

| Label | Meaning | Requires | Does not mean |
| --- | --- | --- | --- |
| `preliminary` | Built from specifications, geometry and catalog data only (S04 Preliminary calculation) | Nothing measured | Any measured accuracy |
| `measured-input` | The propulsion of one motor, propeller, ESC and supply combination is fitted to that combination's bench data within the fit's envelope (TASK-140, TASK-145) | A bench file bound to the combination key | Validated forward flight, descent or coaxial behavior, or a validated aircraft |
| `flight-checked` | One profile version was compared with a real flight log in the tested regimes, within the approved S15 limits (TASK-184) | A scored log and approved limits | Validity in untested regimes, or for a changed geometry, mass, motor or propeller |

None of the labels certifies exported settings for real flight. A label
belongs to a profile version, and to the regimes and effects it was earned in.
Proposed combination rule (F-06): an experiment shows the label of each effect
it uses, and the aircraft-level label is the weakest of them. A change to
geometry, mass, motor or propeller resets `flight-checked`, and a change to the
combination resets `measured-input`.

## Outside the envelope

The session already reports `VehicleFlagV2.ModelOutsideValidity` (bit 5 of the
ABI v2 vehicle flags). Outside its envelope an effect keeps running with the
documented clamped or extrapolated behavior below, sets that flag, and records
the effect and the tick. The UI shows it (S05). An iteration that fails to
converge also sets the flag; it is never silent. Unsupported later-task inputs
fail closed (status −8 in the interfaces v2).

## Per-effect table (F-01, F-02, F-03)

| Effect | Phase 1 model | Required inputs | Validity envelope | Verification tolerance | Validation tolerance | Outside the envelope | Tasks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Rotor thrust and torque, preliminary | Blade element theory with bound airfoil polars (NeuralFoil with confidence, TASK-033) | Diameter, blade count, chord and twist or catalog geometry, airfoil | The polar's angle-of-attack and Reynolds-number range (F-03) and NeuralFoil confidence | Smooth cases at 400, 800 and 1200 Hz against a 4800 Hz reference: position ≤ 0.1 m and attitude ≤ 0.5° over 10 s | BLOCKED_DECISION (F-02); the UIUC comparison currently FAILS | Flag (`FLAG_OUTSIDE_POLAR_VALIDITY`); polar lookups clamp at the table edge and never extrapolate | TASK-033, TASK-097, TASK-144 |
| Rotor thrust and torque, measured | C_T and C_P versus RPM, density-corrected, fitted from bench CSV v1 (TASK-090) | RPM, thrust, torque, voltage, current and conditions for one combination | The bench data's RPM, advance-ratio and density range, plus a margin (F-03) | Synthetic oracle recovers known coefficients | BLOCKED_DECISION (F-02) | Flag; static data are not extended to forward flight or descent silently | TASK-140, TASK-145 |
| Motor and ESC | Torque-driven DC motor `i = (d·V − k_e·Ω)/R` clamped to `[−I_brake, I_max]`, `τ = k_t·i − τ₀`, ESC duty with first-order lag | KV or k_e and k_t, winding resistance, no-load current or τ₀, current limit, ESC update rate | Within the rated current and RPM; no thermal model (S06) | Energy balance closes within 1e-9 relative | Thrust-versus-duty curvature against bench data: BLOCKED_DECISION (F-02) | A rating exceedance is a `warning`; a modeled clamp is `limited` (TASK-146) | TASK-092, TASK-146 |
| Battery | Linear open-circuit voltage versus charge, internal resistance, charge integration, power limit | Cell count, capacity, initial charge, internal resistance, empty and full cell voltage | Lumped electrical model; no heating or aging (S06) | Analytic sag and charge fixtures | BLOCKED_DECISION (F-02) | Infeasible power returns `power_limited`; a depleted pack is a hard cut | TASK-092, TASK-146 |
| Inflow in hover and climb | Annular momentum with the Prandtl tip-loss factor, at most four warm-started Newton iterations | Rotor geometry and polars | Axial flow at zero or positive climb rate | Hover momentum residual ≤ 1% | BLOCKED_DECISION (F-02) | Iteration-cap failure sets the flag | TASK-098 |
| Inflow in forward flight | Glauert edgewise inflow and Pitt–Peters three-state dynamic inflow | Rotor geometry, airspeed relative to the air | Advance ratio up to a bound (F-03) | Inflow step-response time constant within 10% of the analytic value | BLOCKED_DECISION (F-02) | Flag above the bound | TASK-098 |
| Descent and adverse descent | Empirical induced-velocity curve over `−2 ≤ V_c/v_h ≤ 0`, windmill-brake branch, vortex-ring-state boundary with seeded thrust fluctuation and roll-damping loss | Hover induced velocity, descent and edgewise speed | The curve's data range | Continuous induced velocity across branches; identical replay for one seed | Against the curve's source data and descent flight data: BLOCKED_DECISION (F-02) | Regions without data keep the flag | TASK-099 |
| Coaxial pairs | Upper-rotor slipstream with contraction `R_w = R·√((V + v_i)/(V + 2·v_i))`, added to the lower rotor exactly once; never twice one isolated rotor | Pair declaration, separation, overlap | Declared pair geometry | Momentum and energy budgets close; disabled coupling is bitwise identical | Against the TASK-024 coaxial wake reference: BLOCKED_DECISION (F-02) | Flag outside the declared geometry | TASK-101 |
| Body drag | `F = −½·ρ·|v_a|·(C_D·A)_b·v_a` with a drag-area tensor or a direction table; center-of-pressure moments | Drag areas per axis, or an estimate from geometry labeled preliminary | Airspeed range of the source data | Analytic drag fixtures | Trimmed forward-flight lean angle against a reference: BLOCKED_DECISION (F-02) | Flag beyond the source range | TASK-096 |
| Rotor ground effect | `κ = 1 − (R/4z)²/(1 + (V_t/v_i)²)` per rotor along the hub axis to the local terrain plane, with neighbor terms | Rotor radius, hub positions, terrain plane | `z/R ≳ 0.5` | Closed form within 1e-9 | Hover-height sweep or landing logs: BLOCKED_DECISION (F-02) | Flag below `z/R ≈ 0.5` | TASK-100 |
| Contact | See the contact approximation below | Profile geometry and F-08 defaults | Support points and hull on the pad or on a terrain plane | Drop, slope-hold and sideslip fixtures at 400, 800 and 1200 Hz without rate-dependent peak acceleration | No landing-gear load fidelity is claimed; the NASA drop comparison stays deferred and FAILING | Missing ground pauses the run | TASK-095, TASK-149, TASK-187 |
| Sensors | Ideal sensors or specified errors in the external-SITL path, with ownership validated before arming; lever arm `a_IMU = a + ω̇×r + ω×(ω×r)` and sensor-to-body rotation | Sensor placement and orientation, selected error terms | ArduPilot's own SITL errors follow the TASK-089 matrix; the IMU noise floors wait on D-10 | Lever-arm and misalignment fixtures match analytic values; seeded runs reproduce | BLOCKED_DECISION (F-02) | An error applied twice fails validation before arming | TASK-089, TASK-147 |
| Environment | ISA with temperature, pressure and QNH; wind and repeatable gusts; location gravity and WMM2025 | Location, weather schedule, seed | Troposphere; no terrain-induced flow (backlog) | ISA references within 1e-9 relative; replay independent of seed and FPS | BLOCKED_DECISION (F-02) | Unsupported weather commands are rejected visibly | TASK-093, TASK-106, TASK-148, TASK-167 |

## S15 comparisons (F-04, F-05)

Each comparison uses the TASK-090 metrics where they apply: RMS, bias, Theil
inequality coefficient, and the Welch H1 frequency response with coherence and
the cost `J`. Its guideline of 100 is a guideline, not a decided limit.

| Comparison | Metric | Data it needs | Limit | Owner | Date |
| --- | --- | --- | --- | --- | --- |
| Attitude and rate response | Frequency-response cost `J` per axis, from requested to actual rate; RMS and bias of the attitude error | Requested and actual attitude and rate from the log at the rate-loop logging rate | BLOCKED_DECISION (F-05) | Stakeholder | — |
| Overshoot and oscillation | Step overshoot, settling time, oscillation frequency and damping ratio | Step-like maneuvers in the log (TASK-173) | BLOCKED_DECISION (F-05) | Stakeholder | — |
| Altitude, climb and descent | RMS and bias of altitude, climb rate and descent rate | Altitude estimate, barometer, GNSS and the commanded climb | BLOCKED_DECISION (F-05) | Stakeholder | — |
| Trajectory | Horizontal position RMS and Theil inequality coefficient | GNSS or estimated position, wind estimate, the task or commands | BLOCKED_DECISION (F-05) | Stakeholder | — |
| Propulsion and energy | RMS and bias of motor RPM, battery voltage and current, and consumed charge | ESC telemetry, battery log, motor outputs | BLOCKED_DECISION (F-05) | Stakeholder | — |

Missing data leaves a comparison unverified (BLOCKED_EXTERNAL), never PASS.
Fidelity evidence belongs to one profile version and its tested regimes, and
operational acceptance (TASK-191) is separate from fidelity.

## Basic support and contact approximation (F-07, F-08, F-09)

Phase 1 has no landing-gear editor (S18), so support comes from the aircraft
geometry. The contact model is the TASK-095 compliant contact, with the Rapier
backend as the single integration owner and one terrain plane per tick from the
collision chunks (TASK-065, TASK-187).

**Support points (F-07, proposed).** One support point under each arm at the
arm's motor radius, at the profile's ground clearance below the body. A
profile without a clearance uses the lowest point of its body hull. The body
hull and every propeller disk are separate contact shapes that never carry
support.

**Default parameters (F-08, values BLOCKED_DECISION).** Defaults are derived
from three numbers the stakeholder chooses, rather than stored as fixed
constants: the static deflection `δ_s` under the aircraft's weight, the damping
ratio `ζ`, and the static and kinetic friction coefficients `μ_s` and `μ_k`.
With `N` support points and mass `m`:

$$
k=\frac{m\,g}{N\,\delta_s},\qquad c=2\,\zeta\,\sqrt{\frac{k\,m}{N}}
$$

Static friction holds below breakaway and Coulomb friction applies above it,
as in TASK-095.

**Accident criteria (F-09).** Proposed rule: any contact of the body hull or a
propeller disk is an accident (TASK-149). It is recorded with its tick,
location, impulse and load, and the run pauses on that tick. Contact on the
support points alone, including a hard landing, is not an accident. The
minimum impulse or penetration that counts as a contact is BLOCKED_DECISION.
Continuing after an accident is labeled, and it is never presented as a
validated simulation of a damaged aircraft.

## Existing verdicts that stay

* The UIUC propeller BEM comparisons FAIL their measured fidelity tolerances
  (`node scripts/validate-models.mjs` exits 2).
* The NASA TM X-3561 landing-gear drop comparison FAILS its measured
  deceleration and stroke envelopes and stays deferred by the user.

Neither is relabeled, and neither is described as missing data. TASK-033's
synthetic geometry and NeuralFoil baseline remains a software validation
baseline, not measured fidelity.

## Recording a decision

When the stakeholder approves an item or chooses a value, record it with the
owner and date in both languages and update the tasks that use it: TASK-140,
TASK-145 and TASK-184 for F-01 to F-06, and TASK-149 and TASK-187 for F-07 to
F-09.
