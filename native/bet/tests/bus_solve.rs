//! TASK-197: the shared bus and the motors solved together. Oracles by hand. Inside the current limits a motor draws
//! P = d·V·(d·V - k·w)/R, and below its limit the pack gives V·(Voc - V) = Rb·P, so with n equal motors and a house load of 0
//! V = (Voc + (Rb/R)·n·d·k·w)/(1 + n·d²·Rb/R). At the limit P_motors + house = (Voc - Rb·I)·I. Tolerance 1e-8 V, ten times the
//! solver's: both are exact arithmetic on the same law, so a larger gap is a wrong law.
use mirage_bet::battery::Battery;
use mirage_bet::bus_solve::{solve, MotorLoad};
use mirage_bet::motor::DriveMotor;

const K: f64 = 0.013642; // 700 KV.
const R: f64 = 0.085;
const DT: f64 = 1.0 / 800.0;

fn motor(limit: f64, brake: f64) -> DriveMotor { DriveMotor::new(R, K, limit, brake, 0.0068, 0.01, 0.0025).unwrap() }
fn loads(n: usize, duty: f64, omega: f64, limit: f64) -> Vec<MotorLoad> {
    vec![MotorLoad { motor: motor(limit, limit), duty, omega, power_cut: false }; n]
}
fn pack(resistance: f64, limit: f64) -> Battery { Battery::new(16.8, 13.2, resistance, 5.0 * 3600.0, limit).unwrap() }

