// Flight tasks (TASK-172, S10): the task definition v1 stored with an
// experiment, and FlightTaskRunner, the pure stage machine that flies one. The
// runner takes the session's truth and the autopilot's mode, arming and mission
// reports, and returns the commands to send and what is requested at that
// moment; ArduPilot receives the commands and the physics computes the motion.
//
// Altitudes are metres above the pad, as the Run tab shows them; north and east
// are metres from the pad, in the session's frame. Headings are degrees from
// north, clockwise. ArduPilot's own frame starts where it was at its first GPS
// fix, so the commands take the start position and the CG's rest height off.
//
// Ground values of `initial` apply at the session's start tick, before arming.
// An airborne start (`initial.air`) is a lead-in (user decision of 2026-11-04):
// ArduPilot needs about 41 s of simulated time to become READY, so an aircraft
// placed in the air at the start tick would fall first. The runner takes off
// and flies to the requested height, heading and speed, and the task's clock
// starts on arrival. Without `initial.air` the lead-in goes to the state the
// task's own parameters start from.
//
// Every target is one ArduPilot can follow without correcting (smooth-motion.ts):
// speed, height and heading change within ArduPilot's own limits, read from the
// autopilot (GuidanceLimits), and each target carries the position, velocity and
// acceleration of that moment. A target with sharp corners makes ArduPilot fall
// behind, fly faster than asked to catch up, and overshoot where it should stop.
// What is requested is therefore what can be flown: a climb at 2 m/s reaches 2 m/s
// after ArduPilot's own ramp, and the trace shows that ramp.

// Tuning maneuvers (maneuvers.ts, TASK-173) are tasks of their own types. Roll and pitch go to ArduPilot as an
// attitude with the height held; heading and altitude go as position targets. Unlike every other stage, a maneuver
// asks for sharp corners on purpose: how the aircraft answers a sudden change is what a maneuver measures.

import { MANEUVER_TYPES, isManeuverType, maneuverTimeline, offsetAt, type ManeuverAxis, type ManeuverTimeline } from './maneuvers.ts';
import { restToRest, speedChange, type MotionProfile } from './smooth-motion.ts';

export const FLIGHT_TASK_TYPES = ['takeoff', 'hover', 'landing', 'straight', 'climb', 'descent', 'acceleration', 'braking', 'turn', 'route',
  'roll-step', 'roll-doublet', 'pitch-step', 'pitch-doublet', 'heading-step', 'heading-doublet', 'altitude-step', 'altitude-doublet'] as const;
export type FlightTaskType = (typeof FLIGHT_TASK_TYPES)[number];
/** Schema 2 adds the tuning maneuvers. A task of an earlier type stays schema 1, byte for byte, so its stored versions and their SHA-256 do not change. */
export const flightTaskSchemaVersion = (type: FlightTaskType): 1 | 2 => (isManeuverType(type) ? 2 : 1);
export const FLIGHT_TASK_FINISHES = ['land', 'hold'] as const;
export type FlightTaskFinish = (typeof FLIGHT_TASK_FINISHES)[number];

export interface RoutePoint { readonly northM: number; readonly eastM: number; readonly altitudeM: number; readonly speedMps: number }
export interface GroundStart { readonly northM: number; readonly eastM: number; readonly headingDeg: number; readonly stateOfCharge: number }
export interface AirStart { readonly altitudeM: number; readonly headingDeg: number; readonly speedMps: number }
export interface FlightTaskInitial { readonly ground: GroundStart; readonly air: AirStart | null }

/** The numeric parameters of each type: name, smallest and largest value. */
const ALTITUDE = [1, 100] as const, HEADING = [0, 360] as const, SPEED = [0, 20] as const, CRUISE = [0.5, 20] as const;
/** A lean up to ArduCopter's default ATC_ANGLE_MAX, held no longer than this: a lean held on keeps accelerating. */
const LEAN = { altitudeM: ALTITUDE, headingDeg: HEADING, amplitudeDeg: [-30, 30], holdS: [0.5, 10] } as const;
const HOLD = [0.5, 60] as const;
/** A heading follows the shortest way round, so one change must stay below half a turn: a doublet's change is twice its amplitude. */
const TURN_STEP = [-170, 170] as const, TURN_DOUBLET = [-85, 85] as const;
export const FLIGHT_TASK_PARAMETERS = {
  takeoff: { altitudeM: ALTITUDE },
  hover: { altitudeM: ALTITUDE, durationS: [1, 3600] },
  landing: { altitudeM: ALTITUDE },
  straight: { altitudeM: ALTITUDE, headingDeg: HEADING, speedMps: CRUISE, distanceM: [1, 5000] },
  climb: { fromAltitudeM: ALTITUDE, toAltitudeM: ALTITUDE, rateMps: [0.1, 5] },
  descent: { fromAltitudeM: ALTITUDE, toAltitudeM: ALTITUDE, rateMps: [0.1, 5] },
  acceleration: { altitudeM: ALTITUDE, headingDeg: HEADING, fromSpeedMps: SPEED, toSpeedMps: SPEED, rateMps2: [0.1, 5] },
  braking: { altitudeM: ALTITUDE, headingDeg: HEADING, fromSpeedMps: SPEED, toSpeedMps: SPEED, rateMps2: [0.1, 5] },
  turn: { altitudeM: ALTITUDE, headingDeg: HEADING, speedMps: CRUISE, angleDeg: [-1080, 1080], rateDegS: [1, 90] },
  route: {},
  'roll-step': LEAN, 'roll-doublet': LEAN, 'pitch-step': LEAN, 'pitch-doublet': LEAN,
  'heading-step': { altitudeM: ALTITUDE, headingDeg: HEADING, amplitudeDeg: TURN_STEP, holdS: HOLD },
  'heading-doublet': { altitudeM: ALTITUDE, headingDeg: HEADING, amplitudeDeg: TURN_DOUBLET, holdS: HOLD },
  'altitude-step': { altitudeM: ALTITUDE, amplitudeM: [-50, 50], holdS: HOLD },
  'altitude-doublet': { altitudeM: ALTITUDE, amplitudeM: [-50, 50], holdS: HOLD },
} as const satisfies Record<FlightTaskType, Record<string, readonly [number, number]>>;
/** ArduPilot's waypoint storage holds far more; this bounds a route typed by hand. */
export const MAX_ROUTE_POINTS = 50;
export const MIN_ROUTE_POINTS = 2;
const POSITION_LIMIT_M = 5000;

