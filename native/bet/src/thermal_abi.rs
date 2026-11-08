//! Motor thermal record v1 (TASK-105, second increment): one allocation-free batch step of
//! [`crate::motor::MotorThermal`] over caller-owned 192-byte records, one per motor, each holding the
//! network's parameters, its two temperatures, the tick's losses and air, and the winding resistance,
//! torque constant and no-load torque at the new temperatures (SPECS_SIMULATION_ENGINES "Motor thermal
//! record v1"). The magnets sit in the housing node. Every record is checked before any is written.
use crate::motor::{torque_constant_at, winding_resistance_ohm, MotorThermal, NDFEB_COEFFICIENT_PER_K};

/// Record version.
pub const VERSION: u32 = 1;
/// Record bytes.
pub const RECORD_BYTES: usize = 192;
/// The most records one batch step takes.
pub const MAX_RECORDS: usize = 32;
/// The temperature range the record accepts before and after a step, °C.
pub const TEMPERATURE_RANGE_C: (f64, f64) = (-60.0, 250.0);

/// Byte offsets of the record's fields.
pub mod offset {
    /// `version` at byte 0.
    pub const VERSION: usize = 0;
    /// `winding_capacity` at byte 8.
    pub const WINDING_CAPACITY: usize = 8;
    /// `housing_capacity` at byte 16.
    pub const HOUSING_CAPACITY: usize = 16;
    /// `winding_to_housing` at byte 24.
    pub const WINDING_TO_HOUSING: usize = 24;
    /// `housing_to_air` at byte 32.
    pub const HOUSING_TO_AIR: usize = 32;
    /// `airflow_per_mps` at byte 40.
    pub const AIRFLOW_PER_MPS: usize = 40;
    /// `resistance_20c` at byte 48.
    pub const RESISTANCE_20C: usize = 48;
    /// `torque_constant_20c` at byte 56.
    pub const TORQUE_CONSTANT_20C: usize = 56;
    /// `no_load_current` at byte 64.
    pub const NO_LOAD_CURRENT: usize = 64;
    /// `winding_temperature` at byte 72.
    pub const WINDING_TEMPERATURE: usize = 72;
    /// `housing_temperature` at byte 80.
    pub const HOUSING_TEMPERATURE: usize = 80;
    /// `copper_loss` at byte 88.
    pub const COPPER_LOSS: usize = 88;
    /// `shaft_speed` at byte 96.
    pub const SHAFT_SPEED: usize = 96;
    /// `air_temperature` at byte 104.
    pub const AIR_TEMPERATURE: usize = 104;
    /// `airspeed` at byte 112.
    pub const AIRSPEED: usize = 112;
    /// `resistance` at byte 120.
    pub const RESISTANCE: usize = 120;
    /// `torque_constant` at byte 128.
    pub const TORQUE_CONSTANT: usize = 128;
    /// `no_load_torque` at byte 136.
    pub const NO_LOAD_TORQUE: usize = 136;
    /// `iron_loss` at byte 144.
    pub const IRON_LOSS: usize = 144;
    /// `reserved` at byte 152.
    pub const RESERVED: usize = 152;
}

fn word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) }
fn value(b: &[u8], p: usize) -> f64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[p..p + 8]);
    f64::from_le_bytes(x)
}
fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn in_range(t: f64) -> bool { t.is_finite() && t >= TEMPERATURE_RANGE_C.0 && t <= TEMPERATURE_RANGE_C.1 }

/// One record's step: [winding °C, housing °C, R Ω, k N·m/A, no-load torque N·m, iron loss W], or its status.
fn advance(record: &[u8], dt: f64) -> Result<[f64; 6], i32> {
    if word(record, offset::VERSION) != VERSION { return Err(-7); }
    if word(record, 4) != 0 || !record[offset::RESERVED..RECORD_BYTES].iter().all(|b| *b == 0) { return Err(-3); }
    let Ok(network) = MotorThermal::new(value(record, offset::WINDING_CAPACITY), value(record, offset::HOUSING_CAPACITY),
        value(record, offset::WINDING_TO_HOUSING), value(record, offset::HOUSING_TO_AIR), value(record, offset::AIRFLOW_PER_MPS)) else { return Err(-3); };
    let (r20, k20, i0) = (value(record, offset::RESISTANCE_20C), value(record, offset::TORQUE_CONSTANT_20C), value(record, offset::NO_LOAD_CURRENT));
    let (winding, housing) = (value(record, offset::WINDING_TEMPERATURE), value(record, offset::HOUSING_TEMPERATURE));
    let (copper, speed, air, airspeed) = (value(record, offset::COPPER_LOSS), value(record, offset::SHAFT_SPEED),
        value(record, offset::AIR_TEMPERATURE), value(record, offset::AIRSPEED));
    if ![r20, k20, i0, copper, speed, air, airspeed].iter().all(|v| v.is_finite()) || r20 <= 0.0 || k20 <= 0.0 || i0 < 0.0
        || copper < 0.0 || speed < 0.0 || airspeed < 0.0 || !in_range(winding) || !in_range(housing) || !in_range(air) {
        return Err(-3);
    }
    // The iron loss at the step's start temperature, as InductiveMotor gives it: k(T_h)·I₀·|Ω|.
    let iron = torque_constant_at(k20, NDFEB_COEFFICIENT_PER_K, housing) * i0 * speed;
    let Ok([w, h]) = network.step([winding, housing], copper, iron, air, airspeed, dt) else { return Err(-3); };
    if !in_range(w) || !in_range(h) { return Err(-3); }
    let k = torque_constant_at(k20, NDFEB_COEFFICIENT_PER_K, h);
    let out = [w, h, winding_resistance_ohm(r20, w), k, k * i0, iron];
    if !out.iter().all(|v| v.is_finite()) { return Err(-3); }
    Ok(out)
}

/// Steps every record of `records` (1 to 32 records end to end) by `dt`. Statuses: 0, −2 region,
/// −3 invalid record or result, −7 version; a negative status leaves every record unchanged.
pub fn step(records: &mut [u8], dt: f64) -> i32 {
    if records.is_empty() || records.len() % RECORD_BYTES != 0 || records.len() / RECORD_BYTES > MAX_RECORDS { return -2; }
    if !dt.is_finite() || dt <= 0.0 { return -3; }
    let count = records.len() / RECORD_BYTES;
    let mut next = [[0.0; 6]; MAX_RECORDS];
    for (i, slot) in next.iter_mut().enumerate().take(count) {
        match advance(&records[i * RECORD_BYTES..(i + 1) * RECORD_BYTES], dt) { Ok(out) => *slot = out, Err(status) => return status }
    }
    for (i, out) in next.iter().enumerate().take(count) {
        let record = &mut records[i * RECORD_BYTES..(i + 1) * RECORD_BYTES];
        put(record, offset::WINDING_TEMPERATURE, out[0]);
        put(record, offset::HOUSING_TEMPERATURE, out[1]);
        put(record, offset::RESISTANCE, out[2]);
        put(record, offset::TORQUE_CONSTANT, out[3]);
        put(record, offset::NO_LOAD_TORQUE, out[4]);
        put(record, offset::IRON_LOSS, out[5]);
    }
    0
}
