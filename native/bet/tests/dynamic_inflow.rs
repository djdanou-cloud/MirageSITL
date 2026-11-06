//! TASK-098: Pitt-Peters dynamic inflow with annular tip and hub losses, against closed forms and against the
//! separate steady annular BEM of `propeller_bem.rs`, with the tolerances declared in the roadmap.
use mirage_bet::{
    blade::{InflowField, Rotor, RotorGeometry, RotorInput},
    bound,
    inflow::{glauert_root, AnnularMomentum, DynamicInflow, InflowStates, MASS_MEAN},
    polar::PolarTable,
    propeller::PropellerCondition,
    propeller_bem::{prandtl_factor, steady_annular, BemOptions},
    Vec3,
};
use std::f64::consts::PI;

#[path = "support/neuralfoil.rs"]
mod neuralfoil;

const RHO: f64 = 1.225;
const RADIUS: f64 = 0.127;
const CUTOUT: f64 = 0.0127;
const STRIPS: usize = 16;

fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn word(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
fn get(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }

struct Blade { r: Vec<f64>, chord: Vec<f64>, twist: Vec<f64>, width: Vec<f64> }
fn blade() -> Blade {
    let width = (RADIUS - CUTOUT) / STRIPS as f64;
    let r: Vec<f64> = (0..STRIPS).map(|k| CUTOUT + (k as f64 + 0.5) * width).collect();
    let chord = r.iter().map(|x| 0.025 - 0.08 * (x - 0.06)).collect();
    let twist = r.iter().map(|x| (0.1143 / (2.0 * PI * x)).atan()).collect();
    Blade { r, chord, twist, width: vec![width; STRIPS] }
}

/// A rotor whose shaft inertia holds its speed, so that a run is at a fixed rotation speed.
fn config(dt: f64, omega: f64, dynamic: bool, tau: f64) -> Vec<u8> {
    let p = neuralfoil::naca6409(&[0.0, 0.3]);
    let b = blade();
    let count = p.alpha.len() * p.re.len() * p.mach.len();
    let tail = if dynamic { (3 + STRIPS) * 8 } else { 0 };
    let mut c = vec![0u8; 128 + (4 * STRIPS + p.alpha.len() + p.re.len() + p.mach.len() + 3 * count) * 8 + tail];
    let len = c.len() as u32;
    for (at, v) in [(0, if dynamic { bound::CONFIG_VERSION_INFLOW } else { 1 }), (4, len), (8, p.alpha.len() as u32), (12, p.re.len() as u32), (16, p.mach.len() as u32),
        (20, STRIPS as u32), (24, 2), (28, 1), (32, 8), (36, if dynamic { bound::OPTION_DYNAMIC_INFLOW } else { 0 })] {
        word(&mut c, at, v);
    }
    for (at, v) in [(40, RADIUS), (48, CUTOUT), (56, 1.0e3), (64, 0.0), (72, dt), (80, omega), (88, tau), (96, 500.0), (104, 0.9)] {
        put(&mut c, at, v);
    }
    let mut at = 128;
    for values in [&b.r, &b.chord, &b.twist, &b.width, &p.alpha, &p.re, &p.mach, &p.cl, &p.cd, &p.confidence] {
        for v in values.iter() { put(&mut c, at, *v); at += 8; }
    }
    c
}
fn arena_of(c: &[u8]) -> Vec<u8> {
    let mut a = vec![0u8; 64 + c.len()];
    assert_eq!(bound::init(c, &mut a, 0), 0);
    a
}
fn input(air: Vec3) -> Vec<u8> {
    let mut i = vec![0u8; 128];
    word(&mut i, 0, 1);
    for (at, v) in [(8, RHO), (16, 1.7894e-5), (24, 340.294), (32, air.x), (40, air.y), (48, air.z)] { put(&mut i, at, v); }
    i
}
/// Runs to a steady state and returns the last output.
fn settle(arena: &mut [u8], input: &[u8], dt: f64, seconds: f64) -> [u8; 128] {
    let mut out = [0u8; 128];
    for _ in 0..(seconds / dt) as usize { assert_eq!(bound::step(arena, input, &mut out, dt), 0); }
    out
}
/// The steady annular inflow the arena holds: the mean, shape and harmonics.
fn field_of(arena: &[u8]) -> (f64, Vec<f64>, f64, f64) {
    let at = arena.len() - (3 + STRIPS) * 8;
    (get(arena, 24), (0..STRIPS).map(|k| 1.0 + get(arena, at + 24 + k * 8)).collect(), get(arena, at), get(arena, at + 8))
}

#[test]
fn every_kernel_applies_the_field_and_reports_the_strip_thrust() {
    let p = neuralfoil::naca6409(&[0.0, 0.3, 0.5, 0.7]);
    let polar = PolarTable::new(&p.alpha, &p.re, &p.mach, &p.cl, &p.cd).unwrap().with_confidence(&p.confidence, 0.9).unwrap();
    let within = |a: Vec3, b: Vec3| { let scale = 1e-12 * a.norm().max(b.norm()) + 1e-15; (a.x - b.x).abs() <= scale && (a.y - b.y).abs() <= scale && (a.z - b.z).abs() <= scale };
    for n in [16usize, 1, 3, 5, 63] {
        let width = (RADIUS - CUTOUT) / n as f64;
        let r: Vec<f64> = (0..n).map(|k| CUTOUT + (k as f64 + 0.5) * width).collect();
        let chord: Vec<f64> = r.iter().map(|x| 0.025 - 0.08 * (x - 0.06)).collect();
        let twist: Vec<f64> = r.iter().map(|x| (0.1143 / (2.0 * PI * x)).atan()).collect();
        let widths = vec![width; n];
        let shape: Vec<f64> = (0..n).map(|k| 0.7 + 0.8 * k as f64 / n as f64).collect();
        let g = RotorGeometry { blade_count: 2, spin_sign: 1, radius_m: RADIUS, cutout_m: CUTOUT, radius: &r, chord: &chord, twist: &twist, width: &widths };
        for samples in [1usize, 3, 8] {
            let rotor = Rotor::new(g, polar, samples).unwrap();
            for (cos_mps, sin_mps, air) in [(0.0, 0.0, Vec3::new(0.0, 0.0, 0.0)), (1.5, -0.7, Vec3::new(8.0, -3.0, 1.0)), (-2.0, 0.4, Vec3::new(0.0, 0.0, -6.0))] {
                let field = InflowField { shape: &shape, cos_mps, sin_mps };
                let i = RotorInput { density_kg_m3: RHO, viscosity_pa_s: 1.7894e-5, sound_speed_mps: 340.294, air_velocity_hub_mps: air, body_rate_hub_rad_s: Vec3::new(0.3, 0.2, -0.1),
                    omega_rad_s: 600.0, induced_mps: 5.0, collective_rad: 0.02, cyclic_cos_rad: 0.01, cyclic_sin_rad: -0.02 };
                let (mut t_ref, mut t_fast, mut t_sampled) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
                let a = rotor.evaluate_field(i, field, Some(&mut t_ref)).unwrap();
                let b = rotor.evaluate_fast_field(i, field, Some(&mut t_fast)).unwrap();
                let t = rotor.evaluate_sampled_field(i, 1, field, Some(&mut t_sampled)).unwrap();
                assert_eq!(a, b, "the exact kernel is the reference with {n} strips");
                assert_eq!(t_ref, t_fast);
                assert!(within(a.force_n, t.force_n) && within(a.moment_nm, t.moment_nm) && within(a.flap_load_nm, t.flap_load_nm), "{a:?} {t:?}");
                assert_eq!(a.flags, t.flags);
                assert!((t_ref.iter().sum::<f64>() - a.force_n.z).abs() <= 1e-11 * a.force_n.norm().max(1.0));
                assert!((t_sampled.iter().sum::<f64>() - t.force_n.z).abs() <= 1e-11 * t.force_n.norm().max(1.0));
                // The field changes the loads against a uniform inflow.
                assert_ne!(a.force_n, rotor.evaluate(i).unwrap().force_n);
            }
            // The uniform field is the plain kernel, bit for bit.
            let i = RotorInput { density_kg_m3: RHO, viscosity_pa_s: 1.7894e-5, sound_speed_mps: 340.294, air_velocity_hub_mps: Vec3::new(2.0, 1.0, 0.0), body_rate_hub_rad_s: Vec3::new(0.3, 0.2, -0.1),
                omega_rad_s: 600.0, induced_mps: 5.0, collective_rad: 0.02, cyclic_cos_rad: 0.01, cyclic_sin_rad: -0.02 };
            assert_eq!(rotor.evaluate_sampled(i, 1).unwrap(), rotor.evaluate_sampled_field(i, 1, InflowField::UNIFORM, None).unwrap());
        }
    }
    // Shapes of the wrong length and non-finite harmonics are errors.
    let b = blade();
    let g = RotorGeometry { blade_count: 2, spin_sign: 1, radius_m: RADIUS, cutout_m: CUTOUT, radius: &b.r, chord: &b.chord, twist: &b.twist, width: &b.width };
    let rotor = Rotor::new(g, polar, 8).unwrap();
    let i = RotorInput { density_kg_m3: RHO, viscosity_pa_s: 1.7894e-5, sound_speed_mps: 340.294, air_velocity_hub_mps: Vec3::new(0.0, 0.0, 0.0), body_rate_hub_rad_s: Vec3::new(0.0, 0.0, 0.0),
        omega_rad_s: 600.0, induced_mps: 5.0, collective_rad: 0.0, cyclic_cos_rad: 0.0, cyclic_sin_rad: 0.0 };
    assert!(rotor.evaluate_field(i, InflowField { shape: &[1.0, 1.0], cos_mps: 0.0, sin_mps: 0.0 }, None).is_err());
    assert!(rotor.evaluate_sampled_field(i, 1, InflowField { shape: &[], cos_mps: f64::NAN, sin_mps: 0.0 }, None).is_err());
}

#[test]
fn glauert_root_solves_its_equation_and_flags_a_failed_warm_start() {
    // Hover and climb have closed forms.
    let (root, converged) = glauert_root(16.0, 0.0, 0.0, 0.0);
    assert!(converged && (root - 4.0).abs() <= 1e-9);
    let (root, converged) = glauert_root(16.0, 6.0, 0.0, 0.0);
    assert!(converged && (root - 2.0 * 16.0 / (6.0f64.hypot(8.0) + 6.0)).abs() <= 1e-9);
    // Edgewise at many operating points, from a warm start near the root as in a step: the equation holds.
    let mut last = 0.0;
    for k in 1..400 {
        let (loading, climb, transverse) = (k as f64 * 0.5, (k % 7) as f64, (k % 13) as f64 * 3.0);
        let (root, ok) = glauert_root(loading, climb, transverse, 0.0);
        assert!(ok, "from the axial root at {k}");
        let flow = climb + root;
        assert!((root * (transverse * transverse + flow * flow).sqrt() - loading).abs() <= 1e-9 * loading);
        last = root;
    }
    assert!(last > 0.0);
    assert_eq!(glauert_root(0.0, 3.0, 2.0, 5.0), (0.0, true));
    // A warm start far above the root does not converge in four iterations, and says so.
    let (_, ok) = glauert_root(1.0, 0.0, 0.0, 1e6);
    assert!(!ok);
    let model = DynamicInflow::new(RHO, RADIUS, 0.0, 1e7).unwrap();
    let area = PI * RADIUS * RADIUS;
    let far = model.step(InflowStates { mean_mps: 1e6, cos_mps: 0.0, sin_mps: 0.0 }, 1.0, 2.0 * RHO * area, 0.0, 0.0, Vec3::new(0.0, 0.0, 0.0), 80.0, 1e-3).unwrap();
    assert!(far.outside_validity, "an iteration cap sets the flag");
    let near = model.step(InflowStates { mean_mps: 1.0, cos_mps: 0.0, sin_mps: 0.0 }, 1.0, 2.0 * RHO * area, 0.0, 0.0, Vec3::new(0.0, 0.0, 0.0), 80.0, 1e-3).unwrap();
    assert!(!near.outside_validity);
}

#[test]
fn the_states_reach_glauert_coleman_and_the_moment_gains() {
    let model = DynamicInflow::new(RHO, RADIUS, 0.0, 500.0).unwrap();
    let area = PI * RADIUS * RADIUS;
    let loading = 40.0;
    let thrust = 2.0 * RHO * area * loading;
    let tan_half = |transverse: f64, flow: f64| { let w = transverse.hypot(flow); transverse / (w + flow.abs()) };
    for (vx, vy, climb) in [(0.0, 0.0, 0.0), (5.0, 0.0, 0.0), (0.0, 7.0, 2.0), (-3.0, 4.0, 1.0), (12.0, -9.0, 0.0)] {
        let air = Vec3::new(vx, vy, -climb);
        let transverse = (vx * vx + vy * vy as f64).sqrt();
        let r = model.step(InflowStates::default(), 1.0, thrust, 0.0, 0.0, air, 80.0, 1e-3).unwrap();
        // Glauert's root by bisection, independent of the Newton iteration.
        let (mut low, mut high) = (0.0, 1e3);
        for _ in 0..200 { let mid = 0.5 * (low + high); if mid * transverse.hypot(climb + mid) > loading { high = mid } else { low = mid } }
        assert!((r.targets.mean_mps - low).abs() <= 1e-9 * low, "mean at {vx} {vy} {climb}");
        // Coleman: the longitudinal gradient, on the downwind direction, with no lateral part.
        let flow = climb + low;
        let gradient = 15.0 * PI / 32.0 * tan_half(transverse, flow) * low;
        let (dx, dy) = if transverse > 0.0 { (vx / transverse, vy / transverse) } else { (1.0, 0.0) };
        assert!((r.targets.cos_mps - gradient * dx).abs() <= 1e-9 * low, "cos at {vx} {vy} {climb}");
        assert!((r.targets.sin_mps - gradient * dy).abs() <= 1e-9 * low, "sin at {vx} {vy} {climb}");
    }
    // Hover: a moment on cos(psi) gives a harmonic of 2 F/V, V = 2 v.
    let root = loading.sqrt();
    let moment = 0.3;
    let force = moment / (RHO * area * RADIUS);
    let r = model.step(InflowStates::default(), 1.0, thrust, moment, -2.0 * moment, Vec3::new(0.0, 0.0, 0.0), 80.0, 1e-3).unwrap();
    assert!((r.targets.cos_mps - 2.0 * force / (2.0 * root)).abs() <= 1e-9, "{}", r.targets.cos_mps);
    assert!((r.targets.sin_mps + 2.0 * 2.0 * force / (2.0 * root)).abs() <= 1e-9);
    // A negative thrust mirrors the mean.
    let r = model.step(InflowStates::default(), 1.0, -thrust, 0.0, 0.0, Vec3::new(0.0, 0.0, 0.0), 80.0, 1e-3).unwrap();
    assert!((r.targets.mean_mps + root).abs() <= 1e-9);
    // The advance ratio's envelope and descent set the flag; hover and climb do not.
    let flagged = |air: Vec3, tip: f64| model.step(InflowStates::default(), 1.0, thrust, 0.0, 0.0, air, tip, 1e-3).unwrap().outside_validity;
    assert!(!flagged(Vec3::new(0.0, 0.0, 0.0), 80.0) && !flagged(Vec3::new(0.0, 0.0, -5.0), 80.0) && !flagged(Vec3::new(23.0, 0.0, 0.0), 80.0));
    assert!(flagged(Vec3::new(25.0, 0.0, 0.0), 80.0) && flagged(Vec3::new(0.0, 0.0, 3.0), 80.0) && flagged(Vec3::new(1.0, 0.0, 0.0), 0.0));
}

#[test]
fn a_small_thrust_step_in_hover_has_the_analytic_time_constant() {
    let model = DynamicInflow::new(RHO, RADIUS, 0.0, 500.0).unwrap();
    let area = PI * RADIUS * RADIUS;
    let root = 6.0;
    let thrust = |v: f64| 2.0 * RHO * area * v * v;
    let analytic = MASS_MEAN * RADIUS / (4.0 * root);
    let dt = analytic / 400.0;
    let mut states = InflowStates { mean_mps: root, cos_mps: 0.0, sin_mps: 0.0 };
    let (target, mut time) = (root * 1.01, 0.0);
    let threshold = root + (target - root) * (1.0 - (-1.0f64).exp());
    while states.mean_mps < threshold {
        states = model.step(states, 1.0, thrust(target), 0.0, 0.0, Vec3::new(0.0, 0.0, 0.0), 80.0, dt).unwrap().states;
        time += dt;
        assert!(time < 100.0 * analytic);
    }
    assert!((time - analytic).abs() <= 0.1 * analytic, "63 % at {time} s, analytic {analytic} s");
    // A stopped disk with no thrust keeps a finite, capped time constant, and a manual one replaces it.
    assert_eq!(model.step(InflowStates::default(), 1.0, 0.0, 0.0, 0.0, Vec3::new(0.0, 0.0, 0.0), 0.0, 1e-3).unwrap().tau_s, 1.0);
    let manual = DynamicInflow::new(RHO, RADIUS, 0.05, 500.0).unwrap();
    assert_eq!(manual.step(states, 1.0, thrust(target), 0.0, 0.0, Vec3::new(0.0, 0.0, 0.0), 80.0, 1e-3).unwrap().tau_s, 0.05);
}

#[test]
fn a_hover_settles_with_each_annulus_in_balance() {
    for hz in [400.0, 1200.0] {
        let (dt, omega) = (1.0 / hz, 700.0);
        let mut arena = arena_of(&config(dt, omega, true, 0.0));
        let i = input(Vec3::new(0.0, 0.0, 0.0));
        let out = settle(&mut arena, &i, dt, 1.0);
        let (thrust, inflow) = (get(&out, 16), get(&out, 96));
        let (mean, shape, cos_mps, sin_mps) = field_of(&arena);
        assert_eq!(mean, inflow);
        assert!(thrust > 0.1 && inflow > 0.5, "{thrust} {inflow}");
        assert!(cos_mps.abs() <= 1e-6 && sin_mps.abs() <= 1e-6, "{cos_mps} {sin_mps}");
        // The momentum of the annuli against the thrust, at most 1 %.
        let b = blade();
        let mut momentum = 0.0;
        for k in 0..STRIPS {
            let v = mean * shape[k];
            let sin_phi = v / v.hypot(omega * b.r[k]);
            let f = prandtl_factor(2, b.r[k], RADIUS, CUTOUT, sin_phi, true, true);
            momentum += 4.0 * PI * b.r[k] * b.width[k] * RHO * f * v * v;
        }
        assert!((momentum - thrust).abs() <= 0.01 * thrust, "{hz} Hz: momentum {momentum}, thrust {thrust}");
        // Tip loss: the inflow rises towards the tip, against the uniform model's.
        assert!(shape[STRIPS - 1] > shape[STRIPS / 2], "{shape:?}");
        // No limit cycle: the state holds still.
        let mut quiet = arena.clone();
        let next = settle(&mut quiet, &i, dt, 0.05);
        assert!((get(&next, 96) - inflow).abs() <= 1e-6 * inflow, "{hz} Hz: {} {inflow}", get(&next, 96));
        assert!((get(&next, 16) - thrust).abs() <= 1e-6 * thrust, "{hz} Hz");
    }
}

#[test]
fn a_climb_agrees_with_the_steady_annular_bem() {
    let p = neuralfoil::naca6409(&[0.0, 0.3]);
    let polar = PolarTable::new(&p.alpha, &p.re, &p.mach, &p.cl, &p.cd).unwrap();
    let b = blade();
    let g = RotorGeometry { blade_count: 2, spin_sign: 1, radius_m: RADIUS, cutout_m: CUTOUT, radius: &b.r, chord: &b.chord, twist: &b.twist, width: &b.width };
    let (dt, omega) = (1.0 / 800.0, 700.0);
    for climb in [2.0, 6.0] {
        let reference = steady_annular(g, polar, PropellerCondition { rpm: omega * 60.0 / (2.0 * PI), advance_ratio: climb / (omega / (2.0 * PI) * 2.0 * RADIUS),
            density_kg_m3: RHO, viscosity_pa_s: 1.7894e-5, sound_speed_mps: 340.294, collective_rad: 0.0 }, BemOptions { tip_loss: true, hub_loss: true, swirl: false }).unwrap();
        assert!(reference.converged);
        let mut arena = arena_of(&config(dt, omega, true, 0.0));
        let out = settle(&mut arena, &input(Vec3::new(0.0, 0.0, -climb)), dt, 1.0);
        let thrust = get(&out, 16);
        let (mean, shape, _, _) = field_of(&arena);
        let width_weighted = (0..STRIPS).map(|k| mean * shape[k] * b.width[k]).sum::<f64>() / b.width.iter().sum::<f64>();
        assert!((thrust - reference.thrust_n).abs() <= 0.03 * reference.thrust_n, "climb {climb}: {thrust} against {}", reference.thrust_n);
        assert!((width_weighted - reference.mean_induced_mps).abs() <= 0.03 * reference.mean_induced_mps, "climb {climb}: {width_weighted} against {}", reference.mean_induced_mps);
    }
}

#[test]
fn edgewise_flight_keeps_a_steady_field_with_a_downwind_gradient() {
    let (dt, omega) = (1.0 / 800.0, 700.0);
    let mut arena = arena_of(&config(dt, omega, true, 0.0));
    let out = settle(&mut arena, &input(Vec3::new(9.0, 0.0, 0.0)), dt, 1.0);
    let (mean, _, cos_mps, _) = field_of(&arena);
    assert!(cos_mps > 0.05 * mean, "the inflow is larger downwind: {cos_mps} on a mean of {mean}");
    assert_eq!(u32::from_le_bytes(out[112..116].try_into().unwrap()) & 8, 0, "inside the advance ratio's envelope");
    let mut quiet = arena.clone();
    let next = settle(&mut quiet, &input(Vec3::new(9.0, 0.0, 0.0)), dt, 0.05);
    assert!((get(&next, 96) - get(&out, 96)).abs() <= 1e-5 * get(&out, 96));
}

#[test]
fn the_option_changes_only_the_rotors_that_ask_for_it_and_resets() {
    let dt = 1.0 / 400.0;
    // A nonzero state region in a configuration, version 3 with the option, and a negative tau are rejected.
    let good = config(dt, 700.0, true, 0.0);
    let mut dirty = good.clone();
    let last = dirty.len() - 8;
    put(&mut dirty, last, 1.0);
    let mut a = vec![0u8; 64 + dirty.len()];
    assert_eq!(bound::init(&dirty, &mut a, 0), -3);
    let mut older = good.clone();
    word(&mut older, 0, bound::CONFIG_VERSION_ROTATIONAL);
    assert_eq!(bound::init(&older, &mut vec![0u8; 64 + older.len()], 0), -3);
    let mut negative = good.clone();
    put(&mut negative, 88, -0.1);
    assert_eq!(bound::init(&negative, &mut vec![0u8; 64 + negative.len()], 0), -3);
    // A tau of 0 needs the option.
    let plain_zero = config(dt, 700.0, false, 0.0);
    assert_eq!(bound::init(&plain_zero, &mut vec![0u8; 64 + plain_zero.len()], 0), -3);
    // The production and reference steps agree, and the exact kernel is the reference's bits.
    let i = input(Vec3::new(5.0, -2.0, 1.0));
    let (mut production, mut reference) = (arena_of(&good), arena_of(&good));
    let mut exact_config = good.clone();
    word(&mut exact_config, 36, bound::OPTION_DYNAMIC_INFLOW | bound::OPTION_EXACT_KERNEL);
    let mut exact = arena_of(&exact_config);
    let (mut op, mut or, mut oe) = ([0u8; 128], [0u8; 128], [0u8; 128]);
    for _ in 0..400 {
        assert_eq!(bound::step(&mut production, &i, &mut op, dt), 0);
        assert_eq!(bound::step_reference(&mut reference, &i, &mut or, dt), 0);
        assert_eq!(bound::step(&mut exact, &i, &mut oe, dt), 0);
        assert_eq!(oe, or);
        for at in (0..104).step_by(8) {
            let (x, y) = (get(&op, at), get(&or, at));
            assert!((x - y).abs() <= 1e-9 * x.abs().max(y.abs()) + 1e-12, "byte {at}: {x} {y}");
        }
    }
    // A reset clears the region and starts again, step for step.
    let (mut once, fresh_out) = (arena_of(&good), settle(&mut arena_of(&good), &i, dt, 0.1));
    settle(&mut once, &i, dt, 0.3);
    assert_eq!(bound::reset(&mut once), 0);
    assert_eq!(settle(&mut once, &i, dt, 0.1), fresh_out);
    // The annular solver alone: a strip against the rotor holds 0, and its mean is area-weighted.
    let b = blade();
    let annuli = AnnularMomentum { blade_count: 2, radius_m: RADIUS, cutout_m: CUTOUT, strip_radius_m: &b.r, strip_width_m: &b.width };
    let mut thrust = [0.2; STRIPS];
    thrust[3] = -0.1;
    let mut inflow = [0.0; STRIPS];
    let solved = annuli.solve(&thrust, RHO, 700.0, 1.0, 0.0, 0.0, &mut inflow);
    assert_eq!(inflow[3], 0.0);
    assert!(solved.mean_mps > 0.0 && inflow[2] > 0.0);
}

#[test]
fn descent_keeps_a_finite_continuous_inflow_and_is_flagged() {
    use mirage_bet::inflow::descent_baseline;
    // Axial momentum theory on its two branches outside Johnson's points A and B (TP-2005-213477, table 4).
    let working = |x: f64| 0.5 * (-x + (x * x + 4.0).sqrt());
    let windmill = |x: f64| 0.5 * (-x - (x * x - 4.0).sqrt());
    for x in [-0.01, -0.5, -1.0, -1.5] {
        assert!((descent_baseline(x, 0.0).0 - working(x)).abs() <= 1e-11, "{x}");
    }
    for x in [-2.1, -2.5, -4.0, -10.0] {
        assert!((descent_baseline(x, 0.0).0 - windmill(x)).abs() <= 1e-11, "{x}");
    }
    // Between A and B the cubic matches value and slope at A and value at B: no jump, on a grid of both speeds.
    let (a, slope_a) = descent_baseline(-1.5, 0.0);
    let (just_inside, slope_inside) = descent_baseline(-1.5 - 1e-7, 0.0);
    assert!((a - just_inside).abs() <= 1e-6 && (slope_a - slope_inside).abs() <= 1e-5, "{slope_a} {slope_inside}");
    assert!((descent_baseline(-2.1 + 1e-9, 0.0).0 - windmill(-2.1)).abs() <= 1e-6);
    // Forward flight: above VxC momentum alone, one root, on the right branch.
    for (vz, vx) in [(-1.0, 0.9), (-3.0, 1.2), (-0.3, 0.8)] {
        let v = descent_baseline(vz, vx).0;
        assert!((v * (vx * vx + (vz + v) * (vz + v)).sqrt() - 1.0).abs() <= 1e-9, "{vz} {vx}: {v}");
    }
    for k in 0..=40 {
        let vx = k as f64 * 0.025;
        let mut last = descent_baseline(-0.001, vx).0;
        for j in 2..=4000 {
            let next = descent_baseline(-(j as f64) * 0.001, vx).0;
            assert!((next - last).abs() <= 0.03, "a jump at Vz {} Vx {vx}: {last} to {next}", -(j as f64) * 0.001);
            assert!(next.is_finite() && next >= 0.0);
            last = next;
        }
    }
    // A rotor falling fast: the inflow stays finite and small, and the flag is up.
    let (dt, omega) = (1.0 / 800.0, 700.0);
    let mut arena = arena_of(&config(dt, omega, true, 0.0));
    let out = settle(&mut arena, &input(Vec3::new(0.0, 0.0, 30.0)), dt, 0.5);
    assert!(get(&out, 96).is_finite() && get(&out, 96).abs() < 30.0, "{}", get(&out, 96));
    assert_eq!(u32::from_le_bytes(out[112..116].try_into().unwrap()) & 8, 8);
}
