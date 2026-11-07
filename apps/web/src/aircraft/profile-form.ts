import {
  airframeDragOf, bodyOf, landingGearOf, propellerPolarsOf, propulsionCalibrationsOf, validateAircraftProfile, withProfileContent, type AircraftProfile,
  type BodyPart, type BoundCalibration, type CalculationSettings, type GearKind, type GearValues, type ProfileBody, type ProfileGear, type ProfileMotor,
  type PropellerPolar, type SpinDirection, type StatedAirframeDrag,
} from '@mirage/aircraft/profile';
import { GEAR_VALUES, mapGearValues } from '@mirage/aircraft/profile-gear';
import type { SensorConfiguration } from '@mirage/aircraft/sensor-fields';
import type { AirframeDrag, MassProperties } from '@mirage/physics/vehicle-manifest';
import { parseDecimal } from '../library/library-data';

// The aircraft editor's form (TASK-141, S03): the text a user types, turned
// into an aircraft profile only through validateAircraftProfile (TASK-138).
// Angles are typed in degrees and stored in radians. An angle whose text was
// not edited keeps the radians it was loaded with, so opening and saving an
// unchanged profile reproduces its bytes.

/** The profile schema's limits: eight arms, 16 motors and outputs (ABI v2 MAX_ACTUATORS). */
export const MAX_ARMS = 8;
export const MAX_MOTORS = 16;

/** An angle field: the degrees shown, and the stored radians while that text is unedited. */
export interface AngleField {
  readonly text: string;
  readonly rad: number | null;
}
export interface MotorForm {
  readonly id: string;
  readonly spin: SpinDirection;
  readonly output: string;
  /** Component-card version addresses (TASK-139), or null. */
  readonly motor: string | null;
  readonly propeller: string | null;
  readonly esc: string | null;
}
export interface ArmForm {
  readonly lengthM: string;
  readonly azimuth: AngleField;
  readonly heightM: string;
  readonly outwardTilt: AngleField;
  readonly sideTilt: AngleField;
  readonly coaxial: boolean;
  readonly pairSeparationM: string;
  /** The arm's single motor, or the upper motor of its pair. */
  readonly upper: MotorForm;
  /** The lower motor of a pair; kept while the arm is single, so switching back restores it. */
  readonly lower: MotorForm;
}
export interface MassForm {
  readonly massKg: string;
  readonly cg: readonly [string, string, string];
  /** Inertia tensor entries about the CG, kg·m². */
  readonly inertia: { readonly xx: string; readonly yy: string; readonly zz: string; readonly xy: string; readonly xz: string; readonly yz: string };
}
/** TASK-096: drag areas the user states for the airframe without its rotors, with their source. */
export interface DragForm {
  /** C_D·A along body x, y and z, m². */
  readonly areas: readonly [string, string, string];
  /** The center of pressure, body FRD metres from the reference point. */
  readonly cop: readonly [string, string, string];
  readonly maxAirspeedMps: string;
  readonly source: string;
}
/** TASK-194: one gear value as typed and its source; both empty when the value is not known. */
export interface GearValueForm {
  readonly value: string;
  readonly source: string;
}
/** TASK-194: a landing gear the user describes. Positions are the bottom of each foot or wheel with the struts fully extended. */
export interface GearForm {
  readonly kind: GearKind;
  /** Body x, y and z of each foot, m (z down). */
  readonly feet: readonly (readonly [string, string, string])[];
  readonly positionSource: string;
  readonly values: { readonly [K in keyof GearValues]: GearValueForm };
}
/** TASK-196: one named part of the body as typed: a vertical cylinder (centre, radius, half-height) or a capsule (two ends, radius). */
export interface BodyPartForm {
  readonly name: string;
  readonly shape: 'cylinder' | 'capsule';
  readonly center: readonly [string, string, string];
  readonly halfHeightM: string;
  readonly start: readonly [string, string, string];
  readonly end: readonly [string, string, string];
  readonly radiusM: string;
}
/** TASK-196: the body the user describes, in body axes from the reference point (z down). */
export interface BodyForm {
  readonly radiusM: string;
  readonly halfHeightM: string;
  readonly centerDownM: string;
  /** Empty for the standard arm thickness. */
  readonly armRadiusM: string;
  readonly parts: readonly BodyPartForm[];
  readonly source: string;
}
export interface ProfileForm {
  readonly arms: readonly ArmForm[];
  readonly mass: MassForm;
  readonly payloadEnabled: boolean;
  /** Kept while the payload is switched off, so switching it on restores the values. */
  readonly payload: MassForm;
  readonly batteryCard: string | null;
  /** Empty when not known. */
  readonly groundClearanceM: string;
  /** Null for a schema 1 profile, which stays schema 1 when saved unchanged. */
  readonly calculation: CalculationSettings | null;
  /** The sensor configuration (TASK-143), carried unchanged: the Sensors tab edits it. Null is the ArduPilot defaults. */
  readonly sensorConfiguration: SensorConfiguration | null;
  /** Chosen catalog polars of propeller cards (TASK-144); a choice for a card no motor uses any more is dropped on save. */
  readonly propellerPolars: readonly PropellerPolar[];
  /** TASK-096: whether the profile states its drag; otherwise it flies the standard hull's preliminary estimate. */
  readonly dragStated: boolean;
  /** Kept while the drag is not stated, so stating it again restores the values. */
  readonly drag: DragForm;
  /** TASK-194: whether the profile describes its landing gear; otherwise it stands on the standard supports. */
  readonly gearDescribed: boolean;
  /** Kept while the gear is not described, so describing it again restores the values. */
  readonly gear: GearForm;
  /** TASK-196: whether the profile describes its body; otherwise it flies the standard hull. */
  readonly bodyDescribed: boolean;
  /** Kept while the body is not described, so describing it again restores the values. */
  readonly body: BodyForm;
  /** The propulsion calibrations (TASK-145), carried unchanged: the Components tab binds them. */
  readonly propulsionCalibrations: readonly BoundCalibration[];
}
export type FormResult = { readonly ok: true; readonly profile: AircraftProfile } | { readonly ok: false; readonly errors: readonly string[] };

