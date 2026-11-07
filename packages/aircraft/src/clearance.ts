import type { HullShape } from '@mirage/physics/vehicle-manifest';
import { deriveLayout, type AircraftLayout } from './layout.ts';
import { landingGearOf, validateAircraftProfile, type AircraftProfile } from './profile.ts';
import { gearRestingClearanceM } from './profile-gear.ts';
import { restingClearanceM, STANDARD_GEAR } from './standard-gear.ts';
import { hullLowestDepthM, propellerDisc, standardHull } from './standard-hull.ts';

// Propeller clearance (TASK-195, S03, S18): whether the propellers of an
// aircraft profile clear each other, the body and the ground, and the
// smallest change of the profile that makes them. By the user's decision of
// 2026-11-01 a profile with a clash still saves, but no run starts from it,
// and the fix is only ever proposed: the Aircraft tab shows each changed value
// before and after and saves a new version on confirmation.
//
// The parts are the contact shapes the flight physics uses (TASK-095): each
// propeller a disc at its hub (`propellerDisc`), the body the standard hull's
// cylinder, at the geometry the manifest derivation gives the profile. Two
// parts clash when they overlap or touch. The two rotors of a coaxial pair
// share their arm's axis by design and are not checked against each other; a
// propeller is not checked against the arms, since a real propeller turns
// above its arm while the standard hull's arm capsules lie at hub height.
// With a ground clearance the profile states, a hull shape or propeller disc
// at or below the ground at rest clashes too; without one, the derivation
// places the supports below the lowest of them (standard gear rules 3).
//
// Distances between parts come from the GJK distance algorithm on the shapes'
// support functions (Gilbert, Johnson and Keerthi 1988; the closest-point
// regions of Ericson, Real-Time Collision Detection, 2005, section 5.1). It
// converges from above, so a pair is never found clear when it is not by more
// than the touch tolerance. Configuration-time code only.

export const CLEARANCE_RULES = Object.freeze({
  /** Parts closer than this touch, m. */
  touchToleranceM: 1e-6,
  /**
   * The gap that the fix leaves between a propeller tip and another propeller or the body, as a
   * fraction of the larger propeller diameter: the closest tip gaps of large production
   * multirotors are about 5 % of the propeller diameter.
   */
  fixTipGapOfDiameter: 0.05,
  /** The fix rounds arm lengths and the ground clearance up to whole millimetres. */
  fixStepsPerM: 1000,
});

export type ClearancePart =
  | { readonly kind: 'propeller'; readonly motorId: number }
  | { readonly kind: 'body' }
  | { readonly kind: 'arm'; readonly armId: number };
export type ClearanceClash =
  /** Two propeller discs overlap; `overlapM` is how far their tips overlap seen from above. */
  | { readonly kind: 'propellers'; readonly motorIds: readonly [number, number]; readonly overlapM: number }
  /** A propeller disc reaches the body; `overlapM` is how far its tip reaches into the body seen from above. */
  | { readonly kind: 'propeller-body'; readonly motorId: number; readonly overlapM: number }
  /** A part reaches the ground at rest; `depthM` is how far its lowest point lies below it. */
  | { readonly kind: 'ground'; readonly part: ClearancePart; readonly depthM: number };
export interface ClearanceReport {
  /** Height of the reference point above the ground at rest: the profile's clearance, the derived one, or on a described gear its resting height. */
  readonly groundClearanceM: number;
  readonly clearanceStated: boolean;
  /** Propeller pairs in ascending motor order, then propellers and the body, then parts on the ground. */
  readonly clashes: readonly ClearanceClash[];
}
/** The parts of a profile as the checks see them, body FRD metres from the reference point. */
export interface ClearanceShapes {
  readonly layout: AircraftLayout;
  /** The standard hull: the body (ID 0), then one capsule per arm in ascending arm ID order. */
  readonly hull: readonly HullShape[];
  /** One propeller disc per rotor in ascending motor ID order, the disc ID the motor ID. */
  readonly discs: readonly HullShape[];
}
export interface ClearanceChange {
  readonly label: string;
  readonly beforeM: number;
  readonly afterM: number;
}
export interface ClearanceFix {
  /** The fixed profile, validated; only arm lengths and the ground clearance differ. */
  readonly profile: AircraftProfile;
  /** Every changed value, arms in ascending ID order, then the ground clearance. */
  readonly changes: readonly ClearanceChange[];
  /** The common factor of the arm lengths before rounding; 1 when no arm changes. */
  readonly armScale: number;
  /** The fixed profile's clearance. Clashes that no arm length or clearance clears remain in it. */
  readonly after: ClearanceReport;
}

