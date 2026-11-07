import { readFileSync } from 'node:fs';
import { DISCRETE_GUST_MAX_AMPLITUDE_MPS, DISCRETE_GUST_MAX_DURATION_S, DISCRETE_GUST_MIN_DURATION_S } from '../packages/physics/src/discrete-gust.ts';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  EFFECT_CATALOG, EFFECT_IDS, ISA_PRESSURE_PA, ISA_TEMPERATURE_K, WEATHER_SET_GUST_BANDWIDTH_HZ, effectiveControl, initialEffectParameters, lowerEffectSet, migrateFaultSet,
  migrateWeatherSet, parseControlCommand, parseControlCommandV2, parseEffectControl, scheduledEffects, type EffectControl, type EffectId, type EffectParameterValue,
  type EffectiveControl, type EffectField,
} from '@mirage/protocol';
import { WEATHER_GUST_BANDWIDTH_HZ } from '@mirage/physics/bet-dynamics';
import { Wind } from '@mirage/physics/wind';
import { AIR_REFERENCE_PRESSURE, AIR_REFERENCE_TEMPERATURE, atmosphereAtHeightInto } from '@mirage/physics/atmosphere';
import { MAX_IMU_LATENCY_US } from '@mirage/sensors/configured';
import { sensorField, type SensorFieldPath } from '../packages/aircraft/src/sensor-fields.ts';
import schemaV2 from '../packages/protocol/src/control-v2.schema.json';

// TASK-166. Oracles: hand-written fixtures; each owning model's own refusal at its limit, not a shared constant; the arithmetic of
// each intensity's definition written out here.

interface Fixtures {
  readonly accept: readonly { name: string; command: Record<string, unknown> }[];
  readonly reject: readonly { name: string; code: string; command: Record<string, unknown> }[];
  readonly rejectBeyondSchema: readonly { name: string; code: string; command: Record<string, unknown> }[];
  readonly migration: readonly { name: string; v2: Record<string, unknown>; records: readonly EffectControl[] }[];
}
interface SchemaBranch { readonly properties: { readonly control?: { readonly properties: { readonly effect: { readonly const: string }; readonly parameters: { readonly properties: Record<string, Record<string, unknown>> } } } } }
const fixtures = JSON.parse(readFileSync('tests/fixtures/protocol/control-v3.json', 'utf8')) as Fixtures;
const schema = JSON.parse(readFileSync('packages/protocol/src/control-v3.schema.json', 'utf8')) as { readonly oneOf: readonly SchemaBranch[] };
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const control = (effect: EffectId, parameters: Record<string, EffectParameterValue>, intensity = 1, enabled = true): EffectControl =>
  ({ schemaVersion: 1, id: 'c1', effect, enabled, intensity, parameters });
const envelope = { requestId: 1, expectedEpoch: 1, atTick: { lo: 10, hi: 0 }, recovery: 'hold-offset' } as const;
const effective = (c: EffectControl): EffectiveControl => effectiveControl(parseEffectControl(c), envelope);
const faultOf = (result: EffectiveControl) => {
  if (result.family !== 'fault') throw new Error('Not a fault');
  return result.fault;
};
const command = (c: EffectControl) => ({ protocolVersion: 3, requestId: 1, expectedEpoch: 1, atTick: { lo: 10, hi: 0 }, type: 'effect.set', control: c, recovery: 'hold-offset' });

