//! Exports the linker-defined `__heap_base` from the wasm32 cdylib so the
//! TypeScript arena binding (packages/wasm-bet/src/arena.ts) can place caller
//! records above Rust's static data and stack.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-cdylib-link-arg=--export=__heap_base");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
