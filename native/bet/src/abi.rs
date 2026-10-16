//! Checked C ABI records and arena binding for the BET engine (TASK-018).
//!
//! Layouts are byte offsets into little-endian records (docs/SPECS_SIMULATION_ENGINES.md
//! section 4, mirrored in `include/bet.h` and `packages/wasm-bet/src/arena.ts`).
//! Records are read and written field by field from byte slices: no Rust
//! struct, reference, `Vec`, `bool`, or enum layout ever crosses the boundary.
//! Everything here is safe code over slices; the wasm32 export layer in
//! `lib.rs` turns validated `u32` pointers into those slices.
//!
//! The production ABI has no polar-table binding yet. `step` validates its
//! input, overwrites every rotor output record in place with NaN aerodynamic
//! quantities and `FLAG_AERODYNAMICS_UNAVAILABLE`, and returns
//! `STATUS_AERODYNAMICS_UNAVAILABLE`. It never reports success.

/// Maximum rotors per engine instance (section 2).
pub const MAX_ROTORS: u32 = 32;
/// Maximum radial stations per blade (section 2).
pub const MAX_STATIONS: u32 = 64;
/// Maximum azimuth quadrature samples (section 2).
pub const MAX_AZIMUTH_SAMPLES: u32 = 64;
/// Maximum blades per rotor accepted by the configuration validator.
pub const MAX_BLADES: u32 = 16;
/// Alignment of every record and region, in bytes.
pub const RECORD_ALIGN: u32 = 8;
/// Largest accepted deviation of `|q_hb|` from one.
pub const QUATERNION_NORM_TOLERANCE: f64 = 1e-9;

/// Configuration header: 64 bytes, followed by `rotor_count` rotor configs.
pub mod config {
    /// Header size in bytes.
    pub const HEADER_BYTES: u32 = 64;
    /// u32: must equal `BET_ABI_VERSION`.
    pub const ABI_VERSION: usize = 0;
    /// u32: total configuration bytes; must equal the length passed to the export.
    pub const CONFIG_BYTES: usize = 4;
    /// u32: 1..=MAX_ROTORS.
    pub const ROTOR_COUNT: usize = 8;
    /// u32: must equal `rotor::BYTES`.
    pub const ROTOR_STRIDE: usize = 12;
    /// f64: fixed step, exactly 1/400, 1/800, or 1/1200 s.
    pub const DT_S: usize = 16;
    /// 40 reserved bytes; must be zero.
    pub const RESERVED: usize = 24;
}

/// Rotor configuration record (`RotorGeometry`, section 2): 2160 bytes.
pub mod rotor {
    /// Record size in bytes.
    pub const BYTES: u32 = 2160;
    /// u32: caller-assigned rotor identifier.
    pub const ID: usize = 0;
    /// u32: 1..=MAX_BLADES.
    pub const BLADE_COUNT: usize = 4;
    /// i32: +1 or -1.
    pub const SPIN_SIGN: usize = 8;
    /// u32: 1..=MAX_STATIONS.
    pub const STATION_COUNT: usize = 12;
    /// u32: 1..=MAX_AZIMUTH_SAMPLES.
    pub const AZIMUTH_SAMPLES: usize = 16;
    /// u32: polar table identifier (resolved by the polar lookup, TASK-019).
    pub const POLAR_ID: usize = 20;
    /// f64: blade radius, m, > 0.
    pub const RADIUS_M: usize = 24;
    /// f64: root cutout, m, in [0, radius).
    pub const ROOT_CUTOUT_M: usize = 32;
    /// f64[3]: hub position in body FRD axes, m.
    pub const HUB_POSITION_BODY_M: usize = 40;
    /// f64[4]: hub-to-body unit quaternion (w, x, y, z).
    pub const HUB_TO_BODY: usize = 64;
    /// f64: shaft polar inertia, kg m^2, > 0.
    pub const SHAFT_INERTIA_KG_M2: usize = 96;
    /// f64: bearing viscous coefficient, N m s/rad, >= 0.
    pub const BEARING_VISCOUS_NM_PER_RAD_S: usize = 104;
    /// f64[64]: radial stations, m, strictly increasing in [root cutout, radius].
    pub const RADIAL_STATION_M: usize = 112;
    /// f64[64]: chord, m, > 0.
    pub const CHORD_M: usize = 624;
    /// f64[64]: twist, rad, finite.
    pub const TWIST_RAD: usize = 1136;
    /// f64[64]: quadrature width, m, > 0.
    pub const QUADRATURE_WIDTH_M: usize = 1648;
}

