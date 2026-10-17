// Local visible demo measurement; deliberately cannot issue TASK-073 acceptance.
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}
const warmupS = Number(option('warmup', '60')), durationS = Number(option('seconds', '120'));
const mode = option('backend', 'webgl2');
const nativeViewport = process.argv.includes('--native-viewport');
const position = option('position', null);
if (position !== null && !/^-?\d+,-?\d+$/.test(position)) throw new Error('Invalid window position');
if (!Number.isFinite(warmupS) || warmupS < 1 || warmupS > 600 || !Number.isFinite(durationS) || durationS < 1 || durationS > 3600 || !['webgl2', 'webgpu'].includes(mode)) throw new Error('Invalid probe options');
const directory = option('out', 'test-results/laptop');
const readyFile = option('ready-file', null);
if (readyFile && existsSync(readyFile)) throw new Error('Operator readiness file already exists; use a fresh path');
mkdirSync(directory, { recursive: true });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const server = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), 'preview', 'apps/web', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { stdio: ['ignore','pipe','pipe'], windowsHide: true });
let serverOutput = '';
const output = bytes => { serverOutput = (serverOutput + bytes.toString()).slice(-32768); };
server.stdout.on('data', output);
server.stderr.on('data', output);
let browser;
let result = { schemaVersion: 1, kind: 'laptop-demo-probe', sourceRevision: revision, sourceDirty: execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length > 0,
  probeSha256:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'), recordedAt: new Date().toISOString(), status: 'FAIL', backendRequested: mode,
  viewportMode: nativeViewport ? 'native-window' : 'fixed-1920x1080-dpr1',
  environment: { os: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ramBytes: os.totalmem(), node: process.version },
  limitations: ['Demo scene only; not full production terrain/FPV/thermal.', 'Browser heap size is not CPU cache or GPU residency.', 'No TASK-073 certification or physical flight commands.'] };
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Owned preview server exited before readiness');
    // Do not mistake an unrelated listener for the server this probe owns.
    try { if (serverOutput.includes('http://127.0.0.1:5174') && (await fetch('http://127.0.0.1:5174')).ok) { ready = true; break; } } catch { /* bounded startup polling */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Preview startup deadline');
  const args = position === null ? [] : [`--window-position=${position}`];
  if (nativeViewport) args.push('--start-maximized');
  browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH, args });
  const context = await browser.newContext(nativeViewport ? { viewport: null } : { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await browser.newBrowserCDPSession();
  const systemInfo = await cdp.send('SystemInfo.getInfo');
  // Retain GPU diagnostics only, not browser command lines or user profile data.
  result.gpuDiagnostics = systemInfo.gpu;
  result.browser = browser.version();
  await page.goto(`http://127.0.0.1:5174/?renderer=${mode}`);
  await page.getByTestId('worker-status').filter({ hasText: 'READY' }).waitFor({ timeout: 30000 });
  await page.locator('canvas[data-render-backend]').waitFor({ timeout: 30000 });
  result.backendActual = await page.locator('canvas[data-render-backend]').getAttribute('data-render-backend');
  result.fallbackReason = await page.locator('canvas[data-render-backend]').getAttribute('data-render-fallback');
  if (readyFile) {
    console.log(`Waiting for operator display placement: ${readyFile}`);
    const deadline = Date.now() + 15 * 60 * 1000;
    while (!existsSync(readyFile)) {
      if (Date.now() > deadline) throw new Error('Operator placement was not confirmed; measurement did not start');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    result.operatorPlacementConfirmed = true;
  }
  result.capabilities = await page.evaluate(async () => {
    const canvas = globalThis.document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' });
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    const adapter = await globalThis.navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    const controls = globalThis.document.querySelector('.instructor-panel')?.getBoundingClientRect();
    const clientWidth = globalThis.document.documentElement.clientWidth;
    const scrollWidth = globalThis.document.documentElement.scrollWidth;
    return { webglRenderer: renderer, webgpu: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter } : null,
      isolated: globalThis.crossOriginIsolated, secure: globalThis.isSecureContext, dpr: globalThis.devicePixelRatio, width: globalThis.innerWidth, height: globalThis.innerHeight, outerWidth:globalThis.outerWidth, outerHeight:globalThis.outerHeight,
      clientWidth, scrollWidth, controlsRight:controls?.right ?? null, layoutFitsHorizontally:!!controls && scrollWidth<=clientWidth+1 && controls.right<=clientWidth+1,
      screenX:globalThis.screenX, screenY:globalThis.screenY, userAgent: globalThis.navigator.userAgent };
  });
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  console.log(`Visible ${mode} demo: ${warmupS}s warmup then ${durationS}s frame capture.`);
  const measurement = await page.evaluate(async ({ warmupS, durationS }) => {
    const memory = () => globalThis.performance.memory?.usedJSHeapSize ?? null;
    const initialHeapBytes = memory();
    const visibilityChanges = [];
    const visibility = () => visibilityChanges.push({ timeMs: globalThis.performance.now(), state: globalThis.document.visibilityState });
    globalThis.document.addEventListener('visibilitychange', visibility);
    const hiddenAtStart = globalThis.document.hidden;
    try {
      await new Promise(resolve => setTimeout(resolve, warmupS * 1000));
      const warmedHeapBytes = memory();
      const frameMs = [];
      await new Promise(resolve => {
        let first, previous;
        const frame = timestamp => {
          if (first === undefined) { first = timestamp; previous = timestamp; }
          else { frameMs.push(timestamp - previous); previous = timestamp; }
          if (timestamp - first >= durationS * 1000) resolve();
          else globalThis.requestAnimationFrame(frame);
        };
        globalThis.requestAnimationFrame(frame);
      });
      const sorted = [...frameMs].sort((a,b) => a-b), p = q => sorted[Math.ceil(q * sorted.length)-1];
      const measuredS = frameMs.reduce((a,b)=>a+b,0)/1000;
      return { warmupS, requestedDurationS: durationS, measuredS, frames: frameMs.length, averageFps: frameMs.length/measuredS, p50FrameMs:p(.5), p95FrameMs:p(.95), p99FrameMs:p(.99), maxFrameMs:sorted.at(-1), intervalsOver33Ms:frameMs.filter(v=>v>33.34).length, initialHeapBytes, warmedHeapBytes, finalHeapBytes:memory(), hiddenAtStart, visibilityChanges, frameMs };
    } finally { globalThis.document.removeEventListener('visibilitychange', visibility); }
  }, { warmupS, durationS });
  result = { ...result, measurement, errors, status: errors.length === 0 && result.backendActual === mode && result.capabilities.layoutFitsHorizontally && !measurement.hiddenAtStart && measurement.visibilityChanges.every(v=>v.state==='visible') ? 'PASS' : 'FAIL' };
  await page.screenshot({ path: `${directory}/demo-${mode}.png`, fullPage: true });
  console.log(JSON.stringify({ status:result.status, backend:result.backendActual, renderer:result.capabilities.webglRenderer, fps:measurement.averageFps, p99Ms:measurement.p99FrameMs }));
} catch (error) { result.error = error instanceof Error ? error.message : String(error); console.error(result.error); }
finally {
  await browser?.close();
  server.kill();
  writeFileSync(`${directory}/demo-${mode}.json`, JSON.stringify(result, null, 2) + '\n');
}
process.exitCode = result.status === 'PASS' ? 0 : 1;
