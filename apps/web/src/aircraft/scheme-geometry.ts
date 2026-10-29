import { Quaternion } from 'three';
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
