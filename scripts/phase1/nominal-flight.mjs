#!/usr/bin/env node
// TASK-158: the Phase 1 nominal flight acceptance on the reference Mac.
//
//   node scripts/phase1/nominal-flight.mjs [--configuration ID]... [--chrome PATH] [--stock-settings]
//
// Runs tests/browser/phase1-nominal.spec.ts in Google Chrome for the chosen S19
// configurations (all five by default: quad, hexa, octo, x8, octo-paired-16).
// The spec drives the application's UI alone with the installed ArduCopter of
// the TASK-152 home and writes one run file per configuration, with the run's
// DataFlash files, to a fresh directory under test-results/phase1/nominal/
// (ignored). This script checks each run file with
// scripts/phase1/nominal-rules.ts, refuses a run file from an earlier
// invocation and a capture whose bytes differ from its recorded SHA-256, and
// writes the configuration's evidence report to
// test-results/validation/phase1-nominal/<id>.json. On the acceptance machine
// of A-01 only, it also writes the verdicts into the configuration's five
// TASK-158 cells of docs/validation/phase1-matrix.json, citing the report and
// its SHA-256. --stock-settings is the negative control of decision A-13: it
// flies without the configurations' tuning and writes <id>-stock-settings.json,
// and never the matrix. Exit codes: 0 when every workflow passed; 1 when one failed or
// was not reached, or a run file is missing or refused; 2 BLOCKED_EXTERNAL
// (not macOS on Apple Silicon, no TASK-152 installation, or no Chrome).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRITERIA, MATRIX_PATH, NOMINAL_CONFIGURATIONS, NOMINAL_TASK, REPORT_DIRECTORY, REPORT_SCHEMA_VERSION, STOCK_SETTINGS,
  acceptanceMachineReasons, configurationOf, judgeRun, parseNominalRun, writeNominalCells,
} from './nominal-rules.ts';
import { applicationFacts, hostFacts, sha256 } from './run-facts.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HOME = join(ROOT, '.cache/task-152/home');
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SPEC = 'tests/browser/phase1-nominal.spec.ts';
/** The files that define the acceptance run, hashed into every report. */
const SOURCES = [
  SPEC, 'scripts/phase1/nominal-flight.mjs', 'scripts/phase1/nominal-rules.ts', 'tests/support/aircraft-ui.ts', 'tests/support/aircraft-recipes.ts',
  'tests/support/run-tab.ts', 'tests/support/standard-gear.ts', 'playwright.config.ts',
  ...['motor', 'propeller', 'esc', 'battery'].map(type => `tests/fixtures/components/${type}-example.json`),
  ...NOMINAL_CONFIGURATIONS.map(c => `tests/fixtures/aircraft/${c.fixture}.json`),
];

function parseArguments(argv) {
  const chosen = [];
  let chrome = DEFAULT_CHROME, settings = 'acceptance';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[i + 1];
    if (flag === '--configuration' && value !== undefined) { chosen.push(configurationOf(value).id); i++; }
    else if (flag === '--chrome' && value !== undefined) { chrome = value; i++; }
    else if (flag === '--stock-settings') settings = 'stock';
    else throw new Error(`Unknown argument ${flag}; use --configuration ID (${NOMINAL_CONFIGURATIONS.map(c => c.id).join(', ')}), --chrome PATH or --stock-settings`);
  }
  return { ids: chosen.length > 0 ? chosen : NOMINAL_CONFIGURATIONS.map(c => c.id), chrome, settings };
}

function blocked(reason) {
  console.error(`BLOCKED_EXTERNAL: ${reason}`);
  process.exit(2);
}

