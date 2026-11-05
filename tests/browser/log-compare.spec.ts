import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { seedQuadProject } from "../support/run-tab";

// TASK-181 (S14): two logs in the integrated viewer: dashed curves of the same quantity on one value axis, a manual shift, aligned interval starts, side by side, and a
// comparison saved with its alignment. What the viewer draws is read from its own Plotly figure. The viewer is the build of scripts/build-uavlogviewer.mjs.

const REFERENCE = join(process.cwd(), "tests/fixtures/dataflash/sitl-copter.bin");
test.skip(process.env.MIRAGE_UAVLOGVIEWER_DIR === undefined, "Needs MIRAGE_UAVLOGVIEWER_DIR, the build of scripts/build-uavlogviewer.mjs");

interface Trace { readonly name: string; readonly x: readonly number[]; readonly xaxis: string | undefined; readonly yaxis: string | undefined; readonly dash: string | undefined }
/** The curves the viewer has on its plot. */
async function traces(page: Page): Promise<readonly Trace[]> {
  const frame = page.frames().find(item => item.url().includes("/uavlogviewer/"));
  if (!frame) throw new Error("No viewer frame");
  return frame.evaluate(() => {
    const figure = document.getElementById("line") as unknown as { data?: readonly { name: string; x: readonly number[]; xaxis?: string; yaxis?: string; line?: { dash?: string } }[] } | null;
    return (figure?.data ?? []).map(trace => ({ name: trace.name, x: [...trace.x], xaxis: trace.xaxis, yaxis: trace.yaxis, dash: trace.line?.dash }));
  });
}
const layoutOf = async (page: Page) => {
  const frame = page.frames().find(item => item.url().includes("/uavlogviewer/"));
  if (!frame) throw new Error("No viewer frame");
  return frame.evaluate(() => {
    const figure = document.getElementById("line") as unknown as { layout: { xaxis: { domain: readonly number[] }; xaxis2?: { domain: readonly number[]; title?: unknown } } };
    return { first: figure.layout.xaxis.domain, second: figure.layout.xaxis2?.domain ?? null };
  });
};

