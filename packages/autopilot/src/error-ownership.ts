// Sensor-error ownership (TASK-089). Decides, per error source, whether
// ArduPilot's SITL sensor backends or MirageSITL apply the error, and which
// repository-evidenced path carries an error that MirageSITL applies. Upstream
// firmware is the default; a matrix opts into a MirageSITL firmware patch
// (native/ardupilot/patches/) only to switch off an error that the pinned
// upstream applies unconditionally. Configuration-time only.

/** ArduPilot commit pinned in native/ardupilot/source.lock.json. */
export const PINNED_ARDUPILOT_COMMIT = '8ab6afde107a91df1b5f60ade8f333cb8a61b190';
export const OWNERSHIP_PROFILE_VERSION = 1;
/** JSON state keys covered by the TASK-041 oracle and its TASK-147 battery line (tests/fixtures/sitl/json-protocol.json). */
export const JSON_ORACLE_KEYS = ['timestamp', 'imu.gyro', 'imu.accel_body', 'position', 'velocity', 'quaternion', 'velocity_wind',
  'battery.voltage', 'battery.current'] as const;

export type AutopilotPath = 'native-json' | 'browser-hal';
export type ErrorOwner = 'ardupilot' | 'mirage' | 'none';
type Setting = readonly [name: string, value: number];

/** MirageSITL firmware patches over the pinned commit, with the paths whose builds apply them. */
export const FIRMWARE_PATCHES = {
  // scripts/build-ardupilot-sitl.mjs applies it; the browser HAL build does not yet.
  'imu-noise-floor': { paths: ['native-json'] },
} as const satisfies Record<string, { readonly paths: readonly AutopilotPath[] }>;
export type FirmwarePatchId = keyof typeof FIRMWARE_PATCHES;

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
  'json:battery.voltage': { path: 'native-json', evidence: 'TASK-147 JSON state line battery section', jsonKey: 'battery.voltage', enablers: [] },
  'json:battery.current': { path: 'native-json', evidence: 'TASK-147 JSON state line battery section', jsonKey: 'battery.current', enablers: [] },
} as const satisfies Record<string, DeliveryDefinition>;
export type DeliveryPath = keyof typeof DELIVERY_PATHS;

/** The 25 sources of matrix schemas 1 and 2. */
export const ERROR_SOURCE_IDS_V1 = ['imu.accel.noise-floor', 'imu.gyro.noise-floor', 'imu.accel.noise', 'imu.gyro.noise',
  'imu.accel.bias', 'imu.gyro.bias', 'imu.accel.scale', 'imu.gyro.scale', 'imu.gyro.drift', 'imu.vibration',
  'imu.lever-arm', 'imu.board-trim', 'baro.noise', 'baro.drift', 'baro.glitch', 'baro.delay', 'baro.wind',
  'baro.ground-effect', 'mag.noise', 'mag.hard-iron', 'mag.soft-iron', 'mag.delay', 'mag.anomaly', 'mag.motor',
  'gnss.receiver'] as const;
/** Every source; schema 3 (TASK-147) adds the last eight, which a schema 1 or 2 matrix reads as their stock owner. */
export const ERROR_SOURCE_IDS = [...ERROR_SOURCE_IDS_V1, 'imu.latency', 'imu.misalignment', 'mag.misalignment',
  'gnss.position-noise', 'gnss.velocity-noise', 'gnss.delay', 'battery.voltage', 'battery.current'] as const;
