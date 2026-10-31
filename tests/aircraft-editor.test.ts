// TASK-141 (S03): the aircraft editor's form logic and the scheme's render
// poses. Oracles: the five S19 fixtures (built through the recipes a user
// types), their canonical bytes, and an independent quaternion rotation and
// FRD-to-render mapping written here.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { canonicalBytes } from '../packages/project/src/schema.ts';
import { deriveLayout } from '../packages/aircraft/src/layout.ts';
import { validateAircraftProfile, type AircraftProfile } from '../packages/aircraft/src/profile.ts';
import {
  MAX_ARMS, angleField, applyEvenLayout, choosePropellerPolar, editAngle, emptyForm, evenLayout, formFromProfile, profileFromForm,
  propellerCardsOf,
  type ArmForm, type MassForm, type ProfileForm,
} from '../apps/web/src/aircraft/profile-form.ts';
import { rotorRenderPose } from '../apps/web/src/aircraft/scheme-geometry.ts';
import { FIXTURE_NAMES } from './support/aircraft-derivation.ts';
import { RECIPES, profileDifferences, rotate, toRender, type MassText, type Recipe } from './support/aircraft-recipes.ts';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
function fixture(name: string): AircraftProfile {
  const parsed: unknown = JSON.parse(readFileSync(new URL(`./fixtures/aircraft/${name}.json`, import.meta.url), 'utf8'));
  return validateAircraftProfile(parsed);
}
const same = (a: unknown, b: unknown) => Buffer.from(canonicalBytes(a)).equals(Buffer.from(canonicalBytes(b)));
function built(form: ProfileForm): AircraftProfile {
  const result = profileFromForm(form);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.profile;
}
function massForm(text: MassText): MassForm {
  const [xx, yy, zz, xy, xz, yz] = text.inertia;
  return { massKg: text.massKg, cg: [...text.cg], inertia: { xx, yy, zz, xy, xz, yz } };
}
/** Applies a recipe to the form logic as the editor's controls do. */
function buildRecipe(recipe: Recipe): AircraftProfile {
  const layout = evenLayout(recipe.layout);
  if (!layout.ok) throw new Error(layout.errors.join('; '));
  const form: Mutable<ProfileForm> = structuredClone(applyEvenLayout(emptyForm(), layout.arms)) as Mutable<ProfileForm>;
  for (const edit of recipe.arms) {
    const arm = form.arms[edit.arm - 1]!;
    if (edit.heightM !== undefined) arm.heightM = edit.heightM;
    if (edit.outwardTiltDeg !== undefined) arm.outwardTilt = editAngle(edit.outwardTiltDeg);
    if (edit.sideTiltDeg !== undefined) arm.sideTilt = editAngle(edit.sideTiltDeg);
  }
  for (const edit of recipe.motors) {
    const motor = form.arms[edit.arm - 1]![edit.position];
    motor.id = edit.id;
    motor.output = edit.output;
  }
  return built({ ...form, mass: massForm(recipe.mass), payloadEnabled: recipe.payload !== null,
    payload: recipe.payload ? massForm(recipe.payload) : form.payload, groundClearanceM: recipe.groundClearanceM });
}
describe('profile form', () => {
  test('opening and saving an unchanged profile reproduces its exact bytes', () => {
    for (const name of FIXTURE_NAMES) {
      const profile = fixture(name);
      expect(same(built(formFromProfile(profile)), profile), name).toBe(true);
    }
    // A schema 2 profile keeps its calculation and bound sets.
    const measured = validateAircraftProfile({ ...fixture('quad-x'), schemaVersion: 2, calculation: { mode: 'measured', measurementSets: ['f1'.repeat(32)] } });
    expect(same(built(formFromProfile(measured)), measured)).toBe(true);
    // A new profile is written in schema 2, in preliminary mode.
    expect(emptyForm().calculation).toEqual({ mode: 'preliminary', measurementSets: [] });
  });

  test('the even layout and a few edits build the five S19 configurations', () => {
    expect(RECIPES.map(recipe => recipe.fixture)).toEqual([...FIXTURE_NAMES]);
    for (const recipe of RECIPES) {
      const profile = buildRecipe(recipe);
      expect(profile.schemaVersion, recipe.fixture).toBe(2);
      expect(profileDifferences(profile, fixture(recipe.fixture)), recipe.fixture).toEqual([]);
      // Whole and half degrees give the fixtures' azimuths bit for bit.
      expect(profile.arms.map(arm => arm.azimuthRad), recipe.fixture).toEqual(fixture(recipe.fixture).arms.map(arm => arm.azimuthRad));
    }
  });

  test('the even layout spaces arms evenly from the first azimuth and alternates spins', () => {
    const quad = evenLayout({ count: '4', lengthM: '0.225', firstAzimuthDeg: '45', coaxial: false, pairSeparationM: '' });
    if (!quad.ok) throw new Error('layout failed');
    expect(quad.arms.map(arm => arm.azimuth.text)).toEqual(['45', '135', '-135', '-45']);
    expect(quad.arms.map(arm => [arm.upper.id, arm.upper.output, arm.upper.spin])).toEqual([['1', '1', 'ccw'], ['2', '2', 'cw'], ['3', '3', 'ccw'], ['4', '4', 'cw']]);
    const pairs = evenLayout({ count: '3', lengthM: '0.3', firstAzimuthDeg: '180', coaxial: true, pairSeparationM: '0.08' });
    if (!pairs.ok) throw new Error('layout failed');
    // 180, 300 and 420 degrees wrap into (-180, 180].
    expect(pairs.arms.map(arm => arm.azimuth.text)).toEqual(['180', '-60', '60']);
    expect(pairs.arms.map(arm => [arm.coaxial, arm.lower.id, arm.lower.output, arm.lower.spin])).toEqual(
      [[true, '4', '4', 'cw'], [true, '5', '5', 'ccw'], [true, '6', '6', 'cw']]);
    for (const [count, message] of [['9', `1 to ${MAX_ARMS} arms`], ['0', `1 to ${MAX_ARMS} arms`], ['2.5', `1 to ${MAX_ARMS} arms`]] as const) {
      const result = evenLayout({ count, lengthM: '0.3', firstAzimuthDeg: '45', coaxial: false, pairSeparationM: '' });
      expect(result.ok ? '' : result.errors.join('; '), count).toContain(message);
    }
    const noSeparation = evenLayout({ count: '4', lengthM: '0.3', firstAzimuthDeg: '45', coaxial: true, pairSeparationM: '' });
    expect(noSeparation.ok ? '' : noSeparation.errors.join('; ')).toContain('Pair separation is not a decimal number');
  });

  test('an edited angle replaces its stored radians; an untouched one keeps them', () => {
    expect(angleField(0.05)).toEqual({ text: '2.86478897565', rad: 0.05 });
    expect(angleField(-Math.PI / 4)).toEqual({ text: '-45', rad: -Math.PI / 4 });
    expect(editAngle('3')).toEqual({ text: '3', rad: null });
    const form = structuredClone(formFromProfile(fixture('hexa-x'))) as Mutable<ProfileForm>;
    form.arms[0]!.sideTilt = editAngle('3');
    const profile = built(form);
    expect(profile.arms[0]!.sideTiltRad).toBe((3 * Math.PI) / 180);
    expect(profile.arms[1]!.sideTiltRad).toBe(-0.05);
  });

  test('invalid forms are explained, field by field', () => {
    const quad = () => structuredClone(formFromProfile(fixture('quad-x'))) as Mutable<ProfileForm>;
    const edit = (change: (form: Mutable<ProfileForm>) => void) => { const form = quad(); change(form); return form; };
    const errors = (form: ProfileForm) => {
      const result = profileFromForm(form);
      return result.ok ? [] : result.errors;
    };
    const cases: [string, ProfileForm, string][] = [
      ['no arms', { ...emptyForm(), arms: [] }, 'Add at least one arm'],
      ['no mass', emptyForm(), 'Aircraft mass is not a decimal number'],
      ['a word for a length', edit(f => { f.arms[1]!.lengthM = 'long'; }), 'Arm 2 length is not a decimal number'],
      ['a zero length', edit(f => { f.arms[1]!.lengthM = '0'; }), 'Arm 2 length must be above 0 m'],
      ['azimuth -180', edit(f => { f.arms[0]!.azimuth = editAngle('-180'); }), 'Arm 1 azimuth must be above -180° and at most 180°'],
      ['a 90° tilt', edit(f => { f.arms[0]!.outwardTilt = editAngle('90'); }), 'Arm 1 outward tilt must be between -90° and 90°'],
      ['motor 17', edit(f => { f.arms[0]!.upper.id = '17'; }), 'Arm 1 motor number must be a whole number from 1 to 16'],
      ['output 1.5', edit(f => { f.arms[0]!.upper.output = '1.5'; }), 'Arm 1 output must be a whole number from 1 to 16'],
      ['a repeated motor number', edit(f => { f.arms[1]!.upper.id = '1'; }), 'Motor 1 is on arm 1 and arm 2'],
      ['a repeated output', edit(f => { f.arms[1]!.upper.output = '1'; }), 'Output 1 is assigned to motors 1 and 4'],
      ['nine arms', edit(f => { f.arms = Array.from({ length: 9 }, (_, i): ArmForm => ({ ...f.arms[0]!, upper: { ...f.arms[0]!.upper, id: String(i + 1), output: String(i + 1) } })); }), `at most ${MAX_ARMS} arms`],
      ['a zero pair separation', edit(f => { f.arms[0]!.coaxial = true; f.arms[0]!.pairSeparationM = '0'; f.arms[0]!.lower = { ...f.arms[0]!.lower, id: '5', output: '5' }; }), 'Arm 1 pair separation must be above 0 m'],
      ['an indefinite inertia', edit(f => { f.mass.inertia.xy = '0.03'; }), 'Aircraft inertia must be positive definite'],
      ['a payload without mass', edit(f => { f.payloadEnabled = true; f.payload = { massKg: '', cg: ['0', '0', '0'], inertia: { xx: '0', yy: '0', zz: '0', xy: '0', xz: '0', yz: '0' } }; }), 'Payload mass is not a decimal number'],
      ['a negative clearance', edit(f => { f.groundClearanceM = '-0.1'; }), 'Ground clearance must be above 0 m'],
    ];
    for (const [label, form, message] of cases) expect(errors(form).join('; '), label).toContain(message);
    // A profile-check message is shown as the reason itself, without the validator's prefix.
    expect(errors(edit(f => { f.mass.inertia.xy = '0.03'; }))).toEqual(['Aircraft inertia must be positive definite']);
    // Every parse error is reported at once, not only the first.
    expect(errors(edit(f => { f.arms[0]!.lengthM = 'x'; f.arms[2]!.heightM = 'y'; f.mass.massKg = ''; }))).toEqual([
      'Arm 1 length is not a decimal number', 'Arm 3 height is not a decimal number', 'Aircraft mass is not a decimal number',
    ]);
  });
});

