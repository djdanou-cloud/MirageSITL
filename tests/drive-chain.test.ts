import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { ARDUPILOT_SPIN_RANGE, escDriveFromManifest, fitThrustExpo, thrustExpoOfDrive } from '@mirage/physics/drive';
import { MotorFaults } from '@mirage/physics/motor-fault';
import { validateVehicleManifest } from '@mirage/physics/vehicle-manifest';
import { BetRotorEngine } from '@mirage/wasm-bet/rotor';
import { BOUND_V2_INPUT_DOUBLES, BOUND_V2_OUTPUT_SLOTS } from '@mirage/wasm-bet/rotor-v2';
import { validateModelManifest } from '../packages/physics/src/model-manifest.ts';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { StateReaderV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2 } from '@mirage/protocol';
import { PARITY_ESC_BATTERY, PARITY_ESC_MOTOR, parityAircraft, parityEscDrive } from './support/autopilot-parity.ts';

// TASK-092 drive chain: manifest values, ESC duty, motor, rotor and the shared
// battery bus inside BetFlightDynamics. Oracles: the bus power balance and
// charge integral, the linear open-circuit pack, a cut bridge carrying no
// current, the pre-TASK-092 torque-path trajectory, and ArduPilot's thrust curve.

const HZ = 800;
const MOTOR = PARITY_ESC_MOTOR, BATTERY = PARITY_ESC_BATTERY;
const HOUSE_W = 3;
/** The pack's open-circuit voltage, in the order the native battery evaluates it. */
const openCircuitV = (soc: number): number => BATTERY.openCircuitEmptyV + (BATTERY.openCircuitFullV - BATTERY.openCircuitEmptyV) * soc;
const ATMOSPHERE = { densityKgM3: 1.225, viscosityPaS: 1.789e-5, soundMps: 340 };

let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600000);

function escAircraft(soc = 0.9): BetFlightConfiguration {
  const c = parityAircraft();
  c.drive = parityEscDrive(soc, HOUSE_W);
  return c;
}
function parityRotor() {
  const c = parityAircraft(), model = validateModelManifest(c.manifest), geometry = model.rotors[0]!;
  const polar = c.polars.get(geometry.polarId);
  if (!polar) throw new Error('Missing parity polar');
  return { geometry, polar, initialOmegaRadS: 0, inflowTauS: 0.1, inflowLimitMps: 500, minimumConfidence: 0.9 };
}
const pilot = { flags: 3, throttle: 0, roll: 0, pitch: 0, yaw: 0, wallTimeMs: 0 };
function step(d: BetFlightDynamics, tick: number, throttle: number): void {
  d.nowMs = (tick + 0.5) * 1000 / HZ; pilot.wallTimeMs = d.nowMs; pilot.throttle = throttle;
  d.stepNow(pilot);
  if (d.fault !== '') throw new Error(d.fault);
}
const output = (d: BetFlightDynamics, rotor: number, slot: number): number => d.escEngine!.output[rotor * BOUND_V2_OUTPUT_SLOTS + slot]!;

