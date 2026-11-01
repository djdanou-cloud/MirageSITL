import { Quaternion } from 'three';
import type { AircraftLayout } from '@mirage/aircraft/layout';
import { nedToRenderBasis } from '../coordinates';

// Render poses of the aircraft scheme (TASK-141). Body FRD maps to the render
// basis as NED does at a level attitude (coordinates.ts): right, up, back.
// A rotor object's local +z is its hub +z, the thrust axis.

export interface RotorPose {
  /** Render-space hub position, m. */
  readonly position: readonly [number, number, number];
  /** Render-space orientation, Three.js order (x, y, z, w). */
  readonly quaternion: readonly [number, number, number, number];
}

const BASIS = nedToRenderBasis();

/** A body FRD vector in render coordinates. */
export function frdToRender(vector: readonly number[]): [number, number, number] {
  return [vector[1] ?? 0, -(vector[2] ?? 0), -(vector[0] ?? 0)];
}

/** The pose of a rotor from its manifest fields: hub position and hub-to-body rotation (wxyz). */
export function rotorRenderPose(rotor: { readonly hubPositionBodyM: readonly number[]; readonly hubToBody: readonly number[] }): RotorPose {
  const [w = 1, x = 0, y = 0, z = 0] = rotor.hubToBody;
  const q = BASIS.clone().multiply(new Quaternion(x, y, z, w));
  return { position: frdToRender(rotor.hubPositionBodyM), quaternion: [q.x, q.y, q.z, q.w] };
}

/** Drawing sizes of an aircraft from its layout: the largest hub distance, the drawn disc radius and the overall span, m. */
export interface SchemeDimensions {
  readonly reach: number;
  readonly discRadius: number;
  readonly span: number;
}
export function schemeDimensions(layout: AircraftLayout): SchemeDimensions {
  const reach = Math.max(0.1, ...layout.rotors.map(rotor => Math.hypot(...rotor.hubPositionBodyM)));
  const discRadius = Math.max(0.04, Math.min(0.35 * reach, 0.25));
  return { reach, discRadius, span: reach + discRadius * 2 };
}

/** The mean hub position of each arm, body FRD, in ascending arm order: where the drawn struts end. */
export function armMounts(layout: AircraftLayout): [number, number, number][] {
  const sums = new Map<number, [number, number, number, number]>();
  for (const rotor of layout.rotors) {
    const [x = 0, y = 0, z = 0] = rotor.hubPositionBodyM;
    const sum = sums.get(rotor.armId) ?? [0, 0, 0, 0];
    sums.set(rotor.armId, [sum[0] + x, sum[1] + y, sum[2] + z, sum[3] + 1]);
  }
  return [...sums.entries()].sort((a, b) => a[0] - b[0]).map(([, [x, y, z, n]]) => [x / n, y / n, z / n]);
}
