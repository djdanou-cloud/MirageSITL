import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importBenchCsv, importBenchMeasurements } from '@mirage/physics/bench-import';
import { parseUiucPropellerFixture } from '../packages/physics/src/uiuc-propeller.ts';

// TASK-090, the bench half (SPECS_SIMULATION_ENGINES "Capture schema 3 and the bench-test captures"), declared before the captures:
//  - capture schema 3 adds the bench-test source (bench sections only, firmware SHA-256 all zeros, a non-zero model SHA-256, no logs), a
//    list of bench sections and model flags per prediction; schema 2 with bench-test is refused naming schema 3;
//  - an analytic schema 3 section (+2% CT and −3% CP, one row +10% and +5% with a model flag) gives largest errors 0.10 and 0.05, and
//    0.02 and 0.03 within model validity, REPORTED with no verdict;
//  - the committed captures and model descriptions reproduce from scripts/bench-capture.mjs: descriptions byte for byte, predictions
//    within 1e-9 relative, everything else exactly; their measured CT and CP equal the sources within 1e-12 relative.

const ROOT = new URL('../', import.meta.url).pathname;
const sha256 = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
const ZERO = '0'.repeat(64), MODEL = 'ab'.repeat(32);
const CAPTURES = ['bench-tmotor-mn7005-p24x72', 'bench-uiuc-da4002-da4022-static'] as const;

/** Checked access into untrusted JSON. */
function at(value: unknown, ...keys: (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    if (typeof key === 'number') {
      if (!Array.isArray(current) || key >= current.length) throw new Error(`No element ${keys.join('.')}`);
      current = current[key] as unknown;
      continue;
    }
    const entry = typeof current === 'object' && current !== null && !Array.isArray(current)
      ? Object.entries(current).find(([name]) => name === key) : undefined;
    if (!entry) throw new Error(`No field ${keys.join('.')}`);
    current = entry[1];
  }
  return current;
}
function numberAt(value: unknown, ...keys: (string | number)[]): number {
  const found = at(value, ...keys);
  if (typeof found !== 'number') throw new Error(`${keys.join('.')} is not a number`);
  return found;
}
function arrayAt(value: unknown, ...keys: (string | number)[]): unknown[] {
  const found = at(value, ...keys);
  if (!Array.isArray(found)) throw new Error(`${keys.join('.')} is not an array`);
  return found;
}

// scripts/check-fidelity.mjs writes test-results/validation/fidelity.json under its working directory; each run here has a directory of
// its own inside the repository (ignored .cache), so it never shares that file with tests/fidelity-metrics.test.ts.
mkdirSync(join(ROOT, '.cache'), { recursive: true });
function check(capture: unknown): { status: number | null; report: unknown } {
  const cwd = mkdtempSync(join(ROOT, '.cache', 'bench-capture-test-'));
  const text = JSON.stringify(capture), path = join(cwd, 'capture.json');
  writeFileSync(path, text);
  return checkFile(path, sha256(text), cwd);
}
function checkFile(path: string, hash: string, cwd = mkdtempSync(join(ROOT, '.cache', 'bench-capture-test-'))): { status: number | null; report: unknown } {
  const run = spawnSync(process.execPath, [join(ROOT, 'scripts/check-fidelity.mjs'), '--input', path, '--sha256', hash], { cwd, encoding: 'utf8' });
  const report: unknown = JSON.parse(readFileSync(join(cwd, 'test-results/validation/fidelity.json'), 'utf8'));
  return { status: run.status, report };
}

