// TASK-154: parameter read-back before arming and the tagged initial
// parameters of an integrated run. Oracles: PARAM_VALUE frames packed
// independently by pymavlink 2.4.50 (skipped without the TASK-127 venv), the
// GroundStation's parameter requests decoded by pymavlink, the absent-name
// cases of TASK-147 (tests/integration/sitl-sensors.test.ts), and
// sensorRuntime itself over the pinned catalog for the sensor parameters.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MavParser, type MavFrame } from '../packages/mavlink/src/codec.ts';
import { GroundStation } from '../packages/autopilot/src/ground-station.ts';
import { parseArduPilotCatalog } from '../packages/autopilot/src/error-ownership.ts';
import {
  absentAllowed, catalogAbsentRule, ParameterReadback, type AbsentRule, type ExpectedParameter,
} from '../packages/autopilot/src/parameter-readback.ts';
import { validateComponentCard } from '../packages/aircraft/src/components.ts';
import { combineMassProperties } from '../packages/aircraft/src/derive-manifest.ts';
import { FRAME_PARAMETER_NAMES } from '../packages/aircraft/src/frame-parameters.ts';
import { profileDraft, validateAircraftProfile, withPropellerPolars, withSensorConfiguration } from '../packages/aircraft/src/profile.ts';
import { DEFAULT_SENSOR_CONFIGURATION, type SensorConfiguration, type Vector3 } from '../packages/aircraft/src/sensor-fields.ts';
import { sensorSnapshot } from '../packages/aircraft/src/sensor-ownership.ts';
import { sensorRuntime, STOCK_COMPASS_OFFSETS_MILLIGAUSS } from '../packages/aircraft/src/sensor-parameters.ts';
import { applySensorPreset } from '../packages/aircraft/src/sensor-presets.ts';
import { canonicalBytes } from '../packages/project/src/schema.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import { DEFAULT_HOME, prepareVehicle, requireUniqueNames } from '../apps/web/src/sitl/sitl-run.ts';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const json = (path: string): unknown => JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures', path), 'utf8'));
const catalogFile = json('sitl/ardupilot-catalog.json');
const catalog = parseArduPilotCatalog(catalogFile);
const rule = catalogAbsentRule(catalog);
const PYTHON = join(process.cwd(), '.cache/task-127/venv/bin/python');
/** MAV_PARAM_TYPE_REAL32. */
const REAL32 = 9;

