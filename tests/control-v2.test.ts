import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { COMMAND_QUEUE_CAPACITY_V2, ControlProcessorV2, isWorkerInitV2, parseControlCommandV2, parseWorkerEventV2, type ClockModeV2, type CommandResultV2,
  type ControlTargetV2, type PhysicsHz, type ScheduledCommandV2, type TickId } from '@mirage/protocol';
import schema from '../packages/protocol/src/control-v2.schema.json';
import { specText } from './support/spec-layout';

const SHA = 'ab'.repeat(32);
const envelope = (requestId: number, expectedEpoch = 1) => ({ protocolVersion: 2, requestId, expectedEpoch });
const weather = (requestId: number, lo: number, extra: Record<string, unknown> = {}) => ({
  ...envelope(requestId), atTick: { lo, hi: 0 }, type: 'weather.set', windNedMps: [1, -2, 0.5],
  temperatureK: 288.15, pressurePa: 101325, turbulenceRmsMps: 1.5, seed: 7, ...extra });
const fault = (requestId: number, effect: unknown, extra: Record<string, unknown> = {}) => ({
  ...envelope(requestId), atTick: { lo: 400, hi: 0 }, type: 'fault.set', faultId: 'training-drift', enabled: true,
  effect, recovery: 'hold-offset', ...extra });
const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

