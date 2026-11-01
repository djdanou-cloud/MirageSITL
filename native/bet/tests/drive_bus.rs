//! ESC drive step on the shared bus (TASK-092). Oracles: the per-rotor
//! `bound_v2::step` and `bus_abi::step` it must equal bit for bit while the pack
//! is within its limit; the battery's energy identity source = loss + delivered
//! = summed terminal power + house load on limited steps; each rotor stepped
//! alone at the reported supply voltage; and the next voltage above the supply
//! exceeding the limit.
use mirage_bet::{bound, bound_v2, bus_abi, drive_bus};
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

const DT: f64 = 1.0 / 400.0;
fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn word(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }
fn read(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }
fn read_word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes(b[p..p + 4].try_into().unwrap()) }

/// A drive-mode-1 record for the fixture rotor (R 0.05 Ω, k_t 0.05 N·m/A, 100 A, 50 A braking, τ₀ 0.01 N·m).
fn esc_input(duty: f64, voltage: f64) -> Vec<u8> {
    let (_, _, v1) = fixture();
    let mut v2 = vec![0u8; bound_v2::INPUT_BYTES as usize];
    word(&mut v2, 0, bound_v2::VERSION);
    v2[16..120].copy_from_slice(&v1[8..112]);
    word(&mut v2, 8, bound_v2::DRIVE_ESC_DUTY);
    put(&mut v2, 120, duty);
    put(&mut v2, 128, voltage);
    for (p, v) in [(192, 0.05), (200, 0.05), (208, 100.0), (216, 50.0), (224, 0.01), (232, 0.02), (240, 0.0)] {
        put(&mut v2, p, v);
    }
    v2
}
fn arena() -> Vec<u8> {
    let (c, mut a, _) = fixture();
    assert_eq!(bound::init(&c, &mut a, 0), 0);
    a
}
/// 6S pack: open circuit 19.8–25.2 V, 20 mΩ, 5 Ah, the given current limit, house load in W.
fn bus_input(soc: f64, limit_a: f64, house_w: f64) -> Vec<u8> {
    let mut b = vec![0u8; bus_abi::INPUT_BYTES as usize];
    word(&mut b, 0, bus_abi::VERSION);
    for (p, v) in [(8, 25.2), (16, 19.8), (24, 0.02), (32, 18000.0), (40, limit_a), (48, soc), (64, house_w)] { put(&mut b, p, v); }
    b
}
const FULL: f64 = 25.2;
const EMPTY: f64 = 19.8;
const R_INT: f64 = 0.02;
fn open_circuit(soc: f64) -> f64 { EMPTY + (FULL - EMPTY) * soc }

struct Rig { arenas: Vec<Vec<u8>>, inputs: Vec<Vec<u8>>, outputs: Vec<Vec<u8>> }
impl Rig {
    fn new(duties: &[f64], voltage: f64) -> Self {
        Rig { arenas: duties.iter().map(|_| arena()).collect(), inputs: duties.iter().map(|d| esc_input(*d, voltage)).collect(),
            outputs: duties.iter().map(|_| vec![0u8; 256]).collect() }
    }
    fn set_voltage(&mut self, v: f64) { for i in &mut self.inputs { put(i, 128, v); } }
    fn step(&mut self, bus: &[u8], out: &mut [u8]) -> i32 {
        let mut rotors: Vec<drive_bus::DriveRotor<'_>> = self.arenas.iter_mut().zip(self.inputs.iter()).zip(self.outputs.iter_mut())
            .map(|((arena, input), output)| drive_bus::DriveRotor { arena, input, output }).collect();
        drive_bus::step(&mut rotors, bus, out, DT)
    }
}

