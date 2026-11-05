import { effectDefinition, parseEffectControl, type EffectControl, type EffectFamily, type EffectId, type EffectRecovery } from "@mirage/protocol";
import { ekfDriftEntries, isEkfDriftEntry, parseEkfDrift, type EkfDriftProfile } from "./ekf-drift.ts";

// The schedule of the Faults and interference tab (TASK-169, S09): which effects a run applies by itself, when and for how long. A
// schedule is an input of the run, so its experiment record keeps it. Time counts simulated seconds from the moment the aircraft
// first arms, so a repeat meets its faults at the same point of the flight however long its warmup took. Cold path.

export const FAULT_SCHEDULE_SCHEMA_VERSION = 1;
export const MAX_SCHEDULED_EFFECTS = 64;
/** A day of simulated time; a later onset is a typing mistake, not a plan. */
export const MAX_SCHEDULE_S = 86400;
/** The families this tab offers: environment belongs to the Weather tab, and `sensor` to the Sensors tab, before a run. */
export const FAULT_TAB_FAMILIES: readonly EffectFamily[] = ["fault", "delivery", "ardupilot"];

export interface ScheduledEffect {
  /** What to apply, enabled. */
  readonly control: EffectControl;
  /** Simulated seconds after the first arming. */
  readonly onsetS: number;
  /** How long it stays on, s; null keeps it on until the run ends. */
  readonly durationS: number | null;
  /** What a drift does when it ends: decelerate and hold its offset, or step back to the truth. */
  readonly recovery: EffectRecovery;
}
export interface FaultSchedule {
  readonly schemaVersion: typeof FAULT_SCHEDULE_SCHEMA_VERSION;
  readonly entries: readonly ScheduledEffect[];
  /** TASK-170: the EKF drift scenario these entries include, if any; its entries are exactly ekfDriftEntries of this profile. */
  readonly ekfDrift?: EkfDriftProfile;
}
export const EMPTY_FAULT_SCHEDULE: FaultSchedule = Object.freeze({ schemaVersion: FAULT_SCHEDULE_SCHEMA_VERSION, entries: Object.freeze([]) });

