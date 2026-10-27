import { PerformanceObserver, performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  ControlProcessorV2,
  EwFlagV2,
  type ControlTargetV2,
  type ScheduledCommandV2,
  type TickId,
} from "@mirage/protocol";
import { MotorFaults } from "@mirage/physics/motor-fault";
import { EwEngine, FAULT_REGISTRY_CAPACITY, type EwContext, type FaultCommand } from "@mirage/ew/engine";
import { GpsOffsetApplier } from "@mirage/ew/position-step";
import { SensorPipeline } from "@mirage/sensors/pipeline";
import { SensorMapping } from "@mirage/mavlink/sensor-mapping";
import type { GpsSample, ImuSample } from "@mirage/mavlink/samples";

// TASK-058. Oracles: each effect alone (already verified in its own task),
// composed in the specified order and quantized by the existing SensorMapping.
function gps(): GpsSample {
  return { timeLoUs: 100, timeHiUs: 0, latitudeRad: 0.9, longitudeRad: -0.3, altitudeMslM: 150, vnMps: 2, veMps: 1,
    vdMps: -0.5, hdop: 0.8, vdop: 1.1, hdopValid: true, vdopValid: true, fixType: 3, satellites: 12,
    satellitesValid: true, velocityValid: true, courseRad: 0.46, courseValid: true };
}
function imu(): ImuSample {
  return { timeLoUs: 100, timeHiUs: 0, specificForceBodyMps2: new Float64Array([0.1, 0.2, -9.8]),
    gyroBodyRadS: new Float64Array([0.01, -0.02, 0.03]), magBodyGauss: new Float64Array([0.21, 0.02, 0.43]),
    pressurePa: 100000, differentialPressurePa: 20, pressureAltitudeM: 110, temperatureK: 290, updatedMask: 0x1fff };
}
let requestId = 0;
const fault = (faultId: string, enabled: boolean, effect: FaultCommand["effect"], recovery: FaultCommand["recovery"] = "hold-offset"): FaultCommand =>
  ({ protocolVersion: 2, requestId: ++requestId, expectedEpoch: 1, type: "fault.set", atTick: { lo: 0, hi: 0 }, faultId, enabled, effect, recovery });
const tick = (lo: number): TickId => ({ lo, hi: 0 });
const ctx = (dtS = 1 / 400): EwContext => ({ dtS, simTimeS: 0, truthNorthM: 1, truthEastM: 2, truthDownM: -3 });
const magnetic = (yawRad: number): FaultCommand["effect"] => ({ kind: "magnetic", rotationRad: [0, 0, yawRad], biasBodyGauss: [0, 0, 0] });
const motorLoss = (motorIndex: number): FaultCommand["effect"] =>
  ({ kind: "motor-loss", motorIndex, mode: "power-cut", remainingThrustFraction: 0 });

