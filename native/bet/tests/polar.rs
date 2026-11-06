//! TASK-019: polar lookup against the analytic fixture
//! tests/fixtures/polars/synthetic.json (closed-form expectations from
//! tests/fixtures/polars/generate.py, exact under trilinear interpolation).
use mirage_bet::abi::FLAG_OUTSIDE_POLAR_VALIDITY;
use mirage_bet::polar::{PolarError, PolarTable};

const FIXTURE: &str = include_str!("../../../tests/fixtures/polars/synthetic.json");

/// Numbers of the flat JSON array under `"key": [`, searched from `from`.
fn array(key: &str, from: usize) -> Vec<f64> {
    let marker = format!("\"{key}\": [");
    let start = FIXTURE[from..].find(&marker).expect("array key") + from + marker.len();
    let end = start + FIXTURE[start..].find(']').expect("array end");
    FIXTURE[start..end].split(',').map(|v| v.trim().parse().expect("number")).collect()
}
fn number(object: &str, key: &str) -> f64 {
    let marker = format!("\"{key}\": ");
    let start = object.find(&marker).expect("number key") + marker.len();
    object[start..].split([',', '\n', '}']).next().and_then(|v| v.trim().parse().ok()).expect("number")
}
struct Query { name: String, alpha: f64, re: f64, mach: f64, cl: f64, cd: f64, outside: bool }
fn queries() -> Vec<Query> {
    let section = &FIXTURE[FIXTURE.find("\"queries\"").expect("queries")..];
    section.split('{').skip(1).map(|object| {
        let name_at = object.find("\"name\": \"").expect("name") + 9;
        Query {
            name: object[name_at..name_at + object[name_at..].find('"').expect("quote")].to_string(),
            alpha: number(object, "alphaRad"), re: number(object, "reynolds"), mach: number(object, "mach"),
            cl: number(object, "cl"), cd: number(object, "cd"), outside: object.contains("\"outsideValidity\": true"),
        }
    }).collect()
}
struct Tables { alpha: Vec<f64>, re: Vec<f64>, mach: Vec<f64>, cl: Vec<f64>, cd: Vec<f64> }
fn tables() -> Tables {
    Tables { alpha: array("alphaRad", 0), re: array("reynolds", 0), mach: array("mach", 0), cl: array("cl", 0), cd: array("cd", 0) }
}
const TOLERANCE: f64 = 1e-12; // fixture "tolerance.absolute", fixed before implementation

#[test]
fn confidence_uses_only_contributing_corners_without_smoothing_away_uncertainty(){
    use mirage_bet::polar::FLAG_LOW_CONFIDENCE;
    let p=PolarTable::new(&[-1.0,1.0],&[1e4,1e6],&[0.0],&[1.0;4],&[0.02;4]).unwrap()
        .with_confidence(&[1.0,1.0,1.0,0.1],0.9).unwrap();
    assert_eq!(p.lookup(-1.0,1e6,0.0).flags,0);
    assert_eq!(p.lookup(0.0,1e5,0.0).flags,FLAG_LOW_CONFIDENCE);
    assert!(p.with_confidence(&[1.1;4],0.9).is_err());
}

#[test]
fn matches_analytic_values_at_nodes_inside_cells_and_in_reverse_flow() {
    let t = tables();
    let polar = PolarTable::new(&t.alpha, &t.re, &t.mach, &t.cl, &t.cd).expect("valid fixture");
    assert_eq!(polar.shape(), (3, 3, 9));
    let all = queries();
    assert_eq!(all.len(), 13);
    for q in &all {
        let s = polar.lookup(q.alpha, q.re, q.mach);
        assert!((s.cl - q.cl).abs() <= TOLERANCE, "{}: cl {} vs {}", q.name, s.cl, q.cl);
        assert!((s.cd - q.cd).abs() <= TOLERANCE, "{}: cd {} vs {}", q.name, s.cd, q.cd);
        assert_eq!(s.flags, if q.outside { FLAG_OUTSIDE_POLAR_VALIDITY } else { 0 }, "{}", q.name);
        assert!(s.cd >= 0.0, "{}", q.name);
    }
    assert!(all.iter().any(|q| q.outside) && all.iter().any(|q| !q.outside));
}

