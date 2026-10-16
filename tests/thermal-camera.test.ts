// TASK-071: thermal radiometry and palettes (CPU). The shader is compared
// with these functions in tests/browser/thermal.spec.ts.
import { describe, expect, it } from "vitest";
import {
  IRONBOW, SYNTHETIC_LWIR_640, apparentLevel, apparentRadiance, bandRadiance, claimsParityWith, paletteColor, planckSpectral, radianceTable,
  tableRadiance, validateProfile, type InstrumentProfile, type ThermalScene,
} from "../packages/thermal/src/thermal-camera.ts";
import { STEFAN_BOLTZMANN } from "../packages/thermal/src/solar.ts";

const LWIR = [8, 14] as const;
const scene: ThermalScene = { reflectedK: 250, airK: 288, extinctionPerM: 2e-4, spanMinK: 270, spanMaxK: 320 };

describe("radiometry", () => {
  it("integrates Planck to the Stefan-Boltzmann total and peaks at Wien's wavelength", () => {
    for (const t of [250, 300, 400]) {
      const total = bandRadiance(t, [0.2, 2000], 200_000); // 99.99%+ of the spectrum at these temperatures
      expect(Math.abs(total / (STEFAN_BOLTZMANN * t ** 4 / Math.PI) - 1)).toBeLessThan(1e-3);
    }
    // Wien: lambda_max = 2897.77 um K / T.
    const lmax = 2897.771955 / 300 * 1e-6;
    expect(planckSpectral(lmax, 300)).toBeGreaterThan(planckSpectral(lmax * 0.99, 300));
    expect(planckSpectral(lmax, 300)).toBeGreaterThan(planckSpectral(lmax * 1.01, 300));
  });

  it("is strictly monotonic in temperature (blackbody) and the table matches the exact integral", () => {
    let previous = 0;
    for (let t = 150; t <= 405; t += 1) {
      const l = bandRadiance(t, LWIR);
      expect(l).toBeGreaterThan(previous);
      previous = l;
    }
    const table = radianceTable(LWIR);
    for (const t of [200.25, 288.5, 300, 351.75]) expect(Math.abs(tableRadiance(table, t) / bandRadiance(t, LWIR) - 1)).toBeLessThan(2e-4);
  });

  it("weights emission and reflection by emissivity and attenuates with distance", () => {
    const lt = bandRadiance(310, LWIR), lr = bandRadiance(scene.reflectedK, LWIR), la = bandRadiance(scene.airK, LWIR);
    expect(apparentRadiance(310, 1, 0, scene, LWIR)).toBeCloseTo(lt, 9);
    expect(apparentRadiance(310, 0, 0, scene, LWIR)).toBeCloseTo(lr, 9);
    expect(apparentRadiance(310, 0.4, 0, scene, LWIR)).toBeCloseTo(0.4 * lt + 0.6 * lr, 9);
    // Distance: Beer-Lambert towards the path (air) radiance, monotonically.
    let previous = Infinity;
    for (const d of [0, 100, 1000, 5000, 20_000]) {
      const l = apparentRadiance(310, 1, d, scene, LWIR);
      expect(l).toBeLessThan(previous); expect(l).toBeGreaterThan(la);
      previous = l;
    }
    const tau = Math.exp(-2e-4 * 1000);
    expect(apparentRadiance(310, 1, 1000, scene, LWIR)).toBeCloseTo(tau * lt + (1 - tau) * la, 9);
    expect(apparentRadiance(310, 1, 1e7, scene, LWIR)).toBeCloseTo(la, 6);
  });

  it("maps the display span to levels 0 and 1", () => {
    const table = radianceTable(LWIR);
    expect(apparentLevel(table, 270, 1, 0, scene)).toBeCloseTo(0, 6);
    expect(apparentLevel(table, 320, 1, 0, scene)).toBeCloseTo(1, 6);
    expect(apparentLevel(table, 200, 1, 0, scene)).toBe(0);
    expect(apparentLevel(table, 380, 1, 0, scene)).toBe(1);
    expect(apparentLevel(table, 300, 1, 0, scene)).toBeGreaterThan(apparentLevel(table, 290, 1, 0, scene));
  });
});

