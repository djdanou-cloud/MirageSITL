//! Independent bound-ABI fixtures and unchanged-output rejection tests.
use mirage_bet::bound;
fn put(b:&mut[u8],p:usize,v:f64){b[p..p+8].copy_from_slice(&v.to_le_bytes());}
fn word(b:&mut[u8],p:usize,v:u32){b[p..p+4].copy_from_slice(&v.to_le_bytes());}
fn get(b:&[u8],p:usize)->f64{f64::from_le_bytes(b[p..p+8].try_into().unwrap())}
#[path="support/bound_fixture.rs"]
mod fixture_data;
use fixture_data::fixture;

#[test]
fn loads_and_transmitted_shaft_reaction_match_closed_form(){
    let(c,mut a,i)=fixture();assert_eq!(bound::init(&c,&mut a,0),0);
    let mut o=[0u8;128];assert_eq!(bound::step(&mut a,&i,&mut o,1.0/400.0),0);
    let initial_thrust=0.5*1.225*30.0*30.0*0.03*0.4*2.0;
    let half_omega=100.0-initial_thrust*0.02*0.3/0.02/800.0;
    let half_induced=(initial_thrust/(2.0*1.225*std::f64::consts::PI*0.25)).sqrt()
        *(1.0-(-1.0f64/800.0/0.1).exp());
    let velocity=(half_omega*0.3).hypot(half_induced);
    let scale=0.5*1.225*velocity*velocity*0.03*0.4*2.0;
    let thrust=scale*(half_omega*0.3-0.02*half_induced)/velocity;
    assert!((get(&o,16)-thrust).abs()<1e-10);
    let q=-scale*0.3*(half_induced+0.02*half_omega*0.3)/velocity;
    assert!((get(&o,80)-q).abs()<1e-10);
    assert!((get(&o,72)-(100.0+q/0.02/400.0)).abs()<1e-10);
    assert!(get(&o,64).abs()<1e-10); // no drive/bearing: shaft absorbs aerodynamic torque
    assert!(get(&o,96)>0.0);
    assert_eq!(bound::reset(&mut a),0);assert_eq!(get(&a,16),100.0);assert_eq!(get(&a,24),0.0);
}
#[test]
fn errors_preserve_output_and_state_and_old_versions_are_rejected(){
    // Configuration version 2 carries the TASK-091 kernel options; 0 and 3 are unknown.
    let(mut c,mut a,mut i)=fixture();let before=a.clone();
    for version in [0,3] {word(&mut c,0,version);assert_eq!(bound::init(&c,&mut a,0),-7);assert_eq!(before,a);}
    word(&mut c,0,1);
    assert_eq!(bound::init(&c,&mut a,0),0);let before=a.clone();let mut o=[0x5au8;128];
    assert_eq!(bound::step(&mut a,&i,&mut o,1.0/800.0),-4);assert_eq!(before,a);assert_eq!(o,[0x5a;128]);
    put(&mut i,104,f64::NAN);assert_eq!(bound::step(&mut a,&i,&mut o,1.0/400.0),-3);
    assert_eq!(before,a);assert_eq!(o,[0x5a;128]);bound::dispose(&mut a);
    assert_eq!(bound::step(&mut a,&i,&mut o,1.0/400.0),-1);
}

#[path = "support/neuralfoil.rs"]
mod neuralfoil;

/// A NACA6409 rotor configuration in the bound layout (16 strips, 8 azimuth samples).
fn naca_config(dt: f64) -> Vec<u8> {
    let p = neuralfoil::naca6409(&[0.0, 0.3]);
    let (radius_m, cutout_m, n) = (0.127, 0.0127, 16usize);
    let width = (radius_m - cutout_m) / n as f64;
    let r: Vec<f64> = (0..n).map(|k| cutout_m + (k as f64 + 0.5) * width).collect();
    let chord: Vec<f64> = r.iter().map(|x| 0.025 - 0.08 * (x - 0.06)).collect();
    let twist: Vec<f64> = r.iter().map(|x| (0.1143 / (2.0 * std::f64::consts::PI * x)).atan()).collect();
    let count = p.alpha.len() * p.re.len() * p.mach.len();
    let mut c = vec![0u8; 128 + (4 * n + p.alpha.len() + p.re.len() + p.mach.len() + 3 * count) * 8];
    let len = c.len() as u32;
    for (at, v) in [(0, 1), (4, len), (8, p.alpha.len() as u32), (12, p.re.len() as u32), (16, p.mach.len() as u32), (20, n as u32), (24, 2), (28, 1), (32, 8)] {
        word(&mut c, at, v);
    }
    for (at, v) in [(40, radius_m), (48, cutout_m), (56, 2.0e-5), (64, 1e-7), (72, dt), (80, 0.0), (88, 0.1), (96, 500.0), (104, 0.9)] {
        put(&mut c, at, v);
    }
    let mut at = 128;
    for values in [&r, &chord, &twist, &vec![width; n], &p.alpha, &p.re, &p.mach, &p.cl, &p.cd, &p.confidence] {
        for v in values.iter() { put(&mut c, at, *v); at += 8; }
    }
    c
}
fn arena_for(c: &[u8]) -> Vec<u8> { let mut a = vec![0u8; 64 + c.len()]; assert_eq!(bound::init(c, &mut a, 0), 0); a }

