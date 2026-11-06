//! TASK-100: the rotor ground effect's closed form, and the step that uses it through interface v2.
use mirage_bet::{
    blade::{Rotor, RotorGeometry, RotorInput},
    bound, bound_v2,
    ground_effect::{induced_factor, MIN_HEIGHT_OVER_RADIUS},
    inflow::AxialInflow,
    polar::PolarTable,
    shaft::Shaft,
    Vec3,
};

#[path = "support/neuralfoil.rs"]
mod neuralfoil;

const RADIUS: f64 = 0.127;
const CUTOUT: f64 = 0.0127;
const STRIPS: usize = 16;

fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn word(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
fn get(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }
fn read_word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) }

#[test]
fn the_factor_is_the_closed_form() {
    for (z, tilt_deg, vt, vi) in [(0.5, 0.0, 0.0, 8.0), (1.0, 0.0, 0.0, 8.0), (0.3, 0.0, 2.0, 8.0), (0.3, 20.0, 0.0, 6.0), (1.5, 40.0, 5.0, 3.0), (0.2, 10.0, 12.0, 9.0)] {
        let cos: f64 = f64::to_radians(tilt_deg).cos();
        let e = induced_factor(RADIUS, z * cos, cos, vt, vi);
        let want = 1.0 - (RADIUS / (4.0 * z)).powi(2) * cos / (1.0 + (vt / vi) * (vt / vi));
        assert!((e.factor - want).abs() <= 1e-12, "{z} {tilt_deg}: {} against {want}", e.factor);
        assert!(!e.below_envelope);
    }
    // Hover at one radius: Cheeseman and Bennett's 1/(1 - 1/16).
    let hover = induced_factor(RADIUS, RADIUS, 1.0, 0.0, 8.0);
    assert!((1.0 / hover.factor - 16.0 / 15.0).abs() <= 1e-12);
    // Far from the ground it fades away, and a fast transverse flow carries it away.
    assert!(1.0 - induced_factor(RADIUS, 100.0 * RADIUS, 1.0, 0.0, 8.0).factor < 1e-5);
    assert!(induced_factor(RADIUS, RADIUS, 1.0, 40.0, 4.0).factor > 0.999);
    // Below half a radius it holds its value there, and says so.
    let edge = induced_factor(RADIUS, MIN_HEIGHT_OVER_RADIUS * RADIUS, 1.0, 0.0, 8.0);
    for height in [0.49, 0.2, 0.0, -1.0] {
        let e = induced_factor(RADIUS, height * RADIUS, 1.0, 0.0, 8.0);
        assert!(e.below_envelope, "{height}");
        assert_eq!(e.factor, edge.factor);
    }
    assert!(!edge.below_envelope);
    assert_eq!(edge.factor, 0.75);
    // A disk that does not face the plane gets nothing, and neither does no flow with a transverse speed.
    assert_eq!(induced_factor(RADIUS, RADIUS, 0.0, 0.0, 8.0).factor, 1.0);
    assert_eq!(induced_factor(RADIUS, RADIUS, -0.5, 0.0, 8.0).factor, 1.0);
    assert_eq!(induced_factor(RADIUS, RADIUS, 1.0, 5.0, 0.0).factor, 1.0);
}

