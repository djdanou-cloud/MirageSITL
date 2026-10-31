import { expect, it, describe } from "vitest";
import { createSocket, type Socket } from "node:dgram";
import { WebSocket } from "ws";
import {
  ExternalSitlLockstep,
  MAX_STATE_LINE_BYTES,
  decodeServoPacketInto,
  encodeStateLineInto,
  newServoFrame,
  newSitlPhysicsState,
  type SitlPhysicsState,
} from "@mirage/autopilot/external-sitl";
import { SteppingPolicy, newPumpReport } from "@mirage/physics";
import { SeededRandom } from "@mirage/test-support/prng";
import { SIM_JSON_KEYTABLE, isServoDatagram, validateStateLine } from "../apps/bridge/src/ardupilot-json";
import { startBridge } from "../apps/bridge/src/server";
import { decodeRecord, encodeRecord } from "../apps/bridge/src/framing";
import fixture from "./fixtures/sitl/json-protocol.json";

// TASK-041. Oracles: tests/fixtures/sitl/json-protocol.json (Python struct packets and
// '%.9f' reply, upstream file hashes at the pinned ArduPilot commit) and the parser below.

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const ascii = (s: string) => new TextEncoder().encode(s);

/**
 * Transcription of SIM_JSON.cpp parse_sensors()/parse_array() at the pinned
 * commit: section and key are found with strstr (first textual occurrence),
 * the value starts strlen(key)+2 bytes later, arrays skip to the first '-' or
 * digit, float fields are float32 (strtof), position/timestamp are double.
 * Returns the received-key bitmask (0 if a mandatory key is missing) and values.
 */
function upstreamParse(json: string): { mask: bigint; values: Map<string, number[]> } {
  const values = new Map<string, number[]>();
  const doubles = new Set(["timestamp", "position", "latitude", "longitude", "altitude"]);
  const arrays: Record<string, number> = { gyro: 3, accel_body: 3, position: 3, attitude: 3, velocity: 3, velocity_wind: 3, quaternion: 4 };
  let mask = 0n;
  SIM_JSON_KEYTABLE.forEach(([section, key, required], i) => {
    if (mask < 0n) return;
    let p = json.indexOf(section);
    if (p < 0) { if (required) mask = -1n; return; }
    p += section.length + 1;
    p = json.indexOf(key, p);
    if (p < 0) { if (required) mask = -1n; return; }
    mask |= 1n << BigInt(i);
    p += key.length + 2;
    const count = arrays[key] ?? 1;
    const out: number[] = [];
    for (let k = 0; k < count; k++) {
      while (p < json.length && json[p] !== "-" && !(json[p]! >= "0" && json[p]! <= "9")) p++;
      const m = /^-?[0-9]*\.?[0-9]*(?:[eE][-+]?[0-9]+)?/.exec(json.slice(p));
      const v = Number(m?.[0] ?? NaN);
      out.push(doubles.has(key) ? v : Math.fround(v));
      while (p < json.length && json[p] !== "," && json[p] !== "]") p++;
      if (k < count - 1) p++;
    }
    values.set(key, out);
  });
  return { mask: mask < 0n ? 0n : mask, values };
}
const bit = (key: string) => 1n << BigInt(SIM_JSON_KEYTABLE.findIndex(([, k]) => k === key));
const lineText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function stateFromFixture(): SitlPhysicsState {
  const s = newSitlPhysicsState(), f = fixture.state;
  s.timestampS = f.timestampS;
  s.gyroBodyRadS.set(f.gyroBodyRadS); s.accelBodyMps2.set(f.accelBodyMps2); s.positionNedM.set(f.positionNedM);
  s.velocityNedMps.set(f.velocityNedMps); s.quaternionWxyz.set(f.quaternionWxyz); s.windNedMps.set(f.windNedMps);
  s.windValid = true;
  return s;
}
function servo(count: number, pwm = 1500, channels: 16 | 32 = 16): Uint8Array {
  const bytes = new Uint8Array(8 + 2 * channels), v = new DataView(bytes.buffer);
  v.setUint16(0, channels === 16 ? 18458 : 29569, true); v.setUint16(2, 400, true); v.setUint32(4, count, true);
  for (let i = 0; i < channels; i++) v.setUint16(8 + 2 * i, pwm, true);
  return bytes;
}

