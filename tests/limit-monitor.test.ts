import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '@mirage/aircraft/profile';
import { componentRatings, resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics } from '@mirage/physics/bet-dynamics';
import {
  BatteryColumn, BatteryLimited, LimitMonitor, MotorColumn, MotorLimited, MotorWarning, PowerTelemetry, LIMIT_OUTBOX_CAPACITY,
  parseLimitRatings, type LimitEvent, type LimitRatings,
} from '@mirage/physics/limit-monitor';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { validateVehicleManifest } from '@mirage/physics/vehicle-manifest';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';

// TASK-146. Oracle for the electrical values: the shared-bus model of
// SPECS_SIMULATION_ENGINES ("Shared bus"), recomputed here step by step from the
// published per-motor powers: Voc linear in the state of charge,
// I = 2P / (Voc + sqrt(Voc^2 - 4 R P)), V = Voc - I R, and dSOC = -I dt / C.

const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32);
let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600000);

function json(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}
function card(type: string, values: Record<string, unknown> = {}): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object') throw new Error('Invalid card');
  const merged = { ...base.values, ...values };
  const provenance = Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, value === null ? null : 'example']));
  return validateComponentCard({ ...base, values: merged, provenance });
}
interface CardEdits { motor?: Record<string, unknown>; esc?: Record<string, unknown>; battery?: Record<string, unknown> }
function cards(edits: CardEdits = {}): Map<string, ComponentCard> {
  return new Map([[MOTOR, card('motor', edits.motor)], [PROPELLER, card('propeller')], [ESC, card('esc', edits.esc)],
    [BATTERY, card('battery', edits.battery)]]);
}
function quad(): AircraftProfile {
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const fitted = validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) });
  return withPropellerPolars(fitted, [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
}
async function quadDynamics(edits: CardEdits, options: { ratings?: LimitRatings | null; soc?: number; hz?: 400 | 800 } = {}) {
  const profile = quad(), set = cards(edits), resolved = resolveComponents(profile, set);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 146 });
  const ratings = options.ratings === undefined ? componentRatings(profile, set) : options.ratings;
  const { configuration } = buildProfileDynamics(derived.manifest, { initialStateOfCharge: options.soc ?? 1, limitRatings: ratings });
  const manifest = validateVehicleManifest(derived.manifest);
  return { d: new BetFlightDynamics(module, configuration, options.hz ?? 400), manifest, ratings, motorMapId: configuration.motorMapId };
}
/** Runs at a fixed duty on every motor; `each` sees the dynamics after every step. */
function run(q: { d: BetFlightDynamics; motorMapId: number }, duty: number, steps: number, each: (step: number) => void = () => undefined): void {
  const d = q.d, channels = 4, frame = newActuatorFrameV2(), pilot = newInput();
  frame.motorMapId = q.motorMapId;
  frame.actuatorFlags = ActuatorFlagV2.Armed; frame.actuatorCount = channels;
  for (let i = 0; i < channels; i++) frame.normalizedActuators[i] = duty;
  for (let k = 0; k < steps; k++) {
    d.useActuators(frame); d.nowMs = (k + 1) * 1000 / d.hz; d.stepNow(pilot);
    if (d.fault) throw new Error(d.fault);
    each(k);
  }
}
function drainAll(d: BetFlightDynamics): LimitEvent[] {
  const events: LimitEvent[] = [];
  d.limits?.drain(e => events.push(e));
  return events;
}

describe('limit ratings v1', () => {
  const valid = { schemaVersion: 1, motors: [{ motorCurrentA: 30, motorPowerW: 450, escCurrentA: 30, escVoltageV: 25.2, rpm: null }],
    battery: { emptyVoltageV: 13.2 } };
  it('accepts stated ratings and nulls, and rejects anything else', () => {
    expect(parseLimitRatings(valid, 1)).toEqual(valid);
    const invalid: unknown[] = [
      { ...valid, schemaVersion: 2 }, { ...valid, extra: 1 }, { ...valid, motors: [] },
      { ...valid, motors: Array.from({ length: 17 }, () => valid.motors[0]) },
      { ...valid, motors: [{ ...valid.motors[0], motorCurrentA: 0 }] }, { ...valid, motors: [{ ...valid.motors[0], motorPowerW: NaN }] },
      { ...valid, motors: [{ ...valid.motors[0], rpm: -1 }] }, { ...valid, motors: [{ ...valid.motors[0], torque: 1 }] },
      { ...valid, battery: { emptyVoltageV: '13.2' } }, { ...valid, battery: {} }, null, [],
    ];
    for (const value of invalid) expect(() => parseLimitRatings(value), JSON.stringify(value)).toThrow(RangeError);
    expect(() => parseLimitRatings(valid, 4)).toThrow('the model has 4');
  });
  it('takes only stated card values, in profile motor order', () => {
    const ratings = componentRatings(quad(), cards({ motor: { maxPowerW: null } }));
    expect(ratings.motors).toHaveLength(4);
    expect(ratings.motors[0]).toEqual({ motorCurrentA: 30, motorPowerW: null, escCurrentA: 30, escVoltageV: 25.2, rpm: null });
    expect(ratings.battery.emptyVoltageV).toBeCloseTo(4 * 3.3, 12);
    expect(parseLimitRatings(ratings, 4)).toEqual(ratings);
  });
});

