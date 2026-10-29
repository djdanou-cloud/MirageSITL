// TASK-136 browser harness: the project store on real IndexedDB. The spec
// loads this module, disables the network, and then calls these functions;
// a browser restart separates writeProject from reopenProject. Results are
// plain JSON so they cross page.evaluate unchanged.
import { ProjectStoreError, encodeRecord } from "../../packages/project/src/schema";
import { IndexedDbBackend, ProjectStore, toRow, type StorageReport } from "../../packages/project/src/store";

/**
 * Names a user typed. The Russian ones are escaped, because source files outside docs/ru/
 * hold no Cyrillic characters; each comment gives the meaning in English.
 */
export const NAMES = {
  /** "Project: X8 octocopter" */
  project: "\u{41f}\u{440}\u{43e}\u{435}\u{43a}\u{442}: \u{43e}\u{43a}\u{442}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8",
  motor: "Motor MN3110 KV780",
  /** "Quadcopter X8" */
  profile: "\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8",
  /** "Quadcopter X8 (rev. B)" */
  profileEdited: "\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8 (\u{440}\u{435}\u{434}. B)",
  /** "Quadcopter X8 — copy" */
  copy: "\u{41a}\u{432}\u{430}\u{434}\u{440}\u{43e}\u{43a}\u{43e}\u{43f}\u{442}\u{435}\u{440} X8 — \u{43a}\u{43e}\u{43f}\u{438}\u{44f}",
  /** "Hover — hovering" */
  experiment: "Hover — \u{432}\u{438}\u{441}\u{435}\u{43d}\u{438}\u{435}",
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function fromHex(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}
async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ProjectStoreError) return error.code;
    throw error;
  }
  return "resolved";
}

export interface WrittenProject {
  projectId: string;
  profileId: string;
  copyId: string;
  experimentId: string;
  shas: { project: string; motor: string; profile1: string; profile2: string; copy: string; experiment: string };
  /** Canonical bytes (hex) of the experiment and of the versions it depends on. */
  bytes: { experiment: string; profile1: string; motor: string };
  archive: string;
  exportMissing: number;
  storage: StorageReport;
}

export async function writeProject(databaseName: string): Promise<WrittenProject> {
  const store = await ProjectStore.openIndexedDb({ databaseName });
  try {
    const project = await store.createProject(NAMES.project);
    const id = project.record.id;
    const motor = await store.createItem(id, "component-card", { name: NAMES.motor, payload: { kvRpmPerV: 780 } });
    const profile1 = await store.createItem(id, "aircraft-profile",
      { name: NAMES.profile, payload: { arms: 4, motorsPerArm: 2 }, dependencies: [motor.sha256] });
    const experiment = await store.createItem(id, "experiment",
      { name: NAMES.experiment, payload: { task: "hover", durationS: 60 }, dependencies: [profile1.sha256, motor.sha256] });
    const profile2 = await store.saveVersion(profile1.record.id, profile1.sha256,
      { name: NAMES.profileEdited, payload: { arms: 4, motorsPerArm: 2, armLengthM: 0.4 }, dependencies: [motor.sha256] });
    const copy = await store.copyItem(profile2.sha256, NAMES.copy);
    const exported = await store.exportProject(id);
    return {
      projectId: id, profileId: profile1.record.id, copyId: copy.record.id, experimentId: experiment.record.id,
      shas: { project: project.sha256, motor: motor.sha256, profile1: profile1.sha256, profile2: profile2.sha256, copy: copy.sha256, experiment: experiment.sha256 },
      bytes: { experiment: hex(experiment.bytes), profile1: hex(profile1.bytes), motor: hex(motor.bytes) },
      archive: hex(exported.archive), exportMissing: exported.missing.length, storage: await store.storageReport(),
    };
  } finally {
    store.close();
  }
}

export async function reopenProject(databaseName: string, written: WrittenProject) {
  const store = await ProjectStore.openIndexedDb({ databaseName });
  try {
    const projects = (await store.listProjects()).map(v => ({ id: v.record.id, name: v.record.name }));
    const items = (await store.listItems(written.projectId)).map(v => ({ kind: v.record.kind, name: v.record.name, version: v.record.version }));
    const profileHistory = (await store.history(written.profileId)).map(v => v.sha256);
    const experiment = await store.get(written.shas.experiment);
    const bytesAfterRestart = {
      experiment: hex(experiment.bytes), profile1: hex((await store.get(written.shas.profile1)).bytes),
      motor: hex((await store.get(written.shas.motor)).bytes),
    };
    const experimentInputs = experiment.record.dependencies.map(d => d.sha256);
    const copyOrigin = (await store.head(written.copyId))?.record.origin?.copiedFrom ?? null;
    // An edit after the restart appends version 3 and leaves the experiment's inputs as they were.
    const profile3 = await store.saveVersion(written.profileId, written.shas.profile2,
      { name: NAMES.profileEdited, payload: { arms: 8, motorsPerArm: 2 }, dependencies: [written.shas.motor] });
    const experimentAfterEdit = hex((await store.get(written.shas.experiment)).bytes);
    const reimport = await store.importArchive(fromHex(written.archive));
    return {
      projects, items, profileHistory, bytesAfterRestart, experimentInputs, copyOrigin, profile3Version: profile3.record.version,
      experimentAfterEdit, reimport: { added: reimport.added, unchanged: reimport.unchanged, statuses: reimport.items.map(i => [i.kind, i.status]) },
    };
  } finally {
    store.close();
  }
}