describe("ArduPilot JSON protocol against the pinned upstream", () => {
  it("pins the upstream commit and file hashes", () => {
    expect(fixture.ardupilotCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(fixture.upstream.map(f => f.path)).toEqual(["libraries/SITL/SIM_JSON.h", "libraries/SITL/SIM_JSON.cpp",
      "libraries/SITL/examples/JSON/readme.md"]);
    for (const f of fixture.upstream) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SIM_JSON_KEYTABLE).toHaveLength(36);
  });

  it("decodes little-endian 16- and 32-channel servo packets and rejects malformed ones", () => {
    const frame = newServoFrame();
    expect(decodeServoPacketInto(hex(fixture.servo.packet16.hex), frame)).toBe(true);
    expect([frame.channels, frame.frameRateHz, frame.frameCount]).toEqual([16, 400, 7]);
    expect([...frame.pwmUs.subarray(0, 16)]).toEqual(fixture.servo.packet16.pwmUs);
    expect([...frame.pwmUs.subarray(16)].every(v => v === 0)).toBe(true);
    expect(decodeServoPacketInto(hex(fixture.servo.packet32.hex), frame)).toBe(true);
    expect([frame.channels, frame.frameRateHz, frame.frameCount]).toEqual([32, 1200, 4294967295]);
    expect([...frame.pwmUs]).toEqual(fixture.servo.packet32.pwmUs);
    for (const bad of fixture.servo.invalid) {
      expect(decodeServoPacketInto(hex(bad.hex), frame), bad.why).toBe(false);
      expect(isServoDatagram(hex(bad.hex)), bad.why).toBe(false);
    }
    expect(frame.frameCount).toBe(4294967295); // rejected packets leave the frame untouched
  });

  it("encodes the reply byte-for-byte and the upstream parser reads every field", () => {
    const out = new Uint8Array(MAX_STATE_LINE_BYTES);
    const n = encodeStateLineInto(stateFromFixture(), out);
    expect(lineText(out.subarray(0, n))).toBe(fixture.expectedLine);
    const { mask, values } = upstreamParse(fixture.expectedLine.trim());
    for (const key of ["timestamp", "gyro", "accel_body", "position", "velocity", "quaternion", "velocity_wind"]) {
      expect(mask & bit(key), key).not.toBe(0n);
    }
    expect(values.get("timestamp")).toEqual([fixture.state.timestampS]);
    expect(values.get("position")).toEqual(fixture.state.positionNedM);
    expect(values.get("velocity")).toEqual(fixture.state.velocityNedMps.map(Math.fround));
    expect(values.get("velocity_wind")).toEqual(fixture.state.windNedMps.map(Math.fround));
    expect(validateStateLine(out.subarray(0, n))).toBeNull();
    // The upstream example line passes both the transcription and the bridge validator.
    expect(upstreamParse(fixture.readmeExampleLine.trim()).mask & bit("attitude")).not.toBe(0n);
    expect(validateStateLine(ascii(fixture.readmeExampleLine))).toBeNull();
  });

  it("encodes the TASK-147 battery section after velocity_wind, and omits it unless valid", () => {
    const out = new Uint8Array(MAX_STATE_LINE_BYTES), state = stateFromFixture();
    expect(lineText(out.subarray(0, encodeStateLineInto(state, out)))).toBe(fixture.expectedLine);
    state.batteryVoltageV = fixture.battery.voltageV; state.batteryCurrentA = fixture.battery.currentA; state.batteryValid = true;
    const n = encodeStateLineInto(state, out);
    expect(lineText(out.subarray(0, n))).toBe(fixture.expectedBatteryLine);
    const { mask, values } = upstreamParse(fixture.expectedBatteryLine.trim());
    for (const key of ["timestamp", "gyro", "accel_body", "position", "velocity", "quaternion", "velocity_wind", "voltage", "current"]) {
      expect(mask & bit(key), key).not.toBe(0n);
    }
    // SIM_JSON reads both as float32 and every other field as before.
    expect(values.get("voltage")).toEqual([Math.fround(fixture.battery.voltageV)]);
    expect(values.get("current")).toEqual([Math.fround(fixture.battery.currentA)]);
    expect(values.get("velocity_wind")).toEqual(fixture.state.windNedMps.map(Math.fround));
    expect(validateStateLine(out.subarray(0, n))).toBeNull();
    for (const bad of [Number.NaN, Infinity, 2e6]) {
      state.batteryCurrentA = bad;
      expect(encodeStateLineInto(state, out), String(bad)).toBe(0);
    }
    expect(validateStateLine(ascii(fixture.expectedBatteryLine.replace(/"current":[0-9.]+/, '"current":"12.5"')))).toBe("battery");
    expect(validateStateLine(ascii(fixture.expectedBatteryLine.replace(/"battery":\{[^}]*\}/, '"battery":[1,2]')))).toBe("battery");
  });

  it("rejects lines upstream would misread or refuse", () => {
    const good = fixture.expectedLine;
    // velocity_wind before velocity: strstr("velocity") lands inside velocity_wind.
    const reordered = good.replace(/,"velocity":\[[^\]]*\]/, "").replace("}\n", `,"velocity":[${fixture.state.velocityNedMps.join(",")}]}\n`);
    expect(reordered.indexOf("velocity_wind")).toBeLessThan(reordered.indexOf('"velocity"'));
    expect(upstreamParse(reordered.trim()).values.get("velocity")).toEqual(fixture.state.windNedMps.map(Math.fround));
    expect(validateStateLine(ascii(reordered))).toBe("ambiguous key velocity");
    const cases: [string, string][] = [
      [good.replace(/,"velocity":\[[^\]]*\]/, ""), "velocity"],
      [good.replace(/"quaternion":\[[^\]]*\],/, ""), "attitude or quaternion"],
      [good.trim(), "line must start and end with newline"],
      [good.replace("12.345678900", "NaN"), "invalid JSON"],
      [good.replace("0.010000000", "1e999"), "imu"],
      [`\n[1,2]\n`, "not an object"],
      [good.replace("timestamp", "tímestamp"), "non-printable byte"],
      [`\n{"timestamp":1,"imu":{"gyro":[0,0,0],"accel_body":[0,0,0]},"velocity":[0,0,0],"attitude":[0,0,0],"x":"${"a".repeat(MAX_STATE_LINE_BYTES)}"}\n`, "line length"],
    ];
    for (const [line, reason] of cases) expect(validateStateLine(ascii(line)), reason).toBe(reason);
    // Without "velocity", upstream's strstr silently reads velocity_wind as vehicle velocity; the bridge refuses.
    expect(upstreamParse(cases[0]![0].trim()).values.get("velocity")).toEqual(fixture.state.windNedMps.map(Math.fround));
    // A truly missing mandatory key is refused upstream too.
    const noGyro = good.replace('"gyro":[0.010000000,-0.020000000,0.500000000],', "");
    expect(upstreamParse(noGyro.trim()).mask).toBe(0n);
    expect(validateStateLine(ascii(noGyro))).toBe("imu");
  });
});

