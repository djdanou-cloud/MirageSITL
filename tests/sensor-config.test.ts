// TASK-143 (S08): sensor configuration schema 1, ownership mapping 1, presets
// and the experiment snapshot. Oracles: a hand-typed table of every field's
// unit, range and owner; TASK-089's own matrix functions and the pinned
// catalog; hand-computed preset conversions; the SHA-256 of the corrected
// sensor catalog document; and the project store's fixed experiment inputs.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  ERROR_SOURCE_IDS, imuNoiseFloorMatrix, ownershipParameterProfile, parseArduPilotCatalog, validateOwnershipMatrix,
} from '../packages/autopilot/src/error-ownership.ts';
import { bindMeasurements } from '../packages/aircraft/src/calculation-mode.ts';
import { validateAircraftProfile, profileDraft, withSensorConfiguration, type AircraftProfile } from '../packages/aircraft/src/profile.ts';
import { readField, sensorConfigurationSchema, sensorConfigurationSchemaErrors, validateSensorConfiguration } from '../packages/aircraft/src/sensor-config.ts';
import {
  DEFAULT_SENSOR_CONFIGURATION, SENSOR_FIELDS, type SensorConfiguration, type SensorFieldPath,
} from '../packages/aircraft/src/sensor-fields.ts';
import { resolveSensorConfiguration, sensorOwnershipMatrix, sensorSnapshot } from '../packages/aircraft/src/sensor-ownership.ts';
import {
  applySensorPreset, latestPresetCatalog, parseSensorPresetFile,
} from '../packages/aircraft/src/sensor-presets.ts';
import { canonicalBytes } from '../packages/project/src/schema.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = parseArduPilotCatalog(json('./fixtures/sitl/ardupilot-catalog.json'));
const quadX = (): AircraftProfile => validateAircraftProfile(json('./fixtures/aircraft/quad-x.json'));
const settings = (parm: string) => parm.split('\n').filter(line => line !== '' && !line.startsWith('#'));
function configure(change: (config: Mutable<SensorConfiguration>) => void): SensorConfiguration {
  const config = structuredClone(DEFAULT_SENSOR_CONFIGURATION) as Mutable<SensorConfiguration>;
  change(config);
  return config;
}