/// Step input header: 64 bytes, followed by `rotor_count` rotor inputs.
pub mod input {
    /// Header size in bytes.
    pub const HEADER_BYTES: u32 = 64;
    /// u32: must equal the configured rotor count.
    pub const ROTOR_COUNT: usize = 0;
    /// u32: must equal `rotor_input::BYTES`.
    pub const ROTOR_STRIDE: usize = 4;
    /// f64: air density, kg/m^3, > 0.
    pub const DENSITY_KG_M3: usize = 8;
    /// f64: dynamic viscosity, Pa s, > 0.
    pub const DYNAMIC_VISCOSITY_PA_S: usize = 16;
    /// f64: speed of sound, m/s, > 0.
    pub const SPEED_OF_SOUND_MPS: usize = 24;
    /// 32 reserved bytes; must be zero.
    pub const RESERVED: usize = 32;
}

/// Per-rotor step input record (`RotorStepInput`, section 2): 96 bytes.
pub mod rotor_input {
    /// Record size in bytes.
    pub const BYTES: u32 = 96;
    /// f64[3]: air velocity minus hub velocity, hub axes, m/s.
    pub const AIR_VELOCITY_AT_HUB_HUB_MPS: usize = 0;
    /// f64[3]: body angular velocity in hub axes, rad/s.
    pub const BODY_ANGULAR_VELOCITY_HUB_RAD_S: usize = 24;
    /// f64: collective pitch, rad.
    pub const COLLECTIVE_PITCH_RAD: usize = 48;
    /// f64: cosine cyclic pitch, rad.
    pub const CYCLIC_COS_RAD: usize = 56;
    /// f64: sine cyclic pitch, rad.
    pub const CYCLIC_SIN_RAD: usize = 64;
    /// f64: motor torque magnitude, N m, >= 0 (zero for a free rotor).
    pub const MOTOR_TORQUE_MAGNITUDE_NM: usize = 72;
    /// u32: must be zero.
    pub const FLAGS: usize = 80;
    /// 12 reserved bytes; must be zero.
    pub const RESERVED: usize = 84;
}

/// Rotor output record (`RotorOutput`, section 4): 128 bytes.
pub mod output {
    /// Record size in bytes.
    pub const BYTES: u32 = 128;
    /// f64[3]: aerodynamic force, hub axes, N.
    pub const FORCE_HUB_N: usize = 0;
    /// f64[3]: aerodynamic moment about the hub, hub axes, N m.
    pub const AIR_MOMENT_HUB_NM: usize = 24;
    /// f64[3]: transmitted moment (air moment minus dH/dt), hub axes, N m.
    pub const TRANSMITTED_MOMENT_HUB_NM: usize = 48;
    /// f64: rotor speed, rad/s, >= 0.
    pub const OMEGA_RAD_S: usize = 72;
    /// f64: signed aerodynamic shaft torque along the positive hub axis, N m.
    pub const AERO_SHAFT_TORQUE_NM: usize = 80;
    /// f64: motor drive power, W.
    pub const SHAFT_POWER_W: usize = 88;
    /// f64: induced axial velocity, m/s.
    pub const INDUCED_AXIAL_VELOCITY_MPS: usize = 96;
    /// f64: coning angle, rad.
    pub const CONE_RAD: usize = 104;
    /// u32: validity flags (`FLAG_*`).
    pub const FLAGS: usize = 112;
    /// u32: reserved, written as zero.
    pub const RESERVED: usize = 116;
    /// f64: signed angular momentum along the hub axis, N m s.
    pub const ANGULAR_MOMENTUM_NMS: usize = 120;
}

