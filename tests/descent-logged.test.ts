import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildProfileDynamics } from '@mirage/physics/profile-dynamics';
import type { BetFlightConfiguration } from '@mirage/physics/bet-dynamics';
import { readDataFlash } from '../packages/dataflash/src/reader.ts';
import { DESCENT_METHOD, descentClasses, descentReproduced, measureDescent, type DescentAircraft, type DescentClass, type DescentFlight } from '../packages/analysis/src/descent-log.ts';
import { buildPavo, heldAt, hoverCommand } from './support/pavo.ts';
import { syntheticLog, type SyntheticMessage, type SyntheticValue } from './support/synthetic-log.ts';

// TASK-099, logged descent (SPECS_SIMULATION_ENGINES "Logged descent"). Declared before the implementation:
//  - on a log built here whose thrust per squared speed is 1.03 in a 2 m/s descent and 0.95 in a 2 m/s climb against hover, the
//    measurement gives those ratios per class within float32 storage (1e-6) and V_z/v_h from the stated mass, radius and pressure
//    within 1e-6; NaN and 540,800 rpm rows are rejected, and a zero-throttle stretch and a 60° tumble remove their bins and every
//    bin within 1 s of them;
//  - the Pavo model held on its hover command gives less thrust per squared speed in a climb of 0.15 v_h and more in a descent of
//    0.3 v_h than at zero climb, the signs of momentum theory and of Johnson's curve between D and N;
//  - with MIRAGE_FORUM_LOG_DIR set, the Pavo's 18 armed logs are checked by SHA-256, measured and compared class by class with
//    the model at V_x 0 and 2 m/s; MIRAGE_DESCENT_OUT writes the report. The comparison is reported, whatever its outcome.

const MESSAGES: readonly SyntheticMessage[] = [
  { type: 80, name: 'ESC', format: 'QBf', columns: ['TimeUS', 'Instance', 'RPM'] },
  { type: 81, name: 'IMU', format: 'QBf', columns: ['TimeUS', 'I', 'AccZ'] },
  { type: 82, name: 'CTUN', format: 'Qfff', columns: ['TimeUS', 'ThO', 'Alt', 'CRt'] },
  { type: 83, name: 'ATT', format: 'Qff', columns: ['TimeUS', 'Roll', 'Pitch'] },
  { type: 84, name: 'BARO', format: 'QBf', columns: ['TimeUS', 'I', 'Press'] },
];
const PAVO: DescentAircraft = { massKg: 0.169, rotorRadiusM: 0.02794, maxRpm: 8000 * 13.05 };
const G = 9.80665, PRESSURE_PA = 101325, RPM = 22000;
/** 60 s: hover to 20 s, a 2 m/s descent to 30 s, hover to 40 s, a 2 m/s climb to 50 s, hover with a cut at 54 s and a tumble at 57 s. */
function flightLog(): Uint8Array {
  const rows: { message: string; values: SyntheticValue[] }[] = [];
  const climb = (t: number) => (t >= 20 && t < 30 ? -2 : t >= 40 && t < 50 ? 2 : 0), gain = (t: number) => (t >= 20 && t < 30 ? 1.03 : t >= 40 && t < 50 ? 0.95 : 1);
  const k = G / RPM ** 2;
  for (let n = 0; n < 60 * 400; n++) {
    const t = n / 400, us = Math.round(t * 1e6) + 1, cut = t >= 54 && t < 54.3, tumble = t >= 57 && t < 57.2;
    const rpm = (n % 97 === 0) ? Number.NaN : (n % 131 === 0) ? 540800 : RPM;
    rows.push({ message: 'ESC', values: [us, n % 4, rpm] });
    if (n % 4 === 0) rows.push({ message: 'IMU', values: [us + 1, 0, -k * gain(t) * RPM ** 2] });
    if (n % 40 === 0) rows.push({ message: 'CTUN', values: [us + 2, cut ? 0 : 0.2, 5, climb(t) * 100] });
    if (n % 40 === 0) rows.push({ message: 'ATT', values: [us + 3, tumble ? 60 : 0, 0] });
    if (n % 40 === 0) rows.push({ message: 'BARO', values: [us + 4, 0, PRESSURE_PA] });
  }
  return syntheticLog(MESSAGES, rows);
}

