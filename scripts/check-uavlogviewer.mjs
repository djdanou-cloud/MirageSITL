// TASK-130 feasibility check for the pinned UAVLogViewer.
//
//   node scripts/check-uavlogviewer.mjs --source DIR [--dist DIR --log FILE] [--output PATH]
//
// 1. Source identity: DIR must be a checkout of the commit, parser submodule,
//    LICENSE and package-lock.json recorded in third_party/uavlogviewer/source.lock.json.
// 2. Offline smoke (with --dist and --log): serves the built viewer from
//    127.0.0.1, opens the DataFlash log through the viewer's own `?file=` route
//    in Chromium, aborts every request that leaves the loopback server, and
//    passes only when the viewer lists the log's message types. Every aborted
//    origin is reported, so online dependencies stay visible.
//
// The check never builds or installs the viewer. Exit 0 PASS, 1 FAIL,
// 2 BLOCKED_EXTERNAL (missing checkout, build output or log).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const LOCK = join(root, "third_party/uavlogviewer/source.lock.json");
const LOG_ROUTE = "/mirage-check-log.bin";
const MAX_LOG_BYTES = 256 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 180000;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".xml": "application/xml" };

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function argument(name) {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
}

class Blocked extends Error {}

function readLock() {
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  if (lock?.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(String(lock.commit)) || !Array.isArray(lock.submodules) ||
    !/^[0-9a-f]{64}$/.test(String(lock.license?.sha256)) || !/^[0-9a-f]{64}$/.test(String(lock.buildInputs?.packageLockSha256))) {
    throw new Error("third_party/uavlogviewer/source.lock.json is malformed");
  }
  return lock;
}

const gitHead = directory => execFileSync("git", ["-C", directory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

/** Source identity of a checkout against the lock; returns a list of mismatches. */
function checkSource(lock, source) {
  const failures = [];
  if (gitHead(source) !== lock.commit) failures.push(`checkout is not at commit ${lock.commit}`);
  for (const module of lock.submodules) {
    const path = join(source, module.path);
    if (!existsSync(path) || gitHead(path) !== module.commit) failures.push(`submodule ${module.path} is not at ${module.commit}`);
  }
  if (sha256(readFileSync(join(source, lock.license.file))) !== lock.license.sha256) failures.push("LICENSE differs from the lock");
  if (sha256(readFileSync(join(source, "package-lock.json"))) !== lock.buildInputs.packageLockSha256) failures.push("package-lock.json differs from the lock");
  return failures;
}

function serve(dist, logBytes) {
  const base = resolve(dist);
  return createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (path === LOG_ROUTE) {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(logBytes);
      return;
    }
    const file = resolve(base, "." + (path.endsWith("/") ? path + "index.html" : path));
    if ((file !== base && !file.startsWith(base + sep)) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
}

async function offlineSmoke(dist, logBytes) {
  const { chromium } = await import("@playwright/test");
  const server = serve(dist, logBytes);
  await new Promise(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const aborted = new Map();
  const consoleErrors = [];
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
    const context = await browser.newContext();
    await context.route("**/*", route => {
      const url = route.request().url();
      if (url.startsWith(origin + "/") || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      let key = url;
      try { key = new URL(url).origin; } catch { /* keep the raw URL */ }
      aborted.set(key, (aborted.get(key) ?? 0) + 1);
      return route.abort("internetdisconnected");
    });
    const page = await context.newPage();
    page.on("console", message => { if (message.type() === "error" && consoleErrors.length < 50) consoleErrors.push(message.text().slice(0, 300)); });
    page.on("pageerror", error => { if (consoleErrors.length < 50) consoleErrors.push(String(error).slice(0, 300)); });
    const started = Date.now();
    await page.goto(`${origin}/?file=${encodeURIComponent(LOG_ROUTE)}`, { waitUntil: "domcontentloaded" });
    let messageTypes = [];
    try {
      await page.waitForSelector("li.type", { timeout: PARSE_TIMEOUT_MS });
      messageTypes = await page.$$eval("li.type a.section", nodes => nodes.map(node => (node.textContent ?? "").trim().split(/\s+/)[0] ?? ""));
    } catch {
      messageTypes = [];
    }
    return {
      browser: browser.version(),
      parseSeconds: Math.round((Date.now() - started) / 100) / 10,
      messageTypes: messageTypes.filter(name => name !== "").sort(),
      abortedOrigins: [...aborted.entries()].map(([key, count]) => ({ origin: key, requests: count })).sort((a, b) => a.origin.localeCompare(b.origin)),
      consoleErrors,
    };
  } finally {
    await browser?.close();
    await new Promise(accept => server.close(accept));
  }
}

function distFiles(dist) {
  const out = [];
  const walk = path => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(dist, full).split(sep).join("/"), bytes: statSync(full).size, sha256: sha256(readFileSync(full)) });
    }
  };
  walk(dist);
  return out;
}

