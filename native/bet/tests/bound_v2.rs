//! Bound-rotor step interface v2 (TASK-088): neutral records reproduce v1 bitwise,
//! invalid and unsupported records change nothing, and the step allocates zero.
use mirage_bet::{bound, bound_v2, bus_abi};
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
        // TASK-092 implements drive mode 1; without drive parameters it is invalid.
        ("ESC drive mode without drive parameters", Box::new(|b| word(b, 8, bound_v2::DRIVE_ESC_DUTY)), -3),
        ("drive parameters in torque mode", Box::new(|b| put(b, 192, 0.05)), -3),
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

/// A driven record: the fixture's flow and cyclic values, target duty and bus
/// voltage, and a motor sized for the fixture's 0.5 m rotor.
fn esc_input(duty: f64, voltage: f64) -> Vec<u8> {
    let (_, mut v2) = inputs();
    put(&mut v2, 112, 0.0);
    word(&mut v2, 8, bound_v2::DRIVE_ESC_DUTY);
    put(&mut v2, 120, duty);
    put(&mut v2, 128, voltage);
    // R, k_t, I_max, I_brake, τ₀, command τ, update period.
    for (p, v) in [(192, 0.05), (200, 0.05), (208, 100.0), (216, 50.0), (224, 0.01), (232, 0.02), (240, 0.0)] {
        put(&mut v2, p, v);
    }
    v2
}
fn read(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }
fn read_word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) }

#[test]
fn esc_drive_closes_the_electrical_power_budget_and_reaches_its_torque_balance() {
    let (_, mut arena) = ready();
    let input = esc_input(0.6, 24.0);
    let mut out = [0u8; 256];
    for step in 0..4000 {
        assert_eq!(bound_v2::step(&mut arena, &input, &mut out, DT), 0, "step {step}");
        assert_eq!(read_word(&out, 116), bound_v2::VALID_ELECTRICAL);
        let (current, bus, terminal, copper) = (read(&out, 144), read(&out, 152), read(&out, 160), read(&out, 168));
        // P_terminal = i²R + k_e·i·Ω at one speed; the bus carries it at its voltage.
        assert!((copper - current * current * 0.05).abs() <= 1e-12 * copper.max(1.0));
        assert!((bus * 24.0 - terminal).abs() <= 1e-12 * terminal.abs().max(1.0));
        let omega_used = (terminal - copper) / (0.05 * current);
        assert!(omega_used.is_finite() && omega_used > 0.0);
    }
    // Steady state: k_t·(d·V − k_e·Ω)/R − τ₀ − b·Ω + Q_air = 0 at the final speed (bearing b = 0).
    let omega = read(&out, 72);
    let air = read(&out, 80);
    let electromagnetic = 0.05 * (0.6 * 24.0 - 0.05 * omega) / 0.05;
    assert!((electromagnetic - 0.01 + air).abs() < 1e-6 * electromagnetic, "{electromagnetic} {air}");
    assert_eq!(read_word(&out, 112) & bound_v2::FLAG_CURRENT_LIMITED, 0);
}

#[test]
fn a_power_cut_freewheels_and_a_live_esc_refuses_torque_steps_until_reset() {
    let (_, mut arena) = ready();
    let mut out = [0u8; 256];
    for _ in 0..400 { assert_eq!(bound_v2::step(&mut arena, &esc_input(0.6, 24.0), &mut out, DT), 0); }
    let spinning = read(&out, 72);
    // The ESC state lives in the arena; torque steps are refused while it is live.
    let (_, torque) = inputs();
    let before = arena.clone();
    assert_eq!(bound_v2::step(&mut arena, &torque, &mut out, DT), -3);
    assert_eq!(arena, before);
    let mut cut = esc_input(0.6, 24.0);
    word(&mut cut, 248, bound_v2::DRIVE_POWER_CUT);
    for _ in 0..40 {
        assert_eq!(bound_v2::step(&mut arena, &cut, &mut out, DT), 0);
        assert_eq!((read(&out, 144), read(&out, 160), read(&out, 88)), (0.0, 0.0, 0.0));
    }
    assert!(read(&out, 72) < spinning);
    // A cut returns the ESC to its unpowered state; a reset does the same for a live one.
    assert_eq!(&arena[32..64], &[0u8; 32]);
    assert_eq!(bound_v2::step(&mut arena, &esc_input(0.6, 24.0), &mut out, DT), 0);
    assert_ne!(&arena[32..56], &[0u8; 24]);
    assert_eq!(bound::reset(&mut arena), 0);
    assert_eq!(bound_v2::step(&mut arena, &torque, &mut out, DT), 0);
}

