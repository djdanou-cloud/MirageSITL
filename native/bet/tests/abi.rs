//! TASK-018: ABI record layouts and the checked arena binding.
//!
//! Layout oracle: `include/bet.h` (parsed here) and the golden records in
//! tests/fixtures/wasm-abi/bet-abi-v1.json, packed independently with Python
//! struct by tests/fixtures/wasm-abi/generate.py.
use mirage_bet::abi::{self, arena, config, input, output, rotor, rotor_input};

const HEADER: &str = include_str!("../include/bet.h");
const FIXTURE: &str = include_str!("../../../tests/fixtures/wasm-abi/bet-abi-v1.json");

fn define(name: &str) -> i64 {
    let prefix = format!("#define {name} ");
    let line = HEADER.lines().find(|line| line.starts_with(&prefix)).unwrap_or_else(|| panic!("{name} missing from bet.h"));
    line[prefix.len()..].split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or_else(|| panic!("{name} not an integer"))
}
fn fixture_hex(key: &str) -> Vec<u8> {
    let marker = format!("\"{key}\": \"");
    let start = FIXTURE.find(&marker).expect("fixture key") + marker.len();
    let hex = &FIXTURE[start..start + FIXTURE[start..].find('"').expect("closing quote")];
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex")).collect()
}
fn fixture_number(key: &str) -> u32 {
    let marker = format!("\"{key}\": ");
    let start = FIXTURE.find(&marker).expect("fixture key") + marker.len();
    FIXTURE[start..].split(|c: char| !c.is_ascii_digit()).next().and_then(|v| v.parse().ok()).expect("number")
}
fn f64_at(buf: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(buf[at..at + 8].try_into().unwrap())
}
fn u32_at(buf: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(buf[at..at + 4].try_into().unwrap())
}
fn put_f64(buf: &mut [u8], at: usize, value: f64) {
    buf[at..at + 8].copy_from_slice(&value.to_le_bytes());
}
fn put_u32(buf: &mut [u8], at: usize, value: u32) {
    buf[at..at + 4].copy_from_slice(&value.to_le_bytes());
}
fn engine() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let config = fixture_hex("configHex");
    let mut arena_buf = vec![0xa5; abi::required_bytes(&config).expect("valid golden config") as usize];
    abi::init(&config, &mut arena_buf, 0).expect("init");
    (arena_buf, fixture_hex("inputHex"), vec![0xa5; abi::output_bytes(2) as usize])
}
const DT: f64 = 1.0 / 400.0;