/// Engine arena header: 64 bytes, followed by a copy of the configuration and the rotor states.
pub mod arena {
    /// Header size in bytes.
    pub const HEADER_BYTES: u32 = 64;
    /// u32: `ARENA_MAGIC` while the instance is live.
    pub const MAGIC: usize = 0;
    /// u32: arena length in bytes.
    pub const ARENA_BYTES: usize = 4;
    /// u32: rotor count.
    pub const ROTOR_COUNT: usize = 8;
    /// u32: configuration bytes copied after the header.
    pub const CONFIG_BYTES: usize = 12;
    /// f64: configured step.
    pub const DT_S: usize = 16;
    /// u32: seed of the last reset.
    pub const SEED: usize = 24;
    /// u32: linear memory pages at initialization (wasm32); zero natively.
    pub const MEMORY_PAGES: usize = 28;
    /// u64: steps since the last reset.
    pub const STEP_COUNT: usize = 32;
    /// Per-rotor state record (`RotorState`): 8 x f64.
    pub const ROTOR_STATE_BYTES: u32 = 64;
    /// "MBET" little-endian.
    pub const ARENA_MAGIC: u32 = 0x5445_424d;
}

/// The step overwrote every rotor output record and the result is valid.
pub const STATUS_OK: i32 = 0;
/// The step overwrote every rotor output record, but aerodynamic quantities are NaN (no quadrature yet).
pub const STATUS_AERODYNAMICS_UNAVAILABLE: i32 = 1;
/// Unknown, disposed, or corrupt handle.
pub const STATUS_BAD_HANDLE: i32 = -1;
/// Out-of-range, misaligned, or overlapping region.
pub const STATUS_BAD_POINTER: i32 = -2;
/// Invalid count, stride, reserved field, or non-finite/out-of-range value.
pub const STATUS_BAD_INPUT: i32 = -3;
/// `dt_s` differs from the configured step.
pub const STATUS_BAD_DT: i32 = -4;
/// Linear memory grew after initialization.
pub const STATUS_MEMORY_GROWN: i32 = -5;
/// Arena smaller than `required_bytes`.
pub const STATUS_ARENA_TOO_SMALL: i32 = -6;
/// Configuration ABI version differs from `BET_ABI_VERSION`.
pub const STATUS_ABI_MISMATCH: i32 = -7;

/// Output flag: aerodynamic force, moments, and shaft torque are unavailable (NaN).
pub const FLAG_AERODYNAMICS_UNAVAILABLE: u32 = 1 << 0;
/// Output flag: a polar lookup was clamped at the table boundary (TASK-019/020).
pub const FLAG_OUTSIDE_POLAR_VALIDITY: u32 = 1 << 1;

const STEPS_PER_SECOND: [f64; 3] = [400.0, 800.0, 1200.0];

