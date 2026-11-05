// Browser-test support for the Run tab's ArduPilot SITL panel (TASK-154):
// seeding a project with the S19 quad X profile through the application's
// own store modules, reading experiment records back from IndexedDB, the
// launcher API as Node sees it (token in the Authorization header, the
// configured Origin), and the process checks that prove a run left no owned
// process behind. Everything read from the launcher or the page starts as
// unknown and is narrowed here.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { createServer as createViteServer } from "vite";
import { viteFileUrl } from "./vite-url";

type Store = typeof import("../../packages/project/src/store");
type Profiles = typeof import("../../packages/aircraft/src/profile");
type Navigation = typeof import("../../apps/web/src/shell/navigation");
type Experiments = typeof import("../../packages/aircraft/src/experiment");
type Sensors = typeof import("../../packages/aircraft/src/sensor-ownership");
type Schema = typeof import("../../packages/project/src/schema");
type SensorFields = typeof import("../../packages/aircraft/src/sensor-fields");
type Components = typeof import("../../packages/aircraft/src/components");
type Derivation = typeof import("../../packages/aircraft/src/derive-manifest");
type Resolution = typeof import("../../packages/aircraft/src/resolve-components");
type SitlRun = typeof import("../../apps/web/src/sitl/sitl-run");

const urls = {
  store: viteFileUrl(new URL("../../packages/project/src/store.ts", import.meta.url)),
  profile: viteFileUrl(new URL("../../packages/aircraft/src/profile.ts", import.meta.url)),
  navigation: viteFileUrl(new URL("../../apps/web/src/shell/navigation.ts", import.meta.url)),
  experiment: viteFileUrl(new URL("../../packages/aircraft/src/experiment.ts", import.meta.url)),
  sensors: viteFileUrl(new URL("../../packages/aircraft/src/sensor-ownership.ts", import.meta.url)),
  schema: viteFileUrl(new URL("../../packages/project/src/schema.ts", import.meta.url)),
  sensorFields: viteFileUrl(new URL("../../packages/aircraft/src/sensor-fields.ts", import.meta.url)),
  sitlRun: viteFileUrl(new URL("../../apps/web/src/sitl/sitl-run.ts", import.meta.url)),
};
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const QUAD = read("../fixtures/aircraft/quad-x.json");
/** The five S19 configurations (TASK-138 fixtures). */
export const S19_FIXTURES = ["quad-x", "hexa-x", "octa-x", "coaxial-x8", "octa-coaxial-16"] as const;
const CARDS = Object.fromEntries(["motor", "propeller", "esc", "battery"].map(type => [type, read(`../fixtures/components/${type}-example.json`)]));

export interface SeededProject {
  readonly projectId: string;
  /** Address of the stored quad X profile version. */
  readonly profileSha256: string;
}

export interface SeedOptions {
  /**
   * Configures two MirageSITL-owned sensor error terms, an IMU accelerometer
   * bias (imu.accelBiasMps2) and a battery voltage offset
   * (battery.voltageOffsetV), which the external-SITL path cannot apply yet.
   */
  readonly mirageOwnedSensorErrors?: boolean;
  /** The Sensors tab's Ideal sensors: this run switches ArduPilot's removable errors off (TASK-089). */
  readonly idealSensors?: boolean;
  /** Moves the aircraft's CG to this body FRD offset, m (TASK-156: a nose-heavy quad that tips over on take-off). */
  readonly cgOffsetBodyM?: readonly [number, number, number];
}

