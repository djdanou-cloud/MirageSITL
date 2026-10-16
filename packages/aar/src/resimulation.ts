import { SnapshotReplay } from "./replay.ts";
import { AarRecord } from "./record.ts";
import {
  newFlightStateV2,
  copyFlightStateV2,
  type FlightStateV2,
} from "@mirage/protocol";
export interface ResimulationBackend {
  readonly modelSha256: string;
  readonly firmwareSha256: string | null;
  readonly seed: number;
  /** Reset from the complete archived configuration; false means unavailable provenance/backend. */
  reset(manifest: SnapshotReplay["manifest"]): boolean;
  /** Return an independently resimulated state for this recorded sample; never modify the record. */
  sample(record: Readonly<AarRecord>): Readonly<FlightStateV2>;
}
export interface ResimulationReport {
  compared: number;
  mismatches: number;
  maxPositionErrorM: number;
  maxAttitudeErrorRad: number;
  status: "PASS" | "FAIL";
}
export function compareResimulation(
  replay: SnapshotReplay,
  backend: ResimulationBackend,
  positionToleranceM: number,
  attitudeToleranceRad: number,
): ResimulationReport {
  const m = replay.manifest;
  if (
    !Number.isFinite(positionToleranceM) ||
    positionToleranceM < 0 ||
    !Number.isFinite(attitudeToleranceRad) ||
    attitudeToleranceRad < 0 ||
    backend.modelSha256 !== m.modelSha256 ||
    backend.firmwareSha256 !== m.firmwareSha256 ||
    backend.seed !== m.seed ||
    !backend.reset(m)
  )
    throw new Error("Resimulation provenance unavailable or mismatched");
  const report: ResimulationReport = {
      compared: 0,
      mismatches: 0,
      maxPositionErrorM: 0,
      maxAttitudeErrorRad: 0,
      status: "PASS",
    },
    record = new AarRecord(),
    expected = newFlightStateV2();
  for (let i = 0; i < replay.count; i++) {
    replay.read(i, record);
    copyFlightStateV2(record.state, expected);
    const actual = backend.sample(record);
    const p = Math.hypot(
      actual.northM - expected.northM,
      actual.eastM - expected.eastM,
      actual.downM - expected.downM,
    );
    const norm =
      Math.hypot(actual.qw, actual.qx, actual.qy, actual.qz) *
      Math.hypot(expected.qw, expected.qx, expected.qy, expected.qz);
    const dot = Math.abs(
      (actual.qw * expected.qw +
        actual.qx * expected.qx +
        actual.qy * expected.qy +
        actual.qz * expected.qz) /
        norm,
    );
    const angle = norm > 0 ? 2 * Math.acos(Math.min(1, dot)) : Infinity;
    report.compared++;
    if (
      !Number.isFinite(p) ||
      !Number.isFinite(angle) ||
      p > positionToleranceM ||
      angle > attitudeToleranceRad ||
      actual.epoch !== expected.epoch ||
      actual.simTimeS !== expected.simTimeS
    )
      report.mismatches++;
    report.maxPositionErrorM = Math.max(
      report.maxPositionErrorM,
      Number.isFinite(p) ? p : Infinity,
    );
    report.maxAttitudeErrorRad = Math.max(
      report.maxAttitudeErrorRad,
      Number.isFinite(angle) ? angle : Infinity,
    );
  }
  if (report.mismatches || !report.compared) report.status = "FAIL";
  return report;
}