describe("palettes", () => {
  it("have the documented cold and hot endpoints", () => {
    const c = new Float64Array(3);
    paletteColor("white-hot", 0, c); expect([...c]).toEqual([0, 0, 0]);
    paletteColor("white-hot", 1, c); expect([...c]).toEqual([1, 1, 1]);
    paletteColor("black-hot", 0, c); expect([...c]).toEqual([1, 1, 1]);
    paletteColor("black-hot", 1, c); expect([...c]).toEqual([0, 0, 0]);
    paletteColor("ironbow", 0, c); expect([...c]).toEqual([0, 0, 0]);
    paletteColor("ironbow", 1, c); expect([...c]).toEqual([1, 1, 1]);
    paletteColor("ironbow", 0.6, c);
    expect(c[0]).toBeGreaterThan(c[2]!); // warm middle
    // Ironbow luminance rises monotonically from cold to hot.
    let previous = -1;
    for (let x = 0; x <= 1.0001; x += 0.01) {
      paletteColor("ironbow", x, c);
      const y = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
      expect(y).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = y;
    }
    expect(IRONBOW[0]![0]).toBe(0); expect(IRONBOW.at(-1)![0]).toBe(1);
  });
});

describe("instrument profiles", () => {
  it("keeps synthetic training profiles separate from measured instrument claims", () => {
    validateProfile(SYNTHETIC_LWIR_640);
    expect(SYNTHETIC_LWIR_640.resolution).toEqual([640, 512]);
    expect(claimsParityWith(SYNTHETIC_LWIR_640, "CADEX")).toBe(false);
    const measured: InstrumentProfile = { ...SYNTHETIC_LWIR_640, id: "cadex-measured", calibrationSource: { kind: "measured", instrument: "CADEX", dataSha256: "a".repeat(64) } };
    validateProfile(measured);
    expect(claimsParityWith(measured, "cadex")).toBe(true);
    expect(() => validateProfile({ ...measured, calibrationSource: { kind: "measured", instrument: "CADEX", dataSha256: "" } })).toThrow("calibration data hash");
    expect(() => validateProfile({ ...SYNTHETIC_LWIR_640, resolution: [8, 8] })).toThrow();
    expect(() => validateProfile({ ...SYNTHETIC_LWIR_640, spectralBandUm: [14, 8] })).toThrow();
  });
});

// Oracles carried over from the parallel implementation's tests.
describe("radiometry oracles (merged)", () => {
  it("matches an independent 10 um spectral radiance and the 8-14 um band level at 300 K", () => {
    // 2hc^2/lambda^5/(exp(hc/(lambda k T)) - 1) at 10 um, 300 K = 9.9240333300707 W/(m^2 sr um).
    expect(planckSpectral(10e-6, 300) * 1e-6).toBeCloseTo(9.9240333300707, 9);
    expect(bandRadiance(300, LWIR)).toBeGreaterThan(54);
    expect(bandRadiance(300, LWIR)).toBeLessThan(56);
    for (let t = 101; t <= 999; t++) expect(bandRadiance(t, LWIR)).toBeGreaterThan(bandRadiance(t - 1, LWIR));
  });

  it("obeys the limiting cases exactly", () => {
    const s: ThermalScene = { reflectedK: 280, airK: 290, extinctionPerM: 0.001, spanMinK: 270, spanMaxK: 330 };
    expect(apparentRadiance(320, 1, 0, s, LWIR)).toBe(bandRadiance(320, LWIR));
    expect(apparentRadiance(320, 0, 0, s, LWIR)).toBe(bandRadiance(280, LWIR));
    expect(apparentRadiance(320, 0.5, 0, s, LWIR)).toBeCloseTo((bandRadiance(320, LWIR) + bandRadiance(280, LWIR)) / 2, 12);
    expect(apparentRadiance(320, 1, 1e6, s, LWIR)).toBe(bandRadiance(290, LWIR));
    const tau = Math.exp(-1);
    expect(apparentRadiance(320, 1, 1000, s, LWIR)).toBeCloseTo(tau * bandRadiance(320, LWIR) + (1 - tau) * bandRadiance(290, LWIR), 10);
    const table = radianceTable(LWIR);
    expect(apparentLevel(table, 270, 1, 0, s)).toBe(0);
    expect(apparentLevel(table, 330, 1, 0, s)).toBe(1);
    expect(() => validateProfile({ ...SYNTHETIC_LWIR_640, resolution: [1e9, 512] })).toThrow();
  });
});
