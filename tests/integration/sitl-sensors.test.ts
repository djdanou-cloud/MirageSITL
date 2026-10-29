import { it } from 'vitest';
import { nodeCheck } from '../support/node-evidence';

// TASK-147: the native sensor audit fails each check when its condition is
// broken. The synthetic cases are built from the analytic expectations, so
// the passing set is the oracle and each mutation must fail exactly where it
// should. Node runs the cold ESM tool itself (scripts/check-sitl-sensors.mjs).

const SETUP = `
import {readFileSync} from 'node:fs';
import {ACCEL_SCALE,absentAllowed,assessSensorCases,LIMITS,windowMeans} from './scripts/check-sitl-sensors.mjs';
const catalog=JSON.parse(readFileSync('tests/fixtures/sitl/ardupilot-catalog.json','utf8'));
const conditions=new Map(catalog.simParameters.map(p=>[p.name,p.conditions]));
const G=9.80665,probe={settleS:20,windowS:6,batteryTruthV:12.6,batteryTruthA:0,linesHashedFrames:8000};
const neutralMeans=()=>({samples:2000,statusSamples:60,accel:[0,0,-G*ACCEL_SCALE],gyro:[0,0,0],mag:[0.23,0.05,-0.53],
  pressurePa:94503.8,voltageMv:12600,currentCa:0,gnssFixes:30});
const neutralLines={frames:8000,sha256:'a'.repeat(64)};
function sensorCase(id,change=()=>{}){
  const c={id,expected:[{name:'SIM_BARO_RND',value:0}],parameters:{SIM_BARO_RND:0,SIM_ACC1_BIAS_X:0,SIM_GPS2_ENABLE:0},
    confirmedAtS:2,means:neutralMeans(),lines:{...neutralLines},configuration:null,user:{}};
  change(c);return c;
}
function cases(){
  return [
    sensorCase('ideal'),
    sensorCase('zero-offsets'),
    sensorCase('specified',c=>{
      c.configuration={magnetometer:{biasGauss:[0.05,-0.03,0.02]},barometer:{biasPa:30},gnss:{updateRateHz:10},
        battery:{voltageGainError:0.02,voltageOffsetV:-0.15,currentOffsetA:0.4}};
      c.means.mag=[0.28,0.02,-0.51];c.means.pressurePa+=30;c.means.voltageMv=12702;c.means.currentCa=40;c.means.gnssFixes=60;
    }),
    sensorCase('imu-bias',c=>{
      c.configuration={imu:{accelBiasMps2:[0.5,-0.3,0.2],gyroBiasRadS:[0.01,0,-0.02]}};c.user={SIM_ACC1_BIAS_X:0.4};
      c.means.accel=[ACCEL_SCALE*0.5,ACCEL_SCALE*-0.3,ACCEL_SCALE*(0.2-G)];c.means.gyro=[0.01,0,-0.02];
    }),
    sensorCase('imu-tilt',c=>{
      c.configuration={imu:{orientationRad:[0,0.05,0]}};
      c.means.accel=[G*Math.sin(0.05),0,-G*Math.cos(0.05)].map(v=>ACCEL_SCALE*v);
    }),
    sensorCase('zero-terms'),
    sensorCase('noise-a',c=>{c.lines={frames:8000,sha256:'b'.repeat(64)};}),
    sensorCase('noise-b',c=>{c.lines={frames:8000,sha256:'b'.repeat(64)};}),
    sensorCase('noise-c',c=>{c.lines={frames:8000,sha256:'c'.repeat(64)};}),
  ];
}
const named=(all,id)=>all.find(c=>c.id===id);
function failed(mutate){const all=cases();mutate(all);return assessSensorCases(all,conditions,probe).checks.filter(c=>!c.pass).map(c=>c.id);}
`;

it('passes the analytic case set', () => nodeCheck(`${SETUP}
assert.equal(assessSensorCases(cases(),conditions,probe).status,'PASS');
`));

