import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareContact } from './contact-support.ts';
import { clearanceFix, describeClash, propellerClearance } from '@mirage/aircraft/clearance';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import { DERIVED_DATASET_ID, STANDARD_HULL_DATASET_ID, STANDARD_HULL_DRAG_DATASET_ID, deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import {
  bodyOf, validateAircraftProfile, withAirframeDrag, withBody, withPropellerPolars, type AircraftProfile, type BodySpec,
} from '@mirage/aircraft/profile';
import { resolveComponents } from '@mirage/aircraft/resolve-components';
import { bodyHull, hullPartNames, standardHull } from '@mirage/aircraft/standard-hull';
import { standardHullDrag } from '@mirage/aircraft/standard-hull-drag';
import { canonicalBytes } from '@mirage/project/schema';
import { describeAccident, type AccidentEvent } from '@mirage/physics/accident';
import { buildProfileDynamics, profileFlightDynamics, type ProfileDynamicsBuild } from '@mirage/physics/profile-dynamics';
import { ActuatorFlagV2, newActuatorFrameV2, newInput } from '@mirage/protocol';

// TASK-196: the body, arm thickness and body parts of an aircraft profile (schema 7), in place of
// the standard hull. Oracles are worked by hand from the entered sizes: a cylinder's centre lies half
// its height above its bottom, an arm runs from the body axis to its mount, and a part's lowest
// point lies at its bottom depth. The landing test compares two profiles that differ only in how
// far the pod hangs: 3 mm above the ground at rest, which a touchdown at about 2 m/s must reach
// (the supports travel 25 mm), and 40 mm, which it must not.

const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32);
const PROPELLER_RADIUS_M = 0.127;

