import { beforeAll, describe, expect, test } from 'vitest';
import { validateComponentCard, type ComponentCard } from '@mirage/aircraft/components';
import type { AircraftProfile } from '@mirage/aircraft/profile';
import { parseFlightTask } from '@mirage/scenarios/flight-tasks';
import {
  COMPARISON_CONTROLS, comparisonControls, comparisonWindowKind, durationScenario, heldByDefault, massAccounting, metricRows, parameterDifferences,
  type ComparedExperiment, type ComparedInputs, type ComparisonControl,
} from '@mirage/analysis/compare';
import type { ExperimentMetrics, WindowMetrics } from '@mirage/analysis/metrics';
import type { ThrustCapacity } from '@mirage/physics/thrust-capacity';
import { exampleCard, quadProfile } from './support/quad-profile.ts';

// Which inputs two experiments held equal, how their mass changed, and their results side by side,
// every expected figure worked out by hand next to it.

const MOTOR = '11'.repeat(32), PROPELLER = '22'.repeat(32), ESC = '33'.repeat(32), BATTERY = '44'.repeat(32), OTHER_MOTOR = '55'.repeat(32), OTHER_BATTERY = '66'.repeat(32);
function withMass(card: ComponentCard, massKg: number | null): ComponentCard {
  return validateComponentCard({ ...card, values: { ...card.values, massKg }, provenance: { ...card.provenance, massKg: massKg === null ? null : 'example' } });
}
const HOVER = parseFlightTask({ schemaVersion: 1, type: 'hover', parameters: { altitudeM: 5, durationS: 10 }, route: null, initial: { ground: { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 }, air: null }, finish: 'land' });
const FIRMWARE = { catalogId: 'arducopter-8ab6afd', firmwareVersion: 'ArduCopter V4.8.0-dev', commit: 'a'.repeat(40), binarySha256: 'b'.repeat(64), defaultParametersSha256: 'c'.repeat(64) };
const inputs = (edit: Partial<ComparedInputs> = {}): ComparedInputs => ({
  profile: { sha256: 'd'.repeat(64) }, sitl: { ownership: 'launcher', experimentId: '20261101120000000-0a1b2c3d', ardupilot: FIRMWARE }, session: { home: [-35.363261, 149.16523, 584, 0], physicsHz: 800, speedup: 4 },
  parameters: [{ name: 'MOT_PWM_MIN', value: 1000, source: 'pwm' }, { name: 'COMPASS_DEC', value: 0.22, source: 'site' }], frameScript: null, sensors: { mode: 'ideal' },
  recording: { recordId: 'e'.repeat(32), commonHz: 50, groups: {}, signals: {}, durationMin: 10, reserveMb: 100 }, flightTask: { recordSha256: 'f'.repeat(64), name: 'Hover 5 m', definition: HOVER }, ...edit,
});
let base: AircraftProfile;
beforeAll(async () => {
  base = (await quadProfile()).profile;
});
const cards = (): Map<string, ComponentCard> => new Map([
  [MOTOR, withMass(exampleCard('motor'), 0.05)], [OTHER_MOTOR, withMass(exampleCard('motor'), 0.07)], [PROPELLER, withMass(exampleCard('propeller'), 0.01)],
  [ESC, withMass(exampleCard('esc'), 0.02)], [BATTERY, withMass(exampleCard('battery'), 0.3)], [OTHER_BATTERY, withMass(exampleCard('battery'), 0.4)],
]);
const NAMES = new Map([[MOTOR, 'Motor A'], [OTHER_MOTOR, 'Motor B'], [PROPELLER, 'Prop'], [ESC, 'ESC'], [BATTERY, 'Pack A'], [OTHER_BATTERY, 'Pack B']]);
const side = (edit: Partial<ComparedInputs> = {}, profile: AircraftProfile = base, known: ReadonlyMap<string, ComponentCard> = cards()): ComparedExperiment =>
  ({ name: 'Run', payload: inputs(edit), aircraft: { profile, cards: known, cardNames: NAMES } });
const motorsOn = (card: string, profile: AircraftProfile = base): AircraftProfile => ({ ...profile, motors: profile.motors.map(motor => ({ ...motor, components: { ...motor.components, motor: card } })) });
const differing = (a: ComparedExperiment, b: ComparedExperiment, kind: 'conditions' | 'configurations') => comparisonControls(a, b, heldByDefault(kind)).filter(row => row.differs);
const flags = (a: ComparedExperiment, b: ComparedExperiment, kind: 'conditions' | 'configurations'): ComparisonControl[] => differing(a, b, kind).filter(row => row.flagged).map(row => row.control);

