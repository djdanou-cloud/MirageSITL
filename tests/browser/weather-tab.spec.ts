import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";

// TASK-167 (S07): the weather of the Weather and location tab through the UI alone, without a run: the controls refuse what is outside
// their ranges and name the problem, the schedule holds what is added with its values and seeds, survives a reload, and is the TASK-167
// weather schedule with this build's random streams; Apply now waits for a run. The run itself is tests/browser/weather-sitl.spec.ts.
type Store = typeof import("../../packages/project/src/store");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
type Schedules = typeof import("../../packages/scenarios/src/weather-schedule");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
  schedules: viteFileUrl(new URL("../../packages/scenarios/src/weather-schedule.ts", import.meta.url)),
};

async function seed(page: Page): Promise<string> {
  await page.goto("/");
  const projectId = await page.evaluate(async ({ urls }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Weather project");
      await saveNavigation(store, { tab: "weather", projectId: project.record.id });
      return project.record.id;
    } finally {
      store.close();
    }
  }, { urls });
  await page.reload();
  return projectId;
}
/** The stored schedule of the project, parsed as a run would read it. */
async function storedSchedule(page: Page, projectId: string) {
  return page.evaluate(async ({ urls, key }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { parseWeatherSchedule } = await import(urls.schedules) as Schedules;
    const store = await ProjectStore.openIndexedDb();
    try {
      return JSON.parse(JSON.stringify(parseWeatherSchedule(await store.readSetting(key)))) as unknown;
    } finally {
      store.close();
    }
  }, { urls, key: `weather-schedule.p${projectId.replaceAll("-", "").slice(0, 31)}` });
}

test("the weather is set through the UI, scheduled with its values and seeds, and the schedule survives a reload", async ({ page }) => {
  test.setTimeout(60_000);
  const projectId = await seed(page);
  const panel = page.getByRole("tabpanel", { name: "Weather and location", exact: true }).getByTestId("weather-panel");
  await expect(panel.getByTestId("weather-no-run")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Apply the steady wind now" })).toBeDisabled();
  await expect(panel.getByTestId("weather-schedule-empty")).toHaveText("No weather is scheduled.");
  await expect(panel.getByTestId("weather-now").locator("li")).toHaveText(["Steady wind: off", "Synthetic gust: off", "Discrete gust: off", "Turbulence: off", "Air at the ground: off"]);

  // A steady wind of 6 m/s from the west, from arming on.
  await panel.getByLabel("Speed, m/s", { exact: true }).fill("6");
  await panel.getByLabel("From, ° (bearing)", { exact: true }).fill("270");
  await panel.getByLabel("Onset, s after arming", { exact: true }).fill("0");
  await panel.getByRole("button", { name: "Add the steady wind to the schedule" }).click();
  // A discrete gust 12 s after arming; a bad amplitude first names its problem and adds nothing.
  await panel.getByLabel("Amplitude, m/s", { exact: true }).fill("60");
  await panel.getByLabel("Onset, s after arming", { exact: true }).fill("12");
  await panel.getByLabel("Duration, s (empty: until the run ends)", { exact: true }).fill("4");
  await panel.getByRole("button", { name: "Add the discrete gust to the schedule" }).click();
  await expect(panel.getByTestId("weather-refusal")).toHaveText("Gust amplitude must be a number from 0 to 50");
  await panel.getByLabel("Amplitude, m/s", { exact: true }).fill("7");
  await panel.getByLabel("Duration, s", { exact: true }).fill("3");
  await panel.getByLabel("Gust from, ° (bearing)", { exact: true }).fill("90");
  await panel.getByLabel("Upward angle, °", { exact: true }).fill("5");
  await panel.getByRole("button", { name: "Add the discrete gust to the schedule" }).click();
  await expect(panel.getByTestId("weather-refusal")).toHaveCount(0);
  // Turbulence with a fresh seed, from arming on.
  await panel.getByRole("button", { name: "New turbulence seed" }).click();
  const seedText = await panel.getByLabel("Turbulence seed", { exact: true }).inputValue();
  expect(Number(seedText)).toBeGreaterThanOrEqual(0);
  await panel.getByLabel("Onset, s after arming", { exact: true }).fill("0");
  await panel.getByLabel("Duration, s (empty: until the run ends)", { exact: true }).fill("");
  await panel.getByRole("button", { name: "Add the turbulence to the schedule" }).click();
  // Two steady winds at once cannot be: the second is refused.
  await panel.getByRole("button", { name: "Add the steady wind to the schedule" }).click();
  await expect(panel.getByTestId("weather-refusal")).toContainText("overlaps entries[0] of wind.mean");

  const rows = panel.getByTestId("weather-schedule").locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Mean wind: 6.0 m/s from 270°");
  await expect(rows.nth(1)).toContainText("Discrete gust: 7.0 m/s from 90°, 5° upward, over 3.0 s");
  await expect(rows.nth(1)).toContainText("12");
  await expect(rows.nth(2)).toContainText(`Turbulence (Dryden): W20 7.7 m/s, seed ${seedText}`);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);

  // Stored as the run reads it: the weather schedule with this build's streams, seeds included.
  const stored = await storedSchedule(page, projectId) as { entries: { control: { effect: string; parameters: Record<string, unknown> }; onsetS: number; durationS: number | null }[]; streams: unknown };
  expect(stored.streams).toEqual({ gust: [0, 1, 2], turbulence: [0x00106001, 0x00106002, 0x00106003, 0x00106004, 0x00106005] });
  expect(stored.entries.map(entry => [entry.control.effect, entry.onsetS, entry.durationS])).toEqual([["wind.mean", 0, null], ["wind.discrete-gust", 12, 4], ["wind.turbulence", 0, null]]);
  expect(stored.entries[2]?.control.parameters).toEqual({ w20Mps: 7.7, seed: Number(seedText) });

  // After a reload the schedule is still there; one entry removed is gone from the store too.
  await page.reload();
  const again = page.getByRole("tabpanel", { name: "Weather and location", exact: true }).getByTestId("weather-panel");
  await expect(again.getByTestId("weather-schedule").locator("tbody tr")).toHaveCount(3);
  await again.getByRole("button", { name: "Remove Discrete gust: 7.0 m/s from 90°, 5° upward, over 3.0 s" }).click();
  await expect(again.getByTestId("weather-schedule").locator("tbody tr")).toHaveCount(2);
  const after = await storedSchedule(page, projectId) as { entries: { control: { effect: string } }[] };
  expect(after.entries.map(entry => entry.control.effect)).toEqual(["wind.mean", "wind.turbulence"]);
});
