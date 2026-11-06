//! TASK-099: Johnson's inflow model in descent (NASA TP-2005-213477, tables 3 and 4) and its seeded thrust fluctuation,
//! with the tolerances declared in the roadmap.
use mirage_bet::{bound, inflow::{descent_baseline, descent_inflow, vortex_ring_increment, ThrustFluctuation}, Vec3};
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
fn flags(b: &[u8]) -> u32 { u32::from_le_bytes(b[112..116].try_into().unwrap()) }

/// A rotor whose shaft inertia holds its speed, with or without the vortex ring option.
fn config(dt: f64, omega: f64, seed: Option<u64>) -> Vec<u8> {
    let p = neuralfoil::naca6409(&[0.0, 0.3]);
    let width = (RADIUS - CUTOUT) / STRIPS as f64;
    let r: Vec<f64> = (0..STRIPS).map(|k| CUTOUT + (k as f64 + 0.5) * width).collect();
    let chord: Vec<f64> = r.iter().map(|x| 0.025 - 0.08 * (x - 0.06)).collect();
    let twist: Vec<f64> = r.iter().map(|x| (0.1143 / (2.0 * PI * x)).atan()).collect();
    let count = p.alpha.len() * p.re.len() * p.mach.len();
    let tail = (3 + STRIPS) * 8 + if seed.is_some() { 8 + 3 * 8 } else { 0 };
    let tables = 128 + (4 * STRIPS + p.alpha.len() + p.re.len() + p.mach.len() + 3 * count) * 8;
    let mut c = vec![0u8; tables + tail];
    let len = c.len() as u32;
    let (version, options) = if seed.is_some() { (bound::CONFIG_VERSION_VORTEX, bound::OPTION_DYNAMIC_INFLOW | bound::OPTION_VORTEX_RING) } else { (bound::CONFIG_VERSION_INFLOW, bound::OPTION_DYNAMIC_INFLOW) };
    for (at, v) in [(0, version), (4, len), (8, p.alpha.len() as u32), (12, p.re.len() as u32), (16, p.mach.len() as u32), (20, STRIPS as u32), (24, 2), (28, 1), (32, 8), (36, options)] {
        word(&mut c, at, v);
    }
    for (at, v) in [(40, RADIUS), (48, CUTOUT), (56, 1.0e3), (64, 0.0), (72, dt), (80, omega), (88, 0.0), (96, 500.0), (104, 0.9)] {
        put(&mut c, at, v);
    }
    let mut at = 128;
    for values in [&r, &chord, &twist, &vec![width; STRIPS], &p.alpha, &p.re, &p.mach, &p.cl, &p.cd, &p.confidence] {
        for v in values.iter() { put(&mut c, at, *v); at += 8; }
    }
    if let Some(seed) = seed { c[tables..tables + 8].copy_from_slice(&seed.to_le_bytes()); }
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
fn run(arena: &mut [u8], input: &[u8], dt: f64, seconds: f64) -> [u8; 128] {
    let mut out = [0u8; 128];
    for _ in 0..(seconds / dt) as usize { assert_eq!(bound::step(arena, input, &mut out, dt), 0); }
    out
}

#[test]
fn the_curve_reproduces_johnsons_table_4() {
    // The total inflow at N and X, with zero slope there, negative between them and positive outside them.
    let total = |vz: f64| vz + descent_inflow(vz, 0.0);
    assert!((total(-0.45) - 0.85).abs() <= 1e-9, "{}", total(-0.45));
    assert!((total(-1.5) - 1.25).abs() <= 1e-9, "{}", total(-1.5));
    let slope = |vz: f64| (total(vz + 1e-7) - total(vz - 1e-7)) / 2e-7;
    assert!(slope(-0.45).abs() <= 1e-5 && slope(-1.5).abs() <= 1e-5, "{} {}", slope(-0.45), slope(-1.5));
    for k in 1..105 {
        let vz = -0.45 - k as f64 * 0.01;
        assert!(slope(vz) < 0.0, "between N and X at {vz}: {}", slope(vz));
    }
    for vz in [-0.25, -0.3, -0.4, -1.55, -1.7, -1.9] {
        assert!(slope(vz) > 0.0, "outside at {vz}: {}", slope(vz));
    }
    // Outside D and E the increment is 0, and the model is its baseline.
    for vz in [-0.2, -0.1, -0.01, -2.0, -2.5, -5.0] {
        assert_eq!(vortex_ring_increment(vz, 0.0), 0.0, "{vz}");
        assert!((descent_inflow(vz, 0.0) - descent_baseline(vz, 0.0).0).abs() <= 1e-12);
    }
    // Forward of VxM there is no vortex ring state.
    for vz in [-0.5, -1.0, -1.5] {
        assert_eq!(vortex_ring_increment(vz, 0.95), 0.0);
        assert!(vortex_ring_increment(vz, 0.5) != 0.0);
    }
}

#[test]
fn the_curve_has_no_jump_on_a_grid_of_both_speeds() {
    for k in 0..=40 {
        let vx = k as f64 * 0.025;
        let mut last = descent_inflow(-0.001, vx);
        for j in 2..=4000 {
            let vz = -(j as f64) * 0.001;
            let next = descent_inflow(vz, vx);
            assert!(next.is_finite(), "{vz} {vx}");
            assert!((next - last).abs() <= 0.05, "a jump at Vz {vz} Vx {vx}: {last} to {next}");
            last = next;
        }
    }
}

#[test]
fn the_thrust_falls_as_the_descent_rate_rises_through_the_region() {
    // The negative damping: an increase in descent rate at a fixed speed gives less thrust between N and X.
    let (dt, omega) = (1.0 / 800.0, 900.0);
    let area = PI * RADIUS * RADIUS;
    let hover_thrust = { let mut a = arena_of(&config(dt, omega, Some(7))); get(&run(&mut a, &input(Vec3::new(0.0, 0.0, 0.0)), dt, 0.5), 16) };
    let vh = (hover_thrust / (2.0 * RHO * area)).sqrt();
    let mean_thrust = |x: f64| {
        let mut a = arena_of(&config(dt, omega, Some(7)));
        let i = input(Vec3::new(0.0, 0.0, -x * vh));
        run(&mut a, &i, dt, 0.5);
        let (mut sum, mut out) = (0.0, [0u8; 128]);
        let steps = (6.0 / dt) as usize;
        for _ in 0..steps { assert_eq!(bound::step(&mut a, &i, &mut out, dt), 0); sum += get(&out, 16); }
        sum / steps as f64
    };
    let (shallow, deep) = (mean_thrust(-0.6), mean_thrust(-1.3));
    assert!(deep < shallow, "thrust at -0.6 v_h {shallow} N, at -1.3 v_h {deep} N");
}

#[test]
fn the_fluctuation_replays_from_its_seed_and_has_its_declared_size() {
    let (dt, omega) = (1.0 / 800.0, 900.0);
    let area = PI * RADIUS * RADIUS;
    let hover_thrust = { let mut a = arena_of(&config(dt, omega, Some(7))); get(&run(&mut a, &input(Vec3::new(0.0, 0.0, 0.0)), dt, 0.5), 16) };
    let vh = (hover_thrust / (2.0 * RHO * area)).sqrt();
    let i = input(Vec3::new(0.0, 0.0, 0.975 * vh));
    let trace = |seed: u64| {
        let mut a = arena_of(&config(dt, omega, Some(seed)));
        let (mut out, mut bytes) = ([0u8; 128], Vec::new());
        for _ in 0..800 { assert_eq!(bound::step(&mut a, &i, &mut out, dt), 0); bytes.extend_from_slice(&out); }
        (bytes, a)
    };
    let (first, mut arena) = trace(11);
    assert_eq!(first, trace(11).0, "one seed, one run");
    assert_ne!(first, trace(12).0, "another seed, another run");
    // A reset starts the same stream again.
    assert_eq!(bound::reset(&mut arena), 0);
    let mut out = [0u8; 128];
    let mut again = Vec::new();
    for _ in 0..800 { assert_eq!(bound::step(&mut arena, &i, &mut out, dt), 0); again.extend_from_slice(&out); }
    assert_eq!(first, again);
    // The filter alone: at the centre of the region its RMS is the declared 15 %, within 25 %, over many correlation times.
    let (hover, radius, step) = (8.0, RADIUS, 1.0 / 800.0);
    let tau = radius / hover;
    let steps = (2000.0 * tau / step) as usize;
    let (mut state, mut sum, mut square) = (ThrustFluctuation::default(), 0.0, 0.0);
    for _ in 0..steps {
        state = state.step(5, -0.975, 0.0, hover, radius, step);
        assert!(state.active);
        sum += state.value;
        square += state.value * state.value;
    }
    let (mean, rms) = (sum / steps as f64, (square / steps as f64).sqrt());
    assert!((rms - 0.15).abs() <= 0.25 * 0.15, "RMS {rms}");
    assert!(mean.abs() <= 0.03, "mean {mean}");
    // Band-limited: the step-to-step change is far smaller than the RMS.
    let (a, b) = (state, state.step(5, -0.975, 0.0, hover, radius, step));
    assert!((a.value - b.value).abs() <= 0.5 * 0.15);
    assert!((0.5..=1.5).contains(&ThrustFluctuation { active: true, value: 9.0, generator: 1 }.factor()));
}

#[test]
fn the_region_switches_with_hysteresis_and_stays_visible() {
    let (hover, step) = (8.0, 1.0 / 800.0);
    // Entering at the boundary N (-0.45) and leaving only 10 % of the half width beyond it.
    let half = 0.525;
    let mut state = ThrustFluctuation::default();
    state = state.step(1, -0.44, 0.0, hover, RADIUS, step);
    assert!(!state.active, "not yet inside");
    state = state.step(1, -0.46, 0.0, hover, RADIUS, step);
    assert!(state.active, "inside");
    state = state.step(1, -0.45 + 0.05 * half, 0.0, hover, RADIUS, step);
    assert!(state.active, "still on, inside the margin");
    state = state.step(1, -0.45 + 0.2 * half, 0.0, hover, RADIUS, step);
    assert!(!state.active, "off, beyond the margin");
    // Inactive, the value decays and the generator stands still.
    let before = state;
    let after = before.step(1, 0.5, 0.0, hover, RADIUS, step);
    assert_eq!(before.generator, after.generator);
    assert!(after.value.abs() <= before.value.abs());
    // On a rotor: the flag follows the region, and the validity flag the curve's data.
    let (dt, omega) = (1.0 / 800.0, 900.0);
    let area = PI * RADIUS * RADIUS;
    let hover_thrust = { let mut a = arena_of(&config(dt, omega, Some(7))); get(&run(&mut a, &input(Vec3::new(0.0, 0.0, 0.0)), dt, 0.5), 16) };
    let vh = (hover_thrust / (2.0 * RHO * area)).sqrt();
    let at = |x: f64, seconds: f64| { let mut a = arena_of(&config(dt, omega, Some(7))); flags(&run(&mut a, &input(Vec3::new(0.0, 0.0, -x * vh)), dt, seconds)) };
    assert_eq!(at(0.0, 0.5) & (bound::FLAG_VORTEX_RING | 8), 0, "hover");
    assert_eq!(at(1.0, 0.5) & (bound::FLAG_VORTEX_RING | 8), 0, "climb");
    assert_eq!(at(-0.1, 0.5) & (bound::FLAG_VORTEX_RING | 8), 0, "a shallow descent, inside the curve's data");
    assert_ne!(at(-0.9, 0.5) & bound::FLAG_VORTEX_RING, 0, "the vortex ring state");
    assert_ne!(at(-4.0, 0.5) & 8, 0, "below the curve's data");
}

#[test]
fn hover_and_climb_are_bitwise_the_model_without_the_option() {
    let (dt, omega) = (1.0 / 400.0, 700.0);
    for air in [Vec3::new(0.0, 0.0, 0.0), Vec3::new(0.0, 0.0, -4.0), Vec3::new(6.0, 2.0, -1.0)] {
        let (mut with, mut without) = (arena_of(&config(dt, omega, Some(9))), arena_of(&config(dt, omega, None)));
        let i = input(air);
        let (mut o1, mut o2) = ([0u8; 128], [0u8; 128]);
        for _ in 0..400 {
            assert_eq!(bound::step(&mut with, &i, &mut o1, dt), 0);
            assert_eq!(bound::step(&mut without, &i, &mut o2, dt), 0);
            assert_eq!(o1, o2);
        }
    }
    // The option needs dynamic inflow, an older version rejects it, and a nonzero state is rejected at initialization.
    let good = config(dt, omega, Some(1));
    let reject = |c: &[u8], why: &str| assert_eq!(bound::init(c, &mut vec![0u8; 64 + c.len()], 0), -3, "{why}");
    let mut alone = good.clone();
    word(&mut alone, 36, bound::OPTION_VORTEX_RING);
    reject(&alone, "without dynamic inflow");
    let mut older = good.clone();
    word(&mut older, 0, bound::CONFIG_VERSION_INFLOW);
    reject(&older, "version 4 rejects the option");
    let mut dirty = good.clone();
    let last = dirty.len() - 16;
    put(&mut dirty, last, 3.0);
    reject(&dirty, "a nonzero state");
}
