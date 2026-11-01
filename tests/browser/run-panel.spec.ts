import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeCatalogEntry } from "../../apps/launcher/src/catalog";
import { startLauncher } from "../../apps/launcher/src/server";
import { writeFakeFirmware, type FakeFirmware } from "../support/fake-firmware";
import {
  argumentOf, commandWords, field, groupMembers, launcherExperiments, nodeManifestSha256, parameterFile, processesNaming, psGroup,
  readExperimentRecords, seedQuadProject, signalZeroCode, stopEveryRun, type SeededProject,
} from "../support/run-tab";

// TASK-154 DoD in the browser application, through the Run tab alone: the
// fault-injection cases (missing binary, busy port, crash during warmup,
// bridge loss) show the reason and a working restart, Stop leaves no owned
// process behind, and the experiment record contains every version and
// parameter used. The launcher runs in-process in a temporary home whose
// catalog entry is the fake-firmware wrapper (tests/support/fake-firmware.ts);
// its mode file selects a fault, or "real", which execs the ArduCopter build
// of the TASK-152 installation with its copter.parm. The installation itself
// is only read: its catalog gives the build's paths, commit and SHA-256s.
const ROOT = process.cwd();
const INSTALL_HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "fake-arducopter";
const READY_TIMEOUT_MS = 180000;
/** The experiment states in which the launcher owns no process (launcher API v1). */
const FINAL_EXPERIMENT_STATES = ["stopped", "exited", "crashed", "start-failed"];
const sha256 = (source: string | Buffer): string => createHash("sha256").update(typeof source === "string" ? readFileSync(source) : source).digest("hex");

