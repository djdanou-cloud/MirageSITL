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

/// Synthetic compliance harness: kinds 0..2 gas load/energy/loss, 3..5 tire
/// load/energy/loss, 6 linear-strut load, 7 ground friction X, 8 moment X.
/// For count>1, compression alternates x and x+0.001 m. No body integration.
#[no_mangle]
pub extern "C" fn bet_test_landing(kind: u32, x: f64, rate: f64, count: u32) -> f64 {
    use crate::landing_gear::{Damping, DampingLaw, GasStrut, LinearStrut, TireCurve, ground_wrench};
    if count == 0 || count > 1_000_000 || kind > 8 { return f64::NAN; }
    let gas = GasStrut::new(0.01,0.01,300_000.0,100_000.0,1.0,0.5,
        0.005,850.0,0.7,0.0001,0.00005).unwrap();
    let xs = [0.0,0.01,0.03]; let loads = [0.0,100.0,500.0];
    let tire = TireCurve::new(&xs,&loads,50.0).unwrap();
    let linear = LinearStrut::new(1000.0,10.0,0.5,Damping::new(100.0,200.0,DampingLaw::Linear).unwrap()).unwrap();
    let mut value = 0.0;
    for i in 0..count {
        let compression = x + if count > 1 { (i & 1) as f64 * 0.001 } else { 0.0 };
        let r = if kind < 3 { gas.evaluate(compression,rate) }
            else if kind < 6 { tire.evaluate(compression,rate) }
            else { linear.evaluate(compression,rate) };
        let Ok(result) = r else { return f64::NAN; };
        value = match kind {
            0 | 3 | 6 => result.load_n,
            1 | 4 => result.stored_energy_j,
            2 | 5 => result.dissipation_w,
            7 | 8 => {
                let Ok(w) = ground_wrench(Vec3::new(0.0,1.0,1.0),[1.0,0.0,0.0,0.0],
                    Vec3::new(0.0,0.0,-1.0),100.0,Vec3::new(rate,0.0,0.0),0.5,0.1)
                    else { return f64::NAN; };
                if kind == 7 { w.force.x } else { w.moment.x }
            }
            _ => return f64::NAN,
        };
        std::hint::black_box(value);
    }
    value
}
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
/// TASK-091 increment 3: the default rotor kernel (`Rotor::evaluate_sampled`
/// at stride 1) against the scalar reference (`Rotor::evaluate`) inside this
/// WASM build, so the scalar and SIMD128 builds each check the strip pass and
/// its tails. A synthetic polar (25 irregular alpha nodes over +-0.5 rad, six
/// Reynolds and two Mach nodes, some low-confidence cells) and a tapered,
/// twisted rotor of `stations` strips are evaluated over 96 states (both spin
/// directions, stopped and spinning shafts, axial, edgewise and oblique flow,
/// body rates and cyclic). Returns the largest T1 ratio
/// |a - b| / (1e-12 max(|a|, |b|) + 1e-15) over every vector component (at most
/// 1 passes), or +inf when the flags or the error status differ.
#[no_mangle]
pub extern "C" fn bet_test_kernel_t1(stations: u32, azimuth: u32) -> f64 {
    const NA: usize = 25;
    const NR: usize = 6;
    const COUNT: usize = NA * NR * 2;
    let n = stations as usize;
    if n == 0 || n > 64 {
        return f64::NAN;
    }
    let mut alpha = [0.0; NA];
    for (k, a) in alpha.iter_mut().enumerate() {
        *a = -0.5 + k as f64 / (NA - 1) as f64 + 0.004 * (k as f64).sin();
    }
    let reynolds = [1e3, 3e3, 2e4, 1e5, 4e5, 1e6];
    let mach = [0.0, 0.3];
    let (mut cl, mut cd, mut confidence) = ([0.0; COUNT], [0.0; COUNT], [0.0; COUNT]);
    for m in 0..2 {
        for r in 0..NR {
            for a in 0..NA {
                let at = (m * NR + r) * NA + a;
                let x = alpha[a];
                cl[at] = 5.7 * x / (1.0 + 4.0 * x * x) * (1.0 + 0.02 * r as f64) * (1.0 + 0.1 * m as f64);
                cd[at] = 0.01 + 0.4 * x * x + 0.05 / (1.0 + r as f64);
                confidence[at] = if (a + 3 * r + m) % 11 == 0 { 0.5 } else { 0.95 };
            }
        }
    }
    let Ok(polar) = PolarTable::new(&alpha, &reynolds, &mach, &cl, &cd).and_then(|p| p.with_confidence(&confidence, 0.9)) else {
        return f64::NAN;
    };
    let (radius_m, cutout_m) = (0.127, 0.0127);
    let (mut radius, mut chord, mut twist, mut width) = ([0.0; 64], [0.0; 64], [0.0; 64], [0.0; 64]);
    for k in 0..n {
        width[k] = (radius_m - cutout_m) / n as f64;
        radius[k] = cutout_m + (k as f64 + 0.5) * width[k];
        chord[k] = 0.025 - 0.08 * (radius[k] - 0.06);
        twist[k] = (0.1143 / (2.0 * std::f64::consts::PI * radius[k])).atan();
    }
    let mut worst = 0.0f64;
    for spin in [1, -1] {
        let geometry = RotorGeometry {
            blade_count: 2, spin_sign: spin, radius_m, cutout_m,
            radius: &radius[..n], chord: &chord[..n], twist: &twist[..n], width: &width[..n],
        };
        let Ok(rotor) = Rotor::new(geometry, polar, azimuth as usize) else { return f64::NAN };
        for omega in [0.0, 150.0, 900.0] {
            for induced in [-0.5, 2.5] {
                for air in [Vec3::new(0.0, 0.0, 0.0), Vec3::new(0.3 * 530.0 * radius_m, 0.0, 0.0), Vec3::new(-4.0, 6.0, 0.0), Vec3::new(0.0, 0.0, -8.0)] {
                    for (rate, cyclic) in [(Vec3::new(0.0, 0.0, 0.0), (0.0, 0.0)), (Vec3::new(2.0, -3.0, 0.5), (0.05, -0.08))] {
                        let input = RotorInput {
                            density_kg_m3: 1.225, viscosity_pa_s: 1.7894e-5, sound_speed_mps: 340.294,
                            air_velocity_hub_mps: air, body_rate_hub_rad_s: rate, omega_rad_s: omega, induced_mps: induced,
                            collective_rad: 0.1, cyclic_cos_rad: cyclic.0, cyclic_sin_rad: cyclic.1,
                        };
                        match (rotor.evaluate(input), rotor.evaluate_sampled(input, 1)) {
                            (Ok(a), Ok(b)) => {
                                if a.flags != b.flags {
                                    return f64::INFINITY;
                                }
                                for (x, y) in [(a.force_n, b.force_n), (a.moment_nm, b.moment_nm), (a.flap_load_nm, b.flap_load_nm)] {
                                    let scale = 1e-12 * x.norm().max(y.norm()) + 1e-15;
                                    for d in [x.x - y.x, x.y - y.y, x.z - y.z] {
                                        worst = worst.max(d.abs() / scale);
                                    }
                                }
                            }
                            (Err(_), Err(_)) => {}
                            _ => return f64::INFINITY,
                        }
                    }
                }
            }
        }
    }
    worst
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
