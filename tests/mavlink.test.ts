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

// TASK-150: the Phase 1 message set against pymavlink 2.4.50 goldens (scripts/generate-mavlink-fixtures.py).
import { MESSAGE_TABLE, HIGH_RATE_MESSAGES } from "../packages/mavlink/src/message-table";
import {
  packInto, fieldOf, readNumber, readText,
  newAttitude, attitudeInto, newLocalPositionNed, localPositionNedInto, newGlobalPositionInt, globalPositionIntInto,
  newVfrHud, vfrHudInto, newServoOutputRaw, servoOutputRawInto, newSysStatus, sysStatusInto, newBatteryStatus, batteryStatusInto,
} from "../packages/mavlink/src/messages";
import type { MavFrame } from "../packages/mavlink/src/codec";

type GoldenValues = Record<string, number | string | number[]>;
interface GoldenMessageFrame { id: number; name: string; style: string; sequence: number; values: GoldenValues; hex: string }
/** The fixture's message frames, validated from unknown JSON. */
function goldenMessageFrames(value: unknown): GoldenMessageFrame[] {
  if (typeof value !== "object" || value === null || !("messageFrames" in value) || !Array.isArray(value.messageFrames))
    throw new Error("Invalid golden fixture");
  return value.messageFrames.map((frame: unknown) => {
    if (typeof frame !== "object" || frame === null) throw new Error("Invalid golden frame");
    const f: Record<string, unknown> = Object.fromEntries(Object.entries(frame));
    const values: GoldenValues = {};
    if (typeof f.values !== "object" || f.values === null) throw new Error("Invalid golden values");
    for (const [name, v] of Object.entries(f.values)) {
      if (typeof v === "number" || typeof v === "string") values[name] = v;
      else if (Array.isArray(v) && v.every((x): x is number => typeof x === "number")) values[name] = v;
      else throw new Error(`Invalid golden value ${name}`);
    }
    if (typeof f.id !== "number" || typeof f.name !== "string" || typeof f.style !== "string" || typeof f.sequence !== "number" || typeof f.hex !== "string")
      throw new Error("Invalid golden frame fields");
    return { id: f.id, name: f.name, style: f.style, sequence: f.sequence, values, hex: f.hex };
  });
}
const messageFrames = goldenMessageFrames(JSON.parse(readFileSync("tests/fixtures/mavlink/golden.json", "utf8")));
/** The value a field holds on the wire: float32 rounding for float fields. */
function wireValue(id: number, name: string, value: number): number {
  return fieldOf(id, name)?.type === "float" ? Math.fround(value) : value;
}

it("keeps the dialect lock, the generated table and the codec in agreement", () => {
  const ids = MESSAGE_TABLE.map((m) => m.id);
  expect(lock.messages).toEqual(ids);
  expect(lock.highRateMessages).toEqual([...HIGH_RATE_MESSAGES]);
  expect(lock.dialect).toBe("message_definitions/v1.0/ardupilotmega.xml");
  for (const m of MESSAGE_TABLE) {
    expect(definition(m.id)).toBe(m);
    // Every field lies inside the payload and no two fields overlap.
    const used = new Uint8Array(m.length);
    for (const f of m.fields) {
      const size = { uint8_t: 1, int8_t: 1, char: 1, uint16_t: 2, int16_t: 2, uint32_t: 4, int32_t: 4, float: 4, uint64_t: 8, int64_t: 8, double: 8 }[f.type];
      for (let b = f.offset; b < f.offset + size * Math.max(1, f.count); b++) { expect(used[b]).toBe(0); used[b] = 1; }
    }
    expect(used.every((b) => b === 1)).toBe(true);
  }
  // The 12 definitions before TASK-150 are unchanged.
  for (const [id, crcExtra, length] of [[0, 50, 9], [20, 214, 20], [22, 220, 25], [23, 168, 23], [24, 24, 52], [27, 144, 29], [70, 124, 38],
    [93, 47, 81], [105, 93, 63], [107, 108, 65], [113, 124, 39], [193, 71, 26]] as const)
    expect(definition(id)).toMatchObject({ crcExtra, length });
  expect(definition(9999)).toBeNull();
});

it("packs every golden message byte for byte from its field values, including extensions and truncation", () => {
  const out = new Uint8Array(280);
  expect(messageFrames.length).toBe(MESSAGE_TABLE.length * 2);
  for (const f of messageFrames) {
    const d = definition(f.id);
    if (!d) throw new Error(`Missing ${f.name}`);
    const payload = new Uint8Array(d.length);
    expect(packInto(f.id, f.values, payload), `${f.name} ${f.style}`).toBe(true);
    const n = encodeInto(f.id, payload, f.sequence, golden.systemId, golden.componentId, out);
    expect(Buffer.from(out.subarray(0, n)).toString("hex"), `${f.name} ${f.style}`).toBe(f.hex);
  }
});

