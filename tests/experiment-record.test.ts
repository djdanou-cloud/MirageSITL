// TASK-154, TASK-155, TASK-163: experiment payload schema 3 (launcher-owned and
// external SITLs, and the run's recording), schema 1 and 2 records read as
// schema 3, and the record in the project store.
// Oracles: the launcher's own start-request limits (parseExperimentSpec), the
// TASK-128 frame catalog through frameConfiguration, the pinned ArduPilot
// catalog through sensorRuntime, a sensor snapshot recomputed independently
// from the stored profile version, the store's fixed experiment inputs and
// its archive round trip, and MAX_RECORD_BYTES for the worst Phase 1 case.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseFlightTask } from '@mirage/scenarios/flight-tasks';
import { describe, expect, test } from 'vitest';
import { parseCatalog } from '../apps/launcher/src/catalog.ts';
import { parseExperimentSpec } from '../apps/launcher/src/server.ts';
import { parseArduPilotCatalog, PINNED_ARDUPILOT_COMMIT } from '../packages/autopilot/src/error-ownership.ts';
import { validateComponentCard, type ComponentCard } from '../packages/aircraft/src/components.ts';
import { deriveVehicleManifest } from '../packages/aircraft/src/derive-manifest.ts';
import {
  experimentChanges,
  createExperimentRecord, experimentRecordName, migrateExperiment, readExperiment, validateExperiment, type ExperimentParameter, type ExperimentPayload,
  type ExperimentPayloadV1, type ExperimentPayloadV2, type ExperimentPayloadV3, type ExperimentPayloadV4, type ExternalSitl, type LauncherSitl,
} from '../packages/aircraft/src/experiment.ts';
import { siteParameters } from '@mirage/aircraft/site-parameters';
import { externalDependencies, lineageFor, trajectoryDifference } from '../apps/web/src/experiments/lifecycle.ts';
import { frameConfiguration } from '../packages/aircraft/src/frame-parameters.ts';
import { resolveComponents } from '../packages/aircraft/src/resolve-components.ts';
import {
  profileDraft, sensorConfigurationOf, validateAircraftProfile, withSensorConfiguration, type AircraftProfile,
} from '../packages/aircraft/src/profile.ts';
import { validateSensorConfiguration } from '../packages/aircraft/src/sensor-config.ts';
import { DEFAULT_SENSOR_CONFIGURATION, SENSOR_FIELDS, type SensorConfiguration } from '../packages/aircraft/src/sensor-fields.ts';
import { sensorSnapshot } from '../packages/aircraft/src/sensor-ownership.ts';
import { sensorRuntime, STOCK_COMPASS_OFFSETS_MILLIGAUSS } from '../packages/aircraft/src/sensor-parameters.ts';
import { applySensorPreset } from '../packages/aircraft/src/sensor-presets.ts';
import { MAX_NAME_CODE_POINTS, MAX_RECORD_BYTES, ProjectStoreError, canonicalBytes, type StoredVersion } from '../packages/project/src/schema.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';
import { exampleCard, quadProfile, type ExampleCardAddresses } from './support/quad-profile.ts';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const catalog = parseArduPilotCatalog(json('./fixtures/sitl/ardupilot-catalog.json'));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const VALIDATORS = { 'component-card': validateComponentCard, 'aircraft-profile': validateAircraftProfile, 'experiment': validateExperiment };
/** A launcher experiment ID: 17 digits of UTC start time, '-' and 8 hexadecimal digits (apps/launcher/src/server.ts). */
const EXPERIMENT_ID = '20261101120000000-0a1b2c3d';
/** The build the launcher reported; the hashes stand for an installed binary and its copter.parm. */
const FIRMWARE = {
  catalogId: 'arducopter-8ab6afd', firmwareVersion: 'ArduCopter V4.8.0-dev', commit: PINNED_ARDUPILOT_COMMIT,
  binarySha256: hash('arducopter binary'), defaultParametersSha256: hash('copter.parm'),
};
const HOME = [-35.363261, 149.16523, 584, 0] as const;
const CONTEXT = { homeAltitudeM: HOME[2], compassOffsetsMilliGauss: STOCK_COMPASS_OFFSETS_MILLIGAUSS, cgBodyM: [0, 0, 0] as const };
const PWM: readonly ExperimentParameter[] = [{ name: 'MOT_PWM_MIN', value: 1000, source: 'pwm' }, { name: 'MOT_PWM_MAX', value: 2000, source: 'pwm' }];

function newStore(): ProjectStore {
  return new ProjectStore(new MemoryBackend(), { storage: null, validators: VALIDATORS });
}
/** The entry at `index`; a fixture payload that lacks it fails the test here instead of through a non-null assertion. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index < 0 ? items.length + index : index];
  if (item === undefined) throw new Error(`The fixture has no entry ${index}`);
  return item;
}
/** A schema 5 payload; the fixtures never build schema 1 to 4 through this. */
function current(payload: ExperimentPayload | ExperimentPayloadV4 | ExperimentPayloadV3 | ExperimentPayloadV2 | ExperimentPayloadV1): ExperimentPayload {
  if (payload.schemaVersion !== 5) throw new Error('The fixture is not schema 5');
  return payload;
}
/** The launcher-owned SITL of a fixture payload, or of its mutable copy. */
function ownedSitl(payload: ExperimentPayload): LauncherSitl {
  if (payload.sitl.ownership !== 'launcher') throw new Error('The fixture SITL is not launcher-owned');
  return payload.sitl;
}
function ownedEdit(payload: Mutable<ExperimentPayload>): Mutable<LauncherSitl> {
  if (payload.sitl.ownership !== 'launcher') throw new Error('The fixture SITL is not launcher-owned');
  return payload.sitl;
}
function configured<T>(configuration: T | null): T {
  if (configuration === null) throw new Error('The fixture has no sensor configuration');
  return configuration;
}
async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof ProjectStoreError) return error.code;
    throw error;
  }
  return 'resolved';
}

interface Fixture {
  readonly store: ProjectStore;
  readonly projectId: string;
  readonly profile: AircraftProfile;
  readonly stored: StoredVersion;
  readonly manifestSha256: string;
}
/** Stores the four example cards and a profile of `layout` on them, as the Run tab finds them. */
async function storedProfile(layout: string, name: string, sensors: SensorConfiguration | null): Promise<Fixture> {
  const store = newStore();
  const projectId = (await store.createProject('Runs')).record.id;
  const card = async (type: 'motor' | 'propeller' | 'esc' | 'battery') =>
    (await store.createItem(projectId, 'component-card', { name: `Example ${type}`, payload: exampleCard(type) })).sha256;
  const addresses: ExampleCardAddresses = { motor: await card('motor'), propeller: await card('propeller'), esc: await card('esc'), battery: await card('battery') };
  const { profile: base } = await quadProfile(addresses, layout);
  const profile = withSensorConfiguration(base, sensors);
  const stored = await store.createItem(projectId, 'aircraft-profile', profileDraft(name, profile));
  return { store, projectId, profile, stored, manifestSha256: await manifestOf(profile, addresses, 153) };
}
/** The addresses of the four example cards storedProfile stored, found by their record names. */
async function cardAddresses(fixture: Fixture): Promise<ExampleCardAddresses> {
  const cards = await fixture.store.listItems(fixture.projectId, 'component-card');
  const address = (type: string) => at(cards.filter(card => card.record.name === `Example ${type}`), 0).sha256;
  return { motor: address('motor'), propeller: address('propeller'), esc: address('esc'), battery: address('battery') };
}
/** The manifest the Worker loads: the profile with its sensors (the derivation hashes the whole profile) on the four example cards. */
async function manifestOf(profile: AircraftProfile, addresses: ExampleCardAddresses, modelId: number): Promise<string> {
  const cards = new Map<string, ComponentCard>([[addresses.motor, exampleCard('motor')], [addresses.propeller, exampleCard('propeller')],
    [addresses.esc, exampleCard('esc')], [addresses.battery, exampleCard('battery')]]);
  const resolved = resolveComponents(profile, cards);
  if (!resolved.components) throw new Error(`Missing: ${resolved.missing.join('; ')}`);
  return (await deriveVehicleManifest(profile, resolved.components, { modelId })).sha256;
}

