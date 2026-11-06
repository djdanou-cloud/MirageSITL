import { BetRotorEngineV2, BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS } from '../../wasm-bet/src/rotor-v2.ts';
import type { BoundPolar, BoundRotorDefinition } from '../../wasm-bet/src/rotor.ts';
import { atmosphereFromState, isaTroposphere } from './atmosphere.ts';
import type { BenchMeasurements } from './bench-import.ts';

// Measured-mode propulsion calibration (TASK-145, SPECS_SIMULATION_ENGINES "Propulsion calibration: TASK-145"): the BET rotor of one
// exact bench combination is fitted to the bench's static thrust and torque versus RPM by scaling its section polar (lift coefficient
// by s_L, drag coefficient by s_D), and its motor to the bench's electrical power by the winding resistance and no-load current at the
// motor card's KV. The fit keeps the BET physics where the bench has no data (inflow, advance ratio, density) and moves only what the
// bench measures; MirageSITL sets no fit tolerance (SA-01), so the residuals are recorded and shown, never judged. A calibration
// belongs to its combination and is never transferred. Configuration-time code only: the static solves run the WASM rotor off-line.

/** The polar scales a fit may reach: beyond them the polar, not its level, is wrong. */
export const POLAR_SCALE_RANGE = Object.freeze([0.25, 4] as const);
/** F-03: the warning starts 10% beyond the measured RPM range. */
export const CALIBRATION_RPM_MARGIN = 0.1;
/**
 * A static bench holds the advance ratio J = V/(nD) at zero. Steps above this raise the extrapolation flag: the J of a 0.5 m/s draught
 * on a 10-inch propeller at 6000 rpm, so the drift of a hover in still air does not raise it, while wind, forward flight, climb or descent do
 * (TASK-145 engineering default under F-03; it only raises the flag).
 */
export const CALIBRATION_STATIC_ADVANCE_RATIO = 0.02;
/** F-03's 10% margin applied to the single density of a bench run. */
export const CALIBRATION_DENSITY_MARGIN = 0.1;
/** Shaft inertia of the static solve, kg·m²: the rotor keeps its bench speed to 1e-9 over the solve while its inflow settles. */
const SOLVE_INERTIA_KG_M2 = 1e6;
/** The solve's inflow lag and length: 100 time constants at 800 Hz. */
const SOLVE_INFLOW_TAU_S = 0.005, SOLVE_STEPS = 400, SOLVE_HZ = 800;

export interface PolarScales { readonly lift: number; readonly drag: number }
/** One bench point beside the calibrated model at its speed. */
export interface RotorResidual {
  readonly rpm: number;
  readonly thrustN: number; readonly modelThrustN: number;
  readonly torqueNm: number | null; readonly modelTorqueNm: number;
}
export interface MotorResidual {
  readonly rpm: number;
  /** V·I at the supply. */
  readonly electricalPowerW: number;
  readonly modelElectricalPowerW: number;
  /** The motor voltage the model needs; above the supply voltage the point is beyond a full duty. */
  readonly modelMotorVoltageV: number;
  readonly supplyVoltageV: number;
}
export interface MotorFit {
  /** The motor card's KV, rpm/V: the fit holds it, since supply-side data cannot separate it from the resistance. */
  readonly kvRpmPerV: number;
  readonly resistanceOhm: number;
  readonly noLoadCurrentA: number;
  readonly residuals: readonly MotorResidual[];
  readonly rmsResidualW: number;
}
export interface CalibrationEnvelope {
  readonly rpmMin: number; readonly rpmMax: number;
  readonly densityKgM3: number;
  /** The advance ratio the static data hold up to. */
  readonly advanceRatioMax: number;
}
export interface PropulsionFit {
  readonly scales: PolarScales;
  /** What the fit could not set: drag without measured torque, the motor without torque, voltage and current. */
  readonly notFitted: readonly string[];
  readonly residuals: readonly RotorResidual[];
  readonly rmsThrustResidualN: number;
  readonly rmsTorqueResidualNm: number | null;
  readonly motor: MotorFit | null;
  readonly envelope: CalibrationEnvelope;
  readonly iterations: number;
}
export interface PropulsionFitInput {
  readonly module: WebAssembly.Module;
  /** The combination's rotor as the profile builds it, with its catalog polar. */
  readonly rotor: BoundRotorDefinition;
  readonly bench: BenchMeasurements;
  /** The motor card's KV, rpm/V; null skips the motor fit. */
  readonly kvRpmPerV: number | null;
}

