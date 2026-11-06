import type { BodyTruth } from "@mirage/wasm-bet/backend";
import type { GroundContact } from "./ground-contact.ts";
/** Collision-ground queries the coupler needs (implemented by @mirage/terrain CollisionChunks). */
export interface GroundLattice {
  /** [nN, nE, nD, offsetM] of the published triangle under [north, east]; NaN when missing. */
  planeInto(position: Float64Array, out: Float64Array): void;
  /** True when every tile intersecting the [north, east, radius] safety square is published. */
  readyFrom(positionRadius: Float64Array): boolean;
}
/** The ground within this distance of the vehicle must be published, m: wider than a Phase 1 aircraft and its supports. */
export const TERRAIN_READY_RADIUS_M = 8;
/**
 * TASK-187: the pose of an aircraft standing on `plane` ([nN, nE, nD, offset], the unit normal pointing out of the ground, nD < 0),
 * from `flat`, its pose on level ground at down 0: its supports square to the slope, the same CG height above the ground measured along
 * the normal, and the heading it had. Without this a start on a slope pushes its uphill supports into the ground. Cold path.
 */
export function standOnPlane(flat: BodyTruth, plane: Float64Array, out: BodyTruth): void {
  const nN = plane[0] as number, nE = plane[1] as number, nD = plane[2] as number, offset = plane[3] as number; // length 4
  const north = flat.positionNedM[0] as number, east = flat.positionNedM[1] as number, height = -(flat.positionNedM[2] as number); // length 3
  out.positionNedM[0] = north; out.positionNedM[1] = east; out.positionNedM[2] = (offset + height - nN * north - nE * east) / nD;
  // The shortest turn of world down (0, 0, 1) onto the slope's down (-n), then the level pose: (w, x, y, z) = (1 - nD, nE, -nN, 0), normalized.
  const raw = Math.hypot(1 - nD, nE, nN), tw = (1 - nD) / raw, tx = nE / raw, ty = -nN / raw;
  const q = flat.quaternionBodyToNed, w = q[0] as number, x = q[1] as number, y = q[2] as number, z = q[3] as number; // length 4
  out.quaternionBodyToNed[0] = tw * w - tx * x - ty * y;
  out.quaternionBodyToNed[1] = tw * x + tx * w + ty * z;
  out.quaternionBodyToNed[2] = tw * y - tx * z + ty * w;
  out.quaternionBodyToNed[3] = tw * z + tx * y - ty * x;
  out.velocityNedMps.set(flat.velocityNedMps);
  out.angularVelocityBodyRadS.set(flat.angularVelocityBodyRadS);
  out.accelerationNedMps2.set(flat.accelerationNedMps2);
}
export const TERRAIN_STEPPED = 0;
/** Ground under the vehicle is not published: the step did not run and state is unchanged. */
export const TERRAIN_PAUSED_MISSING_GROUND = 1;
/** The contact owner rejected the step (invalid input or a faulted session). */
export const TERRAIN_REJECTED = 2;
export type TerrainStepStatus = typeof TERRAIN_STEPPED | typeof TERRAIN_PAUSED_MISSING_GROUND | typeof TERRAIN_REJECTED;
/**
 * TASK-065: drives the single Rapier contact owner from published collision chunks.
 * Before each step it samples the lattice triangle under the airframe CG and under
 * each wheel's fully extended anchor, and passes those planes to contact ABI v2.
 * Missing ground pauses stepping instead of falling through. All storage is
 * allocated here, so stepInto allocates nothing.
 */
export class TerrainContactCoupler {
  private readonly anchors: Float64Array;
  private readonly planes: Float64Array;
  private readonly query = new Float64Array(3);
  private readonly plane = new Float64Array(4);
  private readonly contact: GroundContact;
  private readonly lattice: GroundLattice;
  private readonly readinessRadiusM: number;
  constructor(contact: GroundContact, lattice: GroundLattice, anchorsBodyM: readonly (readonly [number, number, number])[], readinessRadiusM: number) {
    this.contact = contact; this.lattice = lattice; this.readinessRadiusM = readinessRadiusM;
    if (anchorsBodyM.length !== contact.wheelCount) throw new Error("Anchor count must match the contact wheels");
    this.anchors = new Float64Array(anchorsBodyM.length * 3);
    let reach = 0;
    for (let i = 0; i < anchorsBodyM.length; i++) {
      const a = anchorsBodyM[i];
      if (!a || !a.every(Number.isFinite)) throw new Error("Invalid wheel anchor");
      this.anchors.set(a, i * 3);
      reach = Math.max(reach, Math.hypot(a[0], a[1], a[2]));
    }
    // The safety square must cover every sampled contact point at any attitude.
    if (!Number.isFinite(readinessRadiusM) || readinessRadiusM < reach) throw new Error("Readiness radius must cover the wheel anchors");
    this.planes = new Float64Array(4 * (1 + anchorsBodyM.length));
  }
  /** Samples the plane under (north, east) into slot; false when ground is missing. */
  private sample(slot: number, northM: number, eastM: number): boolean {
    this.query[0] = northM; this.query[1] = eastM;
    this.lattice.planeInto(this.query, this.plane);
    if (!Number.isFinite(this.plane[3])) return false;
    for (let k = 0; k < 4; k++) this.planes[4 * slot + k] = this.plane[k] as number; // length 4
    return true;
  }
  /** TASK-100: the published plane under one hub, for its ground effect, or false where the ground is missing. */
  hubPlaneInto(northM: number, eastM: number, out: Float64Array): boolean {
    this.query[0] = northM; this.query[1] = eastM;
    this.lattice.planeInto(this.query, out);
    return Number.isFinite(out[3]);
  }
  /** Advances `state` in place by one contact step on the published terrain. */
  stepInto(state: BodyTruth, wrenchBody: Float64Array, dt: number, brakes?: Float64Array): TerrainStepStatus {
    const p = state.positionNedM, q = state.quaternionBodyToNed;
    const n = p[0] as number, e = p[1] as number; // BodyTruth: length 3/4, checked by the contact owner
    this.query[0] = n; this.query[1] = e; this.query[2] = this.readinessRadiusM;
    if (!this.lattice.readyFrom(this.query) || !this.sample(0, n, e)) return TERRAIN_PAUSED_MISSING_GROUND;
    const w = q[0] as number, x = q[1] as number, y = q[2] as number, z = q[3] as number;
    for (let i = 0; i < this.contact.wheelCount; i++) {
      const ax = this.anchors[3 * i] as number, ay = this.anchors[3 * i + 1] as number, az = this.anchors[3 * i + 2] as number;
      // Horizontal NED offset of R(q) * anchor (Hamilton wxyz, body FRD to NED).
      const dn = (1 - 2 * (y * y + z * z)) * ax + 2 * (x * y - w * z) * ay + 2 * (x * z + w * y) * az;
      const de = 2 * (x * y + w * z) * ax + (1 - 2 * (x * x + z * z)) * ay + 2 * (y * z - w * x) * az;
      if (!this.sample(1 + i, n + dn, e + de)) return TERRAIN_PAUSED_MISSING_GROUND;
    }
    return this.contact.stepInto(wrenchBody, dt, state, brakes, this.planes) ? TERRAIN_STEPPED : TERRAIN_REJECTED;
  }
}