/** Every generated parameter in the order the Run tab POSTs it: frame and outputs, the PWM range, then the SIM_* sensor parameters. */
function payloadOf(fixture: Fixture, stored = fixture.stored, profile = fixture.profile): ExperimentPayload {
  const frame = frameConfiguration(profile, stored.sha256);
  if (!frame.ok) throw new Error(frame.reasons.map(reason => reason.message).join(' '));
  const runtime = sensorRuntime(sensorConfigurationOf(profile), catalog, CONTEXT);
  const parameters: ExperimentParameter[] = [
    ...frame.parameters.map((p): ExperimentParameter => ({ ...p, source: /^SERVO[0-9]+_FUNCTION$/.test(p.name) ? 'output' : 'frame' })),
    ...PWM, ...runtime.parameters.map((p): ExperimentParameter => ({ ...p, source: 'sensor' })),
  ];
  return current(validateExperiment({
    schemaVersion: 5,
    profile: { sha256: stored.sha256, id: stored.record.id, version: stored.record.version, name: stored.record.name },
    sitl: { ownership: 'launcher', experimentId: EXPERIMENT_ID, ardupilot: FIRMWARE },
    session: { physicsHz: 800, clockMode: 'sitl-lockstep', speedup: 4, home: HOME, modelId: 153, manifestSha256: fixture.manifestSha256,
      betModuleSha256: hash('mirage_bet.wasm') },
    parameters, frameScript: frame.script, sensors: sensorSnapshot(stored), recording: RECORDING, lineage: { kind: 'original' }, flightTask: null,
  }));
}
function edit(payload: ExperimentPayload, change: (copy: Mutable<ExperimentPayload>) => void): unknown {
  // structuredClone keeps the shape; the cast only removes readonly from the copy.
  const copy = structuredClone(payload) as Mutable<ExperimentPayload>;
  change(copy);
  return copy;
}
/** The Logging tab's defaults (A-09) with one override, as a run records them (TASK-163). */
const RECORDING = { recordId: 'a'.repeat(32), commonHz: 50, groups: { motors: 400 }, signals: { 'truth.position': 800 }, durationMin: 60, reserveMb: 500 };
const ICM_42688: SensorConfiguration = validateSensorConfiguration(applySensorPreset(DEFAULT_SENSOR_CONFIGURATION, { catalogVersion: 1, id: 'imu-icm-42688-p' }).configuration);

