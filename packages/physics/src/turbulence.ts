import { SeededRandom } from '@mirage/test-support/prng';

// Dryden turbulence (TASK-106), MIL-F-8785C, low altitude. Three channels, u along the mean wind, v across it and w down:
//   H_u = σ_u·√(2·L_u/(π·V)) / (1 + (L_u/V)·s)
//   H_v,w = σ·√(L/(π·V))·(1 + √3·(L/V)·s) / (1 + (L/V)·s)²
// The discretization is exact: sampled at any rate, the states have exactly the variance and autocovariance of the continuous
// filter, so nothing depends on how small the step is. The states have unit variance, so a change of σ scales the output and
// leaves the state alone. Coefficients refresh on tick indices, never on wall time, about 50 times a second at every rate.
// One uniform wind field: rotational gusts, inter-hub coherence, and the von Kármán and Kaimal spectra are not modelled here.

/** Fixed RNG stream IDs (uint32). One stream per normal draw, so no channel's draws depend on another's. */
export const DRYDEN_STREAMS = Object.freeze({ u: 0x00106001, v1: 0x00106002, v2: 0x00106003, w1: 0x00106004, w2: 0x00106005 });
const FEET_PER_METRE = 1 / 0.3048;
/** MIL-F-8785C's low-altitude form holds for 10 ft to 1000 ft. Below it holds the 10 ft values, above it the 1000 ft ones, where the three channels agree. */
export const DRYDEN_MIN_HEIGHT_M = 10 * 0.3048, DRYDEN_MAX_HEIGHT_M = 1000 * 0.3048;
/** W20, the mean wind at 20 ft that sets the turbulence's strength, m/s: the range the wind model holds for an RMS, and past MIL-F-8785C's severe 45 kt. */
export const DRYDEN_MAX_W20_MPS = 50;
/** About 50 refreshes a second at every physics rate. */
export const DRYDEN_REFRESH_HZ = 50;

/** Slots of `stepAddInto`'s input, so no double crosses a call where V8 can box it. */
export const DRYDEN_HEIGHT = 0, DRYDEN_RELATIVE_NORTH = 1, DRYDEN_RELATIVE_EAST = 2, DRYDEN_RELATIVE_DOWN = 3, DRYDEN_MEAN_NORTH = 4, DRYDEN_MEAN_EAST = 5, DRYDEN_INPUT_SLOTS = 6;
/** Slots of `coefficients`: σ per unit W20, 1/1; scale lengths, m. */
const SIGMA_HORIZONTAL = 0, SIGMA_VERTICAL = 1;
const U_A = 2, U_B = 3, V_A = 4, V_B = 5, V_C = 6, V_D = 7, V_L11 = 8, V_L21 = 9, V_L22 = 10, W_A = 11, W_B = 12, W_C = 13, W_D = 14, W_L11 = 15, W_L21 = 16, W_L22 = 17, AXIS_N = 18, AXIS_E = 19, ADVECTION = 20,
  /** θ of the channel being written: a typed slot, because V8 can box a double call argument. */
  THETA = 21;
const COEFFICIENT_SLOTS = 22;
const SQRT3 = Math.sqrt(3);

export interface DrydenScales { readonly lengthHorizontalM: number; readonly lengthVerticalM: number; readonly sigmaHorizontalPerW20: number; readonly sigmaVerticalPerW20: number }
/**
 * MIL-F-8785C low altitude, with h in feet: L_w = h, L_u = L_v = h/(0.177 + 0.000823·h)^1.2, σ_w = 0.1·W20,
 * σ_u = σ_v = σ_w/(0.177 + 0.000823·h)^0.4.
 */
export function drydenScales(heightM: number): DrydenScales {
  const h = Math.min(Math.max(heightM, DRYDEN_MIN_HEIGHT_M), DRYDEN_MAX_HEIGHT_M) * FEET_PER_METRE, base = 0.177 + 0.000823 * h;
  return { lengthHorizontalM: (h / base ** 1.2) / FEET_PER_METRE, lengthVerticalM: h / FEET_PER_METRE, sigmaHorizontalPerW20: 0.1 / base ** 0.4, sigmaVerticalPerW20: 0.1 };
}

