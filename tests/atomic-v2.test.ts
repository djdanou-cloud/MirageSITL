import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { CAPACITY_V2, HEADER_WORDS_V2, HeaderV2, PILOT_WORD_OFFSET_V2, PilotReaderV2, PilotWriterV2, RuntimeFlagV2,
  STATE_STRIDE_V2, STATE_WORDS_V2, StateReaderV2, StateWriterV2, createSharedMemory, createSharedMemoryV2,
  copyFlightStateV2, newFlightStateV2, newHeaderSnapshotV2, newPilotInputV2, type FlightStateV2 } from '@mirage/protocol';
import { goldenPilot, goldenState, loadGoldenV2 } from './support/golden-v2';
import { STRESS_PUBLICATIONS, fillStressState, runStressReader } from './support/atomic-v2-stress';

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
function snapshot(buffer: SharedArrayBuffer, byteOffset: number, bytes: number): Uint8Array {
  const shared = new Int32Array(buffer), copy = new Int32Array(bytes / 4);
  for (let i = 0; i < copy.length; i++) copy[i] = Atomics.load(shared, byteOffset / 4 + i);
  return new Uint8Array(copy.buffer);
}
function stressState(k: number): FlightStateV2 {
  const state = newFlightStateV2(); fillStressState(k, state); return state;
}
function cloneState(source: FlightStateV2): FlightStateV2 {
  const copy = newFlightStateV2(); copyFlightStateV2(source, copy); return copy;
}

