import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  MavParser,
  encodeInto,
  definition,
  newMavFrame,
} from "../packages/mavlink/src/codec";
import { SensorMapping } from "../packages/mavlink/src/sensor-mapping";
import { MessagePayload, parameterListInto, parameterReadInto, parameterSetInto, actuatorInto } from "../packages/mavlink/src/messages";
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
    golden.frames.slice(0, 5).map((f) => Buffer.from(f.hex, "hex")),
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

it("admits every Phase 1 golden ID and keeps the dialect lock complete", () => {
  expect(lock.messages).toEqual([...new Set(golden.frames.map((f) => f.id))].sort((a, b) => a - b));
  for (const f of golden.frames) {
    const d = definition(f.id);
    expect(d, `Missing ID ${f.id}`).not.toBeNull();
    if (!d) throw new Error("Missing definition");
    const wire = Buffer.from(f.hex, "hex");
    const payload = new Uint8Array(d.length);
    payload.set(Buffer.from(f.payloadHex, "hex"));
    const out = new Uint8Array(280);
    const size = encodeInto(f.id, payload, wire[4]!, 42, 7, out);
    expect(out.subarray(0, size)).toEqual(new Uint8Array(wire));
  }
});

it("packs named field arrays and decodes every field against independent pymavlink values", () => {
  for (const f of golden.frames) {
    if (!("values" in f) || !f.values) continue;
    const fields: unknown = f.values;
    if (!isNumericFields(fields)) throw new Error("Invalid oracle values");
    const payload = new MessagePayload(f.id);
    const decoded = new MessagePayload(f.id);
    for (const [name, expected] of Object.entries(fields)) {
      payload.field(name).set(expected);
      decoded.field(name).fill(123456);
    }
    expect(payload.pack(), `${f.id} ${f.variant}`).toBe(true);
    const wire = Buffer.from(f.hex, "hex");
    const out = new Uint8Array(280);
    const size = encodeInto(f.id, payload.payload, wire[4]!, 42, 7, out);
    expect(out.subarray(0, size), `${f.id} ${f.variant}`).toEqual(new Uint8Array(wire));
    const parser = new MavParser((frame) => expect(decoded.decode(frame)).toBe(true));
    parser.push(wire);
    expect(parser.frames).toBe(1);
    for (const [name, expected] of Object.entries(fields)) {
      const field = decoded.definition.fields.find((field) => field.name === name);
      const oracle = field?.type === "float" ? expected.map(Math.fround) : expected;
      expect(Array.from(decoded.field(name)), `${f.id}.${name} ${f.variant}`).toEqual(oracle);
    }
  }
});

it("covers each locked field exactly once within the pinned payload length", () => {
  const actual = [];
  for (let id = 0; id <= 0xffff; id++) if (definition(id)) actual.push(id);
  expect(actual).toEqual(lock.messages);
  for (const id of actual) {
    const d = definition(id)!; // The enumeration above admits only known IDs.
    const occupied = new Uint8Array(d.length);
    for (const field of d.fields) {
      const size = field.type === "double" ? 8 : field.type === "float" ? 4 :
        field.type === "char" || field.type === "uint8_t_mavlink_version" ? 1 : Number(field.type.match(/\d+/)?.[0]) / 8;
      expect(Number.isInteger(size)).toBe(true);
      for (let i = field.offset; i < field.offset + field.count * size; i++) {
        expect(i).toBeLessThan(d.length);
        expect(occupied[i]).toBe(0);
        occupied[i] = 1;
      }
    }
    expect(Array.from(occupied)).toEqual(Array(d.length).fill(1));
  }
});

it("handles every split point, timeout, CRC rejection and zero-extension reuse for every ID", () => {
  for (const f of golden.frames) {
    const bytes = Buffer.from(f.hex, "hex");
    const decoded = new MessagePayload(f.id);
    const parser = new MavParser((frame) => expect(decoded.decode(frame)).toBe(true));
    for (let split = 1; split < bytes.length; split++) {
      parser.reset();
      const before = parser.frames;
      parser.push(bytes.subarray(0, split));
      expect(parser.frames).toBe(before);
      parser.push(bytes.subarray(split));
      expect(parser.frames).toBe(before + 1);
    }
    parser.reset();
    const before = parser.frames;
    parser.push(bytes.subarray(0, -1));
    expect(parser.frames).toBe(before);
    parser.discardPartial();
    parser.push(bytes);
    expect(parser.frames).toBe(before + 1);
    const bad = Buffer.from(bytes);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    parser.push(bad);
    expect(parser.badCrc).toBeGreaterThan(0);
    expect(parser.frames).toBe(before + 1);
    parser.discardPartial();
    parser.push(bytes);
    expect(parser.frames).toBe(before + 2);
  }
});

