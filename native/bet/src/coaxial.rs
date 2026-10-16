//! Experimental one-way coaxial coupling: steady expanding top-hat jet.
//!
//! Source: ideal hover actuator disk contracts the far wake to A_source/2;
//! downstream turbulent entrainment is represented by an explicitly supplied
//! spreading angle. Momentum is conserved; kinetic power lost in spreading is
//! assigned to mixing. This is a synthetic reference, not a measured coaxial map.
use crate::Vec3;
use std::f64::consts::{FRAC_PI_4, PI, SQRT_2};
/// Invalid geometry, unsupported thrust/launch speed, or numerical overflow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WakeError;
/// Aligned parallel disks: receiver below source along hub -z. No swirl/feedback.
#[derive(Clone, Copy, Debug)]
pub struct WakePair {
    /// Stable source rotor ID (0..31).
    pub upper_id: u32,
    /// Distinct receiver rotor ID (0..31).
    pub lower_id: u32,
    /// Downstream distance m, [0,1e9]; zero is a mathematical limit only.
    pub separation_m: f64,
    /// Fraction [0,1] of min(wake area, receiver area) intercepted.
    pub overlap: f64,
    /// Source rotor radius m, [0.001,100].
    pub source_radius_m: f64,
    /// Receiver rotor radius m, [0.001,100].
    pub receiver_radius_m: f64,
    /// Experimental spreading half angle rad, (0,pi/4]; no default fitted factor.
    pub spread_half_angle_rad: f64,
    /// False suppresses interception; independent rotor inputs stay unchanged.
    pub enabled: bool,
}
/// Passive air-flow transfer budget. Fluxes are NOT extra forces or motor power.
#[derive(Clone, Copy, Debug)]
pub struct WakeReport {
    /// Always true: no empirical coaxial calibration is asserted.
    pub experimental: bool,
    /// Area-averaged addition to receiver air-minus-hub velocity, m/s.
    pub air_velocity_delta_hub_mps: Vec3,
    /// Initial ideal contracted-wake speed m/s, limited to <=100.
    pub launch_speed_mps: f64,
    /// Wake core velocity magnitude at receiver, m/s.
    pub wake_speed_mps: f64,
    /// Ideal hover source kinetic power T*u_launch/2 W.
    pub source_power_w: f64,
    /// Intercepted air kinetic power W, not a receiver motor power credit.
    pub received_power_w: f64,
    /// Air kinetic power bypassing receiver W.
    pub bypass_power_w: f64,
    /// Nonnegative dissipated mixing power W.
    pub mixing_loss_w: f64,
    /// Intercepted axial momentum flux N, not receiver thrust.
    pub received_momentum_n: f64,
    /// Axial momentum flux outside interception N.
    pub bypass_momentum_n: f64,
}
/// Prevalidated geometry and density; evaluation is constant-work and allocation-free.
#[derive(Clone, Copy, Debug)]
pub struct CoaxialWake {
    launch_density_area: f64,
    speed_ratio: f64,
    receiver_coverage: f64,
    wake_interception: f64,
}
impl CoaxialWake {
    /// Precomputes areas and passive mixing fractions. Density [0.05,2] kg/m³.
    pub fn new(pair: WakePair, density_kg_m3: f64) -> Result<Self, WakeError> {
        if pair.upper_id > 31
            || pair.lower_id > 31
            || pair.upper_id == pair.lower_id
            || ![
                pair.separation_m,
                pair.overlap,
                pair.source_radius_m,
                pair.receiver_radius_m,
                pair.spread_half_angle_rad,
                density_kg_m3,
            ]
            .iter()
            .all(|v| v.is_finite())
            || !(0.0..=1e9).contains(&pair.separation_m)
            || !(0.0..=1.0).contains(&pair.overlap)
            || !(0.001..=100.0).contains(&pair.source_radius_m)
            || !(0.001..=100.0).contains(&pair.receiver_radius_m)
            || pair.spread_half_angle_rad <= 0.0
            || pair.spread_half_angle_rad > FRAC_PI_4
            || !(0.05..=2.0).contains(&density_kg_m3)
        {
            return Err(WakeError);
        }
        let launch_radius = pair.source_radius_m / SQRT_2;
        let wake_radius = launch_radius + pair.separation_m * pair.spread_half_angle_rad.tan();
        let launch_area = PI * launch_radius * launch_radius;
        let wake_area = PI * wake_radius * wake_radius;
        let receiver_area = PI * pair.receiver_radius_m * pair.receiver_radius_m;
        let intercept = if pair.enabled {
            pair.overlap * wake_area.min(receiver_area)
        } else {
            0.0
        };
        Ok(Self {
            launch_density_area: density_kg_m3 * launch_area,
            speed_ratio: launch_radius / wake_radius,
            receiver_coverage: intercept / receiver_area,
            wake_interception: intercept / wake_area,
        })
    }
    /// Positive source thrust only; zero is calm. Reverse wake, VRS, oblique
    /// flow, transients and mutual rotor feedback need separate models.
    /// The ideal source power is inferred, not a measured shaft power budget.
    pub fn evaluate(&self, source_thrust_n: f64) -> Result<WakeReport, WakeError> {
        if !source_thrust_n.is_finite() || source_thrust_n < 0.0 {
            return Err(WakeError);
        }
        let launch_speed = (source_thrust_n / self.launch_density_area).sqrt();
        if !launch_speed.is_finite() || launch_speed > 100.0 {
            return Err(WakeError);
        }
        let wake_speed = launch_speed * self.speed_ratio;
        let source_power = 0.5 * source_thrust_n * launch_speed;
        let wake_power = source_power * self.speed_ratio;
        let received_power = wake_power * self.wake_interception;
        let received_momentum = source_thrust_n * self.wake_interception;
        // Canonical +0 preserves exact disabled/zero-flow results across JS/WASM.
        let receiver_delta = if self.receiver_coverage == 0.0 || wake_speed == 0.0 {
            0.0
        } else {
            -wake_speed * self.receiver_coverage
        };
        Ok(WakeReport {
            experimental: true,
            air_velocity_delta_hub_mps: Vec3::new(0.0, 0.0, receiver_delta),
            launch_speed_mps: launch_speed,
            wake_speed_mps: wake_speed,
            source_power_w: source_power,
            received_power_w: received_power,
            bypass_power_w: wake_power - received_power,
            mixing_loss_w: source_power - wake_power,
            received_momentum_n: received_momentum,
            bypass_momentum_n: source_thrust_n - received_momentum,
        })
    }
}
