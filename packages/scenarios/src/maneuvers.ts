// Tuning maneuvers (TASK-173, S10): commanded changes in roll, pitch, heading or
// altitude, and what the response to each change was. A maneuver is a flight task
// (flight-tasks.ts), so it is defined, flown, recorded and repeated like one; this
// module holds what is its own: when each change comes, and the metrics.
//
// The metrics come from the recorded series on one time base: an edge is when the
// recording shows the request changed, and the response is what the recorded truth
// did from that moment. They describe, and no limit is applied to them (SA-01): the
// user judges. What the recording cannot say is shown as missing, never as a number.
//
// The definitions, for a change of the request from `from` to `to` at the edge:
//   delay      edge to the first time the response has moved 10 % of the way
//   rise time  10 % of the way to 90 % of the way, from where it actually was at the edge
//   overshoot  how far it passes `to`, as a percentage of the change requested
//   settling   edge to the last time it enters the band around `to` and stays there; the
//              band is a fraction of the change requested. A response that is outside at
//              the end of its window has not settled.
//   end error  actual minus requested, averaged over the end of the window
//
// Pure and cold: the Experiments tab calls these on a stored recording.

export type ManeuverAxis = 'roll' | 'pitch' | 'heading' | 'altitude';
export type ManeuverShape = 'step' | 'doublet';
export const MANEUVER_TYPES = {
  'roll-step': { axis: 'roll', shape: 'step' }, 'roll-doublet': { axis: 'roll', shape: 'doublet' },
  'pitch-step': { axis: 'pitch', shape: 'step' }, 'pitch-doublet': { axis: 'pitch', shape: 'doublet' },
  'heading-step': { axis: 'heading', shape: 'step' }, 'heading-doublet': { axis: 'heading', shape: 'doublet' },
  'altitude-step': { axis: 'altitude', shape: 'step' }, 'altitude-doublet': { axis: 'altitude', shape: 'doublet' },
} as const satisfies Record<string, { readonly axis: ManeuverAxis; readonly shape: ManeuverShape }>;
export type ManeuverType = keyof typeof MANEUVER_TYPES;
export const isManeuverType = (type: string): type is ManeuverType => Object.hasOwn(MANEUVER_TYPES, type);

/** Roll, pitch and yaw in degrees of a body-to-NED quaternion, in ArduPilot's order: yaw, then pitch, then roll. Yaw runs from -180 to 180. */
export function eulerDegOf(qw: number, qx: number, qy: number, qz: number): { readonly rollDeg: number; readonly pitchDeg: number; readonly yawDeg: number } {
  const toDeg = 180 / Math.PI;
  return {
    rollDeg: Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy)) * toDeg,
    pitchDeg: Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx)))) * toDeg,
    yawDeg: Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)) * toDeg,
  };
}
/**
 * Why this autopilot cannot fly a roll or pitch maneuver as asked; null when it can. SET_ATTITUDE_TARGET's thrust field holds the height
 * only while GUID_OPTIONS bit 3 is clear (ArduCopter/mode.h, SetAttitudeTarget_ThrustAsThrust): with it set, the 0.5 sent would be half thrust.
 */
export function attitudeManeuverRefusal(type: string, reported: (name: string) => number | undefined): string | null {
  if (!isManeuverType(type)) return null;
  const { axis } = MANEUVER_TYPES[type];
  if (axis !== 'roll' && axis !== 'pitch') return null;
  const options = reported('GUID_OPTIONS');
  if (options === undefined) return 'ArduPilot does not report GUID_OPTIONS, which decides how a roll or pitch maneuver holds its height';
  return Math.trunc(options) & 8 ? 'GUID_OPTIONS has bit 3 set, so ArduPilot would take the height-hold request of a roll or pitch maneuver as half thrust. Clear that bit to fly it' : null;
}

/** How long the request stays at its start before the first edge, so a chart shows where the response started from. */
export const BASELINE_S = 2;

/** One change of the request. On a timeline, values count from the maneuver's start value; from a recording, they are the recorded values. */
export interface ManeuverEdge { readonly timeS: number; readonly from: number; readonly to: number }
export interface ManeuverTimeline { readonly edges: readonly ManeuverEdge[]; readonly lengthS: number }

/**
 * The edges of a maneuver. A doublet goes one way for `holdS`, the other way for `holdS`, and back, with `holdS` to show how it
 * settles. A heading or altitude step stays where it went. A roll or pitch step returns level after `holdS`, because a lean held
 * on keeps accelerating, and that return is measured too.
 */
