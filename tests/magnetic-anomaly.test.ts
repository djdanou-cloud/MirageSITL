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
it("reconfigures from arrays like a newly constructed anomaly and keeps it on non-finite input", () => {
  // Oracle: the constructor builds its matrix independently of configureFrom.
  const s = new Float64Array([0.2, 0.3, 0.4]),
    expected = new Float64Array(3),
    t = new Float64Array(3),
    anomaly = new MagneticAnomaly([0, 0, 0], [0, 0, 0]);
  new MagneticAnomaly([0.1, -0.2, 0.3], [0.01, 0.02, -0.03]).distortInto(s, expected);
  expect(anomaly.configureFrom([0.1, -0.2, 0.3], [0.01, 0.02, -0.03])).toBe(true);
  anomaly.distortInto(s, t);
  expect(t).toEqual(expected);
  expect(anomaly.configureFrom([0, Number.NaN, 0], [0, 0, 0])).toBe(false);
  anomaly.distortInto(s, t);
  expect(t).toEqual(expected);
});
