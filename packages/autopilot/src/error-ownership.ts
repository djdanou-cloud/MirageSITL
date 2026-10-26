// Sensor-error ownership (TASK-089). Decides, per error source, whether
// ArduPilot's SITL sensor backends or MirageSITL apply the error, and which
// repository-evidenced path carries an error that MirageSITL applies. The
// native firmware stays unmodified. Configuration-time only.

/** ArduPilot commit pinned in native/ardupilot/source.lock.json. */
export const PINNED_ARDUPILOT_COMMIT = '8ab6afde107a91df1b5f60ade8f333cb8a61b190';
export const OWNERSHIP_PROFILE_VERSION = 1;
/** JSON state keys covered by the TASK-041 oracle (tests/fixtures/sitl/json-protocol.json). */
export const JSON_ORACLE_KEYS = ['timestamp', 'imu.gyro', 'imu.accel_body', 'position', 'velocity', 'quaternion', 'velocity_wind'] as const;

export type AutopilotPath = 'native-json' | 'browser-hal';
export type ErrorOwner = 'ardupilot' | 'mirage' | 'none';
type Setting = readonly [name: string, value: number];

interface DeliveryDefinition {
  readonly path: AutopilotPath;
  /** The repository evidence that this path reaches the firmware. */
  readonly evidence: string;
  /** JSON state key for `json:` paths; it must be covered by the TASK-041 oracle. */
  readonly jsonKey: string | null;
  /** Parameters that switch the firmware onto this path. */
  readonly enablers: readonly Setting[];
}
export const DELIVERY_PATHS = {
  'json:imu.accel_body': { path: 'native-json', evidence: 'TASK-041 JSON state line', jsonKey: 'imu.accel_body', enablers: [] },
  'json:imu.gyro': { path: 'native-json', evidence: 'TASK-041 JSON state line', jsonKey: 'imu.gyro', enablers: [] },
  'hal:specific-force': { path: 'browser-hal', evidence: 'browser_hal.h sensor values 6..8 (specific force FRD)', jsonKey: null, enablers: [] },
  'hal:gyro': { path: 'browser-hal', evidence: 'browser_hal.h sensor values 9..11 (gyro)', jsonKey: null, enablers: [] },
  'hal:magnetic-field': { path: 'browser-hal', evidence: 'browser_hal.h sensor values 16..18 (body magnetic field)', jsonKey: null, enablers: [] },
  'mavlink:gps-input': { path: 'native-json', evidence: 'TASK-059 GPS_INPUT injection (scripts/sitl/driver.mjs, telemetry.py)', jsonKey: null,
    enablers: [['GPS1_TYPE', 14], ['GPS2_TYPE', 0], ['GPS1_RATE_MS', 100]] },
  'mavlink:sim-mag-offsets': { path: 'native-json', evidence: 'TASK-059 magnetic case: PARAM_SET of SIM_MAGn_OFS_* (telemetry.py)', jsonKey: null, enablers: [] },
} as const satisfies Record<string, DeliveryDefinition>;
export type DeliveryPath = keyof typeof DELIVERY_PATHS;

export const ERROR_SOURCE_IDS = ['imu.accel.noise-floor', 'imu.gyro.noise-floor', 'imu.accel.noise', 'imu.gyro.noise',
  'imu.accel.bias', 'imu.gyro.bias', 'imu.accel.scale', 'imu.gyro.scale', 'imu.gyro.drift', 'imu.vibration',
  'imu.lever-arm', 'imu.board-trim', 'baro.noise', 'baro.drift', 'baro.glitch', 'baro.delay', 'baro.wind',
  'baro.ground-effect', 'mag.noise', 'mag.hard-iron', 'mag.soft-iron', 'mag.delay', 'mag.anomaly', 'mag.motor',
  'gnss.receiver'] as const;
export type ErrorSourceId = typeof ERROR_SOURCE_IDS[number];
export interface ErrorSourceDefinition {
  readonly sensor: 'imu' | 'baro' | 'mag' | 'gnss';
  /** Paths on which ArduPilot's SITL backends apply this error. */
  readonly ardupilotPaths: readonly AutopilotPath[];
  /** Catalog parameters and the values that disable ArduPilot's version of the error. */
  readonly neutralize: readonly Setting[];
  /** ArduPilot applies the error unconditionally: no parameter disables it. */
  readonly fixed: boolean;
  /** Pinned-source facts (catalog IDs) that establish the behaviour above. */
  readonly facts: readonly string[];
  /** Paths that carry a MirageSITL-applied version; a matrix lists all of them for its path. */
  readonly deliveries: readonly DeliveryPath[];
}

