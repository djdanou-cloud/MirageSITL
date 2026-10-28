//! Rigid-body step interface v2 (TASK-088): 448-byte input and 256-byte output,
//! little endian. Gravity model, CG offset and mass-property rates belong to
//! later tasks and are fail-closed: they must be neutral, otherwise the step
//! returns `UNSUPPORTED` and leaves the output unchanged. A neutral record runs
//! exactly the v1 body step, so output bytes 0..128 equal the v1 output record.
use crate::body_abi;

/// Step record version.
pub const VERSION: u32 = 2;
/// Input record bytes.
pub const INPUT_BYTES: u32 = 448;
/// Output record bytes.
pub const OUTPUT_BYTES: u32 = 256;
/// A later-task field holds a non-neutral value (same code as bound v2).
pub const UNSUPPORTED: i32 = crate::bound_v2::UNSUPPORTED;
/// Gravity model 0: constant magnitude along NED down, the v1 semantics.
pub const GRAVITY_CONSTANT_DOWN: u32 = 0;
/// Gravity model 1: explicit NED vector (TASK-108).
pub const GRAVITY_NED_VECTOR: u32 = 1;
/// Gravity model 2: WGS84 normal gravity from position (TASK-108).
pub const GRAVITY_WGS84: u32 = 2;
/// Input flag bit 0: mass-property rates are supplied (TASK-119).
pub const INPUT_MASS_RATES: u32 = 1;
/// Output validity bit: specific force at the CG.
pub const VALID_SPECIFIC_FORCE: u32 = 1;
/// Output validity bit: angular acceleration (TASK-094).
pub const VALID_ANGULAR_ACCELERATION: u32 = 2;
/// Output validity bit: reference-point position (TASK-094).
pub const VALID_REFERENCE_POSITION: u32 = 4;

fn word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) }
fn value(b: &[u8], p: usize) -> f64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[p..p + 8]);
    f64::from_le_bytes(x)
}
fn put(b: &mut [u8], p: usize, x: f64) { b[p..p + 8].copy_from_slice(&x.to_le_bytes()); }
fn zero(b: &[u8], a: usize, z: usize) -> bool { b[a..z].iter().all(|v| *v == 0) }
/// Every f64 slot in [a, z) is numerically zero; -0 is accepted.
fn neutral(b: &[u8], a: usize, z: usize) -> bool { (a..z).step_by(8).all(|p| value(b, p) == 0.0) }

/// Returns 0, -3 invalid, -7 version or `UNSUPPORTED`; no output byte changes on failure.
pub fn step(input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    if input.len() != INPUT_BYTES as usize || out.len() != OUTPUT_BYTES as usize { return -3; }
    if word(input, 0) != VERSION { return -7; }
    let (gravity, flags) = (word(input, 4), word(input, 8));
    if gravity > GRAVITY_WGS84 || flags & !INPUT_MASS_RATES != 0 || !zero(input, 12, 16) || !zero(input, 384, 448) {
        return -3;
    }
    if !(16..384).step_by(8).all(|p| value(input, p).is_finite()) { return -3; }
    // Gravity model and vector (TASK-108), CG offset (TASK-094), mass-property rates (TASK-119).
    if gravity != GRAVITY_CONSTANT_DOWN || !neutral(input, 256, 280) || !neutral(input, 280, 304)
        || flags & INPUT_MASS_RATES != 0 || !neutral(input, 304, 384) {
        return UNSUPPORTED;
    }
    // v2 bytes 16..256 hold the v1 input fields 0..240 in the same order.
    let mut v1 = [0u8; body_abi::INPUT_BYTES as usize];
    v1[0..240].copy_from_slice(&input[16..256]);
    v1[240..244].copy_from_slice(&body_abi::VERSION.to_le_bytes());
    let mut staged = [0u8; body_abi::OUTPUT_BYTES as usize];
    let status = body_abi::step(&v1, &mut staged, dt);
    if status != 0 { return status; }
    let mass = value(input, 16);
    out.fill(0);
    out[0..128].copy_from_slice(&staged);
    // The body-frame force is constant over the step, so the CG specific force is F/m.
    for axis in 0..3 { put(out, 128 + 8 * axis, value(input, 200 + 8 * axis) / mass); }
    out[200..204].copy_from_slice(&VALID_SPECIFIC_FORCE.to_le_bytes());
    0
}
