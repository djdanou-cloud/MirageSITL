//! TASK-105, second increment: the ESC shaper record against `EscShaper` itself, declared before the implementation
//! (SPECS_SIMULATION_ENGINES "The ESC and the motor's heat in the flight"): bit for bit over 10,000 random steps on the
//! quantized target, 0.5004 at 2000 steps is 0.5005, a step at a frame boundary arrives after exactly its latency in frames,
//! one invalid record, a wrong version or a short region changes no record, and 1,000,000 steps allocate nothing.
use mirage_bet::esc::{EscShaper, EscShaperState};
use mirage_bet::esc_abi::{self, offset, quantize, RECORD_BYTES};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hint::black_box,
    sync::atomic::{AtomicUsize, Ordering},
};
thread_local! {static TRACK: Cell<bool> = const { Cell::new(false) };}
static CALLS: AtomicUsize = AtomicUsize::new(0);
struct Counter;
fn record_allocation() {
    let _ = TRACK.try_with(|t| if t.get() { CALLS.fetch_add(1, Ordering::Relaxed); });
}
// SAFETY: all allocation operations delegate unchanged to System; tracking is thread-local.
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { record_allocation(); unsafe { System.alloc(l) } }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 { record_allocation(); unsafe { System.alloc_zeroed(l) } }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 { record_allocation(); unsafe { System.realloc(p, l, n) } }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) { unsafe { System.dealloc(p, l) } }
}
#[global_allocator]
static ALLOCATOR: Counter = Counter;

fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn put_word(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
fn value(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }

/// A record with these parameters and zero state.
fn record(period: f64, latency: u32, ramp: f64, start: f64, steps: u32) -> Vec<u8> {
    let mut r = vec![0u8; RECORD_BYTES];
    put_word(&mut r, offset::VERSION, esc_abi::VERSION);
    put_word(&mut r, offset::LATENCY_FRAMES, latency);
    put(&mut r, offset::FRAME_PERIOD, period);
    put(&mut r, offset::RAMP_PER_S, ramp);
    put(&mut r, offset::START_DUTY, start);
    put_word(&mut r, offset::THROTTLE_STEPS, steps);
    r
}
/// A deterministic generator in [0, 1): SplitMix64.
struct Random(u64);
impl Random {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[test]
fn the_record_is_the_shaper_on_the_quantized_target_bit_for_bit() {
    let dt = 1.0 / 1200.0;
    for (latency, ramp, start, steps) in [(0u32, 0.0, 0.0, 0u32), (3, 40.0, 0.06, 2000), (8, 5.0, 0.2, 1000)] {
        let mut r = record(1.0 / 490.0, latency, ramp, start, steps);
        let shaper = EscShaper::new(1.0 / 490.0, latency as usize, if ramp == 0.0 { f64::INFINITY } else { ramp }, start).unwrap();
        let mut state = EscShaperState::default();
        let mut random = Random(7 + u64::from(latency));
        for k in 0..10_000 {
            // Hold a value for a while, with zeros now and then so the motor stops and restarts.
            let target = if k % 997 < 40 { 0.0 } else { random.next() };
            put(&mut r, offset::TARGET, target);
            assert_eq!(esc_abi::step(&mut r, dt), 0);
            let duty = shaper.step(&mut state, quantize(target, steps), dt).unwrap();
            assert_eq!(value(&r, offset::DUTY).to_bits(), duty.to_bits(), "step {k}");
            assert_eq!(value(&r, offset::COMMAND).to_bits(), state.command.to_bits());
            assert_eq!(value(&r, offset::COUNTDOWN).to_bits(), state.countdown_s.to_bits());
        }
    }
}

#[test]
fn quantizes_to_the_throttle_steps_and_delays_by_whole_frames() {
    // 0.5004·2000 = 1000.8 rounds to 1001: the nearest of steps 0.0005 apart (the declaration first said 0.5, an arithmetic slip).
    assert_eq!(quantize(0.5004, 2000), 0.5005);
    assert_eq!(quantize(0.5002, 2000), 0.5);
    assert_eq!(quantize(0.5004, 0), 0.5004);
    // 400 Hz frames stepped at 400 Hz, three frames late: a step entering on frame 0 acts from frame 3.
    let mut r = record(1.0 / 400.0, 3, 0.0, 0.0, 0);
    let mut duties = Vec::new();
    for k in 0..8 {
        put(&mut r, offset::TARGET, if k == 0 { 0.0 } else { 0.4 });
        assert_eq!(esc_abi::step(&mut r, 1.0 / 400.0), 0);
        duties.push(value(&r, offset::DUTY));
    }
    // The 0.4 entered on step 1, so it acts on step 1 + 3 = 4.
    assert_eq!(duties, vec![0.0, 0.0, 0.0, 0.0, 0.4, 0.4, 0.4, 0.4]);
}

#[test]
fn a_bad_record_a_wrong_version_or_a_short_region_changes_nothing() {
    let mut batch = [record(0.002, 1, 0.0, 0.0, 0), record(0.002, 1, 0.0, 0.0, 0)].concat();
    put(&mut batch, offset::TARGET, 0.3);
    put(&mut batch, RECORD_BYTES + offset::TARGET, 0.3);
    assert_eq!(esc_abi::step(&mut batch, 0.001), 0);
    let before = batch.clone();
    // The second record's target outside [0, 1]: nothing at all is written.
    put(&mut batch, RECORD_BYTES + offset::TARGET, 1.5);
    let bad = batch.clone();
    assert_eq!(esc_abi::step(&mut batch, 0.001), -3);
    assert_eq!(batch, bad);
    batch.copy_from_slice(&before);
    put_word(&mut batch, RECORD_BYTES + offset::VERSION, 2);
    let wrong = batch.clone();
    assert_eq!(esc_abi::step(&mut batch, 0.001), -7);
    assert_eq!(batch, wrong);
    batch.copy_from_slice(&before);
    assert_eq!(esc_abi::step(&mut batch[..RECORD_BYTES + 8], 0.001), -2);
    assert_eq!(batch, before);
    for (field, v) in [(offset::FRAME_PERIOD, 0.0), (offset::FRAME_PERIOD, 0.2), (offset::RAMP_PER_S, -1.0), (offset::START_DUTY, 1.0),
        (offset::COUNTDOWN, 0.003)] {
        let mut r = before[..RECORD_BYTES].to_vec();
        put(&mut r, field, v);
        assert_eq!(esc_abi::step(&mut r, 0.001), -3, "field {field}");
    }
    for (field, v) in [(offset::LATENCY_FRAMES, 9u32), (offset::THROTTLE_STEPS, 65_536), (offset::RUNNING, 2), (offset::RESERVED, 1)] {
        let mut r = before[..RECORD_BYTES].to_vec();
        put_word(&mut r, field, v);
        assert_eq!(esc_abi::step(&mut r, 0.001), -3, "field {field}");
    }
}

#[test]
fn a_million_steps_allocate_nothing() {
    let mut batch = [record(1.0 / 490.0, 2, 30.0, 0.05, 2000), record(1.0 / 490.0, 0, 0.0, 0.0, 0)].concat();
    let mut random = Random(11);
    TRACK.with(|t| t.set(true));
    for _ in 0..1_000_000 {
        let target = random.next();
        put(&mut batch, offset::TARGET, target);
        put(&mut batch, RECORD_BYTES + offset::TARGET, target);
        assert_eq!(black_box(esc_abi::step(black_box(&mut batch), 1.0 / 800.0)), 0);
    }
    TRACK.with(|t| t.set(false));
    assert_eq!(CALLS.load(Ordering::Relaxed), 0);
}