/** Creates a project with the example component cards and the S19 quad X profile, and opens it on the Run tab after a reload. */
export async function seedQuadProject(page: Page, profileName: string, options: SeedOptions = {}): Promise<SeededProject> {
  await page.goto("/");
  const seeded = await page.evaluate(async ({ urls, quad, cards, profileName, mirageOwned, ideal, cg }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDraft, validateAircraftProfile, withPropellerPolars, withSensorConfiguration } = await import(urls.profile) as Profiles;
    const { DEFAULT_SENSOR_CONFIGURATION: D } = await import(urls.sensorFields) as SensorFields;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("SITL project");
      const ids: Record<string, string> = {};
      for (const [type, text] of Object.entries(cards)) {
        const card: unknown = JSON.parse(text);
        if (typeof card !== "object" || card === null) throw new Error(`Invalid ${type} card fixture`);
        const values: unknown = Reflect.get(card, "values");
        const provenance = Object.fromEntries(Object.entries(typeof values === "object" && values !== null ? values : {})
          .map(([key, value]) => [key, value === null ? null : "example"]));
        const stored = await store.createItem(project.record.id, "component-card", { name: `Example ${type}`, payload: { ...card, provenance } });
        ids[type] = stored.sha256;
      }
      const propeller = ids.propeller, motor = ids.motor, esc = ids.esc, battery = ids.battery;
      if (propeller === undefined || motor === undefined || esc === undefined || battery === undefined) throw new Error("A component card fixture is missing");
      const parsed = validateAircraftProfile(JSON.parse(quad));
      const fixture = cg ? validateAircraftProfile({ ...parsed, massProperties: { ...parsed.massProperties, cgOffsetBodyM: cg } }) : parsed;
      const polared = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: battery },
        motors: fixture.motors.map(entry => ({ ...entry, components: { motor, propeller, esc } })) }),
      [{ card: propeller, polar: "naca6409-neuralfoil-v1" }]);
      const profile = mirageOwned
        ? withSensorConfiguration(polared, { ...D, imu: { ...D.imu, accelBiasMps2: [0.1, 0, 0] }, battery: { ...D.battery, voltageOffsetV: 0.1 } })
        : ideal ? withSensorConfiguration(polared, { ...D, mode: "ideal" }) : polared;
      const stored = await store.createItem(project.record.id, "aircraft-profile", profileDraft(profileName, profile));
      await saveNavigation(store, { tab: "run", projectId: project.record.id });
      return { projectId: project.record.id, profileSha256: stored.sha256 };
    } finally {
      store.close();
    }
  }, { urls, quad: QUAD, cards: CARDS, profileName, mirageOwned: options.mirageOwnedSensorErrors === true, ideal: options.idealSensors === true, cg: options.cgOffsetBodyM ? [...options.cgOffsetBodyM] : null });
  await page.reload();
  return seeded;
}

/**
 * Creates a project with the example cards and one profile per named S19
 * fixture (named after the fixture), every motor on the example motor,
 * propeller and ESC, and opens it on the Run tab after a reload.
 */
export async function seedProfiles(page: Page, fixtures: readonly (typeof S19_FIXTURES)[number][]): Promise<{ projectId: string; profiles: Record<string, string> }> {
  const texts = Object.fromEntries(fixtures.map(name => [name, read(`../fixtures/aircraft/${name}.json`)]));
  await page.goto("/");
  const seeded = await page.evaluate(async ({ urls, texts, cards }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { profileDraft, validateAircraftProfile, withPropellerPolars } = await import(urls.profile) as Profiles;
    const { saveNavigation } = await import(urls.navigation) as Navigation;
    const store = await ProjectStore.openIndexedDb();
    try {
      const project = await store.createProject("Flight view project");
      const ids: Record<string, string> = {};
      for (const [type, text] of Object.entries(cards)) {
        const card: unknown = JSON.parse(text);
        if (typeof card !== "object" || card === null) throw new Error(`Invalid ${type} card fixture`);
        const values: unknown = Reflect.get(card, "values");
        const provenance = Object.fromEntries(Object.entries(typeof values === "object" && values !== null ? values : {})
          .map(([key, value]) => [key, value === null ? null : "example"]));
        ids[type] = (await store.createItem(project.record.id, "component-card", { name: `Example ${type}`, payload: { ...card, provenance } })).sha256;
      }
      const propeller = ids.propeller, motor = ids.motor, esc = ids.esc, battery = ids.battery;
      if (propeller === undefined || motor === undefined || esc === undefined || battery === undefined) throw new Error("A component card fixture is missing");
      const profiles: Record<string, string> = {};
      for (const [name, text] of Object.entries(texts)) {
        const fixture = validateAircraftProfile(JSON.parse(text));
        const profile = withPropellerPolars(validateAircraftProfile({ ...fixture, battery: { card: battery },
          motors: fixture.motors.map(entry => ({ ...entry, components: { motor, propeller, esc } })) }), [{ card: propeller, polar: "naca6409-neuralfoil-v1" }]);
        profiles[name] = (await store.createItem(project.record.id, "aircraft-profile", profileDraft(name, profile))).sha256;
      }
      await saveNavigation(store, { tab: "run", projectId: project.record.id });
      return { projectId: project.record.id, profiles };
    } finally {
      store.close();
    }
  }, { urls, texts, cards: CARDS });
  await page.reload();
  return seeded;
}

