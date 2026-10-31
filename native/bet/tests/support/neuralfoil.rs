//! TASK-091: the checked-in NACA6409 NeuralFoil polar as flat table slices.
//! Not a runtime parser boundary; the fixture bytes are SHA-256 registered.
#![allow(dead_code)]

const NACA6409: &str = include_str!("../../../../tests/fixtures/polars/naca6409-neuralfoil.json");

/// Flat `(Mach, Re, alpha)` tables of the NACA6409 surrogate. `mach_nodes`
/// copies the single Mach = 0 block onto each requested Mach node, as
/// `parseNeuralFoilPolar` does with its upper Mach limit.
pub struct Polar {
    pub alpha: Vec<f64>,
    pub re: Vec<f64>,
    pub mach: Vec<f64>,
    pub cl: Vec<f64>,
    pub cd: Vec<f64>,
    pub confidence: Vec<f64>,
}

fn numbers(text: &str) -> Vec<f64> {
    text.split(',').map(|v| v.trim().parse().expect("fixture number")).collect()
}
/// The flat array under `"key": [`.
fn flat(key: &str) -> Vec<f64> {
    let marker = format!("\"{key}\": [");
    let start = NACA6409.find(&marker).expect("fixture key") + marker.len();
    numbers(&NACA6409[start..start + NACA6409[start..].find(']').expect("array end")])
}
/// The rows of the nested array under `"key": [[...], ...]`.
fn rows(key: &str) -> Vec<Vec<f64>> {
    let marker = format!("\"{key}\": [");
    let mut at = NACA6409.find(&marker).expect("fixture key") + marker.len();
    let mut out = Vec::new();
    loop {
        let rest = &NACA6409[at..];
        let open = rest.find(|c: char| !c.is_whitespace()).expect("array body");
        if rest[open..].starts_with(']') {
            return out;
        }
        let row_start = at + open + rest[open..].find('[').expect("row start") + 1;
        let row_end = row_start + NACA6409[row_start..].find(']').expect("row end");
        out.push(numbers(&NACA6409[row_start..row_end]));
        at = row_end + 1;
        if NACA6409[at..].trim_start().starts_with(',') {
            at += NACA6409[at..].find(',').expect("comma") + 1;
        }
    }
}

pub fn naca6409(mach_nodes: &[f64]) -> Polar {
    let alpha: Vec<f64> = flat("alphaDeg").iter().map(|d| d * std::f64::consts::PI / 180.0).collect();
    let re = flat("reynolds");
    let block = |key: &str| -> Vec<f64> {
        let table = rows(key);
        assert_eq!(table.len(), re.len(), "one row per Reynolds number");
        let one: Vec<f64> = table.into_iter().flatten().collect();
        assert_eq!(one.len(), re.len() * alpha.len());
        mach_nodes.iter().flat_map(|_| one.iter().copied()).collect()
    };
    Polar { cl: block("cl"), cd: block("cd"), confidence: block("analysisConfidence"), alpha: alpha.clone(), re: re.clone(), mach: mach_nodes.to_vec() }
}
