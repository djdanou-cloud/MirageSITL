import { expect, test } from "@playwright/test";
test("saves channel calibration and a six-slot mode axis and restores them on reload", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "getGamepads", {
      value: () => [
        {
          connected: true,
          index: 0,
          id: "radio-test",
          axes: [0, 0, -1, 0, -1, -1],
          buttons: [],
          timestamp: 0,
          mapping: "",
        },
      ],
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("READY");
  await page.getByRole("button", { name: "USB / EdgeTX", exact: true }).click();
  await page.getByText("USB channels / calibration", { exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "roll min", exact: true })
    .fill("-0.9");
  await page
    .getByRole("checkbox", { name: "Enable mode channel", exact: true })
    .check();
  await page.getByText("Mode channel calibration", { exact: true }).click();
  await page
    .getByRole("spinbutton", { name: "mode axis", exact: true })
    .fill("5");
  await page.reload();
  await page.getByRole("button", { name: "USB / EdgeTX", exact: true }).click();
  await page.getByText("USB channels / calibration", { exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "roll min", exact: true }),
  ).toHaveValue("-0.9");
  await expect(
    page.getByRole("checkbox", { name: "Enable mode channel", exact: true }),
  ).toBeChecked();
  await page.getByText("Mode channel calibration", { exact: true }).click();
  await expect(
    page.getByRole("spinbutton", { name: "mode axis", exact: true }),
  ).toHaveValue("5");
});
