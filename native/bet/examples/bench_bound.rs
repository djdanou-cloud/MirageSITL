//! TASK-091: native timing of the production bound-rotor step (v1 record,
//! torque drive) on a configuration written by `scripts/bench-bet.mjs`.
//!
//!   cargo run --release --locked -p mirage-bet --example bench_bound -- CONFIG HZ STEPS
//!
//! Prints one JSON line with per-step mean, p50, p95, p99 and max in
//! microseconds after 20,000 warm-up steps, and the final shaft speed and hub
//! force z, for the production step and for `bound::step_reference` (the
//! kernel before TASK-091) on twin arenas in the same process. This is host
//! compute timing only, not browser, Worker or target-hardware evidence.
use mirage_bet::bound;
use std::time::Instant;

fn put(b: &mut [u8], at: usize, v: f64) {
    b[at..at + 8].copy_from_slice(&v.to_le_bytes());
}
fn get(b: &[u8], at: usize) -> f64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[at..at + 8]);
    f64::from_le_bytes(x)
}
fn quantile(sorted: &[f64], q: f64) -> f64 {
    sorted[((q * sorted.len() as f64) as usize).min(sorted.len() - 1)]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("Expected CONFIG HZ STEPS");
        std::process::exit(2);
    }
    let config = std::fs::read(&args[1]).expect("readable configuration");
    let hz: f64 = args[2].parse().expect("rate");
    let steps: usize = args[3].parse().expect("step count");
    if steps < 1000 || ![400.0, 800.0, 1200.0].contains(&hz) {
        eprintln!("Expected HZ 400, 800 or 1200 and at least 1000 steps");
        std::process::exit(2);
    }
    let production = run(&config, hz, steps, bound::step);
    let reference = run(&config, hz, steps, bound::step_reference);
    println!("{{\"hz\":{},\"steps\":{},\"warmupSteps\":20000,\"production\":{},\"reference\":{}}}", hz, steps, production, reference);
}

type Step = fn(&mut [u8], &[u8], &mut [u8], f64) -> i32;

/// Times `steps` steps of one kernel on a fresh arena; returns a JSON object.
fn run(config: &[u8], hz: f64, steps: usize, step: Step) -> String {
    // u64 storage keeps the arena 8-byte aligned, as the ABI requires.
    let mut words = vec![0u64; (bound::ARENA_HEADER + config.len()).div_ceil(8)];
    // SAFETY: the u64 buffer outlives the byte view, which covers exactly its bytes.
    let arena = unsafe { std::slice::from_raw_parts_mut(words.as_mut_ptr().cast::<u8>(), words.len() * 8) };
    let arena = &mut arena[..bound::ARENA_HEADER + config.len()];
    assert_eq!(bound::init(config, arena, 0), 0, "configuration rejected");
    let mut input = [0u8; bound::INPUT_BYTES as usize];
    input[0..4].copy_from_slice(&bound::VERSION.to_le_bytes());
    // ISA sea level, still air, a fixed motor torque that settles near hover speed.
    put(&mut input, 8, 1.225);
    put(&mut input, 16, 1.7894e-5);
    put(&mut input, 24, 340.294);
    put(&mut input, 104, 0.12);
    let mut out = [0u8; bound::OUTPUT_BYTES as usize];
    let dt = 1.0 / hz;
    for _ in 0..20_000 {
        assert_eq!(step(arena, &input, &mut out, dt), 0, "warm-up step failed");
    }
    let mut samples = vec![0.0f64; steps];
    for sample in samples.iter_mut() {
        let start = Instant::now();
        let status = step(arena, &input, &mut out, dt);
        *sample = start.elapsed().as_nanos() as f64 / 1e3;
        assert_eq!(status, 0, "timed step failed");
    }
    let mean = samples.iter().sum::<f64>() / steps as f64;
    samples.sort_by(f64::total_cmp);
    format!(
        "{{\"meanUs\":{},\"p50Us\":{},\"p95Us\":{},\"p99Us\":{},\"maxUs\":{},\"omegaRadS\":{},\"hubForceZN\":{}}}",
        mean, quantile(&samples, 0.5), quantile(&samples, 0.95), quantile(&samples, 0.99),
        samples[steps - 1], get(&out, 72), get(&out, 16)
    )
}