/** Degrees to radians as (deg·π)/180, which turns whole and half degrees into the fixtures' radians exactly. */
function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Degrees with 12 significant digits, the precision the form shows. */
export function angleField(rad: number): AngleField {
  return { text: String(Number(((rad * 180) / Math.PI).toPrecision(12))), rad };
}
/** An angle the user typed; its radians follow from the text. */
export function editAngle(text: string): AngleField {
  return { text, rad: null };
}
export function emptyMotor(spin: SpinDirection = 'ccw'): MotorForm {
  return { id: '', spin, output: '', motor: null, propeller: null, esc: null };
}
export function emptyDrag(): DragForm {
  return { areas: ['', '', ''], cop: ['', '', ''], maxAirspeedMps: '', source: '' };
}
/** Four significant digits of a value the estimate gives, as the form shows it. */
function shown(value: number): string {
  return String(Number(value.toPrecision(4)));
}
/** The drag form filled from the standard hull's estimate (TASK-096), for the user to adjust, with no source yet. */
export function dragFormFromEstimate(estimate: AirframeDrag & { readonly maxAirspeedMps?: number }): DragForm {
  const t = estimate.dragAreaBodyM2, c = estimate.centerOfPressureBodyM;
  return {
    areas: [shown(t[0] ?? 0), shown(t[4] ?? 0), shown(t[8] ?? 0)], cop: [shown(c[0] ?? 0), shown(c[1] ?? 0), shown(c[2] ?? 0)],
    maxAirspeedMps: estimate.maxAirspeedMps === undefined ? '' : shown(estimate.maxAirspeedMps), source: '',
  };
}
function dragForm(drag: StatedAirframeDrag): DragForm {
  const a = drag.dragAreasM2.map(String), c = drag.centerOfPressureBodyM.map(String);
  return { areas: [a[0] ?? '', a[1] ?? '', a[2] ?? ''], cop: [c[0] ?? '', c[1] ?? '', c[2] ?? ''], maxAirspeedMps: String(drag.maxAirspeedMps),
    source: drag.source };
}
/** A camera pod under the body's centre, to edit. */
export function emptyBodyPart(): BodyPartForm {
  return { name: 'Camera pod', shape: 'cylinder', center: ['0', '0', '0.06'], halfHeightM: '0.02', start: ['-0.05', '0', '0.06'], end: ['0.05', '0', '0.06'], radiusM: '0.03' };
}
/** A body 0.06 m across the radius and 0.05 m tall about the reference point, without parts; nothing about it is known yet. */
export function emptyBody(): BodyForm {
  return { radiusM: '0.06', halfHeightM: '0.025', centerDownM: '0', armRadiusM: '', parts: [], source: '' };
}
const text3 = (values: readonly number[]): readonly [string, string, string] => [String(values[0]), String(values[1]), String(values[2])];
function bodyForm(body: ProfileBody): BodyForm {
  return {
    radiusM: String(body.radiusM), halfHeightM: String(body.halfHeightM), centerDownM: String(body.centerDownM),
    armRadiusM: body.armRadiusM === null ? '' : String(body.armRadiusM), source: body.source,
    parts: body.parts.map((part): BodyPartForm => part.shape === 'cylinder'
      ? { ...emptyBodyPart(), name: part.name, shape: 'cylinder', center: text3(part.centerBodyM), halfHeightM: String(part.halfHeightM), radiusM: String(part.radiusM) }
      : { ...emptyBodyPart(), name: part.name, shape: 'capsule', start: text3(part.startBodyM), end: text3(part.endBodyM), radiusM: String(part.radiusM) }),
  };
}
const NO_VALUE: GearValueForm = { value: '', source: '' };
/** Four legs in a square under a 0.15 m stance, to edit; nothing about them is known yet. */
export function emptyGear(): GearForm {
  return {
    kind: 'legs', feet: [['0.15', '0.15', '0.1'], ['0.15', '-0.15', '0.1'], ['-0.15', '-0.15', '0.1'], ['-0.15', '0.15', '0.1']], positionSource: '',
    values: mapGearValues(() => NO_VALUE),
  };
}
function gearForm(gear: ProfileGear): GearForm {
  const entry = (key: keyof GearValues): GearValueForm => {
    const value = gear.values[key];
    return value === null ? NO_VALUE : { value: String(value), source: gear.provenance[key] ?? '' };
  };
  return {
    kind: gear.kind, feet: gear.feetBodyM.map(foot => [String(foot[0]), String(foot[1]), String(foot[2])] as const), positionSource: gear.positionSource,
    values: mapGearValues(entry),
  };
}
export function emptyMass(): MassForm {
  return { massKg: '', cg: ['', '', ''], inertia: { xx: '', yy: '', zz: '', xy: '', xz: '', yz: '' } };
}
/** A new profile: no arms and no mass values yet, in schema 2 preliminary mode. */
export function emptyForm(): ProfileForm {
  return {
    arms: [], mass: emptyMass(), payloadEnabled: false, payload: emptyMass(), batteryCard: null, groundClearanceM: '',
    calculation: { mode: 'preliminary', measurementSets: [] }, sensorConfiguration: null, propellerPolars: [], dragStated: false, drag: emptyDrag(),
    gearDescribed: false, gear: emptyGear(), bodyDescribed: false, body: emptyBody(), propulsionCalibrations: [],
  };
}