const BOTH: readonly AutopilotPath[] = ['native-json', 'browser-hal'];
const NATIVE: readonly AutopilotPath[] = ['native-json'];
const ACCEL: readonly DeliveryPath[] = ['json:imu.accel_body', 'hal:specific-force'];
const GYRO: readonly DeliveryPath[] = ['json:imu.gyro', 'hal:gyro'];
const MAG: readonly DeliveryPath[] = ['hal:magnetic-field'];
/** Every cataloged instance: the defaults loader skips names a build lacks (fact param-defaults-unknown-skipped). */
const imus = (suffix: string, value: number): Setting[] => [1, 2, 3, 4, 5].map(i => [`SIM_ACC${i}_${suffix}`, value]);
const gyros = (suffix: string, value: number): Setting[] => [1, 2, 3, 4, 5].map(i => [`SIM_GYR${i}_${suffix}`, value]);
const baros = (suffix: string): Setting[] => ['BARO', 'BAR2', 'BAR3'].map(b => [`SIM_${b}_${suffix}`, 0]);
const mags = (suffix: string, value: number): Setting[] => [1, 2, 3].map(i => [`SIM_MAG${i}_${suffix}`, value]);

export const ERROR_SOURCES: { readonly [id in ErrorSourceId]: ErrorSourceDefinition } = {
  'imu.accel.noise-floor': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [], fixed: true,
    facts: ['ins-accel-noise-floor', 'ins-accel-noise-floor-applied'], deliveries: [] },
  'imu.gyro.noise-floor': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [], fixed: true,
    facts: ['ins-gyro-noise-floor', 'ins-gyro-noise-floor-applied'], deliveries: [] },
  'imu.accel.noise': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: imus('RND', 0), fixed: false, facts: ['ins-accel-motor-noise'], deliveries: ACCEL },
  'imu.gyro.noise': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: gyros('RND', 0), fixed: false, facts: ['ins-gyro-motor-noise'], deliveries: GYRO },
  'imu.accel.bias': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: imus('BIAS', 0), fixed: false, facts: ['ins-accel-bias'], deliveries: ACCEL },
  'imu.gyro.bias': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: gyros('BIAS', 0), fixed: false, facts: ['ins-gyro-bias'], deliveries: GYRO },
  // SIM_ACCn_SCAL divides only when non-zero; SIM_GYRn_SCALE is a percentage.
  'imu.accel.scale': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: imus('SCAL', 0), fixed: false,
    facts: ['ins-accel-scale-nonzero-divides'], deliveries: ACCEL },
  'imu.gyro.scale': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: gyros('SCALE', 0), fixed: false, facts: ['ins-gyro-scale-percent'], deliveries: GYRO },
  'imu.gyro.drift': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [['SIM_DRIFT_SPEED', 0]], fixed: false,
    facts: ['ins-gyro-drift-zero-disables'], deliveries: GYRO },
  'imu.vibration': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [['SIM_VIB_FREQ', 0], ['SIM_VIB_MOT_MAX', 0]], fixed: false,
    facts: ['ins-vibration-frequency', 'ins-vibration-motor'], deliveries: [...ACCEL, ...GYRO] },
  'imu.lever-arm': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [['SIM_IMU_POS', 0]], fixed: false, facts: ['ins-lever-arm'], deliveries: ACCEL },
  // The trim also rotates the compass, which no native path can deliver, so only ArduPilot or nobody applies it.
  'imu.board-trim': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [['SIM_BRD_TRIM', 0]], fixed: false, facts: ['ins-board-trim'], deliveries: [] },
  // Barometer altitude shares the position fields with navigation truth, so no path carries a separate baro error.
  'baro.noise': { sensor: 'baro', ardupilotPaths: BOTH, neutralize: baros('RND'), fixed: false, facts: ['baro-noise'], deliveries: [] },
  'baro.drift': { sensor: 'baro', ardupilotPaths: BOTH, neutralize: baros('DRIFT'), fixed: false, facts: ['baro-drift'], deliveries: [] },
  'baro.glitch': { sensor: 'baro', ardupilotPaths: BOTH, neutralize: baros('GLITCH'), fixed: false, facts: ['baro-glitch'], deliveries: [] },
  'baro.delay': { sensor: 'baro', ardupilotPaths: BOTH, neutralize: baros('DELAY'), fixed: false, facts: ['baro-delay'], deliveries: [] },
  'baro.wind': { sensor: 'baro', ardupilotPaths: BOTH, fixed: false, facts: ['baro-wind'], deliveries: [],
    neutralize: ['FWD', 'BAK', 'RGT', 'LFT', 'UP', 'DN'].flatMap(side => baros(`WCF_${side}`)) },
  'baro.ground-effect': { sensor: 'baro', ardupilotPaths: BOTH, neutralize: baros('GEFF_M'), fixed: false, facts: ['baro-ground-effect'], deliveries: [] },
  'mag.noise': { sensor: 'mag', ardupilotPaths: BOTH, neutralize: [['SIM_MAG_RND', 0]], fixed: false, facts: ['compass-noise'], deliveries: MAG },
  'mag.hard-iron': { sensor: 'mag', ardupilotPaths: BOTH, neutralize: mags('OFS', 0), fixed: false, facts: ['compass-hard-iron'],
    deliveries: ['mavlink:sim-mag-offsets', 'hal:magnetic-field'] },
  // A zero diagonal is the identity; scaling multiplies.
  'mag.soft-iron': { sensor: 'mag', ardupilotPaths: BOTH, neutralize: [...mags('DIA', 0), ...mags('ODI', 0), ...mags('SCALING', 1)],
    fixed: false, facts: ['compass-soft-iron-zero-is-identity', 'compass-scaling'], deliveries: MAG },
  'mag.delay': { sensor: 'mag', ardupilotPaths: BOTH, neutralize: [['SIM_MAG_DELAY', 0]], fixed: false, facts: ['compass-delay'], deliveries: MAG },
  // The aircraft model adds these in fill_fdm, which the browser HAL bypasses.
  'mag.anomaly': { sensor: 'mag', ardupilotPaths: NATIVE, neutralize: [['SIM_MAG_ALY', 0]], fixed: false,
    facts: ['aircraft-mag-anomaly', 'aircraft-body-mag-field'], deliveries: MAG },
  'mag.motor': { sensor: 'mag', ardupilotPaths: NATIVE, neutralize: [['SIM_MAG_MOT', 0]], fixed: false,
    facts: ['aircraft-mag-motor', 'aircraft-body-mag-field'], deliveries: MAG },
  // GPS_INPUT replaces the whole SITL receiver, so MirageSITL owns all of its errors at once.
  'gnss.receiver': { sensor: 'gnss', ardupilotPaths: BOTH, neutralize: [], fixed: false, facts: [], deliveries: ['mavlink:gps-input'] },
};

