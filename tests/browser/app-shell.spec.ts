import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// TASK-137 (S01): the application shell. Each test starts with an empty
// project store, so the shell opens the Run tab, which holds the existing
// synthetic demo.
const TABS = ["Project", "Aircraft", "Components", "Sensors", "Faults and interference", "Weather and location",
  "Flight tasks", "Parameters", "Logging", "Run", "Experiments", "Analysis"];
/** "Hexacopter trials", typed in Russian (escaped: source files outside docs/ru/ hold no Cyrillic). */
const HEXA = "\u{418}\u{441}\u{43f}\u{44b}\u{442}\u{430}\u{43d}\u{438}\u{44f} \u{433}\u{435}\u{43a}\u{441}\u{430}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440}\u{430}";
/** A long Russian project name ("Hexacopter trials — a long project name to check line wrapping on a narrow screen"). */
const LONG = `${HEXA} \u{2014} \u{434}\u{43b}\u{438}\u{43d}\u{43d}\u{43e}\u{435} \u{43d}\u{430}\u{437}\u{432}\u{430}\u{43d}\u{438}\u{435} \u{43f}\u{440}\u{43e}\u{435}\u{43a}\u{442}\u{430} \u{434}\u{43b}\u{44f} \u{43f}\u{440}\u{43e}\u{432}\u{435}\u{440}\u{43a}\u{438} \u{43f}\u{435}\u{440}\u{435}\u{43d}\u{43e}\u{441}\u{430} \u{441}\u{442}\u{440}\u{43e}\u{43a} \u{43d}\u{430} \u{443}\u{437}\u{43a}\u{43e}\u{43c} \u{44d}\u{43a}\u{440}\u{430}\u{43d}\u{435}`;

// Chromium on Linux converts a download's file name through the process
// locale and names the file "download" when the locale cannot hold it, as
// happens to Russian names under the C locale of minimal containers. A UTF-8
// locale keeps the exported file name checkable there; macOS always uses UTF-8.
test.use({
  launchOptions: async ({ launchOptions }, use) => {
    await use(process.platform === "linux" ? { ...launchOptions, env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } } : launchOptions);
  },
});

const tab = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });
const panel = (page: Page, name: string) => page.getByRole("tabpanel", { name, exact: true });

/**
 * The navigation in the project store's settings, read directly so that a
 * test reloads only after the shell's asynchronous save has landed.
 */
function storedNavigation(page: Page): Promise<unknown> {
  return page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open("mirage-project-store");
    // Never create the database here: the application owns its schema.
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => reject(request.error ?? new Error("The project store did not open"));
    request.onsuccess = () => {
      const database = request.result;
      const read = database.transaction("settings").objectStore("settings").get("shell.navigation");
      read.onsuccess = () => {
        database.close();
        resolve(read.result instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(read.result)) : null);
      };
      read.onerror = () => {
        database.close();
        reject(read.error ?? new Error("The navigation could not be read"));
      };
    };
  }));
}

async function createProject(page: Page, name: string): Promise<void> {
  await tab(page, "Project").click();
  await page.getByLabel("New project name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByTestId("current-project")).toHaveText(name);
}

test("a fresh profile opens the Run tab with the synthetic demo and no project", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Sections" }).getByRole("tab")).toHaveText(TABS);
  await expect(tab(page, "Run")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page, "Run")).toBeVisible();
  await expect(panel(page, "Run")).toContainText("Synthetic demo");
  await expect(page.getByRole("radio", { name: /Synthetic demo/ })).toBeChecked();
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
  await expect(page.getByTestId("current-project")).toHaveText("No project open");
  for (const name of TABS.filter(n => n !== "Run")) await expect(panel(page, name)).toBeHidden();
});

test("every tab is reachable with the keyboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
  await tab(page, "Run").focus();
  await page.keyboard.press("Home");
  for (const [index, name] of TABS.entries()) {
    await expect(tab(page, name)).toBeFocused();
    await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
    await expect(panel(page, name)).toBeVisible();
    if (index < TABS.length - 1) await page.keyboard.press("ArrowRight");
  }
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Project")).toBeFocused();
  await page.keyboard.press("End");
  await expect(tab(page, "Analysis")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "Experiments")).toBeFocused();
  // Only the selected tab is in the Tab order, and Tab moves on into its panel.
  await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(panel(page, "Experiments")).toBeFocused();
});

