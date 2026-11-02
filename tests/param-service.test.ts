// TASK-159: the parameter service, its float32 formatting and the generated
// metadata. Oracles: a scripted autopilot that answers each request the way
// ArduPilot's handlers at 8ab6afde do (GCS_Param.cpp: the list stream, reads
// by index and by name, PARAM_SET answered with the new value, a parameter
// the ground station may not write answered with its old value, an unknown
// name answered only by PARAM_ERROR, which the TASK-150 set does not carry);
// the PARAM_SET and index-read frames decoded by pymavlink 2.4.50 (skipped
// without the TASK-127 venv); float32 bit patterns for the formatting; and
// the generated metadata file against facts read from the pinned source.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeInto, MavParser, type MavFrame } from '../packages/mavlink/src/codec.ts';
import { fieldOf, packInto, readNumber, readText } from '../packages/mavlink/src/messages.ts';
import { GroundStation } from '../packages/autopilot/src/ground-station.ts';
import { outsideRange, parseParameterMetadata, type ParameterMetadataSet } from '../packages/autopilot/src/param-metadata.ts';
import {
  formatParameterValue, MavParamType, parseParameterValue, ParameterService, type WriteState,
} from '../packages/autopilot/src/param-service.ts';
import { nodeCheck } from './support/node-evidence';

const PYTHON = join(process.cwd(), '.cache/task-127/venv/bin/python');
const COMMIT = '8ab6afde107a91df1b5f60ade8f333cb8a61b190';
const metadataFile: unknown = JSON.parse(readFileSync(join(process.cwd(), 'data/ardupilot/param-metadata.json'), 'utf8'));
const catalog = parseParameterMetadata(metadataFile);
function pinnedMetadata(): ParameterMetadataSet {
  const set = catalog.forCommit(COMMIT);
  if (!set) throw new Error('No metadata for the pinned commit');
  return set;
}

function requestField(id: number, name: string) {
  const field = fieldOf(id, name);
  if (!field) throw new Error(`No field ${id}.${name}`);
  return field;
}
const READ_INDEX = requestField(20, 'param_index'), READ_ID = requestField(20, 'param_id');
const SET_VALUE = requestField(23, 'param_value'), SET_ID = requestField(23, 'param_id'), SET_TYPE = requestField(23, 'param_type');

interface FakeParameter { name: string; value: number; type: number; internal?: boolean }
/** One sent request, decoded. */
type Request = { readonly kind: 'list' } | { readonly kind: 'read-index'; readonly index: number } | { readonly kind: 'read-name'; readonly name: string }
  | { readonly kind: 'set'; readonly name: string; readonly value: number; readonly type: number };

/**
 * A scripted ArduPilot. Answers are queued and delivered by flush(), so a test
 * can place an unsolicited frame before them. `ready` false ignores list
 * requests (params_ready()); `dropListed` loses list entries of the first
 * stream; `silent` names get no answer to a write or read; `hidden` holds a
 * group that an `enable` parameter shows when it becomes 1.
 */
class FakeAutopilot {
  readonly requests: Request[] = [];
  ready = true;
  dropListed = new Set<number>();
  dropIndexReads = false;
  silent = new Set<string>();
  private queue: Uint8Array[] = [];
  private sequence = 0;
  private readonly payload = new Uint8Array(25);
  private readonly parser = new MavParser(frame => this.receive(frame));
  constructor(public parameters: FakeParameter[], private readonly hidden: { enable: string; group: FakeParameter[] } | null = null) {}