fn rd_u32(buf: &[u8], at: usize) -> Option<u32> {
    let bytes = buf.get(at..at.checked_add(4)?)?;
    Some(u32::from_le_bytes(bytes.try_into().ok()?))
}
fn rd_i32(buf: &[u8], at: usize) -> Option<i32> {
    rd_u32(buf, at).map(|value| value as i32)
}
fn rd_f64(buf: &[u8], at: usize) -> Option<f64> {
    let bytes = buf.get(at..at.checked_add(8)?)?;
    Some(f64::from_le_bytes(bytes.try_into().ok()?))
}
fn wr_u32(buf: &mut [u8], at: usize, value: u32) -> Option<()> {
    buf.get_mut(at..at.checked_add(4)?)?.copy_from_slice(&value.to_le_bytes());
    Some(())
}
fn wr_f64(buf: &mut [u8], at: usize, value: f64) -> Option<()> {
    buf.get_mut(at..at.checked_add(8)?)?.copy_from_slice(&value.to_le_bytes());
    Some(())
}
fn wr_u64(buf: &mut [u8], at: usize, value: u64) -> Option<()> {
    buf.get_mut(at..at.checked_add(8)?)?.copy_from_slice(&value.to_le_bytes());
    Some(())
}
fn rd_u64(buf: &[u8], at: usize) -> Option<u64> {
    let bytes = buf.get(at..at.checked_add(8)?)?;
    Some(u64::from_le_bytes(bytes.try_into().ok()?))
}
fn all_zero(buf: &[u8], at: usize, len: usize) -> bool {
    match buf.get(at..at.saturating_add(len)) {
        Some(bytes) => bytes.iter().all(|byte| *byte == 0),
        None => false,
    }
}
fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite())
}
fn positive(value: Option<f64>) -> Option<f64> {
    finite(value).filter(|v| *v > 0.0)
}

/// Bytes of a configuration with `rotor_count` rotors.
pub fn config_bytes(rotor_count: u32) -> u32 {
    config::HEADER_BYTES + rotor_count * rotor::BYTES
}
/// Bytes of a step input with `rotor_count` rotors.
pub fn input_bytes(rotor_count: u32) -> u32 {
    input::HEADER_BYTES + rotor_count * rotor_input::BYTES
}
/// Bytes of the output records for `rotor_count` rotors.
pub fn output_bytes(rotor_count: u32) -> u32 {
    rotor_count * output::BYTES
}

/// True when `ptr..ptr+len` lies inside `memory_bytes`, is non-null, and is `RECORD_ALIGN`-aligned.
pub fn region_valid(ptr: u32, len: u32, memory_bytes: u64) -> bool {
    ptr != 0 && ptr % RECORD_ALIGN == 0 && len > 0 && u64::from(ptr) + u64::from(len) <= memory_bytes
}
/// True when two byte ranges share at least one byte.
pub fn regions_overlap(a: u32, a_len: u32, b: u32, b_len: u32) -> bool {
    u64::from(a) < u64::from(b) + u64::from(b_len) && u64::from(b) < u64::from(a) + u64::from(a_len)
}

fn valid_dt(dt_s: f64) -> bool {
    // Exactly the f64 nearest 1/hz: the configured step, never a near miss.
    STEPS_PER_SECOND.iter().any(|hz| dt_s == 1.0 / hz)
}

fn validate_rotor(record: &[u8]) -> Option<()> {
    let blades = rd_u32(record, rotor::BLADE_COUNT)?;
    let spin = rd_i32(record, rotor::SPIN_SIGN)?;
    let stations = rd_u32(record, rotor::STATION_COUNT)?;
    let azimuth = rd_u32(record, rotor::AZIMUTH_SAMPLES)?;
    if !(1..=MAX_BLADES).contains(&blades) || (spin != 1 && spin != -1) || !(1..=MAX_STATIONS).contains(&stations)
        || !(1..=MAX_AZIMUTH_SAMPLES).contains(&azimuth) {
        return None;
    }
    let radius = positive(rd_f64(record, rotor::RADIUS_M))?;
    let root = finite(rd_f64(record, rotor::ROOT_CUTOUT_M))?;
    if !(root >= 0.0 && root < radius) {
        return None;
    }
    for axis in 0..3 {
        finite(rd_f64(record, rotor::HUB_POSITION_BODY_M + 8 * axis))?;
    }
    let mut norm_sq = 0.0;
    for component in 0..4 {
        let q = finite(rd_f64(record, rotor::HUB_TO_BODY + 8 * component))?;
        norm_sq += q * q;
    }
    if !((norm_sq.sqrt() - 1.0).abs() <= QUATERNION_NORM_TOLERANCE) {
        return None;
    }
    positive(rd_f64(record, rotor::SHAFT_INERTIA_KG_M2))?;
    finite(rd_f64(record, rotor::BEARING_VISCOUS_NM_PER_RAD_S)).filter(|v| *v >= 0.0)?;
    let mut previous = f64::NEG_INFINITY;
    for i in 0..MAX_STATIONS as usize {
        let r = rd_f64(record, rotor::RADIAL_STATION_M + 8 * i)?;
        let chord = rd_f64(record, rotor::CHORD_M + 8 * i)?;
        let twist = rd_f64(record, rotor::TWIST_RAD + 8 * i)?;
        let width = rd_f64(record, rotor::QUADRATURE_WIDTH_M + 8 * i)?;
        if i < stations as usize {
            let in_span = r >= root && r <= radius && r > previous;
            if !in_span || !(chord > 0.0 && chord.is_finite()) || !twist.is_finite() || !(width > 0.0 && width.is_finite()) {
                return None;
            }
            previous = r;
        } else if [r, chord, twist, width].iter().any(|v| v.to_bits() != 0) {
            return None; // unused slots are +0.0 so they cannot acquire a meaning later
        }
    }
    Some(())
}

