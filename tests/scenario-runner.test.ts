import { expect, it } from "vitest";
import fixture from "./fixtures/scenarios/pilot-basics.json";
import { parseScenario } from "../packages/scenarios/src/schema.ts";
import { ScenarioRunner } from "../packages/scenarios/src/runner.ts";
import { evaluateScenario } from "../packages/scenarios/src/evaluate.ts";
it("emits identical events on simulation ticks, pauses without penalties and rejects late dispatch", () => {
  const s = parseScenario(fixture), make = () => new ScenarioRunner(s, s.modelSha256, s.firmwareSha256, s.seed, s.hz);
  const a = make(), b = make();
  expect(a.nextEventIndex(400, true)).toBe(-1);
  expect(a.nextEventIndex(0, false)).toBe(-1);
  expect(a.nextEventIndex(400, false)).toBe(b.nextEventIndex(400, false));
  expect(a.nextEventIndex(400, false)).toBe(-1);
  a.reset(); expect(a.nextEventIndex(401, false)).toBe(-2);
  expect(() => new ScenarioRunner(s, "wrong", s.firmwareSha256, s.seed, 400)).toThrow();
  expect(Object.isFrozen(s.events[0]?.command)).toBe(true);
});
it("rejects unknown keys, out-of-order events and command/schema mismatches", () => {
  for (const change of [{ schemaVersion: 2 }, { events: [{ ...fixture.events[0], tick: 399 }] }, { hz: 500 }, { seed: -1 }, { rubric: { ...fixture.rubric, holdEndTick: 1 } }, { extra: true }]) expect(() => parseScenario({ ...fixture, ...change })).toThrow();
});
it("evaluates ordered complete autopilot traces, not elapsed timers or fabricated observations", () => {
  const s = parseScenario(fixture);
  const samples = Array.from({ length: 401 }, (_, i) => ({ tick: 800 + i, altitudeM: 10, healthyEkf: true, source: "autopilot" as const }));
  expect(evaluateScenario(s, samples).status).toBe("PASS");
  expect(evaluateScenario(s, []).status).toBe("BLOCKED_EXTERNAL");
  expect(evaluateScenario(s, samples.map(p => ({ ...p, source: "synthetic" as const }))).status).toBe("BLOCKED_EXTERNAL");
  expect(evaluateScenario(s, samples.filter(p => p.tick !== 900)).status).toBe("FAIL");
  expect(evaluateScenario(s, samples.map(p => ({ ...p, altitudeM: 12 }))).status).toBe("FAIL");
});