/** The section polar with its lift and drag coefficients scaled; angle, Reynolds and Mach axes and confidence unchanged. */
export function scaledPolar(polar: BoundPolar, scales: PolarScales): BoundPolar {
  for (const value of [scales.lift, scales.drag]) {
    if (!(value >= POLAR_SCALE_RANGE[0] && value <= POLAR_SCALE_RANGE[1])) throw new Error(`A polar scale must be ${POLAR_SCALE_RANGE[0]} to ${POLAR_SCALE_RANGE[1]}`);
  }
  return { alphaRad: polar.alphaRad, reynolds: polar.reynolds, mach: polar.mach, confidence: polar.confidence,
    cl: polar.cl.map(value => value * scales.lift), cd: polar.cd.map(value => value * scales.drag) };
}

interface Air { readonly densityKgM3: number; readonly viscosityPaS: number; readonly soundMps: number }
function benchAir(bench: BenchMeasurements): Air {
  const { airTemperatureK, airPressurePa } = bench.conditions;
  if (airTemperatureK !== null && airPressurePa !== null) {
    const air = atmosphereFromState({ temperatureK: airTemperatureK, pressurePa: airPressurePa });
    return { densityKgM3: bench.airDensityKgM3, viscosityPaS: air.dynamicViscosityPaS, soundMps: air.speedOfSoundMps };
  }
  // A density without its temperature: viscosity and sound speed of the ISA sea level, which move the static loads by under 1e-3.
  const isa = isaTroposphere(0);
  return { densityKgM3: bench.airDensityKgM3, viscosityPaS: isa.dynamicViscosityPaS, soundMps: isa.speedOfSoundMps };
}

/**
 * Static thrust and torque of the rotor at each speed in still air: each speed is a rotor of its own with a shaft so heavy that it
 * keeps its speed while the inflow settles. Thrust is the axial hub force (+z_h), torque the magnitude of the aerodynamic shaft torque.
 */
export function staticLoads(module: WebAssembly.Module, rotor: BoundRotorDefinition, air: Air, rpms: readonly number[]): { thrustN: number[]; torqueNm: number[] } {
  if (rpms.length < 1 || rpms.length > 32) throw new Error('A static solve takes 1 to 32 speeds');
  const definitions = rpms.map(rpm => ({
    ...rotor, initialOmegaRadS: rpm * Math.PI / 30, inflowTauS: SOLVE_INFLOW_TAU_S,
    geometry: { ...rotor.geometry, shaftInertiaKgM2: SOLVE_INERTIA_KG_M2, bearingViscousNmPerRadS: 0 },
  }));
  const engine = new BetRotorEngineV2(module, definitions, SOLVE_HZ);
  try {
    for (let i = 0; i < rpms.length; i++) {
      const row = i * BOUND_V2_INPUT_DOUBLES;
      engine.input[row] = air.densityKgM3; engine.input[row + 1] = air.viscosityPaS; engine.input[row + 2] = air.soundMps;
    }
    const before = new Float64Array(rpms.length);
    for (let n = 0; n < SOLVE_STEPS; n++) {
      for (let i = 0; i < rpms.length; i++) before[i] = engine.output[i * BOUND_V2_OUTPUT_SLOTS + 2] ?? 0;
      if (!engine.stepInto()) throw new Error(`Rotor step failed with status ${engine.lastStatus}`);
    }
    const thrustN: number[] = [], torqueNm: number[] = [];
    for (let i = 0; i < rpms.length; i++) {
      const out = i * BOUND_V2_OUTPUT_SLOTS, thrust = engine.output[out + 2] ?? NaN;
      if (Math.abs(thrust - (before[i] ?? NaN)) > 1e-9 * Math.max(1, Math.abs(thrust))) throw new Error(`The static solve at ${rpms[i]} rpm did not settle`);
      const omega = engine.output[out + 9] ?? NaN, wanted = (rpms[i] ?? NaN) * Math.PI / 30;
      if (Math.abs(Math.abs(omega) - wanted) > 1e-6 * wanted) throw new Error(`The static solve at ${rpms[i]} rpm did not hold its speed`);
      thrustN.push(thrust); torqueNm.push(Math.abs(engine.output[out + 10] ?? NaN));
    }
    return { thrustN, torqueNm };
  } finally {
    engine.dispose();
  }
}

