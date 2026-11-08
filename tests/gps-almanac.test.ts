// TASK-117: the real GPS almanac of week 2444 (SPECS_SIMULATION_ENGINES "Real GPS almanac"). Declared before the implementation:
//  - the module equals the stored file parsed by parseYumaAlmanac, field for field, and the file's SHA-256 and size equal the
//    offline inventory's;
//  - every satellite's orbital radius from almanacEcefInto within 1e-6 m of a(1 − e cos E) over a day, E solved here, and after one
//    period 2π/n its ECEF position, turned about z by the node's ECEF motion over that period, back at its start within 1e-3 m;
//  - at the default home (32° N, 35° E) over the 24 h from the time of applicability, 10° mask: 6 to 14 healthy satellites at every
//    10-minute step and HDOP below 2.5 throughout (a plausibility bound for a GPS-only sky, not a fidelity limit).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { almanacEcefInto, dilution, GPS_EARTH_RATE_RADS, GPS_MU, parseYumaAlmanac, visibleSatellites } from '../packages/sensors/src/gnss.ts';
import { GPS_ALMANAC, GPS_ALMANAC_SOURCE } from '../packages/sensors/src/gps-almanac.ts';

const bytes = readFileSync(new URL(`../${GPS_ALMANAC_SOURCE.file}`, import.meta.url));

describe('real GPS almanac of week 2444', () => {
  it('equals the stored file and the inventory', () => {
    const parsed = parseYumaAlmanac(bytes.toString('ascii'), week => 2048 + week);
    expect(GPS_ALMANAC).toEqual(parsed);
    expect(parsed).toHaveLength(32);
    expect(new Set(parsed.map(s => s.toaS))).toEqual(new Set([GPS_ALMANAC_SOURCE.toaS]));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    expect([sha256, bytes.length]).toEqual([GPS_ALMANAC_SOURCE.sha256, GPS_ALMANAC_SOURCE.bytes]);
    const inventory: unknown = JSON.parse(readFileSync(new URL('../config/offline-inventory.json', import.meta.url), 'utf8'));
    const items = typeof inventory === 'object' && inventory !== null && 'items' in inventory && Array.isArray(inventory.items) ? inventory.items : [];
    const item: unknown = items.find((entry: unknown) => typeof entry === 'object' && entry !== null && 'id' in entry && entry.id === 'gps-almanac');
    expect(item).toMatchObject({ files: [{ path: GPS_ALMANAC_SOURCE.file, sha256, bytes: bytes.length }] });
  });

  it('propagates orbits that keep their radius and close after one period', () => {
    const out = new Float64Array(3), start = new Float64Array(3);
    for (const satellite of GPS_ALMANAC) {
      const a = satellite.sqrtA ** 2, n = Math.sqrt(GPS_MU / a ** 3), e = satellite.eccentricity;
      for (let t = 0; t <= 86400; t += 900) {
        almanacEcefInto(satellite, 2444, GPS_ALMANAC_SOURCE.toaS + t, out);
        let anomaly = satellite.meanAnomalyRad + n * t;
        for (let i = 0; i < 50; i++) anomaly -= (anomaly - e * Math.sin(anomaly) - (satellite.meanAnomalyRad + n * t)) / (1 - e * Math.cos(anomaly));
        expect(Math.abs(Math.hypot(out[0]!, out[1]!, out[2]!) - a * (1 - e * Math.cos(anomaly)))).toBeLessThan(1e-6);
      }
      const period = 2 * Math.PI / n, turn = (satellite.rateOfRightAscensionRadS - GPS_EARTH_RATE_RADS) * period;
      almanacEcefInto(satellite, 2444, GPS_ALMANAC_SOURCE.toaS, start);
      almanacEcefInto(satellite, 2444, GPS_ALMANAC_SOURCE.toaS + period, out);
      // Undo the node's ECEF rotation over the period: rotate the end position by −turn about z.
      const x = out[0]! * Math.cos(turn) + out[1]! * Math.sin(turn), y = -out[0]! * Math.sin(turn) + out[1]! * Math.cos(turn);
      expect(Math.hypot(x - start[0]!, y - start[1]!, out[2]! - start[2]!)).toBeLessThan(1e-3);
    }
  });

  it('gives a GPS-only sky of 6 to 14 satellites and HDOP below 2.5 at the default home through a day', () => {
    const receiver = { latRad: 32 * Math.PI / 180, lonRad: 35 * Math.PI / 180, heightM: 100 };
    let fewest = Infinity, most = 0, worst = 0;
    for (let t = 0; t <= 86400; t += 600) {
      const views = visibleSatellites(GPS_ALMANAC, receiver, 2444, GPS_ALMANAC_SOURCE.toaS + t, 10 * Math.PI / 180);
      const d = dilution(views.map(v => v.lineOfSight));
      fewest = Math.min(fewest, views.length); most = Math.max(most, views.length); worst = Math.max(worst, d?.hdop ?? Infinity);
    }
    expect(fewest).toBeGreaterThanOrEqual(6);
    expect(most).toBeLessThanOrEqual(14);
    expect(worst).toBeLessThan(2.5);
  });
});
