import { expect, test, type Locator, type Page } from "@playwright/test";
import { field, S19_FIXTURES, seedProfiles } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";

// TASK-185 DoD without a SITL: the Run tab's flight view draws each of the
// five S19 configurations as its profile defines it, and switching between
// the external and onboard views leaks no renderer resources. The oracle is
// the TASK-138 layout derivation of the same stored profile, mapped to render
// axes here (body x forward, y right, z down -> render right, up, back:
// (y, -z, -x)), not the view's own geometry code. The real-SITL flight with
// the view (pose, trajectory, per-motor values, onboard view) is in
// tests/browser/external-sitl.spec.ts.

type Layouts = typeof import("../../packages/aircraft/src/layout");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Store = typeof import("../../packages/project/src/store");
const urls = {
  layout: viteFileUrl(new URL("../../packages/aircraft/src/layout.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
};

interface Probe {
  mode: string;
  rotors: { motorId: number; position: number[]; axis: number[]; spin: string; label: string }[];
  geometries: number; textures: number; programs: number; trailPoints: number; routePoints: number;
}
async function probe(view: Locator): Promise<Probe> {
  const text = await view.getAttribute("data-probe");
  if (!text) throw new Error("The flight view has not reported yet");
  const parsed: unknown = JSON.parse(text);
  const rotors = field(parsed, "rotors");
  if (!Array.isArray(rotors)) throw new Error("The probe has no rotors");
  const list: readonly unknown[] = rotors;
  const number = (value: unknown) => (typeof value === "number" ? value : Number.NaN);
  const numbers = (value: unknown) => (Array.isArray(value) ? value.map(number) : []);
  return {
    mode: String(field(parsed, "mode")), geometries: number(field(parsed, "geometries")), textures: number(field(parsed, "textures")),
    programs: number(field(parsed, "programs")), trailPoints: number(field(parsed, "trailPoints")), routePoints: number(field(parsed, "routePoints")),
    rotors: list.map(r => ({ motorId: number(field(r, "motorId")), position: numbers(field(r, "position")), axis: numbers(field(r, "axis")),
      spin: String(field(r, "spin")), label: String(field(r, "label")) })),
  };
}
/** The expected rotors of a stored profile version, from its TASK-138 layout in the page. */
async function expectedRotors(page: Page, sha256: string): Promise<{ motorId: number; position: number[]; axis: number[]; spin: string }[]> {
  return page.evaluate(async ({ urls, sha256 }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { readAircraftProfile } = await import(urls.profile) as Profiles;
    const { deriveLayout } = await import(urls.layout) as Layouts;
    const store = await ProjectStore.openIndexedDb();
    try {
      const layout = deriveLayout(readAircraftProfile(await store.get(sha256)));
      const render = (v: readonly number[]) => [v[1] ?? 0, -(v[2] ?? 0), -(v[0] ?? 0)];
      return layout.rotors.map(r => ({ motorId: r.motorId, position: render(r.hubPositionBodyM), axis: render(r.thrustAxisBody),
        spin: r.spinSign === 1 ? "ccw" : "cw" }));
    } finally {
      store.close();
    }
  }, { urls, sha256 });
}
async function openSitlPanel(page: Page): Promise<Locator> {
  await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
  return page.getByRole("region", { name: "ArduPilot SITL" });
}

test("the flight view draws each S19 configuration as its profile defines it", async ({ page }) => {
  test.setTimeout(120000);
  const seeded = await seedProfiles(page, S19_FIXTURES);
  const panel = await openSitlPanel(page);
  const view = panel.getByTestId("flight-view");
  for (const name of S19_FIXTURES) {
    const sha256 = seeded.profiles[name];
    if (!sha256) throw new Error(`No seeded ${name}`);
    await panel.getByLabel("Aircraft profile").selectOption(sha256);
    const expected = await expectedRotors(page, sha256);
    // Two profiles may have as many motors (octa X and X8), so wait for this profile's own rotors, not just their count.
    const summary = (rotors: readonly { motorId: number; spin: string; position: number[] }[]) =>
      rotors.map(r => `${r.motorId}:${r.spin}:${r.position.map(v => v.toFixed(4)).join(",")}`).join(" ");
    await expect.poll(async () => summary((await probe(view).catch(() => null))?.rotors ?? []), { message: name }).toBe(summary(expected));
    const drawn = (await probe(view)).rotors;
    expect(drawn.map(r => [r.motorId, r.label, r.spin]), name).toEqual(expected.map(r => [r.motorId, String(r.motorId), r.spin]));
    for (const [i, rotor] of expected.entries()) {
      const shown = drawn[i];
      if (!shown) throw new Error(`${name}: motor ${rotor.motorId} is not drawn`);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs((shown.position[k] ?? Number.NaN) - (rotor.position[k] ?? 0)), `${name} motor ${rotor.motorId} position ${k}`).toBeLessThan(1e-6);
        expect(Math.abs((shown.axis[k] ?? Number.NaN) - (rotor.axis[k] ?? 0)), `${name} motor ${rotor.motorId} thrust axis ${k}`).toBeLessThan(1e-6);
      }
    }
  }
  // Coaxial pairs: the 16-motor octa draws 16 rotors over 8 arms, upper and lower discs on one axis.
  const octa = await probe(view);
  expect(octa.rotors).toHaveLength(16);
  expect(octa.routePoints).toBe(0);
  await expect(panel.getByText("no flight task route is loaded")).toBeVisible();
});

test("switching between the external and onboard views leaks no renderer resources", async ({ page }) => {
  test.setTimeout(120000);
  await seedProfiles(page, ["quad-x"]);
  const panel = await openSitlPanel(page);
  const view = panel.getByTestId("flight-view");
  const external = panel.getByRole("radio", { name: "External" }), onboard = panel.getByRole("radio", { name: "Onboard" });
  const settle = async (mode: string) => { await expect.poll(async () => (await probe(view).catch(() => null))?.mode).toBe(mode); };
  await settle("external");
  // One round trip creates what both views need; later round trips must add nothing.
  await onboard.check(); await settle("onboard");
  await external.check(); await settle("external");
  await page.waitForTimeout(500);
  const baseline = await probe(view);
  for (let i = 0; i < 20; i++) {
    await onboard.check(); await settle("onboard");
    await external.check(); await settle("external");
  }
  await page.waitForTimeout(500);
  const after = await probe(view);
  expect([after.geometries, after.textures, after.programs]).toEqual([baseline.geometries, baseline.textures, baseline.programs]);
  // Leaving the Run tab and coming back keeps them too: the hidden view stops drawing and keeps its scene.
  await page.getByRole("tab", { name: "Aircraft" }).click();
  await page.getByRole("tab", { name: "Run" }).click();
  await settle("external");
  await page.waitForTimeout(500);
  const back = await probe(view);
  expect([back.geometries, back.textures, back.programs]).toEqual([baseline.geometries, baseline.textures, baseline.programs]);
});