describe('ESC drive from a vehicle manifest', () => {
  const bytes = readFileSync(new URL('./fixtures/models/synthetic-quad-v2.json', import.meta.url));
  const quad = validateVehicleManifest(JSON.parse(bytes.toString('utf8')));
  const driven = { ...quad, motors: quad.motors.map(m => ({ ...m, noLoadCurrentA: 0.6 })),
    escs: quad.escs.map(e => ({ ...e, updateRateHz: 490, brakeCurrentLimitA: 8 })) };

  it('maps KV, no-load current and update rate onto every rotor and names a missing value', () => {
    const drive = escDriveFromManifest(driven, 0.95, 2);
    // 920 KV: k_t = 60/(2π·920) = 0.010378... N·m/A, so τ0 = 0.6·k_t.
    const kt = 60 / (2 * Math.PI * 920);
    expect(drive.motors).toHaveLength(4);
    for (const motor of drive.motors) {
      expect(motor).toEqual({ resistanceOhm: 0.12, torqueConstantNmPerA: kt, currentLimitA: 25, brakeCurrentLimitA: 8,
        noLoadTorqueNm: kt * 0.6, commandTauS: 0.02, updatePeriodS: 1 / 490 });
    }
    expect(drive).toMatchObject({ battery: quad.battery, initialStateOfCharge: 0.95, housePowerW: 2 });
    expect(() => escDriveFromManifest(quad, 1)).toThrow('noLoadCurrentA');
    expect(() => escDriveFromManifest({ ...driven, escs: quad.escs.map(e => ({ ...e, updateRateHz: 490 })) }, 1)).toThrow('brakeCurrentLimitA');
    expect(() => escDriveFromManifest({ ...driven, escs: quad.escs.map(e => ({ ...e, brakeCurrentLimitA: 8 })) }, 1)).toThrow('updateRateHz');
    expect(() => escDriveFromManifest({ ...driven, battery: null, provenance: { ...driven.provenance, battery: null } }, 1)).toThrow('battery');
    for (const soc of [0, 1.01, NaN]) expect(() => escDriveFromManifest(driven, soc)).toThrow('state of charge');
    expect(() => escDriveFromManifest(driven, 1, -1)).toThrow('house');
  });
});

describe('ArduPilot thrust curve fit', () => {
  it('recovers the exponent of an exact curve and refuses unusable samples', () => {
    const a = [0, 0.125, 0.25, 0.5, 0.75, 1];
    const fit = fitThrustExpo(a, a.map(x => 0.63 * x + 0.37 * x * x));
    expect(Math.abs(fit.expo - 0.37)).toBeLessThan(1e-14);
    expect(fit.rmsResidual).toBeLessThan(1e-15);
    expect(() => fitThrustExpo([0, 1], [0, 1])).toThrow('three');
    expect(() => fitThrustExpo([0, 1, 1], [0, 1, 1])).toThrow('inside');
    expect(() => fitThrustExpo([0, 0.5, 1.2], [0, 0.5, 1])).toThrow('[0, 1]');
    // y = a³ gives e = Σ(a³−a)(a²−a)/Σ(a²−a)²; a strongly concave curve leaves the parameter range.
    expect(() => fitThrustExpo(a, a.map(x => Math.sqrt(Math.sqrt(x))))).toThrow('MOT_THST_EXPO');
  });

  it('curves the static thrust of the ESC drive, while a torque source stays nearly linear', () => {
    const rotor = parityRotor();
    const esc = thrustExpoOfDrive({ module, rotor, motor: MOTOR, busVoltageV: BATTERY.openCircuitFullV, ...ATMOSPHERE, hz: HZ }, 9);
    // The same rotor driven by duty·τmax, the pre-TASK-092 drive, swept over the same actuator range.
    const engine = new BetRotorEngine(module, [rotor], HZ), torque: number[] = [];
    engine.input.set([ATMOSPHERE.densityKgM3, ATMOSPHERE.viscosityPaS, ATMOSPHERE.soundMps]);
    for (const point of esc.points) {
      engine.input[12] = point.duty * 0.2;
      let previous = engine.output[9]!, change = Infinity;
      for (let n = 0; n < 4 * HZ; n++) {
        expect(engine.stepInto()).toBe(true);
        change = Math.abs(engine.output[9]! - previous); previous = engine.output[9]!;
      }
      expect(change).toBeLessThan(1e-9 * previous);
      torque.push(engine.output[2]!);
    }
    engine.dispose();
    const actuator = esc.points.map(p => (p.duty - ARDUPILOT_SPIN_RANGE.min) / (ARDUPILOT_SPIN_RANGE.max - ARDUPILOT_SPIN_RANGE.min));
    const linear = fitThrustExpo(actuator, torque.map(t => t / torque[torque.length - 1]!));
    // Thrust rises with duty in both drives. Under SA-01 the exponents are
    // reported for the user to judge (F-02); only their order is a physics check:
    // the speed of a voltage drive follows d·V, so T ∝ Ω² bends upward.
    for (let i = 1; i < esc.points.length; i++) expect(esc.points[i]!.thrustN).toBeGreaterThan(esc.points[i - 1]!.thrustN);
    expect(esc.expo).toBeGreaterThan(linear.expo + 0.3);
    expect(esc.points.every(p => p.currentA < MOTOR.currentLimitA)).toBe(true);
  }, 120000);
});

