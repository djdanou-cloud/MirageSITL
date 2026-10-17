import type { Scenario } from "./schema.ts";
export interface ScenarioTraceSample { tick: number; altitudeM: number; healthyEkf: boolean; source: "autopilot" | "synthetic" }
/** Post-flight rubric; every integer hold tick must exist exactly once. No timer-only PASS. */
export function evaluateScenario(scenario: Scenario, samples: readonly ScenarioTraceSample[]): { status: "PASS" | "FAIL" | "BLOCKED_EXTERNAL"; maxAltitudeErrorM: number; reason: string } {
  let expected = scenario.rubric.holdStartTick, max = 0, previous = -1;
  for (const sample of samples) {
    if (!Number.isSafeInteger(sample.tick) || sample.tick <= previous || !Number.isFinite(sample.altitudeM) || sample.source !== "autopilot") return { status: "BLOCKED_EXTERNAL", maxAltitudeErrorM: max, reason: "Missing real, ordered autopilot trace" };
    previous = sample.tick;
    if (sample.tick < scenario.rubric.holdStartTick || sample.tick > scenario.rubric.holdEndTick) continue;
    if (sample.tick !== expected++) return { status: "FAIL", maxAltitudeErrorM: max, reason: "Hold trace gap" };
    max = Math.max(max, Math.abs(sample.altitudeM - scenario.rubric.targetAltitudeM));
    if (scenario.rubric.requireHealthyEkf && !sample.healthyEkf) return { status: "FAIL", maxAltitudeErrorM: max, reason: "Unhealthy EKF" };
  }
  if (expected !== scenario.rubric.holdEndTick + 1) return { status: "BLOCKED_EXTERNAL", maxAltitudeErrorM: max, reason: "Incomplete hold trace" };
  return { status: max <= scenario.rubric.maxAltitudeErrorM ? "PASS" : "FAIL", maxAltitudeErrorM: max, reason: "Altitude hold rubric" };
}