/// Validates a configuration and returns the rotor count, or an error status.
pub fn validate_config(config: &[u8]) -> Result<u32, i32> {
    let len = u32::try_from(config.len()).map_err(|_| STATUS_BAD_INPUT)?;
    if len < config::HEADER_BYTES {
        return Err(STATUS_BAD_INPUT);
    }
    let abi = rd_u32(config, config::ABI_VERSION).ok_or(STATUS_BAD_INPUT)?;
    if abi != crate::BET_ABI_VERSION {
        return Err(STATUS_ABI_MISMATCH);
    }
    let count = rd_u32(config, config::ROTOR_COUNT).ok_or(STATUS_BAD_INPUT)?;
    if !(1..=MAX_ROTORS).contains(&count)
        || rd_u32(config, config::CONFIG_BYTES) != Some(len) || len != config_bytes(count)
        || rd_u32(config, config::ROTOR_STRIDE) != Some(rotor::BYTES)
        || !rd_f64(config, config::DT_S).is_some_and(valid_dt)
        || !all_zero(config, config::RESERVED, config::HEADER_BYTES as usize - config::RESERVED) {
        return Err(STATUS_BAD_INPUT);
    }
    for index in 0..count as usize {
        let at = config::HEADER_BYTES as usize + index * rotor::BYTES as usize;
        let record = config.get(at..at + rotor::BYTES as usize).ok_or(STATUS_BAD_INPUT)?;
        validate_rotor(record).ok_or(STATUS_BAD_INPUT)?;
    }
    Ok(count)
}

/// Arena bytes required for a valid configuration.
pub fn required_bytes(config: &[u8]) -> Result<u32, i32> {
    let count = validate_config(config)?;
    Ok(arena::HEADER_BYTES + config_bytes(count) + count * arena::ROTOR_STATE_BYTES)
}

/// Initializes an arena from a configuration (copied, so the caller may reuse its buffer).
pub fn init(config: &[u8], arena_buf: &mut [u8], memory_pages: u32) -> Result<(), i32> {
    let required = required_bytes(config)?;
    let arena_len = u32::try_from(arena_buf.len()).map_err(|_| STATUS_BAD_POINTER)?;
    if arena_len < required {
        return Err(STATUS_ARENA_TOO_SMALL);
    }
    let count = rd_u32(config, config::ROTOR_COUNT).ok_or(STATUS_BAD_INPUT)?;
    let dt = rd_f64(config, config::DT_S).ok_or(STATUS_BAD_INPUT)?;
    arena_buf.fill(0);
    let header = arena::HEADER_BYTES as usize;
    arena_buf.get_mut(header..header + config.len()).ok_or(STATUS_ARENA_TOO_SMALL)?.copy_from_slice(config);
    let fields = (|| {
        wr_u32(arena_buf, arena::ARENA_BYTES, arena_len)?;
        wr_u32(arena_buf, arena::ROTOR_COUNT, count)?;
        wr_u32(arena_buf, arena::CONFIG_BYTES, config_bytes(count))?;
        wr_f64(arena_buf, arena::DT_S, dt)?;
        wr_u32(arena_buf, arena::MEMORY_PAGES, memory_pages)?;
        wr_u32(arena_buf, arena::MAGIC, arena::ARENA_MAGIC) // last: the instance is live only when complete
    })();
    fields.ok_or(STATUS_ARENA_TOO_SMALL)
}

