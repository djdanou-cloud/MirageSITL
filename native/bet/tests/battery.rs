use mirage_bet::battery::Battery;
mod support;
#[test]
fn ohmic_bus_and_motor_load_accounting() {
    let fixture = include_str!("../../../tests/fixtures/power/battery.json");
    let voc = support::number(fixture, "vocV");
    let b = Battery::new(
        voc,
        voc,
        support::number(fixture, "resistanceOhm"),
        support::number(fixture, "capacityC"),
        support::number(fixture, "currentLimitA"),
    )
    .unwrap();
    let o = b.step(1.0, &[50.0, 60.0], 0.0, 0.0025).unwrap();
    let exact = (12.0 - (144.0_f64 - 44.0).sqrt()) / 0.2;
    assert!((o.current_a - exact).abs() < 1e-12);
    assert!((o.delivered_power_w - 110.0).abs() < 1e-10);
    assert!((o.source_power_w - o.delivered_power_w - o.internal_loss_w).abs() < 1e-10);
    assert!(!o.power_limited);
    assert!((o.soc - (1.0 - exact * 0.0025 / 3600.0)).abs() < 1e-15);
}
#[test]
fn zero_resistance_depletion_and_infeasible_demand_stay_finite() {
    for r in [0.0, 1e-20, 0.1] {
        let b = Battery::new(12.0, 10.0, r, 1.0, 10.0).unwrap();
        let o = b.step(1.0, &[1e9], 0.0, 0.0025).unwrap();
        assert!(o.power_limited && o.current_a <= 10.0);
        assert!(o.voltage_v.is_finite());
        let low = b.step(1e-8, &[100.0], 0.0, 0.0025).unwrap();
        assert!(low.soc < 1e-15);
        assert!(low.current_a * 0.0025 <= 1.000001e-8);
        let empty = b.step(0.0, &[100.0], 0.0, 0.0025).unwrap();
        assert_eq!(empty.delivered_power_w, 0.0);
        assert!(empty.power_limited);
    }
    let b = Battery::new(12.0, 12.0, 0.0, 3600.0, 100.0).unwrap();
    assert!((b.step(1.0, &[120.0], 0.0, 0.0025).unwrap().current_a - 10.0).abs() < 1e-12);
    assert!(b.step(1.0, &[f64::NAN], 0.0, 0.0025).is_err());
}

// ---- TASK-104: the dynamic pack (SPECS_SIMULATION_ENGINES "Battery v2", checks 1 to 7) ----
use mirage_bet::battery::{PackAir, PackModel, PackState, TABLE_POINTS};
use mirage_bet::bus_solve::{self, MotorLoad};
use mirage_bet::motor::DriveMotor;

const FULL: f64 = 12.6;
const EMPTY: f64 = 9.9;
const AIR: PackAir = PackAir { temperature_k: 293.15, speed_mps: 0.0 };

fn linear_table() -> [f64; TABLE_POINTS] {
    let mut t = [0.0; TABLE_POINTS];
    for (i, v) in t.iter_mut().enumerate() { *v = EMPTY + (FULL - EMPTY) * i as f64 / (TABLE_POINTS - 1) as f64; }
    t[0] = EMPTY;
    t[TABLE_POINTS - 1] = FULL;
    t
}
fn neutral() -> PackModel {
    PackModel { table_v: linear_table(), branch_ohm: [0.0; 2], branch_f: [0.0; 2], activation_k: 0.0, reference_k: 298.15,
        heat_capacity_j_per_k: 0.0, still_air_w_per_k: 0.0, airflow_w_per_k: 0.0, entropic_v_per_k: 0.0, capacity_retention: 1.0, resistance_growth: 1.0, series_table: [1.0; TABLE_POINTS] }
}
fn two_branches() -> PackModel { PackModel { branch_ohm: [0.02, 0.03], branch_f: [500.0, 2000.0], ..neutral() } }
fn pack(model: PackModel) -> Battery { Battery::new(FULL, EMPTY, 0.05, 3600.0, 100.0).unwrap().with_model(model).unwrap() }
fn start() -> PackState { PackState { soc: 1.0, branch_v: [0.0; 2], temperature_k: 298.15 } }