describe('propeller polars in the form (TASK-144)', () => {
  const A = 'a1'.repeat(32), B = 'b2'.repeat(32);
  function withCards(form: ProfileForm): ProfileForm {
    return { ...form, arms: form.arms.map((arm, index) => ({ ...arm, upper: { ...arm.upper, propeller: index < 2 ? A : B } })) };
  }
  test('a chosen polar makes schema 4, reopens unchanged and drops when its card leaves the profile', () => {
    const base = withCards(formFromProfile(fixture('quad-x')));
    expect(propellerCardsOf(base)).toEqual([A, B]);
    const chosen = choosePropellerPolar(choosePropellerPolar(base, B, 'naca0012-neuralfoil-v1'), A, 'naca6409-neuralfoil-v1');
    const profile = built(chosen);
    expect(profile.schemaVersion).toBe(4);
    expect(profile.schemaVersion === 4 && profile.propellerPolars).toEqual([
      { card: A, polar: 'naca6409-neuralfoil-v1' }, { card: B, polar: 'naca0012-neuralfoil-v1' }]);
    // Opening and saving unchanged reproduces the bytes.
    expect(same(built(formFromProfile(profile)), profile)).toBe(true);
    // Unchoosing returns the lowest schema; replacing card B drops its choice.
    expect(built(choosePropellerPolar(chosen, A, null)).schemaVersion).toBe(4);
    expect(built(choosePropellerPolar(choosePropellerPolar(chosen, A, null), B, null)).schemaVersion).toBe(1);
    const replaced = { ...chosen, arms: chosen.arms.map(arm => ({ ...arm, upper: { ...arm.upper, propeller: A } })) };
    const kept = built(replaced);
    expect(kept.schemaVersion === 4 && kept.propellerPolars).toEqual([{ card: A, polar: 'naca6409-neuralfoil-v1' }]);
  });
});

describe('scheme render poses', () => {
  test('each rotor is placed at its hub and turned so its +z axis is the thrust axis', () => {
    for (const name of FIXTURE_NAMES) {
      for (const rotor of deriveLayout(fixture(name)).rotors) {
        const pose = rotorRenderPose(rotor);
        expect(pose.position, `${name} rotor ${rotor.motorId}`).toEqual(toRender(rotor.hubPositionBodyM));
        // Three.js quaternions are (x, y, z, w).
        const [x = 0, y = 0, z = 0, w = 0] = pose.quaternion;
        const axis = rotate([w, x, y, z], [0, 0, 1]), expected = toRender(rotate(rotor.hubToBody, [0, 0, 1]));
        expected.forEach((value, i) => expect(Math.abs(axis[i]! - value), `${name} rotor ${rotor.motorId} axis ${i}`).toBeLessThanOrEqual(1e-12));
        toRender(rotor.thrustAxisBody).forEach((value, i) => expect(Math.abs(axis[i]! - value)).toBeLessThanOrEqual(1e-12));
      }
    }
  });
});