export interface FlightTaskDefinition {
  readonly schemaVersion: 1 | 2;
  readonly type: FlightTaskType;
  /** The type's own numbers, FLIGHT_TASK_PARAMETERS; empty for a route. */
  readonly parameters: Readonly<Record<string, number>>;
  /** The route's points; null for every other type. */
  readonly route: readonly RoutePoint[] | null;
  readonly initial: FlightTaskInitial;
  /** After the task: land and disarm, or hold where it ended for the user to land. A landing task always lands. */
  readonly finish: FlightTaskFinish;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const inRange = (value: unknown, low: number, high: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
function unexpected(value: Record<string, unknown>, keys: readonly string[], what: string): string[] {
  return Object.keys(value).filter(key => !keys.includes(key)).map(key => `${what} has an unknown field ${key}`);
}
function numbers(value: Record<string, unknown>, limits: Readonly<Record<string, readonly [number, number]>>, what: string): string[] {
  return Object.entries(limits).flatMap(([key, [low, high]]) => (inRange(value[key], low, high) ? [] : [`${what} ${key} must be a number from ${low} to ${high}`]));
}
const ROUTE_POINT_LIMITS = { northM: [-POSITION_LIMIT_M, POSITION_LIMIT_M], eastM: [-POSITION_LIMIT_M, POSITION_LIMIT_M], altitudeM: ALTITUDE, speedMps: CRUISE } as const;
const GROUND_LIMITS = { northM: [-POSITION_LIMIT_M, POSITION_LIMIT_M], eastM: [-POSITION_LIMIT_M, POSITION_LIMIT_M], headingDeg: HEADING, stateOfCharge: [0.01, 1] } as const;
const AIR_LIMITS = { altitudeM: ALTITUDE, headingDeg: HEADING, speedMps: SPEED } as const;

/** Why a value is not a task definition v1, each reason ready to show; empty when it is one. */
export function flightTaskProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['The task is not an object'];
  const problems = unexpected(value, ['schemaVersion', 'type', 'parameters', 'route', 'initial', 'finish'], 'The task');
  const type = FLIGHT_TASK_TYPES.find(item => item === value.type);
  if (!type) problems.push(`The task type must be one of ${FLIGHT_TASK_TYPES.join(', ')}`);
  if (type ? value.schemaVersion !== flightTaskSchemaVersion(type) : value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    problems.push(`The task is not schema version ${type ? flightTaskSchemaVersion(type) : '1 or 2'}`);
  }
  if (value.finish !== 'land' && value.finish !== 'hold') problems.push('The task must finish by land or hold');
  if (type === 'landing' && value.finish !== 'land') problems.push('A landing task finishes by landing');
  const parameters = value.parameters;
  if (!isRecord(parameters)) problems.push('The task has no parameters');
  else if (type) {
    const limits: Readonly<Record<string, readonly [number, number]>> = FLIGHT_TASK_PARAMETERS[type];
    problems.push(...unexpected(parameters, Object.keys(limits), `The ${type} task's parameters`), ...numbers(parameters, limits, 'The parameter'));
    const from = parameters.fromAltitudeM, to = parameters.toAltitudeM, fromSpeed = parameters.fromSpeedMps, toSpeed = parameters.toSpeedMps;
    if (type === 'climb' && typeof from === 'number' && typeof to === 'number' && !(to > from)) problems.push('A climb must end above where it starts');
    if (type === 'descent' && typeof from === 'number' && typeof to === 'number' && !(to < from)) problems.push('A descent must end below where it starts');
    if (type === 'acceleration' && typeof fromSpeed === 'number' && typeof toSpeed === 'number' && !(toSpeed > fromSpeed)) problems.push('An acceleration must end faster than it starts');
    if (type === 'braking' && typeof fromSpeed === 'number' && typeof toSpeed === 'number' && !(toSpeed < fromSpeed)) problems.push('A braking must end slower than it starts');
    if (type === 'turn' && inRange(parameters.angleDeg, -1080, 1080) && parameters.angleDeg === 0) problems.push('A turn must turn');
    if (isManeuverType(type) && (parameters.amplitudeDeg === 0 || parameters.amplitudeM === 0)) problems.push('A maneuver must change something: its amplitude cannot be 0');
    if (isManeuverType(type) && MANEUVER_TYPES[type].axis === 'altitude' && typeof parameters.altitudeM === 'number' && typeof parameters.amplitudeM === 'number') {
      const reached = MANEUVER_TYPES[type].shape === 'doublet' ? [parameters.altitudeM + parameters.amplitudeM, parameters.altitudeM - parameters.amplitudeM] : [parameters.altitudeM + parameters.amplitudeM];
      for (const altitudeM of reached) if (altitudeM < ALTITUDE[0] || altitudeM > ALTITUDE[1]) problems.push(`The maneuver would go to ${altitudeM} m, outside ${ALTITUDE[0]} to ${ALTITUDE[1]} m`);
    }
  }
  const route = value.route;
  if (type === 'route') {
    if (!Array.isArray(route)) problems.push('A route task needs its route');
    else {
      const points: readonly unknown[] = route;
      if (points.length < MIN_ROUTE_POINTS || points.length > MAX_ROUTE_POINTS) problems.push(`A route has ${MIN_ROUTE_POINTS} to ${MAX_ROUTE_POINTS} points`);
      points.forEach((point, index) => {
        const what = `Route point ${index + 1}`;
        if (!isRecord(point)) { problems.push(`${what} is not an object`); return; }
        problems.push(...unexpected(point, Object.keys(ROUTE_POINT_LIMITS), what), ...numbers(point, ROUTE_POINT_LIMITS, what));
      });
    }
  } else if (route !== null) problems.push('Only a route task has a route');
  const initial = value.initial;
  if (!isRecord(initial)) problems.push('The task has no initial conditions');
  else {
    problems.push(...unexpected(initial, ['ground', 'air'], 'The initial conditions'));
    if (!isRecord(initial.ground)) problems.push('The initial conditions have no ground values');
    else problems.push(...unexpected(initial.ground, Object.keys(GROUND_LIMITS), 'The ground start'), ...numbers(initial.ground, GROUND_LIMITS, 'The ground start'));
    if (initial.air !== null) {
      if (!isRecord(initial.air)) problems.push('The airborne start is not an object');
      else problems.push(...unexpected(initial.air, Object.keys(AIR_LIMITS), 'The airborne start'), ...numbers(initial.air, AIR_LIMITS, 'The airborne start'));
    }
    if (type === 'route' && initial.air !== null) problems.push('A route starts from the ground: its first point is where the lead-in would go');
  }
  return problems;
}

/** A value as task definition v1, frozen; refuses anything else with every reason. */
export function parseFlightTask(value: unknown): FlightTaskDefinition {
  const problems = flightTaskProblems(value);
  if (problems.length > 0) throw new Error(problems.join('; '));
  // flightTaskProblems checked every field of this shape.
  const task = structuredClone(value) as FlightTaskDefinition;
  return Object.freeze({
    ...task, parameters: Object.freeze({ ...task.parameters }), route: task.route ? Object.freeze(task.route.map(point => Object.freeze({ ...point }))) : null,
    initial: Object.freeze({ ground: Object.freeze({ ...task.initial.ground }), air: task.initial.air ? Object.freeze({ ...task.initial.air }) : null }),
  });
}

/** A value as ground start values, frozen; refuses anything else with every reason (the physics Worker's admission). */
export function parseGroundStart(value: unknown): GroundStart {
  if (!isRecord(value)) throw new Error('The ground start is not an object');
  const problems = [...unexpected(value, Object.keys(GROUND_LIMITS), 'The ground start'), ...numbers(value, GROUND_LIMITS, 'The ground start')];
  if (problems.length > 0) throw new Error(problems.join('; '));
  // numbers() checked every field of this shape.
  return Object.freeze({ ...value }) as unknown as GroundStart;
}

/** What every new task starts from: on the pad, facing north, with a full battery. */
export const DEFAULT_GROUND_START: GroundStart = Object.freeze({ northM: 0, eastM: 0, headingDeg: 0, stateOfCharge: 1 });

// ---- the stages ------------------------------------------------------------------------------------------------------------------------

/** How a lead-in reaches its speed; the task's own rates apply only to the task. */
export const LEAD_IN_ACCELERATION_MPS2 = 2;
/** How a lead-in turns to its heading, and a move from an airborne start changes height. */
export const LEAD_IN_TURN_RATE_DEG_S = 30;
export const LEAD_IN_CLIMB_RATE_MPS = 1;
/**
 * A stage's end state must hold within its tolerance this long, simulated time: the next stage starts settled,
 * and a measured stage's trace shows any overshoot instead of ending on the moment it first arrived.
 */
export const SETTLE_S = 2;
/** Operational completion tolerances, declared before the first flight (TASK-172 status). */
export const COMPLETION = { altitudeM: 0.5, verticalSpeedMps: 0.3, headingDeg: 5, speedMps: 0.5 } as const;
/**
 * A guided target is sent at most this often, simulated time, so every observation sends one: the Run tab observes on
 * the session's status, every 80 physics steps (0.1 s at 800 Hz). ArduCopter's GUID_TIMEOUT is 3 s.
 */
export const TARGET_PERIOD_S = 0.05;
/** A mode or arming request repeats this often until the autopilot reports it. */
const REQUEST_PERIOD_S = 1;
/** Time a stage may take beyond its plan before the run fails it, s of simulated time. */
const STAGE_MARGIN_S = 60;

/** What ArduPilot allows itself, as its parameters say; a target within these needs no correction to be followed. */
export interface GuidanceLimits {
  /** WP_ACC_Z: how hard guided flight accelerates up or down. */
  readonly verticalAccelerationMps2: number;
  /** PSC_D_JERK: how fast that acceleration may change. */
  readonly verticalJerkMps3: number;
  /** PSC_NE_JERK: how fast horizontal acceleration may change. */
  readonly horizontalJerkMps3: number;
  /** ATC_ACC_Y_MAX: how fast the turn rate may change; ArduPilot's 0 means no limit, here Infinity. */
  readonly yawAccelerationDegS2: number;
}
/** The parameters GuidanceLimits come from, at the pinned ArduPilot commit. */
export const GUIDANCE_PARAMETERS = ['WP_ACC_Z', 'PSC_D_JERK', 'PSC_NE_JERK', 'ATC_ACC_Y_MAX'] as const;
/** The limits from the autopilot's reported parameters; throws naming what is missing or not usable. */
export function guidanceLimitsOf(reported: (name: string) => number | undefined): GuidanceLimits {
  const read = (name: typeof GUIDANCE_PARAMETERS[number], zeroAllowed: boolean): number => {
    const value = reported(name);
    if (value === undefined) throw new Error(`ArduPilot does not report ${name}, which shapes the task's smooth starts and stops`);
    if (!Number.isFinite(value) || value < 0 || (value === 0 && !zeroAllowed)) throw new Error(`ArduPilot reports ${name} as ${String(value)}, which cannot shape a flight task`);
    return value;
  };
  const yaw = read('ATC_ACC_Y_MAX', true);
  return {
    verticalAccelerationMps2: read('WP_ACC_Z', false), verticalJerkMps3: read('PSC_D_JERK', false), horizontalJerkMps3: read('PSC_NE_JERK', false),
    yawAccelerationDegS2: yaw === 0 ? Number.POSITIVE_INFINITY : yaw,
  };
}

export type FlightTaskStage =
  | { readonly kind: 'upload' }
  | { readonly kind: 'arm' }
  | { readonly kind: 'takeoff'; readonly altitudeM: number }
  | { readonly kind: 'heading'; readonly altitudeM: number; readonly headingDeg: number }
  | { readonly kind: 'speed'; readonly altitudeM: number; readonly headingDeg: number; readonly fromSpeedMps: number; readonly toSpeedMps: number; readonly rateMps2: number }
  | { readonly kind: 'hold'; readonly altitudeM: number; readonly durationS: number }
  | { readonly kind: 'vertical'; readonly fromAltitudeM: number; readonly toAltitudeM: number; readonly rateMps: number }
  | { readonly kind: 'cruise'; readonly altitudeM: number; readonly headingDeg: number; readonly speedMps: number; readonly distanceM: number }
  | { readonly kind: 'turn'; readonly altitudeM: number; readonly headingDeg: number; readonly speedMps: number; readonly angleDeg: number; readonly rateDegS: number }
  | { readonly kind: 'mission'; readonly points: readonly RoutePoint[] }
  /** A heading of null holds the one it arrived on. */
  | { readonly kind: 'maneuver'; readonly axis: ManeuverAxis; readonly altitudeM: number; readonly headingDeg: number | null; readonly timeline: ManeuverTimeline }
  /** After a roll or pitch maneuver: stop smoothly from whatever speed and direction it ended with, and hold. */
  | { readonly kind: 'recover'; readonly altitudeM: number; readonly headingDeg: number }
  | { readonly kind: 'land' };
export type FlightTaskStageKind = FlightTaskStage['kind'];
export interface PlannedStage {
  readonly stage: FlightTaskStage;
  /** Part of the task itself, on its clock; false for the lead-in, and for the stop and landing after it. */
  readonly measured: boolean;
}

const number = (task: FlightTaskDefinition, key: string): number => {
  const value = task.parameters[key];
  if (value === undefined) throw new Error(`The ${task.type} task has no ${key}`);
  return value;
};

/** The state a task's own parameters start from. */
function impliedStart(task: FlightTaskDefinition): { altitudeM: number; headingDeg: number | null; speedMps: number } {
  switch (task.type) {
    case 'takeoff': case 'hover': case 'landing': return { altitudeM: number(task, 'altitudeM'), headingDeg: null, speedMps: 0 };
    case 'straight': case 'turn': return { altitudeM: number(task, 'altitudeM'), headingDeg: number(task, 'headingDeg'), speedMps: number(task, 'speedMps') };
    case 'climb': case 'descent': return { altitudeM: number(task, 'fromAltitudeM'), headingDeg: null, speedMps: 0 };
    case 'acceleration': case 'braking': return { altitudeM: number(task, 'altitudeM'), headingDeg: number(task, 'headingDeg'), speedMps: number(task, 'fromSpeedMps') };
    case 'route': {
      const first = task.route?.[0];
      if (!first) throw new Error('The route has no points');
      return { altitudeM: first.altitudeM, headingDeg: null, speedMps: 0 };
    }
    case 'roll-step': case 'roll-doublet': case 'pitch-step': case 'pitch-doublet': case 'heading-step': case 'heading-doublet':
      return { altitudeM: number(task, 'altitudeM'), headingDeg: number(task, 'headingDeg'), speedMps: 0 };
    case 'altitude-step': case 'altitude-doublet': return { altitudeM: number(task, 'altitudeM'), headingDeg: null, speedMps: 0 };
    default: { const never: never = task.type; throw new Error(`Unhandled task type ${String(never)}`); }
  }
}

/**
 * From an airborne start to the state the task's own parameters start from, on the task's clock: at rest for a change of
 * height or heading, since a target that changed them while moving would ask for a corner the aircraft cannot fly.
 */
function transition(from: AirStart, to: { readonly altitudeM: number; readonly headingDeg: number | null; readonly speedMps: number }): FlightTaskStage[] {
  const stages: FlightTaskStage[] = [];
  const headingDeg = to.headingDeg ?? from.headingDeg, turns = headingError(from.headingDeg, headingDeg) !== 0, climbs = to.altitudeM !== from.altitudeM;
  let speedMps = from.speedMps;
  if (speedMps > 0 && (turns || climbs)) {
    stages.push({ kind: 'speed', altitudeM: from.altitudeM, headingDeg: from.headingDeg, fromSpeedMps: speedMps, toSpeedMps: 0, rateMps2: LEAD_IN_ACCELERATION_MPS2 });
    speedMps = 0;
  }
  if (turns) stages.push({ kind: 'heading', altitudeM: from.altitudeM, headingDeg });
  if (climbs) stages.push({ kind: 'vertical', fromAltitudeM: from.altitudeM, toAltitudeM: to.altitudeM, rateMps: LEAD_IN_CLIMB_RATE_MPS });
  if (speedMps !== to.speedMps) stages.push({ kind: 'speed', altitudeM: to.altitudeM, headingDeg, fromSpeedMps: speedMps, toSpeedMps: to.speedMps, rateMps2: LEAD_IN_ACCELERATION_MPS2 });
  return stages;
}

/** The stages of a task in order: lead-in, the task itself, then the stop and landing it finishes with. */
export function planFlightTask(task: FlightTaskDefinition): readonly PlannedStage[] {
  const lead = (stage: FlightTaskStage): PlannedStage => ({ stage, measured: false }), own = (stage: FlightTaskStage): PlannedStage => ({ stage, measured: true });
  const start = impliedStart(task), air = task.initial.air;
  const altitudeM = air?.altitudeM ?? start.altitudeM, headingDeg = air?.headingDeg ?? start.headingDeg, speedMps = air?.speedMps ?? start.speedMps;
  const stages: PlannedStage[] = task.type === 'route' ? [lead({ kind: 'upload' })] : [];
  stages.push(lead({ kind: 'arm' }));
  // A take-off task with no airborne start is measured from its own climb; every other take-off is the lead-in.
  stages.push(task.type === 'takeoff' && !air ? own({ kind: 'takeoff', altitudeM }) : lead({ kind: 'takeoff', altitudeM }));
  if (headingDeg !== null) stages.push(lead({ kind: 'heading', altitudeM, headingDeg }));
  if (speedMps > 0 && headingDeg !== null) stages.push(lead({ kind: 'speed', altitudeM, headingDeg, fromSpeedMps: 0, toSpeedMps: speedMps, rateMps2: LEAD_IN_ACCELERATION_MPS2 }));
  let stopFrom: { altitudeM: number; headingDeg: number; speedMps: number } | null = null;
  // An airborne take-off task climbs on its clock from where it stopped; every other task first flies to where it starts.
  if (air) stages.push(...transition(air, task.type === 'takeoff' ? { altitudeM: air.altitudeM, headingDeg: null, speedMps: 0 } : start).map(own));
  switch (task.type) {
    case 'takeoff': if (air) stages.push(own({ kind: 'vertical', fromAltitudeM: air.altitudeM, toAltitudeM: number(task, 'altitudeM'), rateMps: LEAD_IN_CLIMB_RATE_MPS })); break;
    case 'hover': stages.push(own({ kind: 'hold', altitudeM: number(task, 'altitudeM'), durationS: number(task, 'durationS') })); break;
    case 'landing': break;
    case 'straight': {
      const stage = { altitudeM: number(task, 'altitudeM'), headingDeg: number(task, 'headingDeg'), speedMps: number(task, 'speedMps') };
      stages.push(own({ kind: 'cruise', ...stage, distanceM: number(task, 'distanceM') }));
      stopFrom = stage;
      break;
    }
    case 'climb': case 'descent':
      stages.push(own({ kind: 'vertical', fromAltitudeM: number(task, 'fromAltitudeM'), toAltitudeM: number(task, 'toAltitudeM'), rateMps: number(task, 'rateMps') }));
      break;
    case 'acceleration': case 'braking': {
      const stage = { altitudeM: number(task, 'altitudeM'), headingDeg: number(task, 'headingDeg') }, toSpeedMps = number(task, 'toSpeedMps');
      stages.push(own({ kind: 'speed', ...stage, fromSpeedMps: number(task, 'fromSpeedMps'), toSpeedMps, rateMps2: number(task, 'rateMps2') }));
      if (toSpeedMps > 0) stopFrom = { ...stage, speedMps: toSpeedMps };
      break;
    }
    case 'turn': {
      const stage = { altitudeM: number(task, 'altitudeM'), headingDeg: number(task, 'headingDeg'), speedMps: number(task, 'speedMps') }, angleDeg = number(task, 'angleDeg');
      stages.push(own({ kind: 'turn', ...stage, angleDeg, rateDegS: number(task, 'rateDegS') }));
      stopFrom = { ...stage, headingDeg: wrapDeg(stage.headingDeg + angleDeg) };
      break;
    }
    case 'route': stages.push(own({ kind: 'mission', points: task.route ?? [] })); break;
    case 'roll-step': case 'roll-doublet': case 'pitch-step': case 'pitch-doublet': case 'heading-step': case 'heading-doublet': case 'altitude-step': case 'altitude-doublet': {
      const { axis, shape } = MANEUVER_TYPES[task.type], stageAltitudeM = number(task, 'altitudeM');
      const amplitude = axis === 'altitude' ? number(task, 'amplitudeM') : number(task, 'amplitudeDeg');
      const stageHeadingDeg = axis === 'altitude' ? null : number(task, 'headingDeg');
      stages.push(own({ kind: 'maneuver', axis, altitudeM: stageAltitudeM, headingDeg: stageHeadingDeg, timeline: maneuverTimeline(axis, shape, amplitude, number(task, 'holdS')) }));
      if (stageHeadingDeg !== null && (axis === 'roll' || axis === 'pitch')) stages.push(lead({ kind: 'recover', altitudeM: stageAltitudeM, headingDeg: stageHeadingDeg }));
      break;
    }
    default: { const never: never = task.type; throw new Error(`Unhandled task type ${String(never)}`); }
  }
  // A task that ends moving stops before it lands or holds.
  if (stopFrom) {
    stages.push(lead({ kind: 'speed', altitudeM: stopFrom.altitudeM, headingDeg: stopFrom.headingDeg, fromSpeedMps: stopFrom.speedMps, toSpeedMps: 0, rateMps2: LEAD_IN_ACCELERATION_MPS2 }));
  }
  if (task.finish === 'land') stages.push(task.type === 'landing' ? own({ kind: 'land' }) : lead({ kind: 'land' }));
  return stages;
}

// ---- the runner ------------------------------------------------------------------------------------------------------------------------

export type AutopilotModeName = 'guided' | 'auto' | 'land' | 'other';
export type MissionUploadState = 'idle' | 'uploading' | 'accepted' | 'failed';
/** One observation of the run: the session's truth and the autopilot's own reports. */
export interface FlightTaskObservation {
  readonly simTimeS: number;
  readonly northM: number; readonly eastM: number; readonly altitudeM: number;
  readonly northMps: number; readonly eastMps: number; readonly downMps: number;
  readonly headingDeg: number;
  readonly rollDeg: number; readonly pitchDeg: number;
  readonly armed: boolean;
  readonly mode: AutopilotModeName;
  readonly mission: MissionUploadState;
  /** The newest route point ArduPilot reported reached, from 0; -1 before the first. */
  readonly routePointReached: number;
}
/** A position target in ArduPilot's own frame, from where it started, with its velocity and acceleration at that moment. */
export interface GuidedTarget {
  readonly northM: number; readonly eastM: number; readonly downM: number;
  readonly northMps: number; readonly eastMps: number; readonly downMps: number;
  readonly northMps2: number; readonly eastMps2: number; readonly downMps2: number;
  readonly yawRad: number; readonly yawRateRadS: number;
}
/** An attitude to hold, with the height held where it is. */
export interface AttitudeTarget { readonly rollRad: number; readonly pitchRad: number; readonly yawRad: number }
export type FlightTaskCommand =
  | { readonly kind: 'set-mode'; readonly mode: 'guided' | 'auto' | 'land' }
  | { readonly kind: 'arm' }
  /** NAV_TAKEOFF to this height above where it armed. */
  | { readonly kind: 'takeoff'; readonly heightM: number }
  | { readonly kind: 'target'; readonly target: GuidedTarget }
  | { readonly kind: 'attitude'; readonly target: AttitudeTarget }
  /** Heights above where it will arm; north and east from the pad. */
  | { readonly kind: 'upload-route'; readonly points: readonly RoutePoint[]; readonly groundAltitudeM: number };
/** What is requested at this moment, beside which the actual values are shown; null where the stage requests nothing of it. */
export interface FlightTaskRequest {
  readonly northM: number | null; readonly eastM: number | null; readonly altitudeM: number | null;
  readonly speedMps: number | null; readonly headingDeg: number | null; readonly verticalSpeedMps: number | null;
  readonly rollDeg: number | null; readonly pitchDeg: number | null;
}
const NO_REQUEST: FlightTaskRequest = Object.freeze({ northM: null, eastM: null, altitudeM: null, speedMps: null, headingDeg: null, verticalSpeedMps: null, rollDeg: null, pitchDeg: null });
/** The actual state where the task's clock started, against what was requested there. */
export interface FlightTaskArrival { readonly simTimeS: number; readonly requested: FlightTaskRequest; readonly actual: FlightTaskRequest }
export type FlightTaskProgress =
  | { readonly state: 'running' }
  | { readonly state: 'done' }
  | { readonly state: 'failed'; readonly reason: string };
export interface FlightTaskStep {
  readonly progress: FlightTaskProgress;
  readonly stageIndex: number;
  readonly stage: FlightTaskStageKind;
  readonly measured: boolean;
  /** Simulated seconds since the task's clock started; null before it. */
  readonly taskTimeS: number | null;
  readonly requested: FlightTaskRequest;
  readonly actual: FlightTaskRequest;
  readonly arrival: FlightTaskArrival | null;
  readonly commands: readonly FlightTaskCommand[];
}

const DEG = Math.PI / 180;
/** A heading in [0, 360). */
export function wrapDeg(deg: number): number { return ((deg % 360) + 360) % 360; }
/** The shortest signed turn from one heading to another, degrees. */
function headingError(fromDeg: number, toDeg: number): number { return ((toDeg - fromDeg + 540) % 360) - 180; }

function plannedDurationS(stage: FlightTaskStage, motionS: number, fromNorthM: number, fromEastM: number): number {
  switch (stage.kind) {
    case 'upload': case 'arm': return 30;
    case 'takeoff': return stage.altitudeM;
    case 'heading': case 'speed': case 'vertical': case 'turn': return motionS;
    case 'hold': return stage.durationS;
    case 'maneuver': return stage.timeline.lengthS;
    case 'recover': return motionS;
    case 'cruise': return stage.distanceM / stage.speedMps;
    case 'mission': {
      let distanceS = 0;
      stage.points.forEach((point, i) => {
        const previous = stage.points[i - 1];
        if (previous) distanceS += Math.hypot(point.northM - previous.northM, point.eastM - previous.eastM, point.altitudeM - previous.altitudeM) / point.speedMps;
      });
      // From where it took off to the first point, at the first point's speed.
      const first = stage.points[0];
      return distanceS + (first ? Math.hypot(first.northM - fromNorthM, first.eastM - fromEastM) / first.speedMps : 0);
    }
    case 'land': return 120;
    default: { const never: never = stage; throw new Error(`Unhandled stage ${String(never)}`); }
  }
}

/** Flies one task: call `observe` as the run's truth updates, send the commands it returns, and stop at `done` or `failed`. */
export class FlightTaskRunner {
  readonly stages: readonly PlannedStage[];
  private index = 0;
  /** When the current stage's first observation came; null until it does. */
  private stageStartS: number | null = null;
  private lastRequestS = Number.NEGATIVE_INFINITY;
  private lastTargetS = Number.NEGATIVE_INFINITY;
  private wasArmed = false;
  private taskStartS: number | null = null;
  private arrival: FlightTaskArrival | null = null;
  private failure: string | null = null;
  private finished = false;
  /** Where ArduPilot's own frame starts, and the CG's height at rest; taken before arming. */
  private originNorthM = 0;
  private originEastM = 0;
  private groundAltitudeM = 0;
  private originTaken = false;
  /** The moving target, in the session's frame. */
  private targetNorthM = 0;
  private targetEastM = 0;
  private holdHeadingDeg = 0;
  private uploadSent = false;
  private settledSinceS: number | null = null;
  /** When the last stage ended: the next one starts there, so a moving target does not stall between stages. */
  private lastStageEndS: number | null = null;
  /** The current stage's motion and what it starts from, set when the stage starts. */
  private motion: MotionProfile | null = null;
  private fromNorthM = 0;
  private fromEastM = 0;
  private fromHeadingDeg = 0;
  private turnSign = 0;
  /** A curve's target position is the sum of its velocity over the observations. */
  private curveElapsedS = 0;
  private curveNorthMps = 0;
  private curveEastMps = 0;
  /** The direction a recover stage stops along. */
  private courseNorth = 1;
  private courseEast = 0;