export interface OwnershipEntry { readonly source: ErrorSourceId; readonly owner: ErrorOwner; readonly delivery: readonly DeliveryPath[] }
export interface OwnershipMatrix {
  readonly schemaVersion: 1; readonly id: string; readonly path: AutopilotPath; readonly entries: readonly OwnershipEntry[];
}
export interface CatalogParameter { readonly name: string; readonly vector: boolean; readonly default: string; readonly conditions: readonly string[] }
export interface ArduPilotCatalog {
  readonly commit: string;
  readonly parameters: ReadonlyMap<string, CatalogParameter>;
  readonly jsonKeys: ReadonlySet<string>;
  readonly facts: ReadonlySet<string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) {
    throw new Error(`Invalid ${label} fields`);
  }
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error(`Invalid ${label}`);
  return value;
}
function list(value: unknown, label: string, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${label} list`);
  return value;
}
function isSource(value: unknown): value is ErrorSourceId { return ERROR_SOURCE_IDS.some(id => id === value); }
function isDelivery(value: unknown): value is DeliveryPath { return typeof value === 'string' && Object.hasOwn(DELIVERY_PATHS, value); }

/** Validates the generated pinned-source catalog (tests/fixtures/sitl/ardupilot-catalog.json). */
export function parseArduPilotCatalog(input: unknown): ArduPilotCatalog {
  const value = exact(input, ['schemaVersion', 'description', 'ardupilotCommit', 'upstream', 'simParameters', 'unresolvedSubgroups',
    'copterDefaults', 'jsonBackendDefaults', 'jsonKeys', 'facts'], 'catalog');
  if (value.schemaVersion !== 1) throw new Error('Unsupported catalog schema');
  if (value.ardupilotCommit !== PINNED_ARDUPILOT_COMMIT) throw new Error('Catalog is not from the pinned ArduPilot commit');
  text(value.description, 'catalog description');
  for (const item of list(value.upstream, 'upstream', 64)) {
    const file = exact(item, ['path', 'sha256', 'bytes'], 'upstream file');
    if (!/^[a-f0-9]{64}$/.test(text(file.sha256, 'upstream hash')) || !Number.isSafeInteger(file.bytes)) throw new Error('Invalid upstream file identity');
    text(file.path, 'upstream path');
  }
  const parameters = new Map<string, CatalogParameter>();
  for (const item of list(value.simParameters, 'parameter', 4096)) {
    const p = exact(item, ['name', 'vector', 'default', 'source', 'conditions'], 'catalog parameter');
    const name = text(p.name, 'parameter name');
    if (!/^SIM_[A-Z0-9_]+$/.test(name) || parameters.has(name) || typeof p.vector !== 'boolean') throw new Error(`Invalid catalog parameter ${name}`);
    const conditions = list(p.conditions, 'condition', 16).map(condition => text(condition, 'condition'));
    text(p.source, 'parameter source');
    parameters.set(name, Object.freeze({ name, vector: p.vector, default: text(p.default, 'parameter default'), conditions: Object.freeze(conditions) }));
  }
  const jsonKeys = new Set<string>();
  for (const item of list(value.jsonKeys, 'JSON key', 256)) {
    const key = exact(item, ['key', 'type', 'required'], 'JSON key');
    if (typeof key.required !== 'boolean') throw new Error('Invalid JSON key flag');
    text(key.type, 'JSON key type');
    jsonKeys.add(text(key.key, 'JSON key'));
  }
  const facts = new Set<string>();
  for (const item of list(value.facts, 'fact', 256)) {
    const fact = exact(item, ['id', 'path', 'text'], 'fact');
    text(fact.path, 'fact path'); text(fact.text, 'fact text');
    const id = text(fact.id, 'fact ID');
    if (facts.has(id)) throw new Error(`Duplicate fact ${id}`);
    facts.add(id);
  }
  for (const item of list(value.unresolvedSubgroups, 'subgroup', 256)) exact(item, ['prefix', 'class'], 'subgroup');
  for (const defaults of [value.copterDefaults, value.jsonBackendDefaults]) {
    if (!record(defaults) || !Object.values(defaults).every(v => typeof v === 'string')) throw new Error('Invalid catalog defaults');
  }
  return Object.freeze({ commit: PINNED_ARDUPILOT_COMMIT, parameters, jsonKeys, facts });
}

/**
 * Rejects double or missing ownership, delivery paths without repository
 * evidence for the matrix path, parameters or facts absent from the
 * pinned-source catalog, and ownership that would need a firmware patch.
 */
export function validateOwnershipMatrix(input: unknown, catalog: ArduPilotCatalog): OwnershipMatrix {
  const value = exact(input, ['schemaVersion', 'id', 'path', 'entries'], 'ownership matrix');
  if (value.schemaVersion !== 1) throw new Error('Unsupported ownership matrix schema');
  const id = text(value.id, 'matrix ID');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid matrix ID');
  const path = value.path;
  if (path !== 'native-json' && path !== 'browser-hal') throw new Error('Unknown autopilot path');
  const entries: OwnershipEntry[] = [];
  for (const item of list(value.entries, 'entry', ERROR_SOURCE_IDS.length)) {
    const entry = exact(item, ['source', 'owner', 'delivery'], 'ownership entry');
    if (!isSource(entry.source)) throw new Error('Unknown error source');
    if (entries.some(other => other.source === entry.source)) throw new Error(`Error source ${entry.source} has two owners`);
    const owner = entry.owner;
    if (owner !== 'ardupilot' && owner !== 'mirage' && owner !== 'none') throw new Error(`Unknown owner for ${entry.source}`);
    const delivery = list(entry.delivery, 'delivery', 8).map(d => {
      if (!isDelivery(d)) throw new Error(`Delivery path for ${String(entry.source)} has no repository evidence`);
      return d;
    });
    entries.push({ source: entry.source, owner, delivery });
  }
  for (const source of ERROR_SOURCE_IDS) if (!entries.some(entry => entry.source === source)) throw new Error(`Error source ${source} has no owner`);
  for (const entry of entries) {
    const source = ERROR_SOURCES[entry.source], appliedByArduPilot = source.ardupilotPaths.includes(path);
    for (const fact of source.facts) if (!catalog.facts.has(fact)) throw new Error(`Fact ${fact} for ${entry.source} is not in the catalog`);
    for (const [name] of source.neutralize) {
      const parameter = catalog.parameters.get(name);
      if (!parameter) throw new Error(`Parameter ${name} for ${entry.source} is not in the pinned-source catalog`);
      if (parameter.conditions.some(condition => condition !== '#if AP_SIM_ENABLED' && !/^#if (INS_MAX_INSTANCES|HAL_COMPASS_MAX_SENSORS) > [1-9]$/.test(condition))) {
        throw new Error(`Parameter ${name} depends on an unverified build condition`);
      }
    }
    if (entry.owner === 'ardupilot') {
      if (!appliedByArduPilot) throw new Error(`ArduPilot does not apply ${entry.source} on the ${path} path`);
      if (entry.delivery.length > 0) throw new Error(`An ArduPilot-owned ${entry.source} has no MirageSITL delivery`);
      continue;
    }
    if (appliedByArduPilot && source.fixed) {
      throw new Error(`ArduPilot applies ${entry.source} unconditionally; changing its owner needs a native firmware patch (BLOCKED_DECISION)`);
    }
    if (appliedByArduPilot && source.neutralize.length === 0 && entry.owner === 'none') {
      throw new Error(`No pinned-source parameter disables ArduPilot's ${entry.source}`);
    }
    if (entry.owner === 'none') {
      if (entry.delivery.length > 0) throw new Error(`Nobody applies ${entry.source}, so it has no delivery`);
      continue;
    }
    const required = source.deliveries.filter(d => DELIVERY_PATHS[d].path === path);
    if (required.length === 0) throw new Error(`No repository-evidenced path carries ${entry.source} on the ${path} path`);
    if (entry.delivery.length !== required.length || !required.every(d => entry.delivery.includes(d))) {
      throw new Error(`MirageSITL-owned ${entry.source} must use exactly ${required.join(', ')}`);
    }
    for (const d of required) {
      const key = DELIVERY_PATHS[d].jsonKey;
      if (key !== null && (!JSON_ORACLE_KEYS.some(k => k === key) || !catalog.jsonKeys.has(key))) {
        throw new Error(`JSON key ${key} is not covered by the oracle and the catalog`);
      }
    }
  }
  entries.sort((a, b) => ERROR_SOURCE_IDS.indexOf(a.source) - ERROR_SOURCE_IDS.indexOf(b.source));
  return Object.freeze({ schemaVersion: 1, id, path, entries: Object.freeze(entries.map(entry => Object.freeze(entry))) });
}

