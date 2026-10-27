import { describe, expect, it } from "vitest";
import { flightPlanFromSearch } from "../apps/web/src/flight-plan";

// TASK-073: only `?flight=circuit` hands the sticks to the scripted pilot, and the circuit stays inside the area.
describe("flight plan selection", () => {
  it("is off unless requested exactly", () => {
    expect(flightPlanFromSearch("", undefined)).toBeNull();
    expect(flightPlanFromSearch("?flight=Circuit", undefined)).toBeNull();
    expect(flightPlanFromSearch("?g3=1", "1000")).toBeNull();
  });
  it("keeps the circuit within 60% of the configured area radius", () => {
    expect(flightPlanFromSearch("?g3=1&flight=circuit", undefined)?.circuitRadiusM).toBe(300);
    expect(flightPlanFromSearch("?flight=circuit", "1000")?.circuitRadiusM).toBe(300);
    expect(flightPlanFromSearch("?flight=circuit", "200")?.circuitRadiusM).toBe(120);
    expect(flightPlanFromSearch("?flight=circuit", "not-a-number")?.circuitRadiusM).toBe(300);
    expect(() => flightPlanFromSearch("?flight=circuit", "20")).toThrow(); // a 12 m circuit is below the supported envelope
  });
});
