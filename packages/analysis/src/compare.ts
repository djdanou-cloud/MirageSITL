// Comparing two flown experiments (TASK-177, S12): which inputs were held equal and which
// differ, how the mass changed, and their results side by side. An input held equal that differs
// is flagged; it does not stop the comparison, because what it means is the user's to judge.
// Nothing here says which experiment is better (SA-01). Cold path.
import type { FaultSchedule } from '@mirage/scenarios/fault-schedule';
import type { ComponentCard } from '@mirage/aircraft/components';
import type { ExperimentFlightTask, ExperimentParameter, ExperimentRecording, ExperimentSession, ExperimentSitl } from '@mirage/aircraft/experiment';
import type { AircraftProfile, ProfileMotor } from '@mirage/aircraft/profile';
import type { ThrustCapacity } from '@mirage/physics/thrust-capacity';
import { flightDurationEstimate, type DurationEstimate, type ExperimentMetrics, type WindowMetrics } from './metrics.ts';

/** The inputs of an experiment record a comparison reads. */
export interface ComparedInputs {
  readonly profile: { readonly sha256: string };
  readonly sitl: ExperimentSitl;
  readonly session: Pick<ExperimentSession, 'home' | 'physicsHz' | 'speedup'>;
  readonly parameters: readonly ExperimentParameter[];
  readonly frameScript: string | null;
  readonly sensors: unknown;
  readonly recording: ExperimentRecording | null;
  readonly flightTask: ExperimentFlightTask | null;
  readonly faults: FaultSchedule | null;
}
/** What a comparison reads of one experiment. */
export interface ComparedExperiment {
  readonly name: string;
  readonly payload: ComparedInputs;
  /** The profile version it flew with its cards, by SHA-256; null when this project does not hold them. */
  readonly aircraft: { readonly profile: AircraftProfile; readonly cards: ReadonlyMap<string, ComponentCard>; readonly cardNames: ReadonlyMap<string, string> } | null;
}

export const COMPARISON_CONTROLS = [
  { id: 'layout', label: 'Arms and motor layout' }, { id: 'motors', label: 'Motors' }, { id: 'propellers', label: 'Propellers' }, { id: 'escs', label: 'ESCs' },
  { id: 'battery', label: 'Battery' }, { id: 'aircraft-mass', label: 'Aircraft mass, CG and inertia' }, { id: 'payload', label: 'Payload' }, { id: 'aircraft-other', label: 'Other aircraft settings' },
  { id: 'flight-task', label: 'Flight task' }, { id: 'start', label: 'Start position and lead-in' }, { id: 'charge', label: 'Battery charge at the start' },
  { id: 'weather', label: 'Weather' }, { id: 'faults', label: 'Scheduled faults' }, { id: 'home', label: 'Home' }, { id: 'ardupilot', label: 'ArduPilot build' }, { id: 'parameters', label: 'Initial parameters' },
  { id: 'frame-script', label: 'Frame script' }, { id: 'sensors', label: 'Sensors' }, { id: 'physics-rate', label: 'Physics rate' }, { id: 'speed', label: 'Speed' },
  { id: 'recording', label: 'Recording setup' }, { id: 'sitl', label: 'SITL ownership' },
] as const;
export type ComparisonControl = (typeof COMPARISON_CONTROLS)[number]['id'];
/** One aircraft under different conditions, or different configurations under equal conditions. */
export type ComparisonKind = 'conditions' | 'configurations';

/** What each kind holds equal by default. A user may change these; speed, recording and ownership do not change the physics, so nothing holds them unless asked. */
const SHARED_HELD: readonly ComparisonControl[] = ['payload', 'ardupilot', 'physics-rate'];
const AIRCRAFT: readonly ComparisonControl[] = ['layout', 'motors', 'propellers', 'escs', 'battery', 'aircraft-mass', 'aircraft-other', 'parameters', 'frame-script', 'sensors'];
const CONDITIONS: readonly ComparisonControl[] = ['flight-task', 'start', 'charge', 'weather', 'faults', 'home'];
export function heldByDefault(kind: ComparisonKind): ReadonlySet<ComparisonControl> {
  switch (kind) {
    case 'conditions': return new Set([...SHARED_HELD, ...AIRCRAFT]);
    case 'configurations': return new Set([...SHARED_HELD, ...CONDITIONS, 'battery']);
    default: { const never: never = kind; throw new Error(`Unhandled comparison ${String(never)}`); }
  }
}

