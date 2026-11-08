// TASK-117: the multi-GNSS broadcast sky (SPECS_SIMULATION_ENGINES "Multi-GNSS broadcast sky"). Declared before the implementation:
//  1. the module equals the data file field for field, and the data file's SHA-256 and size equal the offline inventory's (that
//     `node scripts/gnss-broadcast-elements.mjs --check` reproduces both from the RINEX file is run outside the tests, which do not
//     have the file);
//  2. GLONASS: the model at tb returns the broadcast position within 1e-3 m;
//  3. against the file's own records of the same satellites at other times (the data file's checks), the propagated position within
//     0.3° seen from the nearest point of the Earth, an error of at most (|r| − 6,378 km)·0.3·π/180; the GPS almanac likewise
//     against the file's GPS records;
//  4. every BeiDou GEO through the file's day within 3° of the equator and 1 % of the geostationary radius 42,164 km;
//  5. at the default home (32° N, 35° E, 100 m) over T_ref ± 12 h at 10-minute steps, mask 10°: GPS 6 to 14, Galileo 4 to 13,
//     GLONASS 4 to 12, BeiDou 6 to 20 and all 25 to 50 satellites, multi-system HDOP below 1.0 (plausibility bounds).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gnssSolution, glonassEcefInto, satelliteEcefInto, type GnssSystem, type SkySatellite } from '../packages/sensors/src/gnss.ts';
import { GNSS_BROADCAST, GNSS_BROADCAST_SOURCE } from '../packages/sensors/src/gnss-broadcast.ts';
import { GNSS_SKY, GNSS_SKY_EPOCH } from '../packages/sensors/src/gnss-sky.ts';

const bytes = readFileSync(new URL(`../${GNSS_BROADCAST_SOURCE.dataFile}`, import.meta.url));
const data: unknown = JSON.parse(bytes.toString('utf8'));
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
interface Check { readonly system: GnssSystem; readonly prn: number; readonly gpsWeek: number; readonly secondsOfWeek: number; readonly ecefM: readonly [number, number, number] }
const isSystem = (value: unknown): value is GnssSystem => value === 'G' || value === 'E' || value === 'R' || value === 'C';
function checkOf(value: unknown): Check {
  const c = record(value), ecef = list(c.ecefM).map(Number);
  if (!isSystem(c.system) || typeof c.prn !== 'number' || typeof c.gpsWeek !== 'number' || typeof c.secondsOfWeek !== 'number' || ecef.length !== 3 || !ecef.every(Number.isFinite)) {
    throw new Error(`Not a check: ${JSON.stringify(value)}`);
  }
  return { system: c.system, prn: c.prn, gpsWeek: c.gpsWeek, secondsOfWeek: c.secondsOfWeek, ecefM: [ecef[0]!, ecef[1]!, ecef[2]!] };
}
const CHECKS = list(record(data).checks).map(checkOf);
const satelliteOf = (system: GnssSystem, prn: number): SkySatellite | undefined => GNSS_SKY.find(s => s.system === system && s.prn === prn && s.health === 0);