#[test]
fn every_table_node_is_returned_exactly() {
    let t = tables();
    let polar = PolarTable::new(&t.alpha, &t.re, &t.mach, &t.cl, &t.cd).unwrap();
    for (im, m) in t.mach.iter().enumerate() {
        for (ir, r) in t.re.iter().enumerate() {
            for (ia, a) in t.alpha.iter().enumerate() {
                let index = (im * t.re.len() + ir) * t.alpha.len() + ia;
                let s = polar.lookup(*a, *r, *m);
                assert!((s.cl - t.cl[index]).abs() <= TOLERANCE && (s.cd - t.cd[index]).abs() <= TOLERANCE, "node {index}");
                assert_eq!(s.flags, 0);
            }
        }
    }
}

#[test]
fn interpolates_in_log_reynolds_not_linear_reynolds() {
    // One alpha/Mach node, CL = ln(Re): the geometric midpoint must give the arithmetic mean.
    let (alpha, mach, re) = ([0.0], [0.0], [1.0e4, 1.0e6]);
    let cl = [1.0e4f64.ln(), 1.0e6f64.ln()];
    let cd = [0.01, 0.01];
    let polar = PolarTable::new(&alpha, &re, &mach, &cl, &cd).unwrap();
    let s = polar.lookup(0.0, 1.0e5, 0.0);
    assert!((s.cl - 1.0e5f64.ln()).abs() <= TOLERANCE);
    assert_eq!(s.flags, 0);
    // A single-node Mach axis is exact at its node and flagged anywhere else.
    assert_eq!(polar.lookup(0.0, 1.0e5, 0.1).flags, FLAG_OUTSIDE_POLAR_VALIDITY);
}

#[test]
fn clamps_and_flags_instead_of_extrapolating() {
    let t = tables();
    let polar = PolarTable::new(&t.alpha, &t.re, &t.mach, &t.cl, &t.cd).unwrap();
    let edge = polar.lookup(0.3, 5.0e5, 0.6);
    for (re, mach) in [(5.0e6, 0.6), (5.0e5, 3.0), (1.0e12, 10.0)] {
        let s = polar.lookup(0.3, re, mach);
        assert_eq!((s.cl, s.cd, s.flags), (edge.cl, edge.cd, FLAG_OUTSIDE_POLAR_VALIDITY), "{re} {mach}");
    }
    assert_eq!(polar.lookup(0.3, 0.0, 0.0).flags, FLAG_OUTSIDE_POLAR_VALIDITY); // Re = 0 (no flow) clamps
    assert_eq!(polar.lookup(0.3, -1.0, -1.0).flags, FLAG_OUTSIDE_POLAR_VALIDITY);
    for (a, r, m) in [(f64::NAN, 1e5, 0.0), (0.0, f64::INFINITY, 0.0), (0.0, 1e5, f64::NAN)] {
        let s = polar.lookup(a, r, m);
        assert!(s.cl.is_nan() && s.cd.is_nan() && s.flags == FLAG_OUTSIDE_POLAR_VALIDITY);
    }
}

