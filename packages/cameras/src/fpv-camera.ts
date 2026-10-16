// Mounted FPV camera (TASK-067), separate from the external chase camera.
//
// Frames: body FRD (x forward, y right, z down); NED world; render basis
// (x east, y up, z -north; apps/web/src/coordinates.ts); three.js camera axes
// (x right, y up, looking along -z). Quaternions are [w, x, y, z], body-to-NED
// as in the ABI; q and -q are the same attitude.
//
//   q_world = B (NED -> render) * q_bn (body -> NED) * q_mount (camera -> body)
//   q_mount = R_y(uptilt) * R_x(roll) * (three-camera axes -> FRD)
//   p_world = B (p_ned + R_bn * mount offset_frd)
//
// update() reads the pose and writes only the owned three.js camera (no
// allocation, no mutation of the pose: truth stays immutable). The camera
// renders the pinhole source; fisheye.ts remaps it to the lens image.
import { MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three";
import type { RenderPoseV2 } from "@mirage/protocol";
import { fisheyeParams, type FisheyeParams, type LensConfig } from "./fisheye.ts";

export interface CameraMount {
  /** Optical centre in body FRD, m. */
  offsetFrdM: readonly [number, number, number];
  /** Uptilt (positive pitches the view up from body forward), rad. */
  uptiltRad: number;
  /** Roll about the optical axis (positive clockwise as seen by the camera), rad. Usually 0. */
  rollRad?: number;
}

export interface CameraConfig {
  lens: LensConfig;
  mount: CameraMount;
  nearM?: number;
  farM?: number;
}

/** three.js camera axes expressed in FRD: camera +x = right (+y_frd), +y = up (-z_frd), +z = back (-x_frd). */
const CAMERA_TO_FRD = new Quaternion().setFromRotationMatrix(new Matrix4().set(
  0, 0, -1, 0,
  1, 0, 0, 0,
  0, -1, 0, 0,
  0, 0, 0, 1,
));
/** NED -> render basis: render = (east, -down, -north). */
const NED_TO_RENDER = new Quaternion().setFromRotationMatrix(new Matrix4().set(
  0, 1, 0, 0,
  0, 0, -1, 0,
  -1, 0, 0, 0,
  0, 0, 0, 1,
));

export class FpvCamera {
  readonly camera: PerspectiveCamera;
  private paramsValue: FisheyeParams;
  private readonly mountQ = new Quaternion();
  private readonly offset = new Vector3();
  private readonly bodyQ = new Quaternion();
  private readonly scratch = new Vector3();
  private readonly config: Readonly<CameraConfig>;

  constructor(config: CameraConfig, widthPx: number, heightPx: number) {
    const [ox, oy, oz] = config.mount.offsetFrdM;
    const roll = config.mount.rollRad ?? 0;
    if (![ox, oy, oz, config.mount.uptiltRad, roll].every(Number.isFinite) || Math.hypot(ox, oy, oz) > 5 ||
      Math.abs(config.mount.uptiltRad) > Math.PI / 2 || Math.abs(roll) > Math.PI) throw new Error("Invalid camera mount");
    const near = config.nearM ?? 0.05, far = config.farM ?? 5000;
    if (!(near > 0 && far > near)) throw new Error("Invalid camera clip planes");
    this.config = Object.freeze({ ...config });
    this.paramsValue = fisheyeParams(config.lens, widthPx, heightPx);
    this.camera = new PerspectiveCamera(this.paramsValue.sourceFovYDeg, this.paramsValue.sourceAspect, near, far);
    this.camera.matrixAutoUpdate = false;
    // Mount: +uptilt about body +y (right) turns +x_frd towards -z_frd (up); then roll about the optical axis (+x_frd).
    const pitch = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), config.mount.uptiltRad);
    const rollQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), roll);
    this.mountQ.copy(pitch).multiply(rollQ).multiply(CAMERA_TO_FRD);
    this.offset.set(ox, oy, oz);
  }

  get params(): FisheyeParams { return this.paramsValue; }

  /** Recomputes lens/source projection for a new output size (setup path, allocates). */
  resize(widthPx: number, heightPx: number): void {
    this.paramsValue = fisheyeParams(this.config.lens, widthPx, heightPx);
    this.camera.fov = this.paramsValue.sourceFovYDeg;
    this.camera.aspect = this.paramsValue.sourceAspect;
    this.camera.updateProjectionMatrix();
  }

  /** Places the camera for `pose` (read-only); allocation-free. */
  update(pose: Readonly<RenderPoseV2>): void {
    const q = this.bodyQ.set(pose.qx, pose.qy, pose.qz, pose.qw); // three order x, y, z, w
    const n = q.length();
    if (!(n > 0) || !Number.isFinite(n)) return; // keep the previous placement on an invalid pose
    q.normalize();
    const c = this.camera;
    // Position: NED body position plus the rotated mount offset, then into render axes.
    const p = this.scratch.copy(this.offset).applyQuaternion(q);
    p.x += pose.northM; p.y += pose.eastM; p.z += pose.downM;
    p.applyQuaternion(NED_TO_RENDER);
    c.position.copy(p);
    c.quaternion.copy(NED_TO_RENDER).multiply(q).multiply(this.mountQ);
    c.updateMatrix();
    c.updateMatrixWorld(true);
  }
}

/** Degrees helper for configuration UIs (degrees only at boundaries). */
export function degToRad(deg: number): number { return MathUtils.degToRad(deg); }