#[test]
fn rust_offsets_match_the_c_header() {
    let pairs: &[(&str, i64)] = &[
        ("BET_ABI_VERSION", mirage_bet::BET_ABI_VERSION.into()), ("BET_MAX_ROTORS", abi::MAX_ROTORS.into()),
        ("BET_MAX_STATIONS", abi::MAX_STATIONS.into()), ("BET_MAX_AZIMUTH_SAMPLES", abi::MAX_AZIMUTH_SAMPLES.into()),
        ("BET_MAX_BLADES", abi::MAX_BLADES.into()), ("BET_RECORD_ALIGN", abi::RECORD_ALIGN.into()),
        ("BET_CONFIG_HEADER_BYTES", config::HEADER_BYTES.into()), ("BET_CONFIG_ABI_VERSION", config::ABI_VERSION as i64),
        ("BET_CONFIG_CONFIG_BYTES", config::CONFIG_BYTES as i64), ("BET_CONFIG_ROTOR_COUNT", config::ROTOR_COUNT as i64),
        ("BET_CONFIG_ROTOR_STRIDE", config::ROTOR_STRIDE as i64), ("BET_CONFIG_DT_S", config::DT_S as i64),
        ("BET_CONFIG_RESERVED", config::RESERVED as i64),
        ("BET_ROTOR_BYTES", rotor::BYTES.into()), ("BET_ROTOR_ID", rotor::ID as i64),
        ("BET_ROTOR_BLADE_COUNT", rotor::BLADE_COUNT as i64), ("BET_ROTOR_SPIN_SIGN", rotor::SPIN_SIGN as i64),
        ("BET_ROTOR_STATION_COUNT", rotor::STATION_COUNT as i64), ("BET_ROTOR_AZIMUTH_SAMPLES", rotor::AZIMUTH_SAMPLES as i64),
        ("BET_ROTOR_POLAR_ID", rotor::POLAR_ID as i64), ("BET_ROTOR_RADIUS_M", rotor::RADIUS_M as i64),
        ("BET_ROTOR_ROOT_CUTOUT_M", rotor::ROOT_CUTOUT_M as i64), ("BET_ROTOR_HUB_POSITION_BODY_M", rotor::HUB_POSITION_BODY_M as i64),
        ("BET_ROTOR_HUB_TO_BODY", rotor::HUB_TO_BODY as i64), ("BET_ROTOR_SHAFT_INERTIA_KG_M2", rotor::SHAFT_INERTIA_KG_M2 as i64),
        ("BET_ROTOR_BEARING_VISCOUS_NM_PER_RAD_S", rotor::BEARING_VISCOUS_NM_PER_RAD_S as i64),
        ("BET_ROTOR_RADIAL_STATION_M", rotor::RADIAL_STATION_M as i64), ("BET_ROTOR_CHORD_M", rotor::CHORD_M as i64),
        ("BET_ROTOR_TWIST_RAD", rotor::TWIST_RAD as i64), ("BET_ROTOR_QUADRATURE_WIDTH_M", rotor::QUADRATURE_WIDTH_M as i64),
        ("BET_INPUT_HEADER_BYTES", input::HEADER_BYTES.into()), ("BET_INPUT_ROTOR_COUNT", input::ROTOR_COUNT as i64),
        ("BET_INPUT_ROTOR_STRIDE", input::ROTOR_STRIDE as i64), ("BET_INPUT_DENSITY_KG_M3", input::DENSITY_KG_M3 as i64),
        ("BET_INPUT_DYNAMIC_VISCOSITY_PA_S", input::DYNAMIC_VISCOSITY_PA_S as i64),
        ("BET_INPUT_SPEED_OF_SOUND_MPS", input::SPEED_OF_SOUND_MPS as i64), ("BET_INPUT_RESERVED", input::RESERVED as i64),
        ("BET_ROTOR_INPUT_BYTES", rotor_input::BYTES.into()),
        ("BET_ROTOR_INPUT_AIR_VELOCITY_AT_HUB_HUB_MPS", rotor_input::AIR_VELOCITY_AT_HUB_HUB_MPS as i64),
        ("BET_ROTOR_INPUT_BODY_ANGULAR_VELOCITY_HUB_RAD_S", rotor_input::BODY_ANGULAR_VELOCITY_HUB_RAD_S as i64),
        ("BET_ROTOR_INPUT_COLLECTIVE_PITCH_RAD", rotor_input::COLLECTIVE_PITCH_RAD as i64),
        ("BET_ROTOR_INPUT_CYCLIC_COS_RAD", rotor_input::CYCLIC_COS_RAD as i64),
        ("BET_ROTOR_INPUT_CYCLIC_SIN_RAD", rotor_input::CYCLIC_SIN_RAD as i64),
        ("BET_ROTOR_INPUT_MOTOR_TORQUE_MAGNITUDE_NM", rotor_input::MOTOR_TORQUE_MAGNITUDE_NM as i64),
        ("BET_ROTOR_INPUT_FLAGS", rotor_input::FLAGS as i64), ("BET_ROTOR_INPUT_RESERVED", rotor_input::RESERVED as i64),
        ("BET_OUTPUT_BYTES", output::BYTES.into()), ("BET_OUTPUT_FORCE_HUB_N", output::FORCE_HUB_N as i64),
        ("BET_OUTPUT_AIR_MOMENT_HUB_NM", output::AIR_MOMENT_HUB_NM as i64),
        ("BET_OUTPUT_TRANSMITTED_MOMENT_HUB_NM", output::TRANSMITTED_MOMENT_HUB_NM as i64),
        ("BET_OUTPUT_OMEGA_RAD_S", output::OMEGA_RAD_S as i64), ("BET_OUTPUT_AERO_SHAFT_TORQUE_NM", output::AERO_SHAFT_TORQUE_NM as i64),
        ("BET_OUTPUT_SHAFT_POWER_W", output::SHAFT_POWER_W as i64),
        ("BET_OUTPUT_INDUCED_AXIAL_VELOCITY_MPS", output::INDUCED_AXIAL_VELOCITY_MPS as i64),
        ("BET_OUTPUT_CONE_RAD", output::CONE_RAD as i64), ("BET_OUTPUT_FLAGS", output::FLAGS as i64),
        ("BET_OUTPUT_RESERVED", output::RESERVED as i64), ("BET_OUTPUT_ANGULAR_MOMENTUM_NMS", output::ANGULAR_MOMENTUM_NMS as i64),
        ("BET_ARENA_HEADER_BYTES", arena::HEADER_BYTES.into()), ("BET_ARENA_ROTOR_STATE_BYTES", arena::ROTOR_STATE_BYTES.into()),
        ("BET_STATUS_OK", abi::STATUS_OK.into()), ("BET_STATUS_AERODYNAMICS_UNAVAILABLE", abi::STATUS_AERODYNAMICS_UNAVAILABLE.into()),
        ("BET_STATUS_BAD_HANDLE", abi::STATUS_BAD_HANDLE.into()), ("BET_STATUS_BAD_POINTER", abi::STATUS_BAD_POINTER.into()),
        ("BET_STATUS_BAD_INPUT", abi::STATUS_BAD_INPUT.into()), ("BET_STATUS_BAD_DT", abi::STATUS_BAD_DT.into()),
        ("BET_STATUS_MEMORY_GROWN", abi::STATUS_MEMORY_GROWN.into()), ("BET_STATUS_ARENA_TOO_SMALL", abi::STATUS_ARENA_TOO_SMALL.into()),
        ("BET_STATUS_ABI_MISMATCH", abi::STATUS_ABI_MISMATCH.into()),
        ("BET_FLAG_AERODYNAMICS_UNAVAILABLE", abi::FLAG_AERODYNAMICS_UNAVAILABLE.into()),
        ("BET_FLAG_OUTSIDE_POLAR_VALIDITY", abi::FLAG_OUTSIDE_POLAR_VALIDITY.into()),
    ];
    for (name, value) in pairs {
        assert_eq!(define(name), *value, "{name}");
    }
    assert_eq!(HEADER.matches("#define BET_").count(), pairs.len(), "every bet.h define is checked");
    // Section 4 fixes the output record independently of this crate.
    assert_eq!((output::BYTES, output::FLAGS, output::ANGULAR_MOMENTUM_NMS), (128, 112, 120));
    // Every field lies inside its record and arrays end before the next field.
    assert_eq!(rotor::QUADRATURE_WIDTH_M + 8 * abi::MAX_STATIONS as usize, rotor::BYTES as usize);
    assert_eq!(rotor::RADIAL_STATION_M + 8 * 64, rotor::CHORD_M);
    assert_eq!(rotor_input::RESERVED + 12, rotor_input::BYTES as usize);
}

