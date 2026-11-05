import { describe, expect, it } from 'vitest';
import { EFFECT_IDS, effectDefinition, initialEffectParameters, type EffectControl, type EffectId } from '@mirage/protocol';
import { FAULT_TAB_FAMILIES, faultTimeline, parseFaultSchedule, sitlDeliveryRefusal, withEkfDrift, type ScheduledEffect } from '@mirage/scenarios/fault-schedule';
import { GnssJamming } from '@mirage/ew/gnss-jamming';
import { JAMMING_PARAMETERS, MAGNETIC_PARAMETERS, SITL_GPS_ACC, SITL_GPS_HDOP, SITL_GPS_LOCK, SITL_GPS_NO_LOCK_S, SITL_GPS_NUMSATS, jammingWrites, magneticBiasWrites } from '@mirage/ew/sitl-writes';
import type { GpsSample } from '@mirage/mavlink/samples';
import { parseArduPilotCatalog } from '../packages/autopilot/src/error-ownership.ts';
import catalogJson from './fixtures/sitl/ardupilot-catalog.json';

// TASK-169. The schedule's rules, and what the interference models ask of ArduPilot's simulator. Oracles: the GnssJamming kernel itself
// at its steady state, and SIM_Compass.cpp's own arithmetic, reading = field - SIM_MAGn_OFS.

const control = (effect: EffectId, id = effect.replaceAll('.', '-'), parameters: Partial<Record<string, unknown>> = {}): EffectControl =>
  ({ schemaVersion: 1, id, effect, enabled: true, intensity: 1, parameters: { ...initialEffectParameters(effect), ...parameters } } as EffectControl);
const entry = (effect: EffectId, onsetS: number, durationS: number | null, id?: string, parameters?: Partial<Record<string, unknown>>): ScheduledEffect =>
  ({ control: control(effect, id, parameters), onsetS, durationS, recovery: 'hold-offset' });
const schedule = (...entries: unknown[]) => ({ schemaVersion: 1, entries });

