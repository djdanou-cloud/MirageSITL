import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { standardGearHeights } from './support/standard-gear.ts';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile, withPropellerPolars, type AircraftProfile } from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { CONFIGURATION_FLAG_WAKE_UNMODELED } from '@mirage/physics/bet-dynamics';
import { buildProfileDynamics, profileFlightDynamics, profileModelPort } from '@mirage/physics/profile-dynamics';
import { VehicleRegistry, validateVehicleManifest, withoutAirframeDrag } from '@mirage/physics/vehicle-manifest';
import { PhysicsSessionV2 } from '../packages/physics/src/session-v2.ts';
import { ActuatorFlagV2, StateReaderV2, VehicleFlagV2, newActuatorFrameV2, newInput, createSharedMemoryV2, createSpscQueue, newFlightStateV2, newHeaderSnapshotV2,
  type CommandResultV2 } from '@mirage/protocol';
import { FIXTURE_NAMES, type FixtureName } from './support/aircraft-derivation.ts';
import { holdHover, trimHover } from './support/hover-trim.ts';

// TASK-144: dynamics built from aircraft profiles and component cards. Oracles:
// a static six-axis hover trim from per-rotor sweeps (tests/support/hover-trim.ts),
// independent of the frame summation and the body integrator; the pitch
// balance of a quad X about its CG; and momentum theory for a propeller change.

const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32);
let module: WebAssembly.Module;
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  // The vehicle stands on its standard landing gear (TASK-095).
  await prepareContact();
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
      expect(limitations.some(text => text.includes('rotor-wake pairs'))).toBe(coaxial);
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

