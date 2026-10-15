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
