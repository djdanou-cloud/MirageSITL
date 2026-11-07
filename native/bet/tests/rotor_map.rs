//! TASK-103: the rotor lookup-table kernel against hand-computed oracles. The table's coefficients are linear in
//! every axis, so a multilinear interpolation must reproduce them exactly anywhere inside; the oracle is that
//! formula, not the kernel.
use mirage_bet::{bound, bound_v2, rotor_map};

const R: f64 = 0.15;
const DT: f64 = 1.0 / 800.0;
const J: [f64; 4] = [0.0, 0.1, 0.3, 0.8];
const ALPHA: [f64; 3] = [-1.5, 0.0, 1.5];
const MACH: [f64; 3] = [0.1, 0.3, 0.6];
const COLLECTIVE: [f64; 2] = [0.0, 0.2];
/// Wide, so a query can leave the tip Mach axis while staying on this one.
const REYNOLDS: [f64; 3] = [0.01, 1.0, 100.0];
/// The table's density times speed of sound over viscosity: the 1 of the Reynolds scale.
const REFERENCE: f64 = 1.225 * 340.0 / 1.789e-5;
fn scale(density: f64, sound: f64) -> f64 { density * sound / 1.789e-5 / REFERENCE }

fn coefficients(j: f64, a: f64, m: f64, s: f64, c: f64) -> [f64; 7] {
    [
        0.01 + 0.002 * j + 0.001 * a + 0.003 * m + 0.0005 * s + 0.02 * c,
        0.001 + 0.004 * j,
        -(0.002 + 0.0005 * j + 0.0001 * a + 0.0007 * m + 0.0002 * s + 0.004 * c),
        0.0003 + 0.0002 * j,
        0.0004 + 0.0001 * j,
        0.002 + 0.0005 * j + 0.0001 * a + 0.0007 * m + 0.0002 * s + 0.004 * c,
        1.0,
    ]
}

struct Table { advance: Vec<f64>, angle: Vec<f64>, mach: Vec<f64>, reynolds: Vec<f64>, collective: Vec<f64>, values: Vec<f64> }
fn linear() -> Table {
    let mut values = Vec::new();
    for j in J { for a in ALPHA { for m in MACH { for s in REYNOLDS { for c in COLLECTIVE { values.extend_from_slice(&coefficients(j, a, m, s, c)); } } } } }
    Table { advance: J.to_vec(), angle: ALPHA.to_vec(), mach: MACH.to_vec(), reynolds: REYNOLDS.to_vec(), collective: COLLECTIVE.to_vec(), values }
}

fn encode(t: &Table, spin: i32, inertia: f64, initial: f64) -> Vec<u8> {
    let n = 128 + 8 * (t.advance.len() + t.angle.len() + t.mach.len() + t.reynolds.len() + t.collective.len() + t.values.len());
    let mut b = vec![0u8; n];
    let word = |b: &mut Vec<u8>, at: usize, v: u32| b[at..at + 4].copy_from_slice(&v.to_le_bytes());
    let real = |b: &mut Vec<u8>, at: usize, v: f64| b[at..at + 8].copy_from_slice(&v.to_le_bytes());
    word(&mut b, 0, rotor_map::CONFIG_VERSION); word(&mut b, 4, n as u32);
    word(&mut b, 8, t.advance.len() as u32); word(&mut b, 12, t.angle.len() as u32);
    word(&mut b, 16, t.mach.len() as u32); word(&mut b, 20, t.reynolds.len() as u32); word(&mut b, 24, t.collective.len() as u32);
    word(&mut b, 28, spin as u32);
    real(&mut b, 32, REFERENCE); real(&mut b, 40, R); real(&mut b, 56, inertia); real(&mut b, 64, 0.0); real(&mut b, 72, DT); real(&mut b, 80, initial);
    let mut at = 128;
    for list in [&t.advance, &t.angle, &t.mach, &t.reynolds, &t.collective, &t.values] {
        for v in list.iter() { real(&mut b, at, *v); at += 8; }
    }
    b
}