describe('limit monitor on synthetic telemetry', () => {
  const ratings = parseLimitRatings({ schemaVersion: 1, battery: { emptyVoltageV: 13 },
    motors: [{ motorCurrentA: 20, motorPowerW: 300, escCurrentA: 25, escVoltageV: 25, rpm: 9000 },
      { motorCurrentA: null, motorPowerW: null, escCurrentA: null, escVoltageV: null, rpm: null }] });
  function telemetry(current: number, power: number, rpm: number, volts: number): PowerTelemetry {
    const t = new PowerTelemetry(2);
    for (let i = 0; i < 2; i++) {
      t.motors[i * MotorColumn.stride + MotorColumn.MotorCurrentA] = current;
      t.motors[i * MotorColumn.stride + MotorColumn.ElectricalPowerW] = power;
      t.motors[i * MotorColumn.stride + MotorColumn.Rpm] = rpm;
    }
    t.battery[BatteryColumn.VoltageV] = volts;
    return t;
  }
  it('starts with an empty outbox after priming its branches', () => {
    const monitor = new LimitMonitor(2, ratings, [40, 40], [35, 35], 100, 400);
    expect(monitor.drain(() => undefined)).toBe(0);
    expect(monitor.dropped).toBe(0);
  });
  it('raises and clears each warning once, and never checks a null rating', () => {
    const monitor = new LimitMonitor(2, ratings, [40, 40], [35, 35], 100, 400), events: LimitEvent[] = [];
    const calm = telemetry(10, 150, 5000, 16), hot = telemetry(-26, 350, -9500, 26);
    monitor.evaluate(calm, 1); monitor.evaluate(hot, 2); monitor.evaluate(hot, 3);
    expect(hot.motorWarning[0]).toBe(MotorWarning.MotorCurrent | MotorWarning.MotorPower | MotorWarning.EscCurrent |
      MotorWarning.EscVoltage | MotorWarning.Rpm);
    expect(hot.motorWarning[1]).toBe(0);
    monitor.evaluate(calm, 4);
    monitor.drain(e => events.push(e));
    expect(events.map(e => [e.tick, e.subject, e.quantity, e.kind, e.edge])).toEqual([
      [2, 0, 'motor-current', 'warning', 'start'], [2, 0, 'motor-power', 'warning', 'start'], [2, 0, 'esc-current', 'warning', 'start'],
      [2, 0, 'esc-voltage', 'warning', 'start'], [2, 0, 'rpm', 'warning', 'start'],
      [4, 0, 'motor-current', 'warning', 'end'], [4, 0, 'motor-power', 'warning', 'end'], [4, 0, 'esc-current', 'warning', 'end'],
      [4, 0, 'esc-voltage', 'warning', 'end'], [4, 0, 'rpm', 'warning', 'end'],
    ]);
    expect(events[0]).toMatchObject({ value: 26, limit: 20, simTimeS: 2 / 400 });
    expect(events[4]).toMatchObject({ value: 9500, limit: 9000 });
  });
  it('reports modeled clamps as limited and under-voltage as a warning', () => {
    const monitor = new LimitMonitor(2, null, [7, 8], [5, 6], 60, 800), events: LimitEvent[] = [];
    const t = telemetry(7, 100, 4000, 12);
    t.motorLimited[1] = MotorLimited.CurrentLimit; t.batteryMasks[1] = BatteryLimited.PackCurrent | BatteryLimited.Charge;
    t.battery[BatteryColumn.CurrentA] = 60; t.battery[BatteryColumn.StateOfCharge] = 1;
    monitor.evaluate(t, 9);
    monitor.drain(e => events.push(e));
    // Without ratings no warning is checked, not even the battery's.
    expect(events.map(e => [e.subject, e.quantity, e.kind, e.value, e.limit])).toEqual([
      [1, 'current-limit', 'limited', 7, 8], ['battery', 'pack-current-limit', 'limited', 60, 60], ['battery', 'charge-limit', 'limited', 1, 1]]);
    // A braking current at its limit is reported against the brake limit.
    const braking = telemetry(-6, -50, 4000, 16);
    braking.motorLimited[1] = MotorLimited.CurrentLimit;
    const brake = new LimitMonitor(2, null, [7, 8], [5, 6], 60, 800), braked: LimitEvent[] = [];
    brake.evaluate(braking, 1);
    brake.drain(e => braked.push(e));
    expect(braked).toMatchObject([{ subject: 1, quantity: 'current-limit', kind: 'limited', value: -6, limit: 6 }]);
    const rated = new LimitMonitor(2, ratings, [7, 8], [5, 6], 60, 800), more: LimitEvent[] = [];
    rated.evaluate(telemetry(1, 1, 1, 12.5), 1);
    rated.drain(e => more.push(e));
    expect(more).toMatchObject([{ subject: 'battery', quantity: 'battery-voltage', kind: 'warning', edge: 'start', value: 12.5, limit: 13 }]);
  });
  it('bounds the outbox and counts what it drops', () => {
    const monitor = new LimitMonitor(2, ratings, [40, 40], [35, 35], 100, 400), calm = telemetry(0, 0, 0, 16), hot = telemetry(30, 0, 0, 16);
    for (let k = 0; k < 400; k++) monitor.evaluate(k % 2 ? calm : hot, k);
    let n = 0;
    monitor.drain(() => n++);
    // Each alternation changes two bits (motor and ESC current): 800 events into 256 slots.
    expect(n).toBe(LIMIT_OUTBOX_CAPACITY);
    expect(monitor.dropped).toBe(800 - LIMIT_OUTBOX_CAPACITY);
    monitor.reset();
    expect(monitor.dropped).toBe(0);
  });
});