test.skip(!existsSync(join(INSTALL_HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
test.describe.configure({ mode: "serial" });

interface InstalledBuild { binaryPath: string; defaultParametersPath: string; defaultParametersSha256: string; commit: string; firmwareVersion: string }
function installedBuild(): InstalledBuild {
  const catalog: unknown = JSON.parse(readFileSync(join(INSTALL_HOME, "catalog.json"), "utf8"));
  const entry = field(catalog, "firmware", 0);
  const binaryPath = field(entry, "binaryPath"), defaultParametersPath = field(entry, "defaultParametersPath");
  const defaultParametersSha256 = field(entry, "defaultParametersSha256"), commit = field(entry, "commit"), firmwareVersion = field(entry, "firmwareVersion");
  if (typeof binaryPath !== "string" || typeof defaultParametersPath !== "string" || typeof defaultParametersSha256 !== "string" ||
    typeof commit !== "string" || typeof firmwareVersion !== "string") throw new Error("The TASK-152 catalog has no usable first entry");
  return { binaryPath, defaultParametersPath, defaultParametersSha256, commit, firmwareVersion };
}

let scratch = "";
let home = "";
let modeFile = "";
let fake: FakeFirmware | null = null;
let build: InstalledBuild | null = null;
let launcher: Awaited<ReturnType<typeof startLauncher>> | null = null;
let token = "";

/** (Re)writes the wrapper; its bytes, and so its catalog SHA-256, are the same every time. */
function writeWrapper(): FakeFirmware {
  if (!build) throw new Error("No installed build");
  return writeFakeFirmware(scratch, { modeFile, realBinary: build.binaryPath });
}
function wrapper(): FakeFirmware {
  if (!fake) throw new Error("No fake firmware");
  return fake;
}
function api(): { port: number } {
  if (!launcher) throw new Error("The launcher is not running");
  return launcher;
}
function installed(): InstalledBuild {
  if (!build) throw new Error("No installed build");
  return build;
}
const experiments = () => launcherExperiments(api().port, token, ORIGIN);

test.beforeAll(async () => {
  test.setTimeout(600000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  build = installedBuild();
  scratch = mkdtempSync(join(tmpdir(), "mirage-run-panel-"));
  home = join(scratch, "home");
  modeFile = join(scratch, "mode");
  mkdirSync(home, { mode: 0o700 });
  fake = writeWrapper();
  fake.setMode("real");
  writeCatalogEntry(home, {
    id: FIRMWARE_ID, firmwareVersion: build.firmwareVersion, commit: build.commit, binaryPath: fake.binary, binarySha256: sha256(fake.binary),
    defaultParametersPath: build.defaultParametersPath, defaultParametersSha256: build.defaultParametersSha256,
  });
  launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(INSTALL_HOME, "venv/bin/python"), admit: path => readFileSync(path) });
  token = readFileSync(join(home, "token"), "utf8").trim();
});
test.afterEach(async ({ page }) => {
  // A failed test must not leave a run that refuses the next start. The page
  // is left first, so that no Start still in flight creates a run afterwards.
  await page.goto("about:blank");
  if (launcher) {
    await stopEveryRun(launcher.port, token, ORIGIN);
    await expect.poll(async () => (await experiments()).filter(experiment => !FINAL_EXPERIMENT_STATES.includes(experiment.state)).length,
      { timeout: 30000 }).toBe(0);
    await expect.poll(() => processesNaming(home), { timeout: 10000 }).toEqual([]);
  }
  if (fake && !existsSync(fake.binary)) fake = writeWrapper();
  fake?.setMode("real");
});
test.afterAll(async () => {
  await launcher?.close();
  launcher = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

interface Panel { readonly panel: Locator; readonly stage: Locator; readonly failure: Locator }
/** The ArduPilot SITL panel with the launcher's port and token entered, the build listed and chosen, and speed up to 4×. */
async function openPanel(page: Page, port = api().port): Promise<Panel> {
  await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
  const panel = page.getByRole("region", { name: "ArduPilot SITL" });
  await expect(panel.getByLabel("Aircraft profile")).toContainText("Quad X SITL");
  await panel.getByLabel("Launcher port", { exact: true }).fill(String(port));
  await panel.getByLabel("Launcher token", { exact: true }).fill(token);
  await panel.getByRole("button", { name: "List ArduPilot builds" }).click();
  await expect(panel.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
  await panel.getByLabel("Speed").selectOption("4");
  return { panel, stage: panel.getByTestId("sitl-stage"), failure: panel.getByTestId("sitl-failure") };
}

interface StartPost { readonly body: unknown; readonly status: number; readonly experimentId: unknown }
/** Every POST /v1/experiments the page sends, with the launcher's status and experiment ID. */
function captureStarts(page: Page): StartPost[] {
  const posts: StartPost[] = [];
  page.on("response", response => {
    const request = response.request();
    if (request.method() !== "POST" || new URL(request.url()).pathname !== "/v1/experiments") return;
    const body: unknown = request.postDataJSON();
    void response.json().then((json: unknown) => posts.push({ body, status: response.status(), experimentId: field(json, "id") }),
      () => posts.push({ body, status: response.status(), experimentId: undefined }));
  });
  return posts;
}
/** SHA-256 of every BET module (/__bet/*.wasm) the page fetched. */
function captureBetModules(page: Page): string[] {
  const hashes: string[] = [];
  page.on("response", response => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/__bet/") || !path.endsWith(".wasm")) return;
    void response.body().then(bytes => hashes.push(sha256(bytes)), () => undefined);
  });
  return hashes;
}

/**
 * Records, in order, every value the stage's data-state takes from now on,
 * observed in the page itself (a MutationObserver), so a test shows which
 * state a fault interrupted without relying on the failure text.
 */
async function recordStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const earlier: unknown = Reflect.get(window, "__runStateObserver");
    if (earlier instanceof MutationObserver) earlier.disconnect();
    const seen: string[] = [];
    const note = (): void => {
      const state = document.querySelector('[data-testid="sitl-stage"]')?.getAttribute("data-state");
      if (state && seen.at(-1) !== state) seen.push(state);
    };
    const observer = new MutationObserver(note);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
    note();
    Reflect.set(window, "__runStates", seen);
    Reflect.set(window, "__runStateObserver", observer);
  });
}
async function statesSeen(page: Page): Promise<string[]> {
  const seen: unknown = await page.evaluate((): unknown => Reflect.get(window, "__runStates"));
  if (!Array.isArray(seen)) throw new Error("No run states recorded");
  const items: readonly unknown[] = seen;
  return items.map(item => {
    if (typeof item !== "string") throw new Error("A recorded run state is not a string");
    return item;
  });
}
/** The contract's start path as the page showed it: starting, loading parameters, warming, then ready. */
function expectStartPath(states: readonly string[]): void {
  const start = states.indexOf("starting");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(states.slice(start, start + 4)).toEqual(["starting", "loading-parameters", "warming", "ready"]);
}
/** The run failed out of warming: it never became ready, and warming was the state the failure interrupted. */
function expectFailedFromWarming(states: readonly string[]): void {
  const end = states.findIndex(state => state === "stopping" || state === "failed");
  expect(end).toBeGreaterThan(0);
  expect(states.slice(0, end)).not.toContain("ready");
  expect(states[end - 1]).toBe("warming");
  expect(states.at(-1)).toBe("failed");
}

/** No process of the run whose leader was `pid` remains: ps -g, the full process table and signal 0 all agree. */
function expectGone(pid: number): void {
  expect(psGroup(pid)).toBe("");
  expect(groupMembers(pid)).toEqual([]);
  expect(signalZeroCode(pid)).toBe("ESRCH");
}
/**
 * Every run of every launcher experiment so far has left nothing behind, and,
 * independently of what the launcher reports, no process names the launcher
 * home (every SITL run carries <home>/experiments/<id>/experiment.parm in --defaults).
 */
async function expectNoOwnedProcess(): Promise<void> {
  const list = await experiments();
  for (const experiment of list) for (const run of experiment.runs) expectGone(run.pid);
  expect(processesNaming(home)).toEqual([]);
}
async function expectReady(view: Panel): Promise<void> {
  await expect(view.stage).toHaveAttribute("data-state", "ready", { timeout: READY_TIMEOUT_MS });
  await expect(view.panel.getByTestId("sitl-ready")).toHaveText("READY");
}
/** Stop from the panel; the run passes through stopping, ends as a requested stop and leaves no process. */
async function stopRun(page: Page, view: Panel): Promise<void> {
  await recordStates(page);
  await view.panel.getByRole("button", { name: "Stop run" }).click();
  await expect(view.stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
  expect(await statesSeen(page)).toEqual(["ready", "stopping", "idle"]);
  const latest = (await experiments()).at(-1);
  expect(latest?.runs.at(-1)?.state).toBe("stopped");
  await expectNoOwnedProcess();
}
/** The run of the experiment the page is warming up, with its process group alive. */
async function warmingRun(view: Panel): Promise<{ experimentId: string; pid: number }> {
  await expect(view.stage).toHaveAttribute("data-state", "warming", { timeout: READY_TIMEOUT_MS });
  const running = (await experiments()).filter(experiment => experiment.state === "running");
  expect(running).toHaveLength(1);
  const experiment = running[0], run = experiment?.runs.at(-1);
  if (!experiment || !run) throw new Error("No running experiment");
  // A positive control for expectGone and the home scan: both see the live run.
  expect(psGroup(run.pid).split(/\s+/).map(Number)).toContain(run.pid);
  expect(groupMembers(run.pid)).toContain(run.pid);
  expect(processesNaming(home).map(entry => entry.pid)).toContain(run.pid);
  return { experimentId: experiment.id, pid: run.pid };
}
async function expectAccessible(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).include(".sitl-flight").analyze()).violations).toEqual([]);
}
/** The experiment records stored so far. */
async function recordCount(page: Page, seeded: SeededProject): Promise<number> {
  return (await readExperimentRecords(page, seeded)).experiments.length;
}

