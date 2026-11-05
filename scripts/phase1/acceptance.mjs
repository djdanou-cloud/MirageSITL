#!/usr/bin/env node
// TASK-188: the Phase 1 acceptance matrix, checked against its evidence.
//
//   node scripts/phase1/acceptance.mjs [--matrix PATH] [--out PATH]
//
// Checks every cell of docs/validation/phase1-matrix.json by the rules of
// scripts/phase1/acceptance-rules.ts, prints each that is not a plain PASS,
// and writes the assessment to test-results/validation/phase1-acceptance.json
// with the matrix's SHA-256. Evidence comes from the runners, which write
// their cells themselves only on the acceptance machine:
// scripts/phase1/nominal-flight.mjs for the nine workflows of each
// configuration. Exit codes, as the repository's other checks: 0 when every
// cell passed; 1 on a failure or on evidence refused as forged, missing or
// invalid; 2 when cells are left to run, a stale report among them. A report
// never enables a runtime mode.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessMatrix } from './acceptance-rules.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parseArguments(argv) {
  let matrix = 'docs/validation/phase1-matrix.json', out = 'test-results/validation/phase1-acceptance.json';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[i + 1];
    if (flag === '--matrix' && value !== undefined) { matrix = value; i++; } else if (flag === '--out' && value !== undefined) { out = value; i++; } else throw new Error(`Unknown argument ${flag}; use --matrix PATH or --out PATH`);
  }
  return { matrix, out };
}
const inside = path => { const full = isAbsolute(path) ? path : join(ROOT, path), rel = relative(ROOT, full); return rel.startsWith('..') || isAbsolute(rel) ? null : full; };
const access = {
  read(path) { const full = inside(path); return full !== null && existsSync(full) && statSync(full).isFile() ? readFileSync(full) : null; },
  sha256,
  sourceSha256(path) { const full = inside(path); return full !== null && existsSync(full) && statSync(full).isFile() ? sha256(readFileSync(full)) : null; },
  inHistory(commit) { return /^[0-9a-f]{40}$/.test(commit) && spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: ROOT }).status === 0; },
};

const { matrix, out } = parseArguments(process.argv.slice(2));
const bytes = readFileSync(join(ROOT, matrix)), assessment = assessMatrix(JSON.parse(bytes.toString('utf8')), access);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const report = { schemaVersion: 1, task: 'TASK-188', kind: 'phase1-acceptance', commit, matrix: { path: matrix, sha256: sha256(bytes) }, ...assessment };
const target = join(ROOT, out);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
for (const cell of assessment.cells) {
  if (cell.verdict === 'PASS') continue;
  const name = `${cell.configuration ?? 'global'} × ${cell.workflow}`;
  console.log(`${cell.verdict.padEnd(16)} ${name}${cell.refused ? ` (${cell.refused.kind}: ${cell.refused.reason})` : ''}${cell.blockedBy.length > 0 ? ` (waits on ${cell.blockedBy.join(', ')})` : ''}`);
}
console.log(`${assessment.status}: ${Object.entries(assessment.counts).map(([verdict, count]) => `${count} ${verdict}`).join(', ')}; ${assessment.refused} refused. ${out}`);
process.exit(assessment.status === 'PASS' ? 0 : assessment.status === 'FAIL' ? 1 : 2);