describe('what the two held equal', () => {
  test('two experiments with the same inputs differ in nothing', () => {
    expect(differing(side(), side(), 'configurations')).toEqual([]);
    expect(comparisonControls(side(), side(), heldByDefault('conditions'))).toHaveLength(COMPARISON_CONTROLS.length);
  });
  test('comparing configurations: a different motor is the point, and a different task is flagged', () => {
    const a = side(), b = side({ flightTask: { recordSha256: 'f'.repeat(64), name: 'Other', definition: { ...HOVER, parameters: { altitudeM: 8, durationS: 10 } } } }, motorsOn(OTHER_MOTOR));
    expect(differing(a, b, 'configurations').map(row => row.control)).toEqual(['motors', 'flight-task']);
    expect(flags(a, b, 'configurations')).toEqual(['flight-task']);
    const motors = differing(a, b, 'configurations')[0];
    expect(motors).toMatchObject({ a: 'Motor A × 4', b: 'Motor B × 4', held: false, flagged: false });
  });
  test('comparing conditions on one aircraft: a different task is the point, and a different motor is flagged', () => {
    const a = side(), b = side({ flightTask: { recordSha256: 'f'.repeat(64), name: 'Other', definition: { ...HOVER, parameters: { altitudeM: 8, durationS: 10 } } } }, motorsOn(OTHER_MOTOR));
    expect(flags(a, b, 'conditions')).toEqual(['motors']);
  });
  test('a controlled comparison of configurations holds payload, battery, weather, task, charge, start and home by default', () => {
    const held = heldByDefault('configurations');
    for (const control of ['payload', 'battery', 'weather', 'flight-task', 'charge', 'start', 'home'] as const) expect(held.has(control), control).toBe(true);
    for (const control of ['motors', 'propellers', 'escs', 'aircraft-mass', 'parameters'] as const) expect(held.has(control), control).toBe(false);
  });
  test('the charge and the start are inputs of their own, apart from what the task flies', () => {
    const charged = { ...HOVER, initial: { ...HOVER.initial, ground: { ...HOVER.initial.ground, stateOfCharge: 0.5 } } };
    const moved = { ...HOVER, initial: { ...HOVER.initial, ground: { ...HOVER.initial.ground, northM: 10 } } };
    const task = (definition: typeof HOVER) => ({ flightTask: { recordSha256: 'f'.repeat(64), name: 'Hover 5 m', definition } });
    expect(differing(side(), side(task(charged)), 'configurations').map(row => [row.control, row.a, row.b])).toEqual([['charge', '100 %', '50 %']]);
    expect(differing(side(), side(task(moved)), 'configurations').map(row => row.control)).toEqual(['start']);
  });
  test('speed and the recording setup change no physics, so they differ without a flag', () => {
    const a = side(), b = side({ session: { home: [-35.363261, 149.16523, 584, 0], physicsHz: 800, speedup: 1 } });
    expect(differing(a, b, 'configurations').map(row => row.control)).toEqual(['speed']);
    expect(flags(a, b, 'configurations')).toEqual([]);
    expect(flags(a, b, 'conditions')).toEqual([]);
  });
  test('the physics rate, the home and the ArduPilot build are flagged when held', () => {
    const b = side({ session: { home: [47.4, 8.5, 400, 0], physicsHz: 1200, speedup: 4 }, sitl: { ownership: 'launcher', experimentId: 'x', ardupilot: { ...FIRMWARE, binarySha256: '9'.repeat(64) } } });
    expect(flags(side(), b, 'configurations')).toEqual(['home', 'ardupilot', 'physics-rate']);
  });
  test('what a user holds is what is flagged', () => {
    const a = side(), b = side({}, { ...base, battery: { card: OTHER_BATTERY } });
    expect(flags(a, b, 'configurations')).toEqual(['battery']);
    const held = new Set(heldByDefault('configurations'));
    held.delete('battery');
    expect(comparisonControls(a, b, held).filter(row => row.flagged)).toEqual([]);
  });
  test('the declination that follows from the home is not an input of its own', () => {
    const b = side({ parameters: [{ name: 'MOT_PWM_MIN', value: 1000, source: 'pwm' }, { name: 'COMPASS_DEC', value: 0.5, source: 'site' }] });
    expect(differing(side(), b, 'configurations')).toEqual([]);
  });
  test('sensors are compared by what they are, not by which profile version the snapshot was copied from', () => {
    const snapshot = (profileSha256: string, bias: number) => ({ profileSha256, configuration: { imu: { accelBiasMps2: bias } } });
    const a = side({ sensors: snapshot('1'.repeat(64), 0) });
    expect(differing(a, side({ sensors: snapshot('2'.repeat(64), 0) }), 'conditions')).toEqual([]);
    expect(flags(a, side({ sensors: snapshot('2'.repeat(64), 0.1) }), 'conditions')).toEqual(['sensors']);
  });
  test('the parameters that differ are named', () => {
    const a = inputs({ parameters: [{ name: 'A', value: 1, source: 'pwm' }, { name: 'B', value: 2, source: 'pwm' }, { name: 'C', value: 3, source: 'pwm' }] });
    const b = inputs({ parameters: [{ name: 'A', value: 1, source: 'pwm' }, { name: 'B', value: 9, source: 'pwm' }, { name: 'D', value: 4, source: 'pwm' }] });
    expect(parameterDifferences(a, b)).toEqual(['B', 'C', 'D']);
  });
  test('a profile version this project does not hold can still be told apart by its address', () => {
    const a: ComparedExperiment = { name: 'A', payload: inputs(), aircraft: null };
    const same: ComparedExperiment = { name: 'B', payload: inputs(), aircraft: null };
    const other: ComparedExperiment = { name: 'C', payload: inputs({ profile: { sha256: '7'.repeat(64) } }), aircraft: null };
    expect(differing(a, same, 'configurations')).toEqual([]);
    expect(differing(a, other, 'conditions').map(row => row.control)).toContain('motors');
    expect(differing(a, other, 'conditions')[0]?.a).toContain('not in this project');
  });
});

