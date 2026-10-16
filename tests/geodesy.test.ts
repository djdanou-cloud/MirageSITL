import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LocalTangentFrame,
  WGS84_A_M,
  WGS84_B_M,
  ecefToGeodeticInto,
  geodeticToEcefInto,
  wrapLongitudeRad,
} from "@mirage/sensors/geodesy";
import { GridGeoid, NO_GEOID, ellipsoidalHeightM, mslAccuracyGate, mslHeightM, type GeoidGridSpec } from "@mirage/sensors/geoid";
import fixture from "./fixtures/geodesy/wgs84.json";

// TASK-036. Oracle: tests/fixtures/geodesy/wgs84.json, produced by an independent
// Python implementation (closed-form forward, fixed-point inverse).
const MM = 1e-3;
const out = new Float64Array(3), ecef = new Float64Array(3);
/** Distance (m) between two geodetic points, measured in ECEF so poles/antimeridian need no care. */
function separationM(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const pa = new Float64Array(3), pb = new Float64Array(3);
  geodeticToEcefInto(a[0], a[1], a[2], pa);
  geodeticToEcefInto(b[0], b[1], b[2], pb);
  return Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!, pa[2]! - pb[2]!);
}

describe("WGS84 geodesy", () => {
  it("matches the oracle ECEF and inverts every reference point within 1 mm", () => {
    expect(fixture.constants).toEqual({ aM: WGS84_A_M, inverseFlattening: 298.257223563 });
    for (const p of fixture.points) {
      geodeticToEcefInto(p.latRad, p.lonRad, p.heightM, ecef);
      expect(Math.hypot(ecef[0]! - p.ecefM[0]!, ecef[1]! - p.ecefM[1]!, ecef[2]! - p.ecefM[2]!), p.name).toBeLessThan(1e-6);
      ecefToGeodeticInto(p.ecefM[0]!, p.ecefM[1]!, p.ecefM[2]!, out);
      expect(separationM([out[0]!, out[1]!, out[2]!], [p.latRad, p.lonRad, p.heightM]), p.name).toBeLessThan(MM);
      expect(Math.abs(out[2]! - p.heightM), p.name).toBeLessThan(MM);
      expect(out.every(Number.isFinite), p.name).toBe(true);
    }
    // Independent closed forms: equator radius a, pole radius b.
    geodeticToEcefInto(0, 0, 0, ecef);
    expect([...ecef]).toEqual([WGS84_A_M, 0, 0]);
    geodeticToEcefInto(Math.PI / 2, 0, 0, ecef);
    expect(Math.abs(ecef[2]! - WGS84_B_M)).toBeLessThan(1e-9);
    ecefToGeodeticInto(0, 0, -WGS84_B_M - 250, out);
    expect([out[0], out[1]]).toEqual([-Math.PI / 2, 0]);
    expect(Math.abs(out[2]! - 250)).toBeLessThan(1e-9);
  });

  it("maps 15 km NED offsets across poles and the antimeridian to the oracle within 1 mm", () => {
    for (const t of fixture.tangent) {
      const frame = new LocalTangentFrame(t.originLatRad, t.originLonRad, t.originHeightM);
      const [n = NaN, e = NaN, d = NaN] = t.nedM;
      frame.nedToEcefInto(n, e, d, ecef);
      expect(Math.hypot(ecef[0]! - t.ecefM[0]!, ecef[1]! - t.ecefM[1]!, ecef[2]! - t.ecefM[2]!), t.name).toBeLessThan(MM);
      frame.nedToGeodeticInto(n, e, d, out);
      expect(separationM([out[0]!, out[1]!, out[2]!], [t.latRad, t.lonRad, t.heightM]), t.name).toBeLessThan(MM);
      expect(out[1]!, t.name).toBeGreaterThanOrEqual(-Math.PI);
      expect(out[1]!, t.name).toBeLessThan(Math.PI);
      // Roundtrip back into the same frame.
      frame.geodeticToNedInto(out[0]!, out[1]!, out[2]!, ecef);
      expect(Math.hypot(ecef[0]! - n, ecef[1]! - e, ecef[2]! - d), t.name).toBeLessThan(MM);
    }
  });

  it("roundtrips a dense synthetic grid of local offsets within 1 mm, including at the poles", () => {
    const origins: [number, number, number][] = [[0, 0, 0], [Math.PI / 2, 0, 0], [-Math.PI / 2, 2, 500],
      [1.2, Math.PI - 1e-9, 10], [-0.7, -Math.PI, 2000], [0.9, 0.3, -400]];
    let worst = 0;
    for (const [lat, lon, h] of origins) {
      const frame = new LocalTangentFrame(lat, lon, h);
      for (let n = -15000; n <= 15000; n += 2500) {
        for (let e = -15000; e <= 15000; e += 2500) {
          for (const d of [-15000, -100, 0, 300]) {
            frame.nedToGeodeticInto(n, e, d, out);
            frame.geodeticToNedInto(out[0]!, out[1]!, out[2]!, ecef);
            worst = Math.max(worst, Math.hypot(ecef[0]! - n, ecef[1]! - e, ecef[2]! - d));
          }
        }
      }
      frame.nedToGeodeticInto(0, 0, 0, out); // the origin itself
      expect(Math.abs(out[0]! - lat) + Math.abs(out[2]! - h)).toBeLessThan(1e-9);
    }
    expect(worst).toBeLessThan(MM);
  });

  it("keeps NED axes orthonormal with Down along the inward ellipsoid normal", () => {
    const frame = new LocalTangentFrame(0.6, -2.1, 0);
    const r = frame.ecefToNed;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = r[3 * i]! * r[3 * j]! + r[3 * i + 1]! * r[3 * j + 1]! + r[3 * i + 2]! * r[3 * j + 2]!;
        expect(Math.abs(dot - (i === j ? 1 : 0))).toBeLessThan(1e-15);
      }
    }
    frame.nedToGeodeticInto(0, 0, -100, out); // 100 m up along the normal changes h only
    expect(Math.abs(out[0]! - 0.6)).toBeLessThan(1e-12);
    expect(Math.abs(out[2]! - 100)).toBeLessThan(1e-6);
  });

  it("wraps longitude into [-pi, pi) and rejects invalid origins", () => {
    expect(wrapLongitudeRad(Math.PI)).toBe(-Math.PI);
    expect(wrapLongitudeRad(-Math.PI)).toBe(-Math.PI);
    expect(wrapLongitudeRad(3 * Math.PI + 0.5)).toBeCloseTo(-Math.PI + 0.5, 12);
    // Through the Earth to the antipode (-a, +0, 0): atan2 gives +pi; the frame reports -pi.
    new LocalTangentFrame(0, 0, 0).nedToGeodeticInto(0, 0, 2 * WGS84_A_M, out);
    expect([out[0], out[1]]).toEqual([0, -Math.PI]);
    expect(Math.abs(out[2]!)).toBeLessThan(1e-6);
    for (const [lat, lon, h] of [[NaN, 0, 0], [1.6, 0, 0], [0, Infinity, 0], [0, 0, 2e5]]) {
      expect(() => new LocalTangentFrame(lat!, lon!, h!)).toThrow();
    }
  });
});

