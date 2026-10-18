use mirage_contact::contact::{CONFIG_COUNT, OUTPUT_COUNT};
use mirage_contact::*;
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
    unsafe {
        let c = sphere();
        std::ptr::copy_nonoverlapping(c.as_ptr(), contact_config_ptr(), CONFIG_COUNT);
        assert_eq!(contact_initialize(), 0);
        assert_eq!(contact_allocator_probe(), 1);
        let input = contact_input_ptr();
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
