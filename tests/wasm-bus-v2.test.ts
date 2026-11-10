import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { CHEN_2006_EMPTY_CHARGE, chen2006CellV, openCircuitTableV, seriesResistanceTable } from '@mirage/physics/battery-curves';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { BatteryColumn } from '@mirage/physics/limit-monitor';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';
import { BetBus, type BusBattery, type BusBatteryDynamics } from '@mirage/wasm-bet/bus';

// TASK-104 (SPECS_SIMULATION_ENGINES "Battery v2"), limits declared before the implementation: check 7's table against
// eq. (2) of Chen and Rincón-Mora (2006) within 1e-12 V; check 6 through the WASM bus records, a neutral dynamic pack against
// the TASK-092 pack within 1e-12 V; checks 2 and 3 through the v2 record's byte layout; and the pack's state in a flight.

const HZ = 800;
let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 600_000);

const PACK: BusBattery = { openCircuitFullV: 16.8, openCircuitEmptyV: 13.2, internalResistanceOhm: 0.018, capacityAh: 5, currentLimitA: 125 };
const neutral = (): BusBatteryDynamics => ({ openCircuitTableV: openCircuitTableV('linear', 4, 3.3, 4.2), branches: [], activationK: 0, referenceK: 298.15,
  heatCapacityJPerK: 0, stillAirConductanceWPerK: 0, airflowConductanceWPerK: 0, entropicVPerK: 0, capacityRetention: 1, resistanceGrowth: 1 });

describe('open-circuit curves (check 7)', () => {
  it('chen-2006 is eq. (2) under the declared mapping, with the card window at its ends', () => {
    expect(Math.abs(chen2006CellV(CHEN_2006_EMPTY_CHARGE) - 3.3)).toBeLessThan(1e-12);
    expect(Math.abs(CHEN_2006_EMPTY_CHARGE - 0.02771)).toBeLessThan(5e-6);
    const [cells, empty, full] = [3, 3.3, 4.35];
    const table = openCircuitTableV('chen-2006', cells, empty, full), ze = CHEN_2006_EMPTY_CHARGE;
    const eq2 = (z: number) => -1.031 * Math.exp(-35 * z) + 3.685 + 0.2156 * z - 0.1178 * z ** 2 + 0.3201 * z ** 3;
    for (let i = 0; i < 21; i++) {
      const s = i / 20, shape = (eq2(ze + (1 - ze) * s) - eq2(ze)) / (eq2(1) - eq2(ze));
      expect(Math.abs(table[i]! - cells * (empty + (full - empty) * shape)), `point ${i}`).toBeLessThan(1e-12);
    }
    expect(table[0]).toBe(cells * empty);
    expect(table[20]).toBe(cells * full);
    expect(openCircuitTableV('linear', 4, 3.3, 4.2).every((v, i, t) => i === 0 || v >= t[i - 1]!)).toBe(true);
  });
  // Second increment, check 2: the series resistance's charge table against eq. (3) under the same mapping, within 1e-12.
  it('chen-2006 carries eq. (3) as the series resistance by charge; linear carries none', () => {
    const eq3 = (z: number) => 0.1562 * Math.exp(-24.37 * z) + 0.07446, ze = CHEN_2006_EMPTY_CHARGE;
    const table = seriesResistanceTable('chen-2006');
    if (!table) throw new Error('No table');
    expect(table).toHaveLength(21);
    for (let i = 0; i < 21; i++) expect(Math.abs(table[i]! - eq3(ze + (1 - ze) * i / 20) / eq3(1)), `point ${i}`).toBeLessThan(1e-12);
    expect(table[20]).toBe(1);
    expect(Math.abs(table[0]! - 2.0678)).toBeLessThan(1e-4);
    expect(seriesResistanceTable('linear')).toBeNull();
  });
});