describe("geoid and MSL height", () => {
  const sha = createHash("sha256").update("synthetic grid").digest("hex");
  // Synthetic 4 x 4 grid (90 deg steps) with N = 10*row + col, so bilinear values are exact.
  const spec: GeoidGridSpec = {
    latStartDeg: 90, latStepDeg: -60, latCount: 4, lonStartDeg: -180, lonStepDeg: 90, lonCount: 4,
    undulationM: Float64Array.from({ length: 16 }, (_, i) => 10 * Math.floor(i / 4) + (i % 4)),
    provenance: { model: "synthetic-test-grid", source: "tests/geodesy.test.ts", license: "test-only", sha256: sha },
  };
  const rad = (deg: number) => (deg * Math.PI) / 180;

  it("interpolates bilinearly, wraps longitude, and clamps latitude", () => {
    const g = new GridGeoid(spec);
    expect(g.undulationM(rad(90), rad(-180))).toBe(0);
    expect(g.undulationM(rad(30), rad(-90))).toBeCloseTo(11, 12);
    expect(g.undulationM(rad(60), rad(-135))).toBeCloseTo(5 + 0.5, 12); // halfway in both axes
    expect(g.undulationM(rad(30), rad(180))).toBeCloseTo(10, 12); // +180 wraps onto -180
    expect(g.undulationM(rad(30), rad(135))).toBeCloseTo(13 + 0.5 * (10 - 13), 12); // cell spanning the antimeridian
    expect(g.undulationM(rad(-90), rad(-180))).toBe(30);
  });

  it("converts H = h - N and back, and gates absolute MSL accuracy on authoritative data", () => {
    const g = new GridGeoid(spec);
    const lat = rad(30), lon = rad(-90);
    expect(mslHeightM(g, lat, lon, 500)).toBeCloseTo(489, 12);
    expect(ellipsoidalHeightM(g, lat, lon, 489)).toBeCloseTo(500, 12);
    expect(mslAccuracyGate(g)).toEqual({ status: "AVAILABLE", model: "synthetic-test-grid", sha256: sha });
    expect(mslAccuracyGate(g, "0".repeat(64)).status).toBe("BLOCKED_EXTERNAL");
    // Without a geoid, MSL equals h and the gate refuses to pass.
    expect(mslHeightM(NO_GEOID, lat, lon, 500)).toBe(500);
    expect(mslAccuracyGate(NO_GEOID)).toMatchObject({ status: "BLOCKED_EXTERNAL", reason: expect.stringMatching(/No authoritative geoid/) as unknown });
  });

  it("rejects malformed grids and missing provenance", () => {
    const bad: Partial<GeoidGridSpec>[] = [{ latCount: 1 }, { lonStepDeg: 45 }, { latStartDeg: 95 },
      { undulationM: new Float64Array(15) }, { undulationM: new Float64Array(16).fill(NaN) },
      { provenance: { ...spec.provenance, sha256: "abc" } }, { provenance: { ...spec.provenance, license: "" } }];
    for (const change of bad) expect(() => new GridGeoid({ ...spec, ...change }), JSON.stringify(Object.keys(change))).toThrow();
  });
});
