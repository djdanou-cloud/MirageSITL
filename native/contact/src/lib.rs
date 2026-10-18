//! Direct f64 contact ABI v1. One instance, one owner, no shared memory/reentry.
pub mod contact;
use contact::{Contact, CONFIG_COUNT, INPUT_COUNT, OUTPUT_COUNT};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};
thread_local! {
    static TRACK:Cell<bool>=const {Cell::new(false)};
    static CALLS:Cell<u64>=const {Cell::new(0)};
    static BYTES:Cell<u64>=const {Cell::new(0)};
}
struct Counter;
fn account(n: usize) {
    #[cfg(target_arch = "wasm32")]
    if matches!(option_env!("MIRAGE_CONTACT_TRACE"), Some("1"))
        && TRACK.try_with(|t| t.get()).unwrap_or(false)
    {
        core::arch::wasm32::unreachable();
    }
    let _ = TRACK.try_with(|t| {
        if t.get() {
            let _ = CALLS.try_with(|c| c.set(c.get() + 1));
            let _ = BYTES.try_with(|c| c.set(c.get() + n as u64));
        }
    });
}
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        account(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        account(l.size());
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        account(n);
        unsafe { System.realloc(p, l, n) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}
#[global_allocator]
static ALLOCATOR: Counter = Counter;
static mut CONFIG: [f64; CONFIG_COUNT] = [0.0; CONFIG_COUNT];
static mut INPUT: [f64; INPUT_COUNT] = [0.0; INPUT_COUNT];
static mut OUTPUT: [f64; OUTPUT_COUNT] = [0.0; OUTPUT_COUNT];
static mut SESSION: *mut Contact = std::ptr::null_mut();
static mut FAULTED: bool = false;
#[no_mangle]
pub extern "C" fn contact_abi_version() -> u32 {
    1
}
#[no_mangle]
pub extern "C" fn contact_config_ptr() -> *mut f64 {
    std::ptr::addr_of_mut!(CONFIG).cast()
}
#[no_mangle]
pub extern "C" fn contact_input_ptr() -> *mut f64 {
    std::ptr::addr_of_mut!(INPUT).cast()
}
#[no_mangle]
pub extern "C" fn contact_output_ptr() -> *const f64 {
    std::ptr::addr_of!(OUTPUT).cast()
}
#[no_mangle]
pub extern "C" fn contact_allocation_calls() -> f64 {
    CALLS.with(|c| c.get() as f64)
}
#[no_mangle]
pub extern "C" fn contact_allocation_bytes() -> f64 {
    BYTES.with(|c| c.get() as f64)
}
#[no_mangle]
pub extern "C" fn contact_allocator_probe() -> u32 {
    CALLS.with(|c| c.set(0));
    BYTES.with(|c| c.set(0));
    TRACK.with(|t| t.set(true));
    let p = Box::new(std::hint::black_box([0u8; 64]));
    std::hint::black_box(&p);
    drop(p);
    TRACK.with(|t| t.set(false));
    let pass = CALLS.with(|c| c.get() > 0) && BYTES.with(|c| c.get() >= 64);
    CALLS.with(|c| c.set(0));
    BYTES.with(|c| c.set(0));
    pass as u32
}
/// # Safety
/// All ABI calls and direct buffer writes must be serialized, without reentry.
#[no_mangle]
pub unsafe extern "C" fn contact_initialize() -> i32 {
    if !unsafe { SESSION.is_null() } {
        return -1;
    }
    let config = unsafe { std::ptr::addr_of!(CONFIG).read() };
    match Contact::new(&config) {
        Ok(session) => {
            unsafe {
                SESSION = Box::into_raw(Box::new(session));
                FAULTED = false;
            }
            if contact_allocator_probe() != 1 {
                unsafe {
                    contact_dispose();
                }
                return -6;
            }
            0
        }
        Err(code) => code,
    }
}
/// # Safety
/// Same serialization requirement as contact_initialize. Buffers are fixed and
/// disjoint. A failure after engine advancement faults the instance permanently.
#[no_mangle]
pub unsafe extern "C" fn contact_step() -> i32 {
    if unsafe { SESSION.is_null() || FAULTED } {
        return -1;
    }
    let input = unsafe { std::ptr::addr_of!(INPUT).read() };
    TRACK.with(|t| t.set(true));
    let result = unsafe { (&mut *SESSION).step(&input) };
    TRACK.with(|t| t.set(false));
    if contact_allocation_calls() != 0.0 || contact_allocation_bytes() != 0.0 {
        unsafe {
            FAULTED = true;
        }
        return -6;
    }
    match result {
        Ok(out) => {
            unsafe {
                std::ptr::addr_of_mut!(OUTPUT).write(out);
            }
            0
        }
        Err(code) => {
            if code != -2 {
                unsafe {
                    FAULTED = true;
                }
            }
            code
        }
    }
}
/// # Safety
/// Same serialization requirement as contact_initialize; no views may be used
/// concurrently. Repeated disposal is harmless.
#[no_mangle]
pub unsafe extern "C" fn contact_dispose() {
    if !unsafe { SESSION.is_null() } {
        let p = unsafe { SESSION };
        unsafe {
            SESSION = std::ptr::null_mut();
            drop(Box::from_raw(p));
        }
    }
}
