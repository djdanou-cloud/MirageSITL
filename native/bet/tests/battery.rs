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
