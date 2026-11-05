// Signal catalog and rate plan of recording format v2 (TASK-162, S13). Each
// signal has a numeric ID, a group, named channels with units, a value type
// and its source: the physics tick (one sample per tick at the physics rate),
// a sensor frame or autopilot message that arrives when it arrives
// (aperiodic, bounded by a nominal source rate), or an event, which is always
// recorded. A plan turns one common rate with per-group and per-signal
// overrides into an effective rate per signal: the lower of the requested
// and the source rate, with a request above the source rate marked capped.
// Cold path: plans are built before a recording starts.

export type SignalGroup = "truth" | "pilot" | "actuators" | "motors" | "battery" | "sensors" | "autopilot" | "events";
export type SignalSource = "physics" | "sensor" | "telemetry" | "event";
export type ValueType = "f32" | "f64" | "parameter";
export interface ChannelInfo { readonly name: string; readonly unit: string }
export interface SignalInfo {
  readonly id: number;
  readonly name: string;
  readonly group: SignalGroup;
  readonly source: SignalSource;
  readonly valueType: ValueType;
  readonly channels: readonly ChannelInfo[];
}

/** Recording rates are whole hertz from 1 to 2000 (S13 offers 2 kHz where a source produces it). */
export const MIN_RATE_HZ = 1, MAX_RATE_HZ = 2000;
/** A-09: the default common logging frequency. */
export const DEFAULT_COMMON_RATE_HZ = 50;
/** Channels of one signal, so a presence mask fits a u32. */
export const MAX_CHANNELS = 16;

const ch = (unit: string, ...names: string[]): ChannelInfo[] => names.map(name => ({ name, unit }));
const perMotor = (unit: string): ChannelInfo[] => Array.from({ length: 16 }, (_, i) => ({ name: `motor${i + 1}`, unit }));

/** Signal IDs; the values are stored in records and never reused. */
export const SignalId = {
  TruthPosition: 1, TruthVelocity: 2, TruthAttitude: 3, TruthRates: 4, TruthAcceleration: 5, TruthSpecificForce: 6, TruthAir: 7,
  Pilot: 8, Actuators: 9,
  MotorSpeed: 10, MotorCurrent: 11, MotorBusCurrent: 12, MotorPower: 13, MotorCommand: 14,
  Battery: 15,
  SensorImu: 16, SensorGnss: 17, SensorMagnetometer: 18, SensorBarometer: 19, SensorAirspeed: 20,
  AutopilotAttitude: 32, AutopilotLocalPosition: 33, AutopilotGlobalPosition: 34, AutopilotGps: 35, AutopilotEkf: 36,
  Parameter: 64, Weather: 65, Fault: 66, Pause: 67, Accident: 68, FlightTaskRequest: 69, FlightTaskAttitudeRequest: 70, LimitEvent: 71,
  /** Rows lost before the row that follows; never a signal a plan selects. */
  Gap: 127,
} as const;

