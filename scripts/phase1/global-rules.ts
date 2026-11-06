// TASK-190 (S19): the matrix's global workflows, what each runs and how it is judged, apart from running them so that it is tested directly.

export const GLOBAL_TASK = 'TASK-190';
export const GLOBAL_REPORT_DIRECTORY = 'test-results/validation/phase1-global';
export interface GlobalWorkflow { readonly id: string; readonly criterion: string; readonly vitest: readonly string[]; readonly playwright: readonly string[] }
/** Each workflow's own tests, on the real installation. A clean installation itself is run apart: docs/operations/install-macos.md. */
export const WORKFLOWS: readonly GlobalWorkflow[] = Object.freeze([
  { id: 'installation-restart', criterion: 'Supported macOS installation and restart: every installed file against its recorded hash, every prerequisite OK, and the launcher restarted on the installed folder with the same token',
    vitest: ['tests/install-macos.test.ts', 'tests/launcher.test.ts', 'tests/integration/recovery-drill.test.ts'], playwright: ['tests/browser/first-run.spec.ts'] },
  { id: 'offline-workflow', criterion: 'Local and offline workflows after installation with the network blocked: simulation, tuning, local libraries, recording and log analysis',
    vitest: [], playwright: ['tests/browser/run-panel.spec.ts', 'tests/browser/parameters-tab.spec.ts', 'tests/browser/card-editor.spec.ts', 'tests/browser/aircraft-editor.spec.ts', 'tests/browser/logging-tab.spec.ts', 'tests/browser/log-viewer.spec.ts'] },
  { id: 'export-import', criterion: 'Experiment export and import', vitest: [], playwright: ['tests/browser/experiments-tab.spec.ts'] },
  { id: 'comparisons', criterion: 'Experiment and log comparisons', vitest: [], playwright: ['tests/browser/compare-experiments.spec.ts', 'tests/browser/log-compare.spec.ts', 'tests/browser/from-log-compare.spec.ts'] },
  { id: 'parameter-export', criterion: 'ArduPilot parameter file export', vitest: [], playwright: ['tests/browser/parameter-export.spec.ts'] },
]);

export interface ToolRun { readonly tool: string; readonly status: number | null; readonly passed: number; readonly failed: number; readonly skipped: number; readonly notPassed?: readonly string[] }
export interface WorkflowJudgement { readonly verdict: 'PASS' | 'FAIL'; readonly reasons: readonly string[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === 'number' ? value : 0);
/** The totals of a Vitest JSON report; nothing without one. */
export function vitestCounts(report: unknown): Pick<ToolRun, 'passed' | 'failed' | 'skipped' | 'notPassed'> {
  if (!isRecord(report)) return { passed: 0, failed: 0, skipped: 0, notPassed: [] };
  const notPassed: string[] = [];
  for (const file of Array.isArray(report.testResults) ? report.testResults as unknown[] : []) {
    for (const test of isRecord(file) && Array.isArray(file.assertionResults) ? file.assertionResults as unknown[] : []) {
      if (isRecord(test) && test.status !== 'passed' && typeof test.fullName === 'string') notPassed.push(`${String(test.status)}: ${test.fullName}`);
    }
  }
  return { passed: count(report.numPassedTests), failed: count(report.numFailedTests), skipped: count(report.numPendingTests) + count(report.numTodoTests), notPassed };
}
/** The totals of a Playwright JSON report; nothing without one. */
export function playwrightCounts(report: unknown): Pick<ToolRun, 'passed' | 'failed' | 'skipped' | 'notPassed'> {
  const stats = isRecord(report) && isRecord(report.stats) ? report.stats : {}, notPassed: string[] = [];
  const walk = (suite: unknown): void => {
    if (!isRecord(suite)) return;
    for (const spec of Array.isArray(suite.specs) ? suite.specs as unknown[] : []) {
      if (!isRecord(spec) || spec.ok === true && !JSON.stringify(spec.tests).includes('"status":"skipped"')) continue;
      notPassed.push(`${spec.ok === true ? 'skipped' : 'failed'}: ${String(spec.title)}`);
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites as unknown[] : []) walk(child);
  };
  if (isRecord(report) && Array.isArray(report.suites)) for (const suite of report.suites as unknown[]) walk(suite);
  return { passed: count(stats.expected), failed: count(stats.unexpected) + count(stats.flaky), skipped: count(stats.skipped), notPassed };
}
/** Every tool exited 0, ran something, failed nothing and skipped nothing: a skipped test proves nothing, so it is a failure here. */
export function judgeWorkflow(runs: readonly ToolRun[]): WorkflowJudgement {
  const reasons: string[] = [];
  if (runs.length === 0) reasons.push('Nothing ran');
  for (const run of runs) {
    if (run.status !== 0) reasons.push(`${run.tool} exited ${String(run.status)}`);
    if (run.passed === 0) reasons.push(`${run.tool} passed nothing`);
    if (run.failed > 0) reasons.push(`${run.tool} failed ${run.failed}`);
    if (run.skipped > 0) reasons.push(`${run.tool} skipped ${run.skipped}`);
  }
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}
/** The matrix with a global workflow's verdict in its one cell, citing the report; every other cell and field is kept as it was. */
export function writeGlobalCell(matrix: unknown, workflow: string, verdict: 'PASS' | 'FAIL', evidence: { readonly path: string; readonly sha256: string }): Record<string, unknown> {
  if (!isRecord(matrix) || matrix.schemaVersion !== 1 || !Array.isArray(matrix.cells)) throw new Error('The matrix is not schema version 1');
  if (!/^[0-9a-f]{64}$/.test(evidence.sha256)) throw new Error('The evidence has no SHA-256');
  const cells: readonly unknown[] = matrix.cells;
  const at = cells.flatMap((cell, i) => (isRecord(cell) && cell.configuration === null && cell.workflow === workflow ? [i] : []));
  if (at.length !== 1) throw new Error(`The matrix has ${at.length} cells for ${workflow}`);
  return { ...matrix, cells: cells.map((cell, i) => (i === at[0] ? { configuration: null, workflow, verdict, evidence } : cell)) };
}
