//! TASK-101: interface v2's external wake on a rotor, added to its air once, and what a coaxial pair then gives.
use mirage_bet::{bound, bound_v2};

const RADIUS: f64 = 0.127;
const CUTOUT: f64 = 0.0127;
const STRIPS: usize = 8;

fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn word(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
fn get(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }
fn read_word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) }

/// An ideal rotor: no drag, a linear lift curve and the fixed-lag axial inflow, whose shaft power is thrust times the velocity through it.
fn config(dt: f64, omega: f64, inertia: f64, tau: f64) -> Vec<u8> {
    let width = (RADIUS - CUTOUT) / STRIPS as f64;
    let r: Vec<f64> = (0..STRIPS).map(|k| CUTOUT + (k as f64 + 0.5) * width).collect();
    let twist: Vec<f64> = r.iter().map(|x| (0.1143 / (2.0 * std::f64::consts::PI * x)).atan()).collect();
    let tables = 128 + (4 * STRIPS + 6 + 3 * 8) * 8;
    let mut c = vec![0u8; tables];
    let len = c.len() as u32;
    for (at, v) in [(0, bound::VERSION), (4, len), (8, 2), (12, 2), (16, 2), (20, STRIPS as u32), (24, 2), (28, 1), (32, 8)] { word(&mut c, at, v); }
    for (at, v) in [(40, RADIUS), (48, CUTOUT), (56, inertia), (64, 0.0), (72, dt), (80, omega), (88, tau), (96, 500.0), (104, 0.9)] { put(&mut c, at, v); }
    let mut at = 128;
    let groups: [&[f64]; 10] = [&r, &[0.02; STRIPS], &twist, &[width; STRIPS], &[-1.5, 1.5], &[1.0e3, 1.0e9], &[0.0, 1.0],
        &[-8.55, 8.55, -8.55, 8.55, -8.55, 8.55, -8.55, 8.55], &[0.0; 8], &[1.0; 8]];
    for values in groups { for v in values { put(&mut c, at, *v); at += 8; } }
    c
}
fn record(air: [f64; 3], wake: [f64; 3]) -> Vec<u8> {
    let mut i = vec![0u8; 256];
    word(&mut i, 0, bound_v2::VERSION);
    for (at, v) in [(16, 1.225), (24, 1.7894e-5), (32, 340.294)] { put(&mut i, at, v); }
    for k in 0..3 { put(&mut i, 40 + 8 * k, air[k]); put(&mut i, 136 + 8 * k, wake[k]); }
    i
}
fn run(c: &[u8], i: &[u8], dt: f64, steps: usize) -> [u8; 256] {
    let mut a = vec![0u8; 64 + c.len()];
    assert_eq!(bound::init(c, &mut a, 0), 0);
    let mut out = [0u8; 256];
    for _ in 0..steps { assert_eq!(bound_v2::step(&mut a, i, &mut out, dt), 0); }
    out
}

#[test]
fn a_wake_is_the_same_air_added_once() {
    let (dt, c) = (1.0 / 800.0, config(1.0 / 800.0, 700.0, 0.002, 0.02));
    for (air, wake) in [([0.0, 0.0, 0.0], [0.0, 0.0, -3.0]), ([4.0, -1.0, -2.0], [1.5, 0.25, -6.0]), ([0.0, 3.0, 1.0], [-2.0, 0.0, -0.5])] {
        let added = [air[0] + wake[0], air[1] + wake[1], air[2] + wake[2]];
        let (with, plain) = (run(&c, &record(air, wake), dt, 200), run(&c, &record(added, [0.0; 3]), dt, 200));
        // All but the validity word, which says it.
        assert_eq!(with[..116], plain[..116]);
        assert_eq!(with[120..], plain[120..]);
        assert_eq!(read_word(&with, 116) & bound_v2::VALID_EXTERNAL_WAKE, bound_v2::VALID_EXTERNAL_WAKE);
        assert_eq!(read_word(&plain, 116) & bound_v2::VALID_EXTERNAL_WAKE, 0);
    }
    // No wake leaves a record as it came: bitwise and the bit clear, for -0 too.
    let neutral = run(&c, &record([1.0, 2.0, -3.0], [-0.0, 0.0, -0.0]), dt, 50);
    assert_eq!(neutral, run(&c, &record([1.0, 2.0, -3.0], [0.0; 3]), dt, 50));
    // Not finite is invalid, as every field.
    let mut a = vec![0u8; 64 + c.len()];
    assert_eq!(bound::init(&c, &mut a, 0), 0);
    let mut out = [0u8; 256];
    assert_eq!(bound_v2::step(&mut a, &record([0.0; 3], [f64::NAN, 0.0, 0.0]), &mut out, dt), -3);
}

/// Equal thrust on a pair, the lower disk's whole area taking the upper's area-averaged velocity: the induced power over two rotors alone.
#[test]
fn a_coaxial_pair_in_hover_pays_the_closed_form() {
    let (dt, tau, steps) = (1.0 / 800.0, 0.002, 400);
    let area = std::f64::consts::PI * RADIUS * RADIUS;
    let upper = run(&config(dt, 700.0, 1.0e9, tau), &record([0.0; 3], [0.0; 3]), dt, steps);
    let (thrust, upper_power) = (get(&upper, 16), get(&upper, 72) * get(&upper, 80).abs());
    let induced = (thrust / (2.0 * 1.225 * area)).sqrt();
    assert!((upper_power / (thrust * induced) - 1.0).abs() <= 1e-9, "{upper_power} {}", thrust * induced);
    // A tube of half the disk's area at twice the speed: the lower disk's mean is the upper's induced velocity.
    let wake = record([0.0; 3], [0.0, 0.0, -induced]);
    let mut omega = 700.0;
    let mut lower = [0u8; 256];
    for _ in 0..30 {
        lower = run(&config(dt, omega, 1.0e9, tau), &wake, dt, steps);
        omega *= (thrust / get(&lower, 16)).sqrt();
    }
    assert!((get(&lower, 16) / thrust - 1.0).abs() <= 1e-10);
    let lower_power = get(&lower, 72) * get(&lower, 80).abs();
    let factor = (upper_power + lower_power) / (2.0 * upper_power);
    let want = (3.0 + 5.0f64.sqrt()) / 4.0;
    println!("kappa_int {factor:.9}, closed form {want:.9}; lower rotor {:.4} of the upper's power", lower_power / upper_power);
    assert!((factor - want).abs() <= 1e-9, "{factor} against {want}");
}
