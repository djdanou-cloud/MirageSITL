// TASK-143 (S08): the Sensors tab's form logic. Oracles: canonical bytes of
// configurations written out here, hand-computed unit conversions, and the
// validator's own rules for the messages the form shows.
import { describe, expect, test } from 'vitest';
import { validateSensorConfiguration } from '../packages/aircraft/src/sensor-config.ts';
import { DEFAULT_SENSOR_CONFIGURATION, sensorField, type SensorConfiguration } from '../packages/aircraft/src/sensor-fields.ts';
import { canonicalBytes } from '../packages/project/src/schema.ts';
import {
  applyPresetToForm, editQuantity, formFromSensors, sensorsFromForm, type SensorForm,
} from '../apps/web/src/sensors/sensor-form.ts';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const same = (a: unknown, b: unknown) => Buffer.from(canonicalBytes(a)).equals(Buffer.from(canonicalBytes(b)));
const FULL = validateSensorConfiguration({
  ...DEFAULT_SENSOR_CONFIGURATION, mode: 'specified',
  imu: { ...DEFAULT_SENSOR_CONFIGURATION.imu, preset: { catalogVersion: 1, id: 'imu-icm-42688-p' }, accelNoiseDensityMps2PerSqrtHz: 6.864655e-4,
    gyroNoiseDensityRadSPerSqrtHz: (2.8 * Math.PI) / 180000, accelBiasMps2: [0.1, -0.05, 0.0123], gyroBiasRadS: [0.001, 0, -0.0017],
    positionBodyM: [0.03, -0.01, 0.02] },
  barometer: { preset: null, noiseRmsPa: 2.7, biasPa: -35.5, latencyUs: 20000 },
  magnetometer: { ...DEFAULT_SENSOR_CONFIGURATION.magnetometer, noiseRmsGauss: 0.003, biasGauss: [0.012, -0.004, 0.0333] },
});
function built(form: SensorForm): SensorConfiguration | null {
  const result = sensorsFromForm(form);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.configuration;
}
const errors = (form: SensorForm) => {
  const result = sensorsFromForm(form);
  return result.ok ? [] : [...result.errors];
};
function edit(form: SensorForm, change: (form: Mutable<SensorForm>) => void): SensorForm {
  const copy = structuredClone(form) as Mutable<SensorForm>;
  change(copy);
  return copy;
}

