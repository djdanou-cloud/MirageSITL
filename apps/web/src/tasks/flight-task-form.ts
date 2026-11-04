// The Flight tasks tab's form (TASK-172): a task definition v1 as the text the
// fields hold, and back. A definition that goes to text and back is the same
// definition, so a stored task reopens unchanged and saving it without an edit
// adds no version. Numbers stay as typed until the form is read; what is wrong
// with them is said in the words of the fields. Cold path, configuration time.
import type { ProjectStore } from "@mirage/project/store";
import type { StoredVersion } from "@mirage/project/schema";
import {
  DEFAULT_GROUND_START, FLIGHT_TASK_PARAMETERS, FLIGHT_TASK_SCHEMA_VERSION, flightTaskProblems, parseFlightTask, planFlightTask,
  type FlightTaskDefinition, type FlightTaskFinish, type FlightTaskStage, type FlightTaskType,
} from "@mirage/scenarios/flight-tasks";

export const TASK_TYPE_LABELS: Readonly<Record<FlightTaskType, string>> = {
  takeoff: "Takeoff", hover: "Hover", landing: "Landing", straight: "Straight flight", climb: "Climb", descent: "Descent",
  acceleration: "Acceleration", braking: "Braking", turn: "Turn", route: "Route",
};
export const PARAMETER_LABELS: Readonly<Record<string, string>> = {
  altitudeM: "Altitude (m)", durationS: "Duration (s)", headingDeg: "Heading (°)", speedMps: "Speed (m/s)", distanceM: "Distance (m)",
  fromAltitudeM: "From altitude (m)", toAltitudeM: "To altitude (m)", rateMps: "Vertical rate (m/s)", fromSpeedMps: "From speed (m/s)", toSpeedMps: "To speed (m/s)",
  rateMps2: "Speed change (m/s²)", angleDeg: "Turn angle (°, clockwise)", rateDegS: "Turn rate (°/s)",
};
/** A new task of each type starts from these; they are examples for the user to change, not recommendations. */
const EXAMPLE_PARAMETERS: Readonly<Record<FlightTaskType, Readonly<Record<string, number>>>> = {
  takeoff: { altitudeM: 5 }, hover: { altitudeM: 5, durationS: 10 }, landing: { altitudeM: 5 },
  straight: { altitudeM: 10, headingDeg: 0, speedMps: 5, distanceM: 50 },
  climb: { fromAltitudeM: 5, toAltitudeM: 15, rateMps: 1 }, descent: { fromAltitudeM: 15, toAltitudeM: 5, rateMps: 1 },
  acceleration: { altitudeM: 10, headingDeg: 0, fromSpeedMps: 2, toSpeedMps: 8, rateMps2: 1 }, braking: { altitudeM: 10, headingDeg: 0, fromSpeedMps: 8, toSpeedMps: 0, rateMps2: 1 },
  turn: { altitudeM: 10, headingDeg: 0, speedMps: 4, angleDeg: 90, rateDegS: 15 }, route: {},
};

export interface RouteRow { readonly northM: string; readonly eastM: string; readonly altitudeM: string; readonly speedMps: string }
export interface TaskForm {
  readonly type: FlightTaskType;
  readonly parameters: Readonly<Record<string, string>>;
  readonly route: readonly RouteRow[];
  readonly groundNorthM: string; readonly groundEastM: string; readonly groundHeadingDeg: string;
  /** Percent, as the field shows it. */
  readonly groundChargePercent: string;
  readonly airborne: boolean;
  readonly airAltitudeM: string; readonly airHeadingDeg: string; readonly airSpeedMps: string;
  readonly finish: FlightTaskFinish;
}

const textOf = (value: number): string => String(value);
/** A state of charge as percent, by moving the decimal point rather than multiplying: 0.333 reads 33.3, and 33.3 reads back 0.333, with no binary fraction between. */
const percentOf = (charge: number): string => String(Number(`${charge}e2`));
const chargeOf = (percent: string): number => (percent.trim() === "" ? Number.NaN : Number(`${percent.trim()}e-2`));
const numberOf = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text));

