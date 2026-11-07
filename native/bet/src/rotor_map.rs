//! Rotor lookup-table mode (TASK-103), tier A of the fidelity tiers: the loads of a rotor from a table of
//! non-dimensional coefficients instead of the blade-element kernel, on the same arena, records, shaft and ESC drive.
//! Multilinear in five axes (advance ratio, airflow angle, tip Mach, Reynolds scale, collective), so a step costs a fixed number of
//! reads and allocates nothing. The contract is in docs/SPECS_SIMULATION_ENGINES.md, "Rotor lookup-table mode".
use crate::{bound::{self, Advanced}, motor::DriveTorque, shaft::Shaft, Vec3};

/// Configuration version of a table rotor; versions 1 to 5 are the BET rotor's.
pub const CONFIG_VERSION: u32 = 6;
/// Values per table point: cT, cH, cQ, cR, cM, cP, validity.
pub const OUTPUTS: usize = 7;
/// Points on one axis.
pub const MAX_AXIS: usize = 64;
/// Points in a table.
pub const MAX_POINTS: usize = 32768;
/// How far past an axis a query counts as on it: the rounding of the query's own arithmetic. Every axis is of order 1.
const ROUNDING: f64 = 1e-9;
/// Output flag: a query outside an axis, or with cyclic pitch, which no axis holds; it was clamped to the edge.
pub const FLAG_EDGE: u32 = 512;
/// Output flag bit 3, shared with the BET rotor: outside validity.
const FLAG_OUTSIDE_VALIDITY: u32 = 8;
/// Output flag bit 4, shared with the BET rotor: the shaft's reverse limit acted.
const FLAG_REVERSE_LIMITED: u32 = 16;

/// A parsed table on the configuration's bytes.
#[derive(Clone, Copy)]
pub struct RotorMap<'a> {
    spin: f64,
    spin_sign: i32,
    radius_m: f64,
    inertia: f64,
    damping: f64,
    dt: f64,
    initial: f64,
    /// The table's density times speed of sound over viscosity: the 1 of the Reynolds scale.
    reference: f64,
    advance: &'a [f64],
    angle: &'a [f64],
    mach: &'a [f64],
    reynolds: &'a [f64],
    collective: &'a [f64],
    values: &'a [f64],
}

fn increasing(axis: &[f64]) -> bool {
    !axis.is_empty() && axis.iter().all(|v| v.is_finite()) && axis.windows(2).all(|w| w[1] > w[0])
}

/// Reads a configuration. `full` also validates every axis and value; a step skips that, because initialization did it.
pub fn parse(b: &[u8], full: bool) -> Result<RotorMap<'_>, i32> {
    let parsed = || {
        if bound::u(b, 0)? != CONFIG_VERSION || b.len() < bound::CONFIG_HEADER || bound::u(b, 4)? as usize != b.len() { return None; }
        let (na, nb, nc, nr, nd) = (bound::u(b, 8)? as usize, bound::u(b, 12)? as usize, bound::u(b, 16)? as usize, bound::u(b, 20)? as usize, bound::u(b, 24)? as usize);
        if ![na, nb, nc, nr, nd].iter().all(|n| (1..=MAX_AXIS).contains(n)) { return None; }
        let count = na.checked_mul(nb)?.checked_mul(nc)?.checked_mul(nr)?.checked_mul(nd)?;
        if count > MAX_POINTS || b.len() != bound::CONFIG_HEADER + (na + nb + nc + nr + nd + count * OUTPUTS) * 8 { return None; }
        if !bound::zero(b, 48, 56) || !bound::zero(b, 88, 128) { return None; }
        let spin_sign = bound::u(b, 28)? as i32;
        if spin_sign != 1 && spin_sign != -1 { return None; }
        let mut at = bound::CONFIG_HEADER;
        let mut take = |n: usize| { let values = bound::doubles(b, at, n); at += n * 8; values };
        let (advance, angle, mach, reynolds, collective) = (take(na)?, take(nb)?, take(nc)?, take(nr)?, take(nd)?);
        let values = take(count * OUTPUTS)?;
        let (reference, radius_m, inertia, damping, dt, initial) = (bound::f(b, 32)?, bound::f(b, 40)?, bound::f(b, 56)?, bound::f(b, 64)?, bound::f(b, 72)?, bound::f(b, 80)?);
        if full {
            if !radius_m.is_finite() || radius_m <= 0.0 || !initial.is_finite() || initial < 0.0 || !reference.is_finite() || reference <= 0.0
                || ![400.0, 800.0, 1200.0, 4800.0].iter().any(|hz| dt == 1.0 / hz) { return None; }
            Shaft::new(inertia, damping, spin_sign).ok()?;
            if !increasing(advance) || !increasing(angle) || !increasing(mach) || !increasing(reynolds) || !increasing(collective)
                || advance[0] < 0.0 || mach[0] < 0.0 || reynolds[0] <= 0.0
                || angle[0] < -core::f64::consts::FRAC_PI_2 || angle[nb - 1] > core::f64::consts::FRAC_PI_2 { return None; }
            for point in values.chunks_exact(OUTPUTS) {
                if !point.iter().all(|v| v.is_finite()) || !(0.0..=1.0).contains(&point[OUTPUTS - 1]) { return None; }
            }
        }
        Some(RotorMap { spin: f64::from(spin_sign), spin_sign, radius_m, inertia, damping, dt, initial, reference, advance, angle, mach, reynolds, collective, values })
    };
    parsed().ok_or(-3)
}

