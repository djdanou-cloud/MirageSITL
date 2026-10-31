//! TASK-092 production drive: ESC hold and lag, the voltage-driven motor law,
//! the driven shaft, regeneration into the battery and the shared-bus record.
//! Oracles are closed forms: the sampled-and-held exponential, the affine
//! torque law, the exact viscous solution, and the quadratic bus root.
use mirage_bet::{battery::Battery, bus_abi, motor::{DriveMotor, EscState}, shaft::Shaft};

const R: f64 = 0.12;
const KT: f64 = 0.0159;
fn motor(update_period_s: f64) -> DriveMotor { DriveMotor::new(R, KT, 30.0, 12.0, 0.004, 0.02, update_period_s).unwrap() }
fn close(a: f64, b: f64, tolerance: f64) -> bool { (a - b).abs() <= tolerance * b.abs().max(1.0) }

#[test]
fn esc_samples_its_target_at_the_update_rate_and_lags_it() {
    // 400 Hz update at 800 Hz physics: the target is sampled on every other step.
    let m = motor(1.0 / 400.0);
    let dt = 1.0 / 800.0;
    let decay = (-dt / 0.02f64).exp();
    let mut state = EscState::default();
    let mut expected = 0.0;
    let targets = [0.8, 0.2, 0.2, 0.6, 0.6, 0.1, 0.9, 0.9];
    let mut held = 0.0;
    for (n, target) in targets.iter().enumerate() {
        state = m.command(state, *target, false, dt).unwrap();
        if n % 2 == 0 { held = *target; }
        expected = held + (expected - held) * decay;
        assert_eq!(state.held, held, "step {n}");
        assert!(close(state.duty, expected, 1e-15), "step {n}");
    }
    // A period shorter than the step samples every step; a power cut zeroes the ESC.
    let every = motor(0.0).command(EscState { duty: 0.5, held: 0.5, countdown_s: 0.0 }, 0.7, false, dt).unwrap();
    assert_eq!(every.held, 0.7);
    assert_eq!(m.command(state, 0.9, true, dt).unwrap(), EscState::default());
    assert!(m.command(state, 1.1, false, dt).is_err());
    assert!(DriveMotor::new(R, KT, 30.0, -1.0, 0.0, 0.02, 0.0).is_err());
}

#[test]
fn the_torque_law_is_affine_inside_the_current_limits_and_constant_at_them() {
    let m = motor(0.0);
    // i = (d·V − k_e·Ω)/R = (0.5·16 − 0.0159·300)/0.12 = 26.92 A, inside 30 A.
    let t = m.torque(0.5, 16.0, 300.0, false).unwrap();
    assert!(close(t.constant_nm, KT * 0.5 * 16.0 / R, 1e-15) && close(t.damping, KT * KT / R, 1e-15) && !t.current_limited);
    assert!(close(t.constant_nm - t.damping * 300.0, KT * (0.5 * 16.0 - KT * 300.0) / R, 1e-14));
    // Full duty at standstill wants 133 A: the limit holds the torque at k_t·30.
    let full = m.torque(1.0, 16.0, 0.0, false).unwrap();
    assert!(full.current_limited && full.damping == 0.0 && close(full.constant_nm, KT * 30.0, 1e-15));
    // Zero duty at speed brakes, down to −12 A.
    let brake = m.torque(0.0, 16.0, 1500.0, false).unwrap();
    assert!(brake.current_limited && close(brake.constant_nm, -KT * 12.0, 1e-15));
    // A cut or a dead bus neither drives nor brakes; friction stays.
    for (voltage, cut) in [(16.0, true), (0.0, false)] {
        let free = m.torque(1.0, voltage, 900.0, cut).unwrap();
        assert_eq!((free.constant_nm, free.damping, free.friction_nm), (0.0, 0.0, 0.004));
        assert_eq!(m.electrical(1.0, voltage, 900.0, cut).unwrap().terminal_power_w, 0.0);
    }
}

