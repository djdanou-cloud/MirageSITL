use mirage_bet::{
    frame::Wrench,
    rigid_body::{BodyParameters, BodyState},
    Vec3,
};
const ZERO: Vec3 = Vec3::new(0.0, 0.0, 0.0);
fn initial() -> BodyState {
    BodyState {
        position: ZERO,
        velocity: ZERO,
        quaternion: [1.0, 0.0, 0.0, 0.0],
        omega: ZERO,
    }
}
#[test]
fn ballistic_and_constant_principal_torque_match_analytic_motion() {
    let p = BodyParameters::new(2.0, [2.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 4.0]).unwrap();
    for hz in [400, 800, 1200] {
        let mut state = initial();
        for _ in 0..hz {
            state = p
                .step(
                    state,
                    Wrench {
                        force: ZERO,
                        moment: Vec3::new(0.0, 0.0, 4.0),
                    },
                    9.80665,
                    1.0 / hz as f64,
                )
                .unwrap()
                .state;
        }
        assert!((state.position.z - 4.903325).abs() < 1e-10);
        assert!((state.omega.z - 1.0).abs() < 1e-12);
        assert!((state.quaternion[0] - (0.25_f64).cos()).abs() < 1e-10);
        let norm = state.quaternion.iter().map(|v| v * v).sum::<f64>();
        assert!((norm - 1.0).abs() < 1e-10);
    }
}
fn flight(hz: usize) -> BodyState {
    let p = BodyParameters::new(2.0, [2.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 4.0]).unwrap();
    let mut s = BodyState {
        omega: Vec3::new(0.7, -0.4, 1.0),
        ..initial()
    };
    for _ in 0..hz * 10 {
        s = p
            .step(
                s,
                Wrench {
                    force: Vec3::new(0.1, 0.2, -19.0),
                    moment: ZERO,
                },
                9.80665,
                1.0 / hz as f64,
            )
            .unwrap()
            .state;
    }
    s
}
#[test]
fn smooth_torque_free_trajectory_converges_to_4800hz() {
    let reference = flight(4800);
    for hz in [400, 800, 1200] {
        let s = flight(hz);
        assert!(s.position.add(reference.position.scale(-1.0)).norm() < 0.001);
        let dot = s
            .quaternion
            .iter()
            .zip(reference.quaternion)
            .map(|(a, b)| a * b)
            .sum::<f64>()
            .abs()
            .min(1.0);
        assert!(2.0 * dot.acos() < 0.001);
    }
}
#[test]
fn rejects_bad_inertia_and_quaternion() {
    assert!(BodyParameters::new(1.0, [1.0; 9]).is_err());
    let p = BodyParameters::new(1.0, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]).unwrap();
    assert!(p
        .step(
            BodyState {
                quaternion: [0.0; 4],
                ..initial()
            },
            Wrench {
                force: ZERO,
                moment: ZERO
            },
            9.80665,
            0.0025
        )
        .is_err());
}