function massForm(mass: MassProperties): MassForm {
  const j = mass.inertiaCgKgM2.map(String), c = mass.cgOffsetBodyM.map(String);
  return {
    massKg: String(mass.massKg), cg: [c[0] ?? '', c[1] ?? '', c[2] ?? ''],
    inertia: { xx: j[0] ?? '', yy: j[4] ?? '', zz: j[8] ?? '', xy: j[1] ?? '', xz: j[2] ?? '', yz: j[5] ?? '' },
  };
}
function motorForm(motor: ProfileMotor): MotorForm {
  return { id: String(motor.id), spin: motor.spin, output: String(motor.output), ...motor.components };
}

/** The form of a stored profile. */
export function formFromProfile(profile: AircraftProfile): ProfileForm {
  const arms = profile.arms.map((arm): ArmForm => {
    const motors = profile.motors.filter(motor => motor.armId === arm.id);
    const upper = motors.find(motor => motor.level !== 'lower'), lower = motors.find(motor => motor.level === 'lower');
    return {
      lengthM: String(arm.lengthM), azimuth: angleField(arm.azimuthRad), heightM: String(arm.heightM),
      outwardTilt: angleField(arm.outwardTiltRad), sideTilt: angleField(arm.sideTiltRad),
      coaxial: arm.pairSeparationM !== null, pairSeparationM: arm.pairSeparationM === null ? '' : String(arm.pairSeparationM),
      upper: upper ? motorForm(upper) : emptyMotor(), lower: lower ? motorForm(lower) : emptyMotor('cw'),
    };
  });
  return {
    arms, mass: massForm(profile.massProperties), payloadEnabled: profile.payload !== null,
    payload: profile.payload ? massForm(profile.payload) : emptyMass(), batteryCard: profile.battery.card,
    groundClearanceM: profile.groundClearanceM === null ? '' : String(profile.groundClearanceM),
    calculation: profile.schemaVersion === 1 ? null : profile.calculation, sensorConfiguration: profile.sensorConfiguration,
    propellerPolars: propellerPolarsOf(profile), ...dragOf(profile),
    gearDescribed: landingGearOf(profile) !== null, gear: gearOfProfile(profile), propulsionCalibrations: propulsionCalibrationsOf(profile),
    ...bodyOfProfile(profile),
  };
}
function bodyOfProfile(profile: AircraftProfile): { bodyDescribed: boolean; body: BodyForm } {
  const body = bodyOf(profile);
  return { bodyDescribed: body !== null, body: body ? bodyForm(body) : emptyBody() };
}
function gearOfProfile(profile: AircraftProfile): GearForm {
  const gear = landingGearOf(profile);
  return gear ? gearForm(gear) : emptyGear();
}
function dragOf(profile: AircraftProfile): { dragStated: boolean; drag: DragForm } {
  const stated = airframeDragOf(profile);
  return { dragStated: stated !== null, drag: stated ? dragForm(stated) : emptyDrag() };
}

