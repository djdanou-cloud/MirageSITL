import type { TickId, Vec3 } from './state-v2.ts';
import type { EwEffect, ScheduledCommandV2 } from './control-v2.ts';

// Control Protocol v3 (docs/SPECS_SHARED_MEMORY.md, "Effect controls (TASK-166)"): every environment, sensor-error, EW and fault
// effect has a versioned control record with an on/off switch, a dimensionless intensity and physical parameters with units.
// Intensity 1 is the configured magnitude. EFFECT_CATALOG is the one place that states each effect's fields and ranges; validation,
// control-v3.schema.json and the instructor console read it, and every range is the owning model's validity envelope.
// An effect that is off or at intensity 0 must be bitwise identical to an absent one, so `effectiveControl` reduces both to "off"
// and the session then does nothing it would not do without the command. Cold path: admission allocates, the tick boundary reads.

export const CONTROL_PROTOCOL_VERSION_3 = 3;
export const EFFECT_CONTROL_SCHEMA_VERSION = 1;
export const EFFECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** The sea-level standard atmosphere an `atmosphere` control departs from as its intensity grows. */
export const ISA_TEMPERATURE_K = 288.15;
export const ISA_PRESSURE_PA = 101325;

/**
 * Who applies an effect. `environment` and `fault` act in the session's models; `sensor` is set before the run; `delivery` (TASK-168)
 * acts on what the link to ArduPilot carries, truth untouched; `ardupilot` (TASK-168) is ArduPilot's own fault parameters, written
 * over MAVLink by the run controller, since only it has a parameter service.
 */
export type EffectFamily = 'environment' | 'fault' | 'sensor' | 'delivery' | 'ardupilot';
/** Bits of a session's delivery mask, one per `delivery` effect. */
export const DELIVERY_IMU_FROZEN = 1, DELIVERY_GNSS_FROZEN = 2, DELIVERY_MAG_FROZEN = 4, DELIVERY_PILOT_LINK_LOST = 8, DELIVERY_GCS_LINK_LOST = 16;
export type EffectRecovery = 'hold-offset' | 'step-to-truth';

interface FieldBase { readonly key: string; readonly label: string; readonly unit: string }
export interface NumberField extends FieldBase {
  readonly kind: 'number'; readonly min: number; readonly max: number;
  readonly exclusiveMin?: boolean; readonly exclusiveMax?: boolean;
  /** What a new control starts from in a form; nothing is on until a control is sent. */
  readonly initial: number;
}
export interface IntegerField extends FieldBase { readonly kind: 'integer'; readonly min: number; readonly max: number; readonly initial: number }
export interface VectorField extends FieldBase {
  readonly kind: 'vector3'; readonly min: number; readonly max: number;
  readonly axes: readonly [string, string, string];
  readonly normMax?: number; readonly initial: Vec3;
}
export interface EnumField extends FieldBase { readonly kind: 'enum'; readonly options: readonly string[]; readonly initial: string }
export type EffectField = NumberField | IntegerField | VectorField | EnumField;
export interface EffectDefinition {
  readonly family: EffectFamily;
  readonly label: string;
  /** What intensity does, and which model owns the ranges. */
  readonly meaning: string;
  readonly fields: readonly EffectField[];
}

const number = (key: string, label: string, unit: string, min: number, max: number, initial: number, extra: Partial<NumberField> = {}): NumberField =>
  ({ key, label, unit, kind: 'number', min, max, initial, ...extra });
const vector = (key: string, label: string, unit: string, axes: readonly [string, string, string], limit: number, initial: Vec3, normMax?: number): VectorField =>
  ({ key, label, unit, kind: 'vector3', axes, min: -limit, max: limit, initial, ...(normMax === undefined ? {} : { normMax }) });
const NED = ['north', 'east', 'down'] as const, FRD = ['forward', 'right', 'down'] as const, RPY = ['roll', 'pitch', 'yaw'] as const;

