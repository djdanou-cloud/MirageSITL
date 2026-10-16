import fixture from "./fixtures/sensors/ideal.json";
import { expect, it } from "vitest";
import {
  newSensorFrameV2,
  SensorKindV2,
  isValidSensorFrameV2,
} from "@mirage/protocol";
import { newBodyTruth } from "@mirage/wasm-bet/backend";
import { IdealSensors, type SensorTruth } from "@mirage/sensors/ideal";
function magnetic(): readonly [number, number, number] {
  const [x, y, z] = fixture.magneticNedGauss;
  if (x === undefined || y === undefined || z === undefined)
    throw new Error("Invalid magnetic fixture");
  return [x, y, z];
}
function truth(): SensorTruth {
  return {
    ...newBodyTruth(),
    epoch: 1,
    tickId: { lo: 1, hi: 0 },
    sampleTimeUs: { lo: 2500, hi: 0 },
    windNedMps: new Float64Array(3),
  };
}
it("distinguishes stationary specific force from free fall in FRD", () => {
  const sensors = new IdealSensors(magnetic()),
    t = truth(),
    out = newSensorFrameV2();
  expect(sensors.sampleInto(SensorKindV2.Imu, t, out)).toBe(true);
  expect(out.values[2]).toBe(fixture.stationarySpecificForceFrd[2]);
  expect(isValidSensorFrameV2(out)).toBe(true);
  t.accelerationNedMps2[2] = 9.80665;
  sensors.sampleInto(SensorKindV2.Imu, t, out);
  expect(out.values[2]).toBe(0);
  t.accelerationNedMps2[2] = 0;
  t.quaternionBodyToNed.set([0, 1, 0, 0]);
  sensors.sampleInto(SensorKindV2.Imu, t, out);
  expect(out.values[2]).toBeCloseTo(9.80665, 10);
});
it("rotates magnetic axes and derives pressure/airspeed with correct units and signs", () => {
  const sensors = new IdealSensors(magnetic()),
    t = truth(),
    out = newSensorFrameV2();
  t.quaternionBodyToNed.set([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  sensors.sampleInto(SensorKindV2.Magnetometer, t, out);
  expect(out.values[0]).toBeCloseTo(0, 12);
  expect(out.values[1]).toBeCloseTo(-0.2, 12);
  sensors.sampleInto(SensorKindV2.Barometer, t, out);
  expect(out.values[0]).toBe(fixture.seaLevelPressurePa);
  t.positionNedM[2] = -1000;
  sensors.sampleInto(SensorKindV2.Barometer, t, out);
  expect(out.values[0]!).toBeLessThan(101325);
  t.positionNedM[2] = 0;
  t.velocityNedMps[0] = 10;
  sensors.sampleInto(SensorKindV2.Airspeed, t, out);
  expect(out.values[0]).toBeCloseTo(61.2500009, 5);
  expect(isValidSensorFrameV2(out)).toBe(true);
});