describe('the effect catalog', () => {
  it('names the effects Phase 1 has models for, each field with a unit and a range, and a starting value inside that range', () => {
    expect([...EFFECT_IDS].sort()).toEqual(['atmosphere', 'ew.gnss-jamming', 'ew.magnetic', 'ew.position-step', 'ew.velocity-drift', 'motor.loss', 'rotor.ground-effect', 'sensor.battery.current', 'sensor.battery.voltage',
      'sensor.imu.accel-bias', 'sensor.imu.accel-noise', 'sensor.imu.gyro-bias', 'sensor.imu.gyro-noise', 'sensor.imu.latency', 'wind.discrete-gust', 'wind.gust', 'wind.mean', 'wind.turbulence',
      'link.gcs', 'link.pilot', 'baro.position-error', 'baro.ground-cushion', 'baro.prop-wash', 'baro.drift', 'baro.pressure-trend', 'gnss.constellation', 'gnss.atmosphere', 'gnss.terrain', 'gnss.jamming-budget', 'sensor.baro.frozen', 'sensor.baro.missing', 'sensor.gnss.frozen', 'sensor.gnss.missing', 'sensor.imu.frozen', 'sensor.imu.missing', 'sensor.mag.frozen', 'sensor.mag.missing'].sort());
    for (const id of EFFECT_IDS) {
      const parameters = initialEffectParameters(id);
      // Parsing is the check that every starting value lies inside its own range.
      expect(parseEffectControl(control(id, parameters)).parameters, id).toEqual(parameters);
      expect(parameters, id).not.toBe(initialEffectParameters(id));
    }
  });

  it('holds the ranges of the discrete-gust model (TASK-167)', () => {
    const [amplitude, duration] = EFFECT_CATALOG['wind.discrete-gust'].fields;
    expect([amplitude.min, amplitude.max]).toEqual([0, DISCRETE_GUST_MAX_AMPLITUDE_MPS]);
    expect([duration.min, duration.max]).toEqual([DISCRETE_GUST_MIN_DURATION_S, DISCRETE_GUST_MAX_DURATION_S]);
  });

  it('holds the ranges of the wind and gust models', () => {
    const wind = (mean: number, rms: number, bandwidthHz: number) => new Wind({ meanNedMps: [mean, 0, 0], gustRmsMps: rms, bandwidthHz, hz: 400 }, 1);
    const fields = EFFECT_CATALOG['wind.gust'].fields, mean = EFFECT_CATALOG['wind.mean'].fields[0];
    const rms = fields[0], bandwidth = fields[1];
    expect(() => wind(mean.max, 0, 1)).not.toThrow();
    expect(() => wind(mean.max * 1.001, 0, 1)).toThrow();
    expect(() => wind(0, rms.max, 1)).not.toThrow();
    expect(() => wind(0, rms.max * 1.001, 1)).toThrow();
    // The bandwidth's upper limit is Nyquist at the lowest rate, 400 Hz, so it holds at every rate.
    expect(bandwidth.exclusiveMax).toBe(true);
    expect(() => wind(0, 1, bandwidth.max * 0.999)).not.toThrow();
    expect(() => wind(0, 1, bandwidth.max)).toThrow();
    expect(WEATHER_SET_GUST_BANDWIDTH_HZ).toBe(WEATHER_GUST_BANDWIDTH_HZ);
  });

  it('holds the range of the atmosphere model, and refuses the same density it would', () => {
    const out = new Float64Array(5);
    const accepts = (temperatureK: number, pressurePa: number) => {
      const input = new Float64Array(3);
      input[AIR_REFERENCE_TEMPERATURE] = temperatureK; input[AIR_REFERENCE_PRESSURE] = pressurePa;
      return atmosphereAtHeightInto(input, out);
    };
    const [temperature, pressure] = EFFECT_CATALOG.atmosphere.fields;
    expect(accepts(temperature.max, ISA_PRESSURE_PA)).toBe(true);
    expect(accepts(temperature.max + 0.01, ISA_PRESSURE_PA)).toBe(false);
    expect(accepts(temperature.min, 60000)).toBe(true);
    expect(accepts(temperature.min - 0.01, 60000)).toBe(false);
    expect(accepts(ISA_TEMPERATURE_K, pressure.max)).toBe(true);
    expect(accepts(ISA_TEMPERATURE_K, pressure.max + 1)).toBe(false);
    // Density is the combination: the protocol must agree with the model on a grid of the whole range, off the exact boundary.
    let refused = 0, compared = 0;
    for (let t = temperature.min; t <= temperature.max; t += 5) for (let p = pressure.min; p <= pressure.max; p += 3000) {
      const parsed = parseControlCommand(command(control('atmosphere', { temperatureK: t, pressurePa: p })));
      expect(parsed.ok, `${t} K, ${p} Pa`).toBe(accepts(t, p));
      compared++;
      if (!parsed.ok) { refused++; expect(parsed.code).toBe('OUT_OF_RANGE'); }
    }
    expect(compared).toBeGreaterThan(1000);
    expect(refused).toBeGreaterThan(50);
    expect(compared - refused).toBeGreaterThan(50);
  });

  it('holds the ranges of the EW and motor models, whose admission is the version 2 parser', () => {
    const accepted = (c: EffectControl) => parseControlCommandV2(faultOf(effective(c))).ok;
    expect(accepted(control('ew.gnss-jamming', { severity: 1 }))).toBe(true);
    expect(accepted(control('ew.position-step', { offsetNedM: [10000, 0, 0] }))).toBe(true);
    expect(accepted(control('ew.velocity-drift', { accelerationNedMps2: [0.3, 0, 0], maxSpeedMps: 20 }))).toBe(true);
    expect(accepted(control('ew.magnetic', { rotationRad: [Math.PI, -Math.PI, 0], biasBodyGauss: [2, -2, 2] }))).toBe(true);
    expect(accepted(control('motor.loss', { motorIndex: 31, mode: 'power-cut', remainingThrustFraction: 1 }))).toBe(true);
    // Beyond each limit the version 2 parser refuses the fault it would have become, and this parser refuses the control.
    const beyond: readonly [EffectId, Record<string, EffectParameterValue>, Record<string, unknown>][] = [
      ['ew.gnss-jamming', { severity: 1.01 }, { kind: 'gnss-jamming', severity: 1.01 }],
      ['ew.position-step', { offsetNedM: [10000.5, 0, 0] }, { kind: 'position-step', offsetNedM: [10000.5, 0, 0] }],
      ['ew.velocity-drift', { accelerationNedMps2: [0.31, 0, 0], maxSpeedMps: 2 }, { kind: 'velocity-drift', accelerationNedMps2: [0.31, 0, 0], maxSpeedMps: 2 }],
      ['ew.velocity-drift', { accelerationNedMps2: [0.1, 0, 0], maxSpeedMps: 20.1 }, { kind: 'velocity-drift', accelerationNedMps2: [0.1, 0, 0], maxSpeedMps: 20.1 }],
      ['ew.velocity-drift', { accelerationNedMps2: [0.1, 0, 0], maxSpeedMps: 0 }, { kind: 'velocity-drift', accelerationNedMps2: [0.1, 0, 0], maxSpeedMps: 0 }],
      ['ew.magnetic', { rotationRad: [3.2, 0, 0], biasBodyGauss: [0, 0, 0] }, { kind: 'magnetic', rotationRad: [3.2, 0, 0], biasBodyGauss: [0, 0, 0] }],
      ['ew.magnetic', { rotationRad: [0, 0, 0], biasBodyGauss: [2.1, 0, 0] }, { kind: 'magnetic', rotationRad: [0, 0, 0], biasBodyGauss: [2.1, 0, 0] }],
      ['motor.loss', { motorIndex: 32, mode: 'power-cut', remainingThrustFraction: 0 }, { kind: 'motor-loss', motorIndex: 32, mode: 'power-cut', remainingThrustFraction: 0 }],
      ['motor.loss', { motorIndex: 0, mode: 'power-cut', remainingThrustFraction: 1.1 }, { kind: 'motor-loss', motorIndex: 0, mode: 'power-cut', remainingThrustFraction: 1.1 }],
    ];
    for (const [effect, parameters, faultEffect] of beyond) {
      const asFault = parseControlCommandV2({ protocolVersion: 2, requestId: 1, expectedEpoch: 1, atTick: { lo: 10, hi: 0 }, type: 'fault.set', faultId: 'c1', enabled: true, effect: faultEffect, recovery: 'hold-offset' });
      expect(asFault.ok, JSON.stringify(faultEffect)).toBe(false);
      expect(parseControlCommand(command(control(effect, parameters))).ok, JSON.stringify(parameters)).toBe(false);
    }
  });

  it('holds the ranges of the Sensors tab, whose fields own the sensor errors', () => {
    const pairs: readonly [EffectId, string, SensorFieldPath][] = [
      ['sensor.imu.accel-noise', 'densityMps2PerSqrtHz', 'imu.accelNoiseDensityMps2PerSqrtHz'],
      ['sensor.imu.gyro-noise', 'densityRadSPerSqrtHz', 'imu.gyroNoiseDensityRadSPerSqrtHz'],
      ['sensor.imu.latency', 'latencyUs', 'imu.latencyUs'],
      ['sensor.battery.voltage', 'gainError', 'battery.voltageGainError'],
      ['sensor.battery.voltage', 'offsetV', 'battery.voltageOffsetV'],
      ['sensor.battery.voltage', 'noiseRmsV', 'battery.voltageNoiseRmsV'],
      ['sensor.battery.current', 'gainError', 'battery.currentGainError'],
      ['sensor.battery.current', 'offsetA', 'battery.currentOffsetA'],
      ['sensor.battery.current', 'noiseRmsA', 'battery.currentNoiseRmsA'],
      ['sensor.imu.accel-bias', 'biasMps2', 'imu.accelBiasMps2'],
      ['sensor.imu.gyro-bias', 'biasRadS', 'imu.gyroBiasRadS'],
    ];
    for (const [effect, key, path] of pairs) {
      const definition: { fields: readonly EffectField[] } = EFFECT_CATALOG[effect];
      const field = definition.fields.find(item => item.key === key), owner = sensorField(path);
      if (!field || field.kind === 'enum') throw new Error(`${effect}.${key}`);
      expect([field.min, field.max], path).toEqual([owner.minimum, owner.maximum]);
    }
    const latency = EFFECT_CATALOG['sensor.imu.latency'].fields[0];
    expect(latency.max).toBe(MAX_IMU_LATENCY_US);
  });

  it('states in the JSON schema exactly the ranges it enforces', () => {
    for (const id of EFFECT_IDS) {
      const branch = schema.oneOf.find(item => item.properties.control?.properties.effect.const === id);
      const definition: { fields: readonly EffectField[] } = EFFECT_CATALOG[id];
      const properties = branch?.properties.control?.properties.parameters.properties;
      if (!properties) throw new Error(`No schema branch for ${id}`);
      expect(Object.keys(properties).sort(), id).toEqual(definition.fields.map(field => field.key).sort());
      for (const field of definition.fields) {
        const stated = properties[field.key];
        if (!stated) throw new Error(field.key);
        if (field.kind === 'enum') { expect(stated.enum).toEqual(field.options); continue; }
        const limits = field.kind === 'vector3' ? (stated.prefixItems as Record<string, unknown>[])[0] : stated;
        if (!limits) throw new Error(field.key);
        expect(limits.minimum ?? limits.exclusiveMinimum, `${id}.${field.key}`).toBe(field.min);
        expect(limits.maximum ?? limits.exclusiveMaximum, `${id}.${field.key}`).toBe(field.max);
      }
    }
  });
});