fn config(dt: f64, omega: f64) -> Vec<u8> {
    let p = neuralfoil::naca6409(&[0.0, 0.3]);
    let width = (RADIUS - CUTOUT) / STRIPS as f64;
    let r: Vec<f64> = (0..STRIPS).map(|k| CUTOUT + (k as f64 + 0.5) * width).collect();
    let chord: Vec<f64> = r.iter().map(|x| 0.025 - 0.08 * (x - 0.06)).collect();
    let twist: Vec<f64> = r.iter().map(|x| (0.1143 / (2.0 * std::f64::consts::PI * x)).atan()).collect();
    let count = p.alpha.len() * p.re.len() * p.mach.len();
    let tables = 128 + (4 * STRIPS + p.alpha.len() + p.re.len() + p.mach.len() + 3 * count) * 8;
    let mut c = vec![0u8; tables + (3 + STRIPS) * 8];
    let len = c.len() as u32;
    for (at, v) in [(0, bound::CONFIG_VERSION_INFLOW), (4, len), (8, p.alpha.len() as u32), (12, p.re.len() as u32), (16, p.mach.len() as u32), (20, STRIPS as u32), (24, 2), (28, 1), (32, 8), (36, bound::OPTION_DYNAMIC_INFLOW)] {
        word(&mut c, at, v);
    }
    for (at, v) in [(40, RADIUS), (48, CUTOUT), (56, 1.0e3), (64, 0.0), (72, dt), (80, omega), (88, 0.0), (96, 500.0), (104, 0.9)] {
        put(&mut c, at, v);
    }
    let mut at = 128;
    for values in [&r, &chord, &twist, &vec![width; STRIPS], &p.alpha, &p.re, &p.mach, &p.cl, &p.cd, &p.confidence] {
        for v in values.iter() { put(&mut c, at, *v); at += 8; }
    }
    c
}

/// Bytes 16..120 of the v2 record are v1's step fields; these leave still air at sea level and no motor.
fn record(ground: Option<(f64, f64)>) -> Vec<u8> {
    let mut i = vec![0u8; 256];
    word(&mut i, 0, bound_v2::VERSION);
    for (at, v) in [(16, 1.225), (24, 1.7894e-5), (32, 340.294)] { put(&mut i, at, v); }
    if let Some((height, cos)) = ground {
        word(&mut i, 4, bound_v2::INPUT_GROUND_PLANE);
        put(&mut i, 160, (1.0 - cos * cos).sqrt());
        put(&mut i, 176, cos);
        put(&mut i, 184, height);
    }
    i
}

#[test]
fn a_rotor_near_the_ground_gives_more_thrust_at_the_same_speed() {
    let (dt, omega) = (1.0 / 800.0, 700.0);
    let c = config(dt, omega);
    let settle = |ground: Option<(f64, f64)>| {
        let mut a = vec![0u8; 64 + c.len()];
        assert_eq!(bound::init(&c, &mut a, 0), 0);
        let i = record(ground);
        let mut out = [0u8; 256];
        for _ in 0..800 { assert_eq!(bound_v2::step(&mut a, &i, &mut out, dt), 0); }
        out
    };
    let free = settle(None);
    assert_eq!(read_word(&free, 116) & bound_v2::VALID_GROUND_EFFECT, 0);
    let (low, high) = (settle(Some((0.75 * RADIUS, 1.0))), settle(Some((3.0 * RADIUS, 1.0))));
    let thrust = |o: &[u8; 256]| get(o, 16);
    assert!(thrust(&low) > thrust(&high) && thrust(&high) > thrust(&free), "{} {} {}", thrust(&low), thrust(&high), thrust(&free));
    assert_ne!(read_word(&low, 116) & bound_v2::VALID_GROUND_EFFECT, 0);
    assert_eq!(read_word(&low, 112) & 8, 0, "inside the envelope");
    // Below it the flag is up; a tilted disk feels less than a level one at the same height.
    assert_ne!(read_word(&settle(Some((0.3 * RADIUS, 1.0))), 112) & 8, 0);
    assert!(thrust(&settle(Some((0.75 * RADIUS, 0.8)))) < thrust(&low));
    // A plane far away changes almost nothing; a clear flag with a field set stays fail-closed; a normal that is not unit is invalid.
    let far = settle(Some((1000.0, 1.0)));
    assert!((thrust(&far) - thrust(&free)).abs() <= 1e-4 * thrust(&free));
    let mut a = vec![0u8; 64 + c.len()];
    assert_eq!(bound::init(&c, &mut a, 0), 0);
    let mut out = [0u8; 256];
    let mut stray = record(None);
    put(&mut stray, 184, 0.5);
    assert_eq!(bound_v2::step(&mut a, &stray, &mut out, dt), bound_v2::UNSUPPORTED);
    let mut long = record(Some((0.5, 1.0)));
    put(&mut long, 176, 1.1);
    assert_eq!(bound_v2::step(&mut a, &long, &mut out, dt), -3);
}

