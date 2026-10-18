//! Same-source native captures for independent WASM comparison and G1 evidence.
use mirage_contact::contact::{CONFIG_COUNT, OUTPUT_COUNT};
use mirage_contact::*;
fn main() {
    unsafe {
        let capture = std::env::args().any(|x| x == "--capture");
        print!("{{\"schemaVersion\":1,\"cases\":[");
        let mut first = true;
        for hz in [400, 800, 1200] {
            for wheels in [0, 3, 8] {
                let mut c = [0.0; CONFIG_COUNT];
                c[0] = 1.0;
                c[2] = if wheels == 0 { 1.0 } else { 10.0 };
                c[3] = 0.1;
                c[5] = 0.5;
                c[8] = -1.0;
                c[12] = 1.0;
                c[19] = if wheels == 0 { 0.004 } else { 1.0 };
                c[20] = c[19];
                c[21] = c[19];
                c[24] = -1.0;
                c[26] = 9.80665;
                c[27] = wheels as f64;
                for i in 0..wheels {
                    let b = 32 + i * 160;
                    let angle = 2.0 * std::f64::consts::PI * i as f64 / wheels as f64;
                    c[b] = 0.4 * angle.cos();
                    c[b + 1] = 0.4 * angle.sin();
                    c[b + 2] = 0.4;
                    c[b + 3] = 0.2;
                    c[b + 4] = 0.1;
                    c[b + 5] = 0.05;
                    c[b + 6] = 0.15;
                    c[b + 8] = 1000.0;
                    c[b + 10] = 30.0;
                    c[b + 11] = 50.0;
                    c[b + 13] = 0.02;
                    c[b + 14] = 0.5;
                    c[b + 15] = 0.7;
                    c[b + 16] = 10.0;
                    c[b + 17] = 2.0;
                    c[b + 33] = 0.05;
                    c[b + 97] = 1000.0;
                }
                std::ptr::copy_nonoverlapping(c.as_ptr(), contact_config_ptr(), CONFIG_COUNT);
                assert_eq!(contact_initialize(), 0);
                let input = contact_input_ptr();
                for i in 0..16 {
                    input.add(i).write(0.0);
                }
                input.add(14).write(1.0 / hz as f64);
                let steps = if capture { hz * 2 } else { 1_000_000 };
                let mut samples = Vec::new();
                for i in 0..steps {
                    let force = if i % (2 * hz) < hz / 4 {
                        -(c[2] + 0.2 * wheels as f64) * 19.6133
                    } else {
                        0.0
                    };
                    input.add(2).write(force);
                    let status = contact_step();
                    assert_eq!(
                        status,
                        0,
                        "rate={hz} wheels={wheels} tick={i} calls={} bytes={}",
                        contact_allocation_calls(),
                        contact_allocation_bytes()
                    );
                    if i + 1 == hz || i + 1 == 2 * hz {
                        let mut out = [0.0; OUTPUT_COUNT];
                        std::ptr::copy_nonoverlapping(
                            contact_output_ptr(),
                            out.as_mut_ptr(),
                            OUTPUT_COUNT,
                        );
                        samples.push(out);
                    }
                }
                if !first {
                    print!(",");
                }
                first = false;
                print!("{{\"hz\":{hz},\"wheels\":{wheels},\"steps\":{steps},\"allocationCalls\":{},\"allocationBytes\":{},\"config\":[",contact_allocation_calls(),contact_allocation_bytes());
                for (j, v) in c.iter().enumerate() {
                    if j > 0 {
                        print!(",");
                    }
                    print!("{v:.17e}");
                }
                print!("],\"samples\":[");
                for (i, s) in samples.iter().enumerate() {
                    if i > 0 {
                        print!(",");
                    }
                    print!("[");
                    for (j, v) in s.iter().enumerate() {
                        if j > 0 {
                            print!(",");
                        }
                        print!("{v:.17e}");
                    }
                    print!("]");
                }
                print!("]}}");
                contact_dispose();
            }
        }
        println!("]}}");
    }
}
