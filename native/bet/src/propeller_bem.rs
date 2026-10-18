//! Offline steady, axisymmetric propeller BEM diagnostic (TASK-033).
//!
//! Each annulus balances blade loads with axial and angular momentum. Rotor
//! plane axial induction u and swirl w give relative velocities V+u, Omega*r-w.
//! dT/dr=4*pi*rho*r*F*u*(V+u), dQ/dr=4*pi*rho*r^2*F*w*(V+u).
//! Deters (2014) dissertation section 4.2 motivates axial/tangential induction;
//! PROPID 5.3.1 manual sections 3.1-3.2 identify Prandtl tip/hub loss and swirl.
//! This diagnostic is independent of the legacy uniform-inflow path and does
//! not add a production ABI or certify post-stall or windmilling behavior.
use crate::{
    blade::{Rotor, RotorGeometry},
    polar::PolarTable,
    propeller::{PropellerCondition, PropellerError},
};
use std::f64::consts::PI;

/// Explicit assumptions of the steady diagnostic.
#[derive(Clone, Copy, Debug)]
pub struct BemOptions {
    /// Apply the original Prandtl tip factor to annular momentum.
    pub tip_loss: bool,
    /// Apply the hub factor using distance from the inactive root.
    pub hub_loss: bool,
    /// Solve angular momentum for rotor-plane induced tangential velocity.
    pub swirl: bool,
}
impl Default for BemOptions {
    fn default() -> Self {
        Self {
            tip_loss: true,
            hub_loss: true,
            swirl: true,
        }
    }
}

/// Steady integrated loads and explicit numerical/lookup diagnostics.
#[derive(Clone, Copy, Debug)]
pub struct BemPoint {
    /// Thrust coefficient T/(rho*n^2*D^4).
    pub ct: f64,
    /// Shaft power coefficient P/(rho*n^3*D^5).
    pub cp: f64,
    /// J*CT/CP, NaN for nonpositive shaft power.
    pub eta: f64,
    /// Axial thrust N.
    pub thrust_n: f64,
    /// Shaft power W, positive drives the propeller.
    pub power_w: f64,
    /// Span-width-weighted rotor-plane axial induction m/s.
    pub mean_induced_mps: f64,
    /// Span-width-weighted rotor-plane swirl m/s.
    pub mean_swirl_mps: f64,
    /// All annular residuals are below 1e-9 of local rotational force scale.
    pub converged: bool,
    /// Integrated nonpositive thrust/power is outside the propulsive branch.
    pub outside_momentum_validity: bool,
    /// OR of final station polar validity flags; clamping is never acceptance.
    pub polar_flags: u32,
    /// Maximum dimensionless momentum residual across annuli.
    pub max_relative_residual: f64,
    /// Minimum final section angle of attack rad.
    pub min_alpha_rad: f64,
    /// Maximum final section angle of attack rad.
    pub max_alpha_rad: f64,
    /// Minimum final section Reynolds number.
    pub min_reynolds: f64,
    /// Maximum final section Reynolds number.
    pub max_reynolds: f64,
}

/// Original Prandtl finite-blade factors, in [0,1]; callers use interior
/// midpoint stations. The hub exponent uses hub radius, tip exponent uses r.
/// Disabled losses return exactly one. No empirical performance multiplier.
pub fn prandtl_loss(
    blades: u32,
    r: f64,
    tip: f64,
    hub: f64,
    phi: f64,
    tip_on: bool,
    hub_on: bool,
) -> f64 {
    let s = phi.sin().abs().max(1e-12);
    let factor = |distance: f64, denominator: f64| {
        (2.0 / PI)
            * (-0.5 * blades as f64 * distance / (denominator * s))
                .exp()
                .clamp(0.0, 1.0)
                .acos()
    };
    let ft = if tip_on {
        factor((tip - r).max(0.0), r)
    } else {
        1.0
    };
    let fh = if hub_on && hub > 0.0 {
        factor((r - hub).max(0.0), hub)
    } else {
        1.0
    };
    ft * fh
}

