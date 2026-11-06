import { describe, expect, it } from 'vitest';
import { readDataFlash } from '../packages/dataflash/src/reader.ts';
import { writeDataFlash } from '../packages/dataflash/src/writer.ts';
import { assessFidelity, logOrigin, pairedSeries, type FidelityRow } from '../packages/analysis/src/fidelity.ts';
import { ARDUPILOT_MESSAGES, syntheticLog, type SyntheticValue } from './support/synthetic-log.ts';
import { createHash } from 'node:crypto';
import { validateComponentCard } from '../packages/aircraft/src/components.ts';
import { flightCheckOf, saveFidelityComparison, validateFidelityComparison } from '../packages/aircraft/src/fidelity-comparison.ts';
import { profileDraft, validateAircraftProfile } from '../packages/aircraft/src/profile.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import { fidelityReport } from '../apps/web/src/experiments/fidelity-report.ts';
import { exampleCard, quadProfile } from './support/quad-profile.ts';

// TASK-184: the fidelity assessment against a flight built here, whose metrics are known in closed form. Declared before the
// implementation, with float32 storage as the only error (values within 1e-4 of their unit, frequencies within one FFT bin):
//  - the simulated log, 5 s later on its own clock, is read at the real instants with offset 5 s: a roll 2° above the real one gives
//    bias 2 and RMS 2, an identical pitch RMS 0 and Theil 0, a height 10% above the real one bias 0.1·mean(h) and RMS 0.1·rms(h);
//  - a heading that wraps through north, written 0..360 in one log and −180..180 in the other, compares with RMS 0;
//  - the regimes come from the real log's EKF height and velocity: 1.5 s on the ground, 3.5 s climbing, 4 s hovering, 4 s forward
//    and 3 s descending over the interval 1..17 s, each within one 0.1 s sample, and a quantity's rows exist per regime;
//  - the largest 10° step of the desired roll overshoots 20% in the real log and 40% in the simulated one, a 4 Hz rate oscillation of
//    amplitude 4 and 2 deg/s has spreads 4/√2 and 2/√2 at 4 Hz, the energy used is 0.8 and 0.96 Wh;
//  - what a log lacks is a missing row with its reason, never a number; nothing is judged: no limit and no verdict exist in the output.
const T0 = 1, T1 = 17, OFFSET = 5;
/** The flight's height above the origin, m, and its velocity, m/s, at time t of the real log. */
function flight(t: number) {
  if (t < 2) return { h: 0, vn: 0, vd: 0, pn: 0 };
  if (t < 6) return { h: t - 2, vn: 0, vd: -1, pn: 0 };
  if (t < 10) return { h: 4, vn: 0, vd: 0, pn: 0 };
  if (t < 14) return { h: 4, vn: 3, vd: 0, pn: 3 * (t - 10) };
  return { h: 4 - 0.75 * (t - 14), vn: 0, vd: 0.75, pn: 12 };
}
const desiredRoll = (t: number) => (t >= 7 && t < 9 ? 10 : 0);
/** The real roll follows the desired one, with one sample of 12° just after the step. */
const realRoll = (t: number) => (Math.abs(t - 7.1) < 1e-6 ? 12 : desiredRoll(t));
const yawOf = (t: number) => 350 + 10 * t;
const wrap360 = (deg: number) => ((deg % 360) + 360) % 360, wrap180 = (deg: number) => { const w = wrap360(deg); return w > 180 ? w - 360 : w; };
function log(simulated: boolean, options: { battery?: boolean } = {}): Uint8Array {
  const shift = simulated ? OFFSET : 0, rows: { message: string; values: SyntheticValue[] }[] = [];
  const us = (t: number) => Math.round((t + shift) * 1e6);
  rows.push({ message: 'PARM', values: [us(0), simulated ? 'SIM_RATE_HZ' : 'ATC_RAT_RLL_P', simulated ? 1200 : 0.135, 0] });
  for (let i = 0; i <= 180; i++) {
    const t = i / 10, f = flight(t), h = simulated ? 1.1 * f.h : f.h;
    rows.push({ message: 'XKF1', values: [us(t), 0, f.vn, 0, f.vd, f.pn, 0, -h] });
    rows.push({ message: 'XKF1', values: [us(t), 1, 99, 99, 99, 99, 99, 99] });
    if (options.battery !== false) rows.push({ message: 'BAT', values: [us(t), 0, 16 - 0.01 * t + (simulated ? 0.2 : 0), simulated ? 11 : 10, 0, (simulated ? 0.06 : 0.05) * t] });
    rows.push({ message: 'RCOU', values: [us(t), simulated ? 1520 : 1500, 1500, 1500, 1500] });
  }
  for (let i = 0; i <= 900; i++) {
    const t = i / 50, roll = realRoll(t) + (simulated ? 2 : 0), yaw = simulated ? wrap180(yawOf(t)) : wrap360(yawOf(t));
    rows.push({ message: 'ATT', values: [us(t), desiredRoll(t), roll, 0, 1.5 * Math.sin(t), 0, yaw] });
    const rate = (simulated ? 2 : 4) * Math.sin(2 * Math.PI * 4 * t);
    rows.push({ message: 'RATE', values: [us(t), 0, rate, 0, 0, 0, 0] });
  }
  return syntheticLog(ARDUPILOT_MESSAGES.filter(m => options.battery !== false || m.name !== 'BAT'), rows);
}
const real = readDataFlash(log(false)), simulated = readDataFlash(log(true));
const interval = { fromS: T0, toS: T1, simulatedOffsetS: OFFSET };
const row = (rows: readonly FidelityRow[], quantity: string, regime: FidelityRow['regime'] = 'all') => {
  const found = rows.find(item => item.quantity === quantity && item.regime === regime);
  if (!found) throw new Error(`No row ${quantity} ${regime}`);
  return found;
};

