//! Free shaft with held aerodynamic/drive torques and viscous bearing losses.
/// Invalid parameter/input or numerical overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShaftError;
/// Validated inertia and passive bearing, no prescribed RPM or governor.
#[derive(Clone, Copy, Debug)]
pub struct Shaft {
    inertia: f64,
    damping: f64,
    spin: f64,
}
/// One step's speed, energy and torque residual.
#[derive(Clone, Copy, Debug)]
pub struct ShaftStep {
    /// Nonnegative rotor speed magnitude rad/s.
    pub omega_rad_s: f64,
    /// Spin kinetic energy J.
    pub energy_j: f64,
    /// tau_motor+s*Q_air-b*Omega at the new speed, Nm (air torque held).
    pub residual_nm: f64,
    /// Fixed-spin model hit zero; reversing shaft rotation is outside this model.
    pub reverse_limited: bool,
}
impl Shaft {
    /// Positive shaft inertia kg m², nonnegative bearing Nm/(rad/s), spin +-1.
    pub fn new(inertia: f64, damping: f64, spin: i32) -> Result<Self, ShaftError> {
        if !inertia.is_finite()
            || inertia <= 0.0
            || !damping.is_finite()
            || damping < 0.0
            || ![-1, 1].contains(&spin)
        {
            return Err(ShaftError);
        }
        Ok(Self {
            inertia,
            damping,
            spin: spin as f64,
        })
    }
    /// Exact constant-torque viscous solution. Reevaluate aerodynamic torque each tick.
    pub fn step(
        &self,
        omega: f64,
        q_air_nm: f64,
        motor_nm: f64,
        dt_s: f64,
    ) -> Result<ShaftStep, ShaftError> {
        if ![omega, q_air_nm, motor_nm, dt_s]
            .iter()
            .all(|v| v.is_finite())
            || omega < 0.0
            || motor_nm < 0.0
            || dt_s <= 0.0
            || dt_s > 0.01
        {
            return Err(ShaftError);
        }
        let torque = motor_nm + self.spin * q_air_nm;
        // expm1 avoids cancellation near zero damping and does not divide by damping.
        let x = self.damping * dt_s / self.inertia;
        let phi = if x == 0.0 { 1.0 } else { -(-x).exp_m1() / x };
        let raw = omega + (torque - self.damping * omega) * dt_s / self.inertia * phi;
        let next = raw.max(0.0);
        let energy = 0.5 * self.inertia * next * next;
        let residual = torque - self.damping * next;
        if !raw.is_finite() || !energy.is_finite() || !residual.is_finite() {
            return Err(ShaftError);
        }
        Ok(ShaftStep {
            omega_rad_s: next,
            energy_j: energy,
            residual_nm: residual,
            reverse_limited: raw < 0.0,
        })
    }
}
