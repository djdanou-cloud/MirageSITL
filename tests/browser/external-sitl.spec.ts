import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { viteFileUrl } from "../support/vite-url";

// TASK-153 (S01, S02, S03) DoD: in the browser application, a profile-defined
// quad X arms, takes off, holds and lands with native ArduCopter. The launcher
// is the TASK-152 installation (its own token, Python environment and the
// installed ArduCopter 8ab6afde); the project, the example component cards and
// the S19 quad X profile are seeded through the application's own store
// modules, and the flight is driven through the Run tab alone. READY must come
// from the Worker's LiveEkfWarmup on this run.
type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
};
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const QUAD = read("../fixtures/aircraft/quad-x.json");
const CARDS = Object.fromEntries(["motor", "propeller", "esc", "battery"].map(type => [type, read(`../fixtures/components/${type}-example.json`)]));

test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

test("the Run tab flies the quad X profile with native ArduCopter: READY, take-off to 5 m, hold and land", async ({ page }) => {
  test.setTimeout(600000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  const token = ensureToken(HOME);
  const launcher = await startLauncher({ home: HOME, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  try {
    await page.goto("/");
    await page.evaluate(async ({ urls, quad, cards }) => {
      const { ProjectStore } = await import(urls.store) as Store;
      const { profileDraft, validateAircraftProfile, withPropellerPolars } = await import(urls.profile) as Profiles;
      const { saveNavigation } = await import(urls.navigation) as Navigation;
      const store = await ProjectStore.openIndexedDb();
      try {
        const project = await store.createProject("SITL project");
        const ids: Record<string, string> = {};
        for (const [type, text] of Object.entries(cards)) {
          const card: unknown = JSON.parse(text);
          if (typeof card !== "object" || card === null) throw new Error(`Invalid ${type} card fixture`);
          const values: unknown = Reflect.get(card, "values");
          const provenance = Object.fromEntries(Object.entries(typeof values === "object" && values !== null ? values : {})
            .map(([key, value]) => [key, value === null ? null : "example"]));
          const stored = await store.createItem(project.record.id, "component-card", { name: `Example ${type}`, payload: { ...card, provenance } });
          ids[type] = stored.sha256;
        }
        const fixture = validateAircraftProfile(JSON.parse(quad));
        const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: ids.battery },
          motors: fixture.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) }),
        [{ card: ids.propeller!, polar: "naca6409-neuralfoil-v1" }]);
        await store.createItem(project.record.id, "aircraft-profile", profileDraft("Quad X SITL", profile));
        await saveNavigation(store, { tab: "run", projectId: project.record.id });
      } finally {
        store.close();
      }
    }, { urls, quad: QUAD, cards: CARDS });
    await page.reload();

    await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
    const panel = page.getByRole("region", { name: "ArduPilot SITL" });
    await expect(panel.getByLabel("Aircraft profile")).toContainText("Quad X SITL");
    await panel.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await panel.getByLabel("Launcher token", { exact: true }).fill(token);
    await panel.getByLabel("Speed").selectOption("4");
    expect((await new AxeBuilder({ page }).include(".sitl-flight").analyze()).violations).toEqual([]);
    await panel.getByRole("button", { name: "Start SITL run" }).click();

    const stage = panel.getByTestId("sitl-stage"), ready = panel.getByTestId("sitl-ready"), altitude = panel.getByTestId("sitl-altitude");
    await expect(ready).toHaveText("READY", { timeout: 180000 });
    await expect(stage).toHaveText("READY");
    expect(await page.evaluate(() => location.href)).not.toContain(token);
    await panel.getByLabel("Take-off altitude, m").fill("5");
    await panel.getByRole("button", { name: "Take off" }).click();
    await expect(panel.getByTestId("sitl-armed")).toHaveText("Armed", { timeout: 60000 });
    await expect(stage).toHaveText("Flying", { timeout: 120000 });
    await expect(panel.getByTestId("sitl-mode")).toHaveText("GUIDED");
    // Hold: at least 10 s of simulated time as the page shows it, every reading within 0.5 m of 5 m.
    const meters = async () => Number((await altitude.textContent())?.replace(" m", ""));
    const simTime = async () => Number.parseFloat((await panel.getByTestId("sitl-sim-time").textContent()) ?? "NaN");
    // The panel refreshes every 250 ms; one simulated second passes before sampling, so no reading predates the settled climb.
    const settled = await simTime();
    while ((await simTime()) - settled < 1) await page.waitForTimeout(100);
    const holdStart = await simTime();
    const readings: number[] = [];
    while ((await simTime()) - holdStart < 10) {
      readings.push(await meters());
      await page.waitForTimeout(250);
    }
    expect(readings.length).toBeGreaterThan(3);
    expect(Math.min(...readings)).toBeGreaterThan(4.5);
    expect(Math.max(...readings)).toBeLessThan(5.5);
    await panel.getByRole("button", { name: "Land" }).click();
    await expect(panel.getByTestId("sitl-mode")).toHaveText("LAND", { timeout: 30000 });
    await expect(stage).toHaveText("Landed", { timeout: 120000 });
    expect(await meters()).toBeLessThan(0.1);
    await expect(panel.getByTestId("sitl-frames")).toContainText(" 0 lost, 0 resent");
    await panel.getByRole("button", { name: "Stop run" }).click();
    await expect(stage).toHaveText("Stopped");
  } finally {
    await launcher.close();
  }
});
