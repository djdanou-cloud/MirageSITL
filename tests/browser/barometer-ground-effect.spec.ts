import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { readDataFlash, type DataFlashLog } from "../../packages/dataflash/src/reader";
import { seedQuadProject } from "../support/run-tab";

// TASK-116: ArduPilot's ground-effect handling exercised by the barometer ground cushion, through the application alone.
// The quad X flies twice with native ArduCopter V4.7.2 (the TASK-152 installation): GND_EFFECT_COMP 1, its default, and 0,
// each written on the Parameters tab after READY. Both runs get the same cushion from the Faults tab before take-off (gain
// 1.5, decay height 2 rotor radii), which MirageSITL streams into SIM_BAROn_GLITCH. Each run's own DataFlash log is the
// evidence: SIM is the simulator's truth, BARO the barometer's altitude, XKF1 the EKF's position. Limits declared before the
// first run: in both runs the barometer reads at least 0.5 m low while the vehicle is within 1 m of the ground (the cushion
// reached ArduPilot), and with GND_EFFECT_COMP 1 the EKF's worst height error there is smaller than with 0.
const HOME = join(process.cwd(), ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
const PROFILE = "Quad X cushion";

/** The column `name` of group `group`, as numbers, rows of instance `instance` when it has one. */
function series(log: DataFlashLog, group: string, name: string, instance?: { readonly column: string; readonly value: number }): { timeS: number[]; value: number[] } {
  const g = log.groups.find(item => item.name === group);
  if (!g) throw new Error(`The log has no ${group}`);
  const column = (key: string) => {
    const c = g.columns.find(item => item.name === key);
    if (!c) throw new Error(`${group} has no ${key}`);
    return c;
  };
  const time = column("TimeUS"), value = column(name), pick = instance ? column(instance.column) : null;
  const out = { timeS: [] as number[], value: [] as number[] };
  for (let row = 0; row < g.count; row++) {
    if (pick && Number(pick.values[row]) !== instance?.value) continue;
    out.timeS.push(Number(time.values[row]) / 1e6);
    out.value.push(Number(value.values[row]) * value.valueScale);
  }
  return out;
}
/** The value of a series at time t, from its nearest earlier sample. */
function at(s: { timeS: number[]; value: number[] }, t: number): number {
  let lo = 0, hi = s.timeS.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((s.timeS[mid] ?? Infinity) <= t) lo = mid; else hi = mid - 1; }
  return s.value[lo] ?? Number.NaN;
}
interface NearGround { readonly barometerLowM: number; readonly ekfErrorM: number; readonly samples: number }
/**
 * While armed and within 1 m of the ground by the truth: the barometer's lowest reading below the truth, and the EKF's
 * largest height error, each against what it read at rest in the first half second after arming.
 */
function nearGround(log: DataFlashLog): NearGround {
  const truth = series(log, "SIM", "Alt"), baro = series(log, "BARO", "Alt", { column: "I", value: 0 }), ekf = series(log, "XKF1", "PD", { column: "C", value: 0 });
  // ArduPilot logs from arming (LOG_DISARMED 0): the log's first truth record is the moment it armed, still on the ground.
  const arm = series(log, "ARM", "ArmState"), armedAt = truth.timeS[0];
  let disarmedAt: number | undefined;
  for (let i = 0; i < arm.timeS.length; i++) if (arm.value[i] === 0) disarmedAt = arm.timeS[i];
  if (armedAt === undefined || disarmedAt === undefined || disarmedAt <= armedAt) throw new Error("The log has no arming and disarming");
  const ground = at(truth, armedAt);
  // What each reads at rest: the first half second, before the motors spin up.
  const rest = baro.timeS.flatMap((t, i) => (t >= armedAt && t < armedAt + 0.5 ? [{ b: baro.value[i]! - (at(truth, t) - ground), e: -at(ekf, t) - (at(truth, t) - ground) }] : []));
  if (rest.length === 0) throw new Error("No barometer samples at rest");
  const baroRest = rest.reduce((sum, r) => sum + r.b, 0) / rest.length, ekfRest = rest.reduce((sum, r) => sum + r.e, 0) / rest.length;
  let barometerLowM = 0, ekfErrorM = 0, samples = 0;
  baro.timeS.forEach((t, i) => {
    const height = at(truth, t) - ground;
    if (t < armedAt || t > disarmedAt || height > 1) return;
    samples++;
    barometerLowM = Math.min(barometerLowM, baro.value[i]! - baroRest - height);
    ekfErrorM = Math.max(ekfErrorM, Math.abs(-at(ekf, t) - ekfRest - height));
  });
  return { barometerLowM, ekfErrorM, samples };
}

