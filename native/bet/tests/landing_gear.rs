//! Synthetic independent force/energy oracles; no aircraft calibration claim.
use mirage_bet::{
    landing_gear::{ground_wrench, Damping, DampingLaw, GasStrut, LinearStrut, TireCurve},
    Vec3,
};

fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} != {b}");
}
fn gas() -> GasStrut {
    GasStrut::new(
        0.01, 0.01, 300_000.0, 100_000.0, 1.0, 0.5, 0.005, 850.0, 0.7, 0.0001, 0.00005,
    )
    .unwrap()
}

#[test]
fn gas_pressure_absolute_units_and_orifice_flow_match_hand_calculation() {
    let model = gas();
    let result = model.evaluate(0.1, 0.2).unwrap();
    // V=0.009 m^3; p=300000*10/9 Pa; net pressure acts on 0.01 m^2.
    let elastic = (300_000.0 * 10.0 / 9.0 - 100_000.0) * 0.01;
    // Q=A_h*v=0.001 m^3/s; dp=rho/2*(Q/(Cd*A_o))^2.
    let hydraulic = 850.0 / 2.0 * (0.001_f64 / 0.00007).powi(2) * 0.005;
    close(result.elastic_n, elastic);
    close(result.load_n, elastic + hydraulic);
    close(result.dissipation_w, hydraulic * 0.2);
    close(
        result.stored_energy_j,
        3000.0 * (10.0_f64 / 9.0).ln() - 100.0,
    );
    let rebound = model.evaluate(0.1, -0.2).unwrap();
    close(rebound.load_n, elastic - 4.0 * hydraulic);
    assert!(rebound.dissipation_w > result.dissipation_w);
    let limited = model.evaluate(0.1, -2.0).unwrap();
    close(limited.load_n, 0.0);
    close(limited.dissipation_w, elastic * 2.0);
}

#[test]
fn polytropic_gas_stored_energy_derivative_equals_elastic_load() {
    let model = GasStrut::new(
        0.01, 0.01, 300_000.0, 100_000.0, 1.4, 0.5, 0.005, 850.0, 0.7, 0.0001, 0.00005,
    )
    .unwrap();
    let dx = 1e-5;
    let derivative = (model.evaluate(0.1 + dx, 0.0).unwrap().stored_energy_j
        - model.evaluate(0.1 - dx, 0.0).unwrap().stored_energy_j)
        / (2.0 * dx);
    assert!((derivative - model.evaluate(0.1, 0.0).unwrap().load_n).abs() < 1e-5);
}

#[test]
fn near_zero_compression_is_valid_even_with_zero_gauge_preload() {
    for exponent in [1.0, 1.4] {
        let model = GasStrut::new(
            0.01, 0.01, 100_000.0, 100_000.0, exponent, 0.5, 0.005, 850.0, 0.7, 0.0001, 0.00005,
        )
        .unwrap();
        let result = model.evaluate(1e-16, 0.0).unwrap();
        assert!(result.elastic_n > 0.0);
        assert!(result.stored_energy_j > 0.0);
        let leading_energy = 0.5 * exponent * 100_000.0 * 0.01 * 1e-32;
        assert!((result.stored_energy_j / leading_energy - 1.0).abs() < 1e-12);
    }
}

#[test]
fn closed_compression_rebound_cycle_dissipates_the_independent_work_budget() {
    let model = LinearStrut::new(
        1000.0,
        10.0,
        0.5,
        Damping::new(10.0, 20.0, DampingLaw::Linear).unwrap(),
    )
    .unwrap();
    let mut work = 0.0;
    let dx = 0.1 / 1000.0;
    for i in 0..1000 {
        let x0 = 0.1 * (i as f64 / 1000.0);
        let x1 = 0.1 * ((i + 1) as f64 / 1000.0);
        let c0 = model.evaluate(x0, 0.1).unwrap().load_n;
        let c1 = model.evaluate(x1, 0.1).unwrap().load_n;
        let r0 = model.evaluate(x0, -0.1).unwrap().load_n;
        let r1 = model.evaluate(x1, -0.1).unwrap().load_n;
        work += (c0 + c1 - r0 - r1) * dx / 2.0;
    }
    // Elastic/preload work cancels; (10+20)*0.1 m/s*0.1 m = 0.3 J loss.
    close(work, 0.3);
}

#[test]
fn linear_and_square_damping_use_distinct_compression_and_rebound_coefficients() {
    for (law, expected_compression, expected_rebound) in [
        (DampingLaw::Linear, 20.0, 40.0),
        (DampingLaw::Square, 4.0, 8.0),
    ] {
        let model =
            LinearStrut::new(1000.0, 10.0, 0.5, Damping::new(100.0, 200.0, law).unwrap()).unwrap();
        close(
            model.evaluate(0.1, 0.2).unwrap().load_n,
            110.0 + expected_compression,
        );
        close(
            model.evaluate(0.1, -0.2).unwrap().load_n,
            110.0 - expected_rebound,
        );
        close(model.evaluate(0.1, 0.0).unwrap().stored_energy_j, 6.0);
    }
}

