// Barometer v2 (TASK-116): the pressure errors that dominate barometric altitude near the ground and in fast flight,
// worked out in MirageSITL's physics session (here rather than in @mirage/sensors, which depends on this package) and delivered to ArduPilot as its own barometer offset (SIM_BAROn_GLITCH,
// the stakeholder's decision of 2026-11-07: stock ArduCopter V4.7.2 SITL creates no MSP barometer, so a full reading
// cannot be delivered). Noise and sensor delay stay ArduPilot's own (SIM_BAROn_RND, SIM_BAROn_DELAY).
//
// The error at the static port, Pa, is the sum of the effects that are on:
//
//   position error   Σ_j C_j(sign u_j) · ½ρ·u_j²     u = the vehicle's velocity through the air, body FRD axes
//   ground cushion   k · q_i · exp(−z / (λ·R̄))      q_i = T / (4A), z the port's height above the ground
//   prop wash        c · q_i
//   drift            r · (t − t_on) + κ · (T − T_on)
//   pressure trend   (τ / 3600) · (t − t_on)
//
// q_i is the dynamic pressure of the induced velocity of momentum theory in hover, ½ρv_i² with v_i = √(T / (2ρA)),
// for the rotors' total thrust T and total disc area A, so ρ cancels. The position error has the form of ArduPilot's
// SITL barometer (AP_Baro_SITL::wind_pressure_correction, SIM_BAROn_WCF_*), one coefficient per signed body axis. The
// cushion's exponential shape in z/R̄ and its two constants are a modelling choice, not a measured law: logged takeoff
// and landing dips would fit them (BLOCKED_EXTERNAL). Drift and trend accumulate from the tick their effect goes on.
//
// `step` runs in the physics step and allocates nothing; `set` runs at a tick boundary and allocates nothing. Neither takes
// nor returns a floating-point number: V8 boxes doubles that cross a call it does not inline, so inputs go through `input`
// and the result is `errorPa`.

/** The five effects, in the order of `BarometerErrors.components`. */
export const BarometerEffect = Object.freeze({ PositionError: 0, GroundCushion: 1, PropWash: 2, Drift: 3, PressureTrend: 4 });
export type BarometerEffectIndex = (typeof BarometerEffect)[keyof typeof BarometerEffect];
export const BAROMETER_EFFECT_COUNT = 5;
/** Values each effect takes, intensity applied: 6, [k, λ], [c], [r Pa/s, κ Pa/K], [τ Pa/h]. */
export const BAROMETER_EFFECT_VALUES: readonly number[] = Object.freeze([6, 2, 1, 2, 1]);

/** Slots of `BarometerErrors.input`, written by the dynamics after each step. */
export const BarometerInput = Object.freeze({
  /** Air density at the vehicle, kg/m³. */
  DensityKgM3: 0,
  /** Air temperature at the vehicle, K. */
  TemperatureK: 1,
  /** The vehicle's velocity through the air in body FRD axes, m/s. */
  AirForwardMps: 2, AirRightMps: 3, AirDownMps: 4,
  /** Height of the static port above the ground below it, m; infinite without ground. */
  HeightM: 5,
  /** The rotors' total thrust, N, and total disc area, m². */
  ThrustN: 6, DiscAreaM2: 7,
  /** Mean rotor radius, m. */
  MeanRadiusM: 8,
  /** Simulated time of the step, s. */
  TimeS: 9,
});
const INPUT_SLOTS = 10;

export class BarometerErrors {
  /** Written by the dynamics before `step`. */
  readonly input = new Float64Array(INPUT_SLOTS);
  /** Each effect's error of the last step, Pa, in `BarometerEffect` order; 0 while it is off. */
  readonly components = new Float64Array(BAROMETER_EFFECT_COUNT);
  /** The sum of the components, Pa: a higher pressure reads as a lower altitude. */
  errorPa = 0;
  private readonly on = new Uint8Array(BAROMETER_EFFECT_COUNT);
  private readonly values = new Float64Array(6 * BAROMETER_EFFECT_COUNT);
  /** Drift and trend start times and the drift's start temperature; NaN until the first step after they go on. */
  private driftStartS = Number.NaN;
  private driftStartK = Number.NaN;
  private trendStartS = Number.NaN;
  private count = 0;

  /** True while any effect is on. */
  get active(): boolean { return this.count > 0; }

