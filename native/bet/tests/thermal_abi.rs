//! TASK-105, second increment: the motor thermal record against `MotorThermal` itself, declared before the implementation
//! (SPECS_SIMULATION_ENGINES "The ESC and the motor's heat in the flight"): bit for bit with the iron loss k(T_h)·I₀·|Ω| and
//! R and k by `winding_resistance_ohm` and `torque_constant_at`; one invalid record, a wrong version or a short region
//! changes no record; temperatures outside −60 to 250 °C are refused; 1,000,000 steps allocate nothing.
use mirage_bet::motor::{torque_constant_at, winding_resistance_ohm, MotorThermal, NDFEB_COEFFICIENT_PER_K};
use mirage_bet::thermal_abi::{self, offset, RECORD_BYTES};
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

// A small outrunner: 8 and 25 J/K, 1.5 and 6 K/W, 0.1 s/m of airflow, 0.08 Ω, 2650 KV, 0.6 A no-load current.
const PARAMS: [f64; 8] = [8.0, 25.0, 1.5, 6.0, 0.1, 0.08, 0.0036, 0.6];
fn record(winding: f64, housing: f64) -> Vec<u8> {
    let mut r = vec![0u8; RECORD_BYTES];
    put_word(&mut r, offset::VERSION, thermal_abi::VERSION);
    for (i, v) in PARAMS.iter().enumerate() { put(&mut r, offset::WINDING_CAPACITY + 8 * i, *v); }
    put(&mut r, offset::WINDING_TEMPERATURE, winding);
    put(&mut r, offset::HOUSING_TEMPERATURE, housing);
    r
}
fn inputs(r: &mut [u8], copper: f64, speed: f64, air: f64, airspeed: f64) {
    put(r, offset::COPPER_LOSS, copper);
    put(r, offset::SHAFT_SPEED, speed);
    put(r, offset::AIR_TEMPERATURE, air);
    put(r, offset::AIRSPEED, airspeed);
}

#[test]
fn the_record_is_the_network_with_the_iron_loss_bit_for_bit() {
    let network = MotorThermal::new(PARAMS[0], PARAMS[1], PARAMS[2], PARAMS[3], PARAMS[4]).unwrap();
    let (r20, k20, i0) = (PARAMS[5], PARAMS[6], PARAMS[7]);
    let mut r = record(25.0, 25.0);
    let mut t = [25.0, 25.0];
    let dt = 1.0 / 800.0;
    for k in 0..20_000 {
        // A varying load: 3 to 9 W of copper loss, 1500 to 1900 rad/s, 25 °C air, 8 to 12 m/s past the motor.
        let phase = f64::from(k) * 0.001;
        let (copper, speed, airspeed) = (6.0 + 3.0 * phase.sin(), 1700.0 + 200.0 * phase.cos(), 10.0 + 2.0 * (2.0 * phase).sin());
        inputs(&mut r, copper, speed, 25.0, airspeed);
        assert_eq!(thermal_abi::step(&mut r, dt), 0);
        let iron = torque_constant_at(k20, NDFEB_COEFFICIENT_PER_K, t[1]) * i0 * speed;
        t = network.step(t, copper, iron, 25.0, airspeed, dt).unwrap();
        assert_eq!(value(&r, offset::WINDING_TEMPERATURE).to_bits(), t[0].to_bits(), "step {k}");
        assert_eq!(value(&r, offset::HOUSING_TEMPERATURE).to_bits(), t[1].to_bits());
        assert_eq!(value(&r, offset::IRON_LOSS).to_bits(), iron.to_bits());
        assert_eq!(value(&r, offset::RESISTANCE).to_bits(), winding_resistance_ohm(r20, t[0]).to_bits());
        let kt = torque_constant_at(k20, NDFEB_COEFFICIENT_PER_K, t[1]);
        assert_eq!(value(&r, offset::TORQUE_CONSTANT).to_bits(), kt.to_bits());
        assert_eq!(value(&r, offset::NO_LOAD_TORQUE).to_bits(), (kt * i0).to_bits());
    }
    // 25 s of load heated the winding.
    assert!(t[0] > 30.0 && t[0] > t[1]);
}

#[test]
fn a_bad_record_a_wrong_version_or_a_short_region_changes_nothing() {
    let mut batch = [record(20.0, 20.0), record(20.0, 20.0)].concat();
    inputs(&mut batch[..RECORD_BYTES], 5.0, 1000.0, 20.0, 5.0);
    inputs(&mut batch[RECORD_BYTES..], 5.0, 1000.0, 20.0, 5.0);
    let before = batch.clone();
    put(&mut batch, RECORD_BYTES + offset::COPPER_LOSS, -1.0);
    let bad = batch.clone();
    assert_eq!(thermal_abi::step(&mut batch, 0.01), -3);
    assert_eq!(batch, bad);
    batch.copy_from_slice(&before);
    put_word(&mut batch, RECORD_BYTES + offset::VERSION, 2);
    let wrong = batch.clone();
    assert_eq!(thermal_abi::step(&mut batch, 0.01), -7);
    assert_eq!(batch, wrong);
    batch.copy_from_slice(&before);
    assert_eq!(thermal_abi::step(&mut batch[..RECORD_BYTES - 8], 0.01), -2);
    assert_eq!(batch, before);
    for (field, v) in [(offset::WINDING_CAPACITY, 0.0), (offset::HOUSING_TO_AIR, -1.0), (offset::AIRFLOW_PER_MPS, -0.1),
        (offset::RESISTANCE_20C, 0.0), (offset::NO_LOAD_CURRENT, -0.1), (offset::SHAFT_SPEED, -1.0), (offset::AIRSPEED, f64::NAN),
        (offset::WINDING_TEMPERATURE, 251.0), (offset::AIR_TEMPERATURE, -61.0)] {
        let mut r = before[..RECORD_BYTES].to_vec();
        put(&mut r, field, v);
        assert_eq!(thermal_abi::step(&mut r, 0.01), -3, "field {field}");
    }
    let mut r = before[..RECORD_BYTES].to_vec();
    put_word(&mut r, offset::RESERVED, 1);
    assert_eq!(thermal_abi::step(&mut r, 0.01), -3);
    // A load that would take the winding past 250 °C within the step is refused, not clipped.
    let mut hot = record(240.0, 200.0);
    inputs(&mut hot, 5000.0, 0.0, 20.0, 0.0);
    let saved = hot.clone();
    assert_eq!(thermal_abi::step(&mut hot, 1.0), -3);
    assert_eq!(hot, saved);
}

#[test]
fn a_million_steps_allocate_nothing() {
    let mut batch = [record(25.0, 25.0), record(25.0, 25.0)].concat();
    inputs(&mut batch[..RECORD_BYTES], 6.0, 1700.0, 25.0, 10.0);
    inputs(&mut batch[RECORD_BYTES..], 4.0, 1500.0, 25.0, 9.0);
    TRACK.with(|t| t.set(true));
    for _ in 0..1_000_000 { assert_eq!(black_box(thermal_abi::step(black_box(&mut batch), 1.0 / 1200.0)), 0); }
    TRACK.with(|t| t.set(false));
    assert_eq!(CALLS.load(Ordering::Relaxed), 0);
}
