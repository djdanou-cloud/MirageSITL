import { describe, expect, it } from 'vitest';
import { canonicalBytes } from '@mirage/project/schema';
import { formOf, formProblems, newTaskForm, planLines, taskOfForm, withType } from '../apps/web/src/tasks/flight-task-form.ts';
import { CopterMode, GroundStation } from '@mirage/autopilot/ground-station';
import { autopilotModeName, taskCommandInto } from '@mirage/autopilot/guided';
import { MissionUpload, offsetLocation, routeMissionItems, routePointReached, routePointOfSequence, type MissionItem } from '@mirage/autopilot/mission';
import { encodeInto, MavParser, type MavFrame } from '@mirage/mavlink/codec';
import { fieldOf, packInto, readNumber } from '@mirage/mavlink/messages';
import {
  COMPLETION, FLIGHT_TASK_TYPES, FlightTaskRunner, GUIDANCE_PARAMETERS, LEAD_IN_ACCELERATION_MPS2, LEAD_IN_CLIMB_RATE_MPS, SETTLE_S, TARGET_PERIOD_S, flightTaskProblems, guidanceLimitsOf,
  parseFlightTask, planFlightTask, wrapDeg,
  type AutopilotModeName, type FlightTaskCommand, type FlightTaskDefinition, type FlightTaskStep, type FlightTaskType, type GuidanceLimits, type GuidedTarget, type MissionUploadState,
  parseGroundStart,
} from '@mirage/scenarios/flight-tasks';

// TASK-172: task definition v1, the stage runner and its MAVLink. The
// definition and the runner: Oracle: the stage lists,
// requested values and commands written out here from the task's own numbers,
// against a simulated vehicle that does what it is commanded and reports what
// ArduPilot would (the native ArduCopter flights are in
// tests/integration/flight-tasks-sitl.test.ts).

const GROUND = { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 };
const PARAMETERS: Record<FlightTaskType, Record<string, number>> = {
  takeoff: { altitudeM: 5 },
  hover: { altitudeM: 5, durationS: 10 },
  landing: { altitudeM: 5 },
  straight: { altitudeM: 10, headingDeg: 90, speedMps: 5, distanceM: 50 },
  climb: { fromAltitudeM: 5, toAltitudeM: 15, rateMps: 2 },
  descent: { fromAltitudeM: 15, toAltitudeM: 5, rateMps: 1 },
  acceleration: { altitudeM: 10, headingDeg: 45, fromSpeedMps: 2, toSpeedMps: 8, rateMps2: 1.5 },
  braking: { altitudeM: 10, headingDeg: 45, fromSpeedMps: 8, toSpeedMps: 0, rateMps2: 2 },
  turn: { altitudeM: 10, headingDeg: 350, speedMps: 4, angleDeg: 90, rateDegS: 15 },
  route: {},
};
const ROUTE = [{ northM: 20, eastM: 0, altitudeM: 8, speedMps: 4 }, { northM: 20, eastM: 30, altitudeM: 12, speedMps: 6 }];
/** ArduCopter's defaults at the pinned commit: WP_ACC_Z, PSC_D_JERK, PSC_NE_JERK and ATC_ACC_Y_MAX. */
const LIMITS: GuidanceLimits = { verticalAccelerationMps2: 1, verticalJerkMps3: 5, horizontalJerkMps3: 5, yawAccelerationDegS2: 270 };
const definition = (type: FlightTaskType, edit: Partial<FlightTaskDefinition> = {}): FlightTaskDefinition => ({
  schemaVersion: 1, type, parameters: PARAMETERS[type], route: type === 'route' ? ROUTE : null, initial: { ground: GROUND, air: null }, finish: 'land', ...edit,
});