export type ErrorSourceId = typeof ERROR_SOURCE_IDS[number];
export const OWNERSHIP_MATRIX_SCHEMA_VERSION = 3;
/** The sources each matrix schema lists. */
export function matrixSources(schemaVersion: 1 | 2 | 3): readonly ErrorSourceId[] {
  return schemaVersion === 3 ? ERROR_SOURCE_IDS : ERROR_SOURCE_IDS_V1;
}
export interface ErrorSourceDefinition {
  readonly sensor: 'imu' | 'baro' | 'mag' | 'gnss' | 'battery';
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
  /** For a `fixed` error: the firmware patch whose added parameters disable it, the values that do, and its facts. */
  readonly patch?: { readonly id: FirmwarePatchId; readonly neutralize: readonly Setting[]; readonly facts: readonly string[] };
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
const gpss = (suffix: string, value: number): Setting[] => [1, 2].map(i => [`SIM_GPS${i}_${suffix}`, value]);
const BATTERY_CHAIN = ['analog-average-is-latest'];

export const ERROR_SOURCES: { readonly [id in ErrorSourceId]: ErrorSourceDefinition } = {
  // Upstream constants; the imu-noise-floor patch turns them into SIM_ACC_FLOOR and SIM_GYR_FLOOR with the same defaults.
  'imu.accel.noise-floor': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [], fixed: true,
    facts: ['ins-accel-noise-floor', 'ins-accel-noise-floor-applied'], deliveries: ACCEL,
    patch: { id: 'imu-noise-floor', neutralize: [['SIM_ACC_FLOOR', 0]], facts: ['patch-ins-accel-noise-floor'] } },
  // Without motor noise or vibration ArduPilot adds the gyro floor a second time.
  'imu.gyro.noise-floor': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [], fixed: true,
    facts: ['ins-gyro-noise-floor', 'ins-gyro-noise-floor-applied', 'ins-gyro-background-noise'], deliveries: GYRO,
    patch: { id: 'imu-noise-floor', neutralize: [['SIM_GYR_FLOOR', 0]], facts: ['patch-ins-gyro-noise-floor'] } },
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
  // Schema 3 (TASK-147). ArduPilot has no IMU delay, so only MirageSITL or nobody applies one.
  'imu.latency': { sensor: 'imu', ardupilotPaths: [], neutralize: [], fixed: false, facts: [], deliveries: [...ACCEL, ...GYRO] },
  // SIM_IMU_ORIENT takes ArduPilot's discrete rotations; 0 is none.
  'imu.misalignment': { sensor: 'imu', ardupilotPaths: BOTH, neutralize: [['SIM_IMU_ORIENT', 0]], fixed: false,
    facts: ['ins-imu-orient-accel', 'ins-imu-orient-gyro'], deliveries: [...ACCEL, ...GYRO] },
  'mag.misalignment': { sensor: 'mag', ardupilotPaths: BOTH, neutralize: mags('ORIENT', 0), fixed: false, facts: ['compass-orient'], deliveries: MAG },
  // The SITL receiver's position error is a deterministic wander: a circle and a vertical sine with a 12.6 s period.
  'gnss.position-noise': { sensor: 'gnss', ardupilotPaths: BOTH, neutralize: [...gpss('HNSE', 0), ...gpss('NOISE', 0)], fixed: false,
    facts: ['sim-gps-enabled', 'gps-wander-period', 'gps-horizontal-wander', 'gps-vertical-wander'], deliveries: [] },
  'gnss.velocity-noise': { sensor: 'gnss', ardupilotPaths: BOTH, neutralize: gpss('VERR', 0), fixed: false,
    facts: ['sim-gps-enabled', 'gps-velocity-error', 'rand-float-uniform'], deliveries: [] },
  'gnss.delay': { sensor: 'gnss', ardupilotPaths: BOTH, neutralize: gpss('LAG_MS', 0), fixed: false, facts: ['sim-gps-enabled', 'gps-lag'], deliveries: [] },
  // The SITL analog chain divides and multiplies by the same scale, so ArduPilot adds no measurement error.
  'battery.voltage': { sensor: 'battery', ardupilotPaths: [], neutralize: [], fixed: false,
    facts: ['json-battery-voltage', 'analog-voltage-pin', 'battery-voltage-scale', 'battery-analog-voltage', ...BATTERY_CHAIN],
    deliveries: ['json:battery.voltage'] },
  'battery.current': { sensor: 'battery', ardupilotPaths: [], neutralize: [], fixed: false,
    facts: ['json-battery-current', 'analog-current-pin', 'battery-current-scale', 'battery-analog-current', ...BATTERY_CHAIN],
    deliveries: ['json:battery.current'] },
};
/** The GNSS sources of ArduPilot's SITL receiver, which does not run while GPS_INPUT replaces it. */
const RECEIVER_SOURCES: readonly ErrorSourceId[] = ['gnss.position-noise', 'gnss.velocity-noise', 'gnss.delay'];