describe('how the mass changed', () => {
  test('heavier motors, stated: the components explain the change', () => {
    // Four motors at 0.05 kg are 0.2 kg; at 0.07 kg, 0.28 kg: 0.08 kg more.
    const b = { ...motorsOn(OTHER_MOTOR), massProperties: { ...base.massProperties, massKg: base.massProperties.massKg + 0.08 } };
    const mass = massAccounting(side(), side({}, b));
    expect(mass?.parts.find(part => part.part === 'motors')).toMatchObject({ aKg: 0.2, bKg: 0.28 });
    expect(mass?.componentDifferenceKg).toBeCloseTo(0.08, 12);
    expect(mass?.statedDifferenceKg).toBeCloseTo(0.08, 12);
    expect(mass?.unaccountedKg).toBeCloseTo(0, 12);
    expect(mass?.flagged).toBe(false);
  });
  test('heavier motors on an aircraft that states the same mass are flagged: the swap was not accounted for', () => {
    const mass = massAccounting(side(), side({}, motorsOn(OTHER_MOTOR)));
    expect(mass?.statedDifferenceKg).toBe(0);
    expect(mass?.unaccountedKg).toBeCloseTo(-0.08, 12);
    expect(mass?.flagged).toBe(true);
  });
  test('a stated change no component explains is flagged too', () => {
    const b = { ...base, massProperties: { ...base.massProperties, massKg: base.massProperties.massKg + 0.5 } };
    const mass = massAccounting(side(), side({}, b));
    expect(mass?.componentDifferenceKg).toBe(0);
    expect(mass?.unaccountedKg).toBeCloseTo(0.5, 12);
    expect(mass?.flagged).toBe(true);
  });
  test('the payload stays apart from the aircraft, and the total holds both', () => {
    const payload = { massKg: 0.5, cgOffsetBodyM: [0, 0, 0], inertiaCgKgM2: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
    const mass = massAccounting(side(), side({}, { ...base, payload }));
    expect(mass?.payloadKg).toEqual([0, 0.5]);
    expect(mass?.totalKg).toEqual([base.massProperties.massKg, base.massProperties.massKg + 0.5]);
    expect(mass?.flagged).toBe(false);
  });
  test('a card that states no mass is no difference if both use it, and unknown if they do not', () => {
    const unknown = new Map(cards());
    unknown.set(MOTOR, withMass(exampleCard('motor'), null));
    const same = massAccounting(side({}, base, unknown), side({}, base, unknown));
    expect(same?.parts.find(part => part.part === 'motors')).toMatchObject({ aKg: null, bKg: null, differenceKg: 0 });
    expect(same?.componentDifferenceKg).toBe(0);
    const changed = massAccounting(side({}, base, unknown), side({}, motorsOn(OTHER_MOTOR), unknown));
    expect(changed?.parts.find(part => part.part === 'motors')).toMatchObject({ aKg: null, bKg: 0.28, differenceKg: null });
    expect(changed?.componentDifferenceKg).toBeNull();
    expect(changed?.unaccountedKg).toBeNull();
    expect(changed?.flagged).toBe(false);
  });
  test('without both versions there is no accounting to show', () => {
    expect(massAccounting({ name: 'A', payload: inputs(), aircraft: null }, side())).toBeNull();
  });
});

const windowOf = (edit: Partial<WindowMetrics> = {}): WindowMetrics => ({ startS: 10, endS: 20, durationS: 10, rpm: { mean: 6000, max: 6500 }, command: { mean: 0.5, max: 0.6 }, current: { mean: 20, max: 25 }, power: { mean: 300, max: 350 }, voltage: { min: 14.5 }, energyWh: 0.8, chargeUsedAh: 0.05, ...edit });
const metricsOf = (edit: Partial<ExperimentMetrics> = {}): ExperimentMetrics => ({
  flight: { liftedOff: true, restAltitudeM: 0.1, highestAboveRestM: 5, startS: 5, endS: 25 }, task: windowOf(), wholeFlight: windowOf({ startS: 5, endS: 25, durationS: 20, current: { mean: 22, max: 30 } }),
  pack: { remainingAh: 5, capacityAh: 5 }, position: { samples: 100, horizontalRmsM: 0.1, horizontalMaxM: 0.2, altitudeRmsM: 0.05, altitudeMaxM: 0.1 }, response: null, limits: { recorded: true, dropped: 0, entries: [] }, ...edit,
});
const CAPACITY: ThrustCapacity = { stateOfCharge: 1, densityKgM3: 1.225, thrustN: 40, weightN: 20, thrustToWeight: 2, busVoltageV: 15, busCurrentA: 80, packLimited: false, motorPowerW: 1200, rotors: [] };
const valueOf = (rows: ReturnType<typeof metricRows>, id: string) => rows.find(row => row.id === id);

describe('the results side by side', () => {
  test('each has both values and B less A', () => {
    const rows = metricRows({ a: metricsOf(), b: metricsOf({ task: windowOf({ current: { mean: 25, max: 30 } }) }), capacityA: CAPACITY, capacityB: { ...CAPACITY, thrustN: 30, thrustToWeight: 1.5 }, reservePercent: 20 });
    expect(valueOf(rows, 'current-mean')).toMatchObject({ a: 20, b: 25, difference: 5, unit: 'A' });
    expect(valueOf(rows, 'thrust-to-weight')).toMatchObject({ a: 2, b: 1.5, difference: -0.5 });
    expect(valueOf(rows, 'highest')).toMatchObject({ a: 5, b: 5, difference: 0 });
  });
  test('they compare the task\'s measured part if both have one, or else the whole flight', () => {
    expect(comparisonWindowKind(metricsOf(), metricsOf())).toBe('task');
    expect(comparisonWindowKind(metricsOf(), metricsOf({ task: null }))).toBe('flight');
    const rows = metricRows({ a: metricsOf(), b: metricsOf({ task: null }), capacityA: null, capacityB: null, reservePercent: 20 });
    expect(valueOf(rows, 'current-mean')).toMatchObject({ a: 22, b: 22, difference: 0 });
    expect(valueOf(rows, 'window')).toMatchObject({ a: 20, b: 20 });
  });
  test('the duration estimate uses the reserve it is given', () => {
    // 4 Ah above a 20 % reserve at 20 A is 12 minutes; at 40 % it is 3 Ah, 9 minutes.
    const a = metricsOf(), b = metricsOf();
    expect(valueOf(metricRows({ a, b, capacityA: null, capacityB: null, reservePercent: 20 }), 'duration')).toMatchObject({ a: 12, b: 12, difference: 0 });
    expect(valueOf(metricRows({ a, b, capacityA: null, capacityB: null, reservePercent: 40 }), 'duration')?.a).toBeCloseTo(9, 12);
  });
  test('a value only one side has reads as missing, with no difference', () => {
    const rows = metricRows({ a: metricsOf(), b: metricsOf({ task: windowOf({ energyWh: null }), position: null }), capacityA: CAPACITY, capacityB: null, reservePercent: 20 });
    expect(valueOf(rows, 'energy')).toMatchObject({ a: 0.8, b: null, difference: null });
    expect(valueOf(rows, 'altitude-rms')).toMatchObject({ a: 0.05, b: null, difference: null });
    expect(valueOf(rows, 'thrust')).toMatchObject({ a: 40, b: null, difference: null });
  });
  test('the estimate names its scenario and its reserve', () => {
    expect(durationScenario('task', 'Hover 5 m', 20)).toContain('the measured part of Hover 5 m');
    expect(durationScenario('task', 'Hover 5 m', 20)).toContain('20 % reserve');
    expect(durationScenario('flight', null, 30)).toContain('this whole flight');
    expect(durationScenario('flight', null, 30)).toContain('30 % reserve');
  });
});
