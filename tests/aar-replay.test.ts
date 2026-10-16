import { expect, test } from "vitest";
import { newFlightStateV2 } from "@mirage/protocol";
import { SnapshotReplay } from "../packages/aar/src/replay";
import { AarRecord } from "../packages/aar/src/record";
import { compareResimulation } from "../packages/aar/src/resimulation";
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
  source: "demo-decimated",
};
function samples() {
  const b = new Uint8Array(512 * 4),
    r = new AarRecord(),
    s = newFlightStateV2(),
    p = new Float64Array(4);
  for (let i = 0; i < 4; i++) {
    s.epoch = i < 2 ? 1 : 2;
    s.tickId.lo = (i % 2) * 40;
    s.simTimeS = (i % 2) * 0.1;
    s.northM = i;
    r.encode(s, p, null, null);
    b.set(r.bytes, i * 512);
  }
  return b;
}
test("seek preserves epoch discontinuities, immutable source and checksum validation", () => {
  const b = samples(),
    p = new SnapshotReplay(m, b),
    r = new AarRecord();
  b.fill(0);
  expect(p.seek(1, 0.05, r)).toBe(0);
  expect(r.state.northM).toBe(0);
  expect(p.seek(2, 0.1, r)).toBe(3);
  expect(r.state.northM).toBe(3);
  expect(p.seek(9, 100, r)).toBe(-1);
  expect(p.seek(1, -1, r)).toBe(-1);
  expect(() => new SnapshotReplay(m, b)).toThrow();
  expect(() => new SnapshotReplay(m, samples(), "b".repeat(64))).toThrow();
});
test("resimulation requires configuration identity and reports mismatch without rewriting records", () => {
  const b = samples(),
    original = b.slice(),
    p = new SnapshotReplay(m, b);
  const backend = {
    modelSha256: m.modelSha256,
    firmwareSha256: null,
    seed: 7,
    reset: () => true,
    sample: (r: AarRecord) => ({
      ...r.state,
      northM: r.state.northM + 1,
      qw: -r.state.qw,
    }),
  };
  expect(compareResimulation(p, backend, 0.5, 0.01)).toMatchObject({
    compared: 4,
    mismatches: 4,
    maxPositionErrorM: 1,
    maxAttitudeErrorRad: 0,
    status: "FAIL",
  });
  expect(b).toEqual(original);
  expect(() =>
    compareResimulation(p, { ...backend, seed: 8 }, 0.5, 0.01),
  ).toThrow();
});

test("multiple sensor observations at one physics tick remain separate records", async () => {
  const { newSensorFrameV2 } = await import("@mirage/protocol");
  const s = newFlightStateV2(),
    r = new AarRecord(),
    imu = newSensorFrameV2(),
    mag = newSensorFrameV2(),
    p = new Float64Array(4),
    b = new Uint8Array(1024);
  imu.kind = 1;
  imu.valueCount = 6;
  imu.values[0] = 2.5;
  mag.kind = 3;
  mag.valueCount = 3;
  mag.values[0] = 0.25;
  r.encode(s, p, imu, null);
  b.set(r.bytes);
  r.encode(s, p, mag, null);
  b.set(r.bytes, 512);
  const replay = new SnapshotReplay(m, b);
  expect(replay.count).toBe(2);
  replay.read(0, r);
  expect(r.observation.kind).toBe(1);
  replay.read(1, r);
  expect(r.observation.kind).toBe(3);
});
