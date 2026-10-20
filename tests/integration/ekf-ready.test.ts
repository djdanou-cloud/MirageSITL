import { expect, test } from "vitest";
import { LiveEkfWarmup } from "../../packages/autopilot/src/live-warmup";
import { MavParser, definition, encodeInto } from "../../packages/mavlink/src/codec";
import health from "../fixtures/mavlink/ekf-golden.json";
import sensors from "../fixtures/mavlink/warmup-sensors.json";

function readyGate() {
  const gate = new LiveEkfWarmup("external-sitl", 2, 0, 0, 2);
  for (const frame of [...health.frames, ...sensors.frames])
    gate.ingest(Uint8Array.from(Buffer.from(frame.hex, "hex")), 30);
  return gate;
}

function wire(id: number, timeS = 30, systemId = 1, mutate?: (view: DataView) => void): Uint8Array {
  const source = [...health.frames, ...sensors.frames].find(f => f.id === id);
  const d = definition(id);
  if (!source || !d) throw new Error("Missing independent wire source");
  const bytes = Buffer.from(source.hex, "hex"), payload = new Uint8Array(d.length);
  payload.set(bytes.subarray(10, 10 + bytes.readUInt8(1)));
  const view = new DataView(payload.buffer);
  if (id === 24 || id === 27 || id === 105) {
    view.setUint32(0, timeS * 1e6, true);
    view.setUint32(4, 0, true);
  }
  mutate?.(view);
  const output = new Uint8Array(280);
  const n = encodeInto(id, payload, 25, systemId, 1, output);
  if (!n) throw new Error("Fault-probe encoding failed");
  return output.slice(0, n);
}

test("matches independent sensor frames and requires actual sensor clocks and EKF health", () => {
  for (const frame of sensors.frames) {
    const d = definition(frame.id);
    expect(d).toMatchObject({ crcExtra: frame.crcExtra, length: frame.length });
    let seen = 0;
    const parser = new MavParser((f) => {
      seen++;
      const payload = f.payload.slice(0, frame.length);
      const output = new Uint8Array(280);
      const n = encodeInto(frame.id, payload, f.sequence, 1, 1, output);
      expect(Buffer.from(output.subarray(0, n)).toString("hex")).toBe(frame.hex);
    });
    parser.push(Uint8Array.from(Buffer.from(frame.hex, "hex")));
    expect(seen).toBe(1);
  }
  const gate = readyGate();
  expect(gate.observe(30, 15000)).toBe(true);
  expect(gate.warmup.accelerationFactor).toBe(2);
  expect(gate.warmup.ewAllowed).toBe(true);
  expect(gate.imuTimeS).toBe(30);
  expect(gate.gpsTimeS).toBe(30);
  expect(gate.observe(30.02, 15010)).toBe(false);
  expect(gate.warmup.ewAllowed).toBe(false);
});

test("timer, wrong identity, missing sensors and CRC-corrupted sensors never create READY", () => {
  const gate = new LiveEkfWarmup("external-sitl", 2, 0, 0, 2);
  for (const frame of health.frames) gate.ingest(Uint8Array.from(Buffer.from(frame.hex, "hex")), 30);
  expect(gate.observe(30, 15000)).toBe(false);
  for (const frame of sensors.frames) {
    const bytes = Uint8Array.from(Buffer.from(frame.hex, "hex"));
    bytes[15] = (bytes[15] ?? 0) ^ 1;
    gate.ingest(bytes, 30);
  }
  expect(gate.observe(30, 15000)).toBe(false);
  expect(gate.parser.badCrc).toBeGreaterThan(0);
  const wrong = new LiveEkfWarmup("external-sitl", 2, 0, 0, 2);
  for (const id of [0, 193, 24, 27]) wrong.ingest(wire(id, 30, 2), 30);
  expect(wrong.observe(30, 15000)).toBe(false);
  expect(() => new LiveEkfWarmup("hitl", 2, 0, 0, 2)).toThrow();
});

test("revokes READY for stale diagnostics despite fresh sensors and for failed innovations", () => {
  const gate = readyGate();
  expect(gate.observe(30, 15000)).toBe(true);
  gate.ingest(wire(27, 32), 32);
  gate.ingest(wire(24, 32), 32);
  expect(gate.observe(32, 16000)).toBe(false);
  expect(gate.warmup.ewAllowed).toBe(false);
  gate.ingest(wire(0), 32);
  gate.ingest(wire(193, 30, 1, view => view.setFloat32(0, 1, true)), 32);
  expect(gate.observe(32, 16000)).toBe(false);
  gate.ingest(wire(193), 32);
  expect(gate.observe(32, 16000)).toBe(true);
});

test("rejects future or old sensor stamps and lost GNSS fix without weakening age limits", () => {
  for (const [id, timeS] of [[27, 31], [24, 31], [27, 29.98], [24, 29.6]]) {
    const gate = new LiveEkfWarmup("external-sitl", 2, 0, 0, 2);
    for (const frame of health.frames) gate.ingest(Uint8Array.from(Buffer.from(frame.hex, "hex")), 30);
    gate.ingest(wire(27, id === 27 ? timeS : 30), 30);
    gate.ingest(wire(24, id === 24 ? timeS : 30), 30);
    expect(gate.observe(30, 15000)).toBe(false);
  }
  const gate = readyGate();
  expect(gate.observe(30, 15000)).toBe(true);
  gate.ingest(wire(24, 30, 1, view => view.setUint8(28, 1)), 30);
  expect(gate.observe(30, 15000)).toBe(false);
});

test("revokes on session disposal or clock reversal and refuses observed HITL fast-forward", () => {
  const gate = readyGate();
  expect(gate.observe(30, 15000)).toBe(true);
  expect(gate.observe(29, 15000)).toBe(false);
  expect(gate.ingest(wire(27), 29)).toBe(false);
  gate.dispose();
  expect(gate.observe(30, 15000)).toBe(false);
  expect(gate.warmup.ewAllowed).toBe(false);
  const hitl = new LiveEkfWarmup("hitl", 2, 0, 0, 1);
  for (const frame of [...health.frames, ...sensors.frames]) hitl.ingest(Uint8Array.from(Buffer.from(frame.hex, "hex")), 30);
  expect(hitl.observe(30, 15000)).toBe(false);
  expect(hitl.warmup.reason).toContain("HITL clock");
});

test("external JSON clock requires causal contiguous acknowledgments of encoded prior samples", () => {
  const gate = new LiveEkfWarmup("external-sitl", 2, 0, 0, 2, { imuSource: "json-lockstep" });
  for (const frame of health.frames) gate.ingest(Uint8Array.from(Buffer.from(frame.hex, "hex")), 30);
  gate.ingest(wire(24), 30);
  expect(gate.observe(30, 15000)).toBe(false);
  expect(gate.acknowledgeJsonImu(24000, 23999, 29.99875)).toBe(true);
  expect(gate.observe(30, 15000)).toBe(true);
  expect(gate.imuTimeS).toBe(29.99875);
  expect(gate.reportedImuTimeS).toBe(-1);
  expect(gate.acknowledgeJsonImu(24002, 24000, 30)).toBe(false);
  expect(gate.observe(30, 15000)).toBe(false);
  expect(gate.warmup.ewAllowed).toBe(false);
  expect(gate.acknowledgeJsonImu(24001, 24000, 30)).toBe(true);
  expect(gate.observe(30, 15000)).toBe(true);
  expect(() => new LiveEkfWarmup("hitl", 2, 0, 0, 1, { imuSource: "json-lockstep" })).toThrow();
});
