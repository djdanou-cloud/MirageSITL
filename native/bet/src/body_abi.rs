//! Independent rigid-body ABI v1: 256-byte input, 128-byte output, little endian.
//! This does not change the rotor arena ABI and never fabricates aero outputs.
use crate::{
    frame::Wrench,
    rigid_body::{BodyParameters, BodyState},
    Vec3,
};
/// Version of the independent body ABI.
pub const VERSION: u32 = 1;
/// Input bytes: mass/inertia/state/wrench/gravity/header.
pub const INPUT_BYTES: u32 = 256;
/// Output bytes: position/velocity/quaternion/omega/acceleration.
pub const OUTPUT_BYTES: u32 = 128;
fn get(b: &[u8], i: usize) -> f64 {
    let mut x = [0; 8];
    x.copy_from_slice(&b[i..i + 8]);
    f64::from_le_bytes(x)
}
fn vector(b: &[u8], i: usize) -> Vec3 {
    Vec3::new(get(b, i), get(b, i + 8), get(b, i + 16))
}
fn put(b: &mut [u8], i: usize, x: f64) {
    b[i..i + 8].copy_from_slice(&x.to_le_bytes());
}
fn write_vector(b: &mut [u8], i: usize, v: Vec3) {
    put(b, i, v.x);
    put(b, i + 8, v.y);
    put(b, i + 16, v.z);
}
/// Returns 0 or -3 invalid/-7 version. No output bytes change on failure.
pub fn step(input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    if input.len() != INPUT_BYTES as usize || out.len() != OUTPUT_BYTES as usize {
        return -3;
    }
    if input[240..244] != VERSION.to_le_bytes() {
        return -7;
    }
    if input[244..256].iter().any(|v| *v != 0) {
        return -3;
    }
    let mut inertia = [0.0; 9];
    for i in 0..9 {
        inertia[i] = get(input, 8 + i * 8);
    }
    let parameters = match BodyParameters::new(get(input, 0), inertia) {
        Ok(p) => p,
        Err(_) => return -3,
    };
    let state = BodyState {
        position: vector(input, 80),
        velocity: vector(input, 104),
        quaternion: [
            get(input, 128),
            get(input, 136),
            get(input, 144),
            get(input, 152),
        ],
        omega: vector(input, 160),
    };
    let result = match parameters.step(
        state,
        Wrench {
            force: vector(input, 184),
            moment: vector(input, 208),
        },
        get(input, 232),
        dt,
    ) {
        Ok(r) => r,
        Err(_) => return -3,
    };
    write_vector(out, 0, result.state.position);
    write_vector(out, 24, result.state.velocity);
    for i in 0..4 {
        put(out, 48 + 8 * i, result.state.quaternion[i]);
    }
    write_vector(out, 80, result.state.omega);
    write_vector(out, 104, result.acceleration);
    0
}
