import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { CONFIGURATION_FLAG_WAKE_UNMODELED } from '@mirage/physics/bet-dynamics';
import { buildProfileDynamics, profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { StateReaderV2, VehicleFlagV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2,
  type CommandResultV2 } from '@mirage/protocol';
import { FIXTURE_NAMES, type FixtureName } from './support/aircraft-derivation.ts';
import { holdHover, trimHover } from './support/hover-trim.ts';

// TASK-144: dynamics built from aircraft profiles and component cards. Oracles:
// a static six-axis hover trim from per-rotor sweeps (tests/support/hover-trim.ts),
// independent of the frame summation and the body integrator; the pitch
// balance of a quad X about its CG; and momentum theory for a propeller change.

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
const cards = (propeller: Record<string, unknown> = {}): Map<string, ComponentCard> => new Map([
  [MOTOR, card('motor')], [PROPELLER, card('propeller', propeller)], [ESC, card('esc')], [BATTERY, card('battery')]]);
/** An S19 fixture with the example cards on every motor and NACA6409 chosen for the propeller. */
function profileOf(name: FixtureName, edit: (profile: AircraftProfile) => AircraftProfile = p => p): AircraftProfile {
  const fixture = validateAircraftProfile(json(`./fixtures/aircraft/${name}.json`));
  const fitted = validateAircraftProfile({ ...edit(fixture), battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) });
  return withPropellerPolars(fitted, [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
}
async function build(profile: AircraftProfile, propeller: Record<string, unknown> = {}) {
  const resolved = resolveComponents(profile, cards(propeller));
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  const derived = await deriveVehicleManifest(profile, resolved.components, { modelId: 144 });
  return { derived, ...buildProfileDynamics(derived.manifest) };
}

describe('S19 configurations on the example cards', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name} loads and holds a trimmed hover`, async () => {
      const { derived, configuration, limitations } = await build(profileOf(name));
      expect(configuration.drive?.motors).toHaveLength(derived.manifest.rotorCount);
      const coaxial = derived.manifest.rotorWakePairs.length > 0;
      expect(limitations.length > 0).toBe(coaxial);
      expect((configuration.configurationFlags ?? 0) & CONFIGURATION_FLAG_WAKE_UNMODELED).toBe(coaxial ? CONFIGURATION_FLAG_WAKE_UNMODELED : 0);
      const trim = trimHover(module, configuration);
      // The static balance converges and leaves every motor inside its range.
      expect(trim.residual).toBeLessThan(1e-6);
      for (const duty of trim.duty) expect(duty > 0.05 && duty < 0.95, `duty ${duty}`).toBe(true);
      const hold = holdHover(module, configuration, trim);
      // Tolerances fixed before the run: after 4 s the loop around the trim needs almost no correction.
      expect(hold.correctionRelative).toBeLessThan(0.002);
      expect(hold.verticalSpeedMps).toBeLessThan(0.02);
      expect(hold.bodyRateRadS).toBeLessThan(0.005);
      expect(hold.attitudeErrorRad).toBeLessThan(0.01);
    }, 300000);
  }
});

describe('geometry and component changes change the forces', () => {
  it('splits a quad X hover thrust by the lever arms about the CG, for any arm length', async () => {
    for (const lengthM of [0.225, 0.3]) {
      const profile = profileOf('quad-x', p => validateAircraftProfile({ ...p, arms: p.arms.map(arm => ({ ...arm, lengthM })) }));
      const { configuration } = await build(profile);
      const trim = trimHover(module, configuration);
      // Pitch balance about the CG (x = 0.005 m): T_front·(L/√2 − x_cg) = T_rear·(L/√2 + x_cg).
      const half = lengthM / Math.SQRT2, cg = 0.005, front = trim.thrustN[0]!, rear = trim.thrustN[1]!;
      expect(Math.abs(front / rear - (half + cg) / (half - cg))).toBeLessThan(1e-6);
      expect(trim.thrustN[0]).toBe(trim.thrustN[2]);
      // The total carries the weight.
      expect(Math.abs(trim.thrustN.reduce((s, t) => s + t, 0) - 1.5 * 9.80665)).toBeLessThan(1e-6);
    }
  }, 300000);

  it('hovers a larger propeller slower and on less power, as momentum theory predicts', async () => {
    const small = trimHover(module, (await build(profileOf('quad-x'))).configuration);
    // 11 in instead of 10 in, the same pitch-to-diameter ratio and mass.
    const large = trimHover(module, (await build(profileOf('quad-x'), { diameterM: 0.2794, pitchM: 0.12573 })).configuration);
    const mean = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
    // Ideal hover power T^1.5/sqrt(2ρA) falls with disk area; at a fixed thrust coefficient Ω ∝ 1/D².
    expect(mean(large.omegaRadS)).toBeLessThan(mean(small.omegaRadS));
    expect(large.motorPowerW).toBeLessThan(small.motorPowerW);
  }, 300000);
});

describe('model.load of profile dynamics through the session registry', () => {
  async function harness(withModule = true) {
    const { derived } = await build(profileOf('octa-coaxial-16'));
    const registry = new VehicleRegistry();
    await registry.register(derived.bytes, derived.sha256);
    const stateBuffer = createSharedMemoryV2();
    const session = new PhysicsSessionV2({ type: 'init-v2', protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue('sensor'),
      actuatorBuffer: createSpscQueue('actuator') }, { monotonicMs: () => 0, wallMs: () => 1_790_000_000_000 }, undefined, null,
    profileModelPort(registry, () => (withModule ? module : null)));
    const reader = new StateReaderV2(stateBuffer), header = newHeaderSnapshotV2(), state = newFlightStateV2();
    const results: CommandResultV2[] = [];
    let requestId = 0;
    const command = async (type: string, extra: Record<string, unknown> = {}) => {
      reader.readHeader(header);
      session.handle({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: header.sessionEpoch, type, ...extra });
      await session.settled();
      session.drain(result => results.push(result));
      return results.at(-1);
    };
    return { derived, session, command, reader, state };
  }

  it('loads the 16-rotor profile model, publishes it and flags the unmodeled coaxial wakes', async () => {
    const h = await harness();
    expect(await h.command('model.load', { modelId: 144, manifestSha256: h.derived.sha256 })).toMatchObject({ type: 'ack-v2', status: 'applied' });
    expect(h.session.rotorCount()).toBe(16);
    expect(h.reader.latest(h.state)).toBe(true);
    expect(h.state.modelId).toBe(144);
    expect(h.state.vehicleFlags & VehicleFlagV2.ModelOutsideValidity).toBeTruthy();
    // The battery bus is live: the unloaded pack's voltage is published.
    expect(h.state.batteryVoltage).toBeCloseTo(16.8, 5);
    h.session.dispose();
  }, 300000);

  it('rejects a load without the BET module or with another hash, keeping the session unchanged', async () => {
    const missing = await harness(false);
    const result = await missing.command('model.load', { modelId: 144, manifestSha256: missing.derived.sha256 });
    expect(result).toMatchObject({ type: 'reject-v2', code: 'ASSET_MISSING' });
    expect(result?.type === 'reject-v2' ? result.message : '').toContain('BET module is not loaded');
    const h = await harness();
    const wrong = await h.command('model.load', { modelId: 144, manifestSha256: 'ab'.repeat(32) });
    expect(wrong?.type === 'reject-v2' ? wrong.message : '').toContain('hash does not match');
    expect(h.session.rotorCount()).not.toBe(16);
    missing.session.dispose(); h.session.dispose();
  }, 300000);
});
