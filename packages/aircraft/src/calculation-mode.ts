import { measurementSetBench, combinationKey, type Combination, type MeasurementSet } from './measurements.ts';
import { missingValues, type ComponentCard, type ComponentType } from './components.ts';
import {
  calculationSettings, validateAircraftProfile, type AircraftProfile, type CalculationMode, type ProfileMotor,
} from './profile.ts';

// Calculation modes (TASK-140, S04) and the confidence labels of TASK-133
// (docs/decisions/phase1-fidelity.md, F-06). A profile version in measured
// mode binds measurement sets; a motor uses bench data only when a bound set
// has exactly its combination of motor, propeller, ESC and battery card
// versions, and never another combination's. Configuration-time code only.

/** TASK-133 labels, weakest first. TASK-184 earns `flight-checked`; this module never assigns it. */
export const CONFIDENCE_LABELS = ['preliminary', 'measured-input', 'flight-checked'] as const;
export type ConfidenceLabel = typeof CONFIDENCE_LABELS[number];
/** F-03: the envelope warning starts 10% beyond the measured rpm range of a bench fit. */
export const RPM_EXTRAPOLATION_MARGIN = 0.1;

export interface MotorCalculation {
  readonly motorId: number;
  /** Null while the motor, propeller or ESC card, or the battery card, is not selected. */
  readonly combination: Combination | null;
  readonly combinationKey: string | null;
  readonly label: ConfidenceLabel;
  /** The bound measurement-set version this motor uses, or null. */
  readonly measurementSet: string | null;
  /** What the calculation lacks, never filled in: unselected cards, unknown card values, unmeasured quantities. */
  readonly missing: readonly string[];
  /** Limits of use of the bound bench data. */
  readonly limits: readonly string[];
  readonly reason: string;
}
export interface ProfileCalculation {
  readonly mode: CalculationMode;
  /** The aircraft label: the weakest of its motors' labels (F-06). */
  readonly label: ConfidenceLabel;
  readonly motors: readonly MotorCalculation[];
  readonly limits: readonly string[];
}
/** A stored measurement-set version that a profile may bind. */
export interface MeasurementCandidate {
  readonly sha256: string;
  readonly createdAt: string;
  readonly set: MeasurementSet;
}

/** The weakest of the labels (F-06). */
export function weakestLabel(labels: readonly ConfidenceLabel[]): ConfidenceLabel {
  if (labels.length === 0) throw new Error('The weakest label needs at least one label');
  return CONFIDENCE_LABELS[Math.min(...labels.map(label => CONFIDENCE_LABELS.indexOf(label)))]!;
}

/** The combination a profile motor runs in: its cards and the profile's battery; null while any is not selected. */
export function motorCombination(profile: AircraftProfile, motor: ProfileMotor): Combination | null {
  const { motor: motorCard, propeller, esc } = motor.components, battery = profile.battery.card;
  if (motorCard === null || propeller === null || esc === null || battery === null) return null;
  return { motor: motorCard, propeller, esc, supply: { kind: 'battery', card: battery } };
}

async function motorKeys(profile: AircraftProfile): Promise<Map<number, string | null>> {
  const keys = new Map<number, string | null>();
  for (const motor of profile.motors) {
    const combination = motorCombination(profile, motor);
    keys.set(motor.id, combination ? await combinationKey(combination) : null);
  }
  return keys;
}

/**
 * Checks the measurement sets a profile binds: each is available, matches the
 * combination of at least one motor, and no two bind the same combination.
 * Returns the bound set of each combination key.
 */
export async function checkProfileMeasurements(profile: AircraftProfile, sets: ReadonlyMap<string, MeasurementSet>): Promise<Map<string, string>> {
  const keys = new Set((await motorKeys(profile)).values());
  const bound = new Map<string, string>();
  for (const sha256 of calculationSettings(profile).measurementSets) {
    const set = sets.get(sha256);
    if (!set) throw new Error(`Measurement set ${sha256} is not available`);
    const key = await combinationKey(set.combination);
    if (!keys.has(key)) throw new Error(`Measurement set ${sha256} matches no motor's combination`);
    const other = bound.get(key);
    if (other !== undefined) throw new Error(`Measurement sets ${other} and ${sha256} bind the same combination`);
    bound.set(key, sha256);
  }
  return bound;
}

/**
 * A schema 2 version of the profile in the given mode. Measured mode binds,
 * for each motor combination, the newest candidate set of exactly that
 * combination; candidates of other combinations are never bound.
 */
