//! ESC shaper record v1 (TASK-105, second increment): one allocation-free batch step of
//! [`crate::esc::EscShaper`] over caller-owned 192-byte records, one per motor, each holding the
//! shaper's parameters, its state, the tick's target duty and the shaped duty
//! (SPECS_SIMULATION_ENGINES "ESC shaper record v1"). Every record is checked before any is written.
use crate::esc::{EscShaper, EscShaperState, MAX_LATENCY_FRAMES};

/// Record version.
pub const VERSION: u32 = 1;
/// Record bytes.
pub const RECORD_BYTES: usize = 192;
/// The most records one batch step takes.
pub const MAX_RECORDS: usize = 32;

/// Byte offsets of the record's fields.
pub mod offset {
    /// `version` at byte 0.
    pub const VERSION: usize = 0;
    /// `latency_frames` at byte 4.
    pub const LATENCY_FRAMES: usize = 4;
    /// `frame_period` at byte 8.
    pub const FRAME_PERIOD: usize = 8;
    /// `ramp_per_s` at byte 16.
    pub const RAMP_PER_S: usize = 16;
    /// `start_duty` at byte 24.
    pub const START_DUTY: usize = 24;
    /// `throttle_steps` at byte 32.
    pub const THROTTLE_STEPS: usize = 32;
    /// `running` at byte 36.
    pub const RUNNING: usize = 36;
    /// `command` at byte 40.
    pub const COMMAND: usize = 40;
    /// `duty` at byte 48.
    pub const DUTY: usize = 48;
    /// `countdown` at byte 56.
    pub const COUNTDOWN: usize = 56;
    /// `frames` at byte 64.
    pub const FRAMES: usize = 64;
    /// `target` at byte 128.
    pub const TARGET: usize = 128;
    /// `reserved` at byte 136.
    pub const RESERVED: usize = 136;
}

fn word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) }
fn value(b: &[u8], p: usize) -> f64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[p..p + 8]);
    f64::from_le_bytes(x)
}
fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn unit(v: f64) -> bool { v.is_finite() && (0.0..=1.0).contains(&v) }

/// The quantized command an ESC with `steps` throttle steps resolves `target` to: round(target·N)/N, or `target` for 0 steps.
pub fn quantize(target: f64, steps: u32) -> f64 {
    if steps == 0 { target } else { (target * f64::from(steps)).round() / f64::from(steps) }
}

/// One record's validated shaper, state and quantized target, or the record's status.
fn read(record: &[u8]) -> Result<(EscShaper, EscShaperState, f64), i32> {
    if word(record, offset::VERSION) != VERSION { return Err(-7); }
    if !record[offset::RESERVED..RECORD_BYTES].iter().all(|b| *b == 0) { return Err(-3); }
    let latency = word(record, offset::LATENCY_FRAMES) as usize;
    let (period, ramp, start) = (value(record, offset::FRAME_PERIOD), value(record, offset::RAMP_PER_S), value(record, offset::START_DUTY));
    let steps = word(record, offset::THROTTLE_STEPS);
    if !ramp.is_finite() || ramp < 0.0 || steps > 65_535 || latency > MAX_LATENCY_FRAMES { return Err(-3); }
    // A ramp of 0 is no limit, as an infinite slope.
    let Ok(shaper) = EscShaper::new(period, latency, if ramp == 0.0 { f64::INFINITY } else { ramp }, start) else { return Err(-3); };
    let running = word(record, offset::RUNNING);
    let mut frames = [0.0; MAX_LATENCY_FRAMES];
    for (i, frame) in frames.iter_mut().enumerate() {
        *frame = value(record, offset::FRAMES + 8 * i);
        if !unit(*frame) { return Err(-3); }
    }
    let state = EscShaperState {
        frames, command: value(record, offset::COMMAND), duty: value(record, offset::DUTY),
        countdown_s: value(record, offset::COUNTDOWN), running: running == 1,
    };
    let target = value(record, offset::TARGET);
    if running > 1 || !unit(state.command) || !unit(state.duty) || !unit(target)
        || !state.countdown_s.is_finite() || state.countdown_s < 0.0 || state.countdown_s > period {
        return Err(-3);
    }
    Ok((shaper, state, quantize(target, steps)))
}

/// Steps every record of `records` (1 to 32 records end to end) by `dt`. Statuses: 0, −2 region,
/// −3 invalid record or result, −7 version; a negative status leaves every record unchanged.
pub fn step(records: &mut [u8], dt: f64) -> i32 {
    if records.is_empty() || records.len() % RECORD_BYTES != 0 || records.len() / RECORD_BYTES > MAX_RECORDS { return -2; }
    if !dt.is_finite() || dt <= 0.0 || dt > 0.01 { return -3; }
    let count = records.len() / RECORD_BYTES;
    let mut next = [EscShaperState::default(); MAX_RECORDS];
    for (i, slot) in next.iter_mut().enumerate().take(count) {
        let record = &records[i * RECORD_BYTES..(i + 1) * RECORD_BYTES];
        let (shaper, mut state, target) = match read(record) { Ok(r) => r, Err(status) => return status };
        if shaper.step(&mut state, target, dt).is_err() || !unit(state.duty) { return -3; }
        *slot = state;
    }
    for (i, state) in next.iter().enumerate().take(count) {
        let record = &mut records[i * RECORD_BYTES..(i + 1) * RECORD_BYTES];
        record[offset::RUNNING..offset::RUNNING + 4].copy_from_slice(&u32::from(state.running).to_le_bytes());
        put(record, offset::COMMAND, state.command);
        put(record, offset::DUTY, state.duty);
        put(record, offset::COUNTDOWN, state.countdown_s);
        for (k, frame) in state.frames.iter().enumerate() { put(record, offset::FRAMES + 8 * k, *frame); }
    }
    0
}
