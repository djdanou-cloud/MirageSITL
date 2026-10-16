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