describe('sensor form', () => {
  test('opening and saving reproduces the configuration bytes; the ArduPilot defaults stay null', () => {
    expect(same(built(formFromSensors(FULL)), FULL)).toBe(true);
    const ideal = validateSensorConfiguration({ ...FULL, mode: 'ideal' });
    expect(same(built(formFromSensors(ideal)), ideal)).toBe(true);
    expect(built(formFromSensors(null))).toBeNull();
    // Display units: µg/√Hz, mdps/√Hz, mg, °/s, mG and ms.
    const form = formFromSensors(FULL);
    expect(form.values['imu.accelNoiseDensityMps2PerSqrtHz']?.map(q => q.text)).toEqual(['70']);
    expect(form.values['imu.gyroNoiseDensityRadSPerSqrtHz']?.map(q => q.text)).toEqual(['2.8']);
    expect(form.values['imu.gyroBiasRadS']?.map(q => q.text)).toEqual(['0.0572957795131', '0', '-0.0974028251722']);
    expect(form.values['magnetometer.biasGauss']?.map(q => q.text)).toEqual(['12', '-4', '33.3']);
    expect(form.values['barometer.latencyUs']?.map(q => q.text)).toEqual(['20']);
    expect(form.values['gnss.latencyUs']?.map(q => q.text)).toEqual(['']);
  });

  test('typed values convert from display units; Ideal with nothing given is still Ideal', () => {
    const typed = edit(formFromSensors(null), f => {
      f.values['imu.gyroBiasRadS'] = [editQuantity('3'), editQuantity('0'), editQuantity('-1.5')];
      f.values['imu.accelBiasMps2'] = [editQuantity('20'), editQuantity('0'), editQuantity('0')];
      f.values['magnetometer.noiseRmsGauss'] = [editQuantity('3')];
      f.values['barometer.latencyUs'] = [editQuantity('60')];
    });
    const config = built(typed);
    expect(config?.imu.gyroBiasRadS).toEqual([(3 * Math.PI) / 180, 0, (-1.5 * Math.PI) / 180]);
    expect(config?.imu.accelBiasMps2).toEqual([(20 * 9.80665) / 1000, 0, 0]);
    expect(config?.magnetometer.noiseRmsGauss).toBe(0.003);
    expect(config?.barometer.latencyUs).toBe(60000);
    expect(built(edit(formFromSensors(null), f => { f.mode = 'ideal'; }))).toMatchObject({ mode: 'ideal' });
  });

  test('invalid values are explained, field by field', () => {
    const base = formFromSensors(null);
    const cases: [string, SensorForm, string][] = [
      ['a word for a number', edit(base, f => { f.values['barometer.noiseRmsPa'] = [editQuantity('quiet')]; }), 'Barometer noise (1σ) (Pa) is not a decimal number'],
      ['noise above the range', edit(base, f => { f.values['barometer.noiseRmsPa'] = [editQuantity('51')]; }), 'Barometer noise (1σ) (Pa) must be between 0 and 50'],
      ['a negative density', edit(base, f => { f.values['imu.gyroNoiseDensityRadSPerSqrtHz'] = [editQuantity('-1')]; }), 'Gyroscope noise density (mdps/√Hz) must be between 0 and 57.2957795131'],
      ['two of three components', edit(base, f => { f.values['imu.positionBodyM'] = [editQuantity('0.1'), editQuantity(''), editQuantity('0')]; }), 'IMU position (m) Y is empty; give all 3 components or none'],
      ['a bias beyond COMPASS_OFS', edit(base, f => { f.values['magnetometer.biasGauss'] = [editQuantity('401'), editQuantity('0'), editQuantity('0')]; }), 'Magnetometer bias (hard iron) (mG) X must be between -400 and 400'],
      ['half a millisecond', edit(base, f => { f.values['barometer.latencyUs'] = [editQuantity('2.5')]; }), 'Barometer latency must be a whole number of milliseconds, because ArduPilot applies it in milliseconds'],
      ['a fraction of a microsecond', edit(base, f => { f.values['barometer.latencyUs'] = [editQuantity('2.0005')]; }), 'Barometer latency (ms) must be a whole number of microseconds'],
    ];
    for (const [label, form, message] of cases) expect(errors(form).join('; '), label).toContain(message);
    // The bounds the messages show are accepted as typed and stored exactly.
    const atBounds = built(edit(base, f => {
      f.values['imu.gyroNoiseDensityRadSPerSqrtHz'] = [editQuantity('57.2957795131')];
      f.values['imu.accelBiasMps2'] = [editQuantity('203.943242596'), editQuantity('-203.943242596'), editQuantity('0')];
    }));
    expect(atBounds?.imu.gyroNoiseDensityRadSPerSqrtHz).toBe(0.001);
    expect(atBounds?.imu.accelBiasMps2).toEqual([2, -2, 0]);
    // Every parse error at once; locked fields are never parsed.
    expect(errors(edit(base, f => {
      f.values['barometer.noiseRmsPa'] = [editQuantity('x')]; f.values['magnetometer.noiseRmsGauss'] = [editQuantity('y')];
      f.values['gnss.horizontalSigmaM'] = [editQuantity('z')];
    }))).toEqual(['Barometer noise (1σ) (Pa) is not a decimal number', 'Magnetometer noise (1σ per axis) (mG) is not a decimal number']);
    expect(sensorField('gnss.horizontalSigmaM').applicable).toBe(false);
  });

  test('a preset fills its applicable fields, keeps the others and records the reference', () => {
    const base = edit(formFromSensors(null), f => { f.values['imu.accelBiasMps2'] = [editQuantity('1'), editQuantity('2'), editQuantity('3')]; });
    const { form, applied, skipped } = applyPresetToForm(base, { catalogVersion: 1, id: 'imu-icm-42688-p' });
    expect(applied).toEqual(['imu.accelNoiseDensityMps2PerSqrtHz', 'imu.gyroNoiseDensityRadSPerSqrtHz']);
    expect(skipped).toEqual([]);
    const config = built(form);
    expect(config?.imu).toMatchObject({ preset: { catalogVersion: 1, id: 'imu-icm-42688-p' }, accelNoiseDensityMps2PerSqrtHz: (70 * 9.80665) / 1e6,
      gyroNoiseDensityRadSPerSqrtHz: (2.8 * Math.PI) / 180000 });
    expect(config?.imu.accelBiasMps2).toEqual([(1 * 9.80665) / 1000, (2 * 9.80665) / 1000, (3 * 9.80665) / 1000]);
    const gnss = applyPresetToForm(formFromSensors(null), { catalogVersion: 1, id: 'gnss-neo-m9n' });
    expect(gnss.applied).toEqual([]);
    expect(built(gnss.form)?.gnss.preset).toEqual({ catalogVersion: 1, id: 'gnss-neo-m9n' });
  });
});
