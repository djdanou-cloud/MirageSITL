//! Reduced rotor angular momentum and full discrete inertial derivative.
use crate::{flapping::FlapState, Vec3};
/// Invalid momentum data or overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MomentumError;
fn finite(v: Vec3) -> bool {
    v.x.is_finite() && v.y.is_finite() && v.z.is_finite()
}
/// Small-angle blade-distribution momentum: J=sum integral r²dm.
/// Transverse terms include first-harmonic flap velocity; cone reduces axial
/// inertia by cos²(beta0). Valid for modal amplitude sum <=0.2 rad only.
pub fn angular_momentum(
    inertia: f64,
    spin: i32,
    omega: f64,
    flap: FlapState,
) -> Result<Vec3, MomentumError> {
    if !inertia.is_finite()
        || inertia <= 0.0
        || ![-1, 1].contains(&spin)
        || !omega.is_finite()
        || omega < 0.0
        || !finite(flap.angle)
        || !finite(flap.rate)
        || flap.angle.x.abs() + flap.angle.y.abs() + flap.angle.z.abs() > 0.2
    {
        return Err(MomentumError);
    }
    let h = spin as f64 * inertia * omega;
    let out = Vec3::new(
        -h * flap.angle.y + 0.5 * inertia * flap.rate.z,
        -h * flap.angle.z - 0.5 * inertia * flap.rate.y,
        h * flap.angle.x.cos().powi(2),
    );
    if !finite(out) {
        return Err(MomentumError);
    }
    Ok(out)
}
/// M_hub=M_air-(H_next-H_previous)/dt-omega_body cross H_midpoint.
/// Captures speed, cone, cyclic-axis and flap-rate changes in the supplied H.
/// Includes motor reaction already: do not add -s*tau_motor a second time.
pub fn transmitted_moment(
    air: Vec3,
    previous: Vec3,
    next: Vec3,
    body_rate: Vec3,
    dt: f64,
) -> Result<Vec3, MomentumError> {
    if ![air, previous, next, body_rate].iter().all(|v| finite(*v))
        || !dt.is_finite()
        || dt <= 0.0
        || dt > 0.01
    {
        return Err(MomentumError);
    }
    let derivative = next
        .add(previous.scale(-1.0))
        .scale(1.0 / dt)
        .add(body_rate.cross(next.add(previous).scale(0.5)));
    let out = air.add(derivative.scale(-1.0));
    if !finite(out) {
        return Err(MomentumError);
    }
    Ok(out)
}