describe("external SITL lockstep", () => {
  it("steps exactly once per new frame and resends the identical reply for duplicates", () => {
    const lock = new ExternalSitlLockstep({ motorChannels: [1, 2, 3, 4] });
    const motors = new Float64Array(4), out = new Uint8Array(MAX_STATE_LINE_BYTES), resend = new Uint8Array(MAX_STATE_LINE_BYTES);
    const state = newSitlPhysicsState();
    expect(lock.ready()).toBe(false);
    expect(lock.receive(servo(0, 1500))).toBe("step");
    expect(lock.ready()).toBe(true);
    expect(lock.resendReplyInto(resend)).toBe(0); // not answered yet
    expect(lock.consumeActuatorsInto(motors)).toBe(true);
    expect([...motors]).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(lock.consumeActuatorsInto(motors)).toBe(false); // one step per frame
    state.timestampS = 0.0025;
    const n = lock.completeStepInto(state, out);
    expect(n).toBeGreaterThan(0);
    expect(lock.receive(servo(0, 1900))).toBe("duplicate");
    expect(lock.ready()).toBe(false);
    expect(lock.resendReplyInto(resend)).toBe(n);
    expect(resend.subarray(0, n)).toEqual(out.subarray(0, n));
    expect(lock.receive(servo(1))).toBe("step");
    expect(lock.receive(servo(3))).toBe("gap");
    expect(lock.stats).toMatchObject({ gaps: 1, droppedFrames: 1, duplicates: 1 });
    expect(lock.consumeActuatorsInto(motors)).toBe(true); // frames 1 and 3 coalesce into one pending step
    expect(lock.receive(servo(2))).toBe("stale");
    expect(lock.ready()).toBe(false);
    expect(lock.receive(servo(0))).toBe("restart");
    expect(lock.restartRequested).toBe(true);
    expect(lock.receive(new Uint8Array(39))).toBe("invalid");
    expect(lock.stats).toMatchObject({ steps: 2, restarts: 1, stale: 1, invalid: 1 });
  });

  it("never double-steps under seeded loss, duplication and reordering", () => {
    const rng = new SeededRandom(41, 1);
    const lock = new ExternalSitlLockstep({ motorChannels: [1, 2, 3, 4] });
    const motors = new Float64Array(4);
    const forwardFrames = new Set<number>();
    let ticks = 0, frame = 1; // start at 1: a reordered frame 0 would legitimately mean a SITL restart
    const inFlight: number[] = [];
    for (let i = 0; i < 20000; i++) {
      const r = rng.nextFloat();
      if (r < 0.05) frame++; // lost: never delivered
      else if (r < 0.15) inFlight.push(frame); // duplicate resend
      inFlight.push(frame++);
      if (rng.nextFloat() < 0.1 && inFlight.length > 1) inFlight.reverse(); // reorder the window
      while (inFlight.length) {
        const count = inFlight.shift()!;
        const d = lock.receive(servo(count));
        if (d === "step" || d === "gap") forwardFrames.add(count);
        if (lock.ready() && lock.consumeActuatorsInto(motors)) ticks++;
      }
    }
    expect(ticks).toBe(lock.stats.steps);
    expect(ticks).toBe(forwardFrames.size); // one tick per accepted forward frame, never more
    expect(lock.stats.duplicates + lock.stats.stale).toBeGreaterThan(0);
    expect(lock.stats.droppedFrames).toBeGreaterThan(0);
  });

  it("maps PWM through explicit MOT_PWM_MIN/MAX and flags clamping", () => {
    const lock = new ExternalSitlLockstep({ motorChannels: [3, 1], pwmMinUs: 1100, pwmMaxUs: 1900 });
    const motors = new Float64Array(2), packet = servo(0, 1500), v = new DataView(packet.buffer);
    v.setUint16(8 + 2 * 2, 1900, true); // channel 3
    v.setUint16(8, 1000, true); // channel 1 below min
    lock.receive(packet);
    lock.consumeActuatorsInto(motors);
    expect([...motors]).toEqual([1, 0]);
    expect(lock.stats.clampedPwm).toBe(1);
    for (const bad of [{ motorChannels: [] }, { motorChannels: [0] }, { motorChannels: [33] }, { motorChannels: [1, 1] },
      { motorChannels: [1], pwmMinUs: 1500, pwmMaxUs: 1550 }]) {
      expect(() => new ExternalSitlLockstep(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("keeps SITL time advancing: timestamps strictly increase by less than 0.1 s", () => {
    const lock = new ExternalSitlLockstep({ motorChannels: [1] }), out = new Uint8Array(MAX_STATE_LINE_BYTES);
    const state = newSitlPhysicsState(), motors = new Float64Array(1);
    const step = (count: number, t: number) => { lock.receive(servo(count)); lock.consumeActuatorsInto(motors); state.timestampS = t; return lock.completeStepInto(state, out); };
    expect(step(0, 1)).toBeGreaterThan(0);
    expect(step(1, 1)).toBe(0); // not increasing
    expect(step(2, 1.1)).toBe(0); // 0.1 s: SITL would not advance
    expect(step(3, 1.0025)).toBeGreaterThan(0);
    state.quaternionWxyz.fill(0);
    expect(step(4, 1.005)).toBe(0); // zero quaternion
    state.quaternionWxyz.set([1, 0, 0, 0]); state.positionNedM[0] = Number.NaN;
    expect(step(5, 1.0075)).toBe(0);
  });

  it("waits in sitl-lockstep mode without blocking, so pause stays responsive", () => {
    const lock = new ExternalSitlLockstep({ motorChannels: [1, 2, 3, 4] }), motors = new Float64Array(4);
    const policy = new SteppingPolicy({ hz: 400, mode: "sitl-lockstep" }), report = newPumpReport();
    let ticks = 0;
    const step = () => { lock.consumeActuatorsInto(motors); ticks++; };
    policy.pump(0, lock, step, report);
    expect([report.executed, report.waiting]).toEqual([0, true]); // returns at once: commands can run
    lock.receive(servo(0));
    policy.pump(2.5, lock, step, report);
    expect([report.executed, ticks]).toEqual([1, 1]);
    policy.pump(5, lock, step, report);
    expect([report.executed, report.waiting, ticks]).toEqual([0, true, 1]);
  });
});

describe("bridge ArduPilot JSON endpoint over real loopback UDP and WebSocket", () => {
  const token = "c".repeat(64), origin = "http://localhost:5173";
  const bind = async (): Promise<Socket> => {
    const s = createSocket("udp4");
    await new Promise<void>(done => s.bind(0, "127.0.0.1", () => done()));
    return s;
  };
  it("forwards valid servo packets, replies to the learned SITL port, and rejects invalid traffic", async () => {
    const mav = await bind(), sitl = await bind();
    const bridge = await startBridge({ port: 0, origin, token, epoch: 3,
      udp: { mavlinkPort: mav.address().port, physicsPort: 1 }, ardupilotJson: { localPort: 0 } });
    const physicsPort = bridge.jsonPhysics?.localPort ?? -1;
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, ["mirage-v1", `session.${token}`], { origin });
    const lines: string[] = [];
    sitl.on("message", msg => lines.push(msg.toString("latin1")));
    try {
      await new Promise<void>((done, reject) => { ws.once("open", () => done()); ws.once("error", reject); });
      const records: Uint8Array[] = [];
      ws.on("message", data => { if (Buffer.isBuffer(data)) records.push(new Uint8Array(data)); });
      sitl.send(new Uint8Array(41), physicsPort, "127.0.0.1"); // malformed: dropped at the bridge
      sitl.send(servo(0, 1600), physicsPort, "127.0.0.1");
      await waitFor(() => records.length >= 1);
      const servoRecord = decodeRecord(records[0]!);
      expect(servoRecord?.channel).toBe(3);
      const lock = new ExternalSitlLockstep({ motorChannels: [1, 2, 3, 4] }), motors = new Float64Array(4);
      expect(lock.receive(servoRecord!.payload)).toBe("step");
      lock.consumeActuatorsInto(motors);
      expect(motors[0]).toBeCloseTo(0.6, 12);
      const state = newSitlPhysicsState(), out = new Uint8Array(MAX_STATE_LINE_BYTES);
      state.timestampS = 0.0025;
      const n = lock.completeStepInto(state, out);
      ws.send(encodeRecord({ channel: 2, epoch: 3, sequence: 0, payload: out.subarray(0, n) }));
      await waitFor(() => lines.length >= 1);
      expect(lines[0]).toBe(lineText(out.subarray(0, n)));
      expect(upstreamParse(lines[0]!.trim()).mask).not.toBe(0n);
      expect(bridge.jsonPhysics?.stats).toMatchObject({ servoAccepted: 1, servoRejected: 1, linesSent: 1 });
      const closed = new Promise<number>(done => ws.once("close", code => done(code)));
      ws.send(encodeRecord({ channel: 2, epoch: 3, sequence: 1, payload: ascii('\n{"timestamp":1}\n') }));
      expect(await closed).toBe(1008); // invalid state line closes the session
      expect(lines).toHaveLength(1);
    } finally {
      ws.terminate();
      await bridge.close();
      mav.close(); sitl.close();
    }
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  const until = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
