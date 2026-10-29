// Cold TASK-147 audit of a native sensor-probe capture (scripts/sitl/sensor-probe.mjs).
// It recomputes every value from the forwarded MAVLink telemetry and the
// firmware's complete parameter list, independently of the probe's own
// bookkeeping, and checks: every generated parameter read back before the
// window; ArduPilot's hard-iron pairing against TASK-089's zero neutral; each
// specified error applied once with its analytic size; zero terms and seeds
// reproducing the delivered JSON lines bit for bit.
//   node scripts/check-sitl-sensors.mjs --input CAPTURE_DIRECTORY [--report PATH]
// Exit 0 PASS, 1 FAIL, 2 missing input (BLOCKED_EXTERNAL).
import {existsSync,readFileSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const G=9.80665;
/** Limits fixed from the noise model before the run (means of at least LIMITS.minimumSamples samples; 5 standard errors). */
export const LIMITS=Object.freeze({
  minimumSamples:1500,
  // Magnetometer noise is zero in every compared case; float32 means.
  magGauss:1e-5,
  // Accelerometer noise floor σ = 5.77e-3 m/s² per case; difference of two means.
  accelMps2:1e-3,
  // Gyro floor added twice at rest, σ ≈ 5.7e-4 rad/s per case.
  gyroRadS:1e-4,
  pressurePa:1,
  batteryMilliVolt:1,
  batteryCentiAmp:1,
  gnssFixes:1,
});
/** ArduPilot's copter.parm accelerometer calibration, INS_ACCSCAL 1.001, which scales every accelerometer difference. */
export const ACCEL_SCALE=1.001;

/** Window means of HIGHRES_IMU and SYS_STATUS and the distinct GNSS fix times. */
export function windowMeans(events,startS,endS){
  const inWindow=events.filter(e=>e.receivedSimS>=startS&&e.receivedSimS<=endS);
  const of=type=>inWindow.filter(e=>e.message.mavpackettype===type).map(e=>e.message);
  const mean=(rows,key)=>rows.reduce((sum,row)=>sum+row[key],0)/rows.length;
  const imu=of('HIGHRES_IMU'),status=of('SYS_STATUS');
  return {samples:imu.length,statusSamples:status.length,
    accel:['xacc','yacc','zacc'].map(k=>mean(imu,k)),gyro:['xgyro','ygyro','zgyro'].map(k=>mean(imu,k)),
    mag:['xmag','ymag','zmag'].map(k=>mean(imu,k)),pressurePa:100*mean(imu,'abs_pressure'),
    voltageMv:mean(status,'voltage_battery'),currentCa:mean(status,'current_battery'),
    gnssFixes:new Set(of('GPS_RAW_INT').map(m=>m.time_usec)).size};
}

/** True for a generated parameter the build legitimately lacks: a cataloged instance it does not compile, or a hidden second receiver. */
export function absentAllowed(name,catalogConditions,parameters){
  const base=catalogConditions.has(name)?name:name.replace(/_[XYZ]$/,'');
  const conditions=catalogConditions.get(base);
  if(!conditions)return false;
  if(conditions.some(c=>/^#if (INS_MAX_INSTANCES|HAL_COMPASS_MAX_SENSORS) > [1-9]$/.test(c)))return true;
  // SIM_GPS2_ENABLE carries AP_PARAM_FLAG_ENABLE: the rest of its group is hidden while it is 0.
  return name.startsWith('SIM_GPS2_')&&parameters.SIM_GPS2_ENABLE===0;
}

/**
 * Judges the cases. Each case: {id, expected, parameters, confirmedAtS, means, lines, configuration}.
 * Returns {status, checks}; every check names what it compared.
 */
export function assessSensorCases(cases,catalogConditions,probe){
  const checks=[],byId=new Map(cases.map(c=>[c.id,c]));
  const check=(id,pass,detail)=>checks.push({id,pass:Boolean(pass),detail});
  const need=id=>{const c=byId.get(id);if(!c)throw Error(`Missing case ${id}`);return c;};
  const near=(a,b,limit)=>a.length===b.length&&a.every((v,i)=>Math.abs(v-b[i])<=limit);
  const minus=(a,b)=>a.map((v,i)=>v-b[i]);
  for(const c of cases){
    const missing=[],wrong=[];
    for(const p of c.expected){
      const value=c.parameters[p.name];
      if(value===undefined){if(!absentAllowed(p.name,catalogConditions,c.parameters))missing.push(p.name);}
      else if(value!==Math.fround(p.value))wrong.push(`${p.name}=${value}≠${p.value}`);
    }
    check(`${c.id}: parameters read back before the window`,missing.length===0&&wrong.length===0&&c.confirmedAtS!==null&&c.confirmedAtS<probe.settleS,
      {expected:c.expected.length,missing,wrong,confirmedAtS:c.confirmedAtS});
    check(`${c.id}: enough samples`,c.means.samples>=LIMITS.minimumSamples&&c.means.statusSamples>=probe.windowS*5,{samples:c.means.samples,statusSamples:c.means.statusSamples});
  }
  const ideal=need('ideal'),zero=need('zero-offsets'),spec=need('specified'),bias=need('imu-bias'),tilt=need('imu-tilt');
  // Hard iron: Ideal's SIM_MAGn_OFS = COMPASS_OFSn reads the same field as TASK-089's zero neutral.
  check('hard-iron pairing nets to zero',near(ideal.means.mag,zero.means.mag,1e-6),{ideal:ideal.means.mag,zeroOffsets:zero.means.mag});
  const magBias=spec.configuration.magnetometer.biasGauss;
  check('magnetometer bias applied once',near(minus(spec.means.mag,ideal.means.mag),magBias,LIMITS.magGauss),{difference:minus(spec.means.mag,ideal.means.mag),bias:magBias});
  // IMU errors against the ArduPilot defaults, which keep the same stock gyro drift.
  const accelBias=bias.configuration.imu.accelBiasMps2,gyroBias=bias.configuration.imu.gyroBiasRadS;
  check('accelerometer bias applied once, over a conflicting SIM_ACC1_BIAS',
    near(minus(bias.means.accel,zero.means.accel),accelBias.map(v=>ACCEL_SCALE*v),LIMITS.accelMps2)&&bias.parameters.SIM_ACC1_BIAS_X===0,
    {difference:minus(bias.means.accel,zero.means.accel),expected:accelBias.map(v=>ACCEL_SCALE*v),userSetting:bias.user,reportedSimAcc1BiasX:bias.parameters.SIM_ACC1_BIAS_X});
  check('gyroscope bias applied once',near(minus(bias.means.gyro,zero.means.gyro),gyroBias,LIMITS.gyroRadS),{difference:minus(bias.means.gyro,zero.means.gyro),bias:gyroBias});
  const pitch=tilt.configuration.imu.orientationRad[1];
  const tiltExpected=[G*Math.sin(pitch),0,G*(1-Math.cos(pitch))].map(v=>ACCEL_SCALE*v);
  check('IMU misalignment matches Ryᵀ·g',near(minus(tilt.means.accel,zero.means.accel),tiltExpected,LIMITS.accelMps2),
    {difference:minus(tilt.means.accel,zero.means.accel),expected:tiltExpected});
  const baro=spec.configuration.barometer.biasPa;
  check('barometer bias applied once',Math.abs(spec.means.pressurePa-ideal.means.pressurePa-baro)<=LIMITS.pressurePa,{difference:spec.means.pressurePa-ideal.means.pressurePa,bias:baro});
  const b=spec.configuration.battery,volts=(1+b.voltageGainError)*probe.batteryTruthV+b.voltageOffsetV,amps=(1+(b.currentGainError??0))*probe.batteryTruthA+b.currentOffsetA;
  check('battery measurement errors applied once',Math.abs(spec.means.voltageMv-1000*volts)<=LIMITS.batteryMilliVolt&&Math.abs(spec.means.currentCa-100*amps)<=LIMITS.batteryCentiAmp&&
    Math.abs(ideal.means.voltageMv-1000*probe.batteryTruthV)<=LIMITS.batteryMilliVolt&&Math.abs(ideal.means.currentCa)<=LIMITS.batteryCentiAmp,
    {specified:[spec.means.voltageMv,spec.means.currentCa],expected:[1000*volts,100*amps],ideal:[ideal.means.voltageMv,ideal.means.currentCa]});
  const rate=spec.configuration.gnss.updateRateHz;
  check('GNSS update rate set; Ideal keeps the stock 5 Hz',Math.abs(spec.means.gnssFixes-rate*probe.windowS)<=LIMITS.gnssFixes&&Math.abs(ideal.means.gnssFixes-5*probe.windowS)<=LIMITS.gnssFixes,
    {specified:spec.means.gnssFixes,expected:rate*probe.windowS,ideal:ideal.means.gnssFixes});
  // Delivered JSON lines: zero terms equal absent ones; seeds repeat.
  const lines=id=>need(id).lines;
  check('zero terms deliver the neutral lines bit for bit',lines('zero-terms').sha256===lines('ideal').sha256&&lines('ideal').sha256===lines('zero-offsets').sha256&&
    lines('ideal').frames===probe.linesHashedFrames,{zeroTerms:lines('zero-terms'),ideal:lines('ideal'),zeroOffsets:lines('zero-offsets')});
  check('a seed repeats the delivered lines; another seed changes them',lines('noise-a').sha256===lines('noise-b').sha256&&lines('noise-a').sha256!==lines('noise-c').sha256&&
    lines('noise-a').sha256!==lines('ideal').sha256,{a:lines('noise-a').sha256,b:lines('noise-b').sha256,c:lines('noise-c').sha256});
  return {status:checks.every(c=>c.pass)?'PASS':'FAIL',checks};
}

/** Reads and judges a capture directory; source inputs must be unchanged since the capture. */
export function auditSensorCapture(input){
  const directory=resolve(input),artifacts=[];
  const read=(...parts)=>{const path=join(directory,...parts);if(statSync(path).size>64*1024*1024)throw Error('Capture file exceeds budget');
    const bytes=readFileSync(path);artifacts.push({file:parts.join('/'),sha256:sha(bytes),bytes:bytes.length});return bytes;};
  const run=JSON.parse(read('run.json').toString());
  if(run.task!=='TASK-147'||run.status!=='captured')throw Error('Not a captured TASK-147 sensor probe');
  for(const source of run.inputs){
    if(source.file.includes('..')||source.file.startsWith('/'))throw Error('Invalid input path');
    if(sha(readFileSync(join(root,source.file)))!==source.sha256)throw Error(`Source changed since the capture: ${source.file}`);
  }
  const catalog=JSON.parse(readFileSync(join(root,'tests/fixtures/sitl/ardupilot-catalog.json'),'utf8'));
  const conditions=new Map(catalog.simParameters.map(p=>[p.name,p.conditions]));
  const cases=run.cases.map(id=>{
    const record=JSON.parse(read(id,'case.json').toString()),parameters=JSON.parse(read(id,'parameters.json').toString());
    if(record.status!=='captured'||Object.keys(parameters.values).length!==parameters.parameterCount)throw Error(`Case ${id} lacks its complete parameter list`);
    const events=read(id,'telemetry.ndjson').toString().trim().split('\n').map(line=>JSON.parse(line));
    return {...record,parameters:parameters.values,means:windowMeans(events,run.probe.settleS,run.probe.settleS+run.probe.windowS)};
  });
  const result=assessSensorCases(cases,conditions,run.probe);
  return {schemaVersion:1,kind:'sitl-sensors-report',task:'TASK-147',status:result.status,checks:result.checks,
    capture:{firmwareSha256:run.firmwareSha256,sourceCommit:run.sourceCommit,copterDefaultsSha256:run.copterDefaultsSha256,recordedAt:run.recordedAt,node:run.node,cases:run.cases,artifacts},
    means:Object.fromEntries(cases.map(c=>[c.id,c.means])),limits:LIMITS};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const at=name=>{const i=process.argv.indexOf(name);return i>0?process.argv[i+1]:undefined;};
  const input=at('--input'),report=at('--report');
  if(!input||!existsSync(join(resolve(input),'run.json'))){console.error('BLOCKED_EXTERNAL: --input must name a TASK-147 sensor capture');process.exit(2);}
  let result;
  try{result=auditSensorCapture(input);}catch(error){result={schemaVersion:1,kind:'sitl-sensors-report',task:'TASK-147',status:'FAIL',reasons:[error.message]};}
  if(report){mkdirSync(dirname(resolve(report)),{recursive:true});writeFileSync(resolve(report),JSON.stringify(result,null,2)+'\n');}
  for(const c of result.checks??[])console.log(`${c.pass?'PASS':'FAIL'} ${c.id}`);
  console.log(`TASK-147 sensors: ${result.status}${result.reasons?` (${result.reasons.join('; ')})`:''}`);
  process.exitCode=result.status==='PASS'?0:1;
}
