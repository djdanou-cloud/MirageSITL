import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { writeCatalogEntry } from "../../apps/launcher/src/catalog";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";

// TASK-152 (S01, S02): the first-run check in the Project tab talks to a real
// launcher (TASK-151) started here with a fake SITL build and no Python
// environment or installation, and shows each prerequisite with its fix.
const ORIGIN = "http://127.0.0.1:5173";
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("the first-run check reports each prerequisite of a real launcher with its fix, without keeping the token", async ({ page }) => {
  const scratch = mkdtempSync(join(tmpdir(), "mirage-first-run-"));
  const home = join(scratch, "home");
  const token = ensureToken(home);
  const binary = join(scratch, "arducopter"), defaults = join(scratch, "copter.parm");
  writeFileSync(binary, "#!/bin/sh\nsleep 60\n");
  chmodSync(binary, 0o755);
  writeFileSync(defaults, "SYSID_THISMAV 1\n");
  writeCatalogEntry(home, {
    id: "fake", firmwareVersion: "ArduCopter V4.7.2", commit: "fb773567896014da007bca58358704d4a0d8516f",
    binaryPath: binary, binarySha256: sha256(binary), defaultParametersPath: defaults, defaultParametersSha256: sha256(defaults),
  });
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(scratch, "missing-python"), admit: path => readFileSync(path) });
  // A port nothing listens on, for the unreachable case.
  const closed = await new Promise<number>(done => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => done(typeof address === "object" && address ? address.port : 1)); }); });
  try {
    await page.goto("/");
    await page.getByRole("tab", { name: "Project", exact: true }).click();
    const setup = page.getByRole("region", { name: "Setup: local launcher and prerequisites" });
    const status = setup.getByTestId("first-run-status");
    const check = setup.getByRole("button", { name: "Check setup", exact: true });
    await expect(check).toBeDisabled();

    await setup.getByLabel("Launcher port", { exact: true }).fill(String(closed));
    await setup.getByLabel("Launcher token", { exact: true }).fill(token);
    await check.click();
    await expect(status).toContainText(`No launcher answered on 127.0.0.1:${closed}`);

    await setup.getByLabel("Launcher port", { exact: true }).fill(String(launcher.port));
    await setup.getByLabel("Launcher token", { exact: true }).fill("0".repeat(64));
    await check.click();
    await expect(status).toContainText("The launcher refused this token");

    await setup.getByLabel("Launcher token", { exact: true }).fill(token);
    await check.click();
    const list = setup.getByRole("list", { name: "Prerequisites" });
    await expect(list.getByRole("listitem")).toHaveCount(6);
    const row = (id: string) => list.locator(`[data-check="${id}"]`);
    await expect(row("pymavlink")).toHaveAttribute("data-status", "missing");
    await expect(row("pymavlink")).toContainText("To fix: Run node scripts/install-macos.mjs, which creates the Python environment with pymavlink 2.4.50.");
    await expect(row("installation")).toHaveAttribute("data-status", "missing");
    await expect(row("installation")).toContainText("This launcher folder has no installation");
    await expect(row("firmware")).toHaveAttribute("data-status", "ok");
    await expect(row("firmware")).not.toContainText("To fix");
    await expect(status).toContainText("prerequisites need attention");

    // The token stays out of the address, storage and the page text.
    expect(page.url()).not.toContain(token);
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(stored).not.toContain(token);
    expect(await page.locator("body").innerText()).not.toContain(token);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const result = await new AxeBuilder({ page }).analyze();
    expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
  } finally {
    await launcher.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
