//! Prescribed-state scalar BET, SI hub coordinates; section 3 of engine spec.
use crate::{
    element_force, polar::PolarTable, quadrature::AzimuthGrid, Vec3, MIN_RELATIVE_SPEED_MPS,
};
use std::f64::consts::{PI, TAU};
/// Configuration, non-finite input, or numerical overflow error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RotorError;
/// Borrowed blade geometry. All slices have equal length 1..64.
#[derive(Clone, Copy, Debug)]
pub struct RotorGeometry<'a> {
    /// Number of blades, 1..16.
    pub blade_count: u32,
    /// Right-hand spin sign, +-1.
    pub spin_sign: i32,
    /// Tip radius m.
    pub radius_m: f64,
    /// Inactive root radius m.
    pub cutout_m: f64,
    /// Increasing station radii inside active span, m.
    pub radius: &'a [f64],
    /// Positive chords, m.
    pub chord: &'a [f64],
    /// Twist angles, rad.
    pub twist: &'a [f64],
    /// Positive integration widths summing to tip minus root, m.
    pub width: &'a [f64],
}
/// Prescribed state; a separate free-shaft solver owns RPM dynamics.
#[derive(Clone, Copy, Debug)]
pub struct RotorInput {
    /// Density kg/m³, [0.05,2].
    pub density_kg_m3: f64,
    /// Viscosity Pa s, positive.
    pub viscosity_pa_s: f64,
    /// Sound speed m/s, positive.
    pub sound_speed_mps: f64,
    /// Air minus hub velocity, hub axes m/s.
    pub air_velocity_hub_mps: Vec3,
    /// Body rate in hub axes, rad/s.
    pub body_rate_hub_rad_s: Vec3,
    /// Nonnegative rotor speed rad/s.
    pub omega_rad_s: f64,
    /// Signed induced velocity; positive subtracts hub z, m/s.
    pub induced_mps: f64,
    /// Collective pitch rad.
    pub collective_rad: f64,
    /// Cosine cyclic pitch rad.
    pub cyclic_cos_rad: f64,
    /// Sine cyclic pitch rad.
    pub cyclic_sin_rad: f64,
}
/// Azimuth-averaged aerodynamic output about the hub.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RotorWrench {
    /// Force N.
    pub force_n: Vec3,
    /// Air moment Nm; z is signed Q_air.
    pub moment_nm: Vec3,
    /// Generalized cone/cos/sin loads Nm, unnormalized basis (1,cos,sin).
    pub flap_load_nm: Vec3,
    /// Polar validity flags.
    pub flags: u32,
}
/// Validated rotor with precomputed azimuth nodes; no allocation in evaluate.
#[derive(Clone, Copy, Debug)]
pub struct Rotor<'a> {
    geometry: RotorGeometry<'a>,
    polar: PolarTable<'a>,
    grid: AzimuthGrid,
}
impl<'a> Rotor<'a> {
    /// Validates finite geometry once and constructs the azimuth rule.
    pub fn new(
        g: RotorGeometry<'a>,
        polar: PolarTable<'a>,
        samples: usize,
    ) -> Result<Self, RotorError> {
        let n = g.radius.len();
        if n == 0
            || n > 64
            || g.chord.len() != n
            || g.twist.len() != n
            || g.width.len() != n
            || !(1..=16).contains(&g.blade_count)
            || ![-1, 1].contains(&g.spin_sign)
            || !g.radius_m.is_finite()
            || !g.cutout_m.is_finite()
            || g.cutout_m < 0.0
            || g.radius_m <= g.cutout_m
        {
            return Err(RotorError);
        }
        let (mut previous, mut sum) = (g.cutout_m, 0.0);
        for k in 0..n {
            if !g.radius[k].is_finite()
                || g.radius[k] <= previous
                || g.radius[k] >= g.radius_m
                || !g.chord[k].is_finite()
                || g.chord[k] <= 0.0
                || !g.twist[k].is_finite()
                || !g.width[k].is_finite()
                || g.width[k] <= 0.0
            {
                return Err(RotorError);
            }
            previous = g.radius[k];
            sum += g.width[k];
        }
        if !sum.is_finite() || (sum - (g.radius_m - g.cutout_m)).abs() > 1e-9 {
            return Err(RotorError);
        }
        Ok(Self {
            geometry: g,
            polar,
            grid: AzimuthGrid::new(samples).ok_or(RotorError)?,
        })
    }
    /// Integrates section 3. Invalid states/overflow are errors, never zero-force success.
    pub fn evaluate(&self, i: RotorInput) -> Result<RotorWrench, RotorError> {
        let scalars = [
            i.density_kg_m3,
            i.viscosity_pa_s,
            i.sound_speed_mps,
            i.omega_rad_s,
            i.induced_mps,
            i.collective_rad,
            i.cyclic_cos_rad,
            i.cyclic_sin_rad,
            i.air_velocity_hub_mps.x,
            i.air_velocity_hub_mps.y,
            i.air_velocity_hub_mps.z,
            i.body_rate_hub_rad_s.x,
            i.body_rate_hub_rad_s.y,
            i.body_rate_hub_rad_s.z,
        ];
        if !scalars.iter().all(|x| x.is_finite())
            || !(0.05..=2.0).contains(&i.density_kg_m3)
            || i.viscosity_pa_s <= 0.0
            || i.sound_speed_mps <= 0.0
            || i.omega_rad_s < 0.0
        {
            return Err(RotorError);
        }
        let zero = Vec3::new(0.0, 0.0, 0.0);
        let mut out = RotorWrench {
            force_n: zero,
            moment_nm: zero,
            flap_load_nm: zero,
            flags: 0,
        };
        let g = self.geometry;
        let spin = g.spin_sign as f64;
        let weight = g.blade_count as f64 / self.grid.len() as f64;
        for j in 0..self.grid.len() {
            let (c, s) = self.grid.sample(j).ok_or(RotorError)?;
            let er = Vec3::new(c, s, 0.0);
            let et = Vec3::new(-spin * s, spin * c, 0.0);
            for k in 0..g.radius.len() {
                let r = er.scale(g.radius[k]);
                let v = i
                    .air_velocity_hub_mps
                    .add(i.body_rate_hub_rad_s.cross(r).scale(-1.0))
                    .add(et.scale(-i.omega_rad_s * g.radius[k]))
                    .add(Vec3::new(0.0, 0.0, -i.induced_mps));
                let perpendicular = v.add(er.scale(-v.dot(er)));
                let speed = perpendicular.norm();
                if speed < MIN_RELATIVE_SPEED_MPS {
                    continue;
                }
                let phi = (-perpendicular.z).atan2(-perpendicular.dot(et));
                let alpha =
                    (i.collective_rad + g.twist[k] + i.cyclic_cos_rad * c + i.cyclic_sin_rad * s
                        - phi
                        + PI)
                        .rem_euclid(TAU)
                        - PI;
                let p = self.polar.lookup(
                    alpha,
                    i.density_kg_m3 * speed * g.chord[k] / i.viscosity_pa_s,
                    speed / i.sound_speed_mps,
                );
                let f = element_force(
                    i.density_kg_m3,
                    g.chord[k],
                    g.width[k],
                    perpendicular,
                    er,
                    spin,
                    p.cl,
                    p.cd,
                )
                .scale(weight);
                out.force_n = out.force_n.add(f);
                out.moment_nm = out.moment_nm.add(r.cross(f));
                out.flap_load_nm = out
                    .flap_load_nm
                    .add(Vec3::new(1.0, c, s).scale(g.radius[k] * f.z));
                out.flags |= p.flags;
            }
        }
        if !out.force_n.norm().is_finite()
            || !out.moment_nm.norm().is_finite()
            || !out.flap_load_nm.norm().is_finite()
        {
            return Err(RotorError);
        }
        Ok(out)
    }

