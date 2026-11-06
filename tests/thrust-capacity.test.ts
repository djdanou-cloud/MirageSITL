import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { BetFlightDynamics, type BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { validateModelManifest } from '@mirage/physics/model-manifest';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import { thrustCapacity } from '@mirage/physics/thrust-capacity';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';
import { FIXTURE_NAMES, type FixtureName } from './support/aircraft-derivation.ts';

// The thrust at full command against an oracle that shares none of its loop: the flight dynamics itself, on a body
// a hundred thousand times heavier with gravity off, so it stays still in still air. Its thrust is mass times the
// acceleration its integrator reports. The two share the bus solve of TASK-197, so the oracle flies a stiff pack, whose
// voltage hardly moves and which no demand reaches the limit of: rotors, drive and frame are what it checks. The sag and the
// limit are checked by hand against the pack's own law, and tests/bus-coupling.test.ts flies the real pack. The tolerance, 0.5 % of the thrust, was set before the first run: it allows for the speed the heavy body
// gathers, about a thousandth of a metre per second against an induced velocity of metres per second.

const MOTOR = 'a'.repeat(64), PROPELLER = 'b'.repeat(64), ESC = 'c'.repeat(64), BATTERY = 'd'.repeat(64);
let module: WebAssembly.Module;
beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
}, 300000);