/**
 * The noise covariance of the two-state channel over one step of θ = dt/τ, as Q = I − Φ·Φᵀ, whose factor drives the unit-variance
 * states. x = 2θ. Q11 = 1 − e^(−x)·(1 + x + x²/2) cancels to x³/6 for a small x, where a step is short against the eddy, so it
 * comes from its series there.
 */
function writeChannel(out: Float64Array, a: number): void {
  const theta = out[THETA]!, decay = Math.exp(-theta), x = 2 * theta, e2 = decay * decay;
  out[a] = decay * (1 + theta); out[a + 1] = decay * theta; out[a + 2] = -decay * theta; out[a + 3] = decay * (1 - theta);
  let q11: number;
  if (x < 0.5) {
    let term = x * x * x / 6, sum = term;
    for (let k = 4; k < 16; k++) { term *= x / k; sum += term; }
    q11 = e2 * sum;
  } else q11 = 1 - e2 * (1 + x + 0.5 * x * x);
  const q12 = e2 * 0.5 * x * x, q22 = -Math.expm1(-x) + e2 * (x - 0.5 * x * x);
  const l11 = Math.sqrt(q11), l21 = q12 / l11;
  out[a + 4] = l11; out[a + 5] = l21; out[a + 6] = Math.sqrt(Math.max(q22 - l21 * l21, 0));
}


export class DrydenTurbulence {
  readonly hz: number;
  readonly refreshTicks: number;
  private readonly dt: number;
  private readonly coefficients = new Float64Array(COEFFICIENT_SLOTS);
  /** The states: u; v's two; w's two. */
  private readonly state = new Float64Array(5);
  private readonly noise = new Float64Array(5);
  /** W20, m/s, and the intensity, typed slots because a tick rewrites them and V8 can box a double field. */
  private readonly strength = new Float64Array(2);
  private readonly uRandom: SeededRandom; private readonly v1Random: SeededRandom; private readonly v2Random: SeededRandom;
  private readonly w1Random: SeededRandom; private readonly w2Random: SeededRandom;
  private ticks = 0;
  /** The latest channels, m/s: u along the mean wind, v across it, w down. */
  readonly channels = new Float64Array(3);

