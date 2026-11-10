import { fitPropulsion, type PropulsionFit } from '@mirage/physics/propulsion-calibration';
import { buildProfileDynamics, profileRotorDefinition } from '@mirage/physics/profile-dynamics';
import { validateModelManifest } from '@mirage/physics/model-manifest';
import { catalogPolarByNumericId } from '@mirage/physics/polar-catalog';
import { deriveVehicleManifest, type ResolvedComponents } from './derive-manifest.ts';
import { motorCombination, motorSetKeys } from './calculation-mode.ts';
import { combinationKey, measurementSetBench, type MeasurementSet } from './measurements.ts';
import { withPropulsionCalibrations, type AircraftProfile, type BoundCalibration } from './profile.ts';
import type { StoredVersion } from '@mirage/project/schema';
import type { ProjectStore } from '@mirage/project/store';

// Propulsion calibrations (TASK-145, S04, S05; SPECS_SIMULATION_ENGINES "Propulsion calibration: TASK-145"): what `fitPropulsion` gave
// for one measurement set of one exact combination, kept as a `propulsion-calibration` record that depends on the measurement set and
// the combination's motor and propeller cards. A profile version binds it (profile schema 6) by copying its values with the record's
// SHA-256, and a motor uses it only when its combination key is the calibration's: a calibration is never transferred. Every residual
// is kept and shown; none is judged (SA-01). Configuration-time code only.

/**
 * Schema 3 (2026-11-10, stakeholder decision "Yes, refuse them"): schema 2 with an extended polar's rotational lift augmentation kept
 * by the scaled polar. Schema 2 (2026-11-08, stakeholder decision "Yes align"): the fit solved the rotor exactly as the flight binds it,
 * dynamic inflow included (`profileRotorDefinition`), but `scaledPolar` dropped the augmentation, so a schema 2 fit on an extended
 * polar was made without it; on a NeuralFoil polar, which has none, schema 2 and 3 fits are the same. Schema 1 fits solved the rotor
 * without dynamic inflow. Older schemas stay readable, since stored versions are immutable; `calibrationRefusal` says which
 * `bindCalibration` refuses, and the Components tab asks for a new fit.
 */
export const PROPULSION_CALIBRATION_SCHEMA_VERSION = 3;
/** The schema of fits on the flight's binding made while the scaled polar dropped an extended polar's augmentation. */
export const PROPULSION_CALIBRATION_NO_AUGMENTATION_SCHEMA = 2;
/** The schema of fits made before the static solve took the flight's binding. */
export const PROPULSION_CALIBRATION_STATIC_BINDING_SCHEMA = 1;
export interface PropulsionCalibration {
  readonly schemaVersion: typeof PROPULSION_CALIBRATION_SCHEMA_VERSION | typeof PROPULSION_CALIBRATION_NO_AUGMENTATION_SCHEMA
    | typeof PROPULSION_CALIBRATION_STATIC_BINDING_SCHEMA;
  readonly combinationKey: string;
  /** The measurement-set version fitted, and the cards of the combination's motor and propeller. */
  readonly measurementSet: string;
  readonly motorCard: string;
  readonly propellerCard: string;
  /** YYYY-MM-DD of the bench run. */
  readonly measuredOn: string;
  /** The catalog polar the scales apply to, and the BET module the fit ran on. */
  readonly polarId: number;
  readonly betModuleSha256: string;
  readonly fit: PropulsionFit;
}

const fail = (message: string): never => { throw new Error(`Invalid propulsion calibration: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) return fail(`${label} must be an object`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${label} lacks ${key}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} has an unexpected field ${key}`);
  return value;
}
const sha256 = (value: unknown, label: string): string => (typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : fail(`${label} must be a lowercase SHA-256`));
const finite = (value: unknown, label: string): number => (typeof value === 'number' && Number.isFinite(value) ? value : fail(`${label} must be a finite number`));
const orNull = <T>(value: unknown, read: (value: unknown) => T): T | null => (value === null ? null : read(value));
const list = (value: unknown, label: string, max: number): readonly unknown[] => (Array.isArray(value) && value.length <= max ? value : fail(`${label} must be a list of at most ${max}`));
const text = (value: unknown, label: string): string => (typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : fail(`${label} must be text`));

