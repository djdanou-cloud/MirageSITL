import { initialEffectParameters, type EffectControl } from "@mirage/protocol";
import type { ScheduledEffect } from "./fault-schedule.ts";

// The EKF drift scenario (TASK-170, S09): an input error, never a change to ArduPilot's estimate. MirageSITL's GNSS position runs away from
// the truth in one direction, coherently with its velocity, on the coherent drift of TASK-055 (`ew.velocity-drift`), and ArduPilot may
// follow it, reject it or enter a failsafe; nothing here predicts which. Its form is exact, so a test can hold the model to it:
//
//   while it grows, for t from its onset:  v(t) = min(a t, V),  b(t) = integral of v
//   abrupt removal:                        b and v go to 0 at once, an explicit discontinuity
//   gradual removal:                       a at most, V at most, back to b = 0 with v = 0, the shortest way
//
// The drift's position error never fades without its derivative (TASK-055), so a gradual removal first brakes, which still moves it further,
// and then runs back. Cold path.

export const EKF_DRIFT_SCHEMA_VERSION = 1;
/** The drift model's own ranges (EFFECT_CATALOG['ew.velocity-drift']). */
export const EKF_DRIFT_MAX_GROWTH_MPS2 = 0.3, EKF_DRIFT_MAX_SPEED_MPS = 20;
/** A longest growth and onset, s of simulated time; a longer one is a typing mistake, not a plan. */
export const EKF_DRIFT_MAX_S = 86400;
export type EkfDriftRemoval = "gradual" | "abrupt";
export interface EkfDriftProfile {
  readonly schemaVersion: typeof EKF_DRIFT_SCHEMA_VERSION;
  /** The way the GNSS position runs away: degrees clockwise from north. */
  readonly directionDeg: number;
  /** How fast the error's speed grows, m/s². */
  readonly growthMps2: number;
  /** The speed at which it stops growing, m/s. */
  readonly topSpeedMps: number;
  /** Simulated seconds after the first arming. */
  readonly onsetS: number;
  /** How long it grows, s. */
  readonly durationS: number;
  readonly removal: EkfDriftRemoval;
}
/** One stretch of constant acceleration along the direction of the drift. */
export interface EkfDriftPhase {
  readonly startS: number;
  readonly durationS: number;
  readonly accelerationMps2: number;
}

const fail = (message: string): never => { throw new Error(`Invalid EKF drift: ${message}`); };
const inRange = (value: unknown, low: number, high: number, label: string, exclusiveLow = false): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value > high || (exclusiveLow ? value <= low : value < low)) return fail(`${label} must be ${exclusiveLow ? "above " : ""}${low} ${exclusiveLow ? "and at most" : "to"} ${high}`);
  return value;
};
export function parseEkfDrift(input: unknown): EkfDriftProfile {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("it must be an object");
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!["schemaVersion", "directionDeg", "growthMps2", "topSpeedMps", "onsetS", "durationS", "removal"].includes(key)) fail(`it has an unexpected field ${key}`);
  if (value.schemaVersion !== EKF_DRIFT_SCHEMA_VERSION) fail(`schemaVersion must be ${EKF_DRIFT_SCHEMA_VERSION}`);
  if (value.removal !== "gradual" && value.removal !== "abrupt") return fail("the removal must be gradual or abrupt");
  return { schemaVersion: EKF_DRIFT_SCHEMA_VERSION, directionDeg: inRange(value.directionDeg, 0, 360, "the direction"), growthMps2: inRange(value.growthMps2, 0, EKF_DRIFT_MAX_GROWTH_MPS2, "the growth rate", true),
    topSpeedMps: inRange(value.topSpeedMps, 0, EKF_DRIFT_MAX_SPEED_MPS, "the top speed", true), onsetS: inRange(value.onsetS, 0, EKF_DRIFT_MAX_S, "the onset"),
    durationS: inRange(value.durationS, 0, EKF_DRIFT_MAX_S, "the duration", true), removal: value.removal };
}

