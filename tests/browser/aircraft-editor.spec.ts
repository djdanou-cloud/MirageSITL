import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { viteFileUrl } from "../support/vite-url";
import { RECIPES, profileDifferences, rotate, toRender } from "../support/aircraft-recipes";
import { build, createProject, group, panel } from "../support/aircraft-ui";
import { standardGearHeights } from "../support/standard-gear";
import type { VehicleManifest } from "../../packages/physics/src/vehicle-manifest";

// TASK-141 (S03): the Aircraft tab. Each S19 configuration is built through
// the UI alone from its recipe; the saved profile must match the fixture, and
// the rotors drawn in the 3D scheme, read back from the Three.js scene graph,
// must sit where the derived vehicle manifest puts them, point along its
// thrust axes and show its spins.
type Store = typeof import("../../packages/project/src/store");
type Derivation = typeof import("../../packages/aircraft/src/derive-manifest");
type Support = typeof import("../support/aircraft-derivation");
const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  derivation: viteFileUrl(new URL("../../packages/aircraft/src/derive-manifest.ts", import.meta.url)),
  support: viteFileUrl(new URL("../support/aircraft-derivation.ts", import.meta.url)),
};
/** Rendered poses agree with the manifest to this, in metres and unit-vector components. */
const POSE_TOLERANCE = 1e-9;

interface Rendered { motorId: number; position: number[]; axis: number[]; spin: string; label: string }
interface ManifestRotor { id: number; hubPositionBodyM: number[]; hubToBody: number[]; spinSign: number }
interface StoredProfile {
  arms: { id: number; azimuthRad: number; outwardTiltRad: number; sideTiltRad: number }[];
  motors: { id: number }[];
}

/** The newest stored version of a profile, and the manifest derived from it and from a fixture, computed in the page. */
async function storedAndDerived(page: Page, name: string, fixtureText: string): Promise<{ sha256: string; profile: StoredProfile; built: ManifestRotor[]; reference: ManifestRotor[] }> {
  return page.evaluate(async ({ urls, name, fixtureText }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { deriveVehicleManifest } = await import(urls.derivation) as Derivation;
    const { syntheticComponents } = await import(urls.support) as Support;
    const store = await ProjectStore.openIndexedDb();
    try {
      const projects = await store.listProjects();
      const heads = (await Promise.all(projects.map(project => store.listItems(project.record.id, "aircraft-profile")))).flat();
      const head = heads.find(stored => stored.record.name === name);
      if (!head) throw new Error(`No stored profile ${name}`);
      const derive = async (input: unknown) => {
        const profile = JSON.parse(JSON.stringify(input)) as Parameters<Support["syntheticComponents"]>[0];
        const derived = await deriveVehicleManifest(profile, syntheticComponents(profile), { modelId: 141 });
        return derived.manifest.rotors.map(rotor => ({ id: rotor.id, hubPositionBodyM: [...rotor.hubPositionBodyM], hubToBody: [...rotor.hubToBody], spinSign: rotor.spinSign }));
      };
      return {
        sha256: head.sha256, profile: JSON.parse(JSON.stringify(head.record.payload)) as StoredProfile,
        built: await derive(head.record.payload), reference: await derive(JSON.parse(fixtureText)),
      };
    } finally {
      store.close();
    }
  }, { urls, name, fixtureText });
}
async function rendered(page: Page, count: number): Promise<Rendered[]> {
  const scheme = panel(page).getByTestId("aircraft-scheme");
  await expect(scheme).toHaveAttribute("data-current", "true");
  await expect.poll(async () => (JSON.parse(await scheme.getAttribute("data-rendered") ?? "[]") as unknown[]).length).toBe(count);
  return JSON.parse(await scheme.getAttribute("data-rendered") ?? "[]") as Rendered[];
}
function poseDifferences(drawn: readonly Rendered[], manifest: readonly ManifestRotor[]): string[] {
  const differences: string[] = [];
  if (drawn.length !== manifest.length) differences.push(`${drawn.length} rotors drawn, ${manifest.length} in the manifest`);
  for (const rotor of manifest) {
    const shown = drawn.find(item => item.motorId === rotor.id);
    if (!shown) {
      differences.push(`rotor ${rotor.id} is not drawn`);
      continue;
    }
    const position = toRender(rotor.hubPositionBodyM), axis = toRender(rotate(rotor.hubToBody, [0, 0, 1]));
    position.forEach((value, i) => { if (!(Math.abs(shown.position[i]! - value) <= POSE_TOLERANCE)) differences.push(`rotor ${rotor.id} position ${i}: ${shown.position[i]} != ${value}`); });
    axis.forEach((value, i) => { if (!(Math.abs(shown.axis[i]! - value) <= POSE_TOLERANCE)) differences.push(`rotor ${rotor.id} axis ${i}: ${shown.axis[i]} != ${value}`); });
    if (shown.spin !== (rotor.spinSign === 1 ? "ccw" : "cw")) differences.push(`rotor ${rotor.id} spin ${shown.spin}`);
    if (shown.label !== String(rotor.id)) differences.push(`rotor ${rotor.id} label ${shown.label}`);
  }
  return differences;
}