it('fails each check when its condition is broken', () => nodeCheck(`${SETUP}
const mutations=[
  ['a bias applied twice',all=>{named(all,'imu-bias').means.accel[0]+=ACCEL_SCALE*0.4;},'accelerometer bias applied once, over a conflicting SIM_ACC1_BIAS'],
  ["ArduPilot's bias left on",all=>{named(all,'imu-bias').parameters.SIM_ACC1_BIAS_X=0.4;},'accelerometer bias applied once, over a conflicting SIM_ACC1_BIAS'],
  ['gyro bias missing',all=>{named(all,'imu-bias').means.gyro=[0,0,0];},'gyroscope bias applied once'],
  ['a broken hard-iron pairing',all=>{named(all,'zero-offsets').means.mag=[0.235,0.063,-0.546];},'hard-iron pairing nets to zero'],
  ['the magnetometer bias doubled',all=>{named(all,'specified').means.mag=[0.33,-0.01,-0.49];},'magnetometer bias applied once'],
  ['a tilt with the wrong sign',all=>{named(all,'imu-tilt').means.accel[0]*=-1;},'IMU misalignment matches Ryᵀ·g'],
  ['a barometer bias with the wrong sign',all=>{named(all,'specified').means.pressurePa-=60;},'barometer bias applied once'],
  ['battery gain missing',all=>{named(all,'specified').means.voltageMv=12450;},'battery measurement errors applied once'],
  ['GNSS rate not set',all=>{named(all,'specified').means.gnssFixes=30;},'GNSS update rate set; Ideal keeps the stock 5 Hz'],
  ['a zero term that changes a bit',all=>{named(all,'zero-terms').lines.sha256='d'.repeat(64);},'zero terms deliver the neutral lines bit for bit'],
  ['a seed that does not repeat',all=>{named(all,'noise-b').lines.sha256='e'.repeat(64);},'a seed repeats the delivered lines; another seed changes them'],
  ['noise that does nothing',all=>{for(const id of ['noise-a','noise-b'])named(all,id).lines={...neutralLines};},'a seed repeats the delivered lines; another seed changes them'],
  ['a parameter read back late',all=>{named(all,'ideal').confirmedAtS=21;},'ideal: parameters read back before the window'],
  ['a parameter with another value',all=>{named(all,'ideal').parameters.SIM_BARO_RND=0.2;},'ideal: parameters read back before the window'],
  ['a parameter the build should have',all=>{named(all,'ideal').expected.push({name:'SIM_MAG_RND',value:0});},'ideal: parameters read back before the window'],
  ['too few samples',all=>{named(all,'noise-c').means.samples=LIMITS.minimumSamples-1;},'noise-c: enough samples'],
];
for(const [label,mutate,check] of mutations)assert.deepEqual(failed(mutate),[check],label);
`));

it('accepts only the parameters a build legitimately lacks', () => nodeCheck(`${SETUP}
assert.equal(absentAllowed('SIM_ACC4_BIAS_X',conditions,{}),true);
assert.equal(absentAllowed('SIM_GYR5_RND',conditions,{}),true);
assert.equal(absentAllowed('SIM_GPS2_LAG_MS',conditions,{SIM_GPS2_ENABLE:0}),true);
assert.equal(absentAllowed('SIM_GPS2_LAG_MS',conditions,{SIM_GPS2_ENABLE:1}),false);
assert.equal(absentAllowed('SIM_GPS1_LAG_MS',conditions,{SIM_GPS2_ENABLE:0}),false);
assert.equal(absentAllowed('SIM_ACC1_BIAS_X',conditions,{}),false);
assert.equal(absentAllowed('COMPASS_OFS_X',conditions,{}),false);
`));

it('computes window means from the forwarded telemetry only', () => nodeCheck(`${SETUP}
const imu=(t,x)=>({receivedSimS:t,message:{mavpackettype:'HIGHRES_IMU',xacc:x,yacc:0,zacc:-G,xgyro:0,ygyro:0,zgyro:0,xmag:0.2,ymag:0,zmag:0,abs_pressure:945}});
const events=[imu(19.9,100),imu(20,1),imu(23,3),imu(26,5),imu(26.1,100),
  {receivedSimS:21,message:{mavpackettype:'SYS_STATUS',voltage_battery:12600,current_battery:0}},
  {receivedSimS:21,message:{mavpackettype:'GPS_RAW_INT',time_usec:1}},{receivedSimS:22,message:{mavpackettype:'GPS_RAW_INT',time_usec:1}},
  {receivedSimS:23,message:{mavpackettype:'GPS_RAW_INT',time_usec:2}}];
const means=windowMeans(events,20,26);
assert.deepEqual([means.samples,means.accel[0],means.pressurePa,means.voltageMv,means.gnssFixes],[3,3,94500,12600,2]);
`));