/** Collects parse errors so that every field at fault is reported at once. */
class Reader {
  readonly errors: string[] = [];
  number(text: string, label: string): number {
    try {
      return parseDecimal(text, label);
    } catch (cause) {
      this.errors.push(cause instanceof Error ? cause.message : `${label} is not a decimal number`);
      return Number.NaN;
    }
  }
  positive(text: string, label: string, unit: string): number {
    const value = this.number(text, label);
    if (value <= 0) this.errors.push(`${label} must be above 0 ${unit}`);
    return value;
  }
  whole(text: string, label: string): number {
    const value = Number(text.trim());
    if (!/^[0-9]+$/.test(text.trim()) || value < 1 || value > MAX_MOTORS) this.errors.push(`${label} must be a whole number from 1 to ${MAX_MOTORS}`);
    return value;
  }
  angle(field: AngleField, label: string, check: (deg: number) => boolean, range: string): number {
    if (field.rad !== null) return field.rad;
    const deg = this.number(field.text, label);
    if (Number.isFinite(deg) && !check(deg)) this.errors.push(`${label} must be ${range}`);
    return radians(deg);
  }
  mass(form: MassForm, label: string): MassProperties {
    const massKg = this.positive(form.massKg, `${label} mass`, 'kg');
    const cg = form.cg.map((text, i) => this.number(text, `${label} CG ${'xyz'[i] ?? ''}`));
    const j = form.inertia;
    const [xx, yy, zz, xy, xz, yz] = ([['xx', j.xx], ['yy', j.yy], ['zz', j.zz], ['xy', j.xy], ['xz', j.xz], ['yz', j.yz]] as const)
      .map(([name, text]) => this.number(text, `${label} inertia ${name}`));
    return { massKg, cgOffsetBodyM: cg, inertiaCgKgM2: [xx, xy, xz, xy, yy, yz, xz, yz, zz].map(value => value ?? Number.NaN) };
  }
}
const TILT_RANGE = 'between -90° and 90°';
const inTiltRange = (deg: number) => deg > -90 && deg < 90;