describe("EW pipeline composition", () => {
  it("orders baseline -> step + drift -> jamming -> quantization", () => {
    const engine = new EwEngine(), pipeline = new SensorPipeline(engine), base = gps();
    engine.reset(7);
    engine.apply(fault("step", true, { kind: "position-step", offsetNedM: [300, -200, 5] }), tick(0));
    engine.apply(fault("drift", true, { kind: "velocity-drift", accelerationNedMps2: [0.2, 0, 0], maxSpeedMps: 5 }), tick(0));
    engine.apply(fault("jam", true, { kind: "gnss-jamming", severity: 1 }), tick(0));
    for (let i = 0; i < 4000; i++) engine.advanceInto(ctx()); // 10 s: drift b = (10, 0, 0), v = (2, 0, 0)
    expect(pipeline.gpsInto(base)).toBe(true);
    // Oracle for the position stage: the summed offset applied once through WGS84.
    const expected = gps();
    new GpsOffsetApplier().applyInto(base, 300 + 10, -200, 5, expected);
    expect(pipeline.gps.latitudeRad).toBeCloseTo(expected.latitudeRad, 12);
    expect(pipeline.gps.longitudeRad).toBeCloseTo(expected.longitudeRad, 12);
    expect(pipeline.gps.altitudeMslM).toBeCloseTo(expected.altitudeMslM, 6);
    expect(pipeline.gps.vnMps).toBeCloseTo(base.vnMps + 2, 9);
    // Jamming acts last on satellites/DOP/fix only.
    expect([pipeline.gps.fixType, pipeline.gps.satellites]).toEqual([0, 1]);
    expect(pipeline.gps.hdop).toBeCloseTo(99, 6);
    // Quantization is the existing SensorMapping applied to the distorted sample.
    const reference = new SensorMapping();
    expect(reference.gpsInto(pipeline.gps)).toBe(true);
    expect([...pipeline.mapping.gps]).toEqual([...reference.gps]);
    expect(engine.flags).toBe(EwFlagV2.GnssJamming | EwFlagV2.PositionStep | EwFlagV2.VelocityDrift);
  });

  it("keeps the magnetometer independent of GNSS effects and vice versa", () => {
    const engine = new EwEngine(), pipeline = new SensorPipeline(engine);
    engine.reset(1);
    engine.apply(fault("step", true, { kind: "position-step", offsetNedM: [50, 0, 0] }), tick(0));
    expect(pipeline.imuInto(imu())).toBe(true);
    expect([...pipeline.imu.magBodyGauss]).toEqual([...imu().magBodyGauss]); // GNSS fault: mag untouched
    engine.apply(fault("mag", true, { kind: "magnetic", rotationRad: [0, 0, Math.PI / 2], biasBodyGauss: [0.01, 0, 0] }), tick(1));
    pipeline.imuInto(imu());
    const mag = imu().magBodyGauss, x = mag[0]!, y = mag[1]!, z = mag[2]!; // length-3 sample
    expect(pipeline.imu.magBodyGauss[0]).toBeCloseTo(-y + 0.01, 12); // yaw +90 deg: (x, y) -> (-y, x)
    expect(pipeline.imu.magBodyGauss[1]).toBeCloseTo(x, 12);
    expect(pipeline.imu.magBodyGauss[2]).toBeCloseTo(z, 12);
    expect([...pipeline.imu.specificForceBodyMps2, ...pipeline.imu.gyroBodyRadS, pipeline.imu.pressurePa])
      .toEqual([...imu().specificForceBodyMps2, ...imu().gyroBodyRadS, imu().pressurePa]);
    // The magnetic fault does not move GPS beyond the step.
    pipeline.gpsInto(gps());
    const stepOnly = gps();
    new GpsOffsetApplier().applyInto(gps(), 50, 0, 0, stepOnly);
    expect(pipeline.gps.latitudeRad).toBe(stepOnly.latitudeRad);
  });

  it("composes the fault registry: ownership, replacement, non-owner disable, capacity, and reset", () => {
    const motors = new MotorFaults(Array.from({ length: 32 }, (_, i) => i)), engine = new EwEngine(motors);
    engine.reset(3);
    engine.apply(fault("jam-a", true, { kind: "gnss-jamming", severity: 0.5 }), tick(0));
    engine.apply(fault("jam-b", true, { kind: "gnss-jamming", severity: 0.9 }), tick(1)); // replaces jam-a
    expect(engine.apply(fault("jam-a", false, { kind: "gnss-jamming", severity: 0 }), tick(2))).toBe("applied");
    expect(engine.flags & EwFlagV2.GnssJamming).not.toBe(0); // jam-a no longer owns jamming
    engine.apply(fault("jam-b", false, { kind: "gnss-jamming", severity: 0 }), tick(3));
    for (let i = 0; i < 4000; i++) engine.advanceInto(ctx()); // filtered severity decays on the physics clock
    // Motor faults reach physics actuators through MotorFaults.
    engine.apply(fault("m0", true, { kind: "motor-loss", motorIndex: 0, mode: "power-cut", remainingThrustFraction: 0.25 }), tick(4));
    expect(motors.driveTorque(0, 2)).toBe(0.5);
    expect(engine.flags & EwFlagV2.MotorFault).not.toBe(0);
    // Capacity: 16 registry slots in total.
    const results = Array.from({ length: FAULT_REGISTRY_CAPACITY }, (_, i) =>
      engine.apply(fault(`m${i + 1}`, true, { kind: "motor-loss", motorIndex: i + 1, mode: "power-cut", remainingThrustFraction: 0.5 }), tick(5)));
    expect(results.filter(r => r === "applied")).toHaveLength(FAULT_REGISTRY_CAPACITY - 1);
    expect(results.at(-1)).toBe("registry-full");
    engine.apply(fault("m0", false, { kind: "motor-loss", motorIndex: 0, mode: "power-cut", remainingThrustFraction: 1 }), tick(6));
    expect(motors.driveTorque(0, 2)).toBe(2);
    engine.reset(4);
    expect([engine.flags, engine.seed, motors.driveTorque(5, 2)]).toEqual([0, 4, 2]);
    expect(engine.apply(fault("m1", true, { kind: "motor-loss", motorIndex: 1, mode: "power-cut", remainingThrustFraction: 0.5 }), tick(7))).toBe("applied");
    expect(new EwEngine().apply(fault("x", true, { kind: "motor-loss", motorIndex: 0, mode: "power-cut", remainingThrustFraction: 0.5 }), tick(0)))
      .toBe("rejected"); // no MotorFaults wired
  });

  // TASK-125: re-enabling an owning faultId with another effect, or another motor, releases what it held.
  it("releases the effect a faultId owned when it is re-enabled with another effect or motor", () => {
    const motors = new MotorFaults([0, 1, 2, 3]), engine = new EwEngine(motors);
    engine.reset(5);
    // Another kind: x moves from jamming to the magnetic anomaly, so jamming ends there.
    expect(engine.apply(fault("x", true, { kind: "gnss-jamming", severity: 1 }), tick(0))).toBe("applied");
    expect(engine.apply(fault("x", true, magnetic(0.5)), tick(1))).toBe("applied");
    expect(engine.apply(fault("x", false, { kind: "gnss-jamming", severity: 0 }), tick(2))).toBe("applied"); // x owns no jamming now
    expect(engine.apply(fault("x", false, magnetic(0)), tick(3))).toBe("applied");
    for (let i = 0; i < 4000; i++) engine.advanceInto(ctx()); // filtered severity decays on the physics clock
    expect(engine.flags).toBe(0);
    // Another motor: motor 0 recovers as soon as y moves to motor 1.
    engine.apply(fault("y", true, motorLoss(0)), tick(4));
    expect(engine.apply(fault("y", true, motorLoss(1)), tick(5))).toBe("applied");
    expect([motors.driveTorque(0, 2), motors.driveTorque(1, 2)]).toEqual([2, 0]);
    engine.apply(fault("y", false, motorLoss(1)), tick(6));
    expect([motors.driveTorque(1, 2), engine.flags]).toEqual([2, 0]);
    // An effect another faultId owns: a replaces b as its owner, and the step a held ends.
    engine.apply(fault("a", true, { kind: "position-step", offsetNedM: [10, 0, 0] }), tick(7));
    engine.apply(fault("b", true, magnetic(0.5)), tick(7));
    expect(engine.apply(fault("a", true, magnetic(0.25)), tick(8))).toBe("applied");
    expect(engine.flags).toBe(EwFlagV2.MagneticAnomaly);
    engine.apply(fault("b", false, magnetic(0)), tick(9)); // b no longer owns the anomaly
    expect(engine.flags).toBe(EwFlagV2.MagneticAnomaly);
    engine.apply(fault("a", false, magnetic(0)), tick(10));
    expect(engine.flags).toBe(0);
  });

  it("ends a re-targeted drift with the new command's recovery and changes nothing when the new effect cannot engage", () => {
    const engine = new EwEngine();
    engine.reset(6);
    engine.apply(fault("d", true, { kind: "velocity-drift", accelerationNedMps2: [0.2, 0, 0], maxSpeedMps: 5 }, "hold-offset"), tick(0));
    for (let i = 0; i < 400; i++) engine.advanceInto(ctx()); // 1 s: b = (0.1, 0, 0) m, v_d = (0.2, 0, 0) m/s
    // The drift was enabled with hold-offset; the re-targeting command's step-to-truth decides how it ends.
    expect(engine.apply(fault("d", true, { kind: "gnss-jamming", severity: 0.5 }, "step-to-truth"), tick(400))).toBe("applied");
    expect([engine.drift.mode, engine.drift.discontinuities, ...engine.drift.offsetNedM]).toEqual(["off", 1, 0, 0, 0]);
    // The new effect is engaged before anything is released: a step beyond 10 km is rejected and a keeps its anomaly.
    engine.apply(fault("a", true, magnetic(0.5)), tick(401));
    engine.apply(fault("b", true, { kind: "position-step", offsetNedM: [10, 0, 0] }), tick(401));
    expect(engine.apply(fault("a", true, { kind: "position-step", offsetNedM: [20_000, 0, 0] }), tick(402))).toBe("rejected");
    expect([...engine.step.offsetNedM]).toEqual([10, 0, 0]); // b's step is untouched
    engine.apply(fault("a", false, magnetic(0)), tick(403));
    expect(engine.flags & (EwFlagV2.MagneticAnomaly | EwFlagV2.PositionStep)).toBe(EwFlagV2.PositionStep);
  });

  it("never touches truth or the baseline samples", () => {
    const engine = new EwEngine();
    engine.reset(9);
    engine.apply(fault("step", true, { kind: "position-step", offsetNedM: [10, 10, 0] }), tick(0));
    engine.apply(fault("drift", true, { kind: "velocity-drift", accelerationNedMps2: [0, 0.1, 0], maxSpeedMps: 3 }), tick(0));
    engine.apply(fault("mag", true, { kind: "magnetic", rotationRad: [0.1, 0, 0], biasBodyGauss: [0, 0, 0] }), tick(0));
    const truth = new Float64Array([1, 2, -3, 0.5, 0.25, 0, 1, 0, 0, 0]), before = Float64Array.from(truth);
    const context = ctx(), contextBefore = JSON.stringify(context);
    const baseGps = gps(), baseImu = imu(), gpsBefore = JSON.stringify(baseGps), imuBefore = JSON.stringify([...baseImu.magBodyGauss]);
    const pipeline = new SensorPipeline(engine);
    for (let i = 0; i < 2000; i++) {
      engine.advanceInto(context);
      if (i % 40 === 0) { pipeline.gpsInto(baseGps); pipeline.imuInto(baseImu); }
    }
    expect(truth).toEqual(before); // bit-identical: the engine has no truth write path
    expect(JSON.stringify(context)).toBe(contextBefore);
    expect(JSON.stringify(baseGps)).toBe(gpsBefore);
    expect(JSON.stringify([...baseImu.magBodyGauss])).toBe(imuBefore);
  });

  it("produces identical packets from an identical seed and command log through ControlProcessorV2", () => {
    const runScenario = () => {
      const engine = new EwEngine();
      engine.reset(42);
      const target: ControlTargetV2 = {
        isArmed: () => false, rotorCount: () => 4, start() {}, pause() {}, dispose() {}, reset() {},
        configure() {}, prepareModel: () => Promise.resolve(), commitModel() {},
        applyScheduled: (command: ScheduledCommandV2, at: TickId) => command.type === "fault.set" && engine.apply(command, at) === "applied"
          ? null : { code: "OUT_OF_RANGE", message: "EW fault command was rejected" },
        unsupportedReason: () => null,
      };
      const processor = new ControlProcessorV2(target), pipeline = new SensorPipeline(engine), base = gps(), packets: number[] = [];
      const submit = (id: number, atLo: number, faultId: string, enabled: boolean, effect: FaultCommand["effect"]) =>
        processor.submit({ protocolVersion: 2, requestId: id, expectedEpoch: 1, type: "fault.set", atTick: { lo: atLo, hi: 0 },
          faultId, enabled, effect, recovery: "hold-offset" });
      submit(1, 200, "drift", true, { kind: "velocity-drift", accelerationNedMps2: [0.1, 0.2, 0], maxSpeedMps: 4 });
      submit(2, 800, "step", true, { kind: "position-step", offsetNedM: [25, 0, -2] });
      submit(3, 1600, "jam", true, { kind: "gnss-jamming", severity: 0.7 });
      submit(4, 2400, "drift", false, { kind: "velocity-drift", accelerationNedMps2: [0, 0, 0], maxSpeedMps: 4 });
      processor.drain(() => undefined);
      for (let lo = 1; lo <= 4000; lo++) {
        processor.beforeTick({ lo, hi: 0 });
        engine.advanceInto(ctx());
        if (lo % 40 === 0) { pipeline.gpsInto(base); packets.push(...pipeline.mapping.gps, engine.flags); }
      }
      processor.drain(() => undefined);
      return packets;
    };
    const first = runScenario(), second = runScenario();
    expect(first).toHaveLength(100 * 40);
    expect(second).toEqual(first);
  });

  it("advances and distorts 1e6 steps with every effect active without triggering GC", async () => {
    const motors = new MotorFaults([0, 1, 2, 3]), engine = new EwEngine(motors), pipeline = new SensorPipeline(engine);
    engine.reset(5);
    engine.apply(fault("step", true, { kind: "position-step", offsetNedM: [40, -30, 2] }), tick(0));
    engine.apply(fault("drift", true, { kind: "velocity-drift", accelerationNedMps2: [0.1, 0.1, 0], maxSpeedMps: 3 }), tick(0));
    engine.apply(fault("jam", true, { kind: "gnss-jamming", severity: 0.4 }), tick(0));
    engine.apply(fault("mag", true, { kind: "magnetic", rotationRad: [0.1, 0.2, 0.3], biasBodyGauss: [0.01, 0, 0] }), tick(0));
    engine.apply(fault("m1", true, { kind: "motor-loss", motorIndex: 1, mode: "power-cut", remainingThrustFraction: 0.5 }), tick(0));
    const context = ctx(), baseGps = gps(), baseImu = imu();
    /** Measured loop: 400 Hz physics, IMU every 2 steps, GNSS every 40. Warmed once before measuring. */
    const run = (steps: number) => {
      let failures = 0;
      for (let i = 0; i < steps; i++) {
        if (!engine.advanceInto(context)) failures++;
        if (i % 2 === 0 && !pipeline.imuInto(baseImu)) failures++;
        if (i % 40 === 0 && !pipeline.gpsInto(baseGps)) failures++;
      }
      return failures;
    };
    expect(run(200_000)).toBe(0);
    // A per-step allocation of even one 16-byte HeapNumber is 16 MB per window and always
    // triggers a scavenge, so no window can be GC-free. One-off engine work (e.g. installing
    // concurrently compiled code under parallel test load) can land a single GC in a window,
    // so up to three windows are measured and one GC-free window is required.
    const gcStarts: number[] = [];
    const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) gcStarts.push(e.startTime); });
    observer.observe({ entryTypes: ["gc"] });
    const windows: number[][] = [];
    for (let w = 0; w < 3; w++) {
      const t0 = performance.now(), failures = run(1_000_000), t1 = performance.now();
      expect(failures).toBe(0);
      windows.push([t0, t1]);
      await new Promise(resolve => setTimeout(resolve, 100));
      if (gcStarts.every(t => t < t0 || t > t1)) break;
    }
    observer.disconnect();
    const perWindow = windows.map(([t0, t1]) => gcStarts.filter(t => t >= t0! && t <= t1!).length);
    expect(perWindow, JSON.stringify(perWindow)).toContain(0);
  }, 120_000);
});
