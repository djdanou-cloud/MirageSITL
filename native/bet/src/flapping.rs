//! Linear zero-offset rigid-blade hinge, Galerkin modes 1/cos(psi)/sin(psi).
//! Material derivative is D=d/dt+s*Omega*d/dpsi. Includes centrifugal restoring,
//! Coriolis, spin acceleration and viscous modal terms; small-angle model only.
use crate::Vec3;
/// Invalid hinge/input, excessive step frequency or numerical overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlapError;
/// Cone/cos/sin modal angles and hub-frame time derivatives.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlapState {
    /// (beta0,betaCos,betaSin) radians.
    pub angle: Vec3,
    /// Time derivatives rad/s (excluding convective rotor rotation).
    pub rate: Vec3,
}
/// One reduced-model step and its small-angle validity.
#[derive(Clone, Copy, Debug)]
pub struct FlapStep {
    /// Updated angles and rates.
    pub state: FlapState,
    /// Sum of modal amplitudes exceeds declared small-angle bound.
    pub outside_validity: bool,
}
/// Summed blade hinge inertia/stiffness/damping. Harmonic modal values are half
/// the collective values by orthogonality; no free undocumented scale factors.
#[derive(Clone, Copy, Debug)]
pub struct HingeModel {
    inertia: f64,
    stiffness: f64,
    damping: f64,
    spin: f64,
    limit: f64,
}
impl HingeModel {
    /// I0 kg m², K0 Nm/rad, C0 Nm/(rad/s), spin +-1; small-angle limit <=0.2 rad.
    pub fn new(
        inertia: f64,
        stiffness: f64,
        damping: f64,
        spin: i32,
        angle_limit: f64,
    ) -> Result<Self, FlapError> {
        if ![inertia, stiffness, damping, angle_limit]
            .iter()
            .all(|x| x.is_finite())
            || inertia <= 0.0
            || stiffness < 0.0
            || damping < 0.0
            || ![-1, 1].contains(&spin)
            || angle_limit <= 0.0
            || angle_limit > 0.2
        {
            return Err(FlapError);
        }
        Ok(Self {
            inertia,
            stiffness,
            damping,
            spin: spin as f64,
            limit: angle_limit,
        })
    }
    fn derivative(&self, y: [f64; 6], q: Vec3, w: f64, wd: f64) -> [f64; 6] {
        let k = self.stiffness / self.inertia;
        let d = self.damping / self.inertia;
        [
            y[3],
            y[4],
            y[5],
            q.x / self.inertia - d * y[3] - (k + w * w) * y[0],
            2.0 * q.y / self.inertia - d * y[4] - k * y[1] - 2.0 * w * y[5] - (d * w + wd) * y[2],
            2.0 * q.z / self.inertia - d * y[5] - k * y[2] + 2.0 * w * y[4] + (d * w + wd) * y[1],
        ]
    }
    /// RK4, frozen generalized aerodynamic loads. Does not tilt a render mesh.
    /// Frequency envelope dt*(|Omega|+sqrt(K/I)+C/I)<=1, dt <=0.01 s.
    pub fn step(
        &self,
        state: FlapState,
        load_nm: Vec3,
        omega: f64,
        omega_dot: f64,
        dt: f64,
    ) -> Result<FlapStep, FlapError> {
        let y = [
            state.angle.x,
            state.angle.y,
            state.angle.z,
            state.rate.x,
            state.rate.y,
            state.rate.z,
        ];
        if !y
            .iter()
            .chain([load_nm.x, load_nm.y, load_nm.z, omega, omega_dot, dt].iter())
            .all(|v| v.is_finite())
            || omega < 0.0
            || dt <= 0.0
            || dt > 0.01
            || omega + omega_dot * dt < 0.0
            || dt
                * (omega.max(omega + omega_dot * dt)
                    + (self.stiffness / self.inertia).sqrt()
                    + self.damping / self.inertia)
                > 1.0
        {
            return Err(FlapError);
        }
        let w = self.spin * omega;
        let wd = self.spin * omega_dot;
        let k1 = self.derivative(y, load_nm, w, wd);
        let k2 = self.derivative(add(y, k1, 0.5 * dt), load_nm, w + 0.5 * dt * wd, wd);
        let k3 = self.derivative(add(y, k2, 0.5 * dt), load_nm, w + 0.5 * dt * wd, wd);
        let k4 = self.derivative(add(y, k3, dt), load_nm, w + dt * wd, wd);
        let mut next = y;
        for j in 0..6 {
            next[j] += dt * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]) / 6.0;
        }
        if !next.iter().all(|x| x.is_finite()) {
            return Err(FlapError);
        }
        Ok(FlapStep {
            state: FlapState {
                angle: Vec3::new(next[0], next[1], next[2]),
                rate: Vec3::new(next[3], next[4], next[5]),
            },
            outside_validity: next[0].abs() + next[1].abs() + next[2].abs() > self.limit,
        })
    }
}
fn add(mut y: [f64; 6], dy: [f64; 6], dt: f64) -> [f64; 6] {
    for j in 0..6 {
        y[j] += dt * dy[j];
    }
    y
}