  constructor(hz: number) {
    if (!Number.isInteger(hz) || hz < 2 * DRYDEN_REFRESH_HZ) throw new Error('Invalid Dryden rate');
    this.hz = hz; this.dt = 1 / hz; this.refreshTicks = Math.max(1, Math.round(hz / DRYDEN_REFRESH_HZ));
    this.uRandom = new SeededRandom(0, DRYDEN_STREAMS.u); this.v1Random = new SeededRandom(0, DRYDEN_STREAMS.v1); this.v2Random = new SeededRandom(0, DRYDEN_STREAMS.v2);
    this.w1Random = new SeededRandom(0, DRYDEN_STREAMS.w1); this.w2Random = new SeededRandom(0, DRYDEN_STREAMS.w2);
  }
  /** W20 sets the strength and the slowest the turbulence is carried past; intensity multiplies the strength alone. */
  setStrengthFrom(values: Float64Array, w20Index: number, intensityIndex: number): void {
    this.strength[0] = values[w20Index]!; this.strength[1] = values[intensityIndex]!;
  }
  /**
   * Starts from the seed, with the states drawn from their stationary distribution, as if the air had been turbulent all along:
   * the first tick is at full strength and there is no spin-up. Allocation-free.
   */
  restartFrom(values: Float64Array, seedIndex: number): void {
    this.uRandom.resetFrom(values, seedIndex, DRYDEN_STREAMS.u); this.v1Random.resetFrom(values, seedIndex, DRYDEN_STREAMS.v1); this.v2Random.resetFrom(values, seedIndex, DRYDEN_STREAMS.v2);
    this.w1Random.resetFrom(values, seedIndex, DRYDEN_STREAMS.w1); this.w2Random.resetFrom(values, seedIndex, DRYDEN_STREAMS.w2);
    const s = this.state;
    this.uRandom.nextGaussianInto(s, 0); this.v1Random.nextGaussianInto(s, 1); this.v2Random.nextGaussianInto(s, 2); this.w1Random.nextGaussianInto(s, 3); this.w2Random.nextGaussianInto(s, 4);
    this.ticks = 0;
  }
  /** The coefficients for this height and airspeed through the air, on a tick index; a slower advection than W20 reads as W20. */
  private refresh(input: Float64Array): void {
    const c = this.coefficients, rn = input[DRYDEN_RELATIVE_NORTH]!, re = input[DRYDEN_RELATIVE_EAST]!, rd = input[DRYDEN_RELATIVE_DOWN]!;
    const speed = Math.sqrt(rn * rn + re * re + rd * rd), advection = speed > this.strength[0]! ? speed : this.strength[0]!;
    const h = input[DRYDEN_HEIGHT]!, feet = (h < DRYDEN_MIN_HEIGHT_M ? DRYDEN_MIN_HEIGHT_M : h > DRYDEN_MAX_HEIGHT_M ? DRYDEN_MAX_HEIGHT_M : h) * FEET_PER_METRE;
    const base = 0.177 + 0.000823 * feet, lengthHorizontal = feet / Math.pow(base, 1.2) / FEET_PER_METRE, lengthVertical = feet / FEET_PER_METRE;
    c[SIGMA_HORIZONTAL] = 0.1 / Math.pow(base, 0.4); c[SIGMA_VERTICAL] = 0.1; c[ADVECTION] = advection;
    const thetaHorizontal = this.dt * advection / lengthHorizontal, thetaVertical = this.dt * advection / lengthVertical;
    const a = Math.exp(-thetaHorizontal);
    c[U_A] = a; c[U_B] = Math.sqrt(-Math.expm1(-2 * thetaHorizontal));
    c[THETA] = thetaHorizontal; writeChannel(c, V_A);
    c[THETA] = thetaVertical; writeChannel(c, W_A);
    // u lies along the horizontal mean wind; with none, along north.
    const mn = input[DRYDEN_MEAN_NORTH]!, me = input[DRYDEN_MEAN_EAST]!, horizontal = Math.sqrt(mn * mn + me * me);
    c[AXIS_N] = horizontal > 0 ? mn / horizontal : 1; c[AXIS_E] = horizontal > 0 ? me / horizontal : 0;
  }
  /** One tick: adds the turbulence to the NED wind in `windNed`. `input` holds the DRYDEN_* slots. Allocation-free. */
  stepAddInto(input: Float64Array, windNed: Float64Array): void {
    if (this.ticks % this.refreshTicks === 0) this.refresh(input);
    this.ticks++;
    const c = this.coefficients, s = this.state, n = this.noise;
    this.uRandom.nextGaussianInto(n, 0); this.v1Random.nextGaussianInto(n, 1); this.v2Random.nextGaussianInto(n, 2); this.w1Random.nextGaussianInto(n, 3); this.w2Random.nextGaussianInto(n, 4);
    s[0] = c[U_A]! * s[0]! + c[U_B]! * n[0]!;
    const v1 = s[1]!, v2 = s[2]!;
    s[1] = c[V_A]! * v1 + c[V_B]! * v2 + c[V_L11]! * n[1]!;
    s[2] = c[V_C]! * v1 + c[V_D]! * v2 + c[V_L21]! * n[1]! + c[V_L22]! * n[2]!;
    const w1 = s[3]!, w2 = s[4]!;
    s[3] = c[W_A]! * w1 + c[W_B]! * w2 + c[W_L11]! * n[3]!;
    s[4] = c[W_C]! * w1 + c[W_D]! * w2 + c[W_L21]! * n[3]! + c[W_L22]! * n[4]!;
    const strength = this.strength[0]! * this.strength[1]!, horizontal = strength * c[SIGMA_HORIZONTAL]!, vertical = strength * c[SIGMA_VERTICAL]!;
    const out = this.channels, u = horizontal * s[0], v = horizontal * 0.5 * (s[1] + SQRT3 * s[2]), w = vertical * 0.5 * (s[3] + SQRT3 * s[4]);
    out[0] = u; out[1] = v; out[2] = w;
    windNed[0] = windNed[0]! + c[AXIS_N]! * u - c[AXIS_E]! * v;
    windNed[1] = windNed[1]! + c[AXIS_E]! * u + c[AXIS_N]! * v;
    windNed[2] = windNed[2]! + w;
  }
  /** The speed the turbulence was last carried past at, m/s. */
  get advectionMps(): number { return this.coefficients[ADVECTION]!; }
}