#[test]
fn terminal_power_is_copper_loss_plus_electromagnetic_power_and_regenerates_below_back_emf() {
    let m = motor(0.0);
    for (duty, voltage, omega) in [(0.5, 16.0, 300.0), (0.9, 25.2, 1000.0), (0.1, 16.0, 800.0), (1.0, 16.0, 0.0), (0.0, 22.0, 2000.0)] {
        let e = m.electrical(duty, voltage, omega, false).unwrap();
        let mechanical = e.torque_nm * omega;
        assert!(close(e.terminal_power_w, e.copper_loss_w + mechanical, 1e-13), "{duty} {voltage} {omega}");
        assert!(e.current_a <= 30.0 && e.current_a >= -12.0);
        // Below the back-EMF the current and the terminal power are negative.
        assert_eq!(e.current_a < 0.0, duty * voltage < KT * omega);
        if e.current_a < 0.0 { assert!(e.terminal_power_w < 0.0); }
    }
}

#[test]
fn the_driven_shaft_matches_the_exact_viscous_solution_and_stops_without_reversing() {
    let (inertia, bearing) = (2.0e-5, 1.0e-6);
    let s = Shaft::new(inertia, bearing, 1).unwrap();
    // Zero friction and zero drive damping reproduce the v1 shaft bit for bit.
    for (omega, q, drive) in [(300.0, -0.02, 0.05), (0.0, 0.0, 0.01), (50.0, -0.1, 0.0)] {
        let a = s.step(omega, q, drive, 1.0 / 400.0).unwrap();
        let b = s.step_driven(omega, q, drive, 0.0, 0.0, 1.0 / 400.0).unwrap();
        assert_eq!((a.omega_rad_s.to_bits(), a.reverse_limited), (b.omega_rad_s.to_bits(), b.reverse_limited));
    }
    // Ω(t) = Ω∞ + (Ω0 − Ω∞)·exp(−c·t/J), c = b + B, Ω∞ = (A − τf)/c, composed over 800 steps.
    let (a, damping, friction) = (0.06, 1.5e-4, 0.004);
    let c = bearing + damping;
    let steady = (a - friction) / c;
    let mut omega = 10.0;
    for _ in 0..800 { omega = s.step_driven(omega, 0.0, a, damping, friction, 1.0 / 800.0).unwrap().omega_rad_s; }
    let exact = steady + (10.0 - steady) * (-c * 1.0 / inertia).exp();
    assert!(close(omega, exact, 1e-12), "{omega} {exact}");
    // Static friction holds a stopped shaft; braking to a stop is not a reversal.
    let held = s.step_driven(0.0, 0.0, 0.003, 0.0, friction, 1.0 / 800.0).unwrap();
    assert_eq!((held.omega_rad_s, held.reverse_limited), (0.0, false));
    let stopped = s.step_driven(0.5, -0.001, -0.2, 0.0, friction, 1.0 / 800.0).unwrap();
    assert_eq!((stopped.omega_rad_s, stopped.reverse_limited), (0.0, false));
    // An air torque that would spin it backwards past friction is.
    let pushed = s.step_driven(0.5, -0.05, 0.0, 0.0, friction, 1.0 / 800.0).unwrap();
    assert_eq!((pushed.omega_rad_s, pushed.reverse_limited), (0.0, true));
    assert!(s.step_driven(1.0, 0.0, 0.0, -1.0, 0.0, 1.0 / 800.0).is_err());
}

