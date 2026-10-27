import { describe, expect, it } from "vitest";
import { ControlFlag, newInput } from "@mirage/protocol";
import { DemoDynamics } from "../packages/physics/src/demo-dynamics";
import { ScriptedPilot, newStickCommand, validateFlightPlan, type FlightObservation, type FlightPhase } from "../packages/input/src/scripted-flight";

// TASK-073 scripted flight: the pilot moves only the sticks of the real demo
// dynamics. Oracles are geometric: altitude reached, circle radius/speed held,
// the vehicle stays inside the area, and the landing ends on the ground.
interface FlightLog { t: number; phase: FlightPhase; north: number; east: number; altitude: number; speed: number; armed: boolean }

function fly(plan: { altitudeM: number; circuitRadiusM: number; speedMps: number; durationS: number }, physicsHz: 400 | 800 = 400, pilotHz = 60): FlightLog[] {
  const dyn = new DemoDynamics(physicsHz);
  const pilot = new ScriptedPilot(plan);
  const stick = newStickCommand();
  const input = newInput();
  const obs: FlightObservation = { simTimeS: 0, northM: 0, eastM: 0, downM: 0, vnMps: 0, veMps: 0, vdMps: 0, qw: 1, qx: 0, qy: 0, qz: 0 };
  const log: FlightLog[] = [];
  let armed = false;
  const stepsPerPilot = physicsHz / pilotHz;
  let carry = 0;
  for (let k = 0; k < plan.durationS * pilotHz; k++) {
    const s = dyn.state;
    obs.simTimeS = s.simTime; obs.northM = s.north; obs.eastM = s.east; obs.downM = s.down;
    obs.vnMps = s.vn; obs.veMps = s.ve; obs.vdMps = s.vd; obs.qw = s.qw; obs.qx = s.qx; obs.qy = s.qy; obs.qz = s.qz;
    pilot.update(obs, stick);
    if (stick.arm && !armed && stick.throttle <= 0.05) armed = true; // the runtime arms only at zero throttle
    if (!stick.arm) armed = false;
    input.roll = stick.roll; input.pitch = stick.pitch; input.yaw = stick.yaw; input.throttle = stick.throttle;
    input.flags = ControlFlag.Connected | (armed ? ControlFlag.Armed : 0);
    carry += stepsPerPilot;
    for (; carry >= 1; carry--) {
      const nowMs = s.simTime * 1000;
      input.wallTimeMs = nowMs;
      dyn.step(input, nowMs);
    }
    log.push({ t: s.simTime, phase: pilot.phase, north: s.north, east: s.east, altitude: -s.down, speed: Math.hypot(s.vn, s.ve), armed });
  }
  return log;
}

describe("scripted flight", () => {
  it("rejects plans outside the supported envelope", () => {
    expect(() => validateFlightPlan({ altitudeM: 2, circuitRadiusM: 300, speedMps: 10, durationS: 600 })).toThrow();
    expect(() => validateFlightPlan({ altitudeM: 30, circuitRadiusM: 300, speedMps: 30, durationS: 600 })).toThrow();
    expect(() => validateFlightPlan({ altitudeM: 30, circuitRadiusM: 300, speedMps: 10, durationS: Number.NaN })).toThrow();
  });

  it("climbs, holds a 300 m circuit at 10 m/s and 30 m, then lands at the origin", () => {
    const plan = { altitudeM: 30, circuitRadiusM: 300, speedMps: 10, durationS: 420 };
    const log = fly(plan);
    const circuit = log.filter(e => e.phase === "circuit");
    const settled = circuit.slice(Math.floor(circuit.length * 0.1)); // after the entry transient
    expect(settled.length).toBeGreaterThan(60 * 120); // at least two minutes of circuit
    for (const e of settled) {
      expect(Math.abs(Math.hypot(e.north, e.east) - plan.circuitRadiusM)).toBeLessThan(10);
      expect(Math.abs(e.altitude - plan.altitudeM)).toBeLessThan(2);
      expect(Math.abs(e.speed - plan.speedMps)).toBeLessThan(1.5);
    }
    // Never leaves a 1 km area and never touches the ground between take-off and landing.
    for (const e of log) expect(Math.hypot(e.north, e.east)).toBeLessThan(1000);
    const airborne = log.filter(e => e.phase === "transit" || e.phase === "circuit" || e.phase === "return");
    for (const e of airborne) expect(e.altitude).toBeGreaterThan(20);
    const last = log.at(-1);
    expect(last?.phase).toBe("done");
    expect(last?.altitude).toBeLessThan(0.05);
    expect(Math.hypot(last?.north ?? 99, last?.east ?? 99)).toBeLessThan(5);
  });

  it("flies the same circuit at 800 Hz physics with a 144 Hz pilot", () => {
    const log = fly({ altitudeM: 40, circuitRadiusM: 200, speedMps: 8, durationS: 200 }, 800, 144);
    const settled = log.filter(e => e.phase === "circuit").slice(144 * 20);
    expect(settled.length).toBeGreaterThan(144 * 60);
    for (const e of settled) {
      expect(Math.abs(Math.hypot(e.north, e.east) - 200)).toBeLessThan(10);
      expect(Math.abs(e.altitude - 40)).toBeLessThan(2);
    }
  });
});