const SIGNALS: readonly SignalInfo[] = [
  { id: SignalId.TruthPosition, name: "truth.position", group: "truth", source: "physics", valueType: "f64", channels: ch("m", "north", "east", "down") },
  { id: SignalId.TruthVelocity, name: "truth.velocity", group: "truth", source: "physics", valueType: "f64", channels: ch("m/s", "north", "east", "down") },
  { id: SignalId.TruthAttitude, name: "truth.attitude", group: "truth", source: "physics", valueType: "f64", channels: ch("1", "qw", "qx", "qy", "qz") },
  { id: SignalId.TruthRates, name: "truth.bodyRates", group: "truth", source: "physics", valueType: "f64", channels: ch("rad/s", "p", "q", "r") },
  { id: SignalId.TruthAcceleration, name: "truth.acceleration", group: "truth", source: "physics", valueType: "f64", channels: ch("m/s^2", "north", "east", "down") },
  { id: SignalId.TruthSpecificForce, name: "truth.specificForce", group: "truth", source: "physics", valueType: "f64", channels: ch("m/s^2", "x", "y", "z") },
  { id: SignalId.TruthAir, name: "truth.air", group: "truth", source: "physics", valueType: "f64",
    channels: [{ name: "trueAirspeed", unit: "m/s" }, { name: "ambientPressure", unit: "Pa" }, { name: "groundClearance", unit: "m" }] },
  { id: SignalId.Pilot, name: "pilot", group: "pilot", source: "physics", valueType: "f32", channels: ch("1", "roll", "pitch", "yaw", "throttle") },
  { id: SignalId.Actuators, name: "actuators", group: "actuators", source: "physics", valueType: "f32",
    channels: Array.from({ length: 16 }, (_, i) => ({ name: `output${i + 1}`, unit: "1" })) },
  { id: SignalId.MotorSpeed, name: "motors.speed", group: "motors", source: "physics", valueType: "f32", channels: perMotor("rev/min") },
  { id: SignalId.MotorCurrent, name: "motors.current", group: "motors", source: "physics", valueType: "f32", channels: perMotor("A") },
  { id: SignalId.MotorBusCurrent, name: "motors.busCurrent", group: "motors", source: "physics", valueType: "f32", channels: perMotor("A") },
  { id: SignalId.MotorPower, name: "motors.power", group: "motors", source: "physics", valueType: "f32", channels: perMotor("W") },
  { id: SignalId.MotorCommand, name: "motors.command", group: "motors", source: "physics", valueType: "f32", channels: perMotor("1") },
  { id: SignalId.Battery, name: "battery", group: "battery", source: "physics", valueType: "f64",
    channels: [{ name: "stateOfCharge", unit: "1" }, { name: "voltage", unit: "V" }, { name: "current", unit: "A" }, { name: "power", unit: "W" },
      { name: "remaining", unit: "Ah" }] },
  { id: SignalId.SensorImu, name: "sensors.imu", group: "sensors", source: "sensor", valueType: "f64",
    channels: [...ch("m/s^2", "accelX", "accelY", "accelZ"), ...ch("rad/s", "gyroX", "gyroY", "gyroZ")] },
  { id: SignalId.SensorGnss, name: "sensors.gnss", group: "sensors", source: "sensor", valueType: "f64",
    channels: [{ name: "latitude", unit: "deg" }, { name: "longitude", unit: "deg" }, { name: "altitudeMsl", unit: "m" }, ...ch("m/s", "velNorth", "velEast", "velDown"),
      ...ch("1", "hdop", "vdop", "fixType", "satellites"), { name: "course", unit: "rad" }] },
  { id: SignalId.SensorMagnetometer, name: "sensors.magnetometer", group: "sensors", source: "sensor", valueType: "f64", channels: ch("Gauss", "x", "y", "z") },
  { id: SignalId.SensorBarometer, name: "sensors.barometer", group: "sensors", source: "sensor", valueType: "f64",
    channels: [{ name: "pressure", unit: "Pa" }, { name: "altitude", unit: "m" }, { name: "temperature", unit: "K" }] },
  { id: SignalId.SensorAirspeed, name: "sensors.airspeed", group: "sensors", source: "sensor", valueType: "f64", channels: ch("Pa", "differentialPressure") },
  { id: SignalId.AutopilotAttitude, name: "autopilot.attitude", group: "autopilot", source: "telemetry", valueType: "f32",
    channels: [...ch("rad", "roll", "pitch", "yaw"), ...ch("rad/s", "rollRate", "pitchRate", "yawRate")] },
  { id: SignalId.AutopilotLocalPosition, name: "autopilot.localPosition", group: "autopilot", source: "telemetry", valueType: "f32",
    channels: [...ch("m", "north", "east", "down"), ...ch("m/s", "velNorth", "velEast", "velDown")] },
  { id: SignalId.AutopilotGlobalPosition, name: "autopilot.globalPosition", group: "autopilot", source: "telemetry", valueType: "f64",
    channels: [{ name: "latitude", unit: "deg" }, { name: "longitude", unit: "deg" }, { name: "altitudeMsl", unit: "m" }, { name: "altitudeRelative", unit: "m" },
      ...ch("m/s", "velNorth", "velEast", "velDown"), { name: "heading", unit: "deg" }] },
  { id: SignalId.AutopilotGps, name: "autopilot.gps", group: "autopilot", source: "telemetry", valueType: "f64",
    channels: [{ name: "latitude", unit: "deg" }, { name: "longitude", unit: "deg" }, { name: "altitudeMsl", unit: "m" }, { name: "fixType", unit: "1" },
      { name: "satellites", unit: "1" }, { name: "eph", unit: "1" }, { name: "epv", unit: "1" }] },
  { id: SignalId.AutopilotEkf, name: "autopilot.ekf", group: "autopilot", source: "telemetry", valueType: "f32",
    channels: [{ name: "flags", unit: "1" }, ...ch("1", "velocityVariance", "horizontalPositionVariance", "verticalPositionVariance", "compassVariance",
      "terrainAltitudeVariance")] },
  { id: SignalId.Parameter, name: "events.parameter", group: "events", source: "event", valueType: "parameter", channels: [{ name: "value", unit: "1" }] },
  { id: SignalId.Weather, name: "events.weather", group: "events", source: "event", valueType: "f64", channels: ch("1", "code", "a", "b", "c") },
  { id: SignalId.Fault, name: "events.fault", group: "events", source: "event", valueType: "f64", channels: ch("1", "code", "a", "b", "c") },
  { id: SignalId.Pause, name: "events.pause", group: "events", source: "event", valueType: "f64", channels: ch("1", "paused") },
  { id: SignalId.Accident, name: "events.accident", group: "events", source: "event", valueType: "f64", channels: ch("1", "code", "a", "b", "c") },
  // TASK-172: what a flight task requests at this moment, beside the truth signals of the same ticks; a channel is absent where the stage requests nothing of it.
  { id: SignalId.FlightTaskRequest, name: "events.flightTask", group: "events", source: "event", valueType: "f64",
    channels: [...ch("1", "stage", "measured"), { name: "taskTime", unit: "s" }, ...ch("m", "north", "east", "altitude"), { name: "speed", unit: "m/s" },
      { name: "heading", unit: "deg" }, { name: "verticalSpeed", unit: "m/s" }] },
  // TASK-173: the attitude a roll or pitch maneuver requests, at the tick of its events.flightTask row. A signal of its own, because a row must hold exactly its signal's channels: more channels on events.flightTask would make recordings already stored unreadable.
  { id: SignalId.FlightTaskAttitudeRequest, name: "events.flightTaskAttitude", group: "events", source: "event", valueType: "f64", channels: ch("deg", "roll", "pitch") },
  // TASK-177: the limit monitor's events, each at its own tick, so a stored experiment can say what it exceeded. A first row says the monitor reports here: a recording without this signal is older, and cannot say there were none.
  { id: SignalId.LimitEvent, name: "events.limit", group: "events", source: "event", valueType: "f64", channels: ch("1", "code", "subject", "quantity", "edge", "value", "limit") },
];
export const SIGNAL_CATALOG: readonly SignalInfo[] = Object.freeze(SIGNALS.map(signal => Object.freeze({ ...signal, channels: Object.freeze(signal.channels) })));
const BY_ID = new Map(SIGNAL_CATALOG.map(signal => [signal.id, signal]));
const BY_NAME = new Map(SIGNAL_CATALOG.map(signal => [signal.name, signal]));
export function signalById(id: number): SignalInfo | undefined { return BY_ID.get(id); }
export function signalByName(name: string): SignalInfo | undefined { return BY_NAME.get(name); }
/** Bytes of one value of a signal's type; a parameter row holds a 16-byte name and a float32. */
export function valueBytes(signal: SignalInfo): number { return signal.valueType === "f64" ? 8 : 4; }
export function payloadBytes(signal: SignalInfo): number {
  return signal.valueType === "parameter" ? 20 : signal.channels.length * valueBytes(signal);
}