/// Rotor count of a live arena header, or `STATUS_BAD_HANDLE`.
pub fn live_rotor_count(arena_buf: &[u8]) -> Result<u32, i32> {
    let live = rd_u32(arena_buf, arena::MAGIC) == Some(arena::ARENA_MAGIC)
        && rd_u32(arena_buf, arena::ARENA_BYTES).is_some_and(|len| len as usize == arena_buf.len());
    let count = rd_u32(arena_buf, arena::ROTOR_COUNT).filter(|n| live && (1..=MAX_ROTORS).contains(n));
    count.ok_or(STATUS_BAD_HANDLE)
}

fn rotor_config<'a>(arena_buf: &'a [u8], index: usize) -> Option<&'a [u8]> {
    let at = (arena::HEADER_BYTES + config::HEADER_BYTES) as usize + index * rotor::BYTES as usize;
    arena_buf.get(at..at + rotor::BYTES as usize)
}
fn state_offset(count: u32, index: usize) -> usize {
    (arena::HEADER_BYTES + config_bytes(count)) as usize + index * arena::ROTOR_STATE_BYTES as usize
}

fn validate_input(input_buf: &[u8], count: u32) -> Option<()> {
    if input_buf.len() != input_bytes(count) as usize || rd_u32(input_buf, input::ROTOR_COUNT)? != count
        || rd_u32(input_buf, input::ROTOR_STRIDE)? != rotor_input::BYTES {
        return None;
    }
    positive(rd_f64(input_buf, input::DENSITY_KG_M3))?;
    positive(rd_f64(input_buf, input::DYNAMIC_VISCOSITY_PA_S))?;
    positive(rd_f64(input_buf, input::SPEED_OF_SOUND_MPS))?;
    if !all_zero(input_buf, input::RESERVED, input::HEADER_BYTES as usize - input::RESERVED) {
        return None;
    }
    for index in 0..count as usize {
        let at = input::HEADER_BYTES as usize + index * rotor_input::BYTES as usize;
        for field in 0..9 {
            finite(rd_f64(input_buf, at + 8 * field))?; // velocity[3], angular velocity[3], collective, cyclic cos/sin
        }
        finite(rd_f64(input_buf, at + rotor_input::MOTOR_TORQUE_MAGNITUDE_NM)).filter(|v| *v >= 0.0)?;
        if !all_zero(input_buf, at + rotor_input::FLAGS, rotor_input::BYTES as usize - rotor_input::FLAGS) {
            return None;
        }
    }
    Some(())
}

