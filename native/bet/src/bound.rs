//! Versioned caller-owned production rotor/polar binding; see bet_bound.h.
use crate::{blade::{InflowField, RotationalAugmentation, Rotor, RotorGeometry, RotorInput},
    inflow::{AnnularMomentum, AxialInflow, DynamicInflow, InflowStates, ThrustFluctuation, MAX_INFLOW_STRIPS},
    motor::DriveTorque, polar::PolarTable, quadrature::AzimuthGrid, shaft::Shaft, Vec3};

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
/// Configuration version 2 (TASK-091): version 1 plus the kernel options word at byte 36.
pub const CONFIG_VERSION_OPTIONS: u32 = 2;
/// Configuration version 3 (TASK-097): version 2 plus `OPTION_ROTATIONAL` and its values at bytes 112..128.
pub const CONFIG_VERSION_ROTATIONAL: u32 = 3;
/// Configuration version 4 (TASK-098): version 3 plus `OPTION_DYNAMIC_INFLOW` and its state region.
pub const CONFIG_VERSION_INFLOW: u32 = 4;
/// Configuration version 5 (TASK-099): version 4 plus `OPTION_VORTEX_RING`, its seed and its state.
pub const CONFIG_VERSION_VORTEX: u32 = 5;
/// Kernel option: the half-step prediction uses azimuth samples 0 and N/2 (N even).
pub const OPTION_REDUCED_PREDICTOR: u32 = 1;
/// Kernel option: near hover the midpoint uses every other azimuth sample (N even, at least 4).
pub const OPTION_HOVER_SAMPLING: u32 = 2;
/// Kernel option (TASK-091 increment 3): the exact kernel `Rotor::evaluate_fast`, bitwise equal
/// to the reference, instead of the default T1 kernel; not combinable with options 1 and 2.
pub const OPTION_EXACT_KERNEL: u32 = 4;
/// Option of configuration version 3: rotational lift augmentation, with the lift slope (1/rad) at
/// byte 112 and the zero-lift angle (rad) at byte 120. It changes the physics, not the numerics, so the reference kernel applies it too.
pub const OPTION_ROTATIONAL: u32 = 8;
/// Option of configuration version 4: Pitt-Peters dynamic inflow with annular tip and hub losses. A manual time
/// constant is the positive inflow tau, and 0 asks for the derived one. The configuration ends with a state region of
/// (3 + strips) f64, zero at initialization and reset: the harmonics on cos and sin (m/s), the loss minus 1, and each
/// strip's shape minus 1.
pub const OPTION_DYNAMIC_INFLOW: u32 = 16;
/// Option of configuration version 5, which needs `OPTION_DYNAMIC_INFLOW`: Johnson's vortex ring state in descent, with
/// a seeded thrust fluctuation. A u64 seed follows the tables, and three words (active, value, generator) the state region.
pub const OPTION_VORTEX_RING: u32 = 32;
/// Output flag: this step's thrust fluctuation was active (TASK-099).
pub const FLAG_VORTEX_RING: u32 = 256;
/// Output flag: this step's midpoint loads used hover sampling.
pub const FLAG_HOVER_SAMPLING: u32 = 64;
/// Output flag: this step's half-step prediction used the reduced predictor.
pub const FLAG_REDUCED_PREDICTOR: u32 = 128;
/// Hover sampling starts when the regime measure falls below this value.
pub const HOVER_ENTER: f64 = 0.05;
/// Hover sampling stops when the regime measure rises above this value.
pub const HOVER_LEAVE: f64 = 0.10;

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
    /// Kernel options (configuration versions 2 and 3); 0 for version 1.
    options: u32,
    rotational: Option<RotationalAugmentation>,
    /// Where the dynamic-inflow state region starts in the configuration, with the option.
    inflow_state_at: Option<usize>,
    /// The vortex ring state's seed and where its state words start, with the option.
    vortex: Option<(u64,usize)>,
}

/// Full validation of a configuration: every axis, coefficient and confidence
/// value, the geometry and the shaft. Initialization and reset use it.
fn config(b: &[u8]) -> Result<Config<'_>, i32> { parse_config(b, true) }