describe('Control Protocol v3 fixtures', () => {
  it.each(fixtures.accept)('accepts $name', ({ command: input }) => {
    const parsed = parseControlCommand(input);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
  });
  it.each(fixtures.reject)('refuses $name with $code, as the schema does', ({ command: input, code }) => {
    const parsed = parseControlCommand(input);
    expect(parsed.ok ? 'accept' : parsed.code).toBe(code);
    expect(validate(input)).toBe(false);
  });
  it.each(fixtures.rejectBeyondSchema)('refuses $name with $code, which a schema cannot state', ({ command: input, code }) => {
    const parsed = parseControlCommand(input);
    expect(parsed.ok ? 'accept' : parsed.code).toBe(code);
    expect(validate(input)).toBe(true);
  });
  it('holds an accepted control and its lowered form as plain copies that travel', () => {
    const input = fixtures.accept[0]?.command, parsed = parseControlCommand(input);
    if (!parsed.ok || parsed.command.type !== 'effect.set') throw new Error('Expected effect.set');
    // What travels re-parses to itself: the Worker parses what the page parsed.
    expect(parseControlCommand(structuredClone(parsed.command))).toEqual(parsed);
    expect(Object.keys(parsed.command)).not.toContain('effective');
    expect(lowerEffectSet(parsed.command).effective).toMatchObject({ family: 'environment', effect: 'wind.mean', active: true });
  });
  it('returns every version 3 lifecycle command in its version 2 form, and the schema agrees', () => {
    const lifecycle: readonly Record<string, unknown>[] = [{ type: 'sim.start' }, { type: 'sim.pause' }, { type: 'sim.reset', seed: 3 }, { type: 'sim.configure', hz: 800, clockMode: 'interactive' },
      { type: 'model.load', modelId: 1, manifestSha256: 'ab'.repeat(32) }, { type: 'worker.dispose' }];
    for (const body of lifecycle) {
      const envelope3 = { protocolVersion: 3, requestId: 7, expectedEpoch: 1, ...body }, envelope2 = { ...envelope3, protocolVersion: 2 };
      expect(parseControlCommand(envelope3), JSON.stringify(body)).toEqual({ ok: true, command: envelope2 });
      expect(validate(envelope3), JSON.stringify(body)).toBe(true);
    }
    expect(parseControlCommand({ protocolVersion: 3, requestId: 7, expectedEpoch: 1, type: 'sim.reset' })).toMatchObject({ ok: false, code: 'SCHEMA' });
  });
});

