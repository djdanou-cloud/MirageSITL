//! Bound-rotor step interface v2 (TASK-088): 256-byte input and output records
//! on unchanged v1 arenas. Fields owned by later tasks are fail-closed: until
//! the owning task lands they must hold their neutral value, otherwise the step
//! returns `UNSUPPORTED` and changes neither state nor output. A neutral record
//! runs exactly the v1 step, so output bytes 0..128 equal the v1 output record.
//! Drive mode 1 (TASK-092) runs the ESC and voltage-driven motor: the drive
//! parameters sit in input bytes 192..256 and the ESC state in arena header
//! bytes 32..56.
use crate::bound::{self, Kernel};
use crate::motor::{DriveMotor, EscState};

/// Step record version.
pub const VERSION: u32 = 2;
/// Input record bytes.
pub const INPUT_BYTES: u32 = 256;
/// Output record bytes.
pub const OUTPUT_BYTES: u32 = 256;
/// A later-task field holds a non-neutral value.
pub const UNSUPPORTED: i32 = -8;
/// Input flag bit 0: a ground plane is supplied (TASK-100).
pub const INPUT_GROUND_PLANE: u32 = 1;
/// Drive mode 0: motor torque magnitude, the v1 semantics.
pub const DRIVE_TORQUE: u32 = 0;
/// Drive mode 1: ESC duty on a bus voltage (TASK-092).
pub const DRIVE_ESC_DUTY: u32 = 1;
/// Output validity bit: motor and bus currents, electrical power, copper loss (TASK-092).
pub const VALID_ELECTRICAL: u32 = 1;
/// Output validity bit: first-harmonic inflow states (TASK-098).
pub const VALID_INFLOW_HARMONICS: u32 = 2;
/// Output validity bit: ground effect applied (TASK-100).
pub const VALID_GROUND_EFFECT: u32 = 4;
/// Output validity bit: external wake applied (TASK-101).
pub const VALID_EXTERNAL_WAKE: u32 = 8;
/// Drive flag bit 0 (input word 248): the ESC has lost power; the motor freewheels.
pub const DRIVE_POWER_CUT: u32 = 1;
/// Output flag bit 5: the winding current sat at a limit on this step (drive mode 1).
pub const FLAG_CURRENT_LIMITED: u32 = 32;

fn word(b: &[u8], p: usize) -> u32 { u32::from_le_bytes([b[p], b[p + 1], b[p + 2], b[p + 3]]) }
fn value(b: &[u8], p: usize) -> f64 {
    let mut x = [0u8; 8];
    x.copy_from_slice(&b[p..p + 8]);
    f64::from_le_bytes(x)
}
fn zero(b: &[u8], a: usize, z: usize) -> bool { b[a..z].iter().all(|v| *v == 0) }
/// Every f64 slot in [a, z) is numerically zero; -0 is accepted.
fn neutral(b: &[u8], a: usize, z: usize) -> bool { (a..z).step_by(8).all(|p| value(b, p) == 0.0) }

fn put(b: &mut [u8], p: usize, v: f64) { b[p..p + 8].copy_from_slice(&v.to_le_bytes()); }
fn put_word(b: &mut [u8], p: usize, v: u32) { b[p..p + 4].copy_from_slice(&v.to_le_bytes()); }

/// One allocation-free fixed step. Statuses: 0, -2 record length, -3 invalid,
/// -7 version, `UNSUPPORTED`, and every v1 step status.
pub fn step(arena: &mut [u8], input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    step_with(arena, input, out, dt, Kernel::Production)
}

/// `step` on the reference rotor kernel (`bound::step_reference`, TASK-091),
/// for tests and benchmarks only; no WASM export calls it.
pub fn step_reference(arena: &mut [u8], input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    step_with(arena, input, out, dt, Kernel::Reference)
}

