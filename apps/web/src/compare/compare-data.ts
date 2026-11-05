// What the comparison reads of one stored experiment (TASK-177): its aircraft version and cards from the
// project, its results from its recording, and the thrust at full command from a Worker. Each can be
// missing on its own, and says why. Cold path.
import { experimentMetrics, type ExperimentMetrics } from "@mirage/analysis/metrics";
import type { ComparedExperiment } from "@mirage/analysis/compare";
import { reopenRecording } from "@mirage/aar/recorder-v2-host";
import { evaluateCalculation, type ProfileCalculation } from "@mirage/aircraft/calculation-mode";
import { readComponentCard, type ComponentCard } from "@mirage/aircraft/components";
import { deriveVehicleManifest } from "@mirage/aircraft/derive-manifest";
import type { ExperimentPayload } from "@mirage/aircraft/experiment";
import { validateMeasurementSet, type MeasurementSet } from "@mirage/aircraft/measurements";
import { profileDependencies, readAircraftProfile, type AircraftProfile } from "@mirage/aircraft/profile";
import { resolveComponents } from "@mirage/aircraft/resolve-components";
import type { ThrustCapacity } from "@mirage/physics/thrust-capacity";
import type { StoredVersion } from "@mirage/project/schema";
import type { ProjectStore } from "@mirage/project/store";
import { fetchBetModule } from "../sitl/sitl-run";

export interface LoadedExperiment {
  readonly compared: ComparedExperiment;
  readonly metrics: ExperimentMetrics | null;
  readonly metricsMissing: string | null;
  readonly calculation: ProfileCalculation | null;
  readonly capacity: ThrustCapacity | null;
  readonly capacityMissing: string | null;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);

interface LoadedAircraft {
  readonly profile: AircraftProfile;
  readonly cards: ReadonlyMap<string, ComponentCard>;
  readonly cardNames: ReadonlyMap<string, string>;
  readonly sets: ReadonlyMap<string, MeasurementSet>;
}
async function loadAircraft(store: ProjectStore, sha256: string): Promise<LoadedAircraft> {
  const profile = readAircraftProfile(await store.get(sha256));
  const cards = new Map<string, ComponentCard>(), cardNames = new Map<string, string>(), sets = new Map<string, MeasurementSet>();
  for (const dependency of profileDependencies(profile)) {
    const stored = await store.get(dependency.sha256);
    if (dependency.kind === "component-card") { cards.set(dependency.sha256, readComponentCard(stored)); cardNames.set(dependency.sha256, stored.record.name); }
    else sets.set(dependency.sha256, validateMeasurementSet(stored.record.payload));
  }
  return { profile, cards, cardNames, sets };
}

/** The one Worker for these calculations, started on the first and answering by request ID. */
let worker: Worker | null = null, nextRequest = 0;
function askWorker(manifest: unknown, moduleBytes: Uint8Array, stateOfCharge: number): Promise<ThrustCapacity> {
  worker ??= new Worker(new URL("./capacity.worker.ts", import.meta.url), { type: "module" });
  const running = worker, id = ++nextRequest;
  return new Promise((resolve, reject) => {
    const answer = (event: MessageEvent<unknown>) => {
      if (field(event.data, "id") !== id) return;
      running.removeEventListener("message", answer);
      const error = field(event.data, "error");
      // This module's own Worker answers with what it just computed.
      if (typeof error === "string") reject(new Error(error)); else resolve(field(event.data, "capacity") as ThrustCapacity);
    };
    running.addEventListener("message", answer);
    running.postMessage({ id, manifest, moduleBytes, stateOfCharge });
  });
}
async function capacityOf(aircraft: LoadedAircraft, payload: ExperimentPayload): Promise<ThrustCapacity> {
  const resolved = resolveComponents(aircraft.profile, aircraft.cards);
  if (!resolved.components) throw new Error(`The profile cannot fly yet: ${resolved.missing.join("; ")}`);
  const derived = await deriveVehicleManifest(aircraft.profile, resolved.components, { modelId: payload.session.modelId });
  const module = await fetchBetModule();
  return askWorker(derived.manifest, module.bytes, payload.flightTask?.definition.initial.ground.stateOfCharge ?? 1);
}

export async function loadExperiment(store: ProjectStore, stored: StoredVersion, payload: ExperimentPayload): Promise<LoadedExperiment> {
  let aircraft: LoadedAircraft | null = null, aircraftMissing: string | null = null;
  try { aircraft = await loadAircraft(store, payload.profile.sha256); } catch (cause) { aircraftMissing = `The aircraft profile version is not available: ${messageOf(cause)}`; }

  let metrics: ExperimentMetrics | null = null, metricsMissing: string | null = null;
  if (!payload.recording) metricsMissing = "This run recorded nothing";
  else {
    try { metrics = experimentMetrics((await reopenRecording(payload.recording.recordId)).rows, payload.flightTask?.definition ?? null); }
    catch (cause) { metricsMissing = `The recording cannot be read in this browser: ${messageOf(cause)}`; }
  }

  let calculation: ProfileCalculation | null = null, capacity: ThrustCapacity | null = null, capacityMissing = aircraftMissing;
  if (aircraft) {
    calculation = await evaluateCalculation(aircraft.profile, aircraft.cards, aircraft.sets).catch(() => null);
    try { capacity = await capacityOf(aircraft, payload); } catch (cause) { capacityMissing = `The thrust at full command could not be calculated: ${messageOf(cause)}`; }
  }
  return { compared: { name: stored.record.name, payload, aircraft }, metrics, metricsMissing, calculation, capacity, capacityMissing };
}
