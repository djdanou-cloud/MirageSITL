//! Shared battery bus step record (TASK-092): one allocation-free step of
//! [`crate::battery::Battery`] from a 128-byte input to a 128-byte output.
//! The caller keeps the charge and sums the motors' signed terminal powers.
use crate::battery::Battery;
use crate::bus_solve::{self, MotorLoad};

/// Record version.
pub const VERSION: u32 = 1;
/// Input record bytes.
pub const INPUT_BYTES: u32 = 128;
/// Output record bytes.
pub const OUTPUT_BYTES: u32 = 128;
/// Output flag: the demand exceeded what the pack can deliver or absorb.
pub const FLAG_POWER_LIMITED: u32 = 1;
/// Output flag: regeneration met a full pack.
pub const FLAG_CHARGE_LIMITED: u32 = 2;
/// Bus solution record version (TASK-197).
pub const SOLUTION_VERSION: u32 = 1;
/// Bus solution record bytes (TASK-197).
pub const SOLUTION_BYTES: u32 = 64;

fn word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) }
fn value(b: &[u8], p: usize) -> f64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[p..p + 8]);
    f64::from_le_bytes(x)
}
fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }

fn battery_of(input: &[u8]) -> Result<Battery, i32> {
    if input.len() != INPUT_BYTES as usize { return Err(-2); }
    if word(input, 0) != VERSION { return Err(-7); }
    if word(input, 4) != 0 || !input[72..128].iter().all(|b| *b == 0) { return Err(-3); }
    Battery::new(value(input, 8), value(input, 16), value(input, 24), value(input, 32), value(input, 40)).map_err(|_| -3)
}

/// The bus and `loads` solved together for one step (TASK-197), from the input record of [`step`]
/// with `motor_power` zero, into a [`SOLUTION_BYTES`] record: motor voltage V at 0, pack voltage V
/// at 8, flags at 16 and iterations at 20, both u32. Same statuses; a negative one leaves the output unchanged.
pub fn solve(input: &[u8], loads: &[MotorLoad], out: &mut [u8], dt: f64) -> i32 {
    if out.len() != SOLUTION_BYTES as usize { return -2; }
    let battery = match battery_of(input) { Ok(battery) => battery, Err(status) => return status };
    if value(input, 56) != 0.0 { return -3; }
    let Ok(s) = bus_solve::solve(&battery, value(input, 48), value(input, 64), dt, loads) else { return -3; };
    let mut staged = [0u8; SOLUTION_BYTES as usize];
    put(&mut staged, 0, s.motor_voltage_v);
    put(&mut staged, 8, s.pack_voltage_v);
    let flags = if s.limited { FLAG_POWER_LIMITED } else { 0 };
    staged[16..20].copy_from_slice(&flags.to_le_bytes());
    staged[20..24].copy_from_slice(&s.iterations.to_le_bytes());
    out.copy_from_slice(&staged);
    0
}

/// Statuses: 0, -2 record length, -3 invalid input or state, -7 version.
/// A negative status leaves the output unchanged.
pub fn step(input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    if out.len() != OUTPUT_BYTES as usize { return -2; }
    let battery = match battery_of(input) { Ok(battery) => battery, Err(status) => return status };
    let motors = [value(input, 56)];
    let Ok(o) = battery.step(value(input, 48), &motors, value(input, 64), dt) else { return -3; };
    let mut staged = [0u8; OUTPUT_BYTES as usize];
    put(&mut staged, 0, o.soc);
    put(&mut staged, 8, o.voltage_v);
    put(&mut staged, 16, o.current_a);
    put(&mut staged, 24, o.delivered_power_w);
    put(&mut staged, 32, o.internal_loss_w);
    put(&mut staged, 40, o.source_power_w);
    let flags = if o.power_limited { FLAG_POWER_LIMITED } else { 0 } | if o.charge_limited { FLAG_CHARGE_LIMITED } else { 0 };
    staged[48..52].copy_from_slice(&flags.to_le_bytes());
    out.copy_from_slice(&staged);
    0
}