#[test]
fn within_the_limit_the_step_is_the_rotor_steps_and_the_bus_bit_for_bit() {
    // A pack whose 400 A limit the four motors never reach; a 5 W house load.
    let duties = [0.55, 0.6, 0.65, 0.7];
    let mut drive = Rig::new(&duties, open_circuit(0.9));
    let mut alone = Rig::new(&duties, open_circuit(0.9));
    let (mut soc, mut voltage) = (0.9, open_circuit(0.9));
    let mut out = [0u8; 128];
    let mut bus_out = [0u8; 128];
    for step in 0..2000 {
        drive.set_voltage(voltage);
        alone.set_voltage(voltage);
        let bus = bus_input(soc, 400.0, 5.0);
        assert_eq!(drive.step(&bus, &mut out), 0, "step {step}");
        let mut terminal = 0.0;
        for k in 0..duties.len() {
            assert_eq!(bound_v2::step(&mut alone.arenas[k], &alone.inputs[k], &mut alone.outputs[k], DT), 0);
            terminal += read(&alone.outputs[k], 160);
        }
        let mut separate = bus.clone();
        put(&mut separate, 56, terminal);
        assert_eq!(bus_abi::step(&separate, &mut bus_out, DT), 0);
        assert_eq!(drive.arenas, alone.arenas, "step {step}");
        assert_eq!(drive.outputs, alone.outputs, "step {step}");
        assert_eq!(out[0..52], bus_out[0..52], "step {step}");
        assert_eq!(read_word(&out, 48), 0);
        assert_eq!(read(&out, 56).to_bits(), voltage.to_bits());
        assert_eq!(read(&out, 64).to_bits(), terminal.to_bits());
        assert!(out[52..56].iter().chain(out[72..128].iter()).all(|b| *b == 0));
        (soc, voltage) = (read(&out, 0), read(&out, 8));
    }
    assert!(read(&out, 16) > 1.0, "the motors load the pack");
}

#[test]
fn a_pack_at_its_limit_lowers_the_supply_until_the_motors_draw_what_it_delivers() {
    // A 5 A limit: about 125 W against several hundred watts of demand at full voltage.
    let duties = [0.5, 0.6, 0.7, 0.8];
    let mut drive = Rig::new(&duties, open_circuit(1.0));
    let (mut soc, mut voltage) = (1.0, open_circuit(1.0));
    let mut out = [0u8; 128];
    let (mut limited, mut regenerating) = (0, 0);
    for step in 0..4000 {
        drive.set_voltage(voltage);
        let before = drive.arenas.clone();
        let bus = bus_input(soc, 5.0, 3.0);
        assert_eq!(drive.step(&bus, &mut out), 0, "step {step}");
        let (next, pack_v, current) = (read(&out, 0), read(&out, 8), read(&out, 16));
        let (delivered, loss, source, supply, motors) = (read(&out, 24), read(&out, 32), read(&out, 40), read(&out, 56), read(&out, 64));
        let voc = open_circuit(soc);
        // The battery's identities on every step: source = loss + delivered, V = Voc − I·R, charge integral.
        assert!((source - (loss + delivered)).abs() <= 1e-12 * source.abs().max(1.0), "step {step}");
        assert!((pack_v - (voc - current * R_INT)).abs() <= 1e-12 * voc);
        assert_eq!(next, (soc - current * DT / 18000.0).clamp(0.0, 1.0));
        // The motors receive what the pack delivers: delivered = Σ terminal + house.
        let mut terminal = 0.0;
        for o in &drive.outputs { terminal += read(o, 160); }
        assert_eq!(terminal.to_bits(), motors.to_bits());
        assert!(current <= 5.0 * (1.0 + 1e-12), "step {step}: {current}");
        let flagged = read_word(&out, 48) & drive_bus::FLAG_POWER_LIMITED != 0;
        if flagged && current < 0.0 {
            // Braking beyond the pack's charge-current limit, unchanged by the drive step: the pack
            // absorbs its limit and the excess braking power is not stored.
            regenerating += 1;
            assert_eq!(supply.to_bits(), voltage.to_bits());
            assert!((current + 5.0).abs() <= 1e-12 * 5.0);
            assert!(terminal + 3.0 < delivered);
            (soc, voltage) = (next, pack_v);
            continue;
        }
        assert!((delivered - (terminal + 3.0)).abs() <= 1e-12 * delivered.abs().max(1.0), "step {step}: {delivered} {terminal}");
        if flagged {
            limited += 1;
            assert!(supply < voltage, "step {step}");
            // The pack sits at its current limit.
            assert!((current - 5.0).abs() <= 1e-9, "step {step}: {current}");
            // Each rotor alone at the supply voltage gives the same step, bit for bit.
            for k in 0..duties.len() {
                let mut a = before[k].clone();
                let mut o = vec![0u8; 256];
                let mut input = drive.inputs[k].clone();
                put(&mut input, 128, supply);
                assert_eq!(bound_v2::step(&mut a, &input, &mut o, DT), 0);
                assert_eq!(a, drive.arenas[k], "step {step} rotor {k}");
                assert_eq!(o, drive.outputs[k], "step {step} rotor {k}");
                // The bus current is carried at the supply voltage: P/V times V, within two roundings.
                assert!((read(&o, 152) * supply - read(&o, 160)).abs() <= 4.0 * f64::EPSILON * read(&o, 160).abs());
            }
            // The supply is the highest voltage within the limit: one double above, the demand exceeds it.
            if step % 97 == 0 {
                let mut above = 0.0;
                for k in 0..duties.len() {
                    let mut a = before[k].clone();
                    let mut o = vec![0u8; 256];
                    let mut input = drive.inputs[k].clone();
                    put(&mut input, 128, supply.next_up());
                    assert_eq!(bound_v2::step(&mut a, &input, &mut o, DT), 0);
                    above += read(&o, 160);
                }
                let max_power = 5.0 * (voc - 5.0 * R_INT);
                assert!(3.0 + above > max_power * (1.0 - 1e-12), "step {step}");
            }
        } else {
            assert_eq!(supply.to_bits(), voltage.to_bits());
        }
        (soc, voltage) = (next, pack_v);
    }
    assert!(limited > 3000, "{limited} limited steps");
    // Only the first steps, while the ESC duty rises from zero, brake the initial 100 rad/s.
    assert!(regenerating < 20, "{regenerating} regenerating steps");
    // The starved motors settle far below their unlimited speed.
    let mut free = Rig::new(&duties, open_circuit(1.0));
    let (mut s, mut v) = (1.0, open_circuit(1.0));
    let mut o = [0u8; 128];
    for _ in 0..4000 {
        free.set_voltage(v);
        assert_eq!(free.step(&bus_input(s, 400.0, 3.0), &mut o), 0);
        (s, v) = (read(&o, 0), read(&o, 8));
    }
    for k in 0..duties.len() { assert!(read(&drive.outputs[k], 72) < 0.8 * read(&free.outputs[k], 72), "rotor {k}"); }
}

