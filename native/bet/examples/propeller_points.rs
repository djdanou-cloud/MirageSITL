//! Offline steady propeller evaluation for measured comparison (TASK-033).
//!
//! Reads a whitespace line protocol on stdin and writes one result line per
//! `point`. This is validation tooling, never the step loop: it allocates
//! freely while parsing, then calls the allocation-free `steady_point`.
//!
//! ```text
//! polar <nAlpha> <nRe> <nMach>
//! <alpha rad x nAlpha>
//! <Re x nRe>
//! <Mach x nMach>
//! <CL x nMach*nRe*nAlpha>
//! <CD x nMach*nRe*nAlpha>
//! rotor <blades> <radiusM> <cutoutM> <stations> <azimuthSamples>
//! <station radius m> / <chord m> / <twist rad> / <width m>   (four lines)
//! point <rpm> <J> <rhoKgM3> <muPaS> <soundMps>
//! ```
//! Output: `ok <CT> <CP> <eta> <inducedMps> <residualN> <polarFlags> <outside 0|1>`
//! or `err`. A `rotor` block applies to the following points until the next one.
//! Optional `--annular` selects the separate BEM diagnostic. Its fifth numeric
//! output is a dimensionless residual (legacy: N); nonconverged points are `err`.
//! Detailed `bem` lines on stderr record final section coverage and convergence.
use mirage_bet::{
    blade::{Rotor, RotorGeometry},
    polar::PolarTable,
    propeller::{steady_point, PropellerCondition},
    propeller_bem::{steady_annular, BemOptions},
};
use std::io::{self, BufRead, Write};

fn numbers(line: Option<io::Result<String>>, count: usize) -> Result<Vec<f64>, String> {
    let line = line
        .ok_or("unexpected end of input")?
        .map_err(|e| e.to_string())?;
    let values = line
        .split_whitespace()
        .map(|t| t.parse::<f64>().map_err(|_| format!("bad number {t:?}")))
        .collect::<Result<Vec<_>, _>>()?;
    if values.len() != count {
        return Err(format!("expected {count} values, found {}", values.len()));
    }
    Ok(values)
}

fn count(token: Option<&str>) -> Result<usize, String> {
    token
        .and_then(|t| t.parse().ok())
        .ok_or_else(|| "bad count".to_string())
}

/// Owned rotor block: blade count, tip/cutout radii, azimuth samples and the
/// station radius/chord/twist/width columns.
struct RotorBlock {
    blades: u32,
    radius: f64,
    cutout: f64,
    azimuth: usize,
    stations: [Vec<f64>; 4],
}