/** Hand-typed: unit, range and owner of every field on native-json (mapping 1). */
const ORACLE: readonly [SensorFieldPath, string, number | 'euler', number | 'euler', 'mirage' | 'ardupilot' | 'ardupilot-locked' | 'unassigned'][] = [
  ['imu.accelNoiseDensityMps2PerSqrtHz', 'm/s²/√Hz', 0, 0.01, 'mirage'],
  ['imu.gyroNoiseDensityRadSPerSqrtHz', 'rad/s/√Hz', 0, 0.001, 'mirage'],
  ['imu.accelBiasMps2', 'm/s²', -2, 2, 'mirage'],
  ['imu.gyroBiasRadS', 'rad/s', -0.2, 0.2, 'mirage'],
  ['imu.latencyUs', 'µs', 0, 100000, 'unassigned'],
  ['imu.positionBodyM', 'm', -2, 2, 'mirage'],
  ['imu.orientationRad', 'rad', 'euler', 'euler', 'unassigned'],
  ['gnss.updateRateHz', 'Hz', 1, 20, 'ardupilot-locked'],
  ['gnss.horizontalSigmaM', 'm', 0, 100, 'ardupilot-locked'],
  ['gnss.verticalSigmaM', 'm', 0, 100, 'ardupilot-locked'],
  ['gnss.velocitySigmaMps', 'm/s', 0, 10, 'ardupilot-locked'],
  ['gnss.latencyUs', 'µs', 0, 1000000, 'ardupilot-locked'],
  ['barometer.noiseRmsPa', 'Pa', 0, 50, 'ardupilot'],
  ['barometer.biasPa', 'Pa', -500, 500, 'ardupilot'],
  ['barometer.latencyUs', 'µs', 0, 490000, 'ardupilot'],
  ['magnetometer.noiseRmsGauss', 'G', 0, 0.1, 'ardupilot'],
  ['magnetometer.biasGauss', 'G', -0.4, 0.4, 'ardupilot'],
  ['magnetometer.positionBodyM', 'm', -2, 2, 'unassigned'],
  ['magnetometer.orientationRad', 'rad', 'euler', 'euler', 'unassigned'],
  ['battery.voltageGainError', '1', -0.1, 0.1, 'unassigned'],
  ['battery.voltageOffsetV', 'V', -2, 2, 'unassigned'],
  ['battery.voltageNoiseRmsV', 'V', 0, 1, 'unassigned'],
  ['battery.currentGainError', '1', -0.2, 0.2, 'unassigned'],
  ['battery.currentOffsetA', 'A', -20, 20, 'unassigned'],
  ['battery.currentNoiseRmsA', 'A', 0, 10, 'unassigned'],
];
/** Hand-typed from the TASK-089 matrix and the pinned catalog: each field's error source and the ArduPilot parameters it maps to. */
const SOURCES: { readonly [path: string]: readonly [string | null, readonly string[]] } = {
  'imu.accelNoiseDensityMps2PerSqrtHz': ['imu.accel.noise', ['SIM_ACC1_RND', 'SIM_ACC2_RND', 'SIM_ACC3_RND', 'SIM_ACC4_RND', 'SIM_ACC5_RND']],
  'imu.gyroNoiseDensityRadSPerSqrtHz': ['imu.gyro.noise', ['SIM_GYR1_RND', 'SIM_GYR2_RND', 'SIM_GYR3_RND', 'SIM_GYR4_RND', 'SIM_GYR5_RND']],
  'imu.accelBiasMps2': ['imu.accel.bias', ['SIM_ACC1_BIAS', 'SIM_ACC2_BIAS', 'SIM_ACC3_BIAS', 'SIM_ACC4_BIAS', 'SIM_ACC5_BIAS']],
  'imu.gyroBiasRadS': ['imu.gyro.bias', ['SIM_GYR1_BIAS', 'SIM_GYR2_BIAS', 'SIM_GYR3_BIAS', 'SIM_GYR4_BIAS', 'SIM_GYR5_BIAS']],
  'imu.latencyUs': [null, []], 'imu.positionBodyM': ['imu.lever-arm', ['SIM_IMU_POS']], 'imu.orientationRad': [null, ['SIM_IMU_ORIENT']],
  'gnss.updateRateHz': ['gnss.receiver', ['SIM_GPS1_HZ']], 'gnss.horizontalSigmaM': ['gnss.receiver', ['SIM_GPS1_NOISE']],
  'gnss.verticalSigmaM': ['gnss.receiver', ['SIM_GPS1_NOISE']], 'gnss.velocitySigmaMps': ['gnss.receiver', ['SIM_GPS1_VERR']],
  'gnss.latencyUs': ['gnss.receiver', ['SIM_GPS1_LAG_MS']],
  'barometer.noiseRmsPa': ['baro.noise', ['SIM_BARO_RND', 'SIM_BAR2_RND', 'SIM_BAR3_RND']],
  'barometer.biasPa': ['baro.glitch', ['SIM_BARO_GLITCH', 'SIM_BAR2_GLITCH', 'SIM_BAR3_GLITCH']],
  'barometer.latencyUs': ['baro.delay', ['SIM_BARO_DELAY', 'SIM_BAR2_DELAY', 'SIM_BAR3_DELAY']],
  'magnetometer.noiseRmsGauss': ['mag.noise', ['SIM_MAG_RND']], 'magnetometer.biasGauss': ['mag.hard-iron', ['SIM_MAG1_OFS', 'SIM_MAG2_OFS', 'SIM_MAG3_OFS']],
  'magnetometer.positionBodyM': [null, []], 'magnetometer.orientationRad': [null, ['SIM_MAG1_ORIENT']],
};
/** A configuration whose only value is one field, set to a value of its shape. */
function withValue(path: SensorFieldPath, value: number | readonly number[] | null): unknown {
  const [sensor = '', key = ''] = path.split('.');
  const config = structuredClone(DEFAULT_SENSOR_CONFIGURATION);
  const block: unknown = Reflect.get(config, sensor);
  if (typeof block !== 'object' || block === null) throw new Error(`No block ${sensor}`);
  Reflect.set(block, key, value);
  return config;
}
const shaped = (path: SensorFieldPath, value: number) => {
  const spec = SENSOR_FIELDS.find(item => item.path === path);
  return spec?.shape === 'vector3' ? [0, value, 0] : value;
};
/** A value just beyond a bound: the next integer for integers, otherwise a step at the bound's scale. */
const beyond = (path: SensorFieldPath, bound: number, direction: 1 | -1) => {
  const spec = SENSOR_FIELDS.find(item => item.path === path);
  return spec?.shape === 'integer' ? bound + direction : bound + direction * Math.max(Math.abs(bound), 1) * 1e-9;
};

