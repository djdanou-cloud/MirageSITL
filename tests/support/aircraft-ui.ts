import { expect, type Locator, type Page } from "@playwright/test";
import type { MassText, Recipe } from "./aircraft-recipes";

// TASK-141: types an aircraft recipe into the Aircraft tab, as a user would.
// Shared by the aircraft editor (TASK-141), output mapping (TASK-142) and
// nominal flight acceptance (TASK-158) specs.

export async function createProject(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  await page.getByLabel("New project name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByTestId("current-project")).toHaveText(name);
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
}
export const panel = (page: Page) => page.getByRole("tabpanel", { name: "Aircraft", exact: true });
export const group = (scope: Locator, name: string) => scope.getByRole("group", { name, exact: true });

async function fillMass(scope: Locator, title: string, mass: MassText): Promise<void> {
  await scope.getByLabel(`${title} mass (kg)`, { exact: true }).fill(mass.massKg);
  for (const [i, axis] of ["x", "y", "z"].entries()) await scope.getByLabel(`${title} CG ${axis} (m)`, { exact: true }).fill(mass.cg[i]!);
  for (const [i, symbol] of ["Ixx", "Iyy", "Izz", "Ixy", "Ixz", "Iyz"].entries()) {
    await scope.getByLabel(`${title} ${symbol} (kg·m²)`, { exact: true }).fill(mass.inertia[i]!);
  }
}

/** Types a recipe into the Aircraft tab and saves it; `beforeSave` adds what a recipe leaves out, such as the cards (TASK-158). */
export async function build(page: Page, recipe: Recipe, beforeSave?: (tab: Locator) => Promise<void>): Promise<void> {
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
  if (beforeSave) await beforeSave(tab);
  await expect(tab.getByRole("list", { name: "Problems to fix before saving" })).toHaveCount(0);
  await tab.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Created ${recipe.name}.`);
}