/// The configuration a step reads (TASK-091). The configuration is immutable
/// after initialization, where `config` validated it, so a step rechecks only
/// the header, the counts and the slice bounds that memory safety needs and
/// does not rescan the polar values.
fn step_config(b: &[u8]) -> Result<Config<'_>, i32> { parse_config(b, false) }

fn parse_config(b: &[u8], full: bool) -> Result<Config<'_>, i32> {
    let version = u(b,0);
    if version != Some(VERSION) && version != Some(CONFIG_VERSION_OPTIONS) && version != Some(CONFIG_VERSION_ROTATIONAL) && version != Some(CONFIG_VERSION_INFLOW) && version != Some(CONFIG_VERSION_VORTEX) { return Err(-7); }
    let parse = || {
        if b.len() < CONFIG_HEADER || u(b,4)? as usize != b.len() { return None; }
        // Version 1 keeps byte 36 reserved zero; versions 2 and 3 carry the kernel options there.
        let options=if version==Some(VERSION) {if !zero(b,36,40) {return None;} 0} else {u(b,36)?};
        let known=OPTION_REDUCED_PREDICTOR|OPTION_HOVER_SAMPLING|OPTION_EXACT_KERNEL
            |if version==Some(CONFIG_VERSION_ROTATIONAL) || version==Some(CONFIG_VERSION_INFLOW) || version==Some(CONFIG_VERSION_VORTEX) {OPTION_ROTATIONAL} else {0}
            |if version==Some(CONFIG_VERSION_INFLOW) || version==Some(CONFIG_VERSION_VORTEX) {OPTION_DYNAMIC_INFLOW} else {0}
            |if version==Some(CONFIG_VERSION_VORTEX) {OPTION_VORTEX_RING} else {0};
        if options & !known != 0
            || (options & OPTION_EXACT_KERNEL != 0 && options & (OPTION_REDUCED_PREDICTOR|OPTION_HOVER_SAMPLING) != 0)
            || (options & OPTION_VORTEX_RING != 0 && options & OPTION_DYNAMIC_INFLOW == 0) { return None; }
        // Bytes 112..128 stay reserved zero unless the rotational option is on.
        let rotational=if options & OPTION_ROTATIONAL != 0 {
            let (lift_slope_per_rad,zero_lift_alpha_rad)=(f(b,112)?,f(b,120)?);
            if !lift_slope_per_rad.is_finite() || lift_slope_per_rad<=0.0 || !zero_lift_alpha_rad.is_finite() || zero_lift_alpha_rad.abs()>=1.0 {return None;}
            Some(RotationalAugmentation{lift_slope_per_rad,zero_lift_alpha_rad})
        } else {
            if !zero(b,112,128) {return None;}
            None
        };
        let na=u(b,8)? as usize;let nr=u(b,12)? as usize;let nm=u(b,16)? as usize;
        let ns=u(b,20)? as usize;let count=na.checked_mul(nr)?.checked_mul(nm)?;
        if !(1..=361).contains(&na) || !(1..=32).contains(&nr) || !(1..=8).contains(&nm)
            || !(1..=64).contains(&ns) || count > 16384 { return None; }
        let tables=CONFIG_HEADER+(4*ns+na+nr+nm+3*count)*8;
        let with_vortex=options & OPTION_VORTEX_RING != 0;
        let inflow_state_at=(options & OPTION_DYNAMIC_INFLOW != 0).then_some(tables+if with_vortex {8} else {0});
        let expected=tables+if inflow_state_at.is_some() {(3+ns)*8} else {0}+if with_vortex {8+3*8} else {0};
        if b.len()!=expected { return None; }
        let vortex=if with_vortex {
            let seed=u64::from_le_bytes(b.get(tables..tables+8)?.try_into().ok()?);
            Some((seed,tables+8+(3+ns)*8))
        } else {None};
        let mut at=CONFIG_HEADER;
        let mut take=|n| { let values=doubles(b,at,n);at+=n*8;values };
        let radius=take(ns)?;let chord=take(ns)?;let twist=take(ns)?;let width=take(ns)?;
        let alpha=take(na)?;let re=take(nr)?;let mach=take(nm)?;
        let cl=take(count)?;let cd=take(count)?;let confidence=take(count)?;
        let polar=if full {PolarTable::new(alpha,re,mach,cl,cd).ok()?.with_confidence(confidence,f(b,104)?).ok()?}
            else {PolarTable::validated(alpha,re,mach,cl,cd,confidence,f(b,104)?)};
        let geometry=RotorGeometry{blade_count:u(b,24)?,spin_sign:u(b,28)? as i32,radius_m:f(b,40)?,
            cutout_m:f(b,48)?,radius,chord,twist,width};
        let azimuth=u(b,32)? as usize;
        if full {Rotor::new(geometry,polar,azimuth).ok()?;}
        let inertia=f(b,56)?;let damping=f(b,64)?;let dt=f(b,72)?;
        let initial=f(b,80)?;let tau=f(b,88)?;let limit=f(b,96)?;
        // With dynamic inflow a tau of 0 asks for the derived time constant.
        let tau_valid=if inflow_state_at.is_some() {tau>=0.0} else {tau>0.0};
        if ![initial,tau,limit].iter().all(|v|v.is_finite()) || initial<0.0 || !tau_valid || limit<=0.0
            || ![400.0,800.0,1200.0,4800.0].iter().any(|hz|dt==1.0/hz) {return None;}
        Shaft::new(inertia,damping,geometry.spin_sign).ok()?;
        Some(Config{geometry,polar,azimuth,inertia,damping,dt,initial,tau,limit,options,rotational,inflow_state_at,vortex})
    };
    parse().ok_or(-3)
}