/** [param_id, param_value, param_count, param_index] of one PARAM_VALUE. */
type ValueSpec = readonly [string, number, number, number];
/** Packs PARAM_VALUE frames from system 1, component 1 with pymavlink. */
function pymavlinkFrames(specs: readonly ValueSpec[]): Uint8Array[] {
  const script = `
import json, sys
from pymavlink.dialects.v20 import ardupilotmega
mav = ardupilotmega.MAVLink(None, srcSystem=1, srcComponent=1)
out = []
for name, value, count, index in json.loads(sys.argv[1]):
    out.append(mav.param_value_encode(name.encode(), value, ${REAL32}, count, index).pack(mav).hex())
    mav.seq = (mav.seq + 1) % 256
print(json.dumps(out))
`;
  const result = spawnSync(PYTHON, ['-I', '-c', script, JSON.stringify(specs)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  const hex: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(hex)) throw new Error('pymavlink returned no frame list');
  return hex.map(item => {
    if (typeof item !== 'string') throw new Error('pymavlink returned a non-hex frame');
    return Uint8Array.from(Buffer.from(item, 'hex'));
  });
}
function feed(readback: ParameterReadback, frames: readonly Uint8Array[]): number {
  let taken = 0;
  const parser = new MavParser((frame: MavFrame) => { if (readback.ingest(frame)) taken++; });
  for (const bytes of frames) parser.push(bytes);
  return taken;
}

const EXPECTED: readonly ExpectedParameter[] = [
  { name: 'FRAME_CLASS', value: 1 }, { name: 'MOT_PWM_MIN', value: 1000 },
  // Not a float32: the autopilot reports Math.fround of it.
  { name: 'SIM_GPS1_HNSE', value: Math.SQRT2 * 1.5 },
];
/** The complete list of four parameters, index order. */
const LIST: readonly ValueSpec[] = [
  ['FRAME_CLASS', 1, 4, 0], ['MOT_PWM_MIN', 1000, 4, 1], ['SIM_GPS1_HNSE', Math.SQRT2 * 1.5, 4, 2], ['SIM_GPS2_ENABLE', 0, 4, 3],
];

describe('ParameterReadback over pymavlink PARAM_VALUE', () => {
  it.skipIf(!existsSync(PYTHON))('is complete only when the received indices equal param_count, and a repeated index is idempotent', () => {
    const frames = pymavlinkFrames(LIST), readback = new ParameterReadback(EXPECTED, rule);
    expect(readback.verdict()).toEqual({ kind: 'incomplete', received: 0, total: null });
    expect(feed(readback, [frames[0]!, frames[1]!, frames[2]!])).toBe(3);
    expect(readback.verdict()).toEqual({ kind: 'incomplete', received: 3, total: 4 });
    // The same index three times still counts once.
    feed(readback, [frames[2]!, frames[2]!, frames[0]!]);
    expect(readback.verdict()).toEqual({ kind: 'incomplete', received: 3, total: 4 });
    feed(readback, [frames[3]!]);
    expect(readback.verdict()).toEqual({ kind: 'confirmed' });
    feed(readback, frames);
    expect(readback.verdict()).toEqual({ kind: 'confirmed' });
    expect(readback.received).toBe(4);
  });

  it.skipIf(!existsSync(PYTHON))('ignores answers outside the list and other senders, and restarts the indices on a new param_count', () => {
    const readback = new ParameterReadback(EXPECTED, rule);
    // param_index 65535 answers a read by name: the value counts, but it is no list entry.
    feed(readback, pymavlinkFrames([['SIM_GPS2_ENABLE', 0, 4, 65535]]));
    expect(readback.reported('SIM_GPS2_ENABLE')).toBe(0);
    expect(readback.verdict()).toEqual({ kind: 'incomplete', received: 0, total: null });
    feed(readback, pymavlinkFrames([LIST[0]!, LIST[1]!, LIST[2]!]));
    // A list of five renumbers it: the four indices of the old count do not complete it.
    feed(readback, pymavlinkFrames([['FRAME_CLASS', 1, 5, 0], ['MOT_PWM_MIN', 1000, 5, 1], ['SIM_GPS1_HNSE', Math.SQRT2 * 1.5, 5, 2]]));
    expect(readback.verdict()).toEqual({ kind: 'incomplete', received: 3, total: 5 });
    feed(readback, pymavlinkFrames([['SIM_GPS2_ENABLE', 0, 5, 3], ['SCR_ENABLE', 0, 5, 4]]));
    expect(readback.verdict()).toEqual({ kind: 'confirmed' });
    // A frame of another component, or of another system, is not the autopilot's.
    const otherComponent = new ParameterReadback(EXPECTED, rule, 1, 2);
    expect(feed(otherComponent, pymavlinkFrames(LIST))).toBe(0);
    const otherSystem = new ParameterReadback(EXPECTED, rule, 2, 1);
    expect(feed(otherSystem, pymavlinkFrames(LIST))).toBe(0);
    expect(otherSystem.verdict()).toEqual({ kind: 'incomplete', received: 0, total: null });
  });

  it.skipIf(!existsSync(PYTHON))('lists every difference of a complete list in the given order, for a SITL the user started (TASK-155)', () => {
    const readback = new ParameterReadback(EXPECTED, rule);
    feed(readback, pymavlinkFrames([LIST[0]!, LIST[1]!]));
    expect(readback.differences()).toBeNull();
    // MOT_PWM_MIN at another value and SIM_GPS1_HNSE missing: the verdict names the first, differences() all of them.
    const differing = new ParameterReadback(EXPECTED, rule);
    feed(differing, pymavlinkFrames([['FRAME_CLASS', 1, 3, 0], ['MOT_PWM_MIN', 1100, 3, 1], ['SIM_GPS2_ENABLE', 0, 3, 2]]));
    expect(differing.verdict()).toEqual({ kind: 'mismatch', name: 'MOT_PWM_MIN', reported: 1100, expected: 1000 });
    expect(differing.differences()).toEqual([
      { name: 'MOT_PWM_MIN', expected: 1000, reported: 1100 }, { name: 'SIM_GPS1_HNSE', expected: Math.SQRT2 * 1.5, reported: null },
    ]);
    // A complete, matching list has none, with the float32 comparison of the verdict.
    const matching = new ParameterReadback(EXPECTED, rule);
    feed(matching, pymavlinkFrames(LIST));
    expect(matching.differences()).toEqual([]);
  });

  it.skipIf(!existsSync(PYTHON))('judges presence from the current enumeration only, so a name a renumbered list drops is absent', () => {
    // The complete list of four confirms; then the autopilot renumbers it to three without SIM_GPS1_HNSE (hidden, say, by an *_ENABLE change).
    const shrunk = new ParameterReadback(EXPECTED, rule);
    feed(shrunk, pymavlinkFrames(LIST));
    expect(shrunk.verdict()).toEqual({ kind: 'confirmed' });
    feed(shrunk, pymavlinkFrames([['FRAME_CLASS', 1, 3, 0], ['MOT_PWM_MIN', 1000, 3, 1], ['SIM_GPS2_ENABLE', 0, 3, 2]]));
    expect(shrunk.reported('SIM_GPS1_HNSE')).toBeUndefined();
    expect(shrunk.verdict()).toEqual({ kind: 'absent', name: 'SIM_GPS1_HNSE' });
    // An answer outside the list during the enumeration counts; one received before it does not.
    const answered = new ParameterReadback(EXPECTED, rule);
    feed(answered, pymavlinkFrames([['SIM_GPS1_HNSE', Math.SQRT2 * 1.5, 3, 65535]]));
    feed(answered, pymavlinkFrames([['FRAME_CLASS', 1, 3, 0], ['MOT_PWM_MIN', 1000, 3, 1], ['SIM_GPS2_ENABLE', 0, 3, 2]]));
    expect(answered.verdict()).toEqual({ kind: 'absent', name: 'SIM_GPS1_HNSE' });
    feed(answered, pymavlinkFrames([['SIM_GPS1_HNSE', Math.SQRT2 * 1.5, 3, 65535]]));
    expect(answered.verdict()).toEqual({ kind: 'confirmed' });
    // An answer outside the list with another param_count renumbers it too: the old indices no longer complete it.
    feed(answered, pymavlinkFrames([['SIM_GPS2_ENABLE', 1, 4, 65535]]));
    expect(answered.verdict()).toEqual({ kind: 'incomplete', received: 0, total: 4 });
    expect(answered.reported('FRAME_CLASS')).toBeUndefined();
  });

  it.skipIf(!existsSync(PYTHON))('compares as float32 and names a mismatched parameter with both values', () => {
    const readback = new ParameterReadback(EXPECTED, rule);
    feed(readback, pymavlinkFrames(LIST));
    expect(readback.reported('SIM_GPS1_HNSE')).toBe(Math.fround(Math.SQRT2 * 1.5));
    expect(readback.reported('SIM_GPS1_HNSE')).not.toBe(Math.SQRT2 * 1.5);
    expect(readback.verdict()).toEqual({ kind: 'confirmed' });
    const wrong = new ParameterReadback(EXPECTED, rule);
    feed(wrong, pymavlinkFrames([LIST[0]!, ['MOT_PWM_MIN', 1100, 4, 1], LIST[2]!, LIST[3]!]));
    expect(wrong.verdict()).toEqual({ kind: 'mismatch', name: 'MOT_PWM_MIN', reported: 1100, expected: 1000 });
    // One float32 step away is a mismatch too.
    const near = new ParameterReadback([{ name: 'SIM_BARO_RND', value: 0.2 }], rule);
    const bits = new DataView(new ArrayBuffer(4));
    bits.setFloat32(0, 0.2);
    bits.setUint32(0, bits.getUint32(0) + 1);
    const above = bits.getFloat32(0); // the next float32 above Math.fround(0.2)
    feed(near, pymavlinkFrames([['SIM_BARO_RND', above, 1, 0]]));
    expect(near.verdict()).toEqual({ kind: 'mismatch', name: 'SIM_BARO_RND', reported: Math.fround(above), expected: 0.2 });
  });

  it.skipIf(!existsSync(PYTHON))('accepts only the absent names the TASK-147 rule excuses', () => {
    const base: readonly ValueSpec[] = [['SIM_ACC1_BIAS_X', 0, 2, 0], ['SIM_GPS2_ENABLE', 0, 2, 1]];
    const judge = (name: string, list: readonly ValueSpec[] = base) => {
      const readback = new ParameterReadback([{ name, value: 0 }], rule);
      feed(readback, pymavlinkFrames(list));
      return readback.verdict();
    };
    // An instance this build does not compile, and SIM_GPS2_* while SIM_GPS2_ENABLE is 0.
    expect(judge('SIM_ACC4_BIAS_X')).toEqual({ kind: 'confirmed' });
    expect(judge('SIM_GYR5_RND')).toEqual({ kind: 'confirmed' });
    expect(judge('SIM_GPS2_LAG_MS')).toEqual({ kind: 'confirmed' });
    expect(judge('SIM_GPS2_LAG_MS', [['SIM_ACC1_BIAS_X', 0, 2, 0], ['SIM_GPS2_ENABLE', 1, 2, 1]])).toEqual({ kind: 'absent', name: 'SIM_GPS2_LAG_MS' });
    expect(judge('SIM_GPS1_LAG_MS')).toEqual({ kind: 'absent', name: 'SIM_GPS1_LAG_MS' });
    expect(judge('SIM_BARO_RND')).toEqual({ kind: 'absent', name: 'SIM_BARO_RND' });
    expect(judge('COMPASS_OFS_X')).toEqual({ kind: 'absent', name: 'COMPASS_OFS_X' });
  });
});

describe('the absent-name rule', () => {
  it('gives the TASK-147 cases over the catalog conditions', () => {
    const conditions = new Map([...catalog.parameters].map(([name, parameter]) => [name, parameter.conditions]));
    const values = (entries: Record<string, number>) => (name: string) => entries[name];
    const cases: [string, Record<string, number>, boolean][] = [
      ['SIM_ACC4_BIAS_X', {}, true], ['SIM_GYR5_RND', {}, true], ['SIM_GPS2_LAG_MS', { SIM_GPS2_ENABLE: 0 }, true],
      ['SIM_GPS2_LAG_MS', { SIM_GPS2_ENABLE: 1 }, false], ['SIM_GPS1_LAG_MS', { SIM_GPS2_ENABLE: 0 }, false],
      ['SIM_ACC1_BIAS_X', {}, false], ['COMPASS_OFS_X', {}, false],
    ];
    for (const [name, reported, allowed] of cases) {
      expect(absentAllowed(name, conditions, values(reported)), name).toBe(allowed);
      expect(rule(name, values(reported)), `${name} over the parsed catalog`).toBe(allowed);
    }
  });
  it('refuses invalid expectations', () => {
    const never: AbsentRule = () => false;
    expect(() => new ParameterReadback([{ name: 'A', value: 1 }, { name: 'A', value: 2 }], never)).toThrow('Parameter A is listed twice');
    expect(() => new ParameterReadback([{ name: 'SIM_NAME_LONGER_THAN_16', value: 1 }], never)).toThrow('Invalid parameter name');
    expect(() => new ParameterReadback([{ name: 'A', value: Number.NaN }], never)).toThrow('Parameter A has no finite value');
  });
});

describe('GroundStation parameter requests', () => {
  const gcs = new GroundStation(), out = new Uint8Array(64);
  const list = out.slice(0, gcs.paramRequestListInto(out)), read = out.slice(0, gcs.paramRequestReadInto('SIM_GPS2_ENABLE', out));
  it('parse back with the TASK-150 codec', () => {
    const parsed: [number, number, number, number][] = [];
    new MavParser((frame: MavFrame) => parsed.push([frame.id, frame.sequence, frame.systemId, frame.componentId])).push(Uint8Array.from([...list, ...read]));
    expect(parsed).toEqual([[21, 0, 255, 190], [20, 1, 255, 190]]);
    expect(gcs.paramRequestReadInto('', out)).toBe(0);
    expect(gcs.paramRequestReadInto('SIM_NAME_LONGER_THAN_16', out)).toBe(0);
    expect(gcs.paramRequestReadInto('SIM_É', out)).toBe(0);
    // A NUL would cut the name short on the wire; other control characters and spaces are no names either.
    expect(gcs.paramRequestReadInto('SIM\u0000X', out)).toBe(0);
    expect(gcs.paramRequestReadInto('SIM_BARO\tRND', out)).toBe(0);
    expect(gcs.paramRequestReadInto('SIM BARO', out)).toBe(0);
  });
  it.skipIf(!existsSync(PYTHON))('decode identically in pymavlink 2.4.50', () => {
    const script = `
import json, sys
from pymavlink.dialects.v20 import ardupilotmega
parser = ardupilotmega.MAVLink(None)
out = []
for h in json.loads(sys.argv[1]):
    m = parser.parse_char(bytes.fromhex(h))
    d = m.to_dict()
    out.append([m.get_type(), m.get_srcSystem(), m.get_srcComponent(), m.get_seq(), d["target_system"], d["target_component"]] + ([d["param_id"], d["param_index"]] if m.get_type() == "PARAM_REQUEST_READ" else []))
print(json.dumps(out))
`;
    const hex = [list, read].map(bytes => Buffer.from(bytes).toString('hex'));
    const result = spawnSync(PYTHON, ['-I', '-c', script, JSON.stringify(hex)], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      ['PARAM_REQUEST_LIST', 255, 190, 0, 1, 1],
      ['PARAM_REQUEST_READ', 255, 190, 1, 1, 1, 'SIM_GPS2_ENABLE', -1],
    ]);
  });
});

