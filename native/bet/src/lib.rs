//! Scalar blade-element reference kernels for MirageSITL (TASK-016).
//!
//! This is a bootstrap kernel: one blade element's aerodynamic force from
//! docs/SPECS_SIMULATION_ENGINES.md section 3. It is a scalar reference for
//! later rotor quadrature (TASK-020), not a validated aerodynamics model.
//!
//! On wasm32 the global allocator traps: any heap allocation aborts the module,
//! so the kernels provably run allocation-free (a no_std build is not used
//! because stable Rust 1.97 has no `f64::sqrt` in `core`). Native test builds
//! use the system allocator.
#![forbid(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

/// ABI version reported by `bet_abi_version`; loaders reject any other value.
pub const BET_ABI_VERSION: u32 = 1;
/// Below this relative speed element forces are zero and atan2 is not evaluated (section 3).
pub const MIN_RELATIVE_SPEED_MPS: f64 = 1e-6;

/// A 3-vector in rotor hub axes (metres, metres per second, or newtons).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec3 {
    /// x component.
    pub x: f64,
    /// y component.
    pub y: f64,
    /// z component.
    pub z: f64,
}

impl Vec3 {
    /// Constructs a vector.
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }
    /// Dot product.
    pub fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }
    /// Cross product.
    pub fn cross(self, other: Self) -> Self {
        Self::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }
    /// Scales the vector.
    pub fn scale(self, factor: f64) -> Self {
        Self::new(self.x * factor, self.y * factor, self.z * factor)
    }
    /// Vector sum.
    pub fn add(self, other: Self) -> Self {
        Self::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }
    /// Euclidean norm.
    pub fn norm(self) -> f64 {
        sqrt(self.dot(self))
    }
}

/// IEEE-754 correctly rounded square root (the `f64.sqrt` instruction on wasm32).
#[inline]
pub fn sqrt(value: f64) -> f64 {
    value.sqrt()
}

/// Aerodynamic force on one blade element (section 3):
/// `dF = 1/2 rho U^2 c dr (C_L l + C_D d)`, with `d = v_perp / U` and
/// `l = s (d x e_r)`, where `v_perp` is the relative air velocity projected
/// into the element plane, `e_r` the unit radial direction, and `s = +-1` the
/// spin sign. Returns zero when `U < MIN_RELATIVE_SPEED_MPS`.
///
/// `cl`/`cd` are inputs here only because this is a bootstrap kernel; the
/// rotor engine derives them from the polar table (TASK-019/020).
pub fn element_force(
    density_kg_m3: f64,
    chord_m: f64,
    dr_m: f64,
    v_perp_mps: Vec3,
    e_r: Vec3,
    spin_sign: f64,
    cl: f64,
    cd: f64,
) -> Vec3 {
    let speed = v_perp_mps.norm();
    if !(speed >= MIN_RELATIVE_SPEED_MPS) {
        return Vec3::new(0.0, 0.0, 0.0);
    }
    let drag_dir = v_perp_mps.scale(1.0 / speed);
    let lift_dir = drag_dir.cross(e_r).scale(spin_sign);
    let q_area = 0.5 * density_kg_m3 * speed * speed * chord_m * dr_m;
    lift_dir.scale(q_area * cl).add(drag_dir.scale(q_area * cd))
}

/// WASM export: the ABI version (`BET_ABI_VERSION`).
#[no_mangle]
pub extern "C" fn bet_abi_version() -> u32 {
    BET_ABI_VERSION
}

/// WASM export: component `axis` (0 = x, 1 = y, 2 = z) of `element_force`;
/// NaN for an invalid axis. Scalar arguments only: the bootstrap ABI has no
/// memory records (TASK-018 adds them).
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn bet_bootstrap_element_force(
    density_kg_m3: f64,
    chord_m: f64,
    dr_m: f64,
    vx: f64,
    vy: f64,
    vz: f64,
    erx: f64,
    ery: f64,
    erz: f64,
    spin_sign: f64,
    cl: f64,
    cd: f64,
    axis: u32,
) -> f64 {
    let force = element_force(
        density_kg_m3,
        chord_m,
        dr_m,
        Vec3::new(vx, vy, vz),
        Vec3::new(erx, ery, erz),
        spin_sign,
        cl,
        cd,
    );
    match axis {
        0 => force.x,
        1 => force.y,
        2 => force.z,
        _ => f64::NAN,
    }
}

#[cfg(target_arch = "wasm32")]
mod trapping_allocator {
    //! The only `unsafe` in the crate: a global allocator whose every entry point
    //! traps. Invariant: no code path reachable from an export allocates; if one
    //! ever does, the module aborts loudly instead of growing memory mid-step.
    use std::alloc::{GlobalAlloc, Layout};

    struct TrappingAllocator;

    // SAFETY: GlobalAlloc requires returned pointers to be valid allocations; this
    // allocator never returns (it traps), so it can never hand out invalid memory.
    unsafe impl GlobalAlloc for TrappingAllocator {
        unsafe fn alloc(&self, _layout: Layout) -> *mut u8 {
            core::arch::wasm32::unreachable()
        }
        unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {
            core::arch::wasm32::unreachable()
        }
    }

    #[global_allocator]
    static ALLOCATOR: TrappingAllocator = TrappingAllocator;
}
