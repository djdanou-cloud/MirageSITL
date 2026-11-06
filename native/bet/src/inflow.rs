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

/// Most strips of a rotor (`RotorGeometry`).
pub const MAX_INFLOW_STRIPS: usize = 64;
/// Pitt-Peters mass term of the mean state, 128/(75 pi).
pub const MASS_MEAN: f64 = 128.0 / (75.0 * std::f64::consts::PI);
/// Pitt-Peters mass term of the harmonic states, 16/(45 pi).
pub const MASS_HARMONIC: f64 = 16.0 / (45.0 * std::f64::consts::PI);
/// The derived time constant's cap where the flow vanishes, s: an engineering limit.
pub const MAX_DERIVED_TAU_S: f64 = 1.0;
/// Most Newton iterations of a momentum solve (TASK-133).
pub const MAX_MOMENTUM_ITERATIONS: u32 = 4;
/// The advance ratio above which inflow is outside its envelope (F-03).
pub const MAX_ADVANCE_RATIO: f64 = 0.3;
const MOMENTUM_TOLERANCE: f64 = 1e-4;

/// The three Pitt-Peters states, m/s along +z of the hub: `v(r, psi) = mean + (r/R) (cos cos(psi) + sin sin(psi))`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InflowStates {
    /// Mean induced velocity.
    pub mean_mps: f64,
    /// First harmonic on cos(psi), at the tip.
    pub cos_mps: f64,
    /// First harmonic on sin(psi), at the tip.
    pub sin_mps: f64,
}

/// One step of the dynamic inflow.
#[derive(Clone, Copy, Debug)]
pub struct DynamicInflowReport {
    /// The states after the step.
    pub states: InflowStates,
    /// The states each one relaxed towards.
    pub targets: InflowStates,
    /// The mean's time constant used, s.
    pub tau_s: f64,
    /// Glauert's root for this thrust, before the loss: `root W = |T|/(2 rho A)`.
    pub glauert_root_mps: f64,
    /// Fraction of the step's relaxation, 1 - exp(-dt/tau): the loss and the shape follow with it.
    pub relaxation: f64,
    /// Descent, an advance ratio above `MAX_ADVANCE_RATIO`, a bounded target or an iteration cap.
    pub outside_validity: bool,
}

/// Glauert's momentum root: `v W = loading`, `W = sqrt(transverse^2 + (climb + v)^2)`, for v >= 0 on the branch
/// with `climb + v >= 0`, by at most `MAX_MOMENTUM_ITERATIONS` Newton iterations from `warm`. On that branch the
/// function is increasing and convex, so an iteration from above the root stays above it. Returns the root and
/// whether it converged. In descent `descent_root` gives it.
pub fn glauert_root(loading: f64, climb: f64, transverse: f64, warm: f64) -> (f64, bool) {
    if loading <= 0.0 {
        return (0.0, true);
    }
    if climb < 0.0 {
        return (descent_root(loading, climb, transverse), true);
    }
    edgewise_root(loading, climb, transverse, warm)
}

/// `glauert_root`'s iteration, for a positive loading.
fn edgewise_root(loading: f64, climb: f64, transverse: f64, warm: f64) -> (f64, bool) {
    let floor = (-climb).max(0.0);
    let mut v = if warm > floor { warm } else {
        // The axial root, which is at or above the edgewise one, so the iteration comes from above.
        ((climb * climb + 4.0 * loading).sqrt() - climb) * 0.5
    };
    let tolerance = 1e-12 * loading;
    for _ in 0..MAX_MOMENTUM_ITERATIONS {
        let flow = climb + v;
        let w = (transverse * transverse + flow * flow).sqrt();
        let residual = v * w - loading;
        if residual.abs() <= tolerance {
            return (v, true);
        }
        let slope = w + v * flow / w;
        if !(slope > 0.0) {
            return (v, false);
        }
        v = (v - residual / slope).max(floor);
    }
    let flow = climb + v;
    let residual = v * (transverse * transverse + flow * flow).sqrt() - loading;
    (v, residual.abs() <= MOMENTUM_TOLERANCE * loading)
}