  constructor(readonly task: FlightTaskDefinition, private readonly limits: GuidanceLimits) { this.stages = planFlightTask(task); }

  private get planned(): PlannedStage {
    const planned = this.stages[this.index];
    if (!planned) throw new Error('The task has no stage left');
    return planned;
  }

  observe(o: FlightTaskObservation): FlightTaskStep {
    if (!this.originTaken) {
      this.originTaken = true;
      this.originNorthM = o.northM; this.originEastM = o.eastM; this.groundAltitudeM = o.altitudeM;
      this.targetNorthM = o.northM; this.targetEastM = o.eastM;
      this.holdHeadingDeg = o.headingDeg;
    }
    const commands: FlightTaskCommand[] = [];
    let requested = NO_REQUEST;
    // The report names the stage that produced the request; a stage ending here gives way on the next observation.
    const stageIndex = Math.min(this.index, this.stages.length - 1);
    if (!this.finished && this.failure === null) requested = this.step(o, commands);
    return this.report(o, stageIndex, requested, commands);
  }

  private report(o: FlightTaskObservation, stageIndex: number, requested: FlightTaskRequest, commands: readonly FlightTaskCommand[]): FlightTaskStep {
    const planned = this.stages[stageIndex];
    const progress: FlightTaskProgress = this.failure !== null ? { state: 'failed', reason: this.failure } : this.finished ? { state: 'done' } : { state: 'running' };
    return {
      progress, stageIndex, stage: planned?.stage.kind ?? 'land', measured: planned?.measured ?? false,
      taskTimeS: this.taskStartS === null ? null : o.simTimeS - this.taskStartS, requested, actual: actualOf(o), arrival: this.arrival, commands,
    };
  }

