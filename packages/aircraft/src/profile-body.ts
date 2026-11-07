import type { HullShape } from '@mirage/physics/vehicle-manifest';
import type { AircraftProfile, ProfileBody } from './profile.ts';
import { STANDARD_HULL, standardHull } from './standard-hull.ts';
import { sinCos } from './trig.ts';

// A body the profile describes (TASK-196), in place of the standard hull of TASK-095: the central body as a cylinder about the
// body z axis, its centre as far below the reference point as the profile says, one capsule per arm with the stated thickness or
// the standard one, and named parts such as a camera pod or a cargo box (entered as the cylinder or capsule that encloses it). The
// contact takes them as hull shapes (contact configuration version 5): the body ID 0, the arms 1 to N in ascending arm ID order,
// the parts after them in profile order. Configuration-time code only; body FRD metres from the reference point.

/** The hull's capacity in the vehicle manifest v2 (`hull`, 1 to 16 shapes): the body, the arms and the parts. */
export const MAX_HULL_SHAPES = 16;

/** Every reason a described body cannot be flown; the schema has checked the structure and the signs. */
export function bodyProblems(profile: AircraftProfile, body: ProfileBody): string[] {
  const problems: string[] = [];
  const room = MAX_HULL_SHAPES - 1 - profile.arms.length;
  if (body.parts.length > room) problems.push(`The body holds at most ${room} parts beside its ${profile.arms.length} arms: the hull holds ${MAX_HULL_SHAPES} shapes`);
  if (body.source.trim() === '') problems.push('Say where the body dimensions come from');
  const names = new Set<string>();
  body.parts.forEach((part, index) => {
    const name = part.name.trim();
    if (name === '') problems.push(`Body part ${index + 1} needs a name`);
    else if (names.has(name.toLowerCase())) problems.push(`Two body parts are named ${name}`);
    names.add(name.toLowerCase());
    if (part.shape === 'capsule' && part.startBodyM.every((value, axis) => value === part.endBodyM[axis])) {
      problems.push(`The capsule ${name || `part ${index + 1}`} needs two different ends`);
    }
  });
  return problems;
}

/** The hull of a profile with a described body: the body, the arms, then the parts. `propellerRadiusM` gives each motor's propeller radius. */
export function profileHull(profile: AircraftProfile, body: ProfileBody, propellerRadiusM: (motorId: number) => number): HullShape[] {
  const central: HullShape = {
    id: 0, kind: 'cylinder', centerBodyM: [0, 0, clean(body.centerDownM)], axisBody: [0, 0, 1], radiusM: body.radiusM, halfHeightM: body.halfHeightM,
  };
  const arms = profile.arms.map((arm, index): HullShape => {
    const propeller = Math.max(...profile.motors.filter(motor => motor.armId === arm.id).map(motor => propellerRadiusM(motor.id)));
    const radiusM = body.armRadiusM ?? STANDARD_HULL.armRadiusOfPropellerRadius * propeller;
    if (!(radiusM > 0) || !Number.isFinite(radiusM)) throw new Error(`Arm ${arm.id} has no propeller radius`);
    const { sin, cos } = sinCos(arm.azimuthRad), z = clean(-arm.heightM);
    return { id: index + 1, kind: 'capsule', startBodyM: [0, 0, z], endBodyM: [clean(arm.lengthM * cos), clean(arm.lengthM * sin), z], radiusM };
  });
  const parts = body.parts.map((part, index): HullShape => {
    const id = profile.arms.length + 1 + index;
    return part.shape === 'cylinder'
      ? { id, kind: 'cylinder', centerBodyM: part.centerBodyM.map(clean), axisBody: [0, 0, 1], radiusM: part.radiusM, halfHeightM: part.halfHeightM }
      : { id, kind: 'capsule', startBodyM: part.startBodyM.map(clean), endBodyM: part.endBodyM.map(clean), radiusM: part.radiusM };
  });
  return [central, ...arms, ...parts];
}

/** The hull the aircraft flies and is checked with: the described body's, or the standard hull. */
export function airframeHull(profile: AircraftProfile, propellerRadiusM: (motorId: number) => number): HullShape[] {
  const body = profile.schemaVersion === 7 ? profile.body : undefined;
  return body ? profileHull(profile, body, propellerRadiusM) : standardHull(profile, propellerRadiusM);
}

/** The name of each hull shape in ID order, as accidents and checks name them: the body, each arm, then each part. */
export function hullPartNames(profile: AircraftProfile): string[] {
  const body = profile.schemaVersion === 7 ? profile.body : undefined;
  return ['the body', ...profile.arms.map(arm => `arm ${arm.id}`), ...(body?.parts ?? []).map(part => part.name.trim())];
}

/** The manifest dataset text of a described body. */
export function profileHullDerivation(profile: AircraftProfile, body: ProfileBody, profileSha256: string): string {
  const parts = body.parts.map(part => part.shape === 'cylinder'
    ? `${part.name.trim()}, a cylinder of radius ${part.radiusM} m and half-height ${part.halfHeightM} m centred at (${part.centerBodyM.join(', ')}) m`
    : `${part.name.trim()}, a capsule of radius ${part.radiusM} m from (${part.startBodyM.join(', ')}) to (${part.endBodyM.join(', ')}) m`);
  const text = `Body of the aircraft profile with canonical SHA-256 ${profileSha256} (TASK-196), dimensions from ${body.source.trim()}: a cylinder ` +
    `about the body z axis of radius ${body.radiusM} m and half-height ${body.halfHeightM} m, its centre ${body.centerDownM} m below the reference ` +
    `point; ${profile.arms.length} arm capsules ${body.armRadiusM === null
      ? `of the standard hull's thickness, ${STANDARD_HULL.armRadiusOfPropellerRadius} times the largest propeller radius on the arm (assumed, not measured)`
      : `of radius ${body.armRadiusM} m`}; parts: ${parts.length > 0 ? parts.join('; ') : 'none'}.`;
  if (text.length > 2048) throw new Error('The body description is too long for the manifest dataset text');
  return text;
}

/** Turns -0 into 0, so values and their canonical JSON agree. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}