/** One stored experiment record, as the test compares it. */
export interface StoredExperiment {
  readonly sha256: string;
  readonly dependencies: readonly { readonly kind: string; readonly sha256: string }[];
  readonly profile: { readonly sha256: string; readonly id: string; readonly version: number; readonly name: string };
  readonly ownership: "launcher" | "external";
  /** The launcher-owned build and experiment; null for an external SITL. */
  readonly ardupilot: { readonly catalogId: string; readonly firmwareVersion: string; readonly commit: string; readonly binarySha256: string;
    readonly defaultParametersSha256: string } | null;
  readonly launcherExperimentId: string | null;
  /** An external SITL as the record names it; null for a launcher-owned one. */
  readonly external: {
    readonly connectionId: string; readonly ardupilot: { readonly commit: string; readonly gitHash: string; readonly firmwareVersion: string };
    readonly endpoints: { readonly jsonPhysicsPort: number; readonly mavlink: { readonly transport: "tcp" | "udp"; readonly port: number } };
  } | null;
  readonly session: {
    readonly physicsHz: number; readonly clockMode: string; readonly speedup: number | null;
    readonly home: readonly number[]; readonly modelId: number; readonly manifestSha256: string; readonly betModuleSha256: string;
  };
  readonly parameters: readonly { readonly name: string; readonly value: number; readonly source: string }[];
  readonly frameScript: string | null;
  /** canonicalBytes(payload.sensors) equals canonicalBytes(sensorSnapshot(profile version)). */
  readonly sensorsEqualSnapshot: boolean;
}
export interface ExperimentReadback {
  /** The stored profile version the experiments must name. */
  readonly profile: { readonly sha256: string; readonly id: string; readonly version: number; readonly name: string };
  /** That version's payload and the payloads of the component cards it names, for an independent derivation in Node. */
  readonly profilePayload: unknown;
  readonly cards: readonly { readonly sha256: string; readonly payload: unknown }[];
  readonly experiments: readonly StoredExperiment[];
}

/** Reads every experiment record of a project back from IndexedDB through the store, validated by readExperiment. */
export async function readExperimentRecords(page: Page, seeded: SeededProject): Promise<ExperimentReadback> {
  return page.evaluate(async ({ urls, projectId, profileSha256 }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { readExperiment } = await import(urls.experiment) as Experiments;
    const { sensorSnapshot } = await import(urls.sensors) as Sensors;
    const { canonicalBytes, equalBytes } = await import(urls.schema) as Schema;
    const { profileDependencies, readAircraftProfile } = await import(urls.profile) as Profiles;
    const store = await ProjectStore.openIndexedDb();
    try {
      const profile = await store.get(profileSha256);
      const snapshot = canonicalBytes(sensorSnapshot(profile));
      const cards: { sha256: string; payload: unknown }[] = [];
      for (const dependency of profileDependencies(readAircraftProfile(profile))) {
        if (dependency.kind === "component-card") cards.push({ sha256: dependency.sha256, payload: (await store.get(dependency.sha256)).record.payload });
      }
      const list = await store.listItems(projectId, "experiment");
      return {
        profile: { sha256: profile.sha256, id: profile.record.id, version: profile.record.version, name: profile.record.name },
        profilePayload: profile.record.payload, cards,
        experiments: list.map(stored => {
          const payload = readExperiment(stored);
          const { sitl } = payload;
          return {
            sha256: stored.sha256, dependencies: stored.record.dependencies.map(d => ({ kind: d.kind, sha256: d.sha256 })),
            profile: { ...payload.profile }, ownership: sitl.ownership,
            ardupilot: sitl.ownership === "launcher" ? { ...sitl.ardupilot } : null,
            launcherExperimentId: sitl.ownership === "launcher" ? sitl.experimentId : null,
            external: sitl.ownership === "external" ? { connectionId: sitl.connectionId, ardupilot: { ...sitl.ardupilot },
              endpoints: { jsonPhysicsPort: sitl.endpoints.jsonPhysicsPort, mavlink: { ...sitl.endpoints.mavlink } } } : null,
            session: { ...payload.session, home: [...payload.session.home] },
            parameters: payload.parameters.map(p => ({ name: p.name, value: p.value, source: p.source })),
            frameScript: payload.frameScript,
            sensorsEqualSnapshot: equalBytes(canonicalBytes(payload.sensors), snapshot),
          };
        }),
      };
    } finally {
      store.close();
    }
  }, { urls, projectId: seeded.projectId, profileSha256: seeded.profileSha256 });
}

