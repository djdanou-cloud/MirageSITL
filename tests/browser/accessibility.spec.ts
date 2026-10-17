import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("keyboard landmarks, 390px layout and automated accessibility scan", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to flight controls" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});
test("Serial denial is announced once and keyboard focus returns to its trigger", async ({ page }) => {
  await page.addInitScript(() => {
    let requests = 0;
    Object.defineProperty(navigator, "serial", { value: { requestPort: () => { requests++; Reflect.set(window, "permissionRequests", requests); return Promise.reject(new DOMException("Permission denied", "NotAllowedError")); } } });
  });
  await page.goto("/");
  const connect = page.getByRole("button", { name: "Connect serial", exact: true });
  await connect.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("serial-status")).toContainText(/denied|failed|cancelled/i);
  await expect(connect).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, "permissionRequests") as unknown)).toBe(1);
});
