import type { AircraftProfile } from './profile.ts';
import { validateAircraftProfile } from './profile.ts';

// Motor-to-output mapping record (TASK-142, S03). The profile already stores
// each motor's ArduPilot servo output (SERVOn, 1..16); this record is that
// assignment on its own, so it can be shown, checked and applied to a profile
// as a new version. Configuration-time code only.

export const OUTPUT_MAPPING_SCHEMA_VERSION = 1;
/** Highest servo output a profile may use (profile schema bound). */
export const MAX_PROFILE_OUTPUT = 16;
export interface OutputAssignment {
  readonly motorId: number;
  /** ArduPilot servo output number, SERVOn. */
  readonly output: number;
}
export interface OutputMapping {
  readonly schemaVersion: 1;
  /** One entry per motor of the profile, in ascending motor ID order. */
  readonly entries: readonly OutputAssignment[];
}

function fail(message: string): never {
  throw new Error(`Invalid output mapping: ${message}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The mapping a validated profile holds. */
export function outputMappingOf(profile: AircraftProfile): OutputMapping {
  return Object.freeze({
    schemaVersion: 1,
    entries: Object.freeze(profile.motors.map(motor => Object.freeze({ motorId: motor.id, output: motor.output }))),
  });
}

/**
 * Validates a mapping from `unknown` against the motors of a profile: exactly
 * one entry per motor in ascending motor ID order, outputs 1..16 and unique.
 */
export function validateOutputMapping(input: unknown, profile: AircraftProfile): OutputMapping {
  if (!isRecord(input)) fail('not an object');
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'entries,schemaVersion') fail(`unexpected fields ${keys}`);
  if (input.schemaVersion !== OUTPUT_MAPPING_SCHEMA_VERSION) fail('unsupported schema version');
  if (!Array.isArray(input.entries)) fail('entries must be a list');
  const raw: readonly unknown[] = input.entries;
  if (raw.length !== profile.motors.length) fail(`${raw.length} entries for ${profile.motors.length} motors`);
  const used = new Map<number, number>();
  const entries = raw.map((entry, index): OutputAssignment => {
    if (!isRecord(entry) || Object.keys(entry).sort().join(',') !== 'motorId,output') fail(`entry ${index + 1} must hold motorId and output`);
    const { motorId, output } = entry;
    // Ascending profile order; the profile check made motor IDs unique and ascending.
    const motor = profile.motors[index]!;
    if (motorId !== motor.id) fail(`entry ${index + 1} names motor ${String(motorId)}, expected motor ${motor.id}`);
    if (typeof output !== 'number' || !Number.isInteger(output) || output < 1 || output > MAX_PROFILE_OUTPUT) {
      fail(`motor ${motor.id} needs an output from 1 to ${MAX_PROFILE_OUTPUT}`);
    }
    const other = used.get(output);
    if (other !== undefined) fail(`output ${output} is assigned to motors ${other} and ${motor.id}`);
    used.set(output, motor.id);
    return Object.freeze({ motorId: motor.id, output });
  });
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries) });
}

/** The profile with the mapping applied: a new validated profile; nothing else changes. */
export function withOutputMapping(profile: AircraftProfile, input: unknown): AircraftProfile {
  const mapping = validateOutputMapping(input, profile);
  const motors = profile.motors.map((motor, index) => ({ ...motor, output: mapping.entries[index]!.output }));
  return validateAircraftProfile({ ...profile, motors });
}