type Vector = readonly [number, number, number];
type Support = (direction: Vector) => Vector;

const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vector, b: Vector): Vector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vector, s: number): Vector => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vector): number => Math.sqrt(dot(a, a));
function vector(values: readonly number[]): Vector {
  const [x, y, z, ...rest] = values;
  if (x === undefined || y === undefined || z === undefined || rest.length > 0) throw new Error('A shape position is not a 3-vector');
  return [x, y, z];
}

/** A point inside the shape. */
function centreOf(shape: HullShape): Vector {
  return shape.kind === 'cylinder' ? vector(shape.centerBodyM) : scale(add(vector(shape.startBodyM), vector(shape.endBodyM)), 0.5);
}
/** The shape's farthest point in a direction. */
function supportOf(shape: HullShape): Support {
  if (shape.kind === 'capsule') {
    const start = vector(shape.startBodyM), end = vector(shape.endBodyM), radius = shape.radiusM;
    return direction => {
      const base = dot(direction, start) >= dot(direction, end) ? start : end, norm = length(direction);
      return norm > 0 ? add(base, scale(direction, radius / norm)) : base;
    };
  }
  const centre = vector(shape.centerBodyM), raw = vector(shape.axisBody), axis = scale(raw, 1 / length(raw));
  const radius = shape.radiusM, half = shape.halfHeightM;
  return direction => {
    const along = dot(direction, axis), radial = sub(direction, scale(axis, along)), norm = length(radial);
    const face = add(centre, scale(axis, along >= 0 ? half : -half));
    // Along the axis every point of the face is farthest; its centre is one.
    return norm > 0 ? add(face, scale(radial, radius / norm)) : face;
  };
}

interface Closest {
  readonly point: Vector;
  /** The smallest subset of the simplex whose hull holds the point. */
  readonly simplex: readonly Vector[];
}
function segmentClosest(a: Vector, b: Vector): Closest {
  const ab = sub(b, a), squared = dot(ab, ab), t = squared > 0 ? -dot(a, ab) / squared : 0;
  if (t <= 0) return { point: a, simplex: [a] };
  if (t >= 1) return { point: b, simplex: [b] };
  return { point: add(a, scale(ab, t)), simplex: [a, b] };
}
/** The point of a triangle closest to the origin by its Voronoi regions (Ericson, section 5.1.5). */
function triangleClosest(a: Vector, b: Vector, c: Vector): Closest {
  const ab = sub(b, a), ac = sub(c, a);
  const d1 = -dot(ab, a), d2 = -dot(ac, a);
  if (d1 <= 0 && d2 <= 0) return { point: a, simplex: [a] };
  const d3 = -dot(ab, b), d4 = -dot(ac, b);
  if (d3 >= 0 && d4 <= d3) return { point: b, simplex: [b] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return { point: add(a, scale(ab, d1 / (d1 - d3))), simplex: [a, b] };
  const d5 = -dot(ab, c), d6 = -dot(ac, c);
  if (d6 >= 0 && d5 <= d6) return { point: c, simplex: [c] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return { point: add(a, scale(ac, d2 / (d2 - d6))), simplex: [a, c] };
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    return { point: add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6)))), simplex: [b, c] };
  }
  const denominator = va + vb + vc;
  if (!(denominator > 0)) {
    // A degenerate (collinear) triangle: its closest point lies on one of its edges.
    return [segmentClosest(a, b), segmentClosest(b, c), segmentClosest(a, c)]
      .reduce((best, next) => (dot(next.point, next.point) < dot(best.point, best.point) ? next : best));
  }
  return { point: add(a, add(scale(ab, vb / denominator), scale(ac, vc / denominator))), simplex: [a, b, c] };
}
/** The point of a tetrahedron closest to the origin, or the whole tetrahedron when it holds the origin (Ericson, section 5.1.6). */
function tetrahedronClosest(a: Vector, b: Vector, c: Vector, d: Vector): Closest {
  const volume = dot(sub(d, a), cross(sub(b, a), sub(c, a)));
  const size = length(sub(b, a)) * length(sub(c, a)) * length(sub(d, a));
  const degenerate = !(Math.abs(volume) > 1e-12 * size);
  let best: Closest | null = null;
  for (const [p, q, r, opposite] of [[a, b, c, d], [a, c, d, b], [a, d, b, c], [b, d, c, a]] as const) {
    const normal = cross(sub(q, p), sub(r, p));
    // The origin lies outside the face when the face's plane separates it from the opposite vertex.
    if (!degenerate && dot(scale(p, -1), normal) * dot(sub(opposite, p), normal) >= 0) continue;
    const candidate = triangleClosest(p, q, r);
    if (!best || dot(candidate.point, candidate.point) < dot(best.point, best.point)) best = candidate;
  }
  return best ?? { point: [0, 0, 0], simplex: [a, b, c, d] };
}
function simplexClosest(points: readonly Vector[]): Closest {
  const [a, b, c, d] = points;
  if (a === undefined) throw new Error('An empty simplex has no closest point');
  if (b === undefined) return { point: a, simplex: [a] };
  if (c === undefined) return segmentClosest(a, b);
  if (d === undefined) return triangleClosest(a, b, c);
  return tetrahedronClosest(a, b, c, d);
}

