import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { readDataFlash, type DataFlashColumn, type DataFlashLog } from "../../packages/dataflash/src/reader";
import { gnssSolution } from "../../packages/sensors/src/gnss";
import { GNSS_SKY, GNSS_SKY_EPOCH } from "../../packages/sensors/src/gnss-sky";
import { jammerReceivedPowerDbW } from "../../packages/ew/src/gnss-emitter";
import { seedQuadProject } from "../support/run-tab";

// TASK-117: the GNSS stream on native ArduCopter V4.7.2 (the TASK-152 installation), through the application alone
// (SPECS_SIMULATION_ENGINES "Receiver timing, tracking noise, multipath and jammers", declared 2026-11-09 before the first run).
// A quad X at ArduPilot's Canberra test home flies a stored route north and back at 10 m and 5 m/s with, from the Faults tab after
// READY: the satellite geometry (mask 10°, σ 1.5 m), receiver timing, code noise and multipath at their defaults, and a jammer
// 400 m north and 2 m up at −48.8 dBW. Each run's own DataFlash log is the evidence: GPS and GPA are what ArduPilot's receiver
// reported, PARM the parameter writes it took, SIM the simulator's truth, MODE and ARM what the autopilot did.
//  - Run 1, to 250 m north: GPS.NSats takes at least three values, each one the stream wrote, the smallest at least 10 below the
//    largest; GPA.HAcc follows the accuracy written (each within 0.01 m) and its largest is at least 1.3 times its smallest; at
//    least 100 SIM_GPS1_GLTCH_X writes, and the GPS position less the truth 0.1 s (SIM_GPS1_LAG_MS) earlier within 0.5 m of the
//    offset in force for 95 % of the samples while armed; the fix holds and the aircraft lands within 5 m of the pad, disarmed,
//    with no accident.
//  - Run 2, to 330 m north: GPS.Status falls below 3 within 30 m of the north distance where the model loses the fix on the route,
//    ArduCopter's own failsafe brings the aircraft down, and it disarms with no accident.
const HOME = join(process.cwd(), ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
// The tracked evidence is rewritten only on request (MIRAGE_GNSS_FLIGHT_EVIDENCE=1); an ordinary browser run writes its copy under
// test-results/browser/, which holds no tracked files, so the suite leaves tracked evidence unchanged.
const EVIDENCE = join(process.cwd(), process.env.MIRAGE_GNSS_FLIGHT_EVIDENCE === "1" ? "test-results/validation" : "test-results/browser", "task-117-gnss-flight.json");
const LOG_COPIES = join(process.cwd(), "test-results/browser/task-117-gnss-logs");
const HOME_LAT_DEG = -35.363261, HOME_LON_DEG = 149.16523, HOME_ALT_M = 584;
const JAMMER = { positionNedM: [400, 0, -2] as const, eirpDbW: -48.8 };
const WGS84_A = 6378137, WGS84_E2 = 6.69437999014e-3, DEG = Math.PI / 180;
const S2 = Math.sin(HOME_LAT_DEG * DEG) ** 2;
const MERIDIONAL_M = (WGS84_A * (1 - WGS84_E2)) / (1 - WGS84_E2 * S2) ** 1.5, NORMAL_M = WGS84_A / Math.sqrt(1 - WGS84_E2 * S2);

interface Series { readonly timeS: number[]; readonly value: number[] }
function group(log: DataFlashLog, name: string) {
  const g = log.groups.find(item => item.name === name);
  if (!g) throw new Error(`The log has no ${name}`);
  const column = (key: string): DataFlashColumn => {
    const c = g.columns.find(item => item.name === key);
    if (!c) throw new Error(`${name} has no ${key}`);
    return c;
  };
  return { g, column };
}
/** Column `name` of `groupName` as numbers in its unit, rows of instance 0 where the group has an instance column. */
function series(log: DataFlashLog, groupName: string, name: string): Series {
  const { g, column } = group(log, groupName);
  const time = column("TimeUS"), value = column(name), instance = g.columns.find(item => item.name === "I");
  const out: Series = { timeS: [], value: [] };
  for (let row = 0; row < g.count; row++) {
    if (instance && Number(instance.values[row]) !== 0) continue;
    out.timeS.push(Number(time.values[row]) / 1e6);
    out.value.push(Number(value.values[row]) * value.valueScale);
  }
  return out;
}
/** The text of row `row` of a text column. */
function text(column: DataFlashColumn, row: number): string {
  const bytes: number[] = [];
  for (let i = 0; i < column.width; i++) {
    const b = Number(column.values[row * column.width + i]);
    if (b === 0) break;
    bytes.push(b);
  }
  return String.fromCharCode(...bytes);
}
/** Every PARM write of `name`: time and value. */
function parameterWrites(log: DataFlashLog, name: string): Series {
  const { g, column } = group(log, "PARM");
  const time = column("TimeUS"), names = column("Name"), value = column("Value");
  const out: Series = { timeS: [], value: [] };
  for (let row = 0; row < g.count; row++) {
    if (text(names, row) !== name) continue;
    out.timeS.push(Number(time.values[row]) / 1e6);
    out.value.push(Number(value.values[row]) * value.valueScale);
  }
  return out;
}
/** The latest value at or before t, NaN before the first. */
function inForce(s: Series, t: number): number {
  let lo = -1, hi = s.timeS.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((s.timeS[mid] ?? Infinity) <= t) lo = mid; else hi = mid - 1; }
  return lo < 0 ? Number.NaN : s.value[lo] ?? Number.NaN;
}
/** Linear interpolation of a series at t. */
function interpolate(s: Series, t: number): number {
  let lo = 0, hi = s.timeS.length - 1;
  if (hi < 0 || t < (s.timeS[0] ?? Infinity) || t > (s.timeS[hi] ?? -Infinity)) return Number.NaN;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((s.timeS[mid] ?? Infinity) <= t) lo = mid; else hi = mid; }
  const t0 = s.timeS[lo] ?? 0, t1 = s.timeS[hi] ?? 0, v0 = s.value[lo] ?? 0, v1 = s.value[hi] ?? 0;
  return t1 === t0 ? v0 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}