test("MirageSITL-owned sensor errors: the start is refused naming the terms, and nothing starts or is recorded", async ({ page }) => {
  test.setTimeout(120000);
  const seeded = await seedQuadProject(page, "Quad X SITL", { mirageOwnedSensorErrors: true });
  const before = (await experiments()).length;
  const view = await openPanel(page);
  await view.panel.getByRole("button", { name: "Start SITL run" }).click();
  await expect(view.stage).toHaveAttribute("data-state", "failed", { timeout: 30000 });
  await expect(view.failure).toHaveAttribute("data-reason", "vehicle");
  // User decision of 2026-11-01: refused at start, naming the terms.
  await expect(view.failure).toContainText("imu.accelBiasMps2");
  await expect(view.failure).toContainText("battery.voltageOffsetV");
  await expect(view.panel.getByTestId("sitl-fix")).toBeVisible();
  expect(await experiments()).toHaveLength(before);
  expect(await recordCount(page, seeded)).toBe(0);
  await expectNoOwnedProcess();
  await expectAccessible(page);
});

test("missing binary: the refusal names ENOENT, a start after restoring it reaches READY, and the record holds every version and parameter", async ({ page }) => {
  test.setTimeout(600000);
  const posts = captureStarts(page);
  const betModules = captureBetModules(page);
  const seeded = await seedQuadProject(page, "Quad X SITL");
  const view = await openPanel(page);
  const binary = wrapper().binary;

  // Deleted after the build was listed: the page's start-time catalog check finds the executable gone.
  unlinkSync(binary);
  await view.panel.getByRole("button", { name: "Start SITL run" }).click();
  await expect(view.stage).toHaveAttribute("data-state", "failed", { timeout: 30000 });
  await expect(view.failure).toHaveAttribute("data-reason", "firmware");
  await expect(view.failure).toContainText(FIRMWARE_ID);
  await expect(view.failure).toContainText("ENOENT");
  await expect(view.panel.getByTestId("sitl-fix")).toBeVisible();
  await expectAccessible(page);
  expect(await experiments()).toEqual([]);
  expect(await recordCount(page, seeded)).toBe(0);

  // Deleted between that check and the launcher's own admission: the launcher refuses the POST.
  fake = writeWrapper();
  const startUrl = `http://127.0.0.1:${api().port}/v1/experiments`;
  await page.route(startUrl, async route => {
    if (route.request().method() === "POST" && existsSync(binary)) unlinkSync(binary);
    await route.continue();
  });
  await view.panel.getByRole("button", { name: "Start again" }).click();
  await expect(view.failure).toHaveAttribute("data-reason", "launcher-refused", { timeout: 30000 });
  await expect(view.stage).toHaveAttribute("data-state", "failed");
  await expect(view.failure).toContainText(/not admitted: ENOENT/);
  await page.unroute(startUrl);
  await expect.poll(() => posts.map(post => post.status)).toEqual([409]);
  // A refused start creates no launcher experiment, no folder and no record.
  expect(await experiments()).toEqual([]);
  expect(existsSync(join(home, "experiments")) ? readdirSync(join(home, "experiments")) : []).toEqual([]);
  expect(await recordCount(page, seeded)).toBe(0);
  await expectNoOwnedProcess();
  await expectAccessible(page);

  fake = writeWrapper();
  await recordStates(page);
  await view.panel.getByRole("button", { name: "Start again" }).click();
  await expectReady(view);
  expectStartPath(await statesSeen(page));
  await expect.poll(() => posts.length).toBe(2);
  const started = posts.filter(post => post.status === 201);
  expect(started).toHaveLength(1);
  const post = started[0];
  if (!post || typeof post.experimentId !== "string") throw new Error("No successful start");
  const experimentId = post.experimentId, body = post.body, ardupilot = installed();

  // What ArduPilot was actually given: the live process's own arguments.
  const live = (await experiments()).find(experiment => experiment.id === experimentId)?.runs.at(-1);
  if (!live) throw new Error("The started experiment has no run");
  const words = commandWords(live.pid);
  expect(words[0]).toBe(ardupilot.binaryPath);
  const workDirectory = join(home, "experiments", experimentId);
  expect(argumentOf(words, "--defaults")).toBe(`${ardupilot.defaultParametersPath},${join(workDirectory, "experiment.parm")}`);

  const readback = await readExperimentRecords(page, seeded);
  expect(readback.experiments).toHaveLength(1);
  const record = readback.experiments[0];
  if (!record) throw new Error("No experiment record");
  await expect(view.panel.getByTestId("sitl-record")).toHaveText(record.sha256);
  // The record's only dependency is the exact profile version, named in full.
  expect(record.dependencies).toEqual([{ kind: "aircraft-profile", sha256: seeded.profileSha256 }]);
  expect(record.profile).toEqual(readback.profile);
  expect(record.profile.version).toBe(1);
  expect(record.sensorsEqualSnapshot).toBe(true);
  expect(record.launcherExperimentId).toBe(experimentId);

  // The session settings: those the page POSTed, and those SITL runs with.
  expect(field(body, "firmwareId")).toBe(FIRMWARE_ID);
  expect(field(body, "speedup")).toBe(4);
  expect(record.session.speedup).toBe(4);
  expect(record.session.clockMode).toBe("sitl-lockstep");
  expect(record.session.physicsHz).toBe(field(body, "rateHz"));
  expect(record.session.home).toEqual(field(body, "home"));
  expect(argumentOf(words, "--speedup")).toBe("4");
  expect(Number(argumentOf(words, "--rate"))).toBe(record.session.physicsHz);
  expect(argumentOf(words, "--home")).toBe(record.session.home.join(","));
  expect(record.frameScript).toBe(field(body, "frameScript"));
  const scriptPath = join(workDirectory, "scripts", "frame.lua");
  if (record.frameScript === null) expect(existsSync(scriptPath)).toBe(false);
  else expect(readFileSync(scriptPath, "utf8")).toBe(record.frameScript);
  // The model: the manifest Node derives from the stored profile and cards with the record's model ID, and the BET module served.
  expect(record.session.manifestSha256).toBe(await nodeManifestSha256(readback, record.session.modelId));
  expect(record.session.betModuleSha256).toBe(sha256(join(ROOT, "packages/wasm-bet/dist/mirage_bet.scalar.wasm")));
  await expect.poll(() => betModules).toContain(record.session.betModuleSha256);

  // The initial parameters: those the page POSTed and those the launcher wrote for SITL, in that order, each with its source.
  const named = record.parameters.map(parameter => ({ name: parameter.name, value: parameter.value }));
  expect(named.length).toBeGreaterThan(0);
  expect(named).toEqual(field(body, "parameters"));
  expect(named).toEqual(parameterFile(join(workDirectory, "experiment.parm")));
  for (const parameter of record.parameters) expect(["frame", "output", "pwm", "sensor"]).toContain(parameter.source);

  // The build identity is the launcher catalog entry's, hashed here independently.
  expect(record.ardupilot).toEqual({
    catalogId: FIRMWARE_ID, firmwareVersion: ardupilot.firmwareVersion, commit: ardupilot.commit, binarySha256: sha256(binary),
    defaultParametersSha256: sha256(ardupilot.defaultParametersPath),
  });
  expect(record.ardupilot?.defaultParametersSha256).toBe(ardupilot.defaultParametersSha256);

  await stopRun(page, view);
});