/// Record checks shared by both drive modes: lengths, version, flags, drive
/// mode, finite fields and the later-task fields that stay fail-closed.
fn prelude(input: &[u8], out_len: usize) -> Result<u32, i32> {
    if input.len() != INPUT_BYTES as usize || out_len != OUTPUT_BYTES as usize { return Err(-2); }
    if word(input, 0) != VERSION { return Err(-7); }
    let (flags, drive) = (word(input, 4), word(input, 8));
    if flags & !INPUT_GROUND_PLANE != 0 || drive > DRIVE_ESC_DUTY || !zero(input, 12, 16) { return Err(-3); }
    if !(16..192).step_by(8).all(|p| value(input, p).is_finite()) { return Err(-3); }
    // External wake (TASK-101) and ground plane (TASK-100) stay fail-closed.
    if !neutral(input, 136, 160) || flags & INPUT_GROUND_PLANE != 0 || !neutral(input, 160, 192) { return Err(UNSUPPORTED); }
    Ok(drive)
}

fn step_with(arena: &mut [u8], input: &[u8], out: &mut [u8], dt: f64, kernel: Kernel) -> i32 {
    let drive = match prelude(input, out.len()) { Ok(d) => d, Err(status) => return status };
    if drive == DRIVE_ESC_DUTY {
        let staged = match esc_predict(arena, input, dt, kernel).and_then(|p| esc_complete(&p, p.voltage, dt, kernel)) {
            Ok(s) => s,
            Err(status) => return status,
        };
        esc_commit(arena, out, &staged);
        return 0;
    }
    // Torque mode: ESC duty, bus voltage and the drive parameters stay neutral.
    if !zero(input, 192, 256) { return -3; }
    if !neutral(input, 120, 136) { return UNSUPPORTED; }
    // v2 bytes 16..120 hold the v1 step fields 8..112 in the same order.
    let mut v1 = [0u8; bound::INPUT_BYTES as usize];
    v1[0..4].copy_from_slice(&bound::VERSION.to_le_bytes());
    v1[8..112].copy_from_slice(&input[16..120]);
    let mut staged = [0u8; bound::OUTPUT_BYTES as usize];
    let status = if kernel == Kernel::Production { bound::step(arena, &v1, &mut staged, dt) } else { bound::step_reference(arena, &v1, &mut staged, dt) };
    if status != 0 { return status; }
    out.fill(0);
    out[0..128].copy_from_slice(&staged);
    // Validity word at 116 stays zero: no later-task output is available yet.
    0
}

/// A drive-mode-1 step computed up to its bus voltage (TASK-092): the ESC
/// command, the motor and the rotor's predictor do not depend on the voltage.
/// `esc_power` evaluates the terminal power at any voltage; `esc_complete`
/// finishes the step at one.
pub(crate) struct EscPredicted<'a> {
    rotor: bound::Predicted<'a>,
    motor: DriveMotor,
    command: EscState,
    cut: bool,
    /// The record's bus voltage, V.
    pub(crate) voltage: f64,
}

/// A computed drive-mode-1 step, not yet written.
pub(crate) struct EscStaged {
    advanced: bound::Advanced,
    output: [u8; OUTPUT_BYTES as usize],
    command: EscState,
    /// Terminal power of the step, W (output byte 160).
    pub(crate) terminal_power_w: f64,
}

/// Validates a drive-mode-1 record and predicts its step, writing nothing.
/// Statuses as `step`; a record in another drive mode is invalid (-3).
pub(crate) fn esc_prepare<'a>(arena: &'a [u8], input: &[u8], out_len: usize, dt: f64) -> Result<EscPredicted<'a>, i32> {
    if prelude(input, out_len)? != DRIVE_ESC_DUTY { return Err(-3); }
    esc_predict(arena, input, dt, Kernel::Production)
}

