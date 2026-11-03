import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { seedQuadProject } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-175 (S10, decision A-05): real-time and as-fast-as-possible runs of
// native ArduCopter 8ab6afde through the Run tab alone. Tolerances declared
// before the test: the speed the panel reports over an interval agrees with
// the test's own measurement of simulated over wall time over the same 20 s
// to within 5 %; the truth trajectory of the two runs over their first 20 s
// of simulated time, while the vehicle settles disarmed and the autopilot
// warms up, is identical row for row at every recorded tick. The real-time run is
// labelled real time only when it averages at least 0.99, and every dropped
// interval is listed; the accelerated run is never labelled real time. Speed
// is judged from the autopilot's first heartbeat; SITL's start-up before it
// is shown on its own.

type Host = typeof import("../../packages/aar/src/recorder-v2-host");
type Store = typeof import("../../packages/project/src/store");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
const urls = {
  host: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
};
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-8ab6afde";
/** The compared stretch of simulated time, s, and the displayed speed's agreement with the test's own measurement. */
const COMPARED_S = 20, SPEED_AGREEMENT = 0.05;
/** The wall time of the test's own speed measurement, ms: the shown simulated time has 0.1 s steps and updates every 250 ms. */
const MEASURED_MS = 20_000;

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

const simTime = async (run: Locator) => Number.parseFloat((await run.getByTestId("sitl-sim-time").textContent()) ?? "NaN");

/** truth.position rows of each recorded experiment of the project, by record SHA-256: [tick, north, east, down]. */
async function trajectories(page: Page, projectId: string): Promise<Record<string, [number, number, number, number][]>> {
  return page.evaluate(async ({ urls, projectId, until }) => {
    const { reopenRecording } = await import(urls.host) as Host;
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const store = await ProjectStore.openIndexedDb();
    try {
      const out: Record<string, [number, number, number, number][]> = {};
      for (const stored of await store.listItems(projectId, "experiment")) {
        const opened = await reopenRecording(readExperiment(stored).recording?.recordId ?? "");
        out[stored.sha256] = (opened.rows.get("truth.position") ?? []).filter(row => row.simTimeS <= until)
          .map((row): [number, number, number, number] => [row.tick, row.values?.[0] ?? Number.NaN, row.values?.[1] ?? Number.NaN, row.values?.[2] ?? Number.NaN]);
      }
      return out;
    } finally {
      store.close();
    }
  }, { urls, projectId, until: COMPARED_S });
}

test("a real-time and an as-fast-as-possible run take the same steps, and each shows its measured speed", async ({ page }) => {
  test.setTimeout(600_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "mirage-speed-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    const { projectId } = await seedQuadProject(page, "Quad X pace");
    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const run = page.getByRole("region", { name: "ArduPilot SITL" });
    await run.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await run.getByLabel("Launcher token", { exact: true }).fill(token);
    await run.getByRole("button", { name: "List ArduPilot builds" }).click();
    await expect(run.getByLabel("ArduPilot build", { exact: true })).toHaveValue(FIRMWARE_ID);
    const speed = run.getByTestId("sitl-speed");
    const records: string[] = [];

    for (const [label, mode] of [["Real time", "real-time"], ["As fast as possible", "as-fast-as-possible"]] as const) {
      await run.getByLabel("Speed").selectOption({ label });
      await run.getByRole("button", { name: /^Start (SITL run|again)$/ }).click();
      await expect(run.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 300000 });
      await expect(speed).toHaveAttribute("data-mode", mode);
      // The test's own measurement over 20 s of wall time, against the meter's ratio over the same interval: what the
      // panel reports as simulated and running wall time at its start and end.
      const meter = async () => [Number(await speed.getAttribute("data-sim-elapsed")), Number(await speed.getAttribute("data-running-wall"))];
      const [startElapsed = 0, startRunning = 0] = await meter(), startSim = await simTime(run), startWall = Date.now();
      await page.waitForTimeout(MEASURED_MS);
      const [endElapsed = 0, endRunning = 0] = await meter(), endSim = await simTime(run), endWall = Date.now();
      const measured = (endSim - startSim) / ((endWall - startWall) / 1000);
      const shown = (endElapsed - startElapsed) / (endRunning - startRunning), average = Number(await speed.getAttribute("data-average"));
      await expect(run.getByTestId("sitl-startup")).toContainText("not judged");
      console.log(`EVID ${mode} measured ${measured.toFixed(3)} shown ${shown.toFixed(3)} average ${average.toFixed(3)} ${(await speed.textContent()) ?? ""}`);
      expect(Math.abs(shown - measured) / measured).toBeLessThan(SPEED_AGREEMENT);
      if (mode === "real-time") {
        const dropped = Number(await run.getByTestId("sitl-dropped").getAttribute("data-count"));
        // Real time only at A-05's ratio; otherwise behind, with every dropped interval listed.
        await expect(speed).toHaveAttribute("data-real-time", average >= 0.99 ? "true" : "false");
        await expect(run.getByTestId("sitl-speed-verdict")).toHaveText(average >= 0.99 ? "Real time" : /^Behind real time/);
        if (dropped > 0) await expect(run.getByTestId("sitl-dropped-list").locator("li")).toHaveCount(dropped);
      } else {
        await expect(speed).toHaveAttribute("data-real-time", "unknown");
        await expect(run.getByTestId("sitl-speed-verdict")).toHaveText("As fast as possible: the pace is what this computer reaches");
        expect(average).toBeGreaterThan(1);
        // An accelerated run is never judged against real time, so it lists no dropped intervals.
        await expect(run.getByTestId("sitl-dropped")).toHaveCount(0);
      }
      records.push((await run.getByTestId("sitl-record").textContent()) ?? "");
      await run.getByRole("button", { name: "Stop run" }).click();
      await expect(run.getByTestId("sitl-stage")).toHaveAttribute("data-state", "idle", { timeout: 30000 });
    }

    // The same steps: the two recorded trajectories agree row for row over the compared stretch.
    const paths = await trajectories(page, projectId);
    const [a, b] = records.map(sha => paths[sha] ?? []);
    expect(a?.length).toBeGreaterThan(COMPARED_S * 40);
    expect(b).toEqual(a);
    console.log(`EVID compared ${a?.length ?? 0} truth.position rows up to ${COMPARED_S} s; last ${JSON.stringify(a?.at(-1))}`);
  } finally {
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
  }
});