#[test]
fn rejects_invalid_tables() {
    let t = tables();
    let check = |alpha: &[f64], re: &[f64], mach: &[f64], cl: &[f64], cd: &[f64]| PolarTable::new(alpha, re, mach, cl, cd).err();
    let with = |values: &[f64], index: usize, value: f64| { let mut v = values.to_vec(); v[index] = value; v };
    assert_eq!(check(&t.alpha, &t.re, &t.mach, &t.cl, &with(&t.cd, 40, -1e-9)), Some(PolarError::NegativeDrag));
    assert_eq!(check(&t.alpha, &t.re, &t.mach, &with(&t.cl, 3, f64::NAN), &t.cd), Some(PolarError::NonFinite));
    assert_eq!(check(&t.alpha, &t.re, &t.mach, &t.cl, &with(&t.cd, 0, f64::INFINITY)), Some(PolarError::NonFinite));
    assert_eq!(check(&with(&t.alpha, 4, -0.3), &t.re, &t.mach, &t.cl, &t.cd), Some(PolarError::AxisOrder)); // duplicate
    assert_eq!(check(&with(&t.alpha, 4, -1.0), &t.re, &t.mach, &t.cl, &t.cd), Some(PolarError::AxisOrder));
    assert_eq!(check(&with(&t.alpha, 0, f64::NAN), &t.re, &t.mach, &t.cl, &t.cd), Some(PolarError::AxisOrder));
    assert_eq!(check(&t.alpha, &[1e5, 2e4, 5e5], &t.mach, &t.cl, &t.cd), Some(PolarError::AxisOrder));
    assert_eq!(check(&t.alpha, &[0.0, 1e5, 5e5], &t.mach, &t.cl, &t.cd), Some(PolarError::AxisRange));
    assert_eq!(check(&t.alpha, &t.re, &[-0.1, 0.3, 0.6], &t.cl, &t.cd), Some(PolarError::AxisRange));
    assert_eq!(check(&t.alpha, &t.re, &t.mach, &t.cl[1..], &t.cd[1..]), Some(PolarError::Shape));
    assert_eq!(check(&t.alpha, &t.re, &t.mach, &t.cl, &t.cd[1..]), Some(PolarError::Shape));
    assert_eq!(check(&[], &t.re, &t.mach, &[], &[]), Some(PolarError::Shape));
}

#[path = "support/neuralfoil.rs"]
mod neuralfoil;

/// TASK-091: the prepared lookup returns the reference lookup's exact bits
/// (coefficients and flags) on every query: nodes, cell interiors, clamped
/// and non-finite queries, single-node and duplicated Mach axes, the
/// non-uniform NeuralFoil Reynolds axis and an irregular alpha axis.
#[test]
fn prepared_lookup_returns_the_reference_bits() {
    let check = |table: &PolarTable, alphas: &[f64], res: &[f64], machs: &[f64]| {
        let prepared = table.prepare();
        let mut count = 0usize;
        for &a in alphas {
            for &r in res {
                for &m in machs {
                    let (want, got) = (table.lookup(a, r, m), prepared.lookup(a, r, m));
                    assert_eq!((want.cl.to_bits(), want.cd.to_bits(), want.flags), (got.cl.to_bits(), got.cd.to_bits(), got.flags),
                        "alpha {a} Re {r} Mach {m}");
                    count += 1;
                }
            }
        }
        count
    };
    let mut alphas: Vec<f64> = (-1400..=1400).map(|k| k as f64 * 0.0005).collect();
    alphas.extend([-std::f64::consts::PI, std::f64::consts::PI, f64::NAN, f64::INFINITY, -0.0]);
    let mut res: Vec<f64> = (0..=160).map(|k| 10f64.powf(2.5 + k as f64 * 0.025)).collect();
    res.extend([1000.0, 5000.0, 1e4, 2e4, 4e4, 6e4, 1e5, 2e5, 5e5, 1e6, f64::NAN]);
    let machs = [0.0, 0.05, 0.3, 0.6, -0.1, f64::NAN];
    let mut count = 0;
    for mach_nodes in [vec![0.0], vec![0.0, 0.3]] {
        let p = neuralfoil::naca6409(&mach_nodes);
        // The node alphas themselves, so every exact node is queried too.
        let nodes: Vec<f64> = p.alpha.iter().copied().chain(alphas.iter().copied()).collect();
        let table = PolarTable::new(&p.alpha, &p.re, &p.mach, &p.cl, &p.cd).unwrap().with_confidence(&p.confidence, 0.9).unwrap();
        count += check(&table, &nodes, &res, &machs);
        let plain = PolarTable::new(&p.alpha, &p.re, &p.mach, &p.cl, &p.cd).unwrap();
        count += check(&plain, &alphas[..400], &res, &machs);
    }
    // An irregular alpha axis: the O(1) guess is wrong and is corrected.
    let t = tables();
    let irregular_alpha = [-3.0, -2.9, -1.0, -0.05, 0.0, 0.01, 0.4, 2.5, 3.1];
    let n = irregular_alpha.len() * t.re.len() * t.mach.len();
    let (cl, cd): (Vec<f64>, Vec<f64>) = (0..n).map(|k| ((k as f64 * 0.37).sin(), 0.01 + (k as f64 * 0.11).cos().abs())).unzip();
    let irregular = PolarTable::new(&irregular_alpha, &t.re, &t.mach, &cl, &cd).unwrap();
    count += check(&irregular, &alphas, &res, &machs);
    let synthetic = PolarTable::new(&t.alpha, &t.re, &t.mach, &t.cl, &t.cd).unwrap();
    count += check(&synthetic, &alphas, &res, &machs);
    assert!(count > 2_000_000, "{count} queries");
}

