//! TASK-105: the ESC command path against its definitions.
use mirage_bet::esc::{dshot_throttle, dshot_value, pwm_throttle, EscShaper, EscShaperState};

#[test]
fn dshot_carries_2000_throttle_steps_from_48_to_2047() {
    assert_eq!(dshot_value(0.0), Ok(0));
    assert_eq!(dshot_value(1.0), Ok(2047));
    assert_eq!(dshot_value(1e-9), Ok(48));
    // 0.5·1999 = 999.5, rounded away from zero.
    assert_eq!(dshot_value(0.5), Ok(1048));
    assert_eq!(dshot_throttle(1048), 1000.0 / 1999.0);
    assert_eq!(dshot_throttle(30), 0.0);
    for v in 48..=2047u16 { assert_eq!(dshot_value(dshot_throttle(v)), Ok(if v == 48 { 0 } else { v })); }
    assert!(dshot_value(1.5).is_err() && dshot_value(f64::NAN).is_err());
}

#[test]
fn pwm_resolves_to_the_timer_step() {
    assert_eq!(pwm_throttle(1500.4, 1000.0, 2000.0, 1.0), Ok(0.5));
    assert_eq!(pwm_throttle(1503.0, 1000.0, 2000.0, 4.0), Ok(0.504));
    assert_eq!(pwm_throttle(900.0, 1000.0, 2000.0, 1.0), Ok(0.0));
    assert!(pwm_throttle(1500.0, 2000.0, 1000.0, 1.0).is_err());
}

#[test]
fn a_command_arrives_its_latency_in_frames_late_and_is_held_between_frames() {
    // 400 Hz frames, two frames late, stepped at 1600 Hz: four steps a frame.
    let esc = EscShaper::new(1.0 / 400.0, 2, f64::INFINITY, 0.0).unwrap();
    let mut s = EscShaperState::default();
    let dt = 1.0 / 1600.0;
    let mut duties = Vec::new();
    for step in 0..24 { duties.push(esc.step(&mut s, if step >= 4 { 0.6 } else { 0.2 }, dt).unwrap()); }
    // Frames sent at steps 0, 4, 8, ...; the 0.6 sent at step 4 acts from step 12, two frames later.
    assert_eq!(&duties[..4], &[0.0; 4]);
    assert_eq!(&duties[4..8], &[0.0; 4]);
    assert_eq!(&duties[8..12], &[0.2; 4]);
    assert_eq!(&duties[12..], &[0.6; 12]);
}

#[test]
fn the_duty_ramps_at_its_slope_and_a_stopped_motor_starts_only_at_its_start_duty() {
    let esc = EscShaper::new(1.0 / 400.0, 0, 2.0, 0.1).unwrap();
    let mut s = EscShaperState::default();
    let dt = 1.0 / 400.0;
    // Below the start duty nothing turns.
    for _ in 0..10 { assert_eq!(esc.step(&mut s, 0.05, dt).unwrap(), 0.0); }
    // At 2 per second, 0 to 1 takes 0.5 s: 200 steps of 2.5 ms.
    let mut steps = 0;
    while esc.step(&mut s, 1.0, dt).unwrap() < 1.0 { steps += 1; assert!(steps < 1000); }
    assert_eq!(steps + 1, 200);
    // Running, it follows a command below the start duty; a zero stops it.
    for _ in 0..400 { esc.step(&mut s, 0.05, dt).unwrap(); }
    assert!((s.duty - 0.05).abs() < 1e-12 && s.running);
    esc.step(&mut s, 0.0, dt).unwrap();
    assert!(!s.running);
    assert!(EscShaper::new(0.0, 0, 1.0, 0.0).is_err() && EscShaper::new(0.0025, 9, 1.0, 0.0).is_err());
}
