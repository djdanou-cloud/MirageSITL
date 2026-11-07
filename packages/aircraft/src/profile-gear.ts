import type { AircraftProfile, GearValues, ProfileGear } from './profile.ts';
import { STANDARD_GEAR, type StandardGearLeg } from './standard-gear.ts';

// A landing gear the profile describes (TASK-194), in place of the standard supports of decision D-07 (TASK-095). The profile
// holds the bottom of each foot or wheel with the struts fully extended and one set of values for every support, each known with
// its source or not known. A value that is not known is never written into the profile: the derivation applies the standard
// gear's rule for it and names it as assumed. The rules are F-08's static deflection, damping ratio and friction (approved by the
// stakeholder on 2026-10-28) and TASK-095's engineering choices for the support point, the same as `standardLandingGear` applies;
// a wheel's rolling coefficient has no such rule, so a gear of wheels needs it. Configuration-time code only; body FRD metres.

/** Standard gravity, m/s², as the contact engine applies it. */
const GRAVITY_MPS2 = 9.80665;
/** Two feet closer than this coincide, m; the CG must lie this far inside the support polygon. */
const POLYGON_TOLERANCE_M = 1e-6;

/** Every gear value in schema order, with the words and unit the dataset text and the editor use. */
export const GEAR_VALUES: readonly { readonly key: keyof GearValues; readonly label: string; readonly unit: string }[] = Object.freeze([
  { key: 'strutTravelM', label: 'Strut travel', unit: 'm' },
  { key: 'strutStiffnessNpm', label: 'Strut stiffness', unit: 'N/m' },
  { key: 'strutDampingNspm', label: 'Strut damping', unit: 'N·s/m' },
  { key: 'footRadiusM', label: 'Foot radius', unit: 'm' },
  { key: 'rimRadiusM', label: 'Rim radius', unit: 'm' },
  { key: 'footStiffnessNpm', label: 'Foot stiffness', unit: 'N/m' },
  { key: 'unsprungMassKg', label: 'Unsprung mass per support', unit: 'kg' },
  { key: 'staticFriction', label: 'Static friction', unit: '' },
  { key: 'kineticFriction', label: 'Kinetic friction', unit: '' },
  { key: 'rollingCoefficient', label: 'Rolling coefficient', unit: '' },
]);

/** A record over every gear value key, without a type assertion: the editor's form and the checks build one value per key. */
export function mapGearValues<T>(make: (key: keyof GearValues) => T): { [K in keyof GearValues]: T } {
  return {
    strutTravelM: make('strutTravelM'), strutStiffnessNpm: make('strutStiffnessNpm'), strutDampingNspm: make('strutDampingNspm'),
    footRadiusM: make('footRadiusM'), rimRadiusM: make('rimRadiusM'), footStiffnessNpm: make('footStiffnessNpm'),
    unsprungMassKg: make('unsprungMassKg'), staticFriction: make('staticFriction'), kineticFriction: make('kineticFriction'),
    rollingCoefficient: make('rollingCoefficient'),
  };
}

/** The values the gear flies with: each stated one as stated, each other one from its standard rule. */
export interface EffectiveGear {
  readonly values: { readonly [K in keyof GearValues]: number };
  /** The values that come from a standard rule, in schema order; the rolling coefficient of legs and skids is not one. */
  readonly assumed: readonly (keyof GearValues)[];
  /** The aircraft's mass with its payload, kg, and the share of each support. */
  readonly massKg: number;
  readonly shareKg: number;
  /** The CG of the aircraft with its payload, body FRD m. */
  readonly cgBodyM: readonly [number, number, number];
}

/** The CG and mass of the aircraft with its payload. */
function combinedCg(profile: AircraftProfile): { massKg: number; cg: [number, number, number] } {
  const a = profile.massProperties, p = profile.payload, massKg = a.massKg + (p?.massKg ?? 0);
  const cg = [0, 1, 2].map(i => (a.massKg * a.cgOffsetBodyM[i]! + (p ? p.massKg * p.cgOffsetBodyM[i]! : 0)) / massKg);
  return { massKg, cg: [cg[0]!, cg[1]!, cg[2]!] };
}

/**
 * The values of a profile's gear with the standard rules applied, or every reason it cannot stand: the support polygon, the
 * values among themselves and the payload are checked here, the structure by the profile schema. With N supports and the
 * vehicle mass m, each support's share is m/N, and the rules are:
 *
 * - strut and foot in series with the pair stiffness k = m·g/(N·δ_s) (F-08, δ_s = 5 mm): the foot ten times stiffer than
 *   the pair, so the strut has 10/9·k; a stated strut stiffness alone gives the foot 9 times it, a stated foot stiffness
 *   alone gives the strut 1/(1/k - 1/k_foot);
 * - damping 2·ζ·√(k_pair·m/N) with ζ = 0.7 (F-08), on the strut;
 * - travel five static deflections of the pair under the support's share;
 * - foot radius 0.01 m and the rim half the foot radius; the unsprung foot 1 % of the share;
 * - friction 0.6 static and 0.5 kinetic (F-08), and one stated coefficient gives the other by that ratio, 5/6.
 */
