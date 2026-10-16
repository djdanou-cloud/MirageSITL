//! G1: count allocator entry points and bytes over one million numerical steps.
use mirage_bet::{
    blade::{Rotor, RotorGeometry, RotorInput},
    flapping::{FlapState, HingeModel},
    inflow::AxialInflow,
    momentum::{angular_momentum, transmitted_moment},
    polar::PolarTable,
    shaft::Shaft,
    Vec3,
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hint::black_box,
    sync::atomic::{AtomicUsize, Ordering},
};
thread_local! {static TRACK:Cell<bool>=const {Cell::new(false)};}
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
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        record(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        record(l.size());
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        record(n);
        unsafe { System.realloc(p, l, n) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}
#[global_allocator]
static ALLOCATOR: Counter = Counter;
#[test]
fn all_scalar_kernels_allocate_zero_over_one_million_steps() {
    let polar = PolarTable::new(
        &[-3.15, 3.15],
        &[1.0, 1e9],
        &[0.0, 1.0],
        &[0.2; 8],
        &[0.02; 8],
    )
    .unwrap();
    let rotor = Rotor::new(
        RotorGeometry {
            blade_count: 2,
            spin_sign: 1,
            radius_m: 0.5,
            cutout_m: 0.1,
            radius: &[0.3],
            chord: &[0.03],
            twist: &[0.0],
            width: &[0.4],
        },
        polar,
        1,
    )
    .unwrap();
    let inflow = AxialInflow::new(1.225, 0.5, 0.1, 50.0).unwrap();
    let shaft = Shaft::new(0.2, 0.02, 1).unwrap();
    let hinge = HingeModel::new(1.0, 100.0, 10.0, 1, 0.2).unwrap();
    let zero = Vec3::new(0.0, 0.0, 0.0);
    let mut flap = FlapState {
        angle: zero,
        rate: zero,
    };
    let mut velocity = 0.0;
    let mut omega = 10.0;
    let mut previous = angular_momentum(0.2, 1, omega, flap).unwrap();
    // Positive control proves this thread's allocator instrument sees real objects.
    TRACK.with(|t| t.set(true));
    let probe = Box::new(black_box(123_u64));
    black_box(&probe);
    drop(probe);
    TRACK.with(|t| t.set(false));
    assert!(CALLS.load(Ordering::Relaxed) > 0);
    CALLS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    TRACK.with(|t| t.set(true));
    for _ in 0..1_000_000 {
        let w = rotor
            .evaluate(RotorInput {
                density_kg_m3: 1.225,
                viscosity_pa_s: 1.8e-5,
                sound_speed_mps: 340.0,
                air_velocity_hub_mps: zero,
                body_rate_hub_rad_s: zero,
                omega_rad_s: omega,
                induced_mps: velocity,
                collective_rad: 0.1,
                cyclic_cos_rad: 0.0,
                cyclic_sin_rad: 0.0,
            })
            .unwrap();
        velocity = inflow
            .step(velocity, w.force_n.z, 0.0, 0.0, 0.0025)
            .unwrap()
            .velocity_mps;
        omega = shaft
            .step(omega, w.moment_nm.z, 0.2, 0.0025)
            .unwrap()
            .omega_rad_s;
        flap = hinge.step(flap, zero, omega, 0.0, 0.0025).unwrap().state;
        let next = angular_momentum(0.2, 1, omega, flap).unwrap();
        black_box(transmitted_moment(w.moment_nm, previous, next, zero, 0.0025).unwrap());
        previous = next;
    }
    TRACK.with(|t| t.set(false));
    assert_eq!(CALLS.load(Ordering::Relaxed), 0);
    assert_eq!(BYTES.load(Ordering::Relaxed), 0);
    assert!(omega.is_finite());
}
