// Scripted flight selection (TASK-073). `?flight=circuit` flies a circuit of
// at most 300 m radius, kept inside 60% of the area-of-operation radius set at
// build time (VITE_MIRAGE_AREA_RADIUS_M, default 1000 m). Anything else keeps
// manual input.
import { validateFlightPlan, type FlightPlan } from "@mirage/input/scripted-flight";

const DEFAULT_AREA_RADIUS_M = 1000;
const CIRCUIT_RADIUS_M = 300, ALTITUDE_M = 30, SPEED_MPS = 10;
/** Long enough for any G3 capture (60 s warmup + 600 s); the vehicle keeps circling. */
const DURATION_S = 3600;

export function flightPlanFromSearch(search: string, areaRadius: unknown): FlightPlan | null {
  if (new URLSearchParams(search).get("flight") !== "circuit") return null;
  const parsed = typeof areaRadius === "string" && areaRadius !== "" ? Number(areaRadius) : DEFAULT_AREA_RADIUS_M;
  const radiusM = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AREA_RADIUS_M;
  const plan: FlightPlan = { altitudeM: ALTITUDE_M, circuitRadiusM: Math.min(CIRCUIT_RADIUS_M, 0.6 * radiusM), speedMps: SPEED_MPS, durationS: DURATION_S };
  validateFlightPlan(plan);
  return plan;
}
