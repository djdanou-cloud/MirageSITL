use mirage_bet::{
    frame::{aggregate, RotorMount, Wrench},
    motor::Motor,
    shaft::Shaft,
    Vec3,
};
#[test]
fn cut_power_preserves_passive_spool_decay_and_removed_rotor_changes_lever_moment() {
    let motor = Motor::new(0.1, 0.02, 40.0, 0.1).unwrap();
    let shaft = Shaft::new(0.01, 0.001, 1).unwrap();
    let drive = motor.step(1.0, 1.0, 12.0, 100.0, true, 0.0025).unwrap();
    assert_eq!(drive.torque_nm, 0.0);
    let next = shaft.step(100.0, -0.1, drive.torque_nm, 0.0025).unwrap();
    assert!(next.omega_rad_s > 0.0 && next.omega_rad_s < 100.0);
    let mounts = [
        RotorMount::new(7, Vec3::new(0.0, 1.0, 0.0), [1.0, 0.0, 0.0, 0.0]).unwrap(),
        RotorMount::new(3, Vec3::new(0.0, -1.0, 0.0), [1.0, 0.0, 0.0, 0.0]).unwrap(),
    ];
    let z = Vec3::new(0.0, 0.0, 0.0);
    let w = aggregate(
        &mounts,
        &[
            Wrench {
                force: z,
                moment: z,
            },
            Wrench {
                force: Vec3::new(0.0, 0.0, -5.0),
                moment: z,
            },
        ],
    )
    .unwrap();
    assert_eq!(w.force.z, -5.0);
    assert_eq!(w.moment.x, 5.0);
}