function main() {
  const { ids, chrome, settings } = parseArguments(process.argv.slice(2));
  if (process.platform !== 'darwin' || process.arch !== 'arm64') blocked(`${process.platform} ${process.arch}: Phase 1 acceptance runs on macOS on Apple Silicon`);
  if (!existsSync(join(HOME, 'install-manifest.json'))) blocked('no TASK-152 installation in .cache/task-152/home: run node scripts/install-macos.mjs');
  if (!existsSync(chrome)) blocked(`no Google Chrome at ${chrome}: install it or pass --chrome PATH`);

  // What this run is, taken before it: the checkout and the files that define it.
  const application = applicationFacts(ROOT, [REPORT_DIRECTORY, MATRIX_PATH]);
  const sources = Object.fromEntries(SOURCES.map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
  const started = Date.now();
  const out = join(ROOT, 'test-results/phase1/nominal', new Date(started).toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  console.log(`TASK-158 nominal acceptance: ${ids.join(', ')} with ${settings} settings in ${chrome}; run files in ${relative(ROOT, out)}`);
  // The Mac's own GPU, as a user's Chrome renders the Run tab (Playwright's default is a software renderer).
  const loadBefore = loadavg();
  const playwright = spawnSync(process.execPath, [join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', SPEC], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, MIRAGE_PHASE1_NOMINAL: '1', MIRAGE_PHASE1_CONFIGURATIONS: ids.join(','), MIRAGE_PHASE1_OUT: out, CHROMIUM_PATH: chrome,
      MIRAGE_BROWSER_GPU: 'hardware', MIRAGE_PHASE1_STOCK: settings === 'stock' ? '1' : '0' },
  });
  console.log(`Playwright exited with ${playwright.status ?? playwright.signal}`);

  // Other programs share the CPU, which sets the measured run speed, so the load averages go with the evidence.
  const host = { ...hostFacts(ROOT), loadAverages: { before: loadBefore, after: loadavg() } };
  const machine = acceptanceMachineReasons(host);
  let matrix = JSON.parse(readFileSync(join(ROOT, MATRIX_PATH), 'utf8')), allPassed = true;
  mkdirSync(join(ROOT, REPORT_DIRECTORY), { recursive: true });
  for (const id of ids) {
    const runPath = join(out, `${id}.json`);
    if (!existsSync(runPath)) {
      console.error(`${id}: the spec wrote no run file; the matrix keeps its cells`);
      allPassed = false;
      continue;
    }
    const bytes = readFileSync(runPath), run = parseNominalRun(JSON.parse(bytes.toString('utf8')));
    if (run.configuration !== id) throw new Error(`${relative(ROOT, runPath)} is a run of ${run.configuration}`);
    if (run.settings !== settings) throw new Error(`${relative(ROOT, runPath)} flew ${run.settings} settings, not ${settings}`);
    // Only a run of this invocation: a run file from an earlier run, or another host, is never evidence here.
    if (!(Date.parse(run.startedAt) >= started)) throw new Error(`${id}: the run file started at ${run.startedAt}, before this invocation`);
    const dataflash = run.captures.dataflash.map(file => {
      const captured = readFileSync(join(out, file.file));
      if (captured.length !== file.bytes || sha256(captured) !== file.sha256) throw new Error(`${id}: ${file.name} differs from its recorded size or SHA-256`);
      return { name: file.name, bytes: file.bytes, sha256: file.sha256, status: file.status, records: file.records, truncatedBytes: file.truncatedBytes,
        firmwareMatchesBuild: file.firmwareMatchesBuild };
    });
    const verdicts = judgeRun(run), start = run.steps.start?.facts ?? null;
    const report = {
      schemaVersion: REPORT_SCHEMA_VERSION, task: NOMINAL_TASK, configuration: configurationOf(id), settings: run.settings, recordedAt: run.finishedAt,
      criteria: CRITERIA, stockSettings: STOCK_SETTINGS,
      host, acceptanceMachine: { admitted: machine.length === 0, reasons: machine },
      browser: { name: 'Google Chrome', executable: chrome, ...run.browser },
      application, firmware: start ? start.firmware : null,
      verdicts,
      captures: {
        run: { path: relative(ROOT, runPath), bytes: bytes.length, sha256: sha256(bytes) },
        experimentRecord: start ? { sha256: start.recordSha256, launcherExperimentId: run.captures.launcherExperimentId } : null,
        dataflash, recording: run.captures.recording, speed: run.captures.speed, power: run.captures.power, steadiness: run.captures.steadiness,
        flownSettings: run.captures.flownSettings,
      },
      steps: run.steps,
      sources,
    };
    const reportPath = `${REPORT_DIRECTORY}/${id}${settings === 'stock' ? '-stock-settings' : ''}.json`, reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(join(ROOT, reportPath), reportBytes);
    if (machine.length === 0 && settings === 'acceptance') matrix = writeNominalCells(matrix, id, verdicts, { path: reportPath, sha256: sha256(reportBytes) });
    for (const [workflow, verdict] of Object.entries(verdicts)) {
      console.log(`${id} ${workflow}: ${verdict.verdict}${verdict.reasons.length > 0 ? ` (${verdict.reasons.join('; ')})` : ''}`);
      if (verdict.verdict !== 'PASS') allPassed = false;
    }
    // Decision A-13 judges these: the altitude criterion cannot see an attitude oscillation.
    const held = run.captures.steadiness?.hold ?? null;
    if (held) console.log(`${id} hold body rates, standard deviation: roll ${held.roll.sdDegS.toFixed(2)}, pitch ${held.pitch.sdDegS.toFixed(2)}, yaw ${held.yaw.sdDegS.toFixed(2)} deg/s (${held.samples} samples)`);
    const speed = run.captures.speed;
    if (speed) console.log(`${id} run speed: ${speed.verdict} (${speed.simElapsedS.toFixed(1)} s simulated in ${speed.runningWallS.toFixed(1)} s of running wall time)`);
    console.log(`${id}: ${reportPath} ${sha256(reportBytes)}`);
  }
  if (machine.length > 0) console.log(`Not the acceptance machine of A-01 (${machine.join('; ')}): the reports are written, the matrix is not`);
  else if (settings === 'stock') console.log('Stock settings are the negative control: the report is written, the matrix is not');
  else writeFileSync(join(ROOT, MATRIX_PATH), `${JSON.stringify(matrix, null, 2)}\n`);
  process.exit(allPassed ? 0 : 1);
}

main();