#[test]
fn golden_records_decode_and_size_the_arena() {
    let config = fixture_hex("configHex");
    assert_eq!(config.len() as u32, fixture_number("configBytes"));
    assert_eq!(config.len() as u32, abi::config_bytes(2));
    assert_eq!(abi::validate_config(&config), Ok(2));
    assert_eq!(abi::required_bytes(&config), Ok(fixture_number("requiredArenaBytes")));
    assert_eq!(fixture_hex("inputHex").len() as u32, abi::input_bytes(2));
    let second = &config[64 + 2160..];
    assert_eq!(u32_at(second, rotor::ID), 8);
    assert_eq!(u32_at(second, rotor::SPIN_SIGN) as i32, -1);
    assert_eq!(f64_at(second, rotor::RADIUS_M), 0.2);
    assert_eq!(f64_at(second, rotor::CHORD_M + 8), 0.02);
}

#[test]
fn rejects_invalid_configurations() {
    let golden = fixture_hex("configHex");
    let mutations: Vec<(&str, Box<dyn Fn(&mut Vec<u8>)>)> = vec![
        ("abi", Box::new(|c| put_u32(c, config::ABI_VERSION, 2))),
        ("length field", Box::new(|c| put_u32(c, config::CONFIG_BYTES, 64))),
        ("zero rotors", Box::new(|c| put_u32(c, config::ROTOR_COUNT, 0))),
        ("count/length mismatch", Box::new(|c| put_u32(c, config::ROTOR_COUNT, 1))),
        ("stride", Box::new(|c| put_u32(c, config::ROTOR_STRIDE, 2152))),
        ("dt near miss", Box::new(|c| put_f64(c, config::DT_S, 0.0025000000000000005))),
        ("dt 500 Hz", Box::new(|c| put_f64(c, config::DT_S, 1.0 / 500.0))),
        ("reserved", Box::new(|c| c[config::RESERVED + 3] = 1)),
        ("truncated", Box::new(|c| { c.pop(); })),
        ("spin zero", Box::new(|c| put_u32(c, 64 + rotor::SPIN_SIGN, 0))),
        ("blades", Box::new(|c| put_u32(c, 64 + rotor::BLADE_COUNT, 17))),
        ("stations", Box::new(|c| put_u32(c, 64 + rotor::STATION_COUNT, 65))),
        ("azimuth", Box::new(|c| put_u32(c, 64 + rotor::AZIMUTH_SAMPLES, 0))),
        ("radius NaN", Box::new(|c| put_f64(c, 64 + rotor::RADIUS_M, f64::NAN))),
        ("root at radius", Box::new(|c| put_f64(c, 64 + rotor::ROOT_CUTOUT_M, 0.127))),
        ("quaternion norm", Box::new(|c| put_f64(c, 64 + rotor::HUB_TO_BODY, 1.001))),
        ("inertia", Box::new(|c| put_f64(c, 64 + rotor::SHAFT_INERTIA_KG_M2, 0.0))),
        ("bearing", Box::new(|c| put_f64(c, 64 + rotor::BEARING_VISCOUS_NM_PER_RAD_S, -1e-9))),
        ("station order", Box::new(|c| put_f64(c, 64 + rotor::RADIAL_STATION_M + 8, 0.04))),
        ("station beyond tip", Box::new(|c| put_f64(c, 64 + rotor::RADIAL_STATION_M + 16, 0.13))),
        ("chord", Box::new(|c| put_f64(c, 64 + rotor::CHORD_M, -0.02))),
        ("twist inf", Box::new(|c| put_f64(c, 64 + rotor::TWIST_RAD, f64::INFINITY))),
        ("width", Box::new(|c| put_f64(c, 64 + rotor::QUADRATURE_WIDTH_M, 0.0))),
        ("unused slot", Box::new(|c| put_f64(c, 64 + rotor::CHORD_M + 8 * 3, 0.01))),
        ("unused -0.0", Box::new(|c| put_f64(c, 64 + rotor::TWIST_RAD + 8 * 63, -0.0))),
    ];
    for (name, mutate) in mutations {
        let mut bad = golden.clone();
        mutate(&mut bad);
        assert!(abi::validate_config(&bad).is_err(), "{name}");
        let mut arena_buf = vec![0; 8192];
        assert!(abi::init(&bad, &mut arena_buf, 0).is_err(), "{name}");
        assert!(abi::live_rotor_count(&arena_buf).is_err(), "{name}: no live arena after failed init");
    }
    let mut abi_bad = golden.clone();
    put_u32(&mut abi_bad, config::ABI_VERSION, 2);
    assert_eq!(abi::validate_config(&abi_bad), Err(abi::STATUS_ABI_MISMATCH));
    let required = abi::required_bytes(&golden).unwrap() as usize;
    let mut small = vec![0; required - 8];
    assert_eq!(abi::init(&golden, &mut small, 0), Err(abi::STATUS_ARENA_TOO_SMALL));
    for hz in [800.0, 1200.0] {
        let mut ok = golden.clone();
        put_f64(&mut ok, config::DT_S, 1.0 / hz);
        assert_eq!(abi::validate_config(&ok), Ok(2));
    }
}

