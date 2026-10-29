//! Versioned caller-owned production rotor/polar binding; see bet_bound.h.
use crate::{blade::{Rotor, RotorGeometry, RotorInput}, inflow::AxialInflow,
    motor::DriveTorque, polar::PolarTable, shaft::Shaft, Vec3};

/// Independent binding version (legacy arena ABI remains v1).
pub const VERSION: u32 = 1;
/// Configuration header bytes.
pub const CONFIG_HEADER: usize = 128;
/// Arena header bytes.
pub const ARENA_HEADER: usize = 64;
/// Step input bytes.
pub const INPUT_BYTES: u32 = 128;
/// Step output bytes.
pub const OUTPUT_BYTES: u32 = 128;
/// Live arena identity.
pub const MAGIC: u32 = 0x424e4431;

fn u(b: &[u8], p: usize) -> Option<u32> { Some(u32::from_le_bytes(b.get(p..p+4)?.try_into().ok()?)) }
fn f(b: &[u8], p: usize) -> Option<f64> { Some(f64::from_le_bytes(b.get(p..p+8)?.try_into().ok()?)) }
fn put(b: &mut [u8], p: usize, v: f64) { b[p..p+8].copy_from_slice(&v.to_le_bytes()); }
fn word(b: &mut [u8], p: usize, v: u32) { b[p..p+4].copy_from_slice(&v.to_le_bytes()); }
fn zero(b: &[u8], a: usize, z: usize) -> bool { b.get(a..z).is_some_and(|v| v.iter().all(|n| *n == 0)) }
fn vec(b: &[u8], at: usize) -> Option<Vec3> { Some(Vec3::new(f(b,at)?,f(b,at+8)?,f(b,at+16)?)) }
fn write_vec(b: &mut [u8], at: usize, v: Vec3) { put(b,at,v.x);put(b,at+8,v.y);put(b,at+16,v.z); }

// SAFETY: f64 has no invalid bit patterns. Alignment and exact length are checked;
// caller owns this immutable byte slice, and the state header is disjoint from it.
fn doubles(b: &[u8], start: usize, n: usize) -> Option<&[f64]> {
    let bytes = b.get(start..start.checked_add(n.checked_mul(8)?)?)?;
    if !cfg!(target_endian="little") || bytes.as_ptr() as usize % 8 != 0 { return None; }
    Some(unsafe { core::slice::from_raw_parts(bytes.as_ptr().cast::<f64>(),n) })
}

struct Config<'a> {
    geometry: RotorGeometry<'a>, polar: PolarTable<'a>, azimuth: usize,
    inertia: f64, damping: f64, dt: f64, initial: f64, tau: f64, limit: f64,
}

fn config(b: &[u8]) -> Result<Config<'_>, i32> {
    if u(b,0) != Some(VERSION) { return Err(-7); }
    let parse = || {
        if b.len() < CONFIG_HEADER || u(b,4)? as usize != b.len() || !zero(b,36,40) || !zero(b,112,128) { return None; }
        let na=u(b,8)? as usize;let nr=u(b,12)? as usize;let nm=u(b,16)? as usize;
        let ns=u(b,20)? as usize;let count=na.checked_mul(nr)?.checked_mul(nm)?;
        if !(1..=361).contains(&na) || !(1..=32).contains(&nr) || !(1..=8).contains(&nm)
            || !(1..=64).contains(&ns) || count > 16384 { return None; }
        let expected=CONFIG_HEADER+(4*ns+na+nr+nm+3*count)*8;
        if b.len()!=expected { return None; }
        let mut at=CONFIG_HEADER;
        let mut take=|n| { let values=doubles(b,at,n);at+=n*8;values };
        let radius=take(ns)?;let chord=take(ns)?;let twist=take(ns)?;let width=take(ns)?;
        let alpha=take(na)?;let re=take(nr)?;let mach=take(nm)?;
        let cl=take(count)?;let cd=take(count)?;let confidence=take(count)?;
        let polar=PolarTable::new(alpha,re,mach,cl,cd).ok()?.with_confidence(confidence,f(b,104)?).ok()?;
        let geometry=RotorGeometry{blade_count:u(b,24)?,spin_sign:u(b,28)? as i32,radius_m:f(b,40)?,
            cutout_m:f(b,48)?,radius,chord,twist,width};
        let azimuth=u(b,32)? as usize;
        Rotor::new(geometry,polar,azimuth).ok()?;
        let inertia=f(b,56)?;let damping=f(b,64)?;let dt=f(b,72)?;
        let initial=f(b,80)?;let tau=f(b,88)?;let limit=f(b,96)?;
        if ![initial,tau,limit].iter().all(|v|v.is_finite()) || initial<0.0 || tau<=0.0 || limit<=0.0
            || ![400.0,800.0,1200.0,4800.0].iter().any(|hz|dt==1.0/hz) {return None;}
        Shaft::new(inertia,damping,geometry.spin_sign).ok()?;
        Some(Config{geometry,polar,azimuth,inertia,damping,dt,initial,tau,limit})
    };
    parse().ok_or(-3)
}

