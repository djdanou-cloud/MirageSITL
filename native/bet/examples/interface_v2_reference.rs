//! Native reference for the step interfaces v2 (TASK-088): the WASM parity test
//! sends hex records on stdin and compares the native outputs printed here.
//! Validation tooling, never the step loop; it allocates while parsing.
//!
//! ```text
//! bound <steps> <config hex> <input hex>   -> one output hex line per step
//! body <steps> <input hex>                 -> one output hex line per step;
//!                                             output 0..104 feeds input 96..200
//! bus <steps> <input hex>                  -> one output hex line per step;
//!                                             output charge 0..8 feeds input 48..56
//! ```
//! `bound` also runs drive mode 1 records (TASK-092); `bus` is the TASK-092 shared bus.
use mirage_bet::{body_abi_v2, bound, bound_v2, bus_abi};
use std::io::{self, BufRead, Write};

fn decode(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 { return Err("odd hex length".into()); }
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| e.to_string())).collect()
}
fn encode(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }

fn run(line: &str, out: &mut impl Write) -> Result<(), String> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let steps = |text: &str| text.parse::<usize>().map_err(|e| e.to_string());
    match fields.as_slice() {
        ["bound", n, config, input] => {
            let (config, input) = (decode(config)?, decode(input)?);
            let mut arena = vec![0u8; bound::ARENA_HEADER + config.len()];
            if bound::init(&config, &mut arena, 0) != 0 { return Err("bound init failed".into()); }
            let dt = f64::from_le_bytes(config[72..80].try_into().map_err(|_| "short config")?);
            let mut output = vec![0u8; bound_v2::OUTPUT_BYTES as usize];
            for _ in 0..steps(n)? {
                let status = bound_v2::step(&mut arena, &input, &mut output, dt);
                if status != 0 { return Err(format!("bound step status {status}")); }
                writeln!(out, "{}", encode(&output)).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        ["body", n, input] => {
            let mut input = decode(input)?;
            let mut output = vec![0u8; body_abi_v2::OUTPUT_BYTES as usize];
            for _ in 0..steps(n)? {
                let status = body_abi_v2::step(&input, &mut output, 1.0 / 800.0);
                if status != 0 { return Err(format!("body step status {status}")); }
                writeln!(out, "{}", encode(&output)).map_err(|e| e.to_string())?;
                input[96..200].copy_from_slice(&output[0..104]);
            }
            Ok(())
        }
        ["bus", n, input] => {
            let mut input = decode(input)?;
            let mut output = vec![0u8; bus_abi::OUTPUT_BYTES as usize];
            for _ in 0..steps(n)? {
                let status = bus_abi::step(&input, &mut output, 1.0 / 400.0);
                if status != 0 { return Err(format!("bus step status {status}")); }
                writeln!(out, "{}", encode(&output)).map_err(|e| e.to_string())?;
                input[48..56].copy_from_slice(&output[0..8]);
            }
            Ok(())
        }
        _ => Err(format!("unknown command {:?}", fields.first())),
    }
}

fn main() {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in io::stdin().lock().lines() {
        let result = line.map_err(|e| e.to_string()).and_then(|l| run(&l, &mut out));
        if let Err(message) = result {
            eprintln!("error: {message}");
            std::process::exit(1);
        }
    }
}
