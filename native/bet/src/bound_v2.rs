//! Bound-rotor step interface v2 (TASK-088): 256-byte input and output records
//! on unchanged v1 arenas. Fields owned by later tasks are fail-closed: until
//! the owning task lands they must hold their neutral value, otherwise the step
//! returns `UNSUPPORTED` and changes neither state nor output. A neutral record
//! runs exactly the v1 step, so output bytes 0..128 equal the v1 output record.
use crate::bound;

/// Step record version.
pub const VERSION: u32 = 2;
/// Input record bytes.
pub const INPUT_BYTES: u32 = 256;
/// Output record bytes.
pub const OUTPUT_BYTES: u32 = 256;
/// A later-task field holds a non-neutral value.
pub const UNSUPPORTED: i32 = -8;
/// Input flag bit 0: a ground plane is supplied (TASK-100).
pub const INPUT_GROUND_PLANE: u32 = 1;
/// Drive mode 0: motor torque magnitude, the v1 semantics.
pub const DRIVE_TORQUE: u32 = 0;
/// Drive mode 1: ESC duty on a bus voltage (TASK-092).
pub const DRIVE_ESC_DUTY: u32 = 1;
/// Output validity bit: motor and bus currents, electrical power, copper loss (TASK-092).
pub const VALID_ELECTRICAL: u32 = 1;
/// Output validity bit: first-harmonic inflow states (TASK-098).
pub const VALID_INFLOW_HARMONICS: u32 = 2;
/// Output validity bit: ground effect applied (TASK-100).
pub const VALID_GROUND_EFFECT: u32 = 4;
/// Output validity bit: external wake applied (TASK-101).
pub const VALID_EXTERNAL_WAKE: u32 = 8;

fn word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) }
fn value(b: &[u8], p: usize) -> f64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[p..p + 8]);
    f64::from_le_bytes(x)
}
fn zero(b: &[u8], a: usize, z: usize) -> bool { b[a..z].iter().all(|v| *v == 0) }
/// Every f64 slot in [a, z) is numerically zero; -0 is accepted.
fn neutral(b: &[u8], a: usize, z: usize) -> bool { (a..z).step_by(8).all(|p| value(b, p) == 0.0) }

/// One allocation-free fixed step. Statuses: 0, -2 record length, -3 invalid,
/// -7 version, `UNSUPPORTED`, and every v1 step status.
pub fn step(arena: &mut [u8], input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    if input.len() != INPUT_BYTES as usize || out.len() != OUTPUT_BYTES as usize { return -2; }
    if word(input, 0) != VERSION { return -7; }
    let (flags, drive) = (word(input, 4), word(input, 8));
    if flags & !INPUT_GROUND_PLANE != 0 || drive > DRIVE_ESC_DUTY || !zero(input, 12, 16) || !zero(input, 192, 256) {
        return -3;
    }
    if !(16..192).step_by(8).all(|p| value(input, p).is_finite()) { return -3; }
    // ESC drive and bus voltage (TASK-092), external wake (TASK-101), ground plane (TASK-100).
    if drive != DRIVE_TORQUE || !neutral(input, 120, 136) || !neutral(input, 136, 160)
        || flags & INPUT_GROUND_PLANE != 0 || !neutral(input, 160, 192) {
        return UNSUPPORTED;
    }
    // v2 bytes 16..120 hold the v1 step fields 8..112 in the same order.
    let mut v1 = [0u8; bound::INPUT_BYTES as usize];
    v1[0..4].copy_from_slice(&bound::VERSION.to_le_bytes());
    v1[8..112].copy_from_slice(&input[16..120]);
    let mut staged = [0u8; bound::OUTPUT_BYTES as usize];
    let status = bound::step(arena, &v1, &mut staged, dt);
    if status != 0 { return status; }
    out.fill(0);
    out[0..128].copy_from_slice(&staged);
    // Validity word at 116 stays zero: no later-task output is available yet.
    0
}
