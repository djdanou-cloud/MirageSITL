import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";
import { seedQuadProject } from "../support/run-tab";
import { group, panel } from "../support/aircraft-ui";

// TASK-196 (S03): the Aircraft tab's body and arm size. Describing the body starts from the standard hull's sizes; a
// camera pod entered below the body is drawn in the 3D scheme, and the propeller clearance check sees it: hanging
// 10 mm below the ground at rest it is a clash with a fix, 3 mm above the ground it clears. The profile saves as schema 7
// with exactly the entered body, and switching the body off saves it back in its earlier schema. The pod's scrape on a
// hard landing is checked in the flight dynamics by tests/aircraft-body.test.ts with the same values.
type Store = typeof import("../../packages/project/src/store");
const urls = { store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)) };
const PROFILE = "Quad X body";

/** The schema and body of the newest stored version of the profile. */
async function stored(page: Page): Promise<{ version: number; schemaVersion: number; body: unknown }> {
  return page.evaluate(async ({ urls, name }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      const projects = await store.listProjects();
      const heads = (await Promise.all(projects.map(project => store.listItems(project.record.id, "aircraft-profile")))).flat();
      const head = heads.find(item => item.record.name === name);
      if (!head) throw new Error(`No stored profile ${name}`);
      const payload = head.record.payload as { schemaVersion: number; body?: unknown };
      return { version: head.record.version, schemaVersion: payload.schemaVersion, body: payload.body ?? null };
    } finally {
      store.close();
    }
  }, { urls, name: PROFILE });
}

test("describes the body with a low camera pod through the UI: drawn, checked for clearance and saved as schema 7", async ({ page }) => {
  await seedQuadProject(page, PROFILE);
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
  const tab = panel(page);
  await tab.getByRole("button", { name: `Open ${PROFILE}`, exact: true }).click();
  const save = tab.getByRole("button", { name: "Save profile", exact: true }), scheme = tab.getByTestId("aircraft-scheme");
  expect((await stored(page)).schemaVersion).toBe(4);
  await expect(scheme).toHaveAttribute("data-rendered-hull", "[]");

  // Describing the body starts from the standard hull: 0.25 times the 0.225 m arms across, 0.4 times that radius tall.
  await tab.getByLabel("Describe the body and arms", { exact: true }).check();
  const body = group(tab, "Body");
  await expect(body.getByLabel("Body diameter (m)", { exact: true })).toHaveValue("0.1125");
  await expect(body.getByLabel("Body height (m)", { exact: true })).toHaveValue("0.045");
  await expect(body.getByLabel("Body bottom below the reference point (m)", { exact: true })).toHaveValue("0.0225");
  await expect(body.getByLabel("Arm thickness (m)", { exact: true })).toHaveValue("0.0127");
  await body.getByLabel("Body diameter (m)", { exact: true }).fill("0.11");
  await body.getByLabel("Arm thickness (m)", { exact: true }).fill("0.013");

  // A camera pod hanging 10 mm below the ground at the profile's 0.12 m clearance.
  await tab.getByRole("button", { name: "Add a body part", exact: true }).click();
  await expect(tab.getByText("Give body part 1 a name")).toBeVisible();
  await expect(save).toBeDisabled();
  const part = group(tab, "Body part 1");
  await part.getByLabel("Name", { exact: true }).fill("camera pod");
  const pod = group(tab, "Body part 1: camera pod");
  for (const [label, value] of [["x, forward (m)", "0.05"], ["y, right (m)", "0"], ["Bottom below the reference point (m)", "0.13"],
    ["Diameter (m)", "0.06"], ["Height (m)", "0.05"]] as const) {
    await pod.getByLabel(label, { exact: true }).fill(value);
  }
  await expect(tab.getByText("The body (camera pod) reaches 10.0 mm below the ground at rest")).toBeVisible();

  // The scheme draws the body, the four arms and the pod at their size, the pod below the body and forward of it.
  await expect.poll(async () => JSON.parse((await scheme.getAttribute("data-rendered-hull")) ?? "[]") as { name: string; kind: string; position: number[] }[])
    .toEqual([
      { hullId: 0, name: "The body", kind: "cylinder", position: [0, 0, 0] },
      ...[1, 2, 3, 4].map(arm => ({ hullId: arm, name: `Arm ${arm}`, kind: "capsule", position: expect.any(Array) })),
      { hullId: 5, name: "The body (camera pod)", kind: "cylinder", position: [0, expect.closeTo(-0.105, 9) as unknown, expect.closeTo(-0.05, 9) as unknown] },
    ]);
  expect((await new AxeBuilder({ page }).include("#body-heading").include(".aircraft-panel fieldset").analyze()).violations).toEqual([]);

  // Raised to 3 mm above the ground at rest, the pod clears and the profile saves with exactly the entered body.
  await pod.getByLabel("Bottom below the reference point (m)", { exact: true }).fill("0.117");
  await expect(tab.getByText("The body (camera pod) reaches")).toHaveCount(0);
  await save.click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Saved version 2 of ${PROFILE}.`);
  expect(await stored(page)).toEqual({ version: 2, schemaVersion: 7, body: { diameterM: 0.11, heightM: 0.045, bottomDepthM: 0.0225,
    armDiameterM: 0.013, parts: [{ name: "camera pod", xM: 0.05, yM: 0, bottomDepthM: 0.117, diameterM: 0.06, heightM: 0.05 }] } });

  // Fits a phone screen.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Back to the standard hull: the profile returns to schema 4 and the scheme to its schematic body.
  await tab.getByLabel("Describe the body and arms", { exact: true }).uncheck();
  await save.click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Saved version 3 of ${PROFILE}.`);
  expect(await stored(page)).toEqual({ version: 3, schemaVersion: 4, body: null });
  await expect(scheme).toHaveAttribute("data-rendered-hull", "[]");
});
