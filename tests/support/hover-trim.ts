import { newActuatorFrameV2, ActuatorFlagV2, newInput } from '../../packages/protocol/src/index.ts';
import { BetFlightDynamics, type BetFlightConfiguration } from '../../packages/physics/src/bet-dynamics.ts';
import { validateModelManifest, type RotorGeometry } from '../../packages/physics/src/model-manifest.ts';
import { BOUND_V2, BetRotorEngineV2 } from '../../packages/wasm-bet/src/rotor-v2.ts';

// TASK-144 physics-only hover trim, an oracle independent of FrameLayout and
// the body integrator. Each distinct rotor is swept to steady state in still
// air as a function of the effective motor voltage u = d·V: the TASK-092 motor
// law depends on d and V only through d·V, so one sweep serves every bus
// voltage. Newton steps of minimum norm then solve the six-axis force and
// moment balance about the CG for the per-rotor u and the hover's roll and
// pitch (tilted rotors and an offset CG hover slightly tilted), and the
// battery's loaded voltage turns u into duties. Test support only; allocation
// is not a concern.

const GRAVITY = 9.80665;
export interface RotorTable {
  readonly u: readonly number[];
  /** Steady hub wrench rows [Fx, Fy, Fz, Mx, My, Mz] (transmitted moment) per u. */
  readonly wrench: readonly (readonly number[])[];
  readonly omega: readonly number[];
  readonly terminalPowerW: readonly number[];
}
export interface HoverTrim {
  readonly u: readonly number[];
  /** Roll and pitch of the trimmed hover, rad (ZYX Euler, zero yaw). */
  readonly rollRad: number; readonly pitchRad: number;
  /** ∂(body wrench)/∂u_i at the trim: one column of six per rotor. */
  readonly jacobian: readonly (readonly number[])[];
  readonly duty: readonly number[];
  readonly omegaRadS: readonly number[];
  /** Per-rotor thrust along its own axis, N. */
  readonly thrustN: readonly number[];
  readonly busVoltageV: number;
  /** Total terminal power of the motors, W. */
  readonly motorPowerW: number;
  /** Final balance residual, N and N·m. */
  readonly residual: number;
}

function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]! || x >= xs[xs.length - 1]!) throw new Error(`u = ${x} V is outside the swept range`);
  let i = 0;
  while (x > xs[i + 1]!) i++;
  const t = (x - xs[i]!) / (xs[i + 1]! - xs[i]!);
  return ys[i]! + t * (ys[i + 1]! - ys[i]!);
}

/** Steady still-air hub wrench of one rotor of a configuration over u in (0, V_full], at `points` values. */
export function sweepRotor(module: WebAssembly.Module, configuration: BetFlightConfiguration, rotorIndex: number, hz: 800, points = 72): RotorTable {
  const model = validateModelManifest(configuration.manifest), geometry = model.rotors[rotorIndex], drive = configuration.drive;
  if (!geometry || !drive) throw new Error('A rotor with a production drive is required');
  const polar = configuration.polars.get(geometry.polarId), motor = drive.motors[rotorIndex];
  if (!polar || !motor) throw new Error('Missing polar or motor');
  const engine = new BetRotorEngineV2(module, [{ geometry, polar, initialOmegaRadS: 0, inflowTauS: configuration.inflowTauS[rotorIndex]!,
    inflowLimitMps: configuration.inflowLimitMps[rotorIndex]!, minimumConfidence: configuration.minimumConfidence }], hz);
  try {
    const vRef = drive.battery.openCircuitFullV;
    engine.drive.set([motor.resistanceOhm, motor.torqueConstantNmPerA, motor.currentLimitA, motor.brakeCurrentLimitA,
      motor.noLoadTorqueNm, motor.commandTauS, motor.updatePeriodS], 0);
    engine.driveMode[0] = BOUND_V2.driveEscDuty;
    engine.input.set([configuration.densityKgM3, configuration.viscosityPaS, configuration.soundMps]);
    engine.input[14] = vRef;
    const u: number[] = [], wrench: number[][] = [], omega: number[] = [], power: number[] = [];
    for (let k = 1; k <= points; k++) {
      const value = (vRef * k) / points;
      engine.input[13] = value / vRef;
      let previous = engine.output[9]!, change = Infinity;
      for (let n = 0; n < 2 * hz; n++) {
        if (!engine.stepInto()) throw new Error(`Rotor sweep step failed: ${engine.lastStatus}`);
        change = Math.abs(engine.output[9]! - previous); previous = engine.output[9]!;
      }
      if (change > 1e-8 * Math.max(previous, 1)) throw new Error(`u = ${value} V did not settle`);
      const o = engine.output;
      u.push(value); wrench.push([o[0]!, o[1]!, o[2]!, o[6]!, o[7]!, o[8]!]); omega.push(o[9]!); power.push(o[21]!);
    }
    return { u, wrench, omega, terminalPowerW: power };
  } finally {
    engine.dispose();
  }
}

