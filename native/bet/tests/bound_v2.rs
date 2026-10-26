//! Bound-rotor step interface v2 (TASK-088): neutral records reproduce v1 bitwise,
//! invalid and unsupported records change nothing, and the step allocates zero.
use mirage_bet::{bound, bound_v2};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hint::black_box,
    sync::atomic::{AtomicUsize, Ordering},
};
#[path = "support/bound_fixture.rs"]
mod fixture_data;
use fixture_data::fixture;

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
fn word(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
const DT: f64 = 1.0 / 400.0;

/// The fixture's v1 input with forward flight, body rates, cyclic and drive torque,
/// and the same values in a v2 record.
fn inputs() -> (Vec<u8>, Vec<u8>) {
    let (_, _, mut v1) = fixture();
    for (p, v) in [(32, 3.0), (40, -0.5), (48, -1.0), (56, 0.05), (64, -0.1), (72, 0.02), (80, 0.04), (88, 0.01), (96, -0.01), (104, 0.03)] {
        put(&mut v1, p, v);
    }
    let mut v2 = vec![0u8; bound_v2::INPUT_BYTES as usize];
    word(&mut v2, 0, bound_v2::VERSION);
    v2[16..120].copy_from_slice(&v1[8..112]);
    (v1, v2)
}
fn ready() -> (Vec<u8>, Vec<u8>) {
    let (c, mut a, _) = fixture();
    assert_eq!(bound::init(&c, &mut a, 0), 0);
    (c, a)
}

#[test]
fn neutral_v2_reproduces_v1_bitwise_and_reports_no_later_task_outputs() {
    let (v1, v2) = inputs();
    let (_, mut a1) = ready();
    let (_, mut a2) = ready();
    let (mut o1, mut o2) = ([0u8; 128], [0x77u8; 256]);
    for step in 0..2000 {
        assert_eq!(bound::step(&mut a1, &v1, &mut o1, DT), 0);
        assert_eq!(bound_v2::step(&mut a2, &v2, &mut o2, DT), 0);
        assert_eq!(o2[0..128], o1[..], "step {step}");
        assert!(o2[128..256].iter().all(|v| *v == 0));
        assert_eq!(a1, a2);
    }
    // The validity word at 116 is zero, and v1 leaves 104 (cone) and 116 zero too.
    assert_eq!(o2[116..120], [0, 0, 0, 0]);
    // -0 counts as neutral for a later-task field.
    let mut negative_zero = v2.clone();
    put(&mut negative_zero, 136, -0.0);
    assert_eq!(bound_v2::step(&mut a2, &negative_zero, &mut o2, DT), 0);
}

#[test]
fn invalid_and_unsupported_records_change_neither_state_nor_output() {
    let (_, valid) = inputs();
    let (_, mut arena) = ready();
    let mut out = [0x5au8; 256];
    let cases: Vec<(&str, Box<dyn Fn(&mut Vec<u8>)>, i32)> = vec![
        ("version 1", Box::new(|b| word(b, 0, 1)), -7),
        ("version 3", Box::new(|b| word(b, 0, 3)), -7),
        ("reserved header word", Box::new(|b| b[12] = 1), -3),
        ("reserved tail", Box::new(|b| b[255] = 1), -3),
        ("unknown input flag", Box::new(|b| word(b, 4, 2)), -3),
        ("unknown drive mode", Box::new(|b| word(b, 8, 2)), -3),
        ("NaN density", Box::new(|b| put(b, 16, f64::NAN)), -3),
        ("infinite wake", Box::new(|b| put(b, 136, f64::INFINITY)), -3),
        ("negative density", Box::new(|b| put(b, 16, -1.225)), -3),
        ("ESC drive mode", Box::new(|b| word(b, 8, bound_v2::DRIVE_ESC_DUTY)), bound_v2::UNSUPPORTED),
        ("ESC duty in torque mode", Box::new(|b| put(b, 120, 0.5)), bound_v2::UNSUPPORTED),
        ("bus voltage", Box::new(|b| put(b, 128, 16.8)), bound_v2::UNSUPPORTED),
        ("external wake", Box::new(|b| put(b, 144, 1.0)), bound_v2::UNSUPPORTED),
        ("ground plane flag", Box::new(|b| word(b, 4, bound_v2::INPUT_GROUND_PLANE)), bound_v2::UNSUPPORTED),
        ("ground normal", Box::new(|b| put(b, 176, -1.0)), bound_v2::UNSUPPORTED),
        ("ground distance", Box::new(|b| put(b, 184, 0.5)), bound_v2::UNSUPPORTED),
    ];
    for (label, change, status) in cases {
        let mut input = valid.clone();
        change(&mut input);
        let (before, previous) = (arena.clone(), out);
        assert_eq!(bound_v2::step(&mut arena, &input, &mut out, DT), status, "{label}");
        assert_eq!(arena, before, "{label}");
        assert_eq!(out, previous, "{label}");
    }
    let before = arena.clone();
    assert_eq!(bound_v2::step(&mut arena, &valid[..255], &mut out, DT), -2);
    assert_eq!(bound_v2::step(&mut arena, &valid, &mut [0u8; 128], DT), -2);
    // v1 statuses pass through: a mismatched dt and a disposed arena.
    assert_eq!(bound_v2::step(&mut arena, &valid, &mut out, 1.0 / 800.0), -4);
    assert_eq!(arena, before);
    bound::dispose(&mut arena);
    assert_eq!(bound_v2::step(&mut arena, &valid, &mut out, DT), -1);
}

#[test]
fn v2_step_allocates_zero_over_one_million_steps() {
    let (_, input) = inputs();
    let (_, mut arena) = ready();
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
        status |= black_box(bound_v2::step(&mut arena, &input, &mut out, DT));
    }
    TRACK.with(|t| t.set(false));
    assert_eq!(status, 0);
    assert_eq!(CALLS.load(Ordering::Relaxed), 0);
    assert_eq!(BYTES.load(Ordering::Relaxed), 0);
}