  /** The service's send function. */
  readonly send = (bytes: Uint8Array): void => { this.parser.push(bytes); };
  /** Delivers the queued answers, or only the first `limit` of them. */
  flush(service: ParameterService, nowS: number, limit = Infinity): void {
    const frames = this.queue.slice(0, limit);
    this.queue = this.queue.slice(frames.length);
    const parser = new MavParser(frame => { service.ingest(frame, nowS); });
    for (const frame of frames) parser.push(frame);
  }
  /** Queues a PARAM_VALUE as ArduPilot would send it. */
  value(name: string, value: number, type: number, count: number, index: number): void {
    if (!packInto(22, { param_id: name, param_value: value, param_type: type, param_count: count, param_index: index }, this.payload)) throw new Error('PARAM_VALUE did not pack');
    const out = new Uint8Array(64);
    const n = encodeInto(22, this.payload, this.sequence, 1, 1, out);
    this.sequence = (this.sequence + 1) & 255;
    this.queue.push(out.slice(0, n));
  }
  private visible(): FakeParameter[] {
    const shown = this.hidden && this.parameters.find(p => p.name === this.hidden?.enable)?.value === 1;
    return shown && this.hidden ? [...this.parameters, ...this.hidden.group] : this.parameters;
  }
  private receive(frame: MavFrame): void {
    const list = this.visible();
    switch (frame.id) {
      case 21: {
        this.requests.push({ kind: 'list' });
        if (!this.ready) return;
        const dropping = new Set(this.dropListed);
        this.dropListed.clear();
        list.forEach((p, i) => { if (!dropping.has(i)) this.value(p.name, p.value, p.type, list.length, i); });
        return;
      }
      case 20: {
        const index = readNumber(frame.view, READ_INDEX);
        if (index !== -1) {
          this.requests.push({ kind: 'read-index', index });
          const p = list[index];
          if (!this.dropIndexReads) { if (p) this.value(p.name, p.value, p.type, list.length, index); else this.value('', Number.NaN, MavParamType.Real32, list.length, index); }
          return;
        }
        const name = readText(frame.payload, READ_ID);
        this.requests.push({ kind: 'read-name', name });
        const p = list.find(item => item.name === name);
        if (p && !this.silent.has(name)) this.value(p.name, p.value, p.type, list.length, 65535);
        return;
      }
      case 23: {
        const name = readText(frame.payload, SET_ID), value = readNumber(frame.view, SET_VALUE), type = readNumber(frame.view, SET_TYPE);
        this.requests.push({ kind: 'set', name, value, type });
        const p = list.find(item => item.name === name);
        if (!p || this.silent.has(name)) return; // PARAM_ERROR DOES_NOT_EXIST is not in the TASK-150 set
        if (!p.internal) p.value = Math.fround(value);
        // The save notification of a write, or the read-only answer with the old value; the count after a group appears.
        this.value(p.name, p.value, p.type, this.visible().length, 65535);
        return;
      }
      default: throw new Error(`Unexpected request ${frame.id}`);
    }
  }
}

const REAL32 = MavParamType.Real32, INT8 = MavParamType.Int8, INT16 = MavParamType.Int16, INT32 = MavParamType.Int32;
function vehicle(): FakeParameter[] {
  return [
    { name: 'FRAME_CLASS', value: 1, type: INT8 },
    { name: 'ATC_RAT_RLL_I', value: Math.fround(0.135), type: REAL32 },
    { name: 'SERIAL1_PROTOCOL', value: 2, type: INT8 },
    { name: 'INS_GYRO_FILTER', value: 20, type: INT16 },
    { name: 'BARO1_DEVID', value: 65540, type: INT32, internal: true },
    { name: 'LOG_BITMASK', value: 176126, type: INT32 },
    { name: 'GRIP_ENABLE', value: 0, type: INT8 },
    { name: 'SIM_SPEEDUP', value: 1, type: REAL32 },
  ];
}
const GRIPPER = { enable: 'GRIP_ENABLE', group: [{ name: 'GRIP_TYPE', value: 0, type: INT8 }, { name: 'GRIP_GRAB', value: 1900, type: INT16 }] };

function setup(parameters = vehicle(), metadata: ParameterMetadataSet | null = pinnedMetadata()) {
  const autopilot = new FakeAutopilot(parameters, GRIPPER);
  const service = new ParameterService({ ground: new GroundStation(), send: autopilot.send, metadata });
  return { autopilot, service };
}
function downloaded() {
  const { autopilot, service } = setup();
  service.requestList(0);
  autopilot.flush(service, 0);
  expect(service.download()).toEqual({ kind: 'complete', total: 8 });
  autopilot.requests.length = 0;
  return { autopilot, service };
}
function state(service: ParameterService, write: WriteState): WriteState {
  const current = service.write(write.id);
  if (!current) throw new Error(`No write ${write.id}`);
  return current;
}