#[test]
fn a_house_load_above_the_limit_leaves_the_motors_unpowered() {
    let mut drive = Rig::new(&[0.8, 0.8], open_circuit(1.0));
    let mut out = [0u8; 128];
    // Spin up on an ample pack, then a 2 A limit (about 50 W) under a 100 W house load.
    let (mut soc, mut voltage) = (1.0, open_circuit(1.0));
    for _ in 0..200 {
        drive.set_voltage(voltage);
        assert_eq!(drive.step(&bus_input(soc, 400.0, 0.0), &mut out), 0);
        (soc, voltage) = (read(&out, 0), read(&out, 8));
    }
    assert!(read(&out, 64) > 100.0);
    drive.set_voltage(voltage);
    let max_power = 2.0 * (open_circuit(soc) - 2.0 * R_INT);
    assert_eq!(drive.step(&bus_input(soc, 2.0, 100.0), &mut out), 0);
    assert_eq!(read(&out, 56), 0.0);
    assert_eq!(read(&out, 64), 0.0);
    for o in &drive.outputs { assert_eq!((read(o, 144), read(o, 160)), (0.0, 0.0)); }
    assert_ne!(read_word(&out, 48) & drive_bus::FLAG_POWER_LIMITED, 0);
    assert!((read(&out, 24) - max_power).abs() <= 1e-12 * max_power);
}

