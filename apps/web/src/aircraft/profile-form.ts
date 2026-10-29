import {
  validateAircraftProfile, type AircraftProfile, type CalculationSettings, type ProfileMotor, type SpinDirection,
} from '@mirage/aircraft/profile';
import type { MassProperties } from '@mirage/physics/vehicle-manifest';
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
export function emptyMass(): MassForm {
  return { massKg: '', cg: ['', '', ''], inertia: { xx: '', yy: '', zz: '', xy: '', xz: '', yz: '' } };
}
/** A new profile: no arms and no mass values yet, in schema 2 preliminary mode. */
export function emptyForm(): ProfileForm {
  return {
    arms: [], mass: emptyMass(), payloadEnabled: false, payload: emptyMass(), batteryCard: null, groundClearanceM: '',
    calculation: { mode: 'preliminary', measurementSets: [] },
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
    calculation: profile.schemaVersion === 2 ? profile.calculation : null,
  };
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
  if (read.errors.length > 0) return { ok: false, errors: read.errors };
  const candidate = {
    schemaVersion: form.calculation ? 2 : 1, units: 'SI', bodyFrame: 'FRD', arms,
    motors: motors.sort((a, b) => a.id - b.id), massProperties, payload, battery: { card: form.batteryCard }, groundClearanceM,
    sensorConfiguration: null, ...(form.calculation ? { calculation: form.calculation } : {}),
  };
  try {
    return { ok: true, profile: validateAircraftProfile(candidate) };
  } catch (cause) {
    return { ok: false, errors: [cause instanceof Error ? cause.message.replace(/^Invalid aircraft profile: /, '') : String(cause)] };
  }
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

/** The form with its arms replaced by a layout; propulsion cards of the old first motor carry over to every new motor. */
export function applyEvenLayout(form: ProfileForm, arms: readonly ArmForm[]): ProfileForm {
  const first = form.arms[0]?.upper;
  const cards = first ? { motor: first.motor, propeller: first.propeller, esc: first.esc } : {};
  return { ...form, arms: arms.map(arm => ({ ...arm, upper: { ...arm.upper, ...cards }, lower: { ...arm.lower, ...cards } })) };
}