/// The arena is 8-byte aligned, which the configuration's f64 slices need.
fn aligned(bytes: usize) -> Vec<u64> { vec![0u64; bytes.div_ceil(8)] }
fn as_bytes(v: &mut [u64], len: usize) -> &mut [u8] {
    // SAFETY: u64 storage reinterpreted as bytes, within its length; the test owns it.
    unsafe { core::slice::from_raw_parts_mut(v.as_mut_ptr().cast::<u8>(), len) }
}

struct Rig { store: Vec<u64>, len: usize }
impl Rig {
    fn new(config: &[u8]) -> Result<Rig, i32> {
        let len = config.len() + bound::ARENA_HEADER;
        let mut store = aligned(len);
        let status = bound::init(config, as_bytes(&mut store, len), 0);
        if status != 0 { return Err(status); }
        Ok(Rig { store, len })
    }
    fn arena(&mut self) -> &mut [u8] { as_bytes(&mut self.store, self.len) }
}

#[derive(Clone, Copy)]
struct Air { density: f64, sound: f64, air: [f64; 3], collective: f64, cyclic: f64, motor: f64 }
const STILL: Air = Air { density: 1.225, sound: 340.0, air: [0.0; 3], collective: 0.0, cyclic: 0.0, motor: 0.0 };

fn input(a: Air) -> [u8; 128] {
    let mut b = [0u8; 128];
    b[0..4].copy_from_slice(&bound::VERSION.to_le_bytes());
    let mut put = |at: usize, v: f64| b[at..at + 8].copy_from_slice(&v.to_le_bytes());
    put(8, a.density); put(16, 1.789e-5); put(24, a.sound);
    put(32, a.air[0]); put(40, a.air[1]); put(48, a.air[2]);
    put(80, a.collective); put(88, a.cyclic); put(104, a.motor);
    b
}
struct Out { force: [f64; 3], moment: [f64; 3], omega: f64, torque: f64, flags: u32 }
fn read(out: &[u8]) -> Out {
    let r = |at: usize| f64::from_le_bytes(out[at..at + 8].try_into().unwrap());
    Out { force: [r(0), r(8), r(16)], moment: [r(24), r(32), r(40)], omega: r(72), torque: r(80),
        flags: u32::from_le_bytes(out[112..116].try_into().unwrap()) }
}
fn step(rig: &mut Rig, a: Air) -> (i32, Out) {
    let mut out = [0u8; 128];
    let status = bound::step(rig.arena(), &input(a), &mut out, DT);
    (status, read(&out))
}
fn close(actual: f64, expected: f64, tolerance: f64, what: &str) {
    assert!((actual - expected).abs() <= tolerance * expected.abs().max(1e-9), "{what}: {actual} against {expected}");
}
/// A shaft that cannot change speed in a step, so the loads are those of the initial speed.
const HEAVY: f64 = 1e12;

#[test]
fn interpolates_a_linear_table_exactly_and_scales_with_density_and_speed_squared() {
    let omega = 3000.0 * core::f64::consts::PI / 30.0;
    let mut rig = Rig::new(&encode(&linear(), 1, HEAVY, omega)).unwrap();
    let tip = omega * R;
    // Off every node: an in-plane and a climbing air speed, a collective between nodes.
    let (vx, climb) = (9.0, 4.0);
    let a = Air { density: 1.1, sound: 330.0, air: [vx, 0.0, -climb], collective: 0.07, ..STILL };
    let (status, out) = step(&mut rig, a);
    assert_eq!(status, 0);
    let speed = f64::hypot(vx, climb);
    let c = coefficients(speed / tip, climb.atan2(vx), tip / 330.0, scale(1.1, 330.0), 0.07);
    let q = 1.1 * omega * omega;
    let (r4, r5) = (R.powi(4), R.powi(5));
    close(out.force[2], c[0] * q * r4, 1e-9, "thrust");
    close(out.force[0], c[1] * q * r4, 1e-9, "H-force along the air");
    assert_eq!(out.force[1], 0.0);
    close(out.moment[2], c[2] * q * r5, 1e-9, "torque");
    close(out.moment[0], c[3] * q * r5, 1e-9, "rolling moment");
    close(out.moment[1], c[4] * q * r5, 1e-9, "pitching moment");
    close(out.torque, c[2] * q * r5, 1e-9, "shaft torque slot");
    assert_eq!(out.flags & (8 | rotor_map::FLAG_EDGE), 0, "inside the envelope");
}

