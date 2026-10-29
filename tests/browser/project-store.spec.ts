import { viteFileUrl } from "../support/vite-url";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// TASK-136 (S16, S01): the project store on Chromium's IndexedDB. Projects are
// written, the browser is closed and relaunched on the same profile, and every
// store operation runs with the network disabled. Internet origins are aborted
// and counted for the whole test.
type Harness = typeof import("../support/project-store-harness");
const pageUrl = viteFileUrl(new URL("../support/project-store-harness.html", import.meta.url));
const harnessUrl = viteFileUrl(new URL("../support/project-store-harness.ts", import.meta.url));
const DATABASE = "mirage-project-store";

/**
 * Names a user typed in Russian. Source files outside docs/ru/ hold no Cyrillic
 * characters, so the names are escaped; each comment gives the meaning in English.
 */
const RU = {
  /** "Project: X8 octocopter" */
  project: "\u{41f}\u{440}\u{43e}\u{435}\u{43a}\u{442}: \u{43e}\u{43a}\u{442}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8",
  /** "Quadcopter X8 (rev. B)" */
  quadRevB: "\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8 (\u{440}\u{435}\u{434}. B)",
  /** "Quadcopter X8 — copy" */
  quadCopy: "\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8 — \u{43a}\u{43e}\u{43f}\u{438}\u{44f}",
  /** "Hover — hovering" */
  hover: "Hover — \u{432}\u{438}\u{441}\u{435}\u{43d}\u{438}\u{435}",
};

interface Session { context: BrowserContext; page: Page; offlineRequests: string[]; external: string[] }

test("projects survive a browser restart and round-trip through archives with the network disabled", async ({ playwright, launchOptions, headless, baseURL }, testInfo) => {
  test.setTimeout(120000);
  const userDataDir = testInfo.outputPath("chrome-profile");
  const open = async (): Promise<Session> => {
    const context = await playwright.chromium.launchPersistentContext(userDataDir, { ...launchOptions, headless, baseURL });
    const external: string[] = [], offlineRequests: string[] = [];
    await context.route(url => !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), route => {
      external.push(route.request().url());
      return route.abort();
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(pageUrl);
    // Load every module first; the store itself then needs no network at all.
    await page.evaluate(async url => { await import(url); }, harnessUrl);
    await context.setOffline(true);
    context.on("request", request => offlineRequests.push(request.url()));
    return { context, page, offlineRequests, external };
  };

  const first = await open();
  const written = await first.page.evaluate(async ({ url, db }) => (await import(url) as Harness).writeProject(db), { url: harnessUrl, db: DATABASE });
  expect(written.exportMissing).toBe(0);
  expect(written.storage.records).toBe(6);
  expect(written.storage.storeBytes).toBeGreaterThan(0);
  expect(written.storage.usageBytes).toBeGreaterThan(0);
  expect(written.storage.quotaBytes).toBeGreaterThan(written.storage.usageBytes ?? 0);
  expect(typeof written.storage.persisted).toBe("boolean");
  const conformance = await first.page.evaluate(async url => (await import(url) as Harness).backendConformance("task136-conformance"), harnessUrl);
  expect([conformance.staleHead, conformance.forkCode]).toEqual(["conflict", "conflict"]);
  expect(conformance.afterFailures).toEqual(conformance.before);
  expect([conformance.repeated, conformance.added]).toEqual([{ added: 0, present: 1 }, { added: 1, present: 0 }]);
  expect(conformance.after.records).toBe(conformance.before.records + 1);
  expect(first.offlineRequests).toEqual([]);
  await first.context.close();

  const second = await open();
  const reopened = await second.page.evaluate(async ({ url, db, w }) => (await import(url) as Harness).reopenProject(db, w),
    { url: harnessUrl, db: DATABASE, w: written });
  expect(reopened.projects).toEqual([{ id: written.projectId, name: RU.project }]);
  expect(reopened.items).toEqual([
    { kind: "component-card", name: "Motor MN3110 KV780", version: 1 },
    { kind: "aircraft-profile", name: RU.quadRevB, version: 2 },
    { kind: "aircraft-profile", name: RU.quadCopy, version: 1 },
    { kind: "experiment", name: RU.hover, version: 1 },
  ]);
  expect(reopened.profileHistory).toEqual([written.shas.profile1, written.shas.profile2]);
  expect(reopened.bytesAfterRestart).toEqual(written.bytes);
  expect(reopened.experimentInputs).toEqual([written.shas.profile1, written.shas.motor].sort());
  expect(reopened.copyOrigin).toBe(written.shas.profile2);
  expect(reopened.profile3Version).toBe(3);
  expect(reopened.experimentAfterEdit).toBe(written.bytes.experiment);
  expect(reopened.reimport).toEqual({ added: 0, unchanged: 6, statuses: [
    ["project", "unchanged"], ["component-card", "unchanged"], expect.anything(), expect.anything(), ["experiment", "unchanged"]] });
  expect(reopened.reimport.statuses.filter(([kind]) => kind === "aircraft-profile").map(([, status]) => status).sort()).toEqual(["local-newer", "unchanged"]);

  const elsewhere = await second.page.evaluate(async ({ url, archive }) => (await import(url) as Harness).importElsewhere("task136-other-installation", archive),
    { url: harnessUrl, archive: written.archive });
  expect([elsewhere.tamperedCode, elsewhere.truncatedCode, elsewhere.recordsAfterRejections]).toEqual(["archive-hash", "archive-header", 0]);
  expect(elsewhere.report).toEqual({ added: 6, unchanged: 0, missing: 0, statuses: [
    ["project", "new"], ["component-card", "new"], ["aircraft-profile", "new"], ["aircraft-profile", "new"], ["experiment", "new"]] });
  expect(elsewhere.projectName).toBe(RU.project);
  expect(elsewhere.items).toEqual([
    { kind: "component-card", name: "Motor MN3110 KV780", version: 1 },
    { kind: "aircraft-profile", name: RU.quadRevB, version: 2 },
    { kind: "aircraft-profile", name: RU.quadCopy, version: 1 },
    { kind: "experiment", name: RU.hover, version: 1 },
  ]);
  expect(elsewhere.records).toBe(6);
  expect(second.offlineRequests).toEqual([]);
  expect([...first.external, ...second.external]).toEqual([]);
  await second.context.close();
});

test("a version 1 project database upgrades to version 2 and keeps its records", async ({ page }) => {
  await page.goto(pageUrl);
  const upgraded = await page.evaluate(async url => (await import(url) as Harness).upgradeFromVersion1("task137-upgrade"), harnessUrl);
  expect(upgraded.projects).toEqual([upgraded.expected]);
  expect(upgraded.setting).toEqual({ schemaVersion: 1, tab: "aircraft", projectId: upgraded.id });
  expect(upgraded.version).toBe(2);
});
