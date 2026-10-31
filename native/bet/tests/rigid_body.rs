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

// TASK-094: torque-free precession of an axisymmetric body, I = diag(I1, I1, I3).
// Euler's equations give, in body axes, ω = (ω1 cos Ωt, ω1 sin Ωt, ω3) with
// Ω = (I3 − I1) ω3 / I1, and the world angular momentum R·I·ω is constant.
// Tolerances were set before the implementation (roadmap TASK-094).
const I1: f64 = 0.05;
const I3: f64 = 0.08;
const W1: f64 = 1.0;
const W3: f64 = 2.0;

fn rotate(q: [f64; 4], v: Vec3) -> Vec3 {
    let [w, x, y, z] = q;
    Vec3::new(
        (1.0 - 2.0 * (y * y + z * z)) * v.x + 2.0 * (x * y - w * z) * v.y + 2.0 * (x * z + w * y) * v.z,
        2.0 * (x * y + w * z) * v.x + (1.0 - 2.0 * (x * x + z * z)) * v.y + 2.0 * (y * z - w * x) * v.z,
        2.0 * (x * z - w * y) * v.x + 2.0 * (y * z + w * x) * v.y + (1.0 - 2.0 * (x * x + y * y)) * v.z,
    )
}
fn mat_vec(m: [f64; 9], v: Vec3) -> Vec3 {
    Vec3::new(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[3] * v.x + m[4] * v.y + m[5] * v.z, m[6] * v.x + m[7] * v.y + m[8] * v.z)
}
/// Q·diag(d)·Qᵀ for the rotation Q of the unit quaternion q.
fn rotated_tensor(q: [f64; 4], d: [f64; 3]) -> [f64; 9] {
    let columns = [rotate(q, Vec3::new(1.0, 0.0, 0.0)), rotate(q, Vec3::new(0.0, 1.0, 0.0)), rotate(q, Vec3::new(0.0, 0.0, 1.0))];
    let mut m = [0.0; 9];
    for r in 0..3 {
        for c in r..3 {
            let pick = |v: Vec3, i: usize| [v.x, v.y, v.z][i];
            m[r * 3 + c] = (0..3).map(|k| pick(columns[k], r) * d[k] * pick(columns[k], c)).sum();
            // The kernel accepts only an exactly symmetric tensor, so mirror the upper triangle.
            m[c * 3 + r] = m[r * 3 + c];
        }
    }
    m
}
fn relative(a: Vec3, b: Vec3) -> f64 {
    a.add(b.scale(-1.0)).norm() / b.norm()
}
/// Runs 2 s torque-free at 400 Hz; returns the worst rate and momentum errors against the closed form.
fn precession(inertia: [f64; 9], principal_to_body: [f64; 4]) -> (f64, f64) {
    let p = BodyParameters::new(1.0, inertia).unwrap();
    let mut state = initial();
    state.omega = rotate(principal_to_body, Vec3::new(W1, 0.0, W3));
    let momentum = |s: &BodyState| rotate(s.quaternion, mat_vec(inertia, s.omega));
    let l0 = momentum(&state);
    let (hz, omega_rate) = (400, (I3 - I1) / I1 * W3);
    let (mut worst_rate, mut worst_momentum) = (0.0_f64, 0.0_f64);
    for k in 1..=2 * hz {
        state = p.step(state, Wrench { force: ZERO, moment: ZERO }, 0.0, 1.0 / hz as f64).unwrap().state;
        let t = k as f64 / hz as f64;
        let expected = rotate(principal_to_body, Vec3::new(W1 * (omega_rate * t).cos(), W1 * (omega_rate * t).sin(), W3));
        worst_rate = worst_rate.max(relative(state.omega, expected));
        worst_momentum = worst_momentum.max(relative(momentum(&state), l0));
    }
    (worst_rate, worst_momentum)
}
#[test]
fn torque_free_precession_matches_the_closed_form() {
    let (rate, momentum) = precession([I1, 0.0, 0.0, 0.0, I1, 0.0, 0.0, 0.0, I3], [1.0, 0.0, 0.0, 0.0]);
    assert!(rate < 1e-9, "rate error {rate}");
    assert!(momentum < 1e-10, "momentum error {momentum}");
}
#[test]
fn precession_with_products_of_inertia_matches_the_rotated_closed_form() {
    // A principal frame rotated 0.7 rad about (1, 2, 3): every product of inertia is non-zero.
    let axis = Vec3::new(1.0, 2.0, 3.0).scale(1.0 / 14f64.sqrt());
    let q = [(0.35f64).cos(), axis.x * (0.35f64).sin(), axis.y * (0.35f64).sin(), axis.z * (0.35f64).sin()];
    let inertia = rotated_tensor(q, [I1, I1, I3]);
    assert!(inertia[1].abs() > 1e-4 && inertia[2].abs() > 1e-4 && inertia[5].abs() > 1e-4);
    let (rate, momentum) = precession(inertia, q);
    assert!(rate < 1e-9, "rate error {rate}");
    assert!(momentum < 1e-10, "momentum error {momentum}");
}
#[test]
fn angular_acceleration_solves_eulers_equations() {
    let axis = Vec3::new(1.0, 2.0, 3.0).scale(1.0 / 14f64.sqrt());
    let q = [(0.35f64).cos(), axis.x * (0.35f64).sin(), axis.y * (0.35f64).sin(), axis.z * (0.35f64).sin()];
    let inertia = rotated_tensor(q, [0.03, 0.045, 0.07]);
    let p = BodyParameters::new(1.2, inertia).unwrap();
    let (omega, moment) = (Vec3::new(0.4, -1.3, 2.2), Vec3::new(0.02, -0.01, 0.05));
    let alpha = p.angular_acceleration(omega, moment);
    // I·α + ω × (I·ω) = M, checked by substitution.
    let residual = mat_vec(inertia, alpha).add(omega.cross(mat_vec(inertia, omega))).add(moment.scale(-1.0));
    assert!(residual.norm() < 1e-12 * moment.norm().max(omega.cross(mat_vec(inertia, omega)).norm()), "{residual:?}");
}
