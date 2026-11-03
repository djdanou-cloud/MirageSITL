import type { ExperimentEnvironment } from "@mirage/aircraft/experiment";
import { decimalYearOf, effectiveConditions, type EffectiveConditions } from "@mirage/sensors/environment";
import { WMM2025_SHA256, WorldMagneticModel, parseWmmCoefficients } from "@mirage/sensors/geomagnetic";
import { loadEgm96Geoid, type GeoidModel } from "@mirage/sensors/geoid";
import wmmCoefficients from "../../../../data/geomagnetic/WMM_2025.COF?raw";
import egm96Url from "../../../../data/geoid/WW15MGH.DAC?url";
import type { LocationChoice } from "./location";

// The effective conditions of a location in the application (TASK-148): the
// WMM2025 coefficients travel in the bundle as text and the EGM96 grid as an
// asset; both are checked against their pinned SHA-256 before use, as the
// Node tests check them. Loaded once, on first use. Cold path.

export interface GeographicModels {
  readonly geoid: GeoidModel;
  readonly magnetic: WorldMagneticModel;
}
let models: Promise<GeographicModels> | null = null;

async function sha256Of(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function loadModels(): Promise<GeographicModels> {
  if (await sha256Of(wmmCoefficients) !== WMM2025_SHA256) throw new Error("The bundled WMM2025 coefficients differ from their pinned SHA-256");
  const magnetic = new WorldMagneticModel(parseWmmCoefficients(wmmCoefficients));
  const response = await fetch(egm96Url, { cache: "no-store" });
  if (!response.ok) throw new Error(`The EGM96 geoid grid is not served (${response.status})`);
  const geoid = await loadEgm96Geoid(new Uint8Array(await response.arrayBuffer()));
  return { geoid, magnetic };
}
/** The geoid and the magnetic model, loaded and verified once; a failed load is retried on the next call. */
export function geographicModels(): Promise<GeographicModels> {
  models ??= loadModels().catch((cause: unknown) => { models = null; throw cause; });
  return models;
}

/** The conditions of a location at `date` (the WMM decimal year). */
export function conditionsOf(location: LocationChoice, loaded: GeographicModels, date: Date): EffectiveConditions {
  return effectiveConditions({
    latitudeDeg: location.latitudeDeg, longitudeDeg: location.longitudeDeg, groundElevationMslM: location.groundElevationMslM, decimalYear: decimalYearOf(date),
    ...(location.measuredQnhPa === null ? {} : { measuredQnhPa: location.measuredQnhPa }), temperatureOffsetK: location.temperatureOffsetK,
  }, loaded);
}

/** The environment a run records (TASK-148): the location and its conditions at the run's date. */
export async function environmentFor(location: LocationChoice, date = new Date()): Promise<ExperimentEnvironment> {
  return { location, conditions: conditionsOf(location, await geographicModels(), date) };
}