describe('a fault schedule', () => {
  it('takes every effect the tab offers, and nothing else', () => {
    for (const effect of EFFECT_IDS) {
      const offered = FAULT_TAB_FAMILIES.includes(effectDefinition(effect).family), one = schedule(entry(effect, 1, 2));
      if (offered) expect(parseFaultSchedule(one).entries).toHaveLength(1);
      else expect(() => parseFaultSchedule(one), effect).toThrow('does not belong on this schedule');
    }
  });
  it('refuses what cannot be applied as asked: a time outside its range, a control that is off, an unknown field', () => {
    expect(() => parseFaultSchedule(schedule(entry('link.pilot', -1, 2)))).toThrow('onsetS');
    expect(() => parseFaultSchedule(schedule(entry('link.pilot', 1, 0)))).toThrow('durationS');
    expect(() => parseFaultSchedule(schedule({ ...entry('link.pilot', 1, 2), control: { ...control('link.pilot'), enabled: false } }))).toThrow('must be enabled');
    expect(() => parseFaultSchedule(schedule({ ...entry('link.pilot', 1, 2), extra: 1 }))).toThrow('unexpected field extra');
    expect(() => parseFaultSchedule(schedule({ ...entry('link.pilot', 1, 2), recovery: 'neither' }))).toThrow('recovery');
    expect(() => parseFaultSchedule({ schemaVersion: 2, entries: [] })).toThrow('schemaVersion');
  });
  it('refuses overlaps of one effect, and of one motor, and allows what follows or is another motor', () => {
    expect(() => parseFaultSchedule(schedule(entry('link.pilot', 1, 5, 'a'), entry('link.pilot', 3, 5, 'b')))).toThrow('overlaps');
    expect(() => parseFaultSchedule(schedule(entry('link.pilot', 1, null, 'a'), entry('link.pilot', 100, 5, 'b')))).toThrow('overlaps');
    expect(parseFaultSchedule(schedule(entry('link.pilot', 1, 2, 'a'), entry('link.pilot', 3, 5, 'b'))).entries).toHaveLength(2);
    const motor = (index: number, id: string, onsetS = 1) => entry('motor.loss', onsetS, 5, id, { motorIndex: index });
    expect(parseFaultSchedule(schedule(motor(0, 'a'), motor(1, 'b'))).entries).toHaveLength(2);
    expect(() => parseFaultSchedule(schedule(motor(0, 'a'), motor(0, 'b', 2)))).toThrow('overlaps');
    expect(() => parseFaultSchedule(schedule(entry('link.pilot', 1, 2, 'same'), entry('link.gcs', 1, 2, 'same')))).toThrow('reuses the ID');
  });
  it('refuses a vertical GNSS step or drift, which would also move the barometer, with the reason', () => {
    expect(sitlDeliveryRefusal(control('ew.position-step', 'a', { offsetNedM: [30, 0, 0] }))).toBeNull();
    expect(sitlDeliveryRefusal(control('ew.position-step', 'a', { offsetNedM: [30, 0, 1] }))).toContain('barometer');
    expect(sitlDeliveryRefusal(control('ew.velocity-drift', 'a', { accelerationNedMps2: [0.2, 0, 0.1] }))).toContain('barometer');
    expect(() => parseFaultSchedule(schedule(entry('ew.position-step', 1, 2, 'a', { offsetNedM: [0, 0, 5] })))).toThrow('barometer');
  });
  it('lists its changes in time order, and what goes off before what comes on at one moment', () => {
    const timeline = faultTimeline(parseFaultSchedule(schedule(entry('link.gcs', 5, 5, 'late'), entry('link.pilot', 1, 2, 'a'), entry('link.pilot', 3, null, 'b'))));
    expect(timeline).toEqual([{ atS: 1, entry: 1, on: true }, { atS: 3, entry: 1, on: false }, { atS: 3, entry: 2, on: true }, { atS: 5, entry: 0, on: true }, { atS: 10, entry: 0, on: false }]);
  });
});

describe('the receiver under jamming, through ArduPilot\'s own parameters', () => {
  const sample = (): GpsSample => ({ timeLoUs: 0, timeHiUs: 0, latitudeRad: 0, longitudeRad: 0, altitudeMslM: 0, vnMps: 0, veMps: 0, vdMps: 0, hdop: SITL_GPS_HDOP, vdop: SITL_GPS_HDOP, hdopValid: true, vdopValid: true,
    fixType: 3, satellites: 10, satellitesValid: true, velocityValid: true, courseRad: 0, courseValid: true });
  const baseline = { satellites: 10, accuracyM: 0.3, lockS: 0 };
  const value = (writes: readonly { name: string; value: number }[], name: string) => writes.find(write => write.name === name)?.value;
  it.each([0, 0.1, 0.3, 0.5, 0.7, 0.75, 0.79, 0.8, 0.9, 1])('at severity %f says what the kernel says at its steady state', severity => {
    const jamming = new GnssJamming(), step = { dtS: 0.01 }, input = new Float64Array([severity]);
    for (let i = 0; i < 4000; i++) jamming.advanceFrom(input, step);
    const out = sample();
    expect(jamming.distortInto(sample(), out)).toBe(true);
    const writes = jammingWrites(severity, baseline, false);
    expect(value(writes, SITL_GPS_NUMSATS)).toBe(out.satellites);
    expect(value(writes, SITL_GPS_LOCK)).toBe(out.fixType === 0 ? SITL_GPS_NO_LOCK_S : 0);
    // A position accuracy grows with the DOP; the kernel's DOP against the receiver's own.
    expect(value(writes, SITL_GPS_ACC)).toBeCloseTo(baseline.accuracyM * out.hdop / SITL_GPS_HDOP, 2);
  });
  it('leaves everything as it was at severity 0, and holds a lost fix until the severity is below the recovery level', () => {
    expect(jammingWrites(0, baseline, false)).toEqual([{ name: SITL_GPS_NUMSATS, value: 10 }, { name: SITL_GPS_ACC, value: 0.3 }, { name: SITL_GPS_LOCK, value: 0 }]);
    expect(value(jammingWrites(0.65, baseline, true), SITL_GPS_LOCK)).toBe(SITL_GPS_NO_LOCK_S);
    expect(value(jammingWrites(0.65, baseline, false), SITL_GPS_LOCK)).toBe(0);
    expect(value(jammingWrites(0.55, baseline, true), SITL_GPS_LOCK)).toBe(0);
  });
});

