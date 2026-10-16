//! Analytic tests for the bootstrap element-force kernel (section 3).
use mirage_bet::{bet_abi_version, bet_bootstrap_element_force, element_force, Vec3, BET_ABI_VERSION};

const RHO: f64 = 1.225; // ISA sea-level density, kg/m^3
const ER: Vec3 = Vec3::new(1.0, 0.0, 0.0); // element at azimuth 0

fn close(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol * (1.0 + b.abs())
}

#[test]
fn zero_relative_airspeed_gives_zero_force() {
    for v in [Vec3::new(0.0, 0.0, 0.0), Vec3::new(5e-7, 0.0, 0.0), Vec3::new(f64::NAN, 0.0, 0.0)] {
        assert_eq!(element_force(RHO, 0.03, 0.01, v, ER, 1.0, 1.1, 0.02), Vec3::new(0.0, 0.0, 0.0));
    }
}

#[test]
fn magnitude_matches_dynamic_pressure_times_area_and_coefficients() {
    let (chord, dr, cl, cd) = (0.03, 0.01, 1.1, 0.04);
    let v = Vec3::new(0.0, -30.0, 4.0); // in-plane flow (perpendicular to e_r)
    let f = element_force(RHO, chord, dr, v, ER, 1.0, cl, cd);
    let speed = (30.0f64 * 30.0 + 4.0 * 4.0).sqrt();
    let expected = 0.5 * RHO * speed * speed * chord * dr * (cl * cl + cd * cd).sqrt();
    assert!(close(f.norm(), expected, 1e-14), "{} vs {}", f.norm(), expected);
}

#[test]
fn lift_is_perpendicular_and_drag_parallel_to_the_relative_flow() {
    let v = Vec3::new(0.0, -25.0, 3.0);
    let d = v.scale(1.0 / v.norm());
    let lift_only = element_force(RHO, 0.03, 0.01, v, ER, 1.0, 1.0, 0.0);
    let drag_only = element_force(RHO, 0.03, 0.01, v, ER, 1.0, 0.0, 0.05);
    assert!(lift_only.dot(d).abs() < 1e-12);
    assert!(lift_only.dot(ER).abs() < 1e-12);
    // Drag acts along the relative air velocity: positive work against the blade's motion.
    assert!(close(drag_only.dot(d), drag_only.norm(), 1e-14));
    assert!(drag_only.dot(d) > 0.0);
}

#[test]
fn mirrored_spin_flips_lift_but_not_drag() {
    let v = Vec3::new(0.0, -25.0, 3.0);
    let right = element_force(RHO, 0.03, 0.01, v, ER, 1.0, 1.0, 0.0);
    let left = element_force(RHO, 0.03, 0.01, v, ER, -1.0, 1.0, 0.0);
    assert_eq!(left, right.scale(-1.0));
    let drag_right = element_force(RHO, 0.03, 0.01, v, ER, 1.0, 0.0, 0.05);
    let drag_left = element_force(RHO, 0.03, 0.01, v, ER, -1.0, 0.0, 0.05);
    assert_eq!(drag_left, drag_right);
}

#[test]
fn force_is_linear_in_chord_width_and_coefficients() {
    let v = Vec3::new(0.0, -20.0, 1.0);
    let base = element_force(RHO, 0.03, 0.01, v, ER, 1.0, 0.8, 0.03);
    let doubled = element_force(RHO, 0.06, 0.01, v, ER, 1.0, 0.8, 0.03);
    let wider = element_force(RHO, 0.03, 0.03, v, ER, 1.0, 0.8, 0.03);
    assert!(close(doubled.norm(), 2.0 * base.norm(), 1e-14));
    assert!(close(wider.norm(), 3.0 * base.norm(), 1e-14));
}

#[test]
fn exports_match_the_rust_kernel() {
    assert_eq!(bet_abi_version(), BET_ABI_VERSION);
    let f = element_force(RHO, 0.03, 0.01, Vec3::new(0.0, -25.0, 3.0), ER, 1.0, 1.1, 0.02);
    let component = |axis| bet_bootstrap_element_force(RHO, 0.03, 0.01, 0.0, -25.0, 3.0, 1.0, 0.0, 0.0, 1.0, 1.1, 0.02, axis);
    assert_eq!([component(0), component(1), component(2)], [f.x, f.y, f.z]);
    assert!(component(3).is_nan());
}