export function gearProblems(profile: AircraftProfile, gear: ProfileGear): string[] {
  try {
    effectiveGear(profile, gear);
    return [];
  } catch (cause) {
    return [cause instanceof Error ? cause.message : String(cause)];
  }
}

export function effectiveGear(profile: AircraftProfile, gear: ProfileGear): EffectiveGear {
  const g = STANDARD_GEAR, v = gear.values, n = gear.feetBodyM.length;
  const { massKg, cg } = combinedCg(profile), shareKg = massKg / n;
  checkSupportPolygon(gear, cg);
  if (v.strutTravelM !== null && !(v.strutTravelM > 0)) throw new Error('The strut travel must be above 0 m');
  const pair = (massKg * GRAVITY_MPS2) / (n * g.staticDeflectionM), seriesFactor = g.footStiffnessFactor;
  let strut: number, foot: number;
  if (v.strutStiffnessNpm !== null) {
    strut = v.strutStiffnessNpm;
    foot = v.footStiffnessNpm ?? (seriesFactor - 1) * strut;
  } else if (v.footStiffnessNpm !== null) {
    foot = v.footStiffnessNpm;
    if (!(foot > pair)) throw new Error(`The foot stiffness must exceed ${pair.toPrecision(4)} N/m, the standard support stiffness, for the standard strut to be found`);
    strut = 1 / (1 / pair - 1 / foot);
  } else {
    foot = seriesFactor * pair;
    strut = (pair * foot) / (foot - pair);
  }
  const series = (strut * foot) / (strut + foot);
  const footRadius = v.footRadiusM ?? g.footRadiusM;
  const rim = v.rimRadiusM ?? footRadius * (g.rimRadiusM / g.footRadiusM);
  if (!(rim < footRadius)) throw new Error(`The rim radius ${rim} m must be below the foot radius ${footRadius} m`);
  const unsprung = v.unsprungMassKg ?? g.unsprungFractionOfShare * shareKg;
  if (!(unsprung < shareKg)) throw new Error(`The unsprung mass ${unsprung} kg must be below each support's share of the vehicle, ${shareKg.toPrecision(4)} kg`);
  const damping = v.strutDampingNspm ?? 2 * g.dampingRatio * Math.sqrt(series * shareKg);
  const travel = v.strutTravelM ?? g.travelInStaticDeflections * ((shareKg * GRAVITY_MPS2) / series);
  const ratio = g.kineticFriction / g.staticFriction;
  const staticFriction = v.staticFriction ?? (v.kineticFriction === null ? g.staticFriction : v.kineticFriction / ratio);
  const kineticFriction = v.kineticFriction ?? staticFriction * ratio;
  if (kineticFriction > staticFriction) throw new Error(`The kinetic friction ${kineticFriction} must not exceed the static friction ${staticFriction}`);
  if (gear.kind === 'wheels' && v.rollingCoefficient === null) throw new Error('Wheels need their rolling coefficient: it has no standard value');
  const values = {
    strutTravelM: travel, strutStiffnessNpm: strut, strutDampingNspm: damping, footRadiusM: footRadius, rimRadiusM: rim, footStiffnessNpm: foot,
    unsprungMassKg: unsprung, staticFriction, kineticFriction, rollingCoefficient: v.rollingCoefficient ?? staticFriction,
  };
  const assumed = GEAR_KEYS.filter(key => v[key] === null && (key !== 'rollingCoefficient' || gear.kind === 'wheels'));
  return { values, assumed, massKg, shareKg, cgBodyM: cg };
}
const GEAR_KEYS: readonly (keyof GearValues)[] = GEAR_VALUES.map(item => item.key);

