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