/// Johnson's parameters (NASA TP-2005-213477, table 4), velocities scaled with the hover inflow.
const JOHNSON_VZ_A: f64 = -1.5;
const JOHNSON_VZ_B: f64 = -2.1;
const JOHNSON_VX_C: f64 = 0.75;

/// Scaled momentum theory, `v sqrt(Vx^2 + (Vz + v)^2) = 1`, on the branch with `Vz + v >= 0`: increasing and convex
/// from v = -Vz, so a Newton iteration from above stays above the root.
fn momentum_working(vz: f64, vx: f64) -> f64 {
    let floor = (-vz).max(0.0);
    let mut v = 0.5 * (vz * vz + 4.0).sqrt() - 0.5 * vz;
    for _ in 0..24 {
        let flow = vz + v;
        let w = (vx * vx + flow * flow).sqrt();
        let residual = v * w - 1.0;
        if residual.abs() <= 1e-13 {
            break;
        }
        v = (v - residual / (w + v * flow / w)).max(floor);
    }
    v
}

/// Scaled momentum theory on the branch with `Vz + v <= 0`, the windmill brake: the first crossing of 1 by
/// `v sqrt(Vx^2 + (Vz + v)^2)` as v rises from 0, by bisection up to its local maximum, which has a closed form.
/// Where the function never reaches 1 this returns the maximum's place, the nearest it comes.
fn momentum_windmill(vz: f64, vx: f64) -> f64 {
    let h = |v: f64| { let flow = vz + v; v * (vx * vx + flow * flow).sqrt() };
    let radicand = vz * vz - 8.0 * vx * vx;
    let mut high = if radicand > 0.0 { (-3.0 * vz - radicand.sqrt()) * 0.25 } else { -vz };
    if h(high) <= 1.0 {
        return high;
    }
    let mut low = 0.0;
    for _ in 0..48 {
        let middle = 0.5 * (low + high);
        if h(middle) > 1.0 { high = middle } else { low = middle }
    }
    0.5 * (low + high)
}

/// `dv/dVz` of scaled momentum theory, from the implicit function.
fn momentum_slope(vz: f64, vx: f64, v: f64) -> f64 {
    let flow = vz + v;
    let w = (vx * vx + flow * flow).sqrt();
    let cross = v * flow / w;
    -cross / (w + cross)
}

/// The baseline induced velocity of Johnson's model (NASA TP-2005-213477, table 3, step 2), scaled with the hover
/// inflow, at scaled climb `vz < 0` and transverse speed `vx >= 0`: momentum theory on its two branches, joined across
/// the singularity between `Vz_B` and `Vz_A` by the cubic `b Vz + c Vz^2 + d Vz^3` that matches value and slope at A
/// and value at B. It returns the value and its slope `dv/dVz`.
pub fn descent_baseline(vz: f64, vx: f64) -> (f64, f64) {
    let unique = |vz: f64| {
        // At and above VxC momentum theory has one root; which branch holds it follows from the sign at v = -Vz.
        if -vz * vx - 1.0 > 0.0 { momentum_windmill(vz, vx) } else { momentum_working(vz, vx) }
    };
    if vx >= JOHNSON_VX_C || vz >= 0.0 {
        let v = unique(vz);
        return (v, momentum_slope(vz, vx, v));
    }
    let share = vx / JOHNSON_VX_C;
    let a = JOHNSON_VZ_A + 0.2 * share * share;
    let mut b = JOHNSON_VZ_B + 0.2 * share * share;
    if share > 0.5 {
        let t = 2.0 * share - 1.0;
        b += 0.7 * (a - b) * t * t * t;
    }
    if vz >= a {
        let v = momentum_working(vz, vx);
        return (v, momentum_slope(vz, vx, v));
    }
    if vz <= b {
        let v = momentum_windmill(vz, vx);
        return (v, momentum_slope(vz, vx, v));
    }
    let (va, vb) = (momentum_working(a, vx), momentum_windmill(b, vx));
    let sa = momentum_slope(a, vx, va);
    // Value and slope at A and value at B, for v = b1 Vz + c1 Vz^2 + d1 Vz^3 with no constant term.
    let (r1, r3) = (va / a, vb / b);
    // r1 = b1 + c1 a + d1 a^2, sa = b1 + 2 c1 a + 3 d1 a^2, r3 = b1 + c1 b + d1 b^2.
    let (p1, q1) = (a, 2.0 * a * a);
    let rhs1 = sa - r1;
    let (p2, q2) = (b - a, b * b - a * a);
    let rhs2 = r3 - r1;
    let det = p1 * q2 - q1 * p2;
    let d1 = (p1 * rhs2 - p2 * rhs1) / det;
    let c1 = (rhs1 - q1 * d1) / p1;
    let b1 = r1 - c1 * a - d1 * a * a;
    (vz * (b1 + vz * (c1 + vz * d1)), b1 + vz * (2.0 * c1 + 3.0 * vz * d1))
}

