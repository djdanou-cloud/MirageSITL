//! Shared explicit byte fixture for native correctness and allocation tests.
fn put(b:&mut[u8],p:usize,v:f64){b[p..p+8].copy_from_slice(&v.to_le_bytes());}
fn word(b:&mut[u8],p:usize,v:u32){b[p..p+4].copy_from_slice(&v.to_le_bytes());}
pub fn fixture()->(Vec<u8>,Vec<u8>,Vec<u8>){
    // One midpoint strip, constant CL=1/CD=.02; two alpha/Re/Mach nodes.
    let mut c=vec![0u8;128+(4+2+2+2+24)*8];
    let len=c.len() as u32;word(&mut c,0,1);word(&mut c,4,len);
    for (p,v) in [(8,2),(12,2),(16,2),(20,1),(24,2),(28,1),(32,8)]{word(&mut c,p,v);}
    for (p,v) in [(40,0.5),(48,0.1),(56,0.02),(64,0.0),(72,1.0/400.0),(80,100.0),(88,0.1),(96,500.0),(104,0.9)]{put(&mut c,p,v);}
    let values=[0.3,0.03,0.0,0.4,-3.15,3.15,1.0,1e9,0.0,1.0,
        1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,
        0.02,0.02,0.02,0.02,0.02,0.02,0.02,0.02,
        1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0];
    for(i,v)in values.iter().enumerate(){put(&mut c,128+8*i,*v);}
    let arena=vec![0;64+c.len()];let mut input=vec![0;128];word(&mut input,0,1);
    put(&mut input,8,1.225);put(&mut input,16,1.789e-5);put(&mut input,24,340.0);
    (c,arena,input)
}