/** Every effect a control can carry. Effect tasks registered later add theirs here. */
export const EFFECT_CATALOG = {
  'wind.mean': { family: 'environment', label: 'Mean wind', meaning: 'Intensity multiplies the wind. Range: the wind model.',
    fields: [vector('windNedMps', 'Wind', 'm/s', NED, 200, [5, 0, 0])] },
  'wind.gust': { family: 'environment', label: 'Synthetic gust', meaning: 'Intensity multiplies the RMS, so the same seed gives the same gusts, scaled. Range: the gust model.',
    fields: [number('rmsMps', 'RMS per axis', 'm/s', 0, 50, 1), number('bandwidthHz', 'Bandwidth', 'Hz', 0, 200, 1, { exclusiveMin: true, exclusiveMax: true }),
      { key: 'seed', label: 'Seed', unit: '1', kind: 'integer', min: 0, max: 0xffffffff, initial: 1 }] },
  'wind.turbulence': { family: 'environment', label: 'Turbulence (Dryden)', meaning: 'Intensity multiplies every RMS, so the same seed gives the same turbulence, scaled. W20 is the mean wind at 6 m that sets its strength, with RMS 0.1 W20 vertically; MIL-F-8785C calls 7.7 m/s light, 15.4 moderate and 23.2 severe. Range: the turbulence model.',
    fields: [number('w20Mps', 'Mean wind at 6 m (W20)', 'm/s', 0, 50, 7.7), { key: 'seed', label: 'Seed', unit: '1', kind: 'integer', min: 0, max: 0xffffffff, initial: 1 }] },
  'wind.discrete-gust': { family: 'environment', label: 'Discrete gust', meaning: 'Intensity multiplies the amplitude. Each time it goes on, one one-minus-cosine pulse (MIL-F-8785C) rises from zero to the amplitude at half the duration and back to zero at its end; another weather change leaves a running pulse alone. Range: the discrete-gust model.',
    fields: [number('amplitudeMps', 'Amplitude', 'm/s', 0, 50, 5), number('durationS', 'Duration', 's', 0.1, 60, 4),
      number('fromDeg', 'From (bearing)', '°', 0, 360, 0, { exclusiveMax: true }), number('upwardDeg', 'Upward angle', '°', -90, 90, 0)] },
  'rotor.ground-effect': { family: 'environment', label: 'Rotor ground effect', meaning: 'The thrust gain near the ground (TASK-100). Intensity multiplies the correction (R/4z)^2 and the neighbouring rotors\' terms; 1 is the closed form. Below half a radius it holds its value and flags the run. Needs the ESC drive.',
    fields: [] },
  atmosphere: { family: 'environment', label: 'Temperature and pressure', meaning: 'Intensity moves the air at the origin from the standard atmosphere (at 0) to these values (at 1). Range: the atmosphere model.',
    fields: [number('temperatureK', 'Temperature', 'K', 180, 330, ISA_TEMPERATURE_K), number('pressurePa', 'Pressure', 'Pa', 1000, 120000, ISA_PRESSURE_PA)] },
  'ew.gnss-jamming': { family: 'fault', label: 'GNSS jamming', meaning: 'Intensity multiplies the severity. Range: the jamming model.',
    fields: [number('severity', 'Severity', '1', 0, 1, 1)] },
  'ew.position-step': { family: 'fault', label: 'GNSS position step', meaning: 'Intensity multiplies the offset. Range: the position-step model.',
    fields: [vector('offsetNedM', 'Offset', 'm', NED, 10000, [100, 0, 0], 10000)] },
  'ew.velocity-drift': { family: 'fault', label: 'GNSS velocity drift', meaning: 'Intensity multiplies the acceleration and the top speed. Range: the drift model.',
    fields: [vector('accelerationNedMps2', 'Acceleration', 'm/s²', NED, 0.3, [0.2, 0, 0], 0.3),
      number('maxSpeedMps', 'Top speed', 'm/s', 0, 20, 2, { exclusiveMin: true })] },
  'ew.magnetic': { family: 'fault', label: 'Magnetic interference', meaning: 'Intensity multiplies the rotation and the bias. Range: the magnetic model.',
    fields: [vector('rotationRad', 'Rotation', 'rad', RPY, Math.PI, [0, 0, 0.5]), vector('biasBodyGauss', 'Bias', 'G', FRD, 2, [0, 0, 0])] },
  'motor.loss': { family: 'fault', label: 'Motor loss', meaning: 'Intensity multiplies the thrust lost, 1 minus the remaining fraction. Range: the motor fault table.',
    fields: [{ key: 'motorIndex', label: 'Motor index', unit: '1', kind: 'integer', min: 0, max: 31, initial: 0 },
      { key: 'mode', label: 'Mode', unit: '', kind: 'enum', options: ['power-cut', 'instant-thrust-loss'], initial: 'power-cut' },
      number('remainingThrustFraction', 'Remaining thrust', '1', 0, 1, 0)] },
  'sensor.imu.frozen': { family: 'delivery', label: 'IMU frozen', meaning: 'ArduPilot keeps receiving the last gyro and accelerometer values MirageSITL sent; the flight itself goes on. Any intensity above 0 is on. Only on a run with ArduPilot.', fields: [] },
  'sensor.gnss.frozen': { family: 'delivery', label: 'GNSS position frozen', meaning: 'ArduPilot keeps receiving the last north and east position and ground velocity, from which its GNSS is made, so the fix stops moving. Height and vertical speed go on, because they also feed its barometer. Any intensity above 0 is on. Only on a run with ArduPilot.', fields: [] },
  'sensor.mag.frozen': { family: 'delivery', label: 'Magnetometer frozen', meaning: 'ArduPilot keeps receiving the last attitude, from which its magnetometer is made; its IMU still turns. Any intensity above 0 is on. Only on a run with ArduPilot.', fields: [] },
  'link.pilot': { family: 'delivery', label: 'Pilot control lost', meaning: 'Stick commands stop at the bridge, as if the radio had gone; everything else still flows. Any intensity above 0 is on. Only on a run with ArduPilot.', fields: [] },
  'link.gcs': { family: 'delivery', label: 'Ground-station link lost', meaning: 'All MAVLink stops at the bridge in both directions, so MirageSITL can neither see nor command the autopilot; the physics goes on. Any intensity above 0 is on. Only on a run with ArduPilot.', fields: [] },
  'sensor.imu.missing': { family: 'ardupilot', label: 'IMU missing', meaning: 'ArduPilot stops producing IMU samples (SIM_ACC_FAIL_MSK, SIM_GYR_FAIL_MSK). Any intensity above 0 is on. Only on a run with ArduPilot that MirageSITL started.', fields: [] },
  'sensor.gnss.missing': { family: 'ardupilot', label: 'GNSS missing', meaning: 'ArduPilot\'s GNSS loses its fix (SIM_GPS1_LCKTIME). Any intensity above 0 is on. Only on a run with ArduPilot that MirageSITL started.', fields: [] },
  'sensor.baro.missing': { family: 'ardupilot', label: 'Barometer missing', meaning: 'ArduPilot\'s barometers stop reporting (SIM_BAROn_DISABLE). Any intensity above 0 is on. Only on a run with ArduPilot that MirageSITL started.', fields: [] },
  'sensor.baro.frozen': { family: 'ardupilot', label: 'Barometer frozen', meaning: 'ArduPilot\'s barometers keep reporting the last altitude (SIM_BAROn_FREEZE). Any intensity above 0 is on. Only on a run with ArduPilot that MirageSITL started.', fields: [] },
  'sensor.mag.missing': { family: 'ardupilot', label: 'Magnetometer missing', meaning: 'ArduPilot\'s magnetometers stop reporting (SIM_MAGn_FAIL). Any intensity above 0 is on. Only on a run with ArduPilot that MirageSITL started.', fields: [] },
  'sensor.imu.accel-noise': { family: 'sensor', label: 'Accelerometer noise', meaning: 'Intensity multiplies the density. Range: the Sensors tab.',
    fields: [number('densityMps2PerSqrtHz', 'Noise density', 'm/s²/√Hz', 0, 0.01, 0)] },
  'sensor.imu.gyro-noise': { family: 'sensor', label: 'Gyroscope noise', meaning: 'Intensity multiplies the density. Range: the Sensors tab.',
    fields: [number('densityRadSPerSqrtHz', 'Noise density', 'rad/s/√Hz', 0, 0.001, 0)] },
  'sensor.imu.accel-bias': { family: 'sensor', label: 'Accelerometer bias', meaning: 'Intensity multiplies the bias. Range: the Sensors tab.',
    fields: [vector('biasMps2', 'Bias', 'm/s²', FRD, 2, [0, 0, 0])] },
  'sensor.imu.gyro-bias': { family: 'sensor', label: 'Gyroscope bias', meaning: 'Intensity multiplies the bias. Range: the Sensors tab.',
    fields: [vector('biasRadS', 'Bias', 'rad/s', FRD, 0.2, [0, 0, 0])] },
  'sensor.imu.latency': { family: 'sensor', label: 'IMU latency', meaning: 'Intensity multiplies the latency. Range: the Sensors tab.',
    fields: [{ key: 'latencyUs', label: 'Latency', unit: 'µs', kind: 'integer', min: 0, max: 100000, initial: 0 }] },
  'sensor.battery.voltage': { family: 'sensor', label: 'Battery voltage reading', meaning: 'Intensity multiplies each error. Range: the Sensors tab.',
    fields: [number('gainError', 'Gain error', '1', -0.1, 0.1, 0), number('offsetV', 'Offset', 'V', -2, 2, 0), number('noiseRmsV', 'Noise (1σ)', 'V', 0, 1, 0)] },
  'sensor.battery.current': { family: 'sensor', label: 'Battery current reading', meaning: 'Intensity multiplies each error. Range: the Sensors tab.',
    fields: [number('gainError', 'Gain error', '1', -0.2, 0.2, 0), number('offsetA', 'Offset', 'A', -20, 20, 0), number('noiseRmsA', 'Noise (1σ)', 'A', 0, 10, 0)] },
} as const satisfies Record<string, EffectDefinition>;
export type EffectId = keyof typeof EFFECT_CATALOG;
/**
 * TASK-167: the random streams the seeded weather effects draw from, by effect: the synthetic gust's one per axis (wind.ts) and the
 * Dryden turbulence's five (turbulence.ts DRYDEN_STREAMS). A seed repeats a realization only with these streams, so a weather schedule
 * records them; tests/weather-schedule.test.ts holds the models to them.
 */