/**
 * The initial parameters the Run tab generates for the seeded profile version
 * (prepareVehicle in the page, from IndexedDB), in launch order: what a user
 * would give a SITL they start themselves (TASK-155).
 */
export async function generatedParameters(page: Page, seeded: SeededProject): Promise<{ name: string; value: number; source: string }[]> {
  return page.evaluate(async ({ urls, profileSha256 }) => {
    const { ProjectStore } = await import(urls.store) as Store;
    const { prepareVehicle } = await import(urls.sitlRun) as SitlRun;
    const store = await ProjectStore.openIndexedDb();
    try {
      const vehicle = await prepareVehicle(store, await store.get(profileSha256));
      return vehicle.parameters.map(p => ({ name: p.name, value: p.value, source: p.source }));
    } finally {
      store.close();
    }
  }, { urls, profileSha256: seeded.profileSha256 });
}

/**
 * The SHA-256 of the vehicle manifest that Node derives (TASK-138: Node and
 * Chromium reproduce the bytes identically) from the profile version and its
 * cards as stored in IndexedDB, with this model ID. The aircraft modules
 * import JSON schemas without import attributes, which Node's own loader
 * refuses, so they are loaded through Vite's SSR loader in this process.
 */
export async function nodeManifestSha256(readback: ExperimentReadback, modelId: number): Promise<string> {
  const vite = await createViteServer({
    configFile: false, root: fileURLToPath(new URL("../..", import.meta.url)), appType: "custom", logLevel: "silent",
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    const { validateComponentCard } = await vite.ssrLoadModule("/packages/aircraft/src/components.ts") as Components;
    const { resolveComponents } = await vite.ssrLoadModule("/packages/aircraft/src/resolve-components.ts") as Resolution;
    const { deriveVehicleManifest } = await vite.ssrLoadModule("/packages/aircraft/src/derive-manifest.ts") as Derivation;
    const cards = new Map(readback.cards.map(card => [card.sha256, validateComponentCard(card.payload)]));
    const resolved = resolveComponents(readback.profilePayload, cards);
    if (!resolved.components) throw new Error(`The stored profile cannot be derived in Node: ${resolved.missing.join("; ")}`);
    return (await deriveVehicleManifest(readback.profilePayload, resolved.components, { modelId })).sha256;
  } finally {
    await vite.close();
  }
}

/** The initial parameters the launcher wrote for SITL (<experiment folder>/experiment.parm), one "NAME value" line each, in order. */
export function parameterFile(path: string): { name: string; value: number }[] {
  return readFileSync(path, "utf8").split("\n").filter(line => line !== "").map(line => {
    const match = /^([A-Z][A-Z0-9_]*) (\S+)$/.exec(line);
    const name = match?.[1], value = match?.[2];
    if (name === undefined || value === undefined || !Number.isFinite(Number(value))) throw new Error(`Invalid parameter line ${JSON.stringify(line)}`);
    return { name, value: Number(value) };
  });
}

// ---- the launcher API from Node --------------------------------------------------------------

export function field(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) current = typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined;
  return current;
}

/** One request to the launcher on 127.0.0.1, with the token and the configured Origin; resolves with the status and parsed JSON. */
export function launcherCall(port: number, token: string, origin: string, method: "GET" | "POST", path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method, headers: { authorization: `Bearer ${token}`, origin } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          const json: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ status: response.statusCode ?? 0, json });
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