#[test]
fn tire_interpolation_and_piecewise_energy_are_independent_of_strut_travel() {
    let x = [0.0, 0.01, 0.03];
    let force = [0.0, 100.0, 500.0];
    let model = TireCurve::new(&x, &force, 50.0).unwrap();
    let value = model.evaluate(0.02, 0.2).unwrap();
    close(value.elastic_n, 300.0);
    close(value.load_n, 310.0);
    close(value.stored_energy_j, 2.5); // triangle 0.5 J + trapezoid 2 J.
    close(value.dissipation_w, 2.0);
    close(model.evaluate(0.03, 0.0).unwrap().load_n, 500.0);
    close(model.evaluate(-0.01, 10.0).unwrap().load_n, 0.0);
    close(model.evaluate(0.0, 10.0).unwrap().load_n, 0.0);
    close(model.evaluate(0.02, -10.0).unwrap().load_n, 0.0);
    assert!(model.evaluate(0.031, 0.0).is_err()); // no invented bottom-out curve.
}

#[test]
fn instantaneous_resistance_is_passive_for_each_component() {
    let x = [0.0, 0.01, 0.03];
    let force = [0.0, 100.0, 500.0];
    let tire = TireCurve::new(&x, &force, 50.0).unwrap();
    for i in 1..=1000 {
        let compression = 0.03 * (i as f64 / 1000.0);
        for velocity in [-10.0, -0.2, 0.0, 0.2, 10.0] {
            let t = tire.evaluate(compression, velocity).unwrap();
            let g = gas().evaluate(compression, velocity).unwrap();
            for value in [t, g] {
                assert!(value.load_n >= 0.0);
                assert!(value.dissipation_w >= -1e-10);
                close(
                    (value.load_n - value.elastic_n) * velocity,
                    value.dissipation_w,
                );
            }
        }
    }
}

#[test]
fn ground_wrench_has_correct_ned_sign_lever_moment_and_friction_work() {
    let n = Vec3::new(0.0, 0.0, -1.0);
    let p = Vec3::new(0.0, 1.0, 1.0);
    let q = [1.0, 0.0, 0.0, 0.0];
    let v = Vec3::new(2.0, 0.0, 3.0);
    let w = ground_wrench(p, q, n, 100.0, v, 0.5, 0.1).unwrap();
    close(w.force.x, -50.0);
    close(w.force.y, 0.0);
    close(w.force.z, -100.0);
    close(w.moment.x, -100.0);
    close(w.moment.y, -50.0);
    close(w.moment.z, 50.0);
    let a = std::f64::consts::FRAC_PI_4;
    let turned = ground_wrench(p, [a.cos(), 0.0, 0.0, a.sin()], n, 100.0, v, 0.5, 0.1).unwrap();
    close(turned.force.x, 0.0);
    close(turned.force.y, 50.0);
    close(turned.force.z, -100.0);
    // Tangential friction opposes slip and never exceeds mu*N, including near rest.
    for speed in [-2.0, -0.01, 0.0, 0.01, 2.0] {
        let w = ground_wrench(p, q, n, 100.0, Vec3::new(speed, 0.0, 0.0), 0.5, 0.1).unwrap();
        assert!(w.force.x * speed <= 0.0);
        assert!(w.force.x.abs() <= 50.0);
    }
    assert!(ground_wrench(p, q, n.scale(2.0), 100.0, v, 0.5, 0.1).is_err());
    assert!(ground_wrench(p, q, n, -1.0, v, 0.5, 0.1).is_err());
    assert!(ground_wrench(p, [2.0, 0.0, 0.0, 0.0], n, 100.0, v, 0.5, 0.1).is_err());
}

#[test]
fn invalid_configuration_and_out_of_envelope_states_are_rejected() {
    assert!(GasStrut::new(
        0.01, 0.001, 300_000.0, 100_000.0, 1.4, 0.5, 0.005, 850.0, 0.7, 0.0001, 0.0001
    )
    .is_err());
    assert!(GasStrut::new(
        0.01, 0.01, 300_000.0, 100_000.0, 1.4, 0.5, 0.005, 850.0, 0.0, 0.0001, 0.0001
    )
    .is_err());
    assert!(TireCurve::new(&[0.0, 0.01, 0.01], &[0.0, 1.0, 2.0], 0.0).is_err());
    assert!(TireCurve::new(&[0.0, 0.01], &[0.0, -1.0], 0.0).is_err());
    assert!(gas().evaluate(-0.001, 0.0).is_err());
    assert!(gas().evaluate(0.501, 0.0).is_err());
    assert!(gas().evaluate(0.1, f64::NAN).is_err());
    assert!(gas().evaluate(0.1, f64::MAX).is_err());
    assert!(Damping::new(-1.0, 1.0, DampingLaw::Linear).is_err());
}