it("decodes every golden message to the values pymavlink packed, from chunked input", () => {
  const decoded: { id: number; values: GoldenValues }[] = [];
  const parser = new MavParser((frame: MavFrame) => {
    const d = definition(frame.id);
    if (!d) throw new Error("Unexpected frame");
    const values: GoldenValues = {};
    for (const f of d.fields) {
      if (f.type === "char") values[f.name] = readText(frame.payload, f);
      else if (f.count) values[f.name] = Array.from({ length: f.count }, (_, i) => readNumber(frame.view, f, i));
      else values[f.name] = readNumber(frame.view, f);
    }
    decoded.push({ id: frame.id, values });
  });
  const bytes = Buffer.concat(messageFrames.map((f) => Buffer.from(f.hex, "hex")));
  for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));
  expect(parser.badCrc + parser.unsupported).toBe(0);
  expect(decoded.length).toBe(messageFrames.length);
  decoded.forEach((d, k) => {
    const want = messageFrames[k]!;
    expect(d.id).toBe(want.id);
    for (const [name, value] of Object.entries(want.values)) {
      if (typeof value === "string") expect(d.values[name], name).toBe(value);
      else if (Array.isArray(value)) expect(d.values[name], name).toEqual(value.map((v) => wireValue(want.id, name, v)));
      else expect(d.values[name], `${want.name}.${name}`).toBe(wireValue(want.id, name, value));
    }
  });
});

it("rejects invalid builder input and leaves the payload unchanged", () => {
  const payload = new Uint8Array(definition(76)!.length).fill(0xa5);
  const before = payload.slice();
  const command = { target_system: 1, target_component: 1, command: 400, confirmation: 0, param1: 1, param2: 0, param3: 0, param4: 0, param5: 0, param6: 0, param7: 0 };
  for (const bad of [
    { ...command, unknown_field: 1 }, { ...command, command: 70000 }, { ...command, target_system: -1 }, { ...command, target_system: 1.5 },
    { ...command, param1: Number.NaN }, { ...command, param1: 1e39 }, { ...command, param1: "1" },
  ]) expect(packInto(76, bad, payload)).toBe(false);
  expect(payload).toEqual(before);
  expect(packInto(76, command, new Uint8Array(10))).toBe(false);
  expect(packInto(9999, {}, payload)).toBe(false);
  const text = new Uint8Array(definition(253)!.length);
  expect(packInto(253, { severity: 6, text: "x".repeat(51) }, text)).toBe(false);
  expect(packInto(253, { severity: 6, text: "café" }, text)).toBe(false);
  expect(packInto(253, { severity: 6, text: "x".repeat(50) }, text)).toBe(true);
  const servo = new Uint8Array(definition(36)!.length);
  expect(packInto(147, { voltages: [1, 2] }, new Uint8Array(definition(147)!.length))).toBe(false);
  expect(packInto(36, { servo16_raw: 1900 }, servo)).toBe(true);
  expect(readNumber(new DataView(servo.buffer), fieldOf(36, "servo16_raw")!)).toBe(1900);
  // A command packs with every unset field zero.
  const long = new Uint8Array(definition(76)!.length);
  expect(packInto(76, { command: 400, param1: 1 }, long)).toBe(true);
  expect(readNumber(new DataView(long.buffer), fieldOf(76, "command")!)).toBe(400);
});