export function maneuverTimeline(axis: ManeuverAxis, shape: ManeuverShape, amplitude: number, holdS: number): ManeuverTimeline {
  const first = { timeS: BASELINE_S, from: 0, to: amplitude };
  if (shape === 'doublet') {
    return { edges: [first, { timeS: BASELINE_S + holdS, from: amplitude, to: -amplitude }, { timeS: BASELINE_S + 2 * holdS, from: -amplitude, to: 0 }], lengthS: BASELINE_S + 3 * holdS };
  }
  if (axis === 'roll' || axis === 'pitch') return { edges: [first, { timeS: BASELINE_S + holdS, from: amplitude, to: 0 }], lengthS: BASELINE_S + 2 * holdS };
  return { edges: [first], lengthS: BASELINE_S + holdS };
}
/** A simulated time is a sum of physics steps, so an observation meant to fall on an edge can read a rounding error before it. */
const EDGE_TIME_MARGIN_S = 1e-6;
/** The request at a moment of a timeline: the `to` of the last edge reached. */
export function offsetAt(timeline: ManeuverTimeline, timeS: number): number {
  let offset = 0;
  for (const edge of timeline.edges) if (timeS >= edge.timeS - EDGE_TIME_MARGIN_S) offset = edge.to;
  return offset;
}

// ---- the response ----------------------------------------------------------------------------------------------------------------------

/** A recorded series in time order: times in seconds on the run's own clock, values in the axis's unit. */
export interface ResponseSeries { readonly timeS: readonly number[]; readonly value: readonly number[] }
export interface EdgeResponse {
  readonly edgeTimeS: number; readonly endS: number; readonly from: number; readonly to: number;
  /** Where the response actually was at the edge. */
  readonly startActual: number | null;
  readonly delayS: number | null;
  readonly riseTimeS: number | null;
  readonly overshootPercent: number | null;
  /** The furthest it got towards and past `to`, and when. */
  readonly peak: number | null;
  readonly peakTimeS: number | null;
  readonly settlingTimeS: number | null;
  readonly endError: number | null;
  /** Why the recording cannot give these numbers; null when it can. */
  readonly missing: string | null;
}

/** A hole longer than this, or than this many sample spacings if that is longer, leaves a window without a measurable response. */
const LARGEST_GAP_S = 0.1, LARGEST_GAP_SPACINGS = 5;
/** The end error averages the end of the window: this long, or this share of it if the window is short. */
const END_WINDOW_S = 0.5, END_WINDOW_SHARE = 0.2;
const RISE_START = 0.1, RISE_END = 0.9;

function firstAtOrAfter(times: readonly number[], t: number): number {
  let low = 0, high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((times[middle] ?? Number.POSITIVE_INFINITY) < t) low = middle + 1; else high = middle;
  }
  return low;
}
/** Where `level` falls between two samples, as a time. */
function crossingS(t0: number, v0: number, t1: number, v1: number, level: number): number {
  return v1 === v0 ? t1 : t0 + (level - v0) / (v1 - v0) * (t1 - t0);
}