describe('ESC drive in flight', () => {
  it('closes the bus power budget and charge integral every tick, sags under load and charges while braking', () => {
    const d = new BetFlightDynamics(module, escAircraft(), HZ), dt = 1 / HZ, coulombs = BATTERY.capacityAh * 3600;
    expect(d.state.batteryVoltage).toBe(openCircuitV(0.9));
    let soc = d.stateOfCharge, regenerating = 0, maxSagV = 0;
    for (let tick = 0; tick < 3 * HZ; tick++) {
      // 2 s climb at 0.8, then zero throttle: the spinning motors brake into the pack.
      step(d, tick, tick < 2 * HZ ? 0.8 : 0);
      let terminal = 0;
      for (let r = 0; r < 4; r++) terminal += output(d, r, 21);
      const v = d.state.batteryVoltage, i = d.batteryCurrentA, open = openCircuitV(soc);
      expect(d.busLimited).toBe(false);
      // Charge integral, bit for bit: soc' = soc − I·dt/C (capped at 1).
      expect(d.stateOfCharge).toBe(Math.min(1, soc - i * dt / coulombs));
      // Linear open-circuit pack with series resistance.
      expect(Math.abs(v - (open - i * BATTERY.internalResistanceOhm))).toBeLessThan(1e-12 * open);
      // Delivered = Σ terminal + house: the bus closes on the motors' own powers.
      expect(Math.abs(v * i - (terminal + HOUSE_W))).toBeLessThan(1e-9 * Math.max(1, Math.abs(terminal)));
      if (i < 0) { regenerating++; expect(d.stateOfCharge).toBeGreaterThan(soc); }
      maxSagV = Math.max(maxSagV, open - v);
      soc = d.stateOfCharge;
      if (tick === 2 * HZ - 1) expect(d.state.down).toBeLessThan(-1);
    }
    expect(maxSagV).toBeGreaterThan(0.1);
    expect(regenerating).toBeGreaterThan(0);
    expect(soc).toBeLessThan(0.9);
    d.dispose();
  });

  it('unpowers a cut motor, scales a partial cut through its ESC and recovers on reset', () => {
    const d = new BetFlightDynamics(module, escAircraft(), HZ), faults = new MotorFaults([0, 1, 2, 3]);
    d.useMotorFaults(faults);
    let tick = 0;
    for (; tick < HZ; tick++) step(d, tick, 0.75);
    expect(faults.set(0, 'power-cut', 0)).toBe(true);
    expect(faults.set(1, 'power-cut', 0.5)).toBe(true);
    let omega = output(d, 0, 9);
    for (let n = 0; n < 200; n++, tick++) {
      step(d, tick, 0.75);
      // A cut bridge carries no current and draws no power; the rotor coasts down.
      expect(output(d, 0, 19)).toBe(0);
      expect(output(d, 0, 21)).toBe(0);
      expect(output(d, 0, 9)).toBeLessThan(omega);
      omega = output(d, 0, 9);
      expect(d.escEngine!.driveFlags[0]).toBe(1);
      expect(d.escEngine!.input[BOUND_V2_INPUT_DOUBLES + 13]).toBe(0.75 * 0.5);
      for (const r of [2, 3]) expect(output(d, r, 19)).toBeGreaterThan(0);
    }
    expect(d.escEngine!.driveFlags[1]).toBe(0);
    faults.reset();
    d.reset();
    expect([d.stateOfCharge, d.batteryCurrentA, d.state.batteryVoltage]).toEqual([0.9, 0, openCircuitV(0.9)]);
    step(d, 0, 0.75);
    expect(d.escEngine!.driveFlags[0]).toBe(0);
    expect(output(d, 0, 19)).toBeGreaterThan(0);
    d.dispose();
  });

  it('publishes the bus voltage and current through the SAB session', () => {
    const stateBuffer = createSharedMemoryV2();
    let now = 0, dynamics: BetFlightDynamics | null = null;
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'),
      actuatorBuffer: createSpscQueue('actuator') }, { monotonicMs: () => now, wallMs: () => 100000 + now },
    hz => (dynamics = new BetFlightDynamics(module, escAircraft(), hz)));
    session.start();
    for (let i = 0; i < 50; i++) { now++; session.pump(); }
    const state = newFlightStateV2();
    expect(new StateReaderV2(stateBuffer).latest(state)).toBe(true);
    if (!dynamics) throw new Error('The session created no dynamics');
    const d: BetFlightDynamics = dynamics;
    // f32 wire fields: the published values are the bus state rounded to single precision.
    expect(state.batteryVoltage).toBe(Math.fround(d.electrical[1]!));
    expect(state.batteryCurrentA).toBe(Math.fround(d.electrical[2]!));
    expect(state.batteryCurrentA).toBeGreaterThan(0);
    expect([d.stateOfCharge, d.batteryCurrentA]).toEqual([d.electrical[0], d.electrical[2]]);
    session.dispose();
  });

  it('refuses an ESC drive that does not fit the rotors or the pack', () => {
    const bad = (edit: (c: BetFlightConfiguration) => void) => { const c = escAircraft(); edit(c); return () => new BetFlightDynamics(module, c, HZ); };
    expect(bad(c => { c.drive = { ...c.drive!, motors: [MOTOR, MOTOR, MOTOR] }; })).toThrow('ESC drive');
    expect(bad(c => { c.drive = { ...c.drive!, initialStateOfCharge: 0 }; })).toThrow('ESC drive');
    expect(bad(c => { c.drive = { ...c.drive!, housePowerW: -1 }; })).toThrow('ESC drive');
    expect(bad(c => { c.drive = { ...c.drive!, motors: [{ ...MOTOR, resistanceOhm: NaN }, MOTOR, MOTOR, MOTOR] }; })).toThrow('ESC drive motor');
    expect(bad(c => { c.drive = { ...c.drive!, battery: { ...BATTERY, capacityAh: 0 } }; })).toThrow('bus battery');
  });

  it('keeps the torque drive bit for bit as before TASK-092', () => {
    // SHA-256 of 4000 state records computed with the d1aeaca BetFlightDynamics
    // and the d1aeaca WASM build, both before any TASK-092 change.
    const d = new BetFlightDynamics(module, parityAircraft(), HZ), hash = createHash('sha256'), record = new Float64Array(16);
    const input = { flags: 3, throttle: 0.7, roll: 0.02, pitch: -0.01, yaw: 0.03, wallTimeMs: 0 };
    for (let i = 0; i < 4000; i++) {
      d.nowMs = (i + 0.5) / 0.8; input.wallTimeMs = d.nowMs; input.throttle = 0.6 + 0.2 * Math.sin(i / 300);
      d.stepNow(input);
      const s = d.state;
      record.set([s.north, s.east, s.down, s.qw, s.qx, s.qy, s.qz, s.vn, s.ve, s.vd, s.p, s.q, s.r, s.batteryVoltage, d.referenceRotorRpm, d.validityFlags]);
      hash.update(new Uint8Array(record.buffer));
    }
    expect(d.fault).toBe('');
    expect(hash.digest('hex')).toBe('0149633376a2365bec389ffbb28dc261a8f93a128d8a0d7766aeabffe84ab26d');
    expect(d.batteryCurrentA).toBe(0);
    d.dispose();
  });
});