/// TASK-091 tolerance T1 for one output record: vectors per component within
/// 1e-12 of their norm, scalars within 1e-12 relative (floor 1e-15), flags equal.
fn assert_t1(want: &[u8], got: &[u8], context: &str) {
    let scalar = |a: f64, b: f64| (a - b).abs() <= 1e-12 * a.abs().max(b.abs()) + 1e-15;
    for at in [0, 24, 48] {
        let (a, b) = ([get(want, at), get(want, at + 8), get(want, at + 16)], [get(got, at), get(got, at + 8), get(got, at + 16)]);
        let scale = 1e-12 * a.iter().map(|v| v * v).sum::<f64>().sqrt().max(b.iter().map(|v| v * v).sum::<f64>().sqrt()) + 1e-15;
        assert!((0..3).all(|k| (a[k] - b[k]).abs() <= scale), "{context}: vector at {at}: {a:?} {b:?}");
    }
    for at in [72, 80, 88, 96, 120] { assert!(scalar(get(want, at), get(got, at)), "{context}: scalar at {at}"); }
    assert_eq!(want[112..116], got[112..116], "{context}: flags");
    // Bytes 128.. of a v2 record: the electrical outputs and the validity word.
    for at in (144..want.len()).step_by(8) { assert!(scalar(get(want, at), get(got, at)), "{context}: v2 scalar at {at}"); }
    assert_eq!(want[116..120], got[116..120], "{context}: validity");
}

/// TASK-091: the production step (configuration checked once, fast kernel)
/// against `step_reference` on twin arenas, within the declared T1: 1e5 closed-loop steps from rest
/// in forward flight with body rates and cyclic (1e5 steps at 400 Hz and 2e4
/// at 1200 Hz, which keeps the debug-build test short), then shaft speed and
/// inflow within 1e-9 relative, and outputs within T1 on every step.
#[test]
fn production_step_matches_the_reference_over_a_closed_loop() {
    for (hz, steps) in [(400.0, 100_000), (1200.0, 20_000)] {
        let dt = 1.0 / hz;
        let c = naca_config(dt);
        let (mut fast, mut reference) = (arena_for(&c), arena_for(&c));
        let mut input = vec![0u8; 128];
        word(&mut input, 0, 1);
        for (at, v) in [(8, 1.225), (16, 1.7894e-5), (24, 340.294), (32, 6.0), (40, -1.5), (48, -2.0), (56, 0.4), (64, -0.2), (72, 0.05),
            (80, 0.02), (88, 0.01), (96, -0.015), (104, 0.11)] {
            put(&mut input, at, v);
        }
        let (mut a, mut b) = ([0u8; 128], [0u8; 128]);
        let mut bitwise = 0;
        for step in 0..steps {
            // A slowly varying torque command keeps the shaft and the inflow moving.
            put(&mut input, 104, 0.11 + 0.04 * (step as f64 * 1e-3).sin());
            assert_eq!(bound::step(&mut fast, &input, &mut a, dt), 0);
            assert_eq!(bound::step_reference(&mut reference, &input, &mut b, dt), 0);
            assert_t1(&b, &a, &format!("{hz} Hz step {step}"));
            if a == b { bitwise += 1; }
        }
        for at in [16, 24] {
            let (x, y) = (get(&reference, at), get(&fast, at));
            assert!((x - y).abs() <= 1e-9 * x.abs().max(y.abs()), "{hz} Hz state at {at}: {x} {y}");
        }
        assert!(get(&fast, 16) > 100.0, "the shaft spun up");
        println!("{hz} Hz: {bitwise} of {steps} output records bitwise identical");
        // Without kernel options the production kernel is exact, stricter than T1.
        assert_eq!(bitwise, steps);
    }
}

