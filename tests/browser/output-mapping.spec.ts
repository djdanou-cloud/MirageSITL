import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { RECIPES } from "../support/aircraft-recipes";
import { build, createProject, group, panel } from "../support/aircraft-ui";
import { viteFileUrl } from "../support/vite-url";

// TASK-142 (S03): a 16-motor profile is built through the Aircraft tab alone,
// its outputs and frame are shown, and an output edited in the UI moves its
// motor's output function. The expected parameter files come from the
// package, evaluated in the page; tests/output-mapping.test.ts checks those
// against the parameter files TASK-128 flew.
type Frames = typeof import("../../packages/aircraft/src/frame-parameters");
type Profiles = typeof import("../../packages/aircraft/src/profile");
const urls = {
  frames: viteFileUrl(new URL("../../packages/aircraft/src/frame-parameters.ts", import.meta.url)),
  profiles: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
};
/** The parameter file of a fixture with its outputs replaced at the given motor indices. */
async function expectedFile(page: Page, fixture: string, outputs: Record<number, number> = {}): Promise<string> {
  const fixtureText = readFileSync(new URL(`../fixtures/aircraft/${fixture}.json`, import.meta.url), "utf8");
  return page.evaluate(async ({ urls, fixtureText, outputs }) => {
    const { frameConfiguration, parameterFileText } = await import(urls.frames) as Frames;
    const { validateAircraftProfile } = await import(urls.profiles) as Profiles;
    const profile = validateAircraftProfile(JSON.parse(fixtureText));
    const motors = profile.motors.map((motor, i) => ({ ...motor, output: outputs[i] ?? motor.output }));
    const config = frameConfiguration(validateAircraftProfile({ ...profile, motors }));
    if (!config.ok) throw new Error("The fixture cannot be configured");
    return parameterFileText(config.parameters);
  }, { urls, fixtureText, outputs });
}

test("a 16-motor profile maps every motor to an output and follows an edited output", async ({ page }) => {
  const recipe = RECIPES.find(item => item.fixture === "octa-coaxial-16")!;
  await page.goto("/");
  await createProject(page, "Output mapping");
  await build(page, recipe);
  const tab = panel(page), mapping = tab.getByTestId("output-mapping");
  await expect(mapping).toHaveAttribute("data-kind", "stock-scripting");
  await expect(tab.getByTestId("mapping-frame")).toHaveText("Stock scripting matrix: FRAME_CLASS 15, FRAME_TYPE 1, 32-channel servo packets.");
  const rows = tab.getByRole("table", { name: "Motor outputs" }).getByRole("row");
  await expect(rows).toHaveCount(17);
  await expect(rows.nth(16)).toHaveText(["16", "8 lower", "Counter-clockwise", "Motor 16", "SERVO16", "163"].join(""));
  await expect(tab.getByTestId("mapping-parameters")).toHaveText(await expectedFile(page, "octa-coaxial-16"));
  await expect(tab.getByTestId("mapping-script")).toContainText("assert(MotorsMatrix:init(16)");
  await expect(tab.getByRole("list", { name: "Frame notes" })).toContainText("TASK-128 flew this layout as paired-16");
  // Saved: the parameters name the stored profile version.
  const sha = await tab.getByTestId("mapping-profile").textContent();
  expect(sha).toMatch(/^[0-9a-f]{12}$/);
  await expect(tab.getByTestId("mapping-script")).toContainText(`aircraft profile ${sha}`);

  // Swap the outputs of motors 1 and 9 (arm 1 upper and lower) in the arm table.
  await group(tab, "Arm 1 upper motor").getByLabel("ArduPilot output", { exact: true }).fill("9");
  await expect(tab.getByRole("list", { name: "Problems to fix before saving" })).toContainText("Output 9 is assigned to motors 1 and 9");
  await group(tab, "Arm 1 lower motor").getByLabel("ArduPilot output", { exact: true }).fill("1");
  await expect(tab.getByRole("list", { name: "Problems to fix before saving" })).toHaveCount(0);
  await expect(tab.getByTestId("mapping-parameters")).toHaveText(await expectedFile(page, "octa-coaxial-16", { 0: 9, 8: 1 }));
  await expect(tab.getByTestId("mapping-parameters")).toContainText("SERVO1_FUNCTION 82\n");
  await expect(tab.getByTestId("mapping-parameters")).toContainText("SERVO9_FUNCTION 33\n");
  await expect(mapping).toContainText("Unsaved changes: save the profile to bind these parameters to a version.");
  await tab.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Saved version 2 of ${recipe.name}.`);
  await expect(tab.getByTestId("mapping-profile")).not.toHaveText(sha!);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});

test("a stock frame shows its stock motor numbers, and a layout that cannot be controlled shows why", async ({ page }) => {
  const recipe = RECIPES.find(item => item.fixture === "hexa-x")!;
  await page.goto("/");
  await createProject(page, "Stock frame");
  await build(page, recipe);
  const tab = panel(page);
  await expect(tab.getByTestId("output-mapping")).toHaveAttribute("data-kind", "stock");
  await expect(tab.getByTestId("mapping-frame")).toHaveText("Stock frame: FRAME_CLASS 2, FRAME_TYPE 1, 16-channel servo packets.");
  await expect(tab.getByTestId("mapping-parameters")).toHaveText(await expectedFile(page, "hexa-x"));
  await expect(tab.getByTestId("mapping-script")).toHaveCount(0);
  // Every motor turning the same way leaves no yaw authority.
  for (const arm of [2, 4, 6]) await group(tab, `Arm ${arm} motor`).getByLabel("Spin", { exact: true }).selectOption({ label: "Counter-clockwise" });
  await expect(tab.getByTestId("output-mapping")).toHaveAttribute("data-kind", "refused");
  await expect(tab.getByRole("list", { name: "Why this layout cannot be configured" })).toContainText("Every motor turns the same way");
  await expect(tab.getByTestId("mapping-parameters")).toHaveCount(0);
});