// An ideal rotor: no drag, a linear lift curve and the fixed-lag axial inflow. Its shaft power is exactly thrust times the
// velocity its blades see, which is the rotor the closed form describes.
const IDEAL_STRIPS: usize = 8;
const IDEAL_ALPHA: [f64; 2] = [-1.5, 1.5];
const IDEAL_RE: [f64; 2] = [1.0e3, 1.0e9];
const IDEAL_MACH: [f64; 2] = [0.0, 1.0];
const IDEAL_CL: [f64; 8] = [-8.55, 8.55, -8.55, 8.55, -8.55, 8.55, -8.55, 8.55];
const IDEAL_CD: [f64; 8] = [0.0; 8];
struct IdealBlade { r: Vec<f64>, chord: Vec<f64>, twist: Vec<f64>, width: Vec<f64> }
fn ideal_blade() -> IdealBlade {
    let width = (RADIUS - CUTOUT) / IDEAL_STRIPS as f64;
    let r: Vec<f64> = (0..IDEAL_STRIPS).map(|k| CUTOUT + (k as f64 + 0.5) * width).collect();
    IdealBlade { chord: vec![0.02; IDEAL_STRIPS], twist: r.iter().map(|x| (0.1143 / (2.0 * std::f64::consts::PI * x)).atan()).collect(), width: vec![width; IDEAL_STRIPS], r }
}
fn ideal_config(dt: f64, omega: f64, inertia: f64, tau: f64) -> Vec<u8> {
    let b = ideal_blade();
    let tables = 128 + (4 * IDEAL_STRIPS + 6 + 3 * 8) * 8;
    let mut c = vec![0u8; tables];
    let len = c.len() as u32;
    for (at, v) in [(0, bound::VERSION), (4, len), (8, 2), (12, 2), (16, 2), (20, IDEAL_STRIPS as u32), (24, 2), (28, 1), (32, 8)] { word(&mut c, at, v); }
    for (at, v) in [(40, RADIUS), (48, CUTOUT), (56, inertia), (64, 0.0), (72, dt), (80, omega), (88, tau), (96, 500.0), (104, 0.9)] { put(&mut c, at, v); }
    let mut at = 128;
    let confidence = [1.0; 8];
    let groups: [&[f64]; 10] = [&b.r, &b.chord, &b.twist, &b.width, &IDEAL_ALPHA, &IDEAL_RE, &IDEAL_MACH, &IDEAL_CL, &IDEAL_CD, &confidence];
    for values in groups { for v in values { put(&mut c, at, *v); at += 8; } }
    c
}
struct Settled { thrust_n: f64, torque_nm: f64, omega: f64, induced_mps: f64 }
fn settled(config: &[u8], input: &[u8], dt: f64, steps: usize) -> Settled {
    let mut a = vec![0u8; 64 + config.len()];
    assert_eq!(bound::init(config, &mut a, 0), 0);
    let mut out = [0u8; 256];
    for _ in 0..steps { assert_eq!(bound_v2::step(&mut a, input, &mut out, dt), 0); }
    Settled { thrust_n: get(&out, 16), torque_nm: get(&out, 80), omega: get(&out, 72), induced_mps: get(&out, 96) }
}