describe('fidelity assessment (TASK-184)', () => {
  const result = assessFidelity(real, simulated, interval);
  it('compares each quantity at the real instants with the TASK-090 metrics', () => {
    const roll = row(result.rows, 'roll');
    expect(roll.status).toBe('compared');
    expect(roll.samples).toBe(801);
    expect(roll.bias).toBeCloseTo(2, 4); expect(roll.rms).toBeCloseTo(2, 4); expect(roll.maxAbs).toBeCloseTo(2, 4);
    const pitch = row(result.rows, 'pitch');
    expect(pitch.rms).toBeLessThan(1e-6); expect(pitch.theil).toBeLessThan(1e-6);
    // Heights at the XKF1 instants 1.0, 1.1, ..., 17.0 s of the real log.
    const heights = Array.from({ length: 161 }, (_, i) => flight(1 + i / 10).h);
    const altitude = row(result.rows, 'altitude');
    expect(altitude.samples).toBe(161);
    expect(altitude.bias).toBeCloseTo(0.1 * heights.reduce((s, v) => s + v, 0) / heights.length, 4);
    expect(altitude.rms).toBeCloseTo(0.1 * Math.sqrt(heights.reduce((s, v) => s + v * v, 0) / heights.length), 4);
    expect(row(result.rows, 'batteryVoltage').bias).toBeCloseTo(0.2, 4);
    expect(row(result.rows, 'batteryCurrent').bias).toBeCloseTo(1, 4);
    expect(row(result.rows, 'motorOutput').bias).toBeCloseTo(20, 3);
    expect(row(result.rows, 'yaw').rms).toBeLessThan(1e-3);
    // The second EKF core is never read.
    expect(row(result.rows, 'verticalSpeed').real?.max).toBeCloseTo(1, 5);
  });
  it('sorts the real interval into regimes from its EKF height and velocity, and compares within each', () => {
    const seconds = Object.fromEntries(result.regimes.map(item => [item.regime, item.seconds]));
    for (const [regime, expected] of [['ground', 1.5], ['climb', 3.5], ['hover', 4], ['forward', 4], ['descent', 3]] as const) {
      expect(Math.abs((seconds[regime] ?? NaN) - expected), regime).toBeLessThanOrEqual(0.1 + 1e-9);
    }
    const hover = row(result.rows, 'altitude', 'hover');
    expect(hover.status).toBe('compared');
    expect(hover.bias).toBeCloseTo(0.4, 4);
    expect(row(result.rows, 'roll', 'forward').bias).toBeCloseTo(2, 4);
  });
  it('gives overshoot, oscillation, energy and the path of each log side by side', () => {
    const scalar = (quantity: string) => result.scalars.find(item => item.quantity === quantity);
    expect(scalar('rollOvershoot')?.real).toBeCloseTo(20, 3);
    expect(scalar('rollOvershoot')?.simulated).toBeCloseTo(40, 3);
    expect(scalar('pitchOvershoot')).toMatchObject({ real: null, simulated: null });
    expect(scalar('pitchOvershoot')?.reason).toContain('no step of the desired pitch');
    expect(scalar('rollRateSpread')?.real).toBeCloseTo(4 / Math.SQRT2, 2);
    expect(scalar('rollRateSpread')?.simulated).toBeCloseTo(2 / Math.SQRT2, 2);
    expect(Math.abs((scalar('rollRateFrequency')?.real ?? NaN) - 4)).toBeLessThan(0.1);
    expect(Math.abs((scalar('rollRateFrequency')?.simulated ?? NaN) - 4)).toBeLessThan(0.1);
    expect(scalar('energyUsed')?.real).toBeCloseTo(0.8, 4);
    expect(scalar('energyUsed')?.simulated).toBeCloseTo(0.96, 4);
    expect(result.path?.horizontalRmsM).toBeLessThan(1e-4);
    expect(result.path?.heightRmsM).toBeCloseTo(row(result.rows, 'altitude').rms ?? NaN, 3);
    // No limit and no verdict anywhere in the result.
    expect(JSON.stringify(result)).not.toMatch(/pass|fail|limit|verdict/i);
  });
  it('shows what a log lacks as missing with its reason, and tells a real log from a simulated one', () => {
    const without = assessFidelity(real, readDataFlash(log(true, { battery: false })), interval);
    expect(row(without.rows, 'batteryVoltage')).toMatchObject({ status: 'missing', reason: 'The simulated log has no BAT messages', rms: null });
    const energy = without.scalars.find(item => item.quantity === 'energyUsed');
    expect(energy).toMatchObject({ simulated: null, reason: 'The simulated log has no BAT messages' });
    expect(energy?.real).toBeCloseTo(0.8, 4);
    const short = assessFidelity(real, simulated, { fromS: 6.5, toS: 9.5, simulatedOffsetS: OFFSET });
    expect(row(short.rows, 'roll', 'forward')).toMatchObject({ status: 'missing', reason: 'the real log holds no forward in the interval' });
    expect(logOrigin(real)).toEqual({ kind: 'real', reason: 'It holds no SITL parameter and no MirageSITL message' });
    expect(logOrigin(simulated)).toEqual({ kind: 'simulated', reason: 'It sets the SITL parameter SIM_RATE_HZ' });
    const mirage = readDataFlash(writeDataFlash([{ kind: 'event', timeUs: 0, event: 'note', text: 'x' }]));
    expect(logOrigin(mirage).kind).toBe('simulated');
    expect(() => assessFidelity(real, simulated, { fromS: 5, toS: 5, simulatedOffsetS: 0 })).toThrow('end after its start');
    const paired = pairedSeries(real, simulated, interval, 'roll');
    if (typeof paired === 'string') throw new Error(paired);
    expect(paired.timeS[0]).toBeCloseTo(1, 6);
    expect(paired.simulated[0]! - paired.real[0]!).toBeCloseTo(2, 4);
  });
});