function json(path: string): unknown { return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')); }
function card(type: string, values: Record<string, unknown> = {}): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object') throw new Error('Invalid card');
  const merged = { ...base.values, ...values };
  return validateComponentCard({ ...base, values: merged, provenance: Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, value === null ? null : 'example'])) });
}
function profileOf(name: FixtureName, edit: (profile: AircraftProfile) => AircraftProfile = p => p): AircraftProfile {
  const fixture = validateAircraftProfile(json(`./fixtures/aircraft/${name}.json`));
  const fitted = validateAircraftProfile({ ...edit(fixture), battery: { card: BATTERY }, motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) });
  return withPropellerPolars(fitted, [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
}
async function configurationOf(profile: AircraftProfile, initialStateOfCharge = 1, motor: Record<string, unknown> = {}): Promise<BetFlightConfiguration> {
  const cards = new Map([[MOTOR, card('motor', motor)], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 177 });
  return buildProfileDynamics(derived.manifest, { initialStateOfCharge, syntheticPad: true }).configuration;
}
/** The dynamics at full command on a body too heavy to move, and a pack too large to drain: mass times the acceleration its integrator reports. */
function flownThrustN(configuration: BetFlightConfiguration): number {
  const scale = 1e5, drive = configuration.drive;
  if (!drive) throw new Error('No drive');
  const manifest = validateModelManifest(configuration.manifest);
  const heavy: BetFlightConfiguration = { ...configuration, gravityMps2: 0, syntheticGroundDownM: undefined,
    manifest: { ...structuredClone(configuration.manifest as object), massKg: manifest.massKg * scale, inertiaBodyKgM2: manifest.inertiaBodyKgM2.map(value => value * scale) },
    drive: { ...drive, battery: { ...drive.battery, capacityAh: drive.battery.capacityAh * 1e6 } },
    initialBody: { ...configuration.initialBody, positionNedM: new Float64Array([0, 0, -100]) } };
  const hz = 800, d = new BetFlightDynamics(module, heavy, hz);
  try {
    const frame = newActuatorFrameV2(), pilot = newInput();
    frame.motorMapId = heavy.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed;
    frame.actuatorCount = Math.max(...manifest.rotors.map(rotor => rotor.motorChannel)) + 1;
    for (const rotor of manifest.rotors) frame.normalizedActuators[rotor.motorChannel] = 1;
    const seconds = 5, measureFrom = seconds - 1;
    let velocityAt = 0;
    for (let tick = 0; tick < seconds * hz; tick++) {
      d.useActuators(frame); d.nowMs = (tick + 1) * 1000 / hz; d.stepNow(pilot);
      if (d.fault !== '') throw new Error(d.fault);
      if (tick + 1 === measureFrom * hz) velocityAt = d.state.vd;
    }
    return -(d.state.vd - velocityAt) * manifest.massKg * scale;
  } finally { d.dispose(); }
}

/** The same aircraft on a pack too stiff to sag and too large to limit. */
function stiff(configuration: BetFlightConfiguration): BetFlightConfiguration {
  const drive = configuration.drive;
  if (!drive) throw new Error('No drive');
  return { ...configuration, drive: { ...drive, battery: { ...drive.battery, internalResistanceOhm: 1e-5, currentLimitA: 1e5 } } };
}

describe('the thrust at full command', () => {
  it.each(FIXTURE_NAMES)('%s on a stiff pack gives what the flight dynamics gives', async name => {
    const configuration = stiff(await configurationOf(profileOf(name)));
    const capacity = thrustCapacity(module, configuration), flown = flownThrustN(configuration);
    console.log(`EVID ${name}: ${capacity.thrustN.toFixed(2)} N against ${flown.toFixed(2)} N flown, weight ${capacity.weightN.toFixed(2)} N, ${capacity.rotors[0]?.rpm.toFixed(0)} rev/min`);
    expect(Math.abs(capacity.thrustN - flown) / flown).toBeLessThanOrEqual(0.005);
    expect(capacity.packLimited).toBe(false);
  }, 120000);

  it('settles where the motors and the pack agree, by the pack\'s own law', async () => {
    const configuration = await configurationOf(profileOf('quad-x')), capacity = thrustCapacity(module, configuration), battery = configuration.drive?.battery;
    if (!battery) throw new Error('No battery');
    console.log(`EVID quad-x on its pack: ${capacity.thrustN.toFixed(2)} N, ratio ${capacity.thrustToWeight.toFixed(3)}, ${capacity.busVoltageV.toFixed(3)} V, ${capacity.busCurrentA.toFixed(2)} A, ${capacity.motorPowerW.toFixed(1)} W, limited ${capacity.packLimited}`);
    expect(capacity.packLimited).toBe(false);
    // V = V_full - R·I at a full pack, and the motors draw what it delivers, V·I.
    expect(Math.abs(capacity.busVoltageV - (battery.openCircuitFullV - battery.internalResistanceOhm * capacity.busCurrentA))).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(capacity.motorPowerW - capacity.busVoltageV * capacity.busCurrentA) / capacity.motorPowerW).toBeLessThanOrEqual(1e-3);
    expect(capacity.busCurrentA).toBeLessThan(battery.currentLimitA);
  }, 120000);

  it('counts each rotor once, and weighs the aircraft with its payload', async () => {
    const plain = thrustCapacity(module, await configurationOf(profileOf('quad-x')));
    expect(plain.rotors).toHaveLength(4);
    // The airframe under the wakes takes its download off the total (TASK-101).
    expect(plain.airframeDownloadN).toBeGreaterThan(0);
    expect(plain.thrustN + plain.airframeDownloadN).toBeCloseTo(plain.rotors.reduce((sum, rotor) => sum + rotor.thrustN, 0), 6);
    const manifest = validateModelManifest((await configurationOf(profileOf('quad-x'))).manifest);
    expect(plain.weightN).toBeCloseTo(manifest.massKg * 9.80665, 9);
    expect(plain.thrustToWeight).toBeCloseTo(plain.thrustN / plain.weightN, 12);
    // A kilogram more changes the weight by g, and not the thrust.
    const heavier = thrustCapacity(module, await configurationOf(profileOf('quad-x', profile => ({ ...profile, payload: { massKg: 1, cgOffsetBodyM: [0, 0, 0], inertiaCgKgM2: [0, 0, 0, 0, 0, 0, 0, 0, 0] } }))));
    expect(heavier.weightN - plain.weightN).toBeCloseTo(9.80665, 9);
    expect(heavier.thrustN).toBeCloseTo(plain.thrustN, 6);
  }, 120000);

  it('a part-charged pack gives less, and the bus stands where the pack\'s own law puts it', async () => {
    const configuration = await configurationOf(profileOf('quad-x'), 0.3), full = thrustCapacity(module, await configurationOf(profileOf('quad-x'))), part = thrustCapacity(module, configuration);
    expect(part.stateOfCharge).toBe(0.3);
    expect(part.thrustN).toBeLessThan(full.thrustN);
    const battery = configuration.drive?.battery;
    if (!battery) throw new Error('No battery');
    // V = V_empty + (V_full - V_empty)·soc - R·I, by hand.
    const open = battery.openCircuitEmptyV + (battery.openCircuitFullV - battery.openCircuitEmptyV) * 0.3;
    expect(part.busVoltageV).toBeCloseTo(open - battery.internalResistanceOhm * part.busCurrentA, 3);
  }, 120000);

  it('a motor current limit holds the thrust down, and says so', async () => {
    const free = thrustCapacity(module, await configurationOf(profileOf('quad-x')));
    const limited = thrustCapacity(module, await configurationOf(profileOf('quad-x'), 1, { maxCurrentA: 3 }));
    expect(free.rotors.every(rotor => !rotor.currentLimited)).toBe(true);
    expect(limited.rotors.every(rotor => rotor.currentLimited)).toBe(true);
    expect(limited.thrustN).toBeLessThan(free.thrustN);
    for (const rotor of limited.rotors) expect(rotor.motorCurrentA).toBeCloseTo(3, 3);
  }, 120000);

  it('a pack current limit holds the thrust down, says so, and the motors draw no more than the pack delivers', async () => {
    const configuration = await configurationOf(profileOf('quad-x')), free = thrustCapacity(module, configuration);
    const drive = configuration.drive;
    if (!drive) throw new Error('No drive');
    expect(free.packLimited).toBe(false);
    const limitA = free.busCurrentA / 2, limited = thrustCapacity(module, { ...configuration, drive: { ...drive, battery: { ...drive.battery, currentLimitA: limitA } } });
    expect(limited.packLimited).toBe(true);
    expect(limited.thrustN).toBeLessThan(free.thrustN);
    // Settled to a millionth of the speed, so a motor's power and the pack's current sit that close to the limit.
    expect(Math.abs(limited.busCurrentA - limitA)).toBeLessThanOrEqual(1e-4);
    // The pack delivers (V_full - R·I_limit)·I_limit, by hand, and that is all the motors get.
    const delivered = (drive.battery.openCircuitFullV - drive.battery.internalResistanceOhm * limitA) * limitA;
    expect(Math.abs(limited.motorPowerW - delivered) / delivered).toBeLessThanOrEqual(1e-3);
    console.log(`EVID quad-x limited to ${limitA.toFixed(1)} A: ${limited.thrustN.toFixed(2)} N against ${free.thrustN.toFixed(2)} N, motors ${limited.motorPowerW.toFixed(1)} W, pack ${delivered.toFixed(1)} W`);
  }, 120000);

  it('the sixteen-motor aircraft on one example pack is held by the pack, where a flight today is not', async () => {
    const capacity = thrustCapacity(module, await configurationOf(profileOf('octa-coaxial-16')));
    expect(capacity.packLimited).toBe(true);
    // 125 A at 14.55 V is 1819 W; a flight's motors draw 4458 W here, for 285.8 N.
    expect(Math.abs(capacity.motorPowerW - 125 * 14.55) / capacity.motorPowerW).toBeLessThanOrEqual(1e-3);
    expect(capacity.thrustN).toBeLessThan(285.8);
    console.log(`EVID octa-coaxial-16: ${capacity.thrustN.toFixed(2)} N, ratio ${capacity.thrustToWeight.toFixed(3)}, motors ${capacity.motorPowerW.toFixed(1)} W`);
  }, 120000);

  it('refuses a configuration without a drive', async () => {
    const configuration = await configurationOf(profileOf('quad-x'));
    expect(() => thrustCapacity(module, { ...configuration, drive: undefined })).toThrow('ESC drive');
  });
});
