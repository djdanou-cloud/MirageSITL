import { Matrix4, Quaternion } from 'three';

/** Right-handed NED -> right-handed render basis: [east, -down, -north]. */
export function nedToRenderBasis(): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().set(
    0, 1, 0, 0,
    0, 0, -1, 0,
    -1, 0, 0, 0,
    0, 0, 0, 1,
  ));
}
