#!/usr/bin/env node
// TASK-189: the 16-motor hour on the reference Mac.
//
//   node scripts/phase1/endurance.mjs [--chrome PATH]
//
// Runs tests/browser/phase1-endurance.spec.ts in Google Chrome, which flies decision A-07's workload with the installed ArduCopter of the
// TASK-152 home and writes a run file. This script refuses a run file from an earlier invocation, judges it by
// scripts/phase1/endurance-rules.ts and writes test-results/validation/phase1-endurance/octo-paired-16.json with the host, the checkout
// and the files that define the run. On the acceptance machine of A-01 only, it also writes the verdict into the matrix's cell, citing the
// report and its SHA-256. A failure against the criteria is recorded as FAIL, never hidden. Exit codes: 0 PASS; 1 FAIL or no run file;
// 2 BLOCKED_EXTERNAL (not macOS on Apple Silicon, no TASK-152 installation, or no Chrome).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENDURANCE_CONFIGURATION, ENDURANCE_CRITERIA, ENDURANCE_REPORT_DIRECTORY, ENDURANCE_TASK, ENDURANCE_WORKFLOW, judgeEndurance, parseEnduranceRun, writeEnduranceCell } from './endurance-rules.ts';
import { MATRIX_PATH, acceptanceMachineReasons } from './nominal-rules.ts';
import { applicationFacts, hostFacts, sha256 } from './run-facts.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HOME = join(ROOT, '.cache/task-152/home');
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SPEC = 'tests/browser/phase1-endurance.spec.ts';
const SOURCES = [SPEC, 'scripts/phase1/endurance.mjs', 'scripts/phase1/endurance-rules.ts', 'tests/support/run-tab.ts', 'playwright.config.ts', 'tests/fixtures/aircraft/octa-coaxial-16.json',
  ...['motor', 'propeller', 'esc', 'battery'].map(type => `tests/fixtures/components/${type}-example.json`)];

function blocked(reason) {
  console.error(`BLOCKED_EXTERNAL: ${reason}`);
  process.exit(2);
}
function main() {
  const at = process.argv.indexOf('--chrome'), chrome = at >= 0 ? process.argv[at + 1] : DEFAULT_CHROME;
  if (process.platform !== 'darwin' || process.arch !== 'arm64') blocked(`${process.platform} ${process.arch}: Phase 1 acceptance runs on macOS on Apple Silicon`);
  if (!existsSync(join(HOME, 'install-manifest.json'))) blocked('no TASK-152 installation in .cache/task-152/home: run node scripts/install-macos.mjs');
  if (!chrome || !existsSync(chrome)) blocked(`no Google Chrome at ${chrome}: install it or pass --chrome PATH`);

  const application = applicationFacts(ROOT, [ENDURANCE_REPORT_DIRECTORY, MATRIX_PATH]);
  const sources = Object.fromEntries(SOURCES.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
  const started = Date.now();
  const out = join(ROOT, 'test-results/phase1/endurance', new Date(started).toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  console.log(`${ENDURANCE_TASK} the 16-motor hour in ${chrome}; run file in ${relative(ROOT, out)}`);
  const loadBefore = loadavg();
  const playwright = spawnSync(process.execPath, [join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', SPEC, '--workers=1', '--reporter=line'], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, MIRAGE_PHASE1_ENDURANCE: '1', MIRAGE_PHASE1_OUT: out, CHROMIUM_PATH: chrome, MIRAGE_BROWSER_GPU: 'hardware' },
  });
  console.log(`Playwright exited with ${playwright.status ?? playwright.signal}`);
  const runPath = join(out, `${ENDURANCE_CONFIGURATION}.json`);
  if (!existsSync(runPath)) {
    console.error('The spec wrote no run file; the matrix keeps its cell');
    process.exitCode = 1;
    return;
  }
  const run = parseEnduranceRun(JSON.parse(readFileSync(runPath, 'utf8')));
  if (!(Date.parse(run.startedAt) >= started)) throw new Error(`The run file started at ${run.startedAt}, before this invocation`);
  const host = { ...hostFacts(ROOT), loadAverages: { before: loadBefore, after: loadavg() } };
  const machine = acceptanceMachineReasons(host), judgement = judgeEndurance(run);
  const report = { schemaVersion: 1, task: ENDURANCE_TASK, configuration: { id: ENDURANCE_CONFIGURATION }, settings: 'acceptance', criteria: ENDURANCE_CRITERIA,
    verdicts: { [ENDURANCE_WORKFLOW]: { verdict: judgement.verdict, reasons: judgement.reasons } }, acceptanceMachine: { admitted: machine.length === 0, reasons: machine },
    host, application, sources, run };
  mkdirSync(join(ROOT, ENDURANCE_REPORT_DIRECTORY), { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`, reportPath = `${ENDURANCE_REPORT_DIRECTORY}/${ENDURANCE_CONFIGURATION}.json`;
  writeFileSync(join(ROOT, reportPath), text);
  console.log(`${judgement.verdict}: ${judgement.reasons.join('; ') || 'every limit met'}. Rate: ${run.rate.averageRatio.toFixed(2)} x real time, ${run.rate.executedHz.toFixed(0)} steps per wall second; recording ${(run.recording.bytes / 1e9).toFixed(2)} GB; peak memory ${(run.memory.peakBytes / 1e9).toFixed(2)} GB. Report: ${reportPath}`);
  if (machine.length > 0) {
    console.error(`Not the acceptance machine (${machine.join('; ')}): the matrix keeps its cell`);
  } else {
    const matrix = JSON.parse(readFileSync(join(ROOT, MATRIX_PATH), 'utf8'));
    writeFileSync(join(ROOT, MATRIX_PATH), `${JSON.stringify(writeEnduranceCell(matrix, judgement.verdict, { path: reportPath, sha256: sha256(text) }), null, 2)}\n`);
  }
  process.exitCode = judgement.verdict === 'PASS' ? 0 : 1;
}
main();