/**
 * The armed interval: from the first arming to the last disarming after it. ArduPilot logs from arming (LOG_DISARMED 0), so a log
 * may hold no ARM record of the arming itself; its first SIM record is then that moment.
 */
function armedInterval(log: DataFlashLog): readonly [number, number] {
  const arm = series(log, "ARM", "ArmState");
  const armedAt = arm.timeS.find((_, i) => arm.value[i] === 1) ?? series(log, "SIM", "Lat").timeS[0];
  let disarmedAt: number | undefined;
  for (let i = 0; i < arm.timeS.length; i++) if (arm.value[i] === 0 && armedAt !== undefined && (arm.timeS[i] ?? 0) > armedAt) disarmedAt = arm.timeS[i];
  if (armedAt === undefined || disarmedAt === undefined) throw new Error("The log has no arming and disarming");
  return [armedAt, disarmedAt];
}
/** Where the model loses the fix along the route, m north of the pad, at simulated time t (0.5 m steps, 10 m up). */
function modelFixLossNorthM(simTimeS: number): number | null {
  const gpsS = GNSS_SKY_EPOCH.secondsOfWeek + simTimeS;
  for (let north = 0; north <= 400; north += 0.5) {
    const receivedPowerDbW = jammerReceivedPowerDbW(JAMMER, north, 0, -10);
    const s = gnssSolution(GNSS_SKY, { latRad: HOME_LAT_DEG * DEG + north / MERIDIONAL_M, lonRad: HOME_LON_DEG * DEG, heightM: HOME_ALT_M + 10, eastM: 0, northM: north },
      GNSS_SKY_EPOCH.week + Math.floor(gpsS / 604800), gpsS % 604800,
      { constellation: { maskRad: 10 * DEG, uereM: 1.5 }, atmosphere: null, terrain: null, jamming: null, jammer: { receivedPowerDbW, spectralSeparation: 1.5, thresholdDbHz: 28 } });
    if (!s.fix) return north;
  }
  return null;
}
interface Analysis {
  readonly satellites: number[]; readonly satellitesWritten: number[]; readonly unwrittenSatellites: number[];
  readonly haccMinM: number; readonly haccMaxM: number; readonly haccOffBy: number; readonly haccSamples: number;
  readonly offsetWrites: number; readonly offsetSamples: number; readonly offsetWithinShare: number; readonly offsetP95M: number;
  readonly fixLostAtS: number | null; readonly fixLostNorthM: number | null; readonly modelLossNorthM: number | null;
  readonly farthestNorthM: number; readonly landedFromPadM: number; readonly modesAfterLoss: number[]; readonly armedS: readonly [number, number];
}
function analyse(log: DataFlashLog): Analysis {
  const armedS = armedInterval(log), [armedAt, disarmedAt] = armedS, armed = (t: number) => t >= armedAt && t <= disarmedAt;
  const status = series(log, "GPS", "Status"), sats = series(log, "GPS", "NSats"), lat = series(log, "GPS", "Lat"), lng = series(log, "GPS", "Lng");
  const hacc = series(log, "GPA", "HAcc"), simLat = series(log, "SIM", "Lat"), simLng = series(log, "SIM", "Lng");
  const numsats = parameterWrites(log, "SIM_GPS1_NUMSATS"), acc = parameterWrites(log, "SIM_GPS1_ACC");
  const glitchX = parameterWrites(log, "SIM_GPS1_GLTCH_X"), glitchY = parameterWrites(log, "SIM_GPS1_GLTCH_Y");
  const satellites = [...new Set(sats.value.filter((_, i) => armed(sats.timeS[i] ?? 0)))].sort((a, b) => a - b);
  const written = new Set(numsats.value);
  let haccMinM = Infinity, haccMaxM = 0, haccOffBy = 0, haccSamples = 0;
  hacc.timeS.forEach((t, i) => {
    if (!armed(t)) return;
    const value = hacc.value[i] ?? NaN;
    haccMinM = Math.min(haccMinM, value); haccMaxM = Math.max(haccMaxM, value); haccSamples++;
    haccOffBy = Math.max(haccOffBy, Math.min(...acc.value.map(w => Math.abs(w - value))));
  });
  // The GPS position less the truth one lag earlier, against the offset in force, while armed and once the stream writes offsets.
  const misses: number[] = [];
  const firstOffsetS = glitchX.timeS[0] ?? Infinity;
  lat.timeS.forEach((t, i) => {
    if (!armed(t) || t < firstOffsetS + 0.5 || (status.value[i] ?? 0) < 3) return;
    const truthLat = interpolate(simLat, t - 0.1), truthLng = interpolate(simLng, t - 0.1);
    const x = inForce(glitchX, t), y = inForce(glitchY, t);
    if (![truthLat, truthLng, x, y].every(Number.isFinite)) return;
    const north = ((lat.value[i] ?? NaN) - truthLat - x) * DEG * MERIDIONAL_M, east = ((lng.value[i] ?? NaN) - truthLng - y) * DEG * NORMAL_M * Math.cos(HOME_LAT_DEG * DEG);
    misses.push(Math.hypot(north, east));
  });
  misses.sort((a, b) => a - b);
  const lostIndex = status.timeS.findIndex((t, i) => armed(t) && (status.value[i] ?? 3) < 3);
  const fixLostAtS = lostIndex >= 0 ? status.timeS[lostIndex] ?? null : null;
  const northOf = (t: number) => (interpolate(simLat, t) - HOME_LAT_DEG) * DEG * MERIDIONAL_M;
  const eastOf = (t: number) => (interpolate(simLng, t) - HOME_LON_DEG) * DEG * NORMAL_M * Math.cos(HOME_LAT_DEG * DEG);
  let farthestNorthM = -Infinity;
  simLat.timeS.forEach(t => { if (armed(t)) farthestNorthM = Math.max(farthestNorthM, northOf(t)); });
  const mode = series(log, "MODE", "Mode");
  return {
    satellites, satellitesWritten: [...written].sort((a, b) => a - b), unwrittenSatellites: satellites.filter(n => !written.has(n)),
    haccMinM, haccMaxM, haccOffBy, haccSamples,
    offsetWrites: glitchX.timeS.length, offsetSamples: misses.length,
    offsetWithinShare: misses.filter(m => m <= 0.5).length / Math.max(1, misses.length), offsetP95M: misses[Math.floor(0.95 * (misses.length - 1))] ?? NaN,
    fixLostAtS, fixLostNorthM: fixLostAtS === null ? null : northOf(fixLostAtS), modelLossNorthM: fixLostAtS === null ? null : modelFixLossNorthM(fixLostAtS),
    farthestNorthM, landedFromPadM: Math.hypot(northOf(disarmedAt), eastOf(disarmedAt)),
    modesAfterLoss: fixLostAtS === null ? [] : mode.value.filter((_, i) => (mode.timeS[i] ?? 0) >= fixLostAtS), armedS,
  };
}