/** The profile a form describes, or every reason it is invalid. */
export function profileFromForm(form: ProfileForm): FormResult {
  const read = new Reader();
  if (form.arms.length === 0) read.errors.push('Add at least one arm');
  if (form.arms.length > MAX_ARMS) read.errors.push(`An aircraft has at most ${MAX_ARMS} arms`);
  const arms = [], motors: ProfileMotor[] = [];
  const armOfMotor = new Map<number, number>();
  for (const [index, arm] of form.arms.entries()) {
    const id = index + 1, label = `Arm ${id}`;
    const lengthM = read.positive(arm.lengthM, `${label} length`, 'm');
    const azimuthRad = read.angle(arm.azimuth, `${label} azimuth`, deg => deg > -180 && deg <= 180, 'above -180° and at most 180°');
    const heightM = read.number(arm.heightM, `${label} height`);
    const outwardTiltRad = read.angle(arm.outwardTilt, `${label} outward tilt`, inTiltRange, TILT_RANGE);
    const sideTiltRad = read.angle(arm.sideTilt, `${label} side tilt`, inTiltRange, TILT_RANGE);
    const pairSeparationM = arm.coaxial ? read.positive(arm.pairSeparationM, `${label} pair separation`, 'm') : null;
    arms.push({ id, lengthM, azimuthRad, heightM, outwardTiltRad, sideTiltRad, pairSeparationM });
    const placed: [MotorForm, ProfileMotor['level'], string][] = arm.coaxial
      ? [[arm.upper, 'upper', `${label} upper motor`], [arm.lower, 'lower', `${label} lower motor`]]
      : [[arm.upper, 'single', `${label} motor`]];
    for (const [motor, level, motorLabel] of placed) {
      const motorId = read.whole(motor.id, `${motorLabel} number`);
      const output = read.whole(motor.output, arm.coaxial ? `${motorLabel} output` : `${label} output`);
      const other = armOfMotor.get(motorId);
      if (Number.isInteger(motorId) && other !== undefined) read.errors.push(`Motor ${motorId} is on arm ${other} and arm ${id}`);
      armOfMotor.set(motorId, id);
      motors.push({ id: motorId, armId: id, level, spin: motor.spin, output, components: { motor: motor.motor, propeller: motor.propeller, esc: motor.esc } });
    }
  }
  const massProperties = read.mass(form.mass, 'Aircraft');
  const payload = form.payloadEnabled ? read.mass(form.payload, 'Payload') : null;
  const groundClearanceM = form.groundClearanceM.trim() === '' ? null : read.positive(form.groundClearanceM, 'Ground clearance', 'm');
  let drag: StatedAirframeDrag | null = null;
  if (form.dragStated) {
    const d = form.drag;
    const dragAreasM2 = d.areas.map((text, i) => read.positive(text, `Drag area ${'xyz'[i] ?? ''}`, 'm²'));
    const centerOfPressureBodyM = d.cop.map((text, i) => read.number(text, `Center of pressure ${'xyz'[i] ?? ''}`));
    const maxAirspeedMps = read.positive(d.maxAirspeedMps, 'Drag airspeed range', 'm/s');
    if (d.source.trim() === '') read.errors.push('Say where the drag areas come from');
    drag = { dragAreasM2, centerOfPressureBodyM, maxAirspeedMps, source: d.source.trim() };
  }
  const gear = form.gearDescribed ? readGear(read, form.gear) : null;
  const body = form.bodyDescribed ? readBody(read, form.body) : null;
  if (gear && groundClearanceM !== null) read.errors.push('With a described landing gear the resting height follows from it: leave the ground clearance empty');
  if (read.errors.length > 0) return { ok: false, errors: read.errors };
  const candidate = {
    schemaVersion: form.sensorConfiguration ? 3 : form.calculation ? 2 : 1, units: 'SI', bodyFrame: 'FRD', arms,
    motors: motors.sort((a, b) => a.id - b.id), massProperties, payload, battery: { card: form.batteryCard }, groundClearanceM,
    sensorConfiguration: form.sensorConfiguration, ...(form.calculation ? { calculation: form.calculation } : {}),
  };
  try {
    const used = new Set(motors.map(motor => motor.components.propeller));
    // The lowest schema that holds the content: polars (TASK-144, schema 4), stated drag (TASK-096, schema 5), the propulsion
    // calibrations carried from the stored version (TASK-145, schema 6) and a described gear (TASK-194, schema 7).
    const profile = withProfileContent(validateAircraftProfile(candidate), {
      propellerPolars: form.propellerPolars.filter(entry => used.has(entry.card)), airframeDrag: drag,
      propulsionCalibrations: form.propulsionCalibrations, landingGear: gear, body,
    });
    return { ok: true, profile };
  } catch (cause) {
    return { ok: false, errors: [cause instanceof Error ? cause.message.replace(/^Invalid aircraft profile: /, '') : String(cause)] };
  }
}

