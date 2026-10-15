import { StateReaderV2, StateWriterV2 } from '../../packages/protocol/src/atomic-v2.ts';
import { CAPACITY_V2, HeaderV2 } from '../../packages/protocol/src/layout-v2.ts';
import { StateCodecV2, newFlightStateV2, type FlightStateV2 } from '../../packages/protocol/src/state-v2.ts';

// Shared by the Node worker_threads stress test and the browser Worker stress
// test. Every field of publication k is a distinct function of k, so any frame
// mixing two publications (a torn read) is detected field by field.
// Imports use explicit .ts paths so Node can load this file in a worker thread.

export const STRESS_PUBLICATIONS = 1_000_000;
/** Control words in a separate small SAB: 0 = writer started, 1 = writer finished, 2 = publish failures. */
export const CONTROL_STARTED = 0;
export const CONTROL_FINISHED = 1;
export const CONTROL_FAILURES = 2;

/** Exactly representable f32 value unique to (k, field) within a 2^16 window. */
function f32(k: number, field: number): number {
  return ((k * 7 + field * 13) % 65536) / 4 - 4096;
}

/** Fills out with publication k (0-based); sampleId is assigned by the writer as k + 1. */
export function fillStressState(k: number, out: FlightStateV2): void {
  out.tickId.lo = (k + 1) >>> 0; out.tickId.hi = 0;
  out.epoch = 1 + (k >>> 20); out.simTimeS = (k + 1) / 400;
  out.northM = k * 0.5; out.eastM = -k; out.downM = k * 1e-3;
  out.qw = f32(k, 0); out.qx = f32(k, 1); out.qy = f32(k, 2); out.qz = f32(k, 3);
  out.vnMps = f32(k, 4); out.veMps = f32(k, 5); out.vdMps = f32(k, 6);
  out.anMps2 = f32(k, 7); out.aeMps2 = f32(k, 8); out.adMps2 = f32(k, 9);
  out.pRadS = f32(k, 10); out.qRadS = f32(k, 11); out.rRadS = f32(k, 12);
  out.specificForceXBodyMps2 = f32(k, 13); out.specificForceYBodyMps2 = f32(k, 14); out.specificForceZBodyMps2 = f32(k, 15);
  out.trueAirspeedMps = f32(k, 16); out.batteryVoltage = f32(k, 17); out.batteryCurrentA = f32(k, 18);
  out.ambientPressurePa = f32(k, 19); out.scheduledWallTimeMs = 1.79e12 + k * 2.5;
  out.groundClearanceM = f32(k, 20); out.referenceRotorRpm = f32(k, 21);
  out.vehicleFlags = k & 0x7f; out.ekfFlags = (k >>> 3) & 0x1f; out.ewFlags = (k >>> 5) & 0x1f;
  out.sensorValidMask = (k >>> 7) & 0x3f; out.modelId = k & 0xffff; out.autopilotMode = (k * 3) >>> 0;
  out.autopilotHealth = (k >>> 2) & 0x0f; out.lastActuatorTick.lo = k >>> 0; out.lastActuatorTick.hi = 0;
  out.autopilotStatusAgeMs = f32(k, 22);
}

/** Runs the writer side: publishes STRESS_PUBLICATIONS frames as fast as possible. */
export function runStressWriter(buffer: SharedArrayBuffer, control: Int32Array, publications = STRESS_PUBLICATIONS): void {
  const writer = new StateWriterV2(buffer), state = newFlightStateV2();
  Atomics.store(control, CONTROL_STARTED, 1);
  for (let k = 0; k < publications; k++) {
    fillStressState(k, state);
    if (!writer.publish(state)) Atomics.add(control, CONTROL_FAILURES, 1);
  }
  Atomics.store(control, CONTROL_FINISHED, 1);
}

export interface StressReport {
  reads: number; misses: number; torn: number; nonFinite: number; regressions: number;
  maxSampleId: number; finalPublished: number; finalMatches: boolean; failures: number; timedOut: boolean;
}

/**
 * Runs the reader side until the writer finishes, reading the newest frame and
 * older ages (up to the ring capacity) so slots being overwritten are hit too.
 * Each successful read must equal the expected publication for its sampleId.
 */
export function runStressReader(buffer: SharedArrayBuffer, control: Int32Array, timeoutMs: number): StressReport {
  const reader = new StateReaderV2(buffer), actual = newFlightStateV2(), expected = newFlightStateV2();
  const report: StressReport = { reads: 0, misses: 0, torn: 0, nonFinite: 0, regressions: 0, maxSampleId: 0,
    finalPublished: 0, finalMatches: false, failures: 0, timedOut: false };
  const deadline = performance.now() + timeoutMs;
  while (Atomics.load(control, CONTROL_STARTED) === 0) {
    if (performance.now() > deadline) { report.timedOut = true; return report; }
  }
  let iteration = 0, lastLatest = 0;
  while (Atomics.load(control, CONTROL_FINISHED) === 0) {
    if ((iteration & 1023) === 0 && performance.now() > deadline) { report.timedOut = true; break; }
    // Alternate the newest frame with the oldest one, which is the slot the writer overwrites
    // next; the oldest-slot reads are the ones that can race a write in progress.
    const age = (iteration++ & 1) === 0 ? 0 : CAPACITY_V2 - 1;
    if (!reader.latest(actual, age)) { report.misses++; continue; }
    report.reads++;
    if (age === 0) {
      if (actual.sampleId < lastLatest) report.regressions++;
      lastLatest = actual.sampleId;
    }
    if (!isCoherent(actual, expected)) report.torn++;
    if (!Number.isFinite(actual.northM + actual.qw + actual.simTimeS + actual.scheduledWallTimeMs)) report.nonFinite++;
    if (actual.sampleId > report.maxSampleId) report.maxSampleId = actual.sampleId;
  }
  report.failures = Atomics.load(control, CONTROL_FAILURES);
  report.finalPublished = Atomics.load(new Int32Array(buffer), HeaderV2.Published) >>> 0;
  report.finalMatches = reader.latest(actual) && isCoherent(actual, expected) && actual.sampleId === report.finalPublished;
  return report;
}

const expectedCodec = new StateCodecV2(), actualCodec = new StateCodecV2();
/** True when every encoded byte of the decoded frame equals publication sampleId - 1. */
export function isCoherent(actual: FlightStateV2, scratch: FlightStateV2): boolean {
  const k = actual.sampleId - 1;
  if (k < 0) return false;
  fillStressState(k, scratch);
  scratch.sampleId = actual.sampleId;
  expectedCodec.pack(scratch); actualCodec.pack(actual);
  for (let i = 1; i < expectedCodec.words.length; i++) {
    if (expectedCodec.words[i] !== actualCodec.words[i]) return false;
  }
  return true;
}
