import { Ajv } from 'ajv';
import schema from './sensor-config.schema.json';
import {
  DEFAULT_SENSOR_CONFIGURATION, SENSOR_FIELDS, SENSOR_KINDS, type FieldValue, type SensorConfiguration, type SensorFieldPath,
} from './sensor-fields.ts';
import { findSensorPreset } from './sensor-presets.ts';

// Validation of sensor configuration schema 1 (TASK-143). The schema checks
// shapes, units and ranges; code checks the rules of the Phase 1 ownership
// mapping. Configuration-time only.

export { schema as sensorConfigurationSchema };
/** Adds the schema's annotation keyword to an Ajv instance that compiles or references it. */
export function addSensorSchemaKeywords(ajv: Ajv): Ajv {
  return ajv.addKeyword({ keyword: 'x-unit', metaSchema: { type: 'string' } });
}
const ajv = addSensorSchemaKeywords(new Ajv({ strict: true, strictNumbers: true, allowUnionTypes: true, allErrors: true }));
const validateSchema = ajv.compile<SensorConfiguration>(schema);
const PRESET_NAMES = { imu: 'IMU', gnss: 'GNSS', barometer: 'barometer', magnetometer: 'magnetometer', battery: 'battery' } as const;

function fail(message: string): never {
  throw new Error(`Invalid sensor configuration: ${message}`);
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Every schema error, for tests of the ranges that code checks would otherwise hide. */
export function sensorConfigurationSchemaErrors(input: unknown): readonly string[] {
  if (validateSchema(input)) return [];
  return (validateSchema.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? 'does not match the schema'}`);
}

/** The stored value of a field. */
export function readField(config: SensorConfiguration, path: SensorFieldPath): FieldValue | null {
  const [sensor = '', key = ''] = path.split('.');
  const kind = SENSOR_KINDS.find(item => item === sensor);
  if (!kind) throw new Error(`Unknown sensor field ${path}`);
  const value: unknown = Reflect.get(config[kind], key);
  if (value === null || typeof value === 'number') return value;
  if (Array.isArray(value) && value.every(item => typeof item === 'number')) return value.map(Number);
  throw new Error(`Sensor field ${path} holds no number`);
}

/** Schema and mapping checks; returns a deep-frozen copy. */
export function validateSensorConfiguration(input: unknown): SensorConfiguration {
  const config: unknown = structuredClone(input);
  if (!validateSchema(config)) {
    const error = validateSchema.errors?.[0];
    return fail(`${error?.instancePath || '/'} ${error?.message ?? 'does not match the schema'}`);
  }
  for (const spec of SENSOR_FIELDS) {
    const value = readField(config, spec.path);
    if (value === null) continue;
    if (!spec.applicable) fail(`${spec.label} cannot be applied on native-json yet: ${spec.disabledReason ?? ''}`);
    if (spec.stepUs !== null && typeof value === 'number' && value % spec.stepUs !== 0) {
      fail(`${spec.label} must be a whole number of milliseconds, because ArduPilot applies it in milliseconds`);
    }
  }
  for (const kind of SENSOR_KINDS) {
    const reference = config[kind].preset;
    if (reference === null) continue;
    const preset = findSensorPreset(reference);
    if (!preset) fail(`${PRESET_NAMES[kind]} preset ${reference.id} is not in preset catalog ${reference.catalogVersion}`);
    if (preset.sensor !== kind) fail(`${PRESET_NAMES[kind]} preset ${reference.id} is a ${PRESET_NAMES[preset.sensor]} preset`);
  }
  return freeze(config);
}

/** True for ArduPilot defaults: specified mode with no value and no preset; such a configuration is stored as null. */
export function isDefaultSensorConfiguration(config: SensorConfiguration): boolean {
  return JSON.stringify(canonical(config)) === JSON.stringify(canonical(DEFAULT_SENSOR_CONFIGURATION));
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(Reflect.get(value, key))]));
  }
  return value;
}