export interface ControlRow {
  readonly control: ComparisonControl;
  readonly label: string;
  readonly a: string;
  readonly b: string;
  readonly differs: boolean;
  readonly held: boolean;
  /** Held equal, and it differs. */
  readonly flagged: boolean;
}

const stable = (value: unknown): string => JSON.stringify(value);
/** An object without these keys, for comparing what is left. */
const without = (value: object, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const percent = (fraction: number): string => `${Number(`${fraction}e2`)} %`;
const SEPARATOR = ', ';

/** The cards of the motors of one component type, each once, with how many motors use it. */
function cardsText(side: NonNullable<ComparedExperiment['aircraft']>, pick: (motor: ProfileMotor) => string | null): string {
  const counts = new Map<string, number>();
  for (const motor of side.profile.motors) { const card = pick(motor) ?? 'none'; counts.set(card, (counts.get(card) ?? 0) + 1); }
  return [...counts].map(([card, count]) => `${card === 'none' ? 'none selected' : side.cardNames.get(card) ?? card.slice(0, 12)} × ${count}`).join(SEPARATOR);
}
interface Value { readonly text: string; readonly key: string }
const value = (text: string, key: unknown = text): Value => ({ text, key: stable(key) });

function aircraftValue(control: ComparisonControl, side: ComparedExperiment): Value {
  const aircraft = side.aircraft;
  // Without the version, only its address can be compared: two addresses differ if and only if the versions do.
  if (!aircraft) return value('The profile version is not in this project', side.payload.profile.sha256);
  const { profile } = aircraft;
  switch (control) {
    case 'layout': return value(`${profile.arms.length} arms, ${profile.motors.length} motors`,
      { arms: profile.arms, motors: profile.motors.map(({ id, armId, level, spin, output }) => ({ id, armId, level, spin, output })), groundClearanceM: profile.groundClearanceM });
    case 'motors': return value(cardsText(aircraft, motor => motor.components.motor), profile.motors.map(motor => motor.components.motor));
    case 'propellers': return value(cardsText(aircraft, motor => motor.components.propeller), profile.motors.map(motor => motor.components.propeller));
    case 'escs': return value(cardsText(aircraft, motor => motor.components.esc), profile.motors.map(motor => motor.components.esc));
    case 'battery': return value(profile.battery.card ? aircraft.cardNames.get(profile.battery.card) ?? profile.battery.card.slice(0, 12) : 'none selected', profile.battery.card);
    case 'aircraft-mass': return value(`${profile.massProperties.massKg} kg`, profile.massProperties);
    case 'payload': return value(profile.payload ? `${profile.payload.massKg} kg` : 'none', profile.payload);
    case 'aircraft-other': return value('As stored with the profile version', without(profile, ['arms', 'motors', 'massProperties', 'payload', 'battery', 'groundClearanceM', 'sensorConfiguration']));
    default: throw new Error(`${control} is not an aircraft input`);
  }
}
function controlValue(control: ComparisonControl, side: ComparedExperiment): Value {
  const { payload } = side, task = payload.flightTask, chosen = payload.parameters.filter(parameter => parameter.source !== 'site');
  switch (control) {
    case 'layout': case 'motors': case 'propellers': case 'escs': case 'battery': case 'aircraft-mass': case 'payload': case 'aircraft-other': return aircraftValue(control, side);
    case 'flight-task': {
      if (!task) return value('None', null);
      return value(task.name, without(task.definition, ['initial']));
    }
    case 'start': {
      const initial = task?.definition.initial;
      if (!initial) return value('On the pad', { northM: 0, eastM: 0, headingDeg: 0, air: null });
      const { northM, eastM, headingDeg } = initial.ground;
      return value(`${northM} m north, ${eastM} m east, heading ${headingDeg}°${initial.air ? `, arriving at ${initial.air.altitudeM} m` : ''}`, { northM, eastM, headingDeg, air: initial.air });
    }
    case 'charge': return value(percent(task?.definition.initial.ground.stateOfCharge ?? 1));
    // A run has no weather to choose until TASK-167, so both flew in still air.
    case 'weather': return value('Still air');
    case 'faults': return value(payload.faults ? `${payload.faults.entries.length} on the schedule` : 'None', payload.faults);
    case 'home': return value(payload.session.home.join(SEPARATOR));
    case 'ardupilot': return value(payload.sitl.ardupilot.firmwareVersion, payload.sitl.ownership === 'launcher' ? payload.sitl.ardupilot.binarySha256 : payload.sitl.ardupilot.commit);
    case 'parameters': return value(`${chosen.length} parameters`, chosen);
    case 'frame-script': return value(payload.frameScript === null ? 'Stock frame' : 'Scripting matrix', payload.frameScript);
    // A snapshot names the profile version it was copied from, which says nothing of the sensors: two versions can hold the same ones.
    case 'sensors': return value('As stored with the experiment', typeof payload.sensors === 'object' && payload.sensors !== null ? without(payload.sensors, ['profileSha256']) : payload.sensors);
    case 'physics-rate': return value(`${payload.session.physicsHz} Hz`);
    case 'speed': return value(payload.session.speedup === null ? 'Set by the SITL' : `${payload.session.speedup}×`);
    case 'recording': return value(payload.recording ? `${payload.recording.commonHz} Hz common rate` : 'No recording',
      payload.recording ? { commonHz: payload.recording.commonHz, groups: payload.recording.groups, signals: payload.recording.signals, durationMin: payload.recording.durationMin, reserveMb: payload.recording.reserveMb } : null);
    case 'sitl': return value(payload.sitl.ownership === 'launcher' ? 'Started by the launcher' : 'Started by hand');
    default: { const never: never = control; throw new Error(`Unhandled control ${String(never)}`); }
  }
}
/** Each input of the two experiments, whether it differs, and whether it should not have. */
export function comparisonControls(a: ComparedExperiment, b: ComparedExperiment, held: ReadonlySet<ComparisonControl>): ControlRow[] {
  return COMPARISON_CONTROLS.map(({ id, label }) => {
    const left = controlValue(id, a), right = controlValue(id, b), differs = left.key !== right.key, isHeld = held.has(id);
    return { control: id, label, a: left.text, b: right.text, differs, held: isHeld, flagged: isHeld && differs };
  });
}
/** The names of the initial parameters that differ, or that only one of them has. */
export function parameterDifferences(a: ComparedInputs, b: ComparedInputs): string[] {
  const chosen = (payload: ComparedInputs) => new Map(payload.parameters.filter(parameter => parameter.source !== 'site').map(parameter => [parameter.name, parameter.value]));
  const left = chosen(a), right = chosen(b);
  return [...new Set([...left.keys(), ...right.keys()])].filter(name => left.get(name) !== right.get(name)).sort();
}

// ---- mass ------------------------------------------------------------------------------------------------------------------------------

export const MASS_PARTS = ['motors', 'propellers', 'escs', 'battery'] as const;
export type MassPart = (typeof MASS_PARTS)[number];
export interface MassPartRow {
  readonly part: MassPart;
  /** The sum of the cards' stated masses; null when a card does not state one. */
  readonly aKg: number | null; readonly bKg: number | null;
  /** B less A; 0 when both use the same cards, even if a card states no mass; null when a difference cannot be known. */
  readonly differenceKg: number | null;
}
export interface MassAccounting {
  readonly aircraftKg: readonly [number, number];
  readonly payloadKg: readonly [number, number];
  readonly totalKg: readonly [number, number];
  readonly parts: readonly MassPartRow[];
  /** B less A of the components' own mass, over the parts; null while any part's difference is not known. */
  readonly componentDifferenceKg: number | null;
  /** B less A of the aircraft's stated mass. */
  readonly statedDifferenceKg: number;
  /** How much of the stated change the components do not explain; null while their difference is not known. */
  readonly unaccountedKg: number | null;
  /** The components changed by more than the stated mass did, or the other way round. */
  readonly flagged: boolean;
}
/** A kilogram figure below this is rounding in a card, not a change of mass. */
const MASS_NOTICE_KG = 0.001;
function partCards(profile: AircraftProfile, part: MassPart): (string | null)[] {
  switch (part) {
    case 'motors': return profile.motors.map(motor => motor.components.motor);
    case 'propellers': return profile.motors.map(motor => motor.components.propeller);
    case 'escs': return profile.motors.map(motor => motor.components.esc);
    case 'battery': return [profile.battery.card];
    default: { const never: never = part; throw new Error(`Unhandled part ${String(never)}`); }
  }
}
function partMassKg(cards: readonly (string | null)[], known: ReadonlyMap<string, ComponentCard>): number | null {
  let sum = 0;
  for (const address of cards) {
    const mass = address === null ? null : known.get(address)?.values.massKg ?? null;
    if (mass === null) return null;
    sum += mass;
  }
  return sum;
}
/** How the mass changes between two aircraft: what they state, and what their components' own masses say; null without both versions. */
export function massAccounting(a: ComparedExperiment, b: ComparedExperiment): MassAccounting | null {
  if (!a.aircraft || !b.aircraft) return null;
  const left = a.aircraft, right = b.aircraft;
  const parts = MASS_PARTS.map((part): MassPartRow => {
    const cardsA = partCards(left.profile, part), cardsB = partCards(right.profile, part), aKg = partMassKg(cardsA, left.cards), bKg = partMassKg(cardsB, right.cards);
    const same = stable(cardsA) === stable(cardsB);
    return { part, aKg, bKg, differenceKg: same ? 0 : aKg !== null && bKg !== null ? bKg - aKg : null };
  });
  const differences = parts.map(part => part.differenceKg), componentDifferenceKg = differences.includes(null) ? null : differences.reduce<number>((sum, difference) => sum + (difference ?? 0), 0);
  const aircraftA = left.profile.massProperties.massKg, aircraftB = right.profile.massProperties.massKg, payloadA = left.profile.payload?.massKg ?? 0, payloadB = right.profile.payload?.massKg ?? 0;
  const statedDifferenceKg = aircraftB - aircraftA, unaccountedKg = componentDifferenceKg === null ? null : statedDifferenceKg - componentDifferenceKg;
  return { aircraftKg: [aircraftA, aircraftB], payloadKg: [payloadA, payloadB], totalKg: [aircraftA + payloadA, aircraftB + payloadB], parts, componentDifferenceKg, statedDifferenceKg, unaccountedKg,
    flagged: unaccountedKg !== null && Math.abs(unaccountedKg) >= MASS_NOTICE_KG };
}

// ---- results ---------------------------------------------------------------------------------------------------------------------------

/** Which part of a flight the two are compared over: the task's measured part if both have one, or else the whole flight. */
export function comparisonWindowKind(a: ExperimentMetrics, b: ExperimentMetrics): 'task' | 'flight' { return a.task && b.task ? 'task' : 'flight'; }
const windowOf = (metrics: ExperimentMetrics, kind: 'task' | 'flight'): WindowMetrics | null => (kind === 'task' ? metrics.task : metrics.wholeFlight);

export interface MetricRow {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly unit: string;
  readonly digits: number;
  readonly a: number | null;
  readonly b: number | null;
  /** B less A; null when either is missing. */
  readonly difference: number | null;
}
export interface ResultInputs {
  readonly a: ExperimentMetrics; readonly b: ExperimentMetrics;
  readonly capacityA: ThrustCapacity | null; readonly capacityB: ThrustCapacity | null;
  readonly reservePercent: number;
}
const durationOf = (metrics: ExperimentMetrics, kind: 'task' | 'flight', reservePercent: number): DurationEstimate | null => {
  const window = windowOf(metrics, kind);
  return window && metrics.pack ? flightDurationEstimate(window, metrics.pack, reservePercent) : null;
};
/** The results, each with both values and their difference; a value the recording cannot give is null. */
export function metricRows({ a, b, capacityA, capacityB, reservePercent }: ResultInputs): MetricRow[] {
  const kind = comparisonWindowKind(a, b), windowA = windowOf(a, kind), windowB = windowOf(b, kind);
  const row = (id: string, group: string, label: string, unit: string, digits: number, left: number | null | undefined, right: number | null | undefined): MetricRow => {
    const valueA = left ?? null, valueB = right ?? null;
    return { id, group, label, unit, digits, a: valueA, b: valueB, difference: valueA !== null && valueB !== null ? valueB - valueA : null };
  };
  const margin = 'Takeoff capability and thrust margin', use = 'RPM, current, power and energy', position = 'Position against the request';
  const durationA = durationOf(a, kind, reservePercent), durationB = durationOf(b, kind, reservePercent);
  return [
    row('thrust', margin, 'Thrust at full command (calculated)', 'N', 2, capacityA?.thrustN, capacityB?.thrustN),
    row('weight', margin, 'Weight', 'N', 2, capacityA?.weightN, capacityB?.weightN),
    row('thrust-to-weight', margin, 'Thrust over weight', '', 3, capacityA?.thrustToWeight, capacityB?.thrustToWeight),
    row('highest', margin, 'Highest above where it stood', 'm', 2, a.flight?.highestAboveRestM, b.flight?.highestAboveRestM),
    row('command-mean', use, 'Mean motor command', '', 3, windowA?.command?.mean, windowB?.command?.mean),
    row('command-max', use, 'Largest motor command', '', 3, windowA?.command?.max, windowB?.command?.max),
    row('rpm-mean', use, 'Mean rotor speed', 'rev/min', 0, windowA?.rpm?.mean, windowB?.rpm?.mean),
    row('rpm-max', use, 'Largest rotor speed', 'rev/min', 0, windowA?.rpm?.max, windowB?.rpm?.max),
    row('current-mean', use, 'Mean battery current', 'A', 2, windowA?.current?.mean, windowB?.current?.mean),
    row('current-max', use, 'Largest battery current', 'A', 2, windowA?.current?.max, windowB?.current?.max),
    row('power-mean', use, 'Mean battery power', 'W', 1, windowA?.power?.mean, windowB?.power?.mean),
    row('power-max', use, 'Largest battery power', 'W', 1, windowA?.power?.max, windowB?.power?.max),
    row('voltage-min', use, 'Lowest battery voltage', 'V', 2, windowA?.voltage?.min, windowB?.voltage?.min),
    row('energy', use, 'Energy', 'Wh', 3, windowA?.energyWh, windowB?.energyWh),
    row('charge', use, 'Charge', 'Ah', 4, windowA?.chargeUsedAh, windowB?.chargeUsedAh),
    row('window', use, 'Length of this part of the flight', 's', 1, windowA?.durationS, windowB?.durationS),
    row('duration', 'Estimated flight duration', 'Flying as this part of the flight did', 'min', 1, durationA?.minutes, durationB?.minutes),
    row('horizontal-rms', position, 'Horizontal RMS', 'm', 3, a.position?.horizontalRmsM, b.position?.horizontalRmsM),
    row('horizontal-max', position, 'Horizontal largest', 'm', 3, a.position?.horizontalMaxM, b.position?.horizontalMaxM),
    row('altitude-rms', position, 'Altitude RMS', 'm', 3, a.position?.altitudeRmsM, b.position?.altitudeRmsM),
    row('altitude-max', position, 'Altitude largest', 'm', 3, a.position?.altitudeMaxM, b.position?.altitudeMaxM),
  ];
}
/** What the duration estimate assumes, in words: it names its scenario and its reserve. */
export function durationScenario(kind: 'task' | 'flight', taskName: string | null, reservePercent: number): string {
  const flown = kind === 'task' && taskName !== null ? `the measured part of ${taskName}` : 'this whole flight';
  return `Flying continuously as ${flown} did, at its mean current, from the charge the run started at down to a ${reservePercent} % reserve. It holds the current constant, so it leaves out the voltage falling as the pack empties. It is not an endurance figure for a real aircraft.`;
}
