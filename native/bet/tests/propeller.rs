//! Steady propeller coefficients: exact actuator-disk and zero-drag energy oracles.
use mirage_bet::{
    blade::{Rotor, RotorGeometry},
    inflow::AxialInflow,
    polar::PolarTable,
    propeller::{steady_point, PropellerCondition},
};
use std::f64::consts::PI;

const RADIUS: f64 = 0.127; // 10 in diameter
const CUTOUT: f64 = 0.015;
const PITCH: f64 = 0.12; // geometric pitch, m
const N: usize = 24;

struct Blade {
    radius: [f64; N],
    chord: [f64; N],
    twist: [f64; N],
    width: [f64; N],
}

fn blade() -> Blade {
    let dr = (RADIUS - CUTOUT) / N as f64;
    let mut b = Blade { radius: [0.0; N], chord: [0.0; N], twist: [0.0; N], width: [dr; N] };
    for k in 0..N {
        let r = CUTOUT + (k as f64 + 0.5) * dr;
        b.radius[k] = r;
        b.chord[k] = 0.02;
        // Constant geometric pitch: beta = atan(p / (2 pi r)).
        b.twist[k] = (PITCH / (2.0 * PI * r)).atan();
    }
    b
}

// Linear lift CL = 2 pi alpha over the whole wrapped range; constant CD.
const ALPHA: [f64; 2] = [-PI, PI];
const CL: [f64; 2] = [-2.0 * PI * PI, 2.0 * PI * PI];

fn condition(rpm: f64, j: f64) -> PropellerCondition {
    PropellerCondition {
        rpm,
        advance_ratio: j,
        density_kg_m3: 1.225,
        viscosity_pa_s: 1.789e-5,
        sound_speed_mps: 340.0,
        collective_rad: 0.0,
    }
}

fn with_rotor<T>(spin: i32, cd: f64, f: impl FnOnce(&Rotor<'_>) -> T) -> T {
    let b = blade();
    let cd_table = [cd, cd];
    let polar = PolarTable::new(&ALPHA, &[1e5], &[0.1], &CL, &cd_table).unwrap();
    let rotor = Rotor::new(
        RotorGeometry {
            blade_count: 2,
            spin_sign: spin,
            radius_m: RADIUS,
            cutout_m: CUTOUT,
            radius: &b.radius,
            chord: &b.chord,
            twist: &b.twist,
            width: &b.width,
        },
        polar,
        8,
    )
    .unwrap();
    f(&rotor)
}

#[test]
fn zero_drag_power_equals_thrust_times_axial_flow() {
    // With CD = 0, every element obeys dP = dT (V + v): exact, independent of geometry.
    with_rotor(1, 0.0, |rotor| {
        for (rpm, j) in [(4000.0, 0.0), (5000.0, 0.2), (6000.0, 0.3), (3000.0, 0.38)] {
            let p = steady_point(rotor, RADIUS, 1, condition(rpm, j)).unwrap();
            let n = rpm / 60.0;
            let v = j * n * 2.0 * RADIUS;
            assert!(!p.outside_momentum_validity && p.thrust_n > 0.0, "{rpm} {j}");
            let expected = p.thrust_n * (v + p.induced_mps);
            assert!((p.power_w - expected).abs() <= 1e-9 * expected, "{} vs {expected}", p.power_w);
            if j > 0.0 {
                // Ideal (Froude) efficiency V / (V + v).
                assert!((p.eta - v / (v + p.induced_mps)).abs() < 1e-9);
            }
            // Nondimensionalization with n in rev/s and D = 2R.
            assert!((p.ct * 1.225 * n * n * (2.0 * RADIUS).powi(4) - p.thrust_n).abs() < 1e-9 * p.thrust_n);
            assert!((p.cp * 1.225 * n.powi(3) * (2.0 * RADIUS).powi(5) - p.power_w).abs() < 1e-9 * p.power_w);
        }
    });
}

#[test]
fn induced_velocity_satisfies_axial_momentum_and_matches_inflow_model() {
    with_rotor(1, 0.012, |rotor| {
        for (rpm, j) in [(4000.0, 0.0), (5000.0, 0.25), (7000.0, 0.38)] {
            let p = steady_point(rotor, RADIUS, 1, condition(rpm, j)).unwrap();
            let v = j * rpm / 60.0 * 2.0 * RADIUS;
            assert!(!p.outside_momentum_validity && p.momentum_residual_n <= 1e-9 * p.thrust_n.max(1e-9), "residual {}", p.momentum_residual_n);
            // The dynamic inflow model's quasi-steady target for this thrust is the same root.
            let inflow = AxialInflow::new(1.225, RADIUS, 0.05, 100.0).unwrap();
            let report = inflow.step(p.induced_mps, p.thrust_n, -v, 0.0, 1.0 / 400.0).unwrap();
            assert!((report.target_mps - p.induced_mps).abs() < 1e-9, "{} vs {}", report.target_mps, p.induced_mps);
        }
    });
}

#[test]
fn profile_drag_costs_power_and_spin_mirrors() {
    let ideal = with_rotor(1, 0.0, |r| steady_point(r, RADIUS, 1, condition(5000.0, 0.3)).unwrap());
    let drag = with_rotor(1, 0.015, |r| steady_point(r, RADIUS, 1, condition(5000.0, 0.3)).unwrap());
    let mirrored = with_rotor(-1, 0.015, |r| steady_point(r, RADIUS, -1, condition(5000.0, 0.3)).unwrap());
    assert!(drag.cp > ideal.cp && drag.eta < ideal.eta && drag.eta > 0.0);
    assert!((mirrored.ct - drag.ct).abs() < 1e-12 && (mirrored.cp - drag.cp).abs() < 1e-12);
}

#[test]
fn windmilling_is_flagged_and_inputs_are_checked() {
    with_rotor(1, 0.012, |rotor| {
        // J = 1.5 exceeds the pitch/diameter ratio (0.47): the blade runs at negative alpha.
        let p = steady_point(rotor, RADIUS, 1, condition(5000.0, 1.5)).unwrap();
        assert!(p.outside_momentum_validity && p.ct <= 0.0 && p.induced_mps == 0.0);
        for bad in [condition(0.0, 0.2), condition(5000.0, -0.1), condition(f64::NAN, 0.2)] {
            assert!(steady_point(rotor, RADIUS, 1, bad).is_err());
        }
        assert!(steady_point(rotor, RADIUS, 0, condition(5000.0, 0.2)).is_err());
    });
}