// An S19 profile fixture on the example cards with NACA6409, as tests/support/quad-profile.ts builds the quad X, but stored with the cards it names.
async function quadStore(config: SensorConfiguration | null, fixtureName = 'quad-x') {
  const store = new ProjectStore(new MemoryBackend(), { storage: null,
    validators: { 'aircraft-profile': validateAircraftProfile, 'component-card': validateComponentCard } });
  const project = await store.createProject('Run');
  const card = async (type: string): Promise<string> => {
    const base = json(`components/${type}-example.json`);
    if (typeof base !== 'object' || base === null || !('values' in base) || typeof base.values !== 'object' || base.values === null) {
      throw new Error(`Invalid ${type} card fixture`);
    }
    const provenance = Object.fromEntries(Object.entries(base.values).map(([key, value]) => [key, value === null ? null : 'example']));
    return (await store.createItem(project.record.id, 'component-card', { name: type, payload: validateComponentCard({ ...base, provenance }) })).sha256;
  };
  const motor = await card('motor'), propeller = await card('propeller'), esc = await card('esc'), battery = await card('battery');
  const fixture = validateAircraftProfile(json(`aircraft/${fixtureName}.json`));
  const profile = withSensorConfiguration(withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: battery },
    motors: fixture.motors.map(item => ({ ...item, components: { motor, propeller, esc } })) }),
  [{ card: propeller, polar: 'naca6409-neuralfoil-v1' }]), config);
  const stored = await store.createItem(project.record.id, 'aircraft-profile', profileDraft('Quad', profile));
  return { store, stored, profile };
}
function configure(change: (config: Mutable<SensorConfiguration>) => void): SensorConfiguration {
  const config = structuredClone(DEFAULT_SENSOR_CONFIGURATION) as Mutable<SensorConfiguration>;
  change(config);
  return config;
}
const PWM = ['MOT_PWM_MIN', 'MOT_PWM_MAX'];