/// Drive mode 1 after the record checks: ESC command, the torque law at the
/// record's voltage, validated as before the drive step existed, and the
/// rotor's predictor.
fn esc_predict<'a>(arena: &'a [u8], input: &[u8], dt: f64, kernel: Kernel) -> Result<EscPredicted<'a>, i32> {
    let drive_flags = word(input, 248);
    if drive_flags & !DRIVE_POWER_CUT != 0 || !zero(input, 252, 256) || !(192..248).step_by(8).all(|p| value(input, p).is_finite())
        || value(input, 112) != 0.0 {
        return Err(-3);
    }
    let (target, voltage, cut) = (value(input, 120), value(input, 128), drive_flags & DRIVE_POWER_CUT != 0);
    if !(0.0..=1.0).contains(&target) || voltage < 0.0 { return Err(-3); }
    let Ok(motor) = DriveMotor::new(value(input, 192), value(input, 200), value(input, 208), value(input, 216),
        value(input, 224), value(input, 232), value(input, 240)) else { return Err(-3); };
    if bound::arena_len(arena) != Some(arena.len() as u32) { return Err(-1); }
    let state = EscState { duty: value(arena, 32), held: value(arena, 40), countdown_s: value(arena, 48) };
    let Ok(command) = motor.command(state, target, cut, dt) else { return Err(-3); };
    // arena_len established a full header, so the state words are in range.
    let omega = value(arena, 16);
    if motor.torque(command.duty, voltage, omega, cut).is_err() { return Err(-3); }
    let mut v1 = [0u8; bound::INPUT_BYTES as usize];
    v1[0..4].copy_from_slice(&bound::VERSION.to_le_bytes());
    v1[8..112].copy_from_slice(&input[16..120]);
    let rotor = bound::predict_with(arena, &v1, bound::OUTPUT_BYTES as usize, dt, true, kernel)?;
    Ok(EscPredicted { rotor, motor, command, cut, voltage })
}

/// The terminal power of a predicted step at bus voltage `voltage` ≥ 0, W:
/// the value `esc_complete` at that voltage writes at output byte 160.
pub(crate) fn esc_power(p: &EscPredicted<'_>, voltage: f64, dt: f64) -> Result<f64, i32> {
    let Ok(torque) = p.motor.torque(p.command.duty, voltage, p.rotor.omega(), p.cut) else { return Err(-3); };
    let half = bound::half_omega(&p.rotor, dt, Some(torque))?;
    let Ok(electrical) = p.motor.electrical(p.command.duty, voltage, half, p.cut) else { return Err(-3); };
    Ok(electrical.terminal_power_w)
}

/// Drive mode 1 at bus voltage `voltage`: torque law, rotor step and
/// electrical outputs, all computed before anything is written.
pub(crate) fn esc_complete(p: &EscPredicted<'_>, voltage: f64, dt: f64, kernel: Kernel) -> Result<EscStaged, i32> {
    let (motor, command, cut) = (p.motor, p.command, p.cut);
    let Ok(torque) = motor.torque(command.duty, voltage, p.rotor.omega(), cut) else { return Err(-3); };
    let advanced = bound::complete(&p.rotor, dt, Some(torque), kernel)?;
    // The electrical operating point at the midpoint speed, where the aerodynamics were evaluated.
    let Ok(electrical) = motor.electrical(command.duty, voltage, advanced.half_omega, cut) else { return Err(-3); };
    let bus_current = if voltage > 0.0 { electrical.terminal_power_w / voltage } else { 0.0 };
    if !bus_current.is_finite() { return Err(-3); }
    let mut staged = [0u8; OUTPUT_BYTES as usize];
    staged[0..128].copy_from_slice(&advanced.staged);
    if torque.current_limited {
        let flags = word(&staged, 112) | FLAG_CURRENT_LIMITED;
        put_word(&mut staged, 112, flags);
    }
    put_word(&mut staged, 116, VALID_ELECTRICAL);
    put(&mut staged, 144, electrical.current_a);
    put(&mut staged, 152, bus_current);
    put(&mut staged, 160, electrical.terminal_power_w);
    put(&mut staged, 168, electrical.copper_loss_w);
    Ok(EscStaged { advanced, output: staged, command, terminal_power_w: electrical.terminal_power_w })
}

/// Writes a computed drive-mode-1 step into its arena and output record.
pub(crate) fn esc_commit(arena: &mut [u8], out: &mut [u8], s: &EscStaged) {
    let mut scratch = [0u8; bound::OUTPUT_BYTES as usize];
    bound::commit(arena, &mut scratch, &s.advanced);
    put(arena, 32, s.command.duty);
    put(arena, 40, s.command.held);
    put(arena, 48, s.command.countdown_s);
    out.copy_from_slice(&s.output);
}
