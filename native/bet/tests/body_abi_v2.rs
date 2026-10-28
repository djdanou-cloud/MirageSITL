//! Rigid-body step interface v2 (TASK-088): neutral records reproduce v1 bitwise,
//! invalid and unsupported records leave the output unchanged, zero allocation.
use mirage_bet::{body_abi, body_abi_v2};
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
        assert!(o2[152..200].iter().all(|v| *v == 0), "later-task outputs stay zero");
        assert_eq!(o2[200..204], body_abi_v2::VALID_SPECIFIC_FORCE.to_le_bytes());
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
    let cases: [(&str, Change, i32); 19] = [
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
        ("CG offset", |b| put(b, 280, 0.01), body_abi_v2::UNSUPPORTED),
        ("mass-rate flag", |b| word(b, 8, body_abi_v2::INPUT_MASS_RATES), body_abi_v2::UNSUPPORTED),
        ("mass rate", |b| put(b, 304, -0.01), body_abi_v2::UNSUPPORTED),
        ("inertia rate", |b| put(b, 376, 1e-4), body_abi_v2::UNSUPPORTED),
        ("first inertia rate", |b| put(b, 312, 1e-4), body_abi_v2::UNSUPPORTED),
        ("CG offset z", |b| put(b, 296, -0.02), body_abi_v2::UNSUPPORTED),
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
