import { expect, it } from "vitest";
import { MotorFaults } from "../packages/physics/src/motor-fault";
it("cuts only the selected stable-ID drive and preserves passive air loads", () => {
  const f = new MotorFaults([7, 3]),
    source = new Float64Array([0, 0, -5, 0, 0, 0.2]),
    out = new Float64Array(6);
  expect(f.set(7, "power-cut", 0)).toBe(true);
  expect(f.driveTorque(7, 1)).toBe(0);
  expect(f.driveTorque(3, 1)).toBe(1);
  f.wrenchInto(7, source, out);
  expect(out).toEqual(source);
  expect(f.outsideValidity(7)).toBe(false);
  f.set(7, "instant-thrust-loss", 0);
  f.wrenchInto(7, source, out);
  expect(out.every((x) => x === 0)).toBe(true);
  expect(f.outsideValidity(7)).toBe(true);
  expect(f.vehicleFlags).toBe(32);
  f.wrenchInto(3, source, out);
  expect(out).toEqual(source);
  f.reset();
  expect(f.vehicleFlags).toBe(0);
  expect(f.driveTorque(7, 1)).toBe(1);
  expect(f.set(1, "power-cut", 0)).toBe(false);
  expect(f.set(7, "power-cut", NaN)).toBe(false);
});
it("accepts varying drive torque through an allocation-free numeric boundary", () => {
  const f = new MotorFaults([7]),
    source = new Float64Array([2.5]),
    out = new Float64Array(1);
  f.set(7, "power-cut", 0.2);
  expect(f.driveTorqueFromArrayInto(7, source, out)).toBe(true);
  expect(out[0]).toBe(0.5);
  expect(source[0]).toBe(2.5);
  source[0] = NaN;
  expect(f.driveTorqueFromArrayInto(7, source, out)).toBe(false);
  expect(out[0]).toBe(0.5);
});