/// Check 1: a 10 A pulse for 20 s and 60 s of rest against the closed form, at four rates.
#[test]
fn pulse_response_matches_the_closed_form_at_every_rate() {
    let b = pack(two_branches());
    let (r0, r, tau, q, i) = (0.05, [0.02, 0.03], [10.0, 60.0], 3600.0, 10.0);
    let (pulse_s, rest_s) = (20.0, 60.0);
    let mut shared: Vec<Vec<f64>> = Vec::new();
    for hz in [400u32, 800, 1200, 4800] {
        let dt = 1.0 / hz as f64;
        let mut s = start();
        let mut at_shared = Vec::new();
        let steps = ((pulse_s + rest_s) * hz as f64).round() as u32;
        let pulse_steps = (pulse_s * hz as f64).round() as u32;
        for n in 0..steps {
            let current = if n < pulse_steps { i } else { 0.0 };
            let p = b.advance(&s, &AIR, current, dt).unwrap();
            s = p.state;
            let t = (n + 1) as f64 * dt;
            let soc = 1.0 - i * t.min(pulse_s) / q;
            // The open-circuit voltage is held at the charge the step starts from, as TASK-092 holds it.
            let held = 1.0 - i * (n as f64 * dt).min(pulse_s) / q;
            let open = EMPTY + (FULL - EMPTY) * held;
            let branch: f64 = (0..2).map(|k| {
                let charged = i * r[k] * (1.0 - (-t.min(pulse_s) / tau[k]).exp());
                if t <= pulse_s { charged } else { charged * (-(t - pulse_s) / tau[k]).exp() }
            }).sum();
            let exact = open - current * r0 - branch;
            assert!((p.output.voltage_v - exact).abs() < 1e-9, "{hz} Hz step {n}: {} vs {exact}", p.output.voltage_v);
            // Not a declared check: the charge sums dt-sized decrements, whose rounding grows to a few 1e-12 over 32,000 steps.
            assert!((s.soc - soc).abs() < 1e-10);
            if (n + 1) % (hz / 400) == 0 { at_shared.push(s.branch_v[0] + s.branch_v[1]); }
        }
        shared.push(at_shared);
    }
    for other in &shared[1..] {
        assert_eq!(other.len(), shared[0].len());
        for (a, b) in shared[0].iter().zip(other) { assert!((a - b).abs() < 1e-9); }
    }
}

/// Check 2: a power demand gives V*I = P, and the state of the constant-current step at that current.
#[test]
fn a_power_demand_is_the_constant_current_step_at_its_root() {
    let b = pack(PackModel { heat_capacity_j_per_k: 50.0, still_air_w_per_k: 0.2, airflow_w_per_k: 0.1, entropic_v_per_k: -3e-4, activation_k: 3000.0, ..two_branches() });
    let air = PackAir { temperature_k: 288.15, speed_mps: 9.0 };
    let mut s = PackState { soc: 0.8, branch_v: [0.05, 0.1], temperature_k: 300.0 };
    for (k, p) in [150.0, 400.0, 20.0, 0.0, 600.0].into_iter().enumerate() {
        let step = b.step_at(&s, &air, &[p], 0.0, 1.0 / 800.0).unwrap();
        assert!(!step.output.power_limited);
        if p > 0.0 { assert!(((step.output.voltage_v * step.output.current_a - p) / p).abs() < 1e-9, "demand {k}"); }
        let same = b.advance(&s, &air, step.output.current_a, 1.0 / 800.0).unwrap();
        for (a, c) in [(same.state.soc, step.state.soc), (same.state.branch_v[0], step.state.branch_v[0]), (same.state.branch_v[1], step.state.branch_v[1]),
            (same.state.temperature_k, step.state.temperature_k), (same.output.voltage_v, step.output.voltage_v)] {
            assert!((a - c).abs() <= 1e-12 * c.abs().max(1.0));
        }
        s = step.state;
    }
}

