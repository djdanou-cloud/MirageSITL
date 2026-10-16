import { expect, test } from "@playwright/test";
test("commands report real Worker rejection and hotkeys ignore typing focus", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Start", exact: true }),
  ).toBeEnabled();
  await page.getByLabel("Fault ID", { exact: true }).fill("arbitrary-fault-42");
  await page.getByRole("button", { name: "Send fault", exact: true }).click();
  await expect(page.getByTestId("command-result").last()).toContainText(
    "rejected",
  );
  await expect(page.getByTestId("command-result").last()).toContainText(
    "BAD_STATE",
  );
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Fault ID", { exact: true }).focus();
  await page.keyboard.press("KeyP");
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Fault effect").focus();
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
