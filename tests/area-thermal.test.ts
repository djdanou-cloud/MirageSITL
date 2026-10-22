// TASK-073 P5: per-class surface temperatures for the area of operation.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AREA_EMISSIVITY, AreaThermal, HEAT_PROPS_PROXY, ORIENTATIONS, TABLE_WIDTH, areaSurfaceProps } from "../packages/thermal/src/area-thermal.ts";
import { TYPICAL_SURFACE_PROPS } from "../packages/thermal/src/heat-balance.ts";
import { MATERIAL_COLORS } from "../apps/web/src/render/material-drape.ts";

const weather = { airTemperatureK: 303.15, windSpeedMps: 3, cloudFraction: 0.1, deepTemperatureK: 298.15 };
const area = { latDeg: 32.20065261195932, lonDeg: 34.87163838506722 };
const classes = ["synthetic-ground", "vegetation-grass", "asphalt", "water", "roof-metal"];

describe("material emissivities", () => {
  it("covers every raster class with a documented 8-14 um value and heat-property proxy", () => {
    const config: unknown = JSON.parse(readFileSync("config/material-classes.json", "utf8"));
    const configured = [...JSON.stringify(config).matchAll(/"material":"([a-z-]+)"/g)].map(m => m[1] ?? "");
    for (const id of new Set([...configured, ...Object.keys(MATERIAL_COLORS)])) {
      const entry = AREA_EMISSIVITY[id];
      expect(entry, id).toBeDefined();
      expect(entry!.emissivity).toBeGreaterThan(0);
      expect(entry!.emissivity).toBeLessThanOrEqual(1);
      expect(entry!.source.length).toBeGreaterThan(5);
      expect(TYPICAL_SURFACE_PROPS[HEAT_PROPS_PROXY[id] ?? ""], id).toBeDefined();
    }
    // Operator-approved stand-ins (docs/needed_for_task073.md section 9.1).
    expect(areaSurfaceProps("vegetation-grass").emissivity).toBe(0.97);
    expect(areaSurfaceProps("asphalt").emissivity).toBe(0.93);
    expect(areaSurfaceProps("bare-soil").emissivity).toBe(0.92);
    expect(areaSurfaceProps("water").emissivity).toBe(0.95);
    expect(areaSurfaceProps("unknown-class")).toEqual(areaSurfaceProps("synthetic-ground"));
    // Heat capacity etc. come from the proxy; only the emissivity is replaced.
    expect(areaSurfaceProps("cropland").arealHeatCapacityJM2K).toBe(TYPICAL_SURFACE_PROPS["vegetation-grass"]!.arealHeatCapacityJM2K);
  });
});

describe("area heat balance", () => {
  it("lays out the table by orientation row and class column from the ThermalField", () => {
    const a = new AreaThermal(classes, { ...area, startUtcMs: Date.UTC(2026, 6, 15, 7), weather });
    a.spinUp();
    expect(a.temperatureK.length).toBe(ORIENTATIONS.length * TABLE_WIDTH);
    for (let r = 0; r < ORIENTATIONS.length; r++) {
      for (let c = 0; c < classes.length; c++) expect(a.temperatureK[r * TABLE_WIDTH + c]).toBeCloseTo(a.field.temperatureK[r * classes.length + c]!, 4);
    }
    expect(Array.from(a.emissivity.subarray(0, classes.length))).toEqual(classes.map(m => Math.fround(areaSurfaceProps(m).emissivity)));
    expect(a.timeUtcMs).toBe(Date.UTC(2026, 6, 15, 7));
  });

  it("warms sunlit surfaces by day, cools them at night and favours the sun-facing wall", () => {
    const at = (hourUtc: number) => {
      const a = new AreaThermal(classes, { ...area, startUtcMs: Date.UTC(2026, 6, 15, hourUtc), weather });
      a.spinUp();
      return a;
    };
    const morning = at(5), noon = at(10), night = at(22);
    const up = (a: AreaThermal, c: number) => a.temperatureK[c]!;
    const row = (a: AreaThermal, r: number, c: number) => a.temperatureK[r * TABLE_WIDTH + c]!;
    for (const c of [0, 1, 2]) {
      expect(up(noon, c)).toBeGreaterThan(weather.airTemperatureK + 5);
      expect(up(night, c)).toBeLessThan(weather.airTemperatureK);
    }
    // Water's large heat capacity damps its diurnal swing.
    expect(up(noon, 3) - up(night, 3)).toBeLessThan((up(noon, 0) - up(night, 0)) / 3);
    // 08:00 local: the sun is in the east, so the east wall is warmer than the west wall (rows 1 and 3).
    expect(row(morning, 1, 0)).toBeGreaterThan(row(morning, 3, 0) + 3);
    expect(morning.skyTemperatureK()).toBeLessThan(weather.airTemperatureK);
  });

  it("keeps evaporating tree canopy near air temperature and far below asphalt (FLIR sample: trees read darker)", () => {
    const mats = ["vegetation-tree", "asphalt"];
    const a = new AreaThermal(mats, { ...area, startUtcMs: Date.UTC(2026, 6, 15, 10), weather: { ...weather, relativeHumidity: 0.6 } });
    a.spinUp();
    const tree = a.temperatureK[0]!, asphalt = a.temperatureK[1]!;
    expect(tree - weather.airTemperatureK).toBeLessThan(4);
    expect(tree - weather.airTemperatureK).toBeGreaterThan(-2);
    expect(asphalt - tree).toBeGreaterThan(10);
  });

  it("advances continuously: one step to a time equals stepping through it", () => {
    const a = new AreaThermal(classes, { ...area, startUtcMs: Date.UTC(2026, 6, 15, 7), weather });
    const b = new AreaThermal(classes, { ...area, startUtcMs: Date.UTC(2026, 6, 15, 7), weather });
    a.spinUp(); b.spinUp();
    a.advanceTo(Date.UTC(2026, 6, 15, 7, 10));
    for (let s = 1; s <= 600; s++) b.advanceTo(Date.UTC(2026, 6, 15, 7) + s * 1000);
    // 60 s versus 1 s steps of the same Heun integrator.
    for (let i = 0; i < classes.length; i++) expect(Math.abs(a.temperatureK[i]! - b.temperatureK[i]!)).toBeLessThan(0.05);
    expect(() => new AreaThermal([], { ...area, startUtcMs: 0, weather })).toThrow();
    expect(() => new AreaThermal(classes, { ...area, latDeg: 91, startUtcMs: 0, weather })).toThrow();
  });
});
