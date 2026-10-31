// TASK-142 (S03): motor-to-output mapping and ArduPilot frame parameters.
// Oracles: the parameter files TASK-128 set, read back and flew on native
// ArduCopter (scripts/sitl/multirotor.mjs frameParameters/frameScript), the
// source-derived normalized factors of tests/fixtures/sitl/frames.json, and
// output functions typed here by hand from the stock motor tables.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalBytes } from '../packages/project/src/schema.ts';
import { validateAircraftProfile, type AircraftProfile } from '../packages/aircraft/src/profile.ts';
import { outputMappingOf, validateOutputMapping, withOutputMapping } from '../packages/aircraft/src/output-mapping.ts';
import { FRAME_PARAMETER_NAMES, frameConfiguration, parameterFileText, parseFrameCatalog } from '../packages/aircraft/src/frame-parameters.ts';
import { FIXTURE_NAMES } from './support/aircraft-derivation.ts';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const catalogText = readFileSync(new URL('./fixtures/sitl/frames.json', import.meta.url), 'utf8');
const catalogJson: unknown = JSON.parse(catalogText);
// Shape validation only; the values themselves are the source-derived oracle.
const catalog = parseFrameCatalog(catalogJson);
type CatalogFrame = (typeof catalog.frames)[number];
const apCatalog: unknown = JSON.parse(readFileSync(new URL('./fixtures/sitl/ardupilot-catalog.json', import.meta.url), 'utf8'));
/** The harness's own parameter files and Lua, from a separate Node process (scripts/sitl/multirotor.mjs). */
const harness = (() => {
  const program = `import {frameParameters,frameScript} from './scripts/sitl/multirotor.mjs';
const ids=${JSON.stringify(catalog.frames.map(frame => frame.id))};
console.log(JSON.stringify(Object.fromEntries(ids.map(id=>[id,{parameters:frameParameters(id),script:frameScript(id)}]))));`;
  const output: unknown = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' }));
  const files = new Map<string, { parameters: string; script: string | null }>();
  for (const frame of catalog.frames) {
    const entry: unknown = typeof output === 'object' && output !== null ? Reflect.get(output, frame.id) : null;
    const parameters: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'parameters') : null;
    const script: unknown = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'script') : undefined;
    if (typeof parameters !== 'string' || (script !== null && typeof script !== 'string')) throw new Error(`No harness output for ${frame.id}`);
    files.set(frame.id, { parameters, script });
  }
  return files;
})();
const frameParameters = (id: string) => harness.get(id)!.parameters;
const frameScript = (id: string) => harness.get(id)!.script;
function fixture(name: string): AircraftProfile {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`./fixtures/aircraft/${name}.json`, import.meta.url), 'utf8'));
  return validateAircraftProfile(parsed);
}
const same = (a: unknown, b: unknown) => Buffer.from(canonicalBytes(a)).equals(Buffer.from(canonicalBytes(b)));
/** Lines the TASK-128 harness adds for its own run, not frame or output settings. */
const HARNESS_ONLY = new Set(['ARMING_SKIPCHK', 'MOT_PWM_MIN', 'MOT_PWM_MAX', 'SIM_RATE_HZ']);
function flownFrameLines(id: string): string {
  return frameParameters(id).split('\n').filter(line => line !== '' && !HARNESS_ONLY.has(line.split(' ')[0]!)).map(line => `${line}\n`).join('');
}
/** A schema 1 profile with motor N on output N at the catalog motor's azimuth, spin and level. */
function profileFromCatalog(frame: CatalogFrame, armM = 0.2): AircraftProfile {
  const azimuths = [...new Set(frame.motors.map(motor => motor.azimuthDeg))];
  const coaxial = azimuths.length < frame.motors.length;
  const arms = azimuths.map((azimuthDeg, index) => {
    const wrapped = azimuthDeg > 180 ? azimuthDeg - 360 : azimuthDeg;
    return { id: index + 1, lengthM: armM, azimuthRad: wrapped * Math.PI / 180, heightM: 0, outwardTiltRad: 0, sideTiltRad: 0, pairSeparationM: coaxial ? 0.06 : null };
  });
  const motors = frame.motors.map(motor => ({
    id: motor.motor, armId: azimuths.indexOf(motor.azimuthDeg) + 1,
    level: coaxial ? (motor.heightM < 0 ? 'upper' : 'lower') : 'single', spin: motor.spin === 'CCW' ? 'ccw' : 'cw',
    output: motor.motor, components: { motor: null, propeller: null, esc: null },
  }));
  return validateAircraftProfile({
    schemaVersion: 1, units: 'SI', bodyFrame: 'FRD', arms, motors, payload: null,
    battery: { card: null }, groundClearanceM: null, sensorConfiguration: null, massProperties: fixture('quad-x').massProperties,
  });
}
function editable(profile: AircraftProfile): Mutable<AircraftProfile> {
  return structuredClone(profile) as Mutable<AircraftProfile>;
}