export interface RateRequest {
  /** The common rate, Hz; A-09 default 50. */
  readonly commonHz?: number;
  /** Per-group rates; a group absent here uses the common rate, 0 records none of the group. */
  readonly groups?: Partial<Readonly<Record<SignalGroup, number>>>;
  /** Per-signal rates by name; they win over the group's. 0 records none of the signal. */
  readonly signals?: Readonly<Record<string, number>>;
}
export interface PlannedSignal extends SignalInfo {
  /** The source's rate, Hz: the physics rate for physics signals; the nominal rate for aperiodic sources; null for events. */
  readonly sourceHz: number | null;
  /** True when samples arrive when they arrive rather than once per tick. */
  readonly aperiodic: boolean;
  readonly requestedHz: number | null;
  /** min(requested, source); 0 when not recorded; null for events, which are always recorded. */
  readonly effectiveHz: number | null;
  /** The request exceeded what the source produces, so the effective rate is the source rate. */
  readonly capped: boolean;
}
export interface SourceRates {
  /** 400, 800 or 1200 (A-04). */
  readonly physicsHz: number;
  /** Nominal rates of the autopilot messages the session requests, Hz (the Run tab requests 10 Hz streams). */
  readonly telemetryHz: number;
}
export interface RatePlan {
  readonly physicsHz: number;
  readonly commonHz: number;
  readonly signals: readonly PlannedSignal[];
}

