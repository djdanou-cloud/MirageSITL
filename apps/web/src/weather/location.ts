import type { ExperimentLocation } from "@mirage/aircraft/experiment";
import type { ProjectStore } from "@mirage/project/store";
import { LOCATION_ENVELOPE } from "@mirage/sensors/environment";

// The location of the flight (TASK-148, S07): a built-in site or coordinates,
// the ground elevation above mean sea level, the heading ArduPilot starts at,
// and what the air at the ground is derived from (a measured QNH, or the ISA
// standard, and an ISA temperature offset). Kept per project in the store's
// local settings, so it survives a reload; a run copies it with its effective
// conditions into the experiment record. Phase 1 has no offline map (S17):
// the synthetic pad stands at any coordinates, and the elevation is typed.
// Cold path.

export const LOCATION_SETTING = "weather.location";
/** The user's choice of location, as the experiment record keeps it. */
export type LocationChoice = ExperimentLocation;

export interface Site {
  readonly id: string;
  readonly name: string;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly groundElevationMslM: number;
  readonly headingDeg: number;
  /** Where the coordinates and the elevation come from. */
  readonly source: string;
}
/** The built-in sites: ArduPilot's own SITL test site, whose elevation ArduPilot's default home states. */
export const SITES: readonly Site[] = Object.freeze([
  Object.freeze({ id: "cmac", name: "ArduPilot SITL test site (CMAC, Canberra)", latitudeDeg: -35.363261, longitudeDeg: 149.16523, groundElevationMslM: 584,
    headingDeg: 0, source: "ArduPilot's default SITL home (Tools/autotest/locations.txt, CMAC)" }),
]);
/** The site of the default location, so a project without a choice flies where the launcher tests do. */
export const DEFAULT_LOCATION: LocationChoice = Object.freeze({
  site: "cmac", latitudeDeg: -35.363261, longitudeDeg: 149.16523, groundElevationMslM: 584, headingDeg: 0, measuredQnhPa: null, temperatureOffsetK: 0,
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function within(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/** A location from unknown (a stored value), or null when it is not one inside the declared envelope. */
export function parseLocation(value: unknown): LocationChoice | null {
  if (!isObject(value)) return null;
  const env = LOCATION_ENVELOPE;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "groundElevationMslM,headingDeg,latitudeDeg,longitudeDeg,measuredQnhPa,site,temperatureOffsetK") return null;
  const site = value.site;
  if (site !== null && (typeof site !== "string" || site.length === 0 || site.length > 64)) return null;
  if (typeof site === "string" && !SITES.some(entry => entry.id === site)) return null;
  const latitudeDeg = within(value.latitudeDeg, -89.9, 89.9), longitudeDeg = within(value.longitudeDeg, -180, 180);
  const groundElevationMslM = within(value.groundElevationMslM, env.minElevationM, env.maxElevationM), headingDeg = within(value.headingDeg, 0, 360);
  const measuredQnhPa = value.measuredQnhPa === null ? null : within(value.measuredQnhPa, env.minSeaLevelPressurePa, env.maxSeaLevelPressurePa);
  const temperatureOffsetK = within(value.temperatureOffsetK, -env.maxTemperatureOffsetK, env.maxTemperatureOffsetK);
  if (latitudeDeg === null || longitudeDeg === null || groundElevationMslM === null || headingDeg === null || measuredQnhPa === undefined || temperatureOffsetK === null) return null;
  if (measuredQnhPa === null && value.measuredQnhPa !== null) return null;
  const location: LocationChoice = { site, latitudeDeg, longitudeDeg, groundElevationMslM, headingDeg, measuredQnhPa, temperatureOffsetK };
  // A site's coordinates, elevation and heading are the site's own.
  const entry = site === null ? null : SITES.find(candidate => candidate.id === site) ?? null;
  if (entry && (entry.latitudeDeg !== latitudeDeg || entry.longitudeDeg !== longitudeDeg || entry.groundElevationMslM !== groundElevationMslM || entry.headingDeg !== headingDeg)) {
    return null;
  }
  return Object.freeze(location);
}

/** ArduPilot's home of a location: latitude, longitude, altitude above mean sea level and heading, as `--home` takes them. */
export function homeOf(location: LocationChoice): readonly [number, number, number, number] {
  return [location.latitudeDeg, location.longitudeDeg, location.groundElevationMslM, location.headingDeg];
}

/** The location on a site, with the pressure choices kept. */
export function atSite(location: LocationChoice, site: Site): LocationChoice {
  return Object.freeze({ ...location, site: site.id, latitudeDeg: site.latitudeDeg, longitudeDeg: site.longitudeDeg, groundElevationMslM: site.groundElevationMslM,
    headingDeg: site.headingDeg });
}

/** How the location reads in one line: the site's name, or its coordinates. */
export function describeLocation(location: LocationChoice): string {
  const site = location.site === null ? null : SITES.find(entry => entry.id === location.site) ?? null;
  const pressure = location.measuredQnhPa === null ? "standard sea-level pressure" : `QNH ${(location.measuredQnhPa / 100).toFixed(2)} hPa`;
  const offset = location.temperatureOffsetK === 0 ? "" : `, ISA ${location.temperatureOffsetK > 0 ? "+" : ""}${location.temperatureOffsetK} K`;
  const where = site ? site.name : `${location.latitudeDeg}°, ${location.longitudeDeg}°, ${location.groundElevationMslM} m above mean sea level`;
  return `${where}, heading ${location.headingDeg}°, ${pressure}${offset}`;
}

/** The stored setting: one location per project (schemaVersion 1). */
function parseSetting(value: unknown): Record<string, LocationChoice> {
  if (!isObject(value) || value.schemaVersion !== 1 || !isObject(value.projects)) return {};
  const projects: Record<string, LocationChoice> = {};
  for (const [projectId, entry] of Object.entries(value.projects)) {
    const location = parseLocation(entry);
    if (UUID_V4.test(projectId) && location) projects[projectId] = location;
  }
  return projects;
}
/** The project's location, or the default when none valid is stored. */
export async function loadLocation(store: ProjectStore, projectId: string): Promise<LocationChoice> {
  try {
    return parseSetting(await store.readSetting(LOCATION_SETTING))[projectId] ?? DEFAULT_LOCATION;
  } catch {
    // A damaged setting costs only the choice; the next save replaces it.
    return DEFAULT_LOCATION;
  }
}
export async function saveLocation(store: ProjectStore, projectId: string, location: LocationChoice): Promise<void> {
  if (!parseLocation(location)) throw new Error("The location lies outside its envelope");
  let projects: Record<string, LocationChoice>;
  try {
    projects = parseSetting(await store.readSetting(LOCATION_SETTING));
  } catch {
    projects = {};
  }
  projects[projectId] = location;
  await store.writeSetting(LOCATION_SETTING, { schemaVersion: 1, projects });
}