describe('experiment payload schema 5', () => {
  test('the payload of an S19 quad X run validates, and its parameters are a start request the launcher accepts', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', null);
    const payload = payloadOf(fixture);
    expect(Object.isFrozen(payload) && Object.isFrozen(payload.sensors.resolution.fields[0])).toBe(true);
    expect(payload.frameScript).toBeNull();
    expect(payload.parameters.slice(0, 3).map(p => [p.name, p.source])).toEqual([['FRAME_CLASS', 'frame'], ['FRAME_TYPE', 'frame'], ['SERVO_32_ENABLE', 'frame']]);
    expect(payload.parameters.filter(p => p.source === 'output').map(p => p.name)).toEqual(Array.from({ length: 16 }, (_, i) => `SERVO${i + 1}_FUNCTION`));
    // The ArduPilot defaults write no sensor parameter.
    expect(payload.parameters.filter(p => p.source === 'sensor')).toEqual([]);
    expect(payload.sensors).toMatchObject({ schemaVersion: 2, profileSha256: fixture.stored.sha256, configuration: null, resolution: { state: 'ardupilot-defaults' } });
    // The same values, without source tags, pass the launcher's own request validator.
    const spec = parseExperimentSpec({ firmwareId: ownedSitl(payload).ardupilot.catalogId, parameters: payload.parameters.map(({ name, value }) => ({ name, value })),
      frameScript: payload.frameScript, speedup: payload.session.speedup, rateHz: payload.session.physicsHz, home: payload.session.home });
    expect(spec.parameters.map(p => p.name)).toEqual(payload.parameters.map(p => p.name));
  });

  test('refuses payloads outside schema 5 with a reason', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const payload = payloadOf(fixture);
    expect(payload.parameters.filter(p => p.source === 'sensor').length).toBeGreaterThan(0);
    const other = hash('another profile version');
    const pwmAt = payload.parameters.findIndex(p => p.source === 'pwm');
    const ardupilotEntry = payload.sensors.ownershipMatrix.entries.findIndex(e => e.owner !== 'mirage');
    expect([pwmAt > 0, ardupilotEntry >= 0, payload.sensors.residuals.length > 0, payload.sensors.presets.length > 0]).toEqual([true, true, true, true]);
    const cases: [string, unknown, string][] = [
      ['an extra key', edit(payload, p => { Object.assign(p.session, { rateHz: 800 }); }), 'session has an unexpected field rateHz'],
      ['an extra top-level key', edit(payload, p => { Object.assign(p, { outcome: 'landed' }); }), 'the payload has an unexpected field outcome'],
      ['a missing key', edit(payload, p => { Reflect.deleteProperty(ownedEdit(p).ardupilot, 'binarySha256'); }), 'ardupilot lacks binarySha256'],
      ['a duplicate parameter name', edit(payload, p => { p.parameters.push({ name: 'FRAME_TYPE', value: 1, source: 'frame' }); }), 'parameter FRAME_TYPE is listed twice'],
      ['a non-SIM sensor name', edit(payload, p => { p.parameters.push({ name: 'INS_GYROFFS_X', value: 0, source: 'sensor' }); }), 'sensor parameter INS_GYROFFS_X is not a SIM_ parameter'],
      ['a 17-character name', edit(payload, p => { p.parameters.push({ name: 'SIM_ACC1_RND_XYZW', value: 0, source: 'sensor' }); }), `parameter ${payload.parameters.length + 1} name must be an ArduPilot parameter name of at most 16 characters`],
      ['a NaN value', edit(payload, p => { at(p.parameters, 0).value = Number.NaN; }), 'parameter FRAME_CLASS must be a number from -3.4e+38 to 3.4e+38'],
      ['an infinite value', edit(payload, p => { at(p.parameters, 1).value = Number.POSITIVE_INFINITY; }), 'parameter FRAME_TYPE must be a number from'],
      ['a value beyond float32', edit(payload, p => { at(p.parameters, 1).value = 3.5e38; }), 'parameter FRAME_TYPE must be a number from'],
      ['an output tagged frame', edit(payload, p => { at(p.parameters, 4).source = 'frame'; }), 'frame parameter SERVO2_FUNCTION is not a TASK-128 frame parameter'],
      ['a frame name tagged output', edit(payload, p => { at(p.parameters, 0).source = 'output'; }), 'output parameter FRAME_CLASS is not a TASK-128 output parameter'],
      ['an unknown output', edit(payload, p => { p.parameters.push({ name: 'SERVO33_FUNCTION', value: 0, source: 'output' }); }), 'output parameter SERVO33_FUNCTION is not a TASK-128 output parameter'],
      ['another PWM name', edit(payload, p => { p.parameters.push({ name: 'MOT_SPIN_MIN', value: 0.15, source: 'pwm' }); }), 'pwm parameter MOT_SPIN_MIN is not MOT_PWM_MIN or MOT_PWM_MAX'],
      ['an unknown source tag', edit(payload, p => { Object.assign(at(p.parameters, 0), { source: 'user' }); }), 'parameter FRAME_CLASS source must be one of frame, output, pwm, sensor, set, site'],
      ['a parameter set naming what the profile sets', edit(payload, p => { p.parameters.push({ name: 'SCR_ENABLE', value: 1, source: 'set' }); }), 'set parameter SCR_ENABLE is set by the aircraft profile or the run'],
      ['a parameter set naming the home\'s declination', edit(payload, p => { p.parameters.push({ name: 'COMPASS_DEC', value: 0.1, source: 'set' }); }), 'set parameter COMPASS_DEC is set by the aircraft profile or the run'],
      ['a parameter set after the site parameters', edit(payload, p => { p.parameters.push({ name: 'COMPASS_DEC', value: 0.1, source: 'site' }, { name: 'ATC_ANG_RLL_P', value: 4, source: 'set' }); }), 'set parameter ATC_ANG_RLL_P follows the site parameters'],
      ['another name as a site parameter', edit(payload, p => { p.parameters.push({ name: 'COMPASS_OFS_X', value: 0, source: 'site' }); }), 'site parameter COMPASS_OFS_X is not COMPASS_DEC'],
      ['a site parameter before the PWM pair', edit(payload, p => { p.parameters.unshift({ name: 'COMPASS_DEC', value: 0.2, source: 'site' }); }), 'follows the site parameters'],
      ['a frame script without SCR_ENABLE', edit(payload, p => { p.frameScript = 'MotorsMatrix:init(4)\n'; }), 'a frame script needs frame parameter SCR_ENABLE 1'],
      ['a non-ASCII frame script', edit(payload, p => { p.frameScript = 'gcs:send_text(6, "é")\n'; }), 'frameScript must be null or printable ASCII Lua'],
      ['a mismatched profileSha256', edit(payload, p => { p.sensors.profileSha256 = other; }), 'sensors.profileSha256 must equal profile.sha256'],
      ['snapshot schema 1', edit(payload, p => { Object.assign(p.sensors, { schemaVersion: 1 }); }), 'sensors must be a sensor snapshot of schema 2, not schema 1'],
      ['snapshot schema 3', edit(payload, p => { Object.assign(p.sensors, { schemaVersion: 3 }); }), 'sensors must be a sensor snapshot of schema 2, not schema 3'],
      ['an invalid configuration', edit(payload, p => { Object.assign(configured(p.sensors.configuration).imu, { accelNoiseDensityMps2PerSqrtHz: -1 }); }), 'sensors.configuration: Invalid sensor configuration'],
      ['a resolution of another state', edit(payload, p => { p.sensors.resolution.state = 'ideal'; }), 'sensors.resolution.state ideal does not match the configuration'],
      ['a matrix entry out of order', edit(payload, p => { p.sensors.ownershipMatrix.entries.reverse(); }), 'sensors.ownershipMatrix.entries[0].source must be imu.accel.noise-floor'],
      ['an uncited preset', edit(payload, p => { p.sensors.presets.pop(); }), 'sensors.presets must cite exactly the presets the configuration references'],
      ['400 Hz physics', edit(payload, p => { Object.assign(p.session, { physicsHz: 400 }); }), 'session.physicsHz must be one of 800, 1200'],
      ['a speedup below the launcher limit', edit(payload, p => { p.session.speedup = 0.05; }), 'session.speedup must be a number from 0.1 to 100'],
      ['a home heading beyond 360', edit(payload, p => { p.session.home[3] = 361; }), 'home heading must be a number from 0 to 360'],
      ['a launcher ID of another format', edit(payload, p => { ownedEdit(p).experimentId = 'run-1'; }), 'sitl.experimentId must be a launcher experiment ID'],
      ['a short commit', edit(payload, p => { ownedEdit(p).ardupilot.commit = '8ab6afd'; }), 'ardupilot.commit must be a 40-digit lowercase commit'],
      ['another experiment schema', edit(payload, p => { Object.assign(p, { schemaVersion: 6 }); }), 'unsupported experiment schema 6'],
      ['an empty firmware version', edit(payload, p => { ownedEdit(p).ardupilot.firmwareVersion = ''; }), 'ardupilot.firmwareVersion must be non-empty text'],
      ['another SITL ownership', edit(payload, p => { Object.assign(p.sitl, { ownership: 'user' }); }), 'sitl.ownership must be launcher or external'],
      ['schema 1 fields in schema 3', edit(payload, p => { Object.assign(p, { launcher: { experimentId: EXPERIMENT_ID } }); }), 'the payload has an unexpected field launcher'],
      ['no recording field', edit(payload, p => { Reflect.deleteProperty(p, 'recording'); }), 'the payload lacks recording'],
      ['a recording ID that is not one', edit(payload, p => { Object.assign(p, { recording: { ...RECORDING, recordId: 'A'.repeat(32) } }); }), 'recording.recordId must be 32 lowercase hexadecimal digits'],
      ['a rate above 2 kHz', edit(payload, p => { Object.assign(p, { recording: { ...RECORDING, groups: { motors: 2001 } } }); }), 'recording.groups.motors must be an integer from 0 to 2000'],
      ['a fractional rate', edit(payload, p => { Object.assign(p, { recording: { ...RECORDING, commonHz: 2.5 } }); }), 'recording.commonHz must be an integer from 0 to 2000'],
      ['a name that is no catalog name', edit(payload, p => { Object.assign(p, { recording: { ...RECORDING, signals: { 'truth position': 1 } } }); }), 'recording.signals names must be catalog names'],
      ['a negative reserve', edit(payload, p => { Object.assign(p, { recording: { ...RECORDING, reserveMb: -1 } }); }), 'recording.reserveMb must be a number from 0 to'],
      ['a recording field it does not know', edit(payload, p => { Object.assign(p, { recording: { ...RECORDING, quotaMb: 1 } }); }), 'recording has an unexpected field quotaMb'],
      ['a launcher SITL without a speedup', edit(payload, p => { p.session.speedup = null; }), 'session.speedup must be a number from 0.1 to 100'],
      ['a padded profile name', edit(payload, p => { p.profile.name = ' S19 quad X'; }), 'profile.name must be a stored record name (NFC, without leading or trailing white space)'],
      ['a non-NFC profile name', edit(payload, p => { p.profile.name = 'Cafe\u0301 quad'; }), 'profile.name must be a stored record name (NFC, without leading or trailing white space)'],
      ['model ID 0', edit(payload, p => { p.session.modelId = 0; }), 'session.modelId must be an integer from 1 to 4294967295'],
      ['a model ID beyond 32 bits', edit(payload, p => { p.session.modelId = 2 ** 32; }), 'session.modelId must be an integer from 1 to 4294967295'],
      ['a home latitude beyond 90', edit(payload, p => { p.session.home[0] = 90.5; }), 'home latitude must be a number from -90 to 90'],
      ['a home longitude beyond -180', edit(payload, p => { p.session.home[1] = -180.5; }), 'home longitude must be a number from -180 to 180'],
      ['SCR_ENABLE 1 without a frame script', edit(payload, p => { p.parameters.splice(3, 0, { name: 'SCR_ENABLE', value: 1, source: 'frame' }); }),
        'frame parameter SCR_ENABLE 1 needs a frame script'],
      ['an empty frame script', edit(payload, p => { p.parameters.splice(3, 0, { name: 'SCR_ENABLE', value: 1, source: 'frame' }); p.frameScript = ''; }),
        'frameScript must be null or printable ASCII Lua of 1 to 65536 bytes'],
      ['a frame parameter after the outputs', edit(payload, p => { p.parameters.splice(pwmAt - 1, 0, ...p.parameters.splice(0, 1)); }),
        'frame parameter FRAME_CLASS follows the output parameters; the order is frame, output, pwm, sensor'],
      ['a PWM parameter after the sensor parameters', edit(payload, p => { p.parameters.push(...p.parameters.splice(pwmAt, 1)); }),
        'pwm parameter MOT_PWM_MIN follows the sensor parameters'],
      ['no PWM range', edit(payload, p => { p.parameters.splice(pwmAt, 2); }), 'parameters must give MOT_PWM_MIN then MOT_PWM_MAX'],
      ['the PWM pair reversed', edit(payload, p => { p.parameters.splice(pwmAt, 0, ...p.parameters.splice(pwmAt + 1, 1)); }), 'parameters must give MOT_PWM_MIN then MOT_PWM_MAX'],
      ['an empty PWM range', edit(payload, p => { at(p.parameters, pwmAt).value = 2000; }), 'MOT_PWM_MIN must be below MOT_PWM_MAX'],
      ['a resolution field out of order', edit(payload, p => { p.sensors.resolution.fields.splice(0, 2, at(p.sensors.resolution.fields, 1), at(p.sensors.resolution.fields, 0)); }),
        `sensors.resolution.fields[0].path must be ${at(SENSOR_FIELDS, 0).path}, in sensor field order`],
      ['a residual listed twice', edit(payload, p => { p.sensors.resolution.residuals.push(at(p.sensors.resolution.residuals, 0)); }),
        'sensors.resolution.residuals lists a residual twice'],
      ['a residual of another ID', edit(payload, p => { Object.assign(at(p.sensors.residuals, 0), { id: 'imu-unknown' }); }),
        'sensors.residuals[0].id must be'],
      // Only one firmware patch exists, so a repeated patch exceeds the list bound before the repetition check.
      ['a firmware patch listed twice', edit(payload, p => { p.sensors.ownershipMatrix.firmwarePatches = ['imu-noise-floor', 'imu-noise-floor']; }),
        'sensors.ownershipMatrix.firmwarePatches may have at most 1 entries'],
      ['a delivery path of an ArduPilot-owned source', edit(payload, p => { at(p.sensors.ownershipMatrix.entries, ardupilotEntry).delivery = ['json:imu.gyro']; }),
        `sensors.ownershipMatrix.entries[${ardupilotEntry}]: only a MirageSITL-owned source has a delivery path`],
      ['a citation of another kind', edit(payload, p => { Object.assign(at(at(p.sensors.presets, 0).citations, 0), { kind: 'blog' }); }),
        'sensors.presets[0].citations[0].kind must be one of specification, ardupilot-source'],
      ['a citation with an extra field', edit(payload, p => { Object.assign(at(at(p.sensors.presets, 0).citations, 0), { doi: null }); }),
        'sensors.presets[0].citations[0] has an unexpected field doi'],
    ];
    for (const [label, input, message] of cases) expect(() => validateExperiment(input), label).toThrow(message);
    expect(() => validateExperiment(edit(payload, () => undefined))).not.toThrow();
    // The store applies the validator to every write.
    const write = () => fixture.store.createItem(fixture.projectId, 'experiment',
      { name: 'Bad run', payload: edit(payload, p => { p.sensors.profileSha256 = other; }), dependencies: [fixture.stored.sha256] });
    expect(await codeOf(write)).toBe('invalid');
    await expect(write()).rejects.toThrow('The experiment payload is invalid: Invalid experiment: sensors.profileSha256 must equal profile.sha256');
  });

  test('admits exactly the firmware versions the launcher catalog admits', async () => {
    const payload = payloadOf(await storedProfile('quad-x', 'S19 quad X', null));
    const entry = { id: FIRMWARE.catalogId, commit: FIRMWARE.commit, binaryPath: '/opt/mirage/arducopter', binarySha256: FIRMWARE.binarySha256,
      defaultParametersPath: '/opt/mirage/copter.parm', defaultParametersSha256: FIRMWARE.defaultParametersSha256 };
    const admitted = (action: () => unknown): boolean => {
      try {
        action();
        return true;
      } catch {
        return false;
      }
    };
    const versions = [FIRMWARE.firmwareVersion, 'V'.repeat(129), 'ArduCopter\u0007V4.8.0', 'ArduCopter\nV4.8.0', ''];
    const verdicts = versions.map(firmwareVersion => [
      admitted(() => parseCatalog({ schemaVersion: 1, firmware: [{ ...entry, firmwareVersion }] })),
      admitted(() => validateExperiment(edit(payload, p => { ownedEdit(p).ardupilot.firmwareVersion = firmwareVersion; }))),
    ]);
    expect(verdicts).toEqual([[true, true], [true, true], [true, true], [true, true], [false, false]]);
  });

  test('a record name keeps the launcher experiment ID within the store limit', () => {
    expect(experimentRecordName('S19 quad X', EXPERIMENT_ID)).toBe(`S19 quad X run ${EXPERIMENT_ID}`);
    // Code points, not UTF-16 units: each astral character counts once.
    const long = experimentRecordName('\u{1F681}'.repeat(MAX_NAME_CODE_POINTS), EXPERIMENT_ID);
    expect([...long]).toHaveLength(MAX_NAME_CODE_POINTS);
    expect(long.endsWith(` run ${EXPERIMENT_ID}`)).toBe(true);
  });
});

