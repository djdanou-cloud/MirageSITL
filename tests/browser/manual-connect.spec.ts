import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { startLauncher } from "../../apps/launcher/src/server";
import { field, generatedParameters, readExperimentRecords, seedQuadProject, signalZeroCode, type SeededProject } from "../support/run-tab";

// TASK-155 DoD in the browser application, through the Run tab alone, with the
// real ArduCopter build of the TASK-152 installation started here as a user
// starts it: `--model JSON`, its own TCP SERIAL0, the session's home, and the
// profile's generated parameters in its own --defaults file. Connect and
// disconnect cycles reach READY and leave that process running; a SITL with
// built-in physics and one whose parameters differ are refused with reasons
// (and the built-in one's clock cannot be paused), and they keep running too.
// The launcher runs in-process in a temporary home and owns no process here.
const ROOT = process.cwd();
const INSTALL_HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const READY_TIMEOUT_MS = 180000;
/** The session's home (apps/web/src/sitl/sitl-run.ts DEFAULT_HOME), which a connected SITL must share. */
const HOME = "-35.363261,149.16523,584,0";

test.skip(!existsSync(join(INSTALL_HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
test.describe.configure({ mode: "serial" });

interface InstalledBuild { binaryPath: string; defaultParametersPath: string }
function installedBuild(): InstalledBuild {
  const catalog: unknown = JSON.parse(readFileSync(join(INSTALL_HOME, "catalog.json"), "utf8"));
  const entry = field(catalog, "firmware", 0);
  const binaryPath = field(entry, "binaryPath"), defaultParametersPath = field(entry, "defaultParametersPath");
  if (typeof binaryPath !== "string" || typeof defaultParametersPath !== "string") throw new Error("The TASK-152 catalog has no usable first entry");
  return { binaryPath, defaultParametersPath };
}

let scratch = "";
let launcher: Awaited<ReturnType<typeof startLauncher>> | null = null;
let token = "";
const users: ChildProcess[] = [];

test.beforeAll(async () => {
  test.setTimeout(600000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  scratch = mkdtempSync(join(tmpdir(), "mirage-manual-connect-"));
  const home = join(scratch, "home");
  launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(INSTALL_HOME, "venv/bin/python"), admit: path => readFileSync(path) });
  token = readFileSync(join(home, "token"), "utf8").trim();
});
test.afterEach(async ({ page }) => {
  await page.goto("about:blank");
  for (const child of users.splice(0)) {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise(done => child.once("exit", done));
  }
});
test.afterAll(async () => {
  await launcher?.close();
  launcher = null;
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

interface UserSitl { readonly pid: number; readonly tcpPort: number; readonly jsonPort: number; output(): string }
/**
 * Starts the installed ArduCopter as a user would, as SITL instance `instance`
 * (TCP SERIAL0 5760 + 10·instance, JSON physics to 9002 + 10·instance), and
 * waits for it to wait for its SERIAL0 connection.
 */
async function startUserSitl(instance: number, model: string, parameters: readonly { name: string; value: number }[] | null): Promise<UserSitl> {
  const build = installedBuild();
  const cwd = mkdtempSync(join(scratch, "user-sitl-"));
  const defaults = [build.defaultParametersPath];
  if (parameters) {
    const file = join(cwd, "profile.parm");
    writeFileSync(file, parameters.map(parameter => `${parameter.name} ${parameter.value}\n`).join(""));
    defaults.push(file);
  }
  const child = spawn(build.binaryPath, ["--model", model, "-I", String(instance), "--speedup", "4", "--home", HOME,
    "--defaults", defaults.join(",")], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  users.push(child);
  let output = "";
  child.stdout?.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr?.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  await expect.poll(() => output.includes("Waiting for connection"), { timeout: 30000, message: "SITL waiting for its SERIAL0 connection" }).toBe(true);
  const pid = child.pid;
  if (pid === undefined) throw new Error("SITL did not start");
  return { pid, tcpPort: 5760 + 10 * instance, jsonPort: 9002 + 10 * instance, output: () => output };
}

interface Panel { readonly panel: Locator; readonly stage: Locator; readonly failure: Locator }
async function openPanel(page: Page): Promise<Panel> {
  if (!launcher) throw new Error("The launcher is not running");
  await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
  const panel = page.getByRole("region", { name: "ArduPilot SITL" });
  await expect(panel.getByLabel("Aircraft profile")).toContainText("Quad X SITL");
  await panel.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
  await panel.getByLabel("Launcher token", { exact: true }).fill(token);
  return { panel, stage: panel.getByTestId("sitl-stage"), failure: panel.getByTestId("sitl-failure") };
}
async function connect(panel: Locator, sitl: UserSitl, again = false): Promise<void> {
  await panel.getByLabel("JSON physics port (UDP)").fill(String(sitl.jsonPort));
  await panel.getByLabel("MAVLink", { exact: true }).selectOption("tcp");
  await panel.getByLabel("MAVLink port").fill(String(sitl.tcpPort));
  await panel.getByRole("button", { name: again ? "Connect again" : "Connect to running SITL" }).click();
}
async function connectionStates(): Promise<string[]> {
  if (!launcher) throw new Error("The launcher is not running");
  const response = await fetch(`http://127.0.0.1:${launcher.port}/v1/status`, { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } });
  const list = field(await response.json(), "connections");
  const items: readonly unknown[] = Array.isArray(list) ? list : [];
  return items.map(item => String(field(item, "state")));
}

test("connect and disconnect cycles reach READY, record schema 2 and leave the SITL the user started running", async ({ page }) => {
  test.setTimeout(600000);
  const seeded: SeededProject = await seedQuadProject(page, "Quad X SITL");
  const parameters = await generatedParameters(page, seeded);
  expect(parameters.some(p => p.source === "output")).toBe(true);
  const sitl = await startUserSitl(31, "JSON:127.0.0.1", parameters);
  const { panel, stage } = await openPanel(page);
  for (let cycle = 1; cycle <= 2; cycle++) {
    await connect(panel, sitl, false);
    await expect(stage, `cycle ${cycle}`).toHaveAttribute("data-state", "ready", { timeout: READY_TIMEOUT_MS });
    await expect(stage).toHaveAttribute("data-ownership", "external");
    const checks = panel.getByTestId("sitl-compatibility").getByRole("listitem");
    await expect(checks).toHaveCount(6);
    await expect(checks.nth(0)).toHaveText(new RegExp(`^JSON physics on UDP port ${sitl.jsonPort} with 16 servo channels; MirageSITL steps it at 800 Hz, which SITL adopts`));
    await expect(checks.nth(1)).toContainText("so Pause stops it with the physics (TASK-156)");
    await expect(checks.nth(3)).toHaveText("ArduPilot 4.8.0-dev, commit 8ab6afde (verified)");
    await expect(checks.nth(4)).toHaveText(`All ${parameters.length} frame, output, PWM and sensor parameters match the profile`);
    await expect(panel.getByRole("button", { name: "Start SITL run" })).toBeDisabled();
    await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
    await expect(stage).toContainText("the SITL keeps running");
    // The process MirageSITL never owned is still there, a few seconds later too.
    await page.waitForTimeout(2000);
    expect(signalZeroCode(sitl.pid), sitl.output().slice(-2000)).toBeNull();
    expect(await connectionStates()).toEqual(Array.from({ length: cycle }, () => "disconnected"));
  }
  // One schema 2 record per connection, each external, with the reported version and nothing MirageSITL did not know.
  const readback = await readExperimentRecords(page, seeded);
  expect(readback.experiments).toHaveLength(2);
  for (const record of readback.experiments) {
    expect(record.ownership).toBe("external");
    expect(record.ardupilot).toBeNull();
    expect(record.external).toMatchObject({ ardupilot: { commit: "8ab6afde107a91df1b5f60ade8f333cb8a61b190", gitHash: "8ab6afde", firmwareVersion: "4.8.0-dev" },
      endpoints: { jsonPhysicsPort: sitl.jsonPort, mavlink: { transport: "tcp", port: sitl.tcpPort } } });
    expect(record.session).toMatchObject({ physicsHz: 800, speedup: null, home: [-35.363261, 149.16523, 584, 0] });
    expect(record.parameters).toEqual(parameters);
    expect(record.frameScript).toBeNull();
    expect(record.sensorsEqualSnapshot).toBe(true);
  }
  expect(readback.experiments[0]?.external?.connectionId).not.toBe(readback.experiments[1]?.external?.connectionId);
});

test("refuses a SITL with built-in physics, explains that its clock cannot be paused, and leaves it running", async ({ page }) => {
  test.setTimeout(300000);
  await seedQuadProject(page, "Quad X SITL");
  const sitl = await startUserSitl(32, "quad", null);
  const { panel, stage, failure } = await openPanel(page);
  await connect(panel, sitl);
  await expect(stage).toHaveAttribute("data-state", "failed", { timeout: 60000 });
  await expect(failure).toHaveAttribute("data-reason", "incompatible");
  const reasons = panel.getByTestId("sitl-incompatible");
  await expect(reasons).toContainText("it runs a built-in physics model, which cannot fly this profile and whose clock MirageSITL cannot pause");
  await expect(reasons).toContainText(`start it with --model JSON and --sim-port-out ${sitl.jsonPort}`);
  await expect(panel.getByTestId("sitl-fix")).toHaveText("Restart your SITL as the reasons say, or choose another profile, then press Connect again");
  await panel.getByTestId("sitl-diagnostics").locator("summary").click();
  await expect(panel.getByTestId("sitl-diagnostics")).toContainText("received 0 JSON servo packets");
  await expect(panel.getByRole("button", { name: "Connect again" })).toBeEnabled();
  expect(signalZeroCode(sitl.pid), sitl.output().slice(-2000)).toBeNull();
  expect(await connectionStates()).toContain("disconnected");
});

test("refuses a SITL whose parameters differ from the profile, naming them, and writes nothing to it", async ({ page }) => {
  test.setTimeout(300000);
  const seeded = await seedQuadProject(page, "Quad X SITL");
  const parameters = await generatedParameters(page, seeded);
  // The stock copter.parm alone: its FRAME_TYPE 0 (plus) instead of the profile's 1 (X).
  const sitl = await startUserSitl(33, "JSON:127.0.0.1", null);
  const { panel, stage, failure } = await openPanel(page);
  await connect(panel, sitl);
  await expect(stage).toHaveAttribute("data-state", "failed", { timeout: READY_TIMEOUT_MS });
  await expect(failure).toHaveAttribute("data-reason", "incompatible");
  const reasons = panel.getByTestId("sitl-incompatible");
  await expect(reasons).toContainText("the SITL's parameters differ from what this profile needs (MirageSITL writes nothing to a SITL it did not start)");
  await expect(reasons).toContainText("FRAME_TYPE is 0 (needs 1)");
  expect((await readExperimentRecords(page, seeded)).experiments).toEqual([]);
  expect(signalZeroCode(sitl.pid), sitl.output().slice(-2000)).toBeNull();
  // Connected again with the profile's parameters given at start, the same Connect reaches READY.
  const fitting = await startUserSitl(34, "JSON:127.0.0.1", parameters);
  await connect(panel, fitting, true);
  await expect(stage).toHaveAttribute("data-state", "ready", { timeout: READY_TIMEOUT_MS });
  await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
  expect(signalZeroCode(fitting.pid)).toBeNull();
});