/// Cold initialization validates and copies config; failure writes no arena byte.
pub fn init(cfg: &[u8], arena: &mut [u8], pages: u32) -> i32 {
    let c=match config(cfg) {Ok(c)=>c,Err(e)=>return e};
    if c.inflow_state_at.is_some_and(|at| !zero(cfg,at,cfg.len())) {return -3;}
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

/// `step` on the reference kernel (TASK-091): the configuration fully
/// revalidated and `Rotor::evaluate` on every step, as before TASK-091. For
/// tests and benchmarks only; no WASM export calls it.
pub fn step_reference(arena: &mut [u8], input: &[u8], out: &mut [u8], dt: f64) -> i32 {
    match advance_with(arena,input,out.len(),dt,None,Kernel::Reference) {
        Ok(a) => { commit(arena,out,&a); 0 }
        Err(status) => status,
    }
}

/// Which rotor kernel a step runs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kernel {
    /// `step_config` and the T1 kernel `Rotor::evaluate_sampled`, or the exact
    /// kernel `Rotor::evaluate_fast` with `OPTION_EXACT_KERNEL`.
    Production,
    /// `config` and `Rotor::evaluate`, the scalar reference.
    Reference,
}

/// A computed step, not yet written: the output record, the next shaft and
/// inflow state, and the speed at the midpoint.
pub(crate) struct Advanced {
    pub(crate) staged: [u8; 128],
    pub(crate) omega: f64,
    pub(crate) induced: f64,
    pub(crate) half_omega: f64,
    /// The next hover-sampling state (arena bytes 56..64) when the option is on.
    pub(crate) hover_state: Option<f64>,
    /// The next dynamic-inflow state region when the option is on.
    pub(crate) inflow_state: Option<InflowRegion>,
    /// The next fluctuation state and where it goes, when the vortex ring option is on.
    pub(crate) vortex_state: Option<(usize,ThrustFluctuation)>,
}

/// The dynamic-inflow state region of a step, not yet written.
#[derive(Clone, Copy)]
pub(crate) struct InflowRegion {
    at: usize,
    strips: usize,
    cos_mps: f64,
    sin_mps: f64,
    loss_excess: f64,
    shape_excess: [f64; MAX_INFLOW_STRIPS],
}

/// Writes a computed step into the arena state and the output record.
pub(crate) fn commit(arena: &mut [u8], out: &mut [u8], a: &Advanced) {
    put(arena,16,a.omega);put(arena,24,a.induced);
    if let Some(state)=a.hover_state {put(arena,56,state);}
    if let Some(region)=&a.inflow_state {
        let at=ARENA_HEADER+region.at;
        put(arena,at,region.cos_mps);put(arena,at+8,region.sin_mps);put(arena,at+16,region.loss_excess);
        for k in 0..region.strips {put(arena,at+24+k*8,region.shape_excess[k]);}
    }
    if let Some((at,state))=&a.vortex_state {
        let at=ARENA_HEADER+at;
        put(arena,at,if state.active {1.0} else {0.0});put(arena,at+8,state.value);
        arena[at+16..at+24].copy_from_slice(&state.generator.to_le_bytes());
    }
    out.copy_from_slice(&a.staged);
}

