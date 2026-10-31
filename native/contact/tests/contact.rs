use mirage_contact::contact::{CONFIG_COUNT, OUTPUT_COUNT};
use mirage_contact::*;
/// The ABI owns one process-global session; tests that use it run one at a time.
static ABI: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn sphere() -> [f64; CONFIG_COUNT] {
    let mut c = [0.0; CONFIG_COUNT];
    c[0] = 1.0;
    c[2] = 1.0;
    c[3] = 0.1;
    c[4] = 0.5;
    c[5] = 0.5;
    c[8] = -1.0;
    c[12] = 1.0;
    c[19] = 0.004;
    c[20] = 0.004;
    c[21] = 0.004;
    c[24] = -1.0;
    c[26] = 9.80665;
    c
}
#[test]
fn native_abi_rejects_invalid_frames_and_preserves_single_integration() {
    let _abi = ABI.lock().unwrap();
    unsafe {
        let c = sphere();
        std::ptr::copy_nonoverlapping(c.as_ptr(), contact_config_ptr(), CONFIG_COUNT);
        assert_eq!(contact_initialize(), 0);
        assert_eq!(contact_allocator_probe(), 1);
        let input = contact_input_ptr();
        // The input buffer is process-global: another test may have left per-tick planes in it.
        for i in 0..mirage_contact::contact::INPUT_COUNT {
            input.add(i).write(0.0);
        }
        input.add(14).write(1.0 / 400.0);
        let mut before = [0.0; OUTPUT_COUNT];
        std::ptr::copy_nonoverlapping(contact_output_ptr(), before.as_mut_ptr(), OUTPUT_COUNT);
        input.add(0).write(f64::NAN);
        assert_eq!(contact_step(), -2);
        for i in 0..OUTPUT_COUNT {
            assert_eq!(contact_output_ptr().add(i).read(), before[i]);
        }
        input.add(0).write(0.0);
        for _ in 0..40 {
            assert_eq!(contact_step(), 0);
        }
        let z = contact_output_ptr().add(2).read();
        // Rapier advances once per dt; the exact ballistic position differs only
        // by the documented first-order timestep error, not a second integration.
        assert!((z - (-1.0 + 0.5 * 9.80665 * 0.1 * 0.1)).abs() < 0.002);
        assert_eq!(contact_allocation_calls(), 0.0);
        assert_eq!(contact_allocation_bytes(), 0.0);
        contact_dispose();
        contact_dispose();
        assert_eq!(contact_step(), -1);
        let mut invalid = c;
        invalid[12] = 2.0;
        std::ptr::copy_nonoverlapping(invalid.as_ptr(), contact_config_ptr(), CONFIG_COUNT);
        assert_eq!(contact_initialize(), -2);
    }
}

