//! Hover momentum and exact exponential transient are independent analytical oracles.
mod support;
use mirage_bet::inflow::AxialInflow;
#[test]
fn hover_and_climb_momentum_close_and_transient_matches_exponential() {
    let m = AxialInflow::new(1.225, 0.5, 0.1, 50.0).unwrap();
    let target = support::number(
        include_str!("../../../tests/fixtures/rotors/axial-inflow.json"),
        "inducedMps",
    );
    for hz in [400, 800, 1200] {
        let mut v = 0.0;
        for _ in 0..hz {
            let r = m.step(v, 100.0, 0.0, 0.0, 1.0 / hz as f64).unwrap();
            v = r.velocity_mps;
            assert!(r.residual_n / 100.0 < 0.01 && !r.outside_validity);
        }
        assert!((v - target * (1.0 - (-10.0_f64).exp())).abs() < 1e-10);
    }
    let climb = m.step(0.0, 100.0, -10.0, 0.0, 0.0025).unwrap();
    assert!(climb.residual_n < 1e-10 && climb.target_mps < target);
}
#[test]
fn zero_loading_reverse_thrust_and_unvalidated_regimes_are_explicit() {
    let m = AxialInflow::new(1.225, 0.5, 0.1, 50.0).unwrap();
    assert_eq!(
        m.step(0.0, 0.0, 0.0, 0.0, 0.0025).unwrap().velocity_mps,
        0.0
    );
    let reverse = m.step(0.0, -100.0, 0.0, 0.0, 0.0025).unwrap();
    assert!(reverse.velocity_mps < 0.0 && reverse.residual_n < 1e-10);
    assert!(
        m.step(0.0, 100.0, 5.0, 0.0, 0.0025)
            .unwrap()
            .outside_validity
    );
    assert!(
        m.step(0.0, 100.0, 0.0, 5.0, 0.0025)
            .unwrap()
            .outside_validity
    );
    assert!(m.step(0.0, f64::NAN, 0.0, 0.0, 0.0025).is_err());
    assert!(AxialInflow::new(0.0, 1.0, 1.0, 1.0).is_err());
}
