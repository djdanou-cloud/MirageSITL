import { expect, it } from "vitest";
import { createSessionFaultPort } from "@mirage/ew/session-port";
import { PhysicsSessionV2 } from "@mirage/physics";
import { EwFlagV2, StateReaderV2, createSharedMemoryV2, createSpscQueue, newFlightStateV2, tickToNumber, type CommandResultV2 } from "@mirage/protocol";
import fixture from "./fixtures/scenarios/pilot-basics.json";
import { ScenarioBinder } from "../packages/scenarios/src/bind.ts";
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
it("does not claim a fault applied until the applied ACK", () => {
  const binder = new ScenarioBinder(parseScenario(fixture), () => 7);
  const command = binder.poll(400, false, 3);
  expect(command?.expectedEpoch).toBe(3);
  expect(command?.requestId).toBe(7);
  expect(binder.claimsApplied(0)).toBe(false);
  binder.observe({ type: "ack-v2", requestId: 7, status: "queued", epoch: 3, appliedTick: { lo: 400, hi: 0 } });
  expect(binder.state(0)).toBe("queued");
  expect(binder.claimsApplied(0)).toBe(false);
  binder.observe({ type: "ack-v2", requestId: 7, status: "applied", epoch: 3, appliedTick: { lo: 400, hi: 0 } });
  expect(binder.claimsApplied(0)).toBe(true);
});
it("applies a scenario fault on the live session tick and records a weather rejection", () => {
  const scenario = parseScenario(fixture);
  let request = 100;
  const binder = new ScenarioBinder(scenario, () => request++);
  const faults = createSessionFaultPort();
  const time = { mono: 0, wall: 1_790_000_000_000 };
  const stateBuffer = createSharedMemoryV2();
  const session = new PhysicsSessionV2(
    { type: "init-v2", protocolVersion: 2, stateBuffer, sensorBuffer: createSpscQueue("sensor"), actuatorBuffer: createSpscQueue("actuator") },
    { monotonicMs: () => time.mono, wallMs: () => time.wall + time.mono }, undefined, faults);
  session.setBeforeTick((tick) => {
    const command = binder.poll(tickToNumber(tick), false, session.currentEpoch);
    if (command) session.handle(command);
  });
  session.handle({ protocolVersion: 2, requestId: 90, expectedEpoch: session.currentEpoch, type: "sim.start" });
  for (let i = 0; i < 1100; i++) { time.mono += 1; session.pump(); }
  session.drain((event) => binder.observe(event));
  expect(binder.claimsApplied(0)).toBe(true);
  const state = newFlightStateV2();
  expect(new StateReaderV2(stateBuffer).latest(state)).toBe(true);
  expect(state.ewFlags & EwFlagV2.GnssJamming).toBeTruthy();
  const weather = parseScenario({
    ...fixture,
    id: "weather-check",
    events: [{
      tick: 1,
      command: {
        protocolVersion: 2, requestId: 1, expectedEpoch: 0, atTick: { hi: 0, lo: 1 },
        type: "weather.set", windNedMps: [1, 0, 0], temperatureK: 288, pressurePa: 101325,
        turbulenceRmsMps: 0, seed: 1,
      },
    }],
  });
  const weatherBinder = new ScenarioBinder(weather, () => 200);
  const weatherSession = new PhysicsSessionV2(
    { type: "init-v2", protocolVersion: 2, stateBuffer: createSharedMemoryV2(), sensorBuffer: createSpscQueue("sensor"), actuatorBuffer: createSpscQueue("actuator") },
    { monotonicMs: () => time.mono, wallMs: () => time.wall + time.mono }, undefined, faults);
  const seen: CommandResultV2[] = [];
  weatherSession.setBeforeTick((tick) => {
    const command = weatherBinder.poll(tickToNumber(tick), false, weatherSession.currentEpoch);
    if (command) weatherSession.handle(command);
  });
  weatherSession.handle({ protocolVersion: 2, requestId: 91, expectedEpoch: weatherSession.currentEpoch, type: "sim.start" });
  time.mono += 20;
  weatherSession.pump();
  weatherSession.drain((event) => { seen.push(event); weatherBinder.observe(event); });
  expect(weatherBinder.claimsApplied(0)).toBe(false);
  expect(weatherBinder.state(0)).toBe("rejected");
  expect(seen.some((event) => event.type === "reject-v2")).toBe(true);
});
