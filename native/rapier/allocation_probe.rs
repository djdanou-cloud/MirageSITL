//! Pinned profiler-free f64 Rapier allocation diagnostic; not a production backend.
use rapier3d_f64::prelude::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
struct Count;
static TRACK: AtomicBool = AtomicBool::new(false);
static CALLS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);
// SAFETY: the allocator forwards each pointer/layout unchanged to System.
// Relaxed atomic counters do not allocate and cannot recurse into this allocator.
unsafe impl GlobalAlloc for Count {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        if TRACK.load(Ordering::Relaxed) {
            CALLS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(l.size() as u64, Ordering::Relaxed);
        }
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}
#[global_allocator]
static ALLOC: Count = Count;
fn main() {
    let mut world = PhysicsWorld::new();
    world.gravity = Vector::new(0.0, 0.0, 9.80665);
    world.integration_parameters.dt = 1.0 / 400.0;
    world.insert(
        RigidBodyBuilder::fixed(),
        ColliderBuilder::halfspace(nalgebra::Unit::new_unchecked(Vector::new(0.0, 0.0, -1.0))),
    );
    let (ball, _) = world.insert(
        RigidBodyBuilder::dynamic()
            .can_sleep(false)
            .translation(Vector::new(0.0, 0.0, -1.0)),
        ColliderBuilder::ball(0.1).mass(1.0),
    );
    for i in 0..100000 {
        world.bodies[ball].reset_forces(false);
        world.bodies[ball].add_force(
            Vector::new(0.0, 0.0, if i % 800 < 100 { -19.6133 } else { 0.0 }),
            true,
        );
        world.step();
    }
    TRACK.store(true, Ordering::Relaxed);
    let positive = Box::new(std::hint::black_box(123_u64));
    std::hint::black_box(&positive);
    drop(positive);
    TRACK.store(false, Ordering::Relaxed);
    assert!(CALLS.load(Ordering::Relaxed) > 0);
    CALLS.store(0, Ordering::Relaxed);
    BYTES.store(0, Ordering::Relaxed);
    let mut trajectory_hash = 14695981039346656037_u64;
    TRACK.store(true, Ordering::Relaxed);
    for i in 0..1000000 {
        world.bodies[ball].reset_forces(false);
        world.bodies[ball].add_force(
            Vector::new(0.0, 0.0, if i % 800 < 100 { -19.6133 } else { 0.0 }),
            true,
        );
        world.step();
        let body = &world.bodies[ball];
        let p = body.translation();
        let v = body.linvel();
        let w = body.angvel();
        let q = body.rotation().to_array();
        for value in [
            p.x, p.y, p.z, v.x, v.y, v.z, q[0], q[1], q[2], q[3], w.x, w.y, w.z,
        ] {
            assert!(value.is_finite());
            for byte in value.to_bits().to_le_bytes() {
                trajectory_hash = (trajectory_hash ^ byte as u64).wrapping_mul(1099511628211);
            }
        }
    }
    TRACK.store(false, Ordering::Relaxed);
    println!("{{\"schemaVersion\":1,\"engineVersion\":\"0.36.0\",\"steps\":1000000,\"allocationCalls\":{},\"allocationBytes\":{},\"finalDownM\":{},\"trajectoryHash\":\"{:016x}\"}}",CALLS.load(Ordering::Relaxed),BYTES.load(Ordering::Relaxed),world.bodies[ball].translation().z,trajectory_hash);
    if CALLS.load(Ordering::Relaxed) > 0 {
        std::process::exit(2);
    }
}
