import { expect, test } from "@playwright/test";
test("HUD labels demo/EKF provenance while physics ticks advance", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("hud-ap-status")).toContainText("EKF UNKNOWN");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .poll(async () =>
      Number((await page.getByTestId("tick").innerText()).split(" ")[0]),
    )
    .toBeGreaterThan(20);
  await expect(page.getByRole("img", { name: /Roll.*pitch/ })).toBeVisible();
  await expect(page.getByTestId("hud-ap-status")).toContainText(
    "ArduPilot disconnected",
  );
});
