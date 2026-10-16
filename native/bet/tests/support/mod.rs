//! Minimal numeric reader for checked-in, independently generated JSON oracles.
//! Not a runtime network/parser boundary; fixture bytes are SHA-256 registered.
pub fn number(json: &str, key: &str) -> f64 {
    let marker = format!("\"{key}\": ");
    let tail = json.split_once(&marker).expect("fixture key").1;
    tail.split([',', '\n', '}'])
        .next()
        .expect("fixture value")
        .trim()
        .parse()
        .expect("fixture number")
}