describe('battery sag and charge on the TASK-092 bus (analytic recurrence)', () => {
  it('publishes the bus values the analytic model gives from the motor powers', async () => {
    const q = await quadDynamics({}, { soc: 0.8 }), { d, manifest } = q;
    const battery = manifest.battery!, dt = 1 / d.hz, capacityC = battery.capacityAh * 3600, R = battery.internalResistanceOhm;
    const t = d.power!;
    expect(t.battery[BatteryColumn.StateOfCharge]).toBe(0.8);
    expect(t.battery[BatteryColumn.CapacityAh]).toBe(5);
    let soc = 0.8, worst = 0, sag = 0;
    run(q, 0.55, 4000, () => {
      let demand = 0;
      for (let i = 0; i < 4; i++) demand += t.motors[i * MotorColumn.stride + MotorColumn.ElectricalPowerW]!;
      const voc = battery.openCircuitEmptyV + (battery.openCircuitFullV - battery.openCircuitEmptyV) * soc;
      const current = 2 * demand / (voc + Math.sqrt(voc * voc - 4 * R * demand)), volts = voc - current * R;
      soc = soc - current * dt / capacityC;
      const b = t.battery, rel = (a: number, e: number) => Math.abs(a - e) / Math.max(1e-9, Math.abs(e));
      worst = Math.max(worst, rel(b[BatteryColumn.CurrentA]!, current), rel(b[BatteryColumn.VoltageV]!, volts),
        rel(b[BatteryColumn.StateOfCharge]!, soc), rel(b[BatteryColumn.PowerW]!, volts * current),
        rel(b[BatteryColumn.RemainingAh]!, soc * battery.capacityAh));
      sag = voc - b[BatteryColumn.VoltageV]!;
    });
    // Tolerance set before the run: the same IEEE operations in the same order, up to the formula's arrangement.
    expect(worst).toBeLessThan(1e-12);
    expect(soc).toBeLessThan(0.8);
    // A loaded pack sags by I·R: tens of amps through 18 mΩ.
    expect(sag).toBeGreaterThan(0.1);
    expect(t.batteryMasks[0]).toBe(0); expect(t.batteryMasks[1]).toBe(0);
    for (let i = 0; i < 4; i++) {
      const row = i * MotorColumn.stride;
      expect(t.motors[row + MotorColumn.Command]).toBe(0.55);
      expect(t.motors[row + MotorColumn.Rpm]).toBeGreaterThan(1000);
      // The bus current per motor is its terminal power over the lagged bus voltage.
      expect(t.motors[row + MotorColumn.BusCurrentA]!).toBeGreaterThan(0);
    }
    d.dispose();
  }, 300000);
  it('resets the telemetry to the unloaded pack', async () => {
    const q = await quadDynamics({}, { soc: 0.5 }), { d, manifest } = q;
    run(q, 0.5, 100);
    d.reset();
    const b = d.power!.battery, battery = manifest.battery!;
    expect(b[BatteryColumn.StateOfCharge]).toBe(0.5);
    expect(b[BatteryColumn.VoltageV]).toBe(battery.openCircuitEmptyV + (battery.openCircuitFullV - battery.openCircuitEmptyV) * 0.5);
    expect(b[BatteryColumn.CurrentA]).toBe(0);
    expect(b[BatteryColumn.RemainingAh]).toBe(2.5);
    expect(drainAll(d)).toEqual([]);
    d.dispose();
  }, 300000);
});

