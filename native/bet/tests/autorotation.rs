//! Shaft energy and airflow-driven rotor tests. Synthetic polars, not autogyro measurements.
mod support;
use mirage_bet::{
    blade::{Rotor, RotorGeometry, RotorInput},
    polar::PolarTable,
    shaft::Shaft,
    Vec3,
};
use std::f64::consts::PI;
#[test]
fn passive_bearing_energy_decays_and_constant_torque_has_no_governor() {
    let shaft = Shaft::new(0.2, 0.02, 1).unwrap();
    let mut omega = 100.0;
    let mut energy = 1000.0;
    for _ in 0..400 {
        let s = shaft.step(omega, 0.0, 0.0, 0.0025).unwrap();
        assert!(s.energy_j < energy);
        omega = s.omega_rad_s;
        energy = s.energy_j;
    }
    assert!(
        (omega
            - support::number(
                include_str!("../../../tests/fixtures/rotors/free-shaft.json"),
                "omegaRadS"
            ))
        .abs()
            < 1e-10
    );
    let free = Shaft::new(0.2, 0.0, 1).unwrap();
    assert!((free.step(0.0, 2.0, 0.0, 0.0025).unwrap().omega_rad_s - 0.025).abs() < 1e-12);
    assert!(free.step(0.0, -2.0, 0.0, 0.0025).unwrap().reverse_limited);
}
#[test]
fn upward_air_drives_a_free_rotor_and_braking_finds_torque_balance() {
    let r = [0.15, 0.25, 0.35, 0.45];
    let chord = [0.03; 4];
    let twist = [0.0; 4];
    let width = [0.1; 4];
    let polar =
        PolarTable::new(&[-PI, PI], &[1.0, 1e9], &[0.0, 1.0], &[1.0; 8], &[0.2; 8]).unwrap();
    for spin in [-1, 1] {
        let rotor = Rotor::new(
            RotorGeometry {
                blade_count: 2,
                spin_sign: spin,
                radius_m: 0.5,
                cutout_m: 0.1,
                radius: &r,
                chord: &chord,
                twist: &twist,
                width: &width,
            },
            polar,
            16,
        )
        .unwrap();
        let shaft = Shaft::new(0.02, 0.001, spin).unwrap();
        let base = RotorInput {
            density_kg_m3: 1.225,
            viscosity_pa_s: 1.789e-5,
            sound_speed_mps: 340.0,
            air_velocity_hub_mps: Vec3::new(0.0, 0.0, 10.0),
            body_rate_hub_rad_s: Vec3::new(0.0, 0.0, 0.0),
            omega_rad_s: 0.0,
            induced_mps: 0.0,
            collective_rad: 0.1,
            cyclic_cos_rad: 0.0,
            cyclic_sin_rad: 0.0,
        };
        let mut equilibria = [0.0; 3];
        for (index, hz) in [400, 800, 1200].into_iter().enumerate() {
            let mut omega = 0.0;
            for _ in 0..hz * 30 {
                let w = rotor
                    .evaluate(RotorInput {
                        omega_rad_s: omega,
                        ..base
                    })
                    .unwrap();
                omega = shaft
                    .step(omega, w.moment_nm.z, 0.0, 1.0 / hz as f64)
                    .unwrap()
                    .omega_rad_s;
            }
            let q = rotor
                .evaluate(RotorInput {
                    omega_rad_s: omega,
                    ..base
                })
                .unwrap()
                .moment_nm
                .z;
            assert!(omega > 1.0);
            assert!((spin as f64 * q - 0.001 * omega).abs() < 0.01);
            equilibria[index] = omega;
            let fast = rotor
                .evaluate(RotorInput {
                    omega_rad_s: 1000.0,
                    ..base
                })
                .unwrap();
            assert!(spin as f64 * fast.moment_nm.z < 0.0);
            let stopped_flow = rotor
                .evaluate(RotorInput {
                    omega_rad_s: omega,
                    air_velocity_hub_mps: Vec3::new(0.0, 0.0, 0.0),
                    ..base
                })
                .unwrap();
            assert!(
                shaft
                    .step(omega, stopped_flow.moment_nm.z, 0.0, 0.0025)
                    .unwrap()
                    .omega_rad_s
                    < omega
            );
        }
        assert!((equilibria[0] - equilibria[2]).abs() < 0.01);
    }
}