type Expectation = 'accept' | 'SCHEMA' | 'OUT_OF_RANGE';
interface Case { name: string; input: unknown; expect: Expectation; schemaCannotExpress?: true; notJson?: true }
const cases: Case[] = [
  // Positive fixtures for every branch and effect.
  { name: 'weather.set', input: weather(1, 400), expect: 'accept' },
  { name: 'fault gnss-jamming', input: fault(2, { kind: 'gnss-jamming', severity: 1 }), expect: 'accept' },
  { name: 'fault position-step', input: fault(3, { kind: 'position-step', offsetNedM: [-10000, 0, 10000] }), expect: 'accept' },
  { name: 'fault velocity-drift', input: fault(4, { kind: 'velocity-drift', accelerationNedMps2: [0.1, 0, 0], maxSpeedMps: 20 }), expect: 'accept' },
  { name: 'fault magnetic at +-pi', input: fault(5, { kind: 'magnetic', rotationRad: [Math.PI, -Math.PI, 0], biasBodyGauss: [2, -2, 0] }), expect: 'accept' },
  { name: 'fault motor-loss', input: fault(6, { kind: 'motor-loss', motorIndex: 31, mode: 'instant-thrust-loss', remainingThrustFraction: 0 }), expect: 'accept' },
  { name: 'sim.start', input: { ...envelope(7), type: 'sim.start' }, expect: 'accept' },
  { name: 'sim.pause', input: { ...envelope(8), type: 'sim.pause' }, expect: 'accept' },
  { name: 'worker.dispose', input: { ...envelope(9), type: 'worker.dispose' }, expect: 'accept' },
  { name: 'sim.reset max seed', input: { ...envelope(4294967295), type: 'sim.reset', seed: 4294967295 }, expect: 'accept' },
  { name: 'sim.configure', input: { ...envelope(11), type: 'sim.configure', hz: 1200, clockMode: 'sitl-lockstep' }, expect: 'accept' },
  { name: 'model.load uppercase hex', input: { ...envelope(12), type: 'model.load', modelId: 0, manifestSha256: 'AB'.repeat(32) }, expect: 'accept' },
  // Envelope and shape.
  { name: 'not an object', input: [1, 2], expect: 'SCHEMA' },
  { name: 'protocolVersion 1', input: { ...envelope(1), protocolVersion: 1, type: 'sim.start' }, expect: 'SCHEMA' },
  { name: 'unknown type', input: { ...envelope(1), type: 'sim.teleport' }, expect: 'SCHEMA' },
  { name: 'missing requestId', input: without({ ...envelope(1), type: 'sim.start' }, 'requestId'), expect: 'SCHEMA' },
  { name: 'additional property', input: { ...envelope(1), type: 'sim.start', extra: true }, expect: 'SCHEMA' },
  { name: 'atTick on a lifecycle command', input: { ...envelope(1), type: 'sim.start', atTick: { lo: 1, hi: 0 } }, expect: 'SCHEMA' },
  { name: 'non-integer requestId', input: { ...envelope(1.5), type: 'sim.start' }, expect: 'SCHEMA' },
  { name: 'negative requestId', input: { ...envelope(-1), type: 'sim.start' }, expect: 'OUT_OF_RANGE' },
  { name: 'requestId 2^32', input: { ...envelope(2 ** 32), type: 'sim.start' }, expect: 'OUT_OF_RANGE' },
  { name: 'string epoch', input: { ...envelope(1), expectedEpoch: '1', type: 'sim.start' }, expect: 'SCHEMA' },
  { name: 'NaN epoch', input: { ...envelope(1), expectedEpoch: NaN, type: 'sim.start' }, expect: 'SCHEMA', notJson: true },
  { name: 'undefined field', input: { ...envelope(1), type: 'sim.reset', seed: undefined }, expect: 'SCHEMA', notJson: true },
  { name: 'oversized payload', input: { ...weather(1, 400), faultPad: 'x'.repeat(17000) }, expect: 'SCHEMA' },
  { name: 'oversized but otherwise valid', input: fault(1, { kind: 'gnss-jamming', severity: 0.5 }, { faultId: 'a'.repeat(64) }), expect: 'accept' },
  // Branch-specific negatives.
  { name: 'atTick extra key', input: weather(1, 400, { atTick: { lo: 1, hi: 0, mid: 0 } }), expect: 'SCHEMA' },
  { name: 'atTick fractional', input: weather(1, 400, { atTick: { lo: 1.5, hi: 0 } }), expect: 'SCHEMA' },
  { name: 'wind vector of two', input: weather(1, 400, { windNedMps: [1, 2] }), expect: 'SCHEMA' },
  { name: 'wind vector of four', input: weather(1, 400, { windNedMps: [1, 2, 3, 4] }), expect: 'SCHEMA' },
  { name: 'wind out of range', input: weather(1, 400, { windNedMps: [0, 100.5, 0] }), expect: 'OUT_OF_RANGE' },
  { name: 'Infinity wind', input: weather(1, 400, { windNedMps: [0, Infinity, 0] }), expect: 'SCHEMA', notJson: true },
  { name: 'temperature too cold', input: weather(1, 400, { temperatureK: 199 }), expect: 'OUT_OF_RANGE' },
  { name: 'pressure too high', input: weather(1, 400, { pressurePa: 110001 }), expect: 'OUT_OF_RANGE' },
  { name: 'negative turbulence', input: weather(1, 400, { turbulenceRmsMps: -0.1 }), expect: 'OUT_OF_RANGE' },
  { name: 'density is not accepted', input: weather(1, 400, { densityKgM3: 1.2 }), expect: 'SCHEMA' },
  { name: 'faultId pattern', input: fault(1, { kind: 'gnss-jamming', severity: 0 }, { faultId: 'bad id' }), expect: 'SCHEMA' },
  { name: 'faultId too long', input: fault(1, { kind: 'gnss-jamming', severity: 0 }, { faultId: 'a'.repeat(65) }), expect: 'SCHEMA' },
  { name: 'enabled not boolean', input: fault(1, { kind: 'gnss-jamming', severity: 0 }, { enabled: 1 }), expect: 'SCHEMA' },
  { name: 'unknown recovery', input: fault(1, { kind: 'gnss-jamming', severity: 0 }, { recovery: 'fade' }), expect: 'SCHEMA' },
  { name: 'unknown effect kind', input: fault(1, { kind: 'spoofing', severity: 0 }), expect: 'SCHEMA' },
  { name: 'effect extra key', input: fault(1, { kind: 'gnss-jamming', severity: 0, note: 1 }), expect: 'SCHEMA' },
  { name: 'severity above 1', input: fault(1, { kind: 'gnss-jamming', severity: 1.01 }), expect: 'OUT_OF_RANGE' },
  { name: 'position offset too large', input: fault(1, { kind: 'position-step', offsetNedM: [0, 0, 10001] }), expect: 'OUT_OF_RANGE' },
  { name: 'drift component too large', input: fault(1, { kind: 'velocity-drift', accelerationNedMps2: [0.31, 0, 0], maxSpeedMps: 1 }), expect: 'OUT_OF_RANGE' },
  { name: 'drift norm above 0.3', input: fault(1, { kind: 'velocity-drift', accelerationNedMps2: [0.3, 0.3, 0], maxSpeedMps: 1 }),
    expect: 'OUT_OF_RANGE', schemaCannotExpress: true },
  { name: 'drift max speed zero', input: fault(1, { kind: 'velocity-drift', accelerationNedMps2: [0.1, 0, 0], maxSpeedMps: 0 }), expect: 'OUT_OF_RANGE' },
  { name: 'drift max speed above 20', input: fault(1, { kind: 'velocity-drift', accelerationNedMps2: [0.1, 0, 0], maxSpeedMps: 20.5 }), expect: 'OUT_OF_RANGE' },
  { name: 'magnetic rotation beyond pi', input: fault(1, { kind: 'magnetic', rotationRad: [3.15, 0, 0], biasBodyGauss: [0, 0, 0] }), expect: 'OUT_OF_RANGE' },
  { name: 'magnetic bias too large', input: fault(1, { kind: 'magnetic', rotationRad: [0, 0, 0], biasBodyGauss: [0, 0, 2.5] }), expect: 'OUT_OF_RANGE' },
  { name: 'motor index 32', input: fault(1, { kind: 'motor-loss', motorIndex: 32, mode: 'power-cut', remainingThrustFraction: 0 }), expect: 'OUT_OF_RANGE' },
  { name: 'motor index fractional', input: fault(1, { kind: 'motor-loss', motorIndex: 1.5, mode: 'power-cut', remainingThrustFraction: 0 }), expect: 'SCHEMA' },
  { name: 'unknown motor mode', input: fault(1, { kind: 'motor-loss', motorIndex: 1, mode: 'stall', remainingThrustFraction: 0 }), expect: 'SCHEMA' },
  { name: 'remaining thrust above 1', input: fault(1, { kind: 'motor-loss', motorIndex: 1, mode: 'power-cut', remainingThrustFraction: 1.5 }), expect: 'OUT_OF_RANGE' },
  { name: 'reset without seed', input: { ...envelope(1), type: 'sim.reset' }, expect: 'SCHEMA' },
  { name: 'configure 500 Hz', input: { ...envelope(1), type: 'sim.configure', hz: 500, clockMode: 'interactive' }, expect: 'OUT_OF_RANGE' },
  { name: 'configure string hz', input: { ...envelope(1), type: 'sim.configure', hz: '400', clockMode: 'interactive' }, expect: 'SCHEMA' },
  { name: 'configure unknown clock mode', input: { ...envelope(1), type: 'sim.configure', hz: 400, clockMode: 'turbo' }, expect: 'SCHEMA' },
  { name: 'model.load short hash', input: { ...envelope(1), type: 'model.load', modelId: 1, manifestSha256: 'ab'.repeat(31) }, expect: 'SCHEMA' },
  { name: 'model.load non-hex hash', input: { ...envelope(1), type: 'model.load', modelId: 1, manifestSha256: 'zz'.repeat(32) }, expect: 'SCHEMA' },
];

