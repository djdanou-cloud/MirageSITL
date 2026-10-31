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
