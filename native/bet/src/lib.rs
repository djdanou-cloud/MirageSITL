//! Scalar blade-element reference kernels for MirageSITL (TASK-016).
//!
//! Includes scalar rotor quadrature, limited axial inflow, free shaft, and
//! reduced flapping/momentum kernels (TASK-020..023). The bootstrap export
//! remains for ABI regression and keeps its unavailable-aerodynamics response.
//! The additive `bound` ABI binds validated polar/rotor data and advances
//! shaft/inflow state; feature-gated exports also verify reference kernels.
//! `bound_v2` and `body_abi_v2` (TASK-088) are the step interfaces v2 with
//! fail-closed fields for later tasks; neutral records run the v1 steps.
//!
//! On wasm32 the global allocator traps: any heap allocation aborts the module,
//! so the kernels provably run allocation-free (a no_std build is not used
//! because stable Rust 1.97 has no `f64::sqrt` in `core`). Native test builds
//! use the system allocator. `abi` (TASK-018) defines the checked C ABI records
//! and arena binding; on wasm32 its section 4 exports are in `wasm_exports`.
//! `polar` (TASK-019) is the validated (Mach, Re, alpha) coefficient lookup.
#![forbid(unsafe_op_in_unsafe_fn)]
#![deny(missing_docs)]

pub mod abi;
pub mod blade;
pub mod coaxial;
pub mod motor;
pub mod battery;
pub mod math;
pub mod frame;
pub mod rigid_body;
pub mod landing_gear;
pub mod body_abi;
pub mod body_abi_v2;
pub mod bound;
pub mod bound_v2;
pub mod inflow;
pub mod shaft;
pub mod flapping;
pub mod momentum;
#[cfg(all(target_arch = "wasm32", feature = "kernel-test-exports"))]
mod test_exports;
pub mod quadrature;
pub mod polar;
pub mod propeller;
pub mod propeller_bem;

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

#[cfg(all(target_arch = "wasm32", not(feature = "embedded-kernels")))]
mod wasm_exports {
    //! The section 4 exports. Every `u32` pointer is checked by `abi::region_valid`
    //! against the current linear memory and must lie at or above `__heap_base`
    //! (never in Rust's static data or stack); regions passed together must not
    //! overlap. Only then are they turned into slices for the safe `abi` code.
    use crate::abi;
    use core::sync::atomic::{AtomicI32, Ordering};

    static LAST_ERROR: AtomicI32 = AtomicI32::new(abi::STATUS_OK);

    extern "C" {
        /// Linker-defined end of static data and stack; memory above it is unused
        /// because the allocator traps.
        static __heap_base: u8;
    }

    fn heap_base() -> u32 {
        core::ptr::addr_of!(__heap_base) as usize as u32
    }
    fn memory_pages() -> u32 {
        core::arch::wasm32::memory_size::<0>() as u32
    }
    fn caller_region(ptr: u32, len: u32) -> bool {
        ptr >= heap_base() && abi::region_valid(ptr, len, u64::from(memory_pages()) * 65536)
    }

    /// Independent polar-bound rotor interface version.
    #[no_mangle]
    pub extern "C" fn bet_bound_version() -> u32 { crate::bound::VERSION }

    /// Validates/copies one rotor configuration; zero means success, not a handle.
    #[no_mangle]
    pub extern "C" fn bet_bound_init(cp:u32,cl:u32,ap:u32,al:u32)->i32 {
        if !caller_region(cp,cl) || !caller_region(ap,al) || abi::regions_overlap(cp,cl,ap,al) {return -2;}
        // SAFETY: caller-owned checked disjoint regions, no concurrent memory access.
        let (config,arena)=unsafe{(bytes(cp,cl),bytes_mut(ap,al))};
        crate::bound::init(config,arena,memory_pages())
    }

    fn bound_len(handle:u32)->Option<u32> {
        if !caller_region(handle,64) {return None;}
        // SAFETY: validated read-only header, dropped before any mutation.
        let len=crate::bound::arena_len(unsafe{bytes(handle,64)})?;
        caller_region(handle,len).then_some(len)
    }

    /// Atomic-on-error fixed step with confidence/validity flags in its output.
    #[no_mangle]
    pub extern "C" fn bet_bound_step(handle:u32,ip:u32,op:u32,dt:f64)->i32 {
        let Some(len)=bound_len(handle) else{return -1;};
        // SAFETY: bound_len checked the full immutable arena region.
        if crate::bound::memory_pages(unsafe{bytes(handle,len)})!=Some(memory_pages()) {return -5;}
        if !caller_region(ip,128) || !caller_region(op,128) || abi::regions_overlap(ip,128,op,128)
            || abi::regions_overlap(handle,len,ip,128) || abi::regions_overlap(handle,len,op,128) {return -2;}
        // SAFETY: all regions are validated and pairwise disjoint.
        let (arena,input,out)=unsafe{(bytes_mut(handle,len),bytes(ip,128),bytes_mut(op,128))};
        crate::bound::step(arena,input,out,dt)
    }