use mirage_contact::contact::{Contact, INPUT_COUNT, PLANE_BASE, PLANE_SLOTS};
/// Sphere airframe with one linear-strut wheel 0.3 m below the CG (body FRD).
fn with_wheel(normal: [f64; 3]) -> [f64; CONFIG_COUNT] {
    let mut c = sphere();
    c[2] = 10.0;
    c[19] = 0.04;
    c[20] = 0.04;
    c[21] = 0.04;
    c[8] = -0.6;
    c[22] = normal[0];
    c[23] = normal[1];
    c[24] = normal[2];
    c[27] = 1.0;
    let w = 32;
    c[w + 2] = 0.3; // anchor z (down)
    c[w + 3] = 0.5; // unsprung mass
    c[w + 4] = 0.1; // tire radius
    c[w + 5] = 0.06; // rim radius
    c[w + 6] = 0.1; // strut travel
    c[w + 8] = 4000.0; // stiffness N/m
    c[w + 9] = 0.0;
    c[w + 10] = 200.0;
    c[w + 11] = 200.0;
    c[w + 13] = 0.02;
    c[w + 14] = 0.6;
    c[w + 15] = 0.6;
    c[w + 16] = 50.0;
    c[w + 17] = 2.0;
    c[w + 32] = 0.0;
    c[w + 33] = 0.04; // knot covers tire radius minus rim radius
    c[w + 96] = 0.0;
    c[w + 97] = 2000.0;
    c
}
fn slope(angle: f64) -> [f64; 3] {
    // Upward unit normal tilted about East: facing -Down with a North component.
    [angle.sin(), 0.0, -angle.cos()]
}
fn planes(input: &mut [f64; INPUT_COUNT], n: [f64; 3], slots: usize) {
    input[15] = 1.0;
    for slot in 0..PLANE_SLOTS {
        let used = slot < slots;
        for k in 0..3 {
            input[PLANE_BASE + 4 * slot + k] = if used { n[k] } else { 0.0 };
        }
        input[PLANE_BASE + 4 * slot + 3] = 0.0;
    }
}
#[test]
fn per_tick_planes_match_an_equivalent_configured_plane() {
    // Oracle: the same 8-degree slope, either configured statically (v1 path) or
    // supplied every tick over a flat configuration (v2 path), gives the same motion.
    let n = slope(8f64.to_radians());
    let mut configured = Contact::new(&with_wheel(n)).unwrap();
    let mut supplied = Contact::new(&with_wheel([0.0, 0.0, -1.0])).unwrap();
    let mut a = [0.0; INPUT_COUNT];
    a[14] = 1.0 / 400.0;
    let mut b = a;
    planes(&mut b, n, 2);
    let mut max_diff: f64 = 0.0;
    let mut touched = false;
    for _ in 0..800 {
        let oa = configured.step(&a).unwrap();
        let ob = supplied.step(&b).unwrap();
        for k in 0..13 {
            max_diff = max_diff.max((oa[k] - ob[k]).abs());
        }
        // Wheel-to-plane distance diagnostic uses the per-wheel plane.
        assert!((oa[32 + 6] - ob[32 + 6]).abs() < 1e-6);
        touched |= oa[32 + 2] > 0.0;
    }
    assert!(touched, "wheel never loaded the slope");
    assert!(max_diff < 1e-6, "configured vs per-tick plane differ by {max_diff}");
    // The airframe slid downslope (+North on this slope), so the slope was effective.
    let end = configured.step(&a).unwrap();
    assert!(end[0] > 1e-3, "no downslope motion: {}", end[0]);
}
#[test]
fn per_wheel_planes_are_independent_and_rejections_preserve_state() {
    let mut contact = Contact::new(&with_wheel([0.0, 0.0, -1.0])).unwrap();
    let mut input = [0.0; INPUT_COUNT];
    input[14] = 1.0 / 400.0;
    planes(&mut input, [0.0, 0.0, -1.0], 2);
    // Raise only the wheel's ground by 0.05 m (n.x = offset with n = -Down: offset = 0.05).
    input[PLANE_BASE + 4 + 3] = 0.05;
    let out = contact.step(&input).unwrap();
    // Wheel center at down = -0.6 + 0.3 = -0.3 m: height above its plane is 0.25 m, not 0.3 m.
    assert!((out[32 + 6] - 0.25).abs() < 0.01, "{}", out[32 + 6]);
    let bad: [Box<dyn Fn(&mut [f64; INPUT_COUNT])>; 6] = [
        Box::new(|i| i[15] = 2.0),
        Box::new(|i| i[PLANE_BASE] = 0.5),                    // not unit
        Box::new(|i| i[PLANE_BASE + 2] = 1.0),                // faces down
        Box::new(|i| i[PLANE_BASE + 4 * 2 + 2] = -1.0),       // unused wheel slot
        Box::new(|i| i[PLANE_BASE + 3] = f64::INFINITY),
        Box::new(|i| {
            i[15] = 0.0; // v1 path with leftover plane data
        }),
    ];
    for change in bad.iter() {
        let mut i = input;
        change(&mut i);
        assert_eq!(contact.step(&i), Err(-2));
    }
    assert!(contact.step(&input).is_ok());
}
#[test]
fn moving_planes_through_the_abi_never_allocate() {
    // The ABI faults the session on any armed allocation, so every step returning 0
    // is the allocator evidence. Planes change every step at each supported rate.
    let _abi = ABI.lock().unwrap();
    unsafe {
        let c = with_wheel([0.0, 0.0, -1.0]);
        std::ptr::copy_nonoverlapping(c.as_ptr(), contact_config_ptr(), CONFIG_COUNT);
        assert_eq!(contact_initialize(), 0);
        let input = contact_input_ptr();
        let mut buffer = [0.0; INPUT_COUNT];
        for (r, hz) in [400.0, 800.0, 1200.0].iter().enumerate() {
            for step in 0..20_000 {
                buffer[14] = 1.0 / hz;
                let n = slope(((step % 7) as f64 - 3.0).to_radians() * (r as f64 + 1.0));
                planes(&mut buffer, n, 2);
                std::ptr::copy_nonoverlapping(buffer.as_ptr(), input, INPUT_COUNT);
                assert_eq!(contact_step(), 0, "rate {hz} step {step}");
            }
        }
        assert_eq!(contact_allocation_calls(), 0.0);
        assert_eq!(contact_allocation_bytes(), 0.0);
        contact_dispose();
    }
}