/// TASK-091: the same comparison for the TASK-092 ESC drive (interface v2 drive mode 1).
#[test]
fn production_esc_step_matches_the_reference_over_a_closed_loop() {
    use mirage_bet::bound_v2;
    let dt = 1.0 / 800.0;
    let c = naca_config(dt);
    let (mut fast, mut reference) = (arena_for(&c), arena_for(&c));
    let mut input = vec![0u8; 256];
    word(&mut input, 0, bound_v2::VERSION);
    word(&mut input, 8, bound_v2::DRIVE_ESC_DUTY);
    for (at, v) in [(16, 1.225), (24, 1.7894e-5), (32, 340.294), (40, 3.0), (48, 0.5), (56, -1.0), (64, 0.1), (72, -0.05), (80, 0.02),
        (88, 0.0), (96, 0.0), (104, 0.0), (128, 16.0), (192, 0.12), (200, 0.0103), (208, 40.0), (216, 40.0), (224, 0.0), (232, 1.0 / 490.0), (240, 1.0 / 490.0)] {
        put(&mut input, at, v);
    }
    let (mut a, mut b) = ([0u8; 256], [0u8; 256]);
    for step in 0..100_000 {
        let duty = 0.45 + 0.3 * (step as f64 * 7e-4).sin();
        put(&mut input, 120, duty);
        // A power cut for a short window exercises the freewheel path.
        word(&mut input, 248, u32::from((40_000..40_400).contains(&step)));
        assert_eq!(bound_v2::step(&mut fast, &input, &mut a, dt), 0, "step {step}");
        assert_eq!(bound_v2::step_reference(&mut reference, &input, &mut b, dt), 0, "step {step}");
        assert_t1(&b, &a, &format!("ESC step {step}"));
    }
    for at in [16, 24, 32, 40, 48] {
        let (x, y) = (get(&reference, at), get(&fast, at));
        assert!((x - y).abs() <= 1e-9 * x.abs().max(y.abs()) + 1e-15, "state at {at}: {x} {y}");
    }
    assert!(get(&fast, 16) > 100.0, "the shaft spun up");
    assert_eq!(a, b, "without kernel options the final records are bitwise identical");
}

/// TASK-091 configuration version 2: the options word is read only there,
/// unknown option bits and a version-1 configuration with a nonzero options
/// word are rejected, and an option-free version 2 steps exactly as version 1.
#[test]
fn configuration_version_two_carries_only_the_known_kernel_options() {
    let dt = 1.0 / 400.0;
    let v1 = naca_config(dt);
    let mut with_options = v1.clone();
    word(&mut with_options, 0, bound::CONFIG_VERSION_OPTIONS);
    for bad in [4u32, 8, 0x8000_0000, 7] {
        word(&mut with_options, 36, bad);
        let mut a = vec![0u8; 64 + v1.len()];
        assert_eq!(bound::init(&with_options, &mut a, 0), -3, "options {bad:#x}");
        assert!(a.iter().all(|b| *b == 0), "a rejected init writes nothing");
    }
    let mut stray = v1.clone();
    word(&mut stray, 36, bound::OPTION_REDUCED_PREDICTOR);
    let mut a = vec![0u8; 64 + v1.len()];
    assert_eq!(bound::init(&stray, &mut a, 0), -3, "version 1 keeps byte 36 reserved");
    word(&mut with_options, 36, 0);
    let (mut a1, mut a2) = (arena_for(&v1), arena_for(&with_options));
    let mut input = vec![0u8; 128];
    word(&mut input, 0, 1);
    for (at, v) in [(8, 1.225), (16, 1.7894e-5), (24, 340.294), (32, 4.0), (56, 0.3), (104, 0.11)] { put(&mut input, at, v); }
    let (mut o1, mut o2) = ([0u8; 128], [0u8; 128]);
    for _ in 0..200 {
        assert_eq!(bound::step(&mut a1, &input, &mut o1, dt), 0);
        assert_eq!(bound::step(&mut a2, &input, &mut o2, dt), 0);
        assert_eq!(o1, o2);
    }
}