/** One run: READY, GND_EFFECT_COMP written, the cushion on, take-off to 3 m, a 5 s hold, land, stop. */
async function fly(page: Page, launcherPort: number, token: string, compensation: 0 | 1, first: boolean): Promise<void> {
  await page.getByRole("tab", { name: "Run", exact: true }).click();
  const run = page.getByRole("region", { name: "ArduPilot SITL" });
  if (first) {
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcherPort));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
  } else {
    await run.getByRole("button", { name: "Start SITL run" }).click();
  }
  const stage = run.getByTestId("sitl-stage");
  await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 180000 });

  await page.getByRole("tab", { name: "Parameters", exact: true }).click();
  await page.getByLabel("Search parameters", { exact: true }).fill("GND_EFFECT_COMP");
  await page.getByRole("button", { name: "GND_EFFECT_COMP", exact: true }).click();
  await page.getByLabel("New value of GND_EFFECT_COMP", { exact: true }).fill(String(compensation));
  await page.getByRole("button", { name: "Write", exact: true }).click();

  await page.getByRole("tab", { name: "Faults and interference", exact: true }).click();
  await page.getByLabel("Effect", { exact: true }).selectOption({ label: "Barometer ground cushion" });
  await page.getByLabel("Gain k", { exact: true }).fill("1.5");
  await page.getByLabel("Decay height λ", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Apply now", exact: true }).click();
  await expect(page.getByTestId("fault-ledger")).toContainText("Barometer ground cushion", { timeout: 10000 });

  await page.getByRole("tab", { name: "Run", exact: true }).click();
  await run.getByLabel("Take-off altitude, m").fill("3");
  await run.getByRole("button", { name: "Take off" }).click();
  await expect(stage).toHaveText("Flying", { timeout: 120000 });
  const simTime = async () => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN");
  const start = await simTime();
  while ((await simTime()) - start < 5) await page.waitForTimeout(200);
  await run.getByRole("button", { name: "Land" }).click();
  await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 120000 });
  await expect(stage).toHaveAttribute("data-state", "ready", { timeout: 60000 });
  await run.getByRole("button", { name: "Stop run" }).click();
  await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 30000 });
}

test("the barometer ground cushion reaches ArduPilot, and its ground-effect compensation holds the EKF closer to the truth", async ({ page }, info) => {
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  test.setTimeout(900000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-cushion-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await seedQuadProject(page, PROFILE);
    await fly(page, launcher.port, token, 1, true);
    await fly(page, launcher.port, token, 0, false);
    // Each run's own log, oldest first: the run with compensation, then the one without.
    const logs = readdirSync(join(home, "experiments")).flatMap(id => {
      const directory = join(home, "experiments", id, "logs");
      return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".BIN")).map(name => join(directory, name)) : [];
    }).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    expect(logs).toHaveLength(2);
    const [withCompensation, without] = logs.map(path => nearGround(readDataFlash(new Uint8Array(readFileSync(path)))));
    if (!withCompensation || !without) throw new Error("Two logs expected");
    await info.attach("near-ground.json", { body: JSON.stringify({ withCompensation, without }, null, 2), contentType: "application/json" });
    process.stdout.write(`TASK-116 near the ground: ${JSON.stringify({ withCompensation, without })}\n`);
    for (const result of [withCompensation, without]) {
      expect(result.samples).toBeGreaterThan(20);
      expect(result.barometerLowM).toBeLessThanOrEqual(-0.5);
    }
    expect(withCompensation.ekfErrorM).toBeLessThan(without.ekfErrorM);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
