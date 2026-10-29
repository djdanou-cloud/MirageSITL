import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";
import { RECIPES, profileDifferences, rotate, toRender, type MassText, type Recipe } from "../support/aircraft-recipes";

// TASK-141 (S03): the Aircraft tab. Each S19 configuration is built through
// the UI alone from its recipe; the saved profile must match the fixture, and
// the rotors drawn in the 3D scheme, read back from the Three.js scene graph,
// must sit where the derived vehicle manifest puts them, point along its
// thrust axes and show its spins.
type Store = typeof import("../../packages/project/src/store");
type Derivation = typeof import("../../packages/aircraft/src/derive-manifest");
type Support = typeof import("../support/aircraft-derivation");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  derivation: viteFileUrl(new URL("../../packages/aircraft/src/derive-manifest.ts", import.meta.url)),
  support: viteFileUrl(new URL("../support/aircraft-derivation.ts", import.meta.url)),
};
/** Rendered poses agree with the manifest to this, in metres and unit-vector components. */
const POSE_TOLERANCE = 1e-9;

interface Rendered { motorId: number; position: number[]; axis: number[]; spin: string; label: string }
interface ManifestRotor { id: number; hubPositionBodyM: number[]; hubToBody: number[]; spinSign: number }
interface StoredProfile {
  arms: { id: number; azimuthRad: number; outwardTiltRad: number; sideTiltRad: number }[];
  motors: { id: number }[];
}

async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  await page.getByLabel("New project name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByTestId("current-project")).toHaveText(name);
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
}
const panel = (page: Page) => page.getByRole("tabpanel", { name: "Aircraft", exact: true });
const group = (scope: Locator, name: string) => scope.getByRole("group", { name, exact: true });

async function fillMass(scope: Locator, title: string, mass: MassText): Promise<void> {
  await scope.getByLabel(`${title} mass (kg)`, { exact: true }).fill(mass.massKg);
  for (const [i, axis] of ["x", "y", "z"].entries()) await scope.getByLabel(`${title} CG ${axis} (m)`, { exact: true }).fill(mass.cg[i]!);
  for (const [i, symbol] of ["Ixx", "Iyy", "Izz", "Ixy", "Ixz", "Iyz"].entries()) {
    await scope.getByLabel(`${title} ${symbol} (kg·m²)`, { exact: true }).fill(mass.inertia[i]!);
  }
}