#[test]
fn step_reports_unavailable_aerodynamics_and_overwrites_every_record() {
    let (mut arena_buf, input_buf, mut out) = engine();
    assert_eq!(abi::step(&mut arena_buf, &input_buf, &mut out, DT), abi::STATUS_AERODYNAMICS_UNAVAILABLE);
    for index in 0..2 {
        let record = &out[index * 128..(index + 1) * 128];
        for slot in 0..9 {
            assert!(f64_at(record, output::FORCE_HUB_N + 8 * slot).is_nan(), "force/moment {slot} is NaN, never a fake zero");
        }
        assert!(f64_at(record, output::AERO_SHAFT_TORQUE_NM).is_nan());
        assert_eq!(f64_at(record, output::OMEGA_RAD_S), 0.0); // at rest after init
        assert_eq!(f64_at(record, output::SHAFT_POWER_W), 0.0);
        assert_eq!(f64_at(record, output::ANGULAR_MOMENTUM_NMS), 0.0);
        assert_eq!(u32_at(record, output::FLAGS), abi::FLAG_AERODYNAMICS_UNAVAILABLE);
        assert_eq!(u32_at(record, output::RESERVED), 0);
    }
    assert_eq!(abi::step_count(&arena_buf), Some(1));
    // 1e6 steps keep overwriting the same caller buffer in place (no growth: the slices are fixed).
    let (ptr, len) = (out.as_ptr(), out.len());
    for _ in 0..1_000_000 {
        out[output::FLAGS] = 0xff;
        assert_eq!(abi::step(&mut arena_buf, &input_buf, &mut out, DT), abi::STATUS_AERODYNAMICS_UNAVAILABLE);
    }
    assert_eq!((out.as_ptr(), out.len(), u32_at(&out, output::FLAGS)), (ptr, len, abi::FLAG_AERODYNAMICS_UNAVAILABLE));
    assert_eq!(abi::step_count(&arena_buf), Some(1_000_001));
    assert_eq!(abi::reset(&mut arena_buf, 42), abi::STATUS_OK);
    assert_eq!(abi::step_count(&arena_buf), Some(0));
}