async function main() {
  const lock = readLock();
  const source = argument("--source");
  const dist = argument("--dist");
  const logPath = argument("--log");
  const report = { schemaVersion: 1, task: "TASK-130", repository: lock.repository, commit: lock.commit, checkerSha256: sha256(readFileSync(fileURLToPath(import.meta.url))) };
  if (source === undefined || !existsSync(join(source, ".git"))) throw new Blocked("Provide --source with a checkout of the pinned UAVLogViewer commit");
  const sourceFailures = checkSource(lock, source);
  report.source = { verdict: sourceFailures.length ? "FAIL" : "PASS", failures: sourceFailures };
  if (sourceFailures.length) return { ...report, verdict: "FAIL" };
  if (dist === undefined || logPath === undefined) throw Object.assign(new Blocked("Provide --dist (a build of the pinned source) and --log (a real DataFlash log) for the offline smoke"), { report });
  if (!existsSync(join(dist, "index.html"))) throw Object.assign(new Blocked(`No built viewer at ${dist}`), { report });
  if (!existsSync(logPath)) throw Object.assign(new Blocked(`No log at ${logPath}`), { report });
  const logBytes = readFileSync(logPath);
  if (logBytes.length === 0 || logBytes.length > MAX_LOG_BYTES) throw new Error(`Log size ${logBytes.length} bytes is outside 1..${MAX_LOG_BYTES}`);
  // DataFlash binary logs start with the 0xA3 0x95 message header.
  if (logBytes[0] !== 0xa3 || logBytes[1] !== 0x95) throw new Error("The log is not a DataFlash binary log (missing 0xA3 0x95 header)");
  const outputs = distFiles(dist);
  report.dist = { files: outputs.length, bytes: outputs.reduce((sum, file) => sum + file.bytes, 0),
    sha256: sha256(outputs.map(file => `${file.path}\t${file.sha256}\n`).join("")) };
  const logSha256 = sha256(logBytes);
  report.log = { file: logPath.split(sep).pop(), bytes: logBytes.length, sha256: logSha256, isLockedTestLog: logSha256 === lock.testLog?.sha256 };
  report.smoke = await offlineSmoke(dist, logBytes);
  report.verdict = report.smoke.messageTypes.length > 0 ? "PASS" : "FAIL";
  return report;
}

const output = argument("--output");
let report;
try {
  report = await main();
} catch (error) {
  report = { ...(error?.report ?? {}), verdict: error instanceof Blocked ? "BLOCKED_EXTERNAL" : "FAIL", reason: error instanceof Error ? error.message : String(error) };
}
const text = JSON.stringify(report, null, 2) + "\n";
if (output !== undefined) writeFileSync(output, text);
process.stdout.write(text);
process.exitCode = report.verdict === "PASS" ? 0 : report.verdict === "BLOCKED_EXTERNAL" ? 2 : 1;