/// The mean inflow target's root in descent, from the baseline of Johnson's model.
fn descent_root(loading: f64, climb: f64, transverse: f64) -> f64 {
    let hover = loading.sqrt();
    hover * descent_baseline(climb / hover, transverse / hover).0
}

/// Pitt-Peters three-state dynamic inflow (TASK-098), in dimensional form, so that a stopped rotor is not singular:
/// `M R dv/dt + V L^-1 v = (T/(rho A), M_c/(rho A R), M_s/(rho A R))`. Each state relaxes exactly towards its
/// quasi-steady target, which is stable at any step.
#[derive(Clone, Copy, Debug)]
pub struct DynamicInflow {
    rho_area: f64,
    radius_m: f64,
    limit_mps: f64,
    /// A manual time constant, s; 0 asks for the derived one.
    manual_tau_s: f64,
}

impl DynamicInflow {
    /// Validates rho [0.05,2] kg/m3, disk radius m, a manual time constant (0 for the derived one) and the velocity bound m/s.
    pub fn new(rho: f64, radius_m: f64, manual_tau_s: f64, limit_mps: f64) -> Result<Self, InflowError> {
        if ![rho, radius_m, manual_tau_s, limit_mps].iter().all(|v| v.is_finite())
            || !(0.05..=2.0).contains(&rho)
            || radius_m <= 0.0
            || manual_tau_s < 0.0
            || limit_mps <= 0.0
        {
            return Err(InflowError);
        }
        Ok(Self { rho_area: rho * std::f64::consts::PI * radius_m * radius_m, radius_m, limit_mps, manual_tau_s })
    }

