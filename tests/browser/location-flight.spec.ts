import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { effectiveConditions } from "../../packages/sensors/src/environment";
import { WorldMagneticModel, parseWmmCoefficients } from "../../packages/sensors/src/geomagnetic";
import { loadEgm96Geoid } from "../../packages/sensors/src/geoid";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-148 (S07) on the reference Mac: a run of native ArduCopter fb773567 at a location other than ArduPilot's
// default test site, chosen through the Weather and location tab alone, with a measured QNH and a temperature
// offset. Declared before the first run:
//  - the Run tab's start check finds ArduPilot's first 3D fix within 10 m and 5 m of the location (READY waits for it);
//  - the record's home is the location, its conditions equal effectiveConditions evaluated here in Node at the
//    record's decimal year (1e-9 relative), COMPASS_DEC is siteParameters(home) and SIM_BARO_RND scales with the
//    location's elevation (sqrt(3)·σ·|dh/dp| at 250 m, 1e-6 relative);
//  - at rest on its legs before arming, the recorded specific force is the location's normal gravity within 0.005 m/s²
//    and the recorded air pressure is the origin air at the CG's height within 50 Pa, 2.9 kPa below the sea-level ISA;
//  - ArduPilot's own GPS altitude stays within 5 m of the location's elevation while the aircraft stands, and the
//    aircraft takes off to 5 m and lands there.
// Needs the TASK-152 installation; it skips everywhere else.