it("decodes the high-rate telemetry subset into preallocated targets and refuses other frames", () => {
  const attitude = newAttitude(), local = newLocalPositionNed(), global = newGlobalPositionInt(), hud = newVfrHud(),
    servo = newServoOutputRaw(), sys = newSysStatus(), battery = newBatteryStatus();
  const decoders: [number, (frame: MavFrame) => boolean][] = [
    [30, (f) => attitudeInto(f, attitude)], [32, (f) => localPositionNedInto(f, local)], [33, (f) => globalPositionIntInto(f, global)],
    [74, (f) => vfrHudInto(f, hud)], [36, (f) => servoOutputRawInto(f, servo)], [1, (f) => sysStatusInto(f, sys)],
    [147, (f) => batteryStatusInto(f, battery)],
  ];
  expect(decoders.map(([id]) => id).sort((a, b) => a - b)).toEqual([...HIGH_RATE_MESSAGES].sort((a, b) => a - b));
  const parser = new MavParser((frame) => {
    // Each decoder accepts exactly its own message and refuses every other frame.
    for (const [id, decode] of decoders) expect(decode(frame)).toBe(frame.id === id);
  });
  for (const f of messageFrames.filter((x) => x.style === "pattern")) parser.push(Buffer.from(f.hex, "hex"));
  const values = (id: number): GoldenValues => {
    const frame = messageFrames.find((x) => x.id === id && x.style === "pattern");
    if (!frame) throw new Error(`No golden ${id}`);
    return frame.values;
  };
  const n = (id: number, name: string): number => {
    const value = values(id)[name];
    if (typeof value !== "number") throw new Error(`Not a number ${id}.${name}`);
    return wireValue(id, name, value);
  };
  const list = (id: number, name: string): number[] => {
    const value = values(id)[name];
    if (!Array.isArray(value)) throw new Error(`Not an array ${id}.${name}`);
    return value;
  };
  expect(attitude).toEqual({ timeBootMs: n(30, "time_boot_ms"), rollRad: n(30, "roll"), pitchRad: n(30, "pitch"), yawRad: n(30, "yaw"),
    rollRateRadS: n(30, "rollspeed"), pitchRateRadS: n(30, "pitchspeed"), yawRateRadS: n(30, "yawspeed") });
  expect(local).toEqual({ timeBootMs: n(32, "time_boot_ms"), northM: n(32, "x"), eastM: n(32, "y"), downM: n(32, "z"),
    vnMps: n(32, "vx"), veMps: n(32, "vy"), vdMps: n(32, "vz") });
  expect(global).toEqual({ timeBootMs: n(33, "time_boot_ms"), latitudeE7: n(33, "lat"), longitudeE7: n(33, "lon"), altitudeMslMm: n(33, "alt"),
    relativeAltitudeMm: n(33, "relative_alt"), vnCmps: n(33, "vx"), veCmps: n(33, "vy"), vdCmps: n(33, "vz"), headingCdeg: n(33, "hdg") });
  expect(hud).toEqual({ airspeedMps: n(74, "airspeed"), groundspeedMps: n(74, "groundspeed"), headingDeg: n(74, "heading"),
    throttlePercent: n(74, "throttle"), altitudeM: n(74, "alt"), climbMps: n(74, "climb") });
  expect([servo.timeUs, servo.port]).toEqual([n(36, "time_usec"), n(36, "port")]);
  expect(Array.from(servo.outputsUs)).toEqual(Array.from({ length: 16 }, (_, i) => n(36, `servo${i + 1}_raw`)));
  expect(sys).toMatchObject({ sensorsPresent: n(1, "onboard_control_sensors_present"), sensorsEnabled: n(1, "onboard_control_sensors_enabled"),
    sensorsHealth: n(1, "onboard_control_sensors_health"), loadPermille: n(1, "load"), batteryVoltageMv: n(1, "voltage_battery"),
    batteryCurrentCa: n(1, "current_battery"), batteryRemainingPercent: n(1, "battery_remaining"), dropRateCommCentipercent: n(1, "drop_rate_comm"),
    errorsComm: n(1, "errors_comm"), sensorsPresentExtended: n(1, "onboard_control_sensors_present_extended"),
    sensorsEnabledExtended: n(1, "onboard_control_sensors_enabled_extended"), sensorsHealthExtended: n(1, "onboard_control_sensors_health_extended") });
  expect(Array.from(sys.errorsCount)).toEqual([1, 2, 3, 4].map((k) => n(1, `errors_count${k}`)));
  expect(Array.from(battery.cellVoltagesMv)).toEqual([...list(147, "voltages"), ...list(147, "voltages_ext")]);
  expect(battery).toMatchObject({ id: n(147, "id"), batteryFunction: n(147, "battery_function"), type: n(147, "type"),
    temperatureCdegC: n(147, "temperature"), currentCa: n(147, "current_battery"), consumedMah: n(147, "current_consumed"),
    energyHj: n(147, "energy_consumed"), remainingPercent: n(147, "battery_remaining"), timeRemainingS: n(147, "time_remaining"),
    chargeState: n(147, "charge_state"), mode: n(147, "mode"), faultBitmask: n(147, "fault_bitmask") });
});

it("rejects every golden message with one corrupted payload byte and keeps decoding afterwards", () => {
  let delivered = 0;
  const parser = new MavParser(() => { delivered++; });
  for (const f of messageFrames) {
    const bytes = Buffer.from(f.hex, "hex");
    bytes[10] = bytes[10]! ^ 0x40; // the first payload byte; the CRC no longer matches
    parser.push(bytes);
  }
  expect(delivered).toBe(0);
  expect(parser.badCrc).toBe(messageFrames.length);
  parser.push(Buffer.from(messageFrames[0]!.hex, "hex"));
  expect(delivered).toBe(1);
});