describe('the experiment record', () => {
  test('is stored with the profile version as its only dependency and the snapshot recomputed from it', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const payload = payloadOf(fixture);
    const name = experimentRecordName(fixture.stored.record.name, EXPERIMENT_ID);
    const record = await createExperimentRecord(fixture.store, fixture.projectId, { name, payload });
    expect(record.record).toMatchObject({ kind: 'experiment', version: 1, name, dependencies: [{ kind: 'aircraft-profile', sha256: fixture.stored.sha256 }] });
    const kept = await fixture.store.get(record.sha256);
    // Independent oracle: a snapshot recomputed from the dependency the store returns.
    const dependency = kept.record.dependencies[0]?.sha256 ?? '';
    expect(Buffer.from(canonicalBytes(Reflect.get(kept.record.payload, 'sensors'))).equals(Buffer.from(canonicalBytes(sensorSnapshot(await fixture.store.get(dependency)))))).toBe(true);
    expect(Buffer.from(canonicalBytes(kept.record.payload)).equals(Buffer.from(canonicalBytes(payload)))).toBe(true);
    expect(readExperiment(kept)).toEqual(payload);
    expect(ownedSitl(readExperiment(kept)).ardupilot).toEqual(FIRMWARE);

    // A snapshot that is well formed but not the stored version's is refused, and so is a profile named by another version.
    const tampered = edit(payload, p => { at(p.sensors.residuals, 0).text = 'ArduPilot adds no noise.'; });
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name, payload: tampered }))
      .rejects.toThrow('sensors must be the sensor snapshot of the stored profile version');
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name, payload: edit(payload, p => { p.profile.version = 2; }) }))
      .rejects.toThrow('profile must give the id, version and name of stored version');
    const card = at(await fixture.store.listItems(fixture.projectId, 'component-card'), 0);
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name, payload: edit(payload, p => {
      p.profile.sha256 = card.sha256; p.sensors.profileSha256 = card.sha256;
    }) })).rejects.toThrow('is not an aircraft profile of this project');

    // Well-formed frame, output and manifest inputs that the stored version does not generate are refused too.
    const frameMessage = 'the frame and output parameters must be the ones frameConfiguration generates for the stored profile version, in its order';
    const manifestMessage = 'session.manifestSha256 must be the manifest derived from the stored profile version with session.modelId';
    const generated: [string, unknown, string][] = [
      ['another frame type', edit(payload, p => { at(p.parameters, 1).value = 3; }), frameMessage],
      ['a dropped frame parameter', edit(payload, p => { p.parameters.splice(2, 1); }), frameMessage],
      ['a motor on another output', edit(payload, p => { at(p.parameters, 3).value = 0; }), frameMessage],
      ['another manifest', edit(payload, p => { p.session.manifestSha256 = hash('another manifest'); }), manifestMessage],
      ['another model ID', edit(payload, p => { p.session.modelId = 154; }), manifestMessage],
    ];
    for (const [label, changed, message] of generated) {
      await expect(createExperimentRecord(fixture.store, fixture.projectId, { name, payload: changed }), label).rejects.toThrow(message);
    }
    // The manifest of the profile without its sensor configuration is another manifest: the derivation hashes the whole profile.
    const withoutSensors = await manifestOf(withSensorConfiguration(fixture.profile, null), await cardAddresses(fixture), 153);
    expect(withoutSensors).not.toBe(payload.session.manifestSha256);
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name, payload: edit(payload, p => { p.session.manifestSha256 = withoutSensors; }) }))
      .rejects.toThrow(manifestMessage);
  });

  test('refuses a stored record whose dependency is not the profile version it names', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', null);
    const payload = payloadOf(fixture);
    const v2 = await fixture.store.saveVersion(fixture.stored.record.id, fixture.stored.sha256,
      profileDraft('S19 quad X', withSensorConfiguration(fixture.profile, ICM_42688)));
    const card = at(await fixture.store.listItems(fixture.projectId, 'component-card'), 0);
    for (const dependencies of [[v2.sha256], [fixture.stored.sha256, card.sha256], []]) {
      // The validator sees only the payload, so the store accepts these; reading refuses them.
      const wrong = await fixture.store.createItem(fixture.projectId, 'experiment', { name: 'Wrong dependency', payload, dependencies });
      expect(() => readExperiment(wrong)).toThrow(`must depend on exactly the aircraft profile version ${fixture.stored.sha256}`);
    }
    expect(() => readExperiment(v2)).toThrow('is of kind aircraft-profile, not an experiment');
  });

  test('a later profile version leaves the record unchanged, and its inputs are fixed', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const payload = payloadOf(fixture);
    const record = await createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 1', payload });
    const ideal = validateSensorConfiguration({ ...ICM_42688, mode: 'ideal' });
    const v2 = await fixture.store.saveVersion(fixture.stored.record.id, fixture.stored.sha256,
      profileDraft('S19 quad X', withSensorConfiguration(fixture.profile, ideal)));
    expect(v2.record.version).toBe(2);
    const kept = await fixture.store.get(record.sha256);
    expect(Buffer.from(kept.bytes).equals(Buffer.from(record.bytes))).toBe(true);
    expect(readExperiment(kept).sensors).toMatchObject({ profileSha256: fixture.stored.sha256, resolution: { state: 'specified' } });
    expect(await fixture.store.history(record.record.id)).toHaveLength(1);

    const changes: [string, unknown, readonly string[]][] = [
      ['the speedup', edit(payload, p => { p.session.speedup = 2; }), [fixture.stored.sha256]],
      ['a parameter', edit(payload, p => { at(p.parameters, -1).value += 1; }), [fixture.stored.sha256]],
      ['the profile version', payloadOf(fixture, v2, withSensorConfiguration(fixture.profile, ideal)), [v2.sha256]],
    ];
    for (const [label, changed, dependencies] of changes) {
      await expect(fixture.store.saveVersion(record.record.id, record.sha256, { name: 'Run 1', payload: changed, dependencies }), label)
        .rejects.toThrow('Experiment inputs are fixed');
    }
    // Renaming is the only edit.
    const renamed = await fixture.store.saveVersion(record.record.id, record.sha256, { name: 'Hover run', payload, dependencies: [fixture.stored.sha256] });
    expect([renamed.record.version, readExperiment(renamed)]).toEqual([2, payload]);
  });

  test('round-trips through a project archive into a store that validates experiments', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const record = await createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 1', payload: payloadOf(fixture) });
    const exported = await fixture.store.exportProject(fixture.projectId);
    expect(exported.missing).toEqual([]);
    const target = newStore();
    const report = await target.importArchive(exported.archive);
    expect(report.items.map(item => [item.kind, item.status])).toEqual([['project', 'new'], ['component-card', 'new'], ['component-card', 'new'],
      ['component-card', 'new'], ['component-card', 'new'], ['aircraft-profile', 'new'], ['experiment', 'new']]);
    expect(report.missing).toEqual([]);
    const imported = await target.get(record.sha256);
    expect(Buffer.from(imported.bytes).equals(Buffer.from(record.bytes))).toBe(true);
    expect(readExperiment(imported)).toEqual(readExperiment(record));

    // An experiment written before the validator existed is refused on import.
    const legacy = new ProjectStore(new MemoryBackend(), { storage: null });
    const project = await legacy.createProject('Legacy');
    await legacy.createItem(project.record.id, 'experiment', { name: 'Hover', payload: { task: 'hover', durationS: 60 } });
    const refused = (await legacy.exportProject(project.record.id)).archive;
    await expect(newStore().importArchive(refused)).rejects.toThrow('The experiment payload is invalid: Invalid experiment: unsupported experiment schema undefined');
  });

  test('the worst Phase 1 case, the S19 octa-coaxial-16 with its scripting-matrix Lua, Ideal sensors and every preset cited, stays below 1 MiB', async ({ annotate }) => {
    let presets = DEFAULT_SENSOR_CONFIGURATION;
    for (const id of ['imu-icm-42688-p', 'gnss-neo-m9n', 'baro-ms5611', 'mag-rm3100', 'battery-ina226']) {
      presets = applySensorPreset(presets, { catalogVersion: 1, id }).configuration;
    }
    const ideal = validateSensorConfiguration({ ...presets, mode: 'ideal' });
    const fixture = await storedProfile('octa-coaxial-16', 'S19 octa coaxial 16', ideal);
    const payload = payloadOf(fixture);
    expect(payload.frameScript).toContain('MotorsMatrix:add_motor_raw(15,');
    expect(payload.parameters.filter(p => p.source === 'output')).toHaveLength(32);
    expect(payload.parameters.filter(p => p.source === 'sensor')).toHaveLength(168);
    expect(payload.sensors.presets.map(p => p.sensor)).toEqual(['imu', 'gnss', 'barometer', 'magnetometer', 'battery']);
    expect(payload.sensors.presets.every(p => p.citations.length > 0)).toBe(true);
    const name = experimentRecordName('S19 octa coaxial 16', EXPERIMENT_ID);
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name, payload: edit(payload, p => { p.frameScript += '-- edited\n'; }) }))
      .rejects.toThrow('frameScript must be the script frameConfiguration generates for the stored profile version');
    const record = await createExperimentRecord(fixture.store, fixture.projectId, { name, payload });
    const bytes = record.bytes.byteLength;
    const report = `Worst-case experiment record: ${bytes} canonical bytes of ${MAX_RECORD_BYTES} (${payload.parameters.length} parameters, ` +
      `frame script ${payload.frameScript?.length ?? 0} bytes)`;
    await annotate(report);
    console.info(report);
    expect(bytes).toBe((await fixture.store.get(record.sha256)).bytes.byteLength);
    expect(bytes).toBeGreaterThan(payload.frameScript?.length ?? 0);
    expect(bytes).toBeLessThan(MAX_RECORD_BYTES);
  });
});