/// Check 3: U*I = V*I + I^2*R0 + I*sum(Vk') on 10,000 random steps.
#[test]
fn energy_closes_on_random_steps() {
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let mut next = || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; (seed >> 11) as f64 / (1u64 << 53) as f64 };
    let model = PackModel { activation_k: 2500.0, entropic_v_per_k: 2e-4, heat_capacity_j_per_k: 80.0, still_air_w_per_k: 0.3, airflow_w_per_k: 0.2, ..two_branches() };
    let b = pack(model);
    let mut s = PackState { soc: 0.9, branch_v: [0.0; 2], temperature_k: 295.0 };
    for n in 0..10_000 {
        let demand = -200.0 + 900.0 * next();
        let air = PackAir { temperature_k: 280.0 + 30.0 * next(), speed_mps: 20.0 * next() };
        let p = b.step_at(&s, &air, &[demand], 5.0 * next(), 1.0 / 1200.0).unwrap();
        let o = p.output;
        let series = model.series_ohm(0.05, s.temperature_k, s.soc);
        let rhs = o.voltage_v * o.current_a + o.current_a * o.current_a * series + o.current_a * (p.state.branch_v[0] + p.state.branch_v[1]);
        let lhs = p.open_circuit_v * o.current_a;
        assert!((lhs - rhs).abs() <= 1e-9 * lhs.abs().max(1e-9), "step {n}: {lhs} vs {rhs}");
        assert!((o.source_power_w - o.delivered_power_w - o.internal_loss_w).abs() <= 1e-9 * o.source_power_w.abs().max(1.0));
        s = p.state;
        if s.soc < 0.2 { s.soc = 0.9; }
    }
}

/// Check 4: the heat balance against its closed form, one long step against many, the steady state, and C = 0.
#[test]
fn heat_follows_its_closed_form() {
    let model = PackModel { heat_capacity_j_per_k: 120.0, still_air_w_per_k: 0.25, airflow_w_per_k: 0.15, ..neutral() };
    let b = Battery::new(FULL, EMPTY, 0.05, 3.6e9, 100.0).unwrap().with_model(model).unwrap();
    let air = PackAir { temperature_k: 290.0, speed_mps: 4.0 };
    let (i, t0) = (6.0, 300.0);
    let q = i * i * 0.05;
    let g = 0.25 + 0.15 * 2.0;
    let settled = 290.0 + q / g;
    let mut s = PackState { soc: 1.0, branch_v: [0.0; 2], temperature_k: t0 };
    for n in 1..=600 {
        s = b.advance(&s, &air, i, 1.0).unwrap().state;
        let exact = settled + (t0 - settled) * (-(n as f64) * g / 120.0).exp();
        assert!((s.temperature_k - exact).abs() < 1e-9, "second {n}");
    }
    let once = b.advance(&PackState { temperature_k: t0, ..s }, &air, i, 600.0).unwrap().state;
    let once_soc = PackState { soc: 1.0, ..once };
    let long = b.advance(&PackState { soc: 1.0, branch_v: [0.0; 2], temperature_k: t0 }, &air, i, 600.0).unwrap().state;
    assert!((long.temperature_k - s.temperature_k).abs() < 1e-9);
    let _ = once_soc;
    let far = b.advance(&PackState { soc: 1.0, branch_v: [0.0; 2], temperature_k: t0 }, &air, i, 1e7).unwrap().state;
    assert!((far.temperature_k - settled).abs() < 1e-9);
    let held = pack(neutral()).advance(&PackState { temperature_k: 305.0, ..start() }, &air, 30.0, 1e-3).unwrap().state;
    assert_eq!(held.temperature_k, 305.0);
}