export async function bindMeasurements(profile: AircraftProfile, mode: CalculationMode,
  candidates: readonly MeasurementCandidate[]): Promise<AircraftProfile> {
  const chosen = new Map<string, MeasurementCandidate>();
  if (mode === 'measured') {
    const keys = new Set((await motorKeys(profile)).values());
    for (const candidate of candidates) {
      const key = await combinationKey(candidate.set.combination);
      if (!keys.has(key)) continue;
      const current = chosen.get(key);
      if (!current || candidate.createdAt > current.createdAt || (candidate.createdAt === current.createdAt && candidate.sha256 > current.sha256)) {
        chosen.set(key, candidate);
      }
    }
  }
  const measurementSets = [...chosen.values()].map(candidate => candidate.sha256).sort();
  // A schema 3 profile keeps its sensor configuration (TASK-143); schemas 1 and 2 become 2.
  return validateAircraftProfile({ ...profile, schemaVersion: profile.schemaVersion === 3 ? 3 : 2, calculation: { mode, measurementSets } });
}

function cardMissing(role: ComponentType, sha256: string | null, cards: ReadonlyMap<string, ComponentCard>): string[] {
  if (sha256 === null) return [`${role} card`];
  const card = cards.get(sha256);
  if (!card) return [`${role} card ${sha256.slice(0, 12)} (not available)`];
  return missingValues(card).map(field => `${role}: ${field}`);
}
function rpmText(value: number): string {
  return String(Math.round(value));
}
/** Motor IDs in a coaxial pair: both motors of an arm that holds an upper and a lower motor. */
function pairedMotors(profile: AircraftProfile): Set<number> {
  return new Set(profile.motors.filter(motor => motor.level !== 'single').map(motor => motor.id));
}

/** The labels, missing quantities and limits of use of each motor and of the aircraft. */
export async function evaluateCalculation(profile: AircraftProfile, cards: ReadonlyMap<string, ComponentCard>,
  sets: ReadonlyMap<string, MeasurementSet>): Promise<ProfileCalculation> {
  const { mode } = calculationSettings(profile);
  const bound = await checkProfileMeasurements(profile, sets);
  const keys = await motorKeys(profile), paired = pairedMotors(profile);
  const motors = profile.motors.map((motor): MotorCalculation => {
    const combination = motorCombination(profile, motor), key = keys.get(motor.id) ?? null;
    const missing = [
      ...cardMissing('motor', motor.components.motor, cards), ...cardMissing('propeller', motor.components.propeller, cards),
      ...cardMissing('esc', motor.components.esc, cards), ...cardMissing('battery', profile.battery.card, cards),
    ];
    const base = { motorId: motor.id, combination, combinationKey: key, missing };
    if (mode === 'preliminary') {
      return { ...base, label: 'preliminary', measurementSet: null, limits: [], reason: 'Preliminary calculation: specifications and geometry only.' };
    }
    if (key === null) {
      return { ...base, label: 'preliminary', measurementSet: null, limits: [],
        reason: 'The motor, propeller or ESC card, or the battery card, is not selected, so no measurements can bind.' };
    }
    const sha256 = bound.get(key);
    const set = sha256 === undefined ? undefined : sets.get(sha256);
    if (sha256 === undefined || !set) {
      return { ...base, label: 'preliminary', measurementSet: null, limits: [], reason: 'No measurement set of this combination is bound.' };
    }
    const bench = measurementSetBench(set), rpms = bench.points.map(point => point.rpm);
    const low = Math.min(...rpms), high = Math.max(...rpms);
    const limits = [
      `Bench data covers ${rpmText(low)} to ${rpmText(high)} rpm; outside ${rpmText(low * (1 - RPM_EXTRAPOLATION_MARGIN))} to ` +
        `${rpmText(high * (1 + RPM_EXTRAPOLATION_MARGIN))} rpm the model warns that it extrapolates (F-03).`,
      'Static measurements of one rotor do not validate forward flight or descent.',
    ];
    if (paired.has(motor.id)) limits.push('This rotor is in a coaxial pair; single-rotor measurements do not validate the pair\'s interaction.');
    if (set.applicability !== null) limits.push(set.applicability);
    return {
      ...base, missing: [...missing, ...bench.missing.map(item => `measurements: ${item}`)], label: 'measured-input', measurementSet: sha256,
      limits, reason: 'Bench data of this exact combination.',
    };
  });
  const limits = ['No label certifies exported settings for real flight.'];
  if (mode === 'measured') {
    limits.unshift('Calculation from measurements does not certify the aircraft: only motors with bench data of their exact combination are labeled measured-input.');
  }
  return { mode, label: weakestLabel(motors.map(motor => motor.label)), motors, limits };
}
