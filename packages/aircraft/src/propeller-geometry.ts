import { validateComponentCard } from './components.ts';
import { atan } from './trig.ts';

// BET propeller geometry derived from a propeller card (TASK-139). The result
// feeds the rotor fields of the vehicle manifest (TASK-138); every assumption
// is listed, and every value that was assumed rather than given is flagged.
// Configuration-time code only. It uses the engine-independent `atan` of
// trig.ts, so the same card gives the same bits on every engine.

/** Default number of midpoint strips; a numerical choice, not a property of the propeller. */
export const DEFAULT_STRIPS = 16;
/** The BET runtime holds at most 64 stations per rotor. */
export const MAX_STRIPS = 64;
/**
 * Chord over tip radius when the card has no chord: the median measured chord
 * ratio between r/R 0.3 and 0.9 of the 14 UIUC propellers in
 * tests/fixtures/rotors/uiuc-propellers.json (182 samples).
 */
export const ASSUMED_CHORD_RATIO = 0.1812;
/** Root cutout over tip radius when the card has no hub diameter: every UIUC geometry there begins at r/R 0.15. */
export const ASSUMED_ROOT_RATIO = 0.15;

export interface PropellerGeometry {
  readonly bladeCount: number;
  readonly radiusM: number;
  readonly rootCutoutM: number;
  /** Strip midpoints, increasing. */
  readonly radialStationM: readonly number[];
  readonly chordM: readonly number[];
  /** Blade angle to the rotor plane: the BET twist added to a collective pitch of zero. */
  readonly twistRad: readonly number[];
  /** Strip widths; they sum to radius minus root cutout. */
  readonly quadratureWidthM: readonly number[];
  readonly airfoil: string | null;
  /** Moment of inertia of the propeller about its shaft, or null without a mass. */
  readonly bladeInertiaKgM2: number | null;
}
export type AssumptionId = 'rigid-identical-blades' | 'midpoint-strips' | 'root-cutout' | 'chord' | 'twist' | 'inertia';
export type GeometryFlagId = 'root-cutout-assumed' | 'chord-assumed' | 'chord-extended' | 'twist-from-pitch' | 'twist-extended'
  | 'airfoil-unspecified' | 'inertia-unknown';
export interface GeometryNote<Id extends string> { readonly id: Id; readonly description: string }
export interface PropellerGeometryResult {
  readonly geometry: PropellerGeometry;
  /** Every modeling assumption the derivation made, in a fixed order. */
  readonly assumptions: readonly GeometryNote<AssumptionId>[];
  /** Validity flags: values assumed instead of given, or held at the end of a distribution. */
  readonly flags: readonly GeometryNote<GeometryFlagId>[];
}

/** Linear interpolation in x; outside the data the end value is held. */
function interpolate(xs: readonly number[], ys: readonly number[], x: number): { value: number; held: boolean } {
  const last = xs.length - 1;
  if (x <= xs[0]!) return { value: ys[0]!, held: x < xs[0]! };
  if (x >= xs[last]!) return { value: ys[last]!, held: x > xs[last]! };
  let i = 0;
  while (x > xs[i + 1]!) i++;
  const t = (x - xs[i]!) / (xs[i + 1]! - xs[i]!);
  return { value: ys[i]! + t * (ys[i + 1]! - ys[i]!), held: false };
}

