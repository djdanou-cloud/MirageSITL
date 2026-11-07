// TASK-161: ArduPilot parameter files. The format is checked against
// ArduPilot's own reading rules (AP_Param.cpp parse_param_line at fb773567)
// and, where the TASK-152 installation provides it, against pymavlink
// 2.4.50's MAVParmDict.load as an independent reader. Selections are checked
// against oracles written out by hand. The subset archive of the project
// store imports into an empty store with every dependency of the profile.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatParamFile, groupOf, parseParamFile, selectParameters, type ExportCandidate, type ParamFileContext } from '../packages/autopilot/src/param-file.ts';
import { decodeArchive } from '../packages/project/src/archive.ts';
import { MemoryBackend, ProjectStore } from '../packages/project/src/store.ts';

const CONTEXT: ParamFileContext = {
  exportedAt: '2026-11-03T08:00:00.000Z', source: "the running SITL's read-back", selection: 'all 4 parameters',
  aircraft: { name: 'Quad X\nsecond line', version: 3, sha256: 'b'.repeat(64) },
  firmware: { version: 'ArduCopter V4.7.2', commit: 'fb773567896014da007bca58358704d4a0d8516f' },
  experiment: { id: '20261103080000000-0000002a', sha256: 'c'.repeat(64) },
};
const f32 = Math.fround;
const PYTHON = join(process.cwd(), '.cache/task-152/home/venv/bin/python');

