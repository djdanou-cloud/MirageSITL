import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { BatteryColumn, MotorColumn } from '@mirage/physics/limit-monitor';
import { validateModelManifest } from '@mirage/physics/model-manifest';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { thrustCapacity } from '@mirage/physics/thrust-capacity';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';
import { FIXTURE_NAMES, type FixtureName } from './support/aircraft-derivation.ts';

// TASK-197: the motors and the battery bus solved together in a flight, on the example cards: a 4S pack of 0.018 ohm and
// 125 A, 700 KV motors of 0.085 ohm. Before this the motors ran on the previous tick's voltage. On the quad at full duty the
// loop gain of that lag is |dP/dV|·|dV/dP| = 803 W/V · 0.0013 V/W = 1.05, above 1, so the bus flipped every tick
// between 14.55 and 15.99 V; and a pack at its limit was flagged while the motors drew on, so a lower limit raised the thrust.
//
// Oracles, independent of the solver. Inside the current limits each motor draws P = d·V·(d·V - k·w)/R, and the pack gives
// V·(Voc - V) = Rb·P, so the voltage has a closed form. At the limit the pack's law gives V = Voc - Rb·I and P = V·I.
// Tolerances, set before the first run: settled speeds move under a mrad/s per tick, so 0.01 V of swing and 1 mV against the
// closed form leave room for the rest of the settling; 0.5 % of thrust as in tests/thrust-capacity.test.ts; on a hard step
// from rest the motors' voltage and the pack's differ by what half a tick of spin-up changes the current, at most 0.2 V.

const MOTOR = 'a'.repeat(64), PROPELLER = 'b'.repeat(64), ESC = 'c'.repeat(64), BATTERY = 'd'.repeat(64);
const HZ = 800;
let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 300000);