describe('task definition v1', () => {
  it('accepts a task of each type and freezes it', () => {
    for (const type of FLIGHT_TASK_TYPES) {
      const parsed = parseFlightTask(definition(type));
      expect(parsed).toEqual(definition(type));
      expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.initial.ground) && Object.isFrozen(parsed.parameters)).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(parseFlightTask(definition('route'))))).toEqual(definition('route'));
  });

  it('names every problem of a task it refuses', () => {
    const cases: [unknown, string][] = [
      [null, 'The task is not an object'],
      [{ ...definition('hover'), schemaVersion: 2 }, 'The task is not schema version 1'],
      [{ ...definition('hover'), type: 'loop' }, 'The task type must be one of takeoff, hover'],
      [{ ...definition('hover'), extra: 1 }, 'The task has an unknown field extra'],
      [{ ...definition('hover'), finish: 'crash' }, 'The task must finish by land or hold'],
      [definition('landing', { finish: 'hold' }), 'A landing task finishes by landing'],
      [definition('hover', { parameters: { altitudeM: 0.5, durationS: 10 } }), 'The parameter altitudeM must be a number from 1 to 100'],
      [definition('hover', { parameters: { altitudeM: 5 } }), 'The parameter durationS must be a number from 1 to 3600'],
      [definition('hover', { parameters: { altitudeM: 5, durationS: 10, speedMps: 1 } }), "The hover task's parameters has an unknown field speedMps"],
      [definition('straight', { parameters: { ...PARAMETERS.straight, speedMps: 21 } }), 'The parameter speedMps must be a number from 0.5 to 20'],
      [definition('climb', { parameters: { fromAltitudeM: 15, toAltitudeM: 5, rateMps: 1 } }), 'A climb must end above where it starts'],
      [definition('descent', { parameters: { fromAltitudeM: 5, toAltitudeM: 15, rateMps: 1 } }), 'A descent must end below where it starts'],
      [definition('acceleration', { parameters: { ...PARAMETERS.acceleration, toSpeedMps: 1 } }), 'An acceleration must end faster than it starts'],
      [definition('braking', { parameters: { ...PARAMETERS.braking, toSpeedMps: 9 } }), 'A braking must end slower than it starts'],
      [definition('turn', { parameters: { ...PARAMETERS.turn, angleDeg: 0 } }), 'A turn must turn'],
      [definition('hover', { route: ROUTE }), 'Only a route task has a route'],
      [definition('route', { route: null }), 'A route task needs its route'],
      [definition('route', { route: ROUTE.slice(0, 1) }), 'A route has 2 to 50 points'],
      [definition('route', { route: [ROUTE[0]!, { ...ROUTE[1]!, altitudeM: 0 }] }), 'Route point 2 altitudeM must be a number from 1 to 100'],
      [definition('route', { initial: { ground: GROUND, air: { altitudeM: 5, headingDeg: 0, speedMps: 0 } } }), 'A route starts from the ground'],
      [definition('hover', { initial: { ground: { ...GROUND, stateOfCharge: 0 }, air: null } }), 'The ground start stateOfCharge must be a number from 0.01 to 1'],
      [definition('hover', { initial: { ground: { ...GROUND, northM: 6000 }, air: null } }), 'The ground start northM must be a number from -5000 to 5000'],
      [definition('hover', { initial: { ground: GROUND, air: { altitudeM: 5, headingDeg: 0, speedMps: 25 } } }), 'The airborne start speedMps must be a number from 0 to 20'],
    ];
    for (const [value, message] of cases) {
      expect(flightTaskProblems(value).join(' | '), message).toContain(message);
      expect(() => parseFlightTask(value), message).toThrow(message);
    }
    expect(flightTaskProblems({ ...definition('hover'), type: 'loop', finish: 'crash' })).toHaveLength(2);
  });

  it('plans each type as a lead-in, the task itself and its finish', () => {
    const kinds = (task: FlightTaskDefinition) => planFlightTask(task).map(({ stage, measured }) => `${stage.kind}${measured ? '*' : ''}`);
    expect(kinds(definition('takeoff'))).toEqual(['arm', 'takeoff*', 'land']);
    expect(kinds(definition('takeoff', { finish: 'hold' }))).toEqual(['arm', 'takeoff*']);
    expect(kinds(definition('hover'))).toEqual(['arm', 'takeoff', 'hold*', 'land']);
    expect(kinds(definition('landing'))).toEqual(['arm', 'takeoff', 'land*']);
    expect(kinds(definition('straight'))).toEqual(['arm', 'takeoff', 'heading', 'speed', 'cruise*', 'speed', 'land']);
    expect(kinds(definition('climb'))).toEqual(['arm', 'takeoff', 'vertical*', 'land']);
    expect(kinds(definition('descent'))).toEqual(['arm', 'takeoff', 'vertical*', 'land']);
    expect(kinds(definition('acceleration'))).toEqual(['arm', 'takeoff', 'heading', 'speed', 'speed*', 'speed', 'land']);
    // Braking to a stop needs no stop after it; from a standstill an acceleration needs no lead-in speed.
    expect(kinds(definition('braking'))).toEqual(['arm', 'takeoff', 'heading', 'speed', 'speed*', 'land']);
    expect(kinds(definition('acceleration', { parameters: { ...PARAMETERS.acceleration, fromSpeedMps: 0 } }))).toEqual(['arm', 'takeoff', 'heading', 'speed*', 'speed', 'land']);
    expect(kinds(definition('turn'))).toEqual(['arm', 'takeoff', 'heading', 'speed', 'turn*', 'speed', 'land']);
    expect(kinds(definition('route'))).toEqual(['upload', 'arm', 'takeoff', 'mission*', 'land']);
    // An airborne start replaces the implied lead-in, and the task's clock starts on arrival with the way to its own start.
    const air = { altitudeM: 20, headingDeg: 180, speedMps: 3 };
    expect(kinds(definition('hover', { initial: { ground: GROUND, air } }))).toEqual(['arm', 'takeoff', 'heading', 'speed', 'speed*', 'vertical*', 'hold*', 'land']);
    expect(kinds(definition('takeoff', { initial: { ground: GROUND, air } }))).toEqual(['arm', 'takeoff', 'heading', 'speed', 'speed*', 'vertical*', 'land']);
    const lead = planFlightTask(definition('hover', { initial: { ground: GROUND, air } }));
    expect(lead[1]?.stage).toEqual({ kind: 'takeoff', altitudeM: 20 });
    expect(lead[2]?.stage).toEqual({ kind: 'heading', altitudeM: 20, headingDeg: 180 });
    expect(lead[3]?.stage).toEqual({ kind: 'speed', altitudeM: 20, headingDeg: 180, fromSpeedMps: 0, toSpeedMps: 3, rateMps2: LEAD_IN_ACCELERATION_MPS2 });
    // The stop after a turn goes on along the heading the turn ended on.
    expect(planFlightTask(definition('turn')).at(-2)?.stage).toEqual({ kind: 'speed', altitudeM: 10, headingDeg: 80, fromSpeedMps: 4, toSpeedMps: 0, rateMps2: 2 });
  });
});

/** A vehicle that does what it is commanded, as ArduPilot and the physics together would in still air. */
class Vehicle {
  simTimeS = 100; northM = 0; eastM = 0; altitudeM = 0.1; northMps = 0; eastMps = 0; downMps = 0; headingDeg = 0;
  armed = false; mode: AutopilotModeName = 'other'; mission: MissionUploadState = 'idle'; routePointReached = -1;
  climbTargetM: number | null = null;
  target: GuidedTarget | null = null;
  readonly sent: { simTimeS: number; command: FlightTaskCommand }[] = [];
  readonly origin = { northM: 0, eastM: 0, altitudeM: 0.1 };
  constructor(start: { northM?: number; eastM?: number; altitudeM?: number; headingDeg?: number } = {}) {
    Object.assign(this, start);
    this.origin.northM = this.northM; this.origin.eastM = this.eastM; this.origin.altitudeM = this.altitudeM;
  }
  apply(command: FlightTaskCommand): void {
    this.sent.push({ simTimeS: this.simTimeS, command });
    switch (command.kind) {
      case 'set-mode': this.mode = command.mode; break;
      case 'arm': this.armed = true; break;
      case 'takeoff': this.climbTargetM = this.origin.altitudeM + command.heightM; break;
      case 'target': this.target = command.target; this.climbTargetM = null; break;
      case 'upload-route': this.mission = 'uploading'; break;
      default: { const never: never = command; throw new Error(String(never)); }
    }
  }
  step(dt: number): void {
    this.simTimeS += dt;
    if (!this.armed) return;
    if (this.mode === 'land') {
      this.northMps = 0; this.eastMps = 0; this.downMps = 1;
      this.altitudeM = Math.max(this.origin.altitudeM, this.altitudeM - dt);
      if (this.altitudeM <= this.origin.altitudeM) { this.armed = false; this.downMps = 0; }
      return;
    }
    if (this.climbTargetM !== null) {
      this.altitudeM = Math.min(this.climbTargetM, this.altitudeM + 2.5 * dt);
      this.downMps = this.altitudeM < this.climbTargetM ? -2.5 : 0;
      return;
    }
    if (this.target) {
      // Exactly on the target, with its velocity and yaw.
      const t = this.target;
      this.northM = t.northM + this.origin.northM; this.eastM = t.eastM + this.origin.eastM; this.altitudeM = -t.downM + this.origin.altitudeM;
      this.northMps = t.northMps; this.eastMps = t.eastMps; this.downMps = t.downMps;
      this.headingDeg = wrapDeg(t.yawRad * 180 / Math.PI);
    }
  }
}
function run(task: FlightTaskDefinition, vehicle = new Vehicle(), dt = 0.05, seconds = 600): { runner: FlightTaskRunner; steps: FlightTaskStep[]; vehicle: Vehicle } {
  const runner = new FlightTaskRunner(parseFlightTask(task), LIMITS), steps: FlightTaskStep[] = [];
  for (let i = 0; i < seconds / dt; i++) {
    const step = runner.observe({ simTimeS: vehicle.simTimeS, northM: vehicle.northM, eastM: vehicle.eastM, altitudeM: vehicle.altitudeM, northMps: vehicle.northMps, eastMps: vehicle.eastMps,
      downMps: vehicle.downMps, headingDeg: vehicle.headingDeg, armed: vehicle.armed, mode: vehicle.mode, mission: vehicle.mission, routePointReached: vehicle.routePointReached });
    steps.push(step);
    for (const command of step.commands) vehicle.apply(command);
    if (vehicle.mission === 'uploading') vehicle.mission = 'accepted';
    if (step.progress.state !== 'running') break;
    vehicle.step(dt);
  }
  return { runner, steps, vehicle };
}
const during = (steps: readonly FlightTaskStep[], stage: string) => steps.filter(step => step.measured && step.stage === stage);
const close = (actual: number | null | undefined, expected: number, tolerance: number) => expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(tolerance);