describe('schema 1 records and external SITLs (TASK-155)', () => {
  /** The TASK-154 form of a launcher-owned payload. */
  function schema1Of(payload: ExperimentPayload): unknown {
    const { profile, session, parameters, frameScript, sensors } = payload, sitl = ownedSitl(payload);
    return structuredClone({ schemaVersion: 1, profile, ardupilot: sitl.ardupilot, launcher: { experimentId: sitl.experimentId }, session, parameters, frameScript, sensors });
  }
  const EXTERNAL = {
    ownership: 'external', connectionId: EXPERIMENT_ID,
    ardupilot: { commit: PINNED_ARDUPILOT_COMMIT, gitHash: PINNED_ARDUPILOT_COMMIT.slice(0, 8), firmwareVersion: '4.8.0-dev' },
    endpoints: { jsonPhysicsPort: 9002, mavlink: { transport: 'tcp', port: 5760 } },
  } as const;
  function externalOf(payload: ExperimentPayload): unknown {
    return edit(payload, p => { Object.assign(p, { sitl: structuredClone(EXTERNAL) }); p.session.speedup = null; });
  }

  test('a TASK-154 schema 1 record still validates and reads as schema 5 without a recording, and new records are schema 5', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const payload = payloadOf(fixture);
    const v1 = schema1Of(payload);
    expect(validateExperiment(v1)).toMatchObject({ schemaVersion: 1, launcher: { experimentId: EXPERIMENT_ID }, ardupilot: FIRMWARE });
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 1', payload: v1 }))
      .rejects.toThrow('new experiments are schema 5; schema 1 is only read');
    // Stored as TASK-154 stored it, it reads as the schema 4 payload of the same original run, which recorded nothing.
    const stored = await fixture.store.createItem(fixture.projectId, 'experiment', { name: 'Run 1', payload: v1, dependencies: [fixture.stored.sha256] });
    expect(readExperiment(stored)).toEqual({ ...payload, recording: null });
    expect(Reflect.get(stored.record.payload, 'schemaVersion')).toBe(1);
    // Schema 1 keeps its own rules: no sitl field, and a speedup.
    expect(() => validateExperiment(edit(payload, p => { Object.assign(p, { schemaVersion: 1 }); }))).toThrow('the payload lacks ardupilot');
  });

  test('a TASK-155 schema 2 record still validates and reads as schema 5 without a recording', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const payload = payloadOf(fixture);
    const v2 = edit(payload, p => { Object.assign(p, { schemaVersion: 2 }); Reflect.deleteProperty(p, 'recording'); Reflect.deleteProperty(p, 'lineage'); Reflect.deleteProperty(p, 'flightTask'); });
    expect(validateExperiment(v2)).toMatchObject({ schemaVersion: 2, sitl: payload.sitl });
    expect(Object.hasOwn(validateExperiment(v2), 'recording')).toBe(false);
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 2', payload: v2 }))
      .rejects.toThrow('new experiments are schema 5; schema 2 is only read');
    const stored = await fixture.store.createItem(fixture.projectId, 'experiment', { name: 'Run 2', payload: v2, dependencies: [fixture.stored.sha256] });
    expect(readExperiment(stored)).toEqual({ ...payload, recording: null });
    // Schema 2 has no recording field.
    expect(() => validateExperiment(edit(payload, p => { Object.assign(p, { schemaVersion: 2 }); Reflect.deleteProperty(p, 'lineage'); Reflect.deleteProperty(p, 'flightTask'); })))
      .toThrow('the payload has an unexpected field recording');
    // A schema 4 run that recorded nothing says so.
    expect(current(validateExperiment(edit(payload, p => { Object.assign(p, { recording: null }); }))).recording).toBeNull();
    expect(payload.recording).toEqual(RECORDING);
  });

  test('a TASK-163 schema 3 record still validates and reads as a schema 5 original run (TASK-165)', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const payload = payloadOf(fixture);
    const v3 = edit(payload, p => { Object.assign(p, { schemaVersion: 3 }); Reflect.deleteProperty(p, 'lineage'); Reflect.deleteProperty(p, 'flightTask'); });
    expect(validateExperiment(v3)).toMatchObject({ schemaVersion: 3, recording: RECORDING });
    expect(Object.hasOwn(validateExperiment(v3), 'lineage')).toBe(false);
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 3', payload: v3 }))
      .rejects.toThrow('new experiments are schema 5; schema 3 is only read');
    const stored = await fixture.store.createItem(fixture.projectId, 'experiment', { name: 'Run 3', payload: v3, dependencies: [fixture.stored.sha256] });
    expect(readExperiment(stored)).toEqual(payload);
    expect(() => validateExperiment(edit(payload, p => { Object.assign(p, { schemaVersion: 3 }); Reflect.deleteProperty(p, 'flightTask'); }))).toThrow('the payload has an unexpected field lineage');
  });

  test('an external SITL payload validates and is stored, and its own rules refuse what MirageSITL cannot know or did not do', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const payload = payloadOf(fixture);
    const external = current(validateExperiment(externalOf(payload)));
    expect(external.sitl).toEqual(EXTERNAL);
    expect(external.session.speedup).toBeNull();
    const name = experimentRecordName(fixture.stored.record.name, EXPERIMENT_ID, 'external');
    expect(name).toBe(`S19 quad X connection ${EXPERIMENT_ID}`);
    const record = await createExperimentRecord(fixture.store, fixture.projectId, { name, payload: external });
    expect(readExperiment(await fixture.store.get(record.sha256))).toEqual(external);

    const variant = (change: (sitl: Mutable<ExternalSitl>, copy: Mutable<ExperimentPayload>) => void): unknown =>
      edit(external, copy => {
        if (copy.sitl.ownership !== 'external') throw new Error('The fixture SITL is not external');
        change(copy.sitl, copy);
      });
    const cases: [string, unknown, string][] = [
      ['a speedup', variant((_, p) => { p.session.speedup = 4; }), 'session.speedup must be null for an external SITL'],
      ['a git hash of another commit', variant(sitl => { sitl.ardupilot.gitHash = '0123abcd'; }),
        'sitl.ardupilot.gitHash must be the first 8 characters of sitl.ardupilot.commit'],
      ['a git hash of another form', variant(sitl => { sitl.ardupilot.gitHash = '8AB6AFDE'; }),
        'sitl.ardupilot.gitHash must be 8 lowercase hexadecimal digits'],
      ['a binary hash MirageSITL never read', variant(sitl => { Object.assign(sitl.ardupilot, { binarySha256: hash('binary') }); }),
        'sitl.ardupilot has an unexpected field binarySha256'],
      ['a launcher experiment', variant(sitl => { Object.assign(sitl, { experimentId: EXPERIMENT_ID }); }), 'sitl has an unexpected field experimentId'],
      ['a connection ID of another format', variant(sitl => { sitl.connectionId = 'connection-1'; }), 'sitl.connectionId must be a launcher connection ID'],
      ['a serial MAVLink transport', variant(sitl => { Object.assign(sitl.endpoints.mavlink, { transport: 'serial' }); }),
        'sitl.endpoints.mavlink.transport must be one of tcp, udp'],
      ['one UDP port for both', variant(sitl => { sitl.endpoints.jsonPhysicsPort = 14550; sitl.endpoints.mavlink = { transport: 'udp', port: 14550 }; }),
        'sitl.endpoints must use two different UDP ports'],
      ['port 0', variant(sitl => { sitl.endpoints.jsonPhysicsPort = 0; }), 'sitl.endpoints.jsonPhysicsPort must be an integer from 1 to 65535'],
    ];
    for (const [label, input, message] of cases) expect(() => validateExperiment(input), label).toThrow(message);

    // A frame that needs a MirageSITL frame script cannot have been flown by an external SITL.
    const octa = await storedProfile('octa-coaxial-16', 'S19 octa coaxial 16', null);
    const scripted = payloadOf(octa);
    expect(scripted.frameScript).not.toBeNull();
    expect(() => validateExperiment(externalOf(scripted))).toThrow('an external SITL has no frame script');
  });
});