describe('motor-to-output mapping', () => {
  test('round-trips every S19 fixture to identical profile bytes', () => {
    for (const name of FIXTURE_NAMES) {
      const profile = fixture(name);
      const mapping: unknown = JSON.parse(JSON.stringify(outputMappingOf(profile)));
      expect(same(validateOutputMapping(mapping, profile), outputMappingOf(profile))).toBe(true);
      expect(same(withOutputMapping(profile, mapping), profile)).toBe(true);
    }
  });
  test('applies a permuted mapping and reads it back unchanged', () => {
    const profile = fixture('octa-coaxial-16');
    const entries = profile.motors.map(motor => ({ motorId: motor.id, output: 17 - motor.output }));
    const mapped = withOutputMapping(profile, { schemaVersion: 1, entries });
    expect(outputMappingOf(mapped).entries).toEqual(entries);
    expect(same({ ...mapped, motors: mapped.motors.map(motor => ({ ...motor, output: 0 })) },
      { ...profile, motors: profile.motors.map(motor => ({ ...motor, output: 0 })) })).toBe(true);
  });
  test('refuses incomplete, misordered, out-of-range and repeated assignments with a reason', () => {
    const profile = fixture('quad-x');
    const good = outputMappingOf(profile).entries.map(entry => ({ ...entry }));
    const cases: [unknown, RegExp][] = [
      [null, /not an object/],
      [{ schemaVersion: 2, entries: good }, /schema version/],
      [{ schemaVersion: 1, entries: good, extra: 1 }, /unexpected fields/],
      [{ schemaVersion: 1, entries: good.slice(1) }, /3 entries for 4 motors/],
      [{ schemaVersion: 1, entries: [good[1], good[0], good[2], good[3]] }, /names motor 2, expected motor 1/],
      [{ schemaVersion: 1, entries: good.map((entry, i) => (i === 0 ? { ...entry, output: 0 } : entry)) }, /output from 1 to 16/],
      [{ schemaVersion: 1, entries: good.map((entry, i) => (i === 0 ? { ...entry, output: 17 } : entry)) }, /output from 1 to 16/],
      [{ schemaVersion: 1, entries: good.map((entry, i) => (i === 0 ? { ...entry, output: 1.5 } : entry)) }, /output from 1 to 16/],
      [{ schemaVersion: 1, entries: good.map((entry, i) => (i === 1 ? { ...entry, output: 1 } : entry)) }, /output 1 is assigned to motors 1 and 2/],
      [{ schemaVersion: 1, entries: good.map((entry, i) => (i === 0 ? { ...entry, note: 'x' } : entry)) }, /must hold motorId and output/],
    ];
    for (const [input, reason] of cases) {
      expect(() => validateOutputMapping(input, profile)).toThrow(reason);
      expect(() => withOutputMapping(profile, input)).toThrow(reason);
    }
  });
});