/** Imports the archive into a second database, as another installation would. */
export async function importElsewhere(databaseName: string, archiveHex: string) {
  const store = await ProjectStore.openIndexedDb({ databaseName });
  try {
    const archive = fromHex(archiveHex);
    const tampered = archive.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    const tamperedCode = await codeOf(() => store.importArchive(new Blob([tampered])));
    const truncatedCode = await codeOf(() => store.importArchive(new Blob([archive.slice(0, archive.length - 1)])));
    const recordsAfterRejections = (await store.storageReport()).records;
    const report = await store.importArchive(new Blob([archive]));
    const project = (await store.listProjects())[0];
    const items = project ? (await store.listItems(project.record.id)).map(v => ({ kind: v.record.kind, name: v.record.name, version: v.record.version })) : [];
    return {
      tamperedCode, truncatedCode, recordsAfterRejections,
      report: { added: report.added, unchanged: report.unchanged, missing: report.missing.length, statuses: report.items.map(i => [i.kind, i.status]) },
      projectName: project?.record.name ?? null, items, records: (await store.storageReport()).records,
    };
  } finally {
    store.close();
  }
}

/** The IndexedDB backend's commit rules, checked directly: atomic, idempotent and fork-proof. */
export async function backendConformance(databaseName: string) {
  const backend = await IndexedDbBackend.open(databaseName);
  const store = new ProjectStore(backend, { storage: null });
  try {
    const project = await store.createProject("Conformance");
    const card = await store.createItem(project.record.id, "component-card", { name: "Card", payload: { n: 1 } });
    const before = await backend.totals();
    const fresh = await encodeRecord({ ...card.record, id: crypto.randomUUID() });
    const staleHead = await codeOf(() => backend.commit({ adds: [toRow(fresh)], expectHeads: new Map([[card.record.id, "a".repeat(64)]]) }));
    const fork = await encodeRecord({ ...card.record, name: "Fork" });
    const forkCode = await codeOf(() => backend.commit({ adds: [toRow(fresh), toRow(fork)], expectHeads: new Map() }));
    const afterFailures = await backend.totals();
    const repeated = await backend.commit({ adds: [toRow(card)], expectHeads: new Map([[card.record.id, card.sha256]]) });
    const added = await backend.commit({ adds: [toRow(fresh)], expectHeads: new Map([[fresh.record.id, null]]) });
    return { staleHead, forkCode, before, afterFailures, repeated, added, after: await backend.totals() };
  } finally {
    store.close();
  }
}

/**
 * TASK-137: a version 1 database, as TASK-136 created it, upgrades to version 2
 * (the settings store) and keeps its records.
 */
export async function upgradeFromVersion1(databaseName: string) {
  const id = crypto.randomUUID();
  const project = await encodeRecord({
    schemaVersion: 1, kind: "project", id, projectId: id, version: 1, previous: null, origin: null,
    name: "Upgrade check", createdAt: "2026-10-28T12:00:00.000Z", dependencies: [], payload: {},
  });
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const records = request.result.createObjectStore("records", { keyPath: "sha256" });
      records.createIndex("item", ["id", "version"], { unique: true });
      records.createIndex("project", "projectId");
      records.createIndex("kind", "kind");
      records.add(toRow(project));
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error("Version 1 database could not be created"));
  });
  const store = await ProjectStore.openIndexedDb({ databaseName });
  let projects: string[], setting: unknown;
  try {
    projects = (await store.listProjects()).map(v => v.sha256);
    await store.writeSetting("shell.navigation", { schemaVersion: 1, tab: "aircraft", projectId: id });
  } finally {
    store.close();
  }
  const reopened = await ProjectStore.openIndexedDb({ databaseName });
  try {
    setting = await reopened.readSetting("shell.navigation");
  } finally {
    reopened.close();
  }
  const version = (await indexedDB.databases()).find(db => db.name === databaseName)?.version ?? null;
  return { expected: project.sha256, projects, setting, id, version };
}