/// The inflow harmonics the arena holds (cos, sin, m/s), for a configuration with dynamic inflow.
pub(crate) fn inflow_harmonics(arena: &[u8]) -> Option<(f64,f64)> {
    let bytes=arena.get(ARENA_HEADER..)?;
    if u(bytes,0)!=Some(CONFIG_VERSION_INFLOW) && u(bytes,0)!=Some(CONFIG_VERSION_VORTEX) {return None;}
    let at=step_config(bytes).ok()?.inflow_state_at?;
    Some((f(bytes,at)?,f(bytes,at+8)?))
}

/// Computes one step without writing anything. `esc` is `None` for the v1
/// torque drive, read from the record, and the ESC drive's torque law for
/// interface v2 drive mode 1 (TASK-092), whose ESC state occupies arena
/// header bytes 32..56.
pub(crate) fn advance(arena: &[u8], input: &[u8], out_len: usize, dt: f64, esc: Option<DriveTorque>) -> Result<Advanced, i32> {
    advance_with(arena,input,out_len,dt,esc,Kernel::Production)
}

/// `advance` on a chosen kernel.
pub(crate) fn advance_with(arena: &[u8], input: &[u8], out_len: usize, dt: f64, esc: Option<DriveTorque>, kernel: Kernel)
    -> Result<Advanced, i32> {
    if arena_len(arena)!=Some(arena.len() as u32) {return Err(-1);}
    if input.len()!=INPUT_BYTES as usize || out_len!=OUTPUT_BYTES as usize {return Err(-2);}
    if u(input,0)!=Some(VERSION) {return Err(-7);}
    // Bytes 32..56 hold the TASK-092 ESC state, free in torque mode; 56..64 hold the hover-sampling state.
    let drive_state_free=esc.is_some() || zero(arena,32,56);
    if !zero(input,4,8) || !zero(input,112,128) || !zero(arena,12,16) || !drive_state_free {return Err(-3);}
    let (state,bytes)=arena.split_at(ARENA_HEADER);
    let c=if kernel==Kernel::Production {step_config(bytes)?} else {config(bytes)?};
    let hover_option=c.options & OPTION_HOVER_SAMPLING != 0;
    let hover_previous=f(state,56).ok_or(-3)?;
    let hover_state_valid=if hover_option {hover_previous==0.0 || hover_previous==1.0} else {zero(state,56,64)};
    if !hover_state_valid {return Err(-3);}
    if dt.to_bits()!=c.dt.to_bits() {return Err(-4);}
    // The options apply to the production kernel only; the reference always samples in full.
    let production=kernel==Kernel::Production;
    let samples=c.azimuth;
    let reduced_predictor=production && c.options & OPTION_REDUCED_PREDICTOR != 0 && samples % 2 == 0;
    let hover_capable=production && hover_option && samples % 2 == 0 && samples >= 4;
    // The T1 kernel by default (TASK-091 increment 3); the exact kernel with OPTION_EXACT_KERNEL.
    let exact=c.options & OPTION_EXACT_KERNEL != 0;
    let evaluate=|rotor:&Rotor<'_>,i:RotorInput,field:InflowField<'_>,thrust:Option<&mut [f64]>| match (kernel,exact) {
        (Kernel::Reference,_)=>rotor.evaluate_field(i,field,thrust),
        (Kernel::Production,true)=>rotor.evaluate_fast_field(i,field,thrust),
        (Kernel::Production,false)=>rotor.evaluate_sampled_field(i,1,field,thrust),
    };
    // The dynamic-inflow state, as `InflowStates` from the arena's inflow word and the state region.
    let ns=c.geometry.radius.len();
    let dynamic=c.inflow_state_at.map(|at| {
        let bytes_at=|k:usize| f(bytes,at+k*8).unwrap_or(f64::NAN);
        let mut shape=[1.0;MAX_INFLOW_STRIPS];
        for k in 0..ns.min(MAX_INFLOW_STRIPS) {shape[k]=1.0+bytes_at(3+k);}
        (at,bytes_at(0),bytes_at(1),1.0+bytes_at(2),shape)
    });
    let compute=|| {
        let omega=f(state,16)?;let induced=f(state,24)?;
        let motor=f(input,104)?;
        let i=RotorInput{density_kg_m3:f(input,8)?,viscosity_pa_s:f(input,16)?,sound_speed_mps:f(input,24)?,
            air_velocity_hub_mps:vec(input,32)?,body_rate_hub_rad_s:vec(input,56)?,omega_rad_s:omega,
            induced_mps:induced,collective_rad:f(input,80)?,cyclic_cos_rad:f(input,88)?,cyclic_sin_rad:f(input,96)?};
        // The production step reads a configuration `config` validated at initialization (TASK-091).
        let rotor=if production {Rotor::from_validated(c.geometry,c.polar,AzimuthGrid::cached(c.azimuth)?)}
            else {Rotor::new(c.geometry,c.polar,c.azimuth).ok()?};
        let rotor=rotor.with_rotational(c.rotational);
        let empty:&[f64]=&[];
        let (shape_now,cos_now,sin_now,loss_now):(&[f64],f64,f64,f64)=match &dynamic {
            Some((_,cos,sin,loss,shape))=>(&shape[..ns.min(MAX_INFLOW_STRIPS)],*cos,*sin,*loss),
            None=>(empty,0.0,0.0,1.0),
        };
        let start_field=InflowField{shape:shape_now,cos_mps:cos_now,sin_mps:sin_now};
        // Reduced predictor: samples 0 and N/2, whose first harmonics cancel; only the axial force and torque are used.
        let first=if reduced_predictor {rotor.evaluate_sampled_field(i,samples/2,start_field,None)} else {evaluate(&rotor,i,start_field,None)}.ok()?;
        // Hover sampling: the regime measure at the start of the step, with hysteresis between HOVER_ENTER and HOVER_LEAVE.
        // Only configurations with the option form it (its hypot calls are libm calls on wasm32).
        let regime=|| { let tip=omega*c.geometry.radius_m; if omega>0.0 && tip>0.0 {
            (i.air_velocity_hub_mps.x.hypot(i.air_velocity_hub_mps.y)/tip)
                .max(i.body_rate_hub_rad_s.x.hypot(i.body_rate_hub_rad_s.y)/omega)
                .max(i.cyclic_cos_rad.hypot(i.cyclic_sin_rad))
        } else {f64::INFINITY} };
        let hover=hover_capable && { let m=regime(); if hover_previous==1.0 {m<=HOVER_LEAVE} else {m<HOVER_ENTER} };
        let shaft_model=Shaft::new(c.inertia,c.damping,c.geometry.spin_sign).ok()?;
        let flow_model=if dynamic.is_some() {None} else {Some(AxialInflow::new(i.density_kg_m3,c.geometry.radius_m,c.tau,c.limit).ok()?)};
        let transverse=i.air_velocity_hub_mps.x.hypot(i.air_velocity_hub_mps.y);
        let shaft_step=|q:f64,h:f64| match esc {
            None=>shaft_model.step(omega,q,motor,h),
            Some(t)=>shaft_model.step_driven(omega,q,t.constant_nm,t.damping,t.friction_nm,h),
        };
        let half_shaft=shaft_step(first.moment_nm.z,dt*0.5).ok()?;
        let start_states=InflowStates{mean_mps:induced,cos_mps:cos_now,sin_mps:sin_now};
        let tip=|speed:f64| speed.abs()*c.geometry.radius_m;
        // Dynamic inflow (TASK-098), or the fixed-lag axial model.
        let dynamic_model=if dynamic.is_some() {Some(DynamicInflow::new(i.density_kg_m3,c.geometry.radius_m,c.tau,c.limit).ok()?.with_vortex_ring(c.vortex.is_some()))} else {None};
        let (half_mean,half_outside,half_cos,half_sin)=match &dynamic_model {
            Some(model)=>{
                let r=model.step(start_states,loss_now,first.force_n.z,first.flap_load_nm.y,first.flap_load_nm.z,i.air_velocity_hub_mps,tip(omega),dt*0.5).ok()?;
                (r.states.mean_mps,r.outside_validity,r.states.cos_mps,r.states.sin_mps)
            }
            None=>{let r=flow_model.as_ref()?.step(induced,first.force_n.z,i.air_velocity_hub_mps.z,transverse,dt*0.5).ok()?;(r.velocity_mps,r.outside_validity,0.0,0.0)}
        };
        let mut midpoint=i;midpoint.omega_rad_s=half_shaft.omega_rad_s;midpoint.induced_mps=half_mean;
        let mid_field=InflowField{shape:shape_now,cos_mps:half_cos,sin_mps:half_sin};
        let mut strip_thrust=[0.0;MAX_INFLOW_STRIPS];
        let thrust_out:Option<&mut [f64]>=if dynamic.is_some() {Some(&mut strip_thrust[..ns.min(MAX_INFLOW_STRIPS)])} else {None};
        let aero=if hover {rotor.evaluate_sampled_field(midpoint,2,mid_field,thrust_out)} else {evaluate(&rotor,midpoint,mid_field,thrust_out)}.ok()?;
        // The inflow follows the mean thrust; the fluctuation (TASK-099) acts on what the rotor gives the shaft and the body.
        let mean_aero=aero;
        let vortex_state=match c.vortex {
            Some((seed,at))=>{
                let previous=ThrustFluctuation{active:f(bytes,at)?!=0.0,value:f(bytes,at+8)?,generator:u64::from_le_bytes(bytes.get(at+16..at+24)?.try_into().ok()?)};
                let sign=if aero.force_n.z<0.0 {-1.0} else {1.0};
                let hover_mps=(aero.force_n.z.abs()/(2.0*i.density_kg_m3*std::f64::consts::PI*c.geometry.radius_m*c.geometry.radius_m)).sqrt();
                let (vz,vx)=if hover_mps>0.0 {(-i.air_velocity_hub_mps.z*sign/hover_mps,transverse/hover_mps)} else {(0.0,f64::INFINITY)};
                Some((at,previous.step(seed,vz,vx,hover_mps,c.geometry.radius_m,dt)))
            }
            None=>None,
        };
        let aero=match &vortex_state {
            Some((_,state))=>{let factor=state.factor();let mut scaled=aero;scaled.force_n=aero.force_n.scale(factor);scaled.moment_nm=aero.moment_nm.scale(factor);scaled}
            None=>aero,
        };
        let shaft=shaft_step(aero.moment_nm.z,dt).ok()?;
        let (next_mean,mut full_outside,inflow_state)=match (&dynamic_model,&dynamic) {
            (Some(model),Some((at,_,_,_,shape)))=>{
                let r=model.step(start_states,loss_now,mean_aero.force_n.z,mean_aero.flap_load_nm.y,mean_aero.flap_load_nm.z,i.air_velocity_hub_mps,tip(half_shaft.omega_rad_s),dt).ok()?;
                // The annular balance, once per step: it sets the loss and the shape, which follow with the mean's lag.
                let sign=if mean_aero.force_n.z<0.0 {-1.0} else {1.0};
                let annuli=AnnularMomentum{blade_count:c.geometry.blade_count,radius_m:c.geometry.radius_m,cutout_m:c.geometry.cutout_m,
                    strip_radius_m:c.geometry.radius,strip_width_m:c.geometry.width};
                let n=ns.min(MAX_INFLOW_STRIPS);
                let mut annular=[0.0;MAX_INFLOW_STRIPS];
                for k in 0..n {annular[k]=induced*shape[k]*sign;}
                let climb=-i.air_velocity_hub_mps.z*sign;
                let mut region=InflowRegion{at:*at,strips:n,cos_mps:r.states.cos_mps,sin_mps:r.states.sin_mps,loss_excess:loss_now-1.0,shape_excess:[0.0;MAX_INFLOW_STRIPS]};
                let mut converged=true;
                if climb<0.0 {
                    // The annular balance holds at zero or positive climb (F-01): in descent the field relaxes to uniform.
                    region.loss_excess=(loss_now-1.0)*(1.0-r.relaxation);
                    for k in 0..n {region.shape_excess[k]=(shape[k]-1.0)*(1.0-r.relaxation);}
                } else {
                    let solved=annuli.solve(&strip_thrust[..n],i.density_kg_m3,half_shaft.omega_rad_s,sign,climb,transverse,&mut annular[..n]);
                    converged=solved.converged;
                    let (mean,root)=(solved.mean_mps,r.glauert_root_mps);
                    if mean>0.0 && root>0.0 {
                        let loss_target=(mean/root).clamp(0.2,5.0);
                        region.loss_excess=loss_now+r.relaxation*(loss_target-loss_now)-1.0;
                        for k in 0..n {region.shape_excess[k]=shape[k]+r.relaxation*(annular[k]/mean-shape[k])-1.0;}
                    } else {
                        for k in 0..n {region.shape_excess[k]=shape[k]-1.0;}
                    }
                }
                (r.states.mean_mps,r.outside_validity||!converged,Some(region))
            }
            _=>{let r=flow_model.as_ref()?.step(induced,aero.force_n.z,i.air_velocity_hub_mps.z,transverse,dt).ok()?;(r.velocity_mps,r.outside_validity,None)}
        };
        full_outside|=half_outside;
        let spin=c.geometry.spin_sign as f64;
        let h=spin*c.inertia*half_shaft.omega_rad_s;
        let dh=Vec3::new(0.0,0.0,spin*c.inertia*(shaft.omega_rad_s-omega)/dt)
            .add(i.body_rate_hub_rad_s.cross(Vec3::new(0.0,0.0,h)));
        let transmitted=aero.moment_nm.add(dh.scale(-1.0));
        // The motor's electromagnetic torque at the start speed times that speed.
        let power=match esc {None=>motor*omega,Some(t)=>(t.constant_nm-t.damping*omega)*omega};
        if !transmitted.norm().is_finite() || !power.is_finite() {return None;}
        let flags=first.flags | aero.flags | if full_outside {8}else{0}
            | if shaft.reverse_limited || half_shaft.reverse_limited {16}else{0}
            | if hover {FLAG_HOVER_SAMPLING}else{0} | if reduced_predictor {FLAG_REDUCED_PREDICTOR}else{0}
            | if vortex_state.is_some_and(|(_,state)| state.active) {FLAG_VORTEX_RING}else{0};
        Some((aero,shaft,next_mean,inflow_state,vortex_state,transmitted,power,flags,spin*c.inertia*shaft.omega_rad_s,half_shaft.omega_rad_s,hover))
    };
    let Some((aero,shaft,next_mean,inflow_state,vortex_state,transmitted,power,flags,h,half_omega,hover))=compute() else{return Err(-3);};
    let mut staged=[0u8;128];
    write_vec(&mut staged,0,aero.force_n);write_vec(&mut staged,24,aero.moment_nm);write_vec(&mut staged,48,transmitted);
    put(&mut staged,72,shaft.omega_rad_s);put(&mut staged,80,aero.moment_nm.z);put(&mut staged,88,power);
    put(&mut staged,96,next_mean);word(&mut staged,112,flags);put(&mut staged,120,h);
    let hover_state=(production && hover_option).then_some(if hover {1.0} else {0.0});
    Ok(Advanced{staged,omega:shaft.omega_rad_s,induced:next_mean,half_omega,hover_state,inflow_state,vortex_state})
}

/// Restores initial speed and zero inflow; invalid handles remain untouched.
pub fn reset(arena: &mut [u8]) -> i32 {
    if arena_len(arena)!=Some(arena.len() as u32) {return -1;}
    let (initial,inflow_at)=match config(&arena[ARENA_HEADER..]) {Ok(c)=>(c.initial,c.inflow_state_at),Err(e)=>return e};
    if let Some(at)=inflow_at {arena[ARENA_HEADER+at..].fill(0);}
    // Bytes 32..56 hold the TASK-092 ESC state, 56..64 the hover-sampling state; a reset returns
    // them to an unpowered ESC and full sampling.
    put(arena,16,initial);put(arena,24,0.0);arena[32..64].fill(0);0
}

/// Invalidates a live handle.
pub fn dispose(arena: &mut [u8]) {if arena_len(arena).is_some() {word(arena,0,0);}}