// TASK-094: a Rapier-owned airframe with products of inertia (contact configuration
// version 2) against the RK4 body integrator. Budget set before the implementation:
// rates within 2 % and attitude within 0.02 rad after 1 s at 400 Hz; at 1200 Hz at
// most 0.6 of the 400 Hz error (first order); without the products at least five
// times further from RK4.
use mirage_bet::{frame::Wrench, rigid_body::{BodyParameters, BodyState}, Vec3};
use rapier3d_f64::prelude::{Rotation, Vector};

/// Principal moments (0.02, 0.03, 0.045) kg m² turned 0.7 rad about (1, 2, 3): all products non-zero.
fn tensor() -> [f64; 9] {
    let a = [1.0 / 14f64.sqrt(), 2.0 / 14f64.sqrt(), 3.0 / 14f64.sqrt()];
    let (c, s) = ((0.7f64).cos(), (0.7f64).sin());
    // Rodrigues' rotation matrix.
    let r = [
        c + a[0] * a[0] * (1.0 - c), a[0] * a[1] * (1.0 - c) - a[2] * s, a[0] * a[2] * (1.0 - c) + a[1] * s,
        a[1] * a[0] * (1.0 - c) + a[2] * s, c + a[1] * a[1] * (1.0 - c), a[1] * a[2] * (1.0 - c) - a[0] * s,
        a[2] * a[0] * (1.0 - c) - a[1] * s, a[2] * a[1] * (1.0 - c) + a[0] * s, c + a[2] * a[2] * (1.0 - c),
    ];
    let d = [0.02, 0.03, 0.045];
    let mut m = [0.0; 9];
    for i in 0..3 {
        for j in i..3 {
            m[i * 3 + j] = (0..3).map(|k| r[i * 3 + k] * d[k] * r[j * 3 + k]).sum();
            m[j * 3 + i] = m[i * 3 + j];
        }
    }
    m
}
/// Free tumbling body 1 m above the plane, no gravity, body rates (3, 7, 2) rad/s.
fn tumbling(products: bool) -> [f64; CONFIG_COUNT] {
    let mut c = sphere();
    let m = tensor();
    c[0] = if products { 2.0 } else { 1.0 };
    c[2] = 1.5;
    c[26] = 0.0;
    c[16] = 3.0;
    c[17] = 7.0;
    c[18] = 2.0;
    c[19] = m[0];
    c[20] = m[4];
    c[21] = m[8];
    if products {
        c[28] = m[1];
        c[29] = m[2];
        c[30] = m[5];
    }
    c
}
/// Rate (relative) and attitude (rad) errors of a Rapier session against RK4 after 1 s.
fn against_rk4(config: [f64; CONFIG_COUNT], hz: usize) -> (f64, f64) {
    let mut contact = Contact::new(&config).unwrap();
    let mut input = [0.0; INPUT_COUNT];
    input[14] = 1.0 / hz as f64;
    let mut output = [0.0; OUTPUT_COUNT];
    for _ in 0..hz {
        output = contact.step(&input).unwrap();
    }
    let p = BodyParameters::new(1.5, tensor()).unwrap();
    let mut s = BodyState { position: Vec3::new(0.0, 0.0, -1.0), velocity: Vec3::new(0.0, 0.0, 0.0), quaternion: [1.0, 0.0, 0.0, 0.0],
        omega: Vec3::new(3.0, 7.0, 2.0) };
    let zero = Vec3::new(0.0, 0.0, 0.0);
    // The 4800 Hz RK4 solution is the reference.
    for _ in 0..4800 {
        s = p.step(s, Wrench { force: zero, moment: zero }, 0.0, 1.0 / 4800.0).unwrap().state;
    }
    let w = Vec3::new(output[10], output[11], output[12]);
    let rate = w.add(s.omega.scale(-1.0)).norm() / s.omega.norm();
    let dot = (0..4).map(|i| output[6 + i] * s.quaternion[i]).sum::<f64>().abs().min(1.0);
    (rate, 2.0 * dot.acos())
}
#[test]
fn a_rapier_airframe_with_products_of_inertia_matches_rk4_within_budget() {
    let (rate400, angle400) = against_rk4(tumbling(true), 400);
    let (rate1200, _) = against_rk4(tumbling(true), 1200);
    let (diagonal, _) = against_rk4(tumbling(false), 400);
    println!("rate error 400 Hz {rate400:.3e}, 1200 Hz {rate1200:.3e}, attitude {angle400:.3e} rad, without products {diagonal:.3e}");
    assert!(rate400 < 0.02, "rate error {rate400}");
    assert!(angle400 < 0.02, "attitude error {angle400}");
    assert!(rate1200 <= 0.6 * rate400, "1200 Hz {rate1200} against 400 Hz {rate400}");
    assert!(diagonal >= 5.0 * rate400, "without products {diagonal} against {rate400}");
}
#[test]
fn version_2_rejects_an_indefinite_tensor_and_version_1_its_products() {
    let mut c = tumbling(true);
    c[28] = 0.05; // |I_xy| larger than the diagonal allows
    assert!(Contact::new(&c).is_err());
    let mut v1 = tumbling(false);
    v1[28] = 0.001;
    assert!(Contact::new(&v1).is_err());
    let mut v2 = tumbling(true);
    v2[31] = 1.0;
    assert!(Contact::new(&v2).is_err());
    assert!(Contact::new(&tumbling(true)).is_ok());
}

