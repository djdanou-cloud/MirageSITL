//! Constant-polar annulus closed forms, independent of the kernel implementation.
mod support;
use mirage_bet::{
    blade::{Rotor, RotorGeometry, RotorInput},
    polar::PolarTable,
    Vec3,
};
use std::f64::consts::PI;
fn input() -> RotorInput {
    RotorInput {
        density_kg_m3: 1.225,
        viscosity_pa_s: 1.789e-5,
        sound_speed_mps: 340.0,
        air_velocity_hub_mps: Vec3::new(0.0, 0.0, 0.0),
        body_rate_hub_rad_s: Vec3::new(0.0, 0.0, 0.0),
        omega_rad_s: 100.0,
        induced_mps: 0.0,
        collective_rad: 0.1,
        cyclic_cos_rad: 0.0,
        cyclic_sin_rad: 0.0,
    }
}
fn run(n: usize, az: usize, spin: i32, i: RotorInput) -> mirage_bet::blade::RotorWrench {
    let dr = 0.4 / n as f64;
    let r: Vec<f64> = (0..n).map(|j| 0.1 + (j as f64 + 0.5) * dr).collect();
    let chord = vec![0.03; n];
    let twist = vec![0.0; n];
    let widths = vec![dr; n];
    let p = PolarTable::new(&[-PI, PI], &[1.0, 1e9], &[0.0, 1.0], &[1.0; 8], &[0.02; 8]).unwrap();
    let rotor = Rotor::new(
        RotorGeometry {
            blade_count: 2,
            spin_sign: spin,
            radius_m: 0.5,
            cutout_m: 0.1,
            radius: &r,
            chord: &chord,
            twist: &twist,
            width: &widths,
        },
        p,
        az,
    )
    .unwrap();
    rotor.evaluate(i).unwrap()
}
#[test]
fn annulus_force_torque_and_refinement_match_closed_forms() {
    let fixture = include_str!("../../../tests/fixtures/rotors/blade.json");
    let exact_t = support::number(fixture, "forceN");
    let exact_q = support::number(fixture, "torqueNm");
    let mut previous = f64::INFINITY;
    for n in [16, 32, 64] {
        let w = run(n, 32, 1, input());
        let error = (w.force_n.z - exact_t).abs();
        assert!(error < previous / 3.9);
        previous = error;
        assert!((w.moment_nm.z - exact_q).abs() / exact_q.abs() < 0.002);
        assert!(w.force_n.x.abs() < 1e-12 && w.force_n.y.abs() < 1e-12);
    }
    assert!(previous / exact_t < 0.0001);
}
#[test]
fn samples_do_not_multiply_force_and_spin_mirror_preserves_thrust() {
    let a = run(32, 16, 1, input());
    for az in [32, 64] {
        assert!((run(32, az, 1, input()).force_n.z - a.force_n.z).abs() < 1e-10);
    }
    let b = run(32, 32, -1, input());
    assert!((b.force_n.z - a.force_n.z).abs() < 1e-10);
    assert!((b.moment_nm.z + a.moment_nm.z).abs() < 1e-10);
    assert!(a.moment_nm.z * 100.0 < 0.0);
    let mut zero = input();
    zero.omega_rad_s = 0.0;
    assert_eq!(run(16, 16, 1, zero).force_n, Vec3::new(0.0, 0.0, 0.0));
}
#[test]
fn crossflow_and_body_rates_are_finite() {
    let mut i = input();
    i.air_velocity_hub_mps = Vec3::new(15.0, -3.0, 2.0);
    i.body_rate_hub_rad_s = Vec3::new(0.1, 0.2, 0.3);
    let w = run(32, 64, 1, i);
    assert!(w.force_n.norm().is_finite() && w.moment_nm.norm().is_finite());
}

