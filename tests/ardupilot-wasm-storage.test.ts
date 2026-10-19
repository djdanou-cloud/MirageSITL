import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {createCheckpoint,validateCheckpoint,storageIdentity} from '../packages/autopilot/src/wasm-storage.ts';
import golden from './fixtures/mavlink/wasm-parameters.json';
import {definition,encodeInto,MavParser} from '../packages/mavlink/src/codec';
import {BrowserWasmSession,isBrowserFirmwareCommand} from '../packages/autopilot/src/wasm-browser';
it('binds the complete EEPROM image to firmware/profile/revision and rejects corruption or foreign identity', async () => {
  const identity=storageIdentity('8'.repeat(40),'a'.repeat(64),'profile-045');
  const image=new Uint8Array(16384);image[0]=0x50;image[16383]=0x7f;
  const saved=await createCheckpoint(identity,1,image);
  expect(saved.sha256).toBe(createHash('sha256').update(image).digest('hex'));
  image[0]=0;expect(saved.image[0]).toBe(0x50); // committed bytes must not alias the live FS buffer
  expect((await validateCheckpoint(saved,identity)).revision).toBe(1);
  saved.image[10]=1;await expect(validateCheckpoint(saved,identity)).rejects.toThrow(/checksum/);
  saved.image[10]=0;await expect(validateCheckpoint(saved,identity+'-other')).rejects.toThrow(/identity/);
  await expect(validateCheckpoint({...saved,revision:0},identity)).rejects.toThrow();
  await expect(createCheckpoint(identity,1,new Uint8Array(2))).rejects.toThrow(/size/);
  expect(()=>storageIdentity('x','a'.repeat(64),'profile')).toThrow();
  expect(()=>storageIdentity('8'.repeat(40),'a'.repeat(64),'../escape')).toThrow();
});
it('rejects unknown versions/fields and oversized or shared serial buffers on the cold Worker channel',async()=>{
  const session=new BrowserWasmSession(()=>{},()=>{});
  await expect(session.start('/not-fetched',{},'main-thread-rejection')).rejects.toThrow(/dedicated Worker/);
  expect(isBrowserFirmwareCommand({protocolVersion:1,type:'stop'})).toBe(true);
  expect(isBrowserFirmwareCommand({protocolVersion:1,type:'serial',bytes:new Uint8Array(1)})).toBe(true);
  for(const value of [{protocolVersion:2,type:'stop'},{protocolVersion:1,type:'stop',extra:true},
    {protocolVersion:1,type:'serial',bytes:new Uint8Array(4097)},
    {protocolVersion:1,type:'serial',bytes:new Uint8Array(new SharedArrayBuffer(10))},
    {protocolVersion:1,type:'start',profile:'../bad',baseUrl:'/',manifest:{}},
    {protocolVersion:1,type:'arm'}])expect(isBrowserFirmwareCommand(value)).toBe(false);
});
it('matches independent pymavlink parameter bytes, accepts fragmented input and rejects invalid CRC',()=>{
  for(const f of golden.frames){
    const bytes=Uint8Array.from(Buffer.from(f.hex,'hex')),d=definition(f.id);expect(d).not.toBeNull();
    if(!d)throw Error('Missing parameter definition');
    expect([d.length,d.crcExtra]).toEqual([f.length,f.crcExtra]);
    const payload=new Uint8Array(d.length),output=new Uint8Array(280);
    payload.set(bytes.subarray(10,10+bytes[1]!));
    const n=encodeInto(f.id,payload,10,bytes[5]!,bytes[6]!,output);
    expect(Buffer.from(output.subarray(0,n)).toString('hex')).toBe(f.hex);
    const ids:number[]=[],parser=new MavParser(frame=>ids.push(frame.id));
    parser.push(bytes.subarray(0,7));parser.push(bytes.subarray(7));expect(ids).toEqual([f.id]);
    bytes[10]=bytes[10]!^1;parser.push(bytes);expect(ids).toEqual([f.id]);expect(parser.badCrc).toBe(1);
  }
});
