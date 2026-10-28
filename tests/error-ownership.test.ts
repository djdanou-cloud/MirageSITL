import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DELIVERY_PATHS, ERROR_SOURCES, ERROR_SOURCE_IDS, FIRMWARE_PATCHES, IMU_NOISE_FLOOR_SETTINGS, JSON_ORACLE_KEYS, PINNED_ARDUPILOT_COMMIT,
  imuNoiseFloorMatrix, isImuNoiseFloorSetting, ownershipParameterProfile, parseArduPilotCatalog, validateOwnershipMatrix, type ErrorSourceId,
} from '@mirage/autopilot/error-ownership';
import catalogJson from './fixtures/sitl/ardupilot-catalog.json';
import ownership from './fixtures/sitl/error-ownership.json';
import protocol from './fixtures/sitl/json-protocol.json';
import lock from '../native/ardupilot/source.lock.json';

const catalog = parseArduPilotCatalog(catalogJson);
const [parityNative, parityBrowser, ewNative] = ownership.matrices;
if (!parityNative || !parityBrowser || !ewNative) throw new Error('Ownership fixture needs three matrices');
type Matrix = typeof parityNative;
/** A copy of a matrix with one source's owner and delivery replaced. */
function own(matrix: Matrix, source: ErrorSourceId, owner: string, delivery: string[] = []): Matrix {
  return { ...matrix, entries: matrix.entries.map(entry => (entry.source === source ? { source, owner, delivery } : entry)) };
}
const settings = (profile: string) => profile.split('\n').filter(line => line !== '' && !line.startsWith('#'));
/** Every parameter line a source's neutralization expands to. */
function expanded(source: ErrorSourceId): string[] {
  return ERROR_SOURCES[source].neutralize.flatMap(([name, value]) => (catalog.parameters.get(name)?.vector
    ? ['X', 'Y', 'Z'].map(axis => `${name}_${axis} ${value}`) : [`${name} ${value}`]));
}