#[test]
fn regeneration_charges_the_pack_with_the_negative_quadratic_root() {
    let b = Battery::new(16.8, 13.2, 0.05, 18000.0, 60.0).unwrap();
    let voc = 13.2 + 3.6 * 0.5;
    // V·I = P with V = Voc − I·R: I = 2P/(Voc + √(Voc² − 4RP)), negative for P < 0.
    let o = b.step(0.5, &[40.0, -100.0], 0.0, 0.0025).unwrap();
    let exact = 2.0 * -60.0 / (voc + (voc * voc + 4.0 * 0.05 * 60.0f64).sqrt());
    assert!(close(o.current_a, exact, 1e-14) && o.current_a < 0.0);
    assert!(o.voltage_v > voc && close(o.delivered_power_w, -60.0, 1e-13));
    assert!(close(o.source_power_w, o.delivered_power_w + o.internal_loss_w, 1e-13));
    assert!(o.soc > 0.5 && !o.power_limited && !o.charge_limited);
    // The current limit applies in both directions; a full pack does not overcharge.
    let limited = b.step(0.5, &[-1e6], 0.0, 0.0025).unwrap();
    assert!(limited.power_limited && close(limited.current_a, -60.0, 1e-12));
    let full = b.step(1.0, &[-50.0], 0.0, 0.0025).unwrap();
    assert!(full.charge_limited && full.soc == 1.0);
    // Positive demands keep the TASK-026 values bit for bit.
    let discharge = b.step(0.5, &[50.0, 60.0], 0.0, 0.0025).unwrap();
    let independent = 2.0 * 110.0 / (voc + (voc * voc - 4.0 * 0.05 * 110.0f64).sqrt());
    assert!(close(discharge.current_a, independent, 1e-14));
}

fn bus_input(soc: f64, demand: f64) -> Vec<u8> {
    let mut b = vec![0u8; 128];
    b[0..4].copy_from_slice(&bus_abi::VERSION.to_le_bytes());
    for (p, v) in [(8, 16.8), (16, 13.2), (24, 0.05), (32, 18000.0), (40, 60.0), (48, soc), (56, demand), (64, 2.0)] {
        b[p..p + 8].copy_from_slice(&f64::to_le_bytes(v));
    }
    b
}
fn read(b: &[u8], p: usize) -> f64 { f64::from_le_bytes(b[p..p + 8].try_into().unwrap()) }

#[test]
fn the_bus_record_steps_the_battery_and_closes_its_power_budget() {
    let b = Battery::new(16.8, 13.2, 0.05, 18000.0, 60.0).unwrap();
    let mut out = [0u8; 128];
    for demand in [250.0, -30.0, 0.0] {
        assert_eq!(bus_abi::step(&bus_input(0.8, demand), &mut out, 0.0025), 0);
        let direct = b.step(0.8, &[demand], 2.0, 0.0025).unwrap();
        assert_eq!(read(&out, 8).to_bits(), direct.voltage_v.to_bits());
        assert_eq!(read(&out, 16).to_bits(), direct.current_a.to_bits());
        assert_eq!(read(&out, 0).to_bits(), direct.soc.to_bits());
        // Source = internal loss + delivered, and delivered = demand + house load.
        assert!(close(read(&out, 40), read(&out, 32) + read(&out, 24), 1e-13));
        assert!(close(read(&out, 24), demand + 2.0, 1e-12));
    }
    assert_eq!(bus_abi::step(&bus_input(0.8, -1e6), &mut out, 0.0025), 0);
    assert_eq!(u32::from_le_bytes(out[48..52].try_into().unwrap()), bus_abi::FLAG_POWER_LIMITED);
    let previous = out;
    let mut bad = bus_input(0.8, 10.0);
    bad[100] = 1;
    assert_eq!(bus_abi::step(&bad, &mut out, 0.0025), -3);
    assert_eq!(bus_abi::step(&bus_input(1.5, 10.0), &mut out, 0.0025), -3);
    let mut version = bus_input(0.8, 10.0);
    version[0] = 2;
    assert_eq!(bus_abi::step(&version, &mut out, 0.0025), -7);
    assert_eq!(bus_abi::step(&bus_input(0.8, 10.0)[..127], &mut out, 0.0025), -2);
    assert_eq!(out, previous);
}
