import { expect, test } from "vitest";
import { newFlightStateV2 } from "@mirage/protocol";
import { parseManifest, recordCrc } from "../packages/aar/src/format";
import { AarRecord } from "../packages/aar/src/record";
import { RecordingRing } from "../packages/aar/src/recorder";
import {
  RecordingHandoff,
  createRecordingQueue,
  HANDOFF_CAPACITY,
} from "../packages/aar/src/handoff";
export const manifest = {
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
test("ISO-HDLC check vector and record roundtrip with strict frame bounds", () => {
  expect(recordCrc(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  const r = new AarRecord(),
    s = newFlightStateV2();
  s.epoch = 2;
  s.tickId.lo = 40;
  s.simTimeS = 0.1;
  expect(
    r.encode(
      s,
      new Float64Array([0.25, -0.5, 1, 0.75]),
      null,
      null,
      3,
      9,
      true,
    ),
  ).toBe(true);
  expect(r.decode()).toBe(true);
  expect(r.state).toEqual(s);
  expect(Array.from(r.pilot)).toEqual([0.25, -0.5, 1, 0.75]);
  expect(r.view.getUint32(56, true)).toBe(9);
  r.bytes[100]! ^= 1;
  expect(r.decode()).toBe(false);
  expect(r.encode(s, new Float64Array([0, 0, 0, NaN]), null, null)).toBe(false);
});
test("separate SPSC preserves ordering, full-queue losses and uint32 wrap", () => {
  const q = createRecordingQueue(),
    p = new RecordingHandoff(q),
    c = new RecordingHandoff(q),
    a = new Int32Array(128),
    out = new Int32Array(128);
  const w = new Int32Array(q);
  Atomics.store(w, 2, -2);
  Atomics.store(w, 3, -2);
  for (let i = 0; i < HANDOFF_CAPACITY; i++) {
    a[0] = i;
    expect(p.push(a)).toBe(true);
  }
  expect(p.push(a)).toBe(false);
  expect(p.lost).toBe(1);
  for (let i = 0; i < HANDOFF_CAPACITY; i++) {
    expect(c.pop(out)).toBe(true);
    expect(out[0]).toBe(i);
  }
  expect(c.pop(out)).toBe(false);
});
test("30 minute ring has fixed allocation, chronological overwrite and rejection", () => {
  const ring = new RecordingRing(manifest);
  expect(ring.bytes.byteLength).toBe(1800 * 10 * 512);
  const small = new RecordingRing({ ...manifest, durationS: 1, recordHz: 2 }),
    r = new AarRecord(),
    s = newFlightStateV2(),
    input = new Float64Array(4);
  for (let i = 0; i < 5; i++) {
    s.tickId.lo = i;
    s.simTimeS = i / 400;
    r.encode(s, input, null, null);
    small.append(r.bytes);
  }
  expect(small.evicted).toBe(3);
  expect(small.count).toBe(2);
  expect(small.bytes.length).toBe(1024);
  const snap = small.snapshot();
  r.bytes.set(snap.subarray(0, 512));
  expect(r.decode()).toBe(true);
  expect(r.state.tickId.lo).toBe(3);
  r.bytes[0] = 0;
  expect(small.append(r.bytes)).toBe(false);
  expect(small.invalid).toBe(1);
  expect(() => parseManifest({ ...manifest, token: "secret" })).toThrow();
  expect(() => parseManifest({ ...manifest, recordHz: 1200 })).toThrow();
});

test("a rejected shared-state seqlock cannot poison a later encoded record", () => {
  const r = new AarRecord(),
    s = newFlightStateV2(),
    p = new Float64Array(4);
  r.encode(s, p, null, null);
  r.words[16] = 1;
  r.view.setUint32(60, recordCrc(r.bytes), true);
  expect(r.decode()).toBe(false);
  expect(r.encode(s, p, null, null)).toBe(true);
  expect(r.decode()).toBe(true);
  expect(r.encode(s, new Float64Array(r.bytes.buffer, 32, 4), null, null)).toBe(
    false,
  );
});

test("records all independent streams with exact offsets and rejects a nested epoch mismatch", async () => {
  const { newSensorFrameV2, newActuatorFrameV2 } = await import(
    "@mirage/protocol"
  );
  const r = new AarRecord(),
    s = newFlightStateV2(),
    sensor = newSensorFrameV2(),
    actuator = newActuatorFrameV2();
  s.epoch = sensor.epoch = actuator.epoch = 1;
  s.northM = 1.25;
  sensor.kind = 1;
  sensor.valueCount = 6;
  sensor.values[0] = 2.5;
  actuator.actuatorCount = 2;
  actuator.normalizedActuators.set([0.25, -0.5]);
  expect(r.encode(s, new Float64Array(4), sensor, actuator)).toBe(true);
  expect(r.decode()).toBe(true);
  expect(r.view.getFloat64(88, true)).toBe(1.25);
  expect(r.view.getFloat32(288, true)).toBe(2.5);
  expect(r.view.getFloat32(416, true)).toBe(0.25);
  expect(r.observation.values[0]).toBe(2.5);
  expect(r.controls.normalizedActuators[1]).toBe(-0.5);
  expect(sensor.values[0]).toBe(2.5);
  r.view.setUint32(260, 2, true);
  r.view.setUint32(60, recordCrc(r.bytes), true);
  expect(r.decode()).toBe(false);
});