const csv = readFileSync(new URL('./fixtures/validation/bench-synthetic.csv', import.meta.url), 'utf8');
const points = importBenchCsv(csv).points;
type Row = { rpm: number; ct: number; cp: number; modelFlags?: string[] };
function analyticRows(): Row[] {
  return points.map((point, i) => i === points.length - 1
    ? { rpm: point.rpm, ct: 0.11 * 1.1, cp: 0.045 * 1.05, modelFlags: ['outside-polar'] }
    : { rpm: point.rpm, ct: 0.11 * 1.02, cp: 0.045 * 0.97, modelFlags: [] });
}
function benchTest(change: (c: Record<string, unknown>) => Record<string, unknown> = c => c): Record<string, unknown> {
  return change({
    schemaVersion: 3, kind: 'mirage-fidelity-capture',
    provenance: { source: 'bench-test', operator: 'test', recordedAt: '2026-11-08T00:00:00Z', firmwareSha256: ZERO, modelSha256: MODEL },
    timeDomain: [], frequencyResponse: [],
    bench: [{ id: 'synthetic', csv, csvSha256: sha256(csv), predicted: analyticRows() }],
  });
}
const provenance = (c: Record<string, unknown>, change: Record<string, unknown>) => ({ ...c, provenance: { ...(c.provenance as object), ...change } });
const rows = (c: Record<string, unknown>, change: (r: Row[]) => Row[]) => ({ ...c, bench: [{ id: 'synthetic', csv, csvSha256: sha256(csv), predicted: change(analyticRows()) }] });