#[test]
fn turns_the_in_plane_loads_with_the_air_and_mirrors_the_other_spin() {
    let omega = 300.0;
    let tip = omega * R;
    let (speed, psi) = (10.0f64, 0.7f64);
    let air = [speed * psi.cos(), speed * psi.sin(), 0.0];
    let a = Air { air, ..STILL };
    let c = coefficients(speed / tip, 0.0, tip / 340.0, 1.0, 0.0);
    let q = 1.225 * omega * omega;
    let (r4, r5) = (R.powi(4), R.powi(5));
    let mut plus = Rig::new(&encode(&linear(), 1, HEAVY, omega)).unwrap();
    let (_, out) = step(&mut plus, a);
    close(out.force[0], c[1] * q * r4 * psi.cos(), 1e-9, "Fx");
    close(out.force[1], c[1] * q * r4 * psi.sin(), 1e-9, "Fy");
    close(out.moment[0], (c[3] * psi.cos() - c[4] * psi.sin()) * q * r5, 1e-9, "Mx");
    close(out.moment[1], (c[3] * psi.sin() + c[4] * psi.cos()) * q * r5, 1e-9, "My");
    // A mirror across the plane of the air and the axis: thrust and H stay; torque and rolling moment change sign.
    let mut minus = Rig::new(&encode(&linear(), -1, HEAVY, omega)).unwrap();
    let (_, mirrored) = step(&mut minus, a);
    close(mirrored.force[2], c[0] * q * r4, 1e-9, "thrust of the other spin");
    close(mirrored.moment[2], -c[2] * q * r5, 1e-9, "torque of the other spin");
    close(mirrored.moment[0], (-c[3] * psi.cos() - c[4] * psi.sin()) * q * r5, 1e-9, "Mx of the other spin");
    close(mirrored.moment[1], (-c[3] * psi.sin() + c[4] * psi.cos()) * q * r5, 1e-9, "My of the other spin");
}

#[test]
fn flags_every_axis_at_its_edge_and_clamps_to_it() {
    let omega = 300.0;
    let tip = omega * R;
    let edge = rotor_map::FLAG_EDGE | 8;
    let q = 1.225 * omega * omega * R.powi(4);
    let mut rig = Rig::new(&encode(&linear(), 1, HEAVY, omega)).unwrap();
    // Inside: nothing flagged. At J = 0 the angle does not matter.
    assert_eq!(step(&mut rig, STILL).1.flags & edge, 0);
    // Advance ratio past its last point, clamped to it.
    let (_, out) = step(&mut rig, Air { air: [2.0 * tip, 0.0, 0.0], ..STILL });
    assert_eq!(out.flags & edge, edge);
    close(out.force[2], coefficients(0.8, 0.0, tip / 340.0, 1.0, 0.0)[0] * q, 1e-9, "clamped advance ratio");
    // Tip Mach above and below its axis: a slow and a fast speed of sound.
    assert_eq!(step(&mut rig, Air { sound: tip / 0.9, ..STILL }).1.flags & edge, edge);
    assert_eq!(step(&mut rig, Air { sound: tip / 0.05, ..STILL }).1.flags & edge, edge);
    // Collective, and any cyclic pitch, which no axis holds.
    assert_eq!(step(&mut rig, Air { collective: 0.3, ..STILL }).1.flags & edge, edge);
    assert_eq!(step(&mut rig, Air { cyclic: 0.01, ..STILL }).1.flags & edge, edge);
    // The Reynolds scale past both ends: air far too thin and far too dense.
    assert_eq!(step(&mut rig, Air { density: 1.225 * 0.001, ..STILL }).1.flags & edge, edge);
    assert_eq!(step(&mut rig, Air { density: 1.225 * 200.0, ..STILL }).1.flags & edge, edge);
    // Past the airflow angle's ends: straight up and straight down at some speed, on an axis of ±1.5 rad.
    assert_eq!(step(&mut rig, Air { air: [0.0, 0.0, -5.0], ..STILL }).1.flags & edge, edge);
    assert_eq!(step(&mut rig, Air { air: [0.0, 0.0, 5.0], ..STILL }).1.flags & edge, edge);
}