describe('sensor configuration schema 1', () => {
  test('every field has the unit, range and owner of the hand-typed table', () => {
    expect(SENSOR_FIELDS.map(spec => spec.path)).toEqual(ORACLE.map(([path]) => path));
    const blocks = sensorConfigurationSchema.properties;
    for (const [path, unit, minimum, maximum, owner] of ORACLE) {
      const spec = SENSOR_FIELDS.find(item => item.path === path);
      const [sensor = '', key = ''] = path.split('.');
      const property: unknown = Reflect.get(Reflect.get(Reflect.get(blocks, sensor) ?? {}, 'properties') ?? {}, key);
      expect(Reflect.get(property ?? {}, 'x-unit'), path).toBe(unit);
      expect(spec?.siUnit, path).toBe(unit);
      expect([spec?.source ?? null, spec?.ardupilotParameters], path).toEqual(SOURCES[path] ?? [null, []]);
      if (minimum !== 'euler' && maximum !== 'euler') expect([spec?.minimum, spec?.maximum, spec?.exclusiveMinimum], path).toEqual([minimum, maximum, false]);
      else expect([spec?.minimum, spec?.maximum, spec?.exclusiveMinimum], path).toEqual([-Math.PI, Math.PI, true]);
      for (const name of spec?.ardupilotParameters ?? []) {
        // Every named parameter is in the pinned catalog, with its vector axes where it has them.
        expect(catalog.parameters.has(name), name).toBe(true);
      }
      expect(spec?.owner === 'ardupilot' && !spec.applicable ? 'ardupilot-locked' : spec?.owner, path).toBe(owner);
      expect(spec?.applicable, path).toBe(owner === 'mirage' || owner === 'ardupilot');
      expect(spec?.applicable ? spec.disabledReason : typeof spec?.disabledReason, path).toBe(spec?.applicable ? null : 'string');
      if (minimum === 'euler' || maximum === 'euler') continue;
      // The schema accepts both bounds and rejects values just beyond them, locked fields included.
      for (const value of [minimum, maximum]) expect(sensorConfigurationSchemaErrors(withValue(path, shaped(path, value))), `${path} ${value}`).toEqual([]);
      expect(sensorConfigurationSchemaErrors(withValue(path, shaped(path, beyond(path, minimum, -1)))).join(), path).toMatch(/must be >=/);
      expect(sensorConfigurationSchemaErrors(withValue(path, shaped(path, beyond(path, maximum, 1)))).join(), path).toMatch(/must be <=/);
    }
    // Orientation: roll and yaw in (-π, π], pitch in [-π/2, π/2].
    for (const path of ['imu.orientationRad', 'magnetometer.orientationRad'] as const) {
      expect(sensorConfigurationSchemaErrors(withValue(path, [Math.PI, Math.PI / 2, Math.PI]))).toEqual([]);
      expect(sensorConfigurationSchemaErrors(withValue(path, [-Math.PI, 0, 0])).join()).toMatch(/must be >/);
      expect(sensorConfigurationSchemaErrors(withValue(path, [0, -Math.PI / 2 - 1e-9, 0])).join()).toMatch(/must be >=/);
    }
    expect(sensorConfigurationSchemaErrors(withValue('gnss.updateRateHz', 5.5)).join()).toMatch(/must be integer/);
    expect(sensorConfigurationSchemaErrors(withValue('imu.accelBiasMps2', [0, 0])).join()).toMatch(/must NOT have fewer than 3 items/);
  });

  test('the code checks name what the schema cannot', () => {
    const cases: [string, unknown, string][] = [
      ['a locked GNSS value', withValue('gnss.horizontalSigmaM', 1.5), 'GNSS horizontal position error (1σ per axis) cannot be applied on native-json yet: ArduPilot\'s SITL receiver'],
      ['a locked battery value', withValue('battery.voltageOffsetV', 0.1), 'Voltage offset cannot be applied on native-json yet: The TASK-089 matrix has no battery source'],
      ['a locked IMU latency', withValue('imu.latencyUs', 1000), 'IMU latency cannot be applied on native-json yet'],
      ['a barometer latency of 1.5 ms', withValue('barometer.latencyUs', 1500), 'Barometer latency must be a whole number of milliseconds'],
      ['an unknown preset', configure(c => { c.imu.preset = { catalogVersion: 1, id: 'imu-unknown' }; }), 'IMU preset imu-unknown is not in preset catalog 1'],
      ['a future catalog', configure(c => { c.imu.preset = { catalogVersion: 2, id: 'imu-icm-42688-p' }; }), 'is not in preset catalog 2'],
      ['a preset of another sensor', configure(c => { c.barometer.preset = { catalogVersion: 1, id: 'baro-ms5611' }; c.imu.preset = { catalogVersion: 1, id: 'baro-ms5611' }; }), 'IMU preset baro-ms5611 is a barometer preset'],
      ['an unknown mode', configure(c => { Object.assign(c, { mode: 'noisy' }); }), '/mode must be equal to one of the allowed values'],
      ['an extra key', configure(c => { Object.assign(c.imu, { scale: 1 }); }), '/imu must NOT have additional properties'],
    ];
    for (const [label, input, message] of cases) expect(() => validateSensorConfiguration(input), label).toThrow(message);
    expect(validateSensorConfiguration(withValue('barometer.latencyUs', 2000)).barometer.latencyUs).toBe(2000);
    expect(readField(validateSensorConfiguration(withValue('imu.gyroBiasRadS', [0.01, 0, -0.01])), 'imu.gyroBiasRadS')).toEqual([0.01, 0, -0.01]);
  });
});