function json(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}
function card(type: string): ComponentCard {
  const base = json(`./fixtures/components/${type}-example.json`);
  if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) throw new Error(`Invalid ${type} card`);
  const provenance = Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example']));
  return validateComponentCard({ ...base, provenance });
}
/** The quad X fixture (ground clearance 0.12 m) with the example cards and a catalog polar. */
function quad(): AircraftProfile {
  const fixture = validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
  return withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: BATTERY },
    motors: fixture.motors.map(motor => ({ ...motor, components: { motor: MOTOR, propeller: PROPELLER, esc: ESC } })) }),
  [{ card: PROPELLER, polar: 'naca6409-neuralfoil-v1' }]);
}
/** A body 0.11 m across and 0.045 m tall centred on the reference point, 13 mm arms, and a camera pod whose bottom is at `podDepthM`. */
function podBody(podDepthM: number): BodySpec {
  return { diameterM: 0.11, heightM: 0.045, bottomDepthM: 0.0225, armDiameterM: 0.013,
    parts: [{ name: 'camera pod', xM: 0.05, yM: 0, bottomDepthM: podDepthM, diameterM: 0.06, heightM: 0.05 }] };
}
const radius = (): number => PROPELLER_RADIUS_M;
async function derive(profile: AircraftProfile) {
  const cards = new Map([[MOTOR, card('motor')], [PROPELLER, card('propeller')], [ESC, card('esc')], [BATTERY, card('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  return deriveVehicleManifest(profile, resolved.components, { modelId: 196 });
}

describe('aircraft profile schema 7: a described body', () => {
  it('is the canonical schema exactly while a body is described, and removing it restores the former bytes', () => {
    const base = quad(), body = podBody(0.117);
    expect(base.schemaVersion).toBe(4);
    const described = withBody(base, body);
    expect(described.schemaVersion).toBe(7);
    expect(bodyOf(described)).toEqual(body);
    expect(validateAircraftProfile(JSON.parse(JSON.stringify(described)))).toEqual(described);
    expect(canonicalBytes(withBody(described, null))).toEqual(canonicalBytes(base));
    // Stated drag and the body together stay schema 7, and dropping the body gives schema 5.
    const drag = { dragAreasM2: [0.01, 0.01, 0.02], centerOfPressureBodyM: [0, 0, 0], maxAirspeedMps: 20, source: 'test' };
    const both = withAirframeDrag(described, drag);
    expect(both.schemaVersion).toBe(7);
    expect(withBody(both, null).schemaVersion).toBe(5);
  });

  it('rejects a body in another schema, an arm that ends inside the body, repeated part names and too many hull shapes', () => {
    const described = withBody(quad(), podBody(0.117));
    expect(() => validateAircraftProfile({ ...described, schemaVersion: 6, propulsionCalibrations: [] })).toThrow(/body appears exactly in schema 7|at least one propulsion calibration/);
    expect(() => withBody(quad(), { ...podBody(0.117), diameterM: 0.5 })).toThrow('Arm 1 ends inside the body');
    const pod = podBody(0.117).parts[0]!;
    expect(() => withBody(quad(), { ...podBody(0.117), parts: [pod, { ...pod, xM: -0.05 }] })).toThrow('Two body parts are named camera pod');
    expect(() => withBody(quad(), { ...podBody(0.117), parts: [{ ...pod, name: ' pod' }] })).toThrow('leading or trailing spaces');
    // Four arms leave room for eleven parts; the schema allows seven.
    const eight = Array.from({ length: 8 }, (_, k) => ({ ...pod, name: `part ${k}` }));
    expect(() => withBody(quad(), { ...podBody(0.117), parts: eight })).toThrow('/body/parts must NOT have more than 7 items');
    expect(() => withBody(quad(), { ...podBody(0.117), heightM: 0 })).toThrow('/body/heightM');
  });

  it('gives the hull from the entered sizes: the body, one capsule per arm, then the parts, named for reports', () => {
    const profile = withBody(quad(), podBody(0.117));
    const hull = bodyHull(profile, podBody(0.117));
    expect(hull.map(shape => [shape.id, shape.kind])).toEqual([[0, 'cylinder'], [1, 'capsule'], [2, 'capsule'], [3, 'capsule'], [4, 'capsule'], [5, 'cylinder']]);
    const [body, , , , , pod] = hull;
    if (body?.kind !== 'cylinder' || pod?.kind !== 'cylinder') throw new Error('Expected cylinders');
    expect(body.radiusM).toBe(0.055);
    expect(body.halfHeightM).toBe(0.0225);
    expect(body.centerBodyM[2]).toBeCloseTo(0, 12);
    expect(pod.centerBodyM[0]).toBe(0.05);
    expect(pod.centerBodyM[2]).toBeCloseTo(0.117 - 0.025, 12);
    expect(pod.radiusM).toBe(0.03);
    for (const [index, arm] of profile.arms.entries()) {
      const shape = hull[index + 1];
      if (shape?.kind !== 'capsule') throw new Error('Expected a capsule');
      expect(shape.radiusM).toBe(0.0065);
      expect(shape.startBodyM).toEqual([0, 0, 0]);
      expect(shape.endBodyM[0]).toBeCloseTo(arm.lengthM * Math.cos(arm.azimuthRad), 12);
      expect(shape.endBodyM[1]).toBeCloseTo(arm.lengthM * Math.sin(arm.azimuthRad), 12);
    }
    expect(hullPartNames(profile)).toEqual(['The body', 'Arm 1', 'Arm 2', 'Arm 3', 'Arm 4', 'The body (camera pod)']);
    expect(hullPartNames(quad())).toEqual(['The body', 'Arm 1', 'Arm 2', 'Arm 3', 'Arm 4']);
  });

  it('derives the manifest with the described hull from the profile, and a profile without a body keeps its bytes', async () => {
    const base = await derive(quad()), described = await derive(withBody(quad(), podBody(0.117)));
    // Without a body the hull is the standard hull, from its own synthetic dataset.
    expect(base.manifest.hull).toEqual(standardHull(quad(), radius));
    expect(base.manifest.provenance.hull).toBe(STANDARD_HULL_DATASET_ID);
    expect(described.manifest.hull).toEqual(bodyHull(withBody(quad(), podBody(0.117)), podBody(0.117)));
    expect(described.manifest.provenance.hull).toBe(DERIVED_DATASET_ID);
    expect(described.manifest.datasets.map(dataset => dataset.id)).not.toContain(STANDARD_HULL_DATASET_ID);
    // The drag estimate is the body's, labelled as such.
    expect(described.manifest.airframe.drag).toEqual(standardHullDrag(described.manifest.hull ?? []));
    const drag = described.manifest.datasets.find(dataset => dataset.id === STANDARD_HULL_DRAG_DATASET_ID);
    expect(drag && 'derivation' in drag ? drag.derivation : '').toContain('from the body the aircraft profile describes');
    const baseDrag = base.manifest.datasets.find(dataset => dataset.id === STANDARD_HULL_DRAG_DATASET_ID);
    expect(baseDrag && 'derivation' in baseDrag ? baseDrag.derivation : '').toContain('from the synthetic standard hull');
    // The supports at the stated clearance do not depend on the body.
    expect(described.manifest.landingGear).toEqual(base.manifest.landingGear);
  });

  it('a profile without a clearance rests with the pod, its lowest point, one static deflection above the ground', async () => {
    const free = withBody(validateAircraftProfile({ ...quad(), groundClearanceM: null }), podBody(0.117));
    const report = propellerClearance(free, radius);
    expect(report.clearanceStated).toBe(false);
    expect(Math.abs(report.groundClearanceM - (0.117 + 0.005))).toBeLessThan(1e-9);
    expect(report.clashes).toEqual([]);
    const gear = (await derive(free)).manifest.landingGear;
    const standard = (await derive(validateAircraftProfile({ ...quad(), groundClearanceM: 0.122 }))).manifest.landingGear;
    expect(gear).toEqual(standard);
  });
});

describe('propeller clearance with a described body (TASK-195 checks)', () => {
  it('reports a pod below a stated clearance as the body on the ground, and the fix raises the clearance to clear it', () => {
    const low = withBody(quad(), podBody(0.13));
    const report = propellerClearance(low, radius);
    expect(report.clashes).toHaveLength(1);
    const clash = report.clashes[0];
    if (clash?.kind !== 'ground') throw new Error('Expected a ground clash');
    expect(clash.part).toEqual({ kind: 'body-part', name: 'camera pod' });
    expect(Math.abs(clash.depthM - 0.01)).toBeLessThan(1e-9);
    expect(describeClash(clash)).toBe('The body (camera pod) reaches 10.0 mm below the ground at rest');
    const fix = clearanceFix(low, radius);
    expect(fix?.changes).toEqual([{ label: 'Ground clearance', beforeM: 0.12, afterM: 0.135 }]);
    expect(fix?.after.clashes).toEqual([]);
    // The same pod 3 mm above the ground at rest clears.
    expect(propellerClearance(withBody(quad(), podBody(0.117)), radius).clashes).toEqual([]);
  });

  it('checks the propellers against the entered body and its parts, not the standard body, and the fix grows the arms', () => {
    // A body 0.26 m across: each hub is 0.225 m out, so each propeller tip reaches 0.032 m into it seen from above.
    const wide = withBody(quad(), { ...podBody(0.117), diameterM: 0.26 });
    const report = propellerClearance(wide, radius);
    expect(report.clashes.map(clash => clash.kind)).toEqual(['propeller-body', 'propeller-body', 'propeller-body', 'propeller-body']);
    for (const clash of report.clashes) if (clash.kind === 'propeller-body') expect(Math.abs(clash.overlapM - (0.13 + 0.127 - 0.225))).toBeLessThan(1e-9);
    expect(propellerClearance(quad(), radius).clashes).toEqual([]);
    // A wide cargo box beside the body at hub height reaches the propellers of the arms beside it.
    const cargo = withBody(quad(), { ...podBody(0.117), parts: [{ name: 'cargo box', xM: 0, yM: 0.16, bottomDepthM: 0.02, diameterM: 0.1, heightM: 0.05 }] });
    const reached = propellerClearance(cargo, radius).clashes;
    expect(reached.length).toBeGreaterThan(0);
    for (const clash of reached) expect(clash.kind === 'propeller-body' && clash.part).toBe('cargo box');
    expect(describeClash(reached[0]!)).toMatch(/^The propeller of motor \d reaches \d+\.\d mm into the body \(cargo box\)$/);
    const fix = clearanceFix(wide, radius);
    expect(fix?.armScale).toBeGreaterThan(1);
    expect(fix?.after.clashes).toEqual([]);
    expect(bodyOf(fix!.profile)).toEqual(bodyOf(wide));
  });
});

describe('a landing that scrapes the pod (WASM dynamics)', () => {
  let module: WebAssembly.Module;
  beforeAll(async () => {
    execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
    module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
    await prepareContact();
  }, 600000);

  async function build(podDepthM: number): Promise<{ built: ProfileDynamicsBuild; names: string[] }> {
    const profile = withBody(quad(), podBody(podDepthM));
    return { built: buildProfileDynamics((await derive(profile)).manifest), names: hullPartNames(profile) };
  }
  /** Motors armed at zero; the vehicle starts `dropM` above its extended feet touching the ground. Every accident of `ticks` steps at 400 Hz. */
  function run(built: ProfileDynamicsBuild, dropM: number, ticks: number): AccidentEvent[] {
    const touch = -built.configuration.initialBody.positionNedM[2]!;
    const start = { ...built, configuration: { ...built.configuration, initialBody: { ...built.configuration.initialBody,
      positionNedM: Float64Array.from([0, 0, -(touch + dropM)]) } } };
    const d = profileFlightDynamics(module, start, 400), frame = newActuatorFrameV2(), pilot = newInput();
    frame.motorMapId = start.configuration.motorMapId; frame.actuatorFlags = ActuatorFlagV2.Armed; frame.actuatorCount = 4;
    const events: AccidentEvent[] = [];
    try {
      for (let k = 1; k <= ticks; k++) {
        d.useActuators(frame); d.nowMs = k * 2.5; d.stepNow(pilot);
        d.accidents!.at[0] = k; d.accidents!.at[1] = k / 400;
        d.accidents!.check();
        d.accidents!.drain(event => events.push(event));
      }
      return events;
    } finally { d.dispose(); }
  }

  it('a touchdown at about 2 m/s reports the pod 3 mm above the ground as a body contact; at rest it touches nothing', async () => {
    const { built, names } = await build(0.117);
    expect(run(built, 0, 800)).toEqual([]);
    const events = run(built, 0.2, 800);
    expect(events.length).toBeGreaterThan(0);
    const first = events[0]!;
    expect(first.part).toEqual({ part: 'hull', hullId: 5 });
    expect(events.every(event => event.part.part === 'hull' && event.part.hullId === 5)).toBe(true);
    expect(describeAccident(first, names)).toMatch(/^The body \(camera pod\) struck the ground at \d+\.\d\d s: /);
  }, 300000);

  it('the same touchdown leaves a pod 40 mm above the ground clear', async () => {
    const { built } = await build(0.08);
    expect(run(built, 0.2, 800)).toEqual([]);
  }, 300000);
});
