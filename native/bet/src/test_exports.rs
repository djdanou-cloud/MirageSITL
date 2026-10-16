//! Feature-gated numerical harness; never included by the production build script.
use crate::{
    blade::{Rotor, RotorGeometry, RotorInput},
    flapping::{FlapState, HingeModel},
    inflow::AxialInflow,
    momentum::{angular_momentum, transmitted_moment},
    polar::PolarTable,
    shaft::Shaft,
    Vec3,
};
/// Constant-polar annulus test: kind 0 thrust, 1 signed air shaft torque.
#[no_mangle]
pub extern "C" fn bet_test_blade(stations: u32, azimuth: u32, spin: i32, kind: u32) -> f64 {
    let n = stations as usize;
    if n == 0 || n > 64 {
        return f64::NAN;
    }
    let mut radius = [0.0; 64];
    let chord = [0.03; 64];
    let twist = [0.0; 64];
    let mut width = [0.0; 64];
    for k in 0..n {
        width[k] = 0.4 / n as f64;
        radius[k] = 0.1 + (k as f64 + 0.5) * width[k];
    }
    let polar = PolarTable::new(
        &[-3.15, 3.15],
        &[1.0, 1e9],
        &[0.0, 1.0],
        &[1.0; 8],
        &[0.02; 8],
    )
    .unwrap();
    let rotor = match Rotor::new(
        RotorGeometry {
            blade_count: 2,
            spin_sign: spin,
            radius_m: 0.5,
            cutout_m: 0.1,
            radius: &radius[..n],
            chord: &chord[..n],
            twist: &twist[..n],
            width: &width[..n],
        },
        polar,
        azimuth as usize,
    ) {
        Ok(r) => r,
        Err(_) => return f64::NAN,
    };
    let zero = Vec3::new(0.0, 0.0, 0.0);
    let w = rotor
        .evaluate(RotorInput {
            density_kg_m3: 1.225,
            viscosity_pa_s: 1.789e-5,
            sound_speed_mps: 340.0,
            air_velocity_hub_mps: zero,
            body_rate_hub_rad_s: zero,
            omega_rad_s: 100.0,
            induced_mps: 0.0,
            collective_rad: 0.1,
            cyclic_cos_rad: 0.0,
            cyclic_sin_rad: 0.0,
        })
        .unwrap();
    match kind {
        0 => w.force_n.z,
        1 => w.moment_nm.z,
        _ => f64::NAN,
    }
}
/// case 0 inflow, 1 passive shaft, 2 hinge oscillator, 3 momentum transmission.
#[no_mangle]
pub extern "C" fn bet_test_dynamics(case: u32, steps: u32, dt: f64) -> f64 {
    if !dt.is_finite() || dt <= 0.0 || dt > 0.01 || steps > 2_000_000 {
        return f64::NAN;
    }
    match case {
        0 => {
            let model = AxialInflow::new(1.225, 0.5, 0.1, 50.0).unwrap();
            let mut v = 0.0;
            for _ in 0..steps {
                v = model.step(v, 100.0, 0.0, 0.0, dt).unwrap().velocity_mps;
            }
            v
        }
        1 => {
            let model = Shaft::new(0.2, 0.02, 1).unwrap();
            let mut v = 100.0;
            for _ in 0..steps {
                v = model.step(v, 0.0, 0.0, dt).unwrap().omega_rad_s;
            }
            v
        }
        2 => {
            let model = HingeModel::new(1.0, 100.0, 0.0, 1, 0.2).unwrap();
            let z = Vec3::new(0.0, 0.0, 0.0);
            let mut s = FlapState {
                angle: Vec3::new(0.1, 0.0, 0.0),
                rate: z,
            };
            for _ in 0..steps {
                s = model.step(s, z, 0.0, 0.0, dt).unwrap().state;
            }
            s.angle.x
        }
        3 => {
            let z = Vec3::new(0.0, 0.0, 0.0);
            let f = FlapState { angle: z, rate: z };
            let before = angular_momentum(0.2, 1, 100.0, f).unwrap();
            let after = angular_momentum(0.2, 1, 101.0, f).unwrap();
            transmitted_moment(z, before, after, z, dt).unwrap().z
        }
        _ => f64::NAN,
    }
}

/// Experimental coaxial fixture harness; not a production ABI export.
#[no_mangle]
pub extern "C" fn bet_test_coaxial(
    separation: f64,
    overlap: f64,
    enabled: u32,
    quantity: u32,
    iterations: u32,
) -> f64 {
    use crate::coaxial::{CoaxialWake, WakePair};
    if iterations == 0 || iterations > 1_000_000 || enabled > 1 {
        return f64::NAN;
    }
    let model = match CoaxialWake::new(
        WakePair {
            upper_id: 1,
            lower_id: 2,
            separation_m: separation,
            overlap,
            source_radius_m: 0.5,
            receiver_radius_m: 0.5,
            spread_half_angle_rad: 0.1,
            enabled: enabled == 1,
        },
        1.225,
    ) {
        Ok(m) => m,
        Err(_) => return f64::NAN,
    };
    let mut value = 0.0;
    for k in 0..iterations {
        let thrust = std::hint::black_box(100.0 + (k & 1) as f64);
        let r = match model.evaluate(thrust) {
            Ok(r) => r,
            Err(_) => return f64::NAN,
        };
        value = match quantity {
            0 => r.air_velocity_delta_hub_mps.z,
            1 => r.source_power_w,
            2 => r.received_power_w,
            3 => r.mixing_loss_w,
            4 => r.received_momentum_n,
            5 => r.bypass_power_w,
            6 => r.bypass_momentum_n,
            _ => return f64::NAN,
        };
    }
    value
}

/// Propulsion/frame analytical harness; kind 0 motor duty, 1 battery current, 2 frame force.
#[no_mangle]
pub extern "C" fn bet_test_propulsion(kind: u32) -> f64 {
    match kind {
        0 => {
            let m = crate::motor::Motor::new(0.2, 0.02, 10.0, 0.1).unwrap();
            let mut duty = 0.0;
            for _ in 0..400 {
                duty = m.step(duty, 1.0, 12.0, 100.0, false, 0.0025).unwrap().duty;
            }
            duty
        }
        1 => {
            crate::battery::Battery::new(12.0, 12.0, 0.1, 3600.0, 100.0)
                .unwrap()
                .step(1.0, &[50.0, 60.0], 0.0, 0.0025)
                .unwrap()
                .current_a
        }
        2 => {
            let a = std::f64::consts::FRAC_PI_4;
            let mount = crate::frame::RotorMount::new(
                0,
                Vec3::new(0.0, 1.0, 0.0),
                [a.cos(), 0.0, a.sin(), 0.0],
            )
            .unwrap();
            crate::frame::aggregate(
                &[mount],
                &[crate::frame::Wrench {
                    force: Vec3::new(0.0, 0.0, 2.0),
                    moment: Vec3::new(0.0, 0.0, 0.0),
                }],
            )
            .unwrap()
            .force
            .x
        }
        _ => f64::NAN,
    }
}
