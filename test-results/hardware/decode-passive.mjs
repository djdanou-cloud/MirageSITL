import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = process.argv[2] ?? 'com20-passive';
const bytes = readFileSync(`test-results/hardware/${source}.bin`);
const extras = new Map([[0,50],[1,124],[22,220],[24,24],[27,144],[29,115],[30,39],[36,222],[65,118],[74,20],[77,143],[111,34],[147,154],[148,178],[193,71],[253,83]]);
const frames = [], counts = {}, unknownIds = []; let badCrc = 0, unknownCrc = 0, skipped = 0;
function crcByte(crc,b) { let t = (b ^ (crc & 255)) & 255; t ^= (t << 4) & 255; return ((crc >>> 8) ^ (t << 8) ^ (t << 3) ^ (t >>> 4)) & 65535; }
for (let i=0;i<bytes.length;) {
  const v2=bytes[i]===253, v1=bytes[i]===254;
  if (!v2&&!v1) { skipped++; i++; continue; }
  if(i+(v2?10:6)>bytes.length) break;
  const header=v2?10:6, len=bytes[i+1], signed=v2&&(bytes[i+2]&1), total=header+len+2+(signed?13:0);
  if(i+total>bytes.length) break;
  const id=v2?bytes.readUIntLE(i+7,3):bytes[i+5], extra=extras.get(id);
  if(extra===undefined) { unknownCrc++; unknownIds.push(id); i+=total; continue; }
  let crc=65535; for(let j=i+1;j<i+header+len;j++) crc=crcByte(crc,bytes[j]); crc=crcByte(crc,extra);
  if(crc!==bytes.readUInt16LE(i+header+len)) {badCrc++;i++;continue;}
  const p=Buffer.alloc(255);bytes.copy(p,0,i+header,i+header+len);
  const frame={id,sequence:bytes[i+(v2?4:2)],systemId:bytes[i+(v2?5:3)],componentId:bytes[i+(v2?6:4)]};
  if(id===0) Object.assign(frame,{customMode:p.readUInt32LE(0),vehicleType:p[4],autopilot:p[5],baseMode:p[6],armed:!!(p[6]&128),hilEnabled:!!(p[6]&32),systemStatus:p[7]});
  if(id===253) frame.text=p.subarray(1,51).toString().replace(/\0.*$/s,'');
  if(id===77) Object.assign(frame,{command:p.readUInt16LE(0),result:p[2]});
  if(id===148) Object.assign(frame,{flightVersion:p.readUInt32LE(16).toString(16),boardVersion:p.readUInt32LE(28),vendorId:p.readUInt16LE(32),productId:p.readUInt16LE(34),firmwareCustomVersion:p.subarray(36,44).toString('hex')});
  if(id===1) Object.assign(frame,{sensorsPresent:p.readUInt32LE(0),sensorsEnabled:p.readUInt32LE(4),sensorsHealthy:p.readUInt32LE(8),batteryMv:p.readUInt16LE(14),batteryCurrentCa:p.readInt16LE(16),batteryRemainingPct:p.readInt8(30)});
  if(id===27) Object.assign(frame,{accelMilliG:[0,1,2].map(j=>p.readInt16LE(8+j*2)),gyroMradS:[0,1,2].map(j=>p.readInt16LE(14+j*2)),magMilliGauss:[0,1,2].map(j=>p.readInt16LE(20+j*2))});
  if(id===29) Object.assign(frame,{pressureHpa:p.readFloatLE(4),temperatureC:p.readInt16LE(12)/100});
  if(id===24) Object.assign(frame,{fixType:p[28],satellites:p[29],ephCm:p.readUInt16LE(20)});
  if(id===36) frame.servoPwmUs=Array.from({length:8},(_,j)=>p.readUInt16LE(4+j*2));
  if(id===147) Object.assign(frame,{voltageMv:Array.from({length:10},(_,j)=>p.readUInt16LE(10+j*2)),currentCa:p.readInt16LE(30),remainingPct:p.readInt8(35)});
  if(id===193) Object.assign(frame,{flags:p.readUInt16LE(20),velocityVariance:p.readFloatLE(0),horizontalPositionVariance:p.readFloatLE(4),verticalPositionVariance:p.readFloatLE(8),compassVariance:p.readFloatLE(12)});
  counts[id]=(counts[id]??0)+1;frames.push(frame);i+=total;
}
const heartbeats=frames.filter(f=>f.id===0); const gaps=[];
for(let i=1;i<frames.length;i++) {const a=frames[i-1],b=frames[i];if(a.systemId===b.systemId&&a.componentId===b.componentId&&((b.sequence-a.sequence+256)%256)!==1)gaps.push({previous:a.sequence,next:b.sequence});}
const result={captureSha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,settingBaud:115200,durationTargetS:source==='com20-passive'?25:20,transmittedBytes:source==='com20-passive'?0:410,transmittedCommands:source==='com20-passive'?[]:['10 MAV_CMD_REQUEST_MESSAGE (512) queries'],dtr:false,rts:false,counts,badCrc,unknownCrc,unknownIds,skipped,sequenceDiscontinuities:gaps,heartbeats,frames,limitations:['USB CDC setting does not establish physical UART baud.','Serial buffering and pre-existing buffered heartbeats do not establish per-frame timing or freshness.','Sequence gaps across unknown message IDs do not establish packet loss.','No cryptographic signature verification.','No hardware motor-disable verification; operator reports battery disconnected.']};
writeFileSync(`test-results/hardware/${source}-summary.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({...result,heartbeats:heartbeats.slice(0,1),frames:frames.filter(f=>f.id!==0&&f.id!==111)},null,2));