/** Row-major hub-to-body rotation of a wxyz quaternion. */
function rotation(q: readonly number[]): number[] {
  const n = Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!), w = q[0]! / n, x = q[1]! / n, y = q[2]! / n, z = q[3]! / n;
  return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z),
    2 * (y * z - w * x), 2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
}
/** Body wrench about the CG of one rotor at u. */
function bodyWrench(table: RotorTable, rotor: RotorGeometry, u: number): number[] {
  const hub = [0, 1, 2, 3, 4, 5].map(j => interpolate(table.u, table.wrench.map(row => row[j]!), u));
  const r = rotation(rotor.hubToBody), p = rotor.hubPositionBodyM;
  const apply = (v: number[]): number[] => [0, 1, 2].map(i => r[i * 3]! * v[0]! + r[i * 3 + 1]! * v[1]! + r[i * 3 + 2]! * v[2]!);
  const f = apply(hub.slice(0, 3)), m = apply(hub.slice(3, 6));
  return [f[0]!, f[1]!, f[2]!, m[0]! + p[1]! * f[2]! - p[2]! * f[1]!, m[1]! + p[2]! * f[0]! - p[0]! * f[2]!, m[2]! + p[0]! * f[1]! - p[1]! * f[0]!];
}
/** Solves A·x = b for a small dense system by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length, m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = c + 1; r < n; r++) { const f = m[r]![c]! / m[c]![c]!; for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!; }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = m[r]![n]!; for (let k = r + 1; k < n; k++) s -= m[r]![k]! * x[k]!; x[r] = s / m[r]![r]!; }
  return x;
}

/** Rotor force the hover needs in body axes: minus the weight seen in a body rolled by φ and pitched by θ. */
function weightBalance(massKg: number, roll: number, pitch: number): number[] {
  const g = massKg * GRAVITY;
  return [g * Math.sin(pitch), -g * Math.sin(roll) * Math.cos(pitch), -g * Math.cos(roll) * Math.cos(pitch), 0, 0, 0];
}

