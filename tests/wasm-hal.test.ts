import {expect,it} from 'vitest';
import {newActuatorFrameV2,newState,type ActuatorFrameV2} from '@mirage/protocol';
import {HAL_BYTES,HAL_MAGIC,WasmHalPort,WasmSitlCoupling} from '@mirage/autopilot/wasm-sitl';

// Structural unit peer only. Real firmware/native execution is checked separately.
function peer(hz:400|800|1200=800) {
  const buffer=new SharedArrayBuffer(4096),w=new Int32Array(buffer,64,256);
  w[0]=HAL_MAGIC;w[1]=1;w[2]=HAL_BYTES;w[3]=1;w[4]=hz;w[5]=7;w[11]=32;w[12]=1;
  w[128]=1000;w[129]=1250;w[130]=1750;w[159]=2000;
  const module={HEAPU8:new Uint8Array(buffer),_mirage_hal_version:()=>1,_mirage_hal_mailbox:()=>64,
    _mirage_hal_configure:(rate:number,epoch:number)=>rate===hz&&epoch===7?0:-1,
    _mirage_hal_notify:()=>{w[3]=1;w[6]=(w[6]??0)+1;w[9]=w[6]??0;},_mirage_hal_stop:()=>{w[3]=4;}};
  const port=new WasmHalPort(module,{hz,epoch:7,motorMapId:42,motorChannels:[0,1,2,31]});
  return {port,module,w};
}
it('maps actual PWM channel order, epoch and first next-tick timestamp without allocating a frame',()=>{
  const {port}=peer(),out=newActuatorFrameV2();expect(port.readActuatorsInto(out)).toBe(true);
  expect(out.epoch).toBe(7);expect(out.motorMapId).toBe(42);expect(out.tickId).toEqual({lo:1,hi:0});
  expect(out.actuatorTimeUs).toEqual({lo:1250,hi:0});
  expect(Array.from(out.normalizedActuators.slice(0,4))).toEqual([0,0.25,0.75,1]);
  expect(out.actuatorFlags).toBe(1);expect(port.steps).toBe(0);
});
it('uses exact rational timestamps at 400/800/1200 Hz and publishes all sensor bits',()=>{
  for(const hz of [400,800,1200] as const) {
    const {port,w}=peer(hz);port.input[6]=0.125;port.input[9]=-0.25;
    for(let n=1;n<=hz;n++) {
      expect(port.submit()).toBe(true);expect(w[14]).toBe(Math.floor(n*1000000/hz));
      const bytes=new DataView(w.buffer,64);expect(bytes.getFloat64(64+6*8,true)).toBe(0.125);
    }
    expect(w[14]).toBe(1000000);expect(port.steps).toBe(hz);
  }
});
it('rejects invalid sensor units/quaternions/reserved fields before writing any shared word',()=>{
  for(const [index,value] of [[0,91],[1,-181],[12,0],[6,Infinity],[9,1e300],[23,1.01],[38,-0]]) {
    const {port,w}=peer();const before=Array.from(w);port.input[index!]=value!;
    expect(port.submit()).toBe(false);expect(Array.from(w)).toEqual(before);expect(port.steps).toBe(0);
  }
});
it('fails closed on corrupt identity/count/sequence/epoch and preserves actuator output',()=>{
  for(const [index,value] of [[0,0],[1,2],[2,64],[5,8],[6,1],[7,1],[9,1],[10,1],[11,33],[12,2],[128,3000]]) {
    const {port,w}=peer(),out=newActuatorFrameV2();out.epoch=99;w[index!]=value!;
    expect(port.readActuatorsInto(out)).toBe(false);expect(out.epoch).toBe(99);expect(port.fault).not.toBe('');
  }
});
it('pause leaves the clock unchanged, growth faults, and stopping cannot publish another input',()=>{
  const {port,module,w}=peer();expect(port.steps).toBe(0);expect(w[14]).toBe(0);
  module.HEAPU8=new Uint8Array(new SharedArrayBuffer(8192));expect(port.submit()).toBe(false);
  expect(port.fault).toContain('memory grew');
  const second=peer();second.port.stop();expect(second.w[3]).toBe(4);expect(second.port.submit()).toBe(false);
});
it('couples real motor channel semantics to one physics step and ideal SI observations',()=>{
  const {port}=peer();let torque=0;
  const physics={state:newState(),hz:800 as const,nowMs:0,fault:'',windNedMps:new Float64Array(3),electrical:new Float64Array([0.9,16.2,7.5]),
    useActuators:(frame:ActuatorFrameV2)=>{torque=frame.normalizedActuators[1]??0;},
    stepNow:()=>{physics.state.tick++;physics.state.ad=9.80665;physics.state.vn=10;physics.state.down=-2;}};
  const coupling=new WasmSitlCoupling(port,physics,{latitudeRad:0,longitudeRad:0,altitudeMslM:0,
    geoidOffsetM:0,magneticNedGauss:[0.2,0.03,0.4]});
  expect(coupling.stepInto()).toBe(true);expect(physics.state.tick).toBe(1);expect(torque).toBe(0.25);
  expect(physics.nowMs).toBe(1.25);expect(port.input[2]).toBeCloseTo(2,6);
  expect(port.input[6]).toBe(0);expect(port.input[7]).toBe(0);expect(port.input[8]).toBe(0); // free fall
  expect(port.input[16]).toBe(0.2);expect(port.input[18]).toBe(0.4);
  expect(port.input[19]).toBeCloseTo(10,2);expect(port.input[22]).toBe(2);expect(coupling.fault).toBe('');
  // TASK-092: the battery bus current reaches HAL sensor value 21; a regenerating
  // bus reads 0, as on a unipolar power module, and the frame stays valid.
  expect(port.input[21]).toBe(7.5);
  physics.electrical[2]=-3;
  expect(coupling.stepInto()).toBe(true);expect(port.input[21]).toBe(0);expect(coupling.fault).toBe('');
});