    /// Restores configured shaft speed and zero induced flow.
    #[no_mangle]
    pub extern "C" fn bet_bound_reset(handle:u32)->i32 {
        let Some(len)=bound_len(handle) else{return -1;};
        // SAFETY: bound_len checked the immutable full arena.
        if crate::bound::memory_pages(unsafe{bytes(handle,len)})!=Some(memory_pages()) {return -5;}
        // SAFETY: checked region is exclusively borrowed for reset.
        crate::bound::reset(unsafe{bytes_mut(handle,len)})
    }

    /// Bound-rotor step record version v2; arenas and `bet_bound_version` stay v1.
    #[no_mangle]
    pub extern "C" fn bet_bound_v2_version() -> u32 { crate::bound_v2::VERSION }

    /// Step v2 on a v1 arena; the pointer, overlap and memory rules of `bet_bound_step`.
    #[no_mangle]
    pub extern "C" fn bet_bound_step_v2(handle:u32,ip:u32,op:u32,dt:f64)->i32 {
        let Some(len)=bound_len(handle) else{return -1;};
        // SAFETY: bound_len checked the full immutable arena region.
        if crate::bound::memory_pages(unsafe{bytes(handle,len)})!=Some(memory_pages()) {return -5;}
        let (n,m)=(crate::bound_v2::INPUT_BYTES,crate::bound_v2::OUTPUT_BYTES);
        if !caller_region(ip,n) || !caller_region(op,m) || abi::regions_overlap(ip,n,op,m)
            || abi::regions_overlap(handle,len,ip,n) || abi::regions_overlap(handle,len,op,m) {return -2;}
        // SAFETY: all regions are validated and pairwise disjoint.
        let (arena,input,out)=unsafe{(bytes_mut(handle,len),bytes(ip,n),bytes_mut(op,m))};
        crate::bound_v2::step(arena,input,out,dt)
    }

    /// Invalidates a bound rotor without affecting another handle.
    #[no_mangle]
    pub extern "C" fn bet_bound_dispose(handle:u32) {
        if let Some(len)=bound_len(handle) {
            // SAFETY: checked exclusive caller-owned arena.
            crate::bound::dispose(unsafe{bytes_mut(handle,len)});
        }
    }
    /// SAFETY: requires `caller_region(ptr, len)`: the range is non-null, aligned,
    /// inside linear memory, and outside Rust-owned memory. The module is
    /// single-threaded, so nothing mutates it while the slice lives.
    unsafe fn bytes<'a>(ptr: u32, len: u32) -> &'a [u8] {
        // SAFETY: see the function contract.
        unsafe { core::slice::from_raw_parts(ptr as usize as *const u8, len as usize) }
    }
    /// SAFETY: as `bytes`, and the range overlaps no other live slice.
    unsafe fn bytes_mut<'a>(ptr: u32, len: u32) -> &'a mut [u8] {
        // SAFETY: see the function contract.
        unsafe { core::slice::from_raw_parts_mut(ptr as usize as *mut u8, len as usize) }
    }
    fn fail(status: i32) -> u32 {
        LAST_ERROR.store(status, Ordering::Relaxed);
        0
    }
    /// Validated live arena behind `handle`: (length, rotor count) or a status.
    fn live_arena(handle: u32) -> Result<u32, i32> {
        if !caller_region(handle, abi::arena::HEADER_BYTES) {
            return Err(abi::STATUS_BAD_HANDLE);
        }
        // SAFETY: caller_region checked above; read-only and dropped before any mutable slice.
        let len = abi::arena_len(unsafe { bytes(handle, abi::arena::HEADER_BYTES) }).ok_or(abi::STATUS_BAD_HANDLE)?;
        if !caller_region(handle, len) {
            return Err(abi::STATUS_BAD_HANDLE);
        }
        Ok(len)
    }

    /// Status of the last failed `bet_required_bytes`/`bet_init` call.
    #[no_mangle]
    pub extern "C" fn bet_last_error() -> i32 {
        LAST_ERROR.load(Ordering::Relaxed)
    }

    /// Arena bytes for a configuration, or 0 (see `bet_last_error`).
    #[no_mangle]
    pub extern "C" fn bet_required_bytes(config_ptr: u32, len: u32) -> u32 {
        if !caller_region(config_ptr, len) {
            return fail(abi::STATUS_BAD_POINTER);
        }
        // SAFETY: caller_region checked above.
        abi::required_bytes(unsafe { bytes(config_ptr, len) }).unwrap_or_else(fail)
    }

