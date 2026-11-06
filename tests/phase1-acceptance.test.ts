import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { acceptanceOf, assessMatrix, openTasksOf, parseMatrix, type EvidenceAccess } from '../scripts/phase1/acceptance-rules.ts';

// TASK-188. Hand-built reports and matrices: what is forged, stale or missing must never stand as PASS, a failure must stay one, and
// the repository's own matrix must be whole.

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const COMMIT = 'a'.repeat(40), SOURCE = 'tests/source.ts', SOURCE_SHA = 'b'.repeat(64);
const report = (extra: Record<string, unknown> = {}, verdict = 'PASS', workflow = 'flight') => JSON.stringify({ schemaVersion: 1, task: 'TASK-158', configuration: { id: 'quad' }, settings: 'acceptance',
  acceptanceMachine: { admitted: true, reasons: [] }, application: { commit: COMMIT, uncommitted: [] }, sources: { [SOURCE]: SOURCE_SHA }, verdicts: { [workflow]: { verdict, reasons: [] } }, ...extra });
function world(files: Record<string, string>, overrides: Partial<EvidenceAccess> = {}): EvidenceAccess {
  return { read: path => (Object.hasOwn(files, path) ? new TextEncoder().encode(files[path]) : null), sha256: sha, sourceSha256: path => (path === SOURCE ? SOURCE_SHA : null), inHistory: commit => commit === COMMIT, ...overrides };
}
const matrixWith = (cell: Record<string, unknown>, more: readonly Record<string, unknown>[] = []) => ({ schemaVersion: 1, configurations: [{ id: 'quad' }],
  workflows: [{ id: 'flight', appliesTo: 'each-configuration' }, ...more.map(item => ({ id: item.workflow, appliesTo: item.configuration === null ? 'global' : ['quad'] }))],
  cells: [{ configuration: 'quad', workflow: 'flight', ...cell }, ...more] });
const cited = (text: string, path = 'r.json') => ({ path, sha256: sha(text) });
const one = (cell: Record<string, unknown>, files: Record<string, string>, overrides: Partial<EvidenceAccess> = {}) => assessMatrix(matrixWith(cell), world(files, overrides));

