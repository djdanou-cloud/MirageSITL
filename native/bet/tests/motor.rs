//! Independent command exponential and electrical power balances.
use mirage_bet::{motor::Motor, shaft::Shaft};
#[test]
fn duty_lag_current_limit_and_power_balance() {
    let m = Motor::new(0.2, 0.02, 10.0, 0.1).unwrap();
    for hz in [400, 800, 1200] {
        let mut duty = 0.0;
        for _ in 0..hz {
            let o = m
                .step(duty, 1.0, 12.0, 100.0, false, 1.0 / hz as f64)
                .unwrap();
            duty = o.duty;
            assert!(o.current_a <= 10.0);
            assert!(o.input_power_w + 1e-12 >= o.torque_nm * 100.0 + o.copper_loss_w);
        }
        assert!((duty - (1.0 - (-10.0_f64).exp())).abs() < 1e-12);
    }
}
#[test]
fn zero_voltage_and_power_cut_do_not_create_mechanical_energy() {
    let m = Motor::new(0.2, 0.02, 10.0, 0.1).unwrap();
    for voltage in [0.0, 12.0] {
        let o = m.step(1.0, 1.0, voltage, 100.0, true, 0.0025).unwrap();
        assert_eq!(o.torque_nm, 0.0);
        assert_eq!(o.input_power_w, 0.0);
    }
    assert_eq!(
        m.step(1.0, 1.0, 0.0, 100.0, false, 0.0025)
            .unwrap()
            .torque_nm,
        0.0
    );
    let s = Shaft::new(0.2, 0.02, 1).unwrap();
    assert!(s.step(100.0, -0.1, 0.0, 0.0025).unwrap().omega_rad_s < 100.0);
    assert!(Motor::new(0.0, 1.0, 1.0, 1.0).is_err());
    assert!(m.step(0.0, f64::NAN, 12.0, 0.0, false, 0.0025).is_err());
}

// TASK-105: the inductive motor and the thermal network against closed forms and an independent integration.
mod v2 {
    use mirage_bet::motor::{torque_constant_at, winding_resistance_ohm, InductiveMotor, MotorThermal, NDFEB_COEFFICIENT_PER_K};
    const R: f64 = 0.12;
    const K: f64 = 0.0095;
    const L: f64 = 30e-6;

    #[test]
    fn current_rises_as_the_rl_step_and_the_mean_is_its_integral() {
        let m = InductiveMotor::new(R, K, L, 60.0, 30.0, 0.0, NDFEB_COEFFICIENT_PER_K).unwrap();
        let (v, dt, tau) = (5.0, 1.0 / 400.0 / 20.0, L / R);
        let mut i = 0.0;
        for n in 1..=200 {
            let s = m.step(i, v, 0.0, 20.0, 20.0, dt).unwrap();
            let t = n as f64 * dt;
            let exact = v / R * (1.0 - (-t / tau).exp());
            assert!((s.current_a - exact).abs() <= 1e-12 * exact.max(1.0), "step {n}");
            // Simpson over the step of the analytic curve.
            let f = |x: f64| v / R * (1.0 - (-x / tau).exp());
            let (t0, k) = (t - dt, 2000);
            let h = dt / k as f64;
            let mut sum = f(t0) + f(t);
            for j in 1..k { sum += f(t0 + j as f64 * h) * if j % 2 == 1 { 4.0 } else { 2.0 }; }
            let simpson = sum * h / 3.0 / dt;
            assert!((s.mean_current_a - simpson).abs() <= 1e-9 * simpson.max(1.0), "mean at step {n}");
            i = s.current_a;
        }
    }

    #[test]
    fn power_balances_exactly_and_the_steady_state_is_the_quasi_static_motor() {
        let m = InductiveMotor::new(R, K, L, 60.0, 30.0, 0.8, NDFEB_COEFFICIENT_PER_K).unwrap();
        let (v, omega, dt) = (11.0, 900.0, 1.0 / 800.0);
        // v·⟨i⟩ = R·⟨i²⟩ + k·Ω·⟨i⟩ + L·(i₁² − i₀²)/(2·dt), the ODE times i integrated over the step.
        let s = m.step(3.0, v, omega, 20.0, 20.0, dt).unwrap();
        let balance = s.copper_loss_w + K * omega * s.mean_current_a + L * (s.current_a.powi(2) - 9.0) / (2.0 * dt);
        assert!((s.input_power_w - balance).abs() <= 1e-9 * s.input_power_w.abs());
        let mut i = 0.0;
        for _ in 0..200 { i = m.step(i, v, omega, 20.0, 20.0, dt).unwrap().current_a; }
        let steady = m.step(i, v, omega, 20.0, 20.0, dt).unwrap();
        let expected = (v - K * omega) / R;
        assert!((steady.current_a - expected).abs() < 1e-12 * expected);
        // Torque k·i less the no-load torque k·I₀; the iron loss k·I₀·Ω.
        assert!((steady.torque_nm - K * (expected - 0.8)).abs() < 1e-12);
        assert!((steady.iron_loss_w - K * 0.8 * omega).abs() < 1e-12);
    }

