//! Fixed-topology f64 Rapier contact owner. All storage is prepared before arming.
use mirage_bet::landing_gear::{Damping, DampingLaw, GasStrut, LinearStrut, TireCurve};
use rapier3d_f64::{na::Unit, prelude::*};

pub const MAX_WHEELS: usize = 8;
pub const CONFIG_COUNT: usize = 32 + MAX_WHEELS * 160;
pub const INPUT_COUNT: usize = 16;
pub const OUTPUT_COUNT: usize = 32 + MAX_WHEELS * 8;

#[derive(Clone, Copy)]
enum Strut {
    Linear(LinearStrut),
    Gas(GasStrut),
}
#[derive(Clone, Copy)]
struct Wheel {
    handle: RigidBodyHandle,
    anchor: Vector,
    travel: f64,
    radius: f64,
    rolling: f64,
    lateral: f64,
    braking: f64,
    damping: f64,
    count: usize,
    x: [f64; 64],
    f: [f64; 64],
    strut: Strut,
}
pub struct Contact {
    world: PhysicsWorld,
    body: RigidBodyHandle,
    wheels: Vec<Wheel>,
    mass: f64,
    inertia: Vector,
    radius: f64,
    normal: Vector,
    offset: f64,
}
fn vec(s: &[f64], i: usize) -> Vector {
    Vector::new(s[i], s[i + 1], s[i + 2])
}
fn finite(v: Vector) -> bool {
    v.x.is_finite() && v.y.is_finite() && v.z.is_finite()
}
fn valid_state(c: &[f64; CONFIG_COUNT]) -> bool {
    c.iter().all(|x| x.is_finite())
        && c[0] == 1.0
        && c[1] == 0.0
        && c[2] > 0.0
        && c[3] > 0.0
        && (0.0..=1.0).contains(&c[4])
        && c[5] >= 0.0
        && (c[12] * c[12] + c[13] * c[13] + c[14] * c[14] + c[15] * c[15] - 1.0).abs() < 1e-10
        && c[19] > 0.0
        && c[20] > 0.0
        && c[21] > 0.0
        && (vec(c, 22).length_squared() - 1.0).abs() < 1e-10
        && c[26] >= 0.0
        && c[27] >= 0.0
        && c[27] <= MAX_WHEELS as f64
        && c[27].fract() == 0.0
        && c[28..32].iter().all(|x| *x == 0.0)
}
impl Contact {
    pub fn new(c: &[f64; CONFIG_COUNT]) -> Result<Self, i32> {
        if !valid_state(c) {
            return Err(-2);
        }
        let mut world = PhysicsWorld::new();
        world.gravity = Vector::new(0.0, 0.0, c[26]);
        world.integration_parameters.dt = 1.0 / 400.0;
        world.integration_parameters.num_solver_iterations = 8;
        let normal = vec(c, 22);
        let groups_ground =
            InteractionGroups::new(Group::GROUP_1, Group::GROUP_2, InteractionTestMode::And);
        let groups_moving =
            InteractionGroups::new(Group::GROUP_2, Group::GROUP_1, InteractionTestMode::And);
        world.insert(
            RigidBodyBuilder::fixed().translation(normal * c[25]),
            ColliderBuilder::halfspace(Unit::new_unchecked(normal))
                .friction(c[5])
                .restitution(c[4])
                .collision_groups(groups_ground),
        );
        let inertia = vec(c, 19);
        let (body, _) = world.insert(
            RigidBodyBuilder::dynamic()
                .can_sleep(false)
                .additional_mass_properties(MassProperties::new(Vector::ZERO, c[2], inertia)),
            ColliderBuilder::ball(c[3])
                .density(0.0)
                .friction(c[5])
                .restitution(c[4])
                .collision_groups(groups_moving),
        );
        let q = Rotation::from_xyzw(c[13], c[14], c[15], c[12]);
        world.bodies[body].set_rotation(q, true);
        world.bodies[body].set_translation(vec(c, 6), true);
        world.bodies[body].set_linvel(vec(c, 9), true);
        world.bodies[body].set_angvel(q * vec(c, 16), true);
        let mut wheels = Vec::with_capacity(MAX_WHEELS);
        for i in 0..c[27] as usize {
            let w = &c[32 + i * 160..32 + (i + 1) * 160];
            if w[3] <= 0.0
                || w[4] <= 0.0
                || w[5] <= 0.0
                || w[5] >= w[4]
                || w[6] <= 0.0
                || ![0.0, 1.0].contains(&w[7])
                || ![0.0, 1.0].contains(&w[12])
                || w[13] < 0.0
                || w[14] < 0.0
                || w[15] < 0.0
                || w[16] < 0.0
                || w[17] < 2.0
                || w[17] > 64.0
                || w[17].fract() != 0.0
                || w[28..32].iter().any(|v| *v != 0.0)
            {
                return Err(-2);
            }
            let count = w[17] as usize;
            let mut xs = [0.0; 64];
            let mut fs = [0.0; 64];
            xs[..count].copy_from_slice(&w[32..32 + count]);
            fs[..count].copy_from_slice(&w[96..96 + count]);
            TireCurve::new(&xs[..count], &fs[..count], w[16]).map_err(|_| -2)?;
            // The rigid rim is the physical tire bottom-out constraint.
            if xs[count - 1] + 1e-12 < w[4] - w[5] {
                return Err(-2);
            }
            let strut = if w[7] == 0.0 {
                let d = Damping::new(
                    w[10],
                    w[11],
                    if w[12] == 0.0 {
                        DampingLaw::Linear
                    } else {
                        DampingLaw::Square
                    },
                )
                .map_err(|_| -2)?;
                Strut::Linear(LinearStrut::new(w[8], w[9], w[6], d).map_err(|_| -2)?)
            } else {
                Strut::Gas(
                    GasStrut::new(
                        w[18], w[19], w[20], w[21], w[22], w[6], w[23], w[24], w[25], w[26], w[27],
                    )
                    .map_err(|_| -2)?,
                )
            };
            let anchor = vec(w, 0);
            let (handle, _) = world.insert(
                RigidBodyBuilder::dynamic()
                    .can_sleep(false)
                    .translation(vec(c, 6) + q * anchor)
                    .linvel(vec(c, 9) + (q * vec(c, 16)).cross(q * anchor)),
                ColliderBuilder::ball(w[5])
                    .mass(w[3])
                    .friction(0.0)
                    .restitution(0.0)
                    .collision_groups(groups_moving),
            );
            world.bodies[handle].set_rotation(q, true);
            world.bodies[handle].set_angvel(q * vec(c, 16), true);
            world.impulse_joints.insert(
                body,
                handle,
                PrismaticJointBuilder::new(Vector::Z)
                    .local_anchor1(anchor)
                    .local_anchor2(Vector::ZERO)
                    .limits([-w[6], 0.0])
                    .contacts_enabled(false),
                true,
            );
            wheels.push(Wheel {
                handle,
                anchor,
                travel: w[6],
                radius: w[4],
                rolling: w[13],
                lateral: w[14],
                braking: w[15],
                damping: w[16],
                count,
                x: xs,
                f: fs,
                strut,
            });
        }
        let mut result = Self {
            world,
            body,
            wheels,
            mass: c[2],
            inertia,
            radius: c[3],
            normal,
            offset: c[25],
        };
        result.warm(c);
        let mut input = [0.0; INPUT_COUNT];
        for hz in [400, 800, 1200] {
            input[14] = 1.0 / hz as f64;
            for i in 0..hz * 8 {
                input[2] = if i % (2 * hz) < hz / 4 {
                    -(c[2]
                        + result
                            .wheels
                            .iter()
                            .map(|w| result.world.bodies[w.handle].mass())
                            .sum::<f64>())
                        * 19.6133
                } else {
                    0.0
                };
                result.step(&input)?;
            }
            result.restore(c);
        }
        result.restore(c);
        Ok(result)
    }
    fn restore(&mut self, c: &[f64; CONFIG_COUNT]) {
        let q = Rotation::from_xyzw(c[13], c[14], c[15], c[12]);
        let p = vec(c, 6);
        let v = vec(c, 9);
        let omega = q * vec(c, 16);
        let b = &mut self.world.bodies[self.body];
        b.set_rotation(q, true);
        b.set_translation(p, true);
        b.set_linvel(v, true);
        b.set_angvel(omega, true);
        b.reset_forces(false);
        b.reset_torques(false);
        for w in &self.wheels {
            let b = &mut self.world.bodies[w.handle];
            b.set_rotation(q, true);
            b.set_translation(p + q * w.anchor, true);
            b.set_linvel(v + omega.cross(q * w.anchor), true);
            b.set_angvel(omega, true);
            b.reset_forces(false);
            b.reset_torques(false);
        }
    }
    fn warm(&mut self, c: &[f64; CONFIG_COUNT]) {
        // Cold topology warmup visits contact creation/removal with all colliders.
        let mut warm = *c;
        for i in 0..4096 {
            if i % 256 == 0 {
                let p = self.normal * (self.offset + if i % 512 == 0 { -2.0 } else { 2.0 });
                warm[6] = p.x;
                warm[7] = p.y;
                warm[8] = p.z;
                warm[9] = 0.0;
                warm[10] = 0.0;
                warm[11] = 0.0;
                self.restore(&warm);
            }
            self.world.step();
        }
        self.restore(c);
    }
    fn angular_momentum(&self) -> Vector {
        let b = &self.world.bodies[self.body];
        let q = *b.rotation();
        q * (self.inertia * (q.inverse() * b.angvel()))
    }
    pub fn step(&mut self, input: &[f64; INPUT_COUNT]) -> Result<[f64; OUTPUT_COUNT], i32> {
        let dt = input[14];
        if input.iter().any(|x| !x.is_finite())
            || ![1.0 / 400.0, 1.0 / 800.0, 1.0 / 1200.0].contains(&dt)
            || input[6..14].iter().any(|b| *b < 0.0 || *b > 1.0)
            || input[15] != 0.0
        {
            return Err(-2);
        }
        let b = &self.world.bodies[self.body];
        let q = *b.rotation();
        let before = b.linvel();
        let p = b.translation();
        let omega = b.angvel();
        let h_before = self.angular_momentum();
        let force = q * vec(input, 0);
        let torque = q * vec(input, 3);
        let axis = q * Vector::Z;
        let mut wheel_force = [Vector::ZERO; MAX_WHEELS];
        let mut strut_force = [Vector::ZERO; MAX_WHEELS];
        let mut points = [Vector::ZERO; MAX_WHEELS];
        let mut out = [0.0; OUTPUT_COUNT];
        for (i, w) in self.wheels.iter().enumerate() {
            let wb = &self.world.bodies[w.handle];
            let anchor = p + q * w.anchor;
            let wp = wb.translation();
            let wv = wb.linvel();
            let raw_x = -(wp - anchor).dot(axis);
            let x = raw_x.clamp(0.0, w.travel);
            let rate = (before + omega.cross(q * w.anchor) - wv).dot(axis);
            let support = match w.strut {
                Strut::Linear(m) => m.evaluate(x, rate),
                Strut::Gas(m) => m.evaluate(x, rate),
            }
            .map_err(|_| -3)?
            .load_n;
            let deflection = (w.radius - (self.normal.dot(wp) - self.offset)).max(0.0);
            // Tiny rim solver overlap is handled by the rigid rim reaction, not
            // relabeled as additional tire or suspension travel.
            let tire_x = deflection.min(w.x[w.count - 1]);
            let curve =
                TireCurve::new(&w.x[..w.count], &w.f[..w.count], w.damping).map_err(|_| -3)?;
            let normal = curve
                .evaluate(tire_x, -wv.dot(self.normal))
                .map_err(|_| -3)?
                .load_n;
            let tangent = wv - self.normal * wv.dot(self.normal);
            let forward = q * Vector::X;
            let projected = forward - self.normal * forward.dot(self.normal);
            let heading = if projected.length_squared() > 1e-12 {
                projected.normalize()
            } else {
                Vector::ZERO
            };
            let longitudinal = heading * tangent.dot(heading);
            let lateral = tangent - longitudinal;
            // Kinematic rolling approximation: no wheel-spin/anti-skid model.
            let mu = w.rolling + (w.braking - w.rolling) * input[6 + i];
            let resistance = longitudinal * (mu / longitudinal.length().max(0.1))
                + lateral * (w.lateral / lateral.length().max(0.1));
            // Combined tangential force is bounded by the larger configured mu.
            let magnitude = resistance.length();
            let limit = mu.max(w.lateral);
            let friction = if magnitude > limit && magnitude > 0.0 {
                resistance * (limit / magnitude)
            } else {
                resistance
            };
            wheel_force[i] = (self.normal - friction) * normal;
            strut_force[i] = axis * support;
            points[i] = anchor;
            if !finite(wheel_force[i]) || !finite(strut_force[i]) {
                return Err(-3);
            }
            let start = 32 + i * 8;
            out[start] = x;
            out[start + 1] = tire_x;
            out[start + 2] = normal;
            out[start + 3] = support;
            out[start + 4] = deflection - tire_x;
            out[start + 5] = raw_x;
            out[start + 6] = self.normal.dot(wp) - self.offset;
        }
        let b = &mut self.world.bodies[self.body];
        b.reset_forces(false);
        b.reset_torques(false);
        b.add_force(force, true);
        b.add_torque(torque, true);
        for (i, w) in self.wheels.iter().enumerate() {
            self.world.bodies[self.body].add_force_at_point(-strut_force[i], points[i], true);
            let wb = &mut self.world.bodies[w.handle];
            wb.reset_forces(false);
            wb.reset_torques(false);
            wb.add_force(strut_force[i] + wheel_force[i], true);
        }
        self.world.integration_parameters.dt = dt;
        self.world.step();
        let b = &self.world.bodies[self.body];
        let pos = b.translation();
        let v = b.linvel();
        let r = *b.rotation();
        let gyro = r.inverse() * b.angvel();
        let accel = (v - before) / dt;
        let impulse = (v - before) * self.mass - (force + self.world.gravity * self.mass) * dt;
        let moment = r.inverse() * (self.angular_momentum() - h_before - torque * dt);
        let qp = r.to_array();
        let values = [
            pos.x, pos.y, pos.z, v.x, v.y, v.z, qp[3], qp[0], qp[1], qp[2], gyro.x, gyro.y, gyro.z,
            accel.x, accel.y, accel.z, impulse.x, impulse.y, impulse.z, moment.x, moment.y,
            moment.z,
        ];
        out[..values.len()].copy_from_slice(&values);
        let point = r.inverse() * (-self.normal * self.radius);
        out[22] = point.x;
        out[23] = point.y;
        out[24] = point.z;
        out[25] = self.wheels.len() as f64;
        if out.iter().any(|x| !x.is_finite()) {
            return Err(-3);
        }
        Ok(out)
    }
}