function fitOf(value: unknown): PropulsionFit {
  const f = exact(value, ['scales', 'notFitted', 'residuals', 'rmsThrustResidualN', 'rmsTorqueResidualNm', 'motor', 'envelope', 'iterations'], 'fit');
  const s = exact(f.scales, ['lift', 'drag'], 'fit.scales');
  const scale = (v: unknown, label: string) => { const n = finite(v, label); return n >= 0.25 && n <= 4 ? n : fail(`${label} must be 0.25 to 4`); };
  const e = exact(f.envelope, ['rpmMin', 'rpmMax', 'densityKgM3', 'advanceRatioMax'], 'fit.envelope');
  const envelope = { rpmMin: finite(e.rpmMin, 'fit.envelope.rpmMin'), rpmMax: finite(e.rpmMax, 'fit.envelope.rpmMax'), densityKgM3: finite(e.densityKgM3, 'fit.envelope.densityKgM3'),
    advanceRatioMax: finite(e.advanceRatioMax, 'fit.envelope.advanceRatioMax') };
  if (!(envelope.rpmMin > 0 && envelope.rpmMax > envelope.rpmMin)) fail('fit.envelope must hold an increasing RPM range');
  const residuals = list(f.residuals, 'fit.residuals', 32).map((item, k) => {
    const r = exact(item, ['rpm', 'thrustN', 'modelThrustN', 'torqueNm', 'modelTorqueNm'], `fit.residuals[${k}]`);
    return { rpm: finite(r.rpm, 'rpm'), thrustN: finite(r.thrustN, 'thrustN'), modelThrustN: finite(r.modelThrustN, 'modelThrustN'),
      torqueNm: orNull(r.torqueNm, v => finite(v, 'torqueNm')), modelTorqueNm: finite(r.modelTorqueNm, 'modelTorqueNm') };
  });
  if (residuals.length < 3) fail('fit.residuals must hold every bench point, at least three');
  const motor = orNull(f.motor, value => {
    const m = exact(value, ['kvRpmPerV', 'resistanceOhm', 'noLoadCurrentA', 'residuals', 'rmsResidualW'], 'fit.motor');
    return {
      kvRpmPerV: finite(m.kvRpmPerV, 'kvRpmPerV'), resistanceOhm: finite(m.resistanceOhm, 'resistanceOhm'), noLoadCurrentA: finite(m.noLoadCurrentA, 'noLoadCurrentA'),
      rmsResidualW: finite(m.rmsResidualW, 'rmsResidualW'),
      residuals: list(m.residuals, 'fit.motor.residuals', 32).map((item, k) => {
        const r = exact(item, ['rpm', 'electricalPowerW', 'modelElectricalPowerW', 'modelMotorVoltageV', 'supplyVoltageV'], `fit.motor.residuals[${k}]`);
        return { rpm: finite(r.rpm, 'rpm'), electricalPowerW: finite(r.electricalPowerW, 'electricalPowerW'), modelElectricalPowerW: finite(r.modelElectricalPowerW, 'modelElectricalPowerW'),
          modelMotorVoltageV: finite(r.modelMotorVoltageV, 'modelMotorVoltageV'), supplyVoltageV: finite(r.supplyVoltageV, 'supplyVoltageV') };
      }),
    };
  });
  if (motor && !(motor.resistanceOhm > 0 && motor.noLoadCurrentA >= 0)) fail('fit.motor needs a positive resistance and a no-load current of zero or more');
  return {
    scales: { lift: scale(s.lift, 'fit.scales.lift'), drag: scale(s.drag, 'fit.scales.drag') },
    notFitted: list(f.notFitted, 'fit.notFitted', 4).map((v, k) => text(v, `fit.notFitted[${k}]`)), residuals,
    rmsThrustResidualN: finite(f.rmsThrustResidualN, 'fit.rmsThrustResidualN'), rmsTorqueResidualNm: orNull(f.rmsTorqueResidualNm, v => finite(v, 'fit.rmsTorqueResidualNm')),
    motor, envelope, iterations: finite(f.iterations, 'fit.iterations'),
  };
}