    /// Number of azimuth samples of the full rule.
    pub fn azimuth_samples(&self) -> usize {
        self.grid.len()
    }

    /// The production kernel (TASK-091): the same integral as `evaluate`, which
    /// stays the scalar reference, with bit-identical results. The polar
    /// lookups share one prepared state (`PolarTable::prepare`), the angle of
    /// attack wraps without `fmod` (`wrap_angle`), and the element speed is
    /// taken once. Configurations without kernel options run it.
    pub fn evaluate_fast(&self, i: RotorInput) -> Result<RotorWrench, RotorError> {
        let scalars = [
            i.density_kg_m3,
            i.viscosity_pa_s,
            i.sound_speed_mps,
            i.omega_rad_s,
            i.induced_mps,
            i.collective_rad,
            i.cyclic_cos_rad,
            i.cyclic_sin_rad,
            i.air_velocity_hub_mps.x,
            i.air_velocity_hub_mps.y,
            i.air_velocity_hub_mps.z,
            i.body_rate_hub_rad_s.x,
            i.body_rate_hub_rad_s.y,
            i.body_rate_hub_rad_s.z,
        ];
        if !scalars.iter().all(|x| x.is_finite())
            || !(0.05..=2.0).contains(&i.density_kg_m3)
            || i.viscosity_pa_s <= 0.0
            || i.sound_speed_mps <= 0.0
            || i.omega_rad_s < 0.0
        {
            return Err(RotorError);
        }
        let zero = Vec3::new(0.0, 0.0, 0.0);
        let mut out = RotorWrench {
            force_n: zero,
            moment_nm: zero,
            flap_load_nm: zero,
            flags: 0,
        };
        let g = self.geometry;
        let polar = self.polar.prepare();
        let spin = g.spin_sign as f64;
        let weight = g.blade_count as f64 / self.grid.len() as f64;
        for j in 0..self.grid.len() {
            let (c, s) = self.grid.sample(j).ok_or(RotorError)?;
            let er = Vec3::new(c, s, 0.0);
            let et = Vec3::new(-spin * s, spin * c, 0.0);
            for k in 0..g.radius.len() {
                let r = er.scale(g.radius[k]);
                let v = i
                    .air_velocity_hub_mps
                    .add(i.body_rate_hub_rad_s.cross(r).scale(-1.0))
                    .add(et.scale(-i.omega_rad_s * g.radius[k]))
                    .add(Vec3::new(0.0, 0.0, -i.induced_mps));
                let perpendicular = v.add(er.scale(-v.dot(er)));
                let speed = perpendicular.norm();
                if speed < MIN_RELATIVE_SPEED_MPS {
                    continue;
                }
                let phi = (-perpendicular.z).atan2(-perpendicular.dot(et));
                let alpha = wrap_angle(
                    i.collective_rad + g.twist[k] + i.cyclic_cos_rad * c + i.cyclic_sin_rad * s
                        - phi
                        + PI,
                ) - PI;
                let p = polar.lookup(
                    alpha,
                    i.density_kg_m3 * speed * g.chord[k] / i.viscosity_pa_s,
                    speed / i.sound_speed_mps,
                );
                let f = element_force_at_speed(
                    i.density_kg_m3,
                    g.chord[k],
                    g.width[k],
                    perpendicular,
                    speed,
                    er,
                    spin,
                    p.cl,
                    p.cd,
                )
                .scale(weight);
                out.force_n = out.force_n.add(f);
                out.moment_nm = out.moment_nm.add(r.cross(f));
                out.flap_load_nm = out
                    .flap_load_nm
                    .add(Vec3::new(1.0, c, s).scale(g.radius[k] * f.z));
                out.flags |= p.flags;
            }
        }
        if !out.force_n.norm().is_finite()
            || !out.moment_nm.norm().is_finite()
            || !out.flap_load_nm.norm().is_finite()
        {
            return Err(RotorError);
        }
        Ok(out)
    }

