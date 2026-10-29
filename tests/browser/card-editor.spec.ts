import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";
import { RECIPES, type MassText } from "../support/aircraft-recipes";

// TASK-192 (S04): the component-card editor. One card of each type is made
// through the UI alone, compared with the card written out here, and used in
// an aircraft profile and a measurement set; a new version of the motor card
// leaves both on the version they reference. The example cards open and save
// to their exact bytes, and the propeller's BET preview is the geometry that
// derivePropellerGeometry gives for the stored card.
type Store = typeof import("../../packages/project/src/store");
type Geometry = typeof import("../../packages/aircraft/src/propeller-geometry");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  geometry: viteFileUrl(new URL("../../packages/aircraft/src/propeller-geometry.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
};
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const radians = (deg: number) => (deg * Math.PI) / 180;

/** The bytes of a blade scan; the editor stores only their SHA-256. */
const SCAN = Buffer.from("station,r_over_R,angle_deg\n1,0.2,20\n2,0.6,12\n3,1,6\n");
const SCAN_SHA256 = createHash("sha256").update(SCAN).digest("hex");
const source = (id: string, description: string) => ({ id, kind: "specification", description, sha256: null, date: null });
const EXPECTED = {
  motor: {
    schemaVersion: 1, units: "SI", type: "motor", example: false, manufacturer: "Test motors", model: "2814 700 KV",
    sources: [source("datasheet", "Manufacturer datasheet, 2026 edition.")],
    values: { kvRpmPerV: 700, resistanceOhm: null, noLoadCurrentA: 0.5, noLoadVoltageV: 10, maxCurrentA: null, maxPowerW: null, massKg: 0.105 },
    provenance: { kvRpmPerV: "datasheet", resistanceOhm: null, noLoadCurrentA: "datasheet", noLoadVoltageV: "datasheet", maxCurrentA: null, maxPowerW: null, massKg: "datasheet" },
    applicability: null,
  },
  propeller: {
    schemaVersion: 1, units: "SI", type: "propeller", example: false, manufacturer: null, model: "10x4.5 scanned",
    sources: [
      source("datasheet", "Manufacturer page."),
      { id: "scan", kind: "measured", description: "Optical blade scan.", sha256: SCAN_SHA256, date: "2026-10-01" },
    ],
    values: {
      diameterM: 0.254, pitchM: 0.1143, bladeCount: 2, hubDiameterM: null, massKg: null, chord: null,
      twist: { radiusRatio: [0.2, 0.6, 1], angleRad: [radians(20), radians(12), radians(6)] }, airfoil: "Clark Y",
    },
    provenance: { diameterM: "datasheet", pitchM: "datasheet", bladeCount: "datasheet", hubDiameterM: null, massKg: null, chord: null, twist: "scan", airfoil: "datasheet" },
    applicability: "Static thrust only.",
  },
  esc: {
    schemaVersion: 1, units: "SI", type: "esc", example: false, manufacturer: null, model: null,
    sources: [source("datasheet", "Shop listing.")],
    values: { maxCurrentA: 30, updateRateHz: null, maxVoltageV: null, massKg: null },
    provenance: { maxCurrentA: "datasheet", updateRateHz: null, maxVoltageV: null, massKg: null },
    applicability: null,
  },
  battery: {
    schemaVersion: 1, units: "SI", type: "battery", example: false, manufacturer: null, model: null,
    sources: [source("datasheet", "Pack label.")],
    values: { cellsSeries: 4, capacityAh: 5, internalResistanceOhm: null, cellFullV: 4.2, cellEmptyV: 3.3, maxDischargeCurrentA: null, massKg: null },
    provenance: { cellsSeries: "datasheet", capacityAh: "datasheet", internalResistanceOhm: null, cellFullV: "datasheet", cellEmptyV: "datasheet", maxDischargeCurrentA: null, massKg: null },
    applicability: null,
  },
} as const;

const tabPanel = (page: Page, name: string) => page.getByRole("tabpanel", { name, exact: true });
const label = (scope: Locator, text: string) => scope.getByLabel(text, { exact: true });
async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  await label(page.locator("body"), "New project name").fill(name);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByTestId("current-project")).toHaveText(name);
  await page.getByRole("tab", { name: "Components", exact: true }).click();
}
async function newCard(panel: Locator, type: string, name: string, description: string): Promise<void> {
  await label(panel, "Type of a new card").selectOption({ label: type });
  await panel.getByRole("button", { name: "New card", exact: true }).click();
  await label(panel, "Card name").fill(name);
  await label(panel, "Source 1 description").fill(description);
}
/** Marks a value known and types it; with one source the value cites it. */
async function known(panel: Locator, field: string, text: string): Promise<void> {
  await label(panel, `${field} is known`).check();
  await label(panel, field).fill(text);
}
async function save(panel: Locator, message: string): Promise<void> {
  await expect(panel.getByRole("list", { name: "Problems to fix before saving the card" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Save card", exact: true }).click();
  await expect(panel.getByTestId("card-status")).toHaveText(message);
}

interface StoredItem { sha256: string; id: string; version: number; payload: unknown }
/** Every stored version of the open project's items of a kind, by name, oldest first. */
async function stored(page: Page, kind: "component-card" | "aircraft-profile" | "measurement-set"): Promise<Record<string, StoredItem[]>> {
  return page.evaluate(async ({ urls, kind }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      const result: Record<string, StoredItem[]> = {};
      for (const project of await store.listProjects()) {
        for (const head of await store.listItems(project.record.id, kind)) {
          result[head.record.name] = (await store.history(head.record.id)).map(version => ({
            sha256: version.sha256, id: version.record.id, version: version.record.version, payload: JSON.parse(JSON.stringify(version.record.payload)) as unknown,
          }));
        }
      }
      return result;
    } finally {
      store.close();
    }
  }, { urls, kind });
}
/** The geometry derivePropellerGeometry gives for a card, computed in the page. */
async function geometryOf(page: Page, card: unknown): Promise<unknown> {
  return page.evaluate(async ({ urls, card }) => {
    const { derivePropellerGeometry } = await import(urls.geometry) as Geometry;
    return JSON.parse(JSON.stringify(derivePropellerGeometry(card))) as unknown;
  }, { urls, card });
}
async function fillMass(scope: Locator, mass: MassText): Promise<void> {
  await label(scope, "Aircraft mass (kg)").fill(mass.massKg);
  for (const [i, axis] of ["x", "y", "z"].entries()) await label(scope, `Aircraft CG ${axis} (m)`).fill(mass.cg[i]!);
  for (const [i, symbol] of ["Ixx", "Iyy", "Izz", "Ixy", "Ixz", "Iyz"].entries()) await label(scope, `Aircraft ${symbol} (kg·m²)`).fill(mass.inertia[i]!);
}

test("one card of each type is made through the UI, used by a profile and a measurement set, and edited into a new version", async ({ page }) => {
  // About 200 UI steps across three forms.
  test.setTimeout(60_000);
  await page.goto("/");
  await createProject(page, "Card editor");
  const panel = tabPanel(page, "Components"), problems = panel.getByRole("list", { name: "Problems to fix before saving the card" });
  const saveButton = panel.getByRole("button", { name: "Save card", exact: true });
  await expect(panel.getByText("The project has no component cards yet. Create a card or import a card file to add some.")).toBeVisible();

  // Motor: a new card starts with KV to fill and its source to describe.
  await label(panel, "Type of a new card").selectOption({ label: "Motor" });
  await panel.getByRole("button", { name: "New card", exact: true }).click();
  await expect(problems).toContainText("Give the card a name");
  await expect(problems).toContainText("Source datasheet needs a description");
  await expect(problems).toContainText("KV (rpm/V) is not a decimal number");
  await expect(saveButton).toBeDisabled();
  await label(panel, "Card name").fill("Bench motor 2814");
  await label(panel, "Manufacturer (optional)").fill("Test motors");
  await label(panel, "Model (optional)").fill("2814 700 KV");
  await label(panel, "Source 1 description").fill("Manufacturer datasheet, 2026 edition.");
  await label(panel, "KV (rpm/V)").fill("700");
  await known(panel, "No-load current (A)", "0.5");
  await expect(problems).toContainText("The no-load current and its test voltage must both be known or both be missing");
  await known(panel, "No-load test voltage (V)", "10");
  await known(panel, "Mass (kg)", "0.105");
  await save(panel, "Created Bench motor 2814.");

  // Propeller: a range error, a measured source without its hash and date, and a value without a source are refused.
  await newCard(panel, "Propeller", "Scanned 10x4.5", "Manufacturer page.");
  await label(panel, "Model (optional)").fill("10x4.5 scanned");
  await label(panel, "Diameter (m)").fill("25");
  await label(panel, "Pitch (m)").fill("0.1143");
  await label(panel, "Blades").fill("2");
  await expect(problems).toContainText("Diameter (m) must be <= 20");
  await label(panel, "Diameter (m)").fill("0.254");
  await panel.getByRole("button", { name: "Add source", exact: true }).click();
  await label(panel, "Source 2 ID").fill("scan");
  await label(panel, "Source 2 kind").selectOption({ label: "Own measurement" });
  await label(panel, "Source 2 description").fill("Optical blade scan.");
  await label(panel, "Twist distribution is known").check();
  await label(panel, "Source of Twist distribution").selectOption({ label: "scan" });
  await panel.getByRole("button", { name: "Add twist distribution row", exact: true }).click();
  for (const [i, [ratio, deg]] of [["0.2", "20"], ["0.6", "12"], ["1", "6"]].entries()) {
    await label(panel, `Twist distribution row ${i + 1} r/R`).fill(ratio!);
    await label(panel, `Twist distribution row ${i + 1} angle`).fill(deg!);
  }
  await expect(problems).toHaveText("Measured source scan needs the SHA-256 and the date of its data");
  await expect(saveButton).toBeDisabled();
  await label(panel, "Source 2 SHA-256 from a file").setInputFiles({ name: "scan.csv", mimeType: "text/csv", buffer: SCAN });
  await expect(label(panel, "Source 2 SHA-256 (optional)")).toHaveValue(SCAN_SHA256);
  await expect(panel.getByTestId("card-status")).toHaveText("Computed the SHA-256 of scan.csv for source 2; the file itself is not stored.");
  await label(panel, "Source 2 date (optional)").fill("2026-10-01");
  // With two sources, a value made known has no source until one is chosen.
  await label(panel, "Airfoil is known").check();
  await label(panel, "Airfoil").fill("Clark Y");
  await expect(problems).toHaveText("Airfoil needs a source");
  await label(panel, "Source of Airfoil").selectOption({ label: "datasheet" });
  // The measurement form has a field of the same name; this one is the card's.
  const editor = panel.getByRole("region").filter({ has: page.getByLabel("Card name", { exact: true }) });
  await label(editor, "Limits of use (optional)").fill("Static thrust only.");
  await save(panel, "Created Scanned 10x4.5.");

  await newCard(panel, "ESC", "Bench ESC", "Shop listing.");
  await label(panel, "Maximum current (A)").fill("30");
  await save(panel, "Created Bench ESC.");
  await newCard(panel, "Battery", "Bench pack", "Pack label.");
  await label(panel, "Cells in series").fill("4");
  await label(panel, "Capacity (Ah)").fill("5");
  await known(panel, "Full cell voltage (V)", "4.2");
  await known(panel, "Empty cell voltage (V)", "4.3");
  await expect(problems).toHaveText("The full cell voltage must be above the empty cell voltage");
  await label(panel, "Empty cell voltage (V)").fill("3.3");
  await save(panel, "Created Bench pack.");

  // The stored cards are the cards written out above, and the preview is the stored propeller's geometry.
  const cards = await stored(page, "component-card");
  expect(Object.keys(cards).sort()).toEqual(["Bench ESC", "Bench motor 2814", "Bench pack", "Scanned 10x4.5"]);
  expect(cards["Bench motor 2814"]?.map(item => item.payload)).toEqual([EXPECTED.motor]);
  expect(cards["Scanned 10x4.5"]?.map(item => item.payload)).toEqual([EXPECTED.propeller]);
  expect(cards["Bench ESC"]?.map(item => item.payload)).toEqual([EXPECTED.esc]);
  expect(cards["Bench pack"]?.map(item => item.payload)).toEqual([EXPECTED.battery]);
  await panel.getByRole("button", { name: "Edit Scanned 10x4.5", exact: true }).click();
  const preview = panel.getByTestId("propeller-preview");
  expect(JSON.parse(await preview.getAttribute("data-geometry") ?? "null")).toEqual(await geometryOf(page, EXPECTED.propeller));
  await expect(panel.getByRole("list", { name: "Geometry validity flags" })).toContainText("The chord is assumed, not given.");
  await panel.getByRole("button", { name: "Close the card", exact: true }).click();

  // An aircraft profile uses the four cards; the Aircraft tab lists them without a reload.
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
  const aircraft = tabPanel(page, "Aircraft");
  await aircraft.getByRole("button", { name: "New profile", exact: true }).click();
  await label(aircraft, "Profile name").fill("Quad");
  await label(aircraft, "Number of arms").fill("4");
  await label(aircraft, "Arm length (m)").fill("0.225");
  await label(aircraft, "First arm azimuth (°)").fill("45");
  await aircraft.getByRole("button", { name: "Lay out arms", exact: true }).click();
  await fillMass(aircraft, RECIPES[0]!.mass);
  await label(aircraft, "Motor card for every motor").selectOption({ label: "Bench motor 2814" });
  await label(aircraft, "Propeller card for every motor").selectOption({ label: "Scanned 10x4.5" });
  await label(aircraft, "ESC card for every motor").selectOption({ label: "Bench ESC" });
  await aircraft.getByRole("button", { name: "Apply to every motor", exact: true }).click();
  await label(aircraft, "Battery card").selectOption({ label: "Bench pack" });
  await aircraft.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(aircraft.getByTestId("aircraft-status")).toHaveText("Created Quad.");

  // A measurement set of the same combination, typed in. Back on the Components tab, the new profile is listed without a reload.
  await page.getByRole("tab", { name: "Components", exact: true }).click();
  await expect(panel.getByRole("region", { name: "Quad", exact: true })).toBeVisible();
  const form = panel.getByRole("form", { name: "New measurement set" });
  await label(form, "Measurement set name").fill("Bench run");
  await label(form, "Motor card").selectOption({ label: "Bench motor 2814" });
  await label(form, "Propeller card").selectOption({ label: "Scanned 10x4.5" });
  await label(form, "ESC card").selectOption({ label: "Bench ESC" });
  await label(form, "Power supply").selectOption({ label: "Bench pack" });
  await label(form, "Enter values").check();
  await label(form, "Air density (kg/m³)").fill("1.2");
  await label(form, "Row 1 Speed (rpm)").fill("3000");
  await label(form, "Row 1 Thrust (N)").fill("1");
  await label(form, "Row 2 Speed (rpm)").fill("6000");
  await label(form, "Row 2 Thrust (N)").fill("4");
  await form.getByRole("button", { name: "Save measurement set" }).click();
  await expect(panel.getByTestId("measurement-status")).toHaveText("Saved measurement set Bench run: 2 points. Not measured: torqueNm, voltageV, currentA, supplyVoltageV.");

  // A new motor version: the old version stays as it was, and the profile and the set keep referencing it.
  await panel.getByRole("button", { name: "Edit Bench motor 2814", exact: true }).click();
  await expect(saveButton).toBeDisabled();
  await label(panel, "KV (rpm/V)").fill("720");
  // Another card cannot be opened over unsaved changes.
  await expect(panel.getByRole("button", { name: "Edit Bench ESC", exact: true })).toBeDisabled();
  await save(panel, "Saved version 2 of Bench motor 2814. Profiles and measurement sets keep the version they reference.");
  const motor = (await stored(page, "component-card"))["Bench motor 2814"] ?? [];
  expect(motor.map(item => item.version)).toEqual([1, 2]);
  expect(motor[0]).toEqual(cards["Bench motor 2814"]?.[0]);
  expect(motor[1]?.payload).toEqual({ ...EXPECTED.motor, values: { ...EXPECTED.motor.values, kvRpmPerV: 720 } });
  const v1 = motor[0]!.sha256, ids = Object.fromEntries(Object.entries(cards).map(([name, versions]) => [name, versions[0]!.sha256]));
  const profiles = await stored(page, "aircraft-profile");
  const profile = profiles.Quad?.at(-1)?.payload as { motors: { components: unknown }[]; battery: { card: string } };
  expect(profiles.Quad).toHaveLength(1);
  expect(profile.motors.map(item => item.components)).toEqual(Array.from({ length: 4 }, () => ({ motor: v1, propeller: ids["Scanned 10x4.5"], esc: ids["Bench ESC"] })));
  expect(profile.battery.card).toBe(ids["Bench pack"]);
  const sets = await stored(page, "measurement-set");
  expect((sets["Bench run"]?.at(-1)?.payload as { combination: unknown }).combination).toEqual({
    motor: v1, propeller: ids["Scanned 10x4.5"], esc: ids["Bench ESC"], supply: { kind: "battery", card: ids["Bench pack"] },
  });

  // A stored twist opens in degrees; a retyped angle replaces its radians, the others keep theirs.
  await panel.getByRole("button", { name: "Edit Scanned 10x4.5", exact: true }).click();
  await expect(label(panel, "Twist distribution row 2 angle")).toHaveValue("12");
  await label(panel, "Twist distribution row 2 angle").fill("3");
  await save(panel, "Saved version 2 of Scanned 10x4.5. Profiles and measurement sets keep the version they reference.");
  const propeller = (await stored(page, "component-card"))["Scanned 10x4.5"] ?? [];
  expect(propeller.map(item => item.payload)).toEqual([
    EXPECTED.propeller,
    { ...EXPECTED.propeller, values: { ...EXPECTED.propeller.values, twist: { radiusRatio: [0.2, 0.6, 1], angleRad: [radians(20), radians(3), radians(6)] } } },
  ]);
  const preview2 = JSON.parse(await panel.getByTestId("propeller-preview").getAttribute("data-geometry") ?? "null") as unknown;
  expect(preview2).toEqual(await geometryOf(page, propeller[1]?.payload));
});

test("the example cards open and save to their exact bytes; a copy leaves the original unchanged", async ({ page }) => {
  await page.goto("/");
  const names = ["Example motor", "Example propeller", "Example ESC", "Example battery"];
  const texts = (["motor", "propeller", "esc", "battery"] as const).map(type => read(`../fixtures/components/${type}-example.json`));
  await page.evaluate(async ({ urls, names, texts }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Examples");
      for (const [i, name] of names.entries()) await store.createItem(project.record.id, "component-card", { name, payload: JSON.parse(texts[i]!) as unknown });
      await saveNavigation(store, { tab: "components", projectId: project.record.id });
    } finally {
      store.close();
    }
  }, { urls, names, texts });
  await page.reload();
  const panel = tabPanel(page, "Components"), saveButton = panel.getByRole("button", { name: "Save card", exact: true });
  const before = await stored(page, "component-card");
  // Each card opens unchanged; a value retyped to the same number saves no new version.
  for (const [name, field, text] of [
    ["Example motor", "KV (rpm/V)", "700.0"], ["Example propeller", "Diameter (m)", "0.2540"],
    ["Example ESC", "Maximum current (A)", "3e1"], ["Example battery", "Cells in series", "4.0"],
  ] as const) {
    await panel.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
    await expect(label(panel, "Card name")).toHaveValue(name);
    await expect(saveButton).toBeDisabled();
    await label(panel, field).fill(text);
    await save(panel, "Nothing changed, so no version was saved.");
    await panel.getByRole("button", { name: "Close the card", exact: true }).click();
  }
  expect(await stored(page, "component-card")).toEqual(before);

  // The example propeller's geometry rests on the listed assumptions.
  await panel.getByRole("button", { name: "Edit Example propeller", exact: true }).click();
  const preview = panel.getByTestId("propeller-preview");
  expect(JSON.parse(await preview.getAttribute("data-geometry") ?? "null")).toEqual(await geometryOf(page, JSON.parse(texts[1]!)));
  await expect(panel.getByRole("list", { name: "Geometry assumptions" }).getByRole("listitem")).toHaveCount(6);
  // Twist angles are typed in degrees.
  await label(panel, "Twist distribution is known").check();
  await expect(label(panel, "Source of Twist distribution")).toHaveValue("0");
  await label(panel, "Twist distribution row 1 r/R").fill("0.3");
  await label(panel, "Twist distribution row 1 angle").fill("95");
  await label(panel, "Twist distribution row 2 r/R").fill("1");
  await label(panel, "Twist distribution row 2 angle").fill("5");
  await expect(panel.getByRole("list", { name: "Problems to fix before saving the card" })).toHaveText("Twist distribution row 1 angle must be between -90° and 90°");
  await expect(panel.getByText("The geometry appears once the card is valid.")).toBeVisible();
  await panel.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(label(panel, "Twist distribution is known")).not.toBeChecked();

  await label(panel, "Copy as").fill("My propeller");
  await panel.getByRole("button", { name: "Copy card", exact: true }).click();
  await expect(panel.getByTestId("card-status")).toHaveText("Copied Example propeller to My propeller; the original is unchanged.");
  const after = await stored(page, "component-card");
  expect(after["Example propeller"]).toEqual(before["Example propeller"]);
  expect(after["My propeller"]?.map(item => item.payload)).toEqual([JSON.parse(texts[1]!)]);
  // A new name alone is a change: it saves a version with the same card.
  await panel.getByRole("button", { name: "Edit My propeller", exact: true }).click();
  await label(panel, "Card name").fill("My propeller 10x4.5");
  await save(panel, "Saved version 2 of My propeller 10x4.5. Profiles and measurement sets keep the version they reference.");
  expect((await stored(page, "component-card"))["My propeller 10x4.5"]?.map(item => item.payload)).toEqual([JSON.parse(texts[1]!), JSON.parse(texts[1]!)]);

  // The open editor fits a phone and passes axe.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});