const EXAMPLE_ROUTE: readonly RouteRow[] = [
  { northM: "20", eastM: "0", altitudeM: "8", speedMps: "4" }, { northM: "20", eastM: "20", altitudeM: "8", speedMps: "4" },
];
export const emptyRouteRow = (): RouteRow => ({ northM: "", eastM: "", altitudeM: "", speedMps: "" });

export function parameterTexts(type: FlightTaskType): Record<string, string> {
  return Object.fromEntries(Object.entries(EXAMPLE_PARAMETERS[type]).map(([key, value]) => [key, textOf(value)]));
}
/** A new task of a type, on the pad with a full battery. */
export function newTaskForm(type: FlightTaskType = "hover"): TaskForm {
  const ground = DEFAULT_GROUND_START;
  return { type, parameters: parameterTexts(type), route: type === "route" ? EXAMPLE_ROUTE : [], groundNorthM: textOf(ground.northM), groundEastM: textOf(ground.eastM),
    groundHeadingDeg: textOf(ground.headingDeg), groundChargePercent: percentOf(ground.stateOfCharge), airborne: false, airAltitudeM: "10", airHeadingDeg: "0", airSpeedMps: "0",
    finish: "land" };
}
/** The form with another type: its parameters and route start over, and the initial conditions stay. */
export function withType(form: TaskForm, type: FlightTaskType): TaskForm {
  return { ...form, type, parameters: parameterTexts(type), route: type === "route" ? EXAMPLE_ROUTE : [], airborne: type === "route" ? false : form.airborne,
    finish: type === "landing" ? "land" : form.finish };
}
export function formOf(task: FlightTaskDefinition): TaskForm {
  const { ground, air } = task.initial;
  return {
    type: task.type, parameters: Object.fromEntries(Object.entries(task.parameters).map(([key, value]) => [key, textOf(value)])),
    route: (task.route ?? []).map(point => ({ northM: textOf(point.northM), eastM: textOf(point.eastM), altitudeM: textOf(point.altitudeM), speedMps: textOf(point.speedMps) })),
    groundNorthM: textOf(ground.northM), groundEastM: textOf(ground.eastM), groundHeadingDeg: textOf(ground.headingDeg), groundChargePercent: percentOf(ground.stateOfCharge),
    airborne: air !== null, airAltitudeM: textOf(air?.altitudeM ?? 10), airHeadingDeg: textOf(air?.headingDeg ?? 0), airSpeedMps: textOf(air?.speedMps ?? 0), finish: task.finish,
  };
}
/** The form as a definition candidate; flightTaskProblems decides whether it is one. */
function candidateOf(form: TaskForm): unknown {
  const limits: Readonly<Record<string, unknown>> = FLIGHT_TASK_PARAMETERS[form.type];
  return {
    schemaVersion: FLIGHT_TASK_SCHEMA_VERSION, type: form.type,
    parameters: Object.fromEntries(Object.keys(limits).map(key => [key, numberOf(form.parameters[key] ?? "")])),
    route: form.type === "route" ? form.route.map(row => ({ northM: numberOf(row.northM), eastM: numberOf(row.eastM), altitudeM: numberOf(row.altitudeM), speedMps: numberOf(row.speedMps) })) : null,
    initial: {
      ground: { northM: numberOf(form.groundNorthM), eastM: numberOf(form.groundEastM), headingDeg: numberOf(form.groundHeadingDeg), stateOfCharge: chargeOf(form.groundChargePercent) },
      air: form.airborne ? { altitudeM: numberOf(form.airAltitudeM), headingDeg: numberOf(form.airHeadingDeg), speedMps: numberOf(form.airSpeedMps) } : null,
    },
    finish: form.finish,
  };
}
/** A definition's reasons in the words of the form's fields. */
function plainProblem(problem: string): string {
  const ground = /^The ground start (\w+) must be a number from (\S+) to (\S+)$/.exec(problem);
  if (ground) {
    const [, key, low, high] = ground;
    if (key === "stateOfCharge") return `Battery charge must be a number from ${Number(low) * 100} to ${Number(high) * 100} percent`;
    return `The start ${key === "northM" ? "north" : key === "eastM" ? "east" : "heading"} must be a number from ${low} to ${high}`;
  }
  const air = /^The airborne start (\w+) must be a number from (\S+) to (\S+)$/.exec(problem);
  if (air) return `The airborne ${air[1] === "altitudeM" ? "altitude" : air[1] === "headingDeg" ? "heading" : "speed"} must be a number from ${air[2]} to ${air[3]}`;
  const parameter = /^The parameter (\w+) must be a number from (\S+) to (\S+)$/.exec(problem);
  if (parameter) return `${PARAMETER_LABELS[parameter[1] ?? ""] ?? parameter[1]} must be a number from ${parameter[2]} to ${parameter[3]}`;
  const point = /^(Route point \d+) (\w+) must be a number from (\S+) to (\S+)$/.exec(problem);
  if (point) return `${point[1]}: ${point[2] === "northM" ? "north" : point[2] === "eastM" ? "east" : point[2] === "altitudeM" ? "altitude" : "speed"} must be a number from ${point[3]} to ${point[4]}`;
  return problem;
}
export function formProblems(form: TaskForm): string[] { return flightTaskProblems(candidateOf(form)).map(plainProblem); }
/** The form as a definition; throws with every reason when it is not one. */
export function taskOfForm(form: TaskForm): FlightTaskDefinition { return parseFlightTask(candidateOf(form)); }