    /// The kernel of the TASK-091 opt-in configurations, on every `stride`-th
    /// azimuth sample from sample 0, each weighted by the blade count over the
    /// samples used; a stride that does not divide the sample count is an
    /// error. It agrees with `evaluate` within the declared tolerance T1 (1e-12
    /// relative, flags identical) at a stride of 1: each element's relative
    /// velocity is resolved on the tangential direction and the axis only,
    /// where the cross products of `element_force` reduce to scalar products;
    /// per-strip and per-azimuth factors are formed once and four sums per
    /// azimuth are rotated into the loads; the polar lookups are those of
    /// `evaluate_fast`.
    pub fn evaluate_sampled(&self, i: RotorInput, stride: usize) -> Result<RotorWrench, RotorError> {
        if stride == 0 || self.grid.len() % stride != 0 {
            return Err(RotorError);
        }
        let scalars = [
            i.density_kg_m3,
            i.viscosity_pa_s,
            i.sound_speed_mps,
            i.omega_rad_s,
            i.induced_mps,
            i.collective_rad,
            i.cyclic_cos_rad,
            i.cyclic_sin_rad,
            i.air_velocity_hub_mps.x,
            i.air_velocity_hub_mps.y,
            i.air_velocity_hub_mps.z,
            i.body_rate_hub_rad_s.x,
            i.body_rate_hub_rad_s.y,
            i.body_rate_hub_rad_s.z,
        ];
        if !scalars.iter().all(|x| x.is_finite())
            || !(0.05..=2.0).contains(&i.density_kg_m3)
            || i.viscosity_pa_s <= 0.0
            || i.sound_speed_mps <= 0.0
            || i.omega_rad_s < 0.0
        {
            return Err(RotorError);
        }
        let zero = Vec3::new(0.0, 0.0, 0.0);
        let mut out = RotorWrench {
            force_n: zero,
            moment_nm: zero,
            flap_load_nm: zero,
            flags: 0,
        };
        let g = self.geometry;
        let polar = self.polar.prepare();
        let spin = g.spin_sign as f64;
        let weight = g.blade_count as f64 / (self.grid.len() / stride) as f64;
        // Per-strip factors: Re = (rho c / mu) U and the element force over U, 1/2 rho c dr weight.
        let n = g.radius.len();
        let (mut reynolds_per_speed, mut force_per_speed) = ([0.0; 64], [0.0; 64]);
        for k in 0..n {
            reynolds_per_speed[k] = i.density_kg_m3 * g.chord[k] / i.viscosity_pa_s;
            force_per_speed[k] = 0.5 * i.density_kg_m3 * g.chord[k] * g.width[k] * weight;
        }
        let inverse_sound = 1.0 / i.sound_speed_mps;
        let (air, rate) = (i.air_velocity_hub_mps, i.body_rate_hub_rad_s);
        let axial_air = air.z - i.induced_mps;
        let z = Vec3::new(0.0, 0.0, 1.0);
        for j in (0..self.grid.len()).step_by(stride) {
            let (c, s) = self.grid.sample(j).ok_or(RotorError)?;
            let er = Vec3::new(c, s, 0.0);
            let et = Vec3::new(-spin * s, spin * c, 0.0);
            // The element's in-plane relative velocity lies in span(et, z): u_t = v.et and u_z = v.z,
            // with v = air - rate x (r er) - omega r et - induced z, linear in r along each azimuth.
            let swept = rate.cross(er);
            let (air_t, per_radius_t, per_radius_z) = (air.dot(et), swept.dot(et) + i.omega_rad_s, swept.z);
            let pitch = i.collective_rad + i.cyclic_cos_rad * c + i.cyclic_sin_rad * s;
            // Sums along the blade of the element force on et and z and of their moments.
            let (mut force_t, mut force_z, mut moment_t, mut moment_z) = (0.0, 0.0, 0.0, 0.0);
            for k in 0..n {
                let r = g.radius[k];
                let (u_t, u_z) = (air_t - r * per_radius_t, axial_air - r * per_radius_z);
                let speed = crate::sqrt(u_t * u_t + u_z * u_z);
                if speed < MIN_RELATIVE_SPEED_MPS {
                    continue;
                }
                let phi = (-u_z).atan2(-u_t);
                let alpha = wrap_angle(pitch + g.twist[k] - phi + PI) - PI;
                let p = polar.lookup(alpha, reynolds_per_speed[k] * speed, speed * inverse_sound);
                out.flags |= p.flags;
                // A NaN speed contributes flags only, as in `element_force`.
                if !(speed >= MIN_RELATIVE_SPEED_MPS) {
                    continue;
                }
                // Drag along (u_t, u_z)/U, lift along (u_z, -u_t)/U (spin x (d x e_r)); q/U = force_per_speed U.
                let q = force_per_speed[k] * speed;
                let (f_t, f_z) = (q * (p.cl * u_z + p.cd * u_t), q * (p.cd * u_z - p.cl * u_t));
                force_t += f_t;
                force_z += f_z;
                moment_t += r * f_t;
                moment_z += r * f_z;
            }
            // r er x (f_t et + f_z z) = spin r f_t z - spin r f_z et; flap loads (1, c, s) r f_z.
            out.force_n = out.force_n.add(et.scale(force_t)).add(z.scale(force_z));
            out.moment_nm = out.moment_nm.add(z.scale(spin * moment_t)).add(et.scale(-spin * moment_z));
            out.flap_load_nm = out.flap_load_nm.add(Vec3::new(1.0, c, s).scale(moment_z));
        }
        if !out.force_n.norm().is_finite()
            || !out.moment_nm.norm().is_finite()
            || !out.flap_load_nm.norm().is_finite()
        {
            return Err(RotorError);
        }
        Ok(out)
    }
}