/// The closed form the task's fixtures hold the model to: at one power, thrust grows by 1/k.
#[test]
fn at_the_same_power_the_thrust_ratio_is_the_closed_form() {
    let (dt, tau, steps) = (1.0 / 800.0, 0.002, 400);
    let free = settled(&ideal_config(dt, 700.0, 1.0e9, tau), &record(None), dt, steps);
    let power = free.omega * free.torque_nm.abs();
    assert!(free.thrust_n > 0.5, "{}", free.thrust_n);
    // The ideal rotor's own identity, which the comparison leans on.
    assert!((power / (free.thrust_n * free.induced_mps) - 1.0).abs() <= 1e-9, "{power} {}", free.thrust_n * free.induced_mps);
    for (z, tilt_deg) in [(0.6, 0.0), (0.75, 0.0), (1.0, 0.0), (2.0, 0.0), (4.0, 0.0), (0.75, 20.0), (1.0, 35.0), (2.0, 50.0)] {
        let cos = f64::to_radians(tilt_deg).cos();
        let height = z * RADIUS * cos;
        let mut omega = 700.0;
        let mut now = free_of_ground_placeholder();
        for _ in 0..6 {
            now = settled(&ideal_config(dt, omega, 1.0e9, tau), &record(Some((height, cos))), dt, steps);
            omega *= (power / (now.omega * now.torque_nm.abs())).cbrt();
        }
        assert!((now.omega * now.torque_nm.abs() / power - 1.0).abs() <= 1e-10);
        let factor = induced_factor(RADIUS, height, cos, 0.0, now.induced_mps).factor;
        let (ratio, want) = (now.thrust_n / free.thrust_n, 1.0 / factor);
        println!("z/R {z} tilt {tilt_deg}: thrust ratio {ratio:.12}, closed form {want:.12}");
        assert!((ratio - want).abs() <= 1e-9, "z/R {z} tilt {tilt_deg}: {ratio} against {want}");
    }
    // In a transverse flow the shaft power also pays for the in-plane force, so the balance is on the induced power.
    for (z, speed) in [(0.75, 2.0), (1.0, 5.0), (1.5, 10.0)] {
        let mut air = record(None);
        put(&mut air, 40, speed);
        let far = settled(&ideal_config(dt, 700.0, 1.0e9, tau), &air, dt, steps);
        let far_power = far.thrust_n * far.induced_mps;
        let mut near = record(Some((z * RADIUS, 1.0)));
        put(&mut near, 40, speed);
        let mut omega = 700.0;
        let (mut now, mut factor) = (free_of_ground_placeholder(), 1.0);
        for _ in 0..30 {
            now = settled(&ideal_config(dt, omega, 1.0e9, tau), &near, dt, steps);
            factor = induced_factor(RADIUS, z * RADIUS, 1.0, speed, now.induced_mps).factor;
            omega *= (far_power / (now.thrust_n * factor * now.induced_mps)).cbrt();
        }
        let ratio = now.thrust_n / far.thrust_n;
        println!("z/R {z} transverse {speed}: thrust ratio {ratio:.12}, closed form {:.12}", 1.0 / factor);
        assert!((ratio * factor - 1.0).abs() <= 1e-9, "z/R {z} at {speed} m/s: {ratio} against {}", 1.0 / factor);
    }
}
fn free_of_ground_placeholder() -> Settled { Settled { thrust_n: 0.0, torque_nm: 0.0, omega: 0.0, induced_mps: 0.0 } }

