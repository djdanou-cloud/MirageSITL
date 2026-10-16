# SPECS_SIMULATION_ENGINES.md

Version 1.0 · 2026-10-15. **Target contract** for TASK-016..059.
Implemented `DemoDynamics` is a separate demonstration stub, not an
implementation of these models. English is the source of truth.
[Russian mirror](ru/SPECS_SIMULATION_ENGINES.md).
Binary transport: [SPECS_SHARED_MEMORY.md](SPECS_SHARED_MEMORY.md).
Tasks and acceptance: [PROJECT_ROADMAP.md](PROJECT_ROADMAP.md).

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
* Experimental rotor/airframe validation and physical HITL are separate
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

Rapier 0.21.0 is selected for a sphere/flat-ground contact reference. It owns
integration, uses NED +Down gravity and reports net contact impulse from change
in momentum minus external force/gravity impulse. `pointBody` is the sphere's
nominal bottom point in body axes, not a general multi-point landing-gear
manifold. Restitution/friction/drop tests exercise the real WASM engine. A rolling
sphere can retain translational speed with Coulomb friction; do not invent a
stopping force. Provider getters allocate new vector/quaternion wrappers each
step: `highRateCertified=false`. TASK-029 remains BLOCKED_DECISION until a
nonallocating binding or alternative solver meets G1. No production Worker path
may select this prototype as a certified 400–1200 Hz backend.

JSBSim v1.2.3 is pinned to commit
`570e8115a102df8f877b11e0e59b964ea483e3c0`; Emscripten 4.0.15 to emsdk commit
`389a68bc35dcff7ebae4614e1615099dafda00d1`. The build checks source HEAD, tracked
cleanliness, LGPL-2.1 library license hash and SDK manifest hash before compilation.
Aircraft XML is not bundled: c172x includes separate redistribution language and
is not pilot validated. Review model-specific licenses/data before packaging.
Native smoke uses the same bridge/source, outputs 22 finite SI doubles after
one simulated second, and is **not** a trim, native/WASM parity or allocation test.
SDK installation was denied with proxy CONNECT 403 at storage.googleapis.com;
TASK-030/031 remain BLOCKED_EXTERNAL. Saved network configuration is a draft,
not evidence that the current runtime or a new cloud task can download the SDK.

The bridge ABI v1 takes four float64 controls: throttle [0,1], aileron/elevator/
rudder [-1,1]. Output is 22 doubles: origin-fixed position NED at indices 0..2,
velocity NED 3..5, body-to-origin-NED wxyz 6..9, body angular velocity 10..12,
body specific force 13..15, simulation seconds 16, altitude ASL metres 17, gravity
magnitude 18, coordinate acceleration NED 19..21. Feet convert with exact 0.3048.
Origin ECEF and its NED rotation are frozen at initialization; transport body
vectors through ECEF into that origin frame. Quaternion extraction accounts for
JSBSim's passive matrix convention. Coordinate acceleration includes the body
velocity transport term; specific force is the applied-force acceleration.
JSBSim owns integration; contact impulse coupling, pinned trim/step fixtures,
WASM allocator instrumentation and Worker artifact smoke remain unverified.

`node scripts/validate-models.mjs` builds actual scalar/SIMD artifacts, runs two
10-second rigid-body cases at 400/800/1200 against 4800 Hz, verifies the analytic
ballistic trajectory, and writes SHA-256/provenance plus error metrics to
`test-results/validation/model-report.json`. Position tolerance is 0.1 m;
attitude tolerance is 0.5 degrees using absolute quaternion dot product.
Numerical PASS is separate from fidelity: absent measured datasets, full BET
binding, contact G1 and JSBSim parity keep overall status BLOCKED (exit 2).
No synthetic dataset is relabeled as measured. The report schema lives in
`docs/validation/model-report.schema.json`.

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


## Retry evidence and corrective contracts: TASK-029–031, TASK-033

The earlier getter-only allocation diagnosis was incomplete. Rapier 0.21.0
supports reusable targets for translation, rotation, velocity and angular velocity.
`GroundContact` now supplies them, keeps native force/torque/gravity vectors alive
until disposal, and calls the raw physics pipeline. The raw path is restricted to
fixed rigid-body topology: no hooks, events, soft-body tearing or automatic mapping
of newly spawned bodies/colliders. It retains exactly one integration owner.
`VectorOps.intoRaw` is not called during stepping; disposal is idempotent and
subsequent steps fail. This removes explicit wrapper construction without claiming
that the engine meets G1.

