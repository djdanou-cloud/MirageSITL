// Deterministic resimulation (TASK-077): replays recorded inputs through a
// simulator built from the same model hashes and seed, and compares the
// produced truth with the recorded truth. A mismatch produces a report; the
// recording is never modified (Recording is frozen and read-only here).
//
// Contract: the Input record with (epoch, tick k) is the command applied by
// the step that produced the Truth record (epoch, tick k). Each segment
// starts from a reset of the simulator (a recorded epoch change is a reset).
// Ticks without an input record (recorded loss) make the rest of that segment
// unverifiable: it is reported as incomplete rather than guessed.
import { RECORD_VALUES } from "./format.ts";
import { tickKey, type Recording } from "./replay.ts";

export interface Resimulator {
  readonly modelHashes: { physics: string; airframe: string };
  /** Resets to the initial state of an epoch for this seed. */
  reset(seed: number, epoch: number): void;
  /** Applies one recorded input (RECORD_VALUE_NAMES[1] layout) and writes the resulting truth (RECORD_VALUE_NAMES[3] layout). */
  step(input: readonly number[], truthOut: Float64Array): void;
}

export interface ResimTolerance { positionM: number; velocityMps: number; quaternionDot: number }

export interface ResimMismatch { epoch: number; tick: number; positionErrorM: number; velocityErrorMps: number; quaternionDot: number }

export interface ResimReport {
  verdict: "match" | "mismatch" | "incomplete";
  comparedTicks: number;
  maxPositionErrorM: number;
  maxVelocityErrorMps: number;
  minQuaternionDot: number;
  firstMismatch: ResimMismatch | null;
  /** At most 32 mismatches, in tick order. */
  mismatches: ResimMismatch[];
  mismatchCount: number;
  incompleteSegments: { epoch: number; fromTick: number; reason: string }[];
  manifest: { sessionId: string; seed: number; modelHashes: { physics: string; airframe: string } };
}

export function resimulate(recording: Recording, sim: Resimulator, tolerance: ResimTolerance): ResimReport {
  const m = recording.manifest;
  if (sim.modelHashes.physics !== m.modelHashes.physics || sim.modelHashes.airframe !== m.modelHashes.airframe) {
    throw new Error("Resimulation model hash mismatch: the recording was made with a different physics build or airframe");
  }
  if (!(tolerance.positionM >= 0 && tolerance.velocityMps >= 0 && tolerance.quaternionDot > 0 && tolerance.quaternionDot <= 1)) throw new Error("Invalid tolerance");
  const report: ResimReport = {
    verdict: "match", comparedTicks: 0, maxPositionErrorM: 0, maxVelocityErrorMps: 0, minQuaternionDot: 1, firstMismatch: null, mismatches: [], mismatchCount: 0,
    incompleteSegments: [], manifest: { sessionId: m.sessionId, seed: m.seed, modelHashes: { ...m.modelHashes } },
  };
  const out = new Float64Array(RECORD_VALUES);
  for (const seg of recording.segments) {
    sim.reset(m.seed, seg.epoch);
    let expectedTick = seg.firstTick;
    for (let i = seg.start; i < seg.end; i++) {
      const truth = recording.truth[i]!; // i < seg.end <= length
      const input = recording.inputs.get(tickKey(seg.epoch, truth.tick));
      if (truth.tick !== expectedTick || !input) {
        report.incompleteSegments.push({ epoch: seg.epoch, fromTick: expectedTick, reason: input ? "missing ticks (recorded loss)" : "missing input record" });
        break;
      }
      sim.step(input.values, out);
      expectedTick++;
      const v = truth.values;
      const dp = Math.hypot(out[0]! - v[0]!, out[1]! - v[1]!, out[2]! - v[2]!);
      const dv = Math.hypot(out[3]! - v[3]!, out[4]! - v[4]!, out[5]! - v[5]!);
      const dot = Math.abs(out[6]! * v[6]! + out[7]! * v[7]! + out[8]! * v[8]! + out[9]! * v[9]!); // q and -q are the same attitude
      report.comparedTicks++;
      report.maxPositionErrorM = Math.max(report.maxPositionErrorM, dp);
      report.maxVelocityErrorMps = Math.max(report.maxVelocityErrorMps, dv);
      report.minQuaternionDot = Math.min(report.minQuaternionDot, dot);
      if (dp > tolerance.positionM || dv > tolerance.velocityMps || dot < tolerance.quaternionDot) {
        const mismatch = { epoch: seg.epoch, tick: truth.tick, positionErrorM: dp, velocityErrorMps: dv, quaternionDot: dot };
        report.mismatchCount++;
        report.firstMismatch ??= mismatch;
        if (report.mismatches.length < 32) report.mismatches.push(mismatch);
      }
    }
  }
  report.verdict = report.mismatchCount > 0 ? "mismatch" : report.incompleteSegments.length > 0 ? "incomplete" : "match";
  return report;
}