describe('Control Protocol v2 after TASK-166', () => {
  const weather = (extra: Record<string, unknown>) => ({ protocolVersion: 2, requestId: 1, expectedEpoch: 1, atTick: { lo: 10, hi: 0 }, type: 'weather.set', windNedMps: [0, 0, 0], temperatureK: 288.15, pressurePa: 101325, turbulenceRmsMps: 0, seed: 0, ...extra });
  const validateV2 = new Ajv2020({ strict: true, allErrors: true }).compile(schemaV2);
  it('takes each model envelope in place of its old, different range', () => {
    for (const within of [{ windNedMps: [200, -200, 150] }, { turbulenceRmsMps: 50 }, { temperatureK: 180 }, { temperatureK: 330 }, { pressurePa: 1000 }, { pressurePa: 120000 }]) {
      expect(parseControlCommandV2(weather(within)).ok, JSON.stringify(within)).toBe(true);
      expect(validateV2(weather(within)), JSON.stringify(within)).toBe(true);
    }
    for (const beyond of [{ windNedMps: [200.5, 0, 0] }, { turbulenceRmsMps: 50.5 }, { temperatureK: 179.5 }, { temperatureK: 330.5 }, { pressurePa: 999 }, { pressurePa: 120001 }]) {
      expect(parseControlCommandV2(weather(beyond)), JSON.stringify(beyond)).toMatchObject({ ok: false, code: 'OUT_OF_RANGE' });
      expect(validateV2(weather(beyond)), JSON.stringify(beyond)).toBe(false);
    }
  });
});

