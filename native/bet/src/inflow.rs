//! Limited signed axial actuator-disk inflow, experimental outside normal working flow.
/// Configuration or non-finite input failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InflowError;
/// Finite signed induced velocity and target residual.
#[derive(Clone, Copy, Debug)]
pub struct InflowReport {
    /// Signed velocity subtracting hub +z air flow, m/s.
    pub velocity_mps: f64,
    /// Quasi-steady momentum target, m/s.
    pub target_mps: f64,
    /// Absolute target momentum residual N, after bounding.
    pub residual_n: f64,
    /// Descent/VRS, transverse flow >1 m/s, or bounded target: unvalidated.
    pub outside_validity: bool,
}
/// Fixed-parameter axial model. Target is a closed form, zero iterative solver steps.
#[derive(Clone, Copy, Debug)]
pub struct AxialInflow {
    rho_area: f64,
    tau_s: f64,
    limit_mps: f64,
}
impl AxialInflow {
    /// Validates rho [0.05,2] kg/m³, disk radius m, time constant s, velocity bound m/s.
    pub fn new(rho: f64, radius_m: f64, tau_s: f64, limit_mps: f64) -> Result<Self, InflowError> {
        if ![rho, radius_m, tau_s, limit_mps]
            .iter()
            .all(|v| v.is_finite())
            || !(0.05..=2.0).contains(&rho)
            || radius_m <= 0.0
            || tau_s <= 0.0
            || limit_mps <= 0.0
        {
            return Err(InflowError);
        }
        let rho_area = rho * std::f64::consts::PI * radius_m * radius_m;
        if !rho_area.is_finite() || rho_area <= 0.0 {
            return Err(InflowError);
        }
        Ok(Self {
            rho_area,
            tau_s,
            limit_mps,
        })
    }
    /// Exact first-order relaxation to the signed momentum root, held T/flow per step.
    /// This is one-way thrust-to-inflow closure; callers iterate coupling separately.
    pub fn step(
        &self,
        current_mps: f64,
        thrust_n: f64,
        air_axial_mps: f64,
        transverse_mps: f64,
        dt_s: f64,
    ) -> Result<InflowReport, InflowError> {
        if ![current_mps, thrust_n, air_axial_mps, transverse_mps, dt_s]
            .iter()
            .all(|v| v.is_finite())
            || dt_s <= 0.0
            || dt_s > 0.01
            || transverse_mps < 0.0
            || current_mps.abs() > self.limit_mps
        {
            return Err(InflowError);
        }
        let sign = thrust_n.signum();
        let climb = -air_axial_mps * sign;
        let loading = thrust_n.abs() / (2.0 * self.rho_area);
        // Rationalized positive root avoids cancellation at high climb speed.
        let root = if loading == 0.0 {
            0.0
        } else if climb >= 0.0 {
            2.0 * loading / (climb.hypot(2.0 * loading.sqrt()) + climb)
        } else {
            (climb * climb + 4.0 * loading)
                .sqrt()
                .mul_add(0.5, -0.5 * climb)
        };
        let target = (sign * root).clamp(-self.limit_mps, self.limit_mps);
        let next = target + (current_mps - target) * (-dt_s / self.tau_s).exp();
        let residual =
            (2.0 * self.rho_area * target * (target - air_axial_mps).abs() - thrust_n).abs();
        if !next.is_finite() || !residual.is_finite() {
            return Err(InflowError);
        }
        Ok(InflowReport {
            velocity_mps: next,
            target_mps: target,
            residual_n: residual,
            outside_validity: (thrust_n != 0.0 && climb < 0.0)
                || transverse_mps > 1.0
                || root > self.limit_mps,
        })
    }
}