/**
 * Deterministic `.parm` text that disables ArduPilot's version of every error
 * MirageSITL owns or that nobody applies, plus the enablers of each delivery
 * path. ArduPilot-owned errors keep the firmware's own parameters untouched.
 * Vector parameters expand to _X, _Y and _Z. Lines are sorted by name.
 */
export function ownershipParameterProfile(input: unknown, catalog: ArduPilotCatalog): string {
  const matrix = validateOwnershipMatrix(input, catalog), values = new Map<string, number>();
  const set = (name: string, value: number): void => {
    const prior = values.get(name);
    if (prior !== undefined && prior !== value) throw new Error(`Conflicting values for ${name}`);
    values.set(name, value);
  };
  for (const entry of matrix.entries) {
    const source = ERROR_SOURCES[entry.source];
    if (entry.owner !== 'ardupilot' && source.ardupilotPaths.includes(matrix.path)) {
      for (const [name, value] of source.neutralize) {
        // Validation established that every name is cataloged.
        if (catalog.parameters.get(name)?.vector) for (const axis of ['X', 'Y', 'Z']) set(`${name}_${axis}`, value);
        else set(name, value);
      }
    }
    if (entry.owner === 'mirage') for (const d of entry.delivery) for (const [name, value] of DELIVERY_PATHS[d].enablers) set(name, value);
  }
  const lines = [`# MirageSITL error-ownership profile v${OWNERSHIP_PROFILE_VERSION}`,
    `# matrix ${matrix.id}; path ${matrix.path}; ArduPilot ${catalog.commit}`];
  for (const name of [...values.keys()].sort()) lines.push(`${name} ${String(values.get(name))}`);
  return lines.join('\n') + '\n';
}
