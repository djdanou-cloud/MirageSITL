//! The shared bus and the motors solved together for one step (TASK-197).
//!
//! An ESC multiplies the bus voltage by its duty, so what the motors draw depends on the
//! voltage, and the voltage on what they draw. Physically the two agree at once: the
//! electrical time constants are far shorter than a step. A one-step lag between them is
//! unstable when the loop gain exceeds one, which a stiff pack and low-resistance motors
//! reach at high demand. So the voltage is found by solving the loop within the step.
//!
//! Below its limit the pack gives `V·(Voc - V) = Rb·P(V)`. When the motors at the pack's lowest
//! voltage still ask for more than it delivers, the pack stays at that voltage and current,
//! and the voltage the ESCs multiply falls until they ask for no more. That is the same as
//! every ESC's effective duty falling by one shared factor: the winding sees `d·V` either way.
//! Regeneration beyond what the pack absorbs does not hold the motors back: the excess is not
//! stored, as in [`crate::battery::Battery::step`].
use crate::battery::{Battery, BatteryError};
use crate::motor::DriveMotor;

/// Solved to this voltage.
const TOLERANCE_V: f64 = 1e-9;
/// After this many steps every further one halves the bracket.
const NEWTON_STEPS: u32 = 16;
/// `NEWTON_STEPS` and enough halvings to take any bracket below the tolerance.
const MAX_STEPS: u32 = NEWTON_STEPS + 64;

/// One motor as the bus sees it over a step.
#[derive(Clone, Copy, Debug, Default)]
pub struct MotorLoad {
    /// The motor.
    pub motor: DriveMotor,
    /// The filtered duty it runs at over this step [0,1].
    pub duty: f64,
    /// The shaft speed the step starts at, rad/s.
    pub omega: f64,
    /// The bridge is cut.
    pub power_cut: bool,
}
/// The voltages of one step.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BusSolution {
    /// The voltage the ESCs multiply by their duty, V; below the pack's only while it is limited.
    pub motor_voltage_v: f64,
    /// The pack's terminal voltage, V.
    pub pack_voltage_v: f64,
    /// The pack cannot deliver or absorb what the motors ask at its voltage limits.
    pub limited: bool,
    /// Evaluations of the loop's solver; 0 when the answer needs none.
    pub iterations: u32,
}

/// The house load plus every motor's terminal power at `voltage`, and its slope with the voltage.
fn demand(loads: &[MotorLoad], house_w: f64, voltage: f64) -> Result<(f64, f64), BatteryError> {
    let (mut power, mut slope) = (house_w, 0.0);
    for load in loads {
        let Ok((p, s)) = load.motor.load(load.duty, voltage, load.omega, load.power_cut) else { return Err(BatteryError); };
        power += p;
        slope += s;
    }
    if power.is_finite() && slope.is_finite() { Ok((power, slope)) } else { Err(BatteryError) }
}

/// A root of `f` (value, slope) in `[low, high]`, where it does not fall from below zero to above it:
/// Newton while it stays inside the bracket, halving otherwise, and always after `NEWTON_STEPS`.
fn root(mut f: impl FnMut(f64) -> Result<(f64, f64), BatteryError>, mut low: f64, mut high: f64, guess: f64) -> Result<(f64, u32), BatteryError> {
    let mut v = if guess > low && guess < high { guess } else { 0.5 * (low + high) };
    for step in 1..=MAX_STEPS {
        let (value, slope) = f(v)?;
        if value == 0.0 { return Ok((v, step)); }
        if value < 0.0 { low = v; } else { high = v; }
        let newton = v - value / slope;
        // Tested first: at the root Newton lands on the bracket's edge, not inside it.
        if (newton - v).abs() <= TOLERANCE_V { return Ok((newton, step)); }
        let next = if step <= NEWTON_STEPS && newton > low && newton < high { newton } else { 0.5 * (low + high) };
        if (next - v).abs() <= TOLERANCE_V { return Ok((next, step)); }
        v = next;
    }
    Err(BatteryError)
}

/// Solves the bus for one step of `loads`, at most 32, at a charge. Changes nothing.
pub fn solve(battery: &Battery, soc: f64, house_w: f64, dt: f64, loads: &[MotorLoad]) -> Result<BusSolution, BatteryError> {
    if loads.len() > 32 { return Err(BatteryError); }
    let limits = battery.limits(soc, house_w, dt)?;
    let (open, rb) = (limits.open_circuit_v, limits.resistance_ohm);
    // A depleted pack is a hard cut.
    if soc == 0.0 {
        return Ok(BusSolution { motor_voltage_v: 0.0, pack_voltage_v: 0.0, limited: house_w > 0.0, iterations: 0 });
    }
    let lowest = open - limits.max_discharge_a * rb;
    let most = limits.max_discharge_a * lowest;
    let (at_lowest, _) = demand(loads, house_w, lowest)?;
    if at_lowest > most {
        // The house load comes first: if it takes everything, the motors get nothing.
        if house_w >= most {
            return Ok(BusSolution { motor_voltage_v: 0.0, pack_voltage_v: lowest, limited: true, iterations: 0 });
        }
        let guess = lowest * most / at_lowest;
        let (voltage, iterations) = root(|v| { let (p, s) = demand(loads, house_w, v)?; Ok((p - most, s)) }, 0.0, lowest, guess)?;
        return Ok(BusSolution { motor_voltage_v: voltage, pack_voltage_v: lowest, limited: true, iterations });
    }
    let highest = open + limits.max_charge_a * rb;
    let (at_highest, _) = demand(loads, house_w, highest)?;
    let absorbed = -limits.max_charge_a * highest;
    if at_highest < absorbed {
        return Ok(BusSolution { motor_voltage_v: highest, pack_voltage_v: highest, limited: true, iterations: 0 });
    }
    if rb == 0.0 {
        return Ok(BusSolution { motor_voltage_v: open, pack_voltage_v: open, limited: false, iterations: 0 });
    }
    // The pack's own answer to what the motors ask at the open-circuit voltage starts the solver near the root.
    let (at_open, _) = demand(loads, house_w, open)?;
    let discriminant = (open * open - 4.0 * rb * at_open).max(0.0);
    let guess = open - rb * 2.0 * at_open / (open + discriminant.sqrt());
    let (voltage, iterations) = root(|v| { let (p, s) = demand(loads, house_w, v)?; Ok((rb * p - v * (open - v), rb * s - open + 2.0 * v)) }, lowest, highest, guess)?;
    Ok(BusSolution { motor_voltage_v: voltage, pack_voltage_v: voltage, limited: false, iterations })
}