/** The BET blade geometry of a propeller card, with its assumptions and validity flags. */
export function derivePropellerGeometry(input: unknown, options: { readonly strips?: number } = {}): PropellerGeometryResult {
  const card = validateComponentCard(input);
  if (card.type !== 'propeller') throw new Error(`A ${card.type} card is not a propeller card`);
  const strips = options.strips ?? DEFAULT_STRIPS;
  if (!Number.isInteger(strips) || strips < 1 || strips > MAX_STRIPS) throw new Error(`strips must be an integer from 1 to ${MAX_STRIPS}`);
  const values = card.values;
  const radiusM = values.diameterM / 2;
  const rootCutoutM = values.hubDiameterM !== null ? values.hubDiameterM / 2 : ASSUMED_ROOT_RATIO * radiusM;
  const width = (radiusM - rootCutoutM) / strips;
  const radialStationM: number[] = [], chordM: number[] = [], twistRad: number[] = [], quadratureWidthM: number[] = [];
  let chordHeld = false, twistHeld = false;
  for (let i = 0; i < strips; i++) {
    const r = rootCutoutM + (i + 0.5) * width, ratio = r / radiusM;
    radialStationM.push(r);
    quadratureWidthM.push(width);
    if (values.chord) {
      const chord = interpolate(values.chord.radiusRatio, values.chord.chordRatio, ratio);
      chordM.push(chord.value * radiusM);
      chordHeld ||= chord.held;
    } else {
      chordM.push(ASSUMED_CHORD_RATIO * radiusM);
    }
    if (values.twist) {
      const twist = interpolate(values.twist.radiusRatio, values.twist.angleRad, ratio);
      twistRad.push(twist.value);
      twistHeld ||= twist.held;
    } else {
      twistRad.push(atan(values.pitchM / (2 * Math.PI * r)));
    }
  }
  const bladeInertiaKgM2 = values.massKg !== null ? (values.massKg * radiusM * radiusM) / 3 : null;

  const assumptions: GeometryNote<AssumptionId>[] = [
    { id: 'rigid-identical-blades', description: 'The blades are rigid, identical and evenly spaced; they do not cone, flap or bend.' },
    { id: 'midpoint-strips', description: `${strips} strips of equal width cover the blade from the root cutout to the tip; each station is the midpoint of its strip, and the strip widths are the quadrature weights.` },
    values.hubDiameterM !== null
      ? { id: 'root-cutout', description: 'The blade begins at the hub radius, half the hub diameter.' }
      : { id: 'root-cutout', description: `The card has no hub diameter, so the blade begins at r/R = ${ASSUMED_ROOT_RATIO}, where every measured UIUC geometry in tests/fixtures/rotors/uiuc-propellers.json begins.` },
    values.chord
      ? { id: 'chord', description: 'The chord is interpolated linearly in r/R from the card; a station outside the data takes the nearest end value.' }
      : { id: 'chord', description: `The card has no chord, so the chord is constant at c/R = ${ASSUMED_CHORD_RATIO}, the median measured chord ratio between r/R 0.3 and 0.9 of the 14 UIUC propellers in tests/fixtures/rotors/uiuc-propellers.json; real blades usually taper.` },
    values.twist
      ? { id: 'twist', description: 'The blade angle is interpolated linearly in r/R from the card; a station outside the data takes the nearest end value.' }
      : { id: 'twist', description: 'The card has no twist, so the blade angle is θ(r) = atan(P/(2πr)): the nominal pitch is taken as the geometric pitch of a helical blade at every radius, measured to the chord line. Manufacturers often state pitch at 0.75 R or to a flat lower surface.' },
  ];
  if (bladeInertiaKgM2 !== null) {
    assumptions.push({ id: 'inertia', description: 'Each blade is a thin uniform rod from the axis to the tip, so the moment of inertia about the shaft is m·R²/3; a heavier hub region makes the real value smaller.' });
  }
  const flags: GeometryNote<GeometryFlagId>[] = [];
  if (values.hubDiameterM === null) flags.push({ id: 'root-cutout-assumed', description: 'The root cutout is assumed, not given.' });
  if (!values.chord) flags.push({ id: 'chord-assumed', description: 'The chord is assumed, not given.' });
  if (chordHeld) flags.push({ id: 'chord-extended', description: 'Some stations lie outside the chord data and take its end value.' });
  if (!values.twist) flags.push({ id: 'twist-from-pitch', description: 'The blade angles come from the nominal pitch, not from a measured twist.' });
  if (twistHeld) flags.push({ id: 'twist-extended', description: 'Some stations lie outside the twist data and take its end value.' });
  if (values.airfoil === null) flags.push({ id: 'airfoil-unspecified', description: 'The card names no airfoil, so a polar must be chosen separately.' });
  if (bladeInertiaKgM2 === null) flags.push({ id: 'inertia-unknown', description: 'The card has no mass, so the propeller inertia is unknown.' });
  return Object.freeze({
    geometry: Object.freeze({
      bladeCount: values.bladeCount, radiusM, rootCutoutM, radialStationM, chordM, twistRad, quadratureWidthM,
      airfoil: values.airfoil, bladeInertiaKgM2,
    }),
    assumptions,
    flags,
  });
}