let module: WebAssembly.Module;
let pavo: BetFlightConfiguration;
let command = 0;
beforeAll(async () => {
  execFileSync(process.execPath, ['scripts/build-wasm.mjs'], { stdio: 'pipe' });
  module = new WebAssembly.Module(readFileSync('packages/wasm-bet/dist/mirage_bet.scalar.wasm'));
  pavo = buildProfileDynamics((await buildPavo()).derived.manifest).configuration;
  command = hoverCommand(module, pavo, PAVO.massKg * G);
}, 900_000);

/** The model held on the hover command at a climb rate and transverse speed: thrust per squared speed and V_z/v_h. */
function model(climbMps: number, transverseMps: number) {
  const held = heldAt(module, pavo, command, { climbMps, transverseMps, settleS: 0.5, measureS: 2 });
  const hover = Math.sqrt(held.forceUpN / 4 / (2 * pavo.densityKgM3 * Math.PI * PAVO.rotorRadiusM ** 2));
  return { k: held.forceUpN / held.meanOmega2, scaledClimb: climbMps / hover, hoverInflowMps: hover, fluctuationShare: held.fluctuationSteps / held.measuredSteps, forceUpN: held.forceUpN };
}

describe('logged descent (TASK-099)', () => {
  it('measures thrust per squared speed against the scaled climb rate, rejecting glitches and what is not airborne', () => {
    const flight = measureDescent(readDataFlash(flightLog()), { ...PAVO, unscaledClimbRateToMps: 0.01 });
    expect(flight.rejectedEscRows).toBeGreaterThan(300);
    expect(flight.densityKgM3).toBeCloseTo(PRESSURE_PA / (287.053 * 288.15), 6);
    const hover = Math.sqrt(PAVO.massKg * G / (8 * flight.densityKgM3 * Math.PI * PAVO.rotorRadiusM ** 2));
    const [descending] = flight.bins.filter(b => b.timeS > 21 && b.timeS < 29), [climbing] = flight.bins.filter(b => b.timeS > 41 && b.timeS < 49);
    expect(Math.abs(descending!.ratio - 1.03)).toBeLessThan(1e-6);
    expect(Math.abs(climbing!.ratio - 0.95)).toBeLessThan(1e-6);
    expect(Math.abs(descending!.scaledClimb + 2 / (hover * Math.sqrt(1.03)))).toBeLessThan(1e-6);
    expect(Math.abs(climbing!.hoverInflowMps - hover * Math.sqrt(0.95))).toBeLessThan(1e-6 * hover);
    // The cut at 54 s and the tumble at 57 s take their own bins and everything within 1 s of them.
    for (const b of flight.bins) {
      expect(b.timeS < 53 - 1e-9 || b.timeS > 55.3 - 1e-9).toBe(true);
      expect(b.timeS < 56 - 1e-9 || b.timeS > 58.2 - 1e-9).toBe(true);
    }
    expect(flight.rejected['airborne-window']).toBeGreaterThan(30);
    const classes = descentClasses([{ name: 'synthetic', flight }]);
    const scaled = 2 / hover;
    const inClass = (c: DescentClass, x: number) => (x < 0 ? x >= c.fromScaledClimb && x < c.toScaledClimb : x > c.fromScaledClimb && x <= c.toScaledClimb);
    const down = classes.find(c => inClass(c, -scaled / Math.sqrt(1.03))), up = classes.find(c => inClass(c, scaled / Math.sqrt(0.95)));
    expect(Math.abs(down!.ratio! - 1.03)).toBeLessThan(1e-6);
    expect(Math.abs(up!.ratio! - 0.95)).toBeLessThan(1e-6);
    // Widened by 2 x 0.001 + 0.02: 1.009 reaches 1.031, 1.007 only 1.029.
    expect(descentReproduced(1.03, 0.001, 1.0, 1.009)).toBe(true);
    expect(descentReproduced(1.03, 0.001, 1.0, 1.007)).toBe(false);
    expect(descentReproduced(1.0301, 0.0, 0.99, 1.01)).toBe(false);
  });

  it('gives the Pavo model less thrust per squared speed in a climb and more in a moderate descent', () => {
    const zero = model(0, 0), hover = zero.hoverInflowMps;
    expect(model(0.15 * hover, 0).k / zero.k).toBeLessThan(1);
    expect(model(-0.3 * hover, 0).k / zero.k).toBeGreaterThan(1);
  }, 600_000);

  const dir = process.env.MIRAGE_FORUM_LOG_DIR ?? '';
  const inventory = JSON.parse(readFileSync(new URL('../data/flight-logs/inventory.json', import.meta.url), 'utf8')) as { logs: { file: string; sha256: string; aircraft: string; notes: string }[] };
  const files = inventory.logs.filter(item => item.aircraft === 'stakeholder-pavo20pro2' && !item.notes.startsWith('never armed'));
  it.skipIf(dir === '' || !files.every(item => existsSync(join(dir, item.file))))('compares the stakeholder\'s Pavo descents with the model, class by class', () => {
    expect(files).toHaveLength(18);
    const flights: { name: string; sha256: string; flight: DescentFlight }[] = [];
    for (const item of files) {
      const bytes = readFileSync(join(dir, item.file));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      expect(sha256, item.file).toBe(item.sha256);
      flights.push({ name: item.file, sha256, flight: measureDescent(readDataFlash(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)), PAVO) });
    }
    const used = flights.filter(f => f.flight.bins.length > 0);
    const classes = descentClasses(used), level = descentClasses(used, DESCENT_METHOD.levelTiltDeg);
    const zero = new Map([0, 2].map(vx => [vx, model(0, vx)]));
    const hover0 = zero.get(0)!.hoverInflowMps;
    const rows = classes.map((c, i) => {
      const runs = c.meanScaledClimb === null ? [] : [0, 2].map(vx => {
        const run = model(c.meanScaledClimb! * hover0, vx);
        return { transverseMps: vx, climbMps: c.meanScaledClimb! * hover0, scaledClimb: run.scaledClimb, ratio: run.k / zero.get(vx)!.k, fluctuationShare: run.fluctuationShare };
      });
      const low = runs.length ? Math.min(...runs.map(r => r.ratio)) : null, high = runs.length ? Math.max(...runs.map(r => r.ratio)) : null;
      const reproduced = c.ratio === null || low === null || high === null ? null : descentReproduced(c.ratio, c.standardError, low, high);
      return { ...c, level: level[i]!, model: runs, modelLow: low, modelHigh: high, reproduced };
    });
    for (const row of rows) if (row.samples > 0) expect(row.model).toHaveLength(2);
    const bins = used.flatMap(f => f.flight.bins.map(b => ({ file: f.name, ...b })));
    const deepest = bins.reduce((a, b) => (b.scaledClimb < a.scaledClimb ? b : a));
    const reference = bins.filter(b => Math.abs(b.scaledClimb) <= DESCENT_METHOD.referenceMaxScaledClimb).map(b => b.hoverInflowMps).sort((a, b) => a - b);
    const out = process.env.MIRAGE_DESCENT_OUT;
    if (out) writeFileSync(out, `${JSON.stringify({ schemaVersion: 1, kind: 'logged-descent', aircraft: 'stakeholder-pavo20pro2', method: DESCENT_METHOD, measuredAircraft: PAVO,
      flights: flights.map(f => ({ file: f.name, sha256: f.sha256, densityKgM3: f.flight.densityKgM3, referenceBins: f.flight.referenceBins, countedBins: f.flight.bins.length,
        rejected: f.flight.rejected, rejectedEscRows: f.flight.rejectedEscRows })),
      model: { command, hoverInflowMps: hover0, densityKgM3: pavo.densityKgM3, transverseMps: [0, 2], settleS: 0.5, measureS: 2, hz: 800 },
      hoverInflowMedianMps: reference[Math.floor(reference.length / 2)] ?? null,
      deepestDescent: { file: deepest.file, timeS: deepest.timeS, climbMps: deepest.climbMps, scaledClimb: deepest.scaledClimb, ratio: deepest.ratio },
      binsBeyondJohnsonN: bins.filter(b => b.scaledClimb < -0.45).length, classes: rows,
      status: rows.every(r => r.reproduced !== false) ? 'REPRODUCED' : 'NOT_REPRODUCED' }, null, 2)}\n`);
  }, 1_800_000);
});