// TASK-095: flight sessions travel. A tumbling body under body-fixed thrust covers
// kilometres; the contact must keep its zero-allocation guarantee all the way.
#[test]
fn a_session_that_travels_kilometres_never_allocates() {
    let _abi = ABI.lock().unwrap();
    unsafe {
        let mut c = tumbling(false);
        c[8] = -1e6;
        c[26] = 9.80665;
        std::ptr::copy_nonoverlapping(c.as_ptr(), contact_config_ptr(), CONFIG_COUNT);
        assert_eq!(contact_initialize(), 0);
        let input = contact_input_ptr();
        for i in 0..INPUT_COUNT {
            input.add(i).write(0.0);
        }
        input.add(2).write(-14.7);
        input.add(3).write(0.001);
        input.add(14).write(1.0 / 1200.0);
        let start = [contact_output_ptr().read(), contact_output_ptr().add(1).read()];
        for k in 0..60_000 {
            assert_eq!(contact_step(), 0, "step {k}");
        }
        let end = [contact_output_ptr().read(), contact_output_ptr().add(1).read()];
        let travel = ((end[0] - start[0]).powi(2) + (end[1] - start[1]).powi(2)).sqrt();
        assert!(travel > 1000.0, "travel {travel} m");
        assert_eq!(contact_allocation_calls(), 0.0);
        contact_dispose();
    }
}

