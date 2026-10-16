import { describe, expect, it } from "vitest";
import { MavParser, encodeInto, type MavFrame } from "@mirage/mavlink/codec";
import type { GpsSample, ImuSample } from "@mirage/mavlink/samples";
import type { HilActuators } from "@mirage/mavlink/messages";
import {
  HIL_GPS_MAX_FRAME_BYTES,
  HIL_SENSOR_ACCEL_GYRO,
  HIL_SENSOR_BARO,
  HIL_SENSOR_MAG,
  HIL_SENSOR_MAX_FRAME_BYTES,
  HilStreamer,
  hilLinkBudget,
  type HilStreamOptions,
} from "@mirage/autopilot/hitl";
import { SteppingPolicy, newPumpReport } from "@mirage/physics";

// TASK-049. Oracle: exact integer counts/timestamps implied by the rates, and
// MavParser (CRC/length checked) decoding of every byte the streamer emits.

function imuSample(): ImuSample {
  return { timeLoUs: 0, timeHiUs: 0, specificForceBodyMps2: new Float64Array([0.1, -0.2, -9.80665]),
    gyroBodyRadS: new Float64Array([0.01, 0.02, -0.03]), magBodyGauss: new Float64Array([0.2, 0.01, 0.4]),
    pressurePa: 101325, differentialPressurePa: 12, pressureAltitudeM: 15, temperatureK: 293.15, updatedMask: 0 };
}
function gpsSample(): GpsSample {
  return { timeLoUs: 0, timeHiUs: 0, latitudeRad: 0.83, longitudeRad: 0.23, altitudeMslM: 120, vnMps: 1, veMps: -2,
    vdMps: 0.5, hdop: 0.8, vdop: 1.2, hdopValid: true, vdopValid: true, fixType: 3, satellites: 12,
    satellitesValid: true, velocityValid: true, courseRad: 1.0, courseValid: true };
}
const base: HilStreamOptions = { physicsHz: 400, imuHz: 400, magHz: 100, baroHz: 50, gnssHz: 10, baud: 921600,
  systemId: 1, componentId: 1 };

describe("HIL sensor streaming on a fake real-time clock", () => {
  for (const physicsHz of [400, 800, 1200] as const) {
    for (const imuHz of [200, 400] as const) {
      for (const gnssHz of [5, 10] as const) {
        it(`60 s at ${physicsHz} Hz physics, IMU ${imuHz} Hz, GNSS ${gnssHz} Hz gives exact counts, bytes, timestamps and fields_updated`, () => {
          const magHz = 100, baroHz = 50;
          const streamer = new HilStreamer({ ...base, physicsHz, imuHz, gnssHz, magHz, baroHz });
          const policy = new SteppingPolicy({ hz: physicsHz, mode: "hitl-realtime", maxCatchUp: 4 }), report = newPumpReport();
          const imu = imuSample(), gps = gpsSample(), drain = new Uint8Array(4096);
          const sensorTimes: number[] = [], gpsTimes: number[] = [], masks: number[] = [];
          let parsedBytes = 0;
          const parser = new MavParser((f: MavFrame) => {
            const time = f.view.getUint32(0, true) + f.view.getUint32(4, true) * 4294967296;
            if (f.id === 107) { sensorTimes.push(time); masks.push(f.view.getUint32(60, true)); }
            if (f.id === 113) gpsTimes.push(time);
          });
          let ticks = 0, failures = 0, faults = 0;
          const step = () => { ticks++; if (!streamer.tick(imu, gps)) failures++; };
          policy.pump(0, { ready: () => true }, step, report); // establishes the clock origin
          for (let ms = 1; ms <= 60_000; ms++) {
            policy.pump(ms, { ready: () => true }, step, report);
            if (report.fault !== "none") faults++;
            const n = streamer.drainInto(drain);
            parsedBytes += n;
            parser.push(drain.subarray(0, n));
          }
          expect([ticks, failures, faults]).toEqual([60 * physicsHz, 0, 0]);
          expect(sensorTimes).toHaveLength(60 * imuHz);
          expect(gpsTimes).toHaveLength(60 * gnssHz);
          expect(sensorTimes).toEqual(Array.from({ length: 60 * imuHz }, (_, k) => ((k + 1) * 1e6) / imuHz));
          expect(gpsTimes).toEqual(Array.from({ length: 60 * gnssHz }, (_, k) => ((k + 1) * 1e6) / gnssHz));
          expect(parser.badCrc + parser.unsupported).toBe(0);
          expect(parsedBytes).toBe(streamer.stats.bytes);
          expect(streamer.queuedBytes).toBe(0);
          // fields_updated: accel/gyro every frame; mag and baro exactly on their own schedules.
          expect(masks.every(m => (m & HIL_SENSOR_ACCEL_GYRO) === HIL_SENSOR_ACCEL_GYRO)).toBe(true);
          expect(masks.filter(m => m & HIL_SENSOR_MAG)).toHaveLength(60 * magHz);
          expect(masks.filter(m => m & HIL_SENSOR_BARO)).toHaveLength(60 * baroHz);
          masks.forEach((m, k) => {
            expect((m & HIL_SENSOR_MAG) !== 0, `mag ${k}`).toBe((k + 1) % (imuHz / magHz) === 0);
            expect((m & HIL_SENSOR_BARO) !== 0, `baro ${k}`).toBe((k + 1) % (imuHz / baroHz) === 0);
          });
        });
      }
    }
  }

  it("requires at least 30% serial headroom at baud/10 for worst-case frames", () => {
    expect(HIL_SENSOR_MAX_FRAME_BYTES).toBe(77);
    expect(HIL_GPS_MAX_FRAME_BYTES).toBe(51);
    const b = hilLinkBudget({ imuHz: 400, gnssHz: 10 }, 921600);
    expect(b).toEqual({ bytesPerSecond: 400 * 77 + 10 * 51, capacityBytesPerSecond: 92160, utilization: 31310 / 92160 });
    expect(() => new HilStreamer({ ...base, baud: 460800 })).not.toThrow(); // 67.9% used
    expect(() => new HilStreamer({ ...base, baud: 115200 })).toThrow(/above 70%/);
    expect(() => new HilStreamer({ ...base, imuHz: 200, gnssHz: 5, baud: 230400 })).not.toThrow(); // 200*77+5*51 = 15655 B/s of 23040
    expect(() => new HilStreamer({ ...base, imuHz: 400, baud: 230400 })).toThrow();
  });

  it("latches queue overflow when the serial writer stalls and clears on reset", () => {
    const streamer = new HilStreamer({ ...base, outboxBytes: 1024 });
    const imu = imuSample(), gps = gpsSample();
    let ok = 0;
    while (ok < 1000 && streamer.tick(imu, gps)) ok++; // bounded: a missing overflow check fails, not hangs
    expect(streamer.fault).toBe("queue-overflow");
    expect(streamer.queuedBytes).toBeLessThanOrEqual(1024);
    expect(ok).toBeLessThan(20);
    expect(streamer.tick(imu, gps)).toBe(false); // latched
    streamer.reset();
    expect([streamer.fault, streamer.queuedBytes]).toEqual(["none", 0]);
    expect(streamer.tick(imu, gps)).toBe(true);
  });

  it("rejects invalid observations instead of emitting them", () => {
    const streamer = new HilStreamer(base), imu = imuSample(), gps = gpsSample();
    imu.gyroBodyRadS[0] = Number.NaN;
    expect(streamer.tick(imu, gps)).toBe(false);
    expect(streamer.stats.bytes).toBe(0);
  });
});