  private fail(reason: string): void { this.failure = reason; }
  private next(o: FlightTaskObservation): void {
    this.index++;
    this.stageStartS = null;
    this.lastStageEndS = o.simTimeS;
    this.lastRequestS = Number.NEGATIVE_INFINITY;
    this.lastTargetS = Number.NEGATIVE_INFINITY;
    this.holdHeadingDeg = o.headingDeg;
    this.settledSinceS = null;
    this.motion = null;
    if (this.index >= this.stages.length) this.finished = true;
  }
  /** True once `within` has held for SETTLE_S of simulated time without a break. */
  private settled(o: FlightTaskObservation, within: boolean): boolean {
    this.settledSinceS = within ? this.settledSinceS ?? o.simTimeS : null;
    return this.settledSinceS !== null && o.simTimeS - this.settledSinceS >= SETTLE_S;
  }
  /** Sets up the stage's motion on its first observation, from where the target is. */
  private beginStage(stage: FlightTaskStage, o: FlightTaskObservation): MotionProfile {
    this.fromNorthM = this.targetNorthM;
    this.fromEastM = this.targetEastM;
    const { limits } = this;
    switch (stage.kind) {
      case 'heading': {
        const turnDeg = headingError(o.headingDeg, stage.headingDeg);
        this.fromHeadingDeg = o.headingDeg;
        this.turnSign = Math.sign(turnDeg);
        return restToRest(Math.abs(turnDeg), LEAD_IN_TURN_RATE_DEG_S, limits.yawAccelerationDegS2, Number.POSITIVE_INFINITY);
      }
      case 'speed': return speedChange(stage.fromSpeedMps, stage.toSpeedMps, stage.rateMps2, limits.horizontalJerkMps3);
      case 'vertical': return restToRest(Math.abs(stage.toAltitudeM - stage.fromAltitudeM), stage.rateMps, limits.verticalAccelerationMps2, limits.verticalJerkMps3);
      case 'turn': {
        this.fromHeadingDeg = stage.headingDeg;
        this.turnSign = Math.sign(stage.angleDeg);
        this.curveElapsedS = 0;
        this.curveNorthMps = stage.speedMps * Math.cos(stage.headingDeg * DEG);
        this.curveEastMps = stage.speedMps * Math.sin(stage.headingDeg * DEG);
        // The curve's sideways acceleration is speed times turn rate, so the turn rate changes within the horizontal jerk limit too.
        const curveDegS2 = limits.horizontalJerkMps3 / stage.speedMps / DEG;
        return restToRest(Math.abs(stage.angleDeg), stage.rateDegS, Math.min(limits.yawAccelerationDegS2, curveDegS2), Number.POSITIVE_INFINITY);
      }
      case 'recover': {
        // From where it is and how it moves: a maneuver in attitude asks for neither.
        const speedMps = Math.hypot(o.northMps, o.eastMps);
        this.fromNorthM = this.targetNorthM = o.northM;
        this.fromEastM = this.targetEastM = o.eastM;
        this.courseNorth = speedMps > 0 ? o.northMps / speedMps : 1;
        this.courseEast = speedMps > 0 ? o.eastMps / speedMps : 0;
        return speedChange(speedMps, 0, LEAD_IN_ACCELERATION_MPS2, limits.horizontalJerkMps3);
      }
      default: return restToRest(0, 1, 1, 1);
    }
  }
  private request(o: FlightTaskObservation, commands: FlightTaskCommand[], command: FlightTaskCommand): void {
    if (o.simTimeS - this.lastRequestS < REQUEST_PERIOD_S) return;
    this.lastRequestS = o.simTimeS;
    commands.push(command);
  }