/// Sphere airframe of 1.5 kg on four linear-strut wheels, the synthetic gear of
/// `tests/contact-support.ts` (not a measured aircraft), tire bottoms 1 mm above the plane.
fn quad_gear(impact_mps: f64) -> [f64; CONFIG_COUNT] {
    let mut c = sphere();
    c[2] = 1.5;
    c[3] = 0.1;
    c[4] = 0.0;
    c[8] = -0.501;
    c[11] = impact_mps;
    c[19] = 1.0;
    c[20] = 1.0;
    c[21] = 1.0;
    c[27] = 4.0;
    for i in 0..4 {
        let w = 32 + i * 160;
        let angle = std::f64::consts::FRAC_PI_2 * i as f64;
        c[w] = 0.4 * angle.cos();
        c[w + 1] = 0.4 * angle.sin();
        c[w + 2] = 0.4;
        c[w + 3] = 0.2;
        c[w + 4] = 0.1;
        c[w + 5] = 0.05;
        c[w + 6] = 0.15;
        c[w + 8] = 1000.0;
        c[w + 10] = 30.0;
        c[w + 11] = 50.0;
        c[w + 13] = 0.02;
        c[w + 14] = 0.5;
        c[w + 15] = 0.7;
        c[w + 16] = 10.0;
        c[w + 17] = 2.0;
        c[w + 33] = 0.05;
        c[w + 97] = 1000.0;
    }
    c
}
/// Peak airframe specific force (acceleration minus gravity) in g over 1 s and the
/// final speed, m/s.
fn drop_peak(height_m: f64, hz: usize) -> (f64, f64) {
    let mut contact = Contact::new(&quad_gear((2.0 * 9.80665 * height_m).sqrt())).unwrap();
    let mut input = [0.0; INPUT_COUNT];
    input[14] = 1.0 / hz as f64;
    let mut peak: f64 = 0.0;
    let mut output = [0.0; OUTPUT_COUNT];
    for _ in 0..hz {
        output = contact.step(&input).unwrap();
        let specific = (output[13].powi(2) + output[14].powi(2) + (output[15] - 9.80665).powi(2)).sqrt();
        peak = peak.max(specific / 9.80665);
    }
    (peak, (output[3].powi(2) + output[4].powi(2) + output[5].powi(2)).sqrt())
}
/// Independent oracle: the symmetric vertical drop as one quarter airframe (M/4) over one
/// wheel, the same strut and tire laws, a stiff extension stop, RK4 at 100 kHz. Returns the
/// peak airframe specific force in g over the first 0.1 s.
fn drop_reference(height_m: f64) -> f64 {
    let (g, body, wheel) = (9.80665, 1.5 / 4.0, 0.2);
    let derivative = |s: [f64; 4]| {
        let [zb, vb, zw, vw] = s;
        let x = zb + 0.4 - zw;
        let rate = vb - vw;
        let damping = if rate >= 0.0 { 30.0 } else { 50.0 };
        let strut = if x < 0.0 { 1e6 * x } else { (1000.0 * x + damping * rate).max(0.0) };
        let deflection = zw + 0.1;
        let tire = if deflection > 0.0 { (20000.0 * deflection + 10.0 * vw).max(0.0) } else { 0.0 };
        ([vb, g - strut / body, vw, g + (strut - tire) / wheel], strut / (body * g))
    };
    let v = (2.0 * g * height_m).sqrt();
    let mut s = [-0.501, v, -0.101, v];
    let (h, mut peak) = (1e-5, 0.0f64);
    for _ in 0..10_000 {
        let (k1, _) = derivative(s);
        let at = |k: [f64; 4], f: f64| [s[0] + f * k[0], s[1] + f * k[1], s[2] + f * k[2], s[3] + f * k[3]];
        let (k2, _) = derivative(at(k1, h / 2.0));
        let (k3, _) = derivative(at(k2, h / 2.0));
        let (k4, _) = derivative(at(k3, h));
        for j in 0..4 {
            s[j] += h / 6.0 * (k1[j] + 2.0 * k2[j] + 2.0 * k3[j] + k4[j]);
        }
        peak = peak.max(derivative(s).1);
    }
    peak
}
// TASK-095 requirement, declared before measuring: the drop peak at 400, 800 and
// 1200 Hz stays within 5 % of the three rates' mean and within 5 % of the RK4
// reference, and the airframe comes to rest.
#[test]
fn a_gear_drop_peak_does_not_depend_on_the_step_rate() {
    for height in [0.5, 2.0] {
        let runs = [400, 800, 1200].map(|hz| drop_peak(height, hz));
        let mean = runs.iter().map(|r| r.0).sum::<f64>() / 3.0;
        let reference = drop_reference(height);
        println!("drop {height} m: peaks {:.2} / {:.2} / {:.2} g, RK4 reference {reference:.2} g, final speeds {:.1e} / {:.1e} / {:.1e} m/s",
            runs[0].0, runs[1].0, runs[2].0, runs[0].1, runs[1].1, runs[2].1);
        for (hz, (peak, speed)) in [400, 800, 1200].iter().zip(runs) {
            assert!((peak - mean).abs() <= 0.05 * mean, "{height} m at {hz} Hz: {peak} g against mean {mean} g");
            assert!((peak - reference).abs() <= 0.05 * reference, "{height} m at {hz} Hz: {peak} g against RK4 {reference} g");
            assert!(speed < 0.05, "{height} m at {hz} Hz still moves at {speed} m/s");
        }
    }
}
// An explicit force step diverges once ω·dt > 2. Tires up to 500 times stiffer than the drop
// fixture's (ω·dt up to about 18 at 400 Hz) must land and settle at their static deflection.
#[test]
fn stiff_tires_land_and_settle_at_every_rate() {
    for hz in [400usize, 800, 1200] {
        for stiffness in [2e5, 1e6, 2e6, 1e7] {
            let mut c = quad_gear((2.0 * 9.80665 * 0.5f64).sqrt());
            for i in 0..4 {
                c[32 + i * 160 + 97] = stiffness * 0.05;
            }
            let mut contact = Contact::new(&c).unwrap();
            let mut input = [0.0; INPUT_COUNT];
            input[14] = 1.0 / hz as f64;
            let (mut speed, mut low, mut high) = (0.0f64, f64::MAX, 0.0f64);
            for k in 0..3 * hz {
                let o = contact.step(&input).unwrap();
                if k >= 3 * hz - hz / 4 {
                    speed = speed.max((o[3].powi(2) + o[4].powi(2) + o[5].powi(2)).sqrt());
                    low = low.min(o[33]);
                    high = high.max(o[33]);
                }
            }
            // Each tire carries a quarter of the airframe and its own wheel.
            let expected = (1.5 / 4.0 + 0.2) * 9.80665 / stiffness;
            assert!(speed < 1e-6, "{hz} Hz, {stiffness} N/m: {speed} m/s in the last 0.25 s");
            assert!((low - expected).abs() < 0.01 * expected && (high - expected).abs() < 0.01 * expected,
                "{hz} Hz, {stiffness} N/m: deflection {low}..{high} m, expected {expected} m");
        }
    }
}

