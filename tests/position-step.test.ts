import { describe, expect, it } from "vitest";
import { PositionStep, GpsOffsetApplier } from "@mirage/ew/position-step";
import { LocalTangentFrame, geodeticToEcefInto } from "@mirage/sensors/geodesy";
import { GridGeoid } from "@mirage/sensors/geoid";
import type { GpsSample } from "../packages/mavlink/src/samples";

// TASK-054. Oracle: the WGS84 frame verified against the independent Python
// fixture in TASK-036. The corrupted fix minus the source fix, expressed in the
// source's local NED frame, must equal the commanded offset.
const deg = (d: number) => (d * Math.PI) / 180;
function fix(latDeg: number, lonDeg: number, altM = 100): GpsSample {
  return { timeLoUs: 123, timeHiUs: 0, latitudeRad: deg(latDeg), longitudeRad: deg(lonDeg), altitudeMslM: altM,
    vnMps: 3, veMps: -4, vdMps: 0.5, hdop: 0.9, vdop: 1.1, hdopValid: true, vdopValid: true, fixType: 3,
    satellites: 14, satellitesValid: true, velocityValid: true, courseRad: 5.4, courseValid: true };
}
/** NED displacement (m) of `b` relative to `a` in a's tangent frame (heights treated as ellipsoidal, N = 0). */
function nedBetween(a: GpsSample, b: GpsSample): number[] {
  const frame = new LocalTangentFrame(a.latitudeRad, a.longitudeRad, a.altitudeMslM), e = new Float64Array(3), out = new Float64Array(3);
  geodeticToEcefInto(b.latitudeRad, b.longitudeRad, b.altitudeMslM, e);
  frame.ecefToNedInto(e[0]!, e[1]!, e[2]!, out);
  return [...out];
}
const close = (actual: number[], expected: number[], tol = 1e-3) =>
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]!), `axis ${i}: ${v} vs ${expected[i]}`).toBeLessThan(tol));

describe("GNSS position step", () => {
  it("applies the offset atomically at the scheduled tick and preserves velocity, time, DOP and fix", () => {
    const step = new PositionStep(), src = fix(47.3, 8.5), out = fix(0, 0);
    expect(step.schedule(120, -80, 0, 1000)).toBe(true);
    step.advanceTick(999);
    expect(step.distortInto(src, out)).toBe(true);
    expect(out).toEqual(src); // not yet due
    step.advanceTick(1000);
    expect(step.isActive).toBe(true);
    expect(step.distortInto(src, out)).toBe(true);
    close(nedBetween(src, out), [120, -80, 0]);
    for (const key of ["vnMps", "veMps", "vdMps", "timeLoUs", "timeHiUs", "hdop", "vdop", "fixType", "satellites", "courseRad", "courseValid"] as const) {
      expect(out[key], key).toBe(src[key]);
    }
  });

  it("follows the Down sign for altitude and handles 10 km offsets", () => {
    const step = new PositionStep(), src = fix(-33.9, 151.2, 50), out = fix(0, 0);
    step.schedule(0, 0, 10, 0); step.advanceTick(0);
    step.distortInto(src, out);
    expect(out.altitudeMslM).toBeCloseTo(40, 6); // +10 m Down is 10 m lower
    expect(out.latitudeRad).toBeCloseTo(src.latitudeRad, 12);
    expect(step.schedule(6000, 7990, -25, 1)).toBe(true); step.advanceTick(1); // |offset| < 10 km
    step.distortInto(src, out);
    close(nedBetween(src, out), [6000, 7990, -25]);
    expect(step.schedule(6000, 8000, -25, 2)).toBe(false); // 10000.03 m > 10 km
  });

  it("wraps across the antimeridian and crosses a pole", () => {
    const step = new PositionStep(), out = fix(0, 0);
    const east = fix(12, 179.99);
    step.schedule(0, 3000, 0, 0); step.advanceTick(0);
    expect(step.distortInto(east, out)).toBe(true);
    expect(out.longitudeRad).toBeLessThan(0); // past +180 deg, reported in [-pi, pi)
    expect(out.longitudeRad).toBeGreaterThanOrEqual(-Math.PI);
    close(nedBetween(east, out), [0, 3000, 0]);
    const polar = fix(89.995, 30);
    step.schedule(1500, 0, 0, 1); step.advanceTick(1);
    expect(step.distortInto(polar, out)).toBe(true);
    close(nedBetween(polar, out), [1500, 0, 0]);
    expect(Math.abs(out.latitudeRad)).toBeLessThanOrEqual(Math.PI / 2);
  });

  it("treats zero, disable and reset as exact baseline, and never mutates the source", () => {
    const step = new PositionStep(), src = fix(60, -20), out = fix(0, 0);
    const before = JSON.stringify(src);
    step.schedule(0, 0, 0, 0); step.advanceTick(0);
    step.distortInto(src, out);
    expect(out).toEqual(src); // zero offset is exact identity
    step.schedule(500, 0, 0, 5); step.advanceTick(5);
    step.distortInto(src, out);
    expect(out.latitudeRad).not.toBe(src.latitudeRad);
    step.disable();
    step.distortInto(src, out);
    expect(out).toEqual(src);
    step.schedule(500, 0, 0, 9); step.reset(); step.advanceTick(10);
    expect([step.isActive, step.scheduledTick]).toEqual([false, -1]);
    expect(JSON.stringify(src)).toBe(before);
    expect(step.distortInto(src, src)).toBe(false);
    const invalid = { ...src, latitudeRad: Number.NaN }, kept = fix(1, 2);
    expect(step.distortInto(invalid, kept)).toBe(false);
    expect(kept).toEqual(fix(1, 2));
    expect(step.schedule(NaN, 0, 0, 0)).toBe(false);
    expect(step.schedule(0, 0, 0, -1)).toBe(false);
    expect(step.schedule(0, 0, 0, 0.5)).toBe(false);
  });

  it("converts MSL through the geoid so H stays MSL after the step", () => {
    // Undulation grows 0.2 m per degree east; a pure Down step keeps lat/lon, so H changes by exactly -D.
    const spec = { latStartDeg: 90, latStepDeg: -90, latCount: 3, lonStartDeg: -180, lonStepDeg: 1, lonCount: 360,
      undulationM: Float64Array.from({ length: 3 * 360 }, (_, i) => 0.2 * (i % 360)),
      provenance: { model: "synthetic", source: "test", license: "test", sha256: "f".repeat(64) } };
    const applier = new GpsOffsetApplier(new GridGeoid(spec)), src = fix(10, 20.5, 300), out = fix(0, 0);
    expect(applier.applyInto(src, 0, 0, -12, out)).toBe(true);
    expect(out.altitudeMslM).toBeCloseTo(312, 6);
    expect(applier.applyInto(src, 0, 1000, 0, out)).toBe(true); // east: undulation changes, H accounts for it
    const n0 = new GridGeoid(spec).undulationM(src.latitudeRad, src.longitudeRad), n1 = new GridGeoid(spec).undulationM(out.latitudeRad, out.longitudeRad);
    expect(n1).toBeGreaterThan(n0);
    const hSrc = src.altitudeMslM + n0, hOut = out.altitudeMslM + n1;
    expect(Math.abs(hOut - hSrc)).toBeLessThan(0.1); // ellipsoidal height barely changes over 1 km east (curvature ~0.08 m)
  });
});