describe('the stage runner against a vehicle that does what it is told', () => {
  it('flies every type to its end and lands', () => {
    for (const type of FLIGHT_TASK_TYPES) {
      const vehicle = new Vehicle();
      // The route's progress comes from ArduPilot: this vehicle reports each point a second after AUTO starts.
      const task = definition(type);
      if (type === 'route') {
        const runner = new FlightTaskRunner(parseFlightTask(task), LIMITS);
        let autoAtS = -1, state = 'running';
        for (let i = 0; i < 20000 && state === 'running'; i++) {
          if (vehicle.mode === 'auto') { autoAtS = autoAtS < 0 ? vehicle.simTimeS : autoAtS; vehicle.routePointReached = Math.min(1, Math.floor(vehicle.simTimeS - autoAtS) - 1); }
          const step = runner.observe({ simTimeS: vehicle.simTimeS, northM: vehicle.northM, eastM: vehicle.eastM, altitudeM: vehicle.altitudeM, northMps: 0, eastMps: 0, downMps: vehicle.downMps,
            headingDeg: 0, armed: vehicle.armed, mode: vehicle.mode, mission: vehicle.mission, routePointReached: vehicle.routePointReached });
          for (const command of step.commands) vehicle.apply(command);
          if (vehicle.mission === 'uploading') vehicle.mission = 'accepted';
          state = step.progress.state;
          vehicle.step(0.05);
        }
        expect(state, type).toBe('done');
      } else {
        const { steps } = run(task, vehicle);
        expect(steps.at(-1)?.progress, type).toEqual({ state: 'done' });
      }
      expect(vehicle.armed, type).toBe(false);
      expect(vehicle.sent.some(item => item.command.kind === 'set-mode' && item.command.mode === 'land'), type).toBe(true);
    }
  });

  it('holds a hover for its duration on its clock, from where the lead-in arrived', () => {
    const { steps } = run(definition('hover'));
    const hold = during(steps, 'hold');
    // The clock starts where the lead-in ended, one observation before the hold's first.
    close(hold[0]?.taskTimeS, 0, 0.051);
    close(hold.at(-1)?.taskTimeS, 10, 0.051);
    expect(hold[0]?.requested).toMatchObject({ altitudeM: 5, speedMps: 0, verticalSpeedMps: 0 });
    // The arrival: what the lead-in was asked for against where it is when the clock starts.
    const arrival = steps.at(-1)?.arrival;
    expect(arrival?.requested).toMatchObject({ altitudeM: 5, speedMps: 0 });
    close(arrival?.actual.altitudeM, 5, COMPLETION.altitudeM);
    // Nothing of the lead-in is on the clock.
    expect(steps.filter(step => !step.measured && step.stage === 'takeoff').every(step => step.taskTimeS === null)).toBe(true);
  });

  it('takes the start position and the rest height off the commands', () => {
    // Started 10 m north and 5 m west of the pad, its CG 0.12 m above it: ArduPilot's frame starts there.
    const { vehicle } = run(definition('hover', { parameters: { altitudeM: 5, durationS: 2 } }), new Vehicle({ northM: 10, eastM: -5, altitudeM: 0.12 }));
    const takeoff = vehicle.sent.find(item => item.command.kind === 'takeoff')?.command;
    expect(takeoff).toEqual({ kind: 'takeoff', heightM: 5 - 0.12 });
    const target = vehicle.sent.find(item => item.command.kind === 'target')?.command;
    if (target?.kind !== 'target') throw new Error('No target sent');
    expect(target.target.northM).toBe(0);
    expect(target.target.eastM).toBe(0);
    close(target.target.downM, -(5 - 0.12), 1e-12);
    // The vehicle above used that frame: it flew at 5 m above the pad, over where it started.
    expect(vehicle.northM).toBe(10);
    expect(vehicle.eastM).toBe(-5);
  });

  it('flies a straight leg along its heading at its speed for its distance', () => {
    const { steps } = run(definition('straight'));
    const cruise = during(steps, 'cruise'), first = cruise[0], last = cruise.at(-1);
    expect(first?.requested).toMatchObject({ altitudeM: 10, speedMps: 5, headingDeg: 90, verticalSpeedMps: 0 });
    // Heading 90: east at 5 m/s, for 50 m, 10 s.
    close(last?.taskTimeS, 10, 0.051);
    close((last?.requested.eastM ?? 0) - (first?.requested.eastM ?? 0), 50, 0.26);
    close((last?.requested.northM ?? 0) - (first?.requested.northM ?? 0), 0, 1e-9);
    // Then it stops at the lead-in's deceleration before it lands.
    const stop = steps.filter(step => !step.measured && step.stage === 'speed' && (step.taskTimeS ?? -1) > 0);
    close(stop.at(0)?.requested.speedMps, 5, 0.11);
    close(stop.at(-1)?.requested.speedMps, 0, 0.11);
    // Each stage takes over where the last ended: the requested position never jumps, and the speed never steps.
    const moving = steps.filter(step => step.requested.eastM !== null && step.requested.speedMps !== null);
    moving.slice(1).forEach((step, i) => {
      close(step.requested.eastM, moving[i]?.requested.eastM ?? 0, 5 * 0.05 + 1e-9);
      close(step.requested.speedMps, moving[i]?.requested.speedMps ?? 0, LEAD_IN_ACCELERATION_MPS2 * 0.05 + 1e-9);
    });
  });

  it('climbs and descends at their rates, starting and stopping within ArduPilot\'s limits', () => {
    const climb = during(run(definition('climb')).steps, 'vertical');
    const at = (steps: readonly FlightTaskStep[], t: number) => {
      const step = steps.find(item => (item.taskTimeS ?? 0) >= t);
      if (!step) throw new Error(`Nothing at ${t} s`);
      return { step, t: step.taskTimeS ?? 0 };
    };
    // From 5 m to 15 m at 2 m/s, 1 m/s² and 5 m/s³: acceleration grows over 0.2 s to 1 m/s², which adds 0.1 m/s, then
    // 1.8 s at 1 m/s² and 0.2 s easing off reach 2 m/s after 2.2 s and 2.2 m. So does the stop, leaving 5.6 m at 2 m/s for 2.8 s.
    const ramp = at(climb, 1.2);
    close(ramp.step.requested.verticalSpeedMps, 0.1 + (ramp.t - 0.2), 1e-9);
    for (const t of [2.5, 3.6, 4.5]) {
      const { step, t: time } = at(climb, t);
      close(step.requested.altitudeM, 5 + 2.2 + 2 * (time - 2.2), 1e-9);
      expect(step.requested.verticalSpeedMps).toBe(2);
    }
    const ending = at(climb, 6.6);
    close(ending.step.requested.verticalSpeedMps, 0.1 + (7.0 - ending.t), 1e-9);
    // No corner: between observations the requested rate changes by at most the limit.
    climb.slice(1).forEach((step, i) => close(step.requested.verticalSpeedMps, climb[i]?.requested.verticalSpeedMps ?? 0, 1 * 0.05 + 1e-9));
    expect(climb.at(-1)?.requested).toMatchObject({ altitudeM: 15, verticalSpeedMps: 0 });
    // It then holds the end for the settling time, on the clock, so the trace shows any overshoot.
    close(climb.at(-1)?.taskTimeS, 7.2 + SETTLE_S, 0.11);
    // From 15 m to 5 m at 1 m/s: 1.2 s and 0.6 m to reach 1 m/s, the same to stop, 8.8 m between.
    const descent = during(run(definition('descent')).steps, 'vertical');
    const middle = at(descent, 5);
    close(middle.step.requested.altitudeM, 15 - 0.6 - (middle.t - 1.2), 1e-9);
    expect(middle.step.requested.verticalSpeedMps).toBe(-1);
    close(descent.at(-1)?.taskTimeS, 11.2 + SETTLE_S, 0.11);
  });

  it('sends a climb\'s velocity and acceleration with its position', () => {
    const { vehicle } = run(definition('climb'));
    const targets = vehicle.sent.flatMap(item => (item.command.kind === 'target' ? [item.command.target] : []));
    const speeding = targets.find(target => target.downMps2 < -0.99 && target.downMps < -0.5), cruising = targets.find(target => target.downMps === -2), braking = targets.find(target => target.downMps2 > 0.99);
    // Up is negative down. Accelerating up, cruising with none, then braking.
    expect(speeding?.downMps2).toBe(-1);
    close(cruising?.downMps2, 0, 0);
    expect(braking?.downMps2).toBe(1);
  });

  it('changes speed at its rate, in the jerk limit\'s shape', () => {
    const up = during(run(definition('acceleration')).steps, 'speed');
    // 2 to 8 m/s at 1.5 m/s² and 5 m/s³: acceleration grows over 0.3 s, adding 0.225 m/s, and 4 s + 0.3 s in all.
    const half = up.find(item => (item.taskTimeS ?? 0) >= 2), time = half?.taskTimeS ?? 0;
    close(half?.requested.speedMps, 2.225 + 1.5 * (time - 0.3), 1e-9);
    close(up.at(-1)?.taskTimeS, 4.3 + SETTLE_S, 0.11);
    expect(up.at(-1)?.requested.speedMps).toBe(8);
    const down = during(run(definition('braking')).steps, 'speed');
    // 8 to 0 at 2 m/s²: acceleration falls over 0.4 s, taking off 0.4 m/s.
    const brake = down.find(item => (item.taskTimeS ?? 0) >= 1), brakeTime = brake?.taskTimeS ?? 0;
    close(brake?.requested.speedMps, 7.6 - 2 * (brakeTime - 0.4), 1e-9);
    expect(down.at(-1)?.requested.speedMps).toBe(0);
    // Velocity and acceleration lie along the heading: 45° is as much north as east.
    const vehicle = run(definition('acceleration')).vehicle;
    const moving = vehicle.sent.map(item => item.command).find(command => command.kind === 'target' && command.target.northMps > 3 && command.target.northMps2 > 1);
    if (moving?.kind !== 'target') throw new Error('No moving target');
    close(moving.target.northMps, moving.target.eastMps, 1e-9);
    close(moving.target.northMps2, 1.5 * Math.SQRT1_2, 1e-9);
    close(moving.target.eastMps2, 1.5 * Math.SQRT1_2, 1e-9);
  });

  it('turns through its angle at its rate, either way, across north, with the curve\'s sideways acceleration', () => {
    const right = run(definition('turn'));
    const turn = during(right.steps, 'turn');
    // At 4 m/s and 5 m/s³ the turn rate may change by 1.25 rad/s², 71.6°/s²: 15°/s after 0.209 s and 1.571°, each way.
    // From 350° through 90°: (90 - 2·1.571)/15 = 5.79 s between, 6.21 s in all, ending on 80°, across north.
    const curveS = 15 / (1.25 * 180 / Math.PI), curveDeg = 15 * curveS / 2;
    close(turn.at(-1)?.taskTimeS, curveS + 90 / 15 + SETTLE_S, 0.11);
    close(turn.at(-1)?.requested.headingDeg, 80, 1e-9);
    const third = turn.find(item => (item.taskTimeS ?? 0) >= 2);
    close(third?.requested.headingDeg, wrapDeg(350 + curveDeg + 15 * ((third?.taskTimeS ?? 0) - curveS)), 1e-9);
    const during2 = right.vehicle.sent.map(item => item.command).filter(command => command.kind === 'target' && command.target.yawRateRadS === 15 * Math.PI / 180);
    expect(during2.length).toBeGreaterThan(0);
    for (const command of during2) {
      if (command.kind !== 'target') continue;
      const t = command.target;
      // Acceleration across the velocity, of speed times turn rate: 4 m/s × 15°/s = 1.05 m/s².
      close(t.northMps * t.northMps2 + t.eastMps * t.eastMps2, 0, 1e-9);
      close(Math.hypot(t.northMps2, t.eastMps2), 4 * 15 * Math.PI / 180, 1e-9);
      // Turning right, the acceleration points right of the velocity.
      expect(t.northMps * t.eastMps2 - t.eastMps * t.northMps2).toBeGreaterThan(0);
    }
    const left = during(run(definition('turn', { parameters: { ...PARAMETERS.turn, headingDeg: 10, angleDeg: -90 } })).steps, 'turn');
    close(left.at(-1)?.requested.headingDeg, 280, 1e-9);
  });

  it('turns to a lead-in\'s heading the short way, ending on it', () => {
    const { steps, vehicle } = run(definition('straight', { parameters: { ...PARAMETERS.straight, headingDeg: 350 } }));
    const turning = steps.filter(step => step.stage === 'heading');
    expect(turning.length).toBeGreaterThan(0);
    close(turning.at(-1)?.requested.headingDeg, 350, 1e-9);
    // The short way from north is left, 10°, at 30°/s.
    expect(turning.every(step => { const heading = step.requested.headingDeg ?? 0; return heading === 0 || heading >= 350; })).toBe(true);
    const rates = vehicle.sent.flatMap(item => (item.command.kind === 'target' && item.command.target.yawRateRadS !== 0 ? [item.command.target.yawRateRadS] : []));
    expect(rates.length).toBeGreaterThan(0);
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(-30 * Math.PI / 180 - 1e-9);
    expect(Math.max(...rates)).toBeLessThan(0);
  });

  it('resends the guided target well inside GUID_TIMEOUT, and asks for a mode only once a second', () => {
    const { vehicle } = run(definition('straight'));
    const targets = vehicle.sent.filter(item => item.command.kind === 'target').map(item => item.simTimeS);
    const gaps = targets.slice(1).map((t, i) => t - targets[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(TARGET_PERIOD_S + 0.051);
    expect(Math.min(...gaps)).toBeGreaterThan(0);
  });

  it('flies a lead-in to an airborne start and starts the clock on arrival', () => {
    const air = { altitudeM: 20, headingDeg: 180, speedMps: 3 };
    const { steps } = run(definition('hover', { initial: { ground: GROUND, air } }));
    const first = steps.find(step => step.measured);
    close(first?.taskTimeS, 0, 0.051);
    const arrival = steps.at(-1)?.arrival;
    expect(arrival?.requested).toMatchObject(air);
    close(arrival?.actual.altitudeM, 20, COMPLETION.altitudeM);
    close(arrival?.actual.speedMps, 3, COMPLETION.speedMps);
    close(arrival?.actual.headingDeg, 180, COMPLETION.headingDeg);
    // On the clock, the hover first stops smoothly, then goes down to its own altitude, then holds: no request ever jumps.
    expect(first?.stage).toBe('speed');
    const measured = steps.filter(step => step.measured);
    expect([...new Set(measured.map(step => step.stage))]).toEqual(['speed', 'vertical', 'hold', 'land'].filter(stage => stage !== 'land'));
    measured.filter(step => step.requested.altitudeM !== null).slice(1).forEach((step, i, rest) => {
      const previous = i === 0 ? measured[0] : rest[i - 1];
      close(step.requested.altitudeM, previous?.requested.altitudeM ?? 0, LEAD_IN_CLIMB_RATE_MPS * 0.05 + 1e-9);
      close(step.requested.speedMps, previous?.requested.speedMps ?? 0, LEAD_IN_ACCELERATION_MPS2 * 0.05 + 1e-9);
    });
    expect(during(steps, 'hold')[0]?.requested).toMatchObject({ altitudeM: 5, speedMps: 0 });
  });

  it('plans the way from an airborne start to the task\'s own start, on the task\'s clock', () => {
    const plan = (type: FlightTaskType, air: { altitudeM: number; headingDeg: number; speedMps: number }, parameters?: Record<string, number>) =>
      planFlightTask(definition(type, { initial: { ground: GROUND, air }, ...(parameters ? { parameters } : {}) })).filter(item => item.measured).map(item => item.stage);
    const stop = { kind: 'speed', toSpeedMps: 0 } as const;
    // Already there, moving as the task starts: straight into the task.
    expect(plan('straight', { altitudeM: 10, headingDeg: 90, speedMps: 5 }).map(stage => stage.kind)).toEqual(['cruise']);
    // Another speed on the same heading and height: changed in flight.
    expect(plan('straight', { altitudeM: 10, headingDeg: 90, speedMps: 2 })[0]).toMatchObject({ kind: 'speed', fromSpeedMps: 2, toSpeedMps: 5 });
    // Another height or heading: stop, change it, then reach the task's speed.
    expect(plan('straight', { altitudeM: 20, headingDeg: 0, speedMps: 3 })).toMatchObject([
      { ...stop, altitudeM: 20, headingDeg: 0, fromSpeedMps: 3 }, { kind: 'heading', altitudeM: 20, headingDeg: 90 },
      { kind: 'vertical', fromAltitudeM: 20, toAltitudeM: 10, rateMps: LEAD_IN_CLIMB_RATE_MPS }, { kind: 'speed', altitudeM: 10, headingDeg: 90, fromSpeedMps: 0, toSpeedMps: 5 }, { kind: 'cruise' },
    ]);
    // A hover keeps the heading it arrived on and needs only to stop and change height.
    expect(plan('hover', { altitudeM: 8, headingDeg: 45, speedMps: 3 }).map(stage => stage.kind)).toEqual(['speed', 'vertical', 'hold']);
    expect(plan('hover', { altitudeM: 5, headingDeg: 45, speedMps: 0 }).map(stage => stage.kind)).toEqual(['hold']);
    // A take-off from the air climbs from where it stopped; a landing stops first.
    expect(plan('takeoff', { altitudeM: 3, headingDeg: 45, speedMps: 2 })).toMatchObject([stop, { kind: 'vertical', fromAltitudeM: 3, toAltitudeM: 5 }]);
    expect(plan('landing', { altitudeM: 5, headingDeg: 45, speedMps: 2 }).map(stage => stage.kind)).toEqual(['speed', 'land']);
  });

  it('reads its limits from what the autopilot reports', () => {
    const reported = new Map<string, number>([['WP_ACC_Z', 1.5], ['PSC_D_JERK', 4], ['PSC_NE_JERK', 3], ['ATC_ACC_Y_MAX', 90]]);
    expect(GUIDANCE_PARAMETERS).toEqual(['WP_ACC_Z', 'PSC_D_JERK', 'PSC_NE_JERK', 'ATC_ACC_Y_MAX']);
    expect(guidanceLimitsOf(name => reported.get(name))).toEqual({ verticalAccelerationMps2: 1.5, verticalJerkMps3: 4, horizontalJerkMps3: 3, yawAccelerationDegS2: 90 });
    // ArduPilot's 0 is no limit on the yaw acceleration, and a turn still has its horizontal jerk limit.
    expect(guidanceLimitsOf(name => (name === 'ATC_ACC_Y_MAX' ? 0 : reported.get(name))).yawAccelerationDegS2).toBe(Number.POSITIVE_INFINITY);
    expect(() => guidanceLimitsOf(name => (name === 'WP_ACC_Z' ? undefined : reported.get(name)))).toThrow('ArduPilot does not report WP_ACC_Z');
    expect(() => guidanceLimitsOf(name => (name === 'PSC_D_JERK' ? 0 : reported.get(name)))).toThrow('ArduPilot reports PSC_D_JERK as 0');
    expect(() => guidanceLimitsOf(name => (name === 'PSC_NE_JERK' ? -1 : reported.get(name)))).toThrow('ArduPilot reports PSC_NE_JERK as -1');
    expect(() => guidanceLimitsOf(name => (name === 'ATC_ACC_Y_MAX' ? Number.NaN : reported.get(name)))).toThrow('ATC_ACC_Y_MAX');
  });
  it('flies with no yaw limit', () => {
    const { steps } = run(definition('turn'), new Vehicle(), 0.05, 600);
    expect(steps.at(-1)?.progress).toEqual({ state: 'done' });
    const unlimited = new FlightTaskRunner(parseFlightTask(definition('straight')), { ...LIMITS, yawAccelerationDegS2: Number.POSITIVE_INFINITY });
    const step = unlimited.observe({ simTimeS: 0, northM: 0, eastM: 0, altitudeM: 0.1, northMps: 0, eastMps: 0, downMps: 0, headingDeg: 0, armed: true, mode: 'guided', mission: 'idle', routePointReached: -1 });
    expect(step.progress).toEqual({ state: 'running' });
  });

  it('uploads a route once, flies it in AUTO, and asks for each point until ArduPilot reports it reached', () => {
    const vehicle = new Vehicle({ altitudeM: 0.15 }), runner = new FlightTaskRunner(parseFlightTask(definition('route')), LIMITS);
    const observe = () => {
      const step = runner.observe({ simTimeS: vehicle.simTimeS, northM: 0, eastM: 0, altitudeM: vehicle.altitudeM, northMps: 0, eastMps: 0, downMps: vehicle.downMps, headingDeg: 0, armed: vehicle.armed,
        mode: vehicle.mode, mission: vehicle.mission, routePointReached: vehicle.routePointReached });
      for (const command of step.commands) vehicle.apply(command);
      vehicle.step(0.05);
      return step;
    };
    let step = observe();
    expect(step.commands).toEqual([{ kind: 'upload-route', points: ROUTE, groundAltitudeM: 0.15 }]);
    // Not armed until ArduPilot accepted the route, and sent once.
    for (let i = 0; i < 40; i++) { step = observe(); expect(step.commands).toEqual([]); expect(step.stage).toBe('upload'); }
    vehicle.mission = 'accepted';
    while (step.stage !== 'mission') step = observe();
    expect(vehicle.armed).toBe(true);
    step = observe();
    expect(vehicle.mode).toBe('auto');
    expect(step.requested).toMatchObject({ northM: 20, eastM: 0, altitudeM: 8, speedMps: 4 });
    vehicle.routePointReached = 0;
    step = observe();
    expect(step.requested).toMatchObject({ northM: 20, eastM: 30, altitudeM: 12, speedMps: 6 });
    vehicle.routePointReached = 1;
    step = observe();
    step = observe();
    expect(step.stage).toBe('land');
  });

  it('fails with a reason when ArduPilot refuses, disarms, leaves the mode or takes too long', () => {
    const refused = new Vehicle(), route = new FlightTaskRunner(parseFlightTask(definition('route')), LIMITS);
    const look = (runner: FlightTaskRunner, vehicle: Vehicle) => {
      const step = runner.observe({ simTimeS: vehicle.simTimeS, northM: vehicle.northM, eastM: vehicle.eastM, altitudeM: vehicle.altitudeM, northMps: vehicle.northMps, eastMps: vehicle.eastMps, downMps: vehicle.downMps,
        headingDeg: vehicle.headingDeg, armed: vehicle.armed, mode: vehicle.mode, mission: vehicle.mission, routePointReached: vehicle.routePointReached });
      for (const command of step.commands) vehicle.apply(command);
      return step;
    };
    look(route, refused);
    refused.mission = 'failed';
    expect(look(route, refused).progress).toEqual({ state: 'failed', reason: 'ArduPilot refused the route' });
    const flyUntil = (edit: (vehicle: Vehicle) => void) => {
      const vehicle = new Vehicle(), runner = new FlightTaskRunner(parseFlightTask(definition('hover')), LIMITS);
      let step = look(runner, vehicle);
      while (step.stage !== 'hold') { vehicle.step(0.05); step = look(runner, vehicle); }
      edit(vehicle);
      vehicle.step(0.05);
      return look(runner, vehicle).progress;
    };
    expect(flyUntil(vehicle => { vehicle.armed = false; })).toEqual({ state: 'failed', reason: 'The autopilot disarmed during the hold stage' });
    expect(flyUntil(vehicle => { vehicle.mode = 'other'; })).toEqual({ state: 'failed', reason: 'The autopilot left its flight mode during the hold stage' });
    // An autopilot that never arms: the stage's plan plus its margin.
    const stuck = new Vehicle(), runner = new FlightTaskRunner(parseFlightTask(definition('hover')), LIMITS);
    let progress = look(runner, stuck).progress;
    stuck.armed = false;
    for (let i = 0; i < 2000 && progress.state === 'running'; i++) {
      stuck.simTimeS += 0.05;
      const step = runner.observe({ simTimeS: stuck.simTimeS, northM: 0, eastM: 0, altitudeM: 0.1, northMps: 0, eastMps: 0, downMps: 0, headingDeg: 0, armed: false, mode: 'guided', mission: 'idle', routePointReached: -1 });
      progress = step.progress;
    }
    expect(progress).toEqual({ state: 'failed', reason: 'The arm stage did not finish within 90 s of simulated time' });
  });

  it('leaves a task that finishes by holding in the air', () => {
    const { steps, vehicle } = run(definition('hover', { finish: 'hold' }));
    expect(steps.at(-1)?.progress).toEqual({ state: 'done' });
    expect(vehicle.armed).toBe(true);
    expect(vehicle.sent.some(item => item.command.kind === 'set-mode' && item.command.mode === 'land')).toBe(false);
    close(vehicle.altitudeM, 5, 1e-9);
  });
});

/** The frames of bytes, decoded by the TASK-150 codec. */
function decode(bytes: Uint8Array): MavFrame[] {
  const frames: MavFrame[] = [];
  new MavParser(frame => frames.push({ ...frame, view: new DataView(frame.view.buffer.slice(frame.view.byteOffset, frame.view.byteOffset + frame.view.byteLength)) })).push(bytes);
  return frames;
}
const value = (frame: MavFrame | undefined, name: string) => {
  const field = frame ? fieldOf(frame.id, name) : null;
  if (!frame || !field) throw new Error(`No ${name}`);
  return readNumber(frame.view, field);
};
/** A frame as ArduPilot would send it. */
function autopilotFrame(id: number, values: Record<string, number>, length: number): MavFrame {
  const payload = new Uint8Array(length), out = new Uint8Array(300);
  if (!packInto(id, values, payload)) throw new Error(`Cannot pack ${id}`);
  const n = encodeInto(id, payload, 0, 1, 1, out);
  const frame = decode(out.subarray(0, n))[0];
  if (!frame) throw new Error('Not decoded');
  return frame;
}

describe('the commands on the wire', () => {
  const gcs = new GroundStation(), out = new Uint8Array(300);

  it('packs a guided target as SET_POSITION_TARGET_LOCAL_NED with position, velocity, acceleration and yaw in use', () => {
    const n = taskCommandInto({ kind: 'target', target: { northM: 12.5, eastM: -3.25, downM: -4.875, northMps: 1.5, eastMps: -0.5, downMps: 0.25, northMps2: 0.75, eastMps2: -1.25, downMps2: 0.5, yawRad: 1.5, yawRateRadS: -0.25 } }, gcs, out);
    const frame = decode(out.subarray(0, n))[0];
    expect(frame?.id).toBe(84);
    expect(['x', 'y', 'z', 'vx', 'vy', 'vz', 'afx', 'afy', 'afz', 'yaw', 'yaw_rate'].map(name => value(frame, name))).toEqual([12.5, -3.25, -4.875, 1.5, -0.5, 0.25, 0.75, -1.25, 0.5, 1.5, -0.25]);
    // MAV_FRAME_LOCAL_NED; no ignore bit, and in particular not FORCE_SET, so ArduCopter takes its position, velocity and acceleration path.
    expect(value(frame, 'coordinate_frame')).toBe(1);
    expect(value(frame, 'type_mask')).toBe(0);
    expect([value(frame, 'target_system'), value(frame, 'target_component')]).toEqual([1, 1]);
  });

  it('packs mode, arming and take-off as the commands ArduCopter expects', () => {
    const command = (c: Parameters<typeof taskCommandInto>[0]) => decode(out.subarray(0, taskCommandInto(c, gcs, out)))[0];
    const auto = command({ kind: 'set-mode', mode: 'auto' });
    expect([value(auto, 'command'), value(auto, 'param1'), value(auto, 'param2')]).toEqual([176, 1, 3]);
    expect(value(command({ kind: 'set-mode', mode: 'guided' }), 'param2')).toBe(4);
    expect(value(command({ kind: 'set-mode', mode: 'land' }), 'param2')).toBe(9);
    const arm = command({ kind: 'arm' });
    expect([value(arm, 'command'), value(arm, 'param1')]).toEqual([400, 1]);
    const takeoff = command({ kind: 'takeoff', heightM: 4.875 });
    expect([value(takeoff, 'command'), value(takeoff, 'param7')]).toEqual([22, 4.875]);
    expect(taskCommandInto({ kind: 'upload-route', points: [], groundAltitudeM: 0 }, gcs, out)).toBe(0);
    expect([CopterMode.Guided, CopterMode.Auto, CopterMode.Land, CopterMode.Loiter, null].map(autopilotModeName)).toEqual(['guided', 'auto', 'land', 'other', 'other']);
  });

  it('computes a waypoint as ArduPilot computes a location offset', () => {
    // Location::offset at the SITL home: 1e-7° of latitude is 0.011131884502145034 m, and longitude shrinks by the cosine of the mean latitude.
    expect(offsetLocation(-35.363261, 149.16523, 0, 0)).toEqual({ latitudeE7: -353632610, longitudeE7: 1491652300 });
    const north = offsetLocation(-35.363261, 149.16523, 100, 0), east = offsetLocation(-35.363261, 149.16523, 0, 100);
    expect(north).toEqual({ latitudeE7: -353632610 + 8983, longitudeE7: 1491652300 });
    expect(east.latitudeE7).toBe(-353632610);
    expect(Math.abs(east.longitudeE7 - 1491652300 - 100 / 0.011131884502145034 / Math.cos(35.363261 * Math.PI / 180))).toBeLessThan(1);
    expect(east.longitudeE7 - 1491652300).toBe(11015);
  });

  it('turns a route into the home slot, then a speed and a waypoint per point, with heights above the rest height', () => {
    const items = routeMissionItems(ROUTE, { latitudeDeg: -35.363261, longitudeDeg: 149.16523 }, 0.1);
    expect(items.map(item => [item.seq, item.command, item.frame])).toEqual([[0, 16, 0], [1, 178, 2], [2, 16, 3], [3, 178, 2], [4, 16, 3]]);
    expect([items[1]?.param1, items[1]?.param2, items[1]?.param3]).toEqual([1, 4, -1]);
    expect(items[2]?.z).toBeCloseTo(7.9, 12);
    expect(items[3]?.param2).toBe(6);
    expect(items[4]?.z).toBeCloseTo(11.9, 12);
    expect(items[4]?.y).toBe(offsetLocation(-35.363261, 149.16523, 20, 30).longitudeE7);
    expect([0, 1, 2, 3, 4].map(routePointOfSequence)).toEqual([-1, -1, 0, 0, 1]);
  });

  it('uploads a mission only on ArduPilot\'s acceptance, answering what it asks for', () => {
    const items = routeMissionItems(ROUTE, { latitudeDeg: -35.363261, longitudeDeg: 149.16523 }, 0.1), sent: (MissionItem | number)[] = [];
    const upload = new MissionUpload(items, { sendCount: count => sent.push(count), sendItem: item => sent.push(item) });
    expect(upload.state).toBe('idle');
    upload.start(10);
    expect(sent).toEqual([5]);
    // No answer yet: MISSION_COUNT again a second later.
    upload.tick(10.5);
    expect(sent).toEqual([5]);
    upload.tick(11);
    expect(sent).toEqual([5, 5]);
    for (const seq of [0, 1, 1, 2, 3, 4]) {
      expect(upload.frame(autopilotFrame(51, { seq, target_system: 255, target_component: 190, mission_type: 0 }, 5), 12)).toBe(true);
      expect(sent.at(-1)).toEqual(items[seq]);
      expect(upload.state).toBe('uploading');
    }
    // The older MISSION_REQUEST is answered too, and other messages are not the upload's.
    upload.frame(autopilotFrame(40, { seq: 4, target_system: 255, target_component: 190, mission_type: 0 }, 5), 12);
    expect(sent.at(-1)).toEqual(items[4]);
    expect(upload.frame(autopilotFrame(46, { seq: 2 }, 2), 12)).toBe(false);
    expect(upload.frame(autopilotFrame(47, { target_system: 255, target_component: 190, type: 0, mission_type: 0, opaque_id: 0 }, 8), 12)).toBe(true);
    expect(upload.state).toBe('accepted');
  });

  it('fails an upload that ArduPilot refuses, ignores, or stops asking for', () => {
    const items = routeMissionItems(ROUTE, { latitudeDeg: 0, longitudeDeg: 0 }, 0), link = { sendCount: () => undefined, sendItem: () => undefined };
    const ack = (type: number) => autopilotFrame(47, { target_system: 255, target_component: 190, type, mission_type: 0, opaque_id: 0 }, 8);
    const refused = new MissionUpload(items, link);
    refused.start(0);
    refused.frame(ack(4), 0);
    expect([refused.state, refused.reason]).toEqual(['failed', 'ArduPilot refused the mission: no space']);
    const silent = new MissionUpload(items, link);
    silent.start(0);
    for (let t = 1; t <= 6; t++) silent.tick(t);
    expect([silent.state, silent.reason]).toEqual(['failed', 'ArduPilot did not answer MISSION_COUNT after 5 attempts']);
    const stalled = new MissionUpload(items, link);
    stalled.start(0);
    stalled.frame(autopilotFrame(51, { seq: 0, target_system: 255, target_component: 190, mission_type: 0 }, 5), 1);
    stalled.tick(5.9);
    expect(stalled.state).toBe('uploading');
    stalled.tick(6.1);
    expect([stalled.state, stalled.reason]).toEqual(['failed', 'ArduPilot stopped asking for mission items after 5 s of simulated time']);
    const wrong = new MissionUpload(items, link);
    wrong.start(0);
    wrong.frame(autopilotFrame(51, { seq: 9, target_system: 255, target_component: 190, mission_type: 0 }, 5), 1);
    expect([wrong.state, wrong.reason]).toEqual(['failed', 'ArduPilot asked for mission item 9 of 5']);
  });

  it('reads the route point ArduPilot reports reached', () => {
    expect(routePointReached(autopilotFrame(46, { seq: 2 }, 2))).toBe(0);
    expect(routePointReached(autopilotFrame(46, { seq: 4 }, 2))).toBe(1);
    expect(routePointReached(autopilotFrame(46, { seq: 0 }, 2))).toBeNull();
    expect(routePointReached(autopilotFrame(47, { target_system: 255, target_component: 190, type: 0, mission_type: 0, opaque_id: 0 }, 8))).toBeNull();
  });
});

const parseTaskOfType = (type: FlightTaskType): FlightTaskDefinition => taskOfForm(newTaskForm(type));
describe('the Flight tasks tab\'s form', () => {
  const definitions: readonly FlightTaskDefinition[] = [
    ...FLIGHT_TASK_TYPES.filter(type => type !== 'route').map(type => {
      const parameters = Object.fromEntries(Object.entries(formOf(parseTaskOfType(type)).parameters).map(([key, value]) => [key, Number(value)]));
      return parseFlightTask({ schemaVersion: 1, type, parameters, route: null, initial: { ground: { northM: 10.25, eastM: -5.5, headingDeg: 359.5, stateOfCharge: 0.333 }, air: type === 'landing' ? null : { altitudeM: 12.5, headingDeg: 45, speedMps: 3 } },
        finish: type === 'landing' ? 'land' : 'hold' });
    }),
    parseFlightTask({ schemaVersion: 1, type: 'route', parameters: {}, route: [{ northM: 20, eastM: 0.1, altitudeM: 8, speedMps: 4 }, { northM: -3.75, eastM: 30, altitudeM: 12.125, speedMps: 6 }],
      initial: { ground: { northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 0.8 }, air: null }, finish: 'land' }),
  ];
  it.each(definitions.map(task => [task.type, task] as const))('%s goes to text and back as the same definition, byte for byte', (_type, task) => {
    const again = taskOfForm(formOf(task));
    expect(again).toEqual(task);
    expect(canonicalBytes(again)).toEqual(canonicalBytes(task));
  });
  it('holds every charge from 1 to 100 percent exactly', () => {
    for (let percent = 1; percent <= 100; percent++) {
      const form = { ...newTaskForm(), groundChargePercent: String(percent) };
      expect(formOf(taskOfForm(form)).groundChargePercent).toBe(String(percent));
      expect(taskOfForm(form).initial.ground.stateOfCharge).toBe(percent / 100);
    }
  });
  it('says what is wrong in the words of the fields, and an empty field is not zero', () => {
    const form = newTaskForm('hover');
    expect(formProblems(form)).toEqual([]);
    expect(formProblems({ ...form, parameters: { ...form.parameters, altitudeM: '' } })).toEqual(['Altitude (m) must be a number from 1 to 100']);
    expect(formProblems({ ...form, groundChargePercent: '120' })).toEqual(['Battery charge must be a number from 1 to 100 percent']);
    expect(formProblems({ ...form, groundNorthM: 'x' })).toEqual(['The start north must be a number from -5000 to 5000']);
    expect(formProblems({ ...withType(form, 'route'), route: [{ northM: '1', eastM: '', altitudeM: '5', speedMps: '4' }] })).toEqual([
      'A route has 2 to 50 points', 'Route point 1: east must be a number from -5000 to 5000',
    ]);
    expect(formProblems({ ...form, airborne: true, airAltitudeM: '0' })).toEqual(['The airborne altitude must be a number from 1 to 100']);
  });
  it('a new task of every type is a valid example, and changing the type keeps the initial conditions', () => {
    for (const type of FLIGHT_TASK_TYPES) expect(formProblems(newTaskForm(type)), type).toEqual([]);
    const changed = withType({ ...newTaskForm('hover'), groundNorthM: '7', airborne: true, finish: 'hold' }, 'landing');
    expect(changed).toMatchObject({ groundNorthM: '7', airborne: true, finish: 'land' });
    expect(withType({ ...newTaskForm('hover'), airborne: true }, 'route').airborne).toBe(false);
  });
  it('words each stage of the plan and marks the measured one', () => {
    expect(planLines(taskOfForm(newTaskForm('hover')))).toEqual([
      { text: 'GUIDED mode, and arm', measured: false }, { text: 'Take off to 5 m', measured: false },
      { text: 'Hold at 5 m for 10 s', measured: true }, { text: 'LAND mode, until ArduPilot disarms', measured: false },
    ]);
  });
});

describe('the ground start the physics Worker admits', () => {
  it('accepts the task\'s ground values and refuses anything else with every reason', () => {
    expect(parseGroundStart({ northM: 10, eastM: -5, headingDeg: 90, stateOfCharge: 0.8 })).toEqual({ northM: 10, eastM: -5, headingDeg: 90, stateOfCharge: 0.8 });
    expect(() => parseGroundStart(null)).toThrow('not an object');
    expect(() => parseGroundStart({ northM: Number.NaN, eastM: 0, headingDeg: 0, stateOfCharge: 2, extra: 1 })).toThrow(/extra.*northM.*stateOfCharge/s);
  });
});