export const EFFECT_RANDOM_STREAMS = Object.freeze({
  'wind.gust': Object.freeze([0, 1, 2]),
  'wind.turbulence': Object.freeze([0x00106001, 0x00106002, 0x00106003, 0x00106004, 0x00106005]),
});
export const EFFECT_IDS = Object.keys(EFFECT_CATALOG) as readonly EffectId[];
export function isEffectId(value: unknown): value is EffectId {
  return typeof value === 'string' && Object.hasOwn(EFFECT_CATALOG, value);
}
export function effectDefinition(id: EffectId): EffectDefinition { return EFFECT_CATALOG[id]; }

export type EffectParameterValue = number | Vec3 | string;
export interface EffectControl {
  readonly schemaVersion: typeof EFFECT_CONTROL_SCHEMA_VERSION;
  /** Names this control's instance; for a fault, its fault ID. */
  readonly id: string;
  readonly effect: EffectId;
  readonly enabled: boolean;
  /** At least 0; 1 is the configured magnitude. */
  readonly intensity: number;
  /** The fields of EFFECT_CATALOG[effect], each in its unit. */
  readonly parameters: Readonly<Record<string, EffectParameterValue>>;
}
type FaultSetV2 = Extract<ScheduledCommandV2, { type: 'fault.set' }>;
/** What a control does on its tick: read by the session without allocating. */
export type EffectiveControl =
  | { readonly family: 'environment'; readonly effect: 'wind.mean'; readonly active: boolean; readonly windNedMps: Vec3 }
  | { readonly family: 'environment'; readonly effect: 'wind.gust'; readonly active: boolean; readonly rmsMps: number; readonly bandwidthHz: number; readonly seed: number }
  | { readonly family: 'environment'; readonly effect: 'wind.turbulence'; readonly active: boolean; readonly w20Mps: number; readonly intensity: number; readonly seed: number }
  | { readonly family: 'environment'; readonly effect: 'rotor.ground-effect'; readonly active: boolean; readonly intensity: number }
  | { readonly family: 'environment'; readonly effect: 'atmosphere'; readonly active: boolean; readonly temperatureK: number; readonly pressurePa: number }
  /** TASK-167: the peak air velocity of the pulse, NED m/s (intensity applied), and its duration, s. */
  | { readonly family: 'environment'; readonly effect: 'wind.discrete-gust'; readonly active: boolean; readonly peakNedMps: Vec3; readonly durationS: number }
  | { readonly family: 'fault'; readonly fault: FaultSetV2 }
  | { readonly family: 'sensor' }
  | { readonly family: 'delivery'; readonly active: boolean; readonly bit: number }
  | { readonly family: 'ardupilot'; readonly active: boolean };
