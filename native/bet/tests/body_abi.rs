use mirage_bet::body_abi;
#[test]
fn byte_layout_and_rejection_are_independent_of_rust_object_layout() {
    let mut input = [0_u8; 256];
    let mut out = [0x55; 128];
    for (offset, value) in [
        (0, 1.0_f64),
        (8, 1.0),
        (40, 1.0),
        (72, 1.0),
        (128, 1.0),
        (232, 9.80665),
    ] {
        input[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }
    input[240..244].copy_from_slice(&1_u32.to_le_bytes());
    assert_eq!(body_abi::step(&input, &mut out, 0.0025), 0);
    let v = f64::from_le_bytes(out[40..48].try_into().unwrap());
    assert!((v - 9.80665 * 0.0025).abs() < 1e-15);
    let previous = out;
    input[244] = 1;
    assert_eq!(body_abi::step(&input, &mut out, 0.0025), -3);
    assert_eq!(out, previous);
}