describe('capture schema 3 and bench-test provenance (TASK-090)', () => {
  it('reports an analytic bench-test section with its model-flagged row in the main errors only, and no verdict', () => {
    const { status, report } = check(benchTest());
    expect(status).toBe(0);
    expect(at(report, 'status')).toBe('REPORTED');
    expect(at(report, 'reasons')).toEqual([
      'The metrics are reported without a limit or a verdict (SA-01); the user judges them',
      'Bench-test capture: no firmware takes part; the propulsion model alone is compared with a static thrust stand',
      'synthetic: 1 predictions carry model validity flags, listed and kept in the bench errors',
    ]);
    // The CSV's coefficients are CT = 0.11 and CP = 0.045 printed to 12 digits, so the analytic errors hold to about 1e-10.
    expect(numberAt(report, 'metrics', 'bench', 'synthetic', 'largestCtRelativeError')).toBeCloseTo(0.1, 9);
    expect(numberAt(report, 'metrics', 'bench', 'synthetic', 'largestCpRelativeError')).toBeCloseTo(0.05, 9);
    expect(numberAt(report, 'metrics', 'bench', 'synthetic', 'withinModelValidity', 'comparedRows')).toBe(6);
    expect(numberAt(report, 'metrics', 'bench', 'synthetic', 'withinModelValidity', 'largestCtRelativeError')).toBeCloseTo(0.02, 9);
    expect(numberAt(report, 'metrics', 'bench', 'synthetic', 'withinModelValidity', 'largestCpRelativeError')).toBeCloseTo(0.03, 9);
    expect(at(report, 'metrics', 'bench', 'synthetic', 'modelFlagged')).toEqual([{ row: 7, rpm: 8000, modelFlags: ['outside-polar'] }]);
    expect(numberAt(report, 'metrics', 'bench', 'synthetic', 'comparedRows')).toBe(7);
    expect(JSON.stringify(report)).not.toMatch(/"passed"|"limits"|maxCost|limitsMet/);
  });

  it('keeps schema 2 as it was and refuses bench-test in it, naming schema 3', () => {
    const v2 = JSON.parse(readFileSync(new URL('./fixtures/validation/fidelity-synthetic-capture-v2.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const synthetic = check(v2);
    expect(synthetic.status).toBe(2);
    expect(Object.keys(at(synthetic.report, 'metrics', 'bench') as object).sort()).toEqual(
      ['comparedRows', 'flagged', 'flaggedRows', 'largestCpRelativeError', 'largestCtRelativeError', 'rows']);
    const refused = check(provenance(v2, { source: 'bench-test' }));
    expect(refused.status).toBe(1);
    expect(at(refused.report, 'reasons')).toEqual(['Provenance source bench-test needs capture schema 3']);
    // A schema 2 prediction carries no model flags.
    const bench = v2.bench as { predicted: Row[] };
    const flagged = check({ ...v2, bench: { ...bench, predicted: bench.predicted.map(row => ({ ...row, modelFlags: [] })) } });
    expect(flagged.status).toBe(1);
  });

  it('accepts schema 3 flight-test and synthetic captures with sections of every kind', () => {
    const flight = check(benchTest(c => provenance({ ...c, timeDomain: [{ id: 'roll', unit: 'rad/s', sampleRateHz: 10, measured: [1, 2, 3], simulated: [1, 2, 4] }] },
      { source: 'flight-test', firmwareSha256: 'cd'.repeat(32) })));
    expect(flight.status).toBe(0);
    expect(at(flight.report, 'status')).toBe('REPORTED');
    expect(numberAt(flight.report, 'metrics', 'timeDomain', 'roll', 'samples')).toBe(3);
    const synthetic = check(benchTest(c => provenance(c, { source: 'synthetic' })));
    expect(synthetic.status).toBe(2);
    expect(at(synthetic.report, 'status')).toBe('BLOCKED_EXTERNAL');
  });

  it('refuses a malformed schema 3 or bench-test capture', () => {
    const series = { id: 'roll', unit: 'rad/s', sampleRateHz: 10, measured: [1, 2, 3], simulated: [1, 2, 4] };
    const cases: [string, Record<string, unknown>, string][] = [
      ['firmware on a bench test', benchTest(c => provenance(c, { firmwareSha256: 'cd'.repeat(32) })), 'firmware SHA-256 must be all zeros'],
      ['no model hash', benchTest(c => provenance(c, { modelSha256: ZERO })), 'model description'],
      ['logs on a bench test', benchTest(c => provenance(c, { logs: { realSha256: MODEL, simulatedSha256: MODEL } })), 'names no logs'],
      ['a time-domain section', benchTest(c => ({ ...c, timeDomain: [series] })), 'bench sections only'],
      ['no bench section', benchTest(c => ({ ...c, bench: [] })), 'bench sections only'],
      ['a schema 2 bench object', benchTest(c => ({ ...c, bench: { csv, csvSha256: sha256(csv), predicted: analyticRows() } })), 'at most 32 sections'],
      ['duplicate section ids', benchTest(c => ({ ...c, bench: [...(c.bench as unknown[]), ...(c.bench as unknown[])] })), 'Duplicate bench identifier'],
      ['a missing model flag list', benchTest(c => rows(c, r => r.map(row => ({ rpm: row.rpm, ct: row.ct, cp: row.cp })))), 'Invalid evidence fields'],
      ['an unknown model flag', benchTest(c => rows(c, r => r.map(row => ({ ...row, modelFlags: ['extrapolated'] })))), 'Model flags'],
      ['a repeated model flag', benchTest(c => rows(c, r => r.map(row => ({ ...row, modelFlags: ['outside-polar', 'outside-polar'] })))), 'Model flags'],
      ['an unknown source', benchTest(c => provenance(c, { source: 'stand' })), 'flight-test, bench-test or synthetic'],
      ['a flight test without firmware', benchTest(c => provenance(c, { source: 'flight-test' })), 'real firmware and model hashes'],
    ];
    for (const [label, capture, reason] of cases) {
      const { status, report } = check(capture);
      expect(status, label).toBe(1);
      expect(at(report, 'status'), label).toBe('FAIL');
      expect(String(at(report, 'reasons', 0)), label).toContain(reason);
    }
  });
});

describe('the committed bench-test captures (TASK-090)', () => {
  const out = mkdtempSync(join(tmpdir(), 'mirage-bench-capture-'));
  const committed = (name: string) => readFileSync(join(ROOT, 'test-results/validation', name), 'utf8');
  const written = (name: string) => readFileSync(join(out, name), 'utf8');

  it('reproduce from scripts/bench-capture.mjs', () => {
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts/bench-capture.mjs'), '--out', out], { cwd: ROOT, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    for (const name of CAPTURES) {
      const model = committed(`${name}-model.json`);
      expect(written(`${name}-model.json`), name).toBe(model);
      const mine: unknown = JSON.parse(committed(`${name}-capture.json`)), theirs: unknown = JSON.parse(written(`${name}-capture.json`));
      expect(at(mine, 'provenance', 'modelSha256')).toBe(sha256(model));
      const sections = arrayAt(mine, 'bench');
      expect(arrayAt(theirs, 'bench')).toHaveLength(sections.length);
      sections.forEach((_, s) => {
        const predicted = arrayAt(mine, 'bench', s, 'predicted');
        predicted.forEach((__, i) => {
          for (const key of ['ct', 'cp']) {
            const a = numberAt(mine, 'bench', s, 'predicted', i, key), b = numberAt(theirs, 'bench', s, 'predicted', i, key);
            expect(Math.abs(a - b), `${name} ${s} ${i} ${key}`).toBeLessThanOrEqual(1e-9 * Math.abs(a));
          }
        });
      });
      // Everything but the predicted coefficients is exact.
      const strip = (value: unknown) => JSON.stringify(value, (key, v: unknown) => (key === 'ct' || key === 'cp') && typeof v === 'number' ? 0 : v);
      expect(strip(theirs), name).toBe(strip(mine));
    }
  }, 600_000);

  it('hold the measured sources: T-Motor\'s rows as transcribed, and UIUC\'s printed coefficients', () => {
    const tmotor: unknown = JSON.parse(committed('bench-tmotor-mn7005-p24x72-capture.json'));
    const v2 = importBenchMeasurements(readFileSync(join(ROOT, 'tests/fixtures/components/tmotor-mn7005-kv230-p24x72.csv'), 'utf8'));
    const tm = importBenchCsv(String(at(tmotor, 'bench', 0, 'csv')));
    expect(tm.diameterM).toBe(0.6096);
    expect(tm.points.map(p => [p.rpm, p.thrustN, p.torqueNm, p.airDensityKgM3])).toEqual(v2.points.map(p => [p.rpm, p.thrustN, p.torqueNm, 1.225]));
    expect(at(tmotor, 'provenance', 'source')).toBe('bench-test');
    expect(at(tmotor, 'provenance', 'firmwareSha256')).toBe(ZERO);
    const fixture = parseUiucPropellerFixture(JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/rotors/uiuc-propellers.json'), 'utf8')));
    const uiuc: unknown = JSON.parse(committed('bench-uiuc-da4002-da4022-static-capture.json'));
    expect(arrayAt(uiuc, 'bench')).toHaveLength(fixture.propellers.length);
    fixture.propellers.forEach((propeller, s) => {
      expect(at(uiuc, 'bench', s, 'id')).toBe(propeller.id.replaceAll('.', 'p'));
      const imported = importBenchCsv(String(at(uiuc, 'bench', s, 'csv')));
      expect(imported.diameterM).toBe(propeller.diameterM);
      const printed = propeller.static?.points ?? [];
      expect(imported.points).toHaveLength(printed.length);
      imported.points.forEach((point, i) => {
        const [rpm, ct, cp] = printed[i] ?? [NaN, NaN, NaN];
        expect(point.rpm).toBe(rpm);
        expect(Math.abs(point.ct - ct) / ct).toBeLessThan(1e-12);
        expect(Math.abs(point.cp - cp) / cp).toBeLessThan(1e-12);
      });
    });
  });

  it('are REPORTED by scripts/check-fidelity.mjs, with every row compared and the model flags listed', () => {
    const expected = { 'bench-tmotor-mn7005-p24x72': { sections: 1, rows: 11 }, 'bench-uiuc-da4002-da4022-static': { sections: 14, rows: 242 } };
    for (const name of CAPTURES) {
      const path = join(ROOT, 'test-results/validation', `${name}-capture.json`);
      const { status, report } = checkFile(path, sha256(readFileSync(path)));
      expect(status, name).toBe(0);
      expect(at(report, 'status')).toBe('REPORTED');
      const sections = Object.values(at(report, 'metrics', 'bench') as Record<string, unknown>);
      expect(sections).toHaveLength(expected[name].sections);
      expect(sections.reduce((sum: number, m) => sum + numberAt(m, 'comparedRows'), 0)).toBe(expected[name].rows);
      expect(sections.reduce((sum: number, m) => sum + numberAt(m, 'flaggedRows'), 0)).toBe(0);
    }
  });
});
