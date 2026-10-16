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