/// TASK-091 increment 4: the strip-wise lookup returns the bits of the
/// query-at-a-time lookup for every strip, with the union of its flags, on every
/// table shape it serves (one or two Mach nodes, one or many Reynolds nodes,
/// regular and irregular alpha axes, with and without confidence) and every
/// tail length; strips below the minimum speed keep their lanes and add no flag.
#[test]
fn strip_lookup_returns_the_bits_of_the_query_lookup() {
    use mirage_bet::polar::{clamp_select, ln_kernel, ReynoldsLogs, StripLanes, FLAG_LOW_CONFIDENCE};
    const MIN_SPEED: f64 = 1.0;
    let mut state = 0x2545_F491_4F6C_DD1Du64;
    let mut unit = move || { state ^= state << 13; state ^= state >> 7; state ^= state << 17; (state >> 11) as f64 / (1u64 << 53) as f64 };
    let mut checked = 0usize;
    let mut check = |table: &PolarTable, alpha_axis: &[f64], re_axis: &[f64], mach_axis: &[f64]| {
        let mut logs = ReynoldsLogs::new();
        let polar = table.prepare_kernel(&mut logs);
        assert!(polar.usable() && polar.strip_wise());
        let (re_first, re_last) = polar.reynolds_bounds();
        let mut lanes = Box::new(StripLanes::new());
        for n in [1usize, 2, 3, 5, 16, 63, 64] {
            lanes.hint[..n].fill(usize::MAX);
            let mut hints = [usize::MAX; 64];
            for round in 0..1000 {
                for k in 0..n {
                    // Exact nodes, interiors and queries past both ends of each axis.
                    let pick = |axis: &[f64], u: f64, v: f64| {
                        if v < 0.3 { axis[(u * axis.len() as f64) as usize] }
                        else { axis[0] + (u * 1.2 - 0.1) * (axis[axis.len() - 1] - axis[0]) }
                    };
                    let (u, v, w) = (unit(), unit(), unit());
                    let alpha = pick(alpha_axis, u, v);
                    let reynolds = if w < 0.01 { f64::INFINITY } else { pick(re_axis, unit(), unit()) };
                    let mach = if w > 0.99 { f64::INFINITY } else { pick(mach_axis, unit(), unit()) };
                    lanes.speed[k] = if unit() < 0.05 { 0.5 } else { 2.0 };
                    lanes.alpha[k] = alpha;
                    lanes.reynolds[k] = reynolds;
                    lanes.clamped_reynolds[k] = clamp_select(reynolds, re_first, re_last);
                    lanes.ln_reynolds[k] = ln_kernel(lanes.clamped_reynolds[k]);
                    lanes.mach[k] = mach;
                }
                let before = (lanes.cl, lanes.cd);
                // Half the rounds as an evaluation that already holds the low-confidence flag.
                let known = if round % 2 == 0 { 0 } else { FLAG_LOW_CONFIDENCE };
                let flags = polar.sample_strips(&mut lanes, n, MIN_SPEED, known);
                let mut expected_flags = 0;
                for k in 0..n {
                    if !(lanes.speed[k] >= MIN_SPEED) {
                        assert_eq!((lanes.cl[k].to_bits(), lanes.cd[k].to_bits()), (before.0[k].to_bits(), before.1[k].to_bits()), "a strip below the minimum speed changed");
                        continue;
                    }
                    if hints[k] == usize::MAX {
                        hints[k] = polar.reynolds_guess(lanes.ln_reynolds[k]);
                    }
                    let want = polar.sample(lanes.alpha[k], lanes.reynolds[k], lanes.ln_reynolds[k], lanes.mach[k], &mut hints[k], known | expected_flags);
                    expected_flags |= want.flags;
                    assert_eq!((lanes.cl[k].to_bits(), lanes.cd[k].to_bits()), (want.cl.to_bits(), want.cd.to_bits()),
                        "strip {k} of {n}: alpha {} Re {} Mach {}", lanes.alpha[k], lanes.reynolds[k], lanes.mach[k]);
                    checked += 1;
                }
                assert_eq!(flags, expected_flags, "{n} strips");
            }
        }
    };
    for mach_nodes in [vec![0.0], vec![0.0, 0.3]] {
        let p = neuralfoil::naca6409(&mach_nodes);
        let table = PolarTable::new(&p.alpha, &p.re, &p.mach, &p.cl, &p.cd).unwrap().with_confidence(&p.confidence, 0.9).unwrap();
        check(&table, &p.alpha, &p.re, &p.mach);
        let plain = PolarTable::new(&p.alpha, &p.re, &p.mach, &p.cl, &p.cd).unwrap();
        check(&plain, &p.alpha, &p.re, &p.mach);
        // One Reynolds node: its weight stays 0 and its bracket stays 0.
        let one = [p.re[3]];
        let count = p.alpha.len() * p.mach.len();
        let (cl, cd): (Vec<f64>, Vec<f64>) = (0..count).map(|k| ((k as f64 * 0.37).sin(), 0.01 + (k as f64 * 0.11).cos().abs())).unzip();
        let single = PolarTable::new(&p.alpha, &one, &p.mach, &cl, &cd).unwrap();
        check(&single, &p.alpha, &one, &p.mach);
    }
    // An irregular alpha axis, where the O(1) guess is wrong and is corrected, with low-confidence cells.
    let t = tables();
    let irregular_alpha = [-3.0, -2.9, -1.0, -0.05, 0.0, 0.01, 0.4, 2.5, 3.1];
    let mach = [0.0, 0.4];
    let count = irregular_alpha.len() * t.re.len() * mach.len();
    let (cl, cd): (Vec<f64>, Vec<f64>) = (0..count).map(|k| ((k as f64 * 0.37).sin(), 0.01 + (k as f64 * 0.11).cos().abs())).unzip();
    let confidence: Vec<f64> = (0..count).map(|k| if k % 7 == 0 { 0.2 } else { 1.0 }).collect();
    let irregular = PolarTable::new(&irregular_alpha, &t.re, &mach, &cl, &cd).unwrap().with_confidence(&confidence, 0.9).unwrap();
    check(&irregular, &irregular_alpha, &t.re, &mach);
    // Axes whose last interval times its reciprocal rounds below 1: only the exact rule keeps a query
    // clamped onto the last node at weight 1, so these separate that rule from the bare product.
    let below_one = |start: f64, step: f64, width: &dyn Fn(f64) -> f64| {
        (1..100_000).map(|k| start + k as f64 * step).find(|x| width(*x) * (1.0 / width(*x)) != 1.0).unwrap()
    };
    let first_re = 2e4;
    let last_re = below_one(1e5, 7.0, &|x| ln_kernel(x) - ln_kernel(first_re));
    let last_mach = below_one(0.3, 1e-5, &|x| x);
    let (re_axis, mach_axis) = ([first_re, last_re], [0.0, last_mach]);
    let count = irregular_alpha.len() * re_axis.len() * mach_axis.len();
    let (cl, cd): (Vec<f64>, Vec<f64>) = (0..count).map(|k| ((k as f64 * 0.37).sin(), 0.01 + (k as f64 * 0.11).cos().abs())).unzip();
    let rounded = PolarTable::new(&irregular_alpha, &re_axis, &mach_axis, &cl, &cd).unwrap();
    check(&rounded, &irregular_alpha, &re_axis, &mach_axis);
    assert!(checked > 1_000_000, "{checked} strips");
}
