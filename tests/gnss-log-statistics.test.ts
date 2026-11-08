import { describe, expect, it } from 'vitest';
import { readDataFlash } from '../packages/dataflash/src/reader.ts';
import { gnssLogStatistics, MODEL_SETTINGS, percentiles } from '../packages/analysis/src/gnss-statistics.ts';
import { gnssSolution } from '../packages/sensors/src/gnss.ts';
import { GPS_ALMANAC } from '../packages/sensors/src/gps-almanac.ts';
import { syntheticLog, type SyntheticMessage, type SyntheticValue } from './support/synthetic-log.ts';

// TASK-117: the logged receiver statistics against a log built here. Declared before the implementation:
//  - only the first receiver's epochs with a 3-D fix or better count; the status table counts every epoch of it;
//  - satellites, HDOP and GPA's accuracies are nearest-rank 5th, 50th and 95th percentiles of the logged values (float32 storage);
//  - the model's geometry is gnssSolution on the constellation effect's defaults (mask 10°, σ 1.5 m) at the logged position and GPS
//    time, one solution per 10 s, equal to calling it directly; since 2026-11-08 on the real GPS almanac of week 2444, and the report
//    gives the weeks between it and the log.
const MESSAGES: readonly SyntheticMessage[] = [
  { type: 72, name: 'GPS', format: 'QBBBffffff', columns: ['TimeUS', 'I', 'Status', 'NSats', 'HDop', 'GWk', 'GMS', 'Lat', 'Lng', 'Alt'] },
  { type: 73, name: 'GPA', format: 'QBfff', columns: ['TimeUS', 'I', 'HAcc', 'VAcc', 'SAcc'] },
];
const WEEK = 2400, LAT = 47.5, LON = 8.5;

function log(): Uint8Array {
  const rows: { message: string; values: SyntheticValue[] }[] = [];
  for (let k = 0; k <= 100; k++) {
    const us = 1e6 + k * 200_000, status = k === 0 ? 1 : k % 2 ? 3 : 4;
    rows.push({ message: 'GPS', values: [us, 0, status, 10 + (k % 21), 0.5 + 0.01 * k, WEEK, 1_000_000 + k * 200, LAT, LON, 0] });
    // A second receiver, never counted.
    rows.push({ message: 'GPS', values: [us + 1, 1, 6, 40, 0.1, WEEK, 1_000_000 + k * 200, LAT, LON, 0] });
    rows.push({ message: 'GPA', values: [us + 2, 0, 0.1 * k, 0.2 * k, 0.01 * k] });
  }
  return syntheticLog(MESSAGES, rows);
}

describe('logged GNSS receiver statistics', () => {
  it('counts the first receiver\'s fixed epochs, its percentiles and the model\'s geometry at the same place and time', () => {
    const stats = gnssLogStatistics(readDataFlash(log()));
    expect(stats.status).toEqual({ '1': 1, '3': 50, '4': 50 });
    expect(stats.epochs).toBe(100);
    expect(stats.durationS).toBeCloseTo(19.8, 9);
    expect(stats.rateHz).toBeCloseTo(5, 9);
    const k = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(stats.satellites).toEqual(percentiles(k.map(i => 10 + (i % 21))));
    expect(stats.hdop.p50).toBeCloseTo(0.5 + 0.01 * 50, 6);
    expect(stats.horizontalAccuracyM?.p95).toBeCloseTo(0.1 * 95, 5);
    expect(stats.verticalAccuracyM?.p5).toBeCloseTo(0.2 * 5, 5);
    expect(stats.speedAccuracyMps?.p50).toBeCloseTo(0.01 * 50, 6);
    const effects = { constellation: { maskRad: MODEL_SETTINGS.maskDeg * Math.PI / 180, uereM: MODEL_SETTINGS.uereM }, atmosphere: null, terrain: null, jamming: null };
    const direct = [1, 51].map(i => gnssSolution(GPS_ALMANAC, { latRad: Math.fround(LAT) * Math.PI / 180, lonRad: Math.fround(LON) * Math.PI / 180, heightM: 0, eastM: 0, northM: 0 },
      WEEK, Math.fround(1_000_000 + i * 200) / 1000, effects));
    expect(stats.model.solutions).toBe(2);
    expect(stats.model.visible).toEqual(percentiles(direct.map(s => s.visible)));
    expect(stats.model.hdop).toEqual(percentiles(direct.map(s => s.dilution!.hdop)));
    expect(stats.model.almanacWeek).toBe(2444);
    expect(stats.model.weeksFromAlmanac).toEqual([WEEK - 2444, WEEK - 2444]);
  });

  it('refuses a log without a fixed receiver', () => {
    expect(() => gnssLogStatistics(readDataFlash(syntheticLog(MESSAGES, [{ message: 'GPA', values: [1, 0, 1, 1, 1] }])))).toThrow('The log has no GPS messages');
  });
});
