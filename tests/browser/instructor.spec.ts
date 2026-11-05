import { expect, test } from "@playwright/test";
test("commands report real Worker rejection and hotkeys ignore typing focus", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send control", exact: true }).click();
  await expect(page.getByTestId("command-result").last()).toContainText(
    "wind.mean wind-mean: rejected",
  );
  await expect(page.getByTestId("command-result").last()).toContainText(
    "BAD_STATE",
  );
  await page.getByLabel("Effect", { exact: true }).selectOption("ew.gnss-jamming");
  await page.getByLabel("Control ID", { exact: true }).fill("arbitrary-fault-42");
  await page.getByRole("button", { name: "Send control", exact: true }).click();
  await expect(page.getByText("ew.gnss-jamming arbitrary-fault-42: queued")).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("ew.gnss-jamming arbitrary-fault-42: applied")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Control ID", { exact: true }).focus();
  await page.keyboard.press("KeyP");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Effect", { exact: true }).focus();
  await page.keyboard.press("KeyP");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByRole("heading", { name: "Instructor", exact: true }).click();
  await page.keyboard.press("KeyP");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("command-result").last()).toContainText(
    "applied",
  );
});
test("motor-loss stays visibly rejected while the demo dynamics cannot model it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Effect", { exact: true }).selectOption("motor.loss");
  await page.getByRole("button", { name: "Send control", exact: true }).click();
  const result = page.getByTestId("command-result").last();
  await expect(result).toContainText("motor.loss motor-loss: rejected");
  await expect(result).toContainText("BAD_STATE");
  await expect(result).toContainText("motor-loss is not supported");
});
test("every effect has a form with its own fields and ranges, and the protocol's refusals show", async ({ page }) => {
  await page.goto("/");
  const send = page.getByRole("button", { name: "Send control", exact: true });
  await expect(send).toBeEnabled();
  const effect = page.getByLabel("Effect", { exact: true });
  const console_ = page.getByRole("region", { name: "Instructor console" });
  // One form per effect, from the protocol's catalog: three families, sixteen effects.
  await expect(effect.locator("optgroup")).toHaveCount(3);
  await expect(effect.locator("option")).toHaveCount(16);
  // Mean wind has all three axes, not the north wind of old, and states the wind model's range.
  await expect(console_.getByLabel("Wind north", { exact: true })).toHaveValue("5");
  await expect(console_.getByLabel("Wind east", { exact: true })).toBeVisible();
  await expect(console_.getByLabel("Wind down", { exact: true })).toBeVisible();
  await expect(console_).toContainText("-200 to 200 m/s per axis");
  // Gusts have the bandwidth the old protocol could not state.
  await effect.selectOption("wind.gust");
  await expect(console_.getByLabel("Bandwidth", { exact: true })).toBeVisible();
  await expect(console_).toContainText("above 0 to below 200 Hz");
  // A magnitude is typed, not a preset.
  await effect.selectOption("ew.position-step");
  await console_.getByLabel("Offset east", { exact: true }).fill("-250");
  await expect(console_.getByLabel("When switched off")).toBeVisible();
  // What is out of range never reaches the Worker, and says why.
  await effect.selectOption("wind.mean");
  await console_.getByLabel("Wind north", { exact: true }).fill("300");
  await send.click();
  await expect(page.getByTestId("control-refused")).toContainText("per axis");
  await expect(page.getByTestId("command-result")).toHaveCount(0);
  // An empty field is refused, never read as zero.
  await console_.getByLabel("Wind north", { exact: true }).fill("");
  await send.click();
  await expect(page.getByTestId("control-refused")).toContainText("finite number");
  await console_.getByLabel("Wind north", { exact: true }).fill("5");
  await console_.getByLabel("Intensity", { exact: true }).fill("-1");
  await send.click();
  await expect(page.getByTestId("control-refused")).toContainText("intensity must be at least 0");
  await expect(page.getByTestId("command-result")).toHaveCount(0);
  // A sensor error is rejected by the backend, with where to set it.
  await effect.selectOption("sensor.imu.accel-noise");
  await send.click();
  const result = page.getByTestId("command-result").last();
  await expect(result).toContainText("sensor.imu.accel-noise sensor-imu-accel-noise: rejected");
  await expect(result).toContainText("Sensors tab");
  // A value edited on one effect stays when another is opened and this one comes back.
  await effect.selectOption("ew.position-step");
  await expect(console_.getByLabel("Offset east", { exact: true })).toHaveValue("-250");
  // Off and on at any intensity is applied like any control, and the demo has this effect's model.
  await page.getByRole("checkbox", { name: "On", exact: true }).uncheck();
  await send.click();
  await expect(page.getByText("ew.position-step ew-position-step: queued")).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByText("ew.position-step ew-position-step: applied")).toBeVisible();
});
