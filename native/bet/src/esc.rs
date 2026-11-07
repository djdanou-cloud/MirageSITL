//! ESC v2 (TASK-105): what an ESC makes of its command before the motor sees it. The command protocol quantizes it, each
//! frame arrives a fixed number of frames late, the ESC samples only at its frame rate, ramps its output at a limited
//! slope, and does not start a stopped motor below its start duty. Desynchronization is not modelled.
//!
//! * DShot carries throttle as an 11-bit value: 0 is stop, 1–47 are commands, and 48–2047 are 2000 throttle steps
//!   (the DShot protocol as Betaflight and BLHeli_32 define it, and ArduPilot's AP_HAL::RCOutput sends it).
//! * PWM carries it as a pulse width; the ESC resolves it to its own timer step.
//!
//! `EscShaper::step` neither allocates nor panics: its frame ring is a fixed array.

/// Invalid configuration or input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EscError;

/// The DShot value of a throttle in [0, 1]: 0 for a zero throttle, else 48 + round(throttle·1999), at most 2047.
pub fn dshot_value(throttle: f64) -> Result<u16, EscError> {
    if !throttle.is_finite() || !(0.0..=1.0).contains(&throttle) {
        return Err(EscError);
    }
    if throttle == 0.0 {
        return Ok(0);
    }
    Ok((48.0 + (throttle * 1999.0).round()).min(2047.0) as u16)
}
/// The throttle a DShot value carries: (value − 48)/1999 for a throttle value, 0 for stop and the command values.
pub fn dshot_throttle(value: u16) -> f64 {
    if value < 48 { 0.0 } else { (f64::from(value.min(2047)) - 48.0) / 1999.0 }
}
/// The throttle of a PWM pulse resolved to the ESC's timer step: the pulse rounded to a multiple of `step_us`, then mapped
/// from [min_us, max_us] to [0, 1].
pub fn pwm_throttle(pulse_us: f64, min_us: f64, max_us: f64, step_us: f64) -> Result<f64, EscError> {
    if ![pulse_us, min_us, max_us, step_us].iter().all(|v| v.is_finite()) || !(max_us > min_us) || step_us <= 0.0 {
        return Err(EscError);
    }
    let resolved = (pulse_us / step_us).round() * step_us;
    Ok(((resolved - min_us) / (max_us - min_us)).clamp(0.0, 1.0))
}

/// The most frames an ESC can be late by.
pub const MAX_LATENCY_FRAMES: usize = 8;

/// The ESC command path: frame sampling, latency, ramp limit and start duty.
#[derive(Clone, Copy, Debug)]
pub struct EscShaper {
    frame_period_s: f64,
    latency_frames: usize,
    ramp_per_s: f64,
    start_duty: f64,
}
/// The state of an [`EscShaper`] the caller stores between steps.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EscShaperState {
    /// Frames in flight, oldest first.
    pub frames: [f64; MAX_LATENCY_FRAMES],
    /// The command the ESC acts on now.
    pub command: f64,
    /// Its output duty.
    pub duty: f64,
    /// Seconds to the next frame.
    pub countdown_s: f64,
    /// The motor is turning: its duty has reached the start duty since it last stopped.
    pub running: bool,
}
impl EscShaper {
    /// Validates once, outside the step: a frame period above 0 and at most 0.1 s, at most 8 frames of latency, a ramp
    /// slope above 0 per second (infinite for none), and a start duty in [0, 1).
    pub fn new(frame_period_s: f64, latency_frames: usize, ramp_per_s: f64, start_duty: f64) -> Result<Self, EscError> {
        if !frame_period_s.is_finite() || frame_period_s <= 0.0 || frame_period_s > 0.1 || latency_frames > MAX_LATENCY_FRAMES
            || ramp_per_s.is_nan() || ramp_per_s <= 0.0 || !start_duty.is_finite() || !(0.0..1.0).contains(&start_duty) {
            return Err(EscError);
        }
        Ok(Self { frame_period_s, latency_frames, ramp_per_s, start_duty })
    }
    /// One step of `dt` with the command `target` the autopilot sends now. A new frame enters when the countdown runs out;
    /// the ESC acts on the frame sent `latency_frames` frames earlier. Its duty moves towards that command by at most
    /// ramp·dt; a stopped motor stays at 0 until the command reaches the start duty, and a command of 0 stops it.
    pub fn step(&self, state: &mut EscShaperState, target: f64, dt: f64) -> Result<f64, EscError> {
        if !target.is_finite() || !(0.0..=1.0).contains(&target) || !dt.is_finite() || dt <= 0.0 || dt > 0.01 {
            return Err(EscError);
        }
        if state.countdown_s <= dt * 1e-9 {
            if self.latency_frames == 0 {
                state.command = target;
            } else {
                state.command = state.frames[0];
                for i in 1..self.latency_frames {
                    state.frames[i - 1] = state.frames[i];
                }
                state.frames[self.latency_frames - 1] = target;
            }
            state.countdown_s += self.frame_period_s;
        }
        state.countdown_s = (state.countdown_s - dt).max(0.0);
        let command = state.command;
        if command == 0.0 {
            state.running = false;
        } else if !state.running && command >= self.start_duty {
            state.running = true;
        }
        let wanted = if state.running { command } else { 0.0 };
        let limit = self.ramp_per_s * dt;
        state.duty = if wanted > state.duty { (state.duty + limit).min(wanted) } else { (state.duty - limit).max(wanted) };
        Ok(state.duty)
    }
}
