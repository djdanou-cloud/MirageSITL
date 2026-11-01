//! Prescribed-state scalar BET, SI hub coordinates; section 3 of engine spec.
use crate::{
    element_force,
    polar::{clamp_select, ln_kernel, PolarTable},
    quadrature::AzimuthGrid,
    Vec3, MIN_RELATIVE_SPEED_MPS,
};
use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, FRAC_PI_8, PI, TAU};
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

    /// The default production kernel (TASK-091 increment 3) on every
    /// `stride`-th azimuth sample from sample 0, each weighted by the blade
    /// count over the samples used; a stride that does not divide the sample
    /// count is an error. At a stride of 1 it agrees with `evaluate` within the
    /// declared tolerance T1 (1e-12 relative, flags identical). Each element's
    /// relative velocity is resolved on the tangential direction and the axis
    /// only, where the cross products of `element_force` reduce to scalar
    /// products. Per azimuth sample, a branch-free strip pass that the compiler
    /// vectorizes forms the speed, the angle of attack (`atan2_kernel` and the
    /// exact conditional wrap), the Reynolds and Mach numbers and the Reynolds
    /// logarithm (`ln_kernel`); a pass of `KernelPolar::sample` lookups follows,
    /// each strip's Reynolds bracket starting from its bracket at the previous
    /// sample, with four sums along the blade rotated into the force, moment and
    /// flapping loads. Tables `KernelPolar` cannot serve, non-finite
    /// intermediates and angles outside the conditional wrap fall back to
    /// `evaluate_resolved`, the increment 2 kernel.
    pub fn evaluate_sampled(&self, i: RotorInput, stride: usize) -> Result<RotorWrench, RotorError> {
        if stride == 0 || self.grid.len() % stride != 0 {
            return Err(RotorError);
        }
        let polar = self.polar.prepare_kernel();
        if !polar.usable() {
            return self.evaluate_resolved(i, stride);
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
        let n = g.radius.len().min(MAX_STRIPS);
        let (radius, twist) = (&g.radius[..n], &g.twist[..n]);
        let spin = g.spin_sign as f64;
        let weight = g.blade_count as f64 / (self.grid.len() / stride) as f64;
        // Per-strip factors: Re = (rho c / mu) U and the element force over U, 1/2 rho c dr weight.
        let (mut reynolds_per_speed, mut force_per_speed) = ([0.0; MAX_STRIPS], [0.0; MAX_STRIPS]);
        for k in 0..n {
            reynolds_per_speed[k] = i.density_kg_m3 * g.chord[k] / i.viscosity_pa_s;
            force_per_speed[k] = 0.5 * i.density_kg_m3 * g.chord[k] * g.width[k] * weight;
        }
        let inverse_sound = 1.0 / i.sound_speed_mps;
        let (air, rate) = (i.air_velocity_hub_mps, i.body_rate_hub_rad_s);
        let axial_air = air.z - i.induced_mps;
        let z = Vec3::new(0.0, 0.0, 1.0);
        let (re_first, re_last) = polar.reynolds_bounds();
        // Strip pass outputs, and each strip's Reynolds bracket carried across azimuth samples.
        let mut lanes = Lanes::new();
        let mut hint = [usize::MAX; MAX_STRIPS];
        for j in (0..self.grid.len()).step_by(stride) {
            let (c, s) = self.grid.sample(j).ok_or(RotorError)?;
            let et = Vec3::new(-spin * s, spin * c, 0.0);
            let swept = rate.cross(Vec3::new(c, s, 0.0));
            let (air_t, per_radius_t, per_radius_z) = (air.dot(et), swept.dot(et) + i.omega_rad_s, swept.z);
            let pitch = i.collective_rad + i.cyclic_cos_rad * c + i.cyclic_sin_rad * s;
            // Pass 1, branch-free so that it vectorizes, in two loops that each keep their constants in
            // registers: velocity, speed and angle of attack; then Re, Mach and ln Re.
            let mut regular = true;
            for k in 0..n {
                let r = radius[k];
                let (u_t, u_z) = (air_t - r * per_radius_t, axial_air - r * per_radius_z);
                let speed = crate::sqrt(u_t * u_t + u_z * u_z);
                let x = pitch + twist[k] - atan2_kernel(-u_z, -u_t) + PI;
                // `wrap_angle` on [-TAU, 2 TAU); anything else (or a non-finite value) takes the fallback.
                regular &= (x >= -TAU) & (x < 2.0 * TAU) & (speed <= f64::MAX);
                let wrapped = if x < 0.0 { x + TAU } else if x >= TAU { x - TAU } else { x };
                lanes.u_t[k] = u_t;
                lanes.u_z[k] = u_z;
                lanes.speed[k] = speed;
                lanes.alpha[k] = wrapped - PI;
            }
            for k in 0..n {
                let speed = lanes.speed[k];
                let reynolds = reynolds_per_speed[k] * speed;
                lanes.reynolds[k] = reynolds;
                lanes.ln_reynolds[k] = ln_kernel(clamp_select(reynolds, re_first, re_last));
                lanes.mach[k] = speed * inverse_sound;
            }
            if !regular {
                return self.evaluate_resolved(i, stride);
            }
            // Pass 2: polar lookups and the element force on et and z, summed along the blade with its moments.
            let (mut force_t, mut force_z, mut moment_t, mut moment_z) = (0.0, 0.0, 0.0, 0.0);
            for k in 0..n {
                let speed = lanes.speed[k];
                if !(speed >= MIN_RELATIVE_SPEED_MPS) {
                    continue;
                }
                if hint[k] == usize::MAX {
                    hint[k] = polar.reynolds_guess(lanes.ln_reynolds[k]);
                }
                let p = polar.sample(lanes.alpha[k], lanes.reynolds[k], lanes.ln_reynolds[k], lanes.mach[k], &mut hint[k], out.flags);
                out.flags |= p.flags;
                // Drag along (u_t, u_z)/U, lift along (u_z, -u_t)/U (spin x (d x e_r)); q/U = force_per_speed U.
                let (u_t, u_z, r) = (lanes.u_t[k], lanes.u_z[k], radius[k]);
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

    /// The T1 kernel of TASK-091 increment 2, kept as the fallback of
    /// `evaluate_sampled` for tables `KernelPolar` cannot serve and for steps
    /// with a non-finite intermediate or an angle outside the conditional wrap.
    fn evaluate_resolved(&self, i: RotorInput, stride: usize) -> Result<RotorWrench, RotorError> {
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

/// Most strips of a rotor (`RotorGeometry`).
const MAX_STRIPS: usize = 64;

/// Per-strip results of the strip pass of `evaluate_sampled`.
struct Lanes {
    u_t: [f64; MAX_STRIPS],
    u_z: [f64; MAX_STRIPS],
    speed: [f64; MAX_STRIPS],
    alpha: [f64; MAX_STRIPS],
    reynolds: [f64; MAX_STRIPS],
    ln_reynolds: [f64; MAX_STRIPS],
    mach: [f64; MAX_STRIPS],
}

impl Lanes {
    fn new() -> Self {
        let zero = [0.0; MAX_STRIPS];
        Self { u_t: zero, u_z: zero, speed: zero, alpha: zero, reynolds: zero, ln_reynolds: zero, mach: zero }
    }
}

/// tan(pi/16) and tan(3 pi/16): the bounds between the reduction centres of `atan2_kernel`.
const TAN_PI_16: f64 = 0.198_912_367_379_658_0;
const TAN_3PI_16: f64 = 0.668_178_637_919_298_9;
/// tan(pi/8) = sqrt(2) - 1, the middle reduction centre.
const TAN_PI_8: f64 = 0.414_213_562_373_095_03;

/// `atan2(y, x)` of the TASK-091 production kernel, without branches or calls
/// so that the strip pass vectorizes. With t = min(|x|, |y|) / max(|x|, |y|),
/// atan t = k pi/8 + atan(t'), t' = (t - c)/(1 + c t), c = tan(k pi/8) for the
/// nearest k in {0, 1, 2}, so |t'| <= tan(pi/16); atan(t') is its Taylor series
/// `t' - t'^3/3 + ... - t'^19/19` (exact rational coefficients; the omitted
/// terms sum to below 9e-17 rad). One division forms t' from |x|
/// and |y| directly; the octant and the sign of y then place the angle.
/// Declared accuracy (TASK-091): within 2e-15 rad of `f64::atan2` for finite
/// arguments whose larger magnitude is a normal number. Smaller arguments
/// (both zero included) give a finite angle in the right quadrant only;
/// callers mask those elements by their speed.
#[inline(always)]
pub fn atan2_kernel(y: f64, x: f64) -> f64 {
    let (ax, ay) = (x.abs(), y.abs());
    let swap = ay > ax;
    let (num, den) = if swap { (ax, ay) } else { (ay, ax) };
    let middle = num > TAN_PI_16 * den;
    let upper = num > TAN_3PI_16 * den;
    let c = if upper { 1.0 } else if middle { TAN_PI_8 } else { 0.0 };
    let base = if upper { FRAC_PI_4 } else if middle { FRAC_PI_8 } else { 0.0 };
    // Both zero: 0 / MIN_POSITIVE keeps the angle finite (0, or pi for x = -0), so the
    // element stays on the vectorized path; callers mask it by its speed.
    let divisor = den + c * num;
    let t = (num - c * den) / if divisor < f64::MIN_POSITIVE { f64::MIN_POSITIVE } else { divisor };
    let z = t * t;
    let series = -1.0 / 3.0 + z * (1.0 / 5.0 + z * (-1.0 / 7.0 + z * (1.0 / 9.0 + z * (-1.0 / 11.0
        + z * (1.0 / 13.0 + z * (-1.0 / 15.0 + z * (1.0 / 17.0 + z * (-1.0 / 19.0))))))));
    let octant = base + (t + t * (z * series));
    let quadrant = if swap { FRAC_PI_2 - octant } else { octant };
    let half = if x < 0.0 { PI - quadrant } else { quadrant };
    half.copysign(y)
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