const GJK_ITERATIONS = 256;
/** Relative and absolute convergence bounds of the distance, m. */
const GJK_RELATIVE = 1e-12, GJK_ABSOLUTE_M = 1e-10;

/** The distance between two convex shapes, 0 when they overlap or touch, m. */
export function shapeDistanceM(first: HullShape, second: HullShape): number {
  const a = supportOf(first), b = supportOf(second);
  const support = (direction: Vector): Vector => sub(a(direction), b(scale(direction, -1)));
  // A point of the Minkowski difference: the difference of two points inside the shapes.
  let v = sub(centreOf(first), centreOf(second)), simplex: readonly Vector[] = [];
  for (let i = 0; i < GJK_ITERATIONS; i++) {
    const squared = dot(v, v);
    if (squared <= GJK_ABSOLUTE_M * GJK_ABSOLUTE_M) return 0;
    const w = support(scale(v, -1));
    // |v| bounds the distance from above and v·w/|v| from below.
    if (squared - dot(v, w) <= Math.max(GJK_RELATIVE * squared, GJK_ABSOLUTE_M * Math.sqrt(squared))) return Math.sqrt(squared);
    const closest = simplexClosest([...simplex, w]);
    if (closest.simplex.length === 4) return 0;
    simplex = closest.simplex;
    v = closest.point;
  }
  return length(v);
}

/** The checked parts of a validated profile; `propellerRadiusM` gives each motor's propeller radius. */
export function clearanceShapes(profile: AircraftProfile, propellerRadiusM: (motorId: number) => number): ClearanceShapes {
  const layout = deriveLayout(profile);
  for (const rotor of layout.rotors) {
    const radius = propellerRadiusM(rotor.motorId);
    if (!(radius > 0) || !Number.isFinite(radius)) throw new Error(`Motor ${rotor.motorId} has no propeller radius`);
  }
  return {
    layout, hull: standardHull(profile, propellerRadiusM),
    discs: layout.rotors.map(rotor => propellerDisc(rotor, propellerRadiusM(rotor.motorId))),
  };
}