export interface StatusRun { readonly run: number; readonly pid: number; readonly state: string; readonly signal: string | null; readonly reason: string | null }
export interface StatusExperiment { readonly id: string; readonly state: string; readonly runs: readonly StatusRun[] }

/** GET /v1/status, narrowed to the experiments and their runs. */
export async function launcherExperiments(port: number, token: string, origin: string): Promise<StatusExperiment[]> {
  const { status, json } = await launcherCall(port, token, origin, "GET", "/v1/status");
  if (status !== 200) throw new Error(`GET /v1/status answered ${status}`);
  const list = field(json, "experiments");
  if (!Array.isArray(list)) throw new Error("GET /v1/status has no experiment list");
  const items: readonly unknown[] = list;
  return items.map(item => {
    const id = field(item, "id"), state = field(item, "state"), runs = field(item, "runs");
    if (typeof id !== "string" || typeof state !== "string" || !Array.isArray(runs)) throw new Error("Invalid experiment in /v1/status");
    const runList: readonly unknown[] = runs;
    return {
      id, state, runs: runList.map(run => {
        const number = field(run, "run"), pid = field(run, "pid"), runState = field(run, "state"), signal = field(run, "signal"), reason = field(run, "reason");
        if (typeof number !== "number" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || typeof runState !== "string") {
          throw new Error("Invalid run in /v1/status");
        }
        return { run: number, pid, state: runState, signal: typeof signal === "string" ? signal : null, reason: typeof reason === "string" ? reason : null };
      }),
    };
  });
}

/** Stops every experiment whose state is not final, through the API; for cleanup after a failed test. */
export async function stopEveryRun(port: number, token: string, origin: string): Promise<void> {
  for (const experiment of await launcherExperiments(port, token, origin)) {
    if (!["stopped", "exited", "crashed", "start-failed"].includes(experiment.state)) {
      await launcherCall(port, token, origin, "POST", `/v1/experiments/${encodeURIComponent(experiment.id)}/stop`);
    }
  }
}

// ---- owned processes ---------------------------------------------------------------------------

/** PIDs whose process group is `leader` (ps -A, independent of ps -g). */
export function groupMembers(leader: number): number[] {
  const listing = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(`ps -A failed: ${listing.stderr}`);
  return listing.stdout.split("\n").flatMap(line => {
    const [pid, pgid] = line.trim().split(/\s+/).map(Number);
    return pid !== undefined && pgid !== undefined && Number.isInteger(pid) && (pgid === leader || pid === leader) ? [pid] : [];
  });
}
/** The processes whose full command line contains `marker` (ps -A -ww); every SITL run names its launcher home in --defaults. */
export function processesNaming(marker: string): { pid: number; command: string }[] {
  const listing = spawnSync("/bin/ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(`ps -A failed: ${listing.stderr}`);
  return listing.stdout.split("\n").flatMap(line => {
    const match = /^\s*([0-9]+) (.*)$/.exec(line);
    const pid = Number(match?.[1]), command = match?.[2];
    return command !== undefined && command.includes(marker) ? [{ pid, command }] : [];
  });
}
/** The argument vector of a live process as ps shows it (paths here hold no spaces). */
export function commandWords(pid: number): string[] {
  const listing = spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error(`ps -p ${pid} found no process`);
  return listing.stdout.trim().split(/\s+/);
}
/** The word after `flag` in a command line, or undefined. */
export function argumentOf(words: readonly string[], flag: string): string | undefined {
  const index = words.indexOf(flag);
  return index < 0 ? undefined : words[index + 1];
}

/** What `ps -g <leader> -o pid=` prints: the processes of that group leader. */
export function psGroup(leader: number): string {
  return spawnSync("/bin/ps", ["-g", String(leader), "-o", "pid="], { encoding: "utf8" }).stdout.trim();
}
/** The error code of signal 0 to `pid`, or null when the process exists. */
export function signalZeroCode(pid: number): string | null {
  try {
    process.kill(pid, 0);
    return null;
  } catch (error) {
    const code: unknown = field(error, "code");
    return typeof code === "string" ? code : "unknown";
  }
}
