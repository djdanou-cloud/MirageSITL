#!/usr/bin/env node
// TASK-190: the matrix's global workflows on the reference Mac, each with the network blocked for everything it starts.
//
//   node scripts/phase1/global-workflows.mjs [--workflow ID]... [--chrome PATH]
//
// sandbox-exec denies every outbound connection except to this computer, for this run's processes only (no system setting changes), and a
// probe shows it: the loopback connects and an outside address is refused, before any test runs. Each workflow is its own tests from
// WORKFLOWS in scripts/phase1/global-rules.ts, and a test that skips counts against it, since a skipped test proves nothing. This writes
// test-results/validation/phase1-global/<workflow>.json with the host, the checkout and the sources, and on the acceptance machine of A-01
// the workflow's matrix cell, citing the report and its SHA-256. Exit codes: 0 every workflow passed; 1 one failed; 2 BLOCKED_EXTERNAL
// (not macOS on Apple Silicon, no TASK-152 installation, no Chrome, or no way to block the network).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOBAL_REPORT_DIRECTORY, GLOBAL_TASK, WORKFLOWS, judgeWorkflow, playwrightCounts, vitestCounts, writeGlobalCell } from './global-rules.ts';
import { MATRIX_PATH, acceptanceMachineReasons } from './nominal-rules.ts';
import { applicationFacts, hostFacts, sha256 } from './run-facts.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HOME = join(ROOT, '.cache/task-152/home');
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/**
 * Outbound connections only to this computer. A process keeps everything else it may do. macOS refuses to run a setuid program inside a
 * sandbox, so /bin/ps, which the launcher tests use to see a process group and which reaches no network, runs outside it.
 */
const NETWORK_BLOCK = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))(allow process-exec (literal "/bin/ps") (with no-sandbox))';
const PROBE = `const net=require('net');const connect=(host,port)=>new Promise(done=>{const s=net.connect({host,port,timeout:3000},()=>{s.destroy();done('connected');});s.on('error',e=>done(e.code));s.on('timeout',()=>{s.destroy();done('timeout');});});
const server=net.createServer().listen(0,'127.0.0.1',async()=>{const loopback=await connect('127.0.0.1',server.address().port),outside=await connect('1.1.1.1',443);console.log(JSON.stringify({loopback,outside}));server.close();});`;

function blocked(reason) {
  console.error(`BLOCKED_EXTERNAL: ${reason}`);
  process.exit(2);
}
const sandboxed = (command, args, options) => spawnSync('/usr/bin/sandbox-exec', ['-p', NETWORK_BLOCK, command, ...args], { cwd: ROOT, encoding: 'utf8', ...options });

function main() {
  const argv = process.argv.slice(2), chosen = [];
  let chrome = DEFAULT_CHROME;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--workflow' && argv[i + 1]) chosen.push(argv[i + 1]);
    else if (argv[i] === '--chrome' && argv[i + 1]) chrome = argv[i + 1];
    else blocked(`Unexpected argument ${argv[i]}`);
  }
  const workflows = chosen.length > 0 ? chosen.map(id => { const found = WORKFLOWS.find(item => item.id === id); if (!found) blocked(`Unknown workflow ${id}`); return found; }) : WORKFLOWS;
  if (process.platform !== 'darwin' || process.arch !== 'arm64') blocked(`${process.platform} ${process.arch}: Phase 1 acceptance runs on macOS on Apple Silicon`);
  if (!existsSync(join(HOME, 'install-manifest.json'))) blocked('no TASK-152 installation in .cache/task-152/home: run node scripts/install-macos.mjs');
  if (!existsSync(chrome)) blocked(`no Google Chrome at ${chrome}: install it or pass --chrome PATH`);
  const probe = sandboxed(process.execPath, ['-e', PROBE], {});
  const network = probe.status === 0 ? JSON.parse(probe.stdout) : null;
  if (network?.loopback !== 'connected' || network?.outside === 'connected') blocked(`the network block does not hold: ${probe.stdout || probe.stderr}`);
  console.log(`${GLOBAL_TASK}: network blocked: loopback ${network.loopback}, outside ${network.outside}`);

  const directory = mkdtempSync(join(tmpdir(), 'mirage-global-')), application = applicationFacts(ROOT, [GLOBAL_REPORT_DIRECTORY, MATRIX_PATH]);
  const env = { ...process.env, CHROMIUM_PATH: chrome, MIRAGE_BROWSER_GPU: 'hardware', MIRAGE_UAVLOGVIEWER_DIR: join(HOME, 'uavlogviewer') };
  let matrix = JSON.parse(readFileSync(join(ROOT, MATRIX_PATH), 'utf8')), allPassed = true;
  mkdirSync(join(ROOT, GLOBAL_REPORT_DIRECTORY), { recursive: true });
  try {
    for (const workflow of workflows) {
      const sources = Object.fromEntries(['scripts/phase1/global-workflows.mjs', 'scripts/phase1/global-rules.ts', 'playwright.config.ts', ...workflow.playwright, ...workflow.vitest].map(path => [path, sha256(readFileSync(join(ROOT, path)))]));
      const loadBefore = loadavg(), runs = [];
      if (workflow.vitest.length > 0) {
        const out = join(directory, `${workflow.id}-vitest.json`);
        const result = sandboxed(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', ...workflow.vitest, '--reporter=json', `--outputFile=${out}`], { env, stdio: 'ignore', timeout: 3600_000 });
        runs.push({ tool: 'vitest', status: result.status, ...vitestCounts(existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null) });
      }
      if (workflow.playwright.length > 0) {
        const out = join(directory, `${workflow.id}-playwright.json`);
        const result = sandboxed(process.execPath, [join(ROOT, 'node_modules/@playwright/test/cli.js'), 'test', ...workflow.playwright, '--workers=1', '--reporter=json'],
          { env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: out }, stdio: 'ignore', timeout: 3 * 3600_000 });
        runs.push({ tool: 'playwright', status: result.status, ...playwrightCounts(existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null) });
      }
      const judgement = judgeWorkflow(runs), host = { ...hostFacts(ROOT), loadAverages: { before: loadBefore, after: loadavg() } }, machine = acceptanceMachineReasons(host);
      const report = { schemaVersion: 1, task: GLOBAL_TASK, configuration: null, settings: 'acceptance', workflow: workflow.id, criterion: workflow.criterion, network: { blocked: true, ...network },
        verdicts: { [workflow.id]: judgement }, acceptanceMachine: { admitted: machine.length === 0, reasons: machine }, host, application, sources, runs };
      const text = `${JSON.stringify(report, null, 2)}\n`, reportPath = `${GLOBAL_REPORT_DIRECTORY}/${workflow.id}.json`;
      writeFileSync(join(ROOT, reportPath), text);
      console.log(`${workflow.id}: ${judgement.verdict}${judgement.reasons.length > 0 ? ` (${judgement.reasons.join('; ')})` : ''}; ${runs.map(run => `${run.tool} ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped`).join('; ')}`);
      if (machine.length === 0) matrix = writeGlobalCell(matrix, workflow.id, judgement.verdict, { path: reportPath, sha256: sha256(text) });
      if (judgement.verdict !== 'PASS') allPassed = false;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  writeFileSync(join(ROOT, MATRIX_PATH), `${JSON.stringify(matrix, null, 2)}\n`);
  process.exitCode = allPassed ? 0 : 1;
}
main();