    /// Initializes an engine in the caller's arena; returns its handle (the arena pointer) or 0.
    #[no_mangle]
    pub extern "C" fn bet_init(config_ptr: u32, len: u32, arena_ptr: u32, arena_bytes: u32) -> u32 {
        if !caller_region(config_ptr, len) || !caller_region(arena_ptr, arena_bytes)
            || abi::regions_overlap(config_ptr, len, arena_ptr, arena_bytes) {
            return fail(abi::STATUS_BAD_POINTER);
        }
        // SAFETY: both regions checked above and disjoint.
        let (config, arena) = unsafe { (bytes(config_ptr, len), bytes_mut(arena_ptr, arena_bytes)) };
        match abi::init(config, arena, memory_pages()) {
            Ok(()) => {
                LAST_ERROR.store(abi::STATUS_OK, Ordering::Relaxed);
                arena_ptr
            }
            Err(status) => fail(status),
        }
    }

    /// One fixed step; see `abi::step` for statuses.
    #[no_mangle]
    pub extern "C" fn bet_step(handle: u32, input_ptr: u32, out_ptr: u32, dt_s: f64) -> i32 {
        let arena_len = match live_arena(handle) {
            Ok(len) => len,
            Err(status) => return status,
        };
        // SAFETY: live_arena validated the whole arena region; read-only, dropped before mutation.
        let arena_view = unsafe { bytes(handle, arena_len) };
        if abi::memory_pages(arena_view) != Some(memory_pages()) {
            return abi::STATUS_MEMORY_GROWN;
        }
        let count = match abi::live_rotor_count(arena_view) {
            Ok(count) => count,
            Err(status) => return status,
        };
        let (input_len, out_len) = (abi::input_bytes(count), abi::output_bytes(count));
        if !caller_region(input_ptr, input_len) || !caller_region(out_ptr, out_len)
            || abi::regions_overlap(input_ptr, input_len, out_ptr, out_len)
            || abi::regions_overlap(input_ptr, input_len, handle, arena_len)
            || abi::regions_overlap(out_ptr, out_len, handle, arena_len) {
            return abi::STATUS_BAD_POINTER;
        }
        // SAFETY: all three regions checked above and pairwise disjoint.
        let (arena, input, out) = unsafe { (bytes_mut(handle, arena_len), bytes(input_ptr, input_len), bytes_mut(out_ptr, out_len)) };
        abi::step(arena, input, out, dt_s)
    }

    /// Independent rigid-body ABI version; rotor arena version remains unchanged.
    #[no_mangle]
    pub extern "C" fn bet_body_abi_version() -> u32 {
        crate::body_abi::VERSION
    }

    /// Body-only RK4 step over validated, disjoint caller-owned regions.
    #[no_mangle]
    pub extern "C" fn bet_body_step(input_ptr: u32, out_ptr: u32, dt: f64) -> i32 {
        let il = crate::body_abi::INPUT_BYTES;
        let ol = crate::body_abi::OUTPUT_BYTES;
        if !caller_region(input_ptr, il) || !caller_region(out_ptr, ol)
            || abi::regions_overlap(input_ptr, il, out_ptr, ol) {
            return abi::STATUS_BAD_POINTER;
        }
        // SAFETY: both regions are in caller memory, aligned and disjoint.
        let (input, out) = unsafe { (bytes(input_ptr, il), bytes_mut(out_ptr, ol)) };
        crate::body_abi::step(input, out, dt)
    }

    /// Rigid-body step record version v2; `bet_body_abi_version` stays v1.
    #[no_mangle]
    pub extern "C" fn bet_body_v2_version() -> u32 {
        crate::body_abi_v2::VERSION
    }

    /// Body-only RK4 step v2 over validated, disjoint caller-owned regions.
    #[no_mangle]
    pub extern "C" fn bet_body_step_v2(input_ptr: u32, out_ptr: u32, dt: f64) -> i32 {
        let il = crate::body_abi_v2::INPUT_BYTES;
        let ol = crate::body_abi_v2::OUTPUT_BYTES;
        if !caller_region(input_ptr, il) || !caller_region(out_ptr, ol)
            || abi::regions_overlap(input_ptr, il, out_ptr, ol) {
            return abi::STATUS_BAD_POINTER;
        }
        // SAFETY: both regions are in caller memory, aligned and disjoint.
        let (input, out) = unsafe { (bytes(input_ptr, il), bytes_mut(out_ptr, ol)) };
        crate::body_abi_v2::step(input, out, dt)
    }

    /// Resets rotor states; 0 or a negative status.
    #[no_mangle]
    pub extern "C" fn bet_reset(handle: u32, seed: u32) -> i32 {
        match live_arena(handle) {
            // SAFETY: live_arena validated the region; the only live slice.
            Ok(len) => abi::reset(unsafe { bytes_mut(handle, len) }, seed),
            Err(status) => status,
        }
    }

    /// Invalidates the handle; unknown handles are ignored.
    #[no_mangle]
    pub extern "C" fn bet_dispose(handle: u32) {
        if let Ok(len) = live_arena(handle) {
            // SAFETY: live_arena validated the region; the only live slice.
            abi::dispose(unsafe { bytes_mut(handle, len) });
        }
    }
}

#[cfg(all(target_arch = "wasm32", not(feature = "embedded-kernels")))]
mod trapping_allocator {
    //! A global allocator whose every entry point
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
