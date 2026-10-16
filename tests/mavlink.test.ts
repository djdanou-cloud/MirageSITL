import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  MavParser,
  encodeInto,
  definition,
} from "../packages/mavlink/src/codec";
import { SensorMapping } from "../packages/mavlink/src/sensor-mapping";
import { actuatorInto } from "../packages/mavlink/src/messages";
import golden from "./fixtures/mavlink/golden.json";
import lock from "../packages/mavlink/dialect.lock.json";
import { gpsSample } from "./sensor-samples";
it("matches every byte of official MAVLink2-generated frames, including extensions and truncation", () => {
  const output = new Uint8Array(280);
  let seq = 254;
  for (const f of golden.frames) {
    const d = definition(f.id);
    expect(d).not.toBeNull();
    if (!d) throw new Error("Missing definition");
    const payload = new Uint8Array(d.length);
    payload.set(Buffer.from(f.payloadHex, "hex"));
    const n = encodeInto(f.id, payload, seq, 42, 7, output);
    expect(Buffer.from(output.subarray(0, n)).toString("hex")).toBe(f.hex);
    seq = (seq + 1) % 256;
  }
  expect(lock.commit).toBe(golden.sourceCommit);
  expect(lock.generatorVersion).toBe("2.4.50");
  expect(
    createHash("sha256")
      .update(readFileSync("tests/fixtures/mavlink/golden.json"))
      .digest("hex"),
  ).toMatch(/^[a-f0-9]{64}$/);
});
it("parses arbitrary split/coalesced chunks, checks CRC, sequence wrap and recovers after a timeout", () => {
  let seen = 0;
  const parser = new MavParser((frame) => {
    expect(frame.systemId).toBe(42);
    seen++;
  });
  const bytes = Buffer.concat(
    golden.frames.map((f) => Buffer.from(f.hex, "hex")),
  );
  for (let i = 0; i < bytes.length; i++) parser.push(bytes.subarray(i, i + 1));
  expect(seen).toBe(5);
  expect(parser.sequenceGaps).toBe(0);
  expect(parser.outOfOrder).toBe(0);
  parser.push(bytes);
  expect(seen).toBe(10);
  const bad = Buffer.from(golden.frames[0]!.hex, "hex");
  bad[20] = bad[20]! ^ 1;
  parser.reset();
  parser.push(bad);
  expect(parser.badCrc).toBeGreaterThan(0);
  expect(seen).toBe(10);
  parser.discardPartial();
  parser.push(Buffer.from(golden.frames[1]!.hex, "hex"));
  expect(seen).toBe(11);
  parser.push(bytes.subarray(0, 5));
  expect(seen).toBe(11);
  parser.discardPartial();
  parser.push(bytes);
  expect(seen).toBe(16);
  const duplicate = Buffer.from(golden.frames[4]!.hex, "hex");
  parser.push(duplicate);
  expect(parser.duplicates).toBe(1);
  const signed = Buffer.from(golden.frames[0]!.hex, "hex");
  signed[2] = 1;
  parser.push(Buffer.concat([signed, Buffer.alloc(13)]));
  expect(parser.unsupported).toBeGreaterThan(0);
  expect(seen).toBe(17);
});
it("maps DOP, SI signs, gauss, hPa and u64 words without BigInt and clips instead of wrapping", () => {
  const m = new SensorMapping(),
    gps = gpsSample();
  gps.timeLoUs = 0xabcdef01;
  gps.timeHiUs = 0x12345678;
  gps.latitudeRad = (12.3456789 * Math.PI) / 180;
  gps.longitudeRad = (-179.9999999 * Math.PI) / 180;
  gps.altitudeMslM = 123.45;
  gps.vnMps = 3;
  gps.veMps = -4;
  gps.vdMps = 0.5;
  gps.courseRad = (123.45 * Math.PI) / 180;
  expect(m.gpsInto(gps)).toBe(true);
  const v = new DataView(m.gps.buffer);
  expect(v.getUint32(0, true)).toBe(0xabcdef01);
  expect(v.getUint32(4, true)).toBe(0x12345678);
  expect(v.getInt32(12, true)).toBe(-1799999999);
  expect(v.getUint16(20, true)).toBe(120);
  expect(v.getUint16(22, true)).toBe(230);
  expect(v.getInt16(28, true)).toBe(-400);
  expect(v.getInt16(30, true)).toBe(50);
  expect(v.getUint16(32, true)).toBe(12345);
  gps.vnMps = 1000;
  gps.hdop = 1000;
  expect(m.gpsInto(gps)).toBe(true);
  expect(v.getInt16(26, true)).toBe(32767);
  expect(v.getUint16(20, true)).toBe(65534);
  expect(m.clipped).toBe(true);
  gps.hdopValid = false;
  gps.vdopValid = false;
  gps.satellitesValid = false;
  gps.velocityValid = false;
  expect(m.gpsInto(gps)).toBe(true);
  for (const offset of [20, 22, 24, 32])
    expect(v.getUint16(offset, true)).toBe(65535);
  expect(v.getUint8(35)).toBe(255);
  expect(
    m.sensorInto({
      timeLoUs: 1,
      timeHiUs: 2,
      specificForceBodyMps2: new Float64Array([0, 0, -9.80665]),
      gyroBodyRadS: new Float64Array([0.1, 0.2, 0.3]),
      magBodyGauss: new Float64Array([0.2, -0.1, 0.4]),
      pressurePa: 101325,
      differentialPressurePa: 1200,
      pressureAltitudeM: 5,
      temperatureK: 293.15,
      updatedMask: 8191,
    }),
  ).toBe(true);
  const s = new DataView(m.sensor.buffer);
  expect(s.getFloat32(44, true)).toBe(1013.25);
  expect(s.getFloat32(48, true)).toBe(12);
  expect(s.getFloat32(56, true)).toBe(20);
  expect(s.getFloat32(32, true)).toBeCloseTo(0.2);
  expect(s.getUint32(60, true)).toBe(8191);
});
it("decodes actual actuator float32 frames and rejects invalid controls without mutating output", () => {
  const out = {
    timeLoUs: 0,
    timeHiUs: 0,
    flagsLo: 0,
    flagsHi: 0,
    mode: 0,
    controls: new Float64Array(16),
  };
  const parser = new MavParser((frame) => {
    expect(actuatorInto(frame, out)).toBe(true);
    frame.view.setFloat32(16, NaN, true);
    const copy = out.controls.slice();
    expect(actuatorInto(frame, out)).toBe(false);
    expect(out.controls).toEqual(copy);
  });
  parser.push(Buffer.from(golden.frames[2]!.hex, "hex"));
  expect(out.mode).toBe(128);
  expect(out.controls[15]).toBe(15 / 16);
  expect(out.flagsLo).toBe(1);
});
it("resets framing before invoking a callback that may reject a decoded record", () => {
  let seen = 0;
  const parser = new MavParser(() => {
    if (++seen === 1) throw new Error("Consumer failed");
  });
  const bytes = Buffer.from(golden.frames[0]!.hex, "hex");
  expect(() => parser.push(bytes)).toThrow("Consumer failed");
  parser.push(bytes);
  expect(seen).toBe(2);
});