/** Types a recipe into the Aircraft tab and saves it. */
async function build(page: Page, recipe: Recipe): Promise<void> {
  const tab = panel(page);
  await tab.getByRole("button", { name: "New profile", exact: true }).click();
  await tab.getByLabel("Profile name", { exact: true }).fill(recipe.name);
  await tab.getByLabel("Number of arms", { exact: true }).fill(recipe.layout.count);
  await tab.getByLabel("Arm length (m)", { exact: true }).fill(recipe.layout.lengthM);
  await tab.getByLabel("First arm azimuth (°)", { exact: true }).fill(recipe.layout.firstAzimuthDeg);
  if (recipe.layout.coaxial) {
    await tab.getByLabel("Coaxial pairs", { exact: true }).check();
    await tab.getByLabel("Layout pair separation (m)", { exact: true }).fill(recipe.layout.pairSeparationM);
  }
  await tab.getByRole("button", { name: "Lay out arms", exact: true }).click();
  await expect(group(tab, `Arm ${recipe.layout.count}`)).toBeVisible();
  for (const edit of recipe.arms) {
    const arm = group(tab, `Arm ${edit.arm}`);
    if (edit.heightM !== undefined) await arm.getByLabel("Height (m)", { exact: true }).fill(edit.heightM);
    if (edit.outwardTiltDeg !== undefined) await arm.getByLabel("Outward tilt (°)", { exact: true }).fill(edit.outwardTiltDeg);
    if (edit.sideTiltDeg !== undefined) await arm.getByLabel("Side tilt (°)", { exact: true }).fill(edit.sideTiltDeg);
  }
  for (const edit of recipe.motors) {
    const motor = group(tab, recipe.layout.coaxial ? `Arm ${edit.arm} ${edit.position} motor` : `Arm ${edit.arm} motor`);
    await motor.getByLabel("Motor number", { exact: true }).fill(edit.id);
    await motor.getByLabel("ArduPilot output", { exact: true }).fill(edit.output);
  }
  await fillMass(tab, "Aircraft", recipe.mass);
  if (recipe.payload) {
    await tab.getByLabel("Payload", { exact: true }).check();
    await fillMass(tab, "Payload", recipe.payload);
  }
  if (recipe.groundClearanceM !== "") await tab.getByLabel("Ground clearance (m, optional)", { exact: true }).fill(recipe.groundClearanceM);
  await expect(tab.getByRole("list", { name: "Problems to fix before saving" })).toHaveCount(0);
  await tab.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Created ${recipe.name}.`);
}

/** The newest stored version of a profile, and the manifest derived from it and from a fixture, computed in the page. */
async function storedAndDerived(page: Page, name: string, fixtureText: string): Promise<{ sha256: string; profile: StoredProfile; built: ManifestRotor[]; reference: ManifestRotor[] }> {
  return page.evaluate(async ({ urls, name, fixtureText }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { deriveVehicleManifest } = await import(urls.derivation) as Derivation;
    const { syntheticComponents } = await import(urls.support) as Support;
    const store = await ProjectStore.openIndexedDb();
    try {
      const projects = await store.listProjects();
      const heads = (await Promise.all(projects.map(project => store.listItems(project.record.id, "aircraft-profile")))).flat();
      const head = heads.find(stored => stored.record.name === name);
      if (!head) throw new Error(`No stored profile ${name}`);
      const derive = async (input: unknown) => {
        const profile = JSON.parse(JSON.stringify(input)) as Parameters<Support["syntheticComponents"]>[0];
        const derived = await deriveVehicleManifest(profile, syntheticComponents(profile), { modelId: 141 });
        return derived.manifest.rotors.map(rotor => ({ id: rotor.id, hubPositionBodyM: [...rotor.hubPositionBodyM], hubToBody: [...rotor.hubToBody], spinSign: rotor.spinSign }));
      };
      return {
        sha256: head.sha256, profile: JSON.parse(JSON.stringify(head.record.payload)) as StoredProfile,
        built: await derive(head.record.payload), reference: await derive(JSON.parse(fixtureText)),
      };
    } finally {
      store.close();
    }
  }, { urls, name, fixtureText });
}
async function rendered(page: Page, count: number): Promise<Rendered[]> {
  const scheme = panel(page).getByTestId("aircraft-scheme");
  await expect(scheme).toHaveAttribute("data-current", "true");
  await expect.poll(async () => (JSON.parse(await scheme.getAttribute("data-rendered") ?? "[]") as unknown[]).length).toBe(count);
  return JSON.parse(await scheme.getAttribute("data-rendered") ?? "[]") as Rendered[];
}
function poseDifferences(drawn: readonly Rendered[], manifest: readonly ManifestRotor[]): string[] {
  const differences: string[] = [];
  if (drawn.length !== manifest.length) differences.push(`${drawn.length} rotors drawn, ${manifest.length} in the manifest`);
  for (const rotor of manifest) {
    const shown = drawn.find(item => item.motorId === rotor.id);
    if (!shown) {
      differences.push(`rotor ${rotor.id} is not drawn`);
      continue;
    }
    const position = toRender(rotor.hubPositionBodyM), axis = toRender(rotate(rotor.hubToBody, [0, 0, 1]));
    position.forEach((value, i) => { if (!(Math.abs(shown.position[i]! - value) <= POSE_TOLERANCE)) differences.push(`rotor ${rotor.id} position ${i}: ${shown.position[i]} != ${value}`); });
    axis.forEach((value, i) => { if (!(Math.abs(shown.axis[i]! - value) <= POSE_TOLERANCE)) differences.push(`rotor ${rotor.id} axis ${i}: ${shown.axis[i]} != ${value}`); });
    if (shown.spin !== (rotor.spinSign === 1 ? "ccw" : "cw")) differences.push(`rotor ${rotor.id} spin ${shown.spin}`);
    if (shown.label !== String(rotor.id)) differences.push(`rotor ${rotor.id} label ${shown.label}`);
  }
  return differences;
}

for (const recipe of RECIPES) {
  test(`${recipe.name} is built through the UI alone and drawn where its manifest puts each rotor`, async ({ page }) => {
    const fixtureText = readFileSync(new URL(`../fixtures/aircraft/${recipe.fixture}.json`, import.meta.url), "utf8");
    await page.goto("/");
    await createProject(page, `${recipe.name} trials`);
    await build(page, recipe);
    const result = await storedAndDerived(page, recipe.name, fixtureText);
    expect(profileDifferences(result.profile, JSON.parse(fixtureText) as StoredProfile)).toEqual([]);
    const drawn = await rendered(page, result.profile.motors.length);
    expect(poseDifferences(drawn, result.built)).toEqual([]);
    // The fixture's own manifest agrees within the same tolerance.
    expect(poseDifferences(drawn, result.reference)).toEqual([]);
  });
}

test("invalid edits are blocked with a reason, and a copy leaves the original unchanged", async ({ page }) => {
  const quad = RECIPES[0]!;
  await page.goto("/");
  await createProject(page, "Editor checks");
  await build(page, quad);
  const tab = panel(page), problems = tab.getByRole("list", { name: "Problems to fix before saving" });
  const save = tab.getByRole("button", { name: "Save profile", exact: true });
  const original = await storedAndDerived(page, quad.name, readFileSync(new URL("../fixtures/aircraft/quad-x.json", import.meta.url), "utf8"));

  // A spin edit reaches the scheme; it is a valid change.
  await group(tab, "Arm 1 motor").getByLabel("Spin", { exact: true }).selectOption({ label: "Clockwise" });
  await expect.poll(async () => (await rendered(page, 4)).find(rotor => rotor.motorId === 1)?.spin).toBe("cw");
  await expect(save).toBeEnabled();
  // A repeated output, an unreadable length and a ninth arm are refused with their reasons.
  await group(tab, "Arm 2 motor").getByLabel("ArduPilot output", { exact: true }).fill("1");
  await expect(problems).toContainText("Output 1 is assigned to motors 1 and 4");
  await expect(save).toBeDisabled();
  await expect(tab.getByTestId("aircraft-scheme")).toHaveAttribute("data-current", "false");
  await group(tab, "Arm 1").getByLabel("Length (m)", { exact: true }).fill("long");
  await expect(problems).toContainText("Arm 1 length is not a decimal number");
  await tab.getByLabel("Number of arms", { exact: true }).fill("9");
  await tab.getByRole("button", { name: "Lay out arms", exact: true }).click();
  await expect(tab.getByRole("list", { name: "Layout errors" })).toContainText("The layout needs 1 to 8 arms");
  await expect(tab.getByRole("button", { name: "Open Quad X" })).toHaveCount(0);
  await tab.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(group(tab, "Arm 1").getByLabel("Length (m)", { exact: true })).toHaveValue("0.225");
  await expect(save).toBeDisabled();

  // Copy: a new profile; the original keeps its only version.
  await tab.getByLabel("Copy as", { exact: true }).fill("Quad X copy");
  await tab.getByRole("button", { name: "Copy profile", exact: true }).click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText("Copied Quad X to Quad X copy; the original is unchanged.");
  await expect(tab.getByRole("list", { name: "Aircraft profiles" }).getByRole("listitem")).toHaveCount(2);
  const after = await storedAndDerived(page, quad.name, readFileSync(new URL("../fixtures/aircraft/quad-x.json", import.meta.url), "utf8"));
  expect(after.sha256).toBe(original.sha256);

  // After a reload the copy opens with the saved values, and the open tab fits 390 px and passes axe.
  await page.reload();
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
  await tab.getByRole("button", { name: "Open Quad X copy", exact: true }).click();
  await expect(group(tab, "Arm 1").getByLabel("Length (m)", { exact: true })).toHaveValue("0.225");
  await expect(group(tab, "Arm 2 motor").getByLabel("Motor number", { exact: true })).toHaveValue("4");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});
