//! Analytical oscillator, rotating hinge signs and discrete momentum ledger.
mod support;
use mirage_bet::{
    flapping::{FlapState, HingeModel},
    momentum::{angular_momentum, transmitted_moment},
    Vec3,
};
const ZERO: Vec3 = Vec3::new(0.0, 0.0, 0.0);
fn zero() -> FlapState {
    FlapState {
        angle: ZERO,
        rate: ZERO,
    }
}
#[test]
fn collective_symmetry_and_oscillator_convergence() {
    let model = HingeModel::new(1.0, 100.0, 0.0, 1, 0.2).unwrap();
    let mut errors = [0.0; 3];
    for (index, hz) in [400, 800, 1200].into_iter().enumerate() {
        let mut state = FlapState {
            angle: Vec3::new(0.1, 0.0, 0.0),
            rate: ZERO,
        };
        for _ in 0..hz {
            state = model
                .step(state, ZERO, 0.0, 0.0, 1.0 / hz as f64)
                .unwrap()
                .state;
        }
        errors[index] = (state.angle.x
            - support::number(
                include_str!("../../../tests/fixtures/rotors/flapping.json"),
                "coneRad",
            ))
        .abs();
        assert_eq!(state.angle.y, 0.0);
        assert_eq!(state.angle.z, 0.0);
    }
    assert!(errors[2] < errors[0] / 40.0);
    assert!(errors[2] < 1e-9);
    let damped = HingeModel::new(1.0, 100.0, 10.0, 1, 0.2).unwrap();
    let mut state = zero();
    for _ in 0..4000 {
        state = damped
            .step(state, Vec3::new(1.0, 0.0, 0.0), 0.0, 0.0, 0.0025)
            .unwrap()
            .state;
    }
    assert!((state.angle.x - 0.01).abs() < 1e-10);
}
#[test]
fn rotating_harmonics_mirror_and_invalid_envelope_is_explicit() {
    let state = FlapState {
        angle: ZERO,
        rate: Vec3::new(0.0, 0.01, 0.0),
    };
    let a = HingeModel::new(1.0, 1.0, 0.0, 1, 0.2)
        .unwrap()
        .step(state, ZERO, 50.0, 0.0, 0.00001)
        .unwrap();
    let b = HingeModel::new(1.0, 1.0, 0.0, -1, 0.2)
        .unwrap()
        .step(state, ZERO, 50.0, 0.0, 0.00001)
        .unwrap();
    assert!(a.state.rate.z > 0.0);
    assert!((a.state.rate.z + b.state.rate.z).abs() < 1e-15);
    let model = HingeModel::new(1.0, 1.0, 0.0, 1, 0.2).unwrap();
    assert!(model.step(zero(), ZERO, 10000.0, 0.0, 0.0025).is_err());
    assert!(
        model
            .step(
                FlapState {
                    angle: Vec3::new(0.3, 0.0, 0.0),
                    rate: ZERO
                },
                ZERO,
                0.0,
                0.0,
                0.0025
            )
            .unwrap()
            .outside_validity
    );
}
#[test]
fn spin_up_gyroscopic_axes_and_full_momentum_balance() {
    let before = angular_momentum(0.2, 1, 100.0, zero()).unwrap();
    let after = angular_momentum(0.2, 1, 101.0, zero()).unwrap();
    let body = Vec3::new(1.0, 0.0, 0.0);
    let air = Vec3::new(0.1, 0.2, -0.3);
    let dt = 0.0025;
    let transmitted = transmitted_moment(air, before, after, body, dt).unwrap();
    let residual = transmitted
        .add(after.add(before.scale(-1.0)).scale(1.0 / dt))
        .add(body.cross(before.add(after).scale(0.5)))
        .add(air.scale(-1.0));
    assert!(residual.norm() < 1e-12);
    assert!(transmitted.y > 0.0 && transmitted.z < 0.0);
    let flap = FlapState {
        angle: Vec3::new(0.02, 0.03, -0.01),
        rate: Vec3::new(0.01, 0.02, 0.03),
    };
    let tilted = angular_momentum(0.2, 1, 100.0, flap).unwrap();
    assert!(tilted.x < 0.0 && tilted.y > 0.0 && tilted.z < before.z);
    let changed = transmitted_moment(ZERO, before, tilted, ZERO, dt).unwrap();
    assert!(changed.x.abs() > 1.0 && changed.y.abs() > 1.0);
}