/// `x.rem_euclid(TAU)` with the same bits. On [TAU, 2·TAU) the subtraction is
/// exact (Sterbenz), as is `fmod`; on (-TAU, 0) `rem_euclid` itself adds TAU to
/// the exact `fmod` result x. Any other x falls back to `rem_euclid`.
#[inline]
pub fn wrap_angle(x: f64) -> f64 {
    if (0.0..TAU).contains(&x) {
        x
    } else if (TAU..2.0 * TAU).contains(&x) {
        x - TAU
    } else if x < 0.0 && x > -TAU {
        x + TAU
    } else {
        x.rem_euclid(TAU)
    }
}

/// `element_force` for a `v_perp_mps` whose norm the caller already holds;
/// the same operations in the same order.
#[allow(clippy::too_many_arguments)]
#[inline]
fn element_force_at_speed(
    density_kg_m3: f64,
    chord_m: f64,
    dr_m: f64,
    v_perp_mps: Vec3,
    speed: f64,
    e_r: Vec3,
    spin_sign: f64,
    cl: f64,
    cd: f64,
) -> Vec3 {
    if !(speed >= MIN_RELATIVE_SPEED_MPS) {
        return Vec3::new(0.0, 0.0, 0.0);
    }
    let drag_dir = v_perp_mps.scale(1.0 / speed);
    let lift_dir = drag_dir.cross(e_r).scale(spin_sign);
    let q_area = 0.5 * density_kg_m3 * speed * speed * chord_m * dr_m;
    lift_dir.scale(q_area * cl).add(drag_dir.scale(q_area * cd))
}