#[test]
fn step_rejects_bad_input_and_dt_without_writing_output() {
    let (mut arena_buf, golden_input, _) = engine();
    let mutations: Vec<(&str, i32, Box<dyn Fn(&mut Vec<u8>)>)> = vec![
        ("count", abi::STATUS_BAD_INPUT, Box::new(|i| put_u32(i, input::ROTOR_COUNT, 1))),
        ("stride", abi::STATUS_BAD_INPUT, Box::new(|i| put_u32(i, input::ROTOR_STRIDE, 88))),
        ("density", abi::STATUS_BAD_INPUT, Box::new(|i| put_f64(i, input::DENSITY_KG_M3, 0.0))),
        ("viscosity NaN", abi::STATUS_BAD_INPUT, Box::new(|i| put_f64(i, input::DYNAMIC_VISCOSITY_PA_S, f64::NAN))),
        ("speed of sound", abi::STATUS_BAD_INPUT, Box::new(|i| put_f64(i, input::SPEED_OF_SOUND_MPS, -1.0))),
        ("reserved", abi::STATUS_BAD_INPUT, Box::new(|i| i[input::RESERVED] = 1)),
        ("velocity inf", abi::STATUS_BAD_INPUT, Box::new(|i| put_f64(i, 64 + 96 + 8, f64::INFINITY))),
        ("cyclic NaN", abi::STATUS_BAD_INPUT, Box::new(|i| put_f64(i, 64 + rotor_input::CYCLIC_SIN_RAD, f64::NAN))),
        ("negative torque", abi::STATUS_BAD_INPUT, Box::new(|i| put_f64(i, 64 + rotor_input::MOTOR_TORQUE_MAGNITUDE_NM, -0.1))),
        ("flags", abi::STATUS_BAD_INPUT, Box::new(|i| put_u32(i, 64 + 96 + rotor_input::FLAGS, 1))),
        ("rotor reserved", abi::STATUS_BAD_INPUT, Box::new(|i| i[64 + rotor_input::RESERVED + 11] = 1)),
        ("truncated", abi::STATUS_BAD_INPUT, Box::new(|i| { i.pop(); })),
    ];
    for (name, status, mutate) in mutations {
        let mut bad = golden_input.clone();
        mutate(&mut bad);
        let mut out = vec![0x5a; 256];
        assert_eq!(abi::step(&mut arena_buf, &bad, &mut out, DT), status, "{name}");
        assert!(out.iter().all(|b| *b == 0x5a), "{name}: output untouched");
    }
    let mut out = vec![0x5a; 256];
    for dt in [1.0 / 800.0, DT * (1.0 + f64::EPSILON), f64::NAN] {
        assert_eq!(abi::step(&mut arena_buf, &golden_input, &mut out, dt), abi::STATUS_BAD_DT);
    }
    let mut short = vec![0; 128];
    assert_eq!(abi::step(&mut arena_buf, &golden_input, &mut short, DT), abi::STATUS_BAD_POINTER);
    assert!(out.iter().all(|b| *b == 0x5a));
    assert_eq!(abi::step_count(&arena_buf), Some(0));
}