#[derive(Clone, Copy)]
struct Ring {
    radius: f64,
    chord: f64,
    twist: f64,
    tip: f64,
    hub: f64,
    omega: f64,
    speed: f64,
    blades: u32,
    condition: PropellerCondition,
    options: BemOptions,
}
#[derive(Clone, Copy)]
struct Evaluation {
    res: [f64; 2],
    thrust: f64,
    torque: f64,
    alpha: f64,
    re: f64,
    flags: u32,
}
impl Ring {
    fn evaluate(self, polar: PolarTable<'_>, u: f64, w: f64) -> Evaluation {
        let axial = self.speed + u;
        let tangential = self.omega * self.radius - w;
        let phi = axial.atan2(tangential);
        let alpha = self.twist + self.condition.collective_rad - phi;
        let v2 = axial * axial + tangential * tangential;
        let re =
            self.condition.density_kg_m3 * v2.sqrt() * self.chord / self.condition.viscosity_pa_s;
        let p = polar.lookup(alpha, re, v2.sqrt() / self.condition.sound_speed_mps);
        let force = 0.5 * self.condition.density_kg_m3 * v2 * self.blades as f64 * self.chord;
        let thrust = force * (p.cl * phi.cos() - p.cd * phi.sin());
        let torque = self.radius * force * (p.cl * phi.sin() + p.cd * phi.cos());
        let f = prandtl_loss(
            self.blades,
            self.radius,
            self.tip,
            self.hub,
            phi,
            self.options.tip_loss,
            self.options.hub_loss,
        );
        let momentum = 4.0 * PI * self.condition.density_kg_m3 * self.radius * f * axial;
        let scale = 0.5
            * self.condition.density_kg_m3
            * (self.omega * self.radius).powi(2)
            * self.blades as f64
            * self.chord;
        Evaluation {
            res: [
                (thrust - momentum * u) / scale,
                if self.options.swirl {
                    (torque / self.radius - momentum * w) / scale
                } else {
                    w
                },
            ],
            thrust,
            torque,
            alpha,
            re,
            flags: p.flags,
        }
    }

    fn swirl_at(self, polar: PolarTable<'_>, u: f64) -> Option<(f64, Evaluation)> {
        if !self.options.swirl {
            return Some((0.0, self.evaluate(polar, u, 0.0)));
        }
        let limit = self.omega * self.radius;
        let mut lo = -limit * (1.0 - 1e-10);
        let mut hi = limit * (1.0 - 1e-10);
        let mut low = self.evaluate(polar, u, lo);
        let high = self.evaluate(polar, u, hi);
        if low.res[1] * high.res[1] > 0.0 {
            return None;
        }
        for _ in 0..70 {
            let mid = (lo + hi) * 0.5;
            let e = self.evaluate(polar, u, mid);
            if e.res[1].abs() < 1e-12 {
                return Some((mid, e));
            }
            if low.res[1] * e.res[1] <= 0.0 {
                hi = mid;
            } else {
                lo = mid;
                low = e;
            }
        }
        let w = (lo + hi) * 0.5;
        Some((w, self.evaluate(polar, u, w)))
    }

    // Safeguarded fallback when a Newton step encounters an interpolation
    // kink/nonmonotone polar. Scan low to high u, take the first continuous
    // sign bracket, then bisect; no coefficient fitting or relaxed residual.
    fn bracketed(self, polar: PolarTable<'_>) -> Option<(f64, f64)> {
        let limit = self.omega * self.radius;
        let mut lower = -0.5 * self.speed + 1e-8 * limit;
        let mut upper = 2.0 * limit;
        // Expand the numerical search if needed. Induction exceeding a fixed
        // fraction of rotational speed is not itself a physical rejection.
        for _ in 0..8 {
            let mut previous: Option<(f64, f64)> = None;
            for i in 0..=64 {
                let u = lower + (upper - lower) * i as f64 / 64.0;
                let Some((_, e)) = self.swirl_at(polar, u) else {
                    previous = None;
                    continue;
                };
                if let Some((mut lo, mut f_lo)) = previous {
                    if f_lo * e.res[0] <= 0.0 {
                        let mut hi = u;
                        for _ in 0..70 {
                            let mid = (lo + hi) * 0.5;
                            let (w, e) = self.swirl_at(polar, mid)?;
                            if norm(e.res) < 1e-11 {
                                return Some((mid, w));
                            }
                            if f_lo * e.res[0] <= 0.0 {
                                hi = mid;
                            } else {
                                lo = mid;
                                f_lo = e.res[0];
                            }
                        }
                        let mid = (lo + hi) * 0.5;
                        return self.swirl_at(polar, mid).map(|(w, _)| (mid, w));
                    }
                }
                previous = Some((u, e.res[0]));
            }
            lower = upper;
            upper *= 2.0;
        }
        None
    }
}
fn norm(r: [f64; 2]) -> f64 {
    r[0].abs().max(r[1].abs())
}