/** Per-rotor u, attitude, duties and bus state that hold a hover in still air. */
export function trimHover(module: WebAssembly.Module, configuration: BetFlightConfiguration, hz: 800 = 800): HoverTrim {
  const model = validateModelManifest(configuration.manifest), drive = configuration.drive;
  if (!drive) throw new Error('A production drive is required');
  const tables = new Map<string, RotorTable>(), rotorTables: RotorTable[] = [];
  model.rotors.forEach((rotor, i) => {
    // Rotors that differ only in pose, ID or channel share a sweep.
    const key = JSON.stringify([{ ...rotor, id: 0, motorChannel: 0, hubPositionBodyM: 0, hubToBody: 0 }, drive.motors[i]]);
    let table = tables.get(key);
    if (!table) { table = sweepRotor(module, configuration, i, hz); tables.set(key, table); }
    rotorTables.push(table);
  });
  const n = model.rotorCount;
  const wrenchOf = (u: readonly number[]): number[] => {
    const total = [0, 0, 0, 0, 0, 0];
    model.rotors.forEach((rotor, i) => bodyWrench(rotorTables[i]!, rotor, u[i]!).forEach((v, j) => { total[j]! += v; }));
    return total;
  };
  // x = [u_1..u_n, roll, pitch]; start level at the equal u that carries the weight.
  let low = 0, high = drive.battery.openCircuitFullV;
  for (let k = 0; k < 60; k++) {
    const mid = (low + high) / 2;
    if (-wrenchOf(new Array<number>(n).fill(mid))[2]! < model.massKg * GRAVITY) low = mid; else high = mid;
  }
  let x = [...new Array<number>(n).fill((low + high) / 2), 0, 0];
  const residualOf = (v: readonly number[]): number[] => {
    const w = wrenchOf(v.slice(0, n)), target = weightBalance(model.massKg, v[n]!, v[n + 1]!);
    return w.map((value, j) => value - target[j]!);
  };
  const jacobianOf = (v: readonly number[]): number[][] => v.map((_value, k) => {
    const h = k < n ? 1e-4 : 1e-6, plus = [...v], minus = [...v];
    plus[k]! += h; minus[k]! -= h;
    const a = residualOf(plus), b = residualOf(minus);
    return a.map((value, j) => (value - b[j]!) / (2 * h));
  });
  let r = residualOf(x), norm = Math.hypot(...r);
  for (let iteration = 0; iteration < 50 && norm > 1e-9 * model.massKg * GRAVITY; iteration++) {
    const jac = jacobianOf(x);
    // Minimum-norm step: dx = -Jᵀ (J Jᵀ)⁻¹ r; the attitude columns keep J J ᵀ regular.
    const jjt = [0, 1, 2, 3, 4, 5].map(a => [0, 1, 2, 3, 4, 5].map(b => jac.reduce((s, col) => s + col[a]! * col[b]!, 0)));
    const y = solve(jjt, r);
    x = x.map((value, k) => value - jac[k]!.reduce((s, v, a) => s + v * y[a]!, 0));
    r = residualOf(x); norm = Math.hypot(...r);
  }
  const u = x.slice(0, n), jacobian = jacobianOf(x).slice(0, n);
  const power = model.rotors.reduce((s, _rotor, i) => s + interpolate(rotorTables[i]!.u, rotorTables[i]!.terminalPowerW, u[i]!), 0);
  const b = drive.battery, soc = drive.initialStateOfCharge, open = b.openCircuitEmptyV + (b.openCircuitFullV - b.openCircuitEmptyV) * soc;
  const demand = power + (drive.housePowerW ?? 0), R = b.internalResistanceOhm;
  const current = R > 0 ? (2 * demand) / (open + Math.sqrt(open * open - 4 * R * demand)) : demand / open;
  const busVoltageV = open - current * R;
  return {
    u, rollRad: x[n]!, pitchRad: x[n + 1]!, jacobian, duty: u.map(value => value / busVoltageV),
    omegaRadS: u.map((value, i) => interpolate(rotorTables[i]!.u, rotorTables[i]!.omega, value)),
    thrustN: u.map((value, i) => interpolate(rotorTables[i]!.u, rotorTables[i]!.wrench.map(row => row[2]!), value)),
    busVoltageV, motorPowerW: power, residual: norm,
  };
}

export interface HoverHold {
  /** Largest steady loop correction over the trim, relative to each motor's trim u. */
  readonly correctionRelative: number;
  readonly verticalSpeedMps: number; readonly bodyRateRadS: number;
  /** Angle between the final attitude and the trim attitude, rad. */
  readonly attitudeErrorRad: number;
}
/**
 * Flies the configuration in the air from the trim attitude, rotors at their
 * trim speeds, with the trim as feed-forward and a light loop around it:
 * attitude and rate damping about the trim attitude and vertical-speed
 * damping, mapped to rotor u by the minimum-norm inverse of the trim
 * Jacobian's thrust and moment rows,
 * divided by the measured bus voltage. If the trim holds, the loop's steady
 * corrections vanish. Returns the state after `seconds`.
 */
