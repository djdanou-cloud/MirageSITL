import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { isaTroposphere } from '../packages/physics/src/atmosphere.ts';
import { decimalYearOf, effectiveConditions, magneticNedGauss, WMM_BLACKOUT_NT } from '../packages/sensors/src/environment.ts';
import { FIELD, WorldMagneticModel, parseWmmCoefficients } from '../packages/sensors/src/geomagnetic.ts';
import { EGM96_15_SHA256, NO_GEOID, loadEgm96Geoid, type GeoidModel } from '../packages/sensors/src/geoid.ts';
import { normalGravityMps2 } from '../packages/sensors/src/gravity.ts';

// TASK-148: the effective conditions compose the verified models (gravity, WMM2025, EGM96) and
// TASK-093's air. Each part has its own oracle in its own test; this one checks the composition:
// the heights (h = H + N), the point each model is evaluated at, ISA at the elevation, and a
// measured QNH that round-trips. ArduPilot's SITL test site (CMAC) is the example location.
const DEG = Math.PI / 180;
const magnetic = new WorldMagneticModel(parseWmmCoefficients(readFileSync('data/geomagnetic/WMM_2025.COF', 'utf8')));
let geoid: GeoidModel = NO_GEOID;
beforeAll(async () => { geoid = await loadEgm96Geoid(new Uint8Array(readFileSync('data/geoid/WW15MGH.DAC'))); });
const CMAC = { latitudeDeg: -35.363261, longitudeDeg: 149.16523, groundElevationMslM: 584, decimalYear: 2026.5 };

describe('effective geographic conditions (TASK-148)', () => {
  it('evaluates gravity and the field at the ellipsoidal height of the ground', () => {
    const c = effectiveConditions(CMAC, { geoid, magnetic });
    const n = geoid.undulationM(CMAC.latitudeDeg * DEG, CMAC.longitudeDeg * DEG);
    expect(c.geoid).toEqual({ status: 'AVAILABLE', model: 'EGM96-15min', sha256: EGM96_15_SHA256, undulationM: n });
    expect(c.ellipsoidalHeightM).toBe(584 + n);
    expect(c.gravityMps2).toBe(normalGravityMps2(CMAC.latitudeDeg * DEG, 584 + n));
    const field = new Float64Array(FIELD.count);
    magnetic.fieldInto(CMAC.latitudeDeg * DEG, CMAC.longitudeDeg * DEG, 584 + n, 2026.5, field);
    expect([c.magnetic.northNt, c.magnetic.eastNt, c.magnetic.downNt]).toEqual([field[FIELD.northNt], field[FIELD.eastNt], field[FIELD.downNt]]);
    expect(magneticNedGauss(c)).toEqual([c.magnetic.northNt / 1e5, c.magnetic.eastNt / 1e5, c.magnetic.downNt / 1e5]);
    expect(c.magnetic.zone).toBe('normal');
    // Canberra: an upward field (negative inclination) of about 57,000 nT, gravity near 9.795 m/s².
    expect(c.magnetic.inclinationDeg).toBeLessThan(-60);
    expect(c.magnetic.totalNt).toBeGreaterThan(55000);
    expect(c.gravityMps2).toBeGreaterThan(9.79);
    expect(c.gravityMps2).toBeLessThan(9.80);
  });
  it('gives ISA air at the elevation, or the air of a measured QNH', () => {
    const standard = effectiveConditions(CMAC, { geoid, magnetic }), isa = isaTroposphere(584);
    expect(standard.air.seaLevelPressureSource).toBe('standard');
    expect(Math.abs(standard.air.pressurePa / isa.pressurePa - 1)).toBeLessThan(1e-9);
    expect(Math.abs(standard.air.temperatureK - isa.temperatureK)).toBeLessThan(1e-9);
    const measured = effectiveConditions({ ...CMAC, measuredQnhPa: 102000, temperatureOffsetK: 7 }, { geoid, magnetic });
    expect(measured.air.seaLevelPressureSource).toBe('measured');
    // Back to sea level along the same lapse: the measured QNH again.
    const seaLevelK = 288.15 + 7, back = measured.air.pressurePa / (measured.air.temperatureK / seaLevelK) ** (9.80665 / (287.05287 * 0.0065));
    expect(Math.abs(back / 102000 - 1)).toBeLessThan(1e-12);
    expect(measured.air.temperatureK).toBeCloseTo(seaLevelK - 0.0065 * 584, 12);
    expect(measured.air.densityKgM3).toBeCloseTo(measured.air.pressurePa / (287.05287 * measured.air.temperatureK), 12);
  });
  it('keeps heights provisional and the MSL gate blocked without the hashed grid', () => {
    const c = effectiveConditions(CMAC, { geoid: NO_GEOID, magnetic });
    expect(c.geoid.status).toBe('BLOCKED_EXTERNAL');
    expect(c.geoid.undulationM).toBe(0);
    expect(c.ellipsoidalHeightM).toBe(584);
  });
  it('flags the WMM blackout zone near the magnetic pole', () => {
    // The weakest horizontal field on a 0.5-degree search north of 80 degrees is in the blackout zone.
    const field = new Float64Array(FIELD.count);
    let best = { lat: 0, lon: 0, h: Infinity };
    for (let lat = 80; lat <= 89.5; lat += 0.5) for (let lon = -180; lon < 180; lon += 0.5) {
      magnetic.fieldInto(lat * DEG, lon * DEG, 0, 2026.5, field);
      const h = field[FIELD.horizontalNt] ?? Infinity;
      if (h < best.h) best = { lat, lon, h };
    }
    expect(best.h).toBeLessThan(WMM_BLACKOUT_NT);
    expect(effectiveConditions({ latitudeDeg: best.lat, longitudeDeg: best.lon, groundElevationMslM: 0, decimalYear: 2026.5 }, { geoid, magnetic }).magnetic.zone).toBe('blackout');
  });
  it('rejects locations and conditions outside the declared envelope', () => {
    for (const change of [{ latitudeDeg: 90 }, { longitudeDeg: 181 }, { groundElevationMslM: 9001 }, { groundElevationMslM: Number.NaN },
      { measuredQnhPa: 80000 }, { temperatureOffsetK: 51 }, { decimalYear: 2031 }]) {
      expect(() => effectiveConditions({ ...CMAC, ...change }, { geoid, magnetic })).toThrow();
    }
  });
  it('converts a UTC date to the WMM decimal year', () => {
    expect(decimalYearOf(new Date('2026-01-01T00:00:00Z'))).toBe(2026);
    expect(decimalYearOf(new Date('2026-07-02T12:00:00Z'))).toBe(2026.5);
    expect(decimalYearOf(new Date('2028-07-02T00:00:00Z'))).toBe(2028.5); // 2028 is a leap year: day 183 of 366
    expect(() => decimalYearOf(new Date(Number.NaN))).toThrow();
  });
});