    #[test]
    fn a_hot_winding_resists_more_and_hot_magnets_weaken_the_torque_constant() {
        assert!((winding_resistance_ohm(R, 100.0) - R * (1.0 + 0.00393 * 80.0)).abs() < 1e-15);
        assert!((torque_constant_at(K, NDFEB_COEFFICIENT_PER_K, 120.0) - 0.88 * K).abs() < 1e-15);
        let m = InductiveMotor::new(R, K, L, 60.0, 30.0, 0.0, NDFEB_COEFFICIENT_PER_K).unwrap();
        let mut i = 0.0;
        for _ in 0..200 { i = m.step(i, 8.0, 500.0, 100.0, 120.0, 1.0 / 800.0).unwrap().current_a; }
        let expected = (8.0 - 0.88 * K * 500.0) / (R * (1.0 + 0.00393 * 80.0));
        assert!((i - expected).abs() < 1e-12 * expected);
    }

    #[test]
    fn the_esc_limits_the_current_and_brakes_below_the_back_emf() {
        let m = InductiveMotor::new(R, K, L, 20.0, 5.0, 0.0, NDFEB_COEFFICIENT_PER_K).unwrap();
        let mut i = 0.0;
        for _ in 0..200 { i = m.step(i, 12.0, 0.0, 20.0, 20.0, 1.0 / 800.0).unwrap().current_a; }
        let s = m.step(i, 12.0, 0.0, 20.0, 20.0, 1.0 / 800.0).unwrap();
        assert!((s.current_a - 20.0).abs() < 1e-9 && s.current_limited);
        for _ in 0..200 { i = m.step(i, 0.0, 1000.0, 20.0, 20.0, 1.0 / 800.0).unwrap().current_a; }
        assert!((i + 5.0).abs() < 1e-9);
        assert!(m.step(0.0, -1.0, 0.0, 20.0, 20.0, 0.001).is_err());
        assert!(InductiveMotor::new(R, K, 0.0, 20.0, 5.0, 0.0, 0.0).is_err());
    }

    fn rk4(t: &MotorThermal, mut x: [f64; 2], pw: f64, ph: f64, air: f64, v: f64, total: f64, n: usize) -> [f64; 2] {
        // The same network written as its ODE, integrated independently.
        let (cw, ch, rwh, rha, c) = (40.0, 120.0, 0.8, 1.5, 0.05);
        let _ = t;
        let f = |y: [f64; 2]| {
            let q = (y[0] - y[1]) / rwh;
            let out = (y[1] - air) * (1.0 + c * v) / rha;
            [(pw - q) / cw, (ph + q - out) / ch]
        };
        let h = total / n as f64;
        for _ in 0..n {
            let k1 = f(x);
            let k2 = f([x[0] + h / 2.0 * k1[0], x[1] + h / 2.0 * k1[1]]);
            let k3 = f([x[0] + h / 2.0 * k2[0], x[1] + h / 2.0 * k2[1]]);
            let k4 = f([x[0] + h * k3[0], x[1] + h * k3[1]]);
            x = [x[0] + h / 6.0 * (k1[0] + 2.0 * k2[0] + 2.0 * k3[0] + k4[0]), x[1] + h / 6.0 * (k1[1] + 2.0 * k2[1] + 2.0 * k3[1] + k4[1])];
        }
        x
    }

    #[test]
    fn the_thermal_network_matches_an_independent_integration_and_settles_where_the_losses_balance() {
        let t = MotorThermal::new(40.0, 120.0, 0.8, 1.5, 0.05).unwrap();
        let (pw, ph, air, v) = (30.0, 8.0, 25.0, 12.0);
        let mut x = [25.0, 25.0];
        for _ in 0..600 { x = t.step(x, pw, ph, air, v, 1.0).unwrap(); }
        let reference = rk4(&t, [25.0, 25.0], pw, ph, air, v, 600.0, 600_000);
        assert!((x[0] - reference[0]).abs() < 1e-6 && (x[1] - reference[1]).abs() < 1e-6, "{x:?} against {reference:?}");
        // One step of 600 s equals 600 steps of 1 s: the integration is exact, not a scheme.
        let once = t.step([25.0, 25.0], pw, ph, air, v, 600.0).unwrap();
        assert!((once[0] - x[0]).abs() < 1e-9 && (once[1] - x[1]).abs() < 1e-9);
        let late = t.step([25.0, 25.0], pw, ph, air, v, 1e6).unwrap();
        let housing = air + (pw + ph) * 1.5 / (1.0 + 0.05 * v);
        assert!((late[1] - housing).abs() < 1e-9 && (late[0] - (housing + pw * 0.8)).abs() < 1e-9);
        // More airflow, cooler.
        assert!(t.step([25.0, 25.0], pw, ph, air, 0.0, 1e6).unwrap()[0] > late[0]);
    }
}
