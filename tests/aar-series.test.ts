import { expect, test } from "vitest";
import { newFlightStateV2, newActuatorFrameV2 } from "@mirage/protocol";
import { SnapshotReplay } from "../packages/aar/src/replay";
import { AarRecord } from "../packages/aar/src/record";
import { responseSeries, seriesPath } from "../apps/web/src/aar/series";
const m = {
  formatVersion: 1,
  recordBytes: 512,
  modelSha256: "a".repeat(64),
  firmwareSha256: null,
  seed: 7,
  physicsHz: 400,
  recordHz: 10,
  durationS: 1800,
  clock: "simulation",
  source: "producer",
};
test("known step-response lag, common time axis, absent actuators and explicit gaps", () => {
  const s = newFlightStateV2(),
    r = new AarRecord(),
    pilot = new Float64Array(4),
    act = newActuatorFrameV2(),
    bytes = new Uint8Array(10 * 512);
  act.actuatorCount = 1;
  for (let i = 0; i < 10; i++) {
    s.tickId.lo = i * 40;
    s.simTimeS = i / 10;
    pilot[0] = i >= 2 ? 1 : 0;
    act.normalizedActuators[0] = i >= 3 ? 1 : 0;
    s.pRadS = i >= 4 ? 1 : 0;
    r.encode(s, pilot, null, i === 6 ? null : act, 0, i === 7 ? 1 : 0);
    bytes.set(r.bytes, i * 512);
  }
  const p = responseSeries(new SnapshotReplay(m, bytes));
  expect(p.find((x) => x.pilot === 1)?.timeS).toBe(0.2);
  expect(p.find((x) => x.actuator === 1)?.timeS).toBe(0.3);
  expect(p.find((x) => x.responseRadS === 1)?.timeS).toBe(0.4);
  expect(p[6]?.actuator).toBeNull();
  expect(p[7]?.gapBefore).toBe(true);
  expect(seriesPath(p, "actuator", 0).split("M").length).toBe(3);
});
test("30 min chart decimation stays <=10000, keeps endpoints and narrow spikes", () => {
  const count = 18000,
    b = new Uint8Array(count * 512),
    r = new AarRecord(),
    s = newFlightStateV2(),
    p = new Float64Array(4);
  for (let i = 0; i < count; i++) {
    s.tickId.lo = i * 40;
    s.simTimeS = i / 10;
    s.pRadS = i === 9011 ? 2 : 0;
    r.encode(s, p, null, null);
    b.set(r.bytes, i * 512);
  }
  const points = responseSeries(new SnapshotReplay(m, b));
  expect(points.length).toBeLessThanOrEqual(10000);
  expect(points[0]?.timeS).toBe(0);
  expect(points.at(-1)?.timeS).toBe(1799.9);
  expect(points.some((p) => p.responseRadS === 2)).toBe(true);
});
