//! Bounded scalar compliance laws; force evaluation only, never body integration.
//!
//! See docs/SPECS_SIMULATION_ENGINES.md, TASK-029 compliant-force increment.
//! All parameters are explicit SI configuration. No aircraft defaults or inferred
//! material properties. Independent equations, not copied upstream source code.
use crate::{
    frame::Wrench,
    math::{finite, rotate},
    Vec3,
};

/// Invalid configuration, nonfinite arithmetic, or an unmodeled travel limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GearError;

/// Positive compressive force, stored elastic energy and effective dissipation.
#[derive(Clone, Copy, Debug)]
pub struct ComplianceOutput {
    /// Unilateral compressive load magnitude, N.
    pub load_n: f64,
    /// Elastic contribution before the unilateral clamp, N.
    pub elastic_n: f64,
    /// Elastic potential relative to zero compression, J.
    pub stored_energy_j: f64,
    /// Effective damping loss (load minus elastic force) times closure speed, W.
    pub dissipation_w: f64,
}

fn output(
    elastic: f64,
    damping: f64,
    energy: f64,
    rate: f64,
) -> Result<ComplianceOutput, GearError> {
    let load = (elastic + damping).max(0.0);
    let loss = (load - elastic) * rate;
    if !elastic.is_finite()
        || !damping.is_finite()
        || !load.is_finite()
        || !energy.is_finite()
        || !loss.is_finite()
        || energy < 0.0
        || loss < 0.0
    {
        return Err(GearError);
    }
    Ok(ComplianceOutput {
        load_n: load,
        elastic_n: elastic,
        stored_energy_j: energy,
        dissipation_w: loss,
    })
}

/// The coefficient has units N s/m for linear, N s²/m² for square damping.
#[derive(Clone, Copy, Debug)]
pub enum DampingLaw {
    /// Force proportional to signed compression speed.
    Linear,
    /// Force proportional to signed speed squared.
    Square,
}

/// Distinct compression and rebound resistance, selected by speed sign.
#[derive(Clone, Copy, Debug)]
pub struct Damping {
    compression: f64,
    rebound: f64,
    law: DampingLaw,
}
impl Damping {
    /// Nonnegative finite coefficients; zero disables damping in that direction.
    pub fn new(compression: f64, rebound: f64, law: DampingLaw) -> Result<Self, GearError> {
        if !compression.is_finite() || compression < 0.0 || !rebound.is_finite() || rebound < 0.0 {
            return Err(GearError);
        }
        Ok(Self {
            compression,
            rebound,
            law,
        })
    }
    fn force(&self, rate: f64) -> f64 {
        let coefficient = if rate >= 0.0 {
            self.compression
        } else {
            self.rebound
        };
        match self.law {
            DampingLaw::Linear => coefficient * rate,
            DampingLaw::Square => coefficient * rate * rate.abs(),
        }
    }
}

/// Linear elastic strut with a preload and direction-dependent damping.
#[derive(Clone, Copy, Debug)]
pub struct LinearStrut {
    stiffness: f64,
    preload: f64,
    travel: f64,
    damping: Damping,
}
impl LinearStrut {
    /// Stiffness N/m, preload N and maximum travel m; no implicit hard-stop law.
    pub fn new(
        stiffness: f64,
        preload: f64,
        travel: f64,
        damping: Damping,
    ) -> Result<Self, GearError> {
        if !stiffness.is_finite()
            || stiffness <= 0.0
            || !preload.is_finite()
            || preload < 0.0
            || !travel.is_finite()
            || travel <= 0.0
        {
            return Err(GearError);
        }
        Ok(Self {
            stiffness,
            preload,
            travel,
            damping,
        })
    }
    /// Compression m in [0, travel], positive closure speed m/s. Pure evaluation.
    pub fn evaluate(&self, compression: f64, rate: f64) -> Result<ComplianceOutput, GearError> {
        if !compression.is_finite()
            || compression < 0.0
            || compression > self.travel
            || !rate.is_finite()
        {
            return Err(GearError);
        }
        output(
            self.preload + self.stiffness * compression,
            self.damping.force(rate),
            self.preload * compression + 0.5 * self.stiffness * compression * compression,
            rate,
        )
    }
}