describe('prepareVehicle initial parameters', () => {
  it('tags the frame, output and PWM parameters; the ArduPilot defaults add no sensor parameter', async () => {
    const { store, stored } = await quadStore(null);
    const vehicle = await prepareVehicle(store, stored);
    expect(vehicle.parameters.filter(p => p.source === 'sensor')).toEqual([]);
    expect(vehicle.parameters.filter(p => p.source === 'pwm')).toEqual([
      { name: 'MOT_PWM_MIN', value: 1000, source: 'pwm' }, { name: 'MOT_PWM_MAX', value: 2000, source: 'pwm' }]);
    for (const p of vehicle.parameters.filter(item => item.source === 'frame' || item.source === 'output')) {
      expect(FRAME_PARAMETER_NAMES.has(p.name), p.name).toBe(true);
      expect(p.source, p.name).toBe(/^SERVO[0-9]+_FUNCTION$/.test(p.name) ? 'output' : 'frame');
    }
    expect(vehicle.parameters.filter(p => p.source === 'frame').map(p => p.name)).toEqual(['FRAME_CLASS', 'FRAME_TYPE', 'SERVO_32_ENABLE']);
    expect(vehicle.parameters.filter(p => p.source === 'output').length).toBeGreaterThanOrEqual(4);
    expect(Buffer.from(canonicalBytes(vehicle.sensorSnapshot)).equals(Buffer.from(canonicalBytes(sensorSnapshot(stored))))).toBe(true);
    expect(vehicle.sensorSnapshot).toMatchObject({ profileSha256: stored.sha256, configuration: null });
    expect(vehicle.frameScript).toBeNull();
  });

  it('tags SCR_ENABLE as a frame parameter on a scripting-matrix profile', async () => {
    // The S19 octa X spins the mirror of stock OCTA X, so TASK-142 gives it the scripting matrix.
    const { store, stored } = await quadStore(null, 'octa-x');
    const vehicle = await prepareVehicle(store, stored);
    expect(vehicle.frameScript).not.toBeNull();
    expect(vehicle.parameters.filter(p => p.source === 'frame').map(p => p.name)).toEqual(['FRAME_CLASS', 'FRAME_TYPE', 'SERVO_32_ENABLE', 'SCR_ENABLE']);
    expect(vehicle.parameters.find(p => p.name === 'SCR_ENABLE')).toEqual({ name: 'SCR_ENABLE', value: 1, source: 'frame' });
    // With 32-channel packets every output gets a function: the eight motors, the rest disabled.
    expect(vehicle.parameters.filter(p => p.source === 'output').map(p => p.name)).toEqual(
      Array.from({ length: 32 }, (_, i) => `SERVO${i + 1}_FUNCTION`));
  });

  it('refuses a name generated by two sources', () => {
    const frame = { name: 'FRAME_CLASS', value: 1, source: 'frame' } as const, pwm = { name: 'MOT_PWM_MIN', value: 1000, source: 'pwm' } as const;
    expect(() => requireUniqueNames([frame, pwm])).not.toThrow();
    expect(() => requireUniqueNames([frame, pwm, { name: 'MOT_PWM_MIN', value: 1100, source: 'sensor' }]))
      .toThrow('MOT_PWM_MIN is generated twice, as a parameter of sources pwm and sensor');
    expect(() => requireUniqueNames([frame, { ...frame, source: 'output' }])).toThrow('FRAME_CLASS is generated twice');
  });

  it('adds exactly the SIM_* parameters sensorRuntime generates, disjoint from the frame and PWM names', async () => {
    const cases: [string, SensorConfiguration, number | null][] = [
      // TASK-147 confirmed 168 generated Ideal parameters on native ArduCopter 8ab6afde (docs/PROJECT_ROADMAP.md, TASK-147 evidence); V4.7.2 lacks SIM_GPSn_HNSE (2) and SIM_BAROn_GEFF_M (3).
      ['Ideal', configure(c => { c.mode = 'ideal'; }), 163],
      ['ArduPilot-owned values', configure(c => {
        c.barometer.noiseRmsPa = 3; c.barometer.biasPa = 20; c.gnss.updateRateHz = 10; c.gnss.horizontalSigmaM = 1.5; c.magnetometer.biasGauss = [0.01, 0, -0.02];
      }), null],
    ];
    for (const [label, config, count] of cases) {
      const { store, stored, profile } = await quadStore(config);
      const vehicle = await prepareVehicle(store, stored);
      const cg = combineMassProperties(profile.massProperties, profile.payload).cgOffsetBodyM;
      const oracle = sensorRuntime(config, catalog, { homeAltitudeM: DEFAULT_HOME[2], compassOffsetsMilliGauss: STOCK_COMPASS_OFFSETS_MILLIGAUSS,
        cgBodyM: [cg[0]!, cg[1]!, cg[2]!] satisfies Vector3 }).parameters;
      const sensors = vehicle.parameters.filter(p => p.source === 'sensor');
      expect(sensors.map(p => ({ name: p.name, value: p.value })), label).toEqual(oracle);
      if (count !== null) expect(sensors.length, label).toBe(count);
      expect(sensors.length, label).toBeGreaterThan(0);
      expect(sensors.every(p => p.name.startsWith('SIM_')), label).toBe(true);
      const others = new Set(vehicle.parameters.filter(p => p.source !== 'sensor').map(p => p.name));
      expect(sensors.filter(p => others.has(p.name) || PWM.includes(p.name) || FRAME_PARAMETER_NAMES.has(p.name)), label).toEqual([]);
      expect(new Set(vehicle.parameters.map(p => p.name)).size, label).toBe(vehicle.parameters.length);
      // Sensor parameters follow the frame and PWM ones.
      expect(vehicle.parameters.slice(-sensors.length), label).toEqual(sensors);
    }
  });

  it('refuses a profile that sets a MirageSITL-owned sensor error, naming it', async () => {
    const bias = await quadStore(configure(c => { c.imu.accelBiasMps2 = [0.1, 0, 0]; c.barometer.noiseRmsPa = 3; }));
    await expect(prepareVehicle(bias.store, bias.stored)).rejects.toThrow('Accelerometer bias (imu.accelBiasMps2)');
    const battery = await quadStore(configure(c => { c.battery.voltageOffsetV = 0.1; }));
    await expect(prepareVehicle(battery.store, battery.stored)).rejects.toThrow(/does not apply MirageSITL-owned sensor errors.*battery\.voltageOffsetV/);
    const preset = applySensorPreset(DEFAULT_SENSOR_CONFIGURATION, { catalogVersion: 1, id: 'imu-icm-42688-p' }).configuration;
    const noise = await quadStore(preset);
    await expect(prepareVehicle(noise.store, noise.stored)).rejects.toThrow('imu.accelNoiseDensityMps2PerSqrtHz), Gyroscope noise density (imu.gyroNoiseDensityRadSPerSqrtHz)');
    // A neutral value is refused too: the profile configures the term, and this path applies none.
    const zero = await quadStore(configure(c => { c.imu.gyroBiasRadS = [0, 0, 0]; }));
    await expect(prepareVehicle(zero.store, zero.stored)).rejects.toThrow('(imu.gyroBiasRadS)');
  });
});