const fail = (message: string): never => { throw new Error(`Invalid fault schedule: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Why a run with ArduPilot cannot deliver this control, or null. Its vertical GNSS channel is shared: the height on the state line also
 * feeds SITL's barometer, so an offset there would be a barometer fault as well.
 */
export function sitlDeliveryRefusal(control: EffectControl): string | null {
  const down = (key: string): number => { const value = control.parameters[key]; return typeof value === "object" ? value[2] : 0; };
  if (control.effect === "ew.position-step" && down("offsetNedM") !== 0) return "A vertical GNSS step cannot reach ArduPilot alone: the height on the state line also feeds its barometer. Set the down offset to 0.";
  if (control.effect === "ew.velocity-drift" && down("accelerationNedMps2") !== 0) return "A vertical GNSS drift cannot reach ArduPilot alone: the height on the state line also feeds its barometer. Set the down acceleration to 0.";
  return null;
}
/** Two entries of one key cannot overlap, because the later would replace the earlier: one effect, and one motor for a motor fault. */
const overlapKey = (control: EffectControl): string => control.effect === "motor.loss" ? `${control.effect}:${String(control.parameters.motorIndex)}` : control.effect;
const endOf = (entry: ScheduledEffect): number => (entry.durationS === null ? Infinity : entry.onsetS + entry.durationS);

function entryOf(value: unknown, index: number): ScheduledEffect {
  const label = `entries[${index}]`;
  if (!isRecord(value)) return fail(`${label} must be an object`);
  const keys = ["control", "onsetS", "durationS", "recovery"];
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${label} has an unexpected field ${key}`);
  const { onsetS, durationS, recovery } = value;
  let control: EffectControl;
  try { control = parseEffectControl(value.control); } catch (cause) { return fail(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (!control.enabled) fail(`${label} must be enabled; its end is its duration`);
  if (!FAULT_TAB_FAMILIES.includes(effectDefinition(control.effect).family)) fail(`${label}: ${control.effect} does not belong on this schedule`);
  const refusal = sitlDeliveryRefusal(control);
  if (refusal !== null) fail(`${label}: ${refusal}`);
  if (typeof onsetS !== "number" || !Number.isFinite(onsetS) || onsetS < 0 || onsetS > MAX_SCHEDULE_S) fail(`${label}.onsetS must be 0 to ${MAX_SCHEDULE_S} s`);
  if (durationS !== null && (typeof durationS !== "number" || !Number.isFinite(durationS) || durationS <= 0 || durationS > MAX_SCHEDULE_S)) fail(`${label}.durationS must be above 0 and at most ${MAX_SCHEDULE_S} s, or null`);
  if (recovery !== "hold-offset" && recovery !== "step-to-truth") return fail(`${label}.recovery must be hold-offset or step-to-truth`);
  return { control, onsetS: onsetS as number, durationS: durationS as number | null, recovery };
}

/** A schedule from unknown (a stored value, or a form): every control checked as the protocol checks it, and no overlap. */
export function parseFaultSchedule(input: unknown): FaultSchedule {
  if (!isRecord(input) || input.schemaVersion !== FAULT_SCHEDULE_SCHEMA_VERSION) return fail(`schemaVersion must be ${FAULT_SCHEDULE_SCHEMA_VERSION}`);
  if (!Array.isArray(input.entries)) return fail("entries must be a list");
  const raw: readonly unknown[] = input.entries;
  if (raw.length > MAX_SCHEDULED_EFFECTS) fail(`at most ${MAX_SCHEDULED_EFFECTS} entries`);
  const entries = raw.map(entryOf);
  entries.forEach((entry, index) => {
    const clash = entries.findIndex((other, at) => at < index && overlapKey(other.control) === overlapKey(entry.control) && other.onsetS < endOf(entry) && entry.onsetS < endOf(other));
    if (clash >= 0) fail(`entries[${index}] overlaps entries[${clash}] of ${entry.control.effect}`);
    if (entries.some((other, at) => at < index && other.control.id === entry.control.id && overlapKey(other.control) !== overlapKey(entry.control))) fail(`entries[${index}] reuses the ID ${entry.control.id} of another effect`);
  });
  const drift = input.ekfDrift === undefined ? null : parseEkfDrift(input.ekfDrift), driftEntries = entries.filter(isEkfDriftEntry);
  if (JSON.stringify(driftEntries) !== JSON.stringify(drift ? ekfDriftEntries(drift) : [])) fail("the EKF drift entries are not those of its profile");
  return { schemaVersion: FAULT_SCHEDULE_SCHEMA_VERSION, entries, ...(drift ? { ekfDrift: drift } : {}) };
}
/** The schedule with this EKF drift in place of any before it, or with none; it refuses what overlaps, as parseFaultSchedule does. */
export function withEkfDrift(schedule: FaultSchedule, profile: EkfDriftProfile | null): FaultSchedule {
  const others = schedule.entries.filter(entry => !isEkfDriftEntry(entry));
  return parseFaultSchedule({ schemaVersion: FAULT_SCHEDULE_SCHEMA_VERSION, entries: [...others, ...(profile ? ekfDriftEntries(profile) : [])], ...(profile ? { ekfDrift: profile } : {}) });
}

/** One change a schedule makes: entry `entry` goes on or off at `atS`. */
export interface FaultTransition {
  readonly atS: number;
  readonly entry: number;
  readonly on: boolean;
}
/** Every change in the order it happens; at one moment, what goes off goes first, so that a following entry starts clean. */
export function faultTimeline(schedule: FaultSchedule): readonly FaultTransition[] {
  const transitions: FaultTransition[] = [];
  schedule.entries.forEach((item, entry) => {
    transitions.push({ atS: item.onsetS, entry, on: true });
    if (item.durationS !== null) transitions.push({ atS: item.onsetS + item.durationS, entry, on: false });
  });
  return transitions.sort((a, b) => a.atS - b.atS || Number(a.on) - Number(b.on) || a.entry - b.entry);
}
export const scheduledEffectId = (effect: EffectId, index: number): string => `${effect.replaceAll(".", "-")}-${index}`;