describe('ParameterService list download', () => {
  it('collects every index against param_count and stores the wire float32 exactly', () => {
    const { autopilot, service } = setup();
    service.requestList(0);
    expect(service.download()).toEqual({ kind: 'downloading', received: 0, total: null });
    autopilot.flush(service, 0.1);
    expect(service.download()).toEqual({ kind: 'complete', total: 8 });
    expect(service.parameters().map(p => [p.name, p.index])).toEqual(vehicle().map((p, i) => [p.name, i]));
    expect(service.get('ATC_RAT_RLL_I')).toEqual({ name: 'ATC_RAT_RLL_I', value: Math.fround(0.135), type: REAL32, index: 1 });
    expect(service.get('ATC_RAT_RLL_I')?.value).not.toBe(0.135);
    expect(autopilot.requests).toEqual([{ kind: 'list' }]);
  });

  it('resends the list request while the autopilot is not ready, then fails after the limit', () => {
    const { autopilot, service } = setup();
    autopilot.ready = false;
    service.requestList(0);
    for (const t of [1, 1.99]) { service.tick(t); autopilot.flush(service, t); }
    expect(autopilot.requests.filter(r => r.kind === 'list')).toHaveLength(1);
    service.tick(2);
    expect(autopilot.requests.filter(r => r.kind === 'list')).toHaveLength(2);
    autopilot.ready = true;
    service.tick(4); autopilot.flush(service, 4);
    expect(service.download()).toEqual({ kind: 'complete', total: 8 });

    const never = setup();
    never.autopilot.ready = false;
    never.service.requestList(0);
    for (let t = 0; t <= 12; t += 0.5) never.service.tick(t);
    expect(never.autopilot.requests.filter(r => r.kind === 'list')).toHaveLength(5);
    expect(never.service.download()).toEqual({ kind: 'failed', received: 0, total: null, missing: [], reason: 'no PARAM_VALUE after 5 list requests' });
  });

  it('reads lost indices one by one after a quiet interval, and fails naming the indices that never came', () => {
    const { autopilot, service } = setup();
    autopilot.dropListed = new Set([3, 6]);
    service.requestList(0);
    autopilot.flush(service, 0);
    expect(service.download()).toEqual({ kind: 'downloading', received: 6, total: 8 });
    service.tick(0.99);
    expect(autopilot.requests.filter(r => r.kind === 'read-index')).toEqual([]);
    service.tick(1);
    expect(autopilot.requests.filter(r => r.kind === 'read-index')).toEqual([{ kind: 'read-index', index: 3 }, { kind: 'read-index', index: 6 }]);
    autopilot.flush(service, 1.1);
    expect(service.download()).toEqual({ kind: 'complete', total: 8 });
    expect(service.get('INS_GYRO_FILTER')?.index).toBe(3);

    const lossy = setup();
    lossy.autopilot.dropListed = new Set([5]);
    lossy.autopilot.dropIndexReads = true;
    lossy.service.requestList(0);
    lossy.autopilot.flush(lossy.service, 0);
    for (let t = 1; t <= 7; t++) lossy.service.tick(t);
    expect(lossy.autopilot.requests.filter(r => r.kind === 'read-index')).toHaveLength(5);
    expect(lossy.service.download()).toEqual({ kind: 'failed', received: 7, total: 8, missing: [5],
      reason: '1 of 8 indices still missing after 5 rounds of index reads' });
  });

  it('restarts a download whose param_count changes, drops the replaced stream, and marks a completed list stale later', () => {
    const { autopilot, service } = setup();
    service.requestList(0);
    autopilot.flush(service, 0, 3);
    // Another ground station enables the gripper: its save notification carries the new count before the old stream ends.
    const enable = autopilot.parameters.find(p => p.name === 'GRIP_ENABLE');
    if (!enable) throw new Error('GRIP_ENABLE missing');
    enable.value = 1;
    const notification = new FakeAutopilot([]);
    notification.value('GRIP_ENABLE', 1, INT8, 10, 65535);
    notification.flush(service, 0.1);
    expect(service.download()).toEqual({ kind: 'downloading', received: 0, total: 10 });
    autopilot.flush(service, 0.2);
    expect(autopilot.requests.filter(r => r.kind === 'list')).toHaveLength(2);
    expect(service.download()).toEqual({ kind: 'complete', total: 10 });
    expect(service.get('GRIP_GRAB')).toEqual({ name: 'GRIP_GRAB', value: 1900, type: INT16, index: 9 });

    const done = downloaded();
    const write = done.service.set('GRIP_ENABLE', 1, 1);
    done.autopilot.flush(done.service, 1);
    expect(state(done.service, write).kind).toBe('confirmed');
    expect(done.service.stale).toBe(true);
    done.service.requestList(2);
    done.autopilot.flush(done.service, 2);
    expect(done.service.stale).toBe(false);
    expect(done.service.download()).toEqual({ kind: 'complete', total: 10 });
  });

  it('ignores other senders and frames that are not PARAM_VALUE', () => {
    const { service } = setup();
    service.requestList(0);
    const payload = new Uint8Array(25), out = new Uint8Array(64);
    packInto(22, { param_id: 'FRAME_CLASS', param_value: 1, param_type: INT8, param_count: 8, param_index: 0 }, payload);
    let taken = 0;
    const parser = new MavParser(frame => { if (service.ingest(frame, 0)) taken++; });
    parser.push(out.slice(0, encodeInto(22, payload, 0, 2, 1, out)));
    parser.push(out.slice(0, encodeInto(22, payload, 1, 1, 0, out)));
    const ground = new GroundStation();
    parser.push(out.slice(0, ground.heartbeatInto(out)));
    expect(taken).toBe(0);
    expect(service.download()).toEqual({ kind: 'downloading', received: 0, total: null });
  });
});