/// The cell of `x` on `axis`: its lower index and fraction, clamped, and whether `x` lay outside.
fn bracket(axis: &[f64], x: f64) -> (usize, f64, bool) {
    let n = axis.len();
    if n == 1 { return (0, 0.0, (x - axis[0]).abs() > ROUNDING); }
    if x <= axis[0] { return (0, 0.0, x < axis[0] - ROUNDING); }
    if x >= axis[n - 1] { return (n - 2, 1.0, x > axis[n - 1] + ROUNDING); }
    let (mut lo, mut hi) = (0, n - 1);
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        if axis[mid] <= x { lo = mid; } else { hi = mid; }
    }
    (lo, (x - axis[lo]) / (axis[lo + 1] - axis[lo]), false)
}

/// The rotor's loads at one query.
#[derive(Clone, Copy)]
struct Loads { force: Vec3, moment: Vec3, edge: bool, unvalidated: bool }

struct Query { density: f64, viscosity: f64, sound: f64, air: Vec3, omega: f64, collective: f64, cyclic: bool }

impl RotorMap<'_> {
    fn loads(&self, q: &Query) -> Loads {
        let zero = Vec3::new(0.0, 0.0, 0.0);
        let across = q.air.x.hypot(q.air.y);
        let speed = across.hypot(q.air.z);
        if q.omega <= 0.0 {
            // A stopped rotor gives no load the table can scale; with air moving, that is outside the table.
            return Loads { force: zero, moment: zero, edge: speed > 0.0 || q.cyclic, unvalidated: false };
        }
        let tip = q.omega * self.radius_m;
        let (j, ja, j_out) = bracket(self.advance, speed / tip);
        // At zero advance ratio the angle does not matter.
        let (a, aa, a_out) = bracket(self.angle, if speed > 0.0 { (-q.air.z).atan2(across) } else { self.angle[0].max(0.0).min(self.angle[self.angle.len() - 1]) });
        let (m, ma, m_out) = bracket(self.mach, tip / q.sound);
        // Mach and this scale together fix the blade's Reynolds number, whichever of density, speed of sound and viscosity moved.
        let (r, ra, r_out) = bracket(self.reynolds, q.density * q.sound / q.viscosity / self.reference);
        let (c, ca, c_out) = bracket(self.collective, q.collective);
        let (nb, nc, nr, nd) = (self.angle.len(), self.mach.len(), self.reynolds.len(), self.collective.len());
        let mut sum = [0.0; OUTPUTS];
        for corner in 0..32usize {
            let weight = (if corner & 1 != 0 { ja } else { 1.0 - ja }) * (if corner & 2 != 0 { aa } else { 1.0 - aa })
                * (if corner & 4 != 0 { ma } else { 1.0 - ma }) * (if corner & 8 != 0 { ra } else { 1.0 - ra }) * (if corner & 16 != 0 { ca } else { 1.0 - ca });
            // A one-point axis, and a clamped end, have nothing above them: their weight is zero.
            if weight == 0.0 { continue; }
            let index = (((((j + (corner & 1)) * nb + a + ((corner >> 1) & 1)) * nc + m + ((corner >> 2) & 1)) * nr + r + ((corner >> 3) & 1)) * nd + c + ((corner >> 4) & 1)) * OUTPUTS;
            for (total, value) in sum.iter_mut().zip(&self.values[index..index + OUTPUTS]) { *total += weight * value; }
        }
        let scale = q.density * q.omega * q.omega * self.radius_m.powi(4);
        let moment_scale = scale * self.radius_m;
        let (cos, sin) = if across > 0.0 { (q.air.x / across, q.air.y / across) } else { (1.0, 0.0) };
        let (h, roll, pitch) = (sum[1] * scale, sum[3] * moment_scale * self.spin, sum[4] * moment_scale);
        Loads {
            force: Vec3::new(h * cos, h * sin, sum[0] * scale),
            moment: Vec3::new(roll * cos - pitch * sin, roll * sin + pitch * cos, sum[2] * moment_scale * self.spin),
            edge: j_out || (speed > 0.0 && a_out) || m_out || r_out || c_out || q.cyclic,
            // The weights sum to 1 only within rounding, so validity 1 interpolates to just below it.
            unvalidated: sum[OUTPUTS - 1] < 1.0 - 1e-9,
        }
    }

    /// Initial shaft speed, rad/s.
    pub fn initial(&self) -> f64 { self.initial }
}

