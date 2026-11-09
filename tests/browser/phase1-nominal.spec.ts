import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { ensureToken, startLauncher } from "../../apps/launcher/src/server";
import { columnText, readDataFlash, type DataFlashLog } from "../../packages/dataflash/src/reader";
import { RECIPES, profileDifferences } from "../support/aircraft-recipes";
import { build, createProject, panel as aircraftPanel } from "../support/aircraft-ui";
import { field, groupMembers, launcherCall, launcherExperiments, processesNaming, psGroup, signalZeroCode, stopEveryRun } from "../support/run-tab";
import { viteFileUrl } from "../support/vite-url";
import {
  CARD_TYPES, CRITERIA, NOMINAL_CONFIGURATIONS, RUN_SCHEMA, STEPS, STOCK_SETTINGS, judgeRun, parseNominalRun, PARAMETER_CHANGE, plannedTuning, steadinessOf,
  type CardType, type HoldFacts, type NominalConfiguration, type Steadiness, type StepFacts, type StepId,
} from "../../scripts/phase1/nominal-rules";

// TASK-158 (S01–S03): the Phase 1 nominal flight of each S19 configuration
// through the application's UI alone, from an empty project to a stopped run,
// on the reference Mac in Chrome with the installed ArduCopter fb773567
// (TASK-152). Each test types the four example component cards into the
// Components tab and the configuration's TASK-141 recipe into the Aircraft
// tab, with the cards on every motor, the battery card and the NACA 6409
// polar; reads the frame and outputs the Aircraft tab generates; and on the
// Run tab starts a real-time run. After READY the quad's one tuned setting goes
// in through the Parameters tab (the 40 Hz gyro filter of the user's decision of
// 2026-11-04; MIRAGE_PHASE1_STOCK=1 leaves it out, as a negative control). Then
// it runs ArduPilot's motor check, takes off to 5 m, holds, pauses for 30 s of
// wall time, resumes, holds, lands and stops.
// Each step's facts, or the error that ended it, go to a run file in
// MIRAGE_PHASE1_OUT with the run's DataFlash files; the verdicts come from
// scripts/phase1/nominal-rules.ts. Opt-in: node scripts/phase1/nominal-flight.mjs
// runs it in Google Chrome on the Mac's GPU (MIRAGE_BROWSER_GPU=hardware) and
// writes the evidence and the matrix cells.
const ROOT = process.cwd();
const HOME = join(ROOT, ".cache/task-152/home");
const ORIGIN = "http://127.0.0.1:5173";
const FIRMWARE_ID = "arducopter-fb773567";
const OUT = process.env.MIRAGE_PHASE1_OUT ?? join(ROOT, "test-results/phase1/nominal/manual");
const CHOSEN = (process.env.MIRAGE_PHASE1_CONFIGURATIONS ?? "").split(",").filter(id => id !== "");
const SETTINGS = process.env.MIRAGE_PHASE1_STOCK === "1" ? "stock" : "acceptance";
/** ArduCopter's failsafe, EKF fault and crash messages, as in tests/browser/sitl-pause.spec.ts. */
const FAILSAFE = /failsafe|variance|lane switch|crash|bad ahrs|glitch|EKF\S* (?:fault|reset)/i;

test.skip(process.env.MIRAGE_PHASE1_NOMINAL !== "1", "Opt-in: node scripts/phase1/nominal-flight.mjs runs the Phase 1 nominal acceptance");
test.skip(!existsSync(join(HOME, "install-manifest.json")), "Needs the TASK-152 installation in .cache/task-152/home");

