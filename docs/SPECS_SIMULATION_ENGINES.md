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
this task does not connect weather to the current demo or JSBSim.

`Wind` preallocates three RNG streams (IDs 0/1/2), reset by the session seed.
At fixed 400/800/1200 Hz, each gust component follows
x_next=a*x+sigma*sqrt(3*(1−a²))*(2u−1), a=exp(−2*pi*bandwidthHz/hz),
u in [0,1). This bounded-innovation AR(1) has stationary variance sigma²
and pole bandwidth in (0,hz/2); it is synthetic, not Gaussian OU or Dryden.
Mean is limited to ±200 m/s per axis and RMS to [0,50] m/s; a bandwidth so
small that decay rounds to one is rejected during configuration.
The caller owns length-three NED output; render grouping never advances RNG.
Atmospheric setup may allocate; wind stepping reuses storage. The allocation
probe is `node scripts/bench-wind.mjs`, report test-results/bench/wind.json.

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
36..39 reserved zero; f64 radius/root/inertia/bearing/dt/initialOmega/
inflowTau/inflowLimit/minConfidence at 40/48/56/64/72/80/88/96/104;
112..127 reserved zero. Then four station f64 arrays (radius/chord/twist/width),
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
WASM variant and one million stationary four-rotor body steps with zero gravity.
The JS probes require zero GC, less than 0.01 incremental bytes/step, stable
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
velocity derivative. Reset clears all fault states and seed streams.

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
energy or calibrated battery-life claim. Power availability must be fed back to
actuators by a future backend before flight dynamics can use the coupled model.

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
[26]=gravity down m/s², [27]=wheel count 0..8, [28..31]=zero.

Each wheel starts at 32+160*i. Its fields are [0..2]=fully extended wheel-center
anchor body FRD m; [3]=unsprung mass kg; [4]=tire radius m; [5]=rigid rim radius m
(0<rim<tire); [6]=strut travel m; [7]=strut kind (0 linear, 1 gas);
[8]=linear stiffness N/m; [9]=preload N; [10..11]=compression/rebound damping;
[12]=damping law (0 linear, 1 square); [13..15]=rolling/lateral/braking mu;
[16]=tire damping N s/m; [17]=knot count 2..64; [18..27]=gas area, volume,
charge pressure, ambient pressure, exponent, hydraulic area, fluid density,
discharge coefficient, compression orifice, rebound orifice in the SI units
specified below; [28..31]=zero; [32..95]=tire deflection knots m;
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
distance from the plane m, and zero. Wheel diagnostics describe the force
evaluation before integration; body state describes the completed step.

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

Rolling uses a kinematic longitudinal resistance, separate lateral resistance,
and brake interpolation, regularized below 0.1 m/s; their combined magnitude
is capped by max(longitudinal mu,lateral mu) times tire normal load. It is passive
but does not represent wheel spin, static tire slip, anti-skid or steering.
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

`packages/mavlink/dialect.lock.json` pins common XML commit
2e2b6af99084e4fde9bb304c84bb9253a1a98b6f, common/standard/minimal XML and license
hashes, pymavlink 2.4.50 and generator-file hashes. The older 2.4.49 generator
rejects the pinned XML schema; validation is retained with the compatible 2.4.50.
`generate-mavlink-fixtures.py` verifies source cleanliness/commit/version and
uses the official generator. Generated Python stays outside the repository;
checked-in golden frames are SHA-256 registered synthetic protocol oracles.
They are not aircraft measurements. The upstream generated-output notice is
retained in packages/mavlink/NOTICE.

| Message ID | Message | Full payload bytes | CRC_EXTRA |
| --- | --- | --- | --- |
| 70 | RC_CHANNELS_OVERRIDE | 38 | 124 |
| 93 | HIL_ACTUATOR_CONTROLS | 81 | 47 |
| 107 | HIL_SENSOR | 65 | 108 |
| 113 | HIL_GPS | 39 | 124 |

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
records, more than 4096 messages/second, oversized records and backpressure close
the session. Default queued-byte budget is 65536; queues cannot grow indefinitely.
An idle client closes after 5 seconds. Tests exercise real WS/UDP transfer,
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
mismatch against the pinned payload also blocks. No authoritative grid
(EGM96/EGM2008) is in the repository yet, so absolute MSL accuracy remains
blocked while local NED/ECEF/geodetic conversions are verified.