// ---- TASK-165: lineage, Repeat and Create variant ---------------------------------------------------

describe('a parameter set as initial parameters (TASK-176)', () => {
  test('is an input of its own: two runs of different sets differ in that and nothing else', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', null);
    const payload = payloadOf(fixture);
    const withSet = (value: number) => current(validateExperiment(edit(payload, p => { p.parameters.push({ name: 'ATC_ANG_RLL_P', value, source: 'set' }); })));
    expect(withSet(4).parameters.at(-1)).toEqual({ name: 'ATC_ANG_RLL_P', value: 4, source: 'set' });
    expect(experimentChanges(withSet(4), withSet(5))).toEqual(['initial parameters']);
    expect(experimentChanges(payload, withSet(4))).toEqual(['initial parameters']);
    expect(experimentChanges(withSet(4), withSet(4))).toEqual([]);
  });
});

describe('what a run\'s home gives ArduPilot (TASK-172)', () => {
  const withSite = (payload: ExperimentPayload, value: number) => current(validateExperiment(edit(payload, p => { p.parameters.push({ name: 'COMPASS_DEC', value, source: 'site' }); })));
  const declination = siteParameters(HOME)[0]?.value ?? Number.NaN;

  test('the record holds the value of its home, and refuses another', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688), { store, projectId } = fixture, payload = payloadOf(fixture);
    const created = await createExperimentRecord(store, projectId, { name: 'Run', payload: withSite(payload, declination) });
    expect(readExperiment(created).parameters.at(-1)).toEqual({ name: 'COMPASS_DEC', value: declination, source: 'site' });
    await expect(createExperimentRecord(store, projectId, { name: 'Run', payload: withSite(payload, 0) })).rejects.toThrow('COMPASS_DEC must be the value session.home gives');
    // A connection's SITL was already running, so its record holds none.
    await expect(createExperimentRecord(store, projectId, { name: 'Run', payload })).resolves.toBeDefined();
  });

  test('it counts as the home, so a record from before it can still be repeated, and a new home is one change', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688), { store, projectId } = fixture, payload = payloadOf(fixture);
    const parent = await createExperimentRecord(store, projectId, { name: 'Parent', payload });
    const child = edit(withSite(readExperiment(parent), declination), p => { Object.assign(p, { lineage: { kind: 'repeat', of: parent.sha256 } }); });
    await expect(createExperimentRecord(store, projectId, { name: 'Repeat', payload: child })).resolves.toBeDefined();
    const elsewhere: readonly [number, number, number, number] = [47.397742, 8.545594, 488, 0];
    const moved = edit(withSite(readExperiment(parent), siteParameters(elsewhere)[0]?.value ?? Number.NaN), p => { Object.assign(p.session, { home: elsewhere }); });
    expect(experimentChanges(readExperiment(parent), current(validateExperiment(moved)))).toEqual(['home']);
  });
});