#[test]
fn disposed_or_corrupt_handles_are_rejected() {
    let (mut arena_buf, input_buf, mut out) = engine();
    abi::dispose(&mut arena_buf);
    assert_eq!(abi::step(&mut arena_buf, &input_buf, &mut out, DT), abi::STATUS_BAD_HANDLE);
    assert_eq!(abi::reset(&mut arena_buf, 0), abi::STATUS_BAD_HANDLE);
    let (mut arena_buf, ..) = engine();
    put_u32(&mut arena_buf, arena::ARENA_BYTES, 64); // header length disagrees with the region
    assert_eq!(abi::step(&mut arena_buf, &input_buf, &mut out, DT), abi::STATUS_BAD_HANDLE);
}

#[test]
fn pointer_regions_are_checked_for_range_alignment_and_overlap() {
    let memory = 65_536u64;
    assert!(abi::region_valid(8, 64, memory));
    assert!(abi::region_valid(65_536 - 64, 64, memory));
    assert!(!abi::region_valid(0, 64, memory), "null");
    assert!(!abi::region_valid(4, 64, memory), "misaligned");
    assert!(!abi::region_valid(65_536 - 56, 64, memory), "past the end");
    assert!(!abi::region_valid(u32::MAX - 7, 64, 1 << 32), "end computed without u32 wrap-around");
    assert!(abi::region_valid(u32::MAX - 7, 8, 1 << 32));
    assert!(!abi::region_valid(8, 0, memory), "empty");
    assert!(abi::regions_overlap(0, 16, 8, 16));
    assert!(abi::regions_overlap(8, 16, 0, 16));
    assert!(abi::regions_overlap(0, 64, 8, 8));
    assert!(!abi::regions_overlap(0, 8, 8, 8), "adjacent regions are disjoint");
    assert!(!abi::regions_overlap(u32::MAX - 7, 8, 0, 8));
}
