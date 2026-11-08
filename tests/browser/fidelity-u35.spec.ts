import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { readDataFlash } from "../../packages/dataflash/src/reader";
import { viteFileUrl } from "../support/vite-url";

// TASK-184 (S15) with the stakeholder's own aircraft, on the reference Mac. The U35 (data/flight-logs/inventory.json,
// stakeholder-4s-quad): a 0.68 kg quad X on a MatekH743 with 2650 KV motors and HQProp Duct-T90MMX3 propellers, rotors 102 mm
// apart front to back and 144 mm left to right, motor directions reversed (X_REV), built from its cards and
// tests/fixtures/aircraft/u35-quad.json (inertia, motor values, ESC and blade count assumed; the ducts not modelled) in a
// preliminary calculation, flown with native ArduCopter from the Run tab to a 1.2 m hover as the real flight 00000167 hovered
// (indoors, AltHold, about 1.1 to 1.5 m by its rangefinder), and compared through the Analysis tab's fidelity report from 2 s
// before the motors started to 50 s after, the logs lined up at their motor starts. Before take-off the run takes the real
// aircraft's own attitude tuning from its log (rate and angle gains, filters, acceleration limits, thrust expo, gyro filter),
// written on the Parameters tab: the first run with ArduPilot's default gains oscillated at 2.7 Hz. Declared:
//  - the real log is the inventory's file (SHA-256) and the report calls it a real flight;
//  - every quantity has its row over the interval, compared or missing with its reason, and nothing in it judges;
//  - the saved comparison belongs to the profile version, which becomes flight-checked in the regimes compared.
// MIRAGE_FORUM_LOG_DIR is the directory of the inventory's logs; MIRAGE_FIDELITY_OUT=path writes the comparison for the record.
type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
const LOG_FILE = "stakeholder-00000167.BIN";
const LOG_DIR = process.env.MIRAGE_FORUM_LOG_DIR ?? "";
const REAL = join(LOG_DIR, LOG_FILE);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
/** The U35's own tuning, read from stakeholder-00000167.BIN's PARM records (ArduCopter V4.6.2), under the pinned V4.7.2's names. */
const REAL_TUNING: readonly (readonly [string, number])[] = [
  ["ATC_RAT_RLL_P", 0.06897857040166855], ["ATC_RAT_RLL_I", 0.06897857040166855], ["ATC_RAT_RLL_D", 0.00202558864839375],
  ["ATC_RAT_RLL_FLTT", 50.5], ["ATC_RAT_RLL_FLTD", 50.5],
  ["ATC_RAT_PIT_P", 0.1220342144370079], ["ATC_RAT_PIT_I", 0.1220342144370079], ["ATC_RAT_PIT_D", 0.0029014309402555227],
  ["ATC_RAT_PIT_FLTT", 50.5], ["ATC_RAT_PIT_FLTD", 50.5],
  ["ATC_RAT_YAW_P", 1.4503039121627808], ["ATC_RAT_YAW_I", 0.14503039419651031], ["ATC_RAT_YAW_D", 0.03498496115207672],
  ["ATC_RAT_YAW_FLTE", 1.2604987621307373], ["ATC_RAT_YAW_FLTD", 0],
  ["ATC_ANG_RLL_P", 36], ["ATC_ANG_PIT_P", 23.078365325927734], ["ATC_ANG_YAW_P", 36],
  // V4.6's ATC_ACCEL_*_MAX in cdeg/s² are V4.7's ATC_ACC_*_MAX in deg/s².
  ["ATC_ACC_R_MAX", 1459.075625], ["ATC_ACC_P_MAX", 975.154375], ["ATC_ACC_Y_MAX", 1866.4153125],
  ["MOT_THST_EXPO", 0.38999998569488525], ["INS_GYRO_FILTER", 101],
];

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
test.skip(LOG_DIR === "" || !existsSync(REAL), "Needs MIRAGE_FORUM_LOG_DIR with the inventory's logs");