type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Components = typeof import("../../packages/aircraft/src/components");
type Resolution = typeof import("../../packages/aircraft/src/resolve-components");
type Derivation = typeof import("../../packages/aircraft/src/derive-manifest");
type Gear = typeof import("../support/standard-gear");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
type Recordings = typeof import("../../packages/aar/src/recorder-v2-host");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  components: viteFileUrl(new URL("../../packages/aircraft/src/components.ts", import.meta.url)),
  resolution: viteFileUrl(new URL("../../packages/aircraft/src/resolve-components.ts", import.meta.url)),
  derivation: viteFileUrl(new URL("../../packages/aircraft/src/derive-manifest.ts", import.meta.url)),
  gear: viteFileUrl(new URL("../support/standard-gear.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
  recordings: viteFileUrl(new URL("../../packages/aar/src/recorder-v2-host.ts", import.meta.url)),
};
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const label = (scope: Locator, text: string) => scope.getByLabel(text, { exact: true });

// ---- the example cards, as a user types them -------------------------------------------------------

interface ExampleCard {
  readonly model: string;
  readonly applicability: string;
  readonly source: { readonly id: string; readonly description: string };
  readonly values: Readonly<Record<string, unknown>>;
}
function exampleCard(type: CardType): ExampleCard {
  const card: unknown = JSON.parse(read(`../fixtures/components/${type}-example.json`));
  const model = field(card, "model"), applicability = field(card, "applicability"), values = field(card, "values");
  const id = field(card, "sources", 0, "id"), description = field(card, "sources", 0, "description");
  if (typeof model !== "string" || typeof applicability !== "string" || typeof id !== "string" || typeof description !== "string" ||
    typeof values !== "object" || values === null) throw new Error(`Invalid ${type} example card`);
  return { model, applicability, source: { id, description }, values: Object.fromEntries(Object.entries(values)) };
}
const CARD_NAMES: { readonly [T in CardType]: string } = { motor: "Example motor", propeller: "Example propeller", esc: "Example ESC", battery: "Example battery" };
const TYPE_OPTIONS: { readonly [T in CardType]: string } = { motor: "Motor", propeller: "Propeller", esc: "ESC", battery: "Battery" };
/** The card editor's label of each value and whether a new card already marks it known (apps/web/src/library/card-form.ts). */
const VALUE_LABELS: { readonly [T in CardType]: Readonly<Record<string, readonly [string, boolean]>> } = {
  motor: { kvRpmPerV: ["KV (rpm/V)", true], resistanceOhm: ["Winding resistance (Ω)", false], noLoadCurrentA: ["No-load current (A)", false],
    noLoadVoltageV: ["No-load test voltage (V)", false], maxCurrentA: ["Maximum current (A)", false], maxPowerW: ["Maximum power (W)", false],
    massKg: ["Mass (kg)", false] },
  propeller: { diameterM: ["Diameter (m)", true], pitchM: ["Pitch (m)", true], bladeCount: ["Blades", true], hubDiameterM: ["Hub diameter (m)", false],
    massKg: ["Mass (kg)", false] },
  esc: { maxCurrentA: ["Maximum current (A)", true], updateRateHz: ["Update rate (Hz)", false], maxVoltageV: ["Maximum voltage (V)", false],
    massKg: ["Mass (kg)", false] },
  battery: { cellsSeries: ["Cells in series", true], capacityAh: ["Capacity (Ah)", true], internalResistanceOhm: ["Internal resistance (Ω)", false],
    cellFullV: ["Full cell voltage (V)", false], cellEmptyV: ["Empty cell voltage (V)", false],
    maxDischargeCurrentA: ["Maximum discharge current (A)", false], massKg: ["Mass (kg)", false] },
};

async function typeCard(page: Page, type: CardType): Promise<void> {
  const tab = page.getByRole("tabpanel", { name: "Components", exact: true }), example = exampleCard(type);
  await label(tab, "Type of a new card").selectOption({ label: TYPE_OPTIONS[type] });
  await tab.getByRole("button", { name: "New card", exact: true }).click();
  await label(tab, "Card name").fill(CARD_NAMES[type]);
  await label(tab, "Model (optional)").fill(example.model);
  // The example cards' one source: illustrative values, not a datasheet and not a measurement.
  await label(tab, "Source 1 ID").fill(example.source.id);
  await label(tab, "Source 1 kind").selectOption({ label: "Illustrative or assumed" });
  await label(tab, "Source 1 description").fill(example.source.description);
  for (const [key, [text, known]] of Object.entries(VALUE_LABELS[type])) {
    const value = example.values[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== "number") throw new Error(`The ${type} example's ${key} is not a number`);
    if (!known) await label(tab, `${text} is known`).check();
    await label(tab, text).fill(String(value));
  }
  const editor = tab.getByRole("region").filter({ has: page.getByLabel("Card name", { exact: true }) });
  await label(editor, "Limits of use (optional)").fill(example.applicability);
  await expect(tab.getByRole("list", { name: "Problems to fix before saving the card" })).toHaveCount(0);
  await tab.getByRole("button", { name: "Save card", exact: true }).click();
  await expect(tab.getByTestId("card-status")).toHaveText(`Created ${CARD_NAMES[type]}.`);
}

/** The open project's stored items of a kind, newest version of each, by name. */
async function storedItems(page: Page, kind: "component-card" | "aircraft-profile"): Promise<{ name: string; sha256: string; version: number; projectId: string; payload: unknown }[]> {
  return page.evaluate(async ({ urls, kind }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const store = await ProjectStore.openIndexedDb();
    try {
      const items = [];
      for (const project of await store.listProjects()) {
        for (const head of await store.listItems(project.record.id, kind)) {
          items.push({ name: head.record.name, sha256: head.sha256, version: head.record.version, projectId: project.record.id,
            payload: JSON.parse(JSON.stringify(head.record.payload)) as unknown });
        }
      }
      return items;
    } finally {
      store.close();
    }
  }, { urls, kind });
}

/** The CG height over level ground at rest on the profile's standard gear (tests/support/standard-gear.ts), from its derived manifest. */
async function restHeight(page: Page, profileSha256: string): Promise<number> {
  return page.evaluate(async ({ urls, profileSha256 }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDependencies, readAircraftProfile } = await import(urls.profile) as Profiles;
    const { readComponentCard } = await import(urls.components) as Components;
    const { resolveComponents } = await import(urls.resolution) as Resolution;
    const { deriveVehicleManifest } = await import(urls.derivation) as Derivation;
    const { standardGearHeights } = await import(urls.gear) as Gear;
    const store = await ProjectStore.openIndexedDb();
    try {
      const profile = readAircraftProfile(await store.get(profileSha256));
      const cards = new Map<string, ReturnType<typeof readComponentCard>>();
      for (const dependency of profileDependencies(profile)) {
        if (dependency.kind === "component-card") cards.set(dependency.sha256, readComponentCard(await store.get(dependency.sha256)));
      }
      const resolved = resolveComponents(profile, cards);
      if (!resolved.components) throw new Error(`Missing components: ${resolved.missing.join("; ")}`);
      return standardGearHeights((await deriveVehicleManifest(profile, resolved.components, { modelId: 158 })).manifest).restM;
    } finally {
      store.close();
    }
  }, { urls, profileSha256 });
}