/** A deterministic sample of finite float32 values over the whole range, by bit pattern. */
function sampleFloats(count: number): number[] {
  const bits = new Uint32Array(1), view = new Float32Array(bits.buffer), out: number[] = [];
  let state = 0x9e3779b9;
  while (out.length < count) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bits[0] = state;
    const value = view[0] ?? Number.NaN;
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

describe('parameter file format', () => {
  test('writes the context as comments and NAME,VALUE lines by name at full float32 precision', () => {
    const text = formatParamFile(CONTEXT, [{ name: 'RTL_ALT_M', value: 20 }, { name: 'ATC_RAT_RLL_I', value: f32(0.00017) }, { name: 'GPS1_DELAY_MS', value: -0 },
      { name: 'LOG_BITMASK', value: 16777216 }]);
    expect(text).toBe([
      '# ArduPilot parameter file exported by MirageSITL for loading by hand; MirageSITL never writes it to a flight controller.',
      '# Exported: 2026-11-03T08:00:00.000Z',
      "# Values: the running SITL's read-back",
      '# Selection: all 4 parameters',
      `# Aircraft profile: Quad X second line, version 3, ${'b'.repeat(64)}`,
      '# ArduPilot: ArduCopter V4.7.2, commit fb773567896014da007bca58358704d4a0d8516f',
      `# Experiment: 20261103080000000-0000002a, record ${'c'.repeat(64)}`,
      '# Parameters: 4',
      'ATC_RAT_RLL_I,0.00017', 'GPS1_DELAY_MS,-0', 'LOG_BITMASK,16777216', 'RTL_ALT_M,20', '',
    ].join('\n'));
    expect(formatParamFile({ ...CONTEXT, aircraft: null, firmware: null, experiment: null }, [])).toContain('# Aircraft profile: none\n# ArduPilot: not known\n# Experiment: none');
  });

  test('refuses names ArduPilot cannot read, duplicates and values that are not finite float32', () => {
    for (const name of ['', 'ABCDEFGHIJKLMNOPQ', 'A B', 'A,B', 'A=B', '#X']) expect(() => formatParamFile(CONTEXT, [{ name, value: 1 }])).toThrow('is not an ArduPilot parameter name');
    expect(() => formatParamFile(CONTEXT, [{ name: 'X', value: 1 }, { name: 'X', value: 2 }])).toThrow('X is listed twice');
    expect(() => formatParamFile(CONTEXT, [{ name: 'X', value: 0.1 }])).toThrow('is not a finite float32');
    expect(() => formatParamFile(CONTEXT, [{ name: 'X', value: Number.NaN }])).toThrow('is not a finite float32');
  });

  test('reads back the same float32 for 200,000 sampled bit patterns, and reads lines as ArduPilot does', () => {
    const values = sampleFloats(200_000);
    const entries = values.map((value, i) => ({ name: `P${i.toString(36).toUpperCase()}`, value }));
    const back = parseParamFile(formatParamFile(CONTEXT, entries));
    const expected = new Map(entries.map(e => [e.name, e.value]));
    let differ = 0;
    for (const entry of back) if (!Object.is(expected.get(entry.name), entry.value)) differ++;
    expect([back.length, differ]).toEqual([entries.length, 0]);
    expect(parseParamFile('# comment\n\nA 1\r\nB\t2.5\nC=3\nD, 4\n  # indented comment\n')).toEqual([
      { name: 'A', value: 1 }, { name: 'B', value: 2.5 }, { name: 'C', value: 3 }, { name: 'D', value: 4 }]);
    expect(() => parseParamFile('A,1\nB\n')).toThrow('Line 2 is not NAME,VALUE');
    expect(() => parseParamFile('A,x\n')).toThrow('Line 1: "x" is not a finite number');
    expect(() => parseParamFile('A,1\nA,2\n')).toThrow('Line 2: A is listed twice');
  });

  test.skipIf(!existsSync(PYTHON))('pymavlink 2.4.50 reads the same float32 values from an exported file', () => {
    const values = sampleFloats(5000);
    const entries = values.map((value, i) => ({ name: `Q${i}`, value }));
    const dir = mkdtempSync(join(tmpdir(), 'mirage-param-file-'));
    try {
      const file = join(dir, 'export.param');
      writeFileSync(file, formatParamFile(CONTEXT, entries));
      const script = [
        'import json, struct, sys', 'from pymavlink import mavparm',
        'p = mavparm.MAVParmDict()', 'p.load(sys.argv[1], use_excludes=False)',
        "print(json.dumps({k: struct.unpack('<I', struct.pack('<f', v))[0] for k, v in p.items()}))",
      ].join('\n');
      const result = spawnSync(PYTHON, ['-I', '-c', script, file], { encoding: 'utf8', maxBuffer: 1 << 24 });
      expect(result.status, result.stderr).toBe(0);
      // MAVParmDict.load prints a "Loaded N parameters" line before the JSON.
      expect(result.stdout).toContain(`Loaded ${entries.length} parameters`);
      const read: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
      const bits = new Float32Array(1), word = new Uint32Array(bits.buffer);
      const expected = Object.fromEntries(entries.map(e => { bits[0] = e.value; return [e.name, word[0]]; }));
      expect(read).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('selections', () => {
  const candidate = (name: string, value: number): ExportCandidate => ({ name, value, source: 'sitl', note: null });
  const live = [candidate('RTL_ALT_M', 20), candidate('ATC_RAT_RLL_P', f32(0.135)), candidate('GPS1_DELAY_MS', 10), candidate('RTL_SPEED_MS', 5),
    candidate('GPS_AUTO_CONFIG', 1), candidate('FORMAT_VERSION', 120), candidate('RTL', 7)];

  test('groups are the name up to the first underscore', () => {
    expect(['RTL_ALT_M', 'GPS1_DELAY_MS', 'GPS_AUTO_CONFIG', 'FORMAT_VERSION', 'RTL', '_X'].map(groupOf)).toEqual(['RTL', 'GPS1', 'GPS', 'FORMAT', 'RTL', '_X']);
  });

  test('all, changes against a baseline and chosen parameters and groups match the hand-written oracles, sorted by name', () => {
    const names = (list: readonly ExportCandidate[]) => list.map(entry => entry.name);
    expect(names(selectParameters(live, { kind: 'all' }))).toEqual(['ATC_RAT_RLL_P', 'FORMAT_VERSION', 'GPS1_DELAY_MS', 'GPS_AUTO_CONFIG', 'RTL', 'RTL_ALT_M', 'RTL_SPEED_MS']);
    // RTL_ALT_M and GPS1_DELAY_MS differ, RTL_SPEED_MS and RTL are not in the baseline; ATC_RAT_RLL_P, GPS_AUTO_CONFIG and FORMAT_VERSION are equal.
    const baseline = [{ name: 'RTL_ALT_M', value: 15 }, { name: 'ATC_RAT_RLL_P', value: f32(0.135) }, { name: 'GPS1_DELAY_MS', value: 0 },
      { name: 'GPS_AUTO_CONFIG', value: 1 }, { name: 'FORMAT_VERSION', value: 120 }, { name: 'GONE', value: 1 }];
    expect(names(selectParameters(live, { kind: 'changes', baseline }))).toEqual(['GPS1_DELAY_MS', 'RTL', 'RTL_ALT_M', 'RTL_SPEED_MS']);
    expect(names(selectParameters(live, { kind: 'chosen', names: ['ATC_RAT_RLL_P', 'NOT_LISTED'], groups: ['RTL', 'GPS1'] })))
      .toEqual(['ATC_RAT_RLL_P', 'GPS1_DELAY_MS', 'RTL', 'RTL_ALT_M', 'RTL_SPEED_MS']);
    expect(selectParameters(live, { kind: 'chosen', names: [], groups: [] })).toEqual([]);
  });
});

describe('simulator settings archive', () => {
  test('holds the project, the profile item and its whole dependency closure with full histories, and nothing else', async () => {
    const store = new ProjectStore(new MemoryBackend());
    const project = await store.createProject('Settings');
    const projectId = project.record.id;
    const motor = await store.createItem(projectId, 'component-card', { name: 'Motor', payload: { v: 1 } });
    const motor2 = await store.saveVersion(motor.record.id, motor.sha256, { name: 'Motor', payload: { v: 2 } });
    const battery = await store.createItem(projectId, 'component-card', { name: 'Battery', payload: { v: 1 } });
    const unrelated = await store.createItem(projectId, 'component-card', { name: 'Spare', payload: { v: 1 } });
    // Version 1 of the profile used the first motor version; version 2 uses the second and the battery.
    const profile = await store.createItem(projectId, 'aircraft-profile', { name: 'Quad', payload: { v: 1 }, dependencies: [motor.sha256] });
    const profile2 = await store.saveVersion(profile.record.id, profile.sha256, { name: 'Quad', payload: { v: 2 }, dependencies: [motor2.sha256, battery.sha256] });
    await store.createItem(projectId, 'experiment', { name: 'Run', payload: { v: 1 }, dependencies: [profile2.sha256] });

    const exported = await store.exportItems(projectId, [profile2.sha256]);
    expect(exported.missing).toEqual([]);
    const { versions } = await decodeArchive(exported.archive);
    expect(versions.map(v => `${v.record.kind}:${v.record.name}:${v.record.version}`).sort()).toEqual([
      'aircraft-profile:Quad:1', 'aircraft-profile:Quad:2', 'component-card:Battery:1', 'component-card:Motor:1', 'component-card:Motor:2', 'project:Settings:1']);
    expect(versions.some(v => v.sha256 === unrelated.sha256)).toBe(false);
    const fresh = new ProjectStore(new MemoryBackend());
    const report = await fresh.importArchive(exported.archive);
    expect(report.missing).toEqual([]);
    expect((await fresh.listItems(projectId)).map(v => v.record.name).sort()).toEqual(['Battery', 'Motor', 'Quad']);
    await expect(store.exportItems(projectId, ['d'.repeat(64)])).rejects.toThrow('is not a stored version of project');
  });
});