    /// One step from `states`. `moment_cos_nm` and `moment_sin_nm` are the first harmonics of the thrust moment:
    /// the sums of `r f_z cos(psi)` and `r f_z sin(psi)` (`RotorWrench::flap_load_nm` y and z). `loss` is the
    /// annular solve's ratio of mean inflow to Glauert's root; `tip_speed_mps` sets the advance ratio.
    #[allow(clippy::too_many_arguments)]
    pub fn step(&self, states: InflowStates, loss: f64, thrust_n: f64, moment_cos_nm: f64, moment_sin_nm: f64,
        air_hub_mps: crate::Vec3, tip_speed_mps: f64, dt_s: f64) -> Result<DynamicInflowReport, InflowError> {
        if ![states.mean_mps, states.cos_mps, states.sin_mps, loss, thrust_n, moment_cos_nm, moment_sin_nm, air_hub_mps.x, air_hub_mps.y, air_hub_mps.z, tip_speed_mps, dt_s]
            .iter().all(|v| v.is_finite()) || dt_s <= 0.0 || dt_s > 0.01 || loss <= 0.0 || tip_speed_mps < 0.0 {
            return Err(InflowError);
        }
        let sign = if thrust_n < 0.0 { -1.0 } else { 1.0 };
        let climb = -air_hub_mps.z * sign;
        let transverse = (air_hub_mps.x * air_hub_mps.x + air_hub_mps.y * air_hub_mps.y).sqrt();
        let loading = thrust_n.abs() / (2.0 * self.rho_area);
        let (root, converged) = glauert_root(loading, climb, transverse, states.mean_mps * sign / loss);
        let flow = climb + root;
        let w = (transverse * transverse + flow * flow).sqrt();
        let half_skew = if w > 0.0 { transverse / (w + flow.abs()) } else { 0.0 };
        let harmonic_flow = if w > 0.0 { (transverse * transverse + (flow * (climb + 2.0 * root)).abs()) / w } else { 0.0 };
        // Wind axes: the longitudinal axis points downwind, where the wake skews and the inflow is larger.
        let (dx, dy) = if transverse > 0.0 { (air_hub_mps.x / transverse, air_hub_mps.y / transverse) } else { (1.0, 0.0) };
        let force_scale = 1.0 / (self.rho_area * self.radius_m);
        let (force_cos, force_sin) = (moment_cos_nm * force_scale, moment_sin_nm * force_scale);
        let force_long = force_cos * dx + force_sin * dy;
        let force_lat = -force_cos * dy + force_sin * dx;
        let thrust_force = thrust_n / self.rho_area;
        let coupling = 15.0 * std::f64::consts::PI / 64.0 * half_skew;
        let (long_gain, lat_gain) = (2.0 * (1.0 - half_skew * half_skew), 2.0 * (1.0 + half_skew * half_skew));
        // The quasi-steady states are L V^-1 F, with V = diag(W, V, V): the thrust's coupling divides by W, the moments' by V.
        let thrust_over_w = if w > 0.0 { thrust_force / w } else { 0.0 };
        let (long_over_v, lat_over_v) = if harmonic_flow > 0.0 { (force_long / harmonic_flow, force_lat / harmonic_flow) } else { (0.0, 0.0) };
        let mean_coupling = coupling * long_over_v;
        let (target_long, target_lat) = (coupling * thrust_over_w + long_gain * long_over_v, lat_gain * lat_over_v);
        let limit = self.limit_mps;
        let raw_mean = sign * loss * root + mean_coupling;
        let targets = InflowStates {
            mean_mps: raw_mean.clamp(-limit, limit),
            cos_mps: (target_long * dx - target_lat * dy).clamp(-limit, limit),
            sin_mps: (target_long * dy + target_lat * dx).clamp(-limit, limit),
        };
        // The mean's linearized time constant, M0 R/(4 v) in hover, and the harmonics' M2 R 2/V.
        let mean_slope = if w > 0.0 { 2.0 * (w + root * flow.abs() / w) } else { 0.0 };
        let cap = MAX_DERIVED_TAU_S;
        let (tau, tau_harmonic) = if self.manual_tau_s > 0.0 {
            (self.manual_tau_s, self.manual_tau_s)
        } else {
            let derived = |numerator: f64, slope: f64| if slope * cap > numerator { numerator / slope } else { cap };
            (derived(MASS_MEAN * self.radius_m, mean_slope), derived(MASS_HARMONIC * self.radius_m * 2.0, harmonic_flow))
        };
        let (keep, keep_harmonic) = ((-dt_s / tau).exp(), (-dt_s / tau_harmonic).exp());
        let next = InflowStates {
            mean_mps: targets.mean_mps + (states.mean_mps - targets.mean_mps) * keep,
            cos_mps: targets.cos_mps + (states.cos_mps - targets.cos_mps) * keep_harmonic,
            sin_mps: targets.sin_mps + (states.sin_mps - targets.sin_mps) * keep_harmonic,
        };
        if !(next.mean_mps.is_finite() && next.cos_mps.is_finite() && next.sin_mps.is_finite()) {
            return Err(InflowError);
        }
        let advance = if tip_speed_mps > 0.0 { transverse / tip_speed_mps } else if transverse > 0.0 { f64::INFINITY } else { 0.0 };
        let outside_validity = !converged || (thrust_n != 0.0 && climb < 0.0) || advance > MAX_ADVANCE_RATIO
            || raw_mean.abs() > limit;
        Ok(DynamicInflowReport { states: next, targets, tau_s: tau, glauert_root_mps: root, relaxation: 1.0 - keep, outside_validity })
    }
}