describe('the standard landing gear on the ground contact (TASK-095)', () => {
  for (const name of FIXTURE_NAMES) {
    it(`${name} starts on its extended feet and comes to rest on them at 400, 800 and 1200 Hz`, async () => {
      const built = await build(profileOf(name)), { configuration, gear, derived, limitations } = built;
      // Every S19 configuration stands on the decision D-07 supports; octa-x, without a ground clearance, on supports below its
      // standard hull (derivation 4).
      if (!gear) throw new Error('No gear');
      expect(limitations.some(text => text.includes('no landing gear'))).toBe(false);
      const { touchM, restM } = standardGearHeights(derived.manifest);
      expect(configuration.syntheticGroundDownM).toBeUndefined();
      expect(configuration.initialBody.positionNedM[2]).toBeCloseTo(-touchM, 12);
      // The hull, then a propeller disc per rotor, each named for TASK-149.
      const hull = derived.manifest.hull ?? [];
      expect(gear.shapes).toHaveLength(hull.length + derived.manifest.rotorCount);
      expect(gear.parts).toEqual([...hull.map(shape => ({ part: 'hull', hullId: shape.id })),
        ...derived.manifest.rotors.map(rotor => ({ part: 'propeller', rotorId: rotor.id }))]);
      for (const hz of [400, 800, 1200] as const) {
        const d = profileFlightDynamics(module, built, hz), frame = newActuatorFrameV2(), pilot = newInput();
        frame.motorMapId = configuration.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed; frame.actuatorCount = derived.manifest.rotorCount;
        try {
          // No hull or propeller shape touches the ground on the way to rest (the D-07 supports alone carry the aircraft).
          const report = new Float64Array(8);
          let touched = 0;
          for (let k = 0; k < 2 * hz; k++) {
            d.useActuators(frame); d.nowMs = (k + 1) * 1000 / hz; d.stepNow(pilot);
            for (let i = 0; i < d.contactShapeCount; i++) { d.contactShapeStateInto(i, report); touched += report[6]!; }
          }
          expect(d.fault).toBe('');
          expect(d.contactShapeCount).toBe(gear.shapes.length);
          expect(touched, `${hz} Hz shapes touching`).toBe(0);
          expect(Math.abs(d.state.down + restM), `${hz} Hz rest height`).toBeLessThan(1e-4);
          expect(Math.abs(d.state.vd)).toBeLessThan(1e-4);
          // At rest, not chattering on the feet' friction (a wide stance once flipped the yaw rate every step).
          expect(Math.hypot(d.state.p, d.state.q, d.state.r), `${hz} Hz body rate`).toBeLessThan(1e-6);
        } finally { d.dispose(); }
      }
    }, 300000);
  }
  it('a quad tipped onto its side strikes with the shape that geometry puts lowest, at 400, 800 and 1200 Hz', async () => {
    // Oracle from the geometry alone, not the contact: rolled 60 degrees right side down and pitched 10 degrees nose down (so one
    // disc is lowest, not a pair), each shape's lowest point sits at down = c·d + h·|a·d| + r·√(1 − (a·d)²) for a cylinder (centre
    // c, axis a) and max over its ends + r for a capsule, with d the world down axis in body coordinates. Dropped from 5 mm above
    // the deepest one, that shape strikes first and alone.
    const built = await build(profileOf('quad-x')), { gear } = built;
    if (!gear) throw new Error('No gear');
    const roll = Math.PI / 3, pitch = -Math.PI / 18;
    // Body-to-NED R = Ry(pitch)·Rx(roll) (ZYX Euler, no yaw); d = Rᵀ·[0, 0, 1].
    const down: [number, number, number] = [-Math.sin(pitch), Math.cos(pitch) * Math.sin(roll), Math.cos(pitch) * Math.cos(roll)];
    const [cr, sr, cp, sp] = [Math.cos(roll / 2), Math.sin(roll / 2), Math.cos(pitch / 2), Math.sin(pitch / 2)];
    const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    const lowest = gear.shapes.map(shape => {
      if (shape.kind === 'capsule') return Math.max(dot(shape.startBodyM, down), dot(shape.endBodyM, down)) + shape.radiusM;
      const along = dot(shape.axisBody, down);
      return dot(shape.centerBodyM, down) + shape.halfHeightM * Math.abs(along) + shape.radiusM * Math.sqrt(Math.max(0, 1 - along * along));
    });
    const deepest = lowest.indexOf(Math.max(...lowest)), second = Math.max(...lowest.filter((_, i) => i !== deepest));
    expect(gear.parts[deepest]?.part).toBe('propeller');
    expect(lowest[deepest]! - second, 'a unique deepest shape').toBeGreaterThan(0.002);
    const initialBody = { ...built.configuration.initialBody, positionNedM: Float64Array.from([0, 0, -(lowest[deepest]! + 0.005)]),
      quaternionBodyToNed: Float64Array.from([cp * cr, cp * sr, sp * cr, -sp * sr]) };
    const tipped = { ...built, configuration: { ...built.configuration, initialBody } };
    for (const hz of [400, 800, 1200] as const) {
      const d = profileFlightDynamics(module, tipped, hz), frame = newActuatorFrameV2(), pilot = newInput(), report = new Float64Array(8);
      frame.motorMapId = built.configuration.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed; frame.actuatorCount = 4;
      try {
        const first: number[] = [];
        for (let k = 0; k < hz && first.length === 0; k++) {
          d.useActuators(frame); d.nowMs = (k + 1) * 1000 / hz; d.stepNow(pilot);
          for (let i = 0; i < d.contactShapeCount; i++) if (d.contactShapeStateInto(i, report) && report[6] === 1) first.push(i);
        }
        expect(d.fault).toBe('');
        expect(first, `${hz} Hz first strike`).toEqual([deepest]);
        d.contactShapeStateInto(deepest, report);
        // The reported point is on the struck disc: within its radius of its hub, on the low (right) side.
        const disc = gear.shapes[deepest]!;
        if (disc.kind !== 'cylinder') throw new Error('Expected a disc');
        const offset = [report[3]! - disc.centerBodyM[0], report[4]! - disc.centerBodyM[1], report[5]! - disc.centerBodyM[2]];
        expect(Math.hypot(...offset)).toBeLessThan(disc.radiusM + disc.halfHeightM + 1e-6);
        expect(report[4]!).toBeGreaterThan(0);
      } finally { d.dispose(); }
    }
  }, 300000);
  it('stays on the synthetic pad for benchmarks of the BET compute alone', async () => {
    const { derived } = await build(profileOf('quad-x'));
    const pad = buildProfileDynamics(derived.manifest, { syntheticPad: true });
    expect([pad.gear, pad.configuration.syntheticGroundDownM, pad.configuration.initialBody.positionNedM[2]]).toEqual([null, 0, 0]);
  });
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

  it('turns an airframe drag block into body drag about the CG, and lists a block without an airspeed range', async () => {
    // TASK-096: the manifest's center of pressure is from the body reference point; the dynamics takes it from the CG.
    const { derived, configuration } = await build(profileOf('quad-x'));
    const m = withoutAirframeDrag(derived.manifest), cg = m.massProperties.cgOffsetBodyM;
    // A derived manifest carries the standard hull's preliminary drag (derivation 6), its center of pressure taken from the CG.
    const estimate = derived.manifest.airframe.drag;
    if (!estimate?.maxAirspeedMps) throw new Error('The derived manifest has no drag estimate');
    expect(configuration.airframeDrag).toEqual({ dragAreaBodyM2: estimate.dragAreaBodyM2,
      centerOfPressureCgM: estimate.centerOfPressureBodyM.map((value, i) => value - cg[i]!), maxAirspeedMps: estimate.maxAirspeedMps });
    const withDrag = (maxAirspeedMps?: number) => validateVehicleManifest({
      ...m, airframe: { drag: { dragAreaBodyM2: [0.012, 0, 0, 0, 0.012, 0, 0, 0, 0.03], centerOfPressureBodyM: [0.02, 0, -0.01],
        ...(maxAirspeedMps === undefined ? {} : { maxAirspeedMps }) } },
      provenance: { ...m.provenance, airframeDrag: 'test-drag' },
      datasets: [...m.datasets, { id: 'test-drag', kind: 'synthetic', sourceSha256: null, derivation: 'Test drag areas, not measured' }],
    });
    expect(buildProfileDynamics(m).configuration.airframeDrag).toBeUndefined();
    const ranged = buildProfileDynamics(withDrag(20));
    expect(ranged.configuration.airframeDrag).toEqual({ dragAreaBodyM2: [0.012, 0, 0, 0, 0.012, 0, 0, 0, 0.03],
      centerOfPressureCgM: [0.02 - cg[0]!, 0 - cg[1]!, -0.01 - cg[2]!], maxAirspeedMps: 20 });
    expect(ranged.limitations.some(text => text.includes('airspeed range'))).toBe(false);
    const open = buildProfileDynamics(withDrag());
    expect(open.configuration.airframeDrag?.maxAirspeedMps).toBe(Infinity);
    expect(open.limitations.some(text => text.includes('no airspeed range'))).toBe(true);
    // The dynamics accept it and apply it on the first step in the configured air at rest: zero relative wind, zero drag.
    const d = profileFlightDynamics(module, ranged, 400), pilot = newInput();
    try {
      d.nowMs = 0; pilot.wallTimeMs = 0; d.stepNow(pilot);
      expect(d.fault).toBe('');
      expect(Array.from(d.dragWrenchBody).every(value => Math.abs(value) < 1e-12)).toBe(true);
    } finally { d.dispose(); }
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