describe('ParameterService writes', () => {
  it('confirms a write by read-back at the exact float32 and flags it from the metadata', () => {
    const { autopilot, service } = downloaded();
    const write = service.set('ATC_RAT_RLL_I', 0.00017, 1);
    expect(write).toMatchObject({ kind: 'requested', name: 'ATC_RAT_RLL_I', requested: 0.00017, attempts: 1 });
    expect(autopilot.requests).toEqual([{ kind: 'set', name: 'ATC_RAT_RLL_I', value: Math.fround(0.00017), type: REAL32 },
      { kind: 'read-name', name: 'ATC_RAT_RLL_I' }]);
    autopilot.flush(service, 1.01);
    expect(state(service, write)).toEqual({ kind: 'confirmed', id: write.id, name: 'ATC_RAT_RLL_I', requested: 0.00017,
      value: Math.fround(0.00017), rebootRequired: false, outsideRange: false });
    expect(formatParameterValue(service.get('ATC_RAT_RLL_I')?.value ?? Number.NaN)).toBe('0.00017');

    const reboot = service.set('SERIAL1_PROTOCOL', 1, 2);
    const outside = service.set('INS_GYRO_FILTER', 300, 2);
    autopilot.flush(service, 2);
    expect(state(service, reboot)).toMatchObject({ kind: 'confirmed', value: 1, rebootRequired: true, outsideRange: false });
    expect(state(service, outside)).toMatchObject({ kind: 'confirmed', value: 300, rebootRequired: false, outsideRange: true });
    expect(service.rebootPending()).toEqual(['SERIAL1_PROTOCOL']);
  });

  it('leaves the metadata flags unknown without metadata for the commit', () => {
    const { autopilot, service } = setup(vehicle(), null);
    service.requestList(0);
    autopilot.flush(service, 0);
    const write = service.set('SERIAL1_PROTOCOL', 1, 1);
    autopilot.flush(service, 1);
    expect(state(service, write)).toMatchObject({ kind: 'confirmed', rebootRequired: null, outsideRange: null });
    expect(service.rebootPending()).toEqual([]);
  });

  it('classifies an autopilot that keeps the old value as refused once it has been quiet for a retry interval', () => {
    const { autopilot, service } = downloaded();
    const write = service.set('BARO1_DEVID', 1, 1);
    autopilot.flush(service, 1);
    expect(state(service, write).kind).toBe('requested');
    expect(autopilot.requests.filter(r => r.kind === 'read-name')).toHaveLength(2);
    autopilot.flush(service, 1.1);
    service.tick(2.09);
    expect(state(service, write).kind).toBe('requested');
    service.tick(2.1);
    expect(autopilot.requests.filter(r => r.kind === 'set')).toHaveLength(1);
    expect(state(service, write)).toEqual({ kind: 'refused', id: write.id, name: 'BARO1_DEVID', requested: 1, by: 'autopilot', reported: 65540,
      reason: "the autopilot kept 65540 (read-only in ArduPilot's metadata)" });
  });

  it('does not refuse a write on an answer sent before the autopilot handled it', () => {
    const { autopilot, service } = downloaded();
    const write = service.set('SIM_SPEEDUP', 2, 1);
    const late = new FakeAutopilot([]);
    late.value('SIM_SPEEDUP', 1, REAL32, 8, 65535);
    late.flush(service, 1);
    expect(state(service, write).kind).toBe('requested');
    autopilot.flush(service, 1.01);
    expect(state(service, write)).toMatchObject({ kind: 'confirmed', value: 2 });
  });

  it('refuses without sending what the parameter cannot carry or the list does not hold', () => {
    const { autopilot, service } = downloaded();
    const cases: [string, number, string][] = [
      ['NOT_A_PARAMETER', 1, "the autopilot's parameter list has no parameter of this name"],
      ['SIM_SPEEDUP', Number.NaN, 'the value is not a finite number'],
      ['SIM_SPEEDUP', Number.POSITIVE_INFINITY, 'the value is not a finite number'],
      ['SIM_SPEEDUP', 1e39, 'the value is outside the float32 range'],
      ['FRAME_CLASS', 1.5, 'an integer from -128 to 127 is required'],
      ['FRAME_CLASS', 128, 'an integer from -128 to 127 is required'],
      ['INS_GYRO_FILTER', -32769, 'an integer from -32768 to 32767 is required'],
      ['LOG_BITMASK', 2 ** 24 + 1, "the value is not exactly representable in PARAM_SET's float32"],
    ];
    for (const [name, value, reason] of cases) {
      expect(service.set(name, value, 1)).toMatchObject({ kind: 'refused', name, by: 'service', reason, reported: null });
    }
    expect(autopilot.requests).toEqual([]);
    expect(service.set('LOG_BITMASK', 2 ** 24, 1).kind).toBe('requested');
  });

  it('resends an unanswered write and times it out after the last attempt', () => {
    const { autopilot, service } = downloaded();
    autopilot.silent.add('SIM_SPEEDUP');
    const write = service.set('SIM_SPEEDUP', 3, 0);
    for (let t = 0; t <= 4; t += 0.25) { service.tick(t); autopilot.flush(service, t); }
    expect(autopilot.requests.filter(r => r.kind === 'set')).toHaveLength(3);
    expect(state(service, write)).toEqual({ kind: 'timeout', id: write.id, name: 'SIM_SPEEDUP', requested: 3, attempts: 3 });
  });

  it('times nothing out while the clock stands still, as a paused lockstep SITL', () => {
    const { autopilot, service } = downloaded();
    autopilot.silent.add('SIM_SPEEDUP');
    const write = service.set('SIM_SPEEDUP', 3, 5);
    for (let i = 0; i < 100; i++) service.tick(5);
    expect(state(service, write)).toMatchObject({ kind: 'requested', attempts: 1 });
  });

  it('marks a replaced pending write stale, and a confirmed write once the autopilot still reports another value after a quiet retry interval', () => {
    const { autopilot, service } = downloaded();
    const first = service.set('SIM_SPEEDUP', 2, 1);
    const second = service.set('SIM_SPEEDUP', 4, 1);
    expect(state(service, first)).toMatchObject({ kind: 'stale', reason: `write ${second.id} of the same parameter replaced it`, reported: null });
    autopilot.flush(service, 1);
    expect(state(service, second)).toMatchObject({ kind: 'confirmed', value: 4 });
    // Something else changed it on the autopilot: the contradiction is read once more, and stands after a quiet interval.
    const changed = autopilot.parameters.find(p => p.name === 'SIM_SPEEDUP');
    if (!changed) throw new Error('No SIM_SPEEDUP');
    changed.value = 5;
    autopilot.requests.length = 0;
    autopilot.value('SIM_SPEEDUP', 5, REAL32, 8, 65535);
    autopilot.flush(service, 2);
    expect(autopilot.requests).toEqual([{ kind: 'read-name', name: 'SIM_SPEEDUP' }]);
    expect(state(service, second).kind).toBe('confirmed');
    autopilot.flush(service, 2.2);
    service.tick(3.19);
    expect(state(service, second).kind).toBe('confirmed');
    service.tick(3.2);
    expect(state(service, second)).toMatchObject({ kind: 'stale', reason: 'the autopilot now reports 5', reported: 5 });
    expect(service.writes().map(w => w.kind)).toEqual(['stale', 'stale']);
  });

  it('keeps a confirmed write when a queued answer from before it arrives late, as after a paused SITL resumes', () => {
    const { autopilot, service } = downloaded();
    // Written while paused: two writes of one parameter wait in the autopilot's input.
    const first = service.set('SIM_SPEEDUP', 3, 5);
    const second = service.set('SIM_SPEEDUP', 3.5, 5);
    // ArduPilot answers each write at once and each read from a queue: the read after the first write reports 3 after the second is confirmed.
    autopilot.requests.length = 0;
    const late = new FakeAutopilot([]);
    late.value('SIM_SPEEDUP', 3, REAL32, 8, 65535);
    late.value('SIM_SPEEDUP', 3.5, REAL32, 8, 65535);
    late.value('SIM_SPEEDUP', 3, REAL32, 8, 65535);
    late.value('SIM_SPEEDUP', 3.5, REAL32, 8, 65535);
    late.flush(service, 5.01);
    expect(state(service, first).kind).toBe('stale');
    expect(state(service, second)).toMatchObject({ kind: 'confirmed', value: 3.5 });
    service.tick(7);
    expect(state(service, second)).toMatchObject({ kind: 'confirmed', value: 3.5 });
    expect(service.get('SIM_SPEEDUP')?.value).toBe(3.5);
  });

  it('replaces a confirmed write by a newer confirmed write of the same parameter', () => {
    const { autopilot, service } = downloaded();
    const first = service.set('SIM_SPEEDUP', 2, 1);
    autopilot.flush(service, 1);
    expect(state(service, first).kind).toBe('confirmed');
    const second = service.set('SIM_SPEEDUP', 4, 2);
    autopilot.flush(service, 2);
    expect(state(service, first)).toMatchObject({ kind: 'stale', reason: `write ${second.id} of the same parameter replaced it`, reported: null });
    expect(state(service, second)).toMatchObject({ kind: 'confirmed', value: 4 });
  });
});