describe('a cell stands only as far as its evidence', () => {
  it('passes a cell whose report is whole, current and agrees with it', () => {
    const text = report(), result = one({ verdict: 'PASS', evidence: cited(text) }, { 'r.json': text });
    expect(result.status).toBe('PASS');
    expect(result.cells[0]).toMatchObject({ verdict: 'PASS', refused: null });
    expect(result.counts.PASS).toBe(1);
  });
  it('shows a cell with no evidence as NOT_RUN, never as anything better', () => {
    const result = one({ verdict: 'NOT_RUN', evidence: null }, {});
    expect(result.status).toBe('NOT_RUN');
    expect(result.cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: null });
    expect(one({ verdict: 'PASS', evidence: null }, {}).cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: { kind: 'missing' } });
  });
  it('refuses a forged report: other bytes than cited, or another verdict than the matrix says', () => {
    const text = report();
    const swapped = one({ verdict: 'PASS', evidence: cited(text) }, { 'r.json': report({ task: 'edited' }) });
    expect(swapped.cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: { kind: 'forged' } });
    expect(swapped.status).toBe('FAIL');
    const failing = report({}, 'FAIL');
    const disagreeing = one({ verdict: 'PASS', evidence: cited(failing) }, { 'r.json': failing });
    expect(disagreeing.cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: { kind: 'forged', reason: expect.stringContaining('says FAIL') as string } });
    expect(disagreeing.status).toBe('FAIL');
  });
  it('refuses a report that is gone, not JSON, of another configuration, without a verdict, off the acceptance machine, or the stock control', () => {
    const cases: readonly [string, string][] = [
      ['invalid', 'not json'], ['invalid', report({ configuration: { id: 'hexa' } })], ['invalid', report({ verdicts: {} })],
      ['invalid', report({ acceptanceMachine: { admitted: false, reasons: ['the chip'] } })], ['invalid', report({ settings: 'stock' })], ['invalid', report({ application: {} })], ['invalid', report({ sources: {} })],
    ];
    for (const [kind, text] of cases) {
      const result = one({ verdict: 'PASS', evidence: cited(text) }, { 'r.json': text });
      expect(result.cells[0], text.slice(0, 80)).toMatchObject({ verdict: 'NOT_RUN', refused: { kind } });
      expect(result.status, text.slice(0, 80)).toBe('FAIL');
    }
    expect(one({ verdict: 'PASS', evidence: cited(report()) }, {}).cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: { kind: 'missing' } });
  });
  it('refuses a stale report: a source changed, or a commit outside this history; that leaves the cell to run, not failed', () => {
    const text = report();
    const changed = one({ verdict: 'PASS', evidence: cited(text) }, { 'r.json': text }, { sourceSha256: () => 'c'.repeat(64) });
    expect(changed.cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: { kind: 'stale', reason: expect.stringContaining(SOURCE) as string } });
    expect(changed.status).toBe('NOT_RUN');
    const elsewhere = one({ verdict: 'PASS', evidence: cited(text) }, { 'r.json': text }, { inHistory: () => false });
    expect(elsewhere.cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: { kind: 'stale', reason: expect.stringContaining('history') as string } });
    const gone = one({ verdict: 'PASS', evidence: cited(text) }, { 'r.json': text }, { sourceSha256: () => null });
    expect(gone.cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: { kind: 'stale' } });
  });
  it('preserves a failure: it stays FAIL when its sources change, and fails the matrix', () => {
    const text = report({}, 'FAIL');
    const current = one({ verdict: 'FAIL', evidence: cited(text) }, { 'r.json': text });
    expect(current.cells[0]).toMatchObject({ verdict: 'FAIL', refused: null });
    expect(current.status).toBe('FAIL');
    const old = one({ verdict: 'FAIL', evidence: cited(text) }, { 'r.json': text }, { sourceSha256: () => 'c'.repeat(64) });
    expect(old.cells[0]).toMatchObject({ verdict: 'FAIL', refused: null });
    expect(old.status).toBe('FAIL');
    // A FAIL with nothing to show for itself is refused, and the matrix still fails.
    expect(one({ verdict: 'FAIL', evidence: null }, {}).status).toBe('FAIL');
  });
  it('keeps a blocked cell blocked, and asks a blocked decision to name itself', () => {
    expect(one({ verdict: 'BLOCKED_EXTERNAL', evidence: null }, {})).toMatchObject({ status: 'BLOCKED_EXTERNAL', counts: { BLOCKED_EXTERNAL: 1 } });
    expect(one({ verdict: 'BLOCKED_DECISION', evidence: null, blockedBy: ['A-99'] }, {})).toMatchObject({ status: 'BLOCKED_DECISION', cells: [{ blockedBy: ['A-99'] }] });
    expect(one({ verdict: 'BLOCKED_DECISION', evidence: null }, {}).cells[0]).toMatchObject({ verdict: 'NOT_RUN', refused: { kind: 'invalid' } });
  });
  it('passes the whole only when every cell passes', () => {
    const text = report(), pass = { verdict: 'PASS', evidence: cited(text) };
    const withOther = (cell: Record<string, unknown>) => assessMatrix(matrixWith(pass, [{ configuration: null, workflow: 'global-one', ...cell }]), world({ 'r.json': text, 'g.json': report({ configuration: null, sources: { [SOURCE]: SOURCE_SHA } }, 'PASS', 'global-one') }));
    expect(withOther({ verdict: 'NOT_RUN', evidence: null }).status).toBe('NOT_RUN');
    const globalText = report({ configuration: null }, 'PASS', 'global-one');
    expect(withOther({ verdict: 'PASS', evidence: cited(globalText, 'g.json') }).status).toBe('PASS');
  });
});