/** The project's experiment record as the Run tab stored it. */
async function experimentRecord(page: Page, projectId: string): Promise<{ sha256: string; payload: unknown; count: number }> {
  return page.evaluate(async ({ urls, projectId }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const store = await ProjectStore.openIndexedDb();
    try {
      const list = await store.listItems(projectId, "experiment");
      const [stored] = list;
      if (!stored) throw new Error("No experiment record");
      return { sha256: stored.sha256, payload: JSON.parse(JSON.stringify(readExperiment(stored))) as unknown, count: list.length };
    } finally {
      store.close();
    }
  }, { urls, projectId });
}

/** The catalog entry of a recording, once the recorder has closed it (or as it stands after 30 s). */
async function recording(page: Page, recordId: string): Promise<unknown> {
  let entry: unknown = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    entry = await page.evaluate(async ({ urls, recordId }) => {
      const { listRecordings } = await import(urls.recordings) as Recordings;
      const found = (await listRecordings()).find(item => item.recordId === recordId);
      return found ? JSON.parse(JSON.stringify(found)) as unknown : null;
    }, { urls, recordId });
    if (field(entry, "status") === "closed") break;
    await page.waitForTimeout(500);
  }
  return entry;
}

// ---- the run file ------------------------------------------------------------------------------

/** Each step's record as the run file holds it; parseNominalRun checks the file before any verdict. */
class Steps {
  readonly records: Record<StepId, { readonly facts: unknown; readonly error: string | null } | null> = {
    profile: null, mapping: null, refusal: null, start: null, tuning: null, parameters: null, motorCheck: null, hold: null, pause: null, landing: null, stop: null, reopen: null };
  failed = false;
  /** `after` runs once a step has run, failed or not: the optional screenshots of MIRAGE_PHASE1_SCREENSHOTS. */
  constructor(private readonly after: (id: StepId) => Promise<void> = () => Promise.resolve()) {}
  /** Runs a step unless an earlier one failed (`always` runs it anyway); an exception ends it with its message as the error. */
  async run<S extends StepId>(id: S, body: () => Promise<StepFacts[S]>, always = false): Promise<void> {
    if (this.failed && !always) return;
    try {
      this.records[id] = { facts: await body(), error: null };
    } catch (error) {
      this.failed = true;
      this.records[id] = { facts: null, error: (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "error" };
    }
    await this.after(id);
  }
}

/** The STOCK_SETTINGS names as the log's PARM records hold them at `atS` of its clock. */
function flownSettingsOf(log: DataFlashLog, atS: number): { name: string; value: number | null }[] {
  const parm = log.groups.find(group => group.name === "PARM");
  const nameColumn = parm?.columns.find(column => column.name === "Name"), valueColumn = parm?.columns.find(column => column.name === "Value");
  const timeColumn = parm?.columns.find(column => column.name === "TimeUS");
  const held = new Map<string, number>();
  if (parm && nameColumn && valueColumn && timeColumn) {
    for (let row = 0; row < parm.count; row++) {
      if (Number(timeColumn.values[row]) * timeColumn.valueScale <= atS) held.set(columnText(nameColumn, row), Number(valueColumn.values[row]) * valueColumn.valueScale);
    }
  }
  return Object.keys(STOCK_SETTINGS).map(name => ({ name, value: held.get(name) ?? null }));
}

const number = async (locator: Locator, suffix = "") => Number.parseFloat(((await locator.textContent()) ?? "").replace(suffix, ""));
type Comparable = Parameters<typeof profileDifferences>[0];
function motorCount(payload: unknown): number {
  const motors = field(payload, "motors"), list: readonly unknown[] = Array.isArray(motors) ? motors : [];
  return list.length;
}

for (const configuration of NOMINAL_CONFIGURATIONS.filter(c => CHOSEN.length === 0 || CHOSEN.includes(c.id))) {
  test(`${configuration.id}: through the UI from an empty project to a stopped real-time flight with native ArduCopter`, async ({ page, browser }) => {
    test.setTimeout(1_800_000);
    await fly(page, browser.version(), configuration);
  });
}

async function fly(page: Page, browserVersion: string, configuration: NominalConfiguration): Promise<void> {
  const recipe = RECIPES.find(item => item.fixture === configuration.fixture);
  if (!recipe) throw new Error(`No recipe for ${configuration.fixture}`);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const startedAt = new Date().toISOString();
  const home = mkdtempSync(join(tmpdir(), "mirage-phase1-nominal-"));
  copyFileSync(join(HOME, "token"), join(home, "token"));
  chmodSync(join(home, "token"), 0o600);
  copyFileSync(join(HOME, "catalog.json"), join(home, "catalog.json"));
  const token = ensureToken(home);
  const launcher = await startLauncher({ home, origin: ORIGIN, port: 0, python: join(HOME, "venv/bin/python") });
  // MIRAGE_PHASE1_SCREENSHOTS=DIR saves the page after every step as DIR/<configuration>-<nn>-<step>.png; a failed screenshot never fails a step.
  const shots = process.env.MIRAGE_PHASE1_SCREENSHOTS;
  let shot = 0;
  const steps = new Steps(async id => {
    if (!shots) return;
    shot += 1;
    await page.screenshot({ path: join(shots, `${configuration.id}-${String(shot).padStart(2, "0")}-${id}.png`), fullPage: true }).catch(() => undefined);
  }), runTab = page.getByRole("region", { name: "ArduPilot SITL" });
  const stage = runTab.getByTestId("sitl-stage"), simTime = () => number(runTab.getByTestId("sitl-sim-time"), " s");
  const altitude = () => number(runTab.getByTestId("sitl-altitude"), " m"), text = async (testId: string) => (await runTab.getByTestId(testId).textContent()) ?? "";
  let projectId = "", profileSha256 = "", runPid = 0, experimentId: string | null = null;
  let speed: unknown = null, hover: unknown = null, limitEvents: readonly string[] = [];
  const holds: { first: HoldFacts | null; afterResume: HoldFacts | null } = { first: null, afterResume: null };
  const finite = (value: number) => (Number.isFinite(value) ? value : null);
  /** The autopilot messages so far that name a failsafe, an EKF fault or a crash. */
  const failsafeMessages = async () => (await runTab.getByRole("list", { name: "Autopilot messages" }).getByRole("listitem").allTextContents().catch(() => []))
    .filter(message => FAILSAFE.test(message));
  /** Readings of the altitude every 250 ms of wall time over `seconds` of simulated time. */
  const holdFor = async (seconds: number): Promise<HoldFacts> => {
    const startSimS = await simTime(), readingsM: number[] = [];
    let now = startSimS;
    while (now - startSimS < seconds) {
      readingsM.push(await altitude());
      await page.waitForTimeout(250);
      now = await simTime();
    }
    return { stage: await text("sitl-stage"), armed: await text("sitl-armed"), mode: await text("sitl-mode"), startSimS, endSimS: now, readingsM };
  };
  try {
    await page.goto("/");
    await steps.run("profile", async () => {
      await createProject(page, `${recipe.name} acceptance`);
      await page.getByRole("tab", { name: "Components", exact: true }).click();
      for (const type of CARD_TYPES) await typeCard(page, type);
      await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
      await build(page, recipe, async tab => {
        await label(tab, "Motor card for every motor").selectOption({ label: CARD_NAMES.motor });
        await label(tab, "Propeller card for every motor").selectOption({ label: CARD_NAMES.propeller });
        await label(tab, "ESC card for every motor").selectOption({ label: CARD_NAMES.esc });
        await tab.getByRole("button", { name: "Apply to every motor", exact: true }).click();
        await label(tab, "Battery card").selectOption({ label: CARD_NAMES.battery });
        await label(tab, `Polar for ${CARD_NAMES.propeller}`).selectOption(CRITERIA.polar);
      });
      const cards = await storedItems(page, "component-card"), profiles = await storedItems(page, "aircraft-profile");
      const profile = profiles.find(item => item.name === recipe.name);
      if (!profile || profiles.length !== 1) throw new Error(`${profiles.length} profiles stored`);
      projectId = profile.projectId;
      profileSha256 = profile.sha256;
      const cardOf = (type: CardType) => {
        const card = cards.find(item => item.name === CARD_NAMES[type]);
        if (!card) throw new Error(`The ${type} card was not stored`);
        return card;
      };
      const ids = Object.fromEntries(CARD_TYPES.map(type => [type, cardOf(type).sha256]));
      // The profile as the fixture describes it, on the cards made here and the chosen polar.
      const fixture = JSON.parse(read(`../fixtures/aircraft/${configuration.fixture}.json`)) as Comparable & { readonly motors: readonly Record<string, unknown>[] };
      const expected = { ...fixture, battery: { card: ids.battery }, propellerPolars: [{ card: ids.propeller, polar: CRITERIA.polar }],
        motors: fixture.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) };
      return {
        cards: CARD_TYPES.map(type => {
          const card = cardOf(type), values = field(card.payload, "values"), example = exampleCard(type).values;
          const differences = Object.keys({ ...example, ...(typeof values === "object" && values !== null ? values : {}) })
            .filter(key => JSON.stringify(field(values, key) ?? null) !== JSON.stringify(example[key] ?? null))
            .map(key => `${key} ${JSON.stringify(field(values, key))} != ${JSON.stringify(example[key])}`);
          if (field(card.payload, "type") !== type) differences.push(`type ${String(field(card.payload, "type"))}`);
          return { type, sha256: card.sha256, sourceKind: String(field(card.payload, "sources", 0, "kind")), differences };
        }),
        sha256: profile.sha256, version: profile.version, motors: motorCount(profile.payload),
        // Stored payloads are validated profiles; profileDifferences compares every field with the fixture's.
        differences: profileDifferences(profile.payload as Comparable, expected),
      };
    });

    await steps.run("mapping", async () => {
      const tab = aircraftPanel(page);
      await expect(tab.getByTestId("mapping-profile")).toHaveText(profileSha256.slice(0, 12));
      const frame = (await tab.getByTestId("mapping-frame").textContent()) ?? "";
      const rows = tab.getByRole("table", { name: "Motor outputs" }).locator("tbody tr"), outputs = [];
      for (let i = 0; i < (await rows.count()); i++) {
        const row = rows.nth(i);
        outputs.push({ motor: Number(await row.locator("th").textContent()), output: Number(((await row.locator("td").nth(3).textContent()) ?? "").replace("SERVO", "")) });
      }
      return { frame: frame.trim(), outputs };
    });

    // TASK-188: what this aircraft's tab refuses, and that nothing is stored for it.
    await steps.run("refusal", async () => {
      const tab = aircraftPanel(page), problems = tab.getByRole("list", { name: "Problems to fix before saving" });
      const outputs = tab.getByLabel("ArduPilot output", { exact: true });
      await outputs.nth(1).fill(await outputs.nth(0).inputValue());
      await expect(problems).toContainText("is assigned to motors");
      const problemTexts = await problems.getByRole("listitem").allTextContents();
      const saveDisabled = await tab.getByRole("button", { name: "Save profile", exact: true }).isDisabled();
      await tab.getByLabel("Number of arms", { exact: true }).fill("9");
      await tab.getByRole("button", { name: "Lay out arms", exact: true }).click();
      const layout = tab.getByRole("list", { name: "Layout errors" });
      await expect(layout).toContainText("1 to 8 arms");
      const layoutErrors = await layout.getByRole("listitem").allTextContents();
      await tab.getByRole("button", { name: "Discard changes", exact: true }).click();
      const versions = (await storedItems(page, "aircraft-profile")).filter(item => item.name === recipe.name);
      return { problems: problemTexts, saveDisabled, layoutErrors, versions: versions.length };
    });

    await steps.run("start", async () => {
      await page.getByRole("tab", { name: "Run", exact: true }).click();
      await page.getByRole("radio", { name: "ArduPilot SITL" }).check();
      await label(runTab, "Aircraft profile").selectOption({ label: `${recipe.name} (version 1)` });
      await label(runTab, "Launcher port").fill(String(launcher.port));
      await label(runTab, "Launcher token").fill(token);
      await runTab.getByRole("button", { name: "List ArduPilot builds" }).click();
      await expect(label(runTab, "ArduPilot build")).toHaveValue(FIRMWARE_ID);
      await label(runTab, "Speed").selectOption(String(CRITERIA.speedup));
      await runTab.getByRole("button", { name: "Start SITL run" }).click();
      // The run's process, known from here on, so the stop step checks it even if the start fails later.
      await expect.poll(async () => (await launcherExperiments(launcher.port, token, ORIGIN))[0]?.runs.at(-1)?.pid ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
      const [experiment] = await launcherExperiments(launcher.port, token, ORIGIN);
      experimentId = experiment?.id ?? null;
      runPid = experiment?.runs.at(-1)?.pid ?? 0;
      // A loaded host runs the lockstep slower than real time; READY comes after about 41 s of simulated time.
      await expect(runTab.getByTestId("sitl-ready")).toHaveText("READY", { timeout: 900_000 });
      const readyAtSimS = await simTime();
      const record = await experimentRecord(page, projectId);
      await expect(runTab.getByTestId("sitl-record")).toHaveText(record.sha256);
      // The catalog's binary and default parameters, hashed here.
      const catalog: unknown = JSON.parse(readFileSync(join(HOME, "catalog.json"), "utf8"));
      const firmwareList = field(catalog, "firmware"), entries: readonly unknown[] = Array.isArray(firmwareList) ? firmwareList : [];
      const entry = entries.find(item => field(item, "id") === FIRMWARE_ID);
      const hashFile = (key: string) => { const path = field(entry, key); return typeof path === "string" ? sha256(readFileSync(path)) : ""; };
      const firmware = field(record.payload, "sitl", "ardupilot"), session = field(record.payload, "session");
      const speedup = field(session, "speedup");
      return {
        ready: await text("sitl-ready"), readyAtSimS, recordSha256: record.sha256, profileSha256: String(field(record.payload, "profile", "sha256")),
        physicsHz: Number(field(session, "physicsHz")), clockMode: String(field(session, "clockMode")), speedup: typeof speedup === "number" ? speedup : null,
        firmware: { id: String(field(firmware, "catalogId")), firmwareVersion: String(field(firmware, "firmwareVersion")), commit: String(field(firmware, "commit")),
          binarySha256: String(field(firmware, "binarySha256")), defaultParametersSha256: String(field(firmware, "defaultParametersSha256")) },
        hashed: { binarySha256: hashFile("binaryPath"), defaultParametersSha256: hashFile("defaultParametersPath") },
      };
    });

    /** Writes each through the Parameters tab, as a user would, and comes back to the Run tab. */
    const writeParameters = async (planned: readonly { readonly name: string; readonly value: number }[]) => {
      const writes: StepFacts["tuning"]["writes"][number][] = [];
      if (planned.length === 0) return { writes };
      await page.getByRole("tab", { name: "Parameters", exact: true }).click();
      const panel = page.getByRole("tabpanel", { name: "Parameters", exact: true });
      await expect(panel.getByTestId("parameters-status")).toHaveAttribute("data-download", "complete", { timeout: 120_000 });
      for (const { name, value } of planned) {
        await panel.getByLabel("Search parameters").fill(name);
        await panel.getByTestId("parameter-table").getByRole("button", { name, exact: true }).click();
        await panel.getByLabel(`New value of ${name}`).fill(String(value));
        await panel.getByRole("button", { name: "Write", exact: true }).click();
        const row = panel.getByTestId("parameter-history").locator(`tr[data-name="${name}"]`).last();
        await expect(row).not.toHaveAttribute("data-outcome", "requested", { timeout: 60_000 });
        // The table's value comes from ArduPilot's read-back.
        const shown = panel.getByTestId("parameter-table").locator(`tr[data-name="${name}"]`).getByTestId("parameter-value");
        writes.push({ name, value, outcome: (await row.getAttribute("data-outcome")) ?? "", rebootRequired: (await row.getAttribute("data-reboot")) === "true",
          shown: (await shown.textContent()) ?? "" });
      }
      await page.getByRole("tab", { name: "Run", exact: true }).click();
      return { writes };
    };
    await steps.run("tuning", () => writeParameters(plannedTuning({ configuration: configuration.id, settings: SETTINGS })));
    // TASK-188: the parameter change every configuration makes, which this flight does not read.
    await steps.run("parameters", () => writeParameters([PARAMETER_CHANGE]));

    await steps.run("motorCheck", async () => {
      const check = runTab.getByTestId("motor-check"), button = check.getByRole("button");
      await expect(button).toBeEnabled();
      await button.click();
      // Each motor spins 1.5 s of simulated time, one after the other.
      await expect(check).not.toHaveAttribute("data-state", "running", { timeout: 60_000 + configuration.motors * 15_000 });
      const rows = [];
      for (let order = 1; order <= configuration.motors; order++) {
        const row = check.getByTestId(`motor-check-${order}`);
        if ((await row.count()) === 0) continue;
        const match = /Motor (\d+), output (\d+)/.exec((await row.textContent()) ?? "");
        rows.push({ order, motor: Number(match?.[1]), output: Number(match?.[2]), pass: (await row.getAttribute("data-pass")) === "true" });
      }
      return { state: (await check.getAttribute("data-state")) ?? "", summary: await text("motor-check-summary"), rows };
    });

    await steps.run("hold", async () => {
      await expect(stage).toHaveAttribute("data-state", "ready", { timeout: 600_000 });
      await label(runTab, "Take-off altitude, m").fill(String(CRITERIA.takeoffAltitudeM));
      await runTab.getByRole("button", { name: "Take off" }).click();
      await expect(runTab.getByTestId("sitl-armed")).toHaveText("Armed", { timeout: 120_000 });
      await expect(stage).toHaveText("Flying", { timeout: 180_000 });
      // One simulated second to settle after the climb, then the hold.
      const settled = await simTime();
      while ((await simTime()) - settled < 1) await page.waitForTimeout(100);
      const held = await holdFor(CRITERIA.holdSimS);
      holds.first = held;
      // What the hover draws, reported in the evidence.
      const battery = runTab.getByTestId("power-battery");
      const reading = async (name: string) => finite(Number.parseFloat((await battery.locator("div", { hasText: name }).locator("dd").textContent()) ?? ""));
      const commandPercent = [];
      for (let motor = 1; motor <= configuration.motors; motor++) {
        commandPercent.push(finite(Number.parseFloat((await runTab.getByTestId(`power-motor-${motor}`).locator("td").nth(3).textContent()) ?? "")));
      }
      hover = { voltageV: await reading("Voltage"), currentA: await reading("Current"), powerW: await reading("Power"), commandPercent };
      return held;
    });

    await steps.run("pause", async () => {
      await runTab.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(stage).toHaveAttribute("data-state", "paused");
      await page.waitForTimeout(1000);
      const snapshot = async () => ({ simS: await simTime(), altitudeM: await altitude(), stepped: Number.parseInt(await text("sitl-frames"), 10) });
      const pausedStage = (await stage.getAttribute("data-state")) ?? "", before = await snapshot(), wallStart = Date.now();
      while (Date.now() - wallStart < CRITERIA.pauseWallS * 1000 + 500) await page.waitForTimeout(1000);
      const after = await snapshot(), wallS = (Date.now() - wallStart) / 1000;
      await runTab.getByRole("button", { name: "Resume", exact: true }).click();
      await expect(stage).toHaveText("Flying", { timeout: 30_000 });
      const resumedStage = await text("sitl-stage"), resumedAtSimS = await simTime();
      const hold = await holdFor(CRITERIA.holdSimS);
      holds.afterResume = hold;
      const log = runTab.getByTestId("sitl-pauses").getByRole("listitem");
      const first = log.first(), logText = (await log.count()) > 0 ? (await first.textContent()) ?? "" : "";
      return {
        stage: pausedStage, before, after, wallS, resumedStage, resumedAtSimS, hold,
        failsafeMessages: await failsafeMessages(),
        log: { count: await log.count(), reason: (await log.count()) > 0 ? (await first.getAttribute("data-reason")) ?? "" : "",
          wallS: Number(/resumed after ([0-9.]+) s/.exec(logText)?.[1] ?? Number.NaN) },
      };
    });

    await steps.run("landing", async () => {
      await runTab.getByRole("button", { name: "Land" }).click();
      await expect(runTab.getByTestId("sitl-mode")).toHaveText("LAND", { timeout: 30_000 });
      const mode = await text("sitl-mode");
      await expect(runTab.getByTestId("sitl-armed")).toHaveText("Disarmed", { timeout: 180_000 }).catch(async (error: unknown) => {
        // What was still moving when it did not land: whether the simulated time and each frame counter advance tells where a stall is.
        const reading = async () => ({ simS: await text("sitl-sim-time"), frames: await text("sitl-frames"), stage: await text("sitl-stage"), armed: await text("sitl-armed"), altitudeM: await altitude() });
        const first = await reading();
        await page.waitForTimeout(5000);
        const alerts = await runTab.getByRole("alert").allTextContents().catch(() => []);
        throw new Error(`Not disarmed: ${JSON.stringify({ first, fiveSecondsLater: await reading(), alerts })} (${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)})`);
      });
      await expect(stage).toHaveAttribute("data-state", "ready", { timeout: 60_000 });
      // On its supports at rest: the CG settles on the gear within a second or two of the disarm.
      await page.waitForTimeout(2000);
      const speedometer = runTab.getByTestId("sitl-speed");
      speed = { verdict: await text("sitl-speed-verdict"), average: Number.parseFloat((await speedometer.getAttribute("data-average")) ?? "") || null,
        dropped: Number((await runTab.getByTestId("sitl-dropped").getAttribute("data-count").catch(() => "0")) ?? "0"),
        simElapsedS: Number(await speedometer.getAttribute("data-sim-elapsed")), runningWallS: Number(await speedometer.getAttribute("data-running-wall")) };
      limitEvents = await runTab.getByTestId("power-events").getByRole("listitem").allTextContents();
      return { mode, armed: await text("sitl-armed"), state: (await stage.getAttribute("data-state")) ?? "", ready: await text("sitl-ready"),
        altitudeM: await altitude(), restAltitudeM: await restHeight(page, profileSha256), frames: await text("sitl-frames"),
        failsafeMessages: await failsafeMessages() };
    });

    // Stop runs after a failed step too, unless no run started.
    if (runPid !== 0) await steps.run("stop", async () => {
      // A fault may have stopped the run already: its Stop button is then disabled, and waiting on it would only use up the test's time.
      const stop = runTab.getByRole("button", { name: "Stop run" });
      if (await stop.isEnabled()) await stop.click();
      await expect(stage).toHaveAttribute("data-state", "idle", { timeout: 60_000 });
      const run = (await launcherExperiments(launcher.port, token, ORIGIN))[0]?.runs.at(-1);
      return { state: (await stage.getAttribute("data-state")) ?? "", text: await text("sitl-stage"), launcherState: run?.state ?? "missing",
        group: psGroup(runPid), members: groupMembers(runPid), signalZero: signalZeroCode(runPid), processes: processesNaming(home).length };
    }, true);

    // TASK-188: the stopped run, as the Experiments tab reopens it, and its recording read back.
    await steps.run("reopen", async () => {
      await page.getByRole("tab", { name: "Experiments", exact: true }).click();
      const panel = page.getByRole("tabpanel", { name: "Experiments", exact: true }), rows = panel.getByTestId("experiment-list").locator("tbody tr");
      await expect(rows.first()).toBeVisible({ timeout: 30_000 });
      const listed = await rows.count();
      await rows.first().getByRole("button").click();
      const detail = panel.getByTestId("experiment-detail");
      await expect(detail).toBeVisible();
      const line = async (name: string) => (await detail.locator("dt", { hasText: name }).locator("+ dd").textContent()) ?? "";
      const record = await experimentRecord(page, projectId), id = field(record.payload, "recording", "recordId");
      if (typeof id !== "string") throw new Error("The experiment names no recording");
      await recording(page, id);
      const opened = await page.evaluate(async ({ urls, id }) => {
        const { reopenRecording } = await import(urls.recordings) as Recordings;
        const reopened = await reopenRecording(id);
        return { truthRows: reopened.rows.get("truth.position")?.length ?? 0, missingChunks: reopened.missingChunks.length, corruptChunks: reopened.corruptChunks.length };
      }, { urls, id });
      return { listed, recordId: id, recordingText: await line("Recording"), profileText: await line("Aircraft profile"), ...opened };
    });
  } finally {
    // A failed step may leave the run going; stop it through the API before closing the launcher.
    await stopEveryRun(launcher.port, token, ORIGIN).catch(() => undefined);
    const directory = join(OUT, configuration.id);
    mkdirSync(directory, { recursive: true });
    const dataflash = [];
    let steadiness: { hold: Steadiness | null; afterResume: Steadiness | null } | null = null;
    let flownSettings: { name: string; value: number | null }[] = [];
    if (experimentId !== null) {
      const logs = await launcherCall(launcher.port, token, ORIGIN, "GET", `/v1/experiments/${encodeURIComponent(experimentId)}/logs`).catch(() => null);
      const attachments = field(logs?.json, "attachments");
      const list: readonly unknown[] = Array.isArray(attachments) ? attachments : [];
      for (const attachment of list) {
        const name = field(attachment, "name");
        if (typeof name !== "string") continue;
        const response = await fetch(`http://127.0.0.1:${launcher.port}/v1/experiments/${encodeURIComponent(experimentId)}/dataflash/${encodeURIComponent(name)}`,
          { headers: { authorization: `Bearer ${token}`, origin: ORIGIN } });
        const bytes = Buffer.from(await response.arrayBuffer()), hash = sha256(bytes);
        writeFileSync(join(directory, name), bytes);
        // The file as downloaded must be the file the launcher hashed when it attached it.
        const status = hash === field(attachment, "sha256") ? String(field(attachment, "status")) : `differs from the launcher's SHA-256 ${String(field(attachment, "sha256"))}`;
        dataflash.push({ name, bytes: bytes.length, sha256: hash, status, records: Number(field(attachment, "records")),
          truncatedBytes: Number(field(attachment, "truncatedBytes")), firmwareMatchesBuild: field(attachment, "firmware", "matchesBuild") === true,
          file: join(configuration.id, name) });
        // The log's clock is the run's simulated time, so the holds' windows apply to it.
        const flightLog = readDataFlash(new Uint8Array(bytes)), of = (held: HoldFacts | null) => (held ? steadinessOf(flightLog, held.startSimS, held.endSimS) : null);
        steadiness = { hold: of(holds.first), afterResume: of(holds.afterResume) };
        flownSettings = flownSettingsOf(flightLog, holds.first?.startSimS ?? Number.POSITIVE_INFINITY);
      }
    }
    const record = projectId === "" ? null : await experimentRecord(page, projectId).catch(() => null);
    const recordId = field(record?.payload, "recording", "recordId");
    const entry = typeof recordId === "string" ? await recording(page, recordId) : null;
    await launcher.close();
    rmSync(home, { recursive: true, force: true });
    const run = {
      schema: RUN_SCHEMA, configuration: configuration.id, settings: SETTINGS, startedAt, finishedAt: new Date().toISOString(),
      browser: { version: browserVersion, userAgent: await page.evaluate(() => navigator.userAgent), headless: process.env.MIRAGE_BROWSER_HEADED !== "1",
        renderer: await page.evaluate(() => {
          const gl = document.createElement("canvas").getContext("webgl2"), info = gl?.getExtension("WEBGL_debug_renderer_info");
          return info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "no WebGL2";
        }) },
      steps: Object.fromEntries(STEPS.map(id => [id, steps.records[id]])),
      captures: {
        launcherExperimentId: experimentId, dataflash,
        recording: entry === null || typeof recordId !== "string" ? null : {
          recordId, status: String(field(entry, "status")), chunks: Number(field(entry, "chunks")), bytes: Number(field(entry, "bytes")),
          droppedChunks: Number(field(entry, "droppedChunks")), droppedRows: Number(field(entry, "droppedRows")), producerLost: Number(field(entry, "producerLost")) },
        speed, power: hover === null ? null : { hover, limitEvents }, steadiness, flownSettings,
      },
    };
    writeFileSync(join(OUT, `${configuration.id}.json`), `${JSON.stringify(run, null, 2)}\n`);
  }
  // The run file is checked as the runner checks it, and every workflow must pass.
  const judged = judgeRun(parseNominalRun(JSON.parse(readFileSync(join(OUT, `${configuration.id}.json`), "utf8"))));
  expect(Object.fromEntries(Object.entries(judged).filter(([, verdict]) => verdict.verdict !== "PASS"))).toEqual({});
}
