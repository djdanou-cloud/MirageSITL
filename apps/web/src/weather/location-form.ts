import { LOCATION_ENVELOPE, STANDARD_SEA_LEVEL_PRESSURE_PA } from "@mirage/sensors/environment";
import { parseLocation, type LocationChoice } from "./location";

// The location form of the Weather and location tab (TASK-148): text fields
// as typed, and the location they describe or the problems that keep them
// from being one. Pure, so the Node tests check it without the component.

export interface LocationForm {
  /** A built-in site's ID, or COORDINATES. */
  readonly site: string;
  readonly latitudeDeg: string;
  readonly longitudeDeg: string;
  readonly groundElevationMslM: string;
  readonly headingDeg: string;
  readonly pressure: "standard" | "measured";
  /** The measured QNH in hPa, as pilots read it; stored in Pa. */
  readonly qnhHpa: string;
  readonly temperatureOffsetK: string;
}
export const COORDINATES = "coordinates";

export function formOf(location: LocationChoice): LocationForm {
  return {
    site: location.site ?? COORDINATES, latitudeDeg: String(location.latitudeDeg), longitudeDeg: String(location.longitudeDeg),
    groundElevationMslM: String(location.groundElevationMslM), headingDeg: String(location.headingDeg),
    pressure: location.measuredQnhPa === null ? "standard" : "measured",
    qnhHpa: location.measuredQnhPa === null ? (STANDARD_SEA_LEVEL_PRESSURE_PA / 100).toFixed(2) : String(location.measuredQnhPa / 100),
    temperatureOffsetK: String(location.temperatureOffsetK),
  };
}
const number = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));
/** The location a form describes, or the problems that keep it from being one, in field order. */
export function locationOf(form: LocationForm): { location: LocationChoice | null; problems: string[] } {
  const env = LOCATION_ENVELOPE, problems: string[] = [];
  const check = (label: string, text: string, min: number, max: number): number => {
    const value = number(text);
    if (!Number.isFinite(value) || value < min || value > max) problems.push(`${label} must be a number from ${min} to ${max}`);
    return value;
  };
  const latitudeDeg = check("Latitude", form.latitudeDeg, -89.9, 89.9), longitudeDeg = check("Longitude", form.longitudeDeg, -180, 180);
  const groundElevationMslM = check("Ground elevation", form.groundElevationMslM, env.minElevationM, env.maxElevationM);
  const headingDeg = check("Heading", form.headingDeg, 0, 360);
  const measuredQnhPa = form.pressure === "measured" ? 100 * check("Measured QNH (hPa)", form.qnhHpa, env.minSeaLevelPressurePa / 100, env.maxSeaLevelPressurePa / 100) : null;
  const temperatureOffsetK = check("Temperature offset", form.temperatureOffsetK, -env.maxTemperatureOffsetK, env.maxTemperatureOffsetK);
  if (problems.length > 0) return { location: null, problems };
  const candidate: LocationChoice = { site: form.site === COORDINATES ? null : form.site, latitudeDeg, longitudeDeg, groundElevationMslM, headingDeg, measuredQnhPa,
    temperatureOffsetK };
  const location = parseLocation(candidate);
  return location ? { location, problems: [] } : { location: null, problems: ["The location does not match its site; choose Coordinates to change it"] };
}