/** A propulsion calibration from unknown; registered for the `propulsion-calibration` kind. */
export function validatePropulsionCalibration(value: unknown): PropulsionCalibration {
  const v = exact(value, ['schemaVersion', 'combinationKey', 'measurementSet', 'motorCard', 'propellerCard', 'measuredOn', 'polarId', 'betModuleSha256', 'fit'], 'the payload');
  const schemaVersion = v.schemaVersion === PROPULSION_CALIBRATION_SCHEMA_VERSION || v.schemaVersion === PROPULSION_CALIBRATION_NO_AUGMENTATION_SCHEMA
    || v.schemaVersion === PROPULSION_CALIBRATION_STATIC_BINDING_SCHEMA
    ? v.schemaVersion : fail(`schemaVersion must be ${PROPULSION_CALIBRATION_STATIC_BINDING_SCHEMA}, ${PROPULSION_CALIBRATION_NO_AUGMENTATION_SCHEMA} or ${PROPULSION_CALIBRATION_SCHEMA_VERSION}`);
  const measuredOn = typeof v.measuredOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.measuredOn) ? v.measuredOn : fail('measuredOn must be YYYY-MM-DD');
  const polarId = finite(v.polarId, 'polarId');
  if (!Number.isInteger(polarId) || polarId < 1) fail('polarId must be a catalog polar ID');
  return {
    schemaVersion, combinationKey: sha256(v.combinationKey, 'combinationKey'), measurementSet: sha256(v.measurementSet, 'measurementSet'),
    motorCard: sha256(v.motorCard, 'motorCard'), propellerCard: sha256(v.propellerCard, 'propellerCard'), measuredOn, polarId,
    betModuleSha256: sha256(v.betModuleSha256, 'betModuleSha256'), fit: fitOf(v.fit),
  };
}
export const readPropulsionCalibration = (stored: StoredVersion): PropulsionCalibration => validatePropulsionCalibration(stored.record.payload);

/** Why a new fit of an older schema is not saved when no refusal applies to it: only a fit made now is stored. */
export const OLD_SCHEMA_SAVE_REFUSAL = `Only a new fit (calibration schema ${PROPULSION_CALIBRATION_SCHEMA_VERSION}) is saved; fit it again`;
/** Stores a calibration with the measurement set and the two cards it was fitted from as its dependencies; only a fit of the current schema. */
export function savePropulsionCalibration(store: ProjectStore, projectId: string, name: string, calibration: PropulsionCalibration): Promise<StoredVersion> {
  const payload = validatePropulsionCalibration(calibration);
  if (payload.schemaVersion !== PROPULSION_CALIBRATION_SCHEMA_VERSION) throw new Error(calibrationRefusal(payload) ?? OLD_SCHEMA_SAVE_REFUSAL);
  const dependencies = [...new Set([payload.measurementSet, payload.motorCard, payload.propellerCard])].sort();
  return store.createItem(projectId, 'propulsion-calibration', { name: name.slice(0, 128), payload, dependencies });
}

/**
 * Fits the rotor of one profile motor to a measurement set of exactly its combination: the rotor as the profile builds it without any
 * bound calibration, on its catalog polar, and its motor at the card's KV. Refused for a set of another combination.
 */