describe('the matrix itself', () => {
  const base = { schemaVersion: 1, configurations: [{ id: 'quad' }, { id: 'hexa' }], workflows: [{ id: 'flight', appliesTo: 'each-configuration' }, { id: 'hour', appliesTo: ['hexa'] }, { id: 'install', appliesTo: 'global' }] };
  const cell = (configuration: string | null, workflow: string) => ({ configuration, workflow, verdict: 'NOT_RUN', evidence: null });
  const whole = [cell('quad', 'flight'), cell('hexa', 'flight'), cell('hexa', 'hour'), cell(null, 'install')];
  it('must be exactly the cells its workflows declare', () => {
    expect(parseMatrix({ ...base, cells: whole })).toHaveLength(4);
    expect(() => parseMatrix({ ...base, cells: whole.slice(1) })).toThrow('no cell for quad|flight');
    expect(() => parseMatrix({ ...base, cells: [...whole, cell('quad', 'hour')] })).toThrow('no workflow declares');
    expect(() => parseMatrix({ ...base, cells: [...whole, cell('hexa', 'hour')] })).toThrow('two cells');
    expect(() => parseMatrix({ ...base, cells: [{ ...whole[0], verdict: 'OK' }, ...whole.slice(1)] })).toThrow('not a cell');
    expect(() => parseMatrix({ ...base, cells: [{ ...whole[0], evidence: { path: 'x', sha256: 'short' } }, ...whole.slice(1)] })).toThrow('malformed evidence');
    expect(() => parseMatrix({ ...base, schemaVersion: 2, cells: whole })).toThrow('schema version 1');
  });
  it('holds its 51 cells in the repository', () => {
    const matrix: unknown = JSON.parse(readFileSync('docs/validation/phase1-matrix.json', 'utf8'));
    expect(parseMatrix(matrix)).toHaveLength(51);
  });
  it('and the command line exits by the same rule, and writes what it found', () => {
    const run = spawnSync(process.execPath, ['scripts/phase1/acceptance.mjs', '--out', 'test-results/phase1/acceptance-test.json'], { encoding: 'utf8' });
    expect([0, 1, 2]).toContain(run.status);
    expect(run.stdout).toMatch(/\d+ PASS, \d+ FAIL/);
    const written: unknown = JSON.parse(readFileSync('test-results/phase1/acceptance-test.json', 'utf8'));
    expect(written).toMatchObject({ task: 'TASK-191', kind: 'phase1-acceptance' });
  });
});

describe('what Phase 1 still waits on (TASK-191)', () => {
  const roadmap = (status189: string, dependencies = 'TASK-096, TASK-189') => [
    ...['185', '186', '187', '188', '190', '096'].map(id => `### TASK-${id} — Task ${id}\n\n- **Status:** DONE — done.\n`),
    `### TASK-189 — The hour\n\n- **Status:** ${status189} — why.\n`,
    `### TASK-191 — The report\n\n- **Status:** TODO\n- **Dependencies:** ${dependencies}.\n`,
  ].join('\n');
  it('lists the tasks that are not DONE, with their status and title, and nothing else', () => {
    expect(openTasksOf(roadmap('DONE'))).toEqual([]);
    expect(openTasksOf(roadmap('BLOCKED_EXTERNAL'))).toEqual([{ id: 'TASK-189', kind: 'task', status: 'BLOCKED_EXTERNAL', what: 'The hour' }]);
    expect(openTasksOf(roadmap('DONE', 'TASK-404'))).toEqual([{ id: 'TASK-404', kind: 'task', status: 'MISSING', what: 'The roadmap does not hold this task' }]);
  });
  it('accepts only with every cell passing and nothing open', () => {
    const counts = { PASS: 51, FAIL: 0, BLOCKED_EXTERNAL: 0, BLOCKED_DECISION: 0, NOT_RUN: 0 };
    expect(acceptanceOf({ status: 'PASS', counts }, [])).toEqual({ accepted: true, reasons: [] });
    const open = [{ id: 'TASK-186', kind: 'task' as const, status: 'BLOCKED_EXTERNAL', what: 'Terrain' }];
    expect(acceptanceOf({ status: 'PASS', counts }, open)).toEqual({ accepted: false, reasons: ['TASK-186 is BLOCKED_EXTERNAL: Terrain'] });
    expect(acceptanceOf({ status: 'NOT_RUN', counts: { ...counts, PASS: 50, NOT_RUN: 1 } }, []).accepted).toBe(false);
  });
});