test("navigation and project context survive a reload", async ({ page }) => {
  await page.goto("/");
  await createProject(page, HEXA);
  await tab(page, "Aircraft").click();
  await expect(panel(page, "Aircraft")).toContainText(HEXA);
  await expect.poll(() => storedNavigation(page)).toEqual({ schemaVersion: 1, tab: "aircraft", projectId: expect.any(String) });
  await page.reload();
  await expect(tab(page, "Aircraft")).toHaveAttribute("aria-selected", "true");
  await expect(panel(page, "Aircraft")).toBeVisible();
  await expect(page.getByTestId("current-project")).toHaveText(HEXA);
  // The demo is still reachable, and it keeps working after the reload.
  await tab(page, "Run").click();
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});

test("the 3D view stops drawing while another tab is open, and the simulation keeps running", async ({ page }) => {
  // Counts the WebGL draw calls that reach the browser, an oracle outside the renderer.
  await page.addInitScript(() => {
    let draws = 0;
    for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      for (const name of ["drawArrays", "drawElements"]) {
        const original: unknown = Reflect.get(prototype, name);
        if (typeof original !== "function") continue;
        Reflect.set(prototype, name, new Proxy(original, {
          apply(target, thisArg: unknown, args: unknown[]) {
            draws++;
            Reflect.apply(target, thisArg, args);
          },
        }));
      }
    }
    Object.defineProperty(window, "drawCalls", { get: () => draws });
  });
  const drawCalls = async () => Number(await page.evaluate(() => Reflect.get(window, "drawCalls") as unknown));
  const ticks = async () => Number.parseInt(await page.getByTestId("tick").textContent() ?? "", 10);
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(drawCalls).toBeGreaterThan(0);
  await tab(page, "Project").click();
  await expect(panel(page, "Project")).toBeVisible();
  // A frame requested before the switch may still draw; two animation frames later none is pending.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const hiddenDraws = await drawCalls(), hiddenTicks = await ticks();
  // One second of simulation at 400 Hz passes while the view is hidden, without a draw call.
  await expect.poll(ticks).toBeGreaterThan(hiddenTicks + 400);
  expect(await drawCalls()).toBe(hiddenDraws);
  await tab(page, "Run").click();
  await expect.poll(drawCalls).toBeGreaterThan(hiddenDraws);
});

test("a project is renamed, exported, and imported here and into a fresh profile", async ({ page, browser, baseURL }) => {
  await page.goto("/");
  await createProject(page, HEXA);
  await page.getByLabel("Project name", { exact: true }).fill(`${HEXA} 2`);
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(page.getByTestId("current-project")).toHaveText(`${HEXA} 2`);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export project", exact: true }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toBe(`${HEXA} 2.mirageproj`);
  const file = await exported.path();
  const archive = readFileSync(file);
  await page.getByLabel("Import a project archive", { exact: true }).setInputFiles(file);
  await expect(page.getByTestId("project-status")).toContainText("2 records already stored");
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
  await page.getByLabel("Import a project archive", { exact: true })
    .setInputFiles({ name: "tampered.mirageproj", mimeType: "application/octet-stream", buffer: tampered });
  await expect(page.getByTestId("project-status")).toContainText("damaged or was changed");

  // Another browser profile stands in for another installation.
  const other = await browser.newContext({ baseURL });
  try {
    const second = await other.newPage();
    await second.goto("/");
    await tab(second, "Project").click();
    await second.getByLabel("Import a project archive", { exact: true })
      .setInputFiles({ name: "project.mirageproj", mimeType: "application/octet-stream", buffer: archive });
    await expect(second.getByTestId("project-status")).toContainText("2 records added");
    await expect(second.getByTestId("current-project")).toHaveText(`${HEXA} 2`);
  } finally {
    await other.close();
  }
});

test("every tab fits 390 px without horizontal overflow and has no axe violations", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
  await createProject(page, LONG);
  for (const name of TABS) {
    await tab(page, name).click();
    await expect(panel(page, name)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name).toBe(true);
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map(v => ({ tab: name, id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  }
});