#[test]
fn rejects_invalid_geometry_inputs_and_reports_polar_clamping() {
    let p = PolarTable::new(
        &[-3.15, 3.15],
        &[1000.0, 2000.0],
        &[0.0, 0.01],
        &[1.0; 8],
        &[0.02; 8],
    )
    .unwrap();
    let g = RotorGeometry {
        blade_count: 2,
        spin_sign: 1,
        radius_m: 0.5,
        cutout_m: 0.1,
        radius: &[0.3],
        chord: &[0.03],
        twist: &[0.0],
        width: &[0.4],
    };
    for bad in [
        RotorGeometry { spin_sign: 0, ..g },
        RotorGeometry {
            blade_count: 0,
            ..g
        },
        RotorGeometry {
            radius: &[0.6],
            ..g
        },
        RotorGeometry { width: &[0.2], ..g },
        RotorGeometry {
            chord: &[f64::NAN],
            ..g
        },
    ] {
        assert!(Rotor::new(bad, p, 16).is_err());
    }
    assert!(Rotor::new(g, p, 0).is_err());
    assert!(Rotor::new(g, p, 65).is_err());
    let rotor = Rotor::new(g, p, 16).unwrap();
    let mut invalid = input();
    invalid.omega_rad_s = f64::NAN;
    assert!(rotor.evaluate(invalid).is_err());
    invalid = input();
    invalid.density_kg_m3 = 0.0;
    assert!(rotor.evaluate(invalid).is_err());
    assert_ne!(rotor.evaluate(input()).unwrap().flags, 0);
}

#[test]
fn pitch_and_flow_derive_alpha_before_polar_lookup() {
    let pi = std::f64::consts::PI;
    let alpha = [-pi, pi];
    // CL=alpha exactly on the table; CD=0, independent of Re/Mach.
    let cl = [-pi, pi, -pi, pi, -pi, pi, -pi, pi];
    let p = PolarTable::new(&alpha, &[1.0, 1e9], &[0.0, 1.0], &cl, &[0.0; 8]).unwrap();
    let g = RotorGeometry {
        blade_count: 2,
        spin_sign: 1,
        radius_m: 0.5,
        cutout_m: 0.1,
        radius: &[0.3],
        chord: &[0.03],
        twist: &[0.0],
        width: &[0.4],
    };
    let rotor = Rotor::new(g, p, 32).unwrap();
    let i = input();
    let force = rotor.evaluate(i).unwrap().force_n.z;
    let pressure_area = 2.0 * 0.5 * 1.225 * (100.0_f64 * 0.3).powi(2) * 0.03 * 0.4;
    assert!((force - pressure_area * 0.1).abs() < 1e-12);
    let negative = rotor
        .evaluate(RotorInput {
            collective_rad: -0.1,
            ..i
        })
        .unwrap();
    assert!((negative.force_n.z + force).abs() < 1e-12);
    // Pure positive induced velocity increases phi and reduces alpha.
    let induced = rotor
        .evaluate(RotorInput {
            induced_mps: 1.0,
            ..i
        })
        .unwrap();
    assert!(induced.force_n.z < force);
}

#[path = "support/neuralfoil.rs"]
mod neuralfoil;

/// TASK-091 tolerance T1, declared before implementation: every component
/// within 1e-12 of its vector's norm (absolute floor 1e-15), flags identical.
fn within_t1(a: Vec3, b: Vec3) -> bool {
    let scale = 1e-12 * (a.norm().max(b.norm())) + 1e-15;
    (a.x - b.x).abs() <= scale && (a.y - b.y).abs() <= scale && (a.z - b.z).abs() <= scale
}