/// Single-chamber polytropic gas spring and incompressible fixed-orifice damping.
/// This is not a calibrated compound aircraft strut or a stop/extension solver.
#[derive(Clone, Copy, Debug)]
pub struct GasStrut {
    area: f64,
    volume: f64,
    pressure_abs: f64,
    ambient_abs: f64,
    exponent: f64,
    travel: f64,
    damping: Damping,
}
impl GasStrut {
    /// SI: gas swept area m², extended volume m³, absolute pressures Pa,
    /// exponent [1,1.4], travel m, hydraulic swept area m², fluid density kg/m³,
    /// discharge coefficient (0,1], compression/rebound orifice areas m².
    /// Pressure-force and swept-volume areas are equal in this reduced model.
    pub fn new(
        area: f64,
        volume: f64,
        pressure_abs: f64,
        ambient_abs: f64,
        exponent: f64,
        travel: f64,
        hydraulic_area: f64,
        density: f64,
        discharge: f64,
        compression_orifice: f64,
        rebound_orifice: f64,
    ) -> Result<Self, GearError> {
        if ![
            area,
            volume,
            pressure_abs,
            ambient_abs,
            exponent,
            travel,
            hydraulic_area,
            density,
            discharge,
            compression_orifice,
            rebound_orifice,
        ]
        .iter()
        .all(|v| v.is_finite() && *v > 0.0)
            || pressure_abs < ambient_abs
            || !(1.0..=1.4).contains(&exponent)
            || discharge > 1.0
            || volume - area * travel <= 0.0
        {
            return Err(GearError);
        }
        let coefficient = |orifice: f64| {
            let flow_ratio = hydraulic_area / (discharge * orifice);
            0.5 * density * hydraulic_area * flow_ratio * flow_ratio
        };
        let damping = Damping::new(
            coefficient(compression_orifice),
            coefficient(rebound_orifice),
            DampingLaw::Square,
        )?;
        Ok(Self {
            area,
            volume,
            pressure_abs,
            ambient_abs,
            exponent,
            travel,
            damping,
        })
    }
    /// Positive closure speed m/s; compression m must remain inside declared travel.
    /// Gas preload is an internal strut load: an integration owner must supply
    /// the opposing extension-stop reaction when the gear hangs fully extended.
    pub fn evaluate(&self, compression: f64, rate: f64) -> Result<ComplianceOutput, GearError> {
        if !compression.is_finite()
            || compression < 0.0
            || compression > self.travel
            || !rate.is_finite()
        {
            return Err(GearError);
        }
        let fraction = self.area * compression / self.volume;
        let log_ratio = -(-fraction).ln_1p();
        let elastic = ((self.pressure_abs - self.ambient_abs)
            + self.pressure_abs * (self.exponent * log_ratio).exp_m1())
            * self.area;
        let gas_work = if self.exponent == 1.0 {
            log_ratio
        } else {
            ((self.exponent - 1.0) * log_ratio).exp_m1() / (self.exponent - 1.0)
        };
        // The integrated compression law minus its constant term starts at u².
        // Its analytic series avoids cancellation when p0 equals ambient and u
        // is tiny. Through u^5, omitted terms at u<1e-4 are below 1e-23.
        let n = self.exponent;
        let excess = if fraction < 1e-4 {
            fraction
                * fraction
                * (n / 2.0
                    + fraction
                        * (n * (n + 1.0) / 6.0
                            + fraction
                                * (n * (n + 1.0) * (n + 2.0) / 24.0
                                    + fraction * n * (n + 1.0) * (n + 2.0) * (n + 3.0) / 120.0)))
        } else {
            gas_work - fraction
        };
        let energy = (self.pressure_abs - self.ambient_abs) * self.area * compression
            + self.pressure_abs * self.volume * excess;
        output(elastic, self.damping.force(rate), energy, rate)
    }
}