describe('Control Protocol v2 validation', () => {
  const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

  it.each(cases)('$name -> $expect', ({ input, expect: expected }) => {
    const result = parseControlCommandV2(input);
    if (expected === 'accept') expect(result.ok, JSON.stringify(result)).toBe(true);
    else expect(result.ok ? 'accept' : result.code).toBe(expected);
  });
  it('the JSON Schema accepts and rejects exactly the same JSON payloads as the TypeScript validator', () => {
    let compared = 0;
    for (const { name, input, expect: expected, schemaCannotExpress, notJson } of cases) {
      if (notJson || name.startsWith('oversized')) continue; // JSON cannot carry NaN/undefined; size is not a schema rule
      const schemaValid = validateSchema(input);
      expect(schemaValid, name).toBe(schemaCannotExpress ? true : expected === 'accept');
      compared++;
    }
    expect(compared).toBeGreaterThan(50);
  });
  it('accepts the normative JSON example from the specification', () => {
    const section = specText.slice(specText.indexOf('## 6. Worker Control Protocol v2'));
    const example: unknown = JSON.parse(/```json\n([\s\S]*?)```/.exec(section)?.[1] ?? 'null');
    expect(validateSchema(example)).toBe(true);
    const result = parseControlCommandV2(example);
    expect(result.ok && result.command.type).toBe('fault.set');
  });
  it('returns a normalized copy that shares nothing with the input', () => {
    const input = weather(1, 400);
    const result = parseControlCommandV2(input);
    if (!result.ok || result.command.type !== 'weather.set') throw new Error('Expected a weather command');
    expect(result.command.windNedMps).not.toBe(input.windNedMps);
    expect(result.command.atTick).not.toBe(input.atTick);
    expect(JSON.stringify(parseControlCommandV2({ ...input, seed: 7, type: 'weather.set' }))).toBe(JSON.stringify(result));
  });
  it('reports the received requestId for malformed commands when it is readable', () => {
    const malformed = parseControlCommandV2({ ...envelope(42), type: 'sim.reset' });
    expect(malformed.ok ? -2 : malformed.requestId).toBe(42);
    const unreadable = parseControlCommandV2({ type: 'sim.start' });
    expect(unreadable.ok ? -2 : unreadable.requestId).toBe(-1);
  });
});

