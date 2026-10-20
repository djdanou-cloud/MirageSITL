import {it,expect} from 'vitest';
import {validateBrowserWasmConfiguration} from '../packages/autopilot/src/wasm-browser.ts';
import {commandLong,ParityCommands} from './support/parity-mavlink.ts';
import {MavParser,encodeInto} from '../packages/mavlink/src/codec.ts';
const home={latitudeDeg:-35.362938,longitudeDeg:149.165085,altitudeMslM:584,yawDeg:0};
it('accepts bounded cold defaults and rejects malformed/non-finite startup inputs',()=>{
  expect(()=>validateBrowserWasmConfiguration({defaultsText:'ARMING_CHECK 1\nSIM_RATE_HZ 800\n',home})).not.toThrow();
  for(const defaultsText of ['ARMING_CHECK false','../path 1','A 1\n\0','A 1e999','A 1\n'.repeat(20000)])
    expect(()=>validateBrowserWasmConfiguration({defaultsText,home})).toThrow();
  for(const [key,value] of [['latitudeDeg',91],['longitudeDeg',181],['altitudeMslM',NaN],['yawDeg',360]] as const)
    expect(()=>validateBrowserWasmConfiguration({defaultsText:'A 1',home:{...home,[key]:value}})).toThrow();
});
it('matches independent pymavlink 2.4.50 COMMAND_LONG full-payload wire oracles',()=>{
  const cases=[
    {id:400,p:[1,0,0,0,0,0,0],hex:'fd21000000ffbe4c00000000803f000000000000000000000000000000000000000000000000900101010021dd'},
    {id:22,p:[0,0,0,0,0,0,5],hex:'fd21000000ffbe4c00000000000000000000000000000000000000000000000000000000a04016000101004f15'},
    {id:176,p:[1,4,0,0,0,0,0],hex:'fd21000000ffbe4c00000000803f000080400000000000000000000000000000000000000000b0000101007549'},
  ];
  for(const c of cases)expect(Buffer.from(commandLong(0,c.id,c.p)).toString('hex')).toBe(c.hex);
});
it('decodes the next known frame immediately after an unsupported envelope containing 0xfd',()=>{
  const known=new Uint8Array(64),payload=new Uint8Array(9);payload[8]=3;
  const count=encodeInto(0,payload,1,1,1,known);expect(count).toBeGreaterThan(0);
  // Structurally bounded unregistered ID 200000, payload contains a false
  // 253/255 candidate. Its bytes and arbitrary CRC are never admitted.
  const unsupported=new Uint8Array(32);unsupported.set([253,20,0,0,0,1,1,64,13,3]);unsupported.set([253,255],12);
  const received:number[]=[],parser=new MavParser(f=>received.push(f.id));
  parser.push(unsupported);parser.push(known.subarray(0,count));
  expect(received).toEqual([0]);expect(parser.unsupported).toBe(1);
});
it('schedules arm/takeoff/land and drops only GCS heartbeat for the failsafe case',()=>{
  for(const failsafe of [false,true]) {
    const events:{tick:number;id:number;command:number}[]=[];let tick=0;
    const commands=new ParityCommands(bytes=>{const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      events.push({tick,id:bytes[7]??-1,command:bytes[7]===76?v.getUint16(38,true):-1});},failsafe);
    for(tick=0;tick<=96000;tick++)commands.tick(tick);
    expect(events.filter(e=>e.command===400).map(e=>e.tick)).toEqual([50400]);
    expect(events.filter(e=>e.command===22).map(e=>e.tick)).toEqual([56000]);
    expect(events.filter(e=>e.command===21).map(e=>e.tick)).toEqual(failsafe?[]:[72000]);
    expect(events.some(e=>e.id===0&&e.tick>=72000)).toBe(!failsafe);
    expect(events.some(e=>e.command===511&&e.tick===96000)).toBe(true);
  }
});