/// Measured or explicitly synthetic tire load-deflection curve, maximum 64 knots.
/// Borrows immutable configuration; deflection is not strut stroke or mesh overlap.
#[derive(Clone, Copy, Debug)]
pub struct TireCurve<'a> {
    deflection: &'a [f64],
    load: &'a [f64],
    damping: f64,
}
impl<'a> TireCurve<'a> {
    /// Strictly increasing deflections m from zero; nondecreasing loads N from
    /// zero. Vertical damping N s/m must be finite and nonnegative.
    pub fn new(deflection: &'a [f64], load: &'a [f64], damping: f64) -> Result<Self, GearError> {
        if deflection.len() < 2
            || deflection.len() > 64
            || deflection.len() != load.len()
            || !damping.is_finite()
            || damping < 0.0
            || deflection[0] != 0.0
            || load[0] != 0.0
        {
            return Err(GearError);
        }
        for i in 0..deflection.len() {
            if !deflection[i].is_finite()
                || !load[i].is_finite()
                || load[i] < 0.0
                || (i > 0 && (deflection[i] <= deflection[i - 1] || load[i] < load[i - 1]))
            {
                return Err(GearError);
            }
        }
        Ok(Self {
            deflection,
            load,
            damping,
        })
    }
    /// Positive tire closure speed m/s; nonpositive deflection means no contact.
    /// Exceeding the last knot fails rather than inventing a bottom-out response.
    pub fn evaluate(&self, deflection: f64, rate: f64) -> Result<ComplianceOutput, GearError> {
        if !deflection.is_finite()
            || !rate.is_finite()
            || deflection > self.deflection[self.deflection.len() - 1]
        {
            return Err(GearError);
        }
        if deflection <= 0.0 {
            return output(0.0, 0.0, 0.0, rate);
        }
        let mut energy = 0.0;
        for i in 1..self.deflection.len() {
            let start = self.deflection[i - 1];
            let width = self.deflection[i] - start;
            let slope = (self.load[i] - self.load[i - 1]) / width;
            let distance = deflection.min(self.deflection[i]) - start;
            energy += self.load[i - 1] * distance + 0.5 * slope * distance * distance;
            if deflection <= self.deflection[i] {
                return output(
                    self.load[i - 1] + slope * distance,
                    self.damping * rate,
                    energy,
                    rate,
                );
            }
        }
        Err(GearError)
    }
}

/// Contact force/moment in body FRD from an outward unit terrain normal in NED.
/// Tangential friction is a regularized Coulomb sliding law, not a static-friction
/// constraint, wheel-spin/slip model or rolling-resistance model. No dt or state
/// integration occurs here; the sole owning solver applies the resulting wrench.
pub fn ground_wrench(
    point_body: Vec3,
    body_to_ned: [f64; 4],
    normal_ned: Vec3,
    load_n: f64,
    velocity_ned: Vec3,
    friction: f64,
    regularization_mps: f64,
) -> Result<Wrench, GearError> {
    let qnorm2 = body_to_ned.iter().map(|v| v * v).sum::<f64>();
    if !finite(point_body)
        || !finite(normal_ned)
        || !finite(velocity_ned)
        || !qnorm2.is_finite()
        || (qnorm2 - 1.0).abs() > 1e-10
        || (normal_ned.dot(normal_ned) - 1.0).abs() > 1e-10
        || !load_n.is_finite()
        || load_n < 0.0
        || !friction.is_finite()
        || friction < 0.0
        || !regularization_mps.is_finite()
        || regularization_mps <= 0.0
    {
        return Err(GearError);
    }
    let tangent = velocity_ned.add(normal_ned.scale(-velocity_ned.dot(normal_ned)));
    let speed = tangent.norm();
    if !speed.is_finite() {
        return Err(GearError);
    }
    let force_ned = normal_ned
        .scale(load_n)
        .add(tangent.scale(-friction * load_n / speed.max(regularization_mps)));
    let force = rotate(
        [
            body_to_ned[0],
            -body_to_ned[1],
            -body_to_ned[2],
            -body_to_ned[3],
        ],
        force_ned,
    );
    let moment = point_body.cross(force);
    if !finite(force) || !finite(moment) {
        return Err(GearError);
    }
    Ok(Wrench { force, moment })
}