type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Store = typeof import("../../packages/project/src/store");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
type SiteParameters = typeof import("../../packages/aircraft/src/site-parameters");
type SensorParameters = typeof import("../../packages/aircraft/src/sensor-parameters");
const urls = {
  site: viteFileUrl(new URL("../../packages/aircraft/src/site-parameters.ts", import.meta.url)),
  sensorParameters: viteFileUrl(new URL("../../packages/aircraft/src/sensor-parameters.ts", import.meta.url)),
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
const LOCATION = { site: null, latitudeDeg: 31.5, longitudeDeg: 34.9, groundElevationMslM: 250, headingDeg: 90, measuredQnhPa: 102000, temperatureOffsetK: 5 };
const BARO_NOISE_PA = 2;
const EVIDENCE = join(ROOT, "test-results/browser/task-148-location-flight.json");

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

interface Readback {
  readonly sha256: string;
  readonly payload: unknown;
  readonly rows: Record<string, { simTimeS: number; values: number[] }[]>;
  /** What the application's own modules give at the record's home: COMPASS_DEC and the barometer's |dh/dp| at its elevation. */
  readonly compassDec: number;
  readonly altitudePerPascal: number;
}
/** The project's only experiment record and the rows of the signals this test reads. */
async function readback(page: Page, projectId: string): Promise<Readback> {
  return page.evaluate(async ({ urls, projectId }) => {
    const { listRecordings, reopenRecording } = await import(urls.host) as Host;
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const { siteParameters } = await import(urls.site) as SiteParameters;
    const { barometerAltitudePerPascal } = await import(urls.sensorParameters) as SensorParameters;
    const store = await ProjectStore.openIndexedDb();
    try {
      const [stored] = await store.listItems(projectId, "experiment");
      if (!stored) throw new Error("No experiment record");
      const payload = readExperiment(stored), recordId = payload.recording?.recordId ?? "";
      // The recording closes after the stop; wait for it as the TASK-158 acceptance does.
      for (let i = 0; i < 100; i++) {
        const listed = (await listRecordings()).find(entry => entry.recordId === recordId);
        if (listed?.status === "closed") break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const opened = await reopenRecording(recordId);
      const rows: Record<string, { simTimeS: number; values: number[] }[]> = {};
      for (const signal of ["truth.specificForce", "truth.air", "truth.position", "autopilot.gps"]) {
        rows[signal] = (opened.rows.get(signal) ?? []).map(row => ({ simTimeS: row.simTimeS, values: Array.from(row.values ?? []) }));
      }
      const [declination] = siteParameters(payload.session.home);
      return { sha256: stored.sha256, payload: JSON.parse(JSON.stringify(payload)) as unknown, rows, compassDec: declination?.value ?? Number.NaN,
        altitudePerPascal: Math.abs(barometerAltitudePerPascal(payload.session.home[2])) };
    } finally {
      store.close();
    }
  }, { urls, projectId });
}
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

test("a run at a typed location starts ArduPilot there, and its gravity, air, parameters and record agree with the location", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const models = {
    geoid: await loadEgm96Geoid(new Uint8Array(readFileSync("data/geoid/WW15MGH.DAC"))),
    magnetic: new WorldMagneticModel(parseWmmCoefficients(readFileSync("data/geomagnetic/WMM_2025.COF", "utf8"))),
  };
  const home = mkdtempSync(join(tmpdir(), "mirage-location-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const seeded = await seedQuadProject(page, "Quad X located", { barometerNoisePa: BARO_NOISE_PA });
    // The location, through the Weather and location tab alone.
    await page.getByRole("tab", { name: "Weather and location", exact: true }).click();
    const form = page.getByRole("tabpanel", { name: "Weather and location", exact: true }).getByTestId("location-picker");
    await form.getByLabel("Site", { exact: true }).selectOption("coordinates");
    await form.getByLabel("Latitude (°)", { exact: true }).fill(String(LOCATION.latitudeDeg));
    await form.getByLabel("Longitude (°)", { exact: true }).fill(String(LOCATION.longitudeDeg));
    await form.getByLabel("Ground elevation above mean sea level (m)", { exact: true }).fill(String(LOCATION.groundElevationMslM));
    await form.getByLabel("Heading (°)", { exact: true }).fill(String(LOCATION.headingDeg));
    await form.getByLabel("Sea-level pressure", { exact: true }).selectOption("measured");
    await form.getByLabel("Measured QNH (hPa)", { exact: true }).fill(String(LOCATION.measuredQnhPa / 100));
    await form.getByLabel("Temperature offset from ISA (K)", { exact: true }).fill(String(LOCATION.temperatureOffsetK));
    await form.getByRole("button", { name: "Save location", exact: true }).click();
    await expect(form.getByTestId("location-status")).toHaveText(/^Saved\./);

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await expect(run.getByTestId("sitl-location")).toHaveText("Location: 31.5°, 34.9°, 250 m above mean sea level, heading 90°, QNH 1020.00 hPa, ISA +5 K (Weather and location tab).");
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
    await run.getByRole("button", { name: "Start SITL run" }).click();
    // READY waits for the start's home check.
    await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300000 });
    expect(await page.evaluate(() => location.href)).not.toContain(token);
    await run.getByLabel("Take-off altitude, m").fill("5");
    await run.getByRole("button", { name: "Take off" }).click();
    await expect.poll(async () => Number.parseFloat((await run.getByTestId("sitl-altitude").textContent()) ?? "NaN"), { timeout: 120000 }).toBeGreaterThan(4.5);
    await run.getByRole("button", { name: "Land" }).click();
    await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 180000 });
    await run.getByRole("button", { name: "Stop run" }).click();
    await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30000 });

    const read = await readback(page, seeded.projectId);
    const payload = read.payload as {
      session: { home: number[] }; parameters: { name: string; value: number; source: string }[];
      environment: { location: typeof LOCATION; conditions: ReturnType<typeof effectiveConditions> } | null;
    };
    expect(payload.session.home).toEqual([31.5, 34.9, 250, 90]);
    expect(payload.environment?.location).toEqual(LOCATION);
    const recorded = payload.environment?.conditions;
    if (!recorded) throw new Error("The record has no conditions");
    const expected = effectiveConditions({ ...LOCATION, decimalYear: recorded.magnetic.decimalYear }, models);
    const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(b)));
    close(recorded.gravityMps2, expected.gravityMps2); close(recorded.ellipsoidalHeightM, expected.ellipsoidalHeightM);
    close(recorded.air.pressurePa, expected.air.pressurePa); close(recorded.air.temperatureK, expected.air.temperatureK);
    close(recorded.magnetic.northNt, expected.magnetic.northNt); close(recorded.magnetic.downNt, expected.magnetic.downNt);
    // What follows from the location: COMPASS_DEC and the barometer noise at its elevation.
    const parameter = (name: string) => payload.parameters.find(entry => entry.name === name)?.value ?? Number.NaN;
    expect(parameter("COMPASS_DEC")).toBe(read.compassDec);
    // |dh/dp| of the ISA at 250 m, about 0.0853 m/Pa (2.4 % more than the 0.0832 m/Pa at sea level): the noise in metres follows the elevation.
    expect(read.altitudePerPascal).toBeGreaterThan(0.0850); expect(read.altitudePerPascal).toBeLessThan(0.0856);
    const rnd = Math.sqrt(3) * BARO_NOISE_PA * read.altitudePerPascal;
    expect(Math.abs(parameter("SIM_BARO_RND") - rnd) / rnd).toBeLessThan(1e-6);

    // At rest before arming (the first 20 s after the gear settles): the location's gravity and air in the physics.
    const resting = (signal: string) => (read.rows[signal] ?? []).filter(row => row.simTimeS > 5 && row.simTimeS < 20);
    const force = resting("truth.specificForce").map(row => row.values[2] ?? Number.NaN);
    const pressure = resting("truth.air").map(row => row.values[1] ?? Number.NaN);
    const height = -mean(resting("truth.position").map(row => row.values[2] ?? Number.NaN));
    expect(force.length).toBeGreaterThan(100);
    expect(Math.abs(mean(force) + recorded.gravityMps2)).toBeLessThan(0.005);
    const lapse = 0.0065, exponent = 9.80665 / (287.05287 * lapse), t0 = recorded.air.temperatureK;
    const originAirAtCg = recorded.air.pressurePa * Math.pow((t0 - lapse * height) / t0, exponent);
    expect(Math.abs(mean(pressure) - originAirAtCg)).toBeLessThan(50);
    expect(101325 * Math.pow(1 - lapse * height / 288.15, exponent) - mean(pressure)).toBeGreaterThan(2000);
    // ArduPilot's own GPS altitude while it stands.
    // Before its first 3D fix (fix type 3) ArduPilot reports an altitude of 0, which says nothing of the location.
    const gpsAltitude = resting("autopilot.gps").filter(row => (row.values[3] ?? 0) >= 3).map(row => row.values[2] ?? Number.NaN);
    expect(gpsAltitude.length).toBeGreaterThan(0);
    for (const altitude of gpsAltitude) expect(Math.abs(altitude - 250)).toBeLessThan(5);

    mkdirSync(join(ROOT, "test-results/browser"), { recursive: true });
    writeFileSync(EVIDENCE, `${JSON.stringify({ task: "TASK-148", record: read.sha256, home: payload.session.home, gravityMps2: recorded.gravityMps2,
      restingSpecificForceZ: mean(force), restingPressurePa: mean(pressure), originAirAtCgPa: originAirAtCg, gpsAltitudeM: { min: Math.min(...gpsAltitude), max: Math.max(...gpsAltitude) },
      compassDec: parameter("COMPASS_DEC"), simBaroRnd: parameter("SIM_BARO_RND") }, null, 2)}\n`);
    console.log(`EVID ${readFileSync(EVIDENCE, "utf8")}`);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
