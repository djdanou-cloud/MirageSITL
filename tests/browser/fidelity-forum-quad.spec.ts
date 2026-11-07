import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { readDataFlash } from "../../packages/dataflash/src/reader";
import { viteFileUrl } from "../support/vite-url";

// TASK-184 (S15) with a real flight log (G4), on the reference Mac. The forum aircraft of topic 144558 (data/flight-logs/inventory.json):
// a 7.2 kg quad X on T-Motor MN7005 KV230 motors with P24*7.2 CF propellers, built from its cards and its assumed geometry
// (tests/fixtures/aircraft/tmotor-mn7005-quad.json), calibrated in the Components tab on T-Motor's datasheet (laboratory supply, TASK-145)
// and flown with native ArduCopter from the Run tab the way the real flight began: an automatic take-off to 100 m, which the real
// aircraft climbed at about 2.5 m/s. The Analysis tab's fidelity report then compares the run with the real log 00000205 from 5 s before
// the motors started to 45 s after, the two logs lined up at their motor starts. Declared:
//  - the real log is the inventory's file (SHA-256) and the report calls it a real flight;
//  - every quantity has its row over the interval, compared or missing with its reason, and nothing in it judges;
//  - the saved comparison belongs to the calibrated profile version, which becomes flight-checked in the regimes compared.
// MIRAGE_FORUM_LOG_DIR is the directory of the inventory's logs; MIRAGE_FIDELITY_OUT=path writes the comparison for the record.
type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Measurements = typeof import("../../packages/aircraft/src/measurements");
type Calculation = typeof import("../../packages/aircraft/src/calculation-mode");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  measurements: viteFileUrl(new URL("../../packages/aircraft/src/measurements.ts", import.meta.url)),
  calculation: viteFileUrl(new URL("../../packages/aircraft/src/calculation-mode.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
const LOG_FILE = "topic-144558-00000205.BIN";
const LOG_DIR = process.env.MIRAGE_FORUM_LOG_DIR ?? "";
const REAL = join(LOG_DIR, LOG_FILE);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

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

async function seedForumQuad(page: Page): Promise<string> {
  await page.goto("/");
  const texts = {
    motor: read("../fixtures/components/tmotor-mn7005-kv230.json"), propeller: read("../fixtures/components/tmotor-p24x72.json"),
    esc: read("../fixtures/components/tmotor-alpha-40a.json"), battery: read("../fixtures/components/battery-6s-42ah-forum-144558.json"),
    profile: read("../fixtures/aircraft/tmotor-mn7005-quad.json"), bench: read("../fixtures/components/tmotor-mn7005-kv230-p24x72.csv"),
  };
  const projectId = await page.evaluate(async ({ urls, texts }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDraft, validateAircraftProfile, withPropellerPolars } = await import(urls.profile) as Profiles;
    const { measurementSetDraft, measurementSetFromBenchCsv } = await import(urls.measurements) as Measurements;
    const { bindMeasurements } = await import(urls.calculation) as Calculation;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Forum quad fidelity");
      const add = async (name: string, text: string) => (await store.createItem(project.record.id, "component-card", { name, payload: JSON.parse(text) as unknown })).sha256;
      const motor = await add("MN7005 KV230", texts.motor), propeller = await add("P24x7.2 CF", texts.propeller);
      const esc = await add("Alpha 40A", texts.esc), battery = await add("2 x 6S 21 Ah", texts.battery);
      const set = await measurementSetFromBenchCsv(texts.bench, {
        combination: { motor, propeller, esc, supply: { kind: "laboratory" } }, fileName: "tmotor-mn7005-kv230-p24x72.csv", date: "2026-07-28",
        description: "T-Motor datasheet table (manufacturer data)", applicability: "Manufacturer data: stand and air not stated." });
      const stored = await store.createItem(project.record.id, "measurement-set", measurementSetDraft("T-Motor datasheet", set));
      const fixture = validateAircraftProfile(JSON.parse(texts.profile));
      const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: battery },
        motors: fixture.motors.map(item => ({ ...item, components: { motor, propeller, esc } })) }), [{ card: propeller, polar: "naca6409-neuralfoil-v1" }]);
      const measured = await bindMeasurements(profile, "measured", [{ sha256: stored.sha256, createdAt: stored.record.createdAt, set }]);
      await store.createItem(project.record.id, "aircraft-profile", profileDraft("Forum quad", measured));
      await saveNavigation(store, { tab: "components", projectId: project.record.id });
      return project.record.id;
    } finally {
      store.close();
    }
  }, { urls, texts });
  await page.reload();
  return projectId;
}

test("the forum quad, calibrated on T-Motor's datasheet, climbs to 100 m in SITL and is compared with its real flight log", async ({ page }) => {
  test.setTimeout(1_800_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const inventory = JSON.parse(readFileSync(join(ROOT, "data/flight-logs/inventory.json"), "utf8")) as { logs: { file: string; sha256: string }[] };
  const realBytes = readFileSync(REAL);
  expect(createHash("sha256").update(realBytes).digest("hex")).toBe(inventory.logs.find(item => item.file === LOG_FILE)?.sha256);
  const home = mkdtempSync(join(tmpdir(), "mirage-forum-fidelity-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const projectId = await seedForumQuad(page);
    // Calibrate on the datasheet and bind it as version 2.
    const components = page.getByRole("tabpanel", { name: "Components", exact: true });
    const one = components.getByRole("list", { name: "Motors of Forum quad" }).getByTestId("calibration-1");
    await one.getByRole("button", { name: "Fit to the bench data" }).click();
    const fitted = one.getByTestId("calibration-result-1");
    await expect(fitted).toBeVisible({ timeout: 120_000 });
    await fitted.getByRole("button", { name: "Save and bind as a new profile version" }).click();
    await expect(components.getByTestId("calculation-status")).toContainText("Saved the calibration and version 2 of Forum quad");

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Aircraft profile", { exact: true }).selectOption({ label: "Forum quad (version 2)" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
    await run.getByLabel("Take-off altitude, m").fill("100");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect.poll(async () => Number.parseFloat((await run.getByTestId("sitl-altitude").textContent()) ?? "NaN"), { timeout: 300_000, intervals: [1000] }).toBeGreaterThan(99);
    await page.waitForTimeout(5_000);
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
    await report.getByLabel("Real log from, s", { exact: true }).fill((realStartS - 5).toFixed(2));
    await report.getByLabel("Real log to, s", { exact: true }).fill((realStartS + 45).toFixed(2));
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
    await expect(report.getByTestId("fidelity-status")).toContainText("Saved as a comparison of Forum quad, version 2");
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
    expect(stored?.profile.version).toBe(2);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
