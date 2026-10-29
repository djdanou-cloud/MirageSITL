import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";

// TASK-140 (S04): the Components tab. A project with five cards and a quad X
// profile is seeded through the application's own store modules; the test then
// uploads a bench file and types values in, and the measured-input label
// appears only on the motors whose exact combination was measured.
type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
type Components = typeof import("../../packages/aircraft/src/components");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
};
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const BENCH = read("../fixtures/components/bench-combination.csv");

/** A project "Bench project" with a motor, two propellers, an ESC, a battery and a quad X profile, opened on the Components tab. */
async function seed(page: Page): Promise<void> {
  await page.goto("/");
  const texts = {
    motor: read("../fixtures/components/motor-example.json"), propeller: read("../fixtures/components/propeller-example.json"),
    esc: read("../fixtures/components/esc-example.json"), battery: read("../fixtures/components/battery-example.json"),
    profile: read("../fixtures/aircraft/quad-x.json"),
  };
  await page.evaluate(async ({ urls, texts }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDraft } = await import(urls.profile) as Profiles;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Bench project");
      const add = async (name: string, payload: unknown) =>
        (await store.createItem(project.record.id, "component-card", { name, payload })).sha256;
      const motor = await add("Example motor", JSON.parse(texts.motor));
      const propA = await add("Propeller A 10x4.5", JSON.parse(texts.propeller));
      const propellerB = JSON.parse(texts.propeller) as { model: string; values: { diameterM: number } };
      propellerB.model = "Example 9x4.5 propeller";
      propellerB.values.diameterM = 0.2286;
      const propB = await add("Propeller B 9x4.5", propellerB);
      const esc = await add("Example ESC", JSON.parse(texts.esc));
      const battery = await add("Example battery", JSON.parse(texts.battery));
      const profile = JSON.parse(texts.profile) as {
        motors: { id: number; components: { motor: string | null; propeller: string | null; esc: string | null } }[];
        battery: { card: string | null };
      };
      for (const item of profile.motors) item.components = { motor, propeller: item.id <= 2 ? propA : propB, esc };
      profile.battery.card = battery;
      await store.createItem(project.record.id, "aircraft-profile", profileDraft("Quad X", profile));
      await saveNavigation(store, { tab: "components", projectId: project.record.id });
    } finally {
      store.close();
    }
  }, { urls, texts });
  await page.reload();
}

async function expectLabels(profile: Locator, labels: readonly string[], aircraft: string): Promise<void> {
  for (const [index, label] of labels.entries()) await expect(profile.getByTestId(`motor-${index + 1}-label`)).toHaveText(label);
  await expect(profile.getByTestId("aircraft-label")).toHaveText(aircraft);
}