export async function calibrateMotor(input: {
  readonly module: WebAssembly.Module; readonly betModuleSha256: string; readonly profile: AircraftProfile; readonly components: ResolvedComponents;
  readonly motorId: number; readonly set: { readonly sha256: string; readonly set: MeasurementSet };
}): Promise<PropulsionCalibration> {
  const { profile, set } = input, motor = profile.motors.find(item => item.id === input.motorId);
  const combination = motor ? motorCombination(profile, motor) : null, keys = motor ? await motorSetKeys(profile, motor) : null;
  if (!motor || !combination || !keys) throw new Error(`Motor ${input.motorId} has no complete combination of cards`);
  // The calibration belongs to the motor's own combination; its set is of that combination or of its cards on a laboratory supply.
  const key = keys.exact, setKey = await combinationKey(set.set.combination);
  if (setKey !== key && setKey !== keys.laboratory) throw new Error('The measurement set is of another combination: a calibration belongs to its own');
  const uncalibrated = withPropulsionCalibrations(profile, []);
  const derived = await deriveVehicleManifest(uncalibrated, input.components, { modelId: 1 });
  const build = buildProfileDynamics(derived.manifest, { syntheticPad: true });
  const model = validateModelManifest(build.configuration.manifest), index = model.rotors.findIndex(rotor => rotor.id === motor.id), rotor = model.rotors[index];
  if (!rotor) throw new Error(`The build has no rotor for motor ${motor.id}`);
  const kv = derived.manifest.motors.find(item => item.rotorId === motor.id)?.kvRpmPerV ?? null;
  const fit = fitPropulsion({ module: input.module, rotor: profileRotorDefinition(build.configuration, index), bench: measurementSetBench(set.set), kvRpmPerV: kv });
  return validatePropulsionCalibration({ schemaVersion: PROPULSION_CALIBRATION_SCHEMA_VERSION, combinationKey: key, measurementSet: set.sha256,
    motorCard: combination.motor, propellerCard: combination.propeller, measuredOn: set.set.source.date, polarId: rotor.polarId, betModuleSha256: input.betModuleSha256, fit });
}
/** Why a schema 1 calibration is not bound: it was fitted to another rotor than the one the flight binds. */
export const STATIC_BINDING_REFUSAL = 'This calibration was fitted before 2026-11-08 to the rotor without the flight\'s dynamic inflow; fit it again to bind it';
/** Why a schema 2 calibration on an extended polar is not bound: it was fitted without the polar's rotational lift augmentation. */
export const AUGMENTATION_REFUSAL = 'This calibration was fitted before 2026-11-09 on an extended polar without its rotational lift augmentation; fit it again to bind it';
/**
 * Why a stored calibration is not bound, or null when it is fitted to the rotor exactly as the flight binds it: schema 3, or schema 2
 * on a polar that is not an extended one (a NeuralFoil polar has no augmentation to lose).
 */
export function calibrationRefusal(calibration: PropulsionCalibration): string | null {
  switch (calibration.schemaVersion) {
    case PROPULSION_CALIBRATION_SCHEMA_VERSION: return null;
    case PROPULSION_CALIBRATION_NO_AUGMENTATION_SCHEMA: return catalogPolarByNumericId(calibration.polarId)?.provenance === 'extended-model' ? AUGMENTATION_REFUSAL : null;
    case PROPULSION_CALIBRATION_STATIC_BINDING_SCHEMA: return STATIC_BINDING_REFUSAL;
    default: { const never: never = calibration.schemaVersion; return never; }
  }
}
/** True for a calibration fitted to the rotor as the flight binds it (`calibrationRefusal` is null). */
export const fittedOnFlightBinding = (calibration: PropulsionCalibration): boolean => calibrationRefusal(calibration) === null;
/** The profile binding a stored calibration in place of any other of its combination; its measurement set must be bound. */
export function bindCalibration(profile: AircraftProfile, stored: StoredVersion): AircraftProfile {
  const c = readPropulsionCalibration(stored);
  const refusal = calibrationRefusal(c);
  if (refusal !== null) throw new Error(refusal);
  const entry: BoundCalibration = { record: stored.sha256, combinationKey: c.combinationKey, measurementSet: c.measurementSet, measuredOn: c.measuredOn,
    liftScale: c.fit.scales.lift, dragScale: c.fit.scales.drag, resistanceOhm: c.fit.motor?.resistanceOhm ?? null, noLoadCurrentA: c.fit.motor?.noLoadCurrentA ?? null,
    rpmMin: c.fit.envelope.rpmMin, rpmMax: c.fit.envelope.rpmMax, densityKgM3: c.fit.envelope.densityKgM3 };
  const others = profile.schemaVersion === 6 ? profile.propulsionCalibrations.filter(item => item.combinationKey !== c.combinationKey) : [];
  const bound = withPropulsionCalibrations(profile, [...others, entry]);
  if (bound.schemaVersion !== 6) throw new Error('The calibration\'s measurement set is not bound by this profile version in a calculation from measurements');
  return bound;
}
