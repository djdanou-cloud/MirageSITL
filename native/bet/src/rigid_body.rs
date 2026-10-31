//! RK4 rigid-body equations: body FRD wrench, NED gravity, wxyz orientation.
use crate::{
    frame::Wrench,
    math::{finite, inverse_spd, multiply, normalize, rotate},
    Vec3,
};
/// Nonphysical parameters, invalid state/step or overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BodyError;
/// Validated mass and body inertia; rotor spin/flap inertia must not be duplicated.
#[derive(Clone, Copy, Debug)]
pub struct BodyParameters {
    mass: f64,
    inertia: [f64; 9],
    inverse: [f64; 9],
}
/// SI truth state; quaternion rotates body FRD into NED.
#[derive(Clone, Copy, Debug)]
pub struct BodyState {
    /// NED position m.
    pub position: Vec3,
    /// NED velocity m/s.
    pub velocity: Vec3,
    /// Body-to-NED wxyz quaternion.
    pub quaternion: [f64; 4],
    /// Body p/q/r rad/s.
    pub omega: Vec3,
}
/// Integrated state and inertial acceleration (including gravity).
#[derive(Clone, Copy, Debug)]
pub struct BodyOutput {
    /// Updated state.
    pub state: BodyState,
    /// Final NED acceleration m/s².
    pub acceleration: Vec3,
}
impl BodyParameters {
    /// Positive finite mass kg and symmetric positive-definite inertia kg m².
    pub fn new(mass: f64, inertia: [f64; 9]) -> Result<Self, BodyError> {
        if !mass.is_finite() || mass <= 0.0 {
            return Err(BodyError);
        }
        Ok(Self {
            mass,
            inertia,
            inverse: inverse_spd(inertia).ok_or(BodyError)?,
        })
    }
    /// Euler's equations about the CG in body axes: I⁻¹(M − ω × I·ω) (TASK-094).
    pub fn angular_acceleration(&self, omega: Vec3, moment: Vec3) -> Vec3 {
        multiply(self.inverse, moment.add(omega.cross(multiply(self.inertia, omega)).scale(-1.0)))
    }
    fn derivative(&self, y: [f64; 13], load: Wrench, g: f64) -> Result<[f64; 13], BodyError> {
        let q = normalize([y[6], y[7], y[8], y[9]]).ok_or(BodyError)?;
        let w = Vec3::new(y[10], y[11], y[12]);
        let a = rotate(q, load.force)
            .scale(1.0 / self.mass)
            .add(Vec3::new(0.0, 0.0, g));
        let wd = multiply(
            self.inverse,
            load.moment
                .add(w.cross(multiply(self.inertia, w)).scale(-1.0)),
        );
        Ok([
            y[3],
            y[4],
            y[5],
            a.x,
            a.y,
            a.z,
            -0.5 * (y[7] * w.x + y[8] * w.y + y[9] * w.z),
            0.5 * (y[6] * w.x + y[8] * w.z - y[9] * w.y),
            0.5 * (y[6] * w.y + y[9] * w.x - y[7] * w.z),
            0.5 * (y[6] * w.z + y[7] * w.y - y[8] * w.x),
            wd.x,
            wd.y,
            wd.z,
        ])
    }
    /// Fixed dt <=0.01 s; wrench held in body axes. No contacts or second integrator.
    pub fn step(
        &self,
        state: BodyState,
        load: Wrench,
        gravity_mps2: f64,
        dt: f64,
    ) -> Result<BodyOutput, BodyError> {
        if !finite(state.position)
            || !finite(state.velocity)
            || !finite(state.omega)
            || !finite(load.force)
            || !finite(load.moment)
            || !gravity_mps2.is_finite()
            || gravity_mps2 < 0.0
            || !dt.is_finite()
            || dt <= 0.0
            || dt > 0.01
        {
            return Err(BodyError);
        }
        let q = normalize(state.quaternion).ok_or(BodyError)?;
        let norm = state.quaternion.iter().map(|v| v * v).sum::<f64>().sqrt();
        if (norm - 1.0).abs() > 1e-6 || state.omega.norm() * dt > 1.0 {
            return Err(BodyError);
        }
        let y = [
            state.position.x,
            state.position.y,
            state.position.z,
            state.velocity.x,
            state.velocity.y,
            state.velocity.z,
            q[0],
            q[1],
            q[2],
            q[3],
            state.omega.x,
            state.omega.y,
            state.omega.z,
        ];
        let k1 = self.derivative(y, load, gravity_mps2)?;
        let k2 = self.derivative(add(y, k1, dt / 2.0), load, gravity_mps2)?;
        let k3 = self.derivative(add(y, k2, dt / 2.0), load, gravity_mps2)?;
        let k4 = self.derivative(add(y, k3, dt), load, gravity_mps2)?;
        let mut next = y;
        for i in 0..13 {
            next[i] += dt * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]) / 6.0;
        }
        if !next.iter().all(|v| v.is_finite()) {
            return Err(BodyError);
        }
        let quaternion = normalize([next[6], next[7], next[8], next[9]]).ok_or(BodyError)?;
        let acceleration = rotate(quaternion, load.force)
            .scale(1.0 / self.mass)
            .add(Vec3::new(0.0, 0.0, gravity_mps2));
        if !finite(acceleration) {
            return Err(BodyError);
        }
        Ok(BodyOutput {
            state: BodyState {
                position: Vec3::new(next[0], next[1], next[2]),
                velocity: Vec3::new(next[3], next[4], next[5]),
                quaternion,
                omega: Vec3::new(next[10], next[11], next[12]),
            },
            acceleration,
        })
    }
}
fn add(mut y: [f64; 13], dy: [f64; 13], dt: f64) -> [f64; 13] {
    for i in 0..13 {
        y[i] += dt * dy[i];
    }
    y
}
