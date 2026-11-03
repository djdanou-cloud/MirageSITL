import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveVehicleManifest } from '@mirage/aircraft/derive-manifest';
import { validateAircraftProfile } from '@mirage/aircraft/profile';
import type { HullShape } from '@mirage/physics/vehicle-manifest';
import { STANDARD_HULL_DRAG, standardHullDrag } from '../packages/aircraft/src/standard-hull-drag.ts';
import { FIXTURE_MODEL_ID, FIXTURE_NAMES, syntheticComponents } from './support/aircraft-derivation.ts';

// TASK-096 increment 2: the standard hull's preliminary drag. Oracle: the drag areas of a body cylinder and arm capsules
// written out by hand from their dimensions and the two stated coefficients, and the tensor's action along and across an arm.

const ACROSS = 1.2, END = 1.17;
const close = (actual: number | undefined, expected: number) => Math.abs((actual ?? NaN) - expected) <= 1e-12 * Math.max(Math.abs(expected), 1e-6);

describe('the standard hull drag estimate', () => {
  it('states its coefficients', () => {
    expect([STANDARD_HULL_DRAG.crossFlowDragCoefficient, STANDARD_HULL_DRAG.endOnDragCoefficient]).toEqual([ACROSS, END]);
  });

  it('adds a body cylinder and an arm along x as their drag areas across and along their axes', () => {
    // Body: radius 0.05 m, half-height 0.02 m. Arm: from the body axis to x = 0.2 m at z = −0.01 m, radius 6 mm, counted from
    // the body radius, so 0.15 m long with its middle at x = 0.125 m.
    const hull: HullShape[] = [
      { id: 0, kind: 'cylinder', centerBodyM: [0, 0, 0], axisBody: [0, 0, 1], radiusM: 0.05, halfHeightM: 0.02 },
      { id: 1, kind: 'capsule', startBodyM: [0, 0, -0.01], endBodyM: [0.2, 0, -0.01], radiusM: 0.006 },
    ];
    const bodySide = ACROSS * (0.1 * 0.04), bodyTop = END * Math.PI * 0.0025;
    const armSide = ACROSS * (0.012 * 0.15), armEnd = END * Math.PI * 0.000036;
    const drag = standardHullDrag(hull), t = drag.dragAreaBodyM2;
    // The body sees its side from x and y and its disc from z; the arm its end from x and its side from y and z.
    expect(close(t[0], bodySide + armEnd)).toBe(true);
    expect(close(t[4], bodySide + armSide)).toBe(true);
    expect(close(t[8], bodyTop + armSide)).toBe(true);
    for (const i of [1, 2, 3, 5, 6, 7]) expect(t[i]).toBe(0);
    // The center of pressure weights the body's center (0, 0, 0) and the arm's middle (0.125, 0, −0.01) by their traces.
    const wBody = 2 * bodySide + bodyTop, wArm = 2 * armSide + armEnd;
    expect(close(drag.centerOfPressureBodyM[0], wArm * 0.125 / (wBody + wArm))).toBe(true);
    expect(drag.centerOfPressureBodyM[1]).toBe(0);
    expect(close(drag.centerOfPressureBodyM[2], wArm * -0.01 / (wBody + wArm))).toBe(true);
    // The widest shape is the 0.1 m body: Re = 2e5 at 2e5·1.4607e-5/0.1 m/s.
    expect(close(drag.maxAirspeedMps, 2e5 * 1.4607e-5 / 0.1)).toBe(true);
  });

  it('turns an arm at 45° into a tensor with its end area along the arm and its side area across it', () => {
    const c = Math.SQRT1_2, hull: HullShape[] = [
      { id: 0, kind: 'cylinder', centerBodyM: [0, 0, 0], axisBody: [0, 0, 1], radiusM: 0.05, halfHeightM: 0.02 },
      { id: 1, kind: 'capsule', startBodyM: [0, 0, 0], endBodyM: [0.2 * c, 0.2 * c, 0], radiusM: 0.006 },
    ];
    const t = standardHullDrag(hull).dragAreaBodyM2, body = ACROSS * 0.004, top = END * Math.PI * 0.0025;
    const side = ACROSS * 0.012 * 0.15, end = END * Math.PI * 0.000036;
    const apply = (v: readonly number[]) => [0, 1, 2].map(i => t[3 * i]! * v[0]! + t[3 * i + 1]! * v[1]! + t[3 * i + 2]! * v[2]!);
    // Along the arm: the body's side plus the arm's end; across it, horizontally: the body's side plus the arm's side.
    const along = apply([c, c, 0]), across = apply([-c, c, 0]), up = apply([0, 0, 1]);
    for (const [vector, direction, area] of [[along, [c, c, 0], body + end], [across, [-c, c, 0], body + side], [up, [0, 0, 1], top + side]] as const) {
      for (let i = 0; i < 3; i++) expect(close(vector[i], area * direction[i]!)).toBe(true);
    }
    expect(t[1]).toBe(t[3]);
  });

  it('gives every S19 fixture a symmetric positive-definite drag, centered on the body axis for its symmetric frame', async () => {
    for (const name of FIXTURE_NAMES) {
      const profile = validateAircraftProfile(JSON.parse(readFileSync(new URL(`./fixtures/aircraft/${name}.json`, import.meta.url), 'utf8')));
      const { manifest } = await deriveVehicleManifest(profile, syntheticComponents(profile), { modelId: FIXTURE_MODEL_ID });
      const drag = manifest.airframe.drag;
      if (!drag || !manifest.hull) throw new Error(`${name}: no drag`);
      expect(drag).toEqual(standardHullDrag(manifest.hull));
      const t = drag.dragAreaBodyM2;
      expect([t[1], t[2], t[5]]).toEqual([t[3], t[6], t[7]]);
      const minors = [t[0]!, t[0]! * t[4]! - t[1]! * t[3]!,
        t[0]! * (t[4]! * t[8]! - t[5]! * t[7]!) - t[1]! * (t[3]! * t[8]! - t[5]! * t[6]!) + t[2]! * (t[3]! * t[7]! - t[4]! * t[6]!)];
      expect(minors.every(value => value > 0), name).toBe(true);
      // X frames with equal arms: no preferred horizontal direction and the center of pressure on the body axis.
      expect(Math.abs(t[0]! - t[4]!) / t[0]!, name).toBeLessThan(1e-12);
      expect(Math.hypot(drag.centerOfPressureBodyM[0]!, drag.centerOfPressureBodyM[1]!), name).toBeLessThan(1e-12);
      // The range ends at the body: its diameter is half the shortest arm.
      const shortest = Math.min(...profile.arms.map(arm => arm.lengthM));
      expect(close(drag.maxAirspeedMps, 2e5 * 1.4607e-5 / (0.5 * shortest)), name).toBe(true);
    }
  });
});