/// Check 5: Arrhenius and the entropic shift against their closed forms; the state of health against a scaled pack.
#[test]
fn temperature_laws_and_state_of_health() {
    let model = PackModel { activation_k: 3500.0, entropic_v_per_k: -4e-4, ..neutral() };
    for t in [253.15, 273.15, 298.15, 318.15] {
        let r = model.series_ohm(0.05, t, 0.5);
        let exact = 0.05 * (3500.0 * (1.0 / t - 1.0 / 298.15)).exp();
        assert!(((r - exact) / exact).abs() < 1e-12);
        let u = model.open_circuit_v(0.5, t);
        let exact_u = (EMPTY + FULL) / 2.0 + (t - 298.15) * -4e-4;
        assert!(((u - exact_u) / exact_u).abs() < 1e-12);
    }
    let aged = Battery::new(FULL, EMPTY, 0.05, 3600.0, 100.0).unwrap()
        .with_model(PackModel { capacity_retention: 0.8, resistance_growth: 1.5, ..two_branches() }).unwrap();
    let scaled = Battery::new(FULL, EMPTY, 0.05 * 1.5, 3600.0 * 0.8, 100.0).unwrap()
        .with_model(PackModel { branch_ohm: [0.02 * 1.5, 0.03 * 1.5], ..two_branches() }).unwrap();
    let (mut a, mut c) = (start(), start());
    for n in 0..2000 {
        let demand = if n % 400 < 200 { 300.0 } else { 40.0 };
        let pa = aged.step_at(&a, &AIR, &[demand], 0.0, 1.0 / 800.0).unwrap();
        let pc = scaled.step_at(&c, &AIR, &[demand], 0.0, 1.0 / 800.0).unwrap();
        assert_eq!(pa.output.voltage_v.to_bits(), pc.output.voltage_v.to_bits(), "step {n}");
        assert_eq!(pa.state, pc.state);
        a = pa.state; c = pc.state;
    }
}

/// Check 6: a neutral dynamic pack gives the TASK-092 values within 1e-12 V.
#[test]
fn a_neutral_dynamic_pack_is_the_linear_pack() {
    let linear = Battery::new(FULL, EMPTY, 0.05, 3600.0, 100.0).unwrap();
    let dynamic = pack(neutral());
    let (mut soc, mut s) = (1.0, start());
    for n in 0..4000 {
        let demand = [-80.0, 0.0, 250.0, 900.0, 40.0][n % 5];
        let o = linear.step(soc, &[demand], 3.0, 1.0 / 800.0).unwrap();
        let p = dynamic.step_at(&s, &AIR, &[demand], 3.0, 1.0 / 800.0).unwrap();
        assert!((o.voltage_v - p.output.voltage_v).abs() < 1e-12, "step {n}");
        assert!((o.current_a - p.output.current_a).abs() < 1e-12);
        assert!((o.soc - p.state.soc).abs() < 1e-12);
        assert_eq!(o.power_limited, p.output.power_limited);
        soc = o.soc; s = p.state;
    }
}

/// Check 7: the bus solve on a dynamic pack is the v1 solve on its step's linear pack, bit for bit.
#[test]
fn the_bus_solve_runs_on_the_steps_linear_pack() {
    let model = PackModel { activation_k: 3000.0, entropic_v_per_k: 1e-4, ..two_branches() };
    let b = pack(model);
    let motor = DriveMotor::new(0.08, 0.0096, 40.0, 10.0, 0.002, 0.01, 0.0).unwrap();
    let loads = [MotorLoad { motor, duty: 0.6, omega: 900.0, power_cut: false }; 4];
    let state = PackState { soc: 0.7, branch_v: [0.12, 0.2], temperature_k: 280.0 };
    let dt = 1.0 / 800.0;
    let limits = b.limits_at(&state, &AIR, 2.0, dt).unwrap();
    let linear = Battery::new(limits.open_circuit_v, limits.open_circuit_v, limits.resistance_ohm, 3600.0, 100.0).unwrap();
    let a = bus_solve::solve_at(&b, &state, &AIR, 2.0, dt, &loads).unwrap();
    let c = bus_solve::solve(&linear, 0.7, 2.0, dt, &loads).unwrap();
    assert_eq!(a, c);
}

// ---- TASK-104, second increment (SPECS_SIMULATION_ENGINES "Second increment"), checks 1 and 2 ----
use mirage_bet::bus_abi;