fn run() -> Result<(), String> {
    let mut annular = false;
    let mut options = BemOptions::default();
    for argument in std::env::args().skip(1) {
        match argument.as_str() {
            "--annular" => annular = true,
            "--no-tip-loss" => options.tip_loss = false,
            "--no-hub-loss" => options.hub_loss = false,
            "--no-swirl" => options.swirl = false,
            _ => return Err(format!("unknown argument {argument:?}")),
        }
    }
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let mut out = io::BufWriter::new(io::stdout().lock());
    let mut polar_data: Option<[Vec<f64>; 5]> = None;
    let mut rotor_data: Option<RotorBlock> = None;
    while let Some(line) = lines.next() {
        let line = line.map_err(|e| e.to_string())?;
        let mut tokens = line.split_whitespace();
        match tokens.next() {
            None => continue,
            Some("polar") => {
                let (na, nr, nm) = (
                    count(tokens.next())?,
                    count(tokens.next())?,
                    count(tokens.next())?,
                );
                let n = na * nr * nm;
                polar_data = Some([
                    numbers(lines.next(), na)?,
                    numbers(lines.next(), nr)?,
                    numbers(lines.next(), nm)?,
                    numbers(lines.next(), n)?,
                    numbers(lines.next(), n)?,
                ]);
            }
            Some("rotor") => {
                let blades = count(tokens.next())? as u32;
                let radius: f64 = tokens
                    .next()
                    .and_then(|t| t.parse().ok())
                    .ok_or("bad radius")?;
                let cutout: f64 = tokens
                    .next()
                    .and_then(|t| t.parse().ok())
                    .ok_or("bad cutout")?;
                let n = count(tokens.next())?;
                let azimuth = count(tokens.next())?;
                rotor_data = Some(RotorBlock {
                    blades,
                    radius,
                    cutout,
                    azimuth,
                    stations: [
                        numbers(lines.next(), n)?,
                        numbers(lines.next(), n)?,
                        numbers(lines.next(), n)?,
                        numbers(lines.next(), n)?,
                    ],
                });
            }
            Some("point") => {
                let v = tokens
                    .map(|t| t.parse::<f64>().map_err(|_| format!("bad number {t:?}")))
                    .collect::<Result<Vec<_>, _>>()?;
                let [rpm, j, rho, mu, sound] = v[..] else {
                    return Err("point needs 5 values".into());
                };
                let p = polar_data.as_ref().ok_or("point before polar")?;
                let r = rotor_data.as_ref().ok_or("point before rotor")?;
                let s = &r.stations;
                let polar = PolarTable::new(&p[0], &p[1], &p[2], &p[3], &p[4])
                    .map_err(|e| format!("polar rejected: {e:?}"))?;
                let geometry = RotorGeometry {
                    blade_count: r.blades,
                    spin_sign: 1,
                    radius_m: r.radius,
                    cutout_m: r.cutout,
                    radius: &s[0],
                    chord: &s[1],
                    twist: &s[2],
                    width: &s[3],
                };
                let rotor = Rotor::new(geometry, polar, r.azimuth)
                    .map_err(|_| "rotor rejected".to_string())?;
                let condition = PropellerCondition {
                    rpm,
                    advance_ratio: j,
                    density_kg_m3: rho,
                    viscosity_pa_s: mu,
                    sound_speed_mps: sound,
                    collective_rad: 0.0,
                };
                let line = if annular {
                    match steady_annular(geometry, polar, condition, options) {
                        Ok(p) => {
                            eprintln!(
                                "bem {} {} {} {} {} {} {} {} {} {} {} {}",
                                u8::from(p.converged),
                                u8::from(p.outside_momentum_validity),
                                p.polar_flags,
                                p.max_relative_residual,
                                p.min_alpha_rad,
                                p.max_alpha_rad,
                                p.min_reynolds,
                                p.max_reynolds,
                                p.mean_induced_mps,
                                p.mean_swirl_mps,
                                p.ct,
                                p.cp
                            );
                            if p.converged {
                                format!(
                                    "ok {:?} {:?} {:?} {:?} {:?} {} {}",
                                    p.ct,
                                    p.cp,
                                    p.eta,
                                    p.mean_induced_mps,
                                    p.max_relative_residual,
                                    p.polar_flags,
                                    u8::from(p.outside_momentum_validity)
                                )
                            } else {
                                "err".to_string()
                            }
                        }
                        Err(_) => {
                            eprintln!("bem error");
                            "err".to_string()
                        }
                    }
                } else {
                    match steady_point(&rotor, r.radius, 1, condition) {
                        Ok(p) => format!(
                            "ok {:?} {:?} {:?} {:?} {:?} {} {}",
                            p.ct,
                            p.cp,
                            p.eta,
                            p.induced_mps,
                            p.momentum_residual_n,
                            p.polar_flags,
                            u8::from(p.outside_momentum_validity)
                        ),
                        Err(_) => "err".to_string(),
                    }
                };
                writeln!(out, "{line}").map_err(|e| e.to_string())?;
            }
            Some(other) => return Err(format!("unknown record {other:?}")),
        }
    }
    out.flush().map_err(|e| e.to_string())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("propeller_points: {message}");
        std::process::exit(1);
    }
}