## Implemented ArduPilot JSON lockstep: TASK-041

The protocol is pinned to ArduPilot commit
8ab6afde107a91df1b5f60ade8f333cb8a61b190 (`libraries/SITL/SIM_JSON.{h,cpp}` and
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
8ab6afde107a91df1b5f60ade8f333cb8a61b190 no HIL_SENSOR/HIL_GPS/
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
allocation. The live Worker owns one `EwEngine` and a four-motor `MotorFaults` table. A session constructed without that port still rejects `fault.set`. `weather.set` stays rejected because the demo has no wind model. Each effect kind has one owning faultId (per motor for
`motor-loss`); a newer faultId replaces the owner, disabling a non-owning or
unknown faultId changes nothing, and a full registry returns `registry-full`.
Disabling drift uses the command's `recovery`; motor-loss is forwarded to the
physics `MotorFaults` and never touches observations. `reset(seed)` clears
every effect, the registry and motor faults. `flags` reports the state ABI
`ew_flags` bits.

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
signatures remain as low-rate conveniences. `MagneticAnomaly.configure`
reconfigures in place for tick-boundary commands.


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

Regression hardening: PhysicsSessionV2 now captures wall receipt time after the coherent pilot read, preventing a concurrent valid publication from appearing future-dated; truly future/stale inputs still disarm. WebGPU capability probing is shared once per document (including in-flight work); reload retries after driver changes. Renderer tests use an isolated harness and compare diagnostics within one document. Instructor motor loss selects channel index, power-cut versus synthetic instant-thrust-loss and remaining fraction; pending epoch-changing commands await their matching ACK even when the shared header advances first.

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

SITL locks firmware commit 8ab6afde107a91df1b5f60ade8f333cb8a61b190, EKF3 and arming checks. The owned Linux driver `scripts/sitl/driver.mjs` (with pinned pymavlink 2.4.50 sidecar `scripts/sitl/telemetry.py`) drives the verified native ArduCopter ELF against `BetRigidBodyBackend`. The analyzer requires contiguous servoFrame from zero, four 1000–2000 us PWM channels, increasing timestamps with <=0.1 s gaps, real source/model/firmware provenance and healthy EKF. Stages must progress arm→takeoff→hold→land, in GUIDED=4 until LAND=9. Takeoff altitude is >=3 m, hold is 10 m ±1 m for >=10 s, and the final sample must be disarmed below 0.5 m. A private process run is bounded to 120 s/16 MiB; only its owned child/group is terminated. Pinned sources/hashes do not alone prove binary reproducibility. Full-rate capture verification (`scripts/check-sitl-capture.mjs --input CAPTURE_DIRECTORY`) and trace v2 details are specified in the TASK-042 native closed-loop section below.

TASK-051 is a version 2 proposal and is not a version 1 acceptance gate. Its analyzer, kept for that later firmware, covers 60–3600 s. Virtual Hybrid SITL uses provenance source `virtual-sitl`, copter `SIM_RATE_HZ` of at least 400, and p99 compute lateness <=2.5 ms, with no drone and no serial port. Recorded Simulation-on-Hardware requires ArduPilot >=4.6.3, `AHRS_EKF_TYPE` 10, `GPS1_TYPE` 100, `SIM_MAG1_DEVID` 97539, heartbeat gaps <=2.5 s, and an unplug that drops the link and disables actuators. Plane, rover and blimp Hybrid SITL use `SIM_RATE_HZ` of at least 50 and p99 lateness <=5 ms. See the version 2 procedure; the CLI does not open a serial port or arm a vehicle.

EW requires a no-fault control plus jamming, position-step, velocity-drift, magnetic and motor-loss cases. TASK-059 native acquisition uses scripts/run-ew-sitl.mjs, the existing TASK-042 driver and the TASK-058 EwEngine. GPS1_TYPE=14 accepts actual GPS_INPUT packets at 10 Hz; GPS2_TYPE=0 prevents a clean backup masking the injected receiver. Physics JSON position/velocity remain true. A 30 m north step, 0.5 m/s² north drift capped at 4 m/s, and severity-1 jamming affect GPS only. Magnetic bias adds [0.3,0.2,0] Gauss in FRD through all three SIM_MAGn_OFS parameters (negative milliGauss because SIM_Compass subtracts offsets); no attitude or IMU-force corruption is used. Motor 0 loses its complete force and yaw wrench after motor lag through the explicit synthetic instant-thrust-loss contract, not an electrical motor model.

The plan is fixed before calibration: seed 59, 800 Hz physics, 100 Hz response capture, live READY admission, 5 s stable hold before injection, 12 s exposure and 8 s recovery; complete motor loss has a bounded 3 s exposure and no recovery claim. Disabling drift uses step-to-truth. Fault runs retain unhealthy EKF flags, innovation ratios, modes and trajectory rather than requiring TASK-042's healthy landing gate. Native source 8ab6afde migrated ARMING_CHECK to ARMING_SKIPCHK: the actual full parameter readback must show ARMING_SKIPCHK=0, EK3_ENABLE=1 and AHRS_EKF_TYPE=3. The legacy parameters.parm remains historical; no check is bypassed.

Schema 2 manifests name six ordered capture directories. scripts/sitl/check-ew.py independently re-decodes both raw directions with pymavlink 2.4.50 and CRC validation, checks every transmitted GPS_INPUT against its source observation and quantization, checks firmware GPS readbacks and the complete pre-fault parameter snapshot. scripts/sitl/audit-ew.mjs reruns that decoder, replays every actual PWM through the original rigid-body WASM and canonical fault schedule, compares truth and quaternion, reconstructs every baseline/distorted observation, verifies compass fault/recovery acknowledgments, and joins response rows to original heartbeat/EKF/global-position messages with <=1 s freshness. Truth hashes compare before/after observation processing in the same tick. Separate closed-loop flights may have different trajectories; motor failure intentionally changes physical truth. The former schema-1 self-declared changed-observation flags do not establish native acceptance.

scripts/freeze-ew.mjs accepts audited calibration captures once, requires a healthy control within 1 m, and refuses to overwrite existing envelopes. The predeclared empirical rule is ceil-to-0.01 of 1.5 times each calibration maximum plus 2 m position/trajectory margin or 0.5 innovation margin. Observed calibration modes become the allowed set; unexpected modes require investigation. Firmware, effective parameter inputs, model, plan and source hashes must match. A new validation batch must pass those fixed bounds and the independent healthy control gate; calibration capture hashes cannot validate themselves. These are version-specific synthetic native regression limits, not measured aircraft fidelity, browser READY, recorded Simulation-on-Hardware, guaranteed fallback modes or EKF gate bypass.

Native TASK-059 acceptance: all six calibration cases and six separate validation cases pass, with 710636 reconstructed physics frames. The immutable matrix and original native reports/archives preserve fault-induced unhealthy flags and modes. Jamming and drift reached Land; the position step raised GPS-glitch flags; magnetic bias increased compass innovation ratios while remaining Guided; complete rotor loss tumbled into the synthetic floor during its 3 s window. In pinned Copter ekf_check.cpp, compass, velocity and position variance criteria combine before failsafe action, so compass innovation alone is not a promise of Land. The healthy TASK-042 flight also passed again. See test-results/validation/task-059-native.json, task-059-tests.json and task-059-completion.json for exact identities and the documented environment reruns.

GPU analysis requires M4 or RTX4050 identity, OS/browser/power/backend, a visible production scene, all terrain/FPV/thermal features, >=60 s warmup and >=600 s measurement. All positive finite frame intervals must cover duration within 0.02 s. On 2026-10-21 the user accepted 60 FPS limits of median 16.680 ms and p99 17.665 ms, compared after rounding to 0.001 ms, and accepted a 59.88 Hz panel for that profile. The 120 FPS p99 limit remains 8.33 ms and applies on a panel that refreshes at least at 120 Hz. GPU residency<=2 GiB and CPU cache<=512 MiB. The flight image must fill the active physical display. An emulated 1920x1080 viewport does not prove presentation on a 2560x1440 mode or on the MacBook Air native 2560x1664 panel. Software/headless rendering cannot pass. Imported traces require original profiler evidence review.

System evidence maps exact G0/G1/G2/G3/G4 IDs to demo, external-sitl, wasm-sitl and hitl. Every missing requirement is NOT_RUN; any FAIL fails the mode; otherwise incomplete coverage blocks. PASS requires an observed source, expected report path, exact report hash, matching source revision and an underlying PASS of the correct kind. Empty, duplicate, unknown and stale declarations cannot certify a mode. Legacy numerical reports are not silently upgraded to physical PASS. Release inventories verify owned generated files, byte limits, hashes, licenses and actual metadata; full license/build/clean-machine/raw-evidence review remains blocked. No release script publishes.

### Terrain collision lattice v1

HeightTile has version=1, epoch/revision uint32, integer northIndex/eastIndex within ±1024, resolution 2..257, spacingM in (0,100], and resolution² finite downM samples within ±15000 m. All horizontal nodes must remain within the 15 km local envelope. Row increases North, column East; the world origin is fixed NED. Each cell uses triangles [a,a+1,a+n] and [a+1,a+n+1,a+n], normals facing -Down. Native height samples remain Float64; mesh vertices are Float32. Quantized vertices add at most about 1 mm over this envelope and do not establish physical terrain accuracy.

Collision construction belongs to a separate Worker. Stage owns a copy, validates matching epoch/lattice, increasing revisions, exact shared-edge heights and fixed capacity 1..256 (default 64). Combined active+pending buffers obey a byte cap (default 64 MiB, configurable up to the 512 MiB CPU ceiling); replacement must fit both old and new data before publication. Publish swaps pointers only on strictly increasing ticks of the matching epoch. Visual resources cannot evict collision ground. downAt/sampleInto use the piecewise-triangular mesh rather than bilinear interpolation. Missing ground returns NaN; readyAround/readyFrom conservatively require every tile intersecting a safety square with radius<=half a chunk. High-rate calls use preallocated typed-array inputs/outputs; scalar convenience calls are cold. The TASK-065 terrain contact coupling below connects it to the Rapier contact owner; live terrain admission into the flight session remains separate. No file decoding runs inside physics.

### Declarative scenario v1

Scenario admission snapshots and freezes configuration: id, physics hz 400/800/1200, uint32 seed, model/firmware SHA-256, duration 1..4320000 ticks, <=128 ordered events and an altitude-hold rubric. Only validated weather.set/fault.set protocol-v2 templates are admitted, with expectedEpoch=0, consecutive requestIds from 1 and atTick exactly matching event tick. `ScenarioBinder` binds the active epoch, allocates the next accepted request id, submits through the session queue on that simulation tick, and claims a fault applied only after an applied ACK. The runner returns immutable event indices, never allocates in polling, and uses simulation ticks; pauses consume no simulated time. Backwards/missed ticks return -2 instead of late execution. Reset explicitly rewinds the cursor. Provenance/seed/hz mismatches reject startup.

The rubric requires every integer hold tick exactly once, finite altitude, actual autopilot source and healthy EKF when configured. Gaps, excess altitude error and unhealthy EKF fail; incomplete/synthetic traces block. Pilot-basics contains all-zero placeholder hashes for structural testing only; it is not a certified aircraft/firmware lesson. Native SITL EW closed-loop validation (TASK-042/043/059) is complete. TASK-075 admits instructor `fault.set` commands into the live session `EwEngine`. TASK-079 submits scenario faults on their tick and waits for the applied ACK. Weather events stay rejected on the demo. Placeholder lesson hashes are not a certified lesson.

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
within 1e-6 of 1, and airspeed/battery/current/height are nonnegative. Bytes
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