/** Recording target: the active model only changes through commitModel. */
class FakeTarget implements ControlTargetV2 {
  armed = false; rotors = 4; model = 1; calls: string[] = []; applied: { requestId: number; tick: number }[] = [];
  loads: { resolve: () => void; reject: (error: Error) => void }[] = [];
  isArmed() { return this.armed; }
  rotorCount() { return this.rotors; }
  start() { this.calls.push('start'); }
  pause() { this.calls.push('pause'); }
  dispose() { this.calls.push('dispose'); }
  reset(seed: number) { this.calls.push(`reset:${seed}`); }
  configure(hz: PhysicsHz, mode: ClockModeV2) { this.calls.push(`configure:${hz}:${mode}`); }
  prepareModel(modelId: number) {
    this.calls.push(`prepare:${modelId}`);
    return new Promise<void>((resolve, reject) => this.loads.push({ resolve, reject }));
  }
  commitModel(modelId: number) { this.calls.push(`commit:${modelId}`); this.model = modelId; }
  applyScheduled(command: ScheduledCommandV2, tick: TickId) { this.applied.push({ requestId: command.requestId, tick: tick.lo }); }
  unsupported: string | null = null;
  unsupportedReason() { return this.unsupported; }
}
function harness(options?: { epoch?: number; hz?: PhysicsHz }) {
  const target = new FakeTarget(), processor = new ControlProcessorV2(target, options), results: CommandResultV2[] = [];
  const send = (input: unknown) => { processor.submit(input); processor.drain(result => results.push(result)); return results.at(-1); };
  const tickTo = (from: number, to: number) => {
    for (let lo = from; lo <= to; lo++) processor.beforeTick({ lo, hi: 0 });
    processor.drain(result => results.push(result));
  };
  return { target, processor, results, send, tickTo };
}
const lifecycle = (requestId: number, type: string, expectedEpoch = 1, extra: Record<string, unknown> = {}) =>
  ({ ...envelope(requestId, expectedEpoch), type, ...extra });