/** The command as it travels. */
export interface EffectSetCommand {
  readonly protocolVersion: typeof CONTROL_PROTOCOL_VERSION_3;
  readonly requestId: number; readonly expectedEpoch: number; readonly atTick: TickId;
  readonly type: 'effect.set';
  readonly control: EffectControl;
  /** How a fault's offset ends when it is switched off; environment and sensor effects simply stop. */
  readonly recovery: EffectRecovery;
}
/** The command as it waits in the queue, its values worked out at admission so that its tick allocates nothing. */
export interface LoweredEffectSet extends EffectSetCommand { readonly effective: EffectiveControl }

export class EffectRangeError extends Error {}
const range = (message: string) => new EffectRangeError(message);
export class EffectSchemaError extends Error {}
const shape = (message: string) => new EffectSchemaError(message);

const plain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw shape(`${name} must be a finite number`);
  return value;
}
const exact = (value: Record<string, unknown>, keys: readonly string[], name: string): void => {
  for (const key of keys) if (!Object.hasOwn(value, key)) throw shape(`${name}.${key} is required`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw shape(`${name}.${key} is not allowed`);
};
function withinRange(value: number, field: NumberField, name: string): number {
  const below = field.exclusiveMin ? value <= field.min : value < field.min, above = field.exclusiveMax ? value >= field.max : value > field.max;
  if (below || above) throw range(`${name} must be in ${field.exclusiveMin ? '(' : '['}${field.min}, ${field.max}${field.exclusiveMax ? ')' : ']'}`);
  return value;
}
function parseField(field: EffectField, value: unknown, name: string): EffectParameterValue {
  switch (field.kind) {
    case 'number': return withinRange(finite(value, name), field, name);
    case 'integer': {
      const n = finite(value, name);
      if (!Number.isInteger(n)) throw shape(`${name} must be an integer`);
      if (n < field.min || n > field.max) throw range(`${name} must be in [${field.min}, ${field.max}]`);
      return n;
    }
    case 'enum':
      if (typeof value !== 'string' || !field.options.includes(value)) throw shape(`${name} must be one of ${field.options.join(', ')}`);
      return value;
    case 'vector3': {
      if (!Array.isArray(value) || value.length !== 3) throw shape(`${name} must be an array of three numbers`);
      const items: unknown[] = value;
      const v: Vec3 = [finite(items[0], `${name}[0]`), finite(items[1], `${name}[1]`), finite(items[2], `${name}[2]`)];
      checkVector(v, field, name);
      return v;
    }
    default: { const never: never = field; throw shape(`Unhandled field ${String(never)}`); }
  }
}
function checkVector(v: Vec3, field: VectorField, name: string): void {
  for (const item of v) if (item < field.min || item > field.max) throw range(`${name} must lie in [${field.min}, ${field.max}] per axis`);
  if (field.normMax !== undefined && Math.hypot(v[0], v[1], v[2]) > field.normMax) throw range(`${name} norm must be <= ${field.normMax}`);
}

/** Validates an untrusted control record into a fresh copy. Throws EffectSchemaError or EffectRangeError. */
export function parseEffectControl(input: unknown): EffectControl {
  if (!plain(input)) throw shape('control must be a plain object');
  exact(input, ['schemaVersion', 'id', 'effect', 'enabled', 'intensity', 'parameters'], 'control');
  if (input.schemaVersion !== EFFECT_CONTROL_SCHEMA_VERSION) throw shape(`control.schemaVersion must be ${EFFECT_CONTROL_SCHEMA_VERSION}`);
  if (typeof input.id !== 'string' || !EFFECT_ID_PATTERN.test(input.id)) throw shape(`control.id must match ${EFFECT_ID_PATTERN.source}`);
  if (!isEffectId(input.effect)) throw shape(`control.effect must be one of ${EFFECT_IDS.join(', ')}`);
  if (typeof input.enabled !== 'boolean') throw shape('control.enabled must be a boolean');
  const intensity = finite(input.intensity, 'control.intensity');
  if (intensity < 0) throw range('control.intensity must be at least 0');
  const definition: EffectDefinition = EFFECT_CATALOG[input.effect];
  if (!plain(input.parameters)) throw shape('control.parameters must be a plain object');
  exact(input.parameters, definition.fields.map(field => field.key), 'control.parameters');
  const raw = input.parameters, parameters: Record<string, EffectParameterValue> = {};
  for (const field of definition.fields) parameters[field.key] = parseField(field, raw[field.key], `control.parameters.${field.key}`);
  return { schemaVersion: EFFECT_CONTROL_SCHEMA_VERSION, id: input.id, effect: input.effect, enabled: input.enabled, intensity, parameters };
}

const numberOf = (control: EffectControl, key: string): number => {
  const value = control.parameters[key];
  if (typeof value !== 'number') throw shape(`control.parameters.${key} is not a number`);
  return value;
};
const vectorOf = (control: EffectControl, key: string): Vec3 => {
  const value = control.parameters[key];
  if (!Array.isArray(value)) throw shape(`control.parameters.${key} is not a vector`);
  return value as Vec3;
};
const scaled = (v: Vec3, intensity: number): Vec3 => [v[0] * intensity, v[1] * intensity, v[2] * intensity];
function fieldOf(effect: EffectId, key: string): EffectField {
  const definition: EffectDefinition = EFFECT_CATALOG[effect], field = definition.fields.find(item => item.key === key);
  if (!field) throw shape(`${effect} has no field ${key}`);
  return field;
}
/** A scaled value must still lie in the model's envelope. */
function scaledNumber(control: EffectControl, key: string, intensity: number): number {
  const field = fieldOf(control.effect, key), value = numberOf(control, key) * intensity;
  if (field.kind !== 'number') throw shape(`${key} is not a number field`);
  return withinRange(value, field, `${key} at intensity ${intensity}`);
}
function scaledVector(control: EffectControl, key: string, intensity: number): Vec3 {
  const field = fieldOf(control.effect, key), value = scaled(vectorOf(control, key), intensity);
  if (field.kind !== 'vector3') throw shape(`${key} is not a vector field`);
  checkVector(value, field, `${key} at intensity ${intensity}`);
  return value;
}
function deliveryBit(effect: EffectId): number {
  switch (effect) {
    case 'sensor.imu.frozen': return DELIVERY_IMU_FROZEN;
    case 'sensor.gnss.frozen': return DELIVERY_GNSS_FROZEN;
    case 'sensor.mag.frozen': return DELIVERY_MAG_FROZEN;
    case 'link.pilot': return DELIVERY_PILOT_LINK_LOST;
    case 'link.gcs': return DELIVERY_GCS_LINK_LOST;
    default: throw shape(`${effect} is not a delivery effect`);
  }
}
/** The air density the atmosphere model accepts at the origin, kg/m³, and its gas constant (packages/physics/src/atmosphere.ts). */
const AIR_DENSITY_MIN_KGM3 = 0.05, AIR_DENSITY_MAX_KGM3 = 2, AIR_GAS_CONSTANT = 287.05287;
/** A value that intensity moves from the standard atmosphere: exactly the value at 1, and within the envelope. */
function fromStandard(control: EffectControl, key: string, standard: number, intensity: number): number {
  const field = fieldOf(control.effect, key), value = numberOf(control, key);
  if (field.kind !== 'number') throw shape(`${key} is not a number field`);
  return withinRange(intensity === 1 ? value : standard + intensity * (value - standard), field, `${key} at intensity ${intensity}`);
}
function faultEffect(control: EffectControl, intensity: number): EwEffect {
  switch (control.effect) {
    case 'ew.gnss-jamming': return { kind: 'gnss-jamming', severity: scaledNumber(control, 'severity', intensity) };
    case 'ew.position-step': return { kind: 'position-step', offsetNedM: scaledVector(control, 'offsetNedM', intensity) };
    case 'ew.velocity-drift': return { kind: 'velocity-drift', accelerationNedMps2: scaledVector(control, 'accelerationNedMps2', intensity), maxSpeedMps: scaledNumber(control, 'maxSpeedMps', intensity) };
    case 'ew.magnetic': return { kind: 'magnetic', rotationRad: scaledVector(control, 'rotationRad', intensity), biasBodyGauss: scaledVector(control, 'biasBodyGauss', intensity) };
    case 'motor.loss': {
      const remaining = numberOf(control, 'remainingThrustFraction'), lost = intensity === 1 ? remaining : 1 - intensity * (1 - remaining);
      if (lost < 0 || lost > 1) throw range(`the thrust lost at intensity ${intensity} is more than all of it`);
      const mode = control.parameters.mode;
      if (mode !== 'power-cut' && mode !== 'instant-thrust-loss') throw shape('control.parameters.mode is not a motor failure mode');
      return { kind: 'motor-loss', motorIndex: numberOf(control, 'motorIndex'), mode, remainingThrustFraction: lost };
    }
    default: throw shape(`${control.effect} is not a fault`);
  }
}

/** What a validated control does. Off and intensity 0 reduce to the same "not active", so neither can differ from an absent effect. */
export function effectiveControl(control: EffectControl, envelope: { requestId: number; expectedEpoch: number; atTick: TickId; recovery: EffectRecovery }): EffectiveControl {
  const active = control.enabled && control.intensity > 0, i = active ? control.intensity : 1;
  const definition: EffectDefinition = EFFECT_CATALOG[control.effect];
  switch (definition.family) {
    case 'environment':
      if (control.effect === 'wind.mean') return { family: 'environment', effect: 'wind.mean', active, windNedMps: scaledVector(control, 'windNedMps', i) };
      if (control.effect === 'wind.turbulence') {
        scaledNumber(control, 'w20Mps', i);
        // W20 itself stays as written: intensity scales the strength, not the speed the turbulence is carried past at.
        return { family: 'environment', effect: 'wind.turbulence', active: active && numberOf(control, 'w20Mps') > 0, w20Mps: numberOf(control, 'w20Mps'), intensity: i, seed: numberOf(control, 'seed') };
      }
      if (control.effect === 'rotor.ground-effect') return { family: 'environment', effect: 'rotor.ground-effect', active, intensity: i };
      if (control.effect === 'wind.gust') return { family: 'environment', effect: 'wind.gust', active, rmsMps: scaledNumber(control, 'rmsMps', i), bandwidthHz: numberOf(control, 'bandwidthHz'), seed: numberOf(control, 'seed') };
      if (control.effect === 'wind.discrete-gust') {
        // A gust from the north blows south; a positive upward angle is an updraft (SPECS_SIMULATION_ENGINES, TASK-167).
        const amplitude = scaledNumber(control, 'amplitudeMps', i), from = numberOf(control, 'fromDeg') * Math.PI / 180, up = numberOf(control, 'upwardDeg') * Math.PI / 180;
        const horizontal = amplitude * Math.cos(up);
        return { family: 'environment', effect: 'wind.discrete-gust', active: active && amplitude > 0,
          peakNedMps: [-horizontal * Math.cos(from), -horizontal * Math.sin(from), -amplitude * Math.sin(up)], durationS: numberOf(control, 'durationS') };
      }
      {
        const temperatureK = fromStandard(control, 'temperatureK', ISA_TEMPERATURE_K, i), pressurePa = fromStandard(control, 'pressurePa', ISA_PRESSURE_PA, i);
        // Refused here rather than on its tick, where a refusal would fault the session.
        const density = pressurePa / (AIR_GAS_CONSTANT * temperatureK);
        if (density < AIR_DENSITY_MIN_KGM3 || density > AIR_DENSITY_MAX_KGM3) throw range(`${temperatureK} K and ${pressurePa} Pa give ${density.toFixed(3)} kg/m³; the atmosphere model holds ${AIR_DENSITY_MIN_KGM3} to ${AIR_DENSITY_MAX_KGM3} kg/m³`);
        return { family: 'environment', effect: 'atmosphere', active, temperatureK, pressurePa };
      }
    case 'fault':
      return { family: 'fault', fault: { protocolVersion: 2, requestId: envelope.requestId, expectedEpoch: envelope.expectedEpoch, atTick: envelope.atTick,
        type: 'fault.set', faultId: control.id, enabled: active, effect: faultEffect(control, i), recovery: envelope.recovery } };
    case 'sensor':
      // Range-checks the scaled values, so a sensor control is refused for the same reasons wherever it is applied.
      for (const field of definition.fields) {
        if (field.kind === 'number') scaledNumber(control, field.key, i);
        if (field.kind === 'vector3') scaledVector(control, field.key, i);
        if (field.kind === 'integer' && numberOf(control, field.key) * i > field.max) throw range(`${field.key} at intensity ${i} must be at most ${field.max}`);
      }
      return { family: 'sensor' };
    case 'delivery': {
      const bit = deliveryBit(control.effect);
      return { family: 'delivery', active, bit };
    }
    case 'ardupilot':
      return { family: 'ardupilot', active };
    default: { const never: never = definition.family; throw shape(`Unhandled family ${String(never)}`); }
  }
}

/** Validates an `effect.set` body whose envelope and tick the caller has validated. */
export function parseEffectSet(input: Record<string, unknown>, envelope: { requestId: number; expectedEpoch: number; atTick: TickId }): EffectSetCommand {
  if (input.recovery !== 'hold-offset' && input.recovery !== 'step-to-truth') throw shape('recovery must be one of hold-offset, step-to-truth');
  const recovery: EffectRecovery = input.recovery, control = parseEffectControl(input.control);
  // Throws when the intensity carries a value out of its envelope.
  effectiveControl(control, { ...envelope, recovery });
  return { protocolVersion: CONTROL_PROTOCOL_VERSION_3, requestId: envelope.requestId, expectedEpoch: envelope.expectedEpoch, atTick: envelope.atTick,
    type: 'effect.set', control, recovery };
}
export function lowerEffectSet(command: EffectSetCommand): LoweredEffectSet {
  return { ...command, effective: effectiveControl(command.control, command) };
}

// --- Migration of Control Protocol v2 ---------------------------------------

const record = (id: string, effect: EffectId, enabled: boolean, parameters: Record<string, EffectParameterValue>): EffectControl =>
  ({ schemaVersion: EFFECT_CONTROL_SCHEMA_VERSION, id, effect, enabled, intensity: 1, parameters });
/** The bandwidth a v2 `weather.set` always had, which it could not state. */
export const WEATHER_SET_GUST_BANDWIDTH_HZ = 1;
/** The three records one v2 `weather.set` stands for. Sent on one tick they give what it gives, bit for bit. */
export function migrateWeatherSet(command: Extract<ScheduledCommandV2, { type: 'weather.set' }>): readonly [EffectControl, EffectControl, EffectControl] {
  return [record('weather-wind', 'wind.mean', true, { windNedMps: [...command.windNedMps] }),
    record('weather-gust', 'wind.gust', true, { rmsMps: command.turbulenceRmsMps, bandwidthHz: WEATHER_SET_GUST_BANDWIDTH_HZ, seed: command.seed }),
    record('weather-atmosphere', 'atmosphere', true, { temperatureK: command.temperatureK, pressurePa: command.pressurePa })];
}
/** The record one v2 `fault.set` stands for. */
export function migrateFaultSet(command: Extract<ScheduledCommandV2, { type: 'fault.set' }>): EffectControl {
  const e = command.effect, id = command.faultId, on = command.enabled;
  switch (e.kind) {
    case 'gnss-jamming': return record(id, 'ew.gnss-jamming', on, { severity: e.severity });
    case 'position-step': return record(id, 'ew.position-step', on, { offsetNedM: [...e.offsetNedM] });
    case 'velocity-drift': return record(id, 'ew.velocity-drift', on, { accelerationNedMps2: [...e.accelerationNedMps2], maxSpeedMps: e.maxSpeedMps });
    case 'magnetic': return record(id, 'ew.magnetic', on, { rotationRad: [...e.rotationRad], biasBodyGauss: [...e.biasBodyGauss] });
    case 'motor-loss': return record(id, 'motor.loss', on, { motorIndex: e.motorIndex, mode: e.mode, remainingThrustFraction: e.remainingThrustFraction });
    default: { const never: never = e; throw shape(`Unhandled effect ${String(never)}`); }
  }
}

/**
 * What a form starts from: every field's `initial`, on at intensity 1. Nothing takes effect until a control is sent, and an effect
 * never sent is absent.
 */
export function initialEffectParameters(effect: EffectId): Record<string, EffectParameterValue> {
  const definition: EffectDefinition = EFFECT_CATALOG[effect], parameters: Record<string, EffectParameterValue> = {};
  for (const field of definition.fields) {
    if (field.kind === 'vector3') parameters[field.key] = [field.initial[0], field.initial[1], field.initial[2]];
    else parameters[field.key] = field.initial;
  }
  return parameters;
}

// --- Schedules ---------------------------------------------------------------

export interface EffectSchedule {
  /** The tick the effect starts on. */
  readonly onsetTick: number;
  /** Ticks it lasts; null holds it until something changes it. */
  readonly durationTicks: number | null;
  /** How a fault's offset ends. */
  readonly recovery: EffectRecovery;
}
export interface ScheduledEffect { readonly tick: number; readonly control: EffectControl; readonly recovery: EffectRecovery }
/**
 * A schedule as the ordinary commands that carry it out: the effect on at its onset, and off when its duration ends. Each is
 * acknowledged on its own tick, so an effect that ended is as visible as one that began.
 */
export function scheduledEffects(control: EffectControl, schedule: EffectSchedule): readonly ScheduledEffect[] {
  const { onsetTick, durationTicks, recovery } = schedule;
  if (!Number.isSafeInteger(onsetTick) || onsetTick < 0) throw range('onsetTick must be a tick');
  if (durationTicks !== null && (!Number.isSafeInteger(durationTicks) || durationTicks < 1)) throw range('durationTicks must be at least 1 tick, or null');
  const on = { tick: onsetTick, control, recovery };
  return durationTicks === null ? [on] : [on, { tick: onsetTick + durationTicks, control: { ...control, enabled: false }, recovery }];
}