test("bench data binds only to its exact combination, and only there does the label change", async ({ page }) => {
  await seed(page);
  const panel = page.getByRole("tabpanel", { name: "Components", exact: true });
  await expect(panel.getByRole("list", { name: "Component cards" }).getByRole("listitem")).toHaveCount(5);
  const quad = panel.getByRole("region", { name: "Quad X" });
  await expect(quad.getByRole("radio", { name: "Preliminary calculation" })).toBeChecked();
  await expectLabels(quad, ["preliminary", "preliminary", "preliminary", "preliminary"], "preliminary");

  const form = panel.getByRole("form", { name: "New measurement set" }), status = panel.getByTestId("measurement-status");
  await form.getByLabel("Measurement set name").fill("Bench A");
  await form.getByLabel("Motor card").selectOption({ label: "Example motor" });
  await form.getByLabel("Propeller card").selectOption({ label: "Propeller A 10x4.5" });
  await form.getByLabel("ESC card").selectOption({ label: "Example ESC" });
  await form.getByLabel("Power supply").selectOption({ label: "Example battery" });
  // A file whose temperature was written in °C is refused, and nothing is stored.
  await form.getByLabel("Bench CSV file", { exact: true }).setInputFiles({
    name: "celsius.csv", mimeType: "text/csv", buffer: Buffer.from(BENCH.replace("airTemperatureK,293.15", "airTemperatureK,20")),
  });
  await expect(form.getByTestId("set-file-read")).toHaveText("Read celsius.csv.");
  await form.getByRole("button", { name: "Save measurement set" }).click();
  await expect(status).toContainText("airTemperatureK 20 is outside [233.15, 323.15] K");
  await expect(panel.getByText("No measurement sets yet.")).toBeVisible();
  // The bench file of combination A: motor, propeller A, ESC and battery.
  await form.getByLabel("Bench CSV file", { exact: true }).setInputFiles({ name: "bench-combination.csv", mimeType: "text/csv", buffer: Buffer.from(BENCH) });
  await expect(form.getByTestId("set-file-read")).toHaveText("Read bench-combination.csv.");
  await form.getByRole("button", { name: "Save measurement set" }).click();
  await expect(status).toHaveText("Saved measurement set Bench A: 7 points. Every quantity was measured.");

  // Propeller B on a laboratory power supply, typed in: speed and thrust only.
  await form.getByLabel("Measurement set name").fill("Bench B laboratory");
  await form.getByLabel("Propeller card").selectOption({ label: "Propeller B 9x4.5" });
  await form.getByLabel("Power supply").selectOption({ label: "Laboratory power supply" });
  await form.getByLabel("Enter values").check();
  await form.getByLabel("Air density (kg/m³)").fill("1.2");
  await form.getByLabel("Row 1 Speed (rpm)").fill("3000");
  await form.getByLabel("Row 1 Thrust (N)").fill("1.3");
  await form.getByLabel("Row 2 Speed (rpm)").fill("6000");
  await form.getByLabel("Row 2 Thrust (N)").fill("5.2");
  await form.getByRole("button", { name: "Save measurement set" }).click();
  await expect(status).toHaveText("Saved measurement set Bench B laboratory: 2 points. Not measured: torqueNm, voltageV, currentA, supplyVoltageV.");
  await expect(panel.getByRole("list", { name: "Measurement sets" }).getByRole("listitem")).toHaveCount(2);

  // Saving data changes no label; the profile's mode does, and only for combination A.
  await expectLabels(quad, ["preliminary", "preliminary", "preliminary", "preliminary"], "preliminary");
  await quad.getByRole("radio", { name: "Calculation from measurements" }).check();
  await expect(panel.getByTestId("calculation-status")).toHaveText("Saved version 2 of Quad X: Calculation from measurements, 1 measurement set bound.");
  await expectLabels(quad, ["measured-input", "measured-input", "preliminary", "preliminary"], "preliminary");
  await expect(quad.getByRole("listitem").filter({ hasText: "Motor 1" })).toContainText("Bench data covers 2000 to 8000 rpm");
  await expect(quad.getByRole("listitem").filter({ hasText: "Motor 3" })).toContainText("No measurement set of this combination is bound.");

  // The bound version survives a reload, and the populated tab fits a phone and passes axe.
  await page.reload();
  await expect(quad.getByRole("radio", { name: "Calculation from measurements" })).toBeChecked();
  await expectLabels(quad, ["measured-input", "measured-input", "preliminary", "preliminary"], "preliminary");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});

test("a card file is imported once, and the project's cards export as a card file", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  await page.getByLabel("New project name", { exact: true }).fill("Card library");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByTestId("current-project")).toHaveText("Card library");
  // A card file made by the application's own modules in a scratch database.
  const cards = await page.evaluate(async ({ urls, texts }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { exportComponentCards } = await import(urls.components) as Components;
    const store = await ProjectStore.openIndexedDb({ databaseName: "card-file-source" });
    try {
      const project = await store.createProject("Source");
      const versions = [];
      for (const [name, text] of texts) versions.push(await store.createItem(project.record.id, "component-card", { name, payload: JSON.parse(text) }));
      return [...await exportComponentCards(versions)];
    } finally {
      store.close();
    }
  }, {
    urls: { ...urls, components: viteFileUrl(new URL("../../packages/aircraft/src/components.ts", import.meta.url)) },
    texts: (["motor", "propeller", "esc", "battery"] as const).map(type => [`Example ${type}`, read(`../fixtures/components/${type}-example.json`)] as const),
  });
  await page.getByRole("tab", { name: "Components", exact: true }).click();
  const panel = page.getByRole("tabpanel", { name: "Components", exact: true }), status = panel.getByTestId("components-status");
  await expect(panel.getByText("The project has no component cards yet.")).toBeVisible();
  const file = { name: "examples.miragecards", mimeType: "application/json", buffer: Buffer.from(cards) };
  await panel.getByLabel("Import a card file", { exact: true }).setInputFiles(file);
  await expect(status).toHaveText("Imported examples.miragecards: 4 cards added, 0 already in the project.");
  await expect(panel.getByRole("list", { name: "Component cards" }).getByRole("listitem")).toHaveCount(4);
  await expect(panel.getByRole("list", { name: "Component cards" })).toContainText("Not known: hubDiameterM, chord, twist, airfoil.");
  await panel.getByLabel("Import a card file", { exact: true }).setInputFiles(file);
  await expect(status).toHaveText("Imported examples.miragecards: 0 cards added, 4 already in the project.");
  await expect(panel.getByRole("list", { name: "Component cards" }).getByRole("listitem")).toHaveCount(4);
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Export cards", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("Card library cards.miragecards");
  await expect(status).toHaveText("Exported 4 cards.");
});