// TASK-095 increment 2b: static friction below breakaway, Coulomb friction above, and the
// brush tire. Tolerances declared before measuring; every oracle is analytic.
const G: f64 = 9.80665;
/// `quad_gear` resting 1 mm above a plane tilted by `slope_rad` about East (downslope is
/// North), the airframe pitched to match and yawed by `yaw_rad`, moving at `velocity`.
fn quad_on_slope(slope_rad: f64, yaw_rad: f64, velocity: [f64; 3]) -> [f64; CONFIG_COUNT] {
    let mut c = quad_gear(0.0);
    let n = slope(slope_rad);
    c[22] = n[0];
    c[23] = n[1];
    c[24] = n[2];
    for k in 0..3 {
        c[6 + k] = n[k] * 0.501;
        c[9 + k] = velocity[k];
    }
    // Pitch about East by -slope (body up onto the normal), then yaw about the normal.
    let pitch = Rotation::from_axis_angle(Vector::Y, -slope_rad);
    let q = Rotation::from_axis_angle(Vector::new(-n[0], -n[1], -n[2]), yaw_rad) * pitch;
    c[12] = q.w;
    c[13] = q.x;
    c[14] = q.y;
    c[15] = q.z;
    c
}
fn run(c: &[f64; CONFIG_COUNT], hz: usize, brakes: f64, seconds: f64, mut each: impl FnMut(usize, &[f64; OUTPUT_COUNT])) {
    let mut contact = Contact::new(c).unwrap();
    let mut input = [0.0; INPUT_COUNT];
    input[14] = 1.0 / hz as f64;
    for i in 0..4 {
        input[6 + i] = brakes;
    }
    for k in 0..(seconds * hz as f64).round() as usize {
        let o = contact.step(&input).unwrap();
        each(k, &o);
    }
}
fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}
#[test]
fn a_braked_or_side_on_aircraft_holds_a_slope_without_creep() {
    for hz in [400, 800, 1200] {
        // Braked nose-down (mu 0.7) and side-on unbraked (lateral mu 0.5), both above tan 10 deg.
        for (yaw, brakes) in [(0.0, 1.0), (std::f64::consts::FRAC_PI_2, 0.0)] {
            let (mut settled, mut last) = ([0.0; 3], [0.0; 3]);
            run(&quad_on_slope(10f64.to_radians(), yaw, [0.0; 3]), hz, brakes, 7.0, |k, o| {
                if k + 1 == 2 * hz {
                    settled = [o[0], o[1], o[2]];
                }
                last = [o[0], o[1], o[2]];
            });
            let creep = distance(settled, last);
            println!("hold {hz} Hz, yaw {yaw:.2}, brakes {brakes}: creep {creep:.2e} m in 5 s");
            assert!(creep < 1e-3, "{hz} Hz, yaw {yaw}, brakes {brakes}: {creep} m in 5 s");
        }
    }
}
#[test]
fn rolling_and_braked_sliding_follow_coulomb_down_the_slope() {
    for hz in [400, 800, 1200] {
        // Unbraked on 10 deg: rolling resistance 0.02. Braked on 40 deg: past breakaway (0.84 > 0.7).
        for (degrees, brakes, mu) in [(10.0f64, 0.0, 0.02), (40.0, 1.0, 0.7)] {
            let a = degrees.to_radians();
            let down = [a.cos(), 0.0, a.sin()];
            let mut v = [0.0; 2];
            run(&quad_on_slope(a, 0.0, [0.0; 3]), hz, brakes, 2.0, |k, o| {
                let along = o[3] * down[0] + o[4] * down[1] + o[5] * down[2];
                if k + 1 == hz {
                    v[0] = along;
                }
                v[1] = along;
            });
            let measured = v[1] - v[0];
            let expected = G * (a.sin() - mu * a.cos());
            println!("slope {hz} Hz, {degrees} deg, brakes {brakes}: {measured:.4} m/s2, Coulomb {expected:.4}");
            assert!((measured - expected).abs() < 0.05 * expected, "{hz} Hz, {degrees} deg: {measured} m/s2 against {expected}");
        }
    }
}
#[test]
fn a_sideways_slide_stops_at_the_coulomb_distance_and_stays() {
    for hz in [400, 800, 1200] {
        let (mut start, mut stop, mut speed) = ([0.0; 3], [0.0; 3], 0.0f64);
        // The stop leaves the airframe rocking on its struts, decaying about tenfold per 0.5 s
        // at every rate; "stays" is checked once that has died out.
        run(&quad_on_slope(0.0, 0.0, [0.0, 2.0, 0.0]), hz, 0.0, 4.0, |k, o| {
            if k == 0 {
                start = [o[0], o[1], 0.0];
            }
            stop = [o[0], o[1], 0.0];
            if k >= 4 * hz - hz / 4 {
                speed = speed.max((o[3].powi(2) + o[4].powi(2)).sqrt());
            }
        });
        let travelled = distance(start, stop);
        let expected = 4.0 / (2.0 * 0.5 * G);
        println!("slide {hz} Hz: {travelled:.4} m against {expected:.4} m, final speed {speed:.1e} m/s");
        assert!((travelled - expected).abs() < 0.05 * expected, "{hz} Hz: {travelled} m against {expected} m");
        assert!(speed < 1e-6, "{hz} Hz: still sliding at {speed} m/s");
    }
}
#[test]
fn the_brush_tire_decays_a_small_side_velocity_like_the_linear_model() {
    for hz in [400, 800, 1200] {
        let mut c = quad_on_slope(0.0, 0.0, [5.0, 0.05, 0.0]);
        c[0] = 3.0;
        for i in 0..4 {
            c[32 + i * 160 + 28] = 20.0; // cornering stiffness, N/rad
        }
        let mut lateral = 0.0;
        run(&c, hz, 0.0, 0.3, |_, o| lateral = o[4]);
        // m dv_y/dt = -sum(C_a) v_y / v_x with v_x = v0 - mu_r g t: a closed form.
        let (k, b) = (4.0 * 20.0 / 2.3, 0.02 * G);
        let expected = 0.05 * ((5.0 - b * 0.3) / 5.0f64).powf(k / b);
        println!("brush {hz} Hz: {lateral:.4e} m/s against {expected:.4e} m/s");
        assert!((lateral - expected).abs() < 0.05 * expected, "{hz} Hz: {lateral} m/s against {expected} m/s");
    }
}
#[test]
fn version_3_alone_accepts_a_cornering_stiffness() {
    let mut c = quad_gear(0.0);
    c[32 + 28] = 20.0;
    assert!(Contact::new(&c).is_err());
    c[0] = 3.0;
    assert!(Contact::new(&c).is_ok());
    c[32 + 28] = -1.0;
    assert!(Contact::new(&c).is_err());
    c[32 + 28] = 20.0;
    c[32 + 29] = 1.0;
    assert!(Contact::new(&c).is_err());
}