describe('ABI v2 atomic transport', () => {
  it('publishes the golden state as seqlock 2 + golden bytes with sample_id = published', async () => {
    const golden = await loadGoldenV2();
    const { state } = goldenState(golden);
    const buffer = createSharedMemoryV2(), writer = new StateWriterV2(buffer), reader = new StateReaderV2(buffer);
    expect(writer.publish(state)).toBe(true);
    expect(state.sampleId).toBe(1);
    const expected = golden.state.bytes.slice(); expected[0] = 2; // even seqlock after one commit
    expect(hex(snapshot(buffer, HEADER_WORDS_V2 * 4, STATE_STRIDE_V2))).toBe(hex(expected));
    expect(Atomics.load(new Int32Array(buffer), HeaderV2.Published)).toBe(1);
    const target = newFlightStateV2();
    expect(reader.latest(target)).toBe(true);
    expect(target).toEqual(state);
  });
  it('rejects contract-violating states without touching shared memory', () => {
    const buffer = createSharedMemoryV2(), writer = new StateWriterV2(buffer);
    const before = hex(snapshot(buffer, 0, buffer.byteLength));
    const state = stressState(0); state.northM = NaN;
    expect(writer.publish(state)).toBe(false);
    state.northM = 0; state.vehicleFlags = 1 << 9;
    expect(writer.publish(state)).toBe(false);
    expect(hex(snapshot(buffer, 0, buffer.byteLength))).toBe(before);
  });
  it('wraps the ring, reads bounded history by age, and misses outside it without mutating output', () => {
    const buffer = createSharedMemoryV2(), writer = new StateWriterV2(buffer), reader = new StateReaderV2(buffer);
    const target = newFlightStateV2();
    expect(reader.latest(target)).toBe(false);
    for (let k = 0; k < CAPACITY_V2 + 3; k++) expect(writer.publish(stressState(k))).toBe(true);
    expect(reader.latest(target)).toBe(true); expect(target.sampleId).toBe(CAPACITY_V2 + 3);
    expect(reader.latest(target, CAPACITY_V2 - 1)).toBe(true); expect(target.sampleId).toBe(4);
    const before = cloneState(target);
    for (const age of [CAPACITY_V2, -1, 1.5, NaN]) expect(reader.latest(target, age)).toBe(false);
    expect(target).toEqual(before);
  });
  it('returns a miss for a frame interrupted mid-write and leaves output unchanged', () => {
    const buffer = createSharedMemoryV2(), writer = new StateWriterV2(buffer), reader = new StateReaderV2(buffer);
    for (let k = 0; k < CAPACITY_V2; k++) writer.publish(stressState(k));
    // A writer that dies after marking the oldest slot busy and writing part of the next payload.
    const shared = new Int32Array(buffer), slot0 = HEADER_WORDS_V2;
    Atomics.add(shared, slot0, 1);
    for (let i = 1; i < STATE_WORDS_V2 / 2; i++) Atomics.store(shared, slot0 + i, 0x7fc00000);
    const target = newFlightStateV2(); reader.latest(target, 1);
    const before = cloneState(target);
    expect(reader.latest(target, CAPACITY_V2 - 1)).toBe(false);
    expect(target).toEqual(before);
    expect(reader.latest(target)).toBe(true); // other slots remain readable
    expect(target.sampleId).toBe(CAPACITY_V2);
  });
  it('rejects a frame whose sample_id does not match the head, even with a valid seqlock', () => {
    const buffer = createSharedMemoryV2(), writer = new StateWriterV2(buffer), reader = new StateReaderV2(buffer);
    for (let k = 0; k < 3; k++) writer.publish(stressState(k));
    const target = newFlightStateV2();
    expect(reader.latest(target)).toBe(true);
    const before = cloneState(target);
    // Head claims a lapped publication: slot (259 - 1) % 256 = 2 still holds sample_id 3.
    Atomics.store(new Int32Array(buffer), HeaderV2.Published, 3 + CAPACITY_V2);
    expect(reader.latest(target)).toBe(false);
    expect(target).toEqual(before);
  });
  it('exposes counters, flags, epoch, and rate; never pairs history across an epoch or model change', () => {
    const buffer = createSharedMemoryV2(), writer = new StateWriterV2(buffer), reader = new StateReaderV2(buffer);
    const header = newHeaderSnapshotV2(), current = newFlightStateV2(), previous = newFlightStateV2();
    writer.setCounters(3, 17); writer.setRuntimeFlags(RuntimeFlagV2.Ready | RuntimeFlagV2.Running);
    reader.readHeader(header);
    expect(header).toEqual({ published: 0, overruns: 3, droppedSteps: 17, physicsHz: 400, sessionEpoch: 1,
      runtimeFlags: RuntimeFlagV2.Ready | RuntimeFlagV2.Running });
    expect(() => writer.setRuntimeFlags(8)).toThrow(); expect(() => writer.setEpoch(0)).toThrow();
    expect(reader.latestPair(current, previous)).toBe('none');
    const s = newFlightStateV2(); s.epoch = 1;
    s.tickId.lo = 1; writer.publish(s);
    expect(reader.latestPair(current, previous)).toBe('latest');
    s.tickId.lo = 2; writer.publish(s);
    expect(reader.latestPair(current, previous)).toBe('pair');
    expect([previous.tickId.lo, current.tickId.lo]).toEqual([1, 2]);
    // Reset: new epoch, tick restarts. Published and sample_id continue.
    writer.setEpoch(2); writer.setPhysicsHz(800); s.epoch = 2; s.tickId.lo = 1; writer.publish(s);
    expect(reader.latestPair(current, previous)).toBe('latest');
    expect(previous).toEqual(current); expect(current.sampleId).toBe(3);
    s.tickId.lo = 2; writer.publish(s);
    expect(reader.latestPair(current, previous)).toBe('pair');
    s.tickId.lo = 3; s.modelId = 9; writer.publish(s); // model swap at the same epoch is still a discontinuity
    expect(reader.latestPair(current, previous)).toBe('latest');
    s.tickId.lo = 5; writer.publish(s); // skipped tick
    expect(reader.latestPair(current, previous)).toBe('latest');
    s.tickId = { lo: 0xffffffff, hi: 0 }; writer.publish(s);
    s.tickId = { lo: 0, hi: 1 }; writer.publish(s); // carry across the 32-bit boundary is adjacent
    expect(reader.latestPair(current, previous)).toBe('pair');
    reader.readHeader(header);
    expect([header.published, header.sessionEpoch, header.physicsHz]).toEqual([8, 2, 800]);
  });
  it('round-trips the pilot mailbox with input_sample_id and misses on a busy mailbox', async () => {
    const { pilot } = goldenPilot(await loadGoldenV2());
    const buffer = createSharedMemoryV2(), writer = new PilotWriterV2(buffer), reader = new PilotReaderV2(buffer);
    const target = newPilotInputV2();
    writer.publish(pilot); writer.publish(pilot);
    expect(pilot.inputSampleId).toBe(2);
    expect(reader.latest(target)).toBe(true); expect(target).toEqual(pilot);
    const before = { ...target };
    Atomics.add(new Int32Array(buffer), PILOT_WORD_OFFSET_V2, 1);
    expect(reader.latest(target)).toBe(false); expect(target).toEqual(before);
  });
  it('refuses to attach to a v1 buffer', () => {
    const v1 = createSharedMemory();
    for (const attach of [StateWriterV2, StateReaderV2, PilotWriterV2, PilotReaderV2]) expect(() => new attach(v1)).toThrow();
  });
});

describe('ABI v2 concurrency stress', () => {
  it(`delivers ${STRESS_PUBLICATIONS} concurrent publications with no torn, NaN, or regressed frames`, async () => {
    const buffer = createSharedMemoryV2(), control = new SharedArrayBuffer(16);
    const worker = new Worker(new URL('./support/atomic-v2-stress.node-worker.ts', import.meta.url), { workerData: { buffer, control } });
    const exited = new Promise<number>(resolve => worker.once('exit', resolve));
    const failed = new Promise<never>((_, reject) => worker.once('error', reject));
    try {
      const report = runStressReader(buffer, new Int32Array(control), 120_000);
      expect(await Promise.race([exited, failed])).toBe(0);
      expect(report.timedOut).toBe(false);
      expect(report.failures).toBe(0);
      expect(report.finalPublished).toBe(STRESS_PUBLICATIONS);
      expect(report.finalMatches).toBe(true);
      expect(report.torn).toBe(0); expect(report.nonFinite).toBe(0); expect(report.regressions).toBe(0);
      // The reader must have overlapped the writer substantially for the result to mean anything.
      expect(report.reads).toBeGreaterThan(10_000);
      expect(report.maxSampleId).toBeGreaterThan(STRESS_PUBLICATIONS / 2);
      console.info('stress', JSON.stringify(report));
    } finally {
      await worker.terminate();
    }
  }, 180_000);
});