describe('the flight task of an experiment (TASK-172)', () => {
  const definition = (altitudeM = 5) => parseFlightTask({ schemaVersion: 1, type: 'hover', parameters: { altitudeM, durationS: 10 }, route: null,
    initial: { ground: { northM: 10, eastM: -5, headingDeg: 90, stateOfCharge: 0.8 }, air: null }, finish: 'land' });
  const withTask = (payload: ExperimentPayload, task: unknown) => edit(payload, p => { Object.assign(p, { flightTask: task }); });

  test('a schema 4 record still validates and reads as schema 5 without a task', async () => {
    const payload = payloadOf(await storedProfile('quad-x', 'S19 quad X', ICM_42688));
    const v4 = edit(payload, p => { Object.assign(p, { schemaVersion: 4 }); Reflect.deleteProperty(p, 'flightTask'); });
    const read = validateExperiment(v4);
    expect(read).toMatchObject({ schemaVersion: 4, lineage: { kind: 'original' } });
    expect(Object.hasOwn(read, 'flightTask')).toBe(false);
    expect(migrateExperiment(read)).toMatchObject({ schemaVersion: 5, flightTask: null, recording: RECORDING });
    expect(() => validateExperiment(edit(payload, p => { Object.assign(p, { schemaVersion: 4 }); }))).toThrow('the payload has an unexpected field flightTask');
    expect(() => validateExperiment(edit(payload, p => { Reflect.deleteProperty(p, 'flightTask'); }))).toThrow('the payload lacks');
  });

  test('stores the stored version it names, byte for byte, and refuses any other', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688), { store, projectId } = fixture, payload = payloadOf(fixture);
    const task = await store.createItem(projectId, 'flight-task', { name: 'Hover 5', payload: definition() });
    const entry = { recordSha256: task.sha256, name: 'Hover 5', definition: definition() };
    const created = await createExperimentRecord(store, projectId, { name: 'Run', payload: withTask(payload, entry) });
    expect(readExperiment(created).flightTask).toEqual(entry);
    // The dependency stays the profile version alone: the definition travels inside the record.
    expect(created.record.dependencies.map(dependency => dependency.kind)).toEqual(['aircraft-profile']);
    await expect(createExperimentRecord(store, projectId, { name: 'Run', payload: withTask(payload, { ...entry, definition: definition(6) }) }))
      .rejects.toThrow('flightTask.definition must be the definition of stored version');
    await expect(createExperimentRecord(store, projectId, { name: 'Run', payload: withTask(payload, { ...entry, name: 'Other' }) }))
      .rejects.toThrow('flightTask.name must be the name of stored version');
    await expect(createExperimentRecord(store, projectId, { name: 'Run', payload: withTask(payload, { ...entry, recordSha256: payload.profile.sha256 }) }))
      .rejects.toThrow('is not a flight task of this project');
    expect(() => validateExperiment(withTask(payload, { ...entry, definition: { ...definition(), type: 'somersault' } }))).toThrow('The task type must be one of');
  });

  test('the flight task is an input: a repeat keeps it and a variant lists its change', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688), { store, projectId } = fixture, payload = payloadOf(fixture);
    const task = await store.createItem(projectId, 'flight-task', { name: 'Hover', payload: definition() });
    const other = await store.createItem(projectId, 'flight-task', { name: 'Higher', payload: definition(8) });
    const entry = { recordSha256: task.sha256, name: 'Hover', definition: definition() };
    const parent = await createExperimentRecord(store, projectId, { name: 'Parent', payload: withTask(payload, entry) });
    const parentPayload = readExperiment(parent);
    const child = (flightTask: unknown, lineage: unknown) => edit(parentPayload, p => { Object.assign(p, { flightTask, lineage }); });
    await expect(createExperimentRecord(store, projectId, { name: 'Repeat', payload: child(entry, { kind: 'repeat', of: parent.sha256 }) })).resolves.toBeDefined();
    const changed = { recordSha256: other.sha256, name: 'Higher', definition: definition(8) };
    await expect(createExperimentRecord(store, projectId, { name: 'False repeat', payload: child(changed, { kind: 'repeat', of: parent.sha256 }) }))
      .rejects.toThrow('these differ: flight task');
    const variant = await createExperimentRecord(store, projectId, { name: 'Variant', payload: child(changed, { kind: 'variant', of: parent.sha256, changes: ['flight task'] }) });
    expect(readExperiment(variant).lineage).toMatchObject({ kind: 'variant', changes: ['flight task'] });
    // A run without a task is a variant of one with it.
    expect(experimentChanges(parentPayload, current(validateExperiment(withTask(parentPayload, null))))).toEqual(['flight task']);
  });

  test('a project archive keeps a flight task, and the store refuses an invalid one', async () => {
    const validated = new ProjectStore(new MemoryBackend(), { validators: { 'flight-task': parseFlightTask } });
    const { record: { id: projectId } } = await validated.createProject('Tasks');
    await expect(validated.createItem(projectId, 'flight-task', { name: 'Bad', payload: { ...definition(), finish: 'somersault' } })).rejects.toThrow('finish by land or hold');
    const stored = await validated.createItem(projectId, 'flight-task', { name: 'Hover', payload: definition() });
    expect((await validated.listItems(projectId, 'flight-task')).map(item => item.sha256)).toEqual([stored.sha256]);
    const { archive } = await validated.exportProject(projectId);
    const other = new ProjectStore(new MemoryBackend(), { validators: { 'flight-task': parseFlightTask } });
    await other.importArchive(archive);
    expect((await other.get(stored.sha256)).record.payload).toEqual(definition());
  });
});

