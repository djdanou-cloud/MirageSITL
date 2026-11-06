//! Rotor ground effect (TASK-100): the induced velocity near a plane, from the image of the rotor in it.
/// Below this height over radius the closed form is outside its envelope; it holds its value here.
pub const MIN_HEIGHT_OVER_RADIUS: f64 = 0.5;

/// The factor on a rotor's induced velocity, and whether the rotor is below the envelope.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GroundEffect {
    /// kappa: the induced velocity's multiplier, at most 1.
    pub factor: f64,
    /// The height over radius is below `MIN_HEIGHT_OVER_RADIUS`.
    pub below_envelope: bool,
}

/// `kappa = 1 - (R/(4 z))^2 cos(theta) / (1 + (V_t/v_i)^2)` (Cheeseman and Bennett, with the transverse term and the
/// projection of the image's induced velocity on the hub axis), with z the height along the hub axis, `d / cos(theta)`.
/// `height_m` is d, along the plane's normal, and `cos_tilt` the hub axis on that normal. A disk that does not face
/// the plane gets no effect. Allocation-free.
#[inline]
pub fn induced_factor(radius_m: f64, height_m: f64, cos_tilt: f64, transverse_mps: f64, induced_mps: f64) -> GroundEffect {
    if !(cos_tilt > 0.0) {
        return GroundEffect { factor: 1.0, below_envelope: false };
    }
    let z = height_m / cos_tilt;
    let below_envelope = !(z >= MIN_HEIGHT_OVER_RADIUS * radius_m);
    let z = if below_envelope { MIN_HEIGHT_OVER_RADIUS * radius_m } else { z };
    let ratio = radius_m / (4.0 * z);
    let (v2, t2) = (induced_mps * induced_mps, transverse_mps * transverse_mps);
    // (1 + (V_t/v_i)^2)^-1, which is 0 for no induced velocity with a transverse speed.
    let share = if v2 + t2 > 0.0 { v2 / (v2 + t2) } else { 1.0 };
    GroundEffect { factor: 1.0 - ratio * ratio * cos_tilt * share, below_envelope }
}