describe('warnings never change physics; modeled clamps are limited', () => {
  it('flies bit for bit the same with exceeded ratings, and warns', async () => {
    const tight = parseLimitRatings({ schemaVersion: 1, battery: { emptyVoltageV: null },
      motors: Array.from({ length: 4 }, () => ({ motorCurrentA: null, motorPowerW: 20, escCurrentA: null, escVoltageV: null, rpm: 3000 })) });
    const warned = await quadDynamics({}, { ratings: tight }), plain = await quadDynamics({}, { ratings: null });
    const states: number[][] = [];
    for (const q of [warned, plain]) {
      const d = q.d;
      run(q, 0.6, 2000);
      states.push([d.state.north, d.state.east, d.state.down, d.state.qw, d.state.qx, d.state.vd, d.state.batteryVoltage, ...d.electrical,
        ...d.power!.motors]);
    }
    expect(states[0]).toEqual(states[1]);
    const events = drainAll(warned.d), warnings = events.filter(e => e.kind === 'warning');
    const starts = warnings.filter(e => e.edge === 'start').map(e => JSON.stringify([e.subject, e.quantity])).sort();
    expect(starts).toEqual([0, 1, 2, 3].flatMap(i => [[i, 'motor-power'], [i, 'rpm']]).map(e => JSON.stringify(e)).sort());
    expect(warnings.every(e => e.edge === 'start')).toBe(true);
    expect(warned.d.power!.motorWarning[0]).toBe(MotorWarning.MotorPower | MotorWarning.Rpm);
    // Spinning up from rest the drive clamps every motor at its 30 A limit for a while: the same clamps in both runs.
    const limited = events.filter(e => e.kind === 'limited');
    expect(limited.length).toBeGreaterThan(0);
    expect(drainAll(plain.d)).toEqual(limited);
    warned.d.dispose(); plain.d.dispose();
  }, 300000);
  it('reports a motor at its current limit as limited, not as a warning', async () => {
    // A 4 A motor rating is also the drive's current limit (TASK-144): the drive clamps at it, so the rating is never exceeded.
    const q = await quadDynamics({ motor: { maxCurrentA: 4 } }), d = q.d;
    run(q, 0.9, 400);
    const t = d.power!, events = drainAll(d);
    for (let i = 0; i < 4; i++) {
      expect(t.motorLimited[i]).toBe(MotorLimited.CurrentLimit);
      expect(Math.abs(t.motors[i * MotorColumn.stride + MotorColumn.MotorCurrentA]!)).toBeCloseTo(4, 9);
    }
    expect(events.filter(e => e.edge === 'start').map(e => [e.subject, e.quantity, e.kind, e.limit])).toEqual(
      [0, 1, 2, 3].map(i => [i, 'current-limit', 'limited', 4]));
    expect(d.driveLimited).toBe(true);
    d.dispose();
  }, 300000);
  it('reports the pack at its discharge limit as limited and a sagging pack below empty as a warning', async () => {
    const q = await quadDynamics({ battery: { maxDischargeCurrentA: 20 } }), d = q.d;
    run(q, 0.9, 400);
    const t = d.power!, events = drainAll(d);
    expect(t.batteryMasks[1]! & BatteryLimited.PackCurrent).toBe(BatteryLimited.PackCurrent);
    expect(t.battery[BatteryColumn.CurrentA]).toBeCloseTo(20, 9);
    expect(events).toContainEqual(expect.objectContaining({ subject: 'battery', quantity: 'pack-current-limit', kind: 'limited', edge: 'start', limit: 20 }));
    d.dispose();
    const low = await quadDynamics({}, { soc: 0.01 });
    run(low, 0.7, 400);
    expect(low.d.power!.batteryMasks[0]).toBe(1);
    expect(drainAll(low.d)).toContainEqual(expect.objectContaining({ subject: 'battery', quantity: 'battery-voltage', kind: 'warning', edge: 'start' }));
    low.d.dispose();
  }, 300000);
  it('rejects ratings for a different motor count', async () => {
    const wrong = parseLimitRatings({ schemaVersion: 1, battery: { emptyVoltageV: null },
      motors: [{ motorCurrentA: null, motorPowerW: null, escCurrentA: null, escVoltageV: null, rpm: null }] });
    await expect(quadDynamics({}, { ratings: wrong })).rejects.toThrow('motor count');
  }, 300000);
});
