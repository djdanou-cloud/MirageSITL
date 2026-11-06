//! Steady axial propeller coefficients for measured wind-tunnel comparison (TASK-033).
//!
//! Drives the prescribed-RPM BET (`blade`) with a uniform induced velocity that
//! satisfies axial actuator-disk momentum, the same closure `inflow::AxialInflow`
//! relaxes towards. Coefficients use the propeller convention of wind-tunnel
//! datasets: n in rev/s, D = 2R, J = V/(nD), CT = T/(rho n^2 D^4),
//! CP = P/(rho n^3 D^5), eta = J CT/CP. This is an offline validation harness,
//! not a step-loop component: it bisects, but allocates nothing.
use crate::{
    blade::{InflowField, Rotor, RotorInput},
    inflow::{AnnularMomentum, DynamicInflow, InflowStates, MAX_INFLOW_STRIPS},
    Vec3,
};
use std::f64::consts::PI;

/// Invalid operating point or rotor evaluation failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PropellerError;

/// Operating point: freestream along the thrust axis.
#[derive(Clone, Copy, Debug)]
pub struct PropellerCondition {
    /// Rotor speed, rev/min (> 0).
    pub rpm: f64,
    /// Advance ratio J = V/(nD), >= 0.
    pub advance_ratio: f64,
    /// Density kg/m^3.
    pub density_kg_m3: f64,
    /// Dynamic viscosity Pa s.
    pub viscosity_pa_s: f64,
    /// Speed of sound m/s.
    pub sound_speed_mps: f64,
    /// Collective pitch added to the geometric twist, rad (0 for fixed-pitch props).
    pub collective_rad: f64,
}

/// Converged steady coefficients.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PropellerPoint {
    /// Thrust coefficient (positive along the hub axis).
    pub ct: f64,
    /// Power coefficient (positive when the shaft drives the air).
    pub cp: f64,
    /// Propulsive efficiency J CT / CP; NaN when CP <= 0.
    pub eta: f64,
    /// Thrust N.
    pub thrust_n: f64,
    /// Shaft power W.
    pub power_w: f64,
    /// Uniform induced velocity m/s (positive opposes the hub axis).
    pub induced_mps: f64,
    /// |T_BET - T_momentum| N at the returned induced velocity.
    pub momentum_residual_n: f64,
    /// Polar validity flags from the BET evaluation.
    pub polar_flags: u32,
    /// True when thrust <= 0 at zero induced velocity (windmilling/brake):
    /// momentum closure is not applied and induced velocity is 0.
    pub outside_momentum_validity: bool,
}

/// Bisection iterations: halves the bracket below 1e-12 relative to its size.
const ITERATIONS: u32 = 80;

fn thrust_and_torque(
    rotor: &Rotor<'_>,
    c: &PropellerCondition,
    omega: f64,
    speed_mps: f64,
    induced: f64,
) -> Result<(f64, f64, u32), PropellerError> {
    let w = rotor
        .evaluate(RotorInput {
            density_kg_m3: c.density_kg_m3,
            viscosity_pa_s: c.viscosity_pa_s,
            sound_speed_mps: c.sound_speed_mps,
            // The propeller advances along +z, so the air approaches along -z.
            air_velocity_hub_mps: Vec3::new(0.0, 0.0, -speed_mps),
            body_rate_hub_rad_s: Vec3::new(0.0, 0.0, 0.0),
            omega_rad_s: omega,
            induced_mps: induced,
            collective_rad: c.collective_rad,
            cyclic_cos_rad: 0.0,
            cyclic_sin_rad: 0.0,
        })
        .map_err(|_| PropellerError)?;
    Ok((w.force_n.z, w.moment_nm.z, w.flags))
}