/// Cold initialization validates and copies config; failure writes no arena byte.
pub fn init(cfg: &[u8], arena: &mut [u8], pages: u32) -> i32 {
    let c=match config(cfg) {Ok(c)=>c,Err(e)=>return e};
    if arena.len()!=ARENA_HEADER+cfg.len() || arena.len()>u32::MAX as usize {return -6;}
    arena.fill(0);word(arena,0,MAGIC);word(arena,4,arena.len() as u32);word(arena,8,pages);
    put(arena,16,c.initial);arena[ARENA_HEADER..].copy_from_slice(cfg);0
}

/// Returns the checked arena length from a header, without creating a full slice.
pub fn arena_len(header: &[u8]) -> Option<u32> {
    if u(header,0)!=Some(MAGIC) {return None;}
    u(header,4).filter(|n|*n>= (ARENA_HEADER+CONFIG_HEADER) as u32 && *n <= 512*1024)
}

/// Memory pages recorded at init; native callers use zero.
pub fn memory_pages(arena: &[u8]) -> Option<u32> {u(arena,8)}

/// One allocation-free fixed step; negative status preserves state and output.
pub fn step(arena: &mut [u8], input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    match advance(arena,input,out.len(),dt,None) {
        Ok(a) => { commit(arena,out,&a); 0 }
        Err(status) => status,
    }
}

/// A computed step, not yet written: the output record, the next shaft and
/// inflow state, and the speed at the midpoint.
pub(crate) struct Advanced {
    pub(crate) staged: [u8; 128],
    pub(crate) omega: f64,
    pub(crate) induced: f64,
    pub(crate) half_omega: f64,
}

/// Writes a computed step into the arena state and the output record.
pub(crate) fn commit(arena: &mut [u8], out: &mut [u8], a: &Advanced) {
    put(arena,16,a.omega);put(arena,24,a.induced);out.copy_from_slice(&a.staged);
}