const tasksPanel = (page: Page): Locator => page.getByRole("tabpanel", { name: "Flight tasks", exact: true });
/** A stored route from the pad north to `northM` and back, at 10 m and 5 m/s. */
async function saveRoute(page: Page, name: string, northM: number): Promise<void> {
  await page.getByRole("tab", { name: "Flight tasks", exact: true }).click();
  const panel = tasksPanel(page);
  await panel.getByRole("button", { name: "New flight task", exact: true }).click();
  await panel.getByLabel("Task name", { exact: true }).fill(name);
  await panel.getByLabel("Task type", { exact: true }).selectOption("route");
  const points = [[String(northM), "0", "10", "5"], ["0", "0", "10", "5"]];
  for (const [i, point] of points.entries()) {
    for (const [j, field] of ["north (m)", "east (m)", "altitude (m)", "speed (m/s)"].entries()) {
      await panel.getByLabel(`Point ${i + 1} ${field}`, { exact: true }).fill(point[j] ?? "");
    }
  }
  await panel.getByRole("button", { name: "Save flight task", exact: true }).click();
  await expect(panel.getByTestId("task-status")).toHaveText(`Saved ${name}, version 1.`);
}
/** Turns one effect on from the Faults tab with the given field values. */
async function applyEffect(page: Page, label: string, fields: Readonly<Record<string, string>> = {}): Promise<void> {
  await page.getByRole("tab", { name: "Faults and interference", exact: true }).click();
  await page.getByLabel("Effect", { exact: true }).selectOption({ label });
  for (const [field, value] of Object.entries(fields)) await page.getByLabel(field, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Apply now", exact: true }).click();
  await expect(page.getByTestId("fault-refusal")).toHaveCount(0);
  await expect(page.getByTestId("fault-ledger")).toContainText(label, { timeout: 10_000 });
}
/** One run of the route `task`: READY, the GNSS effects on, Run task, until disarmed after flying, then stopped. */
async function fly(page: Page, launcherPort: number, token: string, task: string, first: boolean): Promise<{ taskState: string; accidents: number }> {
  await page.getByRole("tab", { name: "Run", exact: true }).click();
  const run = page.getByRole("region", { name: "ArduPilot SITL" });
  if (first) {
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcherPort));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    await run.getByLabel("Speed").selectOption("4");
  }
  await run.getByLabel("Flight task", { exact: true }).selectOption({ label: `${task} (version 1)` });
  await run.getByRole("button", { name: "Start SITL run" }).click();
  await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300_000 });
  await page.getByRole("tab", { name: "Parameters", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Parameters", exact: true }).getByTestId("parameters-status")).toHaveAttribute("data-download", "complete", { timeout: 120_000 });

  await applyEffect(page, "GNSS satellite geometry", { "Elevation mask": "10", "User range error σ": "1.5" });
  await applyEffect(page, "GNSS receiver timing");
  await applyEffect(page, "GNSS code tracking noise");
  await applyEffect(page, "GNSS multipath");
  await applyEffect(page, "GNSS jammer", { "Position from the home north": String(JAMMER.positionNedM[0]), "Position from the home east": "0",
    "Position from the home down": String(JAMMER.positionNedM[2]), "Radiated power (EIRP)": String(JAMMER.eirpDbW) });

  await page.getByRole("tab", { name: "Run", exact: true }).click();
  await run.getByRole("button", { name: "Run task", exact: true }).click();
  await expect(run.getByTestId("sitl-armed")).toHaveText("Armed", { timeout: 120_000 });
  await expect(run.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 600_000 });
  const taskState = (await run.getByTestId("task-state").getAttribute("data-state")) ?? "";
  const accidents = await run.getByTestId("sitl-accidents").locator("li").count();
  await run.getByRole("button", { name: "Stop run", exact: true }).click();
  await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 60_000 });
  return { taskState, accidents };
}