/** The gear a form describes; its rules (the support polygon, the values among themselves) are the profile's to check. */
function readGear(read: Reader, form: GearForm): ProfileGear {
  const feetBodyM = form.feet.map((foot, i) => foot.map((text, axis) => read.number(text, `Support ${i + 1} ${'xyz'[axis] ?? ''}`)));
  if (form.positionSource.trim() === '') read.errors.push('Say where the landing gear positions come from');
  const label = (key: keyof GearValues) => GEAR_VALUES.find(item => item.key === key)?.label ?? key;
  const values = mapGearValues(key => {
    const text = form.values[key].value.trim(), source = form.values[key].source.trim();
    if (text === '') {
      if (source !== '') read.errors.push(`${label(key)} has a source but no value`);
      return null;
    }
    if (source === '') read.errors.push(`Say where the ${label(key).toLowerCase()} comes from`);
    return read.number(text, label(key));
  });
  const provenance = mapGearValues(key => (form.values[key].value.trim() === '' ? null : form.values[key].source.trim()));
  return { kind: form.kind, feetBodyM, positionSource: form.positionSource.trim(), values, provenance };
}

/** The body a form describes; its rules (the part count, the names) are the profile's to check. */
function readBody(read: Reader, form: BodyForm): ProfileBody {
  const vector = (texts: readonly string[], label: string) => texts.map((text, axis) => read.number(text, `${label} ${'xyz'[axis] ?? ''}`));
  const radiusM = read.positive(form.radiusM, 'Body radius', 'm'), halfHeightM = read.positive(form.halfHeightM, 'Body half-height', 'm');
  const centerDownM = read.number(form.centerDownM, 'Body centre below the reference point');
  const armRadiusM = form.armRadiusM.trim() === '' ? null : read.positive(form.armRadiusM, 'Arm thickness radius', 'm');
  if (form.source.trim() === '') read.errors.push('Say where the body dimensions come from');
  const parts = form.parts.map((part, i): BodyPart => {
    const label = `Body part ${i + 1}`, name = part.name.trim(), radius = read.positive(part.radiusM, `${label} radius`, 'm');
    return part.shape === 'cylinder'
      ? { name, shape: 'cylinder', centerBodyM: vector(part.center, `${label} centre`), radiusM: radius, halfHeightM: read.positive(part.halfHeightM, `${label} half-height`, 'm') }
      : { name, shape: 'capsule', startBodyM: vector(part.start, `${label} start`), endBodyM: vector(part.end, `${label} end`), radiusM: radius };
  });
  return { radiusM, halfHeightM, centerDownM, armRadiusM, parts, source: form.source.trim() };
}