describe('pinned ArduPilot source catalog', () => {
  it('comes from the commit pinned in source.lock.json', () => {
    expect(lock.commit).toBe(PINNED_ARDUPILOT_COMMIT);
    expect(catalogJson.ardupilotCommit).toBe(lock.commit);
    expect(catalogJson.upstream.length).toBe(13);
    expect(() => parseArduPilotCatalog({ ...catalogJson, ardupilotCommit: 'f'.repeat(40) })).toThrow('pinned');
    expect(() => parseArduPilotCatalog({ ...catalogJson, extra: 1 })).toThrow('fields');
    // Schema 1 had no patch section; it must be regenerated, not reinterpreted.
    const schema1: Record<string, unknown> = { ...catalogJson, schemaVersion: 1 };
    delete schema1.patches;
    expect(() => parseArduPilotCatalog(schema1)).toThrow('regenerate');
  });

  it('records compiled and copter defaults and vector parameters as the pinned source defines them', () => {
    const p = (name: string) => catalog.parameters.get(name);
    expect(p('SIM_DRIFT_SPEED')?.default).toBe('0.05f');
    expect(p('SIM_BARO_RND')?.default).toBe('0.2f');
    // The copter defaults file turns barometer noise off; the compiled default does not.
    expect(catalogJson.copterDefaults.SIM_BARO_RND).toBe('0');
    expect(p('SIM_MAG1_SCALING')?.default).toBe('1');
    expect(p('SIM_ACC1_BIAS')?.vector).toBe(true);
    expect(p('SIM_GPS1_GLTCH')?.vector).toBe(true);
    // A float member that shares its name with a GPS vector member stays scalar.
    expect(p('SIM_BARO_GLITCH')?.vector).toBe(false);
    expect(p('SIM_ACC2_RND')?.conditions).toEqual(['#if AP_SIM_ENABLED', '#if INS_MAX_INSTANCES > 1']);
    expect(catalogJson.jsonBackendDefaults.INS_ACCSCAL_X).toBe('1.001');
  });

  it('contains every JSON key the TASK-041 oracle writes', () => {
    const line: unknown = JSON.parse(protocol.expectedLine);
    if (typeof line !== 'object' || line === null) throw new Error('Oracle line is not an object');
    const fields: [string, unknown][] = Object.entries(line);
    const keys = fields.flatMap(([key, value]) => (typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.keys(value).map(inner => `${key}.${inner}`) : [key]));
    expect(keys.sort()).toEqual([...JSON_ORACLE_KEYS].sort());
    for (const key of JSON_ORACLE_KEYS) expect(catalog.jsonKeys.has(key), key).toBe(true);
    // Optional upstream keys exist but are not oracle-covered delivery paths yet.
    expect(catalog.jsonKeys.has('battery.voltage')).toBe(true);
  });

  it('records the firmware patch the repository applies, and rejects patches that leave the pinned sources', () => {
    const [entry] = catalogJson.patches;
    if (!entry) throw new Error('Catalog has no patch');
    const bytes = readFileSync(new URL(`../${entry.path}`, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    expect(entry.addedParameters.map(p => [p.name, p.default])).toEqual([['SIM_ACC_FLOOR', '0.01f'], ['SIM_GYR_FLOOR', '0.04f']]);
    // The defaults are the constants the patch removes, so an untouched patched build behaves as upstream.
    const facts = new Map(catalogJson.facts.map(f => [f.id, f.text]));
    expect(facts.get('ins-accel-noise-floor')).toBe('float accel_noise = 0.01f;');
    expect(facts.get('ins-gyro-noise-floor')).toBe('float gyro_noise = radians(0.04f);');
    expect(entry.removedFacts).toEqual(['ins-accel-noise-floor', 'ins-gyro-noise-floor']);
    const patchWith = (change: Record<string, unknown>) => ({ ...catalogJson, patches: [{ ...entry, ...change }] });
    const [first] = entry.files;
    if (!first) throw new Error('Patch changes no file');
    const invalid: [string, unknown, string][] = [
      ['uncataloged file', patchWith({ files: [{ ...first, path: 'libraries/SITL/SIM_Plane.cpp' }] }), 'not a cataloged upstream file'],
      ['other upstream bytes', patchWith({ files: [{ ...first, upstreamSha256: 'a'.repeat(64) }] }), 'not a cataloged upstream file'],
      ['redefined upstream parameter', patchWith({ addedParameters: [{ ...entry.addedParameters[0], name: 'SIM_ACC1_RND' }] }), 'redefines SIM_ACC1_RND'],
      ['unknown removed fact', patchWith({ removedFacts: ['ins-no-such-line'] }), 'removes unknown fact'],
      ['fact shadowing upstream', patchWith({ facts: [{ id: 'compass-noise', path: first.path, text: 'x' }] }), 'Duplicate fact'],
      ['path outside the patch directory', patchWith({ path: 'scripts/imu.patch' }), 'Invalid catalog patch'],
      ['duplicate patch', { ...catalogJson, patches: [entry, entry] }, 'Invalid catalog patch'],
    ];
    for (const [label, input, message] of invalid) expect(() => parseArduPilotCatalog(input), label).toThrow(message);
  });

  it('covers every parameter and fact the ownership taxonomy cites', () => {
    for (const id of ERROR_SOURCE_IDS) {
      const source = ERROR_SOURCES[id];
      for (const [name] of source.neutralize) expect(catalog.parameters.has(name), `${id}: ${name}`).toBe(true);
      for (const fact of source.facts) expect(catalog.facts.has(fact), `${id}: ${fact}`).toBe(true);
      if (source.fixed) {
        // No upstream parameter disables it; only a firmware patch can, and only then can MirageSITL deliver its own.
        expect(source.neutralize, id).toEqual([]);
        if (!source.patch) expect(source.deliveries, id).toEqual([]);
      }
      if (source.patch) {
        const patch = catalog.patches.get(source.patch.id);
        for (const [name] of source.patch.neutralize) expect(patch?.parameters.has(name), `${id}: ${name}`).toBe(true);
        for (const fact of source.patch.facts) expect(patch?.facts.has(fact), `${id}: ${fact}`).toBe(true);
      }
      // A source that cites an upstream fact a patch removes must say how that patch replaces it.
      for (const [patchId, patch] of catalog.patches) {
        if (source.facts.some(fact => patch.removedFacts.has(fact))) expect(source.patch?.id, `${id} vs ${patchId}`).toBe(patchId);
      }
      for (const d of source.deliveries) expect(Object.hasOwn(DELIVERY_PATHS, d)).toBe(true);
    }
    expect(catalog.facts.has('param-defaults-unknown-skipped')).toBe(true);
  });
});

describe('ownership matrices and profiles', () => {
  it('validates the evidenced parity matrices, which neutralize nothing', () => {
    for (const matrix of [parityNative, parityBrowser]) {
      const valid = validateOwnershipMatrix(matrix, catalog);
      expect(valid.entries.length).toBe(ERROR_SOURCE_IDS.length);
      expect(settings(ownershipParameterProfile(matrix, catalog))).toEqual([]);
    }
  });

  it('reproduces the TASK-059 EW parameter block of the native driver exactly', () => {
    const driver = readFileSync(new URL('../scripts/sitl/driver.mjs', import.meta.url), 'utf8');
    const block = /\(experiment\?'([^']*)'/.exec(driver)?.[1];
    if (block === undefined) throw new Error('Driver experiment block not found');
    const evidenced = block.split('\\n').filter(line => line !== '');
    const profile = ownershipParameterProfile(ewNative, catalog);
    expect(settings(profile).sort()).toEqual(evidenced.sort());
    expect(profile.split('\n').slice(0, 2)).toEqual(['# MirageSITL error-ownership profile v1',
      `# matrix task-059-ew-native; path native-json; ArduPilot ${PINNED_ARDUPILOT_COMMIT}`]);
  });

  it('neutralizes exactly the ArduPilot errors MirageSITL owns or nobody applies', () => {
    let matrix = own(parityNative, 'imu.accel.bias', 'mirage', ['json:imu.accel_body']);
    matrix = own(matrix, 'imu.vibration', 'mirage', ['json:imu.accel_body', 'json:imu.gyro']);
    matrix = own(matrix, 'baro.noise', 'none');
    matrix = own(matrix, 'mag.soft-iron', 'none');
    const lines = settings(ownershipParameterProfile(matrix, catalog));
    const expected = (['imu.accel.bias', 'imu.vibration', 'baro.noise', 'mag.soft-iron'] as const).flatMap(expanded);
    expect(lines.sort()).toEqual([...expected].sort());
    expect(lines).toContain('SIM_ACC5_BIAS_Z 0');
    expect(lines).toContain('SIM_MAG3_SCALING 1');
    expect(lines).toContain('SIM_VIB_MOT_MAX 0');
    // A source ArduPilot does not apply on the browser path needs no neutralization.
    expect(settings(ownershipParameterProfile(own(parityBrowser, 'mag.anomaly', 'mirage', ['hal:magnetic-field']), catalog))).toEqual([]);
  });

  it('rejects double, missing and unknown ownership', () => {
    const first = parityNative.entries[0]!;
    const invalid: [string, unknown, string][] = [
      ['two owners', { ...parityNative, entries: [...parityNative.entries, first] }, 'list'],
      ['two owners within the limit', { ...parityNative, entries: [first, ...parityNative.entries.slice(0, -1)] }, 'two owners'],
      ['missing source', { ...parityNative, entries: parityNative.entries.slice(1) }, 'no owner'],
      ['unknown source', { ...parityNative, entries: parityNative.entries.map((e, i) => (i === 3 ? { ...e, source: 'imu.temperature' } : e)) },
        'Unknown error source'],
      ['unknown owner', own(parityNative, 'baro.drift', 'operator'), 'Unknown owner'],
      ['unknown path', { ...parityNative, path: 'hitl' }, 'path'],
      ['extra key', { ...parityNative, note: 'x' }, 'fields'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateOwnershipMatrix(input, catalog), label).toThrow(message);
  });

  it('rejects deliveries without repository evidence for the matrix path', () => {
    const invalid: [string, Matrix, string][] = [
      ['uncovered JSON key', own(parityNative, 'imu.accel.bias', 'mirage', ['json:battery.voltage']), 'repository evidence'],
      ['browser field on the native path', own(parityNative, 'imu.gyro.bias', 'mirage', ['hal:gyro']), 'exactly json:imu.gyro'],
      ['partial vibration delivery', own(parityNative, 'imu.vibration', 'mirage', ['json:imu.accel_body']), 'exactly'],
      ['no delivery', own(parityNative, 'imu.accel.bias', 'mirage'), 'exactly'],
      ['GNSS injection in the browser', own(parityBrowser, 'gnss.receiver', 'mirage', ['mavlink:gps-input']), 'No repository-evidenced path'],
      ['barometer error', own(parityNative, 'baro.noise', 'mirage'), 'No repository-evidenced path'],
      ['board trim', own(parityNative, 'imu.board-trim', 'mirage'), 'No repository-evidenced path'],
      ['ArduPilot owner with a delivery', own(parityNative, 'mag.noise', 'ardupilot', ['hal:magnetic-field']), 'no MirageSITL delivery'],
      ['nobody with a delivery', own(parityNative, 'mag.noise', 'none', ['hal:magnetic-field']), 'no delivery'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateOwnershipMatrix(input, catalog), label).toThrow(message);
  });

  it('keeps the unconditional IMU noise floors with ArduPilot unless the target build applies the patch', () => {
    for (const source of ['imu.accel.noise-floor', 'imu.gyro.noise-floor'] as const) {
      expect(() => validateOwnershipMatrix(own(parityNative, source, 'none'), catalog)).toThrow('needs the imu-noise-floor firmware patch');
      expect(() => validateOwnershipMatrix(own(parityBrowser, source, 'mirage', ['hal:gyro']), catalog)).toThrow('needs the imu-noise-floor');
    }
    expect(() => validateOwnershipMatrix(own(parityNative, 'gnss.receiver', 'none'), catalog)).toThrow('No pinned-source parameter');
    expect(() => validateOwnershipMatrix(own(parityBrowser, 'mag.anomaly', 'ardupilot'), catalog)).toThrow('does not apply');
  });

  it('switches the floors off through the patch parameters, and keeps ArduPilot defaults otherwise', () => {
    const patched = { ...parityNative, schemaVersion: 2, id: 'patched-native', firmwarePatches: ['imu-noise-floor'] };
    // Declaring the patch alone changes nothing: ArduPilot still owns its floors with the upstream defaults.
    expect(settings(ownershipParameterProfile(patched, catalog))).toEqual([]);
    const off = own(own(patched, 'imu.accel.noise-floor', 'none'), 'imu.gyro.noise-floor', 'none');
    const profile = ownershipParameterProfile(off, catalog);
    expect(settings(profile)).toEqual(['SIM_ACC_FLOOR 0', 'SIM_GYR_FLOOR 0']);
    const sha = catalog.patches.get('imu-noise-floor')?.sha256;
    expect(profile.split('\n')[1]).toBe(`# matrix patched-native; path native-json; ArduPilot ${PINNED_ARDUPILOT_COMMIT}; patches imu-noise-floor ${String(sha)}`);
    expect(validateOwnershipMatrix(off, catalog).firmwarePatches).toEqual(['imu-noise-floor']);
    // MirageSITL may own a floor only through the IMU delivery of the path.
    const mirage = own(patched, 'imu.accel.noise-floor', 'mirage', ['json:imu.accel_body']);
    expect(settings(ownershipParameterProfile(mirage, catalog))).toEqual(['SIM_ACC_FLOOR 0']);
    expect(() => validateOwnershipMatrix(own(patched, 'imu.gyro.noise-floor', 'mirage'), catalog)).toThrow('exactly json:imu.gyro');
    const invalid: [string, unknown, string][] = [
      ['browser build without the patch', { ...parityBrowser, schemaVersion: 2, firmwarePatches: ['imu-noise-floor'] }, 'No browser-hal build'],
      ['unknown patch', { ...patched, firmwarePatches: ['imu-noise-ceiling'] }, 'Unknown or repeated firmware patch'],
      ['repeated patch', { ...patched, firmwarePatches: ['imu-noise-floor', 'imu-noise-floor'] }, 'Unknown or repeated'],
      ['schema 2 without patches', { ...parityNative, schemaVersion: 2 }, 'fields'],
      ['schema 1 with patches', { ...parityNative, firmwarePatches: [] }, 'fields'],
      ['schema 3', { ...patched, schemaVersion: 3 }, 'Unsupported ownership matrix schema'],
    ];
    for (const [label, input, message] of invalid) expect(() => validateOwnershipMatrix(input, catalog), label).toThrow(message);
    const unpatchedCatalog = parseArduPilotCatalog({ ...catalogJson, patches: [] });
    expect(() => validateOwnershipMatrix(off, unpatchedCatalog)).toThrow('imu-noise-floor is not in the pinned-source catalog');
  });

  it('maps the IMU noise-floor setting to ArduPilot defaults or to the patch parameters', () => {
    expect([...IMU_NOISE_FLOOR_SETTINGS]).toEqual(['ardupilot', 'off']);
    expect(isImuNoiseFloorSetting('off')).toBe(true);
    expect(isImuNoiseFloorSetting('OFF')).toBe(false);
    for (const path of ['native-json', 'browser-hal'] as const) {
      expect(settings(ownershipParameterProfile(imuNoiseFloorMatrix('ardupilot', path), catalog)), path).toEqual([]);
    }
    expect(settings(ownershipParameterProfile(imuNoiseFloorMatrix('off', 'native-json'), catalog))).toEqual(['SIM_ACC_FLOOR 0', 'SIM_GYR_FLOOR 0']);
    // Fail closed until the browser HAL build applies the patch.
    expect(FIRMWARE_PATCHES['imu-noise-floor'].paths).toEqual(['native-json']);
    expect(() => ownershipParameterProfile(imuNoiseFloorMatrix('off', 'browser-hal'), catalog)).toThrow('No browser-hal build');
  });

  it('rejects parameter names and facts missing from the pinned-source catalog', () => {
    const withoutParameter = parseArduPilotCatalog({ ...catalogJson,
      simParameters: catalogJson.simParameters.filter(p => p.name !== 'SIM_ACC3_BIAS') });
    expect(() => validateOwnershipMatrix(parityNative, withoutParameter)).toThrow('SIM_ACC3_BIAS for imu.accel.bias is not in the pinned-source catalog');
    const withoutFact = parseArduPilotCatalog({ ...catalogJson, facts: catalogJson.facts.filter(f => f.id !== 'compass-noise') });
    expect(() => validateOwnershipMatrix(parityNative, withoutFact)).toThrow('Fact compass-noise');
    const conditional = parseArduPilotCatalog({ ...catalogJson, simParameters: catalogJson.simParameters.map(p =>
      (p.name === 'SIM_MAG_RND' ? { ...p, conditions: ['#if AP_SIM_ENABLED', '#if AP_SIM_MAG_EXPERIMENTAL'] } : p)) });
    expect(() => validateOwnershipMatrix(parityNative, conditional)).toThrow('unverified build condition');
  });
});