/// TASK-091: `evaluate_fast` (bitwise) and `evaluate_sampled` at stride 1
/// (within T1) against the reference `evaluate` on the NACA6409
/// surrogate over axial, edgewise (advance ratio up to 0.3), climbing,
/// descending and reverse-flow states, body rates, cyclic pitch, both spin
/// directions and 1, 3, 8 and 64 azimuth samples.
#[test]
fn production_kernel_matches_the_reference_within_t1() {
    let p = neuralfoil::naca6409(&[0.0, 0.3]);
    let polar = PolarTable::new(&p.alpha, &p.re, &p.mach, &p.cl, &p.cd).unwrap().with_confidence(&p.confidence, 0.9).unwrap();
    // The example 10 x 4.5 in propeller geometry family: 16 strips, tapered and twisted.
    let (radius_m, cutout_m, n) = (0.127, 0.0127, 16usize);
    let width = (radius_m - cutout_m) / n as f64;
    let r: Vec<f64> = (0..n).map(|k| cutout_m + (k as f64 + 0.5) * width).collect();
    let chord: Vec<f64> = r.iter().map(|x| 0.025 - 0.08 * (x - 0.06)).collect();
    let twist: Vec<f64> = r.iter().map(|x| (0.1143 / (2.0 * PI * x)).atan()).collect();
    let widths = vec![width; n];
    let (mut checked, mut bitwise, mut errors) = (0usize, 0usize, 0usize);
    for spin in [1, -1] {
        for samples in [1usize, 3, 8, 64] {
            let rotor = Rotor::new(RotorGeometry { blade_count: 2, spin_sign: spin, radius_m, cutout_m, radius: &r, chord: &chord, twist: &twist, width: &widths },
                polar, samples).unwrap();
            for omega in [0.0, 5.0, 150.0, 530.0, 900.0] {
                for induced in [-6.0, -0.5, 0.0, 2.5, 9.0] {
                    for (vx, vy, vz) in [(0.0, 0.0, 0.0), (0.3 * 530.0 * radius_m, 0.0, 0.0), (-4.0, 6.0, 0.0), (0.0, 0.0, -8.0), (2.0, -1.0, 12.0)] {
                        for (rate, cyclic, collective) in [((0.0, 0.0, 0.0), (0.0, 0.0), 0.0), ((2.0, -3.0, 0.5), (0.05, -0.08), 0.1), ((-0.3, 0.2, -4.0), (-0.1, 0.02), -0.2)] {
                            let i = RotorInput { density_kg_m3: 1.225, viscosity_pa_s: 1.7894e-5, sound_speed_mps: 340.294,
                                air_velocity_hub_mps: Vec3::new(vx, vy, vz), body_rate_hub_rad_s: Vec3::new(rate.0, rate.1, rate.2),
                                omega_rad_s: omega, induced_mps: induced, collective_rad: collective, cyclic_cos_rad: cyclic.0, cyclic_sin_rad: cyclic.1 };
                            match (rotor.evaluate(i), rotor.evaluate_fast(i), rotor.evaluate_sampled(i, 1)) {
                                (Ok(a), Ok(b), Ok(t)) => {
                                    // The default production kernel is exact; the opt-in kernel is within T1.
                                    assert_eq!(a, b);
                                    assert!(within_t1(a.force_n, t.force_n) && within_t1(a.moment_nm, t.moment_nm) && within_t1(a.flap_load_nm, t.flap_load_nm),
                                        "{a:?} {t:?}");
                                    assert_eq!(a.flags, t.flags);
                                    checked += 1;
                                    if a == t { bitwise += 1; }
                                }
                                (Err(_), Err(_), Err(_)) => errors += 1,
                                (a, b, t) => panic!("reference {a:?} production {b:?} opt-in {t:?}"),
                            }
                        }
                    }
                }
            }
        }
    }
    // Invalid inputs fail in both kernels.
    let rotor = Rotor::new(RotorGeometry { blade_count: 2, spin_sign: 1, radius_m, cutout_m, radius: &r, chord: &chord, twist: &twist, width: &widths }, polar, 8).unwrap();
    let mut bad = input();
    bad.omega_rad_s = -1.0;
    assert!(rotor.evaluate(bad).is_err() && rotor.evaluate_fast(bad).is_err());
    bad = input();
    bad.induced_mps = f64::NAN;
    assert!(rotor.evaluate(bad).is_err() && rotor.evaluate_fast(bad).is_err());
    assert_eq!(checked + errors, 2 * 4 * 5 * 5 * 5 * 3);
    // The opt-in kernel reassociates the reference arithmetic, so most states differ in the last bits only.
    println!("T1 checked {checked} states, {bitwise} of them bitwise for the opt-in kernel, {errors} rejected by all");
}

#[test]
fn the_wrap_reproduces_rem_euclid_bits() {
    use mirage_bet::blade::wrap_angle;
    let tau = 2.0 * PI;
    let mut values = vec![0.0, -0.0, tau, -tau, 2.0 * tau, -2.0 * tau, PI, -PI, 3.0 * PI, f64::NAN, f64::INFINITY, -f64::INFINITY, 1e300, -1e-300];
    for k in -40_000..=40_000 {
        values.push(k as f64 * 1.1e-3 * PI);
        values.push(f64::from_bits((tau).to_bits().wrapping_add_signed(k as i64)));
        values.push(-f64::from_bits((tau).to_bits().wrapping_add_signed(k as i64)));
    }
    for x in values {
        let (want, got) = (x.rem_euclid(tau), wrap_angle(x));
        assert!(want.to_bits() == got.to_bits() || (want.is_nan() && got.is_nan()), "{x}: {want} {got}");
    }
}