it("rejects invalid field values without changing packed bytes and retains full-width IDs", () => {
  const payload = new MessagePayload(23);
  expect(parameterSetInto(payload, 1, 1, "ABCDEFGHIJKLMNOP", 12.5, 9)).toBe(true);
  const bytes = payload.payload.slice();
  for (const value of [-1, 256, 1.5, NaN, Infinity]) {
    payload.field("target_system")[0] = value;
    expect(payload.pack()).toBe(false);
    expect(payload.payload).toEqual(bytes);
  }
  payload.field("target_system")[0] = 1;
  payload.field("param_value")[0] = Number.MAX_VALUE;
  expect(payload.pack()).toBe(false);
  expect(payload.payload).toEqual(bytes);
  expect(parameterSetInto(payload, 1, 1, "ABCDEFGHIJKLMNOPQ", 1, 9)).toBe(false);
  expect(parameterSetInto(payload, 1, 1, "P\u0410\u0420\u0410\u041c", 1, 9)).toBe(false);
  expect(parameterSetInto(payload, 1, 1, "A\0B", 1, 9)).toBe(false);
  expect(parameterSetInto(payload, 1, 1, "", 1, 9)).toBe(false);
  expect(payload.payload).toEqual(bytes);
  expect(parameterSetInto(payload, 1, 1, "P", 1, 9)).toBe(true);
  expect(Array.from(payload.field("param_id").subarray(1))).toEqual(Array(15).fill(0));
  expect(() => payload.field("wrong_field")).toThrow("Unknown MAVLink field");
  expect(() => new MessagePayload(99999)).toThrow("Unsupported MAVLink message ID");
  const short = newMavFrame();
  short.id = 30;
  short.view = new DataView(new ArrayBuffer(1));
  const attitude = new MessagePayload(30);
  attitude.field("roll")[0] = 2.5;
  expect(attitude.decode(short)).toBe(false);
  expect(attitude.field("roll")[0]).toBe(2.5);
  short.id = 32;
  expect(attitude.decode(short)).toBe(false);
});

it("builds parameter requests and preserves IEEE unknown-value sentinels", () => {
  const list = new MessagePayload(21);
  expect(parameterListInto(list, 1, 0)).toBe(true);
  expect(Array.from(list.payload)).toEqual([1, 0]);
  expect(parameterListInto(list, 0, 1)).toBe(false);
  const read = new MessagePayload(20);
  expect(parameterReadInto(read, 1, 1, "MOT_THST_EXPO")).toBe(true);
  expect(new DataView(read.payload.buffer).getInt16(0, true)).toBe(-1);
  expect(parameterReadInto(read, 1, 1, "", 42)).toBe(true);
  expect(new DataView(read.payload.buffer).getInt16(0, true)).toBe(42);
  expect(parameterReadInto(read, 1, 1, "", -1)).toBe(false);
  expect(parameterReadInto(list, 1, 1, "P")).toBe(false);
  expect(parameterSetInto(list, 1, 1, "P", 1, 9)).toBe(false);
  const command = new MessagePayload(76);
  command.field("param5")[0] = NaN;
  expect(command.pack()).toBe(true);
  const wire = new Uint8Array(280);
  const size = encodeInto(76, command.payload, 0, 42, 7, wire);
  const decoded = new MessagePayload(76);
  const parser = new MavParser((frame) => expect(decoded.decode(frame)).toBe(true));
  parser.push(wire.subarray(0, size));
  expect(decoded.field("param5")[0]).toBeNaN();
});