/** Where a stretch of constant acceleration leaves the error. */
function advance(offsetM: number, speedMps: number, accelerationMps2: number, timeS: number): { readonly offsetM: number; readonly speedMps: number } {
  return { offsetM: offsetM + speedMps * timeS + 0.5 * accelerationMps2 * timeS * timeS, speedMps: speedMps + accelerationMps2 * timeS };
}
/** The growth, as acceleration until the top speed and then none. */
function growthEnd(profile: EkfDriftProfile): { readonly offsetM: number; readonly speedMps: number } {
  const rampS = Math.min(profile.durationS, profile.topSpeedMps / profile.growthMps2), ramp = advance(0, 0, profile.growthMps2, rampS);
  return advance(ramp.offsetM, ramp.speedMps, 0, profile.durationS - rampS);
}
/** The stretches of the removal: back through zero speed to at most the top speed, and braked to stop exactly at the truth. */
function removalPhases(profile: EkfDriftProfile, startS: number): readonly EkfDriftPhase[] {
  const a = profile.growthMps2, end = growthEnd(profile);
  const peak = Math.sqrt(a * end.offsetM + end.speedMps * end.speedMps / 2), back = Math.min(peak, profile.topSpeedMps);
  const firstS = (end.speedMps + back) / a, lastS = back / a;
  const cruiseS = peak > profile.topSpeedMps ? (end.offsetM + (end.speedMps * end.speedMps - 2 * back * back) / (2 * a)) / back : 0;
  const phases: EkfDriftPhase[] = [{ startS, durationS: firstS, accelerationMps2: -a }];
  if (cruiseS > 0) phases.push({ startS: startS + firstS, durationS: cruiseS, accelerationMps2: 0 });
  const previous = phases[phases.length - 1];
  phases.push({ startS: (previous?.startS ?? startS) + (previous?.durationS ?? 0), durationS: lastS, accelerationMps2: a });
  return phases;
}
/** The whole scenario as stretches of constant acceleration, on the schedule's clock. The growth's cap is the model's own, so it is one stretch. */
export function ekfDriftPhases(profile: EkfDriftProfile): readonly EkfDriftPhase[] {
  const growth: EkfDriftPhase = { startS: profile.onsetS, durationS: profile.durationS, accelerationMps2: profile.growthMps2 };
  return profile.removal === "abrupt" ? [growth] : [growth, ...removalPhases(profile, profile.onsetS + profile.durationS)];
}
/** When the error is gone, on the schedule's clock. */
export function ekfDriftEndS(profile: EkfDriftProfile): number {
  const last = ekfDriftPhases(profile).at(-1);
  return last ? last.startS + last.durationS : profile.onsetS;
}
/** The error at `atS`, along the direction of the drift, from the form above: the oracle tests hold the running model to. */
export function ekfDriftAt(profile: EkfDriftProfile, atS: number): { readonly offsetM: number; readonly speedMps: number } {
  const zero = { offsetM: 0, speedMps: 0 };
  if (atS < profile.onsetS || atS >= ekfDriftEndS(profile)) return zero;
  const growthEndS = profile.onsetS + profile.durationS;
  if (atS <= growthEndS) {
    const t = atS - profile.onsetS, rampS = Math.min(t, profile.topSpeedMps / profile.growthMps2), ramp = advance(0, 0, profile.growthMps2, rampS);
    return advance(ramp.offsetM, ramp.speedMps, 0, t - rampS);
  }
  let state = growthEnd(profile);
  for (const phase of removalPhases(profile, growthEndS)) {
    if (atS <= phase.startS + phase.durationS) return advance(state.offsetM, state.speedMps, phase.accelerationMps2, atS - phase.startS);
    state = advance(state.offsetM, state.speedMps, phase.accelerationMps2, phase.durationS);
  }
  return zero;
}
/** The farthest the GNSS position gets from the truth, m, as the panel says before anything flies. */
export function ekfDriftPeakM(profile: EkfDriftProfile): number {
  const end = growthEnd(profile);
  return profile.removal === "abrupt" ? end.offsetM : end.offsetM + end.speedMps * end.speedMps / (2 * profile.growthMps2);
}
/** Unit north and east components of its direction. */
export const ekfDriftAxis = (profile: EkfDriftProfile): readonly [number, number] => {
  const radians = profile.directionDeg * Math.PI / 180;
  return [Math.cos(radians), Math.sin(radians)];
};

const DRIFT_ID = "ekf-drift-";
export const isEkfDriftEntry = (entry: ScheduledEffect): boolean => entry.control.id.startsWith(DRIFT_ID);
/**
 * The scenario as entries of a fault schedule, one per stretch. Each starts where the one before ended, and the drift model carries its
 * position and velocity across; the last ends with a step to the truth, which for a gradual removal only clears what a tick's rounding left.
 */
export function ekfDriftEntries(profile: EkfDriftProfile): readonly ScheduledEffect[] {
  const [north, east] = ekfDriftAxis(profile), phases = ekfDriftPhases(profile);
  return phases.map((phase, index): ScheduledEffect => {
    const control: EffectControl = { schemaVersion: 1, id: `${DRIFT_ID}${index}`, effect: "ew.velocity-drift", enabled: true, intensity: 1, parameters: { ...initialEffectParameters("ew.velocity-drift"),
      accelerationNedMps2: [north * phase.accelerationMps2, east * phase.accelerationMps2, 0], maxSpeedMps: profile.topSpeedMps } };
    return { control, onsetS: phase.startS, durationS: phase.durationS, recovery: index === phases.length - 1 ? "step-to-truth" : "hold-offset" };
  });
}