/** The first time CTUN.ThO rises above 0.05, s on the log's TimeUS clock. */
function motorStartS(bytes: Uint8Array): number {
  const log = readDataFlash(bytes), ctun = log.groups.find(group => group.name === "CTUN" && group.count > 0);
  const time = ctun?.columns.find(c => c.name === "TimeUS"), throttle = ctun?.columns.find(c => c.name === "ThO");
  if (!ctun || !time || !throttle) throw new Error("The log has no CTUN.ThO");
  for (let row = 1; row < ctun.count; row++) {
    if (Number(throttle.values[row - 1]) <= 0.05 && Number(throttle.values[row]) > 0.05) return Number(time.values[row]) * 1e-6;
  }
  throw new Error("The log has no motor start");
}
/** The newest DataFlash file the launcher's experiments wrote under `home`. */
function newestDataflash(home: string): string {
  const found: { path: string; mtime: number }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.bin$/i.test(entry.name)) found.push({ path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(join(home, "experiments"));
  const newest = found.sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) throw new Error("The run wrote no DataFlash log");
  return newest.path;
}

async function seedU35(page: Page): Promise<string> {
  await page.goto("/");
  const texts = {
    motor: read("../fixtures/components/u35-motor-2650kv.json"), propeller: read("../fixtures/components/u35-hq-dt90mmx3.json"),
    esc: read("../fixtures/components/u35-esc.json"), battery: read("../fixtures/components/u35-battery-4s-4800.json"),
    profile: read("../fixtures/aircraft/u35-quad.json"),
  };
  const projectId = await page.evaluate(async ({ urls, texts }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDraft, validateAircraftProfile, withPropellerPolars } = await import(urls.profile) as Profiles;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("U35 fidelity");
      const add = async (name: string, text: string) => (await store.createItem(project.record.id, "component-card", { name, payload: JSON.parse(text) as unknown })).sha256;
      const motor = await add("2650 KV motor", texts.motor), propeller = await add("HQ DT90MMX3", texts.propeller);
      const esc = await add("U35 ESC", texts.esc), battery = await add("4S 4800 mAh", texts.battery);
      const fixture = validateAircraftProfile(JSON.parse(texts.profile));
      const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: battery },
        motors: fixture.motors.map(item => ({ ...item, components: { motor, propeller, esc } })) }), [{ card: propeller, polar: "naca6409-neuralfoil-v1" }]);
      await store.createItem(project.record.id, "aircraft-profile", profileDraft("U35", profile));
      await saveNavigation(store, { tab: "run", projectId: project.record.id });
      return project.record.id;
    } finally {
      store.close();
    }
  }, { urls, texts });
  await page.reload();
  return projectId;
}