/// Computes one step without writing anything. `esc` is `None` for the v1
/// torque drive, read from the record, and the ESC drive's torque law for
/// interface v2 drive mode 1 (TASK-092), whose ESC state occupies arena
/// header bytes 32..56.
pub(crate) fn advance(arena: &[u8], input: &[u8], out_len: usize, dt: f64, esc: Option<DriveTorque>) -> Result<Advanced, i32> {
    if arena_len(arena)!=Some(arena.len() as u32) {return Err(-1);}
    if input.len()!=INPUT_BYTES as usize || out_len!=OUTPUT_BYTES as usize {return Err(-2);}
    if u(input,0)!=Some(VERSION) {return Err(-7);}
    let drive_state_free=if esc.is_some() {zero(arena,56,64)} else {zero(arena,32,64)};
    if !zero(input,4,8) || !zero(input,112,128) || !zero(arena,12,16) || !drive_state_free {return Err(-3);}
    let (state,bytes)=arena.split_at(ARENA_HEADER);
    let c=config(bytes)?;
    if dt.to_bits()!=c.dt.to_bits() {return Err(-4);}
    let compute=|| {
        let omega=f(state,16)?;let induced=f(state,24)?;
        let motor=f(input,104)?;
        let i=RotorInput{density_kg_m3:f(input,8)?,viscosity_pa_s:f(input,16)?,sound_speed_mps:f(input,24)?,
            air_velocity_hub_mps:vec(input,32)?,body_rate_hub_rad_s:vec(input,56)?,omega_rad_s:omega,
            induced_mps:induced,collective_rad:f(input,80)?,cyclic_cos_rad:f(input,88)?,cyclic_sin_rad:f(input,96)?};
        let rotor=Rotor::new(c.geometry,c.polar,c.azimuth).ok()?;
        let first=rotor.evaluate(i).ok()?;
        let shaft_model=Shaft::new(c.inertia,c.damping,c.geometry.spin_sign).ok()?;
        let flow_model=AxialInflow::new(i.density_kg_m3,c.geometry.radius_m,c.tau,c.limit).ok()?;
        let transverse=i.air_velocity_hub_mps.x.hypot(i.air_velocity_hub_mps.y);
        let shaft_step=|q:f64,h:f64| match esc {
            None=>shaft_model.step(omega,q,motor,h),
            Some(t)=>shaft_model.step_driven(omega,q,t.constant_nm,t.damping,t.friction_nm,h),
        };
        let half_shaft=shaft_step(first.moment_nm.z,dt*0.5).ok()?;
        let half_flow=flow_model.step(induced,first.force_n.z,i.air_velocity_hub_mps.z,transverse,dt*0.5).ok()?;
        let mut midpoint=i;midpoint.omega_rad_s=half_shaft.omega_rad_s;midpoint.induced_mps=half_flow.velocity_mps;
        let aero=rotor.evaluate(midpoint).ok()?;
        let shaft=shaft_step(aero.moment_nm.z,dt).ok()?;
        let flow=flow_model.step(induced,aero.force_n.z,i.air_velocity_hub_mps.z,transverse,dt).ok()?;
        let spin=c.geometry.spin_sign as f64;
        let h=spin*c.inertia*half_shaft.omega_rad_s;
        let dh=Vec3::new(0.0,0.0,spin*c.inertia*(shaft.omega_rad_s-omega)/dt)
            .add(i.body_rate_hub_rad_s.cross(Vec3::new(0.0,0.0,h)));
        let transmitted=aero.moment_nm.add(dh.scale(-1.0));
        // The motor's electromagnetic torque at the start speed times that speed.
        let power=match esc {None=>motor*omega,Some(t)=>(t.constant_nm-t.damping*omega)*omega};
        if !transmitted.norm().is_finite() || !power.is_finite() {return None;}
        let flags=first.flags | aero.flags | if flow.outside_validity || half_flow.outside_validity {8}else{0}
            | if shaft.reverse_limited || half_shaft.reverse_limited {16}else{0};
        Some((aero,shaft,flow,transmitted,power,flags,spin*c.inertia*shaft.omega_rad_s,half_shaft.omega_rad_s))
    };
    let Some((aero,shaft,flow,transmitted,power,flags,h,half_omega))=compute() else{return Err(-3);};
    let mut staged=[0u8;128];
    write_vec(&mut staged,0,aero.force_n);write_vec(&mut staged,24,aero.moment_nm);write_vec(&mut staged,48,transmitted);
    put(&mut staged,72,shaft.omega_rad_s);put(&mut staged,80,aero.moment_nm.z);put(&mut staged,88,power);
    put(&mut staged,96,flow.velocity_mps);word(&mut staged,112,flags);put(&mut staged,120,h);
    Ok(Advanced{staged,omega:shaft.omega_rad_s,induced:flow.velocity_mps,half_omega})
}

/// Restores initial speed and zero inflow; invalid handles remain untouched.
pub fn reset(arena: &mut [u8]) -> i32 {
    if arena_len(arena)!=Some(arena.len() as u32) {return -1;}
    let initial=match config(&arena[ARENA_HEADER..]) {Ok(c)=>c.initial,Err(e)=>return e};
    // Bytes 32..56 hold the TASK-092 ESC state; a reset returns it to an unpowered ESC.
    put(arena,16,initial);put(arena,24,0.0);arena[32..64].fill(0);0
}

/// Invalidates a live handle.
pub fn dispose(arena: &mut [u8]) {if arena_len(arena).is_some() {word(arena,0,0);}}