/// Advances one fixed step. Validates the input first; on a negative status no
/// output byte is written. Otherwise every rotor output record is overwritten.
pub fn step(arena_buf: &mut [u8], input_buf: &[u8], out: &mut [u8], dt_s: f64) -> i32 {
    let count = match live_rotor_count(arena_buf) {
        Ok(count) => count,
        Err(status) => return status,
    };
    if rd_f64(arena_buf, arena::DT_S).map(f64::to_bits) != Some(dt_s.to_bits()) {
        return STATUS_BAD_DT;
    }
    if out.len() != output_bytes(count) as usize {
        return STATUS_BAD_POINTER;
    }
    if validate_input(input_buf, count).is_none() {
        return STATUS_BAD_INPUT;
    }
    for index in 0..count as usize {
        let written = (|| {
            let geometry = rotor_config(arena_buf, index)?;
            let spin = f64::from(rd_i32(geometry, rotor::SPIN_SIGN)?);
            let inertia = rd_f64(geometry, rotor::SHAFT_INERTIA_KG_M2)?;
            let state = state_offset(count, index);
            let omega = rd_f64(arena_buf, state)?;
            let induced = rd_f64(arena_buf, state + 16)?;
            let cone = rd_f64(arena_buf, state + 24)?;
            let at = input::HEADER_BYTES as usize + index * rotor_input::BYTES as usize;
            let motor_torque = rd_f64(input_buf, at + rotor_input::MOTOR_TORQUE_MAGNITUDE_NM)?;
            let record = out.get_mut(index * output::BYTES as usize..(index + 1) * output::BYTES as usize)?;
            for slot in 0..9 {
                wr_f64(record, output::FORCE_HUB_N + 8 * slot, f64::NAN)?; // force, air and transmitted moments
            }
            wr_f64(record, output::OMEGA_RAD_S, omega)?;
            wr_f64(record, output::AERO_SHAFT_TORQUE_NM, f64::NAN)?;
            wr_f64(record, output::SHAFT_POWER_W, motor_torque * omega)?;
            wr_f64(record, output::INDUCED_AXIAL_VELOCITY_MPS, induced)?;
            wr_f64(record, output::CONE_RAD, cone)?;
            wr_u32(record, output::FLAGS, FLAG_AERODYNAMICS_UNAVAILABLE)?;
            wr_u32(record, output::RESERVED, 0)?;
            wr_f64(record, output::ANGULAR_MOMENTUM_NMS, spin * inertia * omega)
        })();
        if written.is_none() {
            return STATUS_BAD_POINTER; // unreachable for validated lengths; never panic
        }
    }
    let steps = rd_u64(arena_buf, arena::STEP_COUNT).unwrap_or(0).wrapping_add(1);
    if wr_u64(arena_buf, arena::STEP_COUNT, steps).is_none() {
        return STATUS_BAD_HANDLE;
    }
    STATUS_AERODYNAMICS_UNAVAILABLE
}

/// Resets every rotor state to rest and records the seed.
pub fn reset(arena_buf: &mut [u8], seed: u32) -> i32 {
    let count = match live_rotor_count(arena_buf) {
        Ok(count) => count,
        Err(status) => return status,
    };
    let start = state_offset(count, 0);
    let end = state_offset(count, count as usize);
    match arena_buf.get_mut(start..end) {
        Some(states) => states.fill(0),
        None => return STATUS_BAD_HANDLE,
    }
    if wr_u32(arena_buf, arena::SEED, seed).is_none() || wr_u64(arena_buf, arena::STEP_COUNT, 0).is_none() {
        return STATUS_BAD_HANDLE;
    }
    STATUS_OK
}

/// Marks the arena dead; later calls with its handle return `STATUS_BAD_HANDLE`.
pub fn dispose(arena_buf: &mut [u8]) {
    if live_rotor_count(arena_buf).is_ok() {
        let _ = wr_u32(arena_buf, arena::MAGIC, 0);
    }
}

/// Steps since the last reset (diagnostics and tests).
pub fn step_count(arena_buf: &[u8]) -> Option<u64> {
    rd_u64(arena_buf, arena::STEP_COUNT)
}
/// Linear memory pages recorded at initialization.
pub fn memory_pages(arena_buf: &[u8]) -> Option<u32> {
    rd_u32(arena_buf, arena::MEMORY_PAGES)
}
/// Arena length recorded in a live header that starts `arena_buf` (may be shorter than the arena).
pub fn arena_len(header: &[u8]) -> Option<u32> {
    if rd_u32(header, arena::MAGIC) != Some(arena::ARENA_MAGIC) {
        return None;
    }
    rd_u32(header, arena::ARENA_BYTES)
}
