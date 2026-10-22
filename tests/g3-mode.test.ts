import { describe, expect, it } from "vitest";
import { DEFAULT_THERMAL_UTC_MS, g3Requested, g3ThermalUtcFromSearch, g3ViewFromSearch } from "../apps/web/src/render/g3-mode";

// TASK-073: the measurement scene presents the chase view unless `view=fpv` is requested.
describe("g3 view selection", () => {
  it("defaults to the chase view", () => {
    expect(g3ViewFromSearch("?g3=1")).toBe("chase");
    expect(g3ViewFromSearch("?g3=1&view=chase")).toBe("chase");
    expect(g3ViewFromSearch("?g3=1&view=FPV")).toBe("chase");
  });
  it("presents the FPV image only when asked", () => {
    expect(g3ViewFromSearch("?g3=1&view=fpv")).toBe("fpv");
    expect(g3Requested("?view=fpv")).toBe(false);
  });
  it("presents the thermal image for inspection (TASK-073 P5)", () => {
    expect(g3ViewFromSearch("?g3=1&view=thermal")).toBe("thermal");
  });
});

describe("thermal scene time", () => {
  it("defaults to a summer morning and accepts only zoned ISO instants", () => {
    expect(g3ThermalUtcFromSearch("?g3=1")).toBe(DEFAULT_THERMAL_UTC_MS);
    expect(DEFAULT_THERMAL_UTC_MS).toBe(Date.UTC(2026, 6, 15, 7));
    expect(g3ThermalUtcFromSearch("?thermalUtc=2026-01-10T12:30:00Z")).toBe(Date.UTC(2026, 0, 10, 12, 30));
    expect(g3ThermalUtcFromSearch("?thermalUtc=2026-01-10T14:30:00%2B02:00")).toBe(Date.UTC(2026, 0, 10, 12, 30));
    for (const bad of ["2026-01-10T12:30:00", "yesterday", "2200-01-01T00:00:00Z"]) {
      expect(g3ThermalUtcFromSearch(`?thermalUtc=${bad}`), bad).toBe(DEFAULT_THERMAL_UTC_MS);
    }
  });
});