describe('migration of version 2 commands', () => {
  it.each(fixtures.migration)('maps $name onto its records', ({ v2, records }) => {
    const parsed = parseControlCommandV2(v2);
    if (!parsed.ok) throw new Error(parsed.message);
    const out = parsed.command.type === 'weather.set' ? migrateWeatherSet(parsed.command) : parsed.command.type === 'fault.set' ? [migrateFaultSet(parsed.command)] : [];
    expect(out).toEqual(records);
    for (const record of out) expect(parseEffectControl(record)).toEqual(record);
  });
  it('gives back the very fault a fault.set was, field for field', () => {
    for (const { v2, records } of fixtures.migration) {
      if (v2.type !== 'fault.set') continue;
      const record = records[0];
      if (!record) throw new Error('No record');
      const recovery = v2.recovery === 'step-to-truth' ? 'step-to-truth' : 'hold-offset';
      expect(faultOf(effectiveControl(record, { requestId: 1, expectedEpoch: 1, atTick: { lo: 10, hi: 0 }, recovery }))).toEqual(v2);
    }
  });
});

describe('intensity', () => {
  it('multiplies mean wind', () => {
    expect(effective(control('wind.mean', { windNedMps: [4, -2, 1] }, 2.5))).toMatchObject({ active: true, windNedMps: [10, -5, 2.5] });
  });
  it('multiplies gust RMS, and leaves the bandwidth and the seed alone', () => {
    expect(effective(control('wind.gust', { rmsMps: 1.5, bandwidthHz: 3, seed: 9 }, 2))).toMatchObject({ active: true, rmsMps: 3, bandwidthHz: 3, seed: 9 });
  });
  it('multiplies the strength of turbulence, and leaves W20 and the seed as written', () => {
    expect(effective(control('rotor.ground-effect', {}, 0.5))).toMatchObject({ family: 'environment', effect: 'rotor.ground-effect', active: true, intensity: 0.5 });
    expect(effective(control('rotor.ground-effect', {}, 0))).toMatchObject({ active: false });
    expect(effective(control('rotor.ground-effect', {}, 1, false))).toMatchObject({ active: false });
    expect(effective(control('wind.turbulence', { w20Mps: 10, seed: 4 }, 3))).toMatchObject({ active: true, w20Mps: 10, intensity: 3, seed: 4 });
    expect(effective(control('wind.turbulence', { w20Mps: 10, seed: 4 }, 0))).toMatchObject({ active: false });
    // No strength at all is no effect, on or off.
    expect(effective(control('wind.turbulence', { w20Mps: 0, seed: 4 }))).toMatchObject({ active: false });
    expect(() => effective(control('wind.turbulence', { w20Mps: 30, seed: 4 }, 2))).toThrow('at intensity');
  });
  it('moves the air from the standard atmosphere at 0 to its values at 1, and past them', () => {
    const parameters = { temperatureK: 300, pressurePa: 90000 };
    expect(effective(control('atmosphere', parameters))).toMatchObject({ temperatureK: 300, pressurePa: 90000 });
    expect(effective(control('atmosphere', parameters, 0.5))).toMatchObject({ temperatureK: 294.075, pressurePa: 95662.5 });
    expect(effective(control('atmosphere', parameters, 2))).toMatchObject({ temperatureK: 311.85, pressurePa: 78675 });
  });
  it('multiplies each EW magnitude', () => {
    expect(faultOf(effective(control('ew.gnss-jamming', { severity: 0.8 }, 0.5))).effect).toEqual({ kind: 'gnss-jamming', severity: 0.4 });
    expect(faultOf(effective(control('ew.position-step', { offsetNedM: [100, -20, 5] }, 3))).effect).toEqual({ kind: 'position-step', offsetNedM: [300, -60, 15] });
    expect(faultOf(effective(control('ew.velocity-drift', { accelerationNedMps2: [0.2, 0, -0.1], maxSpeedMps: 2 }, 0.5))).effect).toEqual({ kind: 'velocity-drift', accelerationNedMps2: [0.1, 0, -0.05], maxSpeedMps: 1 });
    expect(faultOf(effective(control('ew.magnetic', { rotationRad: [0, 0, 0.5], biasBodyGauss: [0.25, 0, 0] }, 2))).effect).toEqual({ kind: 'magnetic', rotationRad: [0, 0, 1], biasBodyGauss: [0.5, 0, 0] });
  });
  it('multiplies the thrust a motor loses, not the thrust that remains', () => {
    const remaining = (r: number, i: number) => {
      const effect = faultOf(effective(control('motor.loss', { motorIndex: 2, mode: 'power-cut', remainingThrustFraction: r }, i))).effect;
      return effect.kind === 'motor-loss' ? effect.remainingThrustFraction : NaN;
    };
    expect(remaining(0.25, 1)).toBe(0.25);
    expect(remaining(0, 0.5)).toBe(0.5);
    expect(remaining(0.25, 0.5)).toBe(0.625);
    expect(remaining(0.5, 2)).toBe(0);
    expect(() => remaining(0, 2)).toThrow('more than all');
  });
  it('makes off and zero the same: not active, whatever the values, and never out of range', () => {
    for (const [effect, parameters] of [['wind.mean', { windNedMps: [150, 0, 0] }], ['wind.gust', { rmsMps: 40, bandwidthHz: 1, seed: 1 }], ['atmosphere', { temperatureK: 320, pressurePa: 101325 }]] as const) {
      expect(effective(control(effect, parameters, 1, false))).toMatchObject({ active: false });
      expect(effective(control(effect, parameters, 0))).toMatchObject({ active: false });
      // An intensity that would be out of range is not one, once the effect is off.
      expect(effective(control(effect, parameters, 1000, false))).toMatchObject({ active: false });
    }
    expect(faultOf(effective(control('ew.gnss-jamming', { severity: 1 }, 1, false))).enabled).toBe(false);
    expect(faultOf(effective(control('ew.gnss-jamming', { severity: 1 }, 0))).enabled).toBe(false);
  });
});

describe('schedules', () => {
  const wind = control('wind.mean', { windNedMps: [5, 0, 0] });
  it('become the effect on at its onset and off when its duration ends', () => {
    expect(scheduledEffects(wind, { onsetTick: 100, durationTicks: 50, recovery: 'hold-offset' })).toEqual([
      { tick: 100, control: wind, recovery: 'hold-offset' }, { tick: 150, control: { ...wind, enabled: false }, recovery: 'hold-offset' }]);
  });
  it('hold when no duration is given, and carry the recovery', () => {
    expect(scheduledEffects(wind, { onsetTick: 0, durationTicks: null, recovery: 'step-to-truth' })).toEqual([{ tick: 0, control: wind, recovery: 'step-to-truth' }]);
  });
  it('refuse a tick that is not one, and a duration under one tick', () => {
    for (const bad of [{ onsetTick: -1, durationTicks: 1 }, { onsetTick: 1.5, durationTicks: 1 }, { onsetTick: 0, durationTicks: 0 }, { onsetTick: 0, durationTicks: 1.5 }]) {
      expect(() => scheduledEffects(wind, { ...bad, recovery: 'hold-offset' })).toThrow();
    }
  });
});