  private step(o: FlightTaskObservation, commands: FlightTaskCommand[]): FlightTaskRequest {
    const { stage, measured } = this.planned;
    // From where the last stage ended, so a moving target does not stall between stages; a maneuver starts at rest, on its own first
    // observation, so its first request is its time zero and each change comes at the time its timeline says.
    this.stageStartS ??= stage.kind === 'maneuver' ? o.simTimeS : this.lastStageEndS ?? o.simTimeS;
    const motion = this.motion ??= this.beginStage(stage, o);
    const elapsed = o.simTimeS - this.stageStartS;
    const allowedS = plannedDurationS(stage, motion.durationS, this.originNorthM, this.originEastM) + STAGE_MARGIN_S;
    if (elapsed > allowedS) {
      this.fail(`The ${stage.kind} stage did not finish within ${allowedS.toFixed(0)} s of simulated time`);
      return NO_REQUEST;
    }
    // Once armed, the autopilot leaving the flight is the end of the task, whatever the reason.
    if (this.wasArmed && !o.armed && stage.kind !== 'land') { this.fail(`The autopilot disarmed during the ${stage.kind} stage`); return NO_REQUEST; }
    this.wasArmed ||= o.armed;
    const inFlightMode = stage.kind === 'mission' ? o.mode === 'auto' || o.mode === 'guided' : stage.kind === 'land' ? true : o.mode === 'guided';
    if (this.wasArmed && !inFlightMode) { this.fail(`The autopilot left its flight mode during the ${stage.kind} stage`); return NO_REQUEST; }
    if (measured && this.taskStartS === null) this.startClock(o, stage);
    switch (stage.kind) {
      case 'upload':
        if (!this.uploadSent) {
          this.uploadSent = true;
          commands.push({ kind: 'upload-route', points: this.routeOf(), groundAltitudeM: this.groundAltitudeM });
        }
        if (o.mission === 'failed') this.fail('ArduPilot refused the route');
        else if (o.mission === 'accepted') this.next(o);
        return NO_REQUEST;
      case 'arm':
        if (o.armed) { this.targetNorthM = o.northM; this.targetEastM = o.eastM; this.next(o); return NO_REQUEST; }
        if (o.mode !== 'guided') this.request(o, commands, { kind: 'set-mode', mode: 'guided' });
        else this.request(o, commands, { kind: 'arm' });
        return NO_REQUEST;
      case 'takeoff': {
        // NAV_TAKEOFF once; ArduPilot acknowledges with its climb, and the request repeats until it climbs.
        if (o.altitudeM - this.groundAltitudeM < 0.2) this.request(o, commands, { kind: 'takeoff', heightM: stage.altitudeM - this.groundAltitudeM });
        if (this.settled(o, Math.abs(o.altitudeM - stage.altitudeM) < COMPLETION.altitudeM && Math.abs(o.downMps) < COMPLETION.verticalSpeedMps)) this.next(o);
        return { ...NO_REQUEST, northM: this.targetNorthM, eastM: this.targetEastM, altitudeM: stage.altitudeM };
      }
      case 'heading': {
        const turn = motion.sample(elapsed), headingDeg = wrapDeg(this.fromHeadingDeg + this.turnSign * turn.distance);
        this.sendTarget(o, commands, stage.altitudeM, 0, 0, 0, 0, 0, 0, headingDeg, this.turnSign * turn.speed * DEG);
        if (elapsed >= motion.durationS && Math.abs(headingError(o.headingDeg, stage.headingDeg)) < COMPLETION.headingDeg) this.next(o);
        return { ...NO_REQUEST, northM: this.targetNorthM, eastM: this.targetEastM, altitudeM: stage.altitudeM, speedMps: 0, headingDeg };
      }
      case 'speed': {
        const now = motion.sample(elapsed), north = Math.cos(stage.headingDeg * DEG), east = Math.sin(stage.headingDeg * DEG);
        this.targetNorthM = this.fromNorthM + now.distance * north;
        this.targetEastM = this.fromEastM + now.distance * east;
        this.sendTarget(o, commands, stage.altitudeM, now.speed * north, now.speed * east, 0, now.acceleration * north, now.acceleration * east, 0, stage.headingDeg, 0);
        if (this.settled(o, elapsed >= motion.durationS && Math.abs(Math.hypot(o.northMps, o.eastMps) - stage.toSpeedMps) < COMPLETION.speedMps)) this.next(o);
        return { ...NO_REQUEST, northM: this.targetNorthM, eastM: this.targetEastM, altitudeM: stage.altitudeM, speedMps: now.speed, headingDeg: stage.headingDeg, verticalSpeedMps: 0 };
      }
      case 'hold': {
        this.sendTarget(o, commands, stage.altitudeM, 0, 0, 0, 0, 0, 0, this.holdHeadingDeg, 0);
        if (elapsed >= stage.durationS) this.next(o);
        return { ...NO_REQUEST, northM: this.targetNorthM, eastM: this.targetEastM, altitudeM: stage.altitudeM, speedMps: 0, headingDeg: this.holdHeadingDeg, verticalSpeedMps: 0 };
      }
      case 'vertical': {
        const now = motion.sample(elapsed), sign = Math.sign(stage.toAltitudeM - stage.fromAltitudeM);
        const altitudeM = stage.fromAltitudeM + sign * now.distance, upMps = now.speed === 0 ? 0 : sign * now.speed;
        this.sendTarget(o, commands, altitudeM, 0, 0, -upMps, 0, 0, -sign * now.acceleration, this.holdHeadingDeg, 0);
        if (this.settled(o, elapsed >= motion.durationS && Math.abs(o.altitudeM - stage.toAltitudeM) < COMPLETION.altitudeM && Math.abs(o.downMps) < COMPLETION.verticalSpeedMps)) this.next(o);
        return { ...NO_REQUEST, northM: this.targetNorthM, eastM: this.targetEastM, altitudeM, speedMps: 0, headingDeg: this.holdHeadingDeg, verticalSpeedMps: upMps };
      }
      case 'cruise': {
        const flownM = stage.speedMps * elapsed, north = Math.cos(stage.headingDeg * DEG), east = Math.sin(stage.headingDeg * DEG);
        this.targetNorthM = this.fromNorthM + flownM * north;
        this.targetEastM = this.fromEastM + flownM * east;
        this.sendTarget(o, commands, stage.altitudeM, stage.speedMps * north, stage.speedMps * east, 0, 0, 0, 0, stage.headingDeg, 0);
        if (flownM >= stage.distanceM) this.next(o);
        return { ...NO_REQUEST, northM: this.targetNorthM, eastM: this.targetEastM, altitudeM: stage.altitudeM, speedMps: stage.speedMps, headingDeg: stage.headingDeg, verticalSpeedMps: 0 };
      }
      case 'turn': {
        const now = motion.sample(elapsed), headingDeg = wrapDeg(this.fromHeadingDeg + this.turnSign * now.distance), rateRadS = this.turnSign * now.speed * DEG;
        const northMps = stage.speedMps * Math.cos(headingDeg * DEG), eastMps = stage.speedMps * Math.sin(headingDeg * DEG), stepS = elapsed - this.curveElapsedS;
        this.targetNorthM += (this.curveNorthMps + northMps) / 2 * stepS;
        this.targetEastM += (this.curveEastMps + eastMps) / 2 * stepS;
        this.curveElapsedS = elapsed;
        this.curveNorthMps = northMps;
        this.curveEastMps = eastMps;
        // Holding a speed along a curve takes a sideways acceleration of speed times turn rate.
        this.sendTarget(o, commands, stage.altitudeM, northMps, eastMps, 0, -eastMps * rateRadS, northMps * rateRadS, 0, headingDeg, rateRadS);
        const finalDeg = wrapDeg(stage.headingDeg + stage.angleDeg);
        if (this.settled(o, elapsed >= motion.durationS && Math.abs(headingError(o.headingDeg, finalDeg)) < COMPLETION.headingDeg)) this.next(o);
        return { ...NO_REQUEST, northM: this.targetNorthM, eastM: this.targetEastM, altitudeM: stage.altitudeM, speedMps: stage.speedMps, headingDeg, verticalSpeedMps: 0 };
      }
      case 'maneuver': {
        const offset = offsetAt(stage.timeline, elapsed), headingDeg = stage.headingDeg ?? this.holdHeadingDeg, done = elapsed >= stage.timeline.lengthS;
        const atRest = { northM: this.targetNorthM, eastM: this.targetEastM, speedMps: 0 };
        switch (stage.axis) {
          case 'roll': case 'pitch': {
            const rollDeg = stage.axis === 'roll' ? offset : 0, pitchDeg = stage.axis === 'pitch' ? offset : 0;
            this.sendAttitude(o, commands, rollDeg, pitchDeg, headingDeg);
            if (done) this.next(o);
            return { ...NO_REQUEST, headingDeg, verticalSpeedMps: 0, rollDeg, pitchDeg };
          }
          case 'heading': {
            const requestedDeg = wrapDeg(headingDeg + offset);
            this.sendTarget(o, commands, stage.altitudeM, 0, 0, 0, 0, 0, 0, requestedDeg, 0);
            if (done) this.next(o);
            return { ...NO_REQUEST, ...atRest, altitudeM: stage.altitudeM, headingDeg: requestedDeg, verticalSpeedMps: 0 };
          }
          case 'altitude': {
            const altitudeM = stage.altitudeM + offset;
            this.sendTarget(o, commands, altitudeM, 0, 0, 0, 0, 0, 0, headingDeg, 0);
            if (done) this.next(o);
            return { ...NO_REQUEST, ...atRest, altitudeM, headingDeg };
          }
          default: { const never: never = stage.axis; throw new Error(`Unhandled maneuver axis ${String(never)}`); }
        }
      }
      case 'recover': {
        const now = motion.sample(elapsed);
        this.targetNorthM = this.fromNorthM + now.distance * this.courseNorth;
        this.targetEastM = this.fromEastM + now.distance * this.courseEast;
        this.sendTarget(o, commands, stage.altitudeM, now.speed * this.courseNorth, now.speed * this.courseEast, 0, now.acceleration * this.courseNorth, now.acceleration * this.courseEast, 0, stage.headingDeg, 0);
        if (this.settled(o, elapsed >= motion.durationS && Math.hypot(o.northMps, o.eastMps) < COMPLETION.speedMps)) this.next(o);
        return { ...NO_REQUEST, northM: this.targetNorthM, eastM: this.targetEastM, altitudeM: stage.altitudeM, speedMps: now.speed, headingDeg: stage.headingDeg, verticalSpeedMps: 0 };
      }
      case 'mission': {
        if (o.mode !== 'auto' && o.routePointReached < stage.points.length - 1) this.request(o, commands, { kind: 'set-mode', mode: 'auto' });
        const point = stage.points[Math.min(o.routePointReached + 1, stage.points.length - 1)];
        if (o.routePointReached >= stage.points.length - 1) {
          // Hold where the route ended, for the landing or the user.
          this.targetNorthM = o.northM; this.targetEastM = o.eastM;
          this.next(o);
        }
        return point ? { ...NO_REQUEST, northM: point.northM, eastM: point.eastM, altitudeM: point.altitudeM, speedMps: point.speedMps } : NO_REQUEST;
      }
      case 'land':
        if (!o.armed) { this.next(o); return NO_REQUEST; }
        if (o.mode !== 'land') this.request(o, commands, { kind: 'set-mode', mode: 'land' });
        return { ...NO_REQUEST, northM: o.northM, eastM: o.eastM, altitudeM: this.groundAltitudeM };
      default: { const never: never = stage; throw new Error(`Unhandled stage ${String(never)}`); }
    }
  }