describe('the WASM bus records v2', () => {
  it('a neutral dynamic pack runs as the TASK-092 pack within 1e-12 V (check 6)', () => {
    const linear = new BetBus(module, PACK, HZ), dynamic = new BetBus(module, { ...PACK, dynamics: neutral() }, HZ);
    expect(dynamic.dynamic).toBe(true);
    let a = 1, b = 1;
    const di = dynamic.input;
    di[5] = 298.15; di[6] = 293.15; di[7] = 0;
    for (let n = 0; n < 4000; n++) {
      const demand = [-80, 0, 250, 900, 40][n % 5]!;
      expect(linear.stepInto(a, demand, 3)).toBe(true);
      di[0] = b; di[1] = demand; di[2] = 3;
      expect(dynamic.stepFromInput(), `status ${dynamic.lastStatus}`).toBe(true);
      expect(Math.abs(linear.output[1]! - dynamic.output[1]!)).toBeLessThan(1e-12);
      expect(Math.abs(linear.output[2]! - dynamic.output[2]!)).toBeLessThan(1e-12);
      a = linear.output[0]!; b = dynamic.output[0]!;
      di[3] = dynamic.output[7]!; di[4] = dynamic.output[8]!; di[5] = dynamic.output[9]!;
    }
  });
  it('a dynamic pack closes V·I = P and its energy budget through the record bytes (checks 2 and 3)', () => {
    const dynamics: BusBatteryDynamics = { ...neutral(), openCircuitTableV: openCircuitTableV('chen-2006', 4, 3.3, 4.2),
      branches: [{ resistanceOhm: 0.01, capacitanceF: 2000 }, { resistanceOhm: 0.012, capacitanceF: 20000 }], activationK: 3000,
      heatCapacityJPerK: 400, stillAirConductanceWPerK: 0.3, airflowConductanceWPerK: 0.2, entropicVPerK: 4e-4 };
    const bus = new BetBus(module, { ...PACK, dynamics }, HZ), x = bus.input, o = bus.output;
    x[0] = 0.9; x[3] = 0; x[4] = 0; x[5] = 295; x[6] = 290; x[7] = 6;
    let heated = false;
    for (let n = 0; n < 8000; n++) {
      x[1] = n % 800 < 400 ? 600 : 50; x[2] = 0;
      expect(bus.stepFromInput(), `status ${bus.lastStatus}`).toBe(true);
      expect(Math.abs(o[1]! * o[2]! - x[1]) / x[1]).toBeLessThan(1e-9);
      // U·I = V·I + I²·R0(T) + I·(V1' + V2'), with R0 at the step's start temperature.
      const r0 = 0.018 * Math.exp(3000 * (1 / x[5] - 1 / 298.15));
      const lhs = o[11]! * o[2]!, rhs = o[1]! * o[2]! + o[2]! * o[2]! * r0 + o[2]! * (o[7]! + o[8]!);
      expect(Math.abs(lhs - rhs) / lhs).toBeLessThan(1e-9);
      if (o[9]! > 295.001) heated = true;
      x[0] = o[0]!; x[3] = o[7]!; x[4] = o[8]!; x[5] = o[9]!;
    }
    expect(heated).toBe(true);
    expect(o[7]!).toBeGreaterThan(0);
  });
  it('refuses a dynamic pack the native checks refuse', () => {
    const bus = new BetBus(module, { ...PACK, dynamics: { ...neutral(), branches: [{ resistanceOhm: 0.01, capacitanceF: 0 }] } }, HZ);
    bus.input[5] = 298.15; bus.input[6] = 293.15;
    expect(bus.stepInto(1, 100, 0)).toBe(false);
    expect(bus.lastStatus).toBe(-3);
  });
});

function json(path: string): unknown { return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')); }
function card(type: string, values: Record<string, unknown> = {}, schemaVersion = 1): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error('Invalid card');
  const all = { ...base.values, ...values };
  return validateComponentCard({ ...base, schemaVersion, values: all,
    provenance: Object.fromEntries(Object.entries(all).map(([key, value]) => [key, value === null ? null : 'example'])) });
}
const MOTOR = 'a'.repeat(64), PROPELLER = 'b'.repeat(64), ESC = 'c'.repeat(64), BATTERY = 'd'.repeat(64);
async function configuration(battery: ComponentCard): Promise<BetFlightConfiguration> {
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
  [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
  const resolved = resolveComponents(profile, new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, battery]]));
  if (!resolved.components) throw new Error(resolved.missing.join('; '));
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 104 });
  return buildProfileDynamics(derived.manifest, { initialStateOfCharge: 1, syntheticPad: true }).configuration;
}

describe('the pack in the flight', () => {
  it('carries its branches and temperature, reports them, and starts relaxed at the air temperature on reset', async () => {
    const v2 = { openCircuitCurve: 'chen-2006', rcFastResistanceOhm: 0.006, rcFastCapacitanceF: 3000, rcSlowResistanceOhm: 0.008, rcSlowCapacitanceF: 40000,
      resistanceActivationK: 3000, heatCapacityJPerK: 500, stillAirConductanceWPerK: 0.4, airflowConductanceWPerK: 0.3, entropicCoefficientVPerK: null,
      capacityRetention: null, resistanceGrowth: null };
    const keys = Object.keys(v2);
    const fresh = await configuration(card('battery', v2, 2));
    expect(fresh.drive?.battery.dynamics?.branches).toHaveLength(2);
    // The chen-2006 preset brings its resistance table, so the flight runs shared bus records v3.
    expect(fresh.drive?.battery.dynamics?.seriesResistanceTable).toHaveLength(21);
    const plain = await configuration(card('battery'));
    expect(plain.drive?.battery.dynamics).toBeUndefined();
    expect(keys).toHaveLength(12);
    const d = new BetFlightDynamics(module, fresh, HZ), frame = newActuatorFrameV2(), pilot = newInput();
    try {
      const air = d.packState[2]!;
      expect(air).toBeGreaterThan(273);
      frame.motorMapId = fresh.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed; frame.actuatorCount = 4;
      for (let tick = 0; tick < 20 * HZ; tick++) {
        for (let c = 0; c < 4; c++) frame.normalizedActuators[c] = 0.55;
        d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / HZ; d.stepNow(pilot);
        expect(d.fault).toBe('');
      }
      expect(d.packState[0]!).toBeGreaterThan(0);
      expect(d.packState[1]!).toBeGreaterThan(0);
      expect(d.packState[2]!).toBeGreaterThan(air);
      expect(d.power?.battery[BatteryColumn.TemperatureK]).toBe(d.packState[2]);
      d.reset();
      expect([d.packState[0], d.packState[1], d.packState[2]]).toEqual([0, 0, air]);
    } finally { d.dispose(); }
  }, 120_000);
});