describe("HIL actuator admission", () => {
  const actuatorFrame = (timeUs: number, controls: number[]) => {
    const payload = new Uint8Array(81), v = new DataView(payload.buffer), wire = new Uint8Array(93);
    v.setUint32(0, timeUs % 4294967296, true); v.setUint32(4, Math.floor(timeUs / 4294967296), true);
    controls.forEach((c, i) => v.setFloat32(16 + 4 * i, c, true));
    payload[80] = 129; // MAV_MODE_FLAG armed + custom
    const n = encodeInto(93, payload, 0, 1, 1, wire);
    let frame: MavFrame | null = null;
    new MavParser(f => { frame = { ...f, payload: f.payload.slice(), view: new DataView(f.payload.slice().buffer) }; }).push(wire.subarray(0, n));
    if (!frame) throw new Error("frame did not parse");
    return frame;
  };
  const newOut = (): HilActuators => ({ timeLoUs: 0, timeHiUs: 0, flagsLo: 0, flagsHi: 0, mode: 0, controls: new Float64Array(16) });

  it("accepts in-range, strictly newer frames and never overwrites output on rejection", () => {
    const streamer = new HilStreamer(base), out = newOut();
    const controls = Array.from({ length: 16 }, (_, i) => (i - 8) / 8);
    expect(streamer.acceptActuator(actuatorFrame(1000, controls), 0, out)).toBe(true);
    expect([...out.controls]).toEqual(controls.map(Math.fround));
    expect(out.mode).toBe(129);
    const before = Float64Array.from(out.controls);
    expect(streamer.acceptActuator(actuatorFrame(1000, controls.map(() => 0.5)), 10, out)).toBe(false); // replay
    expect(streamer.acceptActuator(actuatorFrame(999, controls.map(() => 0.5)), 10, out)).toBe(false); // older
    expect(streamer.acceptActuator(actuatorFrame(2000, [1.5, ...controls.slice(1)]), 10, out)).toBe(false); // out of range
    expect([...out.controls]).toEqual([...before]);
    expect(out.timeLoUs).toBe(1000);
    expect(streamer.acceptActuator(actuatorFrame(2 ** 32 + 5, controls), 20, out)).toBe(true); // u64 time crosses 2^32
    expect([out.timeLoUs, out.timeHiUs]).toEqual([5, 1]);
    expect(streamer.stats).toMatchObject({ actuatorFrames: 2, actuatorRejected: 3 });
  });

  it("latches actuator dropout after the timeout", () => {
    const streamer = new HilStreamer({ ...base, actuatorTimeoutUs: 100_000 }), out = newOut();
    expect(streamer.poll(0)).toBe("none");
    expect(streamer.poll(100_000)).toBe("none");
    expect(streamer.acceptActuator(actuatorFrame(1, new Array<number>(16).fill(0)), 90_000, out)).toBe(true);
    expect(streamer.poll(190_000)).toBe("none");
    expect(streamer.poll(190_001)).toBe("actuator-dropout");
    expect(streamer.tick(imuSample(), gpsSample())).toBe(false);
  });
});