  private routeOf(): readonly RoutePoint[] {
    const mission = this.stages.find(item => item.stage.kind === 'mission')?.stage;
    return mission?.kind === 'mission' ? mission.points : [];
  }
  private startClock(o: FlightTaskObservation, stage: FlightTaskStage): void {
    this.taskStartS = this.stageStartS ?? o.simTimeS;
    // An arrival is what the lead-in reached. A task measured from the ground starts from there.
    const air = this.task.initial.air, start = impliedStart(this.task);
    const requested: FlightTaskRequest = stage.kind === 'takeoff' ? { ...NO_REQUEST, altitudeM: this.groundAltitudeM, speedMps: 0 }
      : { ...NO_REQUEST, altitudeM: air?.altitudeM ?? start.altitudeM, speedMps: air?.speedMps ?? start.speedMps, headingDeg: air?.headingDeg ?? start.headingDeg };
    this.arrival = { simTimeS: o.simTimeS, requested, actual: actualOf(o) };
  }
  private sendAttitude(o: FlightTaskObservation, commands: FlightTaskCommand[], rollDeg: number, pitchDeg: number, headingDeg: number): void {
    if (o.simTimeS - this.lastTargetS < TARGET_PERIOD_S) return;
    this.lastTargetS = o.simTimeS;
    commands.push({ kind: 'attitude', target: { rollRad: rollDeg * DEG, pitchRad: pitchDeg * DEG, yawRad: wrapDeg(headingDeg) * DEG } });
  }
  private sendTarget(o: FlightTaskObservation, commands: FlightTaskCommand[], altitudeM: number, northMps: number, eastMps: number, downMps: number,
    northMps2: number, eastMps2: number, downMps2: number, headingDeg: number, yawRateRadS: number): void {
    if (o.simTimeS - this.lastTargetS < TARGET_PERIOD_S) return;
    this.lastTargetS = o.simTimeS;
    commands.push({ kind: 'target', target: {
      northM: this.targetNorthM - this.originNorthM, eastM: this.targetEastM - this.originEastM, downM: -(altitudeM - this.groundAltitudeM),
      northMps, eastMps, downMps, northMps2, eastMps2, downMps2, yawRad: wrapDeg(headingDeg) * DEG, yawRateRadS,
    } });
  }
}

function actualOf(o: FlightTaskObservation): FlightTaskRequest {
  return { northM: o.northM, eastM: o.eastM, altitudeM: o.altitudeM, speedMps: Math.hypot(o.northMps, o.eastMps), headingDeg: o.headingDeg, verticalSpeedMps: -o.downMps, rollDeg: o.rollDeg, pitchDeg: o.pitchDeg };
}