const rms = (values: readonly number[]): number => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
/** Solves the 2×2 (or 1×1) normal equations of a Levenberg–Marquardt step. */
function solveStep(jtj: number[], jtr: number[], lambda: number): number[] {
  if (jtr.length === 1) return [-(jtr[0] ?? 0) / ((jtj[0] ?? 0) * (1 + lambda))];
  const a = (jtj[0] ?? 0) * (1 + lambda), b = jtj[1] ?? 0, c = jtj[2] ?? 0, d = (jtj[3] ?? 0) * (1 + lambda), det = a * d - b * c;
  if (!(Math.abs(det) > 0)) throw new Error('The calibration is singular: the bench data cannot set both polar scales');
  return [-(d * (jtr[0] ?? 0) - b * (jtr[1] ?? 0)) / det, -(-c * (jtr[0] ?? 0) + a * (jtr[1] ?? 0)) / det];
}

/**
 * Fits the polar scales to the bench's thrust (and torque, when measured) by Levenberg–Marquardt in log scale, each curve weighted by
 * its own RMS so both count alike; then the motor's resistance and no-load current to the bench's electrical power at the card's KV.
 */
export function fitPropulsion(input: PropulsionFitInput): PropulsionFit {
  const { bench } = input, points = bench.points;
  if (points.length < 3) throw new Error('A calibration needs at least three bench points');
  if (points.length > 32) throw new Error('A calibration takes at most 32 bench points');
  // A calibration belongs to its combination: the bench propeller must be the rotor's.
  const diameterM = 2 * input.rotor.geometry.radiusM;
  if (Math.abs(bench.diameterM - diameterM) > 1e-6 * diameterM) {
    throw new Error(`The bench propeller's diameter of ${bench.diameterM} m is not the rotor's ${diameterM} m: a calibration belongs to its own combination`);
  }
  const air = benchAir(bench), rpms = points.map(point => point.rpm), thrust = points.map(point => point.thrustN);
  const torque = points.every(point => point.torqueNm !== null) ? points.map(point => point.torqueNm ?? 0) : null;
  const notFitted: string[] = [];
  if (!torque) notFitted.push('drag scale: the bench measured no torque at every point, so the drag coefficient keeps its polar value');
  const sigmaT = rms(thrust) || 1, sigmaQ = torque ? rms(torque) || 1 : 1;
  const residualsOf = (logScales: readonly number[]): number[] => {
    const scales = { lift: Math.exp(logScales[0] ?? 0), drag: torque ? Math.exp(logScales[1] ?? 0) : 1 };
    const loads = staticLoads(input.module, { ...input.rotor, polar: scaledPolar(input.rotor.polar, scales) }, air, rpms);
    const r = loads.thrustN.map((value, i) => (value - (thrust[i] ?? 0)) / sigmaT);
    if (torque) r.push(...loads.torqueNm.map((value, i) => (value - (torque[i] ?? 0)) / sigmaQ));
    return r;
  };
  const size = torque ? 2 : 1, h = 1e-5;
  let x = new Array<number>(size).fill(0), r = residualsOf(x), cost = r.reduce((sum, value) => sum + value * value, 0), lambda = 1e-3, iterations = 0;
  for (; iterations < 40; iterations++) {
    const columns: number[][] = [];
    for (let k = 0; k < size; k++) {
      const plus = [...x]; plus[k] = (plus[k] ?? 0) + h;
      const minus = [...x]; minus[k] = (minus[k] ?? 0) - h;
      const rp = residualsOf(plus), rm = residualsOf(minus);
      columns.push(rp.map((value, i) => (value - (rm[i] ?? 0)) / (2 * h)));
    }
    const jtj = size === 1 ? [columns[0]!.reduce((s, v) => s + v * v, 0)]
      : [0, 0, 0, 0].map((_, k) => columns[Math.floor(k / 2)]!.reduce((s, v, i) => s + v * (columns[k % 2]![i] ?? 0), 0));
    const jtr = columns.map(column => column.reduce((s, v, i) => s + v * (r[i] ?? 0), 0));
    let accepted = false;
    for (let attempt = 0; attempt < 20 && !accepted; attempt++) {
      const step = solveStep(jtj, jtr, lambda), next = x.map((value, k) => value + (step[k] ?? 0));
      if (next.some(value => !(Math.exp(value) >= POLAR_SCALE_RANGE[0] && Math.exp(value) <= POLAR_SCALE_RANGE[1]))) { lambda *= 10; continue; }
      const rn = residualsOf(next), costNext = rn.reduce((sum, value) => sum + value * value, 0);
      if (costNext <= cost) {
        const moved = Math.max(...step.map(Math.abs));
        x = next; r = rn; cost = costNext; lambda = Math.max(lambda / 10, 1e-12); accepted = true;
        if (moved < 1e-11) { iterations++; return finish(); }
      } else lambda *= 10;
    }
    if (!accepted) break;
  }
  return finish();

  function finish(): PropulsionFit {
    const scales = { lift: Math.exp(x[0] ?? 0), drag: torque ? Math.exp(x[1] ?? 0) : 1 };
    const loads = staticLoads(input.module, { ...input.rotor, polar: scaledPolar(input.rotor.polar, scales) }, air, rpms);
    const residuals = points.map((point, i): RotorResidual => ({ rpm: point.rpm, thrustN: point.thrustN, modelThrustN: loads.thrustN[i] ?? NaN,
      torqueNm: point.torqueNm, modelTorqueNm: loads.torqueNm[i] ?? NaN }));
    const motor = input.kvRpmPerV !== null && torque && points.every(point => point.voltageV !== null && point.currentA !== null)
      ? fitMotor(input.kvRpmPerV, points.map(point => ({ rpm: point.rpm, torqueNm: point.torqueNm ?? 0, voltageV: point.voltageV ?? 0, currentA: point.currentA ?? 0 })))
      : null;
    if (!motor) notFitted.push(input.kvRpmPerV === null ? 'motor: the motor card states no KV' : 'motor: the bench measured no torque, voltage and current at every point');
    return {
      scales, notFitted, residuals, iterations, motor,
      rmsThrustResidualN: rms(residuals.map(row => row.modelThrustN - row.thrustN)),
      rmsTorqueResidualNm: torque ? rms(residuals.map(row => row.modelTorqueNm - (row.torqueNm ?? 0))) : null,
      envelope: { rpmMin: Math.min(...rpms), rpmMax: Math.max(...rpms), densityKgM3: air.densityKgM3, advanceRatioMax: 0 },
    };
  }
}