describe('frame parameters from the TASK-128 catalog', () => {
  test('reproduce the flown parameter file of each catalog frame', () => {
    for (const frame of catalog.frames) {
      const config = frameConfiguration(profileFromCatalog(frame));
      if (!config.ok) throw new Error(`${frame.id}: ${config.reasons.map(reason => reason.message).join('; ')}`);
      expect(config.kind).toBe(frame.kind);
      expect(config.catalogFrameId).toBe(frame.id);
      expect(parameterFileText(config.parameters)).toBe(flownFrameLines(frame.id));
      for (const [index, motor] of config.motors.entries()) {
        const source = frame.motors[motor.ardupilotMotor - 1]!;
        expect(motor.ardupilotMotor).toBe(index + 1);
        expect(motor.rollFactor).toBeCloseTo(source.rollFactor, 12);
        expect(motor.pitchFactor).toBeCloseTo(source.pitchFactor, 12);
        expect(motor.yawFactor).toBe(source.normalizedYawFactor);
        expect(motor.testOrder).toBe(source.testOrder);
      }
    }
  });
  test('generate the paired-16 Lua allocation the harness flew', () => {
    const frame = catalog.frames.find(item => item.id === 'paired-16')!;
    const config = frameConfiguration(profileFromCatalog(frame));
    if (!config.ok || config.script === null) throw new Error('paired-16 must use the scripting matrix');
    const call = /^MotorsMatrix:add_motor_raw\((.+)\)$/;
    const ours = config.script.split('\n').filter(line => call.test(line));
    const flown = (frameScript('paired-16') ?? '').split('\n').filter(line => call.test(line));
    expect(ours).toHaveLength(16);
    expect(flown).toHaveLength(16);
    const evaluate = (text: string) => text.replace(/math\.cos\(math\.rad\(([-\d.+]+)\)\)/g, (_, angle: string) => {
      const degrees = angle.split('+').reduce((sum, part) => sum + Number(part), 0);
      return String(Math.cos(degrees * Math.PI / 180));
    }).split(',').map(Number);
    ours.forEach((line, index) => {
      const a = evaluate(call.exec(line)![1]!), b = evaluate(call.exec(flown[index]!)![1]!);
      expect(a[0]).toBe(b[0]);
      for (const k of [1, 2]) expect(a[k]).toBeCloseTo(b[k]!, 14);
      expect(a.slice(3)).toEqual(b.slice(3));
    });
    expect(config.script).toContain('assert(MotorsMatrix:init(16), "MirageSITL frame init failed")');
  });
  test('use only names TASK-128 set and read back on the pinned firmware', () => {
    const flownNames = new Set(catalog.frames.flatMap(frame => frameParameters(frame.id).trim().split('\n').map(line => line.split(' ')[0]!)));
    for (const name of FRAME_PARAMETER_NAMES) {
      if (/^SERVO\d+_FUNCTION$/.test(name) || name === 'SERVO_32_ENABLE' || name === 'SCR_ENABLE') expect(flownNames.has(name)).toBe(true);
    }
    const defaults: unknown = typeof apCatalog === 'object' && apCatalog !== null ? Reflect.get(apCatalog, 'copterDefaults') : null;
    expect(typeof defaults === 'object' && defaults !== null && 'FRAME_CLASS' in defaults && 'FRAME_TYPE' in defaults).toBe(true);
    for (const name of FIXTURE_NAMES) {
      const config = frameConfiguration(fixture(name));
      if (!config.ok) throw new Error(name);
      for (const parameter of config.parameters) expect(flownNames.has(parameter.name)).toBe(true);
    }
  });
  test('map the five S19 fixtures to hand-checked frames and output functions', () => {
    // Function per output 1..n: Motor1-8 are 33-40, Motor9-12 82-85, Motor13-16 160-163.
    const expected: Record<string, { kind: string; frame: string | null; functions: number[]; notes: string[] }> = {
      'quad-x': { kind: 'stock', frame: 'quad-x', functions: [33, 34, 35, 36], notes: ['stock-frame'] },
      // 30° CCW is stock Motor5, 90° CW Motor1, 150° CCW Motor4, -150° CW Motor6, -90° CCW Motor2, -30° CW Motor3.
      'hexa-x': { kind: 'stock', frame: 'hexa-x', functions: [37, 33, 36, 38, 34, 35], notes: ['thrust-axis-tilt-ignored', 'stock-frame'] },
      // Stock OCTA X puts CW at 22.5°; this fixture puts CCW there, so every spin is the mirror.
      'octa-x': { kind: 'stock-scripting', frame: null, functions: [33, 34, 35, 36, 37, 38, 39, 40], notes: ['thrust-axis-tilt-ignored', 'stock-spin-mismatch', 'scripting-frame', 'thirty-two-channel-packets'] },
      // Upper 45° CCW Motor1, 135° CW Motor4, -135° CCW Motor3, -45° CW Motor2; lower 45° CW Motor6, 135° CCW Motor7, -135° CW Motor8, -45° CCW Motor5.
      'coaxial-x8': { kind: 'stock', frame: 'x8', functions: [33, 36, 35, 34, 38, 39, 40, 37], notes: ['stock-frame'] },
      'octa-coaxial-16': { kind: 'stock-scripting', frame: 'paired-16', functions: [33, 34, 35, 36, 37, 38, 39, 40, 82, 83, 84, 85, 160, 161, 162, 163], notes: ['thrust-axis-tilt-ignored', 'scripting-frame', 'thirty-two-channel-packets'] },
    };
    for (const name of FIXTURE_NAMES) {
      const profile = fixture(name);
      const config = frameConfiguration(profile, 'a'.repeat(64));
      const want = expected[name]!;
      if (!config.ok) throw new Error(name);
      expect([config.kind, config.catalogFrameId]).toEqual([want.kind, want.frame]);
      expect(config.profileSha256).toBe('a'.repeat(64));
      expect(config.notes.map(note => note.code)).toEqual(want.notes);
      const byOutput = new Map(config.parameters.map(parameter => [parameter.name, parameter.value]));
      want.functions.forEach((fn, index) => expect(byOutput.get(`SERVO${profile.motors[index]!.output}_FUNCTION`)).toBe(fn));
      const used = config.parameters.filter(parameter => /_FUNCTION$/.test(parameter.name) && parameter.value !== 0);
      expect(used).toHaveLength(profile.motors.length);
      expect(config.script === null).toBe(want.kind === 'stock');
      if (config.script) expect(config.script).toContain(`aircraft profile ${'a'.repeat(64)}`);
    }
  });
  test('follow a changed mapping: functions move with their motors', () => {
    const profile = fixture('quad-x');
    const swapped = withOutputMapping(profile, { schemaVersion: 1, entries: [
      { motorId: 1, output: 4 }, { motorId: 2, output: 3 }, { motorId: 3, output: 2 }, { motorId: 4, output: 1 },
    ] });
    const config = frameConfiguration(swapped);
    if (!config.ok) throw new Error('quad');
    const fn = (output: number) => config.parameters.find(parameter => parameter.name === `SERVO${output}_FUNCTION`)!.value;
    expect([fn(1), fn(2), fn(3), fn(4)]).toEqual([36, 35, 34, 33]);
  });
  test('use the scripting matrix for unequal arms, keeping the position-weighted factors', () => {
    const profile = editable(fixture('quad-x'));
    profile.arms[0]!.lengthM = 0.3;
    const config = frameConfiguration(validateAircraftProfile(profile));
    if (!config.ok) throw new Error('quad');
    expect(config.kind).toBe('stock-scripting');
    expect(config.notes.map(note => note.code)).toContain('stock-unequal-arms');
    // Arm 1 (motor 1) is the longest: its roll and pitch factors are the normalized maximum.
    expect(Math.abs(config.motors[0]!.rollFactor)).toBeCloseTo(0.5, 15);
    expect(Math.abs(config.motors[1]!.rollFactor)).toBeCloseTo(0.5 * 0.225 / 0.3, 15);
  });
  test('refuse layouts no allocation can control, with every reason', () => {
    const quad = fixture('quad-x');
    const sameSpin = editable(quad);
    for (const motor of sameSpin.motors) motor.spin = 'ccw';
    const pair = editable(fixture('coaxial-x8'));
    pair.arms = pair.arms.slice(0, 1);
    pair.motors = pair.motors.filter(motor => motor.armId === 1);
    const line = editable(fixture('coaxial-x8'));
    line.arms = line.arms.slice(0, 2).map((arm, index) => ({ ...arm, azimuthRad: index === 0 ? Math.PI / 2 : -Math.PI / 2 }));
    line.motors = line.motors.filter(motor => motor.armId <= 2);
    const tri = editable(quad);
    tri.arms = tri.arms.slice(0, 3).map((arm, index) => ({ ...arm, azimuthRad: [0, 2 * Math.PI / 3, -2 * Math.PI / 3][index]! }));
    tri.motors = tri.motors.slice(0, 3).map((motor, index) => ({ ...motor, armId: index + 1 }));
    const cases: [Mutable<AircraftProfile>, string[]][] = [
      [sameSpin, ['no-yaw-authority']],
      [pair, ['dependent-axes']],
      [line, ['no-pitch-authority']],
      [tri, ['dependent-axes']],
    ];
    for (const [input, codes] of cases) {
      const config = frameConfiguration(validateAircraftProfile(input));
      if (config.ok) throw new Error(`accepted ${codes.join(',')}`);
      expect(config.reasons.map(reason => reason.code)).toEqual(codes);
      for (const reason of config.reasons) expect(reason.message.length).toBeGreaterThan(20);
    }
  });
  test('reject a catalog that is not the TASK-128 shape', () => {
    expect(() => parseFrameCatalog({ schemaVersion: 2 })).toThrow(/unsupported schema/);
    const broken: unknown = JSON.parse(catalogText.replace('"spin": "CCW"', '"spin": "left"'));
    expect(() => parseFrameCatalog(broken)).toThrow(/unknown spin/);
    const reordered: unknown = JSON.parse(catalogText.replace(/"motor": 2,(\s*)"function": 34/, '"motor": 3,$1"function": 34'));
    expect(() => parseFrameCatalog(reordered)).toThrow(/in order/);
  });
});