for (const recipe of RECIPES) {
  test(`${recipe.name} is built through the UI alone and drawn where its manifest puts each rotor`, async ({ page }) => {
    const fixtureText = readFileSync(new URL(`../fixtures/aircraft/${recipe.fixture}.json`, import.meta.url), "utf8");
    await page.goto("/");
    await createProject(page, `${recipe.name} trials`);
    await build(page, recipe);
    const result = await storedAndDerived(page, recipe.name, fixtureText);
    expect(profileDifferences(result.profile, JSON.parse(fixtureText) as StoredProfile)).toEqual([]);
    const drawn = await rendered(page, result.profile.motors.length);
    expect(poseDifferences(drawn, result.built)).toEqual([]);
    // The fixture's own manifest agrees within the same tolerance.
    expect(poseDifferences(drawn, result.reference)).toEqual([]);
  });
}

test("invalid edits are blocked with a reason, and a copy leaves the original unchanged", async ({ page }) => {
  const quad = RECIPES[0]!;
  await page.goto("/");
  await createProject(page, "Editor checks");
  await build(page, quad);
  const tab = panel(page), problems = tab.getByRole("list", { name: "Problems to fix before saving" });
  const save = tab.getByRole("button", { name: "Save profile", exact: true });
  const original = await storedAndDerived(page, quad.name, readFileSync(new URL("../fixtures/aircraft/quad-x.json", import.meta.url), "utf8"));

  // A spin edit reaches the scheme; it is a valid change.
  await group(tab, "Arm 1 motor").getByLabel("Spin", { exact: true }).selectOption({ label: "Clockwise" });
  await expect.poll(async () => (await rendered(page, 4)).find(rotor => rotor.motorId === 1)?.spin).toBe("cw");
  await expect(save).toBeEnabled();
  // A repeated output, an unreadable length and a ninth arm are refused with their reasons.
  await group(tab, "Arm 2 motor").getByLabel("ArduPilot output", { exact: true }).fill("1");
  await expect(problems).toContainText("Output 1 is assigned to motors 1 and 4");
  await expect(save).toBeDisabled();
  await expect(tab.getByTestId("aircraft-scheme")).toHaveAttribute("data-current", "false");
  await group(tab, "Arm 1").getByLabel("Length (m)", { exact: true }).fill("long");
  await expect(problems).toContainText("Arm 1 length is not a decimal number");
  await tab.getByLabel("Number of arms", { exact: true }).fill("9");
  await tab.getByRole("button", { name: "Lay out arms", exact: true }).click();
  await expect(tab.getByRole("list", { name: "Layout errors" })).toContainText("The layout needs 1 to 8 arms");
  await expect(tab.getByRole("button", { name: "Open Quad X" })).toHaveCount(0);
  await tab.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(group(tab, "Arm 1").getByLabel("Length (m)", { exact: true })).toHaveValue("0.225");
  await expect(save).toBeDisabled();

  // Copy: a new profile; the original keeps its only version.
  await tab.getByLabel("Copy as", { exact: true }).fill("Quad X copy");
  await tab.getByRole("button", { name: "Copy profile", exact: true }).click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText("Copied Quad X to Quad X copy; the original is unchanged.");
  await expect(tab.getByRole("list", { name: "Aircraft profiles" }).getByRole("listitem")).toHaveCount(2);
  const after = await storedAndDerived(page, quad.name, readFileSync(new URL("../fixtures/aircraft/quad-x.json", import.meta.url), "utf8"));
  expect(after.sha256).toBe(original.sha256);

  // After a reload the copy opens with the saved values, and the open tab fits 390 px and passes axe.
  await page.reload();
  await page.getByRole("tab", { name: "Aircraft", exact: true }).click();
  await tab.getByRole("button", { name: "Open Quad X copy", exact: true }).click();
  await expect(group(tab, "Arm 1").getByLabel("Length (m)", { exact: true })).toHaveValue("0.225");
  await expect(group(tab, "Arm 2 motor").getByLabel("Motor number", { exact: true })).toHaveValue("4");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});

