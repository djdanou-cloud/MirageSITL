import { expect, it } from "vitest";
import { MagneticAnomaly } from "../packages/ew/src/magnetic";
it("uses Rz*Ry*Rx in body axes, preserves rotation norm and applies gauss bias", () => {
  const s = new Float64Array([0.2, 0.3, 0.4]),
    t = new Float64Array(3);
  new MagneticAnomaly([0, 0, 0], [0, 0, 0]).distortInto(s, t);
  expect(t).toEqual(s);
  new MagneticAnomaly([0, 0, Math.PI / 2], [0.1, 0, 0]).distortInto(s, t);
  expect(t[0]).toBeCloseTo(-0.2, 14);
  expect(t[1]).toBeCloseTo(0.2, 14);
  expect(t[2]).toBe(0.4);
  expect(s).toEqual(new Float64Array([0.2, 0.3, 0.4]));
  new MagneticAnomaly([Math.PI / 2, 0, 0], [0, 0, 0]).distortInto(s, t);
  expect(t[1]).toBeCloseTo(-0.4, 14);
  expect(t[2]).toBeCloseTo(0.3, 14);
  expect(Math.hypot(...t)).toBeCloseTo(Math.hypot(...s), 14);
  expect(
    new MagneticAnomaly([0, 0, 0], [0, 0, 0]).distortInto(
      s,
      new Float64Array(s.buffer),
    ),
  ).toBe(false);
});
