// TASK-155: the identity a SITL the user started reports, from AUTOPILOT_VERSION.
// Oracles: the official pymavlink 2.4.50 goldens of message 148
// (tests/fixtures/mavlink/golden.json, scripts/generate-mavlink-fixtures.py),
// ArduPilot's packing of flight_sw_version (GCS_Common.cpp
// send_autopilot_version at 8ab6afde: major, minor, patch, type from the high
// byte down) and of flight_custom_version (the 8 characters of GIT_VERSION),
// FIRMWARE_VERSION_TYPE of common.xml, and the ground station's own encoder
// for MAV_CMD_REQUEST_MESSAGE.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readAutopilotVersion, verifiedCommit } from '../packages/autopilot/src/autopilot-version.ts';
import { GroundStation } from '../packages/autopilot/src/ground-station.ts';
import { encodeInto, MavParser, type MavFrame } from '../packages/mavlink/src/codec.ts';
import { fieldOf, packInto, readNumber } from '../packages/mavlink/src/messages.ts';

interface GoldenFrame { readonly id: number; readonly style: string; readonly values: Record<string, unknown>; readonly hex: string }
const golden: unknown = JSON.parse(readFileSync(new URL('./fixtures/mavlink/golden.json', import.meta.url), 'utf8'));
function goldenFrames(): GoldenFrame[] {
  const frames: unknown = typeof golden === 'object' && golden !== null ? Reflect.get(golden, 'messageFrames') : undefined;
  if (!Array.isArray(frames)) throw new Error('golden.json has no messageFrames');
  const list: readonly unknown[] = frames;
  return list.flatMap(frame => {
    const id: unknown = Reflect.get(Object(frame), 'id'), style: unknown = Reflect.get(Object(frame), 'style');
    const values: unknown = Reflect.get(Object(frame), 'values'), hex: unknown = Reflect.get(Object(frame), 'hex');
    if (typeof id !== 'number' || typeof style !== 'string' || typeof hex !== 'string' || typeof values !== 'object' || values === null) return [];
    return [{ id, style, values: Object.fromEntries(Object.entries(values)), hex }];
  });
}
function parse(bytes: Uint8Array): MavFrame[] {
  const frames: MavFrame[] = [];
  const parser = new MavParser(frame => { frames.push({ ...frame, payload: frame.payload.slice(), view: new DataView(frame.payload.slice().buffer) }); });
  parser.push(bytes);
  return frames;
}
function version(software: number, hash: readonly number[]): MavFrame {
  const payload = new Uint8Array(78), out = new Uint8Array(300);
  const zeros = Array.from({ length: 8 }, () => 0);
  if (!packInto(148, { capabilities: 0, uid: 0, flight_sw_version: software, middleware_sw_version: 0, os_sw_version: 0, board_version: 0,
    vendor_id: 0, product_id: 0, flight_custom_version: hash, middleware_custom_version: zeros, os_custom_version: zeros }, payload)) throw new Error('No pack');
  const frame = parse(out.slice(0, encodeInto(148, payload, 0, 1, 1, out)))[0];
  if (!frame) throw new Error('No frame');
  return frame;
}
const ascii = (text: string) => Array.from(text, c => c.charCodeAt(0));

test('reads the golden AUTOPILOT_VERSION frames as pymavlink packed them', () => {
  const frames = goldenFrames().filter(frame => frame.id === 148);
  expect(frames.map(frame => frame.style)).toEqual(['pattern', 'minimal']);
  for (const golden of frames) {
    const frame = parse(Uint8Array.from(Buffer.from(golden.hex, 'hex')))[0];
    if (!frame) throw new Error(`Golden ${golden.style} does not parse`);
    const software = Number(golden.values.flight_sw_version);
    const custom = golden.values.flight_custom_version;
    if (!Array.isArray(custom)) throw new Error('Golden lacks flight_custom_version');
    const reported = readAutopilotVersion(frame);
    const release = `${Math.floor(software / 2 ** 24)}.${Math.floor(software / 2 ** 16) % 256}.${Math.floor(software / 256) % 256}`;
    const type = software % 256;
    expect(reported?.firmwareVersion).toBe(type === 255 ? release : `${release}-${{ 0: 'dev', 64: 'alpha', 128: 'beta', 192: 'rc' }[type] ?? `type ${type}`}`);
    // Neither golden's bytes spell 8 lowercase hexadecimal characters.
    expect(reported?.gitHash).toBeNull();
    expect(readNumber(frame.view, fieldOf(148, 'flight_sw_version') ?? fail())).toBe(software);
  }
});

test('reads ArduPilot\'s version packing and git hash, and ignores other messages', () => {
  expect(readAutopilotVersion(version(((4 << 24) | (7 << 16) | (0 << 8) | 0) >>> 0, ascii('8ab6afde')))).toEqual({ firmwareVersion: '4.7.0-dev', gitHash: '8ab6afde' });
  expect(readAutopilotVersion(version(((4 << 24) | (6 << 16) | (2 << 8) | 255) >>> 0, ascii('0123abcd')))).toEqual({ firmwareVersion: '4.6.2', gitHash: '0123abcd' });
  expect(readAutopilotVersion(version(((4 << 24) | (6 << 16) | (0 << 8) | 192) >>> 0, ascii('ABCDEF12')))?.gitHash).toBeNull();
  expect(readAutopilotVersion(version(((4 << 24) | (6 << 16) | (0 << 8) | 128) >>> 0, [0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ firmwareVersion: '4.6.0-beta', gitHash: null });
  const heartbeat = new GroundStation().heartbeatInto(new Uint8Array(64));
  expect(heartbeat).toBeGreaterThan(0);
  const out = new Uint8Array(64);
  const frame = parse(out.slice(0, new GroundStation().heartbeatInto(out)))[0];
  expect(frame && readAutopilotVersion(frame)).toBeNull();
});

test('matches a git hash to exactly one verified commit', () => {
  const pinned = '8ab6afde107a91df1b5f60ade8f333cb8a61b190';
  expect(verifiedCommit('8ab6afde', [pinned])).toBe(pinned);
  expect(verifiedCommit('8ab6afdf', [pinned])).toBeNull();
  expect(verifiedCommit(null, [pinned])).toBeNull();
  expect(verifiedCommit('8ab6afde', [pinned, `${pinned.slice(0, 8)}${'0'.repeat(32)}`])).toBeNull();
});

test('requests AUTOPILOT_VERSION with MAV_CMD_REQUEST_MESSAGE', () => {
  const out = new Uint8Array(64);
  const frame = parse(out.slice(0, new GroundStation().requestMessageInto(148, out)))[0];
  if (!frame) throw new Error('No frame');
  expect(frame.id).toBe(76);
  expect(readNumber(frame.view, fieldOf(76, 'command') ?? fail())).toBe(512);
  expect(readNumber(frame.view, fieldOf(76, 'param1') ?? fail())).toBe(148);
  expect(readNumber(frame.view, fieldOf(76, 'target_system') ?? fail())).toBe(1);
});

function fail(): never {
  throw new Error('MAVLink table lacks a field');
}