/** The owner a schema 1 or 2 matrix implies for a source it does not list: ArduPilot where the firmware applies it, nobody otherwise. */
export function stockOwner(source: ErrorSourceId, path: AutopilotPath): ErrorOwner {
  return ERROR_SOURCES[source].ardupilotPaths.includes(path) ? 'ardupilot' : 'none';
}
/** A source's owner in a validated matrix of any schema. */
export function ownerOf(matrix: OwnershipMatrix, source: ErrorSourceId): ErrorOwner {
  return matrix.entries.find(entry => entry.source === source)?.owner ?? stockOwner(source, matrix.path);
}

export interface OwnershipEntry { readonly source: ErrorSourceId; readonly owner: ErrorOwner; readonly delivery: readonly DeliveryPath[] }
export interface OwnershipMatrix {
  readonly schemaVersion: 1 | 2 | 3; readonly id: string; readonly path: AutopilotPath;
  /** Firmware patches the target build applies; a schema 1 matrix targets upstream firmware. */
  readonly firmwarePatches: readonly FirmwarePatchId[];
  readonly entries: readonly OwnershipEntry[];
}
export interface CatalogParameter { readonly name: string; readonly vector: boolean; readonly default: string; readonly conditions: readonly string[] }
export interface CatalogPatch {
  readonly id: string; readonly path: string; readonly sha256: string;
  /** SIM_* parameters the patch adds, parsed from the patched pinned sources. */
  readonly parameters: ReadonlyMap<string, CatalogParameter>;
  /** Upstream facts that no longer hold once the patch is applied. */
  readonly removedFacts: ReadonlySet<string>;
  readonly facts: ReadonlySet<string>;
}
export interface ArduPilotCatalog {
  readonly commit: string;
  readonly parameters: ReadonlyMap<string, CatalogParameter>;
  readonly jsonKeys: ReadonlySet<string>;
  readonly facts: ReadonlySet<string>;
  readonly patches: ReadonlyMap<string, CatalogPatch>;
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
function isPatch(value: unknown): value is FirmwarePatchId { return typeof value === 'string' && Object.hasOwn(FIRMWARE_PATCHES, value); }
function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function catalogParameter(item: unknown): CatalogParameter {
  const p = exact(item, ['name', 'vector', 'default', 'source', 'conditions'], 'catalog parameter');
  const name = text(p.name, 'parameter name');
  if (!/^SIM_[A-Z0-9_]+$/.test(name) || typeof p.vector !== 'boolean') throw new Error(`Invalid catalog parameter ${name}`);
  const conditions = list(p.conditions, 'condition', 16).map(condition => text(condition, 'condition'));
  text(p.source, 'parameter source');
  return Object.freeze({ name, vector: p.vector, default: text(p.default, 'parameter default'), conditions: Object.freeze(conditions) });
}
function catalogFact(item: unknown): string {
  const fact = exact(item, ['id', 'path', 'text'], 'fact');
  text(fact.path, 'fact path'); text(fact.text, 'fact text');
  return text(fact.id, 'fact ID');
}

/** Validates the generated pinned-source catalog (tests/fixtures/sitl/ardupilot-catalog.json). */
export function parseArduPilotCatalog(input: unknown): ArduPilotCatalog {
  if (record(input) && input.schemaVersion === 1) throw new Error('Unsupported catalog schema 1; regenerate it with tests/fixtures/sitl/generate.py');
  const value = exact(input, ['schemaVersion', 'description', 'ardupilotCommit', 'upstream', 'simParameters', 'unresolvedSubgroups',
    'copterDefaults', 'jsonBackendDefaults', 'jsonKeys', 'facts', 'patches'], 'catalog');
  if (value.schemaVersion !== 2) throw new Error('Unsupported catalog schema');
  if (value.ardupilotCommit !== PINNED_ARDUPILOT_COMMIT) throw new Error('Catalog is not from the pinned ArduPilot commit');
  text(value.description, 'catalog description');
  const upstream = new Map<string, string>();
  for (const item of list(value.upstream, 'upstream', 64)) {
    const file = exact(item, ['path', 'sha256', 'bytes'], 'upstream file');
    if (!Number.isSafeInteger(file.bytes)) throw new Error('Invalid upstream file identity');
    upstream.set(text(file.path, 'upstream path'), sha256(file.sha256, 'upstream hash'));
  }
  const parameters = new Map<string, CatalogParameter>();
  for (const item of list(value.simParameters, 'parameter', 4096)) {
    const parameter = catalogParameter(item);
    if (parameters.has(parameter.name)) throw new Error(`Invalid catalog parameter ${parameter.name}`);
    parameters.set(parameter.name, parameter);
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
    const id = catalogFact(item);
    if (facts.has(id)) throw new Error(`Duplicate fact ${id}`);
    facts.add(id);
  }
  const patches = new Map<string, CatalogPatch>();
  for (const item of list(value.patches, 'patch', 16)) {
    const p = exact(item, ['id', 'path', 'sha256', 'files', 'addedParameters', 'removedFacts', 'facts'], 'catalog patch');
    const id = text(p.id, 'patch ID'), path = text(p.path, 'patch path');
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || patches.has(id) || !/^native\/ardupilot\/patches\/[a-z0-9-]+\.patch$/.test(path)) {
      throw new Error(`Invalid catalog patch ${id}`);
    }
    for (const entry of list(p.files, 'patched file', 64)) {
      const file = exact(entry, ['path', 'upstreamSha256', 'patchedSha256'], 'patched file');
      const name = text(file.path, 'patched file path');
      // A patch may only change cataloged upstream files, starting from their pinned bytes.
      if (upstream.get(name) !== sha256(file.upstreamSha256, 'upstream hash')) throw new Error(`Patch ${id} changes ${name}, which is not a cataloged upstream file`);
      sha256(file.patchedSha256, 'patched hash');
    }
    const added = new Map<string, CatalogParameter>();
    for (const entry of list(p.addedParameters, 'added parameter', 64)) {
      const parameter = catalogParameter(entry);
      if (parameters.has(parameter.name) || added.has(parameter.name)) throw new Error(`Patch ${id} redefines ${parameter.name}`);
      added.set(parameter.name, parameter);
    }
    const removedFacts = new Set<string>();
    for (const entry of list(p.removedFacts, 'removed fact', 64)) {
      const fact = text(entry, 'removed fact');
      if (!facts.has(fact)) throw new Error(`Patch ${id} removes unknown fact ${fact}`);
      removedFacts.add(fact);
    }
    const patchFacts = new Set<string>();
    for (const entry of list(p.facts, 'patch fact', 64)) {
      const fact = catalogFact(entry);
      if (facts.has(fact) || patchFacts.has(fact)) throw new Error(`Duplicate fact ${fact}`);
      patchFacts.add(fact);
    }
    patches.set(id, Object.freeze({ id, path, sha256: sha256(p.sha256, 'patch hash'), parameters: added, removedFacts, facts: patchFacts }));
  }
  for (const item of list(value.unresolvedSubgroups, 'subgroup', 256)) exact(item, ['prefix', 'class'], 'subgroup');
  for (const defaults of [value.copterDefaults, value.jsonBackendDefaults]) {
    if (!record(defaults) || !Object.values(defaults).every(v => typeof v === 'string')) throw new Error('Invalid catalog defaults');
  }
  return Object.freeze({ commit: PINNED_ARDUPILOT_COMMIT, parameters, jsonKeys, facts, patches });
}