#[test]
fn invalid_steps_change_no_arena_and_no_output() {
    let mut drive = Rig::new(&[0.6, 0.6, 0.6], 24.0);
    let mut out = [0x5au8; 128];
    for _ in 0..20 { assert_eq!(drive.step(&bus_input(1.0, 5.0, 0.0), &mut out), 0); }
    out = [0x5au8; 128];
    let cases: Vec<(&str, Box<dyn Fn(&mut Rig, &mut Vec<u8>)>, i32)> = vec![
        ("unequal bus voltages", Box::new(|r, _| put(&mut r.inputs[2], 128, 23.9)), -3),
        ("motor power in the bus record", Box::new(|_, b| put(b, 56, 1.0)), -3),
        ("torque-mode rotor", Box::new(|r, _| { r.inputs[1] = esc_input(0.0, 0.0); word(&mut r.inputs[1], 8, 0); r.inputs[1][192..256].fill(0); put(&mut r.inputs[1], 120, 0.0); put(&mut r.inputs[1], 128, 0.0); }), -3),
        ("bus version", Box::new(|_, b| word(b, 0, 2)), -7),
        ("rotor version", Box::new(|r, _| word(&mut r.inputs[0], 0, 1)), -7),
        ("invalid charge", Box::new(|_, b| put(b, 48, 1.5)), -3),
        ("unknown drive flag", Box::new(|r, _| word(&mut r.inputs[1], 248, 2)), -3),
        ("external wake", Box::new(|r, _| put(&mut r.inputs[0], 144, 1.0)), bound_v2::UNSUPPORTED),
    ];
    for (label, change, status) in cases {
        let mut rig = Rig { arenas: drive.arenas.clone(), inputs: drive.inputs.clone(), outputs: drive.outputs.clone() };
        let mut bus = bus_input(1.0, 5.0, 0.0);
        change(&mut rig, &mut bus);
        let (arenas, outputs) = (rig.arenas.clone(), rig.outputs.clone());
        assert_eq!(rig.step(&bus, &mut out), status, "{label}");
        assert_eq!(rig.arenas, arenas, "{label}");
        assert_eq!(rig.outputs, outputs, "{label}");
        assert_eq!(out, [0x5au8; 128], "{label}");
    }
    let bus = bus_input(1.0, 5.0, 0.0);
    let (arenas, outputs) = (drive.arenas.clone(), drive.outputs.clone());
    assert_eq!(drive_bus::step(&mut [], &bus, &mut out, DT), -2);
    assert_eq!(drive.step(&bus, &mut [0u8; 64]), -2);
    assert_eq!(drive.step(&bus[..127], &mut out), -2);
    {
        let mut rotors: Vec<drive_bus::DriveRotor<'_>> = drive.arenas.iter_mut().zip(drive.inputs.iter()).zip(drive.outputs.iter_mut())
            .map(|((arena, input), output)| drive_bus::DriveRotor { arena, input, output }).collect();
        assert_eq!(drive_bus::step(&mut rotors, &bus, &mut out, 1.0 / 800.0), -4);
    }
    assert_eq!((&drive.arenas, &drive.outputs), (&arenas, &outputs));
    bound::dispose(&mut drive.arenas[1]);
    assert_eq!(drive.step(&bus, &mut out), -1);
    assert_eq!(out, [0x5au8; 128]);
    let mut many: Vec<Vec<u8>> = (0..33).map(|_| arena()).collect();
    let input = esc_input(0.5, 24.0);
    let mut outs: Vec<Vec<u8>> = (0..33).map(|_| vec![0u8; 256]).collect();
    let mut rotors: Vec<drive_bus::DriveRotor<'_>> = many.iter_mut().zip(outs.iter_mut())
        .map(|(arena, output)| drive_bus::DriveRotor { arena, input: &input, output }).collect();
    assert_eq!(drive_bus::step(&mut rotors, &bus, &mut out, DT), -2);
}

#[test]
fn drive_steps_allocate_zero_within_and_at_the_limit() {
    for (limit, steps) in [(400.0, 300_000), (5.0, 300_000)] {
        let mut drive = Rig::new(&[0.6, 0.7, 0.8, 0.9], open_circuit(1.0));
        let bus = bus_input(1.0, limit, 3.0);
        let mut out = [0u8; 128];
        for _ in 0..100 { assert_eq!(drive.step(&bus, &mut out), 0); }
        let flags = read_word(&out, 48);
        assert_eq!(flags & drive_bus::FLAG_POWER_LIMITED != 0, limit == 5.0);
        let mut rotors: Vec<drive_bus::DriveRotor<'_>> = drive.arenas.iter_mut().zip(drive.inputs.iter()).zip(drive.outputs.iter_mut())
            .map(|((arena, input), output)| drive_bus::DriveRotor { arena, input, output }).collect();
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
        for _ in 0..steps {
            status |= black_box(drive_bus::step(&mut rotors, &bus, &mut out, DT));
        }
        TRACK.with(|t| t.set(false));
        assert_eq!(status, 0);
        assert_eq!((CALLS.load(Ordering::Relaxed), BYTES.load(Ordering::Relaxed)), (0, 0), "limit {limit}");
    }
}