describe('Control Protocol v2 processing', () => {
  it('applies lifecycle commands with acknowledgements and requires paused, disarmed sessions for reset', () => {
    const { target, processor, send } = harness();
    expect(send(lifecycle(1, 'sim.start'))).toEqual({ type: 'ack-v2', requestId: 1, status: 'applied', epoch: 1, appliedTick: { lo: 0, hi: 0 } });
    expect(send(lifecycle(2, 'sim.reset', 1, { seed: 3 }))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    expect(send(lifecycle(3, 'sim.pause'))).toMatchObject({ type: 'ack-v2', status: 'applied' });
    target.armed = true;
    expect(send(lifecycle(4, 'sim.reset', 1, { seed: 3 }))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    target.armed = false;
    expect(send(lifecycle(5, 'sim.reset', 1, { seed: 3 }))).toEqual({ type: 'ack-v2', requestId: 5, status: 'applied', epoch: 2, appliedTick: { lo: 0, hi: 0 } });
    expect(processor.epoch).toBe(2);
    expect(send(lifecycle(6, 'sim.start', 1))).toMatchObject({ type: 'reject-v2', code: 'STALE_EPOCH' });
    expect(send(lifecycle(7, 'sim.configure', 2, { hz: 800, clockMode: 'interactive' }))).toMatchObject({ status: 'applied', epoch: 3 });
    expect(processor.hz).toBe(800);
    expect(target.calls).toEqual(['start', 'pause', 'reset:3', 'configure:800:interactive']);
  });
  it('replays exact duplicates without reapplying, even after the epoch changed', () => {
    const { target, send } = harness();
    const first = send(lifecycle(10, 'sim.reset', 1, { seed: 9 }));
    expect(first).toMatchObject({ status: 'applied', epoch: 2 });
    expect(send({ type: 'sim.reset', seed: 9, expectedEpoch: 1, requestId: 10, protocolVersion: 2 })).toEqual(first);
    expect(target.calls).toEqual(['reset:9']);
    expect(send(lifecycle(10, 'sim.reset', 1, { seed: 8 }))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
  });
  it('enforces strictly increasing request IDs with a 128-entry cache; malformed commands consume nothing', () => {
    const { send } = harness();
    expect(send(lifecycle(5, 'sim.reset', 1))).toMatchObject({ type: 'reject-v2', code: 'SCHEMA', requestId: 5 });
    expect(send(lifecycle(5, 'sim.pause'))).toMatchObject({ type: 'ack-v2', requestId: 5 });
    expect(send(lifecycle(4, 'sim.pause'))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE', requestId: 4 });
    for (let id = 6; id < 6 + 128; id++) send(lifecycle(id, 'sim.pause'));
    // ID 5 has left the cache: below the high-water mark, so BAD_STATE rather than a replay.
    expect(send(lifecycle(5, 'sim.pause'))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    expect(send(lifecycle(6, 'sim.pause'))).toMatchObject({ type: 'ack-v2', requestId: 6 }); // still cached
  });
  it('schedules within [next tick, 10 s], applies before integrating the tick in receipt order, and finalizes every command', () => {
    const { target, results, send, tickTo } = harness();
    tickTo(1, 10);
    expect(send(weather(1, 10))).toMatchObject({ type: 'reject-v2', code: 'OUT_OF_RANGE' }); // already integrated
    expect(send(weather(2, 11 + 4001))).toMatchObject({ type: 'reject-v2', code: 'OUT_OF_RANGE' }); // beyond 10 s at 400 Hz
    expect(send(weather(3, 11 + 4000))).toMatchObject({ type: 'ack-v2', status: 'queued', appliedTick: { lo: 4011, hi: 0 } });
    expect(send(weather(4, 20))).toMatchObject({ status: 'queued' });
    expect(send(fault(5, { kind: 'gnss-jamming', severity: 0.5 }, { atTick: { lo: 20, hi: 0 } }))).toMatchObject({ status: 'queued' });
    expect(send(weather(6, 11))).toMatchObject({ status: 'queued' });
    expect(send(fault(7, { kind: 'motor-loss', motorIndex: 4, mode: 'power-cut', remainingThrustFraction: 0 }))).toMatchObject({ code: 'OUT_OF_RANGE' });
    results.length = 0;
    tickTo(11, 19);
    expect(target.applied).toEqual([{ requestId: 6, tick: 11 }]);
    tickTo(20, 4011);
    expect(target.applied).toEqual([{ requestId: 6, tick: 11 }, { requestId: 4, tick: 20 }, { requestId: 5, tick: 20 }, { requestId: 3, tick: 4011 }]);
    expect(results.map(r => r.type === 'ack-v2' && `${r.requestId}:${r.status}@${r.appliedTick.lo}`))
      .toEqual(['6:applied@11', '4:applied@20', '5:applied@20', '3:applied@4011']);
    expect(send(weather(3, 11 + 4000))).toMatchObject({ status: 'applied', appliedTick: { lo: 4011 } }); // exact duplicate replays latest result
    expect(target.applied.filter(a => a.requestId === 3)).toHaveLength(1);
    expect(send(weather(3, 4011 + 4000))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' }); // same ID, different payload
  });
  it('accepts 128 queued commands, rejects the 129th with OVERLOAD, and keeps the older ones', () => {
    const { target, processor, send, tickTo } = harness();
    for (let id = 1; id <= COMMAND_QUEUE_CAPACITY_V2; id++) expect(send(weather(id, 100 + id))).toMatchObject({ status: 'queued' });
    expect(send(weather(129, 50))).toMatchObject({ type: 'reject-v2', code: 'OVERLOAD', requestId: 129 });
    expect(processor.pendingCommands).toBe(128);
    tickTo(1, 300);
    expect(target.applied.map(a => a.requestId)).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
    expect(processor.outboxOverflows).toBe(0);
  });
  it('reset and dispose cancel pending commands with BAD_STATE; disposed workers reject everything', () => {
    const { target, results, send, tickTo } = harness();
    send(weather(1, 50)); send(weather(2, 60));
    results.length = 0;
    send(lifecycle(3, 'sim.reset', 1, { seed: 1 }));
    expect(results.map(r => r.type === 'reject-v2' ? `${r.requestId}:${r.code}` : r.type === 'ack-v2' ? `${r.requestId}:${r.status}` : r.type))
      .toEqual(['1:BAD_STATE', '2:BAD_STATE', '3:applied']);
    send(weather(4, 5, { expectedEpoch: 2 }));
    expect(send(lifecycle(5, 'worker.dispose', 2))).toMatchObject({ status: 'applied' });
    expect(results.some(r => r.type === 'reject-v2' && r.requestId === 4)).toBe(true);
    expect(send(lifecycle(6, 'sim.start', 2))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' });
    tickTo(1, 10);
    expect(target.applied).toEqual([]);
  });
  it('swaps a model only after successful preparation; a failure keeps the previous model paused', async () => {
    const { target, processor, results, send, tickTo } = harness();
    send(weather(1, 50));
    expect(send(lifecycle(2, 'model.load', 1, { modelId: 7, manifestSha256: SHA }))).toMatchObject({ status: 'queued', epoch: 1 });
    expect(send(lifecycle(3, 'sim.start'))).toMatchObject({ type: 'reject-v2', code: 'BAD_STATE' }); // busy loading
    target.loads[0]!.reject(new Error('manifest hash mismatch'));
    await processor.settled();
    processor.drain(result => results.push(result));
    expect(results.at(-1)).toEqual({ type: 'reject-v2', requestId: 2, code: 'ASSET_MISSING', message: 'manifest hash mismatch' });
    expect([target.model, processor.epoch, processor.pendingCommands]).toEqual([1, 1, 1]);
    expect(target.calls).toEqual(['prepare:7']);
    expect(send(lifecycle(4, 'model.load', 1, { modelId: 8, manifestSha256: SHA }))).toMatchObject({ status: 'queued' });
    target.loads[1]!.resolve();
    await processor.settled();
    processor.drain(result => results.push(result));
    expect(results.slice(-2)).toEqual([
      { type: 'reject-v2', requestId: 1, code: 'BAD_STATE', message: 'Cancelled by model.load' },
      { type: 'ack-v2', requestId: 4, status: 'applied', epoch: 2, appliedTick: { lo: 0, hi: 0 } },
    ]);
    expect([target.model, processor.epoch]).toEqual([8, 2]);
    tickTo(1, 60);
    expect(target.applied).toEqual([]);
  });
  it('does not commit a model when the worker is disposed during preparation', async () => {
    const { target, processor, results, send } = harness();
    send(lifecycle(1, 'model.load', 1, { modelId: 9, manifestSha256: SHA }));
    expect(send(lifecycle(2, 'worker.dispose'))).toMatchObject({ status: 'applied' });
    target.loads[0]!.resolve();
    await processor.settled();
    processor.drain(result => results.push(result));
    expect(results.at(-1)).toMatchObject({ type: 'reject-v2', requestId: 1, code: 'BAD_STATE' });
    expect(target.model).toBe(1);
  });
});

describe('backend support and Worker boundary guards', () => {
  it('rejects a scheduled command the backend cannot model at admission, with its reason', () => {
    const { target, send } = harness();
    target.unsupported = 'The demo backend has no atmosphere/wind model';
    expect(send(weather(1, 50))).toEqual({ type: 'reject-v2', requestId: 1, code: 'BAD_STATE', message: 'The demo backend has no atmosphere/wind model' });
    target.unsupported = null;
    expect(send(weather(2, 50))).toMatchObject({ status: 'queued' });
  });
  it('accepts only well-formed Worker events and init messages', () => {
    const tick = { lo: 1, hi: 0 };
    expect(parseWorkerEventV2({ type: 'ready-v2', protocolVersion: 2, abiVersion: 2, epoch: 1, hz: 800 })).toMatchObject({ hz: 800 });
    expect(parseWorkerEventV2({ type: 'ack-v2', requestId: 3, status: 'applied', epoch: 1, appliedTick: tick })).toMatchObject({ requestId: 3 });
    expect(parseWorkerEventV2({ type: 'reject-v2', requestId: -1, code: 'SCHEMA', message: 'bad' })).toMatchObject({ code: 'SCHEMA' });
    expect(parseWorkerEventV2({ type: 'fault-v2', protocolVersion: 2, message: 'x' })).toMatchObject({ type: 'fault-v2' });
    for (const invalid of [null, 'ready', { type: 'ready-v2', protocolVersion: 2, abiVersion: 1, epoch: 1, hz: 400 },
      { type: 'ready-v2', protocolVersion: 2, abiVersion: 2, epoch: 1, hz: 500 },
      { type: 'ack-v2', requestId: 1.5, status: 'applied', epoch: 1, appliedTick: tick },
      { type: 'ack-v2', requestId: 1, status: 'done', epoch: 1, appliedTick: tick },
      { type: 'ack-v2', requestId: 1, status: 'applied', epoch: 1, appliedTick: { lo: 1 } },
      { type: 'reject-v2', requestId: 1, code: 'PANIC', message: 'x' }, { type: 'error', message: 'v1' }]) {
      expect(parseWorkerEventV2(invalid), JSON.stringify(invalid)).toBeNull();
    }
    const buffers = { stateBuffer: new SharedArrayBuffer(8), sensorBuffer: new SharedArrayBuffer(8), actuatorBuffer: new SharedArrayBuffer(8) };
    expect(isWorkerInitV2({ type: 'init-v2', protocolVersion: 2, ...buffers })).toBe(true);
    expect(isWorkerInitV2({ type: 'init', version: 1, buffer: buffers.stateBuffer })).toBe(false);
    expect(isWorkerInitV2({ type: 'init-v2', protocolVersion: 2, ...buffers, extra: 1 })).toBe(false);
    expect(isWorkerInitV2({ type: 'init-v2', protocolVersion: 2, ...buffers, sensorBuffer: new ArrayBuffer(8) })).toBe(false);
  });
});
