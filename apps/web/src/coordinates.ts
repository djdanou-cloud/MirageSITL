import { Matrix4, Quaternion, type Vector3 } from 'three';

/** Right-handed NED -> right-handed render basis: [east, -down, -north]. */
export function nedToRenderBasis(): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().set(
    0, 1, 0, 0,
    0, 0, -1, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1,
  ));
}
/** Writes the render-space position of an NED point (m) into `out`: (east, -down, -north). */
export function nedToRenderPositionInto(northM: number, eastM: number, downM: number, out: Vector3): Vector3 {
  return out.set(eastM, -downM, -northM);
}