describe('multi-GNSS broadcast sky of 2026-11-07', () => {
  it('equals the data file and the inventory', () => {
    const d = record(data), source = record(d.source), epoch = record(d.referenceEpoch);
    expect(GNSS_BROADCAST).toEqual(d.satellites);
    expect([source.file, source.sha256, source.bytes, source.url]).toEqual([GNSS_BROADCAST_SOURCE.file, GNSS_BROADCAST_SOURCE.sha256, GNSS_BROADCAST_SOURCE.bytes, GNSS_BROADCAST_SOURCE.url]);
    expect([epoch.gpsWeek, epoch.secondsOfWeek]).toEqual([GNSS_SKY_EPOCH.week, GNSS_SKY_EPOCH.secondsOfWeek]);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const inventory = record(JSON.parse(readFileSync(new URL('../config/offline-inventory.json', import.meta.url), 'utf8')));
    const item = list(inventory.items).find(entry => record(entry).id === 'gnss-broadcast');
    expect(item).toMatchObject({ files: [{ path: GNSS_BROADCAST_SOURCE.dataFile, sha256, bytes: bytes.length }] });
    for (const system of ['E', 'R', 'C'] as const) expect(GNSS_BROADCAST.filter(s => s.system === system).length).toBeGreaterThan(15);
  });

  it('returns each GLONASS broadcast position at its tb', () => {
    const out = new Float64Array(3);
    for (const satellite of GNSS_BROADCAST) {
      if (satellite.system !== 'R') continue;
      glonassEcefInto(satellite, satellite.week, satellite.tbS, out);
      const [x, y, z] = satellite.positionM;
      expect(Math.hypot(out[0]! - x, out[1]! - y, out[2]! - z)).toBeLessThan(1e-3);
    }
  });

  it('propagates every satellite to its own records at other times within 0.3° seen from the nearest point of the Earth', () => {
    const out = new Float64Array(3), checked: Record<GnssSystem, number> = { G: 0, E: 0, R: 0, C: 0 };
    for (const check of CHECKS) {
      const satellite = satelliteOf(check.system, check.prn);
      if (!satellite) continue;
      satelliteEcefInto(satellite, check.gpsWeek, check.secondsOfWeek, out);
      const [x, y, z] = check.ecefM, bound = (Math.hypot(x, y, z) - 6378e3) * 0.3 * Math.PI / 180;
      const error = Math.hypot(out[0]! - x, out[1]! - y, out[2]! - z);
      if (!(error <= bound)) throw new Error(`${check.system}${check.prn} at ${check.gpsWeek}/${check.secondsOfWeek}: ${(error / 1000).toFixed(1)} km against ${(bound / 1000).toFixed(1)} km`);
      checked[check.system]++;
    }
    // Every system is checked, the GPS almanac too, at several times per satellite.
    expect(checked.G).toBeGreaterThan(200);
    expect(checked.E).toBeGreaterThan(100);
    expect(checked.R).toBeGreaterThan(100);
    expect(checked.C).toBeGreaterThan(100);
  });

  it('keeps every BeiDou GEO on the equator at the geostationary radius through the day', () => {
    const out = new Float64Array(3), geos = GNSS_BROADCAST.filter(s => s.system === 'C' && s.geo);
    expect(geos.length).toBeGreaterThan(0);
    for (const satellite of geos) {
      for (let t = -43200; t <= 43200; t += 600) {
        satelliteEcefInto(satellite, GNSS_SKY_EPOCH.week, GNSS_SKY_EPOCH.secondsOfWeek + t, out);
        const r = Math.hypot(out[0]!, out[1]!, out[2]!);
        expect(Math.abs(Math.asin(out[2]! / r))).toBeLessThan(3 * Math.PI / 180);
        expect(Math.abs(r - 42164e3)).toBeLessThan(0.01 * 42164e3);
      }
    }
  });

  it('gives a multi-GNSS sky of plausible counts and HDOP at the default home through the day', () => {
    const receiver = { latRad: 32 * Math.PI / 180, lonRad: 35 * Math.PI / 180, heightM: 100, eastM: 0, northM: 0 };
    const effects = { constellation: { maskRad: 10 * Math.PI / 180, uereM: 1.5 }, atmosphere: null, terrain: null, jamming: null };
    const bounds: Record<GnssSystem | 'all', readonly [number, number]> = { G: [6, 14], E: [4, 13], R: [4, 12], C: [6, 20], all: [25, 50] };
    for (let t = -43200; t <= 43200; t += 600) {
      const gpsS = GNSS_SKY_EPOCH.secondsOfWeek + t;
      const solution = gnssSolution(GNSS_SKY, receiver, GNSS_SKY_EPOCH.week + Math.floor(gpsS / 604800), gpsS % 604800, effects);
      const counts: Record<GnssSystem | 'all', number> = { ...solution.visibleBySystem, all: solution.visible };
      for (const key of ['G', 'E', 'R', 'C', 'all'] as const) {
        const [low, high] = bounds[key], n = counts[key];
        if (!(n >= low && n <= high)) throw new Error(`${key}: ${n} satellites at T_ref ${t >= 0 ? '+' : ''}${t / 3600} h, outside ${low} to ${high}`);
      }
      expect(solution.dilution?.hdop ?? Infinity).toBeLessThan(1);
    }
  });
});
