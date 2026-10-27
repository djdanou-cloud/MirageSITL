// Surface temperatures per material class for the area of operation
// (TASK-073 P5): the TASK-070 ThermalField integrated for every class of the
// P4 material raster in five orientations (up and the four vertical walls),
// driven by the solar ephemeris and clear-sky forcing of solar.ts.
//
// Emissivities follow docs/needed_for_task073.md section 9.1 (8-14 um,
// operator-approved stand-ins and EmissivityTable_thermoworks.txt). Heat
// capacity, absorptance and conductance come from the TASK-070 typical
// properties through a documented proxy class. Limits: one air temperature
// all day (no diurnal air cycle), no cast shadows, no moisture; the result is
// a plausible synthetic field, not a validated surface temperature.
import { TYPICAL_SURFACE_PROPS, ThermalField, type SurfaceThermalProps, type ThermalForcing, type ThermalWeather } from "./heat-balance.ts";
import { clearSkyIrradiance, dayOfYearUtc, skyEmissivity, solarPosition } from "./solar.ts";

export interface EmissivityEntry { emissivity: number; source: string }

/** 8-14 um emissivity per material class with its provenance. */
export const AREA_EMISSIVITY: Readonly<Record<string, Readonly<EmissivityEntry>>> = Object.freeze({
  "synthetic-ground": { emissivity: 0.92, source: "Soil: dry (ThermoWorks); approved bare-soil stand-in" },
  "vegetation-tree": { emissivity: 0.97, source: "Approved vegetation value; trees about 0.977 (arXiv 2001.09191)" },
  "vegetation-shrub": { emissivity: 0.97, source: "Approved vegetation value" },
  "vegetation-grass": { emissivity: 0.97, source: "Approved vegetation value; grass about 0.983 (arXiv 2001.09191)" },
  "cropland": { emissivity: 0.97, source: "Approved vegetation value (Lillesand et al. 2008: 0.96-0.99)" },
  "built-up": { emissivity: 0.92, source: "Concrete (ThermoWorks)" },
  "bare-soil": { emissivity: 0.92, source: "Approved bare-soil stand-in; Soil: dry (ThermoWorks)" },
  "snow-ice": { emissivity: 0.97, source: "Ice (ThermoWorks); the table's Snow 0.80 is below literature LWIR values" },
  "water": { emissivity: 0.95, source: "Water (ThermoWorks)" },
  "wetland": { emissivity: 0.97, source: "Approved vegetation value (vegetated wetland)" },
  "mangrove": { emissivity: 0.97, source: "Approved vegetation value" },
  "moss-lichen": { emissivity: 0.97, source: "Approved vegetation value" },
  "roof-generic": { emissivity: 0.92, source: "Concrete (ThermoWorks); most roofs in the area are concrete" },
  "roof-metal": { emissivity: 0.28, source: "Steel: galvanized (ThermoWorks)" },
  "roof-concrete": { emissivity: 0.92, source: "Concrete (ThermoWorks)" },
  "roof-tile": { emissivity: 0.91, source: "Clay: fired (ThermoWorks)" },
  "roof-bitumen": { emissivity: 0.92, source: "Paper: tar (ThermoWorks)" },
  "roof-glass": { emissivity: 0.92, source: "Glass (ThermoWorks)" },
  "asphalt": { emissivity: 0.93, source: "Approved stand-in (literature 0.94-0.97: recorded as below range)" },
  "gravel": { emissivity: 0.96, source: "Limestone: natural surface (ThermoWorks); the table's Gravel 0.28 is implausible for 8-14 um" },
});

/** Class whose TASK-070 typical heat properties stand in for each material. */
export const HEAT_PROPS_PROXY: Readonly<Record<string, string>> = Object.freeze({
  "synthetic-ground": "synthetic-ground", "vegetation-tree": "vegetation-tree", "vegetation-shrub": "vegetation-tree",
  "vegetation-grass": "vegetation-grass", "cropland": "vegetation-grass", "built-up": "built-up", "bare-soil": "bare-soil",
  "snow-ice": "bare-soil", "water": "water", "wetland": "vegetation-grass", "mangrove": "vegetation-tree", "moss-lichen": "vegetation-grass",
  "roof-generic": "roof-generic", "roof-metal": "roof-metal", "roof-concrete": "built-up", "roof-tile": "roof-generic",
  "roof-bitumen": "roof-generic", "roof-glass": "roof-generic", "asphalt": "asphalt", "gravel": "bare-soil",
});