`node scripts/bench-contact.mjs` measures three million warmed JS steps plus an
allocating control. Every 800 ticks, 100 ticks apply -19.6133 N lift to a 1 kg
sphere and 700 release it, exercising takeoff/landing against the plane. Near-plane
negative normal impulse counts contact transitions. Heap profiling identified
Rapier's imported `performance.now` timing calls and numerical boxing in getters.
Disabling its runtime profiler flag does not eliminate all timing calls. The
actual three windows still produce GC: **G1 fails**. Never replace global clocks
or suppress GC observation to hide this failure.

The matching official source is commit
`b716d375efc0201003f0cd9ef7168eee0b62c177` (native Rapier 0.36.0, JS 0.21.0).
`node scripts/check-contact-native.mjs` verifies its commit/license, copies the
checked-in probe and dependency lock into an external build cache, then runs
1e6 f64 steps with dim3/std/enhanced-determinism and **without** the profiler
feature. The counting allocator and positive control still detect 1,688,500
allocations / 77,328,000 bytes. Report: `test-results/bench/contact-native.json`.
This is native f64 evidence, not measurement of the packaged f32 WASM allocator.
Removing the JS timing feature alone therefore cannot certify the f64 replacement.
TASK-029 requires an allocation-free engine build/binding before admission.

### JSBSim opaque handles and cold trim

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
and C++ new/new[]; the positive control must be detected. Measured result:
21,142,500 allocations / 1,454,820,000 bytes; **native G1 fails**, CLI exits 2.
`test-results/validation/jsbsim-native.json` records model/source/bridge/checker
hashes, windows and separate WASM status. No aircraft XML is redistributed.
The SDK download remains HTTP 403 at storage.googleapis.com; WASM compilation,
Worker smoke, trim parity and contact coupling remain unverified. Native success
on trim does not clear TASK-030/031.

### Model report schema v2

`validate-models.mjs` now rejects empty/misordered rates, malformed cases,
duplicate IDs, missing analytic ballistic reference and unsupported measured-data
entries **before** compilation. The supported manifest is explicitly synthetic;
a measured dataset requires a reviewed units/envelope/provenance adapter.
The report is version 2 because it adds `diagnostics.contact` and
`diagnostics.jsbsimNative`, each containing path, report SHA-256 (or null), and
status missing/invalid/stale/pass/failed. Reports whose adapter/bridge/checker
hash differs from current source are stale. Diagnostics describe evidence; they
cannot authorize a full backend or substitute native evidence for WASM parity.
Overall/fidelity remain BLOCKED with exit 2 even when all 12 numerical cases pass.
The missing measured airframe/rotor data and unconnected full BET backend remain
explicit. Historical batch results above are preserved as dated records; this
retry section supersedes their contact allocation diagnosis.


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
binding or establish a general landing-gear manifold. The JS adapter still
fails its observed-GC gate and retains `highRateCertified=false`.

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
Model report v2 additionally exposes `diagnostics.contactNativePatched` and
`diagnostics.jsbsimNativePatched` with the same missing/invalid/stale/pass/failed
statuses; these do not replace the production contact or WASM gates.

The SDK install still fails with proxy CONNECT 403 at storage.googleapis.com.
Review/save the existing network and startup draft in environment settings,
then publish/apply it before retrying the pinned Emscripten install. Saving the
draft has not applied access to this runtime. An actual JSBSim WASM build,
Worker smoke, native/WASM parity, contact coupling and model-data review remain
required. TASK-029 remains BLOCKED_DECISION for a certified binding/general
contact model; TASK-030/031/033 remain BLOCKED_EXTERNAL. Missing measured rotor/
airframe validation and the unconnected full BET backend still block fidelity.


## Radio, autopilot transport and isolated fault components (TASK-037–060)

This batch implements TASK-037/038/039/040/048/052/053/056/057/060. Modules are
independent protocol/transport/training references. The live flight Worker still
uses demo dynamics. No ArduPilot firmware, HITL health, complete EW composition,
validated terrain, or physical transmitter/flight-controller acceptance is implied.
TASK-036 geodesy, TASK-041 JSON lockstep and TASK-049 HIL streaming remain future
integration boundaries; later work must use actual upstream/device evidence.

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
channel. A real ArduPilot SITL process is not run here: the pinned native
harness is TASK-042.