test("two logs share a value axis in the viewer, shift by hand, align their starts, stand side by side, and a comparison keeps its alignment", async ({ page }) => {
  test.setTimeout(180_000);
  const home = mkdtempSync(join(tmpdir(), "mirage-compare-")), other = join(home, "other.bin");
  copyFileSync(REFERENCE, other);
  try {
    await seedQuadProject(page, "Quad X compare");
    await page.getByRole("tab", { name: "Analysis", exact: true }).click();
    const analysis = page.getByRole("tabpanel", { name: "Analysis", exact: true });
    await analysis.getByLabel("Open DataFlash log (.bin)").setInputFiles(REFERENCE);
    await expect(analysis.getByRole("status").first()).toContainText(/Opened sitl-copter\.bin: \d+ message types\./, { timeout: 60_000 });
    const viewer = page.frameLocator("iframe[title=UAVLogViewer]");
    await viewer.getByText("Plot Individual Field").click();
    await viewer.locator("li.type a.section", { hasText: /^\s*ATT\b/ }).first().click();
    await viewer.locator("#typeATT li.field", { hasText: /^\s*Roll\b/ }).first().click();
    await expect.poll(async () => (await traces(page)).length, { timeout: 30_000 }).toBe(1);

    // A file that is no log is refused where it shows.
    const compare = analysis.getByTestId("compare-logs");
    const notALog = join(home, "notes.bin");
    copyFileSync(join(process.cwd(), "package.json"), notALog);
    await compare.getByLabel("Compare with a file (.bin)").setInputFiles(notALog);
    await expect(compare.getByTestId("compare-refusal")).toContainText("not a DataFlash binary log");

    await compare.getByLabel("Compare with a file (.bin)").setInputFiles(other);
    await expect(compare.getByTestId("compare-second")).toHaveText("Comparing with other.bin.", { timeout: 60_000 });
    await expect.poll(async () => (await traces(page)).length, { timeout: 30_000 }).toBe(2);
    const [first, second] = await traces(page);
    if (!first || !second) throw new Error("No curves");
    // The same quantity: dashed, on the same value axis, so one scale.
    expect(second.name).toContain("ATT.Roll");
    expect(second.name).toContain("other.bin");
    expect(second.dash).toBe("dash");
    expect(first.dash).not.toBe("dash");
    expect(second.yaxis).toBe(first.yaxis);
    expect(second.x).toEqual(first.x);

    // A manual shift moves the second curve by exactly that, and the first not at all.
    await compare.getByRole("button", { name: "+1 s", exact: true }).click();
    await expect(compare.getByTestId("compare-offset")).toHaveAttribute("data-offset-s", "1");
    await expect.poll(async () => (await traces(page))[1]?.x[0], { timeout: 15_000 }).toBeCloseTo((first.x[0] ?? 0) + 1000, 6);
    expect((await traces(page))[0]?.x).toEqual(first.x);
    await compare.getByRole("button", { name: "-0.1 s", exact: true }).click();
    await expect(compare.getByTestId("compare-offset")).toHaveAttribute("data-offset-s", "0.9");
    await expect.poll(async () => (await traces(page))[1]?.x[0], { timeout: 15_000 }).toBeCloseTo((first.x[0] ?? 0) + 900, 6);

    // Two intervals: each log shows its own, and aligning puts the second start on the first.
    await compare.getByLabel("First log from, s").fill("42.3");
    await compare.getByLabel("First log to, s").fill("42.45");
    await compare.getByLabel("Second log from, s").fill("42.45");
    await compare.getByLabel("Second log to, s").fill("42.6");
    await compare.getByRole("button", { name: "Align the starts", exact: true }).click();
    await expect(compare.getByTestId("compare-offset")).toHaveAttribute("data-offset-s", "-0.15");
    await expect(compare.getByTestId("compare-offset")).toContainText("overlap for 0.15 s");
    await expect.poll(async () => { const [a, b] = await traces(page); return a && b && Math.min(...b.x) >= 42300 - 1e-6 && Math.max(...b.x) <= 42450 + 1e-6 && Math.min(...a.x) >= 42300 && Math.max(...a.x) <= 42450; }, { timeout: 15_000 }).toBe(true);
    const aligned = await traces(page);
    // The second curve holds what the log has from 42.45 s, moved by -150 ms.
    const expected = first.x.filter(time => time >= 42450 && time <= 42600).map(time => time - 150);
    expect(aligned[1]?.x.length).toBe(expected.length);
    expected.forEach((time, index) => expect(aligned[1]?.x[index]).toBeCloseTo(time, 6));

    // An interval that makes no sense says why, and changes nothing.
    await compare.getByLabel("First log to, s").fill("42");
    await compare.getByRole("button", { name: "Show these intervals", exact: true }).click();
    await expect(compare.getByTestId("compare-refusal")).toContainText("start before it ends");
    await compare.getByLabel("First log to, s").fill("42.45");

    // Side by side: each log its half of the width and its own time axis, on the one value axis.
    await compare.getByLabel("Show them").selectOption("side-by-side");
    await expect.poll(async () => (await traces(page))[1]?.xaxis, { timeout: 15_000 }).toBe("x2");
    const sideBySide = await traces(page), layout = await layoutOf(page);
    expect(sideBySide[1]?.yaxis).toBe(sideBySide[0]?.yaxis);
    if (!layout.second) throw new Error("No second time axis");
    expect(layout.first[1]).toBeLessThan(layout.second[0] ?? 0);
    mkdirSync("test-results/browser", { recursive: true });
    await page.screenshot({ path: "test-results/browser/task-181-compare.png" });

    // Saved with its alignment, and back.
    await compare.getByRole("button", { name: "Save this comparison", exact: true }).click();
    await expect(compare.getByTestId("compare-saved")).toContainText("Saved as sitl-copter.bin and other.bin");
    await compare.getByRole("button", { name: "+1 s", exact: true }).click();
    await expect(compare.getByTestId("compare-offset")).toHaveAttribute("data-offset-s", "0.85");
    await compare.getByTestId("compare-saved-list").getByText("1 saved comparison").click();
    await compare.getByRole("button", { name: "Use the alignment of sitl-copter.bin and other.bin", exact: true }).click();
    await expect(compare.getByTestId("compare-offset")).toHaveAttribute("data-offset-s", "-0.15");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
