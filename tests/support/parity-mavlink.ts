/** Cold scenario I/O. MAVLink 2 COMMAND_LONG uses common.xml CRC extra 152.
 * Firmware responses still pass the pinned production CRC parser. */
import {crcByte,encodeInto,MavParser,type MavFrame} from '../../packages/mavlink/src/codec.ts';
export function commandLong(sequence:number,command:number,parameters:readonly number[]):Uint8Array {
  if(parameters.length!==7||!parameters.every(Number.isFinite))throw Error('Seven finite command parameters required');
  const wire=new Uint8Array(45),v=new DataView(wire.buffer);
  wire.set([253,33,0,0,sequence&255,255,190,76,0,0]);
  for(let i=0;i<7;i++)v.setFloat32(10+i*4,parameters[i]!,true);
  v.setUint16(38,command,true);wire[40]=1;wire[41]=1;
  let crc=65535;for(let i=1;i<43;i++)crc=crcByte(crc,wire[i]!);crc=crcByte(crc,152);v.setUint16(43,crc,true);
  return wire;
}
export class ParityTelemetry {
  simS=0;heartbeatS=-1;ekfS=-1;mode=-1;armed=false;ekfFlags=0;
  readonly innovations=[0,0,0,0,0];
  readonly parser:MavParser;
  constructor(){this.parser=new MavParser(frame=>this.receive(frame));}
  private receive(f:MavFrame):void {
    if(f.systemId!==1||f.componentId!==1)return;
    if(f.id===0){this.heartbeatS=this.simS;this.mode=f.view.getUint32(0,true);this.armed=(f.view.getUint8(6)&128)!==0;}
    if(f.id===193){this.ekfS=this.simS;this.ekfFlags=f.view.getUint16(20,true);for(let i=0;i<5;i++)this.innovations[i]=f.view.getFloat32(i*4,true);}
  }
  get healthy():boolean {return this.heartbeatS>=0&&this.ekfS>=0&&this.simS-this.heartbeatS<=1&&this.simS-this.ekfS<=1&&
    (this.ekfFlags&55)===55&&(this.ekfFlags&1024)===0&&this.innovations.every(x=>Number.isFinite(x)&&x>=0&&x<1);}
}
export function gcsHeartbeat(sequence:number):Uint8Array {
  const payload=new Uint8Array(9);payload[4]=6;payload[5]=8;payload[8]=3;
  const out=new Uint8Array(32),n=encodeInto(0,payload,sequence&255,255,190,out);
  if(!n)throw Error('GCS heartbeat encoding failed');return out.slice(0,n);
}
/** Identical absolute-tick command schedule; no telemetry-dependent retries.
 * A failed command remains a failed flight instead of moving the reference. */
export class ParityCommands {
  private sequence=0;
  constructor(private readonly write:(bytes:Uint8Array)=>void,readonly failsafe:boolean){}
  tick(tick:number):void {
    if(tick%400===0&&(!this.failsafe||tick<72000))this.write(gcsHeartbeat(this.sequence++));
    if(tick%800!==0)return;
    this.write(commandLong(this.sequence++,511,[193,100000,0,0,0,0,0]));
    this.write(commandLong(this.sequence++,511,[0,200000,0,0,0,0,0]));
    if(tick===48000)this.write(commandLong(this.sequence++,176,[1,4,0,0,0,0,0]));
    if(tick===50400)this.write(commandLong(this.sequence++,400,[1,0,0,0,0,0,0]));
    if(tick===56000)this.write(commandLong(this.sequence++,22,[0,0,0,0,0,0,5]));
    if(tick===72000&&!this.failsafe)this.write(commandLong(this.sequence++,21,[0,0,0,0,0,0,0]));
  }
}