function json(path: string): unknown { return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')); }
function card(type: string): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error('Invalid card');
  return validateComponentCard({ ...base, provenance: Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example'])) });
}
function profileOf(name: FixtureName): AircraftProfile {
  const fixture = validateAircraftProfile(json(`./fixtures/aircraft/${name}.json`));
  const fitted = validateAircraftProfile({ ...fixture, battery: { card: BATTERY }, motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) });
  return withPropellerPolars(fitted, [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
}
async function configurationOf(name: FixtureName): Promise<BetFlightConfiguration> {
  const profile = profileOf(name), cards = new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 197 });
  return buildProfileDynamics(derived.manifest, { initialStateOfCharge: 1, syntheticPad: true }).configuration;
}
interface Sample { readonly voltageV: number; readonly currentA: number; readonly motorPowerW: number; readonly limited: boolean; readonly motorVoltageV: number }
interface Hold { readonly samples: Sample[]; readonly thrustN: number; readonly speedsRadS: number[] }
/** The dynamics on a body too heavy to move, gravity off, with `duty(tick)` on every motor: the charge stays put, and thrust is mass times acceleration. */
function hold(configuration: BetFlightConfiguration, duty: (tick: number) => number, seconds: number, battery: Partial<NonNullable<BetFlightConfiguration['drive']>['battery']> = {}, housePowerW = 0): Hold {
  const scale = 1e5, drive = configuration.drive;
  if (!drive) throw new Error('No drive');
  const manifest = validateModelManifest(configuration.manifest);
  const heavy: BetFlightConfiguration = { ...configuration, gravityMps2: 0, syntheticGroundDownM: undefined,
    manifest: { ...structuredClone(configuration.manifest as object), massKg: manifest.massKg * scale, inertiaBodyKgM2: manifest.inertiaBodyKgM2.map(value => value * scale) },
    drive: { ...drive, housePowerW, battery: { ...drive.battery, ...battery, capacityAh: drive.battery.capacityAh * 1e6 } },
    initialBody: { ...configuration.initialBody, positionNedM: new Float64Array([0, 0, -100]) } };
  const d = new BetFlightDynamics(module, heavy, HZ);
  try {
    const frame = newActuatorFrameV2(), pilot = newInput(), samples: Sample[] = [], count = manifest.rotors.length;
    frame.motorMapId = heavy.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
    frame.actuatorCount = Math.max(...manifest.rotors.map(rotor => rotor.motorChannel)) + 1;
    const ticks = Math.round(seconds * HZ), measureFrom = ticks - HZ;
    let velocityAt = 0;
    for (let tick = 0; tick < ticks; tick++) {
      for (const rotor of manifest.rotors) frame.normalizedActuators[rotor.motorChannel] = duty(tick);
      d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / HZ; d.stepNow(pilot);
      if (d.fault !== '') throw new Error(d.fault);
      if (tick + 1 === measureFrom) velocityAt = d.state.vd;
      const power = d.power;
      if (!power) throw new Error('No power telemetry');
      let motorPowerW = 0;
      for (let i = 0; i < count; i++) motorPowerW += power.motors[i * MotorColumn.stride + MotorColumn.ElectricalPowerW] ?? 0;
      samples.push({ voltageV: d.electrical[1] ?? NaN, currentA: d.electrical[2] ?? NaN, motorPowerW, limited: d.busLimited, motorVoltageV: d.motorBusVoltageV });
    }
    expect(d.power?.battery[BatteryColumn.VoltageV]).toBe(d.electrical[1]);
    return { samples, thrustN: -(d.state.vd - velocityAt) * manifest.massKg * scale, speedsRadS: manifest.rotors.map((_, i) => d.rotorSpeedRadS(i)) };
  } finally { d.dispose(); }
}
const swing = (samples: readonly Sample[]): number => {
  const voltages = samples.map(sample => sample.voltageV);
  return Math.max(...voltages) - Math.min(...voltages);
};
/** Ticks where the voltage turns round by more than a millivolt each way: a settling bus turns once at a step of the command, and a flipping one every tick. */
const turns = (samples: readonly Sample[]): number => {
  let count = 0;
  for (let i = 2; i < samples.length; i++) {
    const a = (samples[i - 1]?.voltageV ?? 0) - (samples[i - 2]?.voltageV ?? 0), b = (samples[i]?.voltageV ?? 0) - (samples[i - 1]?.voltageV ?? 0);
    if (a * b < 0 && Math.abs(a) > 1e-3 && Math.abs(b) > 1e-3) count++;
  }
  return count;
};

describe('the battery bus in flight (TASK-197)', () => {
  it.each(FIXTURE_NAMES)('%s: the bus settles at every duty', async name => {
    const configuration = await configurationOf(name);
    for (const duty of [0.3, 0.5, 0.6, 0.8, 1]) {
      const { samples } = hold(configuration, () => duty, 3), last = samples.slice(-HZ / 2);
      console.log(`EVID ${name} duty ${duty}: ${(last.at(-1)?.voltageV ?? NaN).toFixed(3)} V, ${(last.at(-1)?.currentA ?? NaN).toFixed(2)} A, swing ${swing(last).toExponential(2)} V, limited ${String(last.at(-1)?.limited)}`);
      expect(swing(last), `duty ${duty}`).toBeLessThanOrEqual(0.01);
      expect(turns(samples), `duty ${duty}`).toBeLessThanOrEqual(1);
    }
  }, 300000);

  it('stands where the motors and the pack agree, by the closed form', async () => {
    const configuration = await configurationOf('quad-x'), drive = configuration.drive;
    if (!drive) throw new Error('No drive');
    const { openCircuitFullV: open, internalResistanceOhm: rb } = drive.battery;
    for (const duty of [0.5, 0.8, 1]) {
      const { samples, speedsRadS } = hold(configuration, () => duty, 5), last = samples.at(-1);
      if (!last) throw new Error('No samples');
      const k = drive.motors[0]?.torqueConstantNmPerA ?? NaN, r = drive.motors[0]?.resistanceOhm ?? NaN, sum = speedsRadS.reduce((a, b) => a + b, 0);
      const expected = (open + (rb / r) * duty * k * sum) / (1 + speedsRadS.length * duty * duty * rb / r);
      console.log(`EVID quad duty ${duty}: ${last.voltageV.toFixed(4)} V against ${expected.toFixed(4)} V by hand`);
      expect(Math.abs(last.voltageV - expected)).toBeLessThanOrEqual(1e-3);
    }
  }, 120000);

  it('holds the motors to what a pack at its limit delivers', async () => {
    const configuration = await configurationOf('octa-coaxial-16'), drive = configuration.drive;
    if (!drive) throw new Error('No drive');
    const { openCircuitFullV: open, internalResistanceOhm: rb, currentLimitA: limit } = drive.battery;
    const { samples, thrustN } = hold(configuration, () => 1, 5), last = samples.at(-1);
    if (!last) throw new Error('No samples');
    const delivered = (open - rb * limit) * limit;
    console.log(`EVID octa-coaxial-16 at full duty: ${last.voltageV.toFixed(3)} V, ${last.currentA.toFixed(2)} A, motors ${last.motorPowerW.toFixed(1)} W, pack ${delivered.toFixed(1)} W, ${thrustN.toFixed(1)} N`);
    expect(last.limited).toBe(true);
    expect(last.voltageV).toBeCloseTo(open - rb * limit, 3);
    expect(last.currentA).toBeCloseTo(limit, 3);
    expect(Math.abs(last.motorPowerW - delivered) / delivered).toBeLessThanOrEqual(1e-3);
  }, 120000);

  it('gives less thrust on a lower pack limit, and the avionics are served first', async () => {
    const configuration = await configurationOf('quad-x');
    const free = hold(configuration, () => 1, 5), half = hold(configuration, () => 1, 5, { currentLimitA: 40 });
    console.log(`EVID quad limited to 40 A: ${half.thrustN.toFixed(2)} N against ${free.thrustN.toFixed(2)} N free`);
    expect(half.thrustN).toBeLessThan(free.thrustN * 0.8);
    expect(half.samples.at(-1)?.currentA).toBeCloseTo(40, 3);
    const house = hold(configuration, () => 1, 5, { currentLimitA: 40 }, 100), last = house.samples.at(-1), battery = configuration.drive?.battery;
    if (!last || !battery) throw new Error('No samples');
    expect(house.thrustN).toBeLessThan(half.thrustN);
    expect(Math.abs(last.motorPowerW + 100 - (battery.openCircuitFullV - battery.internalResistanceOhm * 40) * 40)).toBeLessThanOrEqual(2);
  }, 120000);

  it.each(FIXTURE_NAMES)('%s: a flight at full command gives what the thrust at full command says', async name => {
    const configuration = await configurationOf(name), flown = hold(configuration, () => 1, 5), capacity = thrustCapacity(module, configuration);
    console.log(`EVID ${name}: ${flown.thrustN.toFixed(2)} N flown against ${capacity.thrustN.toFixed(2)} N, ratio ${capacity.thrustToWeight.toFixed(3)}, ${capacity.busVoltageV.toFixed(3)} V, ${capacity.busCurrentA.toFixed(2)} A, limited ${String(capacity.packLimited)}`);
    expect(Math.abs(flown.thrustN - capacity.thrustN) / capacity.thrustN).toBeLessThanOrEqual(0.005);
    expect(flown.samples.at(-1)?.limited).toBe(capacity.packLimited);
    expect(flown.samples.at(-1)?.voltageV).toBeCloseTo(capacity.busVoltageV, 2);
  }, 120000);

  it('does not swing on hard steps up and down, and the motors and the pack agree on the voltage', async () => {
    for (const name of ['quad-x', 'octa-coaxial-16'] as const) {
      const configuration = await configurationOf(name), battery = configuration.drive?.battery;
      if (!battery) throw new Error('No battery');
      // Rest to full, full to nothing, which regenerates, nothing to full.
      const { samples } = hold(configuration, tick => (tick < 2 * HZ ? 1 : tick < 4 * HZ ? 0 : 1), 6);
      const gap = Math.max(...samples.map(sample => Math.abs(sample.voltageV - sample.motorVoltageV) * (sample.limited ? 0 : 1)));
      const highest = Math.max(...samples.map(sample => sample.voltageV));
      console.log(`EVID ${name} steps: ${turns(samples)} turns, widest gap between the pack and the motors ${gap.toFixed(4)} V, highest ${highest.toFixed(3)} V`);
      expect(turns(samples)).toBeLessThanOrEqual(6);
      expect(gap).toBeLessThanOrEqual(0.2);
      expect(highest).toBeLessThanOrEqual(battery.openCircuitFullV + battery.currentLimitA * battery.internalResistanceOhm + 1e-9);
    }
  }, 120000);
});