/// TASK-091 hover sampling: the state in arena bytes 56..64 follows the
/// regime measure with hysteresis (on below 0.05, off above 0.10), output
/// flag 64 reports it, a corrupt state is refused, and reset clears it.
/// Without the option the bytes must stay zero.
#[test]
fn hover_sampling_follows_the_regime_with_hysteresis() {
    let dt = 1.0 / 400.0;
    let mut c = naca_config(dt);
    word(&mut c, 0, bound::CONFIG_VERSION_OPTIONS);
    word(&mut c, 36, bound::OPTION_HOVER_SAMPLING);
    let mut a = arena_for(&c);
    let mut input = vec![0u8; 128];
    word(&mut input, 0, 1);
    for (at, v) in [(8, 1.225), (16, 1.7894e-5), (24, 340.294), (104, 0.12)] { put(&mut input, at, v); }
    let mut o = [0u8; 128];
    // Spin up in still air: once the shaft turns, the measure is 0 and hover sampling engages.
    for _ in 0..4000 { assert_eq!(bound::step(&mut a, &input, &mut o, dt), 0); }
    let omega = get(&a, 16);
    let tip = omega * 0.127;
    let flag = |o: &[u8; 128]| u32::from_le_bytes(o[112..116].try_into().unwrap()) & bound::FLAG_HOVER_SAMPLING != 0;
    assert!(omega > 100.0 && flag(&o) && get(&a, 56) == 1.0);
    // Between the thresholds it stays on, above 0.10 it leaves, and between them it stays off.
    for (measure, on) in [(0.08, true), (0.12, false), (0.08, false), (0.04, true)] {
        put(&mut input, 32, measure * tip);
        assert_eq!(bound::step(&mut a, &input, &mut o, dt), 0);
        assert_eq!((flag(&o), get(&a, 56)), (on, if on { 1.0 } else { 0.0 }), "measure {measure}");
    }
    // Body rate and cyclic count too.
    put(&mut input, 32, 0.0);
    put(&mut input, 64, 0.2 * get(&a, 16));
    assert_eq!(bound::step(&mut a, &input, &mut o, dt), 0);
    assert!(!flag(&o));
    put(&mut input, 64, 0.0);
    put(&mut input, 88, 0.2);
    assert_eq!(bound::step(&mut a, &input, &mut o, dt), 0);
    assert!(!flag(&o));
    // A state other than 0 or 1 is refused without a change.
    put(&mut a, 56, 0.5);
    let (before, mut untouched) = (a.clone(), [0x5au8; 128]);
    assert_eq!(bound::step(&mut a, &input, &mut untouched, dt), -3);
    assert_eq!((a.clone(), untouched), (before, [0x5au8; 128]));
    assert_eq!(bound::reset(&mut a), 0);
    assert_eq!(get(&a, 56), 0.0);
    // Without the option, a nonzero state byte is refused as before.
    let mut plain = arena_for(&naca_config(dt));
    put(&mut plain, 56, 1.0);
    assert_eq!(bound::step(&mut plain, &input, &mut o, dt), -3);
}

/// TASK-091 opt-in modes against the full reference: in hover the modes
/// change the loads only slightly and leave a closed loop close to the
/// reference; the reduced predictor flags every step.
#[test]
fn opt_in_modes_stay_close_to_the_reference_in_hover_and_forward_flight() {
    let dt = 1.0 / 400.0;
    let mut c = naca_config(dt);
    word(&mut c, 0, bound::CONFIG_VERSION_OPTIONS);
    word(&mut c, 36, bound::OPTION_REDUCED_PREDICTOR | bound::OPTION_HOVER_SAMPLING);
    for (name, air_x, rate) in [("hover", 0.0, 0.0), ("forward", 15.0, 0.4)] {
        let (mut fast, mut reference) = (arena_for(&c), arena_for(&c));
        let mut input = vec![0u8; 128];
        word(&mut input, 0, 1);
        for (at, v) in [(8, 1.225), (16, 1.7894e-5), (24, 340.294), (32, air_x), (56, rate), (104, 0.12)] { put(&mut input, at, v); }
        let (mut a, mut b) = ([0u8; 128], [0u8; 128]);
        let mut worst = 0.0f64;
        for step in 0..20_000 {
            put(&mut input, 104, 0.11 + 0.03 * (step as f64 * 2e-3).sin());
            assert_eq!(bound::step(&mut fast, &input, &mut a, dt), 0);
            assert_eq!(bound::step_reference(&mut reference, &input, &mut b, dt), 0);
            let flags = u32::from_le_bytes(a[112..116].try_into().unwrap());
            assert!(flags & bound::FLAG_REDUCED_PREDICTOR != 0);
            if step > 2000 {
                // Thrust relative to its own magnitude.
                worst = worst.max((get(&a, 16) - get(&b, 16)).abs() / get(&b, 16).abs());
            }
        }
        let (wf, wr) = (get(&fast, 16), get(&reference, 16));
        println!("{name}: worst thrust deviation {worst:.3e}, shaft {wf} vs {wr}");
        // Limits set before the run: thrust within 0.5% and shaft speed within 0.5% in both regimes.
        assert!(worst < 5e-3, "{name}: thrust deviation {worst}");
        assert!((wf - wr).abs() < 5e-3 * wr, "{name}: shaft speed {wf} vs {wr}");
    }
}
