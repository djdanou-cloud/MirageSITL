//! Shared battery bus step record (TASK-092): one allocation-free step of
//! [`crate::battery::Battery`] from a 128-byte input to a 128-byte output.
//! The caller keeps the charge and sums the motors' signed terminal powers.
use crate::battery::{Battery, BatteryOutput};

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

fn word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) }
fn value(b: &[u8], p: usize) -> f64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[p..p + 8]);
    f64::from_le_bytes(x)
}
fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }

/// A validated input record: the battery, the charge, the motor power and the house load.
pub(crate) struct BusInput { pub(crate) battery: Battery, pub(crate) soc: f64, pub(crate) motor_power_w: f64, pub(crate) house_power_w: f64 }

/// Checks an input record and builds its battery. Statuses as `step`.
pub(crate) fn parse(input: &[u8]) -> Result<BusInput, i32> {
    if input.len() != INPUT_BYTES as usize { return Err(-2); }
    if word(input, 0) != VERSION { return Err(-7); }
    if word(input, 4) != 0 || !input[72..128].iter().all(|b| *b == 0) { return Err(-3); }
    let Ok(battery) = Battery::new(value(input, 8), value(input, 16), value(input, 24), value(input, 32), value(input, 40)) else {
        return Err(-3);
    };
    Ok(BusInput { battery, soc: value(input, 48), motor_power_w: value(input, 56), house_power_w: value(input, 64) })
}

/// The output record's first 52 bytes for one battery step; the rest is zero.
pub(crate) fn stage(o: &BatteryOutput) -> [u8; OUTPUT_BYTES as usize] {
    let mut staged = [0u8; OUTPUT_BYTES as usize];
    put(&mut staged, 0, o.soc);
    put(&mut staged, 8, o.voltage_v);
    put(&mut staged, 16, o.current_a);
    put(&mut staged, 24, o.delivered_power_w);
    put(&mut staged, 32, o.internal_loss_w);
    put(&mut staged, 40, o.source_power_w);
    let flags = if o.power_limited { FLAG_POWER_LIMITED } else { 0 } | if o.charge_limited { FLAG_CHARGE_LIMITED } else { 0 };
    staged[48..52].copy_from_slice(&flags.to_le_bytes());
    staged
}

/// Statuses: 0, -2 record length, -3 invalid input or state, -7 version.
/// A negative status leaves the output unchanged.
pub fn step(input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    if input.len() != INPUT_BYTES as usize || out.len() != OUTPUT_BYTES as usize { return -2; }
    let bus = match parse(input) { Ok(b) => b, Err(status) => return status };
    let motors = [bus.motor_power_w];
    let Ok(o) = bus.battery.step(bus.soc, &motors, bus.house_power_w, dt) else { return -3; };
    out.copy_from_slice(&stage(&o));
    0
}
