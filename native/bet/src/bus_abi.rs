//! Shared battery bus step record (TASK-092): one allocation-free step of
//! [`crate::battery::Battery`] from a 128-byte input to a 128-byte output.
//! The caller keeps the charge and sums the motors' signed terminal powers.
//! Version 2 (TASK-104) adds a dynamic pack in a 384-byte input; the caller also keeps
//! its branch voltages and temperature. Version 1 records run as before, bit for bit.
use crate::battery::{Battery, PackAir, PackModel, PackState, TABLE_POINTS};
use crate::bus_solve::{self, MotorLoad};

/// Record version 1 (TASK-092).
pub const VERSION: u32 = 1;
/// Record version 2 (TASK-104); `bet_bus_step` and the bus solve accept both.
pub const VERSION_V2: u32 = 2;
/// Input record bytes, version 1.
pub const INPUT_BYTES: u32 = 128;
/// Input record bytes, version 2 (TASK-104).
pub const INPUT_V2_BYTES: u32 = 384;
/// Input bytes of a record version, or `None` for an unknown one.
pub fn input_bytes(version: u32) -> Option<u32> {
    match version { 1 => Some(INPUT_BYTES), 2 => Some(INPUT_V2_BYTES), _ => None }
}
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
    if word(input, 0) != 1 { return Err(-7); }
    if word(input, 4) != 0 || !input[72..128].iter().all(|b| *b == 0) { return Err(-3); }
    Battery::new(value(input, 8), value(input, 16), value(input, 24), value(input, 32), value(input, 40)).map_err(|_| -3)
}

/// A version 2 record's pack, state and air (TASK-104).
fn pack_of(input: &[u8]) -> Result<(Battery, PackState, PackAir), i32> {
    if input.len() != INPUT_V2_BYTES as usize { return Err(-2); }
    if word(input, 0) != 2 { return Err(-7); }
    if word(input, 4) != 0 || !input[376..384].iter().all(|b| *b == 0) { return Err(-3); }
    let mut table_v = [0.0; TABLE_POINTS];
    for (i, v) in table_v.iter_mut().enumerate() { *v = value(input, 208 + 8 * i); }
    let model = PackModel {
        table_v,
        branch_ohm: [value(input, 112), value(input, 128)],
        branch_f: [value(input, 120), value(input, 136)],
        activation_k: value(input, 144),
        reference_k: value(input, 152),
        heat_capacity_j_per_k: value(input, 160),
        still_air_w_per_k: value(input, 168),
        airflow_w_per_k: value(input, 176),
        entropic_v_per_k: value(input, 184),
        capacity_retention: value(input, 192),
        resistance_growth: value(input, 200),
    };
    let battery = Battery::new(value(input, 8), value(input, 16), value(input, 24), value(input, 32), value(input, 40))
        .and_then(|b| b.with_model(model)).map_err(|_| -3)?;
    let state = PackState { soc: value(input, 48), branch_v: [value(input, 72), value(input, 80)], temperature_k: value(input, 88) };
    Ok((battery, state, PackAir { temperature_k: value(input, 96), speed_mps: value(input, 104) }))
}

/// The bus and `loads` solved together for one step (TASK-197), from the input record of [`step`]
/// with `motor_power` zero, into a [`SOLUTION_BYTES`] record: motor voltage V at 0, pack voltage V
/// at 8, flags at 16 and iterations at 20, both u32. Same statuses; a negative one leaves the output unchanged.
pub fn solve(input: &[u8], loads: &[MotorLoad], out: &mut [u8], dt: f64) -> i32 {
    if out.len() != SOLUTION_BYTES as usize { return -2; }
    if input.len() < 8 { return -2; }
    let solved = if word(input, 0) == 2 {
        let (battery, state, air) = match pack_of(input) { Ok(pack) => pack, Err(status) => return status };
        if value(input, 56) != 0.0 { return -3; }
        bus_solve::solve_at(&battery, &state, &air, value(input, 64), dt, loads)
    } else {
        let battery = match battery_of(input) { Ok(battery) => battery, Err(status) => return status };
        if value(input, 56) != 0.0 { return -3; }
        bus_solve::solve(&battery, value(input, 48), value(input, 64), dt, loads)
    };
    let Ok(s) = solved else { return -3; };
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
    if input.len() >= 8 && word(input, 0) == 2 { return step_v2(input, out, dt); }
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

/// A version 2 step (TASK-104): the v1 fields, then the new state, the heat and the open-circuit voltage.
fn step_v2(input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    let (battery, state, air) = match pack_of(input) { Ok(pack) => pack, Err(status) => return status };
    let motors = [value(input, 56)];
    let Ok(p) = battery.step_at(&state, &air, &motors, value(input, 64), dt) else { return -3; };
    let o = p.output;
    let mut staged = [0u8; OUTPUT_BYTES as usize];
    put(&mut staged, 0, o.soc);
    put(&mut staged, 8, o.voltage_v);
    put(&mut staged, 16, o.current_a);
    put(&mut staged, 24, o.delivered_power_w);
    put(&mut staged, 32, o.internal_loss_w);
    put(&mut staged, 40, o.source_power_w);
    let flags = if o.power_limited { FLAG_POWER_LIMITED } else { 0 } | if o.charge_limited { FLAG_CHARGE_LIMITED } else { 0 };
    staged[48..52].copy_from_slice(&flags.to_le_bytes());
    put(&mut staged, 56, p.state.branch_v[0]);
    put(&mut staged, 64, p.state.branch_v[1]);
    put(&mut staged, 72, p.state.temperature_k);
    put(&mut staged, 80, p.heat_w);
    put(&mut staged, 88, p.open_circuit_v);
    out.copy_from_slice(&staged);
    0
}
