import { expect, it } from "vitest";
import { AutopilotSession } from "../packages/autopilot/src/state-machine";
it("requires fresh autopilot health and prevents concurrent backends/illegal transitions", () => {
  const a = new AutopilotSession(100);
  expect(a.start(0)).toBe(false);
  expect(a.connect("external-sitl", 7, 0)).toBe(true);
  expect(a.connect("hitl", 8, 0)).toBe(false);
  expect(a.state).toBe("initializing");
  expect(a.initialized()).toBe(true);
  expect(a.start(1)).toBe(false);
  expect(
    a.health(
      {
        source: "autopilot",
        epoch: 6,
        sampleTimeMs: 1,
        ekfHealthy: true,
        linkHealthy: true,
      },
      1,
    ),
  ).toBe(false);
  expect(
    a.health(
      {
        source: "autopilot",
        epoch: 7,
        sampleTimeMs: 1,
        ekfHealthy: true,
        linkHealthy: true,
      },
      1,
    ),
  ).toBe(true);
  expect(a.state).toBe("ready");
  expect(a.start(1)).toBe(false);
  const controls = new Float64Array(16).fill(0.6);
  expect(a.acceptActuators(controls, 7, 2, 2)).toBe(true);
  expect(a.start(2)).toBe(true);
  expect(a.poll(103)).toBe(false);
  expect(a.state).toBe("fault");
  expect(a.actuators.every((x) => x === 0)).toBe(true);
  expect(a.initialized()).toBe(false);
  a.disconnect();
  expect(a.connect("hitl", 8, 104)).toBe(true);
});
it("rejects replayed/nonfinite actuator samples and clears thrust on disarm, health loss and clock reversal", () => {
  const a = new AutopilotSession();
  a.connect("hitl", 1, 0);
  a.initialized();
  a.health(
    {
      source: "autopilot",
      epoch: 1,
      sampleTimeMs: 1,
      ekfHealthy: true,
      linkHealthy: true,
    },
    1,
  );
  const controls = new Float64Array(16).fill(0.5);
  expect(a.acceptActuators(controls, 1, 2, 2)).toBe(true);
  expect(a.acceptActuators(controls, 1, 2, 2)).toBe(false);
  a.start(2);
  a.disarm();
  expect(a.actuators[0]).toBe(0);
  controls[0] = NaN;
  expect(a.acceptActuators(controls, 1, 3, 3)).toBe(false);
  expect(
    a.health(
      {
        source: "autopilot",
        epoch: 1,
        sampleTimeMs: 3,
        ekfHealthy: false,
        linkHealthy: true,
      },
      3,
    ),
  ).toBe(false);
  expect(a.state).toBe("fault");
  a.disconnect();
  a.connect("external-sitl", 2, 5);
  expect(a.poll(4)).toBe(false);
  expect(a.actuators[0]).toBe(0);
});