/// One step written out from the public kernel, shaft and inflow: bitwise, thrust, torque and the next state.
#[test]
fn a_step_near_the_ground_is_the_kernel_at_the_reduced_velocity() {
    let (dt, inertia, tau) = (1.0 / 800.0, 0.002, 0.02);
    let (height, cos, across) = (0.8 * RADIUS, 0.9, 1.5);
    let c = ideal_config(dt, 700.0, inertia, tau);
    let air = |ground: Option<(f64, f64)>| { let mut input = record(ground); put(&mut input, 40, across); input };
    let b = ideal_blade();
    let rotor = Rotor::new(
        RotorGeometry { blade_count: 2, spin_sign: 1, radius_m: RADIUS, cutout_m: CUTOUT, radius: &b.r, chord: &b.chord, twist: &b.twist, width: &b.width },
        PolarTable::new(&IDEAL_ALPHA, &IDEAL_RE, &IDEAL_MACH, &IDEAL_CL, &IDEAL_CD).unwrap(), 8).unwrap();
    let shaft = Shaft::new(inertia, 0.0, 1).unwrap();
    let inflow = AxialInflow::new(1.225, RADIUS, tau, 500.0).unwrap();
    let base = RotorInput { density_kg_m3: 1.225, viscosity_pa_s: 1.7894e-5, sound_speed_mps: 340.294, air_velocity_hub_mps: Vec3::new(across, 0.0, 0.0),
        body_rate_hub_rad_s: Vec3::new(0.0, 0.0, 0.0), omega_rad_s: 0.0, induced_mps: 0.0, collective_rad: 0.0, cyclic_cos_rad: 0.0, cyclic_sin_rad: 0.0 };
    let factor = |v: f64| induced_factor(RADIUS, height, cos, across, v).factor;
    for ground in [Some((height, cos)), None] {
        let input = air(ground);
        let near = |v: f64| if ground.is_some() { factor(v) } else { 1.0 };
        let mut a = vec![0u8; 64 + c.len()];
        assert_eq!(bound::init(&c, &mut a, 0), 0);
        let mut out = [0u8; 256];
        for _ in 0..40 { assert_eq!(bound_v2::step(&mut a, &input, &mut out, dt), 0); }
        // The next step, from the state the last one left.
        let (omega, start) = (get(&out, 72), get(&out, 96));
        assert!(start > 0.5 && omega > 100.0, "{start} {omega}");
        let first = rotor.evaluate_sampled(RotorInput { omega_rad_s: omega, induced_mps: start * near(start), ..base }, 1).unwrap();
        let half_omega = shaft.step(omega, first.moment_nm.z, 0.0, dt * 0.5).unwrap().omega_rad_s;
        let half = inflow.step(start, first.force_n.z * near(start), 0.0, across, dt * 0.5).unwrap().velocity_mps;
        let aero = rotor.evaluate_sampled(RotorInput { omega_rad_s: half_omega, induced_mps: half * near(half), ..base }, 1).unwrap();
        let next = inflow.step(start, aero.force_n.z * near(half), 0.0, across, dt).unwrap().velocity_mps;
        assert_eq!(bound_v2::step(&mut a, &input, &mut out, dt), 0);
        assert_eq!(get(&out, 16).to_bits(), aero.force_n.z.to_bits(), "thrust, ground {ground:?}");
        assert_eq!(get(&out, 80).to_bits(), aero.moment_nm.z.to_bits(), "torque, ground {ground:?}");
        assert_eq!(get(&out, 96).to_bits(), next.to_bits(), "state, ground {ground:?}");
    }
}

/// Production's inflow and a real polar: dynamic inflow with its losses, then profile power, which a closed form leaves out.
#[test]
fn production_inflow_stays_near_the_closed_form_at_the_same_power() {
    let (dt, steps) = (1.0 / 800.0, 2400);
    let c = |omega: f64| config(dt, omega);
    let free = settled(&c(700.0), &record(None), dt, steps);
    let power = free.omega * free.torque_nm.abs();
    for z in [0.75, 1.0, 2.0] {
        let mut omega = 700.0;
        let mut now = free_of_ground_placeholder();
        let plane = record(Some((z * RADIUS, 1.0)));
        for _ in 0..5 {
            now = settled(&c(omega), &plane, dt, steps);
            omega *= (power / (now.omega * now.torque_nm.abs())).cbrt();
        }
        let (ratio, want) = (now.thrust_n / free.thrust_n, 1.0 / induced_factor(RADIUS, z * RADIUS, 1.0, 0.0, now.induced_mps).factor);
        println!("NACA6409 dynamic inflow, z/R {z}: thrust ratio {ratio:.5}, closed form {want:.5}");
        // Profile power does not fall near the ground, so the gain is below the closed form; it is there and not above it.
        assert!(ratio > 1.0 && ratio < want * 1.001, "z/R {z}: {ratio} against {want}");
    }
}