describe('profile schema 3', () => {
  test('a configuration makes schema 3; the ArduPilot defaults go back to null without changing other bytes', () => {
    const v1 = quadX(), config = withValue('barometer.noiseRmsPa', 1.2);
    const v3 = withSensorConfiguration(v1, validateSensorConfiguration(config));
    expect(v3.schemaVersion).toBe(3);
    expect(v3.schemaVersion === 3 && v3.calculation).toEqual({ mode: 'preliminary', measurementSets: [] });
    // Back to the defaults: schema 1 stays byte-identical to the original; schema 2 and 3 become 2.
    expect(Buffer.from(canonicalBytes(withSensorConfiguration(v3, null))).equals(Buffer.from(canonicalBytes(v1)))).toBe(false);
    const reset = withSensorConfiguration(v1, DEFAULT_SENSOR_CONFIGURATION);
    expect(Buffer.from(canonicalBytes(reset)).equals(Buffer.from(canonicalBytes(v1)))).toBe(true);
    expect(withSensorConfiguration(v3, null).schemaVersion).toBe(2);
    expect(withSensorConfiguration(v3, DEFAULT_SENSOR_CONFIGURATION).schemaVersion).toBe(2);
    expect(profileDraft('Quad', v3).dependencies).toEqual(profileDraft('Quad', v1).dependencies);
    const base = v3 as Mutable<AircraftProfile>;
    const invalid: [string, unknown, string][] = [
      ['schema 3 with the defaults', { ...base, sensorConfiguration: DEFAULT_SENSOR_CONFIGURATION }, 'ArduPilot sensor defaults are stored as null'],
      ['schema 2 with a configuration', { ...base, schemaVersion: 2 }, 'Schema 2 profiles hold no sensor configuration'],
      ['schema 1 with a configuration', { ...v1, sensorConfiguration: config }, 'Schema 1 profiles hold no sensor configuration'],
      ['schema 3 without a calculation', { ...v1, schemaVersion: 3, sensorConfiguration: config }, 'Schema 3 profiles need a calculation'],
      ['an out-of-range value in a profile', { ...base, sensorConfiguration: withValue('barometer.noiseRmsPa', 60) }, 'Invalid aircraft profile: Invalid sensor configuration: /barometer/noiseRmsPa must be <= 50'],
      ['a locked value in a profile', { ...base, sensorConfiguration: withValue('gnss.latencyUs', 100000) }, 'Invalid aircraft profile: Invalid sensor configuration: GNSS latency cannot be applied'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateAircraftProfile(input), label).toThrow(message);
  });

  test('binding measurement sets keeps schema 3 and its configuration', async () => {
    const v3 = withSensorConfiguration(quadX(), validateSensorConfiguration(withValue('imu.positionBodyM', [0.01, 0, 0.02])));
    const preliminary = await bindMeasurements(v3, 'preliminary', []);
    expect(preliminary.schemaVersion).toBe(3);
    expect(preliminary.sensorConfiguration).toEqual(v3.sensorConfiguration);
  });
});

describe('ownership mapping 1 on native-json', () => {
  test('the ArduPilot defaults are TASK-089\'s own default matrix and set no parameter', () => {
    const matrix = sensorOwnershipMatrix(null);
    expect(matrix.entries).toEqual(imuNoiseFloorMatrix('ardupilot', 'native-json').entries);
    expect(settings(ownershipParameterProfile(matrix, catalog))).toEqual([]);
    expect(resolveSensorConfiguration(null).state).toBe('ardupilot-defaults');
    // Specified with nothing given is the same as the defaults; schema 3 never stores it.
    expect(sensorOwnershipMatrix(DEFAULT_SENSOR_CONFIGURATION).entries).toEqual(matrix.entries);
  });

  test('Ideal neutralizes every error a setting can neutralize and keeps the stored values inert', () => {
    const ideal = configure(c => { c.mode = 'ideal'; });
    const full = configure(c => {
      c.mode = 'ideal'; c.imu.accelNoiseDensityMps2PerSqrtHz = 7e-4; c.imu.gyroBiasRadS = [0.01, 0, 0]; c.barometer.noiseRmsPa = 3;
      c.magnetometer.biasGauss = [0.1, 0, 0];
    });
    expect(resolveSensorConfiguration(full).fields.map(f => f.effective)).toEqual(resolveSensorConfiguration(ideal).fields.map(f => f.effective));
    expect(sensorOwnershipMatrix(full).entries).toEqual(sensorOwnershipMatrix(ideal).entries);
    const matrix = validateOwnershipMatrix(sensorOwnershipMatrix(ideal), catalog);
    // No MirageSITL owner in Ideal; only what the validator forces, and the stock hard-iron pairing, stay with ArduPilot.
    expect(matrix.entries.filter(e => e.owner === 'ardupilot').map(e => e.source)).toEqual(['imu.accel.noise-floor', 'imu.gyro.noise-floor', 'mag.hard-iron', 'gnss.receiver']);
    expect(matrix.entries.filter(e => e.owner === 'mirage')).toEqual([]);
    const lines = settings(ownershipParameterProfile(matrix, catalog));
    expect(lines).toEqual(expect.arrayContaining(['SIM_DRIFT_SPEED 0', 'SIM_BAR2_RND 0', 'SIM_BAR3_RND 0', 'SIM_IMU_POS_X 0', 'SIM_ACC1_RND 0',
      'SIM_GYR5_BIAS_Z 0', 'SIM_MAG_RND 0', 'SIM_BARO_DELAY 0', 'SIM_BRD_TRIM_Z 0']));
    expect(lines.filter(line => /^(SIM_MAG\d_OFS|SIM_GPS|GPS\d_TYPE|SIM_ACC_FLOOR|SIM_GYR_FLOOR)/.test(line))).toEqual([]);
    expect(lines).toHaveLength(143);
    // Every MirageSITL-owned field is at its neutral value: zero, a zero vector, or no lever arm.
    const neutral = Object.fromEntries(resolveSensorConfiguration(full).fields.filter(f => f.owner === 'mirage').map(f => [f.path, f.effective]));
    expect(neutral).toEqual({
      'imu.accelNoiseDensityMps2PerSqrtHz': { kind: 'neutral', value: 0 }, 'imu.gyroNoiseDensityRadSPerSqrtHz': { kind: 'neutral', value: 0 },
      'imu.accelBiasMps2': { kind: 'neutral', value: [0, 0, 0] }, 'imu.gyroBiasRadS': { kind: 'neutral', value: [0, 0, 0] },
      'imu.positionBodyM': { kind: 'neutral', value: 'at-cg' },
    });
    expect(resolveSensorConfiguration(ideal).residuals.slice(0, 2)).toEqual(['imu-accel-noise-floor', 'imu-gyro-noise-floor']);
  });

  test('every excluded owner\'s basis holds against the TASK-089 validator', () => {
    const base = imuNoiseFloorMatrix('ardupilot', 'native-json');
    let checked = 0;
    for (const spec of SENSOR_FIELDS) {
      for (const excluded of spec.excludedOwners) {
        const source = spec.source;
        if (!source) throw new Error(`${spec.path} excludes an owner without a source`);
        const deliveries = { 'imu.accel.noise': ['json:imu.accel_body'], 'imu.gyro.noise': ['json:imu.gyro'], 'mag.hard-iron': ['mavlink:sim-mag-offsets'],
          'gnss.receiver': ['mavlink:gps-input'] } as Record<string, string[]>;
        const matrix = { ...base, entries: base.entries.map(e => (e.source === source ? { source, owner: excluded.owner, delivery: excluded.owner === 'mirage' ? deliveries[source] ?? [] : [] } : e)) };
        const attempt = () => validateOwnershipMatrix(matrix, catalog);
        if (excluded.basis === 'validator') expect(attempt, `${spec.path} ${excluded.owner}`).toThrow('No repository-evidenced path');
        else expect(attempt, `${spec.path} ${excluded.owner}`).not.toThrow();
        checked++;
      }
    }
    expect(checked).toBe(SENSOR_FIELDS.filter(spec => spec.excludedOwners.length > 0).length);
  });

  test('specified values give MirageSITL exactly the IMU sources it delivers in the JSON state line', () => {
    const imuPaths = ['imu.accelNoiseDensityMps2PerSqrtHz', 'imu.gyroNoiseDensityRadSPerSqrtHz', 'imu.accelBiasMps2', 'imu.gyroBiasRadS', 'imu.positionBodyM'] as const;
    const sources = ['imu.accel.noise', 'imu.gyro.noise', 'imu.accel.bias', 'imu.gyro.bias', 'imu.lever-arm'] as const;
    const deliveries = [['json:imu.accel_body'], ['json:imu.gyro'], ['json:imu.accel_body'], ['json:imu.gyro'], ['json:imu.accel_body']];
    imuPaths.forEach((path, i) => {
      const matrix = validateOwnershipMatrix(sensorOwnershipMatrix(validateSensorConfiguration(withValue(path, shaped(path, 1e-4)))), catalog);
      expect(matrix.entries.filter(e => e.owner !== 'ardupilot'), path).toEqual([{ source: sources[i], owner: 'mirage', delivery: deliveries[i] }]);
      // MirageSITL ownership switches ArduPilot's version off; it sets no enabler.
      expect(settings(ownershipParameterProfile(matrix, catalog)).length, path).toBeGreaterThan(0);
    });
    // ArduPilot-owned values keep every source with ArduPilot: TASK-147 writes their SIM values.
    const baro = sensorOwnershipMatrix(validateSensorConfiguration(configure(c => { c.barometer.noiseRmsPa = 2.7; c.magnetometer.biasGauss = [0.01, 0, 0]; })));
    expect(baro.entries.every(e => e.owner === 'ardupilot')).toBe(true);
    expect(ERROR_SOURCE_IDS.length).toBe(25);
    const resolved = resolveSensorConfiguration(validateSensorConfiguration(withValue('barometer.noiseRmsPa', 2.7)));
    expect(resolved.fields.find(f => f.path === 'barometer.noiseRmsPa')?.effective).toEqual({ kind: 'specified', value: 2.7 });
    expect(resolved.fields.find(f => f.path === 'imu.accelBiasMps2')?.effective).toEqual({ kind: 'not-applied' });
    expect(resolved.fields.find(f => f.path === 'magnetometer.biasGauss')?.effective).toEqual({ kind: 'ardupilot-stock' });
    expect(resolved.fields.find(f => f.path === 'gnss.latencyUs')?.effective).toEqual({ kind: 'ardupilot-stock' });
    expect(resolved.fields.find(f => f.path === 'battery.currentOffsetA')?.effective).toEqual({ kind: 'not-applied' });
  });
});

describe('presets', () => {
  test('catalog 1 rests on the corrected sensor catalog and converts each datasheet value exactly', () => {
    const doc = readFileSync(new URL('../docs/hardware/ardupilot-sensors.md', import.meta.url));
    const latest = latestPresetCatalog();
    expect(latest.basis.sha256).toBe(createHash('sha256').update(doc).digest('hex'));
    // Hand-computed: 70 µg/√Hz = 6.864655e-4 m/s²/√Hz; 2.8 mdps/√Hz = 4.8869219e-5 rad/s/√Hz; 15 nT = 1.5e-4 G;
    // 2.0 m CEP50 / √(2 ln 2) = 1.6986436 m; 1.25 mV / √12 = 3.6084392e-4 V.
    const values = Object.fromEntries(latest.presets.flatMap(p => p.values.map(v => [`${p.id} ${v.field}`, v.value])));
    const expected: [string, number][] = [
      ['imu-icm-42688-p imu.accelNoiseDensityMps2PerSqrtHz', 6.864655e-4], ['imu-icm-42688-p imu.gyroNoiseDensityRadSPerSqrtHz', 4.8869219055841e-5],
      ['baro-ms5611 barometer.noiseRmsPa', 2.7], ['mag-rm3100 magnetometer.noiseRmsGauss', 1.5e-4],
      ['gnss-neo-m9n gnss.horizontalSigmaM', 1.6986436005760], ['battery-ina226 battery.voltageNoiseRmsV', 3.6084391824352e-4],
    ];
    expect(Object.keys(values).sort()).toEqual(expected.map(([key]) => key).sort());
    for (const [key, value] of expected) expect(Math.abs((values[key] ?? NaN) - value) / value, key).toBeLessThan(1e-12);
    // Released catalogs are append-only: catalog 1's bytes are pinned.
    expect(createHash('sha256').update(canonicalBytes(latest)).digest('hex')).toBe(PINNED_CATALOG_1);
  });

  test('a preset fills only applicable same-statistic fields and says why it skipped the rest', () => {
    const imu = applySensorPreset(DEFAULT_SENSOR_CONFIGURATION, { catalogVersion: 1, id: 'imu-icm-42688-p' });
    expect(imu.applied).toEqual(['imu.accelNoiseDensityMps2PerSqrtHz', 'imu.gyroNoiseDensityRadSPerSqrtHz']);
    expect(validateSensorConfiguration(imu.configuration).imu).toMatchObject({ preset: { catalogVersion: 1, id: 'imu-icm-42688-p' }, accelBiasMps2: null });
    const gnss = applySensorPreset(DEFAULT_SENSOR_CONFIGURATION, { catalogVersion: 1, id: 'gnss-neo-m9n' });
    expect(gnss.applied).toEqual([]);
    expect(gnss.skipped.map(s => s.field)).toEqual(['gnss.horizontalSigmaM']);
    expect(gnss.skipped[0]?.reason).toContain('AP_SIM_GPS_ENABLED');
    expect(validateSensorConfiguration(gnss.configuration).gnss.horizontalSigmaM).toBeNull();
    // Other values of the block stay.
    const kept = applySensorPreset(validateSensorConfiguration(withValue('barometer.biasPa', 20)), { catalogVersion: 1, id: 'baro-ms5611' });
    expect(kept.configuration.barometer).toMatchObject({ noiseRmsPa: 2.7, biasPa: 20 });
  });

  test('a preset file that misstates a value, a statistic or a source is refused', () => {
    const file = json('../packages/aircraft/src/sensor-presets.json') as Mutable<{ schemaVersion: 1; catalogs: { catalogVersion: number; citations: { id: string }[];
      presets: { id: string; sensor: string; values: { field: string; value: number; datasheet: { statistic: string }; citation: string }[] }[] }[] }>;
    const edit = (change: (f: typeof file) => void) => { const copy = structuredClone(file); change(copy); return copy; };
    const preset = (f: typeof file, index = 0) => f.catalogs[0]!.presets[index]!;
    const cases: [string, unknown, string][] = [
      ['a rounded value', edit(f => { preset(f).values[0]!.value = 6.86e-4; }), 'is not the ug-to-mps2 conversion of 70'],
      ['an RMS in a density field', edit(f => { preset(f).values[0]!.datasheet.statistic = 'rms'; }), 'a rms value cannot fill imu.accelNoiseDensityMps2PerSqrtHz'],
      ['an unknown source', edit(f => { preset(f).values[0]!.citation = 'X9'; }), 'cites unknown source X9'],
      ['a field of another sensor', edit(f => { preset(f).values[0]!.field = 'barometer.noiseRmsPa'; }), 'sets barometer.noiseRmsPa of another sensor'],
      ['a misnamed preset', edit(f => { preset(f).id = 'baro-icm-42688-p'; }), 'is not named for its sensor imu'],
      ['catalog 2 first', edit(f => { f.catalogs[0]!.catalogVersion = 2; }), 'versions are 1, 2'],
      ['a repeated preset', edit(f => { f.catalogs[0]!.presets.push(structuredClone(preset(f))); }), 'is repeated'],
      ['a CEP50 stored unconverted', edit(f => { const g = f.catalogs[0]!.presets.find(p => p.id === 'gnss-neo-m9n')!; Object.assign(g.values[0]!, { conversion: 'identity', value: 2 }); }), 'the identity conversion cannot carry a cep50 value'],
      ['a density in the wrong unit', edit(f => { Object.assign(preset(f).values[0]!.datasheet, { unit: 'mg/√Hz' }); }), 'the ug-to-mps2 conversion takes µg/√Hz, not mg/√Hz'],
      ['a preset bias', edit(f => { Object.assign(preset(f).values[0]!, { field: 'imu.accelBiasMps2' }); }), 'sets imu.accelBiasMps2, which presets do not fill'],
    ];
    for (const [label, input, message] of cases) expect(() => parseSensorPresetFile(input), label).toThrow(message);
  });
});

describe('experiment copy', () => {
  test('an experiment keeps the sensor snapshot of its exact profile version', async () => {
    const store = new ProjectStore(new MemoryBackend(), { storage: null, validators: { 'aircraft-profile': validateAircraftProfile } });
    const project = await store.createProject('Sensors');
    const v1 = await store.createItem(project.record.id, 'aircraft-profile', profileDraft('Quad', quadX()));
    const specified = applySensorPreset(DEFAULT_SENSOR_CONFIGURATION, { catalogVersion: 1, id: 'imu-icm-42688-p' }).configuration;
    const v2 = await store.saveVersion(v1.record.id, v1.sha256, profileDraft('Quad', withSensorConfiguration(quadX(), specified)));
    const snapshot = sensorSnapshot(v2);
    const experiment = await store.createItem(project.record.id, 'experiment', { name: 'Run 1', payload: { sensors: snapshot }, dependencies: [v2.sha256] });
    const v3 = await store.saveVersion(v1.record.id, v2.sha256, profileDraft('Quad', withSensorConfiguration(quadX(), configure(c => { c.mode = 'ideal'; }))));
    const kept = await store.get(experiment.sha256);
    expect(kept.record.dependencies.map(d => d.sha256)).toEqual([v2.sha256]);
    expect(Buffer.from(canonicalBytes(Reflect.get(kept.record.payload, 'sensors'))).equals(Buffer.from(canonicalBytes(sensorSnapshot(await store.get(v2.sha256)))))).toBe(true);
    expect(sensorSnapshot(v3).resolution.state).toBe('ideal');
    expect(snapshot).toMatchObject({ schemaVersion: 1, profileSha256: v2.sha256, mappingVersion: 1, configuration: specified });
    expect(snapshot.resolution.state).toBe('specified');
    expect(snapshot.resolution.fields.filter(f => f.effective.kind === 'specified').map(f => [f.path, f.effective])).toEqual([
      ['imu.accelNoiseDensityMps2PerSqrtHz', { kind: 'specified', value: 6.864654999999999e-4 }],
      ['imu.gyroNoiseDensityRadSPerSqrtHz', { kind: 'specified', value: 4.8869219055841225e-5 }],
    ]);
    expect(snapshot.resolution.residuals).toEqual(['imu-accel-noise-floor', 'imu-gyro-noise-floor', 'gnss-sitl-receiver', 'mag-hard-iron-pairing',
      'ins-accel-calibration', 'imu-sample-rates', 'ekf-assumed-delays', 'ardupilot-unseeded-noise', 'ardupilot-stock-terms']);
    expect(snapshot.presets).toEqual([{ sensor: 'imu', reference: { catalogVersion: 1, id: 'imu-icm-42688-p' },
      citations: [expect.objectContaining({ id: 'I1', documentNumber: 'DS-000347' })] }]);
    expect(validateOwnershipMatrix(snapshot.ownershipMatrix, catalog).entries.filter(e => e.owner === 'mirage').map(e => e.source))
      .toEqual(['imu.accel.noise', 'imu.gyro.noise']);
    await expect(store.saveVersion(experiment.record.id, experiment.sha256, { name: 'Run 1', payload: { sensors: sensorSnapshot(v3) }, dependencies: [v3.sha256] }))
      .rejects.toThrow('Experiment inputs are fixed');
    // A schema 1 profile copies the ArduPilot defaults.
    expect(sensorSnapshot(v1)).toMatchObject({ configuration: null, resolution: { state: 'ardupilot-defaults' }, presets: [] });
  });
});

/** Canonical SHA-256 of released preset catalog 1; a released catalog never changes. */
const PINNED_CATALOG_1 = '72e1c25b217a5345c3174c1359ffedccc035842b25ff0c514bbab00589af1e85';
