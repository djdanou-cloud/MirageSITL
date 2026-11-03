import { expect, test, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";
import { seedQuadProject } from "../support/run-tab";
import { panel } from "../support/aircraft-ui";

// TASK-096 (S05): the Aircraft tab's body drag. A profile without stated drag shows the standard hull's preliminary
// estimate; stating drag areas starts from that estimate, needs a source, and saves a new profile version in schema 5,
// which derives the stated tensor; removing them saves the profile back in its earlier schema.
type Store = typeof import("../../packages/project/src/store");
const urls = { store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)) };
const PROFILE = "Quad X drag";

/** The schema and stated drag of the newest stored version of the profile. */
async function stored(page: Page): Promise<{ version: number; schemaVersion: number; airframeDrag: unknown }> {
  return page.evaluate(async ({ urls, name }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      const projects = await store.listProjects();
      const heads = (await Promise.all(projects.map(project => store.listItems(project.record.id, "aircraft-profile")))).flat();
      const head = heads.find(item => item.record.name === name);
      if (!head) throw new Error(`No stored profile ${name}`);
      const payload = head.record.payload as { schemaVersion: number; airframeDrag?: unknown };
      return { version: head.record.version, schemaVersion: payload.schemaVersion, airframeDrag: payload.airframeDrag ?? null };
    } finally {
      store.close();
    }
  }, { urls, name: PROFILE });
}

test("states body drag areas with their source over the preliminary estimate, as a new profile version", async ({ page }) => {
  await seedQuadProject(page, PROFILE);
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
  const tab = panel(page);
  await tab.getByRole("button", { name: `Open ${PROFILE}`, exact: true }).click();
  const estimate = tab.getByTestId("drag-estimate"), save = tab.getByRole("button", { name: "Save profile", exact: true });
  await expect(estimate).toHaveText(/^Preliminary estimate: drag areas x [0-9.]+, y [0-9.]+, z [0-9.]+ m²; .* valid up to [0-9.]+ m\/s\.$/);
  const xArea = /drag areas x ([0-9.]+),/.exec((await estimate.textContent()) ?? "")?.[1];
  expect((await stored(page)).schemaVersion).toBe(4);

  // Stating the drag starts from the estimate and needs a source before it can be saved.
  await tab.getByLabel("State the drag areas", { exact: true }).check();
  await expect(tab.getByLabel("Drag area x (m²)", { exact: true })).toHaveValue(xArea ?? "missing");
  await expect(tab.getByText("Say where the drag areas come from")).toBeVisible();
  await expect(save).toBeDisabled();
  for (const [label, value] of [["Drag area x (m²)", "0.02"], ["Drag area y (m²)", "0.025"], ["Drag area z (m²)", "0.05"],
    ["Center of pressure x (m)", "0.01"], ["Center of pressure y (m)", "0"], ["Center of pressure z (m)", "-0.02"], ["Valid up to (m/s)", "18"],
    ["Where the values come from", "Wind-tunnel test of the bare frame, 2026-10-30"]] as const) {
    await tab.getByLabel(label, { exact: true }).fill(value);
  }
  await save.click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Saved version 2 of ${PROFILE}.`);
  expect(await stored(page)).toEqual({ version: 2, schemaVersion: 5, airframeDrag: { dragAreasM2: [0.02, 0.025, 0.05],
    centerOfPressureBodyM: [0.01, 0, -0.02], maxAirspeedMps: 18, source: "Wind-tunnel test of the bare frame, 2026-10-30" } });

  // Back to the estimate: the profile returns to schema 4.
  await tab.getByLabel("State the drag areas", { exact: true }).uncheck();
  await save.click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Saved version 3 of ${PROFILE}.`);
  expect(await stored(page)).toEqual({ version: 3, schemaVersion: 4, airframeDrag: null });
});
