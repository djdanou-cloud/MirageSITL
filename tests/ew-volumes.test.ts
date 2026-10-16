import { expect, it } from "vitest";
import { HazardVolumes } from "../packages/ew/src/volumes";
it("bounds inverse-square exposure, cone taper, center and canonical summation", () => {
  const sphere = {
    id: 1,
    shape: "sphere" as const,
    centerNedM: [0, 0, 0] as const,
    radiusM: 10,
    power: 1,
    referenceM: 1,
    minimumM: 1,
  };
  const v = new HazardVolumes([sphere], 0, 1);
  expect(v.severity(0, 0, 0)).toBe(1);
  expect(v.severity(2, 0, 0)).toBe(0.25);
  expect(v.severity(11, 0, 0)).toBe(0);
  const cone = {
    ...sphere,
    shape: "cone" as const,
    axisNed: [1, 0, 0] as const,
    halfAngleRad: Math.PI / 4,
  };
  const c = new HazardVolumes([cone], 0, 1);
  expect(c.severity(0, 0, 0)).toBe(1);
  expect(c.severity(-1, 0, 0)).toBe(0);
  expect(c.severity(2, 2, 0)).toBeCloseTo(0, 14);
  expect(c.severity(2, 0, 0)).toBe(0.25);
  expect(c.severity(2, 1, 0)).toBeGreaterThan(0);
  const other = { ...sphere, id: 2, power: 0.1 };
  expect(new HazardVolumes([other, sphere], 0, 10).severity(3, 0, 0)).toBe(
    new HazardVolumes([sphere, other], 0, 10).severity(3, 0, 0),
  );
  expect(() => new HazardVolumes([sphere, sphere], 0, 1)).toThrow();
  expect(
    () =>
      new HazardVolumes(
        Array.from({ length: 65 }, (_, id) => ({ ...sphere, id })),
        0,
        1,
      ),
  ).toThrow();
  expect(Number.isNaN(v.severity(NaN, 0, 0))).toBe(true);
});
it("keeps typed-array hot inputs immutable and rejects overlapping output", () => {
  const v = new HazardVolumes([], 0, 1),
    position = new Float64Array([1, 2, 3]),
    q = new Float64Array(1);
  expect(v.severityFromNedInto(position, q)).toBe(true);
  expect(q[0]).toBe(0);
  expect(position).toEqual(new Float64Array([1, 2, 3]));
  expect(
    v.severityFromNedInto(position, new Float64Array(position.buffer, 0, 1)),
  ).toBe(false);
});
