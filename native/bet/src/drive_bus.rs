//! ESC drive step on the shared bus (TASK-092): every rotor's interface v2
//! drive-mode-1 step and the shared battery bus in one allocation-free call,
//! so that the motors draw no more power than the pack delivers.
//!
//! The rotors run at the candidate bus voltage of their records, which the
//! caller sets to the bus voltage of the previous step (the one-tick lag). When
//! their summed terminal power and the house load stay within the pack's
//! discharge limit, the step is the per-rotor `bound_v2::step` followed by
//! `bus_abi::step`, bit for bit. When they exceed it, the step lowers the
//! supply voltage of all motors to the highest voltage it finds by bisection at
//! which the summed terminal power and the house load do not exceed the limit;
//! the pack then delivers exactly that power. Everything is computed before
//! anything is written: a non-zero status changes no arena and no output.
use crate::bound_v2::{self, EscPredicted, EscStaged};
use crate::bus_abi;

/// Record version.
pub const VERSION: u32 = 1;
/// Output record bytes.
pub const OUTPUT_BYTES: u32 = 128;
/// Bytes of one rotor table entry: arena handle, step input record, step output record (u32 each).
pub const TABLE_ENTRY_BYTES: u32 = 12;
/// Rotors per step.
pub const MAX_ROTORS: usize = 32;
/// Output flag: the pack was at its limit. Discharging, the supply voltage was
/// lowered to it; regenerating, the pack absorbed only its charge-current limit.
pub const FLAG_POWER_LIMITED: u32 = bus_abi::FLAG_POWER_LIMITED;
/// Output flag: regeneration met a full pack.
pub const FLAG_CHARGE_LIMITED: u32 = bus_abi::FLAG_CHARGE_LIMITED;
/// Bisection steps at most; the search usually ends earlier, when its bracket
/// holds two adjacent doubles.
pub const MAX_BISECTIONS: u32 = 128;

/// One rotor's caller-owned records.
pub struct DriveRotor<'a> {
    /// Bound-rotor arena (`bound::init`).
    pub arena: &'a mut [u8],
    /// Interface v2 step input in drive mode 1.
    pub input: &'a [u8],
    /// Interface v2 step output.
    pub output: &'a mut [u8],
}

fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn bus_voltage(input: &[u8]) -> Option<u64> { Some(u64::from_le_bytes(input.get(128..136)?.try_into().ok()?)) }

/// Statuses: 0; -2 rotor count, record length or pointers; -3 invalid input or
/// state, a rotor not in drive mode 1, unequal bus voltages or a non-zero bus
/// `motor_power`; -7 version; and every `bound_v2::step` and `bus_abi::step`
/// status, of the first rotor or record that fails.
pub fn step(rotors: &mut [DriveRotor<'_>], bus_input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    if rotors.is_empty() || rotors.len() > MAX_ROTORS || out.len() != OUTPUT_BYTES as usize { return -2; }
    let bus = match bus_abi::parse(bus_input) { Ok(b) => b, Err(status) => return status };
    // The step computes the motor power itself.
    if bus.motor_power_w != 0.0 { return -3; }
    let (staged, supply, lowered) = match compute(rotors, &bus, dt) { Ok(c) => c, Err(status) => return status };
    let mut motor_power = 0.0;
    for s in staged.iter().take(rotors.len()) { motor_power += s.as_ref().map_or(0.0, |s| s.terminal_power_w); }
    let motors = [motor_power];
    let Ok(o) = bus.battery.step(bus.soc, &motors, bus.house_power_w, dt) else { return -3; };
    let mut record = [0u8; OUTPUT_BYTES as usize];
    record[0..bus_abi::OUTPUT_BYTES as usize].copy_from_slice(&bus_abi::stage(&o));
    if lowered {
        let flags = u32::from_le_bytes([record[48], record[49], record[50], record[51]]) | FLAG_POWER_LIMITED;
        record[48..52].copy_from_slice(&flags.to_le_bytes());
    }
    put(&mut record, 56, supply);
    put(&mut record, 64, motor_power);
    for (r, s) in rotors.iter_mut().zip(staged.iter()) {
        if let Some(s) = s { bound_v2::esc_commit(r.arena, r.output, s); }
    }
    out.copy_from_slice(&record);
    0
}

/// Predicts every rotor, finds the supply voltage and completes every rotor at
/// it, writing nothing. Returns the staged steps, the supply voltage and
/// whether it was lowered below the candidate.
fn compute(rotors: &[DriveRotor<'_>], bus: &bus_abi::BusInput, dt: f64)
    -> Result<([Option<EscStaged>; MAX_ROTORS], f64, bool), i32> {
    let mut predicted: [Option<EscPredicted<'_>>; MAX_ROTORS] = core::array::from_fn(|_| None);
    let mut candidate = None;
    for (slot, r) in predicted.iter_mut().zip(rotors.iter()) {
        let p = bound_v2::esc_prepare(&r.arena[..], r.input, r.output.len(), dt)?;
        // One bus: every motor sees the same voltage.
        let bits = bus_voltage(r.input).ok_or(-2)?;
        if *candidate.get_or_insert(bits) != bits { return Err(-3); }
        *slot = Some(p);
    }
    let predicted = &predicted[..rotors.len()];
    let candidate = f64::from_bits(candidate.ok_or(-2)?);
    // Summed terminal power at one voltage, in rotor order from zero, as the caller of `bus_abi::step` adds it.
    let power = |voltage: f64| -> Result<f64, i32> {
        let mut sum = 0.0;
        for p in predicted.iter().flatten() { sum += bound_v2::esc_power(p, voltage, dt)?; }
        Ok(sum)
    };
    let house = bus.house_power_w;
    let limit = bus.battery.discharge_limit_w(bus.soc, dt).map_err(|_| -3)?;
    // The battery's demand is the house load plus the motors' power; above the
    // limit, which is never negative, the battery would limit it.
    let demand = house + power(candidate)?;
    let (mut supply, mut lowered) = (candidate, false);
    if demand > limit {
        lowered = true;
        if house > limit {
            // The house load alone exceeds the limit: an unpowered bridge draws nothing.
            supply = 0.0;
        } else {
            // Invariant: house + P(lo) <= limit < house + P(hi). At 0 V every bridge is unpowered, so P(0) = 0.
            let (mut lo, mut hi) = (0.0_f64, candidate);
            for _ in 0..MAX_BISECTIONS {
                let mid = 0.5 * (lo + hi);
                if !(mid > lo && mid < hi) { break; }
                if house + power(mid)? <= limit { lo = mid; } else { hi = mid; }
            }
            supply = lo;
        }
    }
    let mut staged: [Option<EscStaged>; MAX_ROTORS] = core::array::from_fn(|_| None);
    for (slot, p) in staged.iter_mut().zip(predicted.iter().flatten()) {
        *slot = Some(bound_v2::esc_complete(p, supply, dt, crate::bound::Kernel::Production)?);
    }
    Ok((staged, supply, lowered))
}
