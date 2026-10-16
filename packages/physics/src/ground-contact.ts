import RAPIER from "./contact-engine.ts";
import type { BodyTruth } from "@mirage/wasm-bet/backend";
import type { ContactBackend, ContactImpulse } from "./contact-backend";
/** Rapier sphere-on-plane reference. No parallel native RK4 integration.
 * Uses reusable JS targets and raw vectors. Native allocator certification remains open.
 */
export class GroundContact implements ContactBackend {
  readonly integrationOwner = "rapier" as const;
  readonly highRateCertified = false;
  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly force = new RAPIER.Vector3(0.1, 0.1, 0.1);
  private readonly torque = new RAPIER.Vector3(0.1, 0.1, 0.1);
  private readonly rotation = new RAPIER.Quaternion(0.1, 0.1, 0.1, 0.1);
  private readonly previousVelocity = new RAPIER.Vector3(0.1, 0.1, 0.1);
  private readonly position = new RAPIER.Vector3(0.1, 0.1, 0.1);
  private readonly velocity = new RAPIER.Vector3(0.1, 0.1, 0.1);
  private readonly angularVelocity = new RAPIER.Vector3(0.1, 0.1, 0.1);
  private readonly rawForce: ReturnType<typeof RAPIER.VectorOps.intoRaw>;
  private readonly rawTorque: ReturnType<typeof RAPIER.VectorOps.intoRaw>;
  private readonly rawGravity: ReturnType<typeof RAPIER.VectorOps.intoRaw>;
  private disposed = false;
  private readonly impulse = new Float64Array(3);
  private lastDt = 0;
  private readonly lastQ = new Float64Array([1, 0, 0, 0]);
  private readonly mass: number;
  private readonly radius: number;
  // Plain fields instead of parameter properties keep this module loadable by
  // Node type stripping (scripts/validate-models.mjs runs the NASA drop case).
  private constructor(
    state: BodyTruth,
    mass: number,
    radius: number,
    restitution: number,
    friction: number,
  ) {
    this.mass = mass;
    this.radius = radius;
    this.world = new RAPIER.World({ x: 0, y: 0, z: 9.80665 });
    this.world.numSolverIterations = 8;
    this.world.physicsPipeline.raw.set_profiler_enabled(false);
    this.rawForce = RAPIER.VectorOps.intoRaw(this.force);
    this.rawTorque = RAPIER.VectorOps.intoRaw(this.torque);
    this.rawGravity = RAPIER.VectorOps.intoRaw(this.world.gravity);
    const ground = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0.5),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(10000, 10000, 0.5)
        .setFriction(friction)
        .setRestitution(restitution),
      ground,
    );
    const q = state.quaternionBodyToNed;
    this.body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(
          state.positionNedM[0]!,
          state.positionNedM[1]!,
          state.positionNedM[2]!,
        )
        .setRotation({ w: q[0]!, x: q[1]!, y: q[2]!, z: q[3]! })
        .setLinvel(
          state.velocityNedMps[0]!,
          state.velocityNedMps[1]!,
          state.velocityNedMps[2]!,
        ),
    );
    const omega = state.angularVelocityBodyRadS;
    this.rotateWrench(
      omega,
      0,
      { w: q[0]!, x: q[1]!, y: q[2]!, z: q[3]! },
      this.torque,
    );
    this.body.setAngvel(this.torque, false);
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(radius)
        .setMass(mass)
        .setFriction(friction)
        .setRestitution(restitution),
      this.body,
    );
  }
  static async create(
    state: BodyTruth,
    mass = 1,
    radius = 0.1,
    restitution = 0,
    friction = 0.7,
  ): Promise<GroundContact> {
    if (
      ![mass, radius, restitution, friction].every(Number.isFinite) ||
      mass <= 0 ||
      radius <= 0 ||
      restitution < 0 ||
      restitution > 1 ||
      friction < 0 ||
      state.positionNedM.length !== 3 ||
      state.velocityNedMps.length !== 3 ||
      state.quaternionBodyToNed.length !== 4 ||
      state.angularVelocityBodyRadS.length !== 3 ||
      ![
        ...state.positionNedM,
        ...state.velocityNedMps,
        ...state.quaternionBodyToNed,
        ...state.angularVelocityBodyRadS,
      ].every(Number.isFinite) ||
      Math.abs(Math.hypot(...state.quaternionBodyToNed) - 1) > 1e-6
    )
      throw new Error("Invalid contact configuration");
    await RAPIER.init();
    return new GroundContact(state, mass, radius, restitution, friction);
  }
  private rotateWrench(
    w: Float64Array,
    offset: number,
    q: { w: number; x: number; y: number; z: number },
    target: { x: number; y: number; z: number },
  ): void {
    const x = w[offset]!,
      y = w[offset + 1]!,
      z = w[offset + 2]!,
      tx = 2 * (q.y * z - q.z * y),
      ty = 2 * (q.z * x - q.x * z),
      tz = 2 * (q.x * y - q.y * x);
    target.x = x + q.w * tx + q.y * tz - q.z * ty;
    target.y = y + q.w * ty + q.z * tx - q.x * tz;
    target.z = z + q.w * tz + q.x * ty - q.y * tx;
  }
  stepInto(w: Float64Array, dt: number, out: BodyTruth): boolean {
    if (
      this.disposed ||
      out.positionNedM.length !== 3 ||
      out.velocityNedMps.length !== 3 ||
      out.quaternionBodyToNed.length !== 4 ||
      out.angularVelocityBodyRadS.length !== 3 ||
      out.accelerationNedMps2.length !== 3 ||
      w.length !== 6 ||
      (dt !== 1 / 400 && dt !== 1 / 800 && dt !== 1 / 1200)
    )
      return false;
    for (let i = 0; i < 6; i++) if (!Number.isFinite(w[i])) return false;
    const q = this.body.rotation(this.rotation),
      before = this.body.linvel(this.previousVelocity);
    this.rotateWrench(w, 0, q, this.force);
    this.rotateWrench(w, 3, q, this.torque);
    this.body.resetForces(false);
    this.body.resetTorques(false);
    this.rawForce.x = this.force.x;
    this.rawForce.y = this.force.y;
    this.rawForce.z = this.force.z;
    this.rawTorque.x = this.torque.x;
    this.rawTorque.y = this.torque.y;
    this.rawTorque.z = this.torque.z;
    this.world.bodies.raw.rbAddForce(this.body.handle, this.rawForce, true);
    this.world.bodies.raw.rbAddTorque(this.body.handle, this.rawTorque, true);
    this.world.timestep = dt;
    // Fixed rigid-body topology: no soft bodies, tearing, hooks or dynamic mapping.
    // The raw pipeline avoids World.step's per-step gravity wrapper allocation.
    const world = this.world;
    world.physicsPipeline.raw.step(
      this.rawGravity,
      world.integrationParameters.raw,
      world.islands.raw,
      world.broadPhase.raw,
      world.narrowPhase.raw,
      world.bodies.raw,
      world.colliders.raw,
      world.softBodies.raw,
      world.impulseJoints.raw,
      world.multibodyJoints.raw,
      world.ccdSolver.raw,
    );
    const p = this.body.translation(this.position),
      v = this.body.linvel(this.velocity),
      r = this.body.rotation(this.rotation),
      omega = this.body.angvel(this.angularVelocity);
    this.impulse[0] = this.mass * (v.x - before.x) - this.force.x * dt;
    this.impulse[1] = this.mass * (v.y - before.y) - this.force.y * dt;
    this.impulse[2] =
      this.mass * (v.z - before.z) - (this.force.z + this.mass * 9.80665) * dt;
    this.lastDt = dt;
    out.positionNedM[0] = p.x;
    out.positionNedM[1] = p.y;
    out.positionNedM[2] = p.z;
    out.velocityNedMps[0] = v.x;
    out.velocityNedMps[1] = v.y;
    out.velocityNedMps[2] = v.z;
    out.quaternionBodyToNed[0] = r.w;
    out.quaternionBodyToNed[1] = r.x;
    out.quaternionBodyToNed[2] = r.y;
    out.quaternionBodyToNed[3] = r.z;
    // Rapier angular velocity is in world axes; convert to body FRD.
    const tx = 2 * (-r.y * omega.z + r.z * omega.y),
      ty = 2 * (-r.z * omega.x + r.x * omega.z),
      tz = 2 * (-r.x * omega.y + r.y * omega.x);
    out.angularVelocityBodyRadS[0] = omega.x + r.w * tx - r.y * tz + r.z * ty;
    out.angularVelocityBodyRadS[1] = omega.y + r.w * ty - r.z * tx + r.x * tz;
    out.angularVelocityBodyRadS[2] = omega.z + r.w * tz - r.x * ty + r.y * tx;
    this.lastQ[0] = r.w;
    this.lastQ[1] = r.x;
    this.lastQ[2] = r.y;
    this.lastQ[3] = r.z;
    out.accelerationNedMps2[0] = (v.x - before.x) / dt;
    out.accelerationNedMps2[1] = (v.y - before.y) / dt;
    out.accelerationNedMps2[2] = (v.z - before.z) / dt;
    return true;
  }
  impulseInto(out: ContactImpulse): void {
    out.impulseNed.set(this.impulse);
    out.dt = this.lastDt;
    const q = this.lastQ,
      x = -q[1]!,
      y = -q[2]!,
      z = -q[3]!,
      w = q[0]!,
      tx = 2 * y * this.radius,
      ty = -2 * x * this.radius;
    out.pointBody[0] = w * tx - z * ty;
    out.pointBody[1] = w * ty + z * tx;
    out.pointBody[2] = this.radius + x * ty - y * tx;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rawForce.free();
    this.rawTorque.free();
    this.rawGravity.free();
    this.world.free();
  }
}