export interface EvenLayoutText {
  readonly count: string;
  readonly lengthM: string;
  readonly firstAzimuthDeg: string;
  readonly coaxial: boolean;
  readonly pairSeparationM: string;
}
/** Wraps degrees into (-180, 180]. */
function wrapDegrees(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}
/**
 * Arms evenly spaced from the first azimuth, all with the given length, no
 * height or tilt, and motors numbered and wired in arm order with alternating
 * spins; a lower motor turns against its upper motor and follows all upper
 * motors in numbering.
 */
export function evenLayout(text: EvenLayoutText): { readonly ok: true; readonly arms: ArmForm[] } | { readonly ok: false; readonly errors: readonly string[] } {
  const read = new Reader();
  const count = Number(text.count.trim());
  if (!/^[0-9]+$/.test(text.count.trim()) || count < 1 || count > MAX_ARMS) read.errors.push(`The layout needs 1 to ${MAX_ARMS} arms`);
  read.positive(text.lengthM, 'Arm length', 'm');
  const first = read.number(text.firstAzimuthDeg, 'First arm azimuth');
  if (text.coaxial) read.positive(text.pairSeparationM, 'Pair separation', 'm');
  if (read.errors.length > 0) return { ok: false, errors: read.errors };
  const zero = editAngle('0');
  const arms = Array.from({ length: count }, (_, k): ArmForm => {
    const spin: SpinDirection = k % 2 === 0 ? 'ccw' : 'cw';
    return {
      lengthM: text.lengthM.trim(), azimuth: editAngle(String(wrapDegrees(first + (360 * k) / count))), heightM: '0',
      outwardTilt: zero, sideTilt: zero, coaxial: text.coaxial, pairSeparationM: text.coaxial ? text.pairSeparationM.trim() : '',
      upper: { ...emptyMotor(spin), id: String(k + 1), output: String(k + 1) },
      lower: text.coaxial ? { ...emptyMotor(spin === 'ccw' ? 'cw' : 'ccw'), id: String(count + k + 1), output: String(count + k + 1) }
        : emptyMotor(spin === 'ccw' ? 'cw' : 'ccw'),
    };
  });
  return { ok: true, arms };
}

/** The distinct propeller cards the form's motors use, in arm order. */
export function propellerCardsOf(form: ProfileForm): string[] {
  const cards = new Set<string>();
  for (const arm of form.arms) for (const motor of arm.coaxial ? [arm.upper, arm.lower] : [arm.upper]) if (motor.propeller) cards.add(motor.propeller);
  return [...cards];
}
/** The form with the polar of one propeller card chosen, or unchosen with null. */
export function choosePropellerPolar(form: ProfileForm, card: string, polar: string | null): ProfileForm {
  const others = form.propellerPolars.filter(entry => entry.card !== card);
  return { ...form, propellerPolars: polar === null ? others : [...others, { card, polar }] };
}

/** The form with its arms replaced by a layout; propulsion cards of the old first motor carry over to every new motor. */
export function applyEvenLayout(form: ProfileForm, arms: readonly ArmForm[]): ProfileForm {
  const first = form.arms[0]?.upper;
  const cards = first ? { motor: first.motor, propeller: first.propeller, esc: first.esc } : {};
  return { ...form, arms: arms.map(arm => ({ ...arm, upper: { ...arm.upper, ...cards }, lower: { ...arm.lower, ...cards } })) };
}