#[test]
fn an_axis_end_missed_by_rounding_is_still_on_the_axis() {
    let omega = 300.0;
    let tip = omega * R;
    let edge = rotor_map::FLAG_EDGE | 8;
    let mut rig = Rig::new(&encode(&linear(), 1, HEAVY, omega)).unwrap();
    // The first tip Mach point, missed by the rounding of the query's arithmetic and by a real margin.
    assert_eq!(step(&mut rig, Air { sound: tip / (MACH[0] - 1e-12), ..STILL }).1.flags & edge, 0);
    assert_eq!(step(&mut rig, Air { sound: tip / (MACH[0] - 1e-6), ..STILL }).1.flags & edge, edge);
    // A one-point axis the same way.
    let mut table = linear();
    table.collective = vec![0.0];
    table.values = table.values.chunks_exact(14).flat_map(|pair| pair[..7].to_vec()).collect();
    let mut rig = Rig::new(&encode(&table, 1, HEAVY, omega)).unwrap();
    assert_eq!(step(&mut rig, Air { collective: 1e-12, ..STILL }).1.flags & edge, 0);
    assert_eq!(step(&mut rig, Air { collective: 1e-6, ..STILL }).1.flags & edge, edge);
}

#[test]
fn a_point_of_low_validity_sets_the_validity_flag_only() {
    let mut table = linear();
    let n = table.values.len() / 7;
    for k in 0..n { table.values[k * 7 + 6] = 0.5; }
    let mut rig = Rig::new(&encode(&table, 1, HEAVY, 300.0)).unwrap();
    let flags = step(&mut rig, STILL).1.flags;
    assert_eq!(flags & 8, 8);
    assert_eq!(flags & rotor_map::FLAG_EDGE, 0);
}

#[test]
fn a_stopped_rotor_gives_no_load_and_says_so_when_the_air_moves() {
    let mut rig = Rig::new(&encode(&linear(), 1, 1e-3, 0.0)).unwrap();
    let (status, still) = step(&mut rig, STILL);
    assert_eq!(status, 0);
    assert_eq!((still.force, still.moment[2], still.flags & rotor_map::FLAG_EDGE), ([0.0; 3], 0.0, 0));
    let (status, windy) = step(&mut rig, Air { air: [5.0, 0.0, 0.0], ..STILL });
    assert_eq!(status, 0);
    assert_eq!(windy.force, [0.0; 3]);
    assert_eq!(windy.flags & rotor_map::FLAG_EDGE, rotor_map::FLAG_EDGE);
}

#[test]
fn the_shaft_follows_the_table_torque_with_the_midpoint_rule() {
    // Hover torque Q = k Ω², motor torque opposed to it: the speed must stay exactly where they balance.
    let (omega, inertia) = (300.0, 1e-3);
    let c = coefficients(0.0, 0.0, omega * R / 340.0, 1.0, 0.0);
    let balance = -c[2] * 1.225 * omega * omega * R.powi(5);
    let mut rig = Rig::new(&encode(&linear(), 1, inertia, omega)).unwrap();
    for _ in 0..100 {
        let (status, out) = step(&mut rig, Air { motor: balance, ..STILL });
        assert_eq!(status, 0);
        close(out.omega, omega, 1e-6, "the balanced speed");
    }
    // Twice that motor torque accelerates the shaft at (2Q − Q)/I.
    let mut rig = Rig::new(&encode(&linear(), 1, inertia, omega)).unwrap();
    let (_, out) = step(&mut rig, Air { motor: 2.0 * balance, ..STILL });
    close(out.omega - omega, balance / inertia * DT, 1e-2, "one step's speed gain");
}