/** The CG seen from above must lie inside the convex polygon of the feet, which needs three feet not on one line. */
function checkSupportPolygon(gear: ProfileGear, cg: readonly number[]): void {
  const points = gear.feetBodyM.map(foot => [foot[0]!, foot[1]!] as const);
  points.forEach((point, i) => points.slice(i + 1).forEach((other, j) => {
    if (Math.hypot(point[0] - other[0], point[1] - other[1]) <= POLYGON_TOLERANCE_M) throw new Error(`Supports ${i + 1} and ${i + j + 2} stand at one point`);
  }));
  const hull = convexHull(points);
  const x = cg[0]!, y = cg[1]!, where = `(${roundMm(x)}, ${roundMm(y)}) m`;
  if (hull.length < 3) throw new Error(`The supports stand on one line, so the CG at ${where} has no support polygon`);
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!, b = hull[(i + 1) % hull.length]!;
    // Counter-clockwise hull: the CG must lie left of each edge by the tolerance.
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const side = ((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) / length;
    if (side <= POLYGON_TOLERANCE_M) throw new Error(`The CG at ${where} lies outside the support polygon of the feet seen from above`);
  }
}
const roundMm = (metres: number): string => String(Number(metres.toFixed(4)));
/** Andrew's monotone chain, counter-clockwise without collinear points. */
function convexHull(points: readonly (readonly [number, number])[]): (readonly [number, number])[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const half = (list: (readonly [number, number])[]) => {
    const out: (readonly [number, number])[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
    }
    return out;
  };
  const lower = half(sorted), upper = half([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The manifest's `landingGear` of a described gear: one entry per support in profile order, IDs from 0. */
export function profileLandingGear(profile: AircraftProfile, gear: ProfileGear): StandardGearLeg[] {
  const { values: v, kind } = { values: effectiveGear(profile, gear).values, kind: gear.kind };
  const footTravel = v.footRadiusM - v.rimRadiusM, ratio = v.kineticFriction / v.staticFriction;
  const tireDamping = 2 * STANDARD_GEAR.dampingRatio * Math.sqrt(v.footStiffnessNpm * v.unsprungMassKg);
  return gear.feetBodyM.map((foot, id) => ({
    id, anchorBodyM: [clean(foot[0]!), clean(foot[1]!), clean(foot[2]! - v.footRadiusM)],
    unsprungMassKg: v.unsprungMassKg, tireRadiusM: v.footRadiusM, rimRadiusM: v.rimRadiusM, strutTravelM: v.strutTravelM,
    suspension: { kind: 'linear', stiffnessNpm: v.strutStiffnessNpm, preloadN: 0, compressionDamping: v.strutDampingNspm,
      reboundDamping: v.strutDampingNspm, dampingLaw: 'linear' },
    tireLoadCurve: [[0, 0], [footTravel, v.footStiffnessNpm * footTravel]], tireDampingNsPm: tireDamping,
    // Legs and skids slide alike in every direction; wheels roll along their heading on their rolling coefficient. No gear brakes.
    rollingCoefficient: kind === 'wheels' ? v.rollingCoefficient : v.staticFriction, lateralCoefficient: v.staticFriction,
    brakingCoefficient: v.staticFriction, kineticFrictionRatio: ratio,
  }));
}

/**
 * The height of the reference point above level ground at rest on a described gear: with the body level and each support
 * carrying an equal share, the mean foot depth less a support's static compression (the strut under the share less its foot,
 * the foot under the whole share). Uneven feet or an off-centre CG tilt the aircraft, which this approximation leaves out.
 */
export function gearRestingClearanceM(profile: AircraftProfile, gear: ProfileGear): number {
  const e = effectiveGear(profile, gear), v = e.values;
  const compression = ((e.shareKg - v.unsprungMassKg) * GRAVITY_MPS2) / v.strutStiffnessNpm + (e.shareKg * GRAVITY_MPS2) / v.footStiffnessNpm;
  const depth = gear.feetBodyM.reduce((sum, foot) => sum + foot[2]!, 0) / gear.feetBodyM.length;
  return depth - compression;
}

/** The manifest dataset text of a described gear: what the profile states with its sources, and what follows a standard rule. */
export function profileGearDerivation(profile: AircraftProfile, gear: ProfileGear, profileSha256: string): string {
  const e = effectiveGear(profile, gear), stated: string[] = [], assumed: string[] = [];
  for (const { key, label, unit } of GEAR_VALUES) {
    if (key === 'rollingCoefficient' && gear.kind !== 'wheels') continue;
    const value = `${label.toLowerCase()} ${Number(e.values[key].toPrecision(6))}${unit ? ` ${unit}` : ''}`;
    const source = gear.provenance[key];
    if (source !== null) stated.push(`${value} (${source})`);
    else assumed.push(value);
  }
  const text = `Landing gear of the aircraft profile with canonical SHA-256 ${profileSha256} (TASK-194): ${gear.feetBodyM.length} ` +
    `${gear.kind === 'skids' ? `skid ends on ${gear.feetBodyM.length / 2} skids` : gear.kind}, positions from ${gear.positionSource}. ` +
    `Stated: ${stated.length > 0 ? stated.join('; ') : 'none'}. ` +
    `Assumed from the standard gear's rules (decision F-08 and TASK-095, not measured): ${assumed.length > 0 ? assumed.join('; ') : 'none'}.`;
  // The profile schema bounds each source to 96 characters, which keeps the text inside the manifest's 2048; never cut a source.
  if (text.length > 2048) throw new Error('The landing gear sources are too long for the manifest dataset text');
  return text;
}

/** Turns -0 into 0, so values and their canonical JSON agree. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}