#[test]
fn below_the_limit_it_stands_where_the_pack_and_the_motors_agree() {
    for (n, duty, omega) in [(4, 1.0, 990.0), (4, 0.8, 900.0), (6, 0.85, 930.0), (16, 0.6, 620.0), (32, 0.3, 300.0)] {
        let rb = 0.018;
        let s = solve(&pack(rb, 500.0), 1.0, 0.0, DT, &loads(n, duty, omega, 1000.0)).unwrap();
        let count = n as f64;
        let expected = (16.8 + (rb / R) * count * duty * K * omega) / (1.0 + count * duty * duty * rb / R);
        assert!((s.motor_voltage_v - expected).abs() < 1e-8, "{n} {duty}: {} against {expected}", s.motor_voltage_v);
        assert_eq!(s.motor_voltage_v, s.pack_voltage_v);
        assert!(!s.limited);
        assert!(s.iterations <= 6, "{} iterations", s.iterations);
    }
}
#[test]
fn the_solved_voltage_is_what_the_pack_answers_to_that_demand() {
    let battery = pack(0.018, 500.0);
    let group = loads(4, 1.0, 950.0, 1000.0);
    let s = solve(&battery, 0.7, 40.0, DT, &group).unwrap();
    let power: Vec<f64> = group.iter().map(|l| l.motor.load(l.duty, s.motor_voltage_v, l.omega, false).unwrap().0).collect();
    let answer = battery.step(0.7, &power, 40.0, DT).unwrap();
    assert!((answer.voltage_v - s.motor_voltage_v).abs() < 1e-8);
    assert!(!answer.power_limited);
}
#[test]
fn at_the_limit_the_pack_holds_and_the_motors_get_what_it_delivers() {
    let (rb, limit, house) = (0.018, 125.0, 100.0);
    let lowest = 16.8 - rb * limit;
    let most = lowest * limit;
    let (n, duty, omega) = (16.0, 1.0, 500.0);
    let s = solve(&pack(rb, limit), 1.0, house, DT, &loads(16, duty, omega, 1000.0)).unwrap();
    assert!(s.limited);
    assert_eq!(s.pack_voltage_v, lowest);
    // n·d·V·(d·V - k·w)/R + house = most, a quadratic in d·V.
    let b = K * omega;
    let c = (most - house) * R / n;
    let expected = (b + (b * b + 4.0 * c).sqrt()) / 2.0 / duty;
    assert!((s.motor_voltage_v - expected).abs() < 1e-8, "{} against {expected}", s.motor_voltage_v);
    assert!(s.motor_voltage_v < lowest);
}
#[test]
fn a_house_load_above_what_the_pack_delivers_leaves_the_motors_nothing() {
    let s = solve(&pack(0.018, 10.0), 1.0, 1000.0, DT, &loads(4, 1.0, 900.0, 1000.0)).unwrap();
    assert!(s.limited);
    assert_eq!(s.motor_voltage_v, 0.0);
}
#[test]
fn a_motor_at_its_current_limit_does_not_move_with_the_voltage() {
    // From rest the winding sits at its limit whatever the voltage, so the load is flat and the answer is the pack's own.
    let battery = pack(0.018, 500.0);
    let group = loads(4, 1.0, 0.0, 30.0);
    let s = solve(&battery, 1.0, 0.0, DT, &group).unwrap();
    let flat = group[0].motor.load(1.0, s.motor_voltage_v, 0.0, false).unwrap();
    assert_eq!(flat.1, 0.0);
    let answer = battery.step(1.0, &[4.0 * flat.0], 0.0, DT).unwrap();
    assert!((answer.voltage_v - s.motor_voltage_v).abs() < 1e-8);
}
#[test]
fn regeneration_raises_the_voltage_and_what_the_pack_cannot_absorb_does_not_hold_the_motors() {
    let battery = pack(0.018, 125.0);
    // Duty low and speed high: the motors brake and charge the pack.
    let group = vec![MotorLoad { motor: motor(30.0, 5.0), duty: 0.5, omega: 900.0, power_cut: false }; 4];
    let s = solve(&battery, 0.5, 0.0, DT, &group).unwrap();
    let open = 13.2 + 3.6 * 0.5;
    assert!(s.motor_voltage_v > open);
    assert!(!s.limited);
    let weak = pack(0.018, 1.0);
    let held = solve(&weak, 0.5, 0.0, DT, &group).unwrap();
    assert!(held.limited);
    assert_eq!(held.motor_voltage_v, open + 0.018);
}
#[test]
fn a_stiff_pack_a_cut_and_a_dead_pack_need_no_solving() {
    let stiff = solve(&pack(0.0, 500.0), 1.0, 0.0, DT, &loads(4, 1.0, 900.0, 1000.0)).unwrap();
    assert_eq!(stiff.motor_voltage_v, 16.8);
    assert!(!stiff.limited);
    let cut = vec![MotorLoad { motor: motor(30.0, 30.0), duty: 1.0, omega: 900.0, power_cut: true }; 4];
    assert_eq!(solve(&pack(0.018, 125.0), 1.0, 0.0, DT, &cut).unwrap().motor_voltage_v, 16.8);
    let dead = solve(&pack(0.018, 125.0), 0.0, 0.0, DT, &loads(4, 1.0, 900.0, 1000.0)).unwrap();
    assert_eq!(dead.motor_voltage_v, 0.0);
    assert!(!dead.limited);
    assert!(solve(&pack(0.0, 10.0), 1.0, 0.0, DT, &loads(4, 1.0, 100.0, 1000.0)).unwrap().limited);
}
#[test]
fn rejects_what_the_pack_rejects() {
    let group = loads(4, 1.0, 900.0, 1000.0);
    for (soc, house, dt) in [(f64::NAN, 0.0, DT), (1.5, 0.0, DT), (1.0, -1.0, DT), (1.0, f64::INFINITY, DT), (1.0, 0.0, 0.0), (1.0, 0.0, 1.0)] {
        assert!(solve(&pack(0.018, 125.0), soc, house, dt, &group).is_err());
    }
    assert!(solve(&pack(0.018, 125.0), 1.0, 0.0, DT, &loads(33, 1.0, 900.0, 1000.0)).is_err());
}
#[test]
fn any_mix_of_motors_has_a_consistent_answer_in_a_bounded_number_of_steps() {
    // A fixed-seed search of duties, speeds, limits, charges and packs, for the worst of the kinks in the load curve.
    let mut seed = 0x2545_f491_4f6c_dd1d_u64;
    let mut next = move || { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; (seed >> 11) as f64 / (1u64 << 53) as f64 };
    let mut most = 0;
    for _ in 0..20000 {
        let n = 1 + (next() * 16.0) as usize;
        let (limit, brake) = (5.0 + next() * 60.0, next() * 40.0);
        let mut group = Vec::new();
        for _ in 0..n {
            group.push(MotorLoad { motor: motor_with(limit, brake), duty: next(), omega: next() * 1400.0, power_cut: next() < 0.05 });
        }
        let battery = Battery::new(16.8, 13.2, next() * 0.1, 5.0 * 3600.0, 5.0 + next() * 300.0).unwrap();
        let (soc, house) = (next().max(1e-6), next() * 100.0);
        let s = solve(&battery, soc, house, DT, &group).unwrap();
        assert!(s.motor_voltage_v.is_finite() && s.motor_voltage_v >= 0.0 && s.motor_voltage_v <= s.pack_voltage_v + 1e-12);
        most = most.max(s.iterations);
        let power: Vec<f64> = group.iter().map(|l| l.motor.load(l.duty, s.motor_voltage_v, l.omega, l.power_cut).unwrap().0).collect();
        let answer = battery.step(soc, &power, house, DT).unwrap();
        if !s.limited {
            assert!((answer.voltage_v - s.motor_voltage_v).abs() < 1e-6, "{} against {}", answer.voltage_v, s.motor_voltage_v);
        } else if s.motor_voltage_v > 0.0 && s.motor_voltage_v < s.pack_voltage_v {
            let total: f64 = power.iter().sum::<f64>() + house;
            assert!((total - s.pack_voltage_v * battery.limits(soc, house, DT).unwrap().max_discharge_a).abs() < 1e-3, "{total}");
        }
    }
    println!("most iterations {most}");
    assert!(most <= 80);
}
fn motor_with(limit: f64, brake: f64) -> DriveMotor { motor(limit, brake) }