test("the GNSS stream reaches ArduPilot's receiver in flight, and a jammer on the route takes the fix away", async ({ page }, info) => {
  test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");
  test.setTimeout(1_800_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-gnss-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  const evidence: Record<string, unknown> = { declared: "SPECS_SIMULATION_ENGINES, Receiver timing, tracking noise, multipath and jammers (2026-11-09)", jammer: JAMMER };
  try {
    await seedQuadProject(page, "Quad X GNSS");
    await saveRoute(page, "North 250", 250);
    await saveRoute(page, "North 330", 330);
    const degraded = await fly(page, launcher.port, token, "North 250", true);
    const lost = await fly(page, launcher.port, token, "North 330", false);
    const logs = readdirSync(join(home, "experiments")).flatMap(id => {
      const directory = join(home, "experiments", id, "logs");
      return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".BIN")).map(name => join(directory, name)) : [];
    }).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    // Kept beside the browser artifacts (ignored, no tracked files) for a second look.
    mkdirSync(LOG_COPIES, { recursive: true });
    logs.forEach((path, i) => copyFileSync(path, join(LOG_COPIES, `run${i + 1}.BIN`)));
    expect(logs).toHaveLength(2);
    const [one, two] = logs.map(path => analyse(readDataFlash(new Uint8Array(readFileSync(path)))));
    if (!one || !two) throw new Error("Two logs expected");
    Object.assign(evidence, { run1: { ...degraded, ...one }, run2: { ...lost, ...two } });
    await info.attach("gnss-flight.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    process.stdout.write(`TASK-117 GNSS flight: ${JSON.stringify(evidence)}\n`);

    // Run 1: the receiver reports what the stream wrote, the fix holds, and the aircraft comes home.
    expect(one.satellites.length).toBeGreaterThanOrEqual(3);
    expect(one.unwrittenSatellites).toEqual([]);
    expect((one.satellites.at(-1) ?? 0) - (one.satellites[0] ?? 0)).toBeGreaterThanOrEqual(10);
    expect(one.haccSamples).toBeGreaterThan(20);
    expect(one.haccOffBy).toBeLessThanOrEqual(0.01);
    expect(one.haccMaxM / one.haccMinM).toBeGreaterThanOrEqual(1.3);
    expect(one.offsetWrites).toBeGreaterThanOrEqual(100);
    expect(one.offsetSamples).toBeGreaterThan(100);
    expect(one.offsetWithinShare).toBeGreaterThanOrEqual(0.95);
    expect(one.fixLostAtS).toBeNull();
    expect(one.farthestNorthM).toBeGreaterThan(240);
    expect(one.landedFromPadM).toBeLessThanOrEqual(5);
    expect(degraded.accidents).toBe(0);
    // Run 2: the fix goes where the model says, ArduCopter's failsafe lands it, and nothing crashes.
    expect(two.fixLostNorthM).not.toBeNull();
    expect(two.modelLossNorthM).not.toBeNull();
    expect(Math.abs((two.fixLostNorthM ?? NaN) - (two.modelLossNorthM ?? NaN))).toBeLessThanOrEqual(30);
    expect(two.modesAfterLoss).toContain(9);
    expect(lost.accidents).toBe(0);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
    mkdirSync(dirname(EVIDENCE), { recursive: true });
    writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
  }
});
