import { SnapshotReplay } from "@mirage/aar/replay";
import { AarRecord } from "@mirage/aar/record";
import { RecordFlag } from "@mirage/aar/format";
export interface ResponsePoint {
  epoch: number;
  timeS: number;
  pilot: number;
  actuator: number | null;
  responseRadS: number;
  gapBefore: boolean;
}
/** Decimate by per-bin pilot/response extrema plus endpoints; preserve any skipped gap.
 * Every output series shares the exact simulation-time axis, never sample indexes.
 */
export function responseSeries(
  replay: SnapshotReplay,
  maxPoints = 10000,
): ResponsePoint[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 8 || maxPoints > 10000)
    throw new RangeError("Invalid chart point budget");
  const out: ResponsePoint[] = [],
    r = new AarRecord(),
    bins = Math.floor(maxPoints / 6),
    width = Math.max(1, Math.ceil(replay.count / bins));
  let previousEpoch = -1,
    previousTime = -1;
  for (let start = 0; start < replay.count; start += width) {
    const end = Math.min(replay.count, start + width),
      candidates = new Map<number, ResponsePoint>();
    let first: ResponsePoint | null = null,
      last: ResponsePoint | null = null,
      minPilot: ResponsePoint | null = null,
      maxPilot: ResponsePoint | null = null,
      minRate: ResponsePoint | null = null,
      maxRate: ResponsePoint | null = null;
    let minPi = start,
      maxPi = start,
      minRi = start,
      maxRi = start,
      hasGap = false;
    for (let i = start; i < end; i++) {
      replay.read(i, r);
      const s = r.state,
        flags = r.view.getUint32(48, true);
      const gap =
        s.epoch !== previousEpoch ||
        s.simTimeS - previousTime > 1.5 / replay.manifest.recordHz ||
        r.view.getUint32(56, true) > 0;
      const p: ResponsePoint = {
        epoch: s.epoch,
        timeS: s.simTimeS,
        pilot: r.pilot[0]!,
        actuator:
          flags & RecordFlag.Actuator && r.controls.actuatorCount > 0
            ? r.controls.normalizedActuators[0]!
            : null,
        responseRadS: s.pRadS,
        gapBefore: gap,
      };
      if (!first) first = p;
      last = p;
      if (!minPilot || p.pilot < minPilot.pilot) {
        minPilot = p;
        minPi = i;
      }
      if (!maxPilot || p.pilot > maxPilot.pilot) {
        maxPilot = p;
        maxPi = i;
      }
      if (!minRate || p.responseRadS < minRate.responseRadS) {
        minRate = p;
        minRi = i;
      }
      if (!maxRate || p.responseRadS > maxRate.responseRadS) {
        maxRate = p;
        maxRi = i;
      }
      hasGap ||= gap;
      previousEpoch = s.epoch;
      previousTime = s.simTimeS;
    }
    if (first && last && minPilot && maxPilot && minRate && maxRate) {
      candidates.set(start, first);
      candidates.set(end - 1, last);
      candidates.set(minPi, minPilot);
      candidates.set(maxPi, maxPilot);
      candidates.set(minRi, minRate);
      candidates.set(maxRi, maxRate);
      // Conservatively break all reduced segments in a bin containing an omitted gap.
      for (const [, p] of [...candidates].sort((a, b) => a[0] - b[0]))
        out.push({ ...p, gapBefore: p.gapBefore || (hasGap && width > 1) });
    }
  }
  return out;
}
export function seriesPath(
  points: readonly ResponsePoint[],
  field: "pilot" | "actuator" | "responseRadS",
  epoch: number,
  width = 600,
  height = 100,
): string {
  const selected = points.filter((p) => p.epoch === epoch);
  if (!selected.length) return "";
  const start = selected[0]!.timeS,
    span = Math.max(0.001, selected[selected.length - 1]!.timeS - start);
  let path = "",
    connected = false;
  for (const p of selected) {
    const v = p[field];
    if (v === null) {
      connected = false;
      continue;
    }
    const x = ((p.timeS - start) / span) * width,
      y = height / 2 - (Math.max(-2, Math.min(2, v)) * height) / 4;
    path += `${connected && !p.gapBefore ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)} `;
    connected = true;
  }
  return path;
}