describe('a magnetometer bias, through ArduPilot\'s own offsets', () => {
  it('adds to whatever the Sensors tab set, by SIM_Compass.cpp\'s arithmetic, and never replaces it', () => {
    const fieldMilliGauss = [200, 50, 400], sensorsTab = new Map(MAGNETIC_PARAMETERS.map((name, index) => [name, 5 + index]));
    const writes = magneticBiasWrites([0.3, -0.2, 0.1], name => sensorsTab.get(name) ?? Number.NaN);
    expect(writes.map(write => write.name)).toEqual(MAGNETIC_PARAMETERS);
    const reading = (offset: (name: string) => number, instance: number) => ['X', 'Y', 'Z'].map((axis, index) => (fieldMilliGauss[index] ?? 0) - offset(`SIM_MAG${instance}_OFS_${axis}`));
    for (const instance of [1, 2, 3]) {
      const before = reading(name => sensorsTab.get(name) ?? Number.NaN, instance);
      const after = reading(name => writes.find(write => write.name === name)?.value ?? Number.NaN, instance);
      expect(after.map((value, index) => value - (before[index] ?? 0))).toEqual([300, -200, 100].map(value => expect.closeTo(value, 9) as number));
    }
  });
});

describe('every parameter these writes name', () => {
  it('is in the pinned ArduPilot catalog', () => {
    const catalog = parseArduPilotCatalog(catalogJson);
    // The catalog names a vector parameter once; the list ArduPilot sends has its _X, _Y and _Z.
    for (const name of [...JAMMING_PARAMETERS, ...MAGNETIC_PARAMETERS.map(item => item.replace(/_[XYZ]$/, ''))]) expect(catalog.parameters.has(name), name).toBe(true);
  });
});

describe('an EKF drift on the schedule (TASK-170)', () => {
  const profile = { schemaVersion: 1, directionDeg: 90, growthMps2: 0.2, topSpeedMps: 2, onsetS: 5, durationS: 6, removal: 'gradual' } as const;
  it('stands with its entries, and a stored one whose entries are not its own is refused', () => {
    const schedule = withEkfDrift(parseFaultSchedule({ schemaVersion: 1, entries: [entry('link.pilot', 1, 2)] }), profile);
    expect(schedule.ekfDrift).toEqual(profile);
    expect(parseFaultSchedule(JSON.parse(JSON.stringify(schedule)))).toEqual(schedule);
    expect(() => parseFaultSchedule({ ...schedule, ekfDrift: { ...profile, durationS: 7 } })).toThrow('not those of its profile');
    expect(() => parseFaultSchedule({ schemaVersion: 1, entries: schedule.entries })).toThrow('not those of its profile');
    expect(withEkfDrift(schedule, null)).toEqual(parseFaultSchedule({ schemaVersion: 1, entries: [entry('link.pilot', 1, 2)] }));
  });
  it('refuses to overlap another drift, and takes one that ends first', () => {
    const earlier = parseFaultSchedule({ schemaVersion: 1, entries: [entry('ew.velocity-drift', 1, 2, 'mine', { accelerationNedMps2: [0.1, 0, 0] })] });
    expect(withEkfDrift(earlier, profile).entries.length).toBeGreaterThan(1);
    expect(() => withEkfDrift(earlier, { ...profile, onsetS: 2 })).toThrow('overlaps');
  });
});