/// The annular momentum balance of one rotor (TASK-098): the fixed geometry of its strips.
#[derive(Clone, Copy, Debug)]
pub struct AnnularMomentum<'a> {
    /// Blades.
    pub blade_count: u32,
    /// Tip radius, m.
    pub radius_m: f64,
    /// Inner radius of the blade, m.
    pub cutout_m: f64,
    /// Strip midpoints, m.
    pub strip_radius_m: &'a [f64],
    /// Strip widths, m.
    pub strip_width_m: &'a [f64],
}

/// What the annular balance gives for one step.
#[derive(Clone, Copy, Debug)]
pub struct AnnularSolution {
    /// The area-weighted mean of the annular inflow, m/s.
    pub mean_mps: f64,
    /// False when an annulus reached the iteration cap with a residual above the tolerance.
    pub converged: bool,
}

impl AnnularMomentum<'_> {
    /// Solves `F v W = dT/(4 pi r dr rho)` for each annulus from the azimuth-mean thrust of its strip, by at most
    /// `MAX_MOMENTUM_ITERATIONS` Newton iterations from `inflow_mps`, which it replaces. A strip whose thrust opposes
    /// the rotor's holds 0. `sign` is the rotor's thrust sign, `climb` along it.
    #[allow(clippy::too_many_arguments)]
    pub fn solve(&self, strip_thrust_n: &[f64], rho: f64, omega_rad_s: f64, sign: f64, climb: f64, transverse: f64,
        inflow_mps: &mut [f64]) -> AnnularSolution {
        let n = self.strip_radius_m.len().min(strip_thrust_n.len()).min(inflow_mps.len()).min(self.strip_width_m.len());
        let floor = (-climb).max(0.0);
        let (mut weighted, mut area, mut converged) = (0.0, 0.0, true);
        for k in 0..n {
            let (r, dr) = (self.strip_radius_m[k], self.strip_width_m[k]);
            let target = (sign * strip_thrust_n[k]) / (4.0 * std::f64::consts::PI * r * dr * rho);
            area += r * dr;
            if !(target > 0.0) {
                inflow_mps[k] = 0.0;
                continue;
            }
            let mut v = if inflow_mps[k] > floor { inflow_mps[k] } else { floor + target.sqrt() };
            let mut settled = false;
            // Newton's first iteration holds F; the later ones take the secant, because near the tip F changes quickly with v.
            let mut previous: Option<(f64, f64)> = None;
            for _ in 0..MAX_MOMENTUM_ITERATIONS {
                let flow = climb + v;
                let w = (transverse * transverse + flow * flow).sqrt();
                let swirl = omega_rad_s * r;
                // The helix angle of the wake from the whole flow through and across the annulus.
                let sin_phi = if w > 0.0 { w / (w * w + swirl * swirl).sqrt() } else { 0.0 };
                let f = crate::propeller_bem::prandtl_factor(self.blade_count, r, self.radius_m, self.cutout_m, sin_phi, true, true).max(1e-3);
                let residual = f * v * w - target;
                if residual.abs() <= MOMENTUM_TOLERANCE * target {
                    settled = true;
                    break;
                }
                let held = f * (w + v * flow / w);
                let slope = match previous {
                    Some((last_v, last_residual)) if v != last_v && (residual - last_residual) / (v - last_v) > 0.0 => (residual - last_residual) / (v - last_v),
                    _ => held,
                };
                if !(slope > 0.0) {
                    break;
                }
                previous = Some((v, residual));
                v = (v - residual / slope).max(floor);
            }
            converged &= settled;
            inflow_mps[k] = v;
            weighted += v * r * dr;
        }
        AnnularSolution { mean_mps: if area > 0.0 { weighted / area } else { 0.0 }, converged }
    }
}
