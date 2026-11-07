import { PROPELLER_DISC_HALF_THICKNESS_OF_RADIUS, type HullShape } from '@mirage/physics/vehicle-manifest';
import type { RotorLayout } from './layout.ts';
import { bodyOf, type AircraftProfile, type BodySpec } from './profile.ts';
import { sinCos } from './trig.ts';

// Standard hull (TASK-095 increment 4): the frame as contact shapes, worked
// out from the arms and propellers because aircraft profiles give no body or
// arm size (the user's decision of 2026-11-01; body size fields are TASK-196).
// A body cylinder stands about the body z axis through the reference point,
// and each arm is a capsule from that axis to its motor mount at the arm's
// height. The sizes scale with the aircraft: the body with the shortest arm,
// an arm's thickness with the largest propeller on it. They are synthetic,
// not any aircraft's measured frame, and the vehicle manifest declares them
// as their own synthetic dataset. A profile that describes its body (schema 7,
// TASK-196) has that body's shapes instead, in the same order: the body, the
// arms, then its parts, all from the profile. Configuration-time code only.
// Positions are body FRD metres from the reference point.

/** Version of the rules; a change of any rule is a new version. */
export const STANDARD_HULL_VERSION = 1;

/**
 * The proportions. A 10 in quadcopter on 0.225 m arms gets a body 0.11 m
 * across and 0.045 m tall and arms 13 mm thick; an octocopter with 44 in
 * propellers on 1.25 m arms a body 0.63 m across and 0.25 m tall and arms
 * 56 mm thick.
 */
export const STANDARD_HULL = Object.freeze({
  bodyRadiusOfShortestArm: 0.25,
  bodyHalfHeightOfBodyRadius: 0.4,
  armRadiusOfPropellerRadius: 0.05,
});

/**
 * The standard hull of a validated profile: the body (ID 0), then one capsule
 * per arm in ascending arm ID order (IDs from 1). `propellerRadiusM` gives
 * each motor's propeller radius.
 */
export function standardHull(profile: AircraftProfile, propellerRadiusM: (motorId: number) => number): HullShape[] {
  const h = STANDARD_HULL;
  const radius = h.bodyRadiusOfShortestArm * Math.min(...profile.arms.map(arm => arm.lengthM));
  const body: HullShape = {
    id: 0, kind: 'cylinder', centerBodyM: [0, 0, 0], axisBody: [0, 0, 1], radiusM: radius,
    halfHeightM: h.bodyHalfHeightOfBodyRadius * radius,
  };
  const arms = profile.arms.map((arm, index): HullShape => {
    const propeller = Math.max(...profile.motors.filter(motor => motor.armId === arm.id).map(motor => propellerRadiusM(motor.id)));
    if (!(propeller > 0) || !Number.isFinite(propeller)) throw new Error(`Arm ${arm.id} has no propeller radius`);
    const { sin, cos } = sinCos(arm.azimuthRad), z = clean(-arm.heightM);
    return {
      id: index + 1, kind: 'capsule', startBodyM: [0, 0, z], endBodyM: [clean(arm.lengthM * cos), clean(arm.lengthM * sin), z],
      radiusM: h.armRadiusOfPropellerRadius * propeller,
    };
  });
  return [body, ...arms];
}

/**
 * TASK-196: the hull of a profile that describes its body: the body cylinder (ID 0) about the body z axis with its bottom
 * at the stated depth, one capsule per arm in ascending arm ID order (IDs from 1) from the body axis to the motor mount at
 * the arm's height with the stated thickness, then each part a vertical cylinder (IDs after the arms) in the order given.
 */
export function bodyHull(profile: AircraftProfile, body: BodySpec): HullShape[] {
  const shapes: HullShape[] = [{
    id: 0, kind: 'cylinder', centerBodyM: [0, 0, clean(body.bottomDepthM - body.heightM / 2)], axisBody: [0, 0, 1],
    radiusM: body.diameterM / 2, halfHeightM: body.heightM / 2,
  }];
  profile.arms.forEach((arm, index) => {
    const { sin, cos } = sinCos(arm.azimuthRad), z = clean(-arm.heightM);
    shapes.push({ id: index + 1, kind: 'capsule', startBodyM: [0, 0, z], endBodyM: [clean(arm.lengthM * cos), clean(arm.lengthM * sin), z],
      radiusM: body.armDiameterM / 2 });
  });
  body.parts.forEach((part, index) => shapes.push({
    id: profile.arms.length + 1 + index, kind: 'cylinder', centerBodyM: [clean(part.xM), clean(part.yM), clean(part.bottomDepthM - part.heightM / 2)],
    axisBody: [0, 0, 1], radiusM: part.diameterM / 2, halfHeightM: part.heightM / 2,
  }));
  return shapes;
}

/** The hull a profile flies: the body it describes (TASK-196), or the standard hull, which needs each motor's propeller radius. */
export function profileHull(profile: AircraftProfile, propellerRadiusM: (motorId: number) => number): HullShape[] {
  const body = bodyOf(profile);
  return body ? bodyHull(profile, body) : standardHull(profile, propellerRadiusM);
}

/**
 * What each hull shape of a profile stands for, by hull ID: "The body", "Arm k" by arm ID, and for a described body
 * (TASK-196) each part as part of the body, "The body (camera)". Reports of contacts and clashes use these names.
 */
export function hullPartNames(profile: AircraftProfile): string[] {
  return ['The body', ...profile.arms.map(arm => `Arm ${arm.id}`), ...(bodyOf(profile)?.parts ?? []).map(part => `The body (${part.name})`)];
}

/**
 * The propeller disc of a rotor as physics builds it from the manifest (TASK-095): a cylinder at
 * the hub about the thrust axis with the rotor radius, its ID the motor ID. It is not part of the
 * manifest's hull.
 */
export function propellerDisc(rotor: RotorLayout, radiusM: number): HullShape {
  return {
    id: rotor.motorId, kind: 'cylinder', centerBodyM: [...rotor.hubPositionBodyM], axisBody: [...rotor.thrustAxisBody], radiusM,
    halfHeightM: PROPELLER_DISC_HALF_THICKNESS_OF_RADIUS * radiusM,
  };
}

/** The depth (body FRD z, down) of the lowest point of hull shapes or propeller discs below the reference point with the body level. */
export function hullLowestDepthM(hull: readonly HullShape[]): number {
  return Math.max(...hull.map(shape => {
    if (shape.kind === 'capsule') return Math.max(shape.startBodyM[2]!, shape.endBodyM[2]!) + shape.radiusM;
    // A cylinder's lowest rim point: half its height along the axis, its radius across it.
    const [x, y, z] = shape.axisBody;
    return shape.centerBodyM[2]! + shape.halfHeightM * Math.abs(z!) + shape.radiusM * Math.hypot(x!, y!);
  }));
}

/** Turns -0 into 0, so values and their canonical JSON agree. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}

/** The manifest dataset text of the standard hull. */
export function standardHullDerivation(): string {
  const h = STANDARD_HULL;
  return `Standard hull ${STANDARD_HULL_VERSION} of @mirage/aircraft, synthetic and not measured: a body cylinder about the body z axis ` +
    `through the reference point, radius ${h.bodyRadiusOfShortestArm} times the shortest arm and half-height ` +
    `${h.bodyHalfHeightOfBodyRadius} times that radius, and one capsule per arm from the body axis to its motor mount at the arm's ` +
    `height, radius ${h.armRadiusOfPropellerRadius} times the largest propeller radius on the arm.`;
}
