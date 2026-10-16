//! Synthetic top-hat wake: independent conservation and decoupling oracles.
mod support;
use mirage_bet::{
    blade::{Rotor, RotorGeometry, RotorInput},
    coaxial::{CoaxialWake, WakePair},
    polar::PolarTable,
    Vec3,
};
fn pair() -> WakePair {
    WakePair {
        upper_id: 1,
        lower_id: 2,
        separation_m: 0.5,
        overlap: 0.75,
        source_radius_m: 0.5,
        receiver_radius_m: 0.5,
        spread_half_angle_rad: 0.1,
        enabled: true,
    }
}
#[test]
fn matches_registered_independent_flux_fixture() {
    let fixture = include_str!("../../../tests/fixtures/rotors/coaxial.json");
    let model = CoaxialWake::new(pair(), 1.225).unwrap();
    let r = model.evaluate(100.0).unwrap();
    for (key, actual) in [
        ("launchSpeedMps", r.launch_speed_mps),
        ("wakeSpeedMps", r.wake_speed_mps),
        ("receiverDeltaZMps", r.air_velocity_delta_hub_mps.z),
        ("sourcePowerW", r.source_power_w),
        ("receivedPowerW", r.received_power_w),
        ("mixingLossW", r.mixing_loss_w),
        ("receivedMomentumN", r.received_momentum_n),
    ] {
        assert!(
            (actual - support::number(fixture, key)).abs() < 1e-9,
            "{key}: {actual}"
        );
    }
    assert!(r.experimental);
    assert_eq!(r.air_velocity_delta_hub_mps.x, 0.0);
    assert_eq!(r.air_velocity_delta_hub_mps.y, 0.0);
    assert!(r.air_velocity_delta_hub_mps.z < 0.0);
}
#[test]
fn disabled_and_zero_overlap_leave_the_receiver_rotor_exactly_independent() {
    let zero = Vec3::new(0.0, 0.0, 0.0);
    let polar = PolarTable::new(
        &[-3.15, 3.15],
        &[1.0, 1e9],
        &[0.0, 1.0],
        &[0.2; 8],
        &[0.02; 8],
    )
    .unwrap();
    let rotor = Rotor::new(
        RotorGeometry {
            blade_count: 2,
            spin_sign: -1,
            radius_m: 0.5,
            cutout_m: 0.1,
            radius: &[0.3],
            chord: &[0.03],
            twist: &[0.0],
            width: &[0.4],
        },
        polar,
        32,
    )
    .unwrap();
    let input = RotorInput {
        density_kg_m3: 1.225,
        viscosity_pa_s: 1.8e-5,
        sound_speed_mps: 340.0,
        air_velocity_hub_mps: zero,
        body_rate_hub_rad_s: zero,
        omega_rad_s: 100.0,
        induced_mps: 0.0,
        collective_rad: 0.1,
        cyclic_cos_rad: 0.0,
        cyclic_sin_rad: 0.0,
    };
    let independent = rotor.evaluate(input).unwrap();
    for p in [
        WakePair {
            enabled: false,
            ..pair()
        },
        WakePair {
            overlap: 0.0,
            ..pair()
        },
    ] {
        let wake = CoaxialWake::new(p, 1.225).unwrap().evaluate(100.0).unwrap();
        assert_eq!(wake.air_velocity_delta_hub_mps, zero);
        assert_eq!(wake.received_power_w, 0.0);
        assert_eq!(
            rotor
                .evaluate(RotorInput {
                    air_velocity_hub_mps: input
                        .air_velocity_hub_mps
                        .add(wake.air_velocity_delta_hub_mps),
                    ..input
                })
                .unwrap(),
            independent
        );
    }
    let far = CoaxialWake::new(
        WakePair {
            separation_m: 1e8,
            ..pair()
        },
        1.225,
    )
    .unwrap()
    .evaluate(100.0)
    .unwrap();
    let far_wrench = rotor
        .evaluate(RotorInput {
            air_velocity_hub_mps: far.air_velocity_delta_hub_mps,
            ..input
        })
        .unwrap();
    assert!(
        far_wrench
            .force_n
            .add(independent.force_n.scale(-1.0))
            .norm()
            < 1e-6
    );
    assert!(
        far_wrench
            .moment_nm
            .add(independent.moment_nm.scale(-1.0))
            .norm()
            < 1e-6
    );
    let active = CoaxialWake::new(pair(), 1.225)
        .unwrap()
        .evaluate(100.0)
        .unwrap();
    assert_ne!(
        rotor
            .evaluate(RotorInput {
                air_velocity_hub_mps: active.air_velocity_delta_hub_mps,
                ..input
            })
            .unwrap(),
        independent
    );
}
#[test]
fn budgets_close_for_overlap_thrust_and_separation_and_far_field_decouples() {
    for separation in [0.0, 0.5, 10.0, 1e8] {
        for overlap in [0.0, 0.25, 1.0] {
            for thrust in [0.0, 1e-12, 1.0, 1000.0] {
                let r = CoaxialWake::new(
                    WakePair {
                        separation_m: separation,
                        overlap,
                        ..pair()
                    },
                    1.225,
                )
                .unwrap()
                .evaluate(thrust)
                .unwrap();
                assert!((r.received_momentum_n + r.bypass_momentum_n - thrust).abs() < 1e-9);
                assert!(
                    (r.received_power_w + r.bypass_power_w + r.mixing_loss_w - r.source_power_w)
                        .abs()
                        < 1e-9
                );
                assert!(
                    r.mixing_loss_w >= 0.0 && r.received_power_w >= 0.0 && r.bypass_power_w >= 0.0
                );
                if separation == 1e8 {
                    assert!(r.air_velocity_delta_hub_mps.norm() < 1e-5);
                }
            }
        }
    }
    // Exercise scales beyond the fixture while keeping launch speed 20 m/s.
    for radius in [0.001, 0.5, 100.0] {
        for rho in [0.05, 2.0] {
            let p = WakePair {
                source_radius_m: radius,
                receiver_radius_m: 0.001,
                separation_m: 1e9,
                overlap: 1.0,
                ..pair()
            };
            let thrust = rho * std::f64::consts::PI * radius * radius * 200.0;
            let r = CoaxialWake::new(p, rho).unwrap().evaluate(thrust).unwrap();
            assert!(
                (r.received_power_w + r.bypass_power_w + r.mixing_loss_w - r.source_power_w).abs()
                    <= 1e-9 + 1e-12 * r.source_power_w
            );
            assert!(
                (r.received_momentum_n + r.bypass_momentum_n - thrust).abs()
                    <= 1e-9 + 1e-12 * thrust
            );
        }
    }
    let near = CoaxialWake::new(pair(), 1.225)
        .unwrap()
        .evaluate(100.0)
        .unwrap();
    let half = CoaxialWake::new(
        WakePair {
            overlap: 0.375,
            ..pair()
        },
        1.225,
    )
    .unwrap()
    .evaluate(100.0)
    .unwrap();
    assert!((half.received_power_w * 2.0 - near.received_power_w).abs() < 1e-9);
}
#[test]
fn rejects_unsupported_geometry_regimes_and_nonfinite_values() {
    for p in [
        WakePair {
            lower_id: 1,
            ..pair()
        },
        WakePair {
            separation_m: -1.0,
            ..pair()
        },
        WakePair {
            overlap: 1.1,
            ..pair()
        },
        WakePair {
            overlap: f64::NAN,
            ..pair()
        },
        WakePair {
            source_radius_m: 0.0,
            ..pair()
        },
        WakePair {
            spread_half_angle_rad: 0.0,
            ..pair()
        },
        WakePair {
            spread_half_angle_rad: 1.0,
            ..pair()
        },
    ] {
        assert!(CoaxialWake::new(p, 1.225).is_err());
    }
    assert!(CoaxialWake::new(pair(), 0.0).is_err());
    let model = CoaxialWake::new(pair(), 1.225).unwrap();
    for thrust in [-1.0, f64::NAN, f64::INFINITY, 1e9] {
        assert!(model.evaluate(thrust).is_err());
    }
}