/** Thermal properties of a material class; unknown classes use the synthetic ground. */
export function areaSurfaceProps(material: string): SurfaceThermalProps {
  const proxy = TYPICAL_SURFACE_PROPS[HEAT_PROPS_PROXY[material] ?? "synthetic-ground"] ?? TYPICAL_SURFACE_PROPS["synthetic-ground"];
  const emissivity = AREA_EMISSIVITY[material] ?? AREA_EMISSIVITY["synthetic-ground"];
  if (!proxy || !emissivity) throw new Error("Missing synthetic-ground thermal properties");
  return { ...proxy, emissivity: emissivity.emissivity };
}

/** Orientation rows of the temperature table: up, east, north, west, south (ENU normals). */
export const ORIENTATIONS: readonly (readonly [number, number, number])[] = Object.freeze([
  [0, 0, 1], [1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0],
]);
/** Sky-view factor of a horizontal surface and of a wall. */
const SKY_VIEW = [1, 0.5, 0.5, 0.5, 0.5] as const;
export const TABLE_WIDTH = 256;

export interface AreaThermalConfig {
  latDeg: number;
  lonDeg: number;
  /** UTC instant of sensor time zero, ms since epoch. */
  startUtcMs: number;
  weather: ThermalWeather;
}

/**
 * Temperature table for the G-buffer: row r (orientation), column c (class
 * index) at temperatureK[r * 256 + c]. advanceTo() runs at the thermal update
 * rate (about 1 Hz), outside the physics loop.
 */
export class AreaThermal {
  readonly temperatureK = new Float32Array(ORIENTATIONS.length * TABLE_WIDTH);
  readonly emissivity = new Float32Array(TABLE_WIDTH);
  readonly field: ThermalField;
  timeUtcMs: number;
  private readonly forcing: ThermalForcing = { sunEast: 0, sunNorth: 0, sunUp: 1, directNormalWm2: 0, diffuseHorizontalWm2: 0, dtS: 1 };

  constructor(readonly materials: readonly string[], readonly config: AreaThermalConfig) {
    if (materials.length < 1 || materials.length > TABLE_WIDTH) throw new Error("Material class count out of range");
    if (!(Math.abs(config.latDeg) <= 90 && Math.abs(config.lonDeg) <= 180 && Number.isFinite(config.startUtcMs))) throw new Error("Invalid area thermal configuration");
    const elements = [];
    for (let r = 0; r < ORIENTATIONS.length; r++) {
      for (const material of materials) elements.push({ props: areaSurfaceProps(material), normalEnu: ORIENTATIONS[r], skyViewFactor: SKY_VIEW[r] });
    }
    materials.forEach((material, c) => { this.emissivity[c] = areaSurfaceProps(material).emissivity; });
    this.field = new ThermalField(elements, config.weather, config.weather.airTemperatureK);
    this.timeUtcMs = config.startUtcMs;
    this.publish();
  }

  /** Integrates from `hours` before the start at air temperature, so the start state carries the diurnal history. */
  spinUp(hours = 24, stepS = 60): void {
    this.field.temperatureK.fill(this.config.weather.airTemperatureK);
    this.timeUtcMs = this.config.startUtcMs - hours * 3_600_000;
    this.advanceTo(this.config.startUtcMs, stepS);
  }

  /** Advances to a UTC instant in steps of at most `stepS` seconds. */
  advanceTo(utcMs: number, stepS = 60): void {
    while (utcMs - this.timeUtcMs > 1e-6) {
      const dtS = Math.min(stepS, (utcMs - this.timeUtcMs) / 1000);
      this.forcingAt(this.timeUtcMs + 500 * dtS, dtS); // forcing at the step midpoint
      if (!this.field.stepFrom(this.forcing)) throw new Error("Thermal step rejected");
      this.timeUtcMs += dtS * 1000;
    }
    this.publish();
  }

  /** Effective sky brightness temperature, K (Swinbank clear sky with the cloud factor). */
  skyTemperatureK(): number {
    const w = this.config.weather;
    return skyEmissivity(w.airTemperatureK, w.cloudFraction) ** 0.25 * w.airTemperatureK;
  }

  private forcingAt(utcMs: number, dtS: number): void {
    const sun = solarPosition(utcMs, this.config.latDeg, this.config.lonDeg);
    const irradiance = clearSkyIrradiance(sun.zenithRad, dayOfYearUtc(utcMs), this.config.weather.cloudFraction);
    const f = this.forcing;
    [f.sunEast, f.sunNorth, f.sunUp] = sun.directionEnu;
    f.directNormalWm2 = irradiance.directNormalWm2;
    f.diffuseHorizontalWm2 = irradiance.diffuseHorizontalWm2;
    f.dtS = dtS;
  }

  private publish(): void {
    const n = this.materials.length, t = this.field.temperatureK;
    for (let r = 0; r < ORIENTATIONS.length; r++) for (let c = 0; c < n; c++) this.temperatureK[r * TABLE_WIDTH + c] = t[r * n + c]!; // r * n + c < count
  }
}
