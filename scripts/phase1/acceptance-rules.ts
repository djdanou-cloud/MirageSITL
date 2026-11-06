// The Phase 1 acceptance matrix, checked cell by cell against the evidence it cites (TASK-188, S19), apart from its side effects so
// that it is tested directly. A cell stands only as far as its evidence does: the file must be there, hold the SHA-256 the cell cites,
// be a report of this cell's configuration and workflow with this verdict from the acceptance machine, come from this repository's
// history, and have been made by the sources it names as they stand now. Otherwise the cell is refused, and it counts as not run.
// A failure stays a failure while its report stands: changing a file the run depended on does not make a FAIL go away. No report
// ever enables a runtime mode: nothing in the application reads this.

export const MATRIX_VERDICTS = ['PASS', 'FAIL', 'BLOCKED_EXTERNAL', 'BLOCKED_DECISION', 'NOT_RUN'] as const;
export type MatrixVerdict = (typeof MATRIX_VERDICTS)[number];
export type RefusalKind = 'missing' | 'forged' | 'invalid' | 'stale';
export interface CellResult {
  readonly configuration: string | null;
  readonly workflow: string;
  /** What the matrix says. */
  readonly stated: MatrixVerdict;
  /** What stands after the check. */
  readonly verdict: MatrixVerdict;
  readonly evidence: { readonly path: string; readonly sha256: string } | null;
  readonly blockedBy: readonly string[];
  /** Why the evidence was refused, or null. */
  readonly refused: { readonly kind: RefusalKind; readonly reason: string } | null;
}
export interface MatrixAssessment {
  /** PASS only when every cell passed; FAIL with any failure or refused report; otherwise what is left to do. */
  readonly status: 'PASS' | 'FAIL' | 'BLOCKED_EXTERNAL' | 'BLOCKED_DECISION' | 'NOT_RUN';
  readonly counts: { readonly [V in MatrixVerdict]: number };
  readonly refused: number;
  readonly cells: readonly CellResult[];
}
/** What the check reads of the world. */
export interface EvidenceAccess {
  /** The file's bytes, or null. */
  read(path: string): Uint8Array | null;
  sha256(bytes: Uint8Array): string;
  /** The checkout's SHA-256 of a tracked source, or null when it is gone. */
  sourceSha256(path: string): string | null;
  /** Whether a commit is in this checkout's history. */
  inHistory(commit: string): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isVerdict = (value: unknown): value is MatrixVerdict => MATRIX_VERDICTS.some(verdict => verdict === value);
const SHA256 = /^[0-9a-f]{64}$/;

interface Cell { readonly configuration: string | null; readonly workflow: string; readonly verdict: MatrixVerdict; readonly evidence: { readonly path: string; readonly sha256: string } | null; readonly blockedBy: readonly string[] }
/** The matrix's cells, every field checked, and that they are exactly the cross product its workflows declare. */
export function parseMatrix(value: unknown): readonly Cell[] {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('The matrix is not schema version 1');
  const { configurations, workflows, cells } = value;
  if (!Array.isArray(configurations) || !Array.isArray(workflows) || !Array.isArray(cells)) throw new Error('The matrix has no configurations, workflows or cells');
  const ids: string[] = configurations.map((item: unknown) => { if (!isRecord(item) || typeof item.id !== 'string') throw new Error('A configuration has no id'); return item.id; });
  const expected = new Set<string>();
  for (const item of workflows as unknown[]) {
    if (!isRecord(item) || typeof item.id !== 'string') throw new Error('A workflow has no id');
    if (item.appliesTo === 'global') expected.add(`|${item.id}`);
    else if (item.appliesTo === 'each-configuration') for (const id of ids) expected.add(`${id}|${item.id}`);
    else if (Array.isArray(item.appliesTo)) for (const id of item.appliesTo as unknown[]) { if (typeof id !== 'string' || !ids.includes(id)) throw new Error(`${item.id} names an unknown configuration`); expected.add(`${id}|${item.id}`); }
    else throw new Error(`${item.id} says nothing of where it applies`);
  }
  const seen = new Set<string>();
  const parsed = (cells as unknown[]).map((item, index): Cell => {
    if (!isRecord(item) || typeof item.workflow !== 'string' || !(item.configuration === null || typeof item.configuration === 'string') || !isVerdict(item.verdict)) throw new Error(`cells[${index}] is not a cell`);
    const key = `${item.configuration ?? ''}|${item.workflow}`;
    if (!expected.has(key)) throw new Error(`cells[${index}] is ${key}, which no workflow declares`);
    if (seen.has(key)) throw new Error(`The matrix has two cells for ${key}`);
    seen.add(key);
    const raw = item.evidence;
    if (!(raw === null || (isRecord(raw) && typeof raw.path === 'string' && typeof raw.sha256 === 'string' && SHA256.test(raw.sha256)))) throw new Error(`${key} has malformed evidence`);
    const blockedBy = item.blockedBy === undefined ? [] : item.blockedBy;
    if (!Array.isArray(blockedBy) || !blockedBy.every((entry: unknown) => typeof entry === 'string')) throw new Error(`${key} has a malformed blockedBy`);
    return { configuration: item.configuration, workflow: item.workflow, verdict: item.verdict, evidence: raw === null ? null : { path: raw.path as string, sha256: raw.sha256 as string }, blockedBy: blockedBy };
  });
  for (const key of expected) if (!seen.has(key)) throw new Error(`The matrix has no cell for ${key}`);
  return parsed;
}

function checkEvidence(cell: Cell, access: EvidenceAccess): { readonly kind: RefusalKind; readonly reason: string } | null {
  const { evidence } = cell;
  if (!evidence) return null;
  const bytes = access.read(evidence.path);
  if (bytes === null) return { kind: 'missing', reason: `${evidence.path} is not there` };
  const actual = access.sha256(bytes);
  if (actual !== evidence.sha256) return { kind: 'forged', reason: `${evidence.path} has SHA-256 ${actual}, not the cited ${evidence.sha256}` };
  let report: unknown;
  try { report = JSON.parse(new TextDecoder().decode(bytes)); } catch { return { kind: 'invalid', reason: `${evidence.path} is not JSON` }; }
  if (!isRecord(report)) return { kind: 'invalid', reason: `${evidence.path} is not a report` };
  const configuration = isRecord(report.configuration) ? report.configuration.id : report.configuration ?? null;
  if (configuration !== cell.configuration) return { kind: 'invalid', reason: `the report is of ${String(configuration)}, not ${String(cell.configuration)}` };
  const verdicts = report.verdicts, entry = isRecord(verdicts) ? verdicts[cell.workflow] : undefined;
  if (!isRecord(entry) || !isVerdict(entry.verdict)) return { kind: 'invalid', reason: `the report has no verdict for ${cell.workflow}` };
  if (entry.verdict !== cell.verdict) return { kind: 'forged', reason: `the matrix says ${cell.verdict} and its report says ${entry.verdict}` };
  if (report.settings !== 'acceptance') return { kind: 'invalid', reason: `the report flew ${String(report.settings)} settings` };
  const machine = report.acceptanceMachine;
  if (!isRecord(machine) || machine.admitted !== true) return { kind: 'invalid', reason: 'the report is not from the acceptance machine of A-01' };
  const application = report.application;
  if (!isRecord(application) || typeof application.commit !== 'string') return { kind: 'invalid', reason: 'the report names no commit' };
  if (!access.inHistory(application.commit)) return { kind: 'stale', reason: `its commit ${application.commit} is not in this checkout's history` };
  if (!isRecord(report.sources) || Object.keys(report.sources).length === 0) return { kind: 'invalid', reason: 'the report names no sources' };
  const changed = Object.entries(report.sources).filter(([path, sha]) => access.sourceSha256(path) !== sha).map(([path]) => path);
  if (changed.length > 0) return { kind: 'stale', reason: `made by other versions of ${changed.join(', ')}` };
  return null;
}

export function assessMatrix(matrix: unknown, access: EvidenceAccess): MatrixAssessment {
  const cells = parseMatrix(matrix).map((cell): CellResult => {
    const base = { configuration: cell.configuration, workflow: cell.workflow, stated: cell.verdict, evidence: cell.evidence, blockedBy: cell.blockedBy };
    if (cell.verdict === 'BLOCKED_DECISION' && cell.blockedBy.length === 0) return { ...base, verdict: 'NOT_RUN', refused: { kind: 'invalid', reason: 'blocked on a decision it does not name' } };
    if ((cell.verdict === 'PASS' || cell.verdict === 'FAIL') && !cell.evidence) return { ...base, verdict: 'NOT_RUN', refused: { kind: 'missing', reason: `${cell.verdict} cites no evidence` } };
    const refused = checkEvidence(cell, access);
    // A failure stands while its report stands, however old it is: a change of a source does not make it pass.
    if (refused?.kind === 'stale' && cell.verdict === 'FAIL') return { ...base, verdict: 'FAIL', refused: null };
    return { ...base, verdict: refused ? 'NOT_RUN' : cell.verdict, refused };
  });
  const counts = Object.fromEntries(MATRIX_VERDICTS.map(verdict => [verdict, cells.filter(cell => cell.verdict === verdict).length])) as { [V in MatrixVerdict]: number };
  const refused = cells.filter(cell => cell.refused !== null).length;
  const status: MatrixAssessment['status'] = counts.FAIL > 0 || cells.some(cell => cell.refused !== null && cell.refused.kind !== 'stale') ? 'FAIL'
    : counts.PASS === cells.length ? 'PASS' : counts.NOT_RUN > 0 ? 'NOT_RUN' : counts.BLOCKED_DECISION > 0 ? 'BLOCKED_DECISION' : 'BLOCKED_EXTERNAL';
  return { status, counts, refused, cells };
}

/** What Phase 1 still waits on beside the matrix (TASK-191). */
export interface OpenItem { readonly id: string; readonly kind: 'task' | 'decision' | 'measurement'; readonly status: string; readonly what: string }
/**
 * The tasks milestone M6 needs that are not DONE, from the roadmap's own text: TASK-185 to TASK-190 and whatever TASK-191 depends on. Each
 * with its status and the sentence after it, or the whole list empty when they are done. A task the roadmap does not hold is named too.
 */
export function openTasksOf(roadmap: string): OpenItem[] {
  const section = (id: string): string | null => {
    const at = roadmap.indexOf(`### TASK-${id} `);
    if (at < 0) return null;
    const next = roadmap.indexOf('\n### ', at + 1);
    return next < 0 ? roadmap.slice(at) : roadmap.slice(at, next);
  };
  const dependencies = /\*\*Dependencies:\*\*\s*([^\n]*)/.exec(section('191') ?? '')?.[1] ?? '';
  const ids = new Set<string>(['185', '186', '187', '188', '189', '190', ...[...dependencies.matchAll(/TASK-(\d+)/g)].map(match => match[1] ?? '')]);
  const open: OpenItem[] = [];
  for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) {
    const text = section(id);
    if (text === null) { open.push({ id: `TASK-${id}`, kind: 'task', status: 'MISSING', what: 'The roadmap does not hold this task' }); continue; }
    const status = /\*\*Status:\*\*\s*([A-Z_]+)([^\n]*)/.exec(text);
    if (status?.[1] === 'DONE') continue;
    open.push({ id: `TASK-${id}`, kind: 'task', status: status?.[1] ?? 'UNKNOWN', what: (/^### TASK-\d+\s+—\s+([^\n]*)/.exec(text)?.[1] ?? '').trim() });
  }
  return open;
}
/** Accepted only with every cell PASS and nothing open; the reasons say what stands in the way. */
export function acceptanceOf(assessment: Pick<MatrixAssessment, 'status' | 'counts'>, open: readonly OpenItem[]): { readonly accepted: boolean; readonly reasons: readonly string[] } {
  const reasons = [...(assessment.status === 'PASS' ? [] : [`The matrix is ${assessment.status}: ${Object.entries(assessment.counts).map(([verdict, count]) => `${count} ${verdict}`).join(', ')}`]),
    ...open.map(item => `${item.id} is ${item.status}: ${item.what}`)];
  return { accepted: reasons.length === 0, reasons };
}