export function holdHover(module: WebAssembly.Module, base: BetFlightConfiguration, trim: HoverTrim, hz: 800 = 800, seconds = 4): HoverHold {
  const cr = Math.cos(trim.rollRad / 2), sr = Math.sin(trim.rollRad / 2), cp = Math.cos(trim.pitchRad / 2), sp = Math.sin(trim.pitchRad / 2);
  const q0 = [cr * cp, sr * cp, cr * sp, -sr * sp];
  const configuration: BetFlightConfiguration = { ...base, initialOmegaRadS: [...trim.omegaRadS], syntheticGroundDownM: undefined,
    initialBody: { ...base.initialBody, positionNedM: new Float64Array([0, 0, -20]), quaternionBodyToNed: new Float64Array(q0) } };
  const model = validateModelManifest(configuration.manifest), d = new BetFlightDynamics(module, configuration, hz), n = model.rotorCount;
  // The loop commands thrust and the three moments, as a multirotor mixer does, and leaves lateral force free:
  // with tilted rotors the lateral-force rows are nearly parallel to the moment rows. Minimum-norm inverse of
  // those four rows of the trim Jacobian: J⁺ = Jᵀ (J Jᵀ)⁻¹.
  const jac = trim.jacobian.map(col => col.slice(2)), jjt = [0, 1, 2, 3].map(a => [0, 1, 2, 3].map(b => jac.reduce((s, col) => s + col[a]! * col[b]!, 0)));
  const inertia = model.inertiaBodyKgM2, g = model.massKg;
  try {
    const frame = newActuatorFrameV2(), pilot = newInput();
    frame.motorMapId = configuration.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
    frame.actuatorCount = Math.max(...model.rotors.map(rotor => rotor.motorChannel)) + 1;
    let correction = new Array<number>(n).fill(0);
    for (let tick = 0; tick < seconds * hz; tick++) {
      const s = d.state;
      // Attitude error: rotation from the trim attitude to the current one, as a small-angle vector in body axes (q0⁻¹ ⊗ q).
      const w = q0[0]! * s.qw + q0[1]! * s.qx + q0[2]! * s.qy + q0[3]! * s.qz;
      const ex = q0[0]! * s.qx - q0[1]! * s.qw - q0[2]! * s.qz + q0[3]! * s.qy;
      const ey = q0[0]! * s.qy + q0[1]! * s.qz - q0[2]! * s.qw - q0[3]! * s.qx;
      const sign = w < 0 ? -1 : 1, kp = 16, kd = 8, kv = 2;
      // Body z points down: a descent (vd > 0) needs more negative Fz.
      const wrench = [-g * kv * s.vd,
        -inertia[0]! * (kp * 2 * sign * ex + kd * s.p), -inertia[4]! * (kp * 2 * sign * ey + kd * s.q), -inertia[8]! * kd * s.r];
      const y = solve(jjt, wrench);
      correction = jac.map(col => col.reduce((sum, v, a) => sum + v * y[a]!, 0));
      const bus = d.electrical[1]!;
      model.rotors.forEach((rotor, i) => { frame.normalizedActuators[rotor.motorChannel] = (trim.u[i]! + correction[i]!) / bus; });
      d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / hz; d.stepNow(pilot);
      if (d.fault !== '') throw new Error(d.fault);
    }
    const s = d.state, dot = Math.min(1, Math.abs(q0[0]! * s.qw + q0[1]! * s.qx + q0[2]! * s.qy + q0[3]! * s.qz));
    return {
      correctionRelative: Math.max(...correction.map((c, i) => Math.abs(c) / trim.u[i]!)),
      verticalSpeedMps: Math.abs(s.vd), bodyRateRadS: Math.hypot(s.p, s.q, s.r), attitudeErrorRad: 2 * Math.acos(dot),
    };
  } finally {
    d.dispose();
  }
}