/** What one stage does, in words for the plan the tab shows. */
export function stageText(stage: FlightTaskStage): string {
  switch (stage.kind) {
    case "upload": return "Upload the route to ArduPilot, and wait for its acknowledgement";
    case "arm": return "GUIDED mode, and arm";
    case "takeoff": return `Take off to ${stage.altitudeM} m`;
    case "heading": return `Turn to heading ${stage.headingDeg}° at ${stage.altitudeM} m`;
    case "speed": return `Change speed from ${stage.fromSpeedMps} to ${stage.toSpeedMps} m/s at ${stage.rateMps2} m/s², on heading ${stage.headingDeg}°`;
    case "hold": return `Hold at ${stage.altitudeM} m for ${stage.durationS} s`;
    case "vertical": return `Go from ${stage.fromAltitudeM} to ${stage.toAltitudeM} m at ${stage.rateMps} m/s`;
    case "cruise": return `Fly ${stage.distanceM} m at ${stage.speedMps} m/s on heading ${stage.headingDeg}°`;
    case "turn": return `Turn ${stage.angleDeg}° at ${stage.rateDegS} °/s, flying ${stage.speedMps} m/s`;
    case "mission": return `Fly the ${stage.points.length} route points in AUTO`;
    case "land": return "LAND mode, until ArduPilot disarms";
    default: { const never: never = stage; return never; }
  }
}
/** The stages of a definition, each marked as part of the measured task or as the way to and from it. */
export function planLines(task: FlightTaskDefinition): readonly { readonly text: string; readonly measured: boolean }[] {
  return planFlightTask(task).map(planned => ({ text: stageText(planned.stage), measured: planned.measured }));
}

/** The definition of a stored `flight-task` version; the store validates only writes and imports, so this validates again. */
export function readFlightTask(stored: StoredVersion): FlightTaskDefinition {
  if (stored.record.kind !== "flight-task") throw new Error(`Record ${stored.sha256} is of kind ${stored.record.kind}, not a flight task`);
  return parseFlightTask(stored.record.payload);
}
/** Stores a new flight task, or a new version of `previous`. */
export function saveFlightTask(store: ProjectStore, projectId: string, name: string, task: FlightTaskDefinition,
  previous: { readonly id: string; readonly head: string } | null): Promise<StoredVersion> {
  const draft = { name, payload: task, dependencies: [] };
  return previous ? store.saveVersion(previous.id, previous.head, draft) : store.createItem(projectId, "flight-task", draft);
}
