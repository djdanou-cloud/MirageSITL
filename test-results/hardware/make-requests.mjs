import {writeFileSync} from 'node:fs';
function crcByte(crc,b) { let t=(b^(crc&255))&255;t^=(t<<4)&255;return ((crc>>>8)^(t<<8)^(t<<3)^(t>>>4))&65535; }
// COMMAND_LONG, exclusively MAV_CMD_REQUEST_MESSAGE (512). No state-changing commands.
const ids=[148,1,27,29,24,36,147,193,30,65];
const packets=ids.map((id,seq)=>{const b=Buffer.alloc(41);b.set([254,33,seq,255,190,76]);b.writeFloatLE(id,6);b.writeUInt16LE(512,34);b[36]=1;b[37]=1;let c=65535;for(let i=1;i<39;i++)c=crcByte(c,b[i]);c=crcByte(c,152);b.writeUInt16LE(c,39);return {id,base64:b.toString('base64')};});
writeFileSync('test-results/hardware/requests.json',JSON.stringify(packets,null,2));
