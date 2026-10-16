use mirage_bet::{
    frame::{aggregate, RotorMount, Wrench},
    Vec3,
};
#[test]
fn symmetric_quad_hexa_octo_cancel_yaw_and_lever_moments() {
    for n in [4, 6, 8] {
        let mut mounts = Vec::new();
        let mut loads = Vec::new();
        for i in 0..n {
            let a = std::f64::consts::TAU * i as f64 / n as f64;
            mounts.push(
                RotorMount::new(i, Vec3::new(a.cos(), a.sin(), 0.0), [0.0, 1.0, 0.0, 0.0]).unwrap(),
            );
            loads.push(Wrench {
                force: Vec3::new(0.0, 0.0, 1.0),
                moment: Vec3::new(0.0, 0.0, if i % 2 == 0 { 0.1 } else { -0.1 }),
            });
        }
        let w = aggregate(&mounts, &loads).unwrap();
        assert!((w.force.z + n as f64).abs() < 1e-12);
        assert!(w.moment.norm() < 1e-12);
    }
}
#[test]
fn tilted_axis_and_lever_arm_use_right_hand_rule() {
    let a = std::f64::consts::FRAC_PI_4;
    let m = RotorMount::new(3, Vec3::new(0.0, 1.0, 0.0), [a.cos(), 0.0, a.sin(), 0.0]).unwrap();
    let w = aggregate(
        &[m],
        &[Wrench {
            force: Vec3::new(0.0, 0.0, 2.0),
            moment: Vec3::new(0.0, 0.0, 0.0),
        }],
    )
    .unwrap();
    assert!((w.force.x - 2.0).abs() < 1e-12);
    assert!((w.moment.z + 2.0).abs() < 1e-12);
    assert!(aggregate(&[m, m], &[w, w]).is_err());
}