/// Solves T_BET(v) = 2 rho A v (V + v) for the uniform induced velocity v >= 0
/// and returns the nondimensional point. `radius_m` must equal the rotor tip
/// radius and `spin_sign` its spin sign.
pub fn steady_point(
    rotor: &Rotor<'_>,
    radius_m: f64,
    spin_sign: i32,
    c: PropellerCondition,
) -> Result<PropellerPoint, PropellerError> {
    if ![
        c.rpm,
        c.advance_ratio,
        c.density_kg_m3,
        c.viscosity_pa_s,
        c.sound_speed_mps,
        c.collective_rad,
        radius_m,
    ]
    .iter()
    .all(|x| x.is_finite())
        || c.rpm <= 0.0
        || c.advance_ratio < 0.0
        || radius_m <= 0.0
        || ![-1, 1].contains(&spin_sign)
    {
        return Err(PropellerError);
    }
    let n = c.rpm / 60.0;
    let diameter = 2.0 * radius_m;
    let omega = 2.0 * PI * n;
    let speed = c.advance_ratio * n * diameter;
    let rho_area = c.density_kg_m3 * PI * radius_m * radius_m;
    let momentum = |v: f64| 2.0 * rho_area * v * (speed + v);

    let (t0, _, _) = thrust_and_torque(rotor, &c, omega, speed, 0.0)?;
    let mut induced = 0.0;
    let outside = t0 <= 0.0;
    if !outside {
        // T_BET falls and momentum thrust rises with v: one root in [0, hi].
        // At v = tip speed the element inflow angle exceeds any working blade
        // angle, so T_BET <= momentum there for every validated geometry.
        let (mut lo, mut hi) = (0.0, omega * radius_m);
        let (t_hi, _, _) = thrust_and_torque(rotor, &c, omega, speed, hi)?;
        if t_hi - momentum(hi) > 0.0 {
            return Err(PropellerError);
        }
        for _ in 0..ITERATIONS {
            let mid = 0.5 * (lo + hi);
            let (t, _, _) = thrust_and_torque(rotor, &c, omega, speed, mid)?;
            if t - momentum(mid) > 0.0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        induced = 0.5 * (lo + hi);
    }
    let (thrust, torque, flags) = thrust_and_torque(rotor, &c, omega, speed, induced)?;
    // Air torque opposes rotation; shaft power is the drive power against it.
    let power = -(spin_sign as f64) * torque * omega;
    let ct = thrust / (c.density_kg_m3 * n * n * diameter.powi(4));
    let cp = power / (c.density_kg_m3 * n * n * n * diameter.powi(5));
    let eta = if cp > 0.0 { c.advance_ratio * ct / cp } else { f64::NAN };
    let residual = if outside { 0.0 } else { (thrust - momentum(induced)).abs() };
    if ![ct, cp, thrust, power, residual].iter().all(|x| x.is_finite()) {
        return Err(PropellerError);
    }
    Ok(PropellerPoint {
        ct,
        cp,
        eta,
        thrust_n: thrust,
        power_w: power,
        induced_mps: induced,
        momentum_residual_n: residual,
        polar_flags: flags,
        outside_momentum_validity: outside,
    })
}

/// The steady point of the dynamic inflow (TASK-098) with annular tip and hub losses at a fixed rotation speed: the
/// states march to a steady state by the same model a flight step uses, for validation tooling. A point that does
/// not settle is marked outside momentum validity.
pub fn steady_dynamic_point(rotor: &Rotor<'_>, annuli: AnnularMomentum<'_>, spin_sign: i32, c: PropellerCondition) -> Result<PropellerPoint, PropellerError> {
    if c.rpm <= 0.0 || c.advance_ratio < 0.0 || ![c.rpm, c.advance_ratio, c.density_kg_m3, c.viscosity_pa_s, c.sound_speed_mps, c.collective_rad].iter().all(|x| x.is_finite()) {
        return Err(PropellerError);
    }
    const STEP_S: f64 = 5e-4;
    const MAX_STEPS: usize = 20_000;
    let n = c.rpm / 60.0;
    let (radius_m, omega) = (annuli.radius_m, 2.0 * PI * n);
    let diameter = 2.0 * radius_m;
    let speed = c.advance_ratio * n * diameter;
    let model = DynamicInflow::new(c.density_kg_m3, radius_m, 0.0, 1e4).map_err(|_| PropellerError)?;
    let strips = annuli.strip_radius_m.len().min(MAX_INFLOW_STRIPS);
    let air = Vec3::new(0.0, 0.0, -speed);
    let (mut shape, mut annular, mut thrust) = ([1.0; MAX_INFLOW_STRIPS], [0.0; MAX_INFLOW_STRIPS], [0.0; MAX_INFLOW_STRIPS]);
    let (mut states, mut loss, mut settled) = (InflowStates::default(), 1.0, false);
    let (mut last_thrust, mut flags, mut outside) = (f64::NAN, 0, false);
    let mut w = None;
    for _ in 0..MAX_STEPS {
        let input = RotorInput { density_kg_m3: c.density_kg_m3, viscosity_pa_s: c.viscosity_pa_s, sound_speed_mps: c.sound_speed_mps, air_velocity_hub_mps: air,
            body_rate_hub_rad_s: Vec3::new(0.0, 0.0, 0.0), omega_rad_s: omega, induced_mps: states.mean_mps, collective_rad: c.collective_rad, cyclic_cos_rad: 0.0, cyclic_sin_rad: 0.0 };
        let field = InflowField { shape: &shape[..strips], cos_mps: states.cos_mps, sin_mps: states.sin_mps };
        let wrench = rotor.evaluate_field(input, field, Some(&mut thrust[..strips])).map_err(|_| PropellerError)?;
        flags = wrench.flags;
        let r = model.step(states, loss, wrench.force_n.z, wrench.flap_load_nm.y, wrench.flap_load_nm.z, air, omega * radius_m, STEP_S).map_err(|_| PropellerError)?;
        let sign = if wrench.force_n.z < 0.0 { -1.0 } else { 1.0 };
        for k in 0..strips { annular[k] = states.mean_mps * shape[k] * sign; }
        let solved = annuli.solve(&thrust[..strips], c.density_kg_m3, omega, sign, speed * sign, 0.0, &mut annular[..strips]);
        if solved.mean_mps > 0.0 && r.glauert_root_mps > 0.0 {
            loss += r.relaxation * ((solved.mean_mps / r.glauert_root_mps).clamp(0.2, 5.0) - loss);
            for k in 0..strips { shape[k] += r.relaxation * (annular[k] / solved.mean_mps - shape[k]); }
        }
        states = r.states;
        outside = wrench.force_n.z <= 0.0 || r.outside_validity;
        let quiet = (wrench.force_n.z - last_thrust).abs() <= 1e-9 * wrench.force_n.z.abs().max(1e-6);
        last_thrust = wrench.force_n.z;
        w = Some(wrench);
        if quiet {
            settled = true;
            break;
        }
    }
    let wrench = w.ok_or(PropellerError)?;
    // Near zero thrust the march can keep changing sign: a windmilling point, which momentum does not describe.
    outside |= !settled;
    let power = -(spin_sign as f64) * wrench.moment_nm.z * omega;
    let ct = wrench.force_n.z / (c.density_kg_m3 * n * n * diameter.powi(4));
    let cp = power / (c.density_kg_m3 * n * n * n * diameter.powi(5));
    let eta = if cp > 0.0 { c.advance_ratio * ct / cp } else { f64::NAN };
    if ![ct, cp, wrench.force_n.z, power].iter().all(|x| x.is_finite()) {
        return Err(PropellerError);
    }
    Ok(PropellerPoint { ct, cp, eta, thrust_n: wrench.force_n.z, power_w: power, induced_mps: states.mean_mps, momentum_residual_n: 0.0, polar_flags: flags, outside_momentum_validity: outside })
}