#[test]
fn reset_restores_the_speed_and_a_failed_step_changes_nothing() {
    let omega = 300.0;
    let mut rig = Rig::new(&encode(&linear(), 1, 1e-3, omega)).unwrap();
    let (_, first) = step(&mut rig, Air { motor: 0.01, ..STILL });
    assert_ne!(first.omega, omega);
    let before = rig.arena().to_vec();
    // A wrong step size is refused, with the arena unchanged.
    let mut out = [7u8; 128];
    assert_eq!(bound::step(rig.arena(), &input(STILL), &mut out, DT / 2.0), -4);
    assert_eq!(rig.arena(), before.as_slice());
    assert_eq!(out, [7u8; 128]);
    assert_eq!(bound::reset(rig.arena()), 0);
    let (_, again) = step(&mut rig, Air { motor: 0.01, ..STILL });
    assert_eq!(again.omega, first.omega);
}

#[test]
fn refuses_a_table_it_cannot_trust() {
    let good = encode(&linear(), 1, 1e-3, 300.0);
    assert!(Rig::new(&good).is_ok());
    let spoiled = |change: &dyn Fn(&mut Table)| { let mut t = linear(); change(&mut t); encode(&t, 1, 1e-3, 300.0) };
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("an axis that does not increase", spoiled(&|t| t.advance[1] = t.advance[0])),
        ("a negative advance ratio", spoiled(&|t| t.advance[0] = -0.1)),
        ("an angle past straight up", spoiled(&|t| t.angle[2] = 1.6)),
        ("a coefficient that is not finite", spoiled(&|t| t.values[3] = f64::NAN)),
        ("a validity above 1", spoiled(&|t| t.values[6] = 1.5)),
        ("a spin of neither sign", encode(&linear(), 2, 1e-3, 300.0)),
        ("no inertia", encode(&linear(), 1, 0.0, 300.0)),
        ("a Reynolds scale that is not positive", spoiled(&|t| t.reynolds[0] = 0.0)),
    ];
    for (what, config) in cases {
        assert_eq!(Rig::new(&config).err(), Some(-3), "{what}");
    }
    let mut short = good.clone();
    short.truncate(good.len() - 8);
    assert_eq!(Rig::new(&short).err(), Some(-3), "a table of the wrong length");
    let mut reserved = good.clone();
    reserved[48] = 1;
    assert_eq!(Rig::new(&reserved).err(), Some(-3), "a reserved byte in use");
}

#[test]
fn runs_on_interface_v2_with_the_ground_effect_bit_clear() {
    let omega = 300.0;
    let mut rig = Rig::new(&encode(&linear(), 1, HEAVY, omega)).unwrap();
    let mut record = [0u8; 256];
    record[0..4].copy_from_slice(&bound_v2::VERSION.to_le_bytes());
    let mut put = |at: usize, v: f64| record[at..at + 8].copy_from_slice(&v.to_le_bytes());
    put(16, 1.225); put(24, 1.789e-5); put(32, 340.0);
    // A ground plane under the rotor: the map has no ground effect, so the record must not say one was applied.
    put(176, 1.0); put(184, 0.1);
    record[4..8].copy_from_slice(&bound_v2::INPUT_GROUND_PLANE.to_le_bytes());
    let mut out = [0u8; 256];
    assert_eq!(bound_v2::step(rig.arena(), &record, &mut out, DT), 0);
    let validity = u32::from_le_bytes(out[116..120].try_into().unwrap());
    assert_eq!(validity & bound_v2::VALID_GROUND_EFFECT, 0);
    let thrust = f64::from_le_bytes(out[16..24].try_into().unwrap());
    let c = coefficients(0.0, 0.0, omega * R / 340.0, 1.0, 0.0);
    close(thrust, c[0] * 1.225 * omega * omega * R.powi(4), 1e-9, "thrust through interface v2");
}