/** The response to one edge, from the moment of the edge to `endS`. `band` is the settling band as a fraction of the change requested. */
export function edgeResponse(actual: ResponseSeries, edge: ManeuverEdge, endS: number, band: number): EdgeResponse {
  if (!(band > 0 && band < 1)) throw new Error(`The settling band must be a fraction above 0 and below 1, not ${String(band)}`);
  const none = { edgeTimeS: edge.timeS, endS, from: edge.from, to: edge.to, startActual: null, delayS: null, riseTimeS: null, overshootPercent: null, peak: null, peakTimeS: null, settlingTimeS: null, endError: null };
  const times = actual.timeS, values = actual.value;
  // The last sample at or before the edge is where it was: a response cannot start before its command, so nothing after the edge may be interpolated into this.
  const after = firstAtOrAfter(times, edge.timeS), onEdge = times[after] === edge.timeS, start = onEdge ? after : after - 1;
  const startS = times[start], startActual = values[start], firstS = times[start + 1];
  if (startS === undefined || startActual === undefined || firstS === undefined || firstS > endS) {
    return { ...none, missing: `The recording holds no actual values around the change at ${edge.timeS.toFixed(2)} s` };
  }
  // The window: the value at the edge, then every sample up to its end.
  const windowTimes = [edge.timeS], windowValues = [startActual];
  for (let i = start + 1; i < times.length; i++) {
    const t = times[i], v = values[i];
    if (t === undefined || v === undefined || t > endS) break;
    windowTimes.push(t);
    windowValues.push(v);
  }
  const count = windowTimes.length;
  const spacingS = (times[start + 2] ?? firstS) - firstS, allowedGapS = Math.max(LARGEST_GAP_S, LARGEST_GAP_SPACINGS * spacingS);
  if (edge.timeS - startS > allowedGapS) return { ...none, missing: `The recording has a gap of ${(edge.timeS - startS).toFixed(2)} s before the change at ${edge.timeS.toFixed(2)} s` };
  // Time after the window's last sample counts as a hole too: the recording stopped.
  for (let i = 1; i <= count; i++) {
    const gapS = (i === count ? endS : windowTimes[i] ?? endS) - (windowTimes[i - 1] ?? edge.timeS);
    if (gapS > allowedGapS) return { ...none, startActual, missing: `The recording has a gap of ${gapS.toFixed(2)} s after ${(windowTimes[i - 1] ?? edge.timeS).toFixed(2)} s` };
  }

  // Everything below walks the window; both arrays hold `count` numbers.
  const timeAt = (i: number): number => windowTimes[i] ?? Number.NaN, valueAt = (i: number): number => windowValues[i] ?? Number.NaN;
  const requestedChange = Math.abs(edge.to - edge.from), direction = Math.sign(edge.to - edge.from) || 1;

  // Rise, from where it actually was.
  const span = edge.to - startActual;
  let tenS: number | null = null, ninetyS: number | null = null;
  if (span !== 0) {
    const share = (i: number): number => (valueAt(i) - startActual) / span;
    for (let i = 1; i < count; i++) {
      if (tenS === null && share(i) >= RISE_START) tenS = crossingS(timeAt(i - 1), share(i - 1), timeAt(i), share(i), RISE_START);
      if (tenS !== null && share(i) >= RISE_END) { ninetyS = crossingS(timeAt(i - 1), share(i - 1), timeAt(i), share(i), RISE_END); break; }
    }
  }

  // Overshoot, against the change requested.
  let peakIndex = 0;
  for (let i = 1; i < count; i++) if (direction * valueAt(i) > direction * valueAt(peakIndex)) peakIndex = i;
  const peak = valueAt(peakIndex), overshootPercent = requestedChange === 0 ? 0 : Math.max(0, direction * (peak - edge.to)) / requestedChange * 100;

  // Settling: back from the end, to the last sample outside the band.
  const bandWidth = band * requestedChange, errorAt = (i: number): number => Math.abs(valueAt(i) - edge.to);
  let settlingTimeS: number | null = null;
  if (errorAt(count - 1) <= bandWidth) {
    settlingTimeS = 0;
    for (let i = count - 2; i >= 0; i--) {
      if (errorAt(i) > bandWidth) { settlingTimeS = crossingS(timeAt(i), errorAt(i), timeAt(i + 1), errorAt(i + 1), bandWidth) - edge.timeS; break; }
    }
  }

  // End error.
  const lastS = timeAt(count - 1), endFromS = lastS - Math.min(END_WINDOW_S, END_WINDOW_SHARE * (endS - edge.timeS));
  let errorSum = 0, errorCount = 0;
  for (let i = count - 1; i >= 0 && timeAt(i) >= endFromS; i--) { errorSum += valueAt(i) - edge.to; errorCount++; }

  return {
    ...none, startActual, delayS: tenS === null ? null : tenS - edge.timeS, riseTimeS: tenS === null || ninetyS === null ? null : ninetyS - tenS,
    overshootPercent, peak, peakTimeS: timeAt(peakIndex), settlingTimeS, endError: errorCount > 0 ? errorSum / errorCount : null, missing: null,
  };
}

/** A recorded request changes by this much or more to count as an edge; recorded values are exact, so this only absorbs a heading's unwrapping. */
const EDGE_EPSILON = 1e-6;
/** The edges of a recorded request: each is the first row of a new value. */
export function edgesOf(requested: ResponseSeries): ManeuverEdge[] {
  const edges: ManeuverEdge[] = [];
  for (let i = 1; i < requested.value.length; i++) {
    const from = requested.value[i - 1], to = requested.value[i], timeS = requested.timeS[i];
    if (from !== undefined && to !== undefined && timeS !== undefined && Math.abs(to - from) > EDGE_EPSILON) edges.push({ timeS, from, to });
  }
  return edges;
}
/** Headings in degrees made continuous, each value within 180° of the one before it. */
export function unwrapDeg(values: readonly number[]): number[] {
  const out: number[] = [];
  let previous: number | null = null;
  for (const value of values) {
    const next: number = previous === null ? value : previous + ((value - previous + 540) % 360 + 360) % 360 - 180;
    out.push(next);
    previous = next;
  }
  return out;
}
/** One result per edge of the recorded request, each window ending at the next edge, and the last where the request's record ends. */
export function maneuverResponse(requested: ResponseSeries, actual: ResponseSeries, band: number): EdgeResponse[] {
  const edges = edgesOf(requested), lastS = requested.timeS[requested.timeS.length - 1] ?? 0;
  return edges.map((edge, i) => edgeResponse(actual, edge, edges[i + 1]?.timeS ?? lastS, band));
}
