//! Independent bound-ABI fixtures and unchanged-output rejection tests.
use mirage_bet::bound;
fn put(b:&mut[u8],p:usize,v:f64){b[p..p+8].copy_from_slice(&v.to_le_bytes());}
fn word(b:&mut[u8],p:usize,v:u32){b[p..p+4].copy_from_slice(&v.to_le_bytes());}
fn get(b:&[u8],p:usize)->f64{f64::from_le_bytes(b[p..p+8].try_into().unwrap())}
#[path="support/bound_fixture.rs"]
mod fixture_data;
use fixture_data::fixture;

#[test]
fn loads_and_transmitted_shaft_reaction_match_closed_form(){
    let(c,mut a,i)=fixture();assert_eq!(bound::init(&c,&mut a,0),0);
    let mut o=[0u8;128];assert_eq!(bound::step(&mut a,&i,&mut o,1.0/400.0),0);
    let initial_thrust=0.5*1.225*30.0*30.0*0.03*0.4*2.0;
    let half_omega=100.0-initial_thrust*0.02*0.3/0.02/800.0;
    let half_induced=(initial_thrust/(2.0*1.225*std::f64::consts::PI*0.25)).sqrt()
        *(1.0-(-1.0f64/800.0/0.1).exp());
    let velocity=(half_omega*0.3).hypot(half_induced);
    let scale=0.5*1.225*velocity*velocity*0.03*0.4*2.0;
    let thrust=scale*(half_omega*0.3-0.02*half_induced)/velocity;
    assert!((get(&o,16)-thrust).abs()<1e-10);
    let q=-scale*0.3*(half_induced+0.02*half_omega*0.3)/velocity;
    assert!((get(&o,80)-q).abs()<1e-10);
    assert!((get(&o,72)-(100.0+q/0.02/400.0)).abs()<1e-10);
    assert!(get(&o,64).abs()<1e-10); // no drive/bearing: shaft absorbs aerodynamic torque
    assert!(get(&o,96)>0.0);
    assert_eq!(bound::reset(&mut a),0);assert_eq!(get(&a,16),100.0);assert_eq!(get(&a,24),0.0);
}
#[test]
fn errors_preserve_output_and_state_and_old_versions_are_rejected(){
    let(mut c,mut a,mut i)=fixture();word(&mut c,0,2);let before=a.clone();
    assert_eq!(bound::init(&c,&mut a,0),-7);assert_eq!(before,a);word(&mut c,0,1);
    assert_eq!(bound::init(&c,&mut a,0),0);let before=a.clone();let mut o=[0x5au8;128];
    assert_eq!(bound::step(&mut a,&i,&mut o,1.0/800.0),-4);assert_eq!(before,a);assert_eq!(o,[0x5a;128]);
    put(&mut i,104,f64::NAN);assert_eq!(bound::step(&mut a,&i,&mut o,1.0/400.0),-3);
    assert_eq!(before,a);assert_eq!(o,[0x5a;128]);bound::dispose(&mut a);
    assert_eq!(bound::step(&mut a,&i,&mut o,1.0/400.0),-1);
}