fn record(version: u32, soc: f64, branch: [f64; 2], temperature: f64, demand: f64, table: Option<[f64; TABLE_POINTS]>) -> Vec<u8> {
    let bytes = if version == 3 { 576 } else { 384 };
    let mut b = vec![0u8; bytes];
    b[0..4].copy_from_slice(&version.to_le_bytes());
    let put = |b: &mut Vec<u8>, p: usize, v: f64| b[p..p + 8].copy_from_slice(&v.to_le_bytes());
    for (p, v) in [(8, FULL), (16, EMPTY), (24, 0.05), (32, 3600.0), (40, 100.0), (48, soc), (56, demand), (64, 2.0), (72, branch[0]), (80, branch[1]),
        (88, temperature), (96, 290.0), (104, 3.0), (112, 0.02), (120, 500.0), (128, 0.03), (136, 2000.0), (144, 3000.0), (152, 298.15), (160, 80.0),
        (168, 0.3), (176, 0.2), (184, 2e-4), (192, 0.95), (200, 1.1)] { put(&mut b, p, v); }
    for (i, v) in linear_table().iter().enumerate() { put(&mut b, 208 + 8 * i, *v); }
    if let Some(t) = table { for (i, v) in t.iter().enumerate() { put(&mut b, 376 + 8 * i, *v); } }
    b
}
fn read(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }

/// Check 1: a version 3 record whose table is all ones is version 2 bit for bit over 4000 steps.
#[test]
fn a_v3_record_of_ones_is_v2_bit_for_bit() {
    let (mut a, mut b) = ([0u8; 128], [0u8; 128]);
    let (mut soc, mut branch, mut temperature) = (1.0, [0.0; 2], 298.15);
    for n in 0..4000 {
        let demand = [-80.0, 0.0, 250.0, 900.0, 40.0][n % 5];
        assert_eq!(bus_abi::step(&record(2, soc, branch, temperature, demand, None), &mut a, 1.0 / 800.0), 0);
        assert_eq!(bus_abi::step(&record(3, soc, branch, temperature, demand, Some([1.0; TABLE_POINTS])), &mut b, 1.0 / 800.0), 0, "step {n}");
        assert_eq!(a, b, "step {n}");
        (soc, branch, temperature) = (read(&a, 0), [read(&a, 56), read(&a, 64)], read(&a, 72));
    }
    // A table value of zero, a 576-byte record naming version 2, and version 4 are refused.
    let mut bad = [1.0; TABLE_POINTS];
    bad[3] = 0.0;
    assert_eq!(bus_abi::step(&record(3, 0.5, [0.0; 2], 298.15, 100.0, Some(bad)), &mut a, 1.0 / 800.0), -3);
    let mut named = record(3, 0.5, [0.0; 2], 298.15, 100.0, Some([1.0; TABLE_POINTS]));
    named[0] = 2;
    assert_eq!(bus_abi::step(&named, &mut a, 1.0 / 800.0), -2);
    // An unknown version is held to version 1's 128 bytes, as before, so a 576-byte version 4 is refused by its length.
    named[0] = 4;
    assert_eq!(bus_abi::step(&named, &mut a, 1.0 / 800.0), -2);
    assert_eq!(bus_abi::step(&named[..128], &mut a, 1.0 / 800.0), -7);
}

/// Check 2: R0(T, s) against its closed form within 1e-12 relative at 30 points of T and s.
#[test]
fn series_resistance_by_temperature_and_charge() {
    let mut table = [0.0; TABLE_POINTS];
    for (i, v) in table.iter_mut().enumerate() { *v = 1.0 + 2.0 * (-24.0 * i as f64 / 20.0).exp(); }
    let model = PackModel { activation_k: 3200.0, resistance_growth: 1.3, series_table: table, ..neutral() };
    for (k, t) in [253.15_f64, 283.15, 298.15, 313.15, 333.15].into_iter().enumerate() {
        for s in [0.0_f64, 0.013, 0.05, 0.37, 0.8, 1.0] {
            let x: f64 = s * 20.0;
            let i = (x as usize).min(19);
            let m = table[i] + (table[i + 1] - table[i]) * (x - i as f64);
            let exact = 0.05 * 1.3 * (3200.0 * (1.0 / t - 1.0 / 298.15)).exp() * m;
            let r = model.series_ohm(0.05, t, s);
            assert!(((r - exact) / exact).abs() < 1e-12, "T {k} s {s}: {r} vs {exact}");
        }
    }
}