  /** Turns one effect on with its values (intensity applied) or off. Off forgets it: the next time on starts afresh. */
  set(effect: BarometerEffectIndex, active: boolean, values: ArrayLike<number>): void {
    const n = BAROMETER_EFFECT_VALUES[effect] ?? 0;
    if (active && values.length !== n) throw new Error(`Barometer effect ${effect} takes ${n} values`);
    const was = this.on[effect] === 1;
    this.on[effect] = active ? 1 : 0;
    this.count += (active ? 1 : 0) - (was ? 1 : 0);
    for (let k = 0; k < 6; k++) this.values[effect * 6 + k] = active && k < n ? values[k]! : 0;
    if (!active || !was) {
      if (effect === BarometerEffect.Drift) { this.driftStartS = Number.NaN; this.driftStartK = Number.NaN; }
      if (effect === BarometerEffect.PressureTrend) this.trendStartS = Number.NaN;
    }
    if (!active) {
      const c = this.components;
      c[effect] = 0;
      this.errorPa = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!;
    }
  }

  /** Every effect off, as an epoch that never had any. */
  reset(): void {
    this.on.fill(0); this.values.fill(0); this.components.fill(0); this.count = 0; this.errorPa = 0;
    this.driftStartS = Number.NaN; this.driftStartK = Number.NaN; this.trendStartS = Number.NaN;
  }

  /** The error of this step from `input` into `errorPa`, Pa. With every effect off it does nothing and the error stays 0. */
  step(): void {
    if (this.count === 0) return;
    const x = this.input, v = this.values, c = this.components, on = this.on;
    const rho = x[BarometerInput.DensityKgM3]!, t = x[BarometerInput.TimeS]!;
    if (on[BarometerEffect.PositionError] === 1) {
      let sum = 0;
      for (let j = 0; j < 3; j++) {
        const u = x[BarometerInput.AirForwardMps + j]!, coefficient = u > 0 ? v[j]! : v[3 + j]!;
        sum += coefficient * 0.5 * rho * u * u;
      }
      c[BarometerEffect.PositionError] = sum;
    }
    if (on[BarometerEffect.GroundCushion] === 1 || on[BarometerEffect.PropWash] === 1) {
      const thrust = x[BarometerInput.ThrustN]!, area = x[BarometerInput.DiscAreaM2]!;
      const induced = thrust > 0 && area > 0 ? thrust / (4 * area) : 0;
      if (on[BarometerEffect.GroundCushion] === 1) {
        const k = v[6]!, decay = v[7]!, radius = x[BarometerInput.MeanRadiusM]!, z = x[BarometerInput.HeightM]!;
        c[BarometerEffect.GroundCushion] = Number.isFinite(z) && radius > 0 ? k * induced * Math.exp(-Math.max(z, 0) / (decay * radius)) : 0;
      }
      if (on[BarometerEffect.PropWash] === 1) c[BarometerEffect.PropWash] = v[12]! * induced;
    }
    if (on[BarometerEffect.Drift] === 1) {
      const temperature = x[BarometerInput.TemperatureK]!;
      if (Number.isNaN(this.driftStartS)) { this.driftStartS = t; this.driftStartK = temperature; }
      c[BarometerEffect.Drift] = v[18]! * (t - this.driftStartS) + v[19]! * (temperature - this.driftStartK);
    }
    if (on[BarometerEffect.PressureTrend] === 1) {
      if (Number.isNaN(this.trendStartS)) this.trendStartS = t;
      c[BarometerEffect.PressureTrend] = (v[24]! / 3600) * (t - this.trendStartS);
    }
    this.errorPa = c[0]! + c[1]! + c[2]! + c[3]! + c[4]!;
  }
}

/**
 * The ArduPilot barometer offset for a pressure error: SIM_BAROn_GLITCH is added to the altitude AP_Baro_SITL converts
 * to pressure, so a pressure higher by Δp is an altitude lower by Δp·|dh/dp|. `altitudePerPascalM` is dh/dp at the
 * home altitude (negative; `barometerAltitudePerPascal` of `@mirage/aircraft/sensor-parameters`), as TASK-147 converts
 * the Sensors tab's barometer bias. The result is a float32, as PARAM_SET carries it.
 */
export function barometerGlitchM(baseGlitchM: number, errorPa: number, altitudePerPascalM: number): number {
  return Math.fround(baseGlitchM + errorPa * altitudePerPascalM);
}