describe('experiment lineage (TASK-165)', () => {
  /** A repeat of `parent`: the same inputs, another launcher experiment, another recording. */
  function rerun(parent: ExperimentPayload, lineage: unknown, change: (copy: Mutable<ExperimentPayload>) => void = () => undefined): unknown {
    return edit(parent, p => {
      ownedEdit(p).experimentId = '20261103120000000-0e0f0a0b';
      if (p.recording) p.recording.recordId = 'b'.repeat(32);
      p.session.betModuleSha256 = hash('another build of mirage_bet.wasm');
      Object.assign(p, { lineage });
      change(p);
    });
  }

  test('names the inputs a run changed, and leaves the run\'s own identity out', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const parent = payloadOf(fixture);
    const same = current(validateExperiment(rerun(parent, { kind: 'original' })));
    expect(experimentChanges(parent, same)).toEqual([]);
    const changed = current(validateExperiment(rerun(parent, { kind: 'original' }, p => {
      p.session.speedup = 1;
      p.session.home = [-35.36, 149.16, 600, 0];
      if (p.recording) p.recording.commonHz = 100;
      ownedEdit(p).ardupilot.binarySha256 = hash('another binary');
    })));
    expect(experimentChanges(parent, changed)).toEqual(['ArduPilot build', 'speed', 'home', 'recording setup']);
    expect(lineageFor(null, same)).toEqual({ kind: 'original' });
    const plan = (kind: 'repeat' | 'variant') => ({ kind, parentSha256: 'c'.repeat(64), parentName: 'Run 1', parent });
    expect(lineageFor(plan('repeat'), same)).toEqual({ kind: 'repeat', of: 'c'.repeat(64) });
    // A variant that changed nothing is a repeat.
    expect(lineageFor(plan('variant'), same)).toEqual({ kind: 'repeat', of: 'c'.repeat(64) });
    expect(lineageFor(plan('variant'), changed)).toEqual({ kind: 'variant', of: 'c'.repeat(64), changes: ['ArduPilot build', 'speed', 'home', 'recording setup'] });
    // The validator refuses an empty or disordered list.
    expect(() => validateExperiment(rerun(parent, { kind: 'variant', of: 'c'.repeat(64), changes: [] }))).toThrow('one that changes none is a repeat');
    expect(() => validateExperiment(rerun(parent, { kind: 'variant', of: 'c'.repeat(64), changes: ['speed', 'ArduPilot build'] }))).toThrow('must follow the order');
    expect(() => validateExperiment(rerun(parent, { kind: 'copy' }))).toThrow('lineage.kind must be original, repeat or variant');
  });

  test('stores a repeat and a variant that name their parent, refuses false claims, and leaves the parent unchanged', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const parent = payloadOf(fixture);
    const first = await createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 1', payload: parent });
    const repeat = await createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 2', payload: rerun(parent, { kind: 'repeat', of: first.sha256 }) });
    expect(readExperiment(repeat).lineage).toEqual({ kind: 'repeat', of: first.sha256 });
    await expect(createExperimentRecord(fixture.store, fixture.projectId,
      { name: 'Run 3', payload: rerun(parent, { kind: 'repeat', of: first.sha256 }, p => { p.session.speedup = 1; }) }))
      .rejects.toThrow("a repeat keeps its parent's inputs, but these differ: speed");
    await expect(createExperimentRecord(fixture.store, fixture.projectId,
      { name: 'Run 3', payload: rerun(parent, { kind: 'variant', of: first.sha256, changes: ['home'] }, p => { p.session.speedup = 1; }) }))
      .rejects.toThrow('a variant must list the inputs it changed: speed');
    const variant = await createExperimentRecord(fixture.store, fixture.projectId,
      { name: 'Run 3', payload: rerun(parent, { kind: 'variant', of: first.sha256, changes: ['speed'] }, p => { p.session.speedup = 1; }) });
    expect(readExperiment(variant).lineage).toEqual({ kind: 'variant', of: first.sha256, changes: ['speed'] });
    // The parent must be an experiment of this project.
    await expect(createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 4', payload: rerun(parent, { kind: 'repeat', of: fixture.stored.sha256 }) }))
      .rejects.toThrow('is not an experiment of this project');
    // The parent is untouched: still one version, the same bytes.
    expect((await fixture.store.history(first.record.id)).map(v => v.sha256)).toEqual([first.sha256]);
  });

  test('an exported experiment carries its profile and cards, imports into an empty store, and lists what the archive cannot hold', async () => {
    const fixture = await storedProfile('quad-x', 'S19 quad X', ICM_42688);
    const parent = payloadOf(fixture);
    const first = await createExperimentRecord(fixture.store, fixture.projectId, { name: 'Run 1', payload: parent });
    const exported = await fixture.store.exportItems(fixture.projectId, [first.sha256]);
    expect(exported.missing).toEqual([]);
    const fresh = new ProjectStore(new MemoryBackend(), { validators: VALIDATORS });
    const report = await fresh.importArchive(exported.archive);
    expect(report.missing).toEqual([]);
    expect(report.items.map(item => item.kind).sort()).toEqual(['aircraft-profile', 'component-card', 'component-card', 'component-card', 'component-card',
      'experiment', 'project']);
    expect(readExperiment(await fresh.get(first.sha256))).toEqual(parent);
    expect(externalDependencies(parent).map(d => d.what)).toEqual([
      `ArduPilot build ${FIRMWARE.catalogId} (${FIRMWARE.firmwareVersion}, commit ${FIRMWARE.commit}, binary ${FIRMWARE.binarySha256})`, `Recording ${'a'.repeat(32)}`]);
  });

  test('the trajectory difference is computed at common ticks only, and says where positions first differ', () => {
    const row = (tick: number, n: number, e: number, d: number) => ({ tick, simTimeS: tick / 800, northM: n, eastM: e, downM: d });
    expect(trajectoryDifference([row(16, 0, 0, -1), row(32, 1, 1, -2)], [row(16, 0, 0, -1), row(32, 1, 1, -2), row(48, 9, 9, 9)]))
      .toEqual({ comparedTicks: 2, maxHorizontalM: 0, maxVerticalM: 0, atSimTimeS: null, firstDifferentTick: null });
    const d = trajectoryDifference([row(16, 0, 0, -1), row(32, 3, 4, -2), row(40, 0, 0, 0)], [row(16, 0, 0, -1), row(32, 0, 0, -2.5)]);
    expect(d).toEqual({ comparedTicks: 2, maxHorizontalM: 5, maxVerticalM: 0.5, atSimTimeS: 32 / 800, firstDifferentTick: 32 });
  });
});