/// One step of a table rotor, with the BET rotor's midpoint rule on the shaft. Writes nothing.
pub(crate) fn advance(state: &[u8], bytes: &[u8], input: &[u8], dt: f64, esc: Option<DriveTorque>) -> Result<Advanced, i32> {
    let map = parse(bytes, false)?;
    if !bound::zero(state, 56, 64) { return Err(-3); }
    if dt.to_bits() != map.dt.to_bits() { return Err(-4); }
    let compute = || {
        let omega = bound::f(state, 16)?;
        let (density, viscosity, sound) = (bound::f(input, 8)?, bound::f(input, 16)?, bound::f(input, 24)?);
        if !density.is_finite() || density <= 0.0 || !viscosity.is_finite() || viscosity <= 0.0 || !sound.is_finite() || sound <= 0.0 { return None; }
        let air = bound::vec(input, 32)?;
        let rate = bound::vec(input, 56)?;
        let (collective, cos, sin, motor) = (bound::f(input, 80)?, bound::f(input, 88)?, bound::f(input, 96)?, bound::f(input, 104)?);
        if ![air.x, air.y, air.z, rate.x, rate.y, rate.z, collective, cos, sin, motor].iter().all(|v| v.is_finite()) { return None; }
        let query = |speed: f64| Query { density, viscosity, sound, air, omega: speed, collective, cyclic: cos != 0.0 || sin != 0.0 };
        let shaft_model = Shaft::new(map.inertia, map.damping, map.spin_sign).ok()?;
        let shaft_step = |q: f64, h: f64| match esc {
            None => shaft_model.step(omega, q, motor, h),
            Some(t) => shaft_model.step_driven(omega, q, t.constant_nm, t.damping, t.friction_nm, h),
        };
        let first = map.loads(&query(omega));
        let half = shaft_step(first.moment.z, dt * 0.5).ok()?;
        let aero = map.loads(&query(half.omega_rad_s));
        let shaft = shaft_step(aero.moment.z, dt).ok()?;
        let h = map.spin * map.inertia * half.omega_rad_s;
        let dh = Vec3::new(0.0, 0.0, map.spin * map.inertia * (shaft.omega_rad_s - omega) / dt).add(rate.cross(Vec3::new(0.0, 0.0, h)));
        let transmitted = aero.moment.add(dh.scale(-1.0));
        let power = match esc { None => motor * omega, Some(t) => (t.constant_nm - t.damping * omega) * omega };
        if !transmitted.norm().is_finite() || !power.is_finite() { return None; }
        // No inflow state; the wake model reads the momentum-theory velocity of this thrust.
        let area = core::f64::consts::PI * map.radius_m * map.radius_m;
        let induced = (aero.force.z.abs() / (2.0 * density * area)).sqrt();
        let edge = first.edge || aero.edge;
        let flags = if edge { FLAG_EDGE | FLAG_OUTSIDE_VALIDITY } else { 0 }
            | if first.unvalidated || aero.unvalidated { FLAG_OUTSIDE_VALIDITY } else { 0 }
            | if shaft.reverse_limited || half.reverse_limited { FLAG_REVERSE_LIMITED } else { 0 };
        let mut staged = [0u8; 128];
        bound::write_vec(&mut staged, 0, aero.force);
        bound::write_vec(&mut staged, 24, aero.moment);
        bound::write_vec(&mut staged, 48, transmitted);
        bound::put(&mut staged, 72, shaft.omega_rad_s);
        bound::put(&mut staged, 80, aero.moment.z);
        bound::put(&mut staged, 88, power);
        bound::put(&mut staged, 96, induced);
        bound::word(&mut staged, 112, flags);
        bound::put(&mut staged, 120, map.spin * map.inertia * shaft.omega_rad_s);
        Some(Advanced { staged, omega: shaft.omega_rad_s, induced, half_omega: half.omega_rad_s, hover_state: None, inflow_state: None, vortex_state: None })
    };
    compute().ok_or(-3)
}