#[test]
fn a_full_command_from_rest_sits_at_the_current_limit_and_says_so() {
    let (_, mut arena) = ready();
    let mut out = [0u8; 256];
    let mut stalled = esc_input(1.0, 24.0);
    put(&mut stalled, 208, 40.0);
    put(&mut stalled, 232, 1e-6);
    assert_eq!(bound_v2::step(&mut arena, &stalled, &mut out, DT), 0);
    assert_ne!(read_word(&out, 112) & bound_v2::FLAG_CURRENT_LIMITED, 0);
    assert!((read(&out, 144) - 40.0).abs() < 1e-12);
}

#[test]
fn invalid_drive_records_change_neither_state_nor_output() {
    let (_, mut arena) = ready();
    let mut out = [0x5au8; 256];
    let cases: Vec<(&str, Box<dyn Fn(&mut Vec<u8>)>)> = vec![
        ("duty above 1", Box::new(|b| put(b, 120, 1.01))),
        ("negative bus voltage", Box::new(|b| put(b, 128, -1.0))),
        ("motor torque in ESC mode", Box::new(|b| put(b, 112, 0.1))),
        ("zero resistance", Box::new(|b| put(b, 192, 0.0))),
        ("negative brake limit", Box::new(|b| put(b, 216, -1.0))),
        ("NaN no-load torque", Box::new(|b| put(b, 224, f64::NAN))),
        ("unknown drive flag", Box::new(|b| word(b, 248, 2))),
        ("reserved tail", Box::new(|b| b[255] = 1)),
    ];
    for (label, change) in cases {
        let mut input = esc_input(0.5, 24.0);
        change(&mut input);
        let (before, previous) = (arena.clone(), out);
        assert_eq!(bound_v2::step(&mut arena, &input, &mut out, DT), -3, "{label}");
        assert_eq!(arena, before, "{label}");
        assert_eq!(out, previous, "{label}");
    }
}

#[test]
fn esc_steps_allocate_zero_over_one_million_steps() {
    let input = esc_input(0.55, 24.0);
    let (_, mut arena) = ready();
    let mut out = [0u8; 256];
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

#[test]
fn bus_steps_allocate_zero_over_one_million_steps() {
    let mut input = vec![0u8; 128];
    input[0..4].copy_from_slice(&bus_abi::VERSION.to_le_bytes());
    for (p, v) in [(8, 16.8), (16, 13.2), (24, 0.05), (32, 18000.0), (40, 60.0), (48, 0.9), (56, 180.0)] { put(&mut input, p, v); }
    let mut out = [0u8; 128];
    CALLS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    TRACK.with(|t| t.set(true));
    let mut status = 0;
    for _ in 0..1_000_000 {
        status |= black_box(bus_abi::step(&input, &mut out, DT));
    }
    TRACK.with(|t| t.set(false));
    assert_eq!(status, 0);
    assert_eq!(CALLS.load(Ordering::Relaxed), 0);
    assert_eq!(BYTES.load(Ordering::Relaxed), 0);
}

/// TASK-091: both opt-in kernel modes (configuration version 2) allocate nothing over 1e6 steps,
/// in hover (hover sampling engaged) and in forward flight (hover sampling off).
#[test]
fn opt_in_kernel_modes_allocate_zero_over_one_million_steps() {
    let (mut c, _, _) = fixture();
    word(&mut c, 0, bound::CONFIG_VERSION_OPTIONS);
    word(&mut c, 36, bound::OPTION_REDUCED_PREDICTOR | bound::OPTION_HOVER_SAMPLING);
    let mut arena = vec![0u8; 64 + c.len()];
    assert_eq!(bound::init(&c, &mut arena, 0), 0);
    let (_, mut input) = inputs();
    let mut out = [0u8; 256];
    for forward in [0.0, 3.0] {
        put(&mut input, 40, forward);
        // Body rates, cyclic and drive torque from `inputs`; zero them for the hover case.
        for at in [64, 72, 80, 96, 104] { put(&mut input, at, if forward == 0.0 { 0.0 } else { 0.01 }); }
        CALLS.store(0, Ordering::Relaxed);
        BYTES.store(0, Ordering::Relaxed);
        TRACK.with(|t| t.set(true));
        let mut status = 0;
        for _ in 0..500_000 {
            status |= black_box(bound_v2::step(&mut arena, &input, &mut out, DT));
        }
        TRACK.with(|t| t.set(false));
        assert_eq!(status, 0);
        assert_eq!((CALLS.load(Ordering::Relaxed), BYTES.load(Ordering::Relaxed)), (0, 0));
        // The hover case ran with hover sampling, the forward case without.
        assert_eq!(read_word(&out, 112) & bound::FLAG_HOVER_SAMPLING != 0, forward == 0.0, "forward {forward}");
        assert!(read_word(&out, 112) & bound::FLAG_REDUCED_PREDICTOR != 0);
    }
}