/** Distance between the hubs of two discs, or a disc and the body axis, seen from above. */
function planDistanceM(first: HullShape, second: HullShape): number {
  const a = centreOf(first), b = centreOf(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
const touches = (first: HullShape, second: HullShape): boolean => shapeDistanceM(first, second) <= CLEARANCE_RULES.touchToleranceM;

/**
 * Every clash of a profile's propellers with each other, the body and, with a stated ground
 * clearance, the ground. `propellerRadiusM` gives each motor's propeller radius: the radius of the
 * card's propeller, which is the derived manifest's rotor radius.
 */
export function propellerClearance(input: unknown, propellerRadiusM: (motorId: number) => number): ClearanceReport {
  const profile = validateAircraftProfile(input);
  const { layout, hull, discs } = clearanceShapes(profile, propellerRadiusM);
  const clashes: ClearanceClash[] = [];
  const body = hull[0];
  if (body === undefined) throw new Error('The standard hull has no body');
  layout.rotors.forEach((rotor, i) => {
    const disc = discs[i];
    if (disc === undefined) return;
    for (let j = i + 1; j < layout.rotors.length; j++) {
      const other = layout.rotors[j], otherDisc = discs[j];
      if (other === undefined || otherDisc === undefined || other.armId === rotor.armId || !touches(disc, otherDisc)) continue;
      const overlapM = Math.max(0, disc.radiusM + otherDisc.radiusM - planDistanceM(disc, otherDisc));
      clashes.push({ kind: 'propellers', motorIds: [rotor.motorId, other.motorId], overlapM });
    }
  });
  layout.rotors.forEach((rotor, i) => {
    const disc = discs[i];
    if (disc === undefined || !touches(disc, body)) return;
    clashes.push({ kind: 'propeller-body', motorId: rotor.motorId, overlapM: Math.max(0, disc.radiusM + body.radiusM - planDistanceM(disc, body)) });
  });
  // TASK-194: on a described gear the aircraft rests where its supports put it, so a part below that height is on the ground.
  const gear = landingGearOf(profile);
  const groundClearanceM = gear ? gearRestingClearanceM(profile, gear) : restingClearanceM(profile, hullLowestDepthM([...hull, ...discs]));
  const parts: [ClearancePart, HullShape][] = [
    ...hull.map((shape, i): [ClearancePart, HullShape] => {
      const arm = profile.arms[i - 1];
      return [i === 0 || arm === undefined ? { kind: 'body' } : { kind: 'arm', armId: arm.id }, shape];
    }),
    ...discs.map((disc): [ClearancePart, HullShape] => [{ kind: 'propeller', motorId: disc.id }, disc]),
  ];
  for (const [part, shape] of parts) {
    const depthM = hullLowestDepthM([shape]) - groundClearanceM;
    if (depthM >= -CLEARANCE_RULES.touchToleranceM) clashes.push({ kind: 'ground', part, depthM: Math.max(0, depthM) });
  }
  return { groundClearanceM, clearanceStated: profile.groundClearanceM !== null, clashes };
}

const millimetres = (metres: number): string => `${(metres * 1000).toFixed(1)} mm`;
/** Below this a clash reads as touching: its size shows as 0.0 mm. */
const shown = (metres: number): boolean => metres >= 0.00005;
function partName(part: ClearancePart): string {
  switch (part.kind) {
    case 'propeller': return `The propeller of motor ${part.motorId}`;
    case 'body': return 'The body';
    case 'arm': return `Arm ${part.armId}`;
    default: return assertNever(part);
  }
}
function assertNever(value: never): never {
  throw new Error(`Unknown clearance value ${JSON.stringify(value)}`);
}
/** One line for a clash, in millimetres. */
export function describeClash(clash: ClearanceClash): string {
  switch (clash.kind) {
    case 'propellers': {
      const pair = `The propellers of motors ${clash.motorIds[0]} and ${clash.motorIds[1]}`;
      return shown(clash.overlapM) ? `${pair} overlap by ${millimetres(clash.overlapM)}` : `${pair} touch`;
    }
    case 'propeller-body': {
      const propeller = `The propeller of motor ${clash.motorId}`;
      return shown(clash.overlapM) ? `${propeller} reaches ${millimetres(clash.overlapM)} into the body` : `${propeller} touches the body`;
    }
    case 'ground':
      return shown(clash.depthM) ? `${partName(clash.part)} reaches ${millimetres(clash.depthM)} below the ground at rest`
        : `${partName(clash.part)} touches the ground at rest`;
    default: return assertNever(clash);
  }
}

/** A pair whose gap the fix sets: two propellers on different arms, or a propeller and the body. */
interface FixPair {
  readonly first: number;
  /** A disc index, or -1 for the body. */
  readonly second: number;
  readonly gapM: number;
}
function withArmLengths(profile: AircraftProfile, lengths: readonly number[]): AircraftProfile {
  return validateAircraftProfile({ ...profile, arms: profile.arms.map((arm, i) => ({ ...arm, lengthM: lengths[i] ?? arm.lengthM })) });
}
const roundUp = (metres: number): number => Math.ceil(metres * CLEARANCE_RULES.fixStepsPerM - 1e-9) / CLEARANCE_RULES.fixStepsPerM;

/**
 * The smallest change of a profile that clears its clashes, or null when it has none. Every arm
 * grows by one common factor, so the aircraft keeps its shape, until each propeller is at least
 * `fixTipGapOfDiameter` of the larger diameter from every propeller on another arm and from the
 * body; then a stated ground clearance that leaves a part on the ground rises to the lowest part
 * plus the static deflection, the derivation's rule for a profile without one. Both round up to
 * whole millimetres. Propellers whose hubs coincide seen from above stay as they are, since no arm
 * length moves them apart; they remain in `after`. Mass properties do not change.
 */
export function clearanceFix(input: unknown, propellerRadiusM: (motorId: number) => number): ClearanceFix | null {
  const profile = validateAircraftProfile(input);
  const before = propellerClearance(profile, propellerRadiusM);
  if (before.clashes.length === 0) return null;
  const { layout } = clearanceShapes(profile, propellerRadiusM);
  const pairs: FixPair[] = [];
  const gap = (...radii: number[]): number => CLEARANCE_RULES.fixTipGapOfDiameter * 2 * Math.max(...radii);
  layout.rotors.forEach((rotor, i) => {
    const radius = propellerRadiusM(rotor.motorId);
    pairs.push({ first: i, second: -1, gapM: gap(radius) });
    layout.rotors.forEach((other, j) => {
      if (j <= i || other.armId === rotor.armId) return;
      const a = vector(rotor.hubPositionBodyM), b = vector(other.hubPositionBodyM), apart = Math.hypot(a[0] - b[0], a[1] - b[1]);
      // Scaling the arms moves hubs apart only when they differ seen from above.
      if (apart > CLEARANCE_RULES.touchToleranceM) pairs.push({ first: i, second: j, gapM: gap(radius, propellerRadiusM(other.motorId)) });
    });
  });
  const clears = (candidate: AircraftProfile): boolean => {
    const { hull, discs } = clearanceShapes(candidate, propellerRadiusM);
    const body = hull[0];
    return body !== undefined && pairs.every(pair => {
      const disc = discs[pair.first], other = pair.second < 0 ? body : discs[pair.second];
      return disc !== undefined && other !== undefined && shapeDistanceM(disc, other) >= pair.gapM;
    });
  };
  const lengths = profile.arms.map(arm => arm.lengthM);
  const scaled = (factor: number): AircraftProfile => withArmLengths(profile, lengths.map(value => value * factor));
  let armScale = 1, fixed = profile;
  const propellerClash = before.clashes.some(clash => clash.kind !== 'ground');
  if (propellerClash && !clears(profile)) {
    let low = 1, high = 2;
    while (!clears(scaled(high))) {
      low = high;
      high *= 2;
      if (high > 2 ** 20) throw new Error('No arm length clears the propellers');
    }
    for (let i = 0; i < 60 && high - low > 1e-12 * high; i++) {
      const middle = (low + high) / 2;
      if (clears(scaled(middle))) high = middle;
      else low = middle;
    }
    armScale = high;
    // Rounding each arm up keeps every arm at least as long as the scaled one; one more millimetre settles a rare miss.
    let rounded = withArmLengths(profile, lengths.map(value => roundUp(value * high)));
    for (let step = 1; !clears(rounded) && step <= 1000; step++) {
      rounded = withArmLengths(profile, lengths.map(value => roundUp(value * high) + step / CLEARANCE_RULES.fixStepsPerM));
    }
    fixed = rounded;
  }
  if (fixed.groundClearanceM !== null) {
    const { hull, discs } = clearanceShapes(fixed, propellerRadiusM);
    const lowest = hullLowestDepthM([...hull, ...discs]);
    if (lowest >= fixed.groundClearanceM - CLEARANCE_RULES.touchToleranceM) {
      fixed = validateAircraftProfile({ ...fixed, groundClearanceM: roundUp(lowest + STANDARD_GEAR.staticDeflectionM) });
    }
  }
  const changes: ClearanceChange[] = profile.arms.flatMap((arm, i) => {
    const after = fixed.arms[i]?.lengthM ?? arm.lengthM;
    return after === arm.lengthM ? [] : [{ label: `Arm ${arm.id} length`, beforeM: arm.lengthM, afterM: after }];
  });
  if (fixed.groundClearanceM !== profile.groundClearanceM && fixed.groundClearanceM !== null && profile.groundClearanceM !== null) {
    changes.push({ label: 'Ground clearance', beforeM: profile.groundClearanceM, afterM: fixed.groundClearanceM });
  }
  return { profile: fixed, changes, armScale, after: propellerClearance(fixed, propellerRadiusM) };
}