/**
 * TASK-194: the newest saved profile of a project, on the example cards, flown in the physics Worker on equal pilot throttle:
 * armed at rest, a vertical-speed loop up a metre above the rest height, then down at 0.5 m/s to a landing. Returns the derived
 * manifest, the heights, the tilt and every accident the Worker posted, each worded by `describeAccident`.
 */
async function flySaved(page: Page, projectName: string) {
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const wasm = readFileSync("packages/wasm-bet/dist/mirage_bet.scalar.wasm");
  const input = {
    bytes: Array.from(wasm), wasmSha256: createHash("sha256").update(wasm).digest("hex"), projectName,
    contactBytes: Array.from(readFileSync("packages/physics/dist/contact/contact.wasm")),
    contactManifest: JSON.parse(readFileSync("packages/physics/dist/contact/manifest.json", "utf8")) as unknown,
    cards: Object.fromEntries(["motor", "propeller", "esc", "battery"].map(type => [type, read(`../fixtures/components/${type}-example.json`)])),
    urls: {
      ...urls, worker: viteFileUrl(new URL("../../apps/web/src/physics.worker.ts", import.meta.url)),
      protocol: viteFileUrl(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
      components: viteFileUrl(new URL("../../packages/aircraft/src/components.ts", import.meta.url)),
      resolve: viteFileUrl(new URL("../../packages/aircraft/src/resolve-components.ts", import.meta.url)),
      accident: viteFileUrl(new URL("../../packages/physics/src/accident.ts", import.meta.url)),
    },
  };
  return page.evaluate(async ({ bytes, wasmSha256, contactBytes, contactManifest, cards, urls, projectName }) => {
    const p = await import(urls.protocol) as typeof import("@mirage/protocol");
    const { ProjectStore } = await import(urls.store) as Store;
    const profiles = await import(urls.profile) as typeof import("@mirage/aircraft/profile");
    const components = await import(urls.components) as typeof import("@mirage/aircraft/components");
    const resolver = await import(urls.resolve) as typeof import("@mirage/aircraft/resolve-components");
    const derivation = await import(urls.derivation) as Derivation;
    const accidents = await import(urls.accident) as typeof import("@mirage/physics/accident");
    const store = await ProjectStore.openIndexedDb();
    let stored: unknown;
    try {
      const project = (await store.listProjects()).find(item => item.record.name === projectName);
      const [item] = project ? await store.listItems(project.record.id, "aircraft-profile") : [];
      stored = item?.record.payload;
    } finally { store.close(); }
    const saved = profiles.validateAircraftProfile(stored);
    const ids = { motor: "11".repeat(32), propeller: "22".repeat(32), esc: "33".repeat(32), battery: "44".repeat(32) };
    const fitted = profiles.withPropellerPolars(profiles.validateAircraftProfile({ ...saved, battery: { card: ids.battery },
      motors: saved.motors.map(motor => ({ ...motor, components: { motor: ids.motor, propeller: ids.propeller, esc: ids.esc } })) }),
    [{ card: ids.propeller, polar: "naca6409-neuralfoil-v1" }]);
    const cardMap = new Map(Object.entries(cards).map(([type, value]) => [ids[type as keyof typeof ids], components.validateComponentCard(value)]));
    const resolved = resolver.resolveComponents(fitted, cardMap);
    if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join("; ")}`);
    const derived = await derivation.deriveVehicleManifest(fitted, resolved.components, { modelId: 194 });
    const stateBuffer = p.createSharedMemoryV2(), worker = new Worker(urls.worker, { type: "module" });
    const struck: string[] = [];
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown; events?: unknown };
      if (data.type === "accident.events" && Array.isArray(data.events)) {
        for (const item of data.events as import("@mirage/physics/accident").AccidentEvent[]) struck.push(accidents.describeAccident(item));
      }
    });
    const next = (predicate: (data: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker timeout")), 60000);
      const listener = (event: MessageEvent<unknown>): void => {
        const data = event.data;
        if (typeof data === "object" && data !== null && predicate(data as Record<string, unknown>)) {
          clearTimeout(timer); worker.removeEventListener("message", listener); resolve(data as Record<string, unknown>);
        }
      };
      worker.addEventListener("message", listener);
    });
    try {
      const reader = new p.StateReaderV2(stateBuffer), header = p.newHeaderSnapshotV2(), state = p.newFlightStateV2(), pilot = new p.PilotWriterV2(stateBuffer);
      const ready = next(d => d.type === "ready-v2");
      worker.postMessage({ type: "init-v2", protocolVersion: 2, stateBuffer, sensorBuffer: p.createSpscQueue("sensor"), actuatorBuffer: p.createSpscQueue("actuator") });
      await ready;
      for (const [message, done] of [[{ type: "bet.module", bytes: new Uint8Array(bytes), sha256: wasmSha256 }, "bet.module.ready"],
        [{ type: "contact.module", bytes: new Uint8Array(contactBytes), manifest: contactManifest }, "contact.module.ready"],
        [{ type: "model.register", bytes: derived.bytes, sha256: derived.sha256 }, "model.registered"]] as const) {
        const reply = next(d => d.type === done);
        worker.postMessage(message);
        await reply;
      }
      const final = (id: number) => (d: Record<string, unknown>) => d.requestId === id && (d.type === "reject-v2" || (d.type === "ack-v2" && d.status === "applied"));
      for (const [id, command] of [[1, { type: "model.load", modelId: 194, manifestSha256: derived.sha256 }], [2, { type: "sim.start" }]] as const) {
        reader.readHeader(header);
        const result = next(final(id));
        worker.postMessage({ protocolVersion: 2, requestId: id, expectedEpoch: header.sessionEpoch, ...command });
        const reply = await result;
        if (reply.type !== "ack-v2") throw new Error(`${command.type} refused: ${JSON.stringify(reply)}`);
      }
      reader.readHeader(header);
      const sample = p.newPilotInputV2();
      sample.expectedEpoch = header.sessionEpoch; sample.flags = 3;
      let sampleId = 0, maxTiltRad = 0, highestM = -Infinity;
      const publish = (throttle: number) => {
        sample.throttle = throttle; sample.sampledWallTimeMs = performance.timeOrigin + performance.now(); sample.inputSampleId = ++sampleId;
        pilot.publish(sample);
      };
      const wait = () => new Promise(resolve => setTimeout(resolve, 20));
      const height = () => {
        if (!reader.latest(state)) throw new Error("No state published");
        maxTiltRad = Math.max(maxTiltRad, Math.acos(Math.min(1, 1 - 2 * (state.qx * state.qx + state.qy * state.qy))));
        highestM = Math.max(highestM, -state.downM);
        return -state.downM;
      };
      const hold = async (throttle: number, ms: number) => {
        for (const end = performance.now() + ms; performance.now() < end; await wait()) { publish(throttle); height(); }
      };
      // Armed at zero throttle, standing on the gear.
      await hold(0, 1500);
      const restBefore = height();
      // Equal throttle on a vertical-speed loop: up at 1 m/s to a metre above the rest height, then down at 0.5 m/s.
      let integral = 0.3;
      const fly = (vdRef: number) => {
        const error = state.vdMps - vdRef;
        integral = Math.min(1, Math.max(0, integral + 0.6 * error * 0.02));
        publish(Math.min(1, Math.max(0, integral + 0.2 * error)));
      };
      for (const end = performance.now() + 10000; height() < restBefore + 1 && performance.now() < end; await wait()) fly(-1);
      for (const end = performance.now() + 15000; height() > restBefore + 0.003 && performance.now() < end; await wait()) fly(0.5);
      await hold(0, 3000);
      return { manifest: JSON.parse(JSON.stringify(derived.manifest)) as unknown, restBefore, restAfter: height(), highestM, maxTiltRad,
        schemaVersion: saved.schemaVersion, gear: profiles.landingGearOf(saved), struck,
        paused: (state.vehicleFlags & p.VehicleFlagV2.Paused) !== 0 };
    } finally { worker.terminate(); }
  }, input);
}

// TASK-194: a landing gear described through the Aircraft tab alone. Its refusals come back with their reasons, the scheme draws
// each foot where the profile puts it, and the saved profile, on the example cards, stands, takes off and lands on it in the
// physics Worker: rest within 1 mm of rigid-plate statics on the manifest's supports (tests/support/standard-gear.ts) before and
// after, a climb of a metre, and a tilt below 2 degrees on equal pilot throttle with the CG centred.
test("a landing gear is described through the UI alone, drawn where it is, and a flight session stands, takes off and lands on it", async ({ page }) => {
  test.setTimeout(300_000);
  execFileSync(process.execPath, ["scripts/build-wasm.mjs"], { stdio: "pipe" });
  execFileSync(process.execPath, ["scripts/build-contact.mjs"], { stdio: "pipe" });
  const quad = RECIPES[0]!;
  await page.goto("/");
  await createProject(page, "Gear checks");
  await build(page, quad);
  const tab = panel(page), problems = tab.getByRole("list", { name: "Problems to fix before saving" });
  const save = tab.getByRole("button", { name: "Save profile", exact: true });
  // The CG centred, so equal throttle lifts the aircraft level.
  await tab.getByLabel("Aircraft CG x (m)", { exact: true }).fill("0");
  await tab.getByLabel("Describe the landing gear", { exact: true }).check();
  await expect(tab.getByLabel("Ground clearance (m, optional)", { exact: true })).toBeDisabled();
  await expect(tab.getByLabel("Ground clearance (m, optional)", { exact: true })).toHaveValue("");
  const feet = [[0.16, 0.16, 0.11], [0.16, -0.16, 0.11], [-0.16, -0.16, 0.11], [-0.16, 0.16, 0.11]];
  for (const [i, foot] of feet.entries()) {
    for (const [a, axis] of ["x", "y", "z"].entries()) await tab.getByLabel(`Support ${i + 1} ${axis} (m)`, { exact: true }).fill(String(foot[a]));
  }
  await tab.getByLabel("Where the positions come from", { exact: true }).fill("Frame drawing");
  await tab.getByLabel("Strut stiffness (N/m)", { exact: true }).fill("1800");
  await tab.getByLabel("Strut stiffness source", { exact: true }).fill("Bench compression test");
  await tab.getByLabel("Strut travel (m)", { exact: true }).fill("0.03");
  await tab.getByLabel("Strut travel source", { exact: true }).fill("Datasheet");
  await expect(problems).toHaveCount(0);
  await expect(tab.getByTestId("gear-flown-strutStiffnessNpm")).toHaveText("1800");
  await expect(tab.getByTestId("gear-flown-strutDampingNspm")).toContainText("(assumed)");

  // Refused with their reasons: no travel, a rim outside its foot, and the CG outside the support polygon.
  await tab.getByLabel("Strut travel (m)", { exact: true }).fill("0");
  await expect(problems).toContainText("The strut travel must be above 0 m");
  await expect(save).toBeDisabled();
  await tab.getByLabel("Strut travel (m)", { exact: true }).fill("0.03");
  await tab.getByLabel("Rim radius (m)", { exact: true }).fill("0.02");
  await tab.getByLabel("Rim radius source", { exact: true }).fill("Caliper");
  await expect(problems).toContainText("must be below the foot radius 0.01 m");
  await tab.getByLabel("Rim radius (m)", { exact: true }).fill("");
  await tab.getByLabel("Rim radius source", { exact: true }).fill("");
  for (const i of [3, 4]) await tab.getByLabel(`Support ${i} x (m)`, { exact: true }).fill("0.05");
  await expect(problems).toContainText("lies outside the support polygon of the feet seen from above");
  for (const i of [3, 4]) await tab.getByLabel(`Support ${i} x (m)`, { exact: true }).fill("-0.16");
  await expect(problems).toHaveCount(0);
  await save.click();
  await expect(tab.getByTestId("aircraft-status")).toHaveText(`Saved version 2 of ${quad.name}.`);

  // The scheme draws each foot at its bottom point (render axes: right, up, back).
  const scheme = tab.getByTestId("aircraft-scheme");
  await expect.poll(async () => (JSON.parse(await scheme.getAttribute("data-rendered-gear") ?? "[]") as unknown[]).length).toBe(4);
  const drawn = JSON.parse(await scheme.getAttribute("data-rendered-gear") ?? "[]") as number[][];
  drawn.forEach((position, i) => position.forEach((value, a) => expect(Math.abs(value - toRender(feet[i]!)[a]!), `foot ${i + 1}`).toBeLessThan(1e-9)));

  // The saved version flies in the physics Worker on the example cards; the gear is the one the UI stored.
  const flight = await flySaved(page, "Gear checks");
  expect(flight.schemaVersion).toBe(8);
  expect(flight.struck, "accidents").toEqual([]);
  expect(flight.gear).toMatchObject({ kind: "legs", positionSource: "Frame drawing", feetBodyM: feet,
    values: { strutStiffnessNpm: 1800, strutTravelM: 0.03, strutDampingNspm: null }, provenance: { strutStiffnessNpm: "Bench compression test" } });
  const { restM } = standardGearHeights(flight.manifest as VehicleManifest);
  expect(Math.abs(flight.restBefore - restM), "rest height before the flight").toBeLessThan(1e-3);
  expect(flight.highestM - flight.restBefore, "climb").toBeGreaterThan(0.95);
  expect(Math.abs(flight.restAfter - restM), "rest height after landing").toBeLessThan(1e-3);
  expect(flight.maxTiltRad, "tilt").toBeLessThan((2 * Math.PI) / 180);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
});