describe('fidelity comparisons of a profile version (TASK-184)', () => {
  const PROFILE = { sha256: 'a'.repeat(64), name: 'Quad X', version: 1 }, EXPERIMENT = 'b'.repeat(64);
  const report = (realBytes = log(false), simulatedBytes = log(true)) => fidelityReport({ profile: PROFILE, experimentSha256: EXPERIMENT,
    real: { name: 'flight.bin', bytes: realBytes }, simulated: { name: 'run.bin', bytes: simulatedBytes }, interval });
  it('keeps the assessment with both logs\' hashes and origins, and no limit or verdict', async () => {
    const { comparison, assessment } = await report();
    expect(comparison.real).toMatchObject({ name: 'flight.bin', origin: 'real', sha256: createHash('sha256').update(log(false)).digest('hex') });
    expect(comparison.simulated).toMatchObject({ origin: 'simulated', originReason: 'It sets the SITL parameter SIM_RATE_HZ' });
    expect(comparison.rows).toEqual(assessment.rows);
    // As stored: JSON has no −0, so the text is what must round-trip.
    expect(JSON.stringify(validateFidelityComparison(JSON.parse(JSON.stringify(comparison))))).toBe(JSON.stringify(comparison));
  });
  it('refuses unhashed input, a missing row with a number, a compared row without its metrics, one file twice and a verdict', async () => {
    const { comparison } = await report();
    const plain = () => JSON.parse(JSON.stringify(comparison)) as Record<string, unknown> & { rows: Record<string, unknown>[]; real: Record<string, unknown> };
    const cases: [string, (p: ReturnType<typeof plain>) => void, string][] = [
      ['an unhashed log', p => { p.real.sha256 = 'flight.bin'; }, 'real.sha256 must be a lowercase SHA-256'],
      ['an unhashed profile', p => { p.profile = { ...PROFILE, sha256: 'A'.repeat(64) }; }, 'profile.sha256 must be a lowercase SHA-256'],
      ['the same file twice', p => { p.real.sha256 = (p.simulated as Record<string, unknown>).sha256; }, 'the real and the simulated log are the same file'],
      ['a missing row with a number', p => { const row = p.rows[0]; if (row) { row.status = 'missing'; row.reason = 'none'; } }, 'is missing, so it holds a reason and no number'],
      ['a compared row without metrics', p => { const row = p.rows.find(r => r.status === 'compared'); if (row) row.rms = null; }, 'is compared, so it holds at least two samples'],
      ['a verdict', p => { Object.assign(p, { verdict: 'PASS' }); }, 'the payload has an unexpected field verdict'],
      ['a limit on a row', p => { Object.assign(p.rows[0] ?? {}, { limit: 1 }); }, 'rows[0] has an unexpected field limit'],
      ['another schema', p => { p.schemaVersion = 2; }, 'schemaVersion must be 1'],
    ];
    for (const [name, change, message] of cases) { const p = plain(); change(p); expect(() => validateFidelityComparison(p), name).toThrow(message); }
  });
  it('earns flight-checked for its profile version only with a real log, in the regimes compared, and a new version starts without it', async () => {
    const store = new ProjectStore(new MemoryBackend(), { storage: null, validators: { 'component-card': validateComponentCard, 'aircraft-profile': validateAircraftProfile,
      'fidelity-comparison': validateFidelityComparison } });
    const projectId = (await store.createProject('Fidelity')).record.id;
    const card = async (type: 'motor' | 'propeller' | 'esc' | 'battery') => (await store.createItem(projectId, 'component-card', { name: type, payload: exampleCard(type) })).sha256;
    const { profile } = await quadProfile({ motor: await card('motor'), propeller: await card('propeller'), esc: await card('esc'), battery: await card('battery') });
    const first = await store.createItem(projectId, 'aircraft-profile', profileDraft('Quad X', profile));
    const ofFirst = { sha256: first.sha256, name: 'Quad X', version: first.record.version };
    const real = await fidelityReport({ profile: ofFirst, experimentSha256: EXPERIMENT, real: { name: 'flight.bin', bytes: log(false) }, simulated: { name: 'run.bin', bytes: log(true) }, interval });
    // A "real" log that is a SITL log earns nothing.
    const sitl = await fidelityReport({ profile: ofFirst, experimentSha256: EXPERIMENT, real: { name: 'sitl.bin', bytes: log(true) }, simulated: { name: 'run.bin', bytes: log(false) }, interval });
    await saveFidelityComparison(store, projectId, sitl.comparison);
    expect(flightCheckOf(first.sha256, await store.listItems(projectId, 'fidelity-comparison'))).toBeNull();
    const saved = await saveFidelityComparison(store, projectId, real.comparison);
    expect(saved.record.dependencies).toEqual([{ kind: 'aircraft-profile', sha256: first.sha256 }]);
    const check = flightCheckOf(first.sha256, await store.listItems(projectId, 'fidelity-comparison'));
    expect(check).toEqual({ label: 'flight-checked', comparisons: [saved.sha256], regimes: ['ground', 'hover', 'climb', 'descent', 'forward'] });
    // A change of the profile is a new version, which has no comparison: the label resets and the old comparison stays the old version's.
    const second = await store.saveVersion(first.record.id, first.sha256, profileDraft('Quad X, new version', profile));
    expect(second.record.version).toBe(2);
    expect(flightCheckOf(second.sha256, await store.listItems(projectId, 'fidelity-comparison'))).toBeNull();
    expect(flightCheckOf(first.sha256, await store.listItems(projectId, 'fidelity-comparison'))?.comparisons).toEqual([saved.sha256]);
    // A comparison must name a profile version of the project.
    await expect(saveFidelityComparison(store, projectId, { ...real.comparison, profile: { ...ofFirst, sha256: 'c'.repeat(64) } })).rejects.toThrow();
  });
});
