import type { AircraftProfile } from './profile.ts';
import { sinCos } from './trig.ts';

// Standard landing gear (TASK-095): the basic support approximation of
// decision D-07 (docs/decisions/phase1-fidelity.md, F-07 and F-08, approved by
// the stakeholder on 2026-10-28). Phase 1 has no landing-gear editor (S18); a
// later one is TASK-194. A profile that states its ground clearance stands on
// one support point under each arm, at the arm's motor radius, with the
// reference point at that clearance above level ground when it rests on them.
// The spring and damper follow from the decided static deflection and damping
// ratio, the friction from the decided coefficients. A profile without a
// clearance stands on supports below its standard hull (TASK-095 increment
// 4), as F-07 places them at the hull's lowest point: the derivation passes
// the clearance that leaves that point one static deflection above the
// ground at rest, so a hard landing that doubles the load reaches it. The supports are
// synthetic, not any aircraft's measured legs, and the vehicle manifest
// declares them as their own synthetic dataset. Configuration-time code only.

/** Version of the rules; a change of any rule is a new version. */
export const STANDARD_GEAR_VERSION = 2;
/** Standard gravity, m/s², as the contact engine applies it. */
const GRAVITY_MPS2 = 9.80665;

/**
 * The decided values (F-08) and the shape of a support point, which the
 * decision leaves open. With N supports and vehicle mass m the support's
 * stiffness is k = m·g/(N·δ_s) and its damping c = 2·ζ·√(k·m/N). Each support
 * is a strut on a rubber foot in series: the foot is ten times stiffer than
 * the support, so the strut has 10/9 of k and the pair has k, and the foot's
 * unsprung mass is 1 % of the support's share of the vehicle. The strut
 * travels five static deflections. The friction coefficients hold in every
 * direction: the feet slide rather than roll.
 */
export const STANDARD_GEAR = Object.freeze({
  staticDeflectionM: 0.005,
  dampingRatio: 0.7,
  staticFriction: 0.6,
  kineticFriction: 0.5,
  footRadiusM: 0.01,
  rimRadiusM: 0.005,
  footStiffnessFactor: 10,
  unsprungFractionOfShare: 0.01,
  travelInStaticDeflections: 5,
});

/** One gear entry of vehicle manifest v2 (`landingGear`): the `ContactWheel` fields with the anchor from the reference point. */
export interface StandardGearLeg {
  readonly id: number;
  readonly anchorBodyM: readonly [number, number, number];
  readonly unsprungMassKg: number;
  readonly tireRadiusM: number;
  readonly rimRadiusM: number;
  readonly strutTravelM: number;
  readonly suspension: {
    readonly kind: 'linear'; readonly stiffnessNpm: number; readonly preloadN: number;
    readonly compressionDamping: number; readonly reboundDamping: number; readonly dampingLaw: 'linear';
  };
  readonly tireLoadCurve: readonly (readonly [number, number])[];
  readonly tireDampingNsPm: number;
  readonly rollingCoefficient: number;
  readonly lateralCoefficient: number;
  readonly brakingCoefficient: number;
  readonly kineticFrictionRatio: number;
}

/**
 * The standard gear of a validated profile, its vehicle mass (kg, payload
 * included) and the resting height of the reference point above the ground
 * (the profile's clearance, or the one the derivation works out from the
 * hull): one support per arm in ascending arm ID order.
 */
export function standardLandingGear(profile: AircraftProfile, massKg: number, clearanceM: number): StandardGearLeg[] {
  if (!(massKg > 0) || !Number.isFinite(massKg)) throw new Error('The standard gear needs a positive vehicle mass');
  if (!(clearanceM > 0) || !Number.isFinite(clearanceM)) throw new Error('The standard gear needs a positive ground clearance');
  const clearance = clearanceM;
  const g = STANDARD_GEAR, n = profile.arms.length, share = massKg / n;
  const k = (massKg * GRAVITY_MPS2) / (n * g.staticDeflectionM), footStiffness = g.footStiffnessFactor * k;
  const strutStiffness = (k * footStiffness) / (footStiffness - k), damping = 2 * g.dampingRatio * Math.sqrt(k * share);
  const unsprung = g.unsprungFractionOfShare * share, footTravel = g.footRadiusM - g.rimRadiusM;
  // The support's static deflection under its share: the strut carries the share less the foot, the foot all of it.
  const deflection = ((share - unsprung) * GRAVITY_MPS2) / strutStiffness + (share * GRAVITY_MPS2) / footStiffness;
  // Fully extended, the foot centre sits so that the support at rest puts the reference point at the clearance.
  const anchorDown = clearance + deflection - g.footRadiusM;
  return profile.arms.map((arm, index) => {
    const { sin, cos } = sinCos(arm.azimuthRad);
    return {
      id: index,
      anchorBodyM: [clean(arm.lengthM * cos), clean(arm.lengthM * sin), anchorDown],
      unsprungMassKg: unsprung, tireRadiusM: g.footRadiusM, rimRadiusM: g.rimRadiusM,
      strutTravelM: g.travelInStaticDeflections * g.staticDeflectionM,
      suspension: { kind: 'linear', stiffnessNpm: strutStiffness, preloadN: 0, compressionDamping: damping, reboundDamping: damping,
        dampingLaw: 'linear' },
      tireLoadCurve: [[0, 0], [footTravel, footStiffness * footTravel]],
      tireDampingNsPm: 2 * g.dampingRatio * Math.sqrt(footStiffness * unsprung),
      rollingCoefficient: g.staticFriction, lateralCoefficient: g.staticFriction, brakingCoefficient: g.staticFriction,
      kineticFrictionRatio: g.kineticFriction / g.staticFriction,
    };
  });
}

/** Turns -0 into 0, so values and their canonical JSON agree. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}

/** The manifest dataset text of the standard gear. */
export function standardGearDerivation(): string {
  const g = STANDARD_GEAR;
  return `Standard landing gear ${STANDARD_GEAR_VERSION} of @mirage/aircraft, synthetic and not measured: the basic support approximation ` +
    `of decision D-07 (F-07, F-08), one support under each arm at its motor radius and the reference point at the profile's ground ` +
    `clearance at rest, or without one where the standard hull's lowest point rests one static deflection above the ground, static deflection ${g.staticDeflectionM} m, damping ratio ${g.dampingRatio}, friction ${g.staticFriction} static and ` +
    `${g.kineticFriction} kinetic.`;
}
