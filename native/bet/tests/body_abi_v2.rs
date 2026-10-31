//! Rigid-body step interface v2 (TASK-088): neutral records reproduce v1 bitwise,
//! invalid and unsupported records leave the output unchanged, zero allocation.
use mirage_bet::{body_abi, body_abi_v2, rigid_body::BodyParameters, Vec3};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hint::black_box,
    sync::atomic::{AtomicUsize, Ordering},
};

thread_local! {static TRACK: Cell<bool> = const { Cell::new(false) };}
static CALLS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
struct Counter;
fn record(bytes: usize) {
    let _ = TRACK.try_with(|t| {
        if t.get() {
            CALLS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(bytes, Ordering::Relaxed);
        }
    });
}
// SAFETY: all allocation operations delegate unchanged to System; tracking is thread-local.
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { record(l.size()); unsafe { System.alloc(l) } }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 { record(l.size()); unsafe { System.alloc_zeroed(l) } }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { record(n); unsafe { System.realloc(p, l, n) } }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { unsafe { System.dealloc(p, l) } }
}
#[global_allocator]
static ALLOCATOR: Counter = Counter;

fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn get(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }
fn word(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
const DT: f64 = 1.0 / 800.0;
fn vector(b: &[u8], p: usize) -> Vec3 { Vec3::new(get(b, p), get(b, p + 8), get(b, p + 16)) }
fn parameters(v2: &[u8]) -> BodyParameters {
    let mut inertia = [0.0; 9];
    for (i, value) in inertia.iter_mut().enumerate() { *value = get(v2, 24 + 8 * i); }
    BodyParameters::new(get(v2, 16), inertia).unwrap()
}

/// A tumbling 1.5 kg body with an inertia product, a body force and moment, as v1 and v2 records.
fn inputs() -> ([u8; 256], [u8; 448]) {
    let n = (0.9f64 * 0.9 + 0.1 * 0.1 + 0.3 * 0.3 + 0.2 * 0.2).sqrt();
    let mut values = vec![1.5, 0.03, 0.0, -0.001, 0.0, 0.032, 0.0, -0.001, 0.0, 0.05, 10.0, -5.0, -20.0, 1.0, 0.5, -0.2,
        0.9 / n, 0.1 / n, -0.3 / n, 0.2 / n, 0.4, -0.3, 0.2, 0.5, -0.2, -15.0, 0.01, -0.02, 0.005];
    values.push(9.80665);
    let mut v1 = [0u8; 256];
    for (i, v) in values.iter().enumerate() { put(&mut v1, 8 * i, *v); }
    v1[240..244].copy_from_slice(&body_abi::VERSION.to_le_bytes());
    let mut v2 = [0u8; 448];
    word(&mut v2, 0, body_abi_v2::VERSION);
    v2[16..256].copy_from_slice(&v1[0..240]);
    (v1, v2)
}

#[test]
fn neutral_v2_reproduces_v1_bitwise_with_a_valid_specific_force() {
    let (mut v1, mut v2) = inputs();
    let (mut o1, mut o2) = ([0u8; 128], [0x77u8; 256]);
    for step in 0..2000 {
        assert_eq!(body_abi::step(&v1, &mut o1, DT), 0);
        assert_eq!(body_abi_v2::step(&v2, &mut o2, DT), 0);
        assert_eq!(o2[0..128], o1[..], "step {step}");
        for axis in 0..3 { assert_eq!(get(&o2, 128 + 8 * axis), get(&v2, 200 + 8 * axis) / 1.5); }
        // TASK-094: with no CG offset the reference point is the CG, and the angular acceleration is Euler's.
        assert_eq!(o2[176..200], o2[0..24]);
        let alpha = parameters(&v2).angular_acceleration(vector(&o2, 80), vector(&v2, 224));
        assert_eq!([get(&o2, 152), get(&o2, 160), get(&o2, 168)], [alpha.x, alpha.y, alpha.z]);
        let all = body_abi_v2::VALID_SPECIFIC_FORCE | body_abi_v2::VALID_ANGULAR_ACCELERATION | body_abi_v2::VALID_REFERENCE_POSITION;
        assert_eq!(o2[200..204], all.to_le_bytes());
        assert!(o2[204..256].iter().all(|v| *v == 0));
        // Feed the state back: position, velocity, quaternion and rates.
        v1[80..184].copy_from_slice(&o1[0..104]);
        v2[96..200].copy_from_slice(&o2[0..104]);
    }
}

#[test]
fn invalid_and_unsupported_records_leave_the_output_unchanged() {
    let (_, valid) = inputs();
    let mut out = [0x5au8; 256];
    type Change = fn(&mut [u8; 448]);
    let cases: [(&str, Change, i32); 17] = [
        ("version 1", |b| word(b, 0, 1), -7),
        ("version 3", |b| word(b, 0, 3), -7),
        ("reserved header word", |b| b[13] = 1, -3),
        ("reserved tail", |b| b[447] = 1, -3),
        ("unknown input flag", |b| word(b, 8, 2), -3),
        ("unknown gravity model", |b| word(b, 4, 3), -3),
        ("NaN mass", |b| put(b, 16, f64::NAN), -3),
        ("infinite inertia rate", |b| put(b, 320, f64::INFINITY), -3),
        ("zero mass", |b| put(b, 16, 0.0), -3),
        ("indefinite inertia", |b| put(b, 24, -0.03), -3),
        ("vector gravity model", |b| word(b, 4, body_abi_v2::GRAVITY_NED_VECTOR), body_abi_v2::UNSUPPORTED),
        ("WGS84 gravity model", |b| word(b, 4, body_abi_v2::GRAVITY_WGS84), body_abi_v2::UNSUPPORTED),
        ("gravity vector", |b| put(b, 272, 9.8), body_abi_v2::UNSUPPORTED),
        ("mass-rate flag", |b| word(b, 8, body_abi_v2::INPUT_MASS_RATES), body_abi_v2::UNSUPPORTED),
        ("mass rate", |b| put(b, 304, -0.01), body_abi_v2::UNSUPPORTED),
        ("inertia rate", |b| put(b, 376, 1e-4), body_abi_v2::UNSUPPORTED),
        ("first inertia rate", |b| put(b, 312, 1e-4), body_abi_v2::UNSUPPORTED),
    ];
    for (label, change, status) in cases {
        let mut input = valid;
        change(&mut input);
        let previous = out;
        assert_eq!(body_abi_v2::step(&input, &mut out, DT), status, "{label}");
        assert_eq!(out, previous, "{label}");
    }
    assert_eq!(body_abi_v2::step(&valid[..447], &mut out, DT), -3);
    assert_eq!(body_abi_v2::step(&valid, &mut [0u8; 128], DT), -3);
    assert_eq!(body_abi_v2::step(&valid, &mut out, 0.0), -3);
}

#[test]
fn v2_body_step_allocates_zero_over_one_million_steps() {
    let (_, input) = inputs();
    let mut out = [0u8; 256];
    CALLS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    TRACK.with(|t| t.set(true));
    let control = black_box(vec![0u8; 32]);
    black_box(control);
    TRACK.with(|t| t.set(false));
    assert!(CALLS.load(Ordering::Relaxed) > 0 && BYTES.load(Ordering::Relaxed) >= 32, "positive control");
    CALLS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    TRACK.with(|t| t.set(true));
    let mut status = 0;
    for _ in 0..1_000_000 {
        status |= black_box(body_abi_v2::step(black_box(&input), &mut out, DT));
    }
    TRACK.with(|t| t.set(false));
    assert_eq!(status, 0);
    assert_eq!(CALLS.load(Ordering::Relaxed), 0);
    assert_eq!(BYTES.load(Ordering::Relaxed), 0);
}

#[test]
fn a_minus_zero_cg_offset_is_neutral() {
    let (mut v1, mut v2) = inputs();
    for p in [280, 288, 296] { put(&mut v2, p, -0.0); }
    let (mut o1, mut o2) = ([0u8; 128], [0u8; 256]);
    for _ in 0..200 {
        assert_eq!(body_abi::step(&v1, &mut o1, DT), 0);
        assert_eq!(body_abi_v2::step(&v2, &mut o2, DT), 0);
        assert_eq!(o2[0..128], o1[..]);
        v1[80..184].copy_from_slice(&o1[0..104]);
        v2[96..200].copy_from_slice(&o2[0..104]);
    }
}

/// Body at rest without gravity, I = diag(0.05, 0.08, 0.1), a body-fixed force F = (0, 0, −10) N
/// through the reference point O and the CG at r_c = (0.01, 0, 0) m from O. The moment about the
/// CG is −r_c × F = (0, −0.1, 0) N m, about a principal axis, so the body turns about y with the
/// exact α = −0.1 / 0.08 = −1.25 rad/s²: ω_y = αt and θ = αt²/2.
#[test]
fn a_cg_offset_turns_a_force_through_the_reference_point_into_an_exact_single_axis_rotation() {
    let mut v2 = [0u8; 448];
    word(&mut v2, 0, body_abi_v2::VERSION);
    put(&mut v2, 16, 2.0);
    for (i, v) in [0.05, 0.0, 0.0, 0.0, 0.08, 0.0, 0.0, 0.0, 0.1].iter().enumerate() { put(&mut v2, 24 + 8 * i, *v); }
    put(&mut v2, 144, 1.0);
    put(&mut v2, 216, -10.0);
    put(&mut v2, 280, 0.01);
    let mut out = [0u8; 256];
    let (hz, alpha) = (400usize, -1.25);
    for k in 1..=hz {
        assert_eq!(body_abi_v2::step(&v2, &mut out, 1.0 / hz as f64), 0);
        let t = k as f64 / hz as f64;
        let theta = 0.5 * alpha * t * t;
        assert!((get(&out, 88) - alpha * t).abs() < 1e-9, "rate at step {k}");
        assert!(get(&out, 80).abs() < 1e-12 && get(&out, 96).abs() < 1e-12);
        assert!((get(&out, 48) - (theta / 2.0).cos()).abs() < 1e-9 && (get(&out, 64) - (theta / 2.0).sin()).abs() < 1e-9, "attitude at step {k}");
        assert!((get(&out, 160) - alpha).abs() < 1e-12, "angular acceleration at step {k}");
        // Reference point O = p_cg − R·r_c, with R a rotation by θ about y.
        let (p, r) = (vector(&out, 0), 0.01);
        let expected = Vec3::new(p.x - r * theta.cos(), p.y, p.z + r * theta.sin());
        let o = vector(&out, 176);
        assert!((o.x - expected.x).abs() < 1e-12 && (o.y - expected.y).abs() < 1e-12 && (o.z - expected.z).abs() < 1e-12, "reference at step {k}");
        v2[96..200].copy_from_slice(&out[0..104]);
    }
}

/// Solves A·x = b for a 6×6 system by Gaussian elimination with partial pivoting.
fn solve6(mut a: [[f64; 6]; 6], mut b: [f64; 6]) -> [f64; 6] {
    for c in 0..6 {
        let pivot = (c..6).max_by(|&i, &j| a[i][c].abs().total_cmp(&a[j][c].abs())).unwrap();
        a.swap(c, pivot);
        b.swap(c, pivot);
        for r in c + 1..6 {
            let f = a[r][c] / a[c][c];
            for k in c..6 { a[r][k] -= f * a[c][k]; }
            b[r] -= f * b[c];
        }
    }
    let mut x = [0.0; 6];
    for r in (0..6).rev() {
        x[r] = (b[r] - (r + 1..6).map(|k| a[r][k] * x[k]).sum::<f64>()) / a[r][r];
    }
    x
}
fn rotate_inverse(q: [f64; 4], v: Vec3) -> Vec3 {
    let [w, x, y, z] = q;
    let (x, y, z) = (-x, -y, -z);
    Vec3::new(
        (1.0 - 2.0 * (y * y + z * z)) * v.x + 2.0 * (x * y - w * z) * v.y + 2.0 * (x * z + w * y) * v.z,
        2.0 * (x * y + w * z) * v.x + (1.0 - 2.0 * (x * x + z * z)) * v.y + 2.0 * (y * z - w * x) * v.z,
        2.0 * (x * z - w * y) * v.x + 2.0 * (y * z + w * x) * v.y + (1.0 - 2.0 * (x * x + y * y)) * v.z,
    )
}

/// The contract's equations about the reference point O, solved as one 6×6 system for the body
/// acceleration of O and ω̇: m(a_O + ω̇ × r_c + ω × (ω × r_c)) = F + m g_b and
/// I_O ω̇ + ω × (I_O ω) + m r_c × a_O = M_O + r_c × m g_b, with I_O = I_cg + m(|r_c|²·1 − r_c r_cᵀ).
/// Their ω̇ must equal the step's angular acceleration at its output state.
#[test]
fn the_step_agrees_with_the_coupled_equations_about_the_reference_point() {
    let (_, mut v2) = inputs();
    let rc = Vec3::new(0.03, -0.02, 0.05);
    put(&mut v2, 280, rc.x); put(&mut v2, 288, rc.y); put(&mut v2, 296, rc.z);
    let mut out = [0u8; 256];
    let (m, g) = (get(&v2, 16), get(&v2, 248));
    let mut icg = [0.0; 9];
    for (i, value) in icg.iter_mut().enumerate() { *value = get(&v2, 24 + 8 * i); }
    let r2 = rc.dot(rc);
    let rr = [rc.x, rc.y, rc.z];
    let mut io = icg;
    for i in 0..3 { for j in 0..3 { io[i * 3 + j] += m * ((if i == j { r2 } else { 0.0 }) - rr[i] * rr[j]); } }
    let mul = |a: [f64; 9], v: Vec3| Vec3::new(a[0] * v.x + a[1] * v.y + a[2] * v.z, a[3] * v.x + a[4] * v.y + a[5] * v.z, a[6] * v.x + a[7] * v.y + a[8] * v.z);
    let mut worst = 0.0_f64;
    for _ in 0..400 {
        assert_eq!(body_abi_v2::step(&v2, &mut out, DT), 0);
        let (w, q) = (vector(&out, 80), [get(&out, 48), get(&out, 56), get(&out, 64), get(&out, 72)]);
        let (force, moment) = (vector(&v2, 200), vector(&v2, 224));
        let gb = rotate_inverse(q, Vec3::new(0.0, 0.0, g));
        // Unknowns x = (a_O, ω̇); skew(v)·u = v × u.
        let skew = |v: Vec3| [[0.0, -v.z, v.y], [v.z, 0.0, -v.x], [-v.y, v.x, 0.0]];
        let mut a = [[0.0; 6]; 6];
        let (s_rc, s_neg) = (skew(rc), skew(rc.scale(-1.0)));
        for i in 0..3 {
            a[i][i] = m;
            for j in 0..3 {
                a[i][3 + j] = m * s_neg[i][j]; // m ω̇ × r_c = −m r_c × ω̇
                a[3 + i][j] = m * s_rc[i][j];
                a[3 + i][3 + j] = io[i * 3 + j];
            }
        }
        let lin = force.add(gb.scale(m)).add(w.cross(w.cross(rc)).scale(-m));
        let ang = moment.add(rc.cross(gb.scale(m))).add(w.cross(mul(io, w)).scale(-1.0));
        let x = solve6(a, [lin.x, lin.y, lin.z, ang.x, ang.y, ang.z]);
        let step_alpha = vector(&out, 152);
        let alpha = Vec3::new(x[3], x[4], x[5]);
        worst = worst.max(step_alpha.add(alpha.scale(-1.0)).norm() / alpha.norm());
        v2[96..200].copy_from_slice(&out[0..104]);
    }
    assert!(worst < 1e-12, "relative difference {worst}");
}

#[test]
fn an_offset_body_step_allocates_zero_over_one_million_steps() {
    let (_, mut input) = inputs();
    put(&mut input, 280, 0.03); put(&mut input, 288, -0.02); put(&mut input, 296, 0.05);
    let mut out = [0u8; 256];
    CALLS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    TRACK.with(|t| t.set(true));
    let mut status = 0;
    for _ in 0..1_000_000 {
        status |= black_box(body_abi_v2::step(black_box(&input), &mut out, DT));
    }
    TRACK.with(|t| t.set(false));
    assert_eq!(status, 0);
    assert_eq!(CALLS.load(Ordering::Relaxed), 0);
    assert_eq!(BYTES.load(Ordering::Relaxed), 0);
}