describe('parameter value formatting', () => {
  it('shows the shortest decimal of the float32, never a rounded one', () => {
    expect(formatParameterValue(Math.fround(0.00017))).toBe('0.00017');
    expect(formatParameterValue(Math.fround(0.135))).toBe('0.135');
    expect(formatParameterValue(Math.fround(1e-7))).toBe('1e-7');
    expect(formatParameterValue(176126)).toBe('176126');
    expect(formatParameterValue(16777216)).toBe('16777216');
    expect(formatParameterValue(-0)).toBe('-0');
    expect(formatParameterValue(Math.fround(3.4028234663852886e38))).toBe('3.4028235e+38');
    expect(formatParameterValue(2 ** -149)).toBe('1e-45');
    expect(() => formatParameterValue(0.1)).toThrow(/float32/);
    expect(() => formatParameterValue(Number.NaN)).toThrow(/float32/);
  });

  it('round-trips every sampled float32 bit pattern exactly', () => {
    const bits = new Uint32Array(1), float = new Float32Array(bits.buffer);
    let state = 0x9e3779b9, checked = 0;
    const check = (value: number): void => {
      const text = formatParameterValue(value);
      const back = parseParameterValue(text);
      if (back === null || !Object.is(back, value)) throw new Error(`${value} formatted as ${text} parsed as ${back}`);
      checked++;
    };
    for (let i = 0; i < 1_000_000; i++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      bits[0] = state >>> 0;
      const value = float[0] ?? Number.NaN;
      if (Number.isFinite(value)) check(value);
    }
    for (const pattern of [0, 1, 0x007fffff, 0x00800000, 0x7f7fffff, 0x80000001, 0x3f800001, 0x4b7fffff, 0x4b800001]) {
      bits[0] = pattern;
      check(float[0] ?? Number.NaN);
    }
    expect(checked).toBeGreaterThan(990_000);
  });

  it('parses only one finite decimal number', () => {
    expect(parseParameterValue(' 0.00017 ')).toBe(Math.fround(0.00017));
    expect(parseParameterValue('-2.5e-3')).toBe(Math.fround(-0.0025));
    for (const text of ['', 'abc', '1,5', '0x10', '1e39', 'Infinity', 'NaN', '1 2', '--1']) expect(parseParameterValue(text)).toBeNull();
  });
});

