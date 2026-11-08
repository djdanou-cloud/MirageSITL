# SPECS_SIMULATION_ENGINES.md

Version 1.0 · 2026-10-15. **Target contract** for TASK-016..059.
Implemented `DemoDynamics` is a separate demonstration stub, not an
implementation of these models. English is the source of truth.
[Russian mirror](ru/SPECS_SIMULATION_ENGINES.md).
Binary transport: [SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md).
Tasks and acceptance: [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md).

### NACA6409 data selection (2026-10-20, TASK-033)

The operator selects NACA6409 and NeuralFoil for the new airfoil model.
`scripts/generate-neuralfoil-polar.py` generates
`tests/fixtures/polars/naca6409-neuralfoil.json` offline from analytic NACA
four-digit coordinates through NeuralFoil's internal Kulfan fit. All lift,
drag, pitching moment, transition and confidence values come directly from
NeuralFoil's `xxxlarge` model. The fixture is a neural surrogate, not a measured
dataset. Dependencies are pinned in `scripts/neuralfoil-requirements.txt`;
the fixture records package versions, source/weight hashes and coordinates.

The declared grid is alpha -30 to +30 degrees in 0.5-degree increments;
Re = 1000, 5000, 10000, 20000, 40000, 60000, 100000, 200000, 500000 and
1000000; Mach = 0 only. Settings are nCrit=9 and upper/lower transition=1.
Every value is retained, including low-confidence predictions. There is no
XFOIL fallback, coefficient fitting, gap filling or post-stall extension.

The cold diagnostic lookup interpolates linearly in alpha and logarithmically
in Reynolds number. Confidence is the minimum of the contributing corners;
below 0.9 adds `low-confidence`. This is an engineering screening rule, not an
accuracy guarantee. Out-of-grid values clamp and retain `outside-table`;
nonzero Mach adds `unsupported-mach`. Nonfinite queries, nonpositive Reynolds
numbers and negative Mach are rejected. Consumers must retain these flags.
The returned pitching moment is a section coefficient, not a rotor tilting
moment. NeuralFoil does not supply wake interaction, motor heating, battery or
airframe data. Those models and production BET binding remain separate work.

Run the generator in the pinned Python environment; `--check` regenerates in
memory and requires exact file equality without rewriting. Tests:
`python -m unittest discover -s tests -p test_neuralfoil_polar.py`.
Historical SDA1075/UIUC comparisons below retain their section identity and
fixed acceptance tolerances. A NACA6409 calculation cannot pass those measured
SDA1075 gates by substitution. The new model no longer waits for an SDA1075
polar; measured fidelity and browser autopilot admission remain unproven.

### NACA6409 BET numerical validation (TASK-033)

The configuration-driven continuation below supersedes the fixed-rotor CLI
and schema-v6 interface described in this historical increment.

`python scripts/check-naca6409-bet.py` verifies the registered polar hash and
synthetic provenance, builds the existing native `propeller_points` example,
and evaluates uniform inflow and annular tip/hub/swirl BEM at 1000/3000/6000/9000
RPM and J=0/0.2/0.4 (24 cases). The rotor is explicitly synthetic: two blades,
radius 0.15 m, root 0.045 m, constant chord 0.025 m and twist 15 degrees,
28 midpoint strips, eight azimuth samples, rho=1.225 kg/m3, mu=1.789e-5 Pa s,
sound speed 340 m/s. It does not reuse a measured propeller identity.

The native request duplicates the NeuralFoil Mach=0 coefficients at Mach=0.3
as a declared incompressible approximation; no compressibility data or
corrections are generated. Native validity flags reject states beyond that
approximation. The saved raw polar and its diagnostic query remain Mach=0 only.
An independent Python implementation integrates axial section loads and solves
uniform actuator-disk momentum with 90 bisections. Native uniform CT/CP must
agree within 1e-9 absolute plus 1e-8 relative; momentum residual must be <=1e-9
times max(1 N, rho*n^2*D^4). Annular residuals must be <1e-9 in the native
dimensionless force scale; malformed, nonfinite or nonconverged output fails.

Both solvers retain the minimum NeuralFoil confidence across all contributing
cells in the final section alpha/Re bounding rectangle. This conservative
screen can flag unused interior cells; it never averages poor confidence away.
Confidence below 0.9, outside-table, native outside-polar and outside-momentum
flags exclude a case from the screened count independently of numerical
agreement. CM/transition are retained in the source table; these rotor kernels
consume CL/CD. No section pitching-moment or transient/wake validation is claimed.

`test-results/validation/naca6409-bet.json` records geometry, assumptions,
per-case coefficients/errors/flags, fixture/executable/source hashes and Rust
version. `scripts/validate-models.mjs` runs this check and adds a required
`surrogateValidation` array in model-report schema v6 (v5 is rejected).
`numericalStatus` and `measuredFidelity: unvalidated` stay distinct. The new
section cannot satisfy a measured-data gate or change the failed UIUC results.
Production BET ABI/session wiring remains open.

### Configuration-driven synthetic BET suite (TASK-033)

Synthetic geometry is the implementation baseline by operator instruction;
no particular measured rotor is required to continue software work.
`scripts/check-rotor-bet.py` accepts `--config PATH --report PATH`; defaults
are `tests/fixtures/rotors/synthetic-bet-suite.json` and
`test-results/validation/rotor-bet.json`. The former NACA6409 CLI delegates to
this runner. `scripts/generate-neuralfoil-polar.py --airfoil NACA0012` illustrates
independent polar generation; NACA four-digit names are normalized and validated.
The default remains NACA6409, whose existing fixture bytes are preserved.

Suite schema v1 requires `provenance: synthetic` and 1..32 configurations with
unique IDs. Each selects its own airfoil and hash-registered polar fixture.
Rotor fields are `bladeCount` (integer 1..16), `radiusM` (0.001..10 m),
`rootRadiusRatio` (0..0.99), `strips` (integer 1..64), `azimuthSamples`
(integer 1..64), and `span`. Each span row is [radius/tip-radius,
chord/tip-radius, twist-degrees]; 2..64 strictly increasing rows cover the
active root through 1, chord ratio is 0.0001..2 and twist is -60..60 degrees.
Midpoint strips linearly interpolate the span distribution. The native runner
performs its own geometry/quadrature validation as well.

Each configuration also supplies density (0.05..2 kg/m3), viscosity
(1e-8..0.001 Pa s), sound speed (1..10000 m/s), and 1..128 distinct [RPM,J]
points, with RPM=0.001..100000 and J=0..5. Invalid, duplicate, missing,
nonfinite or mismatched airfoil/fixture inputs fail before solver execution.
These are parser bounds, not an experimentally validated flight envelope.
Each solver receives that configuration's geometry, environment and table;
the independent oracle takes the same explicit configuration without mutable
global geometry. Existing numerical tolerances and confidence/Mach screening
remain unchanged. Tests establish force/power scaling under geometric scaling,
linear blade-count response at prescribed state, spanwise interpolation,
independent airfoil selection and rejection of invalid configurations.

The default matrix contains a constant-chord two-blade NACA6409 rotor, a
tapered/twisted three-blade NACA6409 rotor and a tapered four-blade NACA0012
rotor (72 uniform/annular cases in total). Report schema v2 stores the suite
hash and complete configuration definitions, per-configuration polar hashes,
case identities, numerical status and screening counts. Model-report schema
v7 replaces the single-airfoil schema v6 with a required list of configuration
summaries; counts derive from the input suite, not fixed rotor assumptions.
Versions 5/6 and relabeling surrogate fidelity as measured PASS are rejected.
Both airfoils remain NeuralFoil-generated surrogates. Measured fidelity remains
separate evidence; production BET ABI/session integration remains open.

## 1. Backend invariants and units

Use SI, NED/FRD, and a body-to-NED quaternion. A single component owns
rigid-body integration. BET supplies wrench to the chosen rigid-body/contact
solver. JSBSim integrates its own dynamics and receives a consistently
coupled contact impulse. Never integrate one body twice in JSBSim and
Rapier/Jolt. The target TypeScript facade is:

```ts
export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number]; // w,x,y,z
export type BackendKind = 'demo' | 'bet' | 'jsbsim';
export interface ModelDescriptor {
  modelId: number; sha256: string; kind: BackendKind;
  massKg: number; inertiaBodyKgM2: Float64Array; // 3x3 row-major, SPD
  rotorCount: number; rotorCapacity: 32;
}
export interface StepInput {
  dtS: number; tickLo: number; tickHi: number;
  motorDuty: Float64Array; // capacity 32, values [0,1]
  surfaceDeflectionsRad: Float64Array;
  windNedMps: Float64Array; // length 3
  temperatureK: number; pressurePa: number; densityKgM3: number;
}
export interface TruthOutput {
  positionNedM: Float64Array; quaternionBodyToNed: Float64Array;
  velocityNedMps: Float64Array; angularVelocityBodyRadS: Float64Array;
  accelerationNedMps2: Float64Array; specificForceBodyMps2: Float64Array;
  rotorOmegaRadS: Float64Array;
  batteryVoltage: number; batteryCurrentA: number; validityFlags: number;
}
export interface DynamicsBackend {
  readonly kind: BackendKind;
  initialize(model: ModelDescriptor, hz: 400 | 800 | 1200): void;
  reset(seed: number): void;
  stepInto(input: StepInput, output: TruthOutput): void;
  dispose(): void;
}
```

Allocate all arrays during initialize, validate capacity, and overwrite output
in place. No fetch, await, JSON, JS/WASM allocations, logging, or memory growth
during step. dt equals the configured `1/hz`; change it only while paused
with reset. Reject invalid models before arming: non-SPD inertia, NaN,
nonpositive mass, invalid quaternion, or exceeded capacity.

Do not copy gravitational acceleration directly into HIL acceleration:
`f_b=R_nb^T(a_n-g_n)`. A stationary FRD/NED vehicle has
`f_b≈[0,0,-9.80665]` m/s²; free fall has `f_b≈0`. Zero velocity does not
imply zero accelerometer output.

## 2. BET geometry, polars, and interface

Initial limits: <=32 rotors, <=64 radial stations per blade, and <=64
azimuth quadrature samples. Counts are fixed at initialization and do not
grow during step. Rotor hub `+z_h` is the positive thrust axis, distinct
from body Down. `q_hb` rotates hub into body. Spin sign is `s=±1`, omega>=0.

```ts
export interface PolarTable {
  alphaRad: Float64Array; // strictly increasing; cover reverse and stalled flow
  reynolds: Float64Array; // positive; interpolate in log(Re)
  mach: Float64Array; // nonnegative
  cl: Float64Array; cd: Float64Array;
  // Flattened index = (iMach*nRe + iRe)*nAlpha + iAlpha.
  sourceSha256: string;
}
export interface RotorGeometry {
  id: number; bladeCount: number; spinSign: -1 | 1;
  radiusM: number; rootCutoutM: number; polarId: number;
  radialStationM: Float64Array; chordM: Float64Array;
  twistRad: Float64Array; quadratureWidthM: Float64Array;
  hubPositionBodyM: Vec3; hubToBody: Quat;
  shaftInertiaKgM2: number; bearingViscousNmPerRadS: number;
  azimuthSamples: number;
}
export interface RotorStepInput {
  densityKgM3: number; dynamicViscosityPaS: number; speedOfSoundMps: number;
  airVelocityAtHubHubMps: Float64Array; // Air velocity minus hub velocity, in hub axes.
  bodyAngularVelocityHubRadS: Float64Array;
  collectivePitchRad: number; cyclicCosRad: number; cyclicSinRad: number;
  motorTorqueMagnitudeNm: number; // Zero for a free rotor.
  dtS: number;
}
export interface RotorState {
  omegaRadS: number; azimuthRad: number;
  inducedAxialVelocityMps: number;
  flapConeRad: number; flapCosRad: number; flapSinRad: number;
  flapCosRateRadS: number; flapSinRateRadS: number;
}
export interface RotorOutput {
  aerodynamicForceHubN: Float64Array; // length 3
  aerodynamicMomentHubNm: Float64Array; // length 3; moment ABOUT HUB
  transmittedMomentHubNm: Float64Array; // Air moment minus dH/dt.
  aeroShaftTorqueNm: number; // Signed Qair along the positive hub axis.
  shaftPowerW: number; // Motor drive power = motor torque magnitude * omega.
  omegaRadS: number; validityFlags: number;
}
export interface RotorEngine {
  initialize(geometry: RotorGeometry, polar: PolarTable): void;
  reset(initial: RotorState): void;
  stepInto(input: RotorStepInput, out: RotorOutput): void;
}
```

Angle of attack, CL, CD, and RPM are not independent step inputs: derive
alpha from flow/geometry, coefficients from the polar, and RPM from omega.
A clearly labeled prescribed-RPM mode is permitted for bench tests and
must not be used for autorotation. `RPM=omega*60/(2*pi)`.
Optional element-level alpha/CL/CD telemetry writes into a preallocated
debug buffer at configured decimation, never new arrays per step.

## 3. Blade element equations and wrench transfer

For an element at radius r and azimuth psi, use `e_r=[cosψ,sinψ,0]`,
`a=[0,0,1]`, `e_t=s(a×e_r)`, and `r_h=r*e_r`.
Relative air velocity projected into the element plane is:

\[
v_{rel}=v_{air,hub}-\omega_{body,h}\times r_h
           -\Omega r e_t-v_i a,
\quad v_\perp=v_{rel}-(v_{rel}\cdot e_r)e_r.
\]

Positive `v_i` denotes induced flow in direction `-a`. Add external wakes
separately and do not count them twice in v_air. If `U=|v_perp|<1e-6 m/s`,
element forces are zero and atan2 is not evaluated.

\[
U_t=-v_\perp\cdot e_t,\quad U_a=-v_\perp\cdot a,
\quad\phi=\operatorname{atan2}(U_a,U_t),
\]
\[
\beta(r,\psi)=\theta_{collective}+twist(r)
                 +\theta_c\cos\psi+\theta_s\sin\psi,
\quad \alpha=\operatorname{wrap}_{[-\pi,\pi)}(\beta-\phi),
\quad Re=\rho Uc/\mu,\quad Ma=U/c_{sound}.
\]
\[
\hat d=v_\perp/U,\quad \hat l=s(\hat d\times e_r),
\quad dF=\tfrac12\rho U^2c\,dr\,(C_L\hat l+C_D\hat d),
\quad dM=r_h\times dF.
\]

Mirroring spin and blade-pitch convention preserves thrust and reverses
shaft torque. Radial/azimuth integration includes bladeCount and normalized
azimuth averaging, not another multiplication by sample count. Reject polars
with negative CD, NaN, or ambiguous ordering. Outside the Re/Mach table,
clamp deterministically and set OutsideValidity instead of silently
extrapolating. The declared flight envelope requires stall/reverse-flow coverage.

TASK-019 implements the lookup in `native/bet/src/polar.rs`. `PolarTable`
borrows caller-owned axes and tables and validates them once: non-empty
axes, table length `nMach*nRe*nAlpha`, finite and strictly increasing axes,
`Re>0`, `Ma>=0`, finite coefficients, and `CD>=0`. Lookup is trilinear in
`(Ma, ln Re, alpha)`, evaluated along alpha, then ln Re, then Mach. Each
coordinate outside its axis, alpha included, is clamped to the boundary and
sets `OUTSIDE_POLAR_VALIDITY` (output flag bit 1); a non-finite query
returns NaN coefficients with the flag. The caller wraps alpha into
`[-pi, pi)` first. Lookup does not allocate.

Rotor dynamics use `Q_air=a·M_air`, the **signed** aerodynamic torque:

\[
J\dot\Omega=\tau_{motor}+sQ_{air}-\tau_{bearing}(\Omega),
\quad H_h=sJ\Omega a,
\quad M_{hub}=M_{air}-\left({dH\over dt}\right)_{inertial,h}.
\]

The H derivative includes `omega_body×H` and axis changes caused by flap or
gimbal motion. Using only Q_air as body torque while integrating RPM
separately loses spin-up and gyroscopic momentum. If motor reaction is
already included through this equation, do not add `-s*tau_motor` again.
The inertia ledger separates the spin degree of freedom from body inertia.

Aggregate every rotor in body coordinates:

\[
F_b=\sum_i R_{hb,i}F_{h,i},\quad
M_b=\sum_i\left(r_{b,i}\times R_{hb,i}F_{h,i}
                         +R_{hb,i}M_{hub,i}\right).
\]

### Inflow, coaxial interaction, and autorotation

The first inflow solver is an explicitly limited axial model. Hover
validation uses `T≈2*rho*A*v_i*|v_i|`; this is not a universal vortex-ring
or autorotation equation. Dynamic inflow has its own state and bounded
iterations, at most four per step. Failed convergence sets OutsideValidity.
Coaxial coupling accounts for separation, overlap, wake direction, and
energy transfer. An arbitrary coefficient such as 0.8 requires source data.

A free rotor has motor torque=0. RPM evolves from driving/braking regions
of aerodynamic torque, inertia, and bearing loss. Test acceleration,
deceleration, equilibrium, and recovery after airflow changes. Do not
stabilize RPM with an artificial governor. Flapping/coning require dynamics
with hinge inertia, stiffness, damping, and aerodynamic moment; tilting the
mesh is insufficient. Store parameters and the validity envelope in the
model manifest. Without autogyro reference data, label the model experimental
even when torque-balance tests pass. TASK-022 owns free-shaft dynamics,
TASK-023 owns flapping, and TASK-033 owns model validation. UI must not hide
a failed model gate.

### Experimental coaxial wake reference (TASK-024)

`native/bet/src/coaxial.rs` provides `WakePair`, `CoaxialWake::new(pair,rho)`
and allocation-free `evaluate(source_thrust_n) -> Result<WakeReport,WakeError>`.
This is a steady incompressible top-hat mixing-jet reference derived from ideal
hover actuator-disk momentum, not an empirically calibrated coaxial rotor map.
Every successful report carries experimental=true. The spreading half angle is
an explicit synthetic/configuration parameter, never an implicit efficiency factor.

Disks must be aligned and parallel, with receiver downstream along source hub −z.
Only source thrust >=0 is supported; reverse wakes, swirl, mutual pressure
feedback, oblique flight, VRS, dynamic transport delay and receiver extraction
feedback are excluded. Zero separation is a mathematical limit of the contracted
wake, not a physical claim about coincident disks. Actual pair poses/IDs must
be matched to the airframe by a future adapter.

WakePair contains distinct stable upper_id/lower_id in [0,31], separation_m
[0,1e9], overlap [0,1], source_radius_m/receiver_radius_m [0.001,100],
spread_half_angle_rad (0,pi/4], and enabled. Density is [0.05,2] kg/m³.
Non-finite values and invalid geometry are rejected at construction; source
thrust must be finite, nonnegative, and yield ideal launch speed <=100 m/s.
Negative thrust and unsupported speeds fail even when interception is disabled.

Let A_s=pi*R_s². Ideal hover contracts the launch area to A_0=A_s/2 and gives
u_0=sqrt(T/(rho*A_0)), source ideal kinetic power P_0=T*u_0/2. At distance d,
use the explicit spreading geometry and momentum-conserving core velocity:

\[
R_w=R_s/\sqrt{2}+d\tan\theta,\quad A_w=\pi R_w^2,\quad
u_w=u_0{R_s/\sqrt{2}\over R_w},\quad \rho A_w u_w^2=T.
\]

The supplied overlap multiplies the smaller of the wake and receiver areas;
it is not an automatic geometric disk-intersection solver. With receiver area
A_r, interception area A_i=overlap*min(A_w,A_r), f=A_i/A_w, g=A_i/A_r.
Disabled coupling sets A_i=0. Add only delta_v_h=(0,0,−g*u_w) to the receiver's
existing air-minus-hub velocity, once. Do not also inject it as receiver induced
velocity: that would double-count the source wake. Source self-inflow is separate.
The area-averaged uniform velocity is an approximation; nonlinear blade loading
in a partially covered disk is not resolved spatially.

The report retains separate advected momentum and kinetic-power budgets:

\[
P_w=P_0{R_s/\sqrt{2}\over R_w},\quad
P_{received}=fP_w,\quad P_{bypass}=(1-f)P_w,\quad P_{mix}=P_0-P_w\ge0,
\]
\[
\Pi_{received}=fT,\quad \Pi_{bypass}=(1-f)T,\quad
P_{received}+P_{bypass}+P_{mix}=P_0,\quad
\Pi_{received}+\Pi_{bypass}=T.
\]

These are air fluxes, not additional receiver thrust or a motor-power credit.
P_0 is inferred ideal hover source power, not measured shaft power; there is no
claim of full two-rotor energy closure with a real airfoil/shaft model. Mixing
loss is a passive air-energy sink. Disabling interception preserves the budget
with all remaining wake flux bypassing the receiver, and changes no rotor input.
For positive spreading angle, u_w tends to zero with distance, so the receiver
approaches its independent-rotor result. Overlap scales interception linearly.

The independent synthetic `tests/fixtures/rotors/coaxial.json` records all
parameters, analytic expected fluxes, provenance and a registered SHA-256.
Its 0.1 rad spreading angle is a scenario choice, not a fitted measurement.
Fixture/native/WASM field comparisons use absolute 1e-9; general budget checks
allow 1e-9 + 1e-12*|source| for floating-point scale. Disabled/zero-overlap tests
require exact independent-wrench equality; the far-field test uses 1e-6 N/Nm.
The native allocator probe includes 1e6 wake evaluations with zero allocation
calls/bytes. Test-only scalar/SIMD WASM exports exercise the fixture, budgets,
decoupling, and 1e6 varying-thrust evaluations without allocation traps or memory
growth. Production C ABI, application backend and model registry are unchanged;
this reference is not enabled in the demo and is not training validation.

### ESC, battery, and mechanical faults

Choose either a first-order duty/RPM governor or an electromechanical torque
model explicitly; do not run conflicting spool ODEs. The torque model uses
`I_m=clamp((duty*V-k_e*Omega)/R_m)` and `tau_m=k_t*I_m`, with documented
current and regeneration limits. Battery equations are:

\[
V=V_{oc}(SOC)-IR_{int},\quad \dot{SOC}=-I/Q_C,\quad
I={V_{oc}-\sqrt{V_{oc}^2-4R_{int}P}\over2R_{int}}.
\]

If requested P is infeasible, limit current/power to the admissible domain
and set power-limited. As R approaches zero, use I=P/Voc. P includes ESC
efficiency and house load without double-counting current or heat losses.
Update electrical and mechanical states consistently.

`motor-loss power-cut` sets/scales motor torque while preserving passive
aerodynamics, RPM/inertia, and gyroscopic effects. `instant-thrust-loss`
immediately scales one rotor's force/aerodynamic moment as an **idealized
scenario fault**. It is not physically equivalent to cutting power; mark
the model OutsideValidity for energy validation. Motor IDs are stable in
the manifest and do not automatically equal MAVLink channel numbers.

### Atmosphere and deterministic gusts (TASK-032)

The configuration-time `atmosphereFromState(unknown)` schema accepts exactly
finite temperatureK [180,330] and pressurePa [1000,120000], deriving density
[0.05,2] kg/m³, viscosity, and sound speed; density cannot be overridden.
`isaTroposphere` uses geopotential altitude [0,11000] m, T=288.15−0.0065h,
p=101325(T/288.15)^(9.80665/(287.05287*0.0065)), rho=p/(287.05287T),
a=sqrt(1.4*287.05287T), and Sutherland viscosity with mu0=1.716e-5 Pa·s,
T0=273.15 K, S=110.4 K. These dry-air SI values are shared backend inputs;
this task does not connect weather to the current demo or JSBSim, and TASK-093
connects it to the BET flight dynamics (see below).

`Wind` preallocates three RNG streams (IDs 0/1/2), reset by the session seed.
At fixed 400/800/1200 Hz (and the 4800 Hz BET convergence rate, TASK-093), each
gust component follows
x_next=a*x+sigma*sqrt(3*(1−a²))*(2u−1), a=exp(−2*pi*bandwidthHz/hz),
u in [0,1). This bounded-innovation AR(1) has stationary variance sigma²
and pole bandwidth in (0,hz/2); it is synthetic, not Gaussian OU or Dryden.
Mean is limited to ±200 m/s per axis and RMS to [0,50] m/s; a bandwidth so
small that decay rounds to one is rejected during configuration.
The caller owns length-three NED output; render grouping never advances RNG.
Atmospheric setup may allocate; wind stepping reuses storage. The allocation
probe is `node scripts/bench-wind.mjs`, report test-results/bench/wind.json.

### Dryden turbulence (TASK-106)

The Phase 1 increment of TASK-106 adds MIL-F-8785C's low-altitude Dryden
turbulence in `packages/physics/src/turbulence.ts`, as the effect
`wind.turbulence` (SPECS_SHARED_MEMORY, "Control Protocol v3"). The synthetic
AR(1) gust above stays, because a `weather.set` still names it and flies as it
did. The two add when both are on.

```text
H_u(s)   = σ_u·√(2·L_u/(π·V)) / (1 + (L_u/V)·s)
H_v,w(s) = σ·√(L/(π·V))·(1 + √3·(L/V)·s) / (1 + (L/V)·s)²

With h in feet, for 10 ft ≤ h ≤ 1000 ft:
L_w = h         L_u = L_v = h/(0.177 + 0.000823·h)^1.2
σ_w = 0.1·W20   σ_u = σ_v = σ_w/(0.177 + 0.000823·h)^0.4

One unit-variance step of a channel with θ = dt·V/L, x = 2·θ:
u[k+1]     = e^(−θ)·u[k] + √(1 − e^(−x))·n
[z p][k+1] = Φ·[z p][k] + chol(I − Φ·Φᵀ)·[n1 n2]
Φ = e^(−θ)·[[1 + θ, θ], [−θ, 1 − θ]]
v, w = σ·(z + √3·p)/2
```

u lies along the horizontal mean wind (north when there is none), v 90° to its
right and w down. The filters are discretized exactly: the sampled states have
the variance and autocovariance of the continuous filters at any step, with
R_u(t) = σ²·e^(−|t|·V/L) and R_v,w(t) = σ²·(1 − |t|·V/(2·L))·e^(−|t|·V/L). The
sampled spectrum is the continuous one folded at the sampling rate. The states
have unit variance, so a change of σ moves the output and no state jumps. The
noise covariance's entry 1 − e^(−x)·(1 + x + x²/2) cancels to x³/6 when the step
is short against the eddy, as at 1200 Hz in a large eddy, so it comes from its
series below x = 0.5.

* **Inputs.** W20 is the mean wind at 20 ft (6 m) that sets the strength, 0..50
  m/s (MIL-F-8785C calls 15, 30 and 45 knots light, moderate and severe). h is
  the height above the origin, held at the 10 ft values below 10 ft and at the
  1000 ft values above 1000 ft, where the three channels agree; the model has no
  terrain yet. V is the speed through the air, from this tick's mean flow and the
  vehicle's velocity.
* **Hover.** V goes to zero in a hover in still air, where Taylor's frozen-eddy
  assumption behind the filter has nothing to carry the eddies, so V reads as at
  least W20: turbulence of that strength lives in a wind of about that speed. This
  is a choice made for hover, not part of MIL-F-8785C; the Kaimal spectra the
  roadmap names for hover are not implemented.
* **Determinism.** Five fixed streams, one per normal draw (`DRYDEN_STREAMS`).
  Coefficients refresh on tick indices, every `round(hz/50)` ticks, so a run
  repeats whatever the wall pacing. A start draws the states from their stationary
  distribution, so there is no spin-up.
* **Controls.** Intensity multiplies σ, so one seed gives one realization, exactly
  scaled while V and h are the same; W20 as written still sets the slowest
  carrying speed. A new mean wind or new air leaves it running; its own control
  starts it again from its seed. Off or W20 = 0 draws no random numbers and adds
  nothing. A `weather.set` neither starts nor stops it.
* **Not modelled.** One uniform field at the CG and every hub: no rotational gusts
  or inter-hub coherence, no von Kármán or Kaimal spectra, no medium or high
  altitude form. Those stay with TASK-106 beyond Phase 1.

### Faults on the path to ArduPilot (TASK-168)

Each fault goes in on the path that owns the reading, and truth stays in the
session. Three families of `effect.set` carry them (SPECS_SHARED_MEMORY,
"Control Protocol v3").

| Effect | Path | What ArduPilot gets | What it showed on the native flights |
|---|---|---|---|
| `sensor.imu.frozen` | State line (`delivery`) | The last gyro and accelerometer values | RAW_IMU gyro stops; EKF failsafe, and the quad struck the ground within 8 s |
| `sensor.gnss.frozen` | State line (`delivery`) | The last north and east position and ground velocity; height and vertical speed go on, because they also feed its barometer | GPS_RAW_INT latitude and longitude stop while the aircraft moves 1.4 m; it stays in GUIDED, unaware |
| `sensor.mag.frozen` | State line (`delivery`) | The last attitude, from which SITL makes the magnetometer; the IMU still turns | RAW_IMU magnetometer stops through a 64° turn; it stays in GUIDED |
| `sensor.baro.frozen` | `SIM_BAROn_FREEZE` (`ardupilot`) | The last altitude | Read back; it stays in GUIDED |
| `sensor.baro.missing` | `SIM_BAROn_DISABLE` (`ardupilot`) | No barometer | SYS_STATUS barometer unhealthy; it stays in GUIDED |
| `sensor.mag.missing` | `SIM_MAGn_FAIL` (`ardupilot`) | No magnetometer | SYS_STATUS magnetometer unhealthy; it stays in GUIDED |
| `sensor.gnss.missing` | `SIM_GPS1_LCKTIME` (`ardupilot`; `SIM_GPS1_ENABLE` until TASK-169, whose write renumbers the parameter list) | No fix | Fix type 1 with 3 satellites; EKF failsafe and LAND, and after it ends "EKF Failsafe Cleared" with the mode left in LAND |
| `sensor.imu.missing` | `SIM_ACC_FAIL_MSK`, `SIM_GYR_FAIL_MSK` (`ardupilot`) | No IMU samples | ArduPilot's main loop stops and sends nothing more, and switching the fault off cannot reach it: the run has to end |
| `link.pilot` | Bridge (`delivery`) | No RC_CHANNELS_OVERRIDE | Nothing visible in GUIDED, which does not read the sticks |
| `link.gcs` | Bridge (`delivery`) | No MAVLink either way | Silence, then the same state on recovery |

* **Delivery effects.** The session holds a mask of DELIVERY_* bits, changed in
  place at tick boundaries. The link reads it at every reply and leaves what is
  frozen as it was on the last reply; the bridge client reads it for each MAVLink
  frame. Neither allocates. Since MirageSITL sends the attitude and position only
  on the state line, freezing the magnetometer and the GNSS is possible without a
  firmware patch (D-10), and the JSON backend's IMU keys stay independent. Without
  a link attached the session rejects them visibly; a closed link or a new epoch
  clears the mask. A stick command is lost after the input watchdog, which watches
  whether the pilot still commands.
* **ArduPilot's own faults.** `SessionController.setEffect` writes the parameters
  of `ARDUPILOT_FAULT_PARAMETERS` through the parameter service, logged as any
  write, and restores each parameter's earlier value when the effect goes off. All
  of an effect's parameters must be in the list or none is written. The effect
  stands as its read-backs do. A session rejects these visibly, on or off.
* **Motor faults** act on actuation only, through the same `motor.loss` record, on
  the profile dynamics: a run's motor table is bound when its dynamics is adopted.
* **Truth.** With a sensor or link effect on, every truth value is bitwise identical
  to the run without it for the same servo frames (`tests/delivery-effects.test.ts`).
  A closed loop with ArduPilot differs afterwards only because ArduPilot reacts.
* **Recorded, not predicted.** `tests/sitl-fault-effects.test.ts`, on request with
  `MIRAGE_SITL_FAULTS=1`, flies one flight per fault and asserts only that the fault
  arrived; `test-results/validation/task-168-faults.json` keeps ArduPilot's modes,
  messages, health bits and EKF flags. In a run, the recording keeps them.
* **Not here.** The instructor console is on the demo page, where these are rejected.

### Faults and interference tab (TASK-169)

The tab offers the `fault`, `delivery` and `ardupilot` families of `EFFECT_CATALOG`, from one form per effect, and says for each how it reaches ArduPilot. Motor faults change the physical thrust; sensor and link effects change what ArduPilot observes, and the truth stays as it is.

```typescript
interface ScheduledEffect {
  control: EffectControl;     // enabled; the protocol's own record
  onsetS: number;             // simulated seconds after the first armed report
  durationS: number | null;   // null keeps it on until the run ends
  recovery: EffectRecovery;   // what a drift does when it ends
}
interface FaultSchedule { schemaVersion: 1; entries: ScheduledEffect[] }
interface EffectEntry {
  id: string; effect: EffectId; enabled: boolean; intensity: number;
  status: "pending" | "applied" | "rejected"; message: string;
  origin: "manual" | "schedule";
  requestedSimS: number | null;  // asked for, or meant for on a schedule
  appliedSimS: number | null;    // its tick in the session, or the last read-back
  writes: string[];              // the ArduPilot parameters it writes
}
```

* **Time.** A schedule counts simulated seconds from when ArduPilot first reports the aircraft armed, in a heartbeat, so a repeat meets its faults at the same point of the flight however long its warmup took. That report comes at the heartbeat's rate, so the zero itself is known to within a second of simulated time.
* **Rules.** Two entries of one effect cannot overlap, nor two of one motor, because the later would replace the earlier. What cannot be delivered is refused where the user sees it, by hand or on the tab.
* **Sending.** Effects the session applies are queued up to 5 s ahead on the tick of arming plus onset, and land on it. Parameter writes go when due, and their entry says when their read-back came. A control asked for now is aimed 0.25 s of simulated time ahead of the tick read now, and at twice that each time it is refused as past, because the Worker steps while the message crosses to it.
* **Record.** The experiment record holds the schedule, and a repeat flies its parent's. `effect-log`, one item per run with a new version whenever an entry changes, holds the entries; it depends on the experiment. It says what reached ArduPilot; what ArduPilot did about it is in the run's recording and log.
* **Delivery.** `PhysicsSessionV2.delivery` gains the GNSS offset and velocity and the magnetometer rotation, which the fault port copies out after each step while a link is attached, without allocating. With all of it off, what is delivered is bit for bit as without. A frozen reading wins over an offset.
* **Jamming** cannot reach the state line: it has no field for a satellite count. The writes follow the kernel's arithmetic at its steady state, because a parameter write does not resolve its half-second low-pass, and a position accuracy grows in proportion to the DOP against SITL's fixed hDOP of 1.21.
* **Magnetometer rotation** relies on SITL making its reading from the attitude on the line: q ⊗ conj(r) turns the body field by r and leaves the IMU keys alone.

| Effect | Path | What ArduPilot gets | What it showed on the native flights |
|---|---|---|---|
| `ew.position-step` | State line, north and east | The offset, on its tick; a vertical one is refused | 30 m north: GPS_RAW_INT read 30.02 m from the truth, after one report halfway from SITL's own lag; EKF3 switched lane and said "GPS Glitch or Compass error", the truth moved 0.03 m, and it stayed in GUIDED |
| `ew.velocity-drift` | State line, north and east | The offset and its velocity, on each tick; a vertical one is refused | 0.3 m/s² to 2 m/s for 8 s: 9.35 m from the truth (the form gives 9.33 m), with no message; the aircraft followed it, and the truth moved 9.52 m |
| `ew.magnetic` | Rotation: the attitude on the state line. Bias: `SIM_MAGn_OFS`, added to what the run holds | A reading turned on its tick; a bias as logged writes | 0.3 rad with 0.1 G: the reading moved by 107 and 197 mG in its axes, the aircraft turned 0.84 rad, and it stayed in GUIDED |
| `ew.gnss-jamming` | `SIM_GPS1_NUMSATS`, `SIM_GPS1_ACC`, `SIM_GPS1_LCKTIME` | Satellites and accuracy at the severity, no fix at 0.8 or when below 4 satellites; a DOP has no parameter | Severity 0.5: 6 satellites and 12.4 m read back, with no message and the same EKF flags |

### EKF drift (TASK-170)

An input error, never a change to ArduPilot's estimate: the GNSS position runs away from the truth in one direction, coherently with its velocity, on the coherent drift of TASK-055, and goes by the state line as TASK-169 delivers a drift. ArduPilot may follow, reject the readings or enter a failsafe, and nothing promises which. The Faults tab's form makes this profile:

```typescript
interface EkfDriftProfile {
  schemaVersion: 1;
  directionDeg: number;   // the way the GNSS position runs away, clockwise from north
  growthMps2: number;     // above 0, at most 0.3, the drift model's range
  topSpeedMps: number;    // above 0, at most 20
  onsetS: number;         // simulated seconds after the first armed report
  durationS: number;      // how long it grows
  removal: "gradual" | "abrupt";
}
```

\[
v(t)=\min(a\,t,\;V),\qquad b(t)=\int_0^t v\,d\tau,\qquad V_p=\sqrt{a\,b_1+\tfrac{v_1^2}{2}}.
\]

While it grows, t counts from its onset, a is the growth rate and V the top speed. An abrupt removal drops b and v to 0 at once, an explicit discontinuity. A gradual one starts from (b₁, v₁): it accelerates at -a through zero speed to -V_p, or cruises at -V when V_p would pass it, and brakes at +a to stop at b = 0. The error therefore grows a little further while it brakes, because b never fades without its derivative (TASK-055). The profile becomes one schedule entry per stretch of constant acceleration, each starting where the one before ended, and the last ends with a step to the truth, which clears what a tick's rounding left. `FaultSchedule.ekfDrift` holds the profile, and a stored schedule whose entries are not exactly its profile's is refused.

The Experiments tab charts `truthVsEstimate` for a run with a schedule and a recording. The estimate is what ArduPilot reports in GLOBAL_POSITION_INT, converted with its own metres per degree so the conversion adds no error near home, and the truth is read straight between its neighbouring rows at the simulated time of each report. Errors are the estimate minus the truth, on north, east and down. What the drift added to the input is drawn beside the error, from the form above. None of these numbers has a limit. Reports where the recording holds no truth are counted and left out, and so are reports of all zeros, which ArduPilot sends until the EKF has a position.

### Weather and atmosphere in flight sessions (TASK-093)

A dynamics with an atmosphere and wind implements `SessionDynamics.setWeather`;
today that is `BetFlightDynamics`, which `profileFlightDynamics` builds for
aircraft profiles and the ArduPilot SITL path. The demo backend still rejects
`weather.set` at admission. The session applies a due `weather.set` before
integrating its tick: it copies the command into the `WEATHER_*` slots of
`atmosphere.ts` (wind north, east and down, gust RMS, seed, temperature,
pressure) and calls `setWeather(slots)`, so no number crosses a call where V8
could box it; `Wind.configure` and `SeededRandom.resetFrom` read the slots in
the same way.

TASK-166 applies effect controls (SPECS_SHARED_MEMORY, "Control Protocol v3")
through the same call. The session holds which of mean wind, gust and air are
on, and their values in the slots, and calls `setWeather` when one changes;
with none on it calls `clearWeather`, which restores still air and the
configured atmosphere, and an effect that was never on calls nothing. Three
slots serve this: `WEATHER_GUST_BANDWIDTH` (Hz, 0 keeps the bandwidth),
`WEATHER_GUST_KEEP` (1 leaves a running gust alone; only the mean wind and the
gain change) and `WEATHER_AIR_KEEP` (1 leaves the configured atmosphere in place
and the published pressure the standard atmosphere's, so wind alone does not
change the air). A `weather.set` sets all three effects on, with a bandwidth of
1 Hz, a restarted gust and the air of its temperature and pressure, so it flies
as it did. `setWeather` also refuses a bandwidth at or above Nyquist or too low
to resolve. The table empties with every new epoch.

Every step evaluates the ISA troposphere at the CG's height h = −down above
the origin, from the origin's air T0 = `temperatureK` and p0 = `pressurePa`
(`atmosphereAtHeightInto`): T = T0 − L·h, p = p0·(1 − L·h/T0)^(g/(R·L)),
ρ = p/(R·T), the Sutherland viscosity of TASK-032 and a = sqrt(1.4·R·T), with
L = 0.0065 K/m, g = 9.80665 m/s² and R = 287.05287 J/(kg·K). The contract's
temperature offset ΔT and sea-level pressure p0 reach the origin's air
through `airAtOrigin(p0, ΔT, e)` for an origin e metres above mean sea level:
T = 288.15 + ΔT − L·e and p = p0·(T/(288.15 + ΔT))^(g/(R·L)). A `weather.set`
that carries this air gives every tick T = 288.15 + ΔT − L·(e + h) and
p = p0·(1 − L·(e + h)/T0′)^(g/(R·L)), T0′ = 288.15 + ΔT, because the
polytropic profile is the same from any datum. With ΔT = 0, p0 is the QNH of
the ICAO altimeter relation. TASK-148 supplies the elevation and a measured
QNH, and TASK-167 the Weather tab. TASK-032's Sutherland constants give
1.78930e-5 Pa·s at sea level, 5.4e-5 below the ICAO table's 1.7894e-5; this
task keeps them.

Within a step the gust advances first. The wind of the tick is the mean plus
the gust, one uniform field at the CG and every rotor hub: each hub's inflow
is that wind minus the hub's velocity, rotation included (TASK-106 adds
inter-hub coherence and TASK-107 shear). The rotors read the density,
viscosity and speed of sound of the air at the CG at the start of the step.
After integrating, the dynamics computes the air at the new height
(`BetFlightDynamics.air`, the `AIR_*` slots), which the next step's rotors read
and the session publishes; `setWeather` computes it for the first tick.

While a weather is in effect the published `trueAirspeedMps` is |v − w|, the
speed relative to the air, and `ambientPressurePa` is the weather's pressure
at the CG. The SITL link writes `velocity_wind` = w into the JSON line (a key
of the TASK-041 oracle). The line carries no `airspeed` until the TASK-089
oracle covers that key, so `SIM_JSON` at the pinned commit still derives its
airspeed from the ground velocity. Without a weather nothing changes, bit for
bit: still air, the configured density, viscosity and speed of sound, no
`velocity_wind`, and the standard atmosphere's pressure with the origin at
mean sea level.

`setWeather` refuses, changing nothing, a mean wind beyond 200 m/s per axis, a
gust RMS outside 0..50 m/s or a seed that is not a uint32 (the gust model's
envelope), and air outside 180..330 K, 1..120 kPa or 0.05..2 kg/m³ at the
origin or at the CG. The session rejects such a command with OUT_OF_RANGE at
its tick and faults, as for any scheduled command a model refuses. Admission
holds the same ranges (TASK-166), and refuses an `atmosphere` control's density
as well, so what reaches the tick is a `weather.set`'s density or the air at the
vehicle's height. A
vehicle that flies out of the air envelope faults the dynamics ("BET
atmosphere outside its envelope"). Every new epoch (`sim.reset`,
`sim.configure`, `model.load`) starts without weather.

Verification (TASK-093): `tests/atmosphere.test.ts` checks the ISA above any
reference air against its defining equations written independently, within
1e-9 relative over 200 combinations of reference air and height (those
outside the envelope refused), the standard tables at their printed
precision, `airAtOrigin` against the contract formula, and `Wind.configure`
against a newly built gust. `tests/weather-plumbing.test.ts` runs the real
session on the synthetic BET quad: the weather applies on its exact tick in
four epochs (400 Hz, 400 Hz after a reset, 800 Hz and 1200 Hz), the rotors'
air and the published pressure match the oracle and the published airspeed
is relative to the air; air outside the envelope is refused with
OUT_OF_RANGE and a fault until a reset; a seeded gust replays bit for bit
under fine, 10 ms and irregular wall pacing, and another seed differs; a
constant wind flies the calm flight offset by the wind (Galilean invariance,
within 1e-9 over 400 steps); an idle vehicle drifts downwind; and a reset
restores the configured air bit for bit. `tests/external-sitl-session.test.ts`
checks `velocity_wind` in the JSON line from the weather's tick, and
`node scripts/check-bet-runtime.mjs --allocation` measures the weather graphs
(G1): the gust and the per-step air with a weather re-applied every 1000
steps, and the real session applying scheduled `weather.set` commands in
4000-tick windows. That series has no forced full GC between its windows, as
in the Worker: in the check's process, after its other graphs, a forced full
GC that collects an applied command's shape makes V8 discard the optimized
tick ("embedded weak objects cleared"), which then boxes numbers until it is
recompiled. Measured with that GC, the session averaged 44 B per tick; a
fresh process measures 0 with or without it.

### Airframe drag (TASK-096)

`BetFlightConfiguration.airframeDrag` gives the airframe without its rotors a
drag-area tensor (C_D·A) in body FRD, m², symmetric positive definite, its
center of pressure relative to the CG, and the top of its data's airspeed
range. Before integration every step adds `F = −½·ρ·|v_a|·(C_D·A)·v_a` and
`M = r_cp × F`, body FRD about the CG, to the rotors' wrench. Here v_a is the
velocity relative to the air at the step's midpoint, the same body-axis air
velocity the rotors' inflow uses (TASK-093: the weather's wind, or still air),
and ρ is the density the rotors read. `dragWrenchBody` holds the last step's
force and moment. The BET rotors produce their own momentum (H-force) drag,
so the tensor holds the airframe alone: rotor discs counted in it would count
their drag twice. A step whose airspeed |v_a| exceeds the data's range sets
`VALIDITY_FLAG_DRAG_OUTSIDE_RANGE`, bit 17 of `validityFlags`, which the
session publishes as ModelOutsideValidity; configuration flags may not use
that bit. Without `airframeDrag` the rotors alone meet the air, bit for bit
as before. The computation is a few products in the TypeScript step, so the
registered Rust kernel (`native/bet/src/airframe.rs`) was not needed.

The vehicle manifest's `airframe.drag` gains an optional `maxAirspeedMps`.
`buildProfileDynamics` consumes the block: its center of pressure moves from
the body reference point to the CG; a block without a range gets no validity
flag, and the build lists that limitation; and the drag's dataset leaves the
rotor-and-body projection with it, which itself still refuses drag data
(`withoutAirframeDrag` takes it out, as `withoutHull` the hull).

Aircraft profiles get a preliminary estimate from the standard hull (manifest
derivation 6, `standardHullDrag` of `@mirage/aircraft`) in its own synthetic
dataset `standard-hull-drag`, labeled preliminary and not measured. Each body
cylinder or arm capsule of unit axis a adds
`C_across·A_side·(I − a·aᵀ) + C_along·A_end·(a·aᵀ)`. C_across = 1.2 is the
generally accepted subcritical value of a circular cylinder of infinite span
(NACA, ntrs.nasa.gov 19930083675, which measured about 1.0 itself), so an upper
estimate; C_along = 1.17 is a flat disk or blunt end facing the flow (Hoerner,
Fluid-Dynamic Drag, 1965, as aerospaceweb.org q0231 quotes it). A cylinder's
side area is its diameter times its height and its end area πr²; an arm counts
from the body radius outward. The center of pressure is the shapes' centers
weighted by the traces of their tensors, and the airspeed range ends where the
widest shape, the body, reaches Reynolds number 2·10⁵ in ISA sea-level air
(ν = 1.4607e-5 m²/s): 26 m/s for the S19 quad X, 13.9 m/s for the 16-rotor
octocopter. The quad X gets a frontal drag area of 0.012 m², which alone needs
a lean of 2.9° at 10 m/s. Only +, −, ×, ÷ and √ enter, so the bytes do not
depend on the engine's transcendental functions. A profile may instead state
its drag areas with their source (profile schema 5); the derivation then
writes that diagonal tensor in the profile's own dataset.

In SITL (`tests/airframe-drag-sitl.test.ts`, native ArduCopter 8ab6afde)
the S19 quad X holds position in GUIDED in a steady north wind, with the 40 Hz
gyro filter it needs to fly steadily (section "Attitude oscillation of the quad
X at stock gains"). Its trimmed lean, shown and not judged (F-02), is 1.81° at
4 m/s and 4.58° at 8 m/s, against 0.44° and 1.76° for the body drag alone. The
rotors' share calibrates `EK3_DRAG_MCOEF` (0.060 1/s, since EKF3 models rotor
drag as `MCOEF·V·ρ/ρ0`), and `EK3_DRAG_BCOEF_X/Y` is m/(C_D·A) from the manifest
(130 kg/m²), since EKF3 models body drag along each axis as `½·ρ·u²/BCOEF`. Set
in flight, they let EKF3 learn the wind within 10 s: after 60 s it reads
−8.33 m/s along the true −8 m/s wind and −0.13 m/s across it, with the heading
0.11° from where it was; without them its wind stays zero.

At stock settings the quad's attitude oscillation pulls that estimate. Over a
175 s fusion the cross-wind estimate reaches −1.90 m/s and the heading turns
7.8°, with XKF2 `IDY` growing to +0.041 m/s², against −0.11 m/s, 0.17° and a
steady +0.003 m/s² with the 40 Hz filter; the along-wind estimate is −8.23 m/s
and −8.33 m/s. TASK-096 first put that error down to EKF3's drag form, which
predicts each body axis's drag from that axis's airspeed alone
(`½·ρ·u²/BCOEF` and `MCOEF·u`, as ArduPilot's built-in SITL multicopter computes
it in `SIM_Frame.cpp`), while the contract's drag acts along the relative wind.
The comparison of 2026-11-04 shows that the oscillation is the main cause. By
the user's decision of 2026-11-03 MirageSITL keeps its drag along the relative
wind rather than EKF3's per-axis form.

Verification (TASK-096): `tests/airframe-drag.test.ts` checks the force and
moment against the formula within 1e-12 on the first step of a level vehicle
at rest in four constant winds (v_a = −wind), the extra acceleration F/m
within 1e-10 and the turn rate I⁻¹·M·dt within 1e-5, the validity flag on
either side of the range, the refusals, and Galilean invariance with drag
(within 1e-9 over 400 steps). `tests/profile-dynamics.test.ts` checks the
consumed block, `tests/standard-hull-drag.test.ts` the estimate against drag
areas worked out by hand for a body with an arm along x and at 45° and its
properties on the five S19 fixtures, and `tests/aircraft-profile.test.ts`
takes derivation 6 back to the recorded derivation 5 bytes.
`node scripts/check-bet-runtime.mjs --allocation` measures drag in a gusty wind
(G1).

### Native rotor reference kernels (TASK-020–023)

These are public Rust numerical APIs, tested natively and in scalar/SIMD WASM
through the opt-in `kernel-test-exports` feature. They are not connected to the
running demo. Production `bet_step` still returns AERODYNAMICS_UNAVAILABLE:
ABI v1 has no polar table payload/binding. Enabling a complete backend requires
a versioned configuration/polar binding; do not substitute a constant polar.
The production build script does not enable the numerical test exports.

`blade::Rotor::new(geometry, polar, samples)` validates borrowed geometry once
and precomputes <=64 azimuth sine/cosine nodes. `evaluate(RotorInput)` returns
`Result<RotorWrench, RotorError>` without allocation. Station arrays have equal
length [1,64], strictly increasing internal radii, positive chord/width, finite
twist, and widths totaling radius−cutout within 1e-9 m. Blade count [1,16], spin
±1, azimuth count [1,64], and positive active span are checked. Runtime input
requires finite vectors/scalars, density [0.05,2] kg/m³, positive viscosity and
sound speed, nonnegative omega. Overflow is an error, not a zero-force result.

Each element follows section 3, including body-rate local velocity and signed
induced flow. Integration order is azimuth then radius, with weight B/N_az;
station widths already include radial integration and must not be multiplied
by blade count twice. Wrench is about the hub. `flap_load_nm` is the generalized
hinge torque in basis (1,cos psi,sin psi): sum of r*dF_z times those basis values.
There is no extra factor two in this output; harmonic modal inertia supplies
that normalization. Polar clamp flags are ORed into output. For constant CL/CD,
no inflow and no body rates, the independent continuous annulus references are:

\[
T={B\rho c C_L\Omega^2\over6}(R^3-r_0^3),\qquad
Q_{air}=-{sB\rho c C_D\Omega^2\over8}(R^4-r_0^4).
\]

`inflow::AxialInflow` implements a limited signed normal-working actuator disk.
Let sigma=sign(T), V=−sigma*v_air,z, L=|T|/(2*rho*A). Its target magnitude is
the positive root w of w*(w+V)=L; the hover limit is sqrt(L). Rationalize the
root for V>=0 to avoid cancellation. Target signed velocity is sigma*w,
bounded by the configured positive limit. Relaxation is exact for held inputs:
vi_next=vi_target+(vi−vi_target)*exp(−dt/tau). This uses no iterative solve
(zero <= four iterations), not a disguised unconstrained Newton loop. Report
absolute target residual |2*rho*A*vi*|vi−v_air,z|−T|. Hover tests require <=1%
of thrust and verify transient convergence at 400/800/1200 Hz.

Descent opposing thrust (V<0), transverse speed >1 m/s, and target clipping set
outside_validity. VRS/windmill-brake/autorotation inflow is not validated. T=0
has target zero, including zero RPM/flow. This is a one-way thrust-to-inflow
closure; if used with blade torque, sample updated thrust at tick boundaries
and account for coupling error. No measured rotor data is implied.

`shaft::Shaft` advances J*dOmega/dt=tau_motor+s*Q_air−b*Omega. It holds
motor/air torque per tick and integrates viscous bearing damping exactly with
expm1, using its continuous b=0 limit. No RPM governor exists. Speed magnitude
cannot become negative: attempted reversal stops at zero with reverse_limited;
reverse rotation requires a separate model. Reports kinetic energy J*Omega²/2
and held-torque residual. Reevaluate aerodynamic torque at each new speed.
Tests cover passive exponential energy decay, airflow-driven acceleration,
braking, equilibrium residual <0.01 Nm, airflow removal, and dt convergence.
Synthetic constant-coefficient polars cover mechanics, not airfoil fidelity.

`flapping::HingeModel` is a zero-offset, rigid-blade, linear small-angle hinge
reference, derived by Galerkin projection of I*D²beta+C*D beta+(K+I*Omega²)beta=Q,
with D=partial_t+s*Omega*partial_psi. Parameters I0/K0/C0 are sums across blades;
cos/sin modal parameters are exactly half those values by orthogonality.
With w=s*Omega and wd=s*dOmega/dt, modal accelerations are:

\[
\ddot\beta_0=Q_0/I_0-(C_0/I_0)\dot\beta_0-(K_0/I_0+w^2)\beta_0,
\]
\[
\ddot\beta_c=2Q_c/I_0-(C_0/I_0)\dot\beta_c-(K_0/I_0)\beta_c
 -2w\dot\beta_s-((C_0/I_0)w+\dot w)\beta_s,
\]
\[
\ddot\beta_s=2Q_s/I_0-(C_0/I_0)\dot\beta_s-(K_0/I_0)\beta_s
 +2w\dot\beta_c+((C_0/I_0)w+\dot w)\beta_c.
\]

RK4 holds generalized loads and spin acceleration per tick, evaluating spin
at stage times. Validity requires sum |beta_mode|<=configured limit<=0.2 rad;
exceedance is reported, not hidden by angle clamping. Steps require dt<=0.01 s
and dt*(max spin over step+sqrt(K0/I0)+C0/I0)<=1. The supplied blade loads use
the flat-disk reference: aeroelastic feedback, offset hinges, teetering stops,
elastic blades, stall and autogyro measurements remain outside this envelope.

`momentum::angular_momentum` uses a reduced blade-distribution ledger with
J=sum integral r²dm, Hx=−s*J*Omega*beta_c+(J/2)*beta_s_dot,
Hy=−s*J*Omega*beta_s−(J/2)*beta_c_dot, Hz=s*J*Omega*cos²(beta0).
Transverse terms retain first order in cyclic flap; this is not a complete
flexible-blade inertia tensor. `transmitted_moment` computes the full discrete
inertial derivative for this supplied H:

\[
M_{hub}=M_{air}-{H_{next}-H_{previous}\over dt}
 -\omega_{body,h}\times{H_{next}+H_{previous}\over2}.
\]

This includes spin-up, cone/cyclic changes and flap-rate momentum; motor
reaction must not be added again. Shaft and flap DOFs must be excluded from
any duplicate body inertia. Generalized aerodynamic loads and transmitted
moments stay separate. Frame aggregation and rigid-body integration are later
TASK-027/028. All these APIs reject non-finite parameters and keep fixed storage.

Independent JSON oracles under tests/fixtures/rotors are SHA-256 registered,
explicitly synthetic, and record derivations and units. Native allocator probes
count calls/bytes (with a positive allocating control) over 1e6 combined kernel
steps. WASM tests build scalar/SIMD artifacts with the trapping allocator,
exercise tail counts 1/3/5/63, compare analytic outputs (absolute 1e-9 N/Nm,
oscillator 1e-8 rad), and run million-step dynamics without memory growth.
These checks do not establish experimental aerodynamics or M4/RTX throughput.

## 4. WASM ABI and SIMD

### Additive bound-rotor ABI v1 (TASK-033 runtime continuation)

This separate interface leaves the legacy rotor arena ABI v1 unchanged.
`bet_bound_version`, `bet_bound_init(config,len,arena,arenaLen)`,
`bet_bound_step(arena,input,out,dt)`, `bet_bound_reset(arena)` and
`bet_bound_dispose(arena)` use disjoint caller-owned 8-byte-aligned regions.
Configuration header: 128 bytes; u32 version/totalBytes/nAlpha/nRe/nMach/
nStations/bladeCount/spinSign/azimuthSamples at 0/4/8/12/16/20/24/28/32;
36..39 reserved zero in version 1 and the kernel options word in versions 2 and 3
(TASK-091, TASK-097, below); f64 radius/root/inertia/bearing/dt/initialOmega/
inflowTau/inflowLimit/minConfidence at 40/48/56/64/72/80/88/96/104;
112..127 reserved zero, except for version 3's option 8 (below). Then four station f64 arrays (radius/chord/twist/width),
alpha-radian/Re/Mach axes, and flattened CL/CD/confidence arrays in
(Mach,Re,alpha) order. Counts are bounded by 361/32/8/64 and 16384 table cells.
The native initializer validates and copies this payload into an arena with
a 64-byte header; total arena bytes = 64 + configuration bytes.

Input: 128 bytes; u32 version at 0, 4..7 reserved zero; f64 density/viscosity/
sound speed at 8/16/24, hub relative air velocity[3] at 32, body rate[3] at 56,
collective/cos-cyclic/sin-cyclic at 80/88/96, motor torque magnitude at 104,
112..127 reserved zero. Output reuses the 128-byte rotor output field layout
below through this distinct versioned interface. Arena header: magic/bytes/
memoryPages/reserved u32 at 0/4/8/12; f64 omega/induced at 16/24;
32..63 reserved zero. Configuration is immutable after initialization.

Each step predicts half-step free-shaft and axial-inflow state, evaluates
midpoint loads, and advances full-step shaft/inflow using those loads. Outputs
contain the midpoint aerodynamic wrench and updated shaft/inflow state. Transmitted moment subtracts finite-difference shaft dH/dt
and body-rate cross H. Flapping is disabled (cone=0). Flags: 2 outside polar,
4 low-confidence contributing corner, 8 outside axial-inflow validity,
16 reverse shaft limit. Finite flagged predictions remain distinguishable
from numerical errors. Negative statuses match legacy status meanings; errors
do not change output or state. Reset restores configured initial speed and
zero inflow. Disposal invalidates the arena. Growth after init is rejected.
No new SAB byte layout or autopilot admission follows from this interface.

Kernel cost (TASK-091, in progress). Initialization and reset validate the
whole configuration; each step rechecks only the header, the counts, the
dt, the scalar ranges and the slice bounds, and reads the polar without
rescanning its values, since the configuration is immutable; it takes its
azimuth grid from a cache of the thread's last grid, with the same bits. The
default kernel (increments 3 and 4) is `Rotor::evaluate_sampled`, which agrees with the
reference kernel (`Rotor::evaluate`, `PolarTable::lookup`) within the
declared tolerance T1: every force, moment and flapping component within
1e-12 of its vector's norm (absolute floor 1e-15) and identical flags, with
shaft speed and inflow within 1e-9 relative over closed loops. Each
element's relative velocity is resolved on the tangential direction and the
axis only, where the cross products of the element force reduce to scalar
products. Per azimuth sample a branch-free strip pass, which the compiler
vectorizes (f64x2 in the SIMD128 build), forms the speed, the angle of
attack with the exact conditional wrap, and the Reynolds and Mach numbers.
Its `atan2` and `ln` are kernel functions with exact Taylor coefficients,
within 2e-15 of the platform functions: atan after reduction by multiples
of pi/8 to |t| <= tan(pi/16), with terms up to t^19, and ln through
2 atanh((m - 1)/(m + 1)) with m in [sqrt(1/2), sqrt(2)), with terms up to
s^17, both polynomials evaluated by Estrin's scheme. The polar lookups
(`KernelPolar`) follow. For a table of at most two Mach nodes they run in
passes across strips (`sample_strips`): a branch-free pass forms the clamps,
the validity flag, the alpha guess and the Mach weight; a scalar pass corrects
the brackets against the axes and reads their nodes; a branch-free pass forms
the alpha and Reynolds weights; and a last pass reads the corners. More Mach
nodes take `sample`, one query at a time, which returns the same bits. Both
keep the reference clamping, flags and brackets; the Reynolds bracket starts from the
strip's bracket at the previous azimuth sample, and the Reynolds-axis
logarithms use the same `ln`. The Reynolds and two-node Mach weights
multiply by interval reciprocals, and a query clamped onto the last node
keeps the weight 1. The confidence corners are skipped once the evaluation
has flagged a low-confidence corner, and their weights matter only when one
of the eight corners is low. The trilinear sums take Re and Mach
first on both alpha nodes, then alpha. A branch-free pass forms each element's
force and moment, and four sums along the blade per
azimuth sample, in strip order, are rotated into the force, moment and flapping loads.
The kernel works on one fixed scratch per thread, without allocation: its lanes,
written before they are read, and the Reynolds logarithms, reused while the axis
keeps the same bits, so the scratch cannot change a result. Three
cases fall back to the increment 2 kernel: a table with fewer than two
alpha nodes, more than 32 Reynolds nodes or a Reynolds node that is not a
positive normal number; a non-finite intermediate; and a shifted angle
outside [-2 pi, 4 pi) before the wrap.

Kernel option 4 (configuration version 2) runs the exact kernel
`Rotor::evaluate_fast` instead, whose results are bit-identical to the
reference: its polar lookups (`PreparedPolar`) compute the Reynolds-axis
logarithms, the guess scales and the corner strides once per evaluation,
guess each bracket in O(1) and correct it against its neighbours to the
binary search's index, and read a cell's CL, CD and confidence corners
through one window; the angle of attack wraps by exact conditional
subtraction (Sterbenz) with `rem_euclid` as fallback; and the element speed
is taken once. The reference stays in the crate with `bound::step_reference`
and `bound_v2::step_reference` for tests and benchmarks; no production WASM
export calls them. The feature-gated test export `bet_test_kernel_t1`
compares the default kernel with the reference inside the scalar and
SIMD128 test builds.

Full-range polars (TASK-097). A schema 2 table covers alpha from -180 to 180
degrees at every degree, the source's Reynolds axis and Mach nodes 0, 0.3, 0.5
and 0.7. Inside the source's alpha range at Mach 0 it holds the source's values.
Beyond the edge, Viterna and Corrigan's `C_D = C_Dmax sin^2 a + B2 cos a` and
`C_L = C_Dmax sin a cos a + A2 cos^2 a / sin a` take over, with B2 and A2 from the
values at the edge and C_Dmax = 1.29 (blade aspect ratio 10), joined to the source's
value and slope by a cubic Hermite over 15 degrees. For |a| > 90 degrees
`C_L(a) = -0.7 C_L(+-180 - a)` and `C_D(a) = C_D(+-180 - a)`, joined over 80 to 100
degrees. At higher Mach numbers attached lift follows Prandtl-Glauert and all drag
adds `20 (M - M_cr)^4` above `M_cr = 0.87 - t/c - |C_L|/10 - (0.1/80)^(1/3)`. Every
cell outside the source's alpha range has confidence 0, so that using it raises
`FLAG_LOW_CONFIDENCE`; above Mach 0.7 the lookup clamps and flags. These are
empirical models on a surrogate table, not measured data. A source table keeps its
catalog ID and bytes, so a profile that stored one keeps its numbers; a card's
airfoil name selects the extended table.

Dynamic inflow (TASK-098). Configuration version 4 adds option 16, which a
profile flight asks for. The induced velocity is
`v(r, psi) = v0 s_k + (r/R) (v_c cos psi + v_s sin psi)` with three Pitt-Peters
states, in the dimensional form `M R dv/dt + V L^-1 v = (T/(rho A), M_c/(rho A R),
M_s/(rho A R))`, `M = diag(128/(75 pi), 16/(45 pi), 16/(45 pi))`. With climb V_c along
the thrust, transverse speed V_x and `W = sqrt(V_x^2 + (V_c + v)^2)`: the mean's target
solves Glauert's `v W = T/(2 rho A)`; `tan(chi/2) = V_x/(W + |V_c + v|)`; in wind axes
`L11 = 1/2`, `L13 = L31 = (15 pi/64) tan(chi/2)`, lateral `L = 2 (1 + tan^2(chi/2))`,
longitudinal `L = 2 (1 - tan^2(chi/2))`, and the quasi-steady states are `L V^-1 F` with
`V = diag(W, H, H)`, `H = (V_x^2 + |(V_c + v)(V_c + 2 v)|)/W`. Each state relaxes exactly
towards its target over a step, with the mean's `tau = M0 R/(2 (W + v |V_c + v|/W))`,
which is `M0 R/(4 v)` in hover, and the harmonics' `M2 R 2/H`, capped at 1 s; an inflow
tau above 0 replaces both, and 0 asks for these. Once per step, at zero or positive climb,
each annulus solves `F v W = dT/(4 pi r dr rho)` with the Prandtl tip and hub factor F of
the helix angle `sin(phi) = W/sqrt(W^2 + (Omega r)^2)`, by at most four iterations; the
area-weighted mean over Glauert's root is the loss, each annulus over the mean its shape
`s_k`, and both follow with the mean's lag. In descent the mean's target is the baseline
of Johnson's model (NASA TP-2005-213477, tables 3 and 4), and the field, which is zero
climb's, fades to uniform by a descent of 0.2 hover inflows, Johnson's boundary D, so a
hover that crosses zero climb meets no step in its thrust (TASK-101 found one of 7.6 %).
Descent, an advance ratio above 0.3 and an iteration cap set the inflow's validity flag.
The configuration ends with a state region of (3 + strips) f64, zero at initialization and
reset: the two harmonics, the loss minus 1 and each strip's shape minus 1. Interface v2
reports the harmonics in `inflow_cos` and `inflow_sin` with validity bit 2.

Descent and the vortex ring state (TASK-099). In descent the mean's target is Johnson's
model (NASA TP-2005-213477, tables 3 and 4), in velocities scaled with the hover inflow
`v_h = sqrt(|T|/(2 rho A))`: momentum theory on its two branches, joined between
`V_z = -2.1` and `-1.5` by a cubic, plus, with option 32 of configuration version 5, the
increment `Delta(V_z + v)` through D (-0.2), N (-0.45, total inflow 0.85), X (-1.5, total
inflow 1.25) and E (-2.0), scaled by `(1 - (V_x/0.95)^6)^0.5`, with N and X moving with V_x.
Between N and X the total inflow rises with the descent rate, so thrust falls as descent
rises: the negative damping in heave and, through each hub's own V_z, in roll. Inside the
boundary a seeded fluctuation multiplies the force and moment by `1 + n`: n is a filtered
Gaussian with `omega R/v_h = 1` and an RMS from 2.5 % at the boundary to 15 % at the centre,
with a hysteresis of 10 % of the half width, and output flag 256 marks it. The 15 % is an
engineering choice inside the report's range. The stream is a 64-bit xorshift from a u64 seed
that follows the tables; three more state words follow the state region. With the option a
descent is outside validity only below -2 v_h at V_x < 0.95 v_h, or with the fluctuation active.

Ground effect (TASK-100). `input_flags` bit 0 with a unit `ground_normal_hub` and
`ground_distance`, the hub's height d above a plane along its normal, turns it on, and
output `validity` bit 4 says so. With z = d / cos(theta) the height along the hub axis,
`kappa = 1 - (R/(4 z))^2 cos(theta) / (1 + (V_t/v_i)^2)`. The kernels take the mean induced
velocity times kappa, and the inflow state follows the thrust, the moments and the strip
loads times kappa, so it stays at the velocity of the same power out of ground effect: at
one induced power thrust is `1/kappa` times its value out of ground effect, the closed form
of Cheeseman and Bennett (1955). Below z/R = 0.5 kappa holds its value at 0.5 and output
flag 8 is set; a disk whose axis does not point at the plane gets none. A set flag with a
normal that is not unit is status -3, and a clear flag with a nonzero field stays
`UNSUPPORTED`. `BetFlightDynamics` takes d from a `GroundPlaneSource`, a flat plane at the
session's ground unless its configuration gives another (`CollisionChunks.planeInto` and
`TerrainContactCoupler.hubPlaneInto` serve the published terrain, for TASK-187), and adds
the neighbours (Sanchez-Cuevas et al. 2017): per other rotor at lateral distance D,
`(R_j^2/2) z / (D^2 + 4 z^2)^(3/2)`, passing the height that gives the sum. A rotor nearer
than half a radius, a coaxial partner among them, is not a neighbour: TASK-101 owns that
pair. Their body term was left out at first for lack of data; it is added below. Control Protocol
v3's `rotor.ground-effect` switches it, and only the ESC drive's interface has its fields.

Body lift, the fountain (TASK-100, the stakeholder's decision of 2026-11-08; design recorded before
the implementation). Near the ground the rotors' wakes spread along it, meet under the airframe and
turn up, a fountain that lifts the body. Sanchez-Cuevas et al. 2017 (IJAE, doi 10.1155/2017/1823056,
equation (4)) add `2 R^2 z K_b / (b^2 + 4 z^2)^(3/2)` to the quadrotor's denominator, b the distance
between opposite rotor axes and K_b an empirical coefficient, about 2 on their 12 cm-radius, 1.4 kg
PQUAD on a thrust stand. That equation is a ratio of the whole vehicle's thrust measured on a stand,
rotors and body together, and the term carries no rotor inflow: here it is a force on the airframe,
not a change of any rotor's inflow, so the rotors keep the closed form above. Per rotor i with ground
under it, `B_i = K_b · 2 R_i^2 z_i / (b_i^2 + 4 z_i^2)^(3/2)`, with z_i the rotor's height along its
axis held at 0.5 R_i below that, as the closed form is, and `b_i = 2 ρ_i`, ρ_i the lateral distance of
its hub from the centroid of all hubs in body axes, which is the paper's diagonal on a symmetric quad
and its extrapolation on other frames. The force is `F = intensity · Σ_i max(T_i, 0) · B_i · n_i`,
T_i the rotor's thrust of the step (before TASK-101's download) and n_i the unit ground normal under
it in body axes, applied at the body's origin, so it adds no moment. Against the paper's
`1/(1 − S − B)` this is the first-order share of B on top of a rotor already raised by S: the
difference, about S·B, is under 0.1 % of thrust at 3 radii on the Bee35. `K_b` is the configuration's
`groundBodyLiftCoefficient`, default 2 (the paper's), 0 for none. Intensity 0 and off stay bitwise a
run without the effect. Checks, limits set now: `bodyLiftFractionsInto` against the expression within
1e-12; through a real `BetFlightDynamics` held at heights as the tests above hold it, the step's
`bodyLiftBodyN` equal to `Σ max(T_i, 0) B_i n_i` from the same step's rotor outputs within 1e-12
relative; the vehicle's thrust measured from its acceleration, with the term against the same run with
`groundBodyLiftCoefficient` 0, larger by that lift within 1e-4 relative of the lift (the lift itself
makes the held vehicle climb a few µm/s faster, which moves each rotor's thrust by a few parts in 10^7,
up to about 2e-5 of the lift; corrected before the first run from a declared 1e-6 that this ignored);
the roll, pitch and yaw rates as without the term within 1e-9 rad/s, since it adds no moment; above 20
radii no more than 1e-5 of thrust; and off, intensity 0 and `groundBodyLiftCoefficient` 0 each bitwise
as before the term; G1 with the term active. The logged comparison below is then run again, its method and tolerance unchanged.

Result (2026-11-08; `tests/rotor-ground-effect.test.ts` 9 passed). Three declared checks were corrected
after their first runs, each a fault of the check, not of the term: (1) the far field falls as
`K_b R^2 / (4 z^2)`, 1.25e-3 of thrust at 20 radii with K_b 2, so "no more than 1e-5 above 20 radii"
could not hold; it is checked against that asymptote within 5 % at 20 and 80 radii; (2) the step takes
the ground normal at its midpoint attitude and the published state is its start, and the fixture's CG
offset pitches the held quad at about 1.6e-4 rad/s, so the lift's size is checked within 1e-12 and its
direction within 1e-6 rad of the published normal, and the queried heights against the published pose
within 1e-6 m; (3) the thrust averaged from the last 0.5 s carried the larger lift of the lower heights
the quad rose through, so the last step's published acceleration is used, less the rotors' own
difference (the lifted quad sits about 22 µm higher and its rotors give 0.24 mN less): it equals the lift
within 3.5e-6 of it, inside the declared 1e-4. Rates equal within 1e-9 rad/s, and off, intensity 0 and
K_b 0 are bitwise.

Logged ground effect (TASK-100, 2026-11-08), declared before the model's prediction was computed
and after a first look at the log's ratios. The log is the stakeholder's SpeedyBee 3.5 flight
(`stakeholder-speedybee35-19-10-2026-tune-120hz-frt-02.BIN` of `data/flight-logs/inventory.json`):
SpeedyBee Bee35 frame, 153 mm wheelbase by its sellers' listings, so 76.5 mm arms on a square X
(assumed), 3.5-inch propellers, a downward rangefinder and every motor's speed.
`measureGroundEffect` (`packages/analysis/src/ground-effect-log.ts`) measures thrust per squared
rotor speed against height, which needs neither the mass nor the battery: in 0.1 s bins, k = the
negated mean of the first IMU's `AccZ` (the rotors' specific force) over the mean of the four
motors' squared `ESC.RPM`; a bin counts with all four motors, at least 8 `ESC` rows, a mean speed of
at least 8000 rpm (airborne) and a good rangefinder reading (`RFND.Stat` 4). The rotors' height is
z = d·cos(roll)·cos(pitch) + o, d the mean reading and o the rotors' height above the rangefinder,
which no drawing gives: o is taken as 0.01, 0.03 and 0.05 m, each reported. k is normalized by its
mean over the bins with d at least 0.6 m and reported per bin of d: [0.10, 0.15), [0.15, 0.20),
[0.20, 0.30), [0.30, 0.45), [0.45, 0.60) m, with the standard error of each mean; below 0.10 m the
ground's push enters the specific force, and those bins are not used.

The model's prediction is its own flight dynamics (`BetFlightDynamics`, ESC drive, ground effect on
at intensity 1, the neighbours included), held at a fixed duty with gravity off and a huge mass as
`tests/rotor-ground-effect.test.ts` holds it: thrust from the acceleration over the mean squared
rotor speed, at each bin's mean rotor height against 2 m. The aircraft is a quad X with the 76.5 mm
arms, 3.5-inch propellers with the derived BET geometry on the NACA6409 polar, pitch assumed 2.5
inch and two or three blades (both reported), and a motor card of KV 1950 (SpeedyBee 2006 1950KV;
its other values the example card's, which do not enter a thrust-to-speed ratio). Declared
tolerance, set after the first look: a bin is reproduced when the measured ratio lies within the
model's range over o and blade count, widened by two standard errors of the bin and by 2
percentage points, the size of the unexplained −2 % the first look showed from 4.5 to 10 radii,
where the model's effect is under 0.5 %. `tests/ground-effect-logged.test.ts` runs it with
`MIRAGE_FORUM_LOG_DIR` set to the directory of the inventory's logs (it skips without it), checks
the file's SHA-256 and, with `MIRAGE_GE_OUT` set, writes the report: each bin's measured ratio,
standard error and model range, `reproduced` per bin and the status `REPRODUCED` or
`NOT_REPRODUCED`. It runs as a test rather than a script because the aircraft modules import their
JSON schemas, which only the test runner loads.

Result (2026-11-08; `tests/ground-effect-logged.test.ts` 3 passed, report
`test-results/validation/logged-ground-effect.json`, status `NOT_REPRODUCED`; 136 reference bins):

| Reading, m | Rotor height, R | Measured | Model (o, blades) | Reproduced |
| --- | --- | --- | --- | --- |
| 0.10–0.15 | 3.0–3.9 | 1.0545 ± 0.0078 (38) | 1.0075–1.0128 | no |
| 0.15–0.20 | 4.2–5.1 | 1.0004 ± 0.0084 (17) | 1.0048–1.0072 | yes |
| 0.20–0.30 | 6.0–6.9 | 0.9814 ± 0.0024 (31) | 1.0028–1.0040 | yes |
| 0.30–0.45 | 8.4–9.3 | 0.9780 ± 0.0021 (39) | 1.0016–1.0021 | yes |
| 0.45–0.60 | 11.9–12.8 | 0.9961 ± 0.0020 (67) | 1.0008–1.0010 | yes |

At about 3 radii the aircraft gains 5.5 % of thrust at equal rotor speed where the model, its own
rotor and the Sanchez-Cuevas neighbours included, gives 0.8 to 1.3 %: four to seven times less,
over every offset and blade count tried. What the model leaves out and this aircraft has: the
body term of Sanchez-Cuevas et al., left out above for lack of data; the Bee35's propeller guards
(rings around the propellers, not ducts: corrected by the stakeholder on 2026-11-08, after this
paragraph first called the Bee35 ducted), which the model does not represent; and the room, whose
floor and walls the flight was close to. Two higher bins pass only by the 2 points the tolerance
allows for the unexplained dip of about −2 % between 6 and 9 radii.

Investigation (2026-11-08; the stakeholder did not accept the miss). Correction to the method: a
bin dropped only its rangefinder readings that were not good (`RFND.Stat` other than 4), and the
sensor flags readings below its 0.10 m minimum (`RNGFND1_MIN`) that way, so a bin that dipped toward
the ground kept the mean of its remaining, higher readings. A bin now counts only when every reading
in it is good. The lowest bin becomes 1.0428 ± 0.0063 (33 bins) and the others change by less than
0.0004; the report reads `REPRODUCED`, but only through the tolerance's 2 points: the gap to the
model's 1.0074 to 1.0125 is still about 3 points, and this comparison is not counted as closed.
Ruled out as causes, each from the log: the climb rate (`CTUN.CRt`; ratio against it over the
reference bins −0.029 per m/s, and the bins with |CRt| < 0.1 m/s give 1.066 in the lowest bin);
horizontal speed (optical flow times height; +0.0185 per m/s over the reference bins, and the
bins slower than 0.15 m/s keep the −2 % dip at 0.980); lean (no slope); a motor's speed dropping
out (all four report every 10 ms without a gap). The flight was in Stabilize, height held by hand,
and the gain in the lowest bin comes in bursts of about 0.3 s, up to 1.14, at the bottoms of small
dips (113.9 to 114.2, 115.2 to 115.5, 116.1 to 116.5, 117.2 s) with 1.01 to 1.03 between them at
the same reading. The term the model omits is the most likely cause: Sanchez-Cuevas et al.'s
equation (4) (IJAE 2017, doi 10.1155/2017/1823056, read 2026-11-08) adds to the neighbours' sum
`2 R^2 z K_b / (b^2 + 4 z^2)^(3/2)`, the lift of the fountain where the rotors' ground jets meet
under the body, b the distance between opposite rotor axes and K_b about 2 on their 12 cm-radius,
1.4 kg PQUAD on a thrust stand. With the Bee35's 153 mm diagonal, R 0.0445 m and K_b 2 the full
equation gives 1.041 to 1.062 in the lowest bin over the offsets 0.05 to 0.01 m, against the
measured 1.043; K_b 1.1 to 2.3 matches it exactly over the same offsets. The same term gives +2.6
to +3.7 % at 4 to 5 radii and +1.6 to +2.0 % at 6 to 7, where the log has 1.000 and 0.982: with it,
the −2 % dip between 6 and 9 radii, which neither speed nor climb rate explains, becomes a gap of
3 to 4 points. The log cannot settle K_b without the propellers' height above the rangefinder.

With the body lift (2026-11-08). The stakeholder gave the propellers' height above the rangefinder as
under 2 cm and decided that day to add the fountain ("Body lift, the fountain" above). With the
simulation's own ratios at 1 and 3 cm offsets, the lowest bin asks for K_b 1.7 to 2.0, the paper's value
on another quadrotor. Run again with the term at its default K_b 2, method and tolerance unchanged
(`tests/ground-effect-logged.test.ts` 3 passed, report `test-results/validation/logged-ground-effect.json`,
status `NOT_REPRODUCED`):

| Reading, m | Measured | Model (o 0.01 to 0.05 m, 2 or 3 blades) | Reproduced |
| --- | --- | --- | --- |
| 0.10–0.15 | 1.0428 ± 0.0063 (33) | 1.0287–1.0429 | yes |
| 0.15–0.20 | 1.0007 ± 0.0084 (17) | 1.0191–1.0267 | yes |
| 0.20–0.30 | 0.9817 ± 0.0024 (31) | 1.0115–1.0150 | no |
| 0.30–0.45 | 0.9782 ± 0.0021 (39) | 1.0064–1.0080 | no |
| 0.45–0.60 | 0.9964 ± 0.0020 (67) | 1.0034–1.0041 | yes |

At the stakeholder's offset, 1 cm, the model gives 1.0429 in the lowest bin against the measured 1.0428:
the gap of 3 points without the term is gone. The two bins between 6 and 9 radii now miss by about 3
points: the log's dip of −2 % there, which no speed, climb rate or lean explains, sits below a model that
the term raises by 1.2 to 1.5 %. Whether that dip is the room, the guards or the log's own reference is
not settled by this flight.

The Pavo20 Pro II profile (TASK-099, 2026-11-08). The stakeholder's BetaFPV Pavo20 Pro II
(`stakeholder-pavo20pro2` of `data/flight-logs/inventory.json`) is built from four component cards,
`tests/fixtures/components/pavo-motor-1303-8000kv.json`, `pavo-gemfan-2219-3.json`, `pavo-esc-aio.json`
and `pavo-battery-3s-850.json`, and the profile `tests/fixtures/aircraft/pavo-quad.json`, as the U35 is
(`tests/support/pavo.ts`; the propellers fly the NACA6409 catalog polar, the card naming no airfoil).
Stated: 169 g all-up, the RCinPower 1303 V3 8000KV motors, 2.2-inch Gemfan GP2219-3 propellers and a
3S 850 mAh battery (the stakeholder); a 93.9 mm wheelbase (BetaFPV's frame page); three blades and a
1.9-inch pitch read from the name GP2219-3 by Gemfan's naming, the pitch not confirmed; the outputs
SERVO1 to SERVO4 on motors 2, 3, 4 and 1, QUAD/X_REV (FRAME_CLASS 1, FRAME_TYPE 18), DShot600 once per
400 Hz loop, the cell voltages 4.35 and 3.3 V (MOT_BAT_VOLT_MAX 13.05 V and MOT_BAT_VOLT_MIN 9.9 V over
three cells) and a pack resistance of 0.0771 ohm (ArduPilot's own BAT.Res estimate, its median over
log 34), all from the logs. The logs set BATT_CAPACITY 720 mAh; the card keeps the stakeholder's
850 mAh. The propeller guards are open rings, not ducts, as the stakeholder said; BetaFPV's page calls
them ducts with an 8 to 11 % thrust gain. The model represents neither. Assumed, each with its basis:

| Value | Assumed | Basis |
| --- | --- | --- |
| Arm length and azimuths | 46.95 mm at ±45° and ±135° | half the 93.9 mm wheelbase on a square X; no drawing gives the arms |
| Rotor height, tilt | 0, 0 | flat frame; not measured |
| CG offset | 0 | not measured |
| Inertia about the CG | diag(9.5e-5, 1.2e-4, 1.9e-4) kg m² | a sum of parts: four 5.5 g motors with propellers at the hubs, 30 g of frame and guards as four 30 mm rings around the hubs, and the other 117 g as a 60 by 30 by 40 mm box at the CG |
| Ground clearance | 25 mm | a whoop resting on its guards; not measured |
| Motor resistance, no-load current and voltage, current and power limits, mass | 0.25 ohm, 0.5 A at 10 V, 12 A, 130 W, 4.5 g | typical of a 1303-size 8000 KV whoop motor; the logs' ESC voltage and current telemetry (15.75 V and 148 A at hover) is not usable for a fit |
| Propeller mass | 1.0 g | typical of a 2-inch three-blade whoop propeller |
| Propeller hub, chord, twist, airfoil | none on the card | the TASK-139 derivation's assumptions: a root at 0.15 R, a chord of 0.1812 R, the blade angle from the nominal pitch, the NACA6409 polar |
| ESC current limit | 12 A | typical of a whoop all-in-one ESC; its model is not stated |

`tests/pavo-profile.test.ts` holds, declared before its run: every card value is known with a named
source or not known, and the assumed ones are exactly those of the table; the cards resolve with nothing
missing; the derived rotors stand 46.95 mm from the axis and opposite ones 93.9 mm apart; the outputs are
the logs' SERVO1..4_FUNCTION 34, 35, 36 and 33; the propellers clear; the manifest's bytes repeat; and,
held level with equal commands, the model carries its weight within 0.1 % at zero climb with no vortex
ring fluctuation. The TASK-128 frame catalog holds stock QUAD X (FRAME_TYPE 1) and not X_REV, whose spins
differ, so the profile flies on the scripting matrix (FRAME_CLASS 15) with X_REV's spins, as the U35 does.
Result (2026-11-08, 4 passed): the model hovers at 26,235 rpm on a command of 0.316, where the logs hover
at a median of 22,400 to 23,100 rpm per flight: it needs 17 % more rotor speed, or its thrust per squared
speed is 0.73 times the aircraft's. That is reported, not judged; the assumed blade geometry, the guards
and the 14 poles the logs assume for the speed reading (SERVO_BLH_POLES) are what it rests on. The
six-axis trim of `tests/support/hover-trim.ts` does not apply to this rotor: its sweep needs a settled
speed at every command up to the full 13.05 V, and above about 5.4 V this 28 mm rotor holds a period-two
alternation of about 3e-6 of its speed at 800 Hz, whatever the ESC's update period; a held hover at
zero climb replaces it.

Why the model hovers faster (2026-11-08). The stakeholder asked for the cause, since no datasheet of
the GP2219-3 exists. Measured over the 18 armed flights with the two scripts in `scripts/pavo/` (run
with `node --experimental-transform-types --no-warnings SCRIPT LOG...`):

* The speed reading. The logs convert the ESC's electrical speed with SERVO_BLH_POLES 14; a motor with
  12 magnets would make every logged rpm 12/14 of the truth, a ratio of 1.167 close to the 1.17
  observed. Retailers list the GTS V3 1303 8000KV as 12N14P, 14 magnets, which the parameter matches.
  `scripts/pavo/rpm-voltage-balance.mjs` compares each logged rpm with KV (V_m − I_p R), V_m the
  commanded duty times the battery voltage and I_p the phase current from the battery power per motor
  through a lossless ESC (KV 8000 and R 0.145 Ω from the listing; the avionics current 0.4 or 0.8 A
  assumed): over 209,424 samples the logged rpm is a median 1.21 to 1.24 times that bound (p10 1.12,
  p90 1.35). That does not pin the speed to 20 %: the ESC's real duty or the motor's real KV differ
  from the nominal ones. It does rule out the pole error, which would put the logged rpm below the
  bound, at most about 0.9 times it. The logged speeds stand.
* The propeller in flight. `scripts/pavo/propeller-from-flight.mjs` takes every BAT sample (about
  10 Hz) with all three EKF velocity components below 1.5 m/s and the baro height above 1.5 m: the
  thrust is 0.169 kg times the body specific force −AccZ of IMU 0, the speeds are the four ESC rpms,
  the density p/(R·298 K) from the baro pressure, and the shaft power per motor E (I − I₀) with
  E = rpm/KV and I from the battery power per motor P = (E + I R) I (no-load current 0.3 A assumed).
  Over 15,316 samples, at a median 22,513 rpm and 1.177 kg/m³: CT = T/(ρn²D⁴) 0.255 (0.248 to 0.255
  across 20,000 to 26,000 rpm), and CP = 2πQ/(ρn²D⁵) 0.24 to 0.26 for an avionics current of 0.8 to
  0.4 A. The CT rests on the mass and the logged rpm; the CP also on the motor constants.
* The model's rotor, bound as the flight binds it, at 22,500 rpm in that air: CT 0.182 and CP 0.145,
  both well below the aircraft's. With the chord, constant along the blade, scaled by k: k 1.25 gives
  CT 0.222 and CP 0.181, k 1.5 gives CT 0.262 and CP 0.217, k 1.75 gives CT 0.301 and CP 0.254. The
  measured CT lies at k ≈ 1.46, a chord of 0.265 R (7.4 mm), where the model's CP is about 0.21, 12 to
  19 % below the measured range.

So one geometric change accounts for both coefficients at once: the assumed chord, 0.1812 R from the
median of the UIUC two-blade propellers, is too narrow for this three-blade whoop propeller. The open
rings cannot be the main cause: a duct-like ring raises thrust at equal power, not power with it. Not
established: the propeller's real chord and twist, which a ruler across one blade would give (the
model predicts about 7.4 mm at a constant chord). The card keeps its assumed chord until the
stakeholder decides; the Pavo's TASK-099 descent and TASK-090 SystemId results were computed with it.

Logged descent (TASK-099, 2026-11-08), declared before the model's prediction was computed and
after a first look at the logs. The logs are the Pavo's 18 armed flights of
`data/flight-logs/inventory.json` (`stakeholder-pavo-log_N_UnknownDate.bin`, N 12 to 63; log 0 never
armed), each checked by its SHA-256. They hold no GNSS, rangefinder or airspeed: the climb rate is the
EKF's (`CTUN.CRt`, cm/s stored, m/s by its FMTU), from barometer and accelerometer, and the horizontal
speed is not known. `measureDescent` (`packages/analysis/src/descent-log.ts`) measures thrust per squared
rotor speed against the climb rate scaled with the hover inflow, as TASK-100 measures it against height.
In 0.1 s bins: k = the negated mean of the first IMU's `AccZ` over the mean, over the four motors, of each
motor's mean squared `ESC.RPM`. An `ESC.RPM` row is rejected when it is not finite or exceeds KV times
MOT_BAT_VOLT_MAX (8000 × 13.05 = 104,400 rpm, the motor's speed without load at the highest voltage the
autopilot assumes), which removes the NaN rows and the isolated 540,800 rpm readings of bidirectional
DShot; a bin needs at least 5 accepted rows of each motor. A bin is airborne when its CTUN rows all have
`ThO` above 0.05 (MOT_SPIN_ARM) and `Alt` at least 0.5 m (18 rotor radii above the take-off height, so no
ground effect), its mean rotor speed is at least 8000 rpm, its specific force at least 4.9 m/s² and every
ATT row's tilt from level at most 30° (ANGLE_MAX). A bin counts when every bin with CTUN rows within 1 s
of it is airborne: this removes take-offs, landings, the estimator's climb-rate extremes at zero throttle
(log 22 from 479 s, log 23 at 5 s) and log 22's tumble at 476 s. The climb rate V_z is the bin's mean
CRt; the hover inflow `v_h = sqrt(m a/(8 rho A))` with m 0.169 kg, a the bin's specific force, A the disk of
radius 0.02794 m and rho the flight's mean `BARO.Press` over 287.053 J/(kg K) times 288.15 K (the
barometer's temperature is the board's); x = V_z/v_h. Each flight is its own reference: k over the
mean k of its counted bins with |x| ≤ 0.03, and a flight counts with at least 20 of them. The ratios are
reported in classes of x: [−0.7, −0.45), [−0.45, −0.3), [−0.3, −0.2), [−0.2, −0.1), [−0.1, −0.03), descending,
and (0.03, 0.1], (0.1, 0.2], (0.2, 0.3], (0.3, 0.7], climbing, where momentum theory is established and which is
the method's control; each with its count, mean ratio, standard error of the mean, mean x and mean tilt,
and again over the bins with a tilt of at most 5°, where the unknown horizontal speed matters least.

The first look (a pymavlink script over the same bins, before this declaration) gave v_h about 8.4 m/s at
hover, the deepest counted descent −4.6 m/s in log 34 near 94.5 s at x −0.57, about ten bins below Johnson's
N (−0.45 at V_x = 0) and none near the region's centre (−0.975) or X (−1.5); ratios of about 0.976 from
x −0.45 to −0.2, 0.986 from −0.2 to −0.05, 0.98 and 0.97 on both sides close to hover (|x| 0.03 to 0.1), and
0.944 and 0.91 in climbs of 0.1 to 0.3. Momentum theory and Johnson's curve have the ratio above 1 in such
descents, so the first look already disagrees in sign there; the climbs fall as momentum theory has them.

The model's prediction is its own flight dynamics with the Pavo profile (`buildProfileDynamics` as a
profile flight builds it: ESC drive, dynamic inflow with the vortex ring option 32 and its seeded
fluctuation, rotor wakes, the standard hull's drag; ground effect off), at 800 Hz, held level 20 m up by a
huge mass with gravity off, as `tests/rotor-ground-effect.test.ts` holds it, on the command that carries
169 g at zero climb (`hoverCommand`, `tests/support/pavo.ts`), moving at a fixed climb rate V_c and
transverse speed V_x through still air: after 0.5 s the vertical force and the rotors' mean squared speed
are averaged over 2 s (about 600 correlation times of the fluctuation), k is their ratio and x the climb
rate over the hover inflow of that force at the model's air. For each class the model runs at
V_c = x̄ v_h,0 (x̄ the class's measured mean, v_h,0 the model's at zero climb) and V_x 0 and 2 m/s (about
0.24 v_h: the descent bins lean 7 to 11° on average, at a speed the logs do not give), each normalized by
the model at zero climb and the same V_x, and it reports its own x and how many steps carried the
fluctuation. Declared tolerance, set after the first look as TASK-100's was: a class is reproduced when its
measured mean lies within the model's range over V_x, widened by two standard errors of the class and by 2
percentage points, the size of the fall on both sides of hover that neither the climb nor the descent
effect makes. `tests/descent-logged.test.ts` runs it with `MIRAGE_FORUM_LOG_DIR` (it skips without it) and,
with `MIRAGE_DESCENT_OUT` set, writes the report: per flight its file, SHA-256, density and counts; per class
the measured values, the model's runs, `reproduced`; v_h at hover, the deepest descent and the bins past N;
and the status `REPRODUCED` or `NOT_REPRODUCED`. That status is the declared comparison's, not a fidelity
verdict (SA-01): the effect stays labeled as not validated (D-11) until the stakeholder judges it. If the
logs do not reach the vortex ring region, the report says so with these numbers.

Result (2026-11-08; `tests/descent-logged.test.ts` 3 passed in 20 s, report
`test-results/validation/logged-descent.json`, status `NOT_REPRODUCED`). All 18 flights count: 42,527
bins, 32,861 of them reference bins, densities 1.214 to 1.220 kg/m³. The hover inflow is 8.31 m/s at
hover (the median over the reference bins; the model's is 8.30 m/s), so the 4.4 m/s descent of log 34 at
94.4 s, the deepest counted, is only −0.57 v_h: the logs reach just past Johnson's N, with 10 bins below
−0.45 v_h, all in that one 0.6 s pass at low throttle, and nowhere near the region's centre (−0.975 v_h, about
8.1 m/s down) or X (−1.5 v_h, about 12.5 m/s). The vortex ring state is therefore touched only at its edge;
the comparison tests mainly the descent between D and N, where Johnson's curve lowers the inflow, and the
climbs. Model columns: V_x 0 and 2 m/s; the level column is the bins of at most 5° tilt.

| x = V_z/v_h | Bins | Measured | Mean x | Tilt, ° | Level (bins) | Model | Reproduced |
| --- | --- | --- | --- | --- | --- | --- | --- |
| −0.7 to −0.45 | 10 | 0.9855 ± 0.0163 | −0.530 | 11.2 | — (0) | 1.1244–1.1401 | no |
| −0.45 to −0.3 | 42 | 0.9802 ± 0.0046 | −0.332 | 7.4 | 0.9847 (18) | 1.1130–1.1252 | no |
| −0.3 to −0.2 | 163 | 0.9808 ± 0.0033 | −0.238 | 7.4 | 0.9818 (65) | 1.0982–1.1071 | no |
| −0.2 to −0.1 | 891 | 0.9921 ± 0.0012 | −0.135 | 8.4 | 0.9862 (288) | 1.0528–1.0570 | no |
| −0.1 to −0.03 | 5414 | 0.9865 ± 0.0005 | −0.055 | 7.3 | 0.9862 (2370) | 1.0180–1.0208 | no |
| 0.03 to 0.1 | 2541 | 0.9749 ± 0.0006 | 0.055 | 4.9 | 0.9802 (1332) | 0.9885–0.9888 | yes |
| 0.1 to 0.2 | 496 | 0.9468 ± 0.0015 | 0.134 | 5.9 | 0.9605 (226) | 0.9716–0.9726 | no |
| 0.2 to 0.3 | 70 | 0.9151 ± 0.0029 | 0.234 | 7.3 | 0.9451 (18) | 0.9490–0.9506 | no |
| 0.3 to 0.7 | 38 | 0.7899 ± 0.0074 | 0.541 | 9.9 | — (0) | 0.8736–0.8758 | no |

In descent the model gains 2 to 14 % of thrust at equal rotor speed, as momentum theory and Johnson's
curve between D and N have it, and the aircraft loses 1 to 2 %: the sign differs in every descending class.
In climb both lose thrust, the aircraft about twice as fast (0.947 against 0.972 at 0.13 v_h, 0.79 against
0.875 at 0.54 v_h). The deepest class carries the model's fluctuation on every step (the region's edge at
x −0.50) and has a measured spread of 0.05 per bin. Checked after the run with the first look's script,
not causes: the bins whose rotor speed and climb rate are steady to 1 % and 0.1 m/s between their neighbours keep the
descent ratios at 0.980 to 1.002, so throttle transients and the ESC speed's lag do not make the fall, and
the level bins keep it, so lean does not either; the airframe's vertical drag would raise a descending
bin's ratio, not lower it. What the model leaves out and this aircraft has: the open propeller rings,
whose lip thrust a duct gains in hover from the inflow and loses as the descent slows the flow through it
(BetaFPV's page claims 8 to 11 % for them), and a blade geometry the model assumes: at hover it needs 17 %
more speed than the aircraft, so the real rotor is more heavily loaded at a given speed and its thrust is
more sensitive to inflow, which is the direction of the steeper climbs. Neither is established by these
logs. The effect stays labeled as not validated (D-11); whether the model needs a guard term, or this
comparison is enough for Phase 1, is the stakeholder's to judge.

Rotor wakes (TASK-101). `packages/physics/src/rotor-wake.ts` computes them between rotor
steps, one way and with no swirl, a synthetic model with nothing measured behind it. From
each rotor's last thrust T and its air, with V >= 0 down through the disk and V_t across
it: the induced velocity v from `v sqrt(V_t^2 + (V + v)^2) = T/(2 rho A)`; a straight
top-hat tube along `(V_t, V + 2 v)`, of radius `R_w = R sqrt(U_near/U_far)` where U_near
and U_far are the speeds with v and 2 v, growing as `R_s = R_w + S s` with the distance s
along it, S = 0.1 sqrt(2/ln 2) = 0.17 (a round jet's half-width grows about 0.1 per metre,
Pope 2000, and a top hat with a Gaussian jet's mass and momentum flux has sqrt(2/ln 2)
times that radius); and an excess speed e along the source's thrust axis from
`e sqrt(V_t^2 + (V + e)^2) = (T - F)/(rho pi R_s^2)`, so the tube's momentum flux is what
the rotor gave, less the download, at every distance. A receiver takes e times the
fraction of its disk inside the tube, in its own hub axes, into `external_wake_hub`,
which the step adds to its air once. Seen along the tube a disk is an ellipse, integrated
by 16 chords: to rounding when one shape holds the other, within 0.5 % of its area
otherwise. Several sources add. The lag is one step, from the source's last output, and
pairs run sorted, so the order they are given in changes nothing. Thrust while descending
beyond 0.2 v through the disk sets the inflow's validity flag, and a wake that no longer
leaves below its rotor gives nothing. The download `F = 1/2 rho ((V + 2 v)^2 - V^2) C_D A`
comes off the hub's force, the free stream's own part being the airframe drag's. C_D A
comes from the manifest's hull at configuration, inside the contracted hover radius
`R/sqrt(2)`, for shapes not above the disk: an arm's width times its length inside, with
C_D 1.2, and a body's plan area inside, with C_D 1.17, the numbers of TASK-096. In hover
`F/T = C_D A / A_disk`. Not modeled, and listed as limitations: swirl, a lower rotor's
effect on its upper rotor, and transport delay.

`buildProfileDynamics` takes the option `rotorWake`: `all` by default, every ordered pair,
because a wake's reach depends on the flight; `declared`, the manifest's `rotorWakePairs`;
`off`, none. TASK-177's thrust at full command runs the same coupling.

Measured rotor wakes: NASA MTB2 (TASK-101, 2026-11-08), declared before the model's prediction
was computed and after a first look at the measured thrusts. The data are NASA Ames's second
wind-tunnel entry of the Multirotor Test Bed (Conley et al., NASA/TM-20250004795, May 2025, a
US Government work in the public domain), downloaded with the stakeholder's approval and kept
outside the repository: the data report PDF and five workbooks, each checked by its SHA-256
(`MTB2_METHOD.sources` in `packages/analysis/src/mtb2-interference.ts`). Each of four rotors
stands on its own six-axis load cell, so the tables give every rotor's thrust (`Fz_H`, along
its shaft, lb, after drift, aerodynamic and weight tares) at each point, with the tunnel speed,
dynamic pressure, density, model pitch, rotor tilt and RPM.

What the data offer this model. The rotors are public: 24.5 in diameter (R 12.245 in), two blades
of constant 1.54 in chord, the E387 airfoil, linear twist −16°, collective 6.7° at 0.75 R. Rotors 1
and 2 are in front, 3 and 4 behind, 33 in (2.7 R) apart along the stream and 32.7 in across; the
rear rotors stand 4 in above the front ones (concept configuration, dz/R 0.33), level with them
(equal height, 0) or 7 in above (tall, 0.57). Runs set q 0.48 or 1.90 psf (20 or 40 ft/s), model
pitch 0, −1, −3, −5 and −10° (nose down), rotor tilt 0 or −3°, and 2000, 2500 and 3000 RPM.
What this model represents is the one-way wake of a front rotor reaching a rear one, so the
comparison is the tandem pair (rotors 1 and 3 alone, both starboard, 0° relative phase: runs 113,
143 and the phase-0 points of 151, one per configuration) against the same rotors alone (rotor 3:
runs 103, 141, 147; rotor 1: run 102, whose position the three configurations share). Not used:
the side-by-side pairs, which this model's wakes, going downstream, never reach; the quadrotor
runs (rotor 3 of the equal-height quadrotor, runs 152 and 153, reads 0.87 to 0.94 lb at its
wind-off 2000 RPM points against 1.63 lb alone, an offset as large as the effect sought); the
hover RPM sweeps (no isolated sweep to divide by); the three- and six-blade runs; and the run with
a rotor tilted −78.7°. MTB2 has no coaxial pair, so it cannot test that part of the model.

What the tables hold that the model cannot use or that is questionable, each found in them: the
RPM columns do not follow the rotors in the two-rotor runs (in run 113 `RPM_2` reads 2000 on a
stack without blades while `RPM_3` reads 0 under the rotor giving 4.7 lb and 5.9 in-lb of torque),
so a point's speed is the largest of its four RPM columns, rounded to the nearest 500; the stacks
without blades read −0.2 to −1.1 lb; rotor 1, which this model's front rotor matches by
construction (nothing flows upstream), reads 0.2 to 0.3 lb more in every tandem run than alone
at the wind-off 2000 RPM points, with its torque about 4 % higher, and 0.2 to 0.6 lb more in
forward flight (4 to 19 %), nearly constant in pounds across RPM; the rear rotor reads 0.15 to
0.29 lb more at the same wind-off points. The report notes that the load cells' calibration
depends on the combination of loads. The rotor-positions workbook has a sign and value slip in
six rows of the equal-height configuration (rotors 1 and 2 at pitch −10° tilt 0 and at pitch −5°
and −10° tilt −3°; corrected from four rows when the test first read the workbook).

Measured quantities, per condition (q level: 0 below 0.1 psf, 0.48 below 1.0, else 1.90; pitch
and tilt rounded to the nearest degree; speed as above; the phase the most negative of the four
phase columns; repeated points of one run averaged; wind-off points only at pitch 0, tilt 0 and
2000 RPM, the housekeeping points): the rear rotor's ratio `r = T3_tandem / T3_alone`; the same
with the front rotor's change taken as an offset common to both rotors of the run,
`r_c = (T3_tandem − (T1_tandem − T1_alone)) / T3_alone`; and the front rotor's own
`r_front = T1_tandem / T1_alone`. Which of r and r_c is right depends on the cause of the front
rotor's offset, which the data do not settle, so the measured interval is between them. The
data's own scatter s is the RMS of each isolated rear-rotor run over the mean of the isolated runs
103, 141 and 147 at the conditions two or more of them share. The phase −90° tandem points (runs
116, 144 and 151) are shown beside the phase-0 ratio, measured only: the model has no blade phase.

The model's prediction is its own flight dynamics (`BetFlightDynamics`, ESC drive, wakes `all`,
dynamic inflow) on a two-rotor manifest of the tandem: hub positions from the rotor-positions
workbook at pitch 0 and the run's tilt (the rotor tilts about its own pivot, as the workbook
shows), body x upstream; the model pitch is the body's attitude and the tunnel speed its forward
speed through still air at the run's density, with viscosity by Sutherland's law and the speed of
sound at the tunnel's total temperature; gravity off and the body made 1e8 times heavier, as the
ground-effect test holds it. The blades: the report's geometry, `theta(r) = 6.7° − 16° (r/R − 0.75)
+ delta`, 16 equal strips from the repository's assumed root cutout of 0.15 R (the report gives
none), and the catalog's `naca6409-extended-v1` polar standing in for the E387 the catalog does not
hold (both about 9 % thick; 6 % against 3.2 % camber). One collective offset delta, common to
both rotors, makes the model's summed thrust equal the measured sum over the isolated rotors'
forward-flight points (runs 102 and 103, model at each run's conditions with the wakes off); no
tandem point enters it, and each fitted point's model over measured is shown. A PI governor on
each rotor's duty holds the condition's RPM; a run lasts 3 s at 800 Hz, thrust is the mean over
its last 0.5 s, and a run whose speed is not within 0.1 % of the target is an error. Motor, ESC
and battery are the example cards with KV 300 and 60 A ratings: they only have to reach the speed,
and at a held speed the rotor's thrust does not depend on them. The model's ratios are
`r_model = T3(wakes all) / T3(wakes off)` and the same for rotor 1, at the tandem run's mean
conditions. Not in the model and stated as such: the tunnel's walls and floor (the rotors are about
4.7 R above the floor; ground effect is off), the test bed's structure and motor housings under the
rotors (no hull, so no download), blade phase, any effect of the rear rotor on the front one,
swirl and blade flexibility.

Reporting (SA-01: no fidelity limit and no pass or fail). Each condition lists the measured r, r_c,
r_front, the phase −90° r where it exists, the model's r_model and r_front_model, and whether
r_model lies inside the measured interval widened by 2 s (`within` or `outside`), a description of
where the model falls, not a verdict. Per configuration and speed, the count inside and the means.
`tests/rotor-wake-mtb2.test.ts` runs it with `MIRAGE_MTB2_DIR` set to the downloaded directory (it
skips without it), checks every file's SHA-256, and with `MIRAGE_MTB2_OUT` set writes the report
(`test-results/validation/mtb2-rotor-wake.json`) with the status `SHOWN`; without the data its
synthetic-table tests of the measurement still run.

Correction to the method (2026-11-08, after the first comparison; the model is unchanged). The
runs were made at densities from 0.00220 to 0.00244 slug/ft³ (run 102 at 0.00224, run 113 at
0.00236, run 103's tunnel values recorded by hand), and at a held RPM a rotor's thrust follows
the density, so a ratio of thrusts from two runs carries their density ratio: part of the front
rotor's offset above is that. The corrected basis is the report's own thrust coefficient
`C_T = Fz/(rho pi R^2 (Omega R)^2)` (its table 5.2.2), per point with Omega from the largest RPM
column, in r, r_c, r_front and s alike (`thrustCoefficients`, basis `coefficient`). The model's
ratios do not change: on and off run at one density. The report keeps both: `declared` (thrust)
and `corrected` (coefficient). The corrected front rotor still reads 1.004 to 1.13 of its
isolated value in the concept and tall tandems and 1.04 to 1.28 in the equal-height one (runs 143
and 102 have one density), and s grows from 1.7 % to 2.7 %, largely from run 103's hand-recorded
density. The model's front rotor matches its isolated self to 1e-5 (the test's check), not
bitwise: the two rotors share one battery bus, which moves the governor's duty.

Result (2026-11-08; `tests/rotor-wake-mtb2.test.ts` 4 passed, report
`test-results/validation/mtb2-rotor-wake.json`, status `SHOWN`; 151 conditions, 100 of them with
the model inside the corrected interval and 96 inside the declared one). The collective offset is
−4.50°; with it the model's isolated thrust is 0.69 to 1.34 of the measured, RMS 12 %: rotor 3
alone reads 5 to 20 % less than rotor 1 alone at the same nominal condition while the model's two
rotors are identical, and the model's thrust changes with speed and pitch differently from the
measured. Every condition's steps set the low-confidence polar flag (4): some blade elements, the
retreating blade's root among them, run outside the NeuralFoil source's range. Means over pitch
and tilt, corrected basis (r_c in brackets; each condition and the model's range are in the
report):

| Configuration | 20 ft/s, 2000 / 2500 / 3000 RPM: measured r (r_c) | model | 40 ft/s, 2000 / 2500 / 3000 RPM: measured r (r_c) | model |
| --- | --- | --- | --- | --- |
| concept, dz/R 0.33 | 1.079 (0.962) / 1.023 (0.955) / 1.014 (0.968) | 0.994 / 1.000 / 1.000 | 1.023 (0.963) / 0.959 (0.933) / 0.934 (0.916) | 0.755 / 0.839 / 0.928 |
| equal height, 0 | 0.877 (0.619) / 0.893 (0.733) / 0.912 (0.805) | 0.907 / 0.993 / 1.000 | 0.828 (0.648) / 0.772 (0.662) / 0.765 (0.682) | 0.750 / 0.710 / 0.788 |
| tall, 0.57 | 1.066 (0.971) / 1.038 (0.973) / 1.026 (0.980) | 1.000 / 1.000 / 1.000 | 1.002 (0.954) / 0.959 (0.929) / 0.945 (0.926) | 0.852 / 0.951 / 0.997 |

Inside the corrected interval, per configuration at 20 and 40 ft/s: concept 30 of 30 and 9 of
29, equal height 9 of 30 and 27 of 29, tall 15 of 15 and 8 of 15; the wind-off points (model
1.000 by construction, measured r 1.13 to 1.21, r_c 0.99 to 1.09) 2 of 3. What it shows, for the
stakeholder to judge (SA-01). The large loss of the equal-height rear rotor at 40 ft/s, 17 to
35 % in the data (the means of r to those of r_c), is 21 to 29 % in the model, with the same
order over the configurations: equal height loses most, the concept and tall rear rotors far
less. Two features are not reproduced. At 40 ft/s the model's loss falls steeply with RPM in the
concept and tall configurations, from 25 and 15 % at 2000 RPM to 7 and 0 % at 3000, where the
measured loss is small at every RPM (0 to 8 %) and largest at 3000: at 2000 and 2500 RPM the
model's wake reaches a raised rear rotor that the real one hardly reaches. At 20 ft/s the
equal-height rear rotor loses 9 to 12 % by r and 20 to 38 % by r_c, where the model's wake has
passed below its disk at 2500 and 3000 RPM. In the model a lighter rotor's wake leaves flatter,
descending at 2 v from the disk on, so its RPM trend follows from the straight tube; the data
suggest a wake that descends less near the rotor and reaches less far above its axis, which this
comparison cannot separate. The phase −90° points differ from phase 0 by −0.045 to +0.098 in r,
on average +0.005 to +0.022 per configuration, an effect the model does not have.

Configuration version 3 (TASK-097) adds option 8, rotational lift augmentation,
which an extended table asks for: bytes 112 and 120 hold the f64 lift slope (1/rad)
and zero-lift angle (rad), and stay reserved zero otherwise, as in versions 1 and 2,
which reject the option. Each element uses
`C_L + 3 (c/r)^2 w (slope (a - a0) - C_L)` (Snel et al. 1994), where w fades from 1
to 0 by a smoothstep between 30 and 50 degrees from a0, an engineering limit. It
changes the physics, so the reference and exact kernels apply it too.

Configuration version 2 (TASK-091) carries the kernel options word at byte
36: two opt-in modes that change the numerics (options 1 and 2) and the
exact kernel (option 4). Version 1 keeps byte 36 reserved zero and runs the
default kernel, and `encodeBoundRotor` writes version 2 only when
`kernelOptions` is nonzero. Any other option bit, and option 4 together with
option 1 or 2, is rejected. The modes evaluate with the default kernel.
Option 1 (reduced predictor): the
half-step prediction evaluates azimuth samples 0 and N/2 (N even), whose
first harmonics cancel, and uses only their axial force and torque.
Option 2 (hover sampling): the midpoint evaluation uses every other azimuth
sample (N even, at least 4) while the regime measure
m = max(|transverse air velocity| / (Omega R), |in-plane body rate| / Omega,
|cyclic pitch|) at the start of the step stays low: it engages below 0.05
and disengages above 0.10, and a stopped shaft samples in full. Its state
(f64 0 or 1) occupies arena header bytes 56..63 only with option 2; the
bytes stay zero otherwise, and reset clears them. Output flag 64 marks a
midpoint with hover sampling and flag 128 a reduced prediction;
`BetFlightDynamics` reports them in `samplingFlags` and never as
ModelOutsideValidity. The modes are judged by the TASK-033 suites (T2):
`node scripts/check-bet-runtime.mjs --kernel-options 3` repeats the 18
comparisons with both modes against the unchanged 4800 Hz references and
adds six forward-flight trajectories against the full kernel at the same
rate (limits 0.1 m and 0.5 degrees, report
`test-results/validation/bet-runtime-modes.json`). `BetFlightConfiguration`
and `buildProfileDynamics` take `kernelOptions`; the default is 0.

The configured dt accepts 400/800/1200 Hz plus 4800 Hz for offline reference
integration. The session clock remains limited to 400/800/1200 Hz.
`BetFlightDynamics` predicts midpoint body velocity, rate and orientation for
rotor-relative flow, then integrates the assembled body wrench. Its explicit
configuration supplies manifest, polar map, atmosphere, motor torque limits,
mixer and initial body/shaft state; it assumes rigid nonflapping rotors and
free flight. No contact, battery or autopilot simulation is implied.

`node scripts/check-bet-runtime.mjs` records 18 ten-second comparisons for
4/6/8 rotors across scalar/SIMD and 400/800/1200 Hz against 4800 Hz; tolerances
remain 0.1 m and 0.5 degrees. `--allocation` counts one million native bound
steps with a positive control, probes one million active-rotor steps in each
WASM variant, and one million steps each of the stationary four-rotor body with
zero gravity and of the four-rotor body on the synthetic pad. It also probes the
step interfaces v2 of TASK-088: one million active-rotor steps through
`BetRotorEngineV2` and one million stationary body steps through
`BetRigidBodyBackendV2`, each in both WASM variants, and one million steps of
the four-rotor body on the TASK-092 ESC drive and shared bus on the synthetic
pad. `scripts/bet-runtime-graphs.ts` lists the nine graphs; a report must hold
exactly one sample of each, and `scripts/validate-models.mjs` admits only that
set. The JS probes require zero GC, less than 0.01 incremental bytes/step, stable
WASM memory and an allocating positive control. These are software checks,
not measured aerodynamic validation or target-device real-time guarantees.
Reports `bet-runtime.json` and `bet-runtime-allocation.json` under
`test-results/validation/` include source and artifact hashes. Model-report v8
requires both diagnostics and `runtimeStatus`, rejecting schema v7 and older.
Stale/missing/invalid runtime evidence blocks runtime acceptance; failed checks
fail it. Historical measured comparisons retain their independent status.

Rust crate: `native/bet`; wrapper: `packages/wasm-bet`. JSBSim is a separate
Emscripten artifact. Scalar execution is mandatory. SIMD128 is an optional,
feature-detected artifact introduced after the scalar reference. Use
float64 for physics/integration; float32 requires an explicit error budget
and separate convergence tests.

WASM exports: `bet_abi_version()->u32`,
`bet_required_bytes(config_ptr:u32,len:u32)->u32`,
`bet_init(config_ptr:u32,len:u32,arena_ptr:u32,arena_bytes:u32)->u32 handle`,
`bet_step(handle:u32,input_ptr:u32,out_ptr:u32,dt_s:f64)->i32 status`,
`bet_reset(handle:u32,seed:u32)->i32`, and `bet_dispose(handle:u32)`.
A zero handle means failure. Validate pointer ranges during initialization;
validate input counts/finite values before step. Strides/alignment are
explicit. Use `repr(C)`; never expose Rust Vec/String/bool/enum layouts.
Allocate memory/arenas before running. The BET baseline budget is <=64 MiB;
growth after arming is a fault.

A rotor output record is 128 bytes: offsets 0/24/48 contain f64[3] force,
air moment, and transmitted moment; 72 omega f64; 80 aerodynamic shaft
torque f64; 88 shaft power f64; 96 induced axial velocity f64; 104 cone
angle f64; 112 flags u32; 116 reserved u32; 120 signed angular momentum
along the hub axis f64. TASK-018 creates input/config C headers and Rust
offset tests. Never cast an arbitrary TS object to these records. The
Rust/WASM arena is separate from Main SAB.

TASK-018 implements these layouts in `native/bet/src/abi.rs`, mirrors them
in `native/bet/include/bet.h` (the layout source parsed by the Rust and TS
tests), and in `packages/wasm-bet/src/arena.ts`:

```text
ABI v1 records (little-endian; offsets in bytes; all regions 8-byte aligned)
config header (64):  0 abi_version u32 | 4 config_bytes u32 = 64 + n*2160
                     8 rotor_count u32 (1..32) | 12 rotor_stride u32 = 2160
                     16 dt_s f64 (exactly 1/400, 1/800, 1/1200) | 24..63 reserved = 0
rotor config (2160): 0 id u32 | 4 blade_count u32 (1..16) | 8 spin_sign i32 (+1/-1)
                     12 station_count u32 (1..64) | 16 azimuth_samples u32 (1..64)
                     20 polar_id u32 | 24 radius_m f64 | 32 root_cutout_m f64
                     40 hub_position_body_m f64[3] | 64 hub_to_body f64[4] (w,x,y,z)
                     96 shaft_inertia_kg_m2 f64 | 104 bearing_viscous_nm_per_rad_s f64
                     112 radial_station_m f64[64] | 624 chord_m f64[64]
                     1136 twist_rad f64[64] | 1648 quadrature_width_m f64[64]
                     unused station slots = +0.0
input header (64):   0 rotor_count u32 | 4 rotor_stride u32 = 96 | 8 density_kg_m3 f64
                     16 dynamic_viscosity_pa_s f64 | 24 speed_of_sound_mps f64
                     32..63 reserved = 0
rotor input (96):    0 air_velocity_at_hub_hub_mps f64[3]
                     24 body_angular_velocity_hub_rad_s f64[3] | 48 collective_pitch_rad f64
                     56 cyclic_cos_rad f64 | 64 cyclic_sin_rad f64
                     72 motor_torque_magnitude_nm f64 (>= 0) | 80 flags u32 = 0
                     84..95 reserved = 0
rotor output (128):  as above; flags bit0 AERODYNAMICS_UNAVAILABLE, bit1 OUTSIDE_POLAR_VALIDITY
arena:               64-byte header + configuration copy + n * 64-byte rotor state
                     required_bytes = 64 + config_bytes + n*64
status i32:          0 OK | 1 AERODYNAMICS_UNAVAILABLE | -1 BAD_HANDLE | -2 BAD_POINTER
                     -3 BAD_INPUT | -4 BAD_DT | -5 MEMORY_GROWN | -6 ARENA_TOO_SMALL
                     -7 ABI_MISMATCH
```

Pointers are non-null, 8-byte aligned, inside current linear memory, and at
or above the exported `__heap_base` (never Rust static data or stack);
regions passed to one call must not overlap. The handle is the arena
pointer. `bet_last_error()->i32` reports why `bet_required_bytes` or
`bet_init` returned 0. Unknown counts, strides, nonzero reserved bytes,
non-finite values, and out-of-range geometry are rejected. `bet_step`
validates the whole input first and writes no output byte on a negative
status; on status >= 0 it overwrites every rotor record. It returns
`MEMORY_GROWN` when linear memory differs from its size at initialization.
Until a versioned polar-to-kernel binding exists, the production ABI returns `AERODYNAMICS_UNAVAILABLE`
with NaN force, moments, and aerodynamic torque and the
`AERODYNAMICS_UNAVAILABLE` flag, never a fabricated success. The JS binding
writes inputs and decodes outputs through one preallocated DataView into
caller-owned objects without per-step allocation.

SIMD defaults exclude relaxed-simd and fast-math. Preserve a fixed reduction
order in the scalar reference. Test alignment and tail counts 1/3/5/63.
Limit `unsafe` to validated memory views and explained SIMD intrinsics.
Scalar/SIMD golden tolerance: absolute force<=1e-6 N and moment<=1e-6 Nm;
relative<=1e-6 when |reference|>=1. Long-trajectory tolerances are separate.
Numerical parity is not evidence of physical fidelity.

## 5. Sensor/EW pipeline

`truth -> ideal sample -> calibrated noise/bias -> EW -> quantization -> MAVLink`.
EW does not mutate truth, renderer attitude, terrain, or clocks. Mechanical
faults are the exception: they act on physics actuators rather than GPS.

```ts
export interface GpsSample {
  timeLoUs: number; timeHiUs: number;
  latitudeRad: number; longitudeRad: number; altitudeMslM: number;
  vnMps: number; veMps: number; vdMps: number;
  hdop: number; vdop: number; hdopValid: boolean; vdopValid: boolean;
  fixType: number; satellites: number; satellitesValid: boolean; velocityValid: boolean;
  courseRad: number; courseValid: boolean;
}
export interface ImuSample {
  timeLoUs: number; timeHiUs: number;
  specificForceBodyMps2: Float64Array;
  gyroBodyRadS: Float64Array; magBodyGauss: Float64Array;
  pressurePa: number; differentialPressurePa: number;
  pressureAltitudeM: number; temperatureK: number; updatedMask: number;
}
export interface EwContext {
  dtS: number; simTimeS: number;
  truthNorthM: number; truthEastM: number; truthDownM: number;
}
export interface EwEngine {
  reset(seed: number): void;
  advanceInto(context: EwContext): void; // Every physics step; no allocations.
  distortGpsInto(source: GpsSample, target: GpsSample): void;
  distortImuInto(source: ImuSample, target: ImuSample): void;
}
```

Source and target are distinct preallocated buffers. The RNG has a fixed
algorithm/seed and separate stream IDs per sensor. Render FPS cannot change
the result. IMU runs at 200/400 Hz; GNSS at 5/10 Hz. Use rational tick
scheduling without accumulating drift at 1200 Hz. Noise specifications
include bandwidth/PSD; do not inject equal white-noise variance at different
dt values without a defined model and units.

### Spatial exposure

For a sphere with center c/radius R and a cone with axis u/aperture theta:

\[
r=\|p-c\|,\quad
J=\mathbf{1}_{r\le R}\;G(\hat{p-c}\cdot u)
       {P_{rel}\,r_{ref}^2\over\max(r^2,r_{min}^2)},\quad
q=\operatorname{clamp}\left({J-J_{on}\over J_{full}-J_{on}},0,1\right).
\]

Sphere: G=1. Cone: G=0 outside cos(theta), with a specified smoothstep taper
inside. At r=0 use axis-neutral G=1 without division by zero. Validate
r_min>0 and J_full>J_on>=0. Combine volumes by summing J with saturation,
not an accidental iteration order. This is **dimensionless training
exposure**, not an RF link budget in dBm. A real receiver mapping requires
measurements. A specified smooth shell/hysteresis may soften volume boundaries.

### GNSS jamming

Filter severity using `q_f += (q-q_f)*(1-exp(-dt/tau))`:

\[
N_{sat}=\min(N_0,\operatorname{round}((1-q_f)N_0+q_fN_{jam})),\quad N_{jam}\in[0,3],
\]
\[
HDOP=\max(HDOP_0,(1-q_f)HDOP_0+q_f HDOP_{jam}),
\quad VDOP\text{ analogous},\quad DOP_{jam}\in[50,99].
\]

If q_f>=0.8 or N_sat<4, set fixType=0. Restore fix only after q_f<0.6
and N_sat>=4. An already degraded no-fix baseline must not become a 3D fix.
These thresholds define a versioned training preset, not a measured receiver.
Packet loss/stale measurements require an explicit scenario; do not use
NaN or integer overflow. IMU and barometer remain unchanged. Already worse
baselines such as HDOP>99 or N0<3 must not improve under jamming. Unknown
DOP/satellite validity remains unknown; placeholders are not measurements.

### Position steps and coherent velocity drift

A step adds constant `b_ned` to GPS position while preserving baseline GPS
velocity. This discontinuity is intentionally not kinematically consistent.
It may produce a large innovation, but no particular EKF message/mode is guaranteed.

Integrate drift every physics step rather than only when GNSS samples:

\[
v_d^{k+1}=v_d^k+a_d^k\Delta t,\quad
b^{k+1}=b^k+v_d^k\Delta t+\tfrac12a_d^k\Delta t^2,
\]
\[
p_{GPS}'=p_{GPS}+b,\quad v_{GPS}'=v_{GPS}+v_d.
\]

Typical scenario acceleration magnitude is 0.1..0.3 m/s², with maxSpeed
bounded by the preset. At the speed cap, integrate piecewise to the cap
time and then at constant velocity; do not update position and clip
velocity afterward. Recompute course/speed from corrupted horizontal
velocity. Coherent position/velocity errors do not guarantee bypassing
EK3_VEL_GATE: behavior depends on covariance, other sensors, and firmware.

On disable, `hold-offset` decelerates drift velocity within limits while
integrating b, then holds the offset. `step-to-truth` explicitly resets b/v
with a discontinuity and AAR event. Never fade b without adjusting its
velocity derivative. Reset clears all fault states and seed streams;
`sim.configure` also clears all fault states and keeps the seed of the last
reset.

Small-offset diagnostic approximations are
`delta_lat=bN/(M+h)`, `delta_lon=bE/((N_curv+h)*cos(lat))`, and
`delta_alt_msl=-bD`. Production offsets up to 10 km use WGS84 ECEF/local
tangent conversion and a geoid model. Test poles and antimeridian.
Ellipsoidal h and MSL H differ: `H=h-geoidUndulation`.

### Magnetic anomalies

In body sensor coordinates:

\[
B_b'=R_z(\delta\psi)R_y(\delta\theta)R_x(\delta\phi)B_b+b_{mag,b}.
\]

`rotationRad=[roll,pitch,yaw]`; bias is in gauss. Corrupt only the mag
measurement, not truth quaternion. Convert an Earth-fixed NED bias to body
first. Toilet bowling is not guaranteed: inspect innovations, yaw estimates,
and trajectory in a pinned SITL scenario.

## 6. Required MAVLink encoding conversions

Authoritative format:
[common.xml](https://github.com/mavlink/mavlink/blob/master/message_definitions/v1.0/common.xml).
Names/units were checked on 2026-10-15. TASK-037 pins an upstream commit,
dialect XML hash, and generator. The master link is a reference, not a lockfile.

| Message.field | Wire type | Conversion from the model |
| --- | --- | --- |
| HIL_GPS.time_usec | u64 | Sensor sample time in one consistent epoch/domain |
| lat / lon | i32 | round(rad*180/pi*1e7), WGS84 |
| alt | i32 | round(MSL metres*1000), positive upward |
| eph / epv | u16 | **HDOP/VDOP×100, dimensionless**, not metres; unknown=65535 |
| vel | u16 | round(hypot(vN,vE)*100), cm/s; unknown=65535 |
| vn / ve / vd | i16 | round(component*100), cm/s NED |
| cog | u16 | Course [0,360) deg×100; unknown=65535 |
| fix_type / satellites_visible | u8 | Fix 0/2/3 according to availability; unknown satellites=255 |
| yaw extension | u16 | 0=unavailable, north=36000; distinct from cog |
| HIL_SENSOR.x/y/zacc | f32 | FRD specific force, m/s² |
| x/y/zgyro | f32 | rad/s FRD |
| x/y/zmag | f32 | **gauss** (microtesla×0.01) FRD |
| abs_pressure / diff_pressure | f32 | Pa/100 → hPa |
| pressure_alt | f32 | Pressure altitude, m; adapter convention fixture |
| temperature | f32 | K-273.15 → degC |
| fields_updated | u32 | Only fields actually updated; generated enum |
| HIL_ACTUATOR_CONTROLS.controls | f32[16] | [-1,1]; assignment depends on hardware profile |

Course is unknown below 0.05 m/s horizontal speed. If a signed velocity
component exceeds 327.67 m/s in magnitude, saturate with an encoding-clipped
diagnostic; never wrap the integer. Validate finite/range before quantization.
Do not produce reserved sentinels through overflow. Preserve sample time
rather than replacing it with WS send time. The codec checks MAVLink2
CRC_EXTRA, dialect, IDs, sequence, truncation, and signing when enabled.
Serial/WS chunk boundaries are not frame boundaries.

RC override channels 1..8 use 65535=ignore and 0=release. Channels 9..18 use
0/65535=ignore and 65534=release. RC microseconds and normalized actuators
are distinct contracts. Verify GPS/HIL support for the exact board/ArduPilot
build at the capability gate; absence of a callback is not success.

## 7. Numerical acceptance and experimental validity

* Analytic blade cases: zero relative airspeed gives zero force; CD>=0 drag
  dissipates relative energy; mirrored spin preserves thrust and reverses
  shaft torque. Independent golden fixtures check torque arms and hub rotations.
* Free-spin tests: the motor adds no energy and bearings dissipate energy;
  airflow can power autorotation. Require steady residual
  `|tau_motor+s*Q_air-tau_loss|<0.01 Nm` for the reference rotor fixture.
* Convergence: selected smooth cases at 400/800/1200 Hz are compared with
  an offline 4800 Hz reference. Position error<=0.1 m and attitude<=0.5 deg
  over 10 s, excluding contacts/discontinuities. Other envelope cases define
  their own tolerances.
* EW: truth before/after remains bit-identical; equal seed produces equal
  observations. Sampled drift position derivative matches velocity within
  discretization tolerance. Encode/decode error is at most one wire LSB.
* Automated fixtures and pinned native SITL verify stationary HIL, GPS
  altitude/sign, DOP units, gauss/hPa, and monotonic timestamps.
* JS allocation instrumentation and WASM allocator counters report zero
  allocations/bytes per step after warmup. `memory.buffer.byteLength` stays
  unchanged for 1e6 steps. This is not proof that the browser never performs GC.
* Experimental rotor/airframe validation and recorded Simulation-on-Hardware are separate
  gates. Missing data/hardware means BLOCKED_EXTERNAL, not DONE based on
  synthetic tests.

### Phase 1 envelopes and fidelity criteria (TASK-133)

[docs/decisions/phase1-fidelity.md](decisions/phase1-fidelity.md) states, for
each Phase 1 effect, the model, inputs, validity envelope, verification and
validation tolerances and the behavior outside the envelope, plus the S15
comparison metrics, the confidence labels (`preliminary`, `measured-input`,
`flight-checked`) and the basic support and contact approximation. Validation
limits, envelope bounds and contact defaults stay BLOCKED_DECISION until the
stakeholder approves them; no Phase 1 model task claims acceptance before then.


## Implemented reference kernels: TASK-025–028

These are reusable reference kernels, not a completed flight backend. Motor,
battery, frame aggregation and rigid-body integration are available independently;
production rotor `bet_step` still returns `AERODYNAMICS_UNAVAILABLE`. Runtime polar
binding, load/voltage iteration, motor-fault routing and Worker selection remain
unconnected. All quantities below use SI and body FRD/world NED.

### ESC and battery

The selected model is torque driven. Command duty has exact first-order lag;
shaft inertia is integrated only by the existing shaft kernel. Motor constants
satisfy torque/back-EMF reciprocity in SI. There is no second RPM governor.

$$
d_{n+1}=u+(d_n-u)e^{-\Delta t/\tau},\quad
I=\operatorname{clamp}\left({d_{n+1}V-k_t\Omega\over R_m},0,I_{max}\right),\quad
Q_d=k_tI,\quad P_{mech}=Q_d\Omega,\quad P_{cu}=I^2R_m.
$$

An ideal current-limited PWM ESC draws bus current `(Pmech+Pcu)/V` for positive
voltage/current. The current limit adjusts effective applied duty; the reported
filtered command is not a claim of applied PWM duty during saturation. Zero
voltage or a hard power cut produces zero drive torque, without resetting shaft
speed. No regeneration, switching losses or temperature model is implemented.

The battery uses linear open-circuit voltage versus SOC. Sum requested motor bus
powers and housekeeping exactly once; solve the low-current branch with a stable
root, then apply source, current and remaining-charge limits.

$$
V_{oc}(s)=V_{empty}+(V_{full}-V_{empty})s,\quad V=V_{oc}-IR_b,\quad
I_{req}={2P\over V_{oc}+\sqrt{V_{oc}^2-4R_bP}},\quad
I_{cap}=\min(I_{max},sQ_c/\Delta t,V_{oc}/(2R_b)).
$$

For `Rb=0`, use `Ireq=P/Voc` and omit the maximum-power current bound.
Infeasible requested power saturates at the admissible maximum; return
`power_limited` rather than a negative discriminant/NaN. A depleted pack is a
hard cut. Update `SOC=max(0,SOC-I*dt/Qc)`; source power equals delivered power plus
`I²Rb` at this step's held SOC. This is a lumped electrical model, not a chemical
energy or calibrated battery-life claim. TASK-197 feeds power availability back to the
actuators (see "Solving the bus with the motors").

### Frame aggregation and body integration

Rotor IDs are unique integers 0..31; at most 32 mounts. Hub quaternions use wxyz
and rotate hub coordinates into body FRD. The moment input already includes rotor
angular momentum transport; do not add motor reaction again.

$$
\mathbf F_b=\sum_i R_i\mathbf F_i,\qquad
\mathbf M_b=\sum_i(\mathbf r_i\times R_i\mathbf F_i+R_i\mathbf M_{hub,i}).
$$

The native integrator uses normalized quaternion RK4, constant body wrench during
a step, a symmetric positive-definite inertia tensor checked with Cholesky, and
positive mass. Float64 NED gravity is positive Down. Quaternion `q` rotates body
to NED; angular velocity is body relative to the fixed local NED frame.

$$
\dot{\mathbf p}=\mathbf v,\quad
\dot{\mathbf v}=R(q)\mathbf F_b/m+(0,0,g),\quad
\dot{\boldsymbol\omega}=J^{-1}(\mathbf M_b-\boldsymbol\omega\times J\boldsymbol\omega),\quad
\dot q={1\over2}q\otimes(0,\boldsymbol\omega).
$$

Accepted reference steps satisfy `0<dt<=0.01` and initial `|omega|*dt<=1`.
The sphere contact prototype has a separate integration owner; never step native
RK4 and Rapier for the same body. `BetRigidBodyBackend` requires a dedicated
WASM memory instance; do not share its heap reservation with a rotor arena.

### Independent rigid-body ABI v1

This is a WASM linear-memory contract, **not** a SharedArrayBuffer ABI revision.
The old rotor arena ABI and inter-thread ABI v2 remain unchanged. All doubles
are little-endian, pointers are 8-byte aligned, regions must be disjoint/in range,
and the 12 reserved header bytes must be zero. Input is 256 bytes; output 128.
`bet_body_abi_version()` returns 1; `bet_body_step(input,output,dt)` returns 0,
BAD_POINTER (-2), BAD_INPUT (-3), or ABI_MISMATCH (-7), leaving output unchanged on failure.

| Input byte offset | Type / count | Field | Units |
| --- | --- | --- | --- |
| 0 | f64 | mass | kg |
| 8 | f64[9] | row-major body inertia | kg*m² |
| 80 | f64[3] | position NED | m |
| 104 | f64[3] | velocity NED | m/s |
| 128 | f64[4] | body-to-NED quaternion wxyz | 1 |
| 160 | f64[3] | angular velocity body | rad/s |
| 184 | f64[3] | force body | N |
| 208 | f64[3] | moment body | N*m |
| 232 | f64 | gravity magnitude | m/s² |
| 240 | u32 | version = 1 | 1 |
| 244 | u8[12] | reserved = 0 | 1 |

| Output byte offset | Type / count | Field | Units |
| --- | --- | --- | --- |
| 0 | f64[3] | position NED | m |
| 24 | f64[3] | velocity NED | m/s |
| 48 | f64[4] | quaternion wxyz | 1 |
| 80 | f64[3] | angular velocity body | rad/s |
| 104 | f64[3] | coordinate acceleration NED | m/s² |

## Contact and JSBSim implementation gates: TASK-029–033

### Direct contact ABI v1 (TASK-029)

The production `GroundContact` adapter loads the verified artifact from
`node scripts/build-contact.mjs` through `GroundContact.initialize(bytes, manifest)`
before creating isolated sessions. This replaces the allocating provider wrappers.
The frozen Rapier 0.36.0 f64 source and storage-reuse patch are recorded in the
manifest alongside source hashes, artifact SHA-256 and fixed 16 MiB memory.
Since TASK-095 the build also patches parry3d-f64 0.31.1, pinned by the SHA-256
of its crate archive in `native/rapier/source.lock.json`: the contact manifold of
a capsule or cylinder on a halfspace took its point storage every step, so a
hull shape in contact allocated at every step;
`native/rapier/patches/parry-halfspace-reuse.patch` keeps the storage and copies
the previous points (at most four) to the stack for the impulse transfer. The
manifest records the patch's SHA-256 as `parryPatchSha256`.
The same patch and `reuse-step-buffers.patch` size the broad phase's work lists from
the tree on their first use: the traversal's list of branches still to visit, the
optimizer's lists and the list of candidate pairs. How long they get in a step depends
on the tree's shape and on which leaves changed, so a warmup can only meet some of it:
about 5 flights in 36 of the 16-motor aircraft stopped with status -6 during their
descent because the traversal's list grew (found 2026-11-06). Each bound follows from
the tree's size, which a session keeps constant: the lists hold distinct nodes, and a
traversal reports a pair of leaves at most once.
No imports, shared memory or concurrent/reentrant ABI access are allowed.
The separate contact lockfile is required; standalone BET retains its own ABI
and trapping allocator through the explicit `embedded-kernels` composition feature.

All buffers contain f64 values; offsets here are element indices, not bytes.
`contact_config_ptr`, `contact_input_ptr`, `contact_output_ptr` return aligned,
disjoint regions of 1312, 16 and 96 values. `contact_abi_version` returns 1.
`contact_initialize` rejects an existing session (-1) or invalid configuration (-2).
`contact_step` returns 0 on success, -1 if disposed/faulted, -2 for invalid input,
-3 for nonfinite/out-of-envelope physics, -6 for a counted allocation. Failed
steps preserve the published output; failures after advancement permanently fault
the instance. `contact_dispose` is idempotent. Allocator calls/bytes are cumulative
over armed steps; `contact_allocator_probe` is a cold positive control that resets
the counters. Never call it during an armed run to erase allocation evidence.

Configuration header: [0]=version 1, [1]=0, [2]=airframe mass kg,
[3]=hull sphere radius m, [4]=restitution in [0,1], [5]=hull friction,
[6..8]=position NED m, [9..11]=velocity NED m/s, [12..15]=unit quaternion wxyz,
[16..18]=body angular velocity rad/s, [19..21]=positive diagonal inertia kg m²,
[22..24]=outward unit plane normal NED, [25]=plane offset n·p m,
[26]=gravity down m/s², [27]=wheel count 0..8, [28..31]=zero. Version 2
(TASK-094) puts the products of inertia I_xy, I_xz, I_yz in [28..30] (tensor
entries, so the inertia is [[19, 28, 29], [28, 20, 30], [29, 30, 21]] about the
CG in body FRD; it must be positive definite), and [31] stays zero. Rapier then
receives `MassProperties::with_inertia_matrix`, which diagonalizes the tensor
into a principal-axis frame; version 1 keeps its diagonal path bit for bit.
Version 3 (TASK-095) keeps version 2's inertia slots and adds each wheel's brush
cornering stiffness in its slot [28]; `GroundContact` writes it when a wheel has a
positive `corneringStiffnessNpRad`. Version 4 (TASK-095, decision F-08) keeps
version 3's slots and adds each wheel's kinetic over static friction ratio
μ_k/μ_s in its slot [29], in (0, 1] on every wheel; `GroundContact` writes it
when any wheel has a `kineticFrictionRatio` below 1, and a ratio of 1 gives
version 3's trajectory bit for bit. Version 5 (TASK-095) keeps version 4's
slots, so every wheel states its ratio, and adds up to 32 hull and propeller
shapes: [1] holds their count, 0 to 32 (zero before version 5), and shape i
starts at 1312+16*i. A capsule is [0]=1, [1..3] and [4..6] its end points and
[7] its radius; a cylinder is [0]=2, [1..3] its centre, [4..6] its unit axis
(within 1e-10), [7] its radius and [8] its half-height. Positions are body FRD
metres from the CG, the rest of a record is zero, and every record past the
count, and before version 5 every record, is zero. With shapes the airframe has
no sphere: the shapes, with the airframe's friction [5] and restitution [4],
meet the airframe ground plane (plane slot 0), and with zero shapes version 5
gives version 4's trajectory bit for bit. Because the buffers grow, the
artifact is contact ABI v3: `contact_abi_version` returns 3, and the regions
hold 1824, 52 and 352 values. `GroundContact` writes version 5 when
`ContactOptions.shapes` is non-empty.
`GroundContact` takes `inertiaKgM2` (row-major, exactly symmetric) and writes
version 2 only when a product is non-zero. Against the 4800 Hz RK4 body, a free
body with principal moments (0.02, 0.03, 0.045) kg m² turned 0.7 rad about
(1, 2, 3) and ω = (3, 7, 2) rad/s has, after 1 s, a rate error of 1.15e-3 and
an attitude error of 1.14e-3 rad at 400 Hz, and a rate error of 3.85e-4 at
1200 Hz (first order). Without the products the rate error is 1.15, so the
products act. The budget, set before the implementation, was 2 %, 0.02 rad, a
1200 Hz error at most 0.6 of the 400 Hz one, and at least a fivefold
difference without the products
(`native/contact/tests/contact.rs`, `tests/rigid-body-v2.test.ts`). Contact sessions run without
Rapier's continuous collision detection (`max_ccd_substeps = 0`, TASK-095): every ground is a
halfspace, which yields contact at any penetration depth, and the CCD sweep, which activates on
its own for fast bodies, builds temporary vectors in the step. A native test runs a session over
more than 1 km without an allocation. Building with `MIRAGE_CONTACT_TRACE=1` makes the first
allocation inside `contact_step` print its stack (native) or trap (WASM).

Each wheel starts at 32+160*i. Its fields are [0..2]=fully extended wheel-center
anchor body FRD m; [3]=unsprung mass kg; [4]=tire radius m; [5]=rigid rim radius m
(0<rim<tire); [6]=strut travel m; [7]=strut kind (0 linear, 1 gas);
[8]=linear stiffness N/m; [9]=preload N; [10..11]=compression/rebound damping;
[12]=damping law (0 linear, 1 square); [13..15]=rolling/lateral/braking mu;
[16]=tire damping N s/m; [17]=knot count 2..64; [18..27]=gas area, volume,
charge pressure, ambient pressure, exponent, hydraulic area, fluid density,
discharge coefficient, compression orifice, rebound orifice in the SI units
specified below; [28]=brush cornering stiffness N/rad (version 3, ≥ 0; zero in
versions 1 and 2); [29]=kinetic friction ratio μ_k/μ_s (version 4, in (0, 1];
zero in versions 1 to 3); [30..31]=zero; [32..95]=tire deflection knots m;
[96..159]=tire force knots N. Unused entries are zero. The last knot must cover
the tire-radius minus rim-radius distance. All values must be finite.

Input: [0..2]=external body force N; [3..5]=external body torque N m;
[6..13]=brake fractions in [0,1] (zero for unused wheels); [14]=dt exactly
1/400, 1/800 or 1/1200 s; [15]=zero. Output: [0..2]=position NED;
[3..5]=velocity NED; [6..9]=quaternion wxyz; [10..12]=body angular velocity;
[13..15]=coordinate acceleration NED; [16..18]=net contact impulse on the
airframe N s, excluding external force and gravity; [19..21]=net contact angular
impulse in the new body frame N m s, excluding external torque; [22..24]=hull
diagnostic lever arm body m; [25]=wheel count; [26..31]=zero. Each wheel at
32+8*i reports clamped strut compression m, tire compression m, tire load N,
strut load N, excess tire/rim overlap m, raw strut compression m, signed wheel
distance from the plane m, and zero. Wheel compressions and distances describe
the start of the step, the tire and strut loads the ones the step applied (TASK-095);
body state describes the completed step. In ABI v3 each shape at 96+8*i reports
its deepest penetration m (≥ 0), its normal impulse N s and force N, its deepest
touching point body FRD m from the CG, 1 when it touches and 0 otherwise, and
zero (`GroundContact.shapeStateInto`). A contact point touches when it is at or
inside the plane or carries an impulse; Rapier finds the points at the start of
the step, so penetration and point describe the pose before it, while the
impulse is the step's. With shapes, the diagnostic point [22..24] is the deepest
touching shape point, or zero when none touches.

The diagnostic hull point cannot represent a multiple-contact couple. Consumers
must use `ContactImpulse.momentBodyNms` when transferring the angular impulse;
do not infer it from a single point crossed with the net linear impulse.
Rapier alone integrates the airframe, wheels, prismatic extension/compression
stops and rigid rim bottom-out. Internal strut forces are equal/opposite.
Tire forces act only in contact. Force evaluation saturates at physical travel
and tire curve bounds while rigid constraints supply stop/rim reactions; raw
overlap diagnostics remain available. No second BET/JSBSim body integration
may run over the same step. A terrain plane is explicit configuration; ABI v2
(TASK-065, below) adds per-tick planes for terrain from published collision chunks.

Since TASK-095 each wheel's stroke is stepped linearly implicitly before Rapier
integrates; explicit loads made the drop peak depend on the step rate. The strut and
the tire act in series on the unsprung mass m. With c the cosine between the upward
ground normal and the strut, the stroke has stiffness K = k_s + k_t c² and damping
C = c_s + c_t c² from the laws' tangents (`tangent`, below). A θ-method step solves

$$
m\,\Delta v=\Delta t\,\big(F_0+m\,a-\theta\,(K\,\Delta t\,v_1+C\,\Delta v)\big),\quad v_1=v_0+\Delta v
$$

for the stroke rate v. F_0 is the start-of-step stroke force, including the tire's
closure from the anchor's own approach; a holds gravity and the airframe acceleration
from thrust and strut loads, the airframe's slower motion staying explicit. Each load
is applied as (1 − θ)·max(F_start, 0) + θ·max(F_end, 0). With Ω² = Δt²·K/m, θ is ½
(trapezoidal, no numerical damping) while Ω² ≤ 2 and 1 − 1/Ω² above, which bounds the
step's spectral radius near 1/Ω so that an unresolved stiff tire settles instead of
ringing. A step in which tire contact begins or ends is backward Euler (θ = 1) with
complementarity on the end load: out of contact the first tire segment, continued to
the signed gap, gives a virtual negative start load, and the tire enters the step only
if its end load is positive. Backward Euler throughout left the drop peak 5.6–8.5 %
below the RK4 reference, and trapezoidal steps across touchdown or lift-off added
energy at every bounce. The drop fixture (`native/contact/tests/contact.rs`: 1.5 kg on
four synthetic wheels, not a measured aircraft) keeps its peak airframe specific force
within 5 % of the three rates' mean and of a 100 kHz RK4 reference at 400/800/1200 Hz:
27.72/28.72/28.84 g against 28.96 g from 0.5 m and 55.00/57.04/57.16 g against 57.43 g
from 2 m, where explicit loads gave 39.6/32.8/31.4 g from 0.5 m. Tires up to 10⁷ N/m
(ω·Δt about 18 at 400 Hz) settle at their static deflection within 1 % at every rate.

Tangential friction (TASK-095) is static below breakaway and Coulomb above, per
axis of the ground plane: longitudinal along the projected heading, lateral across
it. Each axis first asks for the force that stops the contact against a stick
anchor within the step, f = −m·(v/Δt + β·d/Δt²), with v the wheel's tangential
speed, d its offset from the anchor and m the wheel plus its load share of the
airframe's effective mass at the contact point along that axis t,
1/(1/M + (r×t)·I⁻¹·(r×t)) for r from the airframe's centre of mass and I⁻¹ its
world inverse inertia. With shares of the translational mass alone, as before
2026-11-01, the feet together over-correct a rotation whenever the stance is
wide against the inertia (M·r² > 2·I): a quad on supports under its motors
(decision F-07) then flipped its yaw rate every step at the friction limit, at
about 0.09 rad/s. With the effective mass no mode of the airframe is corrected
by more than it moved. Below the axis limit μN (longitudinal μ is rolling +
(braking − rolling)·b for brake input b, lateral μ the lateral coefficient) it
sticks; above, it slides at μN, or at μ_k/μ_s of it in version 4, against that
request and the anchor follows. β = 0.2 is constraint
stabilization like Rapier's error reduction: the fraction of the anchor offset
removed per step, so a held wheel keeps a static offset of order gΔt²/β instead of
creeping. While a wheel rolls (|v_long| > 0.1 m/s) and has a cornering stiffness
C_α (configuration version 3), its side force is the brush law F_y = C_α·tan α
with tan α = v_lat/|v_long|, solved as an implicit damper of C_α/|v_long| and capped
at the lateral μN. The combined tangential force stays capped by max(longitudinal
μ, lateral μ)·N. Rolling remains kinematic: no wheel spin, anti-skid or steering.
The fixtures (`native/contact/tests/contact.rs`, the drop fixture's aircraft) pass
their declared tolerances at 400/800/1200 Hz: braked nose-down and side-on on a 10°
slope it creeps at most 5.4·10⁻⁷ m in 5 s (limit 1 mm); unbraked on 10° it rolls at
1.5098 m/s², braked on 40° (past breakaway) it slides at 1.0437 m/s², against
Coulomb 1.5098 and 1.0450 m/s² (limit 5 %); a 2 m/s sideways slide stops in
0.4025–0.4061 m against v²/(2μg) = 0.4079 m (limit 5 %) and then stays at rest; and
with C_α = 20 N/rad a 0.05 m/s side velocity at 5 m/s decays to 6.247·10⁻³ m/s in
0.3 s against the closed form v_y0·((v0 − bt)/v0)^(k/b) = 6.127·10⁻³ m/s (limit 5 %,
k = ΣC_α/m, b = μ_roll·g). These values were measured before the effective mass;
with it every fixture still passes its tolerance (creep at most 5.2·10⁻⁷ m, the rolls, slides and sideways stop unchanged to four digits, and the brush decay 6.266–6.315·10⁻³ m/s, within 3.1 % of the closed form). Version 4 adds
three: a 2 m/s sideways slide at μ_k = 0.8·μ_s stops at v²/(2μ_k·g) = 0.5099 m within 5 % (0.5039–0.5075 m);
braked at μ_s = 0.7 and μ_k = 0.525, the aircraft holds a slope of tan 0.45 after
dropping onto it (creep at most 3.3·10⁻⁶ m in 3 s, limit 1 mm) and slides down
tan 0.6 at g·(sin θ − μ_k·cos θ) = 0.6307 m/s² within 5 % (0.6307 m/s²); and a
1.5 kg airframe of 0.02 kg m² yaw inertia on feet 0.3 m out (M·r² seven times I)
rests with body rates below 10⁻⁴ rad/s after 1 s at all three rates (at most
7.8·10⁻¹² rad/s).
Cold initialization exercises contact transitions and all supported rates.
Actual armed allocations fault the session; stable memory alone is not evidence.
`node scripts/check-contact-binding.mjs` builds native and WASM from the frozen
f64 Rapier 0.36.0 source (`b716d375efc0201003f0cd9ef7168eee0b62c177`), verifies
analytic force/energy and static-load oracles plus same-source native/WASM parity
(position <=0.1 m, attitude <=0.5 degrees) and zero allocator calls/bytes across
0/3/8 wheels at 400/800/1200 Hz (9 million native steps; unit tests separately
count 9 million WASM steps), writing `test-results/validation/task-029-binding.json`.
`node scripts/bench-contact.mjs` (accepting wheel count 0/3/8 and rate 400/800/1200)
warms 4,000,000 steps plus 100,000 measurement-wrapper steps, then measures three
1,000,000-step windows with repeated lift/impact cycles and a positive allocating
control, verifying zero GC events, <0.01 B/step, and zero WASM allocator calls/bytes
(`highRateCertified=true`), writing `test-results/bench/contact.json` (or
`contact-<wheels>-<hz>.json`). The user's 2026-10-18 scope decision defers NASA
measured fidelity; its archived legacy comparison remains failed and is never
substituted with synthetic data.

### Compliant-force reference increment

`native/bet/src/landing_gear.rs` implements force/energy components with no dt,
position update, solver ownership or contact-ready claim. See the source decision
in architecture.md. Configuration is explicit SI; synthetic numerical tests are
not measured landing-gear calibration. There is no new production C/SAB ABI.

Compression x and closure speed v are positive while shortening a component.
`LinearStrut` uses preload F0 (N), stiffness k (N/m), finite travel (m), and
direction-specific linear (N s/m) or square (N s²/m²) damping coefficients.
`GasStrut` is a reduced single-chamber spring, with equal swept/pressure area A
(m²), extended volume V0 (m³), absolute charge/ambient pressures p0/pa (Pa),
polytropic exponent n in [1,1.4], hydraulic area Ah (m²), density rho (kg/m³),
discharge coefficient Cd in (0,1], and separate fixed compression/rebound orifice
areas Ao (m²). Charge pressure must be at least ambient, and V0-A*travel>0.
It excludes thermal state, fluid compressibility, metering-pin variation, seal
friction and compound chambers. Its parameters are not NASA calibration.

$$
F_{e,linear}=F_0+kx,\quad E_{linear}=F_0x+\tfrac12kx^2,\quad V=V_0-Ax.
$$

$$
p=p_0(V_0/V)^n,\quad F_{e,gas}=(p-p_a)A,\quad F_d={\rho A_h^3\over2(C_dA_o)^2}v|v|.
$$

$$
F=\max(0,F_e+F_d),\qquad P_d=(F-F_e)v\ge0.
$$

$$
E_{gas}=\begin{cases}p_0V_0\ln(V_0/V)-p_aAx,&n=1,\\ {p_0V_0\over n-1}[(V_0/V)^{n-1}-1]-p_aAx,&n\ne1.\end{cases}
$$

`ln_1p`/`exp_m1` preserve small-pressure changes; for swept fraction u=Ax/V0<1e-4,
the integrated gas-law excess uses its analytic series through u^5 to avoid
cancellation at zero gauge preload. With n<=1.4, the omitted dimensionless term
is below 1e-23 in that branch. Effective dissipation is computed after the load
clamp. Gas preload remains an internal force at full extension; the owning solver
must supply the extension-stop reaction. Exceeding strut travel returns GearError;
there is no invented bottom-out response or silent extension beyond the envelope.

`TireCurve` borrows 2–64 immutable knots: strictly increasing deflection from 0 m,
nondecreasing load from 0 N, plus nonnegative vertical damping N s/m. It linearly
interpolates force and integrates each segment exactly for elastic energy. For
deflection<=0 its load/energy/dissipation are zero; for positive deflection its
normal load is max(0,elastic+damping*closureSpeed). Deflection beyond the final
knot fails. Tire deflection is neither strut travel nor rigid-mesh penetration.
Each law also gives its tangent (`tangent`, TASK-095): d(load)/d(compression or
deflection) N/m and d(load)/d(rate) N s/m, both zero where the unilateral clamp holds
the load at zero. The gas stiffness is p0·n·A²/V·(1 − A·x/V)^(−n−1); a tire's is the
slope of the segment that holds the deflection (the left one at a knot, the last one
at the final knot). Central differences of `evaluate` are the test oracle.

`ground_wrench` accepts body contact point (m), body-to-NED wxyz, outward terrain
normal NED, nonnegative load N and contact velocity relative to terrain (m/s).
Normal/quaternion squared norms must be within 1e-10 of 1. Tangential force is
regularized Coulomb sliding friction, with explicit mu>=0 and veps>0:

$$
\mathbf v_t=\mathbf v-\mathbf n(\mathbf v\cdot\mathbf n),\quad
\mathbf F_{NED}=N\mathbf n-\mu N{\mathbf v_t\over\max(|\mathbf v_t|,v_\epsilon)},\quad
\mathbf F_b=R(q)^T\mathbf F_{NED},\quad\mathbf M_b=\mathbf r_b\times\mathbf F_b.
$$

This helper has no static-friction constraint, wheel spin, slip-ratio tire model,
brake or rolling-resistance law. It must not be applied alongside a second
solver's force for the same contact. Outputs and all inputs must remain finite.
No per-call heap allocation, collection growth, logging or mutation of body state
occurs. Invalid inputs return GearError; test-only WASM exports return NaN.

Predeclared synthetic tolerances: 1e-9 N/J/W for hand force/energy cases, 1e-5 N
for the polytropic energy derivative, 1e-12 relative for the small-compression
energy asymptote, and 1e-10 W for passive-power bounds. Native allocation counters
with a positive control cover 1e6 warmed evaluations in the existing numerical
graph. Scalar and SIMD-enabled test artifacts exercise the same scalar laws with
the trapping allocator and unchanged memory. This standalone helper does not
certify a NASA trajectory, live terrain session admission or physical tire slip.

### JSBSim WASM build and bridge ABI v1 (TASK-030)

JSBSim v1.2.3 is pinned to commit
`570e8115a102df8f877b11e0e59b964ea483e3c0`; Emscripten 4.0.15 to emsdk commit
`389a68bc35dcff7ebae4614e1615099dafda00d1`. The build checks source HEAD, tracked
cleanliness, LGPL-2.1 library license hash and SDK manifest hash before compilation.
Aircraft XML is not bundled: c172x includes separate redistribution language and
is not pilot validated. Review model-specific licenses/data before packaging.
Native smoke uses the same bridge/source, outputs 22 finite SI doubles after
one simulated second, and is **not** a trim, native/WASM parity or allocation test.
The pinned Emscripten 4.0.15 SDK builds the WASM artifact and passes Chromium
module-Worker execution at 400/800/1200 Hz via `node scripts/check-jsbsim-artifact.mjs`.

The build invokes Emscripten Python entry points directly on Windows and Unix;
`MIRAGE_PYTHON` and `MIRAGE_CMAKE` select executables, and `EM_CONFIG` is set to
the verified SDK's configuration. Ninja must be on PATH on Windows. CMake adds
the POSIX select header and compiles a generated local copy of `strutils.cxx`
selecting the POSIX `strerror_r` return type for Emscripten's musl. These are
portability changes, not changes to upstream dynamics; the checkout stays clean.
The manifest includes artifact byte counts/hashes, source/SDK commits, compiler
version, allocation-patch identity and hashes of the CMake/bridge/build runner.
`SOURCE_DATE_EPOCH` is fixed to the pinned source commit timestamp so upstream
`__DATE__`/`__TIME__` version strings do not change artifact bytes between builds.
The module exports FS, HEAPU8 and HEAPF64 for local assets and the existing adapter.

With `JSBSIM_SOURCE_DIR` and `MIRAGE_EMSDK_DIR` configured, run
`node scripts/build-jsbsim.mjs`, then `node scripts/check-jsbsim-artifact.mjs`.
Set `CHROMIUM_PATH` if Playwright's browser is absent. The standalone smoke
verifies provenance and artifact hashes, loads six local c172x/engine/system XML
files in a real Worker and checks ABI v1, 22 finite outputs, one simulated second
at each supported rate (time error <=1e-10 s), quaternion norm error <=1e-10,
64 MiB stable memory, invalid controls and disposed handles. It writes
`test-results/validation/jsbsim-artifact.json`; failures exit 1. Aircraft XML is
served only from a temporary loopback server for this local test, not bundled.
To compare a second clean build, set `MIRAGE_JSBSIM_OUT` for that build and pass
its directory as `MIRAGE_JSBSIM_COMPARE` when checking the primary artifact.
Matching artifact hashes establish local rebuild reproducibility only.

The bridge ABI v1 takes four float64 controls: throttle [0,1], aileron/elevator/
rudder [-1,1]. Output is 22 doubles: origin-fixed position NED at indices 0..2,
velocity NED 3..5, body-to-origin-NED wxyz 6..9, body angular velocity 10..12,
body specific force 13..15, simulation seconds 16, altitude ASL metres 17, gravity
magnitude 18, coordinate acceleration NED 19..21. Feet convert with exact 0.3048.
Origin ECEF and its NED rotation are frozen at initialization; transport body
vectors through ECEF into that origin frame. Quaternion extraction accounts for
JSBSim's passive matrix convention. Coordinate acceleration includes the body
velocity transport term; specific force is the applied-force acceleration.
JSBSim owns integration. The standalone Worker smoke above (`check-jsbsim-artifact.mjs`)
checks execution and memory identity; contact impulse coupling, pinned trim/step
parity and WASM allocator/GC gates are verified by the TASK-031 `--contact` build
(`check-jsbsim-backend.mjs` and `bench-jsbsim.mjs`) below.

## Implemented sensor references: TASK-034–035

`IdealSensors.sampleInto` consumes existing `BodyTruth`, epoch, split uint64 tick/
sample timestamps and wind NED. It fills existing ABI v2 sensor records with
truth-derived flags and finite float64 values; it does not synthesize GNSS
before the WGS84/geoid task. IMU is body angular velocity and specific force
`R(q)^T*(aNED-gNED)`, so a stationary upright body reports -g on FRD Z and free
fall reports zero. Magnetic field rotates NED gauss into body gauss. Barometer
uses ISA pressure Pa and altitude `originPressureAltitudeM-positionDownM`,
restricted to -1000..11000 m. Ideal airspeed is omnidirectional dynamic pressure
`0.5*rho*|velocityNED-windNED|²` Pa; no pitot alignment/compressibility is implied.

Sampling uses integer phase: add sensor Hz at each physics tick, emit and
subtract physics Hz on threshold. Rates must be integer 1..physicsHz;
200/400 Hz IMU and 5/10 Hz schedules have exact counts over 60 s at 400/800/1200.
Sampling occurs at the tick boundary, with less than one physics-tick phase
quantization; 400 Hz sensing at 400 Hz is not an interpolated observation.

Noise has explicitly specified post-filter RMS, bandwidth Hz, sample Hz and bias
random walk per square-root second. For each sensor stream, use independent
seeded streams `2*id` and `2*id+1` with fixed-work Box–Muller Gaussian draws.

$$
a=e^{-2\pi f_c/f_s},\quad n_{k+1}=an_k+\sigma\sqrt{1-a^2}\,z_k,\quad
b_{k+1}=b_k+{\sigma_b\over\sqrt{f_s}}\,z'_k,\quad y_k=x_k+n_{k+1}+b_{k+1}.
$$

Here `0<fc<fs/2`, sigma is stationary noise RMS, not an unqualified noise PSD.
Starting filter and bias state is zero; discard transient for stationary statistics.
The discrete two-sided PSD in units squared/Hz is
`sigma²*(1-a²)/(fs*(1+a²-2*a*cos(2*pi*f/fs)))` on [-fs/2,fs/2].
`sampleInto(values,out,index)` reads/writes preallocated float64 arrays, avoiding
boxed numeric returns in the V8 hot path. A fixed-capacity latency FIFO stores
one scalar per slot with monotonic due/poll times, safe integer microseconds,
explicit overflow/drop counter and reset; use separate queues for separate sensor
schemas. Its output contains due time and value; preserve original acquisition
metadata separately when integrating the pipeline. Queueing does not change
sampling timestamps or truth.

`node scripts/bench-sensors.mjs all` measures the combined ideal IMU, rational
schedule, seeded noise and latency path after four million warmup ticks, crossing
32-bit timestamp rollover before measurement. Six N=1e6/2e6 windows have no GC;
positive allocating control is required. Component probes (`ideal`, `noise`,
`metadata`) isolate failures. This is warmed Node/V8 allocation evidence, not
browser or M4/RTX timing certification and not full flight-backend allocation
certification.

The `body` allocation mode runs the actual scalar WASM body adapter before the
sensor pipeline, with held hover wrench. Six warmed N=1e6/2e6 windows show no GC
and zero incremental B/step, with an allocating positive control and unchanged
WASM memory. The `ideal` component exercises IMU, magnetic, barometer and airspeed
each iteration. Unit tests also run 1e6 body steps on both scalar and SIMD128
artifacts with the trapping allocator; these are numerical/allocation gates,
not measured airframe fidelity or target-device timing.

## JSBSim opaque handles, cold trim and contact coupling: TASK-031

Legacy ABI v1 remains four normalized controls and 22 SI outputs, with unchanged
offsets. The additive contact API has its own `jsb_contact_abi_version()`:
1 when enabled, otherwise 0. `node scripts/build-jsbsim.mjs --contact` applies
the original storage patch plus `native/jsbsim/patches/contact-impulse.patch`;
the manifest records both hashes and native WASM exception mode. Aircraft XML
remains local. Numerical acceptance is separate from measured aircraft fidelity.

`jsb_apply_contact(handle,input,count=6,out,outCount=22)` takes aligned f64:
origin-NED linear impulse N s at 0..2 and CG body-FRD angular impulse N m s at
3..5. Input/output occupy 48/176 disjoint bytes. Invalid/stale handles, counts,
alignment, bounds or overlap return -1; nonfinite input returns -2; nonfinite
physics returns -4; unavailable contact or active built-in weight-on-wheels
returns -5. Input validation precedes mutation. Exactly one application is
allowed after a successful fixed step; repeats fail. Position, orientation and
time are unchanged. The caller must solve constraints without integrating this
airframe separately. A TASK-029 Rapier airframe step cannot be reintegrated.
Loaded JSBSim gear owns active ground contact, excluding a second reaction.

$$
m_{kg}=m_{slug}{4.4482216152605\over0.3048},\quad I_{SI}=I_{slug\,ft^2}(4.4482216152605)(0.3048),\quad \Delta v_n=J_n/m_{kg},\quad \Delta\omega_b=I_{SI}^{-1}K_b.
$$

`FGPropagate::ApplyBodyImpulse` updates inertial velocity/body angular rate and
derived body/local velocities/quaternion derivative. Position and quaternion
derivative histories receive the same discontinuity, without allocation or
Adams-Bashforth smearing; continuous-force acceleration histories remain intact.
Published acceleration/specific force includes the impulse divided by dt as a
sample-average diagnostic, never integrated again.
This is a post-step split: continuous model forces are recomputed by the next
ordinary JSBSim evaluation. No extra zero-time model run or higher-order external
contact iteration is inserted; internal model sensors are not replayed mid-tick.

`jsb_mass_properties(handle,out,count=10)` returns current kg and full row-major
body inertia kg m², including fuel changes. `jsb_read_state(handle,out,count=22)`
does not advance time. Cold `jsb_set_initial_state(handle,input,count=13)` accepts
geocentric latitude/longitude rad, ASL m, roll/pitch/yaw rad, body velocity m/s, body rates
rad/s, terrain ASL m. All values are finite; latitude/longitude bounds are pi/2
and pi, altitude -1000..1000000 m. RunIC resets the fixed origin; changes after
stepping are rejected. The adapter's 104-byte scratch region serially serves
initial state, mass and impulse calls. Legacy control fields retain their meaning.

At most 64 loaded gear entries, each with at most two friction multipliers, are
supported. Multiplier, dense friction matrix and RHS capacities are reserved
during cold load. Reusing/zeroing buffers preserves solver order and values;
dynamic topology is unsupported. The contact build uses native WASM exceptions
at compile/link time (`-fwasm-exceptions`), keeping exception/virtual-call
trampolines out of JS. Unsupported runtimes fail at cold compilation; an
allocating fallback cannot be certified. See [Emscripten exception support](https://emscripten.org/docs/porting/exceptions.html).
The ordinary legacy build retains JavaScript exception support. Its initial
contact GC run failed with 75 events per million steps; that report is retained.

`jsb_allocator_probe`, `jsb_allocation_track`, `jsb_allocation_calls` and
`jsb_allocation_bytes` instrument malloc/calloc/realloc, aligned allocation and
C++ new/delete. The cold positive control detects an allocation then resets
counters; never reset during measurement. Volatile counters prevent compiler
folding across the linker's allocator rewrite. `JsbsimBackend.armHighRate`
arms after setup/warmup and faults on a counted allocation. Dedicated memory,
matching stable heap views, disjoint owned frames and external caller outputs
are mandatory. These counters do not detect JS allocations; the GC gate is
separate. Cold model reload/trim between bounded flight windows is excluded
explicitly; stationary ground runs evolve continuously.

`scripts/check-jsbsim-backend.mjs` compares native/WASM trim, step-control and
impulse cases at 400/800/1200 Hz over ten seconds. Registered reference descriptor
`airframes/jsbsim-backend-reference.json` predeclares 0.1 m position, 0.5 degree
attitude, 0.1 m/s velocity, 1e-6 trim and 1e-8 N s momentum budgets. Stationary
ground verifies speed <0.02 m/s, acceleration <0.05 m/s² and upward specific force
(local equatorial gravity is about 9.78 m/s², not forced to 9.80665).
`scripts/bench-jsbsim.mjs` runs the real adapter with a passive six-DOF support
impulse (J=-m v, K=-I omega), no second pose/time integration, and separate
JS GC/native allocator/allocating-control observations. These checks do not
establish target-device real-time timing, model redistribution permission or
measured calibration. The current adapter remains the explicit control/contact
bridge; demo/flight-session selection and autopilot readiness are separate.

Bridge handles are now generation-tagged tokens: low four bits select a slot,
remaining bits identify its generation. Generation zero is invalid. Disposing a
stale handle is a no-op; using it after a slot is reused cannot access the new
session. Slots retire before generation wrap. The token remains opaque; this
changes neither the v1 state layout nor function argument types. Input/output
frames must be disjoint; overlap is rejected before controls or simulation time
change. The adapter also rejects mismatched heap views, unaligned/out-of-range/
overlapping frame allocations, and memory replacement during calls.

Additive optional export `jsb_trim(handle,controlsOut,count=4)` performs full
JSBSim trim during cold setup only. It initializes engine/mixture, may allocate,
returns trimmed controls, and recaptures the fixed origin on success. It fails
after stepping begins. Status 0 means trim success, -1 invalid handle/state/frame,
-2 trim failure, -3 invalid trimmed control. A failed trim may change upstream
setup state: dispose/recreate before retrying flight setup. The adapter exposes
`trimInto` and rejects modules without this optional capability. ABI v1's existing
step remains compatible. Native trim is not measured model fidelity.

`node scripts/check-jsbsim-native.mjs` builds/runs the real pinned native bridge.
Checks cover stale-handle reuse, invalid/overlapping inputs, normalized wxyz,
central-difference position/velocity/acceleration, and body-specific-force rotation
versus gravity. Declared tolerances are 0.1 m/s, 0.1 m/s² and 0.05 m/s² respectively;
the latter allows rotating-Earth apparent-gravity terms not represented by the
reported scalar Newtonian gravity magnitude. Native full trim passes. The actual
errors are 5.50e-7 m/s, 5.50e-10 m/s² and 0.03392 m/s².

The allocator test uses 250 independently initialized/trimmed flight windows,
400 warmup steps then 4000 measured steps per window (1e6 measured total).
Reset/trim/destruction are outside measurement, keeping each flight in the short
reference envelope instead of treating uncontrolled long-flight divergence as
an allocator test. GNU wrappers count malloc/calloc/realloc/aligned allocation
and C++ new/new[]; the positive control must be detected. In the unpatched
upstream native run, measured result is 21,142,500 allocations / 1,454,820,000
bytes (CLI exits 2); `test-results/validation/jsbsim-native.json` records
model/source/bridge/checker hashes and windows. No aircraft XML is redistributed.

### Model validation report (schema v5)

`node scripts/validate-models.mjs` validates `tests/fixtures/validation/reference-manifest.json`
(schemaVersion 2) **before** compilation, rejecting empty/misordered rates,
malformed cases, duplicate IDs, missing analytic ballistic reference, and
invalid `measurements` or `deferredMeasurements` descriptors. It builds actual
scalar/SIMD artifacts, runs two 10-second rigid-body cases at 400/800/1200
against 4800 Hz, verifies the analytic ballistic trajectory, evaluates active
and deferred measured-data references, and writes SHA-256/provenance plus error
metrics to `test-results/validation/model-report.json` (schema v5,
`docs/validation/model-report.schema.json`). Position tolerance is 0.1 m;
attitude tolerance is 0.5 degrees using absolute quaternion dot product.

The report exposes `diagnostics.jsbsimBackend`, `diagnostics.jsbsimJsAllocation`,
`diagnostics.annularBem`, `diagnostics.contact`, `diagnostics.jsbsimNative`,
`diagnostics.contactNativePatched` and `diagnostics.jsbsimNativePatched`, each
containing path, report SHA-256 (or null), and status missing/invalid/stale/pass/failed
verified against current source and build-input hashes. Diagnostics describe
evidence and cannot authorize a full backend. Numerical PASS (12 cases) is
separate from fidelity: failing UIUC propeller fidelity (`propellerFidelityStatus: "failed"`),
user-deferred NASA contact fidelity (`contactFidelityStatus: "blocked"`), absent
measured airframe/rotor datasets (`fidelityStatus: "blocked"`) and the unconnected
full BET backend keep overall `status: "failed"` with exit 2. No synthetic
dataset is relabeled as measured.


## Native allocation patches: verified scope (2026-10-16)

Both source patches are opt-in through `--patched`. The runners verify the
original pinned checkout/license, archive that commit into an external cache,
apply the checked-in patch with `git apply --check`, and record its SHA-256.
The original checkout and npm Rapier artifact remain unchanged. No equations,
unit conversions, integration order, or acceptance thresholds are changed.
These are reproducible native experiments, not enabled production backends.

Rapier's patch retains the modified-body handle vector, resets existing
StageSync cursors after workers have joined, and retains single-threaded
narrow-phase transition storage. The diagnostic uses an awake 1 kg sphere and
an infinite halfspace in NED, 400 Hz, 100,000 warmup steps, then 1,000,000 steps
with 100 ticks of lift per 800 ticks. This differs from the earlier finite-box,
sleep-enabled diagnostic: do not compare those allocator counts directly.
The matching current original run reports 2,002,500 allocator calls / 96,320,000
bytes; the patched run reports **zero calls / zero bytes**. Both have the same
trajectory checksum `317ba7c959cd2b59`. Native f64/std/enhanced-determinism is
built without the profiler feature. This does not measure the npm f32 WASM
binding or establish a general landing-gear manifold. These standalone native
probes remain separate from the production `build-contact.mjs` and
`build-jsbsim.mjs --contact` WASM artifacts verified in TASK-029 and TASK-031.

JSBSim's patch shifts values within the existing five deque history slots,
walks existing atmosphere override children without parsing property paths,
and reserves reusable fuel/oxidizer feed lists at model load, sized to the
maximum engine source-tank count. Overrides remain dynamically discoverable;
fuel priority, starvation and drain ordering are unchanged. On the pinned
c172x reference, native full trim and SI/frame checks pass. Original allocation
count is 21,142,500 calls / 1,454,820,000 bytes; the patched million measured
steps report **zero calls / zero bytes**, in the same 250 bounded flight windows.
Both trajectories have checksum `164fd3c0bf6d8a39`. Other aircraft, engine types,
override mutation scenarios and contact coupling are not certified by this run.

Reproduce with the pinned source caches, GNU C++ 14.2, CMake 3.31.6 and Rust
1.97.0 already described above. Original runs intentionally exit 2; patched
runs exit 0 only when their numerical and allocator checks pass:

```bash
node scripts/check-contact-native.mjs
node scripts/check-contact-native.mjs --patched
node scripts/check-jsbsim-native.mjs
node scripts/check-jsbsim-native.mjs --patched
node scripts/check-engine-patch-parity.mjs
```

Run those commands independently so an original failure does not skip the
patched measurement. The parity checker requires current probe/checker,
dependency-lock, source-pin and patch hashes, original allocation failures,
patched zero counts and matching million-step trajectory checksums. It writes
`test-results/validation/engine-patch-parity.json`. FNV-1a-64 processes every
finite output double in little-endian byte order: 13 state components per
Rapier step and all 22 bridge components per JSBSim step. Checksum agreement is
a deterministic regression check, not a cryptographic proof or a measurement
of physical accuracy. SHA-256 authenticates report/source identities separately.
Reports `test-results/bench/contact-native-patched.json` and
`test-results/validation/jsbsim-native-patched.json` retain distinct provenance.


## Radio, autopilot transport and isolated fault components (TASK-037–060)

This batch implements TASK-037/038/039/040/048/052/053/056/057/060. Modules are
independent protocol/transport/training references. The default browser flight Worker
still uses `DemoDynamics`; browser autopilot READY, recorded Simulation-on-Hardware, live terrain
session admission and physical transmitter/flight-controller acceptance remain
separate. Geodesy (TASK-036), JSON lockstep (TASK-041), HIL streaming (TASK-049),
HITL capability gating (TASK-050), EW composition (TASK-054/055/058), native
SITL/EW (TASK-042/043/059) and browser WASM firmware bootstrap (TASK-045) are
specified in the sections below.

### Pinned MAVLink2 subset

`packages/mavlink/dialect.lock.json` (schema 2) pins MAVLink commit
2e2b6af99084e4fde9bb304c84bb9253a1a98b6f, the dialect `ardupilotmega.xml` with
the hash of every definition file it includes (common, standard, minimal,
uAvionix, icarous, loweheiser, cubepilot and csAirLink) and of the license,
pymavlink 2.4.50 and generator-file hashes, the supported message IDs and the
high-rate subset. The older 2.4.49 generator rejects the pinned XML schema;
validation is retained with the compatible 2.4.50.
`generate-mavlink-fixtures.py` (sources from `MIRAGE_MAVLINK_SOURCE` and
`MIRAGE_MAVGEN_OUTPUT`) verifies source cleanliness/commit/version and uses the
official generator. It also writes `packages/mavlink/src/message-table.ts`
(TASK-150): for each supported message its ID, name, CRC_EXTRA, full MAVLink2
payload length and fields in wire order (name, wire type, byte offset, array
length, units, extension), taken from the generator's own parser.
`definition(id)` reads this table, so the codec cannot drift from the
generator. Generated Python stays outside the repository; checked-in golden
frames are SHA-256 registered synthetic protocol oracles packed by pymavlink
from recorded field values. They are not aircraft measurements. The upstream
generated-output notice is retained in packages/mavlink/NOTICE.

| Message ID | Message | Full payload bytes | CRC_EXTRA |
| --- | --- | --- | --- |
| 0 | HEARTBEAT | 9 | 50 |
| 1 | SYS_STATUS | 43 | 124 |
| 20 | PARAM_REQUEST_READ | 20 | 214 |
| 21 | PARAM_REQUEST_LIST | 2 | 159 |
| 22 | PARAM_VALUE | 25 | 220 |
| 23 | PARAM_SET | 23 | 168 |
| 24 | GPS_RAW_INT | 52 | 24 |
| 27 | RAW_IMU | 29 | 144 |
| 30 | ATTITUDE | 28 | 39 |
| 32 | LOCAL_POSITION_NED | 28 | 185 |
| 33 | GLOBAL_POSITION_INT | 28 | 104 |
| 36 | SERVO_OUTPUT_RAW | 37 | 222 |
| 40 | MISSION_REQUEST | 5 | 230 |
| 41 | MISSION_SET_CURRENT | 4 | 28 |
| 42 | MISSION_CURRENT | 18 | 28 |
| 43 | MISSION_REQUEST_LIST | 3 | 132 |
| 44 | MISSION_COUNT | 9 | 221 |
| 45 | MISSION_CLEAR_ALL | 3 | 232 |
| 46 | MISSION_ITEM_REACHED | 2 | 11 |
| 47 | MISSION_ACK | 8 | 153 |
| 51 | MISSION_REQUEST_INT | 5 | 196 |
| 70 | RC_CHANNELS_OVERRIDE | 38 | 124 |
| 73 | MISSION_ITEM_INT | 38 | 38 |
| 74 | VFR_HUD | 20 | 20 |
| 75 | COMMAND_INT | 35 | 158 |
| 76 | COMMAND_LONG | 33 | 152 |
| 77 | COMMAND_ACK | 10 | 143 |
| 82 | SET_ATTITUDE_TARGET | 51 | 49 |
| 84 | SET_POSITION_TARGET_LOCAL_NED | 53 | 143 |
| 85 | POSITION_TARGET_LOCAL_NED | 51 | 140 |
| 86 | SET_POSITION_TARGET_GLOBAL_INT | 53 | 5 |
| 87 | POSITION_TARGET_GLOBAL_INT | 51 | 150 |
| 93 | HIL_ACTUATOR_CONTROLS | 81 | 47 |
| 105 | HIGHRES_IMU | 63 | 93 |
| 107 | HIL_SENSOR | 65 | 108 |
| 113 | HIL_GPS | 39 | 124 |
| 147 | BATTERY_STATUS | 54 | 154 |
| 193 | EKF_STATUS_REPORT | 26 | 71 |
| 253 | STATUSTEXT | 54 | 83 |

TASK-150 adds the Phase 1 ground-station messages. `packInto(id, values,
payload)` is the cold builder for commands, parameters, missions and position
targets: unset fields are zero, and an unknown message or field, a payload of
the wrong length, a non-integer or out-of-range integer, a value that is not
finite in its wire type, an array of the wrong length or text that is not
ASCII or does not fit return false and leave the payload unchanged. 64-bit
integers are limited to the exact JavaScript range. `readNumber(view, field,
index)` and `readText(payload, field)` read any field; 64-bit fields are read
as two 32-bit words, so no BigInt is created. The high-rate telemetry subset
(SYS_STATUS, ATTITUDE, LOCAL_POSITION_NED, GLOBAL_POSITION_INT,
SERVO_OUTPUT_RAW, VFR_HUD and BATTERY_STATUS) has preallocated targets
(`newAttitude`/`attitudeInto` and so on) with unit-named fields in the wire's
units. Each decoder reads its fields with direct DataView getters at offsets
resolved once from the table, whose wire types it asserts at load; a decoder
accepts only its own message ID. SERVO_OUTPUT_RAW decodes all 16 outputs,
outputs 9 to 16 being extensions that read 0 from senders without them, and
BATTERY_STATUS joins cells 1 to 10 and the extension cells 11 to 14. The
goldens hold two pymavlink frames per supported message, one with a distinct
value in every field and one truncated to its first field; the codec
reproduces every byte and the readers every value. The `mavlink` component of
`node scripts/bench-links-ew.mjs` also encodes, parses and decodes one
high-rate telemetry frame per tick for G1.

`encodeInto` writes into caller storage and returns exact length (0 on invalid
inputs). MAVLink2 trailing-zero truncation retains at least one payload byte.
`MavParser` owns a 280-byte collection buffer, 255-byte padded payload, one
DataView and a fixed 65536-entry sequence table. It checks magic/version,
flags, supported IDs, payload bounds and X.25 CRC including CRC_EXTRA. It accepts
arbitrary split/coalesced chunks; truncated links call discardPartial on timeout.
Rejected records resynchronize through a bounded search. Sequence wrap, gaps,
duplicates and out-of-order observations are recorded separately; sequence
numbers alone do not prove authenticated replay protection.

Callbacks consume a reused frame synchronously. Retained frames require an I/O
copy; callbacks must not reenter the parser. Framing resets before the callback,
so consumer exceptions do not duplicate a frame. MAVLink1, unknown messages,
nonzero compatibility/incompatibility flags and signed frames are rejected.
Signing is unsupported and cannot silently become an authenticated session.
Future firmware support must explicitly extend this pinned subset.

SensorMapping implements section 6: u64 timestamps remain two u32 words, DOP
is dimensionless times 100, pressure uses hPa, magnetic field gauss and temperature
Celsius. GPS clipping sets clipped; known DOP/speed saturate below 65535 and
signed velocity is limited to +/-32767 cm/s. Course wraps before degree conversion
and is unknown below 0.05 m/s. Unknown validity maps to explicit wire sentinels.
ImuSample arrays have three components each; updatedMask admits bits 0..12 and
bit 31 only. Invalid inputs preserve output. actuatorInto validates all 16
normalized controls before changing output. No BigInt is created in stepping.

### Radio mapping and lifecycle

Calibration storage uses key mirage.radio-calibration.v1 with schemaVersion=1,
four validated raw-axis calibrations and an optional independent mode axis.
Default mode configuration is disabled; enabling axis 4 maps normalized input
to six slots. Invalid/missing enabled axes clear every stick/arm flag. UI changes
disarm immediately, and existing device-generation protection handles unplug,
replug and a different transmitter at the same index. Profiles are validated on
load/save; storage errors do not fabricate a valid profile. The manual physical
USB checklist is separate and NOT_RUN.

PilotRcMapper maps configured channels [roll,pitch,throttle,yaw,mode], default
[1,2,3,4,5]. Centered axes map -1/0/1 to 1000/1500/2000 us; throttle 0/1 maps
to 1000/2000 us. Default mode PWM is [1100,1300,1425,1550,1700,1900]; actual
flight-mode assignment remains firmware parameter configuration. Unknown mode
leaves its channel ignored. Disconnect releases only owned channels, preserving
other senders. Channels 1..8 release with 0; 9..18 with 65534; ignore is 65535.
Slots never invent requestedMode or an ArduPilot mode enum in the v2 mailbox.

AutopilotSession exposes mutually exclusive external-sitl/wasm-sitl/hitl state:
disconnected -> initializing -> warming -> ready -> running, with fault and
explicit disconnect recovery. Timers cannot create READY. Fresh, epoch-matching,
autopilot-sourced positive health is required; running also requires current
16-channel actuators. Replayed/future/nonfinite controls are rejected. Default
staleness is 100 ms, configurable in (0,1000] ms. Monotonic clock polling clears
outputs on stale health/actuators, health failure, disarm or clock reversal.
The class defines admission; no firmware/health decoder is supplied by this task.

### Loopback bridge binary contract

The bridge binds 127.0.0.1:9002 by default. Exact loopback origin/Host checks and
a 64-hex session token passed through subprotocol session.<token> protect upgrades.
URLs/logs never contain the token. mirage-v1 is the negotiated subprotocol.
Only one authenticated client owns the session; reconnection creates fresh
sequence state for the configured epoch. Epoch changes require a newly configured
session. UDP endpoints are explicitly configured separate MAVLink/physics ports.
The bridge is transport: JSON/servo schemas and ArduPilot lockstep are TASK-041.

Each WebSocket binary message contains exactly one record; WebSocket fragmentation
is reassembled by ws. Coalesced WebSocket messages stay separate; concatenating
two records inside one message is invalid. All header integers are little endian.

| Byte offset | Type | Field | Constraint |
| --- | --- | --- | --- |
| 0 | u8 | version | 1 |
| 1 | u8 | channel | 1=MAVLink, 2=physics outbound, 3=servo inbound |
| 2 | u16 | reserved | 0 |
| 4 | u32 | epoch | configured session epoch |
| 8 | u32 | sequence | monotonic per channel, modulo 2^32 |
| 12 | u32 | payloadLength | 0..4096 |
| 16 | u8[] | payload | exact declared length |

Inbound client channel 3 is rejected. UDP sockets are connected to their selected
loopback peer, so arbitrary remote senders are not accepted. Duplicate/stale
records, more than the session's message limit, oversized records and backpressure
close the session. The limit is 4096 messages/second, and for a lockstep run the
launcher adds one message per step at the run's rate and speed-up, because a flat
limit would close any run above 4096/rate times real time, about 5.1 times at
800 Hz. A connection to a SITL the user started takes the most a launcher run may
ask for, since only that SITL knows its `--speedup`. Default queued-byte budget is 65536; queues cannot grow indefinitely.
A client that does not answer a WebSocket ping closes after 5 seconds. The bridge sends a ping every 1 s. A pong proves the peer is alive, so silence of physics payloads during a lockstep pause does not close the session. Tests exercise real WS/UDP transfer,
fragmentation, origin/token rejection, reconnect, epoch/flood/size checks and
injected backpressure. CLI startup is verified separately.

Plain ws is a loopback development path. HTTPS pages may require an explicitly
configured local WSS endpoint and trusted certificate; mixed-content rules and
browser PNA/Local Network Access prompts remain applicable. No browser security
setting is disabled. These tests do not establish a deployed WSS or SITL session.

### Serial stream ownership

Connect serial requests permission synchronously inside the button handler.
Unavailable APIs disable it; denial is shown without an automatic prompt loop.
SerialTransport leases one port, reader and writer; concurrent opens are rejected.
Close handles pending reads/open, cancellation, errors and explicit reopen.
Writes allow one in-flight buffer, maximum 4096 bytes; callers retain that buffer
until completion. Incoming chunks are at most 4096 bytes. The I/O Worker parses
MAVLink and returns copied payloads, separate from the physics Worker. Each chunk
requires an acknowledgement before reading another; a 500 ms decoder timeout
closes the transport instead of growing a message queue. I/O copies/promises and
permission work are outside the high-rate loop. The UI labels connection as a
transport diagnostic and explicitly keeps HITL unavailable.

Before opening the selected port, the controller waits up to 5 seconds for
`serial.ready` from the initialized I/O Worker. Worker startup/module loading
is outside the 500 ms per-chunk deadline. Startup failure leaves the port
unopened; chunk timeout still closes an established transport. This handshake
does not grant HITL admission or change the permission gesture requirement.

### Training EW and mechanical faults

HazardVolumes validates <=64 unique stable IDs and sorts them once. Finite sphere/
cone exposure follows section 5 with a 1e12 sum saturation, minimum radius >=1e-6 m,
radius <=1e6 m, relative power <=1e6 and reference distance <=1e6 m. Cone axes
must be unit vectors within 1e-9, half aperture in [1e-6,pi/2]. Cone taper uses
x=clamp((cosine-cos(theta))/(1-cos(theta)),0,1), G=x*x*(3-2*x); the center uses G=1.
Outside is zero, including cone angles beyond the boundary. This is synthetic
severity, not measured RF power or a receiver link budget.

GnssJamming implements the exact exponential low-pass and section 5 presets:
tau>0, Njam=0..3, DOPjam=50..99; dt in (0,0.01] seconds. Reset/zero severity
preserve baseline. A latched no-fix state recovers only below 0.6 with known
satellites >=4; unknown satellite count cannot prove recovery. Validity remains
unknown when its baseline is unknown. Already worse DOP/fix/count is never
improved. Source GPS, IMU, barometer and physics truth remain untouched.

MagneticAnomaly precomputes Rz*Ry*Rx and biasBodyGauss once, then writes three
body sensor components in place. Overlapping source/target views are rejected.
Rotation preserves norm before bias; truth quaternion/gyro are not inputs and
cannot be mutated. No particular EKF trajectory or mode response is guaranteed.

MotorFaults reserves IDs 0..31, independent of channel order. Power-cut scales
only drive torque, retaining aerodynamic wrench and passive shaft dynamics.
Instant-thrust-loss scales one rotor's force/aerodynamic moment that tick and
sets VehicleFlagV2.ModelOutsideValidity (bit 5) while any such fault is active.
Reset clears all faults/flags. Rust tests retain spool decay after zero drive
and verify the removed rotor's lever-arm moment. Full BET/mixer wiring and
compensation flight tests remain separate from these independent references.
No session dynamics reads a MotorFaults table yet: the demo quad and
BetFlightDynamics have no motor-fault input (`SessionDynamics.useMotorFaults`),
so the application rejects motor-loss at admission until one does (TASK-124).

### High-rate API and measurement boundary

Dynamically computed float arguments/returns can allocate boxed numbers in V8.
Use the typed-array boundaries below for high-rate composition. Allocate length
3 position/magnetic arrays, length 1 severity/clock/torque arrays, length 6 wrench
and length 16 actuator arrays once. Clock values are monotonic milliseconds;
source GPS and target GPS are distinct. All invalid-step results are false;
configuration constructors may throw outside stepping.

```ts
// Structural hot-path contracts implemented by the corresponding classes.
interface HazardVolumesHot {
  severityFromNedInto(positionNedM: Float64Array, outQ: Float64Array): boolean;
}
interface GnssJammingHot {
  advanceInto(severity: Float64Array, dtS: number): boolean;
  distortInto(source: GpsSample, target: GpsSample): boolean;
}
interface MagneticAnomalyHot {
  distortInto(sourceGauss: Float64Array, targetGauss: Float64Array): boolean;
}
interface MotorFaultsHot {
  driveTorqueFromArrayInto(id: number, sourceNm: Float64Array, outNm: Float64Array): boolean;
  wrenchInto(id: number, source: Float64Array, target: Float64Array): boolean;
}
interface AutopilotSessionHot {
  healthAt(health: AutopilotHealth, clockMs: Float64Array): boolean;
  acceptActuatorsAt(controls: Float64Array, epoch: number,
    sampleMs: Float64Array, clockMs: Float64Array): boolean;
  pollAt(clockMs: Float64Array): boolean;
}
```

`node scripts/bench-links-ew.mjs all 400` also accepts 800/1200 and optional
components ew/mavlink/state. The real component graph uses changing exposure,
all four supported message types, actuator decoding, RC mapping, timestamp word
rollover and lifecycle health/control checks. Four million steps warm V8 before
three pairs of N=1e6/2e6 measured windows; an allocating control must be detected.
I/O and profiler callbacks are excluded. Reports under test-results/bench use
links-ew-all-<Hz>.json, record source/script SHA-256 and Node version, and retain
GC count and incremental bytes/step. This is cloud Node evidence; it does not
establish browser hard real time, full Worker/backend admission or M4/RTX FPS.

### Terrain policy boundary

providerPolicy rejects unknown configurations and freezes the result. Google
live policy grants only transient memory/TTL 0, offline false, prefetch false;
persistent R2/prefetch/offline remain denied. Owned/licensed datasets require
reviewed evidence hashes for these permissions. No key, provider fetch or cache
implementation is included. See docs/decisions/terrain-licensing.md and its mirror.


Mode calibration exposes axis index, endpoints, center, deadzone and inversion; changing it disarms and rejects overlap with a primary stick axis.

## Implemented geodesy: TASK-036

`packages/sensors/src/geodesy.ts` implements WGS84 (NIMA TR8350.2:
`a=6378137` m, `1/f=298.257223563`) in float64. `geodeticToEcefInto` uses the
closed form; `ecefToGeodeticInto` uses Bowring's parametric start with three
refinements and `h=p*cos(lat)+z*sin(lat)-a*sqrt(1-e2*sin²(lat))`, which does
not divide by `cos(lat)`. `LocalTangentFrame` freezes the origin ECEF and the
ECEF-to-NED rotation at construction and converts NED offsets through ECEF,
so poles and the antimeridian need no special cases; longitude is reported in
`[-pi, pi)` and is 0 on the polar axis. All conversions write caller-owned
`Float64Array` outputs without allocation.

`packages/sensors/src/geoid.ts` separates ellipsoidal `h` from MSL `H=h-N`.
`GridGeoid` interpolates a regular latitude/longitude undulation grid
bilinearly (longitude wraps, latitude clamps) and requires model, source,
license and SHA-256 provenance. Without one, `NO_GEOID` sets `N=0`, MSL values
are provisional, and `mslAccuracyGate` returns `BLOCKED_EXTERNAL`; a hash
mismatch against the pinned payload also blocks. TASK-148 adds the
authoritative EGM96 grid (below), which opens the gate.

## Geographic environment: TASK-148

TASK-148 supplies what a location changes in the physics: normal gravity, the
geomagnetic main field and the geoid. Each model is verified against
independent reference data, the effective-conditions record combines them for
one location, and the flight sessions, the Run tab and the experiment record
carry them.

**Normal gravity** (`packages/sensors/src/gravity.ts`) is the gravity of the
WGS84 level ellipsoid after NIMA TR8350.2 (3rd edition, amendment 1). On the
ellipsoid it is Somigliana's closed formula (equation 4-1)

$$
\gamma(\varphi)=\gamma_e\,\frac{1+k\sin^2\varphi}{\sqrt{1-e^2\sin^2\varphi}}
$$

with the Table 3.4 constants γe = 9.7803253359 m/s², k = 0.00193185265241 and
e² = 6.69437999014·10⁻³. Above and below the ellipsoid `normalGravity` evaluates
the closed form in ellipsoidal-harmonic coordinates (equations 4-4 to 4-7),
which is exact for the normal field at any height in the declared envelope of
−1 km to 20 km; it also returns the component along the reduced latitude that
tilts gravity from the ellipsoid normal. The second-order series of equation 4-3
is not used: its free-air gradient is 3.5·10⁻⁵ too small at the equator, which
is already 1.04·10⁻⁸ relative at 1 km and failed the declared 10⁻⁹ budget. The
tests (`tests/gravity.test.ts`) derive γe and γp from the four defining
constants and reproduce Table 3.4, integrate Somigliana over the ellipsoid
surface to the tabulated mean 9.7976432222 m/s², and check every height against
the gradient of the closed-form normal potential, differentiated numerically in
ECEF (steps of 2 and 4 km with Richardson extrapolation; the oracle is good to
about 10⁻¹⁰): all within 10⁻⁹ relative. Normal gravity has no anomalies or
deflection of the vertical; those are TASK-108's deferred anomaly fields.

**The WMM2025 main field** (`packages/sensors/src/geomagnetic.ts`) follows the
WMM2025 technical report. The geodetic point is converted to geocentric
spherical coordinates on WGS84, the degree-12 expansion with Schmidt
semi-normalized associated Legendre functions gives the field with linear
secular variation, and the result is rotated back to the geodetic
north-east-down frame. `fieldInto` writes north, east and down components,
horizontal and total intensity, declination and inclination, and their yearly
rates into preallocated slots. Its envelope is the model's five years from
2025.0, heights from −1 km to 850 km, and latitudes off the geographic poles.
`parseWmmCoefficients` accepts only the complete WMM2025 file;
`data/geomagnetic/WMM_2025.COF` (SHA-256 `dfa85978…582f`) was taken from
pygeomag, since NOAA's site is not reachable from the build environment, and is
authenticated by reproducing NOAA's 100 test values
(`tests/fixtures/geomagnetic/WMM2025_TEST_VALUES.txt`). Y and Z agree within
2.2·10⁻⁶ nT, every rate within 10⁻⁶ nT/yr, D and I to their published
0.01°. X agrees within 7.2·10⁻⁴ nT (7.7·10⁻⁸ relative), above the 10⁻⁴ nT
declared before the implementation; the implementation's geocentric north
component equals the numerical θ-derivative of its own potential within
2·10⁻¹² relative, so the residual is not in this code. NOAA states no numeric
tolerance; the test budget is 10⁻³ nT for X, H and F and 10⁻⁵ nT for Y and Z.
Only the main field is modeled: crustal anomalies, external fields and vehicle
interference are TASK-108's, deferred in Phase 1.

**The geoid** is NGA's EGM96 15-minute grid `data/geoid/WW15MGH.DAC` (721 rows
from 90° N, 1440 columns from 0° E, big-endian int16 centimetres, SHA-256
`9dcaf4ef…5acc`). `loadEgm96Geoid` checks the bytes against the pinned hash
before decoding them into a `GridGeoid`, and `mslAccuracyGate` then reports
`AVAILABLE`. [data/geoid/inventory.json](../data/geoid/inventory.json) records
the provenance: every node agrees within 5.50 mm with OSGeo PROJ-data's
independent GeoTIFF conversion of the same NGA model, the DAC rounding to
centimetres and PROJ to millimetres (the test tolerance is 5.6 mm). EGM2008,
whose 80 MB grid is too large for the repository, is recorded with its PROJ-data
SHA-256 for a later local install; FABDEM heights refer to EGM2008, which
differs from EGM96 by up to about a metre.

**Effective conditions** (`packages/sensors/src/environment.ts`) combine these
for one location. `effectiveConditions` takes the latitude and longitude, the
ground elevation above mean sea level H, the decimal year (`decimalYearOf` a UTC
date), an optional measured QNH and an ISA temperature offset, and returns the
record that is shown and recorded (schema 1): the geoid undulation N with the
gate status, the ellipsoidal height h = H + N, the normal gravity at h, the WMM
field at h in nT with declination, inclination and the WMM zone (blackout below
2000 nT of horizontal field, caution below 6000 nT), and the air at the ground
from TASK-093's `airAtOrigin` (temperature, pressure and density, and whether the
sea-level pressure is standard or measured). The ISA formula takes the elevation
as geopotential height. Without the hashed grid N is 0, h equals H and the
record carries the blocked gate. The envelope is latitudes within ±89.9°, H from
−500 m to 9000 m (ArduPilot's home range), QNH from 870 to 1085 hPa and offsets
within ±50 K. `magneticNedGauss` gives the field as `IdealSensors` takes it.
`tests/environment.test.ts` checks the composition: each model evaluated at h,
standard air equal to ISA at H, a measured QNH that round-trips, the blocked
gate without the grid, and the blackout zone near the magnetic pole.

**In flight sessions** the conditions enter through two opt-in options, which
leave every configuration without them bit for bit as before.
`BetFlightConfiguration.gravityMps2` (and `ProfileDynamicsOptions.gravityMps2`)
sets the body integrator's gravity; `ContactOptions.gravityMps2` sets the Rapier
world's, and the contact must match the model's as before.
`BetFlightConfiguration.originAir` is the air at the ground origin: from reset the
rotors and drag meet ISA air at the CG's height above the origin every step, a
`weather.set` replaces it until the next reset, and `airActive` tells the
session so. `PhysicsSessionV2` subtracts the dynamics' `gravityMps2` in the
published specific force and publishes the dynamics' air pressure while
`airActive`, instead of 9.80665 and a sea-level origin. In
`tests/geographic-session.test.ts` an aircraft at rest on its legs at the CMAC
site publishes its local normal gravity as specific force within 10⁻⁶ m/s² and
exactly the float32 rounding of the origin air's pressure at its height, 6.6 kPa
below the former sea-level value; without the options the session publishes
exactly the former values. `node scripts/bench-flight-contact.mjs --location`
repeats takeoffs and landings there for 10⁶ steps at 0.00296 B/step with no GC
event and no native allocator call (`test-results/bench/flight-contact-location.json`),
and `node scripts/bench-physics.mjs` keeps the session step at zero allocation.

**In the application** the Weather and location tab (`apps/web/src/weather/`)
keeps one location per project in the store's local setting `weather.location`
(`LocationChoice`: a built-in site or coordinates, the ground elevation above
mean sea level, the heading, a measured QNH or the standard sea-level pressure,
and an ISA temperature offset, all inside the envelope above; the default is
ArduPilot's SITL test site CMAC, the Run tab's former fixed home). Phase 1 has
no offline map and the TASK-131 inventory holds no elevation data, so the
elevation is typed and the synthetic pad stands at any coordinates. As the form
changes, the tab shows the effective conditions from the same models the run
uses, loaded in the browser from the repository's data files (`WMM_2025.COF`
after its SHA-256 check and `WW15MGH.DAC` through `loadEgm96Geoid`) at the
current date; a saved location is the next run's home and environment. The Run
tab starts a launcher run, every run of a TASK-176 batch, and connects an
external SITL at that location: ArduPilot's `--home` is the location's
latitude, longitude, elevation and heading, the barometer parameters of
TASK-147 are generated at that elevation, the TASK-172 site parameters
(COMPASS_DEC) follow the home, and the physics Worker receives
`environment.set` (the gravity and the origin air of the conditions, refused
outside 9.7 to 9.9 m/s² or with an invalid air) before `model.load`, so
`profileModelPort` builds the profile dynamics with them. Before READY the Run
tab checks that ArduPilot's first 3D fix lies within 10 m horizontally and 5 m
vertically of the home, for a run the launcher starts as for a connection, and
stops the run with the distance otherwise. A flight task with a ground start
away from the pad flies only on a launcher run, whose physics stands the
aircraft there, so the check measures from that start. A repeat or variant
of an experiment keeps its parent's home and environment; a run from a log
(TASK-183) starts at the log's home in the conditions there, with the standard
sea-level pressure and no temperature offset, since a log does not record them
(`environmentAtHome`; outside the location envelope it flies without an
environment). A weather that keeps the air (TASK-166) and the end of a weather
return to the location's origin air, not to a sea-level origin. On the Phase 1
path ArduPilot SITL computes its own magnetic field from its declination
tables at the home; the WMM2025 field is shown and recorded for comparison and
is not written to the autopilot. Experiment payload schema 7 records the
location and its conditions as `environment` (null for a run recorded without
one), which `validateExperiment` checks for consistency with the session's
home and the location (see "Experiment record").
`tests/weather-location.test.ts` checks the setting, the envelope and the form;
`tests/browser/location.spec.ts` chooses a location through the UI alone,
compares the shown conditions with the models evaluated in Node, and finds the
saved location in the Run tab after a reload; `tests/browser/profile-dynamics.spec.ts`
sets the environment on the physics Worker and reads the location's gravity
and air back from the published state.

## Weather tab: TASK-167

TASK-167 gives the Weather and location tab its weather: steady wind by speed
and direction, the synthetic gust (TASK-032), discrete gusts, Dryden turbulence
(TASK-106) and the air at the ground from a sea-level pressure and a
temperature offset at the location's elevation (TASK-148), applied by hand
during a run or from a saved schedule. Every weather value travels as a
TASK-166 effect control, so off is absent and the session applies it on its
tick.

**The discrete gust** is the effect `wind.discrete-gust` (family
`environment`): `amplitudeMps` in m/s, 0..50; `durationS` in s, 0.1..60;
`fromDeg`, the bearing the gust blows from in degrees, [0, 360); and
`upwardDeg`, its angle above the horizontal in degrees, −90..90. Intensity i
multiplies the amplitude. Its peak air velocity in NED is

$$
\mathbf{g}=iA\,[-\cos\theta\cos\varphi,\;-\sin\theta\cos\varphi,\;-\sin\varphi]
$$

with θ = `fromDeg` and φ = `upwardDeg`, so a gust from the north blows south
and a positive angle is an updraft. Its shape is the one-minus-cosine pulse of
MIL-F-8785C 3.7.4 (CS-25.341 writes the same pulse over a gradient distance H,
with T = 2H/V), in time. On the k-th tick of the pulse, k = 0 on the tick the
control takes effect, before that tick's step, at physics rate f,

$$
\mathbf{u}_k=\frac{\mathbf{g}}{2}\left(1-\cos\frac{2\pi k}{fT}\right)\quad\text{for }k\le fT,\qquad\mathbf{u}_k=0\ \text{after},
$$

added to the wind of the CG and of every rotor hub as one uniform field: an
aircraft of a metre is small against a gust of V·T. It rises from zero to the
peak at T/2 and is back at zero at T. Switching it on again, or changing its
values, starts a new pulse on that tick; another weather change leaves a
running pulse alone; off ends it at once. Declared before the implementation:
every tick equals the formula above within 10⁻¹² m/s at 400, 800 and 1200 Hz;
the pulse at a common simulated time is the same at every rate within
10⁻¹² m/s; i = 0.5 gives half the wind of i = 1 exactly; a pulse never on is
bitwise absent; the step allocates nothing (G1).

**Air at the location.** The tab's air is the TASK-148 location's air with its
own sea-level pressure (standard or a measured QNH) and temperature offset:
`airAtOrigin` gives the `atmosphere` control's temperature and pressure at the
location's elevation, so the pressure stays consistent with the altitude.

**The weather schedule** (`packages/scenarios/src/weather-schedule.ts`,
schema 1) holds up to 64 entries of the TASK-169 form, `{control, onsetS,
durationS, recovery}`, every control of family `environment`. Time counts
simulated seconds from the first arming, as the fault schedule's does, so a
repeat meets its weather at the same point of the flight; two entries of one
effect may not overlap. It records the random streams its seeded effects draw
from, `streams: { gust: [0, 1, 2], turbulence: [0x00106001, …, 0x00106005] }`,
and a schedule with other streams is refused: its seeds would not repeat the
same realization here. The run controller sends its entries as it sends the
fault schedule's: queued 5 s ahead on their exact ticks.

**Records.** Experiment payload schema 8 adds `weather`, the run's weather
schedule or null; `weather` is an input after `conditions`, and older records
read as schema 8 with none. The effect log (TASK-169) goes to schema 2: each
entry holds the `parameters` of its control, so a weather change is logged
with its values and seeds; schema 1 logs read with `parameters: null`.

**In the application** the Weather and location tab's weather section
(`apps/web/src/weather/WeatherPanel.tsx`, the form logic in `weather-form.ts`)
offers a steady wind by speed and the bearing it blows from, the discrete gust,
the synthetic gust and the turbulence with their seeds (New seed draws a fresh
uint32), and the air at the ground from the location's sea-level pressure and
temperature offset. Each has Apply now and Turn off, which send its control to
the run going now through `SessionController.setEffect`, and Add to the
schedule, at an onset after arming and for a duration or until the end. A value
outside its range, or one the intensity would carry past it, is refused in the
form with its problem named, as the session's admission would refuse it. The
schedule is a per-project local setting (`weather-store.ts`) that the Run tab
gives every run, batch run and connection; a repeat flies its parent's. The
section lists what is in effect in the run (the last applied control of each
effect, with its values), the changes still to come and what became of each, and
the Experiments tab names a record's weather with its seeds.

**Verification.** `tests/discrete-gust.test.ts` holds the pulse to its
definition at 400, 800 and 1200 Hz and across rates, its restart, keep and off
rules, its envelope, the control's direction and intensity, and, through the
real `PhysicsSessionV2`, the wind the rotors see from the tick it takes effect,
off and zero bitwise absent. `tests/weather-schedule.test.ts` checks the
schedule's rules and streams against the models' and flies a schedule twice bit
for bit, and differently with another seed. `tests/run-controller.test.ts`
queues a schedule's changes on arming + onset and logs them with their values;
`tests/experiment-record.test.ts` and `tests/effect-log.test.ts` check the
records; `tests/weather-form.test.ts` the form; `tests/browser/weather-tab.spec.ts`
the section through the UI. `tests/browser/weather-sitl.spec.ts` sets wind on a
running native ArduCopter session, observes it in the recorded airspeed and
removes it, and checks that a scheduled discrete gust lands on its tick; it needs
the reference Mac.

## Terrain source selection: TASK-186

TASK-186 lets a run choose its ground at run time, not at build time: the
explicitly labelled synthetic level pad, or real elevation from local data. It
shows what each terrain source is, where it covers and how detailed it is, marks
what needs data, keys or a deployment as not ready, and pauses a real-terrain
run where its terrain is missing instead of substituting a plane. Automatic
region downloads are excluded: nothing is downloaded or cached.

**Source records** (`packages/terrain/src/coverage.ts`) come from the TASK-131
terrain inventory (`data/terrain/inventory.json`): each has its ID, name, kind,
layer, coverage, resolution, license and readiness. The layer distinguishes what
a source gives: `ground` (elevation a run can stand on: the synthetic pad and
FABDEM), `imagery` (imagery, land cover and the Google photorealistic tiles and
the R2 region cache, shown and never chosen as ground) and `other` (geoids,
vector features, test fixtures). Coverage is `any` for the pad, the bounding box
of the served terrain's manifest for FABDEM, and none for what has no data. The
pad is ready anywhere and offline. FABDEM, which the inventory lists as needing
data, is ready only while the local FABDEM output of
`scripts/geodata/build_terrain.py` is served at `/geodata/terrain/layer.json`
(`MIRAGE_GEODATA_DIR`, loopback only; a missing file or the application page in
its place is "not served") with a `terrain-manifest.json` whose bounding box
holds the location; otherwise the record says which of these is missing. Every
other source says why it is not ready: `Needs keys or a deployment` (the Google
tiles, R2), `Available but not wired into a run` (WorldCover), `Needs data`
(buildings, OSM), a test fixture, or not ground. The inventory gains the
`r2-region-cache` row for this.

**The choice** is a per-project local setting (`apps/web/src/weather/terrain-store.ts`,
`terrain-choice.p<project>`): `{ schemaVersion: 1, sourceId, radiusM }` with
`sourceId` `synthetic-pad` (the default) or `fabdem-elevation`, and the radius
around the home that a real-terrain run loads, 256 m to 1500 m, 1000 m by
default. A damaged setting reads as the pad.

**Quantized-mesh decoding** (`packages/terrain/src/quantized-mesh.ts`) reads the
quantized-mesh-1.0 tiles that the TASK-073 pipeline writes: the 88-byte header,
the zig-zag delta-coded u, v and height arrays, and the high-water-mark coded
triangle indices (16-bit below 65537 vertices, 32-bit otherwise, with its
alignment), each index taken modulo its width as Cesium stores it, because
encoders keep their vertices in their own order. Heights are WGS84 ellipsoidal:

```text
h = h_min + (q / 32767) (h_max - h_min)
```

A point of a tile is the triangle that contains it, interpolated
barycentrically. Declared before the implementation: decoded vertices equal the
encoder's quantized positions within one quantization step, (h_max −
h_min)/32767, and a point inside a triangle equals the plane through its three
decoded vertices within 10⁻⁹ m; a point outside every triangle of the tile, or a
tile that is not there, is missing, never zero. Found while testing against the
independent quantized-mesh-encoder package: it holds longitude and latitude in
float32 before quantizing, which moves a vertex by up to half a float32 step
(2⁻¹⁹ degrees between 32 and 64 degrees), so the budget against the plane the
fixture was written from adds the slope times that step.

**The collision lattice** (`packages/terrain/src/run-terrain.ts`) is built on
Main before a run: chunks of 129 × 129 posts 4 m apart (512 m), counted north
and east from the home, each post

```text
down = -(h(lat_home + n dlat/dn, lon_home + e dlon/de) - h_home)
```

with dlat/dn = 1/M and dlon/de = 1/(N cos φ) from the WGS84 meridian and
prime-vertical radii at the home's latitude, h from the deepest tile level
available at the post, and h_home the location's ellipsoidal height (TASK-148,
elevation plus EGM96 undulation). Chunk indices run from ⌊−r/512⌋ to
⌊(r − ε)/512⌋ on each axis for radius r, so 256 m loads 2 × 2 chunks and 1500 m
6 × 6. A chunk with any post outside the terrain's bounding box, on a tile that
is not served, or between triangles is not built: that ground is missing, with
its reason. Neighbouring chunks compute their shared posts identically, so
`CollisionChunks` accepts their seams. `latticeSha256` hashes the lattice: per
chunk, in north then east index order, its two indices as int32 and its posts as
float64, little-endian. `terrainHeightAt` gives one point's height for the tab.

**The run.** `runTerrainFor` (`apps/web/src/weather/local-terrain.ts`) turns
the choice into the run's terrain: nothing for the pad; for FABDEM the lattice
around the run's home and its record, or a refusal that names the reason (no
location, not served, the location outside the terrain, no chunk within the
radius), which stops the start before anything runs. A repeat or variant stands
on its parent's ground (the pad, or the local terrain with the parent's radius);
a batch run, a connection and a run from a log on the tab's choice. The run
controller hands the chunks to `RuntimePhysics.load`, which posts
`terrain.chunks` to the physics Worker after `environment.set` and before
`sim.configure`; the Worker stages and publishes them at tick 0 in a fresh
`CollisionChunks` (epoch 1, at most 64 chunks, 64 MiB), attaches it with
`PhysicsSessionV2.attachGround`, and answers `terrain.ready` with the count or
`terrain.reject` with the reason.

**Missing terrain.** After each step of a run with ground attached, the session
asks it whether every chunk under the square of half-side
`TERRAIN_READY_RADIUS_M` = 8 m around the vehicle's new position is published
(`readyFrom`, allocation-free, with a preallocated query). When one is not, the
session pauses on that tick through the path an accident takes (TASK-149,
TASK-156) and records in `terrainMissing` the count of such ticks, the tick, its
simulated time and the north and east position. After the compute batch the
Worker posts `terrain.missing` once per such tick; the run controller enters the
synchronized pause with reason `terrain` and keeps the first place in its view
(`terrainMissing`); ArduPilot's lockstep time stops with the physics; and the Run
tab says where the terrain ended. A run's terrain is loaded before it starts and
never streamed, so ground that is missing stays missing: Resume is refused with
that reason, and the run can only be stopped. A run already paused by its user
takes `terrain` as its reason; an accident pause keeps its own. Within the
loaded terrain the contact keeps its level plane at the home; contact on the
sloped terrain itself is TASK-187.

**Elevation from terrain.** With real terrain at the location, the Weather and
location tab shows its height there as a ground elevation above mean sea level,
the ellipsoidal height minus the EGM96 undulation of TASK-148, and for a
location given by coordinates offers it as the ground elevation, saved with the
location. FABDEM's heights were made ellipsoidal with EGM2008, which differs
from EGM96 by up to about a metre there; the tab says so.

**Records.** Experiment payload schema 9 adds `terrain`: null for the pad, or
`{ sourceId: "fabdem-elevation", layerSha256, manifestSha256, radiusM, level,
chunks, missingChunks, latticeSha256, homeHeightM }`, which needs the
environment (real terrain is built around the location) and at least one
chunk; schema 8 records read as schema 9 on the pad. `terrain` is a lineage
input after `weather`, compared by its source, data hashes and radius; the
lattice follows from them and the home.

**Verification.** `tests/quantized-mesh.test.ts` decodes the four level-14
tiles of `tests/fixtures/terrain-qm-slope/` (written from a tilted plane by
quantized-mesh-encoder 1.1, `generate.py`) within the budget above, finds every
sampled point's triangle by brute force, refuses truncated tiles and an index
beyond the vertices, and reads a 65537-vertex tile's 32-bit indices after their
alignment. `tests/terrain-coverage.test.ts` checks every inventory row's record,
the pad and FABDEM readiness, the not-ready reasons, the parsers' refusals, a
256 m lattice against the plane within the same budget with its seams accepted
and its readiness, a 1500 m lattice whose chunks outside the fixture are missing
with their reason, missing tiles and homes, and the WGS84 radii at 45°.
`tests/terrain-pause.test.ts` holds a real session to a pause on the exact tick
the ground goes missing, at the step's position, again after a resume, never
without terrain, and runs on over a lattice that holds the vehicle.
`tests/run-controller.test.ts` holds the chunks and the record of a terrain run,
the pause with its place, the refused Resume, and the reasons a pause keeps;
`tests/experiment-record.test.ts` the schema 9 record, its refusals, the schema
8 migration and the input. `tests/browser/terrain-source.spec.ts` (Chromium)
shows the section with only the loopback server contacted, the pad as the only
ground and every other source's reason; with the fixture served, FABDEM ready
at a location inside it, a refused radius, the choice saved and kept after a
reload, the terrain's height used as the ground elevation, and the lattice a
run builds in the browser equal in SHA-256 to the one Node builds; and a run
refused at a location outside it. The allocation check's session graph
(`node scripts/check-bet-runtime.mjs --allocation`) steps with a published
lattice attached. On the reference Mac, `tests/browser/terrain-sitl.spec.ts`
flies native ArduCopter on the fixture's terrain with a 256 m radius on a
straight task 700 m north and declares that the run pauses with reason
`terrain` between 504 and 504.02 m north, that Resume is refused and ArduPilot's
simulated time stands still, and that the record holds the terrain; with
`MIRAGE_GEODATA_DIR` serving the local FABDEM output it hovers on it at the area
of operation without a pause.

## Contact on sloped terrain: TASK-187

A real-terrain run's supports stand on the ground under them.
`PhysicsSessionV2.attachGround` hands the published chunks to the dynamics as well
as checking their readiness, before a run and again for a new model or rate. Each
contact step then takes one plane per support, under its anchor at the step's
attitude, and one under the CG for the hull and propeller shapes
(`TerrainContactCoupler`, TASK-065), and the rotor ground effect reads the same
planes (TASK-100). A step with no ground under a support does not run: the state
stands, and the session's readiness check pauses on that tick.

A start stands on the slope under it. `standOnPlane` turns body down onto the
slope's down by the shortest turn, keeps the heading and keeps the CG's height
along the normal, so the uphill supports do not start inside the ground; a level
plane leaves the pose as it was. On terrain, `groundClearanceM` (the third channel
of `truth.air`) is the height above the ground under the CG along its normal.

A recording holds the loads and the events. Signal 21, `truth.contact`, is each
support's normal load in newtons at its planned rate, with a presence bit for each
support the aircraft has. Signal 73, `events.contact`, is code 1, a touchdown, with
its descent speed in m/s, and code 2, a lift-off, with the peak total load since
its touchdown in newtons. What the aircraft stands on when an epoch starts is not a
touchdown: the first 0.1 s of an epoch only settles onto its supports. At most 64 events wait for the Worker's next drain, and older ones are
counted. Strikes of the hull or a propeller stay `events.accident` (TASK-149).

The limits are those of the basic approximation (F-07, F-08): one plane per support
and one for all the hull and propeller shapes, on a lattice of 4 m, no gear editor
and no landing-gear fidelity claimed. A flight task that starts more than 5 m above
or below the home on real terrain stops at the home check with its distance. The
Run tab's 3D view still draws the pad.

Declared before the first run. `standOnPlane`: body down along the slope's down
within 1e-12 and the height along the normal within 1e-9 m. A level lattice equals
level ground within 1e-9 m. Below breakaway, tan θ < μ_s: after settling, creep
under 1 cm/s, tilt within 0.5° of the slope, and the supports carrying m g cos θ
within 2 %. Above it, the acceleration down the slope is g (sin θ − μ_k cos θ) within
5 %. A drop onto a slope has no rate-dependent peak: the peak load at 400, 800 and
1200 Hz within 10 % of their mean. On native ArduCopter, on the TASK-186 fixture
with its heights scaled to 7.55°: tilt on the ground within 1° of the slope, a
landing within 0.5 m of the ground the plane gives, the resting load m g cos θ
within 5 %, a lift-off then a touchdown under 3 m/s, and no accident.

## Implemented ArduPilot JSON lockstep: TASK-041

The protocol is pinned to ArduPilot commit
fb773567896014da007bca58358704d4a0d8516f (`libraries/SITL/SIM_JSON.{h,cpp}` and
the JSON example readme; SHA-256 in `tests/fixtures/sitl/json-protocol.json`,
sources not copied). SITL sends a little-endian servo packet
`{u16 magic, u16 frame_rate, u32 frame_count, u16 pwm[N]}`: 40 bytes with
magic 18458 for 16 channels, 72 bytes with magic 29569 for 32 channels. Its
socket is unbound, so it sends from an ephemeral port to UDP 9002 and expects
the reply at that source. `frame_count` increments only after a valid reply;
an unanswered frame is resent with the same count, and a restarted SITL starts
again at 0.

`ExternalSitlLockstep` (`packages/autopilot/src/external-sitl.ts`) implements
`StepGate` for `sitl-lockstep` mode. A new count authorizes exactly one physics
tick; a duplicate never steps and is answered by `resendReplyInto` with the
identical bytes; a lower count is stale unless it is 0 (restart, which raises
`restartRequested`); a gap steps once and counts dropped frames. While no frame
is pending, `ready()` is false and the policy returns immediately, so commands
such as pause stay responsive. PWM maps to throttle through explicit
`pwmMinUs/pwmMaxUs` (MOT_PWM_MIN/MAX, default 1000/2000) and a configured
1-based motor-channel list; clamping is counted.

The reply is one line `"\n{...}\n"` with `timestamp`, `imu.gyro`,
`imu.accel_body`, `position`, `velocity`, a normalized `quaternion` (w x y z)
and optional `velocity_wind`. SIM_JSON finds keys with `strstr`, so the
encoder writes `velocity` before `velocity_wind`; without `velocity`, upstream
would silently read the wind vector as vehicle velocity. Numbers use nine
fixed decimals with `|v|<=1e6` and are written into a caller buffer without
string allocation. Timestamps must increase by less than 0.1 s, otherwise
SITL time would not advance; such states are refused.

`apps/bridge/src/ardupilot-json.ts` binds the configured local UDP port
(`ardupilotJson.localPort`, CLI `MIRAGE_ARDUPILOT_JSON_PORT`), accepts only
loopback senders and valid servo packets, learns the SITL peer from them, and
forwards them as bridge channel 3. Outbound channel-2 lines must be printable
ASCII, newline framed, at most 1024 bytes, contain the mandatory fields and an
attitude with finite values, and have no key whose text first occurs inside
another key; an invalid line closes the session. MAVLink remains a separate
channel. This module is the protocol and bridge layer; the pinned native
closed-loop ArduCopter harness is specified under TASK-042 below.

## External SITL clock ownership (TASK-129)

MirageSITL owns simulated time while it is the JSON lockstep physics peer and
the reply omits `no_lockstep`. Withholding the next servo reply leaves ArduPilot
inside `JSON::recv_fdm`. `time_now_us` advances only after a reply whose
timestamp increases by a positive amount below 0.1 s. `Scheduler::stop_clock`
is not called during that wait, so `AP_HAL::millis()` stays at the retained
simulation time. Paused wall time is excluded from simulated duration. The
retained state is unchanged, and the first resumed step is the physics step for
that same servo frame. A duplicate of the frame just accepted at release is
discarded without a second reply: `SIM_JSON` increments `frame_counter` for
every valid reply.

A manual connection is clock-compatible only in that JSON lockstep case.
TASK-153 may enable pause only then. A reply with `no_lockstep` true advances
time at the SITL loop rate while the receive returns immediately. A built-in
SITL frame model advances time itself. HITL at this pin has no `HIL_SENSOR`
handler (TASK-050) and is not a pause path.

`--speedup` paces `Aircraft::sync_frame_time` after simulated time has advanced.
The requested value and the measured simulated/active-wall ratio are both
recorded. The ratio excludes paused wall time. The model is not simplified when
the host cannot meet the request.

The firmware main scheduler does not read MAVLink while blocked in `recv_fdm`.
A parameter read or write sent during the hold is applied after resume. RC
override and a GCS heartbeat may continue on wall time; they do not advance
simulated time. The bridge ping rule above keeps a paused session that answers
pongs. Measured ratios, the 60 s ground and hover holds, and the deferred
parameter result are in [sitl-clock.md](decisions/sitl-clock.md). ArduPilot is
not modified.

## Implemented HIL streaming: TASK-049

`HilClock` (`packages/autopilot/src/hil-clock.ts`) composes integer-phase
`SensorScheduler`s on the physics clock: HIL_SENSOR at 200 or 400 Hz, HIL_GPS at
5 or 10 Hz, and magnetometer/barometer update rates that divide the IMU rate,
so their samples coincide with HIL_SENSOR messages. Sample time is the physics
tick time in microseconds as two uint32 words, never send or wall time.

`HilStreamer` (`packages/autopilot/src/hitl.ts`) encodes due samples through
`SensorMapping` and `encodeInto` into a bounded byte outbox that the serial
writer drains. `fields_updated` is `0x3f` (accel, gyro) on every HIL_SENSOR,
plus `0x1c0` (mag) and `0x1e00` (absolute/differential pressure, pressure
altitude, temperature) only on samples where those groups updated.
Construction fails unless worst-case untruncated frames (77 bytes HIL_SENSOR,
51 bytes HIL_GPS) use at most 70% of `baud/10` bytes per second: 400 Hz IMU plus
10 Hz GNSS needs 31310 B/s, which fits 460800 and 921600 baud but not 230400
or 115200. Outbox overflow latches `queue-overflow`. `acceptActuator` decodes
HIL_ACTUATOR_CONTROLS privately, requires all 16 controls in [-1,1] and a
strictly newer u64 autopilot timestamp, and copies only accepted frames;
`poll` latches `actuator-dropout` after the configured timeout (default
100 ms). Signing is unsupported, so the link is unauthenticated, and assigning
controls to motors remains a hardware-profile decision (TASK-050).

## Implemented HITL capability gate: TASK-050

`evaluateHitlCapability` (`packages/autopilot/src/hitl-capabilities.ts`)
returns READY only when pinned firmware source evidence, a verified board
profile and live observation agree; the matrix and evidence live in
[hardware/hitl-matrix.md](hardware/hitl-matrix.md). At ArduPilot
fb773567896014da007bca58358704d4a0d8516f no HIL_SENSOR/HIL_GPS/
HIL_ACTUATOR_CONTROLS handler exists, so ArduPilot is UNSUPPORTED for this
path. At PX4 4d7e4de77742c3ae8187ffc998ed6d04629c611b HIL_SENSOR is decoded only
in HIL mode, so the live check requires `MAV_MODE_FLAG_HIL_ENABLED` (32) in
HEARTBEAT base_mode, the profile's firmware git SHA, and HIL_ACTUATOR_CONTROLS
within 100 ms. Anything missing yields BLOCKED_EXTERNAL with the exact
requirement. READY verdicts are frozen and registered privately;
`AutopilotSession.connect("hitl", ...)` now requires one, so a hand-made object
or SITL availability cannot enable HITL. No board is verified yet.

## ArduPilot bench: TASK-051 (version 2 proposal)

TASK-051 is deferred from version 1. The version 2 proposal is to produce an
ArduPilot 4.6.3 or newer firmware image, using Hybrid SITL and
Simulation-on-Hardware, that can be loaded on the drone and tested there.
PX4 is out of scope. The analyzer and virtual JSON prototype below are kept
as design notes. They do not block TASK-082 and they do not select the
application backend. See [V2_PLAN.md](V2_PLAN.md).

The recorded-board rules, retained for that later firmware, are: `env SIM_ENABLED 1`,
`AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539, and `SIM_OH_MASK`
in 0..65535, with props removed. A board using `AP_SIM_JSON_ENABLED` is Hybrid
SITL placement `board`. The no-drone prototype is `scripts/run-virtual-hitl.mjs`.
See [hardware/hitl-test-procedure.md](hardware/hitl-test-procedure.md).

## Implemented position-step spoofing: TASK-054

`PositionStep` (`packages/ew/src/position-step.ts`) schedules an NED offset of
at most 10 km for a physics tick; `advanceTick` applies all three axes at once
when that tick is reached, and `disable`/`reset` return the exact baseline.
`GpsOffsetApplier` re-origins one reusable `LocalTangentFrame` at the source
fix (`setOrigin`, allocation-free), converts MSL to ellipsoidal height with the
geoid (`h=H+N`), moves the fix by the offset through ECEF, and converts back
(`H'=h'-N'`). The offset is defined in the fix's tangent plane, so long
horizontal offsets also raise ellipsoidal height by roughly `d²/(2R)`; a pure
Down offset changes MSL altitude by exactly `-D`. Velocity, time, DOP, fix and
course are preserved; a zero offset is an exact identity. The source sample is
never modified; an invalid source leaves the target untouched.

## Implemented coherent drift: TASK-055

`VelocityDrift` (`packages/ew/src/velocity-drift.ts`) integrates `b` and
`v_d` with the section 5 equations on every physics step (`dt` in (0, 0.01] s),
exact for constant acceleration. When `|v_d+a dt|` would exceed `maxSpeedMps`,
the step is split at the root of `|a|²t²+2(v·a)t+|v|²-cap²=0`, integrated to
that time, and continued at constant velocity, so `b` remains the integral of
`v_d` and velocity is never clipped after the fact. `hold-offset` recovery
decelerates `v_d` at `decelMps2` while integrating `b`, splits the step at the
stop time and then holds; `step-to-truth` zeroes `b` and `v_d` and increments
`discontinuities` for the AAR event. At the 10 km envelope the drift stops and
holds. `distortGpsInto` adds `b` through `GpsOffsetApplier` (WGS84 and geoid)
and `v_d` to the GPS velocity, then recomputes course from the corrupted
horizontal velocity (unknown below 0.05 m/s). GNSS sampling and rendering
never change the drift state.

## Implemented EW pipeline composition: TASK-058

`EwEngine` (`packages/ew/src/engine.ts`) owns one preallocated instance of
each effect and a 16-slot fault registry keyed by `faultId`. `apply(fault.set,
tick)` runs at the tick boundary (`PhysicsSessionV2.applyScheduled`, through an injected `SessionFaultPort`) without
allocation. The live Worker owns one `EwEngine` behind `createSessionFaultPort` (`packages/ew/src/session-port.ts`), the same port its tests drive; the port owns no motor table. The session builds a `MotorFaults` table with motor IDs 0..rotorCount-1 of the active dynamics only when that dynamics reads one (`SessionDynamics.useMotorFaults`), binds it through `SessionFaultPort.bindMotors`, and rebuilds it whenever `sim.configure` replaces the dynamics; without a table, motor-loss is rejected at admission. `EwEngine` fixes its table at construction, so the port builds a new engine around each bound table and keeps the seed; binding happens only when a fault-free epoch starts. A session constructed without that port still rejects `fault.set`. `weather.set` stays rejected because the demo has no wind model. Each effect kind has one owning faultId (per motor for
`motor-loss`); a newer faultId replaces the owner, disabling a non-owning or
unknown faultId changes nothing, and a full registry returns `registry-full`.
A faultId owns at most one effect. Enabling a faultId that owns another effect
kind, or another motor for `motor-loss`, moves it (TASK-125): the new effect
engages first, then the effect it owned is released with the new command's
`recovery` (only drift distinguishes the two policies), so a later disable of
the new effect leaves nothing behind. When the new effect cannot engage, the
command returns `rejected` before the registry or any effect changes. The
instructor console relies on this: it keeps one fault ID while its effect
select changes.
The session reports `registry-full` as a final OVERLOAD reject and a kernel
`rejected` as a final OUT_OF_RANGE reject, never as applied, and then faults
(TASK-124). Disabling drift uses the command's `recovery`; motor-loss is
forwarded to the bound `MotorFaults` table and never touches observations.
`reset(seed)` clears every effect, the registry and motor faults;
`sim.configure` calls it with the seed of the last `sim.reset`. `flags`
reports the state ABI `ew_flags` bits.

`advanceInto(context)` advances jamming and drift on every physics step.
`distortGpsInto` composes baseline -> position step plus drift (the summed NED
offset in one WGS84 conversion, then drift velocity and course) -> jamming
(satellites, DOP, fix, applied in place). `distortImuInto` changes only the
magnetometer. `SensorPipeline` (`packages/sensors/src/pipeline.ts`) applies a
structural distorter and then quantizes with `SensorMapping`, so the order is
baseline -> EW -> quantization and the baseline is never modified.

V8 boxes float arguments of non-inlined calls, so the high-rate path passes
floats through typed arrays or object fields: geodesy exposes
`geodeticToEcefFromInto`, `ecefToGeodeticFromInto`,
`LocalTangentFrame.setOriginFrom/nedToGeodeticFromInto/...`, geoids expose
`undulationFromInto`, `GpsOffsetApplier.applyFromInto` takes the offset array,
and drift/jamming read `dtS` from the step context (`advanceFrom`). Scalar
signatures remain as low-rate conveniences. `apply` follows the same rule for
tick-boundary commands (TASK-126): `MagneticAnomaly.configureFrom` reads the
command's rotation and bias arrays and reconfigures in place,
`PositionStep.scheduleFrom`/`advanceTickFrom` read the offset array and take
the tick from a one-element `Float64Array` (past 2^30, the V8 small-integer
limit under pointer compression as in Chromium, a tick is a heap number),
`MotorFaults.setFromArray` reads the remaining thrust fraction from
one, and drift enables reuse one engine-owned preset. The kernels read array
elements by index, because array destructuring boxed non-integer elements.
`configure`, `schedule`, `advanceTick` and `set` remain low-rate conveniences.
`tests/ew-pipeline.test.ts` applies 1e6 commands of every effect, with
non-integer parameters, re-targeting and ticks past 2^32, and requires a
GC-free window next to an allocating control.


## Thermal, diagnostics and recording contracts (TASK-043/070–078/081)

### Surface thermal energy (TASK-070)

`HeatSurface` is a synthetic lumped surface model, advanced outside the 400–1200 Hz physics loop and outside shaders. `ThermalMaterial` defines areal heat capacity C_A (J/m2/K), solar absorptivity alpha and emissivity epsilon [0,1], convection h and substrate conductance k_A (W/m2/K). Forcing contains air/sky/substrate kelvin and incident solar W/m2. Absorptivity and emissivity are independent spectral-band properties. WorldCover classes do not supply these coefficients or measured temperatures.

\[
C_A\frac{dT}{dt}=\alpha G-h(T-T_a)-\epsilon\sigma(T^4-T_{sky}^4)-k_A(T-T_b),\quad
\sigma=5.670374419\times10^{-8}\;\mathrm{W\,m^{-2}\,K^{-4}}.
\]

\[
L(T)=\int_{8\,\mu m}^{14\,\mu m}\frac{2hc^2}{\lambda^5[\exp(hc/(\lambda k_B T))-1]}\,d\lambda,
\quad L_o=\tau[\epsilon L(T)+(1-\epsilon)L(T_r)]+(1-\tau)L(T_a),\quad\tau=e^{-\kappa d}.
\]

Advance with implicit trapezoidal integration: solve the monotone scalar residual by 48 bisection iterations on 100..1000 K. Reject an unbracketed result instead of clipping energy. dt is (0,60] s, forcing temperatures 100..1000 K, incident sunlight 0..2000 W/m2. There is no AO temperature multiplier. Direct solar incidence uses the ENU solar vector: east=-cos(delta) sin(H), north=cos(phi) sin(delta)-sin(phi) cos(delta) cos(H), up=sin(phi) sin(delta)+cos(phi) cos(delta) cos(H). Multiply direct-normal irradiance by max(0,n dot sun) and geometric shadow transmission; sunlight is zero below the horizon. Angles are radians; supplied normals must be unit length. Astronomical declination/hour angle come from the scenario rather than wall-clock time.

`ThermalField` integrates the same balance for many surface elements at once, without allocation, using Heun steps with automatic substeps below the linearised stability limit. Its forcing is a sun direction (ENU) with direct-normal and diffuse-horizontal irradiance; each element has a unit normal, a direct-beam shadow fraction and a sky-view factor V. Sky longwave is eps_sky sigma T_a^4 with Swinbank clear-sky emissivity 9.2e-6 T_a^2 and Bolz cloud factor (1 + 0.22 N^2), capped at 1; the occluded fraction 1 - V radiates at air temperature, so ambient occlusion only weights explicit radiation. Convection is h = 5.7 + 3.8 v (McAdams). `solarPosition` computes the sun from UTC and latitude/longitude with the NOAA/Meeus series (checked against NREL SPA within 0.05 degrees); `clearSkyIrradiance` uses Kasten-Young air mass, Meinel DNI = S0' 0.7^(AM^0.678) with S0 = 1361 W/m2 and the Spencer eccentricity, diffuse = 0.1 DNI, and the Kasten-Czeplak cloud factor 1 - 0.75 N^3.4. Tests cross-check ThermalField against HeatSurface and solarIncidence against the ephemeris. Typical surface properties are uncalibrated synthetic values.

Evapotranspiration (TASK-073 P5) subtracts a big-leaf Penman-Monteith latent flux LE from the `ThermalField` balance for elements whose properties carry a bulk surface resistance r_s (s/m); elements without r_s do not evaporate. T_c is the surface temperature in degrees C, RH the weather's relative humidity (0.5 when absent), P its pressure (101325 Pa when absent; `weatherFrom` takes it from the atmosphere), rho c_p = 1.2 x 1005 J/m3/K, e_s and gamma from FAO-56 (eqs. 11 and 8). Dew (negative LE) is not modelled. By default r_a = rho c_p / h, so sensible and latent heat share the McAdams transfer; an element with a canopy height H uses the FAO-56 log profile (eq. 4) with d = 2/3 H, z_om = 0.123 H, z_oh = 0.1 z_om, k = 0.41, wind taken at z = H + 2 m and floored at 0.5 m/s, and h = rho c_p / r_a then also replaces McAdams for sensible heat. Typical values: grass and crops r_s = 70 s/m (the FAO-56 reference surface), tree canopy r_s = 100 s/m (assumed, well-watered, uncalibrated) with H = 10 m, open water r_s = 0. The substep bound adds (rho c_p / gamma) de_s/dT(400 K) / (r_a + r_s). The weather-dependent h and latent coefficients are refreshed by `setWeather`, and the step passes the surface temperature through a preallocated array, so stepping stays allocation-free.

\[
LE=\frac{\rho c_p}{\gamma}\,\frac{\max\left(0,\;e_s(T)-RH\,e_s(T_a)\right)}{r_a+r_s},\quad
e_s(T)=610.8\exp\frac{17.27\,T_c}{T_c+237.3}\ \mathrm{Pa},\quad
\gamma=0.665\times10^{-3}P,\quad
r_a=\frac{\ln\frac{z-d}{z_{om}}\,\ln\frac{z-d}{z_{oh}}}{k^2u}.
\]

### Synthetic LWIR rendering (TASK-071)

`InstrumentProfile` carries an ID, native resolution (16..4096 per axis), spectral band in micrometres (flat response inside the band), NETD in kelvin and a calibration source that is synthetic (with a note), approximated from public data sheet values (instrument name, citations and a note; TASK-073 P5, e.g. `BOSON_640_50DEG`) or measured (instrument name plus SHA-256 of the calibration data); optional fields give the frame rate and the selected lens (focal length, horizontal field of view). `claimsParityWith` is true only for a measured profile of that instrument; the shipped `synthetic-lwir-640` profile (640x512, 8-14 um, NETD 0.05 K) claims no parity with CADEX or any other instrument. `ThermalScene` holds reflected and air (path) temperature, the extinction coefficient per metre and the display span.

The CPU integrates Planck radiance over the band with composite Simpson (512 intervals, exact SI h/c/k_B) into a float32 table in 1 K steps over 150..405 K; radiance is W/(m2 sr). The table is uploaded once as a texture. `shaders/thermal.glsl` (GLSL ES 3.00) reads a float G-buffer (surface kelvin, emissivity, range metres), interpolates the table, applies emission, reflection and Beer-Lambert attenuation, maps radiance linearly between the span radiances to a clamped level and applies the white-hot, black-hot or ironbow palette; optional NETD noise uses an integer hash of pixel coordinates and a per-frame seed. `ThermalCameraPass` renders into a target at the profile's native resolution; there are no CPU pixel loops per frame. With a supersample factor S (1..4; TASK-073 uses 3) the G-buffer is S times the sensor resolution and each sensor pixel averages the apparent radiance (not the temperature) of its S x S subsamples, modelling detector-area integration; the per-detector fixed-pattern and NETD offsets apply to every subsample, and S = 1 is the point sample above. `apparentTableRadiance`/`levelFromRadiance` mirror one subsample and the averaged level. `ThermalCameraNodePass` (`thermal-node.ts`, TASK-073 P6) is the same pass as a three.js TSL node material for WebGPU; it reads float textures with `textureLoad`. `apparentRadiance`/`apparentLevel`/`paletteColor` are the float64 CPU mirror used by tests, and the browser test compares the shader with it pixel by pixel. Both passes are checked against the CPU mirror in the browser (WebGPU on the RTX 4050); there is no cross-GPU pixel equality or target-device FPS claim.

### Shutter and NUC (TASK-072)

`ThermalNuc` owns fixed output, bias and accumulation arrays. Configuration specifies pixels, frameHz, intervalFrames (start-to-start), closedFrames, calibrationFrames and openFrames. Frame IDs must be consecutive safe integers; reversed/skipped/invalid frames are rejected without advancing status. A request starts on the next sensor frame. Display interruption lasts exactly the sum of the three configured phase lengths. During calibration, mean(raw-referenceK) estimates each pixel's additive fixed-pattern bias; the completed correction becomes raw-bias. Idle frames refresh output; shutter phases hold the last displayed image while sensor timestamps continue as frameId/frameHz. Calibration never accepts physics or recorded truth as an input. This is an offset-only synthetic calibration; gain drift and measured shutter radiometry remain outside the profile.

### Autopilot diagnostics and warmup (TASK-043)

`EkfMonitor` consumes CRC-validated MAVLink2 HEARTBEAT (ID 0, CRC_EXTRA 50, length 9) and ArduPilot EKF_STATUS_REPORT (ID 193, CRC_EXTRA 71, length 26 including optional airspeed variance). Both are independently generated from ardupilotmega XML at the existing pinned MAVLink commit using pymavlink 2.4.50; the new fixture records recursive XML and generated-module hashes. HEARTBEAT custom_mode is u32 at 0, autopilot at byte 5 must be 3, mavlink_version byte 8 must be 3. EKF ratios are five f32 at 0/4/8/12/16; flags are u16 at 20; the airspeed extension begins at 22. The conservative training gate requires finite nonnegative ratios below 1 and rejects EKF_UNINITIALIZED (1024). Raw flags 1/2/4/16/32 map to ABI-v2 flags 1/2/4/8/16. Relative horizontal position never substitutes for absolute position. Only the configured system/component identity is admitted. TASK-074 copies accepted system/component 1/1 frames from the browser serial decoder into a preallocated `MavFrame` and overlays that `EkfMonitor` snapshot on the Main-thread `FlightStateV2` read by `PilotHud`. The physics Worker publication keeps `AutopilotStatusValid` clear. A USB serial grant, the 1000 ms freshness window, or displayed EKF flags do not admit browser READY, HITL, or `EkfWarmup`.

Timestamps use simulation milliseconds for SITL and monotonic wall milliseconds for HITL. Heartbeat and EKF age must each be at most 1000 ms and never in the future. `EkfWarmup` additionally requires 30 simulated seconds, matching epoch, no clock reversal, IMU age <=0.01 s and GNSS age <=0.3 s with no future sample. It reports measured simulated/wall elapsed ratio; configuring speed does not itself accelerate firmware. HITL rejects speed !=1 and observed simulation elapsed exceeding wall elapsed by 1% plus 0.1 s. EW admission remains false until the gate passes and falls false when health fails.

`LiveEkfWarmup` composes the CRC-validating `MavParser`, identity-bound `EkfMonitor` and `EkfWarmup` in the Linux driver. It defaults to MAVLink sensor clocks and additionally supports explicit external-SITL json-lockstep IMU acknowledgments. Sensor messages GPS_RAW_INT (24, CRC 24, length 52), RAW_IMU (27, CRC 144, length 29) and HIGHRES_IMU (105, CRC 93, length 63) have independent pymavlink 2.4.50 wire goldens registered with source/generator hashes. Boot microseconds use safe numeric u64 conversion; GPS requires a 3D fix. Only system/component 1/1 and the primary IMU are admitted. Classes use explicit constructor fields so the cold Linux Node 24 tool can load the same modules.

The native sensor feed is the 800 Hz JSON reply, not a MAVLink report arrival. `acknowledgeJsonImu(servoFrame, repliedFrame, sampleTimeS)` requires N/N-1, contiguous frame counts, increasing actual encoded sample time and a step no larger than 0.01 s. The driver supplies the previous reply timestamp only after the next valid servo packet confirms consumption. Bad acknowledgments invalidate the sensor. HITL cannot select this source. Firmware IMU report clocks remain separate diagnostics: their packet cadence/serialization epoch must not be silently fitted or substituted for the actual sample clock. GPS uses the pinned `AP_GPS` `last_fix_time_ms` carried by CRC-checked GPS_RAW_INT. Freshness limits remain unchanged: IMU <=0.01 s, GNSS <=0.3 s, heartbeat/EKF <=1 s, no future times, 30 simulated seconds, matching epoch and healthy finite innovations below 1.

The sidecar records original wire bytes with each decoded observation and requests 3 ms HIGHRES_IMU and 50 ms GPS_RAW_INT reports. At the pinned 400 Hz scheduler, a 2500 us request truncates to 2 ms and is denied by `cap_message_interval`; 3 ms is accepted. This is a stream configuration fix, not relaxed admission. The driver evaluates readiness on physics ticks and writes `warmup.ndjson` at 100 Hz plus every transition, including source clocks, exact wall elapsed, normalized health, READY/EW flags, reason and measured acceleration. Unknown diagnostic age serializes as null before the first report and cannot pass.

`scripts/check-ekf-warmup.mjs` replays all original physics acknowledgments and raw-CRC-audited telemetry through the same modules and checks every recorded decision. The stream event at physics time t follows that completed tick; replay feeds only events with `receivedSimS<t` before evaluating the next tick. It records actual admission/revocations separately from explicitly synthetic failed-innovation, stale-diagnostic, bad-acknowledgment, GNSS-loss, clock-reversal, disposal and HITL fast-forward probes. The report is `test-results/validation/task-043-warmup.json`. The observed run admits at 41.27625 simulated seconds and 20.733261598 wall seconds (1.990822804x); two genuine GNSS freshness excursions beyond 0.3 s revoke READY/EW and recover on fresh data, and the full flight passes the unchanged TASK-042 envelope. Browser READY, recorded Simulation-on-Hardware and TASK-033 aerodynamic fidelity remain separate.

### AAR record format and ownership (TASK-076)

```typescript
interface AarManifest {
  formatVersion: 1;
  recordBytes: 512;
  modelSha256: string;
  firmwareSha256: string | null;
  seed: number;
  physicsHz: 400 | 800 | 1200;
  recordHz: number;
  durationS: number;
  clock: "simulation";
  source: "demo-decimated" | "producer";
}
interface ArchiveLoss {
  queueLost: number;
  evicted: number;
  storageDropped: number;
}
```

The parser rejects unknown fields, malformed hashes, unsafe seed/rates, more than 1800 s, and a computed ring above the 32 MiB archive budget minus 8192 bytes. Default 10 Hz x 1800 s x 512 bytes gives exactly 9,216,000 ring bytes. A separate 131,136-byte SAB is used solely for recording, never as another consumer of flight sensor/actuator queues. Header: bytes 0 magic 0x4d415251, 4 version 1, 8 write counter, 12 read counter, 16 full/drop counter; bytes 20..63 reserved zero. Capacity is 256 records of 512 bytes. Every shared int32 word is accessed atomically. The producer copies a complete private record then publishes the modular write counter; the consumer copies before releasing read ownership. A full queue drops new data and increments its counter without blocking physics. Queue creation/binding occurs outside stepping.

| Byte offset | Type | Field / units |
| ---: | --- | --- |
| 0 | u32 | magic 0x4d415252 |
| 4 | u32 | record version 1 |
| 8 | u32 | stride 512 bytes |
| 12 | u32 | session epoch |
| 16 | u32[2] | tick lo/hi |
| 24 | f64 | simulation seconds |
| 32 | f32[4] | roll, pitch, yaw [-1,1], throttle [0,1] |
| 48 | u32 | flags: truth=1, pilot=2, sensor=4, actuator=8, event=16, decimated=32 |
| 52 | u32 | numeric event registry ID; 0 means none |
| 56 | u32 | missing recording samples since preceding accepted sample |
| 60 | u32 | CRC-32/ISO-HDLC, excluding bytes 60..63 |
| 64 | bytes[192] | StateCodecV2; zero seqlock/reserved words |
| 256 | bytes[128] | SensorFrameCodecV2 or all zero when absent |
| 384 | bytes[128] | ActuatorFrameCodecV2 or all zero when absent |

Nested payloads retain ABI-v2 units and frames. Missing payloads are zero and their present bit is clear; decoders reject inconsistent epochs, header/time/tick mismatches, nonfinite values, reserved bits and failed CRC. Event code zero means absent; nonzero codes require the event-present bit and are interpreted by the scenario registry. No prose or secrets enter the record.

The recorder Worker drains at most 256 records per 10 ms poll into a preallocated chronological ring and 64-record (32768-byte) chunks. IndexedDB uses a fixed key ring with ceil(ringBytes/32768) keys and one transaction in flight; chunks written while it is busy wait in a bounded pending list (8 by default) and are written in order. Overflow of that list, oversized chunks and failed transactions are counted in exact bytes/records; ring eviction, invalid records and producer loss are separate. Quota/storage failure leaves an explicitly reported memory-only ring. Session databases are uniquely owned and deleted on orderly close; the host requests shutdown and terminates after a bounded fallback. Browser crashes may leave orphaned session databases; no recovery catalogue or reload-resume claim is made. Snapshot requests copy bounded data outside the physics loop and have a timeout.

The application records every physics tick from the physics worker into the recording handoff. The record contains truth and the pilot input used for that tick. Sensor and actuator payloads are copied only from frames that tick already owns; the session is the only consumer of the sensor queue while recording, and it never attaches a second consumer to a flight queue. A full handoff drops the new record and counts the loss. The manifest source is `producer` and `recordHz` equals the physics rate. Duration is capped so `recordHz * durationS * 512` stays within the 32 MiB archive budget minus 8192 bytes, which is below 30 minutes at 400/800/1200 Hz. Charts still decimate a series to at most 10000 points. The demo model hash is SHA-256 of its dynamics source; firmware hash is null.

### Replay, response charts and archives (TASK-077/078/081)

Snapshot replay validates all records and keeps a private copy, rejects repeated epoch segments and regressing ticks/time reversals, and seeks at/before a requested simulation time inside one epoch. It never interpolates across reset/gaps. Resimulation is a separate injected backend: model/firmware hashes and seed must match and reset must resolve the configuration. Position Euclidean error and quaternion q/-q angular error produce PASS/FAIL with maxima/counts using caller-declared tolerances. Missing provenance, empty runs or differences never rewrite records; no default production resimulator is supplied.

Charts share simulation seconds and an explicit selected epoch. Pilot roll, actuator channel 1 and body roll-rate rad/s are displayed separately; unknown actuator channels break the curve. A missing-sample counter, epoch change or time interval over 1.5/recordHz breaks a segment. At most 10000 points are emitted using endpoints and pilot/response extrema per bin; bins containing omitted gaps conservatively break reduced segments. A 30 minute synthetic step-response checks lag and a narrow spike checks decimation. Charts do not change the live flight.

Archives are uncompressed and at most 32 MiB. The 64-byte header has u32 magic 0x4d415241 at 0, version 1 at 4, metadata byte length at 8 (<=4096), record count at 12, payload bytes at 16 (=count*512), producer loss at 20, eviction at 24, storage loss at 28, and 32 SHA-256 bytes at 32. UTF-8 manifest JSON starts at 64, followed immediately by records. SHA-256 covers the entire archive with bytes 32..63 treated as zero. Import checks size/version/length multiplication before bounded copies, then hash, manifest allowlist and all records. No compression means no decompression bombs. Arbitrary metadata, API keys/tokens and serial identifiers are unconditionally excluded rather than optionally retained. Export/review show size, source categories and counters. Imported snapshots stay separate from the active model.

Thermal coefficient validity envelope: areal heat capacity 1..1e9 J/m2/K; convection and substrate conductance 0..1e5 W/m2/K. These bounds exclude overflow/underflow configurations before integration.

Regression hardening: PhysicsSessionV2 now captures wall receipt time after the coherent pilot read, preventing a concurrent valid publication from appearing future-dated, and accepts samples stamped up to `INPUT_CLOCK_TOLERANCE_MS` = 1 ms ahead because Main and the Worker round their wall clocks from separate time origins (TASK-073); inputs further in the future or stale still disarm. WebGPU capability probing is shared once per document (including in-flight work); reload retries after driver changes. Renderer tests use an isolated harness and compare diagnostics within one document. Instructor motor loss selects channel index, power-cut versus synthetic instant-thrust-loss and remaining fraction; pending epoch-changing commands await their matching ACK even when the shared header advances first.

Multiple sensor/event records may share a physics tick with identical simulation time; replay preserves their receipt order. Resimulation backends must advance to the requested tick rather than stepping again for each observation record.

Export redaction is configurable: the default rejects undeclared metadata; omit-extra-metadata copies only the declared manifest fields and discards all other values, including API keys and serial identifiers. Neither policy can retain secrets. Import remains strictly allowlisted.

```typescript
type ArchiveRedactionPolicy = "reject-extra-metadata" | "omit-extra-metadata";
export declare function exportArchive(
  manifest: unknown,
  records: Uint8Array,
  loss?: ArchiveLoss,
  redaction?: ArchiveRedactionPolicy,
): Promise<Uint8Array<ArrayBuffer>>;
```

## NASA TM X-3561 measured drop comparison (TASK-029/033)

Three Docling extractions of NASA/NACA landing-gear reports are archived
byte-exact (CRLF line endings) under `tests/fixtures/contact/nasa/`.
`.gitattributes` marks them `binary`. `scripts/check-docs.mjs` treats
Markdown under `tests/fixtures/` as raw fixture data, so it does not need a
documentation pair. The Cyrillic check still applies.

| Archive | Report | NTRS id | SHA-256 | Used |
| --- | --- | --- | --- | --- |
| `nasa-tm-x-3561.md` | NASA TM X-3561, Fasanella, McGehee, Pappas, Langley, November 1977 | 19780003109 | `8cf5d33d1d2afbd4a28af064901fcf82910dad25e9e3ce916b2249e5d12c4c39` | Yes: level-surface vertical drops |
| `nasa-tp-2353.md` | NASA TP-2353, McGehee, September 1984 | 19840024308 | `1a2a73a922c4b76b174968a554e7390c5e5d717322965ff959c056655b6b3aad` | No: drop results exist only as figure images |
| `naca-report-1248.md` | NACA Report 1248, Milwitzky, Lindquist, Potter, 1955 | 19930092250 | `e49485f4d8a44c151f09b39fff8c67fbb2fbf8441fb5aa19566ec5c1594630ba` | No: forward-speed spin-up on a 15-degree gear; per-test values are in figures |

Each reference resolves as `https://ntrs.nasa.gov/citations/<NTRS id>`. The
TM X-3561 NTRS id comes from the supplied file name, because the Docling text
omits it.

`python3 -I tests/fixtures/contact/generate_nasa_drop.py` (standard library
only) works in five steps:

1. Verifies all three archive hashes.
2. Normalizes CRLF for parsing.
3. Requires every quoted sentence or table row to match exactly once.
4. Converts the U.S. Customary values to SI. The report states that it measured
   in these units; its own rounded SI value is kept as a `printedSi` cross-check.
5. Writes `tests/fixtures/contact/nasa-drop.json` (12,834 bytes, SHA-256
   `62adb81b0a56b5e50a921db0e26d154501b0e4e83a58cfc2f22fed571bc69207`).

`--check` fails if that file is stale, and `tests/fixtures.test.ts` runs it.
Figures are not digitized, and nothing is interpolated or extrapolated. The
generator also checks the quoted 6.7 in free-fall height against the 6 ft/s
impact speed.

The conversion factors are exact: ft = 0.3048 m, in = 0.0254 m,
lbm = 0.45359237 kg, lbf = 4.4482216152605 N, psi = lbf/in^2 and
g = 9.80665 m/s^2.

| Quantity | Source value | SI value | Report SI |
| --- | --- | --- | --- |
| Drop mass (mass acting on gear) | 3280 lbm | 1487.7829736 kg | 1490 kg |
| Hub mass (wheel, tire, piston) | 55.7 lbm | 25.265095009 kg | 25.3 kg |
| Honeycomb crush force (lift simulation) | about 3600 lbf | 16013.5978149 N | 16.00 kN |
| Unloaded tire diameter / radius | 1.81 ft | radius 0.275844 m | 0.552 m diameter |
| Tire width | 0.5735 ft | 0.1748028 m | 0.175 m |
| Tire inflation, gauge | 60 psig | 413685.43759 Pa | 414 kPa |
| Strut charging pressure, gauge | 278 ± 10 psig | 1916742.5275 ± 68947.6 Pa | 1917 ± 69 kPa |
| Maximum strut stroke | 0.75 ft | 0.2286 m | 0.229 m |
| Impact (sink) speed, three drops each | 4 / 5 / 6 ft/s | 1.2192 / 1.524 / 1.8288 m/s | 1.2 / 1.5 / 1.8 m/s |
| Maximum strut stroke, level surface | 2.2 / 3.7 / 4.4 in | 0.05588 / 0.09398 / 0.11176 m | 5.6 / 9.4 / 11.2 cm |
| Upper-mass acceleration bound (all level cases) | does not exceed -1.6 g | >= -15.69064 m/s^2 | -1.6 g |
| Honeycomb rebound time, 4 ft/s | 0.15 s | 0.15 s | 0.15 s |

The source's accelerations are positive downward, so they map directly to NED
down. The -1.6 g value is the 6 ft/s maximum and bounds all three cases. The
5 ft/s stroke comes from the level-surface reference drops in the
inclined-surface series. Accelerometers were filtered flat to 100 Hz; the
report does not state the filter order.

### Registration and adapter

`tests/fixtures/registry.json` registers `contact/nasa-drop.json` as
`nasa-tm-x-3561-drop-v1` with `formatVersion` 1 and the SI units above. The
finite validity envelope covers the measured range. The tolerance is
`{absolute: 0.002, relative: 0.1}`, declared from the source before evaluation:

* the absolute value is penetration in meters, twice Rapier's default allowed
  linear error;
* the relative value is 10 percent on the measured envelopes.

Provenance is measured, with no derivation:

```json
{"kind":"measured","datasetId":"NASA-TM-X-3561-DropTest","license":"Public-Domain-US-Gov","acquiredAt":"1977-11-01T00:00:00Z","referenceUrl":"https://ntrs.nasa.gov/citations/19780003109"}
```

Measured provenance now uses `referenceUrl` (HTTPS) in place of the earlier
`reference` key, which no measured fixture used. `acquiredAt` is the report
date, because test dates are not stated.

`packages/physics/src/nasa-drop.ts` validates the payload and its units, then
drives the real `GroundContact` (Rapier 0.21.0) at 400/800/1200 Hz for 0.3 s
per case:

* the lumped drop mass is a sphere of the unloaded tire radius, touching the
  plane at t = 0 with the measured sink speed;
* the honeycomb force acts upward while descending (the report: it is "on"
  while crushing and falls to zero at rebound);
* restitution is 0.

Checks:

* **Impulse:** the reported contact impulses balance m·Δv minus the harness's
  own gravity and lift within 1 percent of m·v0. The compression impulse
  arrests m·v0 within 10 percent. This is a solver-consistency check, not a
  measured comparison.
* **Nonpenetration:** maximum penetration is at most 0.002 m.
* **Energy:** after arrest, the rebound speed is at most (e + 0.01)·v0.
* **Deceleration envelope:** both the most negative per-step acceleration and
  its 10 ms moving average (matching the 100 Hz instrument bandwidth) stay at or
  above -1.6 g × 1.1.
* **Stroke envelope:** the model's contact travel is within 10 percent of the
  measured strut stroke.

### Result (2026-10-16)

| Case | Measured | Step peak, 400/800/1200 Hz | 10 ms window | Contact travel | Measured stroke |
| --- | --- | --- | --- | --- | --- |
| level-4fps | >= -1.6 g | -49.8 / -99.5 / -149.3 g | -12.43 g | 0.11 / 0.09 / 0.07 mm | 55.9 mm |
| level-5fps | >= -1.6 g | -62.2 / -124.4 / -186.6 g | -15.54 g | 0.14 / 0.11 / 0.09 mm | 94.0 mm |
| level-6fps | >= -1.6 g | -74.7 / -149.3 / -223.9 g | -18.65 g | 0.16 / 0.13 / 0.11 mm | 111.8 mm |

The impulse, nonpenetration and energy checks pass in all nine runs. For
example, the arrest impulse is 2720.4 N·s at 400 Hz against m·v0 = 2720.9 N·s,
and the balance error is below 1e-4 N·s.

Both measured envelopes **fail** in every run. The rigid sphere arrests the
sink within a few steps, so its peak scales with the step rate, and it has no
tire or strut degree of freedom. The NASA contact fidelity gate is therefore
FAIL, not PASS. Passing it needs a landing-gear model with tire force-deflection
and an oleo-pneumatic strut, validated without fitting to these same
envelopes.

The fixture and archive document the gear (orifice and piston areas, volumes,
charging pressure). The tire equation and orifice discharge relations, however,
are `formula-not-decoded` in the Docling text, so they are not invented here.

Per the 2026-10-18 user scope decision, NASA measured drop fidelity is explicitly
deferred (`deferredMeasurements` in `tests/fixtures/validation/reference-manifest.json`
schemaVersion 2) and the historical failing comparison is retained in
`test-results/validation/nasa-drop-legacy.json` (`kind: "archived-failure"`).
`node scripts/validate-models.mjs` (report schema v5) hash-checks the deferred
descriptor, archive and registered fixture `tests/fixtures/contact/nasa-drop.json`,
records `deferredMeasurements[]` with ID, reason, archive path/hash and historical
`failed` status, and sets `contactFidelityStatus: "blocked"` (never `pass`
without an active passing contact measurement), `numericalStatus: "pass"` (12
cases), `propellerFidelityStatus: "failed"`, `fidelityStatus: "blocked"`, and
overall `status: "failed"` (exit 2).

## Acceptance tools, collision chunks and scenarios

This section specifies the acceptance tooling, collision lattice, scenario runner and accessibility contracts for TASK-042/044/051/059/065/073/079/080/082/083. Native closed-loop SITL (TASK-042/043/059), ArduPilot WASM browser bootstrap (TASK-045) and Rapier terrain-plane coupling (TASK-065) are implemented; browser autopilot READY, recorded Simulation-on-Hardware, measured aerodynamics, live terrain session wiring and full thermal rendering remain separate.

### Evidence formats and verdicts

Shared evidence helpers bound input to 32 MiB, verify exact input SHA-256, reject malformed/nonfinite fields and write version 1 reports under test-results/validation. PASS exits 0, FAIL exits 1 and BLOCKED_EXTERNAL exits 2. Missing input never becomes a green test. Hardware/source strings in an imported JSON are declarations requiring operator review, not cryptographic proof of physical execution. Structural tests are explicitly synthetic and cannot admit hardware or firmware modes. CLI reports retain sourceRevision, validatorSha256 and, when supplied, inputSha256; keep original captures for audit.

SITL locks firmware commit fb773567896014da007bca58358704d4a0d8516f, EKF3 and arming checks. The owned Linux driver `scripts/sitl/driver.mjs` (with pinned pymavlink 2.4.50 sidecar `scripts/sitl/telemetry.py`) drives the verified native ArduCopter ELF against `BetRigidBodyBackend`. The analyzer requires contiguous servoFrame from zero, four 1000–2000 us PWM channels, increasing timestamps with <=0.1 s gaps, real source/model/firmware provenance and healthy EKF. Stages must progress arm→takeoff→hold→land, in GUIDED=4 until LAND=9. Takeoff altitude is >=3 m, hold is 10 m ±1 m for >=10 s, and the final sample must be disarmed below 0.5 m. A private process run is bounded to 120 s/16 MiB; only its owned child/group is terminated. Pinned sources/hashes do not alone prove binary reproducibility. Full-rate capture verification (`scripts/check-sitl-capture.mjs --input CAPTURE_DIRECTORY`) and trace v2 details are specified in the TASK-042 native closed-loop section below.

TASK-051 is a version 2 proposal and is not a version 1 acceptance gate. Its analyzer, kept for that later firmware, covers 60–3600 s. Virtual Hybrid SITL uses provenance source `virtual-sitl`, copter `SIM_RATE_HZ` of at least 400, and p99 compute lateness <=2.5 ms, with no drone and no serial port. Recorded Simulation-on-Hardware requires ArduPilot >=4.6.3, `AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539, heartbeat gaps <=2.5 s, and an unplug that drops the link and disables actuators. Plane, rover and blimp Hybrid SITL use `SIM_RATE_HZ` of at least 50 and p99 lateness <=5 ms. See the version 2 procedure; the CLI does not open a serial port or arm a vehicle.

EW requires a no-fault control plus jamming, position-step, velocity-drift, magnetic and motor-loss cases. TASK-059 native acquisition uses scripts/run-ew-sitl.mjs, the existing TASK-042 driver and the TASK-058 EwEngine. GPS1_TYPE=14 accepts actual GPS_INPUT packets at 10 Hz; GPS2_TYPE=0 prevents a clean backup masking the injected receiver. Physics JSON position/velocity remain true. A 30 m north step, 0.5 m/s² north drift capped at 4 m/s, and severity-1 jamming affect GPS only. Magnetic bias adds [0.3,0.2,0] Gauss in FRD through all three SIM_MAGn_OFS parameters (negative milliGauss because SIM_Compass subtracts offsets); no attitude or IMU-force corruption is used. Motor 0 loses its complete force and yaw wrench after motor lag through the explicit synthetic instant-thrust-loss contract, not an electrical motor model.

The plan is fixed before calibration: seed 59, 800 Hz physics, 100 Hz response capture, live READY admission, 5 s stable hold before injection, 12 s exposure and 8 s recovery; complete motor loss has a bounded 3 s exposure and no recovery claim. Disabling drift uses step-to-truth. Fault runs retain unhealthy EKF flags, innovation ratios, modes and trajectory rather than requiring TASK-042's healthy landing gate. Native source V4.7.2 migrated ARMING_CHECK to ARMING_SKIPCHK: the actual full parameter readback must show ARMING_SKIPCHK=0, EK3_ENABLE=1 and AHRS_EKF_TYPE=3. The legacy parameters.parm remains historical; no check is bypassed.

Schema 2 manifests name six ordered capture directories. scripts/sitl/check-ew.py independently re-decodes both raw directions with pymavlink 2.4.50 and CRC validation, checks every transmitted GPS_INPUT against its source observation and quantization, checks firmware GPS readbacks and the complete pre-fault parameter snapshot. scripts/sitl/audit-ew.mjs reruns that decoder, replays every actual PWM through the original rigid-body WASM and canonical fault schedule, compares truth and quaternion, reconstructs every baseline/distorted observation, verifies compass fault/recovery acknowledgments, and joins response rows to original heartbeat/EKF/global-position messages with <=1 s freshness. Truth hashes compare before/after observation processing in the same tick. Separate closed-loop flights may have different trajectories; motor failure intentionally changes physical truth. The former schema-1 self-declared changed-observation flags do not establish native acceptance.

scripts/freeze-ew.mjs accepts audited calibration captures once, requires a healthy control within 1 m, and refuses to overwrite existing envelopes. The predeclared empirical rule is ceil-to-0.01 of 1.5 times each calibration maximum plus 2 m position/trajectory margin or 0.5 innovation margin. Observed calibration modes become the allowed set; unexpected modes require investigation. Firmware, effective parameter inputs, model, plan and source hashes must match. A new validation batch must pass those fixed bounds and the independent healthy control gate; calibration capture hashes cannot validate themselves. These are version-specific synthetic native regression limits, not measured aircraft fidelity, browser READY, recorded Simulation-on-Hardware, guaranteed fallback modes or EKF gate bypass.

Native TASK-059 acceptance: all six calibration cases and six separate validation cases pass, with 710636 reconstructed physics frames. The immutable matrix and original native reports/archives preserve fault-induced unhealthy flags and modes. Jamming and drift reached Land; the position step raised GPS-glitch flags; magnetic bias increased compass innovation ratios while remaining Guided; complete rotor loss tumbled into the synthetic floor during its 3 s window. In pinned Copter ekf_check.cpp, compass, velocity and position variance criteria combine before failsafe action, so compass innovation alone is not a promise of Land. The healthy TASK-042 flight also passed again. See test-results/validation/task-059-native.json, task-059-tests.json and task-059-completion.json for exact identities and the documented environment reruns. TASK-125 and TASK-126 later changed `packages/ew/src/engine.ts`, `magnetic.ts`, `position-step.ts` and `velocity-drift.ts`, which are part of the frozen source closure, so these reports are a historical snapshot of the previous source: a new native EW capture fails the frozen source-closure check in `scripts/report-ekf.mjs` until TASK-059 is recalibrated and revalidated on Linux/WSL native SITL. The native adapter enables each case's effect under its own faultId, so re-targeting never occurred in these flights.

GPU analysis requires M4 or RTX4050 identity, OS/browser/power/backend, a visible production scene, all terrain/FPV/thermal features, >=60 s warmup and >=600 s measurement. All positive finite frame intervals must cover duration within 0.02 s. On 2026-10-21 the user accepted 60 FPS limits of median 16.680 ms and p99 17.665 ms, compared after rounding to 0.001 ms, and accepted a 59.88 Hz panel for that profile. The 120 FPS p99 limit remains 8.33 ms and applies on a panel that refreshes at least at 120 Hz. GPU residency<=2 GiB and CPU cache<=512 MiB. The flight image must fill the active physical display. An emulated 1920x1080 viewport does not prove presentation on a 2560x1440 mode or on the MacBook Air native 2560x1664 panel. Software/headless rendering cannot pass. Imported traces require original profiler evidence review.

System evidence maps exact G0/G1/G2/G3/G4 IDs to demo, external-sitl, wasm-sitl and hitl. Every missing requirement is NOT_RUN; any FAIL fails the mode; otherwise incomplete coverage blocks. PASS requires an observed source, expected report path, exact report hash, matching source revision and an underlying PASS of the correct kind. Empty, duplicate, unknown and stale declarations cannot certify a mode. Legacy numerical reports are not silently upgraded to physical PASS. Release inventories verify owned generated files, byte limits, hashes, licenses and actual metadata; full license/build/clean-machine/raw-evidence review remains blocked. No release script publishes.

### Terrain collision lattice v1

HeightTile has version=1, epoch/revision uint32, integer northIndex/eastIndex within ±1024, resolution 2..257, spacingM in (0,100], and resolution² finite downM samples within ±15000 m. All horizontal nodes must remain within the 15 km local envelope. Row increases North, column East; the world origin is fixed NED. Each cell uses triangles [a,a+1,a+n] and [a+1,a+n+1,a+n], normals facing -Down. Native height samples remain Float64; mesh vertices are Float32. Quantized vertices add at most about 1 mm over this envelope and do not establish physical terrain accuracy.

Collision construction belongs to a separate Worker. Stage owns a copy, validates matching epoch/lattice, increasing revisions, exact shared-edge heights and fixed capacity 1..256 (default 64). Combined active+pending buffers obey a byte cap (default 64 MiB, configurable up to the 512 MiB CPU ceiling); replacement must fit both old and new data before publication. Publish swaps pointers only on strictly increasing ticks of the matching epoch. Visual resources cannot evict collision ground. downAt/sampleInto use the piecewise-triangular mesh rather than bilinear interpolation. Missing ground returns NaN; readyAround/readyFrom conservatively require every tile intersecting a safety square with radius<=half a chunk. High-rate calls use preallocated typed-array inputs/outputs; scalar convenience calls are cold. The TASK-065 terrain contact coupling below connects it to the Rapier contact owner; live terrain admission into the flight session remains separate. No file decoding runs inside physics.

### Declarative scenario v1

Scenario admission snapshots and freezes configuration: id, physics hz 400/800/1200, uint32 seed, model/firmware SHA-256, duration 1..4320000 ticks, <=128 ordered events and an altitude-hold rubric. Only validated weather.set/fault.set protocol-v2 templates are admitted, with expectedEpoch=0, consecutive requestIds from 1 and atTick exactly matching event tick. `ScenarioBinder` binds the active epoch, allocates the next accepted request id, submits through the session queue on that simulation tick, and claims a fault applied only after an applied ACK. The runner returns immutable event indices, never allocates in polling, and uses simulation ticks; pauses consume no simulated time. Backwards/missed ticks return -2 instead of late execution. Reset explicitly rewinds the cursor. Provenance/seed/hz mismatches reject startup. Scenario schema 2 (TASK-166) adds `effects`, entries of `{ control, onsetTick, durationTicks, recovery }` holding a TASK-166 control record, and lets `events` carry `effect.set` as well. Each entry becomes ordinary events, the effect on at its onset and off when its duration ends (null holds it to the end), which must end by the scenario's end and fit its 128 events, two for an effect with a duration. Admission merges them in tick order, on one tick in the order written, numbers their request IDs and refuses a control whose intensity leaves its range. Each is bound, submitted and acknowledged as above, so a scheduled effect applies on its exact tick and its end is as visible as its start. Schema 1 reads as it did and has no `effects`.

The rubric requires every integer hold tick exactly once, finite altitude, actual autopilot source and healthy EKF when configured. Gaps, excess altitude error and unhealthy EKF fail; incomplete/synthetic traces block. Pilot-basics contains all-zero placeholder hashes for structural testing only; it is not a certified aircraft/firmware lesson. Native SITL EW closed-loop validation (TASK-042/043/059) is complete. TASK-075 admits instructor `fault.set` commands into the live session `EwEngine`; TASK-124 rejects motor-loss there while the active dynamics reads no motor-fault table. TASK-079 submits scenario faults on their tick and waits for the applied ACK. Weather events stay rejected on the demo. Placeholder lesson hashes are not a certified lesson.

### Accessible interaction

A visible keyboard focus outline, skip-to-controls landmark, explicit replay-time values, live permission status and focus restoration after Serial permission are implemented. A denial does not schedule a prompt retry. Focus is not stolen from a different control or restored to a detached trigger. An axe scan and browser keyboard/390px checks exercise the demo; a physical device and screen reader remain separate checks. The existing low-contrast footer was corrected without suppressing scan rules.

## Steady propeller coefficients for measured comparison (TASK-033)

`mirage_bet::propeller::steady_point(rotor, radius_m, spin_sign, condition)`
evaluates the prescribed-RPM BET of section 3 with a uniform induced velocity
v >= 0. That velocity is the root of `T_BET(v) = 2*rho*A*v*(V + v)`, the same
axial actuator-disk closure that `AxialInflow` relaxes towards. Bisection runs
80 iterations on [0, Omega*R]. It is an offline validation harness and never
runs in the step loop.

The propeller advances along +z, so the air velocity in hub axes is
(0, 0, -V). The wind-tunnel convention applies:

* n = RPM/60 rev/s, D = 2R and V = J*n*D;
* CT = T/(rho*n^2*D^4) and CP = P/(rho*n^3*D^5), where P = -s*Q_air*Omega;
* eta = J*CT/CP.

When thrust at v = 0 is not positive (windmill or brake), the closure is not
applied: v = 0 and `outside_momentum_validity` is set.

Swirl, tip loss and nonuniform inflow are not modeled. Measured differences
therefore include those effects together with polar uncertainty, and must be
reported, not tuned away.

`cargo test --test propeller` checks four exact oracles independently of any
dataset:

* with CD = 0, P = T*(V + v) and eta = V/(V + v);
* the steady target of `AxialInflow` equals v;
* coefficients recover T and P;
* drag raises CP and lowers eta, and mirrored spin is unchanged.

## UIUC propeller database comparison (TASK-033)

The measured adapter `uiuc-propeller-bet-v1` compares `steady_point` with the
UIUC Propeller Database (Vols 1-4), using the DA4002 and DA4022 3D-printed
propellers. Their airfoil, SDA1075 along the whole blade, is published in
AIAA 2014-2151, Appendix A. The archive, inventory, rights status and
regeneration commands are described in the
[UIUC data guide](operations/uiuc-propdb-data.md).

Data path: `tests/fixtures/rotors/uiuc/generate_uiuc_propellers.py` verifies
the pinned archive digest and writes the registered measured fixture
`tests/fixtures/rotors/uiuc-propellers.json`. `packages/physics/src/uiuc-propeller.ts`
validates it and builds the declared model. `native/bet/examples/propeller_points.rs`
evaluates the BET offline through a line protocol, and `scripts/validate-models.mjs`
reports the result. The comparison is never part of the step loop.

### Declared model and tolerances

These choices were fixed in the fixture and code before the first evaluation:

* blade: SDA1075 from r/R = 0.30 to the tip, in 28 equal midpoint strips
  with measured chord and twist interpolated linearly. The hub region
  0.15 ≤ r/R < 0.30, where the airfoil is not specified, is excluded.
  Two blades unless the run is labelled 3b/4b; spin +1.
* polar `thin-airfoil-laminar-friction`:

  ```text
  CL = 2*pi*(alpha - alpha0)
  CD = 2*1.328/sqrt(Re)
  alpha0 = -(1/pi) * integral_0^pi (dz/dx)*(cos(theta) - 1) dtheta,  x = (1 - cos(theta))/2
  ```

  alpha0 = −1.341 deg from the SDA1075 mean line. The table spans
  alpha0 ± 10 deg, 1e3 ≤ Re ≤ 5e5 and Ma 0–0.3. A query outside it is
  clamped and flagged by `PolarTable`; a flagged point is reported as
  `outsidePolar` and not compared.
* inflow: uniform axial momentum (section "Steady propeller coefficients");
  windmill points are `outsideMomentum`, not compared. No tip loss, swirl or
  nonuniform inflow.
* ambient state: ISA sea level (1.225 kg/m^3, 1.789e-5 Pa s, 340.294 m/s),
  because the archive lists no per-run state.
* tolerance: per compared point, |dCT| ≤ max(0.10·|CT|, 0.005) and
  |dCP| ≤ max(0.10·|CP|, 0.003); both must hold. The status is `failed` if
  any compared point fails or the runner errors, `pass` if all compared
  points pass, and `unvalidated` if no point was compared. `unvalidated` is
  never reported as PASS.
* consistency: before any comparison, the dataset oracles (eta consistency
  and Froude bound, see the data guide) must report zero violations. They must
  also equal the generator's audit counts.

### Result (2026-10-17)

`node scripts/validate-models.mjs` exits 2 with propeller fidelity
`failed`, consistency `pass` and 716/674/0/0 audit counts. Of 958 points,
534 were compared, none passed both tolerances, 101 met the CT tolerance
and 154 the CP tolerance. 389 points were outside the polar envelope (all
242 static points and 147 points with J ≤ 0.52) and 35 were windmilling.

The signatures are consistent with the declared simplifications:

* DA4002 mean CP error is −0.002 to −0.012 in seven of eight
  configurations (+0.0001 in the eighth). Laminar friction omits pressure and
  laminar-bubble drag. Its mean CT error stays within ±0.013.
* DA4022 mean CT error is +0.020 to +0.067 and mean CP error +0.005 to
  +0.024. Both grow with blade count (solidity), consistent with no tip loss
  and uniform inflow.

Per-point values are written to `test-results/validation/propeller-points.json`.
They must not be tuned away: reaching PASS requires a measured or
viscous-solver polar and, if needed, a declared inflow/tip-loss model, each
with its own provenance.

### XFOIL polar comparison (2026-10-17)

The second measured adapter, `uiuc-propeller-bet-xfoil-v1`, uses the same blade,
inflow, ambient state and tolerances. Only the polar changes, to the synthetic
fixture `tests/fixtures/polars/sda1075-xfoil.json` (id `sda1075-xfoil-699-v1`).
`tests/fixtures/polars/generate_sda1075_xfoil.py` produced it by running MIT
XFOIL 6.99 for Windows (exe SHA-256
`c17342f84ae260c2b11a74cd0e2fb8189a5f8954c6bb7a8467a0f27055c7faea`, from
`XFOIL6.99.zip`, SHA-256
`e13e8fe5cc38d8ac2626e9d3b17643bdcfaa63791619f042afdaa7cd103bcb08`) on the
SDA1075 transcription. The settings were fixed before evaluation:

* default PANE repaneling, free transition with Ncrit = 9, Mach 0, ITER 200;
* sweeps 0 → +14 deg and, after INIT, −0.5 → −8 deg in 0.5 deg steps;
* Re = 2e4, 3e4, 4e4, 6e4, 8e4, 1e5, 1.5e5 and 2e5, each in a fresh process.

The table keeps the largest contiguous alpha range around 0 deg that converged
at every Re: −7.5 to +7.5 deg, limited by Re = 3e4 (32 converged angles).
Ma 0 is duplicated at Ma 0.3; tip Mach is at most 0.21 in these runs. Queries
outside the table are flagged and not compared. Two runs of the generator
produce byte-identical output with the same binary.

Result: propeller fidelity `failed`. Of 958 points, 165 were compared and 26
passed both tolerances; 723 were outside the polar and 70 were windmilling.

* DA4002 9×6.75: all 16 compared points pass; with the analytic polar, none
  did.
* DA4002 9×2.85: 10 of 13 compared points pass.
* DA4002 9×8.95: CP passes at all 20 compared points; CT is high by 0.014 on
  average.
* DA4022 9-in: CT is high by 0.024–0.041 and CP by 0.014–0.026, both growing
  with blade count. This is consistent with the missing tip loss and uniform
  inflow, not with the airfoil data.
* 5-in propellers: no point was compared, because root sections fall below
  Re = 2e4.

The XFOIL polar is a solver result, not airfoil measurement. A PASS would
still require the remaining DA4022 errors to be explained by a declared
tip-loss or inflow model.

## UIUC-derived JSBSim propeller tables (TASK-086)

`data/jsbsim/generate_uiuc_propellers.py` writes JSBSim fixed-pitch propeller
files into `data/jsbsim/engine/`, the bridge's engine path. Each file holds a
`C_THRUST` and a `C_POWER` internal table versus J; JSBSim's definitions
CT = T/(rho n^2 D^4) and CP = P/(rho n^3 D^5) match the UIUC tables, so the
rows are copied unchanged. JSBSim tables depend on J only, and one RPM per
propeller is chosen by a fixed rule:

* runs within the same 250 RPM bin form one group;
* the highest-RPM group whose sweep reaches CT ≤ 0 is chosen;
* the J = 0 row comes from the static table at the nearest RPM.

The Reynolds-number dependence across RPMs is therefore not represented, and
JSBSim holds the end value beyond the last measured J. No ixx is written,
because inertia is not in the dataset.

`node scripts/check-jsbsim-propellers.mjs` verifies the native load in the
pinned JSBSim v1.2.3 (commit and license hash from
`native/jsbsim/source.lock.json`; set `JSBSIM_SOURCE_DIR`). Without a checkout
it exits 2 (BLOCKED_EXTERNAL); a failed point exits 1. It works in five steps:

1. Builds `native/jsbsim/propeller_probe.cpp` from the separate CMake project
   `native/jsbsim/propeller/`, leaving the TASK-031 bridge build file unchanged.
2. Copies each definition byte for byte (manifest SHA-256 checked) into a
   temporary root with a probe aircraft. The aircraft has one electric engine,
   zero aerodynamics and an unused ground contact.
3. Loads it through `FGFDMExec::LoadModel` and runs the initial condition at
   ISA sea level with body velocity V = J n D.
4. Calls `FGPropeller::Calculate` at the table's RPM group. Thrust is computed
   from the entry RPM, before RPM integration.
5. Checks the results against the measured rows.

The checked quantities are:

* the loaded diameter equals the manifest value / 12 ft;
* the reported J equals the requested J within 1e-9;
* density is within 1e-4 of ISA (1.225 kg/m^3 = 0.0023769 slug/ft^3);
* thrust and power are within 1% of CT rho n^2 D^4 and CP rho n^3 D^5.

The points are declared before running: the static row; the row whose CT is
nearest half the static CT; and the midpoint to the next row, checked against
linear interpolation.

Result (2026-10-18, Linux, GCC, CMake 3.28): all 6 files load and 18 of 18
points pass. The largest thrust error is 4.1e-16 and the density error is 8.1e-6.
The report is `test-results/validation/jsbsim-propellers.json`.

v1.2.3 assigns `FGPropeller::Ixx` only when `<ixx>` exists; it has no default.
A flight model using these files must therefore add the rotating inertia
before RPM is integrated. The probe never reads Ixx, and it does not exercise
RPM dynamics or engine coupling.

## Native closed-loop SITL harness (TASK-042)

The owned Linux driver is `scripts/sitl/driver.mjs`, with a pinned pymavlink
2.4.50 sidecar (`telemetry.py`). It runs the clean locked ArduPilot source's
native ArduCopter ELF and the existing Rust RK4 body WASM through
`BetRigidBodyBackend`. It uses a synthetic quad X reference, not calibrated
BET polars, JSBSim aircraft performance or the browser demo. Mass, inertia,
arm, thrust curve, yaw reaction and motor lag are explicit in `quad.mjs`.
An inelastic horizontal floor projects penetration; this is not the Rapier
landing-gear model or arbitrary-terrain acceptance. Only Rust integrates motion.

Physics exchanges run at 800 Hz for the standard 400 Hz Copter scheduler's
gyro-rate arming check. Initial advertised 1200 Hz is upstream Aircraft's
default; JSON reply timestamps establish 800 Hz, encoded as 799/800 by float
truncation. Duplicate replies reuse identical bytes; gaps, restarts, malformed
packets and unexpected rates fail the flight. Source files are hashed before
launch and checked unchanged after flight. Child processes share the harness's
owned POSIX group; only those processes are terminated. Windows hosts run the
whole harness inside WSL, rather than pretending a Windows child kill contains
Linux descendants. UDP/TCP bind only to loopback. A new capture directory is
required; previous evidence is never silently overwritten.

Warmup lasts at least 30 simulated seconds and waits for fresh real heartbeat
and EKF reports. Required EKF bits are attitude, horizontal/vertical velocity,
absolute horizontal/vertical position; uninitialized flags or innovation
ratios outside [0,1) reject health. Heartbeat, EKF and autopilot altitude age
must each be within one simulated second. No arming/EKF checks are disabled.
Guided mode, arm, takeoff and land commands use MAVLink; actual heartbeat
mode/armed state controls acceptance, not command intent. Both truth and
autopilot altitude must meet the unchanged hold envelope. Warmup is retained
in raw captures; the scored flight starts after actual healthy arming.

Flight trace v2 adds `physicsHz=800` and `captureStride=8`. Samples are 100 Hz,
retain original firmware frame counts (arbitrary initial offset, stride eight)
and have a 0.01 s timestamp interval. Each sample adds `heartbeatAgeS`,
`ekfAgeS`, `ekfFlags`, five `innovationRatios`, `autopilotAltitudeM` and
`altitudeAgeS` to the legacy fields. Full-rate physics and raw MAVLink logs
remain separate evidence. Legacy v1 still supports historical schema tests;
new native integration uses v2. Existing 3 m takeoff, 10 m +/-1 m for at least
10 s, landing below 0.5 m with disarm, modes 4/9 and 120 s parent deadline
remain unchanged. `arm` stage covers initial ascent until the 3 m takeoff gate;
`takeoff` covers the remaining climb, and `hold` starts only after settling.

Capture outputs include `flight.json`, `run.json`, `physics.ndjson`,
`telemetry.ndjson`, `mavlink.raw`, firmware stdout/stderr and owned DataFlash
logs. They distinguish model truth from autopilot estimates and record
commands, runtime, source hashes, executable/model identity and cleanup.
The final validation report must bind the actual capture bytes and retain
failed trials separately. A native integration PASS does not enable browser
autopilot READY, certify measured aerodynamics, HITL or target-device timing.

## Source-backed propeller annular BEM diagnostic (TASK-033)

This adds an offline diagnostic, not a production dynamics ABI. The original
uniform-inflow path and fixed CT/CP tolerances remain.

### Sources and limits

The supplied AIAA 2014-2151 article anchors the existing UIUC experiment and
blade identity. Deters' dissertation adds design versus manufactured geometry
(3.2), axial/tangential induction (4.2), low-Re XFOIL limitations (6.2), and
downstream slipstreams (chapter 8). Appendix A.2 exactly matches the existing
61-point SDA1075 transcription. The dissertation reports that its Re=20000
XFOIL polar produced propeller predictions inconsistent with experiments.
Expanding solver coverage alone cannot establish fidelity. Our fixture already
uses scanned geometry; no additional fitted pitch offset is applied.

PROPID 5.3.1 documents slug/ft units, midpoint stations, Prandtl tip/hub losses
and swirl. It names MODE=2/INCV=1 for propellers but does not document that mode.
`node scripts/check-propid.mjs --run` checks source hashes and runs the bundled
turbine example in a bounded cache directory. That smoke passes with its
original Reynolds warning. A separate synthetic propeller trial did not
establish velocity/sign conventions and is not admitted as parity. The review
is `test-results/validation/propeller-source-review.json`; raw resources stay
local and ignored. Downstream measured swirl is not rotor-plane induction:
station transforms/wake contraction would be needed to compare chapter 8.

`neel542/airfoil-research`, reviewed at commit
`27c6eb2a37e4f157ae62bd485b3686949b103698`, is a complementary implementation
and uncertainty reference. Its 14 static source files exactly match our UIUC
files, not independent new experiments. Its general airfoil benchmark starts
at Re=60000. Its propeller study uses static cases, a Re>=40000 summary window,
Kulfan-fitted geometry and different loss/root/polar policies. We do not import
its error fits, acceptance window, NeuralFoil predictions or filled XFOIL gaps
as measurements. Its Python code was inspected, not executed.

### Annular diagnostic

The supplied `task_033_sda1075_polar_propid_handoff.md` was reviewed as a
secondary source, not an acceptance instruction. Its claimed digitization
disagrees visibly with the article's Figure 30 (PDF page 22): at alpha=0,
Re=40000 the plotted Cl is near zero, not 0.30; at alpha=20, Re=100000 it is
approximately 0.63, not 0.97. These approximate visual readings identify a
discrepancy; they are not replacement polar cells. The handoff supplies no
digitization calibration or uncertainty and is not imported. Existing raw
XFOIL 6.99 at alpha=0, Re=40000 gives Cl=-0.0322, Cd=0.02661; differences
between solvers/settings still require their own provenance.

NeuralFoil's official documentation describes a neural surrogate trained on
XFOIL runs, with an analysis-confidence output. Smooth evaluation is not a
converged boundary-layer solve or measured accuracy at Re=5000. Viterna
extends angle of attack; it does not supply missing Reynolds-number validity.
Any future extension must separately identify raw solver, digitized solver,
surrogate and angle-extrapolated values, plus Reynolds-envelope flags. The
reviewed sources do not establish that measured SDA1075 data cannot exist
elsewhere. NASA deferral concerns landing-gear fidelity, not whole-aircraft
validation. Review artifact: `test-results/validation/task-033-handoff-review.json`.

`native/bet/src/propeller_bem.rs` balances each midpoint annulus with rotor-plane
axial velocity V+u and tangential velocity Omega*r-w. Momentum loads per unit
radial span are `dT/dr = 4*pi*rho*r*F*u*(V+u)` and
`dQ/dr = 4*pi*rho*r^2*F*w*(V+u)`. Original Prandtl tip/hub factors form F and
multiply momentum, not an arbitrary total-thrust scale. Lightly braking annuli
are allowed on V+u>=V/2; integrated nonpositive thrust/power is outside validity.
Windmilling and high-induction braking remain uncertified.

A bounded damped Newton solve uses nested swirl/axial bisection as fallback.
Its search expands; no fixed fraction of rotational speed is an induction
admission limit. Missing roots yield errors, never zero-inflow success.
Multiple-root uniqueness/stability is not certified: Newton finds a local
balance; fallback scans for the first sign bracket. Convergence requires
relative residual <1e-9 against the local rotational blade-force scale.
Only final section queries determine coverage; clamped polar values are not
admitted as valid comparisons.

The cold example accepts `--annular`, `--no-tip-loss`, `--no-hub-loss` and
`--no-swirl`. In annular mode its fifth numeric output is dimensionless
residual; unchanged legacy mode reports newtons. `bem` stderr records contain
convergence, validity, residual, final alpha/Re extrema, mean induction/swirl
and coefficients. This is offline tooling, not a C/SAB interface.

`node scripts/check-propeller-bem.mjs` runs four explicit variants with the same
registered measurement and XFOIL fixtures. All three annular variants converge
on 958 points. Full losses/swirl compare 193 points: 48 pass both tolerances,
690 are outside polar and 75 outside momentum validity. Original uniform flow
reproduces 165 compared/26 passed. On 159 common points, the candidate passes
39 versus 26, with 35 gains and 22 losses. Different coverage and mixed changes
preclude a general improvement/fidelity PASS claim. Results, source/executable
hashes, paired points and query ranges: `test-results/validation/propeller-bem.json`. Annular diagnostic exit 0 only means its sensitivity execution completed; `validate-models.mjs` exit 2 retains the distinction between numerical parity, failed propeller fidelity and blocked airframe fidelity.

## Terrain contact coupling: contact ABI v2 (TASK-065)

Decision: keep Rapier's topology fixed and move planes instead of rebuilding
colliders. Contact initialization inserts one fixed halfspace per contact slot:
slot 0 for the airframe sphere and slots 1..8 for the wheels. Each slot has its
own collision-group pair, so a halfspace interacts only with its own sphere or
rim. Before each step the integration owner samples the published lattice
triangle under each contact and passes those planes. The fixed bodies are
re-posed; colliders are never inserted or removed while armed.

The `contact_abi_version()` is 2 and the input grows from 16 to 52 values:

| Index | Meaning |
| --- | --- |
| 0..15 | v1 input (wrench, brakes, dt); index 15 is now the plane mode |
| 15 | 0 = configured plane for every contact (v1 behavior); 1 = per-tick planes |
| 16 + 4*s .. 19 + 4*s | slot s plane [nN, nE, nD, offsetM]; s = 0 airframe, s = 1 + i wheel i |

A supplied plane needs a unit normal (|n|^2 - 1 within 1e-9) facing up
(nD < 0) and a finite offset. A point x is n.x - offset above it. With mode 0,
or for slots beyond the configured wheels, all plane values must be 0. Any other
value rejects the step with -2 and leaves state unchanged. Each wheel's tire
deflection, rolling/lateral decomposition, normal force and plane-distance
diagnostic use that wheel's plane. Rim bottom-out uses its own halfspace. The
airframe sphere uses slot 0, and the reported hull point lies along that normal.
Cold initialization also exercises plane moves at every rate before arming.
The existing in-step allocator gate still faults the session on any allocation.

`CollisionChunks.planeInto(position, out)` writes the plane of the same mesh
triangle `sampleInto` uses, with the exact gradient of that triangle and NaN
when ground is missing. `TerrainContactCoupler` (`packages/physics/src/terrain-contact.ts`)
owns preallocated buffers. Each `stepInto`:

1. requires `readyFrom` over a safety square at least the wheel-anchor reach;
2. samples slot 0 at the CG and each wheel at the horizontal position of
   R(q)·anchor;
3. calls `GroundContact.stepInto(..., groundPlanes)`.

Missing ground returns `TERRAIN_PAUSED_MISSING_GROUND`: no step runs and the
state is unchanged. A rejected step returns `TERRAIN_REJECTED`.

Limits:

* Sampling uses the fully extended anchor, not the instantaneous contact patch.
* Curvature inside one triangle, and a triangle edge under a tire footprint,
  are represented by the single plane under the sampled point.
* The coupler is not yet wired into the flight session (the demo backend is
  active).
* Live tile decoding and terrain admission remain separate work.


## Local ArduPilot WASM build and browser acceptance (TASK-045)

The upstream wasm board at 8ab6afde107a91df1b5f60ade8f333cb8a61b190 remains pinned to Emscripten 4.0.15. The clean build reproduced the committed 3730330-byte module (556d97fa6dbf7c0a2cf713f6106a6891de0b9bc9c5a7dd945f1789b63e58df38) and 258215-byte glue (b158a7b8e9b400c770e2b4fc87c66fc2aaf68bc583c7d71f3a56786d3bcb4212). The builder checks source HEAD/cleanliness, locked HAL/license bytes, submodule commits, SDK commit/manifest and compiler version/commit. It requires new/empty outputs, deletes no supplied directory, saves build.log and fails on differences from the committed artifact manifest. Upstream CI's 6.0.8 remains a distinct version; this acceptance verifies the project's unchanged 4.0.15 pin.

With MIRAGE_ARDUPILOT_WASM_DIR explicitly set, the Vite development server admits the pinned local bytes and exposes only manifest.json, arducopter.js and arducopter.wasm at /__local-ardupilot/. GET, loopback peer, loopback Host and same-host Origin checks apply; foreign fetches, writes and unknown files are rejected. This route is absent without the setting and absent from production builds. Artifacts remain local and carry distribution=local-only-pending-gpl-review. The existing distribution decision remains open; the bootstrap adds no firmware to public/ or dist/.

BrowserWasmSession runs inside the dedicated ardubilot.worker.ts. Cold Worker protocol 1 admits exact start/serial/checkpoint/stop shapes and <=4096 non-shared serial bytes. Start requires crossOriginIsolated and SharedArrayBuffer, a same-origin artifact base, <=64 MiB WASM and <=4 MiB glue. The existing admission checks hashes, exports, imports and memory before execution. A Blob URL made from admitted glue is also the pthread entrypoint, and admitted wasmBinary is supplied directly, preventing an unchecked second fetch. The imported shared memory is initially 16 MiB with a 2 GiB maximum; four real pthread Workers are observed, with a host cap of 16 children. The diagnostic supervisor has 30 s boot and 20 s stop deadlines. Explicit shutdown frees its serial buffer, terminates owned children, closes storage and releases the profile lease; abrupt parent termination is separately tested for child cleanup.

The serial bridge is polled in <=4096-byte chunks every 25 ms. Three CRC-valid system/component 1/1 HEARTBEATs produce a diagnostic booted event. Booted is independent of autopilot READY, EKF health or flight acceptance. PARAM_REQUEST_READ (20, CRC 214, 20-byte payload), PARAM_VALUE (22, CRC 220, 25 bytes) and PARAM_SET (23, CRC 168, 23 bytes) extend the pinned codec subset with independent pymavlink 2.4.50 byte fixtures. The actual pinned parameter is WP_SPD in m/s, not the removed WPNAV_SPEED name. Real storage tests read its initial value, set 8.125 m/s and verify the firmware's CRC-checked readback across graceful and abrupt Worker restarts. The built-in quad remains disarmed; MirageSITL physics/time/sensor/actuator coupling belongs to TASK-046 and native parity to TASK-047.

The upstream default POSIX Storage backend uses a 16384-byte eeprom.bin. The unchanged glue exposes FS but lacks IDBFS, so EepromStore checkpoints the actual file to IndexedDB database mirage-ardupilot-eeprom-v1, store profiles. Keys bind firmware commit, module hash and a 1–64-character profile. Schema-1 records contain identity, increasing revision, full image and SHA-256; load validates all fields and bytes, and corrupt records prevent boot rather than being erased. A Web Lock excludes concurrent firmware owners; a readwrite transaction with revision comparison prevents competing checkpoint writers. Tests verify conflicts and transaction abort preservation. preRun restores the validated file before firmware main. Automatic checkpoints are considered every 2 s after boot; one second of stable file bytes is required, with a bounded 10 s stabilization attempt. Explicit stop drains/checkpoints before release. Only an acknowledged checkpoint promises persistence; unsaved changes may be lost on abrupt termination. This is a cold bootstrap/storage facility, not a certified high-rate flight HAL, full AAR recorder or SAB ABI change.

The local diagnostic page is ardupilot-check.html. Its bounded raw captures and three complete EEPROM images are independently audited by scripts/check-ardupilot-browser.py using pymavlink 2.4.50 and hashlib. The audit checks original CRC-valid disarmed heartbeats and parameter values, firmware identity, memory/thread reports, stored revisions, full-image hashes and zero remaining Workers. Unit fixtures are labelled synthetic and cannot substitute for this real browser evidence.

## ArduPilot lockstep HAL mailbox v1 (TASK-046)

The HAL-enabled firmware is a separate local build of the pinned upstream
ArduCopter. `scripts/build-ardupilot-hal.mjs` verifies source/SDK/compiler and
submodule identities, copies source into an owned `/tmp/mirage-task-046-*`
directory, applies `native/ardupilot/hal/sitl-state.patch`, and adds the HAL
kernel. `--resume` verifies/removes/reapplies only that patch before compiling.
It preserves the original source and TASK-045 artifact. Outputs and a separate
manifest/build identity are in `.cache/task-046/`; firmware remains local-only.
The upstream WASM FDM step consumes external observations in place of advancing
its internal quad model, then uses the existing `stop_clock(timestamp_us)` path.
ArduPilot's own sensor processing and task rates remain in effect.

Exports: `mirage_hal_version()->u32`, `mirage_hal_mailbox()->pointer`,
`mirage_hal_configure(hz,epoch)->i32`, `mirage_hal_notify()` and
`mirage_hal_stop()`. Version 1 uses a 1024-byte, 64-byte-aligned mailbox in
firmware shared linear memory. All shared payload accesses are atomic u32;
float64 is encoded as little-endian low/high words through private scratch.
This is an independent C ABI boundary; existing flight ABI-v2/SPSC bytes and
ownership are unchanged. No shared Float64Array access is permitted.

Header u32 words 0..15: magic `0x4d48414c`, version 1, bytes 1024, state,
physics Hz, nonzero epoch, completed-tick low/high, host input sequence,
firmware output sequence, fault code, PWM channel count 32, armed (0/1), zero
reserved word, input timestamp-us low/high. Configure permits 400/800/1200 Hz
before the first accepted input only. Step k starts at 1 and supplies
`floor(k*1000000/hz)` microseconds; the maximum step count is 9007199254.
The low-word sequence wraps modulo 2^32 while completed ticks carry a high word.
Epoch/rate changes require a new cold firmware/physics session.

The 40 f64 sensor values start at byte 64: latitude/longitude degrees, altitude
MSL metres (indices 0..2); velocity NED m/s (3..5); accelerometer specific force
FRD m/s^2 (6..8); gyro FRD rad/s (9..11); unit body-to-NED quaternion wxyz
(12..15); magnetic field FRD gauss (16..18); equivalent airspeed m/s (19);
battery V/A (20..21); nonnegative height AGL m (22); twelve normalized RC inputs
in [0,1] (23..34); wind NED m/s (35..37); exact zero reserved values (38..39).
Every value is finite with absolute magnitude <=1e9. Latitude/longitude limits
are 90/180 degrees, altitude magnitude <=100000 m, squared quaternion norm
within 1e-6 of 1, and airspeed/battery/current/height are nonnegative (the
TASK-092 coupling sends a regenerating bus current as 0). Bytes
384..511, 640..767 and 896..1023 stay zero. Byte 512 contains 32 u32 PWM values
in microseconds. Byte 768 contains sixteen f64 diagnostics: gyro deg/s[3],
magnetic milli-gauss[3], Euler roll/pitch/yaw degrees[3], specific force[3],
NED velocity[3], and last accepted timestamp us. These are binding diagnostics,
not estimator health or flight acceptance.

States: 0 initial, 1 actuator request published, 2 complete sensor input
published, 3 stop requested, 4 stopped, 5 invalid input fault. Firmware owns
actuator/diagnostic payloads and publishes state 1 after atomic writes. The
host reads a coherent request, publishes the next complete sensor payload,
then stores state 2 and wakes the WASM state futex (native probes use a
condition variable). The expected-state wait prevents lost wakeups without
contending on a host pthread mutex. Firmware validates
identity, configured epoch/rate, sequence, timestamp, reserved words, counts
and sensor values before changing its output/clock. Fault code 1 latches an
invalid input. Missing input is a pause: the native thread sleeps without
advancing time. Stop wakes that thread, which acknowledges and sleeps until
the owner terminates it. Faulted threads also remain stopped until disposal.
No host spin or Atomics.wait is used on the browser Main thread.

`WasmHalPort` cold-validates pointer/alignment/memory/ABI and motor channel map;
`readActuatorsInto` writes the next tick's reusable ActuatorFrameV2, mapping
1..16 selected zero-based firmware channels with explicit PWM endpoints.
PWM 0 means no output; supported nonzero PWM is 800..2200 us. Normalization
clamps to the configured throttle range; the Armed bit comes from firmware.
`submit()` validates all private values before publishing shared bytes.
Memory replacement, foreign epoch/sequence/count, and firmware faults fail
closed. `WasmSitlSession` reuses admitted TASK-045 glue, Worker ownership,
serial transport, profile locks and EEPROM storage through a cold binding
callback. Explicit `checkpoint()` uses that storage contract; disposal stops
HAL and terminates owned pthreads without promising an implicit final save.

`WasmSitlCoupling` advances a configurable physics backend exactly once per
firmware request, using its actual actuator frame. It maps body truth through
existing ideal IMU/magnetic/airspeed observations and a WGS84 tangent frame.
The caller supplies origin latitude/longitude, MSL altitude, constant geoid
offset and magnetic field. Zero geoid offset is a declared synthetic choice.
Pressure-based airspeed observations are converted to EAS using reference
density 1.225 kg/m^3. Battery current is zero when no electrical model supplies
it. Rigid free-flight NACA6409/NeuralFoil is the first integration fixture;
validity flags remain visible and no ground support or trained flight is
fabricated. A new epoch recreates both firmware and physics owners.

`node scripts/check-ardupilot-hal.mjs` checks native million-step peers at
400/800/1200 Hz and the actual pthread-WASM HAL kernel plus JS adapter at
800 Hz with allocator/GC positive controls and stable memory. Its isolated
kernel harness is explicitly not replacement firmware or whole-ArduPilot
allocator certification. Browser tests require the real locally built HAL
artifact via `MIRAGE_HAL_ARTIFACT_DIR`; they verify full firmware exchange,
pause, exact time, disposal and the NACA6409 body connection. Build source and
artifact hashes accompany acceptance. These checks do not enable browser
READY, admit measured aerodynamics, settle firmware distribution, or replace
TASK-047 native/WASM flight parity. The main application remains on its
separately selected backend until that mode is admitted.

The browser HAL owns AGL as well as the clock: upstream `set_height_agl()` is
skipped on this path, preserving the supplied height and range values. The
internal aircraft path retains its original terrain-derived AGL behavior.

Firmware disposal drains checkpoints, closes the EEPROM store and completes
profile-lock release while all pthread peers still exist. Thread termination is
the final synchronous phase: detach callbacks, terminate peers, clear ownership,
then acknowledge stop and close the owning Worker in that same event-loop turn.
There is no await after the first peer is terminated. The disposed-session flag
rejects late pthread construction. The profile lock protects persistence commits;
no serial/stepping/checkpoint call is admitted once the session is disposed.
The delayed-release browser fixture uses actual firmware and Web Locks, checking
that each of four pthread terminations follows release completion and that all
Workers disappear after each of three restarts. It does not replace firmware
with a synthetic peer or relax the cleanup deadline.

## Native/browser autopilot parity and admission (TASK-047)

The local parity harness compares the pinned native ArduCopter JSON backend
against the actual HAL-enabled pthread-WASM firmware in isolated Chromium.
Both use the same Rust BET body/rotor module, NACA6409 NeuralFoil polar,
synthetic quad-X geometry, explicit parameter bytes, origin and tick schedule.
This verifies software behavior for the declared configuration, not measured
aircraft fidelity or unrestricted admission of other configurations.

`tests/support/autopilot-parity.ts` supplies a configurable 1.5 kg quad with
0.2 m arms, inertia diagonal [0.03,0.03,0.05] kg m^2, four 0.15 m two-blade
rotors in firmware FR/RL/FL/RR order and maximum shaft torque 0.15 N m each.
The fixture models two uniform 1 g blades per rotor over 0.045..0.15 m;
shaft inertia is 2*0.001*(0.15^2+0.15*0.045+0.045^2)/3 kg m^2. The generic
0.0002 kg m^2 rotor fixture caused an unstable controller response; that failed
diagnostic is preserved. The new declared configuration is shared by both
backends; parity thresholds were not changed to accommodate it.

`BetFlightConfiguration.syntheticGroundDownM` is optional and finite. A body
that penetrates this synthetic horizontal pad is projected to that NED down,
with zero velocity/rates, initial attitude and zero inertial acceleration.
This explicitly inelastic, infinite-friction fixture supplies no force above
the plane and is separate from Rapier or measured landing-gear fidelity.
Existing configurations omit it and retain free flight. Validity flags from
the NeuralFoil/rotor envelope remain recorded, including low-confidence and
out-of-domain operation during spool/landing; passing autopilot parity does
not turn those flags into a model-fidelity PASS.

`BetFlightConfiguration.contact` (TASK-095) makes compliant Rapier contact the
body integrator in place of the BET rigid body: the rotor wrench goes to
`GroundContact.stepInto`, which integrates gravity, the body and the ground
reaction, so the attitude evolves continuously through touchdown. It excludes
`syntheticGroundDownM`. Its vehicle mass, inertia and gravity must equal the
model's (relative 1e-12), else construction fails. `GroundContact.forVehicle`
builds such a contact: the airframe gets the vehicle's mass and inertia less each
unsprung wheel mass taken as a point at its anchor, so the unsprung masses move
the vehicle's centre of mass by Σm_w r_w/M from the body origin, small for light
gear. The dynamics owns the contact: `reset` restarts it from the initial state
through the synchronous `GroundContact.reset` (a cold re-initialization of the
same instance) and repeats the same steps, and `dispose` disposes it. A synthetic
2 kg four-rotor fixture on four short legs (`tests/flight-contact.test.ts`)
rests, climbs 2.5 m, descends on a vertical-speed loop and lands at 0.29 m/s at
400/800/1200 Hz, back within 0.12 mm of its resting height, tilted at most
7.7·10⁻⁶ rad, its attitude changing at most 6·10⁻⁵ rad per step.
`node scripts/bench-flight-contact.mjs` repeats takeoffs and landings for 10⁶
steps at 400 Hz: 0.00296 B/step with no GC event and no native allocator call
(`test-results/bench/flight-contact.json`).

The common origin is -35.362938/149.165085 degrees, 584 m MSL, with an explicit
synthetic zero geoid offset. The browser magnetic field uses the pinned
pymavlink/AP_Declination table at this origin; native JSON derives its field
from the same table and location. Host sensors are ideal and have no random
stream. Both fresh firmware processes use their default initial RNG seed 1;
native libc and WASM libc need not generate identical noise sequences.
Source hashes retain the sensor and geodesy implementations. The reference
does not promise bitwise firmware equivalence.

`BrowserWasmConfiguration` optionally supplies bounded numeric parameter text
and home coordinates before firmware main. It writes a private defaults file
in MEMFS and appends explicit `--defaults`/`--home` arguments. Existing boot
callers retain their defaults/storage behavior. Both parity runs preserve
`ARMING_CHECK=1` and EKF3; arming commands never use the force parameter.
At 800 Hz, GUIDED is commanded at 60 s, arm at 63 s, takeoff to 5 m at 70 s.
At 90 s the nominal case commands LAND; the failsafe case stops GCS
HEARTBEATs, preserving telemetry requests, with FS_GCS_ENABLE=5. Original
STATUSTEXT must confirm the GCS failsafe. Both must land and disarm by 120 s.

The independent `scripts/sitl/check-parity-wire.py` uses pymavlink 2.4.50 to
decode original serial chunks and transmitted commands. Printable UART
startup text is retained separately during pre-flight warmup; CRC errors
remain failures. Scored mode/armed/EKF flags and all five innovation ratios
must match original messages at their recorded receive times, allowing only
one simulation tick of producer bookkeeping. `MavParser` consumes a complete
structurally valid unsupported envelope without scanning its payload for
0xfd; unknown payloads are never admitted. Corrupt known frames retain bounded
resynchronization. A regression reproduces the old delayed-EKF freshness bug;
pre-fix captures fail the independent audit and are excluded from acceptance.

`docs/validation/autopilot-parity.schema.json` describes comparison inputs.
The scored reference is absolute ticks 72000..96000 inclusive (90..120 s),
stride 8, 3001 samples at 100 Hz. No trajectory alignment/interpolation,
mean removal or generated golden is allowed. Position RMSE uses Euclidean
NED distance; attitude RMSE uses the shortest quaternion geodesic angle in
degrees, normalizing within the checked unit-norm envelope and treating q/-q
equally. Fixed limits are 0.5 m and 2 degrees over 30 s. Continuous
mode/arming disagreement may last at most 0.5 s. Every sample requires fresh
heartbeat/EKF age <=1 s, raw EKF flags containing 55 and no uninitialized flag,
and finite innovation ratios in [0,1). Incomplete, shifted, duplicate or
different-input captures fail before scoring.

`scripts/assemble-autopilot-parity.mjs` binds captures/audits into two bundles.
`scripts/compare-autopilot.mjs` rechecks original file/audit/source/physics hashes,
parameter bytes and exact scored samples before emitting `evidenceValidated`.
No-input invocation exits 2 (BLOCKED_EXTERNAL), invalid/failed evidence exits 1,
and audited numerical PASS exits 0. Reports bind native/WASM firmware hashes,
airframe, parameters, commands, sensors, seed and rate. Raw files and firmware
remain local; source/build identity changes invalidate acceptance.

`admitWasmParity(bytes, trustedReportSha256, activeIdentity)` cold-validates
the report hash, identities, fixed limits and both passing scenarios, issuing
an in-memory frozen capability. The expected hash comes from trusted local
acceptance configuration, not from the downloaded report. An issued capability
and matching active identity are mandatory for
`AutopilotSession.connect('wasm-sitl', epoch, nowMs, capability, identity)`.
Copied/serialized capabilities, failed reports and changed configurations
are rejected. Connection only enters initializing; live health/warmup and
actuator freshness remain necessary. The low-level HAL harness is diagnostic
and does not issue this lifecycle capability. Application backend selection,
whole-firmware allocator qualification, GPL redistribution and release gates
remain separate; the active application keeps its demo backend.

## Vehicle manifest v2 and ArduPilot profile (TASK-087)

`packages/physics/src/vehicle.schema.json` and `vehicle-manifest.ts` define
`schemaVersion: 2`. Input starts as `unknown`, passes an AJV strict-mode schema
(`strictNumbers`, union types only for nullable sections, `kind`
discriminators), then physical and cross-reference checks, and returns a
deep-frozen snapshot. Units, frames and quaternion order are those of v1 (SI,
NED world, FRD body, wxyz). Every `*BodyM` position is measured from the body
reference point; the CG is `massProperties.cgOffsetBodyM` and the inertia is
about the CG in body axes. Every top-level key is required: an absent section
is an explicit `null` or `[]`, never a default. A minimal valid manifest is a
rotorless body:

```json
{
  "schemaVersion": 2, "modelId": 2, "kind": "demo",
  "units": "SI", "worldFrame": "NED", "bodyFrame": "FRD", "quaternionOrder": "wxyz",
  "datasets": [{ "id": "airframe", "kind": "synthetic", "sourceSha256": null,
    "derivation": "Hand-specified example body." }],
  "provenance": { "massProperties": "airframe", "rotors": null, "motors": null, "escs": null,
    "battery": null, "airframeDrag": null, "controlSurfaces": null, "landingGear": null,
    "sensorMounts": null, "rotorWakePairs": null },
  "massProperties": { "massKg": 1.5, "cgOffsetBodyM": [0.01, 0, 0.03],
    "inertiaCgKgM2": [0.03, 0, -0.001, 0, 0.032, 0, -0.001, 0, 0.05] },
  "rotorCount": 0, "rotorCapacity": 32, "rotors": [],
  "motors": [], "escs": [], "battery": null, "airframe": { "drag": null },
  "controlSurfaces": [], "landingGear": [], "sensorMounts": [], "rotorWakePairs": [],
  "ardupilot": null
}
```

| Section | Fields | Checks beyond the schema | Runtime consumer |
|---|---|---|---|
| `datasets` (1–32) | `id`; `synthetic`: `sourceSha256` (hex or `null`), `derivation`; `measured`: `sourceSha256`, `license`, `acquiredAt` (UTC `YYYY-MM-DDThh:mm:ssZ`), `reference` | unique IDs, parseable time, every dataset referenced | — |
| `provenance` | one dataset ID or `null` per section | non-null exactly when the section has data; known IDs | — |
| `massProperties` | `massKg` > 0, `cgOffsetBodyM`, `inertiaCgKgM2` | exact symmetry, Cholesky positive definiteness, rigid-body triangle inequality | v1 runtime (TASK-033) |
| `rotors` (≤32) | v1 `RotorGeometry`, unchanged; the schema is test-enforced identical to v1 | the v1 checks: unique IDs and channels, unit hub quaternions (1e-6), stations, quadrature widths | v1 runtime |
| `motors` (≤32) | `id`, `rotorId`, `kvRpmPerV`, `resistanceOhm`, `currentLimitA` (native `Motor`); optional `noLoadCurrentA` ≥0 (TASK-092) | unique IDs, known rotor, one motor per rotor | the ESC drive (TASK-092) |
| `escs` (≤32) | `id`, `motorId`, integer `pwmMinUs`/`pwmMaxUs` in [800, 2200], `commandTauS`; optional `updateRateHz` >0 and `brakeCurrentLimitA` ≥0 (TASK-092) | span ≥100 µs (the `ExternalSitl` boundary), known motor, one ESC per motor | PWM via the profile; lag, hold and braking in the ESC drive (TASK-092) |
| `battery` | `openCircuitFullV`, `openCircuitEmptyV`, `internalResistanceOhm` ≥0, `capacityAh`, `currentLimitA` (native `Battery`, charge 3600·Ah C) | full ≥ empty | TASK-092 |
| `airframe.drag` | `dragAreaBodyM2` (C_D·A tensor, m²), `centerOfPressureBodyM`; optional `maxAirspeedMps` > 0 (TASK-096) | symmetric positive definite, so drag always dissipates | the BET flight dynamics through `buildProfileDynamics` (TASK-096) |
| `controlSurfaces` (≤16) | `id`, `function`, `actuatorChannel`, deflection limits within ±π/2, `rateLimitRadS` | unique IDs and channels, not a rotor channel, min < max | TASK-109 |
| `landingGear` (≤8) | the `ContactWheel` fields plus `id` (the cornering stiffness excepted; optional `kineticFrictionRatio`); anchor from the reference point | unique IDs, rim < tire, last tire knot ≥ tire − rim, kinetic friction ratio in (0, 1]; strut and tire laws stay native | TASK-095 |
| `hull` (optional, 1–16) | `id` 0–15 and a capsule (`startBodyM`, `endBodyM`, `radiusM`) or a cylinder (`centerBodyM`, unit `axisBody`, `radiusM`, `halfHeightM`), from the reference point; its own `provenance.hull` dataset | unique IDs, positive radius and half-height, unit axis within 1e-12; present exactly with `provenance.hull`; a manifest without it keeps its bytes | the ground contact (TASK-095); `projectVehicleToModelV1` refuses it |
| `sensorMounts` (≤32) | `sensor`, `instance` (0–7), `positionBodyM`, `sensorToBody` | unique sensor/instance pairs, quaternion norm within 1e-6 | the sensor pipeline (TASK-147); never the rigid body |
| `rotorWakePairs` (≤64) | `upstreamRotorId`, `downstreamRotorId` | known rotors, no self or duplicate pairs, acyclic | TASK-101 |
| `ardupilot` | `vehicle: "copter"`, `frameClass`, `frameType` | only 1/1 (quad X) is admitted, with the geometry check below | parameter profile |

The inertia check follows from J = ∫(|r|²·1 − r·rᵀ) dm: every principal
moment is at most the sum of the other two, with equality for a planar body.
The admitted slack is 1e-12·trace, which covers only eigen-solver round-off.
Capacities match the existing interfaces: 32 rotors (v1), 8 wheel slots
(contact ABI v2), 16 control surfaces and 32 actuator channels.

A declared quad X frame is checked against the TASK-047 parity aircraft that
ArduCopter flew. Actuator channels 0–3 hold FR, RL, FL and RR. CG-relative hub
quadrant signs (x, y) are (+,+), (−,−), (+,−) and (−,+), and no hub may lie on
a CG plane. Each hub thrust axis +z_h must be within 45° of body up. The spin
axis s·R(q_hb)·ẑ must point up (counter-clockwise seen from above) for
channels 0–1 and down for channels 2–3. Other frame classes and types have no
repository evidence and are rejected.

`deriveVehicle` returns ascending principal moments and a right-handed matrix
of unit principal axes. It uses cyclic Jacobi rotations (Golub and Van Loan,
algorithm 8.5.3), at most 50 sweeps; after four sweeps, entries below the
diagonal precision are zeroed. Degenerate moments have no unique axes. Two
analytic oracles hold to 1e-12 relative: the x–z block of the fixture tensor
and a rotated diagonal tensor. `deriveVehicle` also returns CG-relative hub,
gear and sensor positions and the motor torque constant:

\[
k_t = k_e = \frac{60}{2\pi \cdot KV}
\]

`migrateModelManifestV1(input, dataset)` validates a v1 manifest and makes the
CG the reference point (zero offset). It copies mass, inertia and rotors
unchanged and assigns the provenance stated by the caller. A v1 tensor that
violates the triangle inequality is rejected, not altered.
`projectVehicleToModelV1` returns the CG-referenced v1 descriptor (hub minus
CG) used by `FrameLayout` and `BetFlightDynamics`. It fails closed, naming the
owning task, for any motor, ESC, battery, drag, surface, gear, sensor mount,
wake pair or ArduPilot frame data. The demo quad, the tilted octo and the
parity base quad round-trip exactly.

`ardupilotParameterProfile({ sha256, manifest }, { thrustExpo? })` (profile
v2, TASK-092) needs an admitted frame and a motor plus ESC for every rotor, all
sharing one PWM range. It emits two comment lines and then `NAME value` lines
sorted by name, with LF line endings and a final newline. For the fixture,
whose battery spans 16.8 V to 13.2 V open-circuit:

```text
# MirageSITL ArduPilot parameter profile v2
# modelId 87; manifest sha256 <64 lowercase hex>
BATT_MONITOR 4
FRAME_CLASS 1
FRAME_TYPE 1
MOT_BAT_VOLT_MAX 16.8
MOT_BAT_VOLT_MIN 13.2
MOT_PWM_MAX 2000
MOT_PWM_MIN 1000
```

With a battery the drive delivers the bus voltage and current, so
`BATT_MONITOR 4` reads both and voltage compensation spans the pack's
open-circuit range (`MOT_BAT_VOLT_MAX` full, `MOT_BAT_VOLT_MIN` empty; the
pinned firmware raises the minimum to at least 0.6 of the maximum). Without a
battery the profile keeps `MOT_BAT_VOLT_* 0`, as in the TASK-047 parity
defaults, and omits `BATT_MONITOR`. `thrustExpo`, finite within [−1, 1], adds
`MOT_THST_EXPO`; absent, the firmware default stays. The profile emits only
parameter names that appear in `scripts/sitl/driver.mjs`,
`scripts/prepare-autopilot-parity.mjs`, `packages/autopilot/src/external-sitl.ts`
or the pinned copter defaults of `tests/fixtures/sitl/ardupilot-catalog.json`;
the test enforces this. `INS_POS*` and `SIM_*` names stay with the sensor
configuration (TASK-147).

`VehicleRegistry` hashes the exact payload bytes (≤1 MiB, fatal UTF-8) and
admits schemas 1 and 2. A model ID with a different hash is a collision.
`PhysicsSessionV2` accepts an optional `SessionModelPort` as its fifth
constructor argument; without one, `model.load` is rejected with
`ASSET_MISSING` as before, so the default demo backend is unchanged.
`registryModelPort(registry, build)` requires a registered ID, a hash equal to
the registered one (the request may use upper-case hex) and a successful
projection. The prepared dynamics must report the loaded model ID. Commit
disposes the previous dynamics and keeps the factory, so `sim.configure`
rebuilds the loaded model at the new rate. A failed load keeps the active
model and epoch. A load interrupted by `worker.dispose` builds no dynamics
and ends with `BAD_STATE`.

Open items:

* The native SITL driver still writes its fixed `quad.parm`. Generating that
  file from a manifest changes the driver's source identity, so the
  TASK-042/043/059 captures would have to be regenerated.
* No application path registers models.
* Polar bindings and per-rotor runtime values remain in `BetFlightConfiguration`.

## Fidelity evidence pipeline (TASK-090)

`packages/physics/src/fidelity-metrics.ts` and `bench-import.ts` are offline
evidence code. They allocate and are never called from a physics step.

`timeDomainMetrics(measured, simulated)` compares two equally sampled series
of equal length. It returns the RMS error, the bias (mean of simulated minus
measured) and the Theil inequality coefficient U. U lies in [0, 1], is 0 for a
perfect match, and is rejected as undefined when both series are all zero:

\[
U = \frac{\sqrt{\frac{1}{n}\sum_i (s_i - m_i)^2}}{\sqrt{\frac{1}{n}\sum_i s_i^2} + \sqrt{\frac{1}{n}\sum_i m_i^2}}
\]

`welchFrequencyResponse(input, output, fs, N, overlap, window)` averages
K ≥ 2 segments of power-of-two length N in [16, 65536]. A single segment would
give γ² = 1 identically. Each segment has its mean removed and is multiplied by
a periodic Hann or a rectangular window. The radix-2 FFT uses
X_k = Σ x_n·e^(−j2πkn/N), and the one-sided bins k = 1..N/2 lie at
f_k = k·fs/N. Window scale factors cancel in both ratios:

\[
\hat H(f_k) = \frac{\sum_s X_s^*(f_k)\,Y_s(f_k)}{\sum_s |X_s(f_k)|^2},\qquad
\hat\gamma^2(f_k) = \frac{\left|\sum_s X_s^* Y_s\right|^2}{\sum_s |X_s|^2 \sum_s |Y_s|^2}
\]

A bin whose input power is at most 1e-20 of the strongest bin is unexcited:
its H is NaN and its γ² is 0. An f64 FFT bin carries about 1e-32 of
round-off power, so this floor is twelve decades above round-off and 200 dB
below the strongest bin.

`frequencyResponseCost(reference, model, { bandHz, points, minCoherence })`
computes the CIFER-style cost:

\[
J = \frac{20}{n}\sum_{i=1}^{n} W_\gamma(f_i)\left[W_g\,(\Delta|H|_{dB})^2 + W_p\,(\Delta\angle H_{deg})^2\right],\qquad
W_\gamma = \left[1.58\left(1 - e^{-\gamma^2}\right)\right]^2
\]

The cost uses W_g = 1 and W_p = 0.01745, so 1 dB weighs as much as 7.57°.
`points` target frequencies are spaced logarithmically over the band and each
is mapped to its nearest bin; a bin shared by several targets counts once.
W_γ uses the reference (measured) coherence. Points with γ² below
`minCoherence` are excluded, and n counts the points that remain. Phase
differences are wrapped to (−180°, 180°], so a constant mismatch gives the
same J for any n. The guidelines are J ≤ 100 for an accepted model, J ≤ 50 for
a model nearly indistinguishable from flight, and γ² ≥ 0.6 for usable points.

Sources: the weights, W_γ, the J guidelines and the coherence threshold are
those reported by Ågren et al., "In-flight System Identification of the
Ingenuity Mars Helicopter" (NASA Ames, AIAA 2025), and by DLR's
system-identification retrospective (Journal of Aircraft, doi
10.2514/1.C037262). The 20/n normalization and logarithmic point spacing
follow Tischler and Remple, Aircraft and Rotorcraft System Identification,
2nd ed. (AIAA, 2012).

Bench CSV v1 describes a static thrust stand:

```text
mirage-bench-csv,1
diameterM,0.254
rpm,thrustN,torqueNm,airDensityKgM3
2000,0.610472757547,0.0100957820214,1.2
```

`importBenchCsv` accepts LF or CRLF and 1–10000 rows. Numbers must be strict
decimals (no `+`, hex, `Infinity` or empty fields). The diameter must be in
(0, 10] m, rpm > 0, and density in [0.05, 2] kg/m³, the envelope of
`atmosphereFromState`. Rows keep their file order. With n = rpm/60:

\[
C_T = \frac{T}{\rho n^2 D^4},\qquad C_Q = \frac{Q}{\rho n^2 D^5},\qquad C_P = 2\pi C_Q,\qquad
\mathrm{FM} = \sqrt{\frac{2}{\pi}}\,\frac{C_T^{3/2}}{C_P}
\]

The importer also scales thrust and torque to ISA sea-level density
(1.2250 kg/m³ from `isaTroposphere(0)`). It flags negative thrust, negative
torque and FM > 1, because momentum theory bounds free-air static thrust per
unit power. Flagged rows are kept. Bench CSV v2 (TASK-140), with stated
conditions and only the measured columns, is in section "Calculation modes
and measurement sets v1 (TASK-140)"; `importBenchCsv` still reads version 1
only.

Capture schema 2 (TASK-184) has this skeleton; every series must hold 2..2^20
finite samples. Schema 1 also declared limits (`limits` per time-domain
section, `maxCost`, and bench relative-error limits); by scope amendment SA-01
MirageSITL sets none, so schema 2 holds the same sections without them and
schema 1 is refused with that reason:

```json
{
  "schemaVersion": 2, "kind": "mirage-fidelity-capture",
  "provenance": { "source": "flight-test", "operator": "<name>", "recordedAt": "2026-10-26T00:00:00Z",
    "firmwareSha256": "<64 hex>", "modelSha256": "<64 hex>" },
  "timeDomain": [{ "id": "roll-rate", "unit": "rad/s", "sampleRateHz": 100,
    "measured": ["<samples>"], "simulated": ["<samples>"] }],
  "frequencyResponse": [{ "id": "roll-rate-response", "sampleRateHz": 100, "segmentLength": 64,
    "overlap": 0, "window": "rectangular", "bandHz": [1.5625, 46.875], "points": 20,
    "minCoherence": 0.6,
    "measuredInput": ["<samples>"], "measuredOutput": ["<samples>"],
    "simulatedInput": ["<samples>"], "simulatedOutput": ["<samples>"] }],
  "bench": { "csv": "<bench CSV v1 text>", "csvSha256": "<64 hex>",
    "predicted": [{ "rpm": 2000, "ct": 0.1122, "cp": 0.04365 }] }
}
```

The simulated series come from replaying the measured excitation: the same
samples in the time domain and the same injected input for frequency
responses. Bench predictions list one row per measured row at the same rpm.

`node scripts/fidelity-capture.mjs --real REAL.bin --simulated RUN.bin ...` writes
such a capture from two DataFlash logs, a flight and the simulation of it: a
time-domain section for each `FIDELITY_SERIES` quantity both logs hold, and for each
axis the requested-to-actual rate response of the RATE message, resampled to the real
log's rate. The source comes from the real log (`logOrigin`), so a log with SITL
settings or MirageSITL's messages is `synthetic` whatever the file is called; the
capture names both logs by SHA-256. What a log lacks or what cannot be computed is
left out and listed, never given a number.

`node scripts/check-fidelity.mjs --input CAPTURE.json --sha256 HEX` builds on
`scripts/validation/evidence.mjs`, which enforces the hash and a 32 MiB size
budget. It requires exact keys everywhere, unique section IDs, at most 32
sections per kind and at least one section in total, and it computes each
section's metrics: RMS, bias and Theil per time-domain section, J with its
points and excluded points per frequency response, and per bench file the
rows compared, the rows with a consistency flag (listed with their flags and
left out of the errors) and the largest CT and CP relative errors.
`minCoherence` is part of the method, the coherence below which a frequency
point is unusable, and is never below the 0.6 guideline; nothing in the capture
or the report is a fidelity limit, and nothing passes or fails a model.

Exit codes:

* No input gives BLOCKED_EXTERNAL (2).
* Malformed or unhashed input, a capture schema 1, or a limit written into
  schema 2 gives FAIL (1).
* `synthetic` provenance gives BLOCKED_EXTERNAL (2) with the computed metrics;
  synthetic data compare MirageSITL with no aircraft.
* `flight-test` provenance with non-zero firmware and model hashes gives
  REPORTED (0): the metrics, for the user to judge.
* `bench-test` provenance (capture schema 3 only, see "Capture schema 3 and
  the bench-test captures" below) gives REPORTED (0); in schema 2 it gives
  FAIL (1).

The report `test-results/validation/fidelity.json` (schema 1, kind `fidelity`)
records the input hash, the git revision and the validator hash. The analytic
fixture `tests/fixtures/validation/fidelity-synthetic-capture-v2.json` (the
schema 1 fixture's series without its limits) reports J = 19.950 = 20·W_γ(1)
for its +1 dB model error and exits 2; the schema 1 fixture is kept for the
refusal.

Open items, all closed on 2026-11-08 (see below):

* Score a real ArduCopter SYSTEMID flight capture and a real thrust-stand
  file (G4): the Pavo SystemId flights and the two bench-test captures.
* Convert DataFlash logs to capture schema 2: `scripts/fidelity-capture.mjs`.
* Build the simulation replay that produces the simulated series: the SITL
  flight of each real sweep.

SystemId flights of the Pavo20 Pro II (2026-11-08), declared before the simulated flight was flown.
The real flights are the stakeholder's Pavo SystemId logs of `data/flight-logs/inventory.json`: 33 and
34 with SID_AXIS 4 (recovery roll), 35 with 5 (recovery pitch) and 36 with 6 (recovery yaw), each with
SID_MAGNITUDE 3°, SID_F_START_HZ 0.5, SID_F_STOP_HZ 40, SID_T_FADE_IN 1, SID_T_REC 70 and SID_T_FADE_OUT 1
s, entered from Stabilize with the throttle by hand, on ArduCopter V4.6.3; log 34 swept twice and is
compared on its complete second sweep. Each is simulated by native ArduCopter V4.7.2 (`fb77356`, the
TASK-198 build) flying the Pavo profile ("The Pavo20 Pro II profile") in JSON lockstep at 800 Hz:
`tests/sitl-systemid-pavo.test.ts` flies as `tests/external-sitl-flight.test.ts` does, through the
launcher, `PhysicsSessionV2` and `SitlJsonLink`, on the synthetic pad (no contact module): a GUIDED
take-off to 5 m and 5 s of hover, so that ArduPilot learns MOT_THST_HOVER; then Stabilize under RC
override at 25 Hz, the sticks centred and the throttle from a pilot model holding 5 m (1500 us, plus 30
us per metre below 5 m and minus 40 us per m/s of climb, within ±150 us), as the real pilot held height
by hand; after 3 s SYSTEMID with the axis's logged SID_* values, until ArduPilot reports "SystemID
Finished"; then LAND. Parameters: the real log's attitude controller (every ATC_RAT_* of the three axes,
ATC_ANG_*_P, ATC_INPUT_TC, ATC_RATE_FF_ENAB, ATC_RATE_*_MAX, ATC_THR_MIX_*, ATC_ANGLE_BOOST), its V4.6
names under V4.7.2's (ATC_ACCEL_R/P/Y_MAX in cdeg/s² as ATC_ACC_R/P/Y_MAX in deg/s², ANGLE_MAX in cdeg
as ATC_ANGLE_MAX in degrees), INS_GYRO_FILTER, INS_ACCEL_FILTER, MOT_THST_EXPO, MOT_SPIN_ARM, MOT_SPIN_MIN,
MOT_SPIN_MAX, MOT_HOVER_LEARN, the starting MOT_THST_HOVER, MOT_BAT_VOLT_MAX and MOT_BAT_VOLT_MIN and
LOG_BITMASK; the profile's frame parameters; and MOT_PWM_MIN 1000 and MOT_PWM_MAX 2000, the span the
link maps to ESC duty (the real ESCs take DShot600). Left out, each a stated difference: the harmonic
notch (the real one follows the ESCs' speed telemetry, which this link does not give, so
INS_HNTCH_ENABLE 0), ATC_SLEW_YAW (no V4.7.2 name; it limits autonomous yaw only), INS_GYRO_RATE, and the
real pilot's own sticks during the sweep (the real flights lean 5 to 10° and hold height by hand).

Compared, for each log: `scripts/fidelity-capture.mjs` over the sweep, from the SIDS record to the
"SystemID Finished" message of each log (`--from`, `--to`, and `--simulated-offset` from the two
starts), with the script's fixed method: per axis the requested-to-actual rate response of RATE at the
real log's 400 Hz, Hann segments of 1024 samples with half overlap, 20 points spaced logarithmically
from 0.78 to 20 Hz and the coherence guideline 0.6; and the time-domain sections it finds.
`scripts/check-fidelity.mjs` reports RMS, bias, Theil and J as REPORTED, with no limit and no verdict
(SA-01). The swept axis's response is the comparison; the other axes and the time-domain rows compare
two flights whose pilots differ, which the report states beside them. The capture's firmware hash is the
SITL executable's (no binary of the real board's V4.6.3 is held) and its model hash the derived Pavo
manifest's. The SITL log is simulated, the capture names it by SHA-256, and nothing calls it real data.

Result (2026-11-08; `tests/sitl-systemid-pavo.test.ts` with `MIRAGE_SYSTEMID_LOG` 33, 34, 35 and 36, each
exit 0, about 36 s of wall time for 144 s of simulated flight at speed 4, no lockstep gap or duplicate;
reports `test-results/validation/pavo-systemid-log33.json` to `log36.json`, each `REPORTED`). The
validator's call in the test was corrected after the declaration's commit (`scripts/check-fidelity.mjs`
takes no `--out`; its report is copied instead), and the flight is as declared. Every simulated sweep
ran its 77 s, from SIDS to "SystemID Finished", as the real ones did. The pilot model held 2.5 to 3.0 m,
not 5 m: its proportional term leaves the hover about 2 m low, and the real log 34 swept at about 10 to
18 m by the barometer. J of the swept axis, over the points where the real flight's coherence is at least
0.6:

| Log | Axis | J | Points (excluded) | Real, 1–4 Hz | SITL, 1–4 Hz | Real, 10.2 Hz | SITL, 10.2 Hz |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 33 | roll | 188.3 | 18 (0) | 0.2 to 0.4 dB, −8 to −21° | 0.2 to 0.8 dB, −7 to −22° | 1.1 dB, −68° | 3.2 dB, −92° |
| 34 | roll | 238.5 | 18 (0) | −0.5 to 0.2 dB, −16 to −22° | 0.1 to 0.7 dB, −7 to −22° | 1.1 dB, −63° | 3.3 dB, −91° |
| 35 | pitch | 276.6 | 18 (0) | 0.4 to 0.6 dB, −6 to −22° | 0.2 to 1.2 dB, −7 to −23° | 1.8 dB, −81° | 3.8 dB, −124° |
| 36 | yaw | 7.9 | 10 (8) | −0.8 to 0.8 dB, −10 to −24° | −0.2 to −0.1 dB, −7 to −22° | coherence below 0.6 above 5.1 Hz | |

Up to about 4 Hz the simulated rate loop follows the real one within about 1 dB and a few degrees on
every swept axis. Above about 5 Hz the simulated roll and pitch loops peak higher and earlier (3.2 dB at
10 Hz in roll and 4.7 dB at 8.6 Hz in pitch, against the aircraft's 1.9 to 2.4 dB at 12 to 14 Hz) and lag
more (at 16.8 Hz −178° against −135° and −125° in roll), so the model's closed loop has less phase margin
than the aircraft's at the same gains; in yaw the real response is coherent only
to 5.1 Hz. The cross-axis responses of each log (for example pitch in a roll sweep, J 1435 on log 33)
and every time-domain row compare two flights whose pilots, heights and leans differ, and are reported
only as such (log 34's height bias −10.5 m is the difference of the sweep heights). What the model
assumes and could make the high-frequency difference, none established by these logs: the motor's
resistance and the rotor inertia (a 1.0 g propeller, no motor rotor), which set how fast the speed
follows the command; the body inertia from a sum of parts; the ESC's lag of one 400 Hz period; and the
assumed blade geometry, with which the rotor hovers 17 % faster than the aircraft's. The harmonic notch
left out of the SITL would add lag to the real loop, not remove it. With these four flights the
SystemId item of the G4 criterion has its real captures, scored; the SITL logs and captures stay in
the run's directory, named by SHA-256 in the reports, and are not committed.

Capture schema 3 and the bench-test captures (2026-11-08), declared before either capture was written.
An exploratory run of the two prediction paths came first: it showed the T-Motor predictions with and
without dynamic inflow (below). No choice here follows its numbers, and nothing here is a limit.

Capture schema 3 is schema 2 with three changes. Schema 2 captures are accepted and reported exactly as
before.

* `provenance.source` may also be `bench-test`: a static thrust stand beside the propulsion model alone.
  A bench-test capture has empty `timeDomain` and `frequencyResponse`, at least one bench section, no
  `logs`, a `firmwareSha256` of 64 zeros (no firmware takes part) and a non-zero `modelSha256`, the
  SHA-256 of its model description (below). A schema 2 capture with source `bench-test` is refused,
  FAIL (1), with the reason "Provenance source bench-test needs capture schema 3".
* `bench` is an array of at most 32 sections with unique identifiers, each `{ id, csv, csvSha256,
  predicted }`: a bench CSV v1 holds one diameter, and one stand campaign may test several propellers.
  An empty array means no bench data.
* Every predicted row is `{ rpm, ct, cp, modelFlags }`. `modelFlags` lists, without repeats, the
  validity bits the model raised for that prediction: `outside-polar` (a blade section outside its polar
  table, bit 2 of the rotor's flags word), `low-confidence-polar` (a section on polar data below the
  confidence floor, bit 4) and `outside-inflow-validity` (the inflow model outside its validity, bit 8,
  or the steady runner's momentum-validity bit). Any other name is refused.

For each schema 3 bench section `scripts/check-fidelity.mjs` reports what it reports for a schema 2
bench file, and also the predictions with model flags (`modelFlaggedRows`, and `modelFlagged` with each
row's flags) and `withinModelValidity`: the compared rows without a model flag, with their largest CT
and CP relative errors. Model-flagged rows stay in the main errors, since they are what the model
predicts there. A bench-test capture is REPORTED (exit 0) with the reasons "The metrics are reported
without a limit or a verdict (SA-01); the user judges them" and "Bench-test capture: no firmware takes
part; the propulsion model alone is compared with a static thrust stand", and per section the count of
flagged measured rows and of predictions with model flags.

```json
{
  "schemaVersion": 3, "kind": "mirage-fidelity-capture",
  "provenance": { "source": "bench-test", "operator": "<name>", "recordedAt": "2026-07-28T00:00:00Z",
    "firmwareSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "modelSha256": "<64 hex>" },
  "timeDomain": [], "frequencyResponse": [],
  "bench": [{ "id": "mn7005-kv230-p24x72", "csv": "<bench CSV v1 text>", "csvSha256": "<64 hex>",
    "predicted": [{ "rpm": 2023, "ct": 0.1053, "cp": 0.03578, "modelFlags": [] }] }]
}
```

`node scripts/bench-capture.mjs [--out DIR]` writes the two bench-test captures below, each with its
model description `<name>-model.json` (kind `mirage-bench-model`), into `test-results/validation/` or
DIR. A model description names what produced the predictions, and the capture's `modelSha256` is the
SHA-256 of the description file's bytes. TypeScript that is neither compiled into a named module nor
hashed in a description (the profile derivation, the static solve, the request builder) is identified
by the git revision of the commit that holds the capture.

T-Motor MN7005 KV230 with the P24*7.2" CF propeller, `bench-tmotor-mn7005-p24x72-capture.json`, one
section `mn7005-kv230-p24x72`:

* Measured: T-Motor's datasheet table as transcribed in bench CSV v2,
  `tests/fixtures/components/tmotor-mn7005-kv230-p24x72.csv`: manufacturer static-stand data whose stand
  and air are not stated. The bench CSV v1 copies, as text and in file order, the diameter (0.6096 m),
  each row's rpm, thrustN and torqueNm, and the v2 file's air density, 1.225 kg/m³, in every row. That
  density is an assumption, since the datasheet states none; the voltage and current columns are not
  compared. Operator "T-Motor (manufacturer datasheet)"; recordedAt 2026-07-28T00:00:00Z, the day the
  table was posted (the propeller card's source date), not the unknown day of the test.
* Predicted: the repository's own model, uncalibrated. The forum quad profile
  `tests/fixtures/aircraft/tmotor-mn7005-quad.json` with the T-Motor motor, propeller and ESC cards, the
  forum battery card and the polar `naca6409-neuralfoil-v1`, built as `tests/tmotor-bench-fit.test.ts`
  builds it (`deriveVehicleManifest` with model ID 145, then `buildProfileDynamics`), gives rotor 0: the
  card's derived BET geometry (`derivePropellerGeometry`, whose flags are root-cutout-assumed,
  chord-assumed, twist-from-pitch and airfoil-unspecified) on its catalog polar, unscaled. Not the
  TASK-145 calibration, which is fitted on this same table. The rotor is bound as `BetFlightDynamics`
  binds it in flight: `profileRotorDefinition` with the configuration's dynamic inflow (Pitt-Peters with
  annular tip and hub losses, TASK-098) and its vortex ring seed for rotor 0. `staticLoads` of
  `packages/physics/src/propulsion-calibration.ts`, the TASK-145 static solve (400 steps at 800 Hz on a
  1e6 kg·m² shaft), gives the thrust, the torque and the rotor's flags word at each measured rpm, in air
  of density 1.225 kg/m³ with the ISA sea-level viscosity and speed of sound, on the scalar BET module
  that `node scripts/build-wasm.mjs` builds; then CT = T/(ρn²D⁴) and CP = 2πQ/(ρn²D⁵) with that ρ and
  D = 0.6096 m. The model description holds the BET module's SHA-256, the vehicle manifest's SHA-256,
  the SHA-256 of the bound rotor definition's JSON, the air, the derived geometry's assumptions and
  flags, and the SHA-256 of every input file.
* Until 2026-11-08 the TASK-145 static solve bound the rotor without dynamic inflow
  (`profileRotorDefinition` passed none), while flight binds it with; the exploratory run computed both.
  Since then `profileRotorDefinition` returns the flight's own binding (`flightRotorDefinition`), so the
  capture and TASK-145 solve the same rotor; the description says so.

UIUC DA4002 and DA4022 static tests, `bench-uiuc-da4002-da4022-static-capture.json`:

* Measured: the static tables of the 14 propellers in `tests/fixtures/rotors/uiuc-propellers.json`
  (UIUC propeller database volume 2, laboratory static-stand measurements, rows of rpm, CT and CP as
  printed), one bench section each, whose identifier is the propeller's with `.` written as `p`. Bench
  CSV v1 holds thrust and torque, so each row is converted with a stated density ρ = 1.225 kg/m³ (the
  fixture's comparison density) and the fixture's diameter D: T = CT·ρn²D⁴ and Q = CP/(2π)·ρn²D⁵ with
  n = rpm/60, each printed as the shortest decimal that reads back to the same float64 (JavaScript's
  `String`; an exponent stops the script), and the rpm as UIUC printed it. `importBenchCsv` turns them
  back into CT and CP with the same ρ and D, so the density cancels and the measured CT and CP equal the
  printed ones within float64 rounding (about 1e-15 relative); UIUC's own air density, which their
  reduction to coefficients used, does not enter. Operator "UIUC Applied Aerodynamics Group (Brandt,
  Deters, Ananda, Dantsker, Selig)"; recordedAt 2022-06-27T00:00:00Z, the date of the archive's README
  (the tests are older, and their dates are not in the fixture).
* Predicted: adapter `uiuc-propeller-bet-inflow-v1` of `scripts/validate-models.mjs`, the same BET path:
  the blade from r/R 0.3 (28 strips of the measured chord and twist, 8 azimuth samples), the extended
  SDA1075 polar `tests/fixtures/polars/sda1075-extended.json` with its rotational augmentation, and the
  flight model's dynamic inflow marched to a steady state by
  `cargo run -q --release --locked -p mirage-bet --example propeller_points -- --dynamic-inflow` in
  `native/`, at each static rpm with J = 0 in the fixture's air (1.225 kg/m³, 1.789e-5 Pa·s,
  340.294 m/s). The runner's polar flags and momentum-validity bit become the model flags, and a point
  it cannot solve stops the script. The model description holds the SHA-256 of the runner's request text
  (polar table, blades, points and air), of the extended polar and its XFOIL source, of the fixture and
  of the UIUC inventory, the runner command, and a digest of the native sources it builds: the SHA-256 of
  the sorted "path TAB sha256 LF" lines of the git-tracked files under `native/bet/` and of
  `native/Cargo.toml`, `native/Cargo.lock` and `native/rust-toolchain.toml`.

`tests/bench-capture.test.ts` runs the script into a temporary directory and requires the committed
descriptions to equal its output byte for byte, and the committed captures to equal it except that a
predicted CT or CP may differ by 1e-9 relative: the native runner's floating point may differ between
hosts (on the Mac that writes them they are byte-identical). A change to the BET code, a polar or an
input file changes a description and fails the test until the captures are written again, because a
committed capture describes the model of its commit. The test also holds the schema 3 rules above: the
refusals, schema 2 unchanged, and an analytic bench section whose model-flagged row moves the main
errors but not those within model validity.

Result (2026-11-08, on the M5 with Node 24.22.1 and rustc 1.97.0; `node scripts/bench-capture.mjs` exit 0, twice
with identical bytes). The captures were written as declared, and `node scripts/check-fidelity.mjs --input
CAPTURE --sha256 HEX` reports each REPORTED, exit 0, with no limit and no verdict. Written again on 2026-11-08
after the TASK-145 binding was aligned with the flight's: the T-Motor predictions are byte-identical, and only
its description's rotor-definition SHA-256 and binding note changed, so its two hashes below are new:

| Capture | SHA-256 | Model description | Sections | Rows compared | Measured rows flagged | Predictions with model flags | Largest CT error | Largest CP error | Within model validity: rows, CT, CP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-Motor MN7005 KV230 + P24*7.2 | `3ea50392…22c46a2f` | `34b615e7…7b07c262` | 1 | 11 | 0 | 1 (low-confidence-polar at 2596 rpm) | 0.652 | 1.001 | 10, 0.652, 1.001 |
| UIUC DA4002/DA4022 static | `df6e4490…34ae67d9` | `1dbab472…81009e3e` | 14 | 242 | 0 | 180 (outside-polar) | 0.270 | 0.385 | 62, 0.247, 0.271 |

The uncalibrated T-Motor rotor predicts too much: CT 47 to 65 % and CP 71 to 100 % above the datasheet,
the error growing with rpm (CT 0.1053 to 0.1068 against the table's 0.0718 to 0.0647). The derived
geometry assumes a constant chord of c/R 0.181 and blade angles from the nominal pitch; the table's
torque has two significant digits. The exploratory run's TASK-145 binding, without dynamic inflow, gave
CT 59 to 78 % and CP 67 to 96 % above it. On the UIUC propellers the errors are 27 % or less in CT and
39 % or less in CP, of both signs: the four 5-inch DA4002 propellers mostly under-predicted (to −27 % CT
and −39 % CP), the three 9-inch DA4022 mostly over-predicted (to +25 % CT and +28 % CP), the others either
way. At every 5-inch point, and at the 9-inch points below about 2700 to 5200 rpm, part of the blade lies
outside the extended polar's Reynolds range (20 000 to 200 000):
180 of the 242 predictions carry `outside-polar`, and the 62 within model validity, all on 9-inch
propellers, err by at most 25 % in CT and 27 % in CP. The SHA-256 above are of the committed files in
`test-results/validation/`, with their model descriptions beside them.

## Sensor-error ownership (TASK-089)

ArduPilot's SITL sensor backends read `sitl_fdm` and add their own errors on
both MirageSITL paths. On the native path the JSON line fills `sitl_fdm`, and
the aircraft model's `fill_fdm` adds the magnetic field. On the browser path the
HAL mailbox fills `sitl_fdm` directly and `fill_fdm` is skipped. Every error
must therefore be applied exactly once, by a declared owner.
`packages/autopilot/src/error-ownership.ts` assigns each error source to
`ardupilot` (the firmware's SITL backend applies it), `mirage` (MirageSITL
applies it in the values it delivers) or `none` (nobody applies it). Upstream
firmware is the default. A matrix may opt into a MirageSITL firmware patch only
to switch off an error that the pinned upstream applies unconditionally (see
"IMU noise-floor switch" below).

`python3 tests/fixtures/sitl/generate.py` writes
`tests/fixtures/sitl/ardupilot-catalog.json` from 13 files at the pinned commit
`fb773567896014da007bca58358704d4a0d8516f`, recording each file's SHA-256. The
GPL sources are not copied. The catalog lists:

* the 303 SIM_* parameters of the SITL tables and the barometer, airspeed and
  GPS sub-tables, with compiled defaults, `AP_Vector3f` flags scoped to each
  parameter class, and enclosing preprocessor conditions;
* the copter and JSON-backend defaults;
* the 36 keys of the `SIM_JSON` key table;
* 31 asserted source lines (facts). A different commit fails the generator;
* in schema 2, each MirageSITL firmware patch applied to the same sources.

`json-protocol.json` (TASK-041) is regenerated byte-identically. Three
cataloged facts constrain ownership:

* The IMU backend always adds 0.01 m/s² of uniform accelerometer noise and
  radians(0.04) of gyro noise, and no upstream parameter disables either floor.
  With the motors off and no vibration configured, it adds the gyro floor value
  a second time.
* The JSON backend sets accelerometer calibration defaults, such as
  `INS_ACCSCAL_X 1.001`.
* `SIM_BARO_RND` compiles to 0.2 m but `copter.parm` sets it to 0, while
  `SIM_DRIFT_SPEED` stays at its compiled 0.05.

A defaults-file name that a build lacks is skipped (`AP_Param.cpp`), so a
profile may neutralize every cataloged sensor instance.

Delivery paths need repository evidence, and a JSON key must be both in the
catalog and covered by the TASK-041 oracle:

| Delivery | Path | Evidence | Enablers |
|---|---|---|---|
| `json:imu.accel_body`, `json:imu.gyro` | native-json | TASK-041 JSON oracle | — |
| `hal:specific-force`, `hal:gyro`, `hal:magnetic-field` | browser-hal | `browser_hal.h` sensor values 6–8, 9–11, 16–18 | — |
| `mavlink:gps-input` | native-json | TASK-059 GPS_INPUT injection | `GPS1_TYPE 14`, `GPS2_TYPE 0`, `GPS1_RATE_MS 100` |
| `mavlink:sim-mag-offsets` | native-json | TASK-059 PARAM_SET of `SIM_MAGn_OFS_*` | — |

| Error source | ArduPilot neutral values (all cataloged instances) | ArduPilot applies on | MirageSITL deliveries |
|---|---|---|---|
| `imu.accel.noise-floor` / `imu.gyro.noise-floor` | none upstream (unconditional); with the `imu-noise-floor` patch `SIM_ACC_FLOOR 0` / `SIM_GYR_FLOOR 0` | both | accel / gyro fields, patched builds only |
| `imu.accel.noise` / `imu.gyro.noise` | `SIM_ACCn_RND 0` / `SIM_GYRn_RND 0`, n = 1–5 | both | accel / gyro fields |
| `imu.accel.bias` / `imu.gyro.bias` | `SIM_ACCn_BIAS 0` / `SIM_GYRn_BIAS 0` (vectors) | both | accel / gyro fields |
| `imu.accel.scale` / `imu.gyro.scale` | `SIM_ACCn_SCAL 0` (divides only if non-zero) / `SIM_GYRn_SCALE 0` (percent) | both | accel / gyro fields |
| `imu.gyro.drift` | `SIM_DRIFT_SPEED 0` | both | gyro fields |
| `imu.vibration` | `SIM_VIB_FREQ 0`, `SIM_VIB_MOT_MAX 0` | both | accel and gyro fields |
| `imu.lever-arm` | `SIM_IMU_POS 0` | both | accel fields |
| `imu.board-trim` | `SIM_ACC_TRIM 0` | both | none (at V4.7.2 it turns the accelerometer only, and MirageSITL offers no such error) |
| `baro.noise`, `.drift`, `.glitch`, `.delay`, `.wind` | `SIM_BARO/BAR2/BAR3_RND`, `_DRIFT`, `_GLITCH`, `_DELAY`, `_WCF_*` = 0 | both | none (altitude shares navigation truth) |
| `baro.ground-effect` | none: V4.7.2 has no barometer ground effect, so nobody applies one | neither | none |
| `mag.noise`, `mag.delay` | `SIM_MAG_RND 0`, `SIM_MAG_DELAY 0` | both | `hal:magnetic-field` |
| `mag.hard-iron` | `SIM_MAGn_OFS 0`, n = 1–3 | both | `mavlink:sim-mag-offsets`; `hal:magnetic-field` |
| `mag.soft-iron` | `SIM_MAGn_DIA 0` (identity), `SIM_MAGn_ODI 0`, `SIM_MAGn_SCALING 1` | both | `hal:magnetic-field` |
| `mag.anomaly` / `mag.motor` | `SIM_MAG_ALY 0` / `SIM_MAG_MOT 0` | native only (`fill_fdm`) | `hal:magnetic-field` |
| `gnss.receiver` | replaced by the GPS_INPUT enablers | both | `mavlink:gps-input` |

`parseArduPilotCatalog` checks that the catalog comes from the pinned commit.
`validateOwnershipMatrix(matrix, catalog)` rejects:

* double, missing or unknown sources and unknown owners or paths;
* a delivery without repository evidence, a delivery for another path, or a
  partial delivery: a MirageSITL owner lists exactly its source's deliveries on
  the matrix path;
* a parameter or fact missing from the catalog, or a parameter under a build
  condition other than `AP_SIM_ENABLED` and the IMU and compass instance counts;
* an `ardupilot` owner on a path where ArduPilot does not apply that error;
* `none` for an error that no cataloged parameter disables.

A matrix that does not declare the `imu-noise-floor` patch must leave both
IMU floors with ArduPilot; another unconditional error would need a new patch.

`ownershipParameterProfile(matrix, catalog)` writes the neutral values of
every error that MirageSITL owns or nobody applies (where ArduPilot applies
it), plus each delivery's enablers. Vectors expand to `_X`, `_Y` and `_Z`, and
lines are sorted by name. ArduPilot-owned errors keep the firmware's own
parameters untouched. For the TASK-059 native EW matrix, the profile holds
exactly the parameter lines of the driver's experiment block:

```text
# MirageSITL error-ownership profile v1
# matrix task-059-ew-native; path native-json; ArduPilot fb773567896014da007bca58358704d4a0d8516f
GPS1_RATE_MS 100
GPS1_TYPE 14
GPS2_TYPE 0
SIM_MAG1_OFS_X 0
SIM_MAG1_OFS_Y 0
SIM_MAG1_OFS_Z 0
SIM_MAG2_OFS_X 0
SIM_MAG2_OFS_Y 0
SIM_MAG2_OFS_Z 0
SIM_MAG3_OFS_X 0
SIM_MAG3_OFS_Y 0
SIM_MAG3_OFS_Z 0
```

`tests/fixtures/sitl/error-ownership.json` records three matrices:

* TASK-047 parity on the native path, where ArduPilot owns every error.
* TASK-047 parity on the browser path, where ArduPilot owns everything except
  `mag.anomaly` and `mag.motor`, which nobody applies.
* The TASK-059 native EW runs: `gnss.receiver` is owned through GPS_INPUT and
  `mag.hard-iron` through SIM_MAG offsets.

The parity profiles are empty. Unless a patched build switches them off,
ArduPilot's IMU floors stay on, so a MirageSITL IMU noise model (TASK-115) must
either subtract their variance or own the floors through the patch, never
double count them.

### IMU noise-floor switch (decision 2026-10-26)

The user decided that MirageSITL runs with ArduPilot's default behaviour by
default and that a setting switches off ArduPilot's fixed IMU noise floors on
request. No upstream parameter can do that, so
`native/ardupilot/patches/imu-noise-floor.patch` (SHA-256
`0cb35155f676914f7afe70abbcede25f69b1da0ee009b009138a781d8a819177`) changes
three pinned files: `libraries/SITL/SITL.h`, `libraries/SITL/SITL.cpp` and
`libraries/AP_InertialSensor/AP_InertialSensor_SITL.cpp`. It replaces the two
constants with parameters in the `var_ins` table:

| Parameter | Unit | Default | Index | Replaces |
|---|---|---|---|---|
| `SIM_ACC_FLOOR` | m/s/s | 0.01 | 57 | `float accel_noise = 0.01f;` |
| `SIM_GYR_FLOOR` | deg/s | 0.04 | 58 | `float gyro_noise = radians(0.04f);` |

The defaults are the upstream constants, so a patched build on default
parameters behaves exactly as upstream. 0 removes a floor and other values
scale it. The random draws stay in place, so later noise terms see the same
random sequence. Indices 57 and 58 lie in the gap below the IMUT subgroups
(59–63). A collision after a pin change stops the firmware at its parameter
table check.

The generator applies the patch strictly to the same pinned sources: every
hunk must match at its stated line, without fuzz. Catalog schema 2 records,
per patch:

* the patch path and SHA-256;
* each changed file's upstream and patched SHA-256;
* the SIM_* parameters it adds, parsed from the patched sources;
* the upstream facts it removes and the facts it establishes.

The generator also asserts that every added default equals the constant it
replaces. `parseArduPilotCatalog` rejects schema 1, a patch that changes a file
outside the catalog or other upstream bytes, a redefined upstream parameter
and a duplicate fact.

Ownership matrix schema 2 adds `firmwarePatches`; schema 1 targets upstream
firmware. `FIRMWARE_PATCHES` names the paths whose builds apply each patch.
`imu-noise-floor` is applied on `native-json` only, because the browser HAL
build does not apply it yet; declaring it on `browser-hal` is rejected. With the
patch declared, the floors behave as follows:

* `ardupilot` emits nothing, so the firmware runs on its defaults.
* `none` emits `SIM_ACC_FLOOR 0` and `SIM_GYR_FLOOR 0`.
* `mirage` emits the same lines and requires the accelerometer or gyro delivery
  of the path.

Without the patch, any owner other than `ardupilot` is rejected. A profile that
needs patched firmware appends `; patches <id> <sha256>` to its second header
line; upstream profiles are unchanged.

Ownership matrix schema 3 (TASK-147) adds eight sources: IMU latency and
misalignment, magnetometer misalignment, the SITL GNSS receiver's position
noise, velocity noise and delay, and battery voltage and current. A schema 1 or
2 matrix reads each of them as its stock owner and keeps its profile; section
"Sensor errors in the external-SITL path" has the table.

The setting is `imuNoiseFloorMatrix('ardupilot' | 'off', path)`. On the command
line:

```bash
node scripts/ownership-profile.mjs --imu-noise-floor off
```

`ardupilot` is the default and prints no settings. `off` prints:

```text
# MirageSITL error-ownership profile v1
# matrix imu-noise-floor-off-native-json; path native-json; ArduPilot fb773567896014da007bca58358704d4a0d8516f; patches imu-noise-floor 0cb35155f676914f7afe70abbcede25f69b1da0ee009b009138a781d8a819177
SIM_ACC_FLOOR 0
SIM_GYR_FLOOR 0
```

`node scripts/build-ardupilot-sitl.mjs --out DIR` builds the patched native
firmware on macOS, Linux or WSL. It verifies that `MIRAGE_SITL_SOURCE` is the clean
pinned checkout and copies it, then applies the patch to the copy and checks
every file hash against the catalog. It builds with
`./waf configure --board sitl` and `./waf copter`, checks that it is a native
executable of the host holding both parameter names, and writes `DIR/manifest.json`. Missing prerequisites exit
2. Upstream firmware skips unknown defaults-file names without any log line or
STATUSTEXT, so `off` on unpatched firmware changes nothing silently. Any runner
that applies `off` therefore reads both values back from the running firmware
before it trusts the setting; the native harness does (below).

Evidence (2026-10-26): native ArduCopter SITL runs on Linux at the pinned
commit, using the unchanged TASK-042 driver (`scripts/sitl/driver.mjs`
`c1a1e2a9…`, `scripts/sitl/telemetry.py` `3a386c88…`) and
`tests/fixtures/sitl/parameters.parm`. The floors-off run appends the `off`
profile. Firmware:

* upstream: ELF `b54bef09…`;
* patched: ELF `06846b05…`, built by the script with GCC 13.3.0.

`node scripts/check-imu-noise-floor.mjs --input CAPTURE --expect ardupilot|off
[--reference CAPTURE]` analyzes `HIGHRES_IMU` from 10 s until 1 s before arming
(about 10,400 samples at 333 Hz). The quad then rests on its floor, so ArduPilot
adds no throttle noise. The analyzer removes a least-squares line per axis,
which absorbs the `SIM_DRIFT_SPEED` gyro drift. The limits were set before
measurement from the upstream floor:

* `off`: residual standard deviation at most 1e-5 m/s² and 1e-6 rad/s;
* `ardupilot`: at least 1e-4 m/s² and 1e-5 rad/s.

`--reference CAPTURE` also compares the samples bit for bit, by firmware time,
until the first driver command of either run. MAVLink commands reach the
firmware at wall-clock times, so the flights may diverge after them.

| Run | Accelerometer residual (m/s²) | Gyro residual (rad/s) | Expected | Result |
|---|---|---|---|---|
| Upstream, defaults | 6.05e-4, 6.06e-4, 6.07e-4 | 4.78e-5, 4.78e-5, 4.68e-5 | `ardupilot` | PASS |
| Patched, defaults | identical to upstream | identical to upstream | `ardupilot` | PASS |
| Patched, `off` | 5.7e-11, 5.7e-11, 1.2e-6 (float32 at 9.8 m/s²) | 8.1e-8 on each axis | `off` | PASS |
| Upstream given the `off` lines | 6.05e-4, 6.06e-4, 6.07e-4 | 4.78e-5, 4.78e-5, 4.68e-5 | `off` | FAIL, as the negative control expects |

With defaults, the patched firmware's `HIGHRES_IMU` stream matches upstream bit
for bit until the first driver command: 13,099 of 13,099 samples in this pair.
Here the commands landed in the same firmware cycle, so all 27,362 samples of
the flight matched. In the harness pair below they arrived 52 ms apart, and
the flights diverged after the takeoff command. Both patched flights pass the
TASK-042 raw MAVLink and flight audits: 67,233 physics frames and a 10.19 s
hold. The reports are in `test-results/validation/task-089-imu-floor-*.json`.
The captures stay outside the repository and are identified there by hash.

Decision 2026-10-27: the native harness reads the setting.
`scripts/run-sitl.mjs` accepts `MIRAGE_SITL_IMU_NOISE_FLOOR` unset (meaning
`ardupilot`) or `off`, and rejects any other value. It passes the value to the
driver and records it in its report. With `ardupilot` the driver sends nothing
new, so default runs behave as before. With `off` the driver:

* appends the validated `off` profile to its `quad.parm`;
* asks for both parameters with PARAM_REQUEST_READ after the first heartbeat,
  and again every 5 s;
* holds its mode and arm commands until PARAM_VALUE reports both as 0;
* fails if that has not happened 20 s into the simulation.

`run.json` records the setting, the expected values and the reported values.
The sidecar forwards PARAM_VALUE only for the names the driver read back.
`scripts/sitl/check-raw.py` includes exactly those names, as declared in
`run.json`, in its independent comparison, so captures without the declaration
audit as before.

Harness evidence (2026-10-27), from `node scripts/run-sitl.mjs` with the same
two firmware builds:

| Firmware | Setting | run-sitl | Read-back | Floor analysis | TASK-042 audits |
|---|---|---|---|---|---|
| upstream | default | PASS | none sent | PASS (`ardupilot`) | PASS |
| patched | `off` | PASS, armed at 42.25 s | `SIM_ACC_FLOOR 0`, `SIM_GYR_FLOOR 0` | PASS (`off`), residuals as above | PASS |
| upstream | `off` | FAIL at 20 s, never armed | 4 requests, no reply | not applicable | not applicable |
| patched | default | PASS | none sent | PASS; the 13,082 samples before the first command match the upstream run | PASS |

These changes alter the driver, sidecar and raw-audit sources, so the frozen
TASK-059 matrix (`tests/fixtures/scenarios/ew-matrix.json`) no longer applied, as the
user accepted on 2026-10-27. TASK-171 froze it again with the current driver, on
macOS, and TASK-198 froze it again on ArduCopter V4.7.2. EW calibration and validation also bind the
firmware and parameter hashes, so both must use the same firmware and setting.
Earlier TASK-042/043 audits name the earlier `check-raw.py`; re-run it to
refresh them.

Open items:

* HAL payload v2 with byte fixtures and the TASK-046 browser check.
* Oracle tests for optional JSON keys (`battery.*`, `rng_*`, `airspeed`)
  before they become delivery paths.
* Airspeed and rangefinder sources.
* Rerunning TASK-047 parity whenever a delivery changes.
* Applying the `imu-noise-floor` patch in the browser HAL build
  (`scripts/build-ardupilot-hal.mjs`) with the TASK-046 checks; only then does
  `browser-hal` join the patch's paths.
* Re-freezing TASK-059 with the current driver on the operator's machine
  before new EW validation captures (decision 2026-10-27).

### Every SITL parameter declared

An error must not sit undecided, so `SIM_PARAMETERS_WITHOUT_A_SOURCE` declares why every
SIM_ parameter of the catalog that no error source lists has none. Of the 323, 96 belong
to a source and the other 227 fall in exactly one class. `tests/error-ownership.test.ts`
fails on a name in neither, so a pin change cannot add one unseen, and on an error active
by default outside a source.

| Class | What it holds | Why it has no source |
|---|---|---|
| `fault` | `SIM_ACCELn_FAIL`, `SIM_BAROn_FREEZE`, `SIM_MAGn_FAIL`, `SIM_GPSn_JAM`, `SIM_RC_FAIL` and the like | A fault a user injects, not a standing error; TASK-168 and TASK-169 own these |
| `inactive-error` | `SIM_GPSn_GLTCH`, `_DRFTALT`, `_ALT_OFS`, `SIM_AHRS_OFF_*`, `SIM_TIME_JITTER` and the like | Off at its default of zero; nothing here sets it, so if a user does, ArduPilot applies it once |
| `shapes-a-source` | `SIM_DRIFT_TIME`, `SIM_VIB_MOT_*`, `SIM_MAG_ALY_HGT`, `SIM_INS_THR_MIN` | Shapes an error whose amplitude a source switches off |
| `temperature` | `SIM_IMUT_*`, `SIM_TEMP_*` | An error only through the `SIM_IMUTn_` calibrations, disabled by default; TASK-115 defers temperature errors |
| `sensor-settings` | Sensor counts, `SIM_GPSn_HZ`, `_ACC`, `_NUMSATS`, device IDs and the like | Which sensors exist and how they report |
| `not-fitted` | `SIM_ARSPD*`, `SIM_SONAR_*`, `SIM_FLOW_*`, `SIM_GPS3_*`, `SIM_GPS4_*` and the like | A sensor S08 does not include and the S19 aircraft do not carry, or a GNSS instance that is not enabled |
| `environment-or-vehicle` | `SIM_WIND_*`, `SIM_TERRAIN`, `SIM_SHOVE_*`, `SIM_BATT_*` and the like | ArduPilot's environment or its own vehicle model; TASK-166 decides environment effects |
| `other-systems` | `SIM_ADSB_*`, `SIM_CAN_*`, `SIM_OSD_*`, `SIM_SPEEDUP` and the like | Simulated peripherals and the simulator itself |

### Live writes (S08)

`parameterWriteConflict(matrix, name)` reads the error a SITL parameter sets, counting a
vector's `_X`, `_Y` and `_Z` as its parameter. A write conflicts when ArduPilot applies that
error on the matrix's path and the matrix gives it to `mirage`, because it would be applied
twice, or to `none`, because it would add an error the experiment record says is not there.
An error ArduPilot owns stays free to change. The session passes the run's matrix to
`ParameterService`, which refuses a conflicting write before sending, as `refused` by
`service` with `parameterWriteConflictReason`, so every write path of the Parameters tab is
covered. A batch's set names are already refused against the generated parameters.

## Step interfaces v2 (TASK-088)

The step interfaces v2 extend the bound-rotor and rigid-body byte records once
for the Phase 8–10 inputs and outputs. The v1 interfaces stay unchanged as a
regression API. Bound-rotor arenas and their configuration remain v1:
`bet_bound_init`, `bet_bound_reset` and `bet_bound_dispose` serve both versions.

The new exports are `bet_bound_v2_version()->u32` (2),
`bet_bound_step_v2(arena,input,output,dt)->i32`, `bet_body_v2_version()->u32`
(2) and `bet_body_step_v2(input,output,dt)->i32`. They follow the v1 pointer
rules: caller-owned, 8-byte-aligned, pairwise disjoint regions at or above
`__heap_base`, and no memory growth after initialization. Records are little
endian. A version word leads every input record, and reserved words must be
zero. `native/bet/include/bet_bound.h` defines the sizes, bits and status.

### Bound rotor step input v2

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | version | version |
| 4 | u32 | bitmask | input_flags |
| 8 | u32 | enum | drive_mode |
| 12 | u32 | — | reserved_zero |
| 16 | f64 | kg/m^3 | density |
| 24 | f64 | Pa s | dynamic_viscosity |
| 32 | f64 | m/s | sound_speed |
| 40 / 48 / 56 | f64 × 3 | m/s | air_velocity_hub_x/y/z |
| 64 / 72 / 80 | f64 × 3 | rad/s | body_rate_hub_x/y/z |
| 88 | f64 | rad | collective |
| 96 | f64 | rad | cyclic_cos |
| 104 | f64 | rad | cyclic_sin |
| 112 | f64 | N m | motor_torque |
| 120 | f64 | 1 | esc_duty |
| 128 | f64 | V | bus_voltage |
| 136 / 144 / 152 | f64 × 3 | m/s | external_wake_hub_x/y/z |
| 160 / 168 / 176 | f64 × 3 | 1 | ground_normal_hub_x/y/z |
| 184 | f64 | m | ground_distance |
| 192 | f64 | Ω | motor_resistance |
| 200 | f64 | N m/A | motor_torque_constant |
| 208 | f64 | A | motor_current_limit |
| 216 | f64 | A | motor_brake_current_limit |
| 224 | f64 | N m | motor_no_load_torque |
| 232 | f64 | s | esc_command_tau |
| 240 | f64 | s | esc_update_period |
| 248 | u32 | bitmask | drive_flags |
| 252 | u32 | — | reserved_zero |

### Bound rotor step output v2

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 / 8 / 16 | f64 × 3 | N | force_hub_x/y/z |
| 24 / 32 / 40 | f64 × 3 | N m | air_moment_hub_x/y/z |
| 48 / 56 / 64 | f64 × 3 | N m | transmitted_moment_hub_x/y/z |
| 72 | f64 | rad/s | omega |
| 80 | f64 | N m | aerodynamic_shaft_torque |
| 88 | f64 | W | shaft_power |
| 96 | f64 | m/s | induced_axial |
| 104 | f64 | rad | cone_angle |
| 112 | u32 | bitmask | flags |
| 116 | u32 | bitmask | validity |
| 120 | f64 | kg m^2/s | angular_momentum_axial |
| 128 | f64 | m/s | inflow_cos |
| 136 | f64 | m/s | inflow_sin |
| 144 | f64 | A | motor_current |
| 152 | f64 | A | bus_current |
| 160 | f64 | W | electrical_power |
| 168 | f64 | W | copper_loss |
| 176..255 | u32[20] | — | reserved_zero |

Bound-rotor fields owned by later tasks, with their neutral values:

* `drive_mode` 0 (torque) with zero `esc_duty`, `bus_voltage` and drive
  parameters. TASK-092 implements mode 1 (section "Electromechanical drive");
  without valid drive parameters a mode 1 record is invalid (−3).
* Zero `external_wake_hub_x/y/z`. TASK-101 implements them (above, "Rotor wakes"): the step adds them to its air once, and a
  record without them is used as it came.
* `input_flags` bit 0 clear, with zero `ground_normal_hub_x/y/z` and
  `ground_distance`. TASK-100 implements the bit (above, "Ground effect").

Output `validity` bits mark quantities that need later tasks:

* 1: `motor_current`, `bus_current`, `electrical_power` and `copper_loss`
  (TASK-092).
* 2: `inflow_cos` and `inflow_sin` (TASK-098).
* 4: ground effect applied (TASK-100).
* 8: external wake applied (TASK-101).

An unavailable output is zero with its bit clear. `flags` keeps the v1
meanings.

### Rigid-body step input v2

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | version | version |
| 4 | u32 | enum | gravity_model |
| 8 | u32 | bitmask | input_flags |
| 12 | u32 | — | reserved_zero |
| 16 | f64 | kg | mass |
| 24..95 | f64[9] | kg m^2 | inertia_cg |
| 96 / 104 / 112 | f64 × 3 | m | position_n/e/d |
| 120 / 128 / 136 | f64 × 3 | m/s | velocity_n/e/d |
| 144 / 152 / 160 / 168 | f64 × 4 | 1 | quaternion_w/x/y/z |
| 176 / 184 / 192 | f64 × 3 | rad/s | omega_body_x/y/z |
| 200 / 208 / 216 | f64 × 3 | N | force_body_x/y/z |
| 224 / 232 / 240 | f64 × 3 | N m | moment_body_x/y/z |
| 248 | f64 | m/s^2 | gravity_down |
| 256 / 264 / 272 | f64 × 3 | m/s^2 | gravity_n/e/d |
| 280 / 288 / 296 | f64 × 3 | m | cg_offset_body_x/y/z |
| 304 | f64 | kg/s | mass_rate |
| 312..383 | f64[9] | kg m^2/s | inertia_rate |
| 384..447 | u32[16] | — | reserved_zero |

### Rigid-body step output v2

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 / 8 / 16 | f64 × 3 | m | position_n/e/d |
| 24 / 32 / 40 | f64 × 3 | m/s | velocity_n/e/d |
| 48 / 56 / 64 / 72 | f64 × 4 | 1 | quaternion_w/x/y/z |
| 80 / 88 / 96 | f64 × 3 | rad/s | omega_body_x/y/z |
| 104 / 112 / 120 | f64 × 3 | m/s^2 | acceleration_n/e/d |
| 128 / 136 / 144 | f64 × 3 | m/s^2 | specific_force_body_x/y/z |
| 152 / 160 / 168 | f64 × 3 | rad/s^2 | angular_acceleration_body_x/y/z |
| 176 / 184 / 192 | f64 × 3 | m | reference_position_n/e/d |
| 200 | u32 | bitmask | validity |
| 204..255 | u32[13] | — | reserved_zero |

Rigid-body fields owned by later tasks, with their neutral values:

* `gravity_model` 0 (constant `gravity_down` along NED down, the v1
  semantics) with zero `gravity_n/e/d`; models 1 (NED vector) and 2 (WGS84)
  are TASK-108.
* `input_flags` bit 0 clear, with zero `mass_rate` and `inertia_rate`
  (TASK-119).

Output `validity` bit 1 marks `specific_force_body_x/y/z` and is always set.
The body-frame force is constant over the step, so the CG specific force is
F/m exactly. TASK-094 sets bits 2 (`angular_acceleration_body_x/y/z`) and 4
(`reference_position_n/e/d`) on every step.

TASK-094 implements `cg_offset_body_x/y/z`. The state is the CG's, as
`inertia_cg` names it. r_c points from the body reference point O, about
which `moment_body` is given, to the CG; gravity acts at the CG. The step
moves the moment to the CG and then runs the v1 step:

$$
M_{cg} = M_O - r_c \times F
$$

This is the CG form of the equations of motion about O,
m(a_O + ω̇ × r_c + ω × (ω × r_c)) = F and
I_O·ω̇ + ω × (I_O·ω) + m·r_c × a_O = M_O with
I_O = I_cg + m(|r_c|²·1 − r_c·r_cᵀ); both give the same motion. A zero
offset, −0 included, skips the transfer, so output bytes 0..127 equal v1 bit
for bit. The outputs are ω̇ = I_cg⁻¹(M_cg − ω × I_cg·ω) at the end state and
p_O = p_cg − R·r_c. `BodyParameters::angular_acceleration` computes ω̇, and
`BetRigidBodyBackendV2` takes r_c as `cgOffsetBodyM` and reports
`angularAccelerationBodyRadS2` and `referencePositionNedM`. Earth-rotation
terms and the gravity models stay with TASK-108 (Phase 1: delivered by
TASK-148), and mass-property rates with TASK-119 (deferred).

`native/bet/tests/body_abi_v2.rs` checks, after 1 s at 400 Hz, the exact
single-axis rotation of a body-fixed force through O with r_c = (0.01, 0, 0) m
(ω_y = αt and θ = αt²/2 within 1e-9, α = −1.25 rad/s², with the reference
position within 1e-12). Over 400 steps of a tumbling body with products of
inertia it checks that the angular-acceleration output equals the ω̇ of the
coupled equations about O, solved as a 6×6 system, within 1e-12 relative.
It also checks that a −0 offset reproduces v1, and that an offset step makes
no allocation over 10^6 steps. `native/bet/tests/rigid_body.rs` checks torque-free
precession of an axisymmetric body, I = diag(0.05, 0.05, 0.08), with
ω₀ = (1, 0, 2) rad/s, against the closed form
ω = (ω₁ cos Ωt, ω₁ sin Ωt, ω₃), Ω = (I₃ − I₁)ω₃/I₁. It checks the same body
with its principal frame turned 0.7 rad about (1, 2, 3), so every product of
inertia is non-zero. Both hold the rates within 1e-9 relative and world
angular momentum within 1e-10 over 2 s at 400 Hz. `tests/rigid-body-v2.test.ts`
repeats the CG-offset case and the v1 bit equality through the WASM adapter.

Checks run in a fixed order: record length, version (−7), reserved words,
unknown flags and modes (−3), non-finite values (−3), then later-task fields.
A non-neutral later-task field returns −8 (`BET_V2_UNSUPPORTED`); −0 counts as
neutral. The v1 statuses pass through: −1 handle, −4 dt, −5 memory growth and
−3 for v1 range errors. A wrong rotor record length gives −2; a wrong body
record length gives −3, as in body v1. Every non-zero status leaves the arena
state and the output unchanged.

A neutral record runs exactly the v1 step: rotor input bytes 16..119 are v1
bytes 8..111, and body input bytes 16..255 are v1 bytes 0..239. Output bytes
0..127 therefore equal the v1 output record bitwise. When a later task
implements a field, it removes that field's −8 check and sets its validity
bit.

`tests/fixtures/wasm-abi/interface-v2.json` is generated by
`python3 tests/fixtures/wasm-abi/generate.py` (Python `struct`, with
`bet-abi-v1.json` unchanged). It holds these four layouts, neutral golden
records and rejection patches. `native/bet/tests/bound_v2.rs` and
`body_abi_v2.rs` check bitwise v1 equality over 2000 steps; 16 rotor and 19
body invalid or unsupported records, plus record-length errors and v1
pass-through statuses, all leaving state and output unchanged; and zero
allocator calls and bytes over 10^6 steps. `native/bet/examples/interface_v2_reference.rs`
prints native outputs for the WASM parity test `tests/wasm-abi-v2.test.ts`.
`packages/wasm-bet/src/rotor-v2.ts` and `body-v2.ts` are the allocation-free
adapters. `node scripts/check-bet-runtime.mjs --allocation` measures them on
the JS side: 10^6 steps of each in both WASM variants, with zero GC events,
less than 0.01 incremental bytes per step and stable WASM memory.

Native and WASM agree to 1e-12 relative. Native glibc and the WASM libm may
differ by an ulp in trigonometric functions, and a vector component's
round-off scales with its vector's magnitude. Force and moment components are
therefore compared relative to their vector's norm, and other quantities
relative to their own magnitude. Over 200 steps of the golden records, the
largest differences were 8.5e-14 for the rotor and 8.4e-16 for the body, in
both the scalar and SIMD128 builds. Per-component relative error reached
9.9e-13, on a near-cancelling 6.5e-5 N·m moment component whose absolute
difference was 6.4e-17.

## Local project store and project archive v1 (TASK-136)

Scope S16 and S01. `packages/project` keeps projects, component cards,
aircraft profiles and experiments in the browser, with no account or cloud
service. Every edit appends an immutable version; nothing stored is rewritten
or deleted. This section is the D-05 contract for project import and export.
The component-card format and its exchange file are in section "Component
cards v1 (TASK-139)"; the measured-data format stays with TASK-140.

### Storage backend

The backend is IndexedDB, for these reasons:

* One transaction checks the head that an edit replaces and appends the new
  version. An interrupted write leaves nothing behind, and two tabs cannot
  both append the same version number.
* A unique index on `[id, version]` refuses a second content for one item
  version, even from a caller that bypasses the store.
* It works in the main thread and in Workers, and the repository already uses
  it for AAR chunks (TASK-076) and EEPROM checkpoints (TASK-045).
* The Origin Private File System offers files but no transaction across
  files. It suits large sequential binary data, such as the full-run
  recordings of TASK-162, which can reference project records by SHA-256.
* Files managed by the launcher (TASK-151) remain the documented alternative.
  They survive clearing the browser's site data and can be backed up with
  ordinary tools, but they need the launcher to run. Until then, project
  archives are the backup path.

Browser storage belongs to the page's origin: scheme, host and port.
`http://127.0.0.1:5173` and `http://localhost:5173` are different origins
with different data, so the launcher must serve the application from one
fixed origin. Clearing the site's data deletes its projects, and Chrome may
evict storage that is not persistent when the disk is low. The quota report
shows whether the origin's storage is persistent.

### Records

```typescript
type ItemKind = "project" | "component-card" | "measurement-set" | "aircraft-profile" | "experiment" | "parameter-set" | "parameter-log" | "flight-task" | "experiment-batch" | "log-extraction" | "effect-log" | "log-comparison";
interface Dependency { kind: ItemKind; sha256: string }
interface ProjectRecord {
  schemaVersion: 1;
  kind: ItemKind;
  id: string;                  // UUID v4 shared by all versions of one item
  projectId: string;           // equal to id for a project record
  version: number;             // 1..1000000
  previous: string | null;     // sha256 of version - 1; null exactly for version 1
  origin: { copiedFrom: string } | null; // only on version 1 of a copy
  name: string;                // NFC, trimmed, 1..128 code points
  createdAt: string;           // UTC, YYYY-MM-DDTHH:mm:ss.sssZ
  dependencies: Dependency[];  // exact versions, sorted by sha256
  payload: object;             // owned by the kind's task
}
```

* **Address.** A record is addressed by the lowercase hexadecimal SHA-256 of
  its canonical JSON bytes. Canonical JSON follows RFC 8785: keys sorted by
  UTF-16 code units, ECMAScript serialization of numbers and strings, and no
  white space. It is encoded as UTF-8, with at most 1,048,576 bytes and 32
  nested levels. Stored and imported bytes must equal the canonical form
  exactly. Non-finite numbers, lone surrogates, `__proto__` keys, sparse
  arrays and objects that are not plain are rejected.
* **Validation.** `project.schema.json` (JSON Schema draft-07) validates the
  envelope, which starts as `unknown`. Code checks what the schema cannot
  express; the schema's description lists those rules.
* **Names.** A name is Unicode NFC after its leading and trailing white space
  is removed, with 1 to 128 code points. It may not contain C0 or C1 control
  characters, lone surrogates, U+2028 or U+2029, or the bidirectional marks,
  embeddings, overrides and isolates (U+061C, U+200E, U+200F,
  U+202A–U+202E and U+2066–U+2069). Russian and English text round-trip.
  The store normalizes names given to it. A stored or imported name that is
  not already in this form is rejected rather than rewritten, because
  rewriting would change the record's address.
* **Dependencies.** In schema v1, projects and component cards have none, a
  measurement set (TASK-140) may depend on component cards, an aircraft
  profile on component cards and measurement sets, and an experiment on
  aircraft profiles, component cards and measurement sets. A dependency must
  be a stored version of the same project. TASK-140 added the
  `measurement-set` kind without changing the envelope version: records of the
  other kinds keep their bytes and meaning, and a reader without the kind
  rejects its records as an unknown kind. TASK-160 added `parameter-set` and
  `parameter-log` in the same way; each may depend only on an experiment.
  TASK-172 added `flight-task`, with no dependencies. TASK-176 added
  `experiment-batch`, which may depend on an aircraft profile and on experiments.
  TASK-182 added `log-extraction`, TASK-169 `effect-log` and TASK-181 `log-comparison`, each of which may depend only on experiments.
* **Payloads.** A project's payload is `{}`. The store does not interpret
  card, measurement-set, profile, experiment, parameter-set, parameter-log,
  flight-task, experiment-batch, log-extraction, effect-log and log-comparison payloads beyond the canonical JSON limits. Their owner tasks (TASK-138,
  TASK-139, TASK-140, TASK-154, TASK-160, TASK-165, TASK-169, TASK-172, TASK-181 and TASK-182) register
  payload validators, which apply when a version is written or imported, not
  when it is read.

### Versions

* An item is a chain of versions 1 to n, each naming its predecessor by
  SHA-256. An edit (`saveVersion`) names the head it replaces; if the current
  head differs, the edit fails with `conflict`. An edit that repeats the
  head's name, payload and dependencies returns the head and creates no
  version.
* An experiment's inputs, its payload and its dependencies, are fixed at
  version 1; later versions may only rename it. Dependencies name exact
  versions, so editing a profile or a card never changes the inputs or the
  bytes of an earlier experiment.
* `copyItem` creates a new item in the same project whose version 1 carries
  `origin.copiedFrom`; the source is unchanged. Projects are not copied.
* Every read checks the row: the SHA-256 of its bytes, its canonical form and
  the fields the backend indexes. A mismatch is a `storage` error.

The IndexedDB database is `mirage-project-store`, version 2. Its object
store `records` has the key path `sha256`, and each value is
`{sha256, id, projectId, kind, version, bytes}`, where `bytes` holds the
canonical UTF-8 record. Indexes: `item` on `[id, version]` (unique),
`project` on `projectId` and `kind` on `kind`. Rows are only ever added.
Version 2 (TASK-137) adds the object store `settings` for local settings,
described below. Opening a version 1 database adds that store and keeps every
record.

```typescript
interface Draft { name: string; payload: unknown; dependencies?: string[] }
interface StoredVersion { sha256: string; bytes: Uint8Array; record: ProjectRecord }
interface ProjectStoreOptions {
  now?: () => Date;
  uuid?: () => string;                                      // UUID v4 source; crypto.randomUUID by default
  validators?: { [kind in ItemKind]?: (payload: unknown) => void };
  storage?: { estimate?(): Promise<{ usage?: number; quota?: number }>; persisted?(): Promise<boolean> } | null;
}
interface MissingDependency {
  kind: ItemKind;
  sha256: string;
  requiredBy: { sha256: string; kind: ItemKind; id: string; version: number; name: string }[];
}
interface ImportReport {
  projectId: string;
  added: number;                                            // records newly stored
  unchanged: number;                                        // archive records already stored
  items: { id: string; kind: ItemKind; name: string; status: "new" | "fast-forward" | "unchanged" | "local-newer";
    localVersion: number; importedVersion: number }[];
  missing: MissingDependency[];
}
interface ExportResult { archive: Uint8Array; entries: number; bytes: number; missing: MissingDependency[] }
interface StorageReport {
  records: number;
  storeBytes: number;                                       // canonical record bytes in this store
  usageBytes: number | null;                                // origin-wide, from navigator.storage.estimate()
  quotaBytes: number | null;
  persisted: boolean | null;                                // navigator.storage.persisted()
}
declare class ProjectStore {
  static openIndexedDb(options?: ProjectStoreOptions & { databaseName?: string }): Promise<ProjectStore>;
  createProject(name: string): Promise<StoredVersion>;
  createItem(projectId: string, kind: "component-card" | "aircraft-profile" | "experiment", draft: Draft): Promise<StoredVersion>;
  saveVersion(id: string, expectedHead: string, draft: Draft): Promise<StoredVersion>;
  copyItem(sourceSha256: string, name: string): Promise<StoredVersion>;
  get(sha256: string): Promise<StoredVersion>;
  history(id: string): Promise<StoredVersion[]>;
  head(id: string): Promise<StoredVersion | null>;
  listProjects(): Promise<StoredVersion[]>;
  listItems(projectId: string, kind?: "component-card" | "aircraft-profile" | "experiment"): Promise<StoredVersion[]>;
  missingDependencies(projectId: string): Promise<MissingDependency[]>;
  exportProject(projectId: string): Promise<ExportResult>;
  exportItems(projectId: string, roots: string[]): Promise<ExportResult>; // the items of roots and their dependency closure (TASK-161)
  importArchive(input: Blob | Uint8Array): Promise<ImportReport>;
  storageReport(): Promise<StorageReport>;
  readSetting(key: string): Promise<unknown>;               // undefined when nothing is stored
  writeSetting(key: string, value: unknown): Promise<void>;
  close(): void;
}
type ProjectStoreErrorCode = "invalid" | "not-found" | "conflict" | "missing-dependency" | "quota-exceeded"
  | "storage" | "archive-size" | "archive-header" | "archive-hash" | "archive-invalid";
```

### Project archive v1

The suggested file extension is `.mirageproj`. Like the TASK-081 AAR
archive, the format is uncompressed and length-delimited. All integers are
little-endian, and a whole archive has at most 134,217,728 bytes.

| Byte offset | Type | Field |
| ---: | --- | --- |
| 0 | u32 | magic 0x4a52504d (bytes "MPRJ") |
| 4 | u32 | format version 1 |
| 8 | u32 | manifest bytes, 2..4,194,304 |
| 12 | u32 | entry count, 1..16,384 |
| 16 | u32 | payload bytes, the sum of the entry bytes |
| 20 | bytes[12] | reserved, zero |
| 32 | bytes[32] | SHA-256 of the whole archive with bytes 32..63 read as zero |

The canonical JSON manifest starts at byte 64. Each entry's canonical record
bytes follow it, in manifest order.

```typescript
interface ArchiveManifest {
  format: "mirage-project-archive";
  formatVersion: 1;
  projectId: string;
  exportedAt: string;
  entries: { sha256: string; bytes: number; kind: ItemKind; id: string; version: number }[];
}
```

* **Export** writes every version of every item of one project. The project
  record comes first, then component cards, aircraft profiles and
  experiments, each ordered by id and version. Export also reports
  dependencies that no stored version satisfies. `exportItems` (TASK-161)
  writes only the project record and the items holding the given versions with
  their whole dependency closure, each with its whole history.
* **Import** checks, in this order:
  1. the size, taken from the Blob or array length before any byte is read;
  2. the header, from its first 64 bytes only: magic, version, reserved bytes,
     limits, and 64 + manifest + payload equal to the size;
  3. the archive SHA-256;
  4. the manifest: canonical JSON, the schema, counts and sums equal to the
     header, and no address or item version listed twice;
  5. each entry: its SHA-256, canonical form, envelope and payload
     validators, and agreement with its manifest entry;
  6. that every record belongs to the manifest's project, that the project
     record is present, and that each item's history is complete from
     version 1.
* **Merge.** Each item is new, fast-forward (the archive extends the local
  history), unchanged, or local-newer (the local history extends the
  archive's). A history that diverged from the local one refuses the whole
  import with `conflict`. The import commits in one transaction, which also
  checks that no item's head changed meanwhile.
* **Missing dependencies.** A dependency that neither the archive nor the
  store holds is reported with its kind, its address and every version that
  needs it, and the import proceeds. A dependency that resolves to a record
  of another kind or another project rejects the archive.
* **Errors.** `archive-size`, `archive-header`, `archive-hash`,
  `archive-invalid` and `conflict`. A rejected import stores nothing.

### Quota report

`storageReport()` returns the store's record count and canonical bytes, the
origin's usage and quota from `navigator.storage.estimate()`, and the result
of `navigator.storage.persisted()`. A value that is unavailable or invalid is
null. A write that exceeds the quota fails with `quota-exceeded` and stores
nothing.

### Local settings (TASK-137)

Local settings hold mutable state of one browser profile, such as the
navigation of the application shell. They are not records: they have no
versions or addresses, export never writes them, and import never changes
them.

* The object store `settings` has out-of-line keys. Each value is the
  canonical JSON (RFC 8785, UTF-8) of one setting, at most 16,384 bytes
  (`MAX_SETTING_BYTES`).
* A key has one to four segments separated by dots. Each segment is a
  lowercase ASCII letter followed by up to 31 lowercase ASCII letters, digits
  or hyphens, such as `shell.navigation`. Any other key is `invalid`.
* `writeSetting` replaces the value in one transaction. A value without a
  canonical JSON form, or one larger than the limit, is `invalid`, and a full
  quota is `quota-exceeded`.
* `readSetting` returns `undefined` when nothing is stored. Stored bytes that
  are not the canonical form of their own JSON value are a `storage` error.
  The caller validates the value, which starts as `unknown`.

The shell keeps its navigation in the setting `shell.navigation`:

```typescript
interface StoredNavigation {
  schemaVersion: 1;
  tab: "project" | "aircraft" | "components" | "sensors" | "faults" | "weather"
    | "tasks" | "parameters" | "logging" | "run" | "experiments" | "analysis";
  projectId: string | null;    // the open project: a lowercase UUID v4, or null
}
```

A stored value with other keys, another schema version, an unknown tab or a
`projectId` that is not a lowercase UUID v4 is ignored, and so is a setting
that cannot be read. The shell then opens the Run tab with no project. A
`projectId` whose head is not a stored project is dropped and the tab is
kept.

### Not in schema v1

* Deleting projects or versions, and garbage collection of unreferenced
  records.
* References to artifacts outside the store, such as the ArduPilot build or
  terrain data. TASK-154 records the ArduPilot build's identity (catalog ID,
  version, commit and file hashes) as experiment payload data, not as a
  dependency (user decision of 2026-11-01), and TASK-155 records the version
  and verified commit that a SITL the user started reports the same way;
  TASK-165 and TASK-186 decide whether their artifacts need a
  dependency-model change.
* Binary attachments and recordings (TASK-140, TASK-162 and TASK-164).
* Mutable user-interface state. It lives in local settings, outside the
  records and the archives.

### Verification (TASK-136)

`tests/project-store.test.ts` runs the store on an in-memory backend with
the same commit rules as IndexedDB. Its oracles are the RFC 8785 examples, a
record canonicalized and hashed by Python's `json` and `hashlib` (342 bytes,
SHA-256 `10c1d0ab…34866`), Unicode NFC compositions of Cyrillic and Latin
text, and archives that the test parses and rebuilds itself from the byte
layout above, using `node:crypto` hashes. `tests/browser/project-store.spec.ts`
runs the same operations on Chromium's IndexedDB with the network disabled,
restarts the browser on the same profile, reopens the data and imports the
archive into a second database. The roadmap entry records the results.
TASK-137 adds settings tests on both backends and upgrades a version 1
database, built by the test, to version 2 in Chromium.

## Aircraft profile v1 (TASK-138)

Scope S03. `packages/aircraft` describes a multirotor with one to eight arms
and up to 16 motors, and derives the vehicle manifest v2 (TASK-087) that
physics consumes. Profiles are `aircraft-profile` records of the project store
(TASK-136), so every edit is a new immutable version. Configuration-time code
only; never call it from a physics step.

### Profile schema 1

`packages/aircraft/src/profile.schema.json` (JSON Schema draft-07) validates a
profile, which starts as `unknown`. `validateAircraftProfile` then runs the
checks below and returns a deep-frozen copy. Units are SI, and positions are
body FRD metres from the body reference point.

```typescript
interface AircraftProfile {
  schemaVersion: 1;
  units: "SI";
  bodyFrame: "FRD";
  arms: {                           // 1..8, unique ascending IDs
    id: number;                     // 1..8
    lengthM: number;                // > 0, horizontal distance from the body z axis to the motor axis
    azimuthRad: number;             // (-π, π], from forward towards right, clockwise seen from above
    heightM: number;                // mount height above the reference point; FRD z = -heightM
    outwardTiltRad: number;         // (-π/2, π/2)
    sideTiltRad: number;            // (-π/2, π/2)
    pairSeparationM: number | null; // > 0 for a coaxial pair, null for one motor
  }[];
  motors: {                         // 1..16 (MAX_ACTUATORS), unique ascending IDs
    id: number;                     // 1..16
    armId: number;
    level: "single" | "upper" | "lower";
    spin: "ccw" | "cw";             // seen from the thrust side
    output: number;                 // ArduPilot SERVOn, 1..16, unique; actuator channel = output - 1
    components: { motor: string | null; propeller: string | null; esc: string | null }; // card SHA-256
  }[];
  massProperties: { massKg: number; cgOffsetBodyM: number[]; inertiaCgKgM2: number[] };
  payload: { massKg: number; cgOffsetBodyM: number[]; inertiaCgKgM2: number[] } | null;
  battery: { card: string | null };
  groundClearanceM: number | null;  // > 0 (decision F-07)
  sensorConfiguration: null;        // schema 3 holds a sensor configuration (TASK-143)
  // schema 4 (TASK-144) adds propellerPolars: { card: string; polar: string }[], one or more
  // schema 5 (TASK-096) adds airframeDrag: { dragAreasM2: number[]; centerOfPressureBodyM: number[];
  //   maxAirspeedMps: number; source: string }, with propellerPolars zero or more
}
```

`massProperties` describes the aircraft as flown without payload: airframe,
propulsion and battery, with the inertia about its CG in body axes. A payload
has its own CG and its inertia about it; zero inertia is a point mass. Card
references are SHA-256 addresses of component-card versions (TASK-139), and
null means that none is selected yet. `groundClearanceM` is the height of the
reference point above level ground when the aircraft rests on its supports,
which the F-07 support points use (TASK-187). Schema 2 (TASK-140) adds the
calculation mode of the profile version, described in section "Calculation
modes and measurement sets v1 (TASK-140)"; schema 1 profiles stay valid.
Neither schema holds a sensor configuration; TASK-143 defines it and raises
the schema version.

Checks beyond the schema name the arm or motor at fault:

* Arm IDs and motor IDs are unique and ascending, so a profile has one byte
  representation.
* Outputs are unique, and every motor names a known arm.
* Every arm holds either one `single` motor and no pair separation, or one
  `upper` and one `lower` motor and a pair separation.
* No two arms share a mount point (equal length, azimuth and height).
* The aircraft inertia is exactly symmetric, positive definite (Cholesky) and
  satisfies the rigid-body triangle inequality. The payload inertia is
  symmetric, positive semi-definite and satisfies the triangle inequality. The
  slack is 1e-12 of the trace, the eigen-solver bound of TASK-087.

The limits of 8 arms and 16 motors are schema limits. 16 is the ABI v2
actuator limit `MAX_ACTUATORS`, and a test ties the schema to it. TASK-142
checks whether ArduPilot supports a layout and its outputs.

### Layout

`deriveLayout(profile)` gives each rotor's hub position, thrust axis, hub
orientation and spin in ascending motor ID order, and one wake pair per
coaxial pair. For an arm with length L, azimuth a, height h, outward tilt α
and side tilt β, with radial r = (cos a, sin a, 0), across
e = (−sin a, cos a, 0) and body up u = (0, 0, −1):

\[
m = (L\cos a,\ L\sin a,\ -h),\qquad
t = \frac{\tan\alpha\,r + \tan\beta\,e + u}{\lVert \tan\alpha\,r + \tan\beta\,e + u \rVert}
\]

So α and β are the angles between u and the projections of t onto the arm's
vertical plane and onto the vertical plane across it. A single rotor sits at
m; a coaxial pair sits at m ± (s/2)·t, with the upper rotor on the thrust side.
The hub orientation maps hub +z to t: a half turn about body x, then the
shortest rotation from u to t, written with a positive x component:

\[
q_{hb} = \frac{\left(-t_y,\ 1 - t_z,\ 0,\ t_x\right)}{\sqrt{t_x^2 + t_y^2 + (1 - t_z)^2}}
\]

An untilted rotor has (0, 1, 0, 0), as in the repository's existing fixtures.
The spin sign is +1 for `ccw`, so ω = s·|ω|·t. Each wake pair names the upper
rotor as upstream and the lower one as downstream (TASK-101).

### Engine-independent trigonometry

ECMAScript leaves `Math.sin`, `Math.cos` and `Math.tan` implementation-
approximated. On one machine, Node 24.22.2 and Chromium 153 returned different
last bits for 3.3% (sine), 3.4% (cosine) and 3.7% (tangent) of 200,000
arguments, so a layout built on them would give different manifest bytes in
the application and in the tests. `packages/aircraft/src/trig.ts` uses only
addition, subtraction, multiplication, division, `Math.abs` and `Math.round`,
which every engine rounds identically:

* The argument is reduced to a = n·π/2 + y with |y| ≤ π/4. π/2 is split into
  two 33-bit parts and a 53-bit tail that together reproduce it to 2^-123, and
  n times a 33-bit part is exact. A test recomputes the parts from π by
  Machin's formula in integer arithmetic.
* Taylor polynomials on |y| ≤ π/4 run to y^17 for the sine and y^18 for the
  cosine; the first omitted term is at least three decades below the rounding
  of the result. The cosine recovers the rounding error of 1 − y²/2.
* Arguments are limited to |x| ≤ 4 rad.

Against V8's own functions on 400,001 points, the sine and cosine differ by at
most 1 ulp and the tangent by at most 3 ulp; the tests admit 2 and 4 ulp.

### Derivation to vehicle manifest v2

Propeller blade geometry and motor, ESC and battery values come from component
cards (TASK-139). The derivation receives them already resolved and invents
none:

```typescript
interface ResolvedComponents {
  description: string;              // 1..1024 characters, quoted in the dataset
  motors: {                         // exactly one per profile motor
    motorId: number;
    cards: { motor: string | null; propeller: string | null; esc: string | null }; // equal to the profile's
    rotor: {
      bladeCount: number; radiusM: number; rootCutoutM: number; polarId: number;
      radialStationM: number[]; chordM: number[]; twistRad: number[]; quadratureWidthM: number[];
      shaftInertiaKgM2: number; bearingViscousNmPerRadS: number; azimuthSamples: number;
    };
    motor: { kvRpmPerV: number; resistanceOhm: number; currentLimitA: number; noLoadCurrentA?: number } | null;
    esc: { pwmMinUs: number; pwmMaxUs: number; commandTauS: number; updateRateHz?: number; brakeCurrentLimitA?: number } | null;
  }[];
  battery: { card: string | null; values: BatterySpec } | null; // card equal to the profile's
}
declare function deriveVehicleManifest(profile: unknown, components: ResolvedComponents,
  options: { modelId: number }): Promise<{
    manifest: VehicleManifest; bytes: Uint8Array; sha256: string; profileSha256: string; inputSha256: string;
  }>;
```

Either every motor has motor values or none has, and the same holds for ESC
values. The derived manifest holds:

| Field | Value |
| --- | --- |
| `kind` | `bet` |
| `rotors` | In motor ID order: `id` = motor ID, `motorChannel` = output − 1, the layout's position, orientation and spin, and the resolved blade fields |
| `motors`, `escs` | Only with resolved values; `id`, `rotorId` and `motorId` = motor ID |
| `battery` | The resolved values, or null |
| `rotorWakePairs` | One per coaxial pair, from the upper rotor to the lower one |
| `massProperties` | The aircraft and the payload: combined mass and CG, both inertias moved to it by the parallel-axis theorem |
| `datasets` | The synthetic dataset `aircraft-profile-derivation`, whose source SHA-256 is that of the canonical derivation input, then the synthetic datasets `standard-landing-gear` of the gear rules (derivation 3, TASK-095), `standard-hull` of the hull rules (derivation 4, TASK-095) and `standard-hull-drag` of the hull's preliminary drag (derivation 6, TASK-096), without a source; a profile that describes its body (schema 7, TASK-196) has no `standard-hull` dataset |
| `sensorMounts` | The IMU mount when the sensor configuration states the IMU position or orientation (derivation 2, TASK-147); otherwise empty |
| `landingGear` | The decision D-07 supports; a profile without a ground clearance stands on supports below its standard hull and propeller discs (derivations 3 and 4, TASK-095, and 5, TASK-195; section "Standard landing gear"); a profile that describes its gear (schema 8, TASK-194) gets that gear instead, from the dataset `aircraft-profile-landing-gear` (section "Described landing gear (TASK-194)") |
| `hull` | The standard hull: a body cylinder and one capsule per arm (derivation 4, TASK-095; section "Standard hull and propeller discs"); for a profile that describes its body (schema 7, TASK-196) that body, from the profile's dataset (section "Described body (TASK-196)") |
| `airframe.drag` | The standard hull's preliminary drag (derivation 6, TASK-096; section "Airframe drag") |
| `ardupilot`, `controlSurfaces` | Null or empty; TASK-142 owns `ardupilot` |

With d_i = c_i − c for each part's CG c_i and the combined CG c:

\[
J = \sum_i \left( J_i + m_i\left(\lVert d_i \rVert^2 \mathbf{1} - d_i d_i^{\mathsf T}\right) \right)
\]

`profileSha256` is the SHA-256 of the profile's canonical JSON, so renaming the
stored profile changes nothing. `inputSha256` is the SHA-256 of the canonical
`{derivationVersion: 6, profile, components}` (`DERIVATION_VERSION`; 2 since
TASK-147 added the IMU mount, 3 since TASK-095 added the standard landing
gear, 4 since TASK-095 added the standard hull, 5 since TASK-195 counts the
propeller discs in the supports of a profile without a clearance, 6 since
TASK-096 adds the standard hull's preliminary drag). The manifest passes
`validateVehicleManifest`, and `bytes` is its RFC 8785 canonical JSON, which a
`VehicleRegistry` admits unchanged; −0 in the inputs becomes 0. Any change to
geometry, outputs, mass properties, components or the model ID changes the
bytes. A manifest without motor, ESC and battery values and without pairs
projects to the v1 runtime descriptor once its gear, hull and drag are taken
out. Motors, ESCs, the battery and wake
pairs wait for TASK-092 and TASK-101, and TASK-144 builds the dynamics.

### Project store

`validateAircraftProfile` is the payload validator of the `aircraft-profile`
kind. `profileDraft(name, profile)` makes a store draft whose dependencies are
exactly the profile's component cards and, in schema 2, its bound measurement
sets, and `readAircraftProfile(stored)` refuses a record whose dependencies
differ from them.

### Verification (TASK-138)

`tests/aircraft-profile.test.ts` recomputes every rotor of the five S19
fixtures with independent code: the engine's `Math` functions instead of
`trig.ts`, `Math.atan2` to recover both tilts, and a separate
quaternion-to-matrix formula. It also checks hand-derived quad X and X8 values,
the ArduCopter quad X geometry check of TASK-087, the parallel-axis theorem
against a sum about the reference point, and the rejection cases.
`tests/browser/aircraft-derivation.spec.ts` derives the same fixtures, and a
variant on angles where the engines' `Math` functions disagree, in Chromium,
and requires the same bytes as Node. The roadmap entry records the results.

## Component cards v1 (TASK-139)

Scope S04. `packages/aircraft/src/components.ts` describes motors, propellers,
ESCs and batteries as component cards: `component-card` records of the project
store (TASK-136). Every edit is a new immutable version addressed by its
SHA-256, and aircraft profiles reference those addresses (TASK-138). A card
states what is known about a part and where each value came from; it never
fills in a value. Configuration-time code only; never call it from a physics
step.

### Card schema 1

`packages/aircraft/src/components.schema.json` (JSON Schema draft-07)
validates a card, which starts as `unknown`. `validateComponentCard` then runs
the checks below and returns a deep-frozen copy; it is also the payload
validator of the `component-card` kind.

```typescript
interface ComponentCard {
  schemaVersion: 1;
  units: "SI";
  type: "motor" | "propeller" | "esc" | "battery";
  example: boolean;                 // an illustration shipped with MirageSITL; never measured data
  manufacturer: string | null;      // 1..128 characters
  model: string | null;             // 1..128 characters
  sources: {                        // 1..16, unique IDs, each used by at least one value
    id: string;                     // ^[a-z0-9][a-z0-9-]{0,63}$
    kind: "specification" | "measured" | "synthetic";
    description: string;            // 1..2048 characters
    sha256: string | null;          // of the document or data; required for a measured source
    date: string | null;            // YYYY-MM-DD calendar date; required for a measured source
  }[];
  values: { [field: string]: number | string | object | null };  // the fields of its type, below
  provenance: { [field: string]: string | null };                // the same fields: a source ID exactly when the value is known
  applicability: string | null;     // limits of use, 1..2048 characters
}
```

A source of kind `specification` is a datasheet or catalog, `measured` is the
user's own measurement and `synthetic` is an illustrative or assumed value. The
SHA-256 and date of a measured source identify its data; TASK-140 adds the
measurement sets themselves. Every value field is present: null means that the
value is not known, and `missingValues(card)` lists such fields in schema
order, which is what a user still has to supply. The ranges are parser bounds
that catch unit mistakes, such as a diameter in inches or a KV of zero, not
physical envelopes:

| Type | Field | Unit | Range | Null allowed |
| --- | --- | --- | --- | --- |
| motor | `kvRpmPerV` | rpm/V | (0, 100000] | no |
| motor | `resistanceOhm` (phase to phase) | Ω | (0, 100] | yes |
| motor | `noLoadCurrentA` | A | (0, 1000] | yes |
| motor | `noLoadVoltageV` (of the no-load test) | V | (0, 1000] | yes |
| motor | `maxCurrentA` | A | (0, 10000] | yes |
| motor | `maxPowerW` | W | (0, 10^7] | yes |
| propeller | `diameterM` | m | (0, 20] | no |
| propeller | `pitchM` (nominal) | m | (0, 50] | no |
| propeller | `bladeCount` | 1 | integer 1..16 | no |
| propeller | `hubDiameterM` | m | (0, 20] | yes |
| propeller | `chord`: `radiusRatio`, `chordRatio` (c/R) | 1 | 2..64 points; (0, 1] and (0, 2] | yes |
| propeller | `twist`: `radiusRatio`, `angleRad` (blade angle to the rotor plane) | 1, rad | 2..64 points; (0, 1] and (−π/2, π/2) | yes |
| propeller | `airfoil` | text | 1..64 characters | yes |
| esc | `maxCurrentA` | A | (0, 10000] | no |
| esc | `updateRateHz` | Hz | (0, 10^6] | yes |
| esc | `maxVoltageV` | V | (0, 1000] | yes |
| battery | `cellsSeries` | 1 | integer 1..32 | no |
| battery | `capacityAh` | A·h | (0, 1000] | no |
| battery | `internalResistanceOhm` (whole pack) | Ω | [0, 10] | yes |
| battery | `cellFullV`, `cellEmptyV` | V | (0, 10] | yes |
| battery | `maxDischargeCurrentA` | A | (0, 10^5] | yes |
| all | `massKg` | kg | (0, 1000] | yes |

Checks beyond the schema:

* Source IDs are unique; a date is a real calendar date (proleptic
  Gregorian); a measured source has a SHA-256 and a date.
* An example card has no measured source.
* Every known value names a listed source, every unknown value names none, and
  every source is used.
* A motor's no-load current and its test voltage are both known or both
  unknown.
* A propeller's hub diameter is below its diameter, and each distribution has
  one value per radius ratio, with strictly increasing radius ratios.
* A battery's full cell voltage is above its empty cell voltage.

`checkProfileCards(profile, cards)` checks that every card a profile
references is available and has the type of its role, for example that a
motor's propeller reference names a propeller card. `readComponentCard(stored)`
returns the card of a stored `component-card` version and refuses any other
kind. The four example cards under `tests/fixtures/components/` are labeled
`example: true`, carry one synthetic source and hold no measured data.

### Card exchange file

The card exchange file moves selected cards between projects. Unlike the
project archive (TASK-136), it carries no item IDs, history or project, only
the current cards:

```typescript
interface CardFile {                // canonical JSON (RFC 8785), at most 16 MiB, extension .miragecards
  format: "mirage-component-cards";
  formatVersion: 1;
  exportedAt: string;               // UTC, YYYY-MM-DDTHH:MM:SS.sssZ
  cards: {                          // 1..256
    name: string;                   // NFC without leading or trailing white space, as in the project store
    sourceSha256: string;           // the exported version's address; informational
    payloadSha256: string;          // SHA-256 of the payload's canonical JSON; checked on import
    payload: ComponentCard;
  }[];
}
declare function exportComponentCards(versions: readonly StoredVersion[], exportedAt?: Date): Promise<Uint8Array>;
declare function decodeComponentCards(bytes: Uint8Array): Promise<CardFileEntry[]>;
declare function importComponentCards(store: ProjectStore, projectId: string, bytes: Uint8Array):
  Promise<{ name: string; payloadSha256: string; status: "added" | "unchanged"; sha256: string }[]>;
```

Import checks the whole file before it stores anything: its size, UTF-8 JSON,
the schema, canonical bytes, the timestamp, every name, every payload hash and
every card. A card whose name and payload the project already holds is
reported `unchanged`; every other card becomes a new item. Import never
modifies an existing card, so importing the same file twice changes nothing. A
storage failure part-way leaves the cards added so far, and repeating the
import adds only the rest.

### Propeller geometry

`derivePropellerGeometry(card, { strips })` derives the BET blade geometry of
a propeller card, lists every assumption it makes and flags every value that
was assumed rather than given:

```typescript
declare function derivePropellerGeometry(card: unknown, options?: { strips?: number }): {
  geometry: {
    bladeCount: number; radiusM: number; rootCutoutM: number;
    radialStationM: number[]; chordM: number[]; twistRad: number[]; quadratureWidthM: number[];
    airfoil: string | null; bladeInertiaKgM2: number | null;
  };
  assumptions: { id: AssumptionId; description: string }[];
  flags: { id: GeometryFlagId; description: string }[];
};
```

With diameter D, nominal pitch P, hub diameter d_h, mass m and N strips
(default 16, at most the 64 stations of a BET rotor):

\[
R = \frac{D}{2},\qquad
r_c = \begin{cases} d_h/2 & \text{with a hub diameter} \\ 0.15\,R & \text{without} \end{cases},\qquad
w = \frac{R - r_c}{N},\qquad
r_i = r_c + \left(i + \tfrac{1}{2}\right) w
\]

\[
\theta(r) = \arctan\frac{P}{2\pi r},\qquad
c = 0.1812\,R,\qquad
I = \frac{m R^2}{3}
\]

A given chord or twist distribution is interpolated linearly in r/R; a station
outside the data takes the nearest end value and is flagged. Without one, the
chord is the constant c and the blade angle is θ(r), the geometric pitch angle
of a helical blade. The assumptions, in this order:

| ID | Assumption |
| --- | --- |
| `rigid-identical-blades` | The blades are rigid, identical and evenly spaced; they do not cone, flap or bend |
| `midpoint-strips` | N equal strips from the root cutout to the tip; each station is a strip midpoint, and the strip widths are the quadrature weights |
| `root-cutout` | The blade begins at the hub radius, or at r/R = 0.15 without a hub diameter |
| `chord` | The chord is interpolated from the card, or constant at c/R = 0.1812 without one |
| `twist` | The blade angle is interpolated from the card, or θ(r) from the nominal pitch, taken as the geometric pitch at every radius and measured to the chord line; manufacturers often state pitch at 0.75 R or to a flat lower surface |
| `inertia` | With a mass only: each blade is a thin uniform rod from the axis to the tip, so I = mR²/3; a heavier hub region makes the real value smaller |

The validity flags, in this order, each present only when it applies:
`root-cutout-assumed`, `chord-assumed`, `chord-extended`, `twist-from-pitch`,
`twist-extended`, `airfoil-unspecified` and `inertia-unknown`.

The two defaults come from the measured UIUC geometries in
`tests/fixtures/rotors/uiuc-propellers.json`: c/R = 0.1812 is the median
measured chord ratio between r/R 0.3 and 0.9 of its 14 propellers (182
samples), and every one of them begins at r/R = 0.15. Real blades taper, so a
constant chord is a preliminary value; TASK-145 calibrates against
measurements. The geometry gives the blade fields of a vehicle manifest rotor
(TASK-138) directly. The polar (from the airfoil), the shaft inertia (the
propeller and the motor rotor, which no card states), the bearing friction and
the azimuth samples come from elsewhere; TASK-144 assembles the rotor.

### Arctangent

`Math.atan` also differs between Node 24.22.2 and Chromium 153, in the last
bit for 6.3% of arguments, so θ(r) uses `atan` from `trig.ts`, built from
basic arithmetic and `Math.sqrt`. Engines compute the square root with the
correctly rounded hardware instruction, and Node and Chromium agreed on every
argument tested. The identity atan(a) = 2·atan(a/(1 + √(1 + a²))) brings
a ≤ 1 below 1/8 in at most three steps, where the Taylor series to a^17 leaves
a first omitted term below 3e-18·a; above 1, atan(a) = π/2 − atan(1/a) with
π/2 in two parts. Against V8's `Math.atan` on 400,001 points the result
differs by at most 4 ulp; the tests admit 8.

### Verification (TASK-139)

`tests/component-cards.test.ts` checks the example propeller against values
computed by hand with 40-digit decimal arithmetic, and turns the 14 measured
UIUC geometries into cards whose geometry must equal the TASK-033
blade-station builder `bladeStations`. Every derived geometry must pass the
BET rotor checks of the model manifest. The tests also cover the rejection
cases, the store and the exchange file.
`tests/browser/aircraft-derivation.spec.ts` derives the example propeller in
Chromium at 16 and 64 strips and requires the same bytes as Node. The roadmap
entry records the results.

## Calculation modes and measurement sets v1 (TASK-140)

Scope S04 and S15. An aircraft profile version is either a **Preliminary
calculation**, built from specifications and geometry, or a **Calculation from
measurements**, which also uses static bench data. Bench data belongs to one
exact combination of motor, propeller, ESC and power supply and is never used
for another, except that data measured on a laboratory supply also serve its
motor, propeller and ESC on a battery (stakeholder's decision of 2026-11-07).
The confidence labels follow TASK-133
([phase1-fidelity.md](decisions/phase1-fidelity.md)). Configuration-time code
only; never call it from a physics step.

### Bench CSV v2

`packages/physics/src/bench-import.ts` extends the TASK-090 importer. Version 2
states one set of conditions for the whole file and holds only the quantities
that were measured:

```text
mirage-bench-csv,2
diameterM,0.254
airTemperatureK,293.15
airPressurePa,101325
supplyVoltageV,16.8
rpm,thrustN,torqueNm,voltageV,currentA
2000,0.612561732958,0.0101303287561,16,0.16575711666
```

* The conditions follow the diameter line: `airDensityKgM3`, or
  `airTemperatureK` then `airPressurePa`, optionally followed by
  `supplyVoltageV`, the nominal supply voltage. Nothing else may stand there.
* The column header is `rpm,thrustN` followed by any of `torqueNm`,
  `voltageV` and `currentA` in this order. A quantity that was not measured is
  an absent column; an empty field is an error, so nothing is filled in.
* Numbers follow the v1 rules: strict decimals, LF or CRLF, at most 4 MiB.
  A file holds 1 to 4096 rows (`MAX_BENCH_POINTS`).

The bounds catch unit mistakes; they are not physical envelopes:

| Quantity | Bound | Catches |
| --- | --- | --- |
| `diameterM` | (0, 10] m | |
| `rpm` | (0, 100000] rpm | |
| `thrustN` | [−10000, 10000] N | |
| `torqueNm` | [−1000, 1000] N·m | |
| `voltageV`, `supplyVoltageV` | (0, 1000] V | |
| `currentA` | [0, 10000] A | a negative current |
| `airDensityKgM3` | [0.3, 1.6] kg/m³ | a density in lb/ft³ |
| `airTemperatureK` | [233.15, 323.15] K | a temperature in °C |
| `airPressurePa` | [30000, 110000] Pa | a pressure in hPa or kPa |
| \|C_T\|, \|C_P\| | at most 1 | a thrust in grams, a torque in N·mm or a speed in rad/s |

The largest static coefficients of the 14 measured UIUC propellers in
`tests/fixtures/rotors/uiuc-propellers.json` are C_T = 0.254 and
C_P = 0.193, so the bound of 1 leaves a margin of four, while a unit mistake
multiplies a coefficient by about 100 or more. From temperature and pressure
the density follows the
ideal gas law with the ICAO constant R = 287.05287 J/(kg·K) of
`atmosphereFromState`. With n = rpm/60:

\[
\rho = \frac{p}{R\,T},\qquad P_{\mathrm{shaft}} = 2\pi n\,Q,\qquad P_{\mathrm{el}} = V\,I
\]

`importBenchMeasurements(text)` reads version 2, and version 1 when every row
has the same density. It returns, per row, the measured values, C_T, C_Q,
C_P, thrust and torque at ISA sea-level density, the shaft and electrical
power and the figure of merit, each null when its inputs were not measured.
It keeps the v1 flags and adds `electrical-power-below-shaft-power`, because a
motor and ESC cannot deliver more shaft power than they draw. `missing` lists
the unmeasured columns and then `supplyVoltageV` when it is not stated.
`formatBenchCsv` writes the canonical v2 text of checked data, with numbers in
their shortest round-trip form. `importBenchCsv` still reads version 1 only.

### Measurement sets

`packages/aircraft/src/measurements.ts` stores bench data as
`measurement-set` records of the project store (TASK-136):

```typescript
interface MeasurementSet {
  schemaVersion: 1;
  units: "SI";
  combination: {
    motor: string;                  // component-card version SHA-256
    propeller: string;
    esc: string;
    supply: { kind: "battery"; card: string } | { kind: "laboratory" };
  };
  diameterM: number;                // equal to the propeller card's diameter
  conditions: {
    airDensityKgM3: number | null;  // either the density,
    airTemperatureK: number | null; // or the temperature and the pressure
    airPressurePa: number | null;
    supplyVoltageV: number | null;  // null when not recorded
  };
  points: {                         // 1..4096 values each
    rpm: number[];
    thrustN: number[];
    torqueNm: number[] | null;      // null when not measured
    voltageV: number[] | null;
    currentA: number[] | null;
  };
  source: {
    kind: "file" | "manual";
    fileName: string | null;        // exactly for a file
    fileSha256: string | null;      // SHA-256 of the uploaded file's bytes
    date: string;                   // YYYY-MM-DD calendar date of the measurement
    description: string | null;
  };
  applicability: string | null;     // limits of use, 1..2048 characters
}
```

`validateMeasurementSet` checks the schema, repeats every bench CSV v2 rule
and checks the source, and it is the payload validator of the kind.
`measurementSetFromBenchCsv` builds a set from an uploaded file and
`measurementSetFromColumns` from values typed in. `checkMeasurementCards`
checks that the combination's cards exist, have the types of their roles, and
that the propeller card's diameter equals the set's.
`measurementSetDraft(name, set)` makes a store draft whose dependencies are
exactly the combination's cards, and `readMeasurementSet` refuses a record
whose dependencies differ.

The combination key is the SHA-256 of the canonical JSON of `combination`, so
two sets share a key exactly when they name the same card versions and the
same supply. The supply is part of the combination (S04): a battery card
version, or a laboratory power supply, which no card describes. A profile's
supply is its battery card. By the stakeholder's decision of 2026-11-07, which
first let T-Motor's own datasheet (TASK-145) serve the battery-powered forum
quad, a set of a motor's motor, propeller and ESC cards on a laboratory supply
also binds to that motor whatever the battery, labeled as such; until then it
never bound.

### Profile schema 2

Aircraft profile schema 2 adds the calculation of the profile version:

```typescript
interface CalculationSettings {
  mode: "preliminary" | "measured";
  measurementSets: string[];        // measurement-set version SHA-256, ascending, unique, 0..16
}
// AircraftProfile schema 2 = schema 1 fields with schemaVersion: 2 and calculation: CalculationSettings
```

A schema 1 profile has no `calculation` and reads as preliminary, so stored
profiles and their recorded manifests keep their bytes. A preliminary
calculation binds no set. The bound sets are dependencies of the profile
record, so a profile version always names the exact data it uses, and
changing a binding creates a new version.

### Binding and labels

`packages/aircraft/src/calculation-mode.ts` connects profiles, sets and labels:

* `motorCombination(profile, motor)` is the motor's motor, propeller and ESC
  cards with the profile's battery card, or null while any is not selected.
* `motorSetKeys(profile, motor)` is the motor's two set keys: `exact`, its
  combination, and `laboratory`, its motor, propeller and ESC cards on a
  laboratory supply; null while any card or the battery is not selected.
* `bindMeasurements(profile, mode, candidates)` returns a schema 2 version in
  the given mode. In measured mode it binds, for each motor, the newest
  candidate set of exactly its combination, else the newest of its laboratory
  combination; candidates of other combinations are never bound.
* `checkProfileMeasurements` refuses a bound set that is not available, that
  matches no motor's combination, that binds the same combination as another,
  or that applies to a motor another bound set already serves (a set on the
  battery and one on a laboratory supply of the same cards). A profile edited
  onto other cards therefore cannot keep a stale binding.
* `evaluateCalculation(profile, cards, sets)` labels each motor and the
  aircraft:

| Mode | Motor | Label | Reason |
| --- | --- | --- | --- |
| Preliminary | any | `preliminary` | Specifications and geometry only |
| Measured | a card or the battery not selected | `preliminary` | No measurements can bind |
| Measured | no bound set of its combination | `preliminary` | No set of this combination is bound |
| Measured | a bound set of its combination | `measured-input` | Bench data of this exact combination |
| Measured | a bound set of its cards on a laboratory supply | `measured-input` | Bench data of this motor, propeller and ESC on a laboratory supply |

The aircraft takes the weakest label of its motors (F-06). `flight-checked`
belongs to TASK-184 and is never assigned here. Each motor lists what its
calculation lacks, never filling it in: unselected cards, unknown card values
(`propeller: chord`) and unmeasured quantities (`measurements: torqueNm`). A
motor with bench data also lists its limits of use: the measured rpm range
with the F-03 warning margin of 10% on either side, that static single-rotor
data does not validate forward flight or descent, that it does not validate a
coaxial pair's interaction when the motor is in one, that a laboratory
supply held its voltage where a battery sags when the set was measured on
one, and the set's own applicability. In measured mode the aircraft notes that the mode does not
certify the aircraft. TASK-145 fits the propulsion model to the bound data.

### Components tab

The Components tab of the application (TASK-137) lists the open project's
cards with their unknown values, and imports and exports card files
(TASK-139). It saves measurement sets from an uploaded bench CSV file or from
values typed into a table, for a chosen motor, propeller, ESC and power supply,
and refuses data that breaks the rules above with the reason. For each
aircraft profile it offers **Preliminary calculation** and **Calculation from
measurements**. Choosing a mode saves a new profile version, and the tab
shows each motor's label, combination, bound set, missing quantities and
limits of use. The application's project store registers the card,
measurement-set and profile validators, so archive imports are checked too.

### Verification (TASK-140)

`tests/calculation-mode.test.ts` recovers the coefficients of a bench file
generated from known values with 50-digit decimal arithmetic, checks the
combination key against SHA-256 computed with `node:crypto`, and checks that a
profile differing from a set in any one card version, or in its supply,
binds nothing; since 2026-11-07 a set on a laboratory supply is the exception
and binds whatever the battery. It also covers the rejection cases, the store
and archive round trip, and the labels. `tests/browser/measurements.spec.ts`
uploads and types bench data in Chromium and checks that only the motors of
the bound combination, or of its cards on a laboratory supply, change their
label. The roadmap entry records the results.

## Sensor configuration v1 (TASK-143)

Scope S08. An aircraft profile holds the sensor errors of its IMU, GNSS,
barometer, magnetometer and battery voltage and current sensing, with an
owner for each error on the Phase 1 path: ArduPilot SITL as an external
process, ownership path `native-json`, stock firmware under decision D-10.
The Sensors tab edits it. TASK-147 applies it at run time; TASK-143 applies
nothing. Configuration-time code only; never call it from a physics step.

### Profile schema 3

Profile schema 3 holds a sensor configuration, and schemas 1 and 2 hold
`null`, which means the ArduPilot defaults: every error source stays with
ArduPilot's stock SITL and MirageSITL injects nothing. `PROFILE_SCHEMA_VERSION`
was 3 until schema 4 (TASK-144, section "Profile-driven dynamics") added
propeller polars. Schema 3 always has a calculation, and its configuration never equals
the defaults, so the defaults have exactly one encoding (`null`).
`withSensorConfiguration(profile, config)` writes schema 3 for a configuration
and `null` otherwise, where schema 1 stays 1 and schemas 2 and 3 become 2;
schema 4 keeps its propeller polars.
`bindMeasurements` keeps schema 3, and the Aircraft editor carries the
configuration unchanged. Existing schema 1 and 2 records are never rewritten,
and dependencies do not change. Derivation 2 (TASK-147) reads only the IMU
position and orientation, for the manifest's IMU mount.

### Schema and fields

`packages/aircraft/src/sensor-config.schema.json` (draft-07) validates the
configuration. Each field carries its unit in the annotation keyword `x-unit`
and the provenance of its range in `description`. Every key is present, and
`null` means not specified: the owner's default applies.
`validateSensorConfiguration` adds code checks: a field its owner cannot apply
yet must be `null`, a latency ArduPilot applies must be a whole number of
milliseconds, and a preset reference must name a preset of the block's sensor
in the bundled catalog. `SENSOR_FIELDS` (`sensor-fields.ts`) is the registry
of the 25 fields.

```typescript
interface SensorConfiguration {
  schemaVersion: 1;
  mode: "ideal" | "specified";
  imu: { preset: PresetReference | null;
    accelNoiseDensityMps2PerSqrtHz: number | null; // [0, 0.01], one-sided white-noise density per axis
    gyroNoiseDensityRadSPerSqrtHz: number | null;  // [0, 0.001]
    accelBiasMps2: [number, number, number] | null; // each [-2, 2], constant, sensor axes
    gyroBiasRadS: [number, number, number] | null;  // each [-0.2, 0.2]
    latencyUs: number | null;                       // integer [0, 100000]; MirageSITL in mapping 2
    positionBodyM: [number, number, number] | null; // each [-2, 2], body FRD from the reference point; null at the CG
    orientationRad: [number, number, number] | null; }; // roll, yaw (-π, π], pitch [-π/2, π/2]; locked
  gnss: { preset: PresetReference | null;           // ArduPilot's receiver in mapping 2
    updateRateHz: number | null;                    // integer [1, 20]
    horizontalSigmaM: number | null;                // [0, 100], 1σ per horizontal axis
    verticalSigmaM: number | null;                  // [0, 100]
    velocitySigmaMps: number | null;                // [0, 10], 1σ per NED axis
    latencyUs: number | null; };                    // integer [0, 1000000]
  barometer: { preset: PresetReference | null;
    noiseRmsPa: number | null;                      // [0, 50], 1σ per sample
    biasPa: number | null;                          // [-500, 500], positive reads high
    latencyUs: number | null; };                    // integer [0, 490000], whole milliseconds
  magnetometer: { preset: PresetReference | null;
    noiseRmsGauss: number | null;                   // [0, 0.1], 1σ per axis
    biasGauss: [number, number, number] | null;     // each [-0.4, 0.4], net hard iron after COMPASS_OFS
    positionBodyM: [number, number, number] | null; // locked
    orientationRad: [number, number, number] | null; }; // locked
  battery: { preset: PresetReference | null;        // MirageSITL in mapping 2
    voltageGainError: number | null; voltageOffsetV: number | null; voltageNoiseRmsV: number | null;
    currentGainError: number | null; currentOffsetA: number | null; currentNoiseRmsA: number | null; };
}
interface PresetReference { catalogVersion: number; id: string }  // e.g. { catalogVersion: 1, id: "imu-icm-42688-p" }
```

### Ownership mapping 1

Mapping 2 (TASK-147, section "Sensor errors in the external-SITL path")
replaces this mapping; it stays here as the record of what TASK-143 shipped.
`sensor-ownership.ts` gave each field one owner on `native-json`
(`SENSOR_OWNERSHIP_MAPPING_VERSION` 1). The UI offers no owner choice, so it
cannot produce an inadmissible matrix.

| Owner | Fields | TASK-089 source and delivery |
|---|---|---|
| MirageSITL | IMU noise densities, IMU biases, IMU position | `imu.accel.noise`, `imu.gyro.noise`, `imu.accel.bias`, `imu.gyro.bias`, `imu.lever-arm`; `json:imu.accel_body`, `json:imu.gyro` |
| ArduPilot SITL | Barometer noise, bias and latency; magnetometer noise and bias | `baro.noise`, `baro.glitch`, `baro.delay`, `mag.noise`, `mag.hard-iron`; SIM_* values written by TASK-147 |
| ArduPilot SITL, locked | All GNSS fields | `gnss.receiver`; SIM_GPS1_* need `AP_SIM_GPS_ENABLED`, which the matrix does not admit yet |
| Nobody yet, locked | IMU latency and orientation, magnetometer position and orientation, all battery fields | No TASK-089 source; TASK-147 adds them |

Every excluded owner carries its basis: the validator rejects it (no
MirageSITL path carries a barometer error or magnetometer noise on
`native-json`), the owner's model is another quantity (SIM_ACCn_RND scales
only vibration; SIM_GYRn_RND is throttle-scaled unseeded noise; SIM_IMU_POS
lacks ω̇×r on the JSON backend), or Phase 1 policy (one MirageSITL IMU model;
hard-iron PARAM_SET reserved for S09; ArduPilot's own GNSS receiver).
`error-ownership.ts`, the catalog and the matrix fixtures are unchanged.

`sensorOwnershipMatrix(config)` derives a schema 2 TASK-089 matrix with no
firmware patch:

* **ArduPilot defaults** (`null`): every source with ArduPilot. The entries
  equal `imuNoiseFloorMatrix('ardupilot', 'native-json')`, and
  `ownershipParameterProfile` writes no setting.
* **Specified:** a MirageSITL-owned source is `mirage`, with its JSON
  delivery, exactly while its field holds a value; every other source stays
  with ArduPilot.
* **Ideal:** every source a parameter can neutralize is `none`, which writes
  143 settings. The IMU noise floors and `gnss.receiver` stay with ArduPilot,
  because the validator forces it, and `mag.hard-iron` keeps ArduPilot's stock
  pairing of SIM_MAGn_OFS with COMPASS_OFSn, which nets to zero; TASK-089's
  neutral value would leave COMPASS_OFS (5, 13, −18) mG as an offset. Ideal
  keeps the stored values but uses none of them, and has no MirageSITL owner,
  so every MirageSITL-owned error is at its neutral value.

`resolveSensorConfiguration` lists each field's effective state (`specified`,
`neutral`, `neutralized`, `ardupilot-stock` or `not-applied`) and the
residuals Ideal cannot remove. First among them, on stock firmware (D-10):
ArduPilot's fixed IMU noise floors of ±0.01 m/s² and ±0.04 °/s, uniform. The
others are the stock GNSS receiver, the hard-iron pairing (inferred),
INS_ACCOFFS and INS_ACCSCAL from the defaults files (inferred), the compiled
IMU sample rates, the EKF's assumed delays, and ArduPilot's unseeded noise.

TASK-147 implements these conversions with the gradient at the home altitude
(section "Sensor errors in the external-SITL path"). As planned here:
barometer noise maps to SIM_BAROn_RND as a uniform half-width in
metres, √3·σ·|dh/dp|, and bias to SIM_BAROn_GLITCH = bias·dh/dp, with the ISA
gradient −0.0832 m/Pa at sea level; latency maps to SIM_BAROn_DELAY in
milliseconds. Magnetometer noise maps to SIM_MAG_RND = √3·1000·σ mG, and bias
to SIM_MAGn_OFS = COMPASS_OFSn − 1000·b mG. An S09 effect that writes
SIM_BAROn_GLITCH or SIM_MAGn_OFS adds to the S08 value.

### Presets

`packages/aircraft/src/sensor-presets.json` is an append-only file of preset
catalogs; a released catalog never changes, and catalog 1's canonical SHA-256
is pinned in the tests. Each catalog names the
[sensor catalog](hardware/ardupilot-sensors.md) it was taken from and that
document's SHA-256, which must equal the current document for the latest
catalog. A preset value records the datasheet value, unit, statistic and
conditions, a conversion from a closed set (identity, mdps to rad/s, µg to
m/s², nT to G, CEP50 to 1σ per axis by ÷√(2 ln 2), a quantization step to RMS
by ÷√12), its citation and locator. Loading recomputes every conversion
exactly and checks the statistic fits the field: a density field takes a
density, a 1σ field an RMS-convertible statistic. Each conversion fixes the
datasheet unit it takes, the SI unit it gives and the statistics it carries:
a CEP50 value must be converted to 1σ, and a quantization step to RMS. A
preset never fills a field that presets do not fill. Biases, tolerances, maxima,
rates and latencies are shown as references and never filled.

Catalog 1 holds ICM-42688-P (accelerometer 70 µg/√Hz, gyroscope 2.8 mdps/√Hz),
MS5611-01BA03 (2.7 Pa RMS at OSR 1024, ArduPilot's setting), RM3100 (15 nT at
cycle count 200), NEO-M9N (2.0 m CEP50, 1.699 m per axis) and INA226 (1.25 mV
step, 0.361 mV RMS). `applySensorPreset` writes only applicable fields; NEO-M9N
and INA226 filled nothing in mapping 1 and kept their reference; mapping 2
fills the GNSS horizontal error and the battery voltage noise.

### Experiment copy

`sensorSnapshot(stored)` returns, for one exact profile version, the stored
configuration (`null` stays `null`), its resolution, its ownership matrix, the
mapping version and the sources of every referenced preset, deep-frozen. The
experiment record of TASK-154 and TASK-165 embeds it verbatim from its exact
aircraft-profile dependency; the project store already fixes an experiment's
inputs after version 1. The record is described in "Experiment record" of
the TASK-154 section.

### Verification (TASK-143)

`tests/sensor-config.test.ts` checks every field's unit, range and owner
against a hand-typed table, both schema bounds and values just beyond them,
the code checks, profile schema 3 and its byte round trip, the three
matrices against TASK-089's own functions and the pinned catalog, the preset
conversions against hand-computed values, the catalog basis hash, and the
experiment copy in a project store. `tests/sensor-form.test.ts` checks the
form's display units and byte round trip. `tests/browser/sensors-tab.spec.ts`
sets sensors through the UI in Chromium and compares the stored profile with
the expected configuration. The roadmap entry records the results.

## Sensor errors in the external-SITL path (TASK-147)

Scope S08 at run time. A sensor configuration (TASK-143) takes effect on
native ArduPilot SITL, stock firmware under decision D-10, through two routes:
generated SITL parameters set the errors ArduPilot owns and are read back
before arming, and MirageSITL distorts the JSON state line it sends. Code
outside `stepInto` runs at configuration time only.

### Ownership matrix schema 3

`OWNERSHIP_MATRIX_SCHEMA_VERSION` is 3. Schema 3 lists 33 sources: the 25 of
schemas 1 and 2 (`ERROR_SOURCE_IDS_V1`) and eight more. A schema 1 or 2 matrix
does not list them and reads each as its stock owner, `stockOwner(source,
path)`: ArduPilot where the pinned firmware applies it, nobody otherwise. Its
parameter profile is unchanged, and `ownerOf(matrix, source)` answers for any
schema. `imuNoiseFloorMatrix` stays at schema 2.

| Source | ArduPilot applies it with | Neutral setting | MirageSITL delivery | Stock owner |
|---|---|---|---|---|
| `imu.latency` | nothing: SITL has no IMU delay | none | `json:imu.accel_body`, `json:imu.gyro` | nobody |
| `imu.misalignment` | `SIM_IMU_ORIENT`, discrete rotations | `SIM_IMU_ORIENT 0` | `json:imu.accel_body`, `json:imu.gyro` | ArduPilot |
| `mag.misalignment` | `SIM_MAGn_ORIENT`, discrete rotations | `SIM_MAGn_ORIENT 0` | `hal:magnetic-field` only | ArduPilot |
| `gnss.position-noise` | `SIM_GPSn_NOISE`, a vertical sine with a period of 12.6 s; V4.7.2 has no horizontal error | `NOISE 0` | none | ArduPilot |
| `gnss.velocity-noise` | `SIM_GPSn_VERR`, uniform per axis | `VERR 0` | none | ArduPilot |
| `gnss.delay` | `SIM_GPSn_LAG_MS`, 100 ms stock | `LAG_MS 0` | none | ArduPilot |
| `battery.voltage` | nothing: the analog chain divides and multiplies by 10.1 | none | `json:battery.voltage` | nobody |
| `battery.current` | nothing: the analog chain divides and multiplies by 17 | none | `json:battery.current` | nobody |

The catalog records the source facts behind each row, read from the pinned
files `SIM_GPS.cpp`, `AP_Compass_SITL.cpp`, `AP_InertialSensor_SITL.cpp`,
`SIM_JSON.cpp`, `SITL_State_common.cpp`, `AnalogIn.cpp`,
`AP_HAL/board/sitl.h`, `AP_BattMonitor_Analog.cpp` and `AP_Math.cpp`.
`SIM_GPSn_*` parameters are built under `#if AP_SIM_GPS_ENABLED`, which the
validator admits only through the cataloged fact `sim-gps-enabled`
(`SIM_config.h` defines it as `AP_SIM_ENABLED`). While MirageSITL owns
`gnss.receiver` (GPS_INPUT), ArduPilot's receiver does not run, so the three
receiver sources cannot be ArduPilot's. The pinned `SITL.h` constructor sets
every `SIM_MAGn_OFS` to (5, 13, −18) mG, which pairs with `COMPASS_OFSn` of
`copter.parm` (fact `compass-stock-offsets`).

The JSON oracle gains `expectedBatteryLine`: SIM_JSON reads the optional
section `"battery":{"voltage":V,"current":A}` as float32 and otherwise uses
`SIM_BATT_VOLTAGE` and 0 A. `encodeStateLineInto` writes it after
`velocity_wind` while `batteryValid` is set; neither key's text occurs earlier
in the line. The bridge validator requires finite numbers in it.

### Ownership mapping 2

`SENSOR_OWNERSHIP_MAPPING_VERSION` is 4. Mapping 1 (TASK-143) is the record of
what TASK-143 shipped; mapping 2 replaced it for every resolution, mapping 3
(TASK-198, decision D-01) replaced mapping 2, and mapping 4 (TASK-117, the
stakeholder's decision of 2026-11-07) replaces mapping 3. Mapping 3 locked
`gnss.horizontalSigmaM`, since ArduCopter V4.7.2 has no horizontal GNSS error.
Mapping 4 makes it MirageSITL's, with no TASK-089 source: in specified mode the run
controller streams an east and a north first-order Gauss–Markov wander of that
standard deviation and a 60 s correlation time (`HorizontalWander`, seeded by the
profile version's SHA-256) into `SIM_GPS1_GLTCH_X` and `_Y`, with the GNSS effects of
TASK-117, and the Run tab admits it while it still refuses the other MirageSITL-owned
errors. A preset fills it again. Experiment records keep the mapping they were made
with, and both 3 and 4 read. What this section says of mapping 2 otherwise holds for mapping 4.

| Owner | Fields | Source and delivery |
|---|---|---|
| MirageSITL | IMU noise densities, biases, position, latency and orientation | the five mapping 1 sources, `imu.latency`, `imu.misalignment`; JSON IMU vectors |
| MirageSITL | Battery voltage and current gain, offset and noise | `battery.voltage`, `battery.current`; JSON battery section |
| ArduPilot SITL | Barometer noise, bias and latency; magnetometer noise and bias | as in mapping 1 |
| ArduPilot SITL | GNSS rate, vertical position error, velocity error and latency | `gnss.receiver` (rate), `gnss.position-noise`, `gnss.velocity-noise`, `gnss.delay` |
| MirageSITL | GNSS horizontal position error (mapping 4) | no source; the run controller's stream into `SIM_GPS1_GLTCH_X`, `_Y` |
| Locked | Magnetometer position | no source: a uniform Earth field reads the same anywhere on the airframe |
| ArduPilot SITL, locked | Magnetometer orientation | `mag.misalignment`: `SIM_MAGn_ORIENT` takes only discrete 45° rotations and MirageSITL delivers no magnetometer data on `native-json`; a small misalignment needs a firmware change (D-10) |

`sensorOwnershipMatrix` derives a schema 3 matrix. The ArduPilot defaults give
every source its stock owner. In specified mode a MirageSITL-owned source is
`mirage` while one of its fields holds a value; the others keep their stock
owner. Ideal sets every source a parameter can switch off to `none`; the IMU
floors, `gnss.receiver` and `mag.hard-iron` stay with ArduPilot, and sources
ArduPilot never applies are `none`. Ideal now writes 159 neutralizing settings
(143, the IMU and three magnetometer orientations, and twelve receiver
settings). The GNSS rate is a setting, not an error, so Ideal keeps
ArduPilot's own.

### SITL parameters

`sensorRuntime(config, catalog, context)` validates the matrix against the
pinned catalog and returns the parameters, their `.parm` text
(`# MirageSITL sensor parameters v1`), the MirageSITL error plans and the
residuals. The context holds the home altitude, the vehicle's `COMPASS_OFSn`
(`STOCK_COMPASS_OFFSETS_MILLIGAUSS` for the pinned `copter.parm`) and the CG.
The parameters are the ownership profile's neutralizing settings and the
ArduPilot-owned values; a name that would receive two values fails the call.

| Field | SITL parameters (n = each instance) | Value |
|---|---|---|
| Barometer noise σ (Pa) | `SIM_BAROn_RND` (BARO, BAR2, BAR3) | √3·σ·\|dh/dp\| m, the half-width of SITL's uniform noise |
| Barometer bias b (Pa) | `SIM_BAROn_GLITCH` | b·dh/dp m; a reading higher by b is an altitude lower by b·\|dh/dp\| |
| Barometer latency (µs) | `SIM_BAROn_DELAY` | latency/1000 ms |
| Magnetometer noise σ (G) | `SIM_MAG_RND` | √3·1000·σ mG |
| Magnetometer bias b (G) | `SIM_MAGn_OFS_{X,Y,Z}` | COMPASS_OFSn − 1000·b mG; Ideal writes b = 0 |
| GNSS rate (Hz) | `SIM_GPSn_HZ` (GPS1, GPS2) | the rate |
| GNSS horizontal σ (m) | none: V4.7.2 has no horizontal error | a stored value is kept and not applied |
| GNSS vertical σ (m) | `SIM_GPSn_NOISE` | √2·σ: a sine of amplitude A gives A/√2 |
| GNSS velocity σ (m/s) | `SIM_GPSn_VERR_{X,Y,Z}` | √3·σ, the half-width of uniform noise |
| GNSS latency (µs) | `SIM_GPSn_LAG_MS` | latency/1000 ms |

dh/dp is the slope of ArduPilot's 1976 standard atmosphere
(`AP_Baro_atmosphere.cpp`) at the home altitude h, with geopotential height
H = R_E·h/(R_E + h), R_E = 6 356 766 m, R_air = 287.053072 J/(kg·K), and the
troposphere's temperature T and pressure p:

\[
\frac{dh}{dp} = -\frac{R_{\mathrm{air}}\,T\,(R_E + h)^2}{p\,g\,R_E^2}
\]

It is −0.0832 m/Pa at sea level and 5.8 % steeper at the 584 m home of the
native harness. An external-SITL session writes the parameters into a defaults
file after `copter.parm` and the user's own defaults, then reads the complete
parameter list (`param_count` entries) before arming. Every generated name the
build holds must report its value as float32; a name the list lacks is
accepted only for a cataloged instance the build does not compile
(`INS_MAX_INSTANCES`, `HAL_COMPASS_MAX_SENSORS`) or for `SIM_GPS2_*` while
`SIM_GPS2_ENABLE` is 0, which hides the rest of its group.

### MirageSITL errors on the JSON state line

`packages/sensors/src/configured.ts` applies the plans of `sensorRuntime`.
`ConfiguredImu.stepInto(f_cg, ω, ω̇, accelOut, gyroOut)` takes the CG specific
force, angular velocity and angular acceleration in body FRD and writes the
sensor-axis IMU vectors:

\[
f_{\mathrm{IMU}} = R^{\mathsf T}\left(f_{\mathrm{cg}} + \dot\omega\times r + \omega\times(\omega\times r)\right) + b_a + \sigma_a n_a,
\qquad
\omega_{\mathrm{IMU}} = R^{\mathsf T}\omega + b_g + \sigma_g n_g,
\qquad
\sigma = N\sqrt{f_s/2}
\]

r is the IMU position minus the CG, R = Rz(yaw)·Ry(pitch)·Rx(roll) maps sensor
axes to body axes (`lever-arm.ts`), N is the one-sided noise amplitude density
and f_s the sample rate. The kinematic part is delayed by the latency: whole
samples exactly, fractions by linear interpolation between the two bracketing
samples, and the oldest sample before enough history exists. Bias and noise are
added at delivery. Each noise term draws standard normals (Box–Muller cosine)
on its own fixed stream: accelerometer 0x00147001, gyroscope 0x00147002,
battery voltage 0x00147003 and current 0x00147004. A zero term skips its
arithmetic and its draws, so a configuration of zeros delivers every bit of an
absent one, −0 included. `ConfiguredBattery` measures
(1 + gain)·true + offset + noise. The session supplies the battery truth; the
native harness sends ArduPilot's 12.6 V and 0 A until TASK-092 adds a battery
model. In the native driver ω̇ is the backward difference of ω at 800 Hz, the
same difference that gives the synthetic quad's specific force.

### IMU mount in the manifest

`DERIVATION_VERSION` was 2 until derivation 3 added the standard landing gear
(TASK-095), derivation 4 the standard hull (TASK-095), derivation 5 the
propeller discs in the supports' clearance (TASK-195) and derivation 6 the
standard hull's preliminary drag (TASK-096). When a profile's sensor configuration states the
IMU position or orientation, the derived manifest holds one `sensorMounts`
entry: `imu`, instance 0, the position (the CG when only the orientation is
stated) and the sensor-to-body quaternion of R from `trig.ts`, so Node and
Chromium derive the same bytes. Otherwise the section stays empty. A
derivation 2 manifest without a mount differs from derivation 1 only in the
version inside its dataset. The sensor pipeline consumes the mounts, so
`projectVehicleToModelV1` no longer refuses them.

### Native harness

`MIRAGE_SITL_SENSORS` names a JSON file `{configuration, seed}` for
`scripts/sitl/driver.mjs`; the driver writes the generated parameters, holds
arming until the complete list confirms them, and applies the plans on every
state line. It runs only on stock firmware without an EW case.
`node scripts/run-sitl-sensors.mjs NEW_DIRECTORY` runs
`scripts/sitl/sensor-probe.mjs`: nine ground cases on fresh SITL instances,
each reading back its parameters and recording HIGHRES_IMU, SYS_STATUS and
GPS_RAW_INT for 6 s after a 20 s settle. `node scripts/check-sitl-sensors.mjs
--input DIRECTORY [--report PATH]` recomputes every mean from the telemetry and
judges against limits fixed from the noise model:

| Check | Cases | Expected |
|---|---|---|
| Hard-iron pairing | Ideal against TASK-089's zero neutral | equal magnetometer means within 1e-6 G |
| Magnetometer bias once | specified against Ideal | b within 1e-5 G |
| Accelerometer bias once | imu-bias against the ArduPilot defaults, over a user `SIM_ACC1_BIAS` of 0.4 m/s² | 1.001·b within 1e-3 m/s², and `SIM_ACC1_BIAS_X` read back as 0 |
| Gyroscope bias once | the same | b within 1e-4 rad/s |
| Misalignment | imu-tilt (pitch 0.05 rad) against the defaults | 1.001·(g sin θ, 0, g(1 − cos θ)) within 1e-3 m/s² |
| Barometer bias once | specified against Ideal | +30 Pa within 1 Pa |
| Battery errors once | specified and Ideal | 12 702 mV and 40 cA; 12 600 mV and 0 cA |
| GNSS rate | specified and Ideal | 60 and 30 fixes in 6 s, ±1 |
| Zero terms | zero-terms, Ideal and the defaults | identical SHA-256 of the first 8000 delivered lines |
| Seeds | two runs with seed 7, one with seed 8 | equal, then different, and different from Ideal |

The 1.001 is `INS_ACCSCAL` of `copter.parm`, which scales every accelerometer
difference. The audit fails when a source it records changed after the capture.

### Residuals (mapping 2)

Ideal lists the IMU noise floors (D-10), the SITL GNSS receiver's own rate and
fixed 0.3 m accuracy, `INS_ACCOFFS` and `INS_ACCSCAL`, the compiled IMU sample
rates, the EKF's assumed delays and ArduPilot's unseeded noise. Specified mode
adds the stock terms without a value and, while a GNSS position error is set,
the receiver's deterministic wander. The hard-iron pairing is no longer a
residual: the capture shows it nets to zero. Sensor snapshot 2
(`SENSOR_SNAPSHOT_VERSION`) adds the residual texts to the experiment record
and carries mapping 2 and its schema 3 matrix. Snapshot 3 (TASK-198) carries mapping 3
and the changed wander text, and an experiment recorded with snapshot 2 is refused
with a reason that names both.

### Verification (TASK-147)

`tests/lever-arm.test.ts` checks centripetal and tangential terms, a
skew-matrix formulation, the rotation order and quaternion against independent
code. `tests/sensor-configured.test.ts` checks bit identity of zero terms, exact
biases, gains, offsets and delays, the noise σ, independence and whiteness
within five standard errors, and seeds. `tests/error-ownership.test.ts` checks
schema 3, the stock owners and the GNSS condition; `tests/sensor-config.test.ts`
checks mapping 2, the parameters against their formulas, the barometer slope
against a finite difference of ArduPilot's atmosphere and the IMU mount;
`tests/integration/sitl-sensors.test.ts` breaks each audit check once. The
roadmap entry records the native captures.

## Barometer v2 (TASK-116)

The pressure errors that dominate barometric altitude near the ground and in fast flight. The
stock ArduCopter V4.7.2 SITL takes no barometer reading from outside: SIM_JSON has no barometer
field, and in the simulator build `AP_Baro::init` returns after creating its SITL barometers,
before it would probe an MSP barometer (checked in the pinned source and in a test run). By the
stakeholder's decision of 2026-11-07 the errors therefore reach ArduPilot as its own barometer
offset: the physics session works them out every step, samples their sum every tenth of a
second of simulated time, and the run controller writes `SIM_BAROn_GLITCH` of each simulated
barometer (`SIM_BARO_COUNT`) through the parameter service. A test run moved ArduPilot's pressure
by −22 Pa for a 2 m offset.

```text
Δp = Σ_j C_j(sign u_j)·½ρ·u_j²            position error, u the vehicle's air velocity in body axes
   + k·q_i·exp(−z/(λ·R̄))                  ground cushion, q_i = T/(4A)
   + c·q_i                                 prop wash
   + r·(t − t_on) + κ·(T − T_on)           drift
   + (τ/3600)·(t − t_on)                   weather pressure trend
SIM_BAROn_GLITCH = held + Δp·dh/dp(home)
```

q_i is ½ρv_i² with the hover induced velocity v_i = √(T/(2ρA)) of momentum theory, for the
rotors' total thrust T and disc area A, so ρ cancels. The position error has the form of
ArduPilot's own `SIM_BAROn_WCF_*`. The cushion's exponential shape and its two constants are a
modelling choice; logged takeoff and landing dips would fit them. Drift and trend accumulate from
the tick their effect goes on. The static port is taken at the CG. Noise and sensor delay stay
ArduPilot's (`SIM_BAROn_RND`, `SIM_BAROn_DELAY`, set from the Sensors tab), and the stream adds to
the Sensors tab's bias, which `SIM_BAROn_GLITCH` already holds. Each write replaces the one before
it; the run counts them (`barometerOffset`) rather than listing each, and ArduPilot's own log has
every one as a PARM record.

The five effects (`EFFECT_CATALOG`, family `barometer`, `packages/physics/src/barometer.ts`):

| Effect | Parameters | Intensity multiplies |
| --- | --- | --- |
| `baro.position-error` | `positiveCoefficient` (forward, right, down) and `negativeCoefficient` (back, left, up), each −2..2 | every C |
| `baro.ground-cushion` | `gain` k 0..10, `decayRadii` λ 0.1..10 rotor radii | k |
| `baro.prop-wash` | `coefficient` c −2..2 | c |
| `baro.drift` | `ratePaPerS` −10..10 Pa/s, `temperaturePaPerK` −100..100 Pa/K | both |
| `baro.pressure-trend` | `trendPaPerHour` −1000..1000 Pa/h | τ |

They need a link to ArduPilot (`delivery.attached`) and a run whose parameters the controller
may write; otherwise they are refused by name. `BarometerErrors.step` neither takes nor returns a
double, since V8 boxes doubles across a call it does not inline: the first allocation probe found
63 bytes a step that way.

Checks, limits set before the first run: `tests/barometer.test.ts`, 6 passed, every effect against
its closed form within 1e-12 relative, off computing nothing, and the offset as TASK-147 converts
the bias. `tests/effect-controls.test.ts`, 8 barometer tests passed through the real session: off
and intensity 0 bitwise identical to absent and sampling nothing, on sampled on the expected ticks
(8 samples from tick 5 to 280 at 400 Hz) and once more, as 0, when it goes off; the inputs filled
from the step; refused without a link. `tests/run-controller.test.ts`: the stream writes the held
value plus Δp·dh/dp to both barometers, nothing for an unchanged error, and the held values when
the last effect goes off. `node scripts/check-bet-runtime.mjs --allocation`, exit 0, with all five
effects among the session graph's commands: 1,848 bytes over 1,000,000 steps, no collections.
`tests/browser/barometer-ground-effect.spec.ts`, 1 passed: the quad X flies twice with native
ArduCopter V4.7.2 through the application alone, `GND_EFFECT_COMP` written to 1 and to 0 on the
Parameters tab and the cushion (k 1.5, λ 2) applied on the Faults tab before take-off; in its
DataFlash logs, while within 1 m of the ground, the barometer read 1.83 m and 1.82 m low and the
EKF's worst height error was 0.13 m with the compensation and 0.39 m without.

### Logged dips (TASK-116, 2026-11-07)

The comparison with logged dips uses the real ArduCopter logs of `data/flight-logs/inventory.json`
(stakeholder's decision of 2026-11-07), kept outside the repository and checked by SHA-256.
`measureBarometerDips` (`packages/analysis/src/barometer-dips.ts`) finds each motor start and stop
in a log and measures the barometer's excess pressure around it against a height reference that
does not use the barometer:

```text
Δp(t) = p_baro(t) − (p_ref − ρ·g·(h_gnss(t) − h_ref))      ρ = p_ref / (R_d · 288.15 K)
```

p_ref and h_ref are the means of the barometer and GNSS altitude over the motors-off window: the
4 s before a start (from −4.5 s to −0.5 s) or after a stop (from +1 s to +5 s). An event counts only
when the throttle (`CTUN.ThO`) stays at or below 0.05 over that whole window, the window holds at
least 10 barometer samples, and the GNSS height at the start or stop is within 0.5 m of h_ref, so
the vehicle is on the ground; otherwise the event is listed as skipped with its reason. The
measured samples are those with the motors on (`ThO` above 0.05) in the 15 s after a start or
before a stop. The GNSS altitude (`GPS.Alt` of the first receiver) is interpolated linearly to the
barometer's times. The air temperature of the hydrostatic correction is not logged and is taken
as 288.15 K, which moves a 1 m correction by about 0.4 % per 1 K. The sample noise is the standard
deviation of the barometer in the motors-off window. The near-ground excess is the mean Δp of the
samples within 0.3 m of h_ref.

The cushion is fitted to the landings, where the thrust is close to the weight, so q_i = m·g/(4A)
from the owner's stated mass and the rotor count and radius: the samples of the 15 s before each
stop with heights from 0 to 2 m (heights below 0 clipped to 0) are fitted by least squares with

```text
Δp = q_i · (k_e · exp(−h / (λ·R)) + c)
```

for λ on a grid of 200 log-spaced values from 0.1 to 10 (the effect's range) and k_e, c linear at
each λ. h is the height above the landed position, so k_e = k·exp(−z₀/(λR)) for a static port z₀
above the ground when landed. The prediction for a held-out log runs the model itself,
`BarometerErrors` with the ground-cushion and prop-wash effects at the fitted k_e, λ and c, on the
held-out log's measured heights.

Declared before the first comparison: a held-out landing's near-ground excess is reproduced when
the prediction is within 5 Pa or 30 % of the measured one, whichever is larger. 5 Pa is about two
standard deviations of one barometer sample in these logs (about 2 Pa) and 0.4 m of altitude, and
30 % covers the stated masses and the GNSS height's lag. Hold-out pairs, of one configuration each:
`tmotor-230kv-24in-6kg` fitted on 00000148 and held out on 00000280; `p80iii-kv100-30in-16kg`
after its flight controller was remounted (00000014 onwards) fitted on 00000014 and 00000016 and
held out on 00000017, 00000023 and 00000025. The other logs are measured and fitted only.
`node scripts/check-baro-dips.mjs --dir DIRECTORY` checks every file's SHA-256 against the
inventory, writes `test-results/validation/logged-baro-dips.json` and exits 0 when every hold-out
is reproduced, 1 when one is not or a file differs, and 2 without the directory.

One rule was added after the first run, because its event list showed it was missing: a start or
stop counts only when the vehicle flew, that is a measured sample at least 1 m above h_ref
(`minFlightHeightM`); motor spin-ups on the ground with the throttle above 0.05 had been counted
as landings. It changed the fits of the 16 kg aircraft and no held-out verdict.

Result (2026-11-07, `node scripts/check-baro-dips.mjs`, exit 1; `tests/barometer-dips.test.ts` 3
passed): the dips are real and differ by aircraft. Near-ground excess and fit per configuration
(k_e, λ, c; q_i from the stated mass):

| Configuration | q_i, Pa | Events (skipped) | Near-ground excess, Pa | k_e | λ | c | Fit RMS, Pa |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `mn7005-kv230-24in-7.2kg` | 15.1 | 2 (0) | 8.1 takeoff, 6.6 landing | 0.79 | 0.75 | −0.27 | 3.4 |
| `tmotor-230kv-24in-6kg` | 12.6 | 4 (4) | 7.3 to 12.9 | 7.69 | 1.25 | −1.05 | 9.1 |
| `tmotor-7005-230kv-24in-7kg` | 14.7 | 2 (0) | 20.8 takeoff, 15.9 landing | 2.20 | 0.78 | −0.40 | 3.6 |
| `mn7005-kv115-24in-12s` | not stated | 2 (0) | −1.4, −0.2 | | | | |
| 16 kg, first mount (00000011) | 18.4 | 5 (7) | 11.6 to 27.6 | 2.53 | 0.67 | −0.34 | 4.6 |
| 16 kg, remounted (00000014 on) | 21.5 | 12 (10) | −4.1 to 2.4 | 0.26 | 0.17 | −0.06 | 3.7 |

Hold-outs: the remounted 16 kg aircraft is reproduced on all three held-out landings (measured
1.65, −2.65, 0.23 Pa; predicted −0.91, 1.26, −0.56 Pa). The 6 kg aircraft is not: its held-out
landing measured 10.43 Pa and the fit predicted 52.35 Pa. The fit's one landing had a single sample
within 0.3 m of the ground, because the GNSS height still read about 0.4 m while the barometer
showed the touchdown, so the exponential was extrapolated to the ground from above 0.3 m (k_e 7.7,
RMS 9.1 Pa). The same aircraft before and after its flight controller was remounted shows a near-
ground excess of 12 to 28 Pa and then of −4 to 2 Pa: where the barometer sits decides the dip, so no
constant fits every aircraft and the cushion's gain belongs to the aircraft's configuration. The
four determined fits give k_e from 0.26 to 2.5 and λ from 0.17 to 0.78; the effect's defaults (k 1,
λ 1) lie within that spread of gains.

**Second list (2026-11-07), declared before its run.** The stakeholder kept the task open for more
landings. The inventory gains the 5-inch quad of topic 145352, which flew indoors with a downward
rangefinder (`RFND`, MTF-02P), the 18 kg quad of topic 96944 and two more logs of the 7 kg aircraft
of topic 140620 (same board serial). `measureBarometerDips` takes a height source: `gnss` as above,
or `rangefinder`, which reads `RFND.Dist` of the first rangefinder where `RFND.Stat` is 4 (good)
and uses a barometer sample only when a good reading lies within 0.25 s of it; the reference height
is the mean reading of the motors-off window, so h is the height above the landed reading. Every
other rule is unchanged, and so is the tolerance. New hold-outs: `m1200-u8xl-32in-18kg` fitted on
`topic-96944-1NN44LN2` and held out on `topic-96944-1aYxm5oh`; `tmotor-7005-230kv-24in-7kg`,
fitted as before on `topic-140620-00000218`, held out on `topic-140620-00000175` and
`topic-140620-12-11-47`. The 5-inch quad's mass is not stated, so its seven logs are measured with
the rangefinder and not fitted. The 6 kg aircraft has no new log, so its miss stands.

Result of the second list (2026-11-07, `node scripts/check-baro-dips.mjs`, exit 1; `tests/barometer-dips.test.ts`
4 passed): no new hold-out is reproduced, so three of eight are over both lists. The 7 kg aircraft's
two other logs show near-ground excesses of 42.6, 37.5 and 36.0 Pa at their landings (24 to 35 Pa at
take-off) where the fit from 00000218, whose landing showed 15.9 Pa, predicts 10.0 to 18.1 Pa: the
same aircraft, the same method, and a dip two to three times larger from one flight to another. The
logs do not tell why; what differs between them is the learned hover throttle (`MOT_THST_HOVER`
0.254 in 00000218, 0.274 and 0.287 in the others, so possibly another load), the receiver's fix
type, which changes how far the GNSS height lags, and the weather. The 18 kg aircraft's held-out
landing measured 3.3 Pa against −9.4 Pa predicted: its fit (k_e 0.98, λ 0.12, c −0.86) is driven by
a strong suction of −15 to −22 Pa in its fit log's low flight that the held-out log shows at −2 to
−13 Pa. The 5-inch quad's barometer scatters 10 to 25 Pa while its motors are off indoors (one
window 0.3 Pa), so its near-ground excesses of −56 to +14 Pa cannot be read at the 5 Pa level; its
low flight shows a suction of −10 to −40 Pa. A dip constant per configuration fitted on one flight
does not carry to that aircraft's other flights within the declared tolerance.

The stakeholder's own flight (2026-11-07, `stakeholder-00000084.BIN` of the inventory: a 4S quad X
on a MatekH743, one AltHold flight indoors with a rangefinder; the banner reads ArduCopter V4.6.2)
is measured with the rangefinder and not fitted, since neither its mass nor its propellers are
stated (`DipAircraft.rotorRadiusM` may now be null, and a fit or prediction then refuses;
`tests/barometer-dips.test.ts` 5 passed). Its barometer reads the largest dips of all the logs: 85 Pa
above static while the motors spin up on the ground and 45 Pa at the touchdown (near-ground means
76.7 and 39.1 Pa), and a suction of 16 to 30 Pa from 0.15 m up in flight, with motors-off scatter of
4.0 and 0.15 Pa. A mass and a propeller size would let it be fitted; a second flight of the same
aircraft would let it be held out.

**The stakeholder's flights 00000116 and 00000167 (2026-11-07), declared before their run.** Two
more flights of the same aircraft (same board serial, ArduCopter V4.6.2), both with
`BATT_CAPACITY` 4800 where 00000084 has 4000, so another battery and possibly another mass. Two
changes, made after a first look at these logs and before any fit of them:

* The flight rule misses a real flight that hovers low: 00000116 hovers 50 s between 0.35 and 0.8 m
  before it climbs, and its landing comes down slowly from 0.65 m. A start or stop now counts as a
  flight when a measured sample reaches 1 m, as before, or when the samples at or above 0.3 m span
  at least 5 s (`lowHoverS`); a spin-up on the ground does neither. Every other event's count
  stays as reported above unless the rerun lists it.
* Without a stated mass and rotor radius the same model is fitted in pressure units: q_i is taken
  as 1 Pa and R as 0.1 m, which only set the units, so k_e is in pascals and λ·0.1 m is the decay
  height. This holds a fit to one aircraft and battery only, where the true q_i and R do not change
  between its flights.

Hold-out: fitted on 00000116 and held out on 00000167, same battery setting, with the declared
tolerance; 00000084 is measured only.

Result (2026-11-07, exit 1; `tests/barometer-dips.test.ts` 7 passed): the hold-out is not
reproduced, three of nine over all lists. The fit on 00000116 (k_e 74.8 Pa, λ at the grid's floor,
a decay height of 0.01 m, c −14.8 Pa) predicts 3.0 Pa for 00000167's landing, which measured 34.8 Pa.
The low-hover rule added one event of the 5-inch quad of topic 145352 and moved no hold-out. Binned
finely against the rangefinder, every flight of the stakeholder's aircraft shows the same two levels:
an excess of 40 to 180 Pa only within 0.03 to 0.06 m of the landed reading, on the ground or in the
first centimetres, and a flat suction of −13 to −30 Pa from about 0.1 m up, the same at 0.15 m and at
3 m; the 5-inch quad of topic 145352 shows the same step to −14 to −45 Pa. The near-ground mean
(heights below 0.3 m) therefore weighs a step by how many barometer samples, at 10 Hz, fall in the
few centimetres where the aircraft sits or touches down with its motors at speed, which differs from
flight to flight: 00000116's slow landing from a 0.6 m hover left 2 to 3 such samples, 00000167's
take-off and landing 4 to 7. This explains the misses with the rangefinder, and very likely those
with the GNSS height, which cannot resolve centimetres. A metric that separates the on-ground
excess from the airborne offset would test the model's shape directly; it would be declared before
a run on new logs, since these have been seen. The stakeholder added on 2026-11-08 that the aircraft
has 3.5-inch propellers and flew some of these flights with a payload, which log not being known: the
pressure-unit fit's premise of one mass across 00000116 and 00000167 may not hold either. The stakeholder
then gave 680 g with the battery and without payload, and asked for the flights to be checked. They
agree with each other: 00000116 and 00000167 lift off at 16,000 to 17,000 rpm and hover at 17,075 and
17,062 rpm on 209 and 206 W, the same thrust within 0.2 % of speed, so the premise holds for this
pair; at 680 g the hover power means an overall efficiency of 0.33 against the ideal 69.8 W, which a
small ducted or multi-blade propeller can give. 00000084 hovers at 21,478 rpm on 212 W: on the same
propellers 1.58 times the thrust would need about twice the power, so it most likely flew other
propellers, and stays out of any fit with the other two. In real units the fit on 00000116 is
k_e 1.11 and λ 0.22 rotor radii (q_i 67.1 Pa); the hold-out's outcome does not depend on the units.

**The two-level metric (declared 2026-11-08, before any run on a log not yet seen).** The model gives
Δp = q_i·(k_e·exp(−h/(λR)) + c): q_i·(k_e + c) on the ground and the flat q_i·c a few decay heights up,
the two levels every rangefinder log above shows. `DIP_TWO_LEVEL`
(`packages/analysis/src/barometer-dips.ts`) measures them apart, with rangefinder heights only, since a
GNSS height cannot resolve the ground band: the on-ground excess is the mean of the motors-on samples
below 0.06 m above the motors-off reference (the step seen at 0.03 to 0.06 m), the airborne offset the
mean of those from 0.15 m to 2 m (the fit's own upper bound), and the samples between count in neither; a
level with fewer than 2 samples is null. `predictTwoLevels` is the fitted model's mean over the same
samples, as `predictNearGroundPa` computes its excess. A held-out landing is reproduced when both levels
are measured and predicted and each is within `DIP_TOLERANCE`. `scripts/check-baro-dips.mjs` judges by it
only the logs of a group's `twoLevelHoldOut`, which only a log added to the inventory after this date may
join; every list is empty now. On the logs seen before, each rangefinder event's two levels and each
held-out landing's predicted two levels are reported with `judged: false`, and the exit status stays the
near-ground mean's. `tests/barometer-dips.test.ts` (8 passed) holds it, declared before the
implementation: on the synthetic landing with 2 s on the ground, each level equals the mean closed-form
excess of its band within 0.02 Pa, the samples between the bands count in neither, the fit's prediction
of each level agrees within 0.02 Pa and passes, and a missing level or a ground level beyond the
tolerance does not pass.

Reported, not judged (2026-11-08, `test-results/validation/logged-baro-dips.json`): on the stakeholder's
held-out landing of 00000167 the airborne offset is reproduced, −14.15 Pa measured against −14.76 Pa
predicted over 142 samples, and the on-ground excess is not, 121.3 Pa against 35.5 Pa over 6 samples. The
fit on 00000116 puts the decay height at its grid's floor, 0.01 m, so over a 6 cm band its exponential
averages to a third of the step the barometer reads on the ground: the measured jump behaves as a step
that the ground contact switches on, not as a cushion that grows with closeness to the ground. The
stakeholder's other flights show the same pattern: on-ground excesses of 19 to 131 Pa and airborne
offsets of −14 to −26 Pa. The 5-inch quad of topic 145352 scatters −40 to +67 Pa on the ground, as its
motors-off scatter of 10 to 25 Pa allows, with airborne offsets of −5 to −57 Pa.

Judged (2026-11-08): the first logs added after the declaration, two U35 logs the stakeholder gave
that day, join the U35 group's `twoLevelHoldOut` (00000332, and log_173, recorded on another
MatekH743 board unit than the group's other logs: the U35 with its flight controller replaced, the stakeholder said). Both
landings are not reproduced. The airborne offset is within the tolerance on both, −11.38 Pa measured
against −14.76 Pa predicted over 146 samples and −10.51 against −14.76 Pa over 102; the on-ground excess
fails on both, 73.18 Pa against 11.31 Pa over 3 samples and 66.83 Pa against −14.42 Pa over 2. The
ground level rests on few samples, since the barometer logs at about 10 Hz and the aircraft spends
little time below 0.06 m, but both miss by far more than their own scatter could explain: the
declared test confirms on unseen landings what the logs seen before only showed, that the model's
cushion does not give the step the barometer reads on the ground. `node scripts/check-baro-dips.mjs`
exits 1 as before, now with 8 landings not reproduced: the 6 earlier near-ground ones and these 2.

## GNSS v2 (TASK-117)

GNSS errors and outages tied to satellite geometry, the terrain that hides satellites, the
atmosphere and jamming (`packages/sensors/src/gnss.ts`). By the stakeholder's decision of
2026-11-07 they reach ArduPilot as its own simulated receiver's parameters, written by the run
controller every 0.2 s of simulated time, off the physics Worker: `SIM_GPS1_GLTCH_X` and `_Y`, the
latitude and longitude offsets in degrees, `_Z` in metres, `SIM_GPS1_NUMSATS`, `SIM_GPS1_ACC` and,
without a fix, `SIM_GPS1_LCKTIME` held off. ArduPilot's receiver keeps its own rate, lag and noise.

* Orbits: the almanac propagation of IS-GPS-200 Table 20-VI (μ = 3.986005e14 m³/s², Ω̇e =
  7.2921151467e-5 rad/s). Since 2026-11-08 the run's constellation is the real GPS almanac of week
  2444 ("Real GPS almanac" below); until then it was synthetic, the Walker 24/6/1 pattern at 55° on
  circular orbits of half a sidereal day, which stays for tests. Later on 2026-11-08 Galileo, GLONASS
  and BeiDou joined it from the IGS broadcast records of 2026-11-07 ("Multi-GNSS broadcast sky"
  below).
* Geometry: elevation and azimuth of each satellite above the mask, and Q = (GᵀG)⁻¹ of the rows
  [−e_E, −e_N, −e_U, 1] for the dilutions; since the multi-GNSS sky one clock column per system
  tracked, [−e_E, −e_N, −e_U, c₁ … c_k].
* Ionosphere: the Klobuchar model of IS-GPS-200 20.3.3.5.2.5 with RTKLIB's default broadcast set;
  the receiver removes it with the same model, so a stated fraction remains. Troposphere: the
  Saastamoinen delays of a standard atmosphere at 70 % humidity, mapped by 1/cos z; likewise.
* Terrain: a line of sight marched over the run's terrain lattice; a blocked satellite is lost, or
  tracked as non-line-of-sight with an excess path. On the synthetic pad nothing is hidden.
* Jamming: (C/N0)_eff⁻¹ = (C/N0)⁻¹ + (J/S)/(Q·R_c) against an open sky of 45 dB-Hz at the zenith
  and 35 at the horizon; below the tracking threshold a satellite is lost.
* Position error: δx = (GᵀG)⁻¹Gᵀδρ of the remaining biases in local east, north, up; the reported
  accuracy is σ·HDOP.

| Effect | Parameters | Intensity multiplies |
| --- | --- | --- |
| `gnss.constellation` | `maskDeg` 0..30°, `uereM` σ 0.1..30 m | σ |
| `gnss.atmosphere` | `ionosphereResidual` 0..2, `troposphereResidual` 0..2 | both |
| `gnss.terrain` | `nlosExcessM` 0..200 m | the excess |
| `gnss.jamming-budget` | `jammingToSignalDb` −30..80 dB, `spectralSeparation` Q 1..2, `thresholdDbHz` 15..40 | J/S (by 10·log10 i dB) |

GNSS effects and `ew.gnss-jamming` write the same receiver parameters, so each is refused while
the other is on. The stream also carries the Sensors tab's horizontal GNSS error (mapping 4):
a seeded first-order Gauss–Markov wander per horizontal axis, x ← φ·x + σ·√(1 − φ²)·w with
φ = e^(−Δt/60 s), added to the solution's east and north error; the 60 s correlation time is a
modelling choice that logged open-sky data would fit. `tests/gnss-errors.test.ts` holds its
variance within 5 % of σ² and its lag-one correlation within 0.005 over 1,000,000 steps, and
`tests/run-controller.test.ts` its writes every 0.2 s, of metres, repeated by the same profile.

Checks, limits set before the first run: `tests/gnss-errors.test.ts`, 12 passed: the dilutions of
one satellite at the zenith and three on the horizon (HDOP = VDOP = √(4/3), TDOP = √(1/3), GDOP =
√3) within 1e-9; a common bias goes into the clock and a zenith bias moves the fix down by itself;
a circular orbit against an independent rotation within 1e-6 m and half a sidereal day; the
Klobuchar floor and peak; the Saastamoinen dry zenith delay 2.3070 m; the jamming budget 20.08
dB-Hz; a ridge hiding a satellite at 20° and not at 30°; on the synthetic sky four to twelve
satellites through a day, an atmosphere error linear in its residual and mostly vertical, a wall
losing or reflecting the eastern sky, and a jammer losing the fix. `tests/run-controller.test.ts`:
off writes nothing; on, the count and σ·HDOP as an independent solution gives them, offsets for
the atmosphere, the lock held off by a jammer, the held values back when every effect is off, and
GNSS jamming refused meanwhile. Not yet: a real almanac or broadcast ephemeris, the multipath
envelope and C/N0-dependent noise, the receiver's own latency and rate, jamming from EW zones
(`packages/ew/src/engine.ts`), a native SITL flight with the stream, and the comparison with
logged open-sky and urban statistics (BLOCKED_EXTERNAL).

### Logged receiver statistics (TASK-117, 2026-11-07)

The real ArduCopter logs of `data/flight-logs/inventory.json` (stakeholder's decision of
2026-11-07) hold what each first receiver reported: its fix type (`GPS.Status`), satellites,
HDOP and its own accuracy estimates (`GPA.HAcc`, `VAcc`, `SAcc`). They do not hold its position
error: that needs a reference position, and the logs record GNSS only while armed, apart from 157 s
before the first take-off of one log, too short for a correlation time of a minute. The position-
error statistics of the DoD therefore stay BLOCKED_EXTERNAL, and no limit applies to what follows.
`gnssLogStatistics` (`packages/analysis/src/gnss-statistics.ts`) gives nearest-rank 5th, 50th
and 95th percentiles of the epochs with a 3-D fix or better, and the GNSS v2 model's geometry at the
same positions and GPS times (`gnssSolution` on the synthetic Walker 24/6/1 constellation with the
`gnss.constellation` defaults, mask 10° and σ 1.5 m, one solution per 10 s). TimeUS and GMS are read
in their stored units whatever FMTU scales them to. `node scripts/check-gnss-stats.mjs --dir
DIRECTORY` checks every file's SHA-256 and writes `test-results/validation/logged-gnss.json` without
any position; exit 0 REPORTED, 1 for a missing or different file, 2 without the directory.

Result (2026-11-07, exit 0; `tests/gnss-log-statistics.test.ts` 2 passed), medians:

| Receiver (logs) | Satellites | HDOP | HAcc, m | VAcc, m | Model satellites | Model HDOP | Model σ·HDOP, m |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CubePilot Here4 (6 logs, SBAS) | 31 to 32 | 0.46 to 0.50 | 0.22 to 0.27 | 0.38 to 0.47 | 6 to 8 | 0.88 to 1.35 | 1.33 to 2.02 |
| CUAV Neo 3 Pro (2 logs) | 24, 29 | 0.56, 0.48 | 1.47, 0.80 | 1.99, 1.16 | 6, 7 | 1.13, 1.11 | 1.70, 1.66 |
| not stated (00000218) | 30 | 0.47 | 0.70 | 1.18 | 8 | 0.98 | 1.47 |
| not stated (KV115 aircraft) | 15 | 0.66 | 0.66 | 1.15 | 7 | 0.99 | 1.49 |
| NMEA receiver (00000205) | 28 | 0.60 | 1.52 | 2.04 | 8 | 0.88 | 1.31 |

The real multi-constellation receivers track four to five times the satellites of the synthetic
GPS-only sky and report about half its HDOP; the Here4 reports a horizontal accuracy six to seven
times smaller than the model's default σ·HDOP. The NMEA receiver of 00000205 reported 28 satellites
and HDOP 0.60 at every one of its 26,487 epochs: values it held, not measurements. A real
multi-constellation almanac and a receiver-class σ are what the comparison asks for.

The second list (2026-11-07) adds four outdoor logs; the seven indoor logs of topic 145352 have no
fix and are listed with that reason, not counted. Medians: the 18 kg aircraft's receiver (not
stated; 3-D fix only) 16 and 15 satellites, HDOP 0.66 and 0.68, HAcc 0.83 and 0.81 m, VAcc 1.49 and
1.29 m against the model's 8 and 6 satellites, HDOP 0.92 and 1.30 and σ·HDOP 1.39 and 1.95 m; the
7 kg aircraft's two other logs 30 satellites, HDOP 0.52, HAcc 0.65 and 0.62 m, VAcc 1.05 and 1.07 m
against 7 and 8, HDOP 0.98 and 0.87 and 1.48 and 1.31 m. The pattern holds: four times the
satellites, half the HDOP. Still no reference position, so the error statistics stay
BLOCKED_EXTERNAL.

### Real GPS almanac (TASK-117, declared 2026-11-08)

Recorded before the implementation. The approved download from navcen.uscg.gov succeeded on its
retry of 2026-11-08 (the address now redirects to the host without `www`): `current_yuma.alm`, GPS
week 396 modulo 1024, so week 2444 (2026-11-08 to 11-14; corrected in "Multi-GNSS broadcast sky"
below), time of applicability 233,472 s, 32
satellites, 19,008 bytes. It is stored unchanged as `data/gnss/yuma-2444.alm` (a United States
Government work, public domain) and registered in `config/offline-inventory.json` with its SHA-256.
`packages/sensors/src/gps-almanac.ts` holds its elements as a module, so the browser, the tests and the
Node scripts read the same values without a file loader; `tests/gps-almanac.test.ts` parses the stored
file with `parseYumaAlmanac` and requires the module equal to it field for field, and the file's
SHA-256 equal to the inventory's. The run's sky becomes this almanac at week 2444, simulated time 0
at its time of applicability, in place of the Walker 24/6/1 pattern, which stays for tests;
`gnssLogStatistics` propagates it to each log's own GPS time and reports how many weeks lie between.
Checks, limits set now: every satellite's orbital radius from `almanacEcefInto` within 1e-6 m of
a(1 − e cos E) over a day, and after one period 2π/n its ECEF position, rotated about the z axis by
the angle the node moved in ECEF over that period ((Ω̇ − Ω̇e)·2π/n), back at its start within 1e-3 m,
as independent forms of the same elements; at the default home (32° N,
35° E) over the 24 hours from the time of applicability, with the 10° mask, between 6 and 14 healthy
satellites at every 10-minute step (the published GPS-only range at mid-latitudes, information for
a plausibility bound, not a fidelity limit) and HDOP below 2.5 throughout. The logged statistics are
shown, not judged (SA-01): a GPS-only sky still cannot show the counts of a multi-constellation
receiver, and an almanac propagated weeks or years from its epoch gives real orbital planes and slot
spacing but not that day's positions; Galileo, GLONASS and BeiDou almanacs would need another
download.

Result (2026-11-08; `tests/gps-almanac.test.ts` 3 passed on the first run, `tests/gnss-log-statistics.test.ts`
2, `tests/gnss-errors.test.ts` 13, `tests/run-controller.test.ts` 136, `tests/offline-inventory.test.ts`
passes with 8 hashed files): the module equals the file; every orbit keeps a(1 − e cos E) and closes after
its period; at the default home over the day 7 to 11 satellites (median 9) and HDOP 0.74 to 1.58. Two tests
changed with the sky: the run's GNSS stream at the test's home now tracks 10 satellites, the count the
simulated receiver already holds, so only its accuracy is written, and the offline check hashes the almanac
as an eighth file. `node scripts/check-gnss-stats.mjs` (exit 0; the report names the almanac and each log's
distance from it, 10 to 194 weeks): the model's medians become 7 to 12 satellites and HDOP 0.73 to 1.68,
against the synthetic sky's 6 to 8 and 0.87 to 1.35 and the receivers' 15 to 32 and 0.46 to 0.68. A real
GPS-only sky closes part of the satellite gap (now about three times, not four to five) and none of the
HDOP gap; the rest is the other constellations.

A receiver of known model joined on 2026-11-08: the ArduPilot Methodic Configurator's Tarot X4 template
log (GPL-3.0; `amc-tarot-x4` in the inventory, Holybro M9N, 709 epochs over 141.6 s) reports a median of
27 satellites, HDOP 0.54 and HAcc 0.31 m, against the model's 10 satellites, HDOP 0.87 and σ·HDOP 1.3 m
at the same place and time, 118 weeks before the almanac. The 21 logs the stakeholder gave that day have no
GNSS and are listed with that reason.

### Multi-GNSS broadcast sky (TASK-117, declared 2026-11-08)

Recorded before the implementation. On 2026-11-08 the stakeholder approved the download of one daily
multi-GNSS broadcast navigation file: `BRDC00IGS_R_20263110000_01D_MN.rnx.gz` from the IGS data centre
of BKG (igs.bkg.bund.de, directory `IGS/BRDC/2026/311/`), 1,246,410 bytes, SHA-256
`3d67b94184459700c2b969e7f791b769d925fb3eefbb1f9d78f4f3d2586b8fa3`: the IGS merged RINEX 3.04 mixed
navigation file of 2026-11-07, day 311, the Saturday of GPS week 2443. Correction: GPS week 2444 runs
from 2026-11-08 to 11-14, not from 11-01 to 11-07 as "Real GPS almanac" said; the almanac's time of
applicability, 233,472 s, is Tuesday 2026-11-10 16:51:12 GPS time, a future epoch, as almanacs are
issued. The file stays outside the repository (10.8 MB unpacked). IGS products are freely available,
and IGS asks users to cite them.

* Generator: `node scripts/gnss-broadcast-elements.mjs --input FILE` (cold) checks the file's SHA-256,
  unpacks it, parses its GPS, Galileo, GLONASS and BeiDou records and writes
  `data/gnss/broadcast-2026-311.json` and the module `packages/sensors/src/gnss-broadcast.ts`, both from
  the same values. `--check` regenerates both and compares them byte for byte with the stored files:
  exit 0 equal, 1 different, 2 (BLOCKED_EXTERNAL) without the file. The data file names the source
  file, its size, SHA-256 and address, the reference epoch and the selection rule, and is registered in
  `config/offline-inventory.json` with its own SHA-256. QZSS, NavIC and SBAS records are not used.
* Reference epoch and selection: T_ref = 2026-11-07 12:00:00 GPS time (week 2443, 561,600 s), the
  middle of the file's day. For each Galileo, GLONASS and BeiDou satellite the healthy record (Galileo:
  SV health 0 in an I/NAV record, data source bit 0 or 2; GLONASS: health Bn 0; BeiDou: SatH1 0)
  whose reference time (toe, or tb, in GPS time) is nearest T_ref, the earlier on a tie. A satellite
  without a healthy record is left out. GPS stays the YUMA almanac; the file's GPS records serve only
  as a check.
* Time: Galileo system time and week equal GPS time (their offset of nanoseconds is ignored); BeiDou
  time is GPS time − 14 s and its week the GPS week − 1356; GLONASS epochs are UTC(SU), and GPS time =
  UTC + 18 s (the file header's LEAP SECONDS). Frames: GTRF, CGCS2000 and PZ-90.11 are taken as WGS 84;
  they differ by centimetres to decimetres.
* Galileo, and BeiDou MEO and IGSO: the broadcast Keplerian algorithm with Δn, IDOT and the harmonic
  corrections Cuc to Cis, with the constants of the Galileo OS SIS ICD (issue 2.1, section 5.1.1:
  μ = 3.986004418e14 m³/s², Ω̇e = 7.2921151467e-5 rad/s) and of the BeiDou B1I ICD
  (BDS-SIS-ICD-B1I-3.0, its user algorithm for the ephemeris, CGCS2000: μ = 3.986004418e14 m³/s²,
  Ω̇e = 7.2921150e-5 rad/s).
  BeiDou GEO (PRN 1 to 5 and 59 to 63): that ICD's GEO algorithm, the node without the Earth's
  rotation, the orbit turned by −5° about x and by Ω̇e·tk about z.
* GLONASS: the broadcast PZ-90 state vector at tb (GLONASS ICD, edition 5.1) holds ±15 min by
  integration. For a day's sky, and for logs years away, it becomes osculating Keplerian elements in
  the inertial frame aligned with PZ-90 at tb (velocity plus ω₃ × r), propagated with the first-order
  J2 secular rates Ω̇ = −(3/2)·n̄·J2·(a_e/p)²·cos i, ω̇ = (3/4)·n̄·J2·(a_e/p)²·(5 cos²i − 1) and
  Ṁ = n̄·[1 + (3/4)·J2·(a_e/p)²·√(1 − e²)·(3 cos²i − 1)], with the ICD's constants (GM =
  398600.4418e9 m³/s², a_e = 6,378,136 m, J2 = 1082625.75e-9, ω₃ = 7.292115e-5 rad/s). The mean
  motion n̄ comes from the mean semi-major axis ā = a − (3/2)·(J2·a_e²/a)·sin²i·cos 2u, the
  short-period term a near-circular orbit's energy gives; the position itself keeps the osculating
  elements, so at tb it is the broadcast one. The broadcast luni-solar accelerations hold only ±15 min
  and are dropped. Expected error over a day: kilometres to a few tens of kilometres, from the
  short-period and luni-solar terms left out; at the nearest range of 19,100 km that is about a tenth
  of a degree, which changes visibility only at the mask and the DOP not visibly.
* Far from T_ref, as for the GPS almanac, the elements give real orbital planes and slot spacing but
  not that day's positions; IDOT turns the Galileo and BeiDou inclinations linearly, which the logged
  statistics state at the farthest log.
* Position solution: one receiver clock per system among the tracked satellites. The rows of G are
  [−e_E, −e_N, −e_U, c₁ … c_k] with c_j = 1 for the satellite's own system, Q = (GᵀG)⁻¹, and a fix
  needs at least 3 + k satellites. HDOP, VDOP and PDOP as before; GDOP from the whole trace; TDOP is
  the clock of the first system present in the order GPS, Galileo, GLONASS, BeiDou. With one system
  the arithmetic is the four-unknown one, unchanged bit for bit.
* The run's sky becomes the GPS almanac plus the three systems, simulated time 0 at T_ref instead of
  the almanac's time of applicability, so that every system is used within a day of its data (the
  almanac then 3.2 days before its time of applicability). `gnssLogStatistics` uses the same sky at
  each log's GPS time and also reports the visible satellites per system. ArduPilot V4.7.2 keeps
  `SIM_GPS1_NUMSATS` as an AP_Int8 (`libraries/SITL/SITL.h`), so counts up to 127 pass unchanged.

Checks, limits set now (`tests/gnss-broadcast.test.ts`; the DOP in `tests/gnss-errors.test.ts`):

1. The module equals the data file field for field, the data file's SHA-256 equals the inventory's,
   and `--check` reproduces both files from the RINEX file.
2. GLONASS: the model at tb returns the broadcast position within 1e-3 m (the element conversion and
   its inverse).
3. Against truth from the file itself: for each satellite, its records nearest T_ref ± 3, 6, 9 and
   12 h (within 1 h of the mark and at least 1 h from the selected record), each evaluated at its own
   reference time (Keplerian at tk = 0 by the generator's separate implementation; GLONASS, the state
   vector itself). The propagated position lies within 0.3° of it seen from the nearest point of the
   Earth: an error of at most (|r| − 6,378 km)·0.3·π/180, about 100 km for GLONASS, 120 km for Galileo,
   110 km for BeiDou MEO and 190 km for BeiDou IGSO and GEO. The same bound holds for the GPS almanac
   against the file's GPS records, 3.2 to 3.7 days before its time of applicability.
4. Every BeiDou GEO stays through the file's day within 3° of the equator and within 1 % of the
   geostationary radius, 42,164 km.
5. At the default home (32° N, 35° E, 100 m) over T_ref ± 12 h at 10-minute steps with the 10° mask:
   GPS 6 to 14, Galileo 4 to 13, GLONASS 4 to 12, BeiDou 6 to 20 and all systems 25 to 50 satellites at
   every step, and the multi-system HDOP below 1.0 throughout (plausibility bounds from the published
   mid-latitude counts, not fidelity limits).
6. The multi-system DOP against a case computed by hand, within 1e-9: GPS at the zenith and on the
   north and south horizons, and Galileo at the zenith and on the east and west horizons, give HDOP 1,
   VDOP √(3/4), PDOP √(7/4), each clock √(5/12) and GDOP √(8/3); a second system with one satellite
   leaves a one-system case's position DOPs unchanged; and a bias common to one system's satellites
   moves only its clock, the position error within 1e-9 m of zero.

The run's GNSS stream test and the logged statistics are recomputed on this sky; the comparison with
the receivers is shown, not judged (SA-01).

Result (2026-11-08). The generator selected 28 Galileo, 24 GLONASS and 37 BeiDou satellites (4 of
them GEO, PRN 1 to 4) and 995 check records; the file's header gives 18 leap seconds. The data file
is 171,708 bytes; `--check` reproduces both outputs (exit 0, EQUAL), and without `--input` the
generator exits 2. `tests/gnss-broadcast.test.ts` 5 passed on the first run, `tests/gnss-errors.test.ts`
15 (two new), `tests/gps-almanac.test.ts` 3, `tests/gnss-log-statistics.test.ts` 2,
`tests/run-controller.test.ts` 136 and `tests/offline-inventory.test.ts` 11, with 9 hashed files.

1. The module equals the data file, and the data file the inventory.
2. GLONASS at tb: largest difference 1.8e-8 m.
3. Largest errors against the file's own records, and their largest share of the 0.3° bound: Galileo
   0.84 km (0.7 %; 221 checks), GLONASS 7.4 km (7.4 %; 190), BeiDou MEO 0.96 km (0.8 %; 224), IGSO
   1.85 km (1.0 %; 40) and GEO 2.2 km (1.2 %; 32), each at 9 to 12 h from the selected record; the GPS
   almanac 6.9 km (6.5 %; 288) at 3.2 to 3.7 days before its time of applicability.
4. BeiDou GEO: at most 2.78° from the equator and 0.05 % from 42,164 km.
5. At the default home through the day: GPS 7 to 11 (median 9), Galileo 5 to 12 (9), GLONASS 5 to 9
   (7), BeiDou 8 to 14 (11), all 30 to 41 (35); HDOP 0.39 to 0.56, median 0.46.
6. The hand case passes within 1e-9, but its GDOP is √(31/12), not the √(8/3) the declaration wrote:
   1/2 + 1/2 + 3/4 + 5/12 + 5/12 is 31/12, an addition error in the declared value, not in the
   implementation. The other declared values (HDOP 1, VDOP √(3/4), PDOP √(7/4), each clock √(5/12))
   pass as written; so do the one-satellite second system, the bias moved into its own clock, and one
   clock equal bit for bit to the four-unknown arithmetic.

Every system takes the GPS L1 ionosphere and the C/A chip rate. BeiDou B1I and GLONASS G1 lie within
2 % of L1 in frequency, so their ionospheric delays differ by up to 4 %; their chip rates, 2.046 and
0.511 Mchip/s, put their jamming margins 3 dB above and below the C/A one, which the jamming budget
does not yet model.

The run's GNSS stream test changed with the sky: at ArduPilot's Canberra test home, 50 s into the
run, 36 satellites are tracked (GPS 8, Galileo 10, GLONASS 5, BeiDou 13, whose IGSO and GEO
satellites serve the Asia-Pacific) instead of the 10 the receiver holds, so `SIM_GPS1_NUMSATS` is
written as well as `SIM_GPS1_ACC` (σ·HDOP 0.73 m; the GPS almanac alone gives HDOP 1.16 at that
moment, 0.94 at the former epoch). `node scripts/check-gnss-stats.mjs` (exit 0; 16 logs with a fix,
48 listed): the model's medians become 31 to 46 satellites and HDOP 0.39 to 0.53 (σ·HDOP 0.58 to
0.79 m), against the GPS-only sky's 7 to 12 and 0.73 to 1.68 and the receivers' 15 to 32 and 0.46 to
0.68. Each log's GPS median is unchanged; per log the report adds the medians per system and the
weeks from the sky's epoch (9 to 193 before it).

| Receiver (logs) | Satellites | HDOP | Model satellites (GPS, Galileo, GLONASS, BeiDou) | Model HDOP |
| --- | --- | --- | --- | --- |
| CubePilot Here4 (6 logs) | 31 to 32 | 0.46 to 0.50 | 31 to 35 (7–10, 8–11, 6–8, 7–9) | 0.46 to 0.53 |
| CUAV Neo 3 Pro (2 logs) | 24, 29 | 0.56, 0.48 | 43, 40 | 0.40, 0.40 |
| Holybro M9N (amc-tarot-x4) | 27 | 0.54 | 37 (10, 11, 9, 7) | 0.44 |
| not stated (6 logs) | 15 to 30 | 0.47 to 0.68 | 36 to 46 | 0.39 to 0.44 |
| not stated (00000205) | 28 | 0.60 | 41 | 0.41 |

The model now holds more satellites than most receivers report. It counts every healthy satellite of
four systems above 10°, while a receiver reports those it uses, from the systems it is set to track
(a u-blox M8 tracks three at once) and up to its own limits; the Here4's 31 to 32 at every epoch
look like such a limit. Its HDOP comes within 0.05 of the Here4's and lies below the others'. Far
from the sky's epoch IDOT turns the Galileo and BeiDou inclinations by up to 7.6° at the farthest log
(193 weeks; `inclinationDriftDeg` in the report), 3.1° at the Here4 logs: their planes then differ
from the real ones by that much.

## Electromechanical drive (TASK-092)

The production drive replaces the ideal torque-source ESC with an ESC, a
voltage-driven DC motor and one battery bus shared by all motors, so the
throttle-to-thrust curve and battery sag follow from the physics. It is
interface v2 drive mode 1 and the `bet_bus_step` export; drive mode 0 and the
v1 interfaces are unchanged bit for bit. A trajectory digest of 4000 varying
v1 steps is identical before and after the change.

### Motor and ESC law

`DriveMotor` (`native/bet/src/motor.rs`) takes the winding resistance R, the
SI torque constant k_t = k_e, the current limit I_max, the brake current limit
I_brake ≥ 0, the no-load torque τ₀ = k_t·I₀ (I₀ the card's no-load current),
the command lag τ_cmd and the ESC update period T_esc. The legacy TASK-025
`Motor`, without braking or friction, stays for its own tests.

\[
i = \operatorname{clamp}\!\left(\frac{d\,V_{\mathrm{bus}} - k_e\,\Omega}{R},\; -I_{\mathrm{brake}},\; I_{\max}\right),
\qquad
\tau_{\mathrm{em}} = k_t\, i,
\qquad
P_{\mathrm{terminal}} = i\,(i\,R + k_e\,\Omega)
\]

The ESC samples its target duty when its countdown has run out (within
dt·1e-9), holds it for T_esc (every step when T_esc is shorter than the step)
and follows it with d ← d* + (d − d*)·exp(−dt/τ_cmd). A power cut, or a zero
bus voltage, makes the bridge unpowered: zero current, so no drive and no
braking; a cut also zeroes the ESC state, which resamples afterwards.

Over one step the shaft (`Shaft::step_driven`) integrates
J·dΩ/dt = τ_drive − (b + B)·Ω + s·Q_air − τ₀ with the exact constant-torque
viscous solution. Inside the current limits, at the start speed,
τ_drive = k_t·d·V/R and B = k_t²/R, so the back-EMF is implicit and the
electrical time constant does not limit the step; at a limit,
τ_drive = k_t·i_limit and B = 0. The Coulomb torque τ₀ opposes rotation; a
stopped shaft stays stopped while the net torque does not exceed τ₀. Braking
or friction that stops the shaft is inside the model; only an air torque that
would turn it backwards past τ₀ sets flag 16. With τ₀ = 0, B = 0 and a
non-negative drive, `step_driven` equals the v1 `step` bit for bit.

### Drive mode 1 record and arena

Drive mode 1 uses `esc_duty` (target duty [0, 1]) and `bus_voltage` (V ≥ 0) at
their reserved offsets, requires `motor_torque` = 0, and reads the parameters
at bytes 192–247 and `drive_flags` at 248 (bit 0: power cut); see the input
table of "Step interfaces v2". Drive mode 0 still requires bytes 120–135 and
192–255 to be neutral. The ESC state (duty, held target, countdown) occupies
arena header bytes 32–55, which v1 requires to be zero, so a live ESC arena
refuses torque steps until `bet_bound_reset` or a power cut clears it.
Everything is computed before anything is written; a rejected record changes
neither the arena nor the output.

Drive mode 1 writes the electrical outputs at the midpoint speed, where the
aerodynamics were evaluated: `motor_current` i, `bus_current` = P_terminal/V
(0 at V = 0), `electrical_power` = P_terminal and `copper_loss` = i²·R, with
validity bit 1. `shaft_power` is the electromagnetic torque at the start speed
times that speed. Output flag 32 marks a step whose current sat at a limit.

### Shared bus

`bet_bus_step(input, output, dt)` steps the TASK-026 battery: linear
open-circuit voltage between the empty and full values, internal resistance,
charge in coulombs, a current limit in both directions. A negative demand
regenerates: the current is the negative root of the same quadratic, and the
charge never exceeds 1 (flag 2 when the pack was full). A demand beyond what
the pack can deliver or absorb is limited (flag 1). Positive demands give the
TASK-026 values bit for bit.

\[
I = \frac{2P}{V_{oc} + \sqrt{V_{oc}^2 - 4\,R_{\mathrm{int}}\,P}},
\qquad
V_{\mathrm{bus}} = V_{oc} - I\,R_{\mathrm{int}}
\]

### Shared bus input v1

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | version | version |
| 4 | u32 | — | reserved_zero |
| 8 | f64 | V | open_circuit_full |
| 16 | f64 | V | open_circuit_empty |
| 24 | f64 | Ω | internal_resistance |
| 32 | f64 | C | capacity_coulomb |
| 40 | f64 | A | current_limit |
| 48 | f64 | 1 | state_of_charge |
| 56 | f64 | W | motor_power |
| 64 | f64 | W | house_power |
| 72..127 | u32[14] | — | reserved_zero |

### Shared bus output v1

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | f64 | 1 | state_of_charge |
| 8 | f64 | V | voltage |
| 16 | f64 | A | current |
| 24 | f64 | W | delivered_power |
| 32 | f64 | W | internal_loss |
| 40 | f64 | W | source_power |
| 48 | u32 | bitmask | flags |
| 52..127 | u32[19] | — | reserved_zero |

Statuses: 0, −2 record length or pointers, −3 invalid input or charge, −7
version. `BetBus` (`@mirage/wasm-bet/bus`) owns one record pair in its own
instance. A hot caller writes the charge, the motor power and the house power
into its preallocated `input` slots and calls `stepFromInput()`;
`stepInto(soc, motorPowerW, housePowerW)` is the cold form over the same slots.
V8 boxes a double passed as an argument to a call it does not inline, and the
flight step with its weather code is too large to inline the bus step: passed
as arguments, those doubles cost 32 B on every tick of an ESC-drive run with a
weather, until TASK-145's allocation graph found it.

### Solving the bus with the motors (TASK-197)

An ESC multiplies the bus voltage by its duty, so what the motors draw depends on the
voltage, and the voltage on what they draw. Physically the two agree at once, because the
electrical time constants are far shorter than a tick. `bet_bound_bus_solve_v2(table, count,
bus, output, dt)` finds that agreement for the step the rotors are about to take, from
each motor's filtered duty for the step and the speed the step starts at. `table` holds
`count` pairs of u32, an arena and its v2 input record as `bet_bound_step_v2` takes them,
and `bus` is a shared bus input v1 with `motor_power` zero. It changes neither, and writes
only the record below. `bet_bus_solve_version` returns 1.

\[
V\,(V_{oc} - V) = R_{\mathrm{int}}\Big(P_{\mathrm{house}} + \sum_k P_k(V)\Big),
\qquad
P_k(V) = i_k\,(i_k R_k + k_t \Omega_k),
\qquad
i_k = \operatorname{clamp}\Big(\frac{d_k V - k_t \Omega_k}{R_k},\, -I_{\mathrm{brake}},\, I_{\max}\Big)
\]

The upper branch of that equation is the bus voltage, found by a safeguarded Newton search
to 1e-9 V, in at most 9 steps over 20 000 random mixes of motors and packs. When the
motors at the pack's lowest voltage, V_oc − I_cap·R_int, still ask for more than it delivers,
the pack stays at that voltage and at I_cap, flag 1 is set, and the voltage the ESCs
multiply falls to the V_m below. That is the same as every ESC's effective duty falling by one
shared factor, since the winding sees d·V either way. The house load is served first; if
it takes everything, V_m is 0.

\[
P_{\mathrm{house}} + \sum_k P_k(V_m) = I_{\mathrm{cap}}\,(V_{oc} - I_{\mathrm{cap}} R_{\mathrm{int}})
\]

A real pack does not stop at its rated current: its voltage sags further and it heats. The
model has treated the rating as a ceiling since TASK-026 and flags reaching it, so a result
at the limit means the rating was reached, not what the pack would do beyond it.
Regeneration beyond what the pack absorbs does not hold the motors back: the excess is not
stored, as in the bus step, and flag 1 is set.

### Shared bus solution v1

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | f64 | V | motor_voltage |
| 8 | f64 | V | pack_voltage |
| 16 | u32 | bitmask | flags |
| 20 | u32 | 1 | iterations |
| 24..63 | u32[10] | — | reserved_zero |

Statuses: those of the bus records and of `bet_bound_step_v2`, and −3 for a count outside
1 to 32 or a rotor not in drive mode 1. A negative status leaves the output unchanged.

### Coupling and energy budget

Each tick, before the rotors step, the bus and the motors are solved together (see "Solving
the bus with the motors"), and every rotor runs on the voltage found. A one-tick lag between
them is unstable once the loop gain passes 1: on the example quad at full duty, 803 W/V
times 0.0013 V/W is 1.05, and until TASK-197 the bus flipped every tick between 14.55 and 15.99 V.

The rotors then step, and the bus delivers the sum of the motors' terminal powers,
evaluated at the midpoint speed where the aerodynamics were. So the pack's voltage after a tick
can differ from the one the motors ran on by what half a tick of spin-up changed the current:
at most 0.042 V on the hardest steps of the example cards, and nothing once the speeds settle.
On every tick the bus is not limited, the source power V_oc·I equals the internal
loss I²·R_int plus the delivered power, and the delivered power equals the summed
terminal powers, each of which is copper loss plus k_t·i·Ω. The bus current recorded per
motor is its terminal power over the pack's voltage, so with the house load these sum to the
pack's current, which is the root above.

### Verification (TASK-197)

`native/bet/tests/bus_solve.rs` checks the solver by hand: the voltage's closed form for equal
motors, the pack's law at its limit, flat loads at a current limit, regeneration, a dead pack,
and 20 000 random mixes for consistency and the step count. `tests/bus-coupling.test.ts`
flies the dynamics on a body too heavy to move on all five S19 configurations: the bus settles
at every duty, and a flight at full command matches `thrustCapacity` within 0.5 %.
`tests/integration/flight-tasks-sitl.test.ts` flies a climb with native ArduCopter on a pack
limited just above hover current, which stays within 0.1 A of the limit in every physics step.

### Flight dynamics, manifest and parameter profile

`BetFlightConfiguration.drive` (`EscDriveConfiguration`) selects the drive:
one `EscDriveMotor` per rotor in rotor order (R, k_t, I_max, I_brake, τ₀,
τ_cmd, T_esc), the `BusBattery`, the initial state of charge in (0, 1] and a
constant house load ≥ 0 W. Absent, each rotor gets duty·`motorMaxTorqueNm`
through interface v1, and a trajectory of 4000 state records hashes to the
same SHA-256 as the d1aeaca code and WASM build. With it, the rotors run
interface v2 drive mode 1 with the clamped duty as `esc_duty` and the voltage
solved for this tick, and the bus delivers their summed terminal power plus the house
load. `electrical` (a `Float64Array` of state of charge, bus voltage and bus
current), `busLimited` and `driveLimited` report the last step; the
`stateOfCharge` and `batteryCurrentA` getters read `electrical` for cold code,
because V8 keeps class fields tagged and a double stored in one, or returned
by a getter that is not inlined, can allocate. `state.batteryVoltage` is the
bus voltage, which `PhysicsSessionV2` publishes with the bus current
(`batteryCurrentA` of `FlightStateV2`, read from `SessionDynamics.electrical`)
and the HAL delivers as sensor values 20 and 21. The HAL
contract keeps value 21 nonnegative, so the autopilot's current reading is a
unipolar power-module sensor: `WasmSitlCoupling` and the native JSON line send
max(0, I), and a regenerating bus reads 0 A while `FlightStateV2` keeps the
signed current. Output flag 32 is a modeled clamp and does not enter
`validityFlags`.

Motor faults (`useMotorFaults`) take the physical path. A power cut with
remaining fraction r scales the ESC target duty by r; r = 0 also sets the
power-cut drive flag, so the bridge carries no current and the rotor coasts.
Without the ESC drive, r scales the drive torque. A synthetic instant thrust
loss still scales the rotor's whole wrench.

`escDriveFromManifest(manifest, initialStateOfCharge, housePowerW = 0)`
(`@mirage/physics/drive`) maps a validated vehicle manifest onto the drive:
k_t = k_e = 60/(2π·KV), τ₀ = k_t·`noLoadCurrentA`, T_esc = 1/`updateRateHz`,
I_brake = `brakeCurrentLimitA`, τ_cmd = `commandTauS`. It throws, naming the
field, when a motor lacks `noLoadCurrentA`, an ESC lacks `updateRateHz` or
`brakeCurrentLimitA`, or the vehicle lacks a battery; nothing is defaulted.

`thrustExpoOfDrive` fits ArduPilot's thrust curve (`Thrust_Linearization`)
to the drive. The autopilot maps actuator a ∈ [0, 1] to the output
`MOT_SPIN_MIN + (MOT_SPIN_MAX − MOT_SPIN_MIN)·a` and models the thrust
fraction as (1 − e)·a + e·a². With the ESC duty linear in PWM over
`MOT_PWM_MIN..MAX` and the pinned defaults 0.15 and 0.95, a static sweep at
`MOT_BAT_VOLT_MAX`, where voltage scaling is 1, gives the thrust T(a) of one
rotor in still air once its speed has settled; then

\[
e = \frac{\sum_k \left(y_k - a_k\right)\left(a_k^2 - a_k\right)}{\sum_k \left(a_k^2 - a_k\right)^2},
\qquad
y_k = \frac{T(a_k)}{T(1)}
\]

and a fit outside [−1, 1] throws. For the parity rotor on the synthetic
300 KV, 0.1 Ω drive at 16.8 V, nine samples give e = 0.853 (RMS residual
0.006); the same rotor driven by duty·0.2 N·m gives e = −0.252 (RMS residual
0.047). No thrust-stand data are in the repository; under SA-01 these
values are reported for the user to judge, not accepted against a tolerance.


### Verification (TASK-092)

`native/bet/tests/drive.rs` checks the ESC hold and lag, the torque law, the
terminal-power identity, the driven shaft against the exact solution and its
v1 bit equality, regeneration and the bus record against closed forms.
`native/bet/tests/bound_v2.rs` checks the energy and torque balance over 4000
steps, the power cut, the current-limit flag, invalid drive records and zero
allocations over 1,000,000 ESC and bus steps. `tests/wasm-abi-v2.test.ts`
compares the WASM adapters with the native reference and the golden records.
`tests/drive-chain.test.ts` checks, every tick of a climb and a braking
descent, the charge integral bit for bit, the pack voltage and the bus power
balance within 1e-9; the cut and partial-cut faults; the manifest mapping;
the thrust fit; and the torque-path digest. `scripts/check-bet-runtime.mjs
--allocation` adds the ESC-drive graph and the native drive allocator tests.
The roadmap entry records the native ArduCopter flight on the drive.

## Motor and ESC v2 (TASK-105)

The first increment, in the native kernel (`native/bet/src/motor.rs`, `native/bet/src/esc.rs`),
not yet in the flight path:

```text
L·di/dt = v − R(T_w)·i − k(T_m)·Ω          i(t) = i∞ + (i₀ − i∞)·e^(−t/τ),  τ = L/R,  i∞ = (v − k·Ω)/R
R(T) = R₂₀·(1 + 0.00393·(T − 20 °C))       k(T) = k₂₀·(1 + β·(T − 20 °C)),  β = −0.0012 /K (NdFeB)
C_w·dT_w/dt = P_cu − (T_w − T_h)/R_wh
C_h·dT_h/dt = P_fe + (T_w − T_h)/R_wh − (T_h − T_air)·(1 + c·V)/R_ha
```

`InductiveMotor` integrates the current exactly with v and Ω held over a step, i∞ bounded by the
ESC's current and brake limits, and gives the mean current, torque k·⟨i⟩ less the no-load torque
k·I₀, the copper loss R·⟨i²⟩ and the iron loss k·I₀·Ω. `MotorThermal` integrates the two-node
network exactly through the closed-form exponential of its 2×2 matrix. `EscShaper` takes the
autopilot's command through the ESC: DShot's 2000 throttle steps (values 48 to 2047) or PWM at the
timer step, frames at the ESC's rate arriving a fixed number of frames late, a ramp limit, and a
start duty below which a stopped motor stays stopped. Desynchronization is not modelled.

Motor speed reaches ArduPilot's ESC telemetry (for `INS_HNTCH_MODE 3`) only through the browser
build, by the stakeholder's decision of 2026-11-07: the native SITL's JSON link has no field for it.
HAL mailbox version 2 (`native/ardupilot/hal/browser_hal.h`) carries 16 f64 rev/min at byte 896 by
firmware output channel, their channel mask in header word 13, and `sitl-state.patch` copies them to
`fdm.rpm` and `fdm.motor_mask`, which `AP_ESC_Telem_SITL` reads. `WasmSitlCoupling` fills them from
the dynamics' power telemetry, the magnitude for a reversed rotor; a motor on output channel 16 or
higher has no slot.

Checks, limits set before the first run: `cargo test -p mirage-bet --test motor --test esc`, 11
passed: the current against the analytic RL step within 1e-12 and its mean against Simpson's rule
within 1e-9; the power identity v·⟨i⟩ = R·⟨i²⟩ + k·Ω·⟨i⟩ + L·(i₁² − i₀²)/(2·dt) within 1e-9; the
steady state, the temperature laws and the current and brake limits; the thermal network against
an independent RK4 integration within 1e-6 K, one 600 s step equal to 600 steps of 1 s, and its
steady state; DShot's values, PWM's timer step, the latency in frames, the ramp's 200 steps and the
start duty. `tests/wasm-hal.test.ts`, 9 passed, with the speeds in their channels' slots, a bad
speed refused whole and version 1 firmware refused. Native HAL exchange of version 2 frames for
1,000,000 steps at 400, 800 and 1200 Hz without a fault, compiled on the Mac without its allocation
counter (the probe's `--wrap=malloc` needs GNU ld). Not yet: the models in the bound-rotor drive and
the flight, a rebuilt WASM firmware and the notch-tracking check with it, and thrust-stand
temperature runs (BLOCKED_EXTERNAL).

### The ESC and the motor's heat in the flight (second increment, design of 2026-11-08)

Recorded before the implementation. Two of the first increment's models enter the ESC drive of
TASK-092 as two native batch steps around the rotor step, each over one record per motor; the
inductive current does not, for a reason given below.

**ESC shaping.** Each tick, before the bus is solved, `bet_esc_shaper_step(records, count, dt)` takes
every rotor's target duty (the duty after the motor fault's fraction) through `EscShaper`: the target
is first quantized to round(target·N)/N for an ESC with N throttle steps (none for N = 0), then enters
the frame ring at the ESC's frame period, reaches the ESC `latency_frames` frames later, is followed at
most `ramp_per_s`·dt per step (no limit for 0), and starts a stopped motor only from `start_duty`. Its
output is the drive record's `esc_duty`. The frame period is the ESC's update period, so with a shaper
the drive record's own sampling period T_esc is 0 and only its command lag τ_cmd stays; a power cut
still unpowers the bridge at once through the drive flag.

**Motor heat.** Each tick, after the rotors step, `bet_motor_thermal_step(records, count, dt)` advances
every motor's two-node network (`MotorThermal`) with the step's copper loss (output `copper_loss`), the
iron loss k(T_h)·I₀·|Ω| at the step's shaft speed, the air temperature and the airspeed past the motor,
and writes R(T_w), k(T_h) and the no-load torque k(T_h)·I₀ into that rotor's drive record for the next
tick. The magnets sit in the housing node. The air temperature is the atmosphere's, a²/(1.4·287.05) K
from its speed of sound a; the airspeed past the motor is the magnitude of the air's velocity at the
hub plus the hover induced velocity √(|T|/(2ρπR²)) of the rotor's thrust T this step, an engineering
choice under F-03 since the motor sits in its own rotor's wash. The temperatures start at the air
temperature and return to it on reset. The heat changes over seconds, while a tick is about a
millisecond, so the one-tick lag of R and k behind the temperatures is not a numerical concern.

**The inductive current stays in the kernel.** The winding's time constant L/R is about 0.1 ms on
small motors (for example 10 µH and 0.1 Ω), against 0.83 to 2.5 ms per tick at 1200 to 400 Hz. Over one
tick the current settles to within e^(−dt·R/L) ≈ e^(−8) or less of its quasi-static value, which is the
current the TASK-092 drive already takes, with the back-EMF implicit in the shaft step. `InductiveMotor`
holds Ω over a step; in the flight it would trade that implicit coupling for a lagged one to resolve a
transient shorter than the step. Its mean current over a tick differs from the quasi-static one by
(i₀ − i∞)·τ/dt, 8 to 12 % of the change of the quasi-static current within that one tick at 800 to
1200 Hz, and by nothing once the current has settled. Desynchronization stays not modelled.

**Where the values come from.** Component card schema 2 adds to the ESC card `latencyFrames` (0 to 8),
`rampPerS` (above 0), `startDuty` ([0, 1)) and `throttleSteps` (1 to 65535), and to the motor card
`windingHeatCapacityJPerK`, `housingHeatCapacityJPerK`, `windingToHousingKPerW`, `housingToAirKPerW`
(above 0) and `airflowCoolingPerMps` (0 or above), each known with its source or null; a card with none
of them keeps schema 1 and its bytes and SHA-256. The ESC is shaped when any of its four is known, the
unknown ones neutral (no latency, no ramp limit, no start duty, no quantization) and listed as
assumptions; the motor heats only when all five are known, and is listed as not heating otherwise.
The vehicle manifest v2 takes them as an optional `shaping` on an ESC and an optional `thermal` on a
motor; without them a manifest keeps its bytes, and a profile without them derives the bytes it did.

### ESC shaper record v1

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | version | version |
| 4 | u32 | frames | latency_frames |
| 8 | f64 | s | frame_period |
| 16 | f64 | 1/s | ramp_per_s |
| 24 | f64 | 1 | start_duty |
| 32 | u32 | steps | throttle_steps |
| 36 | u32 | 0 or 1 | running |
| 40 | f64 | 1 | command |
| 48 | f64 | 1 | duty |
| 56 | f64 | s | countdown |
| 64 | f64[8] | 1 | frames |
| 128 | f64 | 1 | target |
| 136..191 | u32[14] | — | reserved_zero |

`running`, `command`, `duty`, `countdown` and `frames` are the shaper's state, zero at reset; `target`
is the tick's input and `duty` its output. Valid: a frame period above 0 and at most 0.1 s, at most 8
latency frames, a ramp of 0 or above, a start duty in [0, 1), at most 65535 steps, a target, command,
duty and frames in [0, 1], a countdown in [0, frame period] and `running` 0 or 1.

### Motor thermal record v1

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | version | version |
| 4 | u32 | — | reserved_zero |
| 8 | f64 | J/K | winding_capacity |
| 16 | f64 | J/K | housing_capacity |
| 24 | f64 | K/W | winding_to_housing |
| 32 | f64 | K/W | housing_to_air |
| 40 | f64 | s/m | airflow_per_mps |
| 48 | f64 | Ω | resistance_20c |
| 56 | f64 | N·m/A | torque_constant_20c |
| 64 | f64 | A | no_load_current |
| 72 | f64 | °C | winding_temperature |
| 80 | f64 | °C | housing_temperature |
| 88 | f64 | W | copper_loss |
| 96 | f64 | rad/s | shaft_speed |
| 104 | f64 | °C | air_temperature |
| 112 | f64 | m/s | airspeed |
| 120 | f64 | Ω | resistance |
| 128 | f64 | N·m/A | torque_constant |
| 136 | f64 | N·m | no_load_torque |
| 144 | f64 | W | iron_loss |
| 152..191 | u32[10] | — | reserved_zero |

The temperatures are the state, the losses, speed, air temperature and airspeed the tick's input, and
bytes 120 to 151 its output: R and k at the new temperatures, the no-load torque k·I₀, and the iron
loss the step applied. Valid: the capacities, resistances, R₂₀ and k₂₀ above 0, the airflow
coefficient, I₀, the copper loss, the shaft speed and the airspeed 0 or above, and temperatures from
−60 to 250 °C before and after the step.

Both batch steps take 1 to 32 records laid end to end, check every record before writing any, and
change nothing on a negative status: −2 record region, −3 invalid record or result, −7 version.
`bet_esc_shaper_version` and `bet_motor_thermal_version` return 1.

**Checks, declared before the implementation.** Native: the shaper record equals `EscShaper::step` on
the quantized target bit for bit over 10,000 random steps; a target of 0.5004 with 2000 steps gives
0.5005, the nearest of steps 0.0005 apart (first written as 0.5, an arithmetic slip found by the test's first run); a step at a frame boundary reaches the duty after exactly `latency_frames` frames; the thermal
record equals `MotorThermal::step` with the iron loss k(T_h)·I₀·|Ω| bit for bit, with R and k by
`winding_resistance_ohm` and `torque_constant_at`; one invalid record of a batch, a wrong version or a
short region leaves every record unchanged; 1,000,000 steps of each allocate nothing. Flight
(`BetFlightDynamics` on a body too heavy to move, with the ESC drive): without shaping or heat the
trajectory digest is unchanged; with 2000 throttle steps every `esc_duty` is a multiple of 1/2000;
with 3 latency frames at 400 Hz a command step first moves `esc_duty` 3 frames, 7.5 ms, plus at most one
frame later; with a start duty of 0.1 a command of 0.05 leaves the rotor at rest; with heat at a held
duty the winding temperature rises monotonically, every tick's drive record holds R₂₀·(1 + α·(T_w −
20)), and after 60 time constants of the network the temperatures are within 0.01 K of the network's
steady state at the final losses. `scripts/check-bet-runtime.mjs --allocation` adds the graph
`shaped-heated-esc-four-rotor`: 1,000,000 steps with no collection.

**Result (2026-11-08), as designed.** Native: `cargo test -p mirage-bet --release --test esc_abi --test thermal_abi`,
7 passed: the shaper record equals `EscShaper` bit for bit over 10,000 random steps in three configurations,
and the thermal record equals `MotorThermal` with its iron loss bit for bit over 20,000 steps of a varying
load; bad records, versions and regions change nothing; 1,000,000 steps of each allocate nothing. WASM:
`tests/wasm-motor-v2.test.ts`, 3 passed: the TypeScript offsets and the C header's constants equal the two
tables above, the scalar and SIMD builds agree bit for bit over 6,000 steps, the shaper equals an
independent transcription exactly and the network an independent eigen-decomposition within 1e-12. Flight:
`tests/motor-v2-flight.test.ts`, 7 passed: an ESC with neutral shaping flies bit for bit as one without over
2,400 steps of a varying command; every `esc_duty` is a multiple of 1/2000; a command step entered on tick
200 acts on tick 203; a 0.05 command below a 0.1 start duty leaves every rotor at rest, and 0.15 then runs
them within 1 % of an unshaped ESC; the heated network is within 0.01 K of its steady state after 36 s, and
every tick's drive record holds R₂₀·(1 + 0.00393·(T_w − 20)) and k₂₀·(1 − 0.0012·(T_h − 20)) within 1e-15;
cards that know two command-path values and all five thermal values shape and heat every rotor through
`resolveComponents`, the manifest and `buildProfileDynamics`, an incomplete network does not heat and says
so, and cards without schema-2 values derive neither section. Cards: `tests/component-cards.test.ts` and
`tests/card-editor.test.ts`, 25 passed, and `tests/browser/card-editor.spec.ts`, 3 passed, where an ESC card
given a latency and throttle steps in the Components tab is stored as schema 2. G1: the declared graph `shaped-heated-esc-four-rotor` did not pass, and it is not in the check. In the check's process, after its twenty other vehicles, the first vehicle with ESC shaping and motor heat allocated 0.28 B a step net with 15 collections over 1,000,000 steps (about 16 B a step by a sampling heap profile), also with a 500,000-step warm-up and with a harness that stores no double; an identical vehicle measured right after it in the same process, the shaping alone, the heat alone, and the first such vehicle in a fresh process allocated nothing (0 collections, 0.002 B a step). V8's traces show no deoptimization of the step after the warm-up and no megamorphic access in it, so the site that boxes in that first optimized code is not found. The native records allocate nothing over 1,000,000 steps each, which `scripts/check-bet-runtime.mjs --allocation` now runs. G1 of the flight path with them stays open. A second look (2026-11-08, baseline 1bff607) did not reproduce it: a copy of the check's allocation part, outside the repository, ran its 21 samples and then four-rotor vehicles on the ESC drive with shaping and heat on every motor on the synthetic pad, two identical ones per process at 0.3 duty after 100,000 warm-up steps, in two processes: shaping (2, 40/s, 0.05, 2000) with the network of `tests/wasm-motor-v2.test.ts`, without and with a weather, and the shaping and network of `tests/motor-v2-flight.test.ts`; all six allocated 2,048 B over 1,000,000 steps (0.002 B a step, the measurement's own) with no collection. The first run's graph is not in the repository, so whether its configuration differed is not known; G1 stays open until the declared graph is in the check and passes there. The
motor temperatures are in `motorV2.thermalOutput` for cold readers and not yet in the telemetry or the
recording; a step that would take a winding beyond 250 °C faults the session (`Motor thermal step failed`).

Corrections made after the first runs, each recorded here: (1) 0.5004 at 2000 steps is 0.5005, not 0.5, an
arithmetic slip; (2) the declared monotonic warm-up ignored the pack's discharge: at a held duty the bus
voltage falls (16.43 to 16.33 V over 36 s), the copper loss with it, and the winding, at its steady state of
22.35 °C after about 6 s, follows it down by about 1.3 mK every 3 s, so the check became that it never cools
while more than 0.01 K below the steady state of its losses; (3) the neutral-shaping comparison compares the
rotor speeds, since `esc_duty` holds the raw target without a shaper and the sampled one with it; (4) a 0.15
command was first expected to give more than 100 rad/s within 1 s, a number with no basis, and is now
compared with an unshaped ESC; (5) a heated motor was expected to turn slower, but the parity motor turns
0.2 % faster: the magnets' lower k raises the speed a duty gives more than the winding's higher R lowers it,
so the check is only that the heat reaches the rotor.

Not yet: G1 of the flight path, as above; desynchronization; and thrust-stand temperature runs
(BLOCKED_EXTERNAL).

Desynchronization evidence (2026-11-08). The one public case found, discuss.ardupilot.org topic 136849
(X500 V2 class quads on AM32 ESCs, crashing in AutoTune), has no logs left: its three Proton Drive shares
answer that the files were deleted or made unavailable. What remains is the developer's screenshot in post
8, called "classic desync" there: within about 2 s of AutoTune starting, two motors are commanded to full
output (1950 µs) and two to about 1100 µs while the vehicle rolls, then ArduPilot's vibration failsafe and
crash check; the ESCs' `RawRPM` jumps to impossible values (571,428 rpm), the same artefact as the
isolated 540,800 rpm readings in the stakeholder's Pavo logs. The thread's resolution was electrical: the
slim ESCs needed far larger capacitors. A picture of one crash fixes no rate or condition, so a
desynchronization model still has no data to be compared with.

### Motor heat against wind-tunnel runs (TASK-105, declared 2026-11-08)

Recorded before the network was run on any of these data, after a first look at their summary rows
(power balance, temperatures at spool-up and at the end). The stakeholder has no thrust stand and chose
on 2026-11-08, in place of the thrust-stand temperature runs, the public data of Saemi, Whitson and
Benedict (Texas A&M University; Aerospace 11:401, 2024, doi:10.3390/aerospace11050401): the thermal data
(figshare, doi:10.6084/m9.figshare.25658493, 2024-04-20) and the sizing data (doi:10.6084/m9.figshare.26107465,
2024-06-26), CC BY 4.0, credited to the authors. The files are kept outside the repository (on the
reference Mac under `~/Projects/MirageSITL-data/public-datasets/texas-am-motor-thermal/`);
`data/motor-thermal/inventory.json` holds the SHA-256 and size of both archives and of each of their 73
files, and the comparison refuses a file that differs. The paper itself was not read; what follows uses
only the archives and their README.

**What the data hold.** By the README, each `wtRaw_` file is a transient sampled at 1 Hz in a wind
tunnel from the motor's start until its temperature changed by less than 1 K/min (time, speed, throttle,
DC and AC power, voltage and rms current, two load-cell voltages, the stator temperature `Tstat`, the ESC
temperature, a pitot voltage), and its name gives the target tunnel speed, target speed, supply voltage,
propeller (diameter in inches and blades), date, ambient temperature, pressure and humidity. Each
`wtSummary_` file gives two rows of the same run, at spool-up and at thermal steady state: speed, thrust
in grams, torque, AC voltage, current and power, DC voltage and power, the motor temperature `Tmot`, the
air temperature `Tamb` and the measured tunnel speed u; the first column is the transient's row (0-based)
or −1 for its last row. Motor numbers in the files are one higher than in the paper. Motors 2, 3 and 5
have ten transients each (15.5-inch three-blade, 21.5-inch three-blade and 15.5-inch two-blade
propellers); motor 4 has summaries only, and its names do not give the propeller, so it has neither a
transient nor an airspeed past the motor and is not compared.

**Where the parameters come from.** The sizing data are not used: the thermal files name the motors by
number only, and neither the catalogue (31 motors) nor the teardown table (7 motors) says which rows were
tested; the measured torque per rms current, about 0.024, 0.033 and 0.029 N·m/A for motors 2, 3 and 5 at
their higher currents, fits several catalogue rows each, so neither R₂₀ nor a mass for the heat
capacities can be read from them. The electrical values come from the measured power balance of the fit
runs' summary rows, not from temperatures: the motor's loss is the AC input less the shaft power,
P_loss = P_ac − τ·Ω, and over the two rows of each fit run (ten rows per motor) the least-squares fit
without intercept

```text
P_loss = R₂₀·(1 + 0.00393·(T_mot − 20 °C))·I_ac² + (k·I₀)₂₀·(1 − 0.0012·(T_mot − 20 °C))·Ω
```

gives R₂₀ and (k·I₀)₂₀, with T_mot standing in for both nodes. R₂₀ is then the resistance for which
R·I_ac² is the copper loss at the measured rms current; it absorbs the phase count and the winding's
connection, as the measured torque per I_ac follows the catalogue's convention k = 60/(2π·KV), so I_ac
plays the DC-equivalent current of the drive. k₂₀ is the median of τ/I_ac over the fit rows with I_ac of
at least 5 A, and I₀ = (k·I₀)₂₀/k₂₀; only their product enters the iron loss. A coefficient that is not
positive stops that motor's comparison. The five thermal values, C_w, C_h, R_wh, R_ha and c, are fitted
to the fit runs' transients: Nelder–Mead on their natural logarithms from (30 J/K, 100 J/K, 0.5 K/W,
1 K/W, 0.1 s/m) with initial steps of ln 2, restarted from its best point until a restart improves the
objective by less than 1e-9 of it, at most 20 restarts of at most 2000 evaluations each. The objective is
the mean over the fit runs of each run's mean squared difference between the model's housing
temperature and `Tstat` at every sample after the first.

**The model.** The network is the repository's own: `BetMotorV2` (`packages/wasm-bet/src/motor-v2.ts`)
over `bet_motor_thermal_step` of the scalar WASM build, one heated motor at 400 Hz, the same record the
flight steps. Over each sample interval [t_k, t_k+1) the inputs of sample k are held, for
round(400·t_k+1) − round(400·t_k) steps: the copper loss R·I_ac,k², R the record's own R(T_w) after the
previous step (the flight path's one-step lag); the shaft speed 2π·N_k/60, from which the record forms
its iron loss k(T_h)·I₀·|Ω|; the air temperature, the mean of the summary's two T_amb; and the airspeed
past the motor by the flight path's rule, the tunnel speed plus the rotor's hover induced velocity, with
the run's thrust scaled by the squared speed through spool-up and spool-down:

```text
V_k = u + √(|T_k| / (2·ρ·π·R_p²))      T_k = T_run·(N_k / N_run)²      ρ = p / (287.05 J/(kg·K) · (T_a + 273.15 K))
```

u, T_run and N_run the means of the summary's two tunnel speeds, thrusts and speeds, R_p half the
propeller diameter of the file name, p and T_a the file name's pressure and ambient temperature. Both
nodes start at the first sample's `Tstat`: the motor stands still for about five seconds before it
starts, and several runs begin warm from the run before. `Tstat` is the stator temperature and is
compared with the housing node, which this specification defines as the stator and housing; the winding
node has no measurement and is reported only.

**Fit and hold-out.** Within each motor the runs are sorted by the steady-state row's P_ac, largest
first; the 1st, 3rd, 5th, 7th and 9th are fitted and the others held out (runs named by tunnel speed in
dm/s and target speed in rev/min, as in the file names):

| Motor | Fitted | Held out |
| --- | --- | --- |
| M02 | u070 RPM4829, u080 RPM4388, u110 RPM4071, u090 RPM3269, u100 RPM2718 | u070 RPM4683, u100 RPM3972, u080 RPM3526, u120 RPM3218, u120 RPM3003 |
| M03 | u070 RPM3030, u060 RPM3170, u100 RPM2580, u080 RPM2160, u060 RPM1940 | u080 RPM2910, u050 RPM2630, u090 RPM2300, u070 RPM2060, u090 RPM1710 |
| M05 | u090 RPM6044, u130 RPM6284, u130 RPM4956, u080 RPM4045, u090 RPM3618 | u100 RPM5877, u120 RPM5391, u110 RPM4644, u140 RPM4506, u100 RPM3508 |

**Reported.** Per motor the fitted values and the fit's RMS; per run, fitted and held out, the RMS and
the largest absolute difference between the housing node and `Tstat` over the samples after the first,
the measured and model temperatures and rises above the air at the last sample, and the model's winding
temperature there; per summary row, fitted and held out, the measured loss P_ac − τ·Ω and the fitted loss
law's. Declared tolerance: a held-out run is reproduced when both its RMS and its last-sample difference
are within max(2.5 K, 10 % of its measured last-sample rise above the air). 2.5 K is the standard
tolerance of a class 2 type K thermocouple (IEC 60584-1), as the data do not name the sensor; 10 %
covers the power balance, where 1 % of a 200 W input is 4 % of a 50 W loss, and the fit. Under SA-01 this
labels the declared comparison for the user to judge; it is not a fidelity verdict.
`tests/motor-thermal-runs.test.ts` runs it with `MIRAGE_MOTOR_THERMAL_DIR` set to the directory the
archives unpack into (it skips without it), checks every file against the inventory and the split
against the table above, and with `MIRAGE_MOTOR_THERMAL_OUT` set writes the report
(`test-results/validation/motor-thermal-runs.json`), status `REPRODUCED` when every held-out run is
reproduced and `NOT_REPRODUCED` otherwise. Its checks without the data, declared with the method: the loss
law's fit returns R₂₀ and (k·I₀)₂₀ within 1e-9 relative from rows made with them; the driven network at
held inputs ends within 1e-6 K of its steady state, found independently by fixed-point iteration of
R(T_w); the fit returns the transient of a synthetic run made by the same network within 0.01 K RMS; and
the file and name readers take a synthetic file in the archive's format.

**Result (2026-11-08), as declared, no correction after the first run.** Without the data
`tests/motor-thermal-runs.test.ts`, 4 passed and 1 skipped (41 s); with
`MIRAGE_MOTOR_THERMAL_DIR` set to the reference Mac's `extracted/` directory, the comparison passed its
checks (every file equal to the inventory, the split equal to the table) in 1,435 s and wrote
`test-results/validation/motor-thermal-runs.json` (inventory SHA-256 `fa53fb64…`, scalar WASM
`e97fec79…`): status `REPRODUCED`, 15 of 15 held-out runs. The fitted values, and the housing's
conductance to the air (1 + 12·c)/R_ha at 12 m/s past the motor:

| Motor | R₂₀, Ω | (k·I₀)₂₀, N·m | k₂₀, N·m/A | I₀, A | C_w, J/K | C_h, J/K | R_wh, K/W | R_ha, K/W | c, s/m | Conductance at 12 m/s, W/K | Fit RMS, K | Evaluations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M02 | 0.185 | 0.0219 | 0.0221 | 0.99 | 9.5e-7 | 127.5 | 7.4e-8 | 9.33 | 1.127 | 1.56 | 0.56 | 4010 |
| M03 | 0.169 | 0.0399 | 0.0308 | 1.30 | 1.1e-9 | 301.5 | 0.421 | 150.2 | 33.8 | 2.70 | 0.47 | 1895 |
| M05 | 0.248 | 0.0127 | 0.0284 | 0.45 | 8.0e-6 | 95.9 | 0.0195 | 5.28 | 0.363 | 1.01 | 0.82 | 7218 |

The held-out runs (mean airspeed past the motor by the declared rule; RMS and largest difference over
the transient; `Tstat` and the housing node at the last sample):

| Motor | Run | Airspeed, m/s | RMS, K | Largest, K | Measured, °C | Model, °C | Difference, K | Tolerance, K |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M02 | u070 RPM4683 | 11.7 | 0.68 | 1.36 | 57.9 | 57.7 | −0.14 | 3.40 |
| M02 | u100 RPM3972 | 13.1 | 0.52 | 1.51 | 35.5 | 35.8 | +0.30 | 2.50 |
| M02 | u080 RPM3526 | 10.9 | 0.44 | 0.83 | 36.1 | 36.0 | −0.13 | 2.50 |
| M02 | u120 RPM3218 | 15.2 | 0.73 | 1.23 | 28.5 | 27.8 | −0.72 | 2.50 |
| M02 | u120 RPM3003 | 15.5 | 0.66 | 1.00 | 27.8 | 27.0 | −0.76 | 2.50 |
| M03 | u080 RPM2910 | 12.5 | 0.76 | 1.98 | 48.5 | 49.7 | +1.22 | 2.50 |
| M03 | u050 RPM2630 | 8.9 | 0.96 | 2.40 | 56.3 | 57.5 | +1.22 | 3.27 |
| M03 | u090 RPM2300 | 10.8 | 0.39 | 1.35 | 31.2 | 31.2 | −0.05 | 2.50 |
| M03 | u070 RPM2060 | 9.3 | 0.48 | 1.01 | 30.9 | 31.9 | +1.01 | 2.50 |
| M03 | u090 RPM1710 | 10.8 | 0.19 | 0.68 | 26.7 | 26.5 | −0.19 | 2.50 |
| M05 | u100 RPM5877 | 16.3 | 1.10 | 3.93 | 63.4 | 65.2 | +1.87 | 4.02 |
| M05 | u120 RPM5391 | 16.9 | 0.58 | 2.66 | 43.6 | 44.3 | +0.72 | 2.50 |
| M05 | u110 RPM4644 | 14.9 | 0.61 | 2.47 | 37.6 | 37.6 | +0.02 | 2.50 |
| M05 | u140 RPM4506 | 14.8 | 0.69 | 2.01 | 30.6 | 31.3 | +0.71 | 2.50 |
| M05 | u100 RPM3508 | 11.9 | 0.20 | 0.87 | 31.0 | 31.2 | +0.24 | 2.50 |

What the numbers do and do not show. (1) Only the stator node is tested. In all three fits the winding's
capacity went to its lower end (C_w 1e-9 to 1e-5 J/K) and for M02 R_wh too (7e-8 K/W), so the network
the data determine is one node, the housing, with its capacity and its airflow-dependent conductance: one
measured temperature cannot separate a winding node. M02's two Nelder–Mead passes each ran to the cap of
about 2000 evaluations along that flat direction, M05 took five passes, and each fit's last restart
improved the objective by less than 1e-9 of it. The model's winding temperatures are therefore not evidence: for M03 its massless winding sits
R_wh·P_cu above the housing, 101 °C at the end of u070 RPM3030 where `Tstat` read 61.7 °C, and through
R(T_w) it raises that run's copper loss by about 13 % over R at the measured stator temperature. The fitted five values are a parameterization of
these motors in this rig, not card values with a physical meaning. (2) The residual has one shape: in
every high-power run `Tstat` rises faster than the housing node in the first 30 to 60 s after the start
(the model lags by up to 5.6 K, M05 u090 RPM6044, fitted) and then the model ends slightly warm. A sensor
that sees the winding's faster rise would do this; the declared mapping compares `Tstat` with the housing
node, and comparing it with the winding node instead would be a new declaration. (3) The loss law: R₂₀ of
0.17 to 0.25 Ω is about two to nine times the catalogue's resistances of motors of similar KV (0.018 to
0.08 Ω), because R·I_ac² takes every loss that grows with the current squared (the winding's AC and PWM losses
as well as its DC resistance, and the per-phase convention of I_ac), and the no-load law k·I₀·|Ω|
over-predicts the low-current rows by up to 4 W (M02 u120 RPM3003: 7.5 W against 4.2 W measured). On the
held-out rows the law's RMS difference is 2.1 W (M02), 5.4 W (M03, with 9.7 W too much at u050 RPM2630,
the lowest tunnel speed) and 0.8 W (M05). (4) The airflow term is needed: the fitted conductance grows
with airspeed by c = 0.36 to 34 s/m, which, at c·V ≫ 1 as for M03, means a conductance almost
proportional to the airspeed past the motor; the c and R_ha of M03 are determined only as their ratio.
(5) The tolerance's floor decided most verdicts: 12 of the 15 held-out runs have a measured rise below 25
K, where 2.5 K is above 10 % of the rise. Under SA-01 the user judges these numbers.

### Notch tracking in the browser firmware (TASK-105, declared 2026-11-08)

Recorded before the first run. The stakeholder approved the Emscripten SDK download on 2026-11-08; the
pinned SDK (4.0.15, emsdk `389a68bc…`, manifest `2df8c7f8…`) and a shallow ArduPilot checkout at the
browser track's `8ab6afd` live outside the repository, and `scripts/build-ardupilot-hal.mjs` now runs on
macOS and Linux as well as through WSL, with the three directories given by `MIRAGE_ARDUPILOT_SOURCE`,
`MIRAGE_EMSDK_DIR` and `MIRAGE_ARDUPILOT_VENV`. The check, `tests/browser/wasm-notch.spec.ts`, boots that
firmware in a Worker with cold defaults `INS_HNTCH_ENABLE 1`, `INS_HNTCH_MODE 3` (ESC telemetry),
`INS_HNTCH_REF 1`, `INS_HNTCH_FREQ 40`, `INS_HNTCH_BW 20` and `LOG_DISARMED 1`, at 800 Hz, disarmed and
stationary, and publishes four motors' speeds through HAL mailbox version 2 in three phases of simulated
time: 4800 rpm on every motor up to 9 s, 7200 rpm up to 12 s, then 4000, 5000, 6000 and 7000 rpm up to
15 s. ArduPilot's SITL ESC telemetry ignores speeds before 6 s, and its average motor frequency is the
mean speed over 60, so `FTNS.NF`, the notch frequency the firmware logs before its filter clamps it, must
be 80, 120 and 91.667 Hz. The firmware's own DataFlash log is copied out of its file system
(`BrowserWasmSession.readLogs`) and read by `packages/dataflash`. Limits: every `FTNS` row logged in the
last second of a phase within 0.01 Hz of that phase's value (a single-precision frequency near 120 Hz
rounds to about 1e-5 Hz), at least five such rows per phase (it is logged at 10 Hz), and no row from a
phase's first 0.5 s required to match, since the ESC telemetry's average follows the new speeds within one
update. What it does not show: the notch's attenuation of a vibration, which needs TASK-114's vibration,
and the native SITL, whose JSON link has no speed field.

Result (2026-11-08; Apple M5, macOS 27.2, Playwright's Chromium 141; firmware 3,735,881 bytes, SHA-256
`1f8e3a6a…`): `tests/browser/wasm-notch.spec.ts` 1 passed, report `test-results/browser/task-105-notch.json`
(ignored). Each phase's last second holds 10 `FTNS` rows, 80.00001, 120.00001 and 91.66667 Hz, the worst
7.6e-6 Hz from its value, and the notch took each new value from the first row logged in the phase; before
6 s it reads 0 Hz, ArduPilot's start-up hold. The four `tests/browser/wasm-hal.spec.ts` checks pass on the
rebuilt firmware. Two findings on the way: the first build stopped at `browser_hal.cpp`, whose speed check
compared a double with `!=`, an error under ArduPilot's `-Werror=float-equal` that the native probe's flags
did not raise (now `rpm > 0`, equal for the non-negative speeds it admits); and the first run stepped the
firmware faster than real time, so its log writer fell behind and the file ended at 7.86 s of 17 s, on a
4096-byte boundary; the check now paces the firmware to real time, as the application runs it, with the
limits unchanged.

## Propulsion calibration: TASK-145

In measured mode (TASK-140), TASK-145 fits the BET rotor and the DC motor of
one exact bench combination to that combination's static bench data, records
and shows the residuals, and flags flight outside what the bench measured.
MirageSITL sets no fit tolerance (SA-01): the residuals are shown, never
judged. A calibration belongs to its combination and is never transferred.

**Scaling the BET model, not the TASK-103 table mode.** The fit scales the
section polar of the combination's propeller: every lift coefficient by s_L and
every drag coefficient by s_D, with the angle, Reynolds-number and Mach axes and
the confidence unchanged. The reasons: (1) a table of the bench's C_T and C_P
versus RPM holds only where a static bench measured, at one density and zero
advance ratio, while a flight needs loads in climb, descent, forward flight and
wind, which the BET gives from the geometry and the inflow; scaling its polar
moves the level of its static loads to the bench and keeps their dependence on
inflow, advance ratio, density and Reynolds number; (2) the two scales are what
the two measured curves, thrust and torque versus RPM, can set: a static bench
cannot identify more free parameters, and RPM-dependent factors would fit the
noise; (3) the table mode of TASK-103 did not exist when this was decided, and a table from a
stand still flags every flight in moving air. Scales are confined to 0.25 to 4: beyond them the
polar, not its level, is wrong.

**The static solve** (`staticLoads`, `packages/physics/src/propulsion-calibration.ts`)
gives the BET rotor's thrust and torque at each bench speed in still air at the
bench's air (density as measured or p/(R·T); viscosity and sound speed from the
temperature, or of the ISA sea level when only a density is given): each speed
is a bound rotor of its own on the drive-mode-0 shaft with no motor torque and a
shaft inertia of 10⁶ kg·m², so it holds its speed to 10⁻⁶ while its inflow
(lag 5 ms) settles over 400 steps at 800 Hz; thrust is the axial hub force,
torque the magnitude of the aerodynamic shaft torque. A speed that does not
settle to 10⁻⁹ or does not hold throws. The rotor solved is the one the flight
binds: `profileRotorDefinition` returns `flightRotorDefinition` of
`bet-dynamics.ts`, which the flight model's constructor also uses (dynamic
inflow, the vortex ring seed, kernel options and a rotor table included). A rotor
flown from a table (TASK-103) is refused, since polar scales cannot reach it.
Until 2026-11-08 the definition left out dynamic inflow and the rest (section
"Aligned with the flight's binding" below).

**The rotor fit** (`fitPropulsion`) minimizes, by Levenberg–Marquardt in
x = (ln s_L, ln s_D) with central differences,

```text
S(x) = Σ_i ((T_i(x) - T_i,bench) / rms(T_bench))² + Σ_i ((Q_i(x) - Q_i,bench) / rms(Q_bench))²
```

from s_L = s_D = 1, so both curves count alike whatever their units, until a
step moves x by less than 10⁻¹¹. Without torque at every point it fits s_L
alone, keeps s_D = 1 and says so. It needs 3 to 32 points of a bench propeller
whose diameter is the rotor's.

**The motor fit** (`fitMotor`), when the bench has torque, voltage and current at
every point, holds the motor card's KV (supply-side data cannot separate KV from
the winding resistance) and fits the winding resistance R and the no-load current
I₀ of the TASK-092 DC motor, with a lossless ESC, to the supply power by
Gauss–Newton:

```text
I_m = K_v Q + I_0,   V_m = ω / K_v + R I_m,   P_model = V_m I_m = V I
```

K_v in rad/s per volt. The ESC's losses therefore appear in R and I₀, which the
record says. A point whose model motor voltage exceeds its supply voltage lies
beyond full duty and is shown as such.

**The envelope** is the bench's RPM range, its density and its advance ratio,
J = 0 for a static bench. A flight step is outside it when a rotor turns more
than 10% beyond the RPM range (F-03), when J = V/(nD) of the airspeed at the CG
exceeds 0.02 (the J of a 0.5 m/s draught on a 10-inch propeller at 6000 rpm:
the drift of a hover in still air stays below it, while wind, forward flight,
climb and descent do not; an engineering default under F-03), or when the air density differs from the
bench's by more than 10% (F-03's margin applied to the single density of a
run). These only raise the flag; static data are never extended silently.

**In the flight model.** The vehicle manifest v2 takes an optional
`propulsionCalibrations` section (absent, a manifest keeps its bytes): per
calibrated rotor its rotor ID, s_L and s_D, the fitted winding resistance and
no-load current (null where the bench could not fit them), the bench's RPM range
and density, the measured dataset it names (the bench data, kind `measured`) and
the calibration record's SHA-256; at most one per rotor, and the v1 runtime
refuses it. `buildProfileDynamics` gives each calibrated rotor its own scaled
copy of its catalog polar under polar ID `CALIBRATED_POLAR_BASE` (10⁶) plus the
rotor's index, takes the fitted R and I₀ into that rotor's drive, lists the
calibration among its limitations, and hands `BetFlightDynamics` the envelope
with its margins. Every step, a calibrated rotor that turns (1 rpm or more)
outside 0.9·rpm_min to 1.1·rpm_max, in air whose density is more than 10% from
the bench's, or with V·60 > J_max·rpm·D for the airspeed V at the CG, sets
`VALIDITY_FLAG_CALIBRATION_EXTRAPOLATION` (bit 18), which the session reports as
`ModelOutsideValidity`; allocation-free, from preallocated slots. The session
keeps each change of the model's validity bits with its tick in a ring of 64
(`drainValidityChanges`, the oldest dropped and counted beyond it), the Worker
posts them after the compute batch (`validity.changes`), and the run recorder
writes them as `events.validity` (ID 72), so a recording says from which tick to
which a calibrated rotor flew outside its bench data.

**The calibration record and its binding.** A fit is stored as a
`propulsion-calibration` item of the project store
(`@mirage/aircraft/propulsion-calibration`, payload schema 2; schema 1 below): the combination
key, the measurement set's SHA-256, the motor and propeller cards, the date the
bench measured, the polar's catalog ID and the SHA-256 of the BET module it was
fitted with, and the fit itself (s_L, s_D, iterations, the RMS thrust and torque
residuals, R and I₀ at the card's KV or null, every residual row, what was not
fitted and the envelope); it depends on the measurement set and both cards.
`calibrateMotor` fits the profile's own rotor of one motor, as the profile builds
it without any bound calibration, and refuses a set of another combination.
Profile schema 6 is schema 5 with its airframe drag optional and a
`propulsionCalibrations` list of one to any number of entries, one per
combination in ascending key order: each holds the record's SHA-256, the
combination key, the measurement set, the bench date, s_L, s_D, R, I₀ and the
envelope. Only a calculation from measurements binds them, and each needs its
measurement set bound; a version whose calculation is changed (another mode, a
newer set) drops the calibrations whose set is no longer bound, and without any
the version keeps the lowest schema that holds it. `bindCalibration` replaces any
calibration of the same combination. The derivation writes the section above for
every motor whose combination key is a bound calibration's, and the bench data
as a dataset of kind `measured` (`bench-` and the first 16 hex digits of the
set's SHA-256, acquired on the bench date); a profile without calibrations
derives the bytes it did before, so the derivation version stays 6.

**In the Components tab** (`apps/web/src/library/CalibrationSection.tsx`), each
motor with a bound measurement set offers **Fit to the bench data**: the page
fits it on the served scalar BET module, shows s_L, s_D, R, I₀, the RMS
residuals, what was not fitted, a table of every bench point against the model
and the envelope, and on **Save and bind as a new profile version** stores the
record and saves the profile version that binds it, for every motor of that
combination and no other. Nothing in it says a fit is good or bad.

**Verification.** `tests/propulsion-calibration.test.ts` declares before the
implementation: bench data that the rotor itself gives with its polar scaled by
s_L = 0.9 and s_D = 1.2, and the electrical power of a known motor (KV 900, R =
0.08 Ω, I₀ = 0.6 A), are fitted back from the unscaled polar within 10⁻⁹
relative; a thrust-only bench gives s_L back within 10⁻⁹ with s_D = 1 and names
what it could not fit; the static solve at a speed equals within 10⁻⁶ the thrust
of the free shaft settled on the TASK-092 ESC drive at that speed (the same rotor
reached by a motor balancing its aerodynamic torque); a motor fit alone gives R
and I₀ back; the repository's bench CSV v2 fixture is refused on a rotor of
another diameter and fitted on one of its own, with every residual kept.
`tests/profile-dynamics.test.ts` flies a calibrated rotor of the S19 quad on its
scaled polar (every coefficient exactly s_L or s_D times the catalog's) and
fitted motor with the other rotors unchanged, refuses five bad sections, and
holds the flag to no step inside the envelope over 0.1 s of trimmed hover and to
every step above or below the RPM range, outside the density band or at 5 m/s;
`tests/terrain-pause.test.ts` holds the validity ring to the tick of each change
and to counting what it drops. In the same file, a calibration of the S19 quad
on the repository's bench fixture is fitted, stored with its three dependencies,
bound as schema 6 and derived for both motors of its combination with the bench
data as a `measured` dataset, while the unbound profile derives no section and
a set of another combination is refused.
`tests/browser/propulsion-calibration.spec.ts` does the same through the
Components tab in Chromium: seven residual rows, the record and profile
version 2 at schema 6 in the store, the calibration shown on motors 1 and 2
after a reload and none on the unmeasured motors 3 and 4, the tab fitting a
phone and passing axe. `node scripts/check-bet-runtime.mjs --allocation`
measures the envelope check in the graph `calibrated-esc-weather-pad-four-rotor`:
four calibrated rotors on the ESC drive on the synthetic pad, whose weather,
re-applied every 1000 steps, alternates between 98 and 90 kPa so that the bench
density band flags every other window; over 1,000,000 steps it allocates
nothing (0 GCs, the measurement's own 4,640 B) with the flag on in 500,000. A
real bench file (G4) is still to be fitted and its residuals shown before
measured mode is called working.

### Manufacturer data (2026-11-07)

By the stakeholder's decision of 2026-11-07 the first real bench data are T-Motor's own datasheet
table for MN7005 KV230 with the P24*7.2" CF propeller, from an image posted on the ArduPilot forum
(`data/flight-logs/inventory.json`, bench table `tmotor-datasheet-mn7005-kv230-p24x72`): manufacturer
data, not a measurement of ours, with the stand and the air unstated. Its eleven rows (40 to 60 %
throttle) are transcribed into `tests/fixtures/components/tmotor-mn7005-kv230-p24x72.csv`: thrust
from grams by 9.80665 m/s², torque and current as printed, the assumed air density 1.225 kg/m³,
the table's nominal 24 V as the supply, and each row's voltage as the table's power over its
current, so V·I reproduces the printed power (the table has no voltage column). The table's
neighbour for MN6007 II KV320 is not transcribed: its first row belongs to another propeller.
The cards (`tmotor-mn7005-kv230.json`, `tmotor-p24x72.json`, `tmotor-alpha-40a.json`,
`battery-6s-42ah-forum-144558.json`) name a source for every value: the datasheet table, T-Motor's
product pages read on 2026-11-07 (71 mΩ and 188 g with the cable, idle 0.9 A at 22 V, 28 A and
700 W over 180 s; propeller two blades and 56 ± 2 g), the owner's posts and the log's own battery
thresholds (MOT_BAT_VOLT_MAX 24.6 V, MOT_BAT_VOLT_MIN 16.8 V); unknown values are null.
`tests/fixtures/aircraft/tmotor-mn7005-quad.json` is the forum aircraft's quad X at its stated
7.2 kg with assumptions: arm length 0.5 m, inertia 0.25, 0.25 and 0.48 kg·m² (four 0.4 kg motor
and propeller masses at 0.5 m and a 5.6 kg central box of 0.3 × 0.3 × 0.15 m), CG at the centre and
0.3 m ground clearance.

`tests/tmotor-bench-fit.test.ts` (1 passed) fits the data on the rotor this profile builds from the
propeller card (derived BET geometry, NACA6409 polar) with the motor at the card's KV 230: lift
×0.474, drag ×1.249 in 7 iterations; RMS thrust residual 0.69 N and torque 0.020 N·m; motor
R 0.132 Ω and I₀ 0.889 A with an RMS electrical residual of 1.45 W; envelope 2023 to 2835 rpm at
1.225 kg/m³. The residuals run from −7.4 % of thrust at 2023 rpm to +3.8 % at 2835 rpm: the table's
thrust coefficient falls from 0.0717 to 0.0647 over that range, which a scaled polar on a fixed
geometry does not follow. The fitted R is above the 71 mΩ of the product page because the fit's
lossless ESC leaves the ESC's losses to the motor.

A calibration belongs to its motor's combination, whose supply is the profile's battery card
(TASK-140), and T-Motor's stand did not run on the owner's battery. By the stakeholder's decision
of 2026-11-07 ("Yes, allow it") a set on a laboratory supply binds to the motors with its motor,
propeller and ESC cards whatever the battery (section "Calculation modes and measurement sets v1"),
so the T-Motor set is stored on a laboratory supply; `calibrateMotor` accepts a set of the motor's
exact or laboratory combination and records the motor's own combination key. The second test of
`tests/tmotor-bench-fit.test.ts` (2 passed) calibrates, stores and binds it through the store
(schema 6, all four rotors calibrated, the bench data a `measured` dataset dated 2026-07-28), and
the second test of `tests/browser/propulsion-calibration.spec.ts` (2 passed in Chromium) does it in
the Components tab: lift ×0.47.., drag ×1.24.., eleven residual rows, the envelope 2023 to 2835 rpm,
version 2 saved and every motor calibrated after a reload. Measured mode works on real data; the
data are the manufacturer's, and the user judges how far to trust them.

### Aligned with the flight's binding (2026-11-08)

TASK-090's bench captures found that the static solve bound the rotor without the dynamic inflow
(Pitt-Peters, TASK-098) that every profile flight uses, so a calibration's scales were fitted to
another rotor than the one that flies with them. By the stakeholder's decision of 2026-11-08 ("Yes
align") the solve now takes the flight's own binding: `flightRotorDefinition` (`bet-dynamics.ts`)
builds each rotor's bound definition for the `BetFlightDynamics` constructor and for
`profileRotorDefinition` alike, so the two cannot drift apart again. The static solve's own inflow lag
of 5 ms stays: it changes how fast the inflow settles, not where.

The calibration record's payload schema becomes 2, which marks a fit on the flight's binding. A
schema 1 record, fitted before, still validates, since stored versions are immutable, but
`savePropulsionCalibration` and `bindCalibration` refuse it ("This calibration was fitted before
2026-11-08 to the rotor without the flight's dynamic inflow; fit it again to bind it"), and the
Components tab shows that note under a motor whose bound calibration is of schema 1 (test ID
`calibration-stale-N`). A profile version that bound one before keeps its scales until it is fitted
again.

Checks, declared before the run. `tests/propulsion-calibration.test.ts`: the definition the fit takes
has the flight's dynamic inflow, vortex ring seed and kernel options; the fit's residual rows equal an
independent static solve of that rotor on the fitted polar within 10⁻⁹ relative and differ by more than
10⁻⁶ from the same solve on the old binding; new records are schema 2, and a schema 1 record reads, is
refused on saving and on binding, and schema 3 is refused; a rotor flown from a table is refused.
Result: 6 passed. `tests/browser/propulsion-calibration.spec.ts` (2 passed in Chromium) also binds a
schema 1 copy of the T-Motor calibration to a new profile version and finds the note.

The T-Motor fit on the flight's binding (`tests/tmotor-bench-fit.test.ts`, 2 passed): lift ×0.504,
drag ×0.846 in 7 iterations (×0.474 and ×1.249 before); RMS thrust residual 0.688 N and torque
0.022 N·m; thrust residuals from −7.5 % at 2023 rpm to +3.7 % at 2835 rpm, as before; the motor fit
unchanged (R 0.132 Ω, I₀ 0.889 A, RMS 1.45 W), since it reads the bench, not the rotor. The drag scale
moved most: with the dynamic inflow's tip and hub losses the rotor already needs more torque for its
thrust, so less is added through the drag coefficient.

## Profile-driven dynamics (TASK-144)

An aircraft profile version and its component cards build the session's
flight dynamics: up to 16 BET rotors on the TASK-092 drive and battery bus,
registered and loaded through `model.load`. The demo stays the default. By
the stakeholder decisions of 2026-10-30, a physics value that a card lacks
takes a documented assumed value and is listed as a flagged assumption, and
each propeller's airfoil polar comes from a versioned runtime catalog.

### Polar catalog v1

`@mirage/physics/polar-catalog` lists the polars a profile may choose. Each
entry has a stable text ID, stored in profiles, and a numeric ID, the rotor
`polarId` of a derived manifest; numeric IDs are never reused.

| ID | Numeric ID | Airfoil | Source |
| --- | ---: | --- | --- |
| `naca6409-neuralfoil-v1` | 1 | NACA6409 | NeuralFoil 0.3.3 prediction, `tests/fixtures/polars/naca6409-neuralfoil.json` |
| `naca0012-neuralfoil-v1` | 2 | NACA0012 | NeuralFoil 0.3.3 prediction, `tests/fixtures/polars/naca0012-neuralfoil.json` |

The catalog files under `packages/physics/polars/` are byte-identical copies
of those fixtures, with the fixtures' provenance and limitations; the
production `parseNeuralFoilPolar` reads them once. `catalogPolarForAirfoil`
matches a card's airfoil name ignoring case, spaces, hyphens and underscores,
and nothing looser. The SDA1075 XFOIL table, a single-Reynolds input of the
annular BEM diagnostic in another format, is not in the catalog.

### Profile schema 4

Schema 4 adds `propellerPolars`: one or more `{ card, polar }` entries in
ascending card order, each for a propeller card that a motor of the profile
uses and naming a catalog ID. A profile is written in the lowest schema that
holds its content: 4 with a chosen polar, else 3 with a sensor configuration,
else 2, and a schema 1 profile whose calculation stays the implicit
preliminary one stays 1. Schema 4 holds a sensor configuration or `null` and
always a calculation. `withProfileContent` applies this rule;
`withSensorConfiguration`, `withPropellerPolars` and `bindMeasurements` use it,
so each keeps the others' content. `PROFILE_SCHEMA_VERSION` was 4 until
schema 5 (TASK-096) added stated airframe drag; records in schemas 1 to 4 stay
valid and are never rewritten. The Aircraft tab lists each
propeller card in use with a polar selector; a choice for a card that no motor
uses any more is dropped when the profile is saved.

### Profile schema 5

Schema 5 (TASK-096) adds `airframeDrag`: drag areas the user states for the
airframe without its rotors, C_D·A along body x, y and z (each above 0 m²),
the center of pressure from the reference point, the top of the airspeed
range the values hold for (above 0 m/s), and where they come from (1 to 1024
characters, not blank). A profile is written in schema 5 exactly while it
states drag; its propeller polars may then be none. `withAirframeDrag(profile,
drag)` writes it, and with null returns the profile to schema 4 or lower,
byte for byte. The derivation turns stated drag into the diagonal tensor in
the profile's own dataset, without the `standard-hull-drag` dataset; profiles
without it derive as before. The Aircraft tab's Body drag section shows the
standard hull's estimate and lets the user state the values, which start from
that estimate and cannot be saved without a source.

### Component resolution

`resolveComponents(profile, cards)` (`@mirage/aircraft/resolve-components`)
turns a profile and its card versions into the TASK-138 resolved components,
with the drive fields of manifest v2, the assumptions and the values still
missing. A profile with anything missing does not resolve and cannot fly.
Propeller geometry is the TASK-139 derivation with 16 strips; its flags
(assumed root cutout, chord or twist) become assumptions. The shaft inertia is
the propeller's m·R²/3.

| Value | Taken from | When the card has none | Assumption ID |
| --- | --- | --- | --- |
| Polar | the profile's choice | a catalog airfoil matching the card's airfoil; else missing | `polar-from-card-airfoil` |
| Propeller mass (shaft inertia) | propeller card | missing | — |
| Motor rotor inertia | — | 0, always | `motor-rotor-inertia` |
| Bearing drag | — | 0, always; the no-load current carries the losses | `bearing-drag` |
| Strips and azimuth samples | — | 16 (TASK-139) and 8 (TASK-033 validation), always | `rotor-numerics` |
| Winding resistance | motor card | missing | — |
| No-load current | motor card | 0, losses neglected | `motor-no-load-current` |
| Motor current limit | motor card | the ESC rating | `motor-current-limit` |
| PWM range | — | 1000–2000 µs, MOT_PWM_MIN/MAX defaults of the pinned ArduPilot, always | `esc-pwm-range` |
| ESC update rate | ESC card | 490 Hz, `AP_MOTORS_SPEED_DEFAULT` of the pinned ArduPilot | `esc-update-rate` |
| ESC command lag | — | one update period, always | `esc-command-lag` |
| Brake current limit | — | the ESC rating, always | `esc-brake-current` |
| Cell voltages | battery card | missing | — |
| Pack resistance | battery card | 0, no sag | `pack-resistance` |
| Pack current limit | battery card | the summed ESC ratings | `pack-current-limit` |

The battery's open-circuit voltages are cells × cell voltage. Each assumption
names its subject (a card or the battery) once, however many motors share it.
The manifest derivation passes the optional `noLoadCurrentA`, `updateRateHz`
and `brakeCurrentLimitA` through, so a resolved profile's manifest carries the
drive; existing derivation inputs give the same bytes.

### Building the dynamics

`buildProfileDynamics(manifest, options)` (`@mirage/physics/profile-dynamics`)
needs a motor and an ESC for every rotor and a battery. It projects the body
and rotors to the v1 descriptor (sensor mounts, wake pairs, the ArduPilot
frame and, through `withoutLandingGear`, the landing gear are consumed
elsewhere; drag and control surfaces still fail closed), binds each rotor's
catalog polar, takes the drive from
`escDriveFromManifest` (initial state of charge 1 and no house load unless
given) and the air from the ISA troposphere at 0 m unless given. Inflow lag
0.1 s, inflow limit 500 m/s and minimum confidence 0.9 are the TASK-033
settings. Actuator frames for the model carry its model ID as the motor map
ID; without an autopilot the pilot sticks command collective only, and the
vehicle starts with the motors stopped on its landing gear over the origin
(section "Standard landing gear"), or at the origin on the synthetic pad when
the manifest has no gear.
Since TASK-101 the rotor wakes are modeled. With its option `off` a declared rotor-wake pair
is not: the build lists the limitation and sets `CONFIGURATION_FLAG_WAKE_UNMODELED` (bit 16) in the
`configurationFlags` of `BetFlightConfiguration`, which `BetFlightDynamics` ORs
into `validityFlags` every step, so the session reports ModelOutsideValidity.
Configuration flags use bits 16 to 31 only; with none, the step is unchanged.

### Session and Worker

`profileModelPort(registry, module, options)` admits a schema 2 manifest from
the `VehicleRegistry` when the requested hash equals the registered one, the
BET module is loaded and the vehicle builds; the session changes nothing on a
rejection (`ASSET_MISSING`). The physics Worker holds a registry and accepts
two cold messages: `{ type: "bet.module", bytes, sha256 }` checks the hash,
compiles the module and requires no imports and the `bet_bound_step_v2`,
`bet_bus_step` and `bet_body_step` exports, answering `bet.module.ready` or
`bet.module.reject`; `{ type: "model.register", bytes, sha256 }` registers a
manifest, answering `model.registered` with its model ID or `model.reject`;
`{ type: "contact.module", bytes, manifest }` (TASK-095) passes the Rapier
contact module and its build manifest to `GroundContact.initialize`, answering
`contact.module.ready` or `contact.module.reject`. A vehicle with landing gear
loads only once the contact module is ready. The demo runs until a Control
Protocol v2 `model.load` names a registered ID and hash. Starting experiments from the Run tab and the SITL lockstep stay with
TASK-153 and TASK-154.

### Hover trim check

`tests/support/hover-trim.ts` is a physics-only oracle independent of the frame
summation and the body integrator. It sweeps each distinct rotor to steady
state in still air over the effective motor voltage u = d·V, on which the
TASK-092 motor law depends only through their product, then solves the six-axis
force and moment balance about the CG for every rotor's u and the hover roll
and pitch by minimum-norm Newton steps, and turns u into duties at the
battery's loaded voltage. The dynamics then fly from the trim attitude and
rotor speeds with the trim as feed-forward and a light loop around it
(attitude, rate and vertical-speed damping mapped to u by the minimum-norm
inverse of the thrust and moment rows of the trim Jacobian). Rotor inflow
starts at zero, so the first tenths of a second carry excess thrust that an
open-loop hover would never forget; if the trim is right, the loop's steady
corrections vanish.

| Configuration | Hover duty | Hover rpm | Motor power | Loop correction after 4 s | Attitude error |
| --- | --- | --- | ---: | ---: | ---: |
| quad X | 0.396–0.407 | 4344–4461 | 127.8 W | 9.3e-5 of u | 4.4e-4 rad |
| hexa X | 0.421–0.465 | 4569–5018 | 246.9 W | 6.9e-5 | 8.5e-5 rad |
| octa X | 0.472–0.481 | 5037–5130 | 390.4 W | 6.5e-5 | 1.5e-4 rad |
| coaxial X8 | 0.442 | 4757 | 320.5 W | 6.2e-5 | 0 |
| sixteen motors | 0.487–0.499 | 5050–5168 | 792.3 W | 8.0e-5 | 2.7e-4 rad |

These are the S19 fixtures with the example cards and NACA6409; the coaxial
rotors see free-stream inflow, so their pairs share one duty. The acceptance
limits, set before the first run, are a correction below 2e-3 of u, vertical
speed below 0.02 m/s, body rate below 0.005 rad/s and attitude error below
0.01 rad.

### Standard landing gear

Until TASK-194, aircraft profiles described no landing gear and Phase 1 had
no gear editor (S18). A profile without a described gear still stands on the
standard one (section "Described landing gear (TASK-194)"). Derivation 3 therefore gives every vehicle the
basic support approximation that decision D-07 fixed on 2026-10-28
([phase1-fidelity.md](decisions/phase1-fidelity.md), F-07 and F-08;
`packages/aircraft/src/standard-gear.ts`, rules version 1). The supports are
synthetic, not any aircraft's measured legs, and the manifest declares them as
their own synthetic dataset `standard-landing-gear`.

| Rule | Value | Source |
| --- | --- | --- |
| Supports | One under each arm, at the arm's motor radius and azimuth, in ascending arm ID order | F-07 |
| Height | The reference point rests at the profile's `groundClearanceM` above level ground | F-07 |
| Stiffness, N supports, mass m | k = m·g/(N·δ_s), δ_s = 5 mm | F-08 |
| Damping | c = 2·ζ·√(k·m/N), ζ = 0.7, on the strut | F-08 |
| Friction | μ_s = 0.6 rolling, lateral and braking; μ_k = 0.5 while sliding (`kineticFrictionRatio` 5/6) | F-08 |
| Support point | A linear strut on a rubber foot of radius 0.01 m on a 0.005 m rim; the foot is ten times stiffer than the support, so the strut has 10/9 of k and the pair k | Engineering choice |
| Unsprung mass | 1 % of the support's share of the vehicle, on the foot | Engineering choice |
| Strut travel | Five static deflections, 25 mm | Engineering choice |

The unsprung foot loads its foot but not its strut, so a support compresses
0.991·δ_s under its share; the anchors put the reference point exactly at the
clearance with that deflection. F-07 places the supports of a profile without
a clearance at the lowest point of its body hull. Derivation 4 (rules version
2) reads that as the clearance that leaves the standard hull's lowest point,
level, one static deflection δ_s above the ground at rest: the hull stays off
the ground on the supports, and a hard landing that doubles the load reaches
it. Derivation 5 (rules version 3, TASK-195) takes the lowest point of the
standard hull and the propeller discs together, since F-07 lets no disc carry
support and the lower rotor of a coaxial pair can hang below the hull: the
coaxial X8 without its clearance would rest at 0.0535 m, its lower discs'
0.0485 m plus δ_s, instead of 0.035 m with those discs 13.5 mm in the ground.
Of the S19 fixtures only octa-x states no clearance; on its 0.385 m arms it
rests at 0.0435 m, below its body, under both rules (0.04 m on its former
0.35 m arms). Derivation 3 gave such a profile no supports and
the synthetic pad. The
anchors use the package's own sine and cosine (`trig.ts`), so Node and
Chromium derive the same bytes. The vehicle manifest v2 gains the optional
`landingGear[].kineticFrictionRatio` in (0, 1]; existing manifests stay valid
with the same bytes.

`buildProfileDynamics` hands the gear to the contact: `ProfileDynamicsBuild.gear`
holds the wheels with anchors relative to the CG
(`deriveVehicle().landingGearAnchorCgM`), the vehicle's mass and inertia about
the CG as the projected model declares them, and the radius of the airframe's
contact sphere about the CG, half the CG's height over the ground with every
strut and foot fully compressed, so only the supports carry the vehicle; with a
hull (derivation 4) the contact has shapes instead of the sphere (section
"Standard hull and propeller discs"). The vehicle starts with its fully extended feet touching the
ground plane through the origin. `profileFlightDynamics(module, build, hz)`
creates the dynamics on a new `GroundContact.forVehicleNow` contact (a
synchronous `forVehicle` once the artifact is compiled), because the session
builds the dynamics again at each rate change and the dynamics owns and
disposes its contact; `profileModelPort` rejects a vehicle with gear before the
contact module is loaded. The Run tab's SITL load fetches the module and its
manifest from the loopback-only `/__contact/` route of the development server,
which serves `packages/physics/dist/contact/` as `/__bet/` serves the BET module.

At rest, rigid-plate statics give the struts the loads Fᵢ = a + b·xᵢ + c·yᵢ that
balance the sprung weight and its moments about the CG; the feet add their own
weight. The plane through the support compressions gives the CG's sink and the
rest pitch and roll (`tests/support/standard-gear.ts` computes them from the
manifest). All five S19 configurations come to rest within 0.1 mm of that
height at 400, 800 and 1200 Hz with body rates below 10⁻⁶ rad/s, no hull or
propeller shape touching on the way (`tests/profile-dynamics.test.ts`). On the quad X
the lockstep session's accelerometer reads −g·sin(pitch) forward within 5 %
(`tests/external-sitl-session.test.ts`). Native ArduCopter `8ab6afd` warms up,
takes off to 5 m, holds within 0.06 m and lands in LAND mode on the quad X's
supports through `SitlJsonLink` (`tests/external-sitl-flight.test.ts`, 800 Hz,
speedup 4): touchdown at 0.44 m/s, at rest 0.1 µm from the predicted height and
disarmed. No step turned the body more than 1.05 times its body rate over the
step (largest excess 1.1·10⁻¹⁰ rad in 58,432 steps, the single-precision
quaternion of the published state), so no pad resets the attitude. The step
turn is measured as 2·asin of the vector part of q_prev⁻¹ ⊗ q; 2·acos of their
dot product turns the published quaternion's rounding into 10⁻⁴ rad.
`node scripts/check-sitl-link-allocation.mjs` keeps G1 on the supports: 10⁶
lockstep steps at 400 Hz with 0.00404 B/step and no GC event, the quad on its
feet throughout, and the contact faults the session on any native allocation.

### Standard hull and propeller discs

A profile that gives no body or arm size flies the standard hull. By the
user's decision of 2026-11-01 (TASK-095 increment 4) derivation 4 works the
frame out from the arms and propellers, marked not measured; a profile that
describes its body (schema 7, TASK-196) flies that body instead (section
"Described body (TASK-196)"); the propeller clearance check that blocks a run, with a
previewed fix, is TASK-195 (section "Propeller clearance"). The standard hull
(`packages/aircraft/src/standard-hull.ts`, rules version 1, synthetic dataset
`standard-hull`) is:

| Shape | Geometry | Size |
| --- | --- | --- |
| Body (ID 0) | A cylinder about the body z axis through the reference point | Radius 0.25 times the shortest arm; half-height 0.4 times that radius |
| Arm i (ID i + 1) | A capsule from the body axis to the arm's motor mount, both at the arm's height | Radius 0.05 times the largest propeller radius on the arm |

A 10 in quadcopter on 0.225 m arms gets a body 0.11 m across and 0.045 m tall
and arms 13 mm thick; an octocopter with 44 in propellers on 1.25 m arms a body
0.63 m across and 0.25 m tall and arms 56 mm thick. A body that hangs low, or a
pod below it, needs the described body of TASK-196.

`buildProfileDynamics` adds one propeller disc per rotor: a cylinder at the hub
about its thrust axis, its radius the rotor's and half its thickness 0.025 times
that radius (`PROPELLER_DISC_HALF_THICKNESS_OF_RADIUS`, a contact model
setting). `ProfileGear.shapes` lists the hull, then the discs in rotor order,
relative to the CG, and `ProfileGear.parts` names each one (`hull` with its ID,
or `propeller` with its rotor ID). The contact takes them as configuration
version 5 shapes with the airframe friction 0.6 (F-08's static coefficient, which
Rapier's rigid contact applies to sticking and sliding alike) and no
restitution. They never carry the vehicle at rest; each step reports their
contact, which `BetFlightDynamics.contactShapeStateInto` passes on, and TASK-149
turns the reports into accident events with the F-09 thresholds (section
"Accidents"). The hull and
the discs are rigid Rapier contacts, not compliant like the supports: a strike
is reported, not modelled as damage, and continuing after it is labelled
(F-09).

Checks: in `native/contact/tests/contact.rs` a horizontal capsule and a vertical
cylinder rest with the CG at their geometric depth (0.0798–0.0799 m against
0.08 m, 0.03997 m against 0.04 m) and carry m·g within 0.01 %; a tilted disc held
1 mm too low reports 1 mm of penetration and its analytic rim point within
10⁻⁶ m; on a quad's feet only a disc that reaches below the feet reports
contact; version 5 without shapes is version 4 bit for bit; invalid shape
records are rejected; and a quad hull with eight discs tumbling across the
ground for 120,000 steps through the C ABI allocates nothing (before the parry
patch it faulted at step 2,367). `tests/contact-binding.test.ts` checks the same
rest and reports through the WASM contact at 400, 800 and 1200 Hz. In
`tests/profile-dynamics.test.ts` a quad X rolled 60 degrees and pitched 10
degrees nose down, dropped 5 mm above its lowest shape, strikes first and alone
with the propeller disc that the geometry puts lowest, at a point on that disc,
at all three rates.

### Described body (TASK-196)

Aircraft profile schema 7 (`packages/aircraft/src/profile.ts`) adds an
optional `body`: the airframe's contact shapes as the user describes them, in
place of the standard hull. A schema 7 profile holds any content of schema 6
as well (polars, stated drag, propulsion calibrations, of which it may bind
none); schema 8 (TASK-194, below) may hold a body beside a landing gear. A
profile without a body keeps its lowest schema and derives the same bytes as
before, so `DERIVATION_VERSION` stays 6. Depths are body FRD z,
metres below the reference point.

| Field | Meaning | Limits |
| --- | --- | --- |
| `diameterM`, `heightM` | The body cylinder about the body z axis | Above 0, at most 10 m |
| `bottomDepthM` | How far the body's bottom lies below the reference point; negative when it lies above | −10 to 10 m |
| `armDiameterM` | The thickness of every arm | Above 0, at most 1 m |
| `parts[]` | Parts fixed to the body, such as a camera or a cargo box: `name`, axis `xM` and `yM`, `bottomDepthM`, `diameterM`, `heightM`, each a vertical cylinder | At most 7; names 1 to 64 characters, unique, without leading or trailing spaces |

Code also checks that every arm is longer than the body radius, so each arm
reaches out of the body, and that the body, the arms and the parts make at
most 16 hull shapes. `bodyHull` gives, in the standard hull's order, the body
(ID 0) centred `heightM`/2 above its bottom, one capsule per arm (IDs 1 to N)
from the body axis to its motor mount at the arm's height with radius
`armDiameterM`/2, then each part (IDs N + 1 onward) centred `heightM`/2 above
its bottom. `profileHull` returns that hull or the standard hull. Everything
that read the standard hull reads it:

* the manifest's `hull`, whose provenance is then the profile derivation's
  dataset; the `standard-hull` dataset is left out;
* the supports' rest without a stated clearance (the lowest part one static
  deflection above the ground);
* the preliminary drag estimate, whose dataset text then says it is from the
  body the profile describes;
* the propeller clearance check, which treats each part as part of the body
  (a `propeller-body` clash names the part, a `ground` clash a `body-part`);
* the accident line, whose `describeAccident(event, hullPartNames(profile))`
  names a struck part "The body (camera pod)";
* both 3D views, which draw the body, arms and parts at their size in place of
  the schematic box and struts.

Mass properties are stated separately and do not follow from the sizes. The
Aircraft tab's "Body and arms" section starts a new description from the
standard hull's sizes.

Checks, limits set before the first run: `tests/aircraft-body.test.ts`, 9
passed. Schema 7 holds exactly while a body is described, and removing it
restores the former bytes; the five rejections; the hull against the entered
sizes within 1e-12 m; the manifest's hull, provenance and drag text, with the
supports at a stated clearance unchanged; without a clearance the pod rests
one static deflection (5 mm) above the ground within 1e-9 m. A pod hanging
0.13 m down at the quad's 0.12 m clearance is "The body (camera pod) reaches
10.0 mm below the ground at rest", and the fix raises the clearance to
0.135 m. A body 0.26 m across makes four `propeller-body` clashes of
0.032 m each, and the fix grows the arms; a cargo box beside the body clashes
by name. In the WASM flight dynamics at 400 Hz the quad dropped 0.2 m with
its motors off, a touchdown at about 2 m/s, strikes the ground with the
camera pod 3 mm above the ground at rest: one accident, hull shape 5, "The
body (camera pod) struck the ground at 0.21 s" (989.6 N, the step's normal
impulse of 2.47 N·s over 2.5 ms on a rigid shape). The same pod resting 3 mm
above the ground for 2 s, and a pod 40 mm above the ground in the same drop,
raise none. `tests/browser/aircraft-body.spec.ts`, 1 passed: through the UI
alone, describing the body starts from the standard hull's sizes; a camera
pod entered 0.13 m down is listed as the clash above and drawn in the 3D
scheme below and forward of the body; raised to 0.117 m it clears; the profile
saves as schema 7 with exactly the entered values, and switching the body off
saves it back in schema 4; axe finds no violation; the tab fits 390 px.

### Described landing gear (TASK-194)

By the user's request of 2026-11-07, the separate approval that the Phase 1
disposition of TASK-194 asked for, a profile may describe its landing gear in
place of the standard supports. Aircraft profile schema 8 is schema 7 (the
described body of TASK-196, above) with its `body` optional and a required
`landingGear` section; a profile is schema 8 exactly when it describes its
gear, with or without a body, and a body alone stays schema 7. A profile
without a gear keeps its schema and derives the bytes it did, and the
derivation version stays 6.

The section holds the gear's kind, `legs`, `skids` or `wheels`; the bottom of
each foot or wheel with the struts fully extended (`feetBodyM`, body FRD metres
from the reference point; three to eight, and for skids an even four to eight,
skid i running from support 2i to support 2i + 1) and the source of those
positions; and one set of values for every support, each known with its source
(1 to 96 characters) or not known with neither. A value that is not known is
never written into the profile: the derivation applies the standard gear's
rule for it (`packages/aircraft/src/profile-gear.ts`) and names it as assumed.
With N supports and the vehicle mass m (the payload included), each support's
share is m/N and the rules are:

| Value | Rule when not known | Source |
| --- | --- | --- |
| Strut and foot stiffness | Pair k = m·g/(N·δ_s), δ_s = 5 mm; the foot 10·k and the strut 10/9·k; a stated strut alone gives the foot 9 times it; a stated foot alone gives the strut 1/(1/k − 1/k_foot) | F-08, TASK-095 |
| Strut damping | 2·ζ·√(k_pair·m/N), ζ = 0.7 | F-08 |
| Strut travel | Five static deflections of the pair under the support's share | TASK-095 |
| Foot radius, rim radius | 0.01 m; the rim half the foot | TASK-095 |
| Unsprung mass | 1 % of the support's share | TASK-095 |
| Static and kinetic friction | 0.6 and 0.5; one stated coefficient gives the other in the ratio 5/6 | F-08 |
| Rolling coefficient | None: wheels need it, legs and skids have none | — |

Each support becomes one manifest `landingGear` entry in profile order: its
anchor the foot's centre (the bottom less the foot radius), the strut linear
with the same damping in compression and rebound, the foot's load curve
linear to rim contact, the tyre damping 2·ζ·√(k_foot·unsprung). Legs and skids
slide alike in every direction (rolling, lateral and braking coefficients the
static friction); wheels roll along their heading on their rolling
coefficient, since the contact's longitudinal friction is
μ_rolling + (μ_braking − μ_rolling)·b and no multirotor gear brakes. The
provenance of `landingGear` is the synthetic dataset
`aircraft-profile-landing-gear`, whose source SHA-256 is the profile's
canonical SHA-256 and whose text lists every stated value with its source and
every assumed value; the standard gear's dataset is then absent.

A gear is refused, with its reason, when the CG seen from above lies outside
the support polygon of the feet (with a 1 µm margin; three feet on one line
have none), which is how the DoD's "a foot outside every support polygon" is
read; when a strut travel is zero; when a rim is not inside its foot (with the
standard values where one is not known); when the kinetic friction exceeds the
static; when the unsprung mass reaches a support's share; when a foot
stiffness alone is not above the standard pair stiffness; when wheels lack
their rolling coefficient or legs and skids state one; when a value lacks its
source or a source its value; and when a ground clearance is stated beside it,
since the resting height then follows from the gear. TASK-195's ground check
rests the aircraft on the described gear, level and each support carrying an
equal share: the mean foot depth less the strut's compression under the share
minus its foot and the foot's under the whole share.

The Aircraft tab's Landing gear section (`apps/web/src/aircraft/LandingGear.tsx`)
describes it: the kind, a row per support, where the positions come from, and
a value and a source for each value beside its standard rule and the value
flown, marked when assumed. The ground clearance field is disabled while a gear
is described. The 3D scheme draws the feet at their bottom points, a strut
from the reference plane down to each, the skid runners and the wheels, and
lists the supports; the Run tab's flight view draws the same gear. The editor
form also keeps a profile's propulsion calibrations (TASK-145) through a save,
which dropped them before.

**Verification.** `tests/aircraft-profile.test.ts` holds the derivation to the
rules computed in the test from the stated values (a 1500 N/m strut gives a
13,500 N/m foot, damping 2·0.7·√(k_pair·0.375 kg), a 6 mm rim, a 3.75 g foot),
the dataset text to every stated value with its source and every assumed one,
a fully stated gear of wheels to its own coefficients and none assumed, and
fifteen gears to their refusals; the five S19 fixtures still derive their
recorded bytes. `tests/profile-dynamics.test.ts` flies a quad X with its CG
centred on legs, skids and a tricycle of wheels whose centroid is the CG: each
comes to rest within 0.1 mm of rigid-plate statics on the manifest's supports
(`tests/support/standard-gear.ts`) at 400, 800 and 1200 Hz for the legs and
400 Hz for the others, takes off on equal motor commands, lands and rests
there again within 0.1 mm, tilting less than 2 degrees and with no hull or
propeller contact. `tests/aircraft-clearance.test.ts` holds the resting height
on a gear to its closed form and puts the body on the ground on a gear too
short for it. `tests/browser/aircraft-editor.spec.ts` describes a gear through
the UI alone, sees zero travel, a rim outside its foot and a CG outside the
support polygon refused with their reasons, finds each drawn foot where the
profile puts it, and flies the saved version in the physics Worker on the
example cards: rest within 1 mm of the statics height, a climb of a metre, a
landing back at that height with no accident and less than 2 degrees of tilt
on equal pilot throttle. `tests/aircraft-profile.test.ts` and
`tests/aircraft-editor.test.ts` also hold a body beside a gear to schema 8, and
the same profile with its gear switched off to schema 7.

### Propeller clearance

By the user's decisions of 2026-11-01 (TASK-095 increment 4) a profile whose
propellers clash still saves, but no run starts from it, and a fix shows how
it changes the profile before it saves a new version; it never edits a
profile silently. `packages/aircraft/src/clearance.ts` (TASK-195) checks the
parts the flight physics uses, at the geometry the manifest derivation gives:
each propeller is its propeller disc and the body the standard hull's
cylinder, or a described body's cylinder and parts (TASK-196)
(`clearanceShapes(profile, propellerRadiusM)`).

| Clash | When | Size reported |
| --- | --- | --- |
| `propellers` | Two discs of motors on different arms overlap or touch | How far the tips overlap seen from above: R₁ + R₂ minus the hubs' horizontal distance |
| `propeller-body` | A disc overlaps or touches the body cylinder, or a described body's part, which it names (TASK-196) | R + body or part radius minus the hub's horizontal distance from its axis |
| `ground` | With a stated ground clearance, the lowest point of a hull shape or a disc, level, at or below the ground at rest | Depth below the ground |

The two rotors of a coaxial pair share their arm's axis by design and are not
checked against each other. A propeller is not checked against the arm
capsules: a real propeller turns above its arm, while the standard arms lie at
hub height. Without a stated clearance, derivation 5 rests the lowest part one
static deflection above the ground, so no part reaches it. Parts closer than
1 µm touch. Distances come from the GJK distance algorithm on the shapes'
support functions (Gilbert, Johnson and Keerthi 1988, with Ericson's
closest-point regions for the simplex), which converges from above, so a pair
is never reported clear when it is not by more than that tolerance.
`propellerClearance(profile, propellerRadiusM)` returns the clearance at rest,
whether the profile states it, and every clash; `describeClash` words one in
millimetres. Each motor's propeller radius is half its propeller card's
diameter, which is the derived manifest's rotor radius. The check takes the
profile rather than the manifest, because the Aircraft tab checks a profile
whose motor, ESC or battery cards are not chosen yet, and a manifest does not
say whether its supports came from a stated clearance.

`clearanceFix(profile, propellerRadiusM)` returns null for a profile without a
clash, or the fixed profile, each changed value before and after, the common
arm factor and the fixed profile's report:

1. Every arm grows by one common factor, so the aircraft keeps its shape,
   until each propeller is at least 5 % of the larger propeller diameter from
   every propeller on another arm and from the body (`fixTipGapOfDiameter`:
   the closest tip gaps of large production multirotors are about 5 % of the
   diameter). The factor is found by bisection, and each length is rounded up
   to the whole millimetre.
2. A stated ground clearance that leaves a part at or below the ground then
   rises to the lowest part plus δ_s, rounded up to the millimetre: the
   derivation's rule for a profile without one.
3. Propellers whose hubs coincide seen from above stay as they are, since no
   arm length parts them; they remain in the fixed report.

The fix changes nothing else: the mass properties stay as entered, and the
Aircraft tab says that longer arms usually weigh more. The tab's clearance
section lists every clash, draws the aircraft from above to scale with the
clashing discs marked, and offers "Propose a fix", which shows the changed
values now and after the fix and both top views; "Save the fixed version"
stores a new profile version, together with any other unsaved change of the
form. The Run tab refuses a start or connection whose profile clashes, as a
`vehicle` failure that names each clash.

| Example | Check | Fix |
| --- | --- | --- |
| Octa X on 0.35 m arms with 0.28 m propellers | Each of the eight neighbouring pairs overlaps by 2R − 2L·sin(π/8) = 12.1 mm | 0.385 m arms: 2L·sin(π/8) ≥ 1.05·2R needs 0.38414 m. The octa-x fixture (version 2) has them |
| Octocopter with 1.12 m (44 in) propellers on 0.25 m arms | All 28 pairs overlap, the neighbours by 928.7 mm, and each disc reaches 372.5 mm into the body | 1.537 m arms (1.5365 m needed) |
| Quad X on 0.17 m arms with the example card's 0.254 m propellers | Four neighbouring pairs overlap by 0.254 − 0.17·√2 = 13.6 mm | 0.189 m arms |
| Coaxial X8 with a 0.03 m clearance | The body touches the ground and the four lower discs reach 18.5 mm below it | A 0.054 m clearance |

Checks: `tests/aircraft-clearance.test.ts` compares distances with closed forms
(discs side by side and stacked, capsules parallel and crossing, a capsule
above a disc) and tilted discs with an independent sampled distance; finds the
cases above, the fixes and their minimality (at 0.384 m a neighbouring octa-x
pair is nearer than the 5 % gap); exempts a coaxial pair whose discs touch;
clears alternate hexa arms 6 cm apart in height but not 5 mm apart; rests a
coaxial X8 without a clearance on the derivation 5 supports; leaves stacked
propellers in the fixed report; and has the Run tab's preparation refuse the
short quad with each clash named and admit its fixed version.
`tests/browser/propeller-clearance.spec.ts` shortens the quad's arms in the
Aircraft tab, saves the clashing version, and applies and saves the fix
through the UI alone; with the TASK-152 installation the Run tab refuses the
clashing version and flies the fixed one with native ArduCopter (READY,
take-off to 5 m, a 10 s hold within 0.5 m, LAND and disarm).

### Accidents

Decision F-09 makes a contact of the body hull or a propeller disc an
accident, recorded with its tick, location, impulse and load, on which the run
pauses; contact on the support points alone, a hard landing included, is not
one ([phase1-fidelity.md](decisions/phase1-fidelity.md)). TASK-149 implements
it in `packages/physics/src/accident.ts`:

| Shape | Counts when it touches and | Threshold |
| --- | --- | --- |
| Propeller disc of a turning rotor | Always | The rotor turns at least 1 rad/s (under 10 rpm), Claude's reading of "while its rotor turns" |
| Hull shape, or the disc of a stopped rotor | Its penetration or its normal force reaches the threshold | 1 mm, or 5 % of the aircraft's weight m·g |

`AccidentMonitor` reads the contact's shape reports of the last step (contact
ABI v3: penetration, normal impulse and force, deepest point, touching) and
the rotor speeds, all into a typed array (`BetFlightDynamics.rotorSpeedsInto`), since
a double returned from a call that V8 does not inline is boxed. An accident is raised
on the tick a shape starts to meet the criteria. The shape counts again only
once it has touched nothing for 0.25 s of simulated time (TASK-156): a contact
that goes on after the run continues, a bounce, and the contact chatter of a
wreck at rest stay one accident, and the next strike is a new one. Several
shapes may strike on one tick; each is an event.
`check` allocates nothing: events wait in an outbox of 64, the overflow is
counted in `dropped`, and `drain` hands them out after the compute batch. The
constructor runs the raising branch once on a synthetic report, so a first
strike in flight does not deoptimize the step. `BetFlightDynamics` builds the
monitor when its configuration names the contact's shapes
(`contactParts`, which `profileFlightDynamics` passes from `ProfileGear.parts`),
and `reset` clears it.

After each step `PhysicsSessionV2` writes the tick and simulated time into the
monitor's `at` array and calls `check`. On an accident it pauses through the
user pause's path, `pause()` and the control processor's `paused()`, before the
tick is published, so that tick's state carries the paused flag and a later
`sim.start` is admitted as after `sim.pause`. The clock's catch-up ends after
that tick (`MultiRateClock.stopRequested`, which the remaining deadlines do not
count as drops), and in `sitl-lockstep` the paused session takes no further
actuator frame: the autopilot's next frame stays queued and the autopilot
waits for its reply, as in TASK-129. A new epoch clears the monitor.
`drainAccidents`, `accidentsDropped` and `accidentTotal` serve the Worker,
which posts `{ type: "accident.events", events, dropped, total }` after the
compute batch. After a resumed pump the SITL bridge client answers the frame
the paused session held (`SitlBridgeClient.answer`), since no new frame
arrives to trigger the reply.

The Run tab shows the run as `paused` with reason `accident` and its
accidents, each named as the profile names its part (`describeAccident`: a
motor, the body or an arm) with its force and depth. "Continue after the
accident" resumes the session with `sim.start` and returns to the state before
the pause; the rest of the run is then labelled as not validated for a
physically damaged aircraft (`ControllerView.afterAccident`), and a further
accident pauses it again. While paused, a connected SITL's silence is not a
heartbeat loss. TASK-156 adds the user pause and its other reasons.

An event becomes `events.accident` rows of recorder v2 (TASK-162), each a code
and up to three numbers, and the pause an `events.pause` row with 1 on the
same tick:

| Code | Numbers |
| --- | --- |
| 1 | A hull shape: its ID, the normal force N, the penetration m |
| 2 | A propeller: its rotor ID, the normal force N, the penetration m |
| 3 | The deepest point, body FRD metres from the CG |
| 4 | The normal impulse N·s, and for a propeller its rotor speed rad/s |

The recording's catalog entry counts its `events.accident` rows, so a
recording with an accident is marked as one. The experiment record does not
change: its inputs are fixed at version 1 (TASK-154, TASK-155).

Checks: `tests/accident.test.ts` applies the thresholds to scripted reports
(below and at 1 mm and 5 % of the weight, a propeller just below and at
1 rad/s, a stopped one at 1.2 mm), raises a continuing contact once and a new
one again, counts the outbox overflow and writes the record rows.
`tests/accident-session.test.ts` runs the quad X on the example cards: rolled
60 degrees and pitched 10 degrees nose down 5 mm above its lowest shape, with
stopped rotors in an interactive session and turning ones in lockstep, the
session pauses on the tick on which an independent run of the same dynamics
first meets F-09 in its raw reports, publishes that tick marked paused, and
steps no further (in lockstep the next frame waits until `sim.start`);
continued after each pause, it raises exactly the plain run's later strikes in
one second, each on its tick (motor 1's propeller at tick 13, whose bounces stay
that strike, and motor 4's at tick 68); upside down, its body strikes; and a
new epoch forgets the accidents.
Dropped level 0.2 m onto its supports with the motors off, the same quad
touches down at more than 1.9 m/s and is stopped at more than 3 g with no
accident. The events and the pause read back from a
recording. `tests/run-controller.test.ts` pauses a flying run on an accident,
continues it labelled, pauses it again on a second accident, fails a refused
resume with its reason and forgets a run's accidents in the next.

### Compute and allocation

`node scripts/bench-profile-dynamics.mjs` runs the sixteen-motor S19 fixture
on the example cards in Node 24 (V8, `--single-threaded`). Its rotors spin up
from rest to 0.8 of their hover-trim duty, so the vehicle stays on the
synthetic pad while every rotor runs near flight speed; `syntheticPad: true`
keeps it there instead of on its gear (TASK-095), so the step times the BET
compute alone, as before. It writes
`test-results/bench/profile-dynamics-16.json` with the manifest, WASM and
source hashes. The step is `BetFlightDynamics` alone, not the browser Worker
or the session; the scalar WASM build is used. The budget is the step period
(A-04: 400 Hz for every configuration, and 800 Hz in runs with ArduPilot SITL
since its amendment of 2026-11-03), and A-05 judges the average
real-time ratio, which must be at least 0.99. The run below is from the cloud
container (Intel Xeon at 2.80 GHz, 4 CPUs), not the Apple Silicon target.

| Rate | Period | Mean | p50 | p95 | p99 | Period / mean |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 400 Hz | 2.500 ms | 1.149 ms | 1.059 ms | 1.762 ms | 2.162 ms | 2.18 |
| 800 Hz | 1.250 ms | 1.142 ms | 1.056 ms | 1.694 ms | 2.148 ms | 1.09 |
| 1200 Hz | 0.833 ms | 1.129 ms | 1.056 ms | 1.651 ms | 2.056 ms | 0.74 |

At 400 Hz the p99 step stays inside the period. At 800 Hz the average keeps
real time, but one step in twenty takes longer than the period and must be
caught up by the clock. At 1200 Hz even the average exceeds the period, so the
16-rotor model cannot run in real time there until TASK-091 adds compute
headroom. G1 at 400 Hz: after 110,000 warm-up steps, 1,000,000 steps grow the
young generation by 2,960 bytes (0.00296 B/step) with zero GC events, and the
BET WASM memory keeps its armed size; an allocating positive
control in the same harness is detected (30 GC events).

### Verification (TASK-144)

`tests/polar-catalog.test.ts` checks the catalog bytes, hashes and parse
against the fixtures, airfoil matching and the schema 4 rules.
`tests/resolve-components.test.ts` checks every value and assumption of the
table above against the example cards. `tests/profile-dynamics.test.ts` loads
the five S19 configurations and holds their trimmed hover; checks that a quad
X splits its hover thrust by the lever arms about the CG,
T_front·(L/√2 − x_cg) = T_rear·(L/√2 + x_cg), for two arm lengths within 1e-6;
checks that an 11-inch propeller hovers slower and on less power than a
10-inch one, as momentum theory predicts (4403 to 3638 rpm, 127.8 to 117.4 W,
a ratio of 0.918 against the ideal 0.909); and loads the sixteen-motor model
through the session registry. `tests/browser/profile-dynamics.spec.ts` derives
the sixteen-motor manifest in Chromium and loads it into the application's
physics Worker. `tests/aircraft-editor.test.ts` checks the polar choices of the
Aircraft tab form.

## DataFlash reader and writer (TASK-178)

`@mirage/dataflash` reads ArduPilot DataFlash logs (`.BIN`) and writes
MirageSITL experiment records as DataFlash files. pymavlink 2.4.50, whose
`DFReader` `mavlogdump.py` uses, is the oracle for framing, field values and
times. Both directions run on the cold path.

### Reader

`DataFlashReader` is incremental: `push(chunk)` takes bytes in file order and
`finish()` returns the log; `readDataFlash(bytes)` does both. A record is the
header 0xA3 0x95, a type byte that an FMT record has defined, and the body
length that FMT declares. FMT itself (type 128, 89 bytes, `BBnNZ`) is built in.
Bytes that do not start a defined record are skipped up to the next one, as
pymavlink skips them. The reader reports every damaged range with its byte
offsets:

| Kind | Range |
| --- | --- |
| `skipped` | From the first byte that does not start a defined record up to the next header of a defined type, or to the end of the file. |
| `truncated` | A record with a valid header that the end of the file cuts short, or the first one or two bytes of a header that end the file. |
| `bad-format` | An FMT record that has an unknown format character, a Length that differs from the size of its format, a column count that differs from its format, or that redefines FMT. Its type stays undefined. |

pymavlink instead fails on an unknown format character and later skips the
records of a type whose Length is wrong. An FMT record that repeats the current
definition of its type changes nothing. One that differs starts a new group,
and later records of that type use it.

The result is a plain object, so a Worker can transfer it: the bytes read, the
record count, the damaged ranges, the clock, the group index of every record
in file order (`order`), and one group per message definition. A group has its
type, name, format, record count, the byte offset of each record and
pymavlink's timestamp of each record. Its columns are typed:

| Format | Column | Value |
| --- | --- | --- |
| b, M | Int8Array | as logged |
| B | Uint8Array | as logged |
| h, H, i, I | Int16Array, Uint16Array, Int32Array, Uint32Array | as logged |
| q, Q | BigInt64Array, BigUint64Array | as logged |
| f | Float32Array | as logged |
| d | Float64Array | as logged |
| g | Float32Array | binary16 widened exactly |
| c, C, e, E | Float64Array | integer divided by 100 |
| L | Float64Array | integer divided by 10^7 |
| a | Int16Array | 32 values per record |
| n, N, Z | Uint8Array | 4, 16 or 64 bytes per record |

The scaled formats divide rather than multiply, as pymavlink does, so the
values are the same doubles. `columnText(column, row)` decodes text as
pymavlink does: UTF-8, else Latin-1, cut at the first NUL. pymavlink returns
FILE.Data as raw bytes; the column holds those bytes.

Each column also has a unit, a multiplier, a value scale and an instance flag.
These come from the last FMTU record of its type, resolved against the log's
final UNIT and MULT tables. An identifier with no UNIT entry gives `''`, and no
MULT entry gives `null`. The value scale converts the stored value to the unit:
1 where the format already scales the value (c, C, e, E, L) or where there is
no multiplier, else the multiplier. The instance flag marks the `#` column.
pymavlink resolves each FMTU against the tables as they stand when it reads
that FMTU. In ArduPilot logs, FMTU records precede UNIT, so pymavlink loses
those units; the reader does not reproduce that.

Times follow pymavlink's `init_clock` and microsecond clock. The first GPS
record with GWk > 0 sets the timebase:

$$
t_\mathrm{base} = 315964800 + 604800\,\mathrm{GWk} + 0.001\,\mathrm{GMS} - 18 - 10^{-6}\,\mathrm{TimeUS}
$$

A record whose first column is TimeUS gets t_base + 10^-6·TimeUS. A record
whose first column is TimeMS gets t_base + 0.001·TimeMS, unless its name
starts with ACC or GYR or that time is earlier than the previous one. Any other
record repeats the previous time; the first time is t_base plus the first
TimeUS of the log. Without a GPS week the timebase and the first time are 0,
as in pymavlink. Logs
with older clocks give `clock: 'unsupported'` and NaN times: a GPS record with
a non-zero T, Week or GPSTime, a TIME record with StartTime, or no TimeUS at
all.

`parseSource(source, chunkBytes, onProgress)` reads a Blob, ArrayBuffer or
Uint8Array in chunks and reports the bytes read after each. `transferables(log)`
lists the log's buffers. `dataflash.worker.ts` takes
`{ type: 'parse', id, source, chunkBytes? }` (1 MiB chunks by default, at most
64 MiB). It replies `{ type: 'progress', id, bytes, total }` after each chunk,
then `{ type: 'result', id, log }` with the buffers transferred. It answers any
other message with `{ type: 'error', id, message }`, using id −1 when the
message has no valid id.

### Writer

`DataFlashWriter.append(record)` validates one record and encodes it; an
invalid record throws `RangeError` and writes nothing. `bytes()` returns the
log and `writeDataFlash(records)` does both. The log starts with FMT for FMT,
UNIT, MULT and FMTU, then the UNIT and MULT tables, then FMT and FMTU for each
MirageSITL message. Every time is TimeUS in microseconds (a safe integer
≥ 0). The names start with `MS`; in the pinned ArduPilot source, no
four-character log name starts with `MS`.

```text
type name format            columns                                                     units             multipliers
240  MSTR QLLfffffffffffff  TimeUS,Lat,Lng,Alt,PN,PE,PD,VN,VE,VD,Roll,Pitch,Yaw,GX,GY,GZ sDUmmmmnnndddkkk  FGG0000000000000
241  MSMO QBffffff          TimeUS,Inst,Cmd,RPM,Thr,Trq,Curr,Volt                        s#-qNtAv          F--00000
242  MSEV QBZ               TimeUS,Kind,Text                                             s--               F--
243  MSPC QINfffB           TimeUS,Seq,Name,Req,Old,Act,Stat                             s------           F------
UNIT - "" # instance s s D deglatitude U deglongitude m m n m/s d deg k deg/s q rpm N N t N.m A A v V
MULT - 0  0 1  F 1e-6  G 1e-7
```

| Message | Record | Content |
| --- | --- | --- |
| MSTR | `truth` | Latitude and longitude in degrees (L, within ±90 and ±180, rounded to 10^-7), altitude above mean sea level, NED position and velocity, roll, pitch and yaw in degrees, and body rates in degrees per second. |
| MSMO | `motor` | Motor index 0 to 15 (instance), normalized command, rpm, thrust, torque, current and voltage. |
| MSEV | `event` | Kind (0 `note`, 1 `environment`, 2 `fault`, 3 `command`) and text of at most 64 UTF-8 bytes without NUL. |
| MSPC | `parameter` | Request sequence (uint32), name (1 to 16 of A–Z, 0–9 and `_`), requested, previous and confirmed values, and status (0 `requested`, 1 `confirmed`, 2 `rejected`). A previous or confirmed value of `null` is written as NaN. |

ArduPilot defines no unit for newton, so the writer adds `N` to the UNIT table.
Float fields must be finite and remain finite in float32, and they are stored
as float32. Records must have exactly the listed fields.
`readExperimentRecords(log)` reads the MirageSITL records of a log back, in
file order. It turns NaN back into `null` and ignores other messages. It
rejects an MS message whose definition differs from the table above.

### Verification (TASK-178)

`scripts/generate-dataflash-fixtures.py` writes
`tests/fixtures/dataflash/reference.json` from pymavlink 2.4.50's
`mavlogdump.py --format json`, covering:

* `sitl-copter.bin`: the first 100,011 bytes (2,259 records, ending on a
  record boundary) of an ArduCopter V4.8.0-dev (8ab6afde) SITL log from the
  TASK-147 run;
* four damaged copies: 37 garbage bytes inserted, a type byte set to an
  undefined type, 300 bytes zeroed, and a cut final record. For each, the
  script checks that pymavlink loses exactly the recorded records and reports
  the same skipped ranges;
* a writer sample from fixed inputs, each exactly representable in its wire
  type. The script checks that pymavlink reads every input back unchanged.

`tests/dataflash.test.ts` compares every record, time and field value of the
slice exactly, at chunk sizes from 1 byte to 64 KiB; the damaged ranges and
surviving records of each damaged copy; the units; FMT rejection,
redefinition and truncation; the timebase, TimeMS and pre-TimeUS clock rules;
half floats; and pymavlink text decoding. For the writer it checks the
sample's bytes, pymavlink's reading of it, the identical re-parse and the
rejection of invalid records. `tests/browser/dataflash-worker.spec.ts` parses
the slice in the Worker in Chromium.

## Battery and propulsion limits (TASK-146)

With the TASK-092 drive, `BetFlightDynamics` records the electrical values of
every step and checks them against the component ratings and against the
clamps the model applied. A rating `warning` and a modeled `limited` clamp
stay separate everywhere: a warning never changes physics, and a clamp is
never reported as a warning. Heating, cooling and aging are not modeled.

### Limit ratings v1

`componentRatings(profile, cards)` (`@mirage/aircraft/resolve-components`)
builds the ratings from the cards a profile references, one entry per motor
in profile order, which is the derived manifest's rotor order. Only values a
card states become ratings, never assumed ones; null is never checked.
`parseLimitRatings(value, motorCount?)` (`@mirage/physics/limit-monitor`)
validates them from unknown input: exactly these keys, each rating a
positive finite number or null, 1 to 16 motors.

```json
{
  "schemaVersion": 1,
  "motors": [{ "motorCurrentA": 30, "motorPowerW": 450, "escCurrentA": 30, "escVoltageV": 25.2, "rpm": null }],
  "battery": { "emptyVoltageV": 13.2 }
}
```

| Rating | Card value |
| --- | --- |
| `motorCurrentA` | Motor card maximum current |
| `motorPowerW` | Motor card maximum power |
| `escCurrentA` | ESC card maximum current |
| `escVoltageV` | ESC card maximum voltage |
| `rpm` | Always null: component card schema 1 has no speed rating |
| `emptyVoltageV` | Battery cells in series × empty cell voltage |

### Telemetry and masks

`PowerTelemetry` holds, in preallocated arrays, five doubles per motor
(speed in rev/min, motor current, bus current and electrical power from
bound-rotor v2 record bytes 144, 152 and 160, and the ESC duty) and six for
the battery (state of charge, bus voltage, bus current, bus power, remaining
and total charge in Ah). It is written after the bus step of every tick. A
reset restores the unloaded pack: the initial state of charge, the
open-circuit voltage, no current.

| Kind | Subject | Bit | Condition | Compared with |
| --- | --- | --- | --- | --- |
| warning | motor | MotorCurrent | \|motor current\| > `motorCurrentA` | the rating |
| warning | motor | MotorPower | electrical power > `motorPowerW` | the rating |
| warning | motor | EscCurrent | \|motor current\| > `escCurrentA` | the rating |
| warning | motor | EscVoltage | bus voltage > `escVoltageV` | the rating |
| warning | motor | Rpm | \|speed\| > `rpm` | the rating |
| warning | battery | UnderVoltage | bus voltage < `emptyVoltageV` | the rating |
| limited | motor | CurrentLimit | bound-rotor v2 output flag 32 | the drive's current limit, or its brake limit for a negative current |
| limited | battery | PackCurrent | shared bus flag 1 (discharging or regenerating) | the pack current limit |
| limited | battery | Charge | shared bus flag 2 (regeneration into a full pack) | a state of charge of 1 |

A motor rated at its own current limit (TASK-144 takes the drive limit from
the motor card) is clamped exactly at the rating, so it shows `limited` and no
`warning`.

### Events

`LimitMonitor.evaluate` turns every mask bit that changes into an event in
a bounded outbox of 256: tick, subject (motor index or battery), quantity,
kind, edge (`start` or `end`), value and the rating or limit. Events beyond
the capacity are counted in `dropped`. The quantities are `motor-current`,
`motor-power`, `esc-current`, `esc-voltage`, `rpm`, `battery-voltage`
(warnings) and `current-limit`, `pack-current-limit`, `charge-limit`
(limited). `evaluate` allocates nothing; `drain` builds the event objects and
runs only after the compute batch. The monitor runs every event branch once
on synthetic telemetry at construction and then resets. V8 compiles
`evaluate` with the type feedback of the branches it has executed, and a
branch first taken in flight, such as a pack crossing its empty voltage, would
deoptimize it; the unoptimized code then boxes doubles until it is optimized
again. Event values and limits pass through a typed array, never as call
arguments.

Since TASK-177 the recorder keeps these events as `events.limit` rows, so a stored
experiment can say what it exceeded (see "Limit exceedances").

### Session, Worker and UI

`PhysicsSessionV2.attachPowerChannel` publishes power telemetry v1
([Shared Memory](SPECS_SHARED_MEMORY.md)) after every step. Each recording
sample carries the step's telemetry (`SessionRecordSample.power`), and
`drainLimitEvents` empties the outbox after a pump. The AAR v1 record has no
free bytes, so the per-motor values reach the recording hook, and the
recorder v2 format of TASK-162 stores them. The physics Worker attaches the
channel on `power.attach`, binds ratings to a manifest hash on
`limits.register`, and posts `limits.events` after each pump.
`profileModelPort` passes a model's ratings to its dynamics and refuses a
`model.load` whose ratings list another motor count. The Run tab's
`PowerPanel` reads the channel four times a second and shows the battery
values and status, a row per motor, and the newest limit events, labeling
each `Warning` or `Limited`. For the demo it states that there is no
electrical model.

### Verification (TASK-146)

`tests/limit-monitor.test.ts` recomputes the shared bus from the published
per-motor powers each step (V_oc linear in the state of charge, the current
root above, V = V_oc − I·R_int, ΔSOC = −I·dt/C) and matches voltage,
current, power, state of charge and remaining charge within 1e-12 relative
over 4,000 steps. It also checks that exceeded ratings warn while two runs,
one with and one without ratings, stay bit-identical; that a motor at its
current limit and a pack at its current limit are `limited`; that a low pack
warns of under-voltage; and the ratings schema, the outbox bound and the
brake limit. `tests/power-channel.test.ts` checks every byte offset of the
channel, the torn-read refusal, and a session that publishes four motors,
feeds the recording hook and drains a limit event while ABI v2 keeps its
size. `tests/browser/power-panel.spec.ts` runs a quad X profile in the
application's physics Worker with a 15 A pack limit and a 60 W motor power
rating and checks that the panel shows the pack `Limited` and each motor's
power as a `Warning`; it also checks the Run tab's panel for the demo.
`scripts/bench-profile-dynamics.mjs` measures G1 with the monitor and the
channel publish in the step loop.

## ArduPilot output mapping and frame parameters (TASK-142)

`packages/aircraft/src/output-mapping.ts` and `frame-parameters.ts`, shown in
the Aircraft tab by `apps/web/src/aircraft/OutputMapping.tsx`. Configuration-time
code only.

### Mapping record

```json
{ "schemaVersion": 1, "entries": [{ "motorId": 1, "output": 1 }] }
```

The record is the profile's own assignment of each motor to an ArduPilot servo
output (SERVOn): one entry per motor in ascending motor ID order, outputs 1–16
and unique. `outputMappingOf(profile)` reads it; `validateOutputMapping(input,
profile)` checks it from `unknown` and refuses an incomplete, misordered,
out-of-range, fractional or repeated assignment or an extra field with its
reason; `withOutputMapping(profile, input)` returns a new validated profile
in which only the outputs change. A profile and its own mapping round-trip to
the same canonical bytes.

### Frame selection

The only source is the TASK-128 catalog of the pinned firmware
(`tests/fixtures/sitl/frames.json`, ArduCopter V4.7.2, commit
`fb773567896014da007bca58358704d4a0d8516f`), validated from `unknown` once at
module load by `parseFrameCatalog`. `frameConfiguration(profile,
profileSha256)` decides in this order:

1. **Stock frame.** Every motor sits at one of a stock X frame's azimuths
   (within 1e-9°, wrapped to (−180°, 180°]) with that motor's spin, one to one,
   and all arms are equally long. ArduPilot allocates by azimuth and spin, so
   the arm height, the coaxial level and the tilt do not select the frame; a
   coaxial motor on the other level than in the catalog only adds a note. Each
   profile motor takes the matched stock motor number, output function and
   normalized factors from the catalog.
2. **Stock scripting matrix.** Otherwise, if the layout can be controlled,
   frame class 15 with the generated Lua file, `SCR_ENABLE 1` and
   `SERVO_32_ENABLE 1` (32-channel packets, as TASK-128 flew it; motors stay on
   outputs 1–16). ArduPilot motor k is the k-th motor in ascending motor ID
   order, with test order k. With arm length L, azimuth a and the longest arm
   L_max, the raw factors are roll = −L·sin a / L_max, pitch = L·cos a / L_max
   and yaw = +1 for counter-clockwise, −1 for clockwise; ArduPilot normalizes
   them so the largest magnitude of each is 0.5. For equal arms these are the
   TASK-128 paired-16 factors cos(a + 90°) and cos(a).
3. **Refused.** No parameters, with every applicable reason:
   `no-yaw-authority` (one spin direction only), `no-roll-authority` or
   `no-pitch-authority` (no motor off the body x or y axis), else
   `dependent-axes` when the rows thrust, roll, pitch and yaw of the raw factor
   matrix have rank below 4 (for example three motors, or one coaxial pair).

Notes are structured as well: `stock-frame`, `scripting-frame` (with the
TASK-128 frame ID when the layout is the one flown), `stock-spin-mismatch`,
`stock-unequal-arms`, `coaxial-level-differs`, `thrust-axis-tilt-ignored`
(ArduPilot's matrix assumes vertical thrust; the simulation applies the tilt,
the allocation does not compensate it) and `thirty-two-channel-packets`.

### Generated parameters

`FRAME_CLASS`, `FRAME_TYPE`, `SERVO_32_ENABLE`, `SCR_ENABLE` for the scripting
matrix, then `SERVO1_FUNCTION` to `SERVOn_FUNCTION` for every packet channel,
0 where no motor is assigned. Motor functions follow the catalog: 33–40 for
motors 1–8, 82–85 for 9–12, 160–163 for 13–16. Only names TASK-128 set and
read back on the pinned firmware are written (`FRAME_PARAMETER_NAMES`); any
other name is an internal error. `parameterFileText` writes one `NAME value`
line each, in that order. The result carries the profile version's SHA-256,
or null for unsaved edits, and the firmware identity; the Lua file names the
same version. The TASK-128 harness lines `ARMING_SKIPCHK`, `MOT_PWM_MIN`,
`MOT_PWM_MAX` and `SIM_RATE_HZ` belong to the run, not the frame, and are not
generated here.

### S19 configurations

| Fixture | Frame | Output functions, outputs 1 to n |
| --- | --- | --- |
| quad-x | stock quad-x (1/1) | 33, 34, 35, 36 |
| hexa-x | stock hexa-x (2/1) | 37, 33, 36, 38, 34, 35 |
| octa-x | scripting matrix (15/1) | 33 to 40 |
| coaxial-x8 | stock x8 (4/1) | 33, 36, 35, 34, 38, 39, 40, 37 |
| octa-coaxial-16 | scripting matrix (15/1), flown as paired-16 | 33 to 40, 82 to 85, 160 to 163 |

The octa-x fixture puts a counter-clockwise motor at 22.5°, where stock OCTA X
has a clockwise one; every spin is the mirror, so the stock frame would yaw the
wrong way and the scripting matrix is used. TASK-128 found no 16-motor
blocker; the 16-motor profile maps every motor.

### Verification (TASK-142)

`tests/output-mapping.test.ts` builds a profile from each of the five catalog
frames and requires the generated parameter file to equal, byte for byte, the
frame and output lines of the file the TASK-128 harness set, read back and
flew (`scripts/sitl/multirotor.mjs`, run in a separate Node process), and the
normalized factors to equal the catalog's source-derived factors; the paired-16
Lua calls equal the flown calls to 1e-14. It checks the S19 fixtures against
the hand-typed table above, mapping round trips and rejections, a changed
mapping, unequal arms and four uncontrollable layouts with their reasons.
`tests/browser/output-mapping.spec.ts` builds the 16-motor profile through the
Aircraft tab, checks its 16 rows and parameter file, swaps two outputs in the
arm table and checks the moved functions and the new version, and refuses a
hexa whose motors all turn one way.

## Browser physics as the JSON lockstep backend (TASK-153)

Increment 1 is the headless core that the physics Worker runs; the Worker,
the WebSocket client and the Run tab come next.

### Link

`SitlJsonLink` (`packages/autopilot/src/sitl-link.ts`) runs in the thread
that owns the PhysicsSessionV2 in `sitl-lockstep` mode, on the session's
state buffer and actuator queue. It reads bridge records (version 1, 16-byte
header, apps/bridge/src/framing.ts) of the run's epoch: channel 1 is MAVLink
in both directions, channel 3 servo packets from SITL; channel 2 state lines
leave through `outbound`. For each new servo frame it writes one
ActuatorFrameV2 for the session's next tick: the published epoch and tick
plus one, the Armed flag, the profile's model ID as the motor map ID, and
each rotor channel's ESC duty (pwm − 1000 µs) / 1000 µs, clamped to [0, 1]
and counted when clamped. After the owner pumps the session, `poll()` checks
that the published tick is that tick and encodes the JSON line from the
published state: `timestamp` the simulated time, `imu.gyro` the body rates,
`imu.accel_body` the body specific force, `position`, `velocity` and
`quaternion` in NED, and `battery` when the model publishes a pack voltage.
A resent frame is answered with the stored reply and never steps; a lost
frame is counted and the next one steps once; a frame that arrives before the
reply is held and SITL resends it; a frame 0 after a higher count reports a
restart, and the owner starts a new epoch and calls `reset()`. A frame that
cannot be delivered forgets the frame counter, so SITL's resend steps. The
owner reads the stepped state from `link.state`: a second FlightStateV2
object read from the same buffer makes the state decoder polymorphic, which
allocated about 637 kB after a full GC in the G1 probe.

### Ground station

`GroundStation` (`packages/autopilot/src/ground-station.ts`) packs the
application's MAVLink2 HEARTBEAT (type GCS, system 255, component 190) and
COMMAND_LONG requests: DO_SET_MODE with ArduCopter's custom mode, arm,
NAV_TAKEOFF, NAV_LAND and SET_MESSAGE_INTERVAL. It is a cold path. The
launcher's relay forwards to SITL only after SITL's first datagram, so stream
requests repeat until acknowledged. LiveEkfWarmup needs GPS within 0.3 s of
the IMU, so EKF_STATUS_REPORT, GPS_RAW_INT and GLOBAL_POSITION_INT are
requested at 10 Hz.

### Rate and parameters

ArduCopter's pre-arm check requires the gyro at 1.8 times its 400 Hz loop
(at 400 Hz physics: "PreArm: Gyro 0 rate 400Hz < loop rate*1.8 720Hz"), so
integrated sessions run at 800 Hz or 1200 Hz; decision A-04, amended on
2026-11-03, sets 800 Hz for runs with ArduPilot SITL. MOT_PWM_MIN and
MOT_PWM_MAX are set to 1000 µs and 2000 µs, the link's duty span; the frame
parameters come from the TASK-142 generator.

### Attitude oscillation of the quad X at stock gains

TASK-158 found it in the flights' own DataFlash logs. With ArduCopter's stock
rate gains (`ATC_RAT_RLL_P` and `_I` 0.135, `_D` 0.0036) and 20 Hz gyro filter
(`INS_GYRO_FILTER`), the S19 quad X on the example cards holds 5 m within 0.1 m
while its roll rate swings ±85 deg/s at 10.3 Hz (standard deviation 61 deg/s)
and its motor commands spread from 15 % to 61 %, drawing 238 to 403 W at the
moments sampled against 128 W when steady. This airframe is light and has
much authority: it hovers at a learned `MOT_THST_HOVER` of 0.23, with moments of
inertia of 0.016 and 0.017 kg·m² about roll and pitch. The other four S19
configurations stay within 0.22 deg/s at the same gains.

The headless harness of `tests/external-sitl-flight.test.ts` shows the same
oscillation as the Run tab, at 800 Hz and at 1200 Hz (62.3 and 62.7 deg/s, both
at 10.3 Hz), so neither the browser nor the step rate causes it. The rate gains
on both axes at 0.95 and 0.9 of stock leave it (59.5 and 50.4 deg/s); at 0.8 and
0.6 the quad is still (0.13 and 0.10 deg/s). At stock gains it is also still
with a gyro filter of 30 or 40 Hz (0.13 and 0.07 deg/s), and with both moments of
inertia at 0.02 kg·m² (0.11 deg/s), but not at 0.017 kg·m² (40 deg/s on both
axes). Lowering the roll gains alone moves it to pitch (56 deg/s): both axes are
above the limit, and the axis that oscillates hides the other, since they share
the motors. A hand estimate of the loop (thrust slope 15 N per unit of thrust
demand, mixer factor 0.5, the 20 Hz filters, a motor lag of 37 ms and 5 ms of
delay) puts its −180° phase crossing at 10 Hz, the measured frequency, with a
gain of about half what the flights imply; it uses the steady thrust slope, and
the difference is not resolved. This is a result about these gains on this
aircraft, and no measured aircraft confirms it. Decision A-13 of 2026-11-04 limits
the body rates in each hold of TASK-158's flight to a standard deviation of
1 deg/s, so from then the quad flew that acceptance with `INS_GYRO_FILTER` at 40 Hz,
typed into the Parameters tab after READY, and the other configurations flew stock.

TASK-198 found on 2026-11-06 that this oscillation no longer occurs, on either
firmware. `node scripts/phase1/nominal-flight.mjs --configuration quad --stock-settings`
now reads 0.09 deg/s of roll on V4.7.2, and 0.10 and 0.08 deg/s in two flights on
`8ab6afd` with the same code. A bisection with that control on `8ab6afd` puts the
change at TASK-098 (commit `47f59de`): the commit before it reads 59.39 deg/s and that
commit 0.08 deg/s. TASK-098 replaces the uniform inflow's fixed 0.1 s lag with a
physical time scale of milliseconds. That this lag cost the loop its phase margin is
the likely reading; it has not been shown separately. The negative control of A-13
therefore no longer fails, and `tests/integration/phase1-nominal.test.ts` still holds the 1 deg/s
limit to hand-built readings. On 2026-11-07 the stakeholder dropped the 40 Hz filter:
the quad flies its acceptance at stock settings and held 0.10, 0.09 and 0.05 deg/s,
and all five configurations, flown again under the changed rules, hold 51 PASS.

### Rotor lookup-table mode (TASK-103)

Tier A of the fidelity tiers: a rotor whose loads come from a table instead of the
blade-element kernel, for faster-than-real-time regression and for measured or
external-solver data. It is selected per rotor (`rotorModel: "bet" | "map"`) and shares the
bound-rotor records, the shaft, the ESC drive and the bus with the BET rotor: only the loads
differ. It has no inflow, flapping or fluctuation state, so body rates, cyclic pitch, ground
effect and the vortex ring fluctuation are not in it; a query with cyclic pitch is flagged.

Coefficients are non-dimensional, so the `ρ·Ω²` scaling is exact by construction:

```text
T = cT ρ Ω² R⁴      H = cH ρ Ω² R⁴
Q = cQ ρ Ω² R⁵      Mr = cR ρ Ω² R⁵      Mp = cM ρ Ω² R⁵      P = cP ρ Ω³ R⁵
J = |v| / (Ω R)     α = atan2(-v_z, hypot(v_x, v_y))     M_tip = Ω R / a
s = (ρ a / μ) / (ρ a / μ)_reference
```

The axes are the advance ratio J, the airflow angle α from −90° (descending into the wake)
through 0° (edgewise) to +90° (axial climb), the tip Mach number, the Reynolds scale s and the
collective pitch, in that order, with up to 64 points each and at most 32768 points in all.
Interpolation is multilinear in the five axes. A table holds a rotor spinning in the +1 sense
with the air along hub +x; `H`, `Mr` and `Mp` turn with the airflow's direction ψ in the disk,
and a rotor of the other sense mirrors `Q` and `Mr`. A query more than 1e-9 outside an axis,
which is the rounding of its own arithmetic, is clamped to the edge and sets output flags 8
(outside validity) and 512 (`ROTOR_FLAG_MAP_EDGE`); a point of validity below 1 sets flag 8. At
J = 0 the angle does not matter and is not flagged.

The Reynolds scale was not in the table the budget below was first declared for. `ρ·Ω²` scales
a rotor at one Reynolds number only: a blade loses lift and gains drag at a lower one, so four
axes missed the density limit below by up to 29.6 % of thrust at ρ = 0.9, and by 7.3 % even at
the fastest tips. J, α, M_tip, s and the collective together fix the flow, whichever of density,
speed of sound and viscosity moved. A table from a thrust stand holds one air: its s axis has
one point and other air is flagged.

Configuration version 6, on the same arena and records as the BET rotor:

| Bytes | Field |
| --- | --- |
| 0, 4 | version 6, total bytes |
| 8, 12, 16, 20, 24 | points on the J, α, M_tip, s and collective axes |
| 28 | spin sign, +1 or −1 |
| 32 | the reference air's ρ a / μ |
| 40 | radius, m |
| 48 | reserved zero |
| 56, 64 | shaft inertia kg·m², bearing viscous damping N·m·s/rad |
| 72, 80 | step s, initial speed rad/s |
| 88..128 | reserved zero |
| 128.. | the five axes, then 7 f64 per point: cT, cH, cQ, cR, cM, cP, validity |

Declared before the first run. On `tests/fixtures/rotors/rotor-map-synthetic.json`, generated
from the full BET (`baseline-two-blade`, with dynamic inflow), compared with that BET at the
midpoints of the table's cells, where the interpolation is at its worst:

| Quantity | Region | Limit |
| --- | --- | --- |
| Thrust, torque | α ≥ 0 | within 5 % of the BET, or 1 % of that speed's hover value |
| Thrust, torque | α < 0, validity 1 | within 15 %, or 1 % of that speed's hover value |
| H-force, rolling and pitching moments | validity 1 | within 20 %, or 1 % of that speed's hover thrust (times R for a moment) |
| Any load at a table node | all | 1e-9 relative, the generator's settling aside: 1e-12 of the table |
| Density, against the BET at ρ = 0.9 | α ≥ 0 | within 3 % of thrust and torque |

The bench oracle is the archived UIUC static data (`tests/fixtures/rotors/uiuc-propellers.json`,
measured): a zero-airflow table reproduces the points it holds within 1e-12, and one built
from every other point reproduces the ones it left out within 3 % of C_T and C_P. The cost: a
16-rotor tick in scalar WASM on the reference Mac at most 31.25 µs, half the budget of 800 Hz
at 20 times real time, as G3 limits compute to half of `dt`. The step allocates nothing:
zero allocator calls over one million native steps, and zero GC events in WASM.

**Results, with the limits above unchanged.** The fixture has 23 × 20 × 8 × 5 × 1 = 18,400 points,
11,579 of them of validity 0, in 1.7 MB, and regenerates in about 2 minutes, byte for byte on one machine. The
axes grew through the first runs: 702 points missed the thrust limit at 49 midpoints, and the
density limit needed the fifth axis and more points at low speed. A rotor's arena limit rose
from 512 KiB to 2 MiB to hold this. Sixteen such rotors take 34 MB of the 64 MB
rotor memory budget, because each holds its table twice, against 12 MB for the BET.

One thing narrows what was declared. The budget says α ≥ 0, and it holds for the queries the
table does not flag. A point has validity 0 where the BET flags it, which is all descent with
J > 0, or does not settle, and also, added after the first run showed why, where thrust is
below 10 % of that speed's hover: the inflow closure has a kink at zero thrust that no table
can follow, and a percentage of a near-zero load means nothing. So no point below α = 0 has
validity 1, and the second row of the budget compares nothing. A flagged query still flies on
the table's numbers. The flag says they are not validated, not that they are refused.

At the midpoints of the cells, for queries the table does not flag:

| Air | Compared (flagged) | Thrust, worst | Torque, worst |
| --- | --- | --- | --- |
| ρ = 1.225, s = 1 | 831 (2095, of which 1017 at α ≥ 0) | 1.70 % | 1.25 % |
| ρ = 0.9, s = 0.735 | 793 (1055 at α ≥ 0) | 2.71 % | 1.43 % |
| 3000 m standard, s = 0.758 | 793 (1055 at α ≥ 0) | 2.72 % | 2.40 % |
| 5000 m standard, s = 0.623 | 805 (1043 at α ≥ 0) | 2.39 % | 2.76 % |
| 40 °C at sea level, s = 0.899 | 795 (1053 at α ≥ 0) | 2.08 % | 1.47 % |

Those percentages have no floor; with the budget's floor of 1 % of hover, no thrust or torque
exceeds its limit at s = 1, and H-force and both moments are all within theirs. As a share of
hover at s = 1, the error reaches:

| Quantity | Not flagged | Flagged, α ≥ 0 | All, with descent |
| --- | --- | --- | --- |
| Thrust | 1.39 % | 5.31 % | 21.58 % |
| Torque | 1.32 % | 7.74 % | 22.03 % |
| H-force | 0.12 % | 0.76 % | 2.60 % |
| Rolling moment | 0.36 % | 3.01 % | 8.94 % |
| Pitching moment | 0.77 % | 1.36 % | 15.08 % |

The table flies the fixture's quad on the same polar and inflow as the BET, on torque drive, for 3 s
from the same start. Declared before that test's first run: speed within 2 %, climb rate within
10 % or 0.1 m/s.

| Throttle | Rotor speed, BET and table, rad/s | Vertical speed, BET and table, m/s (positive down) |
| --- | --- | --- |
| 0.3, sinking | 302.5, 302.1 | 6.724, 6.818 |
| 0.55, near hover | 354.7, 356.0 | 0.478, 0.444 |
| 0.8, climbing | 427.5, 428.1 | −5.417, −5.377 |

**Bench data.** On all 14 UIUC propellers, a zero-airflow table reproduces the points it holds
within 1e-12. The leave-out limit is **not met**: 9 of 111 left-out points lie more than 3 % from
the table, the worst by 6.61 % of C_P and 5.50 % of C_T. The miss is the measurements' own
scatter, not the interpolation. At 4253 rpm the three-blade 5x3.75 reads C_T 0.1963 between
0.2120 and 0.2031, and at 9943 rpm the two-blade 5x1.58 reads C_P 0.03506 between 0.03626 and
0.03831. A least-squares cubic through each propeller's own points leaves raw points up to
6.08 % away from it, and the table's value is within 2.59 % of that cubic at all 111. That
second comparison was added after the miss to find its cause, and it does not replace the limit:
`tests/rotor-map.test.ts` keeps the nine points by name. The stakeholder accepted the miss on
2026-11-07 and TASK-103 is DONE with it; the limit stays 3 %.

**Cost.** A 16-rotor tick in scalar WASM takes 6.82 µs on average and 8.71 µs at p99 against the
limit of 31.25 µs, and the BET with dynamic inflow takes 231 µs, 34 times as long, on the
reference Mac (Apple M5, Node 24.22.1, load average 2.0 to 2.6, one thread, not a browser):
`node scripts/bench-rotor-map.mjs`, which writes `test-results/bench/rotor-map.json`. That is 183
times real time at 800 Hz for these rotors alone. The rest of the physics tick is not in it.

**Allocation.** Zero allocator calls and bytes over one million native steps
(`table_rotor_step_allocates_zero_over_one_million_steps`). Through the flight model, on the ESC
drive in a gusty wind, four table rotors over one million steps in each WASM variant:
zero GC events and 2048 bytes in all, the measurement's own, in both (graph `rotor-map-esc-drive-weather-pad-four-rotor` of
`node scripts/check-bet-runtime.mjs --allocation`).

**What it does not do yet.** The selection exists per rotor in `BoundRotorDefinition` and in
`BetFlightConfiguration.rotorMaps`; the aircraft profile and the application do not offer it. The
fixture is synthetic: no external solver's table exists, and no table has been compared with a
flight log, which V2_PLAN B4 asks for. The wake model reads a momentum-theory estimate of the table
rotor's induced velocity, and TASK-090's certification of Tier A against Tiers B and C is open.

### Allocation

`decodeServoPacketInto` reads the datagram byte by byte, the lockstep copies
replies without a subarray view, and `encodeStateLineInto` passes doubles to
its writers through a preallocated slot, because V8 boxes a double argument
of a helper it does not inline. `node scripts/check-sitl-link-allocation.mjs`
measures receive, pump and poll per servo record on the quad X profile after
110,000 warmup steps, with an allocating positive control; WebSocket I/O is
excluded.

### Verification (TASK-153)

`tests/external-sitl-session.test.ts` drives a real session with the quad X
profile through lost, resent, stale, held, foreign-epoch and damaged records,
checks the replies with the bridge's state-line validator, and decodes the
ground station's frames with pymavlink 2.4.50.
`tests/external-sitl-flight.test.ts` flies the profile with the installed
native ArduCopter through the launcher: READY from LiveEkfWarmup, GUIDED,
arm, take-off to 5 m, a 10 s hold and LAND.

### Physics Worker and Run tab (increment 2)

`SitlBridgeClient` (`apps/web/src/sitl/bridge-client.ts`) is the link in the
physics Worker. The Worker opens the run's bridge on `sitl.connect` (port,
token, bridge epoch, motor channels, motor map ID and speed-up from Main),
with the token as a WebSocket subprotocol and never in the URL, and only
while the session is in sitl-lockstep. For each new servo frame the client
acknowledges the previous reply's IMU sample to LiveEkfWarmup, pumps the
session, polls and sends the reply; every 80 steps it checks readiness,
flushes session events and posts `sitl.status`, so READY is re-evaluated
ten times per simulated second at 800 Hz and stale diagnostics revoke it.
MAVLink chunks are fed to LiveEkfWarmup at the current simulated time and
posted to Main as `sitl.mavlink`; `sitl.mavlink.send` carries Main's
ground-station frames back. A SITL restart ends the session with a fault.

Main's `SitlRun` (`apps/web/src/sitl/sitl-run.ts`) prepares the vehicle from a
stored profile version and the exact card versions it names (derived
manifest with model ID 153, component ratings, TASK-142 frame parameters and
script, MOT_PWM_MIN and MOT_PWM_MAX), gives the Worker the BET module from
`/__bet/` checked against its manifest, registers the manifest and ratings,
configures 800 Hz sitl-lockstep, loads the model and starts the session,
asks the launcher for a run of the first usable build, and connects the
Worker. It sends the ground-station heartbeat each wall second and repeats
stream requests until acknowledged; Take off sets GUIDED and arms, retrying
each second, then sends NAV_TAKEOFF once the heartbeat reports armed; Land
sets LAND. Its stages follow the autopilot's own heartbeat and the published truth:
flying means the climb has settled within 0.5 m of the target below 0.3 m/s
vertical speed, and landed means disarmed after LAND. The Run tab's ArduPilot SITL backend
(`apps/web/src/run/SitlFlight.tsx`) takes the launcher's port and token for
the page only, and the session keeps running while the page is hidden.

## Experiment start, stop and failures (TASK-154)

### Run states

`SessionController` (`apps/web/src/run/session-controller.ts`) is a pure state
machine on four injected ports: the launcher, the physics Worker, the
experiment record store and a clock. The Run panel
(`apps/web/src/run/RunPanel.tsx`) only renders its state. The states are a
discriminated union:

| State | Entered on | Left on |
|---|---|---|
| idle | first view; a completed user Stop | Start |
| starting | Start: prepare, firmware, physics, launcher, record, connecting | ArduPilot's first heartbeat; a failure; Stop |
| loading parameters | the first heartbeat from system 1, component 1 with autopilot 3: PARAM_REQUEST_LIST is sent | the list is complete and every generated parameter reads back; a mismatch, an absent name or 30 s of simulated time |
| warming | parameters confirmed while READY is false; READY revoked | READY |
| ready | READY from the Worker's LiveEkfWarmup | Take off; READY revoked |
| running | Take off: arming, climbing, flying (within 0.5 m of the target below 0.3 m/s), landing | disarmed after LAND, back to ready or warming |
| paused | none yet: synchronized pause and its control are TASK-156 | — |
| stopping | a user Stop, or any failure once the launcher owns a run | the launcher's stop answer |
| failed | a failure, after stopping when a run was owned | Start again, or Stop again after a failed stop |

Every Start, a restart included, is a new launcher experiment with a new
record and a fresh physics Worker; changing the profile, the build or the
speed therefore always means a new run. Stop cancels a start in any step: a
run the launcher reports after the Stop is stopped at once. A failure after
the launcher owns a run silences the ground-station beat and the bridge,
stops the run, collects the launcher's run state, exit code, signal, exit
reason, stdout and stderr tails and DataFlash list, and only then shows
failed, so a failed state never leaves an owned process. A READY loss in
flight is shown as a warning. The ground station sends only while the
Worker's bridge socket is open, and the first heartbeat must arrive within
60 s of wall time.

Each failure has a reason kind, its text and a restart path:

| Reason | Text begins | Restart |
|---|---|---|
| vehicle | The aircraft profile cannot run | fix the profile, then Start again |
| firmware | ArduPilot build … cannot be started | reinstall or choose another build |
| launcher-unreachable | No MirageSITL launcher answered on 127.0.0.1:port | start the launcher or check the port |
| launcher-foreign | Port … answers, but not as the MirageSITL launcher | enter the launcher's port |
| launcher-refused | The launcher refused the run | Start again |
| physics | The physics session could not be prepared | Start again |
| record | The experiment record could not be saved | Start again |
| no-heartbeat | SITL started but sent no heartbeat | Start again |
| parameters | ArduPilot did not confirm the initial parameters | Start again |
| sitl-ended | SITL ended (while starting, during EKF warmup, …) with the launcher's exit reason | Start again |
| bridge-lost | The bridge to SITL closed … while SITL kept running | Start again |
| sitl-restarted | SITL restarted on its own | Start again |
| stop-failed | Stopping SITL failed | Stop again, which ends as the stop was meant to |

A program on the launcher's port that does not answer CORS reads as
launcher-unreachable in Chromium, which reports a failed preflight as a
network error; launcher-foreign needs an answer the browser may read.

### Experiment record

`packages/aircraft/src/experiment.ts` defines experiment payload schema 9
(TASK-186) in record envelope v1, and the application registers
`validateExperiment` for the `experiment` kind. The record has exactly one
dependency, its aircraft-profile version, and the payload holds:

| Field | Content |
|---|---|
| profile | SHA-256, item ID, version and name of the profile version |
| sitl | `ownership: "launcher"`: the launcher experiment ID, which names `experiments/<id>/`, and `ardupilot`, the launcher catalog ID, firmware version, commit, binary SHA-256 and default-parameter SHA-256 of the build that ran, as the launcher's view reports them; or `ownership: "external"` for a SITL the user started (see the TASK-155 section) |
| session | physics rate (800 or 1200 Hz), `sitl-lockstep`, speed-up (null for an external SITL), home, model ID, manifest SHA-256 and BET module SHA-256 |
| parameters | exactly the list sent to the launcher, in its order, each tagged frame, output, pwm, sensor, set or site (`set`: TASK-176, see "Parameter batches"); for an external SITL the same generated list without site, which it was confirmed to hold |
| frameScript | the Lua of a scripting-matrix frame, or null (always null for an external SITL) |
| sensors | `sensorSnapshot()` of the profile version, verbatim |
| recording | the run's recorder v2 record ID and the Logging tab settings it records with (common, group and signal rates, the run length and the storage reserve; TASK-163), or null for a run that records nothing |
| lineage | an original run, or a repeat or variant of a parent experiment (TASK-165; see "Experiment lifecycle") |
| flightTask | the flight task the run was started with: its definition, its name and the SHA-256 of the `flight-task` record as data (TASK-172; see "Flight tasks"), or null |
| faults | the effects the run applies by itself, or null (TASK-169; see "Faults and interference tab") |
| weather | the weather schedule the run applied by itself, its seeds and random streams included (TASK-167; see "Weather tab: TASK-167"), or null |
| environment | the location of the run (site, coordinates, ground elevation, heading, measured QNH, temperature offset) with the effective conditions evaluated there (TASK-148), or null for a run without a location; the session's home must be the location, the conditions must be evaluated at it with h = H + N, the WMM zone must match the horizontal field, and the air must come from the location's sea-level pressure |
| terrain | the local real terrain the run stood on: its source, the SHA-256 of its layer and manifest, the radius, the deepest level, the chunks loaded and missing, the lattice's SHA-256 and the terrain's height at the home (TASK-186; see "Terrain source selection: TASK-186"), or null for the synthetic pad; it needs the environment |

Schema 1, which TASK-154 wrote, had `ardupilot` and `launcher` at the top
level and a required speed-up; schema 2, which TASK-155 wrote, had no
`recording`, schema 3, which TASK-163 wrote, no `lineage`, and schema 4, which
TASK-165 wrote, no `flightTask`, schema 5, which TASK-172 wrote, no `faults`, and
schema 6, which TASK-169 wrote, no `environment`, schema 7, which
TASK-148 wrote, no `weather`, and schema 8, which TASK-167 wrote, no `terrain`.
All stay valid on reads and archive imports; `readExperiment` presents them as
schema 9 runs on the synthetic pad, without a weather schedule before schema 8,
without an environment before schema 7, with no fault schedule before schema 6,
without a task before schema 5, original runs before schema 4, without a
recording before schema 3 (schema 1 with a launcher-owned `sitl`), and
`createExperimentRecord` writes only schema 9.

`createExperimentRecord` recomputes the snapshot from the stored profile
version and requires canonical-byte equality, cross-checks the frame and
output parameters, the frame script and the manifest against that version, and
writes the record once, after the launcher has started SITL and before the
bridge connects; no unrecorded run flies. A start the launcher refuses writes
no record. Run outcomes (failures, exit codes) stay in the launcher's
experiment view and logs; the record holds only inputs, which the store fixes
after version 1. In the worst Phase 1 case, the 16-motor octa with its
scripting-matrix Lua, every preset cited and 206 parameters, the record
encodes to 26,226 bytes against the 1 MiB limit.

### Initial parameters and read-back

`prepareVehicle` (`apps/web/src/sitl/sitl-run.ts`) builds the frame and output
parameters (TASK-142), MOT_PWM_MIN and MOT_PWM_MAX, and the ArduPilot-owned
sensor parameters of `sensorRuntime` (TASK-147) with the launcher's home
altitude, the stock compass offsets and the aircraft's CG; the names must be
disjoint. A profile that sets any MirageSITL-owned sensor error term (IMU
noise, bias, latency, position or orientation; battery measurement errors) is
refused at start with the terms named, because the browser path does not apply
them on the JSON line yet (user decision of 2026-11-01); any stored value
counts, a neutral one included. `ParameterReadback`
(`packages/autopilot/src/parameter-readback.ts`) collects PARAM_VALUE by
index against param_count and compares each generated value as float32; a
name the complete list lacks is accepted only under the absent rule of the
pinned ArduPilot catalog, which `scripts/check-sitl-sensors.mjs` now imports
from it.

### Launcher changes

`POST /v1/experiments` checks the body, the build, the one running
experiment and the build's files before it creates anything, so a refused
start leaves no experiment and no folder; a spawn failure answers 500 with
the experiment ID. An experiment's view reports the build identity without
machine paths, the state `starting` or `start-failed` (with `startError`)
around a launch, and ports only while a bridge is open. A run's `reason` is
null after a requested stop and otherwise `exit code N` or `killed by
SIGNAL`, followed by the last stderr line. `closeBridge(experimentId)` on the
object `startLauncher` returns ends a run's bridge and relay without stopping
SITL; no HTTP route reaches it, and it exists only to inject bridge loss in
tests (user decision of 2026-11-01).

### Verification (TASK-154)

`tests/run-controller.test.ts` drives the controller on scripted ports and on
a real launcher with the shared fake SITL (`tests/support/fake-sitl.mjs`,
`tests/support/fake-firmware.ts`): every transition, Stop from every state,
each failure kind with its restart, and the record payload.
`tests/experiment-record.test.ts`, `tests/parameter-readback.test.ts` and
`tests/launcher.test.ts` cover the record, the read-back and the launcher.
`tests/browser/run-panel.spec.ts` runs the four DoD faults through the Run
tab with the installed ArduCopter behind a wrapper: a missing binary, a busy
port (a fake SITL that cannot bind a held port, and a program that is not the
launcher on its port), SITL killed during EKF warmup, and bridge loss; each
shows its reason and diagnostic log, leaves no owned process and reaches READY
again on Start again.

## Manual connection to a running SITL (TASK-155)

A user who started ArduCopter themselves connects the Run tab to it instead
of having the launcher start one (S02). The launcher owns only the
connection: its bridge and MAVLink relay. Disconnect, and every failure of a
connection, closes those and never signals the SITL process, which keeps
running. The decisions of 2026-11-01 set the policy: a SITL with built-in
physics is refused; only verified source commits connect; the SITL's
parameters are read, never written, and every difference is a reason to
refuse; a connection is recorded as experiment payload schema 2, which is
schema 3 since TASK-163, schema 4 since TASK-165, schema 5 since TASK-172 and
schema 6 since TASK-169.

### Launcher API

`POST /v1/connections` takes the connection descriptor:

```json
{ "jsonPhysicsPort": 9002, "mavlink": { "transport": "tcp", "port": 5760 } }
```

`jsonPhysicsPort` is the UDP port SITL sends JSON servo packets to
(`--sim-port-out`, 9002 + 10·instance by default), which the bridge binds.
MAVLink is either SITL's TCP server (`tcp`, SERIAL0 on 5760 + 10·instance by
default), to which `MavlinkTcpRelay` connects and whose byte stream it passes
to the bridge in datagrams of at most 2048 bytes, or a UDP port SITL or
MAVProxy sends to (`udp`), which `MavlinkRelay` binds and whose source port
it learns. A port that cannot be used is refused with 409 and a reason
(nothing accepts the TCP connection, the JSON or UDP port is in use), and a
refused connection leaves nothing open and nothing registered. One experiment
run or one open connection exists at a time. The view
(`GET /v1/connections/{id}`) is:

| Field | Content |
|---|---|
| id | the connection ID, in the format of experiment IDs |
| ownership | `external` |
| state | `open`; `sitl-closed` when SITL ended its TCP connection; `disconnected` after `POST /v1/connections/{id}/disconnect` |
| closedReason | why SITL's side ended, or null |
| endpoints | the descriptor |
| ports | the bridge port and record epoch (1) while open, else null |
| physics | servo packets received and rejected, foreign senders, and the latest packet's rate and channel count (null before the first) |
| mavlink | bytes received from SITL and datagrams dropped |

The counters stay readable after the connection closes, as its diagnostics.
SITL closing its TCP connection marks the connection `sitl-closed` before its
bridge closes.

### Compatibility

`SessionController.connect` checks, in this order, and refuses with every
reason named (failure kind `incompatible`, restart path fix-first):

| Check | Passes when | Limit |
|---|---|---|
| frame script | the profile needs no frame script, which MirageSITL installs only in a SITL it starts | before connecting |
| JSON physics | JSON servo packets reach the physics port; MAVLink without them means a built-in physics model, which cannot fly the profile and whose clock MirageSITL cannot pause | first packet within 15 s of wall time |
| armed | ArduPilot's first heartbeat (system 1, component 1, autopilot 3) says disarmed | first heartbeat within 60 s of wall time |
| version | `AUTOPILOT_VERSION` (requested with `MAV_CMD_REQUEST_MESSAGE` once per wall second) has a `flight_custom_version` git hash that is the first 8 characters of exactly one verified commit of the pinned catalog | within 10 s of simulated time |
| parameters | the complete PARAM_VALUE list holds every generated frame, output, PWM and sensor parameter at its float32 value, under the catalog's absent rule; the first 12 differences are listed and the rest counted | within 30 s of simulated time |
| home | the first 3D GPS fix lies within 10 m horizontally and 5 m vertically of the session's home | — |

Physics steps at the session's rate, 800 Hz as for Start. The rate in SITL's
first servo packets is only its `SIM_RATE_HZ` default (1200 Hz), since
`SIM_JSON` adopts the step of the physics peer's replies
(`Aircraft::adjust_frame_time` with 1/Δt), so it is shown and not checked.
The clock is then classified as TASK-129 found it: MirageSITL is the JSON
lockstep peer and its replies never set `no_lockstep`, so SITL's simulated
time waits for each reply and Pause (TASK-156) stops it with the physics. A SITL whose clock MirageSITL cannot hold, one with built-in
physics, is refused at the JSON check, and the reason says that its clock
cannot be paused. The panel lists the checks a connection passed.

The ground station now requests the EKF_STATUS_REPORT, GPS_RAW_INT and
GLOBAL_POSITION_INT streams once per wall second until each stream's message
arrives, and again after 2 s of wall time without one, for owned runs too. An
acknowledgement does not prove a stream runs: a link's first send pass sets
every interval from its `SRn_` stream rates (`GCS_MAVLINK::update_send`,
`initialise_message_intervals_from_streamrates`), overwriting an interval
acknowledged before it. A TCP SITL starts its scheduler only when the
launcher connects, so the first requests reach that window; stopping after
the acknowledgements left the connection without GPS, and so without READY.

A SITL connected again keeps its clock: `SIM_JSON` treats the new session's
earlier timestamps as a physics reset and does not reset the autopilot, so
its GPS time leads the new session's physics clock by the time it already
ran. `LiveEkfWarmup` therefore compares GPS time in the session clock in
JSON lockstep, shifted by the autopilot's lead, which GLOBAL_POSITION_INT's
`time_boot_ms` bounds from below (sent at or before the step at which it is
received). The largest bound seen, never below 0, is used, so a wrong time
can only keep the GPS stale; without GLOBAL_POSITION_INT a leading GPS stays
incoherent. A SITL that starts with the session has a lead of 0.

`ParameterReadback.differences()` gives every generated parameter a complete
list does not hold. The git hash identifies the source commit only: a binary
built from a changed working tree reports the same hash, and MirageSITL has
no binary hash of a SITL it did not start.

### States, failures and record

A connection runs the TASK-154 states with ownership `external`: starting
(prepare, launcher, probing, physics, connecting, version), loading
parameters, warming, ready and running. Failures specific to a connection:

| Reason | Text begins | Restart |
|---|---|---|
| incompatible | This SITL cannot be used with this profile, and every reason | restart the SITL as the reasons say, then Connect again |
| sitl-silent | The SITL sent no heartbeat for 10 s; MirageSITL disconnected | Connect again |

`sitl-ended` carries the launcher's `closedReason` when SITL closed its TCP
connection; a launcher refusal of the ports asks the user to check the SITL
and its ports. Heartbeat silence is measured in wall time, so TASK-156
suspends it while paused. Diagnostics name the connection and the launcher's
counters instead of process logs.

The record is written once every check has passed, when the home check
completes during warming, and READY waits for it. Its `sitl` is:

| Field | Content |
|---|---|
| ownership | `external` |
| connectionId | the launcher connection ID |
| ardupilot | `commit` (the verified commit), `gitHash` (its first 8 characters, as reported) and `firmwareVersion` (`flight_sw_version` as text, for example `4.7.2`) |
| endpoints | the connection descriptor |

`session.speedup` is null, because SITL's own command line set it, and
`frameScript` is null. The record name is `<profile> connection <id>`.

### Verification (TASK-155)

`tests/launcher-connections.test.ts` checks refusals that leave nothing open,
both MAVLink transports and the servo packets through the bridge, disconnect,
SITL closing its TCP connection, and three connect and disconnect cycles
against the pinned ArduCopter that leave its process running.
`tests/run-controller.test.ts` drives every check, refusal and failure of a
connection on scripted ports; `tests/experiment-record.test.ts` covers schema
2, the external variant and schema 1 reads; `tests/autopilot-version.test.ts`
checks the version decoder against the pymavlink goldens of message 148,
which the codec now supports (`scripts/generate-mavlink-fixtures.py`);
`tests/sitl-bridge-client.test.ts` admits READY with an autopilot clock 120 s
ahead only when GLOBAL_POSITION_INT bounds the lead.
`tests/browser/manual-connect.spec.ts` starts the installed ArduCopter as a
user would and, through the Run tab alone, connects and disconnects twice to
READY, refuses a SITL with built-in physics and one whose parameters differ,
and finds each process still running afterwards.

## Flight view in the Run tab (TASK-185)

With the ArduPilot SITL backend, the Run tab shows the chosen aircraft
profile in 3D from the moment the profile is chosen, and flies it at the
physics session's pose during a run (S17). `apps/web/src/run/FlightView.tsx`
draws the aircraft from the TASK-138 layout of the stored profile version
with the Aircraft tab's own parts (`Rotor` and `Strut` of
`AircraftScheme3D.tsx`, sized by `schemeDimensions`): the body with its
forward cone, a strut to each arm's mean hub, and per rotor its motor number,
a disc coloured by spin with a turning arrow, and its thrust axis. Each disc
also carries a blade that turns about the thrust axis at a display rate that
follows the motor's speed from power telemetry v1 (rows in the manifest's
rotor order, which is the layout's motor order), capped at 4π rad/s at
12,000 rev/min so that a 60 Hz display never shows it turning backwards.

The scene reads the session only: each frame interpolates the pose between
adjacent ticks of one epoch (`interpolatePoseInto`) and places the aircraft
group, with no change to the physics. The views are:

| View | Camera |
|---|---|
| External | follows the aircraft from behind, right and above, at an offset scaled to its span |
| Onboard | TASK-067's `FpvCamera` at the front of the drawn body, looking along body forward, with a plain 90° lens: no fisheye and no analog effects |

The trajectory keeps one sample per 0.1 s of simulated time for 120 s in a
preallocated ring (`TrailBuffer`), restarted on a new session epoch; the
route and its points are drawn when a flight task provides one (TASK-172),
and the view says when none is loaded. The ground is the synthetic level pad
and is labelled so; real terrain is TASK-186. Beside the view, the flight
panel shows altitude above the pad, ground and vertical speed, roll, pitch
and heading of the session's truth, and the TASK-146 power panel shows the
battery and each motor's speed, current, power and command; both refresh
every 250 ms, never per physics step.

A probe reports, every 20 frames and only on change, the drawn rotors in the
aircraft's own frame, the aircraft's position, the trail and route counts
and the renderer's geometries, textures and programs, which the browser
tests read.

### Verification (TASK-185)

`tests/browser/flight-view.spec.ts` compares the drawn rotors of all five
S19 configurations with their layouts mapped to render axes in the test
(position and thrust axis within 1e-6 m, motor number and spin), and switches
between the external and onboard views 20 times, and away from the Run tab
and back, with the renderer's geometries, textures and programs unchanged.
`tests/browser/external-sitl.spec.ts` checks during the real ArduCopter hover
that the drawn aircraft is at the session's altitude, the trail holds the
climb and the hover, every motor shows its speed and the pack supplies
current, and the onboard view switches in flight.
`tests/flight-view-geometry.test.ts` covers the trail ring, the cameras, the
blade rate and the flight values. `tests/browser/flight-view-frames.spec.ts`
(opt-in, `MIRAGE_FRAME_TIME=1`) measures frame times against A-06 in visible
full-screen Google Chrome on the real GPU during a SITL hover: 60 s of the
external view and 30 s of the onboard view after 5 s of warmup each, the
intervals between `requestAnimationFrame` callbacks, which Chrome paces to
the display. On macOS it passes, per the A-06 amendment of 2026-11-01, with
the median at most 16.680 ms and no interval above 25 ms, and reports the
p99; elsewhere the median and p99 limits apply. On 2026-11-01, Google Chrome
156.0.8078.80 on the M5 (Mac17,4, Apple M5 with 10 GPU cores, built-in
display 1710 x 1107 points at 2x and 60 Hz, window filling the screen)
measured 3,601 external-view intervals (median 16.665 ms, p95 17.660 ms, p99
17.670 ms, maximum 17.680 ms) and 1,801 onboard-view intervals (median
16.665 ms, p99 17.670 ms, maximum 17.675 ms): 60 frames per second with no
skipped frame.

## Motor check before flight (TASK-157)

Before take-off, the Run tab's motor check asks ArduPilot to spin each frame
motor alone and shows which physics rotor turned. ArduCopter's own motor test
(`MAV_CMD_DO_MOTOR_TEST`, `ArduCopter/motor_test.cpp` at V4.7.2) spins the
motor whose test order is requested (`AP_MotorsMatrix::output_test_seq`):
`GroundStation.motorTestInto` sends the test order, throttle type 1 (a PWM
value, which ArduCopter accepts without the RC calibration check), 1150 us
(15 % of the 1000-2000 us range), a 1.5 s timeout and a count of 1.

`MotorCheck` (`packages/autopilot/src/motor-test.ts`) compares, motor by
motor in test order:

| | Expected (ArduPilot's frame) | Observed (the physics as it runs) |
|---|---|---|
| Motor | the profile motor with that test order in the TASK-142 frame configuration | the rotor whose speed rose |
| Output | that motor's servo output | the output that drives that rotor in the manifest the session runs |
| Spin | the sign of its ArduPilot yaw factor (positive is counter-clockwise) | that rotor's spin in the model |

Speeds come from power telemetry v1, rows in the manifest's rotor order, and
are judged from 0.5 s after ArduPilot's acknowledgement to the end of the
spin; the next motor waits 1.5 s more for the last one to stop, all in
simulated time. A rotor turned when its peak reached 300 rev/min and at least
half of the step's largest peak. A motor passes when exactly the expected
rotor turned with the expected spin; otherwise the result names what turned:
no motor, several motors, "the motor mapping is swapped" or "the spin is
reversed". A refusal by ArduPilot (with its last status text) or no
acknowledgement within 3 s stops the check.

`SessionController.checkMotors` starts it only while warming or READY,
disarmed and below 0.3 m, and refuses otherwise with the reason; Take off
waits until it ends. The Run tab's motor-check panel shows the progress and,
per test, the expected and the turned motor, output and spin with pass or
fail, and the flight view rings the fastest turning rotor in its spin colour.

### Verification (TASK-157)

`tests/motor-check-sitl.test.ts` runs the installed native ArduCopter against
the physics session in Node: every motor of all five S19 configurations
passes (4, 6, 8, 8 and 16 motors, the 16-motor octa with its scripting
frame). Faults are injected in the model the physics runs while ArduPilot
keeps the profile's frame: motors 1 and 2 on each other's outputs fail on
exactly those two motors ("the motor mapping is swapped"), and motor 3 with
its spin reversed fails on exactly that motor ("the spin is reversed").
Swapping channels inside the JSON link would not inject a fault, because the
link reads a channel and writes the same actuator slot.
`tests/motor-test.test.ts` covers the expectation from the frame catalog, the
judgement cases, refusals and the command's encoding;
`tests/run-controller.test.ts` the controller's sequence and refusals; and
`tests/browser/motor-test.spec.ts`, through the Run tab with the installed
ArduCopter, the check before flight (motors 1, 4, 2 and 3 ringed in turn,
all passing) and no check in flight.

## ArduPilot parameter service (TASK-159)

`ParameterService` (`packages/autopilot/src/param-service.ts`) is the cold-path
parameter client of an integrated session: it downloads the autopilot's
complete parameter list, writes parameters and classifies every write by
read-back. It follows ArduPilot's handlers at V4.7.2
(`libraries/GCS_MAVLink/GCS_Param.cpp`) and sends through the session's
`GroundStation`, so its frames share the ground station's MAVLink sequence.
`GroundStation.paramSetInto(name, value, paramType)` packs PARAM_SET (23) with
the float32 value and the MAV_PARAM_TYPE the autopilot reported, and
`paramRequestReadIndexInto(index)` packs PARAM_REQUEST_READ (20) with an empty
name and `param_index` 0 to 32767.

Every timeout runs on a clock the caller passes in seconds, normally the
SITL's simulated time. A paused lockstep SITL answers nothing and its time
stands (TASK-129), so a pause neither retries nor times out a request.

### List download

`requestList(nowS)` sends PARAM_REQUEST_LIST. ArduPilot streams every
parameter as PARAM_VALUE with its index and `param_count`, and ignores the
request until its parameters are ready. Values are the float32 numbers of the
wire, stored exactly; a PARAM_VALUE with an empty name or a non-finite value
(an index read past the list) is not stored. A PARAM_VALUE from another system
or component is ignored.

| Situation | Action |
|---|---|
| No PARAM_VALUE for `listRetryS` (2 s) after a list request | resend the request, at most `maxListRequests` (5) times; then `failed` |
| `param_count` known, no new index for `gapS` (1 s) | read the first `indexBatch` (20) missing indices by index; after `maxGapRounds` (5) rounds without a new index, `failed` with the missing indices |
| `param_count` changes during the download | restart: the indices received so far are dropped and the list is requested again; list entries still carrying the replaced count are ignored, because ArduPilot fixed that count when the replaced stream began |
| `param_count` changes after the download completed | `stale` is true: the autopilot renumbered its list, for example after an `*_ENABLE` write; download again |
| every index below `param_count` received | `complete` |

A download state is `idle`, `downloading` (received, total or null),
`complete` (total) or `failed` (received, total, missing indices, reason).

### Writes and their states

`set(name, value, nowS)` sends PARAM_SET followed by PARAM_REQUEST_READ of the
same name. ArduPilot answers PARAM_SET with the stored value outside the list
(`param_index` 65535). It answers a parameter the ground station may not write
(`allow_set_via_mavlink`: read-only, or `AP_PARAM_FLAG_INTERNAL_USE_ONLY` such
as `BARO1_DEVID`) with its old value. It answers an unknown name only with
PARAM_ERROR, which is outside the TASK-150 message set.

| State | Meaning |
|---|---|
| `requested` | PARAM_SET sent; `attempts` sends so far |
| `confirmed` | an answer outside the list holds the requested float32; `rebootRequired` and `outsideRange` come from the metadata, null without metadata for the commit |
| `refused` by `service` | not sent: the name is not in the downloaded list, the run's ownership matrix forbids the write (TASK-089, "Live writes"), the value is not finite, the value is outside the float32 range, the parameter's integer type cannot carry it exactly (not an integer, outside the type's limits, or not exact in float32), or its type is not one PARAM_SET's float32 carries |
| `refused` by `autopilot` | answers kept another value: after the first differing answer one more read is sent, and the write is refused when the latest answer still differs after `writeRetryS` (1 s) without an answer; `reported` holds that value |
| `timeout` | no answer after `writeAttempts` (3) sends, `writeRetryS` apart |
| `stale` | the outcome no longer describes the autopilot: a newer write of the same name replaced a pending write or was confirmed after a confirmed one, or the autopilot still reports another value for a confirmed one after one more read and `writeRetryS` without an answer |

Answers inside the list never decide a write. A differing answer alone never
refuses one, because an answer sent before ArduPilot handled the write, or to
a write it replaced, can still be in flight. For the same reason one differing
answer never makes a confirmed write stale: ArduPilot answers a read by name
from a queue, so the answer to a read sent before a write can arrive after the
write's confirmation. TASK-160 saw this when a paused SITL resumed with two
writes of one parameter waiting. `rebootPending()` lists the names
whose current confirmed write needs a reboot according to the metadata.
ArduPilot does not enforce declared ranges, and neither does the service:
`outsideRange` reports a confirmed value outside the declared range.

### Value display

`formatParameterValue(value)` returns the shortest decimal (1 to 9
significant digits) that parses back to exactly the same float32. For
example, `Math.fround(0.00017)` is shown as `0.00017`, never `0.00`, and -0
keeps its sign. `parseParameterValue(text)` accepts one finite decimal number
and returns its float32, or null.

### Metadata

`scripts/generate-param-metadata.mjs` runs ArduPilot's own
`Tools/autotest/param_metadata/param_parse.py --vehicle ArduCopter --format
json` in a temporary directory on a clean checkout at a commit of
`scripts/sitl.lock.json` (its Python needs `lxml`, which the TASK-127
environment has). It writes `data/ardupilot/param-metadata.json` (schema 1):
`versions` holds one entry per supported commit with the vehicle, the
parameter count, the SHA-256 of the upstream output and of the four generator
files, the anomalies and one record per parameter. A record keeps `group`,
`displayName`, `description` and, when the source declares them, `units`,
`range` ([low, high]), `increment`, `values` and `bitmask` ([number, label]
pairs, ascending), and the flags `rebootRequired`, `readOnly` and `volatile`,
plus the user level. The upstream fields `path` and `Calibration` are dropped. An
upstream field the generator does not know fails the run. A reversed range is
left out of its record and listed under `anomalies`; at V4.7.2 that is
`TA_GSP_AIRBRAKE`. The file is written one parameter per line, and
`--check` regenerates it and exits 1 on any difference.

`parseParameterMetadata` (`packages/autopilot/src/param-metadata.ts`)
validates the file from `unknown`. `forCommit(commit)` returns the metadata
of exactly that commit or null; the metadata of another commit is never
substituted. The file is GPL-3.0-or-later text generated from the ArduPilot
source (`config/offline-inventory.json`, row `ardupilot-parameter-metadata`).

### Verification (TASK-159)

`tests/param-service.test.ts` runs the service against a scripted autopilot
that answers as the pinned handlers do. It covers the list download with the
autopilot not ready, lost entries recovered by index and the failure that
names the missing indices, the restart on a new count with the replaced
stream's entries dropped, the stale list, each write state, and no timeout
while the clock stands. It also checks float32 formatting over 1,000,000
sampled bit patterns. The PARAM_SET and index-read frames are decoded by
pymavlink 2.4.50. Further tests cover the metadata facts read from the
pinned source, the validator's refusals and the generator's conversion. It
also checks byte-for-byte regeneration from the TASK-127 checkout.

`scripts/check-param-sitl.mjs` runs the service against the installed native
ArduCopter, holding the vehicle at rest in JSON lockstep. It writes
`test-results/validation/param-sitl.json`, whose judge `assessParamRun`
rejects false evidence (`tests/integration/param-sitl.test.ts`); without an
installed, verified firmware it exits 2 (`BLOCKED_EXTERNAL`).

## Parameters tab (TASK-160)

The Parameters tab shows and writes the parameters of the SITL that the Run
tab's current run talks to, through the TASK-159 parameter service. The Run
tab attaches each new session to a `SessionLink`
(`apps/web/src/run/session-link.ts`), which the shell shares with the
Parameters tab.

### Loading and writing

When a run loads its parameters, the session controller creates the run's
`ParameterService` with the metadata of the SITL's exact source commit (the
catalog commit of a launcher-owned run, the verified commit of a
connection) and downloads the complete list with it; the start's read-back
(TASK-154) reads the same PARAM_VALUE stream. The service resends
PARAM_REQUEST_LIST every 2 s of simulated time while nothing answers, at most
15 times, and reads missing entries by index. When that recovery fails before
the start's 30 s deadline, the list is requested again. Every PARAM_VALUE goes
to the service, and every Worker status of an open bridge ticks it on the
SITL's simulated time.

The browser fetches `data/ardupilot/param-metadata.json` as a separate asset
when the first run starts (`apps/web/src/params/metadata.ts`). Without it a
run shows its parameters without restart, range and description facts, and a
confirmed write says that whether it needs a restart is not known.

`setParameter(name, value)` writes a finite float32. It is refused with its
reason, and without a change entry, in these cases:

| Situation | Refusal |
|---|---|
| no run has loaded its parameters | No run has loaded its parameters |
| a SITL that MirageSITL did not start (TASK-155) | MirageSITL writes nothing to it (decision of 2026-11-01), so its parameters are shown read-only |
| the run is not warming, READY, flying or paused | Parameters can be written once the run has loaded them, until it stops |
| the bridge is not open | The bridge to SITL is not open |
| the list is not complete, or the autopilot renumbered it | Download the list (again) first |

Otherwise the service writes it, and a refusal by the service is a change
like any other.

Writes are possible in flight and while paused. ArduPilot V4.7.2's
PARAM_SET handler (`GCS_Param.cpp`, `handle_param_set`) refuses nothing
because the vehicle is armed, so no change needs a disarm. A paused lockstep
SITL answers after Resume and its simulated time stands (TASK-129), so a
write sent while paused stays `requested` and is neither resent nor timed
out; a newer write of the same parameter makes it `stale`.

### Parameter change

```typescript
interface ParameterChange {
  writeId: number;          // the parameter service's write ID, unique in the run
  name: string;
  oldValue: number | null;  // what the autopilot reported before the write
  newValue: number;         // the requested float32
  requestedAt: string;      // wall time of the request, UTC
  tick: number;             // session tick and simulated time when it was sent
  simTimeS: number;
  experimentId: string;     // launcher experiment or connection ID
  whilePaused: boolean;
  outcome: WriteState;      // the write's latest state (TASK-159)
}
```

The tab words each outcome as follows:

| Outcome | Shown as |
|---|---|
| `requested` | waiting for ArduPilot's answer; sent while paused, a paused SITL answers after Resume |
| `confirmed`, `rebootRequired` true | Stored, not applied: ArduPilot uses it only after SITL restarts |
| `confirmed`, `rebootRequired` false | Confirmed and applied |
| `confirmed` without metadata | Confirmed; whether it needs a restart is not known |
| `refused` | Refused before sending (by the service) or Refused by ArduPilot, with the reason |
| `timeout` | No answer from ArduPilot after its sends |
| `stale` | No longer current, with the reason |

A confirmed value outside its declared range says so. A restart-required
change is never called applied, and the tab lists the confirmed values that
wait for a restart.

### Records

TASK-160 adds two record kinds to schema v1 of the project store, after
`experiment`; each may depend only on an experiment.

`parameter-log` is one item per run, with a new version whenever a change of
the run is made or settles. Each version holds every change so far with its
latest outcome (`ParameterLogWriter`), so the history persists with the
experiment record it depends on and travels in the project archive.

```typescript
interface ParameterLog {
  schemaVersion: 1;
  experimentId: string;
  experimentSha256: string;   // the run's experiment record, its dependency
  changes: ParameterChange[]; // 1..2000, in write order
}
```

`parameter-set` holds the values the running SITL reports when it is saved,
sorted by name, with the run they come from. Saving again under the same item
creates a new version.

```typescript
interface ParameterSet {
  schemaVersion: 1;
  source: { kind: "run"; experimentId: string; experimentSha256: string; firmwareCommit: string; tick: number; simTimeS: number };
  parameters: { name: string; value: number }[]; // 1..8192 float32 values, sorted by name, unique
}
```

`validateParameterSet` and `validateParameterLog`
(`apps/web/src/params/parameter-sets.ts`) validate both payloads from
`unknown`; the shell registers them as the kinds' payload validators.

### Comparison and restore

A set is compared with the running SITL or with another set: the comparison
lists, by name, every parameter whose value differs or that only one side
holds. Sending a set back writes only the parameters whose live value
differs. It skips, with the reason, a parameter the running SITL does not
list and one that ArduPilot's metadata marks read-only (such as `BARO1_DEVID`
or the `STAT_` counters) or as changed by the autopilot itself (volatile).
Parameters the set does not hold are left alone. Each write is a change in
the history, from which a change's old value can also be sent back.

### Verification (TASK-160)

`tests/run-controller.test.ts` drives the controller on scripted ports: the
download, a write in flight confirmed and logged with its old value, wall
time and tick, a restart-required write, refusals by the service and by the
autopilot, a write nobody answers (timeout), a write while paused that is
neither resent nor timed out and is made stale by a newer one, which is
confirmed after Resume, and the refusals before the list is loaded, while it
is renumbered (then downloaded again), for a connection and after the run
stops. `tests/parameter-sets.test.ts` covers both payloads, their records and
dependencies in the store, and comparison and restore with the pinned
metadata. `tests/browser/parameters-tab.spec.ts` runs the tab against native
ArduCopter V4.7.2 (the TASK-152 installation): every write state except the
timeout, which a real ArduPilot does not produce for a listed parameter, a
write in flight and while paused, a set compared and sent back, an old value
sent back from the history, and the history after a reload.

## Parameter file export (TASK-161)

The Parameters tab exports an ArduPilot parameter file for the user to load
by hand into a ground station or SITL. MirageSITL never writes such a file
to a flight controller.

### File format

`formatParamFile` (`packages/autopilot/src/param-file.ts`) writes `#`
comment lines with the context, then one `NAME,VALUE` line per parameter,
sorted by name. Each value is the shortest decimal that reads back to
exactly its float32 (`formatParameterValue`, TASK-159), so ArduPilot's own
loader gets the same float32: at V4.7.2, `AP_Param::parse_param_line`
skips `#` lines and splits a line on `,`, space, `=` and tab. A name that
loader cannot read, a duplicate, or a value that is not a finite float32
refuses the export. The header names:

| Line | Content |
|---|---|
| purpose | an ArduPilot parameter file exported by MirageSITL for loading by hand, never written to a flight controller |
| `Exported` | UTC time |
| `Values` | where the values come from |
| `Selection` | which parameters |
| `Aircraft profile` | name, version and SHA-256 of the profile version, or none |
| `ArduPilot` | firmware version and source commit, or not known |
| `Experiment` | launcher experiment or connection ID and its record's SHA-256, or none |
| `Parameters` | the number of lines that follow |

`parseParamFile` reads such a file as the ArduPilot loader does, but it
throws with the line number of the first line it cannot read, of a
duplicate, or of a value that is not a finite float32.

### Sources and selections

| Source | Values | Shown as |
|---|---|---|
| the running SITL | the TASK-159 read-back: only values ArduPilot reported | SITL read-back; a parameter with a write still pending says so and the file holds ArduPilot's confirmed value |
| an experiment record | the parameters MirageSITL generated from its saved profile at the start, as ArduPilot's float32 | Experiment record, generated from the saved profile (frame, output, PWM or sensor) |
| a parameter set (TASK-160) | the set's values, read back from the run it names | Parameter set |

The preview also marks a value that ArduPilot's metadata calls read-only or
volatile. The context comes from the experiment record behind the values:
the running SITL's, the record itself, or the run a set was read from.

| Selection | Parameters exported |
|---|---|
| all | every value of the source |
| changes | every value that differs from a chosen parameter set's, or that the set does not hold |
| chosen | the named parameters and every parameter of the named groups; a group is a name up to its first underscore (RTL_ALT_M is in RTL, GPS1_DELAY_MS in GPS1) |

A pending write never enters the file, because the running SITL's values
are only those ArduPilot reported.

### Simulator settings

Settings that only the simulator uses are saved separately as a project
archive: `ProjectStore.exportItems(projectId, roots)` writes the project
record and the items holding `roots` with their whole dependency closure,
each with its whole history, so the archive imports like a full one. The
Parameters tab exports the aircraft profile version of the values' record
with its component cards and measurement sets. Weather and location
settings come with TASK-148 and TASK-167.

### Verification (TASK-161)

`tests/param-file.test.ts` checks the header and line format, the refusals,
200,000 sampled float32 bit patterns read back exactly, ArduPilot's
separators, and pymavlink 2.4.50's `MAVParmDict.load` reading 5,000 exported
values bit for bit (where the TASK-152 Python environment exists). It also
checks the three selections against hand-written oracles, and a subset
archive with two profile versions whose dependencies differ: it imports into
an empty store with nothing missing and holds no unrelated item.

`scripts/check-param-file-sitl.mjs` runs two native ArduCopter SITLs at rest
in lockstep. SITL A confirms four writes and its complete list is exported;
SITL B starts in an empty directory from `copter.parm` followed by the
exported file (`--defaults`), so ArduPilot's own loader reads it. Every
exported value must read back as the same float32, except the parameters
ArduPilot's metadata marks read-only or volatile, which the autopilot sets
itself. That rule was fixed before the first run, and those values are only
reported. The report is `test-results/validation/param-file-sitl.json`, and
`tests/integration/param-file-sitl.test.ts` checks that its judge rejects
false evidence. `tests/browser/parameter-export.spec.ts` exports from the
Parameters tab against native ArduCopter: all parameters with a write
pending while paused, the chosen parameters and groups and the changes
against a stored set (each checked against an oracle from the
all-parameters file), an experiment record's generated parameters, and the
simulator settings.

## Run speed (TASK-175)

In JSON lockstep every physics step answers one SITL frame, so a real-time
run and an accelerated run take the same step sequence. Only ArduPilot's own
`--speedup` pacing differs, and acceleration is limited by the host, never
reached by skipping steps or simplifying the model.

### Modes

| Run tab choice | `--speedup` | Mode |
|---|---|---|
| Real time | 1 | `real-time` |
| Accelerated, at most 2× or 4× | 2 or 4 | `capped` |
| As fast as possible | 100, the launcher's largest, which no host reaches | `as-fast-as-possible` |
| a SITL the user started (TASK-155) | its own command line | `external` |

No acceleration factor is promised: the Run tab shows the speed the host
reached.

### Measurement

`RunSpeedMeter` (`apps/web/src/run/run-speed.ts`) takes one sample per Worker
status of an open bridge: the controller's wall time and the session's
simulated time. Paused wall time (TASK-156) is not running time. The meter
reports:

| Value | Meaning |
|---|---|
| `windowSpeed` | simulated over running wall time over the last 5 s |
| `averageSpeed` | the same over the whole run |
| `intervals`, `dropped` | completed 1 s intervals of running wall time; for a real-time run, every interval that advanced less than 0.99 s of simulated time, with its start and its advance |
| `realTime` | for a real-time run with a completed interval, whether it averages at least 0.99 (decision A-05); null otherwise |
| `startup` | SITL's start-up before the autopilot's first heartbeat: its simulated and wall time |

Interval boundaries are interpolated between samples, and running wall time
is summed in milliseconds from the clock's own differences, so intervals
close at exact boundaries. The run is judged from the autopilot's first
heartbeat. Before it SITL boots: on the reference Mac that took about 10 s
of wall time for 2 s of simulated time when it was counted as part of the
run, so every real-time run would have read as behind real time. The start-up
is measured and shown on its own, never folded into the verdict or hidden.
A real-time run is called real time only while it averages at least 0.99;
otherwise it says that it is behind, with its average. Every dropped interval
is listed. An accelerated run reports the speed it reached and is never
judged against real time.

### Verification (TASK-175)

`tests/run-speed.test.ts` checks the meter against hand-computed ratios: a
steady real-time run, a stalled second as a dropped interval, interpolated
boundaries, paused time left out, start-up kept apart, and the window
against the average. On a real `PhysicsSessionV2` in sitl-lockstep with the
quad profile, it also checks that the same servo frames delivered at real
time and at 25 times that pace give byte-identical state lines: 1106 frames
until the climb without an autopilot tips the quad and two propellers
strike, on the same tick at both paces, with the same accident reports. That
tolerance, identical bytes, was declared before the test.
`tests/browser/run-speed.spec.ts` runs native ArduCopter V4.7.2 through the
Run tab in real time and as fast as possible. The tolerances were declared
before the test: the speed the panel reports over an interval agrees with
the test's own measurement of simulated over wall time over the same 20 s
within 5 %, and the two runs' recorded
truth trajectories over their first 20 s of simulated time are identical row
for row.

## Manual flight with a controller (TASK-174)

The Run tab flies an integrated run with the USB controller calibrated in
the radio panel (TASK-038), through the `GamepadAdapter` and its
calibration.

### Taking and releasing control

`takeManual(mode)` takes manual control in altitude hold, loiter or
stabilize:

| Where | Conditions | What MirageSITL does |
|---|---|---|
| on the ground at READY, disarmed | the controller is connected and valid, throttle at most 5 % (the TASK-038 rearm rule) | sets the mode, then arms once the heartbeat reports it; an arm request waits while the throttle is up |
| in flight, armed in GUIDED (climbing or flying) | the controller is connected and valid; altitude hold or loiter only, which hold with the throttle centred | sets the mode |

The controller's sticks then go to ArduPilot as RC_CHANNELS_OVERRIDE at
`MANUAL_RATE_HZ` (25 Hz), mapped by `PilotRcMapper`. MirageSITL commands the
mode itself, so the mode channel carries the ignore sentinel. Releasing
control sends the release sentinels and, while armed, sets GUIDED, where
ArduPilot holds position. A landing that ArduPilot disarms ends manual
control, and the run is READY again.

### Losing the controller

By the user's decision of 2026-11-03, losing the controller in flight
**pauses** the run through the TASK-156 path, with pause reason
`controller`:

| Cause | Detected by |
|---|---|
| unplugged, invalid axes or a different device (a new `GamepadAdapter` generation) | the session controller, at each 40 ms period |
| no stick command for `INPUT_TIMEOUT_MS` (250 ms, the existing input timeout), for example a stalled page | the physics Worker's watchdog, before it steps the next SITL frame |

The watchdog runs in the Worker because a stalled main thread cannot notice
its own silence. ArduPilot would otherwise go on applying the last override
for its RC_OVERRIDE_TIME. `SitlBridgeClient.setManual(true)` arms it, each
RC_CHANNELS_OVERRIDE that Main sends refreshes it, and only a real resume,
not the running state reported after every pump, restarts its interval. When
it fires, the session pauses before the frame (`holdForInput`, as after an
accident), so thrust is never held on stale input. The Worker posts
`sitl.input-stale` with the simulated time and the silence.

A run paused for its controller resumes only once a controller is connected.
If it is the same device that never left (a stall), manual control goes on.
A controller that was unplugged and plugged back in, or swapped, counts as a
new device (TASK-038) and never takes over silently: Resume releases manual
control, ArduPilot holds position in GUIDED, and the user may take manual
control again.

### Verification (TASK-174)

`tests/run-controller.test.ts` drives the controller on scripted ports with a
scripted controller: refusals, mode and arm with the throttle down,
overrides at 25 Hz with their PWM, an unplug that pauses and a Resume that
waits for the controller, a swap whose Resume releases to GUIDED with the
release sentinels, the Worker's stale-input pause, a landing that ends manual
control, and an in-flight takeover. `tests/sitl-bridge-client.test.ts`
checks the watchdog on a real session: overrides every 40 ms keep the frames
stepping, 250 ms of silence is still fresh, and 1 ms more pauses the session
before the frame, unanswered, while the running state reported after a pump
never refreshes it. `tests/browser/manual-flight.spec.ts` flies native
ArduCopter V4.7.2 with a mocked controller through the Run tab.

## Flight tasks (TASK-172)

A flight task says what ArduPilot should fly, from what initial conditions and
how it ends (S10). ArduPilot receives the commands, and the physics computes
the motion; nothing moves the aircraft but the motors ArduPilot drives. Mass
and payload belong to the aircraft profile.

### Task definition v1

`packages/scenarios/src/flight-tasks.ts` defines the definition, and
`flightTaskProblems` gives every reason a value is not one:

```typescript
interface FlightTaskDefinition {
  schemaVersion: 1 | 2;   // 2 for a tuning maneuver, 1 for every other type
  type: "takeoff" | "hover" | "landing" | "straight" | "climb" | "descent" | "acceleration" | "braking" | "turn" | "route"
    | "roll-step" | "roll-doublet" | "pitch-step" | "pitch-doublet" | "heading-step" | "heading-doublet" | "altitude-step" | "altitude-doublet";
  parameters: Record<string, number>;   // the type's own numbers; empty for a route
  route: { northM: number; eastM: number; altitudeM: number; speedMps: number }[] | null;   // 2 to 50 points; null unless a route
  initial: {
    ground: { northM: number; eastM: number; headingDeg: number; stateOfCharge: number };
    air: { altitudeM: number; headingDeg: number; speedMps: number } | null;   // always null for a route
  };
  finish: "land" | "hold";   // a landing task always lands
}
```

| Type | Parameters, with their limits |
|---|---|
| takeoff, landing | altitude 1–100 m |
| hover | altitude, duration 1–3600 s |
| straight | altitude, heading 0–360°, speed 0.5–20 m/s, distance 1–5000 m |
| climb, descent | from and to altitude, rate 0.1–5 m/s |
| acceleration, braking | altitude, heading, from and to speed 0–20 m/s, rate 0.1–5 m/s² |
| turn | altitude, heading, speed, angle ±1080° (clockwise positive), rate 1–90 °/s |
| route | its points: north and east ±5000 m, altitude, speed |
| roll-step, roll-doublet, pitch-step, pitch-doublet | altitude, heading, amplitude ±30°, hold 0.5–10 s |
| heading-step | altitude, heading, amplitude ±170°, hold 0.5–60 s |
| heading-doublet | altitude, heading, amplitude ±85°, hold 0.5–60 s |
| altitude-step, altitude-doublet | altitude, amplitude ±50 m, hold 0.5–60 s; every altitude it reaches stays within 1–100 m |

Altitudes are metres above the pad, as the Run tab shows them; north and east
are metres from the pad, in the session's frame; headings are degrees from
north, clockwise. A task is a versioned `flight-task` item of the project
store, with no dependencies, and `parseFlightTask` is its registered payload
validator. Schema 2 adds the tuning maneuvers (see "Tuning maneuvers"). A task of
an earlier type stays schema 1, byte for byte, so its stored versions and their
SHA-256 do not change, and a definition whose version does not match its type is
refused.

### Initial conditions

Ground values are in the physics at the first step: `ground.register` gives the
Worker the values before `model.load`, bound to the manifest's SHA-256, and
`buildProfileDynamics` places the vehicle (`initialGround`) with its battery
(`initialStateOfCharge`). By the user's decision of 2026-11-04 an airborne
start is a lead-in. ArduPilot needs about 41 s of simulated time to become
READY, so an aircraft placed in the air at the start tick falls before anything
can fly it. ArduPilot takes off and flies to the requested height, heading and
speed instead, and the task's clock starts on arrival, with requested and actual
shown there. Without `initial.air` the lead-in goes to the state the task's own
parameters start from. Roll and pitch cannot be set on their own in the air;
TASK-173 commands them. A route always starts from the ground. A SITL the user
started stands at its own `--home`, so a task whose ground start is away from
the pad cannot fly on a connection, and the Run tab says so.

On the task's clock, an airborne start first flies to the state the task's own
parameters start from: the same height and heading only change speed; another
height or heading stops first, turns at 30 °/s, changes height at 1 m/s and then
reaches the task's speed.

### The compass declination at boot

A vehicle keeps COMPASS_DEC between boots, and a MirageSITL run boots with an
empty memory. Without it ArduPilot sets its first heading before it has a
position, and is wrong by the local declination: 12.8° at the default home, at
5.4 s of simulated time. When GPS arrives the heading swings back, and EKF3 takes
part of that swing for a gyro error: it learned -1.76 °/s by 14 s, and had
unlearned it only to -0.18 °/s at arming. It then holds the heading it believes
while the true heading creeps away, about 2° during the first flight, although
its own heading stays within 0.02° of the one commanded.

A run the launcher starts is therefore given COMPASS_DEC before ArduPilot boots
(`packages/aircraft/src/site-parameters.ts`), interpolated from ArduPilot's own
table as `AP_Declination::get_mag_field_ef` does.
`scripts/generate-declination.mjs` generates `data/ardupilot/declination.json`
from the pinned source. COMPASS_AUTODEC stays on, and ArduPilot arrives at the
same value once it knows where it is, so a run does not read this one back. The
record holds it with source `site`, `createExperimentRecord` requires the value of
the record's home, and comparing two experiments counts it as the home, so a
record from before it can still be repeated. A parameter export leaves it out:
where a run started is no part of the profile. A connection cannot set it, since
its SITL is already running.

### The runner

`planFlightTask` turns a definition into stages, each measured (the task, on its
clock) or not (the lead-in, the stop and the landing). `FlightTaskRunner` is a
pure stage machine: `observe` takes the session's truth and the autopilot's mode,
arming and mission reports, and returns the commands to send and what is
requested at that moment. A stage's completion tolerances are operational,
declared before the first flight, and do not judge fidelity (SA-01):

| Stage ends | When |
|---|---|
| take-off or vertical | within 0.5 m of its altitude, vertical speed below 0.3 m/s, held for 2 s of simulated time |
| heading | its turn done, within 5° |
| speed | its change done, within 0.5 m/s, held for 2 s |
| turn | its turn done, within 5° of the final heading, held for 2 s |
| route leg | on ArduPilot's own MISSION_ITEM_REACHED |
| maneuver | at the end of its timeline, whatever the response did |
| recover | its stop done, ground speed below 0.5 m/s, held for 2 s |
| landing | on ArduPilot's disarm |

The 2 s holds count on the task's clock too, so a measured stage's trace shows any
overshoot rather than ending on the moment it first arrived. A stage that takes
60 s of simulated time beyond its plan fails the task, as does the autopilot
disarming or leaving its flight mode.

Every target is one ArduPilot can follow without correcting. A target whose speed
changes in one step is one no aircraft can follow: ArduCopter's position
controller shapes its correction within its own limits, so it falls behind, flies
faster than asked to catch up, because the correction adds to the target's
velocity, and then cannot stop in time. The first flights of this task did that: a
2 m/s climb flew at 4.2 m/s and passed its end by 2.28 m, while the aircraft stayed
within 5 cm of ArduPilot's own plan throughout. `packages/scenarios/src/smooth-motion.ts`
therefore changes each value in the jerk limit's S-shape, within limits the runner
reads from the autopilot's parameter list when the task starts
(`guidanceLimitsOf`); a limit that is missing or unusable refuses the task.

| What changes | Acceleration | Jerk |
|---|---|---|
| height | WP_ACC_Z | PSC_D_JERK |
| speed | the stage's own rate; 2 m/s² in a lead-in or a stop | PSC_NE_JERK |
| heading while flying | the smaller of ATC_ACC_Y_MAX and PSC_NE_JERK divided by the speed | not limited |
| heading at rest, at 30 °/s | ATC_ACC_Y_MAX | not limited |

What is requested is therefore what can be flown, and the trace shows it: with
ArduCopter's defaults a climb at 2 m/s reaches 2 m/s after 2.2 s. A move too short
for its rate peaks lower and still arrives. Each stage starts where the last one
ended, so a moving target does not stall between stages.

Guided stages (`packages/autopilot/src/guided.ts`) send
SET_POSITION_TARGET_LOCAL_NED in MAV_FRAME_LOCAL_NED with `type_mask` 0: the
position, velocity and acceleration of that moment, along a curve the sideways
acceleration of speed times turn rate, and the yaw with its rate. ArduCopter
carries them forward between messages. One goes out at every observation, which on
the Run tab is every 80 physics steps (0.1 s at 800 Hz), well inside
`GUID_TIMEOUT`. ArduPilot's local frame starts where
it was at its first GPS fix, so the commands take the start position and the CG's
rest height off. A route (`packages/autopilot/src/mission.ts`) is a mission: for
each point a DO_CHANGE_SPEED and a NAV_WAYPOINT at a location computed as
`Location::offset` does, uploaded by MISSION_COUNT, each MISSION_REQUEST_INT or
MISSION_REQUEST answered with its MISSION_ITEM_INT, and MISSION_ACK. A route
counts as uploaded only on ArduPilot's acceptance, and a refusal names its
reason. It flies in AUTO after a guided take-off.

### The run

The Flight tasks tab (`apps/web/src/tasks/`) defines and versions tasks and shows
the stages ArduPilot will be asked to fly. The route editor adds, removes and
reorders points; the form's text and a definition convert both ways without
change, percent included, so a stored task reopens unchanged and saving it again
adds no version.

The Run tab chooses a task before the start. `RunPanel` passes it to the
controller as the experiment's `flightTask`, and from READY, `runTask` hands the
flight to the runner, once per Worker status. A run flies its task once, as its
first flight: ArduPilot's frame starts where the run started, and a repeat is a
new experiment. A task that fails, or that the user ends with Land, hands the
flight to ArduPilot's LAND, and the run goes on. Pause holds the task with the
session. The panel shows the stage, the task's clock, requested next to actual,
and the arrival; a value the stage does not request reads "not requested". The
flight view draws a route's line and points.

Each observation becomes an `events.flightTask` row at the latest physics tick,
with the truth signals of the same ticks beside it. Experiment payload schema 5
holds the definition with its record's SHA-256 (see "Experiment record"), and
`createExperimentRecord` requires the definition and name of that stored version.

### Verification (TASK-172)

`tests/flight-tasks.test.ts` checks definitions, the plan, the runner against a
simulated vehicle, the MAVLink packing and upload protocol, and the form's round
trip. `tests/smooth-motion.test.ts` steps the profiles and checks them by
differentiating and integrating numerically, and `tests/site-parameters.test.ts`
checks the declination against the values ArduCopter itself reported at two
places. `tests/profile-dynamics.test.ts` checks the ground start in the dynamics at
400, 800 and 1200 Hz, and `tests/run-controller.test.ts` the controller's flow
against scripted frames. `tests/integration/flight-tasks-sitl.test.ts` flies each
of the ten types, an airborne start, a straight flight and a route from another
place, and a climb and a descent at 5 m/s, with native ArduCopter V4.7.2 through
the launcher's bridge at speed 4 and 800 Hz, observing as the Run tab does and
reading the limits from the autopilot, and writes the traces to an ignored report.
`tests/browser/flight-tasks.spec.ts` round-trips the route editor through a
reload; flies a climb and a braking from the Run tab and measures their gaps from
the recording, with the timing a user's run really has; and flies a stored route
from another place in the application, reading the ground values and the requests
back from the recording, then repeats it.

### Tuning maneuvers (TASK-173)

A maneuver is a flight task of its own type, so it is defined, versioned, flown,
recorded and repeated like any other, and the experiment record holds it. It
commands sudden changes in roll, pitch, heading or altitude and shows how the
aircraft answered. `packages/scenarios/src/maneuvers.ts` holds what is its own:
when each change comes, and the metrics.

A maneuver holds its start for 2 s, on a clock that starts on its own first
observation, then changes the request:

| Shape | Changes, at task time, with H the hold |
|---|---|
| roll or pitch step | 2 s: 0 to A; 2 + H: A to 0; ends at 2 + 2H |
| heading or altitude step | 2 s: 0 to A; ends at 2 + H |
| doublet, on any axis | 2 s: 0 to A; 2 + H: A to -A; 2 + 2H: -A to 0; ends at 2 + 3H |

A roll or pitch step comes back level because a lean held on keeps accelerating.
A heading follows the shortest way round, so one change stays below half a turn,
which is why a doublet's amplitude is limited to half a step's. Positive amplitude
rolls right, pitches the nose up, turns clockwise and climbs.

Unlike every other stage these targets have sharp corners, on purpose: how the
aircraft answers a sudden change is what a maneuver measures. The way to the
maneuver and from it stays smooth. Heading and altitude go as position targets of
no speed, with the yaw or the height changed at once. Roll and pitch go as
SET_ATTITUDE_TARGET in GUIDED, with the attitude at every observation, the three
body rates ignored (`type_mask` 7) and the thrust field exactly 0.5, which
ArduCopter reads as a climb rate of none, so it holds the height and not the
position. With GUID_OPTIONS bit 3 set that field would be half thrust, so the Run
tab refuses a roll or pitch maneuver then, and says why. If the messages stop,
ArduPilot levels the aircraft (GUID_TIMEOUT). After a roll or pitch maneuver a
`recover` stage, not measured, stops the aircraft smoothly from whatever speed and
direction it ended with, starting from where it actually is.

A request of roll or pitch becomes an `events.flightTaskAttitude` row at the tick
of its `events.flightTask` row. It is a signal of its own because a recording's
reader requires a row to hold exactly its signal's channels: two more channels on
`events.flightTask` would make recordings already stored unreadable.

The Experiments tab computes the response from the stored recording on the run's
simulated clock (`packages/analysis/src/response-series.ts`). An edge is the first
recorded row of a new request. The actual value is the physics truth: roll, pitch
and yaw from `truth.attitude`, height from `truth.position`, at the rate the
Logging tab set, 50 Hz by default. For each edge, with its window ending at the
next edge or at the end of the maneuver:

| Metric | Definition |
|---|---|
| delay | from the edge to 10 % of the way from where it actually was to the request |
| rise time | from 10 % to 90 % of that way |
| overshoot | how far it passes the request, as a percentage of the change requested |
| settling | from the edge to the last entry into the band around the request, 2, 5 or 10 % of the change requested, with 5 % shown first; none if it is outside at the end of the window |
| end error | actual minus requested, averaged over the last 0.5 s of the window, or its last fifth if that is shorter |

Crossings are interpolated between samples, and where it was at the edge is the
last sample at or before the edge, since a response cannot start before its
command. These describe the response. No limit applies to any of them, and the user
judges (SA-01). A value the recording cannot give reads as missing: no sample
around the edge, or a hole longer than 0.1 s or five sample spacings inside the
window. A heading keeps counting past north so the lines stay continuous, so 395°
is 35°, and the actual heading counts the same turns as the request.

The chart (`ResponsePlot.tsx`) draws requested and actual on one axis and one time
scale, with the request's corners at their recorded moments. Hovering reads both at
a moment, and a table holds the same values. The line colors pass the palette
validator against the panel's surface.

A roll or pitch can end slightly off the request. In the first flights the true
roll held 9.76° for a request of 10°, with ArduPilot's own estimate at 9.97°, so
the difference lies between its estimate and the truth. It exists from before
take-off and does not change with the lean. The cause
is ArduPilot's simulated gyro drift, SIM_DRIFT_SPEED, which stays at its compiled
0.05 by the decision of TASK-089: EKF3's learned gyro bias lags a drift that keeps
moving, and the lag shows as tilt. Flown with SIM_DRIFT_SPEED at 0, the same step
ends within 0.004° of the request, and rises alike both ways. Ideal mode on the
Sensors tab switches the drift off, and the Experiments tab says so beside a roll
or pitch.

### Verification (TASK-173)

`tests/maneuvers.test.ts` checks the metrics against the closed-form step response
of a second-order system at five dampings, 1000 and 50 Hz and two bands, with
oracles found by bisecting that closed form and tolerances set before the
implementation from the error of linear interpolation. It also checks what an edge
cannot say, the timelines, definitions and plans, the runner against a vehicle that
does what it is commanded, the attitude's bytes and quaternion, and the refusal.
`tests/response-series.test.ts` checks the series from rows written out by hand,
and that one time scale draws a response 0.25 s late as 0.25 s late.
`tests/integration/flight-tasks-sitl.test.ts` flies each of the eight types with
native ArduCopter V4.7.2 at speed 4 and 800 Hz, with the truth sampled at 50 Hz.
`tests/browser/maneuvers.spec.ts` defines one on the Flight tasks tab, flies a roll
doublet and an altitude step from the Run tab, and compares the table's numbers and
the chart's drawn lines with what it computes from the recording's own rows.

## Experiment lifecycle (TASK-165)

An experiment fixes its inputs: the aircraft profile version, the ArduPilot
build, the speed, the physics rate, the home, the conditions of its location
(the measured QNH and the temperature offset; TASK-148), its weather schedule
with its seeds (TASK-167), the initial parameters, the frame script, the
TASK-143 sensor snapshot of its profile version, the recording setup, the
flight task (TASK-172) and the fault schedule (TASK-169).
Results (the recording, the parameter log, the DataFlash files) belong to
the run. Its inputs never change after version 1.

### Lineage

Experiment payload schema 4 added `lineage`:

```typescript
type ExperimentLineage =
  | { kind: "original" }
  | { kind: "repeat"; of: string }   // the parent experiment record's SHA-256
  | { kind: "variant"; of: string; changes: ExperimentInput[] };
type ExperimentInput = "aircraft profile" | "ArduPilot build" | "speed" | "physics rate" | "home" | "conditions" | "weather" |
  "initial parameters" | "frame script" | "sensors" | "recording setup" | "SITL" | "flight task" | "fault schedule";
```

`experimentChanges(parent, child)` lists the inputs that differ, in that
order; the `conditions` input compares the location's measured QNH and
temperature offset, and the date of a run, with the magnetic field of its
conditions, is not an input. The run's own identity (launcher experiment or connection ID, the
recording record it made, its lineage and the BET module build) is not an
input. `createExperimentRecord` reads the parent, which must be an
experiment of the same project, and refuses a repeat whose inputs differ and
a variant whose `changes` are not exactly the computed list; a variant needs
at least one change. The parent is named as data, not as a store dependency,
and is never changed. Older records read as original runs. Schema 5 appended
`flight task` and schema 6 `fault schedule` to the inputs, schema 7 inserted
`conditions` after `home`, schema 8 `weather` after `conditions`, and schema 9
`terrain` after `weather`; no
stored `changes` list holds an input added after it, so every stored list
stays valid.

### Repeat and Create variant

The Experiments tab lists the project's experiments with their inputs and
lineage. Repeat and Create variant plan the Run tab's next run through
`SessionLink.planRun`; the Run tab switches to the ArduPilot SITL backend
and loads the parent's profile version (which need not be its profile's
head), ArduPilot build, speed, physics rate and home, and its recording setup
(or none, when the parent recorded nothing). A repeat locks them; a variant
lets the profile version, the build and the speed change. The record's
lineage is computed with `lineageFor` when it is written: a variant that
changed nothing is recorded as a repeat. A run with a SITL started by hand is
repeated by connecting that SITL again.

### Differences, never judged

By the user's decision of 2026-11-03, MirageSITL does not judge
reproduction; it stores no tolerance. For a repeat or a variant, the tab
shows the inputs that differ from the parent and, from the two recordings,
the largest horizontal and vertical difference of `truth.position` at the
recorded ticks both hold, where it occurs and the first tick at which the
positions differ (`trajectoryDifference`).

### Export and import

Export the experiment writes a project archive of the project record, the
experiment and its profile with that profile's whole dependency closure
(`ProjectStore.exportItems`, TASK-161). The tab lists what the archive cannot
hold (`externalDependencies`): the ArduPilot build a repeat would start,
which the receiving launcher must have installed (or the hand-started SITL),
and the recording, which stays in the browser storage of the computer that
made it. Import experiments imports an archive with the store's checks, then
lists the missing project records and, per imported experiment, a recording
this browser does not hold and the build it needs.

### Verification (TASK-165)

`tests/experiment-record.test.ts` checks schema 9, the migrations of schemas
1 to 8, the environment's consistency checks, the weather schedule and the terrain, the
input changes and what is not an input, the refusals of a false
repeat or variant and of a parent from elsewhere, the unchanged parent, an
exported experiment imported into an empty store and its external
dependencies, and the trajectory difference against a hand-computed oracle.
`tests/browser/experiments-tab.spec.ts` runs native ArduCopter V4.7.2
through the application alone: an original run, its repeat and a variant at
another speed, the comparison, and an export imported into another browser
profile.

## Experiment comparison (TASK-177)

Two flown experiments side by side, on the Experiments tab, which the twelve tabs of
TASK-137 leave as its place: different conditions for one aircraft, or equal
conditions for different configurations. `packages/analysis` is pure and reads a
stored recording. Nothing in it says which experiment is better: the metrics
describe, no limit applies to any of them, and the user judges (SA-01). A value the
recording cannot give reads as missing, never as zero.

### Inputs held equal and inputs that differ

`comparisonControls` lists 22 inputs: arms and motor layout, motors, propellers, ESCs,
battery, aircraft mass with CG and inertia, payload, other aircraft settings, flight
task, start position and lead-in, battery charge at the start, weather, scheduled faults, home,
ArduPilot build, initial parameters, frame script, sensors, physics rate, speed,
recording setup and SITL ownership. Each row gives both values, whether they differ,
and whether it is held equal. One held equal that differs is flagged, and the
comparison still shows, because what that means is the user's to judge. The user may
change what is held.

| Comparison | Held equal by default |
|---|---|
| Different configurations, equal conditions | payload, battery, flight task, start, charge, weather, scheduled faults, home, ArduPilot build, physics rate |
| One aircraft, different conditions | every aircraft input, payload, initial parameters, frame script, sensors, ArduPilot build, physics rate |

Speed, recording setup and SITL ownership do not change the physics, so neither kind
holds them by default. A run has no weather to choose until TASK-167, so that row reads
still air. The start and the charge are inputs of their own, apart from what the task
flies. A sensor snapshot names the profile version it was copied from; that name
is left out of the comparison, as is the COMPASS_DEC that follows from the home.

### Mass

A profile states its aircraft's mass, and component cards state their own.
`massAccounting` lists motors, propellers, ESCs and battery for each aircraft, the
stated aircraft mass, the payload and the total. It flags a change of 1 g or more that
the components and the stated mass do not agree on: heavier motors on an aircraft that
states the same mass, or a stated change no component explains. Both using one card is
no difference even if the card states no mass; a different card with no mass makes the
difference not known, and nothing is flagged.

### Metrics

Each is computed from the recording, on its own clock, in `experimentMetrics`. Airborne
means more than 0.5 m above the height of the first row. The two are compared over the
task's measured part if both have one, or else from the first to the last moment
airborne.

| Metric | Definition | Unit |
|---|---|---|
| highest | largest height over the first row's | m |
| mean and largest motor command | the mean over the motors at each row, then by trapezoids over time; the largest is any motor's | 0 to 1 |
| mean and largest rotor speed | in the same way, `motors.speed` | rev/min |
| mean and largest battery current, power | `battery`, by trapezoids; the largest is its largest row | A, W |
| lowest battery voltage | its smallest row | V |
| energy | ∫P dt by trapezoids, over 3600 | Wh |
| charge | remaining at the start of the window less remaining at its end | Ah |
| flight duration | (Q₀ − r·Q) / Ī, with Q₀ the charge the run started at, Q the capacity, r the reserve and Ī the window's mean current | min |
| position | RMS and largest of horizontal and altitude difference between each measured request and the first truth row at or after its tick; none for a maneuver, whose request jumps on purpose | m |
| maneuver response | as in "Tuning maneuvers", at a 5 % band | s, % |

The duration estimate names its scenario and its reserve: it flies on as the window
flew, from the charge the run started at to a reserve the user types, 20 % at first and
theirs to change. It holds the current constant, so it leaves out the voltage falling
as the pack empties, and it is not an endurance figure for a real aircraft.

### Limit exceedances

The recorder now keeps the limit monitor's events as `events.limit` rows, each at its
own tick: code 0, the monitor reports into this recording; code 1, a change of an
exceedance with its subject, quantity, edge, value and limit; code 2, events the monitor
could not hold. `limitSummary` adds up each quantity on each subject: how many times,
for how long, and against what limit, a rating warning kept apart from a modeled clamp.
A recording without code 0 is older, and says it does not know, never that there were
none. A brief clamp at the drive's current limit as a motor starts is normal, and shows.

### Thrust at full command

Takeoff capability and thrust margin come from `thrustCapacity`
(`packages/physics/src/thrust-capacity.ts`), in a Worker: every rotor at full duty on
the same rotor engine and battery as flight, in still air with the aircraft held
still, until speeds and voltage settle, at the charge the run started at. The result is
the upward force, the weight with the payload, and their ratio. Above 1 it can lift off,
and the rest is its margin. It is a calculation and carries the profile's label.

The rotors and the pack are solved together as in a flight (TASK-197), so a flight at full
command settles on the same thrust. On the example cards, a 125 A pack of 0.018 Ω:

| Aircraft | Bus at full duty | Pack current | Thrust | Thrust over weight | The pack holds it back |
|---|---|---|---|---|---|
| quad X, 4 motors | 15.29 V | 83.65 A | 78.45 N | 5.333 | no |
| hexa X, 6 motors | 14.70 V | 116.94 A | 109.05 N | 4.044 | no |
| octa X, 8 motors | 14.55 V | 125 A | 124.30 N | 3.018 | yes |
| coaxial X8, 8 motors | 14.55 V | 125 A | 124.37 N | 3.523 | yes |
| octa coaxial, 16 motors | 14.55 V | 125 A | 153.55 N | 1.842 | yes |

Before TASK-197 a flight's motors drew on past the limit, up to 4458 W from the 1819 W this
pack delivers on 16 motors, and reached 285.7 N. The tab says so when the pack limits an aircraft.

### Verification (TASK-177)

`tests/experiment-metrics.test.ts` and `tests/experiment-compare.test.ts` check the metrics
and the comparison on rows and inputs written out by hand, with each expected figure's
arithmetic next to it. `tests/thrust-capacity.test.ts` checks the thrust against an
oracle, the flight dynamics on a body 100 000 times heavier with gravity off, on a stiff
pack whose voltage hardly moves, within 0.5 % set beforehand; and the sag and the limit by
hand against the pack's law. `tests/bus-coupling.test.ts` flies the real pack (TASK-197). `tests/browser/compare-experiments.spec.ts`
flies one hover on two configurations with native ArduCopter V4.7.2, and compares the page's
numbers with what it works out from the recording's rows and the cards on its own.


## Fidelity assessment: TASK-184

TASK-184 sets a real flight log beside the log of a simulated run of one
aircraft profile version and compares them quantity by quantity and regime by
regime with the TASK-090 time-domain metrics. MirageSITL sets no fidelity limit
and gives no verdict (SA-01, F-05): every number is shown, and the user judges
how far to trust the results. What a log lacks is shown as missing, never
filled in. Operational acceptance (TASK-188) and fidelity stay separate reports.

**Logs and alignment** (`assessFidelity`, `packages/analysis/src/fidelity.ts`).
Both logs are ArduPilot DataFlash logs, read the same way: the real one, and
ArduPilot's own log of the simulated run or the one written from its recording.
The comparison takes an interval of the real log and an offset for the simulated
one, t_sim = t_real + offset, and reads the simulated series at the real
instants, straight between its neighbours; instants outside the simulated log
are left out. `logOrigin` tells a real log from a simulated one: a log that sets
any `SIM_` parameter, or holds MirageSITL's `MS` messages, is simulated.

**Quantities.** Roll, pitch and heading (ATT; a heading is unwrapped and the
simulated one moved by the whole turns that bring its start nearest the real
start), roll, pitch and yaw rate (RATE), height above the origin and climb rate
(XKF1, first EKF core), battery voltage and current (BAT, first battery) and the
first motor output (RCOU). For each, over the interval and in each regime:

```text
e_i = s(t_i + offset) - m(t_i),   RMS = sqrt(mean(e²)),   bias = mean(e),   Theil = RMS / (sqrt(mean(s²)) + sqrt(mean(m²))),   max |e_i|
```

with the mean, minimum and maximum of each series. Side by side, one number
per log: the energy used (BAT.EnrgTot at the end of the interval minus at its
start), the overshoot of the largest step of the desired roll and pitch of at
least 5° (the peak of (actual − before)/(desired − before) until the desired
value moves again, minus 1, in percent), and for each body rate its spread
about its mean and the dominant frequency of a Hann-windowed FFT over the
largest power-of-two number of samples. The paths, north, east and height each
from its log's own origin, are compared with the TASK-183 `pathDifference`.

**Regimes** come from the real log's EKF height (from its first sample) and
velocity at the latest XKF1 row: ground below 0.5 m, then forward at 1 m/s or
more horizontally, climb or descent at 0.5 m/s or more vertically, else hover.
These bounds only sort samples (an engineering default); the result lists the
seconds of each regime, and a quantity with no sample in a regime has a missing
row there with the reason.

**Comparison records and the label.** `fidelityReport`
(`apps/web/src/experiments/fidelity-report.ts`) reads both logs, assesses them
and builds a `fidelity-comparison` record (`packages/aircraft/src/fidelity-comparison.ts`,
schema 1): the profile version's SHA-256, name and version, the experiment's
SHA-256 as data, each log's name, SHA-256, size and origin with its reason, the
interval and offset, the regimes, and every row, scalar and the path above. Its
one dependency is the profile version. `validateFidelityComparison` refuses an
unhashed log or profile, the same file as both logs, a missing row that holds a
number or a compared row without its metrics, and any field it does not know,
so a limit or a verdict cannot be stored. `flightCheckOf` gives a profile
version the TASK-133 label `flight-checked`, with the regimes in which at least
one quantity was compared, only while it has a comparison whose real log is a
real flight: a SITL log earns nothing, and a new profile version has no
comparison, so a change of geometry, mass, motor or propeller resets the label
while the earlier comparisons stay their version's. The Analysis tab's fidelity
report (`FidelityReport.tsx`) chooses the experiment, whose log is found as the
Analysis tab finds it (ArduPilot's own log from the launcher, or one written
from the recording), takes the real log as a file, the interval (the real log's
span by default) and the offset (the logs' starts aligned by default), shows
the rows and scalars, charts the two series of a chosen quantity (real solid,
simulated dashed), saves the comparison and shows the version's label with the
comparisons that belong to other versions. `scripts/check-fidelity.mjs` takes
the TASK-090 capture in schema 2, without limits, and reports a flight-test
capture's metrics as REPORTED with no verdict; it refuses schema 1, whose
declared limits it no longer applies (section "Fidelity evidence pipeline
(TASK-090)").

**Verification.** `tests/fidelity-assessment.test.ts` declares before the
implementation, on a flight written here whose metrics follow in closed form
(float32 storage the only error): a roll 2° above the real one gives bias and
RMS 2, an identical pitch RMS 0, a height 10% above bias 0.1·mean(h) and RMS
0.1·rms(h), a heading written 0..360 in one log and −180..180 in the other RMS
0; the regimes 1.5, 3.5, 4, 4 and 3 s within one sample; overshoots of 20% and
40%; 4 Hz oscillations of amplitude 4 and 2 with spreads 4/√2 and 2/√2;
energies 0.8 and 0.96 Wh; missing rows with their reasons; and the origin of
each log. The same file holds the record: both logs' hashes and origins kept
as stored, eight refusals, and `flight-checked` earned only with a real log, in
the five regimes, absent for a new profile version and for a SITL log. On the
reference Mac, `tests/browser/fidelity-report.spec.ts` flies a hover of native
ArduCopter, compares it through the report with the repository's SITL log (or a
real one given as `MIRAGE_REAL_FLIGHT_LOG`), saves the comparison and checks the
label.

**First real flight (G4, 2026-11-07).** By the stakeholder's decision of
2026-11-07 the real log is `topic-144558-00000205.BIN` of
`data/flight-logs/inventory.json` (ArduCopter V4.6.2, the 7.2 kg quad X on
T-Motor MN7005 KV230 and P24*7.2 CF propellers). `tests/browser/fidelity-forum-quad.spec.ts`
(1 passed on the reference Mac, Playwright Chromium, native ArduCopter fb773567
at speed 4, `MIRAGE_FORUM_LOG_DIR` set) builds that aircraft from its cards and
`tests/fixtures/aircraft/tmotor-mn7005-quad.json` (arm length and inertia
assumed), calibrates it in the Components tab on T-Motor's datasheet (TASK-145),
takes off to 100 m from the Run tab as the real flight's automatic take-off
did, lands, and compares the run with the real log from 5 s before the motors
started to 45 s after, the logs lined up at their motor starts (real 178.18 s,
simulated 50.44 s). The real interval holds 42.1 s of climb and 7.9 s of
hover; the version became flight-checked in those regimes. Its first run found
that `logOrigin` called every real log simulated: it took any message whose
name begins with `MS` for MirageSITL's own, and ArduPilot's `MSG` begins so;
it now matches MirageSITL's message names exactly
(`tests/fidelity-assessment.test.ts`, a log with `MSG` alone is real).

Means over the climb, real against simulated (no limit, no verdict):

| Quantity | Real | Simulated | RMS of the difference |
| --- | --- | --- | --- |
| Roll, deg | −2.33 | 0.15 | 2.52 |
| Pitch, deg | −0.39 | 0.13 | 0.87 |
| Height above the origin, m | 51.6 | 51.1 | 0.51 |
| Climb rate, m/s | 2.48 | 2.37 | 0.18 |
| Battery voltage, V | 23.05 | 24.56 | 1.51 |
| Battery current, A | 19.8 | 35.4 | 15.7 |
| Motor output 1, µs | 1642 | 1562 | 81 |
| Roll, pitch and yaw rate RMS, deg/s | | | 1.63, 1.96, 0.56 |

What explains the larger differences, as far as the logs show: the real
aircraft flies with a steady roll of about −2.3°, of which its own
`AHRS_TRIM_X` of 0.023 rad (1.3°) accounts for part, and the owner was told
in the topic that its propellers were not level; the heading differs by 120°
because the run took off facing another way; the simulated battery does not
sag, because the card's internal resistance is not known; and the simulated
current is 1.8 times the real one. T-Motor's datasheet puts 1.8 kg of thrust
per motor (the stated 7.2 kg) at 6.4 A, about 26 A for the aircraft in hover,
which the simulation follows; the real log reads less, so either its current
sensor's scale (`BATT_AMP_PERVLT` 39.88) or the datasheet does not hold for
this aircraft, and the logs cannot tell which.

**The stakeholder's U35 (2026-11-08).** A second comparison, of the stakeholder's own aircraft
against its own log `stakeholder-00000167.BIN`: a 0.68 kg quad X on a MatekH743, rotors 102 mm apart
front to back and 144 mm left to right (arms of 88.2 mm at ±54.7° and ±125.3°), motor directions
reversed as in its `FRAME_TYPE` 18, 2650 KV motors and HQProp Duct-T90MMX3 propellers (90 mm,
pitch 3 inch, three blades and 2.35 g by retail listings), a 4S 4800 mAh pack
(`tests/fixtures/aircraft/u35-quad.json` and the `u35-*` cards; inertia, the motor's other values
and the ESC assumed, the ducts not modelled). The layout is not a stock frame's, so it flies on
the scripting matrix. `tests/browser/fidelity-u35.spec.ts` (1 passed on the reference Mac) flies it
in a preliminary calculation to a 1.2 m hover, as 00000167 hovered indoors at 1.1 to 1.5 m, and
compares 52 s from 2 s before the motor start. Its first run, on ArduPilot's default gains,
oscillated: roll rate spread 204 deg/s at 2.7 Hz against the real 2.6 deg/s. The aircraft's own
tuning from its log (rate and angle gains, filters, acceleration limits under V4.7's names in
deg/s², thrust expo, gyro filter) is now written on the Parameters tab before take-off. Means over
the hover, real against simulated: roll 1.20 against 0.10 deg, pitch −0.81 against 0.10 deg, roll and
pitch rate RMS 2.5 and 2.3 deg/s, current 13.4 against 10.2 A, voltage 15.16 against 16.69 V
(the pack's internal resistance is not known), motor output 1440 against 1470 µs, energy 2.83 against
2.37 Wh. The height differs by 2.7 m because the real aircraft's EKF reads 3.9 m where its rangefinder
reads 1.2 m: its barometer took the 76 Pa take-off dip of TASK-116 as a 6 m drop, and EK3_SRC1_POSZ is
the barometer. The simulated drive draws about 16 % less power for the same hover, the opposite sign
of the forum quad's 1.8 times; with the motor's resistance and the ESC assumed and the ducts left
out, the logs cannot say which part is off. The version became flight-checked in the regimes compared.

## Experiment from a log (TASK-182)

**Create experiment from log**, on the Experiments tab, takes a DataFlash log and an
interval on the log's own clock, and says what they give. Every run without a log goes
on as it did: a log is never needed. `packages/analysis/src/log-to-experiment.ts` is
pure and cold, and reads the log with the TASK-178 reader.

### The report

```typescript
type ExtractionStatus = "extracted" | "user-supplied" | "missing";
type ExtractionGroup = "initial conditions" | "parameters" | "task and control" | "weather" | "aircraft";
interface ExtractionField {
  key: string;
  label: string;
  group: ExtractionGroup;
  status: ExtractionStatus;
  value: string | null;   // as a person reads it; null exactly when missing
  source: string | null;  // the log message, or "the user"; null exactly when missing
  note?: string;          // what becomes of it, when that is not obvious
}
interface LogExtractionRecord {
  schemaVersion: 1;
  experimentSha256: string;
  log: { name: string; bytes: number; sha256: string };
  interval: { fromS: number; toS: number };  // the log's own clock, TimeUS
  fields: ExtractionField[];
  parameters: { name: string; value: number; defaultValue: number | null }[];  // the settings the run took
  skipped: { name: string; value: number; why: string }[];
}
```

| Field | Source message | What becomes of it |
|---|---|---|
| Home | `ORGN` | The new run starts here, with the heading from `ATT.Yaw` |
| Attitude at the start | `ATT` | Read and not flown from |
| Position from the origin, velocity at the start | `XKF1`, core 0 | Read and not flown from |
| Battery at the start | `BAT`, instance 0 | Read; the profile's battery starts full |
| Parameters | `PARM` | The value held at the interval's start; see below |
| Frame in the log | `PARM` | Read; the chosen profile sets the frame |
| Flight modes | `MODE` | Not replayed |
| Commands in the interval | `CMD`, `MAVC` | Not replayed |
| Pilot input | `RCIN` | Not replayed |
| Wind | `XKF2`, core 0 | The EKF's estimate, not a measurement; not applied |
| Air pressure, sensor temperature | `BARO`, instance 0 | Not applied; the temperature is the barometer's own |
| Turbulence | None | Always missing: no log holds it |
| Aircraft profile | None | Always missing, and the one field the user must supply |
| Firmware in the log | `VER` | Read; the run flies the build the Run tab chooses |

A field the log does not give is `missing`, with no value and no source, and the wizard
lists it. A field the user supplied says so, and the log's own value cannot be overwritten.
An interval outside the log, or a file with no timed records, is refused with its reason.

### Parameters

A parameter's value is its first record, or its last record at or before the interval's
start. A value equal to its logged default stays out, because the run has it already.
Parameters that belong to another machine or to the run stay out and are listed with the
reason: `SIM_*`, counters and versions, values the firmware writes as it starts (device
IDs, ground pressure, the mission count), telemetry rates a ground station asked for,
hardware ports and sensor calibrations, and what the aircraft profile and the Logging tab
set. The Run tab drops any the chosen build cannot write, and any the aircraft profile
sets, so the aircraft stays the one the user chose. The hint before the start says "up
to" that many, and the stored record says which the run really took.

### The run and its record

The wizard hands a `LogPlan` (log hash, report, chosen profile) to the Run tab, which shows
it and starts it like any other run: on the ground, at the log's home, with stock simulated
sensors. It is an experiment like that flight and not a replay, and the wizard and the Run
tab both say so. Exact replay of an arbitrary log is not promised. `log-extraction` is one
item per such run, depending on its experiment, and the Experiments tab shows it for as long
as the experiment exists: the log's name, interval, settings taken and what the log did not
hold.

### Comparison with the original flight (TASK-183)

The wizard takes parameter changes on top of the log's settings. `resimulationInputs` is all
the Run tab reads of a log, its home and its parameters, so the physics integrates its own
trajectory from the ground, and no recorded position reaches it. The run flies what the Run tab
asks, not the log's commands.

The log is not stored with the project, so `FromLogCompare.tsx` takes it again and refuses one
whose SHA-256 differs from the record's. Both logs are read the same way: core 0 of `XKF1`, or
`MSTR` in a log written from a recording. The start of the log's interval is lined up with the
start of the run's log, and the panel gives duration, greatest height, farthest from the start,
path length, and the root mean square and greatest gap between the two paths over the time they
share. These describe the difference, and no limit applies to any of them. **Compare both in
Analysis** opens the same alignment in the TASK-181 viewer.

## Parameter batches (TASK-176)

The user supplies several parameter sets on the Experiments tab. The scenario chosen
on the Run tab runs once for each, in the order given, with every other input
identical, and the results collect in one record. MirageSITL does not search for new
values, does not choose what runs next from a result, never retries a failed run and
does not say that a set is fit for real flight (S12, SA-01). There is no optimization
path to switch on.

### The record

`packages/project/src/batch.ts` defines the payload of the `experiment-batch` item
kind, and `validateExperimentBatch` checks it. The store keeps a new version after
each run, so the runs finished so far survive a closed browser. A batch is not
resumed: its record says how far it got.

```typescript
interface BatchParameter { name: string; value: number }
interface BatchSet { name: string; parameters: BatchParameter[] }
interface BatchScenario {
  profileSha256: string;
  flightTaskSha256: string;
  firmwareId: string;
  speedup: number;
  physicsHz: 800 | 1200;
  home: [number, number, number, number];
}
type BatchRun =
  | { setIndex: number; state: "done"; experimentSha256: string }
  | { setIndex: number; state: "failed"; experimentSha256: string | null; reason: string };
interface ExperimentBatch {
  schemaVersion: 1;
  scenario: BatchScenario;
  sets: BatchSet[];
  runs: BatchRun[];
  stopped: string | null;
}
```

A batch holds 1 to 32 sets, each with its own name and at most 512 parameters, sorted
by name, each once. An empty set runs the scenario as it stands, for comparison. Runs
are in run order, at most one per set: a second run of one set is invalid, so a retry
cannot be stored. A failed run's experiment is null when the run failed before it had
one. `stopped` says why the batch stopped before its last set. The record depends on
its aircraft profile version and the experiments so far (`batchDependencies`), and
names its flight task as data, as an experiment does. The recording setup is the
Logging tab's when each run starts, and that run's record holds it.

### A set in an experiment

A set's values are the run's initial parameters: ArduPilot boots with them and
confirms them as it does the generated list, and a value it cannot confirm fails that
run. `parameters` in the experiment record gains the tag `set`, with no new schema
version, since a record without it means what it did. `createExperimentRecord` refuses
a `set` parameter that names something the frame, PWM or site lists generate. The form
(`batchSetOfText`) refuses such a name before the batch can start and names it in the
reason, since the runs would otherwise not fly one aircraft. The run's start appends
the set after the generated list and refuses a clash with any generated name. A planned
repeat or variant carries its parent's `set` parameters, so a run of a batch can be
repeated exactly. Two finished runs of one batch differ in `initial parameters` and
nothing else, which is what `experimentChanges` reports for them.

### The runner

`BatchRunner` (`apps/web/src/experiments/batch-runner.ts`) is a state machine that the
Run tab's views drive, through `RunDriver` in `apps/web/src/run/session-link.ts`. For
each set in order it starts a fresh run with the set, flies the task from READY, stops
the run when the task ends, records the outcome and stores the batch. Nothing in it
reads a result to decide what runs next. While a batch runs, the Run tab's Start is
disabled. A batch cannot start until the Run tab has a flight task and an ArduPilot
build chosen.

| What happens | What the batch records | What runs next |
|---|---|---|
| The task finishes | `done`, with the experiment | The next set |
| The run cannot start, ArduPilot does not confirm the set, or the run fails | `failed`, with the reason and any experiment | The next set |
| The task ends early, or an accident pauses the run | `failed`, with the reason, once the run has stopped | The next set |
| The user stops the batch | The run under way as `failed`, and `stopped` | Nothing |
| The run is stopped on the Run tab | That run as `failed`, and `stopped` | Nothing |
| The Run tab's driver goes away | The run under way as `failed`, and `stopped` | Nothing |

### Results

The results table shows each run's highest point above where it stood, mean current,
energy and minutes to a 20 % reserve, from `experimentMetrics` (see "Experiment
comparison"), and a value the run cannot give reads as missing. Beside them it shows
altitude RMS unless the task is a maneuver, whose request jumps on purpose. For a
maneuver, a second table holds each run's rise time, overshoot, settling and end error
for each change, grouped by change so that the sets read side by side. The two sets of
a tuning batch may differ in little else. Nothing ranks the runs, and any two of them can
be opened in the comparison.

## DataFlash capture per experiment (TASK-164)

ArduPilot's own DataFlash logs of an integrated run stay ArduPilot's: the
launcher checks how they are configured, attaches each run's files to the
experiment with their hashes, and reads what they contain. It never writes
into them, and they are kept apart from the MirageSITL recorder (TASK-162).

### Logging parameters

An experiment's `LOG_*` parameters travel in its parameter list like any other
(`experiment.parm`). Before the launcher creates anything for a start, it
checks them against the generated metadata of the firmware's exact commit
(TASK-159; `checkLoggingParameters` in
`packages/autopilot/src/dataflash-logging.ts`). Every reason is named, and the
start is refused with HTTP 400:

| Check | Refused when |
| --- | --- |
| metadata | MirageSITL has no metadata for the firmware's commit |
| name | the name is not a parameter of that commit |
| value | the value is not finite; an enumerated parameter's value is not one of its values; a bitmask sets a bit the metadata does not declare or is not a whole number; a declared range does not hold it |
| `LOG_BACKEND_TYPE` | it lacks the File backend (bit 0), the only one whose output the launcher collects, or it requests the Block backend (bit 2), which SITL does not have |

Parameters whose names do not start with `LOG_` are not checked here. A start
without `LOG_*` parameters runs with the build's defaults.

### Attachment

The launcher lists `logs/` with each file's size and modification time just
before it starts a run. When the run ends (it exits, crashes or is stopped),
every DataFlash file that is new, or whose size or modification time changed,
belongs to that run. The launcher reads and hashes each one, and appends to the
experiment:

| Field | Meaning |
| --- | --- |
| run | the launcher run number |
| name, bytes, sha256 | the file in `logs/`, its size and the SHA-256 of its bytes |
| status | `complete` (ends at a record boundary, nothing damaged), `truncated` (only the tail after the last whole record is missing, as when SITL is stopped by a signal), `damaged` (a skipped or bad-format range inside), `empty` (no bytes, or no record) |
| records, truncatedBytes, damaged | whole records read, bytes in the cut tail, damaged ranges inside |
| firmware | the version string and git hash of the log's VER record, and whether the hash is the build's commit; null without a VER record |
| logging | each configured `LOG_*` parameter with the value the log's PARM records hold (its last occurrence), and `confirmed` when every one holds the configured float32 |

A run that wrote no file is attached as `missing` with the reason; a file that
cannot be read is attached as missing with the read error. Nothing is
synthesized. The attachments of every run are written to the experiment
folder's `dataflash.json` (schema 1: experiment ID, firmware version, commit,
captures) through a temporary file and a rename, and returned as
`attachments` by `GET /v1/experiments/{id}/logs`. The files themselves stay in
`logs/` and are served by `GET /v1/experiments/{id}/dataflash/{name}`. The
experiment record (TASK-154) names the launcher experiment whose folder holds
them; the project store gains no record kind for them in this task.

### Verification (TASK-164)

`tests/dataflash-capture.test.ts` checks the `LOG_*` rules against the
metadata of V4.7.2. It reads the VER and PARM records of the real SITL log
slice of TASK-178, and classifies that slice whole, with its tail cut, with a
damaged range inside, and with no bytes. It attributes files to runs (new,
grown, or rewritten at the same size) and writes the manifest atomically.
Through the launcher with the shared fake SITL, it refuses an unusable logging
configuration before creating anything and attaches both runs' 6-byte logs as
truncated. With the TASK-127 build, it attaches the real log of a 20-second
lockstep run through the launcher's own bridge on free ports, with the hash,
the firmware from VER and every configured `LOG_*` value read back from PARM.

## Recording format v2 (TASK-162)

Recorder v2 records a whole run, signal by signal, at per-signal rates. It
replaces neither the TASK-076 AAR record nor its archives, which stay as they
are. The Logging tab (TASK-163) and the Run tab's controller (TASK-163,
TASK-165) start recordings and send their events; this section defines what
they record into.

### Signal catalog

`packages/aar/src/signal-catalog.ts` lists every signal with a fixed numeric
ID, a group, named channels with units and a value type. The IDs are stored in
records and never reused.

| ID | Signal | Channels (units) | Type | Source |
| ---: | --- | --- | --- | --- |
| 1 | truth.position | north, east, down (m) | f64 | physics tick |
| 2 | truth.velocity | north, east, down (m/s) | f64 | physics tick |
| 3 | truth.attitude | qw, qx, qy, qz (1) | f64 | physics tick |
| 4 | truth.bodyRates | p, q, r (rad/s) | f64 | physics tick |
| 5 | truth.acceleration | north, east, down (m/s^2) | f64 | physics tick |
| 6 | truth.specificForce | x, y, z body (m/s^2) | f64 | physics tick |
| 7 | truth.air | trueAirspeed (m/s), ambientPressure (Pa), groundClearance (m) | f64 | physics tick |
| 8 | pilot | roll, pitch, yaw, throttle (1) | f32 | physics tick |
| 9 | actuators | output1..output16 (1) | f32 | physics tick, when the tick has an actuator frame |
| 10–14 | motors.speed, motors.current, motors.busCurrent, motors.power, motors.command | motor1..motor16 (rev/min, A, A, W, 1) | f32 | physics tick, when the dynamics has an electrical drive (power telemetry v1) |
| 15 | battery | stateOfCharge (1), voltage (V), current (A), power (W), remaining (Ah) | f64 | physics tick, with an electrical drive |
| 16–20 | sensors.imu, sensors.gnss, sensors.magnetometer, sensors.barometer, sensors.airspeed | the SensorFrameV2 values of the kind; GNSS adds latitude, longitude (deg) and altitude (m MSL) | f64 | sensor frames, aperiodic |
| 21 | truth.contact | support1 to support8 (N): each support's normal load, a presence bit for each the aircraft has (TASK-187) | f32 | physics tick |
| 32 | autopilot.attitude | roll, pitch, yaw (rad), roll/pitch/yaw rates (rad/s) | f32 | ATTITUDE |
| 33 | autopilot.localPosition | north, east, down (m), velocities (m/s) | f32 | LOCAL_POSITION_NED |
| 34 | autopilot.globalPosition | latitude, longitude (deg), MSL and relative altitude (m), velocities (m/s), heading (deg) | f64 | GLOBAL_POSITION_INT |
| 35 | autopilot.gps | latitude, longitude (deg), MSL altitude (m), fix type, satellites, eph, epv | f64 | GPS_RAW_INT |
| 36 | autopilot.ekf | flags, velocity, horizontal and vertical position, compass and terrain variances | f32 | EKF_STATUS_REPORT |
| 64 | events.parameter | a parameter name (16 ASCII bytes) and its float32 value; a flag marks the snapshot | — | event |
| 65–68 | events.weather, events.fault, events.pause, events.accident | a registry code and up to three numbers (pause: 1 paused, 0 resumed) | f64 | event |
| 69 | events.flightTask | stage, measured, task time (s), requested north, east, altitude (m), speed (m/s), heading (deg), vertical speed (m/s); a channel the stage does not request is absent (TASK-172) | f64 | event |
| 70 | events.flightTaskAttitude | requested roll and pitch (deg), at the tick of the events.flightTask row; a channel the maneuver does not request is absent (TASK-173) | f64 | event |
| 71 | events.limit | code, subject (a motor's index, or -1 for the battery), quantity, edge, value and limit; code 0: the monitor reports into this recording; code 1: an exceedance changed; code 2: events the monitor could not hold, in the value channel (TASK-177) | f64 | event |
| 72 | events.validity | flags (1): the flight model's validity bits at each change, from the session's first tick (TASK-145; bit 18 a calibrated rotor outside its bench data, bit 17 airframe drag beyond its data, lower bits the rotors' own) | f64 | event |
| 73 | events.contact | code, value: code 1 a touchdown with its descent speed (m/s), code 2 a lift-off with the peak total support load since its touchdown (N); what the aircraft stands on when an epoch starts is not a touchdown (TASK-187) | f64 | event |
| 127 | gap | rows lost here | — | recorder |

### Rates

A plan (`planRates`) takes one common rate (default 50 Hz, A-09) with
per-group and per-signal overrides. A rate is 0 (not recorded) or a whole
number from 1 to 2000 Hz; a signal override wins over its group's. The source
rate is the physics rate (400, 800 or 1200 Hz) for physics signals and the
upper bound for sensor frames, and the stream rate the session requests
(10 Hz on the Run tab) for telemetry. The effective rate is min(requested,
source). A request above the source rate is capped, and the plan and the
record's header mark it `capped` with both rates: 2 kHz is reached only by a
source that produces it, and no Phase 1 source does. Events have no rate and
are always recorded.

| Source | Which samples are kept |
| --- | --- |
| physics tick | an integer accumulator per signal adds the effective rate each tick and keeps the tick when the sum reaches the physics rate, subtracting it; N ticks keep exactly floor(N · effective / physics) samples, evenly spaced when the effective rate divides the physics rate, and never one tick twice |
| sensor frame | a frame is kept when at least physics / effective ticks passed since the last kept frame of its kind |
| telemetry | a message is kept when at least 1 / effective seconds of simulated time passed since the last kept message of its signal (5·10⁻⁷ s of slack for rounding) |

A kept physics sample whose source produced nothing in that tick (no
electrical drive, no actuator frame) writes no row; the producer counts it as
absent per signal, and the catalog entry reports the counts. An absent sample
is therefore never stored, and never read, as zero.

### Rows and chunks

A row is one kept sample, a gap or an event. Its header is 40 bytes
little-endian, followed by the payload and padding to 8 bytes.

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u16 | ID | signal |
| 2 | u16 | bitmask | flags: bit0 Gap, bit1 Snapshot (parameter rows only) |
| 4 | u32 | bitmask | presence: bit i set when channel i holds a value |
| 8 | u32 | ticks | tick lo |
| 12 | u32 | ticks | tick hi |
| 16 | f64 | s | simulated time |
| 24 | u32 | epoch | session epoch |
| 28 | u32 | rows | lost: rows the producer dropped immediately before this row |
| 32 | u16 | channels | channel count, equal to the catalog's |
| 34 | u16 | bytes | payload bytes: channels × 4 (f32) or × 8 (f64); 20 for a parameter row; 0 for a gap |
| 36 | u32 | — | reserved_zero |
| 40 | bytes | — | payload |

A chunk is a 48-byte header followed by rows, at most 65,536 bytes.

| Byte Offset | Data Type | Units | Field Name |
| ---: | --- | --- | --- |
| 0 | u32 | magic | 0x3243524d ("MRC2") |
| 4 | u32 | version | 2 |
| 8 | u32 | index | chunk index, from 0 without gaps in numbering |
| 12 | u32 | rows | row count |
| 16 | u32 | bytes | payload bytes after the header |
| 20 | u32 | ticks | first tick lo |
| 24 | u32 | ticks | first tick hi |
| 28 | u32 | ticks | last tick lo |
| 32 | u32 | ticks | last tick hi |
| 36 | u32 | key | the record ID's first 4 bytes |
| 40 | u32 | — | reserved_zero |
| 44 | u32 | CRC | CRC-32/ISO-HDLC of the chunk with bytes 44..47 taken as zero |

A reader checks every chunk: magic, version, its index, the record key, the
CRC and each row against the catalog (signal, channel count, payload size,
flags, presence bits within the channel count, a finite time). A failing chunk
is reported as corrupt and its rows are not used.

The record's header is JSON (schema `formatVersion` 2): the record ID (32 hex
characters), the experiment ID or null, the start time, the physics rate, the
common rate, the model SHA-256 or null, the firmware commit and binary
SHA-256 or null, and the signal table with each signal's source, requested and
effective rate and `capped`. A header is accepted only when its signals equal
this version's catalog and every effective rate equals min(requested, source).

### Producer, recorder and storage

The producer (`RecordingProducerV2`) runs in the physics Worker's record hook
and writes rows into recording queue v2 ([Shared Memory](SPECS_SHARED_MEMORY.md),
"Recording queue v2"). It allocates nothing after construction and never
waits. The recorder Worker (`recorder-v2.worker.ts`) drains the queue every
10 ms and Main's telemetry and event rows into chunks. It seals a chunk when
it is full or after one second of wall time with rows in it, which bounds what
a crash can lose. While it records, it holds the Web Lock
`mirage-recording-<record ID>`. When the recording closes, rows the producer
lost after its last delivered row become one gap row, so every lost row is in
the record.

Storage is the persistent IndexedDB database `mirage-recordings`, without the
32 MiB cap of TASK-076. Store `entries` holds one catalog entry per record:
the header; the status `recording`, `closed` or `interrupted`; the chunk
indices used and stored; bytes and rows per signal; dropped chunks and rows;
producer losses; and absent samples per signal. Store `chunks` holds the
chunks keyed by [record ID, index]. A chunk and its entry are written in one
transaction, and one transaction is in flight at a time, with at most 64
chunks waiting. A chunk that cannot wait, or whose transaction fails, is
dropped; its index stays unused and the entry counts it, so a reader names it
as missing. `listRecordings` marks a record that is still `recording` while
no Web Lock holds it as `interrupted`, and it then reopens with every chunk
stored before the restart. A-08 limits a recording to 2 GB per simulated
hour; the Logging tab (TASK-163) estimates a plan's size before it starts.

### Verification (TASK-162)

`tests/recorder-v2.test.ts` runs one simulated hour at 400 Hz (1,440,000
ticks) through the producer, the queue, the consumer and the stream writer. It
checks every stored chunk's CRC and rows, and finds for each signal exactly
floor(ticks · effective / source) rows in strictly increasing ticks: 2 kHz
capped to 400, 7 Hz on a source it does not divide, and IMU frames at 100 Hz.
It adds telemetry at 10 Hz, a 1,410-parameter snapshot and pause events, and
keeps the record within the A-08 budget. Other tests cover absent samples,
drops with every lost row accounted for, corrupted and dropped chunks, chunks
of another record or index, refused rows and headers, an interrupted record,
and telemetry decoding. `node scripts/bench-aar.mjs HZ v2` is G1 for the
producer at its worst case (every physics signal at the physics rate, 16
motors and an IMU frame each tick). `tests/browser/recorder-v2.spec.ts` arms
the application's physics Worker in Chrome. It records the demo session,
closes and relaunches the browser on the same profile, and reopens a closed
record with exact rates and a cut-off record as interrupted.

## Logging tab and run recording (TASK-163)

The Logging tab (`apps/web/src/logging/LoggingTab.tsx`) holds what the next
Run-tab run records, in the store's local settings (`logging`, schema 1;
`logging-settings.ts`): the common rate, A-09's 50 Hz by default, a rate per
group and per signal that overrides it (0 records none), the run length the
estimate totals (60 simulated minutes) and a storage reserve (500 MB). The
plan is `planRates` of the signal catalog at the Run tab's 800 Hz physics rate
with the 10 Hz autopilot streams the Run tab requests. The tab lists every
signal with its source, the source's rate (an upper bound for an aperiodic
source), the requested and effective rates, and why an effective rate is
lower: limited to the source's rate, or not produced in a Run-tab run. A rate
that is not a whole number of hertz from 1 to 2000 or 0, a rate for an event,
and an unknown name are refused with the reason, and nothing invalid can be
saved; 2 kHz is offered, and a source that produces less records at its own
rate.

`size-estimate.ts` estimates a plan from the catalog and the format: every row
has a fixed width (the 40-byte header and all of its signal's channels,
padded to 8 bytes), a physics signal keeps exactly its effective rate of
samples per simulated second, an aperiodic one at most its effective rate,
and rows fill 64 KiB chunks behind 48-byte headers. A Run-tab run produces
truth, pilot input, actuator outputs, motors, battery and autopilot telemetry,
but no MirageSITL sensor frames, since the SITL computes its own sensors
(`RUN_TAB_SOURCES`). Events are not estimated. The tab shows the size per
simulated hour and for the run length, marked as an upper bound while
telemetry is in the plan, and the free storage from
`navigator.storage.estimate()`, read again every 2 s.

Storage warnings (`storage-warning.ts`, lead defaults open to change): before
a run, when the run length needs more than is free beyond the reserve; at any
time, when the free storage is below the reserve; and while a run records,
when the rest of the run length at the measured growth needs more than is
free beyond the reserve. The reserve and the run length are recorded in the
experiment.

A run records when its `SessionController` has a recording port
(`RecordingPort`; the Run tab's is `RunRecorder` of `run-recorder.ts`, on
recorder v2's `RecorderV2Host`):

1. `prepare`, before the experiment record: the recorder Worker's record is
   created with the run's identity (the launcher experiment or connection ID,
   the manifest SHA-256 and, for a launcher-owned SITL, the commit and binary
   SHA-256), and the record's ID and the Logging tab's settings become the
   experiment payload's `recording` (schema 3).
2. `start`, after the experiment record and before the bridge connects: the
   recorder Worker opens the record and the physics Worker's producer is
   armed (`recording-v2.arm`), so the run's first tick is recorded. A
   connection to a SITL the user started records from its record on. A
   recording that cannot start stops the run as failure `recording`, with
   the instruction to free storage or lower the rates.
3. While the run lasts, Main adds every autopilot message the catalog
   records, decimated by simulated time; the parameter snapshot once the
   autopilot holds the run's parameters; the accident rows of TASK-149 and a
   pause row (1 paused, 0 resumed) for each pause. Rows take the latest
   physics tick (`SimulationRuntime.latestInto`, read when the row is made, so
   a hidden page stamps them too).
4. Every end of the run closes the record: the producer is detached
   (`recording.stop`), the last chunk sealed and the catalog entry closed.

Once a second the recorder publishes the record's catalog entry
(`RecorderV2Host.status`) to the Logging tab (`recording-monitor.ts`), which
shows the stored bytes, the growth per simulated hour and per real second,
and the gaps: rows the producer lost and chunks storage refused, each a gap in
the record.

Checks: `tests/size-estimate.test.ts` records 120 simulated seconds of the
default plan and 30 of a plan with 800 Hz truth, motors requested at 2 kHz and
the battery at 7 Hz through the producer, the consumer and the stream writer,
and the stored bytes are within 0.5 % of the estimate, declared before the
runs (0.0006 % and 0.005 % measured), with exact physics row counts.
`tests/logging-tab.test.ts` checks the defaults, the refusals, the settings'
round trip and the warnings. `tests/run-controller.test.ts` checks the order
prepare, record, start, connect, the telemetry, snapshot, accident and pause
calls, the close on Stop, and a recording that cannot start.
`tests/experiment-record.test.ts` checks schema 3's `recording`, its refusals,
and schema 2 records read as schema 3 without one.
`tests/browser/logging-tab.spec.ts` uses the tab alone: the estimate it shows
equals the module's, an unsupported rate is refused with its reason, 2 kHz is
capped at 800 Hz, the settings survive a reload, the tab fits 390 px and passes
axe, and a low quota (600 MB with 50 MB used, injected before the page loads)
warns before any run. With the TASK-152 installation a Run-tab run of the quad
X with native ArduCopter records while the tab shows its growth with no gap;
after Stop the record is closed with no lost row, every physics signal holds
exactly floor(ticks·50/800) rows (2,157 over 34,514 ticks), the experiment
record names the record and the settings, and the stored 2,713,080 bytes are
2.95 % below the estimate for the recorded time plus the parameter snapshot,
within the 10 % declared: ArduCopter streamed EKF_STATUS_REPORT, GPS_RAW_INT
and GLOBAL_POSITION_INT below 10 Hz and ATTITUDE and LOCAL_POSITION_NED not at
all, which the upper bound allows.

## Pause and resume of an integrated session (TASK-156)

A Run-tab run pauses through one path with a reason (`PauseReason`): `user`
(the Pause button), `visibility` (its tab was hidden), `accident` (TASK-149)
and `terrain` (missing terrain, which TASK-186 raises). The physics session
pauses as for `sim.pause` (an accident pauses it on the accident's tick from
inside the step); in JSON lockstep the autopilot then waits on the frame the
paused session holds, so its simulated time stops with the physics, as
decision D-03 records ([sitl-clock.md](decisions/sitl-clock.md)): position,
velocity, the aircraft's state and the flight are kept, and neither side
times out. Resume sends `sim.start`; after the resumed pump the SITL bridge
client answers the held frame, and both clocks go on. A run can pause while
loading parameters, warming, READY or flying, and returns to that state on
Resume; an accident also pauses a start once SITL runs (connecting, probing,
checking the version), since an aircraft that tips over on its supports does
so before the autopilot's first heartbeat, and Resume then restarts the
start's heartbeat deadline. A run continued after an accident stays
labelled. An accident's shape counts again only once it has touched nothing
for 0.25 s (section "Accidents"), so a wreck's contact chatter does not pause
the run on every tick.

The visibility policy: a hidden tab pauses an active run, which then waits
for the user's Resume, also when the tab is shown again. The ground station
(heartbeat, flight commands, the MAVLink parser) runs on the page's main
thread, whose timers a browser slows in a hidden tab, so a run never goes on
there unwatched, and a run with manual input (TASK-174) never continues on
stale input.

While paused, the ground station keeps sending its heartbeat, which the
autopilot reads on resume (TASK-129 found a 60 s hold without a failsafe),
and a connected SITL's silence is not a heartbeat loss; the bridge keeps the
session's WebSocket alive with its 1 s ping, which the browser answers.
Parameter reads and writes sent while paused wait until resume (D-03). Each
pause is logged
(`ControllerView.pauses`: reason, tick and simulated time of the pause, wall
time of the pause and of the resume) and recorded as an `events.pause` row,
1 on pause and 0 on resume (TASK-163). Simulated time does not advance while
paused, so a run's simulated duration excludes paused wall time; the Run tab
shows the paused wall time, and the speed the bridge client reports leaves it
out (`SitlBridgeClient.setPaused`).

Checks: `tests/run-controller.test.ts` pauses a flying run for the user and
resumes it to the same flight with the pause logged (600 s of wall time on
the fake clock), pauses a READY run for a hidden tab, refuses a second pause
while one is pending and a pause outside a run, pauses a start on an accident
before the first heartbeat and restarts its deadline on Resume, fails a
refused `sim.pause` with its reason, and starts the next run without pauses.
`tests/browser/sitl-pause.spec.ts` with native ArduCopter, through the Run tab
alone: a user pause of more than 10 minutes of wall time in a 5 m hover, with
simulated time, altitude and stepped frames unchanged throughout, resumes into
a hover within 0.5 m of 5 m for 10 s of simulated time, armed in GUIDED, with
no failsafe or EKF message, the pause logged and both rows recorded; and a
quad whose CG is 0.152 m forward, 7 mm inside its front supports, tips onto
its nose while it settles at the start: the run pauses on that accident before
the autopilot's first heartbeat, continues labelled (the rocking wreck strikes
once more), loads its parameters, then pauses when its tab is hidden and waits
for Resume after the tab is shown again, with every pause recorded.