/**
 * Rejects double or missing ownership, delivery paths without repository
 * evidence for the matrix path, parameters or facts absent from the
 * pinned-source catalog, and ownership that would need a firmware patch.
 */
export function validateOwnershipMatrix(input: unknown, catalog: ArduPilotCatalog): OwnershipMatrix {
  const version = record(input) ? input.schemaVersion : undefined;
  if (version !== 1 && version !== 2 && version !== 3) throw new Error('Unsupported ownership matrix schema');
  // Schema 2 adds the firmware patches of the target build; schema 1 targets upstream firmware; schema 3 adds sources.
  const value = exact(input, version === 1 ? ['schemaVersion', 'id', 'path', 'entries'] : ['schemaVersion', 'id', 'path', 'firmwarePatches', 'entries'],
    'ownership matrix');
  const id = text(value.id, 'matrix ID');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid matrix ID');
  const path = value.path;
  if (path !== 'native-json' && path !== 'browser-hal') throw new Error('Unknown autopilot path');
  const firmwarePatches: FirmwarePatchId[] = [];
  for (const item of version !== 1 ? list(value.firmwarePatches, 'firmware patch', 8) : []) {
    if (!isPatch(item) || firmwarePatches.includes(item)) throw new Error(`Unknown or repeated firmware patch ${String(item)}`);
    if (!catalog.patches.has(item)) throw new Error(`Firmware patch ${item} is not in the pinned-source catalog`);
    const paths: readonly AutopilotPath[] = FIRMWARE_PATCHES[item].paths;
    if (!paths.includes(path)) throw new Error(`No ${path} build applies the ${item} firmware patch`);
    firmwarePatches.push(item);
  }
  const sources = matrixSources(version), entries: OwnershipEntry[] = [];
  for (const item of list(value.entries, 'entry', sources.length)) {
    const entry = exact(item, ['source', 'owner', 'delivery'], 'ownership entry');
    if (!isSource(entry.source)) throw new Error('Unknown error source');
    if (!sources.includes(entry.source)) throw new Error(`Error source ${entry.source} needs ownership matrix schema 3`);
    if (entries.some(other => other.source === entry.source)) throw new Error(`Error source ${entry.source} has two owners`);
    const owner = entry.owner;
    if (owner !== 'ardupilot' && owner !== 'mirage' && owner !== 'none') throw new Error(`Unknown owner for ${entry.source}`);
    const delivery = list(entry.delivery, 'delivery', 8).map(d => {
      if (!isDelivery(d)) throw new Error(`Delivery path for ${String(entry.source)} has no repository evidence`);
      return d;
    });
    entries.push({ source: entry.source, owner, delivery });
  }
  for (const source of sources) if (!entries.some(entry => entry.source === source)) throw new Error(`Error source ${source} has no owner`);
  const admitted = (condition: string): boolean => condition === '#if AP_SIM_ENABLED' ||
    /^#if (INS_MAX_INSTANCES|HAL_COMPASS_MAX_SENSORS) > [1-9]$/.test(condition) ||
    // SIM_config.h defines AP_SIM_GPS_ENABLED as AP_SIM_ENABLED (fact sim-gps-enabled).
    (condition === '#if AP_SIM_GPS_ENABLED' && catalog.facts.has('sim-gps-enabled'));
  for (const entry of entries) {
    const source = ERROR_SOURCES[entry.source], appliedByArduPilot = source.ardupilotPaths.includes(path);
    for (const fact of source.facts) if (!catalog.facts.has(fact)) throw new Error(`Fact ${fact} for ${entry.source} is not in the catalog`);
    // A declared patch replaces the upstream neutralization of the source it covers.
    const patch = source.patch && firmwarePatches.includes(source.patch.id) ? source.patch : null;
    const patched = patch ? catalog.patches.get(patch.id) : undefined;
    for (const fact of patch?.facts ?? []) {
      if (!patched?.facts.has(fact)) throw new Error(`Fact ${fact} for ${entry.source} is not in the ${String(patch?.id)} patch catalog`);
    }
    const settings = patch ? patch.neutralize : source.neutralize;
    for (const [name] of settings) {
      const parameter = patch ? patched?.parameters.get(name) : catalog.parameters.get(name);
      if (!parameter) {
        throw new Error(patch ? `Parameter ${name} for ${entry.source} is not added by the ${patch.id} patch`
          : `Parameter ${name} for ${entry.source} is not in the pinned-source catalog`);
      }
      if (!parameter.conditions.every(admitted)) {
        throw new Error(`Parameter ${name} depends on an unverified build condition`);
      }
    }
    if (entry.owner === 'ardupilot') {
      if (!appliedByArduPilot) throw new Error(`ArduPilot does not apply ${entry.source} on the ${path} path`);
      if (entry.delivery.length > 0) throw new Error(`An ArduPilot-owned ${entry.source} has no MirageSITL delivery`);
      continue;
    }
    if (appliedByArduPilot && source.fixed && !patch) {
      throw new Error(source.patch
        ? `ArduPilot applies ${entry.source} unconditionally at the pinned commit; switching it off needs the ${source.patch.id} firmware patch in firmwarePatches`
        : `ArduPilot applies ${entry.source} unconditionally; changing its owner needs a native firmware patch (BLOCKED_DECISION)`);
    }
    if (appliedByArduPilot && settings.length === 0 && entry.owner === 'none') {
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
  // GPS_INPUT replaces ArduPilot's receiver, which then applies none of its own errors.
  const receiver = entries.find(entry => entry.source === 'gnss.receiver')?.owner;
  for (const entry of entries) {
    if (receiver === 'mirage' && RECEIVER_SOURCES.includes(entry.source) && entry.owner === 'ardupilot') {
      throw new Error(`ArduPilot's receiver does not run while MirageSITL owns gnss.receiver, so it cannot apply ${entry.source}`);
    }
  }
  entries.sort((a, b) => ERROR_SOURCE_IDS.indexOf(a.source) - ERROR_SOURCE_IDS.indexOf(b.source));
  return Object.freeze({ schemaVersion: version, id, path, firmwarePatches: Object.freeze(firmwarePatches),
    entries: Object.freeze(entries.map(entry => Object.freeze(entry))) });
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
    const patch = source.patch && matrix.firmwarePatches.includes(source.patch.id) ? source.patch : null;
    const parameters = patch ? catalog.patches.get(patch.id)?.parameters : catalog.parameters;
    if (entry.owner !== 'ardupilot' && source.ardupilotPaths.includes(matrix.path)) {
      for (const [name, value] of patch ? patch.neutralize : source.neutralize) {
        // Validation established that every name is cataloged.
        if (parameters?.get(name)?.vector) for (const axis of ['X', 'Y', 'Z']) set(`${name}_${axis}`, value);
        else set(name, value);
      }
    }
    if (entry.owner === 'mirage') for (const d of entry.delivery) for (const [name, value] of DELIVERY_PATHS[d].enablers) set(name, value);
  }
  // A profile that needs patched firmware names each patch and its hash; an upstream profile is unchanged.
  const patches = matrix.firmwarePatches.map(id => `${id} ${catalog.patches.get(id)?.sha256 ?? ''}`);
  const lines = [`# MirageSITL error-ownership profile v${OWNERSHIP_PROFILE_VERSION}`,
    `# matrix ${matrix.id}; path ${matrix.path}; ArduPilot ${catalog.commit}${patches.length > 0 ? `; patches ${patches.join(', ')}` : ''}`];
  for (const name of [...values.keys()].sort()) lines.push(`${name} ${String(values.get(name))}`);
  return lines.join('\n') + '\n';
}

/** Values of the IMU noise-floor setting (MIRAGE_SITL_IMU_NOISE_FLOOR); 'ardupilot' is the default. */
export const IMU_NOISE_FLOOR_SETTINGS = ['ardupilot', 'off'] as const;
export type ImuNoiseFloorSetting = typeof IMU_NOISE_FLOOR_SETTINGS[number];
export function isImuNoiseFloorSetting(value: unknown): value is ImuNoiseFloorSetting {
  return IMU_NOISE_FLOOR_SETTINGS.some(setting => setting === value);
}

/**
 * The IMU noise-floor setting as an ownership matrix. 'ardupilot' leaves every
 * error ArduPilot applies on the path with ArduPilot, so the firmware runs on
 * its own defaults; 'off' declares the imu-noise-floor patch and leaves both
 * floors to nobody. Validation rejects 'off' where no build applies the patch.
 */
export function imuNoiseFloorMatrix(setting: ImuNoiseFloorSetting, path: AutopilotPath): OwnershipMatrix {
  const off = setting === 'off';
  return {
    schemaVersion: 2, id: `imu-noise-floor-${setting}-${path}`, path, firmwarePatches: off ? ['imu-noise-floor'] : [],
    entries: ERROR_SOURCE_IDS_V1.map(source => ({ source, delivery: [],
      owner: off && ERROR_SOURCES[source].patch?.id === 'imu-noise-floor' ? 'none'
        : ERROR_SOURCES[source].ardupilotPaths.includes(path) ? 'ardupilot' : 'none' })),
  };
}