describe('GroundStation PARAM_SET and index reads', () => {
  const gcs = new GroundStation(), out = new Uint8Array(64);
  const set = out.slice(0, gcs.paramSetInto('ATC_RAT_RLL_I', Math.fround(0.00017), REAL32, out));
  const read = out.slice(0, gcs.paramRequestReadIndexInto(1234, out));
  it('refuses what the wire cannot carry', () => {
    expect(set.length).toBeGreaterThan(0);
    expect(read.length).toBeGreaterThan(0);
    expect(gcs.paramSetInto('SIM\u0000X', 1, REAL32, out)).toBe(0);
    expect(gcs.paramSetInto('SIM_SPEEDUP', 1, 0, out)).toBe(0);
    expect(gcs.paramSetInto('SIM_SPEEDUP', 1, 11, out)).toBe(0);
    expect(gcs.paramSetInto('SIM_SPEEDUP', 1e39, REAL32, out)).toBe(0);
    expect(gcs.paramRequestReadIndexInto(-1, out)).toBe(0);
    expect(gcs.paramRequestReadIndexInto(32768, out)).toBe(0);
    expect(gcs.paramRequestReadIndexInto(1.5, out)).toBe(0);
  });
  it.skipIf(!existsSync(PYTHON))('decode identically in pymavlink 2.4.50', () => {
    const script = `
import json, struct, sys
from pymavlink.dialects.v20 import ardupilotmega
parser = ardupilotmega.MAVLink(None)
out = []
for h in json.loads(sys.argv[1]):
    m = parser.parse_char(bytes.fromhex(h))
    d = m.to_dict()
    row = [m.get_type(), m.get_srcSystem(), m.get_srcComponent(), d["target_system"], d["target_component"], d["param_id"]]
    if m.get_type() == "PARAM_SET":
        row += [struct.pack("<f", d["param_value"]).hex(), d["param_type"]]
    else:
        row += [d["param_index"]]
    out.append(row)
print(json.dumps(out))
`;
    const result = spawnSync(PYTHON, ['-I', '-c', script, JSON.stringify([set, read].map(bytes => Buffer.from(bytes).toString('hex')))], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const f32 = Buffer.alloc(4);
    f32.writeFloatLE(0.00017);
    expect(JSON.parse(result.stdout)).toEqual([
      ['PARAM_SET', 255, 190, 1, 1, 'ATC_RAT_RLL_I', f32.toString('hex'), REAL32],
      ['PARAM_REQUEST_READ', 255, 190, 1, 1, '', 1234],
    ]);
  });
});

describe('generated parameter metadata', () => {
  it('holds the pinned commit only, with facts read from its source', () => {
    expect(catalog.commits).toEqual([COMMIT]);
    expect(catalog.forCommit('0'.repeat(40))).toBeNull();
    const set = pinnedMetadata();
    expect(set.vehicle).toBe('ArduCopter');
    expect(set.size).toBe(5799);
    // libraries/AP_SerialManager/AP_SerialManager.cpp documents SERIAL1_PROTOCOL with @RebootRequired: True.
    expect(set.get('SERIAL1_PROTOCOL')).toMatchObject({ group: 'SERIAL', rebootRequired: true, readOnly: false, units: null });
    const frameClass = set.get('FRAME_CLASS');
    expect(frameClass?.rebootRequired).toBe(true);
    expect([1, 3, 15].map(value => frameClass?.values?.find(entry => entry[0] === value)?.[1])).toEqual(['Quad', 'Octa', 'Scripting Matrix']);
    expect(set.get('INS_GYRO_FILTER')).toMatchObject({ units: 'Hz', range: [0, 256], rebootRequired: false, user: 'Advanced' });
    expect(set.get('ATC_RAT_RLL_I')).toMatchObject({ units: '1/rad', range: [0, 0.6], increment: 0.01 });
    expect(set.get('BARO1_DEVID')).toMatchObject({ readOnly: true });
    expect(set.get('LOG_BITMASK')?.bitmask?.slice(0, 2)).toEqual([[0, 'Fast Attitude'], [1, 'Medium Attitude']]);
    // A reversed upstream range is listed, not repaired.
    expect(set.get('TA_GSP_AIRBRAKE')?.range).toBeNull();
    expect(set.anomalies).toEqual([{ name: 'TA_GSP_AIRBRAKE', field: 'Range', reason: 'low is above high; the range is left out' }]);
    const gyro = set.get('INS_GYRO_FILTER');
    if (!gyro) throw new Error('INS_GYRO_FILTER missing');
    expect([outsideRange(gyro, 256), outsideRange(gyro, 256.5), outsideRange(gyro, -1)]).toEqual([false, true, true]);
  });

  it('refuses a file outside schema 1', () => {
    const base = (): { schemaVersion: number; versions: Record<string, unknown>[] } => ({ schemaVersion: 1, versions: [{ commit: COMMIT, vehicle: 'ArduCopter',
      parameterCount: 1, anomalies: [], parameters: { A: { group: 'G', displayName: 'A', description: 'a' } } }] });
    expect(parseParameterMetadata(base()).forCommit(COMMIT)?.get('A')).toMatchObject({ rebootRequired: false, range: null, values: null });
    const broken: [string, (file: ReturnType<typeof base>) => void][] = [
      ['schema', file => { file.schemaVersion = 2; }],
      ['unknown field', file => { file.versions[0] = { ...file.versions[0], parameters: { A: { group: 'G', displayName: 'A', description: 'a', path: 'x' } } }; }],
      ['reversed range', file => { file.versions[0] = { ...file.versions[0], parameters: { A: { group: 'G', displayName: 'A', description: 'a', range: [2, 1] } } }; }],
      ['bit number', file => { file.versions[0] = { ...file.versions[0], parameters: { A: { group: 'G', displayName: 'A', description: 'a', bitmask: [[64, 'x']] } } }; }],
      ['flag false', file => { file.versions[0] = { ...file.versions[0], parameters: { A: { group: 'G', displayName: 'A', description: 'a', readOnly: false } } }; }],
      ['count', file => { file.versions[0] = { ...file.versions[0], parameterCount: 2 }; }],
      ['repeated commit', file => { file.versions.push({ ...file.versions[0] }); }],
      ['short commit', file => { file.versions[0] = { ...file.versions[0], commit: 'abc' }; }],
    ];
    for (const [label, change] of broken) {
      const file = base();
      change(file);
      expect(() => parseParameterMetadata(file), label).toThrow();
    }
  });

  it('converts param_parse.py output and fails on an upstream field it does not know', () => nodeCheck(`
import {convert,serialize} from './scripts/generate-param-metadata.mjs';
const raw={json:{version:0},SIM_:{SIM_B:{DisplayName:'B',Description:'b',Values:{'10':'ten','-1':'off','2':'two'},RebootRequired:'True',Calibration:'1',path:'x'},
 SIM_A:{DisplayName:'A',Description:'a',Range:{low:'5',high:'1'},Increment:'0.5',Bitmask:{'3':'d','0':'a'},User:'Advanced'}}};
const out=convert(raw,'${COMMIT}');
assert.deepEqual(Object.keys(out.parameters),['SIM_A','SIM_B']);
assert.deepEqual(out.parameters.SIM_B,{group:'SIM_',displayName:'B',description:'b',values:[[-1,'off'],[2,'two'],[10,'ten']],rebootRequired:true});
assert.deepEqual(out.parameters.SIM_A,{group:'SIM_',displayName:'A',description:'a',increment:0.5,bitmask:[[0,'a'],[3,'d']],user:'Advanced'});
assert.deepEqual(out.anomalies.map(a=>a.name),['SIM_A']);
assert.throws(()=>convert({G:{X:{DisplayName:'X',Description:'x',NewField:'1'}}},'c'),/unknown upstream field/);
assert.throws(()=>convert({G:{X:{DisplayName:'X',Description:'x',ReadOnly:'False'}}},'c'),/only "True"/);
assert.throws(()=>convert({G:{X:{DisplayName:'X',Description:'x',Range:{low:'a',high:'1'}}}},'c'),/not a number/);
assert.throws(()=>convert({G:{X:{DisplayName:'X',Description:'x'}},H:{X:{DisplayName:'X',Description:'x'}}},'c'),/two groups/);
const text=serialize({schemaVersion:1,generator:{},license:'l',versions:[{commit:'c',parameters:out.parameters}]});
assert.deepEqual(JSON.parse(text).versions[0].parameters,out.parameters);
assert.equal(text.split('\\n').filter(line=>line.startsWith('"SIM_')).length,2);
`));

  it.skipIf(!existsSync(join(process.cwd(), '.cache/task-127/ardupilot/Tools/autotest/param_metadata/param_parse.py')) || !existsSync(PYTHON))(
    'regenerates byte for byte from the pinned checkout', () => {
      const result = spawnSync(process.execPath, ['scripts/generate-param-metadata.mjs', '--source', '.cache/task-127/ardupilot', '--python', PYTHON, '--check'],
        { encoding: 'utf8' });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toMatch(/^identical .*5799 parameters, 1 anomalies/);
    }, 60_000);
});