test("the U35 hovers at 1.2 m in SITL and is compared with its own real flight log 00000167", async ({ page }) => {
  test.setTimeout(1_800_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const inventory = JSON.parse(readFileSync(join(ROOT, "data/flight-logs/inventory.json"), "utf8")) as { logs: { file: string; sha256: string }[] };
  const realBytes = readFileSync(REAL);
  expect(createHash("sha256").update(realBytes).digest("hex")).toBe(inventory.logs.find(item => item.file === LOG_FILE)?.sha256);
  const home = mkdtempSync(join(tmpdir(), "mirage-u35-fidelity-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const projectId = await seedU35(page);
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Aircraft profile", { exact: true }).selectOption({ label: "U35 (version 1)" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await page.getByRole("tab", { name: "Parameters", exact: true }).click();
    for (const [name, value] of REAL_TUNING) {
      await page.getByLabel("Search parameters", { exact: true }).fill(name);
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByLabel(`New value of ${name}`, { exact: true }).fill(String(value));
      await page.getByRole("button", { name: "Write", exact: true }).click();
      const cell = page.locator(`tr[data-name="${name}"] [data-testid="parameter-value"]`);
      await expect.poll(async () => Math.abs(Number.parseFloat((await cell.textContent()) ?? "NaN") - value) <= 1e-4 * Math.max(1, Math.abs(value)), { timeout: 30_000 }).toBe(true);
    }
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await run.getByLabel("Take-off altitude, m").fill("1.2");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect.poll(async () => Number.parseFloat((await run.getByTestId("sitl-altitude").textContent()) ?? "NaN"), { timeout: 300_000, intervals: [500] }).toBeGreaterThan(1);
    // 15 s at speed 4: about 60 s of simulated hover, more than the compared interval.
    await page.waitForTimeout(15_000);
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 600_000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });
    const simulatedStartS = motorStartS(new Uint8Array(readFileSync(newestDataflash(home))));
    const realStartS = motorStartS(new Uint8Array(realBytes.buffer, realBytes.byteOffset, realBytes.byteLength));

    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    const report = page.getByRole("tabpanel", { name: "Analysis", exact: true }).getByTestId("fidelity-report");
    await report.getByLabel("Simulated run (experiment)", { exact: true }).selectOption({ index: 1 });
    await expect(report.getByTestId("fidelity-simulated-note")).toContainText(/ArduPilot's own log of this run|MirageSITL's truth from the stored recording/, { timeout: 60_000 });
    await report.getByLabel("Real flight log (.bin)", { exact: true }).setInputFiles(REAL);
    await expect(report.getByLabel("Real log to, s", { exact: true })).not.toHaveValue("", { timeout: 120_000 });
    await report.getByLabel("Real log from, s", { exact: true }).fill((realStartS - 2).toFixed(2));
    await report.getByLabel("Real log to, s", { exact: true }).fill((realStartS + 50).toFixed(2));
    await report.getByLabel("Simulated time minus real time, s", { exact: true }).fill((simulatedStartS - realStartS).toFixed(2));
    await report.getByRole("button", { name: "Compare", exact: true }).click();
    const result = report.getByTestId("fidelity-result");
    await expect(result).toBeVisible({ timeout: 120_000 });
    await expect(report.getByTestId("fidelity-origin")).toContainText("a real flight");
    for (const quantity of ["roll", "pitch", "yaw", "rollRate", "pitchRate", "yawRate", "altitude", "verticalSpeed", "batteryVoltage", "batteryCurrent", "motorOutput"]) {
      const row = result.locator(`tr[data-quantity="${quantity}"][data-regime="all"]`);
      await expect(row).toHaveCount(1);
      if ((await row.getAttribute("data-status")) === "missing") await expect(row).toContainText("Missing: ");
    }
    const text = (await result.textContent()) ?? "";
    expect(text).not.toMatch(/\b(pass|fail|verdict|limit)\b/i);
    const out = process.env.MIRAGE_FIDELITY_OUT;
    if (out) {
      const rows = await result.locator("tr[data-quantity]").evaluateAll(items => items.map(item => ({
        quantity: item.getAttribute("data-quantity"), regime: item.getAttribute("data-regime"), status: item.getAttribute("data-status"),
        cells: [...item.querySelectorAll("td, th")].map(cell => cell.textContent?.trim() ?? ""),
      })));
      writeFileSync(out, `${JSON.stringify({ realStartS, simulatedStartS, rows, text }, null, 2)}\n`);
    }
    await report.getByRole("button", { name: "Save comparison", exact: true }).click();
    await expect(report.getByTestId("fidelity-status")).toContainText("Saved as a comparison of U35, version 1");
    await expect(report.getByTestId("fidelity-label")).toContainText("flight-checked in");
    const stored = await page.evaluate(async ({ urls, projectId }) => {
      const { ProjectStore } = await import(urls.store) as Store;
      const store = await ProjectStore.openIndexedDb();
      try {
        const [item] = await store.listItems(projectId, "fidelity-comparison");
        return item ? JSON.parse(JSON.stringify(item.record.payload)) as { real: { sha256: string; origin: string }; profile: { version: number } } : null;
      } finally { store.close(); }
    }, { urls, projectId });
    expect(stored?.real).toMatchObject({ origin: "real", sha256: inventory.logs.find(item => item.file === LOG_FILE)?.sha256 });
    expect(stored?.profile.version).toBe(1);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