interface ElectricalPoint { readonly rpm: number; readonly torqueNm: number; readonly voltageV: number; readonly currentA: number }
/**
 * The DC motor of TASK-092 at the card's KV: I_m = K_v·Q + I_0 and V_m = ω/K_v + R·I_m, with a lossless ESC, so the supply power
 * V·I equals V_m·I_m; R and I_0 are fitted by Gauss–Newton. ESC losses therefore appear in R and I_0, which the record says.
 */
export function fitMotor(kvRpmPerV: number, points: readonly ElectricalPoint[]): MotorFit {
  if (!(kvRpmPerV > 0) || points.length < 2) throw new Error('A motor fit needs a positive KV and at least two points');
  const kv = kvRpmPerV * Math.PI / 30;
  const model = (resistance: number, noLoad: number, point: ElectricalPoint) => {
    const omega = point.rpm * Math.PI / 30, current = kv * point.torqueNm + noLoad, voltage = omega / kv + resistance * current;
    return { current, voltage, power: voltage * current };
  };
  let resistance = 0.05, noLoad = 0.5;
  for (let iteration = 0; iteration < 50; iteration++) {
    let a = 0, b = 0, d = 0, g0 = 0, g1 = 0;
    for (const point of points) {
      const m = model(resistance, noLoad, point), r = m.power - point.voltageV * point.currentA;
      const jr = m.current * m.current, ji = m.voltage + resistance * m.current;
      a += jr * jr; b += jr * ji; d += ji * ji; g0 += jr * r; g1 += ji * r;
    }
    const det = a * d - b * b;
    if (!(Math.abs(det) > 0)) throw new Error('The motor fit is singular');
    const dr = -(d * g0 - b * g1) / det, di = -(-b * g0 + a * g1) / det;
    resistance = Math.max(0, resistance + dr); noLoad = Math.max(0, noLoad + di);
    if (Math.abs(dr) < 1e-13 && Math.abs(di) < 1e-12) break;
  }
  const residuals = points.map((point): MotorResidual => {
    const m = model(resistance, noLoad, point);
    return { rpm: point.rpm, electricalPowerW: point.voltageV * point.currentA, modelElectricalPowerW: m.power, modelMotorVoltageV: m.voltage, supplyVoltageV: point.voltageV };
  });
  return { kvRpmPerV, resistanceOhm: resistance, noLoadCurrentA: noLoad, residuals, rmsResidualW: rms(residuals.map(row => row.modelElectricalPowerW - row.electricalPowerW)) };
}