test("busy port: SITL that cannot bind and a foreign program on the launcher port show the reason, then a start reaches READY", async ({ page }) => {
  test.setTimeout(600000);
  const servers: (HttpServer | TcpServer)[] = [];
  const listen = async <T extends HttpServer | TcpServer>(server: T): Promise<number> => {
    servers.push(server);
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    return address.port;
  };
  try {
    const seeded = await seedQuadProject(page, "Quad X SITL");
    const before = (await experiments()).length;
    const view = await openPanel(page);
    const port = view.panel.getByLabel("Launcher port", { exact: true });

    // A plain web server on the launcher port. Chromium reports its CORS
    // failure as a network error, exactly like a refused connection, so the
    // page cannot tell this program from a missing launcher: it reports no
    // launcher there, and must also send the user to the port.
    let plainRequests = 0;
    const plain = await listen(createHttpServer((request, response) => {
      plainRequests++;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Not a launcher</title>");
      request.resume();
    }));
    await port.fill(String(plain));
    await view.panel.getByRole("button", { name: "Start SITL run" }).click();
    await expect(view.stage).toHaveAttribute("data-state", "failed", { timeout: 30000 });
    await expect(view.failure).toHaveAttribute("data-reason", "launcher-unreachable");
    await expect(view.failure).toContainText(`127.0.0.1:${plain}`);
    await expect(view.failure).toContainText(/check the port/i);
    await expect(view.panel.getByTestId("sitl-fix")).toBeVisible();
    expect(plainRequests).toBeGreaterThan(0);
    await expectAccessible(page);

    // A synthetic stand-in that lets the page read it (CORS) but answers HTML: not the launcher.
    const readable = await listen(createHttpServer((request, response) => {
      const cors = { "access-control-allow-origin": ORIGIN, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST" };
      response.writeHead(request.method === "OPTIONS" ? 204 : 200, { ...cors, "content-type": "text/html" });
      response.end(request.method === "OPTIONS" ? undefined : "<!doctype html><title>Not a launcher</title>");
      request.resume();
    }));
    await port.fill(String(readable));
    await view.panel.getByRole("button", { name: "Start again" }).click();
    await expect(view.failure).toHaveAttribute("data-reason", "launcher-foreign", { timeout: 30000 });
    await expect(view.failure).toContainText(String(readable));
    // Neither reached the launcher, so it has no new experiment, and no record exists.
    expect(await experiments()).toHaveLength(before);
    expect(await recordCount(page, seeded)).toBe(0);

    // SITL cannot bind a port another program holds. By the user's decision
    // this is injected with the fake SITL (tests/support/fake-sitl.mjs), which
    // tries to listen on the held port, prints the line of ArduPilot's SITL
    // UARTDriver ("bind failed on port %u - %s", UARTDriver.cpp:422 of the
    // pinned source) and exits with code 1. With the launcher's arguments
    // (JSON model, --serial0 udpclient, --serial1 and --serial2 none) real
    // ArduCopter binds no TCP port, so this shows that the stderr line and the
    // exit code reach the panel, not that real SITL hits it with them.
    const holder = createTcpServer();
    const held = await listen(holder);
    wrapper().setMode(`bind-busy ${held}`);
    await port.fill(String(api().port));
    await view.panel.getByRole("button", { name: "Start again" }).click();
    await expect(view.failure).toHaveAttribute("data-reason", "sitl-ended", { timeout: 60000 });
    await expect(view.stage).toHaveAttribute("data-state", "failed");
    await expect(view.failure).toContainText(`port ${held}`);
    await expect(view.failure).toContainText("exit code 1");
    const diagnostics = view.panel.getByTestId("sitl-diagnostics");
    await diagnostics.locator("summary").click();
    await expect(diagnostics).toContainText(`bind failed on port ${held} - Address already in use`);
    const ended = (await experiments()).at(-1)?.runs.at(-1);
    expect(ended?.state).toBe("crashed");
    expect(ended?.reason).toContain(`bind failed on port ${held}`);
    await expectNoOwnedProcess();
    await expectAccessible(page);

    await new Promise<void>(done => holder.close(() => done()));
    wrapper().setMode("real");
    await view.panel.getByRole("button", { name: "Start again" }).click();
    await expectReady(view);
    await stopRun(page, view);
  } finally {
    for (const server of servers) if (server.listening) server.close();
  }
});

test("crash during warmup: SIGKILL of the run shows SITL's end and its signal, and a new experiment reaches READY", async ({ page }) => {
  test.setTimeout(600000);
  const seeded = await seedQuadProject(page, "Quad X SITL");
  const before = (await experiments()).length;
  const view = await openPanel(page);
  await recordStates(page);
  await view.panel.getByRole("button", { name: "Start SITL run" }).click();
  const killed = await warmingRun(view);
  await expect(view.stage).toHaveAttribute("data-state", "warming", { timeout: 100 });
  process.kill(killed.pid, "SIGKILL");

  await expect(view.stage).toHaveAttribute("data-state", "failed", { timeout: 60000 });
  await expect(view.failure).toHaveAttribute("data-reason", "sitl-ended");
  await expect(view.failure).toContainText("SIGKILL");
  // The fault interrupted warming (the page never showed ready), and the reason names that phase.
  expectFailedFromWarming(await statesSeen(page));
  await expect(view.failure).toContainText(/warmup/i);
  await expect(view.panel.getByTestId("sitl-diagnostics")).toContainText(killed.experimentId);
  expectGone(killed.pid);
  await expectNoOwnedProcess();
  const ended = (await experiments()).find(experiment => experiment.id === killed.experimentId)?.runs.at(-1);
  expect(ended).toMatchObject({ state: "crashed", signal: "SIGKILL" });
  await expectAccessible(page);

  await view.panel.getByRole("button", { name: "Start again" }).click();
  await expectReady(view);
  // The restart is a new launcher experiment with a new record.
  const list = (await experiments()).slice(before);
  expect(list).toHaveLength(2);
  const restarted = list.find(experiment => experiment.id !== killed.experimentId);
  const readback = await readExperimentRecords(page, seeded);
  expect(readback.experiments.map(record => record.launcherExperimentId).sort()).toEqual([killed.experimentId, restarted?.id].sort());
  const current = readback.experiments.find(record => record.launcherExperimentId === restarted?.id);
  await expect(view.panel.getByTestId("sitl-record")).toHaveText(current?.sha256 ?? "missing");
  await stopRun(page, view);
});

test("bridge loss: closing only the bridge stops SITL, shows the loss, and a new experiment reaches READY", async ({ page }) => {
  test.setTimeout(600000);
  const seeded = await seedQuadProject(page, "Quad X SITL");
  const before = (await experiments()).length;
  const view = await openPanel(page);
  await recordStates(page);
  await view.panel.getByRole("button", { name: "Start SITL run" }).click();
  const lost = await warmingRun(view);
  if (!launcher) throw new Error("The launcher is not running");
  await expect(view.stage).toHaveAttribute("data-state", "warming", { timeout: 100 });
  expect(await launcher.closeBridge(lost.experimentId)).toBe(true);

  await expect(view.stage).toHaveAttribute("data-state", "failed", { timeout: 60000 });
  await expect(view.failure).toHaveAttribute("data-reason", "bridge-lost");
  // The fault interrupted warming: the page never showed ready.
  expectFailedFromWarming(await statesSeen(page));
  // SITL kept running after the bridge closed; MirageSITL stopped it before showing the failure.
  expectGone(lost.pid);
  await expectNoOwnedProcess();
  const ended = (await experiments()).find(experiment => experiment.id === lost.experimentId)?.runs.at(-1);
  expect(ended?.state).toBe("stopped");
  await expectAccessible(page);

  await view.panel.getByRole("button", { name: "Start again" }).click();
  await expectReady(view);
  const list = (await experiments()).slice(before);
  expect(list).toHaveLength(2);
  expect(list[0]?.id).toBe(lost.experimentId);
  // The restart is a new launcher experiment with a new record.
  const readback = await readExperimentRecords(page, seeded);
  expect(readback.experiments.map(record => record.launcherExperimentId).sort()).toEqual(list.map(experiment => experiment.id).sort());
  const current = readback.experiments.find(record => record.launcherExperimentId === list[1]?.id);
  await expect(view.panel.getByTestId("sitl-record")).toHaveText(current?.sha256 ?? "missing");
  await stopRun(page, view);
});