function rate(value: number, where: string): number {
  if (!Number.isInteger(value) || (value !== 0 && (value < MIN_RATE_HZ || value > MAX_RATE_HZ))) {
    throw new RangeError(`${where}: a rate is 0 or a whole number of hertz from ${MIN_RATE_HZ} to ${MAX_RATE_HZ}`);
  }
  return value;
}

/** The effective rate of every catalog signal under `request`. Throws on an unknown name or an invalid rate. */
export function planRates(request: RateRequest, sources: SourceRates): RatePlan {
  if (![400, 800, 1200].includes(sources.physicsHz)) throw new RangeError("The physics rate is 400, 800 or 1200 Hz");
  if (!Number.isInteger(sources.telemetryHz) || sources.telemetryHz < 1 || sources.telemetryHz > MAX_RATE_HZ) throw new RangeError("Invalid telemetry rate");
  const commonHz = rate(request.commonHz ?? DEFAULT_COMMON_RATE_HZ, "commonHz");
  for (const [group, value] of Object.entries(request.groups ?? {})) {
    if (!SIGNAL_CATALOG.some(signal => signal.group === group)) throw new RangeError(`Unknown signal group ${group}`);
    rate(value ?? 0, `groups.${group}`);
  }
  for (const [name, value] of Object.entries(request.signals ?? {})) {
    const signal = signalByName(name);
    if (!signal) throw new RangeError(`Unknown signal ${name}`);
    if (signal.source === "event") throw new RangeError(`${name} is an event and is always recorded`);
    rate(value, `signals.${name}`);
  }
  const signals = SIGNAL_CATALOG.map((signal): PlannedSignal => {
    if (signal.source === "event") return { ...signal, sourceHz: null, aperiodic: true, requestedHz: null, effectiveHz: null, capped: false };
    const sourceHz = signal.source === "telemetry" ? sources.telemetryHz : sources.physicsHz;
    const requestedHz = request.signals?.[signal.name] ?? request.groups?.[signal.group] ?? commonHz;
    return { ...signal, sourceHz, aperiodic: signal.source !== "physics", requestedHz, effectiveHz: Math.min(requestedHz, sourceHz),
      capped: requestedHz > sourceHz };
  });
  return Object.freeze({ physicsHz: sources.physicsHz, commonHz, signals: Object.freeze(signals) });
}

/** Rows the plan keeps per second of simulated time at the effective rates, events excluded. */
export function plannedRowsPerSecond(plan: RatePlan): number {
  return plan.signals.reduce((sum, signal) => sum + (signal.effectiveHz ?? 0), 0);
}