it("consumes unsupported and signed envelopes whole even with a valid frame embedded", () => {
  const known = Buffer.from(golden.frames[1]!.hex, "hex");
  const envelopes: readonly (readonly [number, number, number])[] = [[60000, 0, 0], [107, 1, 0], [107, 2, 0], [107, 0, 1]];
  for (const [id, incompatibility, compatibility] of envelopes) {
    // A signature is 13 extra bytes; none of its contents can become a new frame.
    const envelope = new Uint8Array(known.length + 12 + (incompatibility & 1 ? 13 : 0));
    envelope.set([253, known.length, incompatibility, compatibility, 0, 42, 7, id & 255, id >>> 8, 0]);
    envelope.set(known, 10);
    let seen = 0;
    const parser = new MavParser(() => seen++);
    parser.push(envelope);
    expect(seen).toBe(0);
    expect(parser.unsupported).toBe(1);
    parser.push(known);
    expect(seen).toBe(1);
  }
});

it("clears stale extension fields when reusing telemetry targets", () => {
  for (const id of lock.messages) {
    const decoded = new MessagePayload(id);
    const parser = new MavParser((frame) => expect(decoded.decode(frame)).toBe(true));
    for (const variant of ["distinct", "zero"]) {
      const fixture = golden.frames.find((f) => f.id === id && "variant" in f && f.variant === variant);
      if (!fixture || !("values" in fixture) || !fixture.values) throw new Error("Missing fixture");
      parser.push(Buffer.from(fixture.hex, "hex"));
      const fields: unknown = fixture.values;
      if (!isNumericFields(fields)) throw new Error("Invalid oracle values");
      for (const [name, value] of Object.entries(fields)) {
        expect(Array.from(decoded.field(name)), `${id}.${name} ${variant}`).toEqual(value);
      }
    }
  }
});


it("measures the real high-rate payload path with an allocating positive control", () => {
  const directory = mkdtempSync(join(tmpdir(), "mirage-mavlink-g1-"));
  try {
    const path = join(directory, "allocation.json");
    const result = spawnSync(process.execPath, ["scripts/check-mavlink-allocation.mjs", "--out", path], { encoding: "utf8" });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const report: unknown = JSON.parse(readFileSync(path, "utf8"));
    expect(report).toMatchObject({ zeroAllocation: true, controlDetected: true, received: 13000000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120000);


function isNumericFields(value: unknown): value is Record<string, number[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry: unknown) =>
    Array.isArray(entry) && entry.every((item: unknown) => typeof item === "number"));
}

it("matches the named parameter helpers to independent generated requests", () => {
  for (const id of [20, 21, 23]) {
    const payload = new MessagePayload(id);
    const valid = id === 20 ? parameterReadInto(payload, 1, 1, "MOT_THST_EXPO") :
      id === 21 ? parameterListInto(payload, 1, 0) :
      parameterSetInto(payload, 1, 1, "ABCDEFGHIJKLMNOP", 12.5, 9);
    expect(valid).toBe(true);
    const fixture = golden.frames.find((frame) => frame.id === id && "variant" in frame && frame.variant === "parameter-builder");
    if (!fixture) throw new Error("Missing parameter oracle");
    const expected = Buffer.from(fixture.hex, "hex");
    const out = new Uint8Array(280);
    const size = encodeInto(id, payload.payload, expected[4]!, 42, 7, out);
    expect(out.subarray(0, size)).toEqual(new Uint8Array(expected));
  }
});

it("rejects out-of-range integers in every named field before changing any payload byte", () => {
  for (const id of lock.messages) {
    const payload = new MessagePayload(id);
    expect(payload.pack()).toBe(true);
    const initial = payload.payload.slice();
    for (const field of payload.definition.fields) {
      if (field.type === "float" || field.type === "double") continue;
      const signed = field.type.startsWith("int") && field.type !== "int64_t";
      const bits = field.type === "char" || field.type === "uint8_t_mavlink_version" ? 8 :
        field.type.endsWith("64_t") ? 32 : Number(field.type.match(/\d+/)?.[0]);
      const minimum = signed ? -(2 ** (bits - 1)) : 0;
      const maximum = 2 ** (signed ? bits - 1 : bits) - 1;
      const values = payload.field(field.name);
      for (const invalid of [minimum - 1, maximum + 1, 0.5, NaN, Infinity]) {
        values[values.length - 1] = invalid;
        expect(payload.pack(), `${id}.${field.name} ${invalid}`).toBe(false);
        expect(payload.payload).toEqual(initial);
      }
      values.fill(0);
    }
  }
});