/// Solves a bounded damped Newton system per midpoint annulus. At most 100
/// iterations, 16 backtracks each, then a bounded nested bisection fallback;
/// nonconvergence is returned explicitly and
/// must not be admitted as fidelity evidence. Local lightly braking annuli are
/// allowed only while V+u >= V/2 (classical momentum branch); integrated thrust
/// and shaft power must be positive for propeller acceptance. No allocations.
pub fn steady_annular(
    g: RotorGeometry<'_>,
    polar: PolarTable<'_>,
    c: PropellerCondition,
    options: BemOptions,
) -> Result<BemPoint, PropellerError> {
    Rotor::new(g, polar, 4).map_err(|_| PropellerError)?;
    if ![
        c.rpm,
        c.advance_ratio,
        c.density_kg_m3,
        c.viscosity_pa_s,
        c.sound_speed_mps,
        c.collective_rad,
    ]
    .iter()
    .all(|v| v.is_finite())
        || c.rpm <= 0.0
        || c.advance_ratio < 0.0
        || c.density_kg_m3 <= 0.0
        || c.viscosity_pa_s <= 0.0
        || c.sound_speed_mps <= 0.0
    {
        return Err(PropellerError);
    }
    let n = c.rpm / 60.0;
    let omega = 2.0 * PI * n;
    let diameter = 2.0 * g.radius_m;
    let mut out = BemPoint {
        ct: 0.0,
        cp: 0.0,
        eta: f64::NAN,
        thrust_n: 0.0,
        power_w: 0.0,
        mean_induced_mps: 0.0,
        mean_swirl_mps: 0.0,
        converged: true,
        outside_momentum_validity: false,
        polar_flags: 0,
        max_relative_residual: 0.0,
        min_alpha_rad: f64::INFINITY,
        max_alpha_rad: f64::NEG_INFINITY,
        min_reynolds: f64::INFINITY,
        max_reynolds: 0.0,
    };
    for k in 0..g.radius.len() {
        let ring = Ring {
            radius: g.radius[k],
            chord: g.chord[k],
            twist: g.twist[k],
            tip: g.radius_m,
            hub: g.cutout_m,
            omega,
            speed: c.advance_ratio * n * diameter,
            blades: g.blade_count,
            condition: c,
            options,
        };
        let limit = omega * ring.radius;
        let mut u = 0.05 * limit;
        let mut w = if options.swirl { 0.01 * limit } else { 0.0 };
        for _ in 0..100 {
            let e = ring.evaluate(polar, u, w);
            if norm(e.res) < 1e-10 {
                break;
            }
            let h = 1e-6 * limit.max(1.0);
            let du = ring.evaluate(polar, u + h, w).res;
            let dw = ring.evaluate(polar, u, w + h).res;
            let a = (du[0] - e.res[0]) / h;
            let b = (dw[0] - e.res[0]) / h;
            let d = (du[1] - e.res[1]) / h;
            let f = (dw[1] - e.res[1]) / h;
            let det = a * f - b * d;
            if !det.is_finite() || det.abs() < 1e-16 {
                break;
            }
            let step_u = (-e.res[0] * f + b * e.res[1]) / det;
            let step_w = if options.swirl {
                (d * e.res[0] - a * e.res[1]) / det
            } else {
                0.0
            };
            let mut damping = 1.0;
            let mut accepted = false;
            for _ in 0..16 {
                let nu = u + damping * step_u;
                let nw = w + damping * step_w;
                if nu >= -0.5 * ring.speed
                    && nu.is_finite()
                    && nw > -limit
                    && nw < limit
                    && norm(ring.evaluate(polar, nu, nw).res) < norm(e.res)
                {
                    u = nu;
                    w = nw;
                    accepted = true;
                    break;
                }
                damping *= 0.5;
            }
            if !accepted {
                break;
            }
        }
        if norm(ring.evaluate(polar, u, w).res) >= 1e-9 {
            if let Some((bu, bw)) = ring.bracketed(polar) {
                if norm(ring.evaluate(polar, bu, bw).res) < norm(ring.evaluate(polar, u, w).res) {
                    u = bu;
                    w = bw;
                }
            }
        }
        let e = ring.evaluate(polar, u, w);
        out.converged &= norm(e.res) < 1e-9;
        out.max_relative_residual = out.max_relative_residual.max(norm(e.res));
        out.thrust_n += e.thrust * g.width[k];
        out.power_w += e.torque * omega * g.width[k];
        out.mean_induced_mps += u * g.width[k] / (g.radius_m - g.cutout_m);
        out.mean_swirl_mps += w * g.width[k] / (g.radius_m - g.cutout_m);
        out.polar_flags |= e.flags;
        out.min_alpha_rad = out.min_alpha_rad.min(e.alpha);
        out.max_alpha_rad = out.max_alpha_rad.max(e.alpha);
        out.min_reynolds = out.min_reynolds.min(e.re);
        out.max_reynolds = out.max_reynolds.max(e.re);
    }
    out.ct = out.thrust_n / (c.density_kg_m3 * n * n * diameter.powi(4));
    out.cp = out.power_w / (c.density_kg_m3 * n * n * n * diameter.powi(5));
    out.outside_momentum_validity = out.thrust_n <= 0.0 || out.power_w <= 0.0;
    out.eta = if out.cp > 0.0 {
        c.advance_ratio * out.ct / out.cp
    } else {
        f64::NAN
    };
    if ![
        out.ct,
        out.cp,
        out.max_relative_residual,
        out.min_alpha_rad,
        out.max_alpha_rad,
        out.min_reynolds,
        out.max_reynolds,
    ]
    .iter()
    .all(|v| v.is_finite())
    {
        return Err(PropellerError);
    }
    Ok(out)
}
